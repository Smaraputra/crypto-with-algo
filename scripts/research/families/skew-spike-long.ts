/**
 * skew-spike-long: go long after BTC-wide 25-delta put-call skew spikes.
 *
 * Theory (round-2 develop-slice IC triage at 1h, 2021-10 to 2022-12, lag 1;
 * threads C9, S106, whose sign the triage reversed). `raw.mktOptSkew24`
 * (aligned 24-consecutive-hour trailing mean of putIv25 - callIv25, computed
 * on the hourly rows before alignment) reads ic +0.028 at h8, t 4.0: after
 * put skew (fear of a downside move, priced into puts over calls) spikes,
 * prices rise over the following hours. `mktOptSkew24`
 * (research-columns.ts) is BTC's own skew series -- read by every symbol as
 * the market-wide reading -- already shifted forward one bar, so a read at
 * bar i reflects what was knowable at close i-1.
 *
 * LONG ONLY, mirroring dvol-spike-long: the triage's sign is positive for a
 * HIGH skew reading and the low-skew side is not the mirror of this claim.
 *
 * THRESHOLDS ARE ABSOLUTE SKEW LEVELS, not a z-score: `mktOptSkew24` is
 * reported as the raw IV-percentage-point level (the triage measured the
 * level, not a standardised reading), so `s` in [2, 4, 6] below are put-minus
 * -call 25-delta implied-vol points. A z-scored form (matching the DVOL
 * column's own treatment) is the obvious follow-up once this raw-level cell
 * has a result to compare against.
 *
 * No target: as with dvol-spike-long, the triage cell reads as drift over a
 * horizon rather than a fixed distance, so `hold` (time stop) alone closes
 * the trade.
 *
 * Params: s in [2, 4, 6] (mktOptSkew24 threshold, IV points), k in [2, 3]
 * (ATR multiple for the stop), hold in [8, 16, 32] (time stop bars).
 * 3 x 2 x 3 = 18 cells.
 */
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { StrategyFamily } from '../strategy-families';
import { currentAtr } from '../strategy-families';
import { researchValue } from '@/lib/backtest/research-series';

const SKEW_COLUMN = 'mktOptSkew24';

export const skewSpikeLongFamily: StrategyFamily = {
  name: 'skew-spike-long',
  description: 'go long after a BTC-wide 25-delta put skew spike (mktOptSkew24 triage: ic +0.028, h8, t4.0)',
  requiresResearchColumns: [SKEW_COLUMN],
  params: [
    { name: 's', values: [2, 4, 6] },
    { name: 'k', values: [2, 3] },
    { name: 'hold', values: [8, 16, 32] },
  ],
  create(params: Record<string, number>): Strategy {
    const threshold = params.s;
    const atrMultiple = params.k;
    const holdBars = params.hold;

    return {
      name: 'skew-spike-long',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;

        const skew = researchValue(ctx.research, ctx.bar, SKEW_COLUMN);
        if (!Number.isFinite(skew)) return null;

        const close = ctx.candles[ctx.bar].close;
        if (!Number.isFinite(close)) return null;

        if (skew >= threshold) {
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
