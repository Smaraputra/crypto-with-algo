// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STRATEGY_FAMILIES, expandGrid } from './strategy-families';
import { depthColumn, fundingColumn } from './research-columns';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const funding = STRATEGY_FAMILIES['funding-z-fade'];
const depth = STRATEGY_FAMILIES['depth-imbalance-fade'];

const BARS = 40;

function candles(n: number): OHLCV[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: 1700000000000 + i * 3600000,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
}

/** A research series where the final bar carries the given columns. */
function research(last: Record<string, number> | null): (ResearchBar | null)[] {
  const bars: (ResearchBar | null)[] = new Array(BARS).fill(null);
  bars[BARS - 1] = last;
  return bars;
}

/** Only ATR is read by these families. */
const suite = { atr: { current: 2 } } as unknown as IndicatorSuite;
const config = {} as BacktestConfig;

function ctx(bars: (ResearchBar | null)[], interval = '1h'): StrategyContext {
  return {
    bar: BARS - 1,
    candles: candles(BARS),
    interval,
    suite,
    score: 0,
    tier: 'neutral',
    superTrend: null,
    snapshot: null,
    snapshots: [],
    research: bars,
    htfContext: null,
    session: null,
    position: null,
    pendingOrder: null,
  };
}

const swing = { style: 'swing_trading', interval: '1h' } as const;

describe('funding-z-fade family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(funding);
    expect(grid).toHaveLength(3 * 3 * 3 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the columns it cannot trade without', () => {
    expect(funding.requiresResearchColumns).toEqual([
      fundingColumn(15), fundingColumn(30), fundingColumn(60),
    ]);
  });

  it('every grid cell maps to a declared column', () => {
    for (const cell of expandGrid(funding)) {
      expect(funding.requiresResearchColumns).toContain(fundingColumn(cell.days));
    }
  });

  it('shorts expensive funding and longs cheap funding', () => {
    // Negative IC: a high funding z precedes lower forward returns.
    const s = funding.create({ days: 30, z: 1, hold: 16, k: 2 }, swing);
    expect(s.decideEntry(ctx(research({ [fundingColumn(30)]: 2.5 })), config)?.side).toBe('short');
    expect(s.decideEntry(ctx(research({ [fundingColumn(30)]: -2.5 })), config)?.side).toBe('long');
  });

  it('reads the column its days param names and ignores the others', () => {
    const s = funding.create({ days: 30, z: 1, hold: 16, k: 2 }, swing);
    // Only the 15-day column is present: the 30-day cell must decline.
    expect(s.decideEntry(ctx(research({ [fundingColumn(15)]: 9 })), config)).toBeNull();
    // Both present with opposite signs: the 30-day one decides.
    const both = research({ [fundingColumn(15)]: -9, [fundingColumn(30)]: 9 });
    expect(s.decideEntry(ctx(both), config)?.side).toBe('short');
  });

  it('places the stop and target on the correct sides', () => {
    const s = funding.create({ days: 30, z: 1, hold: 16, k: 2 }, swing);
    const d = s.decideEntry(ctx(research({ [fundingColumn(30)]: 2.5 })), config)!;
    // close 100, atr 2, k 2: stop above for a short, target below, 2:1.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(104, 10);
    expect(d.targetPrice).toBeCloseTo(92, 10);
    expect(d.timeStopBars).toBe(16);
    expect(d.orderType).toBe('market');
  });

  it('scales the stop with k and keeps the 2:1 target ratio', () => {
    const s = funding.create({ days: 30, z: 1, hold: 8, k: 3 }, swing);
    const d = s.decideEntry(ctx(research({ [fundingColumn(30)]: -2.5 })), config)!;
    expect(d.side).toBe('long');
    expect(d.stopPrice).toBeCloseTo(94, 10);
    expect(d.targetPrice).toBeCloseTo(112, 10);
    expect(d.timeStopBars).toBe(8);
  });

  it('does not trade below the z threshold', () => {
    const s = funding.create({ days: 30, z: 2, hold: 16, k: 2 }, swing);
    expect(s.decideEntry(ctx(research({ [fundingColumn(30)]: 1.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [fundingColumn(30)]: -1.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [fundingColumn(30)]: 2 })), config)).not.toBeNull();
  });

  it('does not trade when the column is missing or not finite', () => {
    const s = funding.create({ days: 30, z: 1, hold: 16, k: 2 }, swing);
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
    expect(s.decideEntry(ctx(research({})), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [fundingColumn(30)]: Number.NaN })), config)).toBeNull();
    expect(s.decideEntry(ctx([]), config)).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const s = funding.create({ days: 30, z: 1, hold: 16, k: 2 }, swing);
    const bars = research({ [fundingColumn(30)]: 2.5 });
    expect(s.decideEntry({ ...ctx(bars), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry({ ...ctx(bars), suite: noAtr }, config)).toBeNull();
  });

  it('never exits on signal, leaving stops and the time stop to work', () => {
    const s = funding.create({ days: 30, z: 1, hold: 16, k: 2 }, swing);
    expect(s.decideExit(ctx(research({ [fundingColumn(30)]: 2.5 })), config)).toBe(false);
  });
});

describe('depth-imbalance-fade family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(depth);
    expect(grid).toHaveLength(2 * 3 * 3 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the columns it cannot trade without', () => {
    expect(depth.requiresResearchColumns).toEqual([depthColumn(30), depthColumn(90)]);
  });

  it('every grid cell maps to a declared column', () => {
    for (const cell of expandGrid(depth)) {
      expect(depth.requiresResearchColumns).toContain(depthColumn(cell.days));
    }
  });

  it('shorts a heavy bid book and longs a heavy ask book', () => {
    const s = depth.create({ days: 30, z: 1, hold: 16, k: 2 }, swing);
    expect(s.decideEntry(ctx(research({ [depthColumn(30)]: 2.5 })), config)?.side).toBe('short');
    expect(s.decideEntry(ctx(research({ [depthColumn(30)]: -2.5 })), config)?.side).toBe('long');
  });

  it('reads the column its days param names', () => {
    const s = depth.create({ days: 90, z: 1, hold: 16, k: 2 }, swing);
    expect(s.decideEntry(ctx(research({ [depthColumn(30)]: 9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [depthColumn(90)]: 9 })), config)?.side).toBe('short');
  });

  it('places the stop and target on the correct sides', () => {
    const s = depth.create({ days: 30, z: 1, hold: 32, k: 2 }, swing);
    const d = s.decideEntry(ctx(research({ [depthColumn(30)]: 2.5 })), config)!;
    expect(d.stopPrice).toBeCloseTo(104, 10);
    expect(d.targetPrice).toBeCloseTo(92, 10);
    expect(d.timeStopBars).toBe(32);
    expect(d.orderType).toBe('market');
  });

  it('does not trade below the threshold, on a missing column, or without ATR', () => {
    const s = depth.create({ days: 30, z: 2, hold: 16, k: 2 }, swing);
    expect(s.decideEntry(ctx(research({ [depthColumn(30)]: 1.5 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
    const bars = research({ [depthColumn(30)]: 2.5 });
    expect(s.decideEntry({ ...ctx(bars), suite: null }, config)).toBeNull();
  });

  it('never exits on signal', () => {
    const s = depth.create({ days: 30, z: 1, hold: 16, k: 2 }, swing);
    expect(s.decideExit(ctx(research({ [depthColumn(30)]: 2.5 })), config)).toBe(false);
  });
});

describe('column-reading families in general', () => {
  it('never read ctx.snapshots, so slice truncation cannot reach them', () => {
    // The defect this whole channel exists to fix: a family that derives its
    // own trailing window from ctx.snapshots gets a different factor
    // out-of-sample. Passing an empty snapshots array must change nothing.
    for (const name of ['funding-z-fade', 'depth-imbalance-fade', 'positioning-fade']) {
      const family = STRATEGY_FAMILIES[name];
      const cell = expandGrid(family)[0];
      const s = family.create(cell, swing);
      const column = family.requiresResearchColumns![0];
      const bars = research({ [column]: 9 });
      const withSnapshots = { ...ctx(bars), snapshots: new Array(BARS).fill(null) };
      expect(s.decideEntry(ctx(bars), config)?.side).toBe(
        s.decideEntry(withSnapshots, config)?.side
      );
      expect(s.decideEntry(ctx(bars), config)).not.toBeNull();
    }
  });
});
