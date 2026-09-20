// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createScoreThresholdStrategy } from './score-threshold';
import type { StrategyContext } from '../strategy';
import { runBacktest } from '../engine';
import { DEFAULT_BACKTEST_CONFIG } from '../types';
import type { BacktestConfig } from '../types';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeSignalScore } from '@/lib/signals/scorer';
import { interpretIndicatorsAtBar } from '@/lib/indicators/interpret-at-bar';
import type { OHLCV } from '@/types/market';
import type { SuperTrendPoint } from '@/lib/indicators/supertrend';
import type { OpenPosition } from '../trade-utils';

const BASE = 1700000000000;
const HOUR = 60 * 60 * 1000;

function makeCandle(close: number, bar = 0): OHLCV {
  return {
    timestamp: BASE + bar * HOUR,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  };
}

function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    bar: 0,
    candles: [makeCandle(100)],
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
    ...overrides,
  };
}

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    entryBar: 0,
    entryTime: BASE,
    entryPrice: 100,
    side: 'long',
    quantity: 1,
    entryScore: 30,
    entryTier: 'buy',
    stopPrice: 95,
    targetPrice: 110,
    timeStopBars: null,
    entrySlippageCost: 0,
    ...overrides,
  };
}

const config: BacktestConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  allowShorts: true,
  entryThreshold: 30,
  exitThreshold: -10,
  shortEntryThreshold: -30,
  shortExitThreshold: 10,
  stopLossPercent: 0.05,
  takeProfitPercent: 0.1,
};

// Deterministic random walk with trend, seeded LCG. Same generator as
// src/lib/backtest/engine-parity.test.ts so the parity check below runs
// against the exact series today's engines are locked to.
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

describe('createScoreThresholdStrategy', () => {
  const strategy = createScoreThresholdStrategy();

  it('has a name', () => {
    expect(strategy.name).toBeTruthy();
  });

  describe('decideEntry', () => {
    it('enters long at the entry threshold', () => {
      const ctx = makeContext({ score: 30 });
      expect(strategy.decideEntry(ctx, config)?.side).toBe('long');
    });

    it('enters long above the entry threshold', () => {
      const ctx = makeContext({ score: 45 });
      expect(strategy.decideEntry(ctx, config)?.side).toBe('long');
    });

    it('does not enter just below the entry threshold', () => {
      const ctx = makeContext({ score: 29.999999 });
      expect(strategy.decideEntry(ctx, config)).toBeNull();
    });

    it('returns null for a score between the exit and entry thresholds', () => {
      const ctx = makeContext({ score: 0 });
      expect(strategy.decideEntry(ctx, config)).toBeNull();
    });

    it('enters short at the short entry threshold when shorts are allowed', () => {
      const ctx = makeContext({ score: -30 });
      expect(strategy.decideEntry(ctx, config)?.side).toBe('short');
    });

    it('enters short below the short entry threshold when shorts are allowed', () => {
      const ctx = makeContext({ score: -45 });
      expect(strategy.decideEntry(ctx, config)?.side).toBe('short');
    });

    it('does not enter short just above the short entry threshold', () => {
      const ctx = makeContext({ score: -29.999999 });
      expect(strategy.decideEntry(ctx, config)).toBeNull();
    });

    it('never enters short when shorts are disallowed, however low the score', () => {
      const noShorts: BacktestConfig = { ...config, allowShorts: false };
      const ctx = makeContext({ score: -90 });
      expect(strategy.decideEntry(ctx, noShorts)).toBeNull();
    });

    it('uses a market order', () => {
      const ctx = makeContext({ score: 30 });
      expect(strategy.decideEntry(ctx, config)?.orderType).toBe('market');
    });

    it('sets timeStopBars to null', () => {
      const ctx = makeContext({ score: 30 });
      expect(strategy.decideEntry(ctx, config)?.timeStopBars).toBeNull();
    });

    it('computes the long stop and target from the bar close', () => {
      const ctx = makeContext({ score: 30, bar: 0, candles: [makeCandle(200)] });
      const decision = strategy.decideEntry(ctx, config);
      expect(decision).toEqual({
        side: 'long',
        orderType: 'market',
        stopPrice: 200 * (1 - 0.05),
        targetPrice: 200 * (1 + 0.1),
        timeStopBars: null,
      });
    });

    it('computes the short stop and target from the bar close', () => {
      const ctx = makeContext({ score: -30, bar: 0, candles: [makeCandle(200)] });
      const decision = strategy.decideEntry(ctx, config);
      expect(decision).toEqual({
        side: 'short',
        orderType: 'market',
        stopPrice: 200 * (1 + 0.05),
        targetPrice: 200 * (1 - 0.1),
        timeStopBars: null,
      });
    });

    it('reads the close of the bar at ctx.bar, not the last candle in the array', () => {
      const candles = [makeCandle(100, 0), makeCandle(150, 1), makeCandle(300, 2)];
      const ctx = makeContext({ score: 30, bar: 1, candles });
      const decision = strategy.decideEntry(ctx, config);
      expect(decision?.stopPrice).toBeCloseTo(150 * (1 - 0.05));
      expect(decision?.targetPrice).toBeCloseTo(150 * (1 + 0.1));
    });
  });

  describe('decideExit', () => {
    it('exits a long position at the exit threshold', () => {
      const ctx = makeContext({ score: -10, position: makePosition({ side: 'long' }) });
      expect(strategy.decideExit(ctx, config)).toBe(true);
    });

    it('exits a long position below the exit threshold', () => {
      const ctx = makeContext({ score: -50, position: makePosition({ side: 'long' }) });
      expect(strategy.decideExit(ctx, config)).toBe(true);
    });

    it('does not exit a long position above the exit threshold', () => {
      const ctx = makeContext({ score: -9.999999, position: makePosition({ side: 'long' }) });
      expect(strategy.decideExit(ctx, config)).toBe(false);
    });

    it('exits a short position at the short exit threshold', () => {
      const ctx = makeContext({
        score: 10,
        position: makePosition({ side: 'short', entryScore: -30, entryTier: 'sell' }),
      });
      expect(strategy.decideExit(ctx, config)).toBe(true);
    });

    it('exits a short position above the short exit threshold', () => {
      const ctx = makeContext({
        score: 50,
        position: makePosition({ side: 'short', entryScore: -30, entryTier: 'sell' }),
      });
      expect(strategy.decideExit(ctx, config)).toBe(true);
    });

    it('does not exit a short position below the short exit threshold', () => {
      const ctx = makeContext({
        score: 9.999999,
        position: makePosition({ side: 'short', entryScore: -30, entryTier: 'sell' }),
      });
      expect(strategy.decideExit(ctx, config)).toBe(false);
    });

    it('returns false when there is no position', () => {
      const ctx = makeContext({ score: -100, position: null });
      expect(strategy.decideExit(ctx, config)).toBe(false);
    });
  });

  describe('engine parity', () => {
    it("the strategy's first-trade decision matches what engine.ts produces today", () => {
      const candles = generateCandles(600);
      const parityConfig: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, allowShorts: true };

      const result = runBacktest(candles, parityConfig, 'BTCUSDT', '1h');
      expect(result.trades.length).toBeGreaterThan(0);
      const trade = result.trades[0];
      const entryBar = trade.entryBar;

      // Rebuild the exact score the engine computed at entryBar: same raw
      // indicators, same SuperTrend alignment, same interpreted suite, same
      // computeSignalScore call the engines make.
      const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
      const superTrend = computeSuperTrend(candles);
      const stOffset = candles.length - superTrend.values.length;
      const stIdx = entryBar - stOffset;
      const superTrendAtBar: SuperTrendPoint | undefined =
        stIdx >= 0 && stIdx < superTrend.values.length ? superTrend.values[stIdx] : undefined;
      const suite = interpretIndicatorsAtBar(raw, entryBar, candles);
      const composite = computeSignalScore(
        suite,
        null,
        null,
        parityConfig.weights,
        superTrendAtBar ? { values: superTrend.values, current: superTrendAtBar } : null,
        null
      );

      const ctx = makeContext({
        bar: entryBar,
        candles,
        interval: '1h',
        suite,
        score: composite.score,
        tier: composite.tier,
        superTrend: superTrendAtBar ? { values: superTrend.values, current: superTrendAtBar } : null,
      });

      const decision = strategy.decideEntry(ctx, parityConfig);
      expect(decision).not.toBeNull();
      expect(decision?.side).toBe(trade.side);

      const expectedStop =
        trade.side === 'long'
          ? trade.entryPrice * (1 - parityConfig.stopLossPercent)
          : trade.entryPrice * (1 + parityConfig.stopLossPercent);
      const expectedTarget =
        trade.side === 'long'
          ? trade.entryPrice * (1 + parityConfig.takeProfitPercent)
          : trade.entryPrice * (1 - parityConfig.takeProfitPercent);

      expect(Math.abs(decision!.stopPrice - expectedStop)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(decision!.targetPrice! - expectedTarget)).toBeLessThanOrEqual(1e-12);
    });
  });
});
