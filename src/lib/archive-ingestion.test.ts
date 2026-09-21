// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  METRICS_SLOT_MS,
  aggregateBookDepth,
  alignToBars,
  barGrid,
  buildMetricsSnapshotPatches,
  depthUpserts,
  enumerateDays,
  enumerateMonths,
  metricsUpserts,
  perpCandleUpserts,
  perpPairsForSeries,
  PERP_DATASET_SERIES,
} from './archive-ingestion';
import type { BookDepthSnapshot, KlineCsvRow, MetricsCsvRow } from './external/binance-archive';

const HOUR = 60 * 60 * 1000;

function metricsRow(timestamp: number, over: Partial<MetricsCsvRow> = {}): MetricsCsvRow {
  return {
    timestamp,
    openInterest: 100,
    openInterestValue: 1_000_000,
    topTraderAccountRatio: 1.2,
    topTraderPositionRatio: 1.5,
    globalAccountRatio: 2,
    takerLongShortRatio: 0.9,
    ...over,
  };
}

function depthSnapshot(
  timestamp: number,
  levels: Record<number, number>
): BookDepthSnapshot {
  const notional = new Map<number, number>();
  const depth = new Map<number, number>();
  for (const [pct, value] of Object.entries(levels)) {
    notional.set(Number(pct), value);
    depth.set(Number(pct), value / 1000);
  }
  return { timestamp, notional, depth };
}

describe('enumerateDays', () => {
  it('is inclusive of both ends', () => {
    expect(enumerateDays(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 3))).toEqual([
      '2025-01-01',
      '2025-01-02',
      '2025-01-03',
    ]);
  });

  it('returns a single day when both bounds land inside it', () => {
    expect(enumerateDays(Date.UTC(2025, 0, 1, 3), Date.UTC(2025, 0, 1, 22))).toEqual(['2025-01-01']);
  });

  it('crosses a year boundary', () => {
    expect(enumerateDays(Date.UTC(2024, 11, 31), Date.UTC(2025, 0, 1))).toEqual([
      '2024-12-31',
      '2025-01-01',
    ]);
  });

  it('includes the leap day', () => {
    expect(enumerateDays(Date.UTC(2024, 1, 28), Date.UTC(2024, 2, 1))).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
  });

  it('returns nothing when the range runs backwards', () => {
    expect(enumerateDays(Date.UTC(2025, 0, 3), Date.UTC(2025, 0, 1))).toEqual([]);
  });
});

describe('enumerateMonths', () => {
  it('is inclusive of both ends', () => {
    expect(enumerateMonths(Date.UTC(2025, 0, 15), Date.UTC(2025, 2, 2))).toEqual([
      '2025-01',
      '2025-02',
      '2025-03',
    ]);
  });

  it('crosses a year boundary', () => {
    expect(enumerateMonths(Date.UTC(2024, 10, 1), Date.UTC(2025, 1, 1))).toEqual([
      '2024-11',
      '2024-12',
      '2025-01',
      '2025-02',
    ]);
  });

  it('returns one month when both bounds are inside it', () => {
    expect(enumerateMonths(Date.UTC(2025, 5, 2), Date.UTC(2025, 5, 28))).toEqual(['2025-06']);
  });

  it('returns nothing when the range runs backwards', () => {
    expect(enumerateMonths(Date.UTC(2025, 5, 1), Date.UTC(2025, 3, 1))).toEqual([]);
  });
});

describe('aggregateBookDepth', () => {
  const slot = Date.UTC(2025, 5, 2, 0, 0, 0);

  it('buckets snapshots into the 5m slot that contains them', () => {
    const slots = aggregateBookDepth([
      depthSnapshot(slot + 10_000, { '-1': 100, 1: 300 }),
      depthSnapshot(slot + 40_000, { '-1': 100, 1: 300 }),
      depthSnapshot(slot + METRICS_SLOT_MS + 1000, { '-1': 300, 1: 100 }),
    ]);
    expect(slots).toHaveLength(2);
    expect(slots[0].timestamp).toBe(slot);
    expect(slots[0].depthSamples).toBe(2);
    expect(slots[1].timestamp).toBe(slot + METRICS_SLOT_MS);
    expect(slots[1].depthSamples).toBe(1);
  });

  it('averages the imbalance across the snapshots in a slot', () => {
    const slots = aggregateBookDepth([
      depthSnapshot(slot, { '-1': 100, 1: 300 }), // -0.5
      depthSnapshot(slot + 30_000, { '-1': 300, 1: 100 }), // +0.5
    ]);
    expect(slots[0].depthImbalance1).toBeCloseTo(0, 10);
    expect(slots[0].depthNotional1).toBe(400);
  });

  it('leaves a band null when no snapshot could price it, never zero', () => {
    const slots = aggregateBookDepth([depthSnapshot(slot, { '-1': 100, 1: 300 })]);
    expect(slots[0].depthImbalance1).toBeCloseTo(-0.5, 10);
    expect(slots[0].depthImbalance2).toBeNull();
    expect(slots[0].depthImbalance5).toBeNull();
    expect(slots[0].depthNotional5).toBeNull();
  });

  it('averages a band only over the snapshots that carried both of its sides', () => {
    const slots = aggregateBookDepth([
      depthSnapshot(slot, { '-1': 100, 1: 300 }), // -0.5, counted
      depthSnapshot(slot + 30_000, { '-1': 100 }), // one-sided, not counted
    ]);
    expect(slots[0].depthImbalance1).toBeCloseTo(-0.5, 10);
    expect(slots[0].depthSamples).toBe(2);
  });

  it('returns slots in ascending order regardless of input order', () => {
    const slots = aggregateBookDepth([
      depthSnapshot(slot + 2 * METRICS_SLOT_MS, { '-1': 1, 1: 1 }),
      depthSnapshot(slot, { '-1': 1, 1: 1 }),
      depthSnapshot(slot + METRICS_SLOT_MS, { '-1': 1, 1: 1 }),
    ]);
    expect(slots.map((s) => s.timestamp)).toEqual([
      slot,
      slot + METRICS_SLOT_MS,
      slot + 2 * METRICS_SLOT_MS,
    ]);
  });
});

describe('metricsUpserts', () => {
  it('keys on symbol and timestamp and sets every finite measure', () => {
    const ops = metricsUpserts('BTCUSDT', [metricsRow(1000)]);
    expect(ops).toHaveLength(1);
    expect(ops[0].filter).toEqual({ symbol: 'BTCUSDT', timestamp: 1000 });
    expect(ops[0].set).toEqual({
      openInterest: 100,
      openInterestValue: 1_000_000,
      topTraderAccountRatio: 1.2,
      topTraderPositionRatio: 1.5,
      globalAccountRatio: 2,
      takerLongShortRatio: 0.9,
    });
  });

  it('omits a null field rather than writing zero', () => {
    const ops = metricsUpserts('BTCUSDT', [metricsRow(1000, { openInterest: null, takerLongShortRatio: null })]);
    expect(ops[0].set).not.toHaveProperty('openInterest');
    expect(ops[0].set).not.toHaveProperty('takerLongShortRatio');
    expect(ops[0].set.globalAccountRatio).toBe(2);
  });

  it('keeps a genuine zero, which is not the same as missing', () => {
    const ops = metricsUpserts('BTCUSDT', [metricsRow(1000, { takerLongShortRatio: 0 })]);
    expect(ops[0].set.takerLongShortRatio).toBe(0);
  });

  it('drops a row with no usable measure at all', () => {
    const empty = metricsRow(1000, {
      openInterest: null,
      openInterestValue: null,
      topTraderAccountRatio: null,
      topTraderPositionRatio: null,
      globalAccountRatio: null,
      takerLongShortRatio: null,
    });
    expect(metricsUpserts('BTCUSDT', [empty])).toEqual([]);
  });
});

describe('depthUpserts', () => {
  it('writes the depth fields for a slot', () => {
    const ops = depthUpserts('BTCUSDT', [
      {
        timestamp: 5000,
        depthImbalance1: -0.5,
        depthImbalance2: null,
        depthImbalance5: 0.1,
        depthNotional1: 400,
        depthNotional5: null,
        depthSamples: 3,
      },
    ]);
    expect(ops[0].filter).toEqual({ symbol: 'BTCUSDT', timestamp: 5000 });
    expect(ops[0].set).toEqual({
      depthImbalance1: -0.5,
      depthImbalance5: 0.1,
      depthNotional1: 400,
      depthSamples: 3,
    });
  });

  it('writes nothing for a slot that carries only a sample count', () => {
    expect(
      depthUpserts('BTCUSDT', [
        {
          timestamp: 5000,
          depthImbalance1: null,
          depthImbalance2: null,
          depthImbalance5: null,
          depthNotional1: null,
          depthNotional5: null,
          depthSamples: 4,
        },
      ])
    ).toEqual([]);
  });
});

describe('perpCandleUpserts', () => {
  const row: KlineCsvRow = {
    timestamp: 1635724800000,
    open: 61347.14,
    high: 61447.27,
    low: 61129.9,
    close: 61290.31,
    volume: 1705.548,
    quoteVolume: 104522700.64749,
    trades: 14001,
    takerBuyVolume: 638.68,
  };

  it('keys on symbol, interval, series and bar', () => {
    const ops = perpCandleUpserts('BTCUSDT', '5m', 'klines', [row]);
    expect(ops[0].filter).toEqual({
      symbol: 'BTCUSDT',
      interval: '5m',
      series: 'klines',
      timestamp: 1635724800000,
    });
    expect(ops[0].set.takerBuyVolume).toBe(638.68);
  });

  it('leaves takerBuyVolume unset when the archive had none', () => {
    const ops = perpCandleUpserts('BTCUSDT', '5m', 'premiumIndex', [{ ...row, takerBuyVolume: null }]);
    expect(ops[0].set).not.toHaveProperty('takerBuyVolume');
    expect(ops[0].set.close).toBe(61290.31);
  });
});

describe('alignToBars', () => {
  const sources = [
    { timestamp: 0, v: 'a' },
    { timestamp: 10, v: 'b' },
    { timestamp: 25, v: 'c' },
  ];

  it('takes the last source at or before each target', () => {
    const aligned = alignToBars([5, 10, 24, 30], sources, 1000);
    expect(aligned.map((r) => r?.v ?? null)).toEqual(['a', 'b', 'b', 'c']);
  });

  it('includes a source landing exactly on the target', () => {
    expect(alignToBars([10], sources, 1000)[0]?.v).toBe('b');
  });

  it('returns null before the first source', () => {
    expect(alignToBars([-1], sources, 1000)[0]).toBeNull();
  });

  it('refuses to carry a reading past the staleness cap', () => {
    // Target 30 is 5 ms after source c, target 100 is 75 ms after it.
    const aligned = alignToBars([30, 100], sources, 10);
    expect(aligned[0]?.v).toBe('c');
    expect(aligned[1]).toBeNull();
  });

  it('never reads a source that postdates the target', () => {
    // The no-lookahead property: dropping every source after a target must not
    // change what that target aligns to.
    const targets = [5, 12, 26, 40];
    const full = alignToBars(targets, sources, 1000);
    for (let i = 0; i < targets.length; i++) {
      const truncated = sources.filter((s) => s.timestamp <= targets[i]);
      const partial = alignToBars([targets[i]], truncated, 1000);
      expect(partial[0]?.timestamp ?? null).toBe(full[i]?.timestamp ?? null);
    }
  });

  it('handles empty inputs', () => {
    expect(alignToBars([], sources, 1000)).toEqual([]);
    expect(alignToBars([1, 2], [], 1000)).toEqual([null, null]);
  });
});

describe('barGrid', () => {
  it('starts at the first bar at or after the lower bound', () => {
    const grid = barGrid(Date.UTC(2025, 0, 1, 0, 30), Date.UTC(2025, 0, 1, 3), '1h');
    expect(grid).toEqual([
      Date.UTC(2025, 0, 1, 1),
      Date.UTC(2025, 0, 1, 2),
      Date.UTC(2025, 0, 1, 3),
    ]);
  });

  it('returns an aligned bound unchanged as the first bar', () => {
    expect(barGrid(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 1, 1), '1h')).toEqual([
      Date.UTC(2025, 0, 1),
      Date.UTC(2025, 0, 1, 1),
    ]);
  });

  it('handles the daily interval', () => {
    expect(barGrid(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 3), '1d')).toHaveLength(3);
  });
});

describe('buildMetricsSnapshotPatches', () => {
  const bars = [Date.UTC(2025, 0, 1, 1), Date.UTC(2025, 0, 1, 2), Date.UTC(2025, 0, 1, 3)];

  it('fills longShortRatio from the top trader POSITION ratio, matching the live path', () => {
    // Every live caller goes through fetchLongShortRatio, which hits
    // /futures/data/topLongShortPositionRatio. Using the archive's global
    // account ratio here would put a different series in the same field.
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars: [bars[0]],
      metrics: [metricsRow(bars[0], { topTraderPositionRatio: 3, globalAccountRatio: 99 })],
    });
    expect(patches).toHaveLength(1);
    const ls = patches[0].data.longShortRatio!;
    expect(ls.ratio).toBe(3);
    expect(ls.longAccount).toBeCloseTo(0.75, 10);
    expect(ls.shortAccount).toBeCloseTo(0.25, 10);
    expect(ls.longAccount + ls.shortAccount).toBeCloseTo(1, 10);
    // The shares must reproduce the ratio they came from.
    expect(ls.longAccount / ls.shortAccount).toBeCloseTo(3, 10);
  });

  it('carries open interest as value and sumValue', () => {
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars: [bars[0]],
      metrics: [metricsRow(bars[0], { openInterest: 83624.198, openInterestValue: 8736988614.45 })],
    });
    expect(patches[0].data.openInterest).toEqual({ value: 83624.198, sumValue: 8736988614.45 });
  });

  it('stamps the patch at the bar, not at the metrics row', () => {
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars: [bars[0]],
      metrics: [metricsRow(bars[0] - 5 * 60 * 1000)],
    });
    expect(patches[0].timestamp).toBe(bars[0]);
    expect(patches[0].interval).toBe('1h');
    expect(patches[0].symbol).toBe('BTCUSDT');
  });

  it('never uses a metrics row published after the bar it stamps', () => {
    // A row five minutes into the bar must not reach the bar's own timestamp.
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars: [bars[0]],
      metrics: [metricsRow(bars[0] + 5 * 60 * 1000, { topTraderPositionRatio: 9 })],
    });
    expect(patches).toEqual([]);
  });

  it('skips bars the archive cannot reach rather than carrying a stale reading', () => {
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars,
      metrics: [metricsRow(bars[0])],
    });
    // Bar 0 is exact; bar 1 is one hour later, inside the 1h staleness cap;
    // bar 2 is two hours later and out of reach.
    expect(patches.map((p) => p.timestamp)).toEqual([bars[0], bars[1]]);
  });

  it('omits a field the archive had no value for', () => {
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars: [bars[0]],
      metrics: [metricsRow(bars[0], { openInterest: null })],
    });
    expect(patches[0].data.openInterest).toBeUndefined();
    expect(patches[0].data.longShortRatio).toBeDefined();
  });

  it('ignores the global account ratio entirely, which is its own research column', () => {
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars: [bars[0]],
      metrics: [metricsRow(bars[0], { topTraderPositionRatio: null, globalAccountRatio: 5, openInterest: null })],
    });
    expect(patches).toEqual([]);
  });

  it('drops a bar whose row carries neither measure', () => {
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars: [bars[0]],
      metrics: [metricsRow(bars[0], { openInterest: null, topTraderPositionRatio: null })],
    });
    expect(patches).toEqual([]);
  });

  it('rejects a non-positive ratio instead of dividing by it', () => {
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars: [bars[0]],
      metrics: [metricsRow(bars[0], { topTraderPositionRatio: 0, openInterest: null })],
    });
    expect(patches).toEqual([]);
  });

  it('walks a long series in one pass, matching a naive search', () => {
    const start = Date.UTC(2025, 0, 1);
    const metrics = Array.from({ length: 2000 }, (_, i) =>
      metricsRow(start + i * METRICS_SLOT_MS, { topTraderPositionRatio: 1 + i / 1000 })
    );
    const hourly = barGrid(start, start + 160 * HOUR, '1h');
    const patches = buildMetricsSnapshotPatches({
      symbol: 'BTCUSDT',
      interval: '1h',
      bars: hourly,
      metrics,
    });
    for (const patch of patches) {
      const expected = metrics.filter((m) => m.timestamp <= patch.timestamp).pop()!;
      expect(patch.data.longShortRatio!.ratio).toBe(expected.topTraderPositionRatio);
    }
    expect(patches.length).toBeGreaterThan(100);
  });
});

describe('PERP_DATASET_SERIES', () => {
  it('pairs each kline-shaped dataset with the series it writes', () => {
    // One literal per pair, because this is the pairing whose drift is
    // expensive: premiumIndex and klines rows carry the same timestamps, so
    // writing premium rows under series 'klines' would overwrite the traded
    // bars with premium values, and nothing in the live app reads this
    // collection, so nothing would notice.
    expect(PERP_DATASET_SERIES).toEqual([
      { dataset: 'klines', series: 'klines' },
      { dataset: 'premiumIndex', series: 'premiumIndex' },
      { dataset: 'markPrice', series: 'markPrice' },
    ]);
  });

  it('selects pairs for the requested series, in the requested order', () => {
    expect(perpPairsForSeries(['klines'])).toEqual([{ dataset: 'klines', series: 'klines' }]);
    expect(perpPairsForSeries(['premiumIndex'])).toEqual([
      { dataset: 'premiumIndex', series: 'premiumIndex' },
    ]);
    expect(perpPairsForSeries(['klines', 'premiumIndex']).map((p) => p.series)).toEqual([
      'klines',
      'premiumIndex',
    ]);
    expect(perpPairsForSeries([])).toEqual([]);
  });
});
