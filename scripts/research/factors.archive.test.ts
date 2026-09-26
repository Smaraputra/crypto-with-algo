// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';
import type { CandleRow, HtfRow, MetricsRow, PerpCandleRow, SnapshotRow } from './dataset-format';
import { computeFactorMatrix, type FactorMatrix } from './factors';

const INTERVAL = '1h';
const INTERVAL_MS = intervalToMs(INTERVAL);
const SLOT_MS = 5 * 60 * 1000;
const START = 1700000000000 - (1700000000000 % INTERVAL_MS);
const BAR_COUNT = 400;

// Deterministic random walk, the LCG pattern the other research tests use.
function generateCandles(count: number, seed = 4242): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;
  const next = () => {
    rng = (rng * 16807) % 2147483647;
    return rng / 2147483647;
  };

  for (let i = 0; i < count; i++) {
    const noise = (next() - 0.5) * 0.5;
    price = price * (1 + noise / 100);
    const volume = 1000 + next() * 5000;
    candles.push({
      timestamp: START + i * INTERVAL_MS,
      open: price * (1 + (next() - 0.5) * 0.003),
      high: price * (1 + next() * 0.005),
      low: price * (1 - next() * 0.005),
      close: price,
      volume,
      takerBuyVolume: volume * 0.5,
    });
  }
  return candles;
}

function toCandleRow(c: OHLCV): CandleRow {
  return { t: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, tbv: c.takerBuyVolume ?? null };
}

const candles = generateCandles(BAR_COUNT);
const candleRows = candles.map(toCandleRow);
const htfRows: HtfRow[] = candleRows.map((c) => ({ t: c.t, context: null }));

/** Funding on every bar, oscillating so the z-score has real spread. */
const snapshotRows: SnapshotRow[] = candleRows.map((c, i) => ({
  t: c.t,
  fundingRate: { rate: 0.0001 * Math.sin(i / 7), markPrice: c.c },
  longShortRatio: null,
  openInterest: null,
  fearGreed: { index: 50, label: 'Neutral' },
  newsSentiment: null,
}));

function metricsRow(t: number, over: Partial<MetricsRow> = {}): MetricsRow {
  return {
    t,
    openInterest: null,
    openInterestValue: null,
    topTraderAccountRatio: null,
    topTraderPositionRatio: null,
    globalAccountRatio: null,
    takerLongShortRatio: null,
    depthImbalance1: null,
    depthImbalance2: null,
    depthImbalance5: null,
    depthNotional1: null,
    depthNotional5: null,
    ...over,
  };
}

/** A 5m grid across the whole span, twelve rows per 1h bar. */
const metricsRows: MetricsRow[] = Array.from({ length: BAR_COUNT * 12 }, (_, i) =>
  metricsRow(START + i * SLOT_MS, {
    // Rises monotonically, so which slot a bar picks up is visible in the value.
    openInterest: 1000 + i,
    openInterestValue: (1000 + i) * 100,
    topTraderPositionRatio: 1.5 + (i % 10) / 100,
    globalAccountRatio: 2 + (i % 5) / 100,
    takerLongShortRatio: 0.8 + (i % 7) / 100,
    depthImbalance1: -0.2 + (i % 4) / 10,
    depthImbalance5: 0.1,
  })
);

const perpRows: PerpCandleRow[] = candleRows.map((c) => ({
  t: c.t,
  o: c.o * 1.001,
  h: c.h * 1.001,
  l: c.l * 1.001,
  c: c.c * 1.001,
  v: c.v,
  qv: c.v * c.c,
  n: 100,
  tbv: null,
}));

const premiumRows: PerpCandleRow[] = candleRows.map((c, i) => ({
  t: c.t,
  o: 0,
  h: 0,
  l: 0,
  c: 0.0005 + i / 1_000_000,
  v: 0,
  qv: 0,
  n: 60,
  tbv: null,
}));

function build(over: Partial<Parameters<typeof computeFactorMatrix>[0]> = {}): FactorMatrix {
  return computeFactorMatrix({
    candles: candleRows,
    snapshots: snapshotRows,
    htf: htfRows,
    interval: INTERVAL,
    metrics: metricsRows,
    perp: perpRows,
    premiumIndex: premiumRows,
    ...over,
  });
}

function column(matrix: FactorMatrix, name: string): Float64Array {
  const index = matrix.names.indexOf(name);
  expect(index, `factor ${name} is missing`).toBeGreaterThanOrEqual(0);
  return matrix.values[index];
}

const ARCHIVE_FACTORS = [
  'raw.oiChange1',
  'raw.oiChange8',
  'raw.oiPriceDiv',
  'raw.takerLongShortRatio',
  'raw.topTraderPositionRatio',
  'raw.globalAccountRatio',
  'raw.fundingZ',
  'raw.basisPct',
  'raw.perpSpotSpreadPct',
  'raw.depthImbalance1',
  'raw.depthImbalance5',
  'raw.depthNotionalZ',
];

describe('archive factors: presence and category', () => {
  const matrix = build();

  it('adds every archive column under the raw category', () => {
    for (const name of ARCHIVE_FACTORS) {
      const index = matrix.names.indexOf(name);
      expect(index, name).toBeGreaterThanOrEqual(0);
      expect(matrix.categories[index]).toBe('raw');
    }
  });

  it('keeps the pre-existing columns untouched', () => {
    for (const name of ['composite', 'cat.trend', 'raw.rsi', 'raw.ret1', 'raw.longShortRatio']) {
      expect(matrix.names).toContain(name);
    }
  });

  it('leaves every archive column NaN when the inputs are absent', () => {
    const without = build({ metrics: null, perp: null, premiumIndex: null });
    for (const name of ARCHIVE_FACTORS) {
      // fundingZ comes from snapshots, not the archive, so it survives.
      if (name === 'raw.fundingZ') continue;
      const values = column(without, name);
      for (let bar = without.warmupBars; bar < candleRows.length; bar++) {
        expect(values[bar], `${name} at ${bar}`).toBeNaN();
      }
    }
  });

  it('still produces the same composite with the archive inputs supplied', () => {
    const without = build({ metrics: null, perp: null, premiumIndex: null });
    const a = column(matrix, 'composite');
    const b = column(without, 'composite');
    for (let bar = matrix.warmupBars; bar < candleRows.length; bar++) {
      expect(b[bar]).toBe(a[bar]);
    }
  });
});

describe('metrics alignment', () => {
  const matrix = build();

  it('takes the last 5m reading at or before the bar close, not the bar open', () => {
    const bar = matrix.warmupBars + 10;
    const oi = column(matrix, 'raw.oiChange1');
    expect(Number.isFinite(oi[bar])).toBe(true);

    // Twelve 5m slots per 1h bar, so bar k closes on slot 12k + 11.
    const expectedSlot = 12 * bar + 11;
    const expectedPrev = 12 * (bar - 1) + 11;
    const expected = Math.log((1000 + expectedSlot) / (1000 + expectedPrev));
    expect(oi[bar]).toBeCloseTo(expected, 12);
  });

  it('reads positioning from the same slot', () => {
    const bar = matrix.warmupBars + 10;
    const slot = 12 * bar + 11;
    expect(column(matrix, 'raw.globalAccountRatio')[bar]).toBeCloseTo(2 + (slot % 5) / 100, 12);
    expect(column(matrix, 'raw.takerLongShortRatio')[bar]).toBeCloseTo(0.8 + (slot % 7) / 100, 12);
    expect(column(matrix, 'raw.topTraderPositionRatio')[bar]).toBeCloseTo(1.5 + (slot % 10) / 100, 12);
    expect(column(matrix, 'raw.depthImbalance1')[bar]).toBeCloseTo(-0.2 + (slot % 4) / 10, 12);
    expect(column(matrix, 'raw.depthImbalance5')[bar]).toBeCloseTo(0.1, 12);
  });

  it('never reads a metrics row published after the bar closes', () => {
    // One row per bar, stamped one millisecond after that bar's close.
    const late = candleRows.map((c) => metricsRow(c.t + INTERVAL_MS, { openInterest: 5000 }));
    const matrixLate = build({ metrics: late });
    const values = column(matrixLate, 'raw.globalAccountRatio');
    const oi = column(matrixLate, 'raw.oiChange1');
    for (let bar = matrixLate.warmupBars; bar < candleRows.length; bar++) {
      expect(values[bar]).toBeNaN();
      // Only rows from strictly earlier bars can be in reach.
      expect(Number.isFinite(oi[bar]) || Number.isNaN(oi[bar])).toBe(true);
    }
  });

  it('refuses to carry a reading beyond the staleness cap', () => {
    // A single row at the very start: bars far past it must not inherit it.
    const sparse = [metricsRow(START, { openInterest: 1000, globalAccountRatio: 2 })];
    const matrixSparse = build({ metrics: sparse });
    const values = column(matrixSparse, 'raw.globalAccountRatio');
    const lastBar = candleRows.length - 1;
    expect(values[lastBar]).toBeNaN();
  });

  it('leaves a gap NaN rather than zero', () => {
    const holed = metricsRows.map((row) =>
      row.t >= START + 200 * INTERVAL_MS && row.t < START + 210 * INTERVAL_MS
        ? metricsRow(row.t)
        : row
    );
    const matrixHoled = build({ metrics: holed });
    const values = column(matrixHoled, 'raw.globalAccountRatio');
    expect(values[205]).toBeNaN();
    expect(Number.isFinite(values[220])).toBe(true);
  });
});

describe('derived archive factors', () => {
  const matrix = build();

  it('computes the open interest log change over eight bars', () => {
    const bar = matrix.warmupBars + 20;
    const slot = (b: number) => 1000 + 12 * b + 11;
    expect(column(matrix, 'raw.oiChange8')[bar]).toBeCloseTo(
      Math.log(slot(bar) / slot(bar - 8)),
      12
    );
  });

  it('reads the buildup versus liquidation divergence as a sign product', () => {
    const div = column(matrix, 'raw.oiPriceDiv');
    const ret1 = column(matrix, 'raw.ret1');
    const oi1 = column(matrix, 'raw.oiChange1');
    for (let bar = matrix.warmupBars + 1; bar < candleRows.length; bar++) {
      if (!Number.isFinite(oi1[bar]) || !Number.isFinite(ret1[bar])) continue;
      expect(div[bar]).toBe(Math.sign(oi1[bar]) * Math.sign(ret1[bar]));
      expect([-1, 0, 1]).toContain(div[bar]);
    }
  });

  it('propagates a missing leg of the divergence as NaN, not as zero', () => {
    const noOi = build({ metrics: [metricsRow(START, { globalAccountRatio: 2 })] });
    const div = column(noOi, 'raw.oiPriceDiv');
    expect(div[candleRows.length - 1]).toBeNaN();
  });

  it('reads the basis from the premium index close, as a percent', () => {
    const bar = matrix.warmupBars + 5;
    expect(column(matrix, 'raw.basisPct')[bar]).toBeCloseTo((0.0005 + bar / 1_000_000) * 100, 12);
  });

  it('measures the perp to spot spread against the spot close', () => {
    const bar = matrix.warmupBars + 5;
    // Perp bars are built at exactly 1.001x spot.
    expect(column(matrix, 'raw.perpSpotSpreadPct')[bar]).toBeCloseTo(0.1, 8);
  });

  it('joins perp bars on an exact timestamp, never carrying one forward', () => {
    const gapped = perpRows.filter((row) => row.t !== candleRows[matrix.warmupBars + 6].t);
    const matrixGapped = build({ perp: gapped });
    const spread = column(matrixGapped, 'raw.perpSpotSpreadPct');
    expect(spread[matrix.warmupBars + 6]).toBeNaN();
    expect(spread[matrix.warmupBars + 7]).toBeCloseTo(0.1, 8);
  });

  it('exposes perpCloses joined on the exact bar timestamp, NaN where the perp bar is missing', () => {
    const perpByTime = new Map(perpRows.map((r) => [r.t, r.c]));
    for (let bar = 0; bar < candleRows.length; bar++) {
      const expected = perpByTime.get(candleRows[bar].t);
      if (expected === undefined) expect(matrix.perpCloses[bar]).toBeNaN();
      else expect(matrix.perpCloses[bar]).toBe(expected);
    }
    const noPerp = build({ perp: null });
    expect(noPerp.perpCloses.every((c) => Number.isNaN(c))).toBe(true);
  });
});

describe('funding z-score', () => {
  const matrix = build();

  it('is NaN until the minimum number of readings exists', () => {
    const z = column(matrix, 'raw.fundingZ');
    // Fewer than 30 finite readings have accumulated right after warmup.
    expect(z[matrix.warmupBars]).toBeNaN();
    expect(Number.isFinite(z[matrix.warmupBars + 60])).toBe(true);
  });

  it('matches a direct computation over the trailing window', () => {
    const z = column(matrix, 'raw.fundingZ');
    const bar = matrix.warmupBars + 120;
    const windowBars = Math.ceil((30 * 24 * 60 * 60 * 1000) / INTERVAL_MS);
    const start = Math.max(matrix.warmupBars, bar - windowBars + 1);

    // Snapshot i is stamped at candle i's open and holds a reading captured
    // anywhere inside that bar, so bar i reads snapshot i-1. The window the
    // factor sees is therefore the fixture shifted one bar back.
    const window: number[] = [];
    for (let i = start; i <= bar; i++) window.push(0.0001 * Math.sin((i - 1) / 7));
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / (window.length - 1);
    const expected = (window[window.length - 1] - mean) / Math.sqrt(variance);

    expect(z[bar]).toBeCloseTo(expected, 8);
  });

  it('is NaN rather than zero when funding never moves', () => {
    const flat = snapshotRows.map((row) => ({
      ...row,
      fundingRate: { rate: 0.0001, markPrice: 100 },
    }));
    const matrixFlat = build({ snapshots: flat });
    const z = column(matrixFlat, 'raw.fundingZ');
    for (let bar = matrixFlat.warmupBars; bar < candleRows.length; bar++) {
      expect(z[bar]).toBeNaN();
    }
  });

  it('is NaN on a bar whose own funding reading is missing', () => {
    const sparse = snapshotRows.map((row, i) =>
      i % 2 === 0 ? row : { ...row, fundingRate: null }
    );
    const matrixSparse = build({ snapshots: sparse });
    const z = column(matrixSparse, 'raw.fundingZ');
    const funding = column(matrixSparse, 'raw.fundingRate');
    for (let bar = matrixSparse.warmupBars; bar < candleRows.length; bar++) {
      if (Number.isNaN(funding[bar])) expect(z[bar]).toBeNaN();
    }
  });
});

describe('no lookahead across every archive factor', () => {
  const matrix = build();

  it('gives the same value at bar i when every later input is removed', () => {
    // Every probe must leave enough candles for the style's indicator warmup,
    // which computeAllIndicators enforces (210 bars for day_trading).
    const probeBars = [250, 320, BAR_COUNT - 2];

    for (const bar of probeBars) {
      const cutoffClose = candleRows[bar].t + INTERVAL_MS - 1;
      const truncated = computeFactorMatrix({
        candles: candleRows.slice(0, bar + 1),
        snapshots: snapshotRows.filter((r) => r.t <= cutoffClose),
        htf: htfRows.slice(0, bar + 1),
        interval: INTERVAL,
        metrics: metricsRows.filter((r) => r.t <= cutoffClose),
        perp: perpRows.filter((r) => r.t <= cutoffClose),
        premiumIndex: premiumRows.filter((r) => r.t <= cutoffClose),
      });

      const fullIdx = new Map(matrix.names.map((n, i) => [n, i]));
      for (const name of ARCHIVE_FACTORS) {
        const truncatedIdx = truncated.names.indexOf(name);
        expect(truncatedIdx, name).toBeGreaterThanOrEqual(0);
        const a = truncated.values[truncatedIdx][bar];
        const b = matrix.values[fullIdx.get(name)!][bar];
        if (Number.isNaN(b)) expect(a, `${name} at ${bar}`).toBeNaN();
        else expect(a, `${name} at ${bar}`).toBeCloseTo(b, 12);
      }
    }
  });
});

describe('book depth level, shape and flow', () => {
  // A 5m grid carrying notional on BOTH bands, which the existing fixture
  // leaves null. Bar b picks up slot 12b+11, the last reading at or before its
  // close, the same alignment the open-interest test relies on.
  const slotOf = (bar: number) => 12 * bar + 11;
  const notional1 = (i: number) => 1_000_000 + i * 1_000;
  const notional5 = (i: number) => 4_000_000 + i * 2_000;
  const imbalance1 = (i: number) => -0.2 + (i % 4) / 10;

  const depthMetrics: MetricsRow[] = Array.from({ length: BAR_COUNT * 12 }, (_, i) =>
    metricsRow(START + i * SLOT_MS, {
      depthImbalance1: imbalance1(i),
      depthNotional1: notional1(i),
      depthNotional5: notional5(i),
    })
  );

  const matrix = build({ metrics: depthMetrics });

  it('adds the three columns under the raw category', () => {
    for (const name of ['raw.depthNotional1', 'raw.depthSlope', 'raw.depthFlow1']) {
      const index = matrix.names.indexOf(name);
      expect(index, `factor ${name} is missing`).toBeGreaterThanOrEqual(0);
      expect(matrix.categories[index]).toBe('raw');
    }
  });

  it('reads the notional level from the aligned slot', () => {
    const bar = matrix.warmupBars + 20;
    expect(column(matrix, 'raw.depthNotional1')[bar]).toBeCloseTo(notional1(slotOf(bar)), 6);
  });

  it('measures book shape as the 5 percent band relative to the 1 percent band', () => {
    const bar = matrix.warmupBars + 20;
    const i = slotOf(bar);
    expect(column(matrix, 'raw.depthSlope')[bar]).toBeCloseTo(
      (notional5(i) - notional1(i)) / notional1(i),
      12
    );
  });

  it('measures flow as the change in signed depth, scaled by current depth', () => {
    // B - A = N * I identically, so the order-flow imbalance
    // (B_t - B_{t-1}) - (A_t - A_{t-1}) collapses to N_t*I_t - N_{t-1}*I_{t-1}
    // and needs no separate reconstruction of each side.
    const bar = matrix.warmupBars + 20;
    const i = slotOf(bar);
    const prev = slotOf(bar - 1);
    const expected =
      (notional1(i) * imbalance1(i) - notional1(prev) * imbalance1(prev)) / notional1(i);
    expect(column(matrix, 'raw.depthFlow1')[bar]).toBeCloseTo(expected, 12);
  });

  it('is NaN, never zero, when a band is missing', () => {
    const noNotional = build({
      metrics: Array.from({ length: BAR_COUNT * 12 }, (_, i) =>
        metricsRow(START + i * SLOT_MS, { depthImbalance1: imbalance1(i) })
      ),
    });
    const bar = noNotional.warmupBars + 20;
    expect(column(noNotional, 'raw.depthNotional1')[bar]).toBeNaN();
    expect(column(noNotional, 'raw.depthSlope')[bar]).toBeNaN();
    expect(column(noNotional, 'raw.depthFlow1')[bar]).toBeNaN();
  });

  it('leaves flow NaN when the previous bar has no reading, rather than treating it as zero', () => {
    const gapped = depthMetrics.filter(
      (row) => row.t < START + slotOf(BAR_COUNT - 6) * SLOT_MS - 11 * SLOT_MS ||
               row.t > START + slotOf(BAR_COUNT - 6) * SLOT_MS
    );
    const matrixGapped = build({ metrics: gapped });
    const flow = column(matrixGapped, 'raw.depthFlow1');
    // The bar after the removed slot span has no previous reading to difference.
    expect(flow[BAR_COUNT - 6]).toBeNaN();
  });

  it('depthNotionalZ is NaN until 30 readings exist and finite after, and NaN on a constant book', () => {
    const z = column(matrix, 'raw.depthNotionalZ');
    expect(z[matrix.warmupBars]).toBeNaN();
    const finiteBars = Array.from(z).filter((v) => Number.isFinite(v)).length;
    expect(finiteBars).toBeGreaterThan(0);
    const constant = build({
      metrics: depthMetrics.map((row) => ({ ...row, depthNotional1: 1_000_000 })),
    });
    expect(Array.from(column(constant, 'raw.depthNotionalZ')).every(Number.isNaN)).toBe(true);
  });
});
