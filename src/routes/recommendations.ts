/**
 * Recommendations route (Claude-backed).
 *
 *   POST /recommendations
 *     body: { gameIds: number[] }   // rawg_ids from the /releases response
 *     -> { recommendations: [{ gameId, gameName, confidenceScore, reasoning, cachedAt }] }
 *
 * Flow:
 *   1. Validate gameIds (non-empty, <= 50, all numbers).
 *   2. Resolve rawgIds to stored games_table rows (recommendations key on the
 *      internal id, and we need name/description for the prompt anyway). Unknown
 *      rawgIds — games we've never stored via /releases — are reported back so
 *      the caller knows to fetch them first.
 *   3. Read fresh (non-expired) recommendations from SQLite — cache hits.
 *   4. Score only the cache misses via claude.ts (one batched API call).
 *   5. Persist the fresh scores with expiresAt = now + 30 days.
 *   6. Return cached + fresh combined.
 *
 * Gated behind requireApiSecret (wired in app.ts).
 */

import { Hono } from 'hono';
import {
  getGamesByRawgIds,
  getFreshRecommendations,
  saveRecommendations,
  upsertGame,
  type GameRow,
  type RecommendationUpsert,
} from '../lib/db.js';
import {
  scoreRecommendations,
  discoverRecommendations,
  lookupGame,
  ClaudeApiError,
  type UserPreferences,
} from '../lib/claude.js';
import { fetchGameById } from '../lib/rawg.js';

const MAX_GAME_IDS = 50;
const TTL_DAYS = 30;

export const recommendationsRoutes = new Hono();

/** A single recommendation in the response shape. */
interface ResponseRec {
  gameId: number; // rawgId — what the caller sent in
  gameName: string;
  confidenceScore: number;
  reasoning: string;
  cachedAt: string; // ISO timestamp the recommendation was generated
}

function expiryFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

recommendationsRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const rawIds = (body as { gameIds?: unknown; preferences?: unknown })?.gameIds;
  const rawPrefs = (body as { preferences?: unknown })?.preferences;
  const preferences: UserPreferences | undefined =
    rawPrefs && typeof rawPrefs === 'object' ? (rawPrefs as UserPreferences) : undefined;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return c.json({ error: '`gameIds` must be a non-empty array.' }, 400);
  }
  if (rawIds.length > MAX_GAME_IDS) {
    return c.json(
      { error: `\`gameIds\` may contain at most ${MAX_GAME_IDS} ids.` },
      400,
    );
  }
  if (!rawIds.every((n) => typeof n === 'number' && Number.isInteger(n))) {
    return c.json({ error: '`gameIds` must contain only integers.' }, 400);
  }

  // De-dupe while preserving the set of requested rawgIds.
  const requestedRawgIds = [...new Set(rawIds as number[])];

  // Resolve to stored rows, fetching any unknowns from RAWG on demand.
  let games = getGamesByRawgIds(requestedRawgIds);
  const foundIds = new Set(games.map((g) => g.rawgId));
  const unknownRawgIds = requestedRawgIds.filter((id) => !foundIds.has(id));

  if (unknownRawgIds.length > 0) {
    const fetched = await Promise.all(
      unknownRawgIds.map((id) => fetchGameById(id)),
    );
    for (const release of fetched) {
      if (!release) continue;
      try {
        const row = upsertGame({
          rawgId: release.rawgId,
          name: release.name,
          category: release.category,
          releaseDate: release.releaseDate,
          platforms: release.platforms,
          metacriticScore: release.metacriticScore,
          description: release.description,
          avgPlaytimeHours: release.avgPlaytimeHours,
        });
        games = [...games, row];
      } catch {
        // Non-fatal: skip games we couldn't store.
      }
    }
  }

  if (games.length === 0) {
    return c.json(
      { recommendations: [], warning: 'Could not retrieve game data for scoring.' },
      200,
    );
  }

  // Cache read: fresh recommendations keyed by internal game id.
  const internalIds = games.map((g) => g.id);
  const cached = getFreshRecommendations(internalIds);
  const cachedByGameId = new Map(cached.map((r) => [r.gameId, r]));

  // Cache misses: stored games without a fresh recommendation row.
  const misses = games.filter((g) => !cachedByGameId.has(g.id));

  const responses: ResponseRec[] = [];

  // Emit cached hits.
  for (const rec of cached) {
    responses.push({
      gameId: rec.rawgId,
      gameName: rec.gameName,
      confidenceScore: rec.confidenceScore,
      reasoning: rec.reasoning,
      cachedAt: rec.generatedAt,
    });
  }

  // Score the misses in one batched Claude call, then persist + emit.
  if (misses.length > 0) {
    let fresh;
    try {
      fresh = await scoreRecommendations(misses, preferences);
    } catch (err) {
      if (err instanceof ClaudeApiError) {
        // If we have at least some cached results, degrade gracefully rather
        // than failing the whole request.
        if (responses.length > 0) {
          return c.json({
            recommendations: responses,
            unknownGameIds: unknownRawgIds,
            warning: `Some games could not be scored: ${err.message}`,
          });
        }
        return c.json({ error: err.message }, err.status as 400);
      }
      return c.json(
        { error: `Unexpected error: ${(err as Error).message}` },
        500,
      );
    }

    const generatedAt = new Date().toISOString();
    const expiresAt = expiryFromNow(TTL_DAYS);
    const freshByRawgId = new Map(fresh.map((r) => [r.rawgId, r]));

    const toPersist: RecommendationUpsert[] = [];
    for (const game of misses) {
      const scored = freshByRawgId.get(game.rawgId);
      if (!scored) continue; // model omitted this candidate; skip rather than invent
      toPersist.push({
        gameId: game.id,
        confidenceScore: scored.confidenceScore,
        reasoning: scored.reasoning,
        expiresAt,
      });
      responses.push({
        gameId: game.rawgId,
        gameName: game.name,
        confidenceScore: scored.confidenceScore,
        reasoning: scored.reasoning,
        cachedAt: generatedAt,
      });
    }

    saveRecommendations(toPersist);
  }

  return c.json({
    recommendations: responses,
    ...(unknownRawgIds.length ? { unknownGameIds: unknownRawgIds } : {}),
  });
});

// ── POST /recommendations/discover ───────────────────────────────────────────

recommendationsRoutes.post('/discover', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { body = {}; }

  const b = body as Record<string, unknown>;
  const platforms = Array.isArray(b.platforms) ? (b.platforms as string[]) : [];
  const genres    = Array.isArray(b.genres)    ? (b.genres    as string[]) : [];
  const limit     = Math.max(1, Math.min(12, typeof b.limit === 'number' ? b.limit : 8));
  const preferences = b.preferences && typeof b.preferences === 'object'
    ? (b.preferences as UserPreferences)
    : undefined;

  try {
    const picks = await discoverRecommendations({ platforms, genres, limit }, preferences);
    return c.json({ picks });
  } catch (err) {
    if (err instanceof ClaudeApiError) return c.json({ error: err.message }, err.status as 400);
    return c.json({ error: `Unexpected error: ${(err as Error).message}` }, 500);
  }
});

// ── POST /recommendations/lookup ─────────────────────────────────────────────

recommendationsRoutes.post('/lookup', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const b = body as Record<string, unknown>;
  const query = typeof b.query === 'string' ? b.query.trim() : '';
  if (!query) return c.json({ error: '`query` is required.' }, 400);

  const preferences = b.preferences && typeof b.preferences === 'object'
    ? (b.preferences as UserPreferences)
    : undefined;

  try {
    const results = await lookupGame(query, preferences);
    return c.json({ results });
  } catch (err) {
    if (err instanceof ClaudeApiError) return c.json({ error: err.message }, err.status as 400);
    return c.json({ error: `Unexpected error: ${(err as Error).message}` }, 500);
  }
});

export default recommendationsRoutes;
