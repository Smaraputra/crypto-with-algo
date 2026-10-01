/**
 * btc-leadlag-continuation: follow BTC's lead when its one-bar return has
 * pulled away from this symbol's own.
 *
 * Theory (thread 1i8645x, "money follows the leader"; also the Phase B near
 * miss recorded in strategy-families.ts's header -- btcLeadLag 1h +0.0219
 * t 12.5, a near miss on h2/quarters that survived a leave-one-out control).
 * `btcLeadLagZ` (research-columns.ts) is BTC's one-bar return minus this
 * symbol's own, timestamp-joined and z-scored against its own trailing 30
 * day window, then shifted forward one bar so a read at bar i reflects what
 * closed at bar i-1. When BTC has just outrun this symbol (z >= threshold)
 * the rule goes long, betting the symbol catches up to BTC's move; when BTC
 * has just underrun it (z <= -threshold) the rule goes short, the mirror.
 * NaN for BTCUSDT itself and for any dataset with no BTCUSDT candles at this
 * interval (computeBtcLeadLagRaw in research-columns.ts), so this family
 * never trades BTCUSDT -- no symbol check is needed here, the column already
 * enforces it.
 *
 * WHY THE TARGET IS 1R, NOT 2R. Every other column-reading family in this
 * program (positioning-fade, funding-z-fade, depth-imbalance-fade) targets
 * 2R on a hold of 8 to 32 bars: a mean-reversion or crowding fade that is
 * given room to travel back through its own average. This is a continuation
 * bet on a lead/lag gap that a short hold (2, 4, or 8 bars) expects to close
 * quickly, if it closes at all -- Stage 1 of this research program's own
 * ruling (see strategy-families.ts's MEMORY-recorded arithmetic) is that a
 * trade's earnable return scales with its holding period while cost does
 * not, so a 2-to-8-bar hold must be judged against its own round trip, not
 * against a hold three to sixteen times longer. Asking a 2-bar hold to
 * travel 2R before its stop or time-out is asking it to move as far, as
 * fast, as a fade family is given four times as long to do. 1R keeps the
 * target inside what a one-to-four-bar continuation can plausibly earn.
 *
 * Params: z in [1, 1.5, 2] (|btcLeadLagZ| threshold), k in [2, 3] (ATR
 * multiple for the stop; the target is the same distance, 1R), hold in
 * [2, 4, 8] (time stop bars). 3 x 2 x 3 = 18 cells. No regime param: the
 * task-5 brief's F7 section fixes this family's grid at 18 cells over
 * exactly these three axes and does not mention regime, unlike F2/F3/F4,
 * so none is added here (there was budget for one at MAX_PARAMS=4 and
 * 18 x 3 = 54 <= 60 cells, but the brief's own F7 cell math omits it).
 */
import type { TradingStyle } from '@/lib/models/signal-template';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { StrategyFamily } from '../strategy-families';
import { currentAtr, withLimitEntry } from '../strategy-families';
import { researchValue } from '@/lib/backtest/research-series';

const BTC_LEAD_LAG_COLUMN = 'btcLeadLagZ';

export const btcLeadlagContinuationFamily: StrategyFamily = {
  name: 'btc-leadlag-continuation',
  description: "follow BTC's lead when its one-bar return has pulled away from this symbol's own (thread 1i8645x)",
  requiresResearchColumns: [BTC_LEAD_LAG_COLUMN],
  params: [
    { name: 'z', values: [1, 1.5, 2] },
    { name: 'k', values: [2, 3] },
    { name: 'hold', values: [2, 4, 8] },
  ],
  create(params: Record<string, number>): Strategy {
    const threshold = params.z;
    const atrMultiple = params.k;
    const holdBars = params.hold;

    return {
      name: 'btc-leadlag-continuation',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;

        const z = researchValue(ctx.research, ctx.bar, BTC_LEAD_LAG_COLUMN);
        if (!Number.isFinite(z)) return null;

        const close = ctx.candles[ctx.bar].close;
        if (!Number.isFinite(close)) return null;

        // BTC led up relative to this symbol: go long, betting the symbol
        // catches up.
        if (z >= threshold) {
          return {
            side: 'long',
            orderType: 'market',
            stopPrice: close - atrMultiple * atr,
            targetPrice: close + atrMultiple * atr,
            timeStopBars: holdBars,
          };
        }
        // BTC led down relative to this symbol: go short, the mirror.
        if (z <= -threshold) {
          return {
            side: 'short',
            orderType: 'market',
            stopPrice: close + atrMultiple * atr,
            targetPrice: close - atrMultiple * atr,
            timeStopBars: holdBars,
          };
        }
        return null;
      },
      decideExit(): boolean {
        return false;
      },
    };
  },
};

/**
 * btc-leadlag-continuation-limit: the same lead/lag continuation rule (see
 * btcLeadlagContinuationFamily above), entering on a resting limit order at
 * the decision close (offset fixed at 0) instead of at market. Exit, stop,
 * target and time stop are btc-leadlag-continuation's own, unchanged.
 *
 * Params: btc-leadlag-continuation's own z/k/hold grid plus timeout in
 * [1, 2] (limit order timeout, bars). 3 x 2 x 3 x 2 = 36 cells. offsetBps
 * fixed at 0, matching every other *-limit family in this file.
 */
export const btcLeadlagContinuationLimitFamily: StrategyFamily = {
  name: 'btc-leadlag-continuation-limit',
  description: 'btc-leadlag-continuation with a resting limit entry at the decision close (offset 0)',
  requiresResearchColumns: btcLeadlagContinuationFamily.requiresResearchColumns,
  params: [
    { name: 'z', values: [1, 1.5, 2] },
    { name: 'k', values: [2, 3] },
    { name: 'hold', values: [2, 4, 8] },
    { name: 'timeout', values: [1, 2] },
  ],
  create(params: Record<string, number>, ctx: { style: TradingStyle; interval: string }): Strategy {
    const { z, k, hold, timeout } = params;
    const base = btcLeadlagContinuationFamily.create({ z, k, hold }, ctx);
    return withLimitEntry(base, 'btc-leadlag-continuation-limit', params, {
      timeoutBars: timeout,
      offsetBps: 0,
    });
  },
};
