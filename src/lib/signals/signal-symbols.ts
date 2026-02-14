/**
 * Top 10 symbols by 24h volume for automated signal computation.
 * All styles compute signals for these symbols on their preferred intervals.
 */
export const SIGNAL_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'LINKUSDT',
] as const;

export type SignalSymbol = (typeof SIGNAL_SYMBOLS)[number];
