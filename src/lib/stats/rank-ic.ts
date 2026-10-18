/**
 * Pure statistics for the forward signal lab's per-bar metric, no I/O.
 */

/** Average ranks (1-based), ties resolved to the mean rank of the tied group. */
export function rank(values: number[]): number[] {
  const n = values.length;
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && indexed[j + 1].v === indexed[i].v) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].i] = averageRank;
    }
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation; the n/(n-1) normalization cancels, so ddof is irrelevant. */
export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }

  if (varianceA === 0 || varianceB === 0) return NaN;
  return covariance / Math.sqrt(varianceA * varianceB);
}

/**
 * Centred score ranks: rank(scores) minus (n + 1) / 2 for each entry.
 * The result sums to 0 (ties included, because average ranks preserve the total).
 */
export function centredRanks(scores: number[]): number[] {
  const n = scores.length;
  const midpoint = (n + 1) / 2;
  return rank(scores).map((r) => r - midpoint);
}

/**
 * Population standard deviation: sqrt(sum((v - mean)^2) / n).
 * Throws on an empty array.
 */
export function populationSd(values: number[]): number {
  const n = values.length;
  if (n === 0) {
    throw new Error('populationSd needs at least one value');
  }
  const mean = values.reduce((s, v) => s + v, 0) / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    variance += d * d;
  }
  return Math.sqrt(variance / n);
}

/**
 * Dollar-neutral, gross-1 book weights: w_i = c_i / sum_j |c_j| with c = centredRanks(scores).
 * Weights sum to 0 and their absolute values sum to 1.
 * When every c_i is 0 (all scores tied, or n = 1) returns an array of zeros.
 */
export function bookWeights(scores: number[]): number[] {
  const c = centredRanks(scores);
  let absSum = 0;
  for (let i = 0; i < c.length; i++) {
    absSum += Math.abs(c[i]);
  }
  if (absSum === 0) {
    return new Array(c.length).fill(0);
  }
  return c.map((v) => v / absSum);
}

/**
 * Normalization factor k_N: n x populationSd(c) / sum|c| with c = centredRanks(scores).
 * Returns NaN when sum|c| is 0.
 */
export function kN(scores: number[]): number {
  const n = scores.length;
  if (n === 0) return NaN;
  const c = centredRanks(scores);
  let absSum = 0;
  for (let i = 0; i < n; i++) {
    absSum += Math.abs(c[i]);
  }
  if (absSum === 0) return NaN;
  return (n * populationSd(c)) / absSum;
}

/**
 * Closed-form k_N for distinct scores: n x sqrt((n^2 - 1) / 12) / S(n),
 * where S(n) = sum over i = 1..n of |i - (n + 1) / 2|.
 * Throws on n < 2 or non-integer n.
 */
export function kNNoTies(n: number): number {
  if (n < 2 || !Number.isInteger(n)) {
    throw new Error('kNNoTies requires an integer n >= 2');
  }
  const midpoint = (n + 1) / 2;
  let s = 0;
  for (let i = 1; i <= n; i++) {
    s += Math.abs(i - midpoint);
  }
  return (n * Math.sqrt((n * n - 1) / 12)) / s;
}

/**
 * Rank-weighted correlation (X_t): Pearson correlation between centred score ranks
 * and raw forward returns: pearson(centredRanks(scores), returns).
 *
 * Identity:
 * bookReturn(scores, returns) === kN(scores) x populationSd(returns) x rankWeightedCorrelation(scores, returns)
 *
 * This is Pearson on ranks against raw returns, not Spearman, because a rank-on-rank
 * statistic tracks medians while the book earns mean returns.
 */
export function rankWeightedCorrelation(scores: number[], returns: number[]): number {
  if (scores.length !== returns.length) {
    throw new Error('scores and returns must have the same length');
  }
  const n = scores.length;
  if (n < 2) return NaN;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(scores[i]) || !Number.isFinite(returns[i])) {
      return NaN;
    }
  }
  return pearson(centredRanks(scores), returns);
}

/**
 * Dollar-neutral rank-weighted book return: sum of bookWeights(scores)[i] x returns[i].
 * Throws when scores and returns lengths differ.
 */
export function bookReturn(scores: number[], returns: number[]): number {
  if (scores.length !== returns.length) {
    throw new Error('scores and returns must have the same length');
  }
  const weights = bookWeights(scores);
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += weights[i] * returns[i];
  }
  return sum;
}
