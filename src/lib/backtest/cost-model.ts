import type { BacktestConfig, ExitReason } from './types';

/** How an order filled: 'maker' rests on the book (limit), 'taker' crosses the
 * spread (market or a limit that immediately fills). Maker fills pay the
 * lower fee and do not slip; taker fills pay the higher fee and slip against
 * the trader. */
export type FillKind = 'maker' | 'taker';

// Binance USDT-M futures standard (non-VIP) fee tiers, fraction per side.
export const BINANCE_FUTURES_MAKER_FEE = 0.0002; // 0.02%
export const BINANCE_FUTURES_TAKER_FEE = 0.0005; // 0.05%

/** Slippage budget, in basis points, applied to taker fills for a study
 * backtest. Shorter intervals move faster relative to book depth and get a
 * wider allowance. */
export const STUDY_SLIPPAGE_BPS: Record<string, number> = {
  '1m': 5,
  '5m': 5,
  '15m': 3,
  '1h': 3,
  '4h': 2,
  '1d': 2,
};

export type FeeProfileName = 'standard' | 'bnb' | 'promo-btc-eth-2026-07';

/** A fee schedule the study can price under. Fractions per side. */
export interface FeeProfile {
  name: FeeProfileName;
  makerFee: number;
  takerFee: number;
  /** When set, the profile applies to these symbols only; any other symbol
   * (or a call with no symbol) resolves to `fallback`. */
  symbols?: readonly string[];
  fallback?: FeeProfileName;
  note: string;
}

export const FEE_PROFILES: Record<FeeProfileName, FeeProfile> = {
  standard: {
    name: 'standard',
    makerFee: BINANCE_FUTURES_MAKER_FEE,
    takerFee: BINANCE_FUTURES_TAKER_FEE,
    note: 'Binance USDT-M VIP 0, fees paid in USDT. Every recorded research number is on this schedule.',
  },
  bnb: {
    name: 'bnb',
    makerFee: 0.00018,
    takerFee: 0.00045,
    note: 'VIP 0 with the 10% discount for paying fees in BNB.',
  },
  'promo-btc-eth-2026-07': {
    name: 'promo-btc-eth-2026-07',
    makerFee: 0,
    takerFee: 0.00036,
    symbols: ['BTCUSDT', 'ETHUSDT'],
    fallback: 'bnb',
    note:
      'Binance Futures promotion from 2026-07-02 10:00 UTC "until further notice": 0 maker fee for all users, ' +
      '20% taker discount (0.036% with BNB) regular through VIP 3. Announced for "BTCU and ETHU" U-margined ' +
      'perpetuals; whether that is BTCUSDT/ETHUSDT was not verified from a primary source as of 2026-09-26. ' +
      'A sensitivity profile, never the selection profile.',
  },
};

export const DEFAULT_FEE_PROFILE: FeeProfileName = 'standard';
export const FEE_PROFILE_NAMES: readonly FeeProfileName[] = ['standard', 'bnb', 'promo-btc-eth-2026-07'];

export function isFeeProfileName(value: string): value is FeeProfileName {
  return (FEE_PROFILE_NAMES as readonly string[]).includes(value);
}

/** The schedule a symbol actually pays under a profile. A symbol-scoped
 * profile hands every other symbol, and a call with no symbol, to its
 * fallback, so an alt can never be priced at a promotion it does not get. */
export function resolveFeeProfile(profile: FeeProfileName = DEFAULT_FEE_PROFILE, symbol?: string): FeeProfile {
  const candidate = FEE_PROFILES[profile];
  if (!candidate) throw new Error(`Unknown fee profile: ${String(profile)}`);
  if (candidate.symbols && (symbol === undefined || !candidate.symbols.includes(symbol))) {
    if (!candidate.fallback) throw new Error(`Fee profile ${profile} is symbol-scoped and has no fallback`);
    return FEE_PROFILES[candidate.fallback];
  }
  return candidate;
}

export interface StudyCostOptions {
  profile?: FeeProfileName;
  symbol?: string;
}

/** Cost fields for a realistic Binance USDT-M futures study backtest at the
 * given interval: taker fee as the feePercent fallback, both explicit maker
 * and taker rates from the resolved fee profile (default `standard`), and
 * the interval's slippage budget. Throws on an interval with no configured
 * slippage budget. */
export function studyCostConfig(
  interval: string,
  options: StudyCostOptions = {}
): Pick<BacktestConfig, 'feePercent' | 'makerFeePercent' | 'takerFeePercent' | 'slippageBps'> {
  const slippageBps = STUDY_SLIPPAGE_BPS[interval];
  if (slippageBps === undefined) {
    throw new Error(`No slippage budget configured for interval: ${interval}`);
  }
  const fees = resolveFeeProfile(options.profile, options.symbol);
  return {
    feePercent: fees.takerFee,
    makerFeePercent: fees.makerFee,
    takerFeePercent: fees.takerFee,
    slippageBps,
  };
}

/**
 * Round-trip cost estimate in PERCENT for a taker-in, taker-out trade at the
 * given interval: both fee legs plus the interval's slippage budget on both.
 *
 * Lives here rather than beside its callers because its inputs
 * (BINANCE_FUTURES_TAKER_FEE, STUDY_SLIPPAGE_BPS) do, and because it now has
 * two readers -- scripts/ops/live-outcomes.ts and the calibration analytics
 * the admin dashboard reads. A second copy is how the CLI report and the
 * dashboard would silently come to disagree about what "net" means.
 *
 * The fee schedule comes from the resolved fee profile (default
 * `standard`). Note the unit: fees are fractions (0.0005) and this returns
 * percent, so the fee term is multiplied by 100 and the bps term divided by
 * 100.
 */
export function defaultCostPercent(interval: string, options: StudyCostOptions = {}): number {
  const slippageBps = STUDY_SLIPPAGE_BPS[interval];
  if (slippageBps === undefined) {
    throw new Error(`No slippage budget configured for interval: ${interval}`);
  }
  const fees = resolveFeeProfile(options.profile, options.symbol);
  return 2 * fees.takerFee * 100 + (2 * slippageBps) / 100;
}

/** Fee rate for a fill of the given kind. Falls back to config.feePercent
 * when the specific maker/taker rate is not configured, so legacy configs
 * behave exactly as before. */
export function feeRateFor(kind: FillKind, config: BacktestConfig): number {
  if (kind === 'maker') {
    return config.makerFeePercent ?? config.feePercent;
  }
  return config.takerFeePercent ?? config.feePercent;
}

/** Moves price against the trader by slippageBps: a buy fills higher, a sell
 * fills lower. Undefined or zero slippage returns the price unchanged. */
export function applySlippage(
  price: number,
  direction: 'buy' | 'sell',
  slippageBps: number | undefined
): number {
  if (!slippageBps) return price;
  const factor = slippageBps / 10000;
  return direction === 'buy' ? price * (1 + factor) : price * (1 - factor);
}

/** take_profit exits fill at a resting limit order (maker); every other exit
 * reason crosses the book (taker). */
export function exitFillKind(reason: ExitReason): FillKind {
  return reason === 'take_profit' ? 'maker' : 'taker';
}

/** Whether an exit reason's fill is subject to slippage. stop_loss, signal,
 * and time_stop exits cross the book at an unknown price and slip;
 * take_profit fills at its resting limit price and end_of_data is a
 * mark-to-model close, so neither slips. */
export function exitSlippageApplies(reason: ExitReason): boolean {
  return reason === 'stop_loss' || reason === 'signal' || reason === 'time_stop';
}
