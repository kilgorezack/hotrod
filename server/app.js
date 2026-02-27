/**
 * Express application — shared between the local dev server and the
 * Vercel serverless function.  No app.listen() here; that lives in
 * server/index.js (local) and api/index.js (Vercel).
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import providersRouter from './routes/providers.js';
import coverageRouter  from './routes/coverage.js';
import geoRouter       from './routes/geo.js';
import tilesRouter     from './routes/tiles.js';

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

// ── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
