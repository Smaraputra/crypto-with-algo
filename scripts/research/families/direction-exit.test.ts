import { describe, expect, it } from 'vitest';
import type { StrategyContext } from '@/lib/backtest/strategy';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import type { SignalComponent } from '@/types/signal';
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
  it('goes long on a buy tier with a 10 ATR protective stop, the horizon and no target at E1', () => {
    const s = DX_FAMILIES['dx-d0'].create({ exit: 1, k: 1 }, { style: 'day_trading', interval: '1h' });
    const d = s.decideEntry(ctx({ score: 30, tier: 'buy' }), DEFAULT_BACKTEST_CONFIG)!;
    expect(d.side).toBe('long');
    expect(d.orderType).toBe('next-open');
    expect(d.timeStopBars).toBe(24);
    expect(d.targetPrice).toBeNull();
    expect(d.stopPrice).toBeLessThan(100);
  });

  it('sets symmetric k ATR barriers at E3 and a target only at E2', () => {
    const e3 = DX_FAMILIES['dx-d0'].create({ exit: 3, k: 1.5 }, { style: 'day_trading', interval: '1h' }).decideEntry(ctx({ score: -40, tier: 'strong_sell' }), DEFAULT_BACKTEST_CONFIG)!;
    expect(e3.side).toBe('short');
    expect(e3.stopPrice - 100).toBeCloseTo(100 - (e3.targetPrice as number), 6);
  });

  it('leaves a long at E4 once the score falls to 7', () => {
    const s = DX_FAMILIES['dx-d0'].create({ exit: 4, k: 1 }, { style: 'day_trading', interval: '1h' });
    const position = { side: 'long' } as StrategyContext['position'];
    expect(s.decideExit(ctx({ score: 8, position }), DEFAULT_BACKTEST_CONFIG)).toBe(false);
    expect(s.decideExit(ctx({ score: 7, position }), DEFAULT_BACKTEST_CONFIG)).toBe(true);
  });
});

describe('d1FromComponents', () => {
  it('averages the signed present components and ignores empty ones', () => {
    const signs = { trend: 1, momentum: -1, volume: 1, volatility: 1, futures: 1, sentiment: 1, htf: 1 } as const;
    expect(d1FromComponents([comp('trend', 40), comp('momentum', 20), comp('futures', 90, 0)], signs)).toBeCloseTo(10);
    expect(d1FromComponents([comp('futures', 90, 0)], signs)).toBeNull();
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
