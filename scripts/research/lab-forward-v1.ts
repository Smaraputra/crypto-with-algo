/**
 * FORWARD SIGNAL LAB, lab-v1: four frozen candidates and eight hypotheses, judged only on bars recorded
 * after the live jobs start. Pre-registered.
 *
 * WHY: no rule in the program has passed (ledger 2,161), and the history that could test a new one is
 * spent. Every lock and RESULT header from 2022 onward has read it: the 10-coin perp cross-section through
 * 2026-10-13 (rv-v1 re-validation, every rv development run read the lockbox), and per-coin 4h and 1d
 * direction through 2026-10-09 (direction and exit study, v8 re-score). Trying ideas on that history can
 * only generate hypotheses. Only bars that no study has seen can confirm one, so this lab scores each
 * candidate live and judges it with a test that stays valid however often it is read. The owner asked for
 * a small lab of three to four candidates and for the combined rv-v1 and v8 score at all five v8
 * timeframes (2026-10-17).
 *
 * STATUS: LOCKED before any live lab bar exists. Amendments may only tighten, may only be made before the
 * bar they affect is graded, and are each their own commit named "AMENDMENT n".
 * Review before the lock (agy on gemini-3.8-flash-high, 2026-10-18, seven findings, each checked by Claude
 * against the code): accepted and applied, the L4 input pinned to the T - 4h point (factors.ts), the
 * turnover reference and the uncharged entry stated, the identity's exact and approximate cases stated,
 * the POWER sources separated, the e-process predictability comment corrected and the L3 wording fixed.
 * Rejected, with the reason in CANDIDATES: the claim that a short rv-v1 ranking distorts L2.
 *
 * WHAT IS ALREADY KNOWN (disclosed, each candidate's overlap with spent history):
 * - L1, rv-v1 composite rank. The pre-registered re-validation (scripts/research/rv-revalidation.ts,
 *   RESULT 2026-10-15) found real time structure (G1 p 0.0020, G2 p 0.0030) that did not survive the
 *   search (G3 deflated Sharpe 0.10). Net taker Sharpe 0.87, 2026 to 2026-10-13 -22.0%. The rv-v1 desk
 *   has recorded it forward since the 2026-10-14 16:00 bar. A pass here validates the ranking only. The
 *   desk's own read rule is separate and unchanged.
 * - L2, combined v8 and rv-v1 score. v8 alone is measured as no edge: balanced hit rate 0.43 to 0.48 on
 *   the live record, re-scored calls right less often than chance at 5m, 15m and 1h, and the 5m paper desk
 *   lost 0.17% per trade. The combination has never been tested.
 * - L3, variance fade. Lee and Wang (2025), "Variance Decomposition and Cryptocurrency Return Prediction",
 *   JFQA 60(4) 1859-1890: coins with higher realised variance earn lower returns in the following weeks,
 *   cross-sectionally, more strongly in small, retail-heavy coins than in large caps like these ten. Overlap:
 *   the closed realisedVol20 cross-sectional track (Phase A/B and PR #51), where the rank IC survived (1h
 *   h32 -0.075) while the quantile spread was about zero.
 * - L4, positioning fade. The program's largest historical effect is the within-symbol top-trader position
 *   ratio, 1d h32 IC -0.218 (Phase 3b), which survived the execution lag, and positioning passed the
 *   cross-sectional IC screen at 1h and 4h (Phase A/B). This cross-sectional sort of the within-symbol z
 *   has never been run.
 *
 * DATA (live only, every input stored with the timestamp it was read):
 * - Binance USDT-M perpetual REST: 5m klines (grading prices), 1h klines (L3), and the top-trader
 *   long/short position ratio at the 4h period (L4).
 * - The stored v8 GlobalSignal rows at configVersion 8 (L2) and the stored rv-v1 rvsignals (L1, L2).
 * - Universe: the 10 signal symbols (src/lib/signals/signal-symbols.ts).
 *
 * CANDIDATES (frozen as the code of src/lib/signals/lab/candidates.ts and factors.ts at the commit that
 * merges this file. A higher score is more long):
 * - L1-8h: the stored rv-v1 compositeZ of the 8h bar closing at T.
 * - L2-<tf> for tf in 5m, 15m, 1h, 4h, 1d: 0.5 x v8 score + 0.5 x 100 x (5.5 - rank) / 4.5, where the v8
 *   score is the configVersion 8 GlobalSignal of the bar closing at T from scalping (5m), day_trading (15m
 *   and 1h) or swing_trading (4h and 1d), and the rank is that coin's rv-v1 rank in the latest rv-v1
 *   signal whose 8h bar closed at or before T. A coin rv-v1 skipped is skipped, and so is a coin with no
 *   v8 score. The weights are fixed and are never tuned. When rv-v1 ranks fewer than 10 coins, the rank
 *   component keeps its 22.2-point step and shifts every coin by the same constant, which leaves the
 *   ranks of the combined score unchanged.
 * - L3-8h: minus the sum of the 168 squared log returns of the 169 closed perp 1h bars ending at T (low
 *   variance = long). Bars are fetched with endTime = T - 1 and any bar closing at or after T is refused.
 * - L4-8h: minus (latest - mean) / sample SD over the 180 top-trader position ratio points at the 4h
 *   period ending at the point stamped exactly T - 4h (low z = long). Each point is a point-in-time state
 *   at its stamp (the 4h point at a 4h boundary equals the 1h point with the same stamp, checked live
 *   2026-10-18). The point stamped T is published some minutes after T, so using it would make the input
 *   depend on when the job ran. The point stamped T - 4h is always published by T. A missing T - 4h
 *   point, a short or gapped window, or zero spread skips the coin.
 *
 * METRIC: per graded bar, X_t is the Pearson correlation between the centred ranks of the candidate's
 * scores at T and the raw perp returns over [T + D, T + D + Δ] (rankWeightedCorrelation in
 * src/lib/stats/rank-ic.ts). Δ is the bar length. D is 5 minutes at 5m and 10 minutes at every other
 * timeframe. The prices are the opens of the perp 5m klines opening at T + D and at T + D + Δ, fetched at
 * grade time and stored. Only coins with both a score and both prices count, and a bar with fewer than 8
 * places no bet. A score written after T + D places no bet. With a fixed D the return windows of one
 * hypothesis never overlap. X_t is in [-1, 1], and with ranks independent of returns its null mean is
 * exactly 0. For a rank-weighted, dollar-neutral, gross-1 book on the same coins, the book return is
 * k x s_t x X_t, with s_t the cross-sectional population SD of the returns and k = N x SD(centred ranks) /
 * sum|centred ranks| (1.149 for 10 distinct scores). The identity is exact when every scored coin has
 * both prices, which is the normal case. When a scored coin lacks a price, X_t and s_t use the coins
 * with prices while the hurdle keeps the book known at T (below), so the identity is approximate on
 * that bar. Rebuilding the book from the priced coins would make b_t depend on what happened after T.
 *
 * HURDLE: b_t = turnover_t x 0.0007 / (k_t x ŝ_t).
 * - turnover_t is the sum of |w - w_prev| of that book, from the scores of every coin scored at T (known at
 *   T). w_prev is the book of the previous graded bar of the same hypothesis with at least 8 coins priced,
 *   whether or not that bar placed a bet, because the book follows the forecast on every bar it can be
 *   priced. k_t is k from the same scores as w.
 * - 0.0007 is 5 bps taker plus 2 bps slippage per unit traded.
 * - ŝ_t is the mean of s over the last 90 graded bars of the hypothesis with at least 8 coins priced,
 *   earlier bars only. With no such earlier bar, b_t is undefined and the bar places no bet. So the first
 *   bar, which enters from flat, places no bet, and its one-off entry turnover of 1 (7 bps) is never
 *   charged. This is disclosed and immaterial over a test of thousands of bars.
 * - b_t depends only on the scores at T and on earlier bars, so it is fixed before X_t can be observed.
 *   λ_t's cap uses b_t, which keeps λ_t predictable.
 * - A pass means the forecast pays its taker costs on average, to within ŝ_t standing in for s_t. The
 *   realised net book return is reported beside it, descriptively.
 *
 * GATES:
 * - Each hypothesis tests H0: E[X_t - b_t | past] <= 0 with the e-process E_t = E_(t-1) x (1 + λ_t x
 *   (X_t - b_t)) (src/lib/signals/lab/e-process.ts). λ_t is the empirical Kelly plug-in mean / (variance +
 *   1e-6) of the earlier (X - b) values, clipped to [0, 0.5 / (1 + b_t)], and 0 for the first 30
 *   bet-placing bars. Shafer (2021) JRSS A 184(2), Waudby-Smith and Ramdas (2024) JRSS B 86(1).
 * - Multiplicity: e-Bonferroni over K = 8 at alpha 0.01. A hypothesis is validated when E_t >= 800, under
 *   any dependence between the hypotheses (Wang and Ramdas 2022, JRSS B 84(3)). The crossing is final.
 * - E_t at b = 0 ("has predictive content") is reported and never validates.
 *
 * POWER (Claude's numpy simulation, 2026-10-18: t4 returns, 10 coins, the exact λ rule, two-year runs of
 * 2,190 bars): no null run crossed 800 in 1,000 runs. An edge of 0.07 over the hurdle (mean X 0.081, b
 * 0.01) crossed in all 300 runs, median bar 322, about 3.5 months at 8h. Mean X 0.05 at b 0 crossed in
 * all 300 runs, median bar 595, about 6.5 months at 8h. The calibration suite in
 * src/lib/signals/lab/e-process.test.ts re-runs part of this on every test run with its own generator:
 * 300 null runs at b 0 and 300 at b 0.02 (at most 2 crossings allowed, 0 observed), and 200 planted runs
 * at mean X 0.081 and b 0.01 (200 crossed, median bar 320). A hypothesis at 5m sees 96 times as many bars
 * as one at 8h, but its hurdle is far larger.
 *
 * PRE-LOCK PREVIEW (descriptive, never gating). scripts/research/lab-preview.ts at b9a9580, run on the VPS
 * 2026-10-18 05:44 UTC with no network. Inputs: rv panel sha256 69f27f6ec023 (rv-v1 re-validation inputs,
 * 2022-01-15 to 2026-10-13), v8 re-score rows sha256 2addedf2b2ce, rescore dataset a964d87d8f45 (perp
 * 5m to 1d, 2025-10-01 to 2026-10-09), rv dataset bc3566f4c6c6 (perp 1h). Real scores fed turnover only,
 * and no score was set against a return. The hurdle b in X units, over bars with at least 8 coins:
 *
 *   Hypothesis   Bars      Turnover mean   b mean   b p10   b p50   b p90
 *   L1-8h         5,197    0.406           0.026    0.009   0.023   0.046
 *   L2-5m       107,700    0.076           0.061    0       0.053   0.148
 *   L2-15m       35,880    0.055           0.026    0       0       0.067
 *   L2-1h         8,952    0.095           0.022    0       0       0.068
 *   L2-4h         2,214    0.250           0.028    0       0.015   0.072
 *   L2-1d           344    0.577           0.026    0.013   0.025   0.039
 *   L3-8h         5,197    0.078           0.005    0       0.004   0.013
 *   L4-8h         not previewed: no stored 4h top-trader ratio history, and REST serves 30 days
 *
 * A median of 0 means the rank order, and so the book, did not change on most bars. Simulated at 8h with
 * b 0.025 (300 runs each, same model as POWER), the share of runs that cross 800 within 24 months is 19%
 * for a mean X 0.02 above b, 61% for 0.03, 95% for 0.04 and 100% for 0.05. So L1 needs a mean X near
 * 0.065 to be likely to pass. At 5m the bars are 96 times as frequent, so a far smaller edge over b
 * would cross, but b is the largest there.
 * Real-returns null (random scores against the real 8h perp returns of 5,240 bars, real b, 1,000 runs):
 * L1's b gave 0 crossings, and 0 at b = 0. L3's b gave 0 crossings, and 1 at b = 0. The bound allows
 * 1.25 per 1,000.
 *
 * PREDICTIONS (recorded before any live bar): the most likely outcome is that no hypothesis crosses 800
 * within 24 months. L2 at 5m, 15m and 1h will not cross, because their hurdle exceeds any plausible
 * information coefficient. L1 is the best placed of the eight, but its 2026 record is negative. L3 and L4
 * are unknown, and the evidence for both comes from smaller or broader universes than these ten coins.
 *
 * READ RULE: E_t is read continuously on the signals board. A hypothesis is "Under test since <date of
 * its first graded bar>" until it crosses, then "Validated (forward, <date>)". The test ends 24 months
 * after a hypothesis's first graded bar, and a hypothesis that has not crossed by then is "Not shown".
 * There is no futility claim and no early stop for a low E_t.
 *
 * FAILURE ACTION: a hypothesis that is not shown keeps no claim and stays labelled that way. Trading any
 * candidate, validated or not, is a separate decision of the owner's and is outside this lock.
 *
 * LOCK START: the live jobs score only the bar that has just closed, so the first stored bar of each
 * hypothesis is its first bar closing after the deploy that starts them. Nothing earlier is scored.
 * AMENDMENT 1 records the deploy time.
 *
 * TRIALS: the program ledger moves from 2,161 to 2,169 (eight hypotheses).
 */
import { LAB_HYPOTHESES_V1, LAB_VERSION } from '@/lib/signals/lab/candidates';

/** The locked values. lab-forward-v1.test.ts asserts each one against the code that runs the lab. */
export const LAB_FORWARD_V1_LOCK = {
  version: 'lab-v1',
  hypotheses: ['L1-8h', 'L2-5m', 'L2-15m', 'L2-1h', 'L2-4h', 'L2-1d', 'L3-8h', 'L4-8h'],
  alpha: 0.01,
  threshold: 800,
  warmupBars: 30,
  varianceEps: 1e-6,
  capNumerator: 0.5,
  costPerSide: 0.0007,
  sWindow: 90,
  minCrossSection: 8,
  delayMs: { '5m': 300_000, '15m': 600_000, '1h': 600_000, '4h': 600_000, '8h': 600_000, '1d': 600_000 },
  l2Weights: { v8: 0.5, rv: 0.5 },
  l2V8ConfigVersion: 8,
  l2V8Style: { '5m': 'scalping', '15m': 'day_trading', '1h': 'day_trading', '4h': 'swing_trading', '1d': 'swing_trading' },
  l3Bars: 169,
  l4: { period: '4h', periodMs: 4 * 3_600_000, points: 180, lagMs: 4 * 3_600_000 },
  maxMonths: 24,
  ledgerBefore: 2161,
  ledgerAfter: 2169,
} as const;

/** The registry this lock freezes, re-exported so a reader of the lock sees what runs. */
export const LOCKED_REGISTRY = { version: LAB_VERSION, hypotheses: LAB_HYPOTHESES_V1 };
