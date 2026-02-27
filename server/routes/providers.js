import { Router } from 'express';
import { searchProviders, getProviderTechnologies, searchBdcProviders } from '../services/fcc.js';

const router = Router();

// ─── FCC BDC tile config (for tech probing) ──────────────────────────────────

const PROCESS_UUID = 'ae8c39d5-170d-4178-8147-5ac7dcaca06a';
const FCC_TILE_BASE = 'https://broadbandmap.fcc.gov/nbm/map/api/fixed/provider/hex/tile';
const BROWSER_HEADERS = {
  'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':         'application/x-protobuf,*/*',
  'Referer':        'https://broadbandmap.fcc.gov/',
  'Origin':         'https://broadbandmap.fcc.gov',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

// 8 zoom-5 tiles covering all major US regions (Pacific NW, CA, SW, Plains, Midwest, Great Lakes, NE, SE)
const PROBE_TILES = [
  [5, 4, 11], [5, 5, 12], [5, 6, 12], [5, 7, 11],
  [5, 7, 12], [5, 8, 11], [5, 9, 11], [5, 9, 12],
];

// BDC-valid tech codes accepted by the hex tile endpoint.
// 41, 43 (DOCSIS sub-codes), 300 (5G NR), and DSL variants (11,12,20,30)
// all return HTTP 422 — only the parent codes work.
const PROBE_TECHS = ['10', '40', '50', '60', '70'];

const techProbeCache = new Map();
const bdcNameResolutionCache = new Map();

/**
 * Detect available tech codes for a provider by checking whether
 * FCC BDC tiles have any data (0-byte response = no coverage).
 * Returns sorted array of tech code strings, or null if none found.
 */
async function probeTechs(providerId) {
  const cacheKey = `probe:${providerId}`;
  if (techProbeCache.has(cacheKey)) return techProbeCache.get(cacheKey);

  const results = await Promise.all(
    PROBE_TECHS.map(async (tech) => {
      const hits = await Promise.all(
        PROBE_TILES.map(async ([z, x, y]) => {
          const url = `${FCC_TILE_BASE}/${PROCESS_UUID}/${providerId}/${tech}/r/0/0/${z}/${x}/${y}`;
          try {
            const res = await fetch(url, {
              headers: BROWSER_HEADERS,
              signal: AbortSignal.timeout(6000),
            });
            if (!res.ok) return false;
            const buf = await res.arrayBuffer();
            return buf.byteLength > 0;
          } catch { return false; }
        })
      );
      return hits.some(Boolean) ? tech : null;
    })
  );

  const techs = results.filter(Boolean).sort((a, b) => Number(a) - Number(b));
  if (techs.length > 0) {
    techProbeCache.set(cacheKey, techs);
    setTimeout(() => techProbeCache.delete(cacheKey), 60 * 60 * 1000); // 1-hour TTL
  }
  return techs;
}

function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulTokens(name) {
  const STOP = new Set([
    'inc', 'llc', 'ltd', 'corp', 'co', 'company', 'corporation', 'communications',
    'communication', 'the', 'of', 'and', 'wireless', 'telephone', 'broadband',
    'network', 'networks', 'services', 'service', 'holdings', 'group',
  ]);
  return normalizeName(name)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP.has(token));
}

function scoreNameMatch(form477Name, bdcName) {
  const left = meaningfulTokens(form477Name);
  if (!left.length) return 0;
  const right = new Set(meaningfulTokens(bdcName));
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) hits += 1;
  }
  return hits;
}

async function resolveBdcProviderByName(providerName) {
  const cacheKey = normalizeName(providerName);
  if (bdcNameResolutionCache.has(cacheKey)) {
    return bdcNameResolutionCache.get(cacheKey);
  }

  const tokens = meaningfulTokens(providerName);
  if (!tokens.length) {
    bdcNameResolutionCache.set(cacheKey, null);
    return null;
  }

  const candidateQueries = [];
  candidateQueries.push(tokens.slice(0, 2).join(' '));
  candidateQueries.push(tokens[0]);

  const dedup = [...new Set(candidateQueries.filter(Boolean))];
  for (const query of dedup) {
    try {
      const rows = await searchBdcProviders(query, 25);
      if (!rows.length) continue;

      let best = null;
      let bestScore = 0;
      for (const row of rows) {
        const score = scoreNameMatch(providerName, row.name);
        if (score > bestScore) {
          best = row;
          bestScore = score;
        }
      }

      const minScore = Math.min(2, meaningfulTokens(providerName).length);
      if (best && bestScore >= minScore) {
        bdcNameResolutionCache.set(cacheKey, best);
        return best;
      }
    } catch (err) {
      console.warn('[providers] BDC name resolution failed:', err.message);
    }
  }

  bdcNameResolutionCache.set(cacheKey, null);
  return null;
}

export async function resolveProviderSearch(query, limit = 20) {
  return searchProviders(query, limit);
}

export async function resolveProviderTechnologies(providerId, providerName = '') {
  let resolvedBdc = null;

  try {
    const techs = await probeTechs(providerId);
    if (techs.length > 0) {
      return { technologies: techs, source: 'bdc', providerId };
    }
  } catch (err) {
    console.warn('[providers/:id/technologies] BDC probe failed:', err.message);
  }

  if (providerName) {
    resolvedBdc = await resolveBdcProviderByName(providerName);
    if (resolvedBdc && resolvedBdc.id !== String(providerId)) {
      try {
        const techs = await probeTechs(resolvedBdc.id);
        if (techs.length > 0) {
          return {
            technologies: techs,
            source: 'bdc_resolved',
            providerId: resolvedBdc.id,
            providerName: resolvedBdc.name,
            resolvedFromProviderId: String(providerId),
          };
        }
      } catch (err) {
        console.warn('[providers] Resolved BDC probe failed:', err.message);
      }
    }
  }

  const rows = await getProviderTechnologies(providerId);
  const technologies = rows
    .map((r) => r.techcode)
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));

  if (resolvedBdc && resolvedBdc.id !== String(providerId)) {
    return {
      technologies,
      source: 'bdc_resolved',
      providerId: resolvedBdc.id,
      providerName: resolvedBdc.name,
      resolvedFromProviderId: String(providerId),
    };
  }

  return { technologies, source: 'form477', providerId };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/providers/search?q=comcast&limit=20
 */
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ providers: [] });

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  try {
    const providers = await resolveProviderSearch(q, limit);
    res.json({ providers });
  } catch (err) {
    console.error('[providers/search]', err.message);
    res.status(502).json({ error: 'Failed to reach FCC data source', detail: err.message });
  }
});

/**
 * GET /api/providers/:id/technologies
 *
 * 1. Try BDC tile probing (fast, 0-byte empty tiles, uses BDC provider ID)
 * 2. Fall back to Socrata Form 477 GROUP-BY-free query (works for Form 477 IDs)
 */
router.get('/:id/technologies', async (req, res) => {
  const { id } = req.params;
  const providerName = String(req.query.provider_name || '');
  if (!id) return res.status(400).json({ error: 'Provider ID required' });

  try {
    const data = await resolveProviderTechnologies(id, providerName);
    res.json(data);
  } catch (err) {
    console.error('[providers/:id/technologies]', err.message);
    res.status(502).json({ error: 'Failed to reach FCC data source', detail: err.message });
  }
});

export default router;
