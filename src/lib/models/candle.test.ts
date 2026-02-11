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
});
