// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { runBacktest } from './engine';
import { prepareBacktest, runOptimizedBacktest } from './optimized-engine';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import { getSession } from '@/lib/sessions';
import type { OHLCV } from '@/types/market';

function generateCandles(count: number, seed = 55, intervalMs = 3600000): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  // Start at a UTC midnight so session boundaries are predictable
  const base = 1700006400000;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 25) * 0.005;
    const noise = (nextRandom() - 0.5) * 0.8;
    price = price * (1 + drift + noise / 100);
    const high = price * (1 + nextRandom() * 0.006);
    const low = price * (1 - nextRandom() * 0.006);
    const open = price * (1 + (nextRandom() - 0.5) * 0.004);

    candles.push({
      timestamp: base + i * intervalMs,
      open,
      high,
      low,
      close: price,
      volume: 1000 + nextRandom() * 5000,
    });
  }

  return candles;
}

const activeConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  entryThreshold: 10,
  exitThreshold: -5,
  allowShorts: true,
  shortEntryThreshold: -10,
  shortExitThreshold: 5,
};

describe('session entry filter', () => {
  it('tags every trade with its entry session on intraday intervals', () => {
    const candles = generateCandles(400);
    const result = runBacktest(candles, activeConfig, 'BTCUSDT', '1h');

    expect(result.trades.length).toBeGreaterThan(0);
    for (const trade of result.trades) {
      expect(trade.entrySession).toBeDefined();
      expect(trade.entrySession).not.toBeNull();
    }
  });

  it('only enters during allowed sessions, but exits anywhere', () => {
    const candles = generateCandles(500);
    const config = { ...activeConfig, allowedSessions: ['asia' as const] };
    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    expect(result.trades.length).toBeGreaterThan(0);
    for (const trade of result.trades) {
      expect(trade.entrySession).toBe('asia');
    }
    // Exits are not session-gated: at least one exit lands outside asia
    // (positions ride across session boundaries)
    const exitsOutsideAsia = result.trades.filter(
      (t) => getSession(t.exitTime + 3600000) !== 'asia'
    );
    expect(exitsOutsideAsia.length).toBeGreaterThan(0);
  });

  it('produces fewer or equal trades than an unfiltered run', () => {
    const candles = generateCandles(500);
    const unfiltered = runBacktest(candles, activeConfig, 'BTCUSDT', '1h');
    const filtered = runBacktest(
      candles,
      { ...activeConfig, allowedSessions: ['ny_overlap' as const] },
      'BTCUSDT',
      '1h'
    );

    expect(filtered.trades.length).toBeLessThanOrEqual(unfiltered.trades.length);
  });

  it('is a no-op for 4h intervals and leaves sessions untagged', () => {
    const candles = generateCandles(400, 55, 4 * 3600000);
    const config = { ...activeConfig, allowedSessions: ['asia' as const] };
    const filtered = runBacktest(candles, config, 'BTCUSDT', '4h');
    const unfiltered = runBacktest(candles, activeConfig, 'BTCUSDT', '4h');

    expect(filtered.trades).toEqual(unfiltered.trades);
    for (const trade of filtered.trades) {
      expect(trade.entrySession).toBeNull();
    }
    expect(filtered.metrics.sessionBreakdown).toBeUndefined();
  });

  it('session breakdown sums match trade totals', () => {
    const candles = generateCandles(500);
    const result = runBacktest(candles, activeConfig, 'BTCUSDT', '1h');
    const breakdown = result.metrics.sessionBreakdown;

    expect(breakdown).toBeDefined();
    const totalFromBreakdown = breakdown!.reduce((sum, e) => sum + e.trades, 0);
    const winsFromBreakdown = breakdown!.reduce((sum, e) => sum + e.wins, 0);
    const pnlFromBreakdown = breakdown!.reduce((sum, e) => sum + e.totalPnl, 0);
    const tradePnl = result.trades.reduce((sum, t) => sum + t.pnl, 0);

    expect(totalFromBreakdown).toBe(result.trades.length);
    expect(winsFromBreakdown).toBe(result.metrics.winningTrades);
    expect(pnlFromBreakdown).toBeCloseTo(tradePnl, 6);
  });

  it('both engines agree under a session filter', () => {
    const candles = generateCandles(500);
    const config = { ...activeConfig, allowedSessions: ['london' as const, 'ny_overlap' as const] };

    const direct = runBacktest(candles, config, 'BTCUSDT', '1h');
    const prepared = prepareBacktest(candles, 'BTCUSDT', '1h');
    const optimized = runOptimizedBacktest(prepared, config, 'BTCUSDT', '1h');

    expect(optimized.trades).toEqual(direct.trades);
    expect(optimized.metrics).toEqual(direct.metrics);
  });
});
