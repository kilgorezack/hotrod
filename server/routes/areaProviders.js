/**
 * POST /api/area-providers
 *
 * Given a drawn polygon, returns all broadband providers with confirmed
 * H3-cell coverage in that area.
 *
 * Fast pipeline (uses pre-built local index):
 *   1. Convert polygon → res-3 cells → look up candidates from coverage_index_r3.json
 *   2. Convert polygon → res-5 cells (fine overlap resolution)
 *   3. For each candidate (provider × tech), fetch Firebase hex + confirm res-5 overlap
 *   4. Return confirmed providers sorted alphabetically
 *
 * Slow fallback (when index not available — first deploy before index is built):
 *   Same as above but candidates come from FCC Form 477 / Socrata + Nominatim geocode.
 *
 * Regenerate the index after each FCC BDC data refresh:
 *   FIREBASE_STORAGE_BUCKET=... node scripts/buildCoverageIndex.js
 */

import { Hono } from 'hono';
import { polygonToCells, latLngToCell, cellToParent, getResolution } from 'h3-js';

const router = new Hono();

// ─── Constants ────────────────────────────────────────────────────────────────

const INDEX_RES          = 3; // resolution of coverage_index_r3.json
const OVERLAP_RESOLUTION = 5; // fine resolution for exact overlap check (~252 km²)

// Form 477 sub-codes → BDC codes (used only in Socrata fallback)
const FORM477_TO_BDC = {
  '11': '10', '12': '10', '20': '10', '30': '10',
  '41': '40', '43': '40',
};

const STATE_NAMES = {
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR',
  'California':'CA','Colorado':'CO','Connecticut':'CT','Delaware':'DE',
  'Florida':'FL','Georgia':'GA','Hawaii':'HI','Idaho':'ID',
  'Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS',
  'Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD',
  'Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS',
  'Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV',
  'New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY',
  'North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK',
  'Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC',
  'South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT',
  'Vermont':'VT','Virginia':'VA','Washington':'WA','West Virginia':'WV',
  'Wisconsin':'WI','Wyoming':'WY','District of Columbia':'DC',
};

// ─── Coverage index (fast path) ───────────────────────────────────────────────

let _coverageIndex     = null;
let _coverageIndexDone = false;

async function getCoverageIndex() {
  if (_coverageIndexDone) return _coverageIndex;
  _coverageIndexDone = true;
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath }            = await import('node:url');
    const pathMod                      = await import('node:path');
    const HERE      = pathMod.default.dirname(fileURLToPath(import.meta.url));
    const indexPath = pathMod.default.join(HERE, '..', 'data', 'coverage_index_r3.json');
    if (existsSync(indexPath)) {
      _coverageIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
      console.info('[area-providers] coverage index loaded');
    } else {
      console.warn('[area-providers] coverage_index_r3.json not found — will use Socrata fallback');
    }
  } catch (err) {
    console.warn('[area-providers] could not load coverage index:', err.message);
  }
  return _coverageIndex;
}

// Eager load on module init so it's ready by the first request
getCoverageIndex().catch(() => {});

// ─── Firebase helpers ─────────────────────────────────────────────────────────

function storageBucket() {
  return (process.env.FIREBASE_STORAGE_BUCKET || '').replace(/\/$/, '');
}

function storageUrl(p) {
  return `https://firebasestorage.googleapis.com/v0/b/${storageBucket()}/o/${encodeURIComponent(p)}?alt=media`;
}

let _fbProvidersCache   = null;
let _fbProvidersCacheAt = 0;

async function getFirebaseProviderIndex() {
  if (_fbProvidersCache && Date.now() - _fbProvidersCacheAt < 3_600_000) {
    return _fbProvidersCache;
  }
  if (!storageBucket()) return new Map();
  try {
    const res = await fetch(storageUrl('providers.json'), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return new Map();
    const list = await res.json();
    const map = new Map(list.map(p => [String(p.id), p]));
    _fbProvidersCache   = map;
    _fbProvidersCacheAt = Date.now();
    return map;
  } catch {
    return _fbProvidersCache ?? new Map();
  }
}

async function fetchFirebaseHexArr(providerId, techCode) {
  if (!storageBucket()) return null;
  try {
    const res = await fetch(storageUrl(`hexes/${providerId}_${techCode}.json`), {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// ─── Geocoding (Socrata fallback only) ────────────────────────────────────────

async function reverseGeocodeState(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1&zoom=5`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HOTROD/1.0 broadband-map (https://github.com/kilgorezack/hotrod)' },
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  const stateName = data.address?.state;
  if (!stateName) throw new Error('No state in geocoder response');
  const abbr = STATE_NAMES[stateName];
  if (!abbr) throw new Error(`Unrecognised state name: "${stateName}"`);
  return abbr;
}

// ─── FCC Form 477 (Socrata fallback only) ─────────────────────────────────────

async function getForm477ProvidersForState(stateAbbr) {
  const url = new URL('https://opendata.fcc.gov/resource/4kuc-phrr.json');
  url.searchParams.set('$select', 'provider_id,providername,techcode');
  url.searchParams.set('$where',  `stateabbr = '${stateAbbr}'`);
  url.searchParams.set('$group',  'provider_id,providername,techcode');
  url.searchParams.set('$limit',  '2000');

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Socrata HTTP ${res.status}`);
  const rows = await res.json();

  const map = new Map();
  for (const row of rows) {
    const id = row.provider_id;
    if (!id) continue;
    const bdc = FORM477_TO_BDC[row.techcode] ?? row.techcode;
    if (!map.has(id)) map.set(id, { id, name: row.providername || '', techs: new Set() });
    if (bdc) map.get(id).techs.add(bdc);
  }
  return [...map.values()].map(p => ({ id: p.id, name: p.name, techs: [...p.techs] }));
}

// ─── H3 helpers ───────────────────────────────────────────────────────────────

/** Returns a Set of H3 cells at `resolution` that cover the polygon. */
function computePolygonCellsAtRes(vertices, resolution) {
  const coords = vertices.map(v => [v.latitude, v.longitude]);
  if (coords[0][0] !== coords.at(-1)[0] || coords[0][1] !== coords.at(-1)[1]) {
    coords.push(coords[0]);
  }

  let cells;
  try {
    cells = polygonToCells(coords, resolution);
  } catch {
    cells = [];
  }

  // Fallback: polygon too small for the resolution → use centroid cell
  if (cells.length === 0) {
    const lat = vertices.reduce((s, v) => s + v.latitude,  0) / vertices.length;
    const lng = vertices.reduce((s, v) => s + v.longitude, 0) / vertices.length;
    cells = [latLngToCell(lat, lng, resolution)];
  }

  return new Set(cells);
}

/** Returns true if any h3 in h3arr coarsens to one of the polygonCells (res-5). */
function hexArrOverlaps(h3arr, polygonCells) {
  for (const h of h3arr) {
    if (!h) continue;
    try {
      const cell = getResolution(h) <= OVERLAP_RESOLUTION
        ? h
        : cellToParent(h, OVERLAP_RESOLUTION);
      if (polygonCells.has(cell)) return true;
    } catch { /* skip malformed */ }
  }
  return false;
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

  // Compute polygon cells at both resolutions up front
  let r3cells, r5cells;
  try {
    r3cells = computePolygonCellsAtRes(polygon, INDEX_RES);
    r5cells = computePolygonCellsAtRes(polygon, OVERLAP_RESOLUTION);
  } catch (err) {
    return c.json({ error: `H3 conversion failed: ${err.message}` }, 400);
  }

  // ── Fast path: local coverage index ──────────────────────────────────────
  const index = await getCoverageIndex();
  let candidates;
  let usedIndex = false;

  if (index) {
    usedIndex = true;
    const candidateMap = new Map();
    for (const cell of r3cells) {
      for (const { id, name, techs } of (index[cell] ?? [])) {
        if (!candidateMap.has(id)) {
          candidateMap.set(id, { id, name, techs: new Set(techs) });
        } else {
          for (const t of techs) candidateMap.get(id).techs.add(t);
        }
      }
    }
    candidates = [...candidateMap.values()]
      .map(p => ({ id: p.id, name: p.name, techs: [...p.techs] }));

    console.info(
      `[area-providers] index lookup: ${r3cells.size} res-3 cells → ` +
      `${candidates.length} candidates`
    );
  } else {
    // ── Slow fallback: Nominatim + Socrata Form 477 ───────────────────────
    const cLat = polygon.reduce((s, v) => s + v.latitude,  0) / polygon.length;
    const cLng = polygon.reduce((s, v) => s + v.longitude, 0) / polygon.length;

    let stateAbbr;
    try {
      stateAbbr = await reverseGeocodeState(cLat, cLng);
    } catch (err) {
      console.warn('[area-providers] geocode failed:', err.message);
      return c.json({ error: `Could not determine location: ${err.message}` }, 422);
    }

    const [form477Providers, fbIndex] = await Promise.all([
      getForm477ProvidersForState(stateAbbr).catch(err => {
        console.error('[area-providers] Socrata error:', err.message);
        return null;
      }),
      getFirebaseProviderIndex(),
    ]);

    if (!form477Providers) {
      return c.json({ error: 'Failed to load provider list from FCC' }, 502);
    }

    candidates = form477Providers.filter(p => fbIndex.has(String(p.id)));
    console.info(
      `[area-providers] Socrata fallback (${stateAbbr}): ` +
      `${form477Providers.length} → ${candidates.length} candidates`
    );
  }

  // ── Exact overlap check: fetch each candidate's hex data ─────────────────
  const tasks = candidates.flatMap(p =>
    p.techs.map(tech => ({ id: p.id, name: p.name, tech }))
  );

  const settled = await Promise.allSettled(
    tasks.map(async ({ id, name, tech }) => {
      const h3arr = await fetchFirebaseHexArr(id, tech);
      if (!h3arr || !hexArrOverlaps(h3arr, r5cells)) return null;
      return { providerId: id, providerName: name, techCode: tech };
    })
  );

  // Aggregate by provider
  const providerMap = new Map();
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const { providerId, providerName, techCode } = r.value;
    if (!providerMap.has(providerId)) {
      providerMap.set(providerId, { providerId, providerName, techCodes: [] });
    }
    providerMap.get(providerId).techCodes.push(techCode);
  }

  const providers = [...providerMap.values()]
    .map(p => ({ ...p, techCodes: p.techCodes.sort((a, b) => Number(a) - Number(b)) }))
    .sort((a, b) => a.providerName.localeCompare(b.providerName));

  const durationMs = Date.now() - start;
  console.info(
    `[area-providers] done — ${providers.length} providers with coverage, ` +
    `${tasks.length} tasks, ${durationMs}ms (${usedIndex ? 'index' : 'socrata'})`
  );

  return c.json({
    providers,
    polygonCells: r5cells.size,
    meta: { durationMs, source: usedIndex ? 'index' : 'socrata' },
  });
});

export default router;
