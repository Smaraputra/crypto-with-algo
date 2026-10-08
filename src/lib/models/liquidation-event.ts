import mongoose, { Schema, type Document } from 'mongoose';

/**
 * One USDT-M futures liquidation order as Binance's `!forceOrder@arr` stream
 * pushed it, written by `scripts/ops/market-recorder.ts`.
 *
 * AN INCOMPLETE RECORD BY CONSTRUCTION: Binance pushes at most the latest
 * liquidation per symbol per 1,000 ms, so a burst of liquidations on one
 * symbol inside a second keeps only the last. Every vendor's liquidation feed
 * is built from this same stream and shares the limit. Counts and notionals
 * summed from this collection are a lower bound, never the market total.
 *
 * Research data, forward-only: the Binance archive keeps no liquidations, so
 * nothing before the recorder started exists anywhere. No test may use it
 * before a pre-registration with its own power calculation and read rule.
 *
 * Times are epoch ms, like every research collection here. `tradeTime` and
 * `eventTime` are Binance's clock, `receivedAt` the recorder's.
 *
 * The stream covers every symbol, not only the recorder's trade-flow universe:
 * a live run on 2026-10-07 also received USDC-quoted perps (FILUSDC, `st` 1)
 * and COIN-M contracts (FILUSD_PERP, `st` 2). `symbolType` keeps `st` so a
 * study can separate them; COIN-M quantities are contracts, not base units.
 *
 * Expected growth: tens of thousands of documents a day (a live run on
 * 2026-10-07 stored 253 in 10.8 minutes, about 34,000 a day on a quiet
 * evening; a volatile day is several times that), at 316 bytes of BSON each
 * before compression. No TTL: this is research history.
 */
export interface ILiquidationEvent extends Document {
  symbol: string;
  /** The liquidation order's side: SELL liquidates a long, BUY a short. */
  side: 'BUY' | 'SELL';
  orderType: string;
  timeInForce: string;
  origQty: number;
  price: number;
  avgPrice: number;
  status: string;
  lastFilledQty: number;
  filledAccumulatedQty: number;
  /** Binance's order trade time, epoch ms. */
  tradeTime: number;
  /** Binance's event time, epoch ms. */
  eventTime: number;
  /** When the recorder received the message, epoch ms. */
  receivedAt: number;
  /** `ps`, the pair, when the stream sends it. */
  pair: string | null;
  /** `st`: 1 = USDT-M, 2 = COIN-M, null when the stream omits it. */
  symbolType: number | null;
}

const liquidationEventSchema = new Schema<ILiquidationEvent>(
  {
    symbol: { type: String, required: true },
    side: { type: String, required: true, enum: ['BUY', 'SELL'] },
    orderType: { type: String, required: true },
    timeInForce: { type: String, required: true },
    origQty: { type: Number, required: true },
    price: { type: Number, required: true },
    avgPrice: { type: Number, required: true },
    status: { type: String, required: true },
    lastFilledQty: { type: Number, required: true },
    filledAccumulatedQty: { type: Number, required: true },
    tradeTime: { type: Number, required: true },
    eventTime: { type: Number, required: true },
    receivedAt: { type: Number, required: true },
    pair: { type: String, default: null },
    symbolType: { type: Number, default: null },
  },
  { timestamps: false }
);

// The dedupe key. A reconnect, or the overlap while the recorder swaps
// connections, can deliver the same event twice; the write is an upsert on
// this key, so the second copy is a no-op.
liquidationEventSchema.index(
  { symbol: 1, tradeTime: 1, side: 1, filledAccumulatedQty: 1 },
  { unique: true }
);
// Cross-symbol time-range reads (the unique index leads with symbol).
liquidationEventSchema.index({ tradeTime: 1 });

// No TTL: research reads the whole history (see historical-snapshot.ts).

export const LiquidationEvent =
  mongoose.models.LiquidationEvent ||
  mongoose.model<ILiquidationEvent>('LiquidationEvent', liquidationEventSchema, 'liquidationevents');
