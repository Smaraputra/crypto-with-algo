import type { BacktestResult, BacktestTrade, EquityPoint } from './types';
import type { IBacktestResultV2 } from '../models/backtest-result-v2';
import type { TradingStyle } from '../models/signal-template';
import type { Document } from 'mongoose';
import mongoose from 'mongoose';

/**
 * Sample equity curve to max 200 points
 * Uses uniform sampling to preserve shape while reducing size
 */
export function sampleEquityCurve(
  equityCurve: EquityPoint[],
  maxPoints = 200
): Array<{ timestamp: number; equity: number }> {
  if (equityCurve.length <= maxPoints) {
    return equityCurve.map(point => ({
      timestamp: point.time,
      equity: point.equity,
    }));
  }

  const sampled: Array<{ timestamp: number; equity: number }> = [];
  const step = equityCurve.length / maxPoints;

  for (let i = 0; i < maxPoints; i++) {
    const index = Math.floor(i * step);
    const point = equityCurve[index];
    sampled.push({
      timestamp: point.time,
      equity: point.equity,
    });
  }

  // Always include the last point
  const last = equityCurve[equityCurve.length - 1];
  if (sampled[sampled.length - 1].timestamp !== last.time) {
    sampled.push({
      timestamp: last.time,
      equity: last.equity,
    });
  }

  return sampled;
}

/**
 * Create trade summary from full trade array
 */
export function createTradeSummary(trades: BacktestTrade[]): IBacktestResultV2['tradeSummary'] {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      avgHoldTimeBars: 0,
      bestTrade: { pnl: 0, pnlPercent: 0, timestamp: 0 },
      worstTrade: { pnl: 0, pnlPercent: 0, timestamp: 0 },
    };
  }

  const winningTrades = trades.filter(t => t.pnl > 0).length;

  // Calculate avgHoldTimeBars from holdTimeBars field
  const avgHoldTimeBars = trades.reduce((sum, t) => sum + t.holdTimeBars, 0) / trades.length;

  // Find best and worst trades
  let bestTrade = trades[0];
  let worstTrade = trades[0];

  for (const trade of trades) {
    if (trade.pnl > bestTrade.pnl) {
      bestTrade = trade;
    }
    if (trade.pnl < worstTrade.pnl) {
      worstTrade = trade;
    }
  }

  return {
    totalTrades: trades.length,
    winningTrades,
    avgHoldTimeBars,
    bestTrade: {
      pnl: bestTrade.pnl,
      pnlPercent: bestTrade.pnlPercent,
      timestamp: bestTrade.entryTime,
    },
    worstTrade: {
      pnl: worstTrade.pnl,
      pnlPercent: worstTrade.pnlPercent,
      timestamp: worstTrade.entryTime,
    },
  };
}

/**
 * Convert BacktestResult to compressed V2 format
 */
export function compressBacktestResult(
  result: BacktestResult,
  userId: string,
  strategyId: string | null,
  tradingStyle: TradingStyle,
  templateId: string | null = null,
  optimizationGeneration = 0,
  parentResultId: string | null = null
): Omit<IBacktestResultV2, keyof Document | 'createdAt' | 'updatedAt'> {
  return {
    userId,
    strategyId,
    templateId: templateId ? (templateId as unknown as mongoose.Types.ObjectId) : null,
    tradingStyle,
    symbol: result.symbol,
    interval: result.interval,
    config: result.config as unknown as Record<string, unknown>,
    metrics: result.metrics as unknown as Record<string, unknown>,
    tradeSummary: createTradeSummary(result.trades),
    equityCurveSampled: sampleEquityCurve(result.equityCurve),
    startTime: result.startTime,
    endTime: result.endTime,
    totalBars: result.totalBars,
    warmupBars: result.warmupBars,
    optimizationGeneration,
    parentResultId: parentResultId ? (parentResultId as unknown as mongoose.Types.ObjectId) : null,
    isOptimized: optimizationGeneration > 0,
    contributedToTemplate: false,
  } as Omit<IBacktestResultV2, keyof Document | 'createdAt' | 'updatedAt'>;
}
