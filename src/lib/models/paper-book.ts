import mongoose, { Schema, type Document } from 'mongoose';

import { TRADING_STYLES } from '@/lib/indicators/style-configs';
import type { TradingStyle } from '@/lib/models/signal-template';

/**
 * One paper book: a style at one interval.
 *
 * Global, like `GlobalSignal` and `SignalOutcome`: the desk trades the global
 * signal, so there is nothing per-user about it.
 *
 * The book owns a single cursor for all ten symbols. The desk walks bar
 * timestamps in order and, within each bar, every symbol, so a result never
 * depends on which symbol's data happened to arrive first. A per-symbol cursor
 * would reintroduce exactly that dependence.
 *
 * `leaseUntil` and `leaseOwner` make a run exclusive. `withJobRun` takes no
 * lock, and the desk's cadence is one minute while a catch-up run can take
 * longer, so two runs could otherwise process the same bar twice.
 */
export interface IPaperBook extends Document {
  tradingStyle: TradingStyle;
  interval: string;
  startEquity: number;
  /** Open time of the newest bar the desk has stepped, or null before the first run. */
  lastProcessedBarTime: number | null;
  leaseUntil: Date | null;
  leaseOwner: string | null;
  /** Bars stepped with no GlobalSignal, so the desk managed but did not decide. */
  missingScoreBars: number;
  /** Highest aggregate open notional across the book's symbols, in USDT. */
  peakNotional: number;
  /** `peakNotional` divided by the aggregate equity at that moment. */
  peakLeverage: number;
  createdAt: Date;
  updatedAt: Date;
}

const paperBookSchema = new Schema<IPaperBook>(
  {
    tradingStyle: { type: String, enum: TRADING_STYLES, required: true },
    interval: { type: String, required: true },
    startEquity: { type: Number, required: true },
    lastProcessedBarTime: { type: Number, default: null },
    leaseUntil: { type: Date, default: null },
    leaseOwner: { type: String, default: null },
    missingScoreBars: { type: Number, default: 0 },
    peakNotional: { type: Number, default: 0 },
    peakLeverage: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One book per style and interval; the desk upserts on this key.
paperBookSchema.index({ tradingStyle: 1, interval: 1 }, { unique: true });

export const PaperBook =
  (mongoose.models.PaperBook as mongoose.Model<IPaperBook>) ||
  mongoose.model<IPaperBook>('PaperBook', paperBookSchema);
