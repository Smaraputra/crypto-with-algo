// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  STRATEGY_FAMILIES,
  expandGrid,
  fundingWindowBars,
  fundingZScore,
  positioningZScore,
} from './strategy-families';
import type { SnapshotBar } from '@/lib/backtest/snapshot-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const family = STRATEGY_FAMILIES['funding-z-fade'];

/** A snapshot carrying a funding rate, and optionally a long/short ratio so a
 * test can prove the two series do not share a cache entry. */
function snap(rate: number | null, ratio?: number): SnapshotBar | null {
  if (rate === null) return null;
  return {
    futures: {
      fundingRate: {
        symbol: 'BTCUSDT',
        fundingRate: rate,
        fundingTime: 0,
        markPrice: Number.NaN,
      },
      openInterest: null,
      longShortRatio:
        ratio === undefined
          ? null
          : {
              symbol: 'BTCUSDT',
              longShortRatio: ratio,
              longAccount: 0.5,
              shortAccount: 0.5,
              timestamp: 0,
            },
    },
    sentiment: null,
  };
}

function candles(n: number): OHLCV[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: 1700000000000 + i * 3600000,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
}

/** Only ATR is read by the family. */
const suite = { atr: { current: 2 } } as unknown as IndicatorSuite;
const config = {} as BacktestConfig;

function ctx(bar: number, snapshots: (SnapshotBar | null)[]): StrategyContext {
  return {
    bar,
    candles: candles(snapshots.length),
    interval: '1h',
    suite,
    score: 0,
    tier: 'neutral',
    superTrend: null,
    snapshot: snapshots[bar],
    snapshots,
    research: [],
    htfContext: null,
    session: null,
    position: null,
    pendingOrder: null,
  };
}

const swing1h = { style: 'swing_trading', interval: '1h' } as const;

describe('fundingWindowBars', () => {
  it('converts days to bars per interval, as factors.ts does', () => {
    // factors.ts: ceil(days * DAY_MS / intervalMs), floored at 1.
    expect(fundingWindowBars(30, '1h')).toBe(30 * 24);
    expect(fundingWindowBars(30, '15m')).toBe(30 * 96);
    expect(fundingWindowBars(15, '1h')).toBe(15 * 24);
    expect(fundingWindowBars(60, '15m')).toBe(60 * 96);
  });

  it('never returns less than one bar', () => {
    expect(fundingWindowBars(0, '1d')).toBe(1);
  });

  it('spans the same number of funding settlements at every interval', () => {
    // Funding settles every 8h, so a day-count window is what makes a grid
    // cell mean the same thing at 15m and at 1h: thirty days is ninety
    // settlements either way. A bar-count window would not be.
    const settlementsAt = (interval: string, barsPerDay: number) =>
      (fundingWindowBars(30, interval) / barsPerDay) * 3;
    expect(settlementsAt('1h', 24)).toBe(90);
    expect(settlementsAt('15m', 96)).toBe(90);
    expect(settlementsAt('5m', 288)).toBe(90);
  });
});

describe('fundingZScore', () => {
  it('is NaN until the minimum number of readings exists', () => {
    const s = Array.from({ length: 100 }, (_, i) => snap(0.0001 * (i % 7)));
    const z = fundingZScore(s, 50);
    expect(z[0]).toBeNaN();
    expect(z[10]).toBeNaN();
    expect(Number.isFinite(z[60])).toBe(true);
  });

  it('matches a direct computation over the trailing window', () => {
    const values = Array.from({ length: 300 }, (_, i) => Math.sin(i / 5) * 0.0004);
    const s = values.map((v) => snap(v));
    const windowBars = 120;
    const bar = 250;
    const z = fundingZScore(s, windowBars)[bar];

    const start = Math.max(0, bar - windowBars + 1);
    const w = values.slice(start, bar + 1);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const variance = w.reduce((a, b) => a + (b - mean) ** 2, 0) / (w.length - 1);
    expect(z).toBeCloseTo((values[bar] - mean) / Math.sqrt(variance), 8);
  });

  it('keeps negative funding rates, which the ratio reader would discard', () => {
    // The whole point of a separate accessor: a negative funding rate means
    // shorts pay longs and is a real reading, where a non-positive long/short
    // ratio is a broken row.
    const values = Array.from({ length: 200 }, (_, i) => -0.0003 + (i % 9) * 0.00001);
    const s = values.map((v) => snap(v));
    const z = fundingZScore(s, 120);
    expect(Number.isFinite(z[199])).toBe(true);
  });

  it('is NaN rather than zero when funding never moves', () => {
    const s = Array.from({ length: 200 }, () => snap(0.0001));
    const z = fundingZScore(s, 100);
    for (let i = 0; i < 200; i++) expect(z[i]).toBeNaN();
  });

  it('treats a zero funding rate as a reading, not a gap', () => {
    const values = Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? 0 : 0.0002));
    const s = values.map((v) => snap(v));
    const z = fundingZScore(s, 120);
    expect(Number.isFinite(z[196])).toBe(true);
  });

  it('skips bars with no snapshot without poisoning the window', () => {
    const s = Array.from({ length: 300 }, (_, i) =>
      i % 3 === 0 ? null : snap(0.0001 * (i % 11))
    );
    const z = fundingZScore(s, 150);
    expect(z[0]).toBeNaN();
    expect(Number.isFinite(z[299])).toBe(true);
    for (let i = 0; i < 300; i += 3) expect(z[i]).toBeNaN();
  });

  it('never reads a bar later than the one asked for', () => {
    const values = Array.from({ length: 400 }, (_, i) => Math.sin(i / 9) * 0.0002);
    const s = values.map((v) => snap(v));
    const full = fundingZScore(s, 120);
    for (const bar of [150, 250, 399]) {
      const truncated = values.slice(0, bar + 1).map((v) => snap(v));
      const partial = fundingZScore(truncated, 120);
      expect(partial[bar]).toBeCloseTo(full[bar], 12);
    }
  });

  it('memoizes per array and window', () => {
    const s = Array.from({ length: 100 }, (_, i) => snap(0.0001 * i));
    expect(fundingZScore(s, 50)).toBe(fundingZScore(s, 50));
    expect(fundingZScore(s, 50)).not.toBe(fundingZScore(s, 60));
  });

  it('does not share a cache entry with the positioning series', () => {
    // The shared trailing-z is keyed by series AND window. If the key were the
    // window alone, whichever series was asked for first would be served to
    // both, silently making one family trade the other's factor.
    const s = Array.from({ length: 200 }, (_, i) => snap(0.0001 * (i % 7), 1 + i / 100));
    const funding = fundingZScore(s, 120);
    const positioning = positioningZScore(s, 120);
    expect(funding).not.toBe(positioning);
    expect(funding[199]).not.toBeCloseTo(positioning[199], 6);
  });
});

describe('funding-z-fade family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(family);
    expect(grid).toHaveLength(3 * 3 * 3 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('shorts expensive funding and longs cheap funding', () => {
    // Negative IC: a high funding z precedes lower forward returns.
    const rising = Array.from({ length: 900 }, (_, i) => snap(0.000001 * i));
    const strategy = family.create({ days: 15, z: 1, hold: 16, k: 2 }, swing1h);
    expect(strategy.decideEntry(ctx(899, rising), config)?.side).toBe('short');

    const falling = Array.from({ length: 900 }, (_, i) => snap(0.0009 - 0.000001 * i));
    expect(strategy.decideEntry(ctx(899, falling), config)?.side).toBe('long');
  });

  it('places the stop and target on the correct sides', () => {
    const rising = Array.from({ length: 900 }, (_, i) => snap(0.000001 * i));
    const strategy = family.create({ days: 15, z: 1, hold: 16, k: 2 }, swing1h);
    const d = strategy.decideEntry(ctx(899, rising), config)!;
    // close 100, atr 2, k 2: stop above for a short, target below, 2:1.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(104, 10);
    expect(d.targetPrice).toBeCloseTo(92, 10);
    expect(d.timeStopBars).toBe(16);
    expect(d.orderType).toBe('market');
  });

  it('does not trade below the z threshold', () => {
    const flatish = Array.from({ length: 900 }, (_, i) => snap(0.0002 + ((i % 5) - 2) * 1e-9));
    const strategy = family.create({ days: 15, z: 2, hold: 16, k: 2 }, swing1h);
    expect(strategy.decideEntry(ctx(899, flatish), config)).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const rising = Array.from({ length: 900 }, (_, i) => snap(0.000001 * i));
    const strategy = family.create({ days: 15, z: 1, hold: 16, k: 2 }, swing1h);
    expect(strategy.decideEntry({ ...ctx(899, rising), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(strategy.decideEntry({ ...ctx(899, rising), suite: noAtr }, config)).toBeNull();
  });

  it('does not trade on a bar with no funding reading', () => {
    const s: (SnapshotBar | null)[] = Array.from({ length: 900 }, (_, i) => snap(0.000001 * i));
    s[899] = null;
    const strategy = family.create({ days: 15, z: 1, hold: 16, k: 2 }, swing1h);
    expect(strategy.decideEntry(ctx(899, s), config)).toBeNull();
  });

  it('reaches the same decision when future bars are removed', () => {
    const values = Array.from({ length: 900 }, (_, i) => Math.sin(i / 60) * 0.0004);
    const strategy = family.create({ days: 15, z: 1, hold: 16, k: 2 }, swing1h);
    for (const bar of [700, 800, 899]) {
      const full = strategy.decideEntry(ctx(bar, values.map((v) => snap(v))), config);
      const cut = strategy.decideEntry(
        ctx(bar, values.slice(0, bar + 1).map((v) => snap(v))),
        config
      );
      expect(cut?.side ?? null).toBe(full?.side ?? null);
      if (full && cut) expect(cut.stopPrice).toBeCloseTo(full.stopPrice, 10);
    }
  });

  it('sizes its window from the interval, so 15m and 1h are not the same cell', () => {
    // A level shift 100 bars from the end. The 1h window (720 bars) sits
    // mostly after the shift and the 15m window (2880, so the whole series
    // here) mostly before it, so the same reading is a different number of
    // standard deviations at each interval.
    const values = Array.from({ length: 900 }, (_, i) =>
      (i < 800 ? 0.0002 : 0.0006) + (i % 3) * 1e-7
    );
    const s = values.map((v) => snap(v));
    const z1h = fundingZScore(s, fundingWindowBars(30, '1h'))[899];
    const z15m = fundingZScore(s, fundingWindowBars(30, '15m'))[899];
    expect(Number.isFinite(z1h)).toBe(true);
    expect(Number.isFinite(z15m)).toBe(true);
    expect(z1h).not.toBeCloseTo(z15m, 6);

    // A threshold set between the two: exactly one cell clears it, which is
    // only possible if `create` read ctx.interval.
    const threshold = (Math.abs(z1h) + Math.abs(z15m)) / 2;
    const at1h = family.create({ days: 30, z: threshold, hold: 16, k: 2 }, swing1h);
    const at15m = family.create({ days: 30, z: threshold, hold: 16, k: 2 }, {
      style: 'swing_trading', interval: '15m',
    });
    const fired1h = at1h.decideEntry(ctx(899, s), config) !== null;
    const fired15m = at15m.decideEntry(ctx(899, s), config) !== null;
    expect(fired1h).not.toBe(fired15m);
  });

  it('never exits on signal, leaving stops and the time stop to work', () => {
    const rising = Array.from({ length: 900 }, (_, i) => snap(0.000001 * i));
    const strategy = family.create({ days: 15, z: 1, hold: 16, k: 2 }, swing1h);
    expect(strategy.decideExit(ctx(899, rising), config)).toBe(false);
  });
});
