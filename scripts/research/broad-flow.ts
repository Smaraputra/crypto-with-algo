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

/*
 * IMPLEMENTATION NOTES (build time, 2026-10-08, before any run; none changes a rule). The header above is
 * untouched. Code: this file (signals, the rank book, the nulls), trend-sim.ts SimOptions.reequaliseAt (the
 * container option), broad-flow-gates.ts (the eight gates), broad-flow-harness.ts (runBroadFlowStudy and the
 * CLI), report-schema.ts BroadFlowReportSchema (schema v3) and broad-flow-dsr.ts (gate 7). Inputs, contracts,
 * carried days, funding coverage, membership, costs, leaves and delistings are the broad trend phase's, unchanged
 * (broad-trend.ts implementation notes A3 to A5).
 *
 * F1. Volumes. A traded day is a bar with base volume v > 0 (AMENDMENT 1). Its buy volume is tbv and its sell
 *     volume v - tbv; both are KNOWN when tbv is a finite number with 0 <= tbv <= v. The day's flow is defined
 *     when both are known and positive. A traded day whose buy volume is unknown (tbv null, negative or above v)
 *     has no flow, and the week holding it has no flow either (its summed buy volume is unknown). The report
 *     counts such days.
 * F2. Daily periods. Period d is the bar opening at d, decided at the close d + 1 day. Its log return is
 *     ln(close_d / the previous traded day's close), which is the previous close on the contract's calendar (a
 *     carried close is the last real close); undefined at a contract's first bar. A carried day has no flow, so
 *     a member carried at the deciding bar is not ranked and its target for the period is 0.
 * F3. Weekly periods. The week of Friday F is the bars F - 6 days (Saturday) to F, decided at the close F + 1 day
 *     (Saturday 00:00). With fewer than 5 traded days, or a summed buy or sell volume of 0, it has no flow. A
 *     zero-volume side on one day does not void its week: the header's "holds nothing that day" is read as the
 *     daily rule, the weekly flow being "the same on the week's summed buy and sell volume". Its log return is
 *     ln(close of its last traded day / the previous week's last close), undefined in a contract's first week. A
 *     contract without a bar on F (ended before it, or listed after it) has no decision that week.
 * F4. Standardisation runs on a contract's own series (daily: its calendar days; weekly: its consecutive weeks);
 *     periods before its first bar count as undefined. The sd is over the defined values among the 30 periods
 *     ending at the current one; an sd that is not positive gives no signal. OF = of / sd, not demeaned, as
 *     written.
 * F5. Orthogonalisation. Its periods are the decision closes from the first one at or after the universe's start
 *     close (the sample's first period) to the last one before the sample end. A pair enters the fit when the
 *     contract's membership span covers the close (a contract delisting at that close included: it is a member)
 *     and its OF and log return are both defined. The fit is expanding pooled OLS with an intercept, accumulated
 *     with Welford co-moments, pairs in contract-id order; a period whose fit has fewer than 3 pairs or no return
 *     variance gives no signal. The residual OF - a - b x r is taken with that period's fit for EVERY contract
 *     with OF and log return defined there, member or not, so a contract's residual series covers its life from
 *     the sample's first period (the aligned null reads it there); before that period there is no fit and no
 *     residual, so a shift onto it holds nothing, as an undefined stretch did in the broad trend nulls (A4).
 * F6. Ranking. At each decision close the ranked members are those whose membership span covers the close, whose
 *     contract has not ended by it, and whose value is defined. A contract whose last bar is the deciding bar is
 *     delisted at that close by the container and cannot hold the period, so ranking it would leave a leg unheld.
 *     Values sort ascending, ties by contract id in code-unit order; the q lowest are short (-1), the q highest
 *     long (+1), the rest 0. Paths: that signal at the deciding bar and 0 at every other bar, size 1,
 *     'on-decision', and `defined` = 1 at a deciding bar where the contract is ranked. A weekly member joining at
 *     a ranking close inside a week therefore holds nothing until the next Saturday (its forced first decision
 *     reads a non-deciding bar).
 * F7. Re-equalisation (trend-sim.ts SimOptions.reequaliseAt, opt-in, a no-op when absent). At every decision
 *     close, after the container's ranking-close split when both fall on one close, the capital of the live
 *     sleeves (active, not leaving) is split equally across the RANKED members, the header's M, so the gross is
 *     2q / M of that capital as the header states; an unranked live member gets 0 and holds nothing. Cash (the
 *     shares of members whose contract ended before a ranking close, and delisting proceeds) stays cash until
 *     the next ranking close, as the header's "capital to cash until the next ranking close" says. At a weekly
 *     ranking close that is not a Saturday the broad container's monthly split across all members applies, with
 *     leaves and joins as there. Orders are sized on each sleeve's capital plus its overnight PnL at the fill,
 *     as in the container, so the book is exactly dollar-neutral at the fill when each open equals the previous
 *     close (the tests' data); real opens differ from closes by ticks, and a carried fill day defers one leg.
 * F8. Gate 1 and the sample. The sample's first day is the first day on which some sleeve holds a non-zero
 *     quantity after the day's fills. Every gated and reported statistic uses the days from it to 2026-06-30; the
 *     nulls, drops, stress runs and the delay take the same day indices. This header's gate 1 is the day count
 *     alone (the broad trend phase's "start later than 2021-07-01 fails by construction" is not restated), so the
 *     universe's start flag is reported, not gated.
 * F9. Gate 3. One stream per null, seed 7. Permuted: in each draw, decision closes in time order, the ranked
 *     members' values (contract-id order) are permuted by Fisher-Yates, then ranked; the ranked set and q are
 *     unchanged. Aligned: k = 365 + floor(u x (S - 729)) days with S = 2,373 for DO and D; k = 52 + floor(u x
 *     (S_w - 103)) weeks with S_w = 338 whole Saturday-to-Friday weeks (Friday 2020-01-10 to Friday 2026-06-26)
 *     for W and WO. A member's value for the period decided at bar b is its contract's value at the bar k days
 *     (or k Fridays) before b on the wrapping calendar; undefined, so not ranked, where the contract has no bar
 *     or no value there; then ranking as in F6. p = (1 + draws whose Sharpe is at or above the observed or is
 *     undefined) / (draws + 1): an undefined draw is no evidence against the null, so it counts against the
 *     rule. An undefined observed Sharpe gives p = 1 and runs no draw.
 * F10. Gate 4. A drop removes the contracts from the cross-section and from the container; the remaining members
 *     are re-ranked at every close with their values unchanged (the orthogonalisation keeps its full panel, as
 *     C3's state kept its full basket). Cohorts: listing years merged by the broad rule over member-days; the
 *     legends ten and BTC and ETH by asset key; the five contracts with the largest summed daily contribution to
 *     the book's return over the sample, ties by contract id (broad-gates.ts helpers).
 * F11. Gate 5. Calendar years 2021 to 2025 within the sample; a year without sample days counts as not positive.
 * F12. Gate 6. broad-harness.ts stressOptions: 1.5x the fee, stressBroad (2x every tier and the 10 bps leave
 *     slippage) and a 4% haircut; the re-equalisation option carries over. The reported 5% haircut is the same
 *     stress with a 5% haircut (the broad trend precedent, A5 gate 7).
 * F13. The one-period delay ranks each decision close on each member's value at the previous decision (the day,
 *     or the Friday, before), so the book holds every ranking one period late. The container's one-bar delay is
 *     not used: under re-equalisation it would split capital on one close's ranking and fill another's targets.
 * F14. Benchmarks: broad-harness.ts btcBenchmark and memberBasketBenchmark unchanged and run without
 *     re-equalisation; alpha (x 365) and beta of the book on each over the sample.
 * F15. Gate 7 (broad-flow-dsr.ts): legends-dsr.ts gate8FromStats with trial ids DO, W, WO, N = 3, the program
 *     count 1,732 beside, variance mode 'max-cross-sampling' (V = the larger of the three per-period Sharpes'
 *     sample variance and 1 / (T - 1), T the shortest series); a trial passes when its report reads
 *     'pending-trials' and its deflated probability is at least 0.95. D is refused.
 * F16. D, the control, runs through the same harness; its gates are computed for information, gate 7 does not
 *     apply and its verdict is 'control'.
 * F17. Counts. The CLI runs 2,000 bootstrap draws and 200 draws per null; the core takes lower counts for tests
 *     only, and every report records the counts it used.
 * F18. Reported block. "Gross, turnover, cost and funding per year" is reported both annualised over the sample
 *     and per calendar year. Net exposure is reported at each close (long minus short notional over equity) and
 *     just after each day's fills, where a daily book is neutral to rounding. Members, M and q are listed for
 *     every decision close.
 */

import { createSeededRandom } from '@/lib/stats/seeded-random';
import { buildBroadInputs, type BroadInputs, type BuildSource } from './broad-inputs';
import { segmentContracts, tradedDays, type Contract } from './broad-trend';
import type { PerpCandleRow } from './dataset-format';
import { DAY_MS, type RulePaths } from './trend-signals';
import {
  MIN_SHIFT_DAYS,
  NULL_CALENDAR_DAYS,
  NULL_CALENDAR_START,
  annualisedSharpe,
  barIndex,
  runTrend,
  spanAt,
  type SimOptions,
  type TrendRun,
  type TrendSymbolInput,
} from './trend-sim';

export type FlowRuleId = 'DO' | 'W' | 'WO' | 'D';
/** Header TRIALS AND LEDGER: three trials; the daily raw sort D is a control. */
export const FLOW_TRIAL_IDS = ['DO', 'W', 'WO'] as const;
export const FLOW_CONTROL_ID = 'D';
export const FLOW_RULE_IDS: readonly FlowRuleId[] = ['DO', 'W', 'WO', 'D'];

export type FlowFrequency = 'daily' | 'weekly';

export interface FlowRule {
  frequency: FlowFrequency;
  orthogonalised: boolean;
  trial: boolean;
}

export const FLOW_RULES: Readonly<Record<FlowRuleId, FlowRule>> = {
  DO: { frequency: 'daily', orthogonalised: true, trial: true },
  W: { frequency: 'weekly', orthogonalised: false, trial: true },
  WO: { frequency: 'weekly', orthogonalised: true, trial: true },
  D: { frequency: 'daily', orthogonalised: false, trial: false },
};

/** Header SIGNALS: 30 trailing periods, the current one included, at least 20 defined. */
export const STANDARDISE_WINDOW = 30;
export const STANDARDISE_MIN_DEFINED = 20;
/** Header SIGNALS: a week needs at least 5 traded days. */
export const WEEK_MIN_TRADED_DAYS = 5;
/** Header PORTFOLIO: quintiles, flat below q = 2. */
export const QUINTILES = 5;
export const MIN_QUINTILE = 2;
/** Implementation note F5: a fit needs at least 3 pairs. */
export const MIN_FIT_PAIRS = 3;
/** Header GATES 3 (b): weekly shifts of at least 52 whole weeks. */
export const MIN_SHIFT_WEEKS = 52;

const WEEK_MS = 7 * DAY_MS;

/** The bar opening on a Friday closes at Saturday 00:00 UTC, the weekly decision close. */
export function isFridayBar(t: number): boolean {
  return new Date(t).getUTCDay() === 5;
}

/** Saturday 00:00 UTC: a weekly decision close. */
export function isSaturdayClose(ms: number): boolean {
  return ms % DAY_MS === 0 && new Date(ms).getUTCDay() === 6;
}

/** The Friday bar of the Saturday-to-Friday week holding the bar opening on day `t`. */
export function weekFriday(t: number): number {
  const day = Math.floor(t / DAY_MS) * DAY_MS;
  return day + ((5 - new Date(day).getUTCDay() + 7) % 7) * DAY_MS;
}

/** Whole Saturday-to-Friday weeks of a day calendar, identified by their Friday bars. */
export interface WeekCalendar {
  firstFriday: number;
  weeks: number;
}

/** The whole weeks of the day calendar [start, start + days): its first Saturday to its last Friday. */
export function wholeWeeks(start: number, days: number): WeekCalendar {
  const last = start + (days - 1) * DAY_MS;
  let saturday = start;
  while (new Date(saturday).getUTCDay() !== 6) saturday += DAY_MS;
  const firstFriday = saturday + 6 * DAY_MS;
  let lastFriday = last;
  while (new Date(lastFriday).getUTCDay() !== 5) lastFriday -= DAY_MS;
  return { firstFriday, weeks: lastFriday >= firstFriday ? Math.round((lastFriday - firstFriday) / WEEK_MS) + 1 : 0 };
}

/** The day null calendar of gate 3 (2020-01-01 to 2026-06-30, S = 2,373) and its whole weeks (S_w = 338). */
export interface FlowCalendar {
  start: number;
  days: number;
  weeks: WeekCalendar;
}

export const FLOW_CALENDAR: FlowCalendar = {
  start: NULL_CALENDAR_START,
  days: NULL_CALENDAR_DAYS,
  weeks: wholeWeeks(NULL_CALENDAR_START, NULL_CALENDAR_DAYS),
};

export function flowCalendar(start: number, days: number): FlowCalendar {
  return { start, days, weeks: wholeWeeks(start, days) };
}

/*
 * SIGNALS (header): order flow, standardisation, orthogonalisation.
 */

/** One traded day's volumes and flow (header SIGNALS, notes F1 and F2). */
export interface DayFlow {
  /** Bar open time. */
  t: number;
  close: number;
  /** Taker-buy base volume; undefined when unknown (F1). */
  buy: number | undefined;
  /** Base volume minus the taker-buy base volume; undefined when unknown. */
  sell: number | undefined;
  /** ln(buy) - ln(sell); undefined when either is unknown or not positive. */
  of: number | undefined;
  /** ln(close / the previous traded day's close); undefined on the first traded day. */
  logReturn: number | undefined;
}

function knownBuy(row: PerpCandleRow): boolean {
  return row.tbv !== null && Number.isFinite(row.tbv) && row.tbv >= 0 && row.tbv <= row.v;
}

function logRatio(a: number | undefined, b: number | undefined): number | undefined {
  return a !== undefined && b !== undefined && a > 0 && b > 0 ? Math.log(a) - Math.log(b) : undefined;
}

/**
 * Header SIGNALS: of(d) = ln(buy volume of d) - ln(sell volume of d) on every traded day (v > 0, one row per
 * day, ascending), buy the taker-buy BASE volume and sell the base volume minus it. Undefined when tbv is null
 * or not in [0, v] (F1), or when either side is 0.
 */
export function dailyOrderFlow(rows: readonly PerpCandleRow[]): DayFlow[] {
  const traded = tradedDays([...rows]);
  return traded.map((row, k) => {
    const known = knownBuy(row);
    const buy = known ? (row.tbv as number) : undefined;
    const sell = known ? row.v - (row.tbv as number) : undefined;
    const previous = traded[k - 1];
    return {
      t: row.t,
      close: row.c,
      buy,
      sell,
      of: logRatio(buy, sell),
      logReturn: previous ? logRatio(row.c, previous.c) : undefined,
    };
  });
}

/** One Saturday-to-Friday week's volumes and flow (header SIGNALS, note F3). */
export interface WeekFlow {
  /** The week's Friday bar (open time); the decision close is one day later, Saturday 00:00 UTC. */
  friday: number;
  tradedDays: number;
  /** Summed buy and sell volume; undefined when a traded day's buy volume is unknown. */
  buy: number | undefined;
  sell: number | undefined;
  /** ln(summed buy) - ln(summed sell): needs at least 5 traded days and both sums positive. */
  of: number | undefined;
  /** Close of the week's last traded day (the last close before it in a week without one). */
  close: number;
  /** ln(close / the previous week's close); undefined in the first week. */
  logReturn: number | undefined;
}

/**
 * Header SIGNALS: weekly order flow on the summed buy and sell volume of each Saturday 00:00 to Friday 23:59 UTC
 * week, from the week of the first traded day to the week of the last, consecutive (a week without a traded day
 * included, at the last close). With the week's log return: its last traded day's close over the previous week's.
 */
export function weeklyOrderFlow(rows: readonly PerpCandleRow[]): WeekFlow[] {
  const days = dailyOrderFlow(rows);
  if (days.length === 0) return [];
  const out: WeekFlow[] = [];
  const last = weekFriday(days[days.length - 1].t);
  let j = 0;
  let close = days[0].close;
  for (let friday = weekFriday(days[0].t); friday <= last; friday += WEEK_MS) {
    let traded = 0;
    let buy = 0;
    let sell = 0;
    let known = true;
    while (j < days.length && days[j].t <= friday) {
      const day = days[j];
      traded++;
      if (day.buy === undefined || day.sell === undefined) known = false;
      else {
        buy += day.buy;
        sell += day.sell;
      }
      close = day.close;
      j++;
    }
    const previous = out[out.length - 1];
    out.push({
      friday,
      tradedDays: traded,
      buy: known ? buy : undefined,
      sell: known ? sell : undefined,
      of: known && traded >= WEEK_MIN_TRADED_DAYS ? logRatio(buy, sell) : undefined,
      close,
      logReturn: previous ? logRatio(close, previous.close) : undefined,
    });
  }
  return out;
}

function isDefined(x: number | undefined): x is number {
  return x !== undefined && Number.isFinite(x);
}

/**
 * Header SIGNALS: OF = of / sd(of over the trailing `window` periods, the current one included, undefined
 * periods skipped), with at least `minDefined` defined periods in the window, sd the sample standard deviation
 * (n - 1). The index is the calendar period (note F4). Undefined where of is, or the sd is not positive.
 */
export function standardise(
  series: ReadonlyArray<number | undefined>,
  window = STANDARDISE_WINDOW,
  minDefined = STANDARDISE_MIN_DEFINED
): Array<number | undefined> {
  return series.map((x, i) => {
    if (!isDefined(x)) return undefined;
    let n = 0;
    let mean = 0;
    let m2 = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = series[j];
      if (!isDefined(v)) continue;
      n++;
      const delta = v - mean;
      mean += delta / n;
      m2 += delta * (v - mean);
    }
    if (n < minDefined) return undefined;
    const sd = Math.sqrt(m2 / (n - 1));
    return sd > 0 && Number.isFinite(sd) ? x / sd : undefined;
  });
}

/** One contract at one period of the orthogonalisation panel. */
export interface PanelEntry {
  id: string;
  /** The standardised flow OF, the dependent variable. */
  of: number | undefined;
  /** The same period's log return, the regressor. */
  r: number | undefined;
  /** A member at the period's decision close: only members enter the fit. */
  member: boolean;
}

export interface OrthoFit {
  /** Pairs in the fit so far. */
  n: number;
  alpha: number;
  beta: number;
}

export interface OrthoResult {
  /** Per period: the residual of every entry with OF and r defined, by id (none when the fit is undefined). */
  residuals: Array<Map<string, number>>;
  /** Per period: the expanding fit after its pairs were added, or null when undefined. */
  fits: Array<OrthoFit | null>;
}

/**
 * Header SIGNALS (DO, WO): OF regressed on the same period's log return by one pooled OLS with an intercept over
 * every (member, period) pair from the first period up to and including the current one (an expanding window);
 * the signal is the current period's residual (note F5). Periods are in time order; nothing from a later period
 * is read.
 */
export function orthogonalise(panel: ReadonlyArray<ReadonlyArray<PanelEntry>>): OrthoResult {
  let n = 0;
  let mx = 0;
  let my = 0;
  let cxx = 0;
  let cxy = 0;
  const residuals: OrthoResult['residuals'] = [];
  const fits: OrthoResult['fits'] = [];
  for (const period of panel) {
    for (const e of period) {
      if (!e.member || !isDefined(e.of) || !isDefined(e.r)) continue;
      n++;
      const dx = e.r - mx;
      mx += dx / n;
      my += (e.of - my) / n;
      cxx += dx * (e.r - mx);
      cxy += dx * (e.of - my);
    }
    const fit = n >= MIN_FIT_PAIRS && cxx > 0 ? { n, beta: cxy / cxx, alpha: my - (cxy / cxx) * mx } : null;
    const out = new Map<string, number>();
    if (fit) {
      for (const e of period) {
        if (isDefined(e.of) && isDefined(e.r)) out.set(e.id, e.of - fit.alpha - fit.beta * e.r);
      }
    }
    residuals.push(out);
    fits.push(fit);
  }
  return { residuals, fits };
}

/** One period's quintile book. */
export interface QuintileBook {
  /** Members holding a defined value, ranked. */
  M: number;
  q: number;
  /** q < 2: the book holds nothing this period. */
  flat: boolean;
  /** Ranked ids, ascending by value then id. */
  ranked: string[];
  /** +1 (top q), -1 (bottom q) or 0, for every member given. */
  positions: Map<string, number>;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Header PORTFOLIO: rank the members holding a defined value, ties by contract id; q = floor(M / 5); flat with
 * q < 2; long the q highest (+1), short the q lowest (-1), 0 otherwise. A member without a value gets 0.
 */
export function quintileSignals(members: ReadonlyArray<{ id: string; value: number | undefined }>): QuintileBook {
  const ranked = members
    .filter((m) => isDefined(m.value))
    .sort((a, b) => (a.value as number) - (b.value as number) || byId(a.id, b.id));
  const M = ranked.length;
  const q = Math.floor(M / QUINTILES);
  const flat = q < MIN_QUINTILE;
  const positions = new Map<string, number>(members.map((m) => [m.id, 0]));
  if (!flat) {
    for (let k = 0; k < q; k++) {
      positions.set(ranked[k].id, -1);
      positions.set(ranked[M - 1 - k].id, 1);
    }
  }
  return { M, q, flat, ranked: ranked.map((m) => m.id), positions };
}

/*
 * INPUTS: the broad trend phase's inputs plus each member contract's traded bars, whose volumes the flow reads.
 */

export interface FlowInputs extends BroadInputs {
  /** Each universe member's traded bars (volume > 0, ascending), by contract id. */
  bars: Record<string, PerpCandleRow[]>;
}

/**
 * buildBroadInputs (contracts, membership, carried days, funding coverage, every check) plus each member's traded
 * bars from the same re-segmentation; a bar that is not a real day of its input's calendar stops here.
 */
export function buildFlowInputs(src: BuildSource): FlowInputs {
  const rowsBySymbol = new Map<string, PerpCandleRow[]>();
  const broad = buildBroadInputs({
    ...src,
    perp: (symbol) => {
      const loaded = src.perp(symbol);
      rowsBySymbol.set(symbol, loaded.rows);
      return loaded;
    },
  });
  const segments = new Map<string, Contract>();
  const symbolOf = new Map(broad.contracts.map((c) => [c.id, c.symbol]));
  const bars: Record<string, PerpCandleRow[]> = {};
  for (const input of broad.inputs) {
    const symbol = symbolOf.get(input.symbol);
    if (symbol === undefined) throw new Error(`${input.symbol}: no contract record`);
    if (!segments.has(input.symbol)) {
      for (const c of segmentContracts(symbol, rowsBySymbol.get(symbol) ?? [])) segments.set(c.id, c);
    }
    const contract = segments.get(input.symbol);
    if (!contract) throw new Error(`${input.symbol}: not found when re-segmenting ${symbol}`);
    let real = 0;
    for (let i = 0; i < input.t.length; i++) if (!(input.carried && input.carried[i] === 1)) real++;
    if (real !== contract.bars.length) throw new Error(`${input.symbol}: ${contract.bars.length} traded bars for ${real} real days`);
    for (const bar of contract.bars) {
      const i = barIndex(input, bar.t);
      if (i === -1 || (input.carried && input.carried[i] === 1)) {
        throw new Error(`${input.symbol}: traded bar ${new Date(bar.t).toISOString()} is not a real day of its calendar`);
      }
    }
    bars[input.symbol] = contract.bars;
  }
  return { ...broad, bars };
}

/** One contract's flow on its calendar (TrendSymbolInput.t), NaN where undefined, at its deciding bars. */
export interface ContractFlowSeries {
  /** of before standardisation. */
  raw: Float64Array;
  /** OF, standardised. */
  of: Float64Array;
  /** The period's log return. */
  r: Float64Array;
  /** Traded days whose buy volume is unknown (F1). */
  unknownDays: number;
}

const toNaN = (x: number | undefined): number => (isDefined(x) ? x : Number.NaN);

/** Daily: every bar is a deciding bar; weekly: the Friday bars (notes F2 to F4). */
export function contractFlowSeries(
  input: TrendSymbolInput,
  bars: readonly PerpCandleRow[],
  frequency: FlowFrequency
): ContractFlowSeries {
  const n = input.t.length;
  const raw = new Float64Array(n).fill(Number.NaN);
  const of = new Float64Array(n).fill(Number.NaN);
  const r = new Float64Array(n).fill(Number.NaN);
  const days = dailyOrderFlow(bars);
  const unknownDays = days.filter((d) => d.buy === undefined).length;
  if (frequency === 'daily') {
    const series: Array<number | undefined> = new Array(n).fill(undefined);
    for (const day of days) {
      const i = barIndex(input, day.t);
      if (i === -1) throw new Error(`${input.symbol}: traded day ${new Date(day.t).toISOString()} outside its calendar`);
      series[i] = day.of;
      raw[i] = toNaN(day.of);
      r[i] = toNaN(day.logReturn);
    }
    standardise(series).forEach((v, i) => (of[i] = toNaN(v)));
  } else {
    const weeks = weeklyOrderFlow(bars);
    const standardised = standardise(weeks.map((w) => w.of));
    weeks.forEach((w, k) => {
      const i = barIndex(input, w.friday);
      if (i === -1) return;
      raw[i] = toNaN(w.of);
      of[i] = toNaN(standardised[k]);
      r[i] = toNaN(w.logReturn);
    });
  }
  return { raw, of, r, unknownDays };
}

/*
 * THE RANK BOOK: decision closes, cross-sections, quintile paths for the broad container.
 */

/** Decision closes in [from, to): every 00:00 UTC close (daily) or every Saturday 00:00 UTC (weekly). */
export function decisionCloses(frequency: FlowFrequency, from: number, to: number): number[] {
  const out: number[] = [];
  let first = Math.ceil(from / DAY_MS) * DAY_MS;
  if (frequency === 'weekly') while (!isSaturdayClose(first)) first += DAY_MS;
  for (let x = first; x < to; x += frequency === 'daily' ? DAY_MS : WEEK_MS) out.push(x);
  return out;
}

/** The container option for a frequency: re-equalise at every decision close (note F7). */
export function reequaliseAt(frequency: FlowFrequency): (closeAt: number) => boolean {
  return frequency === 'daily' ? () => true : isSaturdayClose;
}

export interface ScheduleMember {
  /** Index into the inputs. */
  input: number;
  /** The deciding bar (the bar closing at the decision close), or -1. */
  bar: number;
}

export interface FlowSchedule {
  frequency: FlowFrequency;
  closes: number[];
  /** Per close, the members able to hold the period, in input order (note F6). */
  members: ScheduleMember[][];
}

/** Members whose span covers each decision close and whose contract has not ended by it (note F6). */
export function flowSchedule(
  inputs: readonly TrendSymbolInput[],
  frequency: FlowFrequency,
  from: number,
  to: number
): FlowSchedule {
  const closes = decisionCloses(frequency, from, to);
  const members = closes.map((close) => {
    const out: ScheduleMember[] = [];
    inputs.forEach((input, j) => {
      if (!spanAt(input.membership, close)) return;
      if (input.endDay !== undefined && input.endDay !== null && input.endDay < close) return;
      out.push({ input: j, bar: barIndex(input, close - DAY_MS) });
    });
    return out;
  });
  return { frequency, closes, members };
}

/** Each contract's value at its deciding bars (NaN where undefined), and the fit summary when orthogonalised. */
export interface FlowValues {
  values: Record<string, Float64Array>;
  series: Record<string, ContractFlowSeries>;
  /** Orthogonalised rules: each period's fit (null where undefined). */
  fits: Array<OrthoFit | null> | null;
}

/**
 * The rule's signal values per contract (header SIGNALS): OF for D and W; for DO and WO the residual of the
 * expanding pooled fit over the schedule's closes (note F5), for every contract with OF and return defined.
 */
export function flowValues(rule: FlowRuleId, inputs: readonly TrendSymbolInput[], bars: Readonly<Record<string, readonly PerpCandleRow[]>>, schedule: FlowSchedule): FlowValues {
  const spec = FLOW_RULES[rule];
  if (schedule.frequency !== spec.frequency) throw new Error(`${rule} is ${spec.frequency}; the schedule is ${schedule.frequency}`);
  const series: Record<string, ContractFlowSeries> = {};
  for (const input of inputs) {
    const b = bars[input.symbol];
    if (!b) throw new Error(`${input.symbol}: no traded bars`);
    series[input.symbol] = contractFlowSeries(input, b, spec.frequency);
  }
  if (!spec.orthogonalised) {
    return { values: Object.fromEntries(inputs.map((i) => [i.symbol, series[i.symbol].of])), series, fits: null };
  }
  const panel: PanelEntry[][] = schedule.closes.map((close) => {
    const period: PanelEntry[] = [];
    for (const input of inputs) {
      const i = barIndex(input, close - DAY_MS);
      if (i === -1) continue;
      const s = series[input.symbol];
      period.push({
        id: input.symbol,
        of: Number.isFinite(s.of[i]) ? s.of[i] : undefined,
        r: Number.isFinite(s.r[i]) ? s.r[i] : undefined,
        member: spanAt(input.membership, close) !== undefined,
      });
    }
    return period;
  });
  const { residuals, fits } = orthogonalise(panel);
  const values: Record<string, Float64Array> = Object.fromEntries(
    inputs.map((i) => [i.symbol, new Float64Array(i.t.length).fill(Number.NaN)])
  );
  const index = new Map(inputs.map((input) => [input.symbol, input]));
  schedule.closes.forEach((close, p) => {
    for (const [id, e] of residuals[p]) values[id][barIndex(index.get(id)!, close - DAY_MS)] = e;
  });
  return { values, series, fits };
}

/** One member's value at a deciding bar; undefined when it has none. */
export type ValueAt = (input: number, bar: number) => number | undefined;

/** The values as computed. */
export function plainValueAt(inputs: readonly TrendSymbolInput[], values: Readonly<Record<string, Float64Array>>): ValueAt {
  const arrays = inputs.map((i) => values[i.symbol]);
  return (j, bar) => {
    if (bar < 0) return undefined;
    const v = arrays[j][bar];
    return Number.isFinite(v) ? v : undefined;
  };
}

/** Note F13: the value at the previous decision, one day (daily) or one Friday (weekly) earlier. */
export function lagValueAt(inputs: readonly TrendSymbolInput[], values: Readonly<Record<string, Float64Array>>, frequency: FlowFrequency): ValueAt {
  const plain = plainValueAt(inputs, values);
  const step = frequency === 'daily' ? 1 : 7;
  return (j, bar) => (bar - step >= 0 ? plain(j, bar - step) : undefined);
}

/**
 * Note F9, the aligned null: the value at the deciding bar `bar` is the contract's value k days (daily) or k
 * whole weeks (weekly) earlier on the calendar that wraps from its last day (or week) back to its first; undefined
 * where the contract has no bar there. Throws for a deciding bar outside the calendar.
 */
export function alignedSource(input: TrendSymbolInput, bar: number, k: number, frequency: FlowFrequency, calendar: FlowCalendar): number {
  const day = input.t[bar];
  if (frequency === 'daily') {
    const c = Math.round((day - calendar.start) / DAY_MS);
    if (c < 0 || c >= calendar.days || calendar.start + c * DAY_MS !== day) {
      throw new Error(`${input.symbol}: bar ${new Date(day).toISOString()} lies outside the null calendar`);
    }
    return calendar.start + ((((c - k) % calendar.days) + calendar.days) % calendar.days) * DAY_MS;
  }
  const { firstFriday, weeks } = calendar.weeks;
  const w = Math.round((day - firstFriday) / WEEK_MS);
  if (w < 0 || w >= weeks || firstFriday + w * WEEK_MS !== day) {
    throw new Error(`${input.symbol}: bar ${new Date(day).toISOString()} is not a Friday of the null calendar's whole weeks`);
  }
  return firstFriday + ((((w - k) % weeks) + weeks) % weeks) * WEEK_MS;
}

export function alignedValueAt(
  inputs: readonly TrendSymbolInput[],
  values: Readonly<Record<string, Float64Array>>,
  frequency: FlowFrequency,
  k: number,
  calendar: FlowCalendar = FLOW_CALENDAR
): ValueAt {
  const plain = plainValueAt(inputs, values);
  return (j, bar) => {
    if (bar < 0) return undefined;
    const source = barIndex(inputs[j], alignedSource(inputs[j], bar, k, frequency, calendar));
    return source === -1 ? undefined : plain(j, source);
  };
}

/** One decision close's members and their values. */
export type Section = Array<{ id: string; value: number | undefined }>;

export function sectionsOf(schedule: FlowSchedule, inputs: readonly TrendSymbolInput[], valueAt: ValueAt): Section[] {
  return schedule.members.map((members) => members.map((m) => ({ id: inputs[m.input].symbol, value: valueAt(m.input, m.bar) })));
}

/**
 * Note F9, the permuted null: within each section (in order), the defined values are permuted by Fisher-Yates
 * across the members holding them (in their order); undefined members are untouched.
 */
export function permuteSections(sections: readonly Section[], random: () => number): Section[] {
  return sections.map((section) => {
    const slots: number[] = [];
    section.forEach((m, k) => {
      if (isDefined(m.value)) slots.push(k);
    });
    const vals = slots.map((k) => section[k].value as number);
    for (let a = vals.length - 1; a > 0; a--) {
      const b = Math.floor(random() * (a + 1));
      const tmp = vals[a];
      vals[a] = vals[b];
      vals[b] = tmp;
    }
    const out = section.map((m) => ({ ...m }));
    slots.forEach((k, s) => (out[k].value = vals[s]));
    return out;
  });
}

export interface FlowPeriod {
  close: number;
  /** Members able to hold the period (note F6). */
  members: number;
  /** M: members holding a defined value. */
  ranked: number;
  /** floor(M / 5); the book is flat when it is under 2. */
  q: number;
}

export interface FlowBook {
  paths: Record<string, RulePaths>;
  periods: FlowPeriod[];
}

/**
 * The quintile book's paths for the broad container (note F6): at each decision close the signal +1, -1 or 0 at
 * the deciding bar, `defined` where ranked; 0 elsewhere; size 1; 'on-decision'.
 */
export function rankBook(inputs: readonly TrendSymbolInput[], schedule: FlowSchedule, sections: readonly Section[]): FlowBook {
  if (sections.length !== schedule.closes.length) throw new Error('One section per decision close');
  const signal = inputs.map((i) => new Float64Array(i.t.length));
  const defined = inputs.map((i) => new Uint8Array(i.t.length));
  const periods: FlowPeriod[] = [];
  schedule.closes.forEach((close, p) => {
    const book = quintileSignals(sections[p]);
    const ranked = new Set(book.ranked);
    schedule.members[p].forEach((m, k) => {
      if (m.bar < 0) return;
      const id = sections[p][k].id;
      if (!ranked.has(id)) return;
      defined[m.input][m.bar] = 1;
      signal[m.input][m.bar] = book.positions.get(id) ?? 0;
    });
    periods.push({ close, members: schedule.members[p].length, ranked: book.M, q: book.q });
  });
  const decide = (input: TrendSymbolInput) =>
    schedule.frequency === 'daily' ? () => true : (i: number) => isFridayBar(input.t[i]);
  const paths: Record<string, RulePaths> = {};
  inputs.forEach((input, j) => {
    paths[input.symbol] = {
      signal: signal[j],
      size: new Float64Array(input.t.length).fill(1),
      decide: decide(input),
      rebalance: { kind: 'on-decision' },
      defined: defined[j],
    };
  });
  return { paths, periods };
}

/** The container's options for the book: `base` with re-equalisation at every decision close (note F7). */
export function flowSimOptions(base: SimOptions, frequency: FlowFrequency): SimOptions {
  return { ...base, reequaliseAt: reequaliseAt(frequency) };
}

/** Note F8: the index of the first day on which some sleeve holds a position after the fills (days.length if none). */
export function firstPositionIndex(run: TrendRun): number {
  const detail = run.broad;
  if (!detail) throw new Error('firstPositionIndex reads a broad run');
  for (let k = 0; k < run.days.length; k++) if (detail.openLong[k] > 0 || detail.openShort[k] > 0) return k;
  return run.days.length;
}

/** Annualised Sharpe of a run's returns over a day range. */
export function rangeSharpe(run: TrendRun, range: { first: number; last: number }): number {
  return annualisedSharpe(run.returns.slice(range.first, range.last + 1));
}

/*
 * GATE 3: the permuted and aligned nulls.
 */

export type FlowNullMode = 'permuted' | 'aligned';

export interface FlowNullContext {
  inputs: TrendSymbolInput[];
  schedule: FlowSchedule;
  values: Readonly<Record<string, Float64Array>>;
  /** The container options of the observed run (re-equalisation included). */
  opts: SimOptions;
  range: { first: number; last: number };
  calendar?: FlowCalendar;
}

export interface FlowNullResult {
  mode: FlowNullMode;
  /** (1 + draws at or above the observed, or undefined) / (draws + 1); 1 for an undefined observed Sharpe. */
  p: number;
  /** Mean of the defined draw Sharpes. */
  nullMean: number;
  draws: number;
  /** Draws whose Sharpe is undefined (counted against the rule). */
  undefinedDraws: number;
  /** 'aligned': each draw's shift, in days (daily) or weeks (weekly). */
  shifts?: number[];
  /** 'aligned': the mean over draws of the share of member-periods whose source lies outside the contract's bars. */
  outsideLifeShare?: number;
  /** The mean over draws of the share of member-periods holding no value (not ranked). */
  unrankedShare: number;
}

/** Note F9: k = min + floor(u x (S - 2 min + 1)), uniform on [min, S - min]. */
export function nullShift(frequency: FlowFrequency, u: number, calendar: FlowCalendar = FLOW_CALENDAR): number {
  const [min, size] = frequency === 'daily' ? [MIN_SHIFT_DAYS, calendar.days] : [MIN_SHIFT_WEEKS, calendar.weeks.weeks];
  if (size < 2 * min + 1) throw new Error(`A calendar of ${size} periods is too short for a shift of ${min}`);
  return min + Math.floor(u * (size - 2 * min + 1));
}

/**
 * Header gate 3's p (note F9): (1 + draws whose Sharpe is at or above the observed, or undefined) / (draws + 1);
 * the null mean over the defined draws. An undefined observed Sharpe gives p = 1.
 */
export function nullP(observed: number, drawSharpes: readonly number[]): { p: number; nullMean: number; undefinedDraws: number } {
  if (!Number.isFinite(observed)) return { p: 1, nullMean: Number.NaN, undefinedDraws: 0 };
  let atOrAbove = 0;
  let undefinedDraws = 0;
  let sum = 0;
  for (const s of drawSharpes) {
    if (!Number.isFinite(s)) {
      undefinedDraws++;
      atOrAbove++;
      continue;
    }
    sum += s;
    if (s >= observed) atOrAbove++;
  }
  const defined = drawSharpes.length - undefinedDraws;
  return { p: (1 + atOrAbove) / (drawSharpes.length + 1), nullMean: defined > 0 ? sum / defined : Number.NaN, undefinedDraws };
}

/** Share of member-periods holding no value. */
export function unrankedShare(sections: readonly Section[]): number {
  let members = 0;
  let unranked = 0;
  for (const s of sections) {
    members += s.length;
    unranked += s.filter((m) => !isDefined(m.value)).length;
  }
  return members > 0 ? unranked / members : Number.NaN;
}

/**
 * Header gate 3: `draws` re-runs of the book under one null (seed `seed`, one stream), each Sharpe over the
 * observed day range; p = (1 + draws at or above the observed, or undefined) / (draws + 1) (note F9). The
 * `onDraw` hook sees each draw's shift (aligned) and sections.
 */
export function flowNull(
  mode: FlowNullMode,
  ctx: FlowNullContext,
  observedSharpe: number,
  draws: number,
  seed: number,
  onDraw?: (draw: { k: number | null; sections: Section[] }) => void
): FlowNullResult {
  if (!Number.isFinite(observedSharpe)) return { mode, p: 1, nullMean: Number.NaN, draws: 0, undefinedDraws: 0, unrankedShare: Number.NaN };
  const calendar = ctx.calendar ?? FLOW_CALENDAR;
  const { inputs, schedule, values, opts, range } = ctx;
  const frequency = schedule.frequency;
  const random = createSeededRandom(seed);
  const plain = sectionsOf(schedule, inputs, plainValueAt(inputs, values));
  const shifts: number[] = [];
  const sharpes: number[] = [];
  let outside = 0;
  let unranked = 0;
  for (let draw = 0; draw < draws; draw++) {
    let sections: Section[];
    let k: number | null = null;
    if (mode === 'permuted') {
      sections = permuteSections(plain, random);
    } else {
      k = nullShift(frequency, random(), calendar);
      shifts.push(k);
      sections = sectionsOf(schedule, inputs, alignedValueAt(inputs, values, frequency, k, calendar));
      outside += outsideLife(schedule, inputs, k, calendar);
    }
    unranked += unrankedShare(sections);
    onDraw?.({ k, sections });
    const book = rankBook(inputs, schedule, sections);
    sharpes.push(rangeSharpe(runTrend(inputs, book.paths, opts), range));
  }
  const result: FlowNullResult = {
    mode,
    ...nullP(observedSharpe, sharpes),
    draws,
    unrankedShare: draws > 0 ? unranked / draws : Number.NaN,
  };
  if (mode === 'aligned') {
    result.shifts = shifts;
    result.outsideLifeShare = draws > 0 ? outside / draws : Number.NaN;
  }
  return result;
}

/** The share of member-periods (with a deciding bar) whose aligned source lies outside the contract's bars. */
export function outsideLife(schedule: FlowSchedule, inputs: readonly TrendSymbolInput[], k: number, calendar: FlowCalendar): number {
  let total = 0;
  let outside = 0;
  for (const members of schedule.members) {
    for (const m of members) {
      if (m.bar < 0) continue;
      total++;
      if (barIndex(inputs[m.input], alignedSource(inputs[m.input], m.bar, k, schedule.frequency, calendar)) === -1) outside++;
    }
  }
  return total > 0 ? outside / total : Number.NaN;
}
