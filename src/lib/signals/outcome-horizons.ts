import type { TradingStyle } from '@/lib/models/signal-template';
import { intervalToMs } from '@/lib/intervals';

/**
 * How many closed bars ahead of a signal's candle price is measured, per
 * trading style. Used to record a pending outcome and to know when it can
 * be resolved from stored candles.
 */
export const OUTCOME_HORIZON_BARS: Record<TradingStyle, number> = {
  scalping: 12,
  day_trading: 24,
  swing_trading: 30,
  position_trading: 20,
};

/**
 * Wall-clock time at which an outcome can be resolved: the timestamp at
 * which the horizon bar itself has closed. The horizon bar's open time is
 * candleTimestamp + horizonBars * intervalMs, so its close time is one more
 * interval beyond that.
 */
export function resolveAtFor(
  candleTimestamp: number,
  interval: string,
  horizonBars: number
): number {
  return candleTimestamp + (horizonBars + 1) * intervalToMs(interval);
}
