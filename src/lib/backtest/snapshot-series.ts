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
 * Align snapshots to candles: for each candle, use the latest snapshot whose
 * timestamp is at or before the candle's open time, within the staleness cap.
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
  // Default covers one missed ingest tick plus fine candles fed by coarser snapshots
  const maxStalenessMs = opts?.maxStalenessMs ?? 2 * snapshotIntervalMs;
  const symbol = opts?.symbol ?? '';

  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const bars: (SnapshotBar | null)[] = new Array(candles.length).fill(null);

  let snapIdx = -1; // index of the latest snapshot at or before the current candle
  for (let i = 0; i < candles.length; i++) {
    const candleTime = candles[i].timestamp;
    while (snapIdx + 1 < sorted.length && sorted[snapIdx + 1].timestamp <= candleTime) {
      snapIdx++;
    }
    if (snapIdx < 0) continue;

    const snapshot = sorted[snapIdx];
    if (candleTime - snapshot.timestamp > maxStalenessMs) continue;

    bars[i] = snapshotToScorerInputs(snapshot.data, symbol, snapshot.timestamp);
  }

  return bars;
}
