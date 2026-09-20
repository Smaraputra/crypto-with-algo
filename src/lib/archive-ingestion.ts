/**
 * Turning Binance archive files into stored documents.
 *
 * Everything here is pure: no fetch, no Mongo, no filesystem. The CLI in
 * `scripts/ops/ingest-archive.ts` supplies parsed rows and writes what these
 * functions return, so the shaping rules are unit tested without I/O.
 *
 * Three jobs:
 *   1. Enumerate which archive files a date range needs.
 *   2. Fold bookDepth snapshots (about one every 30 seconds) onto the metrics
 *      5m grid, so both land in one FuturesMetric document per slot.
 *   3. Build the HistoricalSnapshot patches that fill `longShortRatio` and
 *      `openInterest`, the two fields Binance REST could only serve for the
 *      last 30 days.
 */
import type { BookDepthSnapshot, KlineCsvRow, MetricsCsvRow } from '@/lib/external/binance-archive';
import { depthImbalance } from '@/lib/external/binance-archive';
import type { IFuturesMetric } from '@/lib/models/futures-metric';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';
import type { PerpSeries } from '@/lib/models/perp-candle';
import { intervalToMs } from '@/lib/intervals';

/** The archive publishes metrics on a 5m grid, and FuturesMetric mirrors it. */
export const METRICS_SLOT_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Which files a range needs
// ---------------------------------------------------------------------------

/** Inclusive list of 'YYYY-MM-DD' keys, oldest first. */
export function enumerateDays(fromMs: number, toMs: number): string[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('enumerateDays needs finite bounds');
  const out: string[] = [];
  let cursor = Math.floor(fromMs / DAY_MS) * DAY_MS;
  const last = Math.floor(toMs / DAY_MS) * DAY_MS;
  while (cursor <= last) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return out;
}

/** Inclusive list of 'YYYY-MM' keys, oldest first. */
export function enumerateMonths(fromMs: number, toMs: number): string[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('enumerateMonths needs finite bounds');
  const out: string[] = [];
  const from = new Date(fromMs);
  const to = new Date(toMs);
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  const lastYear = to.getUTCFullYear();
  const lastMonth = to.getUTCMonth();
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    out.push(`${year}-${String(month + 1).padStart(2, '0')}`);
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// bookDepth onto the 5m grid
// ---------------------------------------------------------------------------

export interface DepthSlot {
  timestamp: number;
  depthImbalance1: number | null;
  depthImbalance2: number | null;
  depthImbalance5: number | null;
  depthNotional1: number | null;
  depthNotional5: number | null;
  depthSamples: number;
}

function meanOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Average the bookDepth snapshots that fall inside each 5m slot.
 *
 * A snapshot belongs to the slot that contains it, so every figure in a slot
 * was observable by the end of that slot. Research reads a slot only at or
 * after the close of the bar containing it (see `alignToBars`), so the average
 * never reaches past a decision point.
 *
 * Each band is averaged over the snapshots that actually carried both sides of
 * it, and a band no snapshot could price stays null rather than becoming zero,
 * which would read as a balanced book.
 */
export function aggregateBookDepth(snapshots: BookDepthSnapshot[]): DepthSlot[] {
  const bySlot = new Map<number, BookDepthSnapshot[]>();
  for (const snapshot of snapshots) {
    if (!Number.isFinite(snapshot.timestamp)) continue;
    const slot = Math.floor(snapshot.timestamp / METRICS_SLOT_MS) * METRICS_SLOT_MS;
    const bucket = bySlot.get(slot);
    if (bucket) bucket.push(snapshot);
    else bySlot.set(slot, [snapshot]);
  }

  const out: DepthSlot[] = [];
  for (const [timestamp, bucket] of bySlot) {
    const imb1: number[] = [];
    const imb2: number[] = [];
    const imb5: number[] = [];
    const notional1: number[] = [];
    const notional5: number[] = [];

    for (const snapshot of bucket) {
      const i1 = depthImbalance(snapshot, 1);
      const i2 = depthImbalance(snapshot, 2);
      const i5 = depthImbalance(snapshot, 5);
      if (i1 !== null) imb1.push(i1);
      if (i2 !== null) imb2.push(i2);
      if (i5 !== null) imb5.push(i5);

      const bid1 = snapshot.notional.get(-1);
      const ask1 = snapshot.notional.get(1);
      if (bid1 !== undefined && ask1 !== undefined) notional1.push(bid1 + ask1);
      const bid5 = snapshot.notional.get(-5);
      const ask5 = snapshot.notional.get(5);
      if (bid5 !== undefined && ask5 !== undefined) notional5.push(bid5 + ask5);
    }

    out.push({
      timestamp,
      depthImbalance1: meanOrNull(imb1),
      depthImbalance2: meanOrNull(imb2),
      depthImbalance5: meanOrNull(imb5),
      depthNotional1: meanOrNull(notional1),
      depthNotional5: meanOrNull(notional5),
      depthSamples: bucket.length,
    });
  }

  return out.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------------------
// Document shaping
// ---------------------------------------------------------------------------

export interface UpsertOp<T> {
  filter: Record<string, unknown>;
  set: T;
}

/** Drop keys whose value is null or not finite, so a gap never stores as zero. */
function finiteFields<T extends Record<string, number | null>>(fields: T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export type FuturesMetricFields = Partial<
  Pick<
    IFuturesMetric,
    | 'openInterest'
    | 'openInterestValue'
    | 'topTraderAccountRatio'
    | 'topTraderPositionRatio'
    | 'globalAccountRatio'
    | 'takerLongShortRatio'
    | 'depthImbalance1'
    | 'depthImbalance2'
    | 'depthImbalance5'
    | 'depthNotional1'
    | 'depthNotional5'
    | 'depthSamples'
  >
>;

/**
 * One upsert per metrics row. A row whose every measure is missing is dropped
 * rather than written as an empty document.
 */
export function metricsUpserts(symbol: string, rows: MetricsCsvRow[]): UpsertOp<FuturesMetricFields>[] {
  const ops: UpsertOp<FuturesMetricFields>[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.timestamp)) continue;
    const set = finiteFields({
      openInterest: row.openInterest,
      openInterestValue: row.openInterestValue,
      topTraderAccountRatio: row.topTraderAccountRatio,
      topTraderPositionRatio: row.topTraderPositionRatio,
      globalAccountRatio: row.globalAccountRatio,
      takerLongShortRatio: row.takerLongShortRatio,
    });
    if (Object.keys(set).length === 0) continue;
    ops.push({ filter: { symbol, timestamp: row.timestamp }, set });
  }
  return ops;
}

/** One upsert per 5m slot of aggregated book depth, merged into the same document. */
export function depthUpserts(symbol: string, slots: DepthSlot[]): UpsertOp<FuturesMetricFields>[] {
  const ops: UpsertOp<FuturesMetricFields>[] = [];
  for (const slot of slots) {
    const set = finiteFields({
      depthImbalance1: slot.depthImbalance1,
      depthImbalance2: slot.depthImbalance2,
      depthImbalance5: slot.depthImbalance5,
      depthNotional1: slot.depthNotional1,
      depthNotional5: slot.depthNotional5,
      depthSamples: slot.depthSamples,
    });
    // depthSamples alone says nothing; require at least one real measure.
    if (Object.keys(set).length <= 1) continue;
    ops.push({ filter: { symbol, timestamp: slot.timestamp }, set });
  }
  return ops;
}

export interface PerpCandleFields {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  takerBuyVolume?: number;
}

/** One upsert per archive kline row, keyed by symbol, interval, series and bar. */
export function perpCandleUpserts(
  symbol: string,
  interval: string,
  series: PerpSeries,
  rows: KlineCsvRow[]
): UpsertOp<PerpCandleFields>[] {
  return rows.map((row) => {
    const set: PerpCandleFields = {
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      quoteVolume: row.quoteVolume,
      trades: row.trades,
    };
    if (row.takerBuyVolume !== null && Number.isFinite(row.takerBuyVolume)) {
      set.takerBuyVolume = row.takerBuyVolume;
    }
    return { filter: { symbol, interval, series, timestamp: row.timestamp }, set };
  });
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/**
 * For each target timestamp, the last source row at or before it, or null.
 *
 * Both inputs must be ascending, which every archive parser guarantees. The
 * walk is linear, so a year of 5m rows against a year of 1h bars is one pass.
 *
 * `maxStalenessMs` caps how far back a reading may be carried. Without it a
 * single row would stand in for an arbitrary gap in the archive, and a bar
 * would silently score on data from days earlier.
 */
export function alignToBars<T extends { timestamp: number }>(
  targets: number[],
  sources: T[],
  maxStalenessMs: number
): (T | null)[] {
  const out: (T | null)[] = new Array(targets.length).fill(null);
  let cursor = 0;
  let latest: T | null = null;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    while (cursor < sources.length && sources[cursor].timestamp <= target) {
      latest = sources[cursor];
      cursor++;
    }
    if (latest !== null && target - latest.timestamp <= maxStalenessMs) {
      out[i] = latest;
    }
  }

  return out;
}

/** Bar open times from `from` to `to` inclusive, aligned down to the interval. */
export function barGrid(fromMs: number, toMs: number, interval: string): number[] {
  const ms = intervalToMs(interval);
  const out: number[] = [];
  let cursor = Math.ceil(fromMs / ms) * ms;
  for (; cursor <= toMs; cursor += ms) out.push(cursor);
  return out;
}

/**
 * The subset of a metrics reading the snapshot backfill needs, shaped to accept
 * both a parsed archive row (missing fields are null) and a stored
 * FuturesMetric document (missing fields are undefined).
 */
export interface MetricsLike {
  timestamp: number;
  openInterest?: number | null;
  openInterestValue?: number | null;
  globalAccountRatio?: number | null;
  topTraderPositionRatio?: number | null;
}

export interface SnapshotPatch {
  symbol: string;
  interval: string;
  timestamp: number;
  data: IHistoricalSnapshot['data'];
}

/**
 * HistoricalSnapshot patches carrying `longShortRatio` and `openInterest` for
 * every bar the archive can price.
 *
 * These are the two fields `src/lib/snapshot-backfill.ts` could not backfill:
 * Binance REST serves them for about 500 bars, so stored coverage is 11.0% at
 * 1h and nothing before 2026-03-03. The archive's 5m metrics reach back to 2021.
 *
 * A snapshot stamped T is read by `buildSnapshotSeries` for bars whose open is
 * at or after T, so the value stored at T must be knowable at T: the rule here
 * is the last metrics row at or before the bar's own open time, never a later
 * one. That is one notch stricter than live ingestion, where the cron runs at
 * :15 and stamps the reading back to the hour it floors into.
 *
 * `longShortRatio.ratio` takes the TOP TRADER POSITION ratio
 * (`sum_toptrader_long_short_ratio`), not the global account ratio, because
 * that is the series live ingestion stores in this field: every live caller
 * (`ingest-snapshots`, `compute-signals`, `compute-engine`, `signals/compute`)
 * goes through `fetchLongShortRatio`, which hits
 * `/futures/data/topLongShortPositionRatio`. Filling it from the archive's
 * `count_long_short_ratio` instead would put a different series in the same
 * field on older bars, so historical scoring would diverge from live scoring
 * in exactly the way `src/lib/backtest/snapshot-series.ts` refuses to. The
 * archive's global account ratio is still ingested into `FuturesMetric` and
 * reaches research as `raw.globalAccountRatio`, where it is its own column.
 *
 * `longAccount` and `shortAccount` are derived from that ratio as shares
 * summing to 1, which is the shape the live path carries.
 */
export function buildMetricsSnapshotPatches(input: {
  symbol: string;
  interval: string;
  bars: number[];
  metrics: MetricsLike[];
  maxStalenessMs?: number;
}): SnapshotPatch[] {
  const { symbol, interval, bars, metrics } = input;
  const maxStalenessMs = input.maxStalenessMs ?? Math.max(intervalToMs(interval), METRICS_SLOT_MS * 2);
  const aligned = alignToBars(bars, metrics, maxStalenessMs);
  const patches: SnapshotPatch[] = [];

  for (let i = 0; i < bars.length; i++) {
    const row = aligned[i];
    if (row === null) continue;

    const data: IHistoricalSnapshot['data'] = {};

    const topTraderPositionRatio = row.topTraderPositionRatio ?? null;
    if (
      topTraderPositionRatio !== null &&
      Number.isFinite(topTraderPositionRatio) &&
      topTraderPositionRatio > 0
    ) {
      const ratio = topTraderPositionRatio;
      const longAccount = ratio / (1 + ratio);
      data.longShortRatio = { ratio, longAccount, shortAccount: 1 - longAccount };
    }

    const openInterest = row.openInterest ?? null;
    const openInterestValue = row.openInterestValue ?? null;
    if (
      openInterest !== null &&
      Number.isFinite(openInterest) &&
      openInterestValue !== null &&
      Number.isFinite(openInterestValue)
    ) {
      data.openInterest = { value: openInterest, sumValue: openInterestValue };
    }

    if (Object.keys(data).length === 0) continue;
    patches.push({ symbol, interval, timestamp: bars[i], data });
  }

  return patches;
}
