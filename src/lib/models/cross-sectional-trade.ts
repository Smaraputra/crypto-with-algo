/** ARCHIVED: pre-rv-v1 records (book rv-8h-buffer2), read-only. Nothing writes here. rv-v1 uses RvBook, RvSignal and RvStep. */
import mongoose, { Schema, type Document } from 'mongoose';

export interface ICrossSectionalTrade extends Document {
  bookName: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  barsHeld: number;
  weight: number;
  pnlGross: number;
  pnlPercentGross: number;
  pnlNetMaker: number;
  pnlPercentNetMaker: number;
  pnlNetTaker: number;
  pnlPercentNetTaker: number;
  fundingCollected: number;
  exitReason: string;
  createdAt: Date;
}

const crossSectionalTradeSchema = new Schema<ICrossSectionalTrade>(
  {
    bookName: { type: String, required: true, default: 'rv-8h-buffer2' },
    symbol: { type: String, required: true },
    side: { type: String, enum: ['long', 'short'], required: true },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    entryTime: { type: Number, required: true },
    exitTime: { type: Number, required: true },
    barsHeld: { type: Number, required: true },
    weight: { type: Number, required: true },
    pnlGross: { type: Number, required: true },
    pnlPercentGross: { type: Number, required: true },
    pnlNetMaker: { type: Number, required: true },
    pnlPercentNetMaker: { type: Number, required: true },
    pnlNetTaker: { type: Number, required: true },
    pnlPercentNetTaker: { type: Number, required: true },
    fundingCollected: { type: Number, required: true, default: 0 },
    exitReason: { type: String, required: true, default: 'rank_buffer_exit' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

crossSectionalTradeSchema.index({ bookName: 1, exitTime: -1 });
crossSectionalTradeSchema.index({ symbol: 1, exitTime: -1 });

export const CrossSectionalTrade =
  mongoose.models.CrossSectionalTrade ||
  mongoose.model<ICrossSectionalTrade>('CrossSectionalTrade', crossSectionalTradeSchema);
