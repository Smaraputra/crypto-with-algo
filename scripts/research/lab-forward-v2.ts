/**
 * FORWARD SIGNAL LAB, lab-v2: the two Round 1 screen survivors, judged only on bars recorded after the live jobs
 * start. Pre-registered.
 *
 * WHY: next-version Round 1 (scripts/research/next-version-v1.ts, RESULT 2026-10-18) read the untouched 2017 to 2021
 * segment once. C1 (v8's price score with a confirmation delay) failed. C2 (a weekly cross-sectional ridge) and C3
 * (value-area drift) each passed their screen once. That lock fixed four lab-v2 slots at alpha 0.01 / 4 each,
 * whether filled or not. Slot 1 (C1) stays empty, slot 2 holds C2, slot 3 holds C3, and slot 4 is reserved. A
 * forward hypothesis is frozen exactly as tested. C2 carries the Gate 2 label "weak": its screen's null promotion
 * rate is 0.615. On 2026-10-18 the owner decided to keep rounds as designed, after seeing a generic power table.
 * (24-month crossing needs an annual Sharpe near 2.5 at daily bars, and weekly bars have no power.) The
 * hypothesis-specific preview below came the next day and agrees.
 *
 * STATUS: LOCKED before any live lab-v2 bar exists. Amendments may only tighten, may only be made before the bar they
 * affect is graded, and are each their own commit named "AMENDMENT n".
 *
 * HYPOTHESES (frozen as the code at the commit that merges this file):
 * - the scorers: src/lib/signals/lab/v2/n2.ts and n3.ts;
 * - the live jobs: job-signals-v2.ts;
 * - grading: job-grade.ts (gradeBookBar and the lab-v2 path of runLabGrade);
 * - shared code: e-process.ts, candidates.ts (LAB_HYPOTHESES_V2, LAB_V2_THRESHOLD, LabTimeframeAny), hurdle.ts
 *   (bookTurnover), src/lib/stats/rank-ic.ts (bookWeights, centredRanks), src/lib/funding-settlement-sync.ts and
 *   the REST fetchers fetchKlinesRange and fetchPerpKlinesRange.
 * lab-v2 adds to candidates.ts, which lab-v1's lock also freezes. It changes no lab-v1 value, and
 * lab-forward-v1.test.ts passes unchanged.
 * Each live scorer equals the Round 1 screen code exactly:
 * - in unit tests on synthetic data (80 weeks for N2; 60 days on 3 coins for N3);
 * - on the real B and C history by scripts/research/lab-v2-parity.ts (results under PARITY below).
 * - N2-1w (slot 2): at each Monday 00:00 UTC (T), five spot features per coin, z-scored across coins:
 *   - res1w and res4w, the residual return over 1 and 4 weeks against BTC with a 90-day clamped beta;
 *   - vol4w, the 4-week volatility;
 *   - tbs1w, the 1-week taker-buy share;
 *   - vtrend, the 4-over-12-week volume trend.
 *   A ridge (lambda 1, intercept unpenalised) is refit on the trailing 260 weeks with a one-week embargo, with the
 *   next week's z-scored residual return as the target. Each prediction gives a centred-rank sign. A coin is
 *   eligible when its sign at T equals its sign at T - 1w (k 1). The book is the rank-weighted, dollar-neutral,
 *   gross-1 weights over the eligible coins (re-ranked). It is cash with fewer than 6 kept or eligible coins, or
 *   with one side empty. Inputs are Binance spot 1d klines for the 10 signal symbols, fetched by REST at T + 3
 *   minutes (retry T + 8), using only bars that open before T.
 * - N3-1d (slot 3): at each 00:00 UTC (T), each coin's value area (70%, 200 linear bins, proportional overlap) of
 *   each of the prior three UTC days from spot 15m bars (at least 90 a day). The side of day D is +1 if the D - 1
 *   midpoint rose by more than 0.25 x the D - 2 width, and -1 if it fell by more. A position is held for day T when
 *   side(T) is non-zero and equals side(T - 1) (k 1). Inputs are Binance spot 15m klines fetched by REST at T + 3
 *   minutes (retry T + 8), using only bars that open before T.
 *
 * STATISTIC (differs from lab-v1 on purpose). The design is .superpowers/sdd/next-version/r4-design.md, and it was
 * reviewed twice:
 * - by agy on gemini-3.8-flash-high, run 20261018-233739-c492f2: seven findings, six applied, one disclosed;
 * - by a Claude Opus reviewer of this lock, 2026-10-19: its findings are applied below, including the corrected null
 *   hypothesis under GATES.
 * - lab-v1 bets on the rank correlation (IC). C2's IC is 0.12 over B and C, yet its book earned +0.03% to +0.14% a
 *   week, so an IC test could validate a book that barely pays. lab-v2 bets on the net book return as the screens
 *   tested it.
 * - Returns r_i: the perp open-to-open return over [T + D, T + D + Δ], from 5m perp klines (D = 10 minutes).
 * - Funding f_i: what a long receives over that window, minus the sum of the settled rates with settlement time in
 *   (T + D, T + D + Δ].
 * - Two declared differences from the screens:
 *   - The screens used spot returns with funding excluded. lab-v2 uses perp prices with funding, which is what
 *     holding the book pays, and is stricter.
 *   - The screens entered at the bar boundary: C2 at the week's first daily open, C3 at the day's open. lab-v2
 *     enters 10 minutes later, at T + D, as lab-v1 does.
 * - N2: R_t = sum_i w_i (r_i + f_i) - N2.costRate (0.0007) x sum_i |w_i - w_prev,i|.
 *   - A cash week pays the cost of going flat and counts as a bet. A cash week with nothing to unwind has R = 0, is
 *     a bet that moves nothing, and uses up one of the 30 warm-up bets.
 *   - If any weighted coin lacks a perp price, the bar places no bet. Its book still becomes the next w_prev.
 * - N3: R_t = sum over coins with a side of (side_i x (r_i + f_i) - N3.costPerTrade (0.0014)).
 *   - This is one unit of notional per trade, as the screen pooled trades. (The design first used a per-day mean.
 *     The preview showed that weights a one-trade day like a ten-trade day, so it was changed to the sum before
 *     this lock, which reproduces the screen's per-trade mean exactly.)
 *   - A day with no side places no bet. A side coin without a perp price is left out of that day's R.
 *   - Both missing-price rules depend on the end-of-window price. With these 10 coins that is negligible, and it is
 *     disclosed here.
 * - Funding is never assumed:
 *   - a bar is graded only after the funding sync succeeded for its coins;
 *   - each coin must have a stored settlement within 8 hours before the window's end;
 *   - otherwise the bar waits for a later grade run.
 * - X_t = min(R_t / c, 1), with b_t = 0 (costs and funding are inside R_t), c = 0.13 for N2 and 0.8 for N3.
 *   - c is 4 x the B + C standard deviation of R, rounded up to 2 significant figures.
 *   - Gains above c are clipped. A bar whose bet factor 1 + λ_t x X_t is at or below 0 sets E to 0 for good.
 *
 * GATES: lab-v1's e-process rule (src/lib/signals/lab/e-process.ts: Kelly plug-in from past bets only, 30-bet
 * warm-up, cap 0.5 / (1 + b), variance floor 1e-6), run with threshold 400 and lossUnbounded.
 * - THE NULL ACTUALLY TESTED: with unbounded losses, no non-negative e-process can test E[R_t | past] <= 0 itself.
 *   Because λ <= 0.5, max(0, 1 + λX) <= 1 + λ x max(X, -2), so E_t is a non-negative supermartingale under
 *   H0': E[min(max(R_t / c, -2), 1) | past] <= 0.
 * - In words: losses beyond 2c (8 standard deviations of the B + C R) are counted at -2c. Such a loss while betting
 *   at the cap ends the test for good.
 * - B + C share of bars with R / c below -1: 0.41% (N2) and 0.42% (N3). The share below -2 is under PARITY. The gap
 *   between H0' and H0 is confined to those extreme tails.
 * - Threshold 400 is e-Bonferroni over the four slots at alpha 0.01 (4 / 0.01). Together with lab-v1's 0.01, the
 *   program's forward labs carry 0.02 in all. The crossing is final.
 * - Read rule: lab-v1's labels, with the 24 months counted from each lab-v2 hypothesis's first graded bar.
 *
 * PRE-LOCK PREVIEW (descriptive, never gating). scripts/research/lab-v2-preview.ts at 8184df8 (sha256 5e5d46b1aa9b),
 * run on the VPS with no network in the image built at the Round 1 lock commit 1713e71, dataset 414fef1ee6cc
 * (segment A used only as N2's training data, as in the screen). The preview's R uses the screens' spot returns
 * without funding, entering at the bar boundary, so c, the Sharpe and the power below come from a close relative of
 * the R this lab grades, not from it. Over B and C:
 *
 *   Hypothesis  Bars   Mean R          SD R    Annual Sharpe  Gain clip  Below -1  Null crossings (of 1,000)
 *   N2-1w       245    +0.072% a week  3.07%   0.17           0          0.41%     0 (max log E 3.07)
 *   N3-1d     1,419    +0.237% a day   19.96%  0.23           0.49%      0.42%     0 (max log E 2.09)
 *
 * POWER (the preview, 300 bootstrap runs each, 24 months, threshold 400). N2: 0 at the measured effect and 0 even at
 * an annual Sharpe of 2.5 (104 bars, 30 of them warm-up). N3: 0 at the measured effect, 2.3% at Sharpe 1, 20% at
 * Sharpe 2, 44% at Sharpe 2.5. So neither is likely to cross unless its forward effect is about ten times what the
 * history shows. This lab is a forward record of the survivors, run as the Round 1 lock required.
 *
 * PREDICTIONS (recorded before any live bar): neither hypothesis crosses 400 within 24 months. N2's book stays near
 * zero net. N3's sign is unknown, and its daily return swings are large (SD about 20% at one unit per trade).
 *
 * PARITY (real data, run on the VPS 2026-10-18, image crypto-ops:labv2 at d9ad573, --network none, dataset 414fef1ee6cc,
 * output $HOME/labv2-check/parity.json):
 * - N2: 245 of 245 B and C weeks equal the screen's walkForward(prepared, 260, 1) on net, turnover, eligible count
 *   and cash, to 1e-9.
 * - N3: 17,208 of 17,210 coin-days equal the screen's trade sides. The other 2 (BNB and DOGE on 2026-06-30, the
 *   dataset's last day) are positions the live rule takes where the screen could not open a trade, because the
 *   next day was missing (its contiguity rule). Live, the next day always comes.
 * REST CHECK (live, 2026-10-18 18:10 UTC, $HOME/labv2-check/rest-check.json). Spot 1d and 15m klines for the 10 coins
 * over the 60 completed days 2026-08-19 to 2026-10-17, fetched by REST as the live jobs do, against the stored
 * candles:
 * - 19 of 20 series are identical (every bar present on both sides, every field equal);
 * - BTC 15m has every bar on both sides, but at least one stored bar differs from REST (close by up to 30, volume by
 *   up to 5.46 BTC). That is consistent with a bar stored before it closed.
 * The live jobs read REST, never the stored rows, so this affects only the stored copy.
 *
 * READ RULE, FAILURE ACTION: as lab-v1. Trading either rule is a separate owner decision outside this lock.
 * OPERATIONS: lab-v2 is graded in the same hourly run as lab-v1, after it. A lab-v1 price-fetch failure delays
 * lab-v2 grading to the next hour, and a lab-v2 error marks that run's heartbeat failed. Neither changes any
 * stored value.
 *
 * LOCK START: the live jobs score only the bar that has just closed. The first N3 bar is the first 00:00 UTC close
 * after the deploy that starts the jobs. The first N2 bar is the first Monday 00:00 UTC after it. AMENDMENT 1 will
 * record the deploy time.
 *
 * AMENDMENT 1 (2026-10-19, written after the first rows were stored and before either was graded). It records the
 * start and changes no rule.
 * - The code merged with PR #105 (main 518c0ef). The app restarted on it at 2026-10-18 18:44:04 UTC.
 * - The cron container was recreated at about 18:45 UTC. Its crontab carries the four lab-v2 lines (00:03 and 00:08
 *   daily; 00:03 and 00:08 on Mondays).
 * - No lab-v2 job ran by hand, so no earlier bar exists.
 * - First rows, both for the bar closing 2026-10-19 00:00 UTC (a Monday), neither late:
 *   - N3-1d written 00:03:03 UTC, 7 positions, all short;
 *   - N2-1w written 00:03:05 UTC, an 8-coin book, +0.5 long and -0.5 short, reason ok.
 *
 * TRIALS: none added. The two hypotheses were counted in Round 1 (ledger 2,189) and are judged here under their own
 * alpha.
 */
import { LAB_HYPOTHESES_V2, LAB_V2_THRESHOLD, LAB_VERSION_V2 } from '@/lib/signals/lab/candidates';

/** The locked values. lab-forward-v2.test.ts asserts each one against the code that runs the lab. */
export const LAB_FORWARD_V2_LOCK = {
  version: 'lab-v2',
  hypotheses: [
    { id: 'N2-1w', candidate: 'N2', timeframe: '1w', metric: 'book', scale: 0.13 },
    { id: 'N3-1d', candidate: 'N3', timeframe: '1d', metric: 'book', scale: 0.8 },
  ],
  slots: 4,
  alphaPerSlot: 0.01 / 4,
  threshold: 400,
  warmupBars: 30,
  capNumerator: 0.5,
  varianceEps: 1e-6,
  delayMs: 600_000,
  universe: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT'],
  n2: { lookbackWeeks: 260, k: 1, lambda: 1.0, minCoins: 6, embargoWeeks: 1, betaDays: 90, costRate: 0.0007 },
  n3: { bins: 200, valueAreaShare: 0.7, minBarsPerDay: 90, threshold: 0.25, k: 1, costPerTrade: 0.0014 },
  maxMonths: 24,
} as const;

/** Re-exported so a reader of the lock sees what runs. */
export const LOCKED_CODE = { LAB_HYPOTHESES_V2, LAB_V2_THRESHOLD, LAB_VERSION_V2 };
