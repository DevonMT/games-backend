/**
 * Steam Web API client.
 *
 * Uses IPlayerService/GetOwnedGames to fetch the owned-games list for a single
 * SteamID. This endpoint requires an API key but works against any profile
 * whose "Game details" privacy is set to Public. It returns playtime in
 * MINUTES; we normalize to hours for the dashboard.
 *
 * Docs: https://partner.steamgames.com/doc/webapi/IPlayerService#GetOwnedGames
 */

import { requireEnv } from './env.js';

const STEAM_API_BASE = 'https://api.steampowered.com';

/** A single game as returned by Steam, after normalization. */
export interface SteamGame {
  /** Steam AppID. */
  appId: number;
  name: string;
  /** Total playtime across all platforms, in hours (rounded to 1 decimal). */
  hoursPlayed: number;
  /** Playtime in the last 2 weeks, in hours. */
  hoursLast2Weeks: number;
  /** URL to the game's capsule/header image, or null if unavailable. */
  imageUrl: string | null;
}

export interface SteamLibrary {
  steamId: string;
  gameCount: number;
  games: SteamGame[];
  /** ISO timestamp the library was fetched from Steam. */
  fetchedAt: string;
}

/** Raw shape of a single game in the Steam API response. */
interface RawSteamGame {
  appid: number;
  name?: string;
  playtime_forever?: number; // minutes
  playtime_2weeks?: number; // minutes
  img_icon_url?: string;
}

interface RawGetOwnedGamesResponse {
  response?: {
    game_count?: number;
    games?: RawSteamGame[];
  };
}

/** Error type that carries an HTTP status for the route layer to map. */
export class SteamApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SteamApiError';
  }
}

const minutesToHours = (minutes: number | undefined): number =>
  Math.round(((minutes ?? 0) / 60) * 10) / 10;

/**
 * Steam serves library capsule art from a CDN keyed by appid + image hash.
 * The header image is a stable, predictable URL and looks better in a table
 * than the tiny icon, so we prefer it.
 */
function buildImageUrl(appId: number): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

function normalizeGame(raw: RawSteamGame): SteamGame {
  return {
    appId: raw.appid,
    name: raw.name ?? `App ${raw.appid}`,
    hoursPlayed: minutesToHours(raw.playtime_forever),
    hoursLast2Weeks: minutesToHours(raw.playtime_2weeks),
    imageUrl: buildImageUrl(raw.appid),
  };
}

/**
 * Fetch the owned-games library for the configured SteamID.
 *
 * @param signal Optional AbortSignal so the route can enforce a timeout.
 */
export async function fetchSteamLibrary(
  signal?: AbortSignal,
): Promise<SteamLibrary> {
  const apiKey = requireEnv('STEAM_API_KEY');
  const steamId = requireEnv('STEAM_USER_ID');

  const url = new URL(`${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamid', steamId);
  url.searchParams.set('include_appinfo', 'true'); // gives us names + icons
  url.searchParams.set('include_played_free_games', 'true');
  url.searchParams.set('format', 'json');

  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new SteamApiError('Steam request timed out.', 504);
    }
    throw new SteamApiError(
      `Network error contacting Steam: ${(err as Error).message}`,
      502,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new SteamApiError(
      'Steam rejected the API key (401/403). Check STEAM_API_KEY.',
      502,
    );
  }
  if (res.status === 429) {
    throw new SteamApiError('Steam rate limit hit (429). Try again shortly.', 429);
  }
  if (!res.ok) {
    throw new SteamApiError(`Steam returned HTTP ${res.status}.`, 502);
  }

  const body = (await res.json()) as RawGetOwnedGamesResponse;

  // Steam returns an empty `response: {}` (no `games` key) when the profile's
  // game details are private OR the SteamID owns nothing. Disambiguate for a
  // clearer error, since a private profile is the most common setup mistake.
  if (!body.response || body.response.games === undefined) {
    throw new SteamApiError(
      'Steam returned no game data. Most likely the profile’s game ' +
        'details are set to Private, or STEAM_USER_ID is wrong. Set "Game ' +
        'details" to Public in Steam privacy settings.',
      422,
    );
  }

  const games = (body.response.games ?? [])
    .map(normalizeGame)
    .sort((a, b) => b.hoursPlayed - a.hoursPlayed);

  return {
    steamId,
    gameCount: body.response.game_count ?? games.length,
    games,
    fetchedAt: new Date().toISOString(),
  };
}
