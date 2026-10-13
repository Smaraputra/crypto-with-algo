import { describe, expect, it } from 'vitest';
import {
  generateWalkForwardWindows,
  stitchOutOfSampleRecords,
  calculateRecordStats,
  type WalkForwardConfig,
  type WalkForwardFoldResult,
} from './cross-sectional-walkforward';
import type { BarReturnRecord } from './cross-sectional-harness';

describe('generateWalkForwardWindows', () => {
  it('generates non-overlapping rolling walk-forward window slices', () => {
    const totalBars = 3000;
    const config: WalkForwardConfig = {
      trainBars: 1000,
      testBars: 200,
      stepBars: 200,
      purgeGapBars: 40,
      windowMode: 'rolling',
    };

    const windows = generateWalkForwardWindows(totalBars, config);
    expect(windows.length).toBeGreaterThan(0);

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      expect(w.fold).toBe(i + 1);

      // Verify strict temporal ordering
      expect(w.trainStartIdx).toBeLessThan(w.trainEndIdx);
      expect(w.trainEndIdx).toBe(w.purgeStartIdx);
      expect(w.purgeStartIdx).toBeLessThan(w.purgeEndIdx);
      expect(w.purgeEndIdx).toBe(w.testStartIdx);
      expect(w.testStartIdx).toBeLessThan(w.testEndIdx);
      expect(w.testEndIdx).toBeLessThanOrEqual(totalBars);

      // Verify exact bar widths
      expect(w.trainBars).toBe(1000);
      expect(w.testBars).toBe(200);
      expect(w.purgeEndIdx - w.purgeStartIdx).toBe(40);
    }

    // Verify rolling offset progression
    if (windows.length > 1) {
      expect(windows[1].trainStartIdx - windows[0].trainStartIdx).toBe(200);
      expect(windows[1].testStartIdx - windows[0].testStartIdx).toBe(200);
    }
  });

  it('supports anchored expanding window mode', () => {
    const totalBars = 2000;
    const config: WalkForwardConfig = {
      trainBars: 500,
      testBars: 100,
      stepBars: 100,
      purgeGapBars: 20,
      windowMode: 'anchored',
    };

    const windows = generateWalkForwardWindows(totalBars, config);
    expect(windows.length).toBeGreaterThan(0);

    for (const w of windows) {
      expect(w.trainStartIdx).toBe(0); // Anchored to origin
    }
    if (windows.length > 1) {
      expect(windows[1].trainBars).toBe(600); // Expanding
    }
  });
});

describe('stitchOutOfSampleRecords', () => {
  it('concatenates test records across folds', () => {
    const r1: BarReturnRecord = {
      timestamp: 1000,
      grossReturn: 0.01,
      netMakerReturn: 0.009,
      netTakerReturn: 0.005,
      fundingReturn: 0,
      turnover: 0.5,
      positions: [],
    };
    const r2: BarReturnRecord = {
      timestamp: 2000,
      grossReturn: -0.005,
      netMakerReturn: -0.006,
      netTakerReturn: -0.01,
      fundingReturn: 0,
      turnover: 0.2,
      positions: [],
    };

    const foldResults: WalkForwardFoldResult[] = [
      {
        fold: 1,
        window: {
          fold: 1,
          trainStartIdx: 0,
          trainEndIdx: 100,
          purgeStartIdx: 100,
          purgeEndIdx: 110,
          testStartIdx: 110,
          testEndIdx: 120,
          trainBars: 100,
          testBars: 10,
        },
        testRecords: [r1],
        testStats: calculateRecordStats('Fold 1', [r1], 1000),
      },
      {
        fold: 2,
        window: {
          fold: 2,
          trainStartIdx: 20,
          trainEndIdx: 120,
          purgeStartIdx: 120,
          purgeEndIdx: 130,
          testStartIdx: 130,
          testEndIdx: 140,
          trainBars: 100,
          testBars: 10,
        },
        testRecords: [r2],
        testStats: calculateRecordStats('Fold 2', [r2], 1000),
      },
    ];

    const stitched = stitchOutOfSampleRecords(foldResults);
    expect(stitched).toHaveLength(2);
    expect(stitched[0]).toEqual(r1);
    expect(stitched[1]).toEqual(r2);
  });
});

describe('calculateRecordStats', () => {
  it('correctly calculates compounding returns and Sharpe ratio', () => {
    const records: BarReturnRecord[] = [
      {
        timestamp: 1,
        grossReturn: 0.01,
        netMakerReturn: 0.01,
        netTakerReturn: 0.005,
        fundingReturn: 0,
        turnover: 0.2,
        positions: [],
      },
      {
        timestamp: 2,
        grossReturn: 0.02,
        netMakerReturn: 0.02,
        netTakerReturn: 0.015,
        fundingReturn: 0,
        turnover: 0.2,
        positions: [],
      },
      {
        timestamp: 3,
        grossReturn: -0.01,
        netMakerReturn: -0.01,
        netTakerReturn: -0.015,
        fundingReturn: 0,
        turnover: 0.2,
        positions: [],
      },
    ];

    const stats = calculateRecordStats('Test', records, 365.25 * 3);
    expect(stats.bars).toBe(3);
    expect(stats.totalNetMakerReturnPct).toBeGreaterThan(0);
    expect(Number.isFinite(stats.annualizedNetMakerSharpe)).toBe(true);
    expect(stats.winRateNetMaker).toBeCloseTo(2 / 3, 2);
  });
});
