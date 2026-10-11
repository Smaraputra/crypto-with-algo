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
 * N8 The harness time stop is horizon - 1 bars after the next-open fill (timeStopBars = h - 1), so an E1 trade
 *    signalled at bar i spans open[i + 1] to close[i + h], exactly N1's lag-1 label (Ruling R9). E2 to E4 share
 *    that time stop.
 * N9 E4's score-reversal exit is decided at a bar's close and fills at the NEXT bar's open (Strategy.exitFill
 *    'next-open'): one bar of execution lag, the program's standard and the legends phase's practice (Ruling R10).
 * N10 VERDICT rule 2's interval is bootstrapCi's stationary block bootstrap (geometric block lengths) over the
 *    pooled trades in exit order, mean block = the cell horizon counted in trades (24 at 1h, 30 at 4h). 2,000
 *    resamples leave about 2 draws in each 0.104% tail. This is noted, not changed.
 * N11 The k picks require at least the harness's in-sample minimum trade count (MIN_IS_TRADES, 10, in
 *    scripts/research/strategy-harness.ts), the earliest k on a tie. D2's condition pick has no trade floor, only
 *    the 30% coverage floor, a tie to the higher coverage (Ruling R11).
 * N12 Data and provenance:
 *    - The develop rows (Part A) include a bar only if its whole horizon, out to the close of bar i + h, ends
 *      inside DEVELOP. Bars whose horizon crosses 2025-01-01 are dropped and counted (pastWindowEnd).
 *    - Every stage asserts the dataset manifest hash. The rows builder, the parity check and the verdict verify
 *      the dataset against its manifest, the diagnosis and the reproduction check assert the hash their rows
 *      recorded, check-fit asserts the hash the diagnosis recorded, and cond, select and verdict assert the
 *      hash each report recorded.
 *    - Every container records GIT_COMMIT, the clean commit the image was built from (the runbook checks the
 *      image label). select and verdict require one commit per run stage, and from develop-a to the verdict the
 *      code may differ only in this file's committed constants or in Markdown.
 *    - The develop-b and confirmation job lists are generated by the judge from the committed
 *      DIRECTION_EXIT_D2_CONDITION and DIRECTION_EXIT_SELECTION, never typed by hand. The D2 condition is
 *      committed on its own before develop-b, because develop-b's jobs depend on it.
 */

/*
 * RESULT, 2026-10-11 (each confirmation configuration run once, on the VPS).
 *
 * PROVENANCE. Export datasetHash 48ff79609080f11a48c45822f27cd609818b913b2d42455cddf4ea1ef4806e93 (100 files).
 * Develop rows sha256 5c7d6d4d1597b00e014475454376da426c4c0a62a4f123b1c2328a8640c6c354, reproduction rows
 * e5eecd6bf86232a791e87c6f6d8dd6046f60b3723a971c07e523f93992ef6c92. Commits: build, export, reproduction, parity,
 * rows and diagnosis at 63fc26d (it differs from the next commit's code only in the runbook and judge, which those
 * stages do not use); the fit ccf4504 (develop-a, cond); the D2 condition 8fda06d (develop-b, select); the
 * selection 1ae854e (confirm, verdict; judgeCommit 1ae854e). Every code check from develop-a to the verdict passed.
 * Reports in $HOME/dx-out on the VPS: diagnosis.json, cond.json, select.json, develop/ (54), confirm/ (24) and
 * confirm/verdict.json.
 *
 * REPRODUCTION (PASS): 1h 89,520 of 89,520 reference rows matched, same tier 1.0000, score r 0.999997; 4h 22,140
 * of 22,140, same tier 0.99991, r 0.999992. PARITY (PASS): ten symbols at 1h and 4h, 2024-11-01 to the DEVELOP
 * end, every category finite on every bar (10,248 values per symbol at 1h, 2,562 at 4h), largest difference 0.
 * ROWS: 1h 262,550 (240 dropped because their horizon spans 2023-03-24 13:00 UTC, an hour absent at the source on
 * every symbol, the Binance futures trading halt; 240 past the DEVELOP end); 4h 65,460 (0 dropped, 300 past).
 *
 * PART A (DEVELOP, lag 1; lag 0 differs by at most 0.0045 in any balanced hit rate, 0.0027 points in any net per
 * call and 0.0007 in any touch or finish share). Calls overlap here; the harness below holds one at a time.
 *   1h: 47,678 calls (21,671 buy, 26,007 sell), balanced hit 0.483, net per call +0.049%.
 *   4h:  4,241 calls ( 1,823 buy,  2,418 sell), balanced hit 0.476, net per call -0.376%.
 *   A1 category: share agreeing with the call / balanced hit of its own sign (n when below the calls)
 *               1h                      4h
 *   trend       0.999 / 0.483           0.997 / 0.475
 *   momentum    0.958 / 0.485           0.949 / 0.482
 *   volume      0.753 / 0.475           0.699 / 0.465
 *   volatility  0.348 / 0.563 (12,907)  0.555 / 0.544 (1,138)
 *   futures     0.536 / 0.498 (19,476)  0.981 / 0.490 (1,910)
 *   sentiment   0.540 / 0.482 (33,813)  0.529 / 0.473 (2,653)
 *   htf         0.990 / 0.484           0.936 / 0.481
 *   A2 condition: balanced hit holds / fails, net per call holds / fails, coverage
 *   1h C1 0.483 / 0.453, +0.054 / -0.428, 0.990    4h C1 0.477 / 0.422, -0.332 / -1.021, 0.936
 *   1h C2 0.494 / 0.462, +0.094 / -0.033, 0.651    4h C2 0.489 / 0.458, -0.438 / -0.215, 0.721
 *   1h C3 0.479 / 0.484, -0.019 / +0.064, 0.171    4h C3 0.460 / 0.477, -0.282 / -0.387, 0.109
 *   1h C4 0.487 / 0.476, +0.108 / -0.068, 0.666    4h C4 0.479 / 0.469, -0.484 / -0.157, 0.669
 *   A3 touch / finish at +k ATR, calls against matched random entries
 *   1h k 1   0.728 / 0.343 vs 0.736 / 0.355       4h k 1   0.744 / 0.344 vs 0.771 / 0.373
 *   1h k 1.5 0.606 / 0.288 vs 0.614 / 0.292       4h k 1.5 0.627 / 0.294 vs 0.662 / 0.320
 *   1h k 2   0.506 / 0.241 vs 0.505 / 0.239       4h k 2   0.525 / 0.249 vs 0.562 / 0.271
 *   Median MFE / MAE: 1h calls 2.15% / -2.00%, random 2.15% / -2.11%; 4h calls 4.32% / -4.85%, random 4.78% /
 *   -4.74%. The calls' paths are the random entries' paths: there is no excursion an exit rule could harvest.
 *   A4 signs (committed in ccf4504): 1h trend -, momentum +, volume -, volatility +, futures -, sentiment -, htf -,
 *   T 24.418; 4h trend +, momentum +, volume -, volatility -, futures -, sentiment -, htf -, T 23.280. D1's call
 *   share equals D0's: 0.1816 at 1h, 0.0648 at 4h.
 *
 * DEVELOP (54 runs, net expectancy % per trade, trades 127 to 23,786; these select, they are never judged)
 *   1h      E1      E2 k1   E2 k1.5 E2 k2   E3 k1   E3 k1.5 E3 k2   E4
 *   D0      -0.025  -0.104  -0.101  -0.077  -0.137  -0.112  -0.109  -0.057
 *   D1      -0.149  -0.145  -0.198  -0.222  -0.154  -0.193  -0.223  -0.213
 *   D2 C2   +0.094  -0.076  -0.054  -0.020  -0.118  -0.082  -0.049  +0.079
 *   D2 at E1: C1 -0.012, C2 +0.094 (picked), C3 -0.016, C4 -0.011.
 *   4h      E1      E2 k1   E2 k1.5 E2 k2   E3 k1   E3 k1.5 E3 k2   E4
 *   D0      +0.275  -0.262  -0.179  -0.203  -0.107  -0.007  -0.034  +0.030
 *   D1      +1.475  +0.107  +0.262  +0.366  -0.188  -0.006  +0.230  +1.416
 *   D2 C1   +0.232  -0.348  -0.166  -0.194  -0.139  -0.015  -0.011  +0.152
 *   D2 at E1: C1 +0.232 (picked), C2 +0.200, C3 +1.737 (coverage 0.17, below the 0.30 floor), C4 +0.107.
 *   Picked k (E2, E3): 1h D0 2, 2; D1 1, 1; D2 2, 2. 4h D0 1.5, 1.5; D1 2, 2; D2 1.5, 2. Variance of the 54
 *   per-trade Sharpes 0.002898455179130157. D1 at 4h is in-sample: its signs and T were fit on these years.
 *
 * CONFIRM (2025-01-01 to 2026-10-09). Every configuration fails expectancy, windows, symbols, Bonferroni and
 * the deflated Sharpe (N 2,135); "also" lists the other failures (t timing, s stress, and a negative calendar part).
 *   config      trades  exp %   bonf lo  2025    2026    DSR      win    payoff  PT t    AG      also
 *   1h D0 E1    3,614   -0.165  -0.576   -0.121  -0.219  4.4e-42  0.444  1.11    -3.67   -2.48   t s 2025 2026
 *   1h D0 E2k2  4,723   -0.162  -0.459   -0.099  -0.243  9.6e-66  0.573  0.65    5.37    -3.79   t s 2025 2026
 *   1h D0 E3k2  5,648   -0.154  -0.346   -0.130  -0.185  8.7e-81  0.487  0.91    -0.97   -4.94   t s 2025 2026
 *   1h D0 E4    3,857   -0.224  -0.540   -0.204  -0.248  3.4e-51  0.377  1.37    -8.31   -3.96   t s 2025 2026
 *   1h D1 E1    4,166   -0.162  -0.490   -0.084  -0.265  3.2e-49  0.502  0.89    0.14    -2.55   t s 2025 2026
 *   1h D1 E2k1  5,985   -0.173  -0.399   -0.146  -0.209  9.0e-101 0.749  0.27    24.67   -4.88   t s 2025 2026
 *   1h D1 E3k1  14,469  -0.144  -0.207   -0.154  -0.130  8.6e-279 0.473  0.86    -3.42   -13.62  s 2025 2026
 *   1h D1 E4    5,000   -0.214  -0.485   -0.207  -0.223  9.0e-84  0.616  0.50    9.41    -4.95   t s 2025 2026
 *   1h D2 E1    2,831   -0.112  -0.525   +0.059  -0.294  4.8e-31  0.451  1.11    -2.96   -1.66   t s 2026
 *   1h D2 E2k2  3,627   -0.106  -0.360   +0.027  -0.246  2.2e-45  0.593  0.62    6.34    -2.49   t s 2026
 *   1h D2 E3k2  4,270   -0.099  -0.261   -0.024  -0.176  2.9e-55  0.493  0.92    -0.50   -3.46   s 2025 2026
 *   1h D2 E4    3,009   -0.085  -0.364   +0.045  -0.221  1.7e-31  0.381  1.50    -7.47   -1.61   t s 2026
 *   4h D0 E1    411     +0.030  -1.532   +0.045  +0.013  1.1e-4   0.470  1.14    -1.39   -0.10   t s
 *   4h D0 E2k1.5 574    -0.132  -0.834   -0.121  -0.144  1.3e-7   0.657  0.49    7.06    -0.68   t s 2025 2026
 *   4h D0 E3k1.5 734    -0.117  -0.615   -0.115  -0.120  1.3e-9   0.499  0.93    -0.06   -0.92   t s 2025 2026
 *   4h D0 E4    439     +0.093  -1.143   +0.148  +0.029  1.5e-4   0.392  1.61    -4.28   +0.21   t
 *   4h D1 E1    481     -0.192  -1.900   -0.338  -0.008  2.2e-6   0.486  0.99    -0.67   -0.44   t s 2025 2026
 *   4h D1 E2k2  687     -0.279  -1.489   -0.569  +0.100  2.8e-10  0.613  0.57    3.84    -1.15   t s 2025
 *   4h D1 E3k2  822     -0.183  -0.811   -0.377  +0.081  5.5e-11  0.502  0.91    0.02    -1.16   t s 2025
 *   4h D1 E4    517     -0.347  -1.892   -0.569  -0.057  8.3e-8   0.397  1.32    -3.55   -0.78   t s 2025 2026
 *   4h D2 E1    367     +0.056  -1.335   +0.178  -0.102  2.9e-4   0.474  1.13    -1.45   -0.16   t s 2026
 *   4h D2 E2k1.5 515    -0.247  -0.968   -0.143  -0.374  2.3e-8   0.649  0.48    6.20    -1.32   t s 2025 2026
 *   4h D2 E3k2  527     -0.160  -0.975   -0.244  -0.062  1.5e-7   0.499  0.93    -0.15   -1.01   t s 2025 2026
 *   4h D2 E4    388     +0.169  -1.025   +0.220  +0.105  6.9e-4   0.397  1.62    -4.28   +0.30   t
 *   The balanced hit rate is within 0.013 of the win rate in every row. E1's 10 x ATR protective stop fired on
 *   1.4% to 4.4% of trades (D1 1h 184 of 4,166), not near zero: hourly crypto moves 10 ATR within a day often
 *   enough. mfeCaptureNet is negative in every row (a mean of ratios, so trades with a near-zero MFE set its size).
 *   PT t is positive under every take-profit (E2, 3.84 to 24.67) and for D1's E4 at 1h (9.41): an exit that closes
 *   winners early makes the trade's sign agree with the call more often by construction. AG stays negative there,
 *   and the win rate rises while the payoff falls (1h D1 E2: win 0.749, average win 1.02% against loss 3.73%).
 *   Spot check (Ruling R17): dx-d1 4h E1 re-run for BTCUSDT alone at 1ae854e reproduces the confirm report's
 *   BTCUSDT windows byte for byte (window 0: 6 trades, -0.6682%).
 *
 * NOTES. Barriers are stored as fractions of the signal bar's close and applied to the next-open fill, so a k x ATR
 * distance is k x ATR x (open / close), the legends phase's convention and negligible here. The Bonferroni bound
 * is N10's stationary block bootstrap with about 2 draws in each 0.104% tail; every bound is below zero by 0.2 to
 * 1.9 points, far beyond what that resolution could move. Fixed-eval runs compute indicators from a slice that
 * starts at the evaluation start minus the warm-up, not over the full series the parity check used (Ruling R4);
 * the reproduction check covers that path end to end.
 *
 * PREDICTIONS against outcomes. No pass at 1h: RIGHT (all twelve fail). At 4h D1 or an exit variant comes
 * closest and fails at least the trials or expectancy gate: RIGHT for the exit variants (D0 and D2 with E4 fail
 * the fewest gates and both fail expectancy and the deflated Sharpe), WRONG for D1, the worst direction at 4h
 * after leading develop (+1.475% develop, -0.192% confirm). E2 raises the win rate over E1 without raising net
 * expectancy beyond its interval: RIGHT in all six direction and interval pairs (win rate +0.13 to +0.25,
 * expectancy never higher than E1 by more than 0.01 points). E3 worse than E2 at both intervals: WRONG, E3's point
 * estimate beat E2's in all six pairs, all negative and inside each other's intervals. A3 calls touch +k ATR about
 * twice as often as they finish there, close to random entries: RIGHT (ratios 2.10 to 2.16 against 2.07 to 2.11).
 *
 * PHASE VERDICT. NO CONFIGURATION PASSES. Re-signing the composite's categories (D1), abstaining on one fixed
 * condition (D2), and closing on a take-profit, a target and stop, or a score reversal (E2 to E4) do not turn the
 * v8 calls into a positive net expectancy at 1h or 4h on 2025-01-01 to 2026-10-09. Closing winners sooner raises
 * the share of winning trades but shrinks each win by as much, because the calls carry no direction edge for an
 * exit to protect; "was up, ended wrong" is the reflection principle, the same on random entries. Direction and
 * exit improvement of the v8 composite at 1h and 4h is CLOSED. Program trial ledger: 2,135.
 */

export interface DirectionExitFit {
  /** s_c per category, +1 or -1, in CATEGORY order trend, momentum, volume, volatility, futures, sentiment, htf. */
  signs: Record<'trend' | 'momentum' | 'volume' | 'volatility' | 'futures' | 'sentiment' | 'htf', 1 | -1>;
  /** D1's call threshold T on |D1 score|. */
  threshold: number;
  /** C2: the develop-period two-thirds quantile of realizedVol20 per symbol; null when the symbol has none. */
  volTopThreshold: Record<string, number | null>;
}

export const DIRECTION_EXIT_FIT: Record<'1h' | '4h', DirectionExitFit | null> = {
  '1h': {
    signs: { trend: -1, momentum: 1, volume: -1, volatility: 1, futures: -1, sentiment: -1, htf: -1 },
    threshold: 24.417572349450225,
    volTopThreshold: {
      BTCUSDT: 0.005423659052141113,
      ETHUSDT: 0.0066432881083381655,
      BNBUSDT: 0.006090197492306986,
      SOLUSDT: 0.010293917449177471,
      XRPUSDT: 0.00745448585762286,
      ADAUSDT: 0.008460603861811793,
      DOGEUSDT: 0.009129179514776802,
      AVAXUSDT: 0.010301502856810536,
      DOTUSDT: 0.008527907575179587,
      LINKUSDT: 0.009146030842435962,
    },
  },
  '4h': {
    signs: { trend: 1, momentum: 1, volume: -1, volatility: -1, futures: -1, sentiment: -1, htf: -1 },
    threshold: 23.28010974666508,
    volTopThreshold: {
      BTCUSDT: 0.01117986653442798,
      ETHUSDT: 0.013649585620504757,
      BNBUSDT: 0.012474051191387434,
      SOLUSDT: 0.02124190062923456,
      XRPUSDT: 0.014870520840918259,
      ADAUSDT: 0.017061062255768266,
      DOGEUSDT: 0.018295507101869758,
      AVAXUSDT: 0.021269078235214216,
      DOTUSDT: 0.017019951298096695,
      LINKUSDT: 0.018851308225119504,
    },
  },
};

export interface DirectionExitSelection {
  d2Condition: 1 | 2 | 3 | 4;
  /** k for E2 and E3, per direction variant. */
  e2K: { d0: number; d1: number; d2: number };
  e3K: { d0: number; d1: number; d2: number };
}

export const DIRECTION_EXIT_SELECTION: Record<'1h' | '4h', DirectionExitSelection | null> = {
  '1h': { d2Condition: 2, e2K: { d0: 2, d1: 1, d2: 2 }, e3K: { d0: 2, d1: 1, d2: 2 } },
  '4h': { d2Condition: 1, e2K: { d0: 1.5, d1: 2, d2: 1.5 }, e3K: { d0: 1.5, d1: 2, d2: 2 } },
};

/**
 * D2's condition per interval (1 to 4 = C1 to C4), committed on its own between develop-a and develop-b, because
 * develop-b's jobs are generated from it and the k values do not exist yet (note N12). The selection committed
 * before confirm repeats it in `d2Condition`, and the judge's `jobs confirm` requires the two to agree.
 */
export const DIRECTION_EXIT_D2_CONDITION: Record<'1h' | '4h', 1 | 2 | 3 | 4 | null> = { '1h': 2, '4h': 1 };

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

/** The harness's --windows for every develop and confirm run (VERDICT rule 1). */
export const DIRECTION_EXIT_WINDOWS = 6;

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
