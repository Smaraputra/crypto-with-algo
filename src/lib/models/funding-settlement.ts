import mongoose, { Schema, type Document } from 'mongoose';

/**
 * One USDT-M perpetual funding settlement, exactly as the data.binance.vision
 * `fundingRate` archive records it.
 *
 * Why a collection of its own when `HistoricalSnapshot.data.fundingRate` already
 * carries funding: the snapshot pass forward-fills each settlement onto every
 * 1h/4h/1d bar and discards the settlement interval, so a 1d bar keeps one of
 * its three settlements and a symbol whose interval Binance shortened to 4h is
 * mis-timed. The funding carry test (review 2026-10-01) has to collect each
 * settlement a held position actually crossed, at the rate that actually
 * settled, which only a per-settlement series can give.
 *
 * `fundingTime` is the settlement boundary: the archive's `calc_time` lands
 * 1 ms after it, so it is rounded to the nearest hour. `rawTime` keeps the
 * archive value so the rounding can be audited.
 */
export interface IFundingSettlement extends Document {
  symbol: string;
  /** The settlement boundary, ms UTC, `calc_time` rounded to the hour. */
  fundingTime: number;
  /** The archive's own `calc_time`, ms UTC. */
  rawTime: number;
  /** The settled rate as a fraction (0.0001 is 0.01%). Positive: longs pay shorts. */
  rate: number;
  /** Hours between settlements as the archive states it; null when the column is empty. */
  intervalHours: number | null;
}

const fundingSettlementSchema = new Schema<IFundingSettlement>(
  {
    symbol: { type: String, required: true },
    fundingTime: { type: Number, required: true },
    rawTime: { type: Number, required: true },
    rate: { type: Number, required: true },
    intervalHours: { type: Number, default: null },
  },
  { timestamps: false }
);

// The upsert key: re-ingesting a month rewrites the same documents.
fundingSettlementSchema.index({ symbol: 1, fundingTime: 1 }, { unique: true });

// No TTL: research reads the whole history (see historical-snapshot.ts).

export const FundingSettlement =
  mongoose.models.FundingSettlement ||
  mongoose.model<IFundingSettlement>('FundingSettlement', fundingSettlementSchema);
