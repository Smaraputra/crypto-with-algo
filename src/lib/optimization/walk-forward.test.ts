import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  calculateWindows,
  deriveStepSize,
  deriveVolatilityStops,
  runWalkForward,
  STOP_TRUE_RANGE_MULTIPLE,
  TARGET_TRUE_RANGE_MULTIPLE,
  WALK_FORWARD_FEE_PERCENT,
} from './walk-forward';
import { DEFAULT_OPTIMIZATION_CONFIG } from '@/types/optimization';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeWarmupBars } from '@/lib/indicators/interpret-at-bar';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { filterRobustResults } from './robustness-filter';
import type { OHLCV } from '@/types/market';

const mockJobUpdateOne = vi.fn();
vi.mock('@/lib/models/optimization-job', () => ({
  OptimizationJob: {
    updateOne: (...args: unknown[]) => mockJobUpdateOne(...args),
  },
}));

vi.mock('@/lib/models/backtest-result-v2', () => ({
  BacktestResultV2: {
    create: async (doc: Record<string, unknown>) => ({ ...doc, _id: `mock-${Math.random()}` }),
  },
}));

// Wraps the real filterRobustResults so one test can force a single window's
// in-sample candidates to fail robustness (mockImplementationOnce) while
// every other call still runs the actual filter.
vi.mock('./robustness-filter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./robustness-filter')>();
  return {
    ...actual,
    filterRobustResults: vi.fn(actual.filterRobustResults),
  };
});

/** Deterministic synthetic OHLCV series, enough variance for real indicators. */
function generateSyntheticCandles(count: number, seed = 7): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 30) * 0.004;
    const noise = (nextRandom() - 0.5) * 0.8;
    price = price * (1 + drift + noise / 100);
    const high = price * (1 + nextRandom() * 0.006);
    const low = price * (1 - nextRandom() * 0.006);
    const open = price * (1 + (nextRandom() - 0.5) * 0.004);
    const volume = 1000 + nextRandom() * 5000;

    candles.push({
      timestamp: 1700000000000 + i * 3600000,
      open,
      high,
      low,
      close: price,
      volume,
    });
  }

  return candles;
}

describe('calculateWindows', () => {
  it('produces correct number of windows for standard input', () => {
    // 1000 bars, 500 train, 100 test, 100 step
    const windows = calculateWindows(1000, 500, 100, 100);

    // trainEnd starts at 499, each step adds 100
    // Window 1: trainEnd=499, testStart=500, testEnd=599 (500+100<1000)
    // Window 2: trainEnd=599, testStart=600, testEnd=699 (600+100<1000)
    // Window 3: trainEnd=699, testStart=700, testEnd=799 (700+100<1000)
    // Window 4: trainEnd=799, testStart=800, testEnd=899 (800+100<1000)
    // Window 5: trainEnd=899, testStart=900, testEnd=999 (900+100<1000? 900+100=1000, not < 1000)
    // Actually: while (trainEnd + testWindowBars < totalBars), 899+100=999 < 1000, so window 5 exists
    // Window 6: trainEnd=999, 999+100=1099 >= 1000, stop
    expect(windows).toHaveLength(5);
  });

  it('returns 1 window when totalBars equals minTraining + testWindow', () => {
    // Exact minimum: 600 bars = 500 train + 100 test
    const windows = calculateWindows(600, 500, 100, 100);

    // trainEnd=499, 499+100=599 < 600, so 1 window
    // Next: trainEnd=599, 599+100=699 >= 600, stop
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({
      trainStart: 0,
      trainEnd: 499,
      testStart: 500,
      testEnd: 599,
    });
  });

  it('returns 0 windows when totalBars < minTraining + testWindow', () => {
    const windows = calculateWindows(400, 500, 100, 100);
    expect(windows).toHaveLength(0);
  });

  it('all windows are anchored at trainStart === 0', () => {
    const windows = calculateWindows(2000, 500, 100, 100);
    expect(windows.length).toBeGreaterThan(1);

    for (const w of windows) {
      expect(w.trainStart).toBe(0);
    }
  });

  it('each window trainEnd grows by stepSize (expanding)', () => {
    const stepSize = 100;
    const windows = calculateWindows(2000, 500, 100, stepSize);
    expect(windows.length).toBeGreaterThan(1);

    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].trainEnd - windows[i - 1].trainEnd).toBe(stepSize);
    }
  });

  it('testEnd never exceeds totalBars - 1', () => {
    const totalBars = 1000;
    const windows = calculateWindows(totalBars, 300, 150, 50);

    for (const w of windows) {
      expect(w.testEnd).toBeLessThanOrEqual(totalBars - 1);
    }
  });

  it('test window immediately follows training window', () => {
    const windows = calculateWindows(1500, 400, 200, 100);

    for (const w of windows) {
      expect(w.testStart).toBe(w.trainEnd + 1);
    }
  });

  it('handles step size of 1 (many small windows)', () => {
    const windows = calculateWindows(110, 100, 5, 1);

    // trainEnd starts at 99, step 1
    // Window 1: trainEnd=99, 99+5=104 < 110
    // Window 2: trainEnd=100, 100+5=105 < 110
    // ...
    // Window 5: trainEnd=103, 103+5=108 < 110
    // Window 6: trainEnd=104, 104+5=109 < 110
    // Window 7: trainEnd=105, 105+5=110, NOT < 110, stop
    expect(windows).toHaveLength(6);
  });
});

describe('calculateWindows purge gap', () => {
  it('purgeGapBars 0 reproduces the current windows', () => {
    const noOpts = calculateWindows(1000, 500, 100, 100);
    const explicitZero = calculateWindows(1000, 500, 100, 100, { purgeGapBars: 0 });

    expect(explicitZero).toEqual(noOpts);
  });

  it('shifts every testStart by the gap and never overlaps train/test', () => {
    // A gap can shrink the window count (the last unpurged window may no
    // longer fit a full test slice), so compare only the windows gapped
    // still produces, index for index against the ungapped run.
    const gap = 25;
    const base = calculateWindows(1000, 500, 100, 100);
    const gapped = calculateWindows(1000, 500, 100, 100, { purgeGapBars: gap });

    expect(gapped.length).toBeGreaterThan(0);
    expect(gapped.length).toBeLessThanOrEqual(base.length);
    for (let i = 0; i < gapped.length; i++) {
      expect(gapped[i].testStart).toBe(base[i].testStart + gap);
      expect(gapped[i].trainEnd).toBeLessThan(gapped[i].testStart);
    }
  });

  it('the last window still fits a full test slice under a purge gap', () => {
    const testWindowBars = 100;
    const windows = calculateWindows(1000, 500, testWindowBars, 100, { purgeGapBars: 25 });
    const last = windows[windows.length - 1];

    expect(last.testEnd - last.testStart + 1).toBe(testWindowBars);
  });

  it('produces no window once the gap leaves no room for a full test slice', () => {
    // 600 bars = 500 train + 100 test exactly; any gap leaves no room.
    const windows = calculateWindows(600, 500, 100, 100, { purgeGapBars: 1 });

    expect(windows).toHaveLength(0);
  });
});

describe('calculateWindows rolling mode', () => {
  it('keeps trainStart at 0 by default (anchored)', () => {
    const windows = calculateWindows(2000, 500, 100, 100, { mode: 'anchored' });

    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      expect(w.trainStart).toBe(0);
    }
  });

  it('rolling mode slides trainStart and keeps a fixed training width', () => {
    const windows = calculateWindows(2000, 500, 100, 100, { mode: 'rolling' });

    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      expect(w.trainEnd - w.trainStart + 1).toBe(500);
    }
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].trainStart).toBeGreaterThan(windows[i - 1].trainStart);
    }
  });

  it('rollingTrainBars overrides the rolling training width', () => {
    const width = 250;
    const windows = calculateWindows(2000, 500, 100, 100, {
      mode: 'rolling',
      rollingTrainBars: width,
    });

    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w.trainEnd - w.trainStart + 1).toBe(width);
    }
  });

  it('never lets rolling trainStart go below 0', () => {
    const windows = calculateWindows(700, 500, 100, 100, {
      mode: 'rolling',
      rollingTrainBars: 500,
    });

    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w.trainStart).toBeGreaterThanOrEqual(0);
    }
  });

  it('floors rolling trainStart at 0 when rollingTrainBars exceeds minTrainingBars', () => {
    // rollingTrainBars (500) > minTrainingBars (300), so the earliest windows
    // cannot roll back a full 500 bars and the Math.max(0, ...) floor actually
    // clamps a value that would otherwise go negative.
    const rollingTrainBars = 500;
    const windows = calculateWindows(700, 300, 100, 100, { mode: 'rolling', rollingTrainBars });

    expect(windows.length).toBeGreaterThan(1);

    // First window: trainEnd - rollingTrainBars + 1 = 299 - 500 + 1 = -200,
    // floored to 0, so its training width (300) is narrower than requested.
    expect(windows[0]).toEqual({ trainStart: 0, trainEnd: 299, testStart: 300, testEnd: 399 });
    expect(windows[0].trainEnd - windows[0].trainStart + 1).toBeLessThan(rollingTrainBars);

    // Once trainEnd + 1 >= rollingTrainBars, the floor no longer binds and
    // the full requested width is achieved.
    const last = windows[windows.length - 1];
    expect(last.trainStart).toBe(last.trainEnd - rollingTrainBars + 1);
    expect(last.trainEnd - last.trainStart + 1).toBe(rollingTrainBars);
  });

  it('combines rolling mode with a purge gap (hand-checked boundaries)', () => {
    const purgeGapBars = 20;
    const rollingTrainBars = 300;
    const windows = calculateWindows(1000, 300, 100, 100, {
      mode: 'rolling',
      rollingTrainBars,
      purgeGapBars,
    });

    expect(windows.length).toBeGreaterThan(1);
    // Window 0: trainEnd=299 (minTrainingBars-1), testStart=299+1+20=320.
    expect(windows[0]).toEqual({ trainStart: 0, trainEnd: 299, testStart: 320, testEnd: 419 });
    // Window 1: trainEnd=399 (stepSizeBars=100), trainStart=399-300+1=100.
    expect(windows[1]).toEqual({ trainStart: 100, trainEnd: 399, testStart: 420, testEnd: 519 });

    for (const w of windows) {
      expect(w.testStart).toBe(w.trainEnd + 1 + purgeGapBars);
      expect(w.trainEnd - w.trainStart + 1).toBeLessThanOrEqual(rollingTrainBars);
    }
  });
});

describe('runWalkForward default purge gap', () => {
  it('resolves purgeGapBars to the style/interval indicator warmup when not passed', async () => {
    const interval = '1h';
    const tradingStyle = 'day_trading' as const;
    const symbol = 'TESTUSDT';
    const candles = generateSyntheticCandles(450);

    const expectedWarmup = computeWarmupBars(
      computeAllIndicators(candles, symbol, interval, getStyleConfig(tradingStyle).config)
    );

    const result = await runWalkForward({
      candles,
      symbol,
      interval,
      tradingStyle,
      minTrainingBars: 210,
      testWindowBars: 30,
      stepSizeBars: 50,
      candidatesPerWindow: 2,
      constraintPercent: 0.2,
      jobId: new mongoose.Types.ObjectId(),
      robustness: { minSharpe: -100, minWinRate: 0, maxDrawdown: 1, minTrades: 0, minExpectancyPercent: -Infinity },
    });

    expect(result.windows.length).toBeGreaterThan(0);
    for (const window of result.windows) {
      expect(window.testStart).toBe(window.trainEnd + 1 + expectedWarmup);
    }
  }, 30_000);

  it('clamps a rolling training width narrower than the style warmup and completes', async () => {
    const interval = '1h';
    const tradingStyle = 'day_trading' as const;
    const symbol = 'TESTUSDT';
    const candles = generateSyntheticCandles(700);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await runWalkForward({
        candles,
        symbol,
        interval,
        tradingStyle,
        minTrainingBars: 210,
        testWindowBars: 30,
        stepSizeBars: 50,
        candidatesPerWindow: 2,
        constraintPercent: 0.2,
        jobId: new mongoose.Types.ObjectId(),
        windowMode: 'rolling',
        // Far narrower than day_trading/1h's actual minimum training width,
        // which is 220 here (computeMinCandles(indicatorConfig) + 10), not
        // the 210 minTrainingBars passed above -- the indicator warmup floor
        // wins via effectiveMinTrainingBars. Without a floor, every window's
        // prepareBacktest would throw on a too-short training slice.
        rollingTrainBars: 50,
        robustness: { minSharpe: -100, minWinRate: 0, maxDrawdown: 1, minTrades: 0, minExpectancyPercent: -Infinity },
      });

      expect(result.windows.length).toBeGreaterThan(1);
      for (const window of result.windows) {
        expect(window.trainEnd - window.trainStart + 1).toBeGreaterThanOrEqual(220);
      }
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rollingTrainBars'));
    } finally {
      warnSpy.mockRestore();
    }
  }, 30_000);
});

describe('runWalkForward window records', () => {
  it('gives every returned window robustCandidates and oosMetrics (populated or null)', async () => {
    const interval = '1h';
    const tradingStyle = 'day_trading' as const;
    const symbol = 'TESTUSDT';
    const candles = generateSyntheticCandles(450);

    const result = await runWalkForward({
      candles,
      symbol,
      interval,
      tradingStyle,
      minTrainingBars: 210,
      testWindowBars: 30,
      stepSizeBars: 50,
      candidatesPerWindow: 2,
      constraintPercent: 0.2,
      jobId: new mongoose.Types.ObjectId(),
      robustness: { minSharpe: -100, minWinRate: 0, maxDrawdown: 1, minTrades: 0, minExpectancyPercent: -Infinity },
    });

    expect(result.windows.length).toBeGreaterThan(0);
    for (const window of result.windows) {
      expect(typeof window.robustCandidates).toBe('number');
      expect(window.robustCandidates).toBeGreaterThanOrEqual(0);
      if (window.oosMetrics === null) {
        expect(window.robustCandidates).toBe(0);
      } else {
        expect(typeof window.oosMetrics.expectancyPercent).toBe('number');
        expect(window.robustCandidates).toBeGreaterThan(0);
      }
    }
  }, 30_000);

  it('records a skipped window with oosMetrics null and robustCandidates 0 alongside a contributing window', async () => {
    const interval = '1h';
    const tradingStyle = 'day_trading' as const;
    const symbol = 'TESTUSDT';
    const candles = generateSyntheticCandles(700);

    const mockedFilter = vi.mocked(filterRobustResults);
    mockedFilter.mockClear();
    // Force the first window's in-sample candidates to fail robustness so it
    // is skipped, while later windows fall through to the real filter (the
    // lenient robustness config below would otherwise pass everything).
    mockedFilter.mockImplementationOnce(() => []);

    const result = await runWalkForward({
      candles,
      symbol,
      interval,
      tradingStyle,
      minTrainingBars: 210,
      testWindowBars: 30,
      stepSizeBars: 50,
      candidatesPerWindow: 2,
      constraintPercent: 0.2,
      jobId: new mongoose.Types.ObjectId(),
      robustness: { minSharpe: -100, minWinRate: 0, maxDrawdown: 1, minTrades: 0, minExpectancyPercent: -Infinity },
    });

    expect(result.windows.length).toBeGreaterThan(1);
    const [first, ...rest] = result.windows;
    expect(first.oosMetrics).toBeNull();
    expect(first.robustCandidates).toBe(0);
    expect(first.bestWeights).toBeUndefined();
    expect(first.testSharpe).toBeUndefined();
    expect(first.trainStart).toBeDefined();
    expect(first.trainEnd).toBeDefined();
    expect(first.testStart).toBeDefined();
    expect(first.testEnd).toBeDefined();
    expect(rest.some((w) => w.oosMetrics !== null)).toBe(true);
  }, 30_000);
});

describe('deriveStepSize', () => {
  const MIN_TRAINING = DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars;
  const TEST_WINDOW = DEFAULT_OPTIMIZATION_CONFIG.testWindowBars;
  const TARGET = 6;

  function windowCount(totalBars: number, targetWindows = TARGET): number {
    const step = deriveStepSize(totalBars, MIN_TRAINING, TEST_WINDOW, targetWindows);
    return calculateWindows(totalBars, MIN_TRAINING, TEST_WINDOW, step).length;
  }

  it('bounds the window count for a three-month 5m series', () => {
    // 3 months at 5m. A fixed 300-bar step yielded ~85 windows here.
    const bars = 3 * 30 * 24 * 12;

    expect(calculateWindows(bars, MIN_TRAINING, TEST_WINDOW, 300).length).toBeGreaterThan(80);
    expect(windowCount(bars)).toBeLessThanOrEqual(TARGET + 1);
  });

  it('produces multiple windows for a 48-month daily series', () => {
    // 4 years at 1d. A fixed 300-bar step yielded a single window here.
    const bars = 48 * 30;

    expect(calculateWindows(bars, MIN_TRAINING, TEST_WINDOW, 300).length).toBe(4);
    expect(windowCount(bars)).toBeGreaterThan(1);
    expect(windowCount(bars)).toBeLessThanOrEqual(TARGET + 1);
  });

  it('keeps the count near target across two orders of magnitude of series length', () => {
    for (const bars of [600, 1440, 4320, 8640, 25920]) {
      const count = windowCount(bars);

      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(TARGET + 1);
    }
  });

  it('never returns a step below 1', () => {
    expect(deriveStepSize(401, MIN_TRAINING, TEST_WINDOW, 100)).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the test window when the series cannot be stepped', () => {
    expect(deriveStepSize(400, MIN_TRAINING, TEST_WINDOW, TARGET)).toBe(TEST_WINDOW);
    expect(deriveStepSize(200, MIN_TRAINING, TEST_WINDOW, TARGET)).toBe(TEST_WINDOW);
  });

  it('rejects a target below one window', () => {
    expect(() => deriveStepSize(5000, MIN_TRAINING, TEST_WINDOW, 0)).toThrow('at least 1');
  });
});

describe('deriveVolatilityStops', () => {
  function bars(closes: number[], rangeFraction: number) {
    return closes.map((close, i) => ({
      timestamp: i * 60_000,
      open: close,
      high: close * (1 + rangeFraction / 2),
      low: close * (1 - rangeFraction / 2),
      close,
      volume: 1,
    }));
  }

  it('sizes stop and target from the median true range at a 1:2 ratio', () => {
    const stops = deriveVolatilityStops(bars(Array(50).fill(100), 0.01));

    expect(stops.medianTrueRangePercent).toBeCloseTo(0.01, 5);
    expect(stops.stopLossPercent).toBeCloseTo(0.01 * STOP_TRUE_RANGE_MULTIPLE, 5);
    expect(stops.takeProfitPercent).toBeCloseTo(0.01 * TARGET_TRUE_RANGE_MULTIPLE, 5);
    expect(stops.takeProfitPercent / stops.stopLossPercent).toBeCloseTo(2, 5);
  });

  it('gives a volatile daily series wider stops than a quiet intraday one', () => {
    // Regression: a flat 3% stop fit neither 5m BTC nor daily SOL.
    const intraday = deriveVolatilityStops(bars(Array(200).fill(80_000), 0.0015));
    const daily = deriveVolatilityStops(bars(Array(200).fill(150), 0.06));

    expect(intraday.stopLossPercent).toBeLessThan(0.03);
    expect(daily.stopLossPercent).toBeGreaterThan(0.03);
    expect(daily.stopLossPercent).toBeGreaterThan(intraday.stopLossPercent * 10);
  });

  it('counts gaps from the previous close, not only the bar range', () => {
    const series = [
      { timestamp: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      // Opens and trades entirely 5% above the prior close with no intra-bar range.
      { timestamp: 1, open: 105, high: 105, low: 105, close: 105, volume: 1 },
    ];

    expect(deriveVolatilityStops(series).medianTrueRangePercent).toBeCloseTo(0.05, 5);
  });

  it('resists a single crash bar that would inflate a mean', () => {
    const series = bars(Array(99).fill(100), 0.01);
    series.push({ timestamp: 99 * 60_000, open: 100, high: 100, low: 50, close: 60, volume: 1 });

    expect(deriveVolatilityStops(series).medianTrueRangePercent).toBeCloseTo(0.01, 5);
  });

  it('clamps the stop between 0.25% and 25%', () => {
    expect(deriveVolatilityStops(bars(Array(20).fill(100), 0.0001)).stopLossPercent).toBe(0.0025);
    expect(deriveVolatilityStops(bars(Array(20).fill(100), 0.4)).stopLossPercent).toBe(0.25);
  });

  it('keeps fee drag at or below a fifth of the risk on quiet intraday series', () => {
    // Regression: 0.25% stops against 0.2% round-trip fees wiped out the account.
    const stops = deriveVolatilityStops(bars(Array(200).fill(80_000), 0.001), WALK_FORWARD_FEE_PERCENT);
    const roundTripFees = 2 * WALK_FORWARD_FEE_PERCENT;

    expect(roundTripFees / stops.stopLossPercent).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(stops.takeProfitPercent / stops.stopLossPercent).toBeCloseTo(2, 5);
  });

  it('leaves volatile series on their true-range stop when it already clears the fee floor', () => {
    const stops = deriveVolatilityStops(bars(Array(200).fill(150), 0.06), WALK_FORWARD_FEE_PERCENT);

    expect(stops.stopLossPercent).toBeCloseTo(0.12, 5);
  });

  it('falls back to the minimum stop when there are too few bars', () => {
    const stops = deriveVolatilityStops(bars([100], 0.01));

    expect(stops.stopLossPercent).toBe(0.0025);
    expect(stops.takeProfitPercent).toBe(0.005);
  });
});
