/**
 * HOTROD — Hyperlocal Overbuild & Telecom Reach Optimization Dashboard
 * Main application entry point
 */

import { initMap, fitMapToGeoJSON } from './map/init.js';
import { initAreaSearch } from './ui/areaSearch.js';
import { addCoverageOverlay, removeCoverageOverlay, toggleCoverageOverlay } from './map/overlays.js';
import { initAddProvider, onProviderAdd } from './ui/addProvider.js';
import { initInsights } from './ui/insights.js';
import { addProviderCard, removeProviderCard, updateCardCoverage, markCardError, updateCardVisibility } from './ui/sidebar.js';
import { showToast } from './ui/toast.js';
import { assignColor, releaseColor } from './utils/colors.js';
import { fetchHexCoverage } from './map/hexCoverage.js';
import { getCoverageGeoJSON } from './api/coverage.js';
import { targetResolution, aggregateH3, h3ToGeoJSON, extractH3Indices } from './map/h3Resolution.js';

// ─── App State ───────────────────────────────────────────────────────────────

/**
 * Active providers map.
 * Key: `${providerId}:${techCode}`
 * Value: { provider, techCode, colorHex, visible, h3Indices, renderedResolution }
 */
const activeProviders = new Map();

/** MapKit map instance — set after initMap() resolves. */
let mapInst = null;

// ─── Initialize ──────────────────────────────────────────────────────────────

async function init() {
  initAddProvider();
  initInsights();
  onProviderAdd(handleProviderAdd);

  try {
    mapInst = await initMap();
  } catch (err) {
    console.error('[map init]', err);
    showToast('Map failed to initialize. Check your MapKit token.', 'error', 0);
  }

  if (mapInst) {
    initAreaSearch(mapInst, handleProviderAdd);
  }

  // Re-render all active providers at the appropriate H3 resolution when zoom changes.
  if (mapInst) {
    let _resolutionDebounce = null;
    mapInst.addEventListener('region-change-end', () => {
      clearTimeout(_resolutionDebounce);
      _resolutionDebounce = setTimeout(() => {
        const res = targetResolution(mapInst.region.span.latitudeDelta);
        for (const [, entry] of activeProviders) {
          if (!entry.h3Indices?.length) continue;
          // Always re-render once after the initial fit-to-coverage pan (_pendingRedraw),
          // because MapKit may not render overlays that were outside the viewport when
          // they were first added. After that, only re-render on resolution changes.
          if (entry.renderedResolution === res && !entry._pendingRedraw) continue;
          entry._pendingRedraw = false;
          entry.renderedResolution = res;
          const geojson = h3ToGeoJSON(aggregateH3(entry.h3Indices, res));
          addCoverageOverlay(entry.provider.id, entry.techCode, entry.colorHex, geojson);
          if (!entry.visible) toggleCoverageOverlay(entry.provider.id, entry.techCode, false);
        }
      }, 150);
    });
  }

  // Fail fast in production if the backend is misrouted/misconfigured.
  // Without the API, provider search/tech probing/tiles will fail and coverage
  // will show as "unavailable" with little context.
  checkApiHealth();
}

// ─── Provider Management ─────────────────────────────────────────────────────

/**
 * Called when the user clicks "Add to Map" in the add provider panel.
 *
 * Coverage source priority:
 *   1. FCC BDC hex tiles (broadbandmap.fcc.gov) → exact H3 hexagons, current data
 *   2. FCC Form 477 state polygons (opendata.fcc.gov) → state-level fallback
 */
async function handleProviderAdd(provider, techCode) {
  const key = `${provider.id}:${techCode}`;

  if (activeProviders.has(key)) {
    showToast(`${provider.name} is already on the map with this technology.`, 'info');
    return;
  }

  const color = assignColor(key);
  activeProviders.set(key, { provider, techCode, colorHex: color.hex, visible: true });

  addProviderCard(
    { id: provider.id, name: provider.name, techCode, colorHex: color.hex, visible: true },
    { onToggle: handleToggleProvider, onRemove: handleRemoveProvider }
  );

  showToast(`Loading coverage for ${provider.name}…`, 'info', 2500);

  try {
    let geojson = await fetchHexCoverage(provider.id, techCode);
    let dataSource = 'hex';

    const tileErrors = geojson?.meta?.tileStats?.tilesErrored ?? 0;
    const hasHex = (geojson?.features?.length ?? 0) > 0;

    // If all tile attempts errored out, do not silently mask the issue with
    // state polygons; this would look like valid coverage but be inaccurate.
    if (!hasHex && tileErrors > 0) {
      throw new Error(`Hex tile fetch failed for ${provider.id}:${techCode} (${tileErrors} tile errors)`);
    }

    if (!hasHex) {
      console.info(`[coverage] No BDC hex data for ${provider.id}:${techCode} — falling back to state polygons`);
      geojson = await getCoverageGeoJSON(provider.id, techCode);
      dataSource = 'state';
    }

    if (!geojson?.features?.length) {
      showToast(`No coverage data found for ${provider.name} — ${techLabel(techCode)}.`, 'info');
      updateCardCoverage(provider.id, techCode, 0, 'hex');
      return;
    }

    // Store raw H3 indices so we can re-render at any resolution on zoom change.
    const h3Indices = extractH3Indices(geojson);
    const entry = activeProviders.get(key);
    if (entry) {
      entry.h3Indices = h3Indices;
      entry._pendingRedraw = true; // force one re-render after the initial fit-to-coverage pan
    }

    // Render at resolution appropriate for the current zoom level.
    const currentSpan = mapInst?.region?.span?.latitudeDelta ?? 22;
    const res = targetResolution(currentSpan);
    if (entry) entry.renderedResolution = res;
    const renderGeoJSON = h3Indices.length
      ? h3ToGeoJSON(aggregateH3(h3Indices, res))
      : geojson;

    addCoverageOverlay(provider.id, techCode, color.hex, renderGeoJSON);
    fitMapToGeoJSON(renderGeoJSON); // renderGeoJSON has real coordinates; geojson may have null geometry

    const count = geojson.features.length;
    updateCardCoverage(provider.id, techCode, count, dataSource);

    const countStr = count.toLocaleString();
    const sourceLabel = dataSource === 'hex'
      ? `${countStr} hex area${count !== 1 ? 's' : ''}`
      : `${geojson.meta?.stateCount ?? count} state${(geojson.meta?.stateCount ?? count) !== 1 ? 's' : ''}`;

    showToast(`Added ${provider.name} — ${techLabel(techCode)} (${sourceLabel})`, 'success');
  } catch (err) {
    console.error('[coverage load]', err);
    markCardError(provider.id, techCode, 'Coverage data unavailable');
    showToast(`Failed to load coverage for ${provider.name}.`, 'error');
  }
}

function handleToggleProvider(providerId, techCode, visible) {
  const key = `${providerId}:${techCode}`;
  const entry = activeProviders.get(key);
  if (!entry) return;
  entry.visible = visible;
  toggleCoverageOverlay(providerId, techCode, visible);
  updateCardVisibility(providerId, techCode, visible);
}

function handleRemoveProvider(providerId, techCode) {
  const key = `${providerId}:${techCode}`;
  if (!activeProviders.has(key)) return;
  removeCoverageOverlay(providerId, techCode);
  releaseColor(key);
  activeProviders.delete(key);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function techLabel(code) {
  const LABELS = {
    '10': 'DSL', '11': 'ADSL2', '20': 'SDSL', '30': 'Other DSL',
    '40': 'Cable', '41': 'DOCSIS 3+', '43': 'DOCSIS 3.1',
    '50': 'Fiber', '60': 'Satellite', '70': 'Fixed Wireless',
    '90': 'Power Line', '300': '5G NR',
  };
  return LABELS[String(code)] || `Tech ${code}`;
}

async function checkApiHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('/api/health', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn('[api health]', err);
    showToast('Backend API unavailable — provider coverage may not load.', 'error', 8000);
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

init();
