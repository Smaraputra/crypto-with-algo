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
 * and the results of the rerun are recorded below by the controller.
 */

import type { TradingStyle } from '@/lib/models/signal-template';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { BacktestConfig } from '@/lib/backtest/types';
import { createScoreThresholdStrategy } from '@/lib/backtest/strategies/score-threshold';
import { STRATEGY_EXIT_LEVEL } from '@/lib/signals/calibration';

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
 * STRATEGY_EXIT_LEVEL is 6 (src/lib/signals/calibration.ts).
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
};
