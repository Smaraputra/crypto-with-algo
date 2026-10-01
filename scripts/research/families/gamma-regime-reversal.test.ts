// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { expandGrid } from '../strategy-families';
import { gammaRegimeReversalFamily } from './gamma-regime-reversal';
import type { ResearchBar } from '@/lib/backtest/research-series';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';

const BARS = 40;
const ENTRY_BAR = BARS - 1; // the decision/entry bar: entry price is its own close.
const FADE_BAR = ENTRY_BAR - 1; // the bar whose OWN return this family fades -- the
// row mktOptGammaFlow24Z (read at ENTRY_BAR) actually describes, per the shift rule.
const FADE_BAR_PREV = ENTRY_BAR - 2; // needed to compute FADE_BAR's own return.

function candles(overrides: Partial<Record<number, Partial<OHLCV>>> = {}): OHLCV[] {
  return Array.from({ length: BARS }, (_, i) => ({
    timestamp: 1700000000000 + i * 3600000,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
    ...overrides[i],
  }));
}

/** A research series where only `bar` carries the given columns. */
function research(last: Record<string, number> | null, bar = ENTRY_BAR): (ResearchBar | null)[] {
  const bars: (ResearchBar | null)[] = new Array(BARS).fill(null);
  bars[bar] = last;
  return bars;
}

/** Only ATR is read off the suite by this family. */
const suite = { atr: { current: 2 } } as unknown as IndicatorSuite;
const config = {} as BacktestConfig;

function ctx(
  bars: (ResearchBar | null)[],
  candleOverrides: Partial<Record<number, Partial<OHLCV>>> = {},
  bar = ENTRY_BAR,
  interval = '4h'
): StrategyContext {
  return {
    bar,
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

const swing = { style: 'swing_trading', interval: '4h' } as const;

describe('gamma-regime-reversal family', () => {
  it('expands to a grid inside the cell cap', () => {
    const grid = expandGrid(gammaRegimeReversalFamily);
    expect(grid).toHaveLength(3 * 2 * 2 * 2);
    expect(grid.length).toBeLessThanOrEqual(60);
  });

  it('declares the gamma-flow column it cannot trade without', () => {
    expect(gammaRegimeReversalFamily.requiresResearchColumns).toEqual(['mktOptGammaFlow24Z']);
  });

  it('shorts when the fade bar (ctx.bar - 1) rose past +r and the gate is met', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    // FADE_BAR_PREV close 100 (default), FADE_BAR close 100.6 -> fade-bar ret1 +0.6%.
    const overrides = { [FADE_BAR]: { close: 100.6 } };
    const d = s.decideEntry(ctx(research({ mktOptGammaFlow24Z: -1.5 }), overrides), config);
    expect(d?.side).toBe('short');
  });

  it('longs when the fade bar (ctx.bar - 1) fell past -r and the gate is met', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    const overrides = { [FADE_BAR]: { close: 99.4 } }; // fade-bar ret1 -0.6%
    const d = s.decideEntry(ctx(research({ mktOptGammaFlow24Z: -1.5 }), overrides), config);
    expect(d?.side).toBe('long');
  });

  it('fades bar i-1, not bar i: opposite-signed same-bar and fade-bar returns must trade on the fade bar', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    // FADE_BAR_PREV close 100, FADE_BAR close 105: fade-bar (i-1) ret1 = +5% (rise).
    // ENTRY_BAR close 95: candles[i]/candles[i-1] - 1 = 95/105 - 1 ~ -9.5% (fall) --
    // the OLD, wrong pairing this family used to compute. The two returns have
    // opposite signs, so only the correct (fade-bar) pairing decides the side.
    const overrides = { [FADE_BAR_PREV]: { close: 100 }, [FADE_BAR]: { close: 105 }, [ENTRY_BAR]: { close: 95 } };
    const d = s.decideEntry(ctx(research({ mktOptGammaFlow24Z: -1.5 }), overrides), config);
    // Fade-bar rose (+5%) -> fade it with a short. The old pairing (bar i fell 9.5%)
    // would have gone long instead, so this assertion fails under the old code.
    expect(d?.side).toBe('short');
  });

  it('sizes the short stop k*ATR above the entry close and the target at 1R below', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    const overrides = { [FADE_BAR]: { close: 105 }, [ENTRY_BAR]: { close: 100.6 } }; // fade-bar ret1 +5%
    const d = s.decideEntry(ctx(research({ mktOptGammaFlow24Z: -1.5 }), overrides), config)!;
    // entry close 100.6, atr 2, k 2: stop 100.6 + 4 = 104.6, risk 4, target 100.6 - 4 = 96.6.
    expect(d.side).toBe('short');
    expect(d.stopPrice).toBeCloseTo(104.6, 10);
    expect(d.targetPrice).toBeCloseTo(96.6, 10);
    expect(d.timeStopBars).toBe(4);
    expect(d.orderType).toBe('market');
  });

  it('sizes the long stop k*ATR below the entry close and the target at 1R above, mirrored', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 3, hold: 2 }, swing);
    const overrides = { [FADE_BAR]: { close: 95 }, [ENTRY_BAR]: { close: 99.4 } }; // fade-bar ret1 -5%
    const d = s.decideEntry(ctx(research({ mktOptGammaFlow24Z: -1.5 }), overrides), config)!;
    // entry close 99.4, atr 2, k 3: stop 99.4 - 6 = 93.4, risk 6, target 99.4 + 6 = 105.4.
    expect(d.side).toBe('long');
    expect(d.stopPrice).toBeCloseTo(93.4, 10);
    expect(d.targetPrice).toBeCloseTo(105.4, 10);
    expect(d.timeStopBars).toBe(2);
  });

  it('does not trade when the fade-bar return is inside the +/- r band', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    const overrides = { [FADE_BAR]: { close: 100.3 } }; // fade-bar ret1 +0.3%, below r 0.5%
    expect(s.decideEntry(ctx(research({ mktOptGammaFlow24Z: -1.5 }), overrides), config)).toBeNull();
  });

  it('does not trade exactly at the r boundary (strict above/below)', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    const overrides = { [FADE_BAR]: { close: 100.5 } }; // fade-bar ret1 exactly +0.5%
    expect(s.decideEntry(ctx(research({ mktOptGammaFlow24Z: -1.5 }), overrides), config)).toBeNull();
  });

  it('does not trade when the negative-gamma-flow gate is not met', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    const overrides = { [FADE_BAR]: { close: 100.6 } };
    // -0.5 is negative but does not clear the g=1 gate (-0.5 > -1).
    expect(s.decideEntry(ctx(research({ mktOptGammaFlow24Z: -0.5 }), overrides), config)).toBeNull();
    // Positive flow is the dealers-short-gamma mirror regime, not traded this round.
    expect(s.decideEntry(ctx(research({ mktOptGammaFlow24Z: 1.5 }), overrides), config)).toBeNull();
  });

  it('does not trade when the gamma-flow column is missing, absent, or non-finite', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    const overrides = { [FADE_BAR]: { close: 100.6 } };
    expect(s.decideEntry(ctx(research(null), overrides), config)).toBeNull();
    expect(s.decideEntry(ctx(research({}), overrides), config)).toBeNull();
    expect(
      s.decideEntry(ctx(research({ mktOptGammaFlow24Z: Number.NaN }), overrides), config)
    ).toBeNull();
  });

  it('does not trade without an indicator suite or a usable ATR', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    const overrides = { [FADE_BAR]: { close: 100.6 } };
    const bars = research({ mktOptGammaFlow24Z: -1.5 });
    expect(s.decideEntry({ ...ctx(bars, overrides), suite: null }, config)).toBeNull();
    const noAtr = { atr: { current: 0 } } as unknown as IndicatorSuite;
    expect(s.decideEntry({ ...ctx(bars, overrides), suite: noAtr }, config)).toBeNull();
  });

  it('does not trade before two previous completed bars exist', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    // bar 1 has only one earlier bar (bar 0); bar -1 does not exist, so the
    // fade-bar's own return cannot be computed. The bar < 2 guard must decline.
    const bars = research({ mktOptGammaFlow24Z: -1.5 }, 1);
    const c = ctx(bars, { 0: { close: 100.6 } }, 1);
    expect(s.decideEntry(c, config)).toBeNull();
  });

  it('does not trade when the entry close or either fade-bar close is non-finite', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    const bars = research({ mktOptGammaFlow24Z: -1.5 });
    expect(
      s.decideEntry(ctx(bars, { [ENTRY_BAR]: { close: Number.NaN } }), config)
    ).toBeNull();
    expect(
      s.decideEntry(ctx(bars, { [FADE_BAR]: { close: Number.NaN } }), config)
    ).toBeNull();
    expect(
      s.decideEntry(ctx(bars, { [FADE_BAR_PREV]: { close: Number.NaN } }), config)
    ).toBeNull();
  });

  it('never exits on signal, leaving the stop, target, and time stop to work', () => {
    const s = gammaRegimeReversalFamily.create({ g: 1, r: 0.005, k: 2, hold: 4 }, swing);
    const overrides = { [FADE_BAR]: { close: 100.6 } };
    expect(
      s.decideExit(ctx(research({ mktOptGammaFlow24Z: -1.5 }), overrides), config)
    ).toBe(false);
  });
});
