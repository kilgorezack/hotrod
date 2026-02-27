/**
 * Vercel serverless entry point.
 * Vercel routes /api/* here (see vercel.json).
 * The Express app handles all routing internally.
 */
import app from '../server/app.js';

export default app;
