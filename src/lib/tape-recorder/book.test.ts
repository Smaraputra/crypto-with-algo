import { describe, expect, it } from 'vitest';

import { OrderBook } from './book';

function handBook(): OrderBook {
  const book = new OrderBook();
  book.applySnapshot(
    [
      [101, 10],
      [102, 10],
      [103, 10],
    ],
    [
      [100, 10],
      [99, 10],
      [98, 10],
    ]
  );
  return book;
}

describe('OrderBook', () => {
  it('reports the best bid and ask whatever order the snapshot arrives in', () => {
    const book = new OrderBook();
    book.applySnapshot(
      [
        [103, 1],
        [101, 2],
        [102, 3],
      ],
      [
        [98, 1],
        [100, 2],
        [99, 3],
      ]
    );
    expect(book.bestBid()).toEqual([100, 2]);
    expect(book.bestAsk()).toEqual([101, 2]);
    expect(book.isCrossed()).toBe(false);
  });

  it('applies deltas: update, insert and removal at size 0', () => {
    const book = handBook();
    book.applyDelta(
      [
        [101, 0],
        [101.5, 4],
      ],
      [[100, 7]]
    );
    expect(book.bestAsk()).toEqual([101.5, 4]);
    expect(book.bestBid()).toEqual([100, 7]);
    book.applyDelta([], [[100, 0], [100, 0]]);
    expect(book.bestBid()).toEqual([99, 10]);
    expect(book.askCount).toBe(3);
    expect(book.bidCount).toBe(2);
  });

  it('ignores removal of a level that is not in the book', () => {
    const book = handBook();
    book.applyDelta([[150, 0]], [[50, 0]]);
    expect(book.askCount).toBe(3);
    expect(book.bidCount).toBe(3);
  });

  it('replaces the whole book on a new snapshot', () => {
    const book = handBook();
    book.applySnapshot([[201, 1]], [[200, 1]]);
    expect(book.bestBid()).toEqual([200, 1]);
    expect(book.askCount).toBe(1);
  });

  it('detects a crossed book', () => {
    const book = handBook();
    book.applyDelta([[99.5, 1]], []);
    expect(book.isCrossed()).toBe(true);
  });

  describe('roundTripBps', () => {
    it('is the spread over mid when the size fits the top level', () => {
      // mid 100.5, buy at 101, sell at 100.
      expect(handBook().roundTripBps(500)).toBeCloseTo((1 / 100.5) * 1e4, 9);
    });

    it('walks levels for a size past the top level', () => {
      const book = handBook();
      // Buy 1,500 USD: 1,010 at 101 (10 base), then 490 at 102 (4.8039 base).
      const buyBase = 10 + 490 / 102;
      const buyAvg = 1500 / buyBase;
      // Sell 1,500 USD: 1,000 at 100 (10 base), then 500 at 99 (5.0505 base).
      const sellBase = 10 + 500 / 99;
      const sellAvg = 1500 / sellBase;
      expect(book.roundTripBps(1500)).toBeCloseTo(((buyAvg - sellAvg) / 100.5) * 1e4, 9);
    });

    it('is null when the visible book is too thin on either side', () => {
      const book = handBook();
      // Total visible: asks 10 x (101 + 102 + 103) = 3,060 USD, bids 10 x (100 + 99 + 98) = 2,970 USD.
      expect(book.roundTripBps(2_900)).not.toBeNull();
      expect(book.roundTripBps(3_000)).toBeNull();
      expect(book.roundTripBps(1e6)).toBeNull();
    });

    it('is null for an empty side, a non-positive size or an empty book', () => {
      const oneSided = new OrderBook();
      oneSided.applySnapshot([[101, 1]], []);
      expect(oneSided.roundTripBps(10)).toBeNull();
      expect(handBook().roundTripBps(0)).toBeNull();
      expect(new OrderBook().roundTripBps(10)).toBeNull();
    });

    it('works on a 5-level Binance-style book and goes null when 5 levels are not enough', () => {
      const book = new OrderBook();
      book.applySnapshot(
        [
          [73864.0, 3.637],
          [73864.1, 0.122],
          [73864.2, 0.01],
          [73864.3, 0.028],
          [73864.4, 0.111],
        ],
        [
          [73863.9, 0.445],
          [73863.8, 0.001],
          [73863.7, 0.001],
          [73863.6, 0.002],
          [73863.5, 0.002],
        ]
      );
      const rt1000 = book.roundTripBps(1000);
      expect(rt1000).toBeCloseTo((0.1 / 73863.95) * 1e4, 6);
      // The five bid levels hold about 33,000 USD; 100,000 USD cannot be sold into them.
      expect(book.roundTripBps(100_000)).toBeNull();
    });
  });

  describe('summary', () => {
    it('returns the quotes and four rounded costs, and refreshes after a change', () => {
      const book = handBook();
      const first = book.summary();
      expect(first).toMatchObject({ bid: 100, ask: 101, bidSz: 10, askSz: 10 });
      expect(first.rt100).toBe(99.5025);
      expect(first.rt20000).toBeNull();
      expect(book.summary()).toBe(first);
      book.applyDelta([[100.5, 1]], []);
      expect(book.summary().ask).toBe(100.5);
    });
  });
});
