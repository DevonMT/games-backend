/**
 * User preferences routes.
 *
 *   GET  /preferences   -> return stored taste profile
 *   POST /preferences   -> save taste profile (body: { favoritesNote, values, notes })
 *
 * Gated behind requireApiSecret (wired in app.ts).
 * Stored as a single row in user_preferences so prefs survive across devices.
 */

import { Hono } from 'hono';
import { getPreferences, setPreferences } from '../lib/db.js';

export const preferencesRoutes = new Hono();

preferencesRoutes.get('/', (c) => {
  return c.json({ prefs: getPreferences() });
});

preferencesRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be valid JSON.' }, 400);
  }

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Body must be a JSON object.' }, 400);
  }

  setPreferences(body as Record<string, unknown>);
  return c.json({ ok: true });
});
