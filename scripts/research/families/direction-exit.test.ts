// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { prepareBacktest, runOptimizedBacktest } from '@/lib/backtest/optimized-engine';
import type { Strategy, StrategyContext } from '@/lib/backtest/strategy';
import { DEFAULT_BACKTEST_CONFIG, type BacktestConfig } from '@/lib/backtest/types';
import type { OHLCV } from '@/types/market';
import type { SignalComponent } from '@/types/signal';
import { DIRECTION_EXIT_FIT, type DirectionExitFit } from '../direction-exit';
import { DX_FAMILIES, d1FromComponents } from './direction-exit';

const HOUR = 3_600_000;
const candles = Array.from({ length: 60 }, (_, i) => ({ timestamp: (i + 8) * HOUR, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
const comp = (category: SignalComponent['category'], score: number, signals = 1): SignalComponent => ({
  category, score, weight: 0, weightedScore: 0,
  signals: Array.from({ length: signals }, () => ({ name: 'x', direction: 'bullish' as const, strength: 50, description: '' })),
});
function ctx(over: Partial<StrategyContext>): StrategyContext {
  return { bar: 40, candles, interval: '1h', suite: null, score: 0, tier: 'neutral', superTrend: null, snapshot: null, snapshots: [], research: [], htfContext: null, session: null, position: null, components: [], ...over } as StrategyContext;
}

describe('dx-d0', () => {
  it('goes long on a buy tier with a 10 ATR protective stop, a time stop of h - 1 bars and no target at E1', () => {
    const s = DX_FAMILIES['dx-d0'].create({ exit: 1, k: 1 }, { style: 'day_trading', interval: '1h' });
    const d = s.decideEntry(ctx({ score: 30, tier: 'buy' }), DEFAULT_BACKTEST_CONFIG)!;
    expect(d.side).toBe('long');
    expect(d.orderType).toBe('next-open');
    expect(d.timeStopBars).toBe(23);
    expect(d.targetPrice).toBeNull();
    expect(d.stopPrice).toBeLessThan(100);
    const s4h = DX_FAMILIES['dx-d0'].create({ exit: 1, k: 1 }, { style: 'swing_trading', interval: '4h' });
    expect(s4h.decideEntry(ctx({ interval: '4h', score: 30, tier: 'buy' }), DEFAULT_BACKTEST_CONFIG)!.timeStopBars).toBe(29);
  });

  it('sets symmetric k ATR barriers at E3 and a target only at E2', () => {
    const e3 = DX_FAMILIES['dx-d0'].create({ exit: 3, k: 1.5 }, { style: 'day_trading', interval: '1h' }).decideEntry(ctx({ score: -40, tier: 'strong_sell' }), DEFAULT_BACKTEST_CONFIG)!;
    expect(e3.side).toBe('short');
    expect(e3.stopPrice - 100).toBeCloseTo(100 - (e3.targetPrice as number), 6);
  });

  it('leaves a long at E4 once the score falls to 7, at the next open', () => {
    const s = DX_FAMILIES['dx-d0'].create({ exit: 4, k: 1 }, { style: 'day_trading', interval: '1h' });
    const position = { side: 'long' } as StrategyContext['position'];
    expect(s.exitFill).toBe('next-open');
    expect(s.decideExit(ctx({ score: 8, position }), DEFAULT_BACKTEST_CONFIG)).toBe(false);
    expect(s.decideExit(ctx({ score: 7, position }), DEFAULT_BACKTEST_CONFIG)).toBe(true);
  });

  it('leaves a short at E4 once the score rises to -7', () => {
    const s = DX_FAMILIES['dx-d0'].create({ exit: 4, k: 1 }, { style: 'day_trading', interval: '1h' });
    const entry = s.decideEntry(ctx({ score: -30, tier: 'sell' }), DEFAULT_BACKTEST_CONFIG)!;
    expect(entry.side).toBe('short');
    const position = { side: 'short' } as StrategyContext['position'];
    expect(s.decideExit(ctx({ score: -8, position }), DEFAULT_BACKTEST_CONFIG)).toBe(false);
    expect(s.decideExit(ctx({ score: -7, position }), DEFAULT_BACKTEST_CONFIG)).toBe(true);
    expect(s.decideExit(ctx({ score: 12, position }), DEFAULT_BACKTEST_CONFIG)).toBe(true);
  });
});

describe('d1FromComponents', () => {
  it('averages the signed present components and ignores empty ones', () => {
    const signs = { trend: 1, momentum: -1, volume: 1, volatility: 1, futures: 1, sentiment: 1, htf: 1 } as const;
    expect(d1FromComponents([comp('trend', 40), comp('momentum', 20), comp('futures', 90, 0)], signs)).toBeCloseTo(10);
    expect(d1FromComponents([comp('futures', 90, 0)], signs)).toBeNull();
  });
});

describe('dx-d1', () => {
  const fit: DirectionExitFit = {
    signs: { trend: -1, momentum: 1, volume: 1, volatility: 1, futures: 1, sentiment: 1, htf: 1 },
    threshold: 20,
    volTopThreshold: {},
  };
  /** create() reads DIRECTION_EXIT_FIT once, so the fit is restored as soon as the strategy exists. */
  function d1(exit: number): Strategy {
    const saved = DIRECTION_EXIT_FIT['1h'];
    DIRECTION_EXIT_FIT['1h'] = fit;
    try {
      return DX_FAMILIES['dx-d1'].create({ exit, k: 1 }, { style: 'day_trading', interval: '1h' });
    } finally {
      DIRECTION_EXIT_FIT['1h'] = saved;
    }
  }

  it('takes no entry on a NaN D1 score', () => {
    const s = d1(1);
    expect(s.decideEntry(ctx({ components: [comp('momentum', Number.NaN)] }), DEFAULT_BACKTEST_CONFIG)).toBeNull();
    expect(s.decideEntry(ctx({ components: [comp('trend', 40), comp('momentum', Number.NaN)] }), DEFAULT_BACKTEST_CONFIG)).toBeNull();
  });

  it('enters in the direction of the sign-corrected score above T and not at T', () => {
    const s = d1(1);
    // trend 40 with sign -1 gives D1 = -40: short.
    expect(s.decideEntry(ctx({ components: [comp('trend', 40)] }), DEFAULT_BACKTEST_CONFIG)!.side).toBe('short');
    expect(s.decideEntry(ctx({ components: [comp('momentum', 25)] }), DEFAULT_BACKTEST_CONFIG)!.side).toBe('long');
    expect(s.decideEntry(ctx({ components: [comp('momentum', 20)] }), DEFAULT_BACKTEST_CONFIG)).toBeNull();
  });

  it('exits at E4 once the D1 score falls back inside T / 4, never on a NaN score', () => {
    const s = d1(4);
    const long = { side: 'long' } as StrategyContext['position'];
    const short = { side: 'short' } as StrategyContext['position'];
    expect(s.decideExit(ctx({ position: long, components: [comp('momentum', 6)] }), DEFAULT_BACKTEST_CONFIG)).toBe(false);
    expect(s.decideExit(ctx({ position: long, components: [comp('momentum', 5)] }), DEFAULT_BACKTEST_CONFIG)).toBe(true);
    expect(s.decideExit(ctx({ position: short, components: [comp('momentum', -6)] }), DEFAULT_BACKTEST_CONFIG)).toBe(false);
    expect(s.decideExit(ctx({ position: short, components: [comp('momentum', -5)] }), DEFAULT_BACKTEST_CONFIG)).toBe(true);
    expect(s.decideExit(ctx({ position: long, components: [comp('momentum', Number.NaN)] }), DEFAULT_BACKTEST_CONFIG)).toBe(false);
  });
});

describe('dx-d2 conditions', () => {
  it('takes the call only when the higher timeframe agrees (C1) and outside Asia (C4)', () => {
    const c1 = DX_FAMILIES['dx-d2'].create({ cond: 1, exit: 1, k: 1 }, { style: 'day_trading', interval: '1h' });
    expect(c1.decideEntry(ctx({ score: 30, tier: 'buy', components: [comp('htf', 20)] }), DEFAULT_BACKTEST_CONFIG)).not.toBeNull();
    expect(c1.decideEntry(ctx({ score: 30, tier: 'buy', components: [comp('htf', -20)] }), DEFAULT_BACKTEST_CONFIG)).toBeNull();
    const c4 = DX_FAMILIES['dx-d2'].create({ cond: 4, exit: 1, k: 1 }, { style: 'day_trading', interval: '1h' });
    const early = [...candles];
    early[40] = { ...early[40], timestamp: Date.UTC(2023, 0, 1, 3) };
    expect(c4.decideEntry(ctx({ score: 30, tier: 'buy', candles: early }), DEFAULT_BACKTEST_CONFIG)).toBeNull();
  });

  it('never takes a C2 call for a symbol without a volatility threshold', () => {
    const c2 = DX_FAMILIES['dx-d2'].create({ cond: 2, exit: 1, k: 1 }, { style: 'day_trading', interval: '1h' });
    expect(c2.decideEntry(ctx({ score: 30, tier: 'buy', research: [] }), DEFAULT_BACKTEST_CONFIG)).toBeNull();
  });
});

// End to end through the shared bar loop, as legends-orders.test.ts does: the family's own decisions,
// with the call injected at bar D (the engine's composite cannot be steered to a tier on synthetic bars).
describe('dx-d0 through the engine', () => {
  const PREFIX = 210;
  const D = PREFIX;
  const flat = (i: number): OHLCV => ({ timestamp: i * HOUR, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 });
  // From D on, every bar has its own open and close, so a fill or an exit price names its bar.
  const engineered = (k: number): OHLCV => {
    const open = 100 + k * 0.1;
    const close = open + 0.05;
    return { timestamp: (PREFIX + k) * HOUR, open, high: close + 0.3, low: open - 0.3, close, volume: 1000 };
  };
  const bars: OHLCV[] = [...Array.from({ length: PREFIX }, (_, i) => flat(i)), ...Array.from({ length: 40 }, (_, k) => engineered(k))];
  const CONFIG: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    allowShorts: true,
    positionSizePercent: 1,
    feePercent: 0,
    takerFeePercent: 0,
    makerFeePercent: 0,
    slippageBps: 0,
  };

  /** The family's strategy with a buy call at bar D only, and the score each bar reads for E4. */
  function injected(s: Strategy, scoreAt: (bar: number) => number): Strategy {
    return {
      ...s,
      decideEntry: (c, cfg) => (c.bar === D ? s.decideEntry({ ...c, score: 30, tier: 'buy' }, cfg) : null),
      decideExit: (c, cfg) => s.decideExit({ ...c, score: scoreAt(c.bar) }, cfg),
    };
  }
  function run(s: Strategy) {
    return runOptimizedBacktest(prepareBacktest(bars, 'BTCUSDT', '1h'), CONFIG, 'BTCUSDT', '1h', undefined, s);
  }

  it('holds an E1 call from open[i + 1] to close[i + h], the lag-1 label of note N1', () => {
    const s = DX_FAMILIES['dx-d0'].create({ exit: 1, k: 1 }, { style: 'day_trading', interval: '1h' });
    const { trades } = run(injected(s, () => 30));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      side: 'long',
      entryBar: D + 1,
      entryPrice: bars[D + 1].open,
      exitBar: D + 24,
      exitTime: bars[D + 24].timestamp,
      exitReason: 'time_stop',
      holdTimeBars: 23,
    });
    expect(trades[0].exitPrice).toBeCloseTo(bars[D + 24].close, 10);
  });

  it('fills an E4 exit at the open of the bar after the deciding bar', () => {
    const s = DX_FAMILIES['dx-d0'].create({ exit: 4, k: 1 }, { style: 'day_trading', interval: '1h' });
    const { trades } = run(injected(s, (bar) => (bar === D + 3 ? 5 : 30)));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ entryBar: D + 1, exitBar: D + 4, exitTime: bars[D + 4].timestamp, exitReason: 'signal', holdTimeBars: 3 });
    expect(trades[0].exitPrice).toBeCloseTo(bars[D + 4].open, 10);
  });
});
