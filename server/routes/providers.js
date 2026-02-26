import { Router } from 'express';
import { searchProviders, getProviderTechnologies } from '../services/fcc.js';

const router = Router();

/**
 * GET /api/providers/search?q=comcast&limit=20
 * Search FCC provider names.
 */
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) {
    return res.json({ providers: [] });
  }

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  try {
    const rows = await searchProviders(q, limit);
    const providers = rows.map((r) => ({
      id: r.provider_id,
      name: r.providername,
    }));
    res.json({ providers });
  } catch (err) {
    console.error('[providers/search]', err.message);
    res.status(502).json({ error: 'Failed to reach FCC data source', detail: err.message });
  }
});

/**
 * GET /api/providers/:id/technologies
 * List technology codes available for a given provider.
 */
router.get('/:id/technologies', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Provider ID required' });

  try {
    const rows = await getProviderTechnologies(id);
    const technologies = rows
      .map((r) => r.techcode)
      .filter(Boolean)
      .sort((a, b) => Number(a) - Number(b));
    res.json({ technologies });
  } catch (err) {
    console.error('[providers/:id/technologies]', err.message);
    res.status(502).json({ error: 'Failed to reach FCC data source', detail: err.message });
  }
});

export default router;
