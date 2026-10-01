// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dvolSpikeLongFamily, dvolSpikeLongLimitFamily } from './dvol-spike-long';
import { expandGrid } from '../strategy-families';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const BARS = 40;
const COLUMN = 'mktDvolZ30';

function candles(n: number): OHLCV[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: 1700000000000 + i * 3600000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  }));
}

/** A research series where the final bar carries the given columns. */
function research(last: Record<string, number> | null): (ResearchBar | null)[] {
  const bars: (ResearchBar | null)[] = new Array(BARS).fill(null);
  bars[BARS - 1] = last;
  return bars;
}

/** Only ATR is read by this family. */
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

describe('dvol-spike-long family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(dvolSpikeLongFamily);
    expect(grid).toHaveLength(3 * 2 * 3);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the column it cannot trade without', () => {
    expect(dvolSpikeLongFamily.requiresResearchColumns).toEqual([COLUMN]);
  });

  it('every grid cell maps to the declared column', () => {
    for (const cell of expandGrid(dvolSpikeLongFamily)) {
      void cell;
      expect(dvolSpikeLongFamily.requiresResearchColumns).toEqual([COLUMN]);
    }
  });

  it('goes long when the DVOL z is at or above the threshold', () => {
    const s = dvolSpikeLongFamily.create({ z: 1, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 1.5 })), config)?.side).toBe('long');
    expect(s.decideEntry(ctx(research({ [COLUMN]: 1 })), config)?.side).toBe('long');
  });

  it('never shorts, even on a very negative reading', () => {
    const s = dvolSpikeLongFamily.create({ z: 1, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: -3 })), config)).toBeNull();
  });

  it('places the stop below entry by k*ATR and sets no target', () => {
    const s = dvolSpikeLongFamily.create({ z: 1, k: 2, hold: 8 }, swing);
    const d = s.decideEntry(ctx(research({ [COLUMN]: 1.5 })), config)!;
    // close 100, atr 2, k 2: stop 4 below, no target.
    expect(d.stopPrice).toBeCloseTo(96, 10);
    expect(d.targetPrice).toBeNull();
    expect(d.timeStopBars).toBe(8);
    expect(d.orderType).toBe('market');
  });

  it('scales the stop with k and the time stop with hold', () => {
    const s = dvolSpikeLongFamily.create({ z: 1, k: 3, hold: 32 }, swing);
    const d = s.decideEntry(ctx(research({ [COLUMN]: 1.5 })), config)!;
    expect(d.stopPrice).toBeCloseTo(94, 10);
    expect(d.timeStopBars).toBe(32);
  });

  it('does not trade below the z threshold', () => {
    const s = dvolSpikeLongFamily.create({ z: 2, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 1.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: 2 })), config)).not.toBeNull();
  });

  it('does not trade when the column is missing or not finite', () => {
    const s = dvolSpikeLongFamily.create({ z: 1, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
    expect(s.decideEntry(ctx(research({})), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: Number.NaN })), config)).toBeNull();
    expect(s.decideEntry(ctx([]), config)).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const s = dvolSpikeLongFamily.create({ z: 1, k: 2, hold: 8 }, swing);
    const bars = research({ [COLUMN]: 1.5 });
    expect(s.decideEntry({ ...ctx(bars), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry({ ...ctx(bars), suite: noAtr }, config)).toBeNull();
  });

  it('never exits on signal, leaving the stop and time stop to work', () => {
    const s = dvolSpikeLongFamily.create({ z: 1, k: 2, hold: 8 }, swing);
    expect(s.decideExit(ctx(research({ [COLUMN]: 1.5 })), config)).toBe(false);
  });
});

describe('dvol-spike-long-limit family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(dvolSpikeLongLimitFamily);
    expect(grid).toHaveLength(3 * 2 * 3 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the same column as the base family', () => {
    expect(dvolSpikeLongLimitFamily.requiresResearchColumns).toEqual([COLUMN]);
  });

  it('converts the base decision into a resting limit order with offset 0', () => {
    const s = dvolSpikeLongLimitFamily.create({ z: 1, k: 2, hold: 8, timeout: 2 }, swing);
    const d = s.decideEntry(ctx(research({ [COLUMN]: 1.5 })), config)!;
    expect(d.side).toBe('long');
    expect(d.orderType).toBe('limit');
    expect(d.limitPrice).toBeCloseTo(100, 10);
    expect(d.timeoutBars).toBe(2);
    // Stop/timeStop pass through from the base decision unchanged; no target.
    expect(d.stopPrice).toBeCloseTo(96, 10);
    expect(d.targetPrice).toBeNull();
    expect(d.timeStopBars).toBe(8);
  });

  it('does not trade when the base family would not', () => {
    const s = dvolSpikeLongLimitFamily.create({ z: 2, k: 2, hold: 8, timeout: 1 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 1.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
  });

  it('never exits on signal', () => {
    const s = dvolSpikeLongLimitFamily.create({ z: 1, k: 2, hold: 8, timeout: 1 }, swing);
    expect(s.decideExit(ctx(research({ [COLUMN]: 1.5 })), config)).toBe(false);
  });
});
