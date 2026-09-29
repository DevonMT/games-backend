import { Hono } from 'hono';
import {
  SKILL_TAGS, type Source, type SkillTag,
  insertLearnSession, getAllLearnSessions, deleteLearnSession,
} from '../lib/learnDb.js';

export const learnRoutes = new Hono();

const VALID_SOURCES: Source[] = ['book', 'datacamp', 'dataexpert'];

learnRoutes.post('/sessions', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const { source, item, skills, minutes, note, loggedAt } = body;

  if (!VALID_SOURCES.includes(source as Source)) {
    return c.json({ error: `source must be one of: ${VALID_SOURCES.join(', ')}` }, 400);
  }
  if (typeof item !== 'string' || !item.trim()) {
    return c.json({ error: 'item is required.' }, 400);
  }
  if (!Array.isArray(skills)) {
    return c.json({ error: 'skills must be an array.' }, 400);
  }
  const safeSkills = (skills as unknown[]).filter(
    (s): s is SkillTag => typeof s === 'string' && (SKILL_TAGS as readonly string[]).includes(s),
  );
  const mins = Number(minutes);
  if (!Number.isInteger(mins) || mins < 1 || mins > 600) {
    return c.json({ error: 'minutes must be an integer between 1 and 600.' }, 400);
  }

  // A day other than today is now a normal thing to send (Stacks' "Yesterday").
  // It must be a real instant, not in the future (a little clock skew aside),
  // and within a year -- an unchecked string went straight into the table.
  let when = new Date().toISOString();
  if (loggedAt !== undefined && loggedAt !== null) {
    const t = typeof loggedAt === 'string' ? Date.parse(loggedAt) : NaN;
    if (Number.isNaN(t)) return c.json({ error: 'loggedAt must be a date.' }, 400);
    if (t > Date.now() + 5 * 60_000) return c.json({ error: 'loggedAt cannot be in the future.' }, 400);
    if (t < Date.now() - 366 * 86_400_000) return c.json({ error: 'loggedAt is more than a year ago.' }, 400);
    when = new Date(t).toISOString();
  }

  const id = await insertLearnSession({
    loggedAt: when,
    source: source as Source,
    item: item.trim(),
    skills: safeSkills,
    minutes: mins,
    note: typeof note === 'string' && note.trim() ? note.trim() : null,
  });

  return c.json({ id }, 201);
});

learnRoutes.get('/sessions', async (c) => {
  const sessions = await getAllLearnSessions();
  return c.json({ sessions });
});

learnRoutes.delete('/sessions/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid session id.' }, 400);
  }
  await deleteLearnSession(id);
  return c.json({ deleted: id });
});
