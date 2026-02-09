import mongoose, { Schema, type Document } from 'mongoose';

export interface IBacktestResult extends Document {
  userId: string;
  strategyId: string | null;
  symbol: string;
  interval: string;
  config: Record<string, unknown>;
  metrics: Record<string, unknown>;
  trades: Record<string, unknown>[];
  equityCurve: Record<string, unknown>[];
  totalBars: number;
  warmupBars: number;
  startTime: number;
  endTime: number;
  createdAt: Date;
  updatedAt: Date;
}

const backtestResultSchema = new Schema<IBacktestResult>(
  {
    userId: { type: String, required: true },
    strategyId: { type: String, default: null },
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    config: { type: Schema.Types.Mixed, required: true },
    metrics: { type: Schema.Types.Mixed, required: true },
    trades: { type: Schema.Types.Mixed, default: [] },
    equityCurve: { type: Schema.Types.Mixed, default: [] },
    totalBars: { type: Number, required: true },
    warmupBars: { type: Number, required: true },
    startTime: { type: Number, required: true },
    endTime: { type: Number, required: true },
  },
  { timestamps: true }
);

backtestResultSchema.index({ userId: 1, createdAt: -1 });
backtestResultSchema.index({ userId: 1, strategyId: 1 });

export const MAX_BACKTEST_RESULTS_PER_USER = 50;

export const BacktestResult =
  mongoose.models.BacktestResult ||
  mongoose.model<IBacktestResult>('BacktestResult', backtestResultSchema);
