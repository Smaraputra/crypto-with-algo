// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { EntryDecision, Strategy, StrategyContext } from './strategy';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { OHLCV } from '@/types/market';

const BASE = 1700000000000;

function makeCandle(overrides: Partial<OHLCV> = {}): OHLCV {
  return {
    timestamp: BASE,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    ...overrides,
  };
}

// Hand-built context exercising every field of the interface, none of them
// derived from a real engine run.
function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    bar: 0,
    candles: [makeCandle()],
    interval: '1h',
    suite: null,
    score: 0,
    tier: 'neutral',
    superTrend: null,
    snapshot: null,
    snapshots: [],
    htfContext: null,
    session: null,
    position: null,
    pendingOrder: null,
    ...overrides,
  };
}

// Type-level coverage: this object literal only compiles if it satisfies
// Strategy exactly as declared (name, optional params, decideEntry,
// decideExit). A minimal implementation with no reliance on any concrete
// strategy module.
const alwaysLong: Strategy = {
  name: 'always-long',
  decideEntry(ctx: StrategyContext): EntryDecision | null {
    const close = ctx.candles[ctx.bar].close;
    return {
      side: 'long',
      orderType: 'market',
      stopPrice: close * 0.95,
      targetPrice: close * 1.05,
      timeStopBars: null,
    };
  },
  decideExit(): boolean {
    return false;
  },
};

describe('Strategy interface', () => {
  it('accepts a minimal custom strategy called with a hand-built context', () => {
    const ctx = makeContext({ score: 40, candles: [makeCandle({ close: 200 })] });

    const decision = alwaysLong.decideEntry(ctx, DEFAULT_BACKTEST_CONFIG);

    expect(decision).toEqual({
      side: 'long',
      orderType: 'market',
      stopPrice: 190,
      targetPrice: 210,
      timeStopBars: null,
    });
  });
});
