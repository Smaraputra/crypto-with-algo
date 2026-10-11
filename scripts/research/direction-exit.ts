/**
 * DIRECTION AND EXIT STUDY: when does a composite call point the right way, can a fixed rule improve
 * that direction, and when should a position on a call be closed? Pre-registered.
 *
 * WHY: on 2026-10-11, after the chart began marking each past call right or wrong, the user asked to
 * study the labelled calls, to improve the calls' direction from published research, and to learn when
 * to close a position, having seen calls that were well up partway through the holding window end wrong
 * at the fixed horizon. Decisions the user made in the design conversation: develop on 2022 to 2024 and
 * confirm on history (2025-01-01 to 2026-10-09), knowing that history informed earlier phases; fixed
 * rules only for skipping calls (the standing ruling against ML over existing inputs stays); three exit
 * rules (take-profit, take-profit plus stop, score-reversal); 1h and 4h only.
 *
 * STATUS: LOCKED once committed, before any dataset for this study is exported, any period is re-scored
 * or any number below is computed. Amendments are allowed only before the development data is read and
 * only to tighten. The scorer, weights, cutoffs and configVersion are not touched; nothing here reaches
 * GlobalSignal, SignalOutcome, the paper desk or the chart's re-score collections.
 *
 * WHAT THE PROGRAM ALREADY KNOWS (the reasons for the scope):
 * - Phase 3 (2026-09-18): at 5m to 1h every trend-following input, the composite included, predicts with
 *   the wrong sign; short-horizon reversal dominates, about half of it bid-ask bounce (execution lag).
 * - Session 17 sign audit: the additive ceiling of the composite's categories, each flipped to its
 *   measured sign, is below the cheapest taker line at 5m, 15m and 1h and above it at 4h and 1d, in
 *   information-coefficient terms. So a direction fix can pay only at 4h (1d has too few calls).
 * - Session 19: break-even and trailing stops on the composite rule ("control-managed") made it worse.
 * - The v8 re-score (scripts/research/v8-rescore.ts): over 2025-10 to 2026-10 the calls were right less
 *   often than chance at 5m, 15m and 1h (balanced hit rate 0.467, 0.459, 0.441); acting on every call
 *   lost about the cost.
 *
 * LITERATURE (verified 2026-10-11 against abstracts, publisher pages or full texts):
 * - Horizon structure: continuation over days to weeks (Liu and Tsyvinski 2021, RFS 34(6)); unstable
 *   intraday sign (Wen, Bouri, Xu, Zhao 2022, NAJEF 62); the best documented intraday BTC continuation
 *   breaks even at 3 to 10 bps, below fees (Shen, Urquhart, Wang 2022, Financial Review 57(2)).
 * - Technical rules: BTC's best rule lost out of sample after surviving data-snooping control in sample
 *   (Hudson and Urquhart 2021, Annals of OR 297).
 * - Combination: estimated weights usually lose to equal weights out of sample (Smith and Wallis 2009,
 *   OBES 71; Claeskens, Magnus, Vasnev, Wang 2016, IJF 32). Hence D1's equal weights.
 * - Abstention: about +1 to +3 points of directional accuracy at 37% to 63% coverage, out of sample on
 *   metals futures (Chalkidis and Savani 2021, ICAIF). No independent real-data out-of-sample proof of
 *   meta-labeling was found. Hence one fixed rule, not a model.
 * - Exits: under a martingale no bounded exit rule changes expected value (optional stopping, Durrett,
 *   Probability: Theory and Examples, Thm 4.4.1); stop-losses lower expected return under random walks
 *   and mean reversion and can help only with momentum (Kaminski and Lo 2014, JFM 18); tight stops lose
 *   to costs (Lo and Remorov 2017, JFM 34); under mean reversion the optimal exit includes a take-profit
 *   (Leung and Li 2015, IJTAF 18). With zero edge a path touches +a about twice as often as it finishes
 *   above +a (reflection principle), so "was up, ended wrong" is expected even without an edge.
 * - Tests: Pesaran and Timmermann 2009 (JASA 104, directional dependence robust to serial dependence);
 *   Anatolyev and Gerko 2005 (JBES 23, return-weighted directional test); Bailey and Lopez de Prado
 *   2014 (deflated Sharpe).
 *
 * DATA
 * - Ten symbols: BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK (USDT).
 * - A new export (scripts/research/export-dataset.ts) on the VPS: spot candles 1h, 4h and 1d with
 *   snapshots and per-settlement funding, 2021-10-01 (warmup only) to 2026-10-09T23:59:59.999Z, with the
 *   lockbox allowed. Its manifest hash is recorded in the RESULT block and every run asserts it.
 * - DEVELOP = 2022-01-01T00:00:00.000Z to 2024-12-31T23:59:59.999Z.
 *   CONFIRM = 2025-01-01T00:00:00.000Z to 2026-10-09T23:59:59.999Z, read once, for the verdict only.
 * - Cells: day_trading at 1h (horizon 24 bars, defaultCostPercent 0.16) and swing_trading at 4h (horizon
 *   30 bars, 0.14). 5m, 15m and 1d are out of scope: spot 5m and 15m history covers only the last twelve
 *   months, and 1d had 39 buy calls in the whole re-scored year.
 *
 * REPRODUCTION CHECK (runs first; failing it stops the study before any develop number is read):
 * the research matrix composite on the new export, for the confirmation period's overlap with the
 * labelled year (2025-10-01 to 2026-10-09), must reproduce the hashed re-score rows
 * ($HOME/rescore-out/v8-rows.jsonl.gz, sha256 2addedf2b2ce8d2e22d04a3f58fb207867f09f9546b25c7ee87e89f7e0967d68)
 * at 1h and 4h: same tier on at least 99% of matched bars and score correlation at least 0.999. Only
 * tiers and scores are compared, never returns. (This replaces the conversation's "D0-E4 reproduces the
 * existing control", which was wrong: that control also carries percent stops and targets and no
 * horizon.)
 *
 * PART A, DIAGNOSIS (descriptive, DEVELOP only, adds no trial). A "call" is a bar whose v8 tier is buy or
 * strong buy (direction +1) or sell or strong sell (-1); its outcome is the live resolver's, the spot
 * return from the signal bar's close to the close a horizon later (the label the chart shows), and it is
 * right when direction x return > 0. Every A measure is also reported at one bar of execution lag (the
 * return from the next bar's open), the program's standard for anything tradable.
 * - A1 Categories: for each of the seven categories (trend, momentum, volume, volatility, futures,
 *   sentiment, htf), on call bars, the share where the category's sign agrees with the call, and the
 *   balanced hit rate of the category's own sign as a direction.
 * - A2 Conditions: balanced hit rate and net per call after cost for each candidate condition C1 to C4
 *   (below) and its complement.
 * - A3 Paths: for every call, the maximum favourable and adverse excursion before the horizon (MFE, MAE,
 *   in percent and in ATR(14) multiples at the signal bar), and for k in {1, 1.5, 2} the share of calls
 *   that touch +k ATR before the horizon against the share that finish at or above +k ATR. The same
 *   measures for random entries matched on symbol and volatility tercile over the WHOLE develop span
 *   (never a same-month baseline: the snipe phase's C1 lesson), 20 draws per call, seed 13.
 * - A4 Signs for D1: per category, the sign of its pooled Spearman IC with the cell-horizon forward return
 *   at execution lag 1 over DEVELOP at that interval (0 counts as +1).
 * The diagnosis selects nothing except as Part B prescribes.
 *
 * PART B, CANDIDATES (all at 1h and at 4h; entries fill at the next bar's open; one open position per
 * symbol, a call while a position is open is ignored; standard fee profile, study slippage and
 * per-settlement funding; the harness's stop-first rule when one bar reaches both stop and target).
 * Direction:
 * - D0 control: enter on the v8 calls (long when score > 28, short when score < -28).
 * - D1 sign-corrected equal weights: score = mean over present categories of s_c x category score, with
 *   s_c from A4. Calls when |score| exceeds T, where T is the develop-period quantile of |score| that gives
 *   D1 the same call share as D0 at that interval (no return is used to set T).
 * - D2 one abstention rule on D0, the condition picked from:
 *   C1 the higher-timeframe category agrees in sign with the call;
 *   C2 realised volatility (raw.realizedVol20) is not in the symbol's top tercile of the develop period;
 *   C3 strong tiers only (|score| > 36);
 *   C4 the signal bar opens outside 00:00 to 08:00 UTC (not the Asia session).
 *   Pick: the highest develop net expectancy per trade with exit E1, among conditions keeping at least
 *   30% of D0's develop entries; a tie goes to the higher coverage.
 * Exits (each with the horizon as a time stop):
 * - E1 horizon: close after the horizon; protective stop 10 x ATR(14) from the entry price (the engine
 *   needs a stop; its hit count is reported and expected near zero).
 * - E2 take-profit: target +k x ATR(14), else the horizon; protective stop as E1.
 * - E3 target and stop: target +k x ATR(14) and stop -k x ATR(14), else the horizon.
 * - E4 score reversal: close when the direction's score falls back inside a quarter of its call threshold
 *   (7 for D0 and D2, T/4 for D1), else the horizon; protective stop as E1.
 * - k for E2 and E3 from {1, 1.5, 2}: the highest develop net expectancy (the harness's in-sample rule:
 *   at least the minimum trade count, earliest grid index on a tie).
 * All develop runs use the strategy harness in --fixed-eval mode over DEVELOP.
 *
 * TRIALS: per interval, D2's four conditions at E1 (4), then D0, D1 and the chosen D2 each at E1 (1), E2
 * (3), E3 (3) and E4 (1), less the D2 E1 run already counted: 4 + 24 - 1 = 27. Two intervals: 54. The
 * program ledger moves from 2,081 to 2,135. No other configuration is run.
 *
 * VERDICT (CONFIRM, each of the 24 frozen configurations run once: D0, D1, D2 x E1 to E4 x 1h, 4h, via
 * the harness's --fixed-eval --fix-params --eval-from 2025-01-01, warmup from the export):
 * a configuration PASSES only if every one of these holds:
 * 1. the harness's fixed gates, run with --windows 6: sample, expectancy, windows, symbols (share >= 0.7;
 *    stricter than the 6 of 10 said in conversation, recorded here as a tightening), timing (random-entry
 *    p < 0.05, the same exit profile on random entries), stress; plateau does not apply to one cell. The
 *    harness's own trials gate is inert for a one-cell run (its trial variance is zero), so it is
 *    replaced by the study's: deflated Sharpe probability >= 0.95 with N = 2,135 trials and the variance
 *    of per-trade Sharpe across this study's 54 develop runs (Bailey and Lopez de Prado 2014);
 * 2. Bonferroni over the 24: the pooled expectancy's moving-block bootstrap interval at level
 *    1 - 0.05 / 24 lies above zero (computed from the report's trades, 2,000 resamples, seed 13);
 * 3. both calendar parts positive: pooled expectancy > 0 over 2025 and over 2026-01-01 to 2026-10-09.
 * REPORTED, never gating: win rate, average win and loss, payoff; the balanced hit rate with the
 * Pesaran-Timmermann 2009 regression test (the realised up-indicator on the call's up-indicator, Newey-West
 * standard errors with lag equal to the horizon); the Anatolyev-Gerko excess-profitability statistic;
 * exit reasons; MFE capture (realised trade return over the trade's MFE).
 * A pass stops the study for the user with an agy second opinion; nothing is deployed and no scorer
 * change follows from this study alone.
 *
 * PREDICTIONS, stated before any number exists: no configuration passes at 1h. At 4h, D1 or an exit
 * variant comes closest and fails at least the trials or expectancy gate. Take-profit (E2) raises the win
 * rate over E1 without raising net expectancy beyond its interval, the optional-stopping argument showing
 * up in data. E3 is worse than E2 at both intervals (stops under reversal). In A3 the calls touch +k ATR
 * about twice as often as they finish there, close to the random entries' ratio.
 */

/*
 * IMPLEMENTATION NOTES (added 2026-10-11 before any data for this study existed; they fix readings the
 * locked text leaves open and loosen nothing):
 * N1 Lag-1 label: entry at the next bar's open, exit at the same close as the resolver's,
 *    r1 = close[i + h] / open[i + 1] - 1. A4's IC uses r1.
 * N2 A4 "pooled Spearman": one Spearman correlation over every (symbol, bar) pair of DEVELOP at that
 *    interval with both values finite (scripts/research/ic-stats.ts spearman).
 * N3 Calendar parts and windows group trades by EXIT time, as the harness's windows gate does.
 * N4 The harness's random-entry null reuses the strategy's REALISED hold, stop and target profile and its
 *    entry wrapper (src/lib/backtest/random-entry-benchmark.ts referenceProfile), not its exit rule; the
 *    timing gate is read with that meaning.
 * N5 D1's seven signs and threshold T, and C2's per-symbol volatility thresholds, come from Part A and are
 *    committed into DIRECTION_EXIT_FIT before any develop harness run; the develop picks (D2's condition and
 *    k) are committed into DIRECTION_EXIT_SELECTION before any confirm run. A commit hash for each is
 *    recorded in the RESULT block.
 * N6 Strategies read categories from StrategyContext.components (the scorer's own breakdown); a parity check
 *    (Task 4) requires the matrix's cat.* columns to equal those component scores on a DEVELOP sample
 *    before the diagnosis runs. "Present category" means a component with at least one signal.
 * N7 ATR(14) is Wilder's, scripts/research/families/legends-indicators.ts atr(candles, 14), in the rows
 *    builder and in the families alike.
 */

export interface DirectionExitFit {
  /** s_c per category, +1 or -1, in CATEGORY order trend, momentum, volume, volatility, futures, sentiment, htf. */
  signs: Record<'trend' | 'momentum' | 'volume' | 'volatility' | 'futures' | 'sentiment' | 'htf', 1 | -1>;
  /** D1's call threshold T on |D1 score|. */
  threshold: number;
  /** C2: the develop-period two-thirds quantile of realizedVol20 per symbol; null when the symbol has none. */
  volTopThreshold: Record<string, number | null>;
}

export const DIRECTION_EXIT_FIT: Record<'1h' | '4h', DirectionExitFit | null> = { '1h': null, '4h': null };

export interface DirectionExitSelection {
  d2Condition: 1 | 2 | 3 | 4;
  /** k for E2 and E3, per direction variant. */
  e2K: { d0: number; d1: number; d2: number };
  e3K: { d0: number; d1: number; d2: number };
}

export const DIRECTION_EXIT_SELECTION: Record<'1h' | '4h', DirectionExitSelection | null> = { '1h': null, '4h': null };

export const DIRECTION_EXIT_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'LINKUSDT',
] as const;

export const DIRECTION_EXIT_EXPORT = { start: '2021-10-01T00:00:00.000Z', end: '2026-10-09T23:59:59.999Z' } as const;
export const DIRECTION_EXIT_DEVELOP = { start: '2022-01-01T00:00:00.000Z', end: '2024-12-31T23:59:59.999Z' } as const;
export const DIRECTION_EXIT_CONFIRM = { start: '2025-01-01T00:00:00.000Z', end: '2026-10-09T23:59:59.999Z' } as const;
export const DIRECTION_EXIT_CONFIRM_PARTS = [
  { start: '2025-01-01T00:00:00.000Z', end: '2025-12-31T23:59:59.999Z' },
  { start: '2026-01-01T00:00:00.000Z', end: '2026-10-09T23:59:59.999Z' },
] as const;

export const DIRECTION_EXIT_CELLS = [
  { style: 'day_trading', interval: '1h', horizonBars: 24 },
  { style: 'swing_trading', interval: '4h', horizonBars: 30 },
] as const;

/** v8 cutoffs: calls above the buy cutoff, strong tiers above the strong cutoff. */
export const DIRECTION_EXIT_CUTOFFS = { buy: 28, strong: 36 } as const;
/** An exit level of a quarter of the call threshold (7 for v8's 28). */
export const DIRECTION_EXIT_EXIT_FRACTION = 0.25;
export const DIRECTION_EXIT_K_GRID = [1, 1.5, 2] as const;
export const DIRECTION_EXIT_ATR_PERIOD = 14;
export const DIRECTION_EXIT_PROTECTIVE_STOP_ATR = 10;
export const DIRECTION_EXIT_MIN_D2_COVERAGE = 0.3;
/** C4: the Asia session excluded, by the signal bar's open hour in UTC. */
export const DIRECTION_EXIT_ASIA_HOURS_UTC = { from: 0, to: 8 } as const;

export const DIRECTION_EXIT_CONFIGURATIONS = 24;
export const DIRECTION_EXIT_VERDICT_LEVEL = 1 - 0.05 / DIRECTION_EXIT_CONFIGURATIONS;
export const DIRECTION_EXIT_BOOTSTRAP = { resamples: 2_000, seed: 13 } as const;
export const DIRECTION_EXIT_RANDOM_DRAWS = 20;

export const DIRECTION_EXIT_LEDGER_BEFORE = 2_081;
export const DIRECTION_EXIT_TRIALS = 54;
export const DIRECTION_EXIT_LEDGER_AFTER = DIRECTION_EXIT_LEDGER_BEFORE + DIRECTION_EXIT_TRIALS;

/** The labelled year's hashed rows, the reproduction check's reference. */
export const DIRECTION_EXIT_REFERENCE_ROWS_SHA256 = '2addedf2b2ce8d2e22d04a3f58fb207867f09f9546b25c7ee87e89f7e0967d68';
export const DIRECTION_EXIT_REPRODUCTION = { minSameTierShare: 0.99, minScoreCorrelation: 0.999 } as const;
