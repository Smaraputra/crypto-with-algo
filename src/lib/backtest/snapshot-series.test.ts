// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildSnapshotSeries,
  mapToSnapshotInterval,
  snapshotToScorerInputs,
  type LeanSnapshot,
  longShortZSeries,
} from './snapshot-series';
import type { OHLCV } from '@/types/market';

const HOUR = 60 * 60 * 1000;
const BASE = 1700000000000;

function makeCandles(count: number, intervalMs = HOUR): OHLCV[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: BASE + i * intervalMs,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
  }));
}

function makeSnapshot(timestamp: number, data: LeanSnapshot['data'] = {}): LeanSnapshot {
  return { timestamp, data } as LeanSnapshot;
}

const fullData: LeanSnapshot['data'] = {
  fundingRate: { rate: 0.0001, markPrice: 100 },
  longShortRatio: { ratio: 1.5, longAccount: 0.6, shortAccount: 0.4 },
  openInterest: { value: 1000, sumValue: 100000 },
  fearGreed: { index: 30, label: 'Fear' },
};

describe('mapToSnapshotInterval', () => {
  it('maps fine intervals to 1h (the finest ingested snapshot interval)', () => {
    expect(mapToSnapshotInterval('1m')).toBe('1h');
    expect(mapToSnapshotInterval('5m')).toBe('1h');
    expect(mapToSnapshotInterval('15m')).toBe('1h');
  });

  it('keeps snapshot-native intervals', () => {
    expect(mapToSnapshotInterval('1h')).toBe('1h');
    expect(mapToSnapshotInterval('4h')).toBe('4h');
    expect(mapToSnapshotInterval('1d')).toBe('1d');
  });
});

describe('snapshotToScorerInputs', () => {
  it('adapts stored fields to live scorer shapes', () => {
    const { futures, sentiment } = snapshotToScorerInputs(fullData, 'BTCUSDT', BASE);

    expect(futures).toEqual({
      fundingRate: { symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: BASE, markPrice: 100 },
      openInterest: null, // scorer does not consume openInterest
      longShortRatio: {
        symbol: 'BTCUSDT',
        longShortRatio: 1.5,
        longAccount: 0.6,
        shortAccount: 0.4,
        timestamp: BASE,
      },
    });
    expect(sentiment).toEqual({ fearGreedIndex: 30, label: 'Fear', news: null });
  });

  it('passes stored news sentiment through with Fear & Greed', () => {
    const { sentiment } = snapshotToScorerInputs(
      {
        fearGreed: { index: 55, label: 'Greed' },
        newsSentiment: { count: 7, avgSentiment: -0.25, topics: ['regulation'] },
      },
      'BTCUSDT',
      BASE
    );

    expect(sentiment).toEqual({
      fearGreedIndex: 55,
      label: 'Greed',
      news: { count: 7, avgSentiment: -0.25 },
    });
  });

  it('produces partial futures when only funding exists', () => {
    const { futures, sentiment } = snapshotToScorerInputs(
      { fundingRate: { rate: -0.002, markPrice: 99 } },
      'ETHUSDT',
      BASE
    );

    expect(futures!.fundingRate!.fundingRate).toBe(-0.002);
    expect(futures!.longShortRatio).toBeNull();
    expect(sentiment).toBeNull();
  });

  it('returns nulls for an empty snapshot', () => {
    const { futures, sentiment } = snapshotToScorerInputs({}, 'BTCUSDT', BASE);
    expect(futures).toBeNull();
    expect(sentiment).toBeNull();
  });
});

describe('buildSnapshotSeries', () => {
  it('reads a snapshot only from the bar AFTER the one it was captured in', () => {
    // A snapshot stamped T holds a reading captured anywhere in [T, T+interval):
    // the 1h ingest cron runs */15 and every run floors to the same hour, with
    // the last one winning, so the row stamped 12:00 routinely holds 12:45 data.
    // It is therefore knowable at 13:00 and not before.
    const candles = makeCandles(3);
    const snapshots = [
      makeSnapshot(BASE, fullData),
      makeSnapshot(BASE + HOUR, fullData),
      makeSnapshot(BASE + 2 * HOUR, fullData),
    ];

    const bars = buildSnapshotSeries(candles, snapshots, '1h', { symbol: 'BTCUSDT' });

    expect(bars).toHaveLength(3);
    expect(bars[0]).toBeNull();
    expect(bars[1]).not.toBeNull();
    expect(bars[2]).not.toBeNull();
    expect(bars[2]!.sentiment).toEqual({ fearGreedIndex: 30, label: 'Fear', news: null });
  });

  it('holds a fine candle back until the whole snapshot interval has passed', () => {
    // The case a strict `<` would miss. 5m candles read 1h snapshots, so a bar
    // opening at 12:05 sits INSIDE the window the 12:00 row was captured in and
    // must not see it; 13:00 is the first bar that may.
    const FIVE_MIN = 5 * 60 * 1000;
    const candles = makeCandles(14, FIVE_MIN);
    const snapshots = [makeSnapshot(BASE, fullData)];

    const bars = buildSnapshotSeries(candles, snapshots, '5m');

    for (let i = 0; i < 12; i++) expect(bars[i], `bar ${i}`).toBeNull();
    expect(bars[12]).not.toBeNull(); // BASE + 60m
    expect(bars[13]).not.toBeNull();
  });

  it('carries a snapshot forward within the staleness cap', () => {
    const candles = makeCandles(5);
    // Snapshot only at the first candle. The default cap is 3x the interval:
    // one of those is the causality shift every usable snapshot now carries,
    // leaving the same two ingest ticks of tolerance as before.
    const snapshots = [makeSnapshot(BASE, fullData)];

    const bars = buildSnapshotSeries(candles, snapshots, '1h');

    expect(bars[0]).toBeNull(); // captured during this bar
    expect(bars[1]).not.toBeNull(); // first bar that may read it
    expect(bars[2]).not.toBeNull();
    expect(bars[3]).not.toBeNull(); // 3h stale, at the cap
    expect(bars[4]).toBeNull(); // beyond the cap
  });

  it('never uses a snapshot from after the candle open (no lookahead)', () => {
    const candles = makeCandles(3);
    // Snapshot 1ms after the first candle opens: stamped inside bar 0, so the
    // window it covers ends inside bar 1 and bar 2 is the first that may read it.
    const snapshots = [makeSnapshot(BASE + 1, fullData)];

    const bars = buildSnapshotSeries(candles, snapshots, '1h');

    expect(bars[0]).toBeNull();
    expect(bars[1]).toBeNull();
    expect(bars[2]).not.toBeNull();
  });

  it('maps 5m candles onto hourly snapshots', () => {
    const FIVE_MIN = 5 * 60 * 1000;
    const candles = makeCandles(30, FIVE_MIN);
    const snapshots = [makeSnapshot(BASE, fullData)];

    const bars = buildSnapshotSeries(candles, snapshots, '5m');

    // 1h snapshot interval: bars 12 onward may read it, and the 3h cap keeps
    // every one of the remaining bars inside the window.
    expect(bars.slice(0, 12).every((b) => b === null)).toBe(true);
    expect(bars.slice(12).every((b) => b !== null)).toBe(true);
  });

  it('returns all nulls for empty snapshot input', () => {
    const candles = makeCandles(3);
    const bars = buildSnapshotSeries(candles, [], '1h');

    expect(bars).toEqual([null, null, null]);
  });

  it('handles unsorted snapshot input', () => {
    const candles = makeCandles(3);
    const snapshots = [
      makeSnapshot(BASE + 2 * HOUR, { fearGreed: { index: 90, label: 'Extreme Greed' } }),
      makeSnapshot(BASE, { fearGreed: { index: 10, label: 'Extreme Fear' } }),
    ];

    const bars = buildSnapshotSeries(candles, snapshots, '1h');

    expect(bars[0]).toBeNull();
    expect(bars[1]!.sentiment!.fearGreedIndex).toBe(10);
    expect(bars[2]!.sentiment!.fearGreedIndex).toBe(10);
  });
});

describe('the L/S z (configVersion 8)', () => {
  /** Hourly 1h rows with a moving ratio, enough for the 360-sample floor. */
  function lsRows(count: number, start = BASE): LeanSnapshot[] {
    return Array.from({ length: count }, (_, i) =>
      makeSnapshot(start + i * HOUR, {
        longShortRatio: { ratio: 1.5 + 0.3 * Math.sin(i / 11), longAccount: 0.6, shortAccount: 0.4 },
      })
    );
  }

  it('attaches the z of the latest 1h row whose window closed at or before the candle open', () => {
    const rows = lsRows(500);
    const candles = makeCandles(500);
    const bars = buildSnapshotSeries(candles, rows, '1h', { symbol: 'BTCUSDT' });
    const { t, z } = longShortZSeries(rows);
    // Candle 450 opens at BASE + 450h; the latest readable row is t = 449h.
    const zAt450 = bars[450]!.futures!.longShortRatio!.zScore;
    expect(zAt450).toBeCloseTo(z[t.indexOf(BASE + 449 * HOUR)], 12);
  });

  it('is null before the 360-sample floor is reached, so the signal abstains', () => {
    const bars = buildSnapshotSeries(makeCandles(400), lsRows(400), '1h', { symbol: 'BTCUSDT' });
    expect(bars[300]!.futures!.longShortRatio!.zScore).toBeNull();
    expect(Number.isFinite(bars[390]!.futures!.longShortRatio!.zScore ?? Number.NaN)).toBe(true);
  });

  it('gives 4h candles the 1h-grid z, and refuses to run without the 1h rows', () => {
    const rows1h = lsRows(720);
    const rows4h = rows1h.filter((_, i) => i % 4 === 0);
    const candles4h = makeCandles(180, 4 * HOUR);
    expect(() => buildSnapshotSeries(candles4h, rows4h, '4h', { symbol: 'BTCUSDT' })).toThrow(/lsRows1h/);

    const bars = buildSnapshotSeries(candles4h, rows4h, '4h', { symbol: 'BTCUSDT', lsRows1h: rows1h });
    const { t, z } = longShortZSeries(rows1h);
    // Candle 170 opens at BASE + 680h; the latest readable 1h row is 679h.
    expect(bars[170]!.futures!.longShortRatio!.zScore).toBeCloseTo(z[t.indexOf(BASE + 679 * HOUR)], 12);
  });

  it('drops a 1h z older than three hours, as it drops a stale snapshot', () => {
    const rows1h = lsRows(400);
    const rows4h = [makeSnapshot(BASE + 400 * HOUR, { longShortRatio: { ratio: 1.5, longAccount: 0.6, shortAccount: 0.4 } })];
    // A 4h candle opening 410h reads the 4h row (window closed at 404h) but the
    // newest 1h row is 399h, eleven hours old.
    const candle = makeCandles(1, 4 * HOUR).map((c) => ({ ...c, timestamp: BASE + 410 * HOUR }));
    const bars = buildSnapshotSeries(candle, rows4h, '4h', { symbol: 'BTCUSDT', lsRows1h: rows1h });
    expect(bars[0]!.futures!.longShortRatio!.zScore).toBeNull();
  });

  it('accepts an empty lsRows1h for a funding-only caller', () => {
    const rows4h = [makeSnapshot(BASE, fullData)];
    const candle = makeCandles(1, 4 * HOUR).map((c) => ({ ...c, timestamp: BASE + 4 * HOUR }));
    const bars = buildSnapshotSeries(candle, rows4h, '4h', { symbol: 'BTCUSDT', lsRows1h: [] });
    expect(bars[0]!.futures!.fundingRate).not.toBeNull();
    expect(bars[0]!.futures!.longShortRatio!.zScore).toBeNull();
  });
});
