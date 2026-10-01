/**
 * sweep-reclaim: trade a liquidity sweep and reclaim (a "stop hunt" that
 * fails). Reddit threads 1i8645x, 1wqqi74, 1w7ej45, and the Threads SMC
 * (smart-money-concepts) template circulating alongside them, all describe
 * the same shape: price pokes through a recent swing low or high to run
 * resting stops, then closes back inside the prior range on the same bar,
 * and the failed sweep is read as the reversal signal -- long on a failed
 * sweep of the low, short on a failed sweep of the high.
 *
 * The column already encodes exactly that: `sweepReversal20`/`sweepReversal50`
 * (research-columns.ts) reads +1 when a bar's low breaks the trailing
 * `windowBars`-bar low and its close reclaims back above it, -1 mirrored on
 * the trailing high, computed close-aligned and then shifted forward one bar.
 * So at `ctx.bar`, the column carries the reading for the SWEEP bar
 * `ctx.bar - 1`: that bar's own low/high are what the stop is measured
 * against, not the current bar's.
 *
 * Params: lookback in [20, 50] selects which column (sweepReversal20 or
 * sweepReversal50) decides entries; rr in [1.5, 2, 3] sets the target as a
 * multiple of the entry risk; hold in [8, 16] bars is the time stop; regime
 * in [0, 1, 2] gates entries on `volRatio` (0 no filter, 1 only when
 * volRatio < 0.7 -- quiet relative to the trailing week, i.e. a reclaim is
 * less likely to be noise, 2 only when volRatio >= 0.7). 2 x 3 x 2 x 3 = 36
 * cells.
 *
 * decideEntry: null when ctx.suite is null, currentAtr is not finite/positive,
 * the regime filter (when active) excludes the bar on a non-finite or
 * out-of-band volRatio, the selected sweep column is not finite or reads 0
 * (no sweep this bar), the current close is not finite, or the sweep bar
 * (ctx.candles[ctx.bar - 1], which does not exist before bar 1) has a
 * non-finite low/high. A +1 reading enters long with the stop at the sweep
 * bar's low minus 0.5 ATR; a -1 reading enters short, mirrored off the sweep
 * bar's high. The target is `rr` times the resulting entry risk (the
 * distance from the current close to that stop) on the favourable side; a
 * non-positive risk (the sweep bar's low/high already on the wrong side of
 * the current close) also declines, since no target could then sit on the
 * correct side.
 *
 * decideExit: always false -- the stop and the time stop drive every exit,
 * per the shared family rules.
 *
 * sweep-reclaim-limit: the same rule with a resting limit entry at the
 * decision close (offset 0 bps) instead of a market fill, timeout in
 * [1, 2] bars. regime is dropped (fixed at 0, no filter) to keep the grid
 * under MAX_GRID_CELLS: 2 x 3 x 2 x 2 = 24 cells.
 */

import type { TradingStyle } from '@/lib/models/signal-template';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { StrategyFamily } from '../strategy-families';
import { currentAtr, withLimitEntry } from '../strategy-families';
import { researchValue } from '@/lib/backtest/research-series';

const VOL_RATIO_COLUMN = 'volRatio';
const SWEEP_STOP_ATR = 0.5;

function sweepColumn(lookback: number): string {
  return lookback === 20 ? 'sweepReversal20' : 'sweepReversal50';
}

function passesRegime(context: StrategyContext, regime: number): boolean {
  if (regime === 0) return true;
  const volRatio = researchValue(context.research, context.bar, VOL_RATIO_COLUMN);
  if (!Number.isFinite(volRatio)) return false;
  return regime === 1 ? volRatio < 0.7 : volRatio >= 0.7;
}

function decideSweepReclaimEntry(
  context: StrategyContext,
  params: { lookback: number; rr: number; hold: number; regime: number }
): EntryDecision | null {
  if (!context.suite) return null;
  const atr = currentAtr(context.suite);
  if (atr === null) return null;

  if (!passesRegime(context, params.regime)) return null;

  const sweep = researchValue(context.research, context.bar, sweepColumn(params.lookback));
  if (!Number.isFinite(sweep) || sweep === 0) return null;

  const close = context.candles[context.bar].close;
  if (!Number.isFinite(close)) return null;

  if (context.bar < 1) return null;
  const sweepBar = context.candles[context.bar - 1];
  if (!Number.isFinite(sweepBar.low) || !Number.isFinite(sweepBar.high)) return null;

  if (sweep > 0) {
    const stopPrice = sweepBar.low - SWEEP_STOP_ATR * atr;
    const risk = close - stopPrice;
    if (!(risk > 0)) return null;
    return {
      side: 'long',
      orderType: 'market',
      stopPrice,
      targetPrice: close + params.rr * risk,
      timeStopBars: params.hold,
    };
  }

  const stopPrice = sweepBar.high + SWEEP_STOP_ATR * atr;
  const risk = stopPrice - close;
  if (!(risk > 0)) return null;
  return {
    side: 'short',
    orderType: 'market',
    stopPrice,
    targetPrice: close - params.rr * risk,
    timeStopBars: params.hold,
  };
}

export const sweepReclaimFamily: StrategyFamily = {
  name: 'sweep-reclaim',
  description:
    'long a failed sweep of the trailing low, short a failed sweep of the trailing high (sweepReversal20/50)',
  requiresResearchColumns: ['sweepReversal20', 'sweepReversal50', 'volRatio'],
  params: [
    { name: 'lookback', values: [20, 50] },
    { name: 'rr', values: [1.5, 2, 3] },
    { name: 'hold', values: [8, 16] },
    { name: 'regime', values: [0, 1, 2] },
  ],
  create(params: Record<string, number>): Strategy {
    const { lookback, rr, hold, regime } = params;
    return {
      name: 'sweep-reclaim',
      params,
      decideEntry(context: StrategyContext): EntryDecision | null {
        return decideSweepReclaimEntry(context, { lookback, rr, hold, regime });
      },
      decideExit(): boolean {
        return false;
      },
    };
  },
};

export const sweepReclaimLimitFamily: StrategyFamily = {
  name: 'sweep-reclaim-limit',
  description: 'sweep-reclaim with a resting limit entry at the decision close (offset 0), regime filter dropped',
  requiresResearchColumns: ['sweepReversal20', 'sweepReversal50'],
  params: [
    { name: 'lookback', values: [20, 50] },
    { name: 'rr', values: [1.5, 2, 3] },
    { name: 'hold', values: [8, 16] },
    { name: 'timeout', values: [1, 2] },
  ],
  create(params: Record<string, number>, ctx: { style: TradingStyle; interval: string }): Strategy {
    const { lookback, rr, hold, timeout } = params;
    const base = sweepReclaimFamily.create({ lookback, rr, hold, regime: 0 }, ctx);
    return withLimitEntry(base, 'sweep-reclaim-limit', params, { timeoutBars: timeout, offsetBps: 0 });
  },
};
