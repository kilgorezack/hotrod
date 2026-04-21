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

// Use Firebase Storage REST URL format — Security Rules apply to these.
// FIREBASE_STORAGE_BUCKET e.g. "hotrod-7a59d.firebasestorage.app"
const BUCKET = (process.env.FIREBASE_STORAGE_BUCKET || '').replace(/\/$/, '');

function storageUrl(storagePath) {
  const encoded = encodeURIComponent(storagePath);
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encoded}?alt=media`;
}

function isConfigured() {
  return BUCKET.length > 0;
}

// ─── Provider index ───────────────────────────────────────────────────────────
// providers.json is ~100-200KB — load once and keep in memory.

let _providersPromise = null;

function getProviders() {
  if (!_providersPromise) {
    _providersPromise = fetch(storageUrl('providers.json'))
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

  const url = storageUrl(`hexes/${providerId}_${techCode}.json`);
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

/**
 * Write a complete GeoJSON FeatureCollection (sourced from FCC tiles) back to
 * Firebase Storage so future requests are served instantly.
 * Overwrites any previously incomplete CSV-derived data.
 */
export async function saveFirebaseHexCoverage(providerId, techCode, features) {
  if (!isConfigured() || !features?.length) return;
  const BUCKET_NAME = BUCKET;
  if (!BUCKET_NAME) return;

  // Extract h3index values from the FCC tile features
  const h3arr = features.map(f => f.properties?.h3index).filter(Boolean);
  if (!h3arr.length) return;

  const storagePath = `hexes/${providerId}_${techCode}.json`;
  const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET_NAME}/o/${encodeURIComponent(storagePath)}`;

  try {
    // Firebase Storage REST upload requires an auth token — skip silently if
    // we don't have write credentials in this environment (public read-only).
    const adminModule = await import('firebase-admin/app').catch(() => null);
    if (!adminModule) return;
    const { getApps, initializeApp, cert } = adminModule;
    const { getStorage } = await import('firebase-admin/storage');
    if (!getApps().length) {
      if (!process.env.FIREBASE_SERVICE_ACCOUNT) return;
      initializeApp({
        credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
        storageBucket: BUCKET_NAME,
      });
    }
    const bucket = getStorage().bucket();
    const file = bucket.file(storagePath);
    await file.save(JSON.stringify(h3arr), {
      contentType: 'application/json',
      metadata: { cacheControl: 'public, max-age=86400' },
    });
    // Update in-memory cache with the fresh complete data
    const result = { type: 'FeatureCollection', features };
    _hexCache.set(`${providerId}:${techCode}`, result);
    console.info(`[firebase] saved complete tile data for ${providerId}:${techCode} — ${h3arr.length} hexes`);
  } catch (err) {
    // Non-fatal — app still works without the write-back
    console.warn(`[firebase] write-back failed for ${providerId}:${techCode}:`, err.message);
  }
}
