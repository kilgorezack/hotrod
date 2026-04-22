/**
 * POST /api/area-providers
 *
 * Given a drawn polygon, returns all broadband providers with confirmed
 * H3-cell coverage in that area.
 *
 * Pipeline:
 *   1. Convert polygon vertices → H3 res-5 cells (our index resolution)
 *   2. Reverse-geocode centroid via Nominatim → US state abbreviation
 *   3. Query FCC Form 477 (Socrata) for provider IDs in that state
 *   4. Intersect with Firebase providers.json → narrow to ~20–80 candidates
 *   5. For each candidate, fetch Firebase hex data + test res-5 overlap
 *   6. Return providers with confirmed coverage, sorted alphabetically
 */

import { Hono } from 'hono';
import { polygonToCells, latLngToCell, cellToParent, getResolution } from 'h3-js';

const router = new Hono();

// ─── Constants ────────────────────────────────────────────────────────────────

const SOCRATA_BASE      = 'https://opendata.fcc.gov/resource';
const FORM477_DATASET   = '4kuc-phrr';
const NOMINATIM_BASE    = 'https://nominatim.openstreetmap.org/reverse';
const OVERLAP_RESOLUTION = 5; // res-5 ≈ 252 km² per cell

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

// ─── Firebase helpers ─────────────────────────────────────────────────────────

function storageBucket() {
  return (process.env.FIREBASE_STORAGE_BUCKET || '').replace(/\/$/, '');
}

function storageUrl(path) {
  return `https://firebasestorage.googleapis.com/v0/b/${storageBucket()}/o/${encodeURIComponent(path)}?alt=media`;
}

let _fbProvidersCache = null;
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
    _fbProvidersCache = map;
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

// ─── Geocoding ────────────────────────────────────────────────────────────────

async function reverseGeocodeState(lat, lng) {
  const url = `${NOMINATIM_BASE}?format=json&lat=${lat}&lon=${lng}&addressdetails=1&zoom=5`;
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

// ─── FCC Form 477 provider list ────────────────────────────────────────────────

async function getForm477ProvidersForState(stateAbbr) {
  const url = new URL(`${SOCRATA_BASE}/${FORM477_DATASET}.json`);
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

  // Group rows by provider_id, mapping Form 477 sub-codes → BDC codes
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

// ─── H3 overlap check ─────────────────────────────────────────────────────────

function computePolygonCells(vertices) {
  const coords = vertices.map(v => [v.latitude, v.longitude]);
  // Ensure ring is closed
  const first = coords[0], last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push(coords[0]);

  let cells;
  try {
    cells = polygonToCells(coords, OVERLAP_RESOLUTION);
  } catch {
    cells = [];
  }

  // Fallback: small polygon smaller than one res-5 cell → use centroid
  if (cells.length === 0) {
    const lat = vertices.reduce((s, v) => s + v.latitude,  0) / vertices.length;
    const lng = vertices.reduce((s, v) => s + v.longitude, 0) / vertices.length;
    cells = [latLngToCell(lat, lng, OVERLAP_RESOLUTION)];
  }

  return new Set(cells);
}

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

  // 1. Convert polygon to H3 res-5 cells
  let polygonCells;
  try {
    polygonCells = computePolygonCells(polygon);
  } catch (err) {
    return c.json({ error: `H3 conversion failed: ${err.message}` }, 400);
  }

  // 2. Determine state via reverse geocoding
  const cLat = polygon.reduce((s, v) => s + v.latitude,  0) / polygon.length;
  const cLng = polygon.reduce((s, v) => s + v.longitude, 0) / polygon.length;

  let stateAbbr;
  try {
    stateAbbr = await reverseGeocodeState(cLat, cLng);
  } catch (err) {
    console.warn('[area-providers] geocode failed:', err.message);
    return c.json({ error: `Could not determine location: ${err.message}` }, 422);
  }

  // 3 + 4. Get state providers from Form 477, intersect with Firebase index
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

  const candidates = form477Providers.filter(p => fbIndex.has(String(p.id)));

  console.info(
    `[area-providers] ${stateAbbr}: ${form477Providers.length} Form 477 → ` +
    `${candidates.length} in Firebase, ${polygonCells.size} polygon cells`
  );

  // 5. Fetch each candidate's hex data and test overlap — all in parallel
  const tasks = candidates.flatMap(p =>
    p.techs.map(tech => ({ id: p.id, name: p.name, tech }))
  );

  const settled = await Promise.allSettled(
    tasks.map(async ({ id, name, tech }) => {
      const h3arr = await fetchFirebaseHexArr(id, tech);
      if (!h3arr || !hexArrOverlaps(h3arr, polygonCells)) return null;
      return { providerId: id, providerName: name, techCode: tech };
    })
  );

  // 6. Aggregate by provider
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

  console.info(
    `[area-providers] done — ${providers.length} providers with coverage, ` +
    `${Date.now() - start}ms`
  );

  return c.json({
    providers,
    state: stateAbbr,
    polygonCells: polygonCells.size,
    meta: { durationMs: Date.now() - start },
  });
});

export default router;
