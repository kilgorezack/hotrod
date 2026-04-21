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
export function addCoverageOverlay(providerId, techCode, colorHex, geojson) {
  const key = layerKey(providerId, techCode);

  removeCoverageOverlay(providerId, techCode);

  if (!map) return 0;
  if (!geojson?.features?.length) return 0;

  const style = new mapkit.Style({
    fillColor:     hexToRgba(colorHex, 0.28),
    strokeColor:   hexToRgba(colorHex, 0.65),
    lineWidth:     0.8,
    strokeOpacity: 0.8,
    fillOpacity:   1,
  });

  const overlays = [];
  for (const feature of geojson.features) {
    const rings = feature.geometry?.coordinates;
    if (!rings?.[0]?.length) continue;
    // GeoJSON coords are [lng, lat]; MapKit.Coordinate takes (lat, lng)
    // Drop the closing duplicate point (last === first in GeoJSON rings)
    const points = rings[0].slice(0, -1).map(([lng, lat]) => new mapkit.Coordinate(lat, lng));
    if (points.length < 3) continue;
    const overlay = new mapkit.PolygonOverlay(points, { style, data: { providerId, techCode } });
    overlays.push(overlay);
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

function layerKey(providerId, techCode) {
  return `${providerId}:${techCode}`;
}
