/**
 * US County GeoJSON service
 *
 * Downloads and caches US county boundaries from the US Census TIGER/Line
 * simplified GeoJSON. Returns a GeoJSON FeatureCollection indexed by
 * county FIPS code for fast lookup.
 *
 * County FIPS = 5-digit code: 2-digit state + 3-digit county.
 * Stored in properties.GEOID or properties.GEO_ID in Census files.
 */

import fetch from 'node-fetch';
import { createRequire } from 'module';

// US Census Bureau simplified county boundaries (~1.5 MB GeoJSON)
const COUNTY_GEOJSON_URL =
  'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';

// Fallback: low-res county file from Eric Celeste's topojson
const COUNTIES_URL =
  'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json';

let countyGeoJSONCache = null;       // Full GeoJSON FeatureCollection
let countyIndexCache = null;         // Map: FIPS → Feature
let stateGeoJSONCache = null;

/**
 * Load and parse US counties from the us-atlas topojson package.
 * We inline a fetch so no local file is required.
 *
 * The topojson file contains two objects: "counties" and "states".
 * We use topojson-client to convert to GeoJSON.
 */
async function loadCounties() {
  if (countyGeoJSONCache) return countyGeoJSONCache;

  // Dynamically import topojson-client (ESM)
  const topojson = await import('topojson-client');

  const res = await fetch(COUNTIES_URL, { timeout: 20000 });
  if (!res.ok) throw new Error(`Failed to load county data: ${res.status}`);

  const topology = await res.json();

  // Convert counties object from TopoJSON to GeoJSON
  const geojson = topojson.feature(topology, topology.objects.counties);

  countyGeoJSONCache = geojson;

  // Build FIPS index
  countyIndexCache = new Map();
  for (const feature of geojson.features) {
    const fips = feature.id; // us-atlas uses numeric id = 5-digit FIPS
    if (fips !== undefined) {
      countyIndexCache.set(String(fips).padStart(5, '0'), feature);
    }
  }

  return geojson;
}

/**
 * Get the full county GeoJSON FeatureCollection.
 * Used by /api/geo/counties endpoint.
 */
export async function getAllCounties() {
  return loadCounties();
}

/**
 * Given an array of coverage rows [{stateabbr, countycode}],
 * return a GeoJSON FeatureCollection of only the covered counties.
 *
 * stateabbr: e.g. "CA", "TX"
 * countycode: 3-digit county FIPS, e.g. "001", "075"
 *
 * We look up state FIPS from the stateabbr → FIPS mapping below.
 */
export async function buildCoverageGeoJSON(coverageRows) {
  await loadCounties();

  const features = [];

  for (const row of coverageRows) {
    const stateFips = STATE_FIPS[row.stateabbr?.toUpperCase()];
    if (!stateFips) continue;

    // Pad county code to 3 digits
    const countyPart = String(row.countycode || '').padStart(3, '0');
    const fullFips = stateFips + countyPart;

    const feature = countyIndexCache.get(fullFips);
    if (feature) features.push(feature);
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

// ─── State Abbreviation → FIPS Code Mapping ──────────────────────────────────

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
