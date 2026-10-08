/**
 * Binance USDT-M combined-stream frames for the market recorder's tests.
 * The first two are verbatim from a live `/market/stream` session on
 * 2026-10-08; the builders below vary them.
 */

export const LIVE_AGG_TRADE_FRAME =
  '{"stream":"btcusdt@aggTrade","data":{"e":"aggTrade","E":1791391082024,"a":3478018549,"s":"BTCUSDT","p":"83434.40","q":"0.016","nq":"0.016","f":8154045700,"l":8154045704,"T":1791391081874,"m":true,"st":1}}';

export const LIVE_FORCE_ORDER_FRAME =
  '{"stream":"!forceOrder@arr","data":{"e":"forceOrder","E":1791391083124,"o":{"s":"ILVUSDT","S":"SELL","o":"LIMIT","f":"IOC","q":"116.5","p":"3.80300","ap":"3.85642","X":"FILLED","l":"25.2","z":"116.5","T":1791391082119,"ps":"ILVUSDT","st":1}}}';

export interface AggTradeFrameInput {
  symbol?: string;
  aggId: number;
  price: number | string;
  qty: number | string;
  tradeTime: number;
  buyerIsMaker: boolean;
  firstTradeId?: number;
  lastTradeId?: number;
}

export function aggTradeFrame(input: AggTradeFrameInput): string {
  const symbol = input.symbol ?? 'BTCUSDT';
  const first = input.firstTradeId ?? input.aggId * 10;
  return JSON.stringify({
    stream: `${symbol.toLowerCase()}@aggTrade`,
    data: {
      e: 'aggTrade',
      E: input.tradeTime + 50,
      a: input.aggId,
      s: symbol,
      p: String(input.price),
      q: String(input.qty),
      nq: String(input.qty),
      f: first,
      l: input.lastTradeId ?? first,
      T: input.tradeTime,
      m: input.buyerIsMaker,
      st: 1,
    },
  });
}

export interface ForceOrderFrameInput {
  symbol?: string;
  side?: 'BUY' | 'SELL';
  tradeTime: number;
  qty?: string;
  price?: string;
}

export function forceOrderFrame(input: ForceOrderFrameInput): string {
  const symbol = input.symbol ?? 'ETHUSDT';
  return JSON.stringify({
    stream: '!forceOrder@arr',
    data: {
      e: 'forceOrder',
      E: input.tradeTime + 5,
      o: {
        s: symbol,
        S: input.side ?? 'SELL',
        o: 'LIMIT',
        f: 'IOC',
        q: input.qty ?? '1.5',
        p: input.price ?? '2000.10',
        ap: input.price ?? '2000.10',
        X: 'FILLED',
        l: input.qty ?? '1.5',
        z: input.qty ?? '1.5',
        T: input.tradeTime,
        ps: symbol,
        st: 1,
      },
    },
  });
}
