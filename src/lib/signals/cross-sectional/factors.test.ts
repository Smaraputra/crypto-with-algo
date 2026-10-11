import { describe, expect, it } from 'vitest';
import {
  computeCrossSectionalRanks,
  standardizeCrossSection,
  type SymbolBarSnapshot,
} from './factors';

describe('standardizeCrossSection', () => {
  it('converts values into zero-mean unit-variance z-scores', () => {
    const raw = [10, 20, 30, 40, 50];
    const z = standardizeCrossSection(raw);
    const mean = z.reduce((a, b) => a + b, 0) / z.length;
    const variance = z.reduce((a, b) => a + (b - mean) ** 2, 0) / (z.length - 1);

    expect(mean).toBeCloseTo(0, 10);
    expect(variance).toBeCloseTo(1, 10);
  });

  it('handles identical values without NaN', () => {
    const raw = [5, 5, 5, 5];
    const z = standardizeCrossSection(raw);
    expect(z).toEqual([0, 0, 0, 0]);
  });
});

describe('computeCrossSectionalRanks', () => {
  const baseSnapshots: SymbolBarSnapshot[] = [
    { symbol: 'BTCUSDT', close: 60000, return7d: 0.05, return14d: 0.1, fundingRate: 0.0001, btcReturn14d: 0.1 },
    { symbol: 'ETHUSDT', close: 3000, return7d: 0.08, return14d: 0.15, fundingRate: 0.0001, btcReturn14d: 0.1 },
    { symbol: 'SOLUSDT', close: 150, return7d: 0.12, return14d: 0.25, fundingRate: 0.0002, btcReturn14d: 0.1 },
    { symbol: 'DOGEUSDT', close: 0.1, return7d: -0.05, return14d: -0.1, fundingRate: 0.0001, btcReturn14d: 0.1 },
    { symbol: 'ADAUSDT', close: 0.4, return7d: -0.08, return14d: -0.15, fundingRate: -0.0002, btcReturn14d: 0.1 },
  ];

  it('throws error when fewer than 4 symbols are provided', () => {
    expect(() => computeCrossSectionalRanks(baseSnapshots.slice(0, 3))).toThrow(
      /Insufficient symbols for cross-sectional ranking/
    );
  });

  it('ranks top performers at rank 1 and laggards at rank N', () => {
    const ranks = computeCrossSectionalRanks(baseSnapshots);
    expect(ranks).toHaveLength(5);

    // SOL had highest return (0.25)
    expect(ranks[0].symbol).toBe('SOLUSDT');
    expect(ranks[0].rank).toBe(1);

    // ADA had lowest return (-0.15) but positive carry (-0.0002 funding)
    const last = ranks[ranks.length - 1];
    expect(last.rank).toBe(5);
  });

  it('rewards favorable negative funding carry for long candidates', () => {
    // Two symbols with identical return, but symbol B has negative funding rate (shorts pay longs)
    const snapshots: SymbolBarSnapshot[] = [
      { symbol: 'SYM_A', close: 10, return7d: 0, return14d: 0.05, fundingRate: 0.0008, btcReturn14d: 0 },
      { symbol: 'SYM_B', close: 10, return7d: 0, return14d: 0.05, fundingRate: -0.0005, btcReturn14d: 0 },
      { symbol: 'SYM_C', close: 10, return7d: 0, return14d: 0, fundingRate: 0, btcReturn14d: 0 },
      { symbol: 'SYM_D', close: 10, return7d: 0, return14d: -0.05, fundingRate: 0, btcReturn14d: 0 },
    ];

    const ranks = computeCrossSectionalRanks(snapshots);
    const symA = ranks.find((r) => r.symbol === 'SYM_A')!;
    const symB = ranks.find((r) => r.symbol === 'SYM_B')!;

    expect(symB.compositeZ).toBeGreaterThan(symA.compositeZ);
    expect(symB.rank).toBeLessThan(symA.rank);
  });

  it('breaks ties deterministically by symbol', () => {
    const snapshots: SymbolBarSnapshot[] = [
      { symbol: 'ZZZ', close: 10, return7d: 0, return14d: 0, fundingRate: 0, btcReturn14d: 0 },
      { symbol: 'AAA', close: 10, return7d: 0, return14d: 0, fundingRate: 0, btcReturn14d: 0 },
      { symbol: 'MMM', close: 10, return7d: 0, return14d: 0, fundingRate: 0, btcReturn14d: 0 },
      { symbol: 'BBB', close: 10, return7d: 0, return14d: 0, fundingRate: 0, btcReturn14d: 0 },
    ];

    const ranks = computeCrossSectionalRanks(snapshots);
    expect(ranks.map((r) => r.symbol)).toEqual(['AAA', 'BBB', 'MMM', 'ZZZ']);
    expect(ranks.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('differentiates idiosyncratic momentum from raw momentum when betas vary', () => {
    const snapshots: SymbolBarSnapshot[] = [
      { symbol: 'BTCUSDT', close: 60000, return7d: 0.1, return14d: 0.1, fundingRate: 0, btcReturn14d: 0.1, betaToBtc: 1.0 },
      { symbol: 'ETHUSDT', close: 3000, return7d: 0.12, return14d: 0.12, fundingRate: 0, btcReturn14d: 0.1, betaToBtc: 1.2 },
      { symbol: 'SOLUSDT', close: 150, return7d: 0.15, return14d: 0.15, fundingRate: 0, btcReturn14d: 0.1, betaToBtc: 2.0 },
      { symbol: 'DOGEUSDT', close: 0.1, return7d: 0.08, return14d: 0.08, fundingRate: 0, btcReturn14d: 0.1, betaToBtc: 0.5 },
    ];

    const ranks = computeCrossSectionalRanks(snapshots);
    const zMoms = ranks.map((r) => r.zMom);
    const zIdios = ranks.map((r) => r.zIdio);

    // With heterogeneous betas, zIdio must not equal zMom
    expect(zMoms).not.toEqual(zIdios);
  });
});
