import type { FillKind } from '@/lib/backtest/cost-model';
import type { CostCheckMarketResponse } from '@/types/cost-check';
import { symmetricBreakeven, type Breakeven } from './breakeven';
import { computeCostCheck, type CostCheckInputs } from './cost-check-model';
import type { HoldMoveStats } from './move';
import { MIN_INDEPENDENT_WINDOWS } from './verdict';

/**
 * Pre-trade round-trip cost model for the Focus page.
 *
 * Prices the coin in view across three fill combinations (taker/taker, maker/taker,
 * maker/maker) and calculates the win rate needed to break even against the typical
 * move. Pure, so the Focus page stays a thin renderer and every figure is unit-tested.
 */

export const FOCUS_FILL_PAIRS: readonly { entry: FillKind; exit: FillKind; label: string }[] = [
  { entry: 'taker', exit: 'taker', label: 'Taker in, taker out' },
  { entry: 'maker', exit: 'taker', label: 'Maker in, taker out' },
  { entry: 'maker', exit: 'maker', label: 'Maker in, maker out' },
];

export interface FocusCostRow {
  label: string;
  entry: FillKind;
  exit: FillKind;
  /** Fees plus slippage, percent of notional. Funding is reported separately, never added here. */
  costPercent: number;
  costUsdt: number;
  /** Win rate needed against the typical move; null when the move is missing or rests on too few windows. */
  breakeven: Breakeven | null;
}

export interface FocusCostFunding {
  /** Rate per settlement in percent (0.01 = 0.01%), signed as the venue reports it. */
  ratePercent: number;
  /** Who pays at the next settlement: positive rate means longs pay. Null at exactly zero. */
  payer: 'longs' | 'shorts' | null;
  /** Settlements a position opened now and held for the hold crosses. */
  settlements: number;
}

export interface FocusCost {
  notional: number;
  slippageBps: number;
  slippageSource: 'override' | 'depth' | 'fallback';
  rows: FocusCostRow[];
  move: HoldMoveStats | null;
  /** True when there is no move or it rests on fewer than MIN_INDEPENDENT_WINDOWS windows. */
  moveIsThin: boolean;
  /** Null without market data. */
  funding: FocusCostFunding | null;
  belowMinNotional: boolean;
  effectiveMinNotional: number | null;
}

export function computeFocusCost(
  inputs: CostCheckInputs,
  market: CostCheckMarketResponse | null,
  holdMinutes: number,
  now: number
): FocusCost {
  const models = FOCUS_FILL_PAIRS.map((pair) =>
    computeCostCheck({ ...inputs, holdMinutes, entry: pair.entry, exit: pair.exit }, market, now)
  );

  const move = market?.move ?? null;
  const moveIsThin = move === null || move.independentWindows < MIN_INDEPENDENT_WINDOWS;

  const rows: FocusCostRow[] = FOCUS_FILL_PAIRS.map((pair, index) => {
    const model = models[index];
    const costPercent = model.roundTrip.tradingPercent;
    const costUsdt = model.roundTrip.feeUsdt + model.roundTrip.slippageUsdt;
    const breakeven = moveIsThin ? null : symmetricBreakeven(costPercent, move.meanPercent);
    return {
      label: pair.label,
      entry: pair.entry,
      exit: pair.exit,
      costPercent,
      costUsdt,
      breakeven,
    };
  });

  const firstModel = models[0];

  let funding: FocusCostFunding | null = null;
  if (market) {
    const rate = market.funding.rate;
    const payer = rate > 0 ? 'longs' : rate < 0 ? 'shorts' : null;
    funding = {
      ratePercent: rate * 100,
      payer,
      settlements: firstModel.settlements,
    };
  }

  return {
    notional: firstModel.notional,
    slippageBps: firstModel.slippageBps,
    slippageSource: firstModel.slippageSource,
    rows,
    move,
    moveIsThin,
    funding,
    belowMinNotional: firstModel.belowMinNotional,
    effectiveMinNotional: firstModel.effectiveMinNotional,
  };
}
