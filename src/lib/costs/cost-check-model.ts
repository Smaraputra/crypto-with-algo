import { z } from 'zod';
import type { FillKind } from '@/lib/backtest/cost-model';
import type { CostCheckMarketResponse } from '@/types/cost-check';
import { monthlyCostBurn, symmetricBreakeven, type Breakeven, type CostBurn } from './breakeven';
import { costPercentOfMargin, liquidationDistancePercent } from './leverage';
import type { HoldMoveStats } from './move';
import { COST_FEE_TIERS, feeRatesFor, fundingSettlements, roundTripCost, type RoundTripCost } from './round-trip';
import { MIN_INDEPENDENT_WINDOWS, costVerdict, type CostTone } from './verdict';

/**
 * The Cost Check page's inputs and the one function that turns them, plus the
 * market facts from /api/cost-check, into everything the page shows. Pure, so
 * the page stays a thin renderer and every number on it is unit-tested here.
 */

export const MAX_LEVERAGE = 125;
export const MAX_HOLD_MINUTES = 30 * 24 * 60;
/** Flat per-side slippage when no order book could be read; the server uses the same figure. */
export const FALLBACK_SLIPPAGE_BPS = 5;

export const HOLD_PRESETS = [
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '4h', minutes: 240 },
  { label: '1d', minutes: 1440 },
  { label: '1w', minutes: 10_080 },
] as const;

const fillKind = z.enum(['taker', 'maker']);

export const costCheckInputsSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,20}USDT$/),
  side: z.enum(['long', 'short']),
  margin: z.number().positive().max(10_000_000),
  leverage: z.number().min(1).max(MAX_LEVERAGE),
  equity: z.number().positive().max(1_000_000_000).nullable(),
  feeTier: z.enum(COST_FEE_TIERS),
  customMakerPercent: z.number().min(0).max(1),
  customTakerPercent: z.number().min(0).max(1),
  entry: fillKind,
  exit: fillKind,
  holdMinutes: z.number().int().min(1).max(MAX_HOLD_MINUTES),
  tradesPerDay: z.number().min(0).max(10_000),
  slippageOverrideBps: z.number().min(0).max(1000).nullable(),
});

export type CostCheckInputs = z.infer<typeof costCheckInputsSchema>;

export const DEFAULT_INPUTS: CostCheckInputs = {
  symbol: 'BTCUSDT',
  side: 'long',
  margin: 100,
  leverage: 10,
  equity: 1000,
  feeTier: 'standard',
  customMakerPercent: 0.02,
  customTakerPercent: 0.05,
  entry: 'taker',
  exit: 'taker',
  holdMinutes: 60,
  tradesPerDay: 5,
  slippageOverrideBps: null,
};

export const STORAGE_KEY = 'cost-check:v1';

/** Saved inputs, or the defaults when storage is empty, unreadable or holds an old shape. */
export function parseStoredInputs(raw: string | null): CostCheckInputs {
  if (!raw) return DEFAULT_INPUTS;
  try {
    const parsed = costCheckInputsSchema.safeParse({ ...DEFAULT_INPUTS, ...JSON.parse(raw) });
    return parsed.success ? parsed.data : DEFAULT_INPUTS;
  } catch {
    return DEFAULT_INPUTS;
  }
}

/**
 * URL parameters win over saved inputs, so a link such as
 * /cost-check?symbol=SOLUSDT&holdMinutes=420&notional=248 opens on that
 * trade. A notional is taken at 1x leverage. Invalid values are ignored.
 */
export function applyUrlParams(inputs: CostCheckInputs, params: URLSearchParams): CostCheckInputs {
  const next = { ...inputs };
  const symbol = params.get('symbol');
  if (symbol && /^[A-Z0-9]{2,20}USDT$/.test(symbol)) next.symbol = symbol;
  const hold = Number(params.get('holdMinutes'));
  if (Number.isInteger(hold) && hold >= 1 && hold <= MAX_HOLD_MINUTES) next.holdMinutes = hold;
  const notional = Number(params.get('notional'));
  if (params.has('notional') && Number.isFinite(notional) && notional > 0 && notional <= 10_000_000) {
    next.margin = notional;
    next.leverage = 1;
  }
  const side = params.get('side');
  if (side === 'long' || side === 'short') next.side = side;
  return next;
}

export function notionalOf(inputs: Pick<CostCheckInputs, 'margin' | 'leverage'>): number {
  return inputs.margin * inputs.leverage;
}

/** "1h", "45m", "2d 4h": a hold in words for the verdict. */
export function formatHold(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}

export type VerdictState =
  | { kind: 'verdict'; tone: CostTone; breakeven: Breakeven }
  | { kind: 'thin'; independentWindows: number }
  | { kind: 'no-market' };

export interface CostCheckModel {
  notional: number;
  slippageBps: number;
  slippageSource: 'override' | 'depth' | 'fallback';
  /** The depth figure was measured for a different position size and is being re-measured. */
  slippageForOtherSize: boolean;
  settlements: number;
  roundTrip: RoundTripCost;
  /**
   * The cost the verdict is judged on: fees and slippage, plus funding only
   * when it is paid. An estimated funding receipt is shown but not credited,
   * because the rate can turn before the hold ends.
   */
  verdictCostPercent: number;
  verdictCostUsdt: number;
  move: HoldMoveStats | null;
  verdict: VerdictState;
  costPercentOfMargin: number;
  liquidationDistancePercent: number;
  burn: CostBurn;
  belowMinNotional: boolean;
  effectiveMinNotional: number | null;
}

export function computeCostCheck(
  inputs: CostCheckInputs,
  market: CostCheckMarketResponse | null,
  now: number,
  options: { slippageForOtherSize?: boolean } = {}
): CostCheckModel {
  const notional = notionalOf(inputs);
  const fees = feeRatesFor(inputs.feeTier, {
    makerPercent: inputs.customMakerPercent,
    takerPercent: inputs.customTakerPercent,
  });

  let slippageBps = FALLBACK_SLIPPAGE_BPS;
  let slippageSource: CostCheckModel['slippageSource'] = 'fallback';
  if (inputs.slippageOverrideBps !== null) {
    slippageBps = inputs.slippageOverrideBps;
    slippageSource = 'override';
  } else if (market && market.slippage.source === 'depth') {
    slippageBps = market.slippage.bps;
    slippageSource = 'depth';
  }

  const settlements = market
    ? fundingSettlements(now, inputs.holdMinutes * 60_000, market.funding.nextFundingTime, market.funding.intervalHours * 3_600_000)
    : 0;

  const roundTrip = roundTripCost({
    notional,
    side: inputs.side,
    fees,
    entry: inputs.entry as FillKind,
    exit: inputs.exit as FillKind,
    slippageBps,
    fundingRate: market ? market.funding.rate : null,
    fundingSettlements: settlements,
  });

  const verdictCostPercent = roundTrip.tradingPercent + Math.max(0, roundTrip.fundingPercent);
  const verdictCostUsdt = (notional * verdictCostPercent) / 100;
  const move = market?.move ?? null;

  let verdict: VerdictState;
  if (!market || !move) {
    verdict = market && !move ? { kind: 'thin', independentWindows: 0 } : { kind: 'no-market' };
  } else {
    const breakeven = symmetricBreakeven(verdictCostPercent, move.meanPercent);
    const tone = costVerdict(breakeven, move.independentWindows);
    verdict = tone === null ? { kind: 'thin', independentWindows: move.independentWindows } : { kind: 'verdict', tone, breakeven };
  }

  return {
    notional,
    slippageBps,
    slippageSource,
    slippageForOtherSize: slippageSource === 'depth' && options.slippageForOtherSize === true,
    settlements,
    roundTrip,
    verdictCostPercent,
    verdictCostUsdt,
    move,
    verdict,
    costPercentOfMargin: costPercentOfMargin(verdictCostPercent, inputs.leverage),
    liquidationDistancePercent: liquidationDistancePercent(inputs.leverage),
    burn: monthlyCostBurn(inputs.tradesPerDay, verdictCostUsdt, inputs.equity),
    belowMinNotional: market ? notional < market.venue.effectiveMinNotional : false,
    effectiveMinNotional: market ? market.venue.effectiveMinNotional : null,
  };
}

export { MIN_INDEPENDENT_WINDOWS };
