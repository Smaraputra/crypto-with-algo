/**
 * Cross-sectional factor calculation and ranking engine for Binance perpetual futures.
 * Evaluates the tracked universe simultaneously at each bar boundary.
 */

export interface SymbolBarSnapshot {
  symbol: string;
  close: number;
  return7d: number;
  return14d: number;
  fundingRate: number;
  btcReturn14d: number;
  realizedVol20?: number;
}

export interface FactorWeights {
  mom: number;
  idio: number;
  carry: number;
  vol?: number;
}

export const DEFAULT_FACTOR_WEIGHTS: FactorWeights = {
  mom: 0.4,
  idio: 0.3,
  carry: 0.3,
  vol: 0.0,
};

export interface FactorScores {
  symbol: string;
  zMom: number;
  zIdio: number;
  zCarry: number;
  zVol: number;
  compositeZ: number;
  rank: number; // 1 (strongest long candidate) to N (strongest short candidate)
}

function meanAndStd(values: number[]): { mean: number; std: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 1 };
  const mean = values.reduce((acc, v) => acc + v, 0) / n;
  if (n === 1) return { mean, std: 1 };
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  return { mean, std: std > 1e-12 ? std : 1 };
}

/**
 * Standardizes an array of values into zero-mean, unit-variance z-scores.
 */
export function standardizeCrossSection(values: number[]): number[] {
  const { mean, std } = meanAndStd(values);
  return values.map((v) => (v - mean) / std);
}

/**
 * Computes cross-sectional factor z-scores and descending ranks across a snapshot of symbols.
 * Rank 1 represents the highest composite score (strongest long candidate).
 * Rank N represents the lowest composite score (strongest short candidate).
 */
export function computeCrossSectionalRanks(
  snapshots: SymbolBarSnapshot[],
  weights: FactorWeights = DEFAULT_FACTOR_WEIGHTS
): FactorScores[] {
  const n = snapshots.length;
  if (n < 4) {
    throw new Error(`Insufficient symbols for cross-sectional ranking: ${n} provided, minimum 4 required`);
  }

  // Extract raw factor series
  const rawMoms = snapshots.map((s) => s.return14d);
  const rawIdios = snapshots.map((s) => s.return14d - s.btcReturn14d);
  // Negative funding rate is favorable for long positions (shorts pay longs)
  const rawCarrys = snapshots.map((s) => -s.fundingRate);
  const rawVols = snapshots.map((s) => s.realizedVol20 ?? 0);

  // Cross-sectional standardization across symbols
  const zMoms = standardizeCrossSection(rawMoms);
  const zIdios = standardizeCrossSection(rawIdios);
  const zCarrys = standardizeCrossSection(rawCarrys);
  const zVols = standardizeCrossSection(rawVols);

  const volWeight = weights.vol ?? 0;

  const scored: FactorScores[] = snapshots.map((s, i) => {
    const compositeZ =
      weights.mom * zMoms[i] +
      weights.idio * zIdios[i] +
      weights.carry * zCarrys[i] +
      volWeight * zVols[i];

    return {
      symbol: s.symbol,
      zMom: zMoms[i],
      zIdio: zIdios[i],
      zCarry: zCarrys[i],
      zVol: zVols[i],
      compositeZ,
      rank: 0,
    };
  });

  // Sort descending: highest composite score gets rank 1.
  // Ties broken deterministically by symbol string.
  scored.sort((a, b) => b.compositeZ - a.compositeZ || a.symbol.localeCompare(b.symbol));

  scored.forEach((item, index) => {
    item.rank = index + 1;
  });

  return scored;
}
