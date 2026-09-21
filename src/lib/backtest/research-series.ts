import type { OHLCV } from '@/types/market';

/**
 * Research-only per-bar numeric inputs for a backtest.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT PART OF SnapshotBar
 *
 * Two separate reasons, and both matter.
 *
 * 1. Live-path parity. `snapshot-series.ts` mirrors exactly what the live
 *    scorer consumes, which is why it drops `openInterest` on purpose. A
 *    research family needs inputs that have no place in live scoring at all
 *    (order-book depth, a precomputed trailing z). Those must not travel in
 *    the same structure, or the next reader will reasonably conclude the live
 *    scorer sees them. Nothing here ever reaches `computeSignalScore`:
 *    bar-loop hands the scorer only `snap.futures` and `snap.sentiment`.
 *
 * 2. Slice truncation, which is the defect this module was written to fix.
 *    `runStrategyWalkForward` prepares each window from a SLICE of the candle
 *    array (`candles.slice(testStart - warmupBars, testEnd + 1)`), and
 *    `prepareBacktest` builds `ctx.snapshots` from that slice. A family that
 *    derives a trailing window from `ctx.snapshots` therefore gets the full
 *    window in-sample (the train slice is thousands of bars) and a truncated
 *    one out-of-sample (only `purgeGapBars` of pre-test history). In-sample
 *    and out-of-sample then compute a DIFFERENT factor for the same grid cell
 *    label, which is not lookahead -- truncation is backward-only, so the
 *    no-lookahead guard is silent on it -- but it does mean cell selection
 *    optimises one quantity and the gates score another.
 *
 *    Measured on the Phase 4b reports: at 1d the test slice is 612 bars, so a
 *    720-bar window could never be realised at all, and 5 of 38 selected
 *    symbol-windows chose exactly that cell. At 4h a 720-bar window was
 *    truncated across the first 32% of every test window and 14 of 53
 *    selections chose it.
 *
 *    The fix is to compute every windowed column ONCE over the full candle
 *    series, in the harness, and carry the result per bar as a plain number.
 *    Rows are keyed by timestamp, so slicing the candles for a window simply
 *    selects a sub-range of an already-correct column instead of recomputing a
 *    shorter one.
 *
 * CAUSALITY INVARIANT the producer must satisfy: the value at index `i` was
 * observable at or before `candles[i].timestamp`, the bar's OPEN. That is the
 * same contract `buildSnapshotSeries` satisfies, and it is what makes reading
 * index `bar` from a strategy safe however the column was derived. A column
 * built from a close-aligned source must therefore be shifted forward one bar
 * by its producer before it gets here.
 */

/** One bar's worth of research columns. Absent key means no reading. */
export type ResearchBar = Readonly<Record<string, number>>;

/** A produced row, keyed by the candle open time it belongs to. */
export interface ResearchRow {
  timestamp: number;
  values: Readonly<Record<string, number>>;
}

/**
 * Join research rows onto candles by exact open-time match.
 *
 * Deliberately NOT a staleness-tolerant join like `buildSnapshotSeries` or
 * `alignToBars`: the producer builds one row per candle of the full series, so
 * a candle with no row means the two arrays disagree about the grid, and that
 * should surface as a null (and then a NaN, and then no trade) rather than as
 * a silently carried-forward value from an earlier bar.
 *
 * Two-pointer over both arrays, so it is O(n + m) per prepared slice rather
 * than a map build per window. Rows must be sorted ascending by timestamp;
 * unsorted input is rejected rather than silently mis-joined.
 */
export function buildResearchSeries(
  candles: OHLCV[],
  rows: readonly ResearchRow[]
): (ResearchBar | null)[] {
  const out: (ResearchBar | null)[] = new Array(candles.length).fill(null);
  if (rows.length === 0) return out;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].timestamp < rows[i - 1].timestamp) {
      throw new Error('buildResearchSeries: rows must be sorted ascending by timestamp');
    }
  }

  let cursor = 0;
  for (let i = 0; i < candles.length; i++) {
    const t = candles[i].timestamp;
    while (cursor < rows.length && rows[cursor].timestamp < t) cursor++;
    if (cursor < rows.length && rows[cursor].timestamp === t) {
      out[i] = rows[cursor].values;
    }
  }

  return out;
}

/**
 * One column's reading at one bar, or NaN.
 *
 * NaN and never 0, for the reason factors.ts gives for its own matrix: on a
 * z-scored column 0 reads as "exactly average", which is a lie about a missing
 * reading. Every caller must check `Number.isFinite` and decline to trade.
 */
export function researchValue(
  bars: readonly (ResearchBar | null)[],
  bar: number,
  name: string
): number {
  const row = bars[bar];
  if (!row) return Number.NaN;
  const value = row[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}
