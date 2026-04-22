/**
 * Client-side area provider lookup.
 *
 * Fetches the pre-built H3 res-3 coverage index once (browser-cached),
 * converts the drawn polygon to res-3 cells using h3-js, and returns
 * matching providers — no Lambda round-trip required.
 */

import { polygonToCells, latLngToCell } from 'h3-js';

/** @typedef {{ providerId: string, providerName: string, techCodes: string[] }} AreaProvider */

const INDEX_RES = 3;

// In-memory cache so we only fetch the ~1 MB index once per page load.
let _indexPromise = null;

async function loadIndex() {
  if (_indexPromise) return _indexPromise;
  _indexPromise = fetch('/coverage_index_r3.json')
    .then(r => {
      if (!r.ok) throw new Error(`Failed to load coverage index: HTTP ${r.status}`);
      return r.json();
    })
    .catch(err => {
      _indexPromise = null; // allow retry
      throw err;
    });
  return _indexPromise;
}

function polygonToR3Cells(vertices) {
  const coords = vertices.map(v => [v.latitude, v.longitude]);
  if (coords[0][0] !== coords.at(-1)[0] || coords[0][1] !== coords.at(-1)[1]) {
    coords.push(coords[0]);
  }

  let cells;
  try { cells = polygonToCells(coords, INDEX_RES); } catch { cells = []; }

  if (cells.length === 0) {
    // Polygon too small for res-3 — use its centroid cell
    const lat = vertices.reduce((s, v) => s + v.latitude,  0) / vertices.length;
    const lng = vertices.reduce((s, v) => s + v.longitude, 0) / vertices.length;
    cells = [latLngToCell(lat, lng, INDEX_RES)];
  }

  return new Set(cells);
}

/**
 * Find all broadband providers with coverage in a drawn polygon.
 *
 * @param {Array<{latitude: number, longitude: number}>} vertices
 * @returns {Promise<AreaProvider[]>}
 */
export async function fetchAreaProviders(vertices) {
  const index = await loadIndex();

  const r3cells = polygonToR3Cells(vertices);

  const providerMap = new Map();
  for (const cell of r3cells) {
    for (const { id, name, techs } of (index[cell] ?? [])) {
      if (!providerMap.has(id)) {
        providerMap.set(id, { providerId: id, providerName: name, techCodes: new Set(techs) });
      } else {
        for (const t of techs) providerMap.get(id).techCodes.add(t);
      }
    }
  }

  return [...providerMap.values()]
    .map(p => ({ ...p, techCodes: [...p.techCodes].sort((a, b) => Number(a) - Number(b)) }))
    .sort((a, b) => a.providerName.localeCompare(b.providerName));
}
