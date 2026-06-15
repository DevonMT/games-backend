/**
 * Vercel serverless entry point.
 *
 * Vercel routes all traffic here via vercel.json's rewrite. Hono ships a
 * Vercel-compatible handler adapter, so we just hand it the same app the Node
 * server uses. Env vars come from Vercel's project settings (not .env).
 */

import { handle } from 'hono/vercel';
import { createApp } from '../src/app.js';

export const config = { runtime: 'nodejs' };

const app = createApp();

export default handle(app);
