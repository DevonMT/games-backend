/**
 * Centralized environment-variable access.
 *
 * Reading happens lazily (per call) rather than at import time so that the
 * module works in both long-running Node servers and serverless cold starts,
 * and so that tests can mutate process.env. Required keys throw a clear error
 * the first time they're actually needed instead of crashing the whole server
 * on boot — that way the /health endpoint stays up even if a key is missing.
 */

export function optionalEnv(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === '' ? undefined : value;
}

export function requireEnv(key: string): string {
  const value = optionalEnv(key);
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable "${key}". ` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function intEnv(key: string, fallback: number): number {
  const raw = optionalEnv(key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Origins permitted by CORS, parsed from a comma-separated env var. */
export function allowedOrigins(): string[] {
  const raw = optionalEnv('ALLOWED_ORIGINS');
  if (!raw) return ['http://localhost:4321'];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
