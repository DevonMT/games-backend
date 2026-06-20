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
import { scoreBacklog, ClaudeApiError, type UserPreferences } from '../lib/claude.js';

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

/**
 * GET /steam/backlog-picks
 *
 * Looks at the user's Steam library, filters to games they've barely touched,
 * and asks Claude to rank the ones they're most likely to enjoy.
 *
 * Query params:
 *   threshold  Max hours played to be considered "unplayed" (default: 5)
 *   limit      How many picks to return (default: 5, max: 10)
 */
steamRoutes.post('/backlog-picks', async (c) => {
  const threshold = Math.max(0, parseFloat(c.req.query('threshold') ?? '5') || 5);
  const limit = Math.max(1, Math.min(10, parseInt(c.req.query('limit') ?? '5', 10) || 5));
  const excludeParam = c.req.query('exclude') ?? '';
  const excludedAppIds = new Set(
    excludeParam.split(',').map(Number).filter((n) => n > 0 && Number.isFinite(n)),
  );

  let preferences: UserPreferences | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    const rawPrefs = (body as { preferences?: unknown })?.preferences;
    if (rawPrefs && typeof rawPrefs === 'object') preferences = rawPrefs as UserPreferences;
  } catch { /* no body — fine */ }

  let library: SteamLibrary;
  try {
    library = await cache.getOrLoad(CACHE_KEY, CACHE_TTL_SECONDS, loadLibrary);
  } catch (err) {
    const { status, body } = handleError(err);
    return c.json(body, status as 400);
  }

  // Sort ascending so least-played (most "unstarted") games come first.
  // The Steam library arrives sorted descending by hoursPlayed, so without
  // this re-sort the cap would chop off the 0h games when the pool is large.
  const candidates = library.games
    .filter((g) => g.hoursPlayed < threshold && !excludedAppIds.has(g.appId))
    .sort((a, b) => a.hoursPlayed - b.hoursPlayed);

  if (candidates.length === 0) {
    return c.json({
      picks: [],
      warning: `No games found with fewer than ${threshold} hours played.`,
    });
  }

  // Cap candidate list so the prompt stays reasonable.
  const capped = candidates.length > 120 ? candidates.slice(0, 120) : candidates;

  try {
    const picks = await scoreBacklog(capped, limit, preferences);
    return c.json({ picks, candidateCount: candidates.length, threshold });
  } catch (err) {
    if (err instanceof ClaudeApiError) {
      return c.json({ error: err.message }, err.status as 400);
    }
    return c.json({ error: `Unexpected error: ${(err as Error).message}` }, 500);
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
