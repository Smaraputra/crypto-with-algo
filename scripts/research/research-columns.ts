/**
 * Producer for the research-only per-bar columns a `Strategy` reads through
 * `ctx.research` (src/lib/backtest/research-series.ts). Pure, no I/O: the
 * harness supplies loaded rows and this module shapes them.
 *
 * WHY THE COLUMNS ARE BUILT HERE AND NOT IN A FAMILY
 *
 * Every column below is a trailing window over the candle series. The
 * walk-forward prepares each window from a SLICE, so a family deriving its own
 * trailing window gets the full window in-sample and a truncated one
 * out-of-sample, and the same grid cell then labels two different factors.
 * Measured on Phase 4b: at 1d a 720-bar window could not be realised at all in
 * a 612-bar test slice, and 5 of 38 selected symbol-windows chose exactly that
 * cell. Building the columns once over the FULL series removes the problem:
 * `buildResearchSeries` then merely selects a sub-range.
 *
 * THE CAUSALITY RULE, AND WHY TWO SOURCES ARE TREATED DIFFERENTLY
 *
 * `ResearchRow` promises that the value at a candle was observable at or
 * before that candle's OPEN. The two sources reach that promise differently:
 *
 * - Snapshot-derived columns (funding, positioning) come from
 *   `buildSnapshotSeries`, which pins each candle to the latest snapshot whose
 *   whole capture window closed at or before the candle's open. No shift here,
 *   because the shift lives in that function. It used to read a snapshot
 *   stamped at the candle's own open, which the ingest cron fills with data
 *   captured up to one interval LATER; that was 45 minutes of lookahead at 1h.
 *
 * - Metric-derived columns (order-book depth) come from a 5m grid that
 *   `factors.ts` joins to each bar's CLOSE, because a factor there is read at
 *   the close the forward return measures from. Reading a close-aligned value
 *   and filling at that same close is execution lag 0, and the surviving
 *   depth cells are lag-1 cells. So these columns are computed on the
 *   factors.ts rule and then SHIFTED FORWARD ONE BAR: index `i` carries the
 *   reading aligned to close[i-1], which is both observable before open[i] and
 *   exactly the lag-1 relationship the IC reports. The shift is what makes the
 *   backtest test the cell that survived, without touching the fill model.
 *
 * - Price/volume-derived columns (vwapDevZ, pocDist, outsideValue,
 *   sweepReversal20, sweepReversal50, bosBreak, volRatio, btcLeadLagZ), added
 *   for the Reddit-derived exploration families, follow the SAME rule as the
 *   metric-derived columns and for the same reason: every one of them reads
 *   the bar's own close, directly or through a same-bar return, so each is
 *   computed close-aligned first and then SHIFTED FORWARD ONE BAR via
 *   `shiftForwardOneBar`, so a family acting at bar i's close reads what was
 *   knowable at the previous close. All eight are shifted; none is exempt.
 */

import type { OHLCV } from '@/types/market';
import type { LeanSnapshot } from '@/lib/backtest/snapshot-series';
import { buildSnapshotSeries } from '@/lib/backtest/snapshot-series';
import type { ResearchRow } from '@/lib/backtest/research-series';
import { alignToBars, METRICS_SLOT_MS } from '@/lib/archive-ingestion';
import { intervalToMs } from '@/lib/intervals';
import { trailingZScore, FUNDING_Z_MIN_SAMPLES } from './factors';
import type { CandleRow, MetricsRow } from './dataset-format';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Trailing windows offered to the funding family, in days. One column each. */
export const FUNDING_Z_WINDOW_DAYS = [15, 30, 60] as const;
/** Trailing windows offered to the depth family, in days. */
export const DEPTH_Z_WINDOW_DAYS = [30, 90] as const;
/** Trailing windows offered to the positioning families, in BARS.
 * Bars rather than days, so the existing Phase 4b grid keeps its meaning and
 * the re-run is comparable to the recorded table. */
export const POSITIONING_Z_WINDOW_BARS = [180, 360, 720] as const;

/** Readings needed before a z is emitted, for the non-funding columns.
 * Exported so a caller building an expected value for one of the new
 * price/volume columns (research-columns.test.ts) can reproduce the exact
 * same trailingZScore call this module makes. */
export const Z_MIN_SAMPLES = 30;

/** Trailing window, in days, for vwapDevZ's and btcLeadLagZ's z-score. */
export const NEW_COLUMN_Z_DAYS = 30;

export const fundingColumn = (days: number) => `fundingZ${days}d`;
export const depthColumn = (days: number) => `depthZ${days}d`;
export const positioningColumn = (bars: number) => `positioningZ${bars}`;

/** Every column name this module can produce, for the report and for a
 * family's `requiresResearchColumns` declaration. */
export const RESEARCH_COLUMNS: readonly string[] = [
  ...FUNDING_Z_WINDOW_DAYS.map(fundingColumn),
  ...DEPTH_Z_WINDOW_DAYS.map(depthColumn),
  ...POSITIONING_Z_WINDOW_BARS.map(positioningColumn),
  'vwapDevZ',
  'pocDist',
  'outsideValue',
  'sweepReversal20',
  'sweepReversal50',
  'bosBreak',
  'volRatio',
  'btcLeadLagZ',
];

export interface ResearchColumnInput {
  candles: OHLCV[];
  /** The symbol's full snapshot rows, as the harness already loads them. */
  snapshots: LeanSnapshot[];
  /** The symbol's 5m metrics rows. Empty when the dataset has no metrics. */
  metrics: MetricsRow[];
  interval: string;
  symbol: string;
  /**
   * Indicator warmup for this symbol's full series.
   *
   * factors.ts fills every raw series only from `warmupBars` onward, so the
   * trailing windows it feeds trailingZScore start there too. A column that
   * filled from bar 0 would carry a different z on every bar whose window
   * still overlapped the warmup region -- measured at 1h with a 30-day
   * window, the two disagree by more than 0.6 sd around bar 228 -- and would
   * therefore not be the factor the IC was computed on. Masking here is what
   * makes `fundingZ30d` reproduce `raw.fundingZ` exactly.
   */
  warmupBars: number;
  /**
   * BTCUSDT's candles at this same interval, for btcLeadLagZ. Optional: null
   * or absent means btcLeadLagZ is NaN for the whole series (see
   * strategy-harness.ts, which loads this once per run and logs when the
   * dataset has no BTCUSDT candles at the requested interval).
   */
  marketCandles?: CandleRow[] | null;
}

/** Days to bars at this interval, the same conversion factors.ts applies to
 * FUNDING_Z_DAYS. Floored at one bar. */
export function windowBarsForDays(days: number, interval: string): number {
  return Math.max(1, Math.ceil((days * DAY_MS) / intervalToMs(interval)));
}

/** Shift a column forward one bar, so index i carries index i-1's value.
 * Index 0 becomes NaN: there is no earlier bar to have observed. */
function shiftForwardOneBar(series: Float64Array): Float64Array {
  const out = new Float64Array(series.length).fill(Number.NaN);
  for (let i = 1; i < series.length; i++) out[i] = series[i - 1];
  return out;
}

/** Hours to bars at this interval, expressed through `windowBarsForDays`
 * (24h = 1 day, 168h = 7 days) so both conversions share one floor-and-ceil
 * rule rather than two independently-rounded ones. */
function hoursToBars(hours: number, interval: string): number {
  return windowBarsForDays(hours / 24, interval);
}

// ---------------------------------------------------------------------------
// vwapDevZ: cumulative UTC-day VWAP deviation, 30-day trailing z.
// ---------------------------------------------------------------------------

/** Deviation of close from the cumulative UTC-day VWAP, computed through
 * bar i and reset at every UTC day boundary (`day = floor(t / DAY_MS)`).
 * NaN before `warmupBars` and on the first bar of a day whose cumulative
 * volume is still zero. */
function computeVwapDevRaw(candles: OHLCV[], warmupBars: number): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);
  let day = NaN;
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < n; i++) {
    const candle = candles[i];
    const thisDay = Math.floor(candle.timestamp / DAY_MS);
    if (thisDay !== day) {
      day = thisDay;
      cumPV = 0;
      cumV = 0;
    }
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumPV += typicalPrice * candle.volume;
    cumV += candle.volume;
    if (i >= warmupBars && cumV > 0) {
      const vwap = cumPV / cumV;
      out[i] = (candle.close - vwap) / vwap;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// pocDist / outsideValue: prior UTC-day volume-at-price profile.
// ---------------------------------------------------------------------------

/** log-price bucket width, 0.1%: bucket(p) = floor(log(p) / log(1.001)). */
const POC_LOG_FACTOR = Math.log(1.001);
/** Share of a day's volume the value area must cover. */
const POC_VALUE_AREA_SHARE = 0.7;
/** A prior day needs at least this many bars before its profile is trusted. */
const POC_MIN_PRIOR_DAY_BARS = 6;

function pocBucketOf(price: number): number {
  return Math.floor(Math.log(price) / POC_LOG_FACTOR);
}

/** The lower price edge of a bucket; the bucket spans [edge(b), edge(b+1)). */
function pocBucketEdge(bucket: number): number {
  return Math.exp(bucket * POC_LOG_FACTOR);
}

interface DayProfile {
  poc: number;
  vah: number;
  val: number;
}

/**
 * Volume-at-price profile built from exactly the given bar indices (one
 * UTC day's worth, and never the day being scored): each bar's volume is
 * spread uniformly over the log-price buckets its [low, high] spans. POC is
 * the modal bucket's mid price. The value area starts at the POC bucket and
 * expands one bucket at a time toward whichever open neighbour (above or
 * below the current area) carries more volume, until at least 70% of the
 * day's volume is inside; VAH/VAL are that area's top/bottom bucket edges.
 * Returns null when the bars carry no usable volume at all.
 */
function buildDayProfile(candles: OHLCV[], indices: number[]): DayProfile | null {
  const buckets = new Map<number, number>();
  let total = 0;
  for (const i of indices) {
    const { high, low, volume } = candles[i];
    if (!(high > 0) || !(low > 0) || high < low || !(volume > 0)) continue;
    const lo = pocBucketOf(low);
    const hi = pocBucketOf(high);
    const count = hi - lo + 1;
    const perBucket = volume / count;
    for (let b = lo; b <= hi; b++) {
      buckets.set(b, (buckets.get(b) ?? 0) + perBucket);
    }
    total += volume;
  }
  if (buckets.size === 0 || total <= 0) return null;

  const bucketNums = [...buckets.keys()].sort((a, b) => a - b);
  let pocBucket = bucketNums[0];
  let pocVolume = buckets.get(pocBucket)!;
  for (const b of bucketNums) {
    const v = buckets.get(b)!;
    if (v > pocVolume) {
      pocVolume = v;
      pocBucket = b;
    }
  }

  const minBucket = bucketNums[0];
  const maxBucket = bucketNums[bucketNums.length - 1];
  let top = pocBucket;
  let bottom = pocBucket;
  let covered = pocVolume;
  const target = total * POC_VALUE_AREA_SHARE;
  // Including every bucket from minBucket to maxBucket covers `total`
  // volume, which is always >= target, so this always terminates.
  while (covered < target && (top < maxBucket || bottom > minBucket)) {
    const aboveVolume = top < maxBucket ? (buckets.get(top + 1) ?? 0) : -1;
    const belowVolume = bottom > minBucket ? (buckets.get(bottom - 1) ?? 0) : -1;
    if (aboveVolume >= belowVolume) {
      top += 1;
      covered += Math.max(aboveVolume, 0);
    } else {
      bottom -= 1;
      covered += Math.max(belowVolume, 0);
    }
  }

  return {
    poc: (pocBucketEdge(pocBucket) + pocBucketEdge(pocBucket + 1)) / 2,
    vah: pocBucketEdge(top + 1),
    val: pocBucketEdge(bottom),
  };
}

/**
 * pocDist and outsideValue: bar i on UTC day d reads ONLY day (d-1)'s
 * volume profile, built exclusively from day (d-1)'s own bars -- day d's
 * bars never enter it. NaN when day (d-1) is missing entirely (including
 * the series' first day), has fewer than `POC_MIN_PRIOR_DAY_BARS` bars, or
 * has zero high-low range; this also covers 1d, where a "day" is one bar
 * and every prior day therefore has exactly one bar.
 */
function computePocAndOutsideValueRaw(
  candles: OHLCV[],
  warmupBars: number
): { pocDist: Float64Array; outsideValue: Float64Array } {
  const n = candles.length;
  const pocDist = new Float64Array(n).fill(NaN);
  const outsideValue = new Float64Array(n).fill(NaN);

  const dayIndices = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const day = Math.floor(candles[i].timestamp / DAY_MS);
    let list = dayIndices.get(day);
    if (!list) {
      list = [];
      dayIndices.set(day, list);
    }
    list.push(i);
  }

  const profileCache = new Map<number, DayProfile | null>();
  const rangeCache = new Map<number, number>();

  for (let i = warmupBars; i < n; i++) {
    const day = Math.floor(candles[i].timestamp / DAY_MS);
    const prevDay = day - 1;
    const prevIndices = dayIndices.get(prevDay);
    if (!prevIndices || prevIndices.length < POC_MIN_PRIOR_DAY_BARS) continue;

    let profile = profileCache.get(prevDay);
    if (profile === undefined) {
      profile = buildDayProfile(candles, prevIndices);
      profileCache.set(prevDay, profile);
    }
    if (!profile) continue;

    let range = rangeCache.get(prevDay);
    if (range === undefined) {
      let hi = -Infinity;
      let lo = Infinity;
      for (const idx of prevIndices) {
        if (candles[idx].high > hi) hi = candles[idx].high;
        if (candles[idx].low < lo) lo = candles[idx].low;
      }
      range = hi - lo;
      rangeCache.set(prevDay, range);
    }
    if (!(range > 0)) continue;

    const close = candles[i].close;
    pocDist[i] = (close - profile.poc) / range;
    outsideValue[i] = close > profile.vah ? 1 : close < profile.val ? -1 : 0;
  }

  return { pocDist, outsideValue };
}

// ---------------------------------------------------------------------------
// sweepReversal20 / sweepReversal50: liquidity sweep and reclaim.
// ---------------------------------------------------------------------------

/**
 * +1 when bar i sweeps below the trailing `windowBars`-bar low and closes
 * back above it, -1 mirrored on the trailing high, the two summed (an
 * outside bar satisfying both nets 0). NaN for i < windowBars.
 */
function computeSweepReversalRaw(candles: OHLCV[], windowBars: number, warmupBars: number): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = Math.max(windowBars, warmupBars); i < n; i++) {
    let priorLow = Infinity;
    let priorHigh = -Infinity;
    for (let k = i - windowBars; k < i; k++) {
      if (candles[k].low < priorLow) priorLow = candles[k].low;
      if (candles[k].high > priorHigh) priorHigh = candles[k].high;
    }
    const bar = candles[i];
    let value = 0;
    if (bar.low < priorLow && bar.close > priorLow) value += 1;
    if (bar.high > priorHigh && bar.close < priorHigh) value -= 1;
    out[i] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// bosBreak: confirmed swing break of structure.
// ---------------------------------------------------------------------------

/**
 * bosBreak[i]: +1 the bar the close first crosses above the most recently
 * CONFIRMED swing high as of bar i-1, -1 mirrored for the swing low, 0 on
 * every other bar once at least one swing (either side) is known, NaN
 * before the first confirmed swing.
 *
 * A swing high at bar j is `high[j]` strictly above the highs of the two
 * bars on each side (j-2, j-1, j+1, j+2); it is CONFIRMED, i.e. usable,
 * only once bars j+1 and j+2 have both closed, so it first appears in
 * "as of bar i-1" for i-1 >= j+2. Swing low mirrors this on lows. "First
 * crosses above" means the close at i-1 was not already above the same
 * level (so the column fires once per break, not on every bar the close
 * stays through it).
 */
function computeBosBreakRaw(candles: OHLCV[], warmupBars: number): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < 5) return out;

  const confirmedHighAt = new Float64Array(n).fill(NaN);
  const confirmedLowAt = new Float64Array(n).fill(NaN);
  for (let j = 2; j <= n - 3; j++) {
    const h = candles[j].high;
    if (
      h > candles[j - 2].high &&
      h > candles[j - 1].high &&
      h > candles[j + 1].high &&
      h > candles[j + 2].high
    ) {
      confirmedHighAt[j + 2] = h;
    }
    const l = candles[j].low;
    if (
      l < candles[j - 2].low &&
      l < candles[j - 1].low &&
      l < candles[j + 1].low &&
      l < candles[j + 2].low
    ) {
      confirmedLowAt[j + 2] = l;
    }
  }

  // Forward-fill: swingHighAsOf[k] / swingLowAsOf[k] is the most recently
  // confirmed level considering every confirmation at or before bar k.
  const swingHighAsOf = new Float64Array(n).fill(NaN);
  const swingLowAsOf = new Float64Array(n).fill(NaN);
  let runningHigh = NaN;
  let runningLow = NaN;
  for (let k = 0; k < n; k++) {
    if (Number.isFinite(confirmedHighAt[k])) runningHigh = confirmedHighAt[k];
    if (Number.isFinite(confirmedLowAt[k])) runningLow = confirmedLowAt[k];
    swingHighAsOf[k] = runningHigh;
    swingLowAsOf[k] = runningLow;
  }

  for (let i = Math.max(1, warmupBars); i < n; i++) {
    const sh = swingHighAsOf[i - 1];
    const sl = swingLowAsOf[i - 1];
    if (!Number.isFinite(sh) && !Number.isFinite(sl)) continue;

    const closeNow = candles[i].close;
    const closePrev = candles[i - 1].close;
    const upBreak = Number.isFinite(sh) && closeNow > sh && !(closePrev > sh);
    const downBreak = Number.isFinite(sl) && closeNow < sl && !(closePrev < sl);

    out[i] = upBreak ? 1 : downBreak ? -1 : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// volRatio: 24h realised volatility over 168h realised volatility.
// ---------------------------------------------------------------------------

/** Trailing sample standard deviation (ddof 1) of `series` over an exact
 * window of `windowBars` values; NaN unless the window is COMPLETELY full
 * (every one of the last `windowBars` entries finite), unlike
 * trailingZScore's thinning of a partially-NaN window. */
function trailingFullStd(series: Float64Array, windowBars: number): Float64Array {
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
    if (count < windowBars) continue;
    const mean = sum / count;
    const variance = (sumSq - count * mean * mean) / (count - 1);
    out[i] = Math.sqrt(Math.max(0, variance));
  }
  return out;
}

/**
 * Realised volatility (sd of log returns, ddof 1) over the trailing 24h of
 * bars divided by the same over the trailing 168h. NaN until both windows
 * are completely full. The whole column is NaN when `hoursToBars(168)`
 * would meet or exceed the series length, since no window could ever fill,
 * and NaN throughout at 1d, where 24h is one bar and there is no window to
 * take a standard deviation over.
 */
function computeVolRatioRaw(candles: OHLCV[], interval: string, warmupBars: number): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);
  if (DAY_MS / intervalToMs(interval) <= 1) return out;

  const shortBars = hoursToBars(24, interval);
  const longBars = hoursToBars(168, interval);
  if (longBars >= n) return out;

  const logReturns = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1].close;
    const now = candles[i].close;
    if (prev > 0 && now > 0) logReturns[i] = Math.log(now / prev);
  }

  const shortVol = trailingFullStd(logReturns, shortBars);
  const longVol = trailingFullStd(logReturns, longBars);

  for (let i = warmupBars; i < n; i++) {
    if (Number.isFinite(shortVol[i]) && Number.isFinite(longVol[i]) && longVol[i] > 0) {
      out[i] = shortVol[i] / longVol[i];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// btcLeadLagZ: BTC's one-bar return minus this symbol's, timestamp-joined.
// ---------------------------------------------------------------------------

/**
 * btcRet1[t] - ownRet1[t], joined on exact bar timestamp (never on array
 * position, so a gap in either series never silently pairs the wrong bars).
 * NaN for BTCUSDT itself, when `marketCandles` is absent or empty, or where
 * BTC has no bar at this bar's own timestamp.
 */
function computeBtcLeadLagRaw(
  candles: OHLCV[],
  marketCandles: CandleRow[] | null | undefined,
  symbol: string,
  warmupBars: number
): Float64Array {
  const n = candles.length;
  const out = new Float64Array(n).fill(NaN);
  if (symbol === 'BTCUSDT' || !marketCandles || marketCandles.length === 0) return out;

  const btcRet1ByTimestamp = new Map<number, number>();
  for (let j = 1; j < marketCandles.length; j++) {
    const prev = marketCandles[j - 1].c;
    const now = marketCandles[j].c;
    if (prev > 0 && now > 0) {
      btcRet1ByTimestamp.set(marketCandles[j].t, (now - prev) / prev);
    }
  }

  for (let i = Math.max(1, warmupBars); i < n; i++) {
    const prevClose = candles[i - 1].close;
    const nowClose = candles[i].close;
    if (!(prevClose > 0) || !(nowClose > 0)) continue;
    const btcRet1 = btcRet1ByTimestamp.get(candles[i].timestamp);
    if (btcRet1 === undefined) continue;
    out[i] = btcRet1 - (nowClose - prevClose) / prevClose;
  }
  return out;
}

/**
 * Build every research column for one symbol, over its FULL candle series.
 *
 * Returns one row per candle, carrying only the columns that are finite at
 * that bar: an absent key means no reading, which `researchValue` turns into
 * NaN, which every family treats as "do not trade".
 */
export function buildResearchColumns(input: ResearchColumnInput): ResearchRow[] {
  const { candles, snapshots, metrics, interval, symbol, warmupBars, marketCandles } = input;
  const n = candles.length;
  const intervalMs = intervalToMs(interval);
  // A "day" needs more than one bar for a day boundary to mean anything;
  // at 1d it does not, and vwapDevZ/volRatio are NaN throughout there.
  const isSubDaily = DAY_MS / intervalMs > 1;

  // --- Snapshot-derived columns: buildSnapshotSeries holds each snapshot back
  // until its capture window has closed, so no further shift here. ---
  const snapBars = buildSnapshotSeries(candles, snapshots, interval, { symbol });

  const fundingRaw = new Float64Array(n).fill(Number.NaN);
  const positioningRaw = new Float64Array(n).fill(Number.NaN);
  for (let i = warmupBars; i < n; i++) {
    const futures = snapBars[i]?.futures;
    const rate = futures?.fundingRate?.fundingRate;
    if (typeof rate === 'number' && Number.isFinite(rate)) fundingRaw[i] = rate;
    // A ratio is strictly positive; a non-positive reading is a broken row.
    const ratio = futures?.longShortRatio?.longShortRatio;
    if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0) {
      positioningRaw[i] = ratio;
    }
  }

  const columns = new Map<string, Float64Array>();
  for (const days of FUNDING_Z_WINDOW_DAYS) {
    columns.set(
      fundingColumn(days),
      trailingZScore(fundingRaw, windowBarsForDays(days, interval), FUNDING_Z_MIN_SAMPLES)
    );
  }
  for (const bars of POSITIONING_Z_WINDOW_BARS) {
    columns.set(positioningColumn(bars), trailingZScore(positioningRaw, bars, Z_MIN_SAMPLES));
  }

  // --- Metric-derived columns: close-aligned per factors.ts, then shifted. ---
  const depthRaw = new Float64Array(n).fill(Number.NaN);
  if (metrics.length > 0) {
    const barCloses = candles.map((candle) => candle.timestamp + intervalMs - 1);
    const staleness = Math.max(intervalMs, 2 * METRICS_SLOT_MS);
    const aligned = alignToBars(
      barCloses,
      metrics.map((row) => ({ ...row, timestamp: row.t })),
      staleness
    );
    for (let i = warmupBars; i < n; i++) {
      const value = aligned[i]?.depthImbalance1;
      if (typeof value === 'number' && Number.isFinite(value)) depthRaw[i] = value;
    }
  }
  for (const days of DEPTH_Z_WINDOW_DAYS) {
    const unshifted = trailingZScore(depthRaw, windowBarsForDays(days, interval), Z_MIN_SAMPLES);
    columns.set(depthColumn(days), shiftForwardOneBar(unshifted));
  }

  // --- Price/volume-derived columns: close-aligned, then shifted, exactly
  // like the depth columns above (see this file's header). ---
  if (isSubDaily) {
    const vwapDevRaw = computeVwapDevRaw(candles, warmupBars);
    const vwapDevZ = trailingZScore(vwapDevRaw, windowBarsForDays(NEW_COLUMN_Z_DAYS, interval), Z_MIN_SAMPLES);
    columns.set('vwapDevZ', shiftForwardOneBar(vwapDevZ));
  }

  const { pocDist, outsideValue } = computePocAndOutsideValueRaw(candles, warmupBars);
  columns.set('pocDist', shiftForwardOneBar(pocDist));
  columns.set('outsideValue', shiftForwardOneBar(outsideValue));

  columns.set('sweepReversal20', shiftForwardOneBar(computeSweepReversalRaw(candles, 20, warmupBars)));
  columns.set('sweepReversal50', shiftForwardOneBar(computeSweepReversalRaw(candles, 50, warmupBars)));

  columns.set('bosBreak', shiftForwardOneBar(computeBosBreakRaw(candles, warmupBars)));

  if (isSubDaily) {
    columns.set('volRatio', shiftForwardOneBar(computeVolRatioRaw(candles, interval, warmupBars)));
  }

  const btcLeadLagRaw = computeBtcLeadLagRaw(candles, marketCandles, symbol, warmupBars);
  const btcLeadLagZ = trailingZScore(
    btcLeadLagRaw,
    windowBarsForDays(NEW_COLUMN_Z_DAYS, interval),
    Z_MIN_SAMPLES
  );
  columns.set('btcLeadLagZ', shiftForwardOneBar(btcLeadLagZ));

  // --- Emit, dropping non-finite entries so an absent key means no reading. ---
  const rows: ResearchRow[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const values: Record<string, number> = {};
    for (const [name, series] of columns) {
      if (Number.isFinite(series[i])) values[name] = series[i];
    }
    rows[i] = { timestamp: candles[i].timestamp, values };
  }
  return rows;
}
