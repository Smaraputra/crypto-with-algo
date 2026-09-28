/**
 * Turning Deribit option trades and DVOL rows into stored hourly documents.
 *
 * Pure, like `archive-ingestion.ts`: no fetch, no Mongo. A later task's CLI
 * supplies `OptionTrade[]` from `fetchOptionTrades` and `DvolRow[]` from
 * `fetchDvol` (both in `./external/deribit`) and writes what these functions
 * return.
 *
 * Two jobs:
 *   1. Bucket a run of option trades into one flow row per UTC hour: notional
 *      by call/put and taker side, net delta and dollar gamma, and two
 *      notional-weighted implied-vol readings (a whole-market one and two
 *      confined to the ~25-delta wings).
 *   2. Shape both the flow rows and the raw DVOL rows into upserts, keyed by
 *      currency and hour, with non-finite values dropped rather than stored
 *      as zero (the same rule `finiteFields` applies in `archive-ingestion.ts`,
 *      reimplemented here since that helper is not exported).
 */
import {
  blackScholesDelta,
  blackScholesGamma,
  parseInstrument,
  yearsToExpiry,
  type DvolRow,
  type OptionTrade,
} from '@/lib/external/deribit';
import type { UpsertOp } from '@/lib/archive-ingestion';

export const OPTIONS_SLOT_MS = 60 * 60 * 1000;

/**
 * A one-hour floor on time-to-expiry, so a trade in an option's last hour
 * before expiry does not send its ATM gamma toward infinity. Only applied
 * when the raw time-to-expiry is still positive; an already-expired
 * instrument (tau <= 0) gets no greeks at all rather than a floored one.
 */
export const GREEKS_MIN_TAU_YEARS = 1 / 8760;

/** The ~25-delta wings: notional-weighted iv is only taken from trades whose |delta| falls in this band. */
const IV25_DELTA_MIN = 0.15;
const IV25_DELTA_MAX = 0.35;

export interface OptionsFlowHourFields {
  callBuyNotional: number;
  callSellNotional: number;
  putBuyNotional: number;
  putSellNotional: number;
  netDelta: number;
  netDollarGamma: number;
  tradeCount: number;
  greekTradeCount: number;
  vwIv: number | null;
  putIv25: number | null;
  callIv25: number | null;
}

export interface OptionsFlowHour extends OptionsFlowHourFields {
  /** UTC hour OPEN. */
  timestamp: number;
}

export interface DvolFields {
  dvolOpen: number;
  dvolHigh: number;
  dvolLow: number;
  dvolClose: number;
}

/** Shared shape for the `$set` half of either upsert kind, for a single Mongo store to accept both. */
export type OptionsFlowUpsertFields = Partial<OptionsFlowHourFields & DvolFields>;

/**
 * Delta and gamma for one trade, or null when they cannot be computed:
 * the instrument does not parse as an option, `iv` is null or <= 0,
 * `indexPrice` <= 0, or time-to-expiry (as of the trade, or `atMs` when
 * given) is <= 0. A positive but small time-to-expiry is floored at
 * `GREEKS_MIN_TAU_YEARS`, never dropped.
 */
export function optionTradeGreeks(
  trade: OptionTrade,
  atMs: number = trade.timestamp
): { delta: number; gamma: number } | null {
  const parsed = parseInstrument(trade.instrumentName);
  if (!parsed) return null;

  if (trade.iv === null || !Number.isFinite(trade.iv) || trade.iv <= 0) return null;
  if (!Number.isFinite(trade.indexPrice) || trade.indexPrice <= 0) return null;

  const rawTau = yearsToExpiry(parsed.expiryMs, atMs);
  if (!(rawTau > 0)) return null;
  const tau = Math.max(rawTau, GREEKS_MIN_TAU_YEARS);

  const sigma = trade.iv / 100;
  const delta = blackScholesDelta(trade.indexPrice, parsed.strike, tau, sigma, parsed.isCall);
  const gamma = blackScholesGamma(trade.indexPrice, parsed.strike, tau, sigma);
  if (!Number.isFinite(delta) || !Number.isFinite(gamma)) return null;

  return { delta, gamma };
}

interface HourAccumulator {
  timestamp: number;
  callBuyNotional: number;
  callSellNotional: number;
  putBuyNotional: number;
  putSellNotional: number;
  netDelta: number;
  netDollarGamma: number;
  tradeCount: number;
  greekTradeCount: number;
  ivWeightedSum: number;
  ivWeightTotal: number;
  callIv25WeightedSum: number;
  callIv25WeightTotal: number;
  putIv25WeightedSum: number;
  putIv25WeightTotal: number;
}

function newAccumulator(timestamp: number): HourAccumulator {
  return {
    timestamp,
    callBuyNotional: 0,
    callSellNotional: 0,
    putBuyNotional: 0,
    putSellNotional: 0,
    netDelta: 0,
    netDollarGamma: 0,
    tradeCount: 0,
    greekTradeCount: 0,
    ivWeightedSum: 0,
    ivWeightTotal: 0,
    callIv25WeightedSum: 0,
    callIv25WeightTotal: 0,
    putIv25WeightedSum: 0,
    putIv25WeightTotal: 0,
  };
}

/**
 * Buckets trades into one row per UTC hour (no empty hours) and computes,
 * per hour:
 *
 *   - notional (`amount * indexPrice`, USD) split by call/put and by taker
 *     side, for every trade whose instrument parses -- independent of
 *     whether greeks could be computed for it;
 *   - `netDelta = sum(sign * delta * amount)` and
 *     `netDollarGamma = sum(sign * gamma * amount * indexPrice^2 / 100)`,
 *     sign +1 for a taker buy and -1 for a taker sell, summed only over
 *     trades `optionTradeGreeks` could price;
 *   - `vwIv`, the notional-weighted iv over every trade with a finite,
 *     positive iv (independent of greeks), null when none. A trade with
 *     `iv: 0` is excluded: Deribit uses 0 as a placeholder for "could not be
 *     computed" (typically a deep-in-the-money print), not a real zero-vol
 *     reading, the same reason `optionTradeGreeks` treats it as unpriced;
 *   - `putIv25` / `callIv25`, the notional-weighted iv over puts / calls
 *     whose |delta| sits in [0.15, 0.35], null when none -- inherits the same
 *     `iv <= 0` exclusion, since these only ever sum trades `optionTradeGreeks`
 *     already priced.
 */
export function aggregateOptionTrades(trades: OptionTrade[]): OptionsFlowHour[] {
  const byHour = new Map<number, HourAccumulator>();

  for (const trade of trades) {
    if (!Number.isFinite(trade.timestamp)) continue;

    const hour = Math.floor(trade.timestamp / OPTIONS_SLOT_MS) * OPTIONS_SLOT_MS;
    let acc = byHour.get(hour);
    if (!acc) {
      acc = newAccumulator(hour);
      byHour.set(hour, acc);
    }

    acc.tradeCount += 1;

    const notional = trade.amount * trade.indexPrice;
    const sign = trade.direction === 'buy' ? 1 : -1;
    const parsed = parseInstrument(trade.instrumentName);

    if (parsed) {
      if (parsed.isCall) {
        if (trade.direction === 'buy') acc.callBuyNotional += notional;
        else acc.callSellNotional += notional;
      } else {
        if (trade.direction === 'buy') acc.putBuyNotional += notional;
        else acc.putSellNotional += notional;
      }
    }

    if (trade.iv !== null && Number.isFinite(trade.iv) && trade.iv > 0 && notional > 0) {
      acc.ivWeightedSum += trade.iv * notional;
      acc.ivWeightTotal += notional;
    }

    const greeks = optionTradeGreeks(trade);
    if (greeks && parsed) {
      acc.greekTradeCount += 1;
      acc.netDelta += sign * greeks.delta * trade.amount;
      acc.netDollarGamma += (sign * greeks.gamma * trade.amount * trade.indexPrice * trade.indexPrice) / 100;

      const absDelta = Math.abs(greeks.delta);
      if (
        absDelta >= IV25_DELTA_MIN &&
        absDelta <= IV25_DELTA_MAX &&
        trade.iv !== null &&
        Number.isFinite(trade.iv) &&
        notional > 0
      ) {
        if (parsed.isCall) {
          acc.callIv25WeightedSum += trade.iv * notional;
          acc.callIv25WeightTotal += notional;
        } else {
          acc.putIv25WeightedSum += trade.iv * notional;
          acc.putIv25WeightTotal += notional;
        }
      }
    }
  }

  return Array.from(byHour.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((acc) => ({
      timestamp: acc.timestamp,
      callBuyNotional: acc.callBuyNotional,
      callSellNotional: acc.callSellNotional,
      putBuyNotional: acc.putBuyNotional,
      putSellNotional: acc.putSellNotional,
      netDelta: acc.netDelta,
      netDollarGamma: acc.netDollarGamma,
      tradeCount: acc.tradeCount,
      greekTradeCount: acc.greekTradeCount,
      vwIv: acc.ivWeightTotal > 0 ? acc.ivWeightedSum / acc.ivWeightTotal : null,
      putIv25: acc.putIv25WeightTotal > 0 ? acc.putIv25WeightedSum / acc.putIv25WeightTotal : null,
      callIv25: acc.callIv25WeightTotal > 0 ? acc.callIv25WeightedSum / acc.callIv25WeightTotal : null,
    }));
}

/** Drop keys whose value is null or not finite, so a gap never stores as zero (mirrors archive-ingestion.ts). */
function finiteFields<T extends Record<string, number | null>>(fields: T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * One upsert per options-flow hour, keyed by currency and timestamp. A row
 * with nothing finite to store is skipped. `set` is genuinely partial
 * (`finiteFields` drops non-finite/null keys), so the return type says so
 * rather than claiming every field is always present.
 */
export function flowUpserts(currency: string, hours: OptionsFlowHour[]): UpsertOp<Partial<OptionsFlowHourFields>>[] {
  const ops: UpsertOp<Partial<OptionsFlowHourFields>>[] = [];
  for (const hour of hours) {
    const set = finiteFields({
      callBuyNotional: hour.callBuyNotional,
      callSellNotional: hour.callSellNotional,
      putBuyNotional: hour.putBuyNotional,
      putSellNotional: hour.putSellNotional,
      netDelta: hour.netDelta,
      netDollarGamma: hour.netDollarGamma,
      tradeCount: hour.tradeCount,
      greekTradeCount: hour.greekTradeCount,
      vwIv: hour.vwIv,
      putIv25: hour.putIv25,
      callIv25: hour.callIv25,
    });
    if (Object.keys(set).length === 0) continue;
    ops.push({ filter: { currency, timestamp: hour.timestamp }, set });
  }
  return ops;
}

/**
 * One upsert per DVOL row, keyed by currency and timestamp. A row whose
 * timestamp is not finite is dropped (mirrors `metricsUpserts` in
 * `archive-ingestion.ts`), and a row with nothing finite left to store is
 * skipped. `set` is genuinely partial, same reasoning as `flowUpserts`.
 */
export function dvolUpserts(currency: string, rows: DvolRow[]): UpsertOp<Partial<DvolFields>>[] {
  const ops: UpsertOp<Partial<DvolFields>>[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.timestamp)) continue;
    const set = finiteFields({
      dvolOpen: row.open,
      dvolHigh: row.high,
      dvolLow: row.low,
      dvolClose: row.close,
    });
    if (Object.keys(set).length === 0) continue;
    ops.push({ filter: { currency, timestamp: row.timestamp }, set });
  }
  return ops;
}
