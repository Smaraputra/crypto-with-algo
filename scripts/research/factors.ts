/**
 * Causal, per-bar factor matrix built from the same code paths the live
 * scorer and backtests use: prepareBacktest's precomputed indicator suites
 * and SuperTrend, computeSignalScore for the composite and per-category
 * scores, and the HTF context already exported per bar by C1's
 * export-dataset.ts. No I/O: candles, snapshots, and HTF rows are supplied
 * by the caller (typically load-dataset.ts) and nothing here reaches Mongo.
 *
 * Every factor is NaN before the shared indicator warmup and whenever its
 * own input is missing at that bar (no snapshot, no HTF context, too few
 * bars of price history) -- never silently defaulted to zero, so a research
 * agent's IC measurement never mistakes "no data" for "neutral reading".
 *
 * Known divergence from live scoring: computeIndicatorsForStyle (the live
 * path, src/lib/indicators/compute-for-style.ts) nulls the raw Ichimoku
 * indicator for scalping before interpretation, so no Ichimoku signal ever
 * reaches the scorer at that style. prepareBacktest/interpretIndicatorsAtBar
 * (src/lib/backtest/optimized-engine.ts, shared with ordinary backtesting)
 * has no such style awareness -- every style gets Ichimoku interpreted, a
 * pre-existing divergence this file cannot fix at the source without
 * touching src/, and which any backtest/harness branch built on
 * optimized-engine.ts inherits too. computeFactorMatrix works around it
 * locally, for factor computation only, by stripping the Ichimoku reading
 * and signal from the suite it hands to computeSignalScore when style is
 * scalping (see excludeIchimokuForScalping below).
 */

import type { TradingStyle } from '@/lib/models/signal-template';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { SignalComponent, SignalWeights } from '@/types/signal';
import type { OHLCV } from '@/types/market';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { FUNDING_INTERVAL_MS } from '@/lib/backtest/funding';
import { prepareBacktest } from '@/lib/backtest/optimized-engine';
import { computeSignalScore } from '@/lib/signals/scorer';
import type { LeanSnapshot } from '@/lib/backtest/snapshot-series';
import type { CandleRow, HtfRow, MetricsRow, PerpCandleRow, SnapshotRow } from './dataset-format';
import { alignToBars, METRICS_SLOT_MS } from '@/lib/archive-ingestion';
import { intervalToMs } from '@/lib/intervals';
import { MARKET_SESSIONS, isSessionMeaningful, sessionOfCandleClose } from '@/lib/sessions';

export interface FactorMatrix {
  names: string[];
  categories: string[];
  values: Array<Float64Array>;
  warmupBars: number;
  timestamps: number[];
  closes: number[];
  /**
   * Perpetual close per bar, exact-timestamp join, NaN where the dataset has
   * no perp bar. The venue every backtest charges; --return-series perp
   * measures forward returns on it.
   */
  perpCloses: number[];
}

export interface FactorMatrixInput {
  candles: CandleRow[];
  snapshots: SnapshotRow[] | null;
  htf: HtfRow[];
  interval: string;
  /**
   * The archive's 5m futures-metrics grid for this symbol, from
   * scripts/research/load-dataset.ts's loadMetrics. Optional: omit it and
   * every metrics-derived factor is NaN for the whole series, which is what
   * every study before this input existed measured.
   */
  metrics?: MetricsRow[] | null;
  /** Perpetual bars for this symbol and interval, the traded series. */
  perp?: PerpCandleRow[] | null;
  /** The premium index series for the same symbol and interval. */
  premiumIndex?: PerpCandleRow[] | null;
}

// Fixes each interval's indicator periods and DEFAULT_TEMPLATE_WEIGHTS, per the brief.
const STYLE_FOR_INTERVAL: Record<string, TradingStyle> = {
  '5m': 'scalping',
  '15m': 'day_trading',
  '1h': 'day_trading',
  '4h': 'swing_trading',
  '1d': 'position_trading',
};

/** Exported so export-dataset.ts resolves the same style for the same interval when it needs the style's indicator config (e.g. for the HTF context). */
export function styleForInterval(interval: string): TradingStyle {
  const style = STYLE_FOR_INTERVAL[interval];
  if (!style) {
    throw new Error(`No trading style mapped for interval "${interval}"`);
  }
  return style;
}

/** See this file's header: strips Ichimoku's raw reading and derived trend signal, matching computeIndicatorsForStyle's scalping behavior that prepareBacktest itself does not have. */
function excludeIchimokuForScalping(suite: IndicatorSuite): IndicatorSuite {
  if (!suite.ichimoku && !suite.signals.trend.some((s) => s.name === 'Ichimoku')) {
    return suite;
  }
  return {
    ...suite,
    ichimoku: null,
    signals: {
      ...suite.signals,
      trend: suite.signals.trend.filter((s) => s.name !== 'Ichimoku'),
    },
  };
}

export function toOHLCV(row: CandleRow): OHLCV {
  return {
    timestamp: row.t,
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: row.v,
    ...(row.tbv !== null ? { takerBuyVolume: row.tbv } : {}),
  };
}

/** Inverse of the export side's row shaping in scripts/research/export-dataset.ts. */
export function toLeanSnapshot(row: SnapshotRow): LeanSnapshot {
  return {
    timestamp: row.t,
    data: {
      fundingRate: row.fundingRate
        ? { rate: row.fundingRate.rate, markPrice: row.fundingRate.markPrice ?? undefined }
        : undefined,
      longShortRatio: row.longShortRatio ?? undefined,
      openInterest: row.openInterest ?? undefined,
      newsSentiment: row.newsSentiment ?? undefined,
      fearGreed: row.fearGreed ?? undefined,
    },
  };
}

const CATEGORY_ORDER: (keyof SignalWeights)[] = [
  'trend',
  'momentum',
  'volume',
  'volatility',
  'futures',
  'sentiment',
  'htf',
];

/**
 * PRE-REGISTRATION, 2026-09-25, for the three book-depth columns added below.
 * Written before any measurement; the results go in factor-ic.ts's header.
 *
 * All three come from `depthNotional1` and `depthNotional5`, which
 * `export-dataset.ts` has always written into `MetricsRow` and which no factor
 * has ever read. They need no ingestion and no re-export.
 *
 * MEASURED AT 5m AND 15m FIRST, not at 4h. Recovering per-trade dispersion from
 * the recorded bootstrap CIs puts the statistical bar at about 0.010% at 5m
 * against 0.450% at 4h, so a 4h reading cannot be proven at the sample on hand
 * even if the effect is real. At lag 1, per the standing ruling.
 *
 * SURVIVOR RULE, FIXED NOW: the existing rule (|ic| >= 0.02, two or more
 * horizons, 60% quarter agreement, 70% symbol agreement) with |t| raised from
 * 2.5 to 3.15, and Benjamini-Hochberg FDR at 0.10 across the phase's cells.
 * 3.15 is the empirically calibrated value: |t| > 2.5 fires on 4.0% to 4.5% of
 * zero-edge trials for a persistent factor against a nominal 1.24%, and at 3.15
 * no existing survivor is lost.
 *
 * PREDICTED SIGNS:
 *
 * - `raw.depthFlow1`: POSITIVE, and this is the only one with a real prior.
 *   Order-flow imbalance is continuation-shaped in the literature: price
 *   follows flow. That is the OPPOSITE sign to `raw.depthImbalance1`, which
 *   this program measured as contrarian at 4h and 1d (lag 1: 4h h16 -0.0408
 *   t -5.8, 1d h8-32). Level crowded means fade; flow means follow. The sign
 *   contrast is the test, and a negative flow IC would mean the two columns are
 *   measuring the same thing and this adds nothing.
 *   It also matters for execution: Stage 0 established that a passive entry on
 *   a mean-reversion signal is adversely selected, so only a
 *   continuation-shaped signal can use the 0.04% maker cost bar at all.
 *
 * - `raw.depthNotional1`: NO SURVIVOR EXPECTED. A liquidity level is a state
 *   variable, not a direction. If it survives as a direct factor it is more
 *   likely proxying market regime or a symbol's size than predicting returns,
 *   and it should be treated as a conditioner rather than a signal.
 *
 * - `raw.depthSlope`: NO SURVIVOR EXPECTED, same reasoning. A book that thickens
 *   away from the touch implies higher impact per unit size, which is an
 *   execution cost input rather than a forecast.
 *
 * Recording two predicted non-survivors matters as much as the one predicted
 * survivor: if all three clear the rule, the likeliest explanation is that the
 * rule is too loose for this input, not that three independent edges appeared.
 *
 * STAGE 2 PRE-REGISTRATION, 2026-09-25, for the four columns after those.
 * Written before any measurement. Measured at 5m, 1h AND 4h in one pass, not
 * one interval at a time: Stage 1 had to add intervals after seeing its first
 * result, which makes the later ones post-hoc, and doing all three together
 * avoids repeating that.
 *
 * - `raw.varianceRatio`: NO SURVIVOR EXPECTED as a direct factor. VR(q) is a
 *   REGIME reading, not a direction: above 1 the series trends, below 1 it
 *   reverts. Asking whether the level of the ratio predicts the sign of the
 *   next return is not the hypothesis, and a survivor here would more likely
 *   mean it is proxying volatility than forecasting anything.
 *
 * - `raw.ret1InMeanReversion` and `raw.ret1InTrend` ARE the hypothesis. They
 *   are the same one-bar return split by the regime the bar sits in, so
 *   comparing their two ICs asks the question the ratio exists to answer:
 *   does knowing the regime tell you when reversal works? PREDICTION: both
 *   negative, since Phase 3 found reversal dominates intraday, but materially
 *   MORE negative in the mean-reversion subset. The conditioner earns its
 *   place only through that gap.
 *   FALSIFICATION, fixed now: if the trend subset's IC is as negative as, or
 *   more negative than, the mean-reversion subset's, then the variance ratio
 *   is either mis-signed or measuring nothing here, and no further work should
 *   be done on it. A gap smaller than about a third of the unconditional |ic|
 *   counts as no gap.
 *
 * - `raw.fundingProximity`: WEAK NEGATIVE, probably no survivor. Funding
 *   settles on a known 8h clock, so a bar's distance from the next settlement
 *   is an event-time coordinate that nothing here has ever used. If crowded
 *   longs close into a settlement they are about to pay for, high positive
 *   funding near settlement should precede lower returns, the same contrarian
 *   direction `raw.fundingZ` already shows. The new content is the event-time
 *   axis, not the funding level.
 *
 * PHASE B PRE-REGISTRATION, 2026-09-26, for the five columns after those and
 * the cross-symbol column in cross-symbol-factors.ts. Written before any
 * measurement. Measured at 15m, 1h AND 4h in one pass at lag 1 (5m excluded in
 * advance: its maker breakeven IC is 0.027 against a program-best 0.009),
 * horizons 1,2,4,8,16,32,48 at 15m so the 4 to 12 hour prior is reachable.
 * Survivor rule with |t| >= 3.15 and Benjamini-Hochberg FDR 0.10 across every
 * cell of the phase, both modes, both return series (report-schema.ts,
 * survivor-table.ts). Tradability floor for a survivor: maker breakeven IC of
 * the interval (1h 0.0044 single leg, about 0.017 cross-sectional), and the
 * phase closes with no harness run if nothing clears it.
 *
 * - `raw.hourOfDayDrift` (+): trailing 60-day mean of this symbol's one-bar
 *   return over EARLIER bars sharing the same time of day, the bar itself
 *   excluded so no term of its own return enters. Time-series axis only: it
 *   is market-wide by nature and per-bar demeaning would zero it by
 *   construction. The literature says BTC calendar effects are gone
 *   post-2023, so the expected outcome is null; it is cheap enough to test.
 * - `raw.sessionDrift` (+): the same over the five fixed-UTC sessions of
 *   src/lib/sessions.ts, NaN where a session is not meaningful (4h).
 * - `raw.depthNotionalZ` (+, weak, NO SURVIVOR EXPECTED): within-symbol
 *   30-day trailing z of log depthNotional1, the column Stage 1 deferred.
 *   Stage 1 measured the raw level at +0.0248 at 15m h16 with symbol
 *   agreement 0.80 and QUARTER agreement 0.45, the signature of a
 *   non-stationary level; the z removes the drift. A state variable, so a
 *   survivor here is more likely regime than direction.
 * - `raw.ret1InHighTaker` and `raw.ret1InLowTaker` ARE the conditioning
 *   hypothesis, not standalone signals: the one-bar return split by whether
 *   the bar's absolute taker imbalance sits above (z > 0) or at or below its
 *   30-day trailing mean. PREDICTION: both negative (reversal), MORE negative
 *   in the HIGH-intensity subset (arXiv 2608.21888: reversal concentrates
 *   after aggressive taker flow and grows with intensity, while depth
 *   consumed conditions nothing, which agrees with Stage 1). FALSIFICATION,
 *   fixed now: a gap smaller than a third of the unconditional |ic|, or a
 *   deeper LOW subset, means the intensity conditions nothing. Diagnostics
 *   only, never a family: a gated reversal rule would be a third rule shape
 *   on ret1 under the standing ruling.
 * - `raw.btcLeadLag` (+ at h1 to h4 for alts, weaker at 1h than 15m):
 *   BTC's one-bar return minus the equal-weight cross-sectional one-bar
 *   return, read for every non-BTC symbol, NaN for BTC and where fewer than
 *   five symbols have a finite return. Delayed alt reaction to BTC (JEDC
 *   2024; Springer APFM 2026, paywalled, effect sizes unverified). Both axes.
 *
 * DROPPED without a slot: same-symbol spot-to-perp lead-lag (arbitrage
 * closes in milliseconds; the perpSpotSpreadPct artifact family), day-of-week
 * drift (folded into time of day), retail-versus-top-trader spread (both legs
 * measured at 4h and 1d only, same sign).
 *
 * ADDENDUM, 2026-09-26, written after the 4h and 1h time-series runs were read
 * and BEFORE the 15m run was read. Two properties of `raw.btcLeadLag` were
 * found by review, not by measurement, and are ruled on here so they are not
 * decided after a result:
 *
 * - It has NO cross-sectional content by construction: b_t - m_t is the same
 *   number for every non-BTC symbol at a bar, so a per-bar rank across symbols
 *   is undefined. It is measured on the time-series axis only and is dropped
 *   from the cross-sectional pass. (The same reasoning excluded the drift
 *   columns above; the original "both axes" assignment was wrong.)
 * - The market mean m_t includes the read symbol's own ret1 with weight -1/N,
 *   and ret1 reverses at these horizons, so the column carries a positive
 *   own-return term of about +0.002 at 15m and +0.006 at 1h in IC units, the
 *   pre-registered sign. Below the 0.02 floor on its own, but it biases the
 *   sign test. CONTROL, pre-registered now: `raw.btcLeadLagLoo`, BTC's ret1
 *   minus the equal-weight mean over the OTHER alts (the read symbol and BTC
 *   both excluded), NaN for BTC and below five symbols. PREDICTION: same sign
 *   (+), and the gap btcLeadLag - btcLeadLagLoo bounds the contamination at
 *   about the figures above. If btcLeadLag clears the rule anywhere and the
 *   LOO control does not, the survival is the own-return reversal in disguise
 *   and is recorded as such.
 * - Recorded before the 15m read: at 1h btcLeadLag was +0.0219 (h1, t 12.5)
 *   and +0.0187 (h2), failing the two-horizon |ic| leg by 0.0013.
 */
const RAW_NAMES = [
  'raw.rsi',
  'raw.emaSpreadPct',
  'raw.atrPct',
  'raw.fundingRate',
  'raw.longShortRatio',
  'raw.takerBuyRatio',
  'raw.fearGreed',
  'raw.htfTrend',
  'raw.ret1',
  'raw.ret5',
  'raw.ret20',
  'raw.realizedVol20',
  // Archive-only inputs. Before scripts/ops/ingest-archive.ts existed, Binance
  // REST served these for about 30 days, so stored open interest and
  // positioning covered 11.0% of 1h bars and nothing before 2026-03-03.
  'raw.oiChange1',
  'raw.oiChange8',
  'raw.oiPriceDiv',
  'raw.takerLongShortRatio',
  'raw.topTraderPositionRatio',
  'raw.globalAccountRatio',
  'raw.fundingZ',
  'raw.basisPct',
  'raw.perpSpotSpreadPct',
  'raw.depthImbalance1',
  'raw.depthImbalance5',
  'raw.depthNotional1',
  'raw.depthSlope',
  'raw.depthFlow1',
  'raw.varianceRatio',
  'raw.ret1InMeanReversion',
  'raw.ret1InTrend',
  'raw.fundingProximity',
  'raw.hourOfDayDrift',
  'raw.sessionDrift',
  'raw.depthNotionalZ',
  'raw.ret1InHighTaker',
  'raw.ret1InLowTaker',
] as const;

/**
 * Trailing window for the funding z-score, in days rather than bars.
 *
 * Funding settles every 8h, so a bar-count window degenerates at fine
 * intervals: 96 bars at 5m is a single funding period, over which the
 * standard deviation is zero or near it. Thirty days spans about ninety
 * settlements at every interval.
 */
export const FUNDING_Z_DAYS = 30;
/** Finite readings needed before a z-score is emitted rather than NaN. */
export const FUNDING_Z_MIN_SAMPLES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Days of history the time-of-day and session drifts average over, and the readings a bucket needs. */
export const SEASONAL_DRIFT_DAYS = 60;
export const SEASONAL_DRIFT_MIN_SAMPLES = 20;
/** Days in the trailing z of absolute taker imbalance that splits ret1 by intensity. */
export const TAKER_INTENSITY_DAYS = 30;
/** Days and readings for the within-symbol z of log book notional. */
export const DEPTH_NOTIONAL_Z_DAYS = 30;
export const DEPTH_NOTIONAL_Z_MIN_SAMPLES = 30;

/**
 * Trailing z-score of a series, over a window of `windowBars` bars.
 *
 * Running sums, so the cost is one pass regardless of window size: at 5m a
 * thirty-day window is 8,640 bars and a naive recompute per bar would be
 * quadratic over the 800,000-bar dataset.
 *
 * NaN entries take part in neither the mean nor the count, so a gap in the
 * input thins the window instead of poisoning it, and a bar whose own value
 * is NaN stays NaN. A window with no spread returns NaN rather than 0: a
 * constant funding rate has no z-score, and reporting 0 would read as
 * "exactly average" on what is really "no information".
 */
export function trailingZScore(series: Float64Array, windowBars: number, minSamples: number): Float64Array {
  const n = series.length;
  const out = new Float64Array(n).fill(NaN);
  let count = 0;
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < n; i++) {
    const entering = series[i];
    if (Number.isFinite(entering)) {
      count++;
      sum += entering;
      sumSq += entering * entering;
    }

    const leavingIndex = i - windowBars;
    if (leavingIndex >= 0) {
      const leaving = series[leavingIndex];
      if (Number.isFinite(leaving)) {
        count--;
        sum -= leaving;
        sumSq -= leaving * leaving;
      }
    }

    const value = series[i];
    if (!Number.isFinite(value) || count < minSamples) continue;

    const mean = sum / count;
    const meanSq = mean * mean;
    // Sample variance, matching realizedVol20's ddof of 1.
    const variance = (sumSq - count * meanSq) / (count - 1);

    // sumSq and count*meanSq are nearly equal for a near-constant series, so
    // their difference is pure cancellation noise there: a constant funding
    // rate would otherwise get a standard deviation around 1e-12 and a z-score
    // of arbitrary size. Anything at or below the scale of that noise counts as
    // no spread, which is NaN rather than 0: a series that never moves has no
    // z-score, and 0 would read as "exactly average".
    const epsilon = 1e-12 * Math.max(sumSq / count, meanSq, Number.MIN_VALUE);
    if (variance <= epsilon) continue;

    out[i] = (value - mean) / Math.sqrt(variance);
  }

  return out;
}

/**
 * Trailing mean of `series` over EARLIER bars sharing the bar's bucket (time
 * of day, session), inside a window of `windowBars` bars and excluding the
 * bar itself, so the column carries no term of the bar's own return. NaN
 * until the bucket holds `minSamples` finite readings inside the window.
 *
 * One FIFO of bar indices per bucket with a running sum, so the cost is one
 * pass: a per-bar recompute over a 60-day window at 15m would be quadratic.
 */
export function seasonalDriftSeries(
  series: Float64Array,
  bucketOf: (bar: number) => number,
  windowBars: number,
  minSamples: number
): Float64Array {
  const n = series.length;
  const out = new Float64Array(n).fill(NaN);
  const queues = new Map<number, { bars: number[]; head: number; sum: number }>();

  for (let bar = 0; bar < n; bar++) {
    const bucket = bucketOf(bar);
    let q = queues.get(bucket);
    if (!q) {
      q = { bars: [], head: 0, sum: 0 };
      queues.set(bucket, q);
    }
    while (q.head < q.bars.length && q.bars[q.head] < bar - windowBars) {
      q.sum -= series[q.bars[q.head]];
      q.head++;
    }
    const count = q.bars.length - q.head;
    if (count >= minSamples) out[bar] = q.sum / count;

    const v = series[bar];
    if (Number.isFinite(v)) {
      q.bars.push(bar);
      q.sum += v;
    }
  }
  return out;
}

/** Index rows by timestamp for an exact-bar join, never carrying a stale bar forward. */
function byTimestamp<T extends { t: number }>(rows: T[] | null | undefined): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows ?? []) map.set(row.t, row);
  return map;
}

/** Log change of a per-bar series over `lookback` bars, NaN unless both ends are positive. */
function logChange(series: Float64Array, bar: number, lookback: number): number {
  if (bar < lookback) return NaN;
  const now = series[bar];
  const then = series[bar - lookback];
  if (!Number.isFinite(now) || !Number.isFinite(then) || now <= 0 || then <= 0) return NaN;
  return Math.log(now / then);
}

/** Trailing observations the variance ratio is measured over. */
const VR_WINDOW_BARS = 120;

/** Aggregation period q in VR(q). Four bars, so the ratio is sensitive to
 * reversal over roughly the horizons the program's reversal factors act on. */
const VR_Q = 4;

/**
 * Lo and MacKinlay's variance ratio, VR(q) = Var(r_q) / (q * Var(r_1)), over a
 * trailing window.
 *
 * A random walk has independent increments, so the variance of a q-bar return
 * is q times the variance of a one-bar return and the ratio is 1. Above 1 the
 * series trends, because moves persist and compound; below 1 it mean-reverts,
 * because moves partly cancel. It is a REGIME reading rather than a direction,
 * which is a role nothing else here fills: the program's strongest recorded
 * finding is that mean reversion dominates intraday while momentum survives at
 * 4h, and nothing measures which of the two is in force at a given bar.
 *
 * The simple ratio, not Lo and MacKinlay's bias-corrected estimator. The
 * correction matters for testing the null VR = 1; it does not matter for a
 * monotone regime indicator, which is all this is used as.
 *
 * Running sums, so the cost is one pass regardless of window size, the same
 * reason trailingZScore is written that way.
 */
function varianceRatioSeries(candles: CandleRow[], window: number, q: number): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);

  const r1 = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1].c;
    const now = candles[i].c;
    if (prev > 0 && now > 0) r1[i] = Math.log(now / prev);
  }
  const rq = new Float64Array(n).fill(NaN);
  for (let i = q; i < n; i++) {
    const prev = candles[i - q].c;
    const now = candles[i].c;
    if (prev > 0 && now > 0) rq[i] = Math.log(now / prev);
  }

  let sum1 = 0;
  let sumSq1 = 0;
  let count1 = 0;
  let sumQ = 0;
  let sumSqQ = 0;
  let countQ = 0;

  for (let bar = 0; bar < n; bar++) {
    const entering1 = r1[bar];
    if (Number.isFinite(entering1)) {
      sum1 += entering1;
      sumSq1 += entering1 * entering1;
      count1++;
    }
    const enteringQ = rq[bar];
    if (Number.isFinite(enteringQ)) {
      sumQ += enteringQ;
      sumSqQ += enteringQ * enteringQ;
      countQ++;
    }

    const leaving = bar - window;
    if (leaving >= 0) {
      const leaving1 = r1[leaving];
      if (Number.isFinite(leaving1)) {
        sum1 -= leaving1;
        sumSq1 -= leaving1 * leaving1;
        count1--;
      }
      const leavingQ = rq[leaving];
      if (Number.isFinite(leavingQ)) {
        sumQ -= leavingQ;
        sumSqQ -= leavingQ * leavingQ;
        countQ--;
      }
    }

    // A full window of both series must exist before the ratio means anything.
    if (bar < window + q || count1 < 2 || countQ < 2) continue;

    const mean1 = sum1 / count1;
    const variance1 = sumSq1 / count1 - mean1 * mean1;
    if (!(variance1 > 0)) continue;
    const meanQ = sumQ / countQ;
    const varianceQ = Math.max(0, sumSqQ / countQ - meanQ * meanQ);

    out[bar] = varianceQ / (q * variance1);
  }

  return out;
}

/**
 * Change in signed book depth over one bar, scaled by current depth.
 *
 * The banded analogue of order-flow imbalance (Cont, Kukanov and Stoikov 2014),
 * whose result is that price changes are approximately linear in flow scaled by
 * depth. True OFI needs best-quote updates, which do not exist for UM futures
 * (`bookTicker` serves no files), so this is explicitly a banded proxy.
 *
 * No reconstruction of each side is needed. With `N` the notional on both sides
 * and `I` the imbalance, `bid - ask = N * I` identically, so
 * `(B_t - B_{t-1}) - (A_t - A_{t-1})` collapses to `N_t*I_t - N_{t-1}*I_{t-1}`.
 *
 * One documented approximation: `depthNotional1` and `depthImbalance1` are each
 * a mean over the 5m slot's snapshots, so their product is not the mean of the
 * product unless the sum and the ratio are uncorrelated within the slot.
 * `depthSamples` records the snapshot count if that ever needs auditing.
 */
function depthFlow(signed: Float64Array, notional: Float64Array, bar: number): number {
  if (bar < 1) return NaN;
  const now = signed[bar];
  const then = signed[bar - 1];
  const scale = notional[bar];
  if (!Number.isFinite(now) || !Number.isFinite(then) || !Number.isFinite(scale) || scale <= 0) {
    return NaN;
  }
  return (now - then) / scale;
}

/** -1, 0 or 1; NaN propagates so a missing input never reads as "no divergence". */
function signOf(value: number): number {
  if (!Number.isFinite(value)) return NaN;
  return Math.sign(value);
}

function simpleReturn(candles: CandleRow[], bar: number, lookback: number): number {
  if (bar < lookback) return NaN;
  const prev = candles[bar - lookback].c;
  return (candles[bar].c - prev) / prev;
}

function realizedVol20(candles: CandleRow[], bar: number): number {
  if (bar < 20) return NaN;
  const logReturns: number[] = [];
  for (let k = bar - 19; k <= bar; k++) {
    logReturns.push(Math.log(candles[k].c / candles[k - 1].c));
  }
  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance);
}

/**
 * Whether a category has no real input to score, matching what actually
 * determines `component.score` rather than the displayed `signals` list.
 * scoreVolatility (src/lib/signals/scorer.ts) excludes ATR -- a volatility
 * regime reading, not a directional signal -- from the score it computes,
 * but still lists ATR in `signals`, so volatility needs the same exclusion
 * here or a bar with only ATR would read as "has data" when it has none.
 */
function isCategoryDataMissing(component: SignalComponent): boolean {
  if (component.category === 'volatility') {
    return component.signals.filter((s) => s.name !== 'ATR').length === 0;
  }
  return component.signals.length === 0;
}

export function computeFactorMatrix(input: FactorMatrixInput): FactorMatrix {
  const { candles, snapshots, htf, interval, metrics, perp, premiumIndex } = input;
  const style = styleForInterval(interval);
  const profile = getStyleConfig(style);
  const weights = DEFAULT_TEMPLATE_WEIGHTS[style];

  // htf must be index-aligned with candles (one row per candle, same
  // timestamp) -- everything below reads htf[bar] positionally assuming
  // that invariant. A silent misalignment would attribute the wrong HTF
  // context to a bar without any error, so it is checked here rather than
  // trusted from the caller.
  if (htf.length !== candles.length) {
    throw new Error(
      `computeFactorMatrix: htf has ${htf.length} rows but candles has ${candles.length}`
    );
  }
  for (let i = 0; i < candles.length; i++) {
    if (htf[i].t !== candles[i].t) {
      throw new Error(
        `computeFactorMatrix: htf[${i}].t (${htf[i].t}) does not match candles[${i}].t (${candles[i].t})`
      );
    }
  }

  const ohlcv = candles.map(toOHLCV);
  const leanSnapshots = snapshots ? snapshots.map(toLeanSnapshot) : undefined;

  // No htfInput: HTF context is already precomputed per bar in `htf` (C1's export),
  // computed the same causal way (computeHtfSeries + alignHtfToLtf + htfContextAtBar).
  const prepared = prepareBacktest(ohlcv, '', interval, profile.config, leanSnapshots);
  const { indicators, superTrend, warmupBars, stOffset, snapshots: alignedSnapshots } = prepared;

  const n = candles.length;

  // One composite per bar, exactly as the optimized engine scores a bar --
  // same suite, snapshot inputs, SuperTrend, and HTF context -- but with the
  // style's DEFAULT_TEMPLATE_WEIGHTS rather than a BacktestConfig's weights.
  // Bars before warmupBars are never read below (every consumer starts its
  // own loop at warmupBars), so scoring them is discarded work skipped here.
  const composites: ReturnType<typeof computeSignalScore>[] = new Array(n);
  for (let bar = warmupBars; bar < n; bar++) {
    const suite = indicators[bar];
    const scoringSuite = style === 'scalping' ? excludeIchimokuForScalping(suite) : suite;
    const snap = alignedSnapshots?.[bar] ?? null;
    const htfCtx = htf[bar]?.context ?? null;

    const stIdx = bar - stOffset;
    const superTrendAtBar = stIdx >= 0 && stIdx < superTrend.length ? superTrend[stIdx] : undefined;

    composites[bar] = computeSignalScore(
      scoringSuite,
      snap?.futures ?? null,
      snap?.sentiment ?? null,
      weights,
      superTrendAtBar ? { values: superTrend, current: superTrendAtBar } : null,
      htfCtx
    );
  }

  // Discover every sig.<name> that fires on any post-warmup bar, in first-seen
  // order (category order, then encounter order within a category). Names
  // that never fire for this style/interval/data combination are simply
  // absent, rather than a column that is NaN for the whole series.
  const sigOrder: string[] = [];
  const sigCategory = new Map<string, string>();
  for (let bar = warmupBars; bar < n; bar++) {
    for (const component of composites[bar].components) {
      for (const sig of component.signals) {
        if (!sigCategory.has(sig.name)) {
          sigCategory.set(sig.name, component.category);
          sigOrder.push(sig.name);
        }
      }
    }
  }

  const names: string[] = [
    'composite',
    ...CATEGORY_ORDER.map((c) => `cat.${c}`),
    ...sigOrder.map((s) => `sig.${s}`),
    ...RAW_NAMES,
  ];
  const categories: string[] = [
    'composite',
    ...CATEGORY_ORDER,
    ...sigOrder.map((s) => sigCategory.get(s)!),
    ...RAW_NAMES.map(() => 'raw'),
  ];

  const values: Float64Array[] = names.map(() => new Float64Array(n).fill(NaN));
  const nameIndex = new Map<string, number>(names.map((name, i) => [name, i]));

  const compositeIdx = nameIndex.get('composite')!;
  const catIdx = new Map(CATEGORY_ORDER.map((c) => [c, nameIndex.get(`cat.${c}`)!]));
  const sigIdx = new Map(sigOrder.map((s) => [s, nameIndex.get(`sig.${s}`)!]));
  const rawIdx = new Map(RAW_NAMES.map((r) => [r, nameIndex.get(r)!]));

  // Archive inputs, aligned to these bars.
  //
  // The metrics grid is 5m native, so it is joined with the last reading at or
  // before each bar's CLOSE, not its open. A factor is read at the bar's close
  // (forwardReturns measures from closes[bar] onward), so a reading from
  // inside the bar is already published by the time the factor is used, and
  // taking the open instead would throw away most of an hour of information at
  // 1h. This is deliberately not the rule src/lib/backtest/snapshot-series.ts
  // applies to HistoricalSnapshot rows, which is pinned to the bar's open
  // because live snapshot ingestion runs on its own cron.
  const intervalMs = intervalToMs(interval);
  const barCloses = candles.map((candle) => candle.t + intervalMs - 1);
  const metricsStaleness = Math.max(intervalMs, 2 * METRICS_SLOT_MS);
  const alignedMetrics = metrics && metrics.length > 0
    ? alignToBars(barCloses, metrics.map((row) => ({ ...row, timestamp: row.t })), metricsStaleness)
    : null;

  // Perpetual bars share the candle grid, so they join on an exact timestamp
  // match: a missing perp bar is NaN, never the previous bar's price.
  const perpByTime = byTimestamp(perp);
  const premiumByTime = byTimestamp(premiumIndex);

  // Open interest per bar, needed as a series before its changes can be taken.
  const openInterestSeries = new Float64Array(n).fill(NaN);
  if (alignedMetrics) {
    for (let bar = 0; bar < n; bar++) {
      openInterestSeries[bar] = alignedMetrics[bar]?.openInterest ?? NaN;
    }
  }

  // Book depth per bar, needed as series before a change can be taken. `signed`
  // is bid minus ask, which is the notional times the imbalance.
  const depthNotionalSeries = new Float64Array(n).fill(NaN);
  const signedDepthSeries = new Float64Array(n).fill(NaN);
  if (alignedMetrics) {
    for (let bar = 0; bar < n; bar++) {
      const notional = alignedMetrics[bar]?.depthNotional1;
      const imbalance = alignedMetrics[bar]?.depthImbalance1;
      if (typeof notional === 'number' && Number.isFinite(notional)) {
        depthNotionalSeries[bar] = notional;
        if (typeof imbalance === 'number' && Number.isFinite(imbalance)) {
          signedDepthSeries[bar] = notional * imbalance;
        }
      }
    }
  }

  const varianceRatio = varianceRatioSeries(candles, VR_WINDOW_BARS, VR_Q);

  const fundingSeries = new Float64Array(n).fill(NaN);
  for (let bar = warmupBars; bar < n; bar++) {
    fundingSeries[bar] = alignedSnapshots?.[bar]?.futures?.fundingRate?.fundingRate ?? NaN;
  }
  const fundingZ = trailingZScore(
    fundingSeries,
    Math.max(1, Math.ceil((FUNDING_Z_DAYS * DAY_MS) / intervalMs)),
    FUNDING_Z_MIN_SAMPLES
  );

  const daysToBars = (days: number) => Math.max(1, Math.ceil((days * DAY_MS) / intervalMs));

  const ret1Series = new Float64Array(n).fill(NaN);
  for (let bar = 0; bar < n; bar++) ret1Series[bar] = simpleReturn(candles, bar, 1);

  // Time of day as a bucket index: 96 quarter-hours at 15m, 24 at 1h, 6 at 4h.
  // At 1d (and coarser) every bar falls in the one bucket, so the column would
  // be a trailing 60-day mean return with no time-of-day content at all. NaN
  // throughout there, the same way sessionDrift is NaN off-session, rather than
  // a differently-named momentum column.
  const hourOfDayDrift =
    DAY_MS / intervalMs > 1
      ? seasonalDriftSeries(
          ret1Series,
          (bar) => Math.floor((candles[bar].t % DAY_MS) / intervalMs),
          daysToBars(SEASONAL_DRIFT_DAYS),
          SEASONAL_DRIFT_MIN_SAMPLES
        )
      : new Float64Array(n).fill(NaN);
  const sessionDrift = isSessionMeaningful(interval)
    ? seasonalDriftSeries(
        ret1Series,
        (bar) => MARKET_SESSIONS.indexOf(sessionOfCandleClose(candles[bar].t, intervalMs)),
        daysToBars(SEASONAL_DRIFT_DAYS),
        SEASONAL_DRIFT_MIN_SAMPLES
      )
    : new Float64Array(n).fill(NaN);

  // Matches fundingSeries above: only counted from warmupBars, so a state
  // variable available since bar 0 in the raw archive does not make the
  // z-score's own ramp-up (minSamples readings) invisible by borrowing
  // pre-warmup history nothing else here reads either.
  const logNotional = new Float64Array(n).fill(NaN);
  for (let bar = warmupBars; bar < n; bar++) {
    const v = depthNotionalSeries[bar];
    if (Number.isFinite(v) && v > 0) logNotional[bar] = Math.log(v);
  }
  const depthNotionalZ = trailingZScore(logNotional, daysToBars(DEPTH_NOTIONAL_Z_DAYS), DEPTH_NOTIONAL_Z_MIN_SAMPLES);

  const takerIntensity = new Float64Array(n).fill(NaN);
  for (let bar = 0; bar < n; bar++) {
    const c = candles[bar];
    if (c.tbv !== null && c.v > 0) takerIntensity[bar] = Math.abs((2 * c.tbv) / c.v - 1);
  }
  const takerIntensityZ = trailingZScore(takerIntensity, daysToBars(TAKER_INTENSITY_DAYS), FUNDING_Z_MIN_SAMPLES);

  for (let bar = warmupBars; bar < n; bar++) {
    const composite = composites[bar];
    values[compositeIdx][bar] = composite.score;

    for (const component of composite.components) {
      const idx = catIdx.get(component.category);
      if (idx !== undefined) {
        // Missing input (no futures/sentiment/htf data at this bar) -> NaN,
        // not the scorer's internal 0-for-redistribution default.
        values[idx][bar] = isCategoryDataMissing(component) ? NaN : component.score;
      }

      for (const sig of component.signals) {
        const sIdx = sigIdx.get(sig.name);
        if (sIdx !== undefined) {
          const multiplier = sig.direction === 'bullish' ? 1 : sig.direction === 'bearish' ? -1 : 0;
          values[sIdx][bar] = multiplier * sig.strength;
        }
      }
    }

    const suite = indicators[bar];
    const candle = candles[bar];
    const snap = alignedSnapshots?.[bar] ?? null;
    const htfCtx = htf[bar]?.context ?? null;

    values[rawIdx.get('raw.rsi')!][bar] = suite.rsi.current;
    values[rawIdx.get('raw.emaSpreadPct')!][bar] =
      ((suite.ema12.current - suite.ema26.current) / suite.ema26.current) * 100;
    values[rawIdx.get('raw.atrPct')!][bar] = (suite.atr.current / candle.c) * 100;
    values[rawIdx.get('raw.fundingRate')!][bar] = snap?.futures?.fundingRate?.fundingRate ?? NaN;
    values[rawIdx.get('raw.longShortRatio')!][bar] =
      snap?.futures?.longShortRatio?.longShortRatio ?? NaN;
    values[rawIdx.get('raw.takerBuyRatio')!][bar] =
      candle.tbv !== null && candle.v !== 0 ? candle.tbv / candle.v : NaN;
    values[rawIdx.get('raw.fearGreed')!][bar] = snap?.sentiment?.fearGreedIndex ?? NaN;
    // A null context is a missing input (no confirmation interval, e.g. 1d,
    // or the HTF's own warmup not yet satisfied) -> NaN, distinct from a
    // real 'neutral' trend reading, which is 0.
    values[rawIdx.get('raw.htfTrend')!][bar] = !htfCtx
      ? NaN
      : htfCtx.trendDirection === 'bullish'
        ? 1
        : htfCtx.trendDirection === 'bearish'
          ? -1
          : 0;
    values[rawIdx.get('raw.ret1')!][bar] = simpleReturn(candles, bar, 1);
    values[rawIdx.get('raw.ret5')!][bar] = simpleReturn(candles, bar, 5);
    values[rawIdx.get('raw.ret20')!][bar] = simpleReturn(candles, bar, 20);
    values[rawIdx.get('raw.realizedVol20')!][bar] = realizedVol20(candles, bar);

    const metric = alignedMetrics?.[bar] ?? null;
    const oiChange1 = logChange(openInterestSeries, bar, 1);
    values[rawIdx.get('raw.oiChange1')!][bar] = oiChange1;
    values[rawIdx.get('raw.oiChange8')!][bar] = logChange(openInterestSeries, bar, 8);
    // Positions building into a move against positions covering out of one.
    // NaN in either leg propagates, so "no divergence" is never inferred from
    // a missing reading.
    values[rawIdx.get('raw.oiPriceDiv')!][bar] =
      signOf(oiChange1) * signOf(simpleReturn(candles, bar, 1));
    values[rawIdx.get('raw.takerLongShortRatio')!][bar] = metric?.takerLongShortRatio ?? NaN;
    values[rawIdx.get('raw.topTraderPositionRatio')!][bar] = metric?.topTraderPositionRatio ?? NaN;
    values[rawIdx.get('raw.globalAccountRatio')!][bar] = metric?.globalAccountRatio ?? NaN;
    values[rawIdx.get('raw.depthImbalance1')!][bar] = metric?.depthImbalance1 ?? NaN;
    values[rawIdx.get('raw.depthImbalance5')!][bar] = metric?.depthImbalance5 ?? NaN;
    values[rawIdx.get('raw.depthNotional1')!][bar] = metric?.depthNotional1 ?? NaN;
    // How much thicker the book is out at 5% than at 1%: where liquidity sits
    // is a direct expected-slippage reading, and nothing else here measures it.
    const notional1 = metric?.depthNotional1;
    const notional5 = metric?.depthNotional5;
    values[rawIdx.get('raw.depthSlope')!][bar] =
      typeof notional1 === 'number' &&
      typeof notional5 === 'number' &&
      Number.isFinite(notional1) &&
      Number.isFinite(notional5) &&
      notional1 > 0
        ? (notional5 - notional1) / notional1
        : NaN;
    values[rawIdx.get('raw.depthFlow1')!][bar] = depthFlow(
      signedDepthSeries,
      depthNotionalSeries,
      bar
    );

    const vr = varianceRatio[bar];
    values[rawIdx.get('raw.varianceRatio')!][bar] = vr;
    // The same one-bar return, split by the regime the bar sits in. Comparing
    // the two ICs is the actual test of whether the ratio conditions anything:
    // a raw IC of the ratio itself would ask whether the regime predicts
    // direction, which is not the hypothesis.
    const ret1ForRegime = simpleReturn(candles, bar, 1);
    const regimeKnown = Number.isFinite(vr) && Number.isFinite(ret1ForRegime);
    values[rawIdx.get('raw.ret1InMeanReversion')!][bar] =
      regimeKnown && vr < 1 ? ret1ForRegime : NaN;
    values[rawIdx.get('raw.ret1InTrend')!][bar] = regimeKnown && vr >= 1 ? ret1ForRegime : NaN;

    // Funding settles on a known 8h clock, so a bar's distance from the next
    // settlement is an EVENT-time coordinate. Everything else here is measured
    // in clock time or bar count. Weighting the rate by proximity asks whether
    // crowded positioning unwinds into the settlement it is about to pay.
    const fundingNow = snap?.futures?.fundingRate?.fundingRate;
    if (typeof fundingNow === 'number' && Number.isFinite(fundingNow)) {
      const barClose = candle.t + intervalMs - 1;
      const nextSettlement = Math.ceil(barClose / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
      const proximity = 1 - (nextSettlement - barClose) / FUNDING_INTERVAL_MS;
      values[rawIdx.get('raw.fundingProximity')!][bar] = fundingNow * proximity;
    } else {
      values[rawIdx.get('raw.fundingProximity')!][bar] = NaN;
    }

    values[rawIdx.get('raw.hourOfDayDrift')!][bar] = hourOfDayDrift[bar];
    values[rawIdx.get('raw.sessionDrift')!][bar] = sessionDrift[bar];
    values[rawIdx.get('raw.depthNotionalZ')!][bar] = depthNotionalZ[bar];
    // The one-bar return split by taker intensity: the pair is the
    // conditioning test, never a signal on its own (see the pre-registration).
    const r1 = ret1Series[bar];
    const tz = takerIntensityZ[bar];
    const intensityKnown = Number.isFinite(tz) && Number.isFinite(r1);
    values[rawIdx.get('raw.ret1InHighTaker')!][bar] = intensityKnown && tz > 0 ? r1 : NaN;
    values[rawIdx.get('raw.ret1InLowTaker')!][bar] = intensityKnown && tz <= 0 ? r1 : NaN;

    values[rawIdx.get('raw.fundingZ')!][bar] = fundingZ[bar];

    // The premium index close is the perp-to-index premium as a fraction.
    const premiumBar = premiumByTime.get(candle.t);
    values[rawIdx.get('raw.basisPct')!][bar] = premiumBar ? premiumBar.c * 100 : NaN;

    // What the venue mismatch is worth at this bar: candles/ holds SPOT closes
    // while every backtest charges perpetual costs.
    const perpBar = perpByTime.get(candle.t);
    values[rawIdx.get('raw.perpSpotSpreadPct')!][bar] =
      perpBar && candle.c !== 0 ? ((perpBar.c - candle.c) / candle.c) * 100 : NaN;
  }

  return {
    names,
    categories,
    values,
    warmupBars,
    timestamps: candles.map((c) => c.t),
    closes: candles.map((c) => c.c),
    perpCloses: candles.map((c) => perpByTime.get(c.t)?.c ?? NaN),
  };
}
