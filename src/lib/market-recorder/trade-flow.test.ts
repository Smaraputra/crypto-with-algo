import { describe, expect, it } from 'vitest';

import type { AggTrade } from './messages';
import {
  BUCKET_MS,
  COVERAGE_MARGIN_MS,
  FLUSH_GRACE_MS,
  RecentIds,
  TradeFlowAggregator,
  aggressorOf,
  bucketStartOf,
  sizeClassOf,
} from './trade-flow';

const B0 = Date.UTC(2026, 9, 8, 12, 0, 0); // a bucket boundary
const B1 = B0 + BUCKET_MS;

function trade(overrides: Partial<AggTrade> & { aggId: number }): AggTrade {
  return {
    symbol: 'BTCUSDT',
    price: 100,
    qty: 1,
    firstTradeId: overrides.aggId * 10,
    lastTradeId: overrides.aggId * 10,
    tradeTime: B0 + 1_000,
    eventTime: B0 + 1_050,
    buyerIsMaker: false,
    ...overrides,
  };
}

/** An aggregator whose symbols have been covered since long before B0. */
function coveredAggregator(symbols = ['BTCUSDT', 'ETHUSDT']) {
  const agg = new TradeFlowAggregator();
  agg.setCovered(symbols, B0 - 3_600_000);
  return agg;
}

describe('bucketStartOf', () => {
  it('floors to the UTC five-minute boundary', () => {
    expect(bucketStartOf(B0)).toBe(B0);
    expect(bucketStartOf(B0 + 1)).toBe(B0);
    expect(bucketStartOf(B1 - 1)).toBe(B0);
    expect(bucketStartOf(B1)).toBe(B1);
    expect(new Date(bucketStartOf(Date.UTC(2026, 9, 8, 12, 7, 31))).toISOString()).toBe('2026-10-08T12:05:00.000Z');
  });
});

describe('sizeClassOf', () => {
  it.each([
    [0.01, 'Small'],
    [9_999.99, 'Small'],
    [10_000, 'Medium'],
    [99_999.99, 'Medium'],
    [100_000, 'Large'],
    [5_000_000, 'Large'],
  ])('classes %d USDT as %s', (notional, expected) => {
    expect(sizeClassOf(notional)).toBe(expected);
  });
});

describe('aggressorOf', () => {
  it('reads buyer-is-maker as a taker sell, and its absence as a taker buy', () => {
    expect(aggressorOf(true)).toBe('sell');
    expect(aggressorOf(false)).toBe('buy');
  });
});

describe('RecentIds', () => {
  it('remembers ids up to its capacity, evicting the oldest first', () => {
    const recent = new RecentIds(3);
    expect(recent.add(1)).toBe(true);
    expect(recent.add(2)).toBe(true);
    expect(recent.add(1)).toBe(false);
    expect(recent.add(3)).toBe(true);
    expect(recent.add(4)).toBe(true); // evicts 1
    expect(recent.size).toBe(3);
    expect(recent.add(1)).toBe(true);
    expect(recent.add(3)).toBe(false);
  });
});

describe('TradeFlowAggregator', () => {
  it('splits volume by aggressor side and by trade notional', () => {
    const agg = coveredAggregator();
    agg.add(trade({ aggId: 1, price: 100, qty: 50, buyerIsMaker: false })); // buy 5,000: small
    agg.add(trade({ aggId: 2, price: 100, qty: 100, buyerIsMaker: false })); // buy 10,000: medium
    agg.add(trade({ aggId: 3, price: 100, qty: 1_000, buyerIsMaker: true })); // sell 100,000: large
    agg.add(trade({ aggId: 4, price: 100, qty: 999, buyerIsMaker: true })); // sell 99,900: medium

    const [bar] = agg.drainAll();

    expect(bar).toMatchObject({
      symbol: 'BTCUSDT',
      bucketStart: B0,
      aggTrades: 4,
      buyBase: 150,
      sellBase: 1_999,
      buyQuote: 15_000,
      sellQuote: 199_900,
      buyQuoteSmall: 5_000,
      buyQuoteMedium: 10_000,
      buyQuoteLarge: 0,
      sellQuoteSmall: 0,
      sellQuoteMedium: 99_900,
      sellQuoteLarge: 100_000,
    });
  });

  it('counts individual fills from the trade id range', () => {
    const agg = coveredAggregator();
    agg.add(trade({ aggId: 1, firstTradeId: 100, lastTradeId: 104 }));
    agg.add(trade({ aggId: 2, firstTradeId: 105, lastTradeId: 105 }));

    const [bar] = agg.drainAll();

    expect(bar.trades).toBe(6);
    expect(bar.aggTrades).toBe(2);
  });

  it('takes first and last price by aggregate id, not by arrival order', () => {
    const agg = coveredAggregator();
    agg.add(trade({ aggId: 20, price: 102 }));
    agg.add(trade({ aggId: 10, price: 99 }));
    agg.add(trade({ aggId: 30, price: 105 }));
    agg.add(trade({ aggId: 25, price: 97 }));

    const [bar] = agg.drainAll();

    expect(bar).toMatchObject({
      firstAggId: 10,
      firstPrice: 99,
      lastAggId: 30,
      lastPrice: 105,
      highPrice: 105,
      lowPrice: 97,
    });
  });

  it('keys bars by symbol and by trade time, not arrival time', () => {
    const agg = coveredAggregator();
    agg.add(trade({ aggId: 1, tradeTime: B0 + 10 }));
    agg.add(trade({ aggId: 2, tradeTime: B1 + 10 }));
    agg.add(trade({ aggId: 3, symbol: 'ETHUSDT', tradeTime: B0 + 20 }));

    const bars = agg.drainAll();

    expect(bars.map((b) => [b.symbol, b.bucketStart])).toEqual([
      ['BTCUSDT', B0],
      ['ETHUSDT', B0],
      ['BTCUSDT', B1],
    ]);
  });

  it('drops a repeated aggregate id, as two overlapping connections deliver', () => {
    const agg = coveredAggregator();
    expect(agg.add(trade({ aggId: 7, qty: 2 }))).toBe('added');
    expect(agg.add(trade({ aggId: 7, qty: 2 }))).toBe('duplicate');

    const [bar] = agg.drainAll();

    expect(bar.buyBase).toBe(2);
    expect(bar.aggTrades).toBe(1);
  });

  it('refuses a new bar past its cap rather than growing without bound', () => {
    const agg = new TradeFlowAggregator({ maxOpenBars: 2 });
    agg.setCovered(['A', 'B', 'C'], B0 - 60_000);
    expect(agg.add(trade({ aggId: 1, symbol: 'A' }))).toBe('added');
    expect(agg.add(trade({ aggId: 1, symbol: 'B' }))).toBe('added');
    expect(agg.add(trade({ aggId: 1, symbol: 'C' }))).toBe('overflow');
    // An existing bar still accepts trades.
    expect(agg.add(trade({ aggId: 2, symbol: 'A' }))).toBe('added');
    expect(agg.openBars).toBe(2);
  });

  describe('draining', () => {
    it('holds a bar until FLUSH_GRACE_MS after its bucket closes', () => {
      const agg = coveredAggregator();
      agg.add(trade({ aggId: 1, tradeTime: B0 + 5 }));

      expect(agg.drainClosed(B1 + FLUSH_GRACE_MS - 1)).toHaveLength(0);
      const drained = agg.drainClosed(B1 + FLUSH_GRACE_MS);
      expect(drained).toHaveLength(1);
      expect(agg.openBars).toBe(0);
    });

    it('leaves the still-open bucket in place', () => {
      const agg = coveredAggregator();
      agg.add(trade({ aggId: 1, tradeTime: B0 + 5 }));
      agg.add(trade({ aggId: 2, tradeTime: B1 + 5 }));

      const drained = agg.drainClosed(B1 + FLUSH_GRACE_MS + 10);

      expect(drained.map((b) => b.bucketStart)).toEqual([B0]);
      expect(agg.openBars).toBe(1);
    });

    it('starts a fresh bar for a trade that lands after its bucket was drained', () => {
      // The store merges the two parts; here it is enough that the late trade
      // is not lost and does not resurrect the drained totals.
      const agg = coveredAggregator();
      agg.add(trade({ aggId: 1, qty: 3 }));
      agg.drainAll();
      agg.add(trade({ aggId: 2, qty: 1 }));

      const [late] = agg.drainAll();

      expect(late).toMatchObject({ bucketStart: B0, buyBase: 1, firstAggId: 2 });
    });
  });

  describe('completeness', () => {
    it('marks a bar complete when its symbol was covered before the bucket opened', () => {
      const agg = coveredAggregator();
      agg.add(trade({ aggId: 1 }));

      expect(agg.drainAll()[0].complete).toBe(true);
    });

    it('marks the first bar after coverage begins incomplete', () => {
      const agg = new TradeFlowAggregator();
      agg.setCovered(['BTCUSDT'], B0 + 30_000);
      agg.add(trade({ aggId: 1, tradeTime: B0 + 40_000 }));
      agg.add(trade({ aggId: 2, tradeTime: B1 + 10 }));

      const [first, second] = agg.drainAll();

      expect(first.complete).toBe(false);
      expect(second.complete).toBe(true);
    });

    it('treats coverage that began inside the margin before the bucket as incomplete', () => {
      // Binance's clock may run ahead of ours: trades stamped just after B0
      // could have been sent before our connection opened.
      const agg = new TradeFlowAggregator();
      agg.setCovered(['BTCUSDT'], B0 - COVERAGE_MARGIN_MS + 1);
      agg.add(trade({ aggId: 1, tradeTime: B0 + 10_000 }));

      expect(agg.drainAll()[0].complete).toBe(false);
    });

    it('marks bars incomplete when coverage breaks before they close', () => {
      const agg = coveredAggregator();
      agg.add(trade({ aggId: 1, tradeTime: B0 + 10 })); // closes at B1
      agg.add(trade({ aggId: 2, tradeTime: B1 + 10 })); // still open
      agg.add(trade({ aggId: 3, symbol: 'ETHUSDT', tradeTime: B1 + 10 }));

      agg.breakCoverage(['BTCUSDT'], B1 + 60_000);

      const bars = agg.drainAll();
      const byKey = Object.fromEntries(bars.map((b) => [`${b.symbol}@${b.bucketStart}`, b.complete]));
      expect(byKey[`BTCUSDT@${B0}`]).toBe(true);
      expect(byKey[`BTCUSDT@${B1}`]).toBe(false);
      expect(byKey[`ETHUSDT@${B1}`]).toBe(true);
    });

    it('counts a break inside the margin after the close against the bar', () => {
      const agg = coveredAggregator();
      agg.add(trade({ aggId: 1, tradeTime: B0 + 10 }));

      agg.breakCoverage(['BTCUSDT'], B1 + COVERAGE_MARGIN_MS - 1);

      expect(agg.drainAll()[0].complete).toBe(false);
    });

    it('keeps the post-break bar incomplete after coverage resumes', () => {
      const agg = coveredAggregator();
      agg.add(trade({ aggId: 1, tradeTime: B0 + 10 }));
      agg.breakCoverage(['BTCUSDT'], B0 + 60_000);
      agg.setCovered(['BTCUSDT'], B0 + 70_000);
      agg.add(trade({ aggId: 2, tradeTime: B0 + 80_000 }));

      const [bar] = agg.drainAll();
      expect(bar.complete).toBe(false);
      expect(bar.aggTrades).toBe(2);
    });

    it('does not move the start of coverage for a symbol that is already covered', () => {
      const agg = coveredAggregator(['BTCUSDT']);
      agg.setCovered(['BTCUSDT'], B0 + 60_000); // a second connection opening during a swap
      agg.add(trade({ aggId: 1, tradeTime: B0 + 70_000 }));

      expect(agg.drainAll()[0].complete).toBe(true);
    });
  });

  it('forgets dedupe state for symbols it no longer carries', () => {
    const agg = coveredAggregator();
    agg.add(trade({ aggId: 1, symbol: 'ETHUSDT' }));
    agg.retainDedupe(['BTCUSDT']);

    // Without the state the repeat is accepted again: the memory is gone.
    expect(agg.add(trade({ aggId: 1, symbol: 'ETHUSDT' }))).toBe('added');
  });
});
