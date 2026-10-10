import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Five-minute taker flow for one USDT-M perpetual, folded from Binance's public
 * monthly aggTrades archive by `scripts/ops/ingest-agg-flow.ts`. Raw trades are
 * never stored.
 *
 * Research only: nothing in the live path reads or writes it. The live
 * recorder's equivalent is `TradeFlowBar` (`src/lib/models/trade-flow-bar.ts`),
 * and the definitions are the same because the folder reuses the recorder's own
 * `bucketStartOf`, `sizeClassOf` and `aggressorOf`: buckets are keyed by trade
 * time, `buy*` is taker-buy flow (buyer is not the maker), `sell*` taker-sell,
 * and small, medium and large are the same 10,000 and 100,000 USDT cuts on each
 * aggregate trade's own notional. See that model for the full caveats.
 *
 * Differences from `TradeFlowBar`: no price fields and no `complete` or
 * `segments` (a bucket with no document is a gap in the archive, never zero
 * volume), plus `source` (the archive file the bucket came from) and the two
 * `*Open10s` fields: taker buy and sell quote of the trades whose time falls in
 * the bucket's first 10 seconds, [bucketStart, bucketStart + 10,000 ms).
 *
 * No TTL: research reads the whole history.
 */
export interface IArchiveFlowBar extends Document {
  symbol: string;
  /** Bucket open, epoch ms UTC, a multiple of 300,000. By trade time. */
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
  /** Taker-buy quote of trades in the bucket's first 10 seconds. */
  buyQuoteOpen10s: number;
  /** Taker-sell quote of trades in the bucket's first 10 seconds. */
  sellQuoteOpen10s: number;
  /** Archive file name the bucket was folded from, e.g. BTCUSDT-aggTrades-2024-03.zip. */
  source: string;
}

const num = { type: Number, required: true } as const;

const archiveFlowBarSchema = new Schema<IArchiveFlowBar>(
  {
    symbol: { type: String, required: true },
    bucketStart: num,
    trades: num,
    aggTrades: num,
    buyBase: num,
    sellBase: num,
    buyQuote: num,
    sellQuote: num,
    buyQuoteSmall: num,
    buyQuoteMedium: num,
    buyQuoteLarge: num,
    sellQuoteSmall: num,
    sellQuoteMedium: num,
    sellQuoteLarge: num,
    buyQuoteOpen10s: num,
    sellQuoteOpen10s: num,
    source: { type: String, required: true },
  },
  { timestamps: false }
);

// The upsert key.
archiveFlowBarSchema.index({ symbol: 1, bucketStart: 1 }, { unique: true });

export const ArchiveFlowBar =
  mongoose.models.ArchiveFlowBar ||
  mongoose.model<IArchiveFlowBar>('ArchiveFlowBar', archiveFlowBarSchema, 'archiveflowbars');
