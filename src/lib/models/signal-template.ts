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
        // Optional with default 0 so pre-htf template docs stay readable
        htf: { type: Number, required: false, default: 0 },
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
// Per style, the previous six weights are scaled by (1 - htf) so an empty htf
// component reproduces pre-htf scores exactly via weight redistribution.
// position_trading has no confirmation timeframe, so its htf stays 0.
export const DEFAULT_TEMPLATE_WEIGHTS: Record<TradingStyle, SignalWeights> = {
  scalping: {
    trend: 0.085,
    momentum: 0.34,
    volume: 0.255,
    volatility: 0.1275,
    futures: 0.0425,
    sentiment: 0.00,
    htf: 0.15,
  },
  day_trading: {
    trend: 0.2125,
    momentum: 0.255,
    volume: 0.17,
    volatility: 0.085,
    futures: 0.085,
    sentiment: 0.0425,
    htf: 0.15,
  },
  swing_trading: {
    trend: 0.27,
    momentum: 0.18,
    volume: 0.09,
    volatility: 0.09,
    futures: 0.18,
    sentiment: 0.09,
    htf: 0.10,
  },
  position_trading: {
    trend: 0.35,
    momentum: 0.10,
    volume: 0.05,
    volatility: 0.05,
    futures: 0.25,
    sentiment: 0.20,
    htf: 0.00,
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
