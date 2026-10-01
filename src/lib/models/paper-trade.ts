import mongoose, { Schema, type Document } from 'mongoose';

import { TRADING_STYLES } from '@/lib/indicators/style-configs';
import { SIGNAL_TIERS } from '@/types/signal';
import { MARKET_SESSIONS } from '@/lib/sessions';
import type { TradingStyle } from '@/lib/models/signal-template';

export const PAPER_EXIT_REASONS = ['signal', 'stop_loss', 'take_profit', 'time_stop'] as const;
export type PaperExitReason = (typeof PAPER_EXIT_REASONS)[number];

/**
 * One closed paper trade, booked on both tracks.
 *
 * `engine` is what `runBarLoop` books for the same bars, which is what keeps
 * the desk comparable with every recorded research number. `executable` is
 * what a live order would have got: the entry at the first reachable open
 * rather than at the signal bar's close, and a stop that price had already
 * passed filled at the bar's open. The gap between the two is the cost of the
 * lag no research run has measured.
 *
 * Funding is stored crossing by crossing because the 1h snapshot row keeps
 * changing until T+45, so a later replay would otherwise read a different rate
 * than the desk actually charged.
 */
export interface IPaperFundingCharge {
  time: number;
  rate: number;
  amount: number;
}

export interface IPaperTrackFill {
  entryPrice: number;
  exitPrice: number;
  fees: number;
  slippageCost: number;
  pnl: number;
  pnlPercent: number;
}

export interface IPaperTrade extends Document {
  tradingStyle: TradingStyle;
  interval: string;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryTime: number;
  exitTime: number;
  holdTimeBars: number;
  exitReason: PaperExitReason;
  entryScore: number;
  exitScore: number;
  entryTier: (typeof SIGNAL_TIERS)[number];
  entrySession: string | null;
  entryConfigVersion: number;
  riskPercent: number;
  rewardPercent: number | null;
  /** Signed funding over the whole trade; positive means the trade paid. */
  fundingCost: number;
  fundingCharges: IPaperFundingCharge[];
  engine: IPaperTrackFill;
  executable: IPaperTrackFill & {
    filled: boolean;
    entryDelayBars: number;
    gappedStop: boolean;
    stoppedOnArrival: boolean;
  };
  createdAt: Date;
}

const trackSchema = new Schema<IPaperTrackFill>(
  {
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    fees: { type: Number, required: true },
    slippageCost: { type: Number, required: true },
    pnl: { type: Number, required: true },
    pnlPercent: { type: Number, required: true },
  },
  { _id: false }
);

const paperTradeSchema = new Schema<IPaperTrade>(
  {
    tradingStyle: { type: String, enum: TRADING_STYLES, required: true },
    interval: { type: String, required: true },
    symbol: { type: String, required: true },
    side: { type: String, enum: ['long', 'short'], required: true },
    quantity: { type: Number, required: true },
    entryTime: { type: Number, required: true },
    exitTime: { type: Number, required: true },
    holdTimeBars: { type: Number, required: true },
    exitReason: { type: String, enum: PAPER_EXIT_REASONS, required: true },
    entryScore: { type: Number, required: true },
    exitScore: { type: Number, required: true },
    entryTier: { type: String, enum: SIGNAL_TIERS, required: true },
    entrySession: { type: String, enum: [...MARKET_SESSIONS, null], default: null },
    entryConfigVersion: { type: Number, required: true },
    riskPercent: { type: Number, required: true },
    rewardPercent: { type: Number, default: null },
    fundingCost: { type: Number, default: 0 },
    fundingCharges: {
      type: [new Schema<IPaperFundingCharge>({ time: Number, rate: Number, amount: Number }, { _id: false })],
      default: [],
    },
    engine: { type: trackSchema, required: true },
    executable: {
      type: new Schema(
        {
          entryPrice: { type: Number, required: true },
          exitPrice: { type: Number, required: true },
          fees: { type: Number, required: true },
          slippageCost: { type: Number, required: true },
          pnl: { type: Number, required: true },
          pnlPercent: { type: Number, required: true },
          filled: { type: Boolean, required: true },
          entryDelayBars: { type: Number, required: true },
          gappedStop: { type: Boolean, required: true },
          stoppedOnArrival: { type: Boolean, required: true },
        },
        { _id: false }
      ),
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One trade per book, symbol and entry bar: the desk upserts on this key, so a
// repeated catch-up run cannot book the same trade twice.
paperTradeSchema.index({ tradingStyle: 1, interval: 1, symbol: 1, entryTime: 1 }, { unique: true });
// The read surface groups by book and tier.
paperTradeSchema.index({ tradingStyle: 1, interval: 1, exitTime: -1 });

export const PaperTrade =
  (mongoose.models.PaperTrade as mongoose.Model<IPaperTrade>) ||
  mongoose.model<IPaperTrade>('PaperTrade', paperTradeSchema);
