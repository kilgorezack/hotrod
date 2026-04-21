/**
 * Pre-processes FCC BDC CSV files into compact JSON for deployment.
 *
 * Usage:
 *   node scripts/buildLocalData.js
 *
 * Reads:  fcc_data/<StateName>/bdc_<FIPS>_<TechType>_fixed_broadband_*.csv
 * Writes: server/data/<state_abbr>.json  (one file per state)
 *
 * Output format per state file:
 * {
 *   "providers": [{ "id": "130037", "name": "All West/Wyoming Inc.", "techs": ["40","50"] }],
 *   "hexes": { "130037:40": ["8826b33151fffff", ...], ... }
 * }
 */

import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'server', 'data');

function findDataDir() {
  let dir = ROOT;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'fcc_data');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}
const DATA_DIR = findDataDir();

// CSV filename keyword → normalised app tech code
const CSV_TYPE_TO_TECH = {
  'Copper':                  '10',
  'Cable':                   '40',
  'FibertothePremises':      '50',
  'GSOSatellite':            '60',
  'NGSOSatellite':           '60',
  'LicensedFixedWireless':   '70',
  'LBRFixedWireless':        '70',
  'UnlicensedFixedWireless': '70',
};

// FIPS → state abbreviation
const FIPS_TO_ABBR = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT',
  '10':'DE','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN',
  '19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA',
  '26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV',
  '33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH',
  '40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN',
  '48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI',
  '56':'WY','72':'PR',
};

function detectTechCode(filename) {
  for (const [csvType, tech] of Object.entries(CSV_TYPE_TO_TECH)) {
    if (filename.includes(`_${csvType}_fixed_broadband_`)) return { csvType, tech };
  }
  return null;
}

function detectFips(filename) {
  const m = filename.match(/^bdc_(\d{2})_/);
  return m ? m[1] : null;
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

async function processFile(filePath, techCode, providers, hexes) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    let first = true;
    rl.on('line', (line) => {
      if (first) { first = false; return; }
      const { providerId, name } = extractProviderFields(line);
      if (!providerId) return;

      // Provider index
      if (!providers.has(providerId)) {
        providers.set(providerId, { name, techs: new Set() });
      }
      providers.get(providerId).techs.add(techCode);

      // Hex index
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

async function processStateDir(stateDir) {
  const statePath = path.join(DATA_DIR, stateDir);
  let files;
  try { files = readdirSync(statePath); } catch { return null; }

  // Group files by FIPS to handle mixed-state directories
  const filesByFips = new Map();
  for (const file of files) {
    if (!file.endsWith('.csv')) continue;
    const detected = detectTechCode(file);
    if (!detected) continue;
    const fips = detectFips(file);
    if (!fips) continue;
    if (!filesByFips.has(fips)) filesByFips.set(fips, []);
    filesByFips.get(fips).push({ file, ...detected });
  }

  const results = [];
  for (const [fips, entries] of filesByFips) {
    const abbr = FIPS_TO_ABBR[fips];
    if (!abbr) { console.warn(`  Unknown FIPS ${fips}, skipping`); continue; }

    const providers = new Map();
    const hexes = new Map();

    for (const { file, tech } of entries) {
      const filePath = path.join(statePath, file);
      console.log(`  Processing ${file} (tech ${tech})...`);
      await processFile(filePath, tech, providers, hexes);
    }

    // Serialize
    const providerList = [...providers.entries()].map(([id, { name, techs }]) => ({
      id,
      name,
      techs: [...techs].sort((a, b) => Number(a) - Number(b)),
    }));

    const hexMap = {};
    for (const [key, set] of hexes) {
      hexMap[key] = [...set];
    }

    results.push({ fips, abbr, providerList, hexMap });
  }
  return results;
}

async function main() {
  if (!DATA_DIR) {
    console.error('fcc_data/ directory not found (searched up from project root)');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const stateDirs = readdirSync(DATA_DIR).filter(d => {
    try { readdirSync(path.join(DATA_DIR, d)); return true; } catch { return false; }
  });

  for (const stateDir of stateDirs) {
    console.log(`\nProcessing ${stateDir}...`);
    const results = await processStateDir(stateDir);
    if (!results) continue;

    for (const { fips, abbr, providerList, hexMap } of results) {
      const outPath = path.join(OUT_DIR, `${abbr.toLowerCase()}.json`);
      const totalHexes = Object.values(hexMap).reduce((s, a) => s + a.length, 0);
      writeFileSync(outPath, JSON.stringify({ providers: providerList, hexes: hexMap }));
      console.log(`  → ${outPath} (${providerList.length} providers, ${totalHexes} hex entries)`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
