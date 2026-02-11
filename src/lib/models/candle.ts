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
  },
  { timestamps: false }
);

candleSchema.index({ symbol: 1, interval: 1, timestamp: 1 }, { unique: true });
candleSchema.index({ symbol: 1, interval: 1, timestamp: -1 });

export const VALID_INTERVALS = ['15m', '1h', '4h', '1d'] as const;
export type CandleInterval = (typeof VALID_INTERVALS)[number];

export const Candle =
  mongoose.models.Candle ||
  mongoose.model<ICandle>('Candle', candleSchema);
