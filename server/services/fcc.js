/**
 * FCC data client — two sources:
 *
 * 1. FCC BDC API (broadbandmap.fcc.gov)
 *    - Provider search & technology lookup
 *    - Returns provider IDs that match the hex tile endpoint
 *    - Node.js fetch works with browser-like headers
 *
 * 2. FCC opendata.fcc.gov Socrata API (Form 477, June 2020)
 *    - State-level coverage fallback
 *    - Dataset 4kuc-phrr
 */

// Uses global fetch (Node.js 18+ native) — same TLS fingerprint as tiles.js
// so the FCC BDC API and tile server behave consistently.

// ─── BDC API ──────────────────────────────────────────────────────────────────

const BDC_BASE     = 'https://broadbandmap.fcc.gov/nbm/map/api';
const PROCESS_UUID = 'ae8c39d5-170d-4178-8147-5ac7dcaca06a'; // Jun 2025

const BDC_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://broadbandmap.fcc.gov/',
  'Origin':          'https://broadbandmap.fcc.gov',
  'sec-fetch-site':  'same-origin',
  'sec-fetch-mode':  'cors',
  'sec-fetch-dest':  'empty',
};

async function bdcFetch(path) {
  const res = await fetch(`${BDC_BASE}${path}`, {
    headers: BDC_HEADERS,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`BDC HTTP ${res.status} on ${path}`);
  const json = await res.json();
  if (json.status !== 'successful') throw new Error(`BDC error: ${json.message}`);
  return json.data ?? [];
}

// ─── Socrata API (Form 477 fallback) ─────────────────────────────────────────

const SOCRATA_BASE = 'https://opendata.fcc.gov/resource';
const DATASET      = '4kuc-phrr';

function buildUrl(params) {
  const url = new URL(`${SOCRATA_BASE}/${DATASET}.json`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return url.toString();
}

async function socrataFetch(url) {
  const res = await fetch(url, {
    headers: {
      'Accept':      'application/json',
      'X-App-Token': process.env.FCC_APP_TOKEN || '',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Socrata ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── In-memory cache ─────────────────────────────────────────────────────────

const cache = new Map();

function getCached(key) {
  const e = cache.get(key);
  if (!e || Date.now() > e.expiresAt) { cache.delete(key); return null; }
  return e.data;
}
function setCached(key, data, ttlMs) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ─── Provider Search ─────────────────────────────────────────────────────────

/**
 * Search providers by name.
 * Uses FCC BDC API first (returns IDs that match the hex tile endpoint).
 * Falls back to Form 477 Socrata if BDC is unreachable.
 *
 * @returns {Array<{ id, name }>}
 */
export async function searchProviders(query, limit = 20) {
  const key = `providers:search:${query.toLowerCase()}:${limit}`;
  const cached = getCached(key);
  if (cached) return cached;

  // ── Try BDC first ──────────────────────────────────────────────────────────
  try {
    const rows = await bdcFetch(
      `/provider/list/${PROCESS_UUID}/${encodeURIComponent(query)}/1`
    );
    const providers = rows
      .slice(0, limit)
      .map(r => ({ id: String(r.provider_id), name: r.provider_name }));

    if (providers.length > 0) {
      console.info(`[fcc] BDC provider search OK — "${query}" → ${providers.length} results (IDs: ${providers.slice(0,3).map(p=>p.id).join(', ')})`);
      setCached(key, providers, 60 * 60 * 1000); // 1 hour
      return providers;
    }
  } catch (err) {
    console.warn('[fcc] BDC provider search failed, falling back to Socrata:', err.message);
  }

  // ── Fall back to Socrata Form 477 ─────────────────────────────────────────
  const url = buildUrl({
    '$q':      query,
    '$select': 'provider_id,providername',
    '$limit':  500,
  });

  const data = await socrataFetch(url);

  const seen = new Set();
  const providers = data
    .filter(r => {
      if (!r.provider_id || seen.has(r.provider_id)) return false;
      seen.add(r.provider_id);
      return true;
    })
    .slice(0, limit)
    .map(r => ({ id: r.provider_id, name: r.providername }));

  console.warn(`[fcc] Socrata provider search fallback — "${query}" → ${providers.length} results (IDs are Form 477, NOT BDC — tiles may be empty)`);
  setCached(key, providers, 60 * 60 * 1000);
  return providers;
}

// ─── Technologies for a Provider ─────────────────────────────────────────────

/**
 * Get unique technology codes for a provider.
 * Fetches rows without GROUP BY (avoids slow Socrata aggregation),
 * then deduplicates in Node.
 *
 * @returns {Array<{ techcode: string }>}
 */
export async function getProviderTechnologies(providerId) {
  const key = `providers:tech:${providerId}`;
  const cached = getCached(key);
  if (cached) return cached;

  const url = buildUrl({
    '$select': 'techcode',
    '$where':  `provider_id = '${providerId}'`,
    '$limit':  500,
  });

  const data = await socrataFetch(url);

  const seen = new Set();
  const techs = data
    .filter(r => {
      if (!r.techcode || seen.has(r.techcode)) return false;
      seen.add(r.techcode);
      return true;
    })
    .map(r => ({ techcode: r.techcode }));

  setCached(key, techs, 60 * 60 * 1000);
  return techs;
}

// ─── State-level Coverage (fallback when hex tiles have no data) ──────────────

/**
 * Get unique state abbreviations where a provider+tech offers service.
 * Used as fallback when FCC BDC hex tiles return no data.
 *
 * @returns {Array<{ stateabbr: string }>}
 */
export async function getProviderStateCoverage(providerId, techCode) {
  const key = `coverage:state:${providerId}:${techCode}`;
  const cached = getCached(key);
  if (cached) return cached;

  const url = buildUrl({
    '$select': 'stateabbr',
    '$where':  `provider_id = '${providerId}' AND techcode = '${techCode}'`,
    '$group':  'stateabbr',
    '$order':  'stateabbr ASC',
    '$limit':  60,
  });

  const data = await socrataFetch(url);
  setCached(key, data, 30 * 60 * 1000);
  return data;
}
