import type { OHLCV } from '@/types/market';
import type { IndicatorConfig, IndicatorSuite } from '@/lib/indicators/types';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeWarmupBars, interpretIndicatorsAtBar } from '@/lib/indicators/interpret-at-bar';
import { computeSignalScore } from '@/lib/signals/scorer';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeMetrics } from './metrics';
import { computeSnapshotCoverage } from './engine';
import { isSessionMeaningful, sessionOfCandleClose } from '@/lib/sessions';
import { intervalToMs } from '@/lib/intervals';
import { buildSnapshotSeries, type LeanSnapshot, type SnapshotBar } from './snapshot-series';
import {
  checkStopTakeProfit,
  closeTrade,
  computeEquityAfterTrade,
  computePositionSize,
  type OpenPosition,
} from './trade-utils';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  EquityPoint,
  BacktestProgressCallback,
} from './types';
import type { SuperTrendPoint } from '@/lib/indicators/supertrend';

/**
 * Pre-computed indicators for optimization
 */
export interface PreparedBacktest {
  candles: OHLCV[];
  indicators: IndicatorSuite[]; // Pre-computed for all bars
  superTrend: SuperTrendPoint[];
  warmupBars: number;
  stOffset: number;
  snapshots?: (SnapshotBar | null)[]; // index-aligned point-in-time futures/sentiment
}

/**
 * Prepare backtest: compute indicators once
 * Reuse for multiple weight candidates
 * Optional indicatorConfig allows style-specific indicator parameters
 * Optional snapshotDocs supply point-in-time futures/sentiment per bar
 */
export function prepareBacktest(
  candles: OHLCV[],
  symbol: string,
  interval: string,
  indicatorConfig?: IndicatorConfig,
  snapshotDocs?: LeanSnapshot[]
): PreparedBacktest {
  // Compute raw indicators with optional style-specific config
  const raw = computeAllIndicators(candles, symbol, interval, indicatorConfig);
  const superTrend = computeSuperTrend(candles);
  const warmup = computeWarmupBars(raw);

  // Pre-compute interpreted indicators for all bars
  const indicators: IndicatorSuite[] = [];
  for (let bar = 0; bar < candles.length; bar++) {
    const suite = interpretIndicatorsAtBar(raw, bar, candles);
    indicators.push(suite);
  }

  const stOffset = candles.length - superTrend.values.length;

  return {
    candles,
    indicators,
    superTrend: superTrend.values,
    warmupBars: warmup,
    stOffset,
    ...(snapshotDocs
      ? { snapshots: buildSnapshotSeries(candles, snapshotDocs, interval, { symbol }) }
      : {}),
  };
}

/**
 * Run backtest with pre-computed indicators
 * Only weights differ between runs
 */
export function runOptimizedBacktest(
  prepared: PreparedBacktest,
  config: BacktestConfig,
  symbol: string,
  interval: string,
  onProgress?: BacktestProgressCallback
): BacktestResult {
  const { candles, indicators, superTrend, warmupBars, stOffset, snapshots } = prepared;

  const totalBars = candles.length - warmupBars;
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  // Session tagging and entry filter (sessions only meaningful intraday)
  const sessionMeaningful = isSessionMeaningful(interval);
  const intervalMs = intervalToMs(interval);
  const sessionFilter =
    sessionMeaningful && config.allowedSessions && config.allowedSessions.length > 0
      ? new Set(config.allowedSessions)
      : null;

  let equity = config.startEquity;
  let peakEquity = equity;
  let position: OpenPosition | null = null;
  let barsWithFutures = 0;
  let barsWithSentiment = 0;

  // Iterate bar-by-bar from warmup to end
  for (let bar = warmupBars; bar < candles.length; bar++) {
    const candle = candles[bar];
    const snap = snapshots?.[bar] ?? null;
    if (snap?.futures) barsWithFutures++;
    if (snap?.sentiment) barsWithSentiment++;

    // Get SuperTrend at this bar
    const stIdx = bar - stOffset;
    const superTrendAtBar: SuperTrendPoint | undefined =
      stIdx >= 0 && stIdx < superTrend.length ? superTrend[stIdx] : undefined;

    // Check stop-loss / take-profit
    if (position) {
      const { exitReason, exitPrice } = checkStopTakeProfit(position, candle, config);
      if (exitReason) {
        closeTrade(position, exitPrice, bar, candle.timestamp, exitReason, 0, trades, config);
        equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);
        position = null;
      }
    }

    // Get pre-computed indicators for this bar
    const suite = indicators[bar];

    // Compute signal score with config weights
    const composite = computeSignalScore(
      suite,
      snap?.futures ?? null,
      snap?.sentiment ?? null,
      config.weights,
      superTrendAtBar ? { values: superTrend, current: superTrendAtBar } : null
    );

    // Check entry/exit based on signal score
    if (position) {
      // Check exit condition
      const shouldExit =
        (position.side === 'long' && composite.score <= config.exitThreshold) ||
        (position.side === 'short' && composite.score >= config.shortExitThreshold);

      if (shouldExit) {
        closeTrade(
          position,
          candle.close,
          bar,
          candle.timestamp,
          'signal',
          composite.score,
          trades,
          config
        );
        equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);
        position = null;
      }
    } else {
      // Check entry conditions; the session filter gates entries only, never exits
      const session = sessionMeaningful
        ? sessionOfCandleClose(candle.timestamp, intervalMs)
        : null;
      const sessionAllowed = !sessionFilter || (session !== null && sessionFilter.has(session));

      if (sessionAllowed && composite.score >= config.entryThreshold) {
        const quantity = computePositionSize(equity, candle.close, 'long', config, trades);
        position = {
          entryBar: bar,
          entryTime: candle.timestamp,
          entryPrice: candle.close,
          side: 'long',
          quantity,
          entryScore: composite.score,
          entryTier: composite.tier,
          entrySession: session,
        };
      } else if (sessionAllowed && config.allowShorts && composite.score <= config.shortEntryThreshold) {
        const quantity = computePositionSize(equity, candle.close, 'short', config, trades);
        position = {
          entryBar: bar,
          entryTime: candle.timestamp,
          entryPrice: candle.close,
          side: 'short',
          quantity,
          entryScore: composite.score,
          entryTier: composite.tier,
          entrySession: session,
        };
      }
    }

    // Update equity curve
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    equityCurve.push({
      bar,
      time: candle.timestamp,
      equity,
      drawdown,
    });

    // Report progress
    if (onProgress) {
      const barsProcessed = bar - warmupBars + 1;
      const progress = Math.round((barsProcessed / totalBars) * 100);
      onProgress(progress, barsProcessed, totalBars);
    }
  }

  // Close any open position at end of data
  if (position) {
    const lastCandle = candles[candles.length - 1];
    closeTrade(
      position,
      lastCandle.close,
      candles.length - 1,
      lastCandle.timestamp,
      'end_of_data',
      0,
      trades,
      config
    );
    equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);

    // Update final equity curve point
    if (equityCurve.length > 0) {
      equityCurve[equityCurve.length - 1].equity = equity;
    }
  }

  // Compute metrics
  const metrics = computeMetrics(trades, equityCurve, config.startEquity);

  return {
    symbol,
    interval,
    config,
    trades,
    equityCurve,
    metrics,
    startTime: candles[warmupBars]?.timestamp ?? candles[0].timestamp,
    endTime: candles[candles.length - 1].timestamp,
    totalBars,
    warmupBars,
    ...(snapshots
      ? { snapshotCoverage: computeSnapshotCoverage(barsWithFutures, barsWithSentiment, totalBars) }
      : {}),
  };
}
