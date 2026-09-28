// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { expandGrid } from '../strategy-families';
import { sweepReclaimFamily, sweepReclaimLimitFamily } from './sweep-reclaim';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const BARS = 40;
const SWEEP_BAR = BARS - 2; // ctx.bar - 1: the bar the shifted column describes.
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
const suite = { atr: { current: 2 } } as unknown as IndicatorSuite;
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

// Sweep bar deliberately far from the default 99/101 range so the stop
// arithmetic below cannot be confused with the surrounding candles' own
// high/low.
const SWEEP_BAR_LOW = 90;
const SWEEP_BAR_HIGH = 110;
const sweepBarOverride = { [SWEEP_BAR]: { low: SWEEP_BAR_LOW, high: SWEEP_BAR_HIGH } };

describe('sweep-reclaim family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(sweepReclaimFamily);
    expect(grid).toHaveLength(2 * 3 * 2 * 3);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the columns it cannot trade without', () => {
    expect(sweepReclaimFamily.requiresResearchColumns).toEqual(['sweepReversal20', 'sweepReversal50']);
  });

  it('every grid cell maps to a declared column', () => {
    for (const cell of expandGrid(sweepReclaimFamily)) {
      const column = cell.lookback === 20 ? 'sweepReversal20' : 'sweepReversal50';
      expect(sweepReclaimFamily.requiresResearchColumns).toContain(column);
    }
  });

  it('longs a failed sweep of the low and shorts a failed sweep of the high', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 0 }, swing);
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: 1 }), sweepBarOverride), config)?.side
    ).toBe('long');
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: -1 }), sweepBarOverride), config)?.side
    ).toBe('short');
  });

  it('reads the column its lookback param names and ignores the other', () => {
    const s = sweepReclaimFamily.create({ lookback: 50, rr: 2, hold: 16, regime: 0 }, swing);
    // Only the 20-bar column is present: the 50-bar cell must decline.
    expect(s.decideEntry(ctx(research({ sweepReversal20: 1 }), sweepBarOverride), config)).toBeNull();
    expect(
      s.decideEntry(ctx(research({ sweepReversal50: 1 }), sweepBarOverride), config)?.side
    ).toBe('long');
  });

  it('places the stop below the sweep bar low minus half an ATR and scales the target by rr', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 0 }, swing);
    const d = s.decideEntry(ctx(research({ sweepReversal20: 1 }), sweepBarOverride), config)!;
    // sweep-bar low 90, atr 2: stop = 90 - 0.5*2 = 89. close 100: risk 11, target 100 + 2*11.
    expect(d.side).toBe('long');
    expect(d.stopPrice).toBeCloseTo(89, 10);
    expect(d.targetPrice).toBeCloseTo(122, 10);
    expect(d.timeStopBars).toBe(16);
    expect(d.orderType).toBe('market');
  });

  it('places the stop above the sweep bar high plus half an ATR, mirrored, for a short', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 3, hold: 8, regime: 0 }, swing);
    const d = s.decideEntry(ctx(research({ sweepReversal20: -1 }), sweepBarOverride), config)!;
    // sweep-bar high 110, atr 2: stop = 110 + 0.5*2 = 111. close 100: risk 11, target 100 - 3*11.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(111, 10);
    expect(d.targetPrice).toBeCloseTo(67, 10);
    expect(d.timeStopBars).toBe(8);
  });

  it('does not trade when the sweep bar stop would land on the wrong side of the entry', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 0 }, swing);
    // sweep-bar low 105 (above the 100 close): stop 104, risk -4, not tradeable.
    const bad = { [SWEEP_BAR]: { low: 105, high: 110 } };
    expect(s.decideEntry(ctx(research({ sweepReversal20: 1 }), bad), config)).toBeNull();
  });

  it('does not trade when the column is missing, non-finite, or reads 0', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 0 }, swing);
    expect(s.decideEntry(ctx(research(null), sweepBarOverride), config)).toBeNull();
    expect(s.decideEntry(ctx(research({}), sweepBarOverride), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ sweepReversal20: Number.NaN }), sweepBarOverride), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ sweepReversal20: 0 }), sweepBarOverride), config)).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 0 }, swing);
    const bars = research({ sweepReversal20: 1 });
    expect(s.decideEntry({ ...ctx(bars, sweepBarOverride), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry({ ...ctx(bars, sweepBarOverride), suite: noAtr }, config)).toBeNull();
  });

  it('does not trade before the sweep bar exists', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 0 }, swing);
    // A valid reading at bar 0 itself, so the null comes from the bar < 1
    // guard (there is no bar -1 to have swept), not from a missing column.
    const bars: (ResearchBar | null)[] = new Array(BARS).fill(null);
    bars[0] = { sweepReversal20: 1 };
    const c = { ...ctx(bars, sweepBarOverride), bar: 0 };
    expect(s.decideEntry(c, config)).toBeNull();
  });

  it('regime 1 trades only below the volRatio threshold', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 1 }, swing);
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: 1, volRatio: 0.5 }), sweepBarOverride), config)
    ).not.toBeNull();
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: 1, volRatio: 0.7 }), sweepBarOverride), config)
    ).toBeNull();
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: 1 }), sweepBarOverride), config)
    ).toBeNull(); // volRatio missing
  });

  it('regime 2 trades only at or above the volRatio threshold', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 2 }, swing);
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: 1, volRatio: 0.9 }), sweepBarOverride), config)
    ).not.toBeNull();
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: 1, volRatio: 0.5 }), sweepBarOverride), config)
    ).toBeNull();
  });

  it('regime 0 ignores volRatio entirely', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 0 }, swing);
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: 1 }), sweepBarOverride), config)
    ).not.toBeNull();
  });

  it('never exits on signal, leaving the stop and time stop to work', () => {
    const s = sweepReclaimFamily.create({ lookback: 20, rr: 2, hold: 16, regime: 0 }, swing);
    expect(s.decideExit(ctx(research({ sweepReversal20: 1 }), sweepBarOverride), config)).toBe(false);
  });
});

describe('sweep-reclaim-limit family', () => {
  it('expands to a grid inside the cell cap, with regime dropped', () => {
    const grid = expandGrid(sweepReclaimLimitFamily);
    expect(grid).toHaveLength(2 * 3 * 2 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
    expect(sweepReclaimLimitFamily.params.map((p) => p.name)).not.toContain('regime');
  });

  it('declares the same columns as the base family', () => {
    expect(sweepReclaimLimitFamily.requiresResearchColumns).toEqual(['sweepReversal20', 'sweepReversal50']);
  });

  it('converts the base market entry into a resting limit order', () => {
    const s = sweepReclaimLimitFamily.create({ lookback: 20, rr: 2, hold: 16, timeout: 2 }, swing);
    const d = s.decideEntry(ctx(research({ sweepReversal20: 1 }), sweepBarOverride), config)!;
    expect(d.orderType).toBe('limit');
    expect(d.side).toBe('long');
    expect(d.limitPrice).toBeCloseTo(100, 10); // decision close 100, offset 0 bps.
    expect(d.timeoutBars).toBe(2);
    // Stop/target pass through from the base decision unchanged.
    expect(d.stopPrice).toBeCloseTo(89, 10);
    expect(d.targetPrice).toBeCloseTo(122, 10);
  });

  it('trades regardless of volRatio, since regime is fixed at 0', () => {
    const s = sweepReclaimLimitFamily.create({ lookback: 20, rr: 2, hold: 16, timeout: 1 }, swing);
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: 1, volRatio: 0.9 }), sweepBarOverride), config)
    ).not.toBeNull();
    expect(
      s.decideEntry(ctx(research({ sweepReversal20: 1, volRatio: 0.1 }), sweepBarOverride), config)
    ).not.toBeNull();
  });

  it('never exits on signal', () => {
    const s = sweepReclaimLimitFamily.create({ lookback: 20, rr: 2, hold: 16, timeout: 1 }, swing);
    expect(s.decideExit(ctx(research({ sweepReversal20: 1 }), sweepBarOverride), config)).toBe(false);
  });
});
