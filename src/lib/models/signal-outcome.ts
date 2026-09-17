import mongoose, { Schema, type Document, type Types } from 'mongoose';

import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_TIERS, type SignalTier } from '@/types/signal';

export type SignalOutcomeStatus = 'pending' | 'resolved' | 'unresolvable';

export const SIGNAL_OUTCOME_STATUSES: SignalOutcomeStatus[] = [
  'pending',
  'resolved',
  'unresolvable',
];

const TRADING_STYLES = ['scalping', 'day_trading', 'swing_trading', 'position_trading'] as const;

export interface ISignalOutcome extends Document {
  signalId: Types.ObjectId;
  symbol: string;
  interval: string;
  tradingStyle: TradingStyle;
  tier: SignalTier;
  score: number;
  configVersion: number;
  candleTimestamp: number;
  horizonBars: number;
  resolveAt: number;
  status: SignalOutcomeStatus;
  entryPrice: number | null;
  forwardReturnPercent: number | null;
  mfePercent: number | null;
  maePercent: number | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

const signalOutcomeSchema = new Schema<ISignalOutcome>(
  {
    signalId: { type: Schema.Types.ObjectId, required: true, unique: true },
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    tradingStyle: {
      type: String,
      enum: TRADING_STYLES,
      required: true,
    },
    tier: {
      type: String,
      enum: SIGNAL_TIERS,
      required: true,
    },
    score: { type: Number, required: true },
    configVersion: { type: Number, required: true },
    candleTimestamp: { type: Number, required: true },
    horizonBars: { type: Number, required: true },
    resolveAt: { type: Number, required: true },
    status: {
      type: String,
      enum: SIGNAL_OUTCOME_STATUSES,
      default: 'pending',
    },
    entryPrice: { type: Number, default: null },
    forwardReturnPercent: { type: Number, default: null },
    mfePercent: { type: Number, default: null },
    maePercent: { type: Number, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Resolver sweep: due pending outcomes in resolveAt order
signalOutcomeSchema.index({ status: 1, resolveAt: 1 });
// Analytics: outcomes for a symbol/style, most recent first
signalOutcomeSchema.index({ symbol: 1, tradingStyle: 1, createdAt: -1 });
// TTL: outcomes older than a year are no longer useful for live expectancy
signalOutcomeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

export const SignalOutcome =
  mongoose.models.SignalOutcome ||
  mongoose.model<ISignalOutcome>('SignalOutcome', signalOutcomeSchema);
