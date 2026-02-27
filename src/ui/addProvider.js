import { TECHNOLOGY_TYPES, TECH_BY_CODE } from '../config.js';
import { searchProviders, getProviderTechnologies } from '../api/providers.js';
import { showToast } from './toast.js';

// ─── DOM refs ────────────────────────────────────────────────────────────────
const providerView = document.getElementById('provider-view');
const addView = document.getElementById('add-view');
const addBtn = document.getElementById('add-provider-btn');
const backBtn = document.getElementById('back-btn');
const searchInput = document.getElementById('provider-search');
const searchSpinner = document.getElementById('search-spinner');
const searchResults = document.getElementById('search-results');
const selectedSection = document.getElementById('selected-provider-section');
const selectedDisplay = document.getElementById('selected-provider-display');
const techSection = document.getElementById('tech-section');
const techChips = document.getElementById('tech-chips');
const techLoading = document.getElementById('tech-loading');
const techEmpty = document.getElementById('tech-empty');
const addActionsSection = document.getElementById('add-actions-section');
const addToMapBtn = document.getElementById('add-to-map-btn');

// ─── State ───────────────────────────────────────────────────────────────────
let selectedProvider = null;   // { id, name }
let selectedTechCode = null;
let searchTimeout = null;
let onAddCallback = null;      // (provider, techCode) => void

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register the callback invoked when the user clicks "Add to Map".
 * @param {(provider: {id,name}, techCode: string) => void} fn
 */
export function onProviderAdd(fn) {
  onAddCallback = fn;
}

/**
 * Wire up open/close/submit event listeners.
 * Call once during app initialization.
 */
export function initAddProvider() {
  addBtn.addEventListener('click', openAddPanel);
  backBtn.addEventListener('click', closeAddPanel);
  searchInput.addEventListener('input', handleSearchInput);
  searchInput.addEventListener('keydown', handleSearchKeydown);
  addToMapBtn.addEventListener('click', handleAddToMap);
}

// ─── Panel Open / Close ──────────────────────────────────────────────────────

function openAddPanel() {
  resetPanel();
  providerView.classList.remove('active');
  providerView.setAttribute('aria-hidden', 'true');
  addView.classList.add('active');
  addView.removeAttribute('aria-hidden');
  setTimeout(() => searchInput.focus(), 50);
}

function closeAddPanel() {
  addView.classList.remove('active');
  addView.setAttribute('aria-hidden', 'true');
  providerView.classList.add('active');
  providerView.removeAttribute('aria-hidden');
}

function resetPanel() {
  selectedProvider = null;
  selectedTechCode = null;
  searchInput.value = '';
  searchResults.innerHTML = '';
  searchResults.classList.remove('visible');
  selectedSection.hidden = true;
  techSection.hidden = true;
  addActionsSection.hidden = true;
  addToMapBtn.disabled = true;
}

// ─── Search ──────────────────────────────────────────────────────────────────

function handleSearchInput() {
  const q = searchInput.value.trim();
  clearTimeout(searchTimeout);

  if (q.length < 3) {
    searchResults.innerHTML = '';
    searchResults.classList.remove('visible');
    return;
  }

  searchSpinner.classList.add('visible');
  searchTimeout = setTimeout(() => performSearch(q), 350);
}

async function performSearch(query) {
  try {
    const providers = await searchProviders(query);
    searchSpinner.classList.remove('visible');
    renderSearchResults(providers, query);
  } catch (err) {
    searchSpinner.classList.remove('visible');
    renderSearchError();
    console.error('[search]', err);
  }
}

function renderSearchResults(providers, query) {
  searchResults.innerHTML = '';

  if (!providers.length) {
    searchResults.innerHTML = `<div class="search-no-results">No providers found for "${escapeHtml(query)}"</div>`;
    searchResults.classList.add('visible');
    return;
  }

  for (const p of providers) {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.setAttribute('role', 'option');
    item.setAttribute('tabindex', '0');
    item.innerHTML = `
      <span class="result-name">${highlightMatch(p.name, query)}</span>
      <span class="result-id">Provider ID: ${escapeHtml(p.id)}</span>
    `;
    item.addEventListener('click', () => selectProvider(p));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') selectProvider(p);
    });
    searchResults.appendChild(item);
  }

  searchResults.classList.add('visible');
}

function renderSearchError() {
  searchResults.innerHTML = `<div class="search-no-results" style="color:var(--danger)">Failed to reach FCC data. Check connection.</div>`;
  searchResults.classList.add('visible');
}

function handleSearchKeydown(e) {
  if (e.key === 'ArrowDown') {
    const first = searchResults.querySelector('.search-result-item');
    if (first) first.focus();
  }
  if (e.key === 'Escape') closeAddPanel();
}

// ─── Provider Selection ──────────────────────────────────────────────────────

async function selectProvider(provider) {
  selectedProvider = provider;
  selectedTechCode = null;

  // Hide search results
  searchResults.classList.remove('visible');
  searchInput.value = '';

  renderSelectedProvider(provider);
  selectedSection.hidden = false;

  // Load technology options
  techSection.hidden = false;
  techChips.innerHTML = '';
  techLoading.hidden = false;
  techEmpty.hidden = true;
  addActionsSection.hidden = true;
  addToMapBtn.disabled = true;

  try {
    const techData = await getProviderTechnologies(provider.id, provider.name);
    const codes = techData.technologies || [];
    selectedProvider = {
      ...provider,
      id: techData.providerId || provider.id,
      name: techData.providerName || provider.name,
      techSource: techData.source || 'unknown',
    };
    renderSelectedProvider(selectedProvider);

    if (techData.resolvedFromProviderId) {
      showToast(`Matched to FCC BDC provider ID ${selectedProvider.id} for hex coverage.`, 'info', 3500);
    }

    techLoading.hidden = true;

    if (!codes.length) {
      techEmpty.hidden = false;
      return;
    }

    renderTechChips(codes);
    addActionsSection.hidden = false;
  } catch (err) {
    techLoading.hidden = true;
    techEmpty.hidden = false;
    techEmpty.textContent = 'Failed to load technology data.';
    console.error('[tech]', err);
  }
}

function renderSelectedProvider(provider) {
  const initial = provider.name.charAt(0).toUpperCase();
  selectedDisplay.innerHTML = `
    <div class="selected-provider-icon">${escapeHtml(initial)}</div>
    <div class="selected-provider-info">
      <div class="selected-provider-name">${escapeHtml(provider.name)}</div>
      <div class="selected-provider-id">ID: ${escapeHtml(provider.id)}</div>
    </div>
    <button class="btn-change-provider">Change</button>
  `;
  selectedDisplay.querySelector('.btn-change-provider').addEventListener('click', resetToSearch);
}

function resetToSearch() {
  selectedProvider = null;
  selectedTechCode = null;
  selectedSection.hidden = true;
  techSection.hidden = true;
  addActionsSection.hidden = true;
  addToMapBtn.disabled = true;
  searchInput.focus();
}

// ─── Technology Chips ────────────────────────────────────────────────────────

function renderTechChips(codes) {
  techChips.innerHTML = '';

  for (const code of codes) {
    const tech = TECH_BY_CODE[String(code)] || {
      shortLabel: `Tech ${code}`,
      color: '#8b949e',
    };

    const chip = document.createElement('button');
    chip.className = 'tech-chip';
    chip.dataset.code = code;
    chip.innerHTML = `
      <span class="tech-chip-dot" style="background:${tech.color}"></span>
      ${escapeHtml(tech.shortLabel)}
    `;

    chip.addEventListener('click', () => {
      // Deselect all chips
      techChips.querySelectorAll('.tech-chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      selectedTechCode = String(code);
      addToMapBtn.disabled = false;
    });

    techChips.appendChild(chip);
  }
}

// ─── Add to Map ──────────────────────────────────────────────────────────────

function handleAddToMap() {
  if (!selectedProvider || !selectedTechCode) return;

  if (typeof onAddCallback === 'function') {
    onAddCallback(selectedProvider, selectedTechCode);
  }

  closeAddPanel();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightMatch(text, query) {
  const escaped = escapeHtml(text);
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedQuery})`, 'gi');
  return escaped.replace(regex, '<span class="result-match">$1</span>');
}
