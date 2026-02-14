import mongoose, { Schema, type Document } from 'mongoose';

export interface ICandle extends Document {
  symbol: string;
  interval: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  expiresAt?: Date;
}

const candleSchema = new Schema<ICandle>(
  {
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    timestamp: { type: Number, required: true },
    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    volume: { type: Number, required: true },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: false }
);

candleSchema.index({ symbol: 1, interval: 1, timestamp: 1 }, { unique: true });
candleSchema.index({ symbol: 1, interval: 1, timestamp: -1 });
candleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

export const VALID_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

/** High-frequency intervals that get automatic TTL cleanup */
export const HF_INTERVALS = ['1m', '5m'] as const;
export type HFInterval = (typeof HF_INTERVALS)[number];

/** TTL durations in milliseconds for high-frequency candle cleanup */
export const HF_TTL_MS: Record<HFInterval, number> = {
  '1m': 7 * 24 * 60 * 60 * 1000,   // 7 days
  '5m': 14 * 24 * 60 * 60 * 1000,  // 14 days
};

export function isHighFrequencyInterval(interval: string): interval is HFInterval {
  return (HF_INTERVALS as readonly string[]).includes(interval);
}

export function computeExpiresAt(interval: string): Date | null {
  if (!isHighFrequencyInterval(interval)) return null;
  return new Date(Date.now() + HF_TTL_MS[interval]);
}
export type CandleInterval = (typeof VALID_INTERVALS)[number];

export const Candle =
  mongoose.models.Candle ||
  mongoose.model<ICandle>('Candle', candleSchema);
