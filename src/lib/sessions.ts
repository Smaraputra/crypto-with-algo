import { intervalToMs } from './intervals';

/**
 * Market session taxonomy for a 24/7 crypto market.
 *
 * Five mutually exclusive fixed-UTC buckets; the London/New York overlap is
 * promoted to a first-class session because it is the high-volume regime.
 * DST is deliberately ignored (documented v1 approximation).
 */
export const MARKET_SESSIONS = [
  'asia',
  'london',
  'ny_overlap',
  'new_york',
  'off_hours',
] as const;

export type MarketSession = (typeof MARKET_SESSIONS)[number];

export const SESSION_UTC_RANGES: Array<{
  session: MarketSession;
  startHour: number; // inclusive
  endHour: number; // exclusive
}> = [
  { session: 'asia', startHour: 0, endHour: 7 },
  { session: 'london', startHour: 7, endHour: 12 },
  { session: 'ny_overlap', startHour: 12, endHour: 16 },
  { session: 'new_york', startHour: 16, endHour: 21 },
  { session: 'off_hours', startHour: 21, endHour: 24 },
];

export const SESSION_LABELS: Record<MarketSession, string> = {
  asia: 'Asia',
  london: 'London',
  ny_overlap: 'London/NY Overlap',
  new_york: 'New York',
  off_hours: 'Off Hours',
};

export function getSession(timestampMs: number): MarketSession {
  const hour = new Date(timestampMs).getUTCHours();
  for (const range of SESSION_UTC_RANGES) {
    if (hour >= range.startHour && hour < range.endHour) {
      return range.session;
    }
  }
  // Unreachable: the ranges cover 0-24
  return 'off_hours';
}

/**
 * Session at the candle's close, when the trading decision happens.
 * Consistent between live signals and backtests.
 */
export function sessionOfCandleClose(openTimestampMs: number, intervalMs: number): MarketSession {
  return getSession(openTimestampMs + intervalMs);
}

/**
 * Sessions are only meaningful for intraday intervals up to 1h; a 4h or 1d
 * bar spans multiple sessions.
 */
export function isSessionMeaningful(interval: string): boolean {
  return intervalToMs(interval) <= intervalToMs('1h');
}
