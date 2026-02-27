/**
 * FCC BDC Tile Proxy
 *
 * Routes tile requests through the Express backend so the browser
 * avoids cross-origin restrictions on broadbandmap.fcc.gov.
 *
 * Node.js's built-in fetch handles HTTP/2 correctly (unlike curl),
 * and browser-like headers satisfy the FCC server's checks.
 */
import express from 'express';

const router = express.Router();

// BDC filing period UUID — update when FCC publishes new data (~every 6 months)
// Latest available: Jun 2025  → GET https://broadbandmap.fcc.gov/nbm/map/api/published/filing
const PROCESS_UUID = 'ae8c39d5-170d-4178-8147-5ac7dcaca06a';
const FCC_TILE_BASE = 'https://broadbandmap.fcc.gov/nbm/map/api/fixed/provider/hex/tile';

// Mimic a browser to satisfy the FCC server's HTTP fingerprint check
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'application/x-protobuf,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://broadbandmap.fcc.gov/',
  'Origin':          'https://broadbandmap.fcc.gov',
  'sec-fetch-dest':  'empty',
  'sec-fetch-mode':  'cors',
  'sec-fetch-site':  'same-origin',
};

/**
 * GET /api/tiles/fcc/:providerId/:techCode/:z/:x/:y
 *
 * Proxies one FCC BDC vector tile (PBF format) to the browser.
 * Cached for 24 hours.
 */
// Log one sample response per provider+tech combo to aid debugging
const _logged = new Set();

router.get('/fcc/:providerId/:techCode/:z/:x/:y', async (req, res) => {
  const { providerId, techCode, z, x, y } = req.params;
  const url = `${FCC_TILE_BASE}/${PROCESS_UUID}/${providerId}/${techCode}/r/0/0/${z}/${x}/${y}`;

  try {
    const tileRes = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });

    const buffer = await tileRes.arrayBuffer();
    const bytes  = buffer.byteLength;

    // One-time diagnostic log per provider+tech so Vercel logs stay readable
    const logKey = `${providerId}:${techCode}`;
    if (!_logged.has(logKey)) {
      _logged.add(logKey);
      console.info(`[fcc-tile-proxy] sample ${logKey} z${z}/${x}/${y} → HTTP ${tileRes.status}, ${bytes} bytes`);
    }

    if (!tileRes.ok) {
      return res.status(tileRes.status).end();
    }

    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24-hour browser cache
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[fcc-tile-proxy] fetch error:', err.message);
    res.status(502).end();
  }
});

export default router;
