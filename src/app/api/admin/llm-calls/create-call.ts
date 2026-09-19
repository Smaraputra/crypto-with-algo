import { z } from 'zod';

import { intervalToMs } from '@/lib/intervals';
import {
  LlmCall,
  LLM_CALL_INTERVALS,
  llmStyleForInterval,
  signedStrength,
  type ILlmCall,
} from '@/lib/models/llm-call';
import { createPendingOutcomes } from '@/lib/signals/outcome-resolver';
import { SIGNAL_TIERS } from '@/types/signal';

const DUPLICATE_KEY_ERROR_CODE = 11000;
const MAX_AGE_INTERVALS = 2;

export const llmCallBodySchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{5,20}$/),
  interval: z.enum(LLM_CALL_INTERVALS),
  candleTimestamp: z.number().int().positive(),
  tier: z.enum(SIGNAL_TIERS),
  strength: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  rationale: z.string().min(1).max(2000),
  votes: z
    .array(
      z.object({
        role: z.string().min(1).max(40),
        tier: z.enum(SIGNAL_TIERS),
        strength: z.number().min(0).max(100),
        note: z.string().max(500),
      })
    )
    .min(1)
    .max(5),
  model: z.string().min(1).max(80),
  promptVersion: z.string().min(1).max(40),
  inputsHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type LlmCallBody = z.infer<typeof llmCallBodySchema>;

export class FreshnessError extends Error {}

/**
 * A call may only describe a bar that has closed and is no more than two
 * intervals old, so a late run cannot post a call whose horizon has partly
 * elapsed, and every call sits on a real bar open time. Returns the reason
 * or null when fresh.
 */
export function checkFreshness(interval: string, candleTimestamp: number, now: number): string | null {
  const ms = intervalToMs(interval);
  if (candleTimestamp % ms !== 0) return 'candleTimestamp is not a bar open time for this interval';
  const closeTime = candleTimestamp + ms;
  if (closeTime > now) return 'bar not closed yet';
  if (now - closeTime > MAX_AGE_INTERVALS * ms) return `stale: bar closed more than ${MAX_AGE_INTERVALS} intervals ago`;
  return null;
}

/** Idempotent on (symbol, interval, candleTimestamp, promptVersion): a repeat returns the stored call. */
export async function createLlmCall(
  body: LlmCallBody,
  now: number
): Promise<{ call: ILlmCall; created: boolean }> {
  const reason = checkFreshness(body.interval, body.candleTimestamp, now);
  if (reason) throw new FreshnessError(reason);

  const key = {
    symbol: body.symbol,
    interval: body.interval,
    candleTimestamp: body.candleTimestamp,
    promptVersion: body.promptVersion,
  };
  const existing = await LlmCall.findOne(key);
  if (existing) return { call: existing, created: false };

  const tradingStyle = llmStyleForInterval(body.interval);
  let call: ILlmCall;
  try {
    call = await LlmCall.create({ ...body, tradingStyle });
  } catch (err) {
    if ((err as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE) {
      const raced = await LlmCall.findOne(key);
      if (raced) return { call: raced, created: false };
    }
    throw err;
  }

  await createPendingOutcomes(
    [
      {
        _id: call._id,
        symbol: call.symbol,
        interval: call.interval,
        tradingStyle,
        tier: call.tier,
        score: signedStrength(call.tier, call.strength),
        configVersion: 0,
        candleTimestamp: call.candleTimestamp,
      },
    ],
    'llm'
  );

  return { call, created: true };
}
