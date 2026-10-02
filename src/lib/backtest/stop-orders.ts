import type { OHLCV } from '@/types/market';
import type { TradeSide } from './types';

/**
 * A resting stop-entry order: a long leg is a buy stop that triggers when the
 * price rises to its trigger, a short leg a sell stop that triggers when the
 * price falls to it. Two legs make a one-cancels-other bracket: whichever
 * triggers first fills and the other is cancelled. Pure state; the bar loop
 * (bar-loop.ts) owns the wiring. Added for the legends phase (Turtle, NR7,
 * Holy Grail and Turtle Soup Plus One), whose entries are all stop orders.
 */
export interface StopOrderLeg {
  side: TradeSide;
  triggerPrice: number;
}

export interface PendingStopOrder {
  legs: StopOrderLeg[];
  placedBar: number;
  /** The order is live on bars placedBar + 1 .. placedBar + timeoutBars. */
  timeoutBars: number;
}

export type StopOrderOutcome =
  | {
      status: 'filled';
      /** Index into `legs` of the leg that filled. */
      leg: number;
      fillPrice: number;
      /** True when both legs of a bracket triggered on this bar, so the fill order is assumed (see below). */
      ambiguous: boolean;
    }
  | { status: 'expired' }
  | { status: 'pending' };

function triggered(leg: StopOrderLeg, candle: OHLCV): boolean {
  return leg.side === 'long' ? candle.high >= leg.triggerPrice : candle.low <= leg.triggerPrice;
}

/** A gap through the trigger fills at the open, the worse price; otherwise at the trigger. */
function fillPriceOf(leg: StopOrderLeg, candle: OHLCV): number {
  return leg.side === 'long'
    ? Math.max(candle.open, leg.triggerPrice)
    : Math.min(candle.open, leg.triggerPrice);
}

/** How far price had to travel from the open to reach a leg's trigger (0 when it opened through it). */
function distanceFromOpen(leg: StopOrderLeg, candle: OHLCV): number {
  return leg.side === 'long'
    ? Math.max(0, leg.triggerPrice - candle.open)
    : Math.max(0, candle.open - leg.triggerPrice);
}

/**
 * Evaluates a pending stop order against the candle at `bar`.
 *
 * An order is placed at a bar's close, so it never fills on its placement bar.
 * A leg triggers on a touch (a stop is a market order once its price trades):
 * a long leg when `high >= trigger`, a short leg when `low <= trigger`. The
 * fill is at the trigger, or at the open when the bar opened through it.
 *
 * When BOTH legs of a bracket trigger on one bar, the bar's own path is
 * unknown on OHLC data. The leg whose trigger lies nearer the open is assumed
 * to have filled first and the other is cancelled; the outcome is flagged
 * `ambiguous` so a caller can count such bars. For the legends' brackets the
 * other leg's trigger is usually the filled leg's stop, so the same bar then
 * stops the position out (the bar loop checks the stop after the fill).
 *
 * An order that has not triggered by its last live bar (placedBar +
 * timeoutBars) EXPIRES on that bar, and the bar loop then lets the strategy
 * decide again at that same close: that is how a rule "re-placed every bar"
 * (Turtle System 2) or "re-placed for up to three bars" (Holy Grail) is
 * expressed, each placement live for one bar.
 */
export function evaluateStopOrder(order: PendingStopOrder, bar: number, candle: OHLCV): StopOrderOutcome {
  const { legs, placedBar, timeoutBars } = order;
  if (bar <= placedBar) return { status: 'pending' };
  if (bar > placedBar + timeoutBars) return { status: 'expired' };

  const hit = legs.map((leg, index) => ({ leg, index })).filter(({ leg }) => triggered(leg, candle));
  if (hit.length === 0) {
    return bar === placedBar + timeoutBars ? { status: 'expired' } : { status: 'pending' };
  }

  let first = hit[0];
  for (const h of hit.slice(1)) {
    if (distanceFromOpen(h.leg, candle) < distanceFromOpen(first.leg, candle)) first = h;
  }
  return { status: 'filled', leg: first.index, fillPrice: fillPriceOf(first.leg, candle), ambiguous: hit.length > 1 };
}
