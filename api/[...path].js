/**
 * Vercel catch-all serverless entry point.
 *
 * This ensures requests like `/api/providers/search` reach the shared Express app
 * with the original URL intact (no `vercel.json` rewrites that drop the path).
 */
import { toNodeHandler } from '@hono/node-server';
import app from '../src/worker.js';

export default toNodeHandler(app);
