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
import { requireIdentity } from './middleware/auth.js';
import { steamRoutes } from './routes/steam.js';
import { releasesRoutes } from './routes/releases.js';
import { recommendationsRoutes } from './routes/recommendations.js';
import { preferencesRoutes } from './routes/preferences.js';
import { learnRoutes } from './routes/learn.js';

/**
 * Two apps, one process.
 *
 * Backlog and Stacks are separate rows in the platform with separate grants,
 * so somebody can hold Stacks and not Backlog. They still share this container,
 * which means the grant is only real if the process refuses paths belonging to
 * the app the request is NOT for — otherwise a Stacks-only person reaches
 * stacks.devondoes.dev/releases and reads the games data anyway.
 *
 * The keys are platform slugs; the values are URL paths. They match today and
 * need not: a rename changes what the app is called, not where its API lives.
 *
 * Paths are listed per owner rather than inferred, because getting this wrong
 * fails open. Anything not claimed here — /health, /_astro, favicons — is
 * shared and served to both.
 */
const OWNED: Record<string, string[]> = {
  backlog: ['/steam', '/releases', '/recommendations', '/preferences', '/backlog'],
  stacks: ['/learn', '/stacks'],
};

/**
 * Which app this request is for.
 *
 * X-Platform-App is set unconditionally by the gateway from its own server
 * block, so a client cannot choose it. Host is the fallback and is nearly as
 * good — nginx picked the block by it — but only the header survives a block
 * that ever serves more than one name.
 *
 * Neither present means nobody is in front of us: local development, or a
 * direct hit on the container. Returns null, and the guard lets everything
 * through, because refusing here would make `npm run dev` unable to open half
 * the app while adding nothing — in production the gateway is the only route
 * in, and it always sets the header.
 */
function appFor(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const explicit = c.req.header('x-platform-app');
  if (explicit && explicit in OWNED) return explicit;
  const host = (c.req.header('host') ?? '').split(':')[0] ?? '';
  for (const slug of Object.keys(OWNED)) {
    if (host.startsWith(`${slug}.`)) return slug;
  }
  return null;
}

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', logger());

  // Before anything else, including the static files registered by the server
  // entry point: a page belonging to the other app is as much a leak as its API.
  app.use('*', async (c, next) => {
    const mine = appFor(c);
    if (mine) {
      const path = new URL(c.req.url).pathname;
      const theirs = Object.entries(OWNED)
        .filter(([slug]) => slug !== mine)
        .flatMap(([, paths]) => paths);
      if (theirs.some((p) => path === p || path.startsWith(`${p}/`))) {
        return c.json({ error: 'Not found.' }, 404);
      }
    }
    await next();
  });

  const origins = allowedOrigins();
  app.use(
    '*',
    cors({
      origin: (origin) => (origins.includes(origin) ? origin : origins[0] ?? ''),
      allowHeaders: ['Content-Type'],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      maxAge: 86_400,
    }),
  );

  // Public liveness probe — used by Vercel/Railway uptime checks (Task 6).
  app.get('/health', (c) =>
    c.json({ status: 'ok', service: 'games-backend', time: new Date().toISOString() }),
  );

  // Everything below the health check requires the shared secret.
  app.use('/steam/*', requireIdentity);
  app.route('/steam', steamRoutes);

  app.use('/releases', requireIdentity);
  app.use('/releases/*', requireIdentity);
  app.route('/releases', releasesRoutes);

  app.use('/recommendations', requireIdentity);
  app.use('/recommendations/*', requireIdentity);
  app.route('/recommendations', recommendationsRoutes);

  app.use('/preferences', requireIdentity);
  app.use('/preferences/*', requireIdentity);
  app.route('/preferences', preferencesRoutes);

  app.use('/learn/*', requireIdentity);
  app.route('/learn', learnRoutes);

  app.notFound((c) => c.json({ error: 'Not found.' }, 404));
  app.onError((err, c) => {
    console.error('[unhandled]', err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  return app;
}
