import mongoose, { Schema, type Document } from 'mongoose';

export interface IHistoricalSnapshot extends Document {
  symbol: string;
  timestamp: number; // Unix milliseconds, aligned to candle close
  interval: string; // "15m" | "1h" | "4h" | "1d"
  data: {
    fundingRate?: {
      rate: number;
      markPrice: number;
    };
    longShortRatio?: {
      ratio: number;
      longAccount: number;
      shortAccount: number;
    };
    openInterest?: {
      value: number;
      sumValue: number;
    };
    newsSentiment?: {
      count: number; // Articles in this interval
      avgSentiment: number; // -1 to +1
      topics: string[];
    };
    fearGreed?: {
      index: number; // 0-100
      label: string; // "Extreme Fear", "Greed", etc.
    };
  };
  createdAt: Date;
}

const historicalSnapshotSchema = new Schema<IHistoricalSnapshot>(
  {
    symbol: { type: String, required: true },
    timestamp: { type: Number, required: true },
    interval: { type: String, required: true },
    data: {
      type: {
        fundingRate: {
          type: {
            rate: Number,
            markPrice: Number,
          },
          required: false,
        },
        longShortRatio: {
          type: {
            ratio: Number,
            longAccount: Number,
            shortAccount: Number,
          },
          required: false,
        },
        openInterest: {
          type: {
            value: Number,
            sumValue: Number,
          },
          required: false,
        },
        newsSentiment: {
          type: {
            count: Number,
            avgSentiment: Number,
            topics: [String],
          },
          required: false,
        },
        fearGreed: {
          type: {
            index: Number,
            label: String,
          },
          required: false,
        },
      },
      default: {},
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Primary lookup index
historicalSnapshotSchema.index({ symbol: 1, interval: 1, timestamp: -1 });

// TTL index: 1 year = 31536000 seconds
historicalSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31536000 });

export const HistoricalSnapshot =
  mongoose.models.HistoricalSnapshot ||
  mongoose.model<IHistoricalSnapshot>('HistoricalSnapshot', historicalSnapshotSchema);
