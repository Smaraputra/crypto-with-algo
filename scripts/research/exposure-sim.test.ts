import { describe, expect, it } from 'vitest';

import { BINANCE_FUTURES_TAKER_FEE, STUDY_SLIPPAGE_BPS } from '@/lib/backtest/cost-model';
import { FUNDING_INTERVAL_MS, fundingCrossings, fundingPnl } from '@/lib/backtest/funding';
import {
  FACTOR_DECAY_HORIZON_BARS,
  bootstrapBlockLength,
  circularBlockShuffle,
  simulateExposure,
  targetExposure,
  trailingMean,
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

describe('simulateExposure funding', () => {
  const closes = [100, 100, 100];
  // The rate read at each bar, one settlement per bar. Bar 1 carries a rate,
  // so the funding it causes lands on bar 1's own return.
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

    // One settlement's rate applied to one settlement, not three: the rate
    // column is per bar, so multiplying by the bar's crossing count would
    // charge the same rate to every boundary the bar spans.
    const w = Math.abs(W(-1));
    const expected = fundingPnl(w, 0.0001, 'long', 1);
    expect(expected).toBeLessThan(0);
    expect(fundingCrossings(0, DAY)).toBe(3);
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
    const expected = fundingPnl(Math.abs(W(1)), 0.0001, 'short', 1);
    expect(expected).toBeGreaterThan(0);
    expect(result.fundingReturns[1]).toBeCloseTo(expected, 12);
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
    const expected = fundingPnl(Math.abs(W(-1, 2)), 0.0001, 'long', 1);
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
