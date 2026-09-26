/**
 * Pure statistics for measuring information coefficients (IC) between a
 * factor and forward returns, honest about overlapping-horizon bias.
 *
 * No I/O here: this module only takes plain arrays in and returns plain
 * numbers/objects, so it is usable from any research script or test without
 * touching the dataset, Mongo, or the live scoring path.
 *
 * Overlapping horizons: a factor measured every bar against its h-bar
 * forward return produces samples that share h-1 bars of price history with
 * their neighbors, so consecutive (factor, forward-return) pairs are
 * correlated with each other even when the factor has no real predictive
 * power. Naive t-stats on that series overstate significance. icWithHac
 * keeps every overlapping pair (for statistical power) but computes its
 * t-stat with a Newey-West (HAC) standard error at lag h-1, which corrects
 * for exactly that induced autocorrelation. icNonOverlapping instead removes
 * the overlap by sampling every h-th bar, trading power for pairs whose
 * naive t-stat needs no such correction.
 */

import { normalCdf } from '@/lib/stats/normal';

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
function pearson(a: number[], b: number[]): number {
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

function finitePairs(x: number[], y: number[]): { xs: number[]; ys: number[] } {
  const len = Math.min(x.length, y.length);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < len; i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
      xs.push(x[i]);
      ys.push(y[i]);
    }
  }
  return { xs, ys };
}

/**
 * Spearman rank correlation. Drops pairs where either value is not finite;
 * returns NaN when fewer than 3 pairs remain.
 */
export function spearman(x: number[], y: number[]): number {
  const { xs, ys } = finitePairs(x, y);
  if (xs.length < 3) return NaN;
  return pearson(rank(xs), rank(ys));
}

/** (c[i+h] - c[i]) / c[i]; null for the last h positions, which have no future bar. */
/**
 * Forward returns over `h` bars, optionally entered `lag` bars after the bar
 * the factor is read on.
 *
 * `lag` defaults to 0, which measures from the same close the factor is read
 * at. That is the convention Phase 3 used and it is kept as the default so
 * those numbers stay reproducible, but it has two problems. It assumes a fill
 * at a close that has only just been observed, and it puts `closes[i]` in both
 * the factor (for any factor built from that price) and the return's
 * denominator, so noise in one print moves both together. That is the standard
 * bid-ask bounce correlation, and it is how raw.perpSpotSpreadPct came to have
 * the largest IC in the study while the same quantity measured from an
 * independent series showed 40% of it.
 *
 * `lag: 1` measures from the next close instead, which shares no term with the
 * factor and is what a rule acting on the signal could actually get.
 */
export function forwardReturns(closes: number[], h: number, lag = 0): (number | null)[] {
  const n = closes.length;
  const result: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const entry = i + lag;
    const exit = entry + h;
    result[i] = exit < n ? (closes[exit] - closes[entry]) / closes[entry] : null;
  }
  return result;
}

/** offset, offset+h, offset+2h, ... while the index stays below n. */
export function nonOverlappingIndices(n: number, h: number, offset = 0): number[] {
  if (h <= 0) {
    throw new Error(`nonOverlappingIndices: h must be positive, got ${h}`);
  }
  const result: number[] = [];
  for (let i = offset; i < n; i += h) {
    result.push(i);
  }
  return result;
}

/**
 * Newey-West (HAC) mean, standard error, and t-stat with Bartlett weights
 * w_j = 1 - j / (lag + 1) applied to the autocovariances at lags 1..lag.
 *
 * The lag-0 autocovariance (and every higher lag, for consistency) is
 * normalized by (n - 1), matching this codebase's own sample-variance
 * convention (see computeSharpe in src/lib/backtest/metrics.ts). That choice
 * makes lag 0 reduce exactly to the ordinary standard error of the mean:
 * se = sampleStdDev / sqrt(n).
 */
export function hacTStatOfMean(
  series: number[],
  lag: number
): { mean: number; se: number; t: number } {
  const n = series.length;
  if (n === 0) return { mean: NaN, se: NaN, t: NaN };

  const mean = series.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { mean, se: NaN, t: NaN };

  const deviations = series.map((v) => v - mean);
  const denom = n - 1;

  let gamma0 = 0;
  for (let i = 0; i < n; i++) gamma0 += deviations[i] * deviations[i];
  gamma0 /= denom;

  let longRunVariance = gamma0;
  for (let j = 1; j <= lag; j++) {
    let gammaJ = 0;
    for (let i = j; i < n; i++) gammaJ += deviations[i] * deviations[i - j];
    gammaJ /= denom;
    const weight = 1 - j / (lag + 1);
    longRunVariance += 2 * weight * gammaJ;
  }

  // HAC variance estimates can go slightly negative in finite samples; clamp.
  const se = Math.sqrt(Math.max(0, longRunVariance) / n);
  const t = se === 0 ? NaN : mean / se;
  return { mean, se, t };
}

function overlappingPairs(
  factor: number[],
  fwd: (number | null)[]
): { f: number[]; r: number[] } {
  const len = Math.min(factor.length, fwd.length);
  const f: number[] = [];
  const r: number[] = [];
  for (let i = 0; i < len; i++) {
    const fv = factor[i];
    const rv = fwd[i];
    if (Number.isFinite(fv) && rv !== null && Number.isFinite(rv)) {
      f.push(fv);
      r.push(rv);
    }
  }
  return { f, r };
}

/** z-score using population moments; see icWithHac for why that keeps ic == spearman. */
function standardize(values: number[]): number[] {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  if (sd === 0) return values.map(() => 0);
  return values.map((v) => (v - mean) / sd);
}

/**
 * IC computed on every overlapping (factor, forward-return) pair, with a
 * Newey-West t-stat at lag h-1 -- this is what makes using every overlapping
 * pair honest: it keeps the statistical power of the full overlapping
 * series while correcting the standard error for the autocorrelation that
 * overlap induces, instead of either ignoring it (inflated significance) or
 * discarding pairs to avoid it (see icNonOverlapping).
 *
 * ic is computed as mean(zf * zr) where zf/zr are z-scores of the ranks; this
 * is algebraically identical to the Pearson correlation of those ranks (the
 * normalization constants cancel), i.e. exactly the Spearman coefficient on
 * the same pairs.
 */
export function icWithHac(
  factor: number[],
  fwd: (number | null)[],
  h: number
): { ic: number; n: number; t: number } {
  const { f, r } = overlappingPairs(factor, fwd);
  const n = f.length;
  if (n < 3) return { ic: NaN, n, t: NaN };

  const zf = standardize(rank(f));
  const zr = standardize(rank(r));
  const d = zf.map((v, i) => v * zr[i]);
  const ic = d.reduce((s, v) => s + v, 0) / n;
  const { t } = hacTStatOfMean(d, h - 1);

  return { ic, n, t };
}

/**
 * IC computed only on non-overlapping bars (every h-th bar from offset), with
 * the naive t-stat t = ic * sqrt((n-2) / (1-ic^2)) -- valid here because
 * non-overlapping samples carry no induced autocorrelation.
 */
export function icNonOverlapping(
  factor: number[],
  fwd: (number | null)[],
  h: number,
  offset = 0
): { ic: number; n: number; t: number } {
  const len = Math.min(factor.length, fwd.length);
  const idxs = nonOverlappingIndices(len, h, offset);

  const f: number[] = [];
  const r: number[] = [];
  for (const i of idxs) {
    const fv = factor[i];
    const rv = fwd[i];
    if (Number.isFinite(fv) && rv !== null && Number.isFinite(rv)) {
      f.push(fv);
      r.push(rv);
    }
  }

  const n = f.length;
  const ic = spearman(f, r);
  if (!Number.isFinite(ic) || n < 3) return { ic, n, t: NaN };

  const denom = 1 - ic * ic;
  const t = denom > 0 ? ic * Math.sqrt((n - 2) / denom) : NaN;
  return { ic, n, t };
}

/** Share of pairs with a nonzero, finite factor and a finite forward return whose signs agree. */
export function signHitRate(factor: number[], fwd: number[]): number {
  const len = Math.min(factor.length, fwd.length);
  let hits = 0;
  let total = 0;
  for (let i = 0; i < len; i++) {
    const f = factor[i];
    const r = fwd[i];
    if (!Number.isFinite(f) || f === 0 || !Number.isFinite(r)) continue;
    total++;
    if (Math.sign(f) === Math.sign(r)) hits++;
  }
  return total === 0 ? NaN : hits / total;
}

/**
 * Mean forward return in the top and bottom q share of factor values.
 * The quantile size is max(1, floor(n * q)) observations per side.
 */
export function quantileSpread(
  factor: number[],
  fwd: number[],
  q = 0.1
): { top: number; bottom: number; spread: number } {
  const len = Math.min(factor.length, fwd.length);
  const pairs: Array<{ f: number; r: number }> = [];
  for (let i = 0; i < len; i++) {
    if (Number.isFinite(factor[i]) && Number.isFinite(fwd[i])) {
      pairs.push({ f: factor[i], r: fwd[i] });
    }
  }

  const n = pairs.length;
  if (n === 0) return { top: NaN, bottom: NaN, spread: NaN };

  pairs.sort((a, b) => a.f - b.f);
  const k = Math.max(1, Math.floor(n * q));
  const meanOf = (slice: Array<{ r: number }>) =>
    slice.reduce((s, p) => s + p.r, 0) / slice.length;

  const bottom = meanOf(pairs.slice(0, k));
  const top = meanOf(pairs.slice(n - k));
  return { top, bottom, spread: top - bottom };
}

/** mulberry32: small, fast, decent-quality seeded PRNG returning [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One stationary block bootstrap resample (Politis & Romano 1994): a
 * sequence of n indices into [0, n), built from blocks of geometrically
 * distributed length (mean meanBlockLen) that wrap around at the end of the
 * series, so every original index remains equally likely to be drawn.
 */
export function stationaryBlockBootstrapIndices(
  n: number,
  meanBlockLen: number,
  seed: number
): number[] {
  if (n <= 0) return [];

  const rng = mulberry32(seed);
  const restartProbability = 1 / Math.max(1, meanBlockLen);
  const indices = new Array<number>(n);

  let current = Math.floor(rng() * n);
  for (let i = 0; i < n; i++) {
    indices[i] = current;
    current = rng() < restartProbability ? Math.floor(rng() * n) : (current + 1) % n;
  }
  return indices;
}

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Percentile bootstrap confidence interval for `statistic`, resampled with
 * the stationary block bootstrap so the block structure (not independent
 * bars) is preserved. Only finite, paired (factor, forward-return)
 * observations are resampled; `statistic` always receives clean number[]
 * arrays. Deterministic for a given seed: iteration i draws its resample
 * from a seed derived from opts.seed and i.
 */
export function bootstrapCi(
  factor: number[],
  fwd: (number | null)[],
  statistic: (f: number[], r: number[]) => number,
  opts: { iterations: number; meanBlockLen: number; seed: number; alpha?: number }
): { low: number; high: number } {
  const alpha = opts.alpha ?? 0.05;
  const { f: vf, r: vr } = overlappingPairs(factor, fwd);
  const m = vf.length;

  const stats: number[] = [];
  for (let iter = 0; iter < opts.iterations; iter++) {
    const iterSeed = (opts.seed + iter * 0x9e3779b1) >>> 0;
    const idxs = stationaryBlockBootstrapIndices(m, opts.meanBlockLen, iterSeed);
    const rf = idxs.map((i) => vf[i]);
    const rr = idxs.map((i) => vr[i]);
    stats.push(statistic(rf, rr));
  }

  stats.sort((a, b) => a - b);
  return { low: percentile(stats, alpha / 2), high: percentile(stats, 1 - alpha / 2) };
}

/**
 * The per-pair terms d_i = zf_i * zr_i that icWithHac averages to get `ic`
 * (zf/zr are z-scores of the ranks of the overlapping finite (factor, fwd)
 * pairs): mean(d) is exactly the Spearman IC. Returning the series itself,
 * rather than just its mean, lets a caller bootstrap that mean without
 * re-ranking inside every resample -- see bootstrapCiOfMean. Empty when
 * fewer than 3 finite pairs are available (mirrors icWithHac's own
 * threshold).
 */
export function standardizedRankProducts(factor: number[], fwd: (number | null)[]): number[] {
  const { f, r } = overlappingPairs(factor, fwd);
  if (f.length < 3) return [];

  const zf = standardize(rank(f));
  const zr = standardize(rank(r));
  return zf.map((v, i) => v * zr[i]);
}

/**
 * Percentile bootstrap CI for the mean of `series`, block-resampled with the
 * same stationary block bootstrap and seed/iteration semantics as
 * bootstrapCi. Unlike bootstrapCi, each iteration only resamples indices and
 * averages -- O(n), no sorting -- so this is cheap enough to run per
 * candidate cell even at a large sample size.
 *
 * Combined with standardizedRankProducts, this is the fixed-rank block
 * bootstrap approximation to a Spearman IC's confidence interval: ranks are
 * computed once, on the full (sub)sample, before resampling, not
 * recomputed within each individual resample. That is standard practice at
 * this sample size (re-ranking every resample of ~10^5 pairs, ~200-1000
 * times, is the O(m log m)-per-iteration cost this function exists to
 * avoid); it trades a small amount of exactness in each individual
 * resample's rank correlation for a bootstrap that is actually affordable
 * to run for every gated cell.
 */
export function bootstrapCiOfMean(
  series: number[],
  opts: { iterations: number; meanBlockLen: number; seed: number; alpha?: number }
): { low: number; high: number; point: number } {
  const alpha = opts.alpha ?? 0.05;
  const n = series.length;
  const point = n === 0 ? NaN : series.reduce((s, v) => s + v, 0) / n;

  const stats: number[] = [];
  for (let iter = 0; iter < opts.iterations; iter++) {
    const iterSeed = (opts.seed + iter * 0x9e3779b1) >>> 0;
    const idxs = stationaryBlockBootstrapIndices(n, opts.meanBlockLen, iterSeed);
    let sum = 0;
    for (const i of idxs) sum += series[i];
    stats.push(sum / n);
  }

  stats.sort((a, b) => a - b);
  return { low: percentile(stats, alpha / 2), high: percentile(stats, 1 - alpha / 2), point };
}

/** Quarter label like '2025Q3', evaluated in UTC. */
export function quarterOf(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${year}Q${quarter}`;
}

/** Per-quarter IC computed with icNonOverlapping, one entry per quarter present in `timestamps`. */
export function rollingByQuarter(
  timestamps: number[],
  factor: number[],
  fwd: (number | null)[],
  h: number
): Array<{ quarter: string; ic: number; n: number; t: number }> {
  const len = Math.min(timestamps.length, factor.length, fwd.length);
  const indicesByQuarter = new Map<string, number[]>();

  for (let i = 0; i < len; i++) {
    const quarter = quarterOf(timestamps[i]);
    const bucket = indicesByQuarter.get(quarter);
    if (bucket) {
      bucket.push(i);
    } else {
      indicesByQuarter.set(quarter, [i]);
    }
  }

  return [...indicesByQuarter.keys()].sort().map((quarter) => {
    const idxs = indicesByQuarter.get(quarter)!;
    const subFactor = idxs.map((i) => factor[i]);
    const subFwd = idxs.map((i) => fwd[i]);
    const { ic, n, t } = icNonOverlapping(subFactor, subFwd, h);
    return { quarter, ic, n, t };
  });
}

/**
 * Two-sided p-value of a t-statistic against a standard normal reference,
 * which is what a Newey-West t converges to. NaN in, NaN out; an infinite t
 * is a p of exactly 0.
 */
export function pValueFromT(t: number): number {
  if (Number.isNaN(t)) return NaN;
  if (!Number.isFinite(t)) return 0;
  return 2 * (1 - normalCdf(Math.abs(t)));
}

/**
 * Benjamini-Hochberg step-up procedure at false-discovery rate q: sort the m
 * finite p-values, find the largest k with p_(k) <= (k / m) q, and reject
 * every hypothesis whose p is at or below p_(k). Returns one boolean per
 * input, in input order. Non-finite p-values are never rejected and do not
 * count toward m.
 *
 * This is the phase-wide multiplicity control the 2026-09-25 pre-registration
 * fixed (factors.ts header): the survivor rule's |t| threshold alone has no
 * control across the ~1,500 cells an interval study produces.
 */
export function benjaminiHochberg(pValues: readonly number[], q: number): boolean[] {
  if (!(q > 0 && q < 1)) {
    throw new Error(`benjaminiHochberg: q must be in (0, 1), got ${q}`);
  }
  const finite = pValues
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => Number.isFinite(p) && p >= 0 && p <= 1)
    .sort((a, b) => a.p - b.p);
  const m = finite.length;

  let cutoff = -1;
  for (let k = 1; k <= m; k++) {
    if (finite[k - 1].p <= (k / m) * q) cutoff = finite[k - 1].p;
  }

  const rejected = new Array<boolean>(pValues.length).fill(false);
  if (cutoff < 0) return rejected;
  for (const { p, i } of finite) {
    if (p <= cutoff) rejected[i] = true;
  }
  return rejected;
}

/**
 * Demeans each symbol's forward-return series by the equal-weight mean across
 * the symbols sharing that bar's timestamp: the cross-sectional (relative
 * value) reading, which credits a factor only for what it said about this
 * symbol against the others, not for calling the market. Bars with fewer than
 * minCrossSection finite returns become NaN for every symbol rather than a
 * value demeaned by too few peers. One output per input series, same length.
 *
 * The bar's mean is accumulated incrementally (Welford), not as sum/count.
 * That is the standard numerically stable running mean, and it also makes the
 * degenerate cross-section exact: when every symbol carries the same return,
 * each update adds (v - mean)/k = 0, so the mean stays bit-for-bit v and every
 * residual is exactly 0. The naive sum/count does not -- (v + v + v) / 3 is a
 * rounding away from v for about one double in eight -- and those 1e-18
 * residuals rank like real dispersion, which is a cross-section of pure noise
 * reported as signal.
 */
export function demeanAcrossSymbols(
  timestamps: ReadonlyArray<ArrayLike<number>>,
  fwd: ReadonlyArray<Float64Array>,
  minCrossSection: number
): Float64Array[] {
  const means = new Map<number, { mean: number; count: number }>();
  for (let s = 0; s < fwd.length; s++) {
    const ts = timestamps[s];
    const f = fwd[s];
    for (let i = 0; i < f.length; i++) {
      const v = f[i];
      if (!Number.isFinite(v)) continue;
      const entry = means.get(ts[i]);
      if (entry) {
        entry.count++;
        entry.mean += (v - entry.mean) / entry.count;
      } else {
        means.set(ts[i], { mean: v, count: 1 });
      }
    }
  }
  return fwd.map((f, s) => {
    const ts = timestamps[s];
    const out = new Float64Array(f.length).fill(NaN);
    for (let i = 0; i < f.length; i++) {
      const v = f[i];
      if (!Number.isFinite(v)) continue;
      const entry = means.get(ts[i]);
      if (entry && entry.count >= minCrossSection) out[i] = v - entry.mean;
    }
    return out;
  });
}

/**
 * One Spearman IC per bar across the symbols present at that bar (the
 * Fama-MacBeth reading). Each entry of `bars` pairs the factor and forward
 * return of every symbol with both finite at one timestamp; bars narrower
 * than minCrossSection, and bars whose IC is undefined, are skipped. The
 * caller reduces the series with hacTStatOfMean at lag h-1: one draw per
 * bar, so ten symbols moving together are never counted as ten.
 */
export function crossSectionalIcSeries(
  bars: ReadonlyArray<{ factor: number[]; fwd: number[] }>,
  minCrossSection: number
): number[] {
  const out: number[] = [];
  for (const bar of bars) {
    const ic = oneBarIc(bar.factor, bar.fwd, minCrossSection);
    if (Number.isFinite(ic)) out.push(ic);
  }
  return out;
}

/** One bar's cross-sectional Spearman; NaN for a bar narrower than minCrossSection or with no ranking. */
function oneBarIc(factor: number[], fwd: number[], minCrossSection: number): number {
  const { xs, ys } = finitePairs(factor, fwd);
  if (xs.length < minCrossSection) return NaN;
  return spearman(xs, ys);
}

/**
 * crossSectionalIcSeries over bars this function groups itself, keeping each
 * surviving bar's timestamp: every symbol's (timestamp, factor, forward
 * return) triples are joined on the timestamp, bars narrower than
 * minCrossSection and bars whose IC is undefined are dropped, and what remains
 * is returned in ascending time order.
 *
 * The timestamps are what a caller needs to reduce the series by quarter, and
 * the join is why they cannot be recovered afterwards: symbols do not share a
 * bar index, only a bar time. A factor identical across symbols at a bar has
 * no within-bar ranking, so it yields an EMPTY series rather than a series of
 * zeros -- that is the whole point of reading this statistic rather than a
 * Spearman pooled over bars, which such a factor still scores on.
 */
export function barIcSeries(
  perSymbol: ReadonlyArray<{
    timestamps: ArrayLike<number>;
    factor: ArrayLike<number>;
    fwd: ArrayLike<number>;
  }>,
  minCrossSection: number
): { t: number[]; ic: number[] } {
  const byTime = new Map<number, { factor: number[]; fwd: number[] }>();
  for (const symbol of perSymbol) {
    const len = Math.min(symbol.timestamps.length, symbol.factor.length, symbol.fwd.length);
    for (let i = 0; i < len; i++) {
      const f = symbol.factor[i];
      const r = symbol.fwd[i];
      if (!Number.isFinite(f) || !Number.isFinite(r)) continue;
      const bucket = byTime.get(symbol.timestamps[i]);
      if (bucket) {
        bucket.factor.push(f);
        bucket.fwd.push(r);
      } else {
        byTime.set(symbol.timestamps[i], { factor: [f], fwd: [r] });
      }
    }
  }

  const t: number[] = [];
  const ic: number[] = [];
  for (const stamp of [...byTime.keys()].sort((a, b) => a - b)) {
    const bar = byTime.get(stamp)!;
    const value = oneBarIc(bar.factor, bar.fwd, minCrossSection);
    if (!Number.isFinite(value)) continue;
    t.push(stamp);
    ic.push(value);
  }
  return { t, ic };
}
