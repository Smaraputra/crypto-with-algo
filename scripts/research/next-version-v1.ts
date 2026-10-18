/**
 * NEXT VERSION, ROUND 1: one pre-registered historical round for a new scorer, a confirmation-delay
 * ("delayed scorer") version of the old one, and a volume-profile idea, measured across eras and training
 * lookbacks. Pre-registered.
 *
 * WHY: the owner asked (2026-10-18) for a new live scorer with a real edge after costs that holds
 * consistently across time, a delayed scorer, a recheck of past data and calculations, a comparison of new
 * and old scores, and spans of 3, 5 and all years both as separate eras and as training lookbacks. No rule
 * has passed in 2,169 trials. A historical pass here means "survives the historical test or screen", never
 * "verified": only a forward e-process crossing in lab-v2 verifies.
 *
 * STATUS: LOCKED. This file's presence is what lets `nv1-c1-scores.ts --holdout`, `nv1-c1.ts test` and
 * `nv1-c2.ts run` read holdout segment A. Every value below was fixed before segment A was read. Amendments
 * may only tighten, only before the run they affect, and are each their own commit named "AMENDMENT n".
 * Design and review: `.superpowers/sdd/next-version/r3-design.md` (v3) was reviewed twice by a Sonnet
 * subagent and once by agy (Gemini, run 20261018-203928-d84453); every finding was checked against the code
 * and answered there. The code was reviewed by Claude (core, C1, C3) and a Sonnet subagent (C2).
 *
 * WHAT WAS READ BEFORE THE LOCK (disclosed):
 * - The read-history map (agy run 20261018-195637-f029d3, key citations re-checked) fixed segment A: spot
 *   1h and finer unread before 2021-10-14, spot 4h and 1d unread before 2018-10-31, perp intraday before
 *   2022-01-01, perp 1d before 2020-01-01, funding effectively all read.
 * - R1d integrity audit of production spot candles (counts only, no returns): 0 OHLC violations, gaps only
 *   at exchange-wide outages (2018-02-08 about 32h, 2018-06-26, 2019-05-15, 2019-08-15, 2020-02-19,
 *   2020-12-21, 2021-04-25, 2021-08-13), 43 off-grid 1h bars for BTC, ETH and BNB after 2018-02-09 09:28:14.
 *   Rulings: gaps stay gaps, off-grid bars are dropped, zero-volume bars stay.
 * - B and C (development, read by earlier studies): C1's |score| distribution (scores only, no outcomes)
 *   gave the cutoffs below; the C1 calibration replays ran on A-length slices of B plus C.
 * - The C3 kline approximation was measured on 20 days of 2024 (BTC, ETH) against aggTrades: median error
 *   in % of the day's range POC 3.0, VAH 1.0, VAL 1.5, but 20 to 76% on several two-peaked days. C3 tests a
 *   KLINE-APPROXIMATED value-area rule, not the true volume profile.
 * - R2: the v8 re-score statistics were reproduced exactly and the rv-v1 re-validation step 1 closely
 *   (per-cell per-bar Sharpe within 0.001 to 0.003) by blind recomputes from their lock text.
 *
 * DATA: dataset `nv1-ds` on the VPS, hash 414fef1ee6ccf45fcb6e6a7e25ad8a5c3a3ea24176b40cfd7158e8cf2a906e5f
 * (spot 1h and 1d from each coin's first bar in 2017 to 2026-06-30, 15m from 2021-10-24, manifest records
 * HOLDOUT_A). The 2026-07-01 lockbox is excluded.
 *
 * SEGMENTS (`NV1_SEGMENTS`, half-open, UTC): A1 2017-08-17 to 2018-10-31, A2 2018-10-31 to 2021-10-14,
 * B 2021-10-14 to 2023-10-14, C 2023-10-14 to 2026-07-01. A1 is unread at every cadence; A2 is unread at
 * 1h and below and was read at 4h and 1d by earlier studies.
 *
 * C1, OLD SCORE DELAYED (gated). v8's research path with only its price categories (trend, momentum, volume,
 * volatility), spot 1h, style day_trading; futures, news, sentiment and the 4h confirmation OFF in every era.
 * BUY at score >= c90, SELL (a paper short) at <= -c90. Per coin, a trade opens at bar t when flat and the
 * same side held at t-k..t, holds 24 bars, net = d x 24-bar return x 100 - 0.16. k in {0, 1, 2, 3}. Test on
 * A (A1 plus A2, about 4 years, clean at 1h): statistic = max over assessable k of (N_k - null mean) / null
 * sd, against a persistence- and drift-preserving null that rotates each coin's side series within its own
 * span by round(u x n) with one u per draw (u in [m, 1 - m], m = 720 bars / shortest span). Standardise
 * with 1,000 draws (seed 20261018), null maximum from 10,000 draws (seed 20261019). PASS iff the observed
 * max exceeds the null's 95th percentile AND N at the argmax k is above 0. A k needs 400 trades and 40
 * weeks of timeline. Because drift and side balance are kept, a pass means skill beyond drift and
 * persistence. If the balanced 5-coin universe (BTC, ETH, BNB, ADA, XRP) has the opposite sign of N at the
 * argmax k, the result is "not robust to universe" and is not registered. Plateau at c85 and c95 is
 * reported; a pass whose neighbours flip the sign of N is registered with a "fragile" flag.
 * CALIBRATION (before the lock, output sha256 514d72e0b791, 200 replays): false-pass 0.045 (Wilson 95%
 * 0.024 to 0.083, gate at most 0.08: PASS); power at E = 0.1, 0.2, 0.3 percent per trade 0.265, 0.695,
 * 0.970 (gate at E = 0.2: at least 0.5, PASS).
 *
 * C2, NEW LIVE SCORER (screen). Weekly cross-sectional ridge (lambda 1, intercept unpenalised) on five
 * spot features (residual return 1 and 4 weeks against BTC with a 90-day clamped beta, 4-week volatility,
 * 1-week taker-buy share, 4-over-12-week volume trend), z-scored weekly; target the next week's z-scored
 * residual return; walk-forward refit every Monday with a one-week embargo on trailing windows of 156 weeks,
 * 260 weeks and all history (segment A is TRAINING data only, read after this lock); rank-weighted paper
 * long-short book with cost 0.0007 per unit of turnover and funding excluded; delay k in {0, 1, 2, 3}.
 * A cell survives if its mean weekly net and IC are both above 0 in B and in C and its B-plus-C mean IC
 * exceeds the 90th percentile of 200 within-coin feature-permutation placebos (seeds 20261200 + p). The
 * best surviving cell by IC goes forward. The expected null promotion rate is reported.
 *
 * C3, VOLUME PROFILE (screen). Daily value area (70%, 200 linear bins, proportional overlap, from 96 spot
 * 15m bars) of the prior two UTC days; +1 if the midpoint rose by more than 0.25 x the earlier width, -1 if
 * it fell by more; per-coin one-day trades, cost 0.14; k in {0, 1, 2, 3}. B and C only. A k survives if N
 * is above 0 in B and in C and its pooled N exceeds the 90th percentile of 1,000 null draws (seed 20261300).
 * Plateau thresholds 0.15 and 0.35 are reported.
 *
 * FORWARD: lab-v2 has four slots fixed now, alpha 0.01 / 4 each whether filled or not (e-threshold 400):
 * C1's pass, C2's survivor, C3's survivor, one reserved. A forward hypothesis is frozen exactly as tested.
 *
 * PREDICTIONS (recorded before segment A is read):
 * - C1 fails: v8's price categories are trend-following, and every intraday trend input measured on this
 *   program predicted with the wrong sign or not at all; the delay most likely helps no k.
 * - C2: at most one cell survives the screen, with a mean IC near 0.02; the expected null promotion rate
 *   is above 0.2, so a survivor alone is weak evidence.
 * - C3: no k survives; the value-area migration has no net edge at a one-day horizon after 0.14%.
 *
 * TRIALS: the program ledger moves from 2,169 to 2,189 (C1 4, C2 12, C3 4).
 */

/*
 * RESULT, 2026-10-18 (segment A read once, on the VPS).
 *
 * PROVENANCE. Lock commit 1713e71 (committed 14:35:53 UTC). Image crypto-ops:nv1 built at 1713e71 (the run
 * script refused an image at any other commit; an earlier image at 95d1218 was refused and read nothing). Run
 * start 2026-10-18T14:55:35Z, both containers --network none. Dataset 414fef1ee6cc (30 files), asserted by every
 * stage. Outputs in $HOME/nv1-r1 on the VPS, sha256 prefixes: c1-scores-full 8bdb9a27c23b (holdout true, first bar
 * 2017-08-17 04:00), c1-test abe65f5ebd46, c1-parity aaed2195d4f6, c2-screen 0fd440ae7943, c3-screen 77ec3889ebea.
 *
 * C1 (gated, holdout A): FAIL. max standardised N 1.624 against the null 95th percentile 2.112, p 0.125, argmax k 1.
 *   net % per trade on A by k 0..3: +0.004, +0.085, -0.172, -0.280 (trades 5,254, 2,990, 1,756, 1,042; all assessable)
 *   gross % per trade by k:         +0.164, +0.245, -0.012, -0.120 (cost 0.16)
 *   by segment, net by k:  A1 +0.226 +0.372 +0.585 +0.911 (757 to 153 trades); A2 -0.033 +0.039 -0.298 -0.488;
 *                          B  -0.170 -0.281 -0.205 -0.127;  C -0.034 -0.061 +0.089 +0.050
 *   years in A at k 1: 2017 +1.87 (62 trades), 2018 +0.15, 2019 -0.30, 2020 -0.03, 2021 +0.35; 3 of 5 positive.
 *   balanced 5-coin universe on A: +0.047, +0.009, +0.050, +0.171 (same sign at the argmax).
 *   plateau (reported, never gating): c85 p 0.037 (would pass, argmax k 0, N +0.074), c95 p 0.081. The c85 figure
 *   is one of the forking paths the lock fixed in advance at c90; it is not a pass and is not registered.
 *   Reading: the only positive stretch is A1 (2017 to 2018, about 750 trades at k 0); A2, B and C are flat or
 *   negative, so no delay k turns v8's price categories into a consistent edge. The confirmation delay helps no k.
 *   C1 parity against the stored v8 re-score year (descriptive): 65,520 matched bars, tier agreement 0.885,
 *   score Pearson 0.929, Spearman 0.930 (the price-only score tracks the full v8 score closely).
 *
 * C2 (screen, A as training only): ONE SURVIVOR, lookback 260 weeks, k 1.
 *   cell             net/wk B   net/wk C   IC B    IC C    IC B+C  placebo p90  survives
 *   156 k0          +0.246%    -0.203%    0.105   0.096   0.100   0.066        no (net C)
 *   156 k1          +0.145%    -0.225%    0.108   0.109   0.109   0.102        no (net C)
 *   156 k2          +0.202%    -0.096%    0.128   0.165   0.151   0.209        no
 *   156 k3          +0.142%    +0.156%    0.113   0.193   0.165   0.535        no (placebo)
 *   260 k0          +0.233%    -0.035%    0.099   0.108   0.104   0.065        no (net C)
 *   260 k1          +0.136%    +0.025%    0.108   0.133   0.122   0.103        YES
 *   260 k2          +0.167%    -0.001%    0.136   0.136   0.136   0.223        no
 *   260 k3          +0.027%    -0.007%    0.076   0.128   0.112   0.652        no
 *   all k0..k3 match 260 in B (all history reaches only 260 weeks there) and fail in C.
 *   Expected null promotion rate 0.615: a placebo feature set yields a survivor about 6 times in 10, so this
 *   survivor is weak evidence on its own. Placebo 90th percentiles rise with k (0.065 at k 0 to 0.65 at k 3)
 *   because a delayed book holds fewer coin-weeks; it does not change the survivor. Turnover 0.67 (B), 0.59 (C)
 *   per week. 71 coin-weeks dropped from training as incomplete; none in B or C.
 *
 * C3 (screen): ONE SURVIVOR, k 1. Net % per one-day trade after 0.14:
 *   k0 B -0.186 C +0.101 pooled -0.019 (null p90 -0.042) no;  k1 B +0.075 C +0.045 pooled +0.056 (null p90 +0.002) YES;
 *   k2 B +0.031 C +0.035 pooled +0.033 (null p90 +0.061) no;  k3 B -0.071 C +0.382 pooled +0.209 (null p90 +0.141) no.
 *   k1 trades 2,390 (B) and 3,594 (C), 3,000 buys and 2,992 sells. Expected null promotion rate 0.114.
 *   Plateau: k1 also survives at thresholds 0.15 and 0.35 (at 0.15 k2 and k3 survive too and k3 would be chosen).
 *
 * PREDICTIONS. C1 fails: right. C2 at most one survivor: right, but its IC is 0.12, not about 0.02, and the null
 * promotion rate is 0.615 (predicted above 0.2). C3 no survivor: wrong, k1 survives at every threshold.
 *
 * GATE 2 RULING (Claude, under the owner's full autonomy of 2026-10-18; no historical pass is called an edge):
 * - C1 is not registered. lab-v2 slot 1 stays empty; its alpha (0.0025) is spent unused.
 * - C2 260-week k1 goes forward to lab-v2 slot 2, frozen exactly as tested, labelled weak (null promotion 0.615).
 * - C3 k1 goes forward to lab-v2 slot 3, frozen exactly as tested.
 * - Slot 4 stays reserved. Each filled slot is judged by its own e-process at threshold 400.
 * - The ledger stays at 2,189: forward hypotheses are judged on new bars under their own alpha.
 * - "Verified" needs a forward crossing. Until then both survivors are "survived a screen", nothing more.
 */
import { NV1_C1 } from './nv1-c1';
import { NV1_C2 } from './nv1-c2';
import { NV1_C3 } from './nv1-c3';
import { NV1_SEGMENTS } from './nv1-core';

/** The locked values. next-version-v1.test.ts asserts each against the code that runs the round. */
export const NV1_LOCK = {
  datasetHash: '414fef1ee6ccf45fcb6e6a7e25ad8a5c3a3ea24176b40cfd7158e8cf2a906e5f',
  devScoresSha256: '27fd28cf27535dd4a1f5bb19e2d6738afcd1415f86c6016330d758cf048fb27c',
  calibrationSha256: '514d72e0b791f7fe24b8f603f55ccea78aa69c08548e360f210c74e961b31392',
  segments: {
    A1: { start: Date.UTC(2017, 7, 17), end: Date.UTC(2018, 9, 31) },
    A2: { start: Date.UTC(2018, 9, 31), end: Date.UTC(2021, 9, 14) },
    B: { start: Date.UTC(2021, 9, 14), end: Date.UTC(2023, 9, 14) },
    C: { start: Date.UTC(2023, 9, 14), end: Date.UTC(2026, 6, 1) },
  },
  c1: {
    c85: 31.067892,
    c90: 33.363315483112025,
    c95: 36.332645,
    ks: [0, 1, 2, 3],
    hold: 24,
    costPct: 0.16,
    minShiftBars: 720,
    minTrades: 400,
    minBlocks: 40,
    alpha: 0.05,
    testStandardiseDraws: 1000,
    testStandardiseSeed: 20261018,
    testNullDraws: 10000,
    testNullSeed: 20261019,
    calibration: { falsePass: 0.045, powerAt: { 0.1: 0.265, 0.2: 0.695, 0.3: 0.97 } },
  },
  c2: {
    ks: [0, 1, 2, 3],
    lookbackWeeks: [156, 260, 'all'],
    lambda: 1.0,
    costRate: 0.0007,
    minCoins: 6,
    betaDays: 90,
    embargoWeeks: 1,
    placeboPermutations: 200,
    placeboSeedBase: 20261200,
    placeboQuantile: 0.9,
  },
  c3: {
    ks: [0, 1, 2, 3],
    bins: 200,
    valueAreaShare: 0.7,
    minBarsPerDay: 90,
    threshold: 0.25,
    plateauThresholds: [0.15, 0.35],
    hold: 1,
    costPct: 0.14,
    nullDraws: 1000,
    nullSeed: 20261300,
    minShiftBars: 30,
    nullQuantile: 0.9,
  },
  labV2: { slots: 4, alphaPerSlot: 0.01 / 4, threshold: 400 },
  ledgerBefore: 2169,
  ledgerAfter: 2189,
} as const;

/** Re-exported so a reader of the lock sees what runs. */
export const LOCKED_CODE = { NV1_C1, NV1_C2, NV1_C3, NV1_SEGMENTS };
