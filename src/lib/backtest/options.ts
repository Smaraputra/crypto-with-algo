export const BINANCE_WS_INTERVALS: Record<string, string> = {
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

/** Milliseconds per bar for each interval, used to compute startTime for N bars */
export const INTERVAL_MS: Record<string, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

export const DATA_RANGE_OPTIONS = [
  { label: '500 bars', value: 'legacy', months: 0 },
  { label: '3 months', value: '3m', months: 3 },
  { label: '6 months', value: '6m', months: 6 },
  { label: '1 year', value: '1y', months: 12 },
  { label: '2 years', value: '2y', months: 24 },
  { label: '3 years', value: '3y', months: 36 },
  { label: '5 years', value: '5y', months: 60 },
] as const;

export type DataRange = (typeof DATA_RANGE_OPTIONS)[number]['value'];
