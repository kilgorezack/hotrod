import { API_BASE } from '../config.js';

/**
 * Fetch coverage GeoJSON for a provider + technology combination.
 * Returns a GeoJSON FeatureCollection of covered county polygons.
 *
 * @param {string} providerId
 * @param {string} techCode
 * @returns {Promise<{type: string, features: Array, meta: object}>}
 */
export async function getCoverageGeoJSON(providerId, techCode) {
  const url = `${API_BASE}/coverage?provider_id=${encodeURIComponent(providerId)}&tech_code=${encodeURIComponent(techCode)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Coverage fetch failed: ${res.status}`);
  }
  return res.json();
}
