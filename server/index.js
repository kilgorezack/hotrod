import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import providersRouter from './routes/providers.js';
import coverageRouter from './routes/coverage.js';
import geoRouter from './routes/geo.js';
import tilesRouter from './routes/tiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

const app = express();

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: isProd
    ? process.env.ALLOWED_ORIGIN || true
    : ['http://localhost:5173', 'http://127.0.0.1:5173'],
}));
app.use(express.json());

// Request logger in development
if (!isProd) {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ── API Routes ───────────────────────────────────────────────────────────────

app.use('/api/providers', providersRouter);
app.use('/api/coverage', coverageRouter);
app.use('/api/geo', geoRouter);
app.use('/api/tiles', tilesRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Production: Serve Vite build ─────────────────────────────────────────────

if (isProd) {
  const { readFile } = await import('fs/promises');
  const distDir = path.join(__dirname, '..', 'dist');
  app.use(express.static(distDir));

  // Inject MapKit token into index.html at request time
  app.get('*', async (_req, res) => {
    const indexPath = path.join(distDir, 'index.html');
    try {
      let html = await readFile(indexPath, 'utf8');
      html = html.replace(
        '__MAPKIT_TOKEN__',
        JSON.stringify(process.env.MAPKIT_TOKEN || '').slice(1, -1) // strip outer quotes
      );
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch {
      res.sendFile(indexPath);
    }
  });
}

// ── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 HOTROD API server running on http://localhost:${PORT}`);
  console.log(`   Environment: ${isProd ? 'production' : 'development'}`);
  if (!process.env.MAPKIT_TOKEN) {
    console.warn('   ⚠️  MAPKIT_TOKEN not set — map will not render. See .env.example');
  }
});
