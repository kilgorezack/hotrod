/**
 * Local broadband data service — replaces FCC API calls.
 *
 * Data sources (tried in order):
 *   1. Pre-built JSON files in server/data/*.json  ← works on Vercel + local
 *   2. Raw FCC BDC CSV files in fcc_data/          ← local dev only
 *
 * Public API:
 *   searchLocalProviders(query, limit)   → [{ id, name }]
 *   getLocalProviderTechs(providerId)    → ['10', '40', ...]
 *   getLocalHexCoverage(pid, techCode)   → GeoJSON FeatureCollection | null
 *
 * Node.js only. All callers use dynamic import + try/catch and fall back to
 * the FCC API when this module can't load (e.g. Cloudflare Workers).
 */
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellToBoundary } from 'h3-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─── Tech code mapping ────────────────────────────────────────────────────────

const CSV_TYPE_TO_APP_TECH = {
  'Copper':                  '10',
  'Cable':                   '40',
  'FibertothePremises':      '50',
  'GSOSatellite':            '60',
  'NGSOSatellite':           '60',
  'LicensedFixedWireless':   '70',
  'LBRFixedWireless':        '70',
  'UnlicensedFixedWireless': '70',
};

const TECH_TO_CSV_TYPES = {
  '10': ['Copper'],
  '40': ['Cable'],
  '50': ['FibertothePremises'],
  '60': ['GSOSatellite', 'NGSOSatellite'],
  '70': ['LicensedFixedWireless', 'LBRFixedWireless', 'UnlicensedFixedWireless'],
};

// ─── Pre-built JSON data (server/data/*.json) ─────────────────────────────────

function findJsonDataDir() {
  // server/data/ is one level up from server/services/ (this file's directory)
  const candidate = path.join(HERE, '..', 'data');
  return existsSync(candidate) ? candidate : null;
}

// Loads all *.json state files and merges into a unified in-memory dataset.
// Structure matches the output of scripts/buildLocalData.js.
function loadJsonDataset(dataDir) {
  const providers = new Map(); // id → { name, techs: Set }
  const hexes = new Map();     // "id:techCode" → Set<h3index>

  for (const file of readdirSync(dataDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const { providers: pList, hexes: hMap } = JSON.parse(
        readFileSync(path.join(dataDir, file), 'utf8')
      );
      for (const { id, name, techs } of pList) {
        if (!providers.has(id)) {
          providers.set(id, { name, techs: new Set(techs) });
        } else {
          for (const t of techs) providers.get(id).techs.add(t);
        }
      }
      for (const [key, h3arr] of Object.entries(hMap)) {
        if (!hexes.has(key)) hexes.set(key, new Set(h3arr));
        else for (const h of h3arr) hexes.get(key).add(h);
      }
    } catch (err) {
      console.warn(`[local-data] Failed to load ${file}:`, err.message);
    }
  }

  console.info(`[local-data] JSON dataset loaded — ${providers.size} providers across ${readdirSync(dataDir).filter(f=>f.endsWith('.json')).length} state file(s)`);
  return { providers, hexes };
}

// ─── Raw CSV fallback (local dev, when JSON files not yet built) ──────────────

function findCsvDataDir() {
  let dir = HERE;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'fcc_data');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function listCsvFiles(dataDir) {
  const files = [];
  for (const stateDir of readdirSync(dataDir)) {
    const statePath = path.join(dataDir, stateDir);
    let entries;
    try { entries = readdirSync(statePath); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.csv')) continue;
      for (const [csvType, techCode] of Object.entries(CSV_TYPE_TO_APP_TECH)) {
        if (file.includes(`_${csvType}_fixed_broadband_`)) {
          files.push({ filePath: path.join(statePath, file), techCode });
          break;
        }
      }
    }
  }
  return files;
}

function extractProviderFields(line) {
  const i1 = line.indexOf(',');
  const i2 = line.indexOf(',', i1 + 1);
  const providerId = line.slice(i1 + 1, i2);
  const rest = line.slice(i2 + 1);
  let name;
  if (rest.charAt(0) === '"') {
    const close = rest.indexOf('",', 1);
    name = close >= 0 ? rest.slice(1, close) : rest.slice(1, rest.indexOf('"', 1));
  } else {
    const nc = rest.indexOf(',');
    name = nc >= 0 ? rest.slice(0, nc) : rest;
  }
  return { providerId, name: name.trim() };
}

async function buildCsvDataset(csvDataDir) {
  const providers = new Map();
  const hexes = new Map();

  for (const { filePath, techCode } of listCsvFiles(csvDataDir)) {
    await new Promise((resolve, reject) => {
      const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
      let first = true;
      rl.on('line', (line) => {
        if (first) { first = false; return; }
        const { providerId, name } = extractProviderFields(line);
        if (!providerId) return;
        if (!providers.has(providerId)) providers.set(providerId, { name, techs: new Set() });
        providers.get(providerId).techs.add(techCode);
        const h3 = line.slice(line.lastIndexOf(',') + 1).trim();
        if (!h3) return;
        const key = `${providerId}:${techCode}`;
        if (!hexes.has(key)) hexes.set(key, new Set());
        hexes.get(key).add(h3);
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });
  }

  console.info(`[local-data] CSV dataset built — ${providers.size} providers`);
  return { providers, hexes };
}

// ─── Unified dataset singleton ────────────────────────────────────────────────

let _datasetPromise = null;

function getDataset() {
  if (!_datasetPromise) {
    const jsonDir = findJsonDataDir();
    if (jsonDir) {
      // Sync load is fine here — JSON files are small and this runs once at startup
      _datasetPromise = Promise.resolve(loadJsonDataset(jsonDir));
    } else {
      const csvDir = findCsvDataDir();
      _datasetPromise = csvDir
        ? buildCsvDataset(csvDir)
        : Promise.resolve({ providers: new Map(), hexes: new Map() });
    }
  }
  return _datasetPromise;
}

// Eager startup load so data is ready by the first request
getDataset().catch(() => {});

// ─── Public: provider search & tech lookup ────────────────────────────────────

export async function searchLocalProviders(query, limit = 20) {
  const { providers } = await getDataset();
  if (providers.size === 0) return [];
  const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const results = [];
  for (const [id, { name }] of providers) {
    const lower = name.toLowerCase();
    if (tokens.every(t => lower.includes(t))) {
      results.push({ id, name });
      if (results.length >= limit) break;
    }
  }
  return results;
}

export async function getLocalProviderTechs(providerId) {
  const { providers } = await getDataset();
  const entry = providers.get(String(providerId));
  if (!entry) return [];
  return [...entry.techs].sort((a, b) => Number(a) - Number(b));
}

// ─── Public: hex coverage ─────────────────────────────────────────────────────

function h3ToFeature(h3index) {
  const boundary = cellToBoundary(h3index);
  const ring = boundary.map(([lat, lng]) => [lng, lat]);
  ring.push(ring[0]);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { h3index },
  };
}

const _hexCache = new Map();

export async function getLocalHexCoverage(providerId, techCode) {
  const cacheKey = `${providerId}:${techCode}`;
  if (_hexCache.has(cacheKey)) return _hexCache.get(cacheKey);

  const { hexes } = await getDataset();

  // Collect all H3 indices for this provider+tech (may span multiple CSV types → same app code)
  const allH3s = new Set();
  const key = `${providerId}:${techCode}`;
  const set = hexes.get(key);
  if (set) set.forEach(h => allH3s.add(h));

  if (allH3s.size === 0) return null;

  const features = [...allH3s].map(h3ToFeature);
  const result = { type: 'FeatureCollection', features };

  _hexCache.set(cacheKey, result);
  setTimeout(() => _hexCache.delete(cacheKey), 3_600_000);

  console.info(`[local-data] ${providerId}:${techCode} — ${allH3s.size} hexes`);
  return result;
}
