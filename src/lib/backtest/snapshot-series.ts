import type { OHLCV } from '@/types/market';
import type { FuturesData } from '@/types/futures';
import type { SentimentData } from '@/types/signal';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { intervalToMs } from '@/lib/intervals';

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
 */
export function buildSnapshotSeries(
  candles: OHLCV[],
  snapshots: LeanSnapshot[],
  candleInterval: string,
  opts?: { maxStalenessMs?: number; symbol?: string }
): (SnapshotBar | null)[] {
  const snapshotIntervalMs = intervalToMs(mapToSnapshotInterval(candleInterval));
  // Three intervals, not two: one of them is spent on the causality shift that
  // every usable snapshot now carries, which leaves the same tolerance for a
  // missed ingest tick as the old cap gave.
  const maxStalenessMs = opts?.maxStalenessMs ?? 3 * snapshotIntervalMs;
  const symbol = opts?.symbol ?? '';

  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const bars: (SnapshotBar | null)[] = new Array(candles.length).fill(null);

  let snapIdx = -1; // index of the latest snapshot the current candle may read
  for (let i = 0; i < candles.length; i++) {
    const candleTime = candles[i].timestamp;
    while (
      snapIdx + 1 < sorted.length &&
      sorted[snapIdx + 1].timestamp + snapshotIntervalMs <= candleTime
    ) {
      snapIdx++;
    }
    if (snapIdx < 0) continue;

    const snapshot = sorted[snapIdx];
    if (candleTime - snapshot.timestamp > maxStalenessMs) continue;

    bars[i] = snapshotToScorerInputs(snapshot.data, symbol, snapshot.timestamp);
  }

  return bars;
}
