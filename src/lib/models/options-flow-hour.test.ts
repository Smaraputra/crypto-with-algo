// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { OptionsFlowHour } from '@/lib/models/options-flow-hour';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await OptionsFlowHour.syncIndexes();
}, 60_000);

afterEach(async () => {
  await OptionsFlowHour.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('OptionsFlowHour', () => {
  it('requires currency and timestamp and nothing else', async () => {
    await expect(OptionsFlowHour.create({ currency: 'BTC' })).rejects.toThrow();
    await expect(
      OptionsFlowHour.create({ currency: 'BTC', timestamp: 1 })
    ).resolves.toBeDefined();
  });

  it('rejects a second document for the same currency and hour', async () => {
    await OptionsFlowHour.create({ currency: 'BTC', timestamp: 1748736000000, dvolClose: 60 });
    await expect(
      OptionsFlowHour.create({ currency: 'BTC', timestamp: 1748736000000, dvolClose: 61 })
    ).rejects.toThrow(/duplicate key/i);
  });

  it('lets the dvol pass and the trades pass merge into one document', async () => {
    await OptionsFlowHour.updateOne(
      { currency: 'BTC', timestamp: 1748736000000 },
      { $set: { dvolOpen: 58, dvolHigh: 62, dvolLow: 57, dvolClose: 60 } },
      { upsert: true }
    );
    await OptionsFlowHour.updateOne(
      { currency: 'BTC', timestamp: 1748736000000 },
      { $set: { callBuyNotional: 12345.6, netDelta: 0.42, tradeCount: 7 } },
      { upsert: true }
    );

    const found = await OptionsFlowHour.findOne({ currency: 'BTC' }).lean();
    expect(found?.dvolClose).toBeCloseTo(60, 10);
    expect(found?.callBuyNotional).toBeCloseTo(12345.6, 6);
    expect(found?.tradeCount).toBe(7);
    expect(await OptionsFlowHour.countDocuments()).toBe(1);
  });

  it('distinguishes a missing measure from a zero one', async () => {
    await OptionsFlowHour.create({ currency: 'BTC', timestamp: 1, netDelta: 0 });
    await OptionsFlowHour.create({ currency: 'BTC', timestamp: 2 });
    const zero = await OptionsFlowHour.findOne({ timestamp: 1 }).lean();
    const missing = await OptionsFlowHour.findOne({ timestamp: 2 }).lean();
    expect(zero?.netDelta).toBe(0);
    expect(missing?.netDelta).toBeUndefined();
  });

  it('carries no TTL index, so multi-year history survives', async () => {
    const indexes = await OptionsFlowHour.collection.indexes();
    expect(indexes.some((i) => 'expireAfterSeconds' in i)).toBe(false);
  });

  it('collects into its own collection', async () => {
    expect(OptionsFlowHour.collection.collectionName).toBe('optionsflowhours');
  });
});
