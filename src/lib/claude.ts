/**
 * Claude recommendations engine.
 *
 * Given a set of candidate games (already stored in games_table) and the user's
 * Steam library, asks Claude to score each candidate 0-100 for "will the user
 * enjoy this?" with a one-to-two-sentence rationale.
 *
 * Design choices:
 *   - We read the Steam library straight from the in-process TtlCache (the same
 *     entry the /steam/library route populates) rather than making an HTTP call
 *     back into our own server. If the cache is cold we fetch once via the steam
 *     lib directly. Either way the taste profile is cheap to assemble.
 *   - The prompt summarizes only the top 10 most-played titles (by hours). That
 *     is plenty of signal for taste matching and keeps the prompt small/cheap.
 *   - ALL candidates are scored in ONE API call via a single tool_use schema
 *     (an array of {rawgId, confidenceScore, reasoning}). One round trip beats N.
 *   - Model: claude-haiku-4-5 — cheapest capable model; this is a bounded,
 *     well-structured scoring task that doesn't need Opus.
 *   - Structured output via tool_use means Claude hands back JSON we can read
 *     directly instead of free text we'd have to parse out of prose.
 */

import Anthropic from '@anthropic-ai/sdk';
import { requireEnv } from './env.js';
import { cache } from './cache.js';
import { fetchSteamLibrary, type SteamGame, type SteamLibrary } from './steam.js';
import type { GameRow } from './db.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const TOP_N_LIBRARY = 10;

/** Same cache key the /steam/library route uses, so we reuse a warm entry. */
const STEAM_CACHE_KEY = 'steam:library';
const STEAM_CACHE_TTL_SECONDS = 60 * 60; // mirror steam route's 1h TTL
const STEAM_TIMEOUT_MS = 30_000;

/** One scored candidate as returned to the route layer. */
export interface ClaudeRecommendation {
  /** rawg_id of the candidate, echoed back so the route can re-key by game. */
  rawgId: number;
  confidenceScore: number;
  reasoning: string;
}

/**
 * Manual taste preferences from the user's on-page quiz. Supplements Steam
 * playtime data with games from other platforms and self-reported values.
 */
export interface UserPreferences {
  /** Comma-separated favorites not on Steam, or where playtime doesn't reflect love for them. */
  favoritesNote?: string;
  /** Slugs of what the user values most: story, build-depth, combat, exploration, lore, social, emotional, mechanics */
  values?: string[];
  /** Free-form additional context for Claude. */
  notes?: string;
}

/** Carries an HTTP-ish status so the route can map failures sensibly. */
export class ClaudeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ClaudeApiError';
  }
}

let client: Anthropic | null = null;

/** Lazily construct the SDK client so a missing key never crashes on import. */
function getClient(): Anthropic {
  if (client) return client;
  const apiKey = requireEnv('CLAUDE_API_KEY');
  client = new Anthropic({ apiKey });
  return client;
}

/**
 * Load the user's Steam library, preferring the warm cache populated by the
 * /steam/library route. On a cold cache we fetch once (and seed the cache) so
 * subsequent recommendation calls are cheap.
 */
async function loadLibrary(): Promise<SteamLibrary> {
  return cache.getOrLoad(STEAM_CACHE_KEY, STEAM_CACHE_TTL_SECONDS, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STEAM_TIMEOUT_MS);
    try {
      return await fetchSteamLibrary(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  });
}

const VALUE_LABELS: Record<string, string> = {
  'story':       'story & narrative depth',
  'build-depth': 'build depth & character systems',
  'combat':      'combat feel & mechanics',
  'exploration': 'world exploration',
  'lore':        'lore & world-building',
  'social':      'MMO / social content',
  'emotional':   'emotional impact',
  'mechanics':   'unique mechanics',
  'fantasy':     'fantasy setting (strong preference — penalize games set in realistic/modern/sci-fi worlds unless story/systems are exceptional)',
};

/**
 * Assemble a full taste profile from Steam library data + optional manual prefs.
 * Manual prefs are weighted equally with playtime — they capture games on other
 * platforms and why the user likes specific titles, not just how many hours.
 */
function buildTasteProfile(library: SteamLibrary, prefs?: UserPreferences): string {
  const top = [...library.games]
    .sort((a, b) => b.hoursPlayed - a.hoursPlayed)
    .slice(0, TOP_N_LIBRARY)
    .filter((g) => g.hoursPlayed > 0);

  const parts: string[] = [];

  if (top.length > 0) {
    const lines = top.map((g, i) => `${i + 1}. ${g.name} — ${g.hoursPlayed}h`);
    parts.push(`Most-played Steam games:\n${lines.join('\n')}`);
  } else {
    parts.push('No Steam playtime recorded.');
  }

  if (prefs) {
    const prefParts: string[] = [];
    if (prefs.favoritesNote?.trim()) {
      prefParts.push(
        `Favorite games not reflected in Steam (other platforms, or where playtime understates enjoyment):\n${prefs.favoritesNote.trim()}`,
      );
    }
    if (prefs.values?.length) {
      const labels = prefs.values.map((v) => `• ${VALUE_LABELS[v] ?? v}`).join('\n');
      prefParts.push(`What the user values most in games (self-reported):\n${labels}`);
    }
    if (prefs.notes?.trim()) {
      prefParts.push(`Additional context:\n${prefs.notes.trim()}`);
    }
    if (prefParts.length > 0) {
      parts.push(
        'User-provided taste context (weight equally with playtime — this fills in gaps Steam cannot show):\n\n' +
          prefParts.join('\n\n'),
      );
    }
  }

  return parts.join('\n\n');
}

/** Render the candidate list Claude must score. */
function describeCandidates(candidates: GameRow[]): string {
  return candidates
    .map((g) => {
      const parts = [
        `rawgId ${g.rawgId}: ${g.name}`,
        g.category ? `category: ${g.category}` : null,
        g.platforms.length ? `platforms: ${g.platforms.join(', ')}` : null,
        g.metacriticScore != null ? `metacritic: ${g.metacriticScore}` : null,
        g.avgPlaytimeHours != null ? `avg community playtime: ${g.avgPlaytimeHours}h` : null,
        g.releaseDate ? `releases: ${g.releaseDate}` : null,
        g.description ? `about: ${g.description.slice(0, 400)}` : null,
      ].filter(Boolean);
      return `- ${parts.join(' | ')}`;
    })
    .join('\n');
}

/** The single structured-output tool Claude must call exactly once. */
const SCORE_TOOL: Anthropic.Tool = {
  name: 'submit_recommendations',
  description:
    'Submit a confidence score and short reasoning for every candidate game.',
  input_schema: {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        description: 'One entry per candidate game, in any order.',
        items: {
          type: 'object',
          properties: {
            rawgId: {
              type: 'integer',
              description: 'The rawgId of the candidate being scored.',
            },
            confidenceScore: {
              type: 'integer',
              description:
                'How likely the user is to enjoy this game, 0 (no) to 100 (loves it).',
            },
            reasoning: {
              type: 'string',
              description:
                'One to two sentences justifying the score, grounded in the user\'s taste profile.',
            },
          },
          required: ['rawgId', 'confidenceScore', 'reasoning'],
        },
      },
    },
    required: ['recommendations'],
  },
};

interface ToolResult {
  recommendations: Array<{
    rawgId: number;
    confidenceScore: number;
    reasoning: string;
  }>;
}

/** Clamp a model-provided score into the valid 0-100 integer range. */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Score every candidate game for the current user in a single Claude call.
 *
 * @param candidates  Stored game rows (must include rawgId + name; other fields
 *                    enrich the prompt). Pass only cache-miss candidates.
 */
export async function scoreRecommendations(
  candidates: GameRow[],
  prefs?: UserPreferences,
): Promise<ClaudeRecommendation[]> {
  if (candidates.length === 0) return [];

  const library = await loadLibrary();
  const taste = buildTasteProfile(library, prefs);
  const candidateList = describeCandidates(candidates);

  const prompt = [
    'You help a single user decide which upcoming/recent game releases they will enjoy.',
    '',
    taste,
    '',
    'Score each of the following candidate games from 0 to 100 for how much THIS user',
    'will enjoy it, based on the taste profile above. Give one to two sentences of',
    'reasoning per game. Call submit_recommendations exactly once with an entry for',
    'every candidate.',
    '',
    'When scoring, use "avg community playtime" to gauge game type, not to penalize.',
    'Story-driven games (JRPGs, narrative RPGs, action-adventure) have predictable avg',
    'playtimes because there\'s a defined story arc — most players clock similar hours.',
    'If a game\'s genre strongly matches the user\'s taste profile, its avg playtime is',
    'just its length, not a depth signal, and should not reduce the score.',
    'Avg playtime IS a useful differentiator when comparing otherwise-equal candidates:',
    'live-service games, MMOs, and open-world sandboxes with avg playtimes of 200h+',
    'often get those numbers from a small % of obsessive players, not typical enjoyment.',
    'If the user\'s top games average 40-80h and a live-service candidate shows 400h avg,',
    'flag that mismatch in reasoning. But never penalize a genre-matched story game for',
    'having a "normal" completion time that aligns with the user\'s own history.',
    '',
    'Candidates:',
    candidateList,
  ].join('\n');

  let message: Anthropic.Message;
  try {
    message = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [SCORE_TOOL],
      tool_choice: { type: 'tool', name: SCORE_TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new ClaudeApiError(
        `Claude API error: ${err.message}`,
        err.status ?? 502,
      );
    }
    throw new ClaudeApiError(
      `Unexpected Claude error: ${(err as Error).message}`,
      502,
    );
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) {
    throw new ClaudeApiError(
      'Claude did not return structured recommendations.',
      502,
    );
  }

  const result = toolUse.input as ToolResult;
  if (!result || !Array.isArray(result.recommendations)) {
    throw new ClaudeApiError('Claude returned a malformed recommendations payload.', 502);
  }

  // Keep only entries that map to a candidate we actually asked about, clamp
  // scores, and de-dupe by rawgId (last write wins) in case the model repeats.
  const validRawgIds = new Set(candidates.map((c) => c.rawgId));
  const byRawgId = new Map<number, ClaudeRecommendation>();
  for (const r of result.recommendations) {
    if (!validRawgIds.has(r.rawgId)) continue;
    byRawgId.set(r.rawgId, {
      rawgId: r.rawgId,
      confidenceScore: clampScore(r.confidenceScore),
      reasoning: typeof r.reasoning === 'string' ? r.reasoning.trim() : '',
    });
  }

  return [...byRawgId.values()];
}

// ── Backlog scoring ───────────────────────────────────────────────────────────

/** One pick from the user's unplayed Steam library. */
export interface BacklogPick {
  appId: number;
  name: string;
  hoursPlayed: number;
  confidenceScore: number;
  reasoning: string;
}

const BACKLOG_TOOL: Anthropic.Tool = {
  name: 'submit_backlog_picks',
  description: 'Submit the top picks from the user\'s owned-but-unplayed Steam library.',
  input_schema: {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        description: 'Top picks in descending order of confidence.',
        items: {
          type: 'object',
          properties: {
            appId:           { type: 'integer', description: 'Steam AppID of the game.' },
            name:            { type: 'string',  description: 'Exact game name as provided.' },
            confidenceScore: { type: 'integer', description: '0-100 likelihood the user will enjoy it.' },
            reasoning:       { type: 'string',  description: 'One to two sentences grounded in the taste profile.' },
          },
          required: ['appId', 'name', 'confidenceScore', 'reasoning'],
        },
      },
    },
    required: ['picks'],
  },
};

interface BacklogToolResult {
  picks: Array<{ appId: number; name: string; confidenceScore: number; reasoning: string }>;
}

/**
 * Given the user's unplayed Steam games, ask Claude to rank the top N they'd
 * most enjoy based on their taste profile. Uses Claude's own knowledge of each
 * game — no RAWG enrichment needed.
 */
export async function scoreBacklog(
  candidates: SteamGame[],
  topN: number = 5,
  prefs?: UserPreferences,
): Promise<BacklogPick[]> {
  if (candidates.length === 0) return [];

  const library = await loadLibrary();
  const taste = buildTasteProfile(library, prefs);

  const candidateLines = candidates
    .map((g) => `- ${g.name} (appId: ${g.appId}, ${g.hoursPlayed}h played)`)
    .join('\n');

  const prompt = [
    'You help a single user decide which games from their Steam backlog to play next.',
    '',
    taste,
    '',
    `The user owns the following games but has played each for fewer than a few hours.`,
    `Use your knowledge of each game's genre, tone, and gameplay to match against their`,
    `taste profile. Pick the top ${topN} they are most likely to enjoy.`,
    '',
    'Score 0-100 for how much they will enjoy it (not how good the game is in general).',
    'Give one to two sentences of reasoning grounded in their taste profile.',
    `Return exactly ${topN} picks (or fewer only if fewer than ${topN} candidates are listed).`,
    '',
    'Candidates:',
    candidateLines,
  ].join('\n');

  let message: Anthropic.Message;
  try {
    message = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [BACKLOG_TOOL],
      tool_choice: { type: 'tool', name: BACKLOG_TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new ClaudeApiError(`Claude API error: ${err.message}`, err.status ?? 502);
    }
    throw new ClaudeApiError(`Unexpected Claude error: ${(err as Error).message}`, 502);
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) {
    throw new ClaudeApiError('Claude did not return backlog picks.', 502);
  }

  const result = toolUse.input as BacklogToolResult;
  if (!result || !Array.isArray(result.picks)) {
    throw new ClaudeApiError('Claude returned a malformed backlog payload.', 502);
  }

  const validAppIds = new Map(candidates.map((g) => [g.appId, g]));
  const seen = new Set<number>();
  const picks: BacklogPick[] = [];
  for (const p of result.picks) {
    const candidate = validAppIds.get(p.appId);
    if (seen.has(p.appId) || !candidate) continue;
    seen.add(p.appId);
    picks.push({
      appId: p.appId,
      name: p.name,
      hoursPlayed: candidate.hoursPlayed,
      confidenceScore: clampScore(p.confidenceScore),
      reasoning: typeof p.reasoning === 'string' ? p.reasoning.trim() : '',
    });
  }
  return picks.sort((a, b) => b.confidenceScore - a.confidenceScore);
}

// ── Discovery ─────────────────────────────────────────────────────────────────

const PLATFORM_DISPLAY: Record<string, string> = {
  'pc':              'PC (Steam / Epic / GOG)',
  'playstation5':    'PlayStation 5',
  'playstation4':    'PlayStation 4',
  'xbox-series-x':   'Xbox Series X/S',
  'nintendo-switch': 'Nintendo Switch',
};

export interface DiscoverPick {
  name: string;
  platforms: string[];
  description: string;
  confidenceScore: number;
  reasoning: string;
}

const DISCOVER_TOOL: Anthropic.Tool = {
  name: 'submit_discoveries',
  description: 'Submit games the user should discover and acquire.',
  input_schema: {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        description: 'Picks in descending order of confidence.',
        items: {
          type: 'object',
          properties: {
            name:            { type: 'string',  description: 'Exact game title.' },
            platforms:       { type: 'array',   items: { type: 'string' }, description: 'Platforms this game is available on.' },
            description:     { type: 'string',  description: '2-3 sentence overview of the game.' },
            confidenceScore: { type: 'integer', description: '0-100 likelihood the user will enjoy it.' },
            reasoning:       { type: 'string',  description: '1-2 sentences grounded in the taste profile.' },
          },
          required: ['name', 'platforms', 'description', 'confidenceScore', 'reasoning'],
        },
      },
    },
    required: ['picks'],
  },
};

export async function discoverRecommendations(
  opts: { platforms?: string[]; genres?: string[]; limit?: number },
  prefs?: UserPreferences,
): Promise<DiscoverPick[]> {
  const limit = Math.max(1, Math.min(12, opts.limit ?? 8));
  const library = await loadLibrary();
  const taste = buildTasteProfile(library, prefs);

  const platformNames = (opts.platforms ?? [])
    .map((p) => PLATFORM_DISPLAY[p] ?? p)
    .filter(Boolean);
  const platformStr = platformNames.length
    ? `Preferred platforms: ${platformNames.join(', ')}`
    : 'Any platform (PC, PlayStation, Xbox, Switch, etc.)';

  const genreStr = (opts.genres ?? []).length
    ? `Genre preference: ${opts.genres!.join(', ')}`
    : '';

  const ownedNames = library.games.slice(0, 60).map((g) => g.name).join(', ');
  const ownedBlock = ownedNames
    ? `The user already owns these Steam games — do NOT recommend them:\n${ownedNames}`
    : '';

  const prompt = [
    'You help a user discover games they should buy and play next.',
    '',
    taste,
    '',
    platformStr,
    genreStr,
    '',
    ownedBlock,
    '',
    `Recommend exactly ${limit} games this user would love that they likely do not own yet.`,
    'Draw from your full knowledge — any era, any release, not just recent titles.',
    'For each game provide: its exact title, the platforms it is available on,',
    'a 2-3 sentence description, a 0-100 confidence score for this specific user,',
    'and 1-2 sentences of reasoning grounded in their taste profile.',
    'Sort picks by confidence score descending. Call submit_discoveries exactly once.',
  ].filter(Boolean).join('\n');

  let message: Anthropic.Message;
  try {
    message = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [DISCOVER_TOOL],
      tool_choice: { type: 'tool', name: DISCOVER_TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new ClaudeApiError(`Claude API error: ${err.message}`, err.status ?? 502);
    }
    throw new ClaudeApiError(`Unexpected Claude error: ${(err as Error).message}`, 502);
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) throw new ClaudeApiError('Claude did not return discoveries.', 502);

  const result = toolUse.input as { picks: DiscoverPick[] };
  if (!result || !Array.isArray(result.picks)) {
    throw new ClaudeApiError('Claude returned a malformed discoveries payload.', 502);
  }

  return result.picks
    .map((p) => ({ ...p, confidenceScore: clampScore(p.confidenceScore) }))
    .sort((a, b) => b.confidenceScore - a.confidenceScore);
}

// ── Lookup ────────────────────────────────────────────────────────────────────

export interface LookupResult {
  name: string;
  platforms: string[];
  description: string;
  confidenceScore: number;
  reasoning: string;
}

const LOOKUP_TOOL: Anthropic.Tool = {
  name: 'submit_lookup',
  description: 'Submit scored game results for the lookup query.',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:            { type: 'string' },
            platforms:       { type: 'array',   items: { type: 'string' } },
            description:     { type: 'string',  description: '2-3 sentence game overview.' },
            confidenceScore: { type: 'integer' },
            reasoning:       { type: 'string',  description: '1-2 sentences grounded in the taste profile.' },
          },
          required: ['name', 'platforms', 'description', 'confidenceScore', 'reasoning'],
        },
      },
    },
    required: ['results'],
  },
};

export async function lookupGame(
  query: string,
  prefs?: UserPreferences,
): Promise<LookupResult[]> {
  const library = await loadLibrary();
  const taste = buildTasteProfile(library, prefs);

  const prompt = [
    'You help a user evaluate whether a game or type of game is right for them.',
    '',
    taste,
    '',
    `User query: "${query}"`,
    '',
    'If this is a specific game title: return exactly 1 result scoring that game for this user.',
    'If this is a descriptive query ("games like X", "a game with Y mechanics"): return the',
    '2-4 best matching games scored for this user.',
    'For each: provide the exact title, platforms it is on, a 2-3 sentence description,',
    'a 0-100 confidence score, and 1-2 sentences of reasoning grounded in their taste profile.',
    'Call submit_lookup exactly once.',
  ].join('\n');

  let message: Anthropic.Message;
  try {
    message = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [LOOKUP_TOOL],
      tool_choice: { type: 'tool', name: LOOKUP_TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new ClaudeApiError(`Claude API error: ${err.message}`, err.status ?? 502);
    }
    throw new ClaudeApiError(`Unexpected Claude error: ${(err as Error).message}`, 502);
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolUse) throw new ClaudeApiError('Claude did not return lookup results.', 502);

  const result = toolUse.input as { results: LookupResult[] };
  if (!result || !Array.isArray(result.results)) {
    throw new ClaudeApiError('Claude returned a malformed lookup payload.', 502);
  }

  return result.results
    .map((r) => ({ ...r, confidenceScore: clampScore(r.confidenceScore) }))
    .sort((a, b) => b.confidenceScore - a.confidenceScore);
}
