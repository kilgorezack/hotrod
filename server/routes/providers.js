import { Hono } from 'hono';
import { searchFirebaseProviders, getFirebaseProviderTechs } from '../services/firebaseService.js';

const router = new Hono();

// ─── Local CSV helpers (Node.js only) ────────────────────────────────────────

async function localSearch(query, limit) {
  const { searchLocalProviders } = await import('../services/localCsv.js');
  return searchLocalProviders(query, limit);
}

async function localTechs(providerId) {
  const { getLocalProviderTechs } = await import('../services/localCsv.js');
  return getLocalProviderTechs(providerId);
}

// ─── FCC API fallback ─────────────────────────────────────────────────────────

async function fccSearch(query, limit) {
  const { searchProviders } = await import('../services/fcc.js');
  return searchProviders(query, limit);
}

async function fccTechs(providerId, providerName) {
  const { searchProviders, getProviderTechnologies } = await import('../services/fcc.js');

  // BDC tile probe
  const PROCESS_UUID = 'ae8c39d5-170d-4178-8147-5ac7dcaca06a';
  const FCC_TILE_BASE = 'https://broadbandmap.fcc.gov/nbm/map/api/fixed/provider/hex/tile';
  const PROBE_TILES = [[5,4,11],[5,5,12],[5,6,12],[5,7,11],[5,7,12],[5,8,11],[5,9,11],[5,9,12]];
  const PROBE_TECHS = ['10','40','50','60','70'];
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/x-protobuf,*/*',
    'Referer': 'https://broadbandmap.fcc.gov/',
    'Origin': 'https://broadbandmap.fcc.gov',
  };

  async function probe(id) {
    const results = await Promise.all(PROBE_TECHS.map(async (tech) => {
      const hits = await Promise.all(PROBE_TILES.map(async ([z, x, y]) => {
        try {
          const res = await fetch(
            `${FCC_TILE_BASE}/${PROCESS_UUID}/${id}/${tech}/r/0/0/${z}/${x}/${y}`,
            { headers: HEADERS, signal: AbortSignal.timeout(2500) }
          );
          if (!res.ok) return false;
          return (await res.arrayBuffer()).byteLength > 0;
        } catch { return false; }
      }));
      return hits.some(Boolean) ? tech : null;
    }));
    return results.filter(Boolean).sort((a, b) => Number(a) - Number(b));
  }

  const techs = await probe(providerId);
  if (techs.length) return { technologies: techs, source: 'bdc', providerId };

  const rows = await getProviderTechnologies(providerId);
  const technologies = [...new Set(rows.map(r => r.techcode).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));
  return { technologies, source: 'form477', providerId };
}

// ─── Exported resolvers (used by flat aliases in worker.js) ──────────────────

export async function resolveProviderSearch(query, limit = 20) {
  // 1. Firebase Storage (all states)
  try {
    const results = await searchFirebaseProviders(query, limit);
    if (results?.length > 0) {
      console.info(`[providers] firebase search "${query}" → ${results.length} results`);
      return results;
    }
  } catch (err) {
    console.warn('[providers] firebase search failed:', err.message);
  }

  // 2. Local JSON files (committed states)
  try {
    const results = await localSearch(query, limit);
    if (results.length > 0) {
      console.info(`[providers] local search "${query}" → ${results.length} results`);
      return results;
    }
  } catch (err) {
    console.warn('[providers] local search unavailable:', err.message);
  }

  // 3. FCC API fallback
  return fccSearch(query, limit);
}

export async function resolveProviderTechnologies(providerId, providerName = '') {
  // 1. Firebase Storage
  try {
    const techs = await getFirebaseProviderTechs(providerId);
    if (techs?.length > 0) {
      console.info(`[providers] firebase techs ${providerId} → ${techs}`);
      return { technologies: techs, source: 'firebase', providerId };
    }
  } catch (err) {
    console.warn('[providers] firebase tech lookup failed:', err.message);
  }

  // 2. Local JSON files
  try {
    const techs = await localTechs(providerId);
    if (techs.length > 0) {
      console.info(`[providers] local techs ${providerId} → ${techs}`);
      return { technologies: techs, source: 'local', providerId };
    }
  } catch (err) {
    console.warn('[providers] local tech lookup unavailable:', err.message);
  }

  // 3. FCC API fallback
  return fccTechs(providerId, providerName);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q || q.length < 2) return c.json({ providers: [] });
  const limit = Math.min(parseInt(c.req.query('limit')) || 20, 50);
  try {
    const providers = await resolveProviderSearch(q, limit);
    return c.json({ providers });
  } catch (err) {
    console.error('[providers/search]', err.message);
    return c.json({ error: 'Provider search failed', detail: err.message }, 502);
  }
});

router.get('/:id/technologies', async (c) => {
  const id = c.req.param('id');
  const providerName = String(c.req.query('provider_name') || '');
  if (!id) return c.json({ error: 'Provider ID required' }, 400);
  try {
    const data = await resolveProviderTechnologies(id, providerName);
    return c.json(data);
  } catch (err) {
    console.error('[providers/:id/technologies]', err.message);
    return c.json({ error: 'Provider tech lookup failed', detail: err.message }, 502);
  }
});

export default router;
