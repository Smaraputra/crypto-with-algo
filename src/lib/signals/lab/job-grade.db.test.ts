// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { fetchPerpKlinesRange as fetchPerpKlinesRangeFn, PerpKline } from '@/lib/binance-futures';
import { LabScore } from '@/lib/models/lab-score';
import { insertLabSignalOnce, LabSignal } from '@/lib/models/lab-signal';
import { bookTurnover } from '@/lib/signals/lab/hurdle';
import {
  gradeDueAt,
  priceTimes,
  runLabGrade,
  type LabGradeDeps,
} from '@/lib/signals/lab/job-grade';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

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
  await mongoose.connection.db?.dropDatabase();
});

describe('lab grade database job', () => {
  let fetchPerpKlinesRange: Mock<typeof fetchPerpKlinesRangeFn>;
  let deps: LabGradeDeps;

  const T1 = Date.UTC(2026, 9, 18, 0);
  const T2 = Date.UTC(2026, 9, 18, 8);
  const T3 = Date.UTC(2026, 9, 18, 16);

  function makeKlines(
    symbol: string,
    startTime: number,
    endTime: number,
    priceMultiplier = 1
  ): PerpKline[] {
    const klines: PerpKline[] = [];
    const symbolIndex = (SIGNAL_SYMBOLS as readonly string[]).indexOf(symbol);
    const basePrice = 100 + (symbolIndex >= 0 ? symbolIndex * 10 : 0);

    for (let t = startTime; t <= endTime; t += 300_000) {
      const open =
        basePrice *
        (1 + 0.0001 * (symbolIndex + 1) * ((t - startTime) / 300_000)) *
        priceMultiplier;
      klines.push({
        openTime: t,
        closeTime: t + 300_000 - 1,
        open,
        high: open * 1.01,
        low: open * 0.99,
        close: open * 1.005,
        volume: 1000,
        quoteVolume: 100_000,
        trades: 50,
        takerBuyVolume: 500,
      });
    }
    return klines;
  }

  async function seedSignal(
    barClose: number,
    hypothesis = 'L1-8h',
    candidate: 'L1' | 'L2' | 'L3' | 'L4' = 'L1',
    timeframe: '5m' | '15m' | '1h' | '4h' | '8h' | '1d' = '8h',
    scoresOverride?: Record<string, number>,
    late = false
  ) {
    const scores: Record<string, number> = scoresOverride ?? {};
    if (!scoresOverride) {
      for (let i = 0; i < SIGNAL_SYMBOLS.length; i++) {
        scores[SIGNAL_SYMBOLS[i]] = i;
      }
    }
    return insertLabSignalOnce({
      version: 'lab-v1',
      hypothesis,
      candidate,
      timeframe,
      barClose,
      writtenAt: new Date(barClose + 60_000),
      late,
      scores,
      skipped: [],
      inputs: {},
    });
  }

  beforeEach(() => {
    fetchPerpKlinesRange = vi
      .fn<typeof fetchPerpKlinesRangeFn>()
      .mockImplementation(
        async (symbol: string, _interval: string, startTime: number, endTime: number) =>
          makeKlines(symbol, startTime, endTime)
      );
    deps = {
      fetchPerpKlinesRange,
      clock: () => Date.now(),
    };
  });

  it('grades two due L1-8h bars in order while holding third as pending', async () => {
    await seedSignal(T1, 'L1-8h', 'L1', '8h');
    await seedSignal(T2, 'L1-8h', 'L1', '8h');
    await seedSignal(T3, 'L1-8h', 'L1', '8h');

    const dueT2 = gradeDueAt(T2, '8h');
    const now = dueT2 + 1000;

    const report = await runLabGrade(now, deps);

    expect(report.success).toBe(true);
    expect(report.graded).toHaveLength(2);
    expect(report.graded[0]).toMatchObject({
      hypothesis: 'L1-8h',
      barClose: T1,
      bet: false,
    });
    expect(report.graded[1]).toMatchObject({
      hypothesis: 'L1-8h',
      barClose: T2,
      bet: true,
    });

    expect(report.pending).toHaveLength(1);
    expect(report.pending[0]).toMatchObject({
      hypothesis: 'L1-8h',
      barClose: T3,
      dueAt: gradeDueAt(T3, '8h'),
    });

    const rows = await LabScore.find({ hypothesis: 'L1-8h' }).sort({ barClose: 1 });
    expect(rows).toHaveLength(2);
    expect(rows[0].barClose).toBe(T1);
    expect(rows[1].barClose).toBe(T2);
    expect(rows[0].state.n).toBe(0);
    expect(rows[0].noBetReason).toBe('no_hurdle');
    expect(rows[1].state.n).toBe(1);
    expect(rows[1].noBetReason).toBeNull();
    expect(rows[1].turnover).toBe(0);
    expect(rows[1].sHat).toBe(rows[0].s);
  });

  it('grades nothing new on a second run and calls fetcher only for bars still pending', async () => {
    await seedSignal(T1, 'L1-8h', 'L1', '8h');
    await seedSignal(T2, 'L1-8h', 'L1', '8h');
    const t3Scores: Record<string, number> = {};
    for (let i = 0; i < SIGNAL_SYMBOLS.length; i++) {
      t3Scores[SIGNAL_SYMBOLS[i]] = i === 0 ? 1 : i === 1 ? 0 : i;
    }
    await seedSignal(T3, 'L1-8h', 'L1', '8h', t3Scores);

    const dueT2 = gradeDueAt(T2, '8h');
    const now = dueT2 + 1000;

    await runLabGrade(now, deps);
    fetchPerpKlinesRange.mockClear();

    const report2 = await runLabGrade(now, deps);
    expect(report2.graded).toHaveLength(0);
    expect(report2.pending).toHaveLength(1);
    expect(report2.pending[0].barClose).toBe(T3);
    expect(fetchPerpKlinesRange).not.toHaveBeenCalled();

    const dueT3 = gradeDueAt(T3, '8h');
    const report3 = await runLabGrade(dueT3 + 1000, deps);
    expect(report3.graded).toHaveLength(1);
    expect(report3.graded[0].barClose).toBe(T3);
    expect(report3.pending).toHaveLength(0);

    const row1 = await LabScore.findOne({ hypothesis: 'L1-8h', barClose: T1 }).lean();
    const row2 = await LabScore.findOne({ hypothesis: 'L1-8h', barClose: T2 }).lean();
    const row3 = await LabScore.findOne({ hypothesis: 'L1-8h', barClose: T3 }).lean();

    expect(row1).not.toBeNull();
    expect(row2).not.toBeNull();
    expect(row3).not.toBeNull();

    expect(fetchPerpKlinesRange.mock.calls.length).toBeGreaterThan(0);
    const t3Times = priceTimes(T3, '8h');
    for (const call of fetchPerpKlinesRange.mock.calls) {
      expect(call[2]).toBeGreaterThanOrEqual(t3Times.start);
      expect(call[2]).toBe(t3Times.start);
      expect(call[3]).toBe(t3Times.end);
    }

    const expectedTurnover = bookTurnover(row2!.weights, row3!.weights!);
    expect(row3!.turnover).toBeCloseTo(expectedTurnover, 12);

    const expectedSHat = (row1!.s! + row2!.s!) / 2;
    expect(row3!.sHat).toBeCloseTo(expectedSHat, 12);

    expect(row3!.bet).toBe(true);
    expect(row3!.state.n).toBe(row2!.state.n + 1);
  });

  it('fails safely and grades nothing when a fetcher throws for one symbol', async () => {
    await seedSignal(T1, 'L1-8h', 'L1', '8h');
    const now = gradeDueAt(T1, '8h') + 1000;

    fetchPerpKlinesRange.mockImplementation(
      async (symbol: string, _interval: string, startTime: number, endTime: number) => {
        if (symbol === 'BTCUSDT') {
          throw new Error('Binance 503 Service Unavailable');
        }
        return makeKlines(symbol, startTime, endTime);
      }
    );

    const report = await runLabGrade(now, deps);
    expect(report.success).toBe(false);
    expect(report.graded).toHaveLength(0);
    expect(report.errors).toContain('Binance 503 Service Unavailable');

    const count = await LabScore.countDocuments();
    expect(count).toBe(0);

    fetchPerpKlinesRange.mockImplementation(
      async (symbol: string, _interval: string, startTime: number, endTime: number) =>
        makeKlines(symbol, startTime, endTime)
    );

    const reportRetry = await runLabGrade(now, deps);
    expect(reportRetry.success).toBe(true);
    expect(reportRetry.graded).toHaveLength(1);
    expect(reportRetry.graded[0].barClose).toBe(T1);

    const countAfter = await LabScore.countDocuments();
    expect(countAfter).toBe(1);
  });

  it('leaves missing symbol absent from prices and sets n to 9 when kline is missing', async () => {
    await seedSignal(T1, 'L1-8h', 'L1', '8h');
    const now = gradeDueAt(T1, '8h') + 1000;

    fetchPerpKlinesRange.mockImplementation(
      async (symbol: string, _interval: string, startTime: number, endTime: number) => {
        if (symbol === 'DOGEUSDT') {
          return [];
        }
        return makeKlines(symbol, startTime, endTime);
      }
    );

    const report = await runLabGrade(now, deps);
    expect(report.success).toBe(true);
    expect(report.graded).toHaveLength(1);

    const row = await LabScore.findOne({ hypothesis: 'L1-8h', barClose: T1 }).lean();
    expect(row).not.toBeNull();
    expect(row!.n).toBe(9);
    expect(row!.prices.DOGEUSDT).toBeUndefined();
    expect(Object.keys(row!.prices)).toHaveLength(9);
  });

  it('calls the fetcher at most once per symbol per run', async () => {
    await seedSignal(T1, 'L1-8h', 'L1', '8h');
    await seedSignal(T1, 'L3-8h', 'L3', '8h');
    await seedSignal(T2, 'L1-8h', 'L1', '8h');

    const now = gradeDueAt(T2, '8h') + 1000;

    fetchPerpKlinesRange.mockClear();
    const report = await runLabGrade(now, deps);
    expect(report.success).toBe(true);

    const calledSymbols = fetchPerpKlinesRange.mock.calls.map((call) => call[0]);
    const uniqueSymbols = new Set(calledSymbols);

    expect(calledSymbols.length).toBe(uniqueSymbols.size);
    expect(uniqueSymbols.size).toBe(10);
  });

  it('grades bar A while bar B is pending and blocks later bar C', async () => {
    // Bar A at T1 (due)
    // Bar B at T2 = T1 + 8h (not due because of settle time)
    // Bar C at T3 = T1 + 16h (closed by time, but after B)
    await seedSignal(T1, 'L1-8h', 'L1', '8h');
    await seedSignal(T2, 'L1-8h', 'L1', '8h');
    await seedSignal(T3, 'L1-8h', 'L1', '8h');

    const now = T3 + 5 * 60_000;
    expect(now).toBeGreaterThanOrEqual(gradeDueAt(T1, '8h'));
    expect(now).toBeLessThan(gradeDueAt(T2, '8h'));
    expect(now).toBeGreaterThanOrEqual(T3);

    const report = await runLabGrade(now, deps);

    expect(report.success).toBe(true);
    expect(report.graded).toHaveLength(1);
    expect(report.graded[0].barClose).toBe(T1);

    expect(report.pending).toHaveLength(1);
    expect(report.pending[0]).toMatchObject({
      hypothesis: 'L1-8h',
      barClose: T2,
      dueAt: gradeDueAt(T2, '8h'),
    });

    const rows = await LabScore.find({ hypothesis: 'L1-8h' });
    expect(rows).toHaveLength(1);
    expect(rows[0].barClose).toBe(T1);
  });

  it('grades L1-8h bar and L2-5m bar due in the same run with independent state chains', async () => {
    await seedSignal(T1, 'L1-8h', 'L1', '8h');
    await seedSignal(T1, 'L2-5m', 'L2', '5m');
    await seedSignal(T1 + 300_000, 'L2-5m', 'L2', '5m');

    const due8h = gradeDueAt(T1, '8h');
    const due5m = gradeDueAt(T1 + 300_000, '5m');
    const now = Math.max(due8h, due5m) + 1000;

    const report = await runLabGrade(now, deps);

    expect(report.success).toBe(true);
    expect(report.graded).toHaveLength(3);

    const gradedHypotheses = report.graded.map((g) => g.hypothesis);
    expect(gradedHypotheses).toContain('L1-8h');
    expect(gradedHypotheses).toContain('L2-5m');

    const rowL1 = await LabScore.findOne({ hypothesis: 'L1-8h', barClose: T1 }).lean();
    const rowsL2 = await LabScore.find({ hypothesis: 'L2-5m' }).sort({ barClose: 1 }).lean();

    expect(rowL1).not.toBeNull();
    expect(rowsL2).toHaveLength(2);
    expect(rowL1!.state.n).toBe(0);
    expect(rowsL2[0].state.n).toBe(0);
    expect(rowsL2[1].state.n).toBe(1);
  });

  it('grades two due bars 45 days apart in separate runs under span cap', async () => {
    const T45d = T1 + 45 * 86_400_000;
    await seedSignal(T1, 'L1-8h', 'L1', '8h');
    await seedSignal(T45d, 'L1-8h', 'L1', '8h');

    const now = gradeDueAt(T45d, '8h') + 1000;

    const report1 = await runLabGrade(now, deps);
    expect(report1.success).toBe(true);
    expect(report1.graded).toHaveLength(1);
    expect(report1.graded[0].barClose).toBe(T1);

    const rowsRun1 = await LabScore.find({ hypothesis: 'L1-8h' });
    expect(rowsRun1).toHaveLength(1);
    expect(rowsRun1[0].barClose).toBe(T1);

    const report2 = await runLabGrade(now, deps);
    expect(report2.success).toBe(true);
    expect(report2.graded).toHaveLength(1);
    expect(report2.graded[0].barClose).toBe(T45d);

    const rowsRun2 = await LabScore.find({ hypothesis: 'L1-8h' }).sort({ barClose: 1 });
    expect(rowsRun2).toHaveLength(2);
    expect(rowsRun2[0].barClose).toBe(T1);
    expect(rowsRun2[1].barClose).toBe(T45d);
  });
});
