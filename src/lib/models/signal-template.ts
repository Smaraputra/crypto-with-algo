import mongoose, { Schema, type Document } from 'mongoose';
import type { SignalWeights } from '@/types/signal';
import { STRATEGY_EXIT_LEVEL, TIER_BUY_CUTOFF } from '@/lib/signals/calibration';

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

/**
 * Entry and exit levels for strategies built on a style's signal.
 *
 * Every style enters exactly where its live signal reads buy or sell, so an
 * activated template trades on the tier a user sees. The previous per-style
 * levels (50/40/35/30) inverted against the measured score ranges: scalping,
 * whose scores never passed about 43, required 50 and could not trade at all,
 * while position trading entered on ordinary noise. Measurements are in
 * src/lib/signals/calibration.ts.
 */
const CALIBRATED_THRESHOLDS: ISignalTemplate['thresholds'] = {
  entryThreshold: TIER_BUY_CUTOFF,
  exitThreshold: STRATEGY_EXIT_LEVEL,
  shortEntryThreshold: -TIER_BUY_CUTOFF,
  shortExitThreshold: -STRATEGY_EXIT_LEVEL,
};

export const DEFAULT_TEMPLATE_THRESHOLDS: Record<
  TradingStyle,
  ISignalTemplate['thresholds']
> = {
  scalping: { ...CALIBRATED_THRESHOLDS },
  day_trading: { ...CALIBRATED_THRESHOLDS },
  swing_trading: { ...CALIBRATED_THRESHOLDS },
  position_trading: { ...CALIBRATED_THRESHOLDS },
};

export const SignalTemplate =
  mongoose.models.SignalTemplate ||
  mongoose.model<ISignalTemplate>('SignalTemplate', signalTemplateSchema);
