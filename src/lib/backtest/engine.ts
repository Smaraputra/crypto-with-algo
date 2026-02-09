import type { OHLCV } from '@/types/market';
import type { SuperTrendPoint } from '@/lib/indicators/supertrend';
import { computeAllIndicators } from '@/lib/indicators/compute';
import { computeSuperTrend } from '@/lib/indicators/supertrend';
import { computeSignalScore } from '@/lib/signals/scorer';
import { computeWarmupBars, interpretIndicatorsAtBar } from '@/lib/indicators/interpret-at-bar';
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

interface OpenPosition {
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  side: TradeSide;
  quantity: number;
  entryScore: number;
  entryTier: BacktestTrade['entryTier'];
}

export function runBacktest(
  candles: OHLCV[],
  config: BacktestConfig,
  symbol: string,
  interval: string,
  onProgress?: BacktestProgressCallback
): BacktestResult {
  // 1. Compute all indicators once
  const raw = computeAllIndicators(candles, symbol, interval);
  const superTrend = computeSuperTrend(candles);
  const warmup = computeWarmupBars(raw);

  const totalBars = candles.length - warmup;
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  let equity = config.startEquity;
  let peakEquity = equity;
  let position: OpenPosition | null = null;

  // 2. Iterate bar-by-bar from warmup to end
  for (let bar = warmup; bar < candles.length; bar++) {
    const candle = candles[bar];

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
    const suite = interpretIndicatorsAtBar(raw, bar, candles);
    const composite = computeSignalScore(
      suite,
      null, // no futures in backtest
      null, // no sentiment in backtest
      config.weights,
      superTrendAtBar ? { values: superTrend.values, current: superTrendAtBar } : null
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
  const metrics = computeMetrics(trades, equityCurve, config.startEquity);

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

  const pnlPercent = entryNotional > 0 ? (pnl / entryNotional) * 100 : 0;

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
  });
}

function computeEquityAfterTrade(equity: number, trade: BacktestTrade): number {
  return equity + trade.pnl;
}

function computePositionSize(
  equity: number,
  entryPrice: number,
  side: TradeSide,
  config: BacktestConfig,
  trades: BacktestTrade[]
): number {
  const sizing = config.positionSizing;
  if (!sizing || sizing.method === 'fixed_percent') {
    return (equity * config.positionSizePercent) / entryPrice;
  }

  const stopLossPrice = side === 'long'
    ? entryPrice * (1 - config.stopLossPercent)
    : entryPrice * (1 + config.stopLossPercent);

  switch (sizing.method) {
    case 'fixed_fractional':
      return fixedFractional(equity, sizing.riskPerTrade, entryPrice, stopLossPrice);

    case 'kelly': {
      const completedTrades = trades.filter((t) => t.pnl !== 0);
      if (completedTrades.length < 5) {
        // Not enough history for Kelly, fall back to fixed percent
        return (equity * config.positionSizePercent) / entryPrice;
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
      return kellyCriterion(equity, winRate, avgWin, avgLoss, entryPrice, sizing.fractionKelly ?? 0.5);
    }

    case 'risk_based':
      return riskBased(equity, sizing.riskPerTrade, entryPrice, stopLossPrice);

    default:
      return (equity * config.positionSizePercent) / entryPrice;
  }
}
