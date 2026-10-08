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
