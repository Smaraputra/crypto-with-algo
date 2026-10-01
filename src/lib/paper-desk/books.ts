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

/**
 * Books the desk no longer steps, with the date and the reason. Their stored
 * ledgers and trades stay where they are; nothing is deleted.
 */
export const RETIRED_BOOKS: Readonly<Record<string, string>> = {
  'scalping:1m':
    '2026-10-01: never researched (1m was out of scope in the original plan, so there is no ' +
    'recorded evidence to read it against), and its bars carry unscored holes because ' +
    'sync-candles:1m and compute-signals:scalping share the same minute',
};

/** `position_trading:1d` and the rest, in a stable order, retired books excluded. */
export const DESK_BOOKS: readonly BookKey[] = TRADING_STYLES.flatMap((style) =>
  STYLE_CONFIGS[style].preferredIntervals.map((interval) => ({ tradingStyle: style, interval }))
).filter((key) => !(bookId(key) in RETIRED_BOOKS));

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

/**
 * How the desk's record is READ, declared 2026-10-02, before any v8 trade
 * exists, so no reading can be fitted to what the record later shows.
 *
 * - Futility may be checked at any time: once the executable track's 95%
 *   interval lies entirely below zero, the book's edge read is closed. Looking
 *   often is harmless here, because stopping on a loss cannot manufacture a
 *   false go-live.
 * - Go-live is read ONCE, when the executable track reaches the trade count
 *   below, and never before: re-checking a positive reading as trades arrive
 *   inflates the false-positive rate until something passes. It passes only if
 *   the executable track's 95% interval then lies entirely above zero (stricter
 *   than the one-sided 5% the count was sized for).
 * - The count: the trades needed to detect `deltaPercent` per trade at
 *   one-sided `alphaOneSided` with `power`, from the recorded EFFECTIVE sd of
 *   the same rule at that interval (`ControlEvidence.sdPercentEffective`),
 *   which carries the correlation of simultaneous trades across symbols.
 * - The execution read (lag cost and slippage against the model) is
 *   meaningful after `executionReadMinTrades` executable trades, whatever the
 *   edge read says: execution quality is a property of the venue, not of the
 *   rule.
 */
export const DESK_READ_RULE = {
  declaredOn: '2026-10-02',
  deltaPercent: 0.05,
  alphaOneSided: 0.05,
  power: 0.8,
  executionReadMinTrades: 30,
} as const;

