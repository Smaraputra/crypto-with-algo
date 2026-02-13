import mongoose, { Schema, type Document } from 'mongoose';
import type { SignalWeights } from '@/types/signal';

export type TradingStyle = 'scalping' | 'day_trading' | 'swing_trading' | 'position_trading';

export interface ISignalTemplate extends Document {
  tradingStyle: TradingStyle;
  version: number;
  weights: SignalWeights;
  thresholds: {
    entryThreshold: number;
    exitThreshold: number;
    shortEntryThreshold: number;
    shortExitThreshold: number;
  };
  performanceMetrics: {
    avgSharpe: number;
    avgWinRate: number;
    totalBacktests: number;
    lastOptimizedAt: Date;
  };
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const signalTemplateSchema = new Schema<ISignalTemplate>(
  {
    tradingStyle: {
      type: String,
      enum: ['scalping', 'day_trading', 'swing_trading', 'position_trading'],
      required: true,
    },
    version: { type: Number, required: true, default: 1 },
    weights: {
      type: {
        trend: { type: Number, required: true },
        momentum: { type: Number, required: true },
        volume: { type: Number, required: true },
        volatility: { type: Number, required: true },
        futures: { type: Number, required: true },
        sentiment: { type: Number, required: true },
      },
      required: true,
    },
    thresholds: {
      type: {
        entryThreshold: { type: Number, required: true },
        exitThreshold: { type: Number, required: true },
        shortEntryThreshold: { type: Number, required: true },
        shortExitThreshold: { type: Number, required: true },
      },
      required: true,
    },
    performanceMetrics: {
      avgSharpe: { type: Number, default: 0 },
      avgWinRate: { type: Number, default: 0 },
      totalBacktests: { type: Number, default: 0 },
      lastOptimizedAt: { type: Date, default: null },
    },
    active: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Indexes for template queries
signalTemplateSchema.index({ tradingStyle: 1, version: -1 });
signalTemplateSchema.index({ tradingStyle: 1, active: 1 });

// Default weight profiles per trading style
export const DEFAULT_TEMPLATE_WEIGHTS: Record<TradingStyle, SignalWeights> = {
  scalping: {
    trend: 0.10,
    momentum: 0.40,
    volume: 0.30,
    volatility: 0.15,
    futures: 0.05,
    sentiment: 0.00,
  },
  day_trading: {
    trend: 0.25,
    momentum: 0.30,
    volume: 0.20,
    volatility: 0.10,
    futures: 0.10,
    sentiment: 0.05,
  },
  swing_trading: {
    trend: 0.30,
    momentum: 0.20,
    volume: 0.10,
    volatility: 0.10,
    futures: 0.20,
    sentiment: 0.10,
  },
  position_trading: {
    trend: 0.35,
    momentum: 0.10,
    volume: 0.05,
    volatility: 0.05,
    futures: 0.25,
    sentiment: 0.20,
  },
};

// Default thresholds per trading style
export const DEFAULT_TEMPLATE_THRESHOLDS: Record<
  TradingStyle,
  ISignalTemplate['thresholds']
> = {
  scalping: {
    entryThreshold: 50, // Higher threshold for scalping (more selective)
    exitThreshold: 10,
    shortEntryThreshold: -50,
    shortExitThreshold: -10,
  },
  day_trading: {
    entryThreshold: 40,
    exitThreshold: 10,
    shortEntryThreshold: -40,
    shortExitThreshold: -10,
  },
  swing_trading: {
    entryThreshold: 35,
    exitThreshold: 5,
    shortEntryThreshold: -35,
    shortExitThreshold: -5,
  },
  position_trading: {
    entryThreshold: 30, // Lower threshold (longer-term trends)
    exitThreshold: 0,
    shortEntryThreshold: -30,
    shortExitThreshold: 0,
  },
};

export const SignalTemplate =
  mongoose.models.SignalTemplate ||
  mongoose.model<ISignalTemplate>('SignalTemplate', signalTemplateSchema);
