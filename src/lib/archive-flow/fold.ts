import { bucketStartOf, sizeClassOf, aggressorOf } from '@/lib/market-recorder/trade-flow';
import type { AggTrade } from './agg-trades';

/** The first seconds of a bucket whose flow is tracked separately: [bucketStart, bucketStart + this). */
export const OPEN_WINDOW_MS = 10_000;

/**
 * One folded 5-minute bucket. Field names match `ITradeFlowBar` wherever that
 * model has the same quantity; no price is kept.
 */
export interface FlowBucket {
  bucketStart: number;
  /** Individual fills (sum of last - first trade id + 1). */
  trades: number;
  /** Aggregate-trade rows. */
  aggTrades: number;
  buyBase: number;
  sellBase: number;
  buyQuote: number;
  sellQuote: number;
  buyQuoteSmall: number;
  buyQuoteMedium: number;
  buyQuoteLarge: number;
  sellQuoteSmall: number;
  sellQuoteMedium: number;
  sellQuoteLarge: number;
  /** Taker flow of trades with bucketStart <= time < bucketStart + 10,000 ms. */
  buyQuoteOpen10s: number;
  sellQuoteOpen10s: number;
}

function emptyBucket(bucketStart: number): FlowBucket {
  return {
    bucketStart,
    trades: 0,
    aggTrades: 0,
    buyBase: 0,
    sellBase: 0,
    buyQuote: 0,
    sellQuote: 0,
    buyQuoteSmall: 0,
    buyQuoteMedium: 0,
    buyQuoteLarge: 0,
    sellQuoteSmall: 0,
    sellQuoteMedium: 0,
    sellQuoteLarge: 0,
    buyQuoteOpen10s: 0,
    sellQuoteOpen10s: 0,
  };
}

/**
 * Folds time-ordered aggregate trades into 5-minute buckets keyed by trade
 * time, using the live recorder's own bucket, side and size functions.
 *
 * Files are ordered by aggregate id, which is nearly but not exactly time
 * order, so a trade older than the open bucket's own start cannot be placed
 * (that bucket was already emitted). Such a row is counted in `outOfOrder`
 * and left out, never dropped silently; the caller must treat a nonzero count
 * as a defect. A trade a little older than the previous one but inside the
 * open bucket is folded normally.
 */
export class FlowFolder {
  private open: FlowBucket | null = null;
  /** Rows older than the open bucket, left out of every bucket. */
  outOfOrder = 0;
  /** Rows folded into a bucket. */
  rows = 0;

  /** Add one trade; returns the buckets this trade completed (zero or one). */
  add(trade: AggTrade): FlowBucket[] {
    const start = bucketStartOf(trade.transactTime);
    const emitted: FlowBucket[] = [];

    if (this.open && start < this.open.bucketStart) {
      this.outOfOrder++;
      return emitted;
    }
    if (!this.open || start > this.open.bucketStart) {
      if (this.open) emitted.push(this.open);
      this.open = emptyBucket(start);
    }

    const bucket = this.open;
    const quote = trade.price * trade.quantity;
    const side = aggressorOf(trade.isBuyerMaker);
    const cls = sizeClassOf(quote);
    const inOpenWindow = trade.transactTime - start < OPEN_WINDOW_MS;

    bucket.trades += trade.lastTradeId - trade.firstTradeId + 1;
    bucket.aggTrades += 1;
    if (side === 'buy') {
      bucket.buyBase += trade.quantity;
      bucket.buyQuote += quote;
      bucket[`buyQuote${cls}`] += quote;
      if (inOpenWindow) bucket.buyQuoteOpen10s += quote;
    } else {
      bucket.sellBase += trade.quantity;
      bucket.sellQuote += quote;
      bucket[`sellQuote${cls}`] += quote;
      if (inOpenWindow) bucket.sellQuoteOpen10s += quote;
    }
    this.rows++;
    return emitted;
  }

  /** Emit the open bucket, if any. Call once after the last trade. */
  flush(): FlowBucket[] {
    const last = this.open;
    this.open = null;
    return last ? [last] : [];
  }
}
