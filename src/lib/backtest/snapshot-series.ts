import type { OHLCV } from '@/types/market';
import type { FuturesData } from '@/types/futures';
import type { SentimentData } from '@/types/signal';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { intervalToMs } from '@/lib/intervals';
import { trailingZByTime } from '@/lib/stats/trailing-z';

/**
 * Point-in-time futures/sentiment series for backtests.
 *
 * Pure module: importable from the server, the backtest page, and the worker.
 * It adapts stored HistoricalSnapshot documents into the exact FuturesData and
 * SentimentData shapes the live signal path feeds computeSignalScore, aligned
 * per candle without lookahead.
 */

export interface SnapshotBar {
  futures: FuturesData | null;
  sentiment: SentimentData | null;
}

export type LeanSnapshot = Pick<IHistoricalSnapshot, 'timestamp' | 'data'>;

/** Snapshots are only ingested at 1h/4h/1d (see docker/crontab.template); map finer intervals up. */
export function mapToSnapshotInterval(interval: string): string {
  if (interval === '1m' || interval === '5m' || interval === '15m') return '1h';
  return interval;
}

export function snapshotToScorerInputs(
  data: LeanSnapshot['data'],
  symbol: string,
  timestamp: number
): SnapshotBar {
  const fundingRate = data.fundingRate
    ? {
        symbol,
        fundingRate: data.fundingRate.rate,
        fundingTime: timestamp,
        // Unused by the scorer, which reads only the rate; absent on pre-2023 history
        markPrice: data.fundingRate.markPrice ?? Number.NaN,
      }
    : null;

  const longShortRatio = data.longShortRatio
    ? {
        symbol,
        longShortRatio: data.longShortRatio.ratio,
        longAccount: data.longShortRatio.longAccount,
        shortAccount: data.longShortRatio.shortAccount,
        timestamp,
      }
    : null;

  // openInterest is stored but the scorer does not consume it; adding it here
  // would diverge backtest inputs from the live path
  const futures: FuturesData | null =
    fundingRate || longShortRatio
      ? { fundingRate, openInterest: null, longShortRatio }
      : null;

  // News rides along only when Fear & Greed is present (F&G anchors the
  // SentimentData shape and is nearly always available)
  const sentiment: SentimentData | null = data.fearGreed
    ? {
        fearGreedIndex: data.fearGreed.index,
        label: data.fearGreed.label,
        news: data.newsSentiment
          ? { count: data.newsSentiment.count, avgSentiment: data.newsSentiment.avgSentiment }
          : null,
      }
    : null;

  return { futures, sentiment };
}

/** The L/S z window: thirty days of the 1h series (scorer configVersion 8). */
export const LS_Z_WINDOW_MS = 30 * 24 * 3_600_000;
/** At least half the window's 720 hourly rows, so a fresh series reads neutral, not noisy. */
export const LS_Z_MIN_SAMPLES = 360;
/**
 * History a caller must load BEFORE its first candle for the z to be defined
 * there: the window plus the 1h causality shift plus one hour of slack.
 */
export const LS_Z_WARMUP_MS = LS_Z_WINDOW_MS + 2 * 3_600_000;

const HOUR_MS = 3_600_000;

/**
 * The top-trader L/S ratio's trailing z on the 1h snapshot grid, one entry per
 * row that carries a ratio, sorted by time. Shared by research and live so the
 * two read the same number (configVersion 8).
 */
export function longShortZSeries(rows1h: readonly LeanSnapshot[]): { t: number[]; z: Float64Array } {
  const withRatio = rows1h
    .filter((r) => r.data.longShortRatio && Number.isFinite(r.data.longShortRatio.ratio))
    .sort((a, b) => a.timestamp - b.timestamp);
  const t = withRatio.map((r) => r.timestamp);
  const z = trailingZByTime(
    withRatio.map((r) => ({ t: r.timestamp, value: r.data.longShortRatio!.ratio })),
    LS_Z_WINDOW_MS,
    LS_Z_MIN_SAMPLES
  );
  return { t, z };
}

/**
 * Align snapshots to candles without lookahead.
 *
 * A snapshot stamped T does NOT hold the state of the market at T. It holds a
 * reading captured somewhere in `[T, T + snapshotInterval)`: `ingest-snapshots`
 * stamps `alignTimestamp(now, interval)` while fetching every field at `now`,
 * the 1h line runs every 15 minutes so all four runs of an hour floor to the
 * same stamp, and `mergeSnapshotUpdate` `$set`s per field on upsert, so the
 * LAST run wins.
 * A row stamped 12:00 routinely holds 12:45 data.
 *
 * It is therefore knowable only at `T + snapshotInterval`, and that is the rule
 * applied here: a candle may read the latest snapshot whose whole window closed
 * at or before the candle's open. This was `snapshot.timestamp <= candleTime`,
 * which handed a bar opening at 12:00 a reading taken at 12:45 -- up to 45
 * minutes of lookahead at 1h, and up to nine bars at 5m, since 1m/5m/15m
 * candles read 1h snapshots (`mapToSnapshotInterval`).
 *
 * The cost is one snapshot interval of staleness on fields that were already
 * causal, `longShortRatio` in particular, which the archive backfill wrote
 * strictly (`archive-ingestion.ts`). Staleness is conservative; the alternative
 * is not.
 *
 * Bars without a usable snapshot get null (the scorer redistributes weights,
 * matching live missing-data behavior).
 *
 * THE L/S z (configVersion 8). The scorer reads the ratio's trailing 30-day z
 * within the symbol, computed on the 1h snapshot grid for EVERY candle
 * interval, so 4h and 1d candles get the same z a 1h candle at that time gets
 * rather than a 30-row daily one that a single missed day would blank. A
 * candle reads the z of the latest 1h row whose window closed at or before its
 * open, the same causal rule, within the same three-hour staleness cap. For
 * candles whose snapshots are 1h already, those rows are used; for 4h and 1d
 * the caller must pass `lsRows1h` explicitly. Omitting it there THROWS, so a
 * scoring path cannot silently drop the signal and diverge from live; a caller
 * that only reads funding passes `[]`.
 */
export function buildSnapshotSeries(
  candles: OHLCV[],
  snapshots: LeanSnapshot[],
  candleInterval: string,
  opts?: { maxStalenessMs?: number; symbol?: string; lsRows1h?: readonly LeanSnapshot[] }
): (SnapshotBar | null)[] {
  const snapshotIntervalMs = intervalToMs(mapToSnapshotInterval(candleInterval));
  // Three intervals, not two: one of them is spent on the causality shift that
  // every usable snapshot now carries, which leaves the same tolerance for a
  // missed ingest tick as the old cap gave.
  const maxStalenessMs = opts?.maxStalenessMs ?? 3 * snapshotIntervalMs;
  const symbol = opts?.symbol ?? '';

  let lsRows1h = opts?.lsRows1h;
  if (lsRows1h === undefined) {
    if (snapshotIntervalMs !== HOUR_MS) {
      throw new Error(
        `buildSnapshotSeries: ${candleInterval} candles read ${mapToSnapshotInterval(candleInterval)} snapshots, ` +
          'so the L/S z needs the 1h rows passed as lsRows1h (pass [] for a funding-only caller)'
      );
    }
    lsRows1h = snapshots;
  }
  const ls = longShortZSeries(lsRows1h);

  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const bars: (SnapshotBar | null)[] = new Array(candles.length).fill(null);

  let snapIdx = -1; // index of the latest snapshot the current candle may read
  let lsIdx = -1; // index of the latest 1h L/S row the current candle may read
  for (let i = 0; i < candles.length; i++) {
    const candleTime = candles[i].timestamp;
    while (
      snapIdx + 1 < sorted.length &&
      sorted[snapIdx + 1].timestamp + snapshotIntervalMs <= candleTime
    ) {
      snapIdx++;
    }
    while (lsIdx + 1 < ls.t.length && ls.t[lsIdx + 1] + HOUR_MS <= candleTime) {
      lsIdx++;
    }
    if (snapIdx < 0) continue;

    const snapshot = sorted[snapIdx];
    if (candleTime - snapshot.timestamp > maxStalenessMs) continue;

    const bar = snapshotToScorerInputs(snapshot.data, symbol, snapshot.timestamp);
    if (bar.futures?.longShortRatio) {
      const fresh = lsIdx >= 0 && candleTime - ls.t[lsIdx] <= 3 * HOUR_MS;
      const z = fresh ? ls.z[lsIdx] : Number.NaN;
      bar.futures.longShortRatio.zScore = Number.isFinite(z) ? z : null;
    }
    bars[i] = bar;
  }

  return bars;
}
