/**
 * FORWARD SIGNAL LAB, lab-v4: Round 3's S1 and S2, registered by an OWNER OVERRIDE after the round's result, judged only
 * on bars recorded after the live job starts.
 *
 * WHY, AND WHAT THIS LOCK OVERRIDES: Round 3 previewed three candidates under a decision table committed before the run
 * (scripts/research/lab-v4-preview.ts at 05d427f, PRE-RUN DECLARATION and RESULT). Every candidate had a negative
 * preview mean, so the table registered nothing. It also says unspent alpha is never reallocated without a new
 * pre-stated rule. On 2026-10-22, after seeing that result, the owner chose to register C1 and C2 anyway as a forward
 * record. This lock is that new rule. It is stated AFTER the result, and it is recorded here as an owner override, not
 * as a pre-registered selection.
 * - In this lab C1 is named S1 and C2 is named S2, so they are not confused with Round 1's C1 and C2, which were
 *   different rules.
 * - The Round 3 preview (2022-01-01 to 2026-06-30, the 10 signal symbols, perp 1h, 14 bps round trip and funding by
 *   side):
 *
 *   Rule  Trades  Mean net per trade  t      Gross (side x r)  Funding by side
 *   S1    2,459   -0.126%             -2.53  +0.017%           -0.004%
 *   S2    1,594   -0.093%             -1.55  +0.042%           +0.005%
 *
 * - Both are cost-bound: before costs they earn about nothing against a 0.14% round trip. Neither is expected to pass.
 *
 * STATUS: LOCKED before any live lab-v4 bar exists. Amendments may only tighten, may only be made before the bar they
 * affect is graded, and are each their own commit named "AMENDMENT n".
 *
 * HYPOTHESES (frozen as the code at the commit that merges this file):
 * - the rules: src/lib/signals/lab/v4/rules.ts (s1SideAtLast, s2SideAtLast, isContiguousHourly, LAB_V4_WINDOW_BARS);
 * - the shared analytics: src/lib/market/structure.ts (findPivots, analyzeStructure, SWING_LENGTH) and
 *   src/lib/market/delta.ts (barDelta, deltaDivergences, DIVERGENCE_MAX_BARS);
 * - the live job: src/lib/signals/lab/job-signals-v4.ts;
 * - grading: src/lib/signals/lab/v4/grade.ts and src/lib/signals/lab/job-grade-v4.ts, run by the lab-grade route after
 *   the lab-v1 to v3 pass;
 * - shared code: e-process.ts, candidates.ts (LAB_HYPOTHESES_V4, LAB_V4_THRESHOLD, LAB_V4_ROUND_TRIP, LAB_V4_HOLD_MS),
 *   src/lib/funding-settlement-sync.ts, and the REST fetchers fetchPerpKlinesOhlcv and fetchPerpKlinesRange.
 * lab-v4 adds to candidates.ts and the lab models, which the lab-v1, v2 and v3 locks also freeze. It changes no value or
 * rule of theirs, and src/lib/signals/lab/job-grade.ts is unchanged.
 * - S1-1h: at each 1h close T, for each of the 10 signal symbols, the job takes the last 720 closed perp 1h bars ending
 *   with the bar that closes at T, and skips the coin if they are not exactly contiguous. A long fires when that last bar
 *   is the break bar of a swing CHoCH up (pivot length 20, the close beyond the pivot) and its taker delta (2 x taker buy
 *   volume - volume) is above 0. A short is the mirror, with delta below 0.
 * - S2-1h: same window. A regular divergence between the two most recent confirmed swing pivots of one kind, at most 72
 *   bars apart, confirmed on that last bar, is faded:
 *   - a higher high with the delta summed over the bars after the first pivot through the second below 0 is a short;
 *   - a lower low with that sum above 0 is a long;
 *   - if both confirm on one bar, the short is taken, as in the preview.
 * - One trade per coin per rule at a time: a signal on a coin that entered within the last 8 hours (a stored non-zero
 *   score at a bar close in (T - 8h, T)) is ignored and recorded as 'in_trade'.
 * - Jobs: T + 3 minutes (retry T + 8) every hour. One row per rule per T, with the entering sides only. A row with no
 *   entry still records that the job ran.
 *
 * STATISTIC (lab-v2 N3's per-trade form, over the trade's own 8-hour hold):
 * - For each coin entering at T: r = the perp open-to-open return from the 5m kline opening at T + D to the one opening
 *   at T + D + 8h (D = 10 minutes). F = the sum of the settled funding rates in (T + D, T + D + 8h]. A long pays it.
 * - R_t = sum over the entering coins of (side x (r - F) - 0.0014). That is 7 bps a side taker, twice.
 * - A bar with no entering coin places no bet. A coin without a price is left out of R_t. A kline request answered
 *   with HTTP 400 means no klines for that coin. Funding is never assumed: a priced coin needs a stored settlement within
 *   8 hours before the window's end after a successful sync, or the bar waits, and so does every later bar of that rule.
 * - A row written after T + D is late: it places no bet, and its entries still count for the in-trade rule.
 * - X_t = min(R_t / c, 1), with b_t = 0. c is 0.15 for S1 and 0.14 for S2: 4 x the preview's SD of R_t (3.72% and
 *   3.45%), rounded up to 2 significant figures.
 * - Declared differences from the preview:
 *   - entry at T + 10 minutes from 5m klines (the preview used the 1h open at T);
 *   - structure is built over the last 720 closed bars, not the whole history (agreement measured under PARITY);
 *   - a coin is skipped when its 720-bar window has a gap (the preview skipped a trade with a gap at entry or exit), so
 *     one missing perp bar skips that coin until its window is contiguous again (up to 720 hours);
 *   - the live in-trade rule blocks a coin for 8 hours after any stored entry, even one that later has no price or was
 *     written late. The preview blocked only after a trade it actually priced;
 *   - an hour the job misses (both attempts fail) records no entry, so nothing blocks that coin for the next 8 hours.
 *
 * GATES: lab-v1's e-process rule (Kelly plug-in from past bets only, 30-bet warm-up, cap 0.5 / (1 + b), variance
 * floor 1e-6), run with threshold 800 and lossUnbounded.
 * - THE NULL ACTUALLY TESTED (as lab-v2): H0': E[min(max(R_t / c, -2), 1) | past] <= 0. Losses beyond 2c count at -2c,
 *   and such a loss while betting at the cap ends the test for good.
 * - Threshold 800 per slot is two slots at alpha 0.0025 / 2. With lab-v1 (0.01), lab-v2 (0.01) and lab-v3 (0.005), the
 *   program's forward labs carry 0.0275 in all. The crossing is final.
 * - Read rule: lab-v1's labels, with the 24 months counted from each rule's first graded bar.
 *
 * POWER (Round 3 RESULT, the preview's bootstrap, 24 months, threshold 800): 0 at the measured (negative) edge for
 * both. Even at a true net Sharpe of 2: S1 0.15 iid / 0.19 block, S2 0.12 / 0.14.
 *
 * PREDICTIONS (recorded before any live bar): neither rule crosses 800 within 24 months. Both lose about 0.1% a trade
 * after costs, as on history.
 *
 * TRIALS: none added. Both cells were previewed and counted in the ledger entry round3-lab-v4-preview (total 2,204).
 *
 * PARITY (real data, run on the VPS 2026-10-22 with scripts/research/lab-v4-parity.ts, image crypto-ops:labv4-parity at
 * 14e4b2f, the Round 3 dataset 1b910017b868, output $HOME/labv4-parity/parity.json):
 * - Signals: on 386,890 of 386,890 coin-bars (every bar from each coin's 720th bar to 2026-06-30), the live
 *   s1SideAtLast and s2SideAtLast over a rolling 720-bar window equal the preview's c1Signals and c2Signals.
 * - Trades: on that complete, gap-free history with every hour run, the overlap rule (re-implemented in the parity script
 *   as the preview states it) reproduces 2,430 of 2,459 S1 and 1,576 of 1,594 S2 preview trades, and adds none. The
 *   other 29 and 18 are exactly the preview trades that enter within each coin's first 720 bars, before a live window
 *   could be full (counted per coin with tradesFor on the same data). The live-only differences declared under
 *   STATISTIC are not exercised by this check.
 * REST CHECK (same run): perp 1h bars for the 10 coins from 2026-06-01 to 2026-06-29, fetched by REST as the live job
 * does, equal the archive on every bar (0 time and 0 field mismatches, taker buy volume included).
 *
 * READ RULE, FAILURE ACTION: as lab-v1. Trading either rule is a separate owner decision outside this lock.
 * OPERATIONS: lab-v4 is graded in the hourly lab run in its own pass (job-grade-v4.ts), after the lab-v1 to v3 pass,
 * with sequential kline fetches 250 ms apart, made separately for each rule, so one rule waiting cannot stop the other
 * rule's grading. Either pass failing or throwing is caught and reported, and cannot stop the other. A failure marks that run's lab-grade heartbeat failed. None of this changes any stored value.
 *
 * LOCK START: the live job scores only the bar that has just closed. The first lab-v4 bar is the first 1h close after
 * the cron container is recreated with the two lab-v4 lines (the app deploy alone does not start the job). AMENDMENT 1
 * will record that time.
 */

import {
  LAB_HYPOTHESES_V4,
  LAB_V4_HOLD_MS,
  LAB_V4_ROUND_TRIP,
  LAB_V4_THRESHOLD,
  LAB_VERSION_V4,
} from '@/lib/signals/lab/candidates';
import { LAB_V4_WINDOW_BARS } from '@/lib/signals/lab/v4/rules';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

export const LAB_FORWARD_V4_LOCK = {
  version: 'lab-v4',
  override: { by: 'owner', date: '2026-10-22', afterResult: true, overrides: 'scripts/research/lab-v4-preview.ts decision table at 05d427f' },
  hypotheses: [
    { id: 'S1-1h', candidate: 'S1', timeframe: '1h', metric: 'trade', scale: 0.15, previewCell: 'C1' },
    { id: 'S2-1h', candidate: 'S2', timeframe: '1h', metric: 'trade', scale: 0.14, previewCell: 'C2' },
  ],
  slots: 2,
  alphaPerSlot: 0.00125,
  threshold: 800,
  delayMs: 600_000,
  holdMs: 8 * 3_600_000,
  roundTrip: 0.0014,
  windowBars: 720,
  swingLength: 20,
  divergenceMaxBars: 72,
  universe: SIGNAL_SYMBOLS,
  ledgerTotal: 2204,
  maxMonths: 24,
} as const;

export const LOCKED_CODE = {
  LAB_HYPOTHESES_V4,
  LAB_V4_THRESHOLD,
  LAB_VERSION_V4,
  LAB_V4_ROUND_TRIP,
  LAB_V4_HOLD_MS,
  LAB_V4_WINDOW_BARS,
};
