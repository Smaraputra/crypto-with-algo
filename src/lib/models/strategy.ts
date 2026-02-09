import mongoose, { Schema, type Document } from 'mongoose';

export interface IStrategy extends Document {
  userId: string;
  name: string;
  symbols: string[];
  intervals: string[];
  weights: {
    trend: number;
    momentum: number;
    volume: number;
    volatility: number;
    futures: number;
    sentiment: number;
  };
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const strategySchema = new Schema<IStrategy>(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    symbols: { type: [String], required: true },
    intervals: { type: [String], default: ['1h'] },
    weights: {
      type: {
        trend: { type: Number, default: 0.25 },
        momentum: { type: Number, default: 0.25 },
        volume: { type: Number, default: 0.15 },
        volatility: { type: Number, default: 0.10 },
        futures: { type: Number, default: 0.15 },
        sentiment: { type: Number, default: 0.10 },
      },
      default: () => ({
        trend: 0.25,
        momentum: 0.25,
        volume: 0.15,
        volatility: 0.10,
        futures: 0.15,
        sentiment: 0.10,
      }),
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

strategySchema.index({ userId: 1 });

export const MAX_STRATEGIES_PER_USER = 5;

export const Strategy =
  mongoose.models.Strategy ||
  mongoose.model<IStrategy>('Strategy', strategySchema);
