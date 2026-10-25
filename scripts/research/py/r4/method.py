"""ROUND 4 METHOD LOCK (M), LOCK TEXT V2. Plan of record: ~/.claude/plans/squishy-zooming-wilkes.md (owner-approved
2026-10-25). Version 1 was reviewed at gate M (Opus, 2026-10-25, PASS WITH FIXES) and never signed. This version
adopts that review's fixes. It is committed before any Round 4 model reads development outcomes and the owner signs
it. Changes after the first development read are AMENDMENTS appended below, never edits.

WHAT WAS READ BEFORE THIS LOCK (disclosed)
- Development D (perp 2022-01-01 to 2026-06-30) was read by earlier studies (Phases 3 to 5, Rounds 1 to 3).
- The Phase 1 audit read code and production counts only (.superpowers/sdd/round4/audit.md).
- The overlap simulation used synthetic prices only (scripts/research/round4-overlap-sim.ts, 89f525ee and d6d6c07a).
- Holdout H was ingested on 2026-10-25 (counts only). No study has computed anything on it, and the Round 4 export
  (~/round4-ds on the VPS) holds D only.

PARTITIONS
- DEV_START 2022-01-01, DEV_END 2026-07-01 (exclusive): perp 5m, 15m, 1h, 4h and 1d bars, premium index and funding
  settlements of the 10 signal coins.
- Tier B inputs (futures metrics, depth, aggTrades flow, options) develop from 2023-01-01 only. A Tier B row stamped
  t is usable at T only if t + 5 minutes <= T. A row with a missing Tier B input is dropped, never imputed.
- Recent R: 2026-07-01 to the date of this lock, descriptive only, never used to select.
- Holdout H 2020-01-01 to 2022-01-01 (exclusive), perp 5m to 4h from each coin's first archive bar. An H sample
  whose label ends at or after 2022-01-01 is dropped, so no H label overlaps a training label in D. Perp 1d bars
  and funding before 2022 were read by the broad studies, so H's daily context and funding inputs are disclosed as
  read.
- Universe: the 10 signal coins (BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK), every family included. Their
  2026 selection is the program's known survivorship limit, stated in every result.

TIMING, COSTS AND THE BOOK RULE
- Decision at the close T of a perp 1h or 4h bar. Inputs: bars closed at T only (t + interval <= T), settlements
  with t <= T.
- Entry at the open of the 5m bar starting at T + 10 minutes. Exit at the open of the 5m bar starting at
  T + 10 minutes + h. Horizons: h in {4h, 8h} at 1h, and h in {4h, 8h, 24h} at 4h.
- Costs: Binance USDT-M VIP 0 (maker 0.02%, taker 0.05%), with study slippage on taker fills (3 bps at 1h, 2 bps at
  4h). Funding is the sum of actual settlements in (entry, exit], and a positive rate means longs pay.
- r4.costs reproduces the fee, slippage and funding functions of src/lib/backtest/cost-model.ts and funding.ts to
  1e-8. Labels use r4.costs.trade_net_return, the Round 4 additive convention, which agrees with the TypeScript
  engine's multiplicative slippage to first order.
- BOOK RULE: the equity is split into 10 equal coin slots. Each decision on a coin opens one tranche of weight
  side x size / (h / interval) of that coin's slot, held to its exit, so overlapping tranches stack up to one slot.
  - size is 1 unless a family's declared rule sets it in [0, 1].
  - The daily mark-to-market book return of a UTC day is the sum over tranches open during that day of
    weight x the log return of the tranche's part inside the day, marked at the 00:00 5m open.
  - Costs are charged on the fill day, and funding settlements in (day start, day end] go to that day.
  - A day with no open tranche places no bet.
- Triple-barrier labels: barriers at entry x exp(+-1.0 x sigma_h), where
  sigma_h = sqrt(the sum of squared 5m log returns over the 24 hours to T, times h / 24 hours) (trailing realised
  variance, not a family C forecast, so labels never depend on a fitted model).
  - A take-profit needs a strict trade-through (high > upper for a long, low < lower for a short) and fills as maker
    at the barrier.
  - A stop fills as taker at the worse of the barrier and the touching bar's open.
  - A bar trading through both barriers books the stop.

TRAINING, CUTOFFS AND VALIDATION
- Walk-forward (the deployable path): refit at the first instant of each UTC month from 2023-01-01 (from 2024-01-01
  for Tier B) to DEV_END. Each month is a test block. Training holds samples whose label horizon ends before the
  refit (t1_max < refit). Lookback arms: 12 months, 24 months and all of D (12 months and all for Tier B).
- The no-refit arm is fit once on all data before the first refit and never refit. It is a single configuration
  with no lookback variants.
- Preprocessing (scaling, encoding) is fitted on each training window only. LightGBM uses a fixed number of trees
  per declared setting, with no early stopping.
- CPCV on D runs on the pooled, time-sorted panel of all coins:
  - 6 groups by time, so all coins share the same group boundaries and tied timestamps stay in one group;
  - 2 test groups (15 splits, 5 paths);
  - purging every training sample whose [t0, t1_max] overlaps a test block's span on ANY coin;
  - embargo 30 days after each test block.
  - Features with lookbacks over 30 days (the 1d EMA trend over 200 days) can still carry test-period prices into
    post-test training rows in CPCV. That is disclosed. The walk-forward is unaffected.
- Refit question: the monthly refit arm is adopted for the live model only if the paired block-bootstrap 90%
  interval (mean block 10 days, 1,000 reps) of the walk-forward daily net mean difference (refit minus no-refit)
  lies entirely above zero. Otherwise the live model is not refit after its final fit.
- Final model of a finalist: fit with the selected lookback arm on the window ending at the cutoff, DEV_END minus
  30 days. Nothing after the cutoff is ever training data for it.

TRIALS, BUDGET AND LEDGER
- Every distinct outer walk-forward result computed is one trial, re-runs after a code fix included. The count never
  goes down. A configuration is fully specified by:
  - family, model, hyperparameter setting, feature set;
  - interval, horizon, label type (fixed or triple-barrier);
  - decision threshold and side rule, size rule;
  - family C filter (on or off);
  - lookback or refit arm, exit rule.
- Caps: A 48, B 24, D 12, E 24, re-tests 12 (120 alpha-bearing). C (forecasts) is capped at 12 and counted
  separately.
- Each family appends one entry to scripts/research/ledger.ts in the commit that declares its configuration list,
  before it runs. The program count before Round 4 is 2,204.

EXPLORATION BAR (a configuration becomes a finalist only if all hold)
1. Walk-forward drift-free net expectancy above zero, and at least 4 of the 5 CPCV paths net positive.
   Drift-free trade return = side x (r - m x hold) net of costs and funding, where m is the coin's mean log return
   per hour over the evaluation span.
2. PBO at most 0.25 (CSCV, 16 groups, on the family's daily mark-to-market net returns, by configuration).
3. Deflated Sharpe probability at least 0.95 on the configuration's daily mark-to-market book returns (n = days),
   with N = 120 for every configuration whatever the order. The variance of trial Sharpes is taken over all the
   round's alpha-bearing configurations at round close, and identical configurations are counted once. Also
   reported at the program count (2,204 + 120).
4. Two tests, run only for configurations passing items 1 to 3:
   - Random-entry null with the same entry structure: 1,000 circular time shifts of the whole entry set (all coins
     together, same coins, sides, sizes and holds), each by at least 7 days. p below 0.05.
   - Hansen SPA test of the family's walk-forward daily net-return matrix against zero (stationary bootstrap, mean
     block 10 days, 1,000 reps), consistent p below 0.05. This corrects for selection within the family.
   - A diagnostic only: a panel-wide circular shift of labels against features by at least 30 days (100 shifts).
5. At least 7 of 10 coins with positive walk-forward drift-free net expectancy, or for a cross-section a drop-one-coin
   jackknife that stays positive.
6. Fees x1.5 and slippage x2, and separately every maker fill repriced as taker, each keep net expectancy at or
   above zero.
- Finalists are ranked by walk-forward drift-free daily net Sharpe. At most one finalist per (family, model) and at
  most 3 in all.
- Family C (forecasts, no trading):
  - QLIKE and log-variance MSE better than persistence and EWMA (halflife 7 windows) with a Diebold-Mariano p below
    0.05 (HAC with lag h) on the walk-forward path;
  - 80% and 95% coverage of the horizon log return within 2 points of nominal;
  - on at least 8 of 10 coins.
- Stay-out flag, two conditions:
  - forecast volatility above its trailing 90-day 90th percentile passes if the block-bootstrap 95% interval of the
    realised-volatility ratio (flagged over unflagged windows) lies entirely above 1;
  - a forecast range over the hold below 3 times the round-trip cost passes if at least 60% of flagged windows have a
    realised high-low range below 3 times the cost.

PIPELINE CALIBRATION (Phase 4, before any family runs; each prediction is committed before its run)
- Positive control: a planted edge injected into D returns, at an effect the power simulation says is detected with
  probability at least 0.8. The pipeline must detect it.
- Noise control: 40 random-feature configurations. At most 5 may pass items 1 to 3.
- Re-tests of closed rules as labelled re-reads (counted in the re-tests budget): v8 at 1h and 4h, rv-v1, Round 1
  C1, lab-v4 S1 and S2, and N2, N3 and F1 where their shape fits. They are negative controls. One that passes means
  the pipeline is presumed defective until an independent re-implementation agrees.
- lab-v5 grading null: the drift-hedged daily mark-to-market e-process under a correlated no-edge null (correlation
  as measured in D), with its false-crossing rate against 1/600 reported before any lab-v5 code exists.
- Gate P: an Opus review accepts the pipeline only if every control behaves as predicted.

HOLDOUT H
- All finalist locks are committed and signed before the first H read. The reads then run in one batch.
- Each H read goes through the r4.data read-once ledger, keyed to the finalist lock's 40-character commit sha. There
  are at most 3 read ids, and the Parquet cache holds guarded rows only.
- Each finalist lock states three things before any H read:
  - the frozen procedure and the model artifact hash;
  - H's power: a block-bootstrap simulation of the finalist's D walk-forward drift-free net series at half its mean,
    rescaled by the H-to-D ratio of 1d realised volatility;
  - the pass criteria below.
  If that power is below 0.5, an H fail is recorded as inconclusive (low power), not as evidence against, and an H
  pass still counts.
- H pass criteria, applied once with the final model and no refit inside H:
  - drift-free net expectancy above zero, on all coins with data and separately on the six coins listed by
    February 2020 (BTC, ETH, XRP, LINK, ADA, BNB);
  - at least 60% of the coins with data positive. A coin has data if it has at least 30 graded trades after its
    first 60 days of listing;
  - fees x1.5 and slippage x2 keep net expectancy at or above zero;
  - the random-entry joint-shift null with p below 0.0167 (0.05 over 3 finalists).
- A Tier B finalist skips H and runs forward only, with no provisional surface until its e-process crosses.

LAB-V5 (FORWARD)
- Statistic: the drift-hedged daily mark-to-market book return
  R_d = (book return of day d) - (net weight at the start of day d) x (the equal-weight 10-coin log return of day d),
  under the BOOK RULE, x = min(R_d / c, 1), with unbounded losses (H0': losses beyond 2c counted at 2c). The raw book
  return e-process is kept as a descriptive record.
- Threshold 600 per slot: e-Bonferroni arithmetic, 3 slots at alpha 0.005. Warm-up 30 bets.
- c = 4 times the SD of the finalist's D walk-forward drift-hedged daily net book return, fixed in the finalist lock
  before H, never taken from H or R.
- Missing data:
  - a missing price waits, never dropped, and is carried to the next priced bar for marking;
  - a missing funding settlement waits at most 72 hours, then the day is graded with the settlements found and the
    gap is recorded.
- Validity: daily mark-to-market bets are disjoint in time and sized from earlier days only, so the e-process is a
  supermartingale under the null of no edge given the information at each entry. The overlap simulation is a
  consistency check. At k = 600 it had 0 crossings (continuation) and 1 (fade) in 50,000 no-edge paths each, against
  lab-v4's per-trade grading at 119 crossings (0.238% against 1/600).
- The lab-v5 lock states honest power and a 24-month limit.
- Promotion: an H pass puts the finalist on the paper desk and Focus as "provisional". "Validated" only when its
  lab-v5 e-process crosses. The volatility forecast (family C) reaches Focus after its own H forecast read.

PREDICTIONS (recorded before any development read)
- Given 2,204 earlier trials with no pass, the most likely outcome is that no directional configuration meets the
  exploration bar.
- Family C (volatility) is the likeliest to pass its forecast bar, because volatility clustering is the one effect
  the program has replicated.
- If a directional configuration passes, it is most likely at 1h with BTC-relative or intrabar flow inputs. We
  predict it does not pass H on the drift-free reading.

STOP RULE
- If no configuration meets the exploration bar within the budget, Round 4 closes with no lab-v5 and the RESULT
  block says so.
- An override must be recorded as an amendment that quotes the result it overrides, as lab-v4 was.
"""

from __future__ import annotations

from typing import Any

# Times in epoch ms (UTC)
DEV_START: int = 1640995200000
DEV_END: int = 1782864000000
TIER_B_START: int = 1672531200000
WF_FIRST_REFIT: int = 1672531200000
WF_FIRST_REFIT_TIER_B: int = 1704067200000
H_START: int = 1577836800000
H_END: int = 1640995200000

UNIVERSE: tuple[str, ...] = (
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
    "DOTUSDT",
    "LINKUSDT",
)

H_EARLY_COINS: tuple[str, ...] = (
    "BTCUSDT",
    "ETHUSDT",
    "XRPUSDT",
    "LINKUSDT",
    "ADAUSDT",
    "BNBUSDT",
)

DECISION_INTERVALS_MS: dict[str, int] = {
    "1h": 3600000,
    "4h": 14400000,
}

ENTRY_DELAY_MS: int = 600000

HORIZONS_MS: dict[str, tuple[int, ...]] = {
    "1h": (14400000, 28800000),
    "4h": (14400000, 28800000, 86400000),
}

CPCV_GROUPS: int = 6
CPCV_TEST_GROUPS: int = 2
CPCV_EMBARGO_MS: int = 2592000000

WF_LOOKBACK_ARMS_MONTHS: tuple[int | None, ...] = (12, 24, None)
WF_LOOKBACK_ARMS_MONTHS_TIER_B: tuple[int | None, ...] = (12, None)

TRIPLE_BARRIER_K: float = 1.0
SIGMA_TRAILING_MS: int = 86400000

BUDGET: dict[str, int] = {
    "A": 48,
    "B": 24,
    "D": 12,
    "E": 24,
    "retests": 12,
}

BUDGET_FORECAST_C: int = 12
DSR_TRIALS: int = 120
PROGRAM_TRIALS_BEFORE: int = 2204
MAX_FINALISTS: int = 3

BAR: dict[str, int | float] = {
    "cpcv_paths_positive_min": 4,
    "pbo_max": 0.25,
    "cscv_groups": 16,
    "dsr_min": 0.95,
    "random_entry_draws": 1000,
    "random_entry_shift_min_days": 7,
    "random_entry_p_max": 0.05,
    "spa_reps": 1000,
    "spa_mean_block_days": 10,
    "spa_p_max": 0.05,
    "label_shift_min_days": 30,
    "label_shift_perms": 100,
    "symbols_positive_min": 7,
    "stress_fee_mult": 1.5,
    "stress_slippage_mult": 2.0,
}

BAR_FORECAST: dict[str, Any] = {
    "dm_p_max": 0.05,
    "coverage_levels": (0.80, 0.95),
    "coverage_tolerance": 0.02,
    "symbols_min": 8,
    "ewma_halflife_windows": 7,
}

STAY_OUT: dict[str, int | float] = {
    "vol_percentile": 0.90,
    "vol_percentile_lookback_days": 90,
    "range_cost_multiple": 3.0,
    "range_share_min": 0.60,
}

CONTROLS: dict[str, int | float] = {
    "positive_detection_power_min": 0.80,
    "noise_configs": 40,
    "noise_pass_max": 5,
}

REFIT: dict[str, Any] = {
    "rule": "paired_block_bootstrap_90ci_entirely_above_zero",
    "mean_block_days": 10,
    "reps": 1000,
}

TIER_B_STAMP_MS: int = 300000

H_RULES: dict[str, int | float] = {
    "min_trades_per_coin": 30,
    "listing_burn_in_days": 60,
    "coin_share_min": 0.6,
    "null_p_max": 0.0167,
    "power_min": 0.5,
}

LAB_V5: dict[str, Any] = {
    "alpha": 0.005,
    "max_slots": 3,
    "threshold": 600,
    "warmup_bets": 30,
    "scale_sd_multiple": 4.0,
    "loss_unbounded": True,
    "statistic": "daily_mtm_drift_hedged_book_return",
    "horizon_months": 24,
}

__all__ = [
    "BAR",
    "BAR_FORECAST",
    "BUDGET",
    "BUDGET_FORECAST_C",
    "CONTROLS",
    "CPCV_EMBARGO_MS",
    "CPCV_GROUPS",
    "CPCV_TEST_GROUPS",
    "DECISION_INTERVALS_MS",
    "DEV_END",
    "DEV_START",
    "DSR_TRIALS",
    "ENTRY_DELAY_MS",
    "HORIZONS_MS",
    "H_EARLY_COINS",
    "H_END",
    "H_RULES",
    "H_START",
    "LAB_V5",
    "MAX_FINALISTS",
    "PROGRAM_TRIALS_BEFORE",
    "REFIT",
    "SIGMA_TRAILING_MS",
    "STAY_OUT",
    "TIER_B_STAMP_MS",
    "TIER_B_START",
    "TRIPLE_BARRIER_K",
    "UNIVERSE",
    "WF_FIRST_REFIT",
    "WF_FIRST_REFIT_TIER_B",
    "WF_LOOKBACK_ARMS_MONTHS",
    "WF_LOOKBACK_ARMS_MONTHS_TIER_B",
]
