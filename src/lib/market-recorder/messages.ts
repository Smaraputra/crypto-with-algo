import { z } from 'zod';

/**
 * Parsing and validation of the Binance USDT-M combined-stream messages the
 * market recorder subscribes to. Pure: no I/O, no clock (the caller passes
 * `receivedAt`).
 *
 * Shapes verified against a live `/market/stream` session on 2026-10-08:
 *
 *   {"stream":"btcusdt@aggTrade","data":{"e":"aggTrade","E":..,"a":..,"s":"BTCUSDT",
 *    "p":"83434.40","q":"0.016","nq":"0.016","f":..,"l":..,"T":..,"m":true,"st":1}}
 *   {"stream":"!forceOrder@arr","data":{"e":"forceOrder","E":..,"o":{"s":"ILVUSDT",
 *    "S":"SELL","o":"LIMIT","f":"IOC","q":"116.5","p":"3.80300","ap":"3.85642",
 *    "X":"FILLED","l":"25.2","z":"116.5","T":..,"ps":"ILVUSDT","st":1}}}
 *
 * `q` is the quantity of all market trades; `nq` excludes trades against RPI
 * orders and is not recorded. Despite its name `!forceOrder@arr` sends one
 * object per message; an array is accepted anyway. Binance's docs place `ps`
 * and `st` beside `o`, the live stream inside it; both are read.
 */

/** A non-negative decimal string as Binance sends prices and quantities. */
const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'not a non-negative decimal string')
  .transform(Number);

const positiveDecimalString = decimalString.refine((n) => n > 0, 'must be positive');

const epochMs = z.number().int().positive();
const id = z.number().int().nonnegative();

const aggTradeSchema = z
  .object({
    e: z.literal('aggTrade'),
    E: epochMs,
    s: z.string().min(1),
    a: id,
    p: positiveDecimalString,
    q: positiveDecimalString,
    f: id,
    l: id,
    T: epochMs,
    m: z.boolean(),
  })
  .refine((d) => d.l >= d.f, 'last trade id below first trade id');

const forceOrderSchema = z.object({
  e: z.literal('forceOrder'),
  E: epochMs,
  o: z.object({
    s: z.string().min(1),
    S: z.enum(['BUY', 'SELL']),
    o: z.string().min(1),
    f: z.string().min(1),
    q: decimalString,
    p: decimalString,
    ap: decimalString,
    X: z.string().min(1),
    l: decimalString,
    z: decimalString,
    T: epochMs,
    ps: z.string().optional(),
    st: z.number().int().optional(),
  }),
  ps: z.string().optional(),
  st: z.number().int().optional(),
});

const envelopeSchema = z.object({
  stream: z.string(),
  data: z.unknown(),
});

export interface AggTrade {
  symbol: string;
  aggId: number;
  price: number;
  qty: number;
  firstTradeId: number;
  lastTradeId: number;
  /** Binance trade time, epoch ms. */
  tradeTime: number;
  eventTime: number;
  /** `m`: true means the taker SOLD. */
  buyerIsMaker: boolean;
}

export interface LiquidationRecord {
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  timeInForce: string;
  origQty: number;
  price: number;
  avgPrice: number;
  status: string;
  lastFilledQty: number;
  filledAccumulatedQty: number;
  tradeTime: number;
  eventTime: number;
  receivedAt: number;
  pair: string | null;
  symbolType: number | null;
}

export type ParsedMessage =
  | { kind: 'aggTrade'; trade: AggTrade }
  | { kind: 'liquidations'; events: LiquidationRecord[]; invalid: number }
  /** Valid JSON this recorder has no use for (a subscription ack, another event type). */
  | { kind: 'ignored'; reason: string }
  | { kind: 'invalid'; error: string };

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function eventType(data: unknown): string | null {
  if (data && typeof data === 'object' && 'e' in data) {
    const e = (data as { e: unknown }).e;
    return typeof e === 'string' ? e : null;
  }
  return null;
}

function toLiquidation(raw: unknown, receivedAt: number): LiquidationRecord | string {
  const parsed = forceOrderSchema.safeParse(raw);
  if (!parsed.success) return firstIssue(parsed.error);
  const { E, o, ps, st } = parsed.data;
  return {
    symbol: o.s,
    side: o.S,
    orderType: o.o,
    timeInForce: o.f,
    origQty: o.q,
    price: o.p,
    avgPrice: o.ap,
    status: o.X,
    lastFilledQty: o.l,
    filledAccumulatedQty: o.z,
    tradeTime: o.T,
    eventTime: E,
    receivedAt,
    pair: o.ps ?? ps ?? null,
    symbolType: o.st ?? st ?? null,
  };
}

/** Parses one combined-stream frame. Never throws. */
export function parseStreamMessage(raw: string, receivedAt: number): ParsedMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', error: 'not JSON' };
  }

  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    // A subscription ack ({"result":null,"id":1}) is the only well-formed
    // non-envelope frame Binance sends on a combined stream.
    if (json && typeof json === 'object' && 'id' in json) {
      return { kind: 'ignored', reason: 'control frame' };
    }
    return { kind: 'invalid', error: `envelope: ${firstIssue(envelope.error)}` };
  }

  const { data } = envelope.data;

  if (Array.isArray(data)) {
    const events: LiquidationRecord[] = [];
    let invalid = 0;
    for (const item of data) {
      if (eventType(item) !== 'forceOrder') {
        invalid++;
        continue;
      }
      const result = toLiquidation(item, receivedAt);
      if (typeof result === 'string') invalid++;
      else events.push(result);
    }
    if (events.length === 0 && invalid > 0) {
      return { kind: 'invalid', error: 'array with no valid forceOrder' };
    }
    return { kind: 'liquidations', events, invalid };
  }

  const type = eventType(data);

  if (type === 'aggTrade') {
    const parsed = aggTradeSchema.safeParse(data);
    if (!parsed.success) return { kind: 'invalid', error: `aggTrade ${firstIssue(parsed.error)}` };
    const d = parsed.data;
    return {
      kind: 'aggTrade',
      trade: {
        symbol: d.s,
        aggId: d.a,
        price: d.p,
        qty: d.q,
        firstTradeId: d.f,
        lastTradeId: d.l,
        tradeTime: d.T,
        eventTime: d.E,
        buyerIsMaker: d.m,
      },
    };
  }

  if (type === 'forceOrder') {
    const result = toLiquidation(data, receivedAt);
    if (typeof result === 'string') return { kind: 'invalid', error: `forceOrder ${result}` };
    return { kind: 'liquidations', events: [result], invalid: 0 };
  }

  return { kind: 'ignored', reason: type ? `event ${type}` : 'no event type' };
}
