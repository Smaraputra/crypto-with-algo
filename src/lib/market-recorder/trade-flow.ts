import type { AggTrade } from './messages';

/**
 * Folds aggregate trades into five-minute taker-flow bars, and decides which
 * bars are complete. Pure: no I/O and no clock; every time is passed in.
 * `src/lib/models/trade-flow-bar.ts` documents what each field means.
 *
 * COMPLETENESS is tracked per symbol as "covered since": the moment a
 * connection subscribed to the symbol opened. A bar is born complete only if
 * its symbol was covered since at least `marginMs` before the bucket opened,
 * and is marked incomplete when coverage breaks before the bucket closed (plus
 * the margin). The margin absorbs the gap between Binance's trade clock, which
 * buckets are keyed on, and the local clock, which coverage is measured on.
 *
 * DEDUPE: the recorder briefly runs two connections while it swaps them, so
 * the same aggregate trade can arrive twice, in either order. Each symbol
 * keeps a ring of its most recent aggregate ids; a repeat is dropped.
 */

export const BUCKET_MS = 5 * 60_000;
/** A bar is drained this long after its bucket closes, so late trades still land. */
export const FLUSH_GRACE_MS = 30_000;
/** Coverage margin for clock skew and stream latency. */
export const COVERAGE_MARGIN_MS = 2_000;
/** Notional (USDT) below this is a small trade. */
export const SMALL_TRADE_MAX_USDT = 10_000;
/** Notional (USDT) at or above this is a large trade. */
export const LARGE_TRADE_MIN_USDT = 100_000;

export type SizeClass = 'Small' | 'Medium' | 'Large';

export function bucketStartOf(tradeTime: number): number {
  return tradeTime - (((tradeTime % BUCKET_MS) + BUCKET_MS) % BUCKET_MS);
}

export function sizeClassOf(notional: number): SizeClass {
  if (notional < SMALL_TRADE_MAX_USDT) return 'Small';
  if (notional < LARGE_TRADE_MIN_USDT) return 'Medium';
  return 'Large';
}

/** `m` true: the buyer was the maker, so the taker (aggressor) sold. */
export function aggressorOf(buyerIsMaker: boolean): 'buy' | 'sell' {
  return buyerIsMaker ? 'sell' : 'buy';
}

export interface TradeFlowBarRecord {
  symbol: string;
  bucketStart: number;
  trades: number;
  aggTrades: number;
  buyBase: number;
  sellBase: number;
  buyQuote: number;
  sellQuote: number;
  buyQuoteSmall: number;
  sellQuoteSmall: number;
  buyQuoteMedium: number;
  sellQuoteMedium: number;
  buyQuoteLarge: number;
  sellQuoteLarge: number;
  firstPrice: number;
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
  firstAggId: number;
  lastAggId: number;
  complete: boolean;
}

/** Fields summed when two parts of one bucket are merged. */
export const SUMMED_BAR_FIELDS = [
  'trades',
  'aggTrades',
  'buyBase',
  'sellBase',
  'buyQuote',
  'sellQuote',
  'buyQuoteSmall',
  'sellQuoteSmall',
  'buyQuoteMedium',
  'sellQuoteMedium',
  'buyQuoteLarge',
  'sellQuoteLarge',
] as const satisfies readonly (keyof TradeFlowBarRecord)[];

/** A bounded set of recently seen ids: membership plus FIFO eviction. */
export class RecentIds {
  private readonly ring: (number | undefined)[];
  private readonly seen = new Set<number>();
  private next = 0;

  constructor(private readonly capacity: number) {
    this.ring = new Array<number | undefined>(capacity);
  }

  /** True when `id` was new (and is now remembered), false when it was a repeat. */
  add(id: number): boolean {
    if (this.seen.has(id)) return false;
    const evicted = this.ring[this.next];
    if (evicted !== undefined) this.seen.delete(evicted);
    this.ring[this.next] = id;
    this.seen.add(id);
    this.next = (this.next + 1) % this.capacity;
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface TradeFlowAggregatorOptions {
  /** Hard cap on bars held in memory. Past it a trade opening a new bar is dropped. */
  maxOpenBars: number;
  /** Aggregate ids remembered per symbol for dedupe. */
  dedupeCapacity: number;
  marginMs: number;
}

export const DEFAULT_AGGREGATOR_OPTIONS: TradeFlowAggregatorOptions = {
  maxOpenBars: 10_000,
  dedupeCapacity: 1_024,
  marginMs: COVERAGE_MARGIN_MS,
};

export type AddResult = 'added' | 'duplicate' | 'overflow';

export class TradeFlowAggregator {
  private readonly bars = new Map<string, TradeFlowBarRecord>();
  private readonly recent = new Map<string, RecentIds>();
  private readonly coveredSince = new Map<string, number>();
  private readonly options: TradeFlowAggregatorOptions;

  constructor(options: Partial<TradeFlowAggregatorOptions> = {}) {
    this.options = { ...DEFAULT_AGGREGATOR_OPTIONS, ...options };
  }

  /** Coverage begins for each symbol not already covered. */
  setCovered(symbols: readonly string[], since: number): void {
    for (const symbol of symbols) {
      if (!this.coveredSince.has(symbol)) this.coveredSince.set(symbol, since);
    }
  }

  /**
   * Coverage for these symbols ended at `at`: every open bar of theirs whose
   * bucket had not closed (plus the margin) by then is incomplete.
   */
  breakCoverage(symbols: readonly string[], at: number): void {
    if (symbols.length === 0) return;
    const broken = new Set(symbols);
    for (const symbol of broken) this.coveredSince.delete(symbol);
    for (const bar of this.bars.values()) {
      if (broken.has(bar.symbol) && bar.bucketStart + BUCKET_MS + this.options.marginMs > at) {
        bar.complete = false;
      }
    }
  }

  /** Symbols currently covered. */
  coveredSymbols(): string[] {
    return [...this.coveredSince.keys()];
  }

  /** Drops dedupe state for symbols outside `symbols`, so it cannot grow with churn. */
  retainDedupe(symbols: readonly string[]): void {
    const keep = new Set(symbols);
    for (const symbol of this.recent.keys()) {
      if (!keep.has(symbol)) this.recent.delete(symbol);
    }
  }

  add(trade: AggTrade): AddResult {
    let recent = this.recent.get(trade.symbol);
    if (!recent) {
      recent = new RecentIds(this.options.dedupeCapacity);
      this.recent.set(trade.symbol, recent);
    }
    if (!recent.add(trade.aggId)) return 'duplicate';

    const bucketStart = bucketStartOf(trade.tradeTime);
    const key = `${trade.symbol}|${bucketStart}`;
    let bar = this.bars.get(key);

    if (!bar) {
      if (this.bars.size >= this.options.maxOpenBars) return 'overflow';
      const since = this.coveredSince.get(trade.symbol);
      bar = {
        symbol: trade.symbol,
        bucketStart,
        trades: 0,
        aggTrades: 0,
        buyBase: 0,
        sellBase: 0,
        buyQuote: 0,
        sellQuote: 0,
        buyQuoteSmall: 0,
        sellQuoteSmall: 0,
        buyQuoteMedium: 0,
        sellQuoteMedium: 0,
        buyQuoteLarge: 0,
        sellQuoteLarge: 0,
        firstPrice: trade.price,
        lastPrice: trade.price,
        highPrice: trade.price,
        lowPrice: trade.price,
        firstAggId: trade.aggId,
        lastAggId: trade.aggId,
        complete: since !== undefined && since <= bucketStart - this.options.marginMs,
      };
      this.bars.set(key, bar);
    }

    const notional = trade.price * trade.qty;
    const size = sizeClassOf(notional);

    bar.trades += trade.lastTradeId - trade.firstTradeId + 1;
    bar.aggTrades += 1;
    if (aggressorOf(trade.buyerIsMaker) === 'buy') {
      bar.buyBase += trade.qty;
      bar.buyQuote += notional;
      bar[`buyQuote${size}`] += notional;
    } else {
      bar.sellBase += trade.qty;
      bar.sellQuote += notional;
      bar[`sellQuote${size}`] += notional;
    }

    // By id, not arrival order: two connections can interleave.
    if (trade.aggId < bar.firstAggId) {
      bar.firstAggId = trade.aggId;
      bar.firstPrice = trade.price;
    }
    if (trade.aggId > bar.lastAggId) {
      bar.lastAggId = trade.aggId;
      bar.lastPrice = trade.price;
    }
    if (trade.price > bar.highPrice) bar.highPrice = trade.price;
    if (trade.price < bar.lowPrice) bar.lowPrice = trade.price;

    return 'added';
  }

  /** Removes and returns every bar whose bucket closed at least FLUSH_GRACE_MS before `now`. */
  drainClosed(now: number): TradeFlowBarRecord[] {
    return this.drain((bar) => bar.bucketStart + BUCKET_MS + FLUSH_GRACE_MS <= now);
  }

  /** Removes and returns every bar, closed or not (shutdown). */
  drainAll(): TradeFlowBarRecord[] {
    return this.drain(() => true);
  }

  get openBars(): number {
    return this.bars.size;
  }

  private drain(predicate: (bar: TradeFlowBarRecord) => boolean): TradeFlowBarRecord[] {
    const out: TradeFlowBarRecord[] = [];
    for (const [key, bar] of this.bars) {
      if (predicate(bar)) {
        out.push({ ...bar });
        this.bars.delete(key);
      }
    }
    return out.sort((a, b) => a.bucketStart - b.bucketStart || a.symbol.localeCompare(b.symbol));
  }
}
