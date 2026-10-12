import { describe, it, expect } from 'vitest';
import type { OHLCV } from '@/types/market';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import {
  computeCrossSectionalSignalFromCandles,
  RV_LOOKBACK_BARS,
  BAR_MS_8H,
} from './generator';

function generateMockCandles(
  basePrice: number,
  driftPerBar: number,
  count = RV_LOOKBACK_BARS + 5
): OHLCV[] {
  const candles: OHLCV[] = [];
  const baseTime = 1700000000000;
  let price = basePrice;

  for (let i = 0; i < count; i++) {
    price = price * (1 + driftPerBar);
    candles.push({
      timestamp: baseTime + i * BAR_MS_8H,
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1000,
      takerBuyVolume: 550, // 55% taker buy flow
    });
  }

  return candles;
}

describe('computeCrossSectionalSignalFromCandles', () => {
  it('throws error when BTC candles are insufficient', () => {
    const candlesMap = new Map<string, OHLCV[]>();
    candlesMap.set('BTCUSDT', generateMockCandles(50000, 0.001, 10)); // Only 10 bars

    const fundingMap = new Map<string, number>();

    expect(() =>
      computeCrossSectionalSignalFromCandles(candlesMap, fundingMap)
    ).toThrow(/Insufficient BTC candles/);
  });

  it('throws error when fewer than 5 symbols are aligned', () => {
    const candlesMap = new Map<string, OHLCV[]>();
    candlesMap.set('BTCUSDT', generateMockCandles(50000, 0.001, 50));
    candlesMap.set('ETHUSDT', generateMockCandles(3000, 0.001, 50));
    candlesMap.set('SOLUSDT', generateMockCandles(100, 0.001, 50));

    const fundingMap = new Map<string, number>();

    expect(() =>
      computeCrossSectionalSignalFromCandles(candlesMap, fundingMap)
    ).toThrow(/Insufficient aligned symbols/);
  });

  it('computes factors, ranks, and target allocations across 10 universe symbols', () => {
    const candlesMap = new Map<string, OHLCV[]>();
    const fundingMap = new Map<string, number>();

    // Give each symbol a distinct upward or downward drift
    SIGNAL_SYMBOLS.forEach((sym, idx) => {
      const drift = 0.005 * (idx - 4.5); // Spread drifts from negative to positive
      candlesMap.set(sym, generateMockCandles(100 + idx * 20, drift, 50));
      // Set distinct funding rates
      fundingMap.set(sym, 0.0001 * (idx - 5));
    });

    const result = computeCrossSectionalSignalFromCandles(candlesMap, fundingMap);

    expect(result.cadence).toBe('8h');
    expect(result.universe.length).toBe(SIGNAL_SYMBOLS.length);
    expect(result.snapshots.length).toBe(SIGNAL_SYMBOLS.length);
    expect(result.ranks.length).toBe(SIGNAL_SYMBOLS.length);
    expect(result.targets.length).toBe(SIGNAL_SYMBOLS.length);

    // Verify ranks from 1 to 10
    const rankValues = result.ranks.map((r) => r.rank).sort((a, b) => a - b);
    expect(rankValues).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Check portfolio target legs: 2 longs and 2 shorts
    const longs = result.targets.filter((t) => t.side === 'long');
    const shorts = result.targets.filter((t) => t.side === 'short');
    const flats = result.targets.filter((t) => t.side === 'flat');

    expect(longs.length).toBe(2);
    expect(shorts.length).toBe(2);
    expect(flats.length).toBe(SIGNAL_SYMBOLS.length - 4);

    // Beta neutrality: net beta exposure should be close to 0
    expect(Math.abs(result.netBetaExposure)).toBeLessThan(0.05);
    // Gross exposure should be 1.0 (long weights sum to ~0.5, short weights sum to ~-0.5)
    expect(result.grossExposure).toBeCloseTo(1.0, 2);
  });

  it('preserves existing holdings within the rank hysteresis buffer (Buffer = 2)', () => {
    const candlesMap = new Map<string, OHLCV[]>();
    const fundingMap = new Map<string, number>();

    SIGNAL_SYMBOLS.forEach((sym, idx) => {
      const drift = 0.003 * (idx - 4.5);
      candlesMap.set(sym, generateMockCandles(100, drift, 50));
      fundingMap.set(sym, 0.0001);
    });

    // Run 1: initial allocation
    const initialResult = computeCrossSectionalSignalFromCandles(candlesMap, fundingMap);
    const initialLongs = initialResult.targets.filter((t) => t.side === 'long').map((t) => t.symbol);
    const initialShorts = initialResult.targets.filter((t) => t.side === 'short').map((t) => t.symbol);

    const currentPositions = new Map<string, number>();
    initialLongs.forEach((sym) => currentPositions.set(sym, 0.25));
    initialShorts.forEach((sym) => currentPositions.set(sym, -0.25));

    // Run 2: pass currentPositions back in
    const secondResult = computeCrossSectionalSignalFromCandles(
      candlesMap,
      fundingMap,
      currentPositions
    );

    // With identical data, turnover should be 0 because buffer keeps existing holdings
    expect(secondResult.turnover).toBeCloseTo(0, 4);
    expect(secondResult.rebalanced).toBe(false);

    const secondLongs = secondResult.targets.filter((t) => t.side === 'long').map((t) => t.symbol);
    const secondShorts = secondResult.targets.filter((t) => t.side === 'short').map((t) => t.symbol);

    expect(secondLongs.sort()).toEqual(initialLongs.sort());
    expect(secondShorts.sort()).toEqual(initialShorts.sort());
  });
});
