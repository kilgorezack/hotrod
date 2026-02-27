/**
 * hexCoverage.js
 *
 * Fetches FCC BDC provider hex coverage via our Express backend proxy.
 *
 * The backend (server/routes/tiles.js) proxies requests to:
 *   https://broadbandmap.fcc.gov/nbm/map/api/fixed/provider/hex/tile/...
 *
 * Using a proxy is necessary because the FCC tile server does not set
 * CORS headers (tiles are only served same-origin to broadbandmap.fcc.gov),
 * so direct browser fetches are blocked.  Node.js's built-in fetch CAN reach
 * the endpoint with browser-like headers, which the proxy provides.
 *
 * Tile format : Mapbox Vector Tiles (PBF)
 * Layer name  : "fixedproviderhex"
 * Zoom 6      : H3 resolution 5 hexagons (~252 km² avg, ~56 US tiles)
 */

/** Proxy route base path — routed through our Express backend */
const PROXY_BASE = '/api/tiles/fcc';

/**
 * Zoom level used for tile fetching.
 * zoom 6 → H3 res5, ~56 tiles for continental US + AK + HI (~1-3 s total).
 * Raise to 8 for res6 hexagons (~210 tiles, ~3-8 s).
 */
const ZOOM = 6;

/** In-memory cache keyed by "providerId:techCode" */
const _cache = new Map();

/**
 * Fetch and decode all FCC BDC hexagon coverage for a provider+tech.
 *
 * @param {string|number} providerId  FCC provider_id
 * @param {string|number} techCode    FCC technology code (e.g. 50 = Fiber)
 * @returns {Promise<GeoJSON.FeatureCollection|null>}
 */
export async function fetchHexCoverage(providerId, techCode) {
  const key = `${providerId}:${techCode}`;
  if (_cache.has(key)) return _cache.get(key);

  const tiles = getUsTiles(ZOOM);
  console.info(`[hexCoverage] Fetching ${tiles.length} tiles for provider ${providerId} tech ${techCode}…`);

  const settled = await Promise.allSettled(
    tiles.map(({ x, y }) => fetchAndDecode(providerId, techCode, ZOOM, x, y))
  );

  // Diagnostic counters — visible in browser console
  let tilesWithData = 0, tilesEmpty = 0, tilesErrored = 0;

  const features = [];
  const seen = new Set();

  for (const r of settled) {
    if (r.status === 'rejected') { tilesErrored++; continue; }
    if (!r.value?.length)        { tilesEmpty++;    continue; }
    tilesWithData++;
    for (const f of r.value) {
      // Deduplicate hexagons that appear at tile boundaries.
      // Prefer h3index (always present in FCC BDC tiles); fall back to
      // first-vertex coordinate for any non-standard tile data.
      const h3 = f.properties?.h3index;
      const coord = !h3 && f.geometry?.coordinates?.[0]?.[0];
      const dk = h3 ?? (coord ? `${coord[0].toFixed(4)},${coord[1].toFixed(4)}` : null);
      if (!dk || seen.has(dk)) continue;
      seen.add(dk);
      features.push(f);
    }
  }

  console.info(
    `[hexCoverage] ${providerId}:${techCode} — ` +
    `${tilesWithData} tiles had data, ${tilesEmpty} empty, ${tilesErrored} errored → ` +
    `${features.length} unique hex features`
  );

  const result = features.length > 0
    ? { type: 'FeatureCollection', features }
    : null;

  _cache.set(key, result);
  return result;
}

// ─── Tile Fetching ───────────────────────────────────────────────────────────

async function fetchAndDecode(providerId, techCode, z, x, y) {
  const url = `${PROXY_BASE}/${providerId}/${techCode}/${z}/${x}/${y}`;

  let buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    buffer = await res.arrayBuffer();
  } catch (err) {
    console.warn('[hexCoverage] tile fetch error:', err.message);
    return [];
  }

  if (!buffer || buffer.byteLength === 0) return [];
  return decodePbf(buffer, z, x, y);
}

// ─── PBF Decoding ────────────────────────────────────────────────────────────

async function decodePbf(buffer, z, x, y) {
  const [{ VectorTile }, { default: Pbf }] = await Promise.all([
    import('@mapbox/vector-tile'),
    import('pbf'),
  ]);

  try {
    const tile  = new VectorTile(new Pbf(buffer));
    const layer = tile.layers['fixedproviderhex'];
    if (!layer) return [];

    const features = [];
    for (let i = 0; i < layer.length; i++) {
      try {
        // toGeoJSON(x, y, z) converts tile-space coords → WGS-84 lat/lon
        features.push(layer.feature(i).toGeoJSON(x, y, z));
      } catch {
        // skip malformed features
      }
    }
    return features;
  } catch {
    return [];
  }
}

// ─── Tile Grid ───────────────────────────────────────────────────────────────

/** Returns all Web Mercator {x, y} tile pairs covering the US at zoom `z`. */
function getUsTiles(z) {
  const n = Math.pow(2, z);

  function lonToX(lon) {
    return Math.floor(((lon + 180) / 360) * n);
  }
  function latToY(lat) {
    const r = lat * (Math.PI / 180);
    return Math.floor(
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
    );
  }

  // Wide bounds — covers CONUS + Alaska + Hawaii
  const minX = Math.max(0, lonToX(-180));
  const maxX = Math.min(n - 1, lonToX(-60));
  const minY = Math.max(0, latToY(72));    // top of Alaska
  const maxY = Math.min(n - 1, latToY(17)); // bottom of Hawaii

  const tiles = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}
