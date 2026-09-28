// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { expandGrid } from '../strategy-families';
import { bosContinuationFamily } from './bos-continuation';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const BARS = 40;
const ENTRY_BAR = BARS - 1;

function candles(overrides: Partial<Record<number, Partial<OHLCV>>> = {}): OHLCV[] {
  return Array.from({ length: BARS }, (_, i) => ({
    timestamp: 1700000000000 + i * 3600000,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
    ...overrides[i],
  }));
}

/** A research series where the final bar carries the given columns. */
function research(last: Record<string, number> | null): (ResearchBar | null)[] {
  const bars: (ResearchBar | null)[] = new Array(BARS).fill(null);
  bars[ENTRY_BAR] = last;
  return bars;
}

/** Only ATR is read off the suite by this family. */
const suite = { atr: { current: 5 } } as unknown as IndicatorSuite;
const config = {} as BacktestConfig;

function ctx(
  bars: (ResearchBar | null)[],
  candleOverrides: Partial<Record<number, Partial<OHLCV>>> = {},
  interval = '1h'
): StrategyContext {
  return {
    bar: ENTRY_BAR,
    candles: candles(candleOverrides),
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

describe('bos-continuation family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(bosContinuationFamily);
    expect(grid).toHaveLength(2 * 2 * 2 * 3);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the column it cannot trade without', () => {
    expect(bosContinuationFamily.requiresResearchColumns).toEqual(['bosBreak']);
  });

  it('longs on a +1 bosBreak reading and shorts on -1', () => {
    const s = bosContinuationFamily.create({ k: 1, exit: 0, hold: 16, regime: 0 }, swing);
    expect(s.decideEntry(ctx(research({ bosBreak: 1 })), config)?.side).toBe('long');
    expect(s.decideEntry(ctx(research({ bosBreak: -1 })), config)?.side).toBe('short');
  });

  it('places the stop k*ATR against the entry, mirrored, and the fixed target at 2R when exit=0', () => {
    const s = bosContinuationFamily.create({ k: 2, exit: 0, hold: 16, regime: 0 }, swing);
    const long = s.decideEntry(ctx(research({ bosBreak: 1 })), config)!;
    // close 100, atr 5, k 2: stop 100 - 2*5 = 90, risk 10, target 100 + 2*10 = 120.
    expect(long.stopPrice).toBeCloseTo(90, 10);
    expect(long.targetPrice).toBeCloseTo(120, 10);
    expect(long.orderType).toBe('market');

    const short = s.decideEntry(ctx(research({ bosBreak: -1 })), config)!;
    // stop 100 + 2*5 = 110, risk 10, target 100 - 2*10 = 80.
    expect(short.stopPrice).toBeCloseTo(110, 10);
    expect(short.targetPrice).toBeCloseTo(80, 10);
  });

  it('sets timeStopBars from hold', () => {
    const s = bosContinuationFamily.create({ k: 1, exit: 0, hold: 32, regime: 0 }, swing);
    const d = s.decideEntry(ctx(research({ bosBreak: 1 })), config)!;
    expect(d.timeStopBars).toBe(32);
  });

  it('exit=1 has no target and carries a trailing-management hook; exit=0 has no manage hook', () => {
    const managed = bosContinuationFamily.create({ k: 1, exit: 1, hold: 16, regime: 0 }, swing);
    const d = managed.decideEntry(ctx(research({ bosBreak: 1 })), config)!;
    expect(d.targetPrice).toBeNull();
    expect(managed.manage).toBeTypeOf('function');
    expect(managed.name).toBe('bos-continuation');

    const unmanaged = bosContinuationFamily.create({ k: 1, exit: 0, hold: 16, regime: 0 }, swing);
    expect(unmanaged.manage).toBeUndefined();
    expect(unmanaged.name).toBe('bos-continuation');
  });

  it('does not trade when the column is missing, non-finite, or reads 0', () => {
    const s = bosContinuationFamily.create({ k: 1, exit: 0, hold: 16, regime: 0 }, swing);
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
    expect(s.decideEntry(ctx(research({})), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ bosBreak: Number.NaN })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ bosBreak: 0 })), config)).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const s = bosContinuationFamily.create({ k: 1, exit: 0, hold: 16, regime: 0 }, swing);
    const bars = research({ bosBreak: 1 });
    expect(s.decideEntry({ ...ctx(bars), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry({ ...ctx(bars), suite: noAtr }, config)).toBeNull();
  });

  it('regime 1 trades only below the volRatio threshold', () => {
    const s = bosContinuationFamily.create({ k: 1, exit: 0, hold: 16, regime: 1 }, swing);
    expect(s.decideEntry(ctx(research({ bosBreak: 1, volRatio: 0.5 })), config)).not.toBeNull();
    expect(s.decideEntry(ctx(research({ bosBreak: 1, volRatio: 0.7 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ bosBreak: 1 })), config)).toBeNull(); // volRatio missing
  });

  it('regime 2 trades only at or above the volRatio threshold', () => {
    const s = bosContinuationFamily.create({ k: 1, exit: 0, hold: 16, regime: 2 }, swing);
    expect(s.decideEntry(ctx(research({ bosBreak: 1, volRatio: 0.9 })), config)).not.toBeNull();
    expect(s.decideEntry(ctx(research({ bosBreak: 1, volRatio: 0.5 })), config)).toBeNull();
  });

  it('regime 0 ignores volRatio entirely', () => {
    const s = bosContinuationFamily.create({ k: 1, exit: 0, hold: 16, regime: 0 }, swing);
    expect(s.decideEntry(ctx(research({ bosBreak: 1 })), config)).not.toBeNull();
  });

  it('never exits on signal, for both exit=0 and exit=1 cells', () => {
    const fixed = bosContinuationFamily.create({ k: 1, exit: 0, hold: 16, regime: 0 }, swing);
    const managed = bosContinuationFamily.create({ k: 1, exit: 1, hold: 16, regime: 0 }, swing);
    expect(fixed.decideExit(ctx(research({ bosBreak: 1 })), config)).toBe(false);
    expect(managed.decideExit(ctx(research({ bosBreak: 1 })), config)).toBe(false);
  });
});
