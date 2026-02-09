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

function makeSignalData(overrides = {}) {
  return {
    userId: 'user-1',
    symbol: 'BTCUSDT',
    interval: '1h',
    score: 45.5,
    tier: 'buy',
    confidence: 85,
    components: [
      {
        category: 'trend',
        score: 60,
        weight: 0.25,
        weightedScore: 15,
        signals: [
          { name: 'EMA Cross', direction: 'bullish', strength: 70, description: 'EMA12 above EMA26' },
        ],
      },
      {
        category: 'momentum',
        score: 30,
        weight: 0.25,
        weightedScore: 7.5,
        signals: [
          { name: 'RSI', direction: 'bullish', strength: 40, description: 'RSI at 55' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('Signal model', () => {
  async function getSignal() {
    const { Signal } = await import('./signal');
    return Signal;
  }

  it('creates a signal with required fields', async () => {
    const Signal = await getSignal();
    const signal = await Signal.create(makeSignalData());

    expect(signal.userId).toBe('user-1');
    expect(signal.symbol).toBe('BTCUSDT');
    expect(signal.interval).toBe('1h');
    expect(signal.score).toBe(45.5);
    expect(signal.tier).toBe('buy');
    expect(signal.confidence).toBe(85);
    expect(signal.components).toHaveLength(2);
    expect(signal._id).toBeDefined();
  });

  it('stores nested component signals', async () => {
    const Signal = await getSignal();
    const signal = await Signal.create(makeSignalData());

    expect(signal.components[0].category).toBe('trend');
    expect(signal.components[0].signals[0].name).toBe('EMA Cross');
    expect(signal.components[0].signals[0].direction).toBe('bullish');
    expect(signal.components[0].signals[0].strength).toBe(70);
  });

  it('sets timestamps automatically', async () => {
    const Signal = await getSignal();
    const signal = await Signal.create(makeSignalData());

    expect(signal.createdAt).toBeInstanceOf(Date);
    expect(signal.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects invalid tier enum', async () => {
    const Signal = await getSignal();
    await expect(
      Signal.create(makeSignalData({ tier: 'invalid' }))
    ).rejects.toThrow();
  });

  it('rejects missing required fields', async () => {
    const Signal = await getSignal();
    await expect(Signal.create({ userId: 'user-1' })).rejects.toThrow();
  });

  it('queries by userId and symbol', async () => {
    const Signal = await getSignal();
    await Signal.create(makeSignalData());
    await Signal.create(makeSignalData({ symbol: 'ETHUSDT', score: -20 }));
    await Signal.create(makeSignalData({ userId: 'user-2' }));

    const btcSignals = await Signal.find({ userId: 'user-1', symbol: 'BTCUSDT' });
    expect(btcSignals).toHaveLength(1);

    const user1Signals = await Signal.find({ userId: 'user-1' });
    expect(user1Signals).toHaveLength(2);
  });

  it('sorts by createdAt descending', async () => {
    const Signal = await getSignal();
    await Signal.create(makeSignalData({ score: 10 }));
    await new Promise((r) => setTimeout(r, 10));
    await Signal.create(makeSignalData({ score: 20 }));

    const signals = await Signal.find({ userId: 'user-1' }).sort({ createdAt: -1 });
    expect(signals[0].score).toBe(20);
    expect(signals[1].score).toBe(10);
  });

  it('verifies indexes exist', async () => {
    const Signal = await getSignal();
    await Signal.syncIndexes();
    const indexes = await Signal.collection.indexes();

    const indexKeys = indexes.map((idx) => Object.keys(idx.key));
    expect(indexKeys).toContainEqual(['userId', 'symbol', 'createdAt']);
    expect(indexKeys).toContainEqual(['createdAt']);
  });

  it('has TTL index on createdAt', async () => {
    const Signal = await getSignal();
    await Signal.syncIndexes();
    const indexes = await Signal.collection.indexes();

    const ttlIndex = indexes.find(
      (idx) => Object.keys(idx.key).includes('createdAt') && idx.expireAfterSeconds
    );
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex!.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
  });
});
