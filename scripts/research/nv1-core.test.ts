import { describe, it, expect } from 'vitest';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';
import {
  CoinSeries,
  NV1_SEGMENTS,
  TradeOptions,
  buildTrades,
  drawFraction,
  firstEligible,
  maxStandardised,
  meanNet,
  nullMoments,
  nullN,
  quantile7,
  rotateWithinSpans,
  sumNetTrades,
} from './nv1-core';

describe('NV1_SEGMENTS', () => {
  it('starts A1 at 2017-08-17 and segments are contiguous', () => {
    expect(NV1_SEGMENTS.A1.start).toBe(Date.UTC(2017, 7, 17));
    expect(NV1_SEGMENTS.A1.end).toBe(NV1_SEGMENTS.A2.start);
    expect(NV1_SEGMENTS.A2.end).toBe(NV1_SEGMENTS.B.start);
    expect(NV1_SEGMENTS.B.end).toBe(NV1_SEGMENTS.C.start);
    expect(NV1_SEGMENTS.C.end).toBe(Date.UTC(2026, 6, 1));
  });
});

describe('firstEligible', () => {
  it('is 2017-08-17 plus 30 days for BTCUSDT', () => {
    const expected = Date.UTC(2017, 7, 17) + 30 * 86_400_000;
    expect(firstEligible('BTCUSDT')).toBe(expected);
  });

  it('throws for an unknown symbol', () => {
    expect(() => firstEligible('UNKNOWN_COIN')).toThrow(/Unknown symbol/);
  });
});

describe('buildTrades', () => {
  const stepMs = 3_600_000;
  const hold = 3;
  const costPct = 0.16;
  const eligibleStart = firstEligible('BTCUSDT');
  const baseT = eligibleStart + 10 * 86_400_000;

  // 13 bars: indices 0..12
  // sides at 0..11: [0, 1, 1, 1, 1, 1, 0, -1, -1, -1, -1, 0], and bar 12 with side 0
  const side = [0, 1, 1, 1, 1, 1, 0, -1, -1, -1, -1, 0, 0];
  const close = [100, 100, 102, 105, 110, 112, 115, 120, 118, 115, 108, 105, 102];
  const t = Array.from({ length: 13 }, (_, i) => baseT + i * stepMs);

  const series: CoinSeries = {
    symbol: 'BTCUSDT',
    t,
    close,
    side,
  };

  const baseOpts: TradeOptions = {
    k: 0,
    hold,
    stepMs,
    costPct,
    from: 0,
    to: Number.POSITIVE_INFINITY,
  };

  it('k = 0 opens at index 1, closes at 4, next open allowed at 4, and short opens at 7 and closes at 10', () => {
    const trades = buildTrades(series, { ...baseOpts, k: 0 });

    expect(trades).toHaveLength(3);

    // Trade 1: opens at 1, closes at 4
    expect(trades[0].openT).toBe(t[1]);
    expect(trades[0].closeT).toBe(t[4]);
    expect(trades[0].d).toBe(1);
    const expectedGross1 = 1 * (close[4] / close[1] - 1) * 100;
    expect(trades[0].grossPct).toBeCloseTo(expectedGross1, 6);
    expect(trades[0].netPct).toBeCloseTo(expectedGross1 - costPct, 6);

    // Trade 2: opens at 4, closes at 7
    expect(trades[1].openT).toBe(t[4]);
    expect(trades[1].closeT).toBe(t[7]);
    expect(trades[1].d).toBe(1);
    const expectedGross2 = 1 * (close[7] / close[4] - 1) * 100;
    expect(trades[1].grossPct).toBeCloseTo(expectedGross2, 6);
    expect(trades[1].netPct).toBeCloseTo(expectedGross2 - costPct, 6);

    // Trade 3: opens at 7, closes at 10
    expect(trades[2].openT).toBe(t[7]);
    expect(trades[2].closeT).toBe(t[10]);
    expect(trades[2].d).toBe(-1);
    const expectedGross3 = -1 * (close[10] / close[7] - 1) * 100;
    expect(trades[2].grossPct).toBeCloseTo(expectedGross3, 6);
    expect(trades[2].netPct).toBeCloseTo(expectedGross3 - costPct, 6);
  });

  it('k = 2 opens the long only at index 3 (sides 1..3 all 1) and the short at 9 (7..9)', () => {
    const trades = buildTrades(series, { ...baseOpts, k: 2 });

    expect(trades).toHaveLength(2);

    // Long at 3
    expect(trades[0].openT).toBe(t[3]);
    expect(trades[0].closeT).toBe(t[6]);
    expect(trades[0].d).toBe(1);
    const expectedGrossLong = 1 * (close[6] / close[3] - 1) * 100;
    expect(trades[0].grossPct).toBeCloseTo(expectedGrossLong, 6);
    expect(trades[0].netPct).toBeCloseTo(expectedGrossLong - costPct, 6);

    // Short at 9
    expect(trades[1].openT).toBe(t[9]);
    expect(trades[1].closeT).toBe(t[12]);
    expect(trades[1].d).toBe(-1);
    const expectedGrossShort = -1 * (close[12] / close[9] - 1) * 100;
    expect(trades[1].grossPct).toBeCloseTo(expectedGrossShort, 6);
    expect(trades[1].netPct).toBeCloseTo(expectedGrossShort - costPct, 6);
  });

  it('a gap (one missing timestamp) inside the hold drops that trade and the coin stays flat', () => {
    const gapT = [...t];
    gapT[3] = gapT[3] + stepMs;
    gapT[4] = gapT[4] + stepMs;

    const gapSeries: CoinSeries = {
      ...series,
      t: gapT,
    };

    const trades = buildTrades(gapSeries, { ...baseOpts, k: 0 });
    expect(trades.find((tr) => tr.openT === gapT[1])).toBeUndefined();
  });

  it('a gap inside the k window prevents the open', () => {
    const gapT = [...t];
    gapT[2] = gapT[2] + stepMs;

    const gapSeries: CoinSeries = {
      ...series,
      t: gapT,
    };

    const trades = buildTrades(gapSeries, { ...baseOpts, k: 2 });
    expect(trades.find((tr) => tr.openT === gapT[3])).toBeUndefined();
  });

  it('from / to filtering keeps only trades fully inside, while an earlier trade still blocks overlapping opens', () => {
    const trades = buildTrades(series, {
      ...baseOpts,
      k: 0,
      from: t[4],
      to: t[10],
    });

    expect(trades).toHaveLength(1);
    expect(trades[0].openT).toBe(t[4]);
    expect(trades[0].closeT).toBe(t[7]);
  });

  it('a bar before firstEligible never opens', () => {
    const earlyT = Array.from({ length: 13 }, (_, i) => eligibleStart - 5 * 86_400_000 + i * stepMs);
    const earlySeries: CoinSeries = {
      ...series,
      t: earlyT,
    };

    const trades = buildTrades(earlySeries, { ...baseOpts, k: 0 });
    for (const trade of trades) {
      expect(trade.openT).toBeGreaterThanOrEqual(eligibleStart);
    }
  });
});

describe('rotateWithinSpans', () => {
  it('two coins of different lengths (5 and 8 bars) with u = 0.4 rotate by Math.round(0.4 * 5) = 2 and Math.round(0.4 * 8) = 3 respectively (hand-checked vectors), wraps 2 and 3, and t and close untouched', () => {
    const coin1: CoinSeries = {
      symbol: 'BTCUSDT',
      t: [1000, 2000, 3000, 4000, 5000],
      close: [10, 20, 30, 40, 50],
      side: [1, 2, 3, 4, 5],
    };
    const coin2: CoinSeries = {
      symbol: 'ETHUSDT',
      t: [100, 200, 300, 400, 500, 600, 700, 800],
      close: [1, 2, 3, 4, 5, 6, 7, 8],
      side: [10, 20, 30, 40, 50, 60, 70, 80],
    };

    const res = rotateWithinSpans([coin1, coin2], 0.4);

    expect(res.wrap).toEqual([2, 3]);
    expect(res.coins[0].side).toEqual([4, 5, 1, 2, 3]);
    expect(res.coins[0].t).toBe(coin1.t);
    expect(res.coins[0].close).toBe(coin1.close);

    expect(res.coins[1].side).toEqual([60, 70, 80, 10, 20, 30, 40, 50]);
    expect(res.coins[1].t).toBe(coin2.t);
    expect(res.coins[1].close).toBe(coin2.close);
  });

  it('each coin count of +1, -1 and 0 is unchanged by rotation (side share preserved), on a random series', () => {
    const rand = createSeededRandom(42);
    const length = 300;
    const side: number[] = new Array(length);
    for (let i = 0; i < length; i++) {
      const r = rand();
      side[i] = r < 0.3 ? -1 : r < 0.6 ? 1 : 0;
    }
    const coin: CoinSeries = {
      symbol: 'BTCUSDT',
      t: Array.from({ length }, (_, i) => i * 1000),
      close: Array.from({ length }, () => 100),
      side,
    };

    const countOf = (arr: number[], val: number) => arr.filter((x) => x === val).length;
    const origCounts = {
      pos: countOf(side, 1),
      neg: countOf(side, -1),
      zero: countOf(side, 0),
    };

    const res = rotateWithinSpans([coin], 0.37);
    const rotSide = res.coins[0].side;
    const rotCounts = {
      pos: countOf(rotSide, 1),
      neg: countOf(rotSide, -1),
      zero: countOf(rotSide, 0),
    };

    expect(rotCounts).toEqual(origCounts);
  });
});

describe('drawFraction', () => {
  it('stays inside [m, 1 - m] over 1,000 seeded draws and throws when minShiftBars is at least half the shortest coin', () => {
    const coinShort: CoinSeries = {
      symbol: 'BTCUSDT',
      t: Array.from({ length: 20 }, (_, i) => i),
      close: Array.from({ length: 20 }, () => 100),
      side: Array.from({ length: 20 }, () => 0),
    };
    const coinLong: CoinSeries = {
      symbol: 'ETHUSDT',
      t: Array.from({ length: 50 }, (_, i) => i),
      close: Array.from({ length: 50 }, () => 100),
      side: Array.from({ length: 50 }, () => 0),
    };

    const coins = [coinShort, coinLong];
    const minShiftBars = 4;
    const m = minShiftBars / 20;
    const low = m;
    const high = 1 - m;

    const rand = createSeededRandom(1234);
    let minObs = Number.POSITIVE_INFINITY;
    let maxObs = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < 1000; i++) {
      const u = drawFraction(coins, minShiftBars, rand);
      expect(u).toBeGreaterThanOrEqual(low);
      expect(u).toBeLessThanOrEqual(high);
      if (u < minObs) minObs = u;
      if (u > maxObs) maxObs = u;
    }

    expect(minObs).toBeLessThan(low + 0.05);
    expect(maxObs).toBeGreaterThan(high - 0.05);

    expect(() => drawFraction(coins, 10, rand)).toThrow(RangeError);
    expect(() => drawFraction(coins, 11, rand)).toThrow(RangeError);
  });
});

describe('sumNetTrades', () => {
  it('equals buildTrades (sum of netPct and count) on several random series, k in 0..3, with and without a blocked index', () => {
    const seeds = [101, 202, 303, 404];
    const stepMs = 3_600_000;
    const eligibleStart = firstEligible('BTCUSDT');
    const baseT = eligibleStart + 10 * 86_400_000;
    const length = 400;

    for (const seed of seeds) {
      const rand = createSeededRandom(seed);
      const t = Array.from({ length }, (_, i) => baseT + i * stepMs);
      const close: number[] = new Array(length);
      close[0] = 100;
      for (let i = 1; i < length; i++) {
        close[i] = close[i - 1] * (1 + (rand() - 0.5) * 0.02);
      }
      const side: number[] = new Array(length);
      for (let i = 0; i < length; i++) {
        const r = rand();
        side[i] = r < 0.35 ? -1 : r < 0.7 ? 1 : 0;
      }

      const series: CoinSeries = { symbol: 'BTCUSDT', t, close, side };
      const baseOpts: Omit<TradeOptions, 'k' | 'blocked'> = {
        hold: 4,
        stepMs,
        costPct: 0.1,
        from: 0,
        to: Number.POSITIVE_INFINITY,
      };

      for (const k of [0, 1, 2, 3]) {
        // Without blocked index
        const tradesWithout = buildTrades(series, { ...baseOpts, k });
        const resWithout = sumNetTrades(series, { ...baseOpts, k });
        expect(resWithout.count).toBe(tradesWithout.length);
        const expectedSumWithout = tradesWithout.reduce((acc, tr) => acc + tr.netPct, 0);
        if (tradesWithout.length === 0) {
          expect(resWithout.sum).toBe(0);
        } else {
          expect(resWithout.sum).toBeCloseTo(expectedSumWithout, 9);
        }

        // With blocked index
        const wrapIndex = Math.floor(rand() * length);
        const blockedFn = (idx: number) => idx === wrapIndex;
        const tradesWith = buildTrades(series, { ...baseOpts, k, blocked: blockedFn });
        const resWith = sumNetTrades(series, { ...baseOpts, k, blocked: blockedFn });
        expect(resWith.count).toBe(tradesWith.length);
        const expectedSumWith = tradesWith.reduce((acc, tr) => acc + tr.netPct, 0);
        if (tradesWith.length === 0) {
          expect(resWith.sum).toBe(0);
        } else {
          expect(resWith.sum).toBeCloseTo(expectedSumWith, 9);
        }
      }
    }
  });

  it('a trade whose confirmation window contains the wrap index is not taken; one that ends just before it is', () => {
    const stepMs = 3_600_000;
    const eligibleStart = firstEligible('BTCUSDT');
    const baseT = eligibleStart + 10 * 86_400_000;
    const length = 15;
    const t = Array.from({ length }, (_, i) => baseT + i * stepMs);
    const close = Array.from({ length }, () => 100);
    // Trade 1: confirmation at indices 2..4, closes at 6 (ends just before 7).
    // Trade 2: confirmation at indices 7..9, closes at 11.
    const side = [0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0];
    const series: CoinSeries = { symbol: 'BTCUSDT', t, close, side };

    const baseOpts = {
      hold: 2,
      stepMs,
      costPct: 0.1,
      from: 0,
      to: Number.POSITIVE_INFINITY,
    };

    // Case 1: wrap index is at 3.
    // Trade 1's confirmation window is 2..4 (contains wrap 3) -> Trade 1 is NOT taken.
    // Trade 2's window is 7..11 -> Trade 2 IS taken.
    const tradesWrap3 = buildTrades(series, {
      ...baseOpts,
      k: 2,
      blocked: (idx) => idx === 3,
    });
    const sumWrap3 = sumNetTrades(series, {
      ...baseOpts,
      k: 2,
      blocked: (idx) => idx === 3,
    });
    expect(tradesWrap3).toHaveLength(1);
    expect(tradesWrap3[0].openT).toBe(t[9]);
    expect(sumWrap3.count).toBe(1);

    // Case 2: wrap index is at 7.
    // Trade 1 ends at index 6 (just before wrap index 7) -> Trade 1 IS taken.
    // Trade 2's confirmation window is 7..9 (contains wrap 7) -> Trade 2 is NOT taken.
    const tradesWrap7 = buildTrades(series, {
      ...baseOpts,
      k: 2,
      blocked: (idx) => idx === 7,
    });
    const sumWrap7 = sumNetTrades(series, {
      ...baseOpts,
      k: 2,
      blocked: (idx) => idx === 7,
    });
    expect(tradesWrap7).toHaveLength(1);
    expect(tradesWrap7[0].openT).toBe(t[4]);
    expect(sumWrap7.count).toBe(1);
  });
});

describe('nullN', () => {
  it('is deterministic for a fixed seed and has shape draws x ks', () => {
    const stepMs = 3_600_000;
    const baseT = firstEligible('BTCUSDT') + 86_400_000;
    const length = 100;
    const t = Array.from({ length }, (_, i) => baseT + i * stepMs);
    const coin: CoinSeries = {
      symbol: 'BTCUSDT',
      t,
      close: Array.from({ length }, () => 100),
      side: Array.from({ length }, (_, i) => (i % 2 === 0 ? 1 : -1)),
    };

    const base = {
      hold: 3,
      stepMs,
      costPct: 0.1,
      from: 0,
      to: Number.POSITIVE_INFINITY,
    };

    const nulls1 = nullN([coin], [0, 1], base, 10, 5, 123);
    const nulls2 = nullN([coin], [0, 1], base, 10, 5, 123);

    expect(nulls1).toEqual(nulls2);
    expect(nulls1).toHaveLength(10);
    for (const row of nulls1) {
      expect(row).toHaveLength(2);
    }
  });

  it('mean of null N for k = 0 is within 3 standard errors of observed meanNet when sides are independent of returns', () => {
    const seed = 20261018;
    const rand = createSeededRandom(seed);
    const length = 600;
    const stepMs = 3_600_000;
    const baseT = firstEligible('BTCUSDT') + 86_400_000;

    const t = Array.from({ length }, (_, i) => baseT + i * stepMs);
    const close: number[] = new Array(length);
    close[0] = 100;
    for (let i = 1; i < length; i++) {
      const ret = (rand() - 0.5) * 0.02;
      close[i] = close[i - 1] * (1 + ret);
    }

    const side: number[] = new Array(length);
    for (let i = 0; i < length; i++) {
      const r = rand();
      side[i] = r < 0.35 ? -1 : r < 0.7 ? 1 : 0;
    }

    const coin: CoinSeries = {
      symbol: 'BTCUSDT',
      t,
      close,
      side,
    };

    const base = {
      hold: 4,
      stepMs,
      costPct: 0.05,
      from: 0,
      to: Number.POSITIVE_INFINITY,
    };

    const unshiftedTrades = buildTrades(coin, { ...base, k: 0 });
    const observedMean = meanNet(unshiftedTrades);
    expect(Number.isNaN(observedMean)).toBe(false);

    const draws = 50;
    const minShiftBars = 30;
    const nulls = nullN([coin], [0], base, draws, minShiftBars, 7777);
    const moments = nullMoments(nulls);

    const nullMean = moments.mean[0];
    const nullSd = moments.sd[0];

    expect(Math.abs(nullMean - observedMean)).toBeLessThanOrEqual(3 * nullSd);
  });

  it('speed: nullN with 10 coins of 20,000 bars, 4 values of k and 50 draws finishes in under 10 seconds', () => {
    const numCoins = 10;
    const numBars = 20_000;
    const ks = [0, 1, 2, 3];
    const draws = 50;
    const minShiftBars = 100;
    const stepMs = 3_600_000;
    const eligibleStart = firstEligible('BTCUSDT');
    const baseT = eligibleStart + 10 * 86_400_000;

    const coins: CoinSeries[] = [];
    for (let c = 0; c < numCoins; c++) {
      const t = Array.from({ length: numBars }, (_, i) => baseT + i * stepMs);
      const close = Array.from({ length: numBars }, () => 100);
      const side = Array.from({ length: numBars }, (_, i) => (i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0));
      coins.push({
        symbol: 'BTCUSDT',
        t,
        close,
        side,
      });
    }

    const base = {
      hold: 4,
      stepMs,
      costPct: 0.1,
      from: 0,
      to: Number.POSITIVE_INFINITY,
    };

    const start = performance.now();
    const result = nullN(coins, ks, base, draws, minShiftBars, 9999);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(10_000);
    expect(result).toHaveLength(draws);
    for (const row of result) {
      expect(row).toHaveLength(ks.length);
    }
  });
});

describe('maxStandardised and quantile7', () => {
  it('maxStandardised skips non-assessable k and returns NaN when none is assessable', () => {
    const moments = {
      mean: [10, 20, 30],
      sd: [2, 4, 5],
    };
    const n = [12, 28, 45];

    expect(maxStandardised(n, moments, [true, true, false])).toBe(2);
    expect(maxStandardised(n, moments, [false, false, false])).toBeNaN();
  });

  it('quantile7([1, 2, 3, 4], 0.25) is 1.75', () => {
    expect(quantile7([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile7([4, 3, 2, 1], 0.25)).toBe(1.75);
    expect(quantile7([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile7([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(quantile7([], 0.5)).toBeNaN();
  });
});
