/**
 * HOTROD — Hyperlocal Open-source Telecom Reach & Overbuild Dashboard
 * Main application entry point
 */

import { initMap } from './map/init.js';
import { addCoverageOverlay, removeCoverageOverlay, toggleCoverageOverlay } from './map/overlays.js';
import { initAddProvider, onProviderAdd } from './ui/addProvider.js';
import { addProviderCard, removeProviderCard, updateCardCoverage, markCardError, updateCardVisibility } from './ui/sidebar.js';
import { showToast } from './ui/toast.js';
import { assignColor, releaseColor } from './utils/colors.js';
import { fetchHexCoverage } from './map/hexCoverage.js';
import { getCoverageGeoJSON } from './api/coverage.js';

// ─── App State ───────────────────────────────────────────────────────────────

/**
 * Active providers map.
 * Key: `${providerId}:${techCode}`
 * Value: { provider, techCode, colorHex, visible }
 */
const activeProviders = new Map();

// ─── Initialize ──────────────────────────────────────────────────────────────

async function init() {
  initAddProvider();
  onProviderAdd(handleProviderAdd);

  try {
    await initMap();
  } catch (err) {
    console.error('[map init]', err);
    showToast('Map failed to initialize. Check your MapKit token.', 'error', 0);
  }
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
    // ── Step 1: Try FCC BDC hex tiles (current data, exact hexagons) ──────────
    let geojson = await fetchHexCoverage(provider.id, techCode);
    let dataSource = 'hex';

    // ── Step 2: Fall back to Form 477 state polygons if hex tiles returned nothing
    if (!geojson?.features?.length) {
      console.info(`[coverage] No BDC hex data for ${provider.id}:${techCode} — falling back to state polygons`);
      geojson = await getCoverageGeoJSON(provider.id, techCode);
      dataSource = 'state';
    }

    if (!geojson?.features?.length) {
      showToast(`No coverage data found for ${provider.name} — ${techLabel(techCode)}.`, 'info');
      updateCardCoverage(provider.id, techCode, 0, 'hex');
      return;
    }

    await addCoverageOverlay(provider.id, techCode, color.hex, geojson);

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

// ─── Start ───────────────────────────────────────────────────────────────────

init();
