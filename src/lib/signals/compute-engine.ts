import type { TradingStyle } from '@/lib/models/signal-template';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import { SignalTemplate } from '@/lib/models/signal-template';
import { GlobalSignal } from '@/lib/models/global-signal';
import { getCandles, dropOpenBars } from '@/lib/candle-ingestion';
import { fetchKlines } from '@/lib/binance';
import { fetchFundingRate, fetchLongShortRatio } from '@/lib/binance-futures';
import { computeIndicatorsForStyle } from '@/lib/indicators/compute-for-style';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeSignalScore } from '@/lib/signals/scorer';
import { fetchFearAndGreed } from '@/lib/external/fear-greed';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { isSessionMeaningful, sessionOfCandleClose } from '@/lib/sessions';
import { intervalToMs } from '@/lib/intervals';
import { computeHtfSeries, getConfirmationInterval, htfContextAtBar } from '@/lib/signals/htf';
import { HistoricalSnapshot } from '@/lib/models/historical-snapshot';
import type { HtfContext, SignalTier } from '@/types/signal';
import { createPendingOutcomes } from '@/lib/signals/outcome-resolver';

const NEWS_STALENESS_MS = 2 * 60 * 60 * 1000; // snapshots ingest every 15m; 2h covers outages

/**
 * Latest stored news sentiment per symbol (ingested by the snapshot cron), so
 * signal computation never calls the news API directly at compute cadence.
 */
async function fetchNewsSentimentMap(
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
import { cachedFetch } from '@/lib/redis';
import type { FuturesData } from '@/types/futures';
import type { SentimentData, SignalWeights } from '@/types/signal';
import type { OHLCV } from '@/types/market';

export interface ComputeTask {
  symbol: string;
  interval: string;
  tradingStyle: TradingStyle;
}

export interface ComputeResult {
  computed: number;
  errors: number;
  skipped: number;
  details: Array<{
    symbol: string;
    interval: string;
    tradingStyle: TradingStyle;
    status: 'computed' | 'error' | 'skipped';
    error?: string;
  }>;
}

/**
 * Fetch candles for a symbol/interval, preferring local DB with API fallback.
 *
 * The fetchKlines fallback result is cached for 60s (see `cachedFetch`), and
 * always ends with the still-forming bar. Filtering it here, before the value
 * is cached, means a bar open at fetch time can never be served from the
 * cache as "closed" later just because wall-clock time moved on -- the data
 * itself stays partial for the life of that cache entry regardless. `now` is
 * the caller's single point-in-time reference (see `computeSignalBatch`), not
 * a fresh `Date.now()`, so every dropOpenBars call in one batch agrees.
 */
async function fetchCandlesForTask(
  symbol: string,
  interval: string,
  recommendedCandles: number,
  now: number
): Promise<OHLCV[]> {
  return cachedFetch(
    `klines:${symbol}:${interval}:${recommendedCandles}`,
    async () => {
      const dbCandles = await getCandles(
        symbol,
        interval,
        undefined,
        undefined,
        recommendedCandles
      );
      if (dbCandles.length >= recommendedCandles) return dbCandles;
      const apiCandles = await fetchKlines(symbol, interval, recommendedCandles);
      return dropOpenBars(apiCandles, interval, now);
    },
    60
  );
}

/**
 * Fetch futures data (funding rate + long/short ratio) safely.
 */
async function fetchFuturesDataSafe(symbol: string): Promise<FuturesData> {
  const result: FuturesData = {
    fundingRate: null,
    openInterest: null,
    longShortRatio: null,
  };

  try {
    const rates = await cachedFetch(
      `futures:funding:${symbol}:1`,
      () => fetchFundingRate(symbol, 1),
      300
    );
    if (rates.length > 0) result.fundingRate = rates[0];
  } catch {
    // Futures data is optional
  }

  try {
    const ratios = await cachedFetch(
      `futures:ls:top:${symbol}:1h:1`,
      () => fetchLongShortRatio(symbol, '1h', 1),
      300
    );
    if (ratios.length > 0) result.longShortRatio = ratios[0];
  } catch {
    // Futures data is optional
  }

  return result;
}

/**
 * Get the active template weights for a trading style, falling back to defaults.
 */
async function getWeightsForStyle(tradingStyle: TradingStyle): Promise<SignalWeights> {
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
 * Batch-process signal computation for multiple (symbol, interval, style) tuples.
 *
 * Optimizations:
 * - Deduplicates candle fetches by (symbol, interval)
 * - Fetches sentiment once (shared across all tasks)
 * - Uses bulkWrite for efficient DB insertion
 */
export async function computeSignalBatch(tasks: ComputeTask[]): Promise<ComputeResult> {
  if (tasks.length === 0) {
    return { computed: 0, errors: 0, skipped: 0, details: [] };
  }

  // Single point-in-time reference for the whole batch: every dropOpenBars
  // call (primary and HTF, including inside fetchCandlesForTask's producer)
  // uses this same `now`, so a batch spanning several seconds of async work
  // scores every symbol on the same closed-bar boundary.
  const now = Date.now();

  const result: ComputeResult = { computed: 0, errors: 0, skipped: 0, details: [] };

  // Fetch sentiment once for all tasks; news sentiment per symbol from the
  // latest stored snapshot
  const sentimentData: SentimentData | null = await fetchFearAndGreed().catch(() => null);
  const newsMap = await fetchNewsSentimentMap([...new Set(tasks.map((t) => t.symbol))]);

  // Deduplicate candle fetches by (symbol, interval)
  const candleCache = new Map<string, OHLCV[]>();
  const futuresCache = new Map<string, FuturesData>();

  // Pre-fetch weights for all styles used in this batch
  const stylesNeeded = new Set(tasks.map((t) => t.tradingStyle));
  const weightsMap = new Map<TradingStyle, SignalWeights>();
  for (const style of stylesNeeded) {
    weightsMap.set(style, await getWeightsForStyle(style));
  }

  // Fetch latest candleTimestamp per (symbol, interval, style) to skip duplicates
  const existingTimestamps = new Map<string, number>();
  const uniqueKeys = new Set(tasks.map((t) => `${t.symbol}:${t.interval}:${t.tradingStyle}`));
  if (uniqueKeys.size > 0) {
    const pipeline = [
      {
        $match: {
          $or: tasks.map((t) => ({
            symbol: t.symbol,
            interval: t.interval,
            tradingStyle: t.tradingStyle,
          })),
        },
      },
      {
        $sort: { createdAt: -1 as const },
      },
      {
        $group: {
          _id: { symbol: '$symbol', interval: '$interval', tradingStyle: '$tradingStyle' },
          candleTimestamp: { $first: '$candleTimestamp' },
        },
      },
    ];
    try {
      const existing = await GlobalSignal.aggregate(pipeline);
      for (const doc of existing) {
        const key = `${doc._id.symbol}:${doc._id.interval}:${doc._id.tradingStyle}`;
        existingTimestamps.set(key, doc.candleTimestamp);
      }
    } catch {
      // If aggregate fails, proceed without dedup
    }
  }

  // Process each task
  const signalDocs: Array<Record<string, unknown>> = [];

  for (const task of tasks) {
    const { symbol, interval, tradingStyle } = task;
    const profile = getStyleConfig(tradingStyle);

    try {
      // Get candles (cached by symbol+interval)
      const candleKey = `${symbol}:${interval}`;
      let rawCandles = candleCache.get(candleKey);
      if (!rawCandles) {
        rawCandles = await fetchCandlesForTask(symbol, interval, profile.recommendedCandles, now);
        candleCache.set(candleKey, rawCandles);
      }

      // Score closed bars only: a row synced before the candle-finalization
      // fix may still hold a partial newest bar, and the Binance REST
      // fallback always returns the still-forming candle last (already
      // dropped once inside fetchCandlesForTask's producer; this is a
      // safety net for candles pulled straight from Mongo). Same helper
      // as the HTF path below.
      const candles = dropOpenBars(rawCandles, interval, now);

      if (candles.length === 0) {
        result.skipped++;
        result.details.push({
          symbol,
          interval,
          tradingStyle,
          status: 'skipped',
          error: 'No closed candle available',
        });
        console.log(
          `compute-engine: skipped ${symbol} ${interval} ${tradingStyle} - no closed candle available`
        );
        continue;
      }

      // Check minimum candle requirement
      if (candles.length < profile.minCandles) {
        result.skipped++;
        result.details.push({
          symbol,
          interval,
          tradingStyle,
          status: 'skipped',
          error: `Insufficient candles: ${candles.length} < ${profile.minCandles}`,
        });
        continue;
      }

      // Skip if candle data hasn't changed since last computation
      const latestCandleTs = candles[candles.length - 1].timestamp;
      const taskKey = `${symbol}:${interval}:${tradingStyle}`;
      const prevTs = existingTimestamps.get(taskKey);
      if (prevTs !== undefined && prevTs === latestCandleTs) {
        result.skipped++;
        result.details.push({
          symbol,
          interval,
          tradingStyle,
          status: 'skipped',
          error: `Candle timestamp unchanged: ${latestCandleTs}`,
        });
        continue;
      }

      // Get futures data (cached by symbol)
      let futuresData = futuresCache.get(symbol);
      if (!futuresData) {
        futuresData = await fetchFuturesDataSafe(symbol);
        futuresCache.set(symbol, futuresData);
      }

      // Compute indicators with style-specific parameters
      const indicators = computeIndicatorsForStyle(candles, symbol, interval, tradingStyle);
      const superTrend = computeSuperTrend(candles);

      // Higher-timeframe confluence from the last CLOSED confirmation bar.
      // An in-progress HTF candle must not leak its close; missing HTF data
      // degrades via weight redistribution, same as futures/sentiment.
      let htfContext: HtfContext | null = null;
      const htfInterval = getConfirmationInterval(interval, tradingStyle);
      if (htfInterval) {
        try {
          const htfKey = `${symbol}:${htfInterval}`;
          let htfCandles = candleCache.get(htfKey);
          if (!htfCandles) {
            htfCandles = await fetchCandlesForTask(symbol, htfInterval, profile.recommendedCandles, now);
            candleCache.set(htfKey, htfCandles);
          }
          const closed = dropOpenBars(htfCandles, htfInterval, now);
          if (closed.length > 0) {
            const series = computeHtfSeries(closed, profile.config);
            htfContext = htfContextAtBar(series, closed.length - 1, htfInterval);
          }
        } catch {
          // HTF data is optional
        }
      }

      // Score the signal using template weights; per-symbol news rides on
      // the shared Fear & Greed read
      const weights = weightsMap.get(tradingStyle)!;
      const taskSentiment: SentimentData | null = sentimentData
        ? { ...sentimentData, news: newsMap.get(symbol) ?? null }
        : null;
      const signal = computeSignalScore(
        indicators,
        futuresData,
        taskSentiment,
        weights,
        superTrend,
        htfContext
      );

      // Build GlobalSignal document
      const expiresAt = new Date(Date.now() + profile.signalTTLSeconds * 1000);

      // Session at decision time (candle close); null on multi-session intervals
      const session = isSessionMeaningful(interval)
        ? sessionOfCandleClose(latestCandleTs, intervalToMs(interval))
        : null;

      signalDocs.push({
        symbol: signal.symbol,
        interval: signal.interval,
        tradingStyle,
        score: signal.score,
        tier: signal.tier,
        confidence: signal.confidence,
        components: signal.components,
        // v4: scores closed bars only (candle-finalization fix); rows written
        // before it may have been scored on a still-forming bar's partial
        // values. v3: calibrated tier cutoffs (24/30); v2: htf category + session + htfContext
        configVersion: 4,
        candleTimestamp: latestCandleTs,
        session,
        htfContext: htfContext
          ? {
              interval: htfContext.interval,
              trendDirection: htfContext.trendDirection,
              candleTimestamp: htfContext.candleTimestamp,
            }
          : null,
        expiresAt,
        createdAt: new Date(),
      });

      result.computed++;
      result.details.push({ symbol, interval, tradingStyle, status: 'computed' });
    } catch (err) {
      result.errors++;
      result.details.push({
        symbol,
        interval,
        tradingStyle,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Bulk insert all computed signals
  if (signalDocs.length > 0) {
    let insertedDocs: Array<Record<string, unknown>> = [];

    try {
      insertedDocs = await GlobalSignal.insertMany(signalDocs, { ordered: false });
    } catch (err) {
      console.error('Bulk signal insert failed, falling back to individual inserts:', err);

      // Mongoose attaches the docs that succeeded before the failure to the
      // thrown error on an unordered insertMany. GlobalSignal has no unique
      // index, so blindly re-creating every doc here would duplicate the
      // ones that already made it in, and each duplicate would then get its
      // own pending outcome.
      const alreadyInserted =
        (err as { insertedDocs?: Array<Record<string, unknown>> })?.insertedDocs ?? [];
      const alreadyInsertedKeys = new Set(
        alreadyInserted.map((doc) => `${doc.symbol}:${doc.interval}:${doc.tradingStyle}`)
      );
      insertedDocs = [...alreadyInserted];

      let insertFailures = 0;
      for (const doc of signalDocs) {
        const key = `${doc.symbol}:${doc.interval}:${doc.tradingStyle}`;
        if (alreadyInsertedKeys.has(key)) continue;

        try {
          insertedDocs.push(await GlobalSignal.create(doc));
        } catch (individualErr) {
          insertFailures++;
          console.error(`Individual signal insert failed for ${doc.symbol}:`, individualErr);
        }
      }
      if (insertFailures > 0) {
        result.computed -= insertFailures;
        result.errors += insertFailures;
      }
    }

    // Record a pending outcome for every stored signal so live accuracy can
    // be measured later. Best-effort: never fails the signal batch.
    if (insertedDocs.length > 0) {
      try {
        await createPendingOutcomes(
          insertedDocs.map((doc) => ({
            _id: doc._id as string,
            symbol: doc.symbol as string,
            interval: doc.interval as string,
            tradingStyle: doc.tradingStyle as TradingStyle,
            tier: doc.tier as SignalTier,
            score: doc.score as number,
            configVersion: doc.configVersion as number,
            candleTimestamp: doc.candleTimestamp as number,
          }))
        );
      } catch (err) {
        console.error('Failed to create pending signal outcomes:', err);
      }
    }
  }

  return result;
}

/**
 * Build compute tasks for a trading style using the configured symbols and intervals.
 */
export function buildTasksForStyle(
  tradingStyle: TradingStyle,
  symbols: string[]
): ComputeTask[] {
  const profile = getStyleConfig(tradingStyle);
  const tasks: ComputeTask[] = [];

  for (const symbol of symbols) {
    for (const interval of profile.preferredIntervals) {
      tasks.push({ symbol, interval, tradingStyle });
    }
  }

  return tasks;
}
