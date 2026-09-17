import type { OHLCV } from '@/types/market';
import type { TradeSide } from './types';

/**
 * A resting limit order awaiting a fill: a long order is a buy limit, a
 * short order is a sell limit. Pure state; no engine wiring.
 */
export interface PendingOrder {
  side: TradeSide;
  limitPrice: number;
  placedBar: number;
  timeoutBars: number;
}

export type LimitOrderOutcome =
  | { status: 'filled'; fillPrice: number; fillBar: number }
  | { status: 'cancelled' }
  | { status: 'pending' };

/**
 * Evaluates a pending limit order against the candle at `bar`. An order
 * never fills on its own placement bar, since it is placed at that bar's
 * close: bar must be strictly after placedBar. It fills the first bar where
 * price strictly breaches the limit (an exact touch does not fill): a long
 * order (buy limit) on `candle.low < limitPrice`, a short order (sell limit)
 * on `candle.high > limitPrice`. When the candle gaps through the limit
 * (the open already clears it), the fill is at the open, the better price;
 * otherwise it fills at limitPrice. An order not filled by
 * placedBar + timeoutBars is cancelled the following bar.
 */
export function evaluateLimitOrder(order: PendingOrder, bar: number, candle: OHLCV): LimitOrderOutcome {
  const { side, limitPrice, placedBar, timeoutBars } = order;

  if (bar <= placedBar) {
    return { status: 'pending' };
  }
  if (bar > placedBar + timeoutBars) {
    return { status: 'cancelled' };
  }

  const breached = side === 'long' ? candle.low < limitPrice : candle.high > limitPrice;
  if (!breached) {
    return { status: 'pending' };
  }

  const gappedThrough = side === 'long' ? limitPrice > candle.open : limitPrice < candle.open;
  const fillPrice = gappedThrough ? candle.open : limitPrice;

  return { status: 'filled', fillPrice, fillBar: bar };
}
