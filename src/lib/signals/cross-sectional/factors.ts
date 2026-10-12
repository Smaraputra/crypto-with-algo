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
  betaToBtc?: number;
  takerBuyRatio?: number;
  newsSentiment?: number;
}

export interface FactorWeights {
  mom: number;
  idio: number;
  carry: number;
  flow?: number;
  news?: number;
  vol?: number;
}

export const DEFAULT_FACTOR_WEIGHTS: FactorWeights = {
  mom: 0.25,
  idio: 0.25,
  carry: 0.25,
  flow: 0.15,
  news: 0.1,
  vol: 0.0,
};

export interface FactorScores {
  symbol: string;
  zMom: number;
  zIdio: number;
  zCarry: number;
  zFlow: number;
  zNews: number;
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
 * Clamps z-scores to [-limit, +limit] to prevent extreme rogue asset outliers
 * from dominating cross-sectional ranking.
 */
export function winsorizeZScores(values: number[], limit = 3.0): number[] {
  return values.map((v) => Math.max(-limit, Math.min(limit, v)));
}

/**
 * Standardizes an array of values into zero-mean, unit-variance z-scores with optional winsorization.
 */
export function standardizeCrossSection(values: number[], winsorizeLimit = 3.0): number[] {
  const { mean, std } = meanAndStd(values);
  const z = values.map((v) => (v - mean) / std);
  return winsorizeZScores(z, winsorizeLimit);
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
  // Residual momentum: return relative to asset beta-adjusted BTC return (removes collinearity)
  const rawIdios = snapshots.map((s) => s.return14d - (s.betaToBtc ?? 1.0) * s.btcReturn14d);
  // Negative funding rate is favorable for long positions (shorts pay longs)
  const rawCarrys = snapshots.map((s) => -s.fundingRate);
  // Taker buy ratio centered around 0.5 (neutral)
  const rawFlows = snapshots.map((s) => (s.takerBuyRatio !== undefined ? s.takerBuyRatio - 0.5 : 0));
  // News sentiment
  const rawNews = snapshots.map((s) => s.newsSentiment ?? 0);
  const rawVols = snapshots.map((s) => s.realizedVol20 ?? 0);

  // Cross-sectional standardization across symbols
  const zMoms = standardizeCrossSection(rawMoms);
  const zIdios = standardizeCrossSection(rawIdios);
  const zCarrys = standardizeCrossSection(rawCarrys);
  const zFlows = standardizeCrossSection(rawFlows);
  const zNews = standardizeCrossSection(rawNews);
  const zVols = standardizeCrossSection(rawVols);

  const flowWeight = weights.flow ?? 0;
  const newsWeight = weights.news ?? 0;
  const volWeight = weights.vol ?? 0;

  const scored: FactorScores[] = snapshots.map((s, i) => {
    const compositeZ =
      weights.mom * zMoms[i] +
      weights.idio * zIdios[i] +
      weights.carry * zCarrys[i] +
      flowWeight * zFlows[i] +
      newsWeight * zNews[i] +
      volWeight * zVols[i];

    return {
      symbol: s.symbol,
      zMom: zMoms[i],
      zIdio: zIdios[i],
      zCarry: zCarrys[i],
      zFlow: zFlows[i],
      zNews: zNews[i],
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
