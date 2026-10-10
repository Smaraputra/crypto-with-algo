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
 *   month), the baseline is symbol x ATR quintile over the WHOLE reported span (TRACK_BASELINE_START to the
 *   span end), the excess in the frozen direction, the day-block bootstrap 95% interval (1,000 resamples, seed
 *   11), trades and the month's break-even win rates. CORRECTED after the first run (2026-10-10, report sha256
 *   2d3aa611c2c6489cced648c207c134fd2e920c452545fc9253eafcd9d3343691, superseded): that run matched the
 *   baseline within each month, which absorbs the flagged move and inflates reversal cells (the snipe phase's
 *   C1 finding); its monthly A rows are not used. Its pooled year row and every B row did not depend on it.
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
/** Start of the single span-wide baseline every A row is scored against (the first reported month). */
export const TRACK_BASELINE_START = '2025-10-01T00:00:00.000Z';

/*
 * RESULT, 2026-10-10 (DESCRIPTIVE; no pass/fail, no trial). Dataset b98b246934fa174ee09dbf6b55259b2a5254d5db4f57d7540a9077b4e8550f96
 * ($HOME/track-ds on the VPS, export-dataset.ts 2025-06-01 to 2026-10-09), image crypto-ops:forward-track from
 * 2b765de, report $HOME/track-out/forward-track.json sha256
 * 401561ad42e86cccd6aee5d4cc747f825c0bd8275b759d1109e2524c72ae2f80 (the superseded first run is kept beside it).
 *
 *   month    label        A1 RSI low -> long        A2 RSI high -> short      B small-trade IC (t)  neg sym
 *   2025-10  used-before   0.00 [-2.64, +3.03]      +1.77 [-0.51, +4.34]      -0.0033 (-0.29)       5/10
 *   2025-11  used-before  -0.58 [-3.11, +2.68]      +2.88 [-0.46, +6.76]      -0.0303 (-2.60)       7/10
 *   2025-12  used-before  +0.53 [-2.10, +3.66]      +1.95 [-1.62, +5.75]      -0.0320 (-2.73)       8/10
 *   2026-01  used-before  +2.71 [+0.07, +5.84]      +3.23 [+0.43, +6.57]      -0.0364 (-3.13)       10/10
 *   2026-02  used-before  +2.29 [-0.06, +4.83]      +1.18 [-3.74, +6.27]      -0.0246 (-2.07)       9/10
 *   2026-03  used-before  +2.90 [+0.46, +5.54]      +1.45 [-1.22, +4.67]      +0.0049 (+0.43)       5/10
 *   2026-04  used-before  +2.12 [-1.18, +5.78]      +0.82 [-2.08, +3.88]      -0.0218 (-1.87)       7/10
 *   2026-05  used-before  +0.70 [-1.42, +2.88]      -2.43 [-5.37, +0.52]      +0.0158 (+1.35)       3/10
 *   2026-06  used-before  +3.50 [+1.21, +6.36]      +2.77 [-0.08, +5.81]      -0.0216 (-1.86)       8/10
 *   2026-07  forward      +0.39 [-2.03, +3.07]      +0.91 [-0.52, +2.52]      -0.0322 (-2.76)       6/10
 *   2026-08  forward      +1.03 [-1.20, +3.46]      +0.35 [-1.67, +2.49]      -0.0221 (-1.89)       7/10
 *   2026-09  forward      +2.81 [+0.30, +5.68]      -0.04 [-2.12, +2.24]      -0.0121 (-0.99)       6/10
 *   2026-10  forward      +0.55 [-5.64, +8.37]      +1.92 [-0.33, +4.95]      -0.0461 (-2.03)       9/10
 *   year     mixed        +1.53 [+0.78, +2.33]      +1.19 [+0.27, +2.06]      -0.0190 (-5.62)       8/10
 *   (A: excess win rate in points over the span-wide matched baseline, 95% day-block interval; about 4,500 to
 *   5,600 resolved trades per month; B: about 7,200 to 7,440 pairs per month)
 *
 * Reading:
 * - B, the small-trade imbalance, is the steadiest: negative in 11 of 13 months and in all four forward months;
 *   its |IC| (about 0.02) stays below the 1h taker breakeven IC (0.0329).
 * - A1 and A2 are positive in most months (11 of 13 each) but each month's interval spans zero in most of
 *   them, and the forward months' level depends on the baseline: against this span-wide baseline A1 reads
 *   +0.4 to +2.8 forward and A2 -0.04 to +1.92, against the binding read's window baseline A1 read +0.48 and A2
 *   +1.46. An effect of about one point is the size of that baseline choice, so these monthly numbers do not
 *   sharpen the binding verdict.
 * - The first run matched the baseline within each month (superseded; see METHOD).
 */
