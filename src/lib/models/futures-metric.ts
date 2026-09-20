import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Perpetual positioning and order-book state at the archive's native 5m grid.
 *
 * Every field here is one Binance already serves over REST, but only for the
 * last 30 days or so (`RECENT_FUTURES_LIMIT` in `src/lib/snapshot-backfill.ts`),
 * which is why `HistoricalSnapshot.data.longShortRatio` and `.openInterest`
 * cover 11.0% of 1h bars and nothing before 2026-03-03. The archive carries the
 * same series back to 2021, so this collection is where the history lives.
 *
 * Rows are a faithful copy of the archive grid, not of any bar interval: the
 * join onto candles happens in the research layer, where the rule is the last
 * reading at or before the bar's close.
 *
 * Every measure is optional. A missing field means the archive had no value
 * for that 5m slot, and it must stay distinguishable from a real zero: an open
 * interest of 0 and an unknown open interest are not the same reading.
 */
export interface IFuturesMetric extends Document {
  symbol: string;
  /** Unix ms, aligned to the archive's 5m grid. */
  timestamp: number;

  /** Open interest in base asset, and its notional in USDT. */
  openInterest?: number;
  openInterestValue?: number;

  /** Ratio of long to short accounts among the top traders by position. */
  topTraderAccountRatio?: number;
  /** Ratio of long to short position value among those same top traders. */
  topTraderPositionRatio?: number;
  /** Long to short account ratio across all accounts. */
  globalAccountRatio?: number;
  /** Taker buy volume over taker sell volume in the slot. */
  takerLongShortRatio?: number;

  /**
   * Order-book imbalance in [-1, 1] at 1%, 2% and 5% from mid, positive when
   * the bid side carries more notional. Averaged over the bookDepth snapshots
   * that fall inside the slot (about ten of them, one every 30 seconds).
   */
  depthImbalance1?: number;
  depthImbalance2?: number;
  depthImbalance5?: number;
  /** Total notional within 1% and 5% of mid, a liquidity level rather than a skew. */
  depthNotional1?: number;
  depthNotional5?: number;
  /** How many bookDepth snapshots the depth figures were averaged over. */
  depthSamples?: number;
}

const futuresMetricSchema = new Schema<IFuturesMetric>(
  {
    symbol: { type: String, required: true },
    timestamp: { type: Number, required: true },

    openInterest: { type: Number, required: false },
    openInterestValue: { type: Number, required: false },
    topTraderAccountRatio: { type: Number, required: false },
    topTraderPositionRatio: { type: Number, required: false },
    globalAccountRatio: { type: Number, required: false },
    takerLongShortRatio: { type: Number, required: false },

    depthImbalance1: { type: Number, required: false },
    depthImbalance2: { type: Number, required: false },
    depthImbalance5: { type: Number, required: false },
    depthNotional1: { type: Number, required: false },
    depthNotional5: { type: Number, required: false },
    depthSamples: { type: Number, required: false },
  },
  { timestamps: false }
);

// The upsert key. metrics and bookDepth are ingested separately and merge into
// the same document for a slot, so the write is a field-level $set, never a
// whole-document replace.
futuresMetricSchema.index({ symbol: 1, timestamp: 1 }, { unique: true });
futuresMetricSchema.index({ symbol: 1, timestamp: -1 });

// No TTL: see historical-snapshot.ts.

export const FuturesMetric =
  mongoose.models.FuturesMetric ||
  mongoose.model<IFuturesMetric>('FuturesMetric', futuresMetricSchema);
