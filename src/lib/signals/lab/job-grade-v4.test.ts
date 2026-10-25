// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BinanceHttpError } from '@/lib/binance-futures';
import { FundingSettlement } from '@/lib/models/funding-settlement';
import { LabScore } from '@/lib/models/lab-score';
import { insertLabSignalOnce, LabSignal } from '@/lib/models/lab-signal';
import { LAB_GRADE_SETTLE_MS } from '@/lib/signals/lab/job-grade';
import { type LabGradeV4Deps, runLabGradeV4 } from '@/lib/signals/lab/job-grade-v4';
import { gradeDueAtV4, priceTimesV4 } from '@/lib/signals/lab/v4/grade';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

type Settlement = { symbol: string; rate: number; fundingTime: number; intervalHours?: number };

/** Inserts real FundingSettlement rows into the memory server (8h interval unless given). */
async function seedSettlements(rows: Settlement[]) {
  await FundingSettlement.insertMany(
    rows.map((r) => ({
      rawTime: r.fundingTime + 1,
      source: 'rest',
      intervalHours: 8,
      ...r,
    }))
  );
}

/** A fetchPerpKlinesRange mock serving the given open prices (one price map for every coin). */
function klinesFrom(prices: Record<number, number>) {
  return vi.fn().mockImplementation(async (_sym: string, _tf: string, minTime: number, maxTime: number) =>
    Object.entries(prices)
      .map(([tStr, p]) => ({ t: Number(tStr), p }))
      .filter(({ t }) => t >= minTime && t <= maxTime)
      .map(({ t, p }) => ({
        openTime: t,
        open: p,
        close: p,
        high: p,
        low: p,
        volume: 1,
        quoteVolume: 1,
        trades: 1,
        takerBuyVolume: 1,
        closeTime: t + 299_999,
      }))
  );
}

async function seedSignal(barClose: number, scores: Record<string, number>, hypothesis = 'S1-1h') {
  await insertLabSignalOnce({
    version: 'lab-v4',
    hypothesis,
    candidate: hypothesis.startsWith('S2') ? 'S2' : 'S1',
    timeframe: '1h',
    barClose,
    writtenAt: new Date(barClose + 60_000),
    late: false,
    scores,
    skipped: [],
    inputs: {},
  });
}

describe('runLabGradeV4', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await LabSignal.init();
    await LabScore.init();
    await FundingSettlement.init();
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    await LabSignal.deleteMany({});
    await LabScore.deleteMany({});
    await FundingSettlement.deleteMany({});
  });

  it('grades a due row with the right start and end times (T + 10m and T + 10m + 8h)', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const { start, end } = priceTimesV4(T1);
    expect(start).toBe(T1 + 10 * 60_000);
    expect(end).toBe(T1 + 10 * 60_000 + 8 * 3600_000);

    const now = gradeDueAtV4(T1) + 1000;
    const mockFetchPerpKlinesRange = vi.fn().mockImplementation(async () => [
      {
        openTime: start,
        open: 100,
        close: 100,
        high: 100,
        low: 100,
        volume: 1,
        quoteVolume: 1,
        trades: 1,
        takerBuyVolume: 1,
        closeTime: start + 299_999,
      },
      {
        openTime: end,
        open: 102,
        close: 102,
        high: 102,
        low: 102,
        volume: 1,
        quoteVolume: 1,
        trades: 1,
        takerBuyVolume: 1,
        closeTime: end + 299_999,
      },
    ]);

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: mockFetchPerpKlinesRange,
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0.0001 },
        coverage: { BTCUSDT: true },
      }),
      sleep: async () => {},
      clock: () => now,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(true);
    expect(report.graded).toHaveLength(1);
    expect(report.graded[0]).toMatchObject({
      hypothesis: 'S1-1h',
      barClose: T1,
      bet: true,
    });
    expect(mockFetchPerpKlinesRange).toHaveBeenCalledWith('BTCUSDT', '5m', start, end);

    const row = await LabScore.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T1 }).lean();
    expect(row).not.toBeNull();
    expect(row!.version).toBe('lab-v4');
    expect(row!.n).toBe(1);
    expect(row!.prices['BTCUSDT']).toEqual({ start: 100, end: 102 });
    expect(row!.funding).toEqual({ BTCUSDT: 0.0001 });
  });

  it('marks a row not yet due as pending', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const dueAt = gradeDueAtV4(T1);
    const now = dueAt - 1000; // Not yet due

    const mockFetchPerpKlinesRange = vi.fn();
    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: mockFetchPerpKlinesRange,
      fundingSumsFor: vi.fn(),
      sleep: async () => {},
      clock: () => now,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(true);
    expect(report.graded).toHaveLength(0);
    expect(report.pending).toEqual([
      { hypothesis: 'S1-1h', barClose: T1, dueAt },
    ]);
    expect(mockFetchPerpKlinesRange).not.toHaveBeenCalled();

    const row = await LabScore.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T1 }).lean();
    expect(row).toBeNull();
  });

  it('grades nothing and sets success false on a non-400 kline error', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = gradeDueAtV4(T1) + 1000;
    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockRejectedValue(new Error('network socket hangup')),
      fundingSumsFor: vi.fn(),
      sleep: async () => {},
      clock: () => now,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(false);
    expect(report.errors).toContain('network socket hangup');
    expect(report.graded).toHaveLength(0);

    const row = await LabScore.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T1 }).lean();
    expect(row).toBeNull();
  });

  it('leaves a coin unpriced when BinanceHttpError 400 is returned', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);
    const { start, end } = priceTimesV4(T1);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1, UNKNOWNUSDT: -1 },
      skipped: [],
      inputs: {},
    });

    const now = gradeDueAtV4(T1) + 1000;
    const mockFetchPerpKlinesRange = vi.fn().mockImplementation(async (sym: string) => {
      if (sym === 'UNKNOWNUSDT') {
        throw new BinanceHttpError('/fapi/v1/klines', 400);
      }
      return [
        {
          openTime: start,
          open: 100,
          close: 100,
          high: 100,
          low: 100,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: start + 299_999,
        },
        {
          openTime: end,
          open: 102,
          close: 102,
          high: 102,
          low: 102,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: end + 299_999,
        },
      ];
    });

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: mockFetchPerpKlinesRange,
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0.0001 },
        coverage: { BTCUSDT: true },
      }),
      sleep: async () => {},
      clock: () => now,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(true);
    expect(report.errors.some((e) => e.includes('HTTP 400'))).toBe(true);
    expect(report.graded).toHaveLength(1);

    const row = await LabScore.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T1 }).lean();
    expect(row).not.toBeNull();
    expect(row!.n).toBe(1);
    expect(row!.prices['UNKNOWNUSDT']).toBeUndefined();
    expect(row!.prices['BTCUSDT']).toBeDefined();
    expect(row!.weights).toEqual({ BTCUSDT: 1, UNKNOWNUSDT: -1 });
  });

  it('leaves the bar pending on a funding coverage gap', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);
    const { start, end } = priceTimesV4(T1);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = gradeDueAtV4(T1) + 1000;
    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockResolvedValue([
        {
          openTime: start,
          open: 100,
          close: 100,
          high: 100,
          low: 100,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: start + 299_999,
        },
        {
          openTime: end,
          open: 102,
          close: 102,
          high: 102,
          low: 102,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: end + 299_999,
        },
      ]),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0.0001 },
        coverage: { BTCUSDT: false },
      }),
      sleep: async () => {},
      clock: () => now,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.pending).toEqual([
      { hypothesis: 'S1-1h', barClose: T1, dueAt: gradeDueAtV4(T1) },
    ]);
    expect(report.graded).toHaveLength(0);

    const row = await LabScore.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T1 }).lean();
    expect(row).toBeNull();
  });

  it('grades bars in order carrying state forward', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);
    const T2 = T1 + 3600_000;

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T2,
      writtenAt: new Date(T2 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = gradeDueAtV4(T2) + 1000;
    const { start: start1, end: end1 } = priceTimesV4(T1);
    const { start: start2, end: end2 } = priceTimesV4(T2);

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockResolvedValue([
        {
          openTime: start1,
          open: 100,
          close: 100,
          high: 100,
          low: 100,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: start1 + 299_999,
        },
        {
          openTime: end1,
          open: 102,
          close: 102,
          high: 102,
          low: 102,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: end1 + 299_999,
        },
        {
          openTime: start2,
          open: 101,
          close: 101,
          high: 101,
          low: 101,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: start2 + 299_999,
        },
        {
          openTime: end2,
          open: 103,
          close: 103,
          high: 103,
          low: 103,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: end2 + 299_999,
        },
      ]),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0.0001 },
        coverage: { BTCUSDT: true },
      }),
      sleep: async () => {},
      clock: () => now,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(true);
    expect(report.graded).toHaveLength(2);
    expect(report.graded[0].barClose).toBe(T1);
    expect(report.graded[1].barClose).toBe(T2);

    const row1 = await LabScore.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T1 }).lean();
    const row2 = await LabScore.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T2 }).lean();

    expect(row1).not.toBeNull();
    expect(row2).not.toBeNull();
    expect(row1!.state.n).toBe(1);
    expect(row2!.state.n).toBe(2);
  });

  it('fetches klines sequentially with sleep between symbols', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);
    const { start, end } = priceTimesV4(T1);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1, ETHUSDT: -1, SOLUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = gradeDueAtV4(T1) + 1000;
    const fetchOrder: string[] = [];
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockImplementation(async (sym: string) => {
        fetchOrder.push(sym);
        return [
          {
            openTime: start,
            open: 100,
            close: 100,
            high: 100,
            low: 100,
            volume: 1,
            quoteVolume: 1,
            trades: 1,
            takerBuyVolume: 1,
            closeTime: start + 299_999,
          },
          {
            openTime: end,
            open: 102,
            close: 102,
            high: 102,
            low: 102,
            volume: 1,
            quoteVolume: 1,
            trades: 1,
            takerBuyVolume: 1,
            closeTime: end + 299_999,
          },
        ];
      }),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0.0001, ETHUSDT: 0.0001, SOLUSDT: 0.0001 },
        coverage: { BTCUSDT: true, ETHUSDT: true, SOLUSDT: true },
      }),
      sleep: mockSleep,
      clock: () => now,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(true);
    expect(fetchOrder).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledWith(250);
  });

  it("a fetch error while fetching S1's symbols still grades a due S2 bar", async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);
    const { start, end } = priceTimesV4(T1);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S2-1h',
      candidate: 'S2',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { ETHUSDT: -1 },
      skipped: [],
      inputs: {},
    });

    const now = gradeDueAtV4(T1) + 1000;
    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockImplementation(async (sym: string) => {
        if (sym === 'BTCUSDT') {
          throw new Error('S1 network error');
        }
        return [
          {
            openTime: start,
            open: 100,
            close: 100,
            high: 100,
            low: 100,
            volume: 1,
            quoteVolume: 1,
            trades: 1,
            takerBuyVolume: 1,
            closeTime: start + 299_999,
          },
          {
            openTime: end,
            open: 102,
            close: 102,
            high: 102,
            low: 102,
            volume: 1,
            quoteVolume: 1,
            trades: 1,
            takerBuyVolume: 1,
            closeTime: end + 299_999,
          },
        ];
      }),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { ETHUSDT: 0.0001 },
        coverage: { ETHUSDT: true },
      }),
      sleep: async () => {},
      clock: () => now,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(false);
    expect(report.errors).toContain('S1 network error');
    expect(report.graded).toHaveLength(1);
    expect(report.graded[0]).toMatchObject({
      hypothesis: 'S2-1h',
      barClose: T1,
      bet: true,
    });

    const s1Row = await LabScore.findOne({ version: 'lab-v4', hypothesis: 'S1-1h', barClose: T1 }).lean();
    const s2Row = await LabScore.findOne({ version: 'lab-v4', hypothesis: 'S2-1h', barClose: T1 }).lean();

    expect(s1Row).toBeNull();
    expect(s2Row).not.toBeNull();
  });

  it("each hypothesis's fetch range covers only its own due bars (assert the requested start and end per call)", async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);
    const T2 = Date.UTC(2026, 9, 18, 4);
    const { start: start1, end: end1 } = priceTimesV4(T1);
    const { start: start2, end: end2 } = priceTimesV4(T2);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S2-1h',
      candidate: 'S2',
      timeframe: '1h',
      barClose: T2,
      writtenAt: new Date(T2 + 60_000),
      late: false,
      scores: { BTCUSDT: -1 },
      skipped: [],
      inputs: {},
    });

    const now = gradeDueAtV4(T2) + 1000;
    const fetchCalls: { sym: string; interval: string; start: number; end: number }[] = [];

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockImplementation(async (sym: string, interval: string, start: number, end: number) => {
        fetchCalls.push({ sym, interval, start, end });
        return [
          {
            openTime: start,
            open: 100,
            close: 100,
            high: 100,
            low: 100,
            volume: 1,
            quoteVolume: 1,
            trades: 1,
            takerBuyVolume: 1,
            closeTime: start + 299_999,
          },
          {
            openTime: end,
            open: 102,
            close: 102,
            high: 102,
            low: 102,
            volume: 1,
            quoteVolume: 1,
            trades: 1,
            takerBuyVolume: 1,
            closeTime: end + 299_999,
          },
        ];
      }),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0.0001 },
        coverage: { BTCUSDT: true },
      }),
      sleep: async () => {},
      clock: () => now,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(true);
    expect(report.graded).toHaveLength(2);
    expect(fetchCalls).toEqual([
      { sym: 'BTCUSDT', interval: '5m', start: start1, end: end1 },
      { sym: 'BTCUSDT', interval: '5m', start: start2, end: end2 },
    ]);
  });

  it('with the start day null, the daily pass does nothing', async () => {
    const T1 = Date.UTC(2026, 9, 18, 0);
    const { start, end } = priceTimesV4(T1);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = gradeDueAtV4(T1) + 1000;
    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockResolvedValue([
        {
          openTime: start,
          open: 100,
          close: 100,
          high: 100,
          low: 100,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: start + 299_999,
        },
        {
          openTime: end,
          open: 102,
          close: 102,
          high: 102,
          low: 102,
          volume: 1,
          quoteVolume: 1,
          trades: 1,
          takerBuyVolume: 1,
          closeTime: end + 299_999,
        },
      ]),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0.0001 },
        coverage: { BTCUSDT: true },
      }),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: null,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(true);
    // Only per-trade row graded
    expect(report.graded).toHaveLength(1);
    expect(report.graded[0].hypothesis).toBe('S1-1h');

    const dailyRow = await LabScore.findOne({
      version: 'lab-v4',
      hypothesis: 'S1-1h-daily',
    }).lean();
    expect(dailyRow).toBeNull();
  });

  it('with start day set, days are graded in order, a missing price waits, and the per-trade pass output is unchanged', async () => {
    const day1Start = Date.UTC(2026, 9, 25, 0, 0, 0);
    const day2Start = day1Start + 86_400_000;
    const day3Start = day2Start + 86_400_000;

    // T1 falls in Day 1: entry at 12:10, exit at 20:10 (inside Day 1)
    const T1 = day1Start + 12 * 3600_000;
    const { start: start1, end: end1 } = priceTimesV4(T1);

    // T2 falls in Day 2: entry at 12:10, exit at 20:10 (inside Day 2)
    const T2 = day2Start + 12 * 3600_000;
    const { start: start2, end: end2 } = priceTimesV4(T2);

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T2,
      writtenAt: new Date(T2 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = day3Start + 3600_000; // Both days have ended and settled
    await seedSettlements([
      { symbol: 'BTCUSDT', rate: 0.0001, fundingTime: day1Start + 16 * 3600_000 },
      { symbol: 'BTCUSDT', rate: 0.0001, fundingTime: day2Start + 16 * 3600_000 },
    ]);

    // First test: happy path where both days are graded in order
    const mockPrices = new Map<number, number>([
      [start1, 100],
      [end1, 102],
      [start2, 103],
      [end2, 105],
    ]);

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockImplementation(async (_sym: string, _tf: string, minTime: number, maxTime: number) => {
        const klines = [];
        for (const [t, p] of mockPrices.entries()) {
          if (t >= minTime && t <= maxTime) {
            klines.push({
              openTime: t,
              open: p,
              close: p,
              high: p,
              low: p,
              volume: 1,
              quoteVolume: 1,
              trades: 1,
              takerBuyVolume: 1,
              closeTime: t + 299_999,
            });
          }
        }
        return klines;
      }),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0.0001 },
        coverage: { BTCUSDT: true },
      }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: day1Start,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.success).toBe(true);

    // Per-trade output is present and unchanged
    const perTradeGraded = report.graded.filter((g) => g.hypothesis === 'S1-1h');
    expect(perTradeGraded).toHaveLength(2);
    expect(perTradeGraded[0].barClose).toBe(T1);
    expect(perTradeGraded[1].barClose).toBe(T2);

    // Daily graded output is present and in day order
    const dailyGraded = report.graded.filter((g) => g.hypothesis === 'S1-1h-daily');
    expect(dailyGraded).toHaveLength(2);
    expect(dailyGraded[0].barClose).toBe(day1Start);
    expect(dailyGraded[1].barClose).toBe(day2Start);

    const dailyRow1 = await LabScore.findOne({
      version: 'lab-v4',
      hypothesis: 'S1-1h-daily',
      barClose: day1Start,
    }).lean();
    const dailyRow2 = await LabScore.findOne({
      version: 'lab-v4',
      hypothesis: 'S1-1h-daily',
      barClose: day2Start,
    }).lean();

    expect(dailyRow1).not.toBeNull();
    expect(dailyRow2).not.toBeNull();
    expect(dailyRow1?.state.n).toBe(1);
    expect(dailyRow2?.state.n).toBe(2);

    // Clean up daily scores for missing price test
    await LabScore.deleteMany({ hypothesis: 'S1-1h-daily' });

    // Second test: missing price for Day 2 makes Day 2 wait
    mockPrices.delete(end2); // Delete Day 2 exit price

    const reportWithMissing = await runLabGradeV4(now, deps);

    expect(reportWithMissing.success).toBe(true);

    // Day 1 graded, Day 2 pending
    const dailyGraded2 = reportWithMissing.graded.filter((g) => g.hypothesis === 'S1-1h-daily');
    expect(dailyGraded2).toHaveLength(1);
    expect(dailyGraded2[0].barClose).toBe(day1Start);

    const dailyPending = reportWithMissing.pending.filter((p) => p.hypothesis === 'S1-1h-daily');
    expect(dailyPending).toHaveLength(1);
    expect(dailyPending[0].barClose).toBe(day2Start);
  });

  it('funding settlement at 16:00 is charged to a 10:10 to 18:10 trade and not to a 17:10 to 01:10 trade', async () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;

    const T1 = dayStart + 10 * 3600_000;
    const entry1 = T1 + 10 * 60_000;
    const exit1 = entry1 + 8 * 3600_000;

    const T2 = dayStart + 17 * 3600_000;
    const entry2 = T2 + 10 * 60_000;

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1, SOLUSDT: -1 },
      skipped: [],
      inputs: {},
    });

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T2,
      writtenAt: new Date(T2 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = dayEnd + LAB_GRADE_SETTLE_MS + 1000;
    await seedSettlements([
      { symbol: 'BTCUSDT', rate: 0.0001, fundingTime: dayStart + 16 * 3600_000 },
      { symbol: 'SOLUSDT', rate: 0.0002, fundingTime: dayStart + 16 * 3600_000 },
      { symbol: 'BTCUSDT', rate: 0, fundingTime: dayEnd },
    ]);

    const mockPriceMap: Record<string, Record<number, number>> = {
      BTCUSDT: {
        [entry1]: 100,
        [exit1]: 100,
        [entry2]: 100,
        [dayEnd]: 100,
      },
      SOLUSDT: {
        [entry1]: 50,
        [exit1]: 50,
      },
    };

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockImplementation(async (sym: string, _tf: string, minTime: number, maxTime: number) => {
        const klines = [];
        const coinPrices = mockPriceMap[sym] ?? {};
        for (const [tStr, p] of Object.entries(coinPrices)) {
          const t = Number(tStr);
          if (t >= minTime && t <= maxTime) {
            klines.push({
              openTime: t,
              open: p,
              close: p,
              high: p,
              low: p,
              volume: 1,
              quoteVolume: 1,
              trades: 1,
              takerBuyVolume: 1,
              closeTime: t + 299_999,
            });
          }
        }
        return klines;
      }),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0.0001, SOLUSDT: 0.0002 },
        coverage: { BTCUSDT: true, SOLUSDT: true },
      }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: dayStart,
    };

    const report = await runLabGradeV4(now, deps);
    expect(report.success).toBe(true);

    const dailyRow = await LabScore.findOne({
      version: 'lab-v4',
      hypothesis: 'S1-1h-daily',
      barClose: dayStart,
    }).lean();

    expect(dailyRow).not.toBeNull();
    const key1Long = `BTCUSDT@${entry1}`;
    const key2Long = `BTCUSDT@${entry2}`;
    const key1Short = `SOLUSDT@${entry1}`;

    // 10:10 to 18:10 long trade spans 16:00 and pays positive rate
    expect(dailyRow?.funding?.[key1Long]).toBeCloseTo(0.0001, 12);

    // 17:10 to 01:10 trade starts after 16:00 and pays no funding
    expect(dailyRow?.funding?.[key2Long]).toBe(0);

    // 10:10 to 18:10 short trade spans 16:00 and receives positive rate
    expect(dailyRow?.funding?.[key1Short]).toBeCloseTo(-0.0002, 12);
  });

  it('trade spanning midnight grades on both days with gross summing to log return and cost on day 1 only', async () => {
    const day1Start = Date.UTC(2026, 9, 25, 0, 0, 0);
    const day2Start = day1Start + 86_400_000;
    const day3Start = day2Start + 86_400_000;

    const T1 = day1Start + 20 * 3600_000;
    const entryTime = T1 + 10 * 60_000;
    const exitTime = entryTime + 8 * 3600_000;

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = day3Start + 3600_000;
    await seedSettlements([
      { symbol: 'BTCUSDT', rate: 0, fundingTime: day2Start },
      { symbol: 'BTCUSDT', rate: 0, fundingTime: day2Start + 4 * 3600_000 },
    ]);

    const P_entry = 100;
    const P_mid = 102;
    const P_exit = 106;

    const mockPriceMap: Record<number, number> = {
      [entryTime]: P_entry,
      [day2Start]: P_mid,
      [exitTime]: P_exit,
    };

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockImplementation(async (_sym: string, _tf: string, minTime: number, maxTime: number) => {
        const klines = [];
        for (const [tStr, p] of Object.entries(mockPriceMap)) {
          const t = Number(tStr);
          if (t >= minTime && t <= maxTime) {
            klines.push({
              openTime: t,
              open: p,
              close: p,
              high: p,
              low: p,
              volume: 1,
              quoteVolume: 1,
              trades: 1,
              takerBuyVolume: 1,
              closeTime: t + 299_999,
            });
          }
        }
        return klines;
      }),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0 },
        coverage: { BTCUSDT: true },
      }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: day1Start,
    };

    const report = await runLabGradeV4(now, deps);
    expect(report.success).toBe(true);

    const dailyRow1 = await LabScore.findOne({
      version: 'lab-v4',
      hypothesis: 'S1-1h-daily',
      barClose: day1Start,
    }).lean();

    const dailyRow2 = await LabScore.findOne({
      version: 'lab-v4',
      hypothesis: 'S1-1h-daily',
      barClose: day2Start,
    }).lean();

    expect(dailyRow1).not.toBeNull();
    expect(dailyRow2).not.toBeNull();

    const key = `BTCUSDT@${entryTime}`;
    expect(dailyRow1?.prices[key]).toEqual({ start: P_entry, end: P_mid });
    expect(dailyRow2?.prices[key]).toEqual({ start: P_mid, end: P_exit });

    const grossDay1 = 1 * Math.log(P_mid / P_entry);
    const grossDay2 = 1 * Math.log(P_exit / P_mid);
    const totalExpectedGross = 1 * Math.log(P_exit / P_entry);

    expect(grossDay1 + grossDay2).toBeCloseTo(totalExpectedGross, 12);

    expect(dailyRow1?.netBookReturn).toBeCloseTo(grossDay1 - 0.0014, 12);
    expect(dailyRow2?.netBookReturn).toBeCloseTo(grossDay2, 12);
  });

  it('a day missing a needed funding settlement waits up to 72 hours, then grades with the gap recorded', async () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;
    const T1 = dayStart + 12 * 3600_000;
    const entryTime = T1 + 10 * 60_000;
    const exitTime = entryTime + 8 * 3600_000;
    const missing = dayStart + 16 * 3600_000;

    await seedSignal(T1, { BTCUSDT: 1 });
    // Only the 08:00 settlement is stored, so the 16:00 one the trade needs is missing
    await seedSettlements([{ symbol: 'BTCUSDT', rate: 0.0001, fundingTime: dayStart + 8 * 3600_000 }]);

    const makeDeps = (now: number): LabGradeV4Deps => ({
      fetchPerpKlinesRange: klinesFrom({ [entryTime]: 100, [exitTime]: 103 }),
      fundingSumsFor: vi.fn().mockResolvedValue({ sums: { BTCUSDT: 0 }, coverage: { BTCUSDT: true } }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: dayStart,
    });

    const early = await runLabGradeV4(dayEnd + 3600_000, makeDeps(dayEnd + 3600_000));
    expect(early.pending).toContainEqual({
      hypothesis: 'S1-1h-daily',
      barClose: dayStart,
      dueAt: dayEnd + 72 * 3600_000,
    });
    expect(await LabScore.findOne({ hypothesis: 'S1-1h-daily', barClose: dayStart }).lean()).toBeNull();

    const late = dayEnd + 73 * 3600_000;
    await runLabGradeV4(late, makeDeps(late));
    const row = await LabScore.findOne({ hypothesis: 'S1-1h-daily', barClose: dayStart }).lean();
    expect(row).not.toBeNull();
    expect(row?.fundingGaps).toEqual([`BTCUSDT@${missing}`]);
    expect(row?.funding?.[`BTCUSDT@${entryTime}`]).toBe(0);
    expect(row?.netBookReturn).toBeCloseTo(Math.log(103 / 100) - 0.0014, 12);
  });

  it('a 04:10 to 12:10 trade needs only the 08:00 settlement and grades without waiting when it is stored', async () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;
    const T1 = dayStart + 4 * 3600_000;
    const entryTime = T1 + 10 * 60_000;
    const exitTime = entryTime + 8 * 3600_000;
    const now = dayEnd + 3600_000;

    await seedSignal(T1, { BTCUSDT: 1 });
    await seedSettlements([{ symbol: 'BTCUSDT', rate: 0.0001, fundingTime: dayStart + 8 * 3600_000 }]);

    const report = await runLabGradeV4(now, {
      fetchPerpKlinesRange: klinesFrom({ [entryTime]: 100, [exitTime]: 103 }),
      fundingSumsFor: vi.fn().mockResolvedValue({ sums: { BTCUSDT: 0 }, coverage: { BTCUSDT: true } }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: dayStart,
    });

    expect(report.pending.filter((p) => p.hypothesis === 'S1-1h-daily')).toHaveLength(0);
    const row = await LabScore.findOne({ hypothesis: 'S1-1h-daily', barClose: dayStart }).lean();
    expect(row).not.toBeNull();
    expect(row?.fundingGaps).toBeNull();
    expect(row?.funding?.[`BTCUSDT@${entryTime}`]).toBeCloseTo(0.0001, 12);
  });

  it('a 04:10 to 12:10 trade with the 08:00 settlement missing waits, then grades with that gap and no funding', async () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;
    const T1 = dayStart + 4 * 3600_000;
    const entryTime = T1 + 10 * 60_000;
    const exitTime = entryTime + 8 * 3600_000;
    const missing = dayStart + 8 * 3600_000;

    await seedSignal(T1, { BTCUSDT: 1 });
    // A 16:00 settlement exists, which used to hide the missing 08:00 one
    await seedSettlements([{ symbol: 'BTCUSDT', rate: 0.0001, fundingTime: dayStart + 16 * 3600_000 }]);

    const makeDeps = (now: number): LabGradeV4Deps => ({
      fetchPerpKlinesRange: klinesFrom({ [entryTime]: 100, [exitTime]: 103 }),
      fundingSumsFor: vi.fn().mockResolvedValue({ sums: { BTCUSDT: 0 }, coverage: { BTCUSDT: true } }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: dayStart,
    });

    const early = await runLabGradeV4(dayEnd + 3600_000, makeDeps(dayEnd + 3600_000));
    expect(early.pending).toContainEqual({
      hypothesis: 'S1-1h-daily',
      barClose: dayStart,
      dueAt: dayEnd + 72 * 3600_000,
    });
    expect(await LabScore.findOne({ hypothesis: 'S1-1h-daily', barClose: dayStart }).lean()).toBeNull();

    const late = dayEnd + 73 * 3600_000;
    await runLabGradeV4(late, makeDeps(late));
    const row = await LabScore.findOne({ hypothesis: 'S1-1h-daily', barClose: dayStart }).lean();
    expect(row?.fundingGaps).toEqual([`BTCUSDT@${missing}`]);
    expect(row?.funding?.[`BTCUSDT@${entryTime}`]).toBe(0);
  });

  it('a 4h coin needs both 04:00 and 08:00 for a 02:10 to 10:10 trade, so a missing 08:00 makes the day wait', async () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;
    const T1 = dayStart + 2 * 3600_000;
    const entryTime = T1 + 10 * 60_000;
    const exitTime = entryTime + 8 * 3600_000;
    const now = dayEnd + 3600_000;

    await seedSignal(T1, { BTCUSDT: 1 });
    await seedSettlements([
      { symbol: 'BTCUSDT', rate: 0, fundingTime: dayStart + 4 * 3600_000, intervalHours: 4 },
      { symbol: 'BTCUSDT', rate: 0, fundingTime: dayStart + 12 * 3600_000, intervalHours: 4 },
    ]);

    const report = await runLabGradeV4(now, {
      fetchPerpKlinesRange: klinesFrom({ [entryTime]: 100, [exitTime]: 103 }),
      fundingSumsFor: vi.fn().mockResolvedValue({ sums: { BTCUSDT: 0 }, coverage: { BTCUSDT: true } }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: dayStart,
    });

    expect(report.pending).toContainEqual({
      hypothesis: 'S1-1h-daily',
      barClose: dayStart,
      dueAt: dayEnd + 72 * 3600_000,
    });
    expect(await LabScore.findOne({ hypothesis: 'S1-1h-daily', barClose: dayStart }).lean()).toBeNull();
  });

  it('the day-start settlement is not needed, and the next 00:00 settlement belongs to the earlier day', async () => {
    const day1Start = Date.UTC(2026, 9, 25, 0, 0, 0);
    const day2Start = day1Start + 86_400_000;
    const day3Start = day2Start + 86_400_000;
    const T1 = day1Start + 20 * 3600_000;
    const entryTime = T1 + 10 * 60_000;
    const exitTime = entryTime + 8 * 3600_000;
    const now = day3Start + 3600_000;
    const prices = { [entryTime]: 100, [day2Start]: 102, [exitTime]: 106 };
    const makeDeps = (dailyStartMs: number): LabGradeV4Deps => ({
      fetchPerpKlinesRange: klinesFrom(prices),
      fundingSumsFor: vi.fn().mockResolvedValue({ sums: { BTCUSDT: 0 }, coverage: { BTCUSDT: true } }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs,
    });

    await seedSignal(T1, { BTCUSDT: 1 });

    // Day 2 only: the 00:00 settlement at its start is outside (dayStart, ...], so only 04:00 is needed
    await seedSettlements([{ symbol: 'BTCUSDT', rate: 0.0003, fundingTime: day2Start + 4 * 3600_000 }]);
    const day2Only = await runLabGradeV4(now, makeDeps(day2Start));
    expect(day2Only.pending.filter((p) => p.hypothesis === 'S1-1h-daily')).toHaveLength(0);
    const day2Row = await LabScore.findOne({ hypothesis: 'S1-1h-daily', barClose: day2Start }).lean();
    expect(day2Row?.fundingGaps).toBeNull();
    expect(day2Row?.funding?.[`BTCUSDT@${entryTime}`]).toBeCloseTo(0.0003, 12);

    // Day 1 needs the next 00:00: it waits while that one is missing, then charges it to day 1
    await LabScore.deleteMany({});
    const day1Wait = await runLabGradeV4(now, makeDeps(day1Start));
    expect(day1Wait.pending).toContainEqual({
      hypothesis: 'S1-1h-daily',
      barClose: day1Start,
      dueAt: day2Start + 72 * 3600_000,
    });
    await seedSettlements([{ symbol: 'BTCUSDT', rate: 0.0002, fundingTime: day2Start }]);
    await runLabGradeV4(now, makeDeps(day1Start));
    const day1Row = await LabScore.findOne({ hypothesis: 'S1-1h-daily', barClose: day1Start }).lean();
    expect(day1Row?.fundingGaps).toBeNull();
    expect(day1Row?.funding?.[`BTCUSDT@${entryTime}`]).toBeCloseTo(0.0002, 12);
  });

  it('a daily start that is not a UTC midnight writes no daily row and reports the start error', async () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const badStart = dayStart + 3600_000;
    const now = dayStart + 5 * 86_400_000;

    const report = await runLabGradeV4(now, {
      fetchPerpKlinesRange: klinesFrom({}),
      fundingSumsFor: vi.fn().mockResolvedValue({ sums: {}, coverage: {} }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: badStart,
    });

    expect(report.errors).toContain('Daily pass start is not a UTC midnight: ' + badStart);
    expect(await LabScore.countDocuments({ hypothesis: /daily$/ })).toBe(0);
  });

  it('syncs the day coins before the funding read, and a rejecting sync still grades when stored rows cover the day', async () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;
    const T1 = dayStart + 4 * 3600_000;
    const entryTime = T1 + 10 * 60_000;
    const exitTime = entryTime + 8 * 3600_000;
    const now = dayEnd + 3600_000;

    await seedSignal(T1, { BTCUSDT: 1 });
    await seedSettlements([{ symbol: 'BTCUSDT', rate: 0, fundingTime: dayStart + 8 * 3600_000 }]);

    const sync = vi.fn().mockRejectedValue(new Error('sync down'));
    const report = await runLabGradeV4(now, {
      fetchPerpKlinesRange: klinesFrom({ [entryTime]: 100, [exitTime]: 103 }),
      fundingSumsFor: vi.fn().mockResolvedValue({ sums: { BTCUSDT: 0 }, coverage: { BTCUSDT: true } }),
      syncFundingSettlements: sync,
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: dayStart,
    });

    expect(sync).toHaveBeenCalledWith(['BTCUSDT'], now);
    expect(report.errors).toContain('Daily funding sync error (S1-1h-daily): sync down');
    expect(report.graded.filter((g) => g.hypothesis === 'S1-1h-daily')).toHaveLength(1);
    expect(await LabScore.findOne({ hypothesis: 'S1-1h-daily', barClose: dayStart }).lean()).not.toBeNull();
  });

  it('rule error isolation: an error in S1 daily pass still grades S2 and report.errors names S1-1h-daily', async () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;

    const T1 = dayStart + 4 * 3600_000;
    const entryTime = T1 + 10 * 60_000;
    const exitTime = entryTime + 8 * 3600_000;

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S2-1h',
      candidate: 'S2',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { ETHUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    const now = dayEnd + LAB_GRADE_SETTLE_MS + 1000;
    await seedSettlements([{ symbol: 'ETHUSDT', rate: 0, fundingTime: dayStart + 8 * 3600_000 }]);

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockImplementation(async (sym: string, _tf: string, minTime: number, maxTime: number) => {
        if (sym === 'BTCUSDT') {
          throw new Error('rejection for S1 symbols');
        }
        const prices = { [entryTime]: 200, [exitTime]: 205 };
        const klines = [];
        for (const [tStr, p] of Object.entries(prices)) {
          const t = Number(tStr);
          if (t >= minTime && t <= maxTime) {
            klines.push({
              openTime: t,
              open: p,
              close: p,
              high: p,
              low: p,
              volume: 1,
              quoteVolume: 1,
              trades: 1,
              takerBuyVolume: 1,
              closeTime: t + 299_999,
            });
          }
        }
        return klines;
      }),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0, ETHUSDT: 0 },
        coverage: { BTCUSDT: true, ETHUSDT: true },
      }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: dayStart,
    };

    const report = await runLabGradeV4(now, deps);

    expect(report.errors.some((e) => e.includes('Daily pass error (S1-1h-daily): rejection for S1 symbols'))).toBe(true);

    const s2DailyGraded = report.graded.filter((g) => g.hypothesis === 'S2-1h-daily');
    expect(s2DailyGraded).toHaveLength(1);
    expect(s2DailyGraded[0].barClose).toBe(dayStart);

    const s1DailyRow = await LabScore.findOne({
      version: 'lab-v4',
      hypothesis: 'S1-1h-daily',
      barClose: dayStart,
    }).lean();
    const s2DailyRow = await LabScore.findOne({
      version: 'lab-v4',
      hypothesis: 'S2-1h-daily',
      barClose: dayStart,
    }).lean();

    expect(s1DailyRow).toBeNull();
    expect(s2DailyRow).not.toBeNull();
    expect(s2DailyRow?.state.n).toBe(1);
  });

  it('a coin with two trades of the same rule in one day has two keys in weights and prices', async () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;

    const T1 = dayStart + 2 * 3600_000;
    const entry1 = T1 + 10 * 60_000;
    const exit1 = entry1 + 8 * 3600_000;

    const T2 = dayStart + 12 * 3600_000;
    const entry2 = T2 + 10 * 60_000;
    const exit2 = entry2 + 8 * 3600_000;

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T1,
      writtenAt: new Date(T1 + 60_000),
      late: false,
      scores: { BTCUSDT: 1 },
      skipped: [],
      inputs: {},
    });

    await insertLabSignalOnce({
      version: 'lab-v4',
      hypothesis: 'S1-1h',
      candidate: 'S1',
      timeframe: '1h',
      barClose: T2,
      writtenAt: new Date(T2 + 60_000),
      late: false,
      scores: { BTCUSDT: -1 },
      skipped: [],
      inputs: {},
    });

    const now = dayEnd + LAB_GRADE_SETTLE_MS + 1000;
    await seedSettlements([
      { symbol: 'BTCUSDT', rate: 0, fundingTime: dayStart + 8 * 3600_000 },
      { symbol: 'BTCUSDT', rate: 0, fundingTime: dayStart + 16 * 3600_000 },
    ]);

    const mockPriceMap: Record<number, number> = {
      [entry1]: 100,
      [exit1]: 103,
      [entry2]: 104,
      [exit2]: 99,
    };

    const deps: LabGradeV4Deps = {
      fetchPerpKlinesRange: vi.fn().mockImplementation(async (_sym: string, _tf: string, minTime: number, maxTime: number) => {
        const klines = [];
        for (const [tStr, p] of Object.entries(mockPriceMap)) {
          const t = Number(tStr);
          if (t >= minTime && t <= maxTime) {
            klines.push({
              openTime: t,
              open: p,
              close: p,
              high: p,
              low: p,
              volume: 1,
              quoteVolume: 1,
              trades: 1,
              takerBuyVolume: 1,
              closeTime: t + 299_999,
            });
          }
        }
        return klines;
      }),
      fundingSumsFor: vi.fn().mockResolvedValue({
        sums: { BTCUSDT: 0 },
        coverage: { BTCUSDT: true },
      }),
      syncFundingSettlements: vi.fn().mockResolvedValue([]),
      sleep: async () => {},
      clock: () => now,
      dailyStartMs: dayStart,
    };

    const report = await runLabGradeV4(now, deps);
    expect(report.success).toBe(true);

    const dailyRow = await LabScore.findOne({
      version: 'lab-v4',
      hypothesis: 'S1-1h-daily',
      barClose: dayStart,
    }).lean();

    expect(dailyRow).not.toBeNull();

    const key1 = `BTCUSDT@${entry1}`;
    const key2 = `BTCUSDT@${entry2}`;

    expect(Object.keys(dailyRow?.weights ?? {})).toHaveLength(2);
    expect(dailyRow?.weights?.[key1]).toBe(1);
    expect(dailyRow?.weights?.[key2]).toBe(-1);

    expect(dailyRow?.prices[key1]).toEqual({ start: 100, end: 103 });
    expect(dailyRow?.prices[key2]).toEqual({ start: 104, end: 99 });
  });
});
