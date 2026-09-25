import { describe, expect, it } from 'vitest';

import {
  ACTIONABLE_TIERS,
  MIN_SAMPLES_FOR_ESTIMATE,
  bootstrapIterationsFor,
  bucketByTimestamp,
  cumulativeReturn,
  estimateMean,
  reliabilityCurve,
  returnDistribution,
  tierCalibration,
  type CalibrationRow,
} from './calibration-analytics';
import type { SignalTier } from '@/types/signal';

const HOUR = 3_600_000;

function row(overrides: Partial<CalibrationRow> = {}): CalibrationRow {
  return {
    symbol: 'BTCUSDT',
    candleTimestamp: 0,
    tier: 'buy',
    score: 30,
    forwardReturnPercent: 0,
    mfePercent: 1,
    maePercent: -1,
    configVersion: 7,
    ...overrides,
  };
}

/** n rows one bar apart, cycling the given returns. */
function series(
  count: number,
  returns: number[],
  overrides: Partial<CalibrationRow> = {}
): CalibrationRow[] {
  return Array.from({ length: count }, (_, i) =>
    row({
      candleTimestamp: i * HOUR,
      forwardReturnPercent: returns[i % returns.length],
      ...overrides,
    })
  );
}

const ESTIMATE_OPTS = { meanBlockLen: 4, iterations: 200, seed: 1 };

describe('bootstrapIterationsFor', () => {
  it('reduces iterations as the row count grows', () => {
    expect(bootstrapIterationsFor(500)).toBe(1000);
    expect(bootstrapIterationsFor(20_000)).toBe(500);
    expect(bootstrapIterationsFor(120_000)).toBe(200);
  });
});

describe('bucketByTimestamp', () => {
  it('puts every symbol at one timestamp into the same bucket', () => {
    const rows = [
      row({ candleTimestamp: HOUR, symbol: 'BTCUSDT', forwardReturnPercent: 1 }),
      row({ candleTimestamp: HOUR, symbol: 'ETHUSDT', forwardReturnPercent: 2 }),
      row({ candleTimestamp: 2 * HOUR, symbol: 'BTCUSDT', forwardReturnPercent: 3 }),
    ];

    const buckets = bucketByTimestamp(rows, (r) => r.candleTimestamp, (r) => r.forwardReturnPercent);

    expect(buckets).toEqual([[1, 2], [3]]);
  });

  it('orders buckets by timestamp even when rows arrive unsorted', () => {
    const rows = [
      row({ candleTimestamp: 3 * HOUR, forwardReturnPercent: 3 }),
      row({ candleTimestamp: HOUR, forwardReturnPercent: 1 }),
    ];

    expect(bucketByTimestamp(rows, (r) => r.candleTimestamp, (r) => r.forwardReturnPercent)).toEqual([
      [1],
      [3],
    ]);
  });
});

describe('estimateMean', () => {
  it('withholds everything below the sample floor and says why', () => {
    const rows = series(MIN_SAMPLES_FOR_ESTIMATE - 1, [1]);

    const estimate = estimateMean(rows, (r) => r.forwardReturnPercent, ESTIMATE_OPTS);

    expect(estimate.withheld).toBe('too-few-samples');
    expect(estimate.meanPercent).toBeNull();
    expect(estimate.ciLowPercent).toBeNull();
    // The count is still reported: "we have 29" is the useful part of "no estimate".
    expect(estimate.count).toBe(MIN_SAMPLES_FOR_ESTIMATE - 1);
  });

  it('reports a mean but withholds the interval when there are too few blocks', () => {
    // 40 rows clears the sample floor, but at one timestamp each with a block
    // length of 20 there are only 2 blocks' worth to resample.
    const rows = series(40, [0.5]);

    const estimate = estimateMean(rows, (r) => r.forwardReturnPercent, {
      meanBlockLen: 20,
      iterations: 100,
      seed: 1,
    });

    expect(estimate.withheld).toBe('too-few-blocks');
    expect(estimate.meanPercent).toBeCloseTo(0.5, 10);
    expect(estimate.ciHighPercent).toBeNull();
  });

  it('brackets the mean with an interval when the sample supports one', () => {
    const rows = series(400, [1, -1, 2, 0]);

    const estimate = estimateMean(rows, (r) => r.forwardReturnPercent, ESTIMATE_OPTS);

    expect(estimate.withheld).toBe('none');
    expect(estimate.meanPercent).toBeCloseTo(0.5, 10);
    expect(estimate.ciLowPercent as number).toBeLessThan(estimate.meanPercent as number);
    expect(estimate.ciHighPercent as number).toBeGreaterThan(estimate.meanPercent as number);
  });

  it('is deterministic across calls, so a refresh does not move the interval', () => {
    const rows = series(400, [1, -1, 2, 0]);

    const first = estimateMean(rows, (r) => r.forwardReturnPercent, ESTIMATE_OPTS);
    const second = estimateMean(rows, (r) => r.forwardReturnPercent, ESTIMATE_OPTS);

    expect(second.ciLowPercent).toBe(first.ciLowPercent);
    expect(second.ciHighPercent).toBe(first.ciHighPercent);
  });

  it('widens the interval when the cross-section is correlated rather than independent', () => {
    // Exactly the same 800 observations in both layouts; only the timestamps
    // differ. Each group of ten shares a common factor, which is what ten
    // symbols moving together at one bar looks like. Spread one-per-timestamp
    // they resample as 800 buckets; stacked ten-per-timestamp they are 80
    // buckets that move as units, so the interval must be WIDER -- the ten
    // correlated symbols are not ten independent observations.
    //
    // The factor is drawn from a linear congruential generator rather than a
    // smooth function on purpose. A periodic factor such as sin(group) makes
    // the grouped layout's longer blocks average the periodicity away, which
    // cancels the sample-size effect exactly and hides the property under test.
    const values: number[] = [];
    let seed = 12345;
    const nextFactor = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648 - 0.5) * 4;
    };
    for (let group = 0; group < 80; group++) {
      const factor = nextFactor();
      for (let member = 0; member < 10; member++) {
        values.push(factor + (member - 4.5) * 0.02);
      }
    }

    const spread = values.map((value, i) =>
      row({ candleTimestamp: i * HOUR, forwardReturnPercent: value })
    );
    const stacked = values.map((value, i) =>
      row({
        candleTimestamp: Math.floor(i / 10) * HOUR,
        symbol: `S${i % 10}`,
        forwardReturnPercent: value,
      })
    );

    const spreadEstimate = estimateMean(spread, (r) => r.forwardReturnPercent, ESTIMATE_OPTS);
    const stackedEstimate = estimateMean(stacked, (r) => r.forwardReturnPercent, ESTIMATE_OPTS);

    const spreadWidth = (spreadEstimate.ciHighPercent as number) - (spreadEstimate.ciLowPercent as number);
    const stackedWidth = (stackedEstimate.ciHighPercent as number) - (stackedEstimate.ciLowPercent as number);

    expect(stackedWidth).toBeGreaterThan(spreadWidth);
  });
});

describe('tierCalibration', () => {
  it('inverts the return for sell tiers, matching the backtest convention', () => {
    const buys = series(60, [1], { tier: 'buy' });
    const sells = series(60, [-1], { tier: 'sell' }).map((r) => ({
      ...r,
      candleTimestamp: r.candleTimestamp + 1,
    }));

    const result = tierCalibration([...buys, ...sells], {
      ...ESTIMATE_OPTS,
      costPercentRoundTrip: 0,
    });

    const buy = result.find((r) => r.tier === 'buy');
    const sell = result.find((r) => r.tier === 'sell');
    // A sell tier whose price fell 1% was RIGHT, so its directional return is +1.
    expect(buy?.meanPercent).toBeCloseTo(1, 10);
    expect(sell?.meanPercent).toBeCloseTo(1, 10);
  });

  it('subtracts cost from the point estimate and both interval bounds alike', () => {
    const rows = series(400, [1, -1, 2, 0], { tier: 'buy' });

    const [result] = tierCalibration(rows, { ...ESTIMATE_OPTS, costPercentRoundTrip: 0.16 });

    expect(result.netMeanPercent).toBeCloseTo((result.meanPercent as number) - 0.16, 10);
    expect(result.netCiLowPercent).toBeCloseTo((result.ciLowPercent as number) - 0.16, 10);
    expect(result.netCiHighPercent).toBeCloseTo((result.ciHighPercent as number) - 0.16, 10);
  });

  it('reports win rate on the directional return, not the raw one', () => {
    // Every row fell 1%, which a sell tier predicted correctly.
    const rows = series(60, [-1], { tier: 'strong_sell' });

    const [result] = tierCalibration(rows, { ...ESTIMATE_OPTS, costPercentRoundTrip: 0 });

    expect(result.winRate).toBe(1);
  });

  it('omits a tier with no rows rather than emitting an empty one', () => {
    const rows = series(60, [1], { tier: 'buy' });

    const result = tierCalibration(rows, { ...ESTIMATE_OPTS, costPercentRoundTrip: 0 });

    expect(result.map((r) => r.tier)).toEqual(['buy']);
  });
});

describe('reliabilityCurve', () => {
  it('buckets by signed score and keeps the sign of the return', () => {
    // A perfectly inverted score: positive scores precede negative returns.
    const rows = [
      ...series(60, [-1], { score: 35 }),
      ...series(60, [1], { score: -35 }).map((r) => ({ ...r, candleTimestamp: r.candleTimestamp + 1 })),
    ];

    const curve = reliabilityCurve(rows, { ...ESTIMATE_OPTS, bucketWidth: 10 });

    const positive = curve.find((b) => b.scoreLow === 30);
    const negative = curve.find((b) => b.scoreLow === -40);
    // Signed against signed is what makes an inverted score visible: had the
    // directional return been used, both buckets would read +1.
    expect(positive?.meanPercent).toBeCloseTo(-1, 10);
    expect(negative?.meanPercent).toBeCloseTo(1, 10);
  });

  it('places a score on the bucket floor, not by rounding', () => {
    const rows = series(60, [1], { score: 29 });

    const curve = reliabilityCurve(rows, { ...ESTIMATE_OPTS, bucketWidth: 10 });

    expect(curve[0].scoreLow).toBe(20);
    expect(curve[0].scoreHigh).toBe(30);
    expect(curve[0].scoreMid).toBe(25);
  });

  it('returns nothing for no rows', () => {
    expect(reliabilityCurve([], ESTIMATE_OPTS)).toEqual([]);
  });
});

describe('returnDistribution', () => {
  it('shares bin edges across tiers so the panels are comparable', () => {
    const rows = [
      ...series(20, [0.5], { tier: 'buy' }),
      ...series(20, [-0.5], { tier: 'sell' }),
    ];

    const result = returnDistribution(rows, { binCount: 10 });

    expect(result.bins).toHaveLength(10);
    expect(result.tiers).toEqual(['buy', 'sell']);
    const totals = result.bins.reduce(
      (sum, bin) => sum + (bin.counts.buy ?? 0) + (bin.counts.sell ?? 0),
      0
    );
    expect(totals).toBe(40);
  });

  it('counts rows beyond the plotted range as clipped instead of dropping them', () => {
    const rows = [...series(99, [0.1], { tier: 'buy' }), row({ tier: 'buy', forwardReturnPercent: 40 })];

    const result = returnDistribution(rows, { binCount: 10, quantile: 0.9 });

    expect(result.clipped.buy).toBe(1);
  });

  it('survives a degenerate range without dividing by zero', () => {
    const rows = series(10, [0], { tier: 'neutral' });

    const result = returnDistribution(rows, { binCount: 4 });

    expect(result.binEdges).toHaveLength(5);
    expect(result.bins.every((bin) => Number.isFinite(bin.low) && Number.isFinite(bin.high))).toBe(true);
  });
});

describe('cumulativeReturn', () => {
  it('excludes neutral signals, which are informational', () => {
    const rows = [
      ...series(10, [1], { tier: 'neutral' }),
      ...series(10, [1], { tier: 'buy' }).map((r) => ({ ...r, candleTimestamp: r.candleTimestamp + 1 })),
    ];

    const [result] = cumulativeReturn(rows, { horizonBars: 1, costPercentRoundTrip: 0 });

    expect(result.count).toBe(10);
    expect(ACTIONABLE_TIERS).not.toContain('neutral' as SignalTier);
  });

  it('samples one signal per symbol per horizon by default', () => {
    // 24 consecutive hourly buys on one symbol at a 24-bar horizon can support
    // exactly one non-overlapping trade.
    const rows = series(24, [1], { tier: 'buy' });

    const [result] = cumulativeReturn(rows, { horizonBars: 24, costPercentRoundTrip: 0 });

    expect(result.count).toBe(1);
  });

  it('thins each symbol independently, not the merged stream', () => {
    // Two symbols firing on the same bars must each contribute a signal; a
    // thinning rule applied to the merged stream would drop one of them.
    const btc = series(24, [1], { tier: 'buy', symbol: 'BTCUSDT' });
    const eth = series(24, [1], { tier: 'buy', symbol: 'ETHUSDT' });

    const [result] = cumulativeReturn([...btc, ...eth], { horizonBars: 24, costPercentRoundTrip: 0 });

    expect(result.count).toBe(2);
  });

  it('sums every signal when overlapping is requested', () => {
    const rows = series(24, [1], { tier: 'buy' });

    const [result] = cumulativeReturn(rows, {
      horizonBars: 24,
      costPercentRoundTrip: 0,
      overlapping: true,
    });

    expect(result.count).toBe(24);
    expect(result.points.at(-1)?.cumulativePercent).toBeCloseTo(24, 10);
  });

  it('splits series by configVersion instead of pooling scorers', () => {
    const v6 = series(10, [1], { tier: 'buy', configVersion: 6 });
    const v7 = series(10, [2], { tier: 'buy', configVersion: 7 }).map((r) => ({
      ...r,
      candleTimestamp: r.candleTimestamp + 100 * HOUR,
    }));

    const result = cumulativeReturn([...v6, ...v7], {
      horizonBars: 1,
      costPercentRoundTrip: 0,
      overlapping: true,
    });

    expect(result.map((s) => s.configVersion)).toEqual([6, 7]);
    expect(result[0].points.at(-1)?.cumulativePercent).toBeCloseTo(10, 10);
    expect(result[1].points.at(-1)?.cumulativePercent).toBeCloseTo(20, 10);
  });

  it('charges the cost estimate once per signal', () => {
    const rows = series(10, [1], { tier: 'buy' });

    const [result] = cumulativeReturn(rows, {
      horizonBars: 1,
      costPercentRoundTrip: 0.16,
      overlapping: true,
    });

    expect(result.points.at(-1)?.cumulativePercent).toBeCloseTo(10 * (1 - 0.16), 10);
  });

  it('inverts sell-tier returns before accumulating them', () => {
    const rows = series(10, [-1], { tier: 'sell' });

    const [result] = cumulativeReturn(rows, {
      horizonBars: 1,
      costPercentRoundTrip: 0,
      overlapping: true,
    });

    expect(result.points.at(-1)?.cumulativePercent).toBeCloseTo(10, 10);
  });
});
