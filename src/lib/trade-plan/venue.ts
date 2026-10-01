import type { VenueFilter } from './types';

/**
 * Binance USDT-M perpetual order filters for the ten signal symbols.
 *
 * Fetched from `https://fapi.binance.com/fapi/v1/exchangeInfo` over the VPS
 * (the home ISP blocks Binance) on 2026-10-01, server time
 * 2026-09-30T09:00:43Z. Every symbol was TRADING, and MARKET_LOT_SIZE equalled
 * LOT_SIZE for each, so one step and minimum serve both order types. Binance
 * changes these filters without notice (BTCUSDT's minimum notional fell from
 * 100 to 50 USDT on 2026-04-14), so refresh the table before relying on it for
 * real orders.
 */
export const VENUE_FILTERS_FETCHED_AT = '2026-10-01';

export const VENUE_FILTERS: Record<string, VenueFilter> = {
  BTCUSDT: { symbol: 'BTCUSDT', stepSize: 0.001, minQty: 0.001, minNotional: 50, tickSize: 0.1 },
  ETHUSDT: { symbol: 'ETHUSDT', stepSize: 0.001, minQty: 0.001, minNotional: 20, tickSize: 0.01 },
  BNBUSDT: { symbol: 'BNBUSDT', stepSize: 0.01, minQty: 0.01, minNotional: 5, tickSize: 0.01 },
  SOLUSDT: { symbol: 'SOLUSDT', stepSize: 0.01, minQty: 0.01, minNotional: 5, tickSize: 0.01 },
  XRPUSDT: { symbol: 'XRPUSDT', stepSize: 0.1, minQty: 0.1, minNotional: 5, tickSize: 0.0001 },
  ADAUSDT: { symbol: 'ADAUSDT', stepSize: 1, minQty: 1, minNotional: 5, tickSize: 0.0001 },
  DOGEUSDT: { symbol: 'DOGEUSDT', stepSize: 1, minQty: 1, minNotional: 5, tickSize: 0.00001 },
  AVAXUSDT: { symbol: 'AVAXUSDT', stepSize: 1, minQty: 1, minNotional: 5, tickSize: 0.001 },
  DOTUSDT: { symbol: 'DOTUSDT', stepSize: 0.1, minQty: 0.1, minNotional: 5, tickSize: 0.0001 },
  LINKUSDT: { symbol: 'LINKUSDT', stepSize: 0.01, minQty: 0.01, minNotional: 5, tickSize: 0.001 },
};

export function venueFilterFor(symbol: string): VenueFilter {
  const filter = VENUE_FILTERS[symbol];
  if (!filter) throw new Error(`No venue filter recorded for ${symbol}`);
  return filter;
}

/** Decimal places of an increment such as 0.001 (3) or 1 (0), so rounding
 * does not leave binary noise like 0.30000000000000004 in an order. */
export function decimalsOf(increment: number): number {
  const text = increment.toString();
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Rounds a quantity DOWN to the step: an order may never be larger than the sized risk. */
export function roundQty(quantity: number, stepSize: number): number {
  if (!(quantity > 0)) return 0;
  // The epsilon keeps an exact multiple such as 0.3 / 0.1 = 2.9999999999999996 from losing a step.
  const steps = Math.floor(quantity / stepSize + 1e-9);
  return Number((steps * stepSize).toFixed(decimalsOf(stepSize)));
}

/** Rounds a price to the nearest tick. */
export function roundPrice(price: number, tickSize: number): number {
  const ticks = Math.round(price / tickSize);
  return Number((ticks * tickSize).toFixed(decimalsOf(tickSize)));
}

/** Why an order of this size cannot be sent, or null when it can. */
export function placeability(quantity: number, price: number, filter: VenueFilter): string | null {
  if (quantity < filter.minQty) {
    return `Size ${quantity} is below the ${filter.symbol} minimum of ${filter.minQty}`;
  }
  const notional = quantity * price;
  if (notional < filter.minNotional) {
    return `Notional ${notional.toFixed(2)} USDT is below the ${filter.symbol} minimum of ${filter.minNotional} USDT`;
  }
  return null;
}
