import mongoose, { Schema, type Document } from 'mongoose';

export const ALERT_TYPES = [
  'price_above',
  'price_below',
  'price_change_pct',
  'portfolio_value_above',
  'portfolio_value_below',
  'holding_change_pct',
] as const;

export const ALERT_STATUSES = ['active', 'triggered', 'paused'] as const;

export interface IAlert extends Document {
  userId: string;
  symbol: string;
  portfolioId: string | null;
  type: (typeof ALERT_TYPES)[number];
  targetPrice: number | null;
  percentChange: number | null;
  referencePrice: number | null;
  status: (typeof ALERT_STATUSES)[number];
  recurring: boolean;
  cooldownMinutes: number;
  message: string;
  triggeredAt: Date | null;
  notifiedAt: Date | null;
  lastTriggeredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const alertSchema = new Schema<IAlert>(
  {
    userId: { type: String, required: true },
    symbol: { type: String, default: '' },
    portfolioId: { type: String, default: null },
    type: {
      type: String,
      enum: ALERT_TYPES,
      required: true,
    },
    targetPrice: { type: Number, default: null },
    percentChange: { type: Number, default: null },
    referencePrice: { type: Number, default: null },
    status: {
      type: String,
      enum: ALERT_STATUSES,
      default: 'active',
    },
    recurring: { type: Boolean, default: false },
    cooldownMinutes: { type: Number, default: 60 },
    message: { type: String, default: '' },
    triggeredAt: { type: Date, default: null },
    notifiedAt: { type: Date, default: null },
    lastTriggeredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

alertSchema.index({ userId: 1, status: 1 });
alertSchema.index({ status: 1 });

export const Alert =
  mongoose.models.Alert || mongoose.model<IAlert>('Alert', alertSchema);
