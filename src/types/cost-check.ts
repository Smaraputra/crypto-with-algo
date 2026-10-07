import type { HoldMoveStats, MeasurementInterval } from '@/lib/costs/move';

/**
 * Wire types for the Cost Check API. The server returns market facts and move
 * statistics only. Every cost figure (fees, funding paid, breakeven, verdict)
 * is computed client-side from `@/lib/costs`.
 */

/** GET /api/cost-check/symbols */
export interface CostCheckSymbolsResponse {
  /** Trading crypto USDT-M perpetuals, sorted by symbol. */
  symbols: { symbol: string; baseAsset: string; onboardDate: number }[];
  /** When the underlying venue data was built, epoch ms. */
  asOf: number;
  /** Always false here; kept for shape parity with the market response. */
  stale: boolean;
}

/** GET /api/cost-check?symbol=&holdMinutes=&notional= */
export interface CostCheckMarketResponse {
  symbol: string;
  /** When this response was built from venue data, epoch ms. For a stale copy, its original build time. */
  asOf: number;
  /**
   * True when the venue was unreachable and a last-good copy (up to 24 h old) is served. That copy is
   * shared across users, so its slippage is always the flat fallback, never one measured for another
   * request's notional.
   */
  stale: boolean;
  /** Mark price, USDT. */
  markPrice: number;
  funding: {
    /** Funding rate in force for the next settlement, as a fraction (0.0001 = 0.01%). Positive: longs pay shorts. */
    rate: number;
    /** Hours between settlements. 8 when the symbol is absent from the venue's fundingInfo list. */
    intervalHours: number;
    /** Next settlement, epoch ms. */
    nextFundingTime: number;
  };
  venue: {
    /** MIN_NOTIONAL filter, USDT. */
    minNotional: number;
    /** LOT_SIZE minimum quantity, base units. */
    minQty: number;
    /** LOT_SIZE step, base units. */
    stepSize: number;
    /** PRICE_FILTER tick. */
    tickSize: number;
    /** max(minNotional, minQty x markPrice): the smallest order accepted, USDT. */
    effectiveMinNotional: number;
  };
  measurement: {
    /** Kline interval the hold was measured on. */
    interval: MeasurementInterval;
    /** Whole bars per hold window. */
    holdBars: number;
    /** holdBars x bar length, ms: the hold actually measured. */
    measuredHoldMs: number;
    /** Closed bars the statistics rest on. */
    barsUsed: number;
  };
  /** Close-to-close move over the hold. Null when there are fewer bars than one window. */
  move: HoldMoveStats | null;
  slippage: {
    /** One-way slippage, basis points. */
    bps: number;
    /** `depth`: measured from the order book for the requested notional. `fallback`: flat 5 bps because depth was unavailable. */
    source: 'depth' | 'fallback';
    /** Half the top-of-book spread, bps. Null on fallback. */
    halfSpreadBps: number | null;
    /** True when the 20 visible levels cannot fill the notional, so `bps` is a lower bound. */
    exceedsTopOfBook: boolean;
  };
  /** Listing time, epoch ms (0 when unknown). Short histories follow from a recent listing. */
  onboardDate: number;
}

export type CostCheckErrorCode =
  | 'invalid_request'
  | 'unknown_symbol'
  | 'venue_unreachable'
  | 'venue_rate_limited';

export interface CostCheckError {
  error: CostCheckErrorCode;
  message: string;
  /** Present on `venue_rate_limited` when the venue said how long to wait. */
  retryAfterSeconds?: number;
}
