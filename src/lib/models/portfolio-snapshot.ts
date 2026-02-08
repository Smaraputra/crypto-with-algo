import mongoose, { Schema, type Document } from 'mongoose';

export interface ISnapshotHolding {
  symbol: string;
  quantity: number;
  price: number;
  value: number;
}

export interface IPortfolioSnapshot extends Document {
  userId: string;
  portfolioId: string;
  date: Date;
  totalValue: number;
  totalCost: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  holdings: ISnapshotHolding[];
  createdAt: Date;
  updatedAt: Date;
}

const snapshotHoldingSchema = new Schema<ISnapshotHolding>(
  {
    symbol: { type: String, required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    value: { type: Number, required: true },
  },
  { _id: false }
);

const portfolioSnapshotSchema = new Schema<IPortfolioSnapshot>(
  {
    userId: { type: String, required: true, index: true },
    portfolioId: { type: String, required: true },
    date: { type: Date, required: true },
    totalValue: { type: Number, required: true },
    totalCost: { type: Number, required: true },
    unrealizedPnl: { type: Number, required: true },
    unrealizedPnlPercent: { type: Number, required: true },
    holdings: { type: [snapshotHoldingSchema], default: [] },
  },
  { timestamps: true }
);

portfolioSnapshotSchema.index({ portfolioId: 1, date: 1 }, { unique: true });

portfolioSnapshotSchema.pre('save', function () {
  this.date = truncateToMidnightUTC(this.date);
});

export function truncateToMidnightUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export const PortfolioSnapshot =
  mongoose.models.PortfolioSnapshot ||
  mongoose.model<IPortfolioSnapshot>('PortfolioSnapshot', portfolioSnapshotSchema);
