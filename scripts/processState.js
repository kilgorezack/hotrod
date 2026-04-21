/**
 * Extract a downloaded FCC BDC ZIP and import it to Firebase Storage.
 *
 * Usage:
 *   node scripts/processState.js <path-to-zip>
 *
 * Example:
 *   node scripts/processState.js ~/Downloads/bdc_Idaho_fixed_broadband_J25.zip
 *
 * What it does:
 *   1. Extracts the ZIP into fcc_data/{StateName}/
 *   2. Detects the state from the CSV filenames (bdc_{FIPS}_...)
 *   3. Runs the Firebase import for that state only
 *   4. Prints a summary
 *
 * Required env vars: FIREBASE_SERVICE_ACCOUNT, FIREBASE_STORAGE_BUCKET
 */

import 'dotenv/config';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIPS_TO_STATE = {
  '01':'Alabama','02':'Alaska','04':'Arizona','05':'Arkansas','06':'California',
  '08':'Colorado','09':'Connecticut','10':'Delaware','12':'Florida','13':'Georgia',
  '15':'Hawaii','16':'Idaho','17':'Illinois','18':'Indiana','19':'Iowa',
  '20':'Kansas','21':'Kentucky','22':'Louisiana','23':'Maine','24':'Maryland',
  '25':'Massachusetts','26':'Michigan','27':'Minnesota','28':'Mississippi',
  '29':'Missouri','30':'Montana','31':'Nebraska','32':'Nevada','33':'New Hampshire',
  '34':'New Jersey','35':'New Mexico','36':'New York','37':'North Carolina',
  '38':'North Dakota','39':'Ohio','40':'Oklahoma','41':'Oregon','42':'Pennsylvania',
  '44':'Rhode Island','45':'South Carolina','46':'South Dakota','47':'Tennessee',
  '48':'Texas','49':'Utah','50':'Vermont','51':'Virginia','53':'Washington',
  '54':'West Virginia','55':'Wisconsin','56':'Wyoming','72':'Puerto Rico',
};

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

// ─── Main ─────────────────────────────────────────────────────────────────────

const zipArg = process.argv[2];
if (!zipArg) {
  console.error('Usage: node scripts/processState.js <path-to-zip>');
  process.exit(1);
}

const zipPath = path.resolve(zipArg);
if (!existsSync(zipPath)) {
  console.error(`File not found: ${zipPath}`);
  process.exit(1);
}

// ── 1. Extract ZIP to a temp folder ─────────────────────────────────────────
const tmpDir = path.join(ROOT, 'fcc_data', '_tmp_extract');
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

console.log(`Extracting ${path.basename(zipPath)}...`);
try {
  execSync(`unzip -q "${zipPath}" -d "${tmpDir}"`);
} catch (e) {
  console.error('unzip failed:', e.message);
  process.exit(1);
}

// ── 2. Find CSV files and detect FIPS/state ──────────────────────────────────
function findCsvFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findCsvFiles(full));
    else if (entry.name.endsWith('.csv')) results.push(full);
  }
  return results;
}

const csvFiles = findCsvFiles(tmpDir);
if (csvFiles.length === 0) {
  console.error('No CSV files found in ZIP.');
  rmSync(tmpDir, { recursive: true });
  process.exit(1);
}

// Detect FIPS from first matching filename
const fipsMatch = csvFiles.map(f => path.basename(f).match(/^bdc_(\d{2})_/)).find(Boolean);
if (!fipsMatch) {
  console.error('Could not detect state FIPS from CSV filenames. Expected pattern: bdc_{FIPS}_...');
  rmSync(tmpDir, { recursive: true });
  process.exit(1);
}

const fips = fipsMatch[1];
const stateName = FIPS_TO_STATE[fips];
const stateAbbr = FIPS_TO_ABBR[fips];

if (!stateName) {
  console.error(`Unknown FIPS code: ${fips}`);
  rmSync(tmpDir, { recursive: true });
  process.exit(1);
}

console.log(`Detected state: ${stateName} (${stateAbbr}, FIPS ${fips})`);

// ── 3. Move CSV files to fcc_data/{StateName}/ ───────────────────────────────
const destDir = path.join(ROOT, 'fcc_data', stateName);
mkdirSync(destDir, { recursive: true });

let moved = 0;
for (const csvFile of csvFiles) {
  const dest = path.join(destDir, path.basename(csvFile));
  renameSync(csvFile, dest);
  moved++;
}
rmSync(tmpDir, { recursive: true });
console.log(`Moved ${moved} CSV files to fcc_data/${stateName}/`);

// ── 4. Run Firebase import for this state ────────────────────────────────────
console.log(`\nImporting ${stateName} data to Firebase...\n`);
try {
  execSync(
    `node ${path.join(ROOT, 'scripts', 'importToFirebase.js')} --state ${stateAbbr}`,
    { stdio: 'inherit', cwd: ROOT }
  );
} catch (e) {
  console.error('Import failed:', e.message);
  process.exit(1);
}
