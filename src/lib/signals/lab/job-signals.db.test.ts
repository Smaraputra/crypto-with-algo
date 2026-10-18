// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerpKline } from '@/lib/binance-futures';
import type { LongShortRatio } from '@/types/futures';
import { GlobalSignal } from '@/lib/models/global-signal';
import { LabSignal } from '@/lib/models/lab-signal';
import { RvSignal } from '@/lib/models/rv-signal';
import {
  type LabJobDeps,
  latestClose,
  runLabSignals8h,
  runLabSignalsFast,
} from '@/lib/signals/lab/job-signals';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

let mongoServer: MongoMemoryServer;

const T8 = Date.UTC(2026, 9, 18, 8);
const T5 = Date.UTC(2026, 9, 18, 8, 5);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await LabSignal.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('lab signal jobs', () => {
  let fetchPerpKlinesRange: ReturnType<typeof vi.fn>;
  let fetchLongShortRatio: ReturnType<typeof vi.fn>;
  let clockTime: number;
  let deps: LabJobDeps;

  function generateKlines169(barClose: number): Record<string, PerpKline[]> {
    const out: Record<string, PerpKline[]> = {};
    for (const sym of SIGNAL_SYMBOLS) {
      const bars: PerpKline[] = [];
      for (let i = 0; i < 169; i++) {
        const openTime = barClose - 169 * 3_600_000 + i * 3_600_000;
        bars.push({
          openTime,
          closeTime: openTime + 3_600_000 - 1,
          open: 100,
          high: 105,
          low: 95,
          close: 100 + (i % 7) + 1,
          volume: 1000,
          quoteVolume: 100000,
          trades: 100,
          takerBuyVolume: 500,
        });
      }
      out[sym] = bars;
    }
    return out;
  }

  function generateRatios182(barClose: number): Record<string, LongShortRatio[]> {
    const out: Record<string, LongShortRatio[]> = {};
    for (const sym of SIGNAL_SYMBOLS) {
      const points: LongShortRatio[] = [];
      for (let i = 0; i < 182; i++) {
        const timestamp = barClose - 181 * 4 * 3_600_000 + i * 4 * 3_600_000;
        points.push({
          symbol: sym,
          timestamp,
          longShortRatio: 1.0 + 0.1 * (i % 5) + 0.05,
          longAccount: 0.52,
          shortAccount: 0.48,
        });
      }
      out[sym] = points;
    }
    return out;
  }

  beforeEach(async () => {
    fetchPerpKlinesRange = vi.fn();
    fetchLongShortRatio = vi.fn();
    clockTime = T8;
    deps = {
      fetchPerpKlinesRange: fetchPerpKlinesRange as unknown as LabJobDeps['fetchPerpKlinesRange'],
      fetchLongShortRatio: fetchLongShortRatio as unknown as LabJobDeps['fetchLongShortRatio'],
      clock: () => clockTime,
    };
  });

  afterEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    await LabSignal.createIndexes();
  });

  it('1. latestClose floors now to bar close Δ', () => {
    expect(latestClose(T8 + 3 * 60_000, '8h')).toBe(T8);
    expect(latestClose(Date.UTC(2026, 9, 18, 8, 7), '5m')).toBe(T5);
    expect(latestClose(Date.UTC(2026, 9, 18, 13), '1d')).toBe(Date.UTC(2026, 9, 18));
  });

  it('2. 8h happy path at now = T8 + 3 * 60_000', async () => {
    const rvRanked = SIGNAL_SYMBOLS.map((symbol, idx) => ({
      symbol,
      compositeZ: 1.5 - idx * 0.3,
      rank: idx + 1,
    }));
    await RvSignal.collection.insertOne({
      version: 'rv-v1',
      barTime: T8 - 8 * 3_600_000,
      barCloseTime: T8,
      ranked: rvRanked,
      createdAt: new Date(T8 + 60_000),
    });

    const klinesMap = generateKlines169(T8);
    fetchPerpKlinesRange.mockImplementation(async (sym: string) => klinesMap[sym]);

    const ratiosMap = generateRatios182(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    clockTime = T8 + 3 * 60_000 + 10_000;
    const report = await runLabSignals8h(T8 + 3 * 60_000, deps);

    expect(report.success).toBe(true);
    expect(report.written).toHaveLength(3);
    expect(report.written).toEqual(
      expect.arrayContaining([
        { hypothesis: 'L1-8h', barClose: T8, late: false },
        { hypothesis: 'L3-8h', barClose: T8, late: false },
        { hypothesis: 'L4-8h', barClose: T8, late: false },
      ])
    );

    const l1Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L1-8h',
      barClose: T8,
    }).lean();
    expect(l1Row).not.toBeNull();
    expect(l1Row?.late).toBe(false);
    expect(Object.keys(l1Row?.scores ?? {})).toHaveLength(10);
    expect(l1Row?.skipped).toEqual([]);
    for (const r of rvRanked) {
      expect(l1Row?.scores[r.symbol]).toBeCloseTo(r.compositeZ);
    }

    const l3Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L3-8h',
      barClose: T8,
    }).lean();
    expect(l3Row).not.toBeNull();
    expect(Object.keys(l3Row?.scores ?? {})).toHaveLength(10);
    expect(l3Row?.skipped).toEqual([]);

    const l4Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L4-8h',
      barClose: T8,
    }).lean();
    expect(l4Row).not.toBeNull();
    expect(Object.keys(l4Row?.scores ?? {})).toHaveLength(10);
    expect(l4Row?.skipped).toEqual([]);

    for (const sym of SIGNAL_SYMBOLS) {
      expect(fetchPerpKlinesRange).toHaveBeenCalledWith(
        sym,
        '1h',
        T8 - 169 * 3_600_000,
        T8 - 1
      );
      expect(fetchLongShortRatio).toHaveBeenCalledWith(sym, '4h', 182);
    }
  });

  it('3. L1 with no rv signal yet: no L1 row, waiting holds rv_signal_missing, L3 and L4 still write', async () => {
    const klinesMap = generateKlines169(T8);
    fetchPerpKlinesRange.mockImplementation(async (sym: string) => klinesMap[sym]);
    const ratiosMap = generateRatios182(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    clockTime = T8 + 3 * 60_000;
    const report = await runLabSignals8h(T8 + 3 * 60_000, deps);

    expect(report.waiting).toContainEqual({
      hypothesis: 'L1-8h',
      barClose: T8,
      reason: 'rv_signal_missing',
    });
    expect(report.written).toEqual(
      expect.arrayContaining([
        { hypothesis: 'L3-8h', barClose: T8, late: false },
        { hypothesis: 'L4-8h', barClose: T8, late: false },
      ])
    );
    expect(report.written.some((w) => w.hypothesis === 'L1-8h')).toBe(false);

    const l1Exists = await LabSignal.exists({
      version: 'lab-v1',
      hypothesis: 'L1-8h',
      barClose: T8,
    });
    expect(l1Exists).toBeNull();
  });

  it('4. a second run at T8 + 8 * 60_000 writes nothing, reports exists three times, and calls no fetcher', async () => {
    const rvRanked = SIGNAL_SYMBOLS.map((symbol, idx) => ({
      symbol,
      compositeZ: 1.0,
      rank: idx + 1,
    }));
    await RvSignal.collection.insertOne({
      version: 'rv-v1',
      barTime: T8 - 8 * 3_600_000,
      barCloseTime: T8,
      ranked: rvRanked,
      createdAt: new Date(T8),
    });

    const klinesMap = generateKlines169(T8);
    fetchPerpKlinesRange.mockImplementation(async (sym: string) => klinesMap[sym]);
    const ratiosMap = generateRatios182(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    clockTime = T8 + 3 * 60_000;
    const firstReport = await runLabSignals8h(T8 + 3 * 60_000, deps);
    expect(firstReport.written).toHaveLength(3);

    fetchPerpKlinesRange.mockClear();
    fetchLongShortRatio.mockClear();

    clockTime = T8 + 8 * 60_000;
    const secondReport = await runLabSignals8h(T8 + 8 * 60_000, deps);

    expect(secondReport.written).toHaveLength(0);
    expect(secondReport.waiting).toEqual(
      expect.arrayContaining([
        { hypothesis: 'L1-8h', barClose: T8, reason: 'exists' },
        { hypothesis: 'L3-8h', barClose: T8, reason: 'exists' },
        { hypothesis: 'L4-8h', barClose: T8, reason: 'exists' },
      ])
    );
    expect(fetchPerpKlinesRange).not.toHaveBeenCalled();
    expect(fetchLongShortRatio).not.toHaveBeenCalled();
  });

  it('5. a klines fetch rejecting for one symbol: L3 still writes, symbol is in skipped with bars_incomplete, inputs.errors holds message', async () => {
    const klinesMap = generateKlines169(T8);
    fetchPerpKlinesRange.mockImplementation(async (sym: string) => {
      if (sym === 'BTCUSDT') {
        throw new Error('Binance 500 error for BTCUSDT');
      }
      return klinesMap[sym];
    });
    const ratiosMap = generateRatios182(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    clockTime = T8 + 3 * 60_000;
    const report = await runLabSignals8h(T8 + 3 * 60_000, deps, { final: true });

    expect(report.written.some((w) => w.hypothesis === 'L3-8h')).toBe(true);
    expect(report.errors).toContain('Binance 500 error for BTCUSDT');

    const l3Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L3-8h',
      barClose: T8,
    }).lean();
    expect(l3Row).not.toBeNull();
    expect(l3Row?.skipped).toContainEqual({
      symbol: 'BTCUSDT',
      reason: 'bars_incomplete',
    });
    expect((l3Row?.inputs as { errors?: Record<string, string> })?.errors?.['BTCUSDT']).toBe(
      'Binance 500 error for BTCUSDT'
    );
  });

  it('6. late: the clock returns T8 + 11 * 60_000 at write time, row written with late: true', async () => {
    const rvRanked = SIGNAL_SYMBOLS.map((symbol, idx) => ({
      symbol,
      compositeZ: 1.0,
      rank: idx + 1,
    }));
    await RvSignal.collection.insertOne({
      version: 'rv-v1',
      barTime: T8 - 8 * 3_600_000,
      barCloseTime: T8,
      ranked: rvRanked,
      createdAt: new Date(T8),
    });

    const klinesMap = generateKlines169(T8);
    fetchPerpKlinesRange.mockImplementation(async (sym: string) => klinesMap[sym]);
    const ratiosMap = generateRatios182(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    clockTime = T8 + 11 * 60_000;
    const report = await runLabSignals8h(T8 + 3 * 60_000, deps);

    expect(report.written).toEqual(
      expect.arrayContaining([
        { hypothesis: 'L1-8h', barClose: T8, late: true },
        { hypothesis: 'L3-8h', barClose: T8, late: true },
        { hypothesis: 'L4-8h', barClose: T8, late: true },
      ])
    );

    const l1Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L1-8h',
      barClose: T8,
    }).lean();
    expect(l1Row?.late).toBe(true);
  });

  it('7. Fast, all 10 v8 rows present at now = T5 + 2 * 60_000: L2-5m row written, score matches formula, inputs.rvBarTime is latest rv barTime', async () => {
    const v8Docs = SIGNAL_SYMBOLS.map((sym, idx) => ({
      symbol: sym,
      interval: '5m',
      tradingStyle: 'scalping',
      score: 10 + idx * 5,
      configVersion: 8,
      candleTimestamp: T5 - 5 * 60_000,
      createdAt: new Date(T5 + 30_000),
    }));
    await GlobalSignal.collection.insertMany(v8Docs);

    const olderRvBarTime = T5 - 16 * 3_600_000;
    const latestRvBarTime = T5 - 8 * 3_600_000;
    const futureRvBarTime = T5;

    const rvRanked = SIGNAL_SYMBOLS.map((sym, idx) => ({
      symbol: sym,
      compositeZ: 1.0,
      rank: idx + 1,
    }));
    const rvRankedOther = SIGNAL_SYMBOLS.map((sym, idx) => ({
      symbol: sym,
      compositeZ: 0.5,
      rank: 10 - idx,
    }));

    // Seed three rv signals: older, latest at or before T5, and after T5.
    await RvSignal.collection.insertMany([
      {
        version: 'rv-v1',
        barTime: olderRvBarTime,
        barCloseTime: T5 - 8 * 3_600_000,
        ranked: rvRankedOther,
        createdAt: new Date(T5 - 8 * 3_600_000),
      },
      {
        version: 'rv-v1',
        barTime: latestRvBarTime,
        barCloseTime: T5 - 5 * 60_000,
        ranked: rvRanked,
        createdAt: new Date(T5 - 5 * 60_000),
      },
      {
        version: 'rv-v1',
        barTime: futureRvBarTime,
        barCloseTime: T5 + 5 * 60_000,
        ranked: rvRankedOther,
        createdAt: new Date(T5 + 5 * 60_000),
      },
    ]);

    clockTime = T5 + 2 * 60_000 + 10_000;
    const report = await runLabSignalsFast(T5 + 2 * 60_000, deps);

    const written5m = report.written.find((w) => w.hypothesis === 'L2-5m');
    expect(written5m).toBeDefined();
    expect(written5m?.barClose).toBe(T5);
    expect(written5m?.late).toBe(false);

    const row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L2-5m',
      barClose: T5,
    }).lean();
    expect(row).not.toBeNull();

    for (let i = 0; i < SIGNAL_SYMBOLS.length; i++) {
      const sym = SIGNAL_SYMBOLS[i];
      const v8Score = 10 + i * 5;
      const rank = i + 1;
      const expectedScore = 0.5 * v8Score + 0.5 * ((100 * (5.5 - rank)) / 4.5);
      expect(row?.scores[sym]).toBeCloseTo(expectedScore);
    }

    expect((row?.inputs as { rvBarTime?: number })?.rvBarTime).toBe(latestRvBarTime);
  });

  it('8. Fast, 9 of 10 v8 rows at now = T5 + 2 * 60_000: no L2-5m row, v8_incomplete; same 9 rows at now = T5 + 4 * 60_000 + 30_000: written with missing symbol skipped as v8_missing', async () => {
    const v8Docs = SIGNAL_SYMBOLS.slice(1).map((sym, idx) => ({
      symbol: sym,
      interval: '5m',
      tradingStyle: 'scalping',
      score: 20 + idx * 5,
      configVersion: 8,
      candleTimestamp: T5 - 5 * 60_000,
      createdAt: new Date(T5 + 30_000),
    }));
    await GlobalSignal.collection.insertMany(v8Docs);

    const rvRanked = SIGNAL_SYMBOLS.map((sym, idx) => ({
      symbol: sym,
      compositeZ: 1.0,
      rank: idx + 1,
    }));
    await RvSignal.collection.insertOne({
      version: 'rv-v1',
      barTime: T5 - 8 * 3_600_000,
      barCloseTime: T5 - 5 * 60_000,
      ranked: rvRanked,
      createdAt: new Date(T5 - 5 * 60_000),
    });

    clockTime = T5 + 2 * 60_000;
    const report1 = await runLabSignalsFast(T5 + 2 * 60_000, deps);
    expect(report1.written.find((w) => w.hypothesis === 'L2-5m')).toBeUndefined();
    expect(report1.waiting).toContainEqual({
      hypothesis: 'L2-5m',
      barClose: T5,
      reason: 'v8_incomplete',
    });

    clockTime = T5 + 4 * 60_000 + 30_000;
    const report2 = await runLabSignalsFast(T5 + 4 * 60_000 + 30_000, deps);
    const written5m = report2.written.find((w) => w.hypothesis === 'L2-5m');
    expect(written5m).toBeDefined();
    expect(written5m?.barClose).toBe(T5);

    const row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L2-5m',
      barClose: T5,
    }).lean();
    expect(row).not.toBeNull();
    expect(row?.skipped).toContainEqual({
      symbol: SIGNAL_SYMBOLS[0],
      reason: 'v8_missing',
    });
  });

  it('9. Fast at 11 minutes past a 15m close: window_passed for L2-15m and nothing written for it', async () => {
    const T15 = Date.UTC(2026, 9, 18, 8, 15);
    const now = T15 + 11 * 60_000;
    clockTime = now;
    const report = await runLabSignalsFast(now, deps);

    expect(report.waiting).toContainEqual({
      hypothesis: 'L2-15m',
      barClose: T15,
      reason: 'window_passed',
    });

    const l2_15mRow = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L2-15m',
      barClose: T15,
    }).lean();
    expect(l2_15mRow).toBeNull();

    expect(
      report.waiting.some((w) => w.hypothesis === 'L2-5m' && w.reason === 'window_passed')
    ).toBe(false);
  });

  it('10. Two v8 rows for one symbol and bar: the earlier createdAt is the one used', async () => {
    const sym = SIGNAL_SYMBOLS[0];
    const v8Docs = [
      {
        symbol: sym,
        interval: '5m',
        tradingStyle: 'scalping',
        score: 99,
        configVersion: 8,
        candleTimestamp: T5 - 5 * 60_000,
        createdAt: new Date(T5 + 40_000),
      },
      {
        symbol: sym,
        interval: '5m',
        tradingStyle: 'scalping',
        score: 42,
        configVersion: 8,
        candleTimestamp: T5 - 5 * 60_000,
        createdAt: new Date(T5 + 10_000),
      },
      ...SIGNAL_SYMBOLS.slice(1).map((s, idx) => ({
        symbol: s,
        interval: '5m',
        tradingStyle: 'scalping',
        score: 10 + idx,
        configVersion: 8,
        candleTimestamp: T5 - 5 * 60_000,
        createdAt: new Date(T5 + 20_000),
      })),
    ];
    await GlobalSignal.collection.insertMany(v8Docs);

    const rvRanked = SIGNAL_SYMBOLS.map((s, idx) => ({
      symbol: s,
      compositeZ: 1.0,
      rank: idx + 1,
    }));
    await RvSignal.collection.insertOne({
      version: 'rv-v1',
      barTime: T5 - 8 * 3_600_000,
      barCloseTime: T5 - 5 * 60_000,
      ranked: rvRanked,
      createdAt: new Date(T5 - 5 * 60_000),
    });

    clockTime = T5 + 2 * 60_000;
    const report = await runLabSignalsFast(T5 + 2 * 60_000, deps);
    expect(report.written.some((w) => w.hypothesis === 'L2-5m')).toBe(true);

    const row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L2-5m',
      barClose: T5,
    }).lean();
    expect(row).not.toBeNull();
    const v8Inputs = (row?.inputs as { v8?: Record<string, { score: number }> })?.v8;
    expect(v8Inputs?.[sym]?.score).toBe(42);
    const expectedScore = 0.5 * 42 + 0.5 * ((100 * (5.5 - 1)) / 4.5);
    expect(row?.scores[sym]).toBeCloseTo(expectedScore);
  });

  it('11. A v8 row with configVersion: 9 is ignored (that symbol counts as missing)', async () => {
    const v8Docs = [
      {
        symbol: SIGNAL_SYMBOLS[0],
        interval: '5m',
        tradingStyle: 'scalping',
        score: 50,
        configVersion: 9,
        candleTimestamp: T5 - 5 * 60_000,
        createdAt: new Date(T5 + 10_000),
      },
      ...SIGNAL_SYMBOLS.slice(1).map((s, idx) => ({
        symbol: s,
        interval: '5m',
        tradingStyle: 'scalping',
        score: 10 + idx,
        configVersion: 8,
        candleTimestamp: T5 - 5 * 60_000,
        createdAt: new Date(T5 + 20_000),
      })),
    ];
    await GlobalSignal.collection.insertMany(v8Docs);

    const rvRanked = SIGNAL_SYMBOLS.map((s, idx) => ({
      symbol: s,
      compositeZ: 1.0,
      rank: idx + 1,
    }));
    await RvSignal.collection.insertOne({
      version: 'rv-v1',
      barTime: T5 - 8 * 3_600_000,
      barCloseTime: T5 - 5 * 60_000,
      ranked: rvRanked,
      createdAt: new Date(T5 - 5 * 60_000),
    });

    clockTime = T5 + 4 * 60_000 + 30_000;
    const report = await runLabSignalsFast(T5 + 4 * 60_000 + 30_000, deps);
    expect(report.written.some((w) => w.hypothesis === 'L2-5m')).toBe(true);

    const row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L2-5m',
      barClose: T5,
    }).lean();
    expect(row).not.toBeNull();
    expect(row?.skipped).toContainEqual({
      symbol: SIGNAL_SYMBOLS[0],
      reason: 'v8_missing',
    });
  });

  it('12. a rejecting fetch with final omitted writes no L3 row, waiting has fetch_failed for L3-8h, L1 and L4 still write, and report.errors holds the message', async () => {
    const rvRanked = SIGNAL_SYMBOLS.map((symbol, idx) => ({
      symbol,
      compositeZ: 1.5 - idx * 0.3,
      rank: idx + 1,
    }));
    await RvSignal.collection.insertOne({
      version: 'rv-v1',
      barTime: T8 - 8 * 3_600_000,
      barCloseTime: T8,
      ranked: rvRanked,
      createdAt: new Date(T8 + 60_000),
    });

    const klinesMap = generateKlines169(T8);
    fetchPerpKlinesRange.mockImplementation(async (sym: string) => {
      if (sym === 'BTCUSDT') {
        throw new Error('Binance 500 error for BTCUSDT');
      }
      return klinesMap[sym];
    });
    const ratiosMap = generateRatios182(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    clockTime = T8 + 3 * 60_000;
    const report = await runLabSignals8h(T8 + 3 * 60_000, deps);

    expect(report.written.some((w) => w.hypothesis === 'L3-8h')).toBe(false);
    expect(report.waiting).toContainEqual({
      hypothesis: 'L3-8h',
      barClose: T8,
      reason: 'fetch_failed',
    });

    const l3Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L3-8h',
      barClose: T8,
    }).lean();
    expect(l3Row).toBeNull();

    expect(report.written).toEqual(
      expect.arrayContaining([
        { hypothesis: 'L1-8h', barClose: T8, late: false },
        { hypothesis: 'L4-8h', barClose: T8, late: false },
      ])
    );
    expect(report.errors).toContain('Binance 500 error for BTCUSDT');

    const l1Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L1-8h',
      barClose: T8,
    }).lean();
    expect(l1Row).not.toBeNull();
    expect(Object.keys(l1Row?.scores ?? {})).toHaveLength(10);
    expect(l1Row?.skipped).toEqual([]);

    const l4Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L4-8h',
      barClose: T8,
    }).lean();
    expect(l4Row).not.toBeNull();
    expect(Object.keys(l4Row?.scores ?? {})).toHaveLength(10);
    expect(l4Row?.skipped).toEqual([]);
  });

  it('13. a run where every fetch succeeds writes L3 with final omitted', async () => {
    const klinesMap = generateKlines169(T8);
    fetchPerpKlinesRange.mockImplementation(async (sym: string) => klinesMap[sym]);
    const ratiosMap = generateRatios182(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    clockTime = T8 + 3 * 60_000;
    const report = await runLabSignals8h(T8 + 3 * 60_000, deps);

    expect(report.written.some((w) => w.hypothesis === 'L3-8h')).toBe(true);

    const l3Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L3-8h',
      barClose: T8,
    }).lean();
    expect(l3Row).not.toBeNull();
    expect(report.waiting.some((w) => w.hypothesis === 'L3-8h')).toBe(false);
    expect(Object.keys(l3Row?.scores ?? {})).toHaveLength(10);
    expect(l3Row?.skipped).toEqual([]);
  });

  it('14. a v8 row with candleTimestamp: T5 (the bar after, not T5 - Δ) for one symbol, with the correct rows for the other nine: that symbol counts as missing', async () => {
    const wrongSym = SIGNAL_SYMBOLS[0];
    const v8Docs = [
      {
        symbol: wrongSym,
        interval: '5m',
        tradingStyle: 'scalping',
        score: 50,
        configVersion: 8,
        candleTimestamp: T5,
        createdAt: new Date(T5 + 30_000),
      },
      ...SIGNAL_SYMBOLS.slice(1).map((sym, idx) => ({
        symbol: sym,
        interval: '5m',
        tradingStyle: 'scalping',
        score: 10 + idx * 5,
        configVersion: 8,
        candleTimestamp: T5 - 5 * 60_000,
        createdAt: new Date(T5 + 30_000),
      })),
    ];
    await GlobalSignal.collection.insertMany(v8Docs);

    const rvRanked = SIGNAL_SYMBOLS.map((sym, idx) => ({
      symbol: sym,
      compositeZ: 1.0,
      rank: idx + 1,
    }));
    await RvSignal.collection.insertOne({
      version: 'rv-v1',
      barTime: T5 - 8 * 3_600_000,
      barCloseTime: T5 - 5 * 60_000,
      ranked: rvRanked,
      createdAt: new Date(T5 - 5 * 60_000),
    });

    clockTime = T5 + 4 * 60_000 + 30_000;
    const report = await runLabSignalsFast(T5 + 4 * 60_000 + 30_000, deps);
    expect(report.written.some((w) => w.hypothesis === 'L2-5m')).toBe(true);

    const row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L2-5m',
      barClose: T5,
    }).lean();
    expect(row).not.toBeNull();
    expect(row?.skipped).toEqual([
      { symbol: wrongSym, reason: 'v8_missing' },
    ]);
    expect(Object.keys(row?.scores ?? {})).toHaveLength(9);
    expect(row?.scores[wrongSym]).toBeUndefined();
  });

  it('15. a v8 row whose createdAt is before T5 for one symbol (and no other row for it): that symbol counts as missing', async () => {
    const formingSym = SIGNAL_SYMBOLS[0];
    const v8Docs = [
      {
        symbol: formingSym,
        interval: '5m',
        tradingStyle: 'scalping',
        score: 50,
        configVersion: 8,
        candleTimestamp: T5 - 5 * 60_000,
        createdAt: new Date(T5 - 10_000),
      },
      ...SIGNAL_SYMBOLS.slice(1).map((sym, idx) => ({
        symbol: sym,
        interval: '5m',
        tradingStyle: 'scalping',
        score: 10 + idx * 5,
        configVersion: 8,
        candleTimestamp: T5 - 5 * 60_000,
        createdAt: new Date(T5 + 30_000),
      })),
    ];
    await GlobalSignal.collection.insertMany(v8Docs);

    const rvRanked = SIGNAL_SYMBOLS.map((sym, idx) => ({
      symbol: sym,
      compositeZ: 1.0,
      rank: idx + 1,
    }));
    await RvSignal.collection.insertOne({
      version: 'rv-v1',
      barTime: T5 - 8 * 3_600_000,
      barCloseTime: T5 - 5 * 60_000,
      ranked: rvRanked,
      createdAt: new Date(T5 - 5 * 60_000),
    });

    clockTime = T5 + 4 * 60_000 + 30_000;
    const report = await runLabSignalsFast(T5 + 4 * 60_000 + 30_000, deps);
    expect(report.written.some((w) => w.hypothesis === 'L2-5m')).toBe(true);

    const row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L2-5m',
      barClose: T5,
    }).lean();
    expect(row).not.toBeNull();
    expect(row?.skipped).toEqual([
      { symbol: formingSym, reason: 'v8_missing' },
    ]);
    expect(Object.keys(row?.scores ?? {})).toHaveLength(9);
    expect(row?.scores[formingSym]).toBeUndefined();
  });

  it('16. on a first attempt, a klines fetch that resolves with only 100 bars for one symbol writes no L3 row and reports inputs_incomplete, with final: true writes L3 with that symbol skipped as bars_incomplete', async () => {
    const klinesMap = generateKlines169(T8);
    const shortSym = 'BTCUSDT';
    fetchPerpKlinesRange.mockImplementation(async (sym: string) => {
      if (sym === shortSym) {
        return klinesMap[sym].slice(0, 100);
      }
      return klinesMap[sym];
    });

    const ratiosMap = generateRatios182(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    clockTime = T8 + 3 * 60_000;
    const firstReport = await runLabSignals8h(T8 + 3 * 60_000, deps);

    expect(firstReport.written.some((w) => w.hypothesis === 'L3-8h')).toBe(false);
    expect(firstReport.waiting).toContainEqual({
      hypothesis: 'L3-8h',
      barClose: T8,
      reason: 'inputs_incomplete',
    });

    const l3RowFirst = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L3-8h',
      barClose: T8,
    }).lean();
    expect(l3RowFirst).toBeNull();

    clockTime = T8 + 8 * 60_000;
    const finalReport = await runLabSignals8h(T8 + 8 * 60_000, deps, { final: true });

    expect(finalReport.written.some((w) => w.hypothesis === 'L3-8h')).toBe(true);

    const l3RowFinal = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L3-8h',
      barClose: T8,
    }).lean();
    expect(l3RowFinal).not.toBeNull();
    expect(l3RowFinal?.skipped).toEqual([
      { symbol: shortSym, reason: 'bars_incomplete' },
    ]);
    expect(Object.keys(l3RowFinal?.scores ?? {})).toHaveLength(9);
    expect(l3RowFinal?.scores[shortSym]).toBeUndefined();
  });

  it('17. on a first attempt, a ratio fetch resolving with points that end at T - 8h for one symbol writes no L4 row and reports inputs_incomplete, with final: true writes L4 with that symbol skipped as ratio_stale', async () => {
    const klinesMap = generateKlines169(T8);
    fetchPerpKlinesRange.mockImplementation(async (sym: string) => klinesMap[sym]);

    const staleSym = 'BTCUSDT';
    const ratiosMap = generateRatios182(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => {
      if (sym === staleSym) {
        return ratiosMap[sym].filter((p) => p.timestamp <= T8 - 8 * 3_600_000);
      }
      return ratiosMap[sym];
    });

    clockTime = T8 + 3 * 60_000;
    const firstReport = await runLabSignals8h(T8 + 3 * 60_000, deps);

    expect(firstReport.written.some((w) => w.hypothesis === 'L4-8h')).toBe(false);
    expect(firstReport.waiting).toContainEqual({
      hypothesis: 'L4-8h',
      barClose: T8,
      reason: 'inputs_incomplete',
    });

    const l4RowFirst = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L4-8h',
      barClose: T8,
    }).lean();
    expect(l4RowFirst).toBeNull();

    clockTime = T8 + 8 * 60_000;
    const finalReport = await runLabSignals8h(T8 + 8 * 60_000, deps, { final: true });

    expect(finalReport.written.some((w) => w.hypothesis === 'L4-8h')).toBe(true);

    const l4RowFinal = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L4-8h',
      barClose: T8,
    }).lean();
    expect(l4RowFinal).not.toBeNull();
    expect(l4RowFinal?.skipped).toEqual([
      { symbol: staleSym, reason: 'ratio_stale' },
    ]);
    expect(Object.keys(l4RowFinal?.scores ?? {})).toHaveLength(9);
    expect(l4RowFinal?.scores[staleSym]).toBeUndefined();
  });
});
