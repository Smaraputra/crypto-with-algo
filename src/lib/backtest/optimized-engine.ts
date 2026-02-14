import type { OHLCV } from '@/types/market';
import type { IndicatorConfig, IndicatorSuite } from '@/lib/indicators/types';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeWarmupBars, interpretIndicatorsAtBar } from '@/lib/indicators/interpret-at-bar';
import { computeSignalScore } from '@/lib/signals/scorer';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeMetrics } from './metrics';
import { fixedFractional, kellyCriterion, riskBased } from './position-sizing';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  EquityPoint,
  TradeSide,
  ExitReason,
  BacktestProgressCallback,
} from './types';
import type { SuperTrendPoint } from '@/lib/indicators/supertrend';

interface OpenPosition {
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  side: TradeSide;
  quantity: number;
  entryScore: number;
  entryTier: BacktestTrade['entryTier'];
}

/**
 * Pre-computed indicators for optimization
 */
export interface PreparedBacktest {
  candles: OHLCV[];
  indicators: IndicatorSuite[]; // Pre-computed for all bars
  superTrend: SuperTrendPoint[];
  warmupBars: number;
  stOffset: number;
}

/**
 * Prepare backtest: compute indicators once
 * Reuse for multiple weight candidates
 * Optional indicatorConfig allows style-specific indicator parameters
 */
export function prepareBacktest(
  candles: OHLCV[],
  symbol: string,
  interval: string,
  indicatorConfig?: IndicatorConfig
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
  const { candles, indicators, superTrend, warmupBars, stOffset } = prepared;

  const totalBars = candles.length - warmupBars;
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  let equity = config.startEquity;
  let peakEquity = equity;
  let position: OpenPosition | null = null;

  // Iterate bar-by-bar from warmup to end
  for (let bar = warmupBars; bar < candles.length; bar++) {
    const candle = candles[bar];

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
      null, // no futures in backtest
      null, // no sentiment in backtest
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
      // Check entry conditions
      if (composite.score >= config.entryThreshold) {
        const quantity = computePositionSize(equity, candle.close, 'long', config, trades);
        position = {
          entryBar: bar,
          entryTime: candle.timestamp,
          entryPrice: candle.close,
          side: 'long',
          quantity,
          entryScore: composite.score,
          entryTier: composite.tier,
        };
      } else if (config.allowShorts && composite.score <= config.shortEntryThreshold) {
        const quantity = computePositionSize(equity, candle.close, 'short', config, trades);
        position = {
          entryBar: bar,
          entryTime: candle.timestamp,
          entryPrice: candle.close,
          side: 'short',
          quantity,
          entryScore: composite.score,
          entryTier: composite.tier,
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
  };
}

function checkStopTakeProfit(
  position: OpenPosition,
  candle: OHLCV,
  config: BacktestConfig
): { exitReason: ExitReason | null; exitPrice: number } {
  if (position.side === 'long') {
    const slPrice = position.entryPrice * (1 - config.stopLossPercent);
    const tpPrice = position.entryPrice * (1 + config.takeProfitPercent);

    if (candle.low <= slPrice) {
      return { exitReason: 'stop_loss', exitPrice: slPrice };
    }
    if (candle.high >= tpPrice) {
      return { exitReason: 'take_profit', exitPrice: tpPrice };
    }
  } else {
    const slPrice = position.entryPrice * (1 + config.stopLossPercent);
    const tpPrice = position.entryPrice * (1 - config.takeProfitPercent);

    if (candle.high >= slPrice) {
      return { exitReason: 'stop_loss', exitPrice: slPrice };
    }
    if (candle.low <= tpPrice) {
      return { exitReason: 'take_profit', exitPrice: tpPrice };
    }
  }

  return { exitReason: null, exitPrice: 0 };
}

function closeTrade(
  position: OpenPosition,
  exitPrice: number,
  exitBar: number,
  exitTime: number,
  exitReason: ExitReason,
  exitScore: number,
  trades: BacktestTrade[],
  config: BacktestConfig
): void {
  const entryNotional = position.quantity * position.entryPrice;
  const exitNotional = position.quantity * exitPrice;
  const entryFee = entryNotional * config.feePercent;
  const exitFee = exitNotional * config.feePercent;
  const fees = entryFee + exitFee;

  let pnl: number;
  if (position.side === 'long') {
    pnl = (exitPrice - position.entryPrice) * position.quantity - fees;
  } else {
    pnl = (position.entryPrice - exitPrice) * position.quantity - fees;
  }

  const pnlPercent =
    position.side === 'long'
      ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;

  trades.push({
    entryBar: position.entryBar,
    exitBar,
    entryTime: position.entryTime,
    exitTime,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    pnl,
    pnlPercent,
    fees,
    exitReason,
    entryScore: position.entryScore,
    exitScore,
    entryTier: position.entryTier,
    holdTimeBars: exitBar - position.entryBar,
  });
}

function computeEquityAfterTrade(currentEquity: number, trade: BacktestTrade): number {
  return currentEquity + trade.pnl;
}

function computePositionSize(
  equity: number,
  price: number,
  side: TradeSide,
  config: BacktestConfig,
  trades: BacktestTrade[]
): number {
  const sizing = config.positionSizing;
  if (!sizing || sizing.method === 'fixed_percent') {
    return (equity * config.positionSizePercent) / price;
  }

  const stopLossPrice = side === 'long'
    ? price * (1 - config.stopLossPercent)
    : price * (1 + config.stopLossPercent);

  switch (sizing.method) {
    case 'fixed_fractional':
      return fixedFractional(equity, sizing.riskPerTrade, price, stopLossPrice);

    case 'kelly': {
      const completedTrades = trades.filter((t) => t.pnl !== 0);
      if (completedTrades.length < 5) {
        // Not enough history for Kelly, fall back to fixed percent
        return (equity * config.positionSizePercent) / price;
      }
      const wins = completedTrades.filter((t) => t.pnl > 0);
      const losses = completedTrades.filter((t) => t.pnl < 0);
      const winRate = wins.length / completedTrades.length;
      const avgWin = wins.length > 0
        ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length
        : 0;
      const avgLoss = losses.length > 0
        ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length
        : -1;
      return kellyCriterion(equity, winRate, avgWin, avgLoss, price, sizing.fractionKelly ?? 0.5);
    }

    case 'risk_based':
      return riskBased(equity, sizing.riskPerTrade, price, stopLossPrice);

    default:
      return (equity * config.positionSizePercent) / price;
  }
}
