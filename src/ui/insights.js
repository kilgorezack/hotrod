// ─── Census Divisions ────────────────────────────────────────────────────────

const CENSUS_DIVISIONS = {
  'New England':        ['CT','ME','MA','NH','RI','VT'],
  'Middle Atlantic':    ['NJ','NY','PA'],
  'East North Central': ['IL','IN','MI','OH','WI'],
  'West North Central': ['IA','KS','MN','MO','NE','ND','SD'],
  'South Atlantic':     ['DE','FL','GA','MD','NC','SC','VA','WV','DC'],
  'East South Central': ['AL','KY','MS','TN'],
  'West South Central': ['AR','LA','OK','TX'],
  'Mountain':           ['AZ','CO','ID','MT','NV','NM','UT','WY'],
  'Pacific':            ['AK','CA','HI','OR','WA'],
};

// ─── Module state ────────────────────────────────────────────────────────────

let cachedData = null;
let divisionStats = null;
let searchTimeout = null;

/** @type {Map<string, object>} name → provider object */
const selectedProviders = new Map();

// ─── DOM refs (set in initInsights) ──────────────────────────────────────────

let insightsSearch;
let insightsSearchResults;
let insightsBody;
let insightsChips;

// ─── Public API ──────────────────────────────────────────────────────────────

export async function initInsights() {
  insightsSearch        = document.getElementById('insights-search');
  insightsSearchResults = document.getElementById('insights-search-results');
  insightsBody          = document.getElementById('insights-body');
  insightsChips         = document.getElementById('insights-chips');

  initTabNav();

  insightsSearch.addEventListener('input', handleSearchInput);

  renderLoading();

  try {
    cachedData = await loadData();
    divisionStats = computeDivisionStats(cachedData.providers);
    renderDivisionCards(divisionStats);
  } catch (err) {
    console.error('[insights]', err);
    renderError('Failed to load provider data.');
  }
}

// ─── Tab navigation ──────────────────────────────────────────────────────────

function initTabNav() {
  const tabs = document.querySelectorAll('.sidebar-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.view;

      tabs.forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.sidebar-view').forEach(v => {
        v.classList.remove('active');
        v.setAttribute('aria-hidden', 'true');
      });

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const view = document.getElementById(targetId);
      view.classList.add('active');
      view.removeAttribute('aria-hidden');
    });
  });
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadData() {
  const res = await fetch('/data/bsp-stats.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Stats computation ───────────────────────────────────────────────────────

function computeDivisionStats(providers) {
  const stats = new Map();

  for (const [divName, divStates] of Object.entries(CENSUS_DIVISIONS)) {
    const divSet = new Set(divStates);
    const inDiv = providers.filter(p => p.states.some(s => divSet.has(s)));

    const ratings = inDiv.map(p => p.googleRating).filter(r => r != null);
    const prices  = inDiv.map(p => p.medianMonthlyPriceUsd).filter(v => v != null);

    stats.set(divName, {
      count: inDiv.length,
      avgRating:   ratings.length ? avg(ratings) : null,
      medianPrice: prices.length  ? median(prices) : null,
    });
  }

  return stats;
}

function avg(arr) {
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function providerDivisions(provider) {
  return Object.entries(CENSUS_DIVISIONS)
    .filter(([, states]) => provider.states.some(s => states.includes(s)))
    .map(([name]) => name);
}

// ─── Provider selection ───────────────────────────────────────────────────────

function selectProvider(provider) {
  insightsSearchResults.innerHTML = '';
  insightsSearchResults.classList.remove('visible');
  insightsSearch.value = '';

  if (selectedProviders.has(provider.name)) return; // already selected

  selectedProviders.set(provider.name, provider);
  renderChips();
  renderComparison();
}

function deselectProvider(name) {
  selectedProviders.delete(name);
  renderChips();
  if (selectedProviders.size === 0) {
    renderDivisionCards(divisionStats);
  } else {
    renderComparison();
  }
}

function clearAllProviders() {
  selectedProviders.clear();
  insightsSearch.value = '';
  insightsSearchResults.innerHTML = '';
  insightsSearchResults.classList.remove('visible');
  renderChips();
  renderDivisionCards(divisionStats);
}

// ─── Rendering: chips ─────────────────────────────────────────────────────────

function renderChips() {
  if (!insightsChips) return;

  if (selectedProviders.size === 0) {
    insightsChips.innerHTML = '';
    insightsChips.hidden = true;
    return;
  }

  insightsChips.hidden = false;
  insightsChips.innerHTML = [...selectedProviders.keys()].map(name => `
    <span class="insights-chip">
      <span class="insights-chip-label">${escapeHtml(name)}</span>
      <button class="insights-chip-remove" data-name="${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">✕</button>
    </span>
  `).join('') + (selectedProviders.size > 1
    ? `<button class="insights-chips-clear">Clear all</button>`
    : '');

  insightsChips.querySelectorAll('.insights-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => deselectProvider(btn.dataset.name));
  });
  insightsChips.querySelector('.insights-chips-clear')?.addEventListener('click', clearAllProviders);
}

// ─── Rendering: comparison view ───────────────────────────────────────────────

function renderComparison() {
  insightsBody.innerHTML = '';

  const providers = [...selectedProviders.values()]
    .sort((a, b) => (b.googleRating ?? 0) - (a.googleRating ?? 0));

  const card = document.createElement('div');
  card.className = 'insights-comparison-card';

  card.innerHTML = `
    <div class="insights-comparison-header">
      <span class="insights-comparison-title">Google Ratings</span>
      <span class="insights-comparison-hint">Sorted highest → lowest</span>
    </div>
    <div class="insights-comparison-list">
      ${providers.map((p, i) => {
        const ratingColor = ratingToColor(p.googleRating);
        return `
          <div class="insights-comparison-row">
            <span class="insights-comparison-rank">${i + 1}</span>
            <div class="insights-comparison-icon">${escapeHtml(p.name.charAt(0).toUpperCase())}</div>
            <div class="insights-comparison-info">
              <span class="insights-comparison-name">${escapeHtml(p.name)}</span>
              ${p.medianMonthlyPriceUsd != null
                ? `<span class="insights-comparison-price">$${p.medianMonthlyPriceUsd}/mo</span>`
                : ''}
            </div>
            <div class="insights-comparison-rating">
              ${p.googleRating != null ? `
                <span class="insights-comparison-stars" style="color:${ratingColor}">${renderStars(p.googleRating)}</span>
                <span class="insights-comparison-num" style="color:${ratingColor}">${p.googleRating.toFixed(1)}</span>
              ` : `<span class="insights-stat-unavailable">N/A</span>`}
            </div>
          </div>
          ${p.googleRating != null ? `
            <div class="insights-rating-bar-track">
              <div class="insights-rating-bar-fill" style="width:${(p.googleRating / 5) * 100}%;background:${ratingColor}"></div>
            </div>
          ` : ''}
        `;
      }).join('')}
    </div>
  `;

  insightsBody.appendChild(card);
}

function ratingToColor(rating) {
  if (rating == null) return 'var(--text-muted)';
  if (rating >= 4.0) return '#10b981'; // green
  if (rating >= 3.0) return '#f59e0b'; // amber
  if (rating >= 2.0) return '#f97316'; // orange
  return '#ef4444';                    // red
}

// ─── Rendering: division cards ────────────────────────────────────────────────

function renderDivisionCards(stats) {
  insightsBody.innerHTML = '';

  for (const [divName, s] of stats) {
    const card = document.createElement('div');
    card.className = 'insights-division-card';
    card.innerHTML = `
      <div class="insights-division-header">
        <span class="insights-division-name">${escapeHtml(divName)}</span>
        <span class="insights-division-count">${s.count} provider${s.count !== 1 ? 's' : ''}</span>
      </div>
      <div class="insights-stats-row">
        <div class="insights-stat">
          <span class="insights-stat-label">Avg Google Rating</span>
          <div class="insights-stat-value">
            ${s.avgRating != null
              ? `<span class="insights-rating-stars" aria-hidden="true">${renderStars(s.avgRating)}</span>
                 <span class="insights-rating-number">${s.avgRating.toFixed(1)}</span>`
              : `<span class="insights-stat-unavailable">N/A</span>`}
          </div>
        </div>
        <div class="insights-stat">
          <span class="insights-stat-label">Median Price / mo</span>
          <div class="insights-stat-value">
            ${s.medianPrice != null
              ? `<span>$${s.medianPrice}</span>`
              : `<span class="insights-stat-unavailable">N/A</span>`}
          </div>
        </div>
      </div>
    `;
    insightsBody.appendChild(card);
  }
}

// ─── Rendering: loading / error ───────────────────────────────────────────────

function renderLoading() {
  insightsBody.innerHTML = Array.from({ length: 4 }, () => `
    <div class="insights-skeleton-card">
      <div class="insights-skeleton-line skeleton" style="width:55%"></div>
      <div class="insights-stats-row" style="margin-top:8px">
        <div class="insights-skeleton-value skeleton"></div>
        <div class="insights-skeleton-value skeleton"></div>
      </div>
    </div>
  `).join('');
}

function renderError(msg) {
  insightsBody.innerHTML = `
    <div class="empty-state">
      <p class="empty-title">Unable to load data</p>
      <p class="empty-desc">${escapeHtml(msg)}</p>
    </div>
  `;
}

// ─── Search ───────────────────────────────────────────────────────────────────

function handleSearchInput() {
  const q = insightsSearch.value.trim();
  clearTimeout(searchTimeout);

  if (q.length < 2) {
    insightsSearchResults.innerHTML = '';
    insightsSearchResults.classList.remove('visible');
    return;
  }

  searchTimeout = setTimeout(() => showSearchResults(q), 200);
}

function showSearchResults(query) {
  const lower = query.toLowerCase();
  const matches = cachedData.providers.filter(p =>
    p.name.toLowerCase().includes(lower) && !selectedProviders.has(p.name)
  );

  insightsSearchResults.innerHTML = '';

  if (!matches.length) {
    const msg = cachedData.providers.some(p => p.name.toLowerCase().includes(lower))
      ? `<div class="search-no-results">All matching providers are already selected.</div>`
      : `<div class="search-no-results">No providers found for "${escapeHtml(query)}"</div>`;
    insightsSearchResults.innerHTML = msg;
    insightsSearchResults.classList.add('visible');
    return;
  }

  for (const p of matches) {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.setAttribute('role', 'option');
    item.setAttribute('tabindex', '0');

    const ratingStr = p.googleRating != null
      ? `<span class="result-rating" style="color:${ratingToColor(p.googleRating)}">★ ${p.googleRating.toFixed(1)}</span>`
      : '';

    item.innerHTML = `
      <span class="result-name">${highlightMatch(p.name, query)}</span>
      ${ratingStr}
    `;
    item.addEventListener('click', () => selectProvider(p));
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') selectProvider(p);
    });
    insightsSearchResults.appendChild(item);
  }

  insightsSearchResults.classList.add('visible');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderStars(rating) {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

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
