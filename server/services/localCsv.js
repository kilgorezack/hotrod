/**
 * Local FCC BDC CSV reader for offline/development use.
 *
 * Reads downloaded BDC CSV files from the fcc_data/ directory (auto-detected
 * by traversing up from this file), filters by provider_id, deduplicates
 * h3_res8_id values, and converts them to GeoJSON polygons via h3-js.
 *
 * Node.js only — not available in Cloudflare Workers. hexAgg.js wraps calls
 * in a try/catch and falls back to the FCC API when this module can't load.
 */
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellToBoundary } from 'h3-js';

// Maps the app's normalised BDC tech codes → CSV filename keywords.
// Multiple keywords = multiple CSV files merged (e.g., all three FW types → code 70).
const TECH_TO_CSV_TYPES = {
  '10': ['Copper'],
  '40': ['Cable'],
  '50': ['FibertothePremises'],
  '60': ['GSOSatellite', 'NGSOSatellite'],
  '70': ['LicensedFixedWireless', 'LBRFixedWireless', 'UnlicensedFixedWireless'],
};

// Walk up from this file's directory to find the first ancestor that contains fcc_data/.
function findDataDir() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'fcc_data');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function h3ToFeature(h3index) {
  const boundary = cellToBoundary(h3index); // [[lat, lng], ...]
  const ring = boundary.map(([lat, lng]) => [lng, lat]); // GeoJSON = [lng, lat]
  ring.push(ring[0]); // close the ring
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { h3index },
  };
}

// Stream a CSV file and collect unique H3 indices for one provider.
// Uses first/last field shortcuts (provider_id is always column 2, h3_res8_id is always last)
// so comma-in-brand_name doesn't cause off-by-one errors.
async function readH3sForProvider(filePath, providerId) {
  return new Promise((resolve, reject) => {
    const h3s = new Set();
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    let first = true;

    rl.on('line', (line) => {
      if (first) { first = false; return; } // skip header row
      const i1 = line.indexOf(',');          // end of frn
      const i2 = line.indexOf(',', i1 + 1); // end of provider_id
      if (line.slice(i1 + 1, i2) !== String(providerId)) return;
      const h3 = line.slice(line.lastIndexOf(',') + 1).trim();
      if (h3) h3s.add(h3);
    });

    rl.on('close', () => resolve(h3s));
    rl.on('error', reject);
  });
}

const _cache = new Map();

/**
 * Returns a GeoJSON FeatureCollection of H3 hexagon polygons for the given
 * provider + tech code, sourced from local CSV files.  Returns null when:
 *   - fcc_data/ directory is not found
 *   - no CSV files match the tech code
 *   - the provider has no rows in the matching files
 */
export async function getLocalHexCoverage(providerId, techCode) {
  const cacheKey = `${providerId}:${techCode}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

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

  _cache.set(cacheKey, result);
  setTimeout(() => _cache.delete(cacheKey), 3_600_000);

  console.info(
    `[local-csv] ${providerId}:${techCode} — ` +
    `${allH3s.size} unique hexes from ${filesChecked} file(s)`
  );
  return result;
}
