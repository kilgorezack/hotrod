/**
 * Local development / standalone production server.
 * Uses @hono/node-server to run the Hono app on Node.js.
 * On Cloudflare Workers, src/worker.js is used directly (not this file).
 */
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import app from '../src/worker.js';

const PORT = parseInt(process.env.PORT || '3001');
const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  // Serve static Vite build for standalone production mode
  app.get('*', serveStatic({ root: './dist' }));
}

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`\n HOTROD server on http://localhost:${port}`);
  console.log(`   Environment: ${isProd ? 'production' : 'development'}`);
  if (!process.env.MAPKIT_TOKEN) {
    console.warn('   MAPKIT_TOKEN not set — map will not render. See .env.example');
  }
});
