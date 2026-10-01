/**
 * dvol-spike-long: go long after a spike in BTC-wide implied volatility.
 *
 * Theory (round-2 develop-slice IC triage at 1h, 2021-10 to 2022-12, lag 1;
 * options cluster threads T2.2, T6.8, S100, X4). `raw.mktDvolZ30` (30-day
 * trailing z of the aligned Deribit DVOL close) reads ic +0.033 at h8, +0.047
 * at h16, +0.061 at h32, t 4.6 to 4.8, ten of ten symbols: after implied
 * volatility (fear) spikes, prices rise over the following 8 to 32 hours.
 * `mktDvolZ30` (research-columns.ts) is BTC's own DVOL series -- read by
 * every symbol as the market-wide reading, exactly as factors.ts's
 * `marketOptions` -- already shifted forward one bar, so a read at bar i
 * reflects what was knowable at close i-1.
 *
 * LONG ONLY. The triage's sign is positive for a HIGH z; the low-vol side (a
 * negative z preceding lower returns) is a different, weaker claim in the
 * same cells, not the mirror of this one, so it is not built here.
 *
 * No target: the triage cells read as 8 to 32 bars of drift, a horizon, not
 * a fixed distance, so `hold` alone (the time stop) closes the trade.
 *
 * Params: z in [1, 1.5, 2] (mktDvolZ30 threshold), k in [2, 3] (ATR multiple
 * for the stop), hold in [8, 16, 32] (time stop bars, matching the triage's
 * h8/h16/h32 horizons). 3 x 2 x 3 = 18 cells. Re-entry is intentional: the
 * family re-enters on every bar the condition still holds after an exit
 * (the harness itself holds only one position at a time).
 */
import type { TradingStyle } from '@/lib/models/signal-template';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { StrategyFamily } from '../strategy-families';
import { currentAtr, withLimitEntry } from '../strategy-families';
import { researchValue } from '@/lib/backtest/research-series';

const DVOL_Z_COLUMN = 'mktDvolZ30';

export const dvolSpikeLongFamily: StrategyFamily = {
  name: 'dvol-spike-long',
  description: 'go long after a BTC-wide implied-vol spike (mktDvolZ30 triage: ic +0.033 to +0.061, h8-h32, 10/10)',
  requiresResearchColumns: [DVOL_Z_COLUMN],
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
      name: 'dvol-spike-long',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;

        const z = researchValue(ctx.research, ctx.bar, DVOL_Z_COLUMN);
        if (!Number.isFinite(z)) return null;

        const close = ctx.candles[ctx.bar].close;
        if (!Number.isFinite(close)) return null;

        if (z >= threshold) {
          return {
            side: 'long',
            orderType: 'market',
            stopPrice: close - atrMultiple * atr,
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
 * dvol-spike-long-limit: the same DVOL-spike rule (see dvolSpikeLongFamily
 * above), entering on a resting limit order at the decision close (offset
 * fixed at 0) instead of at market. Exit, stop and time stop are
 * dvol-spike-long's own, unchanged -- there is still no target. This is a
 * continuation-shaped entry (the fill comes on a dip that then resumes),
 * the shape the Stage 0 record says can use the maker line.
 *
 * Params: dvol-spike-long's own z/k/hold grid plus timeout in [1, 2] (limit
 * order timeout, bars). 3 x 2 x 3 x 2 = 36 cells. offsetBps fixed at 0,
 * matching every other *-limit family in this file.
 */
export const dvolSpikeLongLimitFamily: StrategyFamily = {
  name: 'dvol-spike-long-limit',
  description: 'dvol-spike-long with a resting limit entry at the decision close (offset 0)',
  requiresResearchColumns: dvolSpikeLongFamily.requiresResearchColumns,
  params: [
    { name: 'z', values: [1, 1.5, 2] },
    { name: 'k', values: [2, 3] },
    { name: 'hold', values: [8, 16, 32] },
    { name: 'timeout', values: [1, 2] },
  ],
  create(params: Record<string, number>, ctx: { style: TradingStyle; interval: string }): Strategy {
    const { z, k, hold, timeout } = params;
    const base = dvolSpikeLongFamily.create({ z, k, hold }, ctx);
    return withLimitEntry(base, 'dvol-spike-long-limit', params, {
      timeoutBars: timeout,
      offsetBps: 0,
    });
  },
};
