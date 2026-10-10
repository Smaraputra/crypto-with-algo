import { getStyleConfig, TRADING_STYLES } from '@/lib/indicators/style-configs';
import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

/**
 * How often the scheduler scores each style, from docker/crontab.template:
 * scalping every minute, day_trading every 5, swing_trading every 15,
 * position_trading hourly. Bounds how long a closed bar waits for its record.
 */
export const STYLE_CADENCE_MS: Record<TradingStyle, number> = {
  scalping: 60_000,
  day_trading: 300_000,
  swing_trading: 900_000,
  position_trading: 3_600_000,
};

/** Styles whose scheduler run scores this interval. */
export function stylesForInterval(interval: string): TradingStyle[] {
  return TRADING_STYLES.filter((style) => getStyleConfig(style).preferredIntervals.includes(interval));
}

export function isProvisionalEligible(
  symbol: string,
  interval: string,
  style: TradingStyle | null
): style is TradingStyle {
  if (!style) return false;
  if (!(SIGNAL_SYMBOLS as readonly string[]).includes(symbol)) return false;
  return stylesForInterval(interval).includes(style);
}
