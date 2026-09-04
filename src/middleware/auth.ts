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
import { accessConfigured, accessEmail } from './access.js';

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

/**
 * Accepts EITHER a verified Cloudflare Access identity OR the shared secret.
 *
 * Access is the preferred door: when the front end is served from this same
 * origin the cookie rides along automatically, so there is no key for anyone to
 * paste or leak. The shared secret is kept so the old key-gated pages on
 * devontroedel.com keep working during migration, and for machine callers.
 * Drop SHARED_API_SECRET once nothing depends on it.
 */
export async function requireApiSecret(c: Context, next: Next): Promise<Response | void> {
  const email = await accessEmail(c);
  if (email) {
    c.set('userEmail', email);
    await next();
    return;
  }

  const expected = optionalEnv('SHARED_API_SECRET');

  // Fail closed: with neither door configured, reject everything rather than
  // silently running an open API.
  if (!expected) {
    if (accessConfigured()) {
      return c.json({ error: 'Sign in to use this.' }, 401);
    }
    return c.json(
      { error: 'Server misconfigured: no ACCESS_AUD and no SHARED_API_SECRET.' },
      503,
    );
  }

  const provided = c.req.header(HEADER);
  if (!provided || !safeEqual(provided, expected)) {
    return c.json({ error: 'Unauthorized.' }, 401);
  }

  await next();
}
