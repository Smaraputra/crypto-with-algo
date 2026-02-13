import mongoose, { Schema, type Document } from 'mongoose';
import type { TradingStyle } from './signal-template';
import type { SignalWeights } from '@/types/signal';
import type { OptimizationProgress, OptimizationStatus } from '@/types/optimization';

export interface IOptimizationJob extends Document {
  tradingStyle: TradingStyle;
  symbol: string;
  interval: string;

  // Data range
  startTime: number;
  endTime: number;
  totalBars: number;

  // Walk-forward config
  minTrainingBars: number; // 300
  testWindowBars: number; // 100
  stepSizeBars: number; // 300

  // Optimization config
  candidatesPerWindow: number; // 50 weight sets per training window
  constraintPercent: number; // ±20% from template weights

  // Progress tracking
  status: OptimizationStatus;
  progress: OptimizationProgress;

  // Results
  optimizedWeights: SignalWeights | null;
  ensembleResults: mongoose.Types.ObjectId[]; // Top 5 backtest result IDs
  templateVersion: number | null;

  // Metadata
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const optimizationJobSchema = new Schema<IOptimizationJob>(
  {
    tradingStyle: {
      type: String,
      enum: ['scalping', 'day_trading', 'swing_trading', 'position_trading'],
      required: true,
    },
    symbol: { type: String, required: true },
    interval: { type: String, required: true },

    startTime: { type: Number, required: true },
    endTime: { type: Number, required: true },
    totalBars: { type: Number, required: true },

    minTrainingBars: { type: Number, required: true },
    testWindowBars: { type: Number, required: true },
    stepSizeBars: { type: Number, required: true },

    candidatesPerWindow: { type: Number, required: true },
    constraintPercent: { type: Number, required: true },

    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
      required: true,
    },
    progress: {
      currentWindow: { type: Number, default: 0 },
      totalWindows: { type: Number, default: 0 },
      candidatesTested: { type: Number, default: 0 },
      validResults: { type: Number, default: 0 },
    },

    optimizedWeights: {
      type: {
        trend: Number,
        momentum: Number,
        volume: Number,
        volatility: Number,
        futures: Number,
        sentiment: Number,
      },
      default: null,
    },
    ensembleResults: {
      type: [Schema.Types.ObjectId],
      default: [],
    },
    templateVersion: { type: Number, default: null },

    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Indexes for optimization job queries
optimizationJobSchema.index({ status: 1, createdAt: -1 });
optimizationJobSchema.index({ tradingStyle: 1, status: 1 });

export const OptimizationJob =
  mongoose.models.OptimizationJob ||
  mongoose.model<IOptimizationJob>('OptimizationJob', optimizationJobSchema);
