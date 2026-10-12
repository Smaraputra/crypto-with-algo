import mongoose, { Schema, type Document } from 'mongoose';

export interface ICrossSectionalPosition {
  symbol: string;
  side: 'long' | 'short';
  weight: number;
  entryPrice: number;
  entryTime: number;
  notionalMaker: number;
  notionalTaker: number;
  barsHeld: number;
}

export interface ICrossSectionalBook extends Document {
  bookName: string;
  startEquity: number;
  equityMaker: number;
  equityTaker: number;
  lastProcessedBarTime: number | null;
  positions: ICrossSectionalPosition[];
  totalTurnover: number;
  totalFundingCollected: number;
  peakLeverage: number;
  leaseUntil: Date | null;
  leaseOwner: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const positionSchema = new Schema(
  {
    symbol: { type: String, required: true },
    side: { type: String, enum: ['long', 'short'], required: true },
    weight: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    entryTime: { type: Number, required: true },
    notionalMaker: { type: Number, required: true },
    notionalTaker: { type: Number, required: true },
    barsHeld: { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

const crossSectionalBookSchema = new Schema<ICrossSectionalBook>(
  {
    bookName: { type: String, required: true, unique: true, default: 'rv-8h-buffer2' },
    startEquity: { type: Number, required: true, default: 10000 },
    equityMaker: { type: Number, required: true, default: 10000 },
    equityTaker: { type: Number, required: true, default: 10000 },
    lastProcessedBarTime: { type: Number, default: null },
    positions: [positionSchema],
    totalTurnover: { type: Number, required: true, default: 0 },
    totalFundingCollected: { type: Number, required: true, default: 0 },
    peakLeverage: { type: Number, required: true, default: 0 },
    leaseUntil: { type: Date, default: null },
    leaseOwner: { type: String, default: null },
  },
  { timestamps: true }
);

crossSectionalBookSchema.index({ bookName: 1 }, { unique: true });

export const CrossSectionalBook =
  mongoose.models.CrossSectionalBook ||
  mongoose.model<ICrossSectionalBook>('CrossSectionalBook', crossSectionalBookSchema);
