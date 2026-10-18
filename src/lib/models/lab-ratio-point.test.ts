// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import {
  LabRatioPoint,
  loadRatioPoints,
  storeRatioPoints,
} from './lab-ratio-point';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await LabRatioPoint.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  // Delete documents, not the database: dropping it also drops the unique index that init() built once,
  // and the insert-only tests would then race without it.
  await LabRatioPoint.deleteMany({});
});

describe('LabRatioPoint model and store/load functions', () => {
  const symbol = 'BTCUSDT';
  const period = '4h';
  const fetchedAt = new Date('2026-10-18T16:00:00Z');

  it('stores ratio points and returns the count of new points inserted', async () => {
    const points = [
      { timestamp: 1_000_000, longShortRatio: 1.5 },
      { timestamp: 2_000_000, longShortRatio: 1.6 },
      { timestamp: 3_000_000, longShortRatio: 1.7 },
    ];

    const inserted = await storeRatioPoints(symbol, period, points, fetchedAt);
    expect(inserted).toBe(3);

    const count = await LabRatioPoint.countDocuments({ symbol, period });
    expect(count).toBe(3);
  });

  it('is insert-only: storing the same point twice stores once and second write with different ratio does NOT overwrite', async () => {
    const firstPoint = [{ timestamp: 1_000_000, longShortRatio: 1.5 }];
    const res1 = await storeRatioPoints(symbol, period, firstPoint, fetchedAt);
    expect(res1).toBe(1);

    const secondPoint = [{ timestamp: 1_000_000, longShortRatio: 2.5 }];
    const res2 = await storeRatioPoints(symbol, period, secondPoint, new Date('2026-10-18T17:00:00Z'));
    expect(res2).toBe(0);

    const doc = await LabRatioPoint.findOne({ symbol, period, timestamp: 1_000_000 }).lean();
    expect(doc).not.toBeNull();
    expect(doc?.longShortRatio).toBe(1.5);
    expect(doc?.fetchedAt.getTime()).toBe(fetchedAt.getTime());
  });

  it('partially duplicate batch: only inserts new points and keeps existing points untouched', async () => {
    await storeRatioPoints(symbol, period, [{ timestamp: 1_000_000, longShortRatio: 1.2 }], fetchedAt);

    const batch = [
      { timestamp: 1_000_000, longShortRatio: 9.9 },
      { timestamp: 2_000_000, longShortRatio: 1.3 },
      { timestamp: 3_000_000, longShortRatio: 1.4 },
    ];

    const inserted = await storeRatioPoints(symbol, period, batch, fetchedAt);
    expect(inserted).toBe(2);

    const loaded = await loadRatioPoints(symbol, period, 0, 5_000_000);
    expect(loaded).toEqual([
      { timestamp: 1_000_000, longShortRatio: 1.2 },
      { timestamp: 2_000_000, longShortRatio: 1.3 },
      { timestamp: 3_000_000, longShortRatio: 1.4 },
    ]);
  });

  it('loadRatioPoints filters by timestamp range [fromTs, toTs] inclusively', async () => {
    const points = [
      { timestamp: 100, longShortRatio: 1.1 },
      { timestamp: 200, longShortRatio: 1.2 },
      { timestamp: 300, longShortRatio: 1.3 },
      { timestamp: 400, longShortRatio: 1.4 },
      { timestamp: 500, longShortRatio: 1.5 },
    ];
    await storeRatioPoints(symbol, period, points, fetchedAt);

    const loaded = await loadRatioPoints(symbol, period, 200, 400);
    expect(loaded).toEqual([
      { timestamp: 200, longShortRatio: 1.2 },
      { timestamp: 300, longShortRatio: 1.3 },
      { timestamp: 400, longShortRatio: 1.4 },
    ]);
  });

  it('loadRatioPoints returns points sorted by timestamp ascending even if stored out of order', async () => {
    const points = [
      { timestamp: 500, longShortRatio: 1.5 },
      { timestamp: 100, longShortRatio: 1.1 },
      { timestamp: 300, longShortRatio: 1.3 },
    ];
    await storeRatioPoints(symbol, period, points, fetchedAt);

    const loaded = await loadRatioPoints(symbol, period, 0, 1000);
    expect(loaded).toEqual([
      { timestamp: 100, longShortRatio: 1.1 },
      { timestamp: 300, longShortRatio: 1.3 },
      { timestamp: 500, longShortRatio: 1.5 },
    ]);
  });

  it('isolates different symbols and periods', async () => {
    await storeRatioPoints('BTCUSDT', '4h', [{ timestamp: 100, longShortRatio: 1.5 }], fetchedAt);
    await storeRatioPoints('ETHUSDT', '4h', [{ timestamp: 100, longShortRatio: 2.0 }], fetchedAt);

    const btcPoints = await loadRatioPoints('BTCUSDT', '4h', 0, 1000);
    expect(btcPoints).toEqual([{ timestamp: 100, longShortRatio: 1.5 }]);

    const ethPoints = await loadRatioPoints('ETHUSDT', '4h', 0, 1000);
    expect(ethPoints).toEqual([{ timestamp: 100, longShortRatio: 2.0 }]);
  });

  it('rejects points with invalid period or missing fields on store', async () => {
    const badPeriod = [{ timestamp: 100, longShortRatio: 1.5 }];
    await expect(
      storeRatioPoints(symbol, '1h' as unknown as '4h', badPeriod, fetchedAt)
    ).rejects.toThrow();

    expect(await LabRatioPoint.countDocuments()).toBe(0);
  });
});
