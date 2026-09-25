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
 */

import type { OHLCV } from '@/types/market';
import type { LeanSnapshot } from '@/lib/backtest/snapshot-series';
import { buildSnapshotSeries } from '@/lib/backtest/snapshot-series';
import type { ResearchRow } from '@/lib/backtest/research-series';
import { alignToBars, METRICS_SLOT_MS } from '@/lib/archive-ingestion';
import { intervalToMs } from '@/lib/intervals';
import { trailingZScore, FUNDING_Z_MIN_SAMPLES } from './factors';
import type { MetricsRow } from './dataset-format';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Trailing windows offered to the funding family, in days. One column each. */
export const FUNDING_Z_WINDOW_DAYS = [15, 30, 60] as const;
/** Trailing windows offered to the depth family, in days. */
export const DEPTH_Z_WINDOW_DAYS = [30, 90] as const;
/** Trailing windows offered to the positioning families, in BARS.
 * Bars rather than days, so the existing Phase 4b grid keeps its meaning and
 * the re-run is comparable to the recorded table. */
export const POSITIONING_Z_WINDOW_BARS = [180, 360, 720] as const;

/** Readings needed before a z is emitted, for the non-funding columns. */
const Z_MIN_SAMPLES = 30;

export const fundingColumn = (days: number) => `fundingZ${days}d`;
export const depthColumn = (days: number) => `depthZ${days}d`;
export const positioningColumn = (bars: number) => `positioningZ${bars}`;

/** Every column name this module can produce, for the report and for a
 * family's `requiresResearchColumns` declaration. */
export const RESEARCH_COLUMNS: readonly string[] = [
  ...FUNDING_Z_WINDOW_DAYS.map(fundingColumn),
  ...DEPTH_Z_WINDOW_DAYS.map(depthColumn),
  ...POSITIONING_Z_WINDOW_BARS.map(positioningColumn),
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

/**
 * Build every research column for one symbol, over its FULL candle series.
 *
 * Returns one row per candle, carrying only the columns that are finite at
 * that bar: an absent key means no reading, which `researchValue` turns into
 * NaN, which every family treats as "do not trade".
 */
export function buildResearchColumns(input: ResearchColumnInput): ResearchRow[] {
  const { candles, snapshots, metrics, interval, symbol, warmupBars } = input;
  const n = candles.length;
  const intervalMs = intervalToMs(interval);

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
