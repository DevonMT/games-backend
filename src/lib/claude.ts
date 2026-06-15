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
import { fetchSteamLibrary, type SteamLibrary } from './steam.js';
import type { GameRow } from './db.js';

const MODEL = 'claude-haiku-4-5-20251001';
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

/** Render the top-N most-played games as a compact taste profile. */
function summarizeTaste(library: SteamLibrary): string {
  const top = [...library.games]
    .sort((a, b) => b.hoursPlayed - a.hoursPlayed)
    .slice(0, TOP_N_LIBRARY)
    .filter((g) => g.hoursPlayed > 0);

  if (top.length === 0) {
    return 'The user has no recorded playtime, so infer taste conservatively.';
  }

  const lines = top.map(
    (g, i) => `${i + 1}. ${g.name} — ${g.hoursPlayed} hours`,
  );
  return `The user's most-played Steam games (by total hours):\n${lines.join('\n')}`;
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
): Promise<ClaudeRecommendation[]> {
  if (candidates.length === 0) return [];

  const library = await loadLibrary();
  const taste = summarizeTaste(library);
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
