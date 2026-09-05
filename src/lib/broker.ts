/**
 * The one place this service talks to Claude.
 *
 * It holds no Anthropic key. Every call goes to the ai-broker on the mini,
 * which decides whether it runs on Devon's Claude Max subscription or on a
 * metered API key, enforces the monthly budget, and writes an audit line.
 *
 * Why not just keep the SDK here: deciding subscription-vs-API in this file
 * would mean this service knowing Anthropic's licence terms, and every other
 * service knowing them too, and all of them drifting apart. The broker asks the
 * platform who can actually reach an app — from the grant tables, not from a
 * config field — and refuses the subscription path if the answer is anything
 * other than "only administrators".
 *
 * The seam is one function, structured output only, because everything this
 * service asks Claude for has a shape.
 */

import { optionalEnv } from './env.js';

const BROKER_URL = optionalEnv('BROKER_URL') ?? 'http://172.18.0.1:8610';
const APP_ID = optionalEnv('BROKER_APP_ID') ?? 'games';

/**
 * The subscription path shells out to the Claude CLI, which is slower than the
 * API. Scoring a full candidate list is the longest call this service makes.
 */
const TIMEOUT_MS = Number(optionalEnv('BROKER_TIMEOUT_MS') ?? 240_000);

/** A tool definition, minus the SDK type that used to supply it. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

/**
 * Ask Claude for an answer shaped by `schema`, and get it back parsed.
 *
 * The broker guarantees the result is valid JSON in the requested shape or it
 * fails — so callers never parse prose and never see a half-finished tool call.
 */
export async function askStructured<T>(
  prompt: string,
  schema: Record<string, unknown>,
  maxTokens: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BROKER_URL}/v1/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: APP_ID,
        prompt,
        schema,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    throw new BrokerError(
      aborted
        ? `the ai-broker did not answer within ${TIMEOUT_MS / 1000}s`
        : `could not reach the ai-broker: ${(err as Error).message}`,
      504,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Pass the broker's own reason through. "budget_exceeded" and
    // "max_not_permitted" are things a person can act on; a bare 502 is not.
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; detail?: unknown };
      detail = String(body.detail ?? body.error ?? detail);
    } catch {
      /* a non-JSON error body is still an error; the status carries it */
    }
    throw new BrokerError(`ai-broker refused: ${detail}`, res.status);
  }

  const body = (await res.json()) as { data?: unknown };
  if (!body.data || typeof body.data !== 'object') {
    throw new BrokerError('the ai-broker returned no structured answer', 502);
  }
  return body.data as T;
}
