// @vitest-environment node
//
// Task 4: withManagement (a family wrapper that adds a break-even + ATR
// trailing stop `manage` hook to a base strategy's untouched decideEntry/
// decideExit) and the three registered *-managed families. The engine-level
// wiring of the manage hook itself (bar-loop.ts: not called on the entry
// bar, wrong-side rejection, same-bar application, targetPrice null) is
// covered by src/lib/backtest/bar-loop.test.ts; these tests are about
// withManagement's own trailing logic and the family registrations.
//
// Fix round 1 (task-4-review.md C1). The original version of this wrapper
// read `ctx.candles[ctx.bar]`'s high/low and `currentAtr(ctx.suite)` at a
// time when `ctx.bar` WAS the engine's current (not yet fully elapsed) bar,
// and the engine applied the resulting stop before that same bar's own
// stop/target check -- intrabar lookahead. The fix moved `manage` onto a
// narrower `ManagementContext` (strategy.ts) whose `bar`/`suite` are always
// ONE BAR BEHIND the engine's current bar by construction, and changed the
// wrapper's "favourable extreme" from that single (former current) bar's own
// high/low to a RUNNING max/min over every bar from `position.entryBar`
// through `ctx.bar` inclusive -- every bar already fully known at the
// decision point. The `makeManagementContext` helper below builds exactly
// that narrower context; every test that exercises multiple bars is
// constructing the running-extreme scenario the review required.
import { describe, expect, it, vi } from 'vitest';
import { expandGrid, STRATEGY_FAMILIES, withManagement } from './strategy-families';
import { runBacktest } from '@/lib/backtest/engine';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import type { EntryDecision, ManagementContext, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { OpenPosition } from '@/lib/backtest/trade-utils';
import type { OHLCV } from '@/types/market';

const BASE = 1700000000000;
const HOUR = 60 * 60 * 1000;

function makeCandle(overrides: Partial<OHLCV> = {}, bar = 0): OHLCV {
  return { timestamp: BASE + bar * HOUR, open: 100, high: 100, low: 100, close: 100, volume: 1000, ...overrides };
}

/** A full IndicatorSuite with neutral defaults everywhere except atr, the
 * only field withManagement's manage hook reads (via currentAtr). */
function makeSuite(atrCurrent: number): IndicatorSuite {
  return {
    ema12: { period: 12, values: [], current: 100 },
    ema26: { period: 26, values: [], current: 100 },
    sma50: { period: 50, values: [], current: 100 },
    sma200: { period: 200, values: [], current: 100 },
    rsi: { period: 14, values: [], current: 50 },
    macd: { values: [], current: { MACD: 0, signal: 0, histogram: 0 } },
    bollingerBands: { values: [], current: { upper: 110, middle: 100, lower: 90, pb: 0.5 } },
    atr: { period: 14, values: [], current: atrCurrent },
    stochasticRSI: { values: [], current: { stochRSI: 0.5, k: 50, d: 50 } },
    williamsR: { period: 14, values: [], current: -50 },
    ichimoku: null,
    obv: { values: [], current: 0, sma20: 0 },
    mfi: { period: 14, values: [], current: 50 },
    volumeAnalysis: { currentVolume: 1000, sma20Volume: 1000, ratio: 1, priceChangePercent: 0 },
    signals: { trend: [], momentum: [], volatility: [], volume: [] },
    symbol: 'BTCUSDT',
    interval: '1h',
    candleCount: 0,
    lastCandleTime: BASE,
  };
}

function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    bar: 0,
    candles: [makeCandle()],
    interval: '1h',
    suite: makeSuite(4),
    score: 0,
    tier: 'neutral',
    superTrend: null,
    snapshot: null,
    snapshots: [],
    research: [],
    htfContext: null,
    session: null,
    position: null,
    pendingOrder: null,
    ...overrides,
  };
}

/** Builds the narrower `ManagementContext` `manage` actually receives (see
 * this file's header). `bar` defaults to the last index of `candles` --
 * i.e. candles form the whole history through the "one bar behind" point
 * `manage` is evaluated at, and `position.entryBar` (set by the caller via
 * `position` on `makePosition`) marks where the running-extreme scan
 * starts. */
function makeManagementContext(overrides: Partial<ManagementContext> = {}): ManagementContext {
  const candles = overrides.candles ?? [makeCandle()];
  return {
    bar: candles.length - 1,
    candles,
    interval: '1h',
    suite: makeSuite(4),
    score: 0,
    tier: 'neutral',
    ...overrides,
  };
}

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    entryBar: 0,
    entryTime: BASE,
    entryPrice: 100,
    side: 'long',
    quantity: 1,
    entryScore: 0,
    entryTier: 'neutral',
    stopPrice: 95,
    targetPrice: null,
    timeStopBars: null,
    entrySlippageCost: 0,
    initialStopPrice: 95,
    initialRisk: 5,
    ...overrides,
  };
}

function stubBase(): Strategy {
  return {
    name: 'stub-base',
    decideEntry: () => null,
    decideExit: () => false,
  };
}

describe('withManagement', () => {
  // Fix round 2 (task-4-review.md N3): the running extreme spans
  // (position.entryBar, ctx.bar] -- the entry bar itself is EXCLUDED,
  // because the market entry happens at that bar's close, so its own
  // high/low is partly pre-entry. Every candle array below therefore puts
  // an implausibly extreme decoy value on bar 0 (the entry bar): if the
  // wrapper wrongly included it, the assertions below would fail on a
  // different number than the one actually expected, proving the exclusion
  // rather than merely being consistent with it.
  it('moves the stop to entry once the RUNNING favourable move (since entry) has reached breakEvenR risks, even when the latest bar alone would not', () => {
    const wrapped = withManagement(stubBase(), { breakEvenR: 1, trailStartR: 3, trailAtr: 1 }, 'test-managed', {});
    const position = makePosition({ entryBar: 0, entryPrice: 100, stopPrice: 95, initialRisk: 5 });
    const candles = [
      makeCandle({ high: 100 }, 0), // entry bar; unremarkable, so it cannot affect the outcome even if wrongly included
      makeCandle({ high: 105 }, 1), // the post-entry extreme: favourable move 5 == breakEvenR(1) * initialRisk(5)
      makeCandle({ high: 100 }, 2), // ctx.bar's own bar; alone, its move (0) would not trigger anything
    ];
    const ctx = makeManagementContext({ candles }); // bar defaults to candles.length - 1 = 2

    expect(wrapped.manage!(ctx, position)).toEqual({ stopPrice: 100 });
  });

  it('does not move the stop while the running favourable move across every post-entry bar stays below breakEvenR', () => {
    const wrapped = withManagement(stubBase(), { breakEvenR: 1, trailStartR: 3, trailAtr: 1 }, 'test-managed', {});
    const position = makePosition({ entryBar: 0, entryPrice: 100, stopPrice: 95, initialRisk: 5 });
    const candles = [
      makeCandle({ high: 200 }, 0), // entry bar; deliberately way past threshold -- if wrongly included this test would fail
      makeCandle({ high: 104 }, 1),
      makeCandle({ high: 104.9 }, 2), // running max since entry: 104.9 < 105
    ];
    const ctx = makeManagementContext({ candles });

    expect(wrapped.manage!(ctx, position)).toBeNull();
  });

  it('trails at the RUNNING extreme (since entry) minus trailAtr * ATR once trailStartR is reached, even when the latest bar alone would not reach it', () => {
    const wrapped = withManagement(stubBase(), { breakEvenR: 1, trailStartR: 2, trailAtr: 1.5 }, 'test-managed', {});
    const position = makePosition({ entryBar: 0, entryPrice: 100, stopPrice: 100, initialRisk: 5 });
    const candles = [
      makeCandle({ high: 200 }, 0), // entry bar; if wrongly included the candidate would be 200 - 1.5*4 = 194, not 104
      makeCandle({ high: 110 }, 1), // the true post-entry extreme: favourable move 10 == trailStartR(2) * initialRisk(5)
      makeCandle({ high: 101 }, 2), // ctx.bar's own bar; alone, move 1 would not even clear breakEvenR
    ];
    const ctx = makeManagementContext({ candles, suite: makeSuite(4) }); // trail candidate: 110 - 1.5 * 4 = 104

    expect(wrapped.manage!(ctx, position)).toEqual({ stopPrice: 104 });
  });

  it('never moves the stop against the position (never loosens), using the running extreme since entry', () => {
    const wrapped = withManagement(stubBase(), { breakEvenR: 1, trailStartR: 2, trailAtr: 1.5 }, 'test-managed', {});
    // The trailing candidate off the running post-entry extreme (110 - 1.5 * 4
    // = 104) is LESS favourable than the current stop (106, already trailed
    // further by an earlier call this test does not replay). The entry bar's
    // decoy (200) would, if wrongly included, produce a candidate of 194 --
    // MORE favourable than 106 -- which would flip this test's expectation
    // from null to a returned stop, so this also proves the exclusion.
    const position = makePosition({ entryBar: 0, entryPrice: 100, stopPrice: 106, initialRisk: 5 });
    const candles = [makeCandle({ high: 200 }, 0), makeCandle({ high: 110 }, 1), makeCandle({ high: 101 }, 2)];
    const ctx = makeManagementContext({ candles, suite: makeSuite(4) });

    expect(wrapped.manage!(ctx, position)).toBeNull();
  });

  it('returns null when neither threshold is reached by the running move since entry', () => {
    const wrapped = withManagement(stubBase(), { breakEvenR: 1, trailStartR: 2, trailAtr: 1 }, 'test-managed', {});
    const position = makePosition({ entryBar: 0, entryPrice: 100, stopPrice: 95, initialRisk: 5 });
    const candles = [
      makeCandle({ high: 200 }, 0), // entry bar; deliberately way past threshold -- if wrongly included this test would fail
      makeCandle({ high: 100.05 }, 1),
      makeCandle({ high: 100.1 }, 2),
    ];
    const ctx = makeManagementContext({ candles });

    expect(wrapped.manage!(ctx, position)).toBeNull();
  });

  it('mirrors for shorts, using the running MINIMUM low across post-entry bars', () => {
    const wrapped = withManagement(stubBase(), { breakEvenR: 1, trailStartR: 2, trailAtr: 1.5 }, 'test-managed', {});
    const position = makePosition({ entryBar: 0, side: 'short', entryPrice: 100, stopPrice: 105, initialRisk: 5 });
    const candles = [
      makeCandle({ low: 10 }, 0), // entry bar; if wrongly included the candidate would be 10 + 1.5*4 = 16, not 96
      makeCandle({ low: 90 }, 1), // the true post-entry extreme: favourable move (entry - low) 10 == trailStartR(2) * 5
      makeCandle({ low: 99 }, 2), // ctx.bar's own bar; alone, move 1 would not even clear breakEvenR
    ];
    const ctx = makeManagementContext({ candles, suite: makeSuite(4) }); // trail candidate: 90 + 1.5 * 4 = 96; break-even candidate: 100; best (min) = 96

    expect(wrapped.manage!(ctx, position)).toEqual({ stopPrice: 96 });
  });

  it('falls back to |entryPrice - stopPrice| when initialRisk is absent (a hand-built OpenPosition)', () => {
    const wrapped = withManagement(stubBase(), { breakEvenR: 1, trailStartR: 3, trailAtr: 1 }, 'test-managed', {});
    // No initialRisk: the fallback derives risk 5 from entryPrice(100) -
    // stopPrice(95), exactly like the makePosition default it replaces.
    const position = makePosition({ entryBar: 0, entryPrice: 100, stopPrice: 95, initialRisk: undefined });
    const candles = [
      makeCandle({ high: 100 }, 0), // entry bar; excluded from the running scan
      makeCandle({ high: 105 }, 1), // the post-entry extreme: favourable move 5 == breakEvenR(1) * fallback risk(5)
    ];
    const ctx = makeManagementContext({ candles }); // bar defaults to candles.length - 1 = 1

    expect(wrapped.manage!(ctx, position)).toEqual({ stopPrice: 100 });
  });

  it('produces no candidate on the first bar manage is ever called for (ctx.bar === entryBar), since no post-entry bar has completed yet', () => {
    const wrapped = withManagement(stubBase(), { breakEvenR: 1, trailStartR: 1, trailAtr: 1 }, 'test-managed', {});
    const position = makePosition({ entryBar: 0, entryPrice: 100, stopPrice: 95, initialRisk: 5 });
    // A single candle: the entry bar itself. ctx.bar defaults to 0, equal to
    // entryBar, so the running-extreme loop (entryBar + 1..ctx.bar) never
    // runs, however extreme this bar's own high is.
    const candles = [makeCandle({ high: 1000 }, 0)];
    const ctx = makeManagementContext({ candles });

    expect(wrapped.manage!(ctx, position)).toBeNull();
  });

  it('delegates decideEntry and decideExit to the base strategy untouched', () => {
    const entryDecision: EntryDecision = {
      side: 'long',
      orderType: 'market',
      stopPrice: 90,
      targetPrice: 120,
      timeStopBars: null,
    };
    const base: Strategy = {
      name: 'stub-base',
      decideEntry: vi.fn(() => entryDecision),
      decideExit: vi.fn(() => true),
    };
    const wrapped = withManagement(base, { breakEvenR: 1, trailStartR: 2, trailAtr: 1 }, 'test-managed', { a: 1 });

    const ctx = makeContext();
    const config = {} as Parameters<Strategy['decideEntry']>[1];

    expect(wrapped.decideEntry(ctx, config)).toBe(entryDecision);
    expect(base.decideEntry).toHaveBeenCalledWith(ctx, config);
    expect(wrapped.decideExit(ctx, config)).toBe(true);
    expect(base.decideExit).toHaveBeenCalledWith(ctx, config);
    expect(wrapped.name).toBe('test-managed');
    expect(wrapped.params).toEqual({ a: 1 });
  });
});

describe('withManagement end-to-end: task-4-review.md C1 exact scenario', () => {
  // A long at 100 with initial stop 95 (initialRisk 5) and breakEvenR 1 must
  // NOT scratch at break-even on a bar that opens 104, runs up to 106, and
  // then down to 90: at the moment the engine decides (that bar's open),
  // the running favourable move is only whatever prior bars established
  // (3, in this scenario, from a bar that reached high 103), which is under
  // the breakEvenR(1) * initialRisk(5) = 5 threshold, so the stop must still
  // be the original 95 when that bar's own low (90) breaches it: a genuine
  // -1R loss, not the 0R (or better) scratch the pre-fix lookahead bug
  // produced by reading that bar's own high (106) before deciding.
  const FLAT_PREFIX_BARS = 210;
  const ENTRY_BAR = FLAT_PREFIX_BARS;

  function flatCandle(i: number): OHLCV {
    return { timestamp: BASE + i * HOUR, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 };
  }

  function scenarioCandle(offsetFromEntry: number, ohlc: { open: number; high: number; low: number; close: number }): OHLCV {
    return { timestamp: BASE + (ENTRY_BAR + offsetFromEntry) * HOUR, volume: 1000, ...ohlc };
  }

  it('exits at the original -1R stop (95), not a break-even scratch, on a bar open 104 / high 106 / low 90', () => {
    const base: Strategy = {
      name: 'fixed-entry',
      decideEntry(ctx: StrategyContext) {
        if (ctx.bar !== ENTRY_BAR) return null;
        const close = ctx.candles[ctx.bar].close;
        return { side: 'long', orderType: 'market', stopPrice: close - 5, targetPrice: null, timeStopBars: null };
      },
      decideExit() {
        return false;
      },
    };
    // trailStartR/trailAtr set far out of reach so only break-even is live;
    // this isolates the exact defect the review found.
    const strategy = withManagement(base, { breakEvenR: 1, trailStartR: 100, trailAtr: 1 }, 'c1-scenario', {});

    const prefix = Array.from({ length: FLAT_PREFIX_BARS }, (_, i) => flatCandle(i));
    const candles = [
      ...prefix,
      scenarioCandle(0, { open: 100, high: 100.2, low: 99.8, close: 100 }), // entry bar: stop 95
      scenarioCandle(1, { open: 100, high: 103, low: 99.9, close: 102 }), // favourable move so far: 3 < 5, no break-even yet
      scenarioCandle(2, { open: 104, high: 106, low: 90, close: 95 }), // the review's exact bar
    ];

    const config = { ...DEFAULT_BACKTEST_CONFIG };
    const result = runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);

    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.exitReason).toBe('stop_loss');
    expect(trade.exitPrice).toBe(95); // the ORIGINAL stop, not entryPrice (100, the pre-fix bug's break-even scratch)
    expect(trade.riskPercent).toBeCloseTo(5, 6); // |entryPrice(100) - stopPrice(95)| / entryPrice, unchanged -- proves the stop never moved
    expect(trade.pnl).toBeLessThan(0); // a genuine loss, not the pre-fix bug's 0R (or better) scratch
    expect(trade.managed).toBeFalsy();
  });
});

describe('the three *-managed families', () => {
  it.each(['control-managed', 'depth-imbalance-fade-managed', 'positioning-fade-managed'])(
    '%s expands to 8 grid cells',
    (name) => {
      expect(expandGrid(STRATEGY_FAMILIES[name])).toHaveLength(8);
    }
  );

  it('control-managed declares no required research columns, matching control', () => {
    expect(STRATEGY_FAMILIES['control-managed'].requiresResearchColumns).toBeUndefined();
  });

  it('depth-imbalance-fade-managed declares the same research columns as depth-imbalance-fade', () => {
    expect(STRATEGY_FAMILIES['depth-imbalance-fade-managed'].requiresResearchColumns).toEqual(
      STRATEGY_FAMILIES['depth-imbalance-fade'].requiresResearchColumns
    );
    expect(STRATEGY_FAMILIES['depth-imbalance-fade-managed'].requiresResearchColumns).toBeDefined();
  });

  it('positioning-fade-managed declares the same research columns as positioning-fade', () => {
    expect(STRATEGY_FAMILIES['positioning-fade-managed'].requiresResearchColumns).toEqual(
      STRATEGY_FAMILIES['positioning-fade'].requiresResearchColumns
    );
    expect(STRATEGY_FAMILIES['positioning-fade-managed'].requiresResearchColumns).toBeDefined();
  });

  it.each(['control-managed', 'depth-imbalance-fade-managed', 'positioning-fade-managed'])(
    '%s: create returns a strategy named for the family, carrying the cell as params, with a manage hook, for every grid cell',
    (name) => {
      const family = STRATEGY_FAMILIES[name];
      const cells = expandGrid(family);
      expect(cells.length).toBe(8);
      for (const cell of cells) {
        const strategy = family.create(cell, { style: 'day_trading', interval: '1h' });
        expect(strategy.name).toBe(name);
        expect(strategy.params).toEqual(cell);
        expect(strategy.manage).toBeTypeOf('function');
      }
    }
  );
});
