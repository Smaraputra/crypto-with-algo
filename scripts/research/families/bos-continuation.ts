/**
 * bos-continuation: trade a confirmed break of structure in the direction of
 * the break, expecting the new leg to continue. Reddit thread 1r6a1mz claims
 * a break-of-structure follow-through persists 69 to 75% of the time.
 *
 * `bosBreak` (research-columns.ts) reads +1 the bar the close first crosses
 * above the most recently CONFIRMED swing high, -1 mirrored for a confirmed
 * swing low, 0 on every other bar once at least one swing is known, computed
 * close-aligned and then shifted forward one bar. So at `ctx.bar` the column
 * carries the break reading for `ctx.bar - 1`'s close: a +1/-1 at bar i is
 * this family's entry signal at bar i, on the assumption the break continues.
 *
 * Params: k in [1, 2] (ATR multiple for the stop, placed against the break);
 * exit in [0, 1] -- 0 is a fixed 2R target, 1 drops the target and instead
 * wraps the strategy in `withManagement` with a break-even-free ATR trail
 * (`trailStartR: 1`, `trailAtr: 2`), letting a genuine continuation run past
 * 2R instead of capping it, at the cost of giving back more on a leg that
 * stalls; hold in [16, 32] bars (time stop); regime in [0, 1, 2] gates entries
 * on `volRatio` (0 no filter, 1 only when volRatio < 0.7 -- quiet relative to
 * the trailing week, i.e. a break is less likely to be noise, 2 only when
 * volRatio >= 0.7). 2 x 2 x 2 x 3 = 24 cells.
 *
 * `create` decides per cell whether to wrap with `withManagement`: only the
 * exit=1 cells get the trailing hook, per the task-5 brief ("Wrap the whole
 * family with withManagement only for the exit = 1 cells"); exit=0 cells
 * return the base strategy, with no `manage` hook at all.
 *
 * decideEntry: null when ctx.suite is null, currentAtr is not finite/positive,
 * the regime filter (when active) excludes the bar on a non-finite or
 * out-of-band volRatio, `bosBreak` is not finite or reads 0 (no break this
 * bar), or the current close is not finite. A +1 reading enters long with the
 * stop k*ATR below the close; a -1 reading enters short, mirrored above the
 * close. exit=0 sets the target at 2R on the favourable side; exit=1 sets no
 * target (null), leaving the trailing management hook (applied only for
 * those cells, see above) and the time stop to close the trade.
 *
 * decideExit: always false -- the stop, the (exit=0) target, the trailing
 * management (exit=1), and the time stop drive every exit, per the shared
 * family rules.
 */

import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { StrategyFamily } from '../strategy-families';
import { currentAtr, withManagement } from '../strategy-families';
import { researchValue } from '@/lib/backtest/research-series';

const BOS_BREAK_COLUMN = 'bosBreak';
const VOL_RATIO_COLUMN = 'volRatio';

function passesRegime(context: StrategyContext, regime: number): boolean {
  if (regime === 0) return true;
  const volRatio = researchValue(context.research, context.bar, VOL_RATIO_COLUMN);
  if (!Number.isFinite(volRatio)) return false;
  return regime === 1 ? volRatio < 0.7 : volRatio >= 0.7;
}

function decideBosContinuationEntry(
  context: StrategyContext,
  params: { k: number; exit: number; hold: number; regime: number }
): EntryDecision | null {
  if (!context.suite) return null;
  const atr = currentAtr(context.suite);
  if (atr === null) return null;

  if (!passesRegime(context, params.regime)) return null;

  const bos = researchValue(context.research, context.bar, BOS_BREAK_COLUMN);
  if (!Number.isFinite(bos) || bos === 0) return null;

  const close = context.candles[context.bar].close;
  if (!Number.isFinite(close)) return null;

  if (bos > 0) {
    const stopPrice = close - params.k * atr;
    const risk = close - stopPrice;
    return {
      side: 'long',
      orderType: 'market',
      stopPrice,
      targetPrice: params.exit === 0 ? close + 2 * risk : null,
      timeStopBars: params.hold,
    };
  }

  const stopPrice = close + params.k * atr;
  const risk = stopPrice - close;
  return {
    side: 'short',
    orderType: 'market',
    stopPrice,
    targetPrice: params.exit === 0 ? close - 2 * risk : null,
    timeStopBars: params.hold,
  };
}

export const bosContinuationFamily: StrategyFamily = {
  name: 'bos-continuation',
  description: 'trade a confirmed break of structure in the direction of the break (bosBreak)',
  requiresResearchColumns: [BOS_BREAK_COLUMN, VOL_RATIO_COLUMN],
  params: [
    { name: 'k', values: [1, 2] },
    { name: 'exit', values: [0, 1] },
    { name: 'hold', values: [16, 32] },
    { name: 'regime', values: [0, 1, 2] },
  ],
  create(params: Record<string, number>): Strategy {
    const { k, exit, hold, regime } = params;
    const base: Strategy = {
      name: 'bos-continuation',
      params,
      decideEntry(context: StrategyContext): EntryDecision | null {
        return decideBosContinuationEntry(context, { k, exit, hold, regime });
      },
      decideExit(): boolean {
        return false;
      },
    };

    if (exit === 1) {
      return withManagement(base, { trailStartR: 1, trailAtr: 2 }, 'bos-continuation', params);
    }
    return base;
  },
};
