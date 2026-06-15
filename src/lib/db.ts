/**
 * SQLite persistence layer (better-sqlite3).
 *
 * Why SQLite + a file on disk? RAWG results are expensive to fetch (paginated,
 * rate-limited) and the TtlCache in cache.ts is per-process — it evaporates on
 * every serverless cold start. Persisting normalized release rows means a cold
 * start can still serve known games immediately while a fresh RAWG fetch warms
 * the cache in the background. The games_table is also the join target for the
 * recommendations engine in Task 3 (recommendations.gameId -> games_table.id).
 *
 * SERVERLESS NOTE: Vercel's filesystem is read-only except for /tmp, and /tmp
 * is ephemeral per-instance. So on Vercel this DB behaves like a warm-instance
 * cache, not durable storage — which is acceptable for a single-tenant
 * dashboard. Locally (Node server) it persists at ./data/games.db. Point
 * DATABASE_PATH at a mounted volume if you later want true durability. The DB
 * is opened lazily on first use so a missing/unwritable path never crashes the
 * /health probe or the Steam routes.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { optionalEnv } from './env.js';

/** A normalized release row as stored in and read out of games_table. */
export interface GameRow {
  id: number;
  steamId: number | null;
  name: string;
  category: string;
  releaseDate: string | null; // ISO date (YYYY-MM-DD)
  platforms: string[]; // decoded from the platforms_json column
  metacriticScore: number | null;
  description: string | null;
  rawgId: number;
  createdAt: string;
  updatedAt: string;
}

/** Shape callers pass to upsert. Mirrors GameRow minus the DB-managed fields. */
export interface GameUpsert {
  rawgId: number;
  name: string;
  category: string;
  steamId?: number | null;
  releaseDate?: string | null;
  platforms?: string[];
  metacriticScore?: number | null;
  description?: string | null;
}

/** Raw column shape as it comes back from SQLite (platforms still JSON text). */
interface RawGameRow {
  id: number;
  steam_id: number | null;
  name: string;
  category: string;
  release_date: string | null;
  platforms_json: string | null;
  metacritic_score: number | null;
  description: string | null;
  rawg_id: number;
  created_at: string;
  updated_at: string;
}

let db: Database.Database | null = null;

function resolveDbPath(): string {
  return optionalEnv('DATABASE_PATH') ?? './data/games.db';
}

/**
 * Open (once) and return the shared DB handle, creating the schema on first
 * use. Idempotent: schema statements all use IF NOT EXISTS.
 */
export function getDb(): Database.Database {
  if (db) return db;

  const path = resolveDbPath();
  // Ensure the parent directory exists; better-sqlite3 won't create it.
  mkdirSync(dirname(path), { recursive: true });

  db = new Database(path);
  db.pragma('journal_mode = WAL'); // better concurrent read perf
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS games_table (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      steam_id         INTEGER,
      name             TEXT    NOT NULL,
      category         TEXT    NOT NULL,
      release_date     TEXT,
      platforms_json   TEXT,
      metacritic_score INTEGER,
      description      TEXT,
      rawg_id          INTEGER NOT NULL UNIQUE,
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_games_release_date ON games_table(release_date);
    CREATE INDEX IF NOT EXISTS idx_games_category     ON games_table(category);

    -- user_library and recommendations are defined here so the foreign-key
    -- targets exist; they're populated in later tasks.
    CREATE TABLE IF NOT EXISTS user_library (
      steam_id      INTEGER NOT NULL,
      game_id       INTEGER NOT NULL REFERENCES games_table(id) ON DELETE CASCADE,
      hours_played  REAL    NOT NULL DEFAULT 0,
      acquired_date TEXT,
      PRIMARY KEY (steam_id, game_id)
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id          INTEGER NOT NULL REFERENCES games_table(id) ON DELETE CASCADE,
      confidence_score INTEGER NOT NULL,
      reasoning        TEXT    NOT NULL,
      generated_at     TEXT    NOT NULL,
      expires_at       TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recs_game ON recommendations(game_id);
  `);
}

function decodeRow(raw: RawGameRow): GameRow {
  let platforms: string[] = [];
  if (raw.platforms_json) {
    try {
      const parsed = JSON.parse(raw.platforms_json);
      if (Array.isArray(parsed)) platforms = parsed.filter((p): p is string => typeof p === 'string');
    } catch {
      // Corrupt JSON shouldn't take down a read; treat as no platforms.
      platforms = [];
    }
  }
  return {
    id: raw.id,
    steamId: raw.steam_id,
    name: raw.name,
    category: raw.category,
    releaseDate: raw.release_date,
    platforms,
    metacriticScore: raw.metacritic_score,
    description: raw.description,
    rawgId: raw.rawg_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/**
 * Insert or update a single release keyed by rawgId. Returns the stored row.
 * On conflict we refresh the mutable fields and bump updated_at, but preserve
 * the original created_at via COALESCE on the excluded row.
 */
export function upsertGame(game: GameUpsert): GameRow {
  const database = getDb();
  const now = new Date().toISOString();
  const platformsJson = JSON.stringify(game.platforms ?? []);

  const stmt = database.prepare(`
    INSERT INTO games_table (
      steam_id, name, category, release_date, platforms_json,
      metacritic_score, description, rawg_id, created_at, updated_at
    ) VALUES (
      @steamId, @name, @category, @releaseDate, @platformsJson,
      @metacriticScore, @description, @rawgId, @now, @now
    )
    ON CONFLICT(rawg_id) DO UPDATE SET
      steam_id         = excluded.steam_id,
      name             = excluded.name,
      category         = excluded.category,
      release_date     = excluded.release_date,
      platforms_json   = excluded.platforms_json,
      metacritic_score = excluded.metacritic_score,
      description       = excluded.description,
      updated_at        = excluded.updated_at
    RETURNING *;
  `);

  const raw = stmt.get({
    steamId: game.steamId ?? null,
    name: game.name,
    category: game.category,
    releaseDate: game.releaseDate ?? null,
    platformsJson,
    metacriticScore: game.metacriticScore ?? null,
    description: game.description ?? null,
    rawgId: game.rawgId,
    now,
  }) as RawGameRow;

  return decodeRow(raw);
}

/** Upsert many releases in a single transaction. Returns the stored rows. */
export function upsertGames(games: GameUpsert[]): GameRow[] {
  const database = getDb();
  const run = database.transaction((batch: GameUpsert[]) => batch.map(upsertGame));
  return run(games);
}

export interface GameQuery {
  categories?: string[];
  since?: string | null; // inclusive ISO date
  until?: string | null; // inclusive ISO date
  platform?: string | null; // single platform substring filter
  limit?: number;
  offset?: number;
}

/**
 * Read releases back out of the DB with the same filters the /releases route
 * exposes. Used as the cold-start fallback when the RAWG cache is empty.
 */
export function queryGames(q: GameQuery): GameRow[] {
  const database = getDb();
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (q.categories && q.categories.length > 0) {
    const placeholders = q.categories.map((_, i) => `@cat${i}`);
    clauses.push(`category IN (${placeholders.join(', ')})`);
    q.categories.forEach((c, i) => {
      params[`cat${i}`] = c;
    });
  }
  if (q.since) {
    clauses.push('release_date >= @since');
    params.since = q.since;
  }
  if (q.until) {
    clauses.push('release_date <= @until');
    params.until = q.until;
  }
  if (q.platform) {
    // platforms_json is a JSON array of strings; a LIKE on the text is a cheap
    // contains-check that's good enough for a single-tenant dashboard.
    clauses.push('platforms_json LIKE @platform');
    params.platform = `%"${q.platform}"%`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
  const offset = Math.max(0, q.offset ?? 0);
  params.limit = limit;
  params.offset = offset;

  const rows = database
    .prepare(
      `SELECT * FROM games_table ${where}
       ORDER BY release_date DESC NULLS LAST, id DESC
       LIMIT @limit OFFSET @offset;`,
    )
    .all(params) as RawGameRow[];

  return rows.map(decodeRow);
}

/** Total count of stored releases — handy for monitoring/diagnostics. */
export function countGames(): number {
  const database = getDb();
  const row = database.prepare('SELECT COUNT(*) AS n FROM games_table;').get() as {
    n: number;
  };
  return row.n;
}

/**
 * Look up stored games by their rawg_id. Returns only the rows that exist;
 * unknown rawgIds are silently dropped (the caller decides how to handle a
 * miss). Used by the recommendations route to resolve the rawgIds in a request
 * body to internal games_table.id values (the recommendations FK target).
 */
export function getGamesByRawgIds(rawgIds: number[]): GameRow[] {
  if (rawgIds.length === 0) return [];
  const database = getDb();
  const placeholders = rawgIds.map((_, i) => `@id${i}`).join(', ');
  const params: Record<string, number> = {};
  rawgIds.forEach((id, i) => {
    params[`id${i}`] = id;
  });
  const rows = database
    .prepare(`SELECT * FROM games_table WHERE rawg_id IN (${placeholders});`)
    .all(params) as RawGameRow[];
  return rows.map(decodeRow);
}

/** A cached recommendation joined back to the game it scores. */
export interface RecommendationRow {
  gameId: number; // games_table.id
  rawgId: number;
  gameName: string;
  confidenceScore: number;
  reasoning: string;
  generatedAt: string;
  expiresAt: string;
}

interface RawRecommendationRow {
  game_id: number;
  rawg_id: number;
  name: string;
  confidence_score: number;
  reasoning: string;
  generated_at: string;
  expires_at: string;
}

/**
 * Read non-expired recommendations for the given internal game ids. A row is a
 * cache hit only when expires_at is strictly in the future. If a game has
 * multiple stored rows (e.g. a refresh happened), the newest by generated_at
 * wins.
 */
export function getFreshRecommendations(gameIds: number[]): RecommendationRow[] {
  if (gameIds.length === 0) return [];
  const database = getDb();
  const now = new Date().toISOString();
  const placeholders = gameIds.map((_, i) => `@gid${i}`).join(', ');
  const params: Record<string, string | number> = { now };
  gameIds.forEach((id, i) => {
    params[`gid${i}`] = id;
  });
  const rows = database
    .prepare(
      `SELECT r.game_id, g.rawg_id, g.name, r.confidence_score, r.reasoning,
              r.generated_at, r.expires_at
         FROM recommendations r
         JOIN games_table g ON g.id = r.game_id
        WHERE r.game_id IN (${placeholders})
          AND r.expires_at > @now
        GROUP BY r.game_id
       HAVING r.generated_at = MAX(r.generated_at);`,
    )
    .all(params) as RawRecommendationRow[];
  return rows.map((r) => ({
    gameId: r.game_id,
    rawgId: r.rawg_id,
    gameName: r.name,
    confidenceScore: r.confidence_score,
    reasoning: r.reasoning,
    generatedAt: r.generated_at,
    expiresAt: r.expires_at,
  }));
}

/** Shape callers pass to persist a freshly-computed recommendation. */
export interface RecommendationUpsert {
  gameId: number; // games_table.id
  confidenceScore: number;
  reasoning: string;
  /** TTL expiry as an ISO timestamp; the route sets now + 30 days. */
  expiresAt: string;
}

/**
 * Insert fresh recommendations in a single transaction. We delete any prior
 * rows for the same game_id first so a game has exactly one current row (the
 * table has no unique constraint on game_id, so this keeps reads clean and the
 * table from growing unbounded on repeated refreshes).
 */
export function saveRecommendations(recs: RecommendationUpsert[]): void {
  if (recs.length === 0) return;
  const database = getDb();
  const now = new Date().toISOString();
  const del = database.prepare('DELETE FROM recommendations WHERE game_id = @gameId;');
  const ins = database.prepare(`
    INSERT INTO recommendations (
      game_id, confidence_score, reasoning, generated_at, expires_at
    ) VALUES (
      @gameId, @confidenceScore, @reasoning, @now, @expiresAt
    );
  `);
  const run = database.transaction((batch: RecommendationUpsert[]) => {
    for (const rec of batch) {
      del.run({ gameId: rec.gameId });
      ins.run({
        gameId: rec.gameId,
        confidenceScore: rec.confidenceScore,
        reasoning: rec.reasoning,
        now,
        expiresAt: rec.expiresAt,
      });
    }
  });
  run(recs);
}
