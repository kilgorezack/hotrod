import { TECH_BY_CODE } from '../config.js';

const providerListEl = document.getElementById('provider-list');
const emptyStateEl = document.getElementById('empty-state');
const mapLegendEl = document.getElementById('map-legend');
const legendItemsEl = document.getElementById('legend-items');

// ─── Provider Card Rendering ─────────────────────────────────────────────────

/**
 * Render a provider card in the sidebar.
 *
 * @param {object} provider
 *   { id, name, techCode, colorHex, countyCount, totalCounties, visible }
 * @param {object} callbacks
 *   { onToggle(id, techCode, visible), onRemove(id, techCode) }
 */
export function addProviderCard(provider, callbacks) {
  // Remove empty state
  emptyStateEl.style.display = 'none';

  const tech = TECH_BY_CODE[provider.techCode] || { shortLabel: `Tech ${provider.techCode}`, color: '#8b949e' };
  const cardId = cardElId(provider.id, provider.techCode);

  const card = document.createElement('div');
  card.className = 'provider-card';
  card.id = cardId;
  card.style.setProperty('--provider-color', provider.colorHex);

  card.innerHTML = `
    <div class="provider-card-top">
      <div class="provider-name-wrap">
        <div class="provider-color-dot"></div>
        <span class="provider-name" title="${escapeHtml(provider.name)}">${escapeHtml(provider.name)}</span>
      </div>
      <div class="provider-card-controls">
        <button class="btn-icon btn-toggle active" data-id="${provider.id}" data-tech="${provider.techCode}" aria-label="Toggle coverage visibility" title="Toggle visibility">
          ${eyeOpenIcon()}
        </button>
        <button class="btn-icon btn-remove" data-id="${provider.id}" data-tech="${provider.techCode}" aria-label="Remove provider" title="Remove">
          ${removeIcon()}
        </button>
      </div>
    </div>

    <div class="provider-tech">
      <span class="tech-badge" style="color:${tech.color}">${escapeHtml(tech.shortLabel)}</span>
    </div>

    <div class="provider-loading" id="${cardId}-loading">
      <span>Loading coverage…</span>
    </div>

    <div id="${cardId}-coverage" hidden>
      <div class="provider-coverage-bar">
        <div class="provider-coverage-fill" style="width:0%"></div>
      </div>
      <div class="provider-coverage-label">
        <span id="${cardId}-county-label">— counties</span>
      </div>
    </div>
  `;

  // Wire up controls
  card.querySelector('.btn-toggle').addEventListener('click', () => {
    const isVisible = card.querySelector('.btn-toggle').classList.contains('active');
    const nowVisible = !isVisible;
    updateCardVisibility(provider.id, provider.techCode, nowVisible);
    callbacks.onToggle(provider.id, provider.techCode, nowVisible);
  });

  card.querySelector('.btn-remove').addEventListener('click', () => {
    removeProviderCard(provider.id, provider.techCode);
    callbacks.onRemove(provider.id, provider.techCode);
  });

  providerListEl.appendChild(card);

  // Update legend
  updateLegend();
}

/**
 * Update the coverage stats shown on a card after data loads.
 *
 * @param {string} id
 * @param {string} techCode
 * @param {number} countyCount   — number of covered counties
 * @param {number} totalCounties — total US counties (~3143)
 */
export function updateCardCoverage(id, techCode, countyCount) {
  const cardId = cardElId(id, techCode);
  const loadingEl = document.getElementById(`${cardId}-loading`);
  const coverageEl = document.getElementById(`${cardId}-coverage`);
  const fillEl = coverageEl?.querySelector('.provider-coverage-fill');
  const labelEl = document.getElementById(`${cardId}-county-label`);

  if (loadingEl) loadingEl.style.display = 'none';
  if (coverageEl) coverageEl.hidden = false;

  const total = 3143; // approximate US county count
  const pct = Math.round((countyCount / total) * 100 * 10) / 10;

  if (fillEl) fillEl.style.width = `${Math.min(pct, 100)}%`;
  if (labelEl) labelEl.textContent = `${countyCount.toLocaleString()} counties (${pct}% coverage)`;
}

/**
 * Mark card as having failed to load coverage data.
 */
export function markCardError(id, techCode, message) {
  const cardId = cardElId(id, techCode);
  const loadingEl = document.getElementById(`${cardId}-loading`);
  if (loadingEl) loadingEl.innerHTML = `<span style="color:var(--danger);font-size:11px;">⚠ ${escapeHtml(message)}</span>`;
}

/**
 * Remove a provider card from the sidebar.
 */
export function removeProviderCard(id, techCode) {
  const card = document.getElementById(cardElId(id, techCode));
  if (card) {
    card.style.opacity = '0';
    card.style.transform = 'translateX(-8px)';
    card.style.transition = 'opacity 200ms, transform 200ms';
    setTimeout(() => {
      card.remove();
      maybeShowEmpty();
      updateLegend();
    }, 200);
  }
}

/**
 * Toggle the visual state of a provider card's visibility button.
 */
export function updateCardVisibility(id, techCode, visible) {
  const card = document.getElementById(cardElId(id, techCode));
  if (!card) return;

  const btn = card.querySelector('.btn-toggle');
  if (!btn) return;

  if (visible) {
    btn.classList.add('active');
    btn.innerHTML = eyeOpenIcon();
    btn.title = 'Hide coverage';
    card.classList.remove('hidden-layer');
  } else {
    btn.classList.remove('active');
    btn.innerHTML = eyeClosedIcon();
    btn.title = 'Show coverage';
    card.classList.add('hidden-layer');
  }
}

// ─── Legend ──────────────────────────────────────────────────────────────────

function updateLegend() {
  const cards = providerListEl.querySelectorAll('.provider-card');

  if (!cards.length) {
    mapLegendEl.hidden = true;
    return;
  }

  mapLegendEl.hidden = false;
  legendItemsEl.innerHTML = '';

  for (const card of cards) {
    const nameEl = card.querySelector('.provider-name');
    const badgeEl = card.querySelector('.tech-badge');
    const colorStyle = card.style.getPropertyValue('--provider-color');

    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <div class="legend-swatch" style="background:${colorStyle}"></div>
      <span class="legend-label">${escapeHtml(nameEl?.textContent || '')}</span>
      <span class="legend-sublabel">${escapeHtml(badgeEl?.textContent || '')}</span>
    `;
    legendItemsEl.appendChild(item);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cardElId(id, techCode) {
  return `card-${id}-${techCode}`.replace(/[^a-zA-Z0-9-_]/g, '-');
}

function maybeShowEmpty() {
  const cards = providerListEl.querySelectorAll('.provider-card');
  if (!cards.length) {
    emptyStateEl.style.display = '';
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function eyeOpenIcon() {
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    <circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1.3"/>
  </svg>`;
}

function eyeClosedIcon() {
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M1 7s2.5-4.5 6-4.5S13 7 13 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M2 10l10-6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`;
}

function removeIcon() {
  return `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}
