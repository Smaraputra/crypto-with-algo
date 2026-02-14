import mongoose, { Document, Schema } from 'mongoose';
import type { TradingStyle } from './signal-template';

export interface ICronJobDetail {
  tradingStyle: TradingStyle;
  symbol: string;
  interval: string;
  jobId: mongoose.Types.ObjectId | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  activated: boolean; // Auto-activation occurred
  activationReason: string | null; // Why activated/not activated
}

export interface ICronRun extends Document {
  type: 'monthly_optimization';
  scheduledAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  status: 'scheduled' | 'running' | 'completed' | 'failed';

  jobs: ICronJobDetail[];

  summary: {
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    activatedTemplates: number;
  };

  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const cronJobDetailSchema = new Schema<ICronJobDetail>(
  {
    tradingStyle: {
      type: String,
      required: true,
      enum: ['scalping', 'day_trading', 'swing_trading', 'position_trading'],
    },
    symbol: { type: String, default: '' },
    interval: { type: String, default: '' },
    jobId: { type: Schema.Types.ObjectId, default: null },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    error: { type: String, default: null },
    activated: { type: Boolean, default: false },
    activationReason: { type: String, default: null },
  },
  { _id: false }
);

const cronRunSchema = new Schema<ICronRun>(
  {
    type: {
      type: String,
      required: true,
      enum: ['monthly_optimization'],
      default: 'monthly_optimization',
    },
    scheduledAt: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    status: {
      type: String,
      required: true,
      enum: ['scheduled', 'running', 'completed', 'failed'],
      default: 'scheduled',
    },
    jobs: {
      type: [cronJobDetailSchema],
      default: [],
    },
    summary: {
      type: {
        totalJobs: { type: Number, default: 0 },
        completedJobs: { type: Number, default: 0 },
        failedJobs: { type: Number, default: 0 },
        activatedTemplates: { type: Number, default: 0 },
      },
      default: {
        totalJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        activatedTemplates: 0,
      },
    },
    error: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient querying
cronRunSchema.index({ type: 1, scheduledAt: -1 });
cronRunSchema.index({ status: 1, scheduledAt: -1 });

export const CronRun =
  (mongoose.models.CronRun as mongoose.Model<ICronRun>) ||
  mongoose.model<ICronRun>('CronRun', cronRunSchema);
