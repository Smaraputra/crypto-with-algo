// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { HistoricalSnapshot } from './models/historical-snapshot';
import { bulkUpsertSnapshots, upsertSnapshot } from './historical-snapshots';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

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

const KEY = { symbol: 'BTCUSDT', interval: '1h', timestamp: 1_789_556_400_000 };

const liveData = {
  fundingRate: { rate: 0.0001, markPrice: 80000 },
  newsSentiment: { count: 20, avgSentiment: 0.12, topics: ['institutional'] },
  fearGreed: { index: 40, label: 'Fear' },
};

async function stored() {
  return HistoricalSnapshot.findOne(KEY).lean();
}

describe('bulkUpsertSnapshots', () => {
  it('keeps live-captured news when a backfill writes the same bar without it', async () => {
    // Live ingestion stores news, which no API can supply historically.
    await bulkUpsertSnapshots([{ ...KEY, data: liveData }]);

    // The admin backfill supplies futures and Fear & Greed only.
    await bulkUpsertSnapshots([
      {
        ...KEY,
        data: {
          fundingRate: { rate: 0.0002, markPrice: 81000 },
          longShortRatio: { ratio: 1.4, longAccount: 0.58, shortAccount: 0.42 },
        },
      },
    ]);

    const doc = await stored();
    expect(doc?.data.newsSentiment).toMatchObject({ count: 20, avgSentiment: 0.12 });
    expect(doc?.data.fearGreed).toMatchObject({ index: 40, label: 'Fear' });
    // Fields the second write did supply are updated.
    expect(doc?.data.fundingRate).toMatchObject({ rate: 0.0002, markPrice: 81000 });
    expect(doc?.data.longShortRatio).toMatchObject({ ratio: 1.4 });
  });

  it('inserts a new snapshot with every supplied field', async () => {
    await bulkUpsertSnapshots([{ ...KEY, data: liveData }]);

    const doc = await stored();
    expect(doc?.data.fundingRate).toMatchObject({ rate: 0.0001 });
    expect(doc?.data.newsSentiment).toMatchObject({ count: 20 });
    expect(await HistoricalSnapshot.countDocuments()).toBe(1);
  });

  it('does not duplicate a bar written twice', async () => {
    await bulkUpsertSnapshots([{ ...KEY, data: liveData }]);
    await bulkUpsertSnapshots([{ ...KEY, data: liveData }]);

    expect(await HistoricalSnapshot.countDocuments()).toBe(1);
  });

  it('creates a document with empty data when nothing is supplied', async () => {
    await bulkUpsertSnapshots([{ ...KEY, data: {} }]);

    const doc = await stored();
    expect(doc).not.toBeNull();
    expect(doc?.data ?? {}).not.toHaveProperty('newsSentiment');
  });

  it('leaves existing data intact when a later write supplies nothing', async () => {
    await bulkUpsertSnapshots([{ ...KEY, data: liveData }]);
    await bulkUpsertSnapshots([{ ...KEY, data: {} }]);

    const doc = await stored();
    expect(doc?.data.newsSentiment).toMatchObject({ count: 20 });
  });

  it('ignores explicitly undefined fields rather than clearing them', async () => {
    await bulkUpsertSnapshots([{ ...KEY, data: liveData }]);
    await bulkUpsertSnapshots([{ ...KEY, data: { newsSentiment: undefined } }]);

    const doc = await stored();
    expect(doc?.data.newsSentiment).toMatchObject({ count: 20 });
  });

  it('does nothing for an empty batch', async () => {
    await expect(bulkUpsertSnapshots([])).resolves.toBeUndefined();
    expect(await HistoricalSnapshot.countDocuments()).toBe(0);
  });
});

describe('upsertSnapshot', () => {
  it('merges fields the same way as the bulk path', async () => {
    await upsertSnapshot(KEY.symbol, KEY.interval, KEY.timestamp, liveData);
    await upsertSnapshot(KEY.symbol, KEY.interval, KEY.timestamp, {
      fundingRate: { rate: 0.0003, markPrice: 82000 },
    });

    const doc = await stored();
    expect(doc?.data.newsSentiment).toMatchObject({ count: 20 });
    expect(doc?.data.fundingRate).toMatchObject({ rate: 0.0003 });
  });
});
