import { describe, it, expect } from 'vitest';
import { blackScholesDelta, blackScholesGamma, yearsToExpiry, type OptionTrade } from '@/lib/external/deribit';
import {
  OPTIONS_SLOT_MS,
  aggregateOptionTrades,
  dvolUpserts,
  flowUpserts,
  optionTradeGreeks,
  type OptionsFlowHour,
} from './options-flow';

const HOUR = Date.UTC(2024, 0, 1, 10, 0, 0);

function trade(overrides: Partial<OptionTrade> = {}): OptionTrade {
  return {
    timestamp: HOUR + 5 * 60 * 1000,
    tradeId: 't1',
    tradeSeq: 1,
    instrumentName: 'BTC-1JUL24-42000-C',
    direction: 'buy',
    price: 0.05,
    markPrice: 0.051,
    iv: 60,
    indexPrice: 42000,
    amount: 1,
    contracts: 1,
    ...overrides,
  };
}

describe('optionTradeGreeks', () => {
  it('computes delta and gamma matching the Black-Scholes helpers directly', () => {
    const t = trade({ instrumentName: 'BTC-1JUL24-60000-C', iv: 60 });
    const tau = yearsToExpiry(Date.UTC(2024, 6, 1, 8, 0, 0), t.timestamp);
    const expectedDelta = blackScholesDelta(42000, 60000, tau, 0.6, true);
    const expectedGamma = blackScholesGamma(42000, 60000, tau, 0.6);

    const greeks = optionTradeGreeks(t);
    expect(greeks).not.toBeNull();
    expect(greeks!.delta).toBeCloseTo(expectedDelta, 10);
    expect(greeks!.gamma).toBeCloseTo(expectedGamma, 10);
  });

  it('is null when the instrument does not parse', () => {
    expect(optionTradeGreeks(trade({ instrumentName: 'BTC-PERPETUAL' }))).toBeNull();
  });

  it('is null when iv is null or <= 0', () => {
    expect(optionTradeGreeks(trade({ iv: null }))).toBeNull();
    expect(optionTradeGreeks(trade({ iv: 0 }))).toBeNull();
    expect(optionTradeGreeks(trade({ iv: -5 }))).toBeNull();
  });

  it('is null when indexPrice <= 0', () => {
    expect(optionTradeGreeks(trade({ indexPrice: 0 }))).toBeNull();
  });

  it('is null once expiry has passed (tau <= 0)', () => {
    const expired = trade({
      instrumentName: 'BTC-1JAN24-42000-C',
      timestamp: Date.UTC(2024, 5, 1),
    });
    expect(optionTradeGreeks(expired)).toBeNull();
  });

  it('floors a small positive tau at GREEKS_MIN_TAU_YEARS instead of blowing up', () => {
    // One minute before an ATM expiry: unfloored tau would send gamma toward infinity.
    const almostExpired = trade({
      instrumentName: 'BTC-1JUL24-42000-C',
      timestamp: Date.UTC(2024, 6, 1, 7, 59, 0),
      indexPrice: 42000,
      iv: 60,
    });
    const greeks = optionTradeGreeks(almostExpired);
    expect(greeks).not.toBeNull();
    expect(Number.isFinite(greeks!.gamma)).toBe(true);
    expect(greeks!.gamma).toBeCloseTo(blackScholesGamma(42000, 42000, 1 / 8760, 0.6), 6);
  });
});

describe('aggregateOptionTrades', () => {
  it('buckets by UTC hour open and skips empty hours', () => {
    const hourA = Date.UTC(2024, 0, 1, 10, 0, 0);
    const hourC = Date.UTC(2024, 0, 1, 12, 0, 0); // hour B (11:00) has no trades

    const rows = aggregateOptionTrades([
      trade({ tradeId: 'a', timestamp: hourA + 60_000 }),
      trade({ tradeId: 'c', timestamp: hourC + 60_000 }),
    ]);

    expect(rows.map((r) => r.timestamp)).toEqual([hourA, hourC]);
  });

  it('splits notional by call/put and taker side', () => {
    const rows = aggregateOptionTrades([
      trade({ tradeId: 'callBuy', instrumentName: 'BTC-1JUL24-42000-C', direction: 'buy', amount: 1, indexPrice: 40000 }),
      trade({ tradeId: 'callSell', instrumentName: 'BTC-1JUL24-42000-C', direction: 'sell', amount: 2, indexPrice: 40000 }),
      trade({ tradeId: 'putBuy', instrumentName: 'BTC-1JUL24-42000-P', direction: 'buy', amount: 3, indexPrice: 40000 }),
      trade({ tradeId: 'putSell', instrumentName: 'BTC-1JUL24-42000-P', direction: 'sell', amount: 4, indexPrice: 40000 }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].callBuyNotional).toBe(40000);
    expect(rows[0].callSellNotional).toBe(80000);
    expect(rows[0].putBuyNotional).toBe(120000);
    expect(rows[0].putSellNotional).toBe(160000);
    expect(rows[0].tradeCount).toBe(4);
  });

  it('signs netDelta and netDollarGamma by taker side, matching a hand computation', () => {
    const expiryMs = Date.UTC(2024, 6, 1, 8, 0, 0);
    const t = trade({
      instrumentName: 'BTC-1JUL24-60000-C',
      direction: 'sell',
      amount: 5,
      indexPrice: 42000,
      iv: 60,
    });
    const tau = yearsToExpiry(expiryMs, t.timestamp);
    const delta = blackScholesDelta(42000, 60000, tau, 0.6, true);
    const gamma = blackScholesGamma(42000, 60000, tau, 0.6);

    const rows = aggregateOptionTrades([t]);

    expect(rows[0].netDelta).toBeCloseTo(-1 * delta * 5, 8);
    expect(rows[0].netDollarGamma).toBeCloseTo((-1 * gamma * 5 * 42000 * 42000) / 100, 2);
    expect(rows[0].greekTradeCount).toBe(1);
  });

  it('weights vwIv by notional and is null when no trade has a finite iv', () => {
    const withIv = aggregateOptionTrades([
      trade({ tradeId: 'x', amount: 1, indexPrice: 1000, iv: 50 }),
      trade({ tradeId: 'y', amount: 3, indexPrice: 1000, iv: 70 }),
    ]);
    // (1000*50 + 3000*70) / (1000 + 3000) = 65
    expect(withIv[0].vwIv).toBeCloseTo(65, 8);

    const withoutIv = aggregateOptionTrades([trade({ tradeId: 'z', iv: null })]);
    expect(withoutIv[0].vwIv).toBeNull();
  });

  it('excludes iv 0 prints from vwIv but keeps them in count and notional', () => {
    // Deribit reports iv: 0 as a placeholder for "could not be computed"
    // (typically a deep-in-the-money print), not a real zero-vol reading.
    const rows = aggregateOptionTrades([
      trade({
        tradeId: 'zero-iv',
        instrumentName: 'BTC-1JUL24-42000-C',
        direction: 'buy',
        amount: 2,
        indexPrice: 40000,
        iv: 0,
      }),
    ]);

    expect(rows[0].tradeCount).toBe(1);
    expect(rows[0].callBuyNotional).toBe(80000);
    expect(rows[0].vwIv).toBeNull();
    expect(rows[0].greekTradeCount).toBe(0);
    expect(rows[0].callIv25).toBeNull();
    expect(rows[0].putIv25).toBeNull();
  });

  it('takes putIv25/callIv25 only from trades whose |delta| falls in [0.15, 0.35]', () => {
    // spot 42000, sigma 0.6, tau ~0.5 (see deribit.test.ts for the same expiry):
    // call strike 60000 -> delta ~0.264 (in band); ATM call 42000 -> delta ~0.584 (out of band);
    // put strike 32000 -> delta ~ -0.197 (|delta| in band).
    const spot = 42000;
    const expiryMs = Date.UTC(2024, 6, 1, 8, 0, 0);
    const ts = HOUR + 5 * 60 * 1000;
    const tau = yearsToExpiry(expiryMs, ts);

    const inBandCallDelta = blackScholesDelta(spot, 60000, tau, 0.6, true);
    const outOfBandCallDelta = blackScholesDelta(spot, 42000, tau, 0.6, true);
    const inBandPutDelta = blackScholesDelta(spot, 32000, tau, 0.6, false);
    expect(Math.abs(inBandCallDelta)).toBeGreaterThanOrEqual(0.15);
    expect(Math.abs(inBandCallDelta)).toBeLessThanOrEqual(0.35);
    expect(Math.abs(outOfBandCallDelta)).toBeGreaterThan(0.35);
    expect(Math.abs(inBandPutDelta)).toBeGreaterThanOrEqual(0.15);
    expect(Math.abs(inBandPutDelta)).toBeLessThanOrEqual(0.35);

    const rows = aggregateOptionTrades([
      trade({ tradeId: 'call-in-band', instrumentName: 'BTC-1JUL24-60000-C', timestamp: ts, iv: 60, amount: 1, indexPrice: spot }),
      trade({ tradeId: 'call-out-of-band', instrumentName: 'BTC-1JUL24-42000-C', timestamp: ts, iv: 80, amount: 1, indexPrice: spot }),
      trade({ tradeId: 'put-in-band', instrumentName: 'BTC-1JUL24-32000-P', timestamp: ts, iv: 55, amount: 1, indexPrice: spot }),
    ]);

    expect(rows[0].callIv25).toBeCloseTo(60, 8);
    expect(rows[0].putIv25).toBeCloseTo(55, 8);
  });

  it('keeps a trade without usable greeks in tradeCount and notional', () => {
    const rows = aggregateOptionTrades([
      trade({ instrumentName: 'BTC-1JUL24-42000-C', direction: 'buy', amount: 2, indexPrice: 40000, iv: null }),
    ]);

    expect(rows[0].tradeCount).toBe(1);
    expect(rows[0].greekTradeCount).toBe(0);
    expect(rows[0].callBuyNotional).toBe(80000);
    expect(rows[0].netDelta).toBe(0);
    expect(rows[0].netDollarGamma).toBe(0);
    expect(rows[0].vwIv).toBeNull();
    expect(rows[0].callIv25).toBeNull();
    expect(rows[0].putIv25).toBeNull();
  });
});

describe('flowUpserts', () => {
  const hour: OptionsFlowHour = {
    timestamp: HOUR,
    callBuyNotional: 100,
    callSellNotional: 50,
    putBuyNotional: 0,
    putSellNotional: 25,
    netDelta: 1.5,
    netDollarGamma: -2.25,
    tradeCount: 4,
    greekTradeCount: 3,
    vwIv: 65.5,
    putIv25: null,
    callIv25: 70,
  };

  it('keys by currency and timestamp and sets the flow fields, never a dvol field', () => {
    const [op] = flowUpserts('BTC', [hour]);

    expect(op.filter).toEqual({ currency: 'BTC', timestamp: HOUR });
    expect(op.set).toEqual({
      callBuyNotional: 100,
      callSellNotional: 50,
      putBuyNotional: 0, // 0 is finite, so it stays -- a real zero notional is not a missing reading
      putSellNotional: 25,
      netDelta: 1.5,
      netDollarGamma: -2.25,
      tradeCount: 4,
      greekTradeCount: 3,
      vwIv: 65.5,
      callIv25: 70,
    });
    expect(op.set).not.toHaveProperty('putIv25'); // putIv25 was null, so it is dropped
    expect(op.set).not.toHaveProperty('dvolOpen');
    expect(op.set).not.toHaveProperty('dvolClose');
  });

  it('keeps a finite 0 rather than dropping it', () => {
    const [op] = flowUpserts('BTC', [{ ...hour, putBuyNotional: 0 }]);
    expect(op.set).toHaveProperty('putBuyNotional', 0);
  });
});

describe('dvolUpserts', () => {
  it('sets exactly the four dvol fields for a complete row', () => {
    const [op] = dvolUpserts('BTC', [{ timestamp: HOUR, open: 60, high: 65, low: 58, close: 62 }]);

    expect(op.filter).toEqual({ currency: 'BTC', timestamp: HOUR });
    expect(op.set).toEqual({ dvolOpen: 60, dvolHigh: 65, dvolLow: 58, dvolClose: 62 });
  });

  it('drops a non-finite field instead of storing it as zero', () => {
    const [op] = dvolUpserts('BTC', [{ timestamp: HOUR, open: 60, high: 65, low: 58, close: NaN }]);

    expect(op.set).toEqual({ dvolOpen: 60, dvolHigh: 65, dvolLow: 58 });
    expect(op.set).not.toHaveProperty('dvolClose');
  });

  it('skips a row whose timestamp is not finite', () => {
    const ops = dvolUpserts('BTC', [
      { timestamp: NaN, open: 60, high: 65, low: 58, close: 62 },
      { timestamp: HOUR, open: 60, high: 65, low: 58, close: 62 },
    ]);

    expect(ops).toHaveLength(1);
    expect(ops[0].filter).toEqual({ currency: 'BTC', timestamp: HOUR });
  });
});

// Sanity: OPTIONS_SLOT_MS is one hour, since every timestamp above relies on it.
describe('OPTIONS_SLOT_MS', () => {
  it('is one hour in milliseconds', () => {
    expect(OPTIONS_SLOT_MS).toBe(60 * 60 * 1000);
  });
});
