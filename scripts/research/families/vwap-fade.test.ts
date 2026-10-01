// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { expandGrid } from '../strategy-families';
import { vwapFadeFamily } from './vwap-fade';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const BARS = 40;
const COLUMN = 'vwapDevZ';

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

/** A research series carrying the final bar's own reading AND the bar
 * before it, for the slope gate. */
function researchWithPrevious(
  current: Record<string, number> | null,
  previous: Record<string, number> | null
): (ResearchBar | null)[] {
  const bars = research(current);
  bars[BARS - 2] = previous;
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

describe('vwap-fade family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(vwapFadeFamily);
    expect(grid).toHaveLength(3 * 2 * 2 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the column it cannot trade without', () => {
    expect(vwapFadeFamily.requiresResearchColumns).toEqual([COLUMN]);
  });

  it('every grid cell maps to the declared column', () => {
    for (const cell of expandGrid(vwapFadeFamily)) {
      expect(vwapFadeFamily.requiresResearchColumns).toContain(COLUMN);
      expect(cell).toHaveProperty('z');
    }
  });

  it('shorts a stretch above VWAP and longs a stretch below, slope off', () => {
    const s = vwapFadeFamily.create({ z: 1.5, slope: 0, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 2.5 })), config)?.side).toBe('short');
    expect(s.decideEntry(ctx(research({ [COLUMN]: -2.5 })), config)?.side).toBe('long');
  });

  it('places the stop and target on the correct sides, 2R target', () => {
    const s = vwapFadeFamily.create({ z: 1.5, slope: 0, k: 2, hold: 16 }, swing);
    const d = s.decideEntry(ctx(research({ [COLUMN]: 2.5 })), config)!;
    // close 100, atr 2, k 2: short stop above, target 2R below.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(104, 10);
    expect(d.targetPrice).toBeCloseTo(92, 10);
    expect(d.timeStopBars).toBe(16);
    expect(d.orderType).toBe('market');
  });

  it('scales the stop with k and keeps the 2:1 target ratio, long side', () => {
    const s = vwapFadeFamily.create({ z: 1.5, slope: 0, k: 3, hold: 8 }, swing);
    const d = s.decideEntry(ctx(research({ [COLUMN]: -2.5 })), config)!;
    expect(d.side).toBe('long');
    expect(d.stopPrice).toBeCloseTo(94, 10);
    expect(d.targetPrice).toBeCloseTo(112, 10);
    expect(d.timeStopBars).toBe(8);
  });

  it('does not trade below the z threshold', () => {
    const s = vwapFadeFamily.create({ z: 2, slope: 0, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 1.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: -1.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: 2 })), config)).not.toBeNull();
  });

  it('does not trade when the column is missing or not finite', () => {
    const s = vwapFadeFamily.create({ z: 1.5, slope: 0, k: 2, hold: 8 }, swing);
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
    expect(s.decideEntry(ctx(research({})), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: Number.NaN })), config)).toBeNull();
    expect(s.decideEntry(ctx([]), config)).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const s = vwapFadeFamily.create({ z: 1.5, slope: 0, k: 2, hold: 8 }, swing);
    const bars = research({ [COLUMN]: 2.5 });
    expect(s.decideEntry({ ...ctx(bars), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry({ ...ctx(bars), suite: noAtr }, config)).toBeNull();
  });

  describe('slope gate (slope = 1)', () => {
    it('trades when the previous reading is further from zero (easing)', () => {
      const s = vwapFadeFamily.create({ z: 1.5, slope: 1, k: 2, hold: 8 }, swing);
      // current 2.0, previous 3.0: |previous| > |current|, stretch easing.
      const bars = researchWithPrevious({ [COLUMN]: 2.0 }, { [COLUMN]: 3.0 });
      expect(s.decideEntry(ctx(bars), config)?.side).toBe('short');
    });

    it('trades when the previous reading is within 0.25 of the current one (flat)', () => {
      const s = vwapFadeFamily.create({ z: 1.5, slope: 1, k: 2, hold: 8 }, swing);
      const bars = researchWithPrevious({ [COLUMN]: 2.0 }, { [COLUMN]: 1.8 });
      expect(s.decideEntry(ctx(bars), config)?.side).toBe('short');
    });

    it('declines when the reading is still stretching away from zero', () => {
      const s = vwapFadeFamily.create({ z: 1.5, slope: 1, k: 2, hold: 8 }, swing);
      // current 2.5, previous 1.5: |previous| < |current| and more than 0.25 apart.
      const bars = researchWithPrevious({ [COLUMN]: 2.5 }, { [COLUMN]: 1.5 });
      expect(s.decideEntry(ctx(bars), config)).toBeNull();
    });

    it('declines when the previous reading is missing or not finite', () => {
      const s = vwapFadeFamily.create({ z: 1.5, slope: 1, k: 2, hold: 8 }, swing);
      const missing = researchWithPrevious({ [COLUMN]: 2.5 }, null);
      expect(s.decideEntry(ctx(missing), config)).toBeNull();
      const nonFinite = researchWithPrevious({ [COLUMN]: 2.5 }, { [COLUMN]: Number.NaN });
      expect(s.decideEntry(ctx(nonFinite), config)).toBeNull();
    });
  });

  it('never exits on signal, leaving stops and the time stop to work', () => {
    const s = vwapFadeFamily.create({ z: 1.5, slope: 0, k: 2, hold: 8 }, swing);
    expect(s.decideExit(ctx(research({ [COLUMN]: 2.5 })), config)).toBe(false);
  });
});
