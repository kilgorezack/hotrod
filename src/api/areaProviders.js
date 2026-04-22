/**
 * Client-side fetch wrapper for the area provider search endpoint.
 */

/**
 * @typedef {{ providerId: string, providerName: string, techCodes: string[] }} AreaProvider
 */

/**
 * Find all broadband providers with coverage in a drawn polygon.
 *
 * @param {Array<{latitude: number, longitude: number}>} vertices
 * @returns {Promise<AreaProvider[]>}
 */
export async function fetchAreaProviders(vertices) {
  const res = await fetch('/api/area-providers', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ polygon: vertices }),
    signal:  AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    let message = `Server error ${res.status}`;
    try {
      const err = await res.json();
      if (err.error) message = err.error;
    } catch { /* ignore */ }
    throw new Error(message);
  }

  const data = await res.json();
  if (!Array.isArray(data.providers)) throw new Error('Unexpected response shape');
  return data.providers;
}
