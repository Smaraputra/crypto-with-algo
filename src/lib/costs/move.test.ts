import { describe, expect, it } from 'vitest';
import { holdMoveStats, pickMeasurementInterval, quantileSorted } from './move';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('pickMeasurementInterval', () => {
  it.each([
    [5 * MIN, '1m', 5],
    [15 * MIN, '5m', 3],
    [30 * MIN, '5m', 6],
    [HOUR, '15m', 4],
    [2 * HOUR, '15m', 8],
    [4 * HOUR, '1h', 4],
    [DAY, '4h', 6],
    [7 * DAY, '1d', 7],
  ])('measures a %d ms hold on %s bars x %d', (holdMs, interval, holdBars) => {
    const m = pickMeasurementInterval(holdMs);
    expect(m.interval).toBe(interval);
    expect(m.holdBars).toBe(holdBars);
    expect(m.measuredHoldMs).toBe(holdMs);
  });

  it('falls back to 1m bars below three minutes and rounds to whole bars', () => {
    expect(pickMeasurementInterval(MIN)).toEqual({ interval: '1m', holdBars: 1, measuredHoldMs: MIN });
    expect(pickMeasurementInterval(2 * MIN + 20_000)).toEqual({ interval: '1m', holdBars: 2, measuredHoldMs: 2 * MIN });
    expect(pickMeasurementInterval(50 * MIN)).toEqual({ interval: '15m', holdBars: 3, measuredHoldMs: 45 * MIN });
  });

  it('refuses a hold under a minute', () => {
    expect(() => pickMeasurementInterval(30_000)).toThrow(/at least 1 minute/);
  });
});

describe('quantileSorted', () => {
  it('interpolates linearly between order statistics', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25, 12);
    expect(quantileSorted([7], 0.99)).toBe(7);
    expect(Number.isNaN(quantileSorted([], 0.5))).toBe(true);
  });
});

describe('holdMoveStats', () => {
  it('measures absolute close-to-close returns over overlapping windows', () => {
    // one-bar moves: +10%, -10%, 0%, +10%
    const stats = holdMoveStats([100, 110, 99, 99, 108.9], 1);
    expect(stats).not.toBeNull();
    expect(stats!.samples).toBe(4);
    expect(stats!.independentWindows).toBe(4);
    expect(stats!.medianPercent).toBeCloseTo(10, 9);
    expect(stats!.p75Percent).toBeCloseTo(10, 9);
  });

  it('counts non-overlapping windows separately from overlapping samples', () => {
    const closes = Array.from({ length: 101 }, (_, i) => 100 + (i % 2));
    const stats = holdMoveStats(closes, 4)!;
    expect(stats.samples).toBe(97);
    expect(stats.independentWindows).toBe(25);
  });

  it('winsorises the mean at the 99th percentile so one crash does not set it', () => {
    const closes = [100];
    for (let i = 0; i < 199; i++) closes.push(closes[closes.length - 1] * (i % 2 === 0 ? 1.01 : 1 / 1.01));
    closes.push(closes[closes.length - 1] * 0.2); // one -80% bar
    const stats = holdMoveStats(closes, 1)!;
    expect(stats.meanPercent).toBeLessThan(2);
    expect(stats.medianPercent).toBeCloseTo(1, 0);
  });

  it('returns null when the series has no full window', () => {
    expect(holdMoveStats([100, 101], 2)).toBeNull();
  });

  it('refuses a non-integer hold', () => {
    expect(() => holdMoveStats([1, 2, 3], 1.5)).toThrow(/positive integer/);
  });
});
