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
 * 9. Re-equalisation keeps each sleeve's current weight: the quantity is rescaled to the new capital by
 *    an order filled at the next open, paying fee and slippage on the traded notional. A rule order
 *    decided at the same close replaces it.
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

export interface SimOptions {
  /** First UTC day a sleeve may hold; a symbol listed later starts at its listing day. */
  from: number;
  /** End, exclusive: the last simulated day is the last one before `to`. */
  to: number;
  cost: TrendCost;
  /** Bars between the deciding close and the fill: 0 fills at the next open (the rule), 1 is the sensitivity. */
  delay: number;
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
 * month end and whenever a sleeve joins, each sleeve keeping its current weight
 * through an order that pays the usual costs. A rule order placed at the same
 * close replaces that order.
 *
 * Per day d (bar open d, close d + 1 day), for each live sleeve:
 *   gap     qty x (open - last mark)               the overnight quantity, up to the fill
 *   fill    a pending order trades to target x equity at the open / open, paying
 *           |traded notional| x (fee + slippage)
 *   funding -qty x open x rate for every settlement in (d, d + 1 day]
 *   mark    qty x (close - open)
 * A settlement exactly at the open belongs to the day before, as in carry-sim.ts.
 * Decisions read the close of day d and fill at the open of day d + 1 + delay.
 */
export function runTrend(
  inputs: TrendSymbolInput[],
  paths: Record<string, RulePaths>,
  opts: SimOptions
): TrendRun {
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
        // Keep the weight the sleeve means to hold: a pending order's target
        // under a delay, otherwise the drifted weight at the close.
        const drifted = s.capital > 0 ? (s.qty * s.mark) / s.capital : 0;
        const intended = latestPending(s.pending) ?? drifted;
        s.capital = share;
        if (s.qty !== 0 || intended !== 0) s.pending.set(fillDay, intended);
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
 */
export function timingNull(
  inputs: TrendSymbolInput[],
  paths: Record<string, RulePaths>,
  twinReturns: readonly number[],
  observedAlpha: number,
  opts: SimOptions,
  range: { first: number; last: number },
  draws = 200,
  seed = 7
): { p: number; nullMean: number; draws: number } {
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
