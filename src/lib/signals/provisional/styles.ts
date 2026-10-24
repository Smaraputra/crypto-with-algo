import { scoredIntervals, TRADING_STYLES } from '@/lib/indicators/style-configs';
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

/** Styles whose scheduler run still scores this interval (retired intervals excluded). */
export function stylesForInterval(interval: string): TradingStyle[] {
  return TRADING_STYLES.filter((style) => scoredIntervals(style).includes(interval));
}

/** The style whose calls a chart at this interval shows: the user's pick at 1d, else the first scored style. */
export function resolveStyle(interval: string, chosen: TradingStyle | null = null): TradingStyle | null {
  const styles = stylesForInterval(interval);
  if (interval === '1d' && chosen && styles.includes(chosen)) return chosen;
  return styles[0] ?? null;
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
