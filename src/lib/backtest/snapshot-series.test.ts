// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildSnapshotSeries,
  mapToSnapshotInterval,
  snapshotToScorerInputs,
  type LeanSnapshot,
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
    expect(sentiment).toEqual({ fearGreedIndex: 30, label: 'Fear' });
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
  it('aligns exact-match snapshots to candles', () => {
    const candles = makeCandles(3);
    const snapshots = [
      makeSnapshot(BASE, fullData),
      makeSnapshot(BASE + HOUR, fullData),
      makeSnapshot(BASE + 2 * HOUR, fullData),
    ];

    const bars = buildSnapshotSeries(candles, snapshots, '1h', { symbol: 'BTCUSDT' });

    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar).not.toBeNull();
      expect(bar!.sentiment).toEqual({ fearGreedIndex: 30, label: 'Fear' });
    }
  });

  it('carries a snapshot forward within the staleness cap', () => {
    const candles = makeCandles(4);
    // Snapshot only at the first candle; default cap is 2x interval
    const snapshots = [makeSnapshot(BASE, fullData)];

    const bars = buildSnapshotSeries(candles, snapshots, '1h');

    expect(bars[0]).not.toBeNull();
    expect(bars[1]).not.toBeNull(); // 1h stale
    expect(bars[2]).not.toBeNull(); // 2h stale, at the cap
    expect(bars[3]).toBeNull(); // 3h stale, beyond the cap
  });

  it('never uses a snapshot from after the candle open (no lookahead)', () => {
    const candles = makeCandles(2);
    // Snapshot 1ms after the first candle opens
    const snapshots = [makeSnapshot(BASE + 1, fullData)];

    const bars = buildSnapshotSeries(candles, snapshots, '1h');

    expect(bars[0]).toBeNull();
    expect(bars[1]).not.toBeNull();
  });

  it('maps 5m candles onto hourly snapshots', () => {
    const FIVE_MIN = 5 * 60 * 1000;
    const candles = makeCandles(6, FIVE_MIN);
    const snapshots = [makeSnapshot(BASE, fullData)];

    const bars = buildSnapshotSeries(candles, snapshots, '5m');

    // 1h snapshot interval -> 2 hour staleness cap covers all 6 bars
    expect(bars.every((b) => b !== null)).toBe(true);
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

    expect(bars[0]!.sentiment!.fearGreedIndex).toBe(10);
    expect(bars[2]!.sentiment!.fearGreedIndex).toBe(90);
  });
});
