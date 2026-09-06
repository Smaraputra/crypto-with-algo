// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { runBacktest } from './engine';
import { prepareBacktest, runOptimizedBacktest } from './optimized-engine';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { BacktestConfig } from './types';
import type { OHLCV } from '@/types/market';

// Deterministic random walk with trend, seeded LCG (same pattern as engine.test.ts)
function generateCandles(count: number, seed = 123): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    // Alternate trend regimes so both long and short entries occur
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
    });
  }

  return candles;
}

// Both engines must produce identical trades and metrics for the same inputs.
// This locks in parity for all future engine changes: any divergence in
// scoring, fills, sizing, or pnl accounting fails this test.
describe('engine parity', () => {
  const configs: Array<{ name: string; config: BacktestConfig }> = [
    {
      name: 'default config',
      config: { ...DEFAULT_BACKTEST_CONFIG },
    },
    {
      name: 'shorts and risk-based sizing (walk-forward config)',
      config: {
        ...DEFAULT_BACKTEST_CONFIG,
        allowShorts: true,
        positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
        stopLossPercent: 0.03,
        takeProfitPercent: 0.06,
      },
    },
  ];

  it.each(configs)('produces identical trades and metrics: $name', ({ config }) => {
    const candles = generateCandles(400);

    const direct = runBacktest(candles, config, 'BTCUSDT', '1h');
    const prepared = prepareBacktest(candles, 'BTCUSDT', '1h');
    const optimized = runOptimizedBacktest(prepared, config, 'BTCUSDT', '1h');

    expect(direct.trades.length).toBeGreaterThan(0);
    expect(optimized.trades).toEqual(direct.trades);
    expect(optimized.metrics).toEqual(direct.metrics);
    expect(optimized.equityCurve).toEqual(direct.equityCurve);
    expect(optimized.warmupBars).toBe(direct.warmupBars);
    expect(optimized.totalBars).toBe(direct.totalBars);
  });

  it('parity holds with a point-in-time snapshot series', async () => {
    const { buildSnapshotSeries } = await import('./snapshot-series');
    const candles = generateCandles(400);
    // Low thresholds guarantee trading activity under the shifted scores
    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      allowShorts: true,
      entryThreshold: 15,
      exitThreshold: -5,
      shortEntryThreshold: -15,
      shortExitThreshold: 5,
    };
    const snapshotDocs = candles
      .filter((_, i) => i % 4 === 0) // sparse series exercises carry-forward and gaps
      .map((c) => ({
        timestamp: c.timestamp,
        data: {
          fundingRate: { rate: -0.002, markPrice: c.close },
          longShortRatio: { ratio: 2.5, longAccount: 0.71, shortAccount: 0.29 },
          fearGreed: { index: 20, label: 'Extreme Fear' },
        },
      }));

    const series = buildSnapshotSeries(candles, snapshotDocs, '1h', { symbol: 'BTCUSDT' });
    const direct = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, series);
    const prepared = prepareBacktest(candles, 'BTCUSDT', '1h', undefined, snapshotDocs);
    const optimized = runOptimizedBacktest(prepared, config, 'BTCUSDT', '1h');

    expect(direct.trades.length).toBeGreaterThan(0);
    expect(optimized.trades).toEqual(direct.trades);
    expect(optimized.metrics).toEqual(direct.metrics);
    expect(optimized.snapshotCoverage).toEqual(direct.snapshotCoverage);
  });

  it('parity holds with higher-timeframe context', () => {
    const candles = generateCandles(400);
    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      allowShorts: true,
      entryThreshold: 15,
      exitThreshold: -5,
      shortEntryThreshold: -15,
      shortExitThreshold: 5,
    };
    // 4h HTF candles spanning the LTF range plus warmup margin
    const htfCandles = generateCandles(320, 999).map((c, i) => ({
      ...c,
      timestamp: candles[0].timestamp - 220 * 4 * 3600000 + i * 4 * 3600000,
    }));
    const htfInput = { candles: htfCandles, interval: '4h' };

    const direct = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, htfInput);
    const prepared = prepareBacktest(candles, 'BTCUSDT', '1h', undefined, undefined, htfInput);
    const optimized = runOptimizedBacktest(prepared, config, 'BTCUSDT', '1h');

    expect(direct.trades.length).toBeGreaterThan(0);
    expect(optimized.trades).toEqual(direct.trades);
    expect(optimized.metrics).toEqual(direct.metrics);
  });

  it('htf context changes scoring versus an htf-less run', () => {
    const candles = generateCandles(400);
    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      entryThreshold: 10,
      exitThreshold: -5,
    };
    const htfCandles = generateCandles(320, 999).map((c, i) => ({
      ...c,
      timestamp: candles[0].timestamp - 220 * 4 * 3600000 + i * 4 * 3600000,
    }));

    const withHtf = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, {
      candles: htfCandles,
      interval: '4h',
    });
    const withoutHtf = runBacktest(candles, config, 'BTCUSDT', '1h');

    expect(withoutHtf.trades.length).toBeGreaterThan(0);
    expect(withHtf.trades).not.toEqual(withoutHtf.trades);
  });
});
