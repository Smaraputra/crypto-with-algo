"""Phase 5 family C: the 9 declared volatility forecasts, their criteria and the stay-out flag (A5.1).

FAMILY C DECLARATION (2026-11-04, declared in the commit that adds this module and the ledger entry round4-family-c,
before any family C configuration reads D). Draft 5 of .superpowers/sdd/round4/family-c-draft.md. Nothing here reads
data. Family C trades nothing: it is judged by M's family C criteria and stay-out flag (BAR_FORECAST, STAY_OUT,
STAY_OUT_BLOCK_DAYS in method.py).
- Windows W in {1h, 4h, 1d}, aligned to UTC (1h at every hour, 4h at 00, 04, ..., 20, 1d at 00:00). A window [T, T + W)
  needs exactly the n_W = W / 5m perp 5m open times T, T + 5m, ..., T + W - 5m (an off-grid open time voids it), else
  it is dropped and counted. A 5m bar whose volume is zero or not finite is missing (an exchange placeholder): it voids
  its window like an off-grid open time (no target, no component value), the receipt counts such bars and windows per
  coin, and the 7d and 30d spans then drop up to 30 days of forecasts per coin after each. A window with t1 = T + W
  at or past the partition end (DEV_END on D, H_END on H) is dropped. Returns follow the rv5 convention of
  features.py (r_1 = log(c_1 / o_1), then close to close). RV = sum r^2,
  BPV = (pi / 2) sum_{i>=2} |r_i| |r_(i-1)|, R = log(c_last / o_first), G = log(max high / min low).
- The forecast for [T, T + W) is made at T from complete windows that ended at or before T. X_prev is the window
  [T - W, T), X_1d, X_7d and X_30d are means over the trailing 1, 7 and 30 days (each needs every window of its span,
  X_1d is left out for 1d). Any missing input drops the forecast, nothing is imputed.
- Models, per coin, OLS by numpy.linalg.lstsq (rcond=None), refit at the first instant of each UTC month from
  2023-01-01, 24 months of lookback, at least 500 training windows (t1 < refit) else no forecast for that coin-fold
  (counted). LHAR: log RV on [1, log RV_prev, log RV_1d, log RV_7d, log RV_30d]. LHAR-CJ: continuous (mean BPV) and
  jump (mean max(RV - BPV, 0)) parts, regressors [1, log C_prev, log C_1d, log C_7d, log C_30d, log(1 + J_prev /
  C_prev), log(1 + J_7d / C_7d), log(1 + J_30d / C_30d)]. LHAR-X: LHAR plus the absolute last funding settlement at or
  before T (not older than 8 h + 1 min), the absolute premium-index close of the 5m bar at T - 5m, and BTC's log RV_prev
  (left out for BTC). Forecast f = exp(fitted + s^2 / 2), s^2 the training residual variance on n - k. log(x) is
  log(max(x, 1e-12)), denominators are floored at 1e-12, a non-finite forecast or test statistic cannot pass.
- Benchmarks (not trials): persistence f = RV_prev and an EWMA with halflife 7 windows, initialised with the mean of
  the coin's first 7 complete RVs and updated only on complete windows.
- Criteria, per coin on the walk-forward path, on rows where the configuration, persistence and EWMA all have a
  forecast. Both losses floor y and f at 1e-12 first: QLIKE = y' / f' - log(y' / f') - 1 and log-variance MSE =
  (log y' - log f')^2. Each is tested against persistence and EWMA by a one-sided Diebold-Mariano test (Newey-West lag
  1, Bartlett weights, p = Phi(statistic) below 0.05). Coverage of R by filtered historical simulation, from each
  fold's training z = R / sqrt(f_fit) (numpy linear quantiles at 0.10, 0.90, 0.025 and 0.975), within 2 points of 80%
  and of 95%. A coin passes all six, a configuration passes on at least 8 of 10 coins. Descriptive, never gating: beside
  each gated p a long-lag DM p (Bartlett lags spanning 10 calendar days: 240 at 1h, 60 at 4h, 10 at 1d). The finalist is
  the passing configuration with the lowest score on common (coin, UTC day) support: the coins where every passing
  configuration has a finite mean QLIKE, for each the UTC days on which every passing configuration has a paired row,
  the score the mean over those coins of the coin's mean QLIKE on its paired rows in those days. Ties by registry
  order, a single passing configuration is the finalist, an empty support among two or more gives no finalist.
- Stay-out flag for the finalist. Flag 1: a window is eligible when at least 90 days have passed since the coin's first
  forecast and the coin has a forecast in [T - 90d, T). An eligible window is flagged when sqrt(f) exceeds the 90th
  percentile of the coin's sqrt(f) in [T - 90d, T). Ineligible windows enter neither group. The statistic is the pooled
  ratio of mean sqrt(RV) flagged over unflagged. The interval is a stationary block bootstrap over the full calendar-day
  grid from the first to the last eligible day (mean block 10 days, a day with no window contributes nothing, 1,000
  iterations, seed 12,100,000 + the registry index), 95% interval above 1. Empty groups, a zero denominator and a draw
  without flagged or without unflagged windows fail, with no redraw. Flag 2: sqrt(8 / pi) sqrt(f) below 3 round trips
  (2 x (0.0005 + the coin's A1.1 slippage)), and at least 60% of flagged windows, pooled, with G below the same
  bound. No flagged window means not met. Both must pass. A failed flag blocks the finalist's H read and never selects
  another finalist. Registered prediction (owner 2026-11-04, keep as declared): flag 2 fires only below an annualised
  forecast volatility of 21.1% to 35.2% at 1h, 10.6% to 17.6% at 4h and 4.3% to 7.2% at 1d, so a 1d finalist fails
  condition 2 with no flagged window, a 4h finalist almost surely does, and either is blocked from H.
- Refit question (descriptive): a no-refit twin of the finalist (fit once on all windows before the first refit),
  and a block bootstrap over the full calendar-day grid (a day's value the mean paired QLIKE difference twin minus
  finalist, a day with no paired window contributing nothing, the statistic the mean over drawn days with a value, a
  draw with none left out and counted, 90% interval, mean block 10 days, 1,000 iterations, seed 7,100,000 + the
  registry index). It cannot authorize live refitting. An untrainable twin is inconclusive, and so is a comparison
  whose every draw is empty.
- Holdout H: registered, not implemented. run_holdout raises until the owner signs a finalist lock. The H pass is the
  family C criteria on at least 8 of the 10 coins and both stay-out conditions as on D (condition 1 with seed
  12,200,000 + the registry index), without a power or inconclusive state (owner 2026-11-04, "No inconclusive state"):
  an H fail is a fail. Fit on windows with t1 before DEV_END minus 30 days, no refit inside H, 30-day component and
  90-day forecast warm-ups.
- Regime states are not family C trials: flag 1 is the regime state family C delivers, a later regime model is a new
  trial.
- Seeds: every configuration carries joint_shift_seed 12,000,000 + its registry index (unused, A5.1), the stay-out
  bootstrap uses 12,100,000 + index on D and 12,200,000 + index on H, and the refit bootstrap 7,100,000 + index. No
  other randomness. No configuration, window, model, criterion, seed or rule changes after family C's first D outcome,
  except as M's re-run after a code fix. The 3 reserved slots hold the no-refit twin and re-runs. Ledger:
  round4-family-c, 9 trials, counted separately.
- Predictions: PREDICTIONS below (M's, two diagnostics, and the registered flag 2 consequence).
- Receipts carry cli.reproduction_inputs(), the zero-volume counts and the sha256 of forecasts.parquet.
"""

from __future__ import annotations

import copy
import math
from functools import reduce
from typing import Any

import numpy as np
import pandas as pd

from r4 import costs, method, stats

FAMILY = "C"
FAMILY_INDEX = 2
N_RESERVE = 3
FIRST_REFIT_MS = 1_672_531_200_000
LOOKBACK_MONTHS = 24
MIN_TRAIN_WINDOWS = 500
JOINT_SHIFT_SEED_BASE = 12_000_000
STAY_OUT_SEED_BASE = 12_100_000
STAY_OUT_H_SEED_BASE = 12_200_000
REFIT_SEED_BASE = 7_100_000
LOG_FLOOR = 1e-12
BOOTSTRAP_ITERATIONS = 1000
STAY_OUT_ALPHA = 0.05
REFIT_ALPHA = 0.10
REFIT_BLOCK_DAYS = 10
FEE_PER_SIDE = 0.0005
FUND_MAX_AGE_MS = 8 * 3_600_000 + 60_000
BAR_MS = 300_000
DAY_MS = 86_400_000
BTC = "BTCUSDT"
COVERAGE_QUANTILES = (0.10, 0.90, 0.025, 0.975)
LONG_LAG_DAYS = 10

WINDOWS: dict[str, int] = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
MODELS: tuple[str, ...] = ("LHAR", "LHAR-CJ", "LHAR-X")

PREDICTIONS: dict[str, Any] = {
    "m": "family C is the likeliest to pass its forecast bar",
    "diagnostics": {
        "lhar_beats_benchmarks_on_qlike_at_1h_and_4h_on_most_coins": True,
        "coverage_most_likely_to_fail": "1h",
    },
    "flag2": {
        "registered_by": "owner decision 2026-11-04 (keep as declared)",
        "fires_below_annualised_volatility": {"1h": "21.1% to 35.2%", "4h": "10.6% to 17.6%", "1d": "4.3% to 7.2%"},
        "1d_finalist": "fails stay-out condition 2 with no flagged window",
        "4h_finalist": "almost surely fails stay-out condition 2",
        "consequence": "either is blocked from H, without a replacement",
    },
}


def safe_log(x: Any) -> Any:
    """log(max(x, 1e-12)): the declared floor. NaN stays NaN."""
    return np.log(np.maximum(x, LOG_FLOOR))


def family_c() -> list[dict[str, Any]]:
    """The 9 declared configurations in registry order: windows 1h, 4h, 1d, within each LHAR, LHAR-CJ, LHAR-X."""
    out: list[dict[str, Any]] = []
    for window in WINDOWS:
        for model in MODELS:
            out.append(
                {
                    "id": f"C_{model}_{window}",
                    "family": FAMILY,
                    "kind": "trial",
                    "window": window,
                    "model": model,
                    "refit": "monthly",
                    "lookback_months": LOOKBACK_MONTHS,
                    "first_refit_ms": FIRST_REFIT_MS,
                    "min_train_windows": MIN_TRAIN_WINDOWS,
                    "partition_end_ms": method.DEV_END,
                    "joint_shift_seed": JOINT_SHIFT_SEED_BASE + len(out),
                    "index": len(out),
                }
            )
    return out


def family_c_twin(config_id: str) -> dict[str, Any]:
    """The no-refit twin of a declared configuration: fit once on every window before the first refit."""
    by_id = {c["id"]: c for c in family_c()}
    if config_id not in by_id:
        raise ValueError(f"{config_id!r} is not a declared family C configuration")
    twin = copy.deepcopy(by_id[config_id])
    twin["id"] = f"C_twin_{config_id}"
    twin["refit"] = "none"
    twin["lookback_months"] = None
    twin["twin_of"] = config_id
    return twin


# ---------------------------------------------------------------------------------------------------------------------
# Windows, returns and targets
# ---------------------------------------------------------------------------------------------------------------------


def window_table(
    bars_5m: pd.DataFrame, window_ms: int, end_ms: int | None = None
) -> tuple[pd.DataFrame, dict[str, int]]:
    """RV, BPV, R and G per window on the full UTC grid (NaN where the window has no target), and drop counts.

    A window is [T, T + W), T a multiple of W. Its bars are those with open time in it, exactly the n_W = W / 5m
    grid times T, T + 5m, ... are required (an off-grid open time voids the window). A
    window whose t1 = T + W is at or past `end_ms` is dropped. The rv5 return convention of features.py is used.

    A 5m bar whose volume `v` is zero or not finite is missing (an exchange placeholder, not a trade): it voids its
    window like an off-grid open time. A non-empty frame without a `v` column raises ValueError. `info` counts the
    zero-volume bars in the frame (before the partition-end cut) and the grid windows they void.
    """
    n_w = window_ms // BAR_MS
    cols = ["RV", "BPV", "R", "G"]
    empty = pd.DataFrame(columns=cols, index=pd.Index([], dtype=np.int64, name="T"), dtype=np.float64)
    info = {"n_grid": 0, "n_incomplete": 0, "n_partition_end": 0, "n_zero_volume_bars": 0, "n_zero_volume_windows": 0}
    if bars_5m is None or len(bars_5m) == 0:
        return empty, info
    if "v" not in bars_5m.columns:
        raise ValueError("the 5m frame has no volume column 'v': a zero-volume bar cannot be detected")
    df = bars_5m.sort_values("t").drop_duplicates("t", keep="first")
    t = df["t"].to_numpy(dtype=np.int64)
    o = df["o"].to_numpy(dtype=np.float64)
    h = df["h"].to_numpy(dtype=np.float64)
    lo = df["l"].to_numpy(dtype=np.float64)
    c = df["c"].to_numpy(dtype=np.float64)
    v = df["v"].to_numpy(dtype=np.float64)
    zero_volume = ~(np.isfinite(v) & (v > 0.0))
    wid = t // window_ms
    first = (t % window_ms) == 0
    prev_c = np.concatenate(([np.nan], c[:-1]))
    with np.errstate(all="ignore"):
        r = np.where(first, np.log(c / o), np.log(c / prev_c))
        a = np.where(first, 0.0, np.abs(r) * np.abs(np.concatenate(([0.0], r[:-1]))))
    bad = ~np.isfinite(r) | ((t % BAR_MS) != 0) | zero_volume
    frame = pd.DataFrame(
        {
            "wid": wid,
            "r2": np.where(np.isfinite(r), r * r, 0.0),
            "a": np.where(np.isfinite(a), a, 0.0),
            "bad": bad.astype(np.int64),
            "o": o,
            "c": c,
            "h": h,
            "l": lo,
        }
    )
    grp = frame.groupby("wid", sort=True)
    agg = pd.DataFrame(
        {
            "n": grp["r2"].size(),
            "bad": grp["bad"].sum(),
            "RV": grp["r2"].sum(),
            "BPV": grp["a"].sum() * (math.pi / 2.0),
            "o_first": grp["o"].first(),
            "c_last": grp["c"].last(),
            "hmax": grp["h"].max(),
            "lmin": grp["l"].min(),
        }
    )
    grid = np.arange(int(agg.index.min()), int(agg.index.max()) + 1, dtype=np.int64)
    agg = agg.reindex(grid)
    valid = ((agg["n"] == n_w) & (agg["bad"] == 0)).to_numpy()
    t_grid = grid * window_ms
    if end_ms is not None:
        past_end = (t_grid + window_ms) >= end_ms
    else:
        past_end = np.zeros(len(grid), dtype=bool)
    info["n_grid"] = int(len(grid))
    info["n_zero_volume_bars"] = int(zero_volume.sum())
    info["n_zero_volume_windows"] = int(np.unique(wid[zero_volume]).size)
    info["n_incomplete"] = int((~valid).sum())
    info["n_partition_end"] = int((valid & past_end).sum())
    keep = valid & ~past_end
    with np.errstate(all="ignore"):
        big_r = np.log(agg["c_last"].to_numpy() / agg["o_first"].to_numpy())
        big_g = np.log(agg["hmax"].to_numpy() / agg["lmin"].to_numpy())
    out = pd.DataFrame(
        {
            "RV": np.where(keep, agg["RV"].to_numpy(), np.nan),
            "BPV": np.where(keep, agg["BPV"].to_numpy(), np.nan),
            "R": np.where(keep, big_r, np.nan),
            "G": np.where(keep, big_g, np.nan),
        },
        index=pd.Index(t_grid, name="T"),
    )
    return out, info


def _extended(series: pd.Series, window_ms: int, T_values: np.ndarray) -> pd.Series:
    """The series on a grid that also covers every requested T (NaN where nothing is known)."""
    lo = int(series.index.min()) if len(series) else int(T_values.min())
    hi = int(series.index.max()) if len(series) else int(T_values.max())
    lo = min(lo, int(T_values.min()))
    hi = max(hi, int(T_values.max()))
    return series.reindex(np.arange(lo, hi + window_ms, window_ms, dtype=np.int64))


def _trailing_means(x: pd.Series, window_ms: int, prefix: str) -> pd.DataFrame:
    """prev, 1d, 7d and 30d means of complete earlier windows, indexed at T (the windows end at or before T)."""
    out: dict[str, pd.Series] = {f"{prefix}_prev": x.shift(1)}
    for name, days in (("1d", 1), ("7d", 7), ("30d", 30)):
        k = max(1, days * DAY_MS // window_ms)
        out[f"{prefix}_{name}"] = x.rolling(k, min_periods=k).mean().shift(1)
    return pd.DataFrame(out)


def component_frame(win: pd.DataFrame, window_ms: int, T_values: Any) -> pd.DataFrame:
    """The components at each T from complete windows that ended at or before T: rv_*, c_* (BPV) and j_* (jump)."""
    T_arr = np.asarray(list(T_values), dtype=np.int64)
    if len(T_arr) == 0:
        return pd.DataFrame(index=pd.Index([], dtype=np.int64, name="T"))
    rv = _extended(win["RV"], window_ms, T_arr)
    bpv = _extended(win["BPV"], window_ms, T_arr)
    jump = np.maximum(rv - bpv, 0.0)
    frame = pd.concat(
        [
            _trailing_means(rv, window_ms, "rv"),
            _trailing_means(bpv, window_ms, "c"),
            _trailing_means(jump, window_ms, "j"),
        ],
        axis=1,
    )
    out = frame.reindex(T_arr)
    out.index.name = "T"
    return out


def exog_frame(
    T_values: Any,
    window_ms: int,
    settlements: pd.DataFrame | None,
    premium_5m: pd.DataFrame | None,
    btc_win: pd.DataFrame | None,
) -> pd.DataFrame:
    """The X terms known at T: |last funding| (at most 8 h + 1 min old), |premium close at T - 5m|, BTC log RV_prev."""
    T_arr = np.asarray(list(T_values), dtype=np.int64)
    nan = np.full(len(T_arr), np.nan)
    fund = nan.copy()
    if settlements is not None and len(settlements) and len(T_arr):
        s = settlements.sort_values("t")
        st = s["t"].to_numpy(dtype=np.int64)
        sr = s["rate"].to_numpy(dtype=np.float64)
        idx = np.searchsorted(st, T_arr, side="right") - 1
        ok = idx >= 0
        age = np.where(ok, T_arr - st[np.maximum(idx, 0)], 0)
        ok &= age <= FUND_MAX_AGE_MS
        fund = np.where(ok, np.abs(sr[np.maximum(idx, 0)]), np.nan)
    prem = nan.copy()
    if premium_5m is not None and len(premium_5m) and len(T_arr):
        p = premium_5m.drop_duplicates("t", keep="last").set_index("t")["c"].astype(np.float64)
        prem = np.abs(p.reindex(T_arr - BAR_MS).to_numpy())
    btc = nan.copy()
    if btc_win is not None and len(btc_win) and len(T_arr):
        rv = _extended(btc_win["RV"], window_ms, T_arr).shift(1)
        btc = safe_log(rv.reindex(T_arr).to_numpy())
    return pd.DataFrame({"abs_fund": fund, "abs_prem": prem, "btc_lrv_prev": btc}, index=pd.Index(T_arr, name="T"))


def design(comp: pd.DataFrame, exog: pd.DataFrame, model: str, window: str, is_btc: bool) -> pd.DataFrame:
    """The regressors of a model at each T. Windows 1d leave X_1d out. Rows with any missing input are NaN."""
    if model not in MODELS:
        raise ValueError(f"unknown model {model!r}")
    spans = ["prev", "7d", "30d"] if window == "1d" else ["prev", "1d", "7d", "30d"]
    cols: dict[str, Any] = {"const": np.ones(len(comp))}
    if model == "LHAR-CJ":
        for sp in spans:
            cols[f"lc_{sp}"] = safe_log(comp[f"c_{sp}"].to_numpy())
        for sp in ("prev", "7d", "30d"):
            ratio = comp[f"j_{sp}"].to_numpy() / np.maximum(comp[f"c_{sp}"].to_numpy(), LOG_FLOOR)
            cols[f"lj_{sp}"] = np.log(1.0 + ratio)
    else:
        for sp in spans:
            cols[f"lrv_{sp}"] = safe_log(comp[f"rv_{sp}"].to_numpy())
        if model == "LHAR-X":
            cols["abs_fund"] = exog["abs_fund"].to_numpy()
            cols["abs_prem"] = exog["abs_prem"].to_numpy()
            if not is_btc:
                cols["btc_lrv_prev"] = exog["btc_lrv_prev"].to_numpy()
    return pd.DataFrame(cols, index=comp.index)


def persistence_forecast(comp: pd.DataFrame) -> pd.Series:
    """RV_prev floored at 1e-12, NaN when the previous window is missing."""
    return np.maximum(comp["rv_prev"], LOG_FLOOR)


def ewma_forecast(rv: pd.Series, halflife: float | None = None) -> pd.Series:
    """EWMA of RV, halflife 7 windows, at each T from complete windows before T.

    Initialised with the arithmetic mean of the first 7 complete RVs, updated only on complete windows, so a gap leaves
    the state unchanged. The forecast is NaN until the state exists.
    """
    hl = float(method.BAR_FORECAST["ewma_halflife_windows"] if halflife is None else halflife)
    n_init = 7
    alpha = 1.0 - 0.5 ** (1.0 / hl)
    vals = rv.to_numpy(dtype=np.float64)
    out = np.full(len(vals), np.nan)
    state = np.nan
    firsts: list[float] = []
    for i, v in enumerate(vals):
        out[i] = state
        if np.isfinite(v):
            if len(firsts) < n_init:
                firsts.append(float(v))
                if len(firsts) == n_init:
                    state = float(np.mean(firsts))
            else:
                state = alpha * float(v) + (1.0 - alpha) * state
    return pd.Series(np.maximum(out, LOG_FLOOR), index=rv.index)


# ---------------------------------------------------------------------------------------------------------------------
# Walk-forward
# ---------------------------------------------------------------------------------------------------------------------


def refit_times(first_ms: int, end_ms: int) -> list[int]:
    """Refit instants: first_ms, then the first instant of each following UTC month, all before end_ms."""
    out: list[int] = []
    t = pd.Timestamp(first_ms, unit="ms", tz="UTC")
    while int(t.value // 1_000_000) < end_ms:
        out.append(int(t.value // 1_000_000))
        t = pd.Timestamp(year=t.year + (t.month // 12), month=t.month % 12 + 1, day=1, tz="UTC")
    return out


def lookback_start(refit_ms: int, months: int | None) -> int | None:
    """The earliest training T: the refit minus `months` calendar months, None for no limit."""
    if months is None:
        return None
    ts = pd.Timestamp(refit_ms, unit="ms", tz="UTC") - pd.DateOffset(months=int(months))
    return int(ts.value // 1_000_000)


def fit_fold(
    x: pd.DataFrame,
    rv: pd.Series,
    big_r: pd.Series,
    window_ms: int,
    refit_ms: int,
    lookback_months: int | None,
    min_train: int,
) -> dict[str, Any] | None:
    """Fit one coin-fold: OLS of log RV on x over the training windows, and the coverage quantiles of z.

    Training windows have t1 = T + W < refit and T at or after the lookback start, and every input present. None when
    fewer than `min_train` remain. z = R / sqrt(f_fit) with f_fit the in-sample forecast.
    """
    T = x.index.to_numpy(dtype=np.int64)
    xv = x.to_numpy(dtype=np.float64)
    y = rv.reindex(x.index).to_numpy(dtype=np.float64)
    mask = np.isfinite(xv).all(axis=1) & np.isfinite(y) & (T + window_ms < refit_ms)
    lb = lookback_start(refit_ms, lookback_months)
    if lb is not None:
        mask &= T >= lb
    n = int(mask.sum())
    if n < min_train:
        return None
    xt = xv[mask]
    yl = safe_log(y[mask])
    beta, *_ = np.linalg.lstsq(xt, yl, rcond=None)
    fitted = xt @ beta
    resid = yl - fitted
    s2 = float(resid @ resid / (n - xt.shape[1]))
    with np.errstate(all="ignore"):
        f_fit = np.exp(fitted + s2 / 2.0)
    r_tr = big_r.reindex(x.index).to_numpy(dtype=np.float64)[mask]
    with np.errstate(all="ignore"):
        z = r_tr / np.sqrt(np.maximum(f_fit, LOG_FLOOR))
    z = z[np.isfinite(z)]
    q = np.quantile(z, COVERAGE_QUANTILES) if len(z) else np.full(4, np.nan)
    return {"beta": beta, "s2": s2, "n_train": n, "q": [float(v) for v in q]}


def apply_fit(fit: dict[str, Any], x: pd.DataFrame) -> np.ndarray:
    """f = exp(fitted + s^2 / 2) on each row of x, NaN for a row with a missing input or a non-finite result."""
    xv = x.to_numpy(dtype=np.float64)
    ok = np.isfinite(xv).all(axis=1)
    with np.errstate(all="ignore"):
        f = np.exp(np.where(ok, np.nan_to_num(xv) @ fit["beta"], np.nan) + fit["s2"] / 2.0)
    return np.where(np.isfinite(f), f, np.nan)


def prepare_window(panel: dict[str, dict[str, pd.DataFrame]], window: str, end_ms: int) -> dict[str, dict[str, Any]]:
    """Per coin: window table, drop counts, components, X terms, persistence and EWMA for one window size."""
    wms = WINDOWS[window]
    wins = {sym: window_table(d["5m"], wms, end_ms) for sym, d in panel.items()}
    btc_win = wins[BTC][0] if BTC in wins else None
    out: dict[str, dict[str, Any]] = {}
    for sym, d in panel.items():
        win, info = wins[sym]
        T = win.index.to_numpy(dtype=np.int64)
        comp = component_frame(win, wms, T)
        out[sym] = {
            "win": win,
            "info": info,
            "comp": comp,
            "exog": exog_frame(T, wms, d.get("settlements"), d.get("premium_5m"), btc_win),
            "persistence": persistence_forecast(comp),
            "ewma": ewma_forecast(win["RV"]),
        }
    return out


FORECAST_COLUMNS = [
    "coin",
    "T",
    "y",
    "f",
    "persistence",
    "ewma",
    "R",
    "G",
    "fold",
    "lo80",
    "hi80",
    "lo95",
    "hi95",
]


def compute_forecasts(
    panel: dict[str, dict[str, pd.DataFrame]],
    config: dict[str, Any],
    prepared: dict[str, dict[str, Any]] | None = None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """The walk-forward forecasts of one configuration over every coin, and the drop and untrained counts."""
    window = str(config["window"])
    wms = WINDOWS[window]
    end_ms = int(config["partition_end_ms"])
    prep = prepared if prepared is not None else prepare_window(panel, window, end_ms)
    first = int(config["first_refit_ms"])
    if config.get("refit", "monthly") == "none":
        refits = [first]
    else:
        refits = refit_times(first, end_ms)
    bounds = list(zip(refits, [*refits[1:], end_ms], strict=True))
    frames: list[pd.DataFrame] = []
    counts: dict[str, Any] = {
        "windows_incomplete": 0,
        "windows_past_partition_end": 0,
        "zero_volume_bars": 0,
        "zero_volume_windows": 0,
        "zero_volume_by_coin": {},
        "untrained_coin_folds": 0,
        "untrained_by_coin": {},
        "n_folds": len(bounds),
    }
    for sym, p in prep.items():
        counts["windows_incomplete"] += int(p["info"]["n_incomplete"])
        counts["windows_past_partition_end"] += int(p["info"]["n_partition_end"])
        counts["zero_volume_bars"] += int(p["info"]["n_zero_volume_bars"])
        counts["zero_volume_windows"] += int(p["info"]["n_zero_volume_windows"])
        counts["zero_volume_by_coin"][sym] = {
            "bars": int(p["info"]["n_zero_volume_bars"]),
            "windows": int(p["info"]["n_zero_volume_windows"]),
        }
        win = p["win"]
        if win.empty:
            continue
        x = design(p["comp"], p["exog"], str(config["model"]), window, sym == BTC)
        untrained = 0
        for refit, nxt in bounds:
            T = win.index.to_numpy(dtype=np.int64)
            rows = np.isfinite(win["RV"].to_numpy()) & (T >= refit) & (T < nxt)
            if not rows.any():
                continue
            fit = fit_fold(
                x, win["RV"], win["R"], wms, refit, config.get("lookback_months"), int(config["min_train_windows"])
            )
            sub = win.loc[rows]
            n = len(sub)
            if fit is None:
                untrained += 1
                f = np.full(n, np.nan)
                q = np.full(4, np.nan)
            else:
                f = apply_fit(fit, x.loc[sub.index])
                q = np.asarray(fit["q"], dtype=np.float64)
            sd = np.sqrt(f)
            frames.append(
                pd.DataFrame(
                    {
                        "coin": sym,
                        "T": sub.index.to_numpy(dtype=np.int64),
                        "y": sub["RV"].to_numpy(),
                        "f": f,
                        "persistence": p["persistence"].reindex(sub.index).to_numpy(),
                        "ewma": p["ewma"].reindex(sub.index).to_numpy(),
                        "R": sub["R"].to_numpy(),
                        "G": sub["G"].to_numpy(),
                        "fold": np.int64(refit),
                        "lo80": q[0] * sd,
                        "hi80": q[1] * sd,
                        "lo95": q[2] * sd,
                        "hi95": q[3] * sd,
                    }
                )
            )
        counts["untrained_coin_folds"] += untrained
        counts["untrained_by_coin"][sym] = untrained
    if frames:
        out = pd.concat(frames, ignore_index=True)
    else:
        out = pd.DataFrame({c: pd.Series(dtype=np.float64) for c in FORECAST_COLUMNS})
        out["coin"] = out["coin"].astype(object)
    return out[FORECAST_COLUMNS], counts


# ---------------------------------------------------------------------------------------------------------------------
# Criteria
# ---------------------------------------------------------------------------------------------------------------------


def qlike(y: Any, f: Any) -> np.ndarray:
    """y' / f' - log(y' / f') - 1 with y' = max(y, 1e-12) and f' = max(f, 1e-12)."""
    yf = np.maximum(np.asarray(y, dtype=np.float64), LOG_FLOOR)
    ff = np.maximum(np.asarray(f, dtype=np.float64), LOG_FLOOR)
    ratio = yf / ff
    return np.asarray(ratio - np.log(ratio) - 1.0)


def log_mse(y: Any, f: Any) -> np.ndarray:
    """(log y' - log f')^2 with y' = max(y, 1e-12) and f' = max(f, 1e-12)."""
    yf = np.maximum(np.asarray(y, dtype=np.float64), LOG_FLOOR)
    ff = np.maximum(np.asarray(f, dtype=np.float64), LOG_FLOOR)
    return np.asarray((np.log(yf) - np.log(ff)) ** 2)


def dm_test(d: Any, lag: int = 1) -> dict[str, Any]:
    """One-sided Diebold-Mariano on d = loss(configuration) - loss(benchmark): Newey-West, Bartlett weights.

    Statistic mean(d) / se with se^2 = (gamma_0 + 2 sum_{j=1..lag} (1 - j / (lag + 1)) gamma_j) / n, the autocovariances
    about the mean divided by n. p = Phi(statistic). An undefined statistic (n < 2, non-positive variance) gives NaN.
    """
    arr = np.asarray(d, dtype=np.float64)
    n = int(len(arr))
    nan = {"stat": float("nan"), "p": float("nan"), "n": n}
    if n < 2 or not np.isfinite(arr).all():
        return nan
    m = float(arr.mean())
    c = arr - m
    lrv = float(c @ c) / n
    for j in range(1, lag + 1):
        if j >= n:
            break
        lrv += 2.0 * (1.0 - j / (lag + 1.0)) * float(c[j:] @ c[:-j]) / n
    if not np.isfinite(lrv) or lrv <= 0.0:
        return nan
    stat = m / math.sqrt(lrv / n)
    return {"stat": float(stat), "p": stats.normal_cdf(stat), "n": n}


def paired_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Rows where the target, the configuration, persistence and the EWMA all have a finite value."""
    ok = np.isfinite(df[["y", "f", "persistence", "ewma"]].to_numpy(dtype=np.float64)).all(axis=1)
    return df.loc[ok]


def coverage(df: pd.DataFrame, level: str) -> dict[str, Any]:
    """Share of rows with R inside [lo, hi] for level '80' or '95', over rows that have both bounds and R."""
    lo = df[f"lo{level}"].to_numpy(dtype=np.float64)
    hi = df[f"hi{level}"].to_numpy(dtype=np.float64)
    r = df["R"].to_numpy(dtype=np.float64)
    ok = np.isfinite(lo) & np.isfinite(hi) & np.isfinite(r)
    n = int(ok.sum())
    if n == 0:
        return {"n": 0, "coverage": float("nan")}
    return {"n": n, "coverage": float(np.mean((r[ok] >= lo[ok]) & (r[ok] <= hi[ok])))}


def coin_criteria(df: pd.DataFrame, window_ms: int) -> dict[str, Any]:
    """The six tests of one coin on its walk-forward rows (M, BAR_FORECAST).

    Beside each gated DM test the descriptive long-lag statistic, p and lag (Bartlett lags spanning LONG_LAG_DAYS
    calendar days) are recorded as stat_long, p_long and lag_long. They never enter `pass`.
    """
    long_lag = max(1, LONG_LAG_DAYS * DAY_MS // int(window_ms))
    bar = method.BAR_FORECAST
    p_max = float(bar["dm_p_max"])
    tol = float(bar["coverage_tolerance"])
    rows = paired_rows(df)
    tests: dict[str, Any] = {}
    losses = {"qlike": qlike, "logmse": log_mse}
    means: dict[str, float] = {}
    for lname, loss in losses.items():
        lc = loss(rows["y"], rows["f"]) if len(rows) else np.empty(0)
        means[lname] = float(lc.mean()) if len(lc) else float("nan")
        for bname, bcol in (("persistence", "persistence"), ("ewma", "ewma")):
            lb = loss(rows["y"], rows[bcol]) if len(rows) else np.empty(0)
            res = dm_test(lc - lb)
            res["pass"] = bool(np.isfinite(res["p"]) and res["p"] < p_max)
            long = dm_test(lc - lb, long_lag)
            res.update({"stat_long": long["stat"], "p_long": long["p"], "lag_long": long_lag})
            tests[f"{lname}_vs_{bname}"] = res
    cov_ok = True
    covs: dict[str, Any] = {}
    for level, nominal in zip(("80", "95"), bar["coverage_levels"], strict=True):
        c = coverage(df, level)
        c["nominal"] = float(nominal)
        c["pass"] = bool(c["n"] > 0 and abs(c["coverage"] - float(nominal)) <= tol + 1e-12)
        covs[level] = c
        cov_ok &= c["pass"]
    return {
        "n_rows": int(len(df)),
        "n_paired": int(len(rows)),
        "mean_qlike": means["qlike"],
        "mean_logmse": means["logmse"],
        "tests": tests,
        "coverage": covs,
        "pass": bool(all(t["pass"] for t in tests.values()) and cov_ok),
    }


def config_verdict(
    per_coin: dict[str, dict[str, Any]], universe: tuple[str, ...] | None = None, symbols_min: int | None = None
) -> dict[str, Any]:
    """A configuration passes when at least `symbols_min` (8) of the universe's coins pass. Missing coins fail."""
    uni = tuple(method.UNIVERSE if universe is None else universe)
    need = int(method.BAR_FORECAST["symbols_min"] if symbols_min is None else symbols_min)
    n_pass = sum(1 for s in uni if s in per_coin and per_coin[s]["pass"])
    q = [per_coin[s]["mean_qlike"] for s in uni if s in per_coin and np.isfinite(per_coin[s]["mean_qlike"])]
    return {
        "coin_qlike": {s: float(per_coin[s]["mean_qlike"]) for s in uni if s in per_coin},
        "n_coins_pass": n_pass,
        "n_coins": len(uni),
        "symbols_min": need,
        "pass": bool(n_pass >= need),
        "mean_qlike": float(np.mean(q)) if q else float("nan"),
    }


def finalist_ranking(
    verdicts: dict[str, dict[str, Any]], order: list[str], paired: dict[str, pd.DataFrame]
) -> dict[str, Any]:
    """Rank the passing configurations on their common (coin, UTC day) support (declared).

    The coins are those where every passing configuration has a finite mean QLIKE (verdict["coin_qlike"]). For each such
    coin the days are the UTC days (floor(T / 86,400,000)) on which every passing configuration has at least one paired
    row (`paired[id]`, the rows of paired_rows), and a coin without a shared day leaves the support. A configuration's
    score is the mean over the support coins of its mean QLIKE on its paired rows in those days. Lowest score wins, ties
    by registry order. A single passing configuration is the finalist, and an empty support among two or more gives no
    finalist. The output records the support coins and the number of support days per coin.
    """
    passing = [cid for cid in order if cid in verdicts and verdicts[cid]["pass"]]
    out: dict[str, Any] = {"finalist": None, "support": [], "support_days": {}, "scores": {}}
    if not passing:
        return out
    coins = sorted(set().union(*(verdicts[cid].get("coin_qlike", {}).keys() for cid in passing)))
    candidates = [
        c
        for c in coins
        if all(np.isfinite(verdicts[cid].get("coin_qlike", {}).get(c, float("nan"))) for cid in passing)
    ]
    per: dict[str, dict[str, tuple[np.ndarray, np.ndarray]]] = {}
    for cid in passing:
        df = paired.get(cid)
        per[cid] = {}
        if df is None or len(df) == 0:
            continue
        frame = pd.DataFrame(
            {
                "coin": df["coin"].to_numpy(),
                "day": df["T"].to_numpy(dtype=np.int64) // DAY_MS,
                "ql": qlike(df["y"], df["f"]),
            }
        )
        for coin, g in frame.groupby("coin", sort=True):
            per[cid][str(coin)] = (g["day"].to_numpy(dtype=np.int64), g["ql"].to_numpy(dtype=np.float64))
    support: list[str] = []
    days_by_coin: dict[str, np.ndarray] = {}
    for coin in candidates:
        if any(coin not in per[cid] for cid in passing):
            continue
        shared = reduce(np.intersect1d, (np.unique(per[cid][coin][0]) for cid in passing))
        if len(shared):
            support.append(coin)
            days_by_coin[coin] = shared
    if support:
        out["support"] = support
        out["support_days"] = {c: int(len(days_by_coin[c])) for c in support}
        out["scores"] = {
            cid: float(
                np.mean([float(per[cid][c][1][np.isin(per[cid][c][0], days_by_coin[c])].mean()) for c in support])
            )
            for cid in passing
        }
    if len(passing) == 1:
        out["finalist"] = passing[0]
        return out
    if not support:
        return out
    best: str | None = None
    for cid in passing:
        if best is None or out["scores"][cid] < out["scores"][best]:
            best = cid
    out["finalist"] = best
    return out


def pick_finalist(verdicts: dict[str, dict[str, Any]], order: list[str], paired: dict[str, pd.DataFrame]) -> str | None:
    """The passing configuration with the lowest score on the common (coin, day) support, ties by registry order."""
    return finalist_ranking(verdicts, order, paired)["finalist"]  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------------------------------------------------
# Stay-out flag
# ---------------------------------------------------------------------------------------------------------------------


def trailing_vol_flags(t: np.ndarray, f: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Flag 1 for one coin. Returns (eligible, flagged) per row, rows sorted by T.

    A row is eligible when at least 90 days have passed since the coin's first forecast and the coin has a forecast in
    [T - 90 days, T). Ineligible rows enter neither group. An eligible row is flagged when sqrt(f) exceeds the
    90th percentile (numpy linear interpolation) of sqrt(f) over the coin's forecasts in [T - 90 days, T).
    """
    look = int(method.STAY_OUT["vol_percentile_lookback_days"]) * DAY_MS
    pct = float(method.STAY_OUT["vol_percentile"])
    sd = np.sqrt(f)
    eligible = np.zeros(len(t), dtype=bool)
    flagged = np.zeros(len(t), dtype=bool)
    if len(t) == 0:
        return eligible, flagged
    lo = np.searchsorted(t, t - look, side="left")
    hi = np.arange(len(t))
    eligible = ((t - t[0]) >= look) & (hi > lo)
    for i in np.flatnonzero(eligible):
        seg = sd[lo[i] : hi[i]]
        flagged[i] = bool(sd[i] > np.quantile(seg, pct))
    return eligible, flagged


def round_trip(coin: str) -> float:
    """2 x (taker fee 0.0005 + the coin's A1.1 slippage), in log units."""
    return 2.0 * (FEE_PER_SIDE + costs.coin_slippage_bps(coin) / 1e4)


def stay_out_flag(rows: pd.DataFrame, window_ms: int, registry_index: int) -> dict[str, Any]:
    """The two stay-out conditions for the finalist's forecasts (columns coin, T, y, f, G). Both must pass."""
    df = rows[np.isfinite(rows[["y", "f", "G"]].to_numpy(dtype=np.float64)).all(axis=1)].sort_values(["coin", "T"])
    df = df.reset_index(drop=True)
    flag1 = _flag1(df, registry_index)
    flag2 = _flag2(df)
    return {"flag1": flag1, "flag2": flag2, "pass": bool(flag1["pass"] and flag2["pass"])}


def _flag1(df: pd.DataFrame, registry_index: int) -> dict[str, Any]:
    seed = STAY_OUT_SEED_BASE + int(registry_index)
    res: dict[str, Any] = {"seed": seed, "pass": False}
    parts = []
    for _coin, g in df.groupby("coin", sort=True):
        t = g["T"].to_numpy(dtype=np.int64)
        eligible, flagged = trailing_vol_flags(t, g["f"].to_numpy(dtype=np.float64))
        parts.append(
            pd.DataFrame(
                {
                    "day": t[eligible] // DAY_MS,
                    "flag": flagged[eligible],
                    "s": np.sqrt(g["y"].to_numpy(dtype=np.float64))[eligible],
                }
            )
        )
    pooled = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame({"day": [], "flag": [], "s": []})
    n_fl = int(pooled["flag"].sum()) if len(pooled) else 0
    n_un = int(len(pooled) - n_fl)
    res.update({"n_eligible": int(len(pooled)), "n_flagged": n_fl, "n_unflagged": n_un})
    if n_fl == 0 or n_un == 0:
        res["reason"] = "empty group"
        return res
    day_sum = pooled.assign(
        sf=np.where(pooled["flag"], pooled["s"], 0.0), su=np.where(pooled["flag"], 0.0, pooled["s"])
    )
    day_sum["nf"] = pooled["flag"].astype(np.int64)
    day_sum["nu"] = 1 - day_sum["nf"]
    by_day = day_sum.groupby("day", sort=True)[["sf", "su", "nf", "nu"]].sum()
    grid = np.arange(int(by_day.index.min()), int(by_day.index.max()) + 1, dtype=np.int64)
    per_day = by_day.reindex(grid, fill_value=0.0).to_numpy(dtype=np.float64)
    tot = per_day.sum(axis=0)
    if tot[1] == 0.0:
        res["reason"] = "zero denominator"
        return res
    res["ratio"] = float((tot[0] / tot[2]) / (tot[1] / tot[3]))
    rng = np.random.default_rng(seed)
    draws = np.empty(BOOTSTRAP_ITERATIONS)
    for i in range(BOOTSTRAP_ITERATIONS):
        idx = stats.stationary_bootstrap_indices(len(per_day), method.STAY_OUT_BLOCK_DAYS, rng)
        s = per_day[idx].sum(axis=0)
        if s[2] == 0.0 or s[3] == 0.0 or s[1] == 0.0:
            res["reason"] = "degenerate draw"
            return res
        draws[i] = (s[0] / s[2]) / (s[1] / s[3])
    draws.sort()
    low = stats._percentile(draws, STAY_OUT_ALPHA / 2.0)
    high = stats._percentile(draws, 1.0 - STAY_OUT_ALPHA / 2.0)
    res.update(
        {
            "low": float(low),
            "high": float(high),
            "pass": bool(low > 1.0),
            "n_days": int(len(per_day)),
            "n_days_with_windows": int(len(by_day)),
        }
    )
    return res


def _flag2(df: pd.DataFrame) -> dict[str, Any]:
    mult = float(method.STAY_OUT["range_cost_multiple"])
    share_min = float(method.STAY_OUT["range_share_min"])
    res: dict[str, Any] = {"pass": False}
    if len(df) == 0:
        res.update({"n_flagged": 0, "reason": "no forecasts"})
        return res
    bound = mult * np.array([round_trip(c) for c in df["coin"]])
    expected_range = math.sqrt(8.0 / math.pi) * np.sqrt(df["f"].to_numpy(dtype=np.float64))
    flagged = expected_range < bound
    n_fl = int(flagged.sum())
    res["n_flagged"] = n_fl
    if n_fl == 0:
        res["reason"] = "no flagged window"
        return res
    below = int((df["G"].to_numpy(dtype=np.float64)[flagged] < bound[flagged]).sum())
    res.update({"n_below": below, "share": below / n_fl, "pass": bool(below / n_fl >= share_min)})
    return res


# ---------------------------------------------------------------------------------------------------------------------
# The refit question and H
# ---------------------------------------------------------------------------------------------------------------------


def refit_comparison(config_rows: pd.DataFrame, twin_rows: pd.DataFrame, registry_index: int) -> dict[str, Any]:
    """Descriptive: calendar-day mean of (twin QLIKE - finalist QLIKE) on common rows, 90% block bootstrap interval.

    The bootstrap runs over the full calendar-day grid (a day without a paired window has no value and is skipped in the
    mean of a draw, and a draw with no valued day is left out of the interval and counted).

    Cannot authorize live refitting (M). An untrainable twin (no twin forecast) is inconclusive.
    """
    seed = REFIT_SEED_BASE + int(registry_index)
    base: dict[str, Any] = {"seed": seed, "descriptive": True, "authorizes_live_refit": False, "alpha": REFIT_ALPHA}
    a = config_rows[["coin", "T", "y", "f"]].rename(columns={"f": "f_cfg"})
    b = twin_rows[["coin", "T", "f"]].rename(columns={"f": "f_twin"})
    m = a.merge(b, on=["coin", "T"], how="inner")
    ok = np.isfinite(m[["y", "f_cfg", "f_twin"]].to_numpy(dtype=np.float64)).all(axis=1)
    m = m.loc[ok]
    if len(m) == 0:
        return base | {"status": "inconclusive", "reason": "the twin has no forecast (untrainable)"}
    diff = qlike(m["y"], m["f_twin"]) - qlike(m["y"], m["f_cfg"])
    by_day = pd.Series(diff).groupby(m["T"].to_numpy() // DAY_MS).mean().sort_index()
    grid = np.arange(int(by_day.index.min()), int(by_day.index.max()) + 1, dtype=np.int64)
    daily = by_day.reindex(grid).to_numpy(dtype=np.float64)
    have = np.isfinite(daily)
    point = float(daily[have].mean())
    rng = np.random.default_rng(seed)
    draws: list[float] = []
    for _ in range(BOOTSTRAP_ITERATIONS):
        idx = stats.stationary_bootstrap_indices(len(daily), REFIT_BLOCK_DAYS, rng)
        drawn = daily[idx]
        drawn = drawn[np.isfinite(drawn)]
        if len(drawn):
            draws.append(float(drawn.mean()))
    n_empty = BOOTSTRAP_ITERATIONS - len(draws)
    if not draws:
        return base | {
            "status": "inconclusive",
            "reason": "every bootstrap draw lacks a day with a value",
            "n_empty_draws": int(n_empty),
            "iterations": BOOTSTRAP_ITERATIONS,
        }
    sorted_draws = np.sort(np.asarray(draws, dtype=np.float64))
    low = stats._percentile(sorted_draws, REFIT_ALPHA / 2.0)
    high = stats._percentile(sorted_draws, 1.0 - REFIT_ALPHA / 2.0)
    return base | {
        "status": "descriptive",
        "point": point,
        "low": float(low),
        "high": float(high),
        "refit_better": bool(low > 0.0),
        "n_days": int(have.sum()),
        "n_grid_days": int(len(daily)),
        "n_empty_draws": int(n_empty),
        "n_rows": int(len(m)),
        "n_coins": int(m["coin"].nunique()),
        "iterations": BOOTSTRAP_ITERATIONS,
        "mean_block": REFIT_BLOCK_DAYS,
    }


def run_holdout(*args: Any, **kwargs: Any) -> None:
    """The H procedure (registered in the draft, not implemented).

    H is read only after the owner signs a finalist lock (M, HOLDOUT H). The procedure: the final model fit on each
    coin's windows with t1 at or before DEV_END minus 30 days with the same lookback, the coverage quantiles from the
    same windows, no refit inside H, windows after each coin's 30-day component warm-up (90 days of forecasts for the
    stay-out flag), the family C criteria on at least 8 of the fixed 10 coins and both stay-out conditions at p below
    0.05 under its own read id.
    """
    raise NotImplementedError("family C's H read needs the owner-signed finalist lock; it is not implemented")
