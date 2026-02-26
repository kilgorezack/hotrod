const container = document.getElementById('toast-container');

const ICONS = {
  success: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  error:   `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  info:    `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 4v4M5 2.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
};

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 * @param {number} duration — ms before auto-dismiss (0 = persistent)
 */
export function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${ICONS[type] || ICONS.info}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }

  return toast;
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('dismissing');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
