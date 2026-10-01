import mongoose, { Schema, type Document } from 'mongoose';

import { TRADING_STYLES } from '@/lib/indicators/style-configs';
import { SIGNAL_TIERS } from '@/types/signal';
import { MARKET_SESSIONS } from '@/lib/sessions';
import type { TradingStyle } from '@/lib/models/signal-template';

/**
 * One (book, symbol) ledger: its equity and its open position.
 *
 * Each symbol gets its own equity, which is how every research run was sized
 * (one run is one symbol), so the desk's sizing matches the recorded numbers
 * rather than a portfolio rule nothing was measured under. The aggregate
 * leverage that implies is reported on the book rather than capped, because a
 * cap would change which trades are taken and so break comparability.
 *
 * The position stores its decision inputs. `GlobalSignal` carries a TTL as
 * short as a day for scalping, so by the time a trade closes the row that
 * opened it may be gone.
 */
export interface IPaperPosition {
  side: 'long' | 'short';
  /** The engine track's fill: the signal bar's close after slippage. */
  entryPrice: number;
  /** Unslipped close, kept so the entry's slippage cost can be reproduced. */
  entryRawPrice: number;
  entryTime: number;
  quantity: number;
  stopPrice: number;
  targetPrice: number | null;
  timeStopBars: number | null;
  entrySlippageCost: number;
  /** Signed funding accrued so far; positive means the position has been paid. */
  fundingPnl: number;
  entryScore: number;
  entryTier: (typeof SIGNAL_TIERS)[number];
  entrySession: string | null;
  entryConfigVersion: number;
  /** When the signal row was written, which bounds the earliest live fill. */
  signalCreatedAt: number;
  /** The executable track's fill, once its bar has arrived. */
  executableEntryPrice: number | null;
  executableEntryTime: number | null;
  /** Settlements charged so far, copied onto the trade when it closes. */
  fundingCharges: Array<{ time: number; rate: number; amount: number }>;
}

export interface IPaperLedger extends Document {
  tradingStyle: TradingStyle;
  interval: string;
  symbol: string;
  /** Engine-track equity. This sizes every trade. */
  equity: number;
  /** Executable-track equity. Reported only; it never sizes anything. */
  executableEquity: number;
  position: IPaperPosition | null;
  trades: number;
  createdAt: Date;
  updatedAt: Date;
}

const positionSchema = new Schema<IPaperPosition>(
  {
    side: { type: String, enum: ['long', 'short'], required: true },
    entryPrice: { type: Number, required: true },
    entryRawPrice: { type: Number, required: true },
    entryTime: { type: Number, required: true },
    quantity: { type: Number, required: true },
    stopPrice: { type: Number, required: true },
    targetPrice: { type: Number, default: null },
    timeStopBars: { type: Number, default: null },
    entrySlippageCost: { type: Number, default: 0 },
    fundingPnl: { type: Number, default: 0 },
    entryScore: { type: Number, required: true },
    entryTier: { type: String, enum: SIGNAL_TIERS, required: true },
    entrySession: { type: String, enum: [...MARKET_SESSIONS, null], default: null },
    entryConfigVersion: { type: Number, required: true },
    signalCreatedAt: { type: Number, required: true },
    executableEntryPrice: { type: Number, default: null },
    executableEntryTime: { type: Number, default: null },
    fundingCharges: {
      type: [new Schema({ time: Number, rate: Number, amount: Number }, { _id: false })],
      default: [],
    },
  },
  { _id: false }
);

const paperLedgerSchema = new Schema<IPaperLedger>(
  {
    tradingStyle: { type: String, enum: TRADING_STYLES, required: true },
    interval: { type: String, required: true },
    symbol: { type: String, required: true },
    equity: { type: Number, required: true },
    executableEquity: { type: Number, required: true },
    position: { type: positionSchema, default: null },
    trades: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One ledger per book and symbol; the desk upserts on this key.
paperLedgerSchema.index({ tradingStyle: 1, interval: 1, symbol: 1 }, { unique: true });

export const PaperLedger =
  (mongoose.models.PaperLedger as mongoose.Model<IPaperLedger>) ||
  mongoose.model<IPaperLedger>('PaperLedger', paperLedgerSchema);
