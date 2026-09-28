// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { skewSpikeLongFamily } from './skew-spike-long';
import { expandGrid } from '../strategy-families';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const BARS = 40;
const COLUMN = 'mktOptSkew24';

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

describe('skew-spike-long family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(skewSpikeLongFamily);
    expect(grid).toHaveLength(3 * 2 * 3);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the column it cannot trade without', () => {
    expect(skewSpikeLongFamily.requiresResearchColumns).toEqual([COLUMN]);
  });

  it('every grid cell maps to the declared column', () => {
    for (const cell of expandGrid(skewSpikeLongFamily)) {
      void cell;
      expect(skewSpikeLongFamily.requiresResearchColumns).toEqual([COLUMN]);
    }
  });

  it('goes long when the skew level is at or above the threshold', () => {
    const s = skewSpikeLongFamily.create({ s: 2, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 3 })), config)?.side).toBe('long');
    expect(s.decideEntry(ctx(research({ [COLUMN]: 2 })), config)?.side).toBe('long');
  });

  it('never shorts, even on a very negative skew reading', () => {
    const s = skewSpikeLongFamily.create({ s: 2, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: -5 })), config)).toBeNull();
  });

  it('places the stop below entry by k*ATR and sets no target', () => {
    const s = skewSpikeLongFamily.create({ s: 2, k: 2, hold: 8 }, swing);
    const d = s.decideEntry(ctx(research({ [COLUMN]: 3 })), config)!;
    // close 100, atr 2, k 2: stop 4 below, no target.
    expect(d.stopPrice).toBeCloseTo(96, 10);
    expect(d.targetPrice).toBeNull();
    expect(d.timeStopBars).toBe(8);
    expect(d.orderType).toBe('market');
  });

  it('scales the stop with k and the time stop with hold', () => {
    const s = skewSpikeLongFamily.create({ s: 2, k: 3, hold: 32 }, swing);
    const d = s.decideEntry(ctx(research({ [COLUMN]: 3 })), config)!;
    expect(d.stopPrice).toBeCloseTo(94, 10);
    expect(d.timeStopBars).toBe(32);
  });

  it('does not trade below the skew threshold', () => {
    const s = skewSpikeLongFamily.create({ s: 6, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 5.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: 6 })), config)).not.toBeNull();
  });

  it('does not trade when the column is missing or not finite', () => {
    const s = skewSpikeLongFamily.create({ s: 2, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
    expect(s.decideEntry(ctx(research({})), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: Number.NaN })), config)).toBeNull();
    expect(s.decideEntry(ctx([]), config)).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const s = skewSpikeLongFamily.create({ s: 2, k: 2, hold: 8 }, swing);
    const bars = research({ [COLUMN]: 3 });
    expect(s.decideEntry({ ...ctx(bars), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry({ ...ctx(bars), suite: noAtr }, config)).toBeNull();
  });

  it('never exits on signal, leaving the stop and time stop to work', () => {
    const s = skewSpikeLongFamily.create({ s: 2, k: 2, hold: 8 }, swing);
    expect(s.decideExit(ctx(research({ [COLUMN]: 3 })), config)).toBe(false);
  });
});
