// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  resolveWindowConfig,
  runStrategyWalkForward,
  type StrategyWalkForwardInput,
} from './strategy-walk-forward';
import type { StrategyFamily } from './strategy-families';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeWarmupBars } from '@/lib/indicators/interpret-at-bar';
import { DEFAULT_TEMPLATE_THRESHOLDS, DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import { prepareBacktest, runOptimizedBacktest } from '@/lib/backtest/optimized-engine';
import { deriveVolatilityStops } from '@/lib/optimization/walk-forward';
import { createRandomEntryStrategy, type ReferenceProfile } from '@/lib/backtest/random-entry-benchmark';
import type { OHLCV } from '@/types/market';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { BacktestConfig } from '@/lib/backtest/types';

// Deterministic random walk with trend, seeded LCG (same generator as
// src/lib/backtest/random-entry-benchmark.test.ts's generateCandles).
function generateCandles(count: number, seed = 123): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    const drift = i < count / 2 ? 0.002 : -0.002;
    const noise = (nextRandom() - 0.5) * 0.5;
    price = price * (1 + drift + noise / 100);
    const high = price * (1 + nextRandom() * 0.005);
    const low = price * (1 - nextRandom() * 0.005);
    const open = price * (1 + (nextRandom() - 0.5) * 0.003);
    const volume = 1000 + nextRandom() * 5000;

    candles.push({
      timestamp: 1700000000000 + i * 3600000,
      open,
      high,
      low,
      close: price,
      volume,
      takerBuyVolume: volume * (0.3 + nextRandom() * 0.4),
    });
  }

  return candles;
}

const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const STYLE = 'scalping' as const;
const COSTS = { feePercent: 0.0005, makerFeePercent: 0.0002, takerFeePercent: 0.0005, slippageBps: 3 };
const STRESS = { feeMultiplier: 1.5, slippageMultiplier: 1.5 };
const WINDOWS = { count: 4, trainFraction: 0.6, mode: 'anchored' as const };

function makeEntry(side: TradeSideLocal, close: number, holdBars: number): EntryDecision {
  return {
    side,
    orderType: 'market',
    stopPrice: side === 'long' ? close * 0.995 : close * 1.005,
    targetPrice: side === 'long' ? close * 1.02 : close * 0.98,
    timeStopBars: holdBars,
  };
}
type TradeSideLocal = 'long' | 'short';

/**
 * TEST-ONLY LOOKAHEAD: this strategy reads candles[bar + 1], one bar past
 * what a real strategy is ever handed. It exists only to prove the
 * selection rule and the random-entry benchmark can detect a real
 * entry-timing edge; never copy this pattern outside a test file.
 */
function makeLookaheadStrategy(name: string, holdBars = 1): Strategy {
  return {
    name,
    decideEntry(ctx: StrategyContext): EntryDecision | null {
      if (ctx.bar + 1 >= ctx.candles.length) return null;
      const close = ctx.candles[ctx.bar].close;
      const nextClose = ctx.candles[ctx.bar + 1].close;
      const side: TradeSideLocal = nextClose >= close ? 'long' : 'short';
      return makeEntry(side, close, holdBars);
    },
    decideExit(): boolean {
      return false;
    },
  };
}

describe('resolveWindowConfig', () => {
  it('produces exactly `count` contiguous, non-overlapping out-of-sample windows', () => {
    const candles = generateCandles(2500);
    const resolved = resolveWindowConfig(candles, SYMBOL, INTERVAL, STYLE, WINDOWS);

    expect(resolved.bounds).toHaveLength(WINDOWS.count);
    for (let i = 0; i < resolved.bounds.length - 1; i++) {
      expect(resolved.bounds[i + 1].testStart).toBe(resolved.bounds[i].testEnd + 1);
    }
  });

  it('sets testStart = trainEnd + 1 + purgeGapBars for every window', () => {
    const candles = generateCandles(2500);
    const resolved = resolveWindowConfig(candles, SYMBOL, INTERVAL, STYLE, WINDOWS);

    for (const bound of resolved.bounds) {
      expect(bound.testStart).toBe(bound.trainEnd + 1 + resolved.purgeGapBars);
    }
  });

  it('sets purgeGapBars to computeWarmupBars measured on the training prefix', () => {
    const candles = generateCandles(2500);
    const resolved = resolveWindowConfig(candles, SYMBOL, INTERVAL, STYLE, WINDOWS);

    const indicatorConfig = getStyleConfig(STYLE).config;
    const expected = computeWarmupBars(
      computeAllIndicators(candles.slice(0, resolved.trainBars), SYMBOL, INTERVAL, indicatorConfig)
    );
    expect(resolved.purgeGapBars).toBe(expected);
  });

  it('throws when the series is too short to produce a 50-bar test window', () => {
    const candles = generateCandles(150);
    expect(() =>
      resolveWindowConfig(candles, SYMBOL, INTERVAL, STYLE, { count: 1, trainFraction: 0.85, mode: 'anchored' })
    ).toThrow(/insufficient data/);
  });
});

describe('runStrategyWalkForward: selection', () => {
  /** sign=1 always picks the (lookahead-known) correct direction, sign=-1
   * always picks the wrong one, sign=0 never trades. */
  function makeSignFamily(): StrategyFamily {
    return {
      name: 'sign-test',
      description: 'test-only: sign encodes correct(1)/incorrect(-1)/no-trade(0) lookahead direction',
      params: [{ name: 'sign', values: [-1, 0, 1] }],
      create(params): Strategy {
        const sign = params.sign;
        return {
          name: `sign-${sign}`,
          decideEntry(ctx: StrategyContext): EntryDecision | null {
            if (sign === 0) return null;
            if (ctx.bar + 1 >= ctx.candles.length) return null;
            const close = ctx.candles[ctx.bar].close;
            const nextClose = ctx.candles[ctx.bar + 1].close;
            const correctSide: TradeSideLocal = nextClose >= close ? 'long' : 'short';
            const side: TradeSideLocal =
              sign === 1 ? correctSide : correctSide === 'long' ? 'short' : 'long';
            return makeEntry(side, close, 1);
          },
          decideExit(): boolean {
            return false;
          },
        };
      },
    };
  }

  function signInput(overrides: Partial<StrategyWalkForwardInput> = {}): StrategyWalkForwardInput {
    return {
      candles: generateCandles(2500),
      symbol: SYMBOL,
      interval: INTERVAL,
      style: STYLE,
      family: makeSignFamily(),
      cells: [{ sign: -1 }, { sign: 0 }, { sign: 1 }],
      costs: COSTS,
      fundingEnabled: false,
      windows: WINDOWS,
      minIsTrades: 5,
      stress: STRESS,
      benchmark: null,
      ...overrides,
    };
  }

  it('selects the cell with the highest in-sample expectancy among cells at or above minIsTrades', () => {
    const result = runStrategyWalkForward(signInput());

    for (const window of result.windows) {
      expect(window.skippedReason).toBeNull();
      expect(window.selectedParams).toEqual({ sign: 1 });

      const bySign = new Map(window.isCells.map((c) => [c.params.sign, c]));
      expect(bySign.get(0)!.trades).toBe(0);
      expect(bySign.get(1)!.expectancyPercent).toBeGreaterThan(bySign.get(-1)!.expectancyPercent);
    }
  });

  it('breaks a tie in favor of the earliest grid index', () => {
    const strategy = makeLookaheadStrategy('tie-strategy');
    const tieFamily: StrategyFamily = {
      name: 'tie-test',
      description: 'test-only: every cell ignores its param and returns the identical strategy',
      params: [{ name: 'variant', values: [1, 2, 3] }],
      create: () => strategy,
    };

    const result = runStrategyWalkForward(
      signInput({
        family: tieFamily,
        cells: [{ variant: 1 }, { variant: 2 }, { variant: 3 }],
      })
    );

    for (const window of result.windows) {
      expect(window.isCells[0].expectancyPercent).toBe(window.isCells[1].expectancyPercent);
      expect(window.isCells[1].expectancyPercent).toBe(window.isCells[2].expectancyPercent);
      expect(window.selectedParams).toEqual({ variant: 1 });
    }
  });

  it('skips a window with a reason when every cell falls below minIsTrades, still filling oosCells', () => {
    const result = runStrategyWalkForward(signInput({ minIsTrades: 999_999 }));

    for (const window of result.windows) {
      expect(window.selectedParams).toBeNull();
      expect(window.skippedReason).toBe('no cell reached 999999 in-sample trades');
      expect(window.oos).toBeNull();
      expect(window.oosTrades).toEqual([]);
      expect(window.stress).toBeNull();
      expect(window.benchmark).toBeNull();
      expect(window.oosCells).toHaveLength(3);
    }
  });

  it('fills oosCells for every cell in every window, and oos.trades matches oosTrades.length', () => {
    const result = runStrategyWalkForward(signInput());

    for (const window of result.windows) {
      expect(window.oosCells).toHaveLength(3);
      expect(window.oosCells.map((c) => c.params)).toEqual([{ sign: -1 }, { sign: 0 }, { sign: 1 }]);
      expect(window.oos).not.toBeNull();
      expect(window.oos!.trades).toBe(window.oosTrades.length);
    }
  });
});

describe('runStrategyWalkForward: stress', () => {
  it('reruns the selected cell at higher costs, at least matching base fees', () => {
    const signStrategy = (sign: number): Strategy => ({
      name: `sign-${sign}`,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (ctx.bar + 1 >= ctx.candles.length) return null;
        const close = ctx.candles[ctx.bar].close;
        const nextClose = ctx.candles[ctx.bar + 1].close;
        return makeEntry(nextClose >= close ? 'long' : 'short', close, 1);
      },
      decideExit(): boolean {
        return false;
      },
    });
    const family: StrategyFamily = {
      name: 'stress-test',
      description: 'test-only',
      params: [{ name: 'sign', values: [1] }],
      create: (params) => signStrategy(params.sign),
    };

    const candles = generateCandles(2500);
    const input: StrategyWalkForwardInput = {
      candles,
      symbol: SYMBOL,
      interval: INTERVAL,
      style: STYLE,
      family,
      cells: [{ sign: 1 }],
      costs: COSTS,
      fundingEnabled: false,
      windows: WINDOWS,
      minIsTrades: 5,
      stress: STRESS,
      benchmark: null,
    };
    const result = runStrategyWalkForward(input);
    const window = result.windows[0];
    expect(window.oos).not.toBeNull();
    expect(window.stress).not.toBeNull();

    // Second explicit run at the stress-adjusted cost config, reconstructed
    // the same way runStrategyWalkForward builds it, so we can compare real
    // summed fees against window.oos.fees (WindowResult['stress'] carries
    // no fees field by design, so this cannot be read off the result alone).
    const resolved = resolveWindowConfig(candles, SYMBOL, INTERVAL, STYLE, WINDOWS);
    const bound = resolved.bounds[0];
    const indicatorConfig = getStyleConfig(STYLE).config;
    const train = candles.slice(bound.trainStart, bound.trainEnd + 1);
    const preparedTrain = prepareBacktest(train, SYMBOL, INTERVAL, indicatorConfig);
    const stops = deriveVolatilityStops(train, COSTS.takerFeePercent);
    const thresholds = DEFAULT_TEMPLATE_THRESHOLDS[STYLE];
    const weights = DEFAULT_TEMPLATE_WEIGHTS[STYLE];
    const baseConfig: BacktestConfig = {
      entryThreshold: thresholds.entryThreshold,
      exitThreshold: thresholds.exitThreshold,
      shortEntryThreshold: thresholds.shortEntryThreshold,
      shortExitThreshold: thresholds.shortExitThreshold,
      weights,
      allowShorts: true,
      positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
      positionSizePercent: 0.1,
      stopLossPercent: stops.stopLossPercent,
      takeProfitPercent: stops.takeProfitPercent,
      feePercent: COSTS.feePercent,
      makerFeePercent: COSTS.makerFeePercent,
      takerFeePercent: COSTS.takerFeePercent,
      slippageBps: COSTS.slippageBps,
      fundingEnabled: false,
      startEquity: 10000,
    };
    const testSliceStart = Math.max(0, bound.testStart - preparedTrain.warmupBars);
    const testSlice = candles.slice(testSliceStart, bound.testEnd + 1);
    const preparedTest = prepareBacktest(testSlice, SYMBOL, INTERVAL, indicatorConfig);
    const stressConfig: BacktestConfig = {
      ...baseConfig,
      feePercent: baseConfig.feePercent * STRESS.feeMultiplier,
      makerFeePercent: (baseConfig.makerFeePercent as number) * STRESS.feeMultiplier,
      takerFeePercent: (baseConfig.takerFeePercent as number) * STRESS.feeMultiplier,
      slippageBps: (baseConfig.slippageBps as number) * STRESS.slippageMultiplier,
    };
    const stressRun = runOptimizedBacktest(
      preparedTest,
      stressConfig,
      SYMBOL,
      INTERVAL,
      undefined,
      signStrategy(1)
    );
    const stressFees = stressRun.trades.reduce((sum, t) => sum + t.fees, 0);

    expect(stressRun.trades.length).toBeGreaterThan(0);
    expect(stressFees).toBeGreaterThanOrEqual(window.oos!.fees);
  });
});

describe('runStrategyWalkForward: benchmark', () => {
  const lookaheadFamily: StrategyFamily = {
    name: 'lookahead-oracle',
    description: 'test-only: three hold-bar variants of the lookahead strategy',
    params: [{ name: 'holdBars', values: [1, 2, 3] }],
    create: (params) => makeLookaheadStrategy(`oracle-${params.holdBars}`, params.holdBars),
  };

  function lookaheadInput(overrides: Partial<StrategyWalkForwardInput> = {}): StrategyWalkForwardInput {
    return {
      candles: generateCandles(2500),
      symbol: SYMBOL,
      interval: INTERVAL,
      style: STYLE,
      family: lookaheadFamily,
      cells: [{ holdBars: 1 }, { holdBars: 2 }, { holdBars: 3 }],
      costs: COSTS,
      fundingEnabled: false,
      windows: WINDOWS,
      minIsTrades: 5,
      stress: STRESS,
      benchmark: { iterations: 100, seed: 999 },
      ...overrides,
    };
  }

  it('records different seeds for different windows', () => {
    const result = runStrategyWalkForward(lookaheadInput());
    const seeds = result.windows.map((w) => w.benchmark?.seed);
    expect(new Set(seeds).size).toBe(result.windows.length);
  });

  it('records null when benchmark is disabled', () => {
    const result = runStrategyWalkForward(lookaheadInput({ benchmark: null }));
    for (const window of result.windows) {
      expect(window.benchmark).toBeNull();
    }
  });

  it('records null when the selected cell has zero out-of-sample trades', () => {
    const triggerBar = 400; // far above the ~237-bar out-of-sample window, far below training's
    const trainOnlyFamily: StrategyFamily = {
      name: 'train-only-test',
      description: 'test-only: trades only once flatCount passes a threshold only training reaches',
      params: [{ name: 'x', values: [1] }],
      create: (): Strategy => {
        // A fresh counter per created strategy: runStrategyWalkForward calls
        // create() separately for the in-sample and out-of-sample runs, and
        // each must start flat-counting from zero for this bound to work.
        let flatCount = 0;
        return {
          name: 'train-only',
          decideEntry(ctx: StrategyContext): EntryDecision | null {
            flatCount++;
            if (flatCount < triggerBar) return null;
            if (ctx.bar + 1 >= ctx.candles.length) return null;
            const close = ctx.candles[ctx.bar].close;
            const nextClose = ctx.candles[ctx.bar + 1].close;
            return makeEntry(nextClose >= close ? 'long' : 'short', close, 1);
          },
          decideExit(): boolean {
            return false;
          },
        };
      },
    };

    const result = runStrategyWalkForward(
      lookaheadInput({
        family: trainOnlyFamily,
        cells: [{ x: 1 }],
        windows: { count: 1, trainFraction: 0.85, mode: 'anchored' },
      })
    );

    const window = result.windows[0];
    expect(window.selectedParams).toEqual({ x: 1 });
    expect(window.oos!.trades).toBe(0);
    expect(window.oosTrades).toEqual([]);
    expect(window.benchmark).toBeNull();
  });
});

describe('runStrategyWalkForward: determinism', () => {
  it('produces deep-equal results for two runs of identical input', () => {
    const candles = generateCandles(1200);
    const family: StrategyFamily = {
      name: 'determinism-test',
      description: 'test-only',
      params: [{ name: 'holdBars', values: [1, 2] }],
      create: (params) => makeLookaheadStrategy(`det-${params.holdBars}`, params.holdBars),
    };
    const input: StrategyWalkForwardInput = {
      candles,
      symbol: SYMBOL,
      interval: INTERVAL,
      style: STYLE,
      family,
      cells: [{ holdBars: 1 }, { holdBars: 2 }],
      costs: COSTS,
      fundingEnabled: false,
      windows: { count: 2, trainFraction: 0.5, mode: 'anchored' },
      minIsTrades: 1,
      stress: STRESS,
      benchmark: { iterations: 30, seed: 7 },
    };

    const a = runStrategyWalkForward(input);
    const b = runStrategyWalkForward(input);

    expect(a).toEqual(b);
  });
});

describe('runStrategyWalkForward: lookahead oracle beats the benchmark', () => {
  it('yields positive out-of-sample expectancy in the majority of windows and pValue < 0.05 in at least one', () => {
    const family: StrategyFamily = {
      name: 'lookahead-oracle',
      description: 'test-only: three hold-bar variants of the lookahead strategy',
      params: [{ name: 'holdBars', values: [1, 2, 3] }],
      create: (params) => makeLookaheadStrategy(`oracle-${params.holdBars}`, params.holdBars),
    };
    const input: StrategyWalkForwardInput = {
      candles: generateCandles(2500),
      symbol: SYMBOL,
      interval: INTERVAL,
      style: STYLE,
      family,
      cells: [{ holdBars: 1 }, { holdBars: 2 }, { holdBars: 3 }],
      costs: COSTS,
      fundingEnabled: false,
      windows: WINDOWS,
      minIsTrades: 5,
      stress: STRESS,
      benchmark: { iterations: 100, seed: 999 },
    };

    const result = runStrategyWalkForward(input);
    const withOos = result.windows.filter((w) => w.oos !== null);
    expect(withOos.length).toBe(result.windows.length);

    const positiveCount = withOos.filter((w) => w.oos!.expectancyPercent > 0).length;
    expect(positiveCount).toBeGreaterThan(result.windows.length / 2);

    const hasLowPValue = result.windows.some((w) => w.benchmark !== null && w.benchmark.pValue < 0.05);
    expect(hasLowPValue).toBe(true);
  });
});

describe('runStrategyWalkForward: seeded random-entry family shows no edge', () => {
  it('does not produce pValue < 0.05 in the majority of windows', () => {
    const profile: ReferenceProfile = {
      entryProbability: 0.3,
      longShare: 0.5,
      holdBars: [3, 5, 7, 10],
      stopPercents: [1, 1.5, 2, 2.5],
      rewardPercents: [2, 3, 4, null],
    };
    const family: StrategyFamily = {
      name: 'random-entry-test',
      description: 'test-only: createRandomEntryStrategy from a fixed reference profile',
      params: [{ name: 'seed', values: [11, 22, 33] }],
      create: (params) => createRandomEntryStrategy(profile, params.seed),
    };
    const input: StrategyWalkForwardInput = {
      candles: generateCandles(2500),
      symbol: SYMBOL,
      interval: INTERVAL,
      style: STYLE,
      family,
      cells: [{ seed: 11 }, { seed: 22 }, { seed: 33 }],
      costs: COSTS,
      fundingEnabled: false,
      windows: WINDOWS,
      minIsTrades: 5,
      stress: STRESS,
      benchmark: { iterations: 200, seed: 555 },
    };

    const result = runStrategyWalkForward(input);
    const withBenchmark = result.windows.filter((w) => w.benchmark !== null);
    expect(withBenchmark.length).toBeGreaterThan(0);

    const belowCount = withBenchmark.filter((w) => w.benchmark!.pValue < 0.05).length;
    expect(belowCount).toBeLessThan(withBenchmark.length / 2);
  });
});
