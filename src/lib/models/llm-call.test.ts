import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  LlmCall,
  LLM_CALL_INTERVALS,
  llmStyleForInterval,
  signedStrength,
} from '@/lib/models/llm-call';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await LlmCall.syncIndexes();
});

afterEach(async () => {
  await LlmCall.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

function validCall(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    candleTimestamp: 1789689600000,
    tier: 'buy',
    strength: 60,
    confidence: 55,
    rationale: 'Momentum positive after a pullback into support.',
    votes: [
      { role: 'news_reader', tier: 'neutral', strength: 20, note: 'No material news.' },
      { role: 'regime_classifier', tier: 'buy', strength: 65, note: 'Uptrend, normal vol.' },
      { role: 'risk_officer', tier: 'buy', strength: 50, note: 'Stop below the swing low.' },
    ],
    model: 'claude-sonnet-5',
    promptVersion: 'v1',
    inputsHash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('LlmCall model', () => {
  it('saves a valid call with the default source and a createdAt', async () => {
    const doc = await LlmCall.create(validCall());
    expect(doc.source).toBe('llm-panel');
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.votes).toHaveLength(3);
  });

  it('rejects a second call for the same symbol, interval, bar, and prompt version', async () => {
    await LlmCall.create(validCall());
    await expect(LlmCall.create(validCall({ tier: 'sell' }))).rejects.toMatchObject({ code: 11000 });
  });

  it('allows the same bar under another prompt version', async () => {
    await LlmCall.create(validCall());
    await expect(LlmCall.create(validCall({ promptVersion: 'v2' }))).resolves.toBeDefined();
  });

  it('rejects a tier outside the vocabulary, a strength above 100, and a rationale over 2000 chars', async () => {
    await expect(LlmCall.create(validCall({ tier: 'long' }))).rejects.toThrow(/tier/);
    await expect(LlmCall.create(validCall({ strength: 101 }))).rejects.toThrow(/strength/);
    await expect(LlmCall.create(validCall({ rationale: 'x'.repeat(2001) }))).rejects.toThrow(/rationale/);
  });

  it('rejects an interval outside 1h, 4h, 1d', async () => {
    await expect(LlmCall.create(validCall({ interval: '5m' }))).rejects.toThrow(/interval/);
  });
});

describe('llmStyleForInterval and signedStrength', () => {
  it('maps the three intervals and throws on any other', () => {
    expect(LLM_CALL_INTERVALS).toEqual(['1h', '4h', '1d']);
    expect(llmStyleForInterval('1h')).toBe('day_trading');
    expect(llmStyleForInterval('4h')).toBe('swing_trading');
    expect(llmStyleForInterval('1d')).toBe('position_trading');
    expect(() => llmStyleForInterval('5m')).toThrow(/5m/);
  });

  it('signs strength by tier: sell tiers negative, neutral zero', () => {
    expect(signedStrength('strong_buy', 80)).toBe(80);
    expect(signedStrength('buy', 60)).toBe(60);
    expect(signedStrength('neutral', 40)).toBe(0);
    expect(signedStrength('sell', 60)).toBe(-60);
    expect(signedStrength('strong_sell', 90)).toBe(-90);
  });
});
