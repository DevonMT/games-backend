/**
 * Hono application assembly.
 *
 * Kept separate from the server entry points (src/server.ts for Node,
 * api/index.ts for Vercel) so the exact same app runs in every environment.
 *
 * Route map:
 *   GET  /health                 -> liveness probe (no auth)
 *   GET  /steam/library          -> owned games (auth)
 *   POST /steam/library/refresh  -> force re-fetch (auth)
 *   GET  /steam/sync-status      -> last sync time (auth)
 *   GET  /releases               -> RAWG recent/upcoming releases (auth)
 *   POST /recommendations        -> Claude "will I enjoy this?" scores (auth)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { allowedOrigins } from './lib/env.js';
import { requireApiSecret } from './middleware/auth.js';
import { steamRoutes } from './routes/steam.js';
import { releasesRoutes } from './routes/releases.js';
import { recommendationsRoutes } from './routes/recommendations.js';
import { preferencesRoutes } from './routes/preferences.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', logger());

  const origins = allowedOrigins();
  app.use(
    '*',
    cors({
      origin: (origin) => (origins.includes(origin) ? origin : origins[0] ?? ''),
      allowHeaders: ['Content-Type', 'x-api-secret'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 86_400,
    }),
  );

  // Public liveness probe — used by Vercel/Railway uptime checks (Task 6).
  app.get('/health', (c) =>
    c.json({ status: 'ok', service: 'games-backend', time: new Date().toISOString() }),
  );

  // Everything below the health check requires the shared secret.
  app.use('/steam/*', requireApiSecret);
  app.route('/steam', steamRoutes);

  app.use('/releases', requireApiSecret);
  app.use('/releases/*', requireApiSecret);
  app.route('/releases', releasesRoutes);

  app.use('/recommendations', requireApiSecret);
  app.use('/recommendations/*', requireApiSecret);
  app.route('/recommendations', recommendationsRoutes);

  app.use('/preferences', requireApiSecret);
  app.use('/preferences/*', requireApiSecret);
  app.route('/preferences', preferencesRoutes);

  app.notFound((c) => c.json({ error: 'Not found.' }, 404));
  app.onError((err, c) => {
    console.error('[unhandled]', err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  return app;
}
