/**
 * Express application — shared between the local dev server and the
 * Vercel serverless function.  No app.listen() here; that lives in
 * server/index.js (local) and api/index.js (Vercel).
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import providersRouter, { resolveProviderSearch, resolveProviderTechnologies } from './routes/providers.js';
import coverageRouter  from './routes/coverage.js';
import geoRouter       from './routes/geo.js';
import tilesRouter, { proxyFccTile } from './routes/tiles.js';
import { getAllCounties } from './services/counties.js';

const isProd = process.env.NODE_ENV === 'production';

const app = express();

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: isProd
    ? process.env.ALLOWED_ORIGIN || true
    : ['http://localhost:5173', 'http://127.0.0.1:5173'],
}));

app.use(express.json());

if (!isProd) {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ── API Routes ───────────────────────────────────────────────────────────────

app.use('/api/providers', providersRouter);
app.use('/api/coverage',  coverageRouter);
app.use('/api/geo',       geoRouter);
app.use('/api/tiles',     tilesRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Flat aliases for production platforms that only route one path segment
// under /api/*. Existing nested routes remain available.
app.get('/api/providers-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ providers: [] });

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  try {
    const providers = await resolveProviderSearch(q, limit);
    res.json({ providers });
  } catch (err) {
    console.error('[providers-search]', err.message);
    res.status(502).json({ error: 'Failed to reach FCC data source', detail: err.message });
  }
});

app.get('/api/providers-technologies', async (req, res) => {
  const providerId = String(req.query.provider_id || '').trim();
  if (!providerId) return res.status(400).json({ error: 'Provider ID required' });

  try {
    const data = await resolveProviderTechnologies(providerId);
    res.json(data);
  } catch (err) {
    console.error('[providers-technologies]', err.message);
    res.status(502).json({ error: 'Failed to reach FCC data source', detail: err.message });
  }
});

app.get('/api/geo-counties', async (_req, res) => {
  try {
    const geojson = await getAllCounties();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json(geojson);
  } catch (err) {
    console.error('[geo-counties]', err.message);
    res.status(502).json({ error: 'Failed to load county boundaries', detail: err.message });
  }
});

app.get('/api/tiles-fcc', async (req, res) => {
  const providerId = String(req.query.provider_id || '').trim();
  const techCode = String(req.query.tech_code || '').trim();
  const z = String(req.query.z || '').trim();
  const x = String(req.query.x || '').trim();
  const y = String(req.query.y || '').trim();

  if (!providerId || !techCode || !z || !x || !y) {
    return res.status(400).json({ error: 'provider_id, tech_code, z, x, y are required' });
  }

  await proxyFccTile(res, { providerId, techCode, z, x, y });
});

// ── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
