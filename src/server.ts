/**
 * Node entry point (local dev + Railway / any long-running host).
 *
 * Loads .env via Node's built-in --env-file flag when present, then serves the
 * Hono app over HTTP. For Vercel, api/index.ts is used instead.
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';
import { intEnv, optionalEnv } from './lib/env.js';
import { accessConfigured } from './middleware/access.js';

const port = intEnv('PORT', 8787);
const app = createApp();

// Optionally serve a built front end from this same origin. Same-origin is what
// lets the Cloudflare Access cookie cover the API calls the pages make - a page
// on another domain cannot complete Access's interactive login from fetch().
// Registered after createApp() so these routes take precedence over its
// JSON 404 handler.
const staticDir = optionalEnv('STATIC_DIR');
if (staticDir) {
  app.use('/*', serveStatic({ root: staticDir }));
  app.get('*', serveStatic({ path: `${staticDir}/index.html` }));
}

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`games-backend listening on http://localhost:${info.port}`);
  console.log(`  health:        GET  /health`);
  const door = accessConfigured() ? 'Access' : 'x-api-secret';
  console.log(`  steam library: GET  /steam/library        (${door})`);
  console.log(`  force refresh: POST /steam/library/refresh (${door})`);
  console.log(`  sync status:   GET  /steam/sync-status     (${door})`);
  console.log(`  auth:          ${accessConfigured() ? 'Cloudflare Access' : 'shared secret only'}`);
  console.log(`  static:        ${staticDir ?? 'disabled (API only)'}`);
});
