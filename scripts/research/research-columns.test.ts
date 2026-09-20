// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';
import type { CandleRow, HtfRow, MetricsRow, SnapshotRow } from './dataset-format';
import { computeFactorMatrix, toLeanSnapshot, toOHLCV, trailingZScore, type FactorMatrix } from './factors';
import {
  RESEARCH_COLUMNS,
  buildResearchColumns,
  depthColumn,
  fundingColumn,
  positioningColumn,
  windowBarsForDays,
} from './research-columns';

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
      for (const name of [fundingColumn(30), positioningColumn(360), depthColumn(30)]) {
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
