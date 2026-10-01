import { STYLE_CONFIGS, TRADING_STYLES } from '@/lib/indicators/style-configs';
import type { TradingStyle } from '@/lib/models/signal-template';

/**
 * The desk's books: one per style AND interval, never pooled.
 *
 * A style scores more than one interval (`style-configs.ts`), and the cost of
 * a round trip is fixed while the return a trade can earn scales with the
 * holding period, so a 1m book and a 1h book are not the same experiment.
 * Pooling them would let a cheap interval hide behind an expensive one, which
 * is exactly what the user asked not to happen.
 */
export interface BookKey {
  tradingStyle: TradingStyle;
  interval: string;
}

/** `position_trading:1d` and the rest, in a stable order. */
export const DESK_BOOKS: readonly BookKey[] = TRADING_STYLES.flatMap((style) =>
  STYLE_CONFIGS[style].preferredIntervals.map((interval) => ({ tradingStyle: style, interval }))
);

export function bookId(key: BookKey): string {
  return `${key.tradingStyle}:${key.interval}`;
}

export function parseBookId(id: string): BookKey {
  const [tradingStyle, interval] = id.split(':');
  const match = DESK_BOOKS.find((b) => b.tradingStyle === tradingStyle && b.interval === interval);
  if (!match) throw new Error(`Unknown paper desk book: ${id}`);
  return match;
}

/**
 * Starting equity per (book, symbol) ledger, in USDT.
 *
 * Session 07's arithmetic: sizing only means anything once one venue lot is a
 * small fraction of the account. At about 76,000 USDT per BTC one 0.001 lot is
 * roughly 76 USDT, so 1,000 USDT leaves room for risk-based sizing to produce
 * something other than one lot or flat.
 */
export const BOOK_START_EQUITY = 1000;
