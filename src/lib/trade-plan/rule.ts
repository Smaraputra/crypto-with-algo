import type { OHLCV } from '@/types/market';
import type { BacktestConfig } from '@/lib/backtest/types';
import type { Strategy } from '@/lib/backtest/strategy';
import { BINANCE_FUTURES_TAKER_FEE, studyCostConfig } from '@/lib/backtest/cost-model';
import { createScoreThresholdStrategy } from '@/lib/backtest/strategies/score-threshold';
import {
  DEFAULT_TEMPLATE_THRESHOLDS,
  DEFAULT_TEMPLATE_WEIGHTS,
  type TradingStyle,
} from '@/lib/models/signal-template';
import { deriveVolatilityStops, type VolatilityStops } from '@/lib/optimization/walk-forward';

/**
 * The one place the traded rule is defined.
 *
 * The rule is the composite's own: `createScoreThresholdStrategy`, the research
 * `control` family, on the research configuration
 * (scripts/research/strategy-walk-forward.ts): shorts allowed, 1% risk per
 * trade, the calibrated 29 / 7.25 levels (the same constants the live tiers
 * use; an active SignalTemplate changes only live weights, never the cutoffs),
 * study fees and slippage, and funding. Every recorded number in
 * `evidence.ts` came through this rule, so the ticket and the evidence
 * describe the same thing.
 *
 * One deliberate deviation. Research derives the stop from each walk-forward
 * window's own training bars; a live ticket has no training window, so it uses
 * the trailing STOP_WINDOW_BARS closed bars instead. `deriveVolatilityStops`
 * uses the median true range, which a single crash bar barely moves, so the
 * window length matters little once it spans a few hundred bars.
 */

/** Closed bars the stop's median true range is measured over. */
export const STOP_WINDOW_BARS = 1000;

/** Fraction of equity risked per trade, as in every research run. */
export const RISK_PER_TRADE = 0.01;

/**
 * Paper equity the ticket sizes against. Session 07 found that sizing only
 * means something once one venue lot is a small fraction of the account;
 * about 1,000 USDT satisfies that for BTCUSDT.
 */
export const DEFAULT_TICKET_EQUITY = 1000;

export const TRADE_PLAN_STRATEGY: Strategy = createScoreThresholdStrategy();

/** Median-true-range stops over the trailing window, floored at five taker round trips. */
export function stopsFor(candles: OHLCV[]): VolatilityStops {
  // N true ranges need N + 1 bars, since each reads the previous close.
  const window = candles.slice(-(STOP_WINDOW_BARS + 1));
  return deriveVolatilityStops(window, BINANCE_FUTURES_TAKER_FEE);
}

/** The research backtest configuration for one style and interval, with the given stops. */
export function tradePlanConfig(
  style: TradingStyle,
  interval: string,
  stops: Pick<VolatilityStops, 'stopLossPercent' | 'takeProfitPercent'>,
  equity: number = DEFAULT_TICKET_EQUITY
): BacktestConfig {
  const thresholds = DEFAULT_TEMPLATE_THRESHOLDS[style];
  return {
    entryThreshold: thresholds.entryThreshold,
    exitThreshold: thresholds.exitThreshold,
    shortEntryThreshold: thresholds.shortEntryThreshold,
    shortExitThreshold: thresholds.shortExitThreshold,
    weights: DEFAULT_TEMPLATE_WEIGHTS[style],
    allowShorts: true,
    positionSizing: { method: 'risk_based', riskPerTrade: RISK_PER_TRADE },
    positionSizePercent: 0.1,
    stopLossPercent: stops.stopLossPercent,
    takeProfitPercent: stops.takeProfitPercent,
    ...studyCostConfig(interval),
    fundingEnabled: true,
    startEquity: equity,
  };
}
