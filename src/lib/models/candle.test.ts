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
import {
  VALID_INTERVALS,
  HF_INTERVALS,
  HF_TTL_MS,
  isHighFrequencyInterval,
  computeExpiresAt,
} from './candle';

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

function makeCandleData(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    interval: '1h',
    timestamp: 1700000000000,
    open: 50000,
    high: 51000,
    low: 49000,
    close: 50500,
    volume: 123.456,
    ...overrides,
  };
}

describe('Candle model', () => {
  async function getCandle() {
    const { Candle } = await import('./candle');
    return Candle;
  }

  it('creates a candle with required fields', async () => {
    const Candle = await getCandle();
    const candle = await Candle.create(makeCandleData());

    expect(candle.symbol).toBe('BTCUSDT');
    expect(candle.interval).toBe('1h');
    expect(candle.timestamp).toBe(1700000000000);
    expect(candle.open).toBe(50000);
    expect(candle.high).toBe(51000);
    expect(candle.low).toBe(49000);
    expect(candle.close).toBe(50500);
    expect(candle.volume).toBe(123.456);
  });

  it('rejects missing required fields', async () => {
    const Candle = await getCandle();
    await expect(Candle.create({ symbol: 'BTCUSDT' })).rejects.toThrow();
  });

  it('enforces unique compound index on symbol+interval+timestamp', async () => {
    const Candle = await getCandle();
    await Candle.syncIndexes();

    await Candle.create(makeCandleData());
    await expect(Candle.create(makeCandleData())).rejects.toThrow();
  });

  it('allows same timestamp for different symbols', async () => {
    const Candle = await getCandle();
    await Candle.syncIndexes();

    await Candle.create(makeCandleData());
    const second = await Candle.create(
      makeCandleData({ symbol: 'ETHUSDT' })
    );
    expect(second.symbol).toBe('ETHUSDT');
  });

  it('allows same timestamp for different intervals', async () => {
    const Candle = await getCandle();
    await Candle.syncIndexes();

    await Candle.create(makeCandleData());
    const second = await Candle.create(
      makeCandleData({ interval: '4h' })
    );
    expect(second.interval).toBe('4h');
  });

  it('queries by symbol+interval range efficiently', async () => {
    const Candle = await getCandle();

    await Candle.insertMany([
      makeCandleData({ timestamp: 1700000000000 }),
      makeCandleData({ timestamp: 1700003600000 }),
      makeCandleData({ timestamp: 1700007200000 }),
      makeCandleData({ symbol: 'ETHUSDT', timestamp: 1700000000000 }),
    ]);

    const btcCandles = await Candle.find({
      symbol: 'BTCUSDT',
      interval: '1h',
      timestamp: { $gte: 1700000000000, $lte: 1700003600000 },
    }).sort({ timestamp: 1 });

    expect(btcCandles).toHaveLength(2);
    expect(btcCandles[0].timestamp).toBe(1700000000000);
    expect(btcCandles[1].timestamp).toBe(1700003600000);
  });

  it('supports descending sort by timestamp', async () => {
    const Candle = await getCandle();

    await Candle.insertMany([
      makeCandleData({ timestamp: 1700000000000 }),
      makeCandleData({ timestamp: 1700003600000 }),
      makeCandleData({ timestamp: 1700007200000 }),
    ]);

    const candles = await Candle.find({
      symbol: 'BTCUSDT',
      interval: '1h',
    }).sort({ timestamp: -1 }).limit(2);

    expect(candles).toHaveLength(2);
    expect(candles[0].timestamp).toBe(1700007200000);
    expect(candles[1].timestamp).toBe(1700003600000);
  });

  it('verifies indexes exist', async () => {
    const Candle = await getCandle();
    await Candle.syncIndexes();
    const indexes = await Candle.collection.indexes();

    const indexKeys = indexes.map((idx) => Object.keys(idx.key));
    expect(indexKeys).toContainEqual(['symbol', 'interval', 'timestamp']);
  });

  it('does not store timestamps automatically', async () => {
    const Candle = await getCandle();
    const candle = await Candle.create(makeCandleData());

    expect((candle as Record<string, unknown>).createdAt).toBeUndefined();
    expect((candle as Record<string, unknown>).updatedAt).toBeUndefined();
  });

  it('stores expiresAt for HF candles', async () => {
    const Candle = await getCandle();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const candle = await Candle.create(makeCandleData({ interval: '1m', expiresAt }));

    expect(candle.expiresAt).toBeDefined();
    expect(candle.expiresAt!.getTime()).toBe(expiresAt.getTime());
  });

  it('stores null expiresAt for non-HF candles', async () => {
    const Candle = await getCandle();
    const candle = await Candle.create(makeCandleData({ interval: '1h' }));

    expect(candle.expiresAt).toBeNull();
  });

  it('includes expiresAt TTL index', async () => {
    const Candle = await getCandle();
    await Candle.syncIndexes();
    const indexes = await Candle.collection.indexes();

    const ttlIndex = indexes.find((idx) => 'expiresAt' in idx.key);
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex!.expireAfterSeconds).toBe(0);
  });
});

describe('VALID_INTERVALS', () => {
  it('includes high-frequency intervals', () => {
    expect(VALID_INTERVALS).toContain('1m');
    expect(VALID_INTERVALS).toContain('5m');
  });

  it('includes all standard intervals', () => {
    expect(VALID_INTERVALS).toContain('15m');
    expect(VALID_INTERVALS).toContain('1h');
    expect(VALID_INTERVALS).toContain('4h');
    expect(VALID_INTERVALS).toContain('1d');
  });

  it('has 6 intervals total', () => {
    expect(VALID_INTERVALS).toHaveLength(6);
  });
});

describe('HF_INTERVALS', () => {
  it('contains 1m and 5m', () => {
    expect(HF_INTERVALS).toEqual(['1m', '5m']);
  });
});

describe('HF_TTL_MS', () => {
  it('1m TTL is 7 days', () => {
    expect(HF_TTL_MS['1m']).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('5m TTL is 14 days', () => {
    expect(HF_TTL_MS['5m']).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe('isHighFrequencyInterval', () => {
  it('returns true for 1m and 5m', () => {
    expect(isHighFrequencyInterval('1m')).toBe(true);
    expect(isHighFrequencyInterval('5m')).toBe(true);
  });

  it('returns false for standard intervals', () => {
    expect(isHighFrequencyInterval('15m')).toBe(false);
    expect(isHighFrequencyInterval('1h')).toBe(false);
    expect(isHighFrequencyInterval('4h')).toBe(false);
    expect(isHighFrequencyInterval('1d')).toBe(false);
  });
});

describe('computeExpiresAt', () => {
  it('returns a Date for HF intervals', () => {
    const before = Date.now();
    const result = computeExpiresAt('1m');
    const after = Date.now();

    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBeGreaterThanOrEqual(before + HF_TTL_MS['1m']);
    expect(result!.getTime()).toBeLessThanOrEqual(after + HF_TTL_MS['1m']);
  });

  it('returns null for non-HF intervals', () => {
    expect(computeExpiresAt('1h')).toBeNull();
    expect(computeExpiresAt('4h')).toBeNull();
    expect(computeExpiresAt('1d')).toBeNull();
  });
});
