import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FuturesMetric } from '@/lib/models/futures-metric';
import { PerpCandle, PERP_SERIES } from '@/lib/models/perp-candle';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await FuturesMetric.syncIndexes();
  await PerpCandle.syncIndexes();
}, 60_000);

afterEach(async () => {
  await FuturesMetric.deleteMany({});
  await PerpCandle.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('FuturesMetric', () => {
  it('stores a full metrics row', async () => {
    await FuturesMetric.create({
      symbol: 'BTCUSDT',
      timestamp: 1748736000000,
      openInterest: 83624.198,
      openInterestValue: 8736988614.448706,
      topTraderAccountRatio: 1.23458273,
      topTraderPositionRatio: 1.561637,
      globalAccountRatio: 1.19060369,
      takerLongShortRatio: 0.552801,
    });
    const found = await FuturesMetric.findOne({ symbol: 'BTCUSDT' }).lean();
    expect(found?.openInterest).toBeCloseTo(83624.198, 6);
    expect(found?.takerLongShortRatio).toBeCloseTo(0.552801, 8);
  });

  it('requires symbol and timestamp and nothing else', async () => {
    await expect(FuturesMetric.create({ symbol: 'BTCUSDT' })).rejects.toThrow();
    await expect(FuturesMetric.create({ symbol: 'BTCUSDT', timestamp: 1 })).resolves.toBeDefined();
  });

  it('rejects a second document for the same symbol and slot', async () => {
    await FuturesMetric.create({ symbol: 'BTCUSDT', timestamp: 1748736000000, openInterest: 1 });
    await expect(
      FuturesMetric.create({ symbol: 'BTCUSDT', timestamp: 1748736000000, openInterest: 2 })
    ).rejects.toThrow(/duplicate key/i);
  });

  it('lets a separate ingest merge depth fields into an existing slot', async () => {
    // metrics and bookDepth are different archive files for the same 5m slot.
    await FuturesMetric.updateOne(
      { symbol: 'BTCUSDT', timestamp: 1748736000000 },
      { $set: { openInterest: 83624.198, globalAccountRatio: 1.19 } },
      { upsert: true }
    );
    await FuturesMetric.updateOne(
      { symbol: 'BTCUSDT', timestamp: 1748736000000 },
      { $set: { depthImbalance1: -0.2, depthSamples: 10 } },
      { upsert: true }
    );

    const found = await FuturesMetric.findOne({ symbol: 'BTCUSDT' }).lean();
    expect(found?.openInterest).toBeCloseTo(83624.198, 6);
    expect(found?.depthImbalance1).toBeCloseTo(-0.2, 10);
    expect(await FuturesMetric.countDocuments()).toBe(1);
  });

  it('distinguishes a missing measure from a zero one', async () => {
    await FuturesMetric.create({ symbol: 'BTCUSDT', timestamp: 1, takerLongShortRatio: 0 });
    await FuturesMetric.create({ symbol: 'BTCUSDT', timestamp: 2 });
    const zero = await FuturesMetric.findOne({ timestamp: 1 }).lean();
    const missing = await FuturesMetric.findOne({ timestamp: 2 }).lean();
    expect(zero?.takerLongShortRatio).toBe(0);
    expect(missing?.takerLongShortRatio).toBeUndefined();
  });

  it('carries no TTL index, so multi-year history survives', async () => {
    const indexes = await FuturesMetric.collection.indexes();
    expect(indexes.some((i) => 'expireAfterSeconds' in i)).toBe(false);
  });
});

describe('PerpCandle', () => {
  const bar = {
    symbol: 'BTCUSDT',
    interval: '5m',
    timestamp: 1635724800000,
    open: 61347.14,
    high: 61447.27,
    low: 61129.9,
    close: 61290.31,
    volume: 1705.548,
    quoteVolume: 104522700.64749,
    trades: 14001,
    takerBuyVolume: 638.68,
  };

  it('stores a perpetual bar', async () => {
    await PerpCandle.create({ ...bar, series: 'klines' });
    const found = await PerpCandle.findOne({ symbol: 'BTCUSDT' }).lean();
    expect(found?.close).toBeCloseTo(61290.31, 6);
    expect(found?.trades).toBe(14001);
  });

  it('rejects a series outside the enum', async () => {
    await expect(PerpCandle.create({ ...bar, series: 'spot' })).rejects.toThrow();
    for (const series of PERP_SERIES) {
      await expect(PerpCandle.create({ ...bar, series })).resolves.toBeDefined();
    }
  });

  it('keeps the three series apart at the same bar', async () => {
    for (const series of PERP_SERIES) {
      await PerpCandle.create({ ...bar, series });
    }
    expect(await PerpCandle.countDocuments({ timestamp: bar.timestamp })).toBe(3);
  });

  it('rejects a duplicate of the same symbol, interval, series and bar', async () => {
    await PerpCandle.create({ ...bar, series: 'klines' });
    await expect(PerpCandle.create({ ...bar, series: 'klines' })).rejects.toThrow(/duplicate key/i);
  });

  it('leaves takerBuyVolume unset when the archive had none', async () => {
    const withoutTaker = { ...bar };
    delete (withoutTaker as Partial<typeof bar>).takerBuyVolume;
    await PerpCandle.create({ ...withoutTaker, series: 'premiumIndex' });
    const found = await PerpCandle.findOne({ series: 'premiumIndex' }).lean();
    expect(found?.takerBuyVolume).toBeUndefined();
  });

  it('does not collide with the spot Candle collection', async () => {
    expect(PerpCandle.collection.collectionName).toBe('perpcandles');
    expect(FuturesMetric.collection.collectionName).toBe('futuresmetrics');
  });

  it('carries no TTL index', async () => {
    const indexes = await PerpCandle.collection.indexes();
    expect(indexes.some((i) => 'expireAfterSeconds' in i)).toBe(false);
  });
});
