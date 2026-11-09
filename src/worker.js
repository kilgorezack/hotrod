/**
 * Cloudflare Workers entry point — also the shared Hono app for all environments.
 *
 * For Cloudflare Workers (production):  wrangler deploy
 * For local dev:                         vite (via @cloudflare/vite-plugin + Miniflare)
 * For standalone Node.js:                server/index.js (uses @hono/node-server)
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import providersRouter, { resolveProviderSearch, resolveProviderTechnologies } from '../server/routes/providers.js';
import coverageRouter      from '../server/routes/coverage.js';
import hexAggRouter        from '../server/routes/hexAgg.js';
import geoRouter           from '../server/routes/geo.js';
import tilesRouter         from '../server/routes/tiles.js';
import areaProvidersRouter from '../server/routes/areaProviders.js';
import { getAllCounties } from '../server/services/counties.js';
import { getMapkitToken }  from '../server/services/mapkitToken.js';

const app = new Hono();

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use('*', cors({
  origin: (origin) => origin || '*',
}));

// ── API Routes ────────────────────────────────────────────────────────────────

app.route('/api/providers',       providersRouter);
app.route('/api/coverage/hex',    hexAggRouter);       // must come BEFORE /api/coverage
app.route('/api/coverage',        coverageRouter);
app.route('/api/geo',             geoRouter);
app.route('/api/tiles',           tilesRouter);
app.route('/api/area-providers',  areaProvidersRouter);

// Fresh, short-lived MapKit JS token (avoids shipping an expiring build-time JWT)
app.get('/api/mapkit-token', async (c) => {
  try {
    const origin = c.req.header('origin') || '';
    const token = await getMapkitToken(c.env, origin);
    if (!token) return c.json({ error: 'MapKit signing key not configured' }, 503);
    c.header('Cache-Control', 'no-store');
    return c.text(token);
  } catch (err) {
    console.error('[mapkit-token]', err.message);
    return c.json({ error: 'Failed to sign MapKit token', detail: err.message }, 500);
  }
});

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Flat aliases for platforms that only route one segment under /api/*
app.get('/api/providers-search', async (c) => {
  const q = String(c.req.query('q') || '').trim();
  if (!q || q.length < 2) return c.json({ providers: [] });
  const limit = Math.min(parseInt(c.req.query('limit')) || 20, 50);
  try {
    const providers = await resolveProviderSearch(q, limit);
    return c.json({ providers });
  } catch (err) {
    console.error('[providers-search]', err.message);
    return c.json({ error: 'Failed to reach FCC data source', detail: err.message }, 502);
  }
});

app.get('/api/providers-technologies', async (c) => {
  const providerId   = String(c.req.query('provider_id')   || '').trim();
  const providerName = String(c.req.query('provider_name') || '').trim();
  if (!providerId) return c.json({ error: 'Provider ID required' }, 400);
  try {
    const data = await resolveProviderTechnologies(providerId, providerName);
    return c.json(data);
  } catch (err) {
    console.error('[providers-technologies]', err.message);
    return c.json({ error: 'Failed to reach FCC data source', detail: err.message }, 502);
  }
});

app.get('/api/geo-counties', async (c) => {
  try {
    const geojson = await getAllCounties();
    c.header('Cache-Control', 'public, max-age=86400');
    return c.json(geojson);
  } catch (err) {
    console.error('[geo-counties]', err.message);
    return c.json({ error: 'Failed to load county boundaries', detail: err.message }, 502);
  }
});

// Catch-all: unknown /api/* routes return JSON 404 instead of falling through
app.all('/api/*', (c) => c.json({ error: 'API route not found' }, 404));

export default app;
