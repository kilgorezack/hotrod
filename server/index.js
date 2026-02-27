/**
 * Local development / standalone production server.
 * Imports the shared Express app and starts listening.
 * On Vercel, api/index.js is used instead — this file is not invoked.
 */
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import app from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// In standalone production mode, serve the Vite build from dist/
if (isProd) {
  const distDir = path.join(__dirname, '..', 'dist');
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`\n🚀 HOTROD API server running on http://localhost:${PORT}`);
  console.log(`   Environment: ${isProd ? 'production' : 'development'}`);
  if (!process.env.MAPKIT_TOKEN) {
    console.warn('   ⚠️  MAPKIT_TOKEN not set — map will not render. See .env.example');
  }
});
