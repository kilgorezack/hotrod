import { Router } from 'express';
import { getProviderStateCoverage } from '../services/fcc.js';
import { buildCoverageGeoJSON } from '../services/counties.js';

const router = Router();

/**
 * GET /api/coverage?provider_id=72917&tech_code=50
 *
 * Returns a GeoJSON FeatureCollection of state polygons
 * where the given provider offers service with the given tech.
 */
router.get('/', async (req, res) => {
  const { provider_id, tech_code } = req.query;

  if (!provider_id || !tech_code) {
    return res.status(400).json({ error: 'provider_id and tech_code are required' });
  }

  try {
    const coverageRows = await getProviderStateCoverage(provider_id, tech_code);

    if (!coverageRows.length) {
      return res.json({
        type: 'FeatureCollection',
        features: [],
        meta: { stateCount: 0 },
      });
    }

    const geojson = await buildCoverageGeoJSON(coverageRows);

    res.json({
      ...geojson,
      meta: {
        stateCount: geojson.features.length,
        dataDate: 'June 2020',
      },
    });
  } catch (err) {
    console.error('[coverage]', err.message);
    res.status(502).json({ error: 'Failed to load coverage data', detail: err.message });
  }
});

export default router;
