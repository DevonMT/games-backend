/**
 * Node entry point (local dev + Railway / any long-running host).
 *
 * Loads .env via Node's built-in --env-file flag when present, then serves the
 * Hono app over HTTP. For Vercel, api/index.ts is used instead.
 */

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { intEnv } from './lib/env.js';

const port = intEnv('PORT', 8787);
const app = createApp();

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`games-backend listening on http://localhost:${info.port}`);
  console.log(`  health:        GET  /health`);
  console.log(`  steam library: GET  /steam/library        (x-api-secret)`);
  console.log(`  force refresh: POST /steam/library/refresh (x-api-secret)`);
  console.log(`  sync status:   GET  /steam/sync-status     (x-api-secret)`);
});
