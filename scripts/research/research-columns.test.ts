// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';
import type { CandleRow, HtfRow, MetricsRow, SnapshotRow } from './dataset-format';
import { computeFactorMatrix, toLeanSnapshot, toOHLCV, trailingZScore, type FactorMatrix } from './factors';
import {
  RESEARCH_COLUMNS,
  Z_MIN_SAMPLES,
  buildResearchColumns,
  depthColumn,
  fundingColumn,
  positioningColumn,
  windowBarsForDays,
} from './research-columns';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same log-price bucket math as research-columns.ts's pocBucketOf/pocBucketEdge, duplicated here so the pocDist/outsideValue tests build their expectation independently of the module under test. */
const POC_LOG_FACTOR = Math.log(1.001);
function bucketEdge(bucket: number): number {
  return Math.exp(bucket * POC_LOG_FACTOR);
}
/** A price unambiguously inside bucket `bucket` (its geometric midpoint), so floor(log(p)/log(1.001)) === bucket regardless of floating-point edge rounding. */
function bucketMidPrice(bucket: number): number {
  return Math.exp((bucket + 0.5) * POC_LOG_FACTOR);
}
function flatCandle(timestamp: number, price: number, volume: number): OHLCV {
  return { timestamp, open: price, high: price, low: price, close: price, volume };
}

const INTERVAL = '1h';
const INTERVAL_MS = intervalToMs(INTERVAL);
const SLOT_MS = 5 * 60 * 1000;
const START = 1700000000000 - (1700000000000 % INTERVAL_MS);
const BAR_COUNT = 900;
const SYMBOL = 'BTCUSDT';

// Same deterministic LCG the other research tests use.
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
  return {
    t: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close,
    v: c.volume, tbv: c.takerBuyVolume ?? null,
  };
}

const candles = generateCandles(BAR_COUNT);
const candleRows = candles.map(toCandleRow);
const htfRows: HtfRow[] = candleRows.map((c) => ({ t: c.t, context: null }));

const snapshotRows: SnapshotRow[] = candleRows.map((c, i) => ({
  t: c.t,
  fundingRate: { rate: 0.0001 * Math.sin(i / 7), markPrice: c.c },
  longShortRatio: { ratio: 1.5 + 0.4 * Math.sin(i / 11), longAccount: 0.6, shortAccount: 0.4 },
  openInterest: null,
  fearGreed: { index: 50, label: 'Neutral' },
  newsSentiment: null,
}));

function metricsRow(t: number, over: Partial<MetricsRow> = {}): MetricsRow {
  return {
    t,
    openInterest: null, openInterestValue: null,
    topTraderAccountRatio: null, topTraderPositionRatio: null,
    globalAccountRatio: null, takerLongShortRatio: null,
    depthImbalance1: null, depthImbalance2: null, depthImbalance5: null,
    depthNotional1: null, depthNotional5: null,
    ...over,
  };
}

/** A 5m grid across the whole span, twelve rows per 1h bar. */
const metricsRows: MetricsRow[] = Array.from({ length: BAR_COUNT * 12 }, (_, i) =>
  metricsRow(START + i * SLOT_MS, { depthImbalance1: -0.2 + 0.3 * Math.sin(i / 13) })
);

const leanSnapshots = snapshotRows.map(toLeanSnapshot);

let cachedMatrix: FactorMatrix | null = null;
function matrix(): FactorMatrix {
  if (cachedMatrix) return cachedMatrix;
  cachedMatrix = computeFactorMatrix({
    candles: candleRows,
    snapshots: snapshotRows,
    htf: htfRows,
    interval: INTERVAL,
    metrics: metricsRows,
  });
  return cachedMatrix;
}

/** The warmup the matrix used, so the columns mask the same prefix it does. */
const WARMUP = () => matrix().warmupBars;

function column(m: FactorMatrix, name: string): Float64Array {
  const index = m.names.indexOf(name);
  expect(index, `factor ${name} is missing`).toBeGreaterThanOrEqual(0);
  return m.values[index];
}

function columns() {
  return buildResearchColumns({
    candles,
    snapshots: leanSnapshots,
    metrics: metricsRows,
    interval: INTERVAL,
    symbol: SYMBOL,
    warmupBars: WARMUP(),
  });
}

describe('buildResearchColumns', () => {
  it('emits one row per candle, keyed by the candle open time', () => {
    const rows = columns();
    expect(rows).toHaveLength(BAR_COUNT);
    for (let i = 0; i < BAR_COUNT; i++) expect(rows[i].timestamp).toBe(candles[i].timestamp);
  });

  it('declares every column it can produce', () => {
    const rows = columns();
    const produced = new Set<string>();
    for (const row of rows) for (const key of Object.keys(row.values)) produced.add(key);
    for (const name of produced) expect(RESEARCH_COLUMNS).toContain(name);
  });

  it('adds the new research columns to RESEARCH_COLUMNS', () => {
    for (const name of [
      'vwapDevZ',
      'pocDist',
      'outsideValue',
      'sweepReversal20',
      'sweepReversal50',
      'bosBreak',
      'volRatio',
      'btcLeadLagZ',
    ]) {
      expect(RESEARCH_COLUMNS).toContain(name);
    }
  });

  it('reproduces raw.fundingZ exactly at the 30-day window', () => {
    // The 30-day column must BE the measured factor, not merely resemble it.
    // factors.ts uses FUNDING_Z_DAYS = 30 and FUNDING_Z_MIN_SAMPLES = 30 on a
    // series built from the same buildSnapshotSeries output.
    const measured = column(matrix(), 'raw.fundingZ');
    const rows = columns();
    const name = fundingColumn(30);

    let compared = 0;
    for (let i = 0; i < BAR_COUNT; i++) {
      const mine = rows[i].values[name];
      if (Number.isFinite(measured[i])) {
        expect(mine, `bar ${i}`).toBeCloseTo(measured[i], 12);
        compared++;
      }
    }
    // factors.ts only fills its series from warmupBars onward, so the columns
    // legitimately carry readings on some earlier bars the matrix leaves NaN.
    // What matters is that every bar the matrix DOES measure agrees.
    expect(compared).toBeGreaterThan(300);
  });

  it('carries the depth z of bar i-1, computed on raw.depthImbalance1', () => {
    // The strong assertion: rebuild the unshifted z from the matrix's own
    // raw.depthImbalance1 column and require the emitted column to equal it
    // shifted by exactly one bar. This pins the alignment rule and the shift
    // together, and fails loudly if either side ever drifts from factors.ts.
    const measured = column(matrix(), 'raw.depthImbalance1');
    const unshifted = trailingZScore(measured, windowBarsForDays(30, INTERVAL), 30);
    const rows = columns();
    const name = depthColumn(30);

    expect(rows[0].values[name]).toBeUndefined();

    let compared = 0;
    for (let i = 1; i < BAR_COUNT; i++) {
      const emitted = rows[i].values[name];
      if (Number.isFinite(unshifted[i - 1])) {
        expect(emitted, `bar ${i}`).toBeCloseTo(unshifted[i - 1], 12);
        compared++;
      } else {
        expect(emitted, `bar ${i}`).toBeUndefined();
      }
    }
    expect(compared, 'fixture must produce a real depth z').toBeGreaterThan(100);
  });

  it('is not reading the current bar: shifting by one is observable', () => {
    // If the shift were dropped, the emitted column would equal unshifted[i].
    // Prove the fixture actually distinguishes the two.
    const measured = column(matrix(), 'raw.depthImbalance1');
    const unshifted = trailingZScore(measured, windowBarsForDays(30, INTERVAL), 30);
    const rows = columns();
    const name = depthColumn(30);

    let differing = 0;
    for (let i = 1; i < BAR_COUNT; i++) {
      if (!Number.isFinite(unshifted[i]) || !Number.isFinite(unshifted[i - 1])) continue;
      if (Math.abs(unshifted[i] - unshifted[i - 1]) > 1e-6) differing++;
      const emitted = rows[i].values[name];
      if (Number.isFinite(emitted) && Math.abs(unshifted[i] - unshifted[i - 1]) > 1e-6) {
        expect(emitted).not.toBeCloseTo(unshifted[i], 6);
      }
    }
    expect(differing).toBeGreaterThan(100);
  });

  it('emits the depth column one bar later than the underlying reading appears', () => {
    // Metrics that only start halfway through: the first finite depth z must
    // land strictly after the first bar whose close has a metric.
    const half = Math.floor(BAR_COUNT / 2);
    const lateMetrics = metricsRows.filter((r) => r.t >= START + half * INTERVAL_MS);
    const rows = buildResearchColumns({
      candles, snapshots: leanSnapshots, metrics: lateMetrics,
      interval: INTERVAL, symbol: SYMBOL, warmupBars: WARMUP(),
    });
    const name = depthColumn(30);
    const firstFinite = rows.findIndex((r) => Number.isFinite(r.values[name]));
    expect(firstFinite).toBeGreaterThan(half);
  });

  it('produces a positioning column per declared bar window', () => {
    const rows = columns();
    for (const bars of [180, 360, 720]) {
      const name = positioningColumn(bars);
      expect(rows.some((r) => Number.isFinite(r.values[name]))).toBe(true);
    }
    // Different windows must give different readings, or the window is inert.
    const a = rows[BAR_COUNT - 1].values[positioningColumn(180)];
    const b = rows[BAR_COUNT - 1].values[positioningColumn(720)];
    expect(a).not.toBeCloseTo(b, 6);
  });

  it('is slice-invariant: a column value does not depend on later candles', () => {
    // The defect this module exists to fix. Truncating the input after bar i
    // must not change the value at bar i.
    const full = columns();
    for (const bar of [400, 650, 899]) {
      const truncated = buildResearchColumns({
        candles: candles.slice(0, bar + 1),
        snapshots: leanSnapshots.filter((s) => s.timestamp <= candles[bar].timestamp),
        metrics: metricsRows.filter((r) => r.t <= candles[bar].timestamp + INTERVAL_MS - 1),
        interval: INTERVAL,
        symbol: SYMBOL,
        warmupBars: WARMUP(),
      });
      for (const name of [
        fundingColumn(30),
        positioningColumn(360),
        depthColumn(30),
        'vwapDevZ',
        'pocDist',
        'outsideValue',
        'sweepReversal20',
        'sweepReversal50',
        'bosBreak',
        'volRatio',
      ]) {
        const a = full[bar].values[name];
        const b = truncated[bar].values[name];
        if (a === undefined) {
          expect(b, `${name} at ${bar}`).toBeUndefined();
        } else {
          expect(b, `${name} at ${bar}`).toBeCloseTo(a, 10);
        }
      }
    }
  });

  it('no lookahead for every new column: truncating the candles after bar i leaves the column value at i unchanged', () => {
    // Separate from the slice-invariance test above (which reuses its fixed
    // bar list); this one is the defect the module exists to fix, stated
    // explicitly for the new columns per the brief's own test list.
    const full = columns();
    for (const bar of [500, 700, 899]) {
      const truncated = buildResearchColumns({
        candles: candles.slice(0, bar + 1),
        snapshots: leanSnapshots.filter((s) => s.timestamp <= candles[bar].timestamp),
        metrics: metricsRows.filter((r) => r.t <= candles[bar].timestamp + INTERVAL_MS - 1),
        interval: INTERVAL,
        symbol: SYMBOL,
        warmupBars: WARMUP(),
      });
      for (const name of [
        'vwapDevZ',
        'pocDist',
        'outsideValue',
        'sweepReversal20',
        'sweepReversal50',
        'bosBreak',
        'volRatio',
      ]) {
        const a = full[bar].values[name];
        const b = truncated[bar].values[name];
        if (a === undefined) {
          expect(b, `${name} at ${bar}`).toBeUndefined();
        } else {
          expect(b, `${name} at ${bar}`).toBeCloseTo(a, 10);
        }
      }
    }
  });

  it('omits a column rather than emitting zero when there is no reading', () => {
    const rows = buildResearchColumns({
      candles, snapshots: leanSnapshots, metrics: [],
      interval: INTERVAL, symbol: SYMBOL, warmupBars: WARMUP(),
    });
    for (const days of [30, 90]) {
      const name = depthColumn(days);
      expect(rows.every((r) => r.values[name] === undefined)).toBe(true);
    }
    // The snapshot-derived columns are unaffected by missing metrics.
    expect(rows.some((r) => Number.isFinite(r.values[fundingColumn(30)]))).toBe(true);
  });

  it('survives a symbol with no snapshots at all', () => {
    const rows = buildResearchColumns({
      candles, snapshots: [], metrics: metricsRows,
      interval: INTERVAL, symbol: SYMBOL, warmupBars: WARMUP(),
    });
    expect(rows).toHaveLength(BAR_COUNT);
    expect(rows.every((r) => r.values[fundingColumn(30)] === undefined)).toBe(true);
    expect(rows.some((r) => Number.isFinite(r.values[depthColumn(30)]))).toBe(true);
  });
});

describe('vwapDevZ', () => {
  const DAY_START = Date.UTC(2024, 0, 1);
  const HOUR_MS = 60 * 60 * 1000;

  /** Independent re-implementation of the cumulative UTC-day VWAP deviation
   * (research-columns.ts's computeVwapDevRaw), so the test does not simply
   * call the module under test to build its own expectation. */
  function handVwapDevRaw(bars: OHLCV[]): number[] {
    let day = NaN;
    let cumPV = 0;
    let cumV = 0;
    const out: number[] = [];
    for (const bar of bars) {
      const thisDay = Math.floor(bar.timestamp / DAY_MS);
      if (thisDay !== day) {
        day = thisDay;
        cumPV = 0;
        cumV = 0;
      }
      const typicalPrice = (bar.high + bar.low + bar.close) / 3;
      cumPV += typicalPrice * bar.volume;
      cumV += bar.volume;
      out.push(cumV > 0 ? (bar.close - cumPV / cumV) / (cumPV / cumV) : NaN);
    }
    return out;
  }

  it('resets at the UTC day boundary and matches a hand VWAP on a two-day fixture', () => {
    const closesDay1 = [100, 101, 99, 102, 98, 103];
    const volsDay1 = [10, 20, 15, 5, 25, 10];
    const closesDay2 = [200, 202, 198, 204, 196, 206];
    const volsDay2 = [12, 18, 22, 8, 14, 26];

    const bars: OHLCV[] = [];
    for (let i = 0; i < 6; i++) {
      bars.push(flatCandle(DAY_START + i * HOUR_MS, closesDay1[i], volsDay1[i]));
    }
    for (let i = 0; i < 6; i++) {
      bars.push(flatCandle(DAY_START + DAY_MS + i * HOUR_MS, closesDay2[i], volsDay2[i]));
    }

    const handRaw = handVwapDevRaw(bars);
    // Proves the reset actually happened: day 2's own cumulative VWAP must
    // differ from what it would be if day 1's sums had carried over (day 2's
    // prices are roughly double day 1's, so a carried-over VWAP would put
    // every day-2 deviation far from what a fresh day 2 VWAP gives).
    expect(handRaw[6]).toBeCloseTo((closesDay2[0] - closesDay2[0]) / closesDay2[0], 10); // first bar of day 2: VWAP == its own close
    expect(handRaw[6]).not.toBeCloseTo(handRaw[5], 6);

    const windowBars = windowBarsForDays(30, '1h');
    const expectedZ = trailingZScore(Float64Array.from(handRaw), windowBars, Z_MIN_SAMPLES);

    const rows = buildResearchColumns({
      candles: bars, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });

    for (let i = 1; i < bars.length; i++) {
      const emitted = rows[i].values.vwapDevZ;
      if (Number.isFinite(expectedZ[i - 1])) {
        expect(emitted, `bar ${i}`).toBeCloseTo(expectedZ[i - 1], 10);
      } else {
        expect(emitted, `bar ${i}`).toBeUndefined();
      }
    }
    expect(rows[0].values.vwapDevZ).toBeUndefined();
  });

  it('is NaN at 1d', () => {
    const bars: OHLCV[] = Array.from({ length: 40 }, (_, i) =>
      flatCandle(DAY_START + i * DAY_MS, 100 + i, 10 + i)
    );
    const rows = buildResearchColumns({
      candles: bars, snapshots: [], metrics: [], interval: '1d', symbol: 'ETHUSDT', warmupBars: 0,
    });
    expect(rows.every((r) => r.values.vwapDevZ === undefined)).toBe(true);
  });
});

describe('pocDist / outsideValue', () => {
  const DAY_START = Date.UTC(2024, 0, 1);
  const HOUR_MS = 60 * 60 * 1000;
  // Day d-1's profile: bucket 101 is the POC (volume 50). Expanding from it,
  // bucket 102 (12) beats bucket 100 (8) so the area grows up first, then
  // bucket 103 (9) still beats bucket 100 (8) so it grows up again -- both
  // steps decided by a clear inequality, not a tie, so the result does not
  // depend on how ties are broken. 50+12+9 = 71 >= 70% of 100.
  const PRIOR_DAY_BUCKETS = [100, 101, 102, 103, 104, 105];
  const PRIOR_DAY_VOLUMES = [8, 50, 12, 9, 11, 10];
  const POC_BUCKET = 101;
  const VAL_BUCKET = 101; // bottom never moves
  const VAH_TOP_BUCKET = 103; // top ends here; VAH is its upper edge

  function buildPriorDay(startMs: number): OHLCV[] {
    return PRIOR_DAY_BUCKETS.map((bucket, i) =>
      flatCandle(startMs + i * HOUR_MS, bucketMidPrice(bucket), PRIOR_DAY_VOLUMES[i])
    );
  }

  it("pocDist is 0 when the close sits on the prior day's POC and outsideValue reads +1/-1/0 against a hand value area", () => {
    const priorDay = buildPriorDay(DAY_START);
    const poc = (bucketEdge(POC_BUCKET) + bucketEdge(POC_BUCKET + 1)) / 2;
    const val = bucketEdge(VAL_BUCKET);
    const vah = bucketEdge(VAH_TOP_BUCKET + 1);
    const range = bucketMidPrice(105) - bucketMidPrice(100);

    const dayD = [
      flatCandle(DAY_START + DAY_MS + 0 * HOUR_MS, poc, 5), // on the POC
      flatCandle(DAY_START + DAY_MS + 1 * HOUR_MS, vah * 1.0005, 5), // just above VAH
      flatCandle(DAY_START + DAY_MS + 2 * HOUR_MS, val * 0.9995, 5), // just below VAL
      flatCandle(DAY_START + DAY_MS + 3 * HOUR_MS, bucketMidPrice(102), 5), // inside, not POC
      flatCandle(DAY_START + DAY_MS + 4 * HOUR_MS, 1, 1), // dummy landing bar for the shift
    ];
    const bars = [...priorDay, ...dayD];

    const rows = buildResearchColumns({
      candles: bars, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });

    // Shifted forward one bar: dayD[0] (index 6) lands at row 7, etc.
    expect(rows[7].values.pocDist).toBeCloseTo(0, 10);
    expect(rows[7].values.outsideValue).toBe(0);
    expect(rows[8].values.outsideValue).toBe(1);
    expect(rows[9].values.outsideValue).toBe(-1);
    expect(rows[10].values.outsideValue).toBe(0);

    // pocDist sanity: matches (close - poc) / range directly for the VAH bar too.
    const expectedPocDistBarB = (dayD[1].close - poc) / range;
    expect(rows[8].values.pocDist).toBeCloseTo(expectedPocDistBarB, 10);
  });

  it('pocDist ignores the current day\'s bars', () => {
    const priorDay = buildPriorDay(DAY_START);
    const poc = (bucketEdge(POC_BUCKET) + bucketEdge(POC_BUCKET + 1)) / 2;

    // Variant 1: day d = [barA, dummy].
    const variant1 = [
      ...priorDay,
      flatCandle(DAY_START + DAY_MS + 0 * HOUR_MS, poc, 5),
      flatCandle(DAY_START + DAY_MS + 1 * HOUR_MS, 1, 1),
    ];
    // Variant 2: day d = [huge outlier bar, barA, dummy] -- an extra bar
    // with an enormous volume at a wildly different price inserted BEFORE
    // barA. If pocDist/outsideValue ever read the current day's own bars,
    // this outlier would change barA's computed profile.
    const variant2 = [
      ...priorDay,
      flatCandle(DAY_START + DAY_MS + 0 * HOUR_MS, 100000, 999999),
      flatCandle(DAY_START + DAY_MS + 1 * HOUR_MS, poc, 5),
      flatCandle(DAY_START + DAY_MS + 2 * HOUR_MS, 1, 1),
    ];

    const rows1 = buildResearchColumns({
      candles: variant1, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });
    const rows2 = buildResearchColumns({
      candles: variant2, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });

    // barA is at index 6 in variant1 (shifted to row 7) and index 7 in
    // variant2 (shifted to row 8).
    expect(rows1[7].values.pocDist).toBeCloseTo(0, 10);
    expect(rows2[8].values.pocDist).toBeCloseTo(0, 10);
    expect(rows2[8].values.pocDist).toBeCloseTo(rows1[7].values.pocDist!, 10);
    expect(rows2[8].values.outsideValue).toBe(rows1[7].values.outsideValue);
  });
});

describe('sweepReversal20 / sweepReversal50', () => {
  const START = Date.UTC(2024, 0, 1);
  const HOUR_MS = 60 * 60 * 1000;

  /** windowBars flat bars (low=100, high=110), then one bar appended whose
   * own low/high/close is given -- exactly what computeSweepReversalRaw
   * reads as bar i's prior window and bar i itself. */
  function buildWindowFixture(windowBars: number, bar: { low: number; high: number; close: number }): OHLCV[] {
    const bars: OHLCV[] = [];
    for (let i = 0; i < windowBars; i++) {
      bars.push(flatCandle(START + i * HOUR_MS, 105, 10));
    }
    bars[bars.length - 1] = { ...bars[bars.length - 1], high: 110, low: 100 };
    // Make every prior bar span [100,110] so priorLow=100, priorHigh=110
    // regardless of which one the window actually reads.
    for (let i = 0; i < bars.length; i++) bars[i] = { ...bars[i], high: 110, low: 100, close: 105 };
    bars.push({
      timestamp: START + windowBars * HOUR_MS,
      open: bar.close, high: bar.high, low: bar.low, close: bar.close, volume: 10,
    });
    // One more bar so the shift has somewhere to land.
    bars.push({
      timestamp: START + (windowBars + 1) * HOUR_MS,
      open: 105, high: 110, low: 100, close: 105, volume: 10,
    });
    return bars;
  }

  it('is +1 on a low sweep that closes back above, -1 mirrored, 0 on an outside bar', () => {
    const lowSweep = buildWindowFixture(20, { low: 95, high: 105, close: 103 });
    const rowsLow = buildResearchColumns({
      candles: lowSweep, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });
    // Bar at index 20 (the sweep bar) shifts to row 21.
    expect(rowsLow[21].values.sweepReversal20).toBe(1);

    const highSweep = buildWindowFixture(20, { low: 102, high: 115, close: 104 });
    const rowsHigh = buildResearchColumns({
      candles: highSweep, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });
    expect(rowsHigh[21].values.sweepReversal20).toBe(-1);

    const outsideBar = buildWindowFixture(20, { low: 90, high: 120, close: 105 });
    const rowsOutside = buildResearchColumns({
      candles: outsideBar, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });
    // close=105 is inside (100,110) so both the low-sweep and high-sweep
    // reclaim conditions fire; summed they net 0.
    expect(rowsOutside[21].values.sweepReversal20).toBe(0);
  });

  it('is NaN for i < N', () => {
    const bars = buildWindowFixture(20, { low: 95, high: 105, close: 103 });
    const rows = buildResearchColumns({
      candles: bars.slice(0, 15), snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });
    expect(rows.every((r) => r.values.sweepReversal20 === undefined)).toBe(true);
  });
});

describe('bosBreak', () => {
  const START = Date.UTC(2024, 0, 1);
  const HOUR_MS = 60 * 60 * 1000;

  function flat(i: number, high = 100, low = 90, close = 95): OHLCV {
    return { timestamp: START + i * HOUR_MS, open: close, high, low, close, volume: 10 };
  }

  it('fires only after the swing is confirmed by two later bars', () => {
    // Bars 0..4 flat. Bar 5 is a swing high (110, strictly above bars 3,4,6,7).
    // Confirmed at bar 5+2=7. Bar 8's close crosses above 110 for the first
    // time -- that is the earliest bar bosBreak can read a confirmed swing
    // high and see a fresh cross, so (after the one-bar shift) row 9 is the
    // first row that can read +1.
    const bars: OHLCV[] = [];
    for (let i = 0; i <= 4; i++) bars.push(flat(i));
    bars.push(flat(5, 110, 90, 95)); // the swing high bar itself
    for (let i = 6; i <= 7; i++) bars.push(flat(i, 100, 90, 95)); // confirms it at bar 7
    bars.push(flat(8, 115, 111, 112)); // close 112 > 110 for the first time
    for (let i = 9; i <= 11; i++) bars.push(flat(i, 115, 111, 112)); // stays above; must not re-fire

    const rows = buildResearchColumns({
      candles: bars, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });

    // Nothing confirmed yet through bar 7 (as-of bar i-1 for i <= 7): NaN.
    for (let i = 0; i <= 7; i++) {
      expect(rows[i].values.bosBreak, `row ${i}`).toBeUndefined();
    }
    // Bar 8 is the break bar (shifted to row 9): +1.
    expect(rows[9].values.bosBreak).toBe(1);
    // Bars 9..11 stay above 110 without a fresh cross: 0, not another +1.
    expect(rows[10].values.bosBreak).toBe(0);
    expect(rows[11].values.bosBreak).toBe(0);
  });
});

describe('volRatio', () => {
  const START = Date.UTC(2024, 0, 1);
  const HOUR_MS = 60 * 60 * 1000;

  function makeReturnsCandles(returns: number[]): OHLCV[] {
    const bars: OHLCV[] = [];
    let price = 100;
    bars.push(flatCandle(START, price, 10));
    for (let i = 0; i < returns.length; i++) {
      price = price * Math.exp(returns[i]);
      bars.push(flatCandle(START + (i + 1) * HOUR_MS, price, 10));
    }
    return bars;
  }

  /** Sample standard deviation (ddof 1) over the last `windowBars` log
   * returns ending at (and including) `endIndex` of `logReturns`, matching
   * research-columns.ts's trailingFullStd. */
  function handStd(logReturns: number[], endIndex: number, windowBars: number): number {
    const slice = logReturns.slice(endIndex - windowBars + 1, endIndex + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / (slice.length - 1);
    return Math.sqrt(variance);
  }

  it('is the hand ratio of the two realised vols', () => {
    // Deterministic LCG, same pattern as the rest of this file.
    let rng = 777;
    const next = () => {
      rng = (rng * 16807) % 2147483647;
      return rng / 2147483647;
    };
    const returns = Array.from({ length: 220 }, () => (next() - 0.5) * 0.02);
    const bars = makeReturnsCandles(returns);

    const logReturns: number[] = [NaN];
    for (let i = 1; i < bars.length; i++) {
      logReturns.push(Math.log(bars[i].close / bars[i - 1].close));
    }

    const rows = buildResearchColumns({
      candles: bars, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });

    // Check a handful of bars deep enough for both the 24-bar and 168-bar
    // windows to be full (index >= 168).
    let compared = 0;
    for (const i of [168, 190, 210]) {
      const shortStd = handStd(logReturns, i, 24);
      const longStd = handStd(logReturns, i, 168);
      const expected = shortStd / longStd;
      // Shifted forward one bar.
      const emitted = rows[i + 1].values.volRatio;
      expect(emitted, `bar ${i}`).toBeCloseTo(expected, 8);
      compared++;
    }
    expect(compared).toBe(3);
  });

  it('is NaN throughout at 1d', () => {
    const bars: OHLCV[] = Array.from({ length: 250 }, (_, i) => flatCandle(START + i * DAY_MS, 100 + i, 10));
    const rows = buildResearchColumns({
      candles: bars, snapshots: [], metrics: [], interval: '1d', symbol: 'ETHUSDT', warmupBars: 0,
    });
    expect(rows.every((r) => r.values.volRatio === undefined)).toBe(true);
  });
});

describe('btcLeadLagZ', () => {
  const START = Date.UTC(2024, 0, 1);
  const HOUR_MS = 60 * 60 * 1000;

  function makeSeries(seed: number, count: number): OHLCV[] {
    let rng = seed;
    const next = () => {
      rng = (rng * 16807) % 2147483647;
      return rng / 2147483647;
    };
    const bars: OHLCV[] = [];
    let price = 100;
    for (let i = 0; i < count; i++) {
      price = price * (1 + (next() - 0.5) * 0.01);
      bars.push(flatCandle(START + i * HOUR_MS, price, 10));
    }
    return bars;
  }

  function toCandleRow(bar: OHLCV): CandleRow {
    return { t: bar.timestamp, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume, tbv: null };
  }

  it('joins BTC on timestamp and is NaN for BTCUSDT and without marketCandles', () => {
    const own = makeSeries(11, 60);
    const btc = makeSeries(22, 60).map(toCandleRow);
    // Remove BTC's bar at index 30 to create a join gap.
    const btcWithGap = btc.filter((_, i) => i !== 30);

    const rowsJoined = buildResearchColumns({
      candles: own, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
      marketCandles: btcWithGap,
    });
    // The gap at BTC index 30 means own bar 30's timestamp has no BTC match:
    // NaN there (shifted to row 31), while a neighbouring bar with a real
    // BTC match is finite.
    expect(rowsJoined[31].values.btcLeadLagZ).toBeUndefined();

    const rowsNoBtcArg = buildResearchColumns({
      candles: own, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
      marketCandles: null,
    });
    expect(rowsNoBtcArg.every((r) => r.values.btcLeadLagZ === undefined)).toBe(true);

    const rowsBtcSymbol = buildResearchColumns({
      candles: own, snapshots: [], metrics: [], interval: '1h', symbol: 'BTCUSDT', warmupBars: 0,
      marketCandles: btc,
    });
    expect(rowsBtcSymbol.every((r) => r.values.btcLeadLagZ === undefined)).toBe(true);
  });

  it('matches a hand join-and-z computation on a full BTC series', () => {
    const own = makeSeries(11, 260);
    const btcOhlc = makeSeries(22, 260);
    const btc = btcOhlc.map(toCandleRow);

    const btcRet1ByTimestamp = new Map<number, number>();
    for (let j = 1; j < btc.length; j++) {
      btcRet1ByTimestamp.set(btc[j].t, (btc[j].c - btc[j - 1].c) / btc[j - 1].c);
    }
    const raw = new Array<number>(own.length).fill(NaN);
    for (let i = 1; i < own.length; i++) {
      const btcRet1 = btcRet1ByTimestamp.get(own[i].timestamp);
      if (btcRet1 === undefined) continue;
      const ownRet1 = (own[i].close - own[i - 1].close) / own[i - 1].close;
      raw[i] = btcRet1 - ownRet1;
    }
    const expectedZ = trailingZScore(Float64Array.from(raw), windowBarsForDays(30, '1h'), Z_MIN_SAMPLES);

    const rows = buildResearchColumns({
      candles: own, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
      marketCandles: btc,
    });

    let compared = 0;
    for (let i = 1; i < own.length; i++) {
      const emitted = rows[i].values.btcLeadLagZ;
      if (Number.isFinite(expectedZ[i - 1])) {
        expect(emitted, `bar ${i}`).toBeCloseTo(expectedZ[i - 1], 10);
        compared++;
      } else {
        expect(emitted, `bar ${i}`).toBeUndefined();
      }
    }
    expect(compared).toBeGreaterThan(100);
  });
});

describe('shift: every new column reads the previous bar', () => {
  it('sweepReversal20 at row i equals a hand recomputation of the unshifted value at i-1', () => {
    const START = Date.UTC(2024, 0, 1);
    const HOUR_MS = 60 * 60 * 1000;
    const bars: OHLCV[] = [];
    for (let i = 0; i < 30; i++) {
      bars.push({ timestamp: START + i * HOUR_MS, open: 100, high: 110, low: 100, close: 105, volume: 10 });
    }
    // A low sweep at bar 25.
    bars[25] = { ...bars[25], low: 90, high: 105, close: 103 };

    const rows = buildResearchColumns({
      candles: bars, snapshots: [], metrics: [], interval: '1h', symbol: 'ETHUSDT', warmupBars: 0,
    });

    function handUnshifted(i: number): number {
      let priorLow = Infinity;
      let priorHigh = -Infinity;
      for (let k = i - 20; k < i; k++) {
        if (bars[k].low < priorLow) priorLow = bars[k].low;
        if (bars[k].high > priorHigh) priorHigh = bars[k].high;
      }
      let value = 0;
      if (bars[i].low < priorLow && bars[i].close > priorLow) value += 1;
      if (bars[i].high > priorHigh && bars[i].close < priorHigh) value -= 1;
      return value;
    }

    for (const i of [21, 26, 27, 29]) {
      const expected = handUnshifted(i - 1);
      const emitted = rows[i].values.sweepReversal20;
      expect(emitted ?? 0, `row ${i}`).toBe(expected);
    }
  });
});

describe('windowBarsForDays', () => {
  it('matches the factors.ts conversion', () => {
    expect(windowBarsForDays(30, '1h')).toBe(720);
    expect(windowBarsForDays(30, '15m')).toBe(2880);
    expect(windowBarsForDays(90, '4h')).toBe(540);
    expect(windowBarsForDays(30, '1d')).toBe(30);
  });

  it('floors at one bar', () => {
    expect(windowBarsForDays(0, '1d')).toBe(1);
  });
});

describe('toOHLCV round trip', () => {
  it('keeps the candle grid the columns are keyed on', () => {
    expect(toOHLCV(candleRows[0]).timestamp).toBe(candles[0].timestamp);
  });
});
