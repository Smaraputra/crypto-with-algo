import mongoose, { Schema, type Document } from 'mongoose';
import type { TradingStyle } from './signal-template';

export interface IBacktestResultV2 extends Document {
  userId: string;
  strategyId: string | null;
  templateId: mongoose.Types.ObjectId | null;
  tradingStyle: TradingStyle;
  symbol: string;
  interval: string;

  // Config snapshot (for reproducibility)
  config: Record<string, unknown>;

  // Summary metrics (no trade array)
  metrics: Record<string, unknown>;

  // Compressed trade summary (no full trade objects)
  tradeSummary: {
    totalTrades: number;
    winningTrades: number;
    avgHoldTimeBars: number;
    bestTrade: { pnl: number; pnlPercent: number; timestamp: number };
    worstTrade: { pnl: number; pnlPercent: number; timestamp: number };
  };

  // Sampled equity curve (max 200 points)
  equityCurveSampled: Array<{ timestamp: number; equity: number }>;

  // Time range
  startTime: number;
  endTime: number;
  totalBars: number;
  warmupBars: number;

  // Optimization metadata
  optimizationGeneration: number; // 0 = manual, 1+ = optimized
  parentResultId: mongoose.Types.ObjectId | null;

  // Flags
  isOptimized: boolean;
  contributedToTemplate: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const backtestResultV2Schema = new Schema<IBacktestResultV2>(
  {
    userId: { type: String, required: true },
    strategyId: { type: String, default: null },
    templateId: { type: Schema.Types.ObjectId, default: null },
    tradingStyle: {
      type: String,
      enum: ['scalping', 'day_trading', 'swing_trading', 'position_trading'],
      required: true,
    },
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    config: { type: Schema.Types.Mixed, required: true },
    metrics: { type: Schema.Types.Mixed, required: true },
    tradeSummary: {
      totalTrades: { type: Number, required: true },
      winningTrades: { type: Number, required: true },
      avgHoldTimeBars: { type: Number, required: true },
      bestTrade: {
        pnl: Number,
        pnlPercent: Number,
        timestamp: Number,
      },
      worstTrade: {
        pnl: Number,
        pnlPercent: Number,
        timestamp: Number,
      },
    },
    equityCurveSampled: {
      type: [{ timestamp: Number, equity: Number }],
      default: [],
    },
    startTime: { type: Number, required: true },
    endTime: { type: Number, required: true },
    totalBars: { type: Number, required: true },
    warmupBars: { type: Number, required: true },
    optimizationGeneration: { type: Number, default: 0 },
    parentResultId: { type: Schema.Types.ObjectId, default: null },
    isOptimized: { type: Boolean, default: false },
    contributedToTemplate: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Indexes for query optimization
backtestResultV2Schema.index({ userId: 1, createdAt: -1 });
backtestResultV2Schema.index({ userId: 1, strategyId: 1, symbol: 1 });
backtestResultV2Schema.index({ templateId: 1, 'metrics.sharpeRatio': -1 });
backtestResultV2Schema.index({
  tradingStyle: 1,
  symbol: 1,
  interval: 1,
  'metrics.sharpeRatio': -1,
});

export const BacktestResultV2 =
  mongoose.models.BacktestResultV2 ||
  mongoose.model<IBacktestResultV2>('BacktestResultV2', backtestResultV2Schema);
