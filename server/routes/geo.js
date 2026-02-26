import { Router } from 'express';
import { getAllCounties } from '../services/counties.js';

const router = Router();

/**
 * GET /api/geo/counties
 * Returns the full US county GeoJSON (cached in memory after first load).
 * Used by the frontend for reference/lookup.
 */
router.get('/counties', async (req, res) => {
  try {
    const geojson = await getAllCounties();
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24hr browser cache
    res.json(geojson);
  } catch (err) {
    console.error('[geo/counties]', err.message);
    res.status(502).json({ error: 'Failed to load county boundaries', detail: err.message });
  }
});

export default router;
