import type { OHLCV } from '@/types/market';
import type { MarketSession } from '@/lib/sessions';
import type { SignalTier } from '@/types/signal';
import { fixedFractional, kellyCriterion, riskBased } from './position-sizing';
import { applySlippage, exitFillKind, exitSlippageApplies, feeRateFor } from './cost-model';
import type { FillKind } from './cost-model';
import { fundingCrossings, fundingPnl } from './funding';
import type { EntryDecision } from './strategy';
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
  entryTier: SignalTier;
  entrySession?: MarketSession | null;
  entryFillKind?: FillKind; // absent means taker (all entries today are market fills)
  fundingPnl?: number; // accumulated signed funding while open; absent means 0
  stopPrice: number; // absolute stop price
  targetPrice: number | null; // absolute target price; null means no target
  timeStopBars: number | null; // bars held before a forced exit; null means no time stop
}

/** Accrue funding for a bar the position stayed open through. Shared by both
 * engines so their funding accounting cannot diverge. `candle` is the bar
 * being closed; notional is marked to its close price. */
export function accrueFunding(
  position: OpenPosition,
  candle: OHLCV,
  prevCloseTime: number,
  closeTime: number,
  rate: number
): void {
  const crossings = fundingCrossings(prevCloseTime, closeTime);
  const notional = position.quantity * candle.close;
  position.fundingPnl = (position.fundingPnl ?? 0) + fundingPnl(notional, rate, position.side, crossings);
}

/** Checks the bar's high/low against the position's own absolute stop and
 * target prices (set at open time by the strategy's EntryDecision, or by the
 * limit order's decision on a fill). A null targetPrice never triggers.
 * Stop is checked before target, as before. */
export function checkStopTakeProfit(
  position: OpenPosition,
  candle: OHLCV
): { exitReason: ExitReason | null; exitPrice: number } {
  const { stopPrice, targetPrice } = position;

  if (position.side === 'long') {
    if (candle.low <= stopPrice) {
      return { exitReason: 'stop_loss', exitPrice: stopPrice };
    }
    if (targetPrice !== null && candle.high >= targetPrice) {
      return { exitReason: 'take_profit', exitPrice: targetPrice };
    }
  } else {
    if (candle.high >= stopPrice) {
      return { exitReason: 'stop_loss', exitPrice: stopPrice };
    }
    if (targetPrice !== null && candle.low <= targetPrice) {
      return { exitReason: 'take_profit', exitPrice: targetPrice };
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
  pnl += position.fundingPnl ?? 0;

  // pnlPercent is net of fees and funding, relative to entry notional
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
    riskPercent: (Math.abs(position.entryPrice - position.stopPrice) / position.entryPrice) * 100,
    rewardPercent:
      position.targetPrice === null
        ? null
        : (Math.abs(position.targetPrice - position.entryPrice) / position.entryPrice) * 100,
    slippageCost,
    entryFillKind: position.entryFillKind ?? 'taker',
    exitFillKind: exitKind,
    fundingCost: position.fundingPnl ? -position.fundingPnl : 0,
  });
}

export function computeEquityAfterTrade(equity: number, trade: BacktestTrade): number {
  return equity + trade.pnl;
}

/** Position size for an entry at `entryPrice` with an absolute `stopPrice`.
 * The stop is supplied by the caller (the strategy's EntryDecision) rather
 * than derived from config.stopLossPercent, so a strategy's own stop
 * distance drives risk-based and fixed-fractional sizing. */
export function computePositionSize(
  equity: number,
  entryPrice: number,
  side: TradeSide,
  config: BacktestConfig,
  trades: BacktestTrade[],
  stopPrice: number
): number {
  const sizing = config.positionSizing;
  if (!sizing || sizing.method === 'fixed_percent') {
    return (equity * config.positionSizePercent) / entryPrice;
  }

  switch (sizing.method) {
    case 'fixed_fractional':
      return fixedFractional(equity, sizing.riskPerTrade, entryPrice, stopPrice);

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
      return riskBased(equity, sizing.riskPerTrade, entryPrice, stopPrice);

    default:
      return (equity * config.positionSizePercent) / entryPrice;
  }
}

/** Builds the OpenPosition for a fill (market or limit) from a strategy's
 * EntryDecision. Shared by both engines so a fill's sizing, stop, target,
 * and time-stop bookkeeping cannot diverge between them. */
export function openPosition(
  decision: EntryDecision,
  fill: { price: number; bar: number; time: number; kind: FillKind },
  equity: number,
  config: BacktestConfig,
  trades: BacktestTrade[],
  score: number,
  tier: SignalTier,
  session: MarketSession | null
): OpenPosition {
  const quantity = computePositionSize(
    equity,
    fill.price,
    decision.side,
    config,
    trades,
    decision.stopPrice
  );

  return {
    entryBar: fill.bar,
    entryTime: fill.time,
    entryPrice: fill.price,
    side: decision.side,
    quantity,
    entryScore: score,
    entryTier: tier,
    entrySession: session,
    entryFillKind: fill.kind,
    stopPrice: decision.stopPrice,
    targetPrice: decision.targetPrice,
    timeStopBars: decision.timeStopBars ?? null,
  };
}
