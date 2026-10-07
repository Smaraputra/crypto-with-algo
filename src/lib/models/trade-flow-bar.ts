import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Five-minute taker flow for one USDT-M perpetual, folded from Binance's
 * `<symbol>@aggTrade` stream by `scripts/ops/market-recorder.ts`
 * (`src/lib/market-recorder/trade-flow.ts` does the folding). Raw trades are
 * never stored.
 *
 * Research data, forward-only: no test may use it before a pre-registration
 * with its own power calculation and read rule.
 *
 * SIDE: an aggregate trade with `m` (buyer is maker) true was a taker SELL,
 * false a taker BUY. `buy*` fields are taker-buy flow, `sell*` taker-sell.
 *
 * SIZE: each aggregate trade is classed by its own notional (price times
 * quantity, USDT): small below 10,000, medium 10,000 to below 100,000, large
 * 100,000 and above. An aggregate trade is the fills of one taker order at one
 * price inside 100 ms, so it approximates, but is not, one parent order.
 *
 * COMPLETENESS: `complete` is false when the recorder was not subscribed to
 * this symbol for the whole bucket (a disconnect, a process restart, the
 * symbol joining or leaving the top-N set), judged with a 2-second margin for
 * clock skew. A bucket with no document at all was not recorded: a top-50
 * perpetual never goes five minutes without a trade, so a missing bar is a gap,
 * never zero volume. `recordergaps` says when and why.
 *
 * BOUNDARIES: an aggregate trade is bucketed whole by its trade time `T`, so
 * one whose fills straddle a boundary lands in one bucket, and a bar can
 * differ from Binance's 5m kline by a few fills. Checked live for BTCUSDT
 * 2026-10-07 17:10 UTC: high, low, last price and taker-buy base and quote
 * matched the kline exactly; sell base was 0.008 BTC lower (of 86.98) and the
 * fill count 2 higher. The kline's open, 83,491.9, is a fill of a taker-sell
 * aggregate stamped 17:09:59.944 that the recorder put in the previous bucket,
 * so `firstPrice` read 83,492.
 *
 * `segments` counts separately flushed parts merged into this document (a
 * late trade, or the two halves either side of a restart); the merge rule is
 * in `src/lib/market-recorder/store.ts`.
 *
 * Expected growth: 288 buckets a day per symbol, so about 14,400 documents a
 * day at 50 symbols, at 424 bytes of BSON each (measured), about 6 MB a day
 * before compression. No TTL.
 */
export interface ITradeFlowBar extends Document {
  symbol: string;
  /** Bucket open, epoch ms UTC, a multiple of 300,000. By trade time. */
  bucketStart: number;
  /** Individual fills (sum of last - first trade id + 1), comparable to a kline's count. */
  trades: number;
  /** Aggregate-trade messages. */
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
  /** Price of the lowest aggregate trade id in the bucket. */
  firstPrice: number;
  /** Price of the highest aggregate trade id in the bucket. */
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
  firstAggId: number;
  lastAggId: number;
  complete: boolean;
  segments: number;
}

const tradeFlowBarSchema = new Schema<ITradeFlowBar>(
  {
    symbol: { type: String, required: true },
    bucketStart: { type: Number, required: true },
    trades: { type: Number, required: true },
    aggTrades: { type: Number, required: true },
    buyBase: { type: Number, required: true },
    sellBase: { type: Number, required: true },
    buyQuote: { type: Number, required: true },
    sellQuote: { type: Number, required: true },
    buyQuoteSmall: { type: Number, required: true },
    sellQuoteSmall: { type: Number, required: true },
    buyQuoteMedium: { type: Number, required: true },
    sellQuoteMedium: { type: Number, required: true },
    buyQuoteLarge: { type: Number, required: true },
    sellQuoteLarge: { type: Number, required: true },
    firstPrice: { type: Number, required: true },
    lastPrice: { type: Number, required: true },
    highPrice: { type: Number, required: true },
    lowPrice: { type: Number, required: true },
    firstAggId: { type: Number, required: true },
    lastAggId: { type: Number, required: true },
    complete: { type: Boolean, required: true },
    segments: { type: Number, required: true, default: 1 },
  },
  { timestamps: false }
);

// The upsert key.
tradeFlowBarSchema.index({ symbol: 1, bucketStart: 1 }, { unique: true });
// Cross-sectional reads: every symbol at one time.
tradeFlowBarSchema.index({ bucketStart: 1 });

// No TTL: research reads the whole history (see historical-snapshot.ts).

export const TradeFlowBar =
  mongoose.models.TradeFlowBar ||
  mongoose.model<ITradeFlowBar>('TradeFlowBar', tradeFlowBarSchema, 'tradeflowbars');
