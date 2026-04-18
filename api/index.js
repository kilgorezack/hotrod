/**
 * Vercel serverless entry point.
 * Uses @hono/node-server's toNodeHandler to adapt the Hono app
 * to Vercel's Node.js serverless function format.
 */
import { handle } from '@hono/node-server/vercel';
import app from '../src/worker.js';

export default handle(app);
