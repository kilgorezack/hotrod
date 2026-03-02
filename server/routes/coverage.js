import { Hono } from 'hono';
import { getProviderStateCoverage } from '../services/fcc.js';
import { buildCoverageGeoJSON } from '../services/counties.js';

const router = new Hono();

/**
 * GET /api/coverage?provider_id=72917&tech_code=50
 *
 * Returns a GeoJSON FeatureCollection of state polygons
 * where the given provider offers service with the given tech.
 */
router.get('/', async (c) => {
  const provider_id = c.req.query('provider_id');
  const tech_code   = c.req.query('tech_code');

  if (!provider_id || !tech_code) {
    return c.json({ error: 'provider_id and tech_code are required' }, 400);
  }

  try {
    const coverageRows = await getProviderStateCoverage(provider_id, tech_code);

    if (!coverageRows.length) {
      return c.json({
        type: 'FeatureCollection',
        features: [],
        meta: { stateCount: 0 },
      });
    }

    const geojson = await buildCoverageGeoJSON(coverageRows);

    return c.json({
      ...geojson,
      meta: {
        stateCount: geojson.features.length,
        dataDate: 'June 2020',
      },
    });
  } catch (err) {
    console.error('[coverage]', err.message);
    return c.json({ error: 'Failed to load coverage data', detail: err.message }, 502);
  }
});

export default router;
