import type { TradingStyle } from '@/lib/models/signal-template';
import { DEFAULT_TEMPLATE_WEIGHTS, SignalTemplate } from '@/lib/models/signal-template';
import { HistoricalSnapshot } from '@/lib/models/historical-snapshot';
import type { IndicatorConfig } from '@/lib/indicators/types';
import { computeHtfSeries, htfContextAtBar } from '@/lib/signals/htf';
import {
  buildSnapshotSeries,
  LS_Z_WARMUP_MS,
  mapToSnapshotInterval,
  type LeanSnapshot,
} from '@/lib/backtest/snapshot-series';
import type { FuturesData } from '@/types/futures';
import type { OHLCV } from '@/types/market';
import type { HtfContext, SignalWeights } from '@/types/signal';


export const NEWS_STALENESS_MS = 2 * 60 * 60 * 1000; // snapshots ingest every 15m; 2h covers outages

/**
 * Latest stored news sentiment per symbol (ingested by the snapshot cron), so
 * signal computation never calls the news API directly at compute cadence.
 */
export async function fetchNewsSentimentMap(
  symbols: string[]
): Promise<Map<string, { count: number; avgSentiment: number }>> {
  const map = new Map<string, { count: number; avgSentiment: number }>();
  if (symbols.length === 0) return map;

  try {
    const docs = await HistoricalSnapshot.aggregate([
      {
        $match: {
          symbol: { $in: symbols },
          interval: '1h',
          timestamp: { $gte: Date.now() - NEWS_STALENESS_MS },
          'data.newsSentiment': { $ne: null },
        },
      },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$symbol',
          newsSentiment: { $first: '$data.newsSentiment' },
        },
      },
    ]);
    for (const doc of docs) {
      if (doc.newsSentiment) {
        map.set(doc._id, {
          count: doc.newsSentiment.count,
          avgSentiment: doc.newsSentiment.avgSentiment,
        });
      }
    }
  } catch {
    // News sentiment is optional
  }

  return map;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stored snapshot rows for one symbol at one snapshot interval, from far enough
 * back that the L/S z has its thirty days for any candle this run scores (the
 * latest closed 1d candle opened up to two days before `now`). Only the fields
 * the futures category reads are projected: the scalping run fires every
 * minute.
 */
export async function storedSnapshotRows(symbol: string, snapshotInterval: string, now: number): Promise<LeanSnapshot[]> {
  return HistoricalSnapshot.find(
    { symbol, interval: snapshotInterval, timestamp: { $gte: now - LS_Z_WARMUP_MS - 2 * DAY_MS, $lte: now } },
    { timestamp: 1, 'data.fundingRate': 1, 'data.longShortRatio': 1 }
  )
    .sort({ timestamp: 1 })
    .lean<LeanSnapshot[]>();
}

/**
 * The futures input for one candle, from STORED snapshots through the same
 * `buildSnapshotSeries` research scores with (configVersion 8).
 *
 * Until v7 the live path fetched funding and the 1h top-trader ratio from
 * Binance REST at compute time while research read the stored rows, held back
 * one interval: the scoring CODE matched bar for bar, the INPUTS did not, and
 * a trailing z cannot be taken from a single REST read anyway (the endpoint
 * serves about 500 bars, less than thirty days at 1h). Now live reads what
 * research reads, under the same causal rule: the latest row whose capture
 * window closed at or before the candle's open, within three intervals. The
 * value is up to about two hours older at 1h than the REST read was; parity is
 * worth more than that hour for a thirty-day z. There is no REST fallback: a
 * missing or stale row leaves the signal absent, which the scorer handles by
 * redistributing weight, exactly as research does.
 */
export async function storedFuturesForCandle(
  symbol: string,
  interval: string,
  candle: OHLCV,
  now: number,
  rowsCache: Map<string, Promise<LeanSnapshot[]>>
): Promise<FuturesData | null> {
  const rowsFor = (snapshotInterval: string) => {
    const key = `${symbol}:${snapshotInterval}`;
    let rows = rowsCache.get(key);
    if (!rows) {
      rows = storedSnapshotRows(symbol, snapshotInterval, now);
      rowsCache.set(key, rows);
    }
    return rows;
  };
  const snapshotInterval = mapToSnapshotInterval(interval);
  const [snapshots, lsRows1h] = await Promise.all([
    rowsFor(snapshotInterval),
    snapshotInterval === '1h' ? Promise.resolve(undefined) : rowsFor('1h'),
  ]);
  const [bar] = buildSnapshotSeries([candle], snapshots, interval, { symbol, lsRows1h });
  return bar?.futures ?? null;
}

/**
 * Get the active template weights for a trading style, falling back to defaults.
 */
export async function getWeightsForStyle(tradingStyle: TradingStyle): Promise<SignalWeights> {
  try {
    const template = await SignalTemplate.findOne({
      tradingStyle,
      active: true,
    }).lean();

    if (template) {
      // Templates created before the htf category lack the key; frozen at 0
      // until the next optimization run regenerates them
      const weights = template.weights as SignalWeights;
      return { ...weights, htf: weights.htf ?? 0 };
    }
  } catch {
    // Fall back to defaults
  }

  return DEFAULT_TEMPLATE_WEIGHTS[tradingStyle];
}

/**
 * The higher-timeframe context from already-closed confirmation candles, or
 * null when there are none. Pure: fetching and closed-bar filtering stay with
 * the caller.
 */
export function htfContextFromClosed(
  closedHtfCandles: OHLCV[],
  htfInterval: string,
  config: IndicatorConfig
): HtfContext | null {
  if (closedHtfCandles.length === 0) return null;
  const series = computeHtfSeries(closedHtfCandles, config);
  return htfContextAtBar(series, closedHtfCandles.length - 1, htfInterval);
}
