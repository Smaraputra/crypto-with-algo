/**
 * gamma-regime-reversal: fade the last completed bar's return, but only in
 * the dealer-gamma regime where fading works. Reddit/X options-flow threads
 * (T2.2, T6.8, S100, X4) claim dealers who are net long gamma -- i.e.
 * customers were net SELLERS of gamma over the trailing 24h -- hedge by
 * buying dips and selling rallies, mechanically suppressing and reversing
 * short-term moves; dealers net short gamma (customers net buyers) do the
 * opposite, amplifying moves into continuation.
 *
 * The develop-slice IC triage confirms the asymmetry at 4h: masked to bars
 * where the 24h gamma flow reads negative (customers net gamma sellers,
 * dealers long), `raw.ret1InNegGammaFlow` has ic -0.0615, t -6.9 at h2
 * (10/10 symbols, 5/5 quarters) against an unconditional `raw.ret1` of only
 * -0.012 -- the regime more than quintuples the one-bar reversal. The
 * mirror, `raw.ret1InPosGammaFlow` (dealers short gamma), reads only +0.023
 * at h4 and survives just 2 of 5 quarters: weaker and less robust. Per the
 * brief, only the negative-regime FADE is built this round; the
 * continuation mirror (trading WITH the last bar's move when dealers are
 * short gamma) is deliberately not built.
 *
 * `mktOptGammaFlow24Z` (research-columns.ts) is a 30-day trailing z of BTC's
 * 24-consecutive-hour trailing sum of Deribit net dollar gamma, close-
 * aligned and then `shiftForwardOneBar`-ed: at index i it describes candle
 * `i - 1`'s OWN reading (the 24h window ending at close i-1), held back one
 * bar for causality -- reading it at `ctx.bar = i` is safe because it was
 * knowable before bar i opened, but the row it describes is bar `i - 1`, not
 * bar `i`.
 *
 * THE PAIRING THIS FAMILY MUST REPRODUCE. The develop-slice triage's
 * `raw.ret1InNegGammaFlow` is a CONTEMPORANEOUS masking on the raw,
 * unshifted, close-aligned data: at row `j`, `ret1[j]` (candle `j`'s own
 * return, `close[j]/close[j-1] - 1`) is masked by that SAME row's gamma-flow
 * reading, `gammaFlow[j]`, and the triage's lag-1 forward return starts at
 * the NEXT close after row `j`, i.e. `close[j+1]`. Backtesting that exact
 * combination causally means: at decision bar `i` (entering at `close[i]`,
 * the "next close" after row `j`), the row being tested is `j = i - 1`. Its
 * gamma-flow reading is exactly what `mktOptGammaFlow24Z` already carries at
 * `ctx.bar = i` (see above -- no index shift needed at the read site), and
 * its own one-bar return is `candles[i - 1].close / candles[i - 2].close - 1`
 * -- the PREVIOUS completed bar's return, not the current one. Fading
 * `candles[i].close / candles[i - 1].close - 1` instead (an earlier version
 * of this family did) is still fully causal but pairs the gamma reading with
 * a return one bar newer than the row it was measured on, which is not the
 * combination `raw.ret1InNegGammaFlow`'s ic speaks to.
 *
 * Params: g in [0.5, 1, 1.5] (gamma-flow z magnitude; the gate fires when
 * `mktOptGammaFlow24Z <= -g`); r in [0.002, 0.005] (0.2%/0.5%, the ret1
 * magnitude that must be exceeded to trade); k in [2, 3] (ATR multiple for
 * the stop); hold in [2, 4] (time-stop bars, matching the h2 cell the ic was
 * measured at and one double it). 3 x 2 x 2 x 2 = 24 cells. No `regime`
 * param: g/r/k/hold already spend the family's MAX_PARAMS budget of 4.
 *
 * decideEntry: null when `ctx.suite` is null, `currentAtr` is not
 * finite/positive, `ctx.bar < 2` (candle `i - 2` must exist to compute the
 * fade bar's own return), the entry close (`candles[i]`) or either fade-bar
 * close (`candles[i - 1]`, `candles[i - 2]`) is not finite,
 * `mktOptGammaFlow24Z` (read at `ctx.bar = i`, describing row `i - 1`) is not
 * finite or the gate `<= -g` fails, or the resulting `ret1` -- candle
 * `i - 1`'s own return -- is finite but inside `[-r, r]` (no fade signal,
 * boundary itself does not trade -- the comparisons are strict). ret1 > r
 * fades a fade-bar that just rose: short at the current close, stop
 * `k * atr` above, target 1R below (the stop's own risk distance, mirrored
 * to the favourable side). ret1 < -r fades a fade-bar that just fell: long
 * at the current close, stop `k * atr` below, target 1R above.
 * `timeStopBars = hold` either way.
 *
 * decideExit: always false -- the stop, the 1R target, and the time stop
 * drive every exit, per the shared family rules.
 *
 * No limit variant this round; not asked for in the brief.
 */

import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { StrategyFamily } from '../strategy-families';
import { currentAtr } from '../strategy-families';
import { researchValue } from '@/lib/backtest/research-series';

const GAMMA_FLOW_COLUMN = 'mktOptGammaFlow24Z';

function decideGammaRegimeReversalEntry(
  context: StrategyContext,
  params: { g: number; r: number; k: number; hold: number }
): EntryDecision | null {
  if (!context.suite) return null;
  const atr = currentAtr(context.suite);
  if (atr === null) return null;

  if (context.bar < 2) return null;
  const close = context.candles[context.bar].close;
  const fadeBarClose = context.candles[context.bar - 1].close;
  const fadeBarPrevClose = context.candles[context.bar - 2].close;
  if (!Number.isFinite(close) || !Number.isFinite(fadeBarClose) || !Number.isFinite(fadeBarPrevClose)) {
    return null;
  }

  const gammaFlowZ = researchValue(context.research, context.bar, GAMMA_FLOW_COLUMN);
  if (!Number.isFinite(gammaFlowZ) || gammaFlowZ > -params.g) return null;

  const ret1 = fadeBarClose / fadeBarPrevClose - 1;
  if (!Number.isFinite(ret1)) return null;

  if (ret1 > params.r) {
    const stopPrice = close + params.k * atr;
    const risk = stopPrice - close;
    return {
      side: 'short',
      orderType: 'market',
      stopPrice,
      targetPrice: close - risk,
      timeStopBars: params.hold,
    };
  }

  if (ret1 < -params.r) {
    const stopPrice = close - params.k * atr;
    const risk = close - stopPrice;
    return {
      side: 'long',
      orderType: 'market',
      stopPrice,
      targetPrice: close + risk,
      timeStopBars: params.hold,
    };
  }

  return null;
}

export const gammaRegimeReversalFamily: StrategyFamily = {
  name: 'gamma-regime-reversal',
  description:
    'fade the last completed bar return when 24h dealer gamma flow is negative (dealers long gamma)',
  requiresResearchColumns: [GAMMA_FLOW_COLUMN],
  params: [
    { name: 'g', values: [0.5, 1, 1.5] },
    { name: 'r', values: [0.002, 0.005] },
    { name: 'k', values: [2, 3] },
    { name: 'hold', values: [2, 4] },
  ],
  create(params: Record<string, number>): Strategy {
    const { g, r, k, hold } = params;
    return {
      name: 'gamma-regime-reversal',
      params,
      decideEntry(context: StrategyContext): EntryDecision | null {
        return decideGammaRegimeReversalEntry(context, { g, r, k, hold });
      },
      decideExit(): boolean {
        return false;
      },
    };
  },
};
