import type { OHLCV } from '@/types/market';
import type { MarketSession } from '@/lib/sessions';
import { fixedFractional, kellyCriterion, riskBased } from './position-sizing';
import { applySlippage, exitFillKind, exitSlippageApplies, feeRateFor } from './cost-model';
import type { FillKind } from './cost-model';
import type {
  BacktestConfig,
  BacktestTrade,
  TradeSide,
  ExitReason,
} from './types';

export interface OpenPosition {
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  side: TradeSide;
  quantity: number;
  entryScore: number;
  entryTier: BacktestTrade['entryTier'];
  entrySession?: MarketSession | null;
  entryFillKind?: FillKind; // absent means taker (all entries today are market fills)
}

export function checkStopTakeProfit(
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

export function closeTrade(
  position: OpenPosition,
  exitPrice: number,
  exitBar: number,
  exitTime: number,
  exitReason: ExitReason,
  exitScore: number,
  trades: BacktestTrade[],
  config: BacktestConfig
): void {
  const exitKind = exitFillKind(exitReason);
  const effectiveExit = exitSlippageApplies(exitReason)
    ? applySlippage(exitPrice, position.side === 'long' ? 'sell' : 'buy', config.slippageBps)
    : exitPrice;
  const slippageCost = Math.abs(effectiveExit - exitPrice) * position.quantity;

  const entryNotional = position.quantity * position.entryPrice;
  const exitNotional = position.quantity * effectiveExit;
  const entryFee = entryNotional * feeRateFor(position.entryFillKind ?? 'taker', config);
  const exitFee = exitNotional * feeRateFor(exitKind, config);
  const fees = entryFee + exitFee;

  let pnl: number;
  if (position.side === 'long') {
    pnl = (effectiveExit - position.entryPrice) * position.quantity - fees;
  } else {
    pnl = (position.entryPrice - effectiveExit) * position.quantity - fees;
  }

  // pnlPercent is net of fees, relative to entry notional
  const pnlPercent = entryNotional > 0 ? (pnl / entryNotional) * 100 : 0;

  trades.push({
    entryBar: position.entryBar,
    exitBar,
    entryTime: position.entryTime,
    exitTime,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: effectiveExit,
    quantity: position.quantity,
    pnl,
    pnlPercent,
    fees,
    exitReason,
    entryScore: position.entryScore,
    exitScore,
    entryTier: position.entryTier,
    holdTimeBars: exitBar - position.entryBar,
    entrySession: position.entrySession ?? null,
    riskPercent: config.stopLossPercent * 100,
    slippageCost,
    entryFillKind: position.entryFillKind ?? 'taker',
    exitFillKind: exitKind,
  });
}

export function computeEquityAfterTrade(equity: number, trade: BacktestTrade): number {
  return equity + trade.pnl;
}

export function computePositionSize(
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
