// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { runBacktest } from './engine';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { OHLCV } from '@/types/market';
import type { Strategy } from './strategy';

// Generate synthetic candle data with a clear trend
function generateTrendingCandles(count: number, direction: 'up' | 'down' = 'up'): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  const drift = direction === 'up' ? 0.002 : -0.002;
  let rng = 123;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
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
    });
  }

  return candles;
}

describe('runBacktest', () => {
  it('produces a valid BacktestResult', () => {
    const candles = generateTrendingCandles(300);
    const config = { ...DEFAULT_BACKTEST_CONFIG };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    expect(result.symbol).toBe('BTCUSDT');
    expect(result.interval).toBe('1h');
    expect(result.totalBars).toBeGreaterThan(0);
    expect(result.warmupBars).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBe(result.totalBars);
    expect(result.metrics).toBeDefined();
    expect(result.config).toEqual(config);
  });

  it('equity curve starts at startEquity', () => {
    const candles = generateTrendingCandles(300);
    const config = { ...DEFAULT_BACKTEST_CONFIG, startEquity: 50000 };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    expect(result.equityCurve[0].equity).toBe(50000);
  });

  it('records trades with valid fields', () => {
    const candles = generateTrendingCandles(400, 'up');
    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      entryThreshold: 10, // lower threshold to get trades
    };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    if (result.trades.length > 0) {
      const trade = result.trades[0];
      expect(trade.entryPrice).toBeGreaterThan(0);
      expect(trade.exitPrice).toBeGreaterThan(0);
      expect(trade.quantity).toBeGreaterThan(0);
      expect(trade.fees).toBeGreaterThanOrEqual(0);
      expect(trade.side).toBe('long');
      expect(['signal', 'stop_loss', 'take_profit', 'end_of_data']).toContain(trade.exitReason);
    }
  });

  it('does not produce short trades when allowShorts is false', () => {
    const candles = generateTrendingCandles(300, 'down');
    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      allowShorts: false,
      entryThreshold: 10,
    };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    for (const trade of result.trades) {
      expect(trade.side).toBe('long');
    }
  });

  it('calls onProgress callback', () => {
    const candles = generateTrendingCandles(250);
    const config = { ...DEFAULT_BACKTEST_CONFIG };
    const onProgress = vi.fn();

    runBacktest(candles, config, 'BTCUSDT', '1h', onProgress);

    expect(onProgress).toHaveBeenCalled();
    // Last call should be 100%
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
    expect(lastCall[0]).toBe(100);
  });

  it('handles degenerate case with minimal candles', () => {
    // computeMinCandles with DEFAULT_CONFIG requires 210 (ichimoku span 52 + displacement 26 + SMA 200 overlap)
    const candles = generateTrendingCandles(215);
    const config = { ...DEFAULT_BACKTEST_CONFIG };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    expect(result.totalBars).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBe(result.totalBars);
  });

  it('computes metrics correctly', () => {
    const candles = generateTrendingCandles(300);
    const config = { ...DEFAULT_BACKTEST_CONFIG };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    expect(result.metrics.totalTrades).toBeGreaterThanOrEqual(0);
    expect(result.metrics.winRate).toBeGreaterThanOrEqual(0);
    expect(result.metrics.winRate).toBeLessThanOrEqual(1);
    expect(result.metrics.maxDrawdownPercent).toBeGreaterThanOrEqual(0);
  });

  it('fees reduce equity', () => {
    const candles = generateTrendingCandles(300);
    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      entryThreshold: 10,
      feePercent: 0.01, // high fee to make effect visible
    };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    expect(result.metrics.totalFees).toBeGreaterThanOrEqual(0);
    if (result.trades.length > 0) {
      for (const trade of result.trades) {
        expect(trade.fees).toBeGreaterThan(0);
      }
    }
  });
});

describe('custom Strategy: limit orders, market slippage, and time stops', () => {
  // Places a limit order every bar it is flat, always destined to miss
  // (limitPrice far below any realistic low), so it is cancelled every
  // timeoutBars and no position ever opens.
  function createUnfillableLimitStrategy(timeoutBars: number): Strategy {
    return {
      name: 'test-unfillable-limit',
      decideEntry(ctx) {
        const close = ctx.candles[ctx.bar].close;
        return {
          side: 'long',
          orderType: 'limit',
          limitPrice: close * 0.01,
          timeoutBars,
          stopPrice: close * 0.5,
          targetPrice: null,
          timeStopBars: null,
        };
      },
      decideExit() {
        return false;
      },
    };
  }

  // Places exactly one decision at `bar` and never again; never exits by
  // signal. Used to pin a single, deterministic trade for assertions.
  function createOneShotStrategy(
    bar: number,
    buildDecision: (close: number) => ReturnType<Strategy['decideEntry']>
  ): Strategy {
    let placed = false;
    return {
      name: 'test-one-shot',
      decideEntry(ctx) {
        if (placed || ctx.bar !== bar) return null;
        placed = true;
        return buildDecision(ctx.candles[ctx.bar].close);
      },
      decideExit() {
        return false;
      },
    };
  }

  it('a limit order that never fills is cancelled after timeoutBars and opens no position', () => {
    const candles = generateTrendingCandles(300);
    const config = { ...DEFAULT_BACKTEST_CONFIG };
    const strategy = createUnfillableLimitStrategy(3);

    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);

    expect(result.trades).toHaveLength(0);
  });

  it('a limit that fills opens at the limit price with entryFillKind maker and no entry slippage', () => {
    const candles = generateTrendingCandles(300);
    const entryBar = candles.length - 5;
    const fillBar = entryBar + 1;
    const close = candles[entryBar].close;
    const limitPrice = close * 0.999;

    // Strictly breach the limit without a gap: open stays above limitPrice,
    // low dips below it, so the fill price is exactly limitPrice.
    candles[fillBar] = {
      ...candles[fillBar],
      open: limitPrice * 1.002,
      high: limitPrice * 1.003,
      low: limitPrice * 0.998,
      close: limitPrice * 1.0005,
    };

    const strategy = createOneShotStrategy(entryBar, () => ({
      side: 'long',
      orderType: 'limit',
      limitPrice,
      timeoutBars: 5,
      stopPrice: close * 0.5,
      targetPrice: null,
      timeStopBars: null,
    }));
    // Slippage is configured but must not apply to a maker (limit) fill.
    const config = { ...DEFAULT_BACKTEST_CONFIG, slippageBps: 10 };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.entryPrice).toBeCloseTo(limitPrice);
    expect(trade.entryFillKind).toBe('maker');
    expect(trade.entryBar).toBe(fillBar);
  });

  it('a limit that gaps through fills at the open, not the limit price', () => {
    const candles = generateTrendingCandles(300);
    const entryBar = candles.length - 5;
    const fillBar = entryBar + 1;
    const close = candles[entryBar].close;
    const limitPrice = close * 0.999;
    const gapOpen = limitPrice * 0.99; // open already clears the limit

    candles[fillBar] = {
      ...candles[fillBar],
      open: gapOpen,
      high: gapOpen * 1.001,
      low: gapOpen * 0.998,
      close: gapOpen * 1.0002,
    };

    const strategy = createOneShotStrategy(entryBar, () => ({
      side: 'long',
      orderType: 'limit',
      limitPrice,
      timeoutBars: 5,
      stopPrice: close * 0.5,
      targetPrice: null,
      timeStopBars: null,
    }));
    const config = { ...DEFAULT_BACKTEST_CONFIG };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBeCloseTo(gapOpen);
    expect(result.trades[0].entryFillKind).toBe('maker');
  });

  it('a market entry with slippageBps 10 opens 0.1% away from the close against the trader', () => {
    const candles = generateTrendingCandles(300);
    const entryBar = candles.length - 3;
    const close = candles[entryBar].close;
    const strategy = createOneShotStrategy(entryBar, (c) => ({
      side: 'long',
      orderType: 'market',
      stopPrice: c * 0.5,
      targetPrice: null,
      timeStopBars: null,
    }));
    const config = { ...DEFAULT_BACKTEST_CONFIG, slippageBps: 10 };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.entryPrice).toBeCloseTo(close * 1.001, 6); // a buy fills higher, against the trader
    expect(trade.entryFillKind).toBe('taker');
  });

  it('a time stop closes at the right bar with reason time_stop', () => {
    const candles = generateTrendingCandles(300);
    const entryBar = 220;
    const timeStopBars = 4;
    const strategy = createOneShotStrategy(entryBar, (close) => ({
      side: 'long',
      orderType: 'market',
      stopPrice: close * 0.5, // far away: must not trigger before the time stop
      targetPrice: close * 3, // far away: must not trigger before the time stop
      timeStopBars,
    }));
    const config = { ...DEFAULT_BACKTEST_CONFIG };

    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('time_stop');
    expect(trade.entryBar).toBe(entryBar);
    expect(trade.exitBar).toBe(entryBar + timeStopBars);
  });

  it('stops and targets come from the position absolute prices, not config percentages', () => {
    const candles = generateTrendingCandles(300);
    const entryBar = 220;
    const strategy = createOneShotStrategy(entryBar, (close) => ({
      side: 'long',
      orderType: 'market',
      stopPrice: close * 0.8, // 20% away; config.stopLossPercent stays the 5% default
      targetPrice: close * 1.5, // 50% away; config.takeProfitPercent stays the 10% default
      timeStopBars: null,
    }));
    const config = { ...DEFAULT_BACKTEST_CONFIG }; // default 5%/10%, unused by this strategy

    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.riskPercent).toBeCloseTo(20);
    expect(trade.riskPercent).not.toBeCloseTo(config.stopLossPercent * 100);
  });

  it('the default strategy parameter reproduces runBacktest called with no strategy', () => {
    const candles = generateTrendingCandles(300);
    const config = { ...DEFAULT_BACKTEST_CONFIG, entryThreshold: 10 };

    const withoutStrategy = runBacktest(candles, config, 'BTCUSDT', '1h');
    const withDefaultStrategy = runBacktest(
      candles,
      config,
      'BTCUSDT',
      '1h',
      undefined,
      undefined,
      undefined,
      undefined
    );

    expect(withDefaultStrategy.trades).toEqual(withoutStrategy.trades);
    expect(withDefaultStrategy.metrics).toEqual(withoutStrategy.metrics);
  });
});

describe('snapshot integration', () => {
  function makeSnapshots(candles: OHLCV[]) {
    // Extreme contrarian-bullish readings so scoring visibly shifts
    return candles.map((c) => ({
      timestamp: c.timestamp,
      data: {
        fundingRate: { rate: -0.005, markPrice: c.close },
        fearGreed: { index: 5, label: 'Extreme Fear' },
      },
    }));
  }

  it('reports snapshot coverage when a series is provided', async () => {
    const { buildSnapshotSeries } = await import('./snapshot-series');
    const candles = generateTrendingCandles(300);
    const series = buildSnapshotSeries(candles, makeSnapshots(candles), '1h', { symbol: 'BTCUSDT' });

    const result = runBacktest(candles, { ...DEFAULT_BACKTEST_CONFIG }, 'BTCUSDT', '1h', undefined, series);

    expect(result.snapshotCoverage).toBeDefined();
    expect(result.snapshotCoverage!.scoredBars).toBe(result.totalBars);
    expect(result.snapshotCoverage!.barsWithFutures).toBe(result.totalBars);
    expect(result.snapshotCoverage!.barsWithSentiment).toBe(result.totalBars);
    expect(result.snapshotCoverage!.futuresPercent).toBe(100);
  });

  it('omits snapshot coverage when no series is provided', () => {
    const candles = generateTrendingCandles(300);
    const result = runBacktest(candles, { ...DEFAULT_BACKTEST_CONFIG }, 'BTCUSDT', '1h');

    expect(result.snapshotCoverage).toBeUndefined();
  });

  it('snapshot data changes scoring and trades', async () => {
    const { buildSnapshotSeries } = await import('./snapshot-series');
    const candles = generateTrendingCandles(400, 'up');
    // Low thresholds guarantee trading activity in the base run
    const config = { ...DEFAULT_BACKTEST_CONFIG, entryThreshold: 10, exitThreshold: -5 };
    const series = buildSnapshotSeries(candles, makeSnapshots(candles), '1h', { symbol: 'BTCUSDT' });

    const withSnapshots = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, series);
    const withoutSnapshots = runBacktest(candles, config, 'BTCUSDT', '1h');

    expect(withoutSnapshots.trades.length).toBeGreaterThan(0);
    // Strongly bullish contrarian inputs must shift entries/exits somewhere
    expect(withSnapshots.trades).not.toEqual(withoutSnapshots.trades);
  });
});
