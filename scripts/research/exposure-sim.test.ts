import { describe, expect, it } from 'vitest';

import {
  BINANCE_FUTURES_MAKER_FEE,
  BINANCE_FUTURES_TAKER_FEE,
  STUDY_SLIPPAGE_BPS,
} from '@/lib/backtest/cost-model';
import { FUNDING_INTERVAL_MS, fundingCrossings, fundingPnl } from '@/lib/backtest/funding';
import {
  FACTOR_DECAY_HORIZON_BARS,
  bootstrapBlockLength,
  circularBlockShuffle,
  crossSectionalTargets,
  maxRankWeight,
  simulateExposure,
  targetExposure,
  trailingMean,
  type ExposureGrid,
  type ExposureSymbolInput,
} from './exposure-sim';

const DAY = 24 * 60 * 60 * 1000;

/** A 1d symbol with one funding reading per bar. */
function daily(z: number[], closes: number[], rates: number[], symbol = 'AAAUSDT'): ExposureSymbolInput {
  return {
    symbol,
    timestamps: closes.map((_, i) => i * DAY),
    closes,
    fundingRates: rates,
    z,
  };
}

/** Taker fee plus the 1d study slippage, the per-unit-turnover cost. */
const COST_PER_UNIT = BINANCE_FUTURES_TAKER_FEE + STUDY_SLIPPAGE_BPS['1d'] / 10000;

/** The weight a reading produces, so a test's hand-computed cost is derived
 * rather than a magic number copied out of a run. */
const W = (z: number, zScale = 1): number => targetExposure(z, zScale);

/** Five symbols on one shared four-bar grid, for the cross-sectional target
 * tests. Symbol index 3's bar-0 reading (40) is deliberately not the extreme
 * of the five (10..50), so a topBottom k=1 pick never selects it at bar 0 --
 * that is what keeps a carried-forward NaN at bar 1 dollar neutral. `nanAt`
 * overrides one symbol's reading at one bar to NaN. */
function fiveSymbolFixture(options: { nanAt?: { symbol: number; bar: number } } = {}): ExposureSymbolInput[] {
  const z = [
    [10, 15, 12, 1],
    [20, 25, 22, 2],
    [30, 35, 55, 3],
    [40, 45, 42, 4],
    [50, 5, 8, 5],
  ];
  const closes = [
    [100, 102, 101, 103],
    [100, 105, 103, 108],
    [100, 98, 99, 97],
    [100, 101, 102, 100],
    [100, 110, 108, 112],
  ];
  const rates = [0, 0, 0, 0];
  return z.map((symbolZ, index) => {
    const values = [...symbolZ];
    if (options.nanAt && options.nanAt.symbol === index) {
      values[options.nanAt.bar] = Number.NaN;
    }
    return daily(values, closes[index], rates, `SYM${index}USDT`);
  });
}

/** Grid shared by the rank-scheme describe block below: tanh by default
 * (`scheme` unset), zScale large enough to be well past saturation for the
 * fixture's readings, so every traded bar's target magnitude clears the band. */
const baseGrid: ExposureGrid = { band: 0.05, zScale: 3, smoothing: 0, gross: 1, interval: '1d' };

/** Five symbols, four bars, built for the book-level dropout test: symbol 4
 * (index 4) is the topBottom k=1 short leg at bar 0 (z=10 is the max of
 * [1,2,3,4,10]), its signal is NaN at bar 1 while the other four stay finite,
 * and at bar 2 its reading (5) is deliberately not extreme among
 * [1,9,2,8,5], so once flattened it never re-enters a leg for the rest of the
 * fixture. */
function dropoutFixture(): ExposureSymbolInput[] {
  const z = [
    [1, 5, 1, 0],
    [2, 6, 9, 0],
    [3, 7, 2, 0],
    [4, 8, 8, 0],
    [10, Number.NaN, 5, 0],
  ];
  const rates = [0, 0, 0, 0];
  return z.map((symbolZ, index) => {
    const closes = symbolZ.map((_, bar) => 100 + index * (bar + 1));
    return daily(symbolZ, closes, rates, `SYM${index}USDT`);
  });
}

/** Five symbols on a grid with as many bars as `zRows` has rows: row b, index
 * s is symbol s's reading at bar b. Every symbol's own closes are strictly
 * increasing, so every bar earns a finite forward return and none is
 * incomplete -- this fixture is for exercising the rank/band arithmetic
 * itself, not the incomplete-bar path. */
function manyRanksFixture(zRows: readonly (readonly number[])[]): ExposureSymbolInput[] {
  const bars = zRows.length;
  const rates = new Array(bars).fill(0);
  return Array.from({ length: 5 }, (_, s) => {
    const z = zRows.map((row) => row[s]);
    const closes = Array.from({ length: bars }, (_, bar) => 100 + s * (bar + 1));
    return daily(z, closes, rates, `SYM${s}USDT`);
  });
}

/** Two symbols, four bars: symbol B's close is NaN at bar 1, which makes both
 * bar 0 (its forward return) and bar 1 (its backward return) incomplete;
 * bar 2 is the only complete, traded bar. For exercising the incomplete-bar
 * push of the new per-bar series, not the rank arithmetic. */
function twoSymbolGapFixture(): ExposureSymbolInput[] {
  const a = daily([10, 20, 1, 0], [100, 102, 104, 106], [0, 0, 0, 0], 'AAAUSDT');
  const b = daily([5, 15, 2, 0], [100, Number.NaN, 105, 110], [0, 0, 0, 0], 'BBBUSDT');
  return [a, b];
}

describe('targetExposure', () => {
  it('is contrarian and saturating, never reaching full size', () => {
    expect(targetExposure(0, 1)).toBeCloseTo(0, 12);
    expect(targetExposure(1, 1)).toBeLessThan(0);
    expect(targetExposure(-1, 1)).toBeGreaterThan(0);
    // Contrarian at every magnitude.
    for (const z of [0.5, 1, 2, 5, 50]) {
      expect(Math.sign(targetExposure(z, 1))).toBe(-Math.sign(z));
    }
    // Strictly increasing magnitude in |z|, and never at full size across the
    // range the factor actually reaches. A clamped target would be flat at 1
    // from |z| = zScale upward, which is the degeneracy this replaced.
    const magnitudes = [0.5, 1, 2, 5, 8].map((z) => Math.abs(targetExposure(z, 1)));
    for (let i = 1; i < magnitudes.length; i++) {
      expect(magnitudes[i]).toBeGreaterThan(magnitudes[i - 1]);
    }
    for (const m of magnitudes) expect(m).toBeLessThan(1);
    expect(magnitudes[magnitudes.length - 1]).toBeGreaterThan(0.99);
    // Beyond |z| ~ 9 the gap to 1 is below double precision and tanh rounds to
    // exactly 1, so saturation is real there but indistinguishable from the
    // clamp this replaced. Recorded so the bound above is not mistaken for a
    // claim about every magnitude.
    expect(Math.abs(targetExposure(30, 1))).toBe(1);
    // A larger zScale compresses toward linear.
    expect(Math.abs(targetExposure(2, 3))).toBeLessThan(Math.abs(targetExposure(2, 1)));
  });

  it('is a hard clamp now only at the extremes of zScale', () => {
    // tanh saturates, so a tiny zScale is where the old clamp behaviour
    // effectively appears. Pinning it here keeps the difference visible.
    expect(targetExposure(100, 0.01)).toBeCloseTo(-1, 6);
  });

  it('is NaN, never 0, when the reading is missing', () => {
    expect(Number.isNaN(targetExposure(Number.NaN, 1))).toBe(true);
    expect(Number.isNaN(targetExposure(1, Number.NaN))).toBe(true);
    expect(Number.isNaN(targetExposure(1, 0))).toBe(true);
    expect(Number.isNaN(targetExposure(1, -1))).toBe(true);
  });
});

describe('trailingMean', () => {
  it('is NaN until the window is full, then averages the trailing window', () => {
    expect(trailingMean([1, 2, 3, 4], 2)).toEqual([
      Number.NaN,
      1.5,
      2.5,
      3.5,
    ]);
  });

  it('passes the series through when the window is 1 or less', () => {
    expect(trailingMean([1, Number.NaN, 3], 1)).toEqual([1, Number.NaN, 3]);
  });

  it('refuses to average over a gap', () => {
    // A NaN inside the window means the window is not full, so no reading.
    const out = trailingMean([1, Number.NaN, 3], 2);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(Number.isNaN(out[2])).toBe(true);
  });
});

describe('simulateExposure turnover costing', () => {
  // Hand-computed. Daily bars at 00:00, so every bar spans three funding
  // crossings, but rates are 0 here so funding is 0.
  const closes = [100, 100, 100, 100, 100];
  const rates = [0, 0, 0, 0, 0];

  it('charges |dw| * (fee + slippage) on a hand-computed path', () => {
    // Closes are flat, so the price part of every bar's return is 0 and each
    // bar's net is exactly the negative of that bar's trading cost. That
    // isolates the cost arithmetic from the return arithmetic.
    //
    // z = [-1, -1, 1, 1, 1] at zScale 1 -> target [+w, +w, -w, -w, -w] with
    // w = tanh(1). Bar 0: 0 -> +w, |dw| = w. Bar 2: +w -> -w, |dw| = 2w.
    const z = [-1, -1, 1, 1, 1];
    const w = Math.abs(W(-1));
    const result = simulateExposure([daily(z, closes, rates)], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });

    expect(result.netReturns).toHaveLength(4);
    expect(result.turnover[0]).toBeCloseTo(w, 12);
    expect(result.turnover[1]).toBeCloseTo(0, 12);
    expect(result.turnover[2]).toBeCloseTo(2 * w, 12);
    expect(result.turnover[3]).toBeCloseTo(0, 12);
    expect(result.netReturns[0]).toBeCloseTo(-w * COST_PER_UNIT, 12);
    expect(result.netReturns[1]).toBeCloseTo(0, 12);
    expect(result.netReturns[2]).toBeCloseTo(-2 * w * COST_PER_UNIT, 12);
    expect(result.netReturns[3]).toBeCloseTo(0, 12);
    expect(result.costReturns).toEqual(result.turnover.map((t) => -t * COST_PER_UNIT));
  });

  it('scales both fee and slippage under the stress multipliers', () => {
    const z = [-1, -1, 1, 1, 1];
    const result = simulateExposure(
      [daily(z, closes, rates)],
      { band: 0, zScale: 1, smoothing: 0, gross: 1, interval: '1d' },
      { feeMultiplier: 1.5, slippageMultiplier: 2 }
    );
    const w = Math.abs(W(-1));
    const expected = BINANCE_FUTURES_TAKER_FEE * 1.5 + (STUDY_SLIPPAGE_BPS['1d'] / 10000) * 2;
    expect(result.netReturns[0]).toBeCloseTo(-w * expected, 12);
  });

  it('a wider band produces strictly less turnover on the same signal', () => {
    // At zScale 10 the targets alternate between +0.8 and +0.3, so a flip is
    // a 0.5 move and the entry is a 0.8 move. A 0.6 band trades the entry and
    // then sits still; a 0.2 band follows every flip. Same column, same
    // prices, and the band is the only thing that changed.
    const z: number[] = [];
    for (let i = 0; i < 40; i++) z.push(i % 2 === 0 ? -8 : -3);
    const prices = z.map((_, i) => 100 + (i % 5));

    const run = (band: number) =>
      simulateExposure([daily(z, prices, z.map(() => 0))], {
        band,
        zScale: 10,
        smoothing: 0,
        gross: 1,
        interval: '1d',
      });

    const tight = run(0.2);
    const wide = run(0.6);
    const totalTight = tight.turnover.reduce((a, b) => a + b, 0);
    const totalWide = wide.turnover.reduce((a, b) => a + b, 0);

    // The wide band still takes its first entry, so it is not zero, but it
    // never follows a flip afterwards.
    expect(totalWide).toBeCloseTo(Math.abs(W(-8, 10)), 12);
    expect(totalTight).toBeGreaterThan(totalWide);
  });

  it('a constant signal rebalances exactly once and then never again', () => {
    const z = [-1, -1, -1, -1, -1, -1, -1, -1];
    const prices = z.map((_, i) => 100 + i);
    const result = simulateExposure([daily(z, prices, z.map(() => 0))], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });

    // One rebalance onto the target at bar 0, then the held weight already
    // equals it forever after, so turnover is paid once and never again.
    expect(result.turnover[0]).toBeCloseTo(Math.abs(W(-1)), 12);
    expect(result.turnover.slice(1).every((t) => t === 0)).toBe(true);
    expect(result.meanBarsBetweenRebalances).toBeCloseTo(result.turnover.length, 12);
  });
});

describe('simulateExposure fee profile', () => {
  // Two symbols on one shared grid (simulateExposure requires it), each
  // rebalancing onto z = -1 at bar 0 so bar 0's cost is non-zero for both.
  const closes = [100, 100, 100];
  const rates = [0, 0, 0];
  const z = [-1, -1, -1];
  const symbols = [daily(z, closes, rates, 'AAAUSDT'), daily(z, closes, rates, 'BBBUSDT')];
  const grid = { band: 0, zScale: 1, smoothing: 0, gross: 1, interval: '1d' };

  it('prices turnover per symbol from the fee profile and is unchanged under standard', () => {
    // Two symbols, identical inputs, one rebalance each at bar 0.
    const base = simulateExposure(symbols, grid);
    const standard = simulateExposure(symbols, grid, { feeProfile: 'standard' });
    expect(standard.costReturns).toEqual(base.costReturns);

    const promo = simulateExposure(
      [{ ...symbols[0], symbol: 'BTCUSDT' }, { ...symbols[1], symbol: 'SOLUSDT' }],
      grid,
      { feeProfile: 'promo-btc-eth-2026-07' }
    );
    // Both legs rebalance from 0 onto z = -1's target at bar 0, so each
    // leg's turnover is |W(-1)|. BTC prices under the promotion (0.00036
    // taker, resolved for BTCUSDT); SOL falls back to bnb (0.00045 taker).
    // Slippage comes from the grid's own interval, not hardcoded.
    const delta = Math.abs(W(-1));
    const slippage = STUDY_SLIPPAGE_BPS[grid.interval] / 10000;
    const btcCost = delta * (0.00036 + slippage);
    const solCost = delta * (0.00045 + slippage);
    expect(promo.costReturns[0]).toBeCloseTo(-(btcCost + solCost), 12);
  });
});

describe('simulateExposure funding', () => {
  const closes = [100, 100, 100];
  // The rate read at each bar is the last SETTLED rate carried forward. Bar 1
  // carries a rate, so the funding it causes lands on bar 1's own return.
  const rates = [0, 0.0001, 0];

  it('charges a long weight negatively on a positive rate, matching fundingPnl', () => {
    const z = [-1, -1, -1];
    const result = simulateExposure([daily(z, closes, rates)], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });

    // A 1d bar spans three 8h boundaries and owes all three settlements, as
    // accrueFunding charges them (review M8: this used to pin ONE settlement,
    // a two-thirds undercharge on every 1d bar).
    const w = Math.abs(W(-1));
    expect(fundingCrossings(0, DAY)).toBe(3);
    const expected = fundingPnl(w, 0.0001, 'long', 3);
    expect(expected).toBeLessThan(0);
    expect(expected).toBeCloseTo(3 * fundingPnl(w, 0.0001, 'long', 1), 15);
    expect(result.fundingReturns[1]).toBeCloseTo(expected, 12);
    expect(result.netReturns[1]).toBeCloseTo(expected, 12);
  });

  it('charges a short weight positively on a positive rate', () => {
    const z = [1, 1, 1];
    const result = simulateExposure([daily(z, closes, rates)], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });
    const expected = fundingPnl(Math.abs(W(1)), 0.0001, 'short', 3);
    expect(expected).toBeGreaterThan(0);
    expect(result.fundingReturns[1]).toBeCloseTo(expected, 12);
  });

  it('charges one settlement on a 4h bar that crosses one boundary, none on one that crosses none', () => {
    // A 4h grid starting at 00:00: the bar 00:00 -> 04:00 crosses no 8h
    // boundary, the bar 04:00 -> 08:00 crosses 08:00. The 1h and 4h recorded
    // runs are therefore untouched by the M8 fix.
    const FOUR_H = 4 * 3_600_000;
    const input = {
      symbol: 'BTCUSDT',
      timestamps: [0, FOUR_H, 2 * FOUR_H],
      closes: [100, 100, 100],
      z: [-1, -1, -1],
      fundingRates: [0.0001, 0.0001, 0.0001],
    };
    const result = simulateExposure([input], { band: 0, zScale: 1, smoothing: 0, gross: 1, interval: '4h' });
    const w = Math.abs(W(-1));
    expect(fundingCrossings(0, FOUR_H)).toBe(0);
    expect(fundingCrossings(FOUR_H, 2 * FOUR_H)).toBe(1);
    expect(result.fundingReturns[0]).toBe(0);
    expect(result.fundingReturns[1]).toBeCloseTo(fundingPnl(w, 0.0001, 'long', 1), 12);
  });

  it('charges nothing on a zero weight', () => {
    const z = [0, 0, 0];
    const result = simulateExposure([daily(z, closes, rates)], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });
    expect(result.fundingReturns.every((f) => f === 0)).toBe(true);
    expect(result.netReturns.every((n) => n === 0)).toBe(true);
  });

  it('charges funding proportional to the weight', () => {
    // z = -1 at zScale 2 gives a target of +0.5 rather than +1, so the same
    // rate is charged on half the notional.
    const z = [-1, -1, -1];
    const result = simulateExposure([daily(z, closes, rates)], {
      band: 0,
      zScale: 2,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });
    // Three settlements on a 1d bar, as in the cases above.
    const expected = fundingPnl(Math.abs(W(-1, 2)), 0.0001, 'long', 3);
    expect(result.fundingReturns[1]).toBeCloseTo(expected, 12);
  });
});

describe('simulateExposure return mechanics', () => {
  it('earns the return t -> t+1 at the weight the signal set at t', () => {
    // The signal at bar 0 sets +1 and holds it; the +10% move between bar 0
    // and bar 1 is what that position earns, so it lands on bar 0's return
    // together with the entry cost. Every later bar is flat and untraded.
    const result = simulateExposure([daily([-1, -1, -1], [100, 110, 110], [0, 0, 0])], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });
    const w = Math.abs(W(-1));
    expect(result.netReturns[0]).toBeCloseTo(w * 0.1 - w * COST_PER_UNIT, 12);
    // Every later bar is flat and the weight does not move, so bar 1 is a
    // clean zero: no return, no cost, no funding.
    expect(result.netReturns[1]).toBeCloseTo(0, 12);
  });

  it('is short when the factor says crowded long, so a rise loses', () => {
    const result = simulateExposure([daily([1, 0, 0], [100, 110, 110], [0, 0, 0])], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });
    const w = Math.abs(W(1));
    expect(result.netReturns[0]).toBeCloseTo(-w * 0.1 - w * COST_PER_UNIT, 12);
  });

  it('a NaN reading holds the previous weight instead of flattening', () => {
    // Bar 0 sets +1; bar 1 has no reading and a +10% move, so the position
    // must still be long for that move rather than being flattened to 0.
    const closes = [100, 100, 110, 110];
    const z = [-1, Number.NaN, Number.NaN, Number.NaN];
    const result = simulateExposure([daily(z, closes, [0, 0, 0, 0])], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });
    const w = Math.abs(W(-1));
    expect(result.netReturns[0]).toBeCloseTo(-w * COST_PER_UNIT, 12);
    expect(result.netReturns[1]).toBeCloseTo(w * 0.1, 12);
    expect(result.turnover[1]).toBe(0);
  });

  it('divides the raw target by the gross cap', () => {
    const result = simulateExposure([daily([-1, -1, -1], [100, 110, 110], [0, 0, 0])], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 2,
      interval: '1d',
    });
    // Half the weight, so half the move and half the entry cost.
    const w = Math.abs(W(-1));
    expect(result.netReturns[0]).toBeCloseTo((w / 2) * 0.1 - (w / 2) * COST_PER_UNIT, 12);
  });

  it('rejects symbols that are not on one shared grid', () => {
    const a = daily([-1, -1], [100, 100], [0, 0], 'AAAUSDT');
    const b: ExposureSymbolInput = {
      symbol: 'BBBUSDT',
      timestamps: [0, DAY, 2 * DAY],
      closes: [1, 1, 1],
      fundingRates: [0, 0, 0],
      z: [-1, -1, -1],
    };
    expect(() =>
      simulateExposure([a, b], { band: 0, zScale: 1, smoothing: 0, gross: 1, interval: '1d' })
    ).toThrow(/same bar grid/);
  });

  it('counts bars whose return is missing rather than reading them as flat', () => {
    const closes = [100, 100, 100];
    const result = simulateExposure([daily([-1, -1, -1], closes, [0, 0, 0])], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });
    // Bars 0 and 1 earn returns 0->1 and 1->2; bar 2 is the last bar and has
    // no forward return, so it is never traded into.
    expect(result.bars).toBe(2);
    expect(result.netReturns).toHaveLength(2);
  });

  it('holdings never exceed the unit position after gross normalisation', () => {
    const z = [-3, -3, 2, 2, -1, -1];
    const prices = [100, 105, 102, 108, 104, 110];
    const result = simulateExposure([daily(z, prices, z.map(() => 0))], {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
    });
    for (const held of result.perSymbol[0].held) {
      expect(Math.abs(held)).toBeLessThanOrEqual(1 + 1e-12);
    }
    for (const gross of result.grossExposure) {
      expect(gross).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

describe('circularBlockShuffle', () => {
  /** Lag-1 autocorrelation, the property the null must preserve. */
  function lag1Autocorrelation(values: number[]): number {
    const n = values.length;
    const m = values.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      den += (values[i] - m) ** 2;
      if (i > 0) num += (values[i] - m) * (values[i - 1] - m);
    }
    return num / den;
  }

  it('preserves the lag-1 autocorrelation of an autocorrelated series', () => {
    // A strongly autocorrelated series, which is what the positioning column
    // actually looks like: a slow cycle with a little noise. A plain shuffle
    // of this lands near zero; a block shuffle has to keep it high.
    const series: number[] = [];
    for (let i = 0; i < 600; i++) {
      series.push(Math.sin(i / 30) + Math.sin(i / 7) * 0.1);
    }
    const original = lag1Autocorrelation(series);

    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const shuffled = circularBlockShuffle(series, 32, random);
    const after = lag1Autocorrelation(shuffled);

    // A plain shuffle of this series lands near 0; a block shuffle keeps it.
    expect(original).toBeGreaterThan(0.9);
    expect(after).toBeGreaterThan(0.9);
    expect(Math.abs(after - original)).toBeLessThan(0.1);
  });

  it('is a permutation: every value used exactly once', () => {
    const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = circularBlockShuffle(series, 3, () => 0.5);
    expect(shuffled).toHaveLength(series.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(series);
  });

  it('returns an empty series unchanged and handles a block longer than the series', () => {
    expect(circularBlockShuffle([], 8, () => 0)).toEqual([]);
    const series = [1, 2, 3];
    const shuffled = circularBlockShuffle(series, 100, () => 0.5);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(series);
  });
});

describe('bootstrapBlockLength', () => {
  it('never drops below the factor decay horizon', () => {
    // A container that rebalances nearly every bar has a short realised
    // spacing, but the block must still cover the horizon the factor's IC is
    // measured over, or the bootstrap samples independent draws from an
    // autocorrelated series and the interval comes out too tight.
    expect(bootstrapBlockLength(1)).toBe(FACTOR_DECAY_HORIZON_BARS);
    expect(bootstrapBlockLength(3.2)).toBe(FACTOR_DECAY_HORIZON_BARS);
    expect(FACTOR_DECAY_HORIZON_BARS).toBe(32);
  });

  it('uses the realised spacing once it exceeds the horizon', () => {
    expect(bootstrapBlockLength(50)).toBe(50);
    expect(bootstrapBlockLength(120.4)).toBe(120);
    expect(bootstrapBlockLength(120.6)).toBe(121);
  });

  it('falls back to the horizon when nothing ever rebalanced', () => {
    expect(bootstrapBlockLength(Number.POSITIVE_INFINITY)).toBe(FACTOR_DECAY_HORIZON_BARS);
    expect(bootstrapBlockLength(Number.NaN)).toBe(FACTOR_DECAY_HORIZON_BARS);
    expect(bootstrapBlockLength(0)).toBe(FACTOR_DECAY_HORIZON_BARS);
  });

  it('is never the cbrt(n) rule the discrete path uses', () => {
    // Sanity on the shape of the divergence: cbrt over a bar count of a
    // hundred thousand is about 46, and over a trade count of 1,251 about 11.
    // This rule returns neither for a short-spacing container, and is not a
    // function of sample size at all.
    expect(Math.round(Math.cbrt(100_000))).toBeCloseTo(46, 0);
    expect(Math.round(Math.cbrt(1251))).toBeCloseTo(11, 0);
    expect(bootstrapBlockLength(1)).not.toBe(46);
    expect(bootstrapBlockLength(1)).not.toBe(11);
  });
});

describe('FUNDING_INTERVAL_MS sanity', () => {
  it('is the 8h grid the crossings helper is built on', () => {
    expect(FUNDING_INTERVAL_MS).toBe(8 * 60 * 60 * 1000);
  });
});

describe('crossSectionalTargets', () => {
  const grid = { scheme: 'topBottom' as const, legs: 1, factorSign: -1 as const, minCrossSection: 5 };
  it('topBottom k=1 goes long the lowest and short the highest reading under factorSign -1, unit gross, zero net', () => {
    const w = crossSectionalTargets([0.5, 0.1, 0.9, 0.3, 0.7], grid);
    expect(w).toEqual([0, 0.5, -0.5, 0, 0]);
    expect(w.reduce((a, b) => a + Math.abs(b), 0)).toBeCloseTo(1, 12);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 12);
  });
  it('topBottom k=2 splits each leg across two symbols', () => {
    const w = crossSectionalTargets([0.5, 0.1, 0.9, 0.3, 0.7], { ...grid, legs: 2 });
    expect(w).toEqual([0, 0.25, -0.25, 0.25, -0.25]);
  });
  it('linearRank weights are proportional to rank minus the mean rank, scaled to unit gross', () => {
    const w = crossSectionalTargets([0.5, 0.1, 0.9, 0.3, 0.7], { ...grid, scheme: 'linearRank' });
    // factorSign -1: lowest reading gets the highest rank. ranks (high=long): [3,5,1,4,2]; centre (n+1)/2 = 3; centred [0,2,-2,1,-1]; sum|.| = 6
    expect(w.map((x) => Number(x.toFixed(6)))).toEqual([0, 0.333333, -0.333333, 0.166667, -0.166667]);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 12);
  });
  it('holds (all NaN) below the minimum cross-section and ignores NaN readings above it', () => {
    expect(crossSectionalTargets([0.5, NaN, 0.9, NaN, 0.7], grid).every(Number.isNaN)).toBe(true);
    const w = crossSectionalTargets([0.5, NaN, 0.9, 0.3, 0.7, 0.2], { ...grid, minCrossSection: 4 });
    expect(Number.isNaN(w[1])).toBe(true);
    expect(w.reduce((a, b) => a + (Number.isNaN(b) ? 0 : b), 0)).toBeCloseTo(0, 12);
  });
  it('breaks ties by symbol order: descending signed value, ties by ascending index, long leg from the head, short leg from the tail', () => {
    // signed (factorSign -1): [-0.2, -0.2, -0.9, -0.9, -0.5]; sorted: idx0, idx1, idx4, idx2, idx3
    expect(crossSectionalTargets([0.2, 0.2, 0.9, 0.9, 0.5], grid)).toEqual([0.5, 0, 0, -0.5, 0]);
  });
  it('maxRankWeight is 1/(2k) for topBottom and the centred top rank over the rank sum for linearRank', () => {
    expect(maxRankWeight('topBottom', 1, 10)).toBe(0.5);
    expect(maxRankWeight('topBottom', 2, 10)).toBe(0.25);
    expect(maxRankWeight('linearRank', undefined, 10)).toBeCloseTo(4.5 / 25, 12);
  });
  it('throws when 2 * legs exceeds the finite count', () => {
    expect(() =>
      crossSectionalTargets([1, 2, 3], { scheme: 'topBottom', legs: 2, factorSign: -1, minCrossSection: 1 })
    ).toThrow(/legs/);
  });
  it('throws on an unsupported scheme', () => {
    expect(() =>
      crossSectionalTargets([1, 2, 3, 4, 5], { scheme: 'tanh', factorSign: -1, minCrossSection: 1 })
    ).toThrow(/unsupported scheme/);
  });
  it('maxRankWeight throws on an unsupported scheme', () => {
    expect(() => maxRankWeight('tanh', undefined, 10)).toThrow(/unsupported scheme/);
  });
});

describe('simulateExposure rank scheme', () => {
  const symbols = fiveSymbolFixture();
  const grid = baseGrid;

  it('an exact dollar-neutral exit when a leg symbol drops out of the cross-section', () => {
    // dropoutFixture: symbol 4 is the topBottom k=1 short leg at bar 0 (held
    // -0.5); its signal is NaN at bar 1 while the other four stay finite (4
    // of 5, at the minCrossSection floor). The book-level rule flattens
    // symbol 4 to exactly 0 rather than carrying the stale -0.5 forward,
    // which is the only way the sum can stay at zero once the others
    // re-rank over the smaller cross-section.
    const result = simulateExposure(dropoutFixture(), {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
      scheme: 'topBottom',
      legs: 1,
      factorSign: -1,
      minCrossSection: 4,
    });
    for (const n of result.netExposure) expect(Math.abs(n)).toBeLessThan(1e-12);
    expect(result.perSymbol[4].held[1]).toBeCloseTo(-0.5, 12);
    // From the bar-1 trade onward (index 2 is what bar 1's rebalance
    // produces; index 3 is bar 2's, and bar 2's own reading keeps symbol 4
    // out of a leg too), it never carries a non-zero weight again.
    expect(result.perSymbol[4].held.slice(2).every((h) => h === 0)).toBe(true);
    // Entry (0.5 at bar 0) plus the forced exit (0.5 at bar 1).
    expect(result.perSymbol[4].turnover).toBeCloseTo(1, 12);
  });
  it('scheme undefined and scheme tanh produce identical output', () => {
    const a = simulateExposure(symbols, grid);
    const b = simulateExposure(symbols, { ...grid, scheme: 'tanh' });
    expect(b.netReturns).toEqual(a.netReturns);
    expect(b.turnover).toEqual(a.turnover);
  });
  it('maker fill charges the maker fee and no slippage', () => {
    const taker = simulateExposure(symbols, grid);
    const maker = simulateExposure(symbols, grid, { fill: 'maker' });
    // first traded bar: cost = delta x (maker fee + 0) vs delta x (taker fee + slippage)
    expect(maker.costReturns[0]).toBeCloseTo(
      taker.costReturns[0] *
        (BINANCE_FUTURES_MAKER_FEE / (BINANCE_FUTURES_TAKER_FEE + STUDY_SLIPPAGE_BPS[grid.interval] / 10000)),
      12
    );
  });
  it('rank weights are not divided by gross', () => {
    const grid1: ExposureGrid = {
      ...baseGrid,
      band: 0,
      gross: 1,
      scheme: 'topBottom',
      legs: 1,
      factorSign: -1,
      minCrossSection: 4,
    };
    const grid3: ExposureGrid = { ...grid1, gross: 3 };
    const a = simulateExposure(fiveSymbolFixture(), grid1);
    const b = simulateExposure(fiveSymbolFixture(), grid3);
    expect(b.netReturns).toEqual(a.netReturns);
    for (let s = 0; s < a.perSymbol.length; s++) {
      expect(b.perSymbol[s].held).toEqual(a.perSymbol[s].held);
    }
  });
  it('linearRank stays dollar neutral across many bars of changing ranks under a fractional band', () => {
    const rows = [
      [1, 2, 3, 4, 5],
      [5, 3, 4, 2, 1],
      [2, 5, 1, 3, 4],
      [4, 1, 5, 2, 3],
      [3, 4, 2, 5, 1],
      [1, 5, 3, 4, 2],
      [1, 5, 3, 4, 2],
    ];
    const band = 0.5 * maxRankWeight('linearRank', undefined, 5);
    const result = simulateExposure(manyRanksFixture(rows), {
      band,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
      scheme: 'linearRank',
      factorSign: -1,
      minCrossSection: 5,
    });
    expect(result.netExposure.length).toBeGreaterThan(0);
    for (const n of result.netExposure) expect(Math.abs(n)).toBeLessThan(1e-12);
  });
  it('the incomplete-bar branch pushes 0 to the new series and keeps every series the same length', () => {
    const result = simulateExposure(twoSymbolGapFixture(), {
      band: 0,
      zScale: 1,
      smoothing: 0,
      gross: 1,
      interval: '1d',
      scheme: 'topBottom',
      legs: 1,
      factorSign: -1,
      minCrossSection: 2,
    });
    expect(result.incompleteBars).toBe(2);
    expect(result.netExposure).toHaveLength(result.netReturns.length);
    expect(result.longLegReturns).toHaveLength(result.netReturns.length);
    expect(result.shortLegReturns).toHaveLength(result.netReturns.length);
    expect(result.netExposure[0]).toBe(0);
    expect(result.netExposure[1]).toBe(0);
    expect(result.longLegReturns[0]).toBe(0);
    expect(result.longLegReturns[1]).toBe(0);
    expect(result.shortLegReturns[0]).toBe(0);
    expect(result.shortLegReturns[1]).toBe(0);
  });
});

describe('simulateExposure book-level band (rank schemes)', () => {
  const rankGrid = (band: number): ExposureGrid => ({
    band,
    zScale: 1,
    smoothing: 0,
    gross: 1,
    interval: '1d',
    scheme: 'linearRank',
    factorSign: -1,
    minCrossSection: 5,
  });

  it('a large mover forces the whole book to rebalance, including a symbol whose own move is below the band', () => {
    // bar 0 -> bar 1 reverses the ranking entirely: symbols 0 and 4 each move
    // by 2/3 (well above the 0.2 band), symbol 3 by 1/3, and symbols 1 and 2
    // by 1/6 each -- below the band on their own, but the book-level rule
    // rebalances every symbol once the largest move clears it.
    const fixture = manyRanksFixture([
      [1, 2, 3, 4, 5],
      [5, 3, 4, 2, 1],
      [5, 3, 4, 2, 1],
    ]);
    const result = simulateExposure(fixture, rankGrid(0.2));
    for (let s = 0; s < 5; s++) {
      const moved = Math.abs(result.perSymbol[s].held[2] - result.perSymbol[s].held[1]);
      expect(moved).toBeGreaterThan(1e-9);
    }
    expect(result.turnover[1]).toBeGreaterThan(0);
    expect(Math.abs(result.netExposure[1])).toBeLessThan(1e-12);
  });

  it('every move below the band leaves the book exactly where it was', () => {
    // bar 0 -> bar 1 only swaps the ranks of symbols 1 and 2 (adjacent
    // ranks), the smallest possible non-zero move (1/6), which stays under a
    // 0.7 band.
    const fixture = manyRanksFixture([
      [1, 2, 3, 4, 5],
      [1, 3, 2, 4, 5],
      [1, 3, 2, 4, 5],
    ]);
    const result = simulateExposure(fixture, rankGrid(0.7));
    expect(result.turnover[1]).toBeCloseTo(0, 12);
    for (let s = 0; s < 5; s++) {
      expect(result.perSymbol[s].held[2]).toBeCloseTo(result.perSymbol[s].held[1], 12);
    }
  });
});
