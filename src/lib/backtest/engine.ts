import type { OHLCV } from '@/types/market';
import type { SuperTrendPoint } from '@/lib/indicators/supertrend';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeSignalScore } from '@/lib/signals/scorer';
import { computeWarmupBars, interpretIndicatorsAtBar } from '@/lib/indicators/interpret-at-bar';
import { computeMetrics } from './metrics';
import { isSessionMeaningful, sessionOfCandleClose } from '@/lib/sessions';
import { intervalToMs } from '@/lib/intervals';
import { prepareHtf, type HtfInput } from './optimized-engine';
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
  SnapshotCoverage,
} from './types';
import type { SnapshotBar } from './snapshot-series';

export function runBacktest(
  candles: OHLCV[],
  config: BacktestConfig,
  symbol: string,
  interval: string,
  onProgress?: BacktestProgressCallback,
  snapshots?: (SnapshotBar | null)[],
  htfInput?: HtfInput
): BacktestResult {
  // 1. Compute all indicators once
  const raw = computeAllIndicators(candles, symbol, interval);
  const superTrend = computeSuperTrend(candles);
  const warmup = computeWarmupBars(raw);
  const htf = htfInput ? prepareHtf(candles, interval, htfInput) : undefined;

  const totalBars = candles.length - warmup;
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

  // 2. Iterate bar-by-bar from warmup to end
  for (let bar = warmup; bar < candles.length; bar++) {
    const candle = candles[bar];
    const snap = snapshots?.[bar] ?? null;
    if (snap?.futures) barsWithFutures++;
    if (snap?.sentiment) barsWithSentiment++;

    // Get SuperTrend at this bar
    const stOffset = candles.length - superTrend.values.length;
    const stIdx = bar - stOffset;
    const superTrendAtBar: SuperTrendPoint | undefined =
      stIdx >= 0 && stIdx < superTrend.values.length
        ? superTrend.values[stIdx]
        : undefined;

    // 2a. Check stop-loss / take-profit against candle high/low
    if (position) {
      const { exitReason, exitPrice } = checkStopTakeProfit(
        position,
        candle,
        config
      );
      if (exitReason) {
        closeTrade(
          position,
          exitPrice,
          bar,
          candle.timestamp,
          exitReason,
          0, // exit score not meaningful for SL/TP
          trades,
          config
        );
        equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);
        position = null;
      }
    }

    // 2b. Interpret indicators at this bar
    // Higher-timeframe context from the last CLOSED HTF bar at this LTF bar
    const htfBar = htf ? htf.ltfToHtf[bar] : -1;
    const htfCtx = htf && htfBar >= 0 ? htf.contextAtHtfBar[htfBar] : null;

    const suite = interpretIndicatorsAtBar(raw, bar, candles);
    const composite = computeSignalScore(
      suite,
      snap?.futures ?? null,
      snap?.sentiment ?? null,
      config.weights,
      superTrendAtBar ? { values: superTrend.values, current: superTrendAtBar } : null,
      htfCtx
    );

    // 2c. Check entry/exit based on signal score
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

    // 2d. Update equity curve
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    equityCurve.push({
      bar,
      time: candle.timestamp,
      equity,
      drawdown,
    });

    // 2e. Report progress
    if (onProgress) {
      const barsProcessed = bar - warmup + 1;
      const progress = Math.round((barsProcessed / totalBars) * 100);
      onProgress(progress, barsProcessed, totalBars);
    }
  }

  // 3. Close any open position at end of data
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

  // 4. Compute metrics
  const metrics = computeMetrics(trades, equityCurve, config.startEquity, interval);

  return {
    symbol,
    interval,
    config,
    trades,
    equityCurve,
    metrics,
    startTime: candles[warmup]?.timestamp ?? candles[0].timestamp,
    endTime: candles[candles.length - 1].timestamp,
    totalBars,
    warmupBars: warmup,
    ...(snapshots
      ? { snapshotCoverage: computeSnapshotCoverage(barsWithFutures, barsWithSentiment, totalBars) }
      : {}),
  };
}

export function computeSnapshotCoverage(
  barsWithFutures: number,
  barsWithSentiment: number,
  scoredBars: number
): SnapshotCoverage {
  return {
    barsWithFutures,
    barsWithSentiment,
    scoredBars,
    futuresPercent: scoredBars > 0 ? Math.round((barsWithFutures / scoredBars) * 100) : 0,
    sentimentPercent: scoredBars > 0 ? Math.round((barsWithSentiment / scoredBars) * 100) : 0,
  };
}
