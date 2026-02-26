/**
 * FCC opendata.fcc.gov Socrata API client
 *
 * Dataset used:
 *   4kuc-phrr — Fixed Broadband Deployment: June 2020 V1
 *               (census block level; has provider_id, providername, techcode, stateabbr)
 *
 * Note: substr/left string functions are not supported in this Socrata instance,
 * so coverage is aggregated to the state level (stateabbr GROUP BY).
 *
 * Socrata SoQL docs: https://dev.socrata.com/docs/queries/
 */

import fetch from 'node-fetch';

const SOCRATA_BASE = 'https://opendata.fcc.gov/resource';
const DATASET = '4kuc-phrr';

// In-memory cache: key → { data, expiresAt }
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data, ttlMs) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function buildUrl(params) {
  const url = new URL(`${SOCRATA_BASE}/${DATASET}.json`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return url.toString();
}

async function socrataFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-App-Token': process.env.FCC_APP_TOKEN || '',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`FCC API error ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Provider Search ─────────────────────────────────────────────────────────

/**
 * Search providers by full-text match using Socrata $q (uses FTS index, fast).
 * Works best with complete words: "comcast", "verizon", "spectrum", etc.
 * Returns array of { provider_id, providername }.
 */
export async function searchProviders(query, limit = 20) {
  const key = `providers:search:${query.toLowerCase()}:${limit}`;
  const cached = getCached(key);
  if (cached) return cached;

  // $q uses the full-text search index — much faster than $where LIKE + $group.
  // Fetch 500 rows and deduplicate provider_id in Node to get all matching entities.
  const url = buildUrl({
    '$q': query,
    '$select': 'provider_id,providername',
    '$limit': 500,
  });

  const data = await socrataFetch(url);

  // Deduplicate by provider_id, then cap at limit
  const seen = new Set();
  const unique = data
    .filter((r) => {
      if (!r.provider_id || seen.has(r.provider_id)) return false;
      seen.add(r.provider_id);
      return true;
    })
    .slice(0, limit);

  setCached(key, unique, 60 * 60 * 1000); // 1 hour
  return unique;
}

// ─── Technologies for a Provider ─────────────────────────────────────────────

/**
 * Get available technology codes for a provider.
 * Returns array of { techcode }.
 */
export async function getProviderTechnologies(providerId) {
  const key = `providers:tech:${providerId}`;
  const cached = getCached(key);
  if (cached) return cached;

  const url = buildUrl({
    '$select': 'techcode',
    '$where': `provider_id = '${providerId}'`,
    '$group': 'techcode',
    '$order': 'techcode ASC',
    '$limit': 50,
  });

  const data = await socrataFetch(url);
  setCached(key, data, 60 * 60 * 1000); // 1 hour
  return data;
}

// ─── Coverage by State ────────────────────────────────────────────────────────

/**
 * Get the list of unique state abbreviations where a provider+tech offers service.
 * Returns array of { stateabbr }.
 *
 * Note: FCC's Socrata instance does not support substr/left, so county-level
 * aggregation is not available via SoQL. State-level is used instead.
 */
export async function getProviderStateCoverage(providerId, techCode) {
  const key = `coverage:state:${providerId}:${techCode}`;
  const cached = getCached(key);
  if (cached) return cached;

  const url = buildUrl({
    '$select': 'stateabbr',
    '$where': `provider_id = '${providerId}' AND techcode = '${techCode}'`,
    '$group': 'stateabbr',
    '$order': 'stateabbr ASC',
    '$limit': 60,
  });

  const data = await socrataFetch(url);
  setCached(key, data, 30 * 60 * 1000); // 30 minutes
  return data;
}
