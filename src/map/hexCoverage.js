/**
 * hexCoverage.js
 *
 * Fetches FCC BDC provider hex coverage from the server-side aggregation
 * endpoint (server/routes/hexAgg.js).
 *
 * The server fans out all 352 US tile requests to FCC in parallel,
 * decodes PBF, and returns a single GeoJSON FeatureCollection.
 * This replaces the old approach of 352 individual browser→server requests.
 */

// Form 477 sub-codes → BDC parent codes (mirrored in server/routes/hexAgg.js)
const FORM477_TO_BDC = {
  '11': '10', '12': '10', '20': '10', '30': '10', // DSL sub-codes → DSL (10)
  '41': '40', '43': '40',                          // DOCSIS 3+/3.1  → Cable (40)
};

/** In-memory cache keyed by "providerId:bdcTechCode" */
const _cache = new Map();

/**
 * Fetch FCC BDC hexagon coverage for a provider+tech combination.
 *
 * @param {string|number} providerId  FCC BDC provider_id
 * @param {string|number} techCode    Tech code (Form 477 or BDC)
 * @returns {Promise<GeoJSON.FeatureCollection|null>}
 */
export async function fetchHexCoverage(providerId, techCode) {
  const bdcTech = FORM477_TO_BDC[String(techCode)] ?? String(techCode);

  // tech 300 (5G NR) has no BDC tile equivalent
  if (bdcTech === '300') return null;

  const key = `${providerId}:${bdcTech}`;
  if (_cache.has(key)) return _cache.get(key);

  const mapped = bdcTech !== String(techCode) ? ` (${techCode} → BDC ${bdcTech})` : '';
  console.info(`[hexCoverage] Requesting server-aggregated hex for ${providerId}:${bdcTech}${mapped}…`);

  try {
    const res = await fetch(`/api/coverage/hex/${providerId}/${bdcTech}`);

    if (!res.ok) {
      console.warn(`[hexCoverage] Server returned ${res.status} for ${providerId}:${bdcTech}`);
      return null;
    }

    const geojson = await res.json();
    const count   = geojson.features?.length ?? 0;
    console.info(`[hexCoverage] Got ${count} hex features for ${providerId}:${bdcTech}`);

    const result = count > 0 ? geojson : null;
    _cache.set(key, result);
    return result;
  } catch (err) {
    console.warn('[hexCoverage] fetch error:', err.message);
    return null;
  }
}
