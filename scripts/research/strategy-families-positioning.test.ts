// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STRATEGY_FAMILIES, expandGrid } from './strategy-families';
import { positioningColumn } from './research-columns';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const family = STRATEGY_FAMILIES['positioning-fade'];
const horizon = STRATEGY_FAMILIES['positioning-horizon'];

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

/** Only ATR is read by the family. */
const suite = { atr: { current: 2 } } as unknown as IndicatorSuite;
const config = {} as BacktestConfig;

function ctx(bars: (ResearchBar | null)[]): StrategyContext {
  return {
    bar: BARS - 1,
    candles: candles(BARS),
    interval: '4h',
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

const swing4h = { style: 'swing_trading', interval: '4h' } as const;
const z720 = (value: number) => research({ [positioningColumn(720)]: value });

describe('positioning-fade family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(family);
    expect(grid).toHaveLength(3 * 3 * 3 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the columns it cannot trade without', () => {
    expect(family.requiresResearchColumns).toEqual([
      positioningColumn(180), positioningColumn(360), positioningColumn(720),
    ]);
  });

  it('every grid cell maps to a declared column', () => {
    for (const cell of expandGrid(family)) {
      expect(family.requiresResearchColumns).toContain(positioningColumn(cell.window));
    }
  });

  it('shorts a crowded long book and longs a crowded short one', () => {
    const s = family.create({ window: 720, z: 1, hold: 16, k: 2 }, swing4h);
    expect(s.decideEntry(ctx(z720(2.5)), config)?.side).toBe('short');
    expect(s.decideEntry(ctx(z720(-2.5)), config)?.side).toBe('long');
  });

  it('reads the column its window param names and ignores the others', () => {
    const s = family.create({ window: 720, z: 1, hold: 16, k: 2 }, swing4h);
    expect(s.decideEntry(ctx(research({ [positioningColumn(180)]: 9 })), config)).toBeNull();
    const both = research({ [positioningColumn(180)]: -9, [positioningColumn(720)]: 9 });
    expect(s.decideEntry(ctx(both), config)?.side).toBe('short');
  });

  it('places the stop and target on the correct sides', () => {
    const s = family.create({ window: 720, z: 1, hold: 16, k: 2 }, swing4h);
    const d = s.decideEntry(ctx(z720(2.5)), config)!;
    // close 100, atr 2, k 2: stop above for a short, target below, 2:1.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(104, 10);
    expect(d.targetPrice).toBeCloseTo(92, 10);
    expect(d.timeStopBars).toBe(16);
    expect(d.orderType).toBe('market');
  });

  it('does not trade below the z threshold', () => {
    const s = family.create({ window: 720, z: 2, hold: 16, k: 2 }, swing4h);
    expect(s.decideEntry(ctx(z720(1.9)), config)).toBeNull();
    expect(s.decideEntry(ctx(z720(2)), config)).not.toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const s = family.create({ window: 720, z: 1, hold: 16, k: 2 }, swing4h);
    expect(s.decideEntry({ ...ctx(z720(2.5)), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry({ ...ctx(z720(2.5)), suite: noAtr }, config)).toBeNull();
  });

  it('does not trade on a bar with no positioning reading', () => {
    const s = family.create({ window: 720, z: 1, hold: 16, k: 2 }, swing4h);
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
    expect(s.decideEntry(ctx(research({})), config)).toBeNull();
    expect(
      s.decideEntry(ctx(research({ [positioningColumn(720)]: Number.NaN })), config)
    ).toBeNull();
  });

  it('never exits on signal, leaving stops and the time stop to work', () => {
    const s = family.create({ window: 720, z: 1, hold: 16, k: 2 }, swing4h);
    expect(s.decideExit(ctx(z720(2.5)), config)).toBe(false);
  });
});

describe('positioning-horizon family', () => {
  it('expands to a grid inside the cell cap', () => {
    expect(expandGrid(horizon)).toHaveLength(3 * 3 * 3);
  });

  it('takes the same side as positioning-fade on the same reading', () => {
    const p = { window: 720, z: 1, hold: 16 };
    const h = horizon.create(p, swing4h);
    const f = family.create({ ...p, k: 2 }, swing4h);
    expect(h.decideEntry(ctx(z720(2.5)), config)?.side).toBe(
      f.decideEntry(ctx(z720(2.5)), config)?.side
    );
  });

  it('keeps the stop far away and sets no target, so the time stop is the exit', () => {
    const h = horizon.create({ window: 720, z: 1, hold: 32 }, swing4h);
    const d = h.decideEntry(ctx(z720(2.5)), config)!;
    // close 100, atr 2, 10 ATR: the stop sits 20 away, not 4.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(120, 10);
    expect(d.targetPrice).toBeNull();
    expect(d.timeStopBars).toBe(32);
  });

  it('never exits on signal', () => {
    const h = horizon.create({ window: 720, z: 1, hold: 16 }, swing4h);
    expect(h.decideExit(ctx(z720(2.5)), config)).toBe(false);
  });
});
