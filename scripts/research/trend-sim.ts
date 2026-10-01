/**
 * LEGENDS PHASE: classic published trading rules, pre-registered, fixed parameters, one run each.
 *
 * Source of every rule and number: the session 23 reading round (sessions/2026-10-01-session-23-
 * reading-handover.md, gitignored), plan ~/.claude/plans/while-we-wait-for-drifting-whisper.md.
 *
 * STATUS: LOCKED. Approved by the user on 2026-10-02 after agy's adversarial review (recorded at the end).
 * Committed as the first commit on `research/legends`, before any simulation code. Nothing below may
 * change; a change means a new pre-registration and new trials.
 *
 * PHASE BUDGET
 *
 * - Hard cap: 11 trials for the whole phase (trend 4, patterns 4, scour 3), never extended. Benchmarks and sensitivities are not trials.
 * - Ledger: one line per trial in CHANGELOG and in the `strategy-research-program` memory, with the
 *   program-level running total (program trials before this phase: about 1,706 audited in session 19 plus
 *   the earlier phases; the exact figure is read from the ledger at lock time).
 * - Deflated Sharpe gate at the phase count (11), computed ONCE across all eleven trials in one unit: the
 *   annualised Sharpe of each rule's daily portfolio return series (harness rules: realised trade PnL booked
 *   on the exit day, sleeves equal-weighted across symbols), variance across the eleven. The program-count
 *   figure (about 1,717 trials) is reported beside it, not gated (user ruling 2026-10-01; agy dissents and
 *   would gate on it).
 * - Survivorship: the universe is ten 2026 survivors. Any pass is PROVISIONAL: it is not promoted, and
 *   nothing is built on it, until the same pre-registered rule passes on a survivorship-free universe under
 *   its own pre-registration. The lockbox read alone does not promote it.
 * - A family that fails is closed on THIS universe (ten Binance USDT-M symbols). Only a new universe
 *   (survivorship-free, materially broader) reopens it, under a new pre-registration.
 *
 * COMMON SETUP
 *
 * - Universe: BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK (USDT).
 * - Venue and costs: Binance USDT-M perpetual, standard fee profile (taker 0.05%, maker 0.02%), study
 *   slippage 2 bps per side at 1d and 4h, charged on every unit of turnover. Funding charged on held
 *   notional per 8h settlement crossed (PR #56 semantics) from the per-settlement series if PR #58 has
 *   merged, otherwise the snapshot series with its 24 to 48h staleness recorded.
 * - Samples:
 *   - PRIMARY: 2019-09-11 to 2026-06-30, spot 1d closes as the perp price proxy (the strategy harness's
 *     convention, review item M3). Each symbol enters at its perp listing (first funding row); spot history
 *     before that is lookback warmup only.
 *   - CONSISTENCY: perp closes 2022-01-01 to 2026-06-30. The primary statistic must have the same sign.
 *     The same rule is also run on spot closes over the identical 2022-2026 window, and the spot-minus-perp
 *     difference is reported as the measured error of the spot proxy (basis changes over the hold).
 *   - LOCKBOX: 2026-07-01 onward, read once, only for a rule that passes every gate.
 * - Execution: decisions at the 00:00 UTC daily close; fills at the next bar's open (which on a 24/7
 *   venue sits within ticks of the close) plus slippage, taker fee. Sensitivity (reported, not gated): one
 *   full bar of delay.
 * - Portfolio: each symbol is its own sleeve with equal capital (Zarattini's rotation convention), sleeves
 *   re-equalised at each month end, with fees and slippage charged on that turnover; a sleeve's exposure is the rule's weight; between the rule's decision
 *   days the sleeve holds quantity, so exposure drifts.
 * - Every trend rule T has an always-long twin T+ (the same rule with its signal forced to fully long:
 *   same volatility estimate, sizing, cap, schedule and band). T+ is the benchmark for T.
 *
 * TREND SET (4 TRIALS), EXPOSURE CONTAINER `TREND-SIM.TS`
 *
 * TF1, the 4-horizon weekly score (TradingLab's rendering of a Man AHL-style rule)
 *
 * - Score_t = sum over L in {7, 14, 30, 60} days of sign(close_t / close_{t-L} - 1); values -4..+4.
 * - Vol_t = mean absolute daily close-to-close return over 30 days x sqrt(365) (the video's definition).
 * - Weight = (Score/4) x (0.25 / Vol_t). Long-short, no cap.
 * - Decision day: every Monday 00:00 UTC close.
 *
 * TF2, AQR multi-horizon time-series momentum (Hurst, Ooi, Pedersen; Moskowitz, Ooi, Pedersen)
 *
 * - Signals: sign of the 30, 91 and 365-day return (1, 3, 12 months on a 365-day calendar).
 * - Vol_t = EWMA of squared daily returns, centre of mass 60 days (delta = 60/61), annualised by 365
 *   (deviation from the paper's 261: crypto trades every day).
 * - Weight = (1/3) x sum of signs x (0.40 / Vol_t). Long-short, no cap. The paper's 10% portfolio
 *   covariance scaling is NOT applied (needs a 3-year covariance; deviation recorded).
 * - Decision day: the first daily close of each calendar month.
 *
 * TF3, Paul Tudor Jones 200-day
 *
 * - Long (exposure 1.0, unscaled) when close_t > SMA200_t (simple mean of the last 200 daily closes
 *   including t), flat otherwise. Long-flat, the literal reading; the source states no short side.
 * - Decision: every daily close; trade only when the state changes.
 * - Twin TF3+ is plain buy-and-hold per sleeve.
 *
 * TF4, Zarattini, Pagani, Barbon 2025, Donchian ensemble, long-only
 *
 * - For n in {5, 10, 20, 30, 60, 90, 150, 250, 360}: Up = max of closes over n days including t, Down =
 *   min, Mid = (Up + Down)/2. Flat and close_t >= Up_t: enter long, stop = Mid_t. Long: if close_t <=
 *   stop: exit; else stop = max(stop, Mid_t).
 * - Weight per lookback when long = min(0.25 / sigma90_t, 2.0); sigma90 = standard deviation of 90 daily
 *   returns x sqrt(365) (estimator and factor not stated in the paper; chosen).
 * - Combo = mean of the nine weights; a lookback contributes 0 until it has n days of history.
 * - Rebalance daily: any lookback's entry or exit trades immediately to the new target; a volatility-only
 *   change trades only when |target - current| / current > 20% (relative; not stated in the paper; chosen).
 *
 * Trend gates (all must pass)
 *
 * 1. Sample: at least 5 years of portfolio days in PRIMARY.
 * 2. Expectancy: annualised Sharpe of daily portfolio returns, block-bootstrap 95% CI low > 0
 *    (circular blocks, length 60 days; sensitivity 20 and 120).
 * 3. Beats its twin: alpha from regressing T's daily returns on T+'s, block-bootstrap CI low > 0. The
 *    Sharpe difference T minus T+ is reported beside it.
 * 4. Timing: each symbol's SIGNAL or STATE path (the sign, score or in-position state before sizing) is
 *    circularly shifted against its returns (200 draws, shifts at least 365 days from zero), and the
 *    weights are recomputed with the volatility estimate left aligned to the true dates, so the null keeps
 *    the volatility-sizing benefit and tests timing only. One-sided p of alpha at least as large < 0.05.
 * 5. Symbols: alpha point estimate > 0 in all ten drop-one-symbol portfolios.
 * 6. Years: alpha positive in at least 60% of calendar years (2020 to 2025; 2019 and 2026 partial years
 *    reported, not counted).
 * 7. Stress: alpha point estimate > 0 at 1.5x fees and 2x slippage.
 * 8. Trials: deflated Sharpe probability >= 0.95 at N = 11, computed across all eleven trials in one unit
 *    (see Phase budget).
 * 9. Consistency: the CONSISTENCY sample's alpha point estimate > 0.
 * Reported, not gated: beta against the twin beside every alpha, long-leg and short-leg returns separately, max drawdown, turnover, funding paid,
 * leverage table (1x to the cap), share of PnL from the top 15% of trades or episodes (Brandt), longest
 * losing streak against its binomial expectation, one-bar-delay sensitivity.
 *
 * SHORT-TERM PATTERNS (4 TRIALS), STRATEGY HARNESS, 1D, FIXED-EVALUATION MODE
 *
 * Engine additions first (behind golden-regression and desk-parity proofs): stop-entry orders with an
 * optional OCO bracket and a timeout; next-open market orders. A fill bar that also reaches the stop is
 * booked as stopped after the fill. Harness gates: the existing eight, with the deflated Sharpe computed at
 * phase level (N = 11, across all eleven trials in one unit, see Phase budget) because the per-run gate is vacuous under one
 * cell (M5).
 *
 * P1, Turtle System 2, single unit (Faith)
 *
 * - N = (19 N_{t-1} + TR_t)/20, seeded by a 20-day mean of TR.
 * - Entry: OCO bracket for the next bar, buy stop at the prior 55-day high, sell stop at the prior 55-day
 *   low, re-placed every bar while flat. All breakouts taken.
 * - Stop: 2N from the fill. Exit: the opposite 20-day extreme as a stop, updated each bar from the prior
 *   bar's 20-day low (long) or high (short) through `manage` (one bar behind by construction), never
 *   loosened past the 2N stop's side.
 * - Deviation: no pyramiding (Brandt's single-entry practice, YT19). `closeTrade` must take `riskPercent`
 *   from the initial stop before this runs (exploration finding).
 *
 * P2, Crabel NR7 (secondary definition)
 *
 * - NR7 day: today's high-low range is the smallest of the last seven days.
 * - Entry: OCO bracket valid for the next bar only, buy stop at the NR7 high, sell stop at the NR7 low.
 * - Stop: the opposite extreme of the NR7 bar. Exit: the first close beyond the entry price in the trade's
 *   favour (first profitable close).
 *
 * P3, Raschke Holy Grail (Street Smarts; numeric definitions chosen and labelled)
 *
 * - Trend: ADX(14) > 30 at the setup bar and ADX(14) higher than 5 bars earlier; +DI > -DI for longs.
 * - Setup bar (long): low <= EMA20 while the prior close was above EMA20.
 * - Entry: buy stop at the setup bar's high, re-placed for up to 3 bars while the setup holds.
 * - Stop: the lowest low from the setup bar to the fill. Target: the highest high of the 20 bars before
 *   the setup bar.
 * - Deviation: the "after a winner, ADX must turn up above 30 again" clause is dropped (needs trade
 *   history, which the pure-strategy contract forbids).
 *
 * P4, Raschke Turtle Soup Plus One (Street Smarts)
 *
 * - Day one (long): low_t is below the lowest low of the prior 20 days, that prior 20-day low is at least
 *   3 sessions old, and close_t <= the prior 20-day low.
 * - Entry: buy stop at the prior 20-day low, valid day two only.
 * - Stop: day one's low at entry; from day three, the lower of day one's and day two's lows.
 * - Exit: close of the sixth bar after entry (the book's "partial profits within two to six bars, trail
 *   the rest", reduced to one rule; chosen).
 * - Turtle Soup itself is NOT tested: its entry needs the intrabar order of the new low and the reversal.
 *
 * SCOUR CANDIDATES (3 TRIALS; THE FOURTH SLOT IS LEFT UNUSED)
 *
 * Strategy harness, fixed-evaluation mode, next-open market fills unless stated, the same eight gates and
 * phase-level deflated Sharpe.
 *
 * C1, R30: Bollinger (42, 2.5) breakout, 1h, ten symbols
 *
 * - Long when the 1h close is at or above the upper band of a 42-bar, 2.5 standard-deviation Bollinger
 *   band; short when at or below the lower band. Fill at the next bar's open.
 * - Target 3%, stop 1.5% from the fill; time exit at the close of the 18th bar after entry (the source's
 *   1,075 minutes).
 * - When a bar reaches both the stop and the target, the stop counts (the engine already checks the stop
 *   first, the harness-wide convention). Reported beside it: the number of such bars and the target-first
 *   bound, so the effect of the ordering is visible. This is the point of the test: the source's +0.56% a trade gross is most likely a same-bar
 *   ordering artefact.
 * - Deviation: one position per symbol (the source allows three concurrent).
 * - Sample: spot 1h from 2021-10-14 to 2026-06-30 (1h history starts there). Slippage 3 bps at 1h.
 *
 * C2, X24: RSI(14) crosses above 70, 4h, ten symbols, long-only
 *
 * - Enter long at the next 4h open after RSI(14) closes above 70 having been at or below 70 on the prior
 *   bar; exit at the next open after RSI(14) closes below 70. No stop beyond a wide disaster stop
 *   (10 x ATR(14)), recorded as a deviation the harness requires.
 * - Sample: spot 4h from each symbol's perp listing to 2026-06-30, warmup from 2018.
 *
 * C3, LIT4: long-only basket timing (Han, Kang, Ryu), 1d
 *
 * - Basket: equal-weight index of the ten symbols available on the day.
 * - Signal: the basket's 28-day return ranks in the top third of its own trailing 365-day history of
 *   28-day returns (causal deviation: the paper ranks on the full sample).
 * - Hold the basket (equal-weight long of each available symbol) for 5 days from the next open; re-check
 *   at the end of each hold.
 * - Run in the trend container as an exposure path (sleeves equal-weighted), judged by the trend gates
 *   against its always-long twin (the basket held continuously).
 *
 * PREDICTIONS (WRITTEN BEFORE ANY RUN; THE CONTROLLER'S, INFORMED BY THE READING)
 *
 * Anchors: single-market trend Sharpe about 0.2 to 0.3 (YT48); about 1.4 effective symbols (session 22);
 * LIT1's per-coin 1.0 to 1.7 comes from a 2015-2025 sample weighted to 2017 and 2020-2021 and a hand-picked
 * universe.
 *
 * | rule | PRIMARY annualised Sharpe (trend) or per-trade expectancy (harness) | alpha against twin | leg that carries it | expected first failing gates |
 * | --- | --- | --- | --- | --- |
 * | TF1 | +0.3 to +0.7 | point estimate near zero, CI spans zero | long; short leg negative outside 2022 | 3 (twin), 8 (deflated) |
 * | TF2 | +0.3 to +0.6 | near zero, CI spans zero | long | 3, 8 |
 * | TF3 | +0.5 to +0.9 (drift) | small positive point estimate from avoiding 2022, CI spans zero | long only | 3, 8 |
 * | TF4 | +0.7 to +1.1, the best of the set | positive point estimate, CI may span zero | long only | 8; possibly 3 |
 * | C3 | +0.4 to +0.8 | near zero | long only | 3, 8 |
 * | P1 Turtle S2 | about 0% to +0.5% a trade, wide CI | n/a | long in 2020-2021, short in 2022 | expectancy CI, timing, trials |
 * | P2 NR7 | negative, about -0.2% a trade, win rate above 55% | n/a | none | expectancy |
 * | P3 Holy Grail | negative, few trades | n/a | none | sample or expectancy |
 * | P4 Turtle Soup Plus One | negative, few trades | n/a | none | expectancy |
 * | C1 Bollinger 1h | negative, about -0.10% to -0.20% a trade, win rate 33 to 38% (the source's +0.56% does not survive stop-first ordering and costs) | n/a | none | expectancy |
 * | C2 RSI above 70, 4h | about zero to negative | n/a | long only | expectancy CI, timing |
 *
 * Overall: no rule passes every gate. If one does, TF4 is the likeliest. A pass would be surprising enough
 * that the consistency sample, the one-bar-delay sensitivity and the lockbox read must all agree before it
 * is believed.
 *
 * POWER (STATED BEFORE THE RUN)
 *
 * PRIMARY is about 6.8 years: the standard error of an annualised Sharpe is about 0.38, so a CI excluding
 * zero needs about 0.75; the deflated bar at N = 11 is about 1.2; at the program's ~1,700 trials about 1.9
 * (reported only). The literature reports 1.0 to 1.7 on far broader or earlier samples, so a fail here can
 * be a power failure. It is still a fail on this universe.
 *
 * REVIEW RECORD (AGY, 2026-10-02, ADVERSARIAL SECOND OPINION)
 *
 * | # | agy finding | disposition |
 * | --- | --- | --- |
 * | 1 | BLOCKING: deflated Sharpe mixes daily portfolio Sharpes and per-trade Sharpes | ACCEPTED in substance (the draft already split by container, but the harness runs span 1h, 4h and 1d, so per-trade Sharpes were still incomparable): one deflated Sharpe across all eleven trials, every rule expressed as the annualised Sharpe of a daily return series |
 * | 2 | BLOCKING: N should be the program's ~1,717 trials, bar about 1.9 | NOT ADOPTED: the user ruled phase count plus a hard cap on 2026-10-01 after seeing both bars. The program-count figure is reported beside every result, and agy's dissent is recorded above |
 * | 3 | BLOCKING: survivorship (ten 2026 survivors) biases long trend rules toward passing | ACCEPTED as a pre-registered caveat and promotion rule: any pass is provisional until it repeats on a survivorship-free universe. Fixing the universe itself is a separate data project. The twin benchmark absorbs part of it, since T and T+ share the survivors |
 * | 4 | MAJOR: a circular shift of the exposure path breaks the trailing stop's conditionality, making the null too weak; use a random-entry null with the same trailing stop | PARTLY ACCEPTED: the shift now moves only the signal or state path and re-sizes with aligned volatility, so the null keeps the sizing benefit. The random-entry-same-exit null is NOT adopted: it tests entries only, and the legends locate trend value in exits (YT17, YT54) |
 * | 5 | MAJOR: spot closes ignore the perp basis | PARTLY ACCEPTED: funding is charged separately, so the residual error is the change in basis over a hold. It is now measured directly by running each rule on spot and perp over the identical 2022-2026 window |
 * | 6 | MAJOR: P1's "exploration finding" deviation is data snooping; TF4's 20% band is unpublished; TF4 should be long-short | REJECTED, misreadings: the P1 item is a bookkeeping fix (`closeTrade` taking risk from the initial stop), not a rule change; the 20% band is in the paper (Section 5.1 and four table captions); long-only is the paper's headline specification, long-short only an appendix |
 * | 7 | MAJOR: stop-first on a bar that hits both is unfairly pessimistic for C1; resolve with 1-minute data | PARTLY ACCEPTED: 1m history does not exist here (7-day TTL), so stop-first stays as the harness-wide convention, with the ambiguous-bar count and the target-first bound reported |
 * | 8 | MINOR: report beta with alpha | ACCEPTED |
 * | 9 | MINOR: month-end sleeve re-equalisation sells winners and its costs are unmodelled | PARTLY ACCEPTED: costs are now charged on that turnover; the re-equalisation stays because it is the source's convention for TF4 and keeps sleeves comparable |
 * | 10 | MINOR: the standard error arithmetic (1/sqrt(6.8) = 0.383) is correct | noted |
 *
 * IMPLEMENTATION NOTES, recorded at build time on 2026-10-02, before any run. None changes a rule.
 *
 * 1. Funding source by date. The per-settlement series (PR #58, collection `fundingsettlements`) starts
 *    2020-01-01 for BTCUSDT and ETHUSDT (the archive's first monthly file) and at each later symbol's own
 *    listing (BNB 2020-02-10, XRP 2020-01-06, ADA 2020-01-19, LINK 2020-01-17, DOGE 2020-07-10, DOT
 *    2020-08-20, SOL 2020-09-13, AVAX 2020-09-22). The PRIMARY sample enters BTC at 2019-09-11 as
 *    pre-registered. Where a symbol is held before its first archived settlement, funding is charged
 *    from the snapshot series, the pre-registered fallback, at each 8h boundary crossed. This affects
 *    about four months of BTC and about one of ETH, and the count of settlements charged this way is
 *    reported.
 * 2. Program-level trial ledger. Before this phase: 1,706 (the session 19 audited ledger, cumulative
 *    across phases) + 7 (funding carry, session 22) = 1,713. This phase adds 11, for 1,724. The
 *    program-count deflated Sharpe beside each result uses 1,724.
 */

export {};
