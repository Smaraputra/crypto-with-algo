// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STRATEGY_FAMILIES, expandGrid, positioningZScore } from './strategy-families';
import type { SnapshotBar } from '@/lib/backtest/snapshot-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const family = STRATEGY_FAMILIES['positioning-fade'];

function snap(ratio: number | null): SnapshotBar | null {
  if (ratio === null) return null;
  return {
    futures: {
      fundingRate: null,
      openInterest: null,
      longShortRatio: {
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
    interval: '4h',
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

describe('positioningZScore', () => {
  it('is NaN until the minimum number of readings exists', () => {
    const s = Array.from({ length: 100 }, (_, i) => snap(1 + (i % 7) / 10));
    const z = positioningZScore(s, 50);
    expect(z[0]).toBeNaN();
    expect(z[10]).toBeNaN();
    expect(Number.isFinite(z[60])).toBe(true);
  });

  it('matches a direct computation over the trailing window', () => {
    const values = Array.from({ length: 300 }, (_, i) => 1 + Math.sin(i / 5) * 0.5);
    const s = values.map((v) => snap(v));
    const windowBars = 120;
    const bar = 250;
    const z = positioningZScore(s, windowBars)[bar];

    const start = Math.max(0, bar - windowBars + 1);
    const w = values.slice(start, bar + 1);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const variance = w.reduce((a, b) => a + (b - mean) ** 2, 0) / (w.length - 1);
    expect(z).toBeCloseTo((values[bar] - mean) / Math.sqrt(variance), 8);
  });

  it('is NaN rather than zero when the ratio never moves', () => {
    const s = Array.from({ length: 200 }, () => snap(2));
    const z = positioningZScore(s, 100);
    for (let i = 0; i < 200; i++) expect(z[i]).toBeNaN();
  });

  it('skips bars with no snapshot without poisoning the window', () => {
    const s = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? null : snap(1 + (i % 11) / 10)));
    const z = positioningZScore(s, 150);
    expect(z[0]).toBeNaN();
    expect(Number.isFinite(z[299])).toBe(true);
    for (let i = 0; i < 300; i += 3) expect(z[i]).toBeNaN();
  });

  it('never reads a bar later than the one asked for', () => {
    // The ctx.snapshots causality contract. Truncating the series after bar i
    // must not change the value at bar i.
    const values = Array.from({ length: 400 }, (_, i) => 1 + Math.sin(i / 9));
    const s = values.map((v) => snap(v));
    const full = positioningZScore(s, 120);
    for (const bar of [150, 250, 399]) {
      // A fresh array, so the memo cannot serve the full-series answer.
      const truncated = values.slice(0, bar + 1).map((v) => snap(v));
      const partial = positioningZScore(truncated, 120);
      expect(partial[bar]).toBeCloseTo(full[bar], 12);
    }
  });

  it('memoizes per array and window', () => {
    const s = Array.from({ length: 100 }, (_, i) => snap(1 + i / 100));
    expect(positioningZScore(s, 50)).toBe(positioningZScore(s, 50));
    expect(positioningZScore(s, 50)).not.toBe(positioningZScore(s, 60));
  });
});

describe('positioning-fade family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(family);
    expect(grid).toHaveLength(3 * 3 * 3 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('shorts a crowded long book and longs a crowded short one', () => {
    const rising = Array.from({ length: 200 }, (_, i) => snap(1 + i / 100));
    const strategy = family.create({ window: 120, z: 1, hold: 16, k: 2 }, {
      style: 'swing_trading', interval: '4h',
    });
    const high = strategy.decideEntry(ctx(199, rising), config);
    expect(high?.side).toBe('short');

    const falling = Array.from({ length: 200 }, (_, i) => snap(3 - i / 100));
    const low = strategy.decideEntry(ctx(199, falling), config);
    expect(low?.side).toBe('long');
  });

  it('places the stop and target on the correct sides', () => {
    const rising = Array.from({ length: 200 }, (_, i) => snap(1 + i / 100));
    const strategy = family.create({ window: 120, z: 1, hold: 16, k: 2 }, {
      style: 'swing_trading', interval: '4h',
    });
    const d = strategy.decideEntry(ctx(199, rising), config)!;
    // close 100, atr 2, k 2: stop above for a short, target below, 2:1.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(104, 10);
    expect(d.targetPrice).toBeCloseTo(92, 10);
    expect(d.timeStopBars).toBe(16);
    expect(d.orderType).toBe('market');
  });

  it('does not trade below the z threshold', () => {
    const flatish = Array.from({ length: 200 }, (_, i) => snap(2 + ((i % 5) - 2) / 1000));
    const strategy = family.create({ window: 120, z: 2, hold: 16, k: 2 }, {
      style: 'swing_trading', interval: '4h',
    });
    expect(strategy.decideEntry(ctx(199, flatish), config)).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const rising = Array.from({ length: 200 }, (_, i) => snap(1 + i / 100));
    const strategy = family.create({ window: 120, z: 1, hold: 16, k: 2 }, {
      style: 'swing_trading', interval: '4h',
    });
    expect(strategy.decideEntry({ ...ctx(199, rising), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(strategy.decideEntry({ ...ctx(199, rising), suite: noAtr }, config)).toBeNull();
  });

  it('does not trade on a bar with no positioning reading', () => {
    const s: (SnapshotBar | null)[] = Array.from({ length: 200 }, (_, i) => snap(1 + i / 100));
    s[199] = null;
    const strategy = family.create({ window: 120, z: 1, hold: 16, k: 2 }, {
      style: 'swing_trading', interval: '4h',
    });
    expect(strategy.decideEntry(ctx(199, s), config)).toBeNull();
  });

  it('reaches the same decision when future bars are removed', () => {
    const values = Array.from({ length: 300 }, (_, i) => 1 + Math.sin(i / 11));
    const strategy = family.create({ window: 120, z: 1, hold: 16, k: 2 }, {
      style: 'swing_trading', interval: '4h',
    });
    for (const bar of [200, 250, 299]) {
      const full = strategy.decideEntry(ctx(bar, values.map((v) => snap(v))), config);
      const cut = strategy.decideEntry(ctx(bar, values.slice(0, bar + 1).map((v) => snap(v))), config);
      expect(cut?.side ?? null).toBe(full?.side ?? null);
      if (full && cut) expect(cut.stopPrice).toBeCloseTo(full.stopPrice, 10);
    }
  });

  it('never exits on signal, leaving stops and the time stop to work', () => {
    const rising = Array.from({ length: 200 }, (_, i) => snap(1 + i / 100));
    const strategy = family.create({ window: 120, z: 1, hold: 16, k: 2 }, {
      style: 'swing_trading', interval: '4h',
    });
    expect(strategy.decideExit(ctx(199, rising), config)).toBe(false);
  });
});

describe('positioning-horizon family', () => {
  const horizon = STRATEGY_FAMILIES['positioning-horizon'];

  it('expands to a grid inside the cell cap', () => {
    expect(expandGrid(horizon)).toHaveLength(3 * 3 * 3);
  });

  it('takes the same side as positioning-fade on the same reading', () => {
    const rising = Array.from({ length: 200 }, (_, i) => snap(1 + i / 100));
    const p = { window: 120, z: 1, hold: 16 };
    const h = horizon.create(p, { style: 'swing_trading', interval: '4h' });
    const f = family.create({ ...p, k: 2 }, { style: 'swing_trading', interval: '4h' });
    expect(h.decideEntry(ctx(199, rising), config)?.side).toBe(
      f.decideEntry(ctx(199, rising), config)?.side
    );
  });

  it('keeps the stop far away and sets no target, so the time stop is the exit', () => {
    const rising = Array.from({ length: 200 }, (_, i) => snap(1 + i / 100));
    const h = horizon.create({ window: 120, z: 1, hold: 32 }, {
      style: 'swing_trading', interval: '4h',
    });
    const d = h.decideEntry(ctx(199, rising), config)!;
    // close 100, atr 2, 10 ATR: the stop sits 20 away, not 4.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(120, 10);
    expect(d.targetPrice).toBeNull();
    expect(d.timeStopBars).toBe(32);
  });

  it('never exits on signal', () => {
    const rising = Array.from({ length: 200 }, (_, i) => snap(1 + i / 100));
    const h = horizon.create({ window: 120, z: 1, hold: 16 }, {
      style: 'swing_trading', interval: '4h',
    });
    expect(h.decideExit(ctx(199, rising), config)).toBe(false);
  });
});
