/**
 * Import FCC BDC CSV data into Firebase Storage.
 *
 * Usage:
 *   node scripts/importToFirebase.js [--state WY] [--dry-run]
 *
 * Required env vars (in .env):
 *   FIREBASE_SERVICE_ACCOUNT  JSON string of the service account key
 *   FIREBASE_STORAGE_BUCKET   e.g. "myproject.firebasestorage.app"
 *
 * Uploads to Firebase Storage:
 *   providers.json              ← merged provider index across all processed states
 *   hexes/{providerId}_{tech}.json  ← array of H3 indices per provider+tech
 *
 * Run once per state (or omit --state to process all states in fcc_data/).
 * Re-runs are safe — files are overwritten.
 */

import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const FILTER_STATE = args[args.indexOf('--state') + 1]?.toUpperCase();
const DRY_RUN = args.includes('--dry-run');

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

const FIPS_TO_ABBR = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT',
  '10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN',
  '19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA',
  '26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV',
  '33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH',
  '40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN',
  '48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI',
  '56':'WY','72':'PR',
};

// ─── Validate env ─────────────────────────────────────────────────────────────

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT in .env');
  process.exit(1);
}
if (!process.env.FIREBASE_STORAGE_BUCKET) {
  console.error('Missing FIREBASE_STORAGE_BUCKET in .env');
  process.exit(1);
}

// ─── Firebase init ────────────────────────────────────────────────────────────

if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}
const bucket = getStorage().bucket();

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function findDataDir() {
  let dir = ROOT;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'fcc_data');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function detectTechCode(filename) {
  for (const [csvType, tech] of Object.entries(CSV_TYPE_TO_TECH)) {
    if (filename.includes(`_${csvType}_fixed_broadband_`)) return tech;
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

// Processes one CSV file, uploading hex data immediately to avoid OOM on large states.
// Returns provider info (lightweight) so providers.json can be updated at the end.
async function processAndUploadFile(filePath, techCode) {
  const providers = new Map(); // id → { name, techs: Set }
  const hexes     = new Map(); // "id_tech" → Set<h3>

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
      const key = `${providerId}_${techCode}`;
      if (!hexes.has(key)) hexes.set(key, new Set());
      hexes.get(key).add(h3);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  // Upload hex files immediately, then free memory
  let uploaded = 0;
  const tasks = [...hexes.entries()].map(([key, h3Set]) => async () => {
    await uploadJSON(`hexes/${key}.json`, [...h3Set]);
    uploaded++;
    if (uploaded % 50 === 0 || uploaded === hexes.size) {
      process.stdout.write(`\r  ${uploaded}/${hexes.size} hex files`);
    }
  });
  await uploadBatch(tasks, 20);
  if (hexes.size > 0) process.stdout.write('\n');

  return providers;
}

// ─── Upload helpers ───────────────────────────────────────────────────────────

async function uploadJSON(storagePath, data) {
  if (DRY_RUN) { console.log(`  [dry-run] would upload ${storagePath}`); return; }
  const file = bucket.file(storagePath);
  await file.save(JSON.stringify(data), {
    contentType: 'application/json',
    metadata: { cacheControl: 'public, max-age=86400' },
  });
}

async function uploadBatch(tasks, concurrency = 20) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dataDir = findDataDir();
  if (!dataDir) { console.error('fcc_data/ not found'); process.exit(1); }

  const allProviders = new Map(); // id → { name, techs: Set } — stays small

  const stateDirs = readdirSync(dataDir).filter(d => {
    try { readdirSync(path.join(dataDir, d)); return true; } catch { return false; }
  });

  let filesProcessed = 0;
  for (const stateDir of stateDirs) {
    const statePath = path.join(dataDir, stateDir);
    let files;
    try { files = readdirSync(statePath); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith('.csv')) continue;
      const tech = detectTechCode(file);
      const fips = detectFips(file);
      if (!tech || !fips) continue;

      const abbr = FIPS_TO_ABBR[fips];
      if (!abbr) continue;
      if (FILTER_STATE && abbr !== FILTER_STATE) continue;

      console.log(`Processing ${file}...`);
      const fileProviders = await processAndUploadFile(path.join(statePath, file), tech);
      filesProcessed++;

      for (const [id, { name, techs }] of fileProviders) {
        if (!allProviders.has(id)) allProviders.set(id, { name, techs: new Set() });
        for (const t of techs) allProviders.get(id).techs.add(t);
      }
    }
  }

  if (allProviders.size === 0) {
    console.error('No data found. Did you download CSV files to fcc_data/?');
    process.exit(1);
  }

  console.log(`\nProcessed ${filesProcessed} files, ${allProviders.size} providers`);

  // ── Merge and upload providers.json ───────────────────────────────────────
  let existingProviders = {};
  if (!DRY_RUN) {
    try {
      const [buf] = await bucket.file('providers.json').download();
      existingProviders = Object.fromEntries(
        JSON.parse(buf.toString()).map(p => [p.id, p])
      );
      console.log(`Merging with ${Object.keys(existingProviders).length} existing providers`);
    } catch { /* no existing file — start fresh */ }
  }

  for (const [id, { name, techs }] of allProviders) {
    if (existingProviders[id]) {
      const merged = new Set([...existingProviders[id].techs, ...[...techs]]);
      existingProviders[id] = { id, name, techs: [...merged].sort((a,b)=>Number(a)-Number(b)) };
    } else {
      existingProviders[id] = { id, name, techs: [...techs].sort((a,b)=>Number(a)-Number(b)) };
    }
  }

  const providerList = Object.values(existingProviders);
  console.log(`Uploading providers.json (${providerList.length} providers)...`);
  await uploadJSON('providers.json', providerList);

  console.log(`\nDone.${DRY_RUN ? ' (dry run — nothing was uploaded)' : ''}`);
}

main().catch(err => { console.error(err); process.exit(1); });
