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

/** Cost fields for a realistic Binance USDT-M futures study backtest at the
 * given interval: taker fee as the feePercent fallback, both explicit maker
 * and taker rates, and the interval's slippage budget. Throws on an interval
 * with no configured slippage budget. */
export function studyCostConfig(
  interval: string
): Pick<BacktestConfig, 'feePercent' | 'makerFeePercent' | 'takerFeePercent' | 'slippageBps'> {
  const slippageBps = STUDY_SLIPPAGE_BPS[interval];
  if (slippageBps === undefined) {
    throw new Error(`No slippage budget configured for interval: ${interval}`);
  }
  return {
    feePercent: BINANCE_FUTURES_TAKER_FEE,
    makerFeePercent: BINANCE_FUTURES_MAKER_FEE,
    takerFeePercent: BINANCE_FUTURES_TAKER_FEE,
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
 * Note the unit: fees are fractions (0.0005) and this returns percent, so the
 * fee term is multiplied by 100 and the bps term divided by 100.
 */
export function defaultCostPercent(interval: string): number {
  const slippageBps = STUDY_SLIPPAGE_BPS[interval];
  if (slippageBps === undefined) {
    throw new Error(`No slippage budget configured for interval: ${interval}`);
  }
  return 2 * BINANCE_FUTURES_TAKER_FEE * 100 + (2 * slippageBps) / 100;
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
