import type { DemoAlgoOrder, DemoPosition, DemoVenueFilter } from './binance-demo';
import { roundToStep, roundToTick } from './binance-demo';

/**
 * Mirrors ONE paper-desk book onto the demo account.
 *
 * It is a RECONCILER, not an order-event forwarder: every tick it compares
 * what the desk holds against what the venue holds and emits the difference.
 * A missed tick, a restart, a rejected order or a manual change on the venue
 * therefore self-corrects on the next tick, which an event-forwarding design
 * cannot do.
 *
 * The desk stays the source of truth. The mirror never changes desk state,
 * and a mirror failure never changes what the desk recorded. The desk's own
 * measurement is already complete without it; the venue only adds execution
 * truth.
 *
 * Why only one book: one Binance account holds one net position per symbol in
 * one-way mode, so two books that disagree on a symbol would cancel out and no
 * fill could be attributed to either. Verified 2026-10-01: the demo account is
 * tied to the main Binance login, with no sub-accounts, so a second isolated
 * demo account is not available.
 */

/** What the desk wants the venue to hold for one symbol. */
export interface DesiredPosition {
  symbol: string;
  side: 'long' | 'short';
  /** Desk quantity, before scaling to the demo account's size. */
  quantity: number;
  stopPrice: number;
  targetPrice: number | null;
}

export type MirrorIntent =
  | { kind: 'open'; symbol: string; side: 'BUY' | 'SELL'; quantity: number; reason: string }
  | { kind: 'close'; symbol: string; side: 'BUY' | 'SELL'; quantity: number; reason: string }
  | { kind: 'adjust'; symbol: string; side: 'BUY' | 'SELL'; quantity: number; reduceOnly: boolean; reason: string }
  | {
      kind: 'protect';
      symbol: string;
      side: 'BUY' | 'SELL';
      type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
      triggerPrice: number;
      quantity: number;
      clientAlgoId: string;
      reason: string;
    }
  | { kind: 'cancel'; symbol: string; algoId: number; reason: string }
  | { kind: 'skip'; symbol: string; reason: string };

export interface MirrorPlanInput {
  book: string;
  desired: DesiredPosition | null;
  actual: DemoPosition | null;
  algoOrders: DemoAlgoOrder[];
  filter: DemoVenueFilter;
  /**
   * Demo quantity per unit of desk quantity. The desk sizes each symbol
   * against a 1,000 USDT nominal ledger; the demo account has its own
   * balance, so the mirror scales rather than copying a quantity that would
   * mean something different against a different equity.
   */
  scale: number;
  /** Last price, used only for the minimum-notional check. */
  price: number;
}

/** A stable client id so a stop can be recognised across ticks. */
export function algoIdFor(book: string, symbol: string, leg: 'stop' | 'target'): string {
  // Binance pattern: ^[\.A-Z\:/a-z0-9_-]{1,36}$ -- the book's colon is allowed.
  return `${book}-${symbol}-${leg}`.slice(0, 36);
}

const sideOf = (side: 'long' | 'short') => (side === 'long' ? 'BUY' : 'SELL');
const exitSideOf = (side: 'long' | 'short') => (side === 'long' ? 'SELL' : 'BUY');

/**
 * The orders that would bring the venue in line with the desk.
 *
 * Pure: it reads only its input and returns intents. Nothing here sends
 * anything, which is what makes a dry run exact rather than approximate -- the
 * dry run logs these very intents.
 */
export function planMirror(input: MirrorPlanInput): MirrorIntent[] {
  const { book, desired, actual, algoOrders, filter, scale, price } = input;
  const intents: MirrorIntent[] = [];
  const symbol = filter.symbol;

  const actualQty = actual?.positionAmt ?? 0;
  const actualSide: 'long' | 'short' | null = actualQty === 0 ? null : actualQty > 0 ? 'long' : 'short';
  const actualAbs = Math.abs(actualQty);

  // 1. The desk is flat: cancel protection and close whatever the venue holds.
  if (!desired) {
    for (const order of algoOrders) {
      intents.push({ kind: 'cancel', symbol, algoId: order.algoId, reason: 'the desk is flat' });
    }
    if (actualSide) {
      intents.push({
        kind: 'close',
        symbol,
        side: exitSideOf(actualSide),
        quantity: actualAbs,
        reason: 'the desk is flat but the venue holds a position',
      });
    }
    return intents;
  }

  // 2. Scale the desk's size onto this account and round to the venue's grid,
  //    which is NOT the live grid the ticket used.
  const target = roundToStep(desired.quantity * scale, filter.stepSize);
  if (target < filter.minQty) {
    return [
      {
        kind: 'skip',
        symbol,
        reason: `scaled size ${(desired.quantity * scale).toPrecision(4)} rounds to ${target}, below the venue minimum ${filter.minQty}`,
      },
    ];
  }
  if (target * price < filter.minNotional) {
    return [
      {
        kind: 'skip',
        symbol,
        reason: `notional ${(target * price).toFixed(2)} USDT is below the venue minimum ${filter.minNotional}`,
      },
    ];
  }

  // 3. Wrong side: flatten first. A reduce-only order cannot cross zero, and
  //    one order through zero would leave the stop attached to a position that
  //    no longer exists.
  if (actualSide && actualSide !== desired.side) {
    for (const order of algoOrders) {
      intents.push({ kind: 'cancel', symbol, algoId: order.algoId, reason: 'the venue holds the wrong side' });
    }
    intents.push({
      kind: 'close',
      symbol,
      side: exitSideOf(actualSide),
      quantity: actualAbs,
      reason: `the desk is ${desired.side} but the venue is ${actualSide}`,
    });
    intents.push({
      kind: 'open',
      symbol,
      side: sideOf(desired.side),
      quantity: target,
      reason: `open ${desired.side} after flattening`,
    });
    intents.push(...protectionIntents(book, symbol, desired, target, filter, []));
    return intents;
  }

  // 4. Right side, or flat: size it.
  if (!actualSide) {
    intents.push({ kind: 'open', symbol, side: sideOf(desired.side), quantity: target, reason: 'the desk opened' });
  } else {
    const delta = roundToStep(Math.abs(target - actualAbs), filter.stepSize);
    // One step of tolerance, so rounding noise does not churn orders.
    if (delta >= filter.stepSize) {
      const growing = target > actualAbs;
      intents.push({
        kind: 'adjust',
        symbol,
        side: growing ? sideOf(desired.side) : exitSideOf(desired.side),
        quantity: delta,
        reduceOnly: !growing,
        reason: `venue holds ${actualAbs}, desk wants ${target}`,
      });
    }
  }

  // 5. Protection, reconciled against what is already resting.
  intents.push(...protectionIntents(book, symbol, desired, target, filter, algoOrders));
  return intents;
}

/**
 * Stop and target intents, replacing a resting order only when it actually
 * differs. Cancel-and-replace on every tick would churn the venue and lose
 * protection for the moment in between.
 */
function protectionIntents(
  book: string,
  symbol: string,
  desired: DesiredPosition,
  quantity: number,
  filter: DemoVenueFilter,
  resting: DemoAlgoOrder[]
): MirrorIntent[] {
  const intents: MirrorIntent[] = [];
  const exitSide = exitSideOf(desired.side);

  const legs: Array<{ leg: 'stop' | 'target'; type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'; price: number | null }> = [
    { leg: 'stop', type: 'STOP_MARKET', price: desired.stopPrice },
    { leg: 'target', type: 'TAKE_PROFIT_MARKET', price: desired.targetPrice },
  ];

  for (const { leg, type, price } of legs) {
    const clientAlgoId = algoIdFor(book, symbol, leg);
    const existing = resting.find((o) => o.clientAlgoId === clientAlgoId || o.type === type);

    if (price === null) {
      if (existing) {
        intents.push({ kind: 'cancel', symbol, algoId: existing.algoId, reason: `no ${leg} on this trade` });
      }
      continue;
    }

    const trigger = roundToTick(price, filter.tickSize);
    if (existing) {
      const sameTrigger = roundToTick(existing.triggerPrice, filter.tickSize) === trigger;
      const sameQty = roundToStep(existing.quantity, filter.stepSize) === quantity;
      if (sameTrigger && sameQty) continue;
      intents.push({
        kind: 'cancel',
        symbol,
        algoId: existing.algoId,
        reason: `${leg} moved: trigger ${existing.triggerPrice} -> ${trigger}, qty ${existing.quantity} -> ${quantity}`,
      });
    }
    intents.push({
      kind: 'protect',
      symbol,
      side: exitSide,
      type,
      triggerPrice: trigger,
      quantity,
      clientAlgoId,
      reason: existing ? `replace the ${leg}` : `attach the ${leg}`,
    });
  }

  return intents;
}

/** A one-line description of an intent, for the dry-run log and the report. */
export function describeIntent(intent: MirrorIntent): string {
  switch (intent.kind) {
    case 'open':
    case 'close':
      return `${intent.kind.toUpperCase()} ${intent.side} ${intent.quantity} ${intent.symbol} (${intent.reason})`;
    case 'adjust':
      return `ADJUST ${intent.side} ${intent.quantity} ${intent.symbol}${intent.reduceOnly ? ' reduceOnly' : ''} (${intent.reason})`;
    case 'protect':
      return `${intent.type} ${intent.side} ${intent.quantity} ${intent.symbol} @ ${intent.triggerPrice} id=${intent.clientAlgoId} (${intent.reason})`;
    case 'cancel':
      return `CANCEL algo ${intent.algoId} on ${intent.symbol} (${intent.reason})`;
    case 'skip':
      return `SKIP ${intent.symbol} (${intent.reason})`;
  }
}
