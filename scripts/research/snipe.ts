/**
 * SNIPE PHASE: does any rare, extreme condition give precise entries BEFORE costs? Pre-registered.
 *
 * Why: after the qh-flow null (ledger 1,769, nothing passes after costs), the user asked what happens if costs
 * are set aside and the research looks for precise, high-win entries ("sniping", or "precise many entries").
 * The user chose (plan ~/.claude/plans/snipe-precision-2026-10-10.md, 2026-10-09/10):
 * - purpose: answer whether any precise edge exists at all, BEFORE costs. Costs are reported beside every
 *   result and are not a gate. Win rate is the target here, always next to its break-even line.
 * - both timeframes, compared: SCALP (condition at each 5m close, at most 1 hour in the trade) and INTRADAY
 *   (condition at each 1h close, at most 24 hours).
 * - scan the extremes of every existing price, volume, positioning and timing column on a discovery slice,
 *   then confirm at most 5 cells on later data.
 * - discovery from the earliest complete data, without the flow columns; confirmation 2025-01 to 2026-06.
 * - equal target and stop at 1x ATR.
 * - ANY statistically significant gain over a matched random entry counts (no minimum effect size); the gain
 *   and its break-even win rates are always reported beside it.
 * agy reviewed the design before this lock (2026-10-10); its points and the rulings are at the end.
 *
 * Expected outcome, stated before any data is read: some cells will show a significant gross gain at
 * discovery (extremes of short-horizon returns and taker flow carry real but small reversal effects; the
 * qh-flow phase measured one at ic -0.015), and any gain that confirms will sit far below the taker break-even
 * win rate, most of all at 5m.
 *
 * STATUS: LOCKED once committed, before any dataset is exported or read. Nothing below may change; a change is
 * a new pre-registration and new trials. Choices the text leaves open are recorded as implementation notes at
 * build time, before any discovery run.
 *
 * DATA
 *
 * - Ten Binance USDT-M perpetuals: BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK.
 * - One export (export-dataset.ts): perp klines at 5m, 1h and 4h, premiumIndex at 5m and 1h, futures metrics
 *   (5m grid), snapshots at 1h, from 2022-01-01T00:00:00Z to 2026-06-30T23:59:59Z. Perp prices and positioning
 *   start 2022-01-01 for all ten symbols, which sets the discovery start.
 * - DISCOVERY 2022-01-01T00:00:00Z to 2024-12-31T23:59:59Z. CONFIRMATION 2025-01-01T00:00:00Z to
 *   2026-06-30T23:59:59Z. LOCKBOX: nothing from 2026-07-01 onward is read; a final exam there needs the user's
 *   explicit approval later.
 * - A condition bar whose trade window (entry plus the time limit) would end after its slice's end is dropped,
 *   so no trade path crosses from discovery into confirmation or from confirmation into the lockbox.
 *
 * COLUMNS (38, the `raw.*` columns of scripts/research/factors.ts at each interval, built on PERP candles)
 *
 * ret1, ret5, ret20, rsi, emaSpreadPct, atrPct, realizedVol20, varianceRatio, htfTrend, ret1AfterDown,
 * ret1AfterUp, ret1FarRound, ret1NearRound, ret1InAsia, ret1InNyOverlap, ret1InTrend, ret1InMeanReversion,
 * ret1InHighTaker, ret1InLowTaker, ret1InHighVolRatio, ret1InLowVolRatio, takerBuyRatio, takerLongShortRatio,
 * fundingRate, fundingZ, fundingProximity, oiChange1, oiChange8, oiPriceDiv, longShortRatio, globalAccountRatio,
 * topTraderPositionRatio, basisPct, hourOfDayDrift, hourOfDayDriftDev, sessionDrift, weekdayDriftDev, fearGreed.
 *
 * - The factor matrix takes perp klines as its candles at both timeframes (the instrument traded). The HTF
 *   context is recomputed from perp candles (the exported htf is spot-based). raw.perpSpotSpreadPct is
 *   excluded: on a perp price base it is self-referential, and spot 5m candles start 2023-10-14.
 * - Columns keep their existing definitions per interval (5m uses the scalping indicator periods, 1h the
 *   day-trading ones). Snapshot columns read the latest 1h snapshot whose hour closed before the bar opened
 *   (src/lib/backtest/snapshot-series.ts), so they are up to about 2 hours stale at 5m; no lookahead.
 * - Excluded by the user's choice of discovery data: the four qh-flow columns, the six order-book depth
 *   columns (depth starts 2023), and the fourteen options columns.
 *
 * TAILS
 *
 * - Per symbol and column, thresholds at the 99th and 1st percentiles ("snipe", 1%) and at the 90th and 10th
 *   ("many entries", 10%) of the column's finite values over the trailing 90 days, recomputed at each UTC
 *   calendar month start from data strictly before it. A bar is in the TOP tail if its value >= the upper
 *   threshold, in the BOTTOM tail if <= the lower. No threshold before 90 days of history exist.
 * - A cell whose tail share over its slice, pooled across symbols, exceeds twice its nominal share (ties in a
 *   discrete column) is reported as SKIPPED and counts as a trial with p = 1.
 *
 * TRADE AND LABEL
 *
 * - Condition at bar t's close; entry at bar t+1's open (execution lag 1). Target = entry + 1 x ATR, stop =
 *   entry - 1 x ATR for a long (mirrored for a short), ATR = Wilder ATR(14) of the entry timeframe through
 *   bar t-1 (the condition bar does not set its own barriers).
 * - The path is walked on 5m perp candles from the entry: a candle whose high reaches the upper level and
 *   whose low does not reach the lower is UP; the reverse is DOWN; a candle reaching both is AMBIGUOUS; no touch
 *   within 1 hour (scalp) or 24 hours (intraday) is TIMEOUT. The first deciding candle ends the trade.
 * - Win rate = wins / (wins + losses). Timeouts and ambiguous trades are excluded from it and reported. A long
 *   wins on UP, a short on DOWN, so on resolved trades the short's win rate is one minus the long's: each cell
 *   has ONE signed excess, positive = long edge, negative = short edge.
 * - One open position per symbol per cell: a flagged bar whose entry is before the open trade's exit is
 *   skipped. Timeouts and ambiguous trades also block until their exit.
 *
 * STATISTIC
 *
 * - excess = mean over the cell's taken resolved trades of (y - b), y = 1 for UP else 0, b = the baseline long
 *   win rate of the trade's stratum: symbol x UTC calendar month x ATR quintile, from every resolved bar of
 *   that timeframe in the stratum (no blocking). ATR quintile = quintile of ATR% (ATR(14) through t-1 over
 *   bar t-1's close) within the symbol's trailing 90 days, recomputed monthly like the tail thresholds.
 *
 * NULL
 *
 * - Common grid: the bar timestamps present for all ten symbols in the slice, after warmup, threshold
 *   availability and the path-end drop; the bars each symbol loses to it are reported.
 * - Each draw shifts every symbol's tail flags by ONE common offset, uniform in [30 days, G - 30 days] in bars
 *   (G = grid length), circularly on the grid; labels, baselines and exits stay in place; blocking is
 *   recomputed; the statistic is recomputed on the grid. Seed 7. Discovery 200 draws, confirmation 1,000.
 * - The null tests timing: with the baseline matched to each label's own symbol, month and volatility
 *   quintile, a shifted flag set scores about zero.
 *
 * DISCOVERY (2022-01-01 to 2024-12-31): 304 CELLS = 38 columns x 2 tails x 2 levels x 2 timeframes
 *
 * - Two-sided p from the null-calibrated z: z = (observed excess on the grid - null mean) / null sd, normal
 *   two-sided p. (200 draws cannot resolve the BH thresholds over 304 cells; the z keeps the null's spread.)
 * - Benjamini-Hochberg q 0.10 over all 304 cells (skipped cells and cells without trades enter with p = 1).
 * - CONSISTENCY: the excess has the cell's overall sign in at least 60% of calendar quarters (pooled across
 *   symbols; quarters with fewer than 20 resolved trades excluded; at least 4 must remain) and in at least 7
 *   symbols among those with 20 or more resolved trades (at least 7 must remain).
 * - SELECTION: among BH-rejected cells that pass consistency, at most one per (column, tail, timeframe) (the
 *   smaller p wins), then the 5 smallest p (ties: larger |excess|). The direction is the sign of the excess.
 * - If none is selected the phase closes with NULL at discovery.
 *
 * CONFIRMATION (2025-01-01 to 2026-06-30)
 *
 * - Each selected cell, direction, timeframe, level and threshold rule fixed. PASS: one-sided empirical p
 *   (1,000 draws, (1 + #draws with a signed excess at least the observed) / 1,001) below 0.05 / m, m the number
 *   of confirmed cells, AND the consistency legs above with the fixed sign.
 * - VERDICT: EDGE BEFORE COSTS if at least one cell passes, else NULL. Either way no strategy is built and
 *   nothing is deployed; a lockbox exam or any cost-aware follow-up is the user's decision.
 *
 * REPORTED PER CELL: trades taken, resolved, timeout share, ambiguous share, win rate, matched baseline,
 * excess, day-block bootstrap 95% CI of the excess (1,000 resamples of UTC days, seed 11), z and its p,
 * empirical p, quarter and symbol agreement, mean and median ATR%, and the maker and taker break-even win
 * rates (mean over trades of 0.5 + f / (2 x ATR%), f = 0.04% maker and 0.10% taker round trip, the user's
 * confirmed standard USDT-M fees).
 *
 * SANITY BEFORE DISCOVERY IS READ: the baseline long win rate per timeframe (reported; near 50% expected), the
 * timeout and ambiguous shares, a hand-checked label sample, and one random --cell spot check per report
 * reproduced digit for digit.
 *
 * TRIALS: 304 discovery cells plus at most 5 confirmation cells, at most 309. Program ledger 1,769 before this
 * phase, at most 2,078 after it. No trial outside this budget without the user's consent.
 *
 * AGY CRITIQUE (2026-10-10) AND RULINGS, recorded before the lock:
 * - Baseline ignores volatility clustering: ADOPTED, the baseline is matched on the ATR quintile as well.
 * - The shift moves tail events into other volatility regimes: the shift is relative, so shifting the paths
 *   is the same test; with the volatility-matched baseline the null centres at zero. KEPT.
 * - ATR at the condition bar is inflated by the tail bar: ADOPTED, ATR through t-1.
 * - Timeouts punish low-volatility conditions; both-touched candles depress 5m win rates: ADOPTED, both are
 *   excluded from the win rate and reported.
 * - BH under correlated columns, thin per-symbol quarters: BH kept as the program standard (approximate under
 *   dependence); quarter consistency is pooled across symbols, so no threshold is lowered.
 */

/** Program trial ledger before this phase (qh-flow.ts QH_FLOW_LEDGER_AFTER on research/qh-flow). */
export const SNIPE_LEDGER_BEFORE = 1_769;

export const SNIPE_DISCOVERY_CELLS = 304;
export const SNIPE_MAX_CONFIRM = 5;
/** 304 discovery cells plus at most 5 confirmation cells. */
export const SNIPE_TRIAL_BUDGET = 309;

/** Inclusive slice bounds, UTC. */
export const SNIPE_DISCOVERY = { start: '2022-01-01T00:00:00Z', end: '2024-12-31T23:59:59Z' } as const;
export const SNIPE_CONFIRMATION = { start: '2025-01-01T00:00:00Z', end: '2026-06-30T23:59:59Z' } as const;
export const SNIPE_LOCKBOX_START = '2026-07-01T00:00:00Z';

export const SNIPE_COLUMNS = [
  'raw.ret1',
  'raw.ret5',
  'raw.ret20',
  'raw.rsi',
  'raw.emaSpreadPct',
  'raw.atrPct',
  'raw.realizedVol20',
  'raw.varianceRatio',
  'raw.htfTrend',
  'raw.ret1AfterDown',
  'raw.ret1AfterUp',
  'raw.ret1FarRound',
  'raw.ret1NearRound',
  'raw.ret1InAsia',
  'raw.ret1InNyOverlap',
  'raw.ret1InTrend',
  'raw.ret1InMeanReversion',
  'raw.ret1InHighTaker',
  'raw.ret1InLowTaker',
  'raw.ret1InHighVolRatio',
  'raw.ret1InLowVolRatio',
  'raw.takerBuyRatio',
  'raw.takerLongShortRatio',
  'raw.fundingRate',
  'raw.fundingZ',
  'raw.fundingProximity',
  'raw.oiChange1',
  'raw.oiChange8',
  'raw.oiPriceDiv',
  'raw.longShortRatio',
  'raw.globalAccountRatio',
  'raw.topTraderPositionRatio',
  'raw.basisPct',
  'raw.hourOfDayDrift',
  'raw.hourOfDayDriftDev',
  'raw.sessionDrift',
  'raw.weekdayDriftDev',
  'raw.fearGreed',
] as const;

export type SnipeColumn = (typeof SNIPE_COLUMNS)[number];

export const SNIPE_TIMEFRAMES = {
  scalp: { interval: '5m', maxHoldMs: 60 * 60_000 },
  intraday: { interval: '1h', maxHoldMs: 24 * 60 * 60_000 },
} as const;

export type SnipeTimeframe = keyof typeof SNIPE_TIMEFRAMES;

/** Tail share per side: 1% ("snipe") and 10% ("many entries"). */
export const SNIPE_TAIL_LEVELS = { snipe: 0.01, many: 0.1 } as const;

export type SnipeLevel = keyof typeof SNIPE_TAIL_LEVELS;
export type SnipeTail = 'top' | 'bottom';

export const SNIPE_THRESHOLD_LOOKBACK_DAYS = 90;
/** A cell whose pooled tail share exceeds this multiple of its nominal share is skipped (ties). */
export const SNIPE_TIE_SKIP_FACTOR = 2;

export const SNIPE_ATR_PERIOD = 14;
export const SNIPE_BARRIER_ATR = 1;
export const SNIPE_ATR_QUINTILES = 5;

export const SNIPE_NULL = { discoveryDraws: 200, confirmationDraws: 1_000, seed: 7, minShiftDays: 30 } as const;
export const SNIPE_BOOTSTRAP = { resamples: 1_000, seed: 11 } as const;
export const SNIPE_FDR_Q = 0.1;
export const SNIPE_CONFIRM_ALPHA = 0.05;

export const SNIPE_CONSISTENCY = {
  quarterShare: 0.6,
  minQuarterTrades: 20,
  minQuarters: 4,
  symbolsAgree: 7,
  minSymbolTrades: 20,
} as const;

/** Round-trip fees in percent of notional (standard USDT-M: 0.02% maker, 0.05% taker per side). */
export const SNIPE_FEES = { makerRoundTripPct: 0.04, takerRoundTripPct: 0.1 } as const;
