/**
 * Reconnect delay: capped exponential backoff with "equal jitter" (half the
 * ceiling fixed, half random), so a fleet of clients never retries in lockstep
 * and the delay never collapses to zero. Pure; `random` is injectable.
 *
 * Binance allows 300 connection attempts per 5 minutes per IP, so even the
 * floor (half of `baseMs`) keeps one recorder far inside the limit.
 */

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 60_000 };

/** `attempt` counts from 0 for the first retry after a failure. */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  options: BackoffOptions = DEFAULT_BACKOFF
): number {
  const exponent = Math.max(0, Math.floor(attempt));
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(ceiling / 2 + (r * ceiling) / 2);
}
