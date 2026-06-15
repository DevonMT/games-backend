/**
 * Steam routes.
 *
 *   GET /steam/library      -> cached owned-games list (1h TTL)
 *   POST /steam/library/refresh -> force a re-fetch, bypassing cache
 *   GET /steam/sync-status  -> when the library cache was last populated
 *
 * The 1-hour cache (Risk 1 mitigation) protects us from Steam's soft rate
 * limits and keeps dashboard loads fast even with a large library.
 */

import { Hono } from 'hono';
import { cache } from '../lib/cache.js';
import { fetchSteamLibrary, SteamApiError, type SteamLibrary } from '../lib/steam.js';

const CACHE_KEY = 'steam:library';
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour
const STEAM_TIMEOUT_MS = 30_000; // large libraries can be slow

export const steamRoutes = new Hono();

/** Wraps fetchSteamLibrary with an abort-based timeout. */
async function loadLibrary(): Promise<SteamLibrary> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEAM_TIMEOUT_MS);
  try {
    return await fetchSteamLibrary(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function handleError(err: unknown) {
  if (err instanceof SteamApiError) {
    return { status: err.status, body: { error: err.message } };
  }
  return {
    status: 500,
    body: { error: `Unexpected error: ${(err as Error).message}` },
  };
}

steamRoutes.get('/library', async (c) => {
  try {
    const library = await cache.getOrLoad(CACHE_KEY, CACHE_TTL_SECONDS, loadLibrary);
    const meta = cache.ageMeta(CACHE_KEY);
    return c.json({
      ...library,
      cache: {
        cached: true,
        // expiresAt - ttl gives the write time; expose both for the UI badge.
        expiresAt: meta ? new Date(meta.expiresAt).toISOString() : null,
      },
    });
  } catch (err) {
    const { status, body } = handleError(err);
    return c.json(body, status as 400);
  }
});

steamRoutes.post('/library/refresh', async (c) => {
  try {
    const library = await loadLibrary();
    cache.set(CACHE_KEY, library, CACHE_TTL_SECONDS);
    return c.json({ ...library, cache: { cached: false } });
  } catch (err) {
    const { status, body } = handleError(err);
    return c.json(body, status as 400);
  }
});

steamRoutes.get('/sync-status', (c) => {
  const meta = cache.ageMeta(CACHE_KEY);
  const lastSync = meta
    ? new Date(meta.expiresAt - CACHE_TTL_SECONDS * 1000).toISOString()
    : null;
  return c.json({
    lastSteamSync: lastSync,
    stale: lastSync === null,
    ttlSeconds: CACHE_TTL_SECONDS,
  });
});
