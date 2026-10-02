// @vitest-environment node
//
// The legends phase's engine additions (2026-10-02), end to end through the
// shared bar loop: next-open entries and exits, stop entries with one-bar
// re-placement and an OCO bracket, stops and targets relative to the fill,
// funding from per-settlement sums, the target-first sensitivity order, and
// risk measured from the initial stop. Every path is opt-in; the default
// paths stay pinned by golden-regression.test.ts and engine-parity.test.ts.
import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import { prepareBacktest, runOptimizedBacktest } from './optimized-engine';
import { DEFAULT_BACKTEST_CONFIG, type BacktestConfig, type BacktestResult } from './types';
import type { EntryDecision, Strategy, StrategyContext } from './strategy';

const PREFIX = 210;
const D = PREFIX; // the deciding bar: the first engineered bar
const HOUR = 3_600_000;

function flat(i: number): OHLCV {
  return { timestamp: i * HOUR, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 };
}

/** Engineered bars from index D on, each [open, high, low, close]. */
function candles(engineered: Array<[number, number, number, number]>): OHLCV[] {
  const prefix = Array.from({ length: PREFIX }, (_, i) => flat(i));
  const rest = engineered.map(([open, high, low, close], k) => ({
    timestamp: (PREFIX + k) * HOUR,
    open,
    high,
    low,
    close,
    volume: 1000,
  }));
  return [...prefix, ...rest];
}

const CONFIG: BacktestConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  allowShorts: true,
  positionSizePercent: 1,
  feePercent: 0,
  takerFeePercent: 0,
  makerFeePercent: 0,
  slippageBps: 0,
};

function run(
  bars: OHLCV[],
  strategy: Strategy,
  config: Partial<BacktestConfig> = {},
  fundingSums?: Float64Array
): BacktestResult {
  const prepared = prepareBacktest(bars, 'BTCUSDT', '1h');
  if (fundingSums) prepared.fundingSums = fundingSums;
  return runOptimizedBacktest(prepared, { ...CONFIG, ...config }, 'BTCUSDT', '1h', undefined, strategy);
}

/** Enters once with `decision` at bar D; exits only by price, time, or `exitAt`. */
function once(
  decision: EntryDecision,
  opts: { exitAt?: number; exitFill?: 'close' | 'next-open'; seen?: number[]; manage?: Strategy['manage'] } = {}
): Strategy {
  return {
    name: 'test-once',
    decideEntry: (ctx: StrategyContext) => (ctx.bar === D ? decision : null),
    decideExit: (ctx: StrategyContext) => {
      opts.seen?.push(ctx.bar);
      return ctx.bar === opts.exitAt;
    },
    ...(opts.exitFill ? { exitFill: opts.exitFill } : {}),
    ...(opts.manage ? { manage: opts.manage } : {}),
  };
}

const nextOpenLong = (extra: Partial<EntryDecision> = {}): EntryDecision => ({
  side: 'long',
  orderType: 'next-open',
  stopPrice: 90,
  targetPrice: null,
  ...extra,
});

describe('next-open entries', () => {
  it('fill at the next bar open with slippage, entry bar the fill bar', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [101, 103, 100, 102],
      [102, 103, 101, 102.5],
    ]);
    const plain = run(bars, once(nextOpenLong()));
    expect(plain.trades[0]).toMatchObject({ entryPrice: 101, entryBar: D + 1, entryTime: (D + 1) * HOUR });
    const slipped = run(bars, once(nextOpenLong()), { slippageBps: 10 });
    expect(slipped.trades[0].entryPrice).toBeCloseTo(101 * 1.001, 10);
  });

  it('book a fill bar that also reaches the stop as stopped on that bar', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [101, 102, 98, 100],
      [100, 101, 99, 100],
    ]);
    const r = run(bars, once(nextOpenLong({ stopPrice: 99 })));
    expect(r.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 99, entryBar: D + 1, exitBar: D + 1 });
  });

  it('set a fill-relative stop and target from the fill price', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [100, 103.5, 99, 103],
      [103, 104, 102, 103],
    ]);
    const decision = nextOpenLong({ fillRelative: { stopFraction: 0.015, targetFraction: 0.03 } });
    const r = run(bars, once(decision));
    expect(r.trades[0]).toMatchObject({ exitReason: 'take_profit', exitPrice: 103 });
    expect(r.trades[0].riskPercent).toBeCloseTo(1.5, 10);
    expect(r.trades[0].rewardPercent).toBeCloseTo(3, 10);
  });

  it('book a bar reaching both stop and target as the stop by default, the target under target-first', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [100, 104, 98, 100],
    ]);
    const decision = nextOpenLong({ fillRelative: { stopFraction: 0.015, targetFraction: 0.03 } });
    expect(run(bars, once(decision)).trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 98.5 });
    expect(run(bars, once(decision), { intrabarOrder: 'target-first' }).trades[0]).toMatchObject({
      exitReason: 'take_profit',
      exitPrice: 103,
    });
  });
});

describe('stop entries', () => {
  it('re-place a one-bar order each close until it triggers, and decide the exit at the fill bar close', () => {
    const seen: number[] = [];
    const strategy: Strategy = {
      name: 'test-replace',
      decideEntry: (ctx) =>
        ctx.bar >= D ? { side: 'long', orderType: 'stop', triggerPrice: 105, stopPrice: 90, targetPrice: null } : null,
      decideExit: (ctx) => {
        seen.push(ctx.bar);
        return false;
      },
    };
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [100, 104, 99, 103],
      [103, 104.5, 102, 104],
      [103, 106, 102, 105.5],
      [105.5, 106, 105, 105.5],
    ]);
    const r = run(bars, strategy);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ entryPrice: 105, entryBar: D + 3 });
    expect(r.stopEntries).toEqual({ placed: 3, filled: 1, ambiguous: 0, expired: 2 });
    expect(seen[0]).toBe(D + 3);
  });

  it('fill at the open when the bar gaps through the trigger', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [107, 108, 106, 107],
    ]);
    const r = run(bars, once({ side: 'long', orderType: 'stop', triggerPrice: 105, stopPrice: 90, targetPrice: null }));
    expect(r.trades[0].entryPrice).toBe(107);
  });

  it('resolve an OCO bracket hit on both sides to the leg nearer the open, then stop it out on the same bar', () => {
    const bracket: EntryDecision = {
      side: 'long',
      orderType: 'stop',
      triggerPrice: 110,
      stopPrice: 95,
      targetPrice: null,
      oco: { side: 'short', triggerPrice: 95, stopPrice: 110, targetPrice: null },
    };
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [98, 111, 94, 100],
    ]);
    const r = run(bars, once(bracket));
    expect(r.trades[0]).toMatchObject({ side: 'short', entryPrice: 95, exitReason: 'stop_loss', exitPrice: 110 });
    expect(r.stopEntries).toMatchObject({ placed: 1, filled: 1, ambiguous: 1 });
  });

  it('use a fill-relative stop distance (Turtle 2N) from the stop fill', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [104, 106, 103, 105],
      [105, 105.5, 100, 101],
    ]);
    const decision: EntryDecision = {
      side: 'long',
      orderType: 'stop',
      triggerPrice: 105,
      stopPrice: 0,
      targetPrice: null,
      fillRelative: { stopDistance: 4 },
    };
    const r = run(bars, once(decision));
    expect(r.trades[0]).toMatchObject({ entryPrice: 105, exitReason: 'stop_loss', exitPrice: 101, exitBar: D + 2 });
  });
});

describe('next-open exits', () => {
  it('fill a decideExit at the next bar open', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [100, 102, 99, 101],
      [101, 104, 100, 103],
      [107, 108, 106, 107],
    ]);
    const market: EntryDecision = { side: 'long', orderType: 'market', stopPrice: 80, targetPrice: null };
    const r = run(bars, once(market, { exitAt: D + 2, exitFill: 'next-open' }));
    expect(r.trades[0]).toMatchObject({ exitReason: 'signal', exitPrice: 107, exitBar: D + 3 });
  });
});

describe('funding from per-settlement sums', () => {
  it('charges the fill bar for a next-open entry, never the bar a next-open exit fills on', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [100, 101, 99, 100],
    ]);
    const sums = new Float64Array(bars.length);
    sums[D + 1] = 0.001;
    sums[D + 2] = 0.002;
    sums[D + 3] = 0.004;
    const r = run(bars, once(nextOpenLong(), { exitAt: D + 2, exitFill: 'next-open' }), { fundingEnabled: true }, sums);
    // Quantity 100 (10,000 at 100), marked at the close 100: 100 x 100 x (0.001 + 0.002).
    expect(r.trades[0].fundingCost).toBeCloseTo(30, 8);
  });

  it('keeps the entry-bar skip for an entry at the decision close', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [100, 101, 99, 100],
    ]);
    const sums = new Float64Array(bars.length);
    sums[D] = 0.5;
    sums[D + 1] = 0.001;
    const market: EntryDecision = { side: 'long', orderType: 'market', stopPrice: 80, targetPrice: null };
    const r = run(bars, once(market), { fundingEnabled: true }, sums);
    expect(r.trades[0].fundingCost).toBeCloseTo(10, 8);
  });
});

describe('risk from the initial stop', () => {
  it('reports the entry stop distance even after a manage hook trails the stop', () => {
    const bars = candles([
      [100, 100.5, 99.5, 100],
      [100.5, 101, 100, 100.8],
      [100.8, 101, 98, 99],
    ]);
    const market: EntryDecision = { side: 'long', orderType: 'market', stopPrice: 90, targetPrice: null };
    const r = run(bars, once(market, { manage: () => ({ stopPrice: 99.5 }) }));
    expect(r.trades[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 99.5 });
    expect(r.trades[0].riskPercent).toBeCloseTo(10, 10);
  });
});
