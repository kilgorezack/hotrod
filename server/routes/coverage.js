import { Router } from 'express';
import { getProviderCountyCoverage } from '../services/fcc.js';
import { buildCoverageGeoJSON } from '../services/counties.js';

const router = Router();

/**
 * GET /api/coverage?provider_id=130077&tech_code=50
 *
 * Returns a GeoJSON FeatureCollection of county polygons
 * where the given provider offers service with the given tech.
 */
router.get('/', async (req, res) => {
  const { provider_id, tech_code } = req.query;

  if (!provider_id || !tech_code) {
    return res.status(400).json({ error: 'provider_id and tech_code are required' });
  }

  try {
    // Step 1: Get county FIPS list from FCC data
    const coverageRows = await getProviderCountyCoverage(provider_id, tech_code);

    if (!coverageRows.length) {
      return res.json({
        type: 'FeatureCollection',
        features: [],
        meta: { countyCount: 0 },
      });
    }

    // Step 2: Build GeoJSON from county boundaries
    const geojson = await buildCoverageGeoJSON(coverageRows);

    res.json({
      ...geojson,
      meta: {
        countyCount: geojson.features.length,
        dataDate: 'June 2020',
      },
    });
  } catch (err) {
    console.error('[coverage]', err.message);
    res.status(502).json({ error: 'Failed to load coverage data', detail: err.message });
  }
});

export default router;
