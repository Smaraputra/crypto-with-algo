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
 */

import type { TradingStyle } from '@/lib/models/signal-template';
import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { IndicatorSuite } from '@/lib/indicators/types';
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
 * ctx.suite is null, atr is not finite or not above 0, or score is not
 * finite.
 *
 * decideExit: a short exits once the bullish reading it faded is gone
 * (ctx.score <= STRATEGY_EXIT_LEVEL); a long exits once the bearish
 * reading it faded is gone (ctx.score >= -STRATEGY_EXIT_LEVEL).
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
 * below the lookback, vol20 is not above 0, or z is not finite.
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
        const logReturns: number[] = [];
        for (let i = bar - 19; i <= bar; i++) {
          logReturns.push(Math.log(candles[i].close / candles[i - 1].close));
        }
        const mean = logReturns.reduce((sum, v) => sum + v, 0) / logReturns.length;
        const variance =
          logReturns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (logReturns.length - 1);
        const vol20 = Math.sqrt(variance);
        if (!(vol20 > 0)) return null;

        const z = Math.log(candles[bar].close / candles[bar - L].close) / (vol20 * Math.sqrt(L));
        if (!Number.isFinite(z)) return null;

        const close = candles[bar].close;

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
 * above 0, or rsi is not finite.
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
 * above 0, or sk/d is not finite.
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
};
