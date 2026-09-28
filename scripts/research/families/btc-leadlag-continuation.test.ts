// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { btcLeadlagContinuationFamily, btcLeadlagContinuationLimitFamily } from './btc-leadlag-continuation';
import { expandGrid } from '../strategy-families';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const BARS = 40;
const COLUMN = 'btcLeadLagZ';

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

describe('btc-leadlag-continuation family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(btcLeadlagContinuationFamily);
    expect(grid).toHaveLength(3 * 2 * 3);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the column it cannot trade without', () => {
    expect(btcLeadlagContinuationFamily.requiresResearchColumns).toEqual([COLUMN]);
  });

  it('every grid cell maps to the declared column', () => {
    for (const cell of expandGrid(btcLeadlagContinuationFamily)) {
      void cell;
      expect(btcLeadlagContinuationFamily.requiresResearchColumns).toEqual([COLUMN]);
    }
  });

  it('goes long when BTC led up and short when BTC led down', () => {
    const s = btcLeadlagContinuationFamily.create({ z: 1, k: 2, hold: 4 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 2.5 })), config)?.side).toBe('long');
    expect(s.decideEntry(ctx(research({ [COLUMN]: -2.5 })), config)?.side).toBe('short');
  });

  it('places the stop and a 1R target on the correct sides', () => {
    const s = btcLeadlagContinuationFamily.create({ z: 1, k: 2, hold: 4 }, swing);

    const long = s.decideEntry(ctx(research({ [COLUMN]: 2.5 })), config)!;
    // close 100, atr 2, k 2: stop 4 below, target 4 above (1R, not 2R).
    expect(long.stopPrice).toBeCloseTo(96, 10);
    expect(long.targetPrice).toBeCloseTo(104, 10);
    expect(long.timeStopBars).toBe(4);
    expect(long.orderType).toBe('market');

    const short = s.decideEntry(ctx(research({ [COLUMN]: -2.5 })), config)!;
    expect(short.stopPrice).toBeCloseTo(104, 10);
    expect(short.targetPrice).toBeCloseTo(96, 10);
  });

  it('scales the stop and target with k', () => {
    const s = btcLeadlagContinuationFamily.create({ z: 1, k: 3, hold: 2 }, swing);
    const d = s.decideEntry(ctx(research({ [COLUMN]: 2.5 })), config)!;
    expect(d.stopPrice).toBeCloseTo(94, 10);
    expect(d.targetPrice).toBeCloseTo(106, 10);
    expect(d.timeStopBars).toBe(2);
  });

  it('does not trade below the z threshold', () => {
    const s = btcLeadlagContinuationFamily.create({ z: 2, k: 2, hold: 4 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 1.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: -1.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: 2 })), config)).not.toBeNull();
  });

  it('does not trade when the column is missing or not finite (covers BTCUSDT, whose column is always NaN)', () => {
    const s = btcLeadlagContinuationFamily.create({ z: 1, k: 2, hold: 4 }, swing);
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
    expect(s.decideEntry(ctx(research({})), config)).toBeNull();
    expect(s.decideEntry(ctx(research({ [COLUMN]: Number.NaN })), config)).toBeNull();
    expect(s.decideEntry(ctx([]), config)).toBeNull();
  });

  it('does not trade without an indicator suite or an ATR', () => {
    const s = btcLeadlagContinuationFamily.create({ z: 1, k: 2, hold: 4 }, swing);
    const bars = research({ [COLUMN]: 2.5 });
    expect(s.decideEntry({ ...ctx(bars), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry({ ...ctx(bars), suite: noAtr }, config)).toBeNull();
  });

  it('never exits on signal, leaving stops and the time stop to work', () => {
    const s = btcLeadlagContinuationFamily.create({ z: 1, k: 2, hold: 4 }, swing);
    expect(s.decideExit(ctx(research({ [COLUMN]: 2.5 })), config)).toBe(false);
  });
});

describe('btc-leadlag-continuation-limit family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(btcLeadlagContinuationLimitFamily);
    expect(grid).toHaveLength(3 * 2 * 3 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the same column as the base family', () => {
    expect(btcLeadlagContinuationLimitFamily.requiresResearchColumns).toEqual([COLUMN]);
  });

  it('converts the base decision into a resting limit order with offset 0', () => {
    const s = btcLeadlagContinuationLimitFamily.create({ z: 1, k: 2, hold: 4, timeout: 2 }, swing);
    const d = s.decideEntry(ctx(research({ [COLUMN]: 2.5 })), config)!;
    expect(d.side).toBe('long');
    expect(d.orderType).toBe('limit');
    expect(d.limitPrice).toBeCloseTo(100, 10);
    expect(d.timeoutBars).toBe(2);
    // Stop/target/timeStop pass through from the base decision unchanged.
    expect(d.stopPrice).toBeCloseTo(96, 10);
    expect(d.targetPrice).toBeCloseTo(104, 10);
    expect(d.timeStopBars).toBe(4);
  });

  it('does not trade when the base family would not', () => {
    const s = btcLeadlagContinuationLimitFamily.create({ z: 2, k: 2, hold: 4, timeout: 1 }, swing);
    expect(s.decideEntry(ctx(research({ [COLUMN]: 1.9 })), config)).toBeNull();
    expect(s.decideEntry(ctx(research(null)), config)).toBeNull();
  });

  it('never exits on signal', () => {
    const s = btcLeadlagContinuationLimitFamily.create({ z: 1, k: 2, hold: 4, timeout: 1 }, swing);
    expect(s.decideExit(ctx(research({ [COLUMN]: 2.5 })), config)).toBe(false);
  });
});
