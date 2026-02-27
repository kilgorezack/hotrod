import { API_BASE } from '../config.js';

/**
 * Search FCC providers by name.
 * @param {string} query
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function searchProviders(query) {
  const url = `${API_BASE}/providers-search?q=${encodeURIComponent(query)}&limit=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Provider search failed: ${res.status}`);
  const data = await res.json();
  return data.providers || [];
}

/**
 * Get available technology codes for a provider.
 * @param {string} providerId
 * @returns {Promise<string[]>}
 */
export async function getProviderTechnologies(providerId) {
  const url = `${API_BASE}/providers-technologies?provider_id=${encodeURIComponent(providerId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Technology fetch failed: ${res.status}`);
  const data = await res.json();
  return data.technologies || [];
}
