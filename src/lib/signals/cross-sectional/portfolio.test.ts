import { describe, expect, it } from 'vitest';
import type { FactorScores } from './factors';
import { constructBufferedPortfolio } from './portfolio';

describe('constructBufferedPortfolio', () => {
  const dummyRanks = (symbols: string[]): FactorScores[] =>
    symbols.map((sym, idx) => ({
      symbol: sym,
      zMom: 0,
      zIdio: 0,
      zCarry: 0,
      zFlow: 0,
      zNews: 0,
      zVol: 0,
      compositeZ: 10 - idx,
      rank: idx + 1,
    }));

  const universe = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];

  it('allocates top 2 long and bottom 2 short from cold start', () => {
    const ranks = dummyRanks(universe);
    const result = constructBufferedPortfolio(new Map(), ranks, { legs: 2, buffer: 1 });

    expect(result.positions.get('S1')).toBe(0.25);
    expect(result.positions.get('S2')).toBe(0.25);
    expect(result.positions.get('S9')).toBe(-0.25);
    expect(result.positions.get('S10')).toBe(-0.25);
    expect(result.netExposure).toBeCloseTo(0, 10);
    expect(result.grossExposure).toBeCloseTo(1.0, 10);
    expect(result.turnover).toBeCloseTo(1.0, 10);
    expect(result.rebalanced).toBe(true);
  });

  it('suppresses turnover when rankings fluctuate within the hysteresis buffer', () => {
    // Current holdings: Long S1, S2 (+0.25 each), Short S9, S10 (-0.25 each)
    const currentPositions = new Map<string, number>([
      ['S1', 0.25],
      ['S2', 0.25],
      ['S9', -0.25],
      ['S10', -0.25],
    ]);

    // New rankings: S3 moves to rank 1, S1 to rank 2, S2 to rank 3.
    // Buffer = 1, legs = 2 -> exit threshold is rank > 3.
    // Since S1 (rank 2) and S2 (rank 3) are still <= 3, neither exits!
    // Similarly, S8 moves to rank 10, S10 to rank 9, S9 to rank 8.
    // Since S9 and S10 are >= 8, neither short exits!
    const updatedUniverse = ['S3', 'S1', 'S2', 'S4', 'S5', 'S6', 'S7', 'S9', 'S10', 'S8'];
    const ranks = dummyRanks(updatedUniverse);

    const result = constructBufferedPortfolio(currentPositions, ranks, { legs: 2, buffer: 1 });

    expect(result.positions.get('S1')).toBe(0.25);
    expect(result.positions.get('S2')).toBe(0.25);
    expect(result.positions.get('S9')).toBe(-0.25);
    expect(result.positions.get('S10')).toBe(-0.25);
    expect(result.turnover).toBe(0);
    expect(result.rebalanced).toBe(false);
  });

  it('liquidates position when rank breaches hysteresis threshold', () => {
    const currentPositions = new Map<string, number>([
      ['S1', 0.25],
      ['S2', 0.25],
      ['S9', -0.25],
      ['S10', -0.25],
    ]);

    // S2 collapses to rank 6 (breaches exit rank 3).
    // S3 is rank 1, S1 is rank 2.
    // S2 should exit and S3 should enter.
    const collapsedUniverse = ['S3', 'S1', 'S4', 'S5', 'S6', 'S2', 'S7', 'S8', 'S9', 'S10'];
    const ranks = dummyRanks(collapsedUniverse);

    const result = constructBufferedPortfolio(currentPositions, ranks, { legs: 2, buffer: 1 });

    expect(result.positions.has('S2')).toBe(false);
    expect(result.positions.get('S1')).toBe(0.25);
    expect(result.positions.get('S3')).toBe(0.25);
    expect(result.turnover).toBeCloseTo(0.5, 10); // S2 out (0.25), S3 in (0.25)
    expect(result.rebalanced).toBe(true);
  });

  it('throws error when requested legs exceed half universe size', () => {
    const ranks = dummyRanks(['A', 'B', 'C']);
    expect(() => constructBufferedPortfolio(new Map(), ranks, { legs: 2 })).toThrow(
      /Cannot assign 2 long and short legs/
    );
  });

  it('throws error when buffer causes deadband overlap', () => {
    // 10 assets, legs 3, buffer 3 -> longExit = 6, shortExit = 10 - 3 - 3 + 1 = 5 -> overlap!
    const ranks = dummyRanks(universe);
    expect(() => constructBufferedPortfolio(new Map(), ranks, { legs: 3, buffer: 3 })).toThrow(
      /Deadband overlap/
    );
  });

  it('adjusts leg weights for beta-neutrality when betas are provided', () => {
    const ranks = dummyRanks(universe);
    // Longs S1, S2 have beta 1.0; Shorts S9, S10 have beta 2.0
    const betas = new Map<string, number>([
      ['S1', 1.0],
      ['S2', 1.0],
      ['S9', 2.0],
      ['S10', 2.0],
    ]);

    const result = constructBufferedPortfolio(new Map(), ranks, { legs: 2, buffer: 1, betas });

    // W_L * 1.0 = W_S * 2.0 and W_L + W_S = 1.0 -> W_L = 2/3, W_S = 1/3
    expect(result.positions.get('S1')).toBeCloseTo(1 / 3, 5); // 0.3333 each (2 legs = 0.6667)
    expect(result.positions.get('S2')).toBeCloseTo(1 / 3, 5);
    expect(result.positions.get('S9')).toBeCloseTo(-1 / 6, 5); // -0.1667 each (2 legs = -0.3333)
    expect(result.positions.get('S10')).toBeCloseTo(-1 / 6, 5);
    expect(result.netBetaExposure).toBeCloseTo(0, 5);
  });

  it('safely clamps buffer when autoClampBuffer is enabled on a reduced universe', () => {
    // 7 assets, legs 2, requested buffer 2 -> would overlap (4 >= 4) without autoClampBuffer
    const reducedRanks = dummyRanks(['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7']);
    
    // Without autoClampBuffer, it throws
    expect(() => constructBufferedPortfolio(new Map(), reducedRanks, { legs: 2, buffer: 2 })).toThrow(
      /Deadband overlap/
    );

    // With autoClampBuffer, it clamps buffer to 1 and succeeds
    const result = constructBufferedPortfolio(new Map(), reducedRanks, {
      legs: 2,
      buffer: 2,
      autoClampBuffer: true,
    });

    expect(result.positions.get('U1')).toBe(0.25);
    expect(result.positions.get('U2')).toBe(0.25);
    expect(result.positions.get('U6')).toBe(-0.25);
    expect(result.positions.get('U7')).toBe(-0.25);
    expect(result.positions.size).toBe(4);
  });
});
