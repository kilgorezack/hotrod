/**
 * FCC BDC Tile Proxy
 */
import { Hono } from 'hono';

const router = new Hono();

const PROCESS_UUID = 'ae8c39d5-170d-4178-8147-5ac7dcaca06a';
const FCC_TILE_BASE = 'https://broadbandmap.fcc.gov/nbm/map/api/fixed/provider/hex/tile';

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

const _logged = new Set();

router.get('/fcc/:providerId/:techCode/:z/:x/:y', async (c) => {
  const providerId = c.req.param('providerId');
  const techCode   = c.req.param('techCode');
  const z = c.req.param('z');
  const x = c.req.param('x');
  const y = c.req.param('y');

  const url = `${FCC_TILE_BASE}/${PROCESS_UUID}/${providerId}/${techCode}/r/0/0/${z}/${x}/${y}`;

  try {
    const tileRes = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });

    const buffer = await tileRes.arrayBuffer();
    const bytes  = buffer.byteLength;

    const logKey = `${providerId}:${techCode}`;
    if (!_logged.has(logKey)) {
      _logged.add(logKey);
      console.info(`[fcc-tile-proxy] sample ${logKey} z${z}/${x}/${y} → HTTP ${tileRes.status}, ${bytes} bytes`);
    }

    if (!tileRes.ok) {
      return c.body(null, tileRes.status);
    }

    return c.body(buffer, 200, {
      'Content-Type':  'application/x-protobuf',
      'Cache-Control': 'public, max-age=86400',
    });
  } catch (err) {
    console.error('[fcc-tile-proxy] fetch error:', err.message);
    return c.body(null, 502);
  }
});

export default router;
