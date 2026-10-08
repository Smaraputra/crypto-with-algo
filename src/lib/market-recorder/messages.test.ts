import { describe, expect, it } from 'vitest';

import { LIVE_AGG_TRADE_FRAME, LIVE_FORCE_ORDER_FRAME } from '@/__fixtures__/market-recorder';

import { parseStreamMessage } from './messages';

const RECEIVED = 1_791_391_083_500;

function aggData(overrides: Record<string, unknown> = {}) {
  return {
    e: 'aggTrade',
    E: 1_791_391_082_024,
    a: 3_478_018_549,
    s: 'BTCUSDT',
    p: '83434.40',
    q: '0.016',
    f: 8_154_045_700,
    l: 8_154_045_704,
    T: 1_791_391_081_874,
    m: true,
    ...overrides,
  };
}

function frame(data: unknown, stream = 'btcusdt@aggTrade'): string {
  return JSON.stringify({ stream, data });
}

describe('parseStreamMessage: aggTrade', () => {
  it('parses the live frame into numbers', () => {
    const parsed = parseStreamMessage(LIVE_AGG_TRADE_FRAME, RECEIVED);

    expect(parsed).toEqual({
      kind: 'aggTrade',
      trade: {
        symbol: 'BTCUSDT',
        aggId: 3_478_018_549,
        price: 83434.4,
        qty: 0.016,
        firstTradeId: 8_154_045_700,
        lastTradeId: 8_154_045_704,
        tradeTime: 1_791_391_081_874,
        eventTime: 1_791_391_082_024,
        buyerIsMaker: true,
      },
    });
  });

  it('keeps the buyer-is-maker flag as sent, so the aggregator can read a taker sell', () => {
    const parsed = parseStreamMessage(frame(aggData({ m: false })), RECEIVED);

    expect(parsed.kind).toBe('aggTrade');
    if (parsed.kind === 'aggTrade') expect(parsed.trade.buyerIsMaker).toBe(false);
  });

  it.each([
    ['a non-numeric price', { p: 'abc' }],
    ['a negative quantity', { q: '-1' }],
    ['a zero quantity', { q: '0' }],
    ['an exponent-form price', { p: '1e5' }],
    ['a missing trade time', { T: undefined }],
    ['a string buyer-is-maker flag', { m: 'true' }],
    ['a last trade id below the first', { f: 10, l: 9 }],
  ])('rejects %s', (_label, overrides) => {
    const parsed = parseStreamMessage(frame(aggData(overrides)), RECEIVED);

    expect(parsed.kind).toBe('invalid');
  });
});

describe('parseStreamMessage: forceOrder', () => {
  it('parses the live frame, reading ps and st from inside the order', () => {
    const parsed = parseStreamMessage(LIVE_FORCE_ORDER_FRAME, RECEIVED);

    expect(parsed).toEqual({
      kind: 'liquidations',
      invalid: 0,
      events: [
        {
          symbol: 'ILVUSDT',
          side: 'SELL',
          orderType: 'LIMIT',
          timeInForce: 'IOC',
          origQty: 116.5,
          price: 3.803,
          avgPrice: 3.85642,
          status: 'FILLED',
          lastFilledQty: 25.2,
          filledAccumulatedQty: 116.5,
          tradeTime: 1_791_391_082_119,
          eventTime: 1_791_391_083_124,
          receivedAt: RECEIVED,
          pair: 'ILVUSDT',
          symbolType: 1,
        },
      ],
    });
  });

  it('reads ps and st beside the order, where the docs place them', () => {
    const live = JSON.parse(LIVE_FORCE_ORDER_FRAME);
    delete live.data.o.ps;
    delete live.data.o.st;
    live.data.ps = 'BTCUSD';
    live.data.st = 2;

    const parsed = parseStreamMessage(JSON.stringify(live), RECEIVED);

    expect(parsed.kind).toBe('liquidations');
    if (parsed.kind === 'liquidations') {
      expect(parsed.events[0].pair).toBe('BTCUSD');
      expect(parsed.events[0].symbolType).toBe(2);
    }
  });

  it('stores null when the stream sends neither ps nor st', () => {
    const live = JSON.parse(LIVE_FORCE_ORDER_FRAME);
    delete live.data.o.ps;
    delete live.data.o.st;

    const parsed = parseStreamMessage(JSON.stringify(live), RECEIVED);

    expect(parsed.kind === 'liquidations' && parsed.events[0]).toMatchObject({ pair: null, symbolType: null });
  });

  it('accepts an array payload and counts its invalid items', () => {
    const live = JSON.parse(LIVE_FORCE_ORDER_FRAME);
    const broken = { ...live.data, o: { ...live.data.o, S: 'SIDEWAYS' } };
    const raw = JSON.stringify({ stream: '!forceOrder@arr', data: [live.data, broken] });

    const parsed = parseStreamMessage(raw, RECEIVED);

    expect(parsed.kind).toBe('liquidations');
    if (parsed.kind === 'liquidations') {
      expect(parsed.events).toHaveLength(1);
      expect(parsed.invalid).toBe(1);
    }
  });

  it('rejects an unknown side', () => {
    const live = JSON.parse(LIVE_FORCE_ORDER_FRAME);
    live.data.o.S = 'LONG';

    expect(parseStreamMessage(JSON.stringify(live), RECEIVED).kind).toBe('invalid');
  });
});

describe('parseStreamMessage: everything else', () => {
  it('rejects a frame that is not JSON', () => {
    expect(parseStreamMessage('{not json', RECEIVED)).toEqual({ kind: 'invalid', error: 'not JSON' });
  });

  it('ignores a subscription acknowledgement', () => {
    expect(parseStreamMessage('{"result":null,"id":1}', RECEIVED).kind).toBe('ignored');
  });

  it('ignores an event type the recorder does not use', () => {
    const parsed = parseStreamMessage(frame({ e: 'markPriceUpdate', E: 1 }, 'btcusdt@markPrice'), RECEIVED);

    expect(parsed).toEqual({ kind: 'ignored', reason: 'event markPriceUpdate' });
  });

  it('rejects JSON that is not a combined-stream envelope', () => {
    expect(parseStreamMessage('{"e":"aggTrade"}', RECEIVED).kind).toBe('invalid');
  });
});
