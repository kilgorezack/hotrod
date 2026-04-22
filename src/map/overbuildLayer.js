/**
 * overbuildLayer.js — Provider competition heatmap.
 *
 * Loads the pre-built H3 res-3 coverage index and renders each cell
 * as a colored polygon based on how many providers serve it:
 *   1 provider  → slate  (monopoly)
 *   2 providers → amber  (duopoly)
 *   3 providers → orange (competitive)
 *   4+          → red    (highly competitive)
 *
 * Completely independent of the existing provider coverage overlays —
 * toggling this layer does not affect anything else on the map.
 */

import { h3ToGeoJSON } from './h3Resolution.js';

// ─── Module state ─────────────────────────────────────────────────────────────

let _map          = null;
let _overlays     = [];       // mapkit.PolygonOverlay[]
let _visible      = false;
let _indexPromise = null;     // fetch cache

// ─── Public API ───────────────────────────────────────────────────────────────

export function initOverbuildLayer(mapInstance) {
  _map = mapInstance;
}

export function isOverbuildVisible() {
  return _visible;
}

/**
 * Toggle the heatmap on/off.
 * @returns {Promise<boolean>} new visible state
 */
export async function toggleOverbuildLayer() {
  if (_visible) {
    _hide();
    return false;
  }
  await _show();
  return true;
}

// ─── Index loading ────────────────────────────────────────────────────────────

async function _loadIndex() {
  if (_indexPromise) return _indexPromise;
  _indexPromise = fetch('/coverage_index_r3.json')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .catch(err => {
      _indexPromise = null; // allow retry
      throw err;
    });
  return _indexPromise;
}

// ─── Render ───────────────────────────────────────────────────────────────────

async function _show() {
  if (!_map) return;

  const index = await _loadIndex();

  // Group cells by provider count so we batch-create overlays per color tier
  const byCount = new Map(); // count → string[]
  for (const [cell, providers] of Object.entries(index)) {
    const n = providers.length;
    if (!byCount.has(n)) byCount.set(n, []);
    byCount.get(n).push(cell);
  }

  const allOverlays = [];

  for (const [count, cells] of byCount) {
    const { fill, stroke, fillOpacity, strokeOpacity } = _styleForCount(count);

    // h3ToGeoJSON returns a FeatureCollection; extract coordinates per feature
    const geojson = h3ToGeoJSON(cells);

    for (const feature of geojson.features) {
      const rings = feature.geometry?.coordinates;
      if (!rings?.length) continue;

      // GeoJSON uses [lng, lat]; MapKit uses (lat, lng)
      const points = rings[0]
        .slice(0, -1) // drop closing duplicate point
        .map(([lng, lat]) => new mapkit.Coordinate(lat, lng));

      if (points.length < 3) continue;

      allOverlays.push(new mapkit.PolygonOverlay(points, {
        style: new mapkit.Style({
          fillColor:     fill,
          fillOpacity,
          strokeColor:   stroke,
          strokeOpacity,
          lineWidth:     0.5,
        }),
      }));
    }
  }

  if (allOverlays.length) {
    _map.addOverlays(allOverlays);
    _overlays = allOverlays;
  }

  _visible = true;
}

function _hide() {
  if (!_map || !_overlays.length) return;
  try { _map.removeOverlays(_overlays); } catch { /* already removed */ }
  _overlays = [];
  _visible  = false;
}

// ─── Color scale ──────────────────────────────────────────────────────────────

function _styleForCount(count) {
  if (count === 1) return { fill: '#94a3b8', stroke: '#94a3b8', fillOpacity: 0.18, strokeOpacity: 0.35 };
  if (count === 2) return { fill: '#fbbf24', stroke: '#f59e0b', fillOpacity: 0.28, strokeOpacity: 0.50 };
  if (count === 3) return { fill: '#f97316', stroke: '#ea580c', fillOpacity: 0.38, strokeOpacity: 0.60 };
  /*  4+         */ return { fill: '#ef4444', stroke: '#dc2626', fillOpacity: 0.50, strokeOpacity: 0.70 };
}
