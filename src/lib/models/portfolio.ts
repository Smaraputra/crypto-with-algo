import mongoose, { Schema, type Document } from 'mongoose';

export interface ITransaction {
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  date: Date;
  notes?: string;
  fee?: number;
}

export interface IHolding {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  quantity: number;
  avgBuyPrice: number;
  transactions: ITransaction[];
}

export interface IPortfolio extends Document {
  userId: string;
  name: string;
  holdings: IHolding[];
  createdAt: Date;
  updatedAt: Date;
}

const transactionSchema = new Schema<ITransaction>(
  {
    type: { type: String, enum: ['buy', 'sell'], required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    notes: { type: String },
    fee: { type: Number, default: 0 },
  },
  { _id: true }
);

const holdingSchema = new Schema<IHolding>(
  {
    symbol: { type: String, required: true },
    baseAsset: { type: String, required: true },
    quoteAsset: { type: String, required: true },
    quantity: { type: Number, required: true, default: 0 },
    avgBuyPrice: { type: Number, required: true, default: 0 },
    transactions: { type: [transactionSchema], default: [] },
  },
  { _id: false }
);

const portfolioSchema = new Schema<IPortfolio>(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true, default: 'My Portfolio' },
    holdings: { type: [holdingSchema], default: [] },
  },
  { timestamps: true }
);

portfolioSchema.index({ userId: 1, name: 1 }, { unique: true });

export const Portfolio =
  mongoose.models.Portfolio || mongoose.model<IPortfolio>('Portfolio', portfolioSchema);
