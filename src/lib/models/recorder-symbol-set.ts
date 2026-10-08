import mongoose, { Schema, type Document } from 'mongoose';

/**
 * The symbol set `scripts/ops/market-recorder.ts` chose at one refresh: the
 * top N USDT-M perpetuals (PERPETUAL, TRADING, quote USDT, underlying COIN)
 * by 24-hour quote volume, written at start and every 24 hours.
 *
 * Kept because the trade-flow universe moves: a study must know which symbols
 * were recorded on which day, and that membership was chosen by trailing
 * volume at that moment, not by hindsight. A refresh whose set is unchanged
 * still writes a row (`changed: false`), so every day has one.
 *
 * One row a day. No TTL.
 */
export interface IRecorderSymbolSet extends Document {
  /** When the ranking was fetched, epoch ms. */
  refreshedAt: number;
  topN: number;
  /** Symbols that passed the filter before ranking. */
  eligibleCount: number;
  /** In rank order, highest 24h quote volume first. */
  symbols: Array<{ symbol: string; quoteVolume: number }>;
  /**
   * False when the set equals the previous refresh's in the same process.
   * Always true on a process's first refresh, so compare consecutive rows
   * rather than trusting this flag across restarts.
   */
  changed: boolean;
}

const recorderSymbolSetSchema = new Schema<IRecorderSymbolSet>(
  {
    refreshedAt: { type: Number, required: true },
    topN: { type: Number, required: true },
    eligibleCount: { type: Number, required: true },
    symbols: {
      type: [
        new Schema(
          {
            symbol: { type: String, required: true },
            quoteVolume: { type: Number, required: true },
          },
          { _id: false }
        ),
      ],
      required: true,
    },
    changed: { type: Boolean, required: true },
  },
  { timestamps: false }
);

recorderSymbolSetSchema.index({ refreshedAt: -1 });

export const RecorderSymbolSet =
  mongoose.models.RecorderSymbolSet ||
  mongoose.model<IRecorderSymbolSet>('RecorderSymbolSet', recorderSymbolSetSchema, 'recordersymbolsets');
