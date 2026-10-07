/**
 * BROAD FLOW PHASE: daily and weekly cross-sectional order flow on the survivorship-free universe,
 * pre-registered, three trials, one run each.
 *
 * Why: the program never tested order flow in the cross-section at daily or weekly horizons. The one
 * published order-flow result that clears trading costs is cross-sectional: Anastasopoulos, Gradojevic, Liu,
 * Maynard, Tsiakas, "Order Flow and Cryptocurrency Returns" (EFMA 2025 version, Nov 2024; Journal of
 * Financial Markets 2026). Its Table 7, equal-weighted quintile sorts, 82 coins, 2020-02-18 to 2022-06-30,
 * top minus bottom:
 *
 *   daily, raw world order flow        -0.03% a day  (t -0.19)  Sharpe -0.12
 *   daily, flow orthogonalised          +0.29% a day  (t  2.11)  Sharpe  1.34
 *   weekly, raw world order flow        +1.61% a week (t  2.13)  Sharpe  1.68
 *   weekly, flow orthogonalised         +1.74% a week (t  2.28)  Sharpe  1.79
 *
 * Its panel is survivorship-conditioned (coins still trading in 2022), aggregated across 300 exchanges in
 * eleven fiat currencies, gross of costs, and 2.4 years long. This phase asks one question: does that effect
 * survive on Binance USDT-M perpetual taker flow, a survivorship-free point-in-time universe, perp prices,
 * real costs and funding, and a sample mostly after the paper's?
 *
 * Plan: ~/.claude/plans/next-data-tracks-2026-10-07.md (track T1), approved by the user on 2026-10-08.
 *
 * STATUS: LOCKED once committed, before the broad export (the broad trend phase's A6) is taken, so no
 * statistic of the data it reads can inform any rule below. Nothing below may change; a change means a new
 * pre-registration and new trials. Choices the text leaves open are recorded as implementation notes at build
 * time, before any run.
 *
 * TRIALS AND LEDGER
 *
 * - Three trials, never extended: DO (daily, orthogonalised), W (weekly, raw), WO (weekly, orthogonalised).
 *   The paper's daily raw sort is its own null result and is reported here as a control, not a trial.
 * - Program ledger: 1,729 after the broad trend phase; this phase adds 3, for 1,732.
 * - A pass is provisional: it gets the lockbox read once, under this container; passing that, it becomes a
 *   candidate for a forward paper record with its own pre-registration, power calculation and read rule. A
 *   fail closes daily and weekly cross-sectional taker flow on Binance USDT-M perpetuals.
 *
 * DATA AND UNIVERSE
 *
 * - Exactly the broad trend phase's export, contracts, universe file and lockbox (broad-trend.ts header,
 *   DATA, CANDIDATES, CONTRACTS, UNIVERSE, with AMENDMENT 1): the point-in-time top 50 crypto USDT-M
 *   perpetuals by trailing 30-day median quote volume, monthly, at least 366 daily bars, delisted included,
 *   the same sample (its first ranking close with at least 20 eligible contracts, to 2026-06-30).
 * - Buy volume of a contract on a day is the kline's taker-buy BASE volume; sell volume is the kline's total
 *   BASE volume minus it (quote volume is never used here).
 *   A day with zero volume is a missing day (AMENDMENT 1); a day whose buy or sell volume is zero has no order
 *   flow (log undefined) and holds nothing that day.
 *
 * SIGNALS (the paper's definitions on one venue)
 *
 * - Daily order flow: of(d) = ln(buy volume of day d) - ln(sell volume of day d).
 * - Weekly order flow: the same on the week's summed buy and sell volume. Weeks run Saturday 00:00 UTC to
 *   Friday 23:59 UTC, the paper's convention; a week needs at least 5 traded days, otherwise no signal.
 * - Standardised: OF = of / sd(of over the trailing 30 calendar periods of that frequency, the current one
 *   included, undefined periods skipped), so daily looks back 30 days and weekly 30 weeks; at least 20 defined
 *   periods in that window, otherwise no signal. sd is the sample standard deviation (n - 1).
 * - Orthogonalised (DO, WO): OF as the DEPENDENT variable, regressed on the same period's log return (the
 *   return of the period the flow was measured over, closing at the decision close), by one pooled OLS with an
 *   intercept over every (member, period) pair from the sample's first period up to and including the current
 *   one (an expanding window updated every period, the paper's footnote 18); the signal is the current
 *   period's residual. Both inputs are known at the decision close; no later information enters.
 *
 * PORTFOLIO
 *
 * - Decision: at the close that ends the period (00:00 UTC daily; 00:00 UTC Saturday weekly), rank the
 *   members holding a defined signal, ties by contract id. Quintile size q = floor(M / 5) with M the number
 *   ranked; with q < 2 (fewer than 10 ranked members) the book is flat for that period.
 * - Long the q highest, short the q lowest, equal weight, as the paper's equal-weighted quintiles rebalanced
 *   every period: capital is re-equalised across the period's members at EVERY decision close (not only at the
 *   monthly ranking close), each member's sleeve then holds +1 (long), -1 (short) or 0 of its equal share, so
 *   the book is exactly dollar-neutral at every decision and its gross is 2q / M of equity; it drifts only
 *   within a period. Sharpe is independent of that scale.
 * - Fills at the next open; holding until the next decision; a member that leaves the universe or delists is
 *   handled exactly as in the broad trend container (leave at the next open at 10 bps; delisting exit at the
 *   last close moved 2% against the position, plus the fee; capital to cash until the next ranking close).
 * - Costs: taker 0.05% on every unit of traded notional, slippage by rank tier (2 / 5 / 10 bps), funding on
 *   every settlement held (shorts receive positive funding).
 *
 * GATES (all must pass; statistics as in the broad trend phase unless stated)
 *
 * 1. Sample: at least 1,825 portfolio days from the first day the book holds a position.
 * 2. Expectancy: annualised Sharpe of daily book returns, block-bootstrap 95% CI low > 0 (circular blocks of
 *    60 days, 2,000 draws, seed 42; 20 and 120 reported).
 * 3. Timing, two nulls, BOTH p < 0.05, the larger p gating, 200 draws each, seed 7, p = (1 + draws with a
 *    Sharpe at or above the observed) / 201:
 *    (a) Permuted: in each draw, every period's signal values are permuted at random across that period's
 *        ranked members before ranking (destroys the cross-sectional link, keeps every other property).
 *    (b) Aligned: one shift k per draw applied to every contract's signal series on one calendar wrapping
 *        from 2026-06-30 back to 2020-01-01, a shifted period outside the contract's life having no signal
 *        (the broad trend phase's aligned null). DO shifts by k days, uniform on [365, S - 365] with S the
 *        calendar's days; W and WO shift by k whole weeks, uniform on [52, S_w - 52] with S_w the calendar's
 *        whole Saturday-to-Friday weeks, so week boundaries stay aligned.
 * 4. Cohorts: mean daily book return > 0 after dropping, one at a time, each listing-year cohort (merged as
 *    in the broad trend phase), the legends ten, BTC and ETH together, and the five contracts with the largest
 *    summed contribution to the book's return.
 * 5. Years: mean daily book return positive in at least 60% of 2021 (from the sample start) to 2025.
 * 6. Stress: mean daily book return > 0 at 1.5x fees, 2x every slippage tier and a 4% delisting haircut.
 * 7. Trials: deflated Sharpe probability >= 0.95 at N = 3 (this phase), V = the larger of the sample
 *    variance of the three per-period Sharpes and 1/(T - 1), T the shortest of the three daily series (with
 *    two degrees of freedom the sample variance is unstable, but taking the larger of it and the null floor
 *    can only raise the bar); reported, not gated, the same at the program count 1,732.
 * 8. After the paper: mean daily book return > 0 over 2022-07-01 to 2026-06-30, the period after the paper's
 *    sample.
 * Reported, not gated: the daily raw control, alpha against the equal-weight long of the members and against
 * BTCUSDT at 1x, net exposure per day (should be about 0), gross, turnover, cost and funding per year, the
 * long and short legs separately, the overlap with the paper's window (2021-03 to 2022-06), the one-period
 * delay, the 5% haircut, members and q per period.
 *
 * POWER (before any data is read)
 *
 * At T = 1,948 days the standard error of an annualised Sharpe is about 0.43. At N = 3 the expected maximum
 * under the null is about 0.43 x 0.85 = 0.37, so gate 7 needs an annualised Sharpe of about 0.37 + 1.645 x
 * 0.43 = 1.08 before skewness and kurtosis. The paper reports 1.34 to 1.79 gross on a survivor panel.
 *
 * PREDICTIONS (written before any data is read)
 *
 * | trial | annualised Sharpe after costs | expected first failing gates |
 * | --- | --- | --- |
 * | DO | -0.5 to +0.3 (daily turnover eats it) | 2, 7, 6 |
 * | W | 0.0 to +0.6 | 7, 2 |
 * | WO | 0.0 to +0.6 | 7, 2 |
 *
 * Expected verdict: nothing passes gate 7. The paper's effect leans on a survivor panel, cross-exchange flow
 * and the 2020-2022 bull market; one venue's perp taker flow after costs is a much harder test. The program's
 * earlier cross-sectional rank book (realised volatility, 2026-09-28) had a gross spread of about zero.
 *
 * Reviewed adversarially by agy on 2026-10-08 before the lock: the drift away from dollar-neutrality between
 * monthly re-equalisations, the weekly null's week alignment, the standardisation window, the regression's
 * direction and the base-volume definition were tightened in the text above. Not adopted: dropping the
 * cross-trial term from V, because max(cross-trial, floor) is never below the floor.
 */
export {};
