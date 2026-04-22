/**
 * POST /api/area-providers
 *
 * Given a drawn polygon, returns all broadband providers with confirmed
 * H3-cell coverage in that area using a pre-built H3 res-3 reverse index.
 *
 * The index (coverage_index_r3.json, ~1 MB) is copied to dist/client/ at
 * build time and served by Vercel's CDN as a static file. The Lambda fetches
 * it from the same deployment on first cold start and caches it in memory.
 *
 * This avoids ALL module-level large-file imports that block the event loop
 * during Lambda cold starts and cause FUNCTION_INVOCATION_TIMEOUT.
 *
 * Regenerate the index after each FCC BDC data refresh:
 *   FIREBASE_STORAGE_BUCKET=... node scripts/buildCoverageIndex.js
 */

import { Hono } from 'hono';
import { polygonToCells, latLngToCell } from 'h3-js';

const router = new Hono();

// ─── Constants ────────────────────────────────────────────────────────────────

const INDEX_RES = 3; // resolution of the coverage index (~100 km cells)

// The index is served as a static asset from the same Vercel deployment.
// Populated at request time from the HOST header so it works on any domain.
let _indexUrl = null;
function getIndexUrl(host) {
  if (_indexUrl) return _indexUrl;
  const base = host?.includes('localhost') ? `http://${host}` : `https://${host}`;
  _indexUrl = `${base}/coverage_index_r3.json`;
  return _indexUrl;
}

// ─── Index cache ─────────────────────────────────────────────────────────────

let _index      = null;
let _indexFetch = null; // deduplicate concurrent cold-start fetches

function _isValid(obj) {
  return obj != null && typeof obj === 'object' && Object.keys(obj).length > 0;
}

function _fetchWithDeadline(url, ms) {
  // Promise.race + setTimeout — reliable in all Node.js/Lambda environments.
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`index fetch timed out after ${ms}ms`)), ms);
    fetch(url)
      .then(r => { clearTimeout(t); resolve(r); })
      .catch(e => { clearTimeout(t); reject(e); });
  });
}

async function loadIndex(host) {
  if (_isValid(_index)) return _index;
  if (_indexFetch)       return _indexFetch;

  const url = getIndexUrl(host);

  _indexFetch = (async () => {
    try {
      console.info('[area-providers] loading index from', url);
      const res = await _fetchWithDeadline(url, 10_000);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      _index = await res.json();
      console.info('[area-providers] index ready —', Object.keys(_index).length, 'cells');
      return _index;
    } catch (err) {
      console.error('[area-providers] index load failed:', err.message);
      _indexFetch = null; // allow retry on next request
      return null;
    }
  })();

  return _indexFetch;
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

  // Convert polygon to res-3 cells
  let r3cells;
  try {
    r3cells = computePolygonCells(polygon, INDEX_RES);
  } catch (err) {
    return c.json({ error: `H3 conversion failed: ${err.message}` }, 400);
  }

  // Load index (CDN-cached after first cold start)
  const host  = c.req.header('host') || 'hotrod.summitlabs.one';
  const index = await loadIndex(host);
  if (!index) {
    return c.json({
      error: 'Coverage index temporarily unavailable — please try again.',
      providers: [],
    }, 503);
  }

  // Look up providers for each polygon cell
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
  console.info(`[area-providers] ${r3cells.size} cells → ${providers.length} providers, ${durationMs}ms`);

  return c.json({ providers, polygonCells: r3cells.size, meta: { durationMs } });
});

export default router;
