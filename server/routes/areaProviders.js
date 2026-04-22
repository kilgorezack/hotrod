/**
 * POST /api/area-providers
 *
 * Given a drawn polygon, returns all broadband providers with confirmed
 * H3-cell coverage in that area using a pre-built H3 res-3 reverse index.
 *
 * Index loading (in priority order):
 *   1. Static import of coverageIndex.js  — works in local dev / Cloudflare Workers
 *   2. GitHub raw CDN fetch               — works in Vercel serverless (no bundling issues)
 *   3. Error response                     — fast failure; no Socrata fallback that times out
 *
 * Regenerate the index after each FCC BDC data refresh:
 *   FIREBASE_STORAGE_BUCKET=... node scripts/buildCoverageIndex.js
 */

import { Hono } from 'hono';
import { polygonToCells, latLngToCell } from 'h3-js';

// Static import: works locally and in bundled environments that trace imports.
// May be an empty object {} if the bundler didn't include the file — that's fine,
// we fall back to the GitHub CDN fetch below.
import _staticIndex from '../data/coverageIndex.js';

const router = new Hono();

// ─── Constants ────────────────────────────────────────────────────────────────

const INDEX_RES = 3; // resolution of the coverage index (~100 km cells)

// URL of the JSON version, committed to the public repo — always fresh,
// no auth required, works from any serverless environment.
const INDEX_CDN_URL = 'https://raw.githubusercontent.com/kilgorezack/hotrod/main/server/data/coverage_index_r3.json';

// ─── Index loader ─────────────────────────────────────────────────────────────

let _remoteIndex      = null;
let _remoteIndexFetch = null; // in-flight promise, prevents duplicate fetches

function _staticIndexValid() {
  // The static import gives us a real object with >0 keys when bundled correctly.
  // An empty object {} means the bundler didn't include the file.
  return _staticIndex && typeof _staticIndex === 'object' && Object.keys(_staticIndex).length > 0;
}

async function _fetchRemoteIndex() {
  if (_remoteIndex) return _remoteIndex;
  if (_remoteIndexFetch) return _remoteIndexFetch;

  _remoteIndexFetch = (async () => {
    try {
      console.info('[area-providers] fetching coverage index from CDN…');
      const res = await fetch(INDEX_CDN_URL, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) throw new Error(`CDN HTTP ${res.status}`);
      _remoteIndex = await res.json();
      console.info('[area-providers] coverage index loaded from CDN');
      return _remoteIndex;
    } catch (err) {
      console.error('[area-providers] CDN index fetch failed:', err.message);
      return null;
    }
  })();

  return _remoteIndexFetch;
}

async function getIndex() {
  if (_staticIndexValid()) return _staticIndex;
  return _fetchRemoteIndex();
}

// Warm up on module init so cold starts don't add latency to the first request
if (!_staticIndexValid()) {
  _fetchRemoteIndex().catch(() => {});
}

// ─── H3 helpers ───────────────────────────────────────────────────────────────

function computePolygonCells(vertices, resolution) {
  const coords = vertices.map(v => [v.latitude, v.longitude]);
  if (coords[0][0] !== coords.at(-1)[0] || coords[0][1] !== coords.at(-1)[1]) {
    coords.push(coords[0]);
  }

  let cells;
  try { cells = polygonToCells(coords, resolution); } catch { cells = []; }

  if (cells.length === 0) {
    // Polygon too small for this resolution — use centroid cell
    const lat = vertices.reduce((s, v) => s + v.latitude,  0) / vertices.length;
    const lng = vertices.reduce((s, v) => s + v.longitude, 0) / vertices.length;
    cells = [latLngToCell(lat, lng, resolution)];
  }

  return new Set(cells);
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.post('/', async (c) => {
  const start = Date.now();

  let body;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const polygon = body?.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return c.json({ error: 'polygon must be ≥3 {latitude,longitude} points' }, 400);
  }

  // Convert polygon to res-3 cells for index lookup
  let r3cells;
  try {
    r3cells = computePolygonCells(polygon, INDEX_RES);
  } catch (err) {
    return c.json({ error: `H3 conversion failed: ${err.message}` }, 400);
  }

  // Load index (static import or CDN fetch)
  const index = await getIndex();
  if (!index) {
    console.error('[area-providers] coverage index unavailable');
    return c.json({ error: 'Coverage index temporarily unavailable — try again in a moment.' }, 503);
  }

  // Look up all providers whose res-3 cells overlap the polygon
  const providerMap = new Map();
  for (const cell of r3cells) {
    for (const { id, name, techs } of (index[cell] ?? [])) {
      if (!providerMap.has(id)) {
        providerMap.set(id, { providerId: id, providerName: name, techCodes: new Set(techs) });
      } else {
        for (const t of techs) providerMap.get(id).techCodes.add(t);
      }
    }
  }

  const providers = [...providerMap.values()]
    .map(p => ({ ...p, techCodes: [...p.techCodes].sort((a, b) => Number(a) - Number(b)) }))
    .sort((a, b) => a.providerName.localeCompare(b.providerName));

  const durationMs = Date.now() - start;
  const source = _staticIndexValid() ? 'static' : 'cdn';
  console.info(
    `[area-providers] ${source}: ${r3cells.size} cells → ${providers.length} providers, ${durationMs}ms`
  );

  return c.json({
    providers,
    polygonCells: r3cells.size,
    meta: { durationMs, source },
  });
});

export default router;
