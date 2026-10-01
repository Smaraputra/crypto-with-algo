// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { DemoAlgoOrder, DemoPosition, DemoVenueFilter } from './binance-demo';
import { algoIdFor, describeIntent, planMirror, type DesiredPosition, type MirrorIntent } from './mirror';

const BOOK = 'day_trading:15m';

/** The DEMO BTCUSDT filters, which are finer than live's 0.001 step. */
const BTC: DemoVenueFilter = {
  symbol: 'BTCUSDT',
  status: 'TRADING',
  stepSize: 0.0001,
  minQty: 0.0001,
  minNotional: 50,
  tickSize: 0.1,
};

function desired(over: Partial<DesiredPosition> = {}): DesiredPosition {
  return {
    symbol: 'BTCUSDT',
    side: 'long',
    quantity: 0.01,
    stopPrice: 75000,
    targetPrice: 78000,
    ...over,
  };
}

function position(amt: number): DemoPosition {
  return { symbol: 'BTCUSDT', positionAmt: amt, entryPrice: 76000, unrealizedProfit: 0 };
}

function algo(over: Partial<DemoAlgoOrder> = {}): DemoAlgoOrder {
  return {
    algoId: 1,
    clientAlgoId: algoIdFor(BOOK, 'BTCUSDT', 'stop'),
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: 75000,
    quantity: 0.01,
    ...over,
  };
}

function plan(over: Partial<Parameters<typeof planMirror>[0]> = {}): MirrorIntent[] {
  return planMirror({
    book: BOOK,
    desired: desired(),
    actual: null,
    algoOrders: [],
    filter: BTC,
    scale: 1,
    price: 76000,
    ...over,
  });
}

const kinds = (intents: MirrorIntent[]) => intents.map((i) => i.kind);

describe('planMirror: opening', () => {
  it('opens and attaches both legs when the desk opens and the venue is flat', () => {
    const intents = plan();
    expect(kinds(intents)).toEqual(['open', 'protect', 'protect']);
    expect(intents[0]).toMatchObject({ kind: 'open', side: 'BUY', quantity: 0.01 });
    expect(intents[1]).toMatchObject({
      kind: 'protect',
      type: 'STOP_MARKET',
      side: 'SELL',
      triggerPrice: 75000,
      quantity: 0.01,
      clientAlgoId: 'day_trading:15m-BTCUSDT-stop',
    });
    expect(intents[2]).toMatchObject({ kind: 'protect', type: 'TAKE_PROFIT_MARKET', triggerPrice: 78000 });
  });

  it('mirrors a short with the exit legs inverted', () => {
    const intents = plan({ desired: desired({ side: 'short', stopPrice: 77000, targetPrice: 74000 }) });
    expect(intents[0]).toMatchObject({ kind: 'open', side: 'SELL' });
    expect(intents[1]).toMatchObject({ type: 'STOP_MARKET', side: 'BUY', triggerPrice: 77000 });
    expect(intents[2]).toMatchObject({ type: 'TAKE_PROFIT_MARKET', side: 'BUY', triggerPrice: 74000 });
  });

  it('scales the desk size onto the demo account and rounds to the venue step', () => {
    // 0.01 desk at 2.5x scale is 0.025; the demo step is 0.0001.
    const intents = plan({ scale: 2.5 });
    expect(intents[0]).toMatchObject({ quantity: 0.025 });
    // Protection carries the same size as the position.
    expect(intents[1]).toMatchObject({ quantity: 0.025 });
  });

  it('rounds the scaled size DOWN, never up', () => {
    const intents = plan({ desired: desired({ quantity: 0.012345678 }), scale: 1 });
    expect(intents[0]).toMatchObject({ quantity: 0.0123 });
  });

  it('attaches no target when the trade has none', () => {
    const intents = plan({ desired: desired({ targetPrice: null }) });
    expect(kinds(intents)).toEqual(['open', 'protect']);
    expect(intents[1]).toMatchObject({ type: 'STOP_MARKET' });
  });

  it('rounds the trigger to the venue tick', () => {
    const intents = plan({ desired: desired({ stopPrice: 75000.17, targetPrice: 78000.04 }) });
    expect(intents[1]).toMatchObject({ triggerPrice: 75000.2 });
    expect(intents[2]).toMatchObject({ triggerPrice: 78000 });
  });
});

describe('planMirror: the venue minimums', () => {
  it('skips with a reason when the scaled size rounds below the minimum quantity', () => {
    const intents = plan({ desired: desired({ quantity: 0.00005 }), scale: 1 });
    expect(kinds(intents)).toEqual(['skip']);
    expect(intents[0].reason).toContain('below the venue minimum 0.0001');
  });

  it('skips with a reason when the notional is below the minimum', () => {
    // 0.0005 BTC at 76,000 is 38 USDT, under the 50 USDT minimum.
    const intents = plan({ desired: desired({ quantity: 0.0005 }) });
    expect(kinds(intents)).toEqual(['skip']);
    expect(intents[0].reason).toContain('below the venue minimum 50');
  });

  it('places nothing else when it skips, so no stop is left orphaned', () => {
    const intents = plan({ desired: desired({ quantity: 0.0005 }), actual: null, algoOrders: [algo()] });
    expect(kinds(intents)).toEqual(['skip']);
  });
});

describe('planMirror: the desk is flat', () => {
  it('closes the venue position and cancels its protection', () => {
    const intents = plan({ desired: null, actual: position(0.01), algoOrders: [algo(), algo({ algoId: 2, type: 'TAKE_PROFIT_MARKET' })] });
    expect(kinds(intents)).toEqual(['cancel', 'cancel', 'close']);
    expect(intents[2]).toMatchObject({ kind: 'close', side: 'SELL', quantity: 0.01 });
  });

  it('closes a short with a BUY', () => {
    const intents = plan({ desired: null, actual: position(-0.02), algoOrders: [] });
    expect(intents[0]).toMatchObject({ kind: 'close', side: 'BUY', quantity: 0.02 });
  });

  it('does nothing when both sides are already flat', () => {
    expect(plan({ desired: null, actual: null, algoOrders: [] })).toEqual([]);
  });

  it('still cancels stray protection when the venue is flat but orders rest', () => {
    const intents = plan({ desired: null, actual: null, algoOrders: [algo()] });
    expect(kinds(intents)).toEqual(['cancel']);
  });
});

describe('planMirror: the venue is out of step', () => {
  it('flattens, reopens and re-protects when the venue holds the wrong side', () => {
    const intents = plan({ actual: position(-0.01), algoOrders: [algo({ side: 'BUY' })] });
    expect(kinds(intents)).toEqual(['cancel', 'close', 'open', 'protect', 'protect']);
    expect(intents[1]).toMatchObject({ kind: 'close', side: 'BUY', quantity: 0.01 });
    expect(intents[2]).toMatchObject({ kind: 'open', side: 'BUY', quantity: 0.01 });
  });

  it('tops up a position that is too small, without reduceOnly', () => {
    const intents = plan({ actual: position(0.006) });
    expect(intents[0]).toMatchObject({ kind: 'adjust', side: 'BUY', quantity: 0.004, reduceOnly: false });
  });

  it('trims a position that is too large, with reduceOnly', () => {
    const intents = plan({ actual: position(0.015) });
    expect(intents[0]).toMatchObject({ kind: 'adjust', side: 'SELL', quantity: 0.005, reduceOnly: true });
  });

  it('trims a short by BUYing reduce-only', () => {
    const intents = plan({
      desired: desired({ side: 'short', stopPrice: 77000, targetPrice: 74000, quantity: 0.01 }),
      actual: position(-0.015),
    });
    expect(intents[0]).toMatchObject({ kind: 'adjust', side: 'BUY', quantity: 0.005, reduceOnly: true });
  });

  it('leaves a difference below one step alone, so rounding does not churn orders', () => {
    const intents = plan({ actual: position(0.01005), algoOrders: [algo(), algo({ algoId: 2, type: 'TAKE_PROFIT_MARKET', triggerPrice: 78000 })] });
    expect(kinds(intents)).toEqual([]);
  });
});

describe('planMirror: protection is reconciled, not re-sent', () => {
  const resting = [
    algo({ algoId: 1, type: 'STOP_MARKET', triggerPrice: 75000, quantity: 0.01 }),
    algo({ algoId: 2, clientAlgoId: algoIdFor(BOOK, 'BTCUSDT', 'target'), type: 'TAKE_PROFIT_MARKET', triggerPrice: 78000, quantity: 0.01 }),
  ];

  it('emits nothing when both legs already match', () => {
    expect(plan({ actual: position(0.01), algoOrders: resting })).toEqual([]);
  });

  it('replaces only the leg whose trigger moved', () => {
    const moved = [resting[0], { ...resting[1], triggerPrice: 79000 }];
    const intents = plan({ actual: position(0.01), algoOrders: moved });
    expect(kinds(intents)).toEqual(['cancel', 'protect']);
    expect(intents[0]).toMatchObject({ algoId: 2 });
    expect(intents[1]).toMatchObject({ type: 'TAKE_PROFIT_MARKET', triggerPrice: 78000 });
    expect(intents[0].reason).toContain('trigger');
  });

  it('replaces a leg whose size no longer matches the position', () => {
    const stale = resting.map((o) => ({ ...o, quantity: 0.005 }));
    const intents = plan({ actual: position(0.01), algoOrders: stale });
    expect(kinds(intents)).toEqual(['cancel', 'protect', 'cancel', 'protect']);
    expect(intents[0].reason).toContain('qty');
  });

  it('cancels a resting target when the trade no longer has one', () => {
    const intents = plan({
      desired: desired({ targetPrice: null }),
      actual: position(0.01),
      algoOrders: resting,
    });
    expect(kinds(intents)).toEqual(['cancel']);
    expect(intents[0]).toMatchObject({ algoId: 2, reason: 'no target on this trade' });
  });

  it('matches a resting order by type when the client id is absent, so a restart does not duplicate it', () => {
    const anonymous = [
      algo({ algoId: 7, clientAlgoId: '', type: 'STOP_MARKET', triggerPrice: 75000, quantity: 0.01 }),
      algo({ algoId: 8, clientAlgoId: '', type: 'TAKE_PROFIT_MARKET', triggerPrice: 78000, quantity: 0.01 }),
    ];
    expect(plan({ actual: position(0.01), algoOrders: anonymous })).toEqual([]);
  });
});

describe('algoIdFor', () => {
  it('is stable per book, symbol and leg', () => {
    expect(algoIdFor('day_trading:1h', 'BTCUSDT', 'stop')).toBe('day_trading:1h-BTCUSDT-stop');
    expect(algoIdFor('day_trading:1h', 'BTCUSDT', 'target')).toBe('day_trading:1h-BTCUSDT-target');
  });

  it('stays inside the 36 characters Binance allows, using only permitted characters', () => {
    for (const book of ['position_trading:1d', 'swing_trading:4h', 'day_trading:15m']) {
      for (const leg of ['stop', 'target'] as const) {
        const id = algoIdFor(book, 'DOGEUSDT', leg);
        expect(id.length).toBeLessThanOrEqual(36);
        expect(id).toMatch(/^[.A-Z:/a-z0-9_-]{1,36}$/);
      }
    }
  });
});

describe('describeIntent', () => {
  it('renders each kind as one readable line for the dry-run log', () => {
    const intents = plan({ actual: position(-0.01), algoOrders: [algo()] });
    const lines = intents.map(describeIntent);
    expect(lines[0]).toMatch(/^CANCEL algo 1 on BTCUSDT/);
    expect(lines[1]).toMatch(/^CLOSE BUY 0.01 BTCUSDT/);
    expect(lines[2]).toMatch(/^OPEN BUY 0.01 BTCUSDT/);
    expect(lines[3]).toMatch(/^STOP_MARKET SELL 0.01 BTCUSDT @ 75000 id=day_trading:15m-BTCUSDT-stop/);
    expect(describeIntent({ kind: 'skip', symbol: 'BTCUSDT', reason: 'too small' })).toBe(
      'SKIP BTCUSDT (too small)'
    );
    expect(
      describeIntent({ kind: 'adjust', symbol: 'BTCUSDT', side: 'SELL', quantity: 0.001, reduceOnly: true, reason: 'trim' })
    ).toContain('reduceOnly');
  });
});
