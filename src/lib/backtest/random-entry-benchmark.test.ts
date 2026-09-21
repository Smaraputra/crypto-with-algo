// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  referenceProfile,
  createRandomEntryStrategy,
  randomEntryBenchmark,
  type ReferenceProfile,
} from './random-entry-benchmark';
import { prepareBacktest, runOptimizedBacktest } from './optimized-engine';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import { studyCostConfig } from './cost-model';
import type { BacktestConfig, BacktestResult, BacktestTrade } from './types';
import type { EntryDecision, Strategy, StrategyContext } from './strategy';
import type { OHLCV } from '@/types/market';

// Deterministic random walk with trend, seeded LCG (same generator as
// engine-parity.test.ts and strategies/score-threshold.test.ts).
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

function makeTrade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    entryBar: 0,
    exitBar: 1,
    entryTime: 1000,
    exitTime: 2000,
    side: 'long',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    pnl: 10,
    pnlPercent: 10,
    fees: 0.2,
    exitReason: 'signal',
    entryScore: 40,
    exitScore: -15,
    entryTier: 'buy',
    holdTimeBars: 5,
    riskPercent: 2,
    rewardPercent: 4,
    slippageCost: 0,
    entryFillKind: 'taker',
    exitFillKind: 'taker',
    fundingCost: 0,
    ...overrides,
  };
}

function makeResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    symbol: 'BTCUSDT',
    interval: '1h',
    config: DEFAULT_BACKTEST_CONFIG,
    trades: [],
    equityCurve: [],
    metrics: {
      totalPnl: 0,
      totalPnlPercent: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
      avgWin: 0,
      avgLoss: 0,
      avgWinPercent: 0,
      avgLossPercent: 0,
      totalFees: 0,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      expectancyPercent: 0,
      expectancyR: null,
    },
    startTime: 0,
    endTime: 0,
    totalBars: 40,
    warmupBars: 15,
    ...overrides,
  };
}

describe('referenceProfile', () => {
  it('computes entryProbability, longShare, and the per-trade arrays from reference trades', () => {
    const trades: BacktestTrade[] = [
      makeTrade({ side: 'long', holdTimeBars: 5, riskPercent: 2, rewardPercent: 4 }),
      makeTrade({ side: 'long', holdTimeBars: 10, riskPercent: 3, rewardPercent: null }),
      makeTrade({ side: 'short', holdTimeBars: 3, riskPercent: 1.5, rewardPercent: 3 }),
      makeTrade({ side: 'long', holdTimeBars: 8, riskPercent: 2.5, rewardPercent: 5 }),
    ];
    const result = makeResult({ trades, totalBars: 40, warmupBars: 15 });

    const profile = referenceProfile(result);

    // Flat bars = totalBars (40) minus held bars (5+10+3+8=26) = 14, not 40.
    expect(profile.entryProbability).toBeCloseTo(4 / 14);
    expect(profile.longShare).toBeCloseTo(0.75);
    expect(profile.holdBars).toEqual([5, 10, 3, 8]);
    expect(profile.stopPercents).toEqual([2, 3, 1.5, 2.5]);
    expect(profile.rewardPercents).toEqual([4, null, 3, 5]);
  });

  it('clamps entryProbability to 1 when trades outnumber active bars', () => {
    const trades: BacktestTrade[] = Array.from({ length: 5 }, () => makeTrade());
    const result = makeResult({ trades, totalBars: 2, warmupBars: 0 });

    const profile = referenceProfile(result);

    expect(profile.entryProbability).toBe(1);
  });

  it('throws when the reference has no trades', () => {
    const result = makeResult({ trades: [] });

    expect(() => referenceProfile(result)).toThrow();
  });
});

describe('createRandomEntryStrategy', () => {
  const profile: ReferenceProfile = {
    entryProbability: 0.3,
    longShare: 0.5,
    holdBars: [3, 5, 7],
    stopPercents: [1, 2, 3],
    rewardPercents: [2, 4, null],
  };

  function makeCtx(bar: number, candles: OHLCV[]): StrategyContext {
    return {
      bar,
      candles,
      interval: '1h',
      suite: null,
      score: 0,
      tier: 'neutral',
      superTrend: null,
      snapshot: null,
      snapshots: [],
      research: [],
      htfContext: null,
      session: null,
      position: null,
      pendingOrder: null,
    };
  }

  function runManyEntries(strategy: Strategy, candles: OHLCV[]): (EntryDecision | null)[] {
    const decisions: (EntryDecision | null)[] = [];
    for (let bar = 0; bar < candles.length; bar++) {
      decisions.push(strategy.decideEntry(makeCtx(bar, candles), DEFAULT_BACKTEST_CONFIG));
    }
    return decisions;
  }

  it('is deterministic for a given seed', () => {
    const candles = generateCandles(150);
    const a = runManyEntries(createRandomEntryStrategy(profile, 42), candles);
    const b = runManyEntries(createRandomEntryStrategy(profile, 42), candles);
    expect(a).toEqual(b);
  });

  it('differs across seeds', () => {
    const candles = generateCandles(150);
    const a = runManyEntries(createRandomEntryStrategy(profile, 42), candles);
    const c = runManyEntries(createRandomEntryStrategy(profile, 43), candles);
    expect(a).not.toEqual(c);
  });

  it('never exits by signal', () => {
    const strategy = createRandomEntryStrategy(profile, 1);
    const candles = generateCandles(1);
    expect(strategy.decideExit(makeCtx(0, candles), DEFAULT_BACKTEST_CONFIG)).toBe(false);
  });

  it('samples stop, target, and time-stop from the profile arrays for an entry', () => {
    const candles = generateCandles(150);
    const decisions = runManyEntries(createRandomEntryStrategy(profile, 7), candles);
    const entries = decisions.filter((d): d is EntryDecision => d !== null);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.orderType).toBe('market');
      expect(entry.timeStopBars).not.toBeNull();
      expect(profile.holdBars).toContain(entry.timeStopBars);
    }
  });
});

describe('random-entry benchmark against a real engine run', () => {
  // Low thresholds guarantee trading activity on the synthetic series (same
  // pattern as engine-parity.test.ts), so the score-threshold baseline used
  // to build a reference profile has enough trades to sample from.
  const config: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    allowShorts: true,
    entryThreshold: 15,
    exitThreshold: -5,
    shortEntryThreshold: -15,
    shortExitThreshold: 5,
  };

  it('trade count stays within 10% of the reference on average across 20 seeds', () => {
    // Dividing entryProbability by the reference's flat-bar count (not
    // totalBars) brings this well under the old 30% tolerance: measured at
    // ~1.7% on this series (6 reference trades, avg 5.9 across the 20
    // seeds). 10% keeps meaningful headroom above that without reopening
    // the door to the old under-counting bug.
    const candles = generateCandles(600);
    const prepared = prepareBacktest(candles, 'BTCUSDT', '1h');
    const reference = runOptimizedBacktest(prepared, config, 'BTCUSDT', '1h');
    expect(reference.trades.length).toBeGreaterThan(0);

    const profile = referenceProfile(reference);
    const seeds = Array.from({ length: 20 }, (_, i) => i * 97 + 11);
    const counts = seeds.map((seed) => {
      const strategy = createRandomEntryStrategy(profile, seed);
      const result = runOptimizedBacktest(prepared, config, 'BTCUSDT', '1h', undefined, strategy);
      return result.trades.length;
    });
    const avgCount = counts.reduce((sum, c) => sum + c, 0) / counts.length;
    const relativeDiff = Math.abs(avgCount - reference.trades.length) / reference.trades.length;

    expect(relativeDiff).toBeLessThan(0.1);
  });

  it('a planted edge (test-only lookahead oracle) beats the benchmark', () => {
    // TEST-ONLY LOOKAHEAD: this strategy reads candles[bar + 1], one bar past
    // what a real strategy is ever handed. It exists only to prove the
    // benchmark can detect a real entry-timing edge; never copy this pattern
    // outside a test file.
    const oracleStrategy: Strategy = {
      name: 'test-only-oracle-lookahead',
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (ctx.bar + 1 >= ctx.candles.length) return null;
        const close = ctx.candles[ctx.bar].close;
        const nextClose = ctx.candles[ctx.bar + 1].close;
        const side = nextClose >= close ? 'long' : 'short';
        return {
          side,
          orderType: 'market',
          stopPrice: side === 'long' ? close * 0.98 : close * 1.02,
          targetPrice: side === 'long' ? close * 1.01 : close * 0.99,
          timeStopBars: 1,
        };
      },
      decideExit(): boolean {
        return false;
      },
    };

    const candles = generateCandles(600);
    const prepared = prepareBacktest(candles, 'BTCUSDT', '1h');
    const oracleResult = runOptimizedBacktest(prepared, config, 'BTCUSDT', '1h', undefined, oracleStrategy);
    expect(oracleResult.trades.length).toBeGreaterThan(0);

    const benchmark = randomEntryBenchmark(prepared, config, 'BTCUSDT', '1h', oracleResult, {
      iterations: 200,
      seed: 2024,
    });

    expect(benchmark.pValue).toBeLessThan(0.05);
  });

  it('no edge: a random reference scores a mid-range pValue for at least 4 of 5 seeds', () => {
    const candles = generateCandles(600);
    const prepared = prepareBacktest(candles, 'BTCUSDT', '1h');
    const baseline = runOptimizedBacktest(prepared, config, 'BTCUSDT', '1h');
    const baseProfile = referenceProfile(baseline);

    const seeds = [11, 22, 33, 44, 55];
    let midRangeCount = 0;
    for (const seed of seeds) {
      const randomReference = runOptimizedBacktest(
        prepared,
        config,
        'BTCUSDT',
        '1h',
        undefined,
        createRandomEntryStrategy(baseProfile, seed)
      );
      if (randomReference.trades.length === 0) continue;

      const benchmark = randomEntryBenchmark(prepared, config, 'BTCUSDT', '1h', randomReference, {
        iterations: 200,
        seed: seed * 1000 + 1,
      });
      if (benchmark.pValue > 0.05 && benchmark.pValue < 0.95) {
        midRangeCount++;
      }
    }

    expect(midRangeCount).toBeGreaterThanOrEqual(4);
  });

  it('costs flow through unchanged: studyCostConfig lowers expectancy versus no cost model', () => {
    const candles = generateCandles(600);
    const prepared = prepareBacktest(candles, 'BTCUSDT', '1h');
    const baseline = runOptimizedBacktest(prepared, config, 'BTCUSDT', '1h');
    const profile = referenceProfile(baseline);

    // DEFAULT_BACKTEST_CONFIG.feePercent (0.1%) is a placeholder higher than
    // studyCostConfig's real Binance taker rate (0.05%), so comparing against
    // it would not isolate the cost model's effect. Use a genuinely free
    // baseline instead. A strategy's mulberry32 closure carries mutable RNG
    // state, so each run needs its own instance from the same seed to replay
    // identical entries.
    const noCostConfig: BacktestConfig = { ...config, feePercent: 0 };
    const withoutCosts = runOptimizedBacktest(
      prepared,
      noCostConfig,
      'BTCUSDT',
      '1h',
      undefined,
      createRandomEntryStrategy(profile, 777)
    );
    const withCosts = runOptimizedBacktest(
      prepared,
      { ...config, ...studyCostConfig('1h') },
      'BTCUSDT',
      '1h',
      undefined,
      createRandomEntryStrategy(profile, 777)
    );

    expect(withoutCosts.trades.length).toBeGreaterThan(0);
    expect(withCosts.metrics.expectancyPercent).toBeLessThan(withoutCosts.metrics.expectancyPercent);
  });
});
