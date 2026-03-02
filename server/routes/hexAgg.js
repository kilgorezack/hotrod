/**
 * Server-side FCC BDC hex tile aggregation.
 *
 * GET /api/coverage/hex/:providerId/:techCode
 *
 * Fetches all US tiles from FCC in parallel, decodes PBF on the server,
 * deduplicates by h3index, and returns a single GeoJSON FeatureCollection.
 *
 * Why server-side?
 *   Doing this client-side requires 352 individual browser→Vercel→FCC
 *   round-trips, each spinning up a serverless function.  Doing it here
 *   means ONE request from the browser; the server fans out the 352 FCC
 *   fetches concurrently (fast, low-latency within Vercel's network) and
 *   streams back a single JSON response.  PBF decoding also stays out of
 *   the browser bundle.
 */
import express from 'express';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const router = express.Router();

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

// Form 477 sub-codes → BDC parent codes (same mapping as hexCoverage.js)
const FORM477_TO_BDC = {
  '11': '10', '12': '10', '20': '10', '30': '10',
  '41': '40', '43': '40',
};

// 1-hour in-memory cache (survives warm serverless invocations)
const _cache = new Map();

// ─── Tile Grid ────────────────────────────────────────────────────────────────

function getUsTiles(z) {
  const n = Math.pow(2, z);
  const lonToX = (lon) => Math.floor(((lon + 180) / 360) * n);
  const latToY = (lat) => {
    const r = lat * (Math.PI / 180);
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };

  // Full US extent: lon -180→-60 (covers CONUS, Alaska, Hawaii, PR, USVI)
  //                lat 17→72
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

// ─── Single Tile Fetch + Decode ───────────────────────────────────────────────

/**
 * Returns { features: [], tag: 'ok'|'http_NNN'|'empty'|'no_layer'|'parse_err'|'fetch_err' }
 */
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

// ─── Route ───────────────────────────────────────────────────────────────────

router.get('/:providerId/:techCode', async (req, res) => {
  const { providerId } = req.params;
  const techCode = FORM477_TO_BDC[String(req.params.techCode)] ?? String(req.params.techCode);

  // 5G NR has no BDC tile equivalent
  if (techCode === '300') {
    return res.json({ type: 'FeatureCollection', features: [] });
  }

  const cacheKey = `${providerId}:${techCode}`;
  const cached = _cache.get(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(cached);
  }

  const tiles = getUsTiles(ZOOM);
  const start = Date.now();

  // Fan out to FCC in parallel — empty tiles respond in ~50 ms, data tiles ~200-500 ms
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

  // Cache for 1 hour in memory; CDN edge cache will honour the HTTP header
  _cache.set(cacheKey, result);
  setTimeout(() => _cache.delete(cacheKey), 3_600_000);

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(result);
});

export default router;
