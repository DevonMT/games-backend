import postgres from 'postgres';
import { requireEnv } from './env.js';

export const SKILL_TAGS = [
  'Python', 'SQL', 'Data Modeling', 'dbt', 'Orchestration',
  'Warehousing', 'Power BI', 'Streaming', 'General',
] as const;

export type SkillTag = (typeof SKILL_TAGS)[number];
export type Source = 'book' | 'datacamp' | 'dataexpert';

export interface LearnSession {
  id: number;
  loggedAt: string;
  source: Source;
  item: string;
  skills: SkillTag[];
  minutes: number;
  note: string | null;
}

let _sql: ReturnType<typeof postgres> | null = null;

function getSql(): ReturnType<typeof postgres> {
  if (_sql) return _sql;
  const url = requireEnv('DATABASE_URL');
  _sql = postgres(url, { max: 5 });
  return _sql;
}

let _ready = false;

export async function ensureLearnSchema(): Promise<void> {
  if (_ready) return;
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS learn_sessions (
      id        SERIAL  PRIMARY KEY,
      logged_at TEXT    NOT NULL,
      source    TEXT    NOT NULL,
      item      TEXT    NOT NULL,
      skills    TEXT    NOT NULL DEFAULT '[]',
      minutes   INTEGER NOT NULL,
      note      TEXT
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_learn_logged_at ON learn_sessions (logged_at DESC)
  `;
  _ready = true;
}

function decodeRow(row: Record<string, unknown>): LearnSession {
  let skills: SkillTag[] = [];
  try {
    const parsed = JSON.parse(String(row.skills ?? '[]'));
    if (Array.isArray(parsed)) skills = parsed as SkillTag[];
  } catch { /* ignore corrupt JSON */ }
  return {
    id: Number(row.id),
    loggedAt: String(row.logged_at),
    source: String(row.source) as Source,
    item: String(row.item),
    skills,
    minutes: Number(row.minutes),
    note: row.note != null ? String(row.note) : null,
  };
}

export async function insertLearnSession(data: Omit<LearnSession, 'id'>): Promise<number> {
  await ensureLearnSchema();
  const sql = getSql();
  const rows = await sql`
    INSERT INTO learn_sessions (logged_at, source, item, skills, minutes, note)
    VALUES (
      ${data.loggedAt}, ${data.source}, ${data.item},
      ${JSON.stringify(data.skills)}, ${data.minutes}, ${data.note ?? null}
    )
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('INSERT learn_sessions did not return a row.');
  return Number(row.id);
}

export async function getAllLearnSessions(): Promise<LearnSession[]> {
  await ensureLearnSchema();
  const sql = getSql();
  const rows = await sql`SELECT * FROM learn_sessions ORDER BY logged_at DESC`;
  return rows.map(r => decodeRow(r as Record<string, unknown>));
}

export async function deleteLearnSession(id: number): Promise<void> {
  await ensureLearnSchema();
  const sql = getSql();
  await sql`DELETE FROM learn_sessions WHERE id = ${id}`;
}
