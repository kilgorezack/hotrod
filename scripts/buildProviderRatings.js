#!/usr/bin/env node
/**
 * Build a merged provider ratings file for the Insights tab.
 *
 * Reads all unique providers from the H3 coverage index (2000+ ISPs),
 * then merges in Google ratings + pricing from bsp-stats.json for the
 * 30 known major ISPs via case-insensitive name matching.
 *
 * Output: public/data/provider-ratings.json
 *   [{ id, name, techs, googleRating, medianMonthlyPriceUsd, states }, ...]
 *
 * Usage: node scripts/buildProviderRatings.js
 * Re-run after each FCC BDC data refresh or bsp-stats update.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE    = path.dirname(fileURLToPath(import.meta.url));
const ROOT    = path.join(HERE, '..');
const IN_IDX  = path.join(ROOT, 'server', 'data', 'coverage_index_r3.json');
const IN_BSP  = path.join(ROOT, 'public', 'data', 'bsp-stats.json');
const OUT     = path.join(ROOT, 'public', 'data', 'provider-ratings.json');

// ─── Load inputs ──────────────────────────────────────────────────────────────

console.log('Reading coverage index…');
const index = JSON.parse(readFileSync(IN_IDX, 'utf8'));

console.log('Reading bsp-stats…');
const { providers: bspProviders } = JSON.parse(readFileSync(IN_BSP, 'utf8'));

// ─── Deduplicate providers from coverage index ────────────────────────────────

const providerMap = new Map(); // id → { id, name, techs: Set }

for (const entries of Object.values(index)) {
  for (const { id, name, techs } of entries) {
    if (!providerMap.has(id)) {
      providerMap.set(id, { id, name, techs: new Set(techs) });
    } else {
      for (const t of techs) providerMap.get(id).techs.add(t);
    }
  }
}

console.log(`Found ${providerMap.size} unique providers in coverage index.`);

// ─── Build bsp-stats lookup ───────────────────────────────────────────────────
// Key: lowercased alias → bsp entry
// Explicit extra aliases for bsp entries whose FCC BDC name differs from their
// consumer brand. Add new entries here when bsp-stats.json is updated.

const EXTRA_ALIASES = {
  'Comcast / Xfinity':                      ['Comcast', 'Xfinity'],
  'Charter / Spectrum':                     ['Charter', 'Spectrum'],  // exact-only (see below)
  'Lumen / CenturyLink / Quantum Fiber':    ['Lumen', 'CenturyLink', 'Quantum Fiber', 'Brightspeed'],
  'Optimum / Altice':                       ['Optimum', 'Altice'],
  'Windstream / Kinetic':                   ['Windstream', 'Kinetic'],
  'WideOpenWest / WOW':                     ['WideOpenWest', 'WOW!', 'WOW'],
  'GCI (Alaska Communications)':            ['GCI'],
  'Cincinnati Bell / Altafiber':            ['Cincinnati Bell', 'altafiber', 'Altafiber'],
  'T-Mobile Home Internet':                 ['T-Mobile'],
  'Verizon 5G Home Internet':               ['Verizon Fios', 'Verizon'],
};

// Aliases that must match the FULL provider name (not as a substring of a longer name).
// Prevents e.g. "Spectrum" from matching "Red Spectrum Communications LLC".
const EXACT_ONLY_ALIASES = new Set(['spectrum', 'charter', 'wow', 'wow!', 'verizon', 'lumen']);

const bspAliases = new Map();    // lc alias → bsp entry
const exactAliases = new Map();  // lc alias → bsp entry (exact-match only)

for (const p of bspProviders) {
  bspAliases.set(p.name.toLowerCase(), p);

  const extras = EXTRA_ALIASES[p.name] ?? [];
  for (const alias of extras) {
    const lc = alias.toLowerCase();
    if (EXACT_ONLY_ALIASES.has(lc)) {
      exactAliases.set(lc, p);
    } else {
      bspAliases.set(lc, p);
    }
  }
}

// Generic telecom words — never use as a substring match token
const GENERIC_WORDS = new Set([
  'communications', 'broadband', 'internet', 'fiber', 'fibre', 'wireless',
  'cable', 'network', 'networks', 'telecom', 'telecommunications', 'services',
  'service', 'inc', 'llc', 'corp', 'co', 'ltd', 'home',
]);

// ─── Fuzzy name match ─────────────────────────────────────────────────────────
// Returns the matching bsp entry if found, else null.
// Deliberately conservative: word-boundary matches only.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findBspMatch(providerName) {
  const lc = providerName.toLowerCase().trim();

  // 1. Exact alias match (includes exact-only aliases)
  if (bspAliases.has(lc))   return bspAliases.get(lc);
  if (exactAliases.has(lc)) return exactAliases.get(lc);

  // 2. Provider name contains a bsp alias as a whole-word phrase
  //    (alias must be ≥5 chars and not a generic telecom word)
  for (const [alias, entry] of bspAliases) {
    if (alias.length < 5 || GENERIC_WORDS.has(alias)) continue;
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`);
    if (re.test(lc)) return entry;
  }

  return null;
}

// ─── Merge ────────────────────────────────────────────────────────────────────

let matched = 0;
const matchedBspNames = new Set();

const coverageProviders = [...providerMap.values()]
  .map(({ id, name, techs }) => {
    const bsp = findBspMatch(name);
    if (bsp) {
      matched++;
      matchedBspNames.add(bsp.name);
    }
    return {
      id,
      name,
      techs: [...techs].sort((a, b) => Number(a) - Number(b)),
      googleRating:          bsp?.googleRating          ?? null,
      medianMonthlyPriceUsd: bsp?.medianMonthlyPriceUsd ?? null,
      states:                bsp?.states                ?? [],
    };
  });

// Add any bsp-stats entries that weren't matched to a coverage index provider.
// These are real ISPs (Ting, Hawaiian Telecom, etc.) that should still appear
// in the Insights search even if they're not in the coverage index.
const unmatchedBsp = bspProviders
  .filter(p => !matchedBspNames.has(p.name))
  .map(p => ({
    id:                    null,
    name:                  p.name,
    techs:                 [],
    googleRating:          p.googleRating          ?? null,
    medianMonthlyPriceUsd: p.medianMonthlyPriceUsd ?? null,
    states:                p.states                ?? [],
  }));

console.log(`Added ${unmatchedBsp.length} unmatched bsp-stats entries.`);

const providers = [...coverageProviders, ...unmatchedBsp]
  .sort((a, b) => a.name.localeCompare(b.name));

console.log(`Matched ${matched} providers to bsp-stats ratings.`);

// ─── Write output ─────────────────────────────────────────────────────────────

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(providers, null, 0));

const sizeKb = (Buffer.byteLength(JSON.stringify(providers)) / 1024).toFixed(0);
console.log(`Wrote ${providers.length} providers to public/data/provider-ratings.json (${sizeKb} KB)`);
console.log('Done.');
