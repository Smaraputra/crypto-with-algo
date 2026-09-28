import mongoose, { Schema, type Document } from 'mongoose';

/**
 * Hourly Deribit options-market aggregates: the DVOL implied-volatility index
 * and trade-flow measures built from raw option trades.
 *
 * Two independent ingests write into the same document, exactly like
 * FuturesMetric's metrics and bookDepth passes: `scripts/ops/ingest-deribit.ts`
 * runs a `dvol` job (writes `dvol*`) and a `trades` job (writes everything
 * else) separately, and each is a field-level `$set` keyed on `{currency,
 * timestamp}`, so either can run alone or be re-run without disturbing the
 * other's fields. Raw option trades are never stored here or anywhere else;
 * only the hourly aggregate built by `aggregateOptionTrades`
 * (`src/lib/options-flow.ts`) is.
 *
 * Every measure is optional, and a missing one must stay distinguishable from
 * a real zero: an hour with no call buy flow at all reads the same as an hour
 * that was never ingested unless the field itself is left unset rather than
 * written as 0.
 */
export interface IOptionsFlowHour extends Document {
  currency: string;
  /** UTC hour OPEN, ms. */
  timestamp: number;

  dvolOpen?: number;
  dvolHigh?: number;
  dvolLow?: number;
  dvolClose?: number;

  callBuyNotional?: number;
  callSellNotional?: number;
  putBuyNotional?: number;
  putSellNotional?: number;
  netDelta?: number;
  netDollarGamma?: number;
  tradeCount?: number;
  greekTradeCount?: number;
  vwIv?: number;
  putIv25?: number;
  callIv25?: number;
}

const optionsFlowHourSchema = new Schema<IOptionsFlowHour>(
  {
    currency: { type: String, required: true },
    timestamp: { type: Number, required: true },

    dvolOpen: { type: Number, required: false },
    dvolHigh: { type: Number, required: false },
    dvolLow: { type: Number, required: false },
    dvolClose: { type: Number, required: false },

    callBuyNotional: { type: Number, required: false },
    callSellNotional: { type: Number, required: false },
    putBuyNotional: { type: Number, required: false },
    putSellNotional: { type: Number, required: false },
    netDelta: { type: Number, required: false },
    netDollarGamma: { type: Number, required: false },
    tradeCount: { type: Number, required: false },
    greekTradeCount: { type: Number, required: false },
    vwIv: { type: Number, required: false },
    putIv25: { type: Number, required: false },
    callIv25: { type: Number, required: false },
  },
  { timestamps: false }
);

// The upsert key: the dvol pass and the trades pass merge into the same
// document for a slot, so the write is always a field-level $set, never a
// whole-document replace.
optionsFlowHourSchema.index({ currency: 1, timestamp: 1 }, { unique: true });
optionsFlowHourSchema.index({ currency: 1, timestamp: -1 });

// No TTL, for the reason spelled out in historical-snapshot.ts: research reads
// multi-year history, and a TTL would silently delete it a year after each row
// was written.

export const OptionsFlowHour =
  mongoose.models.OptionsFlowHour ||
  mongoose.model<IOptionsFlowHour>('OptionsFlowHour', optionsFlowHourSchema);
