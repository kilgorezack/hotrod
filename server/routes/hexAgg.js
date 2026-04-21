/**
 * Server-side FCC BDC hex tile aggregation.
 *
 * GET /api/coverage/hex/:providerId/:techCode
 *
 * Fetches all US tiles from FCC in parallel, decodes PBF on the server,
 * deduplicates by h3index, and returns a single GeoJSON FeatureCollection.
 */
import { Hono } from 'hono';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { getFirebaseHexCoverage } from '../services/firebaseService.js';

const router = new Hono();

const PROCESS_UUID = 'ae8c39d5-170d-4178-8147-5ac7dcaca06a'; // Jun 2025
const FCC_TILE_BASE = 'https://broadbandmap.fcc.gov/nbm/map/api/fixed/provider/hex/tile';

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'application/x-protobuf,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://broadbandmap.fcc.gov/',
  'Origin':          'https://broadbandmap.fcc.gov',
  'sec-fetch-site':  'same-origin',
  'sec-fetch-mode':  'cors',
  'sec-fetch-dest':  'empty',
};

const ZOOM = 6;

const FORM477_TO_BDC = {
  '11': '10', '12': '10', '20': '10', '30': '10',
  '41': '40', '43': '40',
};

const _cache = new Map();

// ─── Tile Grid ────────────────────────────────────────────────────────────────────────────────

function getUsTiles(z) {
  const n = Math.pow(2, z);
  const lonToX = (lon) => Math.floor(((lon + 180) / 360) * n);
  const latToY = (lat) => {
    const r = lat * (Math.PI / 180);
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };

  const minX = Math.max(0, lonToX(-180));
  const maxX = Math.min(n - 1, lonToX(-60));
  const minY = Math.max(0, latToY(72));
  const maxY = Math.min(n - 1, latToY(17));

  const tiles = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

// ─── Single Tile Fetch + Decode ─────────────────────────────────────────────────────────────────

async function fetchTile(providerId, techCode, z, x, y) {
  const url = `${FCC_TILE_BASE}/${PROCESS_UUID}/${providerId}/${techCode}/r/0/0/${z}/${x}/${y}`;
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(2_500),
    });

    if (!res.ok) return { features: [], tag: `http_${res.status}` };

    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) return { features: [], tag: 'empty' };

    try {
      const tile  = new VectorTile(new Pbf(Buffer.from(buf)));
      const layer = tile.layers['fixedproviderhex'];
      if (!layer) return { features: [], tag: 'no_layer' };

      const features = [];
      for (let i = 0; i < layer.length; i++) {
        try { features.push(layer.feature(i).toGeoJSON(x, y, z)); } catch { /* skip */ }
      }
      return { features, tag: 'ok' };
    } catch (e) {
      return { features: [], tag: 'parse_err', err: e.message };
    }
  } catch (e) {
    return { features: [], tag: 'fetch_err', err: e.message };
  }
}

// ─── Route ───────────────────────────────────────────────────────────────────────────────────

router.get('/:providerId/:techCode', async (c) => {
  const { providerId } = c.req.param();
  const techCode = FORM477_TO_BDC[String(c.req.param('techCode'))] ?? String(c.req.param('techCode'));

  if (techCode === '300') {
    return c.json({ type: 'FeatureCollection', features: [] });
  }

  const cacheKey = `${providerId}:${techCode}`;
  const cached = _cache.get(cacheKey);
  if (cached) {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(cached);
  }

  // 1. Local JSON files (committed states — Node.js only)
  try {
    const { getLocalHexCoverage } = await import('../services/localCsv.js');
    const local = await getLocalHexCoverage(providerId, techCode);
    if (local) {
      _cache.set(cacheKey, local);
      setTimeout(() => _cache.delete(cacheKey), 3_600_000);
      c.header('Cache-Control', 'public, max-age=3600');
      return c.json(local);
    }
  } catch { /* not in Node.js — fall through */ }

  const tiles = getUsTiles(ZOOM);
  const start = Date.now();

  const settled = await Promise.allSettled(
    tiles.map(({ x, y }) => fetchTile(providerId, techCode, ZOOM, x, y))
  );

  const seen     = new Set();
  const features = [];
  const tagCounts = {};
  let tilesWithData = 0;
  let firstErrorSample = null;

  for (const r of settled) {
    if (r.status === 'rejected') {
      tagCounts['rejected'] = (tagCounts['rejected'] || 0) + 1;
      continue;
    }
    const { features: tileFeatures, tag, err } = r.value;
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    if (tag !== 'ok' && tag !== 'empty' && !firstErrorSample) {
      firstErrorSample = { tag, err };
    }
    if (!tileFeatures.length) continue;
    tilesWithData++;
    for (const f of tileFeatures) {
      const dk = f.properties?.h3index;
      if (!dk || seen.has(dk)) continue;
      seen.add(dk);
      features.push(f);
    }
  }

  console.info(
    `[hex-agg] ${providerId}:${techCode} — ` +
    `${tilesWithData}/${tiles.length} tiles with data, ${features.length} hex features, ` +
    `${Date.now() - start}ms | tags: ${JSON.stringify(tagCounts)}` +
    (firstErrorSample ? ` | sample error: ${JSON.stringify(firstErrorSample)}` : '')
  );

  const result = { type: 'FeatureCollection', features };

  _cache.set(cacheKey, result);
  setTimeout(() => _cache.delete(cacheKey), 3_600_000);

  // Back-fill Firebase with the complete FCC tile result so the next request
  // is served instantly from Firebase (which now has accurate nationwide data).
  if (features.length > 0) {
    import('../services/firebaseService.js')
      .then(({ saveFirebaseHexCoverage }) => saveFirebaseHexCoverage(providerId, techCode, features))
      .catch(() => {});
  }

  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(result);
});

export default router;
