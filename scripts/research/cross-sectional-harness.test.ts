import { describe, expect, it } from 'vitest';
import type { CandleRow, FundingRow } from './dataset-format';
import {
  aggregateTo8h,
  runSimulation,
  RV_SYMBOLS,
  type AlignedBar,
} from './cross-sectional-harness';

describe('aggregateTo8h', () => {
  it('aggregates two 4h candles into one 8h bar aligned to UTC 8h boundaries', () => {
    // 00:00 UTC and 04:00 UTC
    const t0 = Date.parse('2024-01-01T00:00:00.000Z');
    const t4 = Date.parse('2024-01-01T04:00:00.000Z');
    const t8 = Date.parse('2024-01-01T08:00:00.000Z');

    const candles4h: CandleRow[] = [
      { t: t0, o: 100, h: 105, l: 98, c: 102, v: 50, tbv: null },
      { t: t4, o: 102, h: 110, l: 101, c: 108, v: 70, tbv: null },
      { t: t8, o: 108, h: 112, l: 104, c: 105, v: 40, tbv: null },
    ];

    const bars = aggregateTo8h(candles4h);
    expect(bars).toHaveLength(2);

    // First 8h bar: 00:00 to 08:00
    expect(bars[0].timestamp).toBe(t0);
    expect(bars[0].open).toBe(100);
    expect(bars[0].high).toBe(110);
    expect(bars[0].low).toBe(98);
    expect(bars[0].close).toBe(108);
    expect(bars[0].volume).toBe(120);

    // Second 8h bar: 08:00
    expect(bars[1].timestamp).toBe(t8);
    expect(bars[1].open).toBe(108);
    expect(bars[1].high).toBe(112);
    expect(bars[1].low).toBe(104);
    expect(bars[1].close).toBe(105);
    expect(bars[1].volume).toBe(40);
  });
});

describe('runSimulation', () => {
  it('executes simulation over synthetic data and returns valid stats', () => {
    const barsBySymbol = new Map<string, AlignedBar[]>();
    const fundingBySymbol = new Map<string, FundingRow[]>();

    const startT = Date.parse('2024-01-01T00:00:00.000Z');
    const EIGHT_H = 8 * 3600 * 1000;
    const nBars = 100;

    // Create synthetic price series for all 10 symbols
    for (let sIdx = 0; sIdx < RV_SYMBOLS.length; sIdx++) {
      const sym = RV_SYMBOLS[sIdx];
      const bars: AlignedBar[] = [];
      let price = 100 * (sIdx + 1);

      for (let i = 0; i < nBars; i++) {
        const drift = sIdx === 0 ? 0.005 : -0.002; // BTC drifts up, others drift slightly
        price *= 1 + drift;
        bars.push({
          timestamp: startT + i * EIGHT_H,
          open: price,
          high: price * 1.01,
          low: price * 0.99,
          close: price,
          volume: 1000,
        });
      }
      barsBySymbol.set(sym, bars);

      // Simple funding series
      fundingBySymbol.set(sym, [
        { t: startT, rate: 0.0001, intervalHours: 8 },
        { t: startT + 50 * EIGHT_H, rate: -0.0001, intervalHours: 8 },
      ]);
    }

    const result = runSimulation(barsBySymbol, fundingBySymbol, '8h', {
      legs: 2,
      buffer: 1,
      weights: { mom: 0.4, idio: 0.3, carry: 0.3 },
      lookbackBars: 10,
    });

    expect(result.inSample.bars).toBeGreaterThan(0);
    expect(Number.isFinite(result.inSample.totalGrossReturnPct)).toBe(true);
    expect(Number.isFinite(result.inSample.annualizedGrossSharpe)).toBe(true);
    expect(Number.isFinite(result.inSample.totalNetMakerReturnPct)).toBe(true);
    expect(Number.isFinite(result.inSample.totalNetTakerReturnPct)).toBe(true);
  });
});
