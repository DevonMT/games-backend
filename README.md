# games-backend

Backend API for the game-release tracking dashboard at `devontroedel.com/games`.

Built with [Hono](https://hono.dev) + TypeScript. Runs locally on Node, deploys
to Vercel (or any Node host like Railway).

## Status

| Task | Endpoint(s) | State |
| ---- | ----------- | ----- |
| 1 — Steam integration | `GET /steam/library`, `POST /steam/library/refresh`, `GET /steam/sync-status` | ✅ done |
| 2 — RAWG releases | `GET /releases` | ✅ done |
| 3 — Claude recommendations | `POST /recommendations` | ⏳ next |

## Endpoints (Task 1)

All `/steam/*` routes require the header `x-api-secret: <SHARED_API_SECRET>`.
`GET /health` is public.

### `GET /steam/library`
Returns the configured Steam account's owned games (cached 1 hour).

```jsonc
{
  "steamId": "765611...",
  "gameCount": 312,
  "games": [
    {
      "appId": 1086940,
      "name": "Baldur's Gate 3",
      "hoursPlayed": 142.5,
      "hoursLast2Weeks": 6.1,
      "imageUrl": "https://cdn.cloudflare.steamstatic.com/steam/apps/1086940/header.jpg"
    }
  ],
  "fetchedAt": "2026-06-14T17:00:00.000Z",
  "cache": { "cached": true, "expiresAt": "2026-06-14T18:00:00.000Z" }
}
```

Games are sorted by `hoursPlayed` descending — most-played first — which is the
ordering the Claude recommender (Task 3) wants for its prompt.

### `POST /steam/library/refresh`
Forces a fresh fetch from Steam, bypassing and repopulating the cache. Use this
behind a "Sync now" button.

### `GET /steam/sync-status`
`{ "lastSteamSync": "...ISO...", "stale": false, "ttlSeconds": 3600 }`

### `GET /health`
`{ "status": "ok", ... }` — no auth, for uptime checks.

## Endpoints (Task 2)

### `GET /releases`
Recent and upcoming releases from the [RAWG](https://rawg.io) catalog, filtered
by category, date range, and platform. Requires `x-api-secret`.

Query params (all optional):

| Param | Example | Default | Notes |
| ----- | ------- | ------- | ----- |
| `categories` | `indie,AAA` | (all) | Comma-separated. Unknown values are ignored. Valid: `AAA`, `indie`, `early_access`, `multiplayer`, `single_player`, `action`, `rpg`, `strategy`, `sports`, `simulation`, `other`. |
| `since` | `2025-01-01` | today − 90d | Inclusive `YYYY-MM-DD`. |
| `until` | `2025-12-31` | today + 180d | Inclusive `YYYY-MM-DD`. |
| `platforms` | `Steam` | (any) | Single platform name (e.g. `PC`, `Steam`, `PlayStation 5`, `Nintendo Switch`). |
| `page` | `2` | `1` | 50 results per page. |

```jsonc
{
  "releases": [
    {
      "rawgId": 58134,
      "name": "Marvel's Spider-Man 2",
      "category": "AAA",
      "categories": ["AAA", "action"],
      "releaseDate": "2025-10-20",
      "platforms": ["PlayStation 5", "PC"],
      "metacriticScore": 90,
      "description": "Peter and Miles return...",
      "imageUrl": "https://media.rawg.io/.../spiderman.jpg"
    }
  ],
  "page": 1,
  "pageSize": 50,
  "totalCount": 1234,
  "hasNext": true,
  "filters": { "categories": ["AAA"], "since": "2025-01-01", "until": "2025-12-31", "platform": "Steam" },
  "source": "rawg",
  "cache": { "cached": true, "expiresAt": "2026-06-21T17:00:00.000Z" }
}
```

**Categories** are inferred from RAWG genres + tags (and a reach-based `AAA`
heuristic using RAWG's `added` count). `category` is the single primary label
stored in SQLite; `categories` is the full inferred set for richer client-side
filtering.

**Caching & persistence.** Each `(filters, page)` tuple is cached in memory for
**7 days** and every fetched page is upserted into a local SQLite `games_table`
(keyed by `rawgId`). If RAWG is unavailable (rate-limited / outage), the route
falls back to whatever matching rows are already stored and returns
`"source": "cache-fallback"` with a `warning`, so the dashboard degrades
gracefully instead of erroring.

## Setup

```bash
npm install
cp .env.example .env   # then fill it in
npm run dev            # tsx watch, serves http://localhost:8787
```

### Required env vars (Task 1)

| Var | Where to get it |
| --- | --------------- |
| `STEAM_API_KEY` | https://steamcommunity.com/dev/apikey |
| `STEAM_USER_ID` | 64-bit SteamID — resolve at https://steamid.io/ |
| `SHARED_API_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ALLOWED_ORIGINS` | comma-separated CORS origins (defaults to localhost dev) |

> **Important:** the Steam account's *Game details* privacy must be **Public**
> for the library to be readable, even with a valid API key. A private profile
> returns HTTP 422 with a descriptive error.

### Required env vars (Task 2)

| Var | Where to get it |
| --- | --------------- |
| `RAWG_API_KEY` | Free key from https://rawg.io/apidocs (sign up → API key). |
| `DATABASE_PATH` | Optional. SQLite file path. Defaults to `./data/games.db`. On Vercel set to `/tmp/games.db` (only `/tmp` is writable). |

> **SQLite on Vercel:** the serverless filesystem is read-only except `/tmp`,
> which is ephemeral per instance — so there the DB acts as a warm-instance
> cache, not durable storage (acceptable for this single-tenant dashboard).
> Point `DATABASE_PATH` at a mounted volume on Railway/Fly for true durability.
> `better-sqlite3` is a native module; Vercel's Node builder compiles it on
> deploy.

### Quick test

```bash
# Health (no auth)
curl http://localhost:8787/health

# Library (auth required)
curl -H "x-api-secret: $SHARED_API_SECRET" http://localhost:8787/steam/library

# Releases (auth required)
curl -H "x-api-secret: $SHARED_API_SECRET" \
  "http://localhost:8787/releases?categories=indie,AAA&since=2025-01-01&until=2025-12-31&platforms=Steam"
```

## Deploy

### Vercel
1. Import this repo in Vercel.
2. Add every var from `.env.example` under Project → Settings → Environment Variables.
3. Deploy. `vercel.json` rewrites all traffic into `api/index.ts`.

### Railway / other Node host
`npm run build` then `npm start` (serves `dist/server.js`). Set env vars in the
platform dashboard. Default port is `8787` (override with `PORT`).

## Architecture notes

- `src/app.ts` builds the Hono app; `src/server.ts` (Node) and `api/index.ts`
  (Vercel) are thin entry points that share it.
- `src/lib/cache.ts` is a dependency-free in-memory TTL cache with single-flight
  loading. Swap for Redis later if multi-instance state becomes a problem.
- `src/lib/rawg.ts` is the RAWG client: date-range fetch, genre/tag → category
  mapping, platform resolution, normalization to our release shape.
- `src/lib/db.ts` opens SQLite lazily (`better-sqlite3`) and owns the schema:
  `games_table` plus the `user_library` and `recommendations` tables whose
  foreign keys target it (populated in later tasks). The DB is the persistence
  layer behind `/releases` and the join target for the Task 3 recommender.
- Auth is a constant-time shared-secret check (`src/middleware/auth.ts`),
  independent of the frontend's GitHub OAuth (defense in depth, plan Risk 3).
