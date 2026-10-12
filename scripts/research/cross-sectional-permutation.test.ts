import { describe, expect, it } from 'vitest';
import {
  createRng,
  extractSynchronousStates,
  generatePermutedUniverse,
} from './cross-sectional-permutation';
import { RV_SYMBOLS, type AlignedBar } from './cross-sectional-harness';
import type { FundingRow } from './dataset-format';

describe('createRng', () => {
  it('generates deterministic pseudorandom numbers for a given seed', () => {
    const rng1 = createRng(12345);
    const rng2 = createRng(12345);

    const seq1 = [rng1(), rng1(), rng1(), rng1()];
    const seq2 = [rng2(), rng2(), rng2(), rng2()];

    expect(seq1).toEqual(seq2);
    seq1.forEach((val) => {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    });
  });
});

describe('extractSynchronousStates and generatePermutedUniverse', () => {
  it('correctly extracts state ratios and reconstructs permuted synchronous bars', () => {
    const barsBySymbol = new Map<string, AlignedBar[]>();
    const fundingBySymbol = new Map<string, FundingRow[]>();

    const startT = Date.parse('2024-01-01T00:00:00.000Z');
    const EIGHT_H = 8 * 3600 * 1000;
    const nBars = 20;

    for (let sIdx = 0; sIdx < RV_SYMBOLS.length; sIdx++) {
      const sym = RV_SYMBOLS[sIdx];
      const bars: AlignedBar[] = [];
      let price = 100 * (sIdx + 1);

      for (let i = 0; i < nBars; i++) {
        price *= 1.01;
        bars.push({
          timestamp: startT + i * EIGHT_H,
          open: price * 0.999,
          high: price * 1.005,
          low: price * 0.995,
          close: price,
          volume: 1000,
          takerBuyVolume: 500,
        });
      }
      barsBySymbol.set(sym, bars);
      fundingBySymbol.set(sym, []);
    }

    const { timestamps, initialCloses, states } = extractSynchronousStates(
      barsBySymbol,
      fundingBySymbol
    );

    expect(timestamps).toHaveLength(nBars);
    expect(states).toHaveLength(nBars - 1);
    expect(initialCloses.size).toBe(RV_SYMBOLS.length);

    const rng = createRng(42);
    const permuted = generatePermutedUniverse(timestamps, initialCloses, states, 3, rng);

    expect(permuted.size).toBe(RV_SYMBOLS.length);

    for (const sym of RV_SYMBOLS) {
      const bars = permuted.get(sym);
      expect(bars).toBeDefined();
      expect(bars!).toHaveLength(nBars);

      // Check all prices are positive numbers
      for (const b of bars!) {
        expect(b.open).toBeGreaterThan(0);
        expect(b.high).toBeGreaterThanOrEqual(b.low);
        expect(b.low).toBeGreaterThan(0);
        expect(b.close).toBeGreaterThan(0);
      }
    }
  });
});
