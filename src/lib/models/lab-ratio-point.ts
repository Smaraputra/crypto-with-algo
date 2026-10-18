import mongoose, { Schema, type Document } from 'mongoose';

export interface ILabRatioPoint extends Document {
  symbol: string;
  period: '4h';
  timestamp: number;
  longShortRatio: number;
  fetchedAt: Date;
}

export type LabRatioPointFields = Omit<ILabRatioPoint, keyof Document>;

export interface RatioPointInput {
  timestamp: number;
  longShortRatio: number;
}

const labRatioPointSchema = new Schema<ILabRatioPoint>(
  {
    symbol: { type: String, required: true },
    period: { type: String, enum: ['4h'], required: true },
    timestamp: { type: Number, required: true },
    longShortRatio: { type: Number, required: true },
    fetchedAt: { type: Date, required: true },
  },
  { timestamps: false, minimize: false }
);

labRatioPointSchema.index({ symbol: 1, period: 1, timestamp: 1 }, { unique: true });

export const LabRatioPoint =
  (mongoose.models.LabRatioPoint as mongoose.Model<ILabRatioPoint>) ||
  mongoose.model<ILabRatioPoint>('LabRatioPoint', labRatioPointSchema, 'labratiopoints');

/**
 * Inserts ratio points with an updateOne upsert using $setOnInsert (insert-only, never overwrites).
 * Follows the write-once pattern of LabSignal by validating each document first.
 * Returns how many points were new (upserted).
 */
export async function storeRatioPoints(
  symbol: string,
  period: '4h' | string,
  points: readonly RatioPointInput[],
  fetchedAt: Date
): Promise<number> {
  if (points.length === 0) {
    return 0;
  }

  // Deduplicate timestamps within the incoming points array, keeping the first
  const seen = new Set<number>();
  const uniquePoints: RatioPointInput[] = [];
  for (const point of points) {
    const fields: LabRatioPointFields = {
      symbol,
      period: period as '4h',
      timestamp: point.timestamp,
      longShortRatio: point.longShortRatio,
      fetchedAt,
    };
    await new LabRatioPoint(fields).validate();
    if (!seen.has(point.timestamp)) {
      seen.add(point.timestamp);
      uniquePoints.push(point);
    }
  }

  const ops = uniquePoints.map((point) => ({
    updateOne: {
      filter: { symbol, period: period as '4h', timestamp: point.timestamp },
      update: {
        $setOnInsert: {
          symbol,
          period: period as '4h',
          timestamp: point.timestamp,
          longShortRatio: point.longShortRatio,
          fetchedAt,
        },
      },
      upsert: true,
    },
  }));

  try {
    const result = await LabRatioPoint.bulkWrite(ops, { ordered: false });
    return result.upsertedCount;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000) {
      const upserted = (error as { result?: { nUpserted?: number } }).result?.nUpserted;
      if (typeof upserted === 'number') {
        return upserted;
      }
    }
    throw error;
  }
}

/**
 * Loads stored ratio points for a symbol and period within [fromTs, toTs], sorted by timestamp ascending.
 */
export async function loadRatioPoints(
  symbol: string,
  period: '4h' | string,
  fromTs: number,
  toTs: number
): Promise<{ timestamp: number; longShortRatio: number }[]> {
  const docs = await LabRatioPoint.find(
    {
      symbol,
      period: period as '4h',
      timestamp: { $gte: fromTs, $lte: toTs },
    },
    { _id: 0, timestamp: 1, longShortRatio: 1 }
  )
    .sort({ timestamp: 1 })
    .lean();

  return docs.map((doc) => ({
    timestamp: doc.timestamp,
    longShortRatio: doc.longShortRatio,
  }));
}
