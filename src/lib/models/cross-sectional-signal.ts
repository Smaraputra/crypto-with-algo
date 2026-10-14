/** ARCHIVED: pre-rv-v1 records (book rv-8h-buffer2), read-only. Nothing writes here; rv-v1 uses RvBook, RvSignal and RvStep. */
import mongoose, { Schema, type Document } from 'mongoose';

export interface ICrossSectionalSnapshot {
  symbol: string;
  close: number;
  return14d: number;
  fundingRate: number;
  btcReturn14d: number;
  betaToBtc: number;
  takerBuyRatio: number;
}

export interface ICrossSectionalRank {
  symbol: string;
  zMom: number;
  zIdio: number;
  zCarry: number;
  zFlow: number;
  compositeZ: number;
  rank: number;
}

export interface ICrossSectionalTarget {
  symbol: string;
  weight: number;
  side: 'long' | 'short' | 'flat';
}

export interface ICrossSectionalSignal extends Document {
  timestamp: number;
  barCloseTime: number;
  cadence: string;
  universe: string[];
  snapshots: ICrossSectionalSnapshot[];
  ranks: ICrossSectionalRank[];
  targets: ICrossSectionalTarget[];
  turnover: number;
  rebalanced: boolean;
  netBetaExposure: number;
  grossExposure: number;
  createdAt: Date;
  updatedAt: Date;
}

const snapshotSchema = new Schema(
  {
    symbol: { type: String, required: true },
    close: { type: Number, required: true },
    return14d: { type: Number, required: true },
    fundingRate: { type: Number, required: true },
    btcReturn14d: { type: Number, required: true },
    betaToBtc: { type: Number, required: true },
    takerBuyRatio: { type: Number, required: true },
  },
  { _id: false }
);

const rankSchema = new Schema(
  {
    symbol: { type: String, required: true },
    zMom: { type: Number, required: true },
    zIdio: { type: Number, required: true },
    zCarry: { type: Number, required: true },
    zFlow: { type: Number, required: true },
    compositeZ: { type: Number, required: true },
    rank: { type: Number, required: true },
  },
  { _id: false }
);

const targetSchema = new Schema(
  {
    symbol: { type: String, required: true },
    weight: { type: Number, required: true },
    side: { type: String, enum: ['long', 'short', 'flat'], required: true },
  },
  { _id: false }
);

const crossSectionalSignalSchema = new Schema<ICrossSectionalSignal>(
  {
    timestamp: { type: Number, required: true, unique: true },
    barCloseTime: { type: Number, required: true },
    cadence: { type: String, required: true, default: '8h' },
    universe: [{ type: String, required: true }],
    snapshots: [snapshotSchema],
    ranks: [rankSchema],
    targets: [targetSchema],
    turnover: { type: Number, required: true, default: 0 },
    rebalanced: { type: Boolean, required: true, default: false },
    netBetaExposure: { type: Number, required: true, default: 0 },
    grossExposure: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

crossSectionalSignalSchema.index({ timestamp: -1 }, { unique: true });
crossSectionalSignalSchema.index({ createdAt: -1 });

export const CrossSectionalSignal =
  mongoose.models.CrossSectionalSignal ||
  mongoose.model<ICrossSectionalSignal>('CrossSectionalSignal', crossSectionalSignalSchema);
