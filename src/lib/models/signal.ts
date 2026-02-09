import mongoose, { Schema, type Document } from 'mongoose';

import { SIGNAL_TIERS } from '@/types/signal';

export interface ISignalComponent {
  category: string;
  score: number;
  weight: number;
  weightedScore: number;
  signals: Array<{
    name: string;
    direction: string;
    strength: number;
    description: string;
  }>;
}

export interface ISignal extends Document {
  userId: string;
  symbol: string;
  interval: string;
  score: number;
  tier: (typeof SIGNAL_TIERS)[number];
  confidence: number;
  components: ISignalComponent[];
  createdAt: Date;
  updatedAt: Date;
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

const signalSchema = new Schema<ISignal>(
  {
    userId: { type: String, required: true },
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    score: { type: Number, required: true },
    tier: {
      type: String,
      enum: SIGNAL_TIERS,
      required: true,
    },
    confidence: { type: Number, required: true },
    components: [signalComponentSchema],
  },
  { timestamps: true }
);

signalSchema.index({ userId: 1, symbol: 1, createdAt: -1 });
signalSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // 90-day TTL

export const Signal =
  mongoose.models.Signal || mongoose.model<ISignal>('Signal', signalSchema);
