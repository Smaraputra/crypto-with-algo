"""ROUND 4 METHOD LOCK (M), LOCK TEXT V3. Plan of record: ~/.claude/plans/squishy-zooming-wilkes.md (owner-approved
2026-10-25). Gate M reviewed version 1 and version 2 (Opus, 2026-10-25, both PASS WITH FIXES). Neither was signed.
This version adopts both reviews' fixes (.superpowers/sdd/round4/gates/). It is committed before any Round 4 model
reads development outcomes, and the owner signs it. Changes after the first development read are AMENDMENTS appended
below, never edits.

WHAT WAS READ BEFORE THIS LOCK (disclosed)
- Development D (perp 2022-01-01 to 2026-06-30) was read by earlier studies (Phases 3 to 5, Rounds 1 to 3).
- The Phase 1 audit read code and production counts only (.superpowers/sdd/round4/audit.md).
- The overlap simulation and the pipeline's statistical tests used synthetic data only.
- Holdout H was ingested on 2026-10-25 (counts only). No study has computed anything on it, and the Round 4 export
  (~/round4-ds, datasetHash 11c87b9c8a97...) holds D only.

PARTITIONS AND DATA EDGES
- DEV_START 2022-01-01, DEV_END 2026-07-01 (exclusive): perp 5m, 15m, 1h, 4h and 1d bars, premium index and funding
  settlements of the 10 signal coins.
- Tier B inputs (futures metrics, depth, aggTrades flow, options) develop from 2023-01-01 only. A Tier B row stamped
  t is usable at T only if t + 5 minutes <= T.
- Recent R: 2026-07-01 to the date of this lock, descriptive only, never used to select.
- Holdout H 2020-01-01 to 2022-01-01 (exclusive), perp 5m to 4h from each coin's first archive bar. Perp 1d bars and
  funding before 2022 were read by the broad studies and are disclosed as read inputs.
- Universe: the 10 signal coins (BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK), every family included. Their
  2026 selection is the program's known survivorship limit, stated in every result.
- Edges:
  - a D sample whose label ends at or after DEV_END is dropped, and so is an H sample whose label ends at or after
    H_END;
  - a D sample whose features would need intraday bars before DEV_START has missing features and is dropped (the
    loader serves no intraday row before 2022 for D);
  - a sample with ANY missing feature is dropped, never imputed, and no missing value reaches a model;
  - a tranche whose window lacks a funding settlement the coin's interval in force says must exist is dropped and
    counted (funding is never assumed);
  - the EMA warm-ups make the first months of D and of each H coin sparse, which is disclosed.

TIMING, COSTS AND THE BOOK RULE
- Decision at the close T of a perp 1h or 4h bar. Inputs: bars closed at T only (t + interval <= T), settlements
  with t <= T.
- Entry at the open of the 5m bar starting at T + 10 minutes. Exit at the open of the 5m bar starting at
  T + 10 minutes + h. Horizons: h in {4h, 8h} at 1h, and h in {4h, 8h, 24h} at 4h.
- Costs: Binance USDT-M VIP 0 (maker 0.02%, taker 0.05%), with study slippage on taker fills (3 bps at 1h, 2 bps at
  4h), charged as abs(weight) x rate on the fill day. Funding is the sum of actual settlements in (entry, exit] times
  -weight, and a positive rate means longs pay.
- r4.costs reproduces the fee, slippage and funding functions of src/lib/backtest/cost-model.ts and funding.ts to
  1e-8. Labels use the Round 4 additive convention, which agrees with the TypeScript multiplicative slippage to first
  order.
- BOOK RULE: the equity is split into 10 equal coin slots. Each decision on a coin opens one tranche of weight
  w = side x size x (interval / h) x 1/10, with h the configured horizon even if a declared exit closes the tranche
  earlier, so overlapping tranches stack to at most one slot.
  - size is 1 unless the family's declared rule sets it in [0, 1].
  - Family D replaces the slot rule: each decision sets dollar-neutral target weights w_i with sum of abs(w_i) = 1,
    and each tranche carries w_i x interval / h.
  - Each UTC day, a tranche's part inside the day is marked in log return at the 00:00 5m open (carried from the last
    5m open before midnight if that bar is missing, and counted).
  - Settlements in (day start, day end] go to that day.
- Triple-barrier labels: barriers at entry x exp(+-1.0 x sigma_h), with sigma_h = sqrt(the sum of squared 5m log
  returns over the 24 hours to T, times h / 24 hours). A missing 5m bar in that window makes sigma_h missing and drops
  the sample.
  - The scan covers the 5m bars from the entry bar (included) to the horizon.
  - A take-profit needs a strict trade-through and fills as maker at the barrier.
  - A stop fills as taker at the worse of the barrier and the touching bar's open.
  - A bar trading through both books the stop.

THE DRIFT-FREE DAILY SERIES (used by every gate)
- For each UTC day d, the drift-free daily return of a configuration is the beta-hedged book return
    D_d = sum over tranches open in day d of w x (r_coin - beta_coin x r_EW) - costs_d + funding_d,
  where:
  - r_coin is the log return of the tranche's part inside the day;
  - r_EW is the mean log return of the 10 coins over the SAME interval;
  - beta_coin is the OLS slope of the coin's daily log return on the 10-coin daily mean.
- beta_coin is estimated on the training window of each walk-forward fold, and on all of D for H and lab-v5, where it
  is fixed in the finalist lock.
- A no-bet day (no open tranche) is a zero in this series for every statistic below, except c and the lab-v5 power,
  which use bet days only. The common span of a family is its walk-forward span (from its first refit to DEV_END).
- The raw (unhedged) book return is reported beside every result and is never gated.

TRAINING, CUTOFFS AND VALIDATION
- Walk-forward (the deployable path): refit at the first instant of each UTC month from 2023-01-01 (from 2024-01-01
  for Tier B and for family B, so all its primaries share one span) to DEV_END.
  - Each month is a test block.
  - Training holds samples with t1_max < refit within the lookback arm: 12 months, 24 months or all of D (12 months
    and all for Tier B).
  - Preprocessing and any family C filter are fitted on each training window only.
  - LightGBM uses a fixed number of trees per declared setting, with no early stopping.
- The no-refit arm is fit once on all data before the first refit and never refit, as a single configuration.
- CPCV on the pooled, time-sorted panel: 6 groups by time (ties share a group), 2 test groups, purging any training
  sample whose [t0, t1_max] overlaps a test block on any coin, and an embargo of 30 days after each block.
  - Lookback arms apply to the walk-forward only.
  - CPCV is a necessary hurdle and is never used for ranking, c, H power or finalist evidence.
  - Features with lookbacks over 30 days (trend_1d, atr14_1d, dist_pdh, dist_pdl, dist_poc, trend_4h, funding_z30d)
    can carry test-period prices into post-test training rows. Leakage biases CPCV upward, so it can only make the
    hurdle easier, which is disclosed. Each finalist also gets a descriptive CPCV with a 200-day embargo.
- Refit question: the monthly refit is adopted for the live model only if the paired block-bootstrap 90% interval
  (mean block 10 days, 1,000 reps) of the drift-free daily mean difference (refit minus no-refit) lies entirely above
  zero.
- Final model of a finalist: fit with its lookback arm on the window ending at the cutoff, DEV_END minus 30 days.

TRIALS, BUDGET AND LEDGER
- ANY computation of a D outcome (walk-forward, CPCV, a probe, a re-run after a code fix) is a trial, and the count
  never goes down. A configuration is fully specified by:
  - family, model, hyperparameter setting, feature set;
  - interval, horizon, label type, decision threshold, side rule, size rule;
  - family C filter (on or off);
  - lookback or refit arm, exit rule.
- Caps: A 48, B 24, D 12, E 24, re-tests 12 (120 alpha-bearing). C (forecasts) is capped at 12 and counted
  separately. Re-runs consume the cap, and a family that reaches its cap stops.
- Each family appends one entry to scripts/research/ledger.ts in the commit that declares its configurations, before
  it runs, and appends re-runs as they happen. The program count before Round 4 is 2,204. Controls (Phase 4) are
  recorded in the ledger and are excluded from the trial-Sharpe variance.

EXPLORATION BAR (a configuration becomes a finalist only if all hold; every expectancy is on the drift-free series)
1. Walk-forward drift-free daily mean above zero, and at least 4 of the 5 CPCV paths with a positive drift-free mean.
2. PBO at most 0.25 (CSCV, 16 groups, on the family's drift-free daily matrix over its common span).
3. Deflated Sharpe probability at least 0.95 on the drift-free daily series (n = calendar days of the span, no-bet
   days zero), with N = max(120, the round's alpha-bearing ledger count at round close) for every configuration. The
   variance of trial Sharpes is taken over the round's alpha-bearing configurations at round close, identical
   configurations counted once. Round close is the commit of the last family's results. Also reported at the program
   count (2,204 + N).
4. Run only for configurations passing items 1 to 3:
   - Joint-shift random-entry null: 1,000 circular shifts of the whole tranche set by whole days (at least 7), all
     coins together with the same sizes, sides and holds. The statistic is the drift-free return per unit of absolute
     weight over the kept tranches. A shifted tranche that wraps past the span or lands on missing data is dropped,
     and the drop share is reported. p = (1 + count(null >= observed)) / (1 + 1000), below 0.05.
   - Hansen SPA on the family's drift-free daily matrix over its common span, against zero, using Hansen's consistent
     p-value (SPA_c), stationary bootstrap with mean block 10 days, 1,000 reps. p below 0.05. It corrects for
     selection within a family. The deflated Sharpe at N covers selection across families.
   - Label-shift tripwire: 100 panel-wide circular shifts of labels against features by at least 30 days. If more
     than 60 of 100 give a positive drift-free mean, the family halts for a leakage review.
5. At least 7 of 10 coins with a positive drift-free daily mean (each coin's tranches alone), or for family D a
   drop-one-coin jackknife that stays positive.
6. Fees x1.5 and slippage x2, and separately every maker fill repriced as taker, each keep the drift-free daily mean
   at or above zero.
- Finalists are ranked by the drift-free daily Sharpe. At most one finalist per (family, model), and at most 3
  directional finalists in all.
- Family C (forecasts, no trading):
  - QLIKE and log-variance MSE better than persistence and EWMA (halflife 7 windows) with a Diebold-Mariano p below
    0.05 (HAC with lag h) on the walk-forward path;
  - 80% and 95% coverage of the horizon log return within 2 points of nominal;
  - on at least 8 of 10 coins.
  At most 1 forecast finalist, the configuration with the best walk-forward QLIKE.
- Stay-out flag (part of the family C finalist), two conditions:
  - forecast volatility above its trailing 90-day 90th percentile passes if the block-bootstrap (mean block 10 days)
    95% interval of the realised-volatility ratio of flagged over unflagged windows lies entirely above 1;
  - a forecast range over the hold below 3 times the round-trip cost passes if at least 60% of flagged windows have a
    realised high-low range below 3 times the cost.

PIPELINE CALIBRATION (Phase 4, before any family runs; each prediction is committed before its run)
- Positive control: a planted edge injected into D returns, at an effect the power simulation says is detected with
  probability at least 0.8. The pipeline must detect it.
- Noise control: 40 random-feature configurations. At most 5 may pass items 1 to 3, and at most 6 may reject the
  joint-shift null at 0.05.
- Re-tests of closed rules as labelled re-reads (re-tests budget): v8 at 1h and 4h, rv-v1, Round 1 C1, lab-v4 S1 and
  S2, and N2, N3 and F1 where their shape fits. They are negative controls. One that passes means the pipeline is
  presumed defective until an independent re-implementation agrees.
- lab-v5 grading null: the beta-hedged daily e-process under a correlated no-edge null (correlation as measured in D),
  with its false-crossing rate against 1/600 reported before any lab-v5 code exists.
- Gate P: an Opus review accepts the pipeline only if every control behaves as predicted.

HOLDOUT H
- All finalist locks (directional and forecast) are committed and signed before the first H read, and the reads run in
  one batch.
- Before each read, Claude verifies three things: the read id equals the 40-character sha of a commit that adds that
  finalist's lock; the commit is an ancestor of research/round4; the working tree is clean.
- The r4.data ledger at the fixed path ~/round4-out/holdout-reads.jsonl records (read_id, finalist_id, path). It
  refuses a fifth read id, a second read id for the same finalist, and a repeated (read_id, path). The cache never
  holds H rows.
- Each finalist lock states three things before any read:
  - the frozen procedure, the model artifact hash and beta_coin from D;
  - the power: a block-bootstrap of the finalist's D drift-free daily series, with its deviations about the mean
    rescaled by the H-to-D ratio of 1d realised volatility, resampled to the length of H's span and shifted to half
    its mean, for the H criterion "drift-free mean above zero";
  - the pass criteria below.
- Directional H pass, applied once with the final model and no refit inside H:
  - drift-free daily mean above zero, on all coins with data and separately on the six coins listed by February 2020
    (BTC, ETH, XRP, LINK, ADA, BNB);
  - at least 60% of the coins with data positive. A coin has data if it has at least 30 graded tranches after its
    first 60 days of listing;
  - fees x1.5 and slippage x2 keep the drift-free mean at or above zero;
  - the joint-shift null with p below 0.05/3.
- Forecast H pass: the family C criteria on H for the forecast finalist and its stay-out flag, at p below 0.05 (its own
  read id).
- If the stated power is below 0.5, a fail is recorded as inconclusive. An inconclusive finalist is not promoted, is
  never read again, and gets no lab-v5. An H pass still counts at any power.
- A Tier B finalist skips H, runs forward only and is never shown as provisional.

LAB-V5 (FORWARD)
- A directional finalist gets a lab-v5 slot only after an H pass (Tier B excepted, forward only).
- Statistic: the drift-free daily series D_d of the finalist with beta_coin from D, x = min(D_d / c, 1), placing no bet
  on a no-bet day. Unbounded losses: a day with x below -2 is counted at -2 and ends the test (loss floor -2, H0'). The
  raw book return e-process is kept as a descriptive record.
- Threshold 600 per slot: e-Bonferroni arithmetic, 3 slots at alpha 0.005. Warm-up 30 bets.
- c = 4 times the SD of the finalist's D walk-forward drift-free daily series over bet days, fixed in the finalist
  lock before H, never taken from H or R.
- Missing data:
  - a missing price waits, never dropped, and is carried to the next priced bar for marking;
  - a missing funding settlement waits at most 72 hours, then the day is graded with the settlements found and the gap
    is recorded.
- Validity: the days are disjoint and the bets are sized from earlier days only, so the e-process is a supermartingale
  under the null of no edge given the information at each entry. The overlap simulation is a consistency check: at
  k = 600, daily mark-to-market grading had 0 crossings (continuation) and 1 (fade) in 50,000 no-edge paths each,
  against 119 (0.238%, above 1/600) for lab-v4's per-trade grading.
- The lab-v5 lock states honest power and a 24-month limit.
- Promotion: an H pass puts the finalist on the paper desk and Focus as "provisional". "Validated" only when its lab-v5
  e-process crosses. The family C forecast reaches Focus after its own H pass.

PREDICTIONS (recorded before any development read)
- Given 2,204 earlier trials with no pass, the most likely outcome is that no directional configuration meets the
  exploration bar.
- Family C (volatility) is the likeliest to pass its forecast bar, because volatility clustering is the one effect the
  program has replicated.
- If a directional configuration passes, it is most likely at 1h with BTC-relative or intrabar flow inputs. We predict
  it does not pass H.

STOP RULE
- If no configuration meets the exploration bar within the budget, Round 4 closes with no lab-v5, and the RESULT block
  says so.
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
CPCV_LONG_LOOKBACK_FEATURES: tuple[str, ...] = (
    "trend_1d",
    "atr14_1d",
    "dist_pdh",
    "dist_pdl",
    "dist_poc",
    "trend_4h",
    "funding_z30d",
)
FINALIST_DESCRIPTIVE_CPCV_EMBARGO_MS: int = 17280000000

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
DSR_TRIALS_MIN: int = 120
PROGRAM_TRIALS_BEFORE: int = 2204
MAX_FINALISTS: int = 3
MAX_FORECAST_FINALISTS: int = 1
MAX_H_READ_IDS: int = 4

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
STAY_OUT_BLOCK_DAYS: int = 10

CONTROLS: dict[str, int | float] = {
    "positive_detection_power_min": 0.80,
    "noise_configs": 40,
    "noise_pass_max": 5,
}
NOISE_SHIFT_REJECT_MAX: int = 6

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
    "power_min": 0.5,
}
H_NULL_P_MAX: float = 0.05 / 3

JOINT_SHIFT_GRID_MS: int = 86400000
HOLDOUT_LEDGER_PATH: str = "~/round4-out/holdout-reads.jsonl"
LABEL_SHIFT_TRIPWIRE: int = 60

LAB_V5: dict[str, Any] = {
    "alpha": 0.005,
    "max_slots": 3,
    "threshold": 600,
    "warmup_bets": 30,
    "scale_sd_multiple": 4.0,
    "loss_floor_x": -2.0,
    "statistic": "daily_beta_hedged_book_return",
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
    "CPCV_LONG_LOOKBACK_FEATURES",
    "CPCV_TEST_GROUPS",
    "DECISION_INTERVALS_MS",
    "DEV_END",
    "DEV_START",
    "DSR_TRIALS_MIN",
    "ENTRY_DELAY_MS",
    "FINALIST_DESCRIPTIVE_CPCV_EMBARGO_MS",
    "HOLDOUT_LEDGER_PATH",
    "HORIZONS_MS",
    "H_EARLY_COINS",
    "H_END",
    "H_NULL_P_MAX",
    "H_RULES",
    "H_START",
    "JOINT_SHIFT_GRID_MS",
    "LAB_V5",
    "LABEL_SHIFT_TRIPWIRE",
    "MAX_FINALISTS",
    "MAX_FORECAST_FINALISTS",
    "MAX_H_READ_IDS",
    "NOISE_SHIFT_REJECT_MAX",
    "PROGRAM_TRIALS_BEFORE",
    "REFIT",
    "SIGMA_TRAILING_MS",
    "STAY_OUT",
    "STAY_OUT_BLOCK_DAYS",
    "TIER_B_STAMP_MS",
    "TIER_B_START",
    "TRIPLE_BARRIER_K",
    "UNIVERSE",
    "WF_FIRST_REFIT",
    "WF_FIRST_REFIT_TIER_B",
    "WF_LOOKBACK_ARMS_MONTHS",
    "WF_LOOKBACK_ARMS_MONTHS_TIER_B",
]
