import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { LlmCall } from '@/lib/models/llm-call';
import { SignalOutcome } from '@/lib/models/signal-outcome';
import { checkFreshness, createLlmCall, llmCallBodySchema } from './create-call';

const HOUR = 3600000;
const T0 = 1789689600000;

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await LlmCall.syncIndexes();
  await SignalOutcome.syncIndexes();
});
afterEach(async () => {
  await LlmCall.deleteMany({});
  await SignalOutcome.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

function body(overrides: Record<string, unknown> = {}) {
  return llmCallBodySchema.parse({
    symbol: 'BTCUSDT',
    interval: '1h',
    candleTimestamp: T0,
    tier: 'sell',
    strength: 70,
    confidence: 60,
    rationale: 'Funding crowded long into resistance.',
    votes: [{ role: 'risk_officer', tier: 'sell', strength: 70, note: 'Crowded.' }],
    model: 'claude-sonnet-5',
    promptVersion: 'v1',
    inputsHash: 'b'.repeat(64),
    ...overrides,
  });
}

describe('checkFreshness', () => {
  it('accepts a closed bar within two intervals and rejects unaligned, open, and stale bars', () => {
    expect(checkFreshness('1h', T0, T0 + HOUR + 60000)).toBeNull();
    expect(checkFreshness('1h', T0, T0 + 3 * HOUR)).toBeNull();
    expect(checkFreshness('1h', T0 + 1, T0 + 2 * HOUR)).toMatch(/bar open time/);
    expect(checkFreshness('1h', T0, T0 + 30 * 60000)).toMatch(/not closed/);
    expect(checkFreshness('1h', T0, T0 + 3 * HOUR + 1)).toMatch(/stale/);
  });
});

describe('createLlmCall', () => {
  it('creates the call and one pending llm outcome with the signed strength', async () => {
    const { call, created } = await createLlmCall(body(), T0 + HOUR + 60000);
    expect(created).toBe(true);
    expect(call.tradingStyle).toBe('day_trading');
    const outcome = await SignalOutcome.findOne({ signalId: call._id }).lean();
    expect(outcome).toMatchObject({ source: 'llm', tier: 'sell', score: -70, configVersion: 1, horizonBars: 24, status: 'pending' });
  });

  it('returns the existing call without a second outcome on a repeated post', async () => {
    const first = await createLlmCall(body(), T0 + HOUR + 60000);
    const second = await createLlmCall(body({ tier: 'buy' }), T0 + HOUR + 120000);
    expect(second.created).toBe(false);
    expect(String(second.call._id)).toBe(String(first.call._id));
    expect(second.call.tier).toBe('sell');
    expect(await SignalOutcome.countDocuments({})).toBe(1);
  });

  it('rejects a stale bar before writing anything', async () => {
    await expect(createLlmCall(body(), T0 + 4 * HOUR)).rejects.toThrow(/stale/);
    expect(await LlmCall.countDocuments({})).toBe(0);
  });

  it('writes configVersion as the prompt version number, separating calls across a prompt bump', async () => {
    const { call: v1Call } = await createLlmCall(body({ promptVersion: 'v1' }), T0 + HOUR + 60000);
    const v1Outcome = await SignalOutcome.findOne({ signalId: v1Call._id }).lean();
    expect(v1Outcome).toMatchObject({ configVersion: 1 });

    const { call: v2Call } = await createLlmCall(body({ promptVersion: 'v2' }), T0 + HOUR + 60000);
    const v2Outcome = await SignalOutcome.findOne({ signalId: v2Call._id }).lean();
    expect(v2Outcome).toMatchObject({ configVersion: 2 });
  });
});

describe('llmCallBodySchema', () => {
  it('accepts promptVersion in vN form and rejects any other shape', () => {
    expect(() => body({ promptVersion: 'v1' })).not.toThrow();
    expect(() => body({ promptVersion: 'v23' })).not.toThrow();
    expect(() => body({ promptVersion: 'prompt-a' })).toThrow();
    expect(() => body({ promptVersion: 'v' })).toThrow();
    expect(() => body({ promptVersion: 'V1' })).toThrow();
  });
});
