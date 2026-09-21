// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildResearchSeries, researchValue, type ResearchRow } from './research-series';
import type { OHLCV } from '@/types/market';

const HOUR = 3600000;
const T0 = 1700000000000;

function candles(n: number, startIndex = 0): OHLCV[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: T0 + (startIndex + i) * HOUR,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
}

function rows(n: number, valueAt: (i: number) => Record<string, number>): ResearchRow[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: T0 + i * HOUR,
    values: valueAt(i),
  }));
}

describe('buildResearchSeries', () => {
  it('joins on an exact open-time match', () => {
    const c = candles(5);
    const r = rows(5, (i) => ({ fundingZ: i / 10 }));
    const series = buildResearchSeries(c, r);
    expect(series).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect(series[i]?.fundingZ).toBeCloseTo(i / 10, 12);
  });

  it('selects the right sub-range when the candles are a slice', () => {
    // This is the whole point of the module: a window prepared from a slice
    // must see the same column values the full series produced, not a
    // recomputed shorter one.
    const full = candles(100);
    const r = rows(100, (i) => ({ depthZ30d: Math.sin(i) }));
    const fullSeries = buildResearchSeries(full, r);

    const slice = full.slice(40, 70);
    const sliceSeries = buildResearchSeries(slice, r);
    expect(sliceSeries).toHaveLength(30);
    for (let i = 0; i < 30; i++) {
      expect(sliceSeries[i]?.depthZ30d).toBe(fullSeries[40 + i]?.depthZ30d);
    }
  });

  it('leaves a candle with no row null rather than carrying the previous one', () => {
    const c = candles(5);
    const r = rows(5, (i) => ({ x: i })).filter((_, i) => i !== 2);
    const series = buildResearchSeries(c, r);
    expect(series[1]?.x).toBe(1);
    expect(series[2]).toBeNull();
    expect(series[3]?.x).toBe(3);
  });

  it('drops a row whose timestamp matches no candle', () => {
    const c = candles(3);
    const r: ResearchRow[] = [
      { timestamp: T0, values: { x: 0 } },
      { timestamp: T0 + HOUR / 2, values: { x: 99 } }, // off-grid
      { timestamp: T0 + HOUR, values: { x: 1 } },
      { timestamp: T0 + 2 * HOUR, values: { x: 2 } },
    ];
    const series = buildResearchSeries(c, r);
    expect(series.map((b) => b?.x)).toEqual([0, 1, 2]);
  });

  it('returns all null for no rows', () => {
    const series = buildResearchSeries(candles(4), []);
    expect(series).toEqual([null, null, null, null]);
  });

  it('handles candles that start before and end after the rows', () => {
    const c = candles(10, -2); // two bars before the first row
    const r = rows(3, (i) => ({ x: i }));
    const series = buildResearchSeries(c, r);
    expect(series[0]).toBeNull();
    expect(series[1]).toBeNull();
    expect(series[2]?.x).toBe(0);
    expect(series[4]?.x).toBe(2);
    expect(series[5]).toBeNull();
  });

  it('rejects unsorted rows rather than mis-joining them', () => {
    const c = candles(3);
    const r: ResearchRow[] = [
      { timestamp: T0 + 2 * HOUR, values: { x: 2 } },
      { timestamp: T0, values: { x: 0 } },
    ];
    expect(() => buildResearchSeries(c, r)).toThrow(/sorted ascending/);
  });
});

describe('researchValue', () => {
  it('returns the column reading', () => {
    const series = buildResearchSeries(candles(3), rows(3, (i) => ({ a: i, b: -i })));
    expect(researchValue(series, 2, 'a')).toBe(2);
    expect(researchValue(series, 2, 'b')).toBe(-2);
  });

  it('returns NaN and never 0 for a null bar or an absent column', () => {
    const series = buildResearchSeries(candles(3), rows(3, (i): Record<string, number> => (i === 1 ? {} : { a: i })));
    expect(researchValue(series, 1, 'a')).toBeNaN();
    expect(researchValue(series, 0, 'missing')).toBeNaN();
    const empty = buildResearchSeries(candles(3), []);
    expect(researchValue(empty, 0, 'a')).toBeNaN();
  });

  it('returns NaN for a non-finite stored value', () => {
    const series = buildResearchSeries(candles(2), [
      { timestamp: T0, values: { a: Number.NaN } },
      { timestamp: T0 + HOUR, values: { a: Number.POSITIVE_INFINITY } },
    ]);
    expect(researchValue(series, 0, 'a')).toBeNaN();
    expect(researchValue(series, 1, 'a')).toBeNaN();
  });

  it('distinguishes a real zero reading from a missing one', () => {
    const series = buildResearchSeries(candles(1), [{ timestamp: T0, values: { a: 0 } }]);
    expect(researchValue(series, 0, 'a')).toBe(0);
    expect(researchValue(series, 0, 'b')).toBeNaN();
  });
});
