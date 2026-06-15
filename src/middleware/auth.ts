/**
 * Shared-secret auth middleware.
 *
 * Per the plan's Risk 3 mitigation: even though the frontend gates access with
 * GitHub OAuth, the backend independently verifies a shared secret so the API
 * can't be called by anyone who fakes a login. The frontend (server-side proxy
 * in api.ts) attaches the secret in the `x-api-secret` header; it is never
 * exposed to the browser.
 *
 * Comparison is constant-time to avoid leaking the secret via timing.
 */

import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { optionalEnv } from '../lib/env.js';

const HEADER = 'x-api-secret';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws if lengths differ, so guard first. Comparing a
  // dummy buffer of equal length keeps the timing roughly constant either way.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function requireApiSecret(c: Context, next: Next): Promise<Response | void> {
  const expected = optionalEnv('SHARED_API_SECRET');

  // Fail closed: if the server has no secret configured, reject everything
  // rather than silently running an open API.
  if (!expected) {
    return c.json(
      { error: 'Server misconfigured: SHARED_API_SECRET is not set.' },
      503,
    );
  }

  const provided = c.req.header(HEADER);
  if (!provided || !safeEqual(provided, expected)) {
    return c.json({ error: 'Unauthorized.' }, 401);
  }

  await next();
}
