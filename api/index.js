/**
 * Vercel serverless entry point.
 * Uses @hono/node-server's toNodeHandler to adapt the Hono app
 * to Vercel's Node.js serverless function format.
 */
import { toNodeHandler } from '@hono/node-server';
import app from '../src/worker.js';

export default toNodeHandler(app);
