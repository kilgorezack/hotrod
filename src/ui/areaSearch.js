/**
 * areaSearch.js — "Find Providers in Area" feature UI.
 *
 * Completely separate from the existing sidebar Add Provider flow.
 * Initialised once from main.js after the map is ready.
 *
 * Exported API:
 *   initAreaSearch(mapInstance, onProviderAdd)
 */

import { initDrawTool, startDraw, stopDraw, clearSelectionOverlay, isDrawing } from '../map/drawTool.js';
import { fetchAreaProviders } from '../api/areaProviders.js';
import { showToast } from './toast.js';

// Tech code labels (mirrors main.js techLabel)
const TECH_LABELS = {
  '10': 'DSL', '11': 'ADSL2', '20': 'SDSL', '30': 'Other DSL',
  '40': 'Cable', '41': 'DOCSIS 3+', '43': 'DOCSIS 3.1',
  '50': 'Fiber', '60': 'Satellite', '70': 'Fixed Wireless',
  '90': 'Power Line', '300': '5G NR',
};

const TECH_COLORS = {
  '10': '#a78bfa', '50': '#10b981', '40': '#f59e0b',
  '70': '#06b6d4', '60': '#3b82f6', '300': '#f85149',
  '30': '#8b5cf6', '90': '#84cc16', '41': '#d97706', '43': '#b45309',
};

function techLabel(code) { return TECH_LABELS[String(code)] || `Tech ${code}`; }
function techColor(code) { return TECH_COLORS[String(code)] || '#8b949e'; }

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * @param {mapkit.Map}  mapInstance
 * @param {Function}    onProviderAdd  — (provider, techCode) => void
 */
export function initAreaSearch(mapInstance, onProviderAdd) {
  initDrawTool(mapInstance, {
    onPolygonComplete: (vertices) => _handlePolygonComplete(vertices, onProviderAdd),
    onCancel:          _handleCancel,
  });

  // Toolbar button toggles draw mode
  const btn = document.getElementById('area-search-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      if (isDrawing()) {
        stopDraw();
        _handleCancel();
      } else {
        _startDraw(btn);
      }
    });
  }

  // Cancel button in hint bar
  const cancelBtn = document.getElementById('draw-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      stopDraw();
      _handleCancel();
    });
  }

  // Close button on results panel
  const closeBtn = document.getElementById('area-results-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', _dismissResults);
  }

  // Escape key handled inside drawTool, but also dismiss results panel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') _dismissResults();
  });
}

// ─── Draw mode state ──────────────────────────────────────────────────────────

function _startDraw(btn) {
  startDraw();
  btn?.classList.add('active');
  _setHint(true, 'Click on the map to draw — double-click or click start point to finish');
  _hideResults();
  clearSelectionOverlay();
}

function _handleCancel() {
  document.getElementById('area-search-btn')?.classList.remove('active');
  _setHint(false);
}

function _setHint(visible, text = '') {
  const bar = document.getElementById('draw-hint');
  if (!bar) return;
  bar.hidden = !visible;
  if (text) {
    const span = document.getElementById('draw-hint-text');
    if (span) span.textContent = text;
  }
}

// ─── Results flow ─────────────────────────────────────────────────────────────

async function _handlePolygonComplete(vertices, onProviderAdd) {
  document.getElementById('area-search-btn')?.classList.remove('active');
  _setHint(false);
  _showLoading();

  try {
    const providers = await fetchAreaProviders(vertices);
    _renderResults(providers, onProviderAdd);
  } catch (err) {
    console.error('[areaSearch]', err);
    _showError(err.message || 'Could not load providers for this area.');
  }
}

function _showLoading() {
  const panel = document.getElementById('area-results-panel');
  const body  = document.getElementById('area-results-body');
  if (!panel || !body) return;

  body.innerHTML = `
    <div class="area-results-loading">
      <svg class="area-loading-spinner" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="2"
          stroke-dasharray="30" stroke-dashoffset="10"/>
      </svg>
      <span>Finding providers in area…</span>
    </div>`;
  panel.hidden = false;
}

function _showError(message) {
  const panel = document.getElementById('area-results-panel');
  const body  = document.getElementById('area-results-body');
  if (!panel || !body) return;
  body.innerHTML = `<p class="area-results-empty">${_esc(message)}</p>`;
  panel.hidden = false;
}

function _hideResults() {
  const panel = document.getElementById('area-results-panel');
  if (panel) panel.hidden = true;
}

function _dismissResults() {
  _hideResults();
  clearSelectionOverlay();
}

function _renderResults(providers, onProviderAdd) {
  const panel = document.getElementById('area-results-panel');
  const body  = document.getElementById('area-results-body');
  if (!panel || !body) return;

  if (!providers.length) {
    body.innerHTML = `<p class="area-results-empty">No providers found in this area. Try drawing a wider selection.</p>`;
    panel.hidden = false;
    return;
  }

  const title = document.getElementById('area-results-title');
  if (title) title.textContent = `${providers.length} Provider${providers.length !== 1 ? 's' : ''} Found`;

  body.innerHTML = providers.map(p => `
    <div class="area-result-card">
      <div class="area-result-name">${_esc(p.providerName)}</div>
      <div class="area-result-techs">
        ${p.techCodes.map(tc => `
          <button
            class="area-tech-chip"
            data-provider-id="${_esc(p.providerId)}"
            data-provider-name="${_esc(p.providerName)}"
            data-tech="${_esc(tc)}"
            title="Add ${_esc(techLabel(tc))} coverage for ${_esc(p.providerName)}"
          >
            <span class="area-tech-dot" style="background:${techColor(tc)}"></span>
            <span class="area-tech-label">${techLabel(tc)}</span>
            <span class="area-tech-add">+ Add</span>
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');

  // Wire up chip clicks
  body.querySelectorAll('.area-tech-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const providerId   = chip.dataset.providerId;
      const providerName = chip.dataset.providerName;
      const techCode     = chip.dataset.tech;

      onProviderAdd({ id: providerId, name: providerName }, techCode);

      // Visual feedback: replace "+ Add" with "✓"
      const addLabel = chip.querySelector('.area-tech-add');
      if (addLabel) addLabel.textContent = '✓';
      chip.classList.add('added');
      chip.disabled = true;
    });
  });

  panel.hidden = false;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
