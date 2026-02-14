import mongoose, { Schema, type Document } from 'mongoose';

import type { TradingStyle } from '@/lib/models/signal-template';
import { SIGNAL_TIERS } from '@/types/signal';
import type { ISignalComponent } from '@/lib/models/signal';

export interface IGlobalSignal extends Document {
  symbol: string;
  interval: string;
  tradingStyle: TradingStyle;
  score: number;
  tier: (typeof SIGNAL_TIERS)[number];
  confidence: number;
  components: ISignalComponent[];
  configVersion: number;
  candleTimestamp: number;
  expiresAt: Date;
  createdAt: Date;
}

const signalComponentSchema = new Schema(
  {
    category: { type: String, required: true },
    score: { type: Number, required: true },
    weight: { type: Number, required: true },
    weightedScore: { type: Number, required: true },
    signals: [
      {
        name: { type: String, required: true },
        direction: { type: String, enum: ['bullish', 'bearish', 'neutral'], required: true },
        strength: { type: Number, required: true },
        description: { type: String, required: true },
        _id: false,
      },
    ],
  },
  { _id: false }
);

const TRADING_STYLES = ['scalping', 'day_trading', 'swing_trading', 'position_trading'] as const;

const globalSignalSchema = new Schema<IGlobalSignal>(
  {
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    tradingStyle: {
      type: String,
      enum: TRADING_STYLES,
      required: true,
    },
    score: { type: Number, required: true },
    tier: {
      type: String,
      enum: SIGNAL_TIERS,
      required: true,
    },
    confidence: { type: Number, required: true },
    components: [signalComponentSchema],
    configVersion: { type: Number, required: true, default: 1 },
    candleTimestamp: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Primary query: get signals for a symbol/style/interval combo
globalSignalSchema.index({ symbol: 1, tradingStyle: 1, interval: 1, createdAt: -1 });
// Latest signal query: get latest signal for a symbol/style
globalSignalSchema.index({ symbol: 1, tradingStyle: 1, createdAt: -1 });
// TTL: auto-delete expired signals (expiresAt is set per-style)
globalSignalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GlobalSignal =
  mongoose.models.GlobalSignal ||
  mongoose.model<IGlobalSignal>('GlobalSignal', globalSignalSchema);
