/**
 * QH-FLOW PHASE: quarter-hour opening order imbalance and trade-size-segmented taker flow, pre-registered.
 *
 * Why: the 2026-10-09 survey (plan ~/.claude/plans/pasted-content-id-e02e-i-will-dapper-bee.md, approved by
 * the user the same day) found no published input with out-of-sample, cost-aware evidence of crypto return
 * predictability at 1h or longer that the program lacks and has not closed. agy's second opinion agreed and
 * recommended stopping. The user picked this phase anyway, as the one venue-matched published claim:
 *
 * - Kim and Hansen, "The Quarter-Hour Effect: Periodic Algorithmic Trading and Return Predictability in
 *   Cryptocurrency Futures", arXiv 2607.09426 (v2 2026-07-16). Six Binance perpetuals (BTC, ETH, XRP, SOL,
 *   DOGE, ADA), 2021-01-01 to 2024-10-31. Taker order imbalance in the first 10 seconds after each
 *   quarter-hour mark is followed by a short reversal over about 30 minutes, then a continuation that peaks
 *   at 8 to 12 hours; significant at 95% for four of six contracts at every horizon from 4 to 12 hours. That
 *   result is IN-SAMPLE (full-sample regressions, no hold-out). Their out-of-sample result (rolling LASSO,
 *   mean R2 3.37%) predicts only the 10-second opening return, worth about 0.5 bp per boundary, a tenth of a
 *   taker fee. One-minute and five-minute marks show little predictive content in the paper.
 * - Trade-size-segmented taker flow: no crypto paper with out-of-sample evidence was found; equity evidence
 *   on size-based imbalance shows a structural break. It is included because it costs only extra columns on
 *   the same extraction, and the live recorder (`src/lib/market-recorder/trade-flow.ts`) writes the same
 *   definitions forward from 2026-10-08, which gives a forward check.
 *
 * Expected outcome, stated before any data is read: most likely another null. The program's closest analogue,
 * raw.depthFlow1 (flow is followed), measured about half the effect size a rule needs.
 *
 * STATUS: LOCKED once committed, before any archive file is read. Nothing below may change; a change means a
 * new pre-registration and new trials. Choices the text leaves open are recorded as implementation notes at
 * build time, before any IC run.
 *
 * TRIALS AND LEDGER
 *
 * - Budget 36 trials: 28 IC cells on the hold-out (4 columns x 7 interval-horizon cells: 1h at h 1, 4, 8, 12
 *   and 4h at h 1, 2, 3) plus at most 8 harness cells, run only if the kill criterion allows. Program ledger:
 *   1,741 before this phase; at most 1,777 after it. No trial outside this budget without the user's consent.
 * - The reproduction run on 2023-01-01 to 2024-10-31 is a diagnostic of the published sign. No decision reads
 *   it, so it is not counted as trials.
 *
 * DATA
 *
 * - The ten symbols BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK (USDT-M perpetual).
 * - Source: the Binance UM aggTrades MONTHLY archive (data.binance.vision, futures/um/monthly/aggTrades),
 *   months 2023-01 to 2026-06. Each file is streamed (download, inflate the single zip entry, parse, fold);
 *   raw trade rows are never stored. Taker side from `is_buyer_maker` (true = taker sell).
 * - Folded into 5-minute buckets keyed by trade time with the recorder's own functions (`bucketStartOf`,
 *   `sizeClassOf`, `aggressorOf`): per bucket, taker buy and sell quote (price x quantity, USDT) in total and
 *   by size class (small under 10,000, medium 10,000 to under 100,000, large 100,000 and up, per aggregate
 *   trade), plus the taker buy and sell quote of trades in the bucket's first 10 seconds
 *   ([bucketStart, bucketStart + 10,000 ms)).
 * - Stored in a new research-only production collection `archiveflowbars` (no live consumer), exported through
 *   a new `flow` dataset kind, hashed with the rest of the export. Forward returns come from perp closes.
 * - Lockbox: nothing from 2026-07-01 onward is read, with ONE declared exception, the extractor validation
 *   below, which compares flow sums only and never reads a price, return or factor.
 *
 * COLUMNS (decided at the close of bar t; every imbalance is signed quote over total quote, in [-1, 1]; a bar
 * with any of its 5-minute buckets missing, or a zero denominator, is null in all four columns)
 *
 * - raw.qhOpenImb: sum over the bar's quarter-hour marks (minute 0, 15, 30, 45 of each hour inside the bar: 4
 *   at 1h, 16 at 4h) of (buy - sell) first-10-second quote, divided by the sum of (buy + sell) first-10-second
 *   quote over the same marks. PREDICTED POSITIVE at 1h h 4, 8, 12 and 4h h 1, 2, 3; no prediction at 1h h1.
 * - raw.fiveMinOpenImb: the same over the bar's other 5-minute marks (8 at 1h, 32 at 4h). NEGATIVE CONTROL:
 *   PREDICTED NO EFFECT.
 * - raw.largeTakerImb: (large buy - large sell) quote over the bar's total (buy + sell) quote. PREDICTED
 *   POSITIVE (informed flow continues).
 * - raw.smallTakerImb: (small buy - small sell) quote over the bar's total (buy + sell) quote. PREDICTED
 *   NEGATIVE, low confidence.
 *
 * MEASUREMENT
 *
 * - factor-ic.ts, unchanged survivor machinery: `--return-series perp --execution-lag 1`, horizons 1,4,8,12 at
 *   1h and 1,2,3 at 4h, bootstrap 200 draws seed 42, `--factors` limited to the four columns.
 * - Windows: REPRODUCTION 2023-01-01 to 2024-10-31 (inside Kim and Hansen's sample; reported for the sign
 *   only, never used for selection); HOLD-OUT 2024-11-01 to 2026-06-30 (after their sample). Every verdict is
 *   judged on the hold-out only.
 * - Survivor rule as implemented in survivor-table.ts, unchanged: pooled |ic| >= 0.02 and |t| >= 3.15 at two
 *   or more horizons, same sign in 60% of quarters and in seven of ten symbols, Benjamini-Hochberg q 0.10
 *   across every pooled cell of this phase's hold-out reports. Its 0.02 floor exceeds the 1h and 4h maker
 *   breakeven ICs (0.0082 and 0.0034, frontier.ts), so a survivor also clears the cost bar for a
 *   continuation shape with maker entries.
 * - Shuffled-label null beside every real run: 200 draws, seed 7; each draw circularly shifts every symbol's
 *   column by an independent uniform offset of at least 30 days (preserving the column's autocorrelation),
 *   recomputes the pooled IC and t of every cell, and reports the null's 95th percentile |t| and the observed
 *   cell's empirical p. The null's standard deviation of pooled IC, times 3.15, is the hold-out detection
 *   floor; it is computed and recorded before the real hold-out cells are read.
 * - Spot check: one random cell per report re-run with `--cell --report` and reproduced digit for digit.
 *
 * KILL CRITERIA
 *
 * 1. If raw.fiveMinOpenImb survives on the hold-out (either sign), the measurement is suspect: stop and
 *    diagnose before any other cell is read as a finding.
 * 2. If none of raw.qhOpenImb, raw.largeTakerImb, raw.smallTakerImb survives on the hold-out with its
 *    predicted sign, the phase closes with a null. No harness run.
 * 3. If one survives, a single continuation family (at most 8 cells, maker and taker entry variants) is
 *    pre-registered as an amendment to this header before it runs: parameters selected on the reproduction
 *    window, evaluated with fixed parameters on the hold-out through strategy-gates.ts, trials gate at this
 *    phase's count of 36 with the program count reported only. Any failed gate (expectancy CI, windows,
 *    symbols, timing against random entry, deflated Sharpe, 1.5x fee and 2x slippage stress) closes the phase.
 * 4. A pass stops everything for the user. agy gives a second opinion. Nothing is deployed; production entry,
 *    if ever, is a separate approved plan at weight zero with forward-only validation.
 *
 * KNOWN CRITIQUE, recorded before the run (agy, 2026-10-09): a 10-second effect read at a 1h bar with one bar
 * of execution lag may be stale. The paper's effect peaks at 8 to 12 hours, and lag 1 skips its 30-minute
 * reversal, so lag 1 is consistent with the claim being tested; a stale effect shows up as a null.
 *
 * EXTRACTOR VALIDATION (before any ingest): the BTCUSDT daily aggTrades file for 2026-10-08 (and 2026-10-09 if
 * published) is folded by the extractor and compared with the live recorder's `tradeflowbars` documents for
 * the same buckets, complete buckets only. Pass: at least 95% of those buckets agree within 0.5% on total taker
 * buy quote and on total taker sell quote. A failure stops the phase until it is understood.
 */

/** Program trial ledger before this phase (event-studies.ts LEDGER_AFTER). */
export const QH_FLOW_LEDGER_BEFORE = 1_741;

/** Declared trial budget of this phase: 28 hold-out IC cells plus at most 8 harness cells. */
export const QH_FLOW_TRIAL_BUDGET = 36;

/** Program trial ledger after this phase: the 28 hold-out IC cells; the harness was not run (RESULT). */
export const QH_FLOW_LEDGER_AFTER = 1_769;

/** Inclusive window bounds, UTC. */
export const QH_FLOW_REPRODUCTION = { start: '2023-01-01T00:00:00Z', end: '2024-10-31T23:59:59Z' } as const;
export const QH_FLOW_HOLDOUT = { start: '2024-11-01T00:00:00Z', end: '2026-06-30T23:59:59Z' } as const;

/** Predicted pooled IC sign per column on the hold-out; 0 is the negative control (no effect). */
export const QH_FLOW_PREDICTED_SIGN = {
  'raw.qhOpenImb': 1,
  'raw.fiveMinOpenImb': 0,
  'raw.largeTakerImb': 1,
  'raw.smallTakerImb': -1,
} as const;

/*
 * IMPLEMENTATION NOTES, recorded at build time on 2026-10-09, before any archive month is ingested and before
 * any IC run. They settle choices the locked header leaves open; none changes a definition, a window, a
 * threshold or the trial budget.
 *
 * N1. One export, two windows. A single dataset (kinds candles, htf, perp, flow; 1h and 4h; ten symbols) is
 *     exported once and hashed; factor-ic.ts and qh-flow-null.ts select the REPRODUCTION and HOLD-OUT windows
 *     with --start/--end. Same data either way, one manifest hash to cite. The export CLI flag is --datasets.
 * N2. The detection floor is 3.15 x the null's standard deviation of pooled IC, from scripts/research/
 *     qh-flow-null.ts --null-only on the hold-out, run and recorded before the real hold-out run. frontier.ts
 *     is not involved: it converts strategy-report dispersion to breakeven IC and has no IC standard error.
 * N3. Matrix warmup. factors.ts fills every raw column only from warmupBars on (the longest indicator lookback,
 *     about 200 bars), so each measured window starts about 8 days (1h) or 33 days (4h) after its --start. This
 *     only shortens the declared windows; nothing crosses the reproduction/hold-out boundary.
 * N4. Out-of-order rows. The fold counts rows whose trade time falls before the open bucket; archive files are
 *     ordered by aggregate id, so zero is expected (BTCUSDT 2025-01: 55,419,155 lines, 0). Any nonzero count in
 *     the ingest summary is investigated before the export.
 * N5. Survivor family. survivor-table.ts is applied to this phase's HOLD-OUT reports only (1h and 4h); the
 *     reproduction reports never enter the Benjamini-Hochberg family because no decision reads them.
 * N6. The null uses factor-ic's own pooled (not cross-sectionally demeaned) statistic through an exported
 *     helper; the unshifted run reproduces factor-ic's pooled ic and t exactly (test in qh-flow-null.test.ts).
 * N7. Validation timing. The recorder's BTCUSDT bars start 2026-10-08 01:05 UTC; that day's daily archive file
 *     is published after UTC midnight, so the ingest waits for it, as the header requires.
 */

/*
 * AMENDMENT 1, 2026-10-09, before any archive month is ingested and before any IC cell is computed. It
 * TIGHTENS the locked protocol; it adds no trial (the 28 hold-out IC cells and the 8-cell harness cap are
 * unchanged, budget 36, ledger at most 1,777) and loosens nothing.
 *
 * Why: the branch's final review found that the locked null cannot see the pooled t's main weakness.
 * factor-ic's pooled t is a HAC t on all symbols concatenated, which ignores the correlation between
 * symbols at the same bar; shifting each symbol's column by an INDEPENDENT offset destroys exactly that
 * correlation, so the null's spread comes out too small. A standalone simulation with no effect (10
 * symbols, 3,000 bars, returns correlated 0.7 and the factor 0.4 across symbols, factor AR(1) 0.3, h 1;
 * script kept in the session scratchpad, rerun by the controller with the same output) gives:
 *   sd of pooled IC: true no-effect 0.01019, independent-offset null 0.00575, common-offset null 0.01000
 *   p95 |t|:         true no-effect 3.67,    independent-offset null 1.92,    common-offset null 3.52
 *   and |t| >= 3.15 in 8.0% of no-effect datasets against 0.16% nominal.
 *
 * A1-1. The null draws ONE offset per draw, shared by every symbol, applied on the common bar grid (the
 *       intersection of the symbols' bar timestamps inside the window, after the matrix warmup); the
 *       number of bars each symbol loses to the intersection is reported. Everything else in the locked
 *       null (200 draws, seed 7, offsets of at least 30 days, the statistic) is unchanged.
 * A1-2. A predicted column survives on the hold-out only if, in addition to the unchanged survivor rule and
 *       the predicted sign, at the passing horizons its |pooled IC| is at least that cell's detection
 *       floor, 3.15 x the A1-1 null's standard deviation of pooled IC. The floor reports are produced and
 *       committed before the hold-out factor-ic run.
 * A1-3. Clarification of the two-horizon requirement against the locked predictions: only horizons that
 *       pass with the PREDICTED sign count, and raw.qhOpenImb at 1h h1 (no prediction) never counts.
 * A1-4. The Benjamini-Hochberg family is exactly the 28 pooled cells of the two hold-out reports (1h and 4h,
 *       --factors limited to the four columns); a verdict script asserts the count, the dataset hash, lag 1,
 *       perp returns and the horizons before applying the rule, so the family cannot be widened by running
 *       without --factors.
 *
 * Also recorded (not an amendment, a fix to match the locked text): COLUMNS says a zero denominator makes
 * ALL FOUR columns null for that bar; the first implementation nulled only the affected column and is
 * corrected to the locked rule.
 */

/*
 * EXECUTION NOTES, recorded as the run proceeds. None changes a definition, a window, a threshold or the
 * trial budget.
 *
 * E1. Ingest order (2026-10-09, user-approved). EXTRACTOR VALIDATION says "before any ingest". Binance
 *     publishes a daily file at about 07:10 to 07:30 UTC the next day (Last-Modified of the BTCUSDT
 *     2026-10-05, -06 and -07 files), so the 2026-10-08 file was not available until about 07:15 UTC on
 *     2026-10-09, and no older day can stand in: the recorder starts 2026-10-08 01:05 UTC. At the user's
 *     request the ingest runs beside the wait instead of after it. The validation still gates everything
 *     that reads the ingested data: no export, null or IC run happens before it passes, and a failure
 *     means the extractor is fixed and every month re-ingested with --refresh before anything is read.
 *     The ingest reads no price, return or factor. Before it, a fold that wrote nothing tested the real
 *     zip64 path: BTCUSDT 2026-02 monthly, 84,154,791 rows, 8,064 buckets (28 x 288), outOfOrder 0,
 *     5,591,936,940 bytes inflated, 467 s, 22 MB heap.
 * E2. Extractor validation waived as a gate (2026-10-09, user decision). The user chose not to wait for the
 *     2026-10-08 daily file. Fold correctness is established instead by scripts/ops/check-agg-flow-naive.ts,
 *     an independent re-sum of sample DAILY files with an exact rule (relative error <= 1e-9, counts equal,
 *     identical bucket sets) declared before any run. What the waiver gives up is the recorder-vs-archive
 *     agreement, which matters only for the forward-only validation of a passing candidate; the validation
 *     still runs when the file is published and its result is reported, not gated.
 *     Also recorded: scripts/ops/check-agg-flow-klines.ts FAILS its declared rule (BTCUSDT 2023-01..2026-02:
 *     coverage complete both ways, invariants clean, but volume within 1e-6 in 83.5% of buckets). Cause, shown
 *     on BTCUSDT 2025-10-01: Binance's TRADES file bucketed by each fill's own time reproduces the klines
 *     exactly (0 of 288 buckets off), while 189,272 of 1,368,367 aggregate trades hold a fill timed up to 100
 *     ms after the aggregate's transact_time, so 230 fills that day sit in the next 5-minute bucket of the
 *     klines. This phase's definition is the aggregate's transact_time, as the locked header and the recorder
 *     use; the rule is not loosened.
 *     N4 finding: the SOLUSDT monthly files for 2023-11 and 2023-12 are not time-ordered (outOfOrder
 *     28,448,315 and 34,283,867); every day of both months was re-ingested from the daily files
 *     (--daily-repair, 61 days, each 288 buckets, outOfOrder 0) and passes the naive check with relative
 *     error 0. Their archiveflowfiles rows keep the monthly outOfOrder value; coverage is refreshed.
 * E3. Data and floors, recorded BEFORE any hold-out IC cell is computed (2026-10-09).
 *     Ingest: 420/420 monthly files complete; archiveflowbars 3,677,680 buckets = 10 x 367,776 minus 80,
 *     the only gaps being 2023-09-12 (3 buckets), 2024-10-28 (2) and 2025-08-29 (3), identical in all ten
 *     symbols (exchange-wide halts, absent from the daily files too). check-agg-flow-naive.ts on its 80
 *     default samples: 80/80 pass, relative error 0 everywhere. The extractor validation ran after all
 *     (file published 2026-10-09 06:39 UTC): PASS, 268/268 complete buckets within 0.5%, worst 0.31%.
 *     Dataset: export-dataset.ts --datasets candles,htf,perp,flow --intervals 1h,4h --start
 *     2023-01-01T00:00:00Z --end 2026-06-30T23:59:59Z, image crypto-ops:qh-flow2 (c183f91), dataset hash
 *     a15dfe0fae98f8baae36010ca6b8147c9ed8f6477173a11d96f90ea17298fc43.
 *     Floors: qh-flow-null.ts --interval 1h|4h --dataset-dir <export> --start 2024-11-01T00:00:00Z --end
 *     2026-06-30T23:59:59Z (defaults: lag 1, perp, locked horizons, the four columns, 200 draws, seed 7,
 *     30 days, null-only). Common grid 14,369 bars at 1h (from 2024-11-09T07:00) and 3,443 at 4h (from
 *     2024-12-04T04:00), no symbol drops a bar; 200/200 valid draws in every cell. Report sha256:
 *     1h d3a207eb101b0fe7abe223755db15f654865157ab8a6e5703b7aa4cf7f111407,
 *     4h 63b0d4ca790d0e7c518922b79259c785ea69a980a5ce9b794de5791dce2132e2.
 *     Floor (3.15 x null sd of pooled IC), 1h h 1/4/8/12, then 4h h 1/2/3:
 *       raw.qhOpenImb       0.0145 0.0154 0.0173 0.0182 | 0.0281 0.0334 0.0340
 *       raw.fiveMinOpenImb  0.0134 0.0134 0.0151 0.0154 | 0.0276 0.0263 0.0277
 *       raw.largeTakerImb   0.0107 0.0109 0.0121 0.0127 | 0.0227 0.0250 0.0245
 *       raw.smallTakerImb   0.0121 0.0128 0.0136 0.0139 | 0.0242 0.0258 0.0252
 *     At 1h every floor is below the unchanged rule's |ic| >= 0.02, which therefore binds; at 4h the floor
 *     binds. Both exceed the maker breakeven ICs of kill criterion 1 (1h 0.0082, 4h 0.0034).
 */

/*
 * RESULT, 2026-10-09: NULL. The phase closes under KILL CRITERION 2; no harness run.
 *
 * Inputs: dataset a15dfe0fae98f8baae36010ca6b8147c9ed8f6477173a11d96f90ea17298fc43, image crypto-ops:qh-flow2
 * (c183f91), reports on the VPS in $HOME/qh-flow-out/ (local copies in data/research/reports/qh-flow/, sha256):
 *   ic-holdout-1h  f5148e7dd32472811ca3aa385b82ee725eee82bde8341c3f0d8ea4d3cf5aba8f
 *   ic-holdout-4h  5672c779d93ad5de043ba6856c9a116a54854c06a7d2d9ac571fb9e7bf03c779
 *   ic-repro-1h    c30028d3dda9b16124b39570fe06ca7e673dd83575437bfc508a171b016eb80c
 *   ic-repro-4h    f5b6892c980d41b0569376b8aee2db7bdb6e0953912e9b7f12b56aca4771486b
 *   verdict        4858e5de69ec9080d7dd6cb79ec66f1932b0f03dc75be1a654e712d2b0898f97
 *   null-observed-1h 6922f4c8977924d5c296bf02d09038aa12a1adb9872ca078bf44183f82419661
 *   null-observed-4h 0bbdb47a06034548a4c856cea63acbfe1f094e780337b7caa2d75e389b85c5aa
 * Commands: factor-ic.ts --interval 1h --horizons 1,4,8,12 (4h: 1,2,3) --factors <the four> --execution-lag 1
 * --return-series perp --expect-manifest-hash <hash> --start 2024-11-01T00:00:00Z --end 2026-06-30T23:59:59Z
 * (reproduction: 2023-01-01T00:00:00Z to 2024-10-31T23:59:59Z); qh-flow-verdict.ts --report-1h --report-4h
 * --floor-1h --floor-4h; qh-flow-null.ts --with-observed --floor-report <floor> on the hold-out.
 *
 * Verdict (qh-flow-verdict.ts): the control raw.fiveMinOpenImb does not survive (kill criterion 1 not
 * triggered); none of the three predicted columns survives with its predicted sign (kill criterion 2). No cell
 * clears |ic| >= 0.02. Benjamini-Hochberg q 0.10 over the 28 cells rejects 7 by p-value alone (`fdr.rejectedCells`);
 * the per-cell `fdrRejected` field means rejected AND clearing |ic| and |t|, so it is false everywhere.
 *
 * Hold-out pooled ic / HAC t / empirical p (common-offset null, 200 draws; 0.005 is its minimum, 1/201 rounded):
 *   1h        h1                     h4                     h8                     h12
 *   qhOpen    -0.0001 -0.02 0.995    +0.0014 +0.52 0.741    +0.0034 +1.21 0.607    +0.0018 +0.61 0.756
 *   fiveMin   +0.0057 +2.25 0.159    +0.0029 +1.12 0.517    +0.0018 +0.69 0.711    +0.0021 +0.79 0.662
 *   large     -0.0103 -4.12 0.010    -0.0041 -1.57 0.209    +0.0015 +0.55 0.652    +0.0037 +1.34 0.363
 *   small     -0.0154 -5.86 0.005    -0.0087 -3.05 0.035    -0.0044 -1.43 0.303    -0.0087 -2.69 0.050
 *   4h        h1                     h2                     h3
 *   qhOpen    +0.0133 +2.54 0.134    +0.0113 +2.13 0.313    +0.0050 +0.93 0.587
 *   fiveMin   -0.0092 -1.75 0.289    -0.0036 -0.68 0.697    +0.0076 +1.43 0.433
 *   large     -0.0073 -1.42 0.318    +0.0061 +1.17 0.478    +0.0122 +2.29 0.109
 *   small     -0.0088 -1.63 0.244    -0.0118 -2.10 0.119    -0.0082 -1.42 0.274
 *   n: 143,660 pooled pairs at 1h h1, 34,400 at 4h h1.
 *
 * Reproduction window (sign only, inside Kim and Hansen's sample), pooled ic / t:
 *   1h qhOpen +0.0112 +4.71 | +0.0154 +5.72 | +0.0160 +5.46 | +0.0102 +3.36   (h 1, 4, 8, 12)
 *   4h qhOpen -0.0052 -1.07 | -0.0098 -1.98 | -0.0087 -1.73                   (h 1, 2, 3)
 *   1h large  -0.0070 -2.93 | -0.0081 -3.27 | -0.0014 -0.54 | +0.0018 +0.71
 *   1h small  -0.0048 -1.90 | -0.0035 -1.32 | -0.0035 -1.26 | -0.0048 -1.66
 *
 * Reading, against the predictions:
 * - raw.qhOpenImb: the paper's continuation sign appears at 1h in its own sample (ic +0.015 to +0.016 at h 4
 *   and 8, still below 0.02) and is gone after it (+0.0014 and +0.0034, p 0.74 and 0.61). The 4h sign flips
 *   between the windows. Prediction (positive at h 4 to 12) WRONG on the hold-out.
 * - raw.fiveMinOpenImb (control): no effect, as predicted. Its 1h h1 HAC t of 2.25 has an empirical p of 0.159,
 *   which is why the rule carries the |ic| and floor legs as well as BH.
 * - raw.largeTakerImb: negative at 1h h1 in both windows (hold-out -0.0103, p 0.010), the OPPOSITE of the
 *   informed-flow prediction; positive only at long horizons, where nothing is significant.
 * - raw.smallTakerImb: negative, as predicted, and the strongest cell of the phase: 1h h1 -0.0154, t -5.86,
 *   beyond all 200 null draws, above its floor 0.0121. It fails the unchanged rule on size (|ic| < 0.02) and
 *   on horizons (one horizon; h4 -0.0087, t -3.05). It is a next-hour reversal after one bar of lag, below the
 *   1h taker breakeven IC of 0.0329. Not a pass. Reopening it needs the user's consent and would be a new
 *   trial on an already-read hold-out.
 *
 * Spot checks (factor-ic --cell --report, all digit for digit, ic and n): hand-picked holdout-1h
 * raw.smallTakerImb:1 -0.015427849405436844, holdout-1h raw.largeTakerImb:1:BTCUSDT -0.016644494742907797,
 * holdout-4h raw.qhOpenImb:1 0.013319808683161922, repro-1h raw.qhOpenImb:8 0.015974456040421473; random
 * (Python random seed 20261009, one per report) holdout-1h raw.fiveMinOpenImb:12:ETHUSDT
 * -0.0037303764874138997, holdout-4h raw.largeTakerImb:1:BNBUSDT -0.006431387002289601, repro-1h
 * raw.smallTakerImb:4:BTCUSDT 0.012192789286547686, repro-4h raw.smallTakerImb:3:LINKUSDT -0.0032018736381965725.
 *
 * Trials: 28 hold-out IC cells; the 8 harness cells were not used. Program ledger 1,741 -> 1,769.
 * Erratum: E3's last sentence attributes the maker breakeven ICs to kill criterion 1; they are in MEASUREMENT.
 */
