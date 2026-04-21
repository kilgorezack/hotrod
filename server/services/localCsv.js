/**
 * Local FCC BDC CSV reader — replaces FCC API calls when fcc_data/ is present.
 *
 * Provides:
 *   getLocalHexCoverage(providerId, techCode) → GeoJSON FeatureCollection | null
 *   searchLocalProviders(query, limit)        → [{ id, name }]
 *   getLocalProviderTechs(providerId)         → ['10', '40', ...]
 *
 * Node.js only. All callers wrap with try/catch and fall back to the FCC API
 * when this module can't load (e.g. Cloudflare Workers, Vercel without data files).
 */
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellToBoundary } from 'h3-js';

// ─── Tech code mapping ────────────────────────────────────────────────────────

// CSV filename keyword → normalised app tech code (same codes hexAgg uses)
const CSV_TYPE_TO_APP_TECH = {
  'Copper':                 '10',
  'Cable':                  '40',
  'FibertothePremises':     '50',
  'GSOSatellite':           '60',
  'NGSOSatellite':          '60',
  'LicensedFixedWireless':  '70',
  'LBRFixedWireless':       '70',
  'UnlicensedFixedWireless':'70',
};

// App tech code → CSV filename keywords (for hex coverage)
const TECH_TO_CSV_TYPES = {
  '10': ['Copper'],
  '40': ['Cable'],
  '50': ['FibertothePremises'],
  '60': ['GSOSatellite', 'NGSOSatellite'],
  '70': ['LicensedFixedWireless', 'LBRFixedWireless', 'UnlicensedFixedWireless'],
};

// ─── Data directory ───────────────────────────────────────────────────────────

function findDataDir() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'fcc_data');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

// Returns every BDC CSV file found, paired with its normalised tech code.
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

// ─── CSV line parsing helpers ─────────────────────────────────────────────────

// Extracts provider_id (field 1) and brand_name (field 2) from a raw CSV line.
// Handles quoted brand names that contain commas.
function extractProviderFields(line) {
  const i1 = line.indexOf(',');
  const i2 = line.indexOf(',', i1 + 1);
  const providerId = line.slice(i1 + 1, i2);
  const rest = line.slice(i2 + 1);
  let brandName;
  if (rest.charAt(0) === '"') {
    const close = rest.indexOf('",', 1);
    brandName = close >= 0 ? rest.slice(1, close) : rest.slice(1, rest.indexOf('"', 1));
  } else {
    const next = rest.indexOf(',');
    brandName = next >= 0 ? rest.slice(0, next) : rest;
  }
  return { providerId, brandName };
}

// ─── Provider index ───────────────────────────────────────────────────────────
// Built once at first use; maps provider_id → { name, techs: Set<appCode> }

let _indexPromise = null;

async function buildIndex(dataDir) {
  const index = new Map();
  const files = listCsvFiles(dataDir);

  for (const { filePath, techCode } of files) {
    await new Promise((resolve, reject) => {
      const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
      let first = true;
      rl.on('line', (line) => {
        if (first) { first = false; return; }
        const { providerId, brandName } = extractProviderFields(line);
        if (!providerId) return;
        if (!index.has(providerId)) {
          index.set(providerId, { name: brandName, techs: new Set() });
        }
        index.get(providerId).techs.add(techCode);
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });
  }

  console.info(`[local-csv] Provider index ready — ${index.size} providers from ${files.length} file(s)`);
  return index;
}

function getIndex() {
  if (!_indexPromise) {
    const dataDir = findDataDir();
    _indexPromise = dataDir
      ? buildIndex(dataDir)
      : Promise.resolve(new Map());
  }
  return _indexPromise;
}

// Kick off index build as soon as this module loads so it's ready by first request.
getIndex().catch(() => {});

// ─── Public: provider search & tech lookup ────────────────────────────────────

/**
 * Search providers by name substring/token match.
 * @returns {Array<{ id: string, name: string }>}
 */
export async function searchLocalProviders(query, limit = 20) {
  const index = await getIndex();
  if (index.size === 0) return [];

  const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const results = [];

  for (const [id, { name }] of index) {
    const lower = name.toLowerCase();
    if (tokens.every(t => lower.includes(t))) {
      results.push({ id, name });
      if (results.length >= limit) break;
    }
  }

  return results;
}

/**
 * Get normalised tech codes available for a provider.
 * @returns {string[]}  e.g. ['40', '50']
 */
export async function getLocalProviderTechs(providerId) {
  const index = await getIndex();
  const entry = index.get(String(providerId));
  if (!entry) return [];
  return [...entry.techs].sort((a, b) => Number(a) - Number(b));
}

// ─── Public: hex coverage ─────────────────────────────────────────────────────

function h3ToFeature(h3index) {
  const boundary = cellToBoundary(h3index); // [[lat, lng], ...]
  const ring = boundary.map(([lat, lng]) => [lng, lat]);
  ring.push(ring[0]);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { h3index },
  };
}

async function readH3sForProvider(filePath, providerId) {
  return new Promise((resolve, reject) => {
    const h3s = new Set();
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    let first = true;
    rl.on('line', (line) => {
      if (first) { first = false; return; }
      const i1 = line.indexOf(',');
      const i2 = line.indexOf(',', i1 + 1);
      if (line.slice(i1 + 1, i2) !== String(providerId)) return;
      const h3 = line.slice(line.lastIndexOf(',') + 1).trim();
      if (h3) h3s.add(h3);
    });
    rl.on('close', () => resolve(h3s));
    rl.on('error', reject);
  });
}

const _hexCache = new Map();

/**
 * Returns a GeoJSON FeatureCollection of H3 hex polygons for a provider+tech.
 * Returns null when no local data is found.
 */
export async function getLocalHexCoverage(providerId, techCode) {
  const cacheKey = `${providerId}:${techCode}`;
  if (_hexCache.has(cacheKey)) return _hexCache.get(cacheKey);

  const dataDir = findDataDir();
  if (!dataDir) return null;

  const csvTypes = TECH_TO_CSV_TYPES[String(techCode)];
  if (!csvTypes) return null;

  const allH3s = new Set();
  let filesChecked = 0;

  for (const stateDir of readdirSync(dataDir)) {
    const statePath = path.join(dataDir, stateDir);
    let files;
    try { files = readdirSync(statePath); } catch { continue; }
    for (const csvType of csvTypes) {
      const matches = files.filter(f => f.includes(`_${csvType}_fixed_broadband_`));
      for (const match of matches) {
        filesChecked++;
        const h3s = await readH3sForProvider(path.join(statePath, match), providerId);
        h3s.forEach(h => allH3s.add(h));
      }
    }
  }

  if (allH3s.size === 0) return null;

  const features = [...allH3s].map(h3ToFeature);
  const result = { type: 'FeatureCollection', features };

  _hexCache.set(cacheKey, result);
  setTimeout(() => _hexCache.delete(cacheKey), 3_600_000);

  console.info(`[local-csv] ${providerId}:${techCode} — ${allH3s.size} unique hexes from ${filesChecked} file(s)`);
  return result;
}
