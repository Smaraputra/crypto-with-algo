/**
 * RV RE-VALIDATION: the frozen live 8h cross-sectional relative value rule (rv-v1) tested on perpetual
 * prices with Timothy Masters' four steps. Pre-registered.
 *
 * WHY: the previous validation of the live 8h cross-sectional relative value system is void (audit
 * 2026-10-14, defect table D01 to D28 in the session 30 handover). The void items:
 * - the walk-forward null is a synthetic Gaussian walk (scripts/research/cross-sectional-walkforward.ts
 *   lines 393-401), not a permutation of the real bars
 * - the permutation test (cross-sectional-permutation.ts) is fixed-parameter and in-sample, and leaves
 *   the funding series unpermuted
 * - the prices were spot candles (load-dataset.ts line 97), and dataset 48ff79609080 held no perp data
 * - the deflated Sharpe used trials 54 and an assumed variance (cross-sectional-harness.ts lines 175
 *   and 236)
 * - there was no pre-registration, and the lockbox was used in every development run
 * Purpose: test the frozen live rule rv-v1 on perp prices with Masters' four steps (as implemented in
 * github.com/neurotrader888/mcpt), so the user can decide whether the RV claim stands.
 *
 * STATUS: LOCKED before any perp history is read for this rule. Amendments may only tighten and only
 * before the `inputs` stage runs. Each amendment is its own commit named "AMENDMENT n".
 * Fix round before publication (2026-10-15): calibration rules, warmup placement, seeds and the G3
 * convention sentence were corrected before any data was read. Second review (agy, 2026-10-15), also
 * before any data was read: planted-edge calibration rule, step 4 M raised to 1,000, step 2 and step 4
 * permutation boundaries, complete-fold rule and continuous stitching in step 3, exact panel
 * cross-check tolerances, permuted funding timestamps, desk bootstrap parameters and seed, and the
 * recorded G3 objection.
 *
 * WHAT IS ALREADY KNOWN (disclosed, not hidden):
 * - Spot, full span 2021-10 to 2026-10-12 (5,462 8h bars), live configuration: +250.43% net maker,
 *   +117.80% net taker, about 180x annual turnover (VPS report-stop-control.json, void as validation).
 * - Spot, 2026-07-01 to 2026-10-12: about -5.3% net maker, -8.4% net taker.
 * - The lockbox (2026-07-01 onward) is spent for this rule: every development run used --allow-lockbox.
 *   No untouched holdout exists. The restarted forward desk (rv-v1, perp prices, from its restart date)
 *   is the only clean test.
 *
 * REFERENCE: Masters, Permutation and Randomization Tests for Trading System Development (2020).
 * neurotrader888/mcpt (bar_permute.py, insample_donchian_mcpt.py, walkforward_donchian_mcpt.py).
 * Bailey and Lopez de Prado (2014) for the deflated Sharpe.
 *
 * DATA
 * - Export into a fresh $HOME/rv2-ds on the VPS with export-dataset.ts: symbols BTCUSDT, ETHUSDT,
 *   BNBUSDT, SOLUSDT, XRPUSDT, ADAUSDT, DOGEUSDT, AVAXUSDT, DOTUSDT, LINKUSDT, with
 *   `--datasets perp,funding --perp-series klines --intervals 1h,4h`, start 2022-01-01T00:00:00Z,
 *   end 2026-10-13T23:59:59.999Z. The loaders run with allowLockbox true (declared above).
 * - 8h panel: pair 4h perp klines into 8h bars at 00, 08 and 16 UTC. Drop a bucket missing either half
 *   and count it. HALT if more than 3 buckets are dropped across the panel. HALT on any null taker-buy
 *   volume. Per-bar funding is the sum of settlements in (bar open, bar close]. HALT on any missing due
 *   settlement (the interval is derived from the spacing of consecutive settlements when intervalHours
 *   is null, which is the case for rows written by the REST sync). Cross-check: 8h bars built from 4h
 *   and from 1h must match exactly in open, high, low and close, and within a relative tolerance of
 *   1e-7 in volume and taker-buy volume. Any mismatch beyond that halts the study.
 * - The dataset manifest hash and the panel sha256 are recorded in RESULT and asserted by every stage.
 *
 * RULE (frozen as rv-v1, the shared engine src/lib/signals/cross-sectional/engine.ts RV_V1)
 * - Weights: mom 0.30, idio 0.25, carry 0.30, flow 0.15.
 * - Momentum and beta window 42 bars (43 closes). Flow window 43 bars.
 * - Carry is minus the latest settled funding rate with fundingTime in (bar close - 8h, bar close].
 * - Beta: OLS against BTC paired by openTime, clamped to [0.1, 3.0], BTC = 1.
 * - Cross-sectional z-scores with sample sd and a winsorisation limit of 3 (which cannot bind with 10
 *   symbols: max |z| = 9 / sqrt(10) = 2.846).
 * - 2 long and 2 short legs. Hysteresis buffer 2 with autoClampBuffer. Beta-neutral basket-average
 *   sizing. Gross 1.0.
 * - Deviations from the old live code, each a defect fix: retained legs trimmed by rank (D13), a held
 *   symbol with missing data is never exited and the step waits (D07), perp prices (D03), missing
 *   taker-buy volume halts instead of defaulting to 0.5 (D12), legs sized from one equity snapshot
 *   (D08). Two frozen quirks are kept and disclosed: the beta floor of 0.1 (D27) and carry not
 *   normalised for 4h-interval symbols (D24).
 * - Execution: signal at bar t close, fill at the open of bar t+1 (execution lag 1). Taker track: fee
 *   0.05% plus 2 bps slippage per side (primary). Maker track: fee 0.02% with the engine's fill model
 *   (filled only if the first 1h bar trades through the limit at the open, else taker at that 1h
 *   close), REPORTED only. Trades are netted deltas.
 *
 * CELLS (index = 4 * buffer + 2 * betaNeutral + flowOn)
 * - buffer {0, 1, 2} x betaNeutral {false, true} x flow {off: weights .40/.30/.30/0, on:
 *   .30/.25/.30/.15}, 12 cells. rv-v1 is cell 11 (buffer 2, betaNeutral true, flow on). Ties go to the
 *   lowest index. The momentum lookback is not varied.
 *
 * OBJECTIVE
 * - Per-bar net Sharpe on the taker track: mean over sample sd of the per-bar portfolio net returns,
 *   open-to-open, including funding. Annualised figures are reported only, with factor
 *   sqrt(365.25 * 3), asserted in a test.
 *
 * STEP 1, in-sample excellence: all 12 cells on the full span. Record each cell's objective and the
 * best cell.
 *
 * STEP 2, in-sample permutation: M = 1,000. The permutation follows mcpt bar_permute. Per symbol, the
 * log gap (open minus previous close) is permuted with one index and the intrabar tuple (high, low,
 * close relative to open, with per-bar funding sum, volume and taker-buy volume) is permuted with a
 * second index. Both indices are shared by all symbols. Bar 0 stays real and permutation begins at
 * bar 1 (start_index = 0). Permuted bars keep their position's timestamp: a permuted funding value is
 * stamped at the close of the bar it lands on, so carry freshness is judged on the permuted timeline.
 * Prices are rebuilt by compounding. Each permutation re-runs all 12 cells and records the best
 * objective. p = (1 + #{null best >= real best}) / (M + 1).
 *
 * STEP 3, walk-forward: rolling training window 1,095 bars, test and step 273 bars, warmup 43 bars.
 * The 43 warmup bars sit inside the first training window (training window 1 = bars 0 to 1,094, with
 * signals from bar 43). The training objective counts only bars with a signal and returns realised
 * inside the training window. The selected cell
 * trades the next test window and positions carry across folds. Only complete 273-bar test folds are
 * evaluated. Any trailing remainder shorter than 273 bars is dropped. Stitched out-of-sample returns
 * are continuous across fold boundaries. Positions carry over, and the rebalance cost of a newly
 * selected cell is charged on the first bar of its fold. The stitched out-of-sample objective is the
 * result. No embargo (forward-only walk-forward, boundary returns are excluded by the rule above). A
 * 1-bar purge sensitivity is reported.
 *
 * STEP 4, walk-forward permutation: M = 1,000. Bars 0 to 1,094 (the first training window) stay
 * real and permutation begins at bar 1,095, including bar 1,095's gap. In neurotrader888/mcpt's
 * convention this is start_index = 1,094. Later bars are permuted with the step 2 scheme. The whole
 * walk-forward, with per-fold re-selection, is re-run per permutation. p is computed as in step 2 on
 * the stitched objective.
 *
 * SEEDS: base 20261014. The permutation index m runs from 1 to M. Step 2 permutation m uses base + m.
 * Step 4 uses base + 100,000 + m. The desk bootstrap uses base + 400,000. Calibration universe seeds:
 * iid k = 1..100 uses base + 200,000 + k, planted k = 1..10 uses base + 210,000 + k, GARCH k = 1..10
 * uses base + 220,000 + k. Inner permutation m of calibration universe seed s uses s * 10,000 + m. The
 * block sensitivity uses base + 300,000 + m.
 *
 * CALIBRATION ACCEPTANCE (run on synthetic data before the real data is read)
 * - Synthetic panels have 10 symbols and 3,000 8h bars.
 * - Driftless iid universe: step 2 over 100 seeds at M = 99, and step 4 over 100 seeds at M = 99. Pass
 *   when the Kolmogorov-Smirnov p against uniform is above 0.01 and the share of seeds with p <= 0.05
 *   is at most 0.11 (an upper bound only: it catches an anti-conservative test, which is the dangerous
 *   direction).
 * - Planted-edge universe: each symbol i has a latent score s(i,t) following AR(1) with coefficient
 *   0.95 and unit stationary variance. The next 8h log return is beta(i) times a common market return
 *   plus kappa times s(i,t) plus idiosyncratic noise. The settled funding rate is minus c times s(i,t)
 *   plus noise, so the carry factor reads the score. Volume and taker-buy volume carry a weak positive
 *   loading on s(i,t). kappa is fixed once so that rv-v1's annualised net taker Sharpe on the full
 *   panel lies in [3, 4]. 10 seeds at M = 199 in both steps. Pass when at least 9 of 10 seeds have
 *   step 2 p <= 0.01 and at least 8 of 10 seeds have step 4 p <= 0.01.
 * - GARCH universe: 10 seeds, reported only.
 * - Failing an acceptance rule stops the study until the machinery is fixed.
 *
 * VERDICT (all three must pass)
 * - G1: step 2 p < 0.01.
 * - G2: step 4 p < 0.01.
 * - G3: deflated Sharpe probability of rv-v1's (cell 11) full-span per-bar net-taker series >= 0.95 at
 *   N = 672, with V = max(sample variance of the 12 cells' per-bar Sharpes, 1 / (T - 1)). N = 672 is
 *   the full product of what the previous agent varied: buffer 3 x beta-neutral 2 x flow weight 2 x
 *   stop variants 7 x cadence 2 x execution 2 x flow window 2. It bounds unknown ad hoc runs and
 *   contains the 12 cells. Under the program's convention, which gates at the phase's own trial count,
 *   N = 672 is this phase's count. N = 26 and the program count 2,161 are reported only and never gate.
 * - G1 and G2 test the 12-cell family. G3 tests rv-v1 itself.
 * - Reviewed objection, rejected before publication: gating G3 at N = 12 would hide the earlier search
 *   on this same data. The gate requires roughly 2.2 annualised and an edge of that size passes it.
 *
 * REPORTED, never gating: maker track, gross, profit factor, max drawdown, turnover, per-year results,
 * the 2026-07-01 to 2026-10-13 slice, funding versus price decomposition of PnL, selected cell per
 * fold, a 12-cell neighbour table of net Sharpe, a block-permutation sensitivity of step 2 with block
 * length 9 bars (3 days) and M = 1,000, deflated Sharpe at N = 26 (14 recorded configurations plus 12)
 * and at the program count 2,161, one combined stress run at 1.5x fees and 2x slippage, the 1-bar
 * purge sensitivity, and desk fill quality by rebalance hour (00, 08, 16 UTC) and weekday or weekend,
 * recorded by the forward desk, reported with the desk read, never part of this study's gates.
 *
 * TRIALS: the program ledger moves from 2,135 to 2,161 (the previous agent's 14 recorded
 * configurations, never added before, plus these 12 cells).
 *
 * POWER: T is about 5,200 bars. The standard error of a per-bar Sharpe is about 1 / sqrt(T) = 0.0139
 * (about 0.46 annualised). The expected maximum Sharpe at N = 672 will be stated as computed by
 * src/lib/stats/deflated-sharpe.ts once the variance is known, and G3 is expected to need roughly 2
 * annualised.
 *
 * PREDICTIONS (recorded before any data):
 * - G3 fails.
 * - Carry dominates the PnL (funding share of net PnL above 50%).
 * - Step 2 may pass because funding persistence is real structure that a single-bar shuffle destroys.
 *   The block sensitivity will show how much of it survives.
 * - The walk-forward selects different cells across folds.
 *
 * DESK READ RULE (the forward desk is the only clean test)
 * - The rv-v1 desk is descriptive until it has 1,095 steps (one year). Then the one-sided 95%
 *   moving-block bootstrap lower bound of the mean per-step net-taker return must exceed zero (block
 *   length 9 steps). At exactly step 1,095 the moving-block bootstrap is evaluated once with
 *   B = 10,000 resamples, block length 9 steps, seed base + 400,000. Later reads happen only at
 *   multiples of 1,095 steps, never continuously. Alerts (not freezes): a 15% drawdown from peak or 10
 *   consecutive negative steps raise a flag on the book.
 *
 * FAILURE ACTION (the user's ruling, 2026-10-14): if any gate fails, the desk keeps recording rv-v1 as
 * a descriptive forward test labelled "not validated", the docs record the failure, and the card stops
 * presenting RV as an active strategy.
 *
 * PHASE V INPUTS (video research, 2026-10-15), the rulings that shaped this lock:
 * - Block sensitivity reported (N1, N20).
 * - Neighbour table reported and no all-cells rule (N22).
 * - Desk fill quality by rebalance hour and weekday (N23).
 * - Full 12-cell selection inside both permutation steps (N14).
 * - No runs test (N4).
 * - Annualisation derived from the bar interval (M23, stale factor).
 * - Netted deltas only (M21).
 * - No embargo in a forward walk-forward (M13).
 * - Alerts not freezes on the desk (agy proposal, adjusted).
 */

export {};

