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
 *
 * IMPLEMENTATION NOTES 3 TO 14, recorded at build time on 2026-10-02 after the lock and before any run,
 * each a choice the locked text leaves open. None changes a rule.
 *
 * 3. Daily data. Spot 1d bars are complete for all ten symbols from their first bar to 2026-06-30. The
 *    perp series has no bars for 2022-02-26 to 2022-02-28 and 2022-04-01 to 2022-04-02 on SOLUSDT and
 *    XRPUSDT at every interval (a production data defect found at build). In CONSISTENCY those five days
 *    carry the last perp close forward (open = close = last close): no price is invented, a lookback of
 *    L bars stays L days, and the move across the gap is booked on the day data resumes. Each report
 *    records the filled days.
 * 4. CONSISTENCY warmup. Perp closes start 2022-01-01, so lookbacks there read spot closes before that
 *    date, PRIMARY's "spot history is warmup only" convention. Every symbol's first holding day is
 *    2022-01-01 in both the perp run and the matching spot run, so their difference is the proxy's
 *    error and nothing else.
 * 5. Listing and joining. A listing day is the open time of a symbol's first 1d snapshot carrying a
 *    funding rate: BTC 2019-09-11, ETH 2019-11-28, XRP 2020-01-07, LINK 2020-01-18, ADA 2020-01-20, BNB
 *    2020-02-11, DOGE 2020-07-11, DOT 2020-08-21, SOL 2020-09-14, AVAX 2020-09-23. A sleeve's first
 *    order is decided at the close before that day and fills at that day's open, whatever the rule's
 *    schedule (a weekly or monthly rule does not wait for its next decision day). A joining sleeve
 *    triggers the same re-equalisation as a month end.
 * 6. Missing history. TF4's text says a lookback contributes 0 until it has n days; TF1's and TF2's
 *    lookbacks follow the same convention, and a sleeve whose volatility estimate is not yet defined
 *    holds nothing. Only SOL, DOT and AVAX are affected (spot history starts 1 to 34 days before
 *    listing).
 * 7. TF2's EWMA is seeded with the mean square of the first 60 returns (no seed is stated).
 * 8. Decisions and rebalancing. TF2's "first daily close of each calendar month" is the 00:00 UTC close
 *    on the 1st (the end of the month's last bar), TF1's and the month-end re-equalisation's 00:00
 *    convention. TF1 and TF2 trade to the target (signal and size) at every decision close. TF3 and
 *    C3 trade only when the state changes, C3 re-checking only at the end of a hold. In TF4's band,
 *    "current" is the weight the sleeve holds at the decision close, drifted, or under the one-bar
 *    delay the target of an order not yet filled. A target is the signal times the size, 0 while the
 *    size is undefined.
 * 9. Re-equalisation returns each sleeve to its rule's weight (the target of its last rule order; "a
 *    sleeve's exposure is the rule's weight") on the new capital, by an order filled at the next open
 *    that pays fee and slippage on the traded notional. A rule order decided at the same close
 *    replaces it. CORRECTED after run 1: the note first read "keeps each sleeve's current weight",
 *    which was the defect described in the run record below.
 * 10. Funding is charged on the quantity times the day's open for each settlement in (open, next open];
 *    a settlement exactly at the fill's own 00:00 belongs to the day before (carry-sim.ts's convention).
 *    Positions are marked to market daily and nothing is closed at the end of a sample.
 * 11. C3's basket index chain-links the equal-weighted daily return of every symbol with closes on both
 *    the day and the day before (spot in PRIMARY, spliced in CONSISTENCY), from 2018-10-31. Its state is
 *    shared by every sleeve.
 * 12. Statistics. Bootstrap CIs: 2,000 circular-block draws, seed 42, percentile 95%. Timing null: 200
 *    draws, seed 7, each symbol's shift uniform on [365, len - 365] bars of its decision span, p = (1 +
 *    draws with alpha at or above the observed) / 201. Alpha is the intercept, times 365, of OLS of T's
 *    daily returns on T+'s over the days any sleeve holds capital. Gate 5 removes one sleeve (C3's
 *    signal still reads the full basket). Gate 6 regresses within each calendar year. Sharpe is
 *    annualised by sqrt(365).
 * 13. The one-bar delay fills every order one bar later at that bar's open.
 * 14. Gate 8 is not decided in a rule's report: it is computed once across all eleven trials, after the
 *    harness rules have run.
 *
 * IMPLEMENTATION NOTES 15 TO 23, the six harness rules, recorded at build time on 2026-10-02 after the
 * trend set's result and before any harness run, each a choice the locked text leaves open. None changes
 * a rule.
 *
 * 15. Fixed evaluation (strategy-harness.ts --fixed-eval, strategy-walk-forward.ts runFixedEvaluation):
 *    one continuous run per symbol from the later of its perp listing (--start-at-listing) and the
 *    harness style's indicator warmup to 2026-06-30, no selection; trades fall into six equal calendar
 *    spans by exit time, used only by the windows gate. The 1d style's warmup is 400 bars, so a symbol
 *    with spot history from 2018 starts on 2019-12-05 (BTCUSDT) or at its later listing, and SOL, DOT and
 *    AVAX (spot history from 2020) a year after their listing.
 * 16. Engine (src/lib/backtest, behind the unchanged golden-regression, engine-parity and paper-desk
 *    parity tests): a stop entry fills at its trigger, or at the open when the bar opened through it,
 *    plus slippage and taker fee; an untriggered one-bar order expires at that bar's close, where the
 *    rule decides again (P1's "re-placed every bar", P3's "up to 3 bars"); an OCO bracket whose legs
 *    both trigger in one bar fills the leg nearer the open (counted per symbol). A next-open fill is at
 *    the next open plus slippage. After either fill the bar's range is checked against the stop first
 *    and its close against the rule's exit. Exits at a stop keep the engine's convention of the stop
 *    price (a gap through a stop is not modelled). Risk is measured from the initial stop.
 * 17. Funding for the harness rules: the per-settlement series with the 4h-snapshot fallback (note 1),
 *    per bar (previous close, close]; a next-open or stop fill pays its whole fill bar (conservative for a
 *    stop filled inside the bar), and a next-open exit pays nothing on the bar it exits at.
 * 18. The timing null enters at the next open with the reference's stop and target distances measured
 *    from the fill, for P1 to P4 as well (a breakout trigger has no meaning for a random entry).
 * 19. CONSISTENCY for the harness rules (COMMON SETUP: the primary statistic must have the same sign): a
 *    second fixed-evaluation run per rule with --price perp --eval-from 2022-01-01, perp klines from
 *    2022-01-01 and spot bars before as warmup (the five missing SOLUSDT and XRPUSDT days of this export
 *    carried forward, note 3); the sign of its pooled expectancy must equal PRIMARY's.
 * 20. Of the harness's eight gates, `trials` is vacuous with one cell (M5) and is replaced by gate 8;
 *    the other seven gate. Gate 8 (legends-dsr.ts): each trial's daily series is, for a harness rule,
 *    its realised trade returns (pnlPercent / 100) booked on the exit day, each symbol a sleeve, the
 *    sleeves equal-weighted over the symbols evaluating that day; the per-period Sharpes of all eleven
 *    give the variance; a trial passes at a deflated Sharpe probability of 0.95.
 * 21. Rule readings (families/legends.ts header): P1's 55-day channel at a close spans bars t-54..t and
 *    its 2N stop is measured from the fill after slippage; P2's NR7 is a range at most each of the prior
 *    six; P3's setup is the most recent qualifying bar of the last three while ADX > 30 and the DI order
 *    still hold at the decision close, its stop the extreme from the setup bar through the decision
 *    bar, a target on the wrong side of the trigger cancels it, and a later bar reaching the trigger
 *    spends it (re-placement is for an unfilled order; found by the pre-run review); P4's prior extreme is its most
 *    recent bar; short legs mirror long ones.
 * 22. Time exits count full bars after the entry moment: C1 enters at an open, so "the close of the
 *    18th bar after entry" (the source's 1,075 minutes) is the fill bar + 17; P4 enters inside day two,
 *    so "the sixth bar after entry" is day two + 6.
 * 23. C1's same-bar ordering is reported per symbol beside its stop-first result: the count of stop
 *    exits on bars that also reached the target, and the expectancy with those bars booked as targets.
 *
 * RUN RECORD
 *
 * Run 1, 2026-10-02, image from `dc70041`, export `d84b32d9fb31`: DISCARDED for a container defect.
 * Re-equalisation restored each sleeve's DRIFTED weight instead of the rule's weight, so funding and
 * costs already paid, a fixed cash debt against the held quantity, compounded into leverage month after
 * month: the buy-and-hold twin of TF3 and C3 reached a gross exposure of 6.5 on 2022-05-11, ran at 117%
 * annualised volatility and drew down 98.5%, where an independent pandas re-computation of the same
 * twin (sharing no code with this file) gives 81% and 81.4%. The defect was found by that check before
 * anything was recorded; it inflated the twin's losses and so inflated TF3's and C3's alphas. Rules
 * that rebalance to target at each decision (TF1, TF2) or within a band (TF4) were affected less. For
 * the record, run 1 read: TF1 Sharpe 0.93, alpha +20.8%, all gates but 8 passed; TF2 0.22, +1.8%,
 * failed; TF3 0.82, +24.6%, failed; TF4 1.31, +7.0%, all but 8 passed; C3 1.36, +51.1%, all but 8
 * passed. Fixed with a regression test (`trend-sim.test.ts`, "re-equalisation restores the rule
 * weight"); every rule re-run once.
 *
 * RESULT, 2026-10-02 (run 2, the run of record). Export `d84b32d9fb31`, image from `9b12f61`, lockbox
 * applied, PRIMARY 2019-09-11 to 2026-06-30 (2,485 days), reports `trend-{tf1,tf2,tf3,tf4,c3}.json`.
 * Checks: TF4 reproduced digit for digit on a second machine from the hash-verified export; BTCUSDT
 * 2024-03 funding reconciled (93 settlements, the archive's sum exactly); an independent pandas
 * re-implementation sharing no code reads TF1 0.80 / +18.9%, TF4 1.28 / +6.8%, C3 1.32 / +39.8%
 * (Sharpe / alpha), against 0.91 / +20.4%, 1.31 / +7.1%, 1.36 / +40.3% here.
 *
 *   rule  Sharpe  95% CI         alpha    95% CI            beta   timing p  failed gates   verdict
 *   TF1   0.91    [0.20, 1.59]   +20.4%   [+4.7%, +34.5%]   -0.07  0.005     none           gate 8 pending
 *   TF2   0.23    [-0.61, 0.98]  +2.0%    [-17.0%, +19.0%]  0.13   0.224     2, 3, 4, 5, 6  FAIL
 *   TF3   0.83    [-0.10, 1.68]  +7.9%    [-17.0%, +30.3%]  0.54   0.100     2, 3, 4, 6     FAIL
 *   TF4   1.31    [0.24, 2.29]   +7.1%    [+1.8%, +12.0%]   0.30   0.005     none           gate 8 pending
 *   C3    1.36    [0.47, 2.15]   +40.3%   [+10.6%, +66.2%]  0.37   0.005     none           gate 8 pending
 *
 *   Reported, not gated. One-bar delay (Sharpe / alpha): TF1 0.65 / +15.6%, TF4 1.23 / +6.4%, C3 1.33 /
 *   +38.6%. CONSISTENCY, perp 2022-2026 (alpha, Sharpe): TF1 +7.8%, 0.33; TF4 +4.5%, 0.73; C3 +27.1%,
 *   0.72; spot minus perp alpha within 0.31% for every rule, so the spot proxy's error is small. Twin
 *   Sharpes: TF1+ 0.76, TF2+ 0.78, TF4+ 0.71, TF3+ and C3+ (buy and hold) 0.86. Max drawdown TF1 34.1%,
 *   TF4 10.9%, C3 37.5%, against 49.2%, 35.6% and 80.9% for their twins. The long legs carry every
 *   rule; TF1's short leg earns +0.78% a year, TF2's loses 8.95%. Concentration: C3's alpha is +138%
 *   in 2021 and its losing streak of episodes is 25 against 9.8 expected; TF4's is 64 against 33 (its
 *   losses cluster). Average gross exposure: TF1 0.31, TF4 0.10, C3 0.37.
 *
 *   Predictions: right for TF2 and TF3 (fail, alpha CI spanning zero) and that TF4 is the best of the
 *   four TF rules; wrong that TF4's alpha CI would span zero, and wrong for TF1 and C3, both predicted
 *   to fail gate 3 and both clearing it. The Sharpe predictions were low for TF1 (0.3 to 0.7, read
 *   0.91), TF4 (0.7 to 1.1, read 1.31) and C3 (0.4 to 0.8, read 1.36).
 *
 *   STATUS. TF1, TF4 and C3 pass every gate a single report can decide. Gate 8, the deflated Sharpe
 *   at N = 11 across all eleven trials, needs the six harness trials (P1 to P4, C1, C2) and is NOT
 *   computed on these five: that would be a peek at a figure the pre-registration computes once. Until
 *   it is, no rule has passed and the lockbox stays closed. By the pre-registration any pass is
 *   PROVISIONAL until the same rule passes on a survivorship-free universe, and the universe here is ten
 *   2026 survivors.
 *
 * RESULT, HARNESS RULES AND GATE 8, 2026-10-02. Export `d84b32d9fb31` (the same export), image from
 * `be688f2`, fixed evaluation from each symbol's listing or warmup end (BTCUSDT and ETHUSDT from
 * 2019-12-04, SOL, DOT and AVAX from 2021-09 to 2021-10) to 2026-06-30, settlement funding, reports
 * `strategy-{p1..p4,c1,c2}.json` and the perp CONSISTENCY runs `strategy-*-perp.json` (2022-01-01 on).
 * P2 reproduced digit for digit on a second machine from the hash-verified export. Expectancy is per
 * trade after costs, CI the bootstrap 95% interval, p the random-entry timing p.
 *
 *   rule  n       expectancy  95% CI              p      symbols  failed gates (of seven; trials is gate 8)   perp 2022-26
 *   P1    456     +24.93%     [-0.83%, +76.47%]   0.010  9/10     expectancy, windows (0.55)                  +0.94%
 *   P2    2,736   +0.195%     [-0.028%, +0.424%]  0.010  8/10     expectancy                                  +0.026%
 *   P3    87      +2.43%      [-0.38%, +5.81%]    0.010  7/10     sample, expectancy, windows                 +0.15%
 *   P4    433     -1.40%      [-2.10%, -0.75%]    1.000  0/10     expectancy, windows, symbols, timing, stress -1.30%
 *   C1    10,677  -0.088%     [-0.156%, -0.025%]  0.005  2/10     expectancy, windows, symbols, stress        -0.074%
 *   C2    2,224   +0.545%     [+0.109%, +1.119%]  0.005  8/10     windows (0.533 against 0.6)                 +0.11%
 *
 *   Reported: C1's same-bar ordering, 134 stop exits on bars that also reached the target; booked as
 *   targets the expectancy is still -0.031%, so the source's +0.56% a trade survives neither ordering.
 *   P2's bracket triggered on both sides on 653 of its 2,736 fill bars (24%), each booked as the
 *   nearer leg then stopped on the same bar (note 16). P1's mean is dominated by a few multi-month
 *   trends (win rate 34%). The perp runs carried 10 1d, 240 1h and 97 4h bars forward (the five known
 *   days, plus about six spot 4h maintenance gaps per symbol inside the pre-2022 warmup).
 *
 *   GATE 8 (legends-dsr.ts, report legends-gate8.json): the variance of the eleven per-period Sharpes
 *   puts the expected maximum annual Sharpe at 1.52 at N = 11 (3.19 at the program's 1,724). Deflated
 *   Sharpe probabilities: C3 0.330 (Sharpe 1.36), TF4 0.294 (1.31), TF1 0.054 (0.91), TF3 0.031,
 *   P2 0.019, C2 0.007 (0.95), P3 0.003, the rest 0.000; every one is 0.000 at the program count.
 *   EVERY TRIAL FAILS GATE 8. The pre-registration's "about 1.2" was an estimate; the spread of the
 *   eleven, widened by P4's and C1's strongly negative Sharpes, set the bar higher.
 *
 *   Predictions: right that no rule passes and that TF4 would be the best trend rule; right for P3
 *   (sample), P4 and C1 (negative, C1 win rate 36%); right on P2's win rate above 55% (57%) but wrong
 *   on its sign (+0.19%, CI spanning zero); wrong for C2 (+0.55% with a CI above zero and timing at
 *   0.005, failing only the windows gate); P1's timing gate passed where a failure was predicted.
 *
 * PHASE VERDICT. NO RULE PASSES. All eleven trials fail; the lockbox stays closed. By the
 * pre-registration every family is CLOSED ON THIS UNIVERSE (ten Binance USDT-M survivors); only a
 * survivorship-free, materially broader universe reopens one, under a new pre-registration. Program
 * trial ledger: 1,724. What the phase leaves standing, as readings and not results: slow trend rules
 * (TF4, C3, TF1) and C2's 4h continuation carry real timing (p 0.005 against shifted or random entries)
 * and positive alpha or expectancy here, but none clears the multiple-testing bar of its own phase,
 * and the universe they were measured on is the one most favourable to long trend rules.
 */
import { BINANCE_FUTURES_TAKER_FEE, STUDY_SLIPPAGE_BPS } from '@/lib/backtest/cost-model';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { DAY_MS, YEAR_DAYS, type RulePaths } from './trend-signals';

/** One settled funding rate at boundary `t`. Positive means longs pay shorts. */
export interface Settlement {
  t: number;
  rate: number;
}

/** One symbol's daily bars, warmup included, consecutive UTC days. */
export interface TrendSymbolInput {
  symbol: string;
  /** Bar OPEN times, ascending, one per UTC day with no gap. The bar closes at t + 1 day. */
  t: number[];
  /** Fill prices. */
  open: number[];
  /** Signal and mark prices. */
  close: number[];
  /** UTC day of the perp listing (the first funding row): the first day the sleeve may hold. */
  listingDay: number;
  /** Settlements sorted by t: the archive's, plus the snapshot fallback before its first. */
  settlements: Settlement[];
  /**
   * Broad mode only (broad-trend.ts): 1 on a carried day, a missing day inside a
   * gap of 1 to 7 days that did not end the contract (open = close = the last real
   * close). Nothing fills, no funding is charged and the mark does not move then.
   */
  carried?: Uint8Array;
  /** Broad mode only: the universe membership, ranking close to ranking close. */
  membership?: MembershipSpan[];
  /**
   * Broad mode only: the contract's last traded day when it ends before
   * 2026-06-30 (a delisting), else null. It must be the input's last bar.
   */
  endDay?: number | null;
}

/** Broad mode: a member for days from <= d < to (UTC day starts, both on a 1st), ranked `rank` at `from`. */
export interface MembershipSpan {
  from: number;
  to: number;
  rank: number;
}

/** Cost per unit of traded notional, both fractions. */
export interface TrendCost {
  fee: number;
  slippage: number;
}

/** Standard USDT-M taker plus the 1d study slippage, charged on every unit of turnover. */
export const TREND_COST: TrendCost = {
  fee: BINANCE_FUTURES_TAKER_FEE,
  slippage: (STUDY_SLIPPAGE_BPS['1d'] ?? 0) / 10_000,
};

/** Gate 7's stress: 1.5x fees and 2x slippage. */
export function stressCost(cost: TrendCost): TrendCost {
  return { fee: cost.fee * 1.5, slippage: cost.slippage * 2 };
}

/**
 * Broad phase costs beyond the taker fee (broad-trend.ts header, COSTS), all
 * fractions of traded notional except the haircut, a fraction of the close.
 */
export interface BroadCost {
  /** Slippage per side by the member's rank at the last ranking close. */
  slippageForRank: (rank: number) => number;
  /** Slippage of a leaving member's exit order. */
  leaveSlippage: number;
  /** A delisting exit fills at the last close moved this much against the position. */
  delistHaircut: number;
}

/** Broad gate 7's stress on the broad costs: 2x every slippage tier, 2x the leave slippage, 2x the haircut. */
export function stressBroad(broad: BroadCost): BroadCost {
  return {
    slippageForRank: (rank) => 2 * broad.slippageForRank(rank),
    leaveSlippage: 2 * broad.leaveSlippage,
    delistHaircut: 2 * broad.delistHaircut,
  };
}

export interface SimOptions {
  /** First UTC day a sleeve may hold; a symbol listed later starts at its listing day. */
  from: number;
  /** End, exclusive: the last simulated day is the last one before `to`. */
  to: number;
  cost: TrendCost;
  /** Bars between the deciding close and the fill: 0 fills at the next open (the rule), 1 is the sensitivity. */
  delay: number;
  /**
   * Broad mode (broad-trend.ts header, PORTFOLIO and COSTS): membership drives
   * joins, leaves and re-equalisation, with delistings, carried days and a cash
   * account. Absent: the legends container, unchanged. In broad mode
   * `cost.slippage` is not read; slippage comes from these tiers.
   */
  broad?: BroadCost;
  /**
   * Broad mode only, opt-in (broad-flow.ts header, PORTFOLIO; implementation note
   * F7): at every close for which this returns true, after any ranking-close split
   * at that close, the capital of the live sleeves (active and not leaving) is split
   * equally across those whose paths are `defined` at the deciding bar (every live
   * sleeve when the paths carry no mask); the others get 0. Cash stays cash until the
   * next ranking close. Each sleeve holding a position or a target gets an order
   * back to its rule's target on its new capital, which a decision at the same close
   * replaces. Absent: re-equalisation happens at ranking closes only, unchanged.
   */
  reequaliseAt?: (closeAt: number) => boolean;
}

export interface TrendRun {
  /** UTC day starts, `from` to `to`. */
  days: number[];
  /** Net portfolio return per day, on the equity at the previous close. */
  returns: number[];
  /** Price and funding PnL of long holdings, on the same equity. */
  longLeg: number[];
  shortLeg: number[];
  /** Fees and slippage (positive, already subtracted from `returns`). */
  cost: number[];
  /** Funding PnL (negative when paid, already in `returns` and the legs). */
  funding: number[];
  /** Traded notional over the equity at the previous close. */
  turnover: number[];
  /** Sum of |notional| over equity at the close. */
  gross: number[];
  /** Each sleeve's PnL over its own capital at the previous close; NaN before it starts. */
  sleeveReturns: Record<string, number[]>;
  /** Each symbol's PnL over the portfolio equity at the previous close. */
  contributions: Record<string, number[]>;
  /** Summed contributions of each episode (a run of one position sign), every sleeve. */
  episodes: number[];
  /** First holding day of each sleeve. */
  startDay: Record<string, number>;
  /** Broad mode only. */
  broad?: BroadRunDetail;
}

/** A delisting exit (broad mode), in units of the starting equity. */
export interface DelistingExit {
  symbol: string;
  /** The contract's last traded day; the exit is at its close. */
  day: number;
  qty: number;
  close: number;
  exitPrice: number;
  /** |qty| x close x haircut. */
  haircut: number;
  /** Taker fee on |qty| x exitPrice. */
  fee: number;
}

/** A leaving member's exit (broad mode), in units of the starting equity. */
export interface LeaveExit {
  symbol: string;
  /** The ranking close it left at. */
  close: number;
  /** The day its exit order filled. */
  day: number;
  traded: number;
  cost: number;
  /** The sleeve's capital moved to cash after the fill (overnight PnL minus cost; may be negative). */
  residual: number;
}

export interface BroadRunDetail {
  /** Cash over equity at each day's close. */
  cash: number[];
  /** Members holding a live sleeve (active, not leaving) at each day's close. */
  members: number[];
  delistings: DelistingExit[];
  leaves: LeaveExit[];
  /** Net notional (long minus short, qty x mark) over equity at each day's close. */
  net: number[];
  /**
   * Long and short notional held just after each day's fills, qty x the day's open,
   * over the equity at the previous close (a sleeve on a carried day at its carried
   * open). A book sized at one close is dollar-neutral here when opens equal the
   * previous closes.
   */
  openLong: number[];
  openShort: number[];
}

interface SleeveState {
  input: TrendSymbolInput;
  paths: RulePaths;
  startDay: number;
  active: boolean;
  capital: number;
  qty: number;
  /** Last price the quantity was marked at. */
  mark: number;
  /** Signal at the last rule order; NaN before the first. */
  lastSignal: number;
  /** Target weight of the last rule order: the weight re-equalisation restores. */
  ruleTarget: number;
  /** Target weight by fill day. */
  pending: Map<number, number>;
  settlementPtr: number;
  episodeSign: number;
  episodeSum: number;
}

/** UTC day start of a moment. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Index of the bar opening at `day`, or -1 outside the input. */
export function barIndex(input: TrendSymbolInput, day: number): number {
  if (input.t.length === 0) return -1;
  const i = Math.round((day - input.t[0]) / DAY_MS);
  return i >= 0 && i < input.t.length && input.t[i] === day ? i : -1;
}

/** Throws unless the input's bars are consecutive UTC days, so a lookback of L bars is L days. */
export function assertDaily(input: TrendSymbolInput): void {
  for (let i = 0; i < input.t.length; i++) {
    if (input.t[i] % DAY_MS !== 0) throw new Error(`${input.symbol}: bar ${i} is not at 00:00 UTC`);
    if (i > 0 && input.t[i] - input.t[i - 1] !== DAY_MS) {
      throw new Error(`${input.symbol}: gap between ${new Date(input.t[i - 1]).toISOString()} and ${new Date(input.t[i]).toISOString()}`);
    }
  }
}

/** First holding day of a sleeve in a sample. */
export function sleeveStart(input: TrendSymbolInput, from: number): number {
  return Math.max(from, utcDay(input.listingDay));
}

/**
 * The sleeve portfolio pre-registered in the header. Every sleeve holds its
 * rule's weight of its own capital; between orders it holds QUANTITY, so its
 * exposure drifts. Capital is re-equalised across the live sleeves at every
 * month end and whenever a sleeve joins, each sleeve returning to its RULE's
 * weight (the target of its last rule order, "a sleeve's exposure is the rule's
 * weight") through an order that pays the usual costs. A rule order placed at
 * the same close replaces that order. Restoring the drifted weight instead let
 * paid funding and costs, a fixed cash debt against a held position, compound
 * into leverage month after month (defect found 2026-10-02, see the run record).
 *
 * Per day d (bar open d, close d + 1 day), for each live sleeve:
 *   gap     qty x (open - last mark)               the overnight quantity, up to the fill
 *   fill    a pending order trades to target x equity at the open / open, paying
 *           |traded notional| x (fee + slippage)
 *   funding -qty x open x rate for every settlement in (d, d + 1 day]
 *   mark    qty x (close - open)
 * A settlement exactly at the open belongs to the day before, as in carry-sim.ts.
 * Decisions read the close of day d and fill at the open of day d + 1 + delay.
 *
 * With `opts.broad` set, the broad phase's membership container runs instead
 * (runBroadTrend, below); without it, inputs carrying broad-only fields throw.
 */
export function runTrend(
  inputs: TrendSymbolInput[],
  paths: Record<string, RulePaths>,
  opts: SimOptions
): TrendRun {
  if (opts.broad) return runBroadTrend(inputs, paths, opts, opts.broad);
  if (opts.reequaliseAt) throw new Error('reequaliseAt needs SimOptions.broad');
  for (const input of inputs) assertLegendsInput(input);
  const { cost, delay } = opts;
  const perUnitCost = cost.fee + cost.slippage;
  const sleeves: SleeveState[] = inputs.map((input) => ({
    input,
    paths: paths[input.symbol],
    startDay: sleeveStart(input, opts.from),
    active: false,
    capital: 0,
    qty: 0,
    mark: Number.NaN,
    lastSignal: Number.NaN,
    ruleTarget: 0,
    pending: new Map(),
    settlementPtr: 0,
    episodeSign: 0,
    episodeSum: 0,
  }));
  for (const s of sleeves) {
    if (!s.paths) throw new Error(`No rule paths for ${s.input.symbol}`);
    assertDaily(s.input);
  }

  const days: number[] = [];
  for (let d = opts.from; d < opts.to; d += DAY_MS) days.push(d);
  const n = days.length;
  const run: TrendRun = {
    days,
    returns: new Array(n).fill(0),
    longLeg: new Array(n).fill(0),
    shortLeg: new Array(n).fill(0),
    cost: new Array(n).fill(0),
    funding: new Array(n).fill(0),
    turnover: new Array(n).fill(0),
    gross: new Array(n).fill(0),
    sleeveReturns: Object.fromEntries(inputs.map((i) => [i.symbol, new Array(n).fill(Number.NaN)])),
    contributions: Object.fromEntries(inputs.map((i) => [i.symbol, new Array(n).fill(0)])),
    episodes: [],
    startDay: Object.fromEntries(sleeves.map((s) => [s.input.symbol, s.startDay])),
  };

  let equity = 1;

  // k = -1 is the close before the first day, where the first sleeves join.
  for (let k = -1; k < n; k++) {
    const d = k === -1 ? opts.from - DAY_MS : days[k];

    if (k >= 0) {
      const prevEquity = equity;
      let dayPnl = 0;
      for (const s of sleeves) {
        if (!s.active) continue;
        const i = barIndex(s.input, d);
        if (i === -1) throw new Error(`${s.input.symbol}: no bar on ${new Date(d).toISOString()}`);
        const open = s.input.open[i];
        const close = s.input.close[i];
        const preQty = s.qty;
        let pnl = 0;
        let longPnl = 0;
        let shortPnl = 0;
        let fundingPnl = 0;
        let costPaid = 0;
        let traded = 0;

        const gap = preQty === 0 ? 0 : preQty * (open - s.mark);
        pnl += gap;
        if (preQty > 0) longPnl += gap;
        else if (preQty < 0) shortPnl += gap;

        const target = s.pending.get(d);
        if (target !== undefined) {
          s.pending.delete(d);
          const equityAtOpen = s.capital + pnl;
          const newQty = open > 0 ? (target * equityAtOpen) / open : 0;
          traded = Math.abs(newQty - s.qty) * open;
          costPaid = traded * perUnitCost;
          pnl -= costPaid;
          s.qty = newQty;
        }

        const settlements = s.input.settlements;
        while (s.settlementPtr < settlements.length && settlements[s.settlementPtr].t <= d) s.settlementPtr++;
        let p = s.settlementPtr;
        while (p < settlements.length && settlements[p].t <= d + DAY_MS) {
          fundingPnl -= s.qty * open * settlements[p].rate;
          p++;
        }
        pnl += fundingPnl;

        const move = s.qty * (close - open);
        pnl += move;
        if (s.qty > 0) longPnl += move + fundingPnl;
        else if (s.qty < 0) shortPnl += move + fundingPnl;
        s.mark = close;

        const sleeveCapitalBefore = s.capital;
        s.capital += pnl;
        dayPnl += pnl;

        const contribution = pnl / prevEquity;
        run.contributions[s.input.symbol][k] = contribution;
        run.sleeveReturns[s.input.symbol][k] = sleeveCapitalBefore > 0 ? pnl / sleeveCapitalBefore : Number.NaN;
        run.longLeg[k] += longPnl / prevEquity;
        run.shortLeg[k] += shortPnl / prevEquity;
        run.cost[k] += costPaid / prevEquity;
        run.funding[k] += fundingPnl / prevEquity;
        run.turnover[k] += traded / prevEquity;

        // Episodes: the day goes to the position held after the fill, or to
        // the one it closed when the fill went flat.
        const postSign = Math.sign(s.qty);
        if (postSign === s.episodeSign) {
          if (s.episodeSign !== 0) s.episodeSum += contribution;
        } else if (postSign === 0) {
          run.episodes.push(s.episodeSum + contribution);
          s.episodeSign = 0;
          s.episodeSum = 0;
        } else {
          if (s.episodeSign !== 0) run.episodes.push(s.episodeSum);
          s.episodeSign = postSign;
          s.episodeSum = contribution;
        }
      }
      equity += dayPnl;
      if (!(equity > 0)) throw new Error(`Portfolio equity reached ${equity} on ${new Date(d).toISOString()}`);
      run.returns[k] = dayPnl / prevEquity;
      let gross = 0;
      for (const s of sleeves) if (s.active) gross += Math.abs(s.qty * s.mark);
      run.gross[k] = gross / equity;
    }

    // The close of day d, at the instant d + 1 day.
    const closeAt = d + DAY_MS;
    if (closeAt >= opts.to) continue;
    const fillDay = closeAt + delay * DAY_MS;

    const joining = sleeves.filter((s) => !s.active && s.startDay === closeAt);
    const monthEnd = new Date(closeAt).getUTCDate() === 1;
    const anyActive = sleeves.some((s) => s.active);
    if (joining.length > 0 || (monthEnd && anyActive)) {
      for (const s of joining) {
        s.active = true;
        s.qty = 0;
        s.capital = 0;
      }
      const live = sleeves.filter((s) => s.active);
      const share = equity / live.length;
      for (const s of live) {
        // Back to the rule's weight on the new capital. Under a delay the last
        // rule order may still be pending; its target is the rule's weight too.
        s.capital = share;
        if (s.qty !== 0 || s.ruleTarget !== 0) s.pending.set(fillDay, s.ruleTarget);
      }
    }

    for (const s of sleeves) {
      if (!s.active) continue;
      const i = barIndex(s.input, d);
      if (i === -1) continue;
      const signal = s.paths.signal[i];
      const size = s.paths.size[i];
      const target = signal === 0 || !Number.isFinite(size) ? 0 : signal * size;
      // A sleeve's first decision after it joins is forced, whatever the schedule.
      let order = Number.isNaN(s.lastSignal);
      if (!order && s.paths.decide(i)) {
        const latest = latestPending(s.pending);
        const current =
          latest !== undefined ? latest : s.capital > 0 ? (s.qty * s.input.close[i]) / s.capital : 0;
        const changed = signal !== s.lastSignal;
        const rb = s.paths.rebalance;
        if (rb.kind === 'on-decision') order = true;
        else if (rb.kind === 'on-signal-change') order = changed || (target !== 0 && current === 0);
        else order = changed || (current === 0 ? target !== 0 : Math.abs(target - current) / Math.abs(current) > rb.band);
      }
      if (order) {
        s.pending.set(fillDay, target);
        s.lastSignal = signal;
        s.ruleTarget = target;
      }
    }
  }

  for (const s of sleeves) if (s.episodeSign !== 0) run.episodes.push(s.episodeSum);
  return run;
}

function latestPending(pending: Map<number, number>): number | undefined {
  let bestDay = -Infinity;
  let best: number | undefined;
  for (const [day, w] of pending) {
    if (day > bestDay) {
      bestDay = day;
      best = w;
    }
  }
  return best;
}

/*
 * BROAD MODE (broad-trend.ts header, CONTRACTS, PORTFOLIO and COSTS). A separate
 * path so the legends container above stays byte-identical; the per-day
 * accounting (gap, fill, funding, mark) is the same as runTrend's. The choices the
 * header leaves open are listed in broad-trend.ts's implementation notes (A4).
 */

/** Legends mode reads none of the broad fields, so it refuses inputs that carry them rather than ignore them. */
function assertLegendsInput(input: TrendSymbolInput): void {
  const carried = input.carried !== undefined && input.carried.some((x) => x === 1);
  if (input.membership !== undefined || (input.endDay !== undefined && input.endDay !== null) || carried) {
    throw new Error(`${input.symbol}: membership, endDay and carried days need SimOptions.broad`);
  }
}

/** 00:00 UTC on the 1st of a month: a ranking close. */
export function isRankingClose(ms: number): boolean {
  return ms % DAY_MS === 0 && new Date(ms).getUTCDate() === 1;
}

/** The membership span covering `day`, or undefined. */
export function spanAt(membership: readonly MembershipSpan[] | undefined, day: number): MembershipSpan | undefined {
  if (!membership) return undefined;
  for (const span of membership) if (span.from <= day && day < span.to) return span;
  return undefined;
}

/** Throws unless a broad input is daily, its carried days copy the last close, its spans are sorted month ranges and its end is its last real bar. */
export function assertBroadInput(input: TrendSymbolInput): void {
  assertDaily(input);
  const n = input.t.length;
  const { carried, membership, endDay } = input;
  if (carried !== undefined) {
    if (carried.length !== n) throw new Error(`${input.symbol}: carried has ${carried.length} flags for ${n} bars`);
    for (let i = 0; i < n; i++) {
      if (carried[i] !== 1) continue;
      if (i === 0 || input.open[i] !== input.close[i - 1] || input.close[i] !== input.close[i - 1]) {
        throw new Error(`${input.symbol}: carried bar ${i} does not repeat the last close`);
      }
    }
  }
  if (membership !== undefined) {
    let previousTo = -Infinity;
    for (const span of membership) {
      if (!isRankingClose(span.from) || !isRankingClose(span.to) || !(span.to > span.from)) {
        throw new Error(`${input.symbol}: membership span [${span.from}, ${span.to}) is not ranking close to ranking close`);
      }
      if (span.from < previousTo) throw new Error(`${input.symbol}: membership spans overlap or are unsorted`);
      if (!Number.isInteger(span.rank) || span.rank < 1) throw new Error(`${input.symbol}: rank ${span.rank} is not a positive integer`);
      previousTo = span.to;
    }
  }
  if (endDay !== undefined && endDay !== null) {
    if (n === 0 || input.t[n - 1] !== endDay) throw new Error(`${input.symbol}: endDay is not its last bar`);
    if (carried !== undefined && carried[n - 1] === 1) throw new Error(`${input.symbol}: its last bar is carried`);
  }
}

/**
 * Header PORTFOLIO: "Sleeve capital plus cash equals portfolio equity on every
 * day (asserted)." Throws when |sum of capital + cash - equity| exceeds 1e-9 of
 * max(1, equity).
 */
export function assertCashBalance(capitalSum: number, cash: number, equity: number, day: number): void {
  const gap = Math.abs(capitalSum + cash - equity);
  if (!(gap <= 1e-9 * Math.max(1, Math.abs(equity)))) {
    throw new Error(
      `Sleeve capital ${capitalSum} plus cash ${cash} is not equity ${equity} on ${new Date(day).toISOString()}`
    );
  }
}

interface BroadSleeve extends SleeveState {
  /** Rank at the last ranking close that kept it. */
  rank: number;
  /** Left at a ranking close; its exit order has not filled yet. */
  leaving: boolean;
  leaveClose: number;
}

/**
 * The fill due on day d: the order with the latest fill day at or before d (the
 * most recently decided one), every such order removed. An order due on a
 * carried day stays pending and fills at the next real bar's open.
 */
function takeDue(pending: Map<number, number>, day: number): number | undefined {
  let bestDay = -Infinity;
  let best: number | undefined;
  for (const [fillDay, w] of pending) {
    if (fillDay <= day && fillDay > bestDay) {
      bestDay = fillDay;
      best = w;
    }
  }
  if (best !== undefined) for (const fillDay of [...pending.keys()]) if (fillDay <= day) pending.delete(fillDay);
  return best;
}

/** Discards a sleeve's rule state: a later rejoin decides afresh, as at a listing. */
function resetBroadSleeve(s: BroadSleeve): void {
  s.active = false;
  s.capital = 0;
  s.qty = 0;
  s.mark = Number.NaN;
  s.lastSignal = Number.NaN;
  s.ruleTarget = 0;
  s.pending.clear();
  s.rank = Number.NaN;
  s.leaving = false;
  s.leaveClose = Number.NaN;
}

/**
 * SimOptions.reequaliseAt (broad-flow.ts implementation note F7): the live sleeves'
 * capital, split equally across those whose paths are defined at the bar of `day`
 * (the close deciding at day + 1 day); the others get 0. Cash is not touched. With
 * no such sleeve nothing changes. Each live sleeve holding a position or a target
 * gets an order back to its rule's target at `fillDay`.
 */
function reequaliseLive(sleeves: readonly BroadSleeve[], day: number, fillDay: number): void {
  const live = sleeves.filter((s) => s.active && !s.leaving);
  const holders = new Set(
    live.filter((s) => {
      const defined = s.paths.defined;
      if (defined === undefined) return true;
      const i = barIndex(s.input, day);
      return i !== -1 && defined[i] === 1;
    })
  );
  if (holders.size === 0) return;
  const pool = live.reduce((sum, s) => sum + s.capital, 0);
  if (!(pool > 0)) throw new Error(`Live capital ${pool} cannot be re-equalised at ${new Date(day + DAY_MS).toISOString()}`);
  const share = pool / holders.size;
  for (const s of live) {
    s.capital = holders.has(s) ? share : 0;
    if (s.qty !== 0 || s.ruleTarget !== 0) s.pending.set(fillDay, s.ruleTarget);
  }
}

/**
 * runTrend in broad mode. Per day d, for each active sleeve, as runTrend (gap,
 * fill, funding, mark), except:
 *   - a carried day books nothing: no fill (the due order waits for the next real
 *     bar's open), no funding, no price move;
 *   - a fill pays the taker fee plus the slippage of the sleeve's rank, or plus
 *     the leave slippage for a leaving sleeve's exit;
 *   - on the contract's endDay, after the mark, any position is closed at the close
 *     moved the haircut against it, plus the taker fee on that notional; the
 *     sleeve's capital moves to cash and its state resets;
 *   - after a leaving sleeve's exit fills, its capital moves to cash and its state
 *     resets.
 * At each ranking close C (00:00 UTC on a 1st): equity, all sleeve capital plus
 * cash, is split equally across the members of [C, next C); a sleeve that is not
 * one gets capital 0 and an order to 0 at the next open; a member keeps (or, on
 * joining, starts from a reset) its rule state and gets an order back to its
 * rule's target weight on the new capital. A member whose contract ended before C
 * holds its share as cash. With `opts.reequaliseAt`, the closes it names also
 * re-split the live capital (reequaliseLive). Decisions read the close of d as in
 * runTrend.
 */
function runBroadTrend(
  inputs: TrendSymbolInput[],
  paths: Record<string, RulePaths>,
  opts: SimOptions,
  broad: BroadCost
): TrendRun {
  const { cost, delay } = opts;
  if (!isRankingClose(opts.from)) throw new Error('A broad run starts at a ranking close (00:00 UTC on the 1st)');
  const sleeves: BroadSleeve[] = inputs.map((input) => ({
    input,
    paths: paths[input.symbol],
    startDay: Number.NaN,
    active: false,
    capital: 0,
    qty: 0,
    mark: Number.NaN,
    lastSignal: Number.NaN,
    ruleTarget: 0,
    pending: new Map(),
    settlementPtr: 0,
    episodeSign: 0,
    episodeSum: 0,
    rank: Number.NaN,
    leaving: false,
    leaveClose: Number.NaN,
  }));
  for (const s of sleeves) {
    if (!s.paths) throw new Error(`No rule paths for ${s.input.symbol}`);
    assertBroadInput(s.input);
  }

  const days: number[] = [];
  for (let d = opts.from; d < opts.to; d += DAY_MS) days.push(d);
  const n = days.length;
  const detail: BroadRunDetail = {
    cash: new Array(n).fill(0),
    members: new Array(n).fill(0),
    delistings: [],
    leaves: [],
    net: new Array(n).fill(0),
    openLong: new Array(n).fill(0),
    openShort: new Array(n).fill(0),
  };
  const startDay: Record<string, number> = {};
  const run: TrendRun = {
    days,
    returns: new Array(n).fill(0),
    longLeg: new Array(n).fill(0),
    shortLeg: new Array(n).fill(0),
    cost: new Array(n).fill(0),
    funding: new Array(n).fill(0),
    turnover: new Array(n).fill(0),
    gross: new Array(n).fill(0),
    sleeveReturns: Object.fromEntries(inputs.map((i) => [i.symbol, new Array(n).fill(Number.NaN)])),
    contributions: Object.fromEntries(inputs.map((i) => [i.symbol, new Array(n).fill(0)])),
    episodes: [],
    startDay,
    broad: detail,
  };

  let equity = 1;
  let cash = 0;
  const capitalSum = (): number => sleeves.reduce((sum, s) => sum + s.capital, 0);

  for (let k = -1; k < n; k++) {
    const d = k === -1 ? opts.from - DAY_MS : days[k];

    if (k >= 0) {
      const prevEquity = equity;
      let dayPnl = 0;
      for (const s of sleeves) {
        if (!s.active) continue;
        const i = barIndex(s.input, d);
        if (i === -1) throw new Error(`${s.input.symbol}: no bar on ${new Date(d).toISOString()}`);
        const carried = s.input.carried !== undefined && s.input.carried[i] === 1;
        const open = s.input.open[i];
        const close = s.input.close[i];
        const preQty = s.qty;
        let pnl = 0;
        let longPnl = 0;
        let shortPnl = 0;
        let fundingPnl = 0;
        let costPaid = 0;
        let traded = 0;
        let filled = false;

        if (!carried) {
          const gap = preQty === 0 ? 0 : preQty * (open - s.mark);
          pnl += gap;
          if (preQty > 0) longPnl += gap;
          else if (preQty < 0) shortPnl += gap;

          const target = takeDue(s.pending, d);
          if (target !== undefined) {
            const equityAtOpen = s.capital + pnl;
            const newQty = open > 0 ? (target * equityAtOpen) / open : 0;
            traded = Math.abs(newQty - s.qty) * open;
            const slippage = s.leaving ? broad.leaveSlippage : broad.slippageForRank(s.rank);
            costPaid = traded * (cost.fee + slippage);
            pnl -= costPaid;
            s.qty = newQty;
            filled = true;
          }

          const settlements = s.input.settlements;
          while (s.settlementPtr < settlements.length && settlements[s.settlementPtr].t <= d) s.settlementPtr++;
          let p = s.settlementPtr;
          while (p < settlements.length && settlements[p].t <= d + DAY_MS) {
            fundingPnl -= s.qty * open * settlements[p].rate;
            p++;
          }
          pnl += fundingPnl;

          const move = s.qty * (close - open);
          pnl += move;
          if (s.qty > 0) longPnl += move + fundingPnl;
          else if (s.qty < 0) shortPnl += move + fundingPnl;
        }
        // On a carried day the close repeats the last real close (assertBroadInput), so the mark does not move.
        s.mark = close;
        // The position just after the day's fill, at the day's open (it is unchanged by funding and the mark).
        if (s.qty > 0) detail.openLong[k] += (s.qty * open) / prevEquity;
        else if (s.qty < 0) detail.openShort[k] -= (s.qty * open) / prevEquity;

        const delisted = s.input.endDay !== undefined && s.input.endDay !== null && d === s.input.endDay;
        if (delisted && s.qty !== 0) {
          const exitPrice = close * (1 - Math.sign(s.qty) * broad.delistHaircut);
          const haircut = Math.abs(s.qty) * close * broad.delistHaircut;
          const exitNotional = Math.abs(s.qty) * exitPrice;
          const fee = exitNotional * cost.fee;
          detail.delistings.push({ symbol: s.input.symbol, day: d, qty: s.qty, close, exitPrice, haircut, fee });
          pnl -= haircut + fee;
          costPaid += haircut + fee;
          traded += exitNotional;
          s.qty = 0;
        }

        const sleeveCapitalBefore = s.capital;
        s.capital += pnl;
        dayPnl += pnl;

        const contribution = pnl / prevEquity;
        run.contributions[s.input.symbol][k] = contribution;
        run.sleeveReturns[s.input.symbol][k] = sleeveCapitalBefore > 0 ? pnl / sleeveCapitalBefore : Number.NaN;
        run.longLeg[k] += longPnl / prevEquity;
        run.shortLeg[k] += shortPnl / prevEquity;
        run.cost[k] += costPaid / prevEquity;
        run.funding[k] += fundingPnl / prevEquity;
        run.turnover[k] += traded / prevEquity;

        const postSign = Math.sign(s.qty);
        if (postSign === s.episodeSign) {
          if (s.episodeSign !== 0) s.episodeSum += contribution;
        } else if (postSign === 0) {
          run.episodes.push(s.episodeSum + contribution);
          s.episodeSign = 0;
          s.episodeSum = 0;
        } else {
          if (s.episodeSign !== 0) run.episodes.push(s.episodeSum);
          s.episodeSign = postSign;
          s.episodeSum = contribution;
        }

        const left = s.leaving && filled;
        if (left) {
          detail.leaves.push({
            symbol: s.input.symbol,
            close: s.leaveClose,
            day: d,
            traded,
            cost: costPaid,
            residual: s.capital,
          });
        }
        if (delisted || left) {
          cash += s.capital;
          resetBroadSleeve(s);
        }
      }
      equity += dayPnl;
      if (!(equity > 0)) throw new Error(`Portfolio equity reached ${equity} on ${new Date(d).toISOString()}`);
      run.returns[k] = dayPnl / prevEquity;
      let gross = 0;
      let net = 0;
      let members = 0;
      for (const s of sleeves) {
        if (!s.active) continue;
        gross += Math.abs(s.qty * s.mark);
        net += s.qty * s.mark;
        if (!s.leaving) members++;
      }
      run.gross[k] = gross / equity;
      detail.net[k] = net / equity;
      detail.cash[k] = cash / equity;
      detail.members[k] = members;
      assertCashBalance(capitalSum(), cash, equity, d);
    }

    // The close of day d, at the instant d + 1 day.
    const closeAt = d + DAY_MS;
    if (closeAt >= opts.to) continue;
    const fillDay = closeAt + delay * DAY_MS;

    if (isRankingClose(closeAt)) {
      const members: Array<{ s: BroadSleeve; rank: number }> = [];
      for (const s of sleeves) {
        const span = spanAt(s.input.membership, closeAt);
        if (span) members.push({ s, rank: span.rank });
      }
      const isMember = new Set(members.map((m) => m.s));
      for (const s of sleeves) {
        if (!s.active || isMember.has(s)) continue;
        // Its capital goes into the split; it keeps its position until its exit order fills.
        s.capital = 0;
        if (!s.leaving) {
          s.pending.clear();
          s.pending.set(fillDay, 0);
          s.leaving = true;
          s.leaveClose = closeAt;
        }
      }
      const share = members.length > 0 ? equity / members.length : 0;
      let dead = 0;
      for (const { s, rank } of members) {
        if (s.leaving) throw new Error(`${s.input.symbol}: rejoins at ${new Date(closeAt).toISOString()} before its exit filled`);
        const endDay = s.input.endDay;
        if (endDay !== undefined && endDay !== null && endDay < closeAt) {
          // Selected at C, but its last bar closed at or before C: it never trades again.
          dead++;
          continue;
        }
        if (!s.active) {
          resetBroadSleeve(s);
          s.active = true;
          if (startDay[s.input.symbol] === undefined) startDay[s.input.symbol] = closeAt;
        }
        s.capital = share;
        s.rank = rank;
        // Back to the rule's weight on the new capital, as runTrend's re-equalisation.
        if (s.qty !== 0 || s.ruleTarget !== 0) s.pending.set(fillDay, s.ruleTarget);
      }
      cash = members.length > 0 ? dead * share : equity;
      assertCashBalance(capitalSum(), cash, equity, closeAt);
    }

    if (opts.reequaliseAt && opts.reequaliseAt(closeAt)) {
      reequaliseLive(sleeves, d, fillDay);
      assertCashBalance(capitalSum(), cash, equity, closeAt);
    }

    for (const s of sleeves) {
      if (!s.active || s.leaving) continue;
      const i = barIndex(s.input, d);
      if (i === -1) continue;
      const signal = s.paths.signal[i];
      const size = s.paths.size[i];
      const target = signal === 0 || !Number.isFinite(size) ? 0 : signal * size;
      // A sleeve's first decision after it joins (or rejoins) is forced, whatever the schedule.
      let order = Number.isNaN(s.lastSignal);
      if (!order && s.paths.decide(i)) {
        const latest = latestPending(s.pending);
        const current =
          latest !== undefined ? latest : s.capital > 0 ? (s.qty * s.input.close[i]) / s.capital : 0;
        const changed = signal !== s.lastSignal;
        const rb = s.paths.rebalance;
        if (rb.kind === 'on-decision') order = true;
        else if (rb.kind === 'on-signal-change') order = changed || (target !== 0 && current === 0);
        else order = changed || (current === 0 ? target !== 0 : Math.abs(target - current) / Math.abs(current) > rb.band);
      }
      if (order) {
        s.pending.set(fillDay, target);
        s.lastSignal = signal;
        s.ruleTarget = target;
      }
    }
  }

  for (const s of sleeves) if (s.episodeSign !== 0) run.episodes.push(s.episodeSum);
  return run;
}

/** Mean and sample standard deviation. */
function meanSd(xs: readonly number[]): { mean: number; sd: number } {
  const n = xs.length;
  if (n < 2) return { mean: Number.NaN, sd: Number.NaN };
  let m = 0;
  for (const x of xs) m += x;
  m /= n;
  let v = 0;
  for (const x of xs) v += (x - m) ** 2;
  return { mean: m, sd: Math.sqrt(v / (n - 1)) };
}

/** Annualised Sharpe of a daily series: mean over sample sd, times sqrt(365). NaN when undefined. */
export function annualisedSharpe(xs: readonly number[]): number {
  const { mean, sd } = meanSd(xs);
  return sd > 0 ? (mean / sd) * Math.sqrt(YEAR_DAYS) : Number.NaN;
}

/** Annualised arithmetic mean of a daily series. */
export function annualMean(xs: readonly number[]): number {
  return xs.length === 0 ? Number.NaN : (xs.reduce((a, b) => a + b, 0) / xs.length) * YEAR_DAYS;
}

/**
 * Circular block bootstrap (Politis and Romano 1992): ceil(n / L) blocks of
 * fixed length L, each starting at a uniform index and wrapping past the end,
 * concatenated and cut to n. The pre-registered resampler (circular blocks of
 * 60 days), distinct from the stationary bootstrap in block-bootstrap.ts.
 */
export function circularBlockIndices(n: number, blockLen: number, random: () => number): number[] {
  const L = Math.max(1, Math.min(n, Math.floor(blockLen)));
  const out: number[] = [];
  while (out.length < n) {
    const start = Math.floor(random() * n);
    for (let j = 0; j < L && out.length < n; j++) out.push((start + j) % n);
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  const index = p * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

export interface BootOptions {
  blockLen: number;
  iterations?: number;
  seed?: number;
}

export interface CiStat {
  point: number;
  low: number;
  high: number;
  blockLen: number;
}

/**
 * Percentile 95% CI of a statistic of n aligned days, the days resampled in
 * circular blocks; `stat` reads the resampled index list. Draws whose
 * statistic is undefined are dropped.
 */
export function circularBootstrapCi(n: number, stat: (idx: number[]) => number, opts: BootOptions): CiStat {
  const iterations = opts.iterations ?? 2000;
  const random = createSeededRandom(opts.seed ?? 42);
  const all = Array.from({ length: n }, (_, i) => i);
  const point = stat(all);
  const draws: number[] = [];
  for (let b = 0; b < iterations; b++) {
    const v = stat(circularBlockIndices(n, opts.blockLen, random));
    if (Number.isFinite(v)) draws.push(v);
  }
  draws.sort((a, b) => a - b);
  if (draws.length === 0) return { point, low: Number.NaN, high: Number.NaN, blockLen: opts.blockLen };
  return { point, low: percentile(draws, 0.025), high: percentile(draws, 0.975), blockLen: opts.blockLen };
}

/** OLS of y on x with an intercept: daily alpha and beta. */
export function olsAlphaBeta(y: readonly number[], x: readonly number[]): { alpha: number; beta: number } {
  const n = y.length;
  if (n < 2 || x.length !== n) return { alpha: Number.NaN, beta: Number.NaN };
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  const beta = sxx > 0 ? sxy / sxx : Number.NaN;
  return { alpha: my - beta * mx, beta };
}

/** Annualised alpha of T on its twin over the given day indices (all when omitted). */
export function annualAlpha(t: readonly number[], twin: readonly number[], idx?: readonly number[]): { alpha: number; beta: number } {
  const ys = idx ? idx.map((i) => t[i]) : t;
  const xs = idx ? idx.map((i) => twin[i]) : twin;
  const { alpha, beta } = olsAlphaBeta(ys, xs);
  return { alpha: alpha * YEAR_DAYS, beta };
}

/** Annualised Sharpe with its circular block bootstrap CI. */
export function sharpeCi(returns: readonly number[], opts: BootOptions): CiStat {
  return circularBootstrapCi(returns.length, (idx) => annualisedSharpe(idx.map((i) => returns[i])), opts);
}

/** Annualised alpha of T on T+ with a paired circular block bootstrap CI. */
export function alphaCi(t: readonly number[], twin: readonly number[], opts: BootOptions): CiStat {
  return circularBootstrapCi(t.length, (idx) => annualAlpha(t, twin, idx).alpha, opts);
}

/** The slice of a run's days from the first day any sleeve holds capital. */
export function liveRange(run: TrendRun): { first: number; last: number } {
  const first = Math.min(...Object.values(run.startDay));
  const k = run.days.findIndex((d) => d >= first);
  return { first: k === -1 ? run.days.length : k, last: run.days.length - 1 };
}

/** Maximum drawdown of the compounded equity of a daily return series, as a positive fraction. */
export function maxDrawdown(returns: readonly number[]): number {
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = 1 - equity / peak;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/** Calendar-year alphas, `years` inclusive, from aligned daily series. */
export function yearAlphas(
  days: readonly number[],
  t: readonly number[],
  twin: readonly number[],
  years: readonly number[]
): Array<{ year: number; alpha: number; days: number }> {
  return years.map((year) => {
    const from = Date.UTC(year, 0, 1);
    const to = Date.UTC(year + 1, 0, 1);
    const idx: number[] = [];
    for (let i = 0; i < days.length; i++) if (days[i] >= from && days[i] < to) idx.push(i);
    return { year, alpha: idx.length >= 2 ? annualAlpha(t, twin, idx).alpha : Number.NaN, days: idx.length };
  });
}

/** Share of the summed episode PnL taken by the best `share` of episodes (Brandt). */
export function topEpisodeShare(episodes: readonly number[], share = 0.15): { share: number; top: number; total: number } {
  const total = episodes.reduce((a, b) => a + b, 0);
  const sorted = [...episodes].sort((a, b) => b - a);
  const k = Math.max(1, Math.ceil(sorted.length * share));
  const top = sorted.slice(0, k).reduce((a, b) => a + b, 0);
  return { share: total !== 0 ? top / total : Number.NaN, top, total };
}

/**
 * Longest run of losing episodes against its expectation for independent
 * episodes with the same loss rate q: about log(n (1 - q)) / log(1 / q)
 * (Schilling 1990).
 */
export function losingStreak(episodes: readonly number[]): { longest: number; expected: number; lossRate: number } {
  let longest = 0;
  let run = 0;
  let losses = 0;
  for (const e of episodes) {
    if (e < 0) {
      losses++;
      run++;
      if (run > longest) longest = run;
    } else run = 0;
  }
  const n = episodes.length;
  const q = n > 0 ? losses / n : Number.NaN;
  const expected = q > 0 && q < 1 && n * (1 - q) > 1 ? Math.log(n * (1 - q)) / Math.log(1 / q) : Number.NaN;
  return { longest, expected, lossRate: q };
}

/**
 * One symbol's paths with the signal circularly shifted by `k` over the bars
 * the sample decides at, [first decision bar, last bar]; the size path stays
 * on its true dates (gate 4).
 */
export function shiftSignal(paths: RulePaths, firstIdx: number, lastIdx: number, k: number): RulePaths {
  const signal = Float64Array.from(paths.signal);
  const len = lastIdx - firstIdx + 1;
  for (let j = 0; j < len; j++) signal[firstIdx + ((j + k) % len)] = paths.signal[firstIdx + j];
  return { ...paths, signal };
}

/** The bar span a sleeve decides at in a sample: from the close before its first day to the last day. */
export function decisionSpan(input: TrendSymbolInput, opts: SimOptions): { firstIdx: number; lastIdx: number } {
  const start = sleeveStart(input, opts.from);
  let firstIdx = barIndex(input, start - DAY_MS);
  if (firstIdx === -1) firstIdx = barIndex(input, start);
  const lastIdx = barIndex(input, utcDay(opts.to - 1));
  if (firstIdx === -1 || lastIdx === -1) throw new Error(`${input.symbol}: sample outside its bars`);
  return { firstIdx, lastIdx };
}

/** Pre-registered minimum circular shift, in days, for the timing null. */
export const MIN_SHIFT_DAYS = 365;

/**
 * Gate 4's timing null: in each draw every symbol's signal path is shifted by
 * its own uniform offset in [365, len - 365] bars, the rule re-run, and its
 * alpha taken against the UNSHIFTED twin. p = (1 + draws at or above the
 * observed alpha) / (draws + 1).
 *
 * `nullOptions.mode` 'wrapped' or 'aligned' runs the broad phase's common-shift
 * nulls instead (commonShiftNull, below); the default 'independent' is this one.
 */
export function timingNull(
  inputs: TrendSymbolInput[],
  paths: Record<string, RulePaths>,
  twinReturns: readonly number[],
  observedAlpha: number,
  opts: SimOptions,
  range: { first: number; last: number },
  draws = 200,
  seed = 7,
  nullOptions: TimingNullOptions = {}
): TimingNullResult {
  // An undefined observed alpha is no evidence of timing. Without this guard no draw compares
  // "at or above" NaN, so p came out at its minimum, 1 / (draws + 1), and read as a pass.
  if (!Number.isFinite(observedAlpha)) return { p: 1, nullMean: Number.NaN, draws: 0 };
  const mode = nullOptions.mode ?? 'independent';
  if (mode !== 'independent') {
    return commonShiftNull(mode, inputs, paths, twinReturns, observedAlpha, opts, range, draws, seed, nullOptions);
  }
  const random = createSeededRandom(seed);
  const spans = inputs.map((input) => decisionSpan(input, opts));
  for (let s = 0; s < inputs.length; s++) {
    const len = spans[s].lastIdx - spans[s].firstIdx + 1;
    if (len < 2 * MIN_SHIFT_DAYS + 1) throw new Error(`${inputs[s].symbol}: ${len} bars is too short for a ${MIN_SHIFT_DAYS}-day shift`);
  }
  const twin = twinReturns.slice(range.first, range.last + 1);
  let atOrAbove = 0;
  let sum = 0;
  for (let d = 0; d < draws; d++) {
    const shifted: Record<string, RulePaths> = {};
    inputs.forEach((input, s) => {
      const len = spans[s].lastIdx - spans[s].firstIdx + 1;
      const k = MIN_SHIFT_DAYS + Math.floor(random() * (len - 2 * MIN_SHIFT_DAYS + 1));
      shifted[input.symbol] = shiftSignal(paths[input.symbol], spans[s].firstIdx, spans[s].lastIdx, k);
    });
    const r = runTrend(inputs, shifted, opts).returns.slice(range.first, range.last + 1);
    const a = annualAlpha(r, twin).alpha;
    sum += a;
    if (a >= observedAlpha) atOrAbove++;
  }
  return { p: (1 + atOrAbove) / (draws + 1), nullMean: sum / draws, draws };
}

/*
 * BROAD GATE 4 (broad-trend.ts header): two timing nulls with ONE shift k per
 * draw, uniform on [365, S - 365] days, S the days of the null calendar
 * (2020-01-01 to 2026-06-30 inclusive by default). Sizes stay on their true
 * dates; alpha is taken against the UNSHIFTED twin, as in the legends null.
 */

export type TimingNullMode = 'independent' | 'wrapped' | 'aligned';

/** The broad null calendar: 2020-01-01 (the archive's first month) to 2026-06-30, inclusive. */
export const NULL_CALENDAR_START = Date.UTC(2020, 0, 1);
export const NULL_CALENDAR_DAYS = (Date.UTC(2026, 5, 30) - NULL_CALENDAR_START) / DAY_MS + 1;

/** A shared state path (C3's basket state) on consecutive days, shifted once for every input. */
export interface SharedStatePath {
  days: readonly number[];
  state: Float64Array;
}

export interface TimingNullOptions {
  /** 'independent' (default): the legends null, unchanged. */
  mode?: TimingNullMode;
  /** First day of the null calendar. */
  calendarStart?: number;
  /** S, the days of the null calendar. */
  calendarDays?: number;
  /** C3: the shared basket state. It is shifted instead, and each input's signal is read from it by date. */
  shared?: SharedStatePath;
  /** Test hook: each draw's shift and the paths it runs. */
  onDraw?: (k: number, shifted: Record<string, RulePaths>) => void;
}

export interface TimingNullResult {
  p: number;
  nullMean: number;
  draws: number;
  /** 'wrapped' and 'aligned': each draw's common shift, in days. */
  shifts?: number[];
  /**
   * 'wrapped': the mean over draws of the share of member-days whose input is no
   * longer than k bars (shifted out of calendar alignment with the others).
   */
  misalignedShare?: number;
}

/** A signal path circularly shifted by k: out[(j + k) mod n] = values[j]. */
function circularShift(values: Float64Array, k: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  for (let j = 0; j < n; j++) out[(j + k) % n] = values[j];
  return out;
}

/** Calendar position of a day, throwing outside the calendar. */
function calendarPosition(day: number, start: number, days: number, symbol: string): number {
  const c = Math.round((day - start) / DAY_MS);
  if (c < 0 || c >= days || start + c * DAY_MS !== day) {
    throw new Error(`${symbol}: bar ${new Date(day).toISOString()} lies outside the null calendar`);
  }
  return c;
}

/** The day k days before `day` on the calendar that wraps from its last day back to its first. */
function calendarSource(day: number, k: number, start: number, days: number, symbol: string): number {
  const c = calendarPosition(day, start, days, symbol);
  return start + ((((c - k) % days) + days) % days) * DAY_MS;
}

function valueOn(days: readonly number[], values: Float64Array, day: number): number {
  if (days.length === 0) return 0;
  const k = Math.round((day - days[0]) / DAY_MS);
  return k >= 0 && k < days.length && days[k] === day ? values[k] : 0;
}

/**
 * One draw's shifted paths for a common shift k (exported for tests).
 *   - 'wrapped': each input's signal is shifted circularly by k modulo its own
 *     full length in bars; with `shared`, the shared state is shifted by k modulo
 *     its own length and each input reads it by date.
 *   - 'aligned': the signal on day d is the signal on day d - k on the calendar
 *     that wraps from its last day back to its first; 0 (holds nothing) where that
 *     day is outside the input's bars (or, with `shared`, outside the state's days).
 * Size, schedule, band and `defined` stay on the true dates.
 */
export function commonShiftPaths(
  mode: Exclude<TimingNullMode, 'independent'>,
  inputs: readonly TrendSymbolInput[],
  paths: Record<string, RulePaths>,
  k: number,
  calendar: { start: number; days: number },
  shared?: SharedStatePath
): Record<string, RulePaths> {
  const out: Record<string, RulePaths> = {};
  let sharedShifted: Float64Array | undefined;
  if (shared && mode === 'wrapped') sharedShifted = circularShift(shared.state, k);
  for (const input of inputs) {
    const base = paths[input.symbol];
    if (!base) throw new Error(`No rule paths for ${input.symbol}`);
    if (base.signal.length !== input.t.length) throw new Error(`${input.symbol}: paths and bars differ in length`);
    let signal: Float64Array;
    if (shared) {
      signal = new Float64Array(input.t.length);
      for (let i = 0; i < input.t.length; i++) {
        signal[i] =
          mode === 'wrapped'
            ? valueOn(shared.days, sharedShifted!, input.t[i])
            : valueOn(shared.days, shared.state, calendarSource(input.t[i], k, calendar.start, calendar.days, input.symbol));
      }
    } else if (mode === 'wrapped') {
      signal = input.t.length > 0 ? circularShift(base.signal, k % input.t.length) : new Float64Array(0);
    } else {
      signal = new Float64Array(input.t.length);
      for (let i = 0; i < input.t.length; i++) {
        const j = barIndex(input, calendarSource(input.t[i], k, calendar.start, calendar.days, input.symbol));
        signal[i] = j === -1 ? 0 : base.signal[j];
      }
    }
    out[input.symbol] = { ...base, signal };
  }
  return out;
}

/**
 * Days an input is a member in a sample: in broad mode the days of [from, to)
 * its membership covers while it has a bar; otherwise its days from its sleeve
 * start while it has a bar.
 */
export function memberDays(input: TrendSymbolInput, opts: SimOptions): number {
  let count = 0;
  const first = opts.broad ? opts.from : sleeveStart(input, opts.from);
  for (let d = first; d < opts.to; d += DAY_MS) {
    if (barIndex(input, d) === -1) continue;
    if (opts.broad && !spanAt(input.membership, d)) continue;
    count++;
  }
  return count;
}

/**
 * 'wrapped': the share of member-days whose shifted path is no longer than k
 * bars, so wraps whole and leaves calendar alignment with the others. NaN when
 * there are no member-days.
 */
export function misalignedShare(lengths: readonly number[], memberDayCounts: readonly number[], k: number): number {
  let total = 0;
  let misaligned = 0;
  lengths.forEach((length, s) => {
    total += memberDayCounts[s];
    if (length <= k) misaligned += memberDayCounts[s];
  });
  return total > 0 ? misaligned / total : Number.NaN;
}

function commonShiftNull(
  mode: Exclude<TimingNullMode, 'independent'>,
  inputs: TrendSymbolInput[],
  paths: Record<string, RulePaths>,
  twinReturns: readonly number[],
  observedAlpha: number,
  opts: SimOptions,
  range: { first: number; last: number },
  draws: number,
  seed: number,
  nullOptions: TimingNullOptions
): TimingNullResult {
  const calendar = {
    start: nullOptions.calendarStart ?? NULL_CALENDAR_START,
    days: nullOptions.calendarDays ?? NULL_CALENDAR_DAYS,
  };
  if (!Number.isInteger(calendar.days) || calendar.days < 2 * MIN_SHIFT_DAYS + 1) {
    throw new Error(`A ${calendar.days}-day calendar is too short for a ${MIN_SHIFT_DAYS}-day shift`);
  }
  const { shared } = nullOptions;
  const random = createSeededRandom(seed);
  const twin = twinReturns.slice(range.first, range.last + 1);
  const memberDayCounts = inputs.map((input) => memberDays(input, opts));
  // In 'wrapped' the shifted path of an input is its own signal, or with a shared state that state.
  const lengths = inputs.map((input) => (shared ? shared.days.length : input.t.length));
  const shifts: number[] = [];
  let misalignedSum = 0;
  let atOrAbove = 0;
  let sum = 0;
  for (let draw = 0; draw < draws; draw++) {
    const k = MIN_SHIFT_DAYS + Math.floor(random() * (calendar.days - 2 * MIN_SHIFT_DAYS + 1));
    shifts.push(k);
    if (mode === 'wrapped') misalignedSum += misalignedShare(lengths, memberDayCounts, k);
    const shifted = commonShiftPaths(mode, inputs, paths, k, calendar, shared);
    nullOptions.onDraw?.(k, shifted);
    const r = runTrend(inputs, shifted, opts).returns.slice(range.first, range.last + 1);
    const a = annualAlpha(r, twin).alpha;
    sum += a;
    if (a >= observedAlpha) atOrAbove++;
  }
  const result: TimingNullResult = { p: (1 + atOrAbove) / (draws + 1), nullMean: sum / draws, draws, shifts };
  if (mode === 'wrapped') result.misalignedShare = misalignedSum / draws;
  return result;
}
