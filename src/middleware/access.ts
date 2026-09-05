/**
 * Cloudflare Access identity.
 *
 * When this backend is served from the same origin as its front end
 * (games.devondoes.dev), the browser sends the Access cookie automatically and
 * Cloudflare hands the origin a signed JWT in `Cf-Access-Jwt-Assertion`.
 *
 * The JWT is VERIFIED against the team's JWKS rather than trusted on sight:
 * this process also listens on the LAN, so the Cloudflare edge is not the only
 * way to reach it. A header alone proves nothing.
 *
 * Configure with:
 *   ACCESS_TEAM_DOMAIN=devondoes.cloudflareaccess.com
 *   ACCESS_AUD=<the application's Application Audience tag>
 * Leave either unset and Access auth is simply disabled (the shared secret
 * remains the only door), so this is safe to deploy before the Access
 * application exists.
 */

import type { Context } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { optionalEnv } from '../lib/env.js';

const HEADER = 'cf-access-jwt-assertion';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksDomain: string | undefined;

function keySet(teamDomain: string) {
  // Rebuild only if the configured domain changes; the set caches keys itself.
  if (!jwks || jwksDomain !== teamDomain) {
    jwks = createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksDomain = teamDomain;
  }
  return jwks;
}

export function accessConfigured(): boolean {
  return Boolean(optionalEnv('ACCESS_TEAM_DOMAIN') && optionalEnv('ACCESS_AUD'));
}

/**
 * Verified Access email, or null. Never throws — a bad token is simply "not
 * authenticated", so callers can fall through to another auth method.
 */
export async function accessEmail(c: Context): Promise<string | null> {
  const teamDomain = optionalEnv('ACCESS_TEAM_DOMAIN');
  const aud = optionalEnv('ACCESS_AUD');
  if (!teamDomain || !aud) return null;

  const token = c.req.header(HEADER);
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, keySet(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience: aud,
    });
    // Human logins carry `email`. Service tokens carry `common_name` instead
    // and no email at all — return that so audit logs name the caller rather
    // than saying 'unknown'.
    return (
      (payload.email as string | undefined) ??
      (payload.common_name as string | undefined) ??
      'unknown'
    );
  } catch {
    return null;
  }
}
