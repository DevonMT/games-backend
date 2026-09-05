/**
 * Who is calling this API.
 *
 * Two doors, both of which prove identity rather than merely possessing a
 * password shared by every caller:
 *
 *   The platform gateway. nginx authenticates the session against
 *   devondoes.dev, then injects the email. Preferred, and now the only route
 *   the tunnel offers.
 *
 *   Cloudflare Access. Kept because it costs nothing and fails closed; there is
 *   no Access application in front of this service any more, so in practice it
 *   never fires.
 *
 * The shared secret is gone. It was a single bearer token that every caller
 * held, pasted into each device, identifying nobody -- so a leak anywhere meant
 * a leak everywhere, with no way to tell who had used it or to revoke one
 * holder. Access to this service is now a grant in the platform, revocable per
 * person, and every request carries a real identity into `userEmail`.
 */

import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { optionalEnv } from '../lib/env.js';
import { accessConfigured, accessEmail } from './access.js';

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
 * through. But this service sits on a Docker network with other containers, and
 * any of them could call it directly with a header of their choosing -- so
 * X-Gateway-Token is a shared secret proving the request actually came through
 * the gateway. Without it, trusting the identity header would mean trusting
 * every container on the network to be honest about who it is.
 */
function platformEmail(c: Context): string | null {
  const expected = optionalEnv('GATEWAY_TOKEN');
  if (!expected) return null;
  const provided = c.req.header('x-gateway-token');
  if (!provided || !safeEqual(provided, expected)) return null;
  const email = c.req.header('x-platform-user')?.trim();
  return email ? email : null;
}

/** Rejects anything that cannot say who it is. */
export async function requireIdentity(c: Context, next: Next): Promise<Response | void> {
  // The gateway first: it is the door this service is actually behind.
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

  // Fail closed. With no door configured at all this is a deployment mistake,
  // and saying so is more useful than a 401 that looks like a bad password.
  if (!optionalEnv('GATEWAY_TOKEN') && !accessConfigured()) {
    return c.json(
      { error: 'Server misconfigured: neither GATEWAY_TOKEN nor ACCESS_AUD is set.' },
      503,
    );
  }
  return c.json({ error: 'Sign in to use this.' }, 401);
}
