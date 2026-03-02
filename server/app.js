/**
 * Shared Hono application — re-exports src/worker.js for backward compatibility.
 * On Cloudflare Workers, src/worker.js is used directly.
 * For Vercel (api/index.js) and local standalone (server/index.js), this file is imported.
 */
import app from '../src/worker.js';
export default app;
