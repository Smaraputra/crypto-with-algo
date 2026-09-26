import mongoose, { Schema, type Document, type Types } from 'mongoose';

import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_TIERS, type SignalTier } from '@/types/signal';

export type SignalOutcomeStatus = 'pending' | 'resolved' | 'unresolvable';

export const SIGNAL_OUTCOME_STATUSES: SignalOutcomeStatus[] = [
  'pending',
  'resolved',
  'unresolvable',
];

export type SignalOutcomeSource = 'composite' | 'llm';
export const SIGNAL_OUTCOME_SOURCES: SignalOutcomeSource[] = ['composite', 'llm'];

/**
 * Match clause for one source. Rows written before the field existed have
 * no `source` and are composite outcomes, so composite matches everything
 * that is not llm rather than the literal value.
 */
export function sourceMatch(source: SignalOutcomeSource): Record<string, unknown> {
  return source === 'llm' ? { source: 'llm' } : { source: { $ne: 'llm' } };
}

const TRADING_STYLES = ['scalping', 'day_trading', 'swing_trading', 'position_trading'] as const;

export interface ISignalOutcome extends Document {
  signalId: Types.ObjectId;
  source: SignalOutcomeSource;
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
    source: { type: String, enum: SIGNAL_OUTCOME_SOURCES, default: 'composite' },
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
// Live tier expectancy: resolved outcomes for a style, with or without a
// symbol filter, ordered by resolvedAt for the optional `since` cutoff
signalOutcomeSchema.index({ tradingStyle: 1, status: 1, resolvedAt: -1 });
// Live tier expectancy by source (llm calls next to the composite)
signalOutcomeSchema.index({ source: 1, tradingStyle: 1, status: 1, resolvedAt: -1 });
// Calibration analytics: every resolved row for one style at ONE interval,
// which is the only query in the codebase that filters on interval. Without
// this the match falls back to the tradingStyle+status prefix and scans every
// interval's rows to discard most of them.
signalOutcomeSchema.index({ tradingStyle: 1, interval: 1, status: 1, candleTimestamp: 1 });
// TTL: outcomes older than a year are no longer useful for live expectancy
signalOutcomeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

export const SignalOutcome =
  mongoose.models.SignalOutcome ||
  mongoose.model<ISignalOutcome>('SignalOutcome', signalOutcomeSchema);
