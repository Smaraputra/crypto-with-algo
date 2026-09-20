import mongoose, { Schema, type Document } from 'mongoose';

/**
 * USDT-M perpetual bars from the Binance public data archive.
 *
 * A separate collection rather than a `venue` field on `Candle`: the candle
 * collection's unique index `{symbol, interval, timestamp}` covers millions of
 * documents on the live path, and widening it would mean an index rebuild in
 * production for no live benefit. Nothing in the live signal path reads this
 * collection; it exists so research can price the venue it actually trades.
 *
 * `Candle` holds SPOT bars (`src/lib/candle-ingestion.ts` fetches through
 * `src/lib/binance.ts`, base `https://api.binance.com/api/v3`) while every
 * backtest charges USDT-M perpetual fees, slippage and funding. That mismatch
 * is what this collection lets the research harness measure.
 */
export type PerpSeries = 'klines' | 'premiumIndex' | 'markPrice';

export const PERP_SERIES: readonly PerpSeries[] = ['klines', 'premiumIndex', 'markPrice'] as const;

export interface IPerpCandle extends Document {
  symbol: string;
  interval: string;
  timestamp: number;
  /**
   * `klines` is the traded perpetual bar. On `premiumIndex` and `markPrice`
   * only OHLC carries meaning: Binance writes zero volume and zero taker
   * volume on both, and `close` is the perp-to-index premium or the mark price.
   */
  series: PerpSeries;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  takerBuyVolume?: number;
}

const perpCandleSchema = new Schema<IPerpCandle>(
  {
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    timestamp: { type: Number, required: true },
    series: { type: String, required: true, enum: PERP_SERIES },
    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    volume: { type: Number, required: true },
    quoteVolume: { type: Number, required: true },
    trades: { type: Number, required: true },
    takerBuyVolume: { type: Number, required: false },
  },
  { timestamps: false }
);

// The upsert key: a re-run of the same archive file writes the same documents.
perpCandleSchema.index({ symbol: 1, interval: 1, series: 1, timestamp: 1 }, { unique: true });
perpCandleSchema.index({ symbol: 1, interval: 1, series: 1, timestamp: -1 });

// No TTL, for the reason spelled out in historical-snapshot.ts: research reads
// multi-year history, and a TTL would silently delete it a year after each row
// was written.

export const PerpCandle =
  mongoose.models.PerpCandle || mongoose.model<IPerpCandle>('PerpCandle', perpCandleSchema);
