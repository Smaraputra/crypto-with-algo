// @vitest-environment node
//
// Task 4: the optional per-bar `manage` hook (strategy.ts) and its wiring in
// runBarLoop. These tests exercise the engine end to end via runBacktest
// (engine.ts) so the position management hook runs against a real
// OpenPosition and real bar-loop control flow, exactly as strategy-families.ts
// strategies will use it. The default path (no `manage`) is covered
// separately and unchanged by golden-regression.test.ts / engine-parity.test.ts,
// which this task does not touch.
//
// Fix round 1 (task-4-review.md C1/I2/I4/M8): `manage` is handed a
// `ManagementContext` that is ONE BAR BEHIND the engine's loop variable
// `bar` (its own `ctx.bar` equals `bar - 1`, and its `suite`/`score`/`tier`
// are cached from that earlier bar), plus the current bar's OPEN passed
// separately for the wrong-side check. So when the loop is processing bar
// ENTRY_BAR + 1 (the first bar `manage` is ever called for), `manage`
// receives `ctx.bar === ENTRY_BAR`, not `ENTRY_BAR + 1`. Every test below
// keys its `manage` implementation off `ctx.bar === ENTRY_BAR` for exactly
// that reason -- it is the bar-index `manage` sees on its first call, which
// happens while the engine is looking at the candle AFTER it.
import { describe, it, expect, vi } from 'vitest';
import { runBacktest } from './engine';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { OHLCV } from '@/types/market';
import type { ManagementContext, ManagementDecision, Strategy, StrategyContext } from './strategy';
import type { OpenPosition } from './trade-utils';
import type { TradeSide } from './types';

// A long enough flat prefix that every indicator (sma200 is the longest
// lookback) has warmed up well before ENTRY_BAR, so computeWarmupBars() never
// lands inside the engineered region below. Flat but not degenerate (a
// non-zero high/low spread) so ATR and the other indicators produce finite
// values through the prefix.
const FLAT_PREFIX_BARS = 210;
const ENTRY_BAR = FLAT_PREFIX_BARS; // first bar of the engineered region, 0-indexed

function flatCandle(i: number): OHLCV {
  return {
    timestamp: i * 3600000,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 1000,
  };
}

/** Builds the full candle array: a flat, well-warmed-up prefix followed by
 * `engineered` bars starting at ENTRY_BAR, each fully specified by the
 * caller so a test controls exactly the open/high/low/close that drives
 * entry, management, and stop/target checks. */
function buildCandles(engineered: OHLCV[]): OHLCV[] {
  const prefix = Array.from({ length: FLAT_PREFIX_BARS }, (_, i) => flatCandle(i));
  return [...prefix, ...engineered];
}

function bar(offsetFromEntry: number, ohlc: { open: number; high: number; low: number; close: number }): OHLCV {
  return { timestamp: (ENTRY_BAR + offsetFromEntry) * 3600000, volume: 1000, ...ohlc };
}

/** A strategy that enters exactly once, at ENTRY_BAR, market, with a fixed
 * stop/target offset from that bar's close (mirrored for a short), never
 * exits by signal (only stop/target/time_stop drive exits), and delegates
 * management to `manage`. */
function makeManagedStrategy(opts: {
  side?: TradeSide;
  stopOffset: number;
  targetOffset: number;
  manage: Strategy['manage'];
}): Strategy {
  const side = opts.side ?? 'long';
  return {
    name: 'test-managed',
    decideEntry(ctx: StrategyContext) {
      if (ctx.bar !== ENTRY_BAR) return null;
      const close = ctx.candles[ctx.bar].close;
      return side === 'long'
        ? {
            side: 'long',
            orderType: 'market',
            stopPrice: close - opts.stopOffset,
            targetPrice: close + opts.targetOffset,
            timeStopBars: null,
          }
        : {
            side: 'short',
            orderType: 'market',
            stopPrice: close + opts.stopOffset,
            targetPrice: close - opts.targetOffset,
            timeStopBars: null,
          };
    },
    decideExit() {
      return false;
    },
    manage: opts.manage,
  };
}

function runWithStrategy(strategy: Strategy, engineered: OHLCV[]) {
  const candles = buildCandles(engineered);
  const config = { ...DEFAULT_BACKTEST_CONFIG, allowShorts: true };
  return runBacktest(candles, config, 'BTCUSDT', '1h', undefined, undefined, undefined, strategy);
}

describe('bar-loop manage hook', () => {
  it('receives a ManagementContext one bar behind the loop, first called for the bar after entry', () => {
    const calls: { bar: number; initialStopPrice: number | undefined; initialRisk: number | undefined }[] = [];
    const manage = vi.fn((ctx: ManagementContext, position: OpenPosition): ManagementDecision | null => {
      calls.push({ bar: ctx.bar, initialStopPrice: position.initialStopPrice, initialRisk: position.initialRisk });
      return null;
    });

    const strategy = makeManagedStrategy({ stopOffset: 5, targetOffset: 10, manage });

    const engineered = [
      bar(0, { open: 100, high: 100.2, low: 99.8, close: 100 }), // entry bar
      bar(1, { open: 100, high: 100.5, low: 99.6, close: 100.2 }),
      bar(2, { open: 100.2, high: 100.6, low: 100, close: 100.3 }),
    ];

    runWithStrategy(strategy, engineered);

    // The loop never calls manage while processing the entry bar itself
    // (position.entryBar === bar guard), so the earliest ctx.bar it can ever
    // report is ENTRY_BAR (one behind the loop's first post-entry bar,
    // ENTRY_BAR + 1) -- never anything smaller, and that value appears on
    // the very first call.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].bar).toBe(ENTRY_BAR);
    expect(calls.every((c) => c.bar >= ENTRY_BAR)).toBe(true);

    // initialStopPrice/initialRisk reflect the entry decision's own absolute
    // stop (close 100, stopOffset 5 -> stop 95, risk 5), fixed regardless of
    // how many bars the position survives.
    expect(calls[0].initialStopPrice).toBe(95);
    expect(calls[0].initialRisk).toBe(5);
  });

  it('ignores a stopPrice on the wrong side of the current bar open (long), counts it, and leaves the position unmanaged', () => {
    const manage = vi.fn((ctx: ManagementContext): ManagementDecision | null => {
      if (ctx.bar === ENTRY_BAR) {
        // Long position; the bar this decision applies to (ENTRY_BAR + 1)
        // opens at 100: 101 is the wrong side (above open).
        return { stopPrice: 101 };
      }
      return null;
    });

    const strategy = makeManagedStrategy({ stopOffset: 5, targetOffset: 10, manage });

    const engineered = [
      bar(0, { open: 100, high: 100.2, low: 99.8, close: 100 }), // entry bar, stop 95, target 110
      bar(1, { open: 100, high: 100.3, low: 96, close: 100.1 }), // wrong-side stop offered for this bar; low 96 would breach the rejected stop (101) but not the real one (95)
      bar(2, { open: 100.1, high: 100.4, low: 94, close: 99.5 }), // low 94 breaches the ORIGINAL stop 95, proving it was never moved
    ];

    const result = runWithStrategy(strategy, engineered);

    expect(result.managementRejected).toBe(1);
    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.exitReason).toBe('stop_loss');
    expect(trade.exitPrice).toBe(95);
    expect(trade.exitBar).toBe(ENTRY_BAR + 2);
    expect(trade.managed).toBeFalsy();
  });

  it('ignores a stopPrice on the wrong side of the current bar open (short), counts it, and leaves the position unmanaged', () => {
    const manage = vi.fn((ctx: ManagementContext): ManagementDecision | null => {
      if (ctx.bar === ENTRY_BAR) {
        // Short position; the bar this decision applies to (ENTRY_BAR + 1)
        // opens at 100: 99 is the wrong side (below/at open; a short's stop
        // must stay above it).
        return { stopPrice: 99 };
      }
      return null;
    });

    const strategy = makeManagedStrategy({ side: 'short', stopOffset: 5, targetOffset: 10, manage });

    const engineered = [
      bar(0, { open: 100, high: 100.2, low: 99.8, close: 100 }), // entry bar, stop 105, target 90
      // Wrong-side stop (99) offered for this bar. Had it wrongly been
      // accepted, high 100.5 >= 99 would fire an immediate stop_loss; it must
      // not.
      bar(1, { open: 100, high: 100.5, low: 99.7, close: 100.2 }),
      // High 106 breaches the ORIGINAL stop 105, proving it was never moved.
      bar(2, { open: 100.2, high: 106, low: 100, close: 105.5 }),
    ];

    const result = runWithStrategy(strategy, engineered);

    expect(result.managementRejected).toBe(1);
    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.exitReason).toBe('stop_loss');
    expect(trade.exitPrice).toBe(105);
    expect(trade.exitBar).toBe(ENTRY_BAR + 2);
    expect(trade.managed).toBeFalsy();
  });

  it('ignores a targetPrice on the wrong side of the current bar open, counts it, and leaves the target unmanaged', () => {
    const manage = vi.fn((ctx: ManagementContext): ManagementDecision | null => {
      if (ctx.bar === ENTRY_BAR) {
        // Long position; the bar this decision applies to opens at 100: 95
        // is the wrong side (below open; a long's target must stay above
        // it). Deliberately far below the current price so an incorrect
        // accept would fire take_profit immediately (checkStopTakeProfit
        // tests candle.high >= targetPrice).
        return { targetPrice: 95 };
      }
      return null;
    });

    const strategy = makeManagedStrategy({ stopOffset: 5, targetOffset: 10, manage });

    const engineered = [
      bar(0, { open: 100, high: 100.2, low: 99.8, close: 100 }), // entry bar, stop 95, target 110
      bar(1, { open: 100, high: 100.3, low: 99.5, close: 100.1 }), // wrong-side target offered; high 100.3 would wrongly trigger take_profit at 95 if accepted
      bar(2, { open: 100.1, high: 100.2, low: 100, close: 100.15 }),
    ];

    const result = runWithStrategy(strategy, engineered);

    expect(result.managementRejected).toBe(1);
    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.exitReason).toBe('end_of_data');
    expect(trade.managed).toBeFalsy();
  });

  it('applies a tightened, correct-side stop before checkStopTakeProfit runs on the same bar, and marks the trade managed', () => {
    const manage = vi.fn((ctx: ManagementContext): ManagementDecision | null => {
      if (ctx.bar === ENTRY_BAR) {
        // Long position; the bar this decision applies to opens at 100: 99
        // is the correct side (below open).
        return { stopPrice: 99 };
      }
      return null;
    });

    const strategy = makeManagedStrategy({ stopOffset: 5, targetOffset: 10, manage });

    const engineered = [
      bar(0, { open: 100, high: 100.2, low: 99.8, close: 100 }), // entry bar, stop 95, target 110
      // Tightened stop 99 applies before this same bar's own check: low 98.5
      // breaches 99 but never would have breached the original 95.
      bar(1, { open: 100, high: 100.3, low: 98.5, close: 98.8 }),
    ];

    const result = runWithStrategy(strategy, engineered);

    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.exitReason).toBe('stop_loss');
    expect(trade.exitPrice).toBe(99);
    expect(trade.exitBar).toBe(ENTRY_BAR + 1);
    expect(trade.managed).toBe(true);
  });

  it('a null targetPrice from manage removes the target', () => {
    const manage = vi.fn((ctx: ManagementContext): ManagementDecision | null => {
      if (ctx.bar === ENTRY_BAR) {
        return { targetPrice: null };
      }
      return null;
    });

    const strategy = makeManagedStrategy({ stopOffset: 5, targetOffset: 10, manage });

    const engineered = [
      bar(0, { open: 100, high: 100.2, low: 99.8, close: 100 }), // entry bar, stop 95, target 110
      // High 115 would have hit the original target (110) had it not been
      // removed; instead the position must survive this bar.
      bar(1, { open: 100, high: 115, low: 99.9, close: 101 }),
      bar(2, { open: 101, high: 101.2, low: 100.8, close: 101.1 }),
    ];

    const result = runWithStrategy(strategy, engineered);

    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.exitReason).not.toBe('take_profit');
    // No further exit condition is engineered, so the position rides to the
    // end of the (short) engineered series.
    expect(trade.exitReason).toBe('end_of_data');
    expect(trade.managed).toBe(true);
  });
});
