// @vitest-environment node
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerpKline } from '@/lib/binance-futures';
import type { LongShortRatio } from '@/types/futures';
import { LabRatioPoint, storeRatioPoints } from '@/lib/models/lab-ratio-point';
import { LabSignal } from '@/lib/models/lab-signal';
import { RvSignal } from '@/lib/models/rv-signal';
import { L4_LAG_MS, L4_PERIOD_MS } from '@/lib/signals/lab/candidates';
import { positioningZ, type RatioPoint } from '@/lib/signals/lab/factors';
import {
  type LabJobDeps,
  runLabSignals8h,
} from '@/lib/signals/lab/job-signals';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

let mongoServer: MongoMemoryServer;

const T8 = Date.UTC(2026, 9, 18, 8);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await LabSignal.init();
  await LabRatioPoint.init();
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('job-signals L4 ratio store and window repair', () => {
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

  /**
   * Generates the newest 180 points ending at T (Binance 30-day window).
   * Index 0 is T - 179 * 4h.
   * Index 178 is T - 4h (cutoff).
   * Index 179 is T.
   * At or before T - 4h, there are exactly 179 points.
   */
  function generateRatios180EndingAtT(barClose: number): Record<string, LongShortRatio[]> {
    const out: Record<string, LongShortRatio[]> = {};
    for (const sym of SIGNAL_SYMBOLS) {
      const points: LongShortRatio[] = [];
      for (let i = 0; i < 180; i++) {
        const timestamp = barClose - (179 - i) * L4_PERIOD_MS;
        points.push({
          symbol: sym,
          timestamp,
          longShortRatio: 1.0 + 0.05 * (i % 7) + 0.02,
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
    clockTime = T8 + 3 * 60_000;
    deps = {
      fetchPerpKlinesRange: fetchPerpKlinesRange as unknown as LabJobDeps['fetchPerpKlinesRange'],
      fetchLongShortRatio: fetchLongShortRatio as unknown as LabJobDeps['fetchLongShortRatio'],
      clock: () => clockTime,
    };

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
  });

  afterEach(async () => {
    await mongoose.connection.db?.dropDatabase();
    await LabSignal.createIndexes();
    await LabRatioPoint.createIndexes();
  });

  it('scores every coin when REST returns 180 points ending at T and store holds the point stamped T - 4h - 179 x 4h', async () => {
    const cutoff = T8 - L4_LAG_MS;
    const oldestTimestampNeeded = cutoff - 179 * L4_PERIOD_MS; // T - 4h - 179 x 4h

    // Pre-seed the store with the single missing point for each symbol
    for (const sym of SIGNAL_SYMBOLS) {
      await storeRatioPoints(
        sym,
        '4h',
        [{ timestamp: oldestTimestampNeeded, longShortRatio: 1.35 }],
        new Date(oldestTimestampNeeded)
      );
    }

    const ratiosMap = generateRatios180EndingAtT(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    const report = await runLabSignals8h(clockTime, deps);

    expect(report.written).toContainEqual({
      hypothesis: 'L4-8h',
      barClose: T8,
      late: false,
    });

    const l4Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L4-8h',
      barClose: T8,
    }).lean();

    expect(l4Row).not.toBeNull();
    expect(l4Row?.skipped).toEqual([]);
    expect(Object.keys(l4Row?.scores ?? {})).toHaveLength(SIGNAL_SYMBOLS.length);

    for (const sym of SIGNAL_SYMBOLS) {
      // Build fullWindow directly from the 180 points (1 from store, 179 from REST at or before cutoff)
      const restPoints = ratiosMap[sym]
        .filter((p) => p.timestamp <= cutoff)
        .map((p) => ({ timestamp: p.timestamp, longShortRatio: p.longShortRatio }));
      const fullWindow: RatioPoint[] = [
        { timestamp: oldestTimestampNeeded, longShortRatio: 1.35 },
        ...restPoints,
      ];

      const expectedZ = positioningZ(fullWindow, T8);
      expect(typeof expectedZ).not.toBe('string');
      const expectedScore = -(expectedZ as { z: number }).z;

      expect(l4Row?.scores[sym]).toBeCloseTo(expectedScore);

      const pointsInput = (l4Row?.inputs.points as Record<string, { storedPoints: number }>)[sym];
      expect(pointsInput).toBeDefined();
      expect(pointsInput.storedPoints).toBe(1);
    }
  });

  it('with an empty store, the same REST input skips with ratio_incomplete', async () => {
    const ratiosMap = generateRatios180EndingAtT(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    // First attempt (final omitted / false): waiting has inputs_incomplete
    const firstReport = await runLabSignals8h(clockTime, deps, { final: false });
    expect(firstReport.waiting).toContainEqual({
      hypothesis: 'L4-8h',
      barClose: T8,
      reason: 'inputs_incomplete',
    });
    expect(firstReport.written.some((w) => w.hypothesis === 'L4-8h')).toBe(false);

    // Final attempt: writes L4-8h with all coins skipped as ratio_incomplete
    const finalReport = await runLabSignals8h(clockTime, deps, { final: true });
    expect(finalReport.written).toContainEqual({
      hypothesis: 'L4-8h',
      barClose: T8,
      late: false,
    });

    const l4Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L4-8h',
      barClose: T8,
    }).lean();

    expect(l4Row).not.toBeNull();
    expect(l4Row?.scores).toEqual({});
    expect(l4Row?.skipped).toHaveLength(SIGNAL_SYMBOLS.length);
    for (const skip of l4Row?.skipped ?? []) {
      expect(skip.reason).toBe('ratio_incomplete');
    }
  });

  it('records inputs.windowSizes for skipped coins', async () => {
    const ratiosMap = generateRatios180EndingAtT(T8);
    fetchLongShortRatio.mockImplementation(async (sym: string) => ratiosMap[sym]);

    await runLabSignals8h(clockTime, deps, { final: true });

    const l4Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L4-8h',
      barClose: T8,
    }).lean();

    expect(l4Row).not.toBeNull();
    const windowSizes = l4Row?.inputs.windowSizes as Record<string, number>;
    expect(windowSizes).toBeDefined();
    for (const sym of SIGNAL_SYMBOLS) {
      expect(windowSizes[sym]).toBe(179);
    }
  });

  it('scores from stored points alone on final attempt when REST fetch fails', async () => {
    const cutoff = T8 - L4_LAG_MS;

    // Seed 180 points for all symbols in the store
    for (const sym of SIGNAL_SYMBOLS) {
      const points: { timestamp: number; longShortRatio: number }[] = [];
      for (let i = 0; i < 180; i++) {
        points.push({
          timestamp: cutoff - (179 - i) * L4_PERIOD_MS,
          longShortRatio: 1.0 + 0.05 * (i % 5) + 0.01,
        });
      }
      await storeRatioPoints(sym, '4h', points, new Date(cutoff));
    }

    // Fail REST fetch
    fetchLongShortRatio.mockRejectedValue(new Error('Binance 502 Bad Gateway'));

    // On final attempt, should score from stored points alone
    const report = await runLabSignals8h(clockTime, deps, { final: true });
    expect(report.written).toContainEqual({
      hypothesis: 'L4-8h',
      barClose: T8,
      late: false,
    });

    const l4Row = await LabSignal.findOne({
      version: 'lab-v1',
      hypothesis: 'L4-8h',
      barClose: T8,
    }).lean();

    expect(l4Row).not.toBeNull();
    expect(l4Row?.skipped).toEqual([]);
    expect(Object.keys(l4Row?.scores ?? {})).toHaveLength(SIGNAL_SYMBOLS.length);

    for (const sym of SIGNAL_SYMBOLS) {
      const pointsInput = (l4Row?.inputs.points as Record<string, { storedPoints: number }>)[sym];
      expect(pointsInput.storedPoints).toBe(180);
    }
  });
});
