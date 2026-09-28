/**
 * delta-flow-continuation: follow BTC options dealer delta flow when
 * customers have leaned hard to one side over the trailing 24 hours.
 *
 * Theory (options cluster, thread ids T2.2/T6.8/S100/X4 for the vol-regime
 * reading this cluster shares). `mktOptDeltaFlow24Z` (research-columns.ts)
 * is a 30-day trailing z-score of the aligned 24-consecutive-hour trailing
 * sum of BTC's hourly Deribit `netDelta` (customer options delta flow),
 * read by every symbol as the market-wide reading and shifted forward one
 * bar, so a read at bar i reflects what was knowable at close i-1. The
 * develop-slice IC triage found this column positive at 4h: h16 ic +0.0656,
 * t 4.9, 10/10 symbols, 4/5 quarters -- large sustained customer delta
 * buying (or selling) over the prior day precedes a same-signed drift over
 * the following bars. At 1h the same column showed nothing (h1 -0.0078),
 * so this family is meant for 4h and is run there first (task-6 brief).
 * Rule: long when the z is at or above the threshold, short when at or
 * below its negative, mirrored -- this is a continuation bet in the
 * direction of the flow, not a fade.
 *
 * Params: z in [1, 1.5, 2] (|mktOptDeltaFlow24Z| threshold), k in [2, 3]
 * (ATR multiple for the stop), hold in [8, 16, 32] (time stop bars, the 8
 * to 32 bar drift window the triage cells describe). 3 x 2 x 3 = 18 cells.
 * No target: the triage reads drift over a bar range, not a fixed
 * distance, so the position is closed by its stop or the time stop only
 * (matching return-reversal and the sibling dvol-spike-long/skew-spike-long
 * families in this round, which read the same "drift over N bars" shape
 * from their own triage cells). No regime param: MAX_PARAMS is 4 and there
 * was budget, but the task-6 brief's own F11 cell math (18 / 36) omits it,
 * matching F7's precedent in task-5.
 */
import type { TradingStyle } from '@/lib/models/signal-template';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { StrategyFamily } from '../strategy-families';
import { currentAtr, withLimitEntry } from '../strategy-families';
import { researchValue } from '@/lib/backtest/research-series';

const DELTA_FLOW_COLUMN = 'mktOptDeltaFlow24Z';

export const deltaFlowContinuationFamily: StrategyFamily = {
  name: 'delta-flow-continuation',
  description:
    'follow BTC options dealer delta flow when customers leaned hard to one side over 24h (options cluster T2.2/T6.8/S100/X4)',
  requiresResearchColumns: [DELTA_FLOW_COLUMN],
  params: [
    { name: 'z', values: [1, 1.5, 2] },
    { name: 'k', values: [2, 3] },
    { name: 'hold', values: [8, 16, 32] },
  ],
  create(params: Record<string, number>): Strategy {
    const threshold = params.z;
    const atrMultiple = params.k;
    const holdBars = params.hold;

    return {
      name: 'delta-flow-continuation',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;

        const z = researchValue(ctx.research, ctx.bar, DELTA_FLOW_COLUMN);
        if (!Number.isFinite(z)) return null;

        const close = ctx.candles[ctx.bar].close;
        if (!Number.isFinite(close)) return null;

        // Customers bought delta hard over the trailing 24h: go long with
        // the flow.
        if (z >= threshold) {
          return {
            side: 'long',
            orderType: 'market',
            stopPrice: close - atrMultiple * atr,
            targetPrice: null,
            timeStopBars: holdBars,
          };
        }
        // Customers sold delta hard over the trailing 24h: go short, the
        // mirror.
        if (z <= -threshold) {
          return {
            side: 'short',
            orderType: 'market',
            stopPrice: close + atrMultiple * atr,
            targetPrice: null,
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
 * delta-flow-continuation-limit: the same delta-flow continuation rule (see
 * deltaFlowContinuationFamily above), entering on a resting limit order at
 * the decision close (offset fixed at 0) instead of at market. Exit, stop,
 * target and time stop are delta-flow-continuation's own, unchanged.
 *
 * Params: delta-flow-continuation's own z/k/hold grid plus timeout in
 * [1, 2] (limit order timeout, bars). 3 x 2 x 3 x 2 = 36 cells. offsetBps
 * fixed at 0, matching every other *-limit family in this program.
 */
export const deltaFlowContinuationLimitFamily: StrategyFamily = {
  name: 'delta-flow-continuation-limit',
  description: 'delta-flow-continuation with a resting limit entry at the decision close (offset 0)',
  requiresResearchColumns: deltaFlowContinuationFamily.requiresResearchColumns,
  params: [
    { name: 'z', values: [1, 1.5, 2] },
    { name: 'k', values: [2, 3] },
    { name: 'hold', values: [8, 16, 32] },
    { name: 'timeout', values: [1, 2] },
  ],
  create(params: Record<string, number>, ctx: { style: TradingStyle; interval: string }): Strategy {
    const { z, k, hold, timeout } = params;
    const base = deltaFlowContinuationFamily.create({ z, k, hold }, ctx);
    return withLimitEntry(base, 'delta-flow-continuation-limit', params, {
      timeoutBars: timeout,
      offsetBps: 0,
    });
  },
};
