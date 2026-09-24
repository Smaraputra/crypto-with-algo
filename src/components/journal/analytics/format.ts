/**
 * Display helpers for analytics rates that may not exist.
 *
 * The analytics route returns `winRate: null` when a sample is too small to
 * state a rate (see ANALYTICS_MIN_SAMPLE_FOR_RATE). Every consumer previously
 * assumed a number and rendered `0.0%` for "no data", which reads as a loss --
 * and one panel showed `1 trades / 100%` under "By Hour (UTC)", presenting an
 * hour-of-day edge from a single observation. These keep the null handling in
 * one place so a new panel cannot reintroduce either.
 */

/** A dash, not a zero: the sample is too small to state a rate. */
export const NO_RATE = '-';

export function formatWinRate(winRate: number | null, digits = 1): string {
  return winRate === null ? NO_RATE : `${winRate.toFixed(digits)}%`;
}

/**
 * Tailwind colour for a win rate, or undefined when there is no rate to colour.
 * An absent rate must not be painted bearish, which is what a naive
 * `winRate >= 50 ? bullish : bearish` did to every suppressed row.
 */
export function winRateColorClass(winRate: number | null): string | undefined {
  if (winRate === null) return undefined;
  return winRate >= 50 ? 'text-bullish' : 'text-bearish';
}

/** Background variant of the above, for the bar in WinRateByTag. */
export function winRateBarClass(winRate: number | null): string {
  if (winRate === null) return 'bg-muted';
  return winRate >= 50 ? 'bg-bullish' : 'bg-bearish';
}
