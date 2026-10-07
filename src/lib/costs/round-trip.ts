import { resolveFeeProfile, type FillKind } from '@/lib/backtest/cost-model';

/**
 * Pre-trade round-trip cost of one Binance USDT-M perpetual trade, for any
 * user and any symbol. Pure and client-safe: the Cost Check page recomputes
 * it on every keystroke, and the trade plan card reads the same arithmetic.
 *
 * Units: fee rates are fractions per side (0.0005), slippage is in basis
 * points per taker leg, and every result is reported both in USDT and in
 * percent of the position's notional.
 */

/** The fee schedules a user can pick. The promotional research profile is
 * deliberately absent: it prices USDT-M pairs at a schedule they cannot get
 * (see FEE_PROFILES in cost-model.ts). */
export const COST_FEE_TIERS = ['standard', 'bnb', 'custom'] as const;
export type CostFeeTier = (typeof COST_FEE_TIERS)[number];

/** Fee rates as fractions per side. */
export interface FeeRates {
  makerFee: number;
  takerFee: number;
}

/** Converts a fee typed as a percent (0.05) to the fraction per side (0.0005). */
export function percentToFraction(percent: number): number {
  return percent / 100;
}

/**
 * The fee rates a tier charges. `custom` takes the user's own maker and
 * taker fees, typed in PERCENT as Binance's fee page shows them.
 */
export function feeRatesFor(tier: CostFeeTier, customPercent?: { makerPercent: number; takerPercent: number }): FeeRates {
  if (tier === 'custom') {
    if (!customPercent) throw new Error('A custom fee tier needs maker and taker percentages');
    return {
      makerFee: percentToFraction(customPercent.makerPercent),
      takerFee: percentToFraction(customPercent.takerPercent),
    };
  }
  const profile = resolveFeeProfile(tier);
  return { makerFee: profile.makerFee, takerFee: profile.takerFee };
}

export interface RoundTripInput {
  /** Position notional in USDT (margin times leverage). */
  notional: number;
  side: 'long' | 'short';
  fees: FeeRates;
  entry: FillKind;
  exit: FillKind;
  /** Slippage per taker leg in basis points; maker legs rest on the book and do not slip. */
  slippageBps: number;
  /** Funding rate per settlement as a fraction; positive means longs pay shorts. Null when unknown. */
  fundingRate: number | null;
  /** Settlements the position is expected to cross while held. */
  fundingSettlements: number;
}

export interface RoundTripCost {
  feeUsdt: number;
  slippageUsdt: number;
  /** Signed: positive is paid, negative is received. Zero when the rate is unknown. */
  fundingUsdt: number;
  totalUsdt: number;
  feePercent: number;
  slippagePercent: number;
  fundingPercent: number;
  totalPercent: number;
  /** Fees and slippage only, the part that does not depend on the funding estimate. */
  tradingPercent: number;
}

function legFee(kind: FillKind, fees: FeeRates): number {
  return kind === 'maker' ? fees.makerFee : fees.takerFee;
}

function legSlippage(kind: FillKind, slippageBps: number): number {
  return kind === 'taker' ? slippageBps / 10_000 : 0;
}

export function roundTripCost(input: RoundTripInput): RoundTripCost {
  const feeFraction = legFee(input.entry, input.fees) + legFee(input.exit, input.fees);
  const slippageFraction = legSlippage(input.entry, input.slippageBps) + legSlippage(input.exit, input.slippageBps);
  const paid = (input.fundingRate ?? 0) * input.fundingSettlements;
  const fundingFraction = input.side === 'long' ? paid : -paid;

  const feePercent = feeFraction * 100;
  const slippagePercent = slippageFraction * 100;
  const fundingPercent = fundingFraction * 100;
  const tradingPercent = feePercent + slippagePercent;
  const totalPercent = tradingPercent + fundingPercent;

  return {
    feeUsdt: input.notional * feeFraction,
    slippageUsdt: input.notional * slippageFraction,
    fundingUsdt: input.notional * fundingFraction,
    totalUsdt: (input.notional * totalPercent) / 100,
    feePercent,
    slippagePercent,
    fundingPercent,
    totalPercent,
    tradingPercent,
  };
}

/**
 * Funding settlements a position opened at `now` and held for `holdMs`
 * crosses: settlement times nextFundingTime + k x intervalMs (k >= 0) with
 * now < t <= now + holdMs. Uses the symbol's own interval (many alts settle
 * every 4h or 1h), which is why it does not reuse `fundingCrossings`: that
 * one assumes the fixed 8h 00/08/16 UTC grid the backtests were recorded on.
 */
export function fundingSettlements(now: number, holdMs: number, nextFundingTime: number, intervalMs: number): number {
  if (!(intervalMs > 0) || !(holdMs > 0)) return 0;
  let first = nextFundingTime;
  if (first <= now) first += Math.ceil((now - first + 1) / intervalMs) * intervalMs;
  const end = now + holdMs;
  if (first > end) return 0;
  return Math.floor((end - first) / intervalMs) + 1;
}
