// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FundingSettlement } from './models/funding-settlement';
import { syncFundingSettlements } from './funding-settlement-sync';
import type { FundingRate } from '@/types/futures';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_790_000_000_000 - (1_790_000_000_000 % (8 * H)) + 3 * H;
const EIGHT = 8 * H;

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

function event(symbol: string, fundingTime: number, rate: number, markPrice = 100): FundingRate {
  return { symbol, fundingRate: rate, fundingTime, markPrice };
}

async function seedArchive(symbol: string, fundingTime: number, rate: number) {
  await FundingSettlement.create({
    symbol,
    fundingTime,
    rawTime: fundingTime + 1,
    rate,
    intervalHours: 8,
  });
}

describe('syncFundingSettlements', () => {
  it('fills a 3-day gap starting one day before the newest stored row', async () => {
    const last = NOW - 3 * DAY;
    const lastBoundary = last - (last % EIGHT);
    await seedArchive('BTCUSDT', lastBoundary, 0.0001);
    const events: FundingRate[] = [];
    for (let t = lastBoundary + EIGHT; t <= NOW; t += EIGHT) events.push(event('BTCUSDT', t + 2, 0.0002, 101));
    const fetchFundingHistory = vi.fn().mockResolvedValue(events);

    const res = await syncFundingSettlements(['BTCUSDT'], NOW, { fetchFundingHistory });

    expect(fetchFundingHistory).toHaveBeenCalledWith('BTCUSDT', lastBoundary - DAY, NOW);
    expect(res).toEqual([{ symbol: 'BTCUSDT', inserted: events.length, updated: 0 }]);
    expect(await FundingSettlement.countDocuments({ symbol: 'BTCUSDT' })).toBe(events.length + 1);
  });

  it('starts 30 days back when nothing is stored', async () => {
    const fetchFundingHistory = vi.fn().mockResolvedValue([]);
    await syncFundingSettlements(['ETHUSDT'], NOW, { fetchFundingHistory });
    expect(fetchFundingHistory).toHaveBeenCalledWith('ETHUSDT', NOW - 30 * DAY, NOW);
  });

  it('lands REST times offset by 1 to 5 ms on the exact hour', async () => {
    const boundary = NOW - (NOW % EIGHT);
    const offsets = [1, 2, 3, 4, 5];
    const events = offsets.map((o, i) => event('SOLUSDT', boundary - i * EIGHT + o, 0.0001));
    await syncFundingSettlements(['SOLUSDT'], NOW, { fetchFundingHistory: vi.fn().mockResolvedValue(events) });
    const rows = await FundingSettlement.find({ symbol: 'SOLUSDT' }).sort({ fundingTime: 1 }).lean();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.fundingTime % H).toBe(0);
      expect(row.source).toBe('rest');
      expect(row.intervalHours).toBeNull();
    }
    expect(rows.map((r) => r.rawTime - r.fundingTime).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('leaves the count unchanged on a rerun', async () => {
    const boundary = NOW - (NOW % EIGHT);
    const events = [event('BTCUSDT', boundary + 1, 0.0001), event('BTCUSDT', boundary - EIGHT + 1, 0.0002)];
    const deps = { fetchFundingHistory: vi.fn().mockResolvedValue(events) };
    await syncFundingSettlements(['BTCUSDT'], NOW, deps);
    const second = await syncFundingSettlements(['BTCUSDT'], NOW, deps);
    expect(await FundingSettlement.countDocuments({ symbol: 'BTCUSDT' })).toBe(2);
    expect(second).toEqual([{ symbol: 'BTCUSDT', inserted: 0, updated: 0 }]);
  });

  it('keeps an archive row intact except for a finite markPrice', async () => {
    const boundary = NOW - (NOW % EIGHT);
    await seedArchive('BTCUSDT', boundary, 0.0003);
    const withMark = [event('BTCUSDT', boundary + 2, 0.9, 123.5)];
    await syncFundingSettlements(['BTCUSDT'], NOW, { fetchFundingHistory: vi.fn().mockResolvedValue(withMark) });
    let row = await FundingSettlement.findOne({ symbol: 'BTCUSDT', fundingTime: boundary }).lean();
    expect(row).toMatchObject({ rate: 0.0003, intervalHours: 8, source: 'archive', rawTime: boundary + 1, markPrice: 123.5 });

    // An empty-string mark price parses to NaN upstream and must not wipe the stored one
    const noMark = [event('BTCUSDT', boundary + 2, 0.9, Number.NaN)];
    const res = await syncFundingSettlements(['BTCUSDT'], NOW, { fetchFundingHistory: vi.fn().mockResolvedValue(noMark) });
    row = await FundingSettlement.findOne({ symbol: 'BTCUSDT', fundingTime: boundary }).lean();
    expect(row?.markPrice).toBe(123.5);
    expect(res[0].inserted).toBe(0);
  });

  it('collapses two events rounding to one boundary into one row without error', async () => {
    const boundary = NOW - (NOW % EIGHT);
    const events = [event('BTCUSDT', boundary - 1, 0.0001), event('BTCUSDT', boundary + 1, 0.0002)];
    const res = await syncFundingSettlements(['BTCUSDT'], NOW, { fetchFundingHistory: vi.fn().mockResolvedValue(events) });
    expect(res).toEqual([{ symbol: 'BTCUSDT', inserted: 1, updated: 0 }]);
    const rows = await FundingSettlement.find({ symbol: 'BTCUSDT' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fundingTime: boundary, rawTime: boundary + 1, rate: 0.0002 });
  });

  it('stores null markPrice for a new row without one', async () => {
    const boundary = NOW - (NOW % EIGHT);
    await syncFundingSettlements(['BTCUSDT'], NOW, {
      fetchFundingHistory: vi.fn().mockResolvedValue([event('BTCUSDT', boundary + 1, 0.0001, Number.NaN)]),
    });
    const row = await FundingSettlement.findOne({ symbol: 'BTCUSDT', fundingTime: boundary }).lean();
    expect(row?.markPrice).toBeNull();
  });

  it('reports a failing symbol and still syncs the others', async () => {
    const boundary = NOW - (NOW % EIGHT);
    const fetchFundingHistory = vi.fn(async (symbol: string) => {
      if (symbol === 'ETHUSDT') throw new Error('HTTP 418');
      return [event(symbol, boundary + 1, 0.0001)];
    });
    const res = await syncFundingSettlements(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], NOW, { fetchFundingHistory });
    expect(res.find((r) => r.symbol === 'ETHUSDT')).toMatchObject({ inserted: 0, updated: 0, error: 'HTTP 418' });
    expect(res.find((r) => r.symbol === 'BTCUSDT')).toEqual({ symbol: 'BTCUSDT', inserted: 1, updated: 0 });
    expect(await FundingSettlement.countDocuments({ symbol: 'SOLUSDT' })).toBe(1);
  });
});
