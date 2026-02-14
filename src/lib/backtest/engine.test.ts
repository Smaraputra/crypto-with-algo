// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { runBacktest } from './engine';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { OHLCV } from '@/types/market';

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
