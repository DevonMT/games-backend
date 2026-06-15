/**
 * RAWG Video Games Database API client.
 *
 * RAWG (https://rawg.io/apidocs) exposes a huge catalog with release dates,
 * Metacritic scores, genres, tags, and platform lists — exactly what the
 * "recent & upcoming releases" view needs. We hit GET /api/games with a date
 * range and optional genre/platform filters, then normalize each result into
 * the shape our DB and frontend expect.
 *
 * Auth: a single `key` query param (RAWG_API_KEY). The free tier is generous
 * but rate-limited, which is why the route layer caches results for 7 days and
 * mirrors them into SQLite.
 *
 * Docs: https://api.rawg.io/docs/#operation/games_list
 */

import { requireEnv } from './env.js';

const RAWG_API_BASE = 'https://api.rawg.io/api';

/** Canonical category enum the dashboard filters on. */
export const CATEGORIES = [
  'AAA',
  'indie',
  'early_access',
  'multiplayer',
  'single_player',
  'action',
  'rpg',
  'strategy',
  'sports',
  'simulation',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** A single release after normalization, ready for DB upsert + API response. */
export interface RawgRelease {
  rawgId: number;
  name: string;
  category: Category;
  /** Every category we inferred, for richer client-side filtering. */
  categories: Category[];
  releaseDate: string | null; // ISO date YYYY-MM-DD
  platforms: string[];
  metacriticScore: number | null;
  description: string | null;
  imageUrl: string | null;
  developer: string | null;
  publisher: string | null;
  steamAppId: number | null;
  avgPlaytimeHours: number | null;
}

export interface RawgReleasesPage {
  releases: RawgRelease[];
  page: number;
  pageSize: number;
  /** Total matching games reported by RAWG (across all pages). */
  totalCount: number;
  hasNext: boolean;
}

/** Error type carrying an HTTP status for the route layer to map. */
export class RawgApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RawgApiError';
  }
}

/** Raw RAWG list-response shapes (only the fields we consume). */
interface RawRawgPlatformEntry {
  platform?: { id?: number; name?: string };
}
interface RawRawgGenre {
  name?: string;
  slug?: string;
}
interface RawRawgTag {
  name?: string;
  slug?: string;
}
interface RawRawgCompany {
  name?: string;
}
interface RawRawgStore {
  url?: string;
  store?: { slug?: string };
}
interface RawRawgGame {
  id: number;
  name?: string;
  slug?: string;
  released?: string | null;
  metacritic?: number | null;
  background_image?: string | null;
  platforms?: RawRawgPlatformEntry[];
  genres?: RawRawgGenre[];
  tags?: RawRawgTag[];
  developers?: RawRawgCompany[];
  publishers?: RawRawgCompany[];
  stores?: RawRawgStore[];
  playtime?: number | null; // average playtime in hours reported by RAWG
  added?: number; // how many RAWG users added it — our AAA-vs-indie heuristic
}
interface RawRawgListResponse {
  count?: number;
  next?: string | null;
  results?: RawRawgGame[];
}

/** Single-game detail response (adds description_raw). */
interface RawRawgGameDetail extends RawRawgGame {
  description_raw?: string;
}

const PAGE_SIZE = 50;

/**
 * Maps RAWG genre/tag slugs onto our canonical genre categories. RAWG genres
 * are broad ("Role-Playing-Games-RPG"); we collapse them to our short enum.
 */
const GENRE_SLUG_TO_CATEGORY: Record<string, Category> = {
  action: 'action',
  shooter: 'action',
  fighting: 'action',
  'role-playing-games-rpg': 'rpg',
  rpg: 'rpg',
  strategy: 'strategy',
  'board-games': 'strategy',
  sports: 'sports',
  racing: 'sports',
  simulation: 'simulation',
};

/** Tag slugs that signal a play-mode category. */
const MULTIPLAYER_TAG_SLUGS = new Set([
  'multiplayer',
  'co-op',
  'online-co-op',
  'online-multiplayer',
  'pvp',
  'massively-multiplayer',
  'mmo',
]);
const SINGLE_PLAYER_TAG_SLUGS = new Set(['singleplayer', 'single-player']);
const EARLY_ACCESS_TAG_SLUGS = new Set(['early-access']);
const INDIE_SLUGS = new Set(['indie']);

/**
 * RAWG's `added` count (number of users who put a game in a collection) is a
 * decent proxy for reach. Above this threshold we tag a game "AAA"; indie is
 * driven by the explicit indie genre/tag. Tuned conservatively — it's a hint,
 * not gospel.
 */
const AAA_ADDED_THRESHOLD = 5000;

function collectCategories(game: RawRawgGame): Category[] {
  const found = new Set<Category>();

  const genreSlugs = (game.genres ?? [])
    .map((g) => g.slug?.toLowerCase())
    .filter((s): s is string => Boolean(s));
  const tagSlugs = (game.tags ?? [])
    .map((t) => t.slug?.toLowerCase())
    .filter((s): s is string => Boolean(s));

  for (const slug of genreSlugs) {
    const mapped = GENRE_SLUG_TO_CATEGORY[slug];
    if (mapped) found.add(mapped);
    if (INDIE_SLUGS.has(slug)) found.add('indie');
  }

  for (const slug of tagSlugs) {
    if (INDIE_SLUGS.has(slug)) found.add('indie');
    if (EARLY_ACCESS_TAG_SLUGS.has(slug)) found.add('early_access');
    if (MULTIPLAYER_TAG_SLUGS.has(slug)) found.add('multiplayer');
    if (SINGLE_PLAYER_TAG_SLUGS.has(slug)) found.add('single_player');
    const mappedTag = GENRE_SLUG_TO_CATEGORY[slug];
    if (mappedTag) found.add(mappedTag);
  }

  // Reach-based AAA heuristic — only when it isn't flagged indie, since the two
  // are mutually exclusive in practice and indie is the higher-signal label.
  if (!found.has('indie') && (game.added ?? 0) >= AAA_ADDED_THRESHOLD) {
    found.add('AAA');
  }

  if (found.size === 0) found.add('other');
  return [...found];
}

/** Picks the single "primary" category for the games_table.category column. */
function primaryCategory(categories: Category[]): Category {
  // Order of preference: the most descriptive / filter-worthy label first.
  const priority: Category[] = [
    'AAA',
    'indie',
    'early_access',
    'rpg',
    'action',
    'strategy',
    'simulation',
    'sports',
    'multiplayer',
    'single_player',
    'other',
  ];
  for (const c of priority) {
    if (categories.includes(c)) return c;
  }
  return 'other';
}

function normalizePlatforms(game: RawRawgGame): string[] {
  const names = (game.platforms ?? [])
    .map((p) => p.platform?.name)
    .filter((n): n is string => Boolean(n));
  return [...new Set(names)];
}

function normalizeGame(game: RawRawgGame): RawgRelease {
  const categories = collectCategories(game);
  return {
    rawgId: game.id,
    name: game.name ?? `RAWG ${game.id}`,
    category: primaryCategory(categories),
    categories,
    releaseDate: game.released ?? null,
    platforms: normalizePlatforms(game),
    metacriticScore: typeof game.metacritic === 'number' ? game.metacritic : null,
    description:
      (game as RawRawgGameDetail).description_raw?.trim() ||
      null,
    imageUrl: game.background_image ?? null,
    developer: game.developers?.[0]?.name ?? null,
    publisher: game.publishers?.[0]?.name ?? null,
    steamAppId: extractSteamAppId(game),
    avgPlaytimeHours: typeof game.playtime === 'number' && game.playtime > 0 ? game.playtime : null,
  };
}

const STEAM_APP_URL_RE = /store\.steampowered\.com\/app\/(\d+)/;

function extractSteamAppId(game: RawRawgGame): number | null {
  const steamStore = (game.stores ?? []).find((s) => s.store?.slug === 'steam');
  if (!steamStore?.url) return null;
  const m = steamStore.url.match(STEAM_APP_URL_RE);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Map our category enum to RAWG genre slugs for the `genres` filter. Only the
 * genre-like categories translate to a RAWG-side filter; play-mode/era
 * categories (multiplayer, early_access, AAA…) are applied post-fetch since
 * RAWG has no direct list filter for them.
 */
const CATEGORY_TO_RAWG_GENRE: Partial<Record<Category, string>> = {
  action: 'action',
  rpg: 'role-playing-games-rpg',
  strategy: 'strategy',
  sports: 'sports',
  simulation: 'simulation',
  indie: 'indie',
};

export interface FetchReleasesParams {
  /** Inclusive start date (YYYY-MM-DD). */
  since: string;
  /** Inclusive end date (YYYY-MM-DD). */
  until: string;
  /** Canonical categories to filter on. */
  categories?: Category[];
  /** Platform name substring (matched against RAWG platform names). */
  platform?: string;
  page?: number;
  signal?: AbortSignal;
}

/**
 * RAWG platform IDs for the common ones, so we can pass `platforms=` and let
 * RAWG do the filtering instead of fetching everything and filtering locally.
 * https://api.rawg.io/api/platforms
 */
const PLATFORM_NAME_TO_ID: Record<string, number> = {
  pc: 4,
  steam: 4, // "Steam" is a store, but in practice users mean PC
  playstation5: 187,
  playstation4: 18,
  'xbox-one': 1,
  'xbox-series-x': 186,
  'nintendo-switch': 7,
};

function resolvePlatformId(platform: string | undefined): number | undefined {
  if (!platform) return undefined;
  const key = platform.trim().toLowerCase().replace(/\s+/g, '-');
  return PLATFORM_NAME_TO_ID[key];
}

async function rawgFetch(url: URL, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new RawgApiError('RAWG request timed out.', 504);
    }
    throw new RawgApiError(
      `Network error contacting RAWG: ${(err as Error).message}`,
      502,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new RawgApiError('RAWG rejected the API key. Check RAWG_API_KEY.', 502);
  }
  if (res.status === 429) {
    throw new RawgApiError('RAWG rate limit hit (429). Try again shortly.', 429);
  }
  if (!res.ok) {
    throw new RawgApiError(`RAWG returned HTTP ${res.status}.`, 502);
  }
  return res;
}

/**
 * Fetch one page of releases for a date range, normalized to our shape.
 *
 * Genre + platform filters are pushed to RAWG where possible. Play-mode and
 * era categories (multiplayer/single_player/early_access/AAA) are applied
 * locally after normalization because RAWG's list endpoint can't filter on
 * them directly.
 */
/**
 * Fetch a single game by its RAWG id. Used by the recommendations route to
 * seed the DB on demand when a game wasn't pre-loaded via /releases.
 */
export async function fetchGameById(
  rawgId: number,
  signal?: AbortSignal,
): Promise<RawgRelease | null> {
  const apiKey = requireEnv('RAWG_API_KEY');
  const url = new URL(`${RAWG_API_BASE}/games/${rawgId}`);
  url.searchParams.set('key', apiKey);

  let res: Response;
  try {
    res = await rawgFetch(url, signal);
  } catch {
    return null;
  }

  if (!res.ok) return null;
  const game = (await res.json()) as RawRawgGameDetail & RawRawgGame;
  return normalizeGame(game);
}

export async function fetchReleases(
  params: FetchReleasesParams,
): Promise<RawgReleasesPage> {
  const apiKey = requireEnv('RAWG_API_KEY');
  const page = Math.max(1, params.page ?? 1);

  const url = new URL(`${RAWG_API_BASE}/games`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('dates', `${params.since},${params.until}`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('page_size', String(PAGE_SIZE));
  url.searchParams.set('ordering', '-released');

  // Genre filter: RAWG accepts a comma-separated list of genre slugs.
  const genreSlugs = (params.categories ?? [])
    .map((c) => CATEGORY_TO_RAWG_GENRE[c])
    .filter((s): s is string => Boolean(s));
  if (genreSlugs.length > 0) {
    url.searchParams.set('genres', [...new Set(genreSlugs)].join(','));
  }

  const platformId = resolvePlatformId(params.platform);
  if (platformId) {
    url.searchParams.set('platforms', String(platformId));
  }

  const res = await rawgFetch(url, params.signal);
  const body = (await res.json()) as RawRawgListResponse;

  const all = (body.results ?? []).map(normalizeGame);

  // Local filter for the categories RAWG couldn't filter server-side.
  const localCategoryFilter = (params.categories ?? []).filter(
    (c) => !CATEGORY_TO_RAWG_GENRE[c],
  );
  const filtered =
    localCategoryFilter.length > 0
      ? all.filter((r) => localCategoryFilter.some((c) => r.categories.includes(c)))
      : all;

  // If a platform name was given that we couldn't resolve to a RAWG id, fall
  // back to a local name-contains filter so the param still has an effect.
  const platformFiltered =
    params.platform && !platformId
      ? filtered.filter((r) =>
          r.platforms.some((p) =>
            p.toLowerCase().includes(params.platform!.toLowerCase()),
          ),
        )
      : filtered;

  // Always post-filter by category locally so the shown games definitively
  // belong to the requested category — RAWG's server-side genre filter can
  // return broad matches that our normalization classifies differently.
  const requestedCats = params.categories ?? [];
  const releases =
    requestedCats.length > 0
      ? platformFiltered.filter((r) =>
          requestedCats.some((c) => r.categories.includes(c)),
        )
      : platformFiltered;

  return {
    releases,
    page,
    pageSize: PAGE_SIZE,
    totalCount: body.count ?? releases.length,
    hasNext: Boolean(body.next),
  };
}
