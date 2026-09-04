/**
 * A/B test: Haiku vs Sonnet for game recommendations.
 *
 * Uses a representative taste profile based on the user's actual preferences
 * and a mix of candidates that should produce differentiated scores.
 * Run with: npx tsx scripts/model-compare.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Load .env manually (no dotenv dependency needed)
try {
  const env = readFileSync(join(import.meta.dirname, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch { /* .env not present, rely on existing env vars */ }

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// ── Representative taste profile ────────────────────────────────────────────

const TASTE_PROFILE = `
Most-played Steam games:
1. Baldur's Gate 3 — 200h
2. Dark Souls III — 120h
3. Elden Ring — 110h
4. Monster Hunter: World — 90h
5. Divinity: Original Sin 2 — 80h

User-provided taste context (weight equally with playtime):

Favorite games not reflected in Steam (other platforms, or where playtime understates enjoyment):
Tales of Arise, FFXIV, Kingdom Hearts, Chained Echoes, FFX, FFXII, WoW, Dark Souls 1 & 2

What the user values most in games (self-reported):
• story & narrative depth
• build depth & character systems
• combat feel & mechanics
• emotional impact

Additional context:
FFXII specifically for its Gambit system and job build depth, not its story. FFXIV and WoW for
the deep world-building and social content, not necessarily the grind. Chained Echoes is one of
my favorite games — indie JRPG with excellent layered combat systems and a great story.
`.trim();

// ── Candidate games ──────────────────────────────────────────────────────────
// Deliberately mixed: clear fits, arguable fits, clear misses.

const CANDIDATES = [
  {
    rawgId: 1,
    desc: 'Metaphor: ReFantazio | category: rpg | metacritic: 94 | avg community playtime: 85h | about: Turn-based JRPG from Atlus (Persona series). Deep social systems, rich political narrative, job/archetype build system with party customization. Emotionally resonant story set in a fantasy kingdom.',
  },
  {
    rawgId: 2,
    desc: 'Final Fantasy VII Rebirth | category: rpg | metacritic: 92 | avg community playtime: 80h | about: Action-RPG sequel/remake with deep materia build system, real-time combat with strategic party switching, emotionally heavy narrative, and massive open world content.',
  },
  {
    rawgId: 3,
    desc: 'Eiyuden Chronicle: Hundred Heroes | category: rpg | metacritic: 76 | avg community playtime: 50h | about: Classic JRPG spiritual successor to Suikoden. Turn-based combat, 100+ recruitable characters, town-building, story-driven. Indie scale but JRPG depth.',
  },
  {
    rawgId: 4,
    desc: 'Lies of P | category: action | metacritic: 80 | avg community playtime: 28h | about: Soulslike action RPG. Precise, demanding melee combat, weapon assembly system, gothic atmosphere. Story retelling of Pinocchio. More combat-focused than narrative-focused.',
  },
  {
    rawgId: 5,
    desc: 'Sea of Stars | category: indie | metacritic: 85 | avg community playtime: 30h | about: Indie turn-based JRPG inspired by Chrono Trigger and Super Mario RPG. Charming story, timed combat mechanics, beautiful pixel art. Lighter in build complexity than Chained Echoes.',
  },
  {
    rawgId: 6,
    desc: 'Dave the Diver | category: indie | metacritic: 89 | avg community playtime: 30h | about: Hybrid indie — daytime diving action, nighttime sushi restaurant management. Charming characters, light story, no deep build systems. Very different from traditional RPGs.',
  },
  {
    rawgId: 7,
    desc: 'EA Sports FC 25 | category: sports | metacritic: 73 | avg community playtime: 210h | about: Annual football (soccer) simulation. Ultimate Team card-collecting mode drives high playtime. Competitive multiplayer focus. No narrative, no build systems in the RPG sense.',
  },
  {
    rawgId: 8,
    desc: 'Like a Dragon: Ishin! | category: action | metacritic: 77 | avg community playtime: 35h | about: Yakuza series spinoff set in Edo-period Japan. Turn-based and action combat hybrid, deep character progression, substory-heavy narrative, strong emotional beats. Like a Dragon series DNA.',
  },
];

// ── Scoring tool ─────────────────────────────────────────────────────────────

const SCORE_TOOL: Anthropic.Tool = {
  name: 'submit_recommendations',
  description: 'Submit a confidence score and reasoning for every candidate game.',
  input_schema: {
    type: 'object' as const,
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rawgId:          { type: 'integer' },
            confidenceScore: { type: 'integer' },
            reasoning:       { type: 'string' },
          },
          required: ['rawgId', 'confidenceScore', 'reasoning'],
        },
      },
    },
    required: ['recommendations'],
  },
};

function buildPrompt(): string {
  const candidateList = CANDIDATES.map((c) => `- ${c.desc}`).join('\n');
  return [
    'You help a single user decide which upcoming/recent game releases they will enjoy.',
    '',
    TASTE_PROFILE,
    '',
    'Score each candidate 0-100 for how much THIS user will enjoy it.',
    'Give one to two sentences of reasoning grounded in their specific taste profile.',
    'Call submit_recommendations exactly once with an entry for every candidate.',
    '',
    'When scoring, factor in content depth vs. the user\'s engagement habits.',
    'Story-driven games (JRPGs, narrative RPGs) have predictable avg playtimes reflecting',
    'completion time, not grind depth — do not penalize them for "normal" runtimes.',
    '',
    'Candidates:',
    candidateList,
  ].join('\n');
}

// ── Run both models ───────────────────────────────────────────────────────────

type Rec = { rawgId: number; confidenceScore: number; reasoning: string };

async function runModel(model: string): Promise<{ recs: Rec[]; inputTokens: number; outputTokens: number; ms: number }> {
  const start = Date.now();
  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [SCORE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_recommendations' },
    messages: [{ role: 'user', content: buildPrompt() }],
  });

  const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const raw = (toolUse?.input as any)?.recommendations;
  const recs: Rec[] = Array.isArray(raw) ? [...raw].sort((a, b) => b.confidenceScore - a.confidenceScore) : [];

  return {
    recs,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    ms: Date.now() - start,
  };
}

function cost(model: string, input: number, output: number): string {
  // Haiku 4.5: $1/M input, $5/M output
  // Sonnet 4.6: $3/M input, $15/M output
  const [iRate, oRate] = model.includes('haiku') ? [1, 5] : [3, 15];
  const total = (input / 1_000_000) * iRate + (output / 1_000_000) * oRate;
  return `$${total.toFixed(5)}`;
}

function gameTitle(rawgId: number): string {
  return CANDIDATES.find((c) => c.rawgId === rawgId)?.desc.split(' | ')[0] ?? `Game ${rawgId}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const HAIKU  = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

console.log('Running Haiku...');
const haiku = await runModel(HAIKU);
console.log('Running Sonnet...');
const sonnet = await runModel(SONNET);

const WIDTH = 100;
const divider = '─'.repeat(WIDTH);

console.log('\n' + '═'.repeat(WIDTH));
console.log(' MODEL COMPARISON — Game Recommendations');
console.log('═'.repeat(WIDTH));
console.log(`  Haiku  — ${haiku.inputTokens} in / ${haiku.outputTokens} out — ${cost(HAIKU, haiku.inputTokens, haiku.outputTokens)} — ${haiku.ms}ms`);
console.log(`  Sonnet — ${sonnet.inputTokens} in / ${sonnet.outputTokens} out — ${cost(SONNET, sonnet.inputTokens, sonnet.outputTokens)} — ${sonnet.ms}ms`);
console.log('═'.repeat(WIDTH));

// Build a merged list sorted by average score
const allIds = [...new Set([...haiku.recs.map(r => r.rawgId), ...sonnet.recs.map(r => r.rawgId)])];
const merged = allIds.map((id) => {
  const h = haiku.recs.find((r) => r.rawgId === id);
  const s = sonnet.recs.find((r) => r.rawgId === id);
  return { id, h, s, avg: ((h?.confidenceScore ?? 0) + (s?.confidenceScore ?? 0)) / 2 };
}).sort((a, b) => b.avg - a.avg);

for (const { id, h, s } of merged) {
  const title = gameTitle(id);
  const hScore = h ? String(h.confidenceScore).padStart(3) : ' — ';
  const sScore = s ? String(s.confidenceScore).padStart(3) : ' — ';
  const diff = h && s ? s.confidenceScore - h.confidenceScore : 0;
  const diffStr = diff === 0 ? '   =' : diff > 0 ? ` +${diff}`.padStart(4) : ` ${diff}`.padStart(4);

  console.log(`\n${divider}`);
  console.log(`  ${title}`);
  console.log(`  Haiku ${hScore}  Sonnet ${sScore}  Δ${diffStr}`);
  console.log(divider);
  if (h) console.log(`  [H] ${h.reasoning}`);
  if (s) console.log(`  [S] ${s.reasoning}`);
}

console.log('\n' + '═'.repeat(WIDTH));
console.log(' SUMMARY');
console.log('═'.repeat(WIDTH));

const hTotal = haiku.recs.reduce((s, r) => s + r.confidenceScore, 0) / haiku.recs.length;
const sTotal = sonnet.recs.reduce((s, r) => s + r.confidenceScore, 0) / sonnet.recs.length;
console.log(`  Haiku  avg score: ${hTotal.toFixed(1)}  cost: ${cost(HAIKU, haiku.inputTokens, haiku.outputTokens)}  latency: ${haiku.ms}ms`);
console.log(`  Sonnet avg score: ${sTotal.toFixed(1)}  cost: ${cost(SONNET, sonnet.inputTokens, sonnet.outputTokens)}  latency: ${sonnet.ms}ms`);
console.log(`  Cost multiplier: ${(
  ((sonnet.inputTokens / 1_000_000) * 3 + (sonnet.outputTokens / 1_000_000) * 15) /
  ((haiku.inputTokens  / 1_000_000) * 1 + (haiku.outputTokens  / 1_000_000) * 5)
).toFixed(1)}x`);
console.log('═'.repeat(WIDTH));
