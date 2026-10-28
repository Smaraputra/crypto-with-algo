"""Round 4 exploration bar: items 1 to 6 and family report."""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4.book import (
    DAY_MS,
    Tranche,
    _coerce_tranches,
    _extract_settlements_for_symbol,
    netted_costs,
)
from r4.costs import DEFAULT_FEE_PROFILE
from r4.method import (
    BAR,
    DEV_END,
    DSR_TRIALS_MIN,
    JOINT_SHIFT_GRID_MS,
    MAX_FINALISTS,
    PROGRAM_TRIALS_BEFORE,
    UNIVERSE,
)
from r4.stats import (
    cscv_pbo,
    deflated_sharpe,
    hansen_spa,
    per_period_sharpe,
    sample_kurtosis,
    sample_skewness,
)

logger = logging.getLogger(__name__)

# Lock, exploration bar item 4, label-shift tripwire: "If more than 60 of 100 give a positive drift-free mean,
# the family halts for a leakage review." Kept as an exact fraction so 60 of 100 never halts.
_TRIPWIRE_HALT_SHARE = Fraction(3, 5)

# family_report gives configuration i the joint-shift seed DEFAULT_JOINT_SHIFT_SEED_BASE + i (sorted run ids).
DEFAULT_JOINT_SHIFT_SEED_BASE = 5_000_000


def read_manifest(ds_dir: Path | str) -> dict[str, Any]:
    """Read the dataset manifest. It is required and must carry a datasetHash."""
    manifest_file = Path(ds_dir) / "manifest.json"
    if not manifest_file.is_file():
        raise ValueError(f"Dataset manifest is missing: {manifest_file}")
    try:
        data = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Dataset manifest is unreadable: {manifest_file}: {exc}") from exc
    if not isinstance(data, dict) or not data.get("datasetHash"):
        raise ValueError(f"Dataset manifest has no datasetHash: {manifest_file}")
    return data


def item1(receipt: dict[str, Any]) -> dict[str, Any]:
    """Lock exploration bar item 1:

    Walk-forward drift-free daily mean above zero, and at least 4 of the 5 CPCV
    paths with a positive drift-free mean.
    """
    metrics = receipt["metrics"]
    wf_mean = float(metrics["wf_mean"])
    cpcv_path_means = [float(m) for m in metrics["cpcv_path_means"]]
    cpcv_pos = sum(1 for m in cpcv_path_means if m > 0.0)
    req_pos = int(BAR["cpcv_paths_positive_min"])

    passed = bool(wf_mean > 0.0 and cpcv_pos >= req_pos)
    return {
        "pass": passed,
        "wf_mean": wf_mean,
        "cpcv_positive_paths": cpcv_pos,
        "cpcv_path_means": cpcv_path_means,
        "min_positive_required": req_pos,
    }


def _build_family_matrix(
    family_daily: dict[str, pd.DataFrame] | pd.DataFrame | np.ndarray,
) -> tuple[np.ndarray, list[str]]:
    """Build the family daily return matrix on the intersection of spans."""
    if isinstance(family_daily, np.ndarray):
        return family_daily, [f"config_{i}" for i in range(family_daily.shape[1])]

    if isinstance(family_daily, pd.DataFrame):
        return family_daily.to_numpy(dtype=np.float64), list(family_daily.columns)

    if not isinstance(family_daily, dict) or not family_daily:
        raise ValueError("family_daily must be a non-empty dict of DataFrames")

    config_ids = sorted(family_daily.keys())
    first_refits: list[int] = []
    ends: list[int] = []

    for cid in config_ids:
        df = family_daily[cid]
        if df.empty:
            raise ValueError(f"Configuration {cid} has empty daily series")
        idx_vals = df.index.to_numpy(dtype=np.int64)
        first_refits.append(int(idx_vals.min()))
        ends.append(int(idx_vals.max()) + DAY_MS)

    common_start = max(first_refits)
    common_end = min(ends)
    if common_start >= common_end:
        raise ValueError(f"No common span for family: common_start {common_start} >= common_end {common_end}")

    common_days = list(range(common_start, common_end, DAY_MS))
    cols = []
    for cid in config_ids:
        df = family_daily[cid]
        col_name = "drift_free" if "drift_free" in df.columns else df.columns[0]
        s = df[col_name].reindex(common_days).fillna(0.0).to_numpy(dtype=np.float64)
        cols.append(s)

    matrix = np.column_stack(cols)
    return matrix, config_ids


def item2(
    family_daily: dict[str, pd.DataFrame] | pd.DataFrame | np.ndarray,
) -> dict[str, Any]:
    """Lock exploration bar item 2:

    PBO at most 0.25 (CSCV, 16 groups, on the family's drift-free daily matrix over its common span).
    """
    matrix, config_ids = _build_family_matrix(family_daily)
    pbo_max = float(BAR["pbo_max"])
    cscv_groups = int(BAR["cscv_groups"])

    pbo, logits = cscv_pbo(matrix, n_groups=cscv_groups)
    passed = bool(pbo <= pbo_max)
    return {
        "pass": passed,
        "pbo": float(pbo),
        "pbo_max": pbo_max,
        "logits_count": len(logits),
        "configs": config_ids,
    }


def item3(
    receipt: dict[str, Any],
    round_daily: dict[str, pd.DataFrame] | Sequence[float] | float,
    ledger_count: int,
    candidate_daily: pd.DataFrame | None = None,
) -> dict[str, Any]:
    """Lock exploration bar item 3:

    Deflated Sharpe probability at least 0.95 on the drift-free daily series,
    with N = max(120, round alpha-bearing ledger count). The variance of trial
    Sharpes counts identical configurations once, keyed by the receipt config_hash
    that the caller stores in each frame's attrs.
    """
    n_trials = max(int(DSR_TRIALS_MIN), int(ledger_count))

    n_unique_configs: int | None = None
    if isinstance(round_daily, (int, float)):
        var_trial_sharpes = float(round_daily)
    elif isinstance(round_daily, dict):
        unique_sharpes: list[float] = []
        seen_hashes: set[str] = set()
        for key, df in round_daily.items():
            cfg_hash = getattr(df, "attrs", {}).get("config_hash")
            if not cfg_hash:
                raise ValueError(f"Round run {key} has no config_hash, so identical configs cannot be counted once")
            if cfg_hash in seen_hashes:
                continue
            seen_hashes.add(cfg_hash)
            col = "drift_free" if "drift_free" in df.columns else df.columns[0]
            arr = df[col].to_numpy(dtype=np.float64)
            unique_sharpes.append(per_period_sharpe(arr))
        n_unique_configs = len(unique_sharpes)
        if n_unique_configs < 2:
            raise ValueError(
                f"Item 3 needs at least 2 unique configurations for the trial-Sharpe variance, got {n_unique_configs}"
            )
        var_trial_sharpes = float(np.var(unique_sharpes, ddof=1))
    else:
        arr_srs = np.asarray(round_daily, dtype=np.float64)
        arr_finite = arr_srs[np.isfinite(arr_srs)]
        if len(arr_finite) < 2:
            raise ValueError(f"Item 3 needs at least 2 finite trial Sharpes for their variance, got {len(arr_finite)}")
        var_trial_sharpes = float(np.var(arr_finite, ddof=1))

    if candidate_daily is not None and not candidate_daily.empty:
        col = "drift_free" if "drift_free" in candidate_daily.columns else candidate_daily.columns[0]
        series_vals = candidate_daily[col].to_numpy(dtype=np.float64)
        obs_sharpe = per_period_sharpe(series_vals)
        n_obs = len(series_vals)
        skew = sample_skewness(series_vals)
        kurt = sample_kurtosis(series_vals)
    else:
        obs_sharpe = float(receipt["metrics"]["wf_sharpe"])
        n_obs = int(receipt["metrics"]["n_days"])
        skew = float(receipt.get("metrics", {}).get("skew", 0.0))
        kurt = float(receipt.get("metrics", {}).get("kurt", 3.0))

    bench_round, prob_round = deflated_sharpe(
        obs_sharpe,
        n_trials,
        var_trial_sharpes,
        n_obs,
        skew,
        kurt,
    )

    n_prog = int(PROGRAM_TRIALS_BEFORE + n_trials)
    bench_prog, prob_prog = deflated_sharpe(
        obs_sharpe,
        n_prog,
        var_trial_sharpes,
        n_obs,
        skew,
        kurt,
    )

    dsr_min = float(BAR["dsr_min"])
    passed = bool(prob_round >= dsr_min)

    return {
        "pass": passed,
        "dsr_prob": float(prob_round),
        "dsr_prob_program": float(prob_prog),
        "dsr_min": dsr_min,
        "benchmark": float(bench_round),
        "benchmark_program": float(bench_prog),
        "num_trials": n_trials,
        "program_trials": n_prog,
        "var_trial_sharpes": float(var_trial_sharpes),
        "n_unique_configs": n_unique_configs,
    }


def shift_tranche_times(
    entry_ms: Any,
    exit_ms: Any,
    s_days: int,
    span_start_ms: int,
    n_days: int,
) -> tuple[Any, Any]:
    """Circularly shift a tranche by s_days whole days inside the span.

    The entry moves by whole days (wrapping inside n_days), keeps its time of day, and the hold is kept.
    Works on Python ints and on integer numpy arrays alike.
    """
    rel = entry_ms - span_start_ms
    day_offset = (rel // DAY_MS + s_days) % n_days
    intra_day_ms = rel % DAY_MS
    shifted_entry = span_start_ms + day_offset * DAY_MS + intra_day_ms
    return shifted_entry, shifted_entry + (exit_ms - entry_ms)


def _fold_table(folds: Sequence[dict[str, Any]], basket: Sequence[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return fold starts, ends and a (n_folds, n_coins) beta matrix, NaN where a beta is null or absent."""
    if not folds:
        raise ValueError("joint_shift_null needs the run's folds (folds.json) to read the betas")
    rows = sorted(folds, key=lambda f: int(f["start_ms"]))
    starts = np.array([int(f["start_ms"]) for f in rows], dtype=np.int64)
    ends = np.array([int(f["end_ms"]) for f in rows], dtype=np.int64)
    betas = np.full((len(rows), len(basket)), np.nan, dtype=np.float64)
    for i, f in enumerate(rows):
        fb = f["betas"]
        for j, sym in enumerate(basket):
            v = fb.get(sym)
            if v is not None:
                betas[i, j] = float(v)
    return starts, ends, betas


def joint_shift_null(
    tranches: list[Tranche] | pd.DataFrame,
    panel: dict[str, dict[str, pd.DataFrame]],
    folds: Sequence[dict[str, Any]],
    span_start_ms: int,
    span_end_ms: int,
    n_draws: int = 1000,
    min_shift_days: int = 7,
    seed: int = 7,
    profile: str = DEFAULT_FEE_PROFILE,
) -> tuple[float, float, float, list[int]]:
    """Joint-shift random-entry null with the lock's beta-hedged drift-free statistic.

    Circular shifts of the whole tranche set by whole days (at least min_shift_days). Per tranche, observed
    and shifted alike: side x (r_coin - beta x r_EW) - costs - side x funding. The costs are the observed
    tranche's allocated netted cost per unit of absolute weight (see netted_costs), kept for the shifted copy
    because a whole-day shift moves all legs of a fill group together. A tranche dropped from a shifted draw keeps
    its allocation in the others. r_coin is the log of the 5m
    opens at exit over entry, r_EW is the mean of that log ratio over the panel coins with an exact 5m open at
    both times, beta is the coin's beta in the fold whose [start_ms, end_ms) holds the (shifted) entry time, and
    funding sums the settlements in (entry, exit]. A shifted tranche is dropped when its exit passes the span
    end, a price is missing, or its beta is NaN or has no fold. The statistic is the weighted mean of that
    return per unit of absolute weight over the kept tranches.

    Returns (p_value, drop_share, observed_statistic, shifts_in_days).
    """
    n_days = int((span_end_ms - span_start_ms) // DAY_MS)
    if n_days < 2 * min_shift_days:
        raise ValueError(
            f"Span of {n_days} days is shorter than 2 x min_shift_days ({2 * min_shift_days}), no valid shift exists"
        )

    tranche_list = _coerce_tranches(tranches)
    if not tranche_list:
        return 1.0, 0.0, float("nan"), []

    basket = [s for s in panel if "5m" in panel[s]]
    sym_pos = {s: i for i, s in enumerate(basket)}
    for t in tranche_list:
        if t.symbol not in sym_pos:
            raise ValueError(f"Tranche symbol {t.symbol} has no 5m series in the panel")

    times_by_coin: list[np.ndarray] = []
    opens_by_coin: list[np.ndarray] = []
    for s in basket:
        df = panel[s]["5m"]
        t_arr = df["t"].to_numpy(dtype=np.int64)
        o_arr = df["o"].to_numpy(dtype=np.float64)
        order = np.argsort(t_arr, kind="stable")
        times_by_coin.append(t_arr[order])
        opens_by_coin.append(o_arr[order])

    def prices_at(q: np.ndarray) -> np.ndarray:
        """Exact 5m opens of every basket coin at the query times, NaN where the bar is missing."""
        out = np.full((len(basket), len(q)), np.nan, dtype=np.float64)
        for i in range(len(basket)):
            tt = times_by_coin[i]
            if len(tt) == 0:
                continue
            idx = np.searchsorted(tt, q)
            idx_c = np.minimum(idx, len(tt) - 1)
            exact = (idx < len(tt)) & (tt[idx_c] == q)
            out[i, exact] = opens_by_coin[i][idx_c[exact]]
        return out

    # Funding as cumulative sums so the sum over (entry, exit] is a difference of two lookups.
    fund_times: dict[int, np.ndarray] = {}
    fund_cum: dict[int, np.ndarray] = {}
    for s in {t.symbol for t in tranche_list}:
        raw = panel[s].get("settlements", panel[s].get("funding"))
        f_t, f_r = _extract_settlements_for_symbol(raw, s)
        fund_times[sym_pos[s]] = f_t
        fund_cum[sym_pos[s]] = np.concatenate(([0.0], np.cumsum(f_r)))

    n_tr = len(tranche_list)
    sym_idx = np.array([sym_pos[t.symbol] for t in tranche_list], dtype=np.int64)
    side = np.array([t.side_val for t in tranche_list], dtype=np.float64)
    w_abs = np.array([abs(t.weight) for t in tranche_list], dtype=np.float64)
    entry0 = np.array([t.entry_ms for t in tranche_list], dtype=np.int64)
    exit0 = np.array([t.exit_ms for t in tranche_list], dtype=np.int64)
    # The observed tranche set uses the book's fill-price rule: a priced entry or exit takes the tranche's own
    # price, and the basket hedge of a priced exit ends at the next 5m boundary. Shifted tranches keep horizon
    # pricing (path-dependent exits get their own null later).
    entry_priced = np.array([t.entry_priced for t in tranche_list], dtype=bool)
    exit_priced = np.array([t.exit_priced for t in tranche_list], dtype=bool)
    entry_px0 = np.array([t.entry_price for t in tranche_list], dtype=np.float64)
    exit_px0 = np.array([t.exit_price for t in tranche_list], dtype=np.float64)
    any_priced = bool(entry_priced.any() or exit_priced.any())

    # Netted costs of the OBSERVED tranche set, per unit of absolute weight. A whole-day shift moves every leg of a
    # fill group together, so the grouping survives and shifted tranches reuse their observed allocation. A
    # tranche dropped from a shifted draw keeps its allocation in the others (the netting is not redone).
    fold_starts, fold_ends, fold_betas = _fold_table(folds, basket)

    # Net over the same set the book charges: observed tranches with a finite beta in the fold of their entry
    # (beta_hedged_daily excludes the rest, so they carry no fill). The excluded ones get no cost; their return is
    # NaN through beta anyway.
    f_obs = np.searchsorted(fold_starts, entry0, side="right") - 1
    f_obs_c = np.maximum(f_obs, 0)
    in_fold_obs = (f_obs >= 0) & (entry0 < fold_ends[f_obs_c])
    beta_obs = np.where(in_fold_obs, fold_betas[f_obs_c, sym_idx], np.nan)
    included = np.isfinite(beta_obs)
    costs = np.zeros(n_tr, dtype=np.float64)
    if np.any(included):
        inc_idx = np.flatnonzero(included)
        netted = netted_costs([tranche_list[i] for i in inc_idx], profile)
        with np.errstate(divide="ignore", invalid="ignore"):
            costs[inc_idx] = np.where(w_abs[inc_idx] > 0.0, netted.tranche_cost / w_abs[inc_idx], 0.0)
    arange_tr = np.arange(n_tr)

    def tranche_returns(entry: np.ndarray, exit_: np.ndarray, observed: bool = False) -> np.ndarray:
        """Per tranche statistic, NaN where a price, the basket, a fold or a beta is missing."""
        priced_out = observed and bool(exit_priced.any())
        hedge_exit = np.where(exit_priced, -(-exit_ // 300_000) * 300_000, exit_) if priced_out else exit_
        pe = prices_at(entry)
        px = prices_at(hedge_exit)
        ok = (pe > 0.0) & (px > 0.0)
        with np.errstate(all="ignore"):
            lr = np.where(ok, np.log(px / pe), np.nan)
        cnt = ok.sum(axis=0)
        total = np.where(ok, lr, 0.0).sum(axis=0)
        with np.errstate(all="ignore"):
            r_ew = np.where(cnt > 0, total / cnt, np.nan)
        r_coin = lr[sym_idx, arange_tr]
        if observed and any_priced:
            # Coin leg from the fill prices where priced, else from the exact 5m opens as before.
            own_entry = np.where(entry_priced, entry_px0, pe[sym_idx, arange_tr])
            own_exit = np.where(exit_priced, exit_px0, px[sym_idx, arange_tr])
            with np.errstate(all="ignore"):
                r_coin = np.where((own_entry > 0.0) & (own_exit > 0.0), np.log(own_exit / own_entry), np.nan)

        f_idx = np.searchsorted(fold_starts, entry, side="right") - 1
        f_idx_c = np.maximum(f_idx, 0)
        in_fold = (f_idx >= 0) & (entry < fold_ends[f_idx_c])
        beta = np.where(in_fold, fold_betas[f_idx_c, sym_idx], np.nan)

        funding = np.zeros(n_tr, dtype=np.float64)
        for pos, f_t in fund_times.items():
            sel = sym_idx == pos
            if not np.any(sel) or len(f_t) == 0:
                continue
            cum = fund_cum[pos]
            idx_exit = np.searchsorted(f_t, exit_[sel], side="right")
            idx_entry = np.searchsorted(f_t, entry[sel], side="right")
            funding[sel] = cum[idx_exit] - cum[idx_entry]

        return side * (r_coin - beta * r_ew) - costs - side * funding

    def weighted(ret: np.ndarray, keep: np.ndarray) -> float:
        """Weighted mean return per unit of absolute weight over kept tranches. Inf when none are kept."""
        if not np.any(keep):
            # A draw with no kept tranche cannot beat the observed value, so it counts against the tranche set.
            return float("inf")
        return float(np.sum(w_abs[keep] * ret[keep]) / np.sum(w_abs[keep]))

    obs_ret = tranche_returns(entry0, exit0, observed=True)
    obs_keep = np.isfinite(obs_ret)
    if not np.any(obs_keep):
        return 1.0, 1.0, float("nan"), []
    obs_stat = weighted(obs_ret, obs_keep)

    max_shift_days = n_days - min_shift_days
    rng = np.random.default_rng(seed)
    shifts = rng.integers(min_shift_days, max_shift_days, endpoint=True, size=n_draws)

    null_stats = np.empty(n_draws, dtype=np.float64)
    total_dropped = 0
    for draw_idx in range(n_draws):
        s_days = int(shifts[draw_idx])
        sh_entry, sh_exit = shift_tranche_times(entry0, exit0, s_days, span_start_ms, n_days)
        late = sh_exit > span_end_ms
        ret = tranche_returns(sh_entry, sh_exit)
        keep = np.isfinite(ret) & ~late
        total_dropped += int(n_tr - np.sum(keep))
        null_stats[draw_idx] = weighted(ret, keep)

    k = int(np.sum(null_stats >= obs_stat))
    p_val = float((1 + k) / (1 + n_draws))
    drop_share = float(total_dropped / (n_draws * n_tr))

    return p_val, drop_share, obs_stat, [int(s) for s in shifts]


def item4(
    receipt: dict[str, Any],
    tranches: list[Tranche] | pd.DataFrame,
    panel: dict[str, dict[str, pd.DataFrame]],
    family_matrix: np.ndarray | pd.DataFrame,
    folds: Sequence[dict[str, Any]],
    end_ms: int = DEV_END,
    seed: int = 7,
    joint_seed: int | None = None,
) -> dict[str, Any]:
    """Lock exploration bar item 4 (only for configurations passing items 1 to 3):

    - Joint-shift random-entry null: circular shifts of tranche set by whole days
    - Hansen SPA on the family's intersection matrix
    - Label-shift tripwire: run by Claude outside this function, reported here as 'pending'

    seed drives the SPA bootstrap. joint_seed drives the joint-shift draws and defaults to seed.
    """
    config = receipt.get("config", {})
    if "first_refit_ms" not in config:
        raise ValueError("Receipt config has no first_refit_ms, so the walk-forward span is unknown")
    first_refit_ms = int(config["first_refit_ms"])

    p_joint, drop_share, obs_stat, _shifts = joint_shift_null(
        tranches=tranches,
        panel=panel,
        folds=folds,
        span_start_ms=first_refit_ms,
        span_end_ms=end_ms,
        n_draws=int(BAR["random_entry_draws"]),
        min_shift_days=int(BAR["random_entry_shift_min_days"]),
        seed=seed if joint_seed is None else joint_seed,
    )

    mat_arr = (
        family_matrix.to_numpy(dtype=np.float64)
        if isinstance(family_matrix, pd.DataFrame)
        else np.asarray(family_matrix, dtype=np.float64)
    )

    spa_t, spa_p = hansen_spa(
        mat_arr,
        n_reps=int(BAR["spa_reps"]),
        mean_block_len=float(BAR["spa_mean_block_days"]),
        seed=seed,
    )

    pass_joint = bool(p_joint < float(BAR["random_entry_p_max"]))
    pass_spa = bool(spa_p < float(BAR["spa_p_max"]))
    passed = bool(pass_joint and pass_spa)

    return {
        "pass": passed,
        "joint_shift_seed": int(seed if joint_seed is None else joint_seed),
        "joint_shift_p": float(p_joint),
        "joint_shift_drop_share": float(drop_share),
        "joint_shift_observed": float(obs_stat) if np.isfinite(obs_stat) else None,
        "pass_joint_shift": pass_joint,
        "spa_t": float(spa_t),
        "spa_p": float(spa_p),
        "pass_spa": pass_spa,
        "label_shift_tripwire": "pending",
    }


def item5(receipt: dict[str, Any]) -> dict[str, Any]:
    """Lock exploration bar item 5:

    At least 7 of 10 coins with a positive drift-free daily mean (each coin's tranches alone),
    or for family D a drop-one-coin jackknife that stays positive. A null mean is not positive.
    """
    metrics = receipt["metrics"]
    family = receipt.get("config", {}).get("family")

    if family == "D":
        if "jackknife_means" not in metrics:
            raise ValueError("Family D item 5 needs metrics.jackknife_means in the receipt")
        jk = metrics["jackknife_means"]
        values = list(jk.values()) if isinstance(jk, dict) else list(jk)
        if not values:
            raise ValueError("jackknife_means is empty")
        n_positive = sum(1 for v in values if v is not None and float(v) > 0.0)
        passed = bool(n_positive == len(values))
        return {
            "pass": passed,
            "rule": "jackknife",
            "jackknife_positive": n_positive,
            "jackknife_total": len(values),
        }

    coin_means = metrics["coin_means"]
    values = list(coin_means.values()) if isinstance(coin_means, dict) else list(coin_means)
    pos_coins = sum(1 for v in values if v is not None and float(v) > 0.0)

    req_symbols = int(BAR["symbols_positive_min"])
    passed = bool(pos_coins >= req_symbols)

    return {
        "pass": passed,
        "rule": "coin_count",
        "positive_coins": pos_coins,
        "min_required": req_symbols,
    }


def item6(receipt: dict[str, Any]) -> dict[str, Any]:
    """Lock exploration bar item 6:

    Fees x1.5 and slippage x2 (one joint stress), and separately every maker fill repriced as taker,
    each keep the drift-free daily mean at or above zero. The one-at-a-time values are descriptive.
    """
    m = receipt["metrics"]
    s_cost = float(m["stress_cost"])
    s_maker = float(m["stress_maker_as_taker"])

    pass_cost = s_cost >= 0.0
    pass_maker = s_maker >= 0.0
    passed = bool(pass_cost and pass_maker)

    return {
        "pass": passed,
        "stress_cost": s_cost,
        "stress_maker_as_taker": s_maker,
        "n_maker_fills": m.get("n_maker_fills"),
        "stress_fee": m.get("stress_fee"),
        "stress_slippage": m.get("stress_slippage"),
    }


def _evaluate_tripwire(tripwire: dict[str, Any] | None) -> tuple[str, dict[str, Any] | None]:
    """Return ("pending" | "halted" | "passed", the validated input)."""
    if tripwire is None:
        return "pending", None
    if not isinstance(tripwire, dict) or "positive" not in tripwire or "n" not in tripwire:
        raise ValueError('tripwire must be a JSON object {"positive": int, "n": int}')
    positive = int(tripwire["positive"])
    n = int(tripwire["n"])
    if n <= 0 or positive < 0 or positive > n:
        raise ValueError(f"tripwire counts are invalid: positive={positive}, n={n}")
    halted = Fraction(positive) > _TRIPWIRE_HALT_SHARE * n
    return ("halted" if halted else "passed"), {"positive": positive, "n": n}


def _rank_candidates(passing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rank all-pass configs by drift-free daily Sharpe, one per (family, model), at most MAX_FINALISTS."""
    ranked = sorted(passing, key=lambda x: float(x["receipt"]["metrics"]["wf_sharpe"]), reverse=True)
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in ranked:
        cfg = item["receipt"]["config"]
        key = (cfg["family"], cfg["model"])
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "id": item["id"],
                "family": cfg["family"],
                "model": cfg["model"],
                "wf_sharpe": item["receipt"]["metrics"]["wf_sharpe"],
                "wf_mean": item["receipt"]["metrics"]["wf_mean"],
            }
        )
        if len(out) >= MAX_FINALISTS:
            break
    return out


def family_report(
    family: str,
    runs_dir: Path | str,
    round_runs_dir: Path | str,
    ledger_count: int,
    ds_dir: Path | str,
    out_file: Path | str | None = None,
    seed: int = 7,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
    tripwire: dict[str, Any] | None = None,
    calibration: bool = False,
    seed_base: int = DEFAULT_JOINT_SHIFT_SEED_BASE,
) -> dict[str, Any]:
    """Evaluate exploration bar across all configurations in a family and write report.

    calibration=False (default) is the trial path: a round receipt with kind "control" raises, because controls
    are excluded from the round-close variance (M lines 116-117). calibration=True is the control path: only
    receipts with kind "control" are accepted, in the family and in the round directory.
    The joint-shift seed of each configuration is seed_base + its index in the sorted run ids (seed drives the
    SPA bootstrap), and the seed used is recorded per configuration.

    Finalists are chosen only once the label-shift tripwire is known and does not halt the family.
    Without a tripwire input the all-pass configurations are listed as candidates and finalists stay empty.
    """
    from r4.data import sha256_file
    from r4.pipeline import load_panel

    runs_path = Path(runs_dir)
    round_path = Path(round_runs_dir)
    ds_path = Path(ds_dir)

    manifest = read_manifest(ds_path)
    dataset_hash = str(manifest["datasetHash"])
    tripwire_status, tripwire_input = _evaluate_tripwire(tripwire)

    # 1. Discover family runs
    family_runs: dict[str, dict[str, Any]] = {}
    family_daily: dict[str, pd.DataFrame] = {}
    family_tranches: dict[str, pd.DataFrame] = {}
    family_folds: dict[str, list[dict[str, Any]]] = {}
    input_receipt_shas: dict[str, str] = {}

    for p in sorted(runs_path.iterdir()):
        if not p.is_dir():
            continue
        receipt_file = p / "receipt.json"
        daily_file = p / "daily.parquet"
        tranches_file = p / "tranches.parquet"
        folds_file = p / "folds.json"
        if receipt_file.exists() and daily_file.exists():
            receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
            if receipt.get("config", {}).get("family") == family or family == "*":
                run_id = p.name
                if calibration and receipt.get("kind") != "control":
                    raise ValueError(f"Calibration mode accepts only control receipts, but {receipt_file} is not one")
                family_runs[run_id] = receipt
                family_daily[run_id] = pd.read_parquet(daily_file)
                if tranches_file.exists():
                    family_tranches[run_id] = pd.read_parquet(tranches_file)
                if folds_file.exists():
                    family_folds[run_id] = json.loads(folds_file.read_text(encoding="utf-8"))
                input_receipt_shas[run_id] = sha256_file(receipt_file)

    if not family_runs:
        raise ValueError(f"No runs found for family {family} in {runs_dir}")

    # 2. Discover round runs for trial Sharpe variance (item 3), keyed by the receipts' config_hash
    round_daily: dict[str, pd.DataFrame] = {}
    for p in sorted(round_path.iterdir()):
        if not p.is_dir():
            continue
        rcpt = p / "receipt.json"
        dly = p / "daily.parquet"
        if rcpt.exists() and dly.exists():
            round_receipt = json.loads(rcpt.read_text(encoding="utf-8"))
            if calibration:
                if round_receipt.get("kind") != "control":
                    raise ValueError(f"Calibration mode accepts only control receipts, but {rcpt} is not one")
            elif round_receipt.get("kind") == "control":
                raise ValueError(
                    f"Round receipt {rcpt} is a control: controls are excluded from the round-close variance, "
                    "M lines 116-117"
                )
            cfg_hash = round_receipt.get("config_hash")
            if not cfg_hash:
                raise ValueError(f"Round receipt {rcpt} has no config_hash")
            df_round = pd.read_parquet(dly)
            df_round.attrs["config_hash"] = str(cfg_hash)
            round_daily[p.name] = df_round

    # 3. Item 2 across the family
    item2_res = item2(family_daily)
    family_matrix, _ = _build_family_matrix(family_daily)

    # Load panel for item 4
    if panel is None:
        symbols = list(manifest["symbols"]) if manifest.get("symbols") else list(UNIVERSE)
        panel = load_panel(ds_path, symbols)

    config_evals: dict[str, Any] = {}
    passing_configs: list[dict[str, Any]] = []

    run_index = {run_id: i for i, run_id in enumerate(sorted(family_runs))}
    for run_id, receipt in family_runs.items():
        res1 = item1(receipt)
        c_daily = family_daily[run_id]
        res3 = item3(receipt, round_daily, ledger_count, candidate_daily=c_daily)
        res5 = item5(receipt)
        res6 = item6(receipt)

        passes_1_to_3 = bool(res1["pass"] and item2_res["pass"] and res3["pass"])

        if passes_1_to_3:
            if run_id not in family_folds:
                raise ValueError(f"Run {run_id} has no folds.json, so the joint-shift null cannot read its betas")
            tranches_df = family_tranches.get(run_id, pd.DataFrame())
            res4 = item4(
                receipt=receipt,
                tranches=tranches_df,
                panel=panel,
                family_matrix=family_matrix,
                folds=family_folds[run_id],
                seed=seed,
                joint_seed=seed_base + run_index[run_id],
            )
        else:
            res4 = {"pass": False, "skipped": True}

        all_pass = bool(
            res1["pass"]
            and item2_res["pass"]
            and res3["pass"]
            and res4.get("pass", False)
            and res5["pass"]
            and res6["pass"]
        )

        cfg_eval = {
            "id": run_id,
            "receipt": receipt,
            "item1": res1,
            "item2": item2_res,
            "item3": res3,
            "item4": res4,
            "item5": res5,
            "item6": res6,
            "joint_shift_seed": seed_base + run_index[run_id] if passes_1_to_3 else None,
            "all_pass": all_pass,
        }
        config_evals[run_id] = cfg_eval

        if all_pass:
            passing_configs.append(cfg_eval)

    # 4. Candidates and finalists
    # Ranked by drift-free daily Sharpe, at most one per (family, model), at most MAX_FINALISTS.
    # Finalists exist only when the label-shift tripwire is known and passes.
    candidates = _rank_candidates(passing_configs)
    finalists = candidates if tripwire_status == "passed" else []

    report = {
        "family": family,
        "n_configurations": len(family_runs),
        "configurations": config_evals,
        "candidates": candidates,
        "finalists": finalists,
        "tripwire": tripwire_status,
        "tripwire_input": tripwire_input,
        "calibration": bool(calibration),
        "seed_base": int(seed_base),
        "inputs_hashes": {
            "dataset_hash": dataset_hash,
            "receipts": input_receipt_shas,
        },
    }

    if out_file is not None:
        out_p = Path(out_file)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        out_p.write_text(json.dumps(report, indent=2), encoding="utf-8")

    return report


__all__ = [
    "BAR",
    "DEV_END",
    "DSR_TRIALS_MIN",
    "JOINT_SHIFT_GRID_MS",
    "MAX_FINALISTS",
    "PROGRAM_TRIALS_BEFORE",
    "family_report",
    "item1",
    "item2",
    "item3",
    "item4",
    "item5",
    "item6",
    "joint_shift_null",
    "read_manifest",
    "shift_tranche_times",
]
