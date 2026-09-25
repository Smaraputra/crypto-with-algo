/**
 * Calibration analytics for the live signal record: what the signal said
 * against what the market actually did afterwards.
 *
 * Reads resolved SignalOutcome documents at row level and returns four views
 * of them -- per-tier expectancy with confidence intervals, a reliability
 * curve over signed score, the forward-return distribution per tier, and a
 * cumulative per-signal return path. The outcome resolver
 * (POST /api/cron/resolve-outcomes) remains the only writer of SignalOutcome;
 * nothing here writes anything.
 *
 * WHAT THE NUMBERS ARE. A row's forward return is close-to-close from the
 * signal's candle to the close of the horizon bar (OUTCOME_HORIZON_BARS for
 * the style) at that row's own interval. There is no stop, no take-profit and
 * no fill simulation anywhere in this module. Cost is a fixed per-interval
 * estimate (defaultCostPercent) for a taker round trip, not a measured fill.
 *
 * WHAT MUST NEVER BE POOLED. Three axes, each for a different reason:
 *   - interval, because a style scores every interval in its preferredIntervals
 *     with the same horizonBars, so a scalping 1m row is a 12-minute return and
 *     a 5m row a 60-minute one. Pooling them was a real defect, fixed 2026-09-19.
 *   - source, because composite rows and the LLM panel's forward-only calls are
 *     different predictors that happen to share a collection.
 *   - configVersion, because each version is a different scorer. A record that
 *     spans a scorer change and reports one mean is measuring neither scorer.
 * The loader takes all three as required inputs rather than optional filters so
 * that pooling is not reachable by forgetting an argument.
 *
 * THE STATISTICS. Outcomes are written every bar over a horizon of h bars, so
 * consecutive rows share h-1 bars of price history, and the ten symbols at one
 * timestamp move together. Both dependencies are handled by resampling whole
 * timestamp buckets with a stationary block bootstrap whose block length is the
 * horizon (see groupedBlockBootstrapCi). The seed is fixed so an interval does
 * not move between page loads, which would read as a bug rather than as
 * sampling noise.
 */

import { SignalOutcome, sourceMatch, type SignalOutcomeSource } from '@/lib/models/signal-outcome';
import { directionalReturn } from '@/lib/signals/outcome-analytics';
import { groupedBlockBootstrapCi, meanOf } from '@/lib/stats/block-bootstrap';
import { SIGNAL_TIERS, type SignalTier } from '@/types/signal';
import type { TradingStyle } from '@/lib/models/signal-template';

/**
 * Below this many observations no estimate is reported at all. A mean over a
 * dozen overlapping bars is not a weak estimate, it is noise with a number
 * printed on it, and a chart that renders it invites reading a trend into it.
 */
export const MIN_SAMPLES_FOR_ESTIMATE = 30;

/**
 * A block bootstrap needs enough independent blocks to resample. With fewer
 * buckets than this multiple of the block length, nearly every draw is the same
 * handful of blocks and the interval is meaninglessly tight, so it is withheld.
 */
export const MIN_BLOCKS_FOR_CI = 8;

/** Bootstrap iterations, reduced above the row count at which the cost of a
 * full run stops being worth the third decimal place. Surfaced in the response
 * so the page can say which was used rather than implying one number always is. */
export function bootstrapIterationsFor(rowCount: number): number {
  if (rowCount > 50_000) return 200;
  if (rowCount > 10_000) return 500;
  return 1000;
}

export interface CalibrationRow {
  symbol: string;
  candleTimestamp: number;
  tier: SignalTier;
  score: number;
  forwardReturnPercent: number;
  mfePercent: number | null;
  maePercent: number | null;
  configVersion: number;
}

export interface LoadCalibrationRowsOptions {
  tradingStyle: TradingStyle;
  /** Required, never pooled: see the interval note in the module comment. */
  interval: string;
  /** Required, never pooled: composite and llm are different predictors. */
  source: SignalOutcomeSource;
  /** Optional, but pooling versions pools scorers -- the caller is told so. */
  configVersion?: number;
  symbol?: string;
  since?: Date;
}

/**
 * Resolved outcome rows for one style, interval and source, oldest first.
 *
 * Row level rather than a $group, because a confidence interval needs the
 * series and an aggregate cannot be un-aggregated. The projection is kept to
 * the fields the four views actually read: at 1m across ten symbols this is the
 * largest query in the module and there is no reason to carry the rest.
 */
export async function loadCalibrationRows(
  opts: LoadCalibrationRowsOptions
): Promise<CalibrationRow[]> {
  const { tradingStyle, interval, source, configVersion, symbol, since } = opts;

  const match: Record<string, unknown> = {
    tradingStyle,
    interval,
    status: 'resolved',
    forwardReturnPercent: { $ne: null },
    ...sourceMatch(source),
  };
  if (configVersion !== undefined) match.configVersion = configVersion;
  if (symbol) match.symbol = symbol;
  if (since) match.resolvedAt = { $gte: since };

  const docs = await SignalOutcome.find(match)
    .select('symbol candleTimestamp tier score forwardReturnPercent mfePercent maePercent configVersion')
    .sort({ candleTimestamp: 1 })
    .lean();

  return docs.map((doc) => ({
    symbol: doc.symbol,
    candleTimestamp: doc.candleTimestamp,
    tier: doc.tier,
    score: doc.score,
    forwardReturnPercent: doc.forwardReturnPercent as number,
    mfePercent: doc.mfePercent ?? null,
    maePercent: doc.maePercent ?? null,
    configVersion: doc.configVersion,
  }));
}

/**
 * Groups values into one bucket per distinct candleTimestamp, ascending, so the
 * bootstrap can resample whole cross-sections. Rows are expected sorted but are
 * not assumed to be: the bucket keys are sorted explicitly.
 */
export function bucketByTimestamp<T>(
  rows: T[],
  timestampOf: (row: T) => number,
  valueOf: (row: T) => number
): number[][] {
  const byTimestamp = new Map<number, number[]>();
  for (const row of rows) {
    const key = timestampOf(row);
    const bucket = byTimestamp.get(key);
    if (bucket) bucket.push(valueOf(row));
    else byTimestamp.set(key, [valueOf(row)]);
  }
  return [...byTimestamp.keys()].sort((a, b) => a - b).map((key) => byTimestamp.get(key) as number[]);
}

export interface MeanEstimate {
  /** Observations behind the estimate, always reported even when it is withheld. */
  count: number;
  meanPercent: number | null;
  ciLowPercent: number | null;
  ciHighPercent: number | null;
  /** Why an interval is absent, so the UI can say which rather than just blanking. */
  withheld: 'none' | 'too-few-samples' | 'too-few-blocks';
}

export interface EstimateOptions {
  /** Block length in timestamp buckets. Comes from the horizon, never cbrt(n). */
  meanBlockLen: number;
  iterations: number;
  seed: number;
}

/**
 * Mean of a per-row value with a block bootstrap interval, or a withheld
 * estimate with the reason attached when the sample cannot support one.
 */
export function estimateMean(
  rows: CalibrationRow[],
  valueOf: (row: CalibrationRow) => number,
  opts: EstimateOptions
): MeanEstimate {
  const count = rows.length;
  if (count < MIN_SAMPLES_FOR_ESTIMATE) {
    return { count, meanPercent: null, ciLowPercent: null, ciHighPercent: null, withheld: 'too-few-samples' };
  }

  const buckets = bucketByTimestamp(rows, (row) => row.candleTimestamp, valueOf);
  const mean = meanOf(rows.map(valueOf));

  if (buckets.length < MIN_BLOCKS_FOR_CI * opts.meanBlockLen) {
    return { count, meanPercent: mean, ciLowPercent: null, ciHighPercent: null, withheld: 'too-few-blocks' };
  }

  const ci = groupedBlockBootstrapCi(buckets, meanOf, {
    iterations: opts.iterations,
    meanBlockLen: opts.meanBlockLen,
    seed: opts.seed,
  });

  return {
    count,
    meanPercent: ci.point,
    ciLowPercent: ci.low,
    ciHighPercent: ci.high,
    withheld: 'none',
  };
}

export interface TierCalibration extends MeanEstimate {
  tier: SignalTier;
  /** Gross mean directional return; net is this less costPercentRoundTrip. */
  netMeanPercent: number | null;
  netCiLowPercent: number | null;
  netCiHighPercent: number | null;
  winRate: number | null;
  avgMfePercent: number | null;
  avgMaePercent: number | null;
}

/**
 * Per-tier expectancy with intervals, in the same directional-return convention
 * getLiveTierExpectancy uses so the dashboard and the CLI report agree.
 *
 * Cost is a constant subtracted from every draw, so the net interval is the
 * gross interval shifted, not a separate resample. Win rate, MFE and MAE are
 * reported before cost and from the long perspective regardless of tier,
 * matching the CLI report.
 */
export function tierCalibration(
  rows: CalibrationRow[],
  opts: EstimateOptions & { costPercentRoundTrip: number }
): TierCalibration[] {
  const byTier = new Map<SignalTier, CalibrationRow[]>();
  for (const row of rows) {
    const bucket = byTier.get(row.tier);
    if (bucket) bucket.push(row);
    else byTier.set(row.tier, [row]);
  }

  const results: TierCalibration[] = [];
  for (const tier of SIGNAL_TIERS) {
    const tierRows = byTier.get(tier);
    if (!tierRows || tierRows.length === 0) continue;

    const estimate = estimateMean(tierRows, (row) => directionalReturn(row.tier, row.forwardReturnPercent), opts);
    const shift = (value: number | null) => (value === null ? null : value - opts.costPercentRoundTrip);
    const wins = tierRows.filter((row) => directionalReturn(row.tier, row.forwardReturnPercent) > 0).length;
    const mfe = tierRows.map((row) => row.mfePercent).filter((v): v is number => v !== null);
    const mae = tierRows.map((row) => row.maePercent).filter((v): v is number => v !== null);

    results.push({
      ...estimate,
      tier,
      netMeanPercent: shift(estimate.meanPercent),
      netCiLowPercent: shift(estimate.ciLowPercent),
      netCiHighPercent: shift(estimate.ciHighPercent),
      winRate: wins / tierRows.length,
      avgMfePercent: mfe.length > 0 ? meanOf(mfe) : null,
      avgMaePercent: mae.length > 0 ? meanOf(mae) : null,
    });
  }

  return results;
}

export interface ReliabilityBucket extends MeanEstimate {
  scoreLow: number;
  scoreHigh: number;
  scoreMid: number;
}

/**
 * Mean SIGNED forward return per SIGNED score bucket: the reliability curve.
 *
 * Signed on both axes deliberately. The directional return used everywhere else
 * folds the tier's predicted direction into the number, which is right for
 * scoring a tier but wrong here: it would map a systematically inverted score
 * onto the same curve as a correct one. Signed against signed, a score carrying
 * directional information produces a line sloping up through the origin, and a
 * sign error is visible as one sloping down.
 *
 * Bucketing by score rather than by the five named tiers is also deliberate:
 * the tier cutoffs are the thing under test, so a view built on them assumes
 * its own conclusion.
 */
export function reliabilityCurve(
  rows: CalibrationRow[],
  opts: EstimateOptions & { bucketWidth?: number }
): ReliabilityBucket[] {
  const bucketWidth = opts.bucketWidth ?? 10;
  if (rows.length === 0) return [];

  const byBucket = new Map<number, CalibrationRow[]>();
  for (const row of rows) {
    const index = Math.floor(row.score / bucketWidth);
    const bucket = byBucket.get(index);
    if (bucket) bucket.push(row);
    else byBucket.set(index, [row]);
  }

  return [...byBucket.keys()]
    .sort((a, b) => a - b)
    .map((index) => {
      const bucketRows = byBucket.get(index) as CalibrationRow[];
      const estimate = estimateMean(bucketRows, (row) => row.forwardReturnPercent, opts);
      const scoreLow = index * bucketWidth;
      return { ...estimate, scoreLow, scoreHigh: scoreLow + bucketWidth, scoreMid: scoreLow + bucketWidth / 2 };
    });
}

export interface DistributionBin {
  low: number;
  high: number;
  counts: Record<string, number>;
}

export interface ReturnDistribution {
  binEdges: number[];
  bins: DistributionBin[];
  tiers: SignalTier[];
  /** Rows outside the plotted range, per tier, so clipping is stated not hidden. */
  clipped: Record<string, number>;
}

/**
 * Histogram of SIGNED forward returns per tier over shared bin edges.
 *
 * Shared edges because the point of the view is comparing tiers, and per-tier
 * edges would rescale each panel into looking alike. The range is set from a
 * central quantile rather than the extremes: one 30% outlier would otherwise
 * push every real observation into the middle bin.
 */
export function returnDistribution(
  rows: CalibrationRow[],
  opts: { binCount?: number; quantile?: number } = {}
): ReturnDistribution {
  const binCount = opts.binCount ?? 41;
  const quantile = opts.quantile ?? 0.99;

  const tiers = SIGNAL_TIERS.filter((tier) => rows.some((row) => row.tier === tier));
  if (rows.length === 0) return { binEdges: [], bins: [], tiers, clipped: {} };

  const sorted = rows.map((row) => Math.abs(row.forwardReturnPercent)).sort((a, b) => a - b);
  const cutoff = sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
  // A degenerate range (every row identical, or a single row) would divide by
  // zero below; a symmetric unit range keeps the view renderable and honest.
  const range = cutoff > 0 ? cutoff : 1;

  const binEdges: number[] = [];
  for (let i = 0; i <= binCount; i++) {
    binEdges.push(-range + (2 * range * i) / binCount);
  }

  const bins: DistributionBin[] = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({ low: binEdges[i], high: binEdges[i + 1], counts: {} });
  }
  const clipped: Record<string, number> = {};

  for (const row of rows) {
    const value = row.forwardReturnPercent;
    if (value < -range || value > range) {
      clipped[row.tier] = (clipped[row.tier] ?? 0) + 1;
      continue;
    }
    const index = Math.min(binCount - 1, Math.floor(((value + range) / (2 * range)) * binCount));
    bins[index].counts[row.tier] = (bins[index].counts[row.tier] ?? 0) + 1;
  }

  return { binEdges, bins, tiers, clipped };
}

export interface CumulativePoint {
  candleTimestamp: number;
  cumulativePercent: number;
  count: number;
}

export interface CumulativeSeries {
  configVersion: number;
  points: CumulativePoint[];
  /** Signals summed into this path after the sampling rule was applied. */
  count: number;
}

/** Tiers a rule would act on. Neutral is informational and is never summed. */
export const ACTIONABLE_TIERS: SignalTier[] = ['strong_buy', 'buy', 'sell', 'strong_sell'];

/**
 * Cumulative sum of net per-signal directional return over time, one series per
 * configVersion.
 *
 * THIS IS NOT AN EQUITY CURVE, and the non-overlapping default is what keeps it
 * from pretending to be one. Outcomes are written every bar over an h-bar
 * horizon, so summing all of them adds h positions that are open at the same
 * time on the same symbol -- a path no account could take, and one that scales
 * a small mean by h. Sampling every h-th bar per symbol gives a set of signals
 * that could actually be taken sequentially. `overlapping: true` sums every row
 * instead and exists only so the difference can be seen; it is never the
 * default and must be labelled wherever it is shown.
 *
 * There is no compounding and no position sizing here either: this is the
 * running sum of per-signal percentage returns, which is what the outcome
 * record can support and nothing more.
 */
export function cumulativeReturn(
  rows: CalibrationRow[],
  opts: {
    horizonBars: number;
    costPercentRoundTrip: number;
    overlapping?: boolean;
    tiers?: SignalTier[];
  }
): CumulativeSeries[] {
  const { horizonBars, costPercentRoundTrip, overlapping = false } = opts;
  const tiers = opts.tiers ?? ACTIONABLE_TIERS;

  const actionable = rows.filter((row) => tiers.includes(row.tier));

  // Non-overlapping sampling is per symbol: a symbol's own rows are what
  // overlap each other, and thinning the merged stream would drop a symbol's
  // signal because a different symbol happened to fire nearby.
  let sampled: CalibrationRow[];
  if (overlapping) {
    sampled = actionable;
  } else {
    const bySymbol = new Map<string, CalibrationRow[]>();
    for (const row of actionable) {
      const bucket = bySymbol.get(row.symbol);
      if (bucket) bucket.push(row);
      else bySymbol.set(row.symbol, [row]);
    }
    sampled = [];
    for (const symbolRows of bySymbol.values()) {
      const ordered = [...symbolRows].sort((a, b) => a.candleTimestamp - b.candleTimestamp);
      let nextEligible = -Infinity;
      for (const row of ordered) {
        if (row.candleTimestamp >= nextEligible) {
          sampled.push(row);
          // The next signal this symbol can contribute is one that fires after
          // the current one has resolved, which is horizonBars bars later --
          // measured in timestamps rather than array positions, because a
          // symbol's rows are not guaranteed to be gapless.
          nextEligible = row.candleTimestamp + horizonBars * barMs(ordered);
        }
      }
    }
  }

  const byVersion = new Map<number, CalibrationRow[]>();
  for (const row of sampled) {
    const bucket = byVersion.get(row.configVersion);
    if (bucket) bucket.push(row);
    else byVersion.set(row.configVersion, [row]);
  }

  return [...byVersion.keys()]
    .sort((a, b) => a - b)
    .map((configVersion) => {
      const versionRows = (byVersion.get(configVersion) as CalibrationRow[]).sort(
        (a, b) => a.candleTimestamp - b.candleTimestamp
      );
      let cumulative = 0;
      const points = versionRows.map((row, index) => {
        cumulative += directionalReturn(row.tier, row.forwardReturnPercent) - costPercentRoundTrip;
        return { candleTimestamp: row.candleTimestamp, cumulativePercent: cumulative, count: index + 1 };
      });
      return { configVersion, points, count: versionRows.length };
    });
}

/**
 * Bar length in ms inferred from the smallest positive gap between consecutive
 * timestamps of one symbol. Inferred rather than taken from the interval string
 * so the sampling rule stays correct if a caller passes rows from a mislabelled
 * interval; falls back to one bar when a symbol has a single row, in which case
 * the spacing is never used.
 */
function barMs(orderedRows: CalibrationRow[]): number {
  let smallest = Infinity;
  for (let i = 1; i < orderedRows.length; i++) {
    const gap = orderedRows[i].candleTimestamp - orderedRows[i - 1].candleTimestamp;
    if (gap > 0 && gap < smallest) smallest = gap;
  }
  return Number.isFinite(smallest) ? smallest : 1;
}

export interface CalibrationCoverage {
  statusCounts: { pending: number; resolved: number; unresolvable: number };
  /** candleTimestamp bounds of the resolved rows, or null when there are none. */
  resolvedFrom: number | null;
  resolvedTo: number | null;
  /** Every configVersion present in the resolved rows, ascending. */
  configVersions: number[];
}

/**
 * Coverage of the outcome record for one style, interval and source.
 *
 * Deliberately NOT filtered by configVersion or by `since`: its job is to say
 * what the resolver has actually covered, so it must keep answering that when
 * the views above are narrowed to a slice of it. Without this the page cannot
 * tell "this scorer has no edge" apart from "this scorer has barely run yet",
 * which on a record that only starts at the 2026-09-17 finalization deploy is
 * the difference that matters most.
 */
export async function loadCalibrationCoverage(opts: {
  tradingStyle: TradingStyle;
  interval: string;
  source: SignalOutcomeSource;
  symbol?: string;
}): Promise<CalibrationCoverage> {
  const { tradingStyle, interval, source, symbol } = opts;
  const base: Record<string, unknown> = { tradingStyle, interval, ...sourceMatch(source) };
  if (symbol) base.symbol = symbol;

  const [statusRows, resolvedRows] = await Promise.all([
    SignalOutcome.aggregate<{ _id: string; count: number }>([
      { $match: base },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    SignalOutcome.aggregate<{ _id: null; from: number; to: number; configVersions: number[] }>([
      { $match: { ...base, status: 'resolved' } },
      {
        $group: {
          _id: null,
          from: { $min: '$candleTimestamp' },
          to: { $max: '$candleTimestamp' },
          configVersions: { $addToSet: '$configVersion' },
        },
      },
    ]),
  ]);

  const byStatus = new Map(statusRows.map((row) => [row._id, row.count]));
  const resolved = resolvedRows[0];

  return {
    statusCounts: {
      pending: byStatus.get('pending') ?? 0,
      resolved: byStatus.get('resolved') ?? 0,
      unresolvable: byStatus.get('unresolvable') ?? 0,
    },
    resolvedFrom: resolved?.from ?? null,
    resolvedTo: resolved?.to ?? null,
    configVersions: (resolved?.configVersions ?? []).sort((a, b) => a - b),
  };
}
