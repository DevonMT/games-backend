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
 * Identity injected by the platform gateway.
 *
 * Two headers, and both are needed. X-Platform-User carries the email; the
 * gateway sets it unconditionally so a client cannot smuggle its own value
 * through. But this service sits on a Docker network with other containers,
 * and any of them could call it directly with a header of their choosing --
 * so X-Gateway-Token is a shared secret proving the request actually came
 * through the gateway. Without it, trusting the identity header would mean
 * trusting every container on the network to be honest about who it is.
 */
function platformEmail(c: Context): string | null {
  const expected = optionalEnv('GATEWAY_TOKEN');
  if (!expected) return null;
  const provided = c.req.header('x-gateway-token');
  if (!provided || !safeEqual(provided, expected)) return null;
  const email = c.req.header('x-platform-user')?.trim();
  return email ? email : null;
}

/**
 * Accepts a platform-gateway identity, a verified Cloudflare Access identity,
 * or the shared secret.
 *
 * Access is the preferred door: when the front end is served from this same
 * origin the cookie rides along automatically, so there is no key for anyone to
 * paste or leak. The shared secret is kept so the old key-gated pages on
 * devontroedel.com keep working during migration, and for machine callers.
 * Drop SHARED_API_SECRET once nothing depends on it.
 */
export async function requireApiSecret(c: Context, next: Next): Promise<Response | void> {
  // The gateway is checked first because it is the door this service is meant
  // to be behind now; Access remains only until its application is removed.
  const viaGateway = platformEmail(c);
  if (viaGateway) {
    c.set('userEmail', viaGateway);
    await next();
    return;
  }

  const email = await accessEmail(c);
  if (email) {
    c.set('userEmail', email);
    await next();
    return;
  }

  const expected = optionalEnv('SHARED_API_SECRET');

  // Fail closed: with no door configured, reject everything rather than
  // silently running an open API.
  if (!expected) {
    if (accessConfigured() || optionalEnv('GATEWAY_TOKEN')) {
      return c.json({ error: 'Sign in to use this.' }, 401);
    }
    return c.json(
      { error: 'Server misconfigured: no GATEWAY_TOKEN, no ACCESS_AUD and no SHARED_API_SECRET.' },
      503,
    );
  }

  const provided = c.req.header(HEADER);
  if (!provided || !safeEqual(provided, expected)) {
    return c.json({ error: 'Unauthorized.' }, 401);
  }

  await next();
}
