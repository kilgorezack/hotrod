/**
 * FCC opendata.fcc.gov Socrata API client
 *
 * Dataset IDs used:
 *   etum-4rg3  — Fixed Broadband Deployment: Provider Name Lookup
 *   4kuc-phrr  — Fixed Broadband Deployment: June 2020 V1 (census block level)
 *
 * Socrata SoQL docs: https://dev.socrata.com/docs/queries/
 */

import fetch from 'node-fetch';

const SOCRATA_BASE = 'https://opendata.fcc.gov/resource';

// Provider name lookup dataset
const PROVIDERS_DATASET = 'etum-4rg3';

// Coverage dataset (census block level, Jun 2020)
const COVERAGE_DATASET = '4kuc-phrr';

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

/**
 * Build a Socrata query URL with SoQL parameters.
 */
function buildUrl(dataset, params) {
  const url = new URL(`${SOCRATA_BASE}/${dataset}.json`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Fetch from Socrata with error handling.
 */
async function socrataFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
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
      throw new Error(`FCC API error ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Provider Search ────────────────────────────────────────────────────────

/**
 * Search providers by name (case-insensitive partial match).
 * Returns array of { providerid, providername }.
 */
export async function searchProviders(query, limit = 20) {
  const key = `providers:search:${query.toLowerCase()}:${limit}`;
  const cached = getCached(key);
  if (cached) return cached;

  // Escape single quotes for SoQL
  const escaped = query.replace(/'/g, "''");
  const url = buildUrl(PROVIDERS_DATASET, {
    '$select': 'providerid,providername',
    '$where': `lower(providername) like '%${escaped.toLowerCase()}%'`,
    '$order': 'providername ASC',
    '$limit': limit,
  });

  const data = await socrataFetch(url);

  // Deduplicate by providerid
  const seen = new Set();
  const unique = data.filter((r) => {
    if (!r.providerid || seen.has(r.providerid)) return false;
    seen.add(r.providerid);
    return true;
  });

  setCached(key, unique, 60 * 60 * 1000); // 1 hour
  return unique;
}

// ─── Technologies for a Provider ────────────────────────────────────────────

/**
 * Get available technology codes for a provider.
 * Returns array of { techcode }.
 */
export async function getProviderTechnologies(providerId) {
  const key = `providers:tech:${providerId}`;
  const cached = getCached(key);
  if (cached) return cached;

  const url = buildUrl(COVERAGE_DATASET, {
    '$select': 'techcode',
    '$where': `providerid = '${providerId}'`,
    '$group': 'techcode',
    '$order': 'techcode ASC',
    '$limit': 50,
  });

  const data = await socrataFetch(url);
  setCached(key, data, 60 * 60 * 1000); // 1 hour
  return data;
}

// ─── Coverage by County ──────────────────────────────────────────────────────

/**
 * Get the list of unique county FIPS codes where a provider+tech offers service.
 * Returns array of { stateabbr, countycode }.
 *
 * county FIPS = stateabbr + countycode (2+3 digits).
 * We aggregate census-block entries up to county level.
 */
export async function getProviderCountyCoverage(providerId, techCode) {
  const key = `coverage:county:${providerId}:${techCode}`;
  const cached = getCached(key);
  if (cached) return cached;

  const url = buildUrl(COVERAGE_DATASET, {
    '$select': 'stateabbr,countycode',
    '$where': `providerid = '${providerId}' AND techcode = '${techCode}'`,
    '$group': 'stateabbr,countycode',
    '$order': 'stateabbr ASC',
    '$limit': 5000,
  });

  const data = await socrataFetch(url);
  setCached(key, data, 30 * 60 * 1000); // 30 minutes
  return data;
}
