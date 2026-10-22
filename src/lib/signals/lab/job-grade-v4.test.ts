// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BinanceHttpError } from '@/lib/binance-futures';
import { LabScore } from '@/lib/models/lab-score';
import { insertLabSignalOnce, LabSignal } from '@/lib/models/lab-signal';
import { type LabGradeV4Deps, runLabGradeV4 } from '@/lib/signals/lab/job-grade-v4';
import { gradeDueAtV4, priceTimesV4 } from '@/lib/signals/lab/v4/grade';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

describe('runLabGradeV4', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await LabSignal.init();
    await LabScore.init();
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    await LabSignal.deleteMany({});
    await LabScore.deleteMany({});
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
});
