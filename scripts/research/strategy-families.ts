/**
 * Registry of strategy families for the research walk-forward harness. A
 * family is a named, parameterized rule set: a small numeric parameter grid
 * plus a `create` function that turns one grid cell into a `Strategy`
 * (src/lib/backtest/strategy.ts) the backtest engines can run directly. Pure,
 * no I/O.
 *
 * `expandGrid` materializes a family's cartesian product of parameter
 * values, one `{ name: value }` record per grid cell, the first declared
 * param varying slowest (an odometer, least-significant digit last). Bounded
 * by `MAX_PARAMS` (a family's own declared param count) and
 * `MAX_GRID_CELLS` (the product across all params): a walk-forward's
 * per-window cost is linear in cell count, so an unbounded grid is an
 * unbounded backtest bill, not just a slow test.
 *
 * `control` has no parameters and wraps today's composite score-threshold
 * strategy (createScoreThresholdStrategy). Its thresholds and weights come
 * from the walk-forward's own config (DEFAULT_TEMPLATE_THRESHOLDS/WEIGHTS
 * for the style), never from the family, so a parameterless family still
 * varies with style and interval through the caller, not through its own
 * (empty) params.
 *
 * The other four entries (fade-composite, return-reversal,
 * oscillator-reversion, stochrsi-momentum) are Phase 4 families built from
 * the Phase 3 factor study's survivors (see the table in the header of
 * factor-ic.ts): each turns one predictive input into a small decision rule
 * over `StrategyContext`. Every rule reads `ctx.candles[i]` only for
 * `i <= ctx.bar`, returns null from `decideEntry` when `ctx.suite` is null
 * or a value it needs is not finite, and enters at market, one position at
 * a time. See each family's own header comment below for its rule, its
 * params, and the exact Phase 3 cells it rests on.
 *
 * Phase 4 results (2026-09-18, dataset 3fdeac9e495e3051ad2e2c7553be6b07b1da0d7b9e84f468d635d2708c624782,
 * commit 30a56ef, lockbox applied so every window ends 2026-06-30, ten
 * symbols, six rolling windows with train fraction 0.4 and purge equal to
 * the indicator warmup, study costs (maker 0.02%, taker 0.05%, interval
 * slippage, funding accrued from snapshots), 1000 bootstrap draws, 200
 * random-entry iterations, trials 82 (every cell across the five families),
 * seed 42; reports under data/research/reports/strategy-<family>-<interval>-p4.json,
 * every report schema-validated and one random window per report re-run
 * with --cell --report and reproduced exactly). No family passes the gate
 * set at any interval. exp is pooled out-of-sample expectancy per trade
 * after costs, CI the bootstrap 95% low bound, p the random-entry p-value,
 * stress the expectancy at 1.5x fees and 2x slippage.
 *
 *   interval family                 trades   exp%    CI low   p      stress  failed gates
 *   5m       control                19414   -0.178  -0.188   0.005  -0.324  expectancy windows symbols trials stress
 *   5m       fade-composite         27900   -0.208  -0.217   1.000  -0.356  all but sample
 *   5m       return-reversal         9305   -0.182  -0.208   0.005  -0.332  all but sample, timing
 *   5m       oscillator-reversion   23584   -0.176  -0.189   0.005  -0.326  all but sample, timing
 *   1h       control                 7519   -0.063  -0.166   0.005  -0.160  expectancy windows symbols trials stress
 *   1h       fade-composite          7084   -0.190  -0.295   0.756  -0.299  all but sample
 *   1h       return-reversal         3025   -0.232  -0.369   0.940  -0.342  all but sample
 *   1h       oscillator-reversion    4450   -0.187  -0.365   0.582  -0.296  all but sample
 *   4h       control                 1619   +0.016  -0.424   0.388  -0.064  expectancy windows symbols timing trials stress
 *   4h       fade-composite          2349   -0.170  -0.402   0.368  -0.259  all but sample
 *   4h       return-reversal         1549   -0.192  -0.511   0.517  -0.282  all but sample
 *   4h       stochrsi-momentum      12679   -0.133  -0.227   0.174  -0.223  all but sample
 *   1d       control                  157   -1.230  -3.566   0.995  -1.312  expectancy windows symbols timing trials stress
 *   1d       return-reversal          459   -1.376  -2.593   0.955  -1.466  all but sample
 *
 * Reading: at 5m every family loses about the round-trip taker cost with
 * slippage (0.20%), with tight intervals, so the rules are roughly flat
 * before costs; the entry timing of control, return-reversal, and
 * oscillator-reversion beats random entries with the same exits (p 0.005)
 * but by less than the cost. At 1h the same holds for control (timing
 * p 0.005, expectancy -0.063% with the interval touching zero), while
 * fading the composite is worse than random (p 0.756): the negative IC
 * Phase 3 measured on the composite comes from the bulk of readings, not
 * from the extremes a fade rule trades. At 4h control sits at breakeven
 * and nothing else is positive; at 1d both rules are beaten by random
 * entries and lose more than 1% per trade. The mean-reversion survivors
 * of Phase 3 do not turn into positive expectancy with market entries,
 * 2 ATR stops, and 4 to 32 bar time stops. Next experiment: maker-only
 * limit entries (0.02% per side, no slippage) for the three families
 * whose timing beats random intraday, since their shortfall is of the
 * order of the taker cost they pay.
 *
 * Limit-entry results (2026-09-19, same dataset, commit d9004f9, trials
 * 123, reports strategy-<family>-<interval>-p4.json for the three
 * *-limit families, each spot-checked with --cell --report). The maker
 * entry recovers 0.04 to 0.07% per trade and no more; every run still
 * fails, timing p 0.005 in all four.
 *
 *   interval family                        trades   exp%    CI low   p      stress  market version
 *   5m       control-limit                 13896   -0.110  -0.121   0.005  -0.192  -0.178
 *   5m       return-reversal-limit          4422   -0.138  -0.186   0.005  -0.223  -0.182
 *   5m       oscillator-reversion-limit    18986   -0.123  -0.140   0.005  -0.208  -0.176
 *   1h       control-limit                  7051   -0.022  -0.123   0.005  -0.075  -0.063
 *
 * control-limit at 1h is the closest any rule has come: interval
 * spanning zero, four of ten symbols positive, 2023 and 2024 positive
 * (+0.10%, +0.07%) and 2025 and 2026 negative. Every control-limit
 * window selected offsetBps 10, the deepest pullback in the grid, so the
 * grid edge was binding; the grid was widened to 30 bps on 2026-09-19
 * and control-limit was rerun at 1h and 5m (trials 129, reports
 * strategy-control-limit-<interval>-p4w.json, spot-checked): the
 * selection moved to 20 and 30 bps and out-of-sample expectancy did not
 * improve (1h 6,624 trades, -0.033%, CI -0.130 to 0.077, 3 of 10 symbols
 * positive; 5m 9,079 trades, -0.114%, CI -0.127 to -0.101), both still
 * failing with timing p 0.005. The edge was not hiding a better cell.
 * Conclusion of the backtest track: no rule built from the current
 * inputs, with market or resting-limit entries, pays for its costs at
 * any interval; the composite's intraday entry timing is real but worth
 * less than the cheapest way to act on it.
 *
 * PHASE 4C, 2026-09-21. Dataset e84cd66dbe01, lockbox applied, 10 symbols,
 * 6 windows, trials 342 on every run (the phase's total cell count:
 * 54x2 + 36x2 + 54x2 + 27x2 -- Phase 4b used 486 and 360, which made its
 * runs incomparable, so the phase now fixes one number). Reports
 * strategy-<family>-<interval>-p4c.json, every one schema-validated and one
 * random symbol-window per report re-run with --cell --report and reproduced
 * digit for digit. depth-imbalance-fade ran with --start 2023-01-01: the
 * archive's depth column is populated on 78.1% of metrics rows and begins
 * 2023-01-01, while candles begin 2018-10-31, so without the bound the early
 * windows have no depth at all and the run would fail for a data reason.
 *
 *   family                interval  trades  exp%     CI low   timing p  gates failed
 *   positioning-fade      1d        285     +0.752   -2.144   0.055     6 of 8
 *   positioning-fade      4h        3076    -0.217   -0.551   0.597     7 of 8
 *   positioning-horizon   1d        247     -1.488   -4.914   0.677     7 of 8
 *   positioning-horizon   4h        2758    -0.164   -0.567   0.144     7 of 8
 *   funding-z-fade        1h        2244    -0.143   -0.349   0.095     7 of 8
 *   funding-z-fade        15m       1602    -0.075   -0.194   0.005     6 of 8
 *   depth-imbalance-fade  4h        1251    +0.090   -0.360   0.144     5 of 8
 *   depth-imbalance-fade  1h        5032    -0.078   -0.194   0.045     6 of 8
 *
 * All eight fail. Nothing here pays its costs.
 *
 * THE POSITIONING RE-RUN. The four positioning rows above REPLACE the Phase
 * 4b table, which was withdrawn on 2026-09-21: both families derived their
 * trailing z from `ctx.snapshots`, which runStrategyWalkForward builds from a
 * SLICE of the candle array, so the window was fully realised in-sample and
 * truncated out-of-sample and the same grid cell labelled two different
 * factors on the two sides of the split. At 1d the test slice is 612 bars, so
 * window=720 could never be realised at all, and the 1d fade selected it in 5
 * of its 38 selecting windows. Both families now read precomputed full-series
 * columns (research-columns.ts). The numbers moved, which is the evidence the
 * columns are actually reaching the families: the 1d fade went from +0.481%
 * to +0.752% and its timing p from 0.070 to 0.055. The verdict did not move.
 * The withdrawn numbers are not repeated here; they were not testing what
 * their labels claimed.
 *
 * WHAT THE TIMING GATE NOW SAYS. Three of the eight runs clear it
 * (funding-z-fade 15m p 0.005, depth-imbalance-fade 1h p 0.045, and
 * positioning-fade 1d at 0.055 misses it), so for the first time in this
 * program a positioning-adjacent entry is distinguishable from entering at
 * random with the same exit profile. Every one of them still loses money.
 * That combination -- real timing, negative expectancy -- is the same verdict
 * Phase 4 reached on the composite at 5m and 1h: the signal is worth less
 * than the cheapest way to act on it.
 *
 * THE ONE RESULT WORTH KEEPING. depth-imbalance-fade at 4h fails 5 of 8, the
 * fewest any family has failed, and it is the first run to clear the SYMBOLS
 * gate (7 of 10 positive, threshold 0.7) and the first with a positive point
 * estimate that also survives the stress gate (+0.090% falling to +0.005% at
 * 1.5x fees and 2x slippage). Compare the 1d positioning fade, whose larger
 * +0.752% comes from 4 of 10 symbols with a CI spanning -2.1% to +3.5%: the
 * depth result is smaller and far better distributed. It fails on the
 * confidence interval (-0.360), on window consistency (0.467 against 0.6),
 * and on timing (p 0.144). It is not an edge. It is the only thing in the
 * program's history that fails for reasons that look like insufficient
 * evidence rather than absent effect, and it is the natural first input for
 * any later phase.
 *
 * WHY A STRONG IC STILL PRODUCES THIS. The IC counts every bar as an
 * observation and the Newey-West correction fixes the t-statistic for
 * overlap, but it cannot turn a highly autocorrelated factor into
 * independent bets. A long stretch of crowded positioning is one regime, and
 * a rule that trades it repeatedly is making one bet many times. In-sample
 * selection then took the shortest hold on offer (median hold 8 bars at 1d
 * and 4h) where the IC is strongest at h32, which is the overfitting the
 * out-of-sample gates exist to catch. positioning-horizon exists because the
 * first explanation was a mismatch between what was measured (the return over
 * h bars) and what was traded (a 2 or 3 ATR stop with a 2:1 target, which
 * resolves on the path instead). Removing the stops and holding to the
 * horizon made it worse, not better, so that explanation is wrong and the
 * disconnect is real.
 *
 * Per the program's standing ruling, no third rule shape was tried on any of
 * these inputs. The measured relationships are robust (positioning survives
 * an execution lag of one bar unchanged) and still do not pay their costs.
 * The next thing to vary is the container, not the rule: see the banded
 * target-exposure phase.
 *
 * PROMO FEE CHECK, 2026-09-26. Two standard-profile controls (image
 * crypto-ops:audit from 164a192, dataset e84cd66dbe01, lockbox on, all ten
 * symbols, --trials 1) and four promo-profile runs (same image and dataset,
 * lockbox on, BTCUSDT and ETHUSDT only, --fee-profile
 * promo-btc-eth-2026-07 so both symbols carry maker 0 / taker 0.036% /
 * slippage 3 bps, --trials 32):
 *
 *   run                     n     exp%     CI95                win    payoff  pf     hold  trades/day  timing p  stress   gates failed
 *   control 15m standard   4796  -0.1175  [-0.1740, -0.0583]   0.321  1.64    0.769  7     24.02       0.2438   -0.2151  expectancy, windows, symbols, timing, trials, stress
 *   control 1h standard    8436  -0.0687  [-0.1741,  0.0385]   0.339  1.83    0.927  7      8.24       0.0050   -0.1656  expectancy, windows, symbols, trials, stress
 *   control 15m promo      1674  -0.0988  [-0.1395, -0.0547]   0.318  1.62    0.752  6      5.03       0.1095   -0.1813  expectancy, windows, symbols, timing, trials, stress
 *   control 1h promo       1840  -0.1082  [-0.2014, -0.0057]   0.328  1.78    0.862  6      1.80       0.4677   -0.1907  expectancy, windows, symbols, timing, trials, stress
 *   control-limit 15m promo 1231 -0.0617  [-0.1042, -0.0182]   0.271  2.19    0.824  4      3.70       0.0050   -0.0991  expectancy, windows, symbols, trials, plateau, stress
 *   control-limit 1h promo  1650 -0.0412  [-0.1228,  0.0539]   0.299  2.21    0.926  5      1.61       0.0050   -0.0773  expectancy, windows, symbols, trials, plateau, stress
 *
 * The 15m control row reproduces the recorded Phase A control (task pA,
 * 2026-09-26) digit for digit, the byte-identity proof for the fee-profile
 * plumbing under `standard`. The 1h control row above is the FIRST
 * like-for-like 1h control on this dataset under the current scorer: the
 * older 1h row in the Phase 4 table above (n 7519, -0.063%) is the Phase 4
 * control on dataset 3fdeac9e, so it was never expected to match this one;
 * the verdict is unchanged (same five gates fail).
 *
 * Predictions recorded before the runs (ledger, 2026-09-26): control fails
 * expectancy at 1h and 15m (the discount is about 0.03% per trade against
 * losses of 0.06 to 0.12%); control-limit 1h lands near +0.02% per trade
 * with a CI spanning zero and fails expectancy, windows and timing;
 * control-limit 15m stays negative.
 *
 * Against the predictions: control fails expectancy at both intervals
 * (predicted); control-limit 15m stays negative (predicted); control-limit
 * 1h fails expectancy with a CI spanning zero (predicted) but its point
 * estimate is -0.041%, not the predicted +0.02%: the prediction assumed the
 * ten-symbol baseline of -0.022%, and the BTCUSDT+ETHUSDT subset's baseline
 * is lower, so the 0.04% maker saving does not lift it above zero. Both
 * control-limit runs clear the timing gate (p 0.005) and still lose money.
 * The trades-per-day figures above are for two symbols, not ten.
 *
 * VERDICT: KILL CRITERION FIRES. Both intervals fail expectancy for both
 * families under the best schedule Binance offers, so the fee question is
 * closed for the composite and no further composite variant runs under any
 * profile.
 *
 * CAVEAT: a like-for-like standard-profile run on the same two symbols
 * (BTCUSDT, ETHUSDT) was not pre-registered and was not run, so the promo
 * rows above measure "does the composite pay under the promotion on BTC
 * and ETH" (no), not "how much did the promotion lift it".
 *
 * Spot check: all four promo reports reproduced at BTCUSDT window 2:
 * control 1h promo 174 trades -0.11186450019777032%, control 15m promo
 * 167 trades -0.09927887669979621%, control-limit 1h promo 159 trades
 * -0.04015098296845698%, control-limit 15m promo 164 trades
 * -0.03521631691686759%.
 */

import type { TradingStyle } from '@/lib/models/signal-template';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';
import { createScoreThresholdStrategy } from '@/lib/backtest/strategies/score-threshold';
import { STRATEGY_EXIT_LEVEL } from '@/lib/signals/calibration';
import { researchValue } from '@/lib/backtest/research-series';
import {
  DEPTH_Z_WINDOW_DAYS,
  FUNDING_Z_WINDOW_DAYS,
  POSITIONING_Z_WINDOW_BARS,
  depthColumn,
  fundingColumn,
  positioningColumn,
} from './research-columns';

/** One numeric parameter a family exposes to the grid search. Numeric only;
 * a boolean-valued parameter is encoded as 0/1 and interpreted by `create`. */
export interface ParamSpec {
  name: string;
  values: number[];
}

export interface StrategyFamily {
  name: string;
  description: string;
  /** At most MAX_PARAMS entries. */
  params: ParamSpec[];
  /**
   * Research columns (research-columns.ts) this family cannot trade without.
   *
   * The harness aborts naming the symbols whose dataset cannot produce them,
   * rather than running to completion: a missing column is NaN on every bar,
   * which produces zero entries and the misleading failure "no cell reached
   * N in-sample trades" instead of "this dataset has no depth data".
   */
  requiresResearchColumns?: readonly string[];
  create(params: Record<string, number>, ctx: { style: TradingStyle; interval: string }): Strategy;
}

export const MAX_PARAMS = 4;
export const MAX_GRID_CELLS = 60;

/**
 * Cartesian product of a family's declared parameter values, in declared
 * order (the first param varies slowest). A family with no params expands
 * to one empty-record cell, `[{}]`: a strategy that reads no params is
 * still exactly one cell to run.
 *
 * Throws when the family declares more than MAX_PARAMS params, when any
 * param has no values (a family that cannot produce even one cell from
 * that param), or when the cartesian product would exceed MAX_GRID_CELLS.
 */
export function expandGrid(family: StrategyFamily): Record<string, number>[] {
  const { params } = family;

  if (params.length > MAX_PARAMS) {
    throw new Error(
      `strategy family "${family.name}" declares ${params.length} params, at most ${MAX_PARAMS} params allowed`
    );
  }

  for (const spec of params) {
    if (spec.values.length === 0) {
      throw new Error(`strategy family "${family.name}" param "${spec.name}" has no values`);
    }
  }

  const totalCells = params.reduce((product, spec) => product * spec.values.length, 1);
  if (totalCells > MAX_GRID_CELLS) {
    throw new Error(
      `strategy family "${family.name}" grid has ${totalCells} cells, at most ${MAX_GRID_CELLS} cells allowed`
    );
  }

  let cells: Record<string, number>[] = [{}];
  for (const spec of params) {
    const next: Record<string, number>[] = [];
    for (const cell of cells) {
      for (const value of spec.values) {
        next.push({ ...cell, [spec.name]: value });
      }
    }
    cells = next;
  }

  return cells;
}

/** Current ATR from an already-non-null suite, or null when the reading is
 * not a usable positive number. Shared by every Phase 4 family below: each
 * rule sizes its stop off ATR and none can trade without one. Callers check
 * `ctx.suite` for null themselves first, both for TypeScript narrowing (most
 * families also read other suite fields) and so the pre-warmup null check
 * reads the same way, once, in every family. */
function currentAtr(suite: IndicatorSuite): number | null {
  const atr = suite.atr.current;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

/**
 * fade-composite: trade against the composite score.
 *
 * Phase 3 (factor-ic.ts header): every trend-following input and the
 * composite itself predict with the wrong sign intraday -- cat.trend
 * "- h1-32" at 5m and "- h1-16" at 1h; the composite "- h8,16" at 1h
 * (h8 ic -0.022 t -6.5), positive but below the effect floor at 5m h1,2.
 * Meant for 5m and 1h. Included at 4h as the expected-to-fail check: the
 * composite and cat.trend both read "." (no survival) there, so this
 * family should show no edge at 4h.
 *
 * Params: T in [15, 24, 30] (|composite score| to fade), timeStop in
 * [8, 16, 32] bars, k in [2, 3] (ATR multiple for the stop). 18 cells.
 *
 * decideEntry: score = ctx.score. score >= T fades a bullish extreme with
 * a short (stop close + k*atr, target close - 2*k*atr); score <= -T fades
 * a bearish extreme with a long (stop close - k*atr, target
 * close + 2*k*atr). timeStopBars = timeStop either way. Null when
 * ctx.suite is null, atr is not finite or not above 0, score is not
 * finite, or the current close is not finite.
 *
 * decideExit: a short exits once the bullish reading it faded is gone
 * (ctx.score <= STRATEGY_EXIT_LEVEL); a long exits once the bearish
 * reading it faded is gone (ctx.score >= -STRATEGY_EXIT_LEVEL). False when
 * there is no position or the score is not finite.
 * STRATEGY_EXIT_LEVEL is 7.5 (src/lib/signals/calibration.ts).
 */
export const fadeCompositeFamily: StrategyFamily = {
  name: 'fade-composite',
  description: 'trade against the composite score (Phase 3: composite and every trend input wrong-signed at 5m/1h)',
  params: [
    { name: 'T', values: [15, 24, 30] },
    { name: 'timeStop', values: [8, 16, 32] },
    { name: 'k', values: [2, 3] },
  ],
  create(params: Record<string, number>): Strategy {
    const { T, timeStop, k } = params;
    return {
      name: 'fade-composite',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;
        const score = ctx.score;
        if (!Number.isFinite(score)) return null;

        const close = ctx.candles[ctx.bar].close;
        if (!Number.isFinite(close)) return null;

        if (score >= T) {
          return {
            side: 'short',
            orderType: 'market',
            stopPrice: close + k * atr,
            targetPrice: close - 2 * k * atr,
            timeStopBars: timeStop,
          };
        }
        if (score <= -T) {
          return {
            side: 'long',
            orderType: 'market',
            stopPrice: close - k * atr,
            targetPrice: close + 2 * k * atr,
            timeStopBars: timeStop,
          };
        }
        return null;
      },
      decideExit(ctx: StrategyContext): boolean {
        if (!ctx.position) return false;
        if (!Number.isFinite(ctx.score)) return false;
        if (ctx.position.side === 'short') return ctx.score <= STRATEGY_EXIT_LEVEL;
        return ctx.score >= -STRATEGY_EXIT_LEVEL;
      },
    };
  },
};

/**
 * return-reversal: fade the past L-bar return when it is large against
 * recent volatility.
 *
 * Phase 3: raw.ret1 negative at all four intervals (5m "- h1-8", 1h
 * "- h1,2,4", 4h "- h1,2", 1d "- h1,2,4,32"); raw.ret5 negative at 5m
 * ("- h1-32"), 1h ("- h1-8"), and 4h ("- h1-8"); raw.ret20 negative at 5m
 * and 1h (both "- h1-32"). Meant for all four intervals.
 *
 * Params: L in [1, 5, 20] (return lookback bars), Z in [1.5, 2, 2.5]
 * (z-score threshold), H in [4, 8, 16] (time stop bars). 27 cells. Stop
 * fixed at 2 ATR; no target, so the time stop and stop drive every exit.
 *
 * decideEntry: needs ctx.bar >= max(L, 20). vol20 is the sample standard
 * deviation (n-1) of the 20 log returns ln(close[i]/close[i-1]) for i from
 * bar-19 to bar -- the same formula as realizedVol20 in factors.ts, applied
 * to OHLCV closes. z = ln(close[bar]/close[bar-L]) / (vol20 * sqrt(L)). A
 * large drop (z <= -Z) goes long; a large rise (z >= Z) goes short -- both
 * fades of the extreme return, matching the negative raw.ret* sign above.
 * Null when ctx.suite is null, atr is not finite or not above 0, bar is
 * below the lookback, the current close is not finite (z would already be
 * non-finite too in that case; checked explicitly for symmetry with the
 * other three families), vol20 is not above 0, or z is not finite.
 *
 * decideExit: always false (the time stop and stop drive every exit).
 */
export const returnReversalFamily: StrategyFamily = {
  name: 'return-reversal',
  description: 'fade the past L-bar return when large against recent volatility (Phase 3: raw.ret1/ret5/ret20 negative across intervals)',
  params: [
    { name: 'L', values: [1, 5, 20] },
    { name: 'Z', values: [1.5, 2, 2.5] },
    { name: 'H', values: [4, 8, 16] },
  ],
  create(params: Record<string, number>): Strategy {
    const { L, Z, H } = params;
    return {
      name: 'return-reversal',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;

        const lookback = Math.max(L, 20);
        if (ctx.bar < lookback) return null;

        const { candles, bar } = ctx;
        const close = candles[bar].close;
        if (!Number.isFinite(close)) return null;

        const logReturns: number[] = [];
        for (let i = bar - 19; i <= bar; i++) {
          logReturns.push(Math.log(candles[i].close / candles[i - 1].close));
        }
        const mean = logReturns.reduce((sum, v) => sum + v, 0) / logReturns.length;
        const variance =
          logReturns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (logReturns.length - 1);
        const vol20 = Math.sqrt(variance);
        if (!(vol20 > 0)) return null;

        const z = Math.log(close / candles[bar - L].close) / (vol20 * Math.sqrt(L));
        if (!Number.isFinite(z)) return null;

        if (z <= -Z) {
          return {
            side: 'long',
            orderType: 'market',
            stopPrice: close - 2 * atr,
            targetPrice: null,
            timeStopBars: H,
          };
        }
        if (z >= Z) {
          return {
            side: 'short',
            orderType: 'market',
            stopPrice: close + 2 * atr,
            targetPrice: null,
            timeStopBars: H,
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
 * oscillator-reversion: buy oversold, sell overbought readings.
 *
 * Phase 3: raw.rsi negative at 5m ("- h1-32") and 1h ("- h1-8");
 * sig.Bollinger positive at 5m ("+ h1-32") and 1h ("+ h1-8");
 * sig.Williams %R positive at 5m ("+ h1-32") and 1h ("+ h1,2,4"). Meant
 * for 5m and 1h.
 *
 * Params: R in [25, 30, 35] (RSI oversold/overbought threshold), H in
 * [8, 16, 32] (time stop bars), band in [0, 1] (0/1-encoded: whether the
 * entry is also gated on the Bollinger band touch). 18 cells. Stop fixed
 * at 2 ATR; no target.
 *
 * decideEntry: rsi = ctx.suite.rsi.current, bb =
 * ctx.suite.bollingerBands.current. Long when rsi <= R and (band === 0 or
 * close <= bb.lower); short when rsi >= 100 - R and (band === 0 or close
 * >= bb.upper). Null when ctx.suite is null, atr is not finite or not
 * above 0, rsi is not finite, or the current close is not finite.
 *
 * decideExit: a long exits once rsi >= 50 (momentum back to neutral); a
 * short exits once rsi <= 50.
 */
export const oscillatorReversionFamily: StrategyFamily = {
  name: 'oscillator-reversion',
  description: 'buy oversold, sell overbought readings (Phase 3: raw.rsi negative and sig.Bollinger/sig.Williams %R positive at 5m/1h)',
  params: [
    { name: 'R', values: [25, 30, 35] },
    { name: 'H', values: [8, 16, 32] },
    { name: 'band', values: [0, 1] },
  ],
  create(params: Record<string, number>): Strategy {
    const { R, H, band } = params;
    return {
      name: 'oscillator-reversion',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;

        const rsi = ctx.suite.rsi.current;
        if (!Number.isFinite(rsi)) return null;
        const bb = ctx.suite.bollingerBands.current;
        const close = ctx.candles[ctx.bar].close;
        if (!Number.isFinite(close)) return null;

        if (rsi <= R && (band === 0 || close <= bb.lower)) {
          return {
            side: 'long',
            orderType: 'market',
            stopPrice: close - 2 * atr,
            targetPrice: null,
            timeStopBars: H,
          };
        }
        if (rsi >= 100 - R && (band === 0 || close >= bb.upper)) {
          return {
            side: 'short',
            orderType: 'market',
            stopPrice: close + 2 * atr,
            targetPrice: null,
            timeStopBars: H,
          };
        }
        return null;
      },
      decideExit(ctx: StrategyContext): boolean {
        if (!ctx.position || !ctx.suite) return false;
        const rsi = ctx.suite.rsi.current;
        if (!Number.isFinite(rsi)) return false;
        return ctx.position.side === 'long' ? rsi >= 50 : rsi <= 50;
      },
    };
  },
};

/**
 * stochrsi-momentum: follow a StochRSI cross out of the oversold or
 * overbought zone.
 *
 * Phase 3: sig.StochRSI positive at 4h ("+ h2,4"); cat.momentum positive
 * at 4h ("+ h2,4"), i.e. a 2-4 bar-ahead momentum edge. Meant for 4h.
 *
 * Params: zone in [20, 30] (StochRSI oversold/overbought band), hold in
 * [2, 3, 4] (time stop bars, matching the surviving 2-4 bar horizon), k in
 * [1.5, 2, 3] (ATR multiple for the stop). 18 cells. No target.
 *
 * decideEntry: { k: sk, d } = ctx.suite.stochasticRSI.current. Long when
 * d < zone and sk > d (k has crossed above d while d is still in the
 * oversold zone); short when d > 100 - zone and sk < d (the mirror,
 * overbought zone). Null when ctx.suite is null, atr is not finite or not
 * above 0, sk/d is not finite, or the current close is not finite.
 *
 * decideExit: always false (the time stop drives every exit).
 */
export const stochrsiMomentumFamily: StrategyFamily = {
  name: 'stochrsi-momentum',
  description: 'follow a StochRSI cross out of the oversold/overbought zone (Phase 3: sig.StochRSI and cat.momentum positive at 4h for 2-4 bars ahead)',
  params: [
    { name: 'zone', values: [20, 30] },
    { name: 'hold', values: [2, 3, 4] },
    { name: 'k', values: [1.5, 2, 3] },
  ],
  create(params: Record<string, number>): Strategy {
    const { zone, hold, k } = params;
    return {
      name: 'stochrsi-momentum',
      params,
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        if (!ctx.suite) return null;
        const atr = currentAtr(ctx.suite);
        if (atr === null) return null;

        const { k: sk, d } = ctx.suite.stochasticRSI.current;
        if (!Number.isFinite(sk) || !Number.isFinite(d)) return null;
        const close = ctx.candles[ctx.bar].close;
        if (!Number.isFinite(close)) return null;

        if (d < zone && sk > d) {
          return {
            side: 'long',
            orderType: 'market',
            stopPrice: close - k * atr,
            targetPrice: null,
            timeStopBars: hold,
          };
        }
        if (d > 100 - zone && sk < d) {
          return {
            side: 'short',
            orderType: 'market',
            stopPrice: close + k * atr,
            targetPrice: null,
            timeStopBars: hold,
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
 * withLimitEntry: wraps a base strategy's market entry into a resting limit
 * order, unchanged otherwise. `decideExit` delegates to `base.decideExit`
 * untouched; `decideEntry` calls `base.decideEntry(ctx, config)` and, only
 * when it returns a decision, converts it: places the order at the decision
 * bar's own close (`close = ctx.candles[ctx.bar].close`), offset by
 * `opts.offsetBps` below the close for a long or above it for a short, and
 * gives it `opts.timeoutBars`. The base decision's `side`, `stopPrice`,
 * `targetPrice`, and `timeStopBars` pass through unchanged -- only
 * `orderType`, `limitPrice`, and `timeoutBars` are added or overwritten.
 *
 * Relies on the fill semantics in limit-orders.ts and bar-loop.ts: the order
 * can never fill on its own placement bar; it fills the first later bar
 * whose low strictly breaches the limit (long) or whose high strictly
 * breaches it (short), at the limit price or at that bar's open when the
 * bar gaps through; the fill pays the maker fee with no slippage; and the
 * order is cancelled once `bar > placedBar + timeoutBars`. The fill lands on
 * a later bar at a possibly different price than the decision bar's close,
 * but the base decision's stop, target, and time stop were already computed
 * from that decision bar's own reading -- this wrapper does not recompute
 * them from the fill, only the entry order itself changes.
 *
 * Returns null when the base returns null or when the current close is not
 * finite. Reads nothing past `ctx.bar`: the only context this function
 * itself reads is `ctx.candles[ctx.bar].close`, the same bar the base
 * decision was already computed from.
 */
export interface LimitEntryOptions {
  timeoutBars: number;
  offsetBps: number;
}

export function withLimitEntry(
  base: Strategy,
  name: string,
  params: Record<string, number>,
  opts: LimitEntryOptions
): Strategy {
  return {
    name,
    params,
    decideEntry(ctx: StrategyContext, config: BacktestConfig): EntryDecision | null {
      const decision = base.decideEntry(ctx, config);
      if (!decision) return null;

      const close = ctx.candles[ctx.bar].close;
      if (!Number.isFinite(close)) return null;

      const limitPrice =
        decision.side === 'long' ? close * (1 - opts.offsetBps / 10000) : close * (1 + opts.offsetBps / 10000);

      return {
        ...decision,
        orderType: 'limit',
        limitPrice,
        timeoutBars: opts.timeoutBars,
      };
    },
    decideExit(ctx: StrategyContext, config: BacktestConfig): boolean {
      return base.decideExit(ctx, config);
    },
  };
}

/**
 * control-limit: control's composite threshold rule (createScoreThresholdStrategy,
 * see STRATEGY_FAMILIES.control below), entering on a resting limit order
 * instead of at market. Thresholds, weights, stop, and target still come
 * from the caller's own config exactly as control's do; withLimitEntry only
 * changes how the entry fills.
 *
 * Phase 4 (header table above): at 5m control traded 19,414 times at
 * -0.178% with entry timing beating random entries (p 0.005); at 1h, 7,519
 * trades at -0.063% with the same timing edge (p 0.005). Both shortfalls
 * are of the order of the round-trip taker cost control pays on every
 * entry; this variant tests whether the timing edge survives paying the
 * maker rate instead.
 *
 * Params: timeout in [1, 2, 3] (limit order timeout, bars), offsetBps in
 * [0, 5, 10, 20, 30] (limit price offset from the decision close, basis
 * points). 15 cells.
 */
export const controlLimitFamily: StrategyFamily = {
  name: 'control-limit',
  description:
    'the composite threshold rule with a resting limit entry at the decision close minus (long) or plus (short) the offset',
  params: [
    { name: 'timeout', values: [1, 2, 3] },
    { name: 'offsetBps', values: [0, 5, 10, 20, 30] },
  ],
  create(params: Record<string, number>): Strategy {
    const { timeout, offsetBps } = params;
    return withLimitEntry(createScoreThresholdStrategy(), 'control-limit', params, {
      timeoutBars: timeout,
      offsetBps,
    });
  },
};

/**
 * return-reversal-limit: return-reversal's fade-the-extreme-return rule (see
 * returnReversalFamily above), entering on a resting limit order at the
 * decision close (offset fixed at 0) instead of at market. Exit, stop, and
 * time stop are return-reversal's own, unchanged.
 *
 * Phase 4: at 5m return-reversal traded 9,305 times at -0.182% with entry
 * timing beating random entries (p 0.005) -- a shortfall of the order of
 * the round-trip taker cost it pays on every entry.
 *
 * Params: L in [5, 20], Z in [2, 2.5], H in [8, 16] (return-reversal's own
 * 27-cell grid, reduced to keep the Phase 4 cells selected most often --
 * L20 Z2.5 H16 and L20 Z2 H16 -- inside it), timeout in [1, 2] (limit order
 * timeout, bars). 16 cells. offsetBps fixed at 0.
 */
export const returnReversalLimitFamily: StrategyFamily = {
  name: 'return-reversal-limit',
  description: 'return-reversal with a resting limit entry at the decision close (offset 0)',
  params: [
    { name: 'L', values: [5, 20] },
    { name: 'Z', values: [2, 2.5] },
    { name: 'H', values: [8, 16] },
    { name: 'timeout', values: [1, 2] },
  ],
  create(params: Record<string, number>, ctx: { style: TradingStyle; interval: string }): Strategy {
    const { L, Z, H, timeout } = params;
    const base = returnReversalFamily.create({ L, Z, H }, ctx);
    return withLimitEntry(base, 'return-reversal-limit', params, { timeoutBars: timeout, offsetBps: 0 });
  },
};

/**
 * oscillator-reversion-limit: oscillator-reversion's oversold/overbought
 * rule (see oscillatorReversionFamily above), entering on a resting limit
 * order at the decision close (offset fixed at 0) instead of at market.
 * Exit, stop, and time stop are oscillator-reversion's own, unchanged.
 *
 * Phase 4: at 5m oscillator-reversion traded 23,584 times at -0.176% with
 * entry timing beating random entries (p 0.005) -- a shortfall of the order
 * of the round-trip taker cost it pays on every entry.
 *
 * Params: R in [25, 30], H in [16, 32], band in [0, 1] (oscillator-reversion's
 * own 18-cell grid, reduced to keep the Phase 4 cells selected most often --
 * R25 H32 band1 and R25 H16 band1 -- inside it), timeout in [1, 2] (limit
 * order timeout, bars). 16 cells. offsetBps fixed at 0.
 */
export const oscillatorReversionLimitFamily: StrategyFamily = {
  name: 'oscillator-reversion-limit',
  description: 'oscillator-reversion with a resting limit entry at the decision close (offset 0)',
  params: [
    { name: 'R', values: [25, 30] },
    { name: 'H', values: [16, 32] },
    { name: 'band', values: [0, 1] },
    { name: 'timeout', values: [1, 2] },
  ],
  create(params: Record<string, number>, ctx: { style: TradingStyle; interval: string }): Strategy {
    const { R, H, band, timeout } = params;
    const base = oscillatorReversionFamily.create({ R, H, band }, ctx);
    return withLimitEntry(base, 'oscillator-reversion-limit', params, { timeoutBars: timeout, offsetBps: 0 });
  },
};

/**
 * depth-imbalance-fade-limit: depth-imbalance-fade's fade-the-crowded-book
 * rule (see depthImbalanceFadeFamily above), entering on a resting limit
 * order at the decision close (offset fixed at 0) instead of at market.
 * Exit, stop, target and time stop are depth-imbalance-fade's own, unchanged.
 *
 * WHY THIS FAMILY EXISTS, and what it is predicted to do.
 *
 * Phase 4c at 4h is the program's best result: +0.090%/trade over 1,251
 * trades, the first to clear the symbols gate (7/10), and the first positive
 * point estimate to survive stress (+0.005% at 1.5x fees and 2x slippage). It
 * was measured against a TAKER cost model, and the limit-entry experiment of
 * Phase 4 never covered this family, nor 4h: `withLimitEntry` reached only
 * control, return-reversal and oscillator-reversion, at 5m and 1h. A maker
 * round trip is 0.04% against a taker round trip of about 0.14% at 4h, so this
 * run asks whether the only positive result the program has is positive after
 * costs once it stops paying the spread twice.
 *
 * PRE-REGISTERED PREDICTION, 2026-09-25: this will NOT pass. Recovering the
 * per-trade standard deviation from the Phase 4c bootstrap CI half-width
 * (sd = half * sqrt(n) / 1.96) gives about 8.12% per trade at 4h, so the edge
 * needed for the CI low bound to clear zero at n = 1,251 is about 0.450%.
 * Maker execution is worth roughly the 0.10% cost difference, lifting +0.090%
 * to about +0.190%. That is a better point estimate and still less than half
 * the bar. Proving +0.090% at this dispersion would need about 31,275 trades.
 * The prediction is recorded here before the run because a pass would mean the
 * dispersion estimate is wrong, and that is worth knowing more than the run is.
 *
 * RAN 2026-09-25 on dataset e84cd66dbe01, lockbox applied, 10 symbols, 6
 * windows, --start 2023-01-01, --trials 358 (Phase 4c's 342 plus these 16
 * cells, so every cell tried on the way to this claim is counted). One random
 * symbol-window re-run with --cell --report and reproduced digit for digit.
 *
 *   family                       interval trades exp%     CI low  timing p  gates failed
 *   depth-imbalance-fade-limit   4h       1035   -0.1919  -0.6830 0.736     7 of 8
 *
 * IT FAILED, AS PREDICTED, BUT NOT FOR THE PREDICTED REASON, AND THE REASON
 * MATTERS MORE THAN THE VERDICT. The prediction was that maker execution would
 * lift expectancy from +0.090% to about +0.190% and still miss a 0.450% bar.
 * Instead expectancy went to -0.1919%. Decomposing at approximate costs (taker
 * about 0.14% round trip at 4h, maker 0.04%; the exact blend varies because
 * `exitFillKind` prices a take-profit as maker):
 *
 *   taker: +0.090% net  ->  about +0.230% gross
 *   maker: -0.1919% net ->  about -0.152% gross
 *
 * so the fee saving of about 0.10% was swamped by a gross deterioration of
 * about 0.38%, and trades fell 1,251 to 1,035 as unfilled orders dropped out.
 *
 * THE MECHANISM IS ADVERSE SELECTION, and it is structural rather than bad
 * luck. `withLimitEntry` rests the order at the decision close, so a short
 * fills only if price RISES to it and a long only if price FALLS to it: a fill
 * requires the market to move against the trade first. For a family whose whole
 * thesis is fading a crowded book, that means being filled precisely on the
 * entries where the fade was early, and skipping the ones that worked
 * immediately. A passive entry on a mean-reversion signal is not a cheaper
 * version of the same trade, it is a different and worse trade.
 *
 * This retro-explains Phase 4's limit results rather than contradicting them:
 * control-limit at 1h recovered only 0.041% (-0.063% to -0.022%) of a roughly
 * 0.10% fee saving, and widening the offset grid to 20 and 30 bps did not help.
 * Same mechanism, milder, on families that are also reversal-shaped. A larger
 * offset buys a better price at the cost of a still more adversely selected
 * fill, and the two roughly cancel.
 *
 * CONSEQUENCE FOR THE SEARCH: the 0.04% maker cost bar is NOT available to a
 * reversal entry, so "find an edge above 0.04% and execute passively" is the
 * wrong target for this family shape. Either the signal must be
 * continuation-shaped, where resting an order is favourably selected because
 * the fill happens on a pullback that then resumes, or the edge must clear the
 * full taker cost. No third rule shape should be tried on this input, per the
 * standing ruling.
 *
 * Params: days in [30, 90], z in [1.5, 2], hold in [16, 32], timeout in [1, 2]
 * (limit order timeout, bars). 16 cells, matching the other limit families.
 * `k` is FIXED at 3 rather than swept: MAX_PARAMS is 4 and the base family
 * already uses four, so one had to go, and k=3 carried all five of the cells
 * Phase 4c selected most often at 4h (days 90/z 2/hold 32 and days 30/z 2/hold
 * 32 at nine windows each, then days 30/z 2/hold 16, days 30/z 1.5/hold 32 and
 * days 90/z 1.5/hold 32). Every one of those stays inside this grid.
 * offsetBps fixed at 0.
 */
export const depthImbalanceFadeLimitFamily: StrategyFamily = {
  name: 'depth-imbalance-fade-limit',
  description:
    'depth-imbalance-fade with a resting limit entry at the decision close (offset 0)',
  requiresResearchColumns: DEPTH_Z_WINDOW_DAYS.map(depthColumn),
  params: [
    { name: 'days', values: [30, 90] },
    { name: 'z', values: [1.5, 2] },
    { name: 'hold', values: [16, 32] },
    { name: 'timeout', values: [1, 2] },
  ],
  create(params: Record<string, number>, ctx: { style: TradingStyle; interval: string }): Strategy {
    const { days, z, hold, timeout } = params;
    const base = depthImbalanceFadeFamily.create({ days, z, hold, k: 3 }, ctx);
    return withLimitEntry(base, 'depth-imbalance-fade-limit', params, {
      timeoutBars: timeout,
      offsetBps: 0,
    });
  },
};

/**
 * The z columns these families read.
 *
 * They are NOT computed here. Every one is a trailing window, and the
 * walk-forward prepares each window from a slice of the candle array, so a
 * window derived in-strategy is full in-sample and truncated out-of-sample --
 * the same grid cell then labels two different factors, and selection
 * optimises one while the gates score the other. research-columns.ts builds
 * them once over the full series instead; see its header for the measured
 * impact on Phase 4b.
 */

/**
 * Fade crowded top-trader positioning.
 *
 * Phase 3b, 4h and 1d: a higher top-trader long/short ratio precedes lower
 * forward returns at every horizon measured (1d h32 ic -0.218 t -5.9), and the
 * sign survives an execution lag of one bar unchanged (-0.219 t -5.9). This
 * family is the cheapest rule that acts on exactly that: short when the ratio
 * is unusually high for this symbol, long when it is unusually low.
 */
const positioningFadeFamily: StrategyFamily = {
  name: 'positioning-fade',
  description: 'fade the top-trader long/short ratio when it is z sd from its own trailing mean',
  requiresResearchColumns: POSITIONING_Z_WINDOW_BARS.map(positioningColumn),
  params: [
    { name: 'window', values: [180, 360, 720] },
    { name: 'z', values: [1, 1.5, 2] },
    { name: 'hold', values: [8, 16, 32] },
    { name: 'k', values: [2, 3] },
  ],
  create(params): Strategy {
    const column = positioningColumn(params.window);
    const threshold = params.z;
    const holdBars = params.hold;
    const atrMultiple = params.k;

    return {
      name: 'positioning-fade',
      params,
      decideEntry(context) {
        if (!context.suite) return null;
        const atr = currentAtr(context.suite);
        if (atr === null) return null;

        const z = researchValue(context.research, context.bar, column);
        if (!Number.isFinite(z) || Math.abs(z) < threshold) return null;

        const close = context.candles[context.bar].close;
        if (!Number.isFinite(close)) return null;

        // Crowd long (high z) is faded short, and the reverse.
        const side: 'long' | 'short' = z > 0 ? 'short' : 'long';
        const sign = side === 'long' ? 1 : -1;
        return {
          side,
          orderType: 'market',
          stopPrice: close - sign * atrMultiple * atr,
          targetPrice: close + sign * 2 * atrMultiple * atr,
          timeStopBars: holdBars,
        };
      },
      decideExit() {
        return false;
      },
    };
  },
};

/**
 * The same positioning signal held to its horizon, with stops kept out of the way.
 *
 * positioning-fade failed at 4h with a random-entry p of 0.602, meaning its
 * entry timing was no better than chance. That is not what the IC says, and
 * the likely reason is that the two measure different things: the IC relates
 * the factor to the return over h bars, while positioning-fade cuts that
 * return short with a 2 or 3 ATR stop and a 2:1 target, so most trades resolve
 * on the path rather than at the horizon. This family removes that difference
 * so the question "does the measured relationship survive costs" gets a clean
 * answer: the stop sits far enough away to bind only in extremis, there is no
 * target, and the time stop is the exit.
 *
 * If this fails too, the finding does not pay its costs and no further rule
 * shape should be tried on it, per the program's standing ruling.
 */
const POSITIONING_WIDE_STOP_ATR = 10;

const positioningHorizonFamily: StrategyFamily = {
  name: 'positioning-horizon',
  description: 'hold the positioning fade to a fixed horizon, stops out of the way',
  requiresResearchColumns: POSITIONING_Z_WINDOW_BARS.map(positioningColumn),
  params: [
    { name: 'window', values: [180, 360, 720] },
    { name: 'z', values: [1, 1.5, 2] },
    { name: 'hold', values: [8, 16, 32] },
  ],
  create(params): Strategy {
    const column = positioningColumn(params.window);
    const threshold = params.z;
    const holdBars = params.hold;

    return {
      name: 'positioning-horizon',
      params,
      decideEntry(context) {
        if (!context.suite) return null;
        const atr = currentAtr(context.suite);
        if (atr === null) return null;

        const z = researchValue(context.research, context.bar, column);
        if (!Number.isFinite(z) || Math.abs(z) < threshold) return null;

        const close = context.candles[context.bar].close;
        if (!Number.isFinite(close)) return null;

        const side: 'long' | 'short' = z > 0 ? 'short' : 'long';
        const sign = side === 'long' ? 1 : -1;
        return {
          side,
          orderType: 'market',
          // Far enough to be a disaster brake, not an exit rule.
          stopPrice: close - sign * POSITIONING_WIDE_STOP_ATR * atr,
          targetPrice: null,
          timeStopBars: holdBars,
        };
      },
      decideExit() {
        return false;
      },
    };
  },
};

/**
 * Fade an unusually high funding rate.
 *
 * Phase 3b at execution lag 1: `raw.fundingZ` survives at 15m (h8 ic -0.0251
 * t -6.5, h16 -0.0320 t -5.9, h32 -0.0420 t -5.7) and 1h (h8 -0.0234 t -7.0,
 * h16 -0.0259 t -5.8), and at no other interval. It does NOT survive at 4h
 * under lag 1, though it did at lag 0, so this family runs at 15m and 1h only.
 *
 * This is a new input, not a new rule shape over an old one: funding z has
 * never been turned into a family. The rule is deliberately the same cheap
 * shape positioning-fade used, so that a difference in outcome is a difference
 * in the input rather than in the rule.
 *
 * It reads a precomputed column rather than deriving the z from
 * `ctx.snapshots`. An earlier version did the latter, on the reasoning that
 * `raw.fundingZ` is computed from the very same aligned snapshot array. That
 * reasoning was right about the source and wrong about the window: the
 * walk-forward prepares each window from a slice, so a 30-day window (720 bars
 * at 1h) is fully realised on the train slice and truncated across the first
 * 13% of every test window. research-columns.ts builds the column once over
 * the full series, and a test pins it equal to `raw.fundingZ` bar for bar.
 *
 * The column needs no execution-lag shift HERE, because the shift lives in
 * `buildSnapshotSeries`: a bar reads only the snapshot whose whole capture
 * window closed before that bar opened, so reading at `ctx.bar` and filling at
 * that bar's close is a one-sided delay twice over. This paragraph used to say
 * the delay came from snapshots aligning to the bar's OPEN, which was the
 * premise the 2026-09-25 audit falsified: a row stamped at a bar's open holds
 * data captured up to one interval later. Every funding-z-fade number recorded
 * before that date was measured on the looser join. Contrast
 * depth-imbalance-fade, whose source aligns to the bar's close and is
 * therefore shifted forward a bar by the producer.
 */
const fundingZFadeFamily: StrategyFamily = {
  name: 'funding-z-fade',
  description: 'fade the funding rate when it is z sd from its own trailing mean',
  requiresResearchColumns: FUNDING_Z_WINDOW_DAYS.map(fundingColumn),
  params: [
    { name: 'days', values: [15, 30, 60] },
    { name: 'z', values: [1, 1.5, 2] },
    { name: 'hold', values: [8, 16, 32] },
    { name: 'k', values: [2, 3] },
  ],
  create(params): Strategy {
    const column = fundingColumn(params.days);
    const threshold = params.z;
    const holdBars = params.hold;
    const atrMultiple = params.k;

    return {
      name: 'funding-z-fade',
      params,
      decideEntry(context) {
        if (!context.suite) return null;
        const atr = currentAtr(context.suite);
        if (atr === null) return null;

        const z = researchValue(context.research, context.bar, column);
        if (!Number.isFinite(z) || Math.abs(z) < threshold) return null;

        const close = context.candles[context.bar].close;
        if (!Number.isFinite(close)) return null;

        // Negative IC: expensive funding (high z) precedes lower returns, so a
        // high z is faded short and the reverse.
        const side: 'long' | 'short' = z > 0 ? 'short' : 'long';
        const sign = side === 'long' ? 1 : -1;
        return {
          side,
          orderType: 'market',
          stopPrice: close - sign * atrMultiple * atr,
          targetPrice: close + sign * 2 * atrMultiple * atr,
          timeStopBars: holdBars,
        };
      },
      decideExit() {
        return false;
      },
    };
  },
};

/**
 * Fade a crowded order book.
 *
 * Phase 3b at execution lag 1: `raw.depthImbalance1`, the cumulative bid/ask
 * depth imbalance within +/-1% of mid, runs contrarian at 4h (h8 ic -0.0269
 * t -4.9, h16 -0.0408 t -5.8, h32 -0.0515 t -5.7) and at 1h (h16 -0.0219
 * t -5.6, h32 -0.0252 t -5.0). It does not clear the survivor rule at 1d under
 * lag 1, and not at all at 5m or 15m, so this family runs at 4h and 1h.
 *
 * A new input, never turned into a family before. The rule is deliberately the
 * same shape positioning-fade and funding-z-fade use, so a difference in
 * outcome is a difference in the input rather than in the rule.
 *
 * Why a trailing z rather than a threshold on the raw imbalance, which is
 * already bounded in [-1, 1]: the IC was measured by Spearman rank inside each
 * symbol, and a symbol whose book is structurally thicker on one side carries
 * a non-zero mean imbalance. The same argument positioning-fade makes for the
 * long/short ratio.
 *
 * The window is in DAYS, not bars, so one cell means the same span at 4h and
 * at 1h. (positioning-fade's window is in bars, kept that way only so the
 * Phase 4b re-run stays comparable to the recorded table.)
 */
const depthImbalanceFadeFamily: StrategyFamily = {
  name: 'depth-imbalance-fade',
  description: 'fade order-book depth imbalance at +/-1% when it is z sd from its own trailing mean',
  requiresResearchColumns: DEPTH_Z_WINDOW_DAYS.map(depthColumn),
  params: [
    { name: 'days', values: [30, 90] },
    { name: 'z', values: [1, 1.5, 2] },
    { name: 'hold', values: [8, 16, 32] },
    { name: 'k', values: [2, 3] },
  ],
  create(params): Strategy {
    const column = depthColumn(params.days);
    const threshold = params.z;
    const holdBars = params.hold;
    const atrMultiple = params.k;

    return {
      name: 'depth-imbalance-fade',
      params,
      decideEntry(context) {
        if (!context.suite) return null;
        const atr = currentAtr(context.suite);
        if (atr === null) return null;

        const z = researchValue(context.research, context.bar, column);
        if (!Number.isFinite(z) || Math.abs(z) < threshold) return null;

        const close = context.candles[context.bar].close;
        if (!Number.isFinite(close)) return null;

        // Negative IC: a heavy bid book precedes lower returns, so an
        // unusually positive imbalance is faded short and the reverse.
        const side: 'long' | 'short' = z > 0 ? 'short' : 'long';
        const sign = side === 'long' ? 1 : -1;
        return {
          side,
          orderType: 'market',
          stopPrice: close - sign * atrMultiple * atr,
          targetPrice: close + sign * 2 * atrMultiple * atr,
          timeStopBars: holdBars,
        };
      },
      decideExit() {
        return false;
      },
    };
  },
};

export const STRATEGY_FAMILIES: Record<string, StrategyFamily> = {
  control: {
    name: 'control',
    description: 'current composite score with calibrated thresholds',
    params: [],
    create(): Strategy {
      return createScoreThresholdStrategy();
    },
  },
  'fade-composite': fadeCompositeFamily,
  'return-reversal': returnReversalFamily,
  'oscillator-reversion': oscillatorReversionFamily,
  'stochrsi-momentum': stochrsiMomentumFamily,
  'control-limit': controlLimitFamily,
  'return-reversal-limit': returnReversalLimitFamily,
  'oscillator-reversion-limit': oscillatorReversionLimitFamily,
  'positioning-fade': positioningFadeFamily,
  'positioning-horizon': positioningHorizonFamily,
  'funding-z-fade': fundingZFadeFamily,
  'depth-imbalance-fade': depthImbalanceFadeFamily,
  'depth-imbalance-fade-limit': depthImbalanceFadeLimitFamily,
};
