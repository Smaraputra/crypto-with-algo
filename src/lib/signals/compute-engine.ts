import type { TradingStyle } from '@/lib/models/signal-template';
import { DEFAULT_TEMPLATE_WEIGHTS } from '@/lib/models/signal-template';
import { SignalTemplate } from '@/lib/models/signal-template';
import { GlobalSignal } from '@/lib/models/global-signal';
import { getCandles } from '@/lib/candle-ingestion';
import { fetchKlines } from '@/lib/binance';
import { fetchFundingRate, fetchLongShortRatio } from '@/lib/binance-futures';
import { computeIndicatorsForStyle } from '@/lib/indicators/compute-for-style';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeSignalScore } from '@/lib/signals/scorer';
import { fetchFearAndGreed } from '@/lib/external/fear-greed';
import { getStyleConfig } from '@/lib/indicators/style-configs';
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
 */
async function fetchCandlesForTask(
  symbol: string,
  interval: string,
  recommendedCandles: number
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
      return fetchKlines(symbol, interval, recommendedCandles);
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
      return template.weights as SignalWeights;
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

  const result: ComputeResult = { computed: 0, errors: 0, skipped: 0, details: [] };

  // Fetch sentiment once for all tasks
  const sentimentData: SentimentData | null = await fetchFearAndGreed().catch(() => null);

  // Deduplicate candle fetches by (symbol, interval)
  const candleCache = new Map<string, OHLCV[]>();
  const futuresCache = new Map<string, FuturesData>();

  // Pre-fetch weights for all styles used in this batch
  const stylesNeeded = new Set(tasks.map((t) => t.tradingStyle));
  const weightsMap = new Map<TradingStyle, SignalWeights>();
  for (const style of stylesNeeded) {
    weightsMap.set(style, await getWeightsForStyle(style));
  }

  // Process each task
  const signalDocs: Array<Record<string, unknown>> = [];

  for (const task of tasks) {
    const { symbol, interval, tradingStyle } = task;
    const profile = getStyleConfig(tradingStyle);

    try {
      // Get candles (cached by symbol+interval)
      const candleKey = `${symbol}:${interval}`;
      let candles = candleCache.get(candleKey);
      if (!candles) {
        candles = await fetchCandlesForTask(symbol, interval, profile.recommendedCandles);
        candleCache.set(candleKey, candles);
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

      // Get futures data (cached by symbol)
      let futuresData = futuresCache.get(symbol);
      if (!futuresData) {
        futuresData = await fetchFuturesDataSafe(symbol);
        futuresCache.set(symbol, futuresData);
      }

      // Compute indicators with style-specific parameters
      const indicators = computeIndicatorsForStyle(candles, symbol, interval, tradingStyle);
      const superTrend = computeSuperTrend(candles);

      // Score the signal using template weights
      const weights = weightsMap.get(tradingStyle)!;
      const signal = computeSignalScore(indicators, futuresData, sentimentData, weights, superTrend);

      // Build GlobalSignal document
      const expiresAt = new Date(Date.now() + profile.signalTTLSeconds * 1000);

      signalDocs.push({
        symbol: signal.symbol,
        interval: signal.interval,
        tradingStyle,
        score: signal.score,
        tier: signal.tier,
        confidence: signal.confidence,
        components: signal.components,
        configVersion: 1,
        candleTimestamp: candles[candles.length - 1].timestamp,
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
    try {
      await GlobalSignal.insertMany(signalDocs, { ordered: false });
    } catch (err) {
      console.error('Bulk signal insert failed, falling back to individual inserts:', err);
      let insertFailures = 0;
      for (const doc of signalDocs) {
        try {
          await GlobalSignal.create(doc);
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
