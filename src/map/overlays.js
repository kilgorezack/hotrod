import { map } from './init.js';
import { hexToRgba } from '../utils/colors.js';

/**
 * Tracks active overlays per provider key.
 * Key: `${providerId}:${techCode}`
 * Value: { overlays: mapkit.PolygonOverlay[], visible: boolean }
 */
const providerOverlays = new Map();

/**
 * Add a GeoJSON FeatureCollection as county coverage overlays for a provider.
 *
 * @param {string} providerId
 * @param {string} techCode
 * @param {string} colorHex   — provider's assigned hex color
 * @param {object} geojson    — FeatureCollection of county polygons
 * @returns {number}           — number of overlays added
 */
export async function addCoverageOverlay(providerId, techCode, colorHex, geojson) {
  const key = layerKey(providerId, techCode);

  // Remove existing overlay for this key if any
  removeCoverageOverlay(providerId, techCode);

  if (!map) return 0;
  if (!geojson?.features?.length) return 0;

  const fillColor = hexToRgba(colorHex, 0.28);
  const strokeColor = hexToRgba(colorHex, 0.65);

  const style = new mapkit.Style({
    fillColor,
    strokeColor,
    lineWidth: 0.8,
    strokeOpacity: 0.8,
    fillOpacity: 1, // opacity already baked into fillColor rgba
  });

  // mapkit.importGeoJSON returns an ItemCollection or calls a callback
  const items = await importGeoJSONAsync(geojson);
  const overlays = [];

  for (const item of items) {
    if (item instanceof mapkit.PolygonOverlay || item instanceof mapkit.PolylineOverlay) {
      item.style = style;
      item.data = { providerId, techCode };
      overlays.push(item);
    }
  }

  if (overlays.length > 0) {
    map.addOverlays(overlays);
  }

  providerOverlays.set(key, { overlays, visible: true });
  return overlays.length;
}

/**
 * Remove all overlays for a provider + tech combination.
 */
export function removeCoverageOverlay(providerId, techCode) {
  const key = layerKey(providerId, techCode);
  const entry = providerOverlays.get(key);
  if (!entry || !map) return;
  map.removeOverlays(entry.overlays);
  providerOverlays.delete(key);
}

/**
 * Toggle visibility of a provider's overlay layer.
 */
export function toggleCoverageOverlay(providerId, techCode, visible) {
  const key = layerKey(providerId, techCode);
  const entry = providerOverlays.get(key);
  if (!entry) return;

  entry.visible = visible;
  for (const overlay of entry.overlays) {
    overlay.visible = visible;
  }
}

/**
 * Remove all overlays from the map (cleanup).
 */
export function removeAllOverlays() {
  if (!map) return;
  for (const [key, entry] of providerOverlays) {
    map.removeOverlays(entry.overlays);
    providerOverlays.delete(key);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function layerKey(providerId, techCode) {
  return `${providerId}:${techCode}`;
}

/**
 * Promisify mapkit.importGeoJSON.
 * Returns an array of MapKit items (overlays, annotations).
 */
function importGeoJSONAsync(geojsonData) {
  return new Promise((resolve, reject) => {
    mapkit.importGeoJSON(geojsonData, (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      // result is an ItemCollection — extract the items array
      const items = result.items ?? result ?? [];
      resolve(Array.isArray(items) ? items : [items]);
    });
  });
}
