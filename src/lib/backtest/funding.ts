import type { TradeSide } from './types';

/**
 * Perpetual futures funding: pure crossing count and pnl math shared by both
 * backtest engines.
 *
 * Same value as FUNDING_INTERVAL_MS in src/lib/snapshot-backfill.ts, defined
 * here instead of imported so the worker bundle does not pull in that
 * module's network fetchers.
 */
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

/**
 * Count of funding timestamps t (integer multiples of FUNDING_INTERVAL_MS
 * since the Unix epoch, i.e. 00:00, 08:00, 16:00 UTC) with
 * prevCloseTime < t <= closeTime.
 */
export function fundingCrossings(prevCloseTime: number, closeTime: number): number {
  if (closeTime <= prevCloseTime) return 0;
  const firstCrossing = Math.floor(prevCloseTime / FUNDING_INTERVAL_MS) + 1;
  const lastCrossing = Math.floor(closeTime / FUNDING_INTERVAL_MS);
  return Math.max(0, lastCrossing - firstCrossing + 1);
}

/**
 * Signed funding pnl over `crossings` funding events on a position with the
 * given notional. Binance convention: a positive rate means longs pay
 * shorts.
 */
export function fundingPnl(
  notional: number,
  fundingRate: number,
  side: TradeSide,
  crossings: number
): number {
  const magnitude = notional * fundingRate * crossings;
  return side === 'long' ? -magnitude : magnitude;
}
