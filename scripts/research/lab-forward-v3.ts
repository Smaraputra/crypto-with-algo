/**
 * FORWARD SIGNAL LAB, lab-v3: the Round 2 hypothesis F1-1d, judged only on bars recorded after the live job starts.
 * Pre-registered.
 *
 * WHY: on 2026-10-18 the owner decided to keep the rounds as designed. Round 2 runs forward-only at alpha 0.005, with
 * near-zero power for realistic edges accepted, and by the program stop rule it is the last exploratory round. The
 * Round 2 preview (scripts/research/nv2-preview.ts at 55ded39, run on the VPS 2026-10-20 14:11 UTC over the
 * point-in-time top 30 Binance USDT-M perpetuals, 2021-03-01 to 2026-06-29, dataset aa62c5a1cb51, output
 * $HOME/nv2/preview.json) measured five signals, each held one day (h1) or as a 7-day staggered book (h7), net of
 * costs and funding, over 1,947 days:
 *
 *   Candidate     h1 annual Sharpe   h7 annual Sharpe
 *   fund7          0.31               0.82
 *   lottery30      0.33               0.29
 *   rev7          -1.00              -0.39
 *   mom1          -1.79              -0.88
 *   fundChange    -1.29              -1.00
 *
 * fund7_h7 had the highest net Sharpe, and it is the single Round 2 hypothesis. Its mean R of +0.038% a day is
 * +0.020% price, +0.030% funding and -0.012% cost. By year its Sharpe was 2.96 (2021), -1.03 (2022), -1.01 (2023),
 * 2.00 (2024), -0.08 (2025) and 2.25 (2026 to June). It was picked as the best of ten on the full history, so the
 * 0.82 overstates what to expect. Only the forward record counts.
 *
 * STATUS: LOCKED before any live lab-v3 bar exists. Amendments may only tighten, may only be made before the bar they
 * affect is graded, and are each their own commit named "AMENDMENT n".
 *
 * HYPOTHESIS (frozen as the code at the commit that merges this file):
 * - the scorer: src/lib/signals/lab/v3/f1.ts;
 * - the live job: src/lib/signals/lab/job-signals-v3.ts;
 * - grading: src/lib/signals/lab/job-grade.ts (the F1 branch of gradeBookBar and gradeLabV3);
 * - shared code: e-process.ts, candidates.ts (LAB_HYPOTHESES_V3, LAB_V3_THRESHOLD, LAB_V3_UNIVERSE,
 *   LAB_V3_UNIVERSE_SHA256, LAB_V3_TAKER_FEE, labV3SlippageOfRank, LAB_V3_COST_PER_SIDE, LAB_V3_COST_UNRANKED,
 *   LAB_V3_DELISTING_HAIRCUT), hurdle.ts (bookTurnover), src/lib/stats/rank-ic.ts (bookWeights, centredRanks),
 *   src/lib/funding-settlement-sync.ts, src/lib/funding-settlements.ts (settlementTimeOf), and the REST fetchers
 *   fetchFundingHistory, fetchPerpKlinesRange and fetchPerpExchangeInfo.
 * lab-v3 adds to candidates.ts and job-grade.ts, which the lab-v1 and lab-v2 locks also freeze. It changes no lab-v1 or
 * lab-v2 value or rule, and lab-forward-v1.test.ts and lab-forward-v2.test.ts pass unchanged. lab-v3 grades in its
 * own pass, after lab-v1 and lab-v2.
 * - UNIVERSE: the 30 Binance USDT-M perpetuals in scripts/research/top30-perps-2026-10-20.json, frozen on 2026-10-20
 *   by median quote volume among contracts listed at least 366 days (built by scripts/research/nv2-universe.ts, manifest
 *   hash field e1035a116d54). The manifest rank sets each coin's cost.
 * - F1-1d: at each 00:00 UTC close T, the job runs at T + 4 minutes (retry at T + 9).
 *   - It reads exchangeInfo once. A frozen coin that is not listed as TRADING is skipped as 'delisted'.
 *   - For each listed coin it fetches funding settlements by REST over [T - 14 days, T + 1 minute] and rounds each
 *     settlement time to the hour (settlementTimeOf), as the stored settlements are.
 *   - fund7 = minus the sum of the rates with rounded time in (T - 7 days, T]. A coin needs at least 18 such
 *     settlements, including the settlement at T itself, else it is skipped as 'funding_incomplete'.
 *   - On the first attempt, any failed fetch, or a coin still missing the settlement at T, makes the attempt write
 *     nothing, so the retry decides. On the retry the row is always written. A coin whose fetch failed or that lacks
 *     the settlement at T is skipped as 'funding_incomplete', and if exchangeInfo fails no coin is skipped as
 *     'delisted'. A smaller cross-section changes every rank that day, and below 10 scored coins the day's target is
 *     cash. The preview never had a cross-section cut down this way.
 *   - The target book at T is the centred-rank, dollar-neutral, gross-1 book over the scored coins (bookWeights),
 *     long low funding and short high funding. Below 10 scored coins the target is cash.
 *   - The active book is one seventh of the sum of the stored target books at T, T - 1 day, ..., T - 6 days. A day
 *     without a stored target adds nothing, so the first six bars after the start hold partial books. They fall inside
 *     the 30-bet warm-up.
 *
 * STATISTIC (lab-v2's net book return, with the preview's costs):
 * - Returns r_i: the perp open-to-open return over [T + D, T + D + 1 day], from 5m perp klines (D = 10 minutes).
 * - Funding f_i: the sum of the settled rates with settlement time in (T + D, T + D + 1 day]. A long pays it.
 * - R_t = sum over priced coins of w_i (r_i - f_i) - cost_t, with
 *   cost_t = sum_i |w_i - w_prev,i| x (0.0005 + slippage by manifest rank: 0.0002 for ranks 1 to 10, 0.0005 for
 *   11 to 25, 0.0010 for 26 to 30). This is the preview's costOf, so the costs run from 7 to 15 bps a side. A coin
 *   outside the manifest would cost 15 bps. The first bar charges the whole book.
 * - Missing and delisted coins (the preview's rules, adapted to live data):
 *   - no 5m kline opening at T + D: the coin adds nothing to R (the preview: no bar that day);
 *   - a kline at T + D but none at the window's end, coin still TRADING: the coin adds nothing (a venue gap);
 *   - a kline at T + D but none at the end, coin no longer TRADING: delisted. r_i = (last 5m close in the window) /
 *     (open at T + D) - 1 - 0.02, as the preview's 2% delisting haircut, with funding as settled;
 *   - a kline request answered with HTTP 400 (the venue no longer knows the symbol) means no klines for that coin.
 *   - The cost is still charged on the whole book change.
 * - Funding is never assumed. For a coin priced normally, the bar is graded only after the funding sync succeeded for
 *   it and it has a stored settlement within 8 hours before the window's end. Otherwise the bar waits for a later
 *   grade run. A waiting bar holds back every later F1 bar. If a settlement is missing for good, only an amendment
 *   can release it.
 * - A row written after T + D (10 minutes) is late: it places no bet, but its book still becomes w_prev and its
 *   target stays in the staggered book for seven days.
 * - X_t = min(R_t / c, 1), with b_t = 0 and c = 0.036. That is 4 x the preview's SD of R (0.88%), rounded up to 2
 *   significant figures, as in lab-v2.
 * - Declared differences from the preview:
 *   - entry is 10 minutes after the day boundary, as lab-v1 and lab-v2 do. The funding window moves with it, and no
 *     settlement falls in those 10 minutes;
 *   - the universe is the frozen 2026-10-20 manifest, not the monthly point-in-time top 30;
 *   - live tradeability is exchangeInfo TRADING, where the preview required a 1d bar at the day;
 *   - a coin with a venue gap at the window's end adds nothing. The preview had no intraday gaps.
 *
 * GATES: lab-v1's e-process rule (src/lib/signals/lab/e-process.ts: Kelly plug-in from past bets only, 30-bet warm-up,
 * cap 0.5 / (1 + b), variance floor 1e-6), run with threshold 200 and lossUnbounded.
 * - THE NULL ACTUALLY TESTED (as lab-v2): H0': E[min(max(R_t / c, -2), 1) | past] <= 0. Losses beyond 2c (7.2%) count
 *   at -7.2%. Such a loss while betting at the cap ends the test for good.
 * - In the preview's 1,947 days, R / c fell below -1 on 5 days and below -2 on none (worst day -5.36%). It exceeded +1
 *   (the gain clip) on 6 days.
 * - Threshold 200 is 1 / 0.005, the whole Round 2 budget on one slot. With lab-v1 (0.01) and lab-v2 (0.01), the
 *   program's forward labs carry 0.025 in all. The crossing is final.
 * - Read rule: lab-v1's labels, with the 24 months counted from F1-1d's first graded bar.
 *
 * POWER (scripts/research/lab-v3-power.ts over the preview's fund7_h7 R series, using the preview's
 * runPowerSimulation: 300 bootstrap runs of 730 bars each, seed 42, threshold 200; run on the VPS 2026-10-21):
 *
 *   Effect (annual Sharpe)   c = 0.036 iid / block   c = 0.1 iid / block
 *   measured (0.82)          1.7% / 2.7%             0% / 0%
 *   0 (null)                 0.3% / 0.3%             0% / 0%
 *   1                        3.0% / 5.0%             0.3% / 0%
 *   1.5                      9.7% / 10%              0.3% / 1.3%
 *   2                        24% / 29%               1.7% / 1.7%
 *   2.5                      53% / 52%               5.7% / 6.7%
 *
 * The owner chose c = 0.036 on 2026-10-21. c = 0.1 would survive a -20% day, but the bet cap would bind and the test
 * could hardly pass. So F1-1d is unlikely to cross unless its forward edge is two to three times what the history
 * shows. This lab is a forward record of Round 2, run as the rounds were designed.
 *
 * PREDICTIONS (recorded before any live bar): F1-1d does not cross 200 within 24 months. Its net return stays near
 * zero, mostly funding collected by the short side.
 *
 * PARITY (real data, run on the VPS 2026-10-21 11:59 UTC with scripts/research/lab-v3-parity.ts, image
 * crypto-ops:labv3-parity at be2c024, the preview's dataset aa62c5a1cb51, output $HOME/labv3-check/parity.json):
 * - Books: on 1,947 of 1,947 days from 2021-03-01 to 2026-06-29, the live active book (computeFund7, targetBook and
 *   staggeredBook over the 30 frozen coins, a coin counted when it has a 1d bar that day) equals the preview's
 *   (signalsAt, targetBook and staggeredBook) to 1e-12.
 * - Costs: on 1,946 of 1,946 consecutive book changes, the cost gradeBookBar charges equals the preview's costOf at the
 *   manifest ranks, to 1e-12.
 * REST CHECK (same run): funding settlements for the 30 coins from 2026-06-01 to 2026-06-29, fetched by REST as the
 * live job does and rounded to the hour, against the archive. All 3,214 settlements are present on both sides with
 * equal rates. 1,624 of the REST prints carry a time off the exact hour, which is why the live job rounds them.
 * The live scorer's targetBook and staggeredBook are copies of the preview's and share bookWeights, so the book check
 * catches drift between the copies, not a defect they share. Parity does not cover the live job's exchangeInfo
 * filter, its round trip of stored targets, or the grader's price, funding and delisting rules. Unit tests cover
 * those, and AMENDMENT 1 checks the first live rows.
 *
 * READ RULE, FAILURE ACTION: as lab-v1. Trading the rule is a separate owner decision outside this lock.
 * OPERATIONS: lab-v3 is graded in the hourly lab run in its own pass, after lab-v1 and lab-v2. Its kline fetches
 * are sequential, 250 ms apart. The signal job's funding fetches are 100 ms apart, and the grader's funding sync is
 * sequential without pauses, as lab-v2's is. A thrown error or a failed fetch in one pass is caught and reported, so
 * it cannot stop the other pass. A lab-v3 failure marks that run's lab-grade heartbeat failed, as a lab-v2 failure
 * does. None of this changes any stored value.
 *
 * LOCK START: the live job scores only the bar that has just closed. The first F1-1d bar is the first 00:00 UTC close
 * after the deploy that starts the job. AMENDMENT 1 will record the deploy time.
 *
 * AMENDMENT 1 (2026-10-22, written after the first row was stored and before it was graded). It records the start
 * and changes no rule.
 * - The code merged with PR #108 (main 6404273). The app restarted on it at 2026-10-21 15:05:33 UTC.
 * - The cron container was recreated at 2026-10-21 15:07:09 UTC. Its crontab carries the two lab-v3 lines (00:04 and
 *   00:09 UTC). No lab-v3 job ran by hand, so no earlier bar exists.
 * - First row: F1-1d for the bar closing 2026-10-22 00:00 UTC, written 00:04:12 UTC, not late. The 00:09 retry found
 *   it stored. The hourly lab run holds it as pending, due 2026-10-23 00:15 UTC.
 * - First-row check (read-only query of the production row, 2026-10-22):
 *   - all 30 frozen coins scored and none skipped (no delisted coin, no incomplete funding);
 *   - funding settlements counted in (T - 7d, T]: 21 to 42 per coin, so at least 18 for every coin;
 *   - the target book has gross 1 and net 0 (to 1e-16), with 15 coins long and 15 short;
 *   - no earlier target exists (priorDaysFound 0), so the active book is the target divided by 7 exactly (gross 1/7);
 *   - the coin with the lowest score (PENGUUSDT, the most funding paid) holds the largest short and the coin with
 *     the highest (QNTUSDT) the largest long, as the rule states.
 * - PR #110 (main 70510b2), deployed 2026-10-22 00:51 UTC, changed no lab, model, cron route or crontab file.
 */

import {
  LAB_HYPOTHESES_V3,
  LAB_V3_THRESHOLD,
  LAB_VERSION_V3,
  LAB_V3_UNIVERSE,
  LAB_V3_UNIVERSE_SHA256,
  LAB_V3_COST_PER_SIDE,
  LAB_V3_COST_UNRANKED,
  LAB_V3_TAKER_FEE,
  LAB_V3_DELISTING_HAIRCUT,
} from '@/lib/signals/lab/candidates';

export const LAB_FORWARD_V3_LOCK = {
  version: 'lab-v3',
  hypotheses: [{ id: 'F1-1d', candidate: 'F1', timeframe: '1d', metric: 'book', scale: 0.036 }],
  slots: 1,
  alphaPerSlot: 0.005,
  threshold: 200,
  delayMs: 600_000,
  universe: LAB_V3_UNIVERSE,
  universeSha256: LAB_V3_UNIVERSE_SHA256,
  manifestFile: 'scripts/research/top30-perps-2026-10-20.json',
  f1: {
    staggerDays: 7,
    minSettlements7d: 18,
    minScoredCoins: 10,
    takerFee: 0.0005,
    slippageByRank: { rank1to10: 0.0002, rank11to25: 0.0005, rank26to30: 0.001 },
    costUnranked: 0.0015,
    delistingHaircut: 0.02,
  },
  maxMonths: 24,
} as const;

export const LOCKED_CODE = {
  LAB_HYPOTHESES_V3,
  LAB_V3_THRESHOLD,
  LAB_VERSION_V3,
  LAB_V3_UNIVERSE,
  LAB_V3_UNIVERSE_SHA256,
  LAB_V3_COST_PER_SIDE,
  LAB_V3_COST_UNRANKED,
  LAB_V3_TAKER_FEE,
  LAB_V3_DELISTING_HAIRCUT,
};
