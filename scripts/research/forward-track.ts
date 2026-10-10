/**
 * FORWARD TRACK RECORD: a DESCRIPTIVE month-by-month read of the three frozen forward-test rules over the past
 * year. Not a test.
 *
 * Why: on 2026-10-10, right after the binding forward read (scripts/research/forward-test.ts, nothing
 * confirmed), the user asked to "do it for the past 1 year right away" instead of waiting for the monthly
 * cron. Only 2026-07-01 to 2026-10-09 of the past year is new; the months before it were already used (the
 * snipe confirmation slice for the RSI rules, the qh-flow hold-out where the small-trade imbalance was found).
 * So this reads every calendar month from 2025-10 to 2026-10 (October 2026 to the 9th) separately, labels each
 * month USED BEFORE or FORWARD, and makes NO pass/fail claim and adds NO trial (ledger stays 2,081).
 *
 * RULES, frozen exactly as in forward-test.ts: A1 raw.rsi bottom 10% at 5m -> long; A2 raw.rsi top 10% at 5m ->
 * short (snipe labels, 1-ATR barriers, 1 hour, blocking); B raw.smallTakerImb at 1h, IC with the perp forward
 * return at horizon 1, execution lag 1.
 *
 * METHOD: each symbol's arrays (A) and factor matrix (B) are built ONCE over the exported span (2025-06-01 to
 * 2026-10-09; the months before 2025-10 only feed warmup and the trailing 90-day thresholds), so no month loses
 * bars to warmup. Per calendar month:
 * - A1, A2: the slice is the month (snipe-stats sliceView: in-month bars whose trade window ends inside the
 *   month), the baseline is symbol x ATR quintile within the month, the excess in the frozen direction, the
 *   day-block bootstrap 95% interval (1,000 resamples, seed 11), trades and the month's break-even win rates.
 * - B: the pooled IC over the month's (bar, horizon-1 return) pairs, its HAC t from factor-ic's pooled
 *   statistic, and the count of symbols with a negative month IC.
 * - Also one row for the whole past year pooled (2025-10-10 to 2026-10-09), labelled MIXED (mostly used data).
 * No shift null is run: a one-month grid is shorter than the null's 30-day minimum shift on both sides.
 */

export const TRACK_SPAN = { dataStart: '2025-06-01T00:00:00.000Z', end: '2026-10-09T23:59:59.999Z' } as const;
export const TRACK_FIRST_MONTH = '2025-10';
export const TRACK_YEAR = { start: '2025-10-10T00:00:00.000Z', end: '2026-10-09T23:59:59.999Z' } as const;
/** First forward month; earlier months were used by the snipe confirmation and the qh-flow hold-out. */
export const TRACK_FORWARD_FROM = '2026-07';
export const TRACK_BOOTSTRAP = { resamples: 1_000, seed: 11 } as const;
