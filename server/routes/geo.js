import { Hono } from 'hono';
import { getAllCounties } from '../services/counties.js';

const router = new Hono();

/**
 * GET /api/geo/counties
 * Returns the full US county GeoJSON (cached in memory after first load).
 */
router.get('/counties', async (c) => {
  try {
    const geojson = await getAllCounties();
    c.header('Cache-Control', 'public, max-age=86400');
    return c.json(geojson);
  } catch (err) {
    console.error('[geo/counties]', err.message);
    return c.json({ error: 'Failed to load county boundaries', detail: err.message }, 502);
  }
});

export default router;
