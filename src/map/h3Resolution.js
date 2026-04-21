/**
 * h3Resolution.js
 *
 * Zoom-adaptive H3 rendering helpers.
 *
 * The FCC BDC data is stored at H3 resolution 8 (~0.74 km² per cell).
 * At national zoom those cells are sub-pixel and invisible. This module
 * aggregates them up to coarser parent cells so coverage stays visible
 * at every zoom level.
 *
 * Resolution ladder (MapKit latitudeDelta → target H3 res):
 *   > 15°  →  3  (~100 km across each cell)
 *    8–15°  →  4  (~42 km)
 *    4–8°   →  5  (~16 km)
 *    2–4°   →  6  (~6 km)
 *    1–2°   →  7  (~2 km)
 *   < 1°   →  8  (original, ~0.9 km)
 */
import { cellToParent, cellToBoundary, getResolution } from 'h3-js';

/**
 * Pick the coarsest H3 resolution that still looks good at the given
 * MapKit latitudeDelta (degrees of latitude visible on screen).
 *
 * @param {number} latDelta  map.region.span.latitudeDelta
 * @returns {number} target H3 resolution (3–8)
 */
export function targetResolution(latDelta) {
  if (latDelta > 15) return 3;
  if (latDelta > 8)  return 4;
  if (latDelta > 4)  return 5;
  if (latDelta > 2)  return 6;
  if (latDelta > 1)  return 7;
  return 8;
}

/**
 * Aggregate an array of H3 indices to a lower (coarser) resolution.
 * Cells that are already at or coarser than `res` are kept as-is.
 * Duplicates introduced by parenting are removed.
 *
 * @param {string[]} h3Indices  original fine-resolution H3 cells
 * @param {number}   res        target resolution (must be ≤ input resolution)
 * @returns {string[]}
 */
export function aggregateH3(h3Indices, res) {
  if (!h3Indices?.length) return [];
  const seen = new Set();
  for (const h of h3Indices) {
    if (!h) continue;
    try {
      const cell = getResolution(h) <= res ? h : cellToParent(h, res);
      seen.add(cell);
    } catch { /* malformed index — skip */ }
  }
  return [...seen];
}

/**
 * Convert an array of H3 indices to a GeoJSON FeatureCollection of polygons.
 *
 * @param {string[]} h3Indices
 * @returns {GeoJSON.FeatureCollection}
 */
export function h3ToGeoJSON(h3Indices) {
  const features = [];
  for (const h of h3Indices) {
    if (!h) continue;
    try {
      const boundary = cellToBoundary(h); // [[lat, lng], ...]
      const ring = boundary.map(([lat, lng]) => [lng, lat]); // → [lng, lat]
      ring.push(ring[0]); // close the ring
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { h3index: h },
      });
    } catch { /* skip */ }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Extract raw H3 indices from a GeoJSON FeatureCollection returned by the
 * /api/coverage/hex endpoint. Both Firebase-sourced and FCC-tile-sourced
 * responses include h3index in feature.properties.
 *
 * @param {GeoJSON.FeatureCollection} geojson
 * @returns {string[]}
 */
export function extractH3Indices(geojson) {
  if (!geojson?.features?.length) return [];
  return geojson.features.map(f => f.properties?.h3index).filter(Boolean);
}
