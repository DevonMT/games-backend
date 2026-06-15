/**
 * Releases routes (RAWG-backed).
 *
 *   GET /releases?categories=indie,AAA&since=2025-01-01&until=2025-12-31
 *               &platforms=Steam&page=1
 *     -> a page of recent/upcoming releases for the given filters.
 *
 * Behavior:
 *   - Validates and defaults the date range (defaults to a window around now).
 *   - Fetches the page from RAWG, normalizing genres/tags into our category
 *     enum and enriching with Metacritic score, platforms, and description.
 *   - Caches each (filter, page) tuple for 7 days (Risk 1: stay under RAWG's
 *     rate limit; release data changes slowly).
 *   - Upserts the page into SQLite games_table so cold starts can still serve
 *     known releases even when the in-memory cache is empty.
 *   - On a RAWG outage, falls back to whatever the DB already holds for the
 *     filters rather than failing the dashboard outright.
 *
 * Gated behind requireApiSecret (wired in app.ts).
 */

import { Hono } from 'hono';
import { cache } from '../lib/cache.js';
import { queryGames, upsertGames, type GameRow } from '../lib/db.js';
import {
  CATEGORIES,
  fetchReleases,
  RawgApiError,
  type Category,
  type RawgReleasesPage,
} from '../lib/rawg.js';

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const RAWG_TIMEOUT_MS = 30_000;
const VALID_CATEGORIES = new Set<string>(CATEGORIES);

export const releasesRoutes = new Hono();

/** Parse the comma-separated `categories` param into validated enum values. */
function parseCategories(raw: string | undefined): Category[] {
  if (!raw) return [];
  const out = new Set<Category>();
  for (const part of raw.split(',')) {
    const c = part.trim();
    if (VALID_CATEGORIES.has(c)) out.add(c as Category);
  }
  return [...out];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a YYYY-MM-DD date string, returning it or undefined if malformed. */
function parseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!ISO_DATE.test(trimmed)) return undefined;
  const d = new Date(`${trimmed}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : trimmed;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Default window: 90 days back through 180 days ahead of today. */
function defaultRange(): { since: string; until: string } {
  const now = new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - 90);
  const until = new Date(now);
  until.setUTCDate(until.getUTCDate() + 180);
  return { since: isoDate(since), until: isoDate(until) };
}

/** Deterministic cache key from the normalized filter set. */
function cacheKey(p: {
  categories: Category[];
  since: string;
  until: string;
  platform: string | null;
  page: number;
}): string {
  const cats = [...p.categories].sort().join('+') || 'all';
  return `releases:${cats}:${p.since}:${p.until}:${p.platform ?? 'any'}:${p.page}`;
}

/** Persist a fetched page and return it unchanged. */
function persistPage(page: RawgReleasesPage): void {
  if (page.releases.length === 0) return;
  upsertGames(
    page.releases.map((r) => ({
      rawgId: r.rawgId,
      name: r.name,
      category: r.category,
      releaseDate: r.releaseDate,
      platforms: r.platforms,
      metacriticScore: r.metacriticScore,
      description: r.description,
    })),
  );
}

/** Map a stored DB row back into the API response shape. */
function rowToResponse(row: GameRow) {
  return {
    rawgId: row.rawgId,
    name: row.name,
    category: row.category,
    categories: [row.category],
    releaseDate: row.releaseDate,
    platforms: row.platforms,
    metacriticScore: row.metacriticScore,
    description: row.description,
    imageUrl: null as string | null,
  };
}

releasesRoutes.get('/', async (c) => {
  const categories = parseCategories(c.req.query('categories'));
  const range = defaultRange();
  const since = parseDate(c.req.query('since')) ?? range.since;
  const until = parseDate(c.req.query('until')) ?? range.until;

  if (since > until) {
    return c.json({ error: '`since` must be on or before `until`.' }, 400);
  }

  const platform = c.req.query('platforms')?.trim() || null;
  const pageRaw = Number.parseInt(c.req.query('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const key = cacheKey({ categories, since, until, platform, page });

  try {
    const result = await cache.getOrLoad(key, CACHE_TTL_SECONDS, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RAWG_TIMEOUT_MS);
      try {
        const fetched = await fetchReleases({
          since,
          until,
          categories,
          platform: platform ?? undefined,
          page,
          signal: controller.signal,
        });
        // Mirror into SQLite so the data survives cold starts.
        persistPage(fetched);
        return fetched;
      } finally {
        clearTimeout(timer);
      }
    });

    const meta = cache.ageMeta(key);
    return c.json({
      ...result,
      filters: { categories, since, until, platform },
      source: 'rawg',
      cache: {
        cached: true,
        expiresAt: meta ? new Date(meta.expiresAt).toISOString() : null,
      },
    });
  } catch (err) {
    // RAWG is down or rate-limited: serve whatever we already persisted for
    // these filters rather than failing the whole dashboard.
    const fallback = queryGames({
      categories: categories.length ? categories : undefined,
      since,
      until,
      platform,
      limit: 50,
      offset: (page - 1) * 50,
    });

    if (fallback.length > 0) {
      return c.json({
        releases: fallback.map(rowToResponse),
        page,
        pageSize: 50,
        totalCount: fallback.length,
        hasNext: fallback.length === 50,
        filters: { categories, since, until, platform },
        source: 'cache-fallback',
        warning:
          err instanceof RawgApiError
            ? `RAWG unavailable (${err.message}); served stored data.`
            : 'RAWG unavailable; served stored data.',
      });
    }

    const status = err instanceof RawgApiError ? err.status : 500;
    const message =
      err instanceof RawgApiError
        ? err.message
        : `Unexpected error: ${(err as Error).message}`;
    return c.json({ error: message }, status as 400);
  }
});

export default releasesRoutes;
