// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

function makeOutcomeData(overrides: Record<string, unknown> = {}) {
  return {
    signalId: new mongoose.Types.ObjectId(),
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    tier: 'buy',
    score: 45,
    configVersion: 3,
    candleTimestamp: 1_700_000_000_000,
    horizonBars: 24,
    resolveAt: 1_700_000_000_000 + 25 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe('SignalOutcome model', () => {
  async function getModel() {
    const { SignalOutcome } = await import('./signal-outcome');
    return SignalOutcome;
  }

  it('creates an outcome with required fields, defaulting status to pending', async () => {
    const SignalOutcome = await getModel();
    const outcome = await SignalOutcome.create(makeOutcomeData());

    expect(outcome.symbol).toBe('BTCUSDT');
    expect(outcome.interval).toBe('1h');
    expect(outcome.tradingStyle).toBe('day_trading');
    expect(outcome.tier).toBe('buy');
    expect(outcome.score).toBe(45);
    expect(outcome.configVersion).toBe(3);
    expect(outcome.candleTimestamp).toBe(1_700_000_000_000);
    expect(outcome.horizonBars).toBe(24);
    expect(outcome.status).toBe('pending');
    expect(outcome.entryPrice).toBeNull();
    expect(outcome.forwardReturnPercent).toBeNull();
    expect(outcome.mfePercent).toBeNull();
    expect(outcome.maePercent).toBeNull();
    expect(outcome.resolvedAt).toBeNull();
    expect(outcome.createdAt).toBeDefined();
  });

  it('rejects missing required fields', async () => {
    const SignalOutcome = await getModel();
    await expect(SignalOutcome.create({ symbol: 'BTCUSDT' })).rejects.toThrow();
  });

  it('rejects an invalid trading style', async () => {
    const SignalOutcome = await getModel();
    await expect(
      SignalOutcome.create(makeOutcomeData({ tradingStyle: 'invalid' }))
    ).rejects.toThrow();
  });

  it('rejects an invalid tier', async () => {
    const SignalOutcome = await getModel();
    await expect(
      SignalOutcome.create(makeOutcomeData({ tier: 'invalid_tier' }))
    ).rejects.toThrow();
  });

  it('rejects an invalid status', async () => {
    const SignalOutcome = await getModel();
    await expect(
      SignalOutcome.create(makeOutcomeData({ status: 'invalid_status' }))
    ).rejects.toThrow();
  });

  it('stores resolved values when set', async () => {
    const SignalOutcome = await getModel();
    const resolvedAt = new Date();
    const outcome = await SignalOutcome.create(
      makeOutcomeData({
        status: 'resolved',
        entryPrice: 50000,
        forwardReturnPercent: 1.5,
        mfePercent: 2.1,
        maePercent: -0.8,
        resolvedAt,
      })
    );

    expect(outcome.status).toBe('resolved');
    expect(outcome.entryPrice).toBe(50000);
    expect(outcome.forwardReturnPercent).toBe(1.5);
    expect(outcome.mfePercent).toBe(2.1);
    expect(outcome.maePercent).toBe(-0.8);
    expect(outcome.resolvedAt!.getTime()).toBe(resolvedAt.getTime());
  });

  it('enforces a unique index on signalId', async () => {
    const SignalOutcome = await getModel();
    await SignalOutcome.syncIndexes();

    const signalId = new mongoose.Types.ObjectId();
    await SignalOutcome.create(makeOutcomeData({ signalId }));
    await expect(
      SignalOutcome.create(makeOutcomeData({ signalId }))
    ).rejects.toThrow();
  });

  it('verifies indexes exist', async () => {
    const SignalOutcome = await getModel();
    await SignalOutcome.syncIndexes();
    const indexes = await SignalOutcome.collection.indexes();

    const indexKeys = indexes.map((idx) => Object.keys(idx.key));
    expect(indexKeys).toContainEqual(['signalId']);
    expect(indexKeys).toContainEqual(['status', 'resolveAt']);
    expect(indexKeys).toContainEqual(['symbol', 'tradingStyle', 'createdAt']);
    expect(indexKeys).toContainEqual(['createdAt']);

    const signalIdIndex = indexes.find(
      (idx) => Object.keys(idx.key).join() === 'signalId'
    );
    expect(signalIdIndex!.unique).toBe(true);

    const ttlIndex = indexes.find(
      (idx) => Object.keys(idx.key).join() === 'createdAt'
    );
    expect(ttlIndex!.expireAfterSeconds).toBe(365 * 24 * 60 * 60);
  });
});
