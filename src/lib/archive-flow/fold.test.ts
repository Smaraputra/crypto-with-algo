import { describe, it, expect } from 'vitest';
import { LARGE_TRADE_MIN_USDT, SMALL_TRADE_MAX_USDT, BUCKET_MS, sizeClassOf } from '@/lib/market-recorder/trade-flow';
import { FlowFolder, type FlowBucket } from './fold';
import type { AggTrade } from './agg-trades';

const T0 = 1_700_000_100_000 - (1_700_000_100_000 % BUCKET_MS); // a bucket start

function trade(over: Partial<AggTrade> & { offset?: number }): AggTrade {
  const { offset, ...rest } = over;
  return {
    price: 100,
    quantity: 1,
    firstTradeId: 1,
    lastTradeId: 1,
    transactTime: T0 + (offset ?? 0),
    isBuyerMaker: false,
    ...rest,
  };
}

function foldAll(trades: AggTrade[]): { buckets: FlowBucket[]; folder: FlowFolder } {
  const folder = new FlowFolder();
  const buckets: FlowBucket[] = [];
  for (const t of trades) buckets.push(...folder.add(t));
  buckets.push(...folder.flush());
  return { buckets, folder };
}

describe('FlowFolder', () => {
  it('maps is_buyer_maker true to taker sell and false to taker buy', () => {
    const { buckets } = foldAll([
      trade({ price: 10, quantity: 2, isBuyerMaker: false }),
      trade({ price: 10, quantity: 3, isBuyerMaker: true }),
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ bucketStart: T0, buyBase: 2, sellBase: 3, buyQuote: 20, sellQuote: 30, aggTrades: 2 });
  });

  it('sums fills as last - first + 1', () => {
    const { buckets } = foldAll([
      trade({ firstTradeId: 10, lastTradeId: 14 }),
      trade({ firstTradeId: 15, lastTradeId: 15 }),
    ]);
    expect(buckets[0].trades).toBe(6);
  });

  it('classes size at exactly 10,000 and 100,000 USDT like sizeClassOf', () => {
    const cases: Array<[number, 'Small' | 'Medium' | 'Large']> = [
      [SMALL_TRADE_MAX_USDT - 0.01, 'Small'],
      [SMALL_TRADE_MAX_USDT, 'Medium'],
      [LARGE_TRADE_MIN_USDT - 0.01, 'Medium'],
      [LARGE_TRADE_MIN_USDT, 'Large'],
    ];
    for (const [quote, expected] of cases) {
      expect(sizeClassOf(quote)).toBe(expected);
      const { buckets } = foldAll([trade({ price: quote, quantity: 1 })]);
      const b = buckets[0] as unknown as Record<string, number>;
      for (const cls of ['Small', 'Medium', 'Large']) {
        expect(b[`buyQuote${cls}`]).toBe(cls === expected ? quote : 0);
        expect(b[`sellQuote${cls}`]).toBe(0);
      }
    }
  });

  it('puts sell trades into the sell size fields', () => {
    const { buckets } = foldAll([trade({ price: 50_000, isBuyerMaker: true })]);
    expect(buckets[0]).toMatchObject({ sellQuoteMedium: 50_000, buyQuoteMedium: 0, sellQuote: 50_000 });
  });

  it('counts the first 10 seconds as [0, 10000) ms', () => {
    const { buckets } = foldAll([
      trade({ offset: 0, price: 1 }),
      trade({ offset: 9_999, price: 2 }),
      trade({ offset: 10_000, price: 4 }),
      trade({ offset: 9_999, price: 8, isBuyerMaker: true }),
      trade({ offset: 10_000, price: 16, isBuyerMaker: true }),
    ]);
    expect(buckets[0].buyQuoteOpen10s).toBe(3);
    expect(buckets[0].sellQuoteOpen10s).toBe(8);
    expect(buckets[0].buyQuote).toBe(7);
    expect(buckets[0].sellQuote).toBe(24);
  });

  it('splits buckets at 299,999 / 300,000 ms and emits in time order', () => {
    const folder = new FlowFolder();
    expect(folder.add(trade({ offset: 299_999, price: 1 }))).toEqual([]);
    const done = folder.add(trade({ offset: 300_000, price: 2 }));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ bucketStart: T0, buyQuote: 1 });
    const rest = folder.flush();
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ bucketStart: T0 + BUCKET_MS, buyQuote: 2, buyQuoteOpen10s: 2 });
    expect(folder.flush()).toEqual([]);
  });

  it('emits a skipped (empty) bucket as no bucket, not a zero bucket', () => {
    const { buckets } = foldAll([trade({}), trade({ offset: 2 * BUCKET_MS })]);
    expect(buckets.map((b) => b.bucketStart)).toEqual([T0, T0 + 2 * BUCKET_MS]);
  });

  it('keeps a slightly late trade in the open bucket and counts a backward jump', () => {
    const folder = new FlowFolder();
    folder.add(trade({ offset: 100_000, price: 1 }));
    folder.add(trade({ offset: 99_000, price: 2 }));
    expect(folder.outOfOrder).toBe(0);
    const emitted = folder.add(trade({ offset: BUCKET_MS + 5 }));
    expect(emitted[0].buyQuote).toBe(3);
    // Now the open bucket is T0+BUCKET_MS, and a trade from T0 is beyond it.
    const late = folder.add(trade({ offset: 200_000, price: 5 }));
    expect(late).toEqual([]);
    expect(folder.outOfOrder).toBe(1);
    const final = folder.flush();
    expect(final).toHaveLength(1);
    expect(final[0].buyQuote).toBe(100); // only the BUCKET_MS+5 trade (price 100); the late row was counted, not folded
  });
});
