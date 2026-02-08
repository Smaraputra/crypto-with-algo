import mongoose, { Schema, type Document } from 'mongoose';

export interface IWatchlist extends Document {
  userId: string;
  symbols: string[];
  updatedAt: Date;
}

const watchlistSchema = new Schema<IWatchlist>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    symbols: { type: [String], default: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] },
  },
  { timestamps: true }
);

export const Watchlist =
  mongoose.models.Watchlist || mongoose.model<IWatchlist>('Watchlist', watchlistSchema);
