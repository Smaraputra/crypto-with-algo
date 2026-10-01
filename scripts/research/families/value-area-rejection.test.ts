// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { expandGrid } from '../strategy-families';
import { valueAreaRejectionFamily } from './value-area-rejection';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';
import type { OpenPosition } from '@/lib/backtest/trade-utils';

const BARS = 40;
const OUTSIDE_VALUE_COLUMN = 'outsideValue';
const POC_DIST_COLUMN = 'pocDist';
const VOL_RATIO_COLUMN = 'volRatio';

function candles(n: number): OHLCV[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: 1700000000000 + i * 3600000,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
}

/** A research series where the final bar (the current reading) carries the
 * given columns. */
function research(last: Record<string, number> | null): (ResearchBar | null)[] {
  const bars: (ResearchBar | null)[] = new Array(BARS).fill(null);
  bars[BARS - 1] = last;
  return bars;
}

/** A research series carrying the final bar's own reading (current, index
 * bar) AND the bar before it (previous, index bar - 1), for the
 * outside-then-inside transition. */
function researchWithPrevious(
  current: Record<string, number> | null,
  previous: Record<string, number> | null
): (ResearchBar | null)[] {
  const bars = research(current);
  bars[BARS - 2] = previous;
  return bars;
}

/** Only ATR is read off the suite by this family. */
const suite = { atr: { current: 2 } } as unknown as IndicatorSuite;
const config = {} as BacktestConfig;

function ctx(
  bars: (ResearchBar | null)[],
  overrides: Partial<StrategyContext> = {}
): StrategyContext {
  return {
    bar: BARS - 1,
    candles: candles(BARS),
    interval: '1h',
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
    ...overrides,
  };
}

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    entryBar: 0,
    entryTime: 1700000000000,
    entryPrice: 100,
    side: 'long',
    quantity: 1,
    entryScore: 0,
    entryTier: 'neutral',
    stopPrice: 95,
    targetPrice: 105,
    timeStopBars: null,
    entrySlippageCost: 0,
    ...overrides,
  };
}

const swing = { style: 'swing_trading', interval: '1h' } as const;

/** current 0 (back inside) + previous +1 (rejected from above) is the short
 * setup; previous -1 (rejected from below) is the long setup. */
function outsideThenInside(previousOutsideValue: 1 | -1): (ResearchBar | null)[] {
  return researchWithPrevious(
    { [OUTSIDE_VALUE_COLUMN]: 0 },
    { [OUTSIDE_VALUE_COLUMN]: previousOutsideValue }
  );
}

describe('value-area-rejection family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(valueAreaRejectionFamily);
    expect(grid).toHaveLength(2 * 2 * 3 * 3);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the columns it cannot trade without', () => {
    expect(valueAreaRejectionFamily.requiresResearchColumns).toEqual([
      OUTSIDE_VALUE_COLUMN, POC_DIST_COLUMN, VOL_RATIO_COLUMN,
    ]);
  });

  it('every grid cell has the declared params', () => {
    for (const cell of expandGrid(valueAreaRejectionFamily)) {
      expect(cell).toHaveProperty('k');
      expect(cell).toHaveProperty('mode');
      expect(cell).toHaveProperty('hold');
      expect(cell).toHaveProperty('regime');
    }
  });

  it('shorts a rejection from above and longs a rejection from below', () => {
    const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 0, hold: 8, regime: 0 }, swing);
    expect(s.decideEntry(ctx(outsideThenInside(1)), config)?.side).toBe('short');
    expect(s.decideEntry(ctx(outsideThenInside(-1)), config)?.side).toBe('long');
  });

  it('places the stop and target on the correct sides, 2R target', () => {
    const s = valueAreaRejectionFamily.create({ k: 2, mode: 0, hold: 16, regime: 0 }, swing);
    const d = s.decideEntry(ctx(outsideThenInside(1)), config)!;
    // close 100, atr 2, k 2: short stop above (risk 4), target 2R below.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(104, 10);
    expect(d.targetPrice).toBeCloseTo(92, 10);
    expect(d.timeStopBars).toBe(16);
    expect(d.orderType).toBe('market');
  });

  it('scales the stop with k and keeps the 2:1 target ratio, long side', () => {
    const s = valueAreaRejectionFamily.create({ k: 2.5, mode: 0, hold: 8, regime: 0 }, swing);
    const d = s.decideEntry(ctx(outsideThenInside(-1)), config)!;
    expect(d.side).toBe('long');
    expect(d.stopPrice).toBeCloseTo(95, 10);
    expect(d.targetPrice).toBeCloseTo(110, 10);
    expect(d.timeStopBars).toBe(8);
  });

  it('does not trade when still outside the value area (current reading not 0)', () => {
    const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 0, hold: 8, regime: 0 }, swing);
    expect(s.decideEntry(ctx(researchWithPrevious({ [OUTSIDE_VALUE_COLUMN]: 1 }, { [OUTSIDE_VALUE_COLUMN]: 1 })), config)).toBeNull();
    expect(s.decideEntry(ctx(researchWithPrevious({ [OUTSIDE_VALUE_COLUMN]: -1 }, { [OUTSIDE_VALUE_COLUMN]: -1 })), config)).toBeNull();
  });

  it('does not trade when the previous bar was never outside the value area', () => {
    const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 0, hold: 8, regime: 0 }, swing);
    expect(s.decideEntry(ctx(researchWithPrevious({ [OUTSIDE_VALUE_COLUMN]: 0 }, { [OUTSIDE_VALUE_COLUMN]: 0 })), config)).toBeNull();
  });

  it('does not trade when either reading is missing or not finite', () => {
    const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 0, hold: 8, regime: 0 }, swing);
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
    expect(s.decideEntry(ctx(research({})), config)).toBeNull();
    expect(s.decideEntry(ctx(researchWithPrevious({ [OUTSIDE_VALUE_COLUMN]: 0 }, null)), config)).toBeNull();
    expect(
      s.decideEntry(ctx(researchWithPrevious({ [OUTSIDE_VALUE_COLUMN]: 0 }, { [OUTSIDE_VALUE_COLUMN]: Number.NaN })), config)
    ).toBeNull();
    expect(
      s.decideEntry(ctx(researchWithPrevious({ [OUTSIDE_VALUE_COLUMN]: Number.NaN }, { [OUTSIDE_VALUE_COLUMN]: 1 })), config)
    ).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 0, hold: 8, regime: 0 }, swing);
    const bars = outsideThenInside(1);
    expect(s.decideEntry(ctx(bars, { suite: null }), config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry(ctx(bars, { suite: noAtr }), config)).toBeNull();
  });

  describe('regime filter', () => {
    function withVolRatio(previousOutsideValue: 1 | -1, volRatio: number | undefined): (ResearchBar | null)[] {
      const bars = outsideThenInside(previousOutsideValue);
      const currentValues = { ...(bars[BARS - 1] ?? {}) };
      if (volRatio !== undefined) currentValues[VOL_RATIO_COLUMN] = volRatio;
      bars[BARS - 1] = currentValues;
      return bars;
    }

    it('regime 0 ignores volRatio, even when it is missing', () => {
      const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 0, hold: 8, regime: 0 }, swing);
      expect(s.decideEntry(ctx(withVolRatio(1, undefined)), config)).not.toBeNull();
      expect(s.decideEntry(ctx(withVolRatio(1, 0.9)), config)).not.toBeNull();
    });

    it('regime 1 trades only when volRatio < 0.7', () => {
      const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 0, hold: 8, regime: 1 }, swing);
      expect(s.decideEntry(ctx(withVolRatio(1, 0.5)), config)).not.toBeNull();
      expect(s.decideEntry(ctx(withVolRatio(1, 0.7)), config)).toBeNull();
      expect(s.decideEntry(ctx(withVolRatio(1, 0.9)), config)).toBeNull();
      expect(s.decideEntry(ctx(withVolRatio(1, undefined)), config)).toBeNull();
    });

    it('regime 2 trades only when volRatio >= 0.7', () => {
      const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 0, hold: 8, regime: 2 }, swing);
      expect(s.decideEntry(ctx(withVolRatio(1, 0.9)), config)).not.toBeNull();
      expect(s.decideEntry(ctx(withVolRatio(1, 0.7)), config)).not.toBeNull();
      expect(s.decideEntry(ctx(withVolRatio(1, 0.5)), config)).toBeNull();
      expect(s.decideEntry(ctx(withVolRatio(1, undefined)), config)).toBeNull();
    });
  });

  describe('exit (mode)', () => {
    it('mode 0 never exits on signal, leaving the 2R target and time stop to work', () => {
      const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 0, hold: 8, regime: 0 }, swing);
      const shortCtx = ctx(research({ [POC_DIST_COLUMN]: -0.5 }), { position: makePosition({ side: 'short' }) });
      expect(s.decideExit(shortCtx, config)).toBe(false);
    });

    it('mode 1 exits a short once pocDist has crossed to zero or below', () => {
      const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 1, hold: 8, regime: 0 }, swing);
      const stillAbove = ctx(research({ [POC_DIST_COLUMN]: 0.2 }), { position: makePosition({ side: 'short' }) });
      expect(s.decideExit(stillAbove, config)).toBe(false);
      const atPoc = ctx(research({ [POC_DIST_COLUMN]: 0 }), { position: makePosition({ side: 'short' }) });
      expect(s.decideExit(atPoc, config)).toBe(true);
      const pastPoc = ctx(research({ [POC_DIST_COLUMN]: -0.1 }), { position: makePosition({ side: 'short' }) });
      expect(s.decideExit(pastPoc, config)).toBe(true);
    });

    it('mode 1 exits a long once pocDist has crossed to zero or above', () => {
      const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 1, hold: 8, regime: 0 }, swing);
      const stillBelow = ctx(research({ [POC_DIST_COLUMN]: -0.2 }), { position: makePosition({ side: 'long' }) });
      expect(s.decideExit(stillBelow, config)).toBe(false);
      const pastPoc = ctx(research({ [POC_DIST_COLUMN]: 0.1 }), { position: makePosition({ side: 'long' }) });
      expect(s.decideExit(pastPoc, config)).toBe(true);
    });

    it('mode 1 does not exit without a position or a finite pocDist reading', () => {
      const s = valueAreaRejectionFamily.create({ k: 1.5, mode: 1, hold: 8, regime: 0 }, swing);
      expect(s.decideExit(ctx(research({ [POC_DIST_COLUMN]: 0 })), config)).toBe(false);
      const missing = ctx(research(null), { position: makePosition({ side: 'short' }) });
      expect(s.decideExit(missing, config)).toBe(false);
    });
  });
});
