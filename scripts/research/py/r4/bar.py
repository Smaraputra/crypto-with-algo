"""Round 4 exploration bar: items 1 to 6 and family report."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping, Sequence
from fractions import Fraction
from pathlib import Path
from typing import Any, NamedTuple

import numpy as np
import pandas as pd

from r4.book import (
    DAY_MS,
    INTRABAR_EXIT_REASONS,
    Tranche,
    _coerce_tranches,
    _extract_settlements_for_symbol,
    netted_costs,
)
from r4.costs import DEFAULT_FEE_PROFILE, coin_slippage_bps, resolve_fee_profile
from r4.method import (
    BAR,
    DEV_END,
    DSR_TRIALS_MIN,
    ENTRY_DELAY_MS,
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
# The SPA bootstrap seed of family_report, separate from the joint-shift seeds.
DEFAULT_SPA_SEED = 6_000_000


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


VARIANCE_MODES = ("within_cell", "total", "cost_free_total")


def cell_key(config: dict[str, Any]) -> tuple[Any, ...]:
    """The cost cell of a configuration: (interval, h_ms, label, exit, book).

    The exit is parsed (r4.exits.parse_exit) and written back in its canonical form, as the string "horizon" or the
    sorted-key JSON of its dict, so neither key order nor {"k": 1} against {"k": 1.0} splits a cell. The book
    defaults to "slot" and the label to "fixed". A missing interval or h_ms is None (old fixtures).
    """
    from r4.exits import _spec_to_raw, parse_exit

    canonical = _spec_to_raw(parse_exit(config.get("exit", "horizon")))
    exit_key = canonical if isinstance(canonical, str) else json.dumps(canonical, sort_keys=True)
    return (
        config.get("interval"),
        config.get("h_ms"),
        config.get("label", "fixed"),
        exit_key,
        config.get("book", "slot"),
    )


def trial_sharpe_variance(
    round_daily: dict[str, pd.DataFrame],
    round_configs: dict[str, dict[str, Any]],
    mode: str = "within_cell",
) -> dict[str, Any]:
    """Variance of the trial per-calendar-day Sharpes, for the DSR benchmark (owner amendment 2026-10-28).

    round_daily maps run id to a daily frame whose attrs["config_hash"] identifies the configuration (identical
    hashes count once, the first in sorted run-id order). round_configs maps the same ids to config dicts for
    cell_key. Modes:
    - "within_cell": pooled within cost cells. A cell holds the unique configurations sharing cell_key. Cells with
      at least 2 contribute sum((S_i - mean_cell)^2), divided by the sum of (n_cell - 1). Raises when that
      degrees-of-freedom total is below 1.
    - "total": the ddof=1 variance of all unique Sharpes.
    - "cost_free_total": as total, on the Sharpe of gross_hedged + funding (both columns required).
    Returns {"V", "df", "cells_used", "cells_singleton"}. The cell counts are reported in every mode.
    """
    if mode not in VARIANCE_MODES:
        raise ValueError(f"variance mode must be one of {VARIANCE_MODES}, got {mode!r}")
    seen: set[str] = set()
    sharpes: dict[tuple[Any, ...], list[float]] = {}
    for key in sorted(round_daily):
        df = round_daily[key]
        cfg_hash = getattr(df, "attrs", {}).get("config_hash")
        if not cfg_hash:
            raise ValueError(f"Round run {key} has no config_hash, so identical configs cannot be counted once")
        if cfg_hash in seen:
            continue
        seen.add(cfg_hash)
        if key not in round_configs:
            raise ValueError(f"Round run {key} has no config for its cost cell")
        if mode == "cost_free_total":
            if "gross_hedged" not in df.columns or "funding" not in df.columns:
                raise ValueError(f"Round run {key} has no gross_hedged and funding columns for the cost-free Sharpe")
            arr = (df["gross_hedged"] + df["funding"]).to_numpy(dtype=np.float64)
        else:
            col = "drift_free" if "drift_free" in df.columns else df.columns[0]
            arr = df[col].to_numpy(dtype=np.float64)
        sharpes.setdefault(cell_key(round_configs[key]), []).append(per_period_sharpe(arr))

    cells_used = sum(1 for v in sharpes.values() if len(v) >= 2)
    cells_singleton = sum(1 for v in sharpes.values() if len(v) == 1)
    if mode == "within_cell":
        df_total = sum(len(v) - 1 for v in sharpes.values() if len(v) >= 2)
        if df_total < 1:
            raise ValueError(
                "within-cell variance needs at least one cell with 2 unique configs: degrees of freedom < 1"
            )
        ss = sum(float(np.sum((np.asarray(v) - np.mean(v)) ** 2)) for v in sharpes.values() if len(v) >= 2)
        return {"V": ss / df_total, "df": int(df_total), "cells_used": cells_used, "cells_singleton": cells_singleton}

    allv = [x for v in sharpes.values() for x in v]
    if len(allv) < 2:
        raise ValueError(
            f"Item 3 needs at least 2 unique configurations for the trial-Sharpe variance, got {len(allv)}"
        )
    return {
        "V": float(np.var(allv, ddof=1)),
        "df": len(allv) - 1,
        "cells_used": cells_used,
        "cells_singleton": cells_singleton,
    }


def item3(
    receipt: dict[str, Any],
    round_daily: Sequence[float] | float,
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
    if isinstance(round_daily, Mapping):
        raise TypeError(
            "item3 takes the trial-Sharpe variance as a float (or a sequence of trial Sharpes), not a mapping of "
            "daily frames: compute it with trial_sharpe_variance(..., 'within_cell') and pass V"
        )
    if isinstance(round_daily, (int, float)):
        var_trial_sharpes = float(round_daily)
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


def _refuse_path_exits(tranche_list: list[Tranche]) -> None:
    if any(t.exit_reason != "horizon" for t in tranche_list):
        raise ValueError(
            "joint-shift null for path-dependent exits needs the exit-engine replay (Amendment 1); "
            "refusing to treat them as time exits"
        )


ExitReplay = Callable[[pd.DataFrame], pd.DataFrame]

# Group keys of the vectorised netting: (cost class, fill) in the high bits, the instant in the low 43 bits.
_KEY_SHIFT = 43


class _Netting:
    """Vectorised twin of book.netted_costs for a fixed set of tranches whose times and fills may change.

    The coin, fee profile and slippage override of a tranche are fixed (its cost class). Entry and exit instants and
    fills are passed per call. Legs merge exactly as in netted_costs: same coin, same instant, same fill kind and
    same native cost, and never an intrabar exit (stop, take-profit, maker exit), which fills inside a 5m bar.
    """

    def __init__(self, tranches: Sequence[Tranche], profile: str):
        classes: dict[tuple[str, str, float], int] = {}
        cls = np.empty(len(tranches), dtype=np.int64)
        for i, t in enumerate(tranches):
            prof = t.fee_profile if t.fee_profile is not None else profile
            slip = -1.0 if t.slippage_bps_override is None else float(t.slippage_bps_override)
            cls[i] = classes.setdefault((t.symbol, prof, slip), len(classes))
        n_cls = len(classes)
        self._cls = cls
        # rate[2 * c + 1] is the maker rate of class c, rate[2 * c] the taker rate (fee plus slippage).
        self._rate = np.zeros(2 * max(n_cls, 1), dtype=np.float64)
        for (sym, prof, slip), c in classes.items():
            fees = resolve_fee_profile(prof, sym)
            slip_rate = (coin_slippage_bps(sym) if slip < 0.0 else slip) / 10000.0
            self._rate[2 * c] = fees.taker_fee + slip_rate
            self._rate[2 * c + 1] = fees.maker_fee
        for t in tranches:
            for fill in (t.entry_fill, t.exit_fill):
                if fill not in ("maker", "taker"):
                    raise ValueError(f"Unknown fill kind: {fill}")

    def unit_costs(
        self,
        idx: np.ndarray,
        weight: np.ndarray,
        entry_ms: np.ndarray,
        exit_ms: np.ndarray,
        entry_maker: np.ndarray,
        exit_maker: np.ndarray,
        exit_intrabar: np.ndarray,
    ) -> np.ndarray:
        """Netted cost per unit of absolute weight of the tranches idx (arrays aligned to idx).

        exit_intrabar marks exits that fill inside a 5m bar (they never net). Entries fill at a 5m open.
        """
        n = len(idx)
        if n == 0:
            return np.zeros(0, dtype=np.float64)
        cls = self._cls[idx]
        code_e = 2 * cls + entry_maker.astype(np.int64)
        code_x = 2 * cls + exit_maker.astype(np.int64)
        intra = np.concatenate((np.zeros(n, dtype=bool), exit_intrabar.astype(bool)))
        code = np.concatenate((code_e, code_x))
        key = (code << _KEY_SHIFT) | np.concatenate((entry_ms.astype(np.int64), exit_ms.astype(np.int64)))
        # Open-price legs merge on (class, fill, instant). An intrabar leg is a group of its own.
        uniq, inv = np.unique(key[~intra], return_inverse=True)
        n_open = len(uniq)
        n_intra = int(intra.sum())
        gid = np.empty(2 * n, dtype=np.int64)
        gid[~intra] = inv
        gid[intra] = n_open + np.arange(n_intra, dtype=np.int64)
        g_code = np.concatenate((uniq >> _KEY_SHIFT, code[intra]))
        n_groups = n_open + n_intra
        amount = np.concatenate((weight, -weight))
        traded = np.abs(np.bincount(gid, weights=amount, minlength=n_groups))
        abs_sum = np.bincount(gid, weights=np.abs(amount), minlength=n_groups)
        group_cost = traded * self._rate[g_code]
        with np.errstate(divide="ignore", invalid="ignore"):
            share = np.where(abs_sum[gid] > 0.0, np.abs(amount) / abs_sum[gid], 0.0)
        leg = share * group_cost[gid]
        cost = leg[:n] + leg[n:]
        w_abs = np.abs(weight)
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(w_abs > 0.0, cost / w_abs, 0.0)


def _unit_costs(tranches: Sequence[Tranche], profile: str = DEFAULT_FEE_PROFILE) -> np.ndarray:
    """Netted cost per unit of absolute weight of a tranche set, from its own times and fills (twin of netted_costs)."""
    tr = list(tranches)
    return _Netting(tr, profile).unit_costs(
        np.arange(len(tr)),
        np.array([t.weight for t in tr], dtype=np.float64),
        np.array([t.entry_ms for t in tr], dtype=np.int64),
        np.array([t.exit_ms for t in tr], dtype=np.int64),
        np.array([t.entry_fill == "maker" for t in tr], dtype=bool),
        np.array([t.exit_fill == "maker" for t in tr], dtype=bool),
        np.array([t.exit_intrabar for t in tr], dtype=bool),
    )


class JointShiftStats(NamedTuple):
    """The raw output of a joint-shift run: the observed statistic, one statistic per draw and the bookkeeping."""

    obs_stat: float
    null_stats: np.ndarray
    shifts: list[int]
    total_dropped: int
    n_tranches: int
    zero_shift_stat: float | None = None
    # Sum of |weight| and count of the observed tranches that carry a finite return: obs_stat x obs_weight_sum is the
    # observed set's weighted return, which the book's summed drift_free must equal (the calibration book anchor).
    obs_weight_sum: float | None = None
    obs_n_kept: int | None = None


def make_exit_replay(
    ctx: Any,
    spec: Any,
    folds: Sequence[dict[str, Any]] | None = None,
    fold_models: Callable[[dict[str, Any]], Any] | None = None,
) -> ExitReplay:
    """Build the callable joint_shift_null takes as exit_replay, from an ExitContext and an exit spec.

    The callable takes a frame of entries (symbol, side, T, entry_ms, exit_ms, entry_price; exit_ms is the scheduled
    exit) and returns the exit fields aligned to it: exit_ms, exit_price, exit_fill, exit_reason.
    For E4 and E5 the exit-model pair is the one of the fold whose [start_ms, end_ms) holds the entry: folds is the
    run's fold list and fold_models(fold) returns that fold's models (None is the counted E1 fallback). Entries outside
    every fold close at their scheduled exit, and the null drops them anyway (no beta there). Models are asked for
    once per fold.
    """
    from r4.exits import parse_exit

    parsed = parse_exit(spec)
    model_rule = parsed.rule in ("E4", "E5")
    fold_rows: list[dict[str, Any]] = []
    starts = ends = np.empty(0, dtype=np.int64)
    if model_rule:
        if not folds or fold_models is None:
            raise ValueError(f"exit {parsed.rule} needs the run's folds and a fold_models callable")
        fold_rows = sorted(folds, key=lambda f: int(f["start_ms"]))
        starts = np.array([int(f["start_ms"]) for f in fold_rows], dtype=np.int64)
        ends = np.array([int(f["end_ms"]) for f in fold_rows], dtype=np.int64)
    cache: dict[int, Any] = {}

    def replay(entries: pd.DataFrame) -> pd.DataFrame:
        if not model_rule:
            return ctx.replay(entries, parsed).reset_index(drop=True)
        n = len(entries)
        entry_ms = entries["entry_ms"].to_numpy(dtype=np.int64)
        f_idx = np.searchsorted(starts, entry_ms, side="right") - 1
        f_c = np.maximum(f_idx, 0)
        in_fold = (f_idx >= 0) & (entry_ms < ends[f_c])
        exit_ms = entries["exit_ms"].to_numpy(dtype=np.int64).copy()
        exit_price = np.full(n, np.nan, dtype=np.float64)
        exit_fill = np.full(n, "taker", dtype=object)
        exit_reason = np.full(n, "horizon", dtype=object)
        for fi in np.unique(f_idx[in_fold]):
            fi = int(fi)
            if fi not in cache:
                cache[fi] = fold_models(fold_rows[fi])
            ctx.set_models(cache[fi])
            rows = np.flatnonzero(in_fold & (f_idx == fi))
            res = ctx.replay(entries.iloc[rows].reset_index(drop=True), parsed)
            exit_ms[rows] = res["exit_ms"].to_numpy(dtype=np.int64)
            exit_price[rows] = res["exit_price"].to_numpy(dtype=np.float64)
            exit_fill[rows] = res["exit_fill"].to_numpy()
            exit_reason[rows] = res["exit_reason"].to_numpy()
        out = pd.DataFrame(
            {"exit_ms": exit_ms, "exit_price": exit_price, "exit_fill": exit_fill, "exit_reason": exit_reason}
        )
        return out

    return replay


def build_exit_replay(
    panel: dict[str, dict[str, pd.DataFrame]],
    config: dict[str, Any],
    folds: Sequence[dict[str, Any]],
    exit_cache_dir: Path | str | None = None,
    dataset_hash: str | None = None,
) -> ExitReplay:
    """Rebuild a run's exit replay from the panel, the receipt's config and its folds.json (nothing is stored).

    The exit context (5m bars, sigma table, premium and settlements) is built from the panel. For E4 and E5 the
    fold models are refitted deterministically, lazily and once per fold: monthly runs fit on
    (fold.train_cut_ms, fold.start_ms) as walk_forward does, refit "none" runs fit once on all history before
    config["first_refit_ms"].
    """
    from r4.exit_models import ExitModelFactory
    from r4.exits import ExitContext, parse_exit
    from r4.pipeline import _panel_premium, run_config_from_raw

    cfg = run_config_from_raw(config)
    spec = parse_exit(cfg.exit)
    settlements = {s: panel[s].get("settlements", panel[s].get("funding")) for s in panel}
    ctx = ExitContext(
        {s: panel[s]["5m"] for s in panel}, cfg.h_ms, premium=_panel_premium(panel), settlements=settlements
    )
    models_for: Callable[[dict[str, Any]], Any] | None = None
    if spec.rule in ("E4", "E5"):
        factory = ExitModelFactory.from_config(panel, cfg, cache_dir=exit_cache_dir, dataset_hash=dataset_hash)
        first_refit = int(config["first_refit_ms"])
        refit_none = cfg.refit == "none"

        def models_for(fold: dict[str, Any]) -> Any:
            if refit_none:
                return factory.fit(None, first_refit)
            cut = fold.get("train_cut_ms")
            return factory.fit(None if cut is None else int(cut), int(fold["start_ms"]))

    return make_exit_replay(ctx, spec, folds=folds, fold_models=models_for)


def joint_shift_stats(
    tranches: list[Tranche] | pd.DataFrame,
    panel: dict[str, dict[str, pd.DataFrame]],
    folds: Sequence[dict[str, Any]],
    span_start_ms: int,
    span_end_ms: int,
    n_draws: int = 1000,
    min_shift_days: int = 7,
    seed: int = 7,
    profile: str = DEFAULT_FEE_PROFILE,
    exit_replay: ExitReplay | None = None,
    zero_shift: bool = False,
) -> JointShiftStats:
    """The joint-shift draws behind joint_shift_null. See that function for the rule.

    zero_shift (with exit_replay only) also prices the OBSERVED entries through the draw path at a shift of zero days:
    the replayed exits, the book's fill rule and the netting of the kept set. zero_shift_stat is that statistic. It
    must equal obs_stat (the stored tranches' own statistic), which ties the observed value and the null to one code
    path (brief 28c, shift-zero identity). The draws themselves are unchanged.

    With exit_replay set, every draw shifts the entries only, re-runs the exit engine from them, prices the
    replayed exits and nets the costs on the draw's kept set. Without it, the tranche set must be horizon-only and the
    shifted copy keeps the observed set's hold and netted cost allocation.
    """
    n_days = int((span_end_ms - span_start_ms) // DAY_MS)
    if n_days < 2 * min_shift_days:
        raise ValueError(
            f"Span of {n_days} days is shorter than 2 x min_shift_days ({2 * min_shift_days}), no valid shift exists"
        )

    tranche_list = _coerce_tranches(tranches)
    replay = exit_replay is not None
    if not replay:
        _refuse_path_exits(tranche_list)
    if not tranche_list:
        return JointShiftStats(float("nan"), np.empty(0), [], 0, 0)

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
    weight = np.array([t.weight for t in tranche_list], dtype=np.float64)
    w_abs = np.abs(weight)
    entry0 = np.array([t.entry_ms for t in tranche_list], dtype=np.int64)
    exit0 = np.array([t.exit_ms for t in tranche_list], dtype=np.int64)
    # The observed tranche set uses the book's fill-price rule: a priced entry or exit takes the tranche's own
    # price, and the basket hedge of a priced exit ends at the next 5m boundary. Without a replay the shifted
    # copies keep horizon pricing. With one they follow the same rule as the observed set, from the replayed exit.
    entry_priced = np.array([t.entry_priced for t in tranche_list], dtype=bool)
    exit_priced = np.array([t.exit_priced for t in tranche_list], dtype=bool)
    entry_px0 = np.array([t.entry_price for t in tranche_list], dtype=np.float64)
    exit_px0 = np.array([t.exit_price for t in tranche_list], dtype=np.float64)
    no_priced = np.zeros(n_tr, dtype=bool)
    no_px = np.full(n_tr, np.nan, dtype=np.float64)

    fold_starts, fold_ends, fold_betas = _fold_table(folds, basket)

    def beta_at(entry: np.ndarray) -> np.ndarray:
        f_idx = np.searchsorted(fold_starts, entry, side="right") - 1
        f_idx_c = np.maximum(f_idx, 0)
        in_fold = (f_idx >= 0) & (entry < fold_ends[f_idx_c])
        return np.where(in_fold, fold_betas[f_idx_c, sym_idx], np.nan)

    # Net over the same set the book charges: observed tranches with a finite beta in the fold of their entry
    # (beta_hedged_daily excludes the rest, so they carry no fill). The excluded ones get no cost; their return is
    # NaN through beta anyway.
    included = np.isfinite(beta_at(entry0))
    arange_tr = np.arange(n_tr)
    netting = _Netting(tranche_list, profile) if replay else None
    entry_maker0 = np.array([t.entry_fill == "maker" for t in tranche_list], dtype=bool)
    exit_maker0 = np.array([t.exit_fill == "maker" for t in tranche_list], dtype=bool)
    exit_intra0 = np.array([t.exit_intrabar for t in tranche_list], dtype=bool)
    costs = np.zeros(n_tr, dtype=np.float64)
    if np.any(included):
        inc_idx = np.flatnonzero(included)
        if netting is not None:
            costs[inc_idx] = netting.unit_costs(
                inc_idx,
                weight[inc_idx],
                entry0[inc_idx],
                exit0[inc_idx],
                entry_maker0[inc_idx],
                exit_maker0[inc_idx],
                exit_intra0[inc_idx],
            )
        else:
            netted = netted_costs([tranche_list[i] for i in inc_idx], profile)
            with np.errstate(divide="ignore", invalid="ignore"):
                costs[inc_idx] = np.where(w_abs[inc_idx] > 0.0, netted.tranche_cost / w_abs[inc_idx], 0.0)

    def hedge_terms(
        entry: np.ndarray,
        exit_: np.ndarray,
        e_priced: np.ndarray,
        e_px: np.ndarray,
        x_priced: np.ndarray,
        x_px: np.ndarray,
        x_intra: np.ndarray,
        pe: np.ndarray | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        """(side x (r_coin - beta x r_EW), side x funding) per tranche, NaN where an input is missing.

        Funding sums the settlements in (entry, exit], and in (entry, exit) for an intrabar exit (x_intra).
        """
        any_priced = bool(e_priced.any() or x_priced.any())
        hedge_exit = np.where(x_priced, -(-exit_ // 300_000) * 300_000, exit_) if x_priced.any() else exit_
        if pe is None:
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
        if any_priced:
            # Coin leg from the fill prices where priced, else from the exact 5m opens as before.
            own_entry = np.where(e_priced, e_px, pe[sym_idx, arange_tr])
            own_exit = np.where(x_priced, x_px, px[sym_idx, arange_tr])
            with np.errstate(all="ignore"):
                r_coin = np.where((own_entry > 0.0) & (own_exit > 0.0), np.log(own_exit / own_entry), np.nan)

        beta = beta_at(entry)

        funding = np.zeros(n_tr, dtype=np.float64)
        for pos, f_t in fund_times.items():
            sel = sym_idx == pos
            if not np.any(sel) or len(f_t) == 0:
                continue
            cum = fund_cum[pos]
            idx_exit = np.where(
                x_intra[sel],
                np.searchsorted(f_t, exit_[sel], side="left"),
                np.searchsorted(f_t, exit_[sel], side="right"),
            )
            idx_entry = np.searchsorted(f_t, entry[sel], side="right")
            funding[sel] = cum[idx_exit] - cum[idx_entry]

        return side * (r_coin - beta * r_ew), side * funding

    def weighted(ret: np.ndarray, keep: np.ndarray) -> float:
        """Weighted mean return per unit of absolute weight over kept tranches. Inf when none are kept."""
        if not np.any(keep):
            # A draw with no kept tranche cannot beat the observed value, so it counts against the tranche set.
            return float("inf")
        return float(np.sum(w_abs[keep] * ret[keep]) / np.sum(w_abs[keep]))

    core0, fund0 = hedge_terms(entry0, exit0, entry_priced, entry_px0, exit_priced, exit_px0, exit_intra0)
    obs_ret = core0 - costs - fund0
    obs_keep = np.isfinite(obs_ret)
    if not np.any(obs_keep):
        return JointShiftStats(float("nan"), np.empty(0), [], 0, n_tr)
    obs_stat = weighted(obs_ret, obs_keep)

    hold = np.array([t.h_ms for t in tranche_list], dtype=np.int64) if replay else exit0 - entry0
    sym_names = np.array([t.symbol for t in tranche_list], dtype=object)
    side_int = side.astype(np.int64)

    max_shift_days = n_days - min_shift_days
    rng = np.random.default_rng(seed)
    shifts = rng.integers(min_shift_days, max_shift_days, endpoint=True, size=n_draws)

    def replay_draw(sh_entry: np.ndarray, sh_exit: np.ndarray) -> tuple[float, int]:
        """(statistic, dropped count) of one set of entry and scheduled-exit times through the exit replay."""
        assert exit_replay is not None and netting is not None
        late = sh_exit > span_end_ms
        pe = prices_at(sh_entry)
        entry_px = pe[sym_idx, arange_tr]
        sched_px = prices_at(sh_exit)[sym_idx, arange_tr]
        cand = ~late & (entry_px > 0.0) & (sched_px > 0.0) & np.isfinite(beta_at(sh_entry))
        ex_ms = sh_exit.copy()
        ex_px = np.full(n_tr, np.nan, dtype=np.float64)
        ex_priced = np.zeros(n_tr, dtype=bool)
        ex_maker = np.zeros(n_tr, dtype=bool)
        ex_intra = np.zeros(n_tr, dtype=bool)
        rows = np.flatnonzero(cand)
        if len(rows):
            frame = pd.DataFrame(
                {
                    "symbol": sym_names[rows],
                    "side": side_int[rows],
                    "T": sh_entry[rows] - ENTRY_DELAY_MS,
                    "entry_ms": sh_entry[rows],
                    "exit_ms": sh_exit[rows],
                    "entry_price": entry_px[rows],
                }
            )
            res = exit_replay(frame)
            if len(res) != len(rows):
                raise ValueError("exit_replay must return one row per entry")
            ex_ms[rows] = res["exit_ms"].to_numpy(dtype=np.int64)
            ex_px[rows] = res["exit_price"].to_numpy(dtype=np.float64)
            reason = res["exit_reason"].to_numpy()
            ex_priced[rows] = reason != "horizon"
            ex_maker[rows] = res["exit_fill"].to_numpy() == "maker"
            ex_intra[rows] = np.isin(reason, INTRABAR_EXIT_REASONS)
        core, fund = hedge_terms(sh_entry, ex_ms, no_priced, no_px, ex_priced, ex_px, ex_intra, pe=pe)
        gross = core - fund
        keep = np.isfinite(gross) & cand
        kept = np.flatnonzero(keep)
        ret = np.zeros(n_tr, dtype=np.float64)
        if len(kept):
            unit = netting.unit_costs(
                kept, weight[kept], sh_entry[kept], ex_ms[kept], entry_maker0[kept], ex_maker[kept], ex_intra[kept]
            )
            ret[kept] = gross[kept] - unit
        return weighted(ret, keep), int(n_tr - np.sum(keep))

    zero_stat: float | None = None
    if zero_shift and replay:
        zero_stat, _ = replay_draw(entry0, entry0 + hold)

    null_stats = np.empty(n_draws, dtype=np.float64)
    total_dropped = 0
    for draw_idx in range(n_draws):
        s_days = int(shifts[draw_idx])
        sh_entry, sh_exit = shift_tranche_times(entry0, entry0 + hold, s_days, span_start_ms, n_days)
        if not replay:
            late = sh_exit > span_end_ms
            core, fund = hedge_terms(sh_entry, sh_exit, no_priced, no_px, no_priced, no_px, no_priced)
            ret = core - costs - fund
            keep = np.isfinite(ret) & ~late
            total_dropped += int(n_tr - np.sum(keep))
            null_stats[draw_idx] = weighted(ret, keep)
            continue
        stat, dropped = replay_draw(sh_entry, sh_exit)
        total_dropped += dropped
        null_stats[draw_idx] = stat

    return JointShiftStats(
        obs_stat,
        null_stats,
        [int(s) for s in shifts],
        total_dropped,
        n_tr,
        zero_stat,
        obs_weight_sum=float(np.sum(w_abs[obs_keep])),
        obs_n_kept=int(np.sum(obs_keep)),
    )


def joint_shift_p(stats: JointShiftStats, n_draws: int) -> tuple[float, float]:
    """The p-value and the drop share of a joint-shift run: the one rule joint_shift_null and the exit block share.

    p = (1 + number of draws with a statistic at or above the observed) / (1 + n_draws). The drop share is the
    dropped tranche-draws over n_draws x n_tranches. No tranches gives (1.0, 0.0). No shift that fits the span gives
    (1.0, 1.0): every draw is lost.
    """
    if stats.n_tranches == 0:
        return 1.0, 0.0
    if not stats.shifts:
        return 1.0, 1.0
    k = int(np.sum(stats.null_stats >= stats.obs_stat))
    return float((1 + k) / (1 + n_draws)), float(stats.total_dropped / (n_draws * stats.n_tranches))


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
    exit_replay: ExitReplay | None = None,
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

    exit_replay (Amendment 1, N5) is for a declared path-dependent exit. Without it, a non-horizon tranche raises.
    With it, each draw shifts every entry by the same whole days with its side, weight and hold h_ms (the scheduled
    exit is the shifted entry plus h_ms), calls exit_replay on the frame of shifted entries (symbol, side, T,
    entry_ms, exit_ms, entry_price) to get each exit (exit_ms, exit_price, exit_fill, exit_reason), prices the
    tranche by the book's rule (fill price for a priced exit, basket hedge ending at the stamp) and recomputes the
    netted costs on the draw's kept set. A shifted entry is priced at the 5m open at its instant. The observed set
    uses its own replayed exits and the netted costs of the observed set. A shifted tranche is dropped as above, and
    when its scheduled exit passes the span end. See make_exit_replay and build_exit_replay.

    Returns (p_value, drop_share, observed_statistic, shifts_in_days).
    """
    stats = joint_shift_stats(
        tranches,
        panel,
        folds,
        span_start_ms,
        span_end_ms,
        n_draws=n_draws,
        min_shift_days=min_shift_days,
        seed=seed,
        profile=profile,
        exit_replay=exit_replay,
    )
    p_val, drop_share = joint_shift_p(stats, n_draws)
    if stats.n_tranches == 0 or not stats.shifts:
        return p_val, drop_share, float("nan"), []
    return p_val, drop_share, stats.obs_stat, stats.shifts


def item4(
    receipt: dict[str, Any],
    tranches: list[Tranche] | pd.DataFrame,
    panel: dict[str, dict[str, pd.DataFrame]],
    family_matrix: np.ndarray | pd.DataFrame,
    folds: Sequence[dict[str, Any]],
    end_ms: int = DEV_END,
    seed: int = 7,
    joint_seed: int | None = None,
    spa_seed: int | None = None,
    exit_replay: ExitReplay | None = None,
) -> dict[str, Any]:
    """Lock exploration bar item 4 (only for configurations passing items 1 to 3):

    - Joint-shift random-entry null: circular shifts of tranche set by whole days
    - Hansen SPA on the family's intersection matrix
    - Label-shift tripwire: run by Claude outside this function, reported here as 'pending'

    spa_seed drives the SPA bootstrap and defaults to seed. joint_seed drives the joint-shift draws and
    defaults to seed.
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
        exit_replay=exit_replay,
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
        seed=seed if spa_seed is None else spa_seed,
    )

    pass_joint = bool(p_joint < float(BAR["random_entry_p_max"]))
    pass_spa = bool(spa_p < float(BAR["spa_p_max"]))
    passed = bool(pass_joint and pass_spa)

    return {
        "pass": passed,
        "joint_shift_seed": int(seed if joint_seed is None else joint_seed),
        "spa_seed": int(seed if spa_seed is None else spa_seed),
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
    or for family D (or any config with book "D") a drop-one-coin jackknife that stays positive.
    The jackknife removes a coin's tranches without re-ranking the rest, which is the declared reading.
    A null mean is not positive.
    """
    metrics = receipt["metrics"]
    config = receipt.get("config", {})

    if config.get("family") == "D" or config.get("book") == "D":
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


def _exit_model_fallback(receipt: dict[str, Any]) -> bool:
    """True for an E4 or E5 receipt that counts walk-forward folds run as E1 (the exit-model fit fell back)."""
    from r4.exits import parse_exit

    if parse_exit(receipt.get("config", {}).get("exit", "horizon")).rule not in ("E4", "E5"):
        return False
    return int(receipt.get("metrics", {}).get("exit_model_fallback_folds", 0)) > 0


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
    spa_seed: int | None = None,
    variance_mode: str = "within_cell",
    family_index: int = 0,
) -> dict[str, Any]:
    """Evaluate exploration bar across all configurations in a family and write report.

    The trial-Sharpe variance V of item 3 is the within-cost-cell pooled variance by default (owner amendment
    2026-10-28). All three modes are computed and recorded under report["variance"]; variance_mode picks the one
    item 3 receives.

    calibration=False (default) is the trial path: a round receipt with kind "control" raises, because controls
    are excluded from the round-close variance (M lines 116-117). calibration=True is the control path: only
    receipts with kind "control" are accepted, in the family and in the round directory.
    The joint-shift seed of each configuration is receipt["config"]["joint_shift_seed"] when present, else
    seed_base + its index in the sorted run ids. In calibration mode a configuration without one raises. The seed
    used is recorded per configuration. spa_seed drives the SPA bootstrap and defaults to DEFAULT_SPA_SEED +
    family_index (the family's index in the program, spec section 9). Both are recorded with seed.

    An E4 or E5 configuration whose receipt counts walk-forward fold fallbacks (exit_model_fallback_folds above 0)
    ran some folds as E1, so it is not the configuration under test: its evaluation carries "exit_model_fallback":
    true, and calibration mode raises.

    Finalists are chosen only once the label-shift tripwire is known and does not halt the family.
    Without a tripwire input the all-pass configurations are listed as candidates and finalists stay empty.
    """
    from r4.cli import reproduction_inputs
    from r4.data import sha256_file
    from r4.pipeline import load_panel

    if isinstance(family_index, bool) or not isinstance(family_index, int) or family_index < 0:
        raise ValueError(f"family_index must be a non-negative int, got {family_index!r}")
    if spa_seed is None:
        spa_seed = DEFAULT_SPA_SEED + family_index

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
                if receipt.get("kind") == "tripwire":
                    raise ValueError(f"Tripwire receipt {receipt_file} is not a trial: it never enters a family")
                if calibration and receipt.get("kind") != "control":
                    raise ValueError(f"Calibration mode accepts only control receipts, but {receipt_file} is not one")
                if calibration and receipt.get("config", {}).get("joint_shift_seed") is None:
                    raise ValueError(
                        f"Calibration mode needs config.joint_shift_seed in every receipt, but {receipt_file} has none"
                    )
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
    round_configs: dict[str, dict[str, Any]] = {}
    for p in sorted(round_path.iterdir()):
        if not p.is_dir():
            continue
        rcpt = p / "receipt.json"
        dly = p / "daily.parquet"
        if rcpt.exists() and dly.exists():
            round_receipt = json.loads(rcpt.read_text(encoding="utf-8"))
            if round_receipt.get("kind") == "tripwire":
                raise ValueError(f"Round receipt {rcpt} is a tripwire receipt: tripwire runs add no trials")
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
            round_configs[p.name] = round_receipt.get("config", {})

    # 3. Item 2 across the family
    item2_res = item2(family_daily)
    family_matrix, _ = _build_family_matrix(family_daily)

    # Load panel for item 4
    if panel is None:
        symbols = list(manifest["symbols"]) if manifest.get("symbols") else list(UNIVERSE)
        panel = load_panel(ds_path, symbols)

    if variance_mode not in VARIANCE_MODES:
        raise ValueError(f"variance_mode must be one of {VARIANCE_MODES}, got {variance_mode!r}")
    variance_modes: dict[str, Any] = {}
    for vm in VARIANCE_MODES:
        try:
            variance_modes[vm] = trial_sharpe_variance(round_daily, round_configs, vm)
        except ValueError as exc:
            if vm == variance_mode:
                raise
            variance_modes[vm] = {"error": str(exc)}
    chosen_v = float(variance_modes[variance_mode]["V"])
    n_unique_round = len({df.attrs["config_hash"] for df in round_daily.values()})

    config_evals: dict[str, Any] = {}
    passing_configs: list[dict[str, Any]] = []

    run_index = {run_id: i for i, run_id in enumerate(sorted(family_runs))}
    for run_id, receipt in family_runs.items():
        exit_fallback = _exit_model_fallback(receipt)
        if exit_fallback and calibration:
            raise ValueError(
                f"Run {run_id} is an E4 or E5 configuration with {receipt['metrics']['exit_model_fallback_folds']} "
                "walk-forward fold(s) run as E1 (exit_model_fallback_folds above 0): it is not the configuration "
                "under test"
            )
        res1 = item1(receipt)
        c_daily = family_daily[run_id]
        res3 = item3(receipt, chosen_v, ledger_count, candidate_daily=c_daily)
        res3["variance_mode"] = variance_mode
        res3["n_unique_configs"] = n_unique_round
        res5 = item5(receipt)
        res6 = item6(receipt)

        passes_1_to_3 = bool(res1["pass"] and item2_res["pass"] and res3["pass"])

        config_seed = receipt.get("config", {}).get("joint_shift_seed")
        run_joint_seed = int(config_seed) if config_seed is not None else seed_base + run_index[run_id]

        if passes_1_to_3:
            if run_id not in family_folds:
                raise ValueError(f"Run {run_id} has no folds.json, so the joint-shift null cannot read its betas")
            tranches_df = family_tranches.get(run_id, pd.DataFrame())
            from r4.exits import is_horizon

            replay_fn = (
                None
                if is_horizon(receipt.get("config", {}).get("exit", "horizon"))
                else build_exit_replay(panel, receipt["config"], family_folds[run_id])
            )
            res4 = item4(
                receipt=receipt,
                tranches=tranches_df,
                panel=panel,
                family_matrix=family_matrix,
                folds=family_folds[run_id],
                seed=seed,
                joint_seed=run_joint_seed,
                spa_seed=spa_seed,
                exit_replay=replay_fn,
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
            "joint_shift_seed": run_joint_seed if passes_1_to_3 else None,
            "exit_model_fallback": exit_fallback,
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
        "variance": {"mode": variance_mode, "V": chosen_v, "modes": variance_modes},
        "tripwire": tripwire_status,
        "tripwire_input": tripwire_input,
        "calibration": bool(calibration),
        "seed_base": int(seed_base),
        "seed": int(seed),
        "spa_seed": int(spa_seed),
        "family_index": int(family_index),
        **reproduction_inputs(),
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
    "VARIANCE_MODES",
    "cell_key",
    "trial_sharpe_variance",
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
    "JointShiftStats",
    "build_exit_replay",
    "joint_shift_null",
    "joint_shift_p",
    "joint_shift_stats",
    "make_exit_replay",
    "read_manifest",
    "shift_tranche_times",
]
