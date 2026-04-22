#!/usr/bin/env node
/**
 * Build a coarse H3 res-3 reverse index from Firebase hex data.
 *
 * Output: server/data/coverage_index_r3.json
 *   { "<res3_cell>": [{ id, name, techs: ["50","70"] }, ...], ... }
 *
 * This file lets the area-search endpoint skip Socrata entirely:
 *   1. Convert drawn polygon → res-3 cells
 *   2. Look up candidates from the index (fast, in-memory)
 *   3. Run detailed H3 intersection on candidates only
 *
 * Usage: node scripts/buildCoverageIndex.js
 * Re-run after each FCC BDC data refresh.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellToParent, getResolution } from 'h3-js';

const HERE     = path.dirname(fileURLToPath(import.meta.url));
// Output both formats:
//   coverageIndex.js       — static import for local/worker builds
//   coverage_index_r3.json — fetched at cold-start by Vercel serverless via GitHub raw CDN
const OUT_JS   = path.join(HERE, '..', 'server', 'data', 'coverageIndex.js');
const OUT_JSON = path.join(HERE, '..', 'server', 'data', 'coverage_index_r3.json');

const BUCKET     = process.env.FIREBASE_STORAGE_BUCKET || '';
const INDEX_RES  = 3;
const CONCURRENCY = 60;

if (!BUCKET) {
  console.error('FIREBASE_STORAGE_BUCKET not set. Run: FIREBASE_STORAGE_BUCKET=hotrod-7a59d.firebasestorage.app node scripts/buildCoverageIndex.js');
  process.exit(1);
}

function storageUrl(p) {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(p)}?alt=media`;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool(tasks, concurrency, fn) {
  let idx = 0;
  const results = new Array(tasks.length).fill(null);
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await fn(tasks[i], i); } catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading providers.json from Firebase…');
  const providers = await fetchJson(storageUrl('providers.json'));
  if (!providers) { console.error('providers.json not found'); process.exit(1); }
  console.log(`${providers.length} providers`);

  // Build task list: { id, name, tech }
  const tasks = providers.flatMap(p =>
    (p.techs || []).map(tech => ({ id: String(p.id), name: p.name, tech: String(tech) }))
  );
  console.log(`${tasks.length} (provider, tech) files to fetch`);

  // Build the index: Map<res3cell, Map<providerId, {name, techs: Set}>>
  const index = new Map(); // res3cell → Map<id, {name, techs: Set}>
  let done = 0, skipped = 0, errors = 0;

  const start = Date.now();

  await runPool(tasks, CONCURRENCY, async ({ id, name, tech }) => {
    const url = storageUrl(`hexes/${id}_${tech}.json`);
    let h3arr;
    try {
      h3arr = await fetchJson(url);
    } catch {
      errors++;
      return;
    }
    if (!Array.isArray(h3arr) || h3arr.length === 0) { skipped++; return; }

    // Coarsen to res-3
    const cells = new Set();
    for (const h of h3arr) {
      if (!h) continue;
      try {
        cells.add(getResolution(h) <= INDEX_RES ? h : cellToParent(h, INDEX_RES));
      } catch { /* skip */ }
    }

    for (const cell of cells) {
      if (!index.has(cell)) index.set(cell, new Map());
      const cellMap = index.get(cell);
      if (!cellMap.has(id)) cellMap.set(id, { name, techs: new Set() });
      cellMap.get(id).techs.add(tech);
    }

    done++;
    if (done % 500 === 0) {
      const pct = ((done / tasks.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  ${done}/${tasks.length} (${pct}%) — ${elapsed}s`);
    }
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nFetched: ${done} ok, ${skipped} empty/missing, ${errors} errors  (${elapsed}s)`);
  console.log(`Index covers ${index.size} res-3 cells`);

  // Serialise: cell → [{ id, name, techs: [] }]
  const out = {};
  for (const [cell, provMap] of index) {
    out[cell] = [...provMap.entries()].map(([id, { name, techs }]) => ({
      id,
      name,
      techs: [...techs].sort((a, b) => Number(a) - Number(b)),
    }));
  }

  mkdirSync(path.dirname(OUT_JS), { recursive: true });
  const json = JSON.stringify(out);

  // Write JSON (used by Vercel serverless via GitHub raw CDN fetch)
  const jsonStream = createWriteStream(OUT_JSON);
  jsonStream.write(json);
  jsonStream.end();
  await new Promise(resolve => jsonStream.on('finish', resolve));

  // Write JS module (used by static import in local/worker builds)
  const js = `// AUTO-GENERATED by scripts/buildCoverageIndex.js — do not edit\nexport default ${json};\n`;
  const jsStream = createWriteStream(OUT_JS);
  jsStream.write(js);
  jsStream.end();
  await new Promise(resolve => jsStream.on('finish', resolve));

  const sizeKb = (Buffer.byteLength(json) / 1024).toFixed(0);
  console.log(`\nWrote coverage_index_r3.json + coverageIndex.js (${sizeKb} KB each)`);
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
