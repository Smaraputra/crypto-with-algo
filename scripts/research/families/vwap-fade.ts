/**
 * vwap-fade: fade a stretch from the UTC-day cumulative VWAP.
 *
 * Threads 1pladiq, 1wk433x, 1wq16xv (X @traderdrysdale): once price sits
 * several standard deviations from the day's own volume-weighted average,
 * the crowd chasing that stretch is itself the flow that tends to pull
 * price back toward it. `vwapDevZ` (research-columns.ts) is exactly that
 * measure -- the 30-day trailing z-score of close's deviation from the
 * cumulative UTC-day VWAP, already shifted forward one bar so bar i reads
 * what was knowable at close i-1.
 *
 * Params: z in [1.5, 2, 2.5] (the |vwapDevZ| stretch threshold), slope in
 * [0, 1] (0/1-encoded "not still stretching" gate, see below), k in [2, 3]
 * (ATR multiple for the stop), hold in [8, 16] (time stop bars).
 * 3 x 2 x 2 x 2 = 24 cells. `regime` is left out on purpose: adding the
 * shared {0, 1, 2} filter would make this 24 x 3 = 72 cells, over
 * MAX_GRID_CELLS (60).
 *
 * THE SLOPE GATE. slope=1 is a cheap proxy for "the stretch is not still
 * building", not a real slope estimate. It compares the current vwapDevZ
 * reading (at ctx.bar) against the PREVIOUS bar's own reading (ctx.bar - 1)
 * and requires either that the magnitude fell (the stretch is easing) or
 * that the two readings are within 0.25 of each other (roughly flat).
 * Both readings already carry research-columns.ts's own one-bar forward
 * shift, so this reads nothing later than the entry rule's own column --
 * ctx.bar - 1's reading was itself computed from close[ctx.bar - 2]. When
 * the previous bar's reading is missing or not finite (including bar 0,
 * where there is no bar - 1), slope=1 declines the trade: there is nothing
 * to confirm "not still stretching" against.
 */

import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import { researchValue } from '@/lib/backtest/research-series';
import { currentAtr, type StrategyFamily } from '../strategy-families';

const VWAP_DEV_Z_COLUMN = 'vwapDevZ';
const SLOPE_FLAT_BAND = 0.25;
const TARGET_R_MULTIPLE = 2;

export const vwapFadeFamily: StrategyFamily = {
  name: 'vwap-fade',
  description: 'fade a stretch from the UTC-day cumulative VWAP (threads 1pladiq/1wk433x/1wq16xv)',
  requiresResearchColumns: [VWAP_DEV_Z_COLUMN],
  params: [
    { name: 'z', values: [1.5, 2, 2.5] },
    { name: 'slope', values: [0, 1] },
    { name: 'k', values: [2, 3] },
    { name: 'hold', values: [8, 16] },
  ],
  create(params: Record<string, number>): Strategy {
    const { z: threshold, slope, k: atrMultiple, hold: holdBars } = params;
    return {
      name: 'vwap-fade',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;

        const value = researchValue(ctx.research, ctx.bar, VWAP_DEV_Z_COLUMN);
        if (!Number.isFinite(value) || Math.abs(value) < threshold) return null;

        const close = ctx.candles[ctx.bar].close;
        if (!Number.isFinite(close)) return null;

        if (slope === 1) {
          const previous = researchValue(ctx.research, ctx.bar - 1, VWAP_DEV_Z_COLUMN);
          if (!Number.isFinite(previous)) return null;
          const easing = Math.abs(previous) > Math.abs(value);
          const flat = Math.abs(previous - value) <= SLOPE_FLAT_BAND;
          if (!easing && !flat) return null;
        }

        // Stretched above VWAP (positive z) is faded short; stretched below
        // (negative z) is faded long.
        const side: 'long' | 'short' = value > 0 ? 'short' : 'long';
        const sign = side === 'long' ? 1 : -1;
        return {
          side,
          orderType: 'market',
          stopPrice: close - sign * atrMultiple * atr,
          targetPrice: close + sign * TARGET_R_MULTIPLE * atrMultiple * atr,
          timeStopBars: holdBars,
        };
      },
      decideExit(): boolean {
        return false;
      },
    };
  },
};
