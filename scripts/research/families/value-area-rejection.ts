/**
 * value-area-rejection: fade a failed break of the prior day's value area
 * back toward the POC.
 *
 * Thread 1wq16xv (OP) and 1sf47c1: a probe outside yesterday's value area
 * (Volume Profile VAH/VAL) that fails to hold -- close back inside within a
 * bar or two -- tends to travel on toward the POC, the magnet the "failed
 * auction" argument in both threads rests on. `outsideValue` and `pocDist`
 * (research-columns.ts) are built from the prior UTC day's own volume-at-price
 * profile and already shifted forward one bar, so at decision bar i,
 * `researchValue(ctx.research, i, name)` is what was knowable at close i-1
 * and `researchValue(ctx.research, i - 1, name)` is what was knowable at
 * close i-2 -- i.e. "the previous bar's reading" (index i-1 of the column) and
 * "the current reading" (index i of the column) as the task brief puts it.
 *
 * ENTRY. The previous reading of `outsideValue` (index bar-1) must be +1
 * (closed above VAH) or -1 (closed below VAL), and the current reading
 * (index bar) must be exactly 0 (closed back inside): that pair is the
 * failed-break-then-reclaim this family trades. +1 -> short toward the POC
 * (price was rejected from above); -1 -> long toward the POC. Declines when
 * either reading is missing, not finite, or does not match this exact
 * pattern (e.g. still outside, or was never outside).
 *
 * EXIT (the `mode` param). The stop is `k * ATR` beyond the entry on the
 * outside side (above for a short, below for a long) and the price target is
 * always 2R toward the POC side, regardless of mode -- this is the "2R"
 * half of "exit when pocDist crosses zero OR 2R, whichever first". `mode`
 * selects whether a SECOND, earlier exit is also live:
 *   - mode 0: only the 2R target (and the time stop) can close the trade;
 *     `decideExit` always returns false, the shared default.
 *   - mode 1: `decideExit` additionally reads the current `pocDist` reading
 *     each bar and exits once it has crossed zero in the trade's favour (a
 *     short, entered with pocDist positive, exits once pocDist <= 0; a long,
 *     entered with pocDist negative, exits once pocDist >= 0) -- i.e. once
 *     price has reached or passed the POC itself. Because the 2R target is
 *     still set, mode 1 is a genuine race: whichever of "price hits 2R" or
 *     "pocDist reaches the POC" happens first closes the trade.
 *
 * REGIME. `regime` is the shared {0, 1, 2} volRatio filter: 0 no filter, 1
 * trade only when `volRatio < 0.7` (quiet), 2 only when `volRatio >= 0.7`
 * (active), reading the same shifted `volRatio` column.
 *
 * Params: k in [1.5, 2.5] (ATR multiple for the stop), mode in [0, 1], hold
 * in [8, 16, 32] (time stop bars), regime in [0, 1, 2]. 2 x 2 x 3 x 3 = 36
 * cells.
 */

import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import { researchValue } from '@/lib/backtest/research-series';
import { currentAtr, type StrategyFamily } from '../strategy-families';

const OUTSIDE_VALUE_COLUMN = 'outsideValue';
const POC_DIST_COLUMN = 'pocDist';
const VOL_RATIO_COLUMN = 'volRatio';
const TARGET_R_MULTIPLE = 2;
const VOL_RATIO_REGIME_THRESHOLD = 0.7;

export const valueAreaRejectionFamily: StrategyFamily = {
  name: 'value-area-rejection',
  description: 'fade a failed break of the prior day value area back toward the POC (threads 1wq16xv/1sf47c1)',
  requiresResearchColumns: [OUTSIDE_VALUE_COLUMN, POC_DIST_COLUMN, VOL_RATIO_COLUMN],
  params: [
    { name: 'k', values: [1.5, 2.5] },
    { name: 'mode', values: [0, 1] },
    { name: 'hold', values: [8, 16, 32] },
    { name: 'regime', values: [0, 1, 2] },
  ],
  create(params: Record<string, number>): Strategy {
    const { k: atrMultiple, mode, hold: holdBars, regime } = params;
    return {
      name: 'value-area-rejection',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;

        const { bar, research } = ctx;

        const current = researchValue(research, bar, OUTSIDE_VALUE_COLUMN);
        if (current !== 0) return null; // must be back inside the value area now

        const previous = researchValue(research, bar - 1, OUTSIDE_VALUE_COLUMN);
        if (previous !== 1 && previous !== -1) return null; // must have been outside

        if (regime !== 0) {
          const volRatio = researchValue(research, bar, VOL_RATIO_COLUMN);
          if (!Number.isFinite(volRatio)) return null;
          if (regime === 1 && !(volRatio < VOL_RATIO_REGIME_THRESHOLD)) return null;
          if (regime === 2 && !(volRatio >= VOL_RATIO_REGIME_THRESHOLD)) return null;
        }

        const close = ctx.candles[bar].close;
        if (!Number.isFinite(close)) return null;

        // Rejected from above the value area (previous +1) is faded short
        // toward the POC; rejected from below (previous -1) is faded long.
        const side: 'long' | 'short' = previous === 1 ? 'short' : 'long';
        const sign = side === 'long' ? 1 : -1;
        const risk = atrMultiple * atr;
        return {
          side,
          orderType: 'market',
          stopPrice: close - sign * risk,
          targetPrice: close + sign * TARGET_R_MULTIPLE * risk,
          timeStopBars: holdBars,
        };
      },
      decideExit(ctx: StrategyContext): boolean {
        if (mode !== 1) return false;
        if (!ctx.position) return false;
        const pocDist = researchValue(ctx.research, ctx.bar, POC_DIST_COLUMN);
        if (!Number.isFinite(pocDist)) return false;
        return ctx.position.side === 'short' ? pocDist <= 0 : pocDist >= 0;
      },
    };
  },
};
