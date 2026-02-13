import mongoose, { Schema, type Document } from 'mongoose';
import type { TradingStyle } from './signal-template';

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
  tradingStyle: TradingStyle;
  templateId: mongoose.Types.ObjectId | null;
  autoOptimize: boolean;
  lastOptimizedAt: Date | null;
  optimizationMetrics: {
    backtestsRun: number;
    bestSharpe: number;
    currentGeneration: number;
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
    tradingStyle: {
      type: String,
      enum: ['scalping', 'day_trading', 'swing_trading', 'position_trading'],
      default: 'day_trading',
    },
    templateId: { type: Schema.Types.ObjectId, default: null },
    autoOptimize: { type: Boolean, default: false },
    lastOptimizedAt: { type: Date, default: null },
    optimizationMetrics: {
      type: {
        backtestsRun: { type: Number, default: 0 },
        bestSharpe: { type: Number, default: 0 },
        currentGeneration: { type: Number, default: 0 },
      },
      default: () => ({
        backtestsRun: 0,
        bestSharpe: 0,
        currentGeneration: 0,
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
