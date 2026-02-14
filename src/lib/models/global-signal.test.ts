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
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    score: 45,
    tier: 'buy',
    confidence: 85,
    components: [
      {
        category: 'trend',
        score: 60,
        weight: 0.25,
        weightedScore: 15,
        signals: [
          {
            name: 'EMA Cross',
            direction: 'bullish',
            strength: 70,
            description: 'EMA12 above EMA26',
          },
        ],
      },
    ],
    configVersion: 1,
    candleTimestamp: Date.now(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

describe('GlobalSignal model', () => {
  async function getModel() {
    const { GlobalSignal } = await import('./global-signal');
    return GlobalSignal;
  }

  it('creates a global signal with required fields', async () => {
    const GlobalSignal = await getModel();
    const signal = await GlobalSignal.create(makeSignalData());

    expect(signal.symbol).toBe('BTCUSDT');
    expect(signal.interval).toBe('1h');
    expect(signal.tradingStyle).toBe('day_trading');
    expect(signal.score).toBe(45);
    expect(signal.tier).toBe('buy');
    expect(signal.confidence).toBe(85);
    expect(signal.configVersion).toBe(1);
    expect(signal.components).toHaveLength(1);
    expect(signal.createdAt).toBeDefined();
  });

  it('rejects invalid trading style', async () => {
    const GlobalSignal = await getModel();
    await expect(
      GlobalSignal.create(makeSignalData({ tradingStyle: 'invalid' }))
    ).rejects.toThrow();
  });

  it('rejects invalid tier', async () => {
    const GlobalSignal = await getModel();
    await expect(
      GlobalSignal.create(makeSignalData({ tier: 'invalid_tier' }))
    ).rejects.toThrow();
  });

  it('rejects missing required fields', async () => {
    const GlobalSignal = await getModel();
    await expect(GlobalSignal.create({ symbol: 'BTCUSDT' })).rejects.toThrow();
  });

  it('allows multiple signals for same symbol/style/interval', async () => {
    const GlobalSignal = await getModel();

    await GlobalSignal.create(makeSignalData());
    const second = await GlobalSignal.create(makeSignalData({ score: 50 }));

    expect(second.score).toBe(50);
    const count = await GlobalSignal.countDocuments();
    expect(count).toBe(2);
  });

  it('stores all four trading styles', async () => {
    const GlobalSignal = await getModel();

    const styles = ['scalping', 'day_trading', 'swing_trading', 'position_trading'];
    for (const style of styles) {
      await GlobalSignal.create(makeSignalData({ tradingStyle: style }));
    }

    const count = await GlobalSignal.countDocuments();
    expect(count).toBe(4);
  });

  it('queries by symbol and tradingStyle', async () => {
    const GlobalSignal = await getModel();

    await GlobalSignal.create(makeSignalData({ symbol: 'BTCUSDT', tradingStyle: 'scalping' }));
    await GlobalSignal.create(makeSignalData({ symbol: 'BTCUSDT', tradingStyle: 'day_trading' }));
    await GlobalSignal.create(makeSignalData({ symbol: 'ETHUSDT', tradingStyle: 'scalping' }));

    const btcScalping = await GlobalSignal.find({
      symbol: 'BTCUSDT',
      tradingStyle: 'scalping',
    });
    expect(btcScalping).toHaveLength(1);
  });

  it('sorts by createdAt descending for latest signal', async () => {
    const GlobalSignal = await getModel();

    const first = await GlobalSignal.create(makeSignalData({ score: 10 }));
    // Small delay to ensure different createdAt
    await new Promise((r) => setTimeout(r, 10));
    const second = await GlobalSignal.create(makeSignalData({ score: 20 }));

    const latest = await GlobalSignal.findOne({
      symbol: 'BTCUSDT',
      tradingStyle: 'day_trading',
    }).sort({ createdAt: -1 });

    expect(latest!.score).toBe(20);
    expect(latest!._id.toString()).toBe(second._id.toString());
    expect(first).toBeDefined(); // satisfy lint
  });

  it('does not have userId field', async () => {
    const GlobalSignal = await getModel();
    const signal = await GlobalSignal.create(makeSignalData());

    expect((signal as Record<string, unknown>).userId).toBeUndefined();
  });

  it('verifies indexes exist', async () => {
    const GlobalSignal = await getModel();
    await GlobalSignal.syncIndexes();
    const indexes = await GlobalSignal.collection.indexes();

    const indexKeys = indexes.map((idx) => Object.keys(idx.key));

    // Primary query index
    expect(indexKeys).toContainEqual(['symbol', 'tradingStyle', 'interval', 'createdAt']);
    // Latest signal index
    expect(indexKeys).toContainEqual(['symbol', 'tradingStyle', 'createdAt']);
    // TTL index
    expect(indexKeys).toContainEqual(['expiresAt']);
  });

  it('has TTL index on expiresAt with expireAfterSeconds: 0', async () => {
    const GlobalSignal = await getModel();
    await GlobalSignal.syncIndexes();
    const indexes = await GlobalSignal.collection.indexes();

    const ttlIndex = indexes.find((idx) => 'expiresAt' in idx.key);
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex!.expireAfterSeconds).toBe(0);
  });

  it('stores component signals with correct structure', async () => {
    const GlobalSignal = await getModel();
    const signal = await GlobalSignal.create(makeSignalData());

    const component = signal.components[0];
    expect(component.category).toBe('trend');
    expect(component.score).toBe(60);
    expect(component.weight).toBe(0.25);
    expect(component.weightedScore).toBe(15);
    expect(component.signals).toHaveLength(1);
    expect(component.signals[0].name).toBe('EMA Cross');
    expect(component.signals[0].direction).toBe('bullish');
  });
});
