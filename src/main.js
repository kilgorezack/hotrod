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
  // Initialize the Add Provider panel
  initAddProvider();

  // Register callback for when user adds a provider
  onProviderAdd(handleProviderAdd);

  // Initialize Apple MapKit JS map
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
 */
async function handleProviderAdd(provider, techCode) {
  const key = `${provider.id}:${techCode}`;

  // Prevent duplicate layers
  if (activeProviders.has(key)) {
    showToast(`${provider.name} is already on the map with this technology.`, 'info');
    return;
  }

  // Assign color
  const color = assignColor(key);

  // Add to state
  activeProviders.set(key, {
    provider,
    techCode,
    colorHex: color.hex,
    visible: true,
  });

  // Render the sidebar card
  addProviderCard(
    {
      id: provider.id,
      name: provider.name,
      techCode,
      colorHex: color.hex,
      visible: true,
    },
    {
      onToggle: handleToggleProvider,
      onRemove: handleRemoveProvider,
    }
  );

  showToast(`Loading coverage for ${provider.name}…`, 'info', 2500);

  // Fetch and render coverage overlay
  try {
    const geojson = await getCoverageGeoJSON(provider.id, techCode);

    const countyCount = geojson?.meta?.countyCount ?? geojson?.features?.length ?? 0;

    if (!geojson?.features?.length) {
      showToast(`No coverage data found for ${provider.name} — ${techLabel(techCode)}.`, 'info');
      updateCardCoverage(provider.id, techCode, 0);
      return;
    }

    // Add coverage polygons to map
    const overlayCount = await addCoverageOverlay(provider.id, techCode, color.hex, geojson);

    // Update sidebar card with coverage stats
    updateCardCoverage(provider.id, techCode, countyCount);

    showToast(
      `Added ${provider.name} — ${techLabel(techCode)} (${countyCount.toLocaleString()} counties)`,
      'success'
    );
  } catch (err) {
    console.error('[coverage load]', err);
    markCardError(provider.id, techCode, 'Coverage data unavailable');
    showToast(`Failed to load coverage for ${provider.name}.`, 'error');
  }
}

/**
 * Toggle a provider's map layer visibility.
 */
function handleToggleProvider(providerId, techCode, visible) {
  const key = `${providerId}:${techCode}`;
  const entry = activeProviders.get(key);
  if (!entry) return;

  entry.visible = visible;
  toggleCoverageOverlay(providerId, techCode, visible);
  updateCardVisibility(providerId, techCode, visible);
}

/**
 * Remove a provider from the map and sidebar.
 */
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
    '10': 'DSL', '40': 'Cable', '50': 'Fiber',
    '60': 'Satellite', '70': 'Fixed Wireless',
  };
  return LABELS[String(code)] || `Tech ${code}`;
}

// ─── Start ───────────────────────────────────────────────────────────────────

init();
