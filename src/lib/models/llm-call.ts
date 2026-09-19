import mongoose, { Schema, type Document } from 'mongoose';

import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_TIERS, type SignalTier } from '@/types/signal';

/**
 * One LLM panel call per symbol, interval, closed bar, and prompt version.
 * Forward-only by construction: a call is made after the bar closes from a
 * point-in-time inputs packet, and the outcome resolver measures it exactly
 * as it measures the composite (see src/lib/signals/outcome-resolver.ts,
 * source 'llm'). Nothing in the scorer reads this collection.
 */
export const LLM_CALL_INTERVALS = ['1h', '4h', '1d'] as const;
export type LlmCallInterval = (typeof LLM_CALL_INTERVALS)[number];

const STYLE_FOR_INTERVAL: Record<LlmCallInterval, TradingStyle> = {
  '1h': 'day_trading',
  '4h': 'swing_trading',
  '1d': 'position_trading',
};

export function llmStyleForInterval(interval: string): TradingStyle {
  const style = STYLE_FOR_INTERVAL[interval as LlmCallInterval];
  if (!style) throw new Error(`No LLM call style for interval "${interval}"`);
  return style;
}

export const LLM_PANEL_ROLES = ['news_reader', 'regime_classifier', 'risk_officer'] as const;

const SELL_TIERS: SignalTier[] = ['sell', 'strong_sell'];

/** The outcome's `score`: strength signed by direction, zero for neutral. */
export function signedStrength(tier: SignalTier, strength: number): number {
  if (tier === 'neutral') return 0;
  return SELL_TIERS.includes(tier) ? -strength : strength;
}

export interface ILlmCallVote {
  role: string;
  tier: SignalTier;
  strength: number;
  note: string;
}

// `model` (the LLM model identifier field below) collides with the name of
// Document's own `model()` method, so that method is omitted here.
export interface ILlmCall extends Omit<Document, 'model'> {
  symbol: string;
  interval: LlmCallInterval;
  tradingStyle: TradingStyle;
  candleTimestamp: number;
  tier: SignalTier;
  strength: number;
  confidence: number;
  rationale: string;
  votes: ILlmCallVote[];
  model: string;
  promptVersion: string;
  inputsHash: string;
  source: 'llm-panel';
  createdAt: Date;
}

const voteSchema = new Schema<ILlmCallVote>(
  {
    role: { type: String, required: true, maxlength: 40 },
    tier: { type: String, enum: SIGNAL_TIERS, required: true },
    strength: { type: Number, required: true, min: 0, max: 100 },
    note: { type: String, required: true, maxlength: 500 },
  },
  { _id: false }
);

const llmCallSchema = new Schema<ILlmCall>(
  {
    symbol: { type: String, required: true },
    interval: { type: String, enum: LLM_CALL_INTERVALS, required: true },
    tradingStyle: {
      type: String,
      enum: ['day_trading', 'swing_trading', 'position_trading'],
      required: true,
    },
    candleTimestamp: { type: Number, required: true },
    tier: { type: String, enum: SIGNAL_TIERS, required: true },
    strength: { type: Number, required: true, min: 0, max: 100 },
    confidence: { type: Number, required: true, min: 0, max: 100 },
    rationale: { type: String, required: true, maxlength: 2000 },
    votes: { type: [voteSchema], default: [] },
    model: { type: String, required: true, maxlength: 80 },
    promptVersion: { type: String, required: true, maxlength: 40 },
    inputsHash: { type: String, required: true, maxlength: 64 },
    source: { type: String, enum: ['llm-panel'], default: 'llm-panel' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One call per bar and prompt version; a repeated run is idempotent.
llmCallSchema.index(
  { symbol: 1, interval: 1, candleTimestamp: 1, promptVersion: 1 },
  { unique: true }
);
// Listing and analytics: newest calls per style.
llmCallSchema.index({ tradingStyle: 1, createdAt: -1 });

export const LlmCall =
  mongoose.models.LlmCall || mongoose.model<ILlmCall>('LlmCall', llmCallSchema);
