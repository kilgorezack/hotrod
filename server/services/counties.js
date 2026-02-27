/**
 * US State GeoJSON service
 *
 * Loads US state boundaries from the us-atlas topojson package and
 * builds a lookup index by 2-digit state FIPS code.
 *
 * State feature IDs in us-atlas are 2-digit FIPS strings: '01', '06', etc.
 */

// Uses global fetch (Node.js 18+ native)

const STATES_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json';

let stateGeoJSONCache = null;   // Full GeoJSON FeatureCollection
let stateIndexCache = null;     // Map: '06' → Feature

async function loadStates() {
  if (stateGeoJSONCache) return stateGeoJSONCache;

  const topojson = await import('topojson-client');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let topology;
  try {
    const res = await fetch(STATES_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to load state boundaries: ${res.status}`);
    topology = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const geojson = topojson.feature(topology, topology.objects.states);
  stateGeoJSONCache = geojson;

  // Build index: '06' → Feature
  stateIndexCache = new Map();
  for (const feature of geojson.features) {
    if (feature.id !== undefined) {
      stateIndexCache.set(String(feature.id).padStart(2, '0'), feature);
    }
  }

  return geojson;
}

/**
 * Get the full state GeoJSON FeatureCollection.
 * Used by /api/geo/counties endpoint (kept for API compatibility).
 */
export async function getAllCounties() {
  return loadStates();
}

/**
 * Given an array of coverage rows [{ stateabbr }],
 * return a GeoJSON FeatureCollection of matching state polygons.
 */
export async function buildCoverageGeoJSON(coverageRows) {
  await loadStates();

  const features = [];
  for (const row of coverageRows) {
    const fips = STATE_FIPS[row.stateabbr?.toUpperCase()];
    if (!fips) continue;
    const feature = stateIndexCache.get(fips);
    if (feature) features.push(feature);
  }

  return { type: 'FeatureCollection', features };
}

// ─── State Abbreviation → FIPS Mapping ───────────────────────────────────────

const STATE_FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06',
  CO: '08', CT: '09', DE: '10', DC: '11', FL: '12',
  GA: '13', HI: '15', ID: '16', IL: '17', IN: '18',
  IA: '19', KS: '20', KY: '21', LA: '22', ME: '23',
  MD: '24', MA: '25', MI: '26', MN: '27', MS: '28',
  MO: '29', MT: '30', NE: '31', NV: '32', NH: '33',
  NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38',
  OH: '39', OK: '40', OR: '41', PA: '42', RI: '44',
  SC: '45', SD: '46', TN: '47', TX: '48', UT: '49',
  VT: '50', VA: '51', WA: '53', WV: '54', WI: '55',
  WY: '56', AS: '60', GU: '66', MP: '69', PR: '72', VI: '78',
};
