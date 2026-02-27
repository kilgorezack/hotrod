/**
 * Vercel catch-all serverless entry point.
 *
 * This ensures requests like `/api/providers/search` reach the shared Express app
 * with the original URL intact (no `vercel.json` rewrites that drop the path).
 */
import app from '../server/app.js';

export default app;
