/**
 * Firebase Storage data service.
 *
 * Reads from public Firebase Storage URLs — no SDK needed for reads.
 * Requires FIREBASE_STORAGE_BASE env var pointing to the public bucket URL.
 *
 * Public API:
 *   searchFirebaseProviders(query, limit)  → [{ id, name }]
 *   getFirebaseProviderTechs(providerId)   → ['10', '40', ...]
 *   getFirebaseHexCoverage(id, techCode)   → GeoJSON FeatureCollection | null
 */
import { cellToBoundary } from 'h3-js';

const BASE = (process.env.FIREBASE_STORAGE_BASE || '').replace(/\/$/, '');

function isConfigured() {
  return BASE.length > 0;
}

// ─── Provider index ───────────────────────────────────────────────────────────
// providers.json is ~100-200KB — load once and keep in memory.

let _providersPromise = null;

function getProviders() {
  if (!_providersPromise) {
    _providersPromise = fetch(`${BASE}/providers.json`)
      .then(r => {
        if (!r.ok) throw new Error(`providers.json fetch failed: ${r.status}`);
        return r.json();
      })
      .then(list => {
        // Build a Map for O(1) lookups
        const map = new Map(list.map(p => [p.id, p]));
        console.info(`[firebase] Provider index loaded — ${map.size} providers`);
        return map;
      });
  }
  return _providersPromise;
}

export async function searchFirebaseProviders(query, limit = 20) {
  if (!isConfigured()) return null;
  const providers = await getProviders();
  const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const results = [];
  for (const [id, { name }] of providers) {
    const lower = name.toLowerCase();
    if (tokens.every(t => lower.includes(t))) {
      results.push({ id, name });
      if (results.length >= limit) break;
    }
  }
  return results;
}

export async function getFirebaseProviderTechs(providerId) {
  if (!isConfigured()) return null;
  const providers = await getProviders();
  const entry = providers.get(String(providerId));
  return entry ? entry.techs : null;
}

// ─── Hex coverage ─────────────────────────────────────────────────────────────

function h3ToFeature(h3index) {
  const boundary = cellToBoundary(h3index);
  const ring = boundary.map(([lat, lng]) => [lng, lat]);
  ring.push(ring[0]);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { h3index },
  };
}

const _hexCache = new Map();

export async function getFirebaseHexCoverage(providerId, techCode) {
  if (!isConfigured()) return null;
  const cacheKey = `${providerId}:${techCode}`;
  if (_hexCache.has(cacheKey)) return _hexCache.get(cacheKey);

  const url = `${BASE}/hexes/${providerId}_${techCode}.json`;
  let h3arr;
  try {
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    h3arr = await res.json();
  } catch (err) {
    console.warn(`[firebase] hex fetch failed ${cacheKey}:`, err.message);
    return null;
  }

  if (!Array.isArray(h3arr) || h3arr.length === 0) return null;

  const features = h3arr.map(h3ToFeature);
  const result = { type: 'FeatureCollection', features };

  _hexCache.set(cacheKey, result);
  setTimeout(() => _hexCache.delete(cacheKey), 3_600_000);

  console.info(`[firebase] ${cacheKey} — ${features.length} hexes`);
  return result;
}
