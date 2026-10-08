/**
 * EVENT STUDIES PHASE: forced deleveraging, funding extremes and volume shocks, pre-registered, one run.
 *
 * Why: the program measured open-interest change, OI-price divergence, funding and taker flow as LINEAR
 * factors (information coefficients over every bar) and none survived at 1h to 1d. A linear IC averages a
 * rare event over thousands of ordinary bars, so an effect that exists only around liquidation cascades,
 * funding extremes or volume shocks would be invisible there. This phase measures those events directly.
 * The literature gathered on 2026-10-07 expects small effects: post-liquidation continuation of about 1 bp
 * (Amberdata 2023, Binance ETHUSDT), jumps that persist rather than reverse (Scaillet, Treccani, Trevisan),
 * and toxicity measures that predict volatility, not direction (Easley, O'Hara, Yang, Zhang 2024).
 *
 * Plan: ~/.claude/plans/next-data-tracks-2026-10-07.md (track T2), approved by the user on 2026-10-08.
 *
 * STATUS: LOCKED once committed, before any event is computed. Nothing below may change; a change means a
 * new pre-registration and new trials. Choices the text leaves open are recorded as implementation notes at
 * build time, before any run.
 *
 * TRIALS AND LEDGER
 *
 * - Nine trials: three events (E1, E2, E3) x three horizons (1h, 4h, 24h), each a two-sided test, never
 *   extended. Program ledger: 1,732 after the broad flow phase; this phase adds 9, for 1,741.
 * - A cell that passes is provisional: it becomes the input of a rule family with its own pre-registration
 *   (and its own lockbox read). A phase with no passing cell closes these three event definitions.
 *
 * DATA
 *
 * - The ten symbols BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK (USDT-M perpetual), from production
 *   Mongo, exported to a fresh directory with every file hashed: 1h perp klines (open, close, base volume),
 *   5m futures metrics (open interest in contracts), and the archive's funding settlements.
 * - Hourly open interest is the last 5m value inside the hour; an hour without one has no OI change.
 * - Sample: events from 2022-07-01 (after a 180-day warmup from the 2022-01-01 start of the 1h perp series)
 *   to 2026-06-30. Lockbox: nothing from 2026-07-01 onward is read; a horizon that would reach past
 *   2026-06-30 drops its event.
 * - A missing or zero-volume hour is not an event hour and breaks no threshold; a horizon that crosses a
 *   missing hour drops its event.
 *
 * EVENTS (per symbol, decided at the close of hour h; every threshold is a percentile over that symbol's
 * non-missing hours among h - 4,320 to h - 1, the trailing 180 days, so nothing at or after h sets it; with
 * fewer than 2,000 non-missing hours in that window there is no event at h)
 *
 * - E1, forced deleveraging: the hour's log change in open interest is at or below its trailing 2nd percentile
 *   AND the hour's |log return| is at or above its trailing 98th percentile. Direction d = sign(return of h).
 * - E2, funding extreme: at a settlement, the rate is at or above the trailing 99th percentile of that symbol's
 *   settlement rates over the previous 180 days (crowded longs, d = +1) or at or below the 1st percentile
 *   (crowded shorts, d = -1), at least 300 earlier settlements in that window. The event hour h is the hour
 *   whose close is the settlement; because acting at the settlement instant assumes no latency, E2 enters one
 *   hour later, at the open of hour h + 2, and its horizon counts from there.
 * - E3, volume shock: the hour's base volume is at or above its trailing 99th percentile. Direction
 *   d = sign(return of h).
 * - De-overlap, chronological and greedy, per horizon H: walking forward in time, an event of the same type on
 *   the same symbol whose entry falls inside a kept event's forward window is dropped, so no two kept events
 *   of a cell share a forward window on one symbol.
 *
 * MEASUREMENT (per cell: event x horizon H in {1, 4, 24})
 *
 * - Forward return: log(close of hour h + H / open of hour h + 1), the trade a taker could take at the next
 *   open, signed by d (positive = the event direction continued; for E2 positive = price moved the way the
 *   crowd was positioned).
 * - Gross statistic: the mean signed forward return over kept events, with a 95% CI from a circular block
 *   bootstrap over UTC days (blocks of 7 consecutive days; every event entering on a resampled day is drawn,
 *   across symbols; 2,000 draws, seed 42), and a two-sided p-value from the same draws recentred at zero:
 *   p = (1 + draws with |bootstrap mean - observed mean| >= |observed mean|) / 2,001.
 * - Net: with s fixed BEFORE any data by the event's predicted direction (E1 s = +1, continuation; E2 s = -1,
 *   against the crowd; E3 s = -1, reversal), each event's net return = s x (its signed forward return) - 0.16% (taker 0.05% both legs plus 3 bps slippage
 *   both legs, the study's 1h cost) - the funding that position pays over the hold (archive settlements in
 *   (open of h + 1, close of h + H], signed by the position's side). The net statistic is the mean of those,
 *   with the same day-clustered bootstrap.
 *
 * GATES PER CELL (all must pass)
 *
 * 1. Significance: Benjamini-Yekutieli at a false discovery rate of 0.10 across the nine two-sided p-values
 *    (valid under any dependence; the nine cells share events across horizons).
 * 2. Pays: the net mean's bootstrap 95% CI low > 0.
 * 3. Breadth: the gross mean has the sign of s in at least 6 of the 10 symbols (symbols with fewer than 10
 *    kept events count as disagreeing).
 * 4. Time: the gross mean has the sign of s in at least 3 of the 4 years 2022H2 + 2023, 2024, 2025, 2026H1
 *    (2022H2 and 2023 pooled as one period).
 * 5. Sample: at least 100 kept events over at least 60 distinct days.
 * Reported, not gated, per cell: counts by symbol and year, the gross mean at 2x cost, median signed return,
 * hit rate, the share of events inside the largest 10 event days, and the result with E1's thresholds at
 * 1st and 99th percentiles instead of 2nd and 98th.
 *
 * VOLATILITY (reported, not gated; the evidence for a market-stress read in the product)
 *
 * - For every kept event at H = 24: realised volatility over the next 24 hours (sum of squared hourly log
 *   returns) divided by its trailing 30-day hourly mean scaled to 24 hours; its median and 95% CI per event.
 * - A stress flag = any E1 or E3 event on any of the ten symbols in the last 24 hours; its AUC for the next
 *   24 hours' BTCUSDT realised volatility landing in its trailing 180-day top quintile, fitted on nothing (the
 *   flag has no parameters), measured over 2024-07-01 to 2026-06-30 as balanced accuracy (the mean of its hit
 *   rate on top-quintile days and its true-negative rate on the rest; a binary flag has no richer AUC). The
 *   product read ships only if that balanced accuracy is at least 0.60 and the volatility ratio after E1 or
 *   E3 is above 1 with a CI excluding 1.
 *
 * PREDICTIONS (written before any event is computed)
 *
 * - E1: small continuation at 1h (gross +0.02% to +0.10%), nothing at 4h and 24h; no cell pays.
 * - E2: small reversal (price moves against the crowd) at 24h, gross under 0.3%; does not pay or fails time.
 * - E3: reversal at 1h from the bounce, small; no cell pays.
 * - Volatility: ratio after E1 and E3 between 1.3 and 2.0; stress-flag balanced accuracy 0.58 to 0.66.
 * - Expected verdict: no directional cell passes; the volatility read passes its product criterion.
 *
 * Reviewed adversarially by agy on 2026-10-08 before the lock: the net gate's direction is now fixed in advance
 * (it was the sign of the same sample's gross mean, a bias toward passing), the bootstrap uses 7-day blocks,
 * the p-value is recentred, de-overlap and percentile windows are mechanical, multiple testing is
 * Benjamini-Yekutieli, E2 enters an hour after the settlement, and the stress flag is judged on balanced
 * accuracy.
 *
 * AMENDMENT 1 (2026-10-08, before any real data was loaded or any event computed)
 *
 * Building the harness on synthetic data exposed two definitions that would have measured something other
 * than what they name. Each change supersedes the line it names; trials, gates and predictions otherwise
 * stand.
 *
 * - E2 thresholds are STRICT: the rate must be strictly above the trailing 99th percentile (crowded longs) or
 *   strictly below the 1st (crowded shorts). Binance funding sits at exactly 0.0100% for long stretches, so
 *   in a window where that base rate fills more than 1% of the tail the 99th percentile equals it and "at or
 *   above" would mark ordinary base-rate settlements as crowded. Supersedes "at or above ... or at or below"
 *   in the E2 bullet.
 * - The stress flag is MARKET-WIDE: an E1 event on any of the ten symbols, or E3 events on at least 3 of the
 *   ten symbols in the same hour, within the last 24 hours. As written (any E1 or E3 on any symbol), E3's 1%
 *   per-symbol hourly rate alone flags about 91% of days under independence, so the flag would be on almost
 *   always and its balanced accuracy pinned near 0.5 whatever the market did. Supersedes "a stress flag = any
 *   E1 or E3 event on any of the ten symbols in the last 24 hours".
 */

/**
 * IMPLEMENTATION NOTES (recorded 2026-10-08 at build time, before any run; built and tested on synthetic
 * panels only, no event computed on real data). Each settles a choice the locked text above leaves open,
 * taking the conservative reading where there is one.
 *
 * 1. A missing hour has no 1h kline row, a base volume not > 0, or an open or close that is not a positive
 *    finite number.
 * 2. "The hour's log return" is the bar's own log(close / open), so a missing neighbour never undefines it;
 *    the realised volatility sums the same per-bar returns. The forward return is the header's
 *    log(close of the last horizon hour / open of the entry hour).
 * 3. Hourly OI is the last finite, positive openInterest among the 5m rows stamped inside
 *    [hour open, hour open + 1h): read at or before the close, as factors.ts reads metrics, but never carried
 *    forward from an earlier hour (factors.ts allows a staleness window; this study does not). The log OI
 *    change at h needs OI at both h and h - 1 and h itself non-missing.
 * 4. Percentile: linear interpolation between order statistics at index p (n - 1) (type 7, as
 *    block-bootstrap.ts), returning the order statistic itself when both neighbours are equal, so a value
 *    tied with its threshold compares exactly. "At or above" and "at or below" are inclusive.
 * 5. The 2,000-hour floor counts the non-missing values of the series the threshold is taken over. E1 needs
 *    both of its series (OI change and |return|) to meet it, so the OI-change series binds.
 * 6. E2: the window is the finite settlement rates stamped in [t - 180 days, t). A rate that is both at or
 *    above the 99th and at or below the 1st percentile (a window of equal rates) has no direction and is no
 *    event. The event hour must itself be non-missing (a missing hour is not an event hour); the latency hour
 *    h + 1 lies outside the horizon and is not required.
 * 7. Sample membership is by the event hour's open, in [2022-07-01, 2026-07-01). An E1 or E3 event whose
 *    hour return is exactly 0 has no direction and enters no cell (it is counted); it still counts for the
 *    stress flag, which has no direction.
 * 8. Lockbox: an event whose hold would end at or after 2026-07-01 00:00 (the close of its last hour) is
 *    dropped, so no settlement stamped inside the lockbox is ever needed. In effect the 23:00 hour of
 *    2026-06-30 never ends a horizon.
 * 9. Drops are applied in the order: no direction, beyond the sample, a missing hour in the horizon, then
 *    de-overlap. Only kept events block: an event dropped for a missing hour or the lockbox never suppresses
 *    a later one. De-overlap drops an event whose entry hour lies in [e, e + H - 1] for the entry e of the
 *    last kept event of the same symbol, type and horizon.
 * 10. Funding: settlements stamped in (open of the entry hour, close of the last horizon hour]; the position
 *     is p = s x d (+1 long, -1 short) and pays p x rate at each. The cost is
 *     2 x BINANCE_FUTURES_TAKER_FEE + 2 x STUDY_SLIPPAGE_BPS['1h'] / 10,000 = 0.16%.
 * 11. Bootstrap calendar: every UTC day from 2022-07-01 to 2026-06-30 (1,461 days); an event sits on the UTC
 *     day of its entry open. A draw takes ceil(1,461 / 7) = 209 uniform block starts of 7 consecutive days,
 *     wrapping from the last day to the first, truncated to 1,461 days. Each cell (and each volatility
 *     median) starts a fresh generator at seed 42, so all of them see the same day resamples. The CI is the
 *     2.5th and 97.5th percentile (note 4) of the finite draws. A draw holding no event has no mean: it is
 *     left out of the CI and counted as an exceedance in the p-value, which raises p.
 * 12. Gate 3: a symbol agrees when it has at least 10 kept events and s x its mean signed gross return is
 *     strictly > 0; the denominator is the ten symbols, so a symbol without data disagrees. Gate 4: periods
 *     by entry time; a period with no kept event, or a mean of exactly 0, disagrees. Gate 5 counts distinct
 *     UTC entry days.
 * 13. Reported block: "the gross mean at 2x cost" is read as the net mean with the cost doubled to 0.32%
 *     (funding included); the median is of the d-signed gross return; the hit rate is the share with
 *     s x signed return > 0; the 10 largest event days rank days by kept-event count, ties to the earlier
 *     day; counts by year use the entry's UTC calendar year. The E1 1st/99th sensitivity reports statistics,
 *     not gates: Benjamini-Yekutieli covers the nine primary cells only.
 * 14. Volatility ratio: the next 24 hours are the kept H = 24 event's horizon (entry hour to entry + 23); the
 *     denominator is 24 x the mean squared hourly log return over the non-missing hours among h - 720 to
 *     h - 1 (30 days, excluding the event hour as the thresholds do), at least 360 of them, else the event
 *     is left out and counted. "After E1 or E3" pools the kept H = 24 E1 and E3 events, one per (symbol,
 *     event hour). Its CI is the day bootstrap of the median.
 * 15. Stress flag, once per UTC day D from 2024-07-01 to 2026-06-30: flagged when any detected E1 or E3
 *     (primary thresholds, before horizon drops and de-overlap, any direction) on any of the ten symbols has
 *     its event-hour close in (D - 24h, D]. Top quintile: BTCUSDT's realised variance over D's 24 hours (all
 *     24 non-missing) at or above the 80th percentile (note 4) of the defined daily values of D - 180 to
 *     D - 1, at least 90 of them; a day lacking either is skipped and counted. Balanced accuracy is
 *     undefined, and the product criterion fails, when either class is empty.
 * 16. Product criterion: balanced accuracy >= 0.60, and the pooled E1/E3 median ratio > 1 with its CI low
 *     > 1.
 */

/*
 * RESULT, 2026-10-08 (the one run). Export `a93d2d26403c` (ten symbols: 1h perp klines, 5m metrics, funding
 * settlements, lockbox applied), image from `ab67970`, events 2022-07-01 to 2026-06-30, report
 * `events/out/event-studies.json`. Reproduced on a second machine from the hash-verified export: every count,
 * gate and verdict identical, floats within 2.8e-15 relative (Node 24 against the image's Node 22).
 *
 *   Detected: E1 1,503, E2 1,431 (none at threshold, which AMENDMENT 1's strict comparison makes structural),
 *   E3 3,851, E1 at 1st/99th 699.
 *
 *   cell     n      days  gross mean (95% CI)          p       net mean (95% CI)            failed gates
 *   E1 1h    1,503  456   -0.079% [-0.257%, +0.094%]   0.394   -0.238% [-0.416%, -0.066%]   1, 2, 3, 4
 *   E1 4h    1,354  456   -0.051% [-0.352%, +0.222%]   0.730   -0.211% [-0.510%, +0.062%]   1, 2, 3, 4
 *   E1 24h   1,160  440   -0.262% [-0.662%, +0.182%]   0.232   -0.399% [-0.799%, +0.042%]   1, 2, 3, 4
 *   E2 1h    1,431  433   -0.063% [-0.195%, +0.080%]   0.369   -0.090% [-0.226%, +0.041%]   1, 2, 4
 *   E2 4h    1,429  433   -0.170% [-0.411%, +0.058%]   0.167   +0.021% [-0.206%, +0.267%]   1, 2, 4
 *   E2 24h   922    414   -0.173% [-0.661%, +0.373%]   0.527   +0.093% [-0.444%, +0.570%]   1, 2
 *   E3 1h    3,846  673   +0.023% [-0.083%, +0.137%]   0.686   -0.183% [-0.296%, -0.078%]   1, 2, 3, 4
 *   E3 4h    2,513  672   +0.153% [-0.079%, +0.389%]   0.200   -0.318% [-0.552%, -0.092%]   1, 2, 3, 4
 *   E3 24h   1,711  629   -0.093% [-0.496%, +0.339%]   0.654   -0.058% [-0.487%, +0.345%]   1, 2, 3
 *
 *   Gross is signed by the event direction d (positive = it continued); net by the pre-set side s. No p-value
 *   is rejected by Benjamini-Yekutieli; no net CI clears zero, and three sit wholly below it (E1 1h, E3 1h and
 *   4h: the cost of trading an event). E1 at the 1st/99th thresholds reads the same (-0.127%, -0.145%, -0.509%
 *   gross, p 0.13 to 0.53).
 *
 *   VOLATILITY (the product read). Median next-24h realised variance over its trailing mean: E1 1.21 [1.04,
 *   1.38], E2 1.02 [0.87, 1.24], E3 1.31 [1.18, 1.53], pooled E1/E3 1.29 [1.14, 1.45] over 2,550 events. Stress
 *   flag on BTCUSDT, 2024-07-01 to 2026-06-30: 729 days (1 skipped), 145 top-quintile, 249 flagged, hit rate
 *   0.566, true-negative rate 0.714, balanced accuracy 0.640. PRODUCT CRITERION MET (0.640 >= 0.60, ratio CI
 *   low 1.14 > 1).
 *
 *   Post-hoc context, computed after the run and outside the pre-registration (no gate, no verdict): a flag
 *   that only says "yesterday's BTCUSDT realised variance was in its own trailing top quintile" reads 0.643 on
 *   the same 728 days (hit 0.428, true-negative 0.858), and flagging when either fires reads 0.658. The event
 *   flag predicts the next day's volatility about as well as volatility persistence does, and adds little to it.
 *
 *   Predictions: right that no directional cell passes and that the volatility read meets its criterion; right
 *   for E2 (24h gross -0.17%, against the crowd and under 0.3%, not paying) and for the balanced accuracy (0.64
 *   inside 0.58 to 0.66); wrong for E1 at 1h (predicted +0.02% to +0.10% continuation, read -0.08%, p 0.39) and
 *   for E3 at 1h (predicted a reversal, read +0.02%, p 0.69); the pooled ratio 1.29 sits just under the
 *   predicted 1.3 to 2.0.
 *
 * PHASE VERDICT. NO CELL PASSES. E1 (forced deleveraging), E2 (funding extremes) and E3 (volume shocks), as
 * defined here, are CLOSED for direction at 1h to 24h. Program trial ledger: 1,741. What stands is a
 * volatility reading, not a trade: after these events the next day is about 1.3 times as volatile as usual.
 */

import { BINANCE_FUTURES_TAKER_FEE, STUDY_SLIPPAGE_BPS } from '@/lib/backtest/cost-model';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { LOCKBOX_START, type FundingRow, type MetricsRow, type PerpCandleRow } from './dataset-format';
import { benjaminiYekutieli } from './ic-stats';
import type {
  EventCell,
  EventCellStatsJson,
  EventDetected,
  EventGate,
  EventGroupMean,
  EventRatioStat,
  EventStress,
  EventStudyReport,
} from './report-schema';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** The ten symbols the header names, fixed here so a later change to SIGNAL_SYMBOLS cannot move them. */
export const EVENT_SYMBOLS = [
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

export const EVENT_TYPES = ['E1', 'E2', 'E3'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const HORIZONS = [1, 4, 24] as const;

/** s, fixed before any data by each event's predicted direction: continuation, against the crowd, reversal. */
export const EVENT_SIDE: Record<EventType, 1 | -1> = { E1: 1, E2: -1, E3: -1 };

export const TRAILING_HOURS = 4_320;
export const MIN_TRAILING_HOURS = 2_000;
export const SETTLEMENT_WINDOW_DAYS = 180;
export const MIN_SETTLEMENTS = 300;
export const E1_PRIMARY = { oi: 0.02, absReturn: 0.98 } as const;
export const E1_SENSITIVITY = { oi: 0.01, absReturn: 0.99 } as const;
export const E2_HIGH = 0.99;
export const E2_LOW = 0.01;
export const E3_HIGH = 0.99;

/** Taker 0.05% both legs plus 3 bps slippage both legs: 0.16% a round trip (note 10). */
export const ROUND_TRIP_COST = 2 * BINANCE_FUTURES_TAKER_FEE + (2 * STUDY_SLIPPAGE_BPS['1h']) / 10_000;

export const FDR_Q = 0.1;
export const TRIALS = 9;
export const LEDGER_BEFORE = 1_732;
export const LEDGER_AFTER = 1_741;

export interface BootstrapOptions {
  draws: number;
  seed: number;
  blockDays: number;
}
export const BOOTSTRAP: BootstrapOptions = { draws: 2_000, seed: 42, blockDays: 7 };

export const GATE_THRESHOLDS = {
  breadthSymbols: 6,
  breadthMinEvents: 10,
  timePeriods: 3,
  sampleEvents: 100,
  sampleDays: 60,
} as const;

export const VOL_HORIZON = 24;
export const VOL_TRAILING_HOURS = 720;
export const VOL_MIN_TRAILING_HOURS = 360;
export const STRESS_SYMBOL = 'BTCUSDT';
export const STRESS_QUANTILE = 0.8;
export const STRESS_TRAILING_DAYS = 180;
export const STRESS_MIN_TRAILING_DAYS = 90;
export const MIN_BALANCED_ACCURACY = 0.6;

export interface EventPeriod {
  label: string;
  from: number;
  /** Exclusive. */
  to: number;
}

/**
 * Everything date-bound in the study. The CLI always runs PREREGISTERED_CONFIG; tests pass a shorter one so
 * a synthetic panel does not have to span four years.
 */
export interface EventStudyConfig {
  symbols: readonly string[];
  sampleStart: number;
  /** Exclusive: the lockbox start. */
  sampleEnd: number;
  periods: readonly EventPeriod[];
  /** First UTC day the stress flag is evaluated on. */
  stressFrom: number;
  /** Exclusive. */
  stressTo: number;
}

export const PREREGISTERED_CONFIG: EventStudyConfig = {
  symbols: EVENT_SYMBOLS,
  sampleStart: Date.UTC(2022, 6, 1),
  sampleEnd: LOCKBOX_START,
  periods: [
    { label: '2022H2+2023', from: Date.UTC(2022, 6, 1), to: Date.UTC(2024, 0, 1) },
    { label: '2024', from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1) },
    { label: '2025', from: Date.UTC(2025, 0, 1), to: Date.UTC(2026, 0, 1) },
    { label: '2026H1', from: Date.UTC(2026, 0, 1), to: LOCKBOX_START },
  ],
  stressFrom: Date.UTC(2024, 6, 1),
  stressTo: LOCKBOX_START,
};

/**
 * The first hour any computation reads: the 4,320-hour window of the first sample hour, plus the hour before
 * it that the window's first OI change needs.
 */
export function gridStartOf(config: Pick<EventStudyConfig, 'sampleStart'>): number {
  return config.sampleStart - (TRAILING_HOURS + 1) * HOUR_MS;
}

const fin = (x: number): number | null => (Number.isFinite(x) ? x : null);
const sgn = (x: number): -1 | 0 | 1 => (x > 0 ? 1 : x < 0 ? -1 : 0);

function meanOf(xs: ArrayLike<number>): number {
  if (xs.length === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[i];
  return sum / xs.length;
}

/**
 * Type 7 percentile of the first n entries of an ascending array (note 4). When the two order statistics
 * around the index are equal it returns that value exactly, so a tie with the threshold compares as a tie.
 */
export function quantileSorted(sorted: ArrayLike<number>, n: number, p: number): number {
  if (n <= 0) return Number.NaN;
  const index = p * (n - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const a = sorted[lo];
  const b = sorted[hi];
  if (lo === hi || a === b) return a;
  return a + (index - lo) * (b - a);
}

export function medianOf(xs: readonly number[]): number {
  const sorted = Float64Array.from(xs).sort();
  return quantileSorted(sorted, sorted.length, 0.5);
}

/** First index whose value is strictly greater than x, in an ascending array. */
function upperBound(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A bounded multiset kept in ascending order, for trailing percentiles in O(window) per step. */
export class SortedWindow {
  private readonly buf: Float64Array;
  private len = 0;

  constructor(capacity: number) {
    this.buf = new Float64Array(Math.max(1, capacity));
  }

  get size(): number {
    return this.len;
  }

  private lowerBound(x: number): number {
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.buf[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  insert(x: number): void {
    if (this.len >= this.buf.length) throw new Error('SortedWindow: capacity exceeded');
    const i = this.lowerBound(x);
    this.buf.copyWithin(i + 1, i, this.len);
    this.buf[i] = x;
    this.len++;
  }

  remove(x: number): void {
    const i = this.lowerBound(x);
    if (i >= this.len || this.buf[i] !== x) throw new Error(`SortedWindow: ${x} is not in the window`);
    this.buf.copyWithin(i, i + 1, this.len);
    this.len--;
  }

  quantile(p: number): number {
    return quantileSorted(this.buf, this.len, p);
  }
}

/**
 * One symbol's hourly series on a fixed hour grid, with NaN wherever an hour is missing (note 1), plus the
 * prefix sums the horizon checks, the funding sums and the volatility denominator read.
 */
export interface HourlyPanel {
  symbol: string;
  /** Open time of hour index 0, ms UTC, hour-aligned. */
  start: number;
  n: number;
  open: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  valid: Uint8Array;
  ret: Float64Array;
  absRet: Float64Array;
  /** Last OI inside the hour, NaN when the hour has none. */
  oi: Float64Array;
  oiChange: Float64Array;
  /** invalidBefore[k] = missing hours among 0 .. k - 1. */
  invalidBefore: Int32Array;
  /** Prefix sums of squared hourly log returns and of their count, over non-missing hours. */
  sqCum: Float64Array;
  sqCount: Int32Array;
  settlementTimes: Float64Array;
  settlementRates: Float64Array;
  /** rateCum[j] = sum of the first j settlement rates. */
  rateCum: Float64Array;
}

export type KlineInput = Pick<PerpCandleRow, 't' | 'o' | 'c' | 'v'>;
export type MetricsInput = Pick<MetricsRow, 't' | 'openInterest'>;
export type FundingInput = Pick<FundingRow, 't' | 'rate'>;

/**
 * Builds the hourly panel for hours [gridStart, gridEnd). Rows outside it are ignored, so nothing at or after
 * gridEnd (the lockbox start, in the study) is read even when a caller passes it.
 */
export function buildHourlyPanel(
  symbol: string,
  klines: readonly KlineInput[],
  metrics: readonly MetricsInput[],
  funding: readonly FundingInput[],
  gridStart: number,
  gridEnd: number
): HourlyPanel {
  if (gridStart % HOUR_MS !== 0 || gridEnd % HOUR_MS !== 0 || gridEnd <= gridStart) {
    throw new Error(`${symbol}: the hour grid [${gridStart}, ${gridEnd}) is not hour-aligned and non-empty`);
  }
  const n = (gridEnd - gridStart) / HOUR_MS;
  const open = new Float64Array(n).fill(Number.NaN);
  const close = new Float64Array(n).fill(Number.NaN);
  const volume = new Float64Array(n).fill(Number.NaN);
  const valid = new Uint8Array(n);

  for (const k of klines) {
    if (k.t < gridStart || k.t >= gridEnd) continue;
    const offset = k.t - gridStart;
    if (offset % HOUR_MS !== 0) throw new Error(`${symbol}: kline at ${k.t} is not on the hour grid`);
    const h = offset / HOUR_MS;
    const ok = Number.isFinite(k.o) && Number.isFinite(k.c) && Number.isFinite(k.v) && k.o > 0 && k.c > 0 && k.v > 0;
    open[h] = ok ? k.o : Number.NaN;
    close[h] = ok ? k.c : Number.NaN;
    volume[h] = ok ? k.v : Number.NaN;
    valid[h] = ok ? 1 : 0;
  }

  const ret = new Float64Array(n).fill(Number.NaN);
  const absRet = new Float64Array(n).fill(Number.NaN);
  for (let h = 0; h < n; h++) {
    if (!valid[h]) continue;
    ret[h] = Math.log(close[h] / open[h]);
    absRet[h] = Math.abs(ret[h]);
  }

  const oi = new Float64Array(n).fill(Number.NaN);
  const oiTime = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
  for (const m of metrics) {
    if (m.t < gridStart || m.t >= gridEnd) continue;
    const value = m.openInterest;
    if (value === null || !Number.isFinite(value) || value <= 0) continue;
    const h = Math.floor((m.t - gridStart) / HOUR_MS);
    if (m.t >= oiTime[h]) {
      oiTime[h] = m.t;
      oi[h] = value;
    }
  }

  const oiChange = new Float64Array(n).fill(Number.NaN);
  for (let h = 1; h < n; h++) {
    if (valid[h] && Number.isFinite(oi[h]) && Number.isFinite(oi[h - 1])) oiChange[h] = Math.log(oi[h] / oi[h - 1]);
  }

  const invalidBefore = new Int32Array(n + 1);
  const sqCum = new Float64Array(n + 1);
  const sqCount = new Int32Array(n + 1);
  for (let h = 0; h < n; h++) {
    invalidBefore[h + 1] = invalidBefore[h] + (valid[h] ? 0 : 1);
    sqCum[h + 1] = sqCum[h] + (valid[h] ? ret[h] * ret[h] : 0);
    sqCount[h + 1] = sqCount[h] + (valid[h] ? 1 : 0);
  }

  const settlements = funding
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.rate) && f.t < gridEnd)
    .map((f) => ({ t: f.t, rate: f.rate }))
    .sort((a, b) => a.t - b.t);
  const settlementTimes = Float64Array.from(settlements.map((f) => f.t));
  const settlementRates = Float64Array.from(settlements.map((f) => f.rate));
  const rateCum = new Float64Array(settlements.length + 1);
  for (let j = 0; j < settlements.length; j++) rateCum[j + 1] = rateCum[j] + settlementRates[j];

  return {
    symbol,
    start: gridStart,
    n,
    open,
    close,
    volume,
    valid,
    ret,
    absRet,
    oi,
    oiChange,
    invalidBefore,
    sqCum,
    sqCount,
    settlementTimes,
    settlementRates,
    rateCum,
  };
}

/**
 * Per hour h, the type 7 percentiles at each p of the finite values among h - window .. h - 1, or NaN with
 * fewer than minCount of them. The window drops its oldest value before it takes value h - 1, and value h is
 * never inside, so nothing at or after h moves the threshold at h.
 */
export function trailingQuantiles(
  values: Float64Array,
  ps: readonly number[],
  window: number = TRAILING_HOURS,
  minCount: number = MIN_TRAILING_HOURS
): Float64Array[] {
  const n = values.length;
  const out = ps.map(() => new Float64Array(n).fill(Number.NaN));
  const sorted = new SortedWindow(window);
  for (let h = 0; h < n; h++) {
    const leave = h - 1 - window;
    if (leave >= 0 && Number.isFinite(values[leave])) sorted.remove(values[leave]);
    const enter = h - 1;
    if (enter >= 0 && Number.isFinite(values[enter])) sorted.insert(values[enter]);
    if (sorted.size >= minCount) {
      for (let j = 0; j < ps.length; j++) out[j][h] = sorted.quantile(ps[j]);
    }
  }
  return out;
}

/**
 * Per settlement j (ascending times), the type 7 percentiles at each p of the rates stamped in
 * [times[j] - windowMs, times[j]), or NaN with fewer than minCount of them.
 */
export function settlementQuantiles(
  times: ArrayLike<number>,
  rates: ArrayLike<number>,
  ps: readonly number[],
  windowMs: number = SETTLEMENT_WINDOW_DAYS * DAY_MS,
  minCount: number = MIN_SETTLEMENTS
): Float64Array[] {
  const n = times.length;
  const out = ps.map(() => new Float64Array(n).fill(Number.NaN));
  const sorted = new SortedWindow(n);
  let lo = 0;
  let hi = 0;
  for (let j = 0; j < n; j++) {
    while (hi < n && times[hi] < times[j]) sorted.insert(rates[hi++]);
    while (lo < hi && times[lo] < times[j] - windowMs) sorted.remove(rates[lo++]);
    if (sorted.size >= minCount) {
      for (let k = 0; k < ps.length; k++) out[k][j] = sorted.quantile(ps[k]);
    }
  }
  return out;
}

export interface DetectedEvent {
  type: EventType;
  symbol: string;
  /** Index of the event hour h in the panel. */
  hour: number;
  /** Open time of h. */
  t: number;
  /** Index of the entry hour: h + 1 for E1 and E3, h + 2 for E2. */
  entry: number;
  d: -1 | 0 | 1;
  /** The defining value equals its threshold exactly (reported, see note 4). */
  atThreshold: boolean;
}

export interface SampleWindow {
  sampleStart: number;
  sampleEnd: number;
}

function inSample(t: number, window: SampleWindow): boolean {
  return t >= window.sampleStart && t < window.sampleEnd;
}

/** E1: OI change at or below its threshold AND |return| at or above its threshold, at a non-missing hour. */
export function detectE1(
  panel: HourlyPanel,
  oiThreshold: Float64Array,
  absReturnThreshold: Float64Array,
  window: SampleWindow
): DetectedEvent[] {
  const events: DetectedEvent[] = [];
  for (let h = 0; h < panel.n; h++) {
    const t = panel.start + h * HOUR_MS;
    if (!inSample(t, window) || !panel.valid[h]) continue;
    const change = panel.oiChange[h];
    const oiThr = oiThreshold[h];
    const retThr = absReturnThreshold[h];
    if (!Number.isFinite(change) || !Number.isFinite(oiThr) || !Number.isFinite(retThr)) continue;
    const abs = panel.absRet[h];
    if (change <= oiThr && abs >= retThr) {
      events.push({
        type: 'E1',
        symbol: panel.symbol,
        hour: h,
        t,
        entry: h + 1,
        d: sgn(panel.ret[h]),
        atThreshold: change === oiThr || abs === retThr,
      });
    }
  }
  return events;
}

/** E3: base volume at or above its threshold, at a non-missing hour. */
export function detectE3(panel: HourlyPanel, volumeThreshold: Float64Array, window: SampleWindow): DetectedEvent[] {
  const events: DetectedEvent[] = [];
  for (let h = 0; h < panel.n; h++) {
    const t = panel.start + h * HOUR_MS;
    if (!inSample(t, window) || !panel.valid[h]) continue;
    const thr = volumeThreshold[h];
    if (!Number.isFinite(thr)) continue;
    const v = panel.volume[h];
    if (v >= thr) {
      events.push({
        type: 'E3',
        symbol: panel.symbol,
        hour: h,
        t,
        entry: h + 1,
        d: sgn(panel.ret[h]),
        atThreshold: v === thr,
      });
    }
  }
  return events;
}

/**
 * E2: a settlement strictly above its trailing 99th percentile (d = +1) or strictly below its 1st (d = -1),
 * AMENDMENT 1. The event hour is the hour whose close is the settlement, and entry is the open of h + 2.
 */
export function detectE2(
  panel: HourlyPanel,
  highThreshold: Float64Array,
  lowThreshold: Float64Array,
  window: SampleWindow
): DetectedEvent[] {
  const events: DetectedEvent[] = [];
  for (let j = 0; j < panel.settlementTimes.length; j++) {
    const hi = highThreshold[j];
    const lo = lowThreshold[j];
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    const rate = panel.settlementRates[j];
    // AMENDMENT 1: strict, so a tail made of the 0.0100% base rate marks no event.
    const up = rate > hi;
    const down = rate < lo;
    if (up === down) continue; // neither, or both (note 6)
    const closeT = Math.ceil(panel.settlementTimes[j] / HOUR_MS) * HOUR_MS;
    const t = closeT - HOUR_MS;
    if (!inSample(t, window)) continue;
    const h = (t - panel.start) / HOUR_MS;
    if (h < 0 || h >= panel.n || !panel.valid[h]) continue;
    events.push({
      type: 'E2',
      symbol: panel.symbol,
      hour: h,
      t,
      entry: h + 2,
      d: up ? 1 : -1,
      atThreshold: rate === hi || rate === lo,
    });
  }
  return events;
}

export interface PanelEvents {
  E1: DetectedEvent[];
  E1Sensitivity: DetectedEvent[];
  E2: DetectedEvent[];
  E3: DetectedEvent[];
}

/** Every event family on one panel, each threshold series computed once. */
export function detectAll(panel: HourlyPanel, window: SampleWindow): PanelEvents {
  const [oi01, oi02] = trailingQuantiles(panel.oiChange, [E1_SENSITIVITY.oi, E1_PRIMARY.oi]);
  const [abs98, abs99] = trailingQuantiles(panel.absRet, [E1_PRIMARY.absReturn, E1_SENSITIVITY.absReturn]);
  const [vol99] = trailingQuantiles(panel.volume, [E3_HIGH]);
  const [rateLow, rateHigh] = settlementQuantiles(panel.settlementTimes, panel.settlementRates, [E2_LOW, E2_HIGH]);
  return {
    E1: detectE1(panel, oi02, abs98, window),
    E1Sensitivity: detectE1(panel, oi01, abs99, window),
    E2: detectE2(panel, rateHigh, rateLow, window),
    E3: detectE3(panel, vol99, window),
  };
}

export interface KeptEvent {
  type: EventType;
  symbol: string;
  horizon: number;
  hour: number;
  t: number;
  entry: number;
  entryT: number;
  d: 1 | -1;
  s: 1 | -1;
  /** d x log(close of the last horizon hour / open of the entry hour). */
  signed: number;
  /** Funding the position paid over the hold (negative when it received). */
  funding: number;
  /** s x signed - cost - funding. */
  net: number;
}

export interface DropCounts {
  noDirection: number;
  beyondSample: number;
  missing: number;
  overlap: number;
}

export function zeroDrops(): DropCounts {
  return { noDirection: 0, beyondSample: 0, missing: 0, overlap: 0 };
}

/** Funding paid by a position of side `side` over settlements stamped in (from, to]. */
export function fundingPaid(panel: HourlyPanel, side: 1 | -1, from: number, to: number): number {
  const a = upperBound(panel.settlementTimes, from);
  const b = upperBound(panel.settlementTimes, to);
  return side * (panel.rateCum[b] - panel.rateCum[a]);
}

/**
 * One symbol's events of one type at horizon H, walked forward in time: direction, sample end, missing hours,
 * then the greedy de-overlap (note 9). Each kept event carries its signed forward return, funding and net.
 */
export function keepEvents(
  panel: HourlyPanel,
  events: readonly DetectedEvent[],
  horizon: number,
  sampleEnd: number,
  cost: number = ROUND_TRIP_COST
): { kept: KeptEvent[]; drops: DropCounts } {
  const drops = zeroDrops();
  const kept: KeptEvent[] = [];
  const ordered = [...events].sort((a, b) => a.entry - b.entry || a.hour - b.hour);
  let lastEntry = Number.NEGATIVE_INFINITY;
  for (const ev of ordered) {
    if (ev.symbol !== panel.symbol) throw new Error(`keepEvents: ${ev.symbol} event on the ${panel.symbol} panel`);
    if (ev.d === 0) {
      drops.noDirection++;
      continue;
    }
    const last = ev.entry + horizon - 1;
    const holdEnd = panel.start + (last + 1) * HOUR_MS;
    if (last >= panel.n || holdEnd >= sampleEnd) {
      drops.beyondSample++;
      continue;
    }
    if (panel.invalidBefore[last + 1] - panel.invalidBefore[ev.entry] > 0) {
      drops.missing++;
      continue;
    }
    if (ev.entry <= lastEntry + horizon - 1) {
      drops.overlap++;
      continue;
    }
    lastEntry = ev.entry;
    const s = EVENT_SIDE[ev.type];
    const entryT = panel.start + ev.entry * HOUR_MS;
    const signed = ev.d * Math.log(panel.close[last] / panel.open[ev.entry]);
    const side = (s * ev.d) as 1 | -1;
    const funding = fundingPaid(panel, side, entryT, holdEnd);
    kept.push({
      type: ev.type,
      symbol: ev.symbol,
      horizon,
      hour: ev.hour,
      t: ev.t,
      entry: ev.entry,
      entryT,
      d: ev.d,
      s,
      signed,
      funding,
      net: s * signed - cost - funding,
    });
  }
  return { kept, drops };
}

export interface Calendar {
  /** UTC midnight of day 0. */
  start: number;
  nDays: number;
}

export function calendarOf(sampleStart: number, sampleEnd: number): Calendar {
  const start = Math.floor(sampleStart / DAY_MS) * DAY_MS;
  return { start, nDays: Math.ceil((sampleEnd - start) / DAY_MS) };
}

export function dayIndex(calendar: Calendar, ms: number): number {
  const k = Math.floor((ms - calendar.start) / DAY_MS);
  if (k < 0 || k >= calendar.nDays) throw new Error(`dayIndex: ${new Date(ms).toISOString()} is outside the calendar`);
  return k;
}

/** One circular block resample of the day calendar: blocks of `blockDays` consecutive days, wrapping. */
export function circularBlockDays(random: () => number, nDays: number, blockDays: number): Int32Array {
  const out = new Int32Array(nDays);
  let k = 0;
  while (k < nDays) {
    const start = Math.floor(random() * nDays);
    for (let j = 0; j < blockDays && k < nDays; j++) out[k++] = (start + j) % nDays;
  }
  return out;
}

/**
 * The day-clustered bootstrap of the mean of each series (every series indexed like `days`), all from the
 * same day resamples. Every event on a resampled day is drawn, across symbols. NaN marks a draw with no event.
 */
export function dayBootstrapMeans(
  days: ArrayLike<number>,
  series: readonly ArrayLike<number>[],
  nDays: number,
  opts: BootstrapOptions = BOOTSTRAP
): Float64Array[] {
  const counts = new Float64Array(nDays);
  const sums = series.map(() => new Float64Array(nDays));
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (!(d >= 0 && d < nDays)) throw new Error(`dayBootstrapMeans: day ${d} outside [0, ${nDays})`);
    counts[d]++;
    for (let j = 0; j < series.length; j++) sums[j][d] += series[j][i];
  }
  const random = createSeededRandom(opts.seed);
  const out = series.map(() => new Float64Array(opts.draws));
  const acc = new Float64Array(series.length);
  for (let b = 0; b < opts.draws; b++) {
    const resample = circularBlockDays(random, nDays, opts.blockDays);
    let count = 0;
    acc.fill(0);
    for (let k = 0; k < resample.length; k++) {
      const d = resample[k];
      count += counts[d];
      for (let j = 0; j < series.length; j++) acc[j] += sums[j][d];
    }
    for (let j = 0; j < series.length; j++) out[j][b] = count > 0 ? acc[j] / count : Number.NaN;
  }
  return out;
}

/** The same day bootstrap for an arbitrary statistic of the resampled values (the volatility median). */
export function dayBootstrapStatistic(
  days: ArrayLike<number>,
  values: ArrayLike<number>,
  statistic: (sample: number[]) => number,
  nDays: number,
  opts: BootstrapOptions = BOOTSTRAP
): Float64Array {
  const byDay: number[][] = Array.from({ length: nDays }, () => []);
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (!(d >= 0 && d < nDays)) throw new Error(`dayBootstrapStatistic: day ${d} outside [0, ${nDays})`);
    byDay[d].push(values[i]);
  }
  const random = createSeededRandom(opts.seed);
  const out = new Float64Array(opts.draws);
  for (let b = 0; b < opts.draws; b++) {
    const resample = circularBlockDays(random, nDays, opts.blockDays);
    const sample: number[] = [];
    for (let k = 0; k < resample.length; k++) {
      const bucket = byDay[resample[k]];
      for (let i = 0; i < bucket.length; i++) sample.push(bucket[i]);
    }
    out[b] = sample.length > 0 ? statistic(sample) : Number.NaN;
  }
  return out;
}

export interface DrawSummary {
  ciLow: number;
  ciHigh: number;
  /** (1 + draws with |b - observed| >= |observed|) / (draws + 1), empty draws counted (note 11). */
  p: number;
  emptyDraws: number;
}

export function summariseDraws(observed: number, draws: Float64Array): DrawSummary {
  const finite = draws.filter(Number.isFinite).sort();
  let exceed = 0;
  const absObserved = Math.abs(observed);
  for (let b = 0; b < draws.length; b++) {
    const v = draws[b];
    if (!Number.isFinite(v) || Math.abs(v - observed) >= absObserved) exceed++;
  }
  return {
    ciLow: quantileSorted(finite, finite.length, 0.025),
    ciHigh: quantileSorted(finite, finite.length, 0.975),
    p: (1 + exceed) / (draws.length + 1),
    emptyDraws: draws.length - finite.length,
  };
}

export interface CellStats {
  n: number;
  days: number;
  gross: { mean: number; ciLow: number; ciHigh: number; p: number; emptyDraws: number };
  net: { mean: number; ciLow: number; ciHigh: number };
  fundingMean: number;
}

/** Gross and net means of a cell with their CIs (and the gross p) from one set of day resamples. */
export function cellStatistics(
  kept: readonly KeptEvent[],
  calendar: Calendar,
  opts: BootstrapOptions = BOOTSTRAP
): CellStats {
  const days = kept.map((e) => dayIndex(calendar, e.entryT));
  const gross = kept.map((e) => e.signed);
  const net = kept.map((e) => e.net);
  const [grossDraws, netDraws] = dayBootstrapMeans(days, [gross, net], calendar.nDays, opts);
  const grossMean = meanOf(gross);
  const netMean = meanOf(net);
  const g = summariseDraws(grossMean, grossDraws);
  const nt = summariseDraws(netMean, netDraws);
  return {
    n: kept.length,
    days: new Set(days).size,
    gross: { mean: grossMean, ciLow: g.ciLow, ciHigh: g.ciHigh, p: g.p, emptyDraws: g.emptyDraws },
    net: { mean: netMean, ciLow: nt.ciLow, ciHigh: nt.ciHigh },
    fundingMean: meanOf(kept.map((e) => e.funding)),
  };
}

export interface GroupMean {
  key: string;
  n: number;
  grossMean: number;
  agrees: boolean;
}

/** Gate 3's per-symbol reading over the fixed symbol list (note 12). */
export function symbolAgreement(kept: readonly KeptEvent[], symbols: readonly string[], s: 1 | -1): GroupMean[] {
  return symbols.map((symbol) => {
    const own = kept.filter((e) => e.symbol === symbol).map((e) => e.signed);
    const grossMean = meanOf(own);
    return {
      key: symbol,
      n: own.length,
      grossMean,
      agrees: own.length >= GATE_THRESHOLDS.breadthMinEvents && s * grossMean > 0,
    };
  });
}

/** Gate 4's per-period reading, events placed by entry time (note 12). */
export function periodAgreement(kept: readonly KeptEvent[], periods: readonly EventPeriod[], s: 1 | -1): GroupMean[] {
  return periods.map((period) => {
    const own = kept.filter((e) => e.entryT >= period.from && e.entryT < period.to).map((e) => e.signed);
    const grossMean = meanOf(own);
    return { key: period.label, n: own.length, grossMean, agrees: own.length > 0 && s * grossMean > 0 };
  });
}

export interface GateInput {
  p: number;
  byRejected: boolean;
  netCiLow: number;
  symbols: readonly GroupMean[];
  periods: readonly GroupMean[];
  n: number;
  days: number;
}

export function evaluateGates(input: GateInput): EventGate[] {
  const agreeingSymbols = input.symbols.filter((g) => g.agrees).length;
  const agreeingPeriods = input.periods.filter((g) => g.agrees).length;
  return [
    {
      id: 1,
      name: 'significance',
      pass: input.byRejected,
      value: fin(input.p),
      threshold: FDR_Q,
      note: `two-sided p, Benjamini-Yekutieli across the ${TRIALS} cells at FDR ${FDR_Q}`,
    },
    {
      id: 2,
      name: 'pays',
      pass: Number.isFinite(input.netCiLow) && input.netCiLow > 0,
      value: fin(input.netCiLow),
      threshold: 0,
      note: 'net mean bootstrap 95% CI low must exceed 0',
    },
    {
      id: 3,
      name: 'breadth',
      pass: agreeingSymbols >= GATE_THRESHOLDS.breadthSymbols,
      value: agreeingSymbols,
      threshold: GATE_THRESHOLDS.breadthSymbols,
      note:
        `${agreeingSymbols} of ${input.symbols.length} symbols with the sign of s ` +
        `(fewer than ${GATE_THRESHOLDS.breadthMinEvents} kept events disagrees)`,
    },
    {
      id: 4,
      name: 'time',
      pass: agreeingPeriods >= GATE_THRESHOLDS.timePeriods,
      value: agreeingPeriods,
      threshold: GATE_THRESHOLDS.timePeriods,
      note: `${agreeingPeriods} of ${input.periods.length} periods with the sign of s`,
    },
    {
      id: 5,
      name: 'sample',
      pass: input.n >= GATE_THRESHOLDS.sampleEvents && input.days >= GATE_THRESHOLDS.sampleDays,
      value: input.n,
      threshold: GATE_THRESHOLDS.sampleEvents,
      note:
        `${input.n} kept events over ${input.days} distinct days ` +
        `(needs ${GATE_THRESHOLDS.sampleEvents} over ${GATE_THRESHOLDS.sampleDays})`,
    },
  ];
}

export interface ReportedBlock {
  countsBySymbol: Record<string, number>;
  countsByYear: Record<string, number>;
  netMeanAt2xCost: number;
  medianSigned: number;
  hitRate: number;
  top10DayShare: number;
}

/** The reported, ungated block of one cell (note 13). */
export function reportedBlock(
  kept: readonly KeptEvent[],
  s: 1 | -1,
  symbols: readonly string[],
  cost: number = ROUND_TRIP_COST
): ReportedBlock {
  const countsBySymbol: Record<string, number> = Object.fromEntries(symbols.map((sym) => [sym, 0]));
  const countsByYear: Record<string, number> = {};
  const perDay = new Map<number, number>();
  for (const e of kept) {
    countsBySymbol[e.symbol] = (countsBySymbol[e.symbol] ?? 0) + 1;
    const year = String(new Date(e.entryT).getUTCFullYear());
    countsByYear[year] = (countsByYear[year] ?? 0) + 1;
    const day = Math.floor(e.entryT / DAY_MS);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const largest = [...perDay.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10);
  const inLargest = largest.reduce((sum, [, count]) => sum + count, 0);
  return {
    countsBySymbol,
    countsByYear,
    netMeanAt2xCost: meanOf(kept.map((e) => s * e.signed - 2 * cost - e.funding)),
    medianSigned: kept.length > 0 ? medianOf(kept.map((e) => e.signed)) : Number.NaN,
    hitRate: kept.length > 0 ? kept.filter((e) => s * e.signed > 0).length / kept.length : Number.NaN,
    top10DayShare: kept.length > 0 ? inLargest / kept.length : Number.NaN,
  };
}

/**
 * A kept 24h event's next-24-hour realised variance over 24 x its trailing 30-day mean squared hourly return
 * (note 14), NaN when the trailing window is too thin or flat.
 */
export function volatilityRatio(panel: HourlyPanel, event: KeptEvent): number {
  if (event.horizon !== VOL_HORIZON) throw new Error('volatilityRatio: needs a kept 24h event');
  const from = event.entry;
  const to = event.entry + VOL_HORIZON;
  if (to > panel.n || panel.invalidBefore[to] - panel.invalidBefore[from] > 0) return Number.NaN;
  const next = panel.sqCum[to] - panel.sqCum[from];
  const a = Math.max(0, event.hour - VOL_TRAILING_HOURS);
  const b = event.hour;
  const count = panel.sqCount[b] - panel.sqCount[a];
  if (count < VOL_MIN_TRAILING_HOURS) return Number.NaN;
  const trailingMean = (panel.sqCum[b] - panel.sqCum[a]) / count;
  if (!(trailingMean > 0)) return Number.NaN;
  return next / (VOL_HORIZON * trailingMean);
}

export interface RatioRead {
  n: number;
  excluded: number;
  median: number;
  ciLow: number;
  ciHigh: number;
}

/** Median ratio over kept 24h events with its day-clustered bootstrap CI (fresh seed, note 11). */
export function ratioRead(
  events: readonly KeptEvent[],
  panelOf: (symbol: string) => HourlyPanel,
  calendar: Calendar,
  opts: BootstrapOptions = BOOTSTRAP
): RatioRead {
  const ratios: number[] = [];
  const days: number[] = [];
  let excluded = 0;
  for (const e of events) {
    const r = volatilityRatio(panelOf(e.symbol), e);
    if (!Number.isFinite(r)) {
      excluded++;
      continue;
    }
    ratios.push(r);
    days.push(dayIndex(calendar, e.entryT));
  }
  if (ratios.length === 0) return { n: 0, excluded, median: Number.NaN, ciLow: Number.NaN, ciHigh: Number.NaN };
  const draws = dayBootstrapStatistic(days, ratios, medianOf, calendar.nDays, opts);
  const summary = summariseDraws(medianOf(ratios), draws);
  return { n: ratios.length, excluded, median: medianOf(ratios), ciLow: summary.ciLow, ciHigh: summary.ciHigh };
}

/** Sum of squared hourly log returns over the 24 hours of the UTC day starting at dayStart; NaN unless all 24 exist. */
export function dailyRealisedVariance(panel: HourlyPanel, dayStart: number): number {
  const from = (dayStart - panel.start) / HOUR_MS;
  const to = from + 24;
  if (!Number.isInteger(from) || from < 0 || to > panel.n) return Number.NaN;
  if (panel.invalidBefore[to] - panel.invalidBefore[from] > 0) return Number.NaN;
  return panel.sqCum[to] - panel.sqCum[from];
}

export interface StressRead {
  symbol: string;
  from: number;
  to: number;
  days: number;
  skippedDays: number;
  topQuintileDays: number;
  flaggedDays: number;
  tp: number;
  fn: number;
  tn: number;
  fp: number;
  hitRate: number;
  trueNegativeRate: number;
  balancedAccuracy: number;
}

/** AMENDMENT 1: E3 events on at least this many distinct symbols in one hour make a market-wide shock. */
export const STRESS_MIN_E3_SYMBOLS = 3;

/**
 * The hour opens that set the market-wide stress flag (AMENDMENT 1): every E1 event hour on any symbol, and
 * every hour in which E3 fired on at least three distinct symbols. Sorted, unique.
 */
export function marketWideStressHours(
  e1Opens: readonly number[],
  e3: ReadonlyArray<{ symbol: string; t: number }>
): number[] {
  const bySymbolHour = new Map<number, Set<string>>();
  for (const e of e3) {
    const set = bySymbolHour.get(e.t) ?? new Set<string>();
    set.add(e.symbol);
    bySymbolHour.set(e.t, set);
  }
  const hours = new Set<number>(e1Opens);
  for (const [t, symbols] of bySymbolHour) if (symbols.size >= STRESS_MIN_E3_SYMBOLS) hours.add(t);
  return [...hours].sort((a, b) => a - b);
}

/**
 * The stress flag's balanced accuracy for the reference panel's next-day realised variance landing in its
 * trailing 180-day top quintile, one evaluation per UTC day in [from, to) (note 15). `eventHourOpens` are the
 * market-wide stress hours from `marketWideStressHours`.
 */
export function evaluateStressFlag(
  eventHourOpens: readonly number[],
  reference: HourlyPanel,
  from: number,
  to: number
): StressRead {
  const opens = [...eventHourOpens].sort((a, b) => a - b);
  const rvByDay = new Map<number, number>();
  const rvOf = (day: number): number => {
    let rv = rvByDay.get(day);
    if (rv === undefined) {
      rv = dailyRealisedVariance(reference, day);
      rvByDay.set(day, rv);
    }
    return rv;
  };
  let skippedDays = 0;
  let tp = 0;
  let fn = 0;
  let tn = 0;
  let fp = 0;
  let flaggedDays = 0;
  for (let day = from; day < to; day += DAY_MS) {
    // An event hour closing in (day - 24h, day] opens in (day - 25h, day - 1h].
    const k = upperBound(opens, day - 25 * HOUR_MS);
    const flagged = k < opens.length && opens[k] <= day - HOUR_MS;
    if (flagged) flaggedDays++;
    const rv = rvOf(day);
    const trailing: number[] = [];
    for (let back = 1; back <= STRESS_TRAILING_DAYS; back++) {
      const v = rvOf(day - back * DAY_MS);
      if (Number.isFinite(v)) trailing.push(v);
    }
    if (!Number.isFinite(rv) || trailing.length < STRESS_MIN_TRAILING_DAYS) {
      skippedDays++;
      continue;
    }
    const sorted = Float64Array.from(trailing).sort();
    const top = rv >= quantileSorted(sorted, sorted.length, STRESS_QUANTILE);
    if (top && flagged) tp++;
    else if (top) fn++;
    else if (flagged) fp++;
    else tn++;
  }
  const hitRate = tp + fn > 0 ? tp / (tp + fn) : Number.NaN;
  const trueNegativeRate = tn + fp > 0 ? tn / (tn + fp) : Number.NaN;
  return {
    symbol: reference.symbol,
    from,
    to,
    days: tp + fn + tn + fp,
    skippedDays,
    topQuintileDays: tp + fn,
    flaggedDays,
    tp,
    fn,
    tn,
    fp,
    hitRate,
    trueNegativeRate,
    balancedAccuracy: (hitRate + trueNegativeRate) / 2,
  };
}

export type EventStudyResult = Omit<
  EventStudyReport,
  'schemaVersion' | 'taskId' | 'datasetManifestHash' | 'lockboxApplied' | 'computedAt' | 'gitCommit' | 'durationMs'
>;

function statsJson(stats: CellStats, drops: DropCounts): EventCellStatsJson {
  return {
    n: stats.n,
    days: stats.days,
    gross: {
      mean: fin(stats.gross.mean),
      ciLow: fin(stats.gross.ciLow),
      ciHigh: fin(stats.gross.ciHigh),
      p: stats.gross.p,
      emptyDraws: stats.gross.emptyDraws,
    },
    net: { mean: fin(stats.net.mean), ciLow: fin(stats.net.ciLow), ciHigh: fin(stats.net.ciHigh) },
    fundingMean: fin(stats.fundingMean),
    drops: { ...drops },
  };
}

function groupJson(groups: readonly GroupMean[]): EventGroupMean[] {
  return groups.map((g) => ({ key: g.key, n: g.n, grossMean: fin(g.grossMean), agrees: g.agrees }));
}

function ratioJson(read: RatioRead): EventRatioStat {
  return { n: read.n, excluded: read.excluded, median: fin(read.median), ciLow: fin(read.ciLow), ciHigh: fin(read.ciHigh) };
}

function stressJson(read: StressRead): EventStress {
  return {
    ...read,
    hitRate: fin(read.hitRate),
    trueNegativeRate: fin(read.trueNegativeRate),
    balancedAccuracy: fin(read.balancedAccuracy),
  };
}

function detectedJson(lists: readonly DetectedEvent[][], symbols: readonly string[]): EventDetected {
  const all = lists.flat();
  const bySymbol: Record<string, number> = Object.fromEntries(symbols.map((s) => [s, 0]));
  for (const e of all) bySymbol[e.symbol] = (bySymbol[e.symbol] ?? 0) + 1;
  return {
    total: all.length,
    bySymbol,
    noDirection: all.filter((e) => e.d === 0).length,
    atThreshold: all.filter((e) => e.atThreshold).length,
  };
}

/** Kept events of one family at one horizon across every panel, in a deterministic order. */
function keepAcross(
  detections: readonly { panel: HourlyPanel; events: PanelEvents }[],
  family: keyof PanelEvents,
  horizon: number,
  sampleEnd: number
): { kept: KeptEvent[]; drops: DropCounts } {
  const kept: KeptEvent[] = [];
  const drops = zeroDrops();
  for (const { panel, events } of detections) {
    const r = keepEvents(panel, events[family], horizon, sampleEnd);
    kept.push(...r.kept);
    drops.noDirection += r.drops.noDirection;
    drops.beyondSample += r.drops.beyondSample;
    drops.missing += r.drops.missing;
    drops.overlap += r.drops.overlap;
  }
  kept.sort((a, b) => a.entryT - b.entryT || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { kept, drops };
}

/**
 * The whole phase on prepared hourly panels (one per symbol, built with buildHourlyPanel on the grid
 * [gridStartOf(config), config.sampleEnd)): the nine cells and their gates, E1's sensitivity and the
 * volatility read. Pure: no I/O, no clock.
 */
export function runEventStudies(
  panels: readonly HourlyPanel[],
  config: EventStudyConfig = PREREGISTERED_CONFIG
): EventStudyResult {
  const window: SampleWindow = { sampleStart: config.sampleStart, sampleEnd: config.sampleEnd };
  const calendar = calendarOf(config.sampleStart, config.sampleEnd);
  const panelBySymbol = new Map(panels.map((p) => [p.symbol, p]));
  const panelOf = (symbol: string): HourlyPanel => {
    const panel = panelBySymbol.get(symbol);
    if (!panel) throw new Error(`no panel for ${symbol}`);
    return panel;
  };
  const detections = panels.map((panel) => ({ panel, events: detectAll(panel, window) }));

  const raw = EVENT_TYPES.flatMap((type) =>
    HORIZONS.map((horizon) => {
      const { kept, drops } = keepAcross(detections, type, horizon, config.sampleEnd);
      return { type, horizon, s: EVENT_SIDE[type], kept, drops, stats: cellStatistics(kept, calendar) };
    })
  );
  const rejected = benjaminiYekutieli(
    raw.map((c) => c.stats.gross.p),
    FDR_Q
  );

  const cells: EventCell[] = raw.map((c, i) => {
    const symbols = symbolAgreement(c.kept, config.symbols, c.s);
    const periods = periodAgreement(c.kept, config.periods, c.s);
    const gates = evaluateGates({
      p: c.stats.gross.p,
      byRejected: rejected[i],
      netCiLow: c.stats.net.ciLow,
      symbols,
      periods,
      n: c.stats.n,
      days: c.stats.days,
    });
    const reported = reportedBlock(c.kept, c.s, config.symbols);
    return {
      event: c.type,
      horizon: c.horizon,
      side: c.s,
      ...statsJson(c.stats, c.drops),
      byRejected: rejected[i],
      gates,
      pass: gates.every((g) => g.pass),
      symbols: groupJson(symbols),
      periods: groupJson(periods),
      reported: {
        countsBySymbol: reported.countsBySymbol,
        countsByYear: reported.countsByYear,
        netMeanAt2xCost: fin(reported.netMeanAt2xCost),
        medianSigned: fin(reported.medianSigned),
        hitRate: fin(reported.hitRate),
        top10DayShare: fin(reported.top10DayShare),
      },
    };
  });

  const e1Sensitivity = HORIZONS.map((horizon) => {
    const { kept, drops } = keepAcross(detections, 'E1Sensitivity', horizon, config.sampleEnd);
    return {
      event: 'E1' as const,
      horizon,
      oiPercentile: E1_SENSITIVITY.oi,
      absReturnPercentile: E1_SENSITIVITY.absReturn,
      ...statsJson(cellStatistics(kept, calendar), drops),
    };
  });

  const keptAt24 = (type: EventType): KeptEvent[] =>
    raw.find((c) => c.type === type && c.horizon === VOL_HORIZON)?.kept ?? [];
  const pooled = new Map<string, KeptEvent>();
  for (const e of [...keptAt24('E1'), ...keptAt24('E3')]) {
    const key = `${e.symbol}|${e.hour}`;
    if (!pooled.has(key)) pooled.set(key, e);
  }
  const pooledRead = ratioRead([...pooled.values()], panelOf, calendar);

  const reference = panelBySymbol.get(STRESS_SYMBOL);
  const stressOpens = marketWideStressHours(
    detections.flatMap(({ events }) => events.E1.map((e) => e.t)),
    detections.flatMap(({ events }) => events.E3.map((e) => ({ symbol: e.symbol, t: e.t })))
  );
  const stress = reference ? evaluateStressFlag(stressOpens, reference, config.stressFrom, config.stressTo) : null;
  const balancedAccuracyPass =
    stress !== null && Number.isFinite(stress.balancedAccuracy) && stress.balancedAccuracy >= MIN_BALANCED_ACCURACY;
  const ratioPass =
    Number.isFinite(pooledRead.median) && pooledRead.median > 1 && Number.isFinite(pooledRead.ciLow) && pooledRead.ciLow > 1;

  const coverage: EventStudyResult['coverage'] = {};
  for (const panel of panels) {
    let sampleHours = 0;
    let validHours = 0;
    let oiChangeHours = 0;
    let firstValid: number | null = null;
    let lastValid: number | null = null;
    for (let h = 0; h < panel.n; h++) {
      const t = panel.start + h * HOUR_MS;
      if (panel.valid[h]) {
        if (firstValid === null) firstValid = t;
        lastValid = t;
      }
      if (!inSample(t, window)) continue;
      sampleHours++;
      if (panel.valid[h]) validHours++;
      if (Number.isFinite(panel.oiChange[h])) oiChangeHours++;
    }
    const settlements = Array.from(panel.settlementTimes).filter((t) => inSample(t, window)).length;
    coverage[panel.symbol] = {
      sampleHours,
      validHours,
      oiChangeHours,
      settlements,
      firstValidHour: firstValid,
      lastValidHour: lastValid,
    };
  }

  const passingCells = cells.filter((c) => c.pass).map((c) => `${c.event}-${c.horizon}h`);
  return {
    symbols: [...config.symbols],
    trials: TRIALS,
    ledgerBefore: LEDGER_BEFORE,
    ledgerAfter: LEDGER_AFTER,
    config: {
      sampleStart: config.sampleStart,
      sampleEnd: config.sampleEnd,
      trailingHours: TRAILING_HOURS,
      minTrailingHours: MIN_TRAILING_HOURS,
      settlementWindowDays: SETTLEMENT_WINDOW_DAYS,
      minSettlements: MIN_SETTLEMENTS,
      horizons: [...HORIZONS],
      cost: ROUND_TRIP_COST,
      fdrQ: FDR_Q,
      bootstrap: { ...BOOTSTRAP },
      calendarStart: calendar.start,
      calendarDays: calendar.nDays,
      periods: config.periods.map((p) => ({ ...p })),
      stressFrom: config.stressFrom,
      stressTo: config.stressTo,
    },
    coverage,
    detected: {
      E1: detectedJson(detections.map((d) => d.events.E1), config.symbols),
      E2: detectedJson(detections.map((d) => d.events.E2), config.symbols),
      E3: detectedJson(detections.map((d) => d.events.E3), config.symbols),
      E1Sensitivity: detectedJson(detections.map((d) => d.events.E1Sensitivity), config.symbols),
    },
    cells,
    e1Sensitivity,
    volatility: {
      byEvent: {
        E1: ratioJson(ratioRead(keptAt24('E1'), panelOf, calendar)),
        E2: ratioJson(ratioRead(keptAt24('E2'), panelOf, calendar)),
        E3: ratioJson(ratioRead(keptAt24('E3'), panelOf, calendar)),
      },
      pooledE1E3: ratioJson(pooledRead),
      stress: stress ? stressJson(stress) : null,
      product: {
        minBalancedAccuracy: MIN_BALANCED_ACCURACY,
        balancedAccuracyPass,
        ratioPass,
        pass: balancedAccuracyPass && ratioPass,
      },
    },
    passingCells,
    verdict: passingCells.length > 0 ? 'provisional-pass' : 'no-cell-passes',
  };
}
