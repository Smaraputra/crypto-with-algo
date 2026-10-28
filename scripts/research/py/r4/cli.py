"""Round 4 command-line interface: run-wf, bar, and feature-check."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import logging
import os
import re
import time
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler

from r4.bar import family_report, read_manifest
from r4.book import (
    DAY_MS,
    beta_hedged_daily,
    daily_close_log_returns,
    daily_series,
    estimate_betas,
    netted_costs,
)
from r4.costs import DEFAULT_FEE_PROFILE
from r4.exit_models import ExitModelFactory
from r4.exits import ExitContext, ModelInputs, is_horizon, parse_exit
from r4.features import ALL_FEATURE_COLUMNS, build_feature_frame
from r4.method import (
    BAR,
    CPCV_EMBARGO_MS,
    CPCV_GROUPS,
    CPCV_TEST_GROUPS,
    DEV_END,
    DEV_START,
    ENTRY_DELAY_MS,
    UNIVERSE,
)
from r4.pipeline import (
    FoldRecord,
    RunConfig,
    _get_decisions,
    _make_tranches,
    _panel_premium,
    assert_whole_decision_times,
    compute_missing_settlement_times,
    decision_samples,
    fit_side_model,
    load_panel,
    walk_forward,
)
from r4.plant import PlantedPanel, apply_plant
from r4.stats import per_period_sharpe
from r4.tripwire import SHIFT_DAYS, label_shift_tripwire
from r4.validation import cpcv_path_ids, cpcv_paths, panel_cpcv_splits

logger = logging.getLogger(__name__)


def _count_funding_dropped(
    panel: dict[str, dict[str, pd.DataFrame]],
    cfg: RunConfig,
) -> int:
    """Count how many decision samples are dropped due to missing funding settlements."""
    interval_ms = 3_600_000 if cfg.interval == "1h" else 14_400_000
    funding_dropped = 0
    for _sym, data_dict in panel.items():
        df_settle = data_dict.get("settlements", data_dict.get("funding"))
        missing = compute_missing_settlement_times(df_settle)
        if not missing:
            continue
        dec_bars = data_dict.get(cfg.interval)
        if dec_bars is None or dec_bars.empty or "t" not in dec_bars.columns:
            continue
        dec_opens = dec_bars["t"].to_numpy(dtype=np.int64)
        t_arr = dec_opens + interval_ms
        entry_times = t_arr + ENTRY_DELAY_MS
        exit_times = entry_times + cfg.h_ms
        sorted_missing = np.array(sorted(missing), dtype=np.int64)
        idx_l = np.searchsorted(sorted_missing, entry_times, side="right")
        idx_r = np.searchsorted(sorted_missing, exit_times, side="right")
        funding_dropped += int(np.sum(idx_r > idx_l))
    return funding_dropped


def restrict_to_d(samples: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """Keep samples inside the development window D: t0 >= DEV_START and t1_max < DEV_END.

    Returns the restricted frame (positional index reset, attrs kept) and how many rows were removed.
    """
    keep = (samples["t0"] >= DEV_START) & (samples["t1_max"] < DEV_END)
    restricted = samples.loc[keep].reset_index(drop=True)
    restricted.attrs = dict(samples.attrs)
    return restricted, int(len(samples) - len(restricted))


def cpcv_path_layout(
    path_ids: np.ndarray,
    n_groups: int,
    n_test_groups: int,
) -> dict[tuple[int, int], tuple[int, int]]:
    """Map (path, group) to (split index, position of the group among that split's test groups).

    Splits come in lexicographic order of test group combinations, the same order panel_cpcv_splits yields.
    A path's group g is predicted by the split that tests g in that path, so only that split's model and
    betas may be used for g.
    """
    combos = list(itertools.combinations(range(n_groups), n_test_groups))
    if len(combos) != len(path_ids):
        raise ValueError(f"path_ids has {len(path_ids)} splits but {n_groups} choose {n_test_groups} is {len(combos)}")
    layout: dict[tuple[int, int], tuple[int, int]] = {}
    for s, combo in enumerate(combos):
        for j, g in enumerate(combo):
            key = (int(path_ids[s, j]), g)
            if key in layout:
                raise ValueError(f"Path {key[0]} has group {g} tested by two splits")
            layout[key] = (s, j)
    return layout


def cpcv_path_daily(
    path: int,
    path_sides: np.ndarray,
    samples: pd.DataFrame,
    test_groups_by_split: Sequence[Sequence[np.ndarray]],
    layout: dict[tuple[int, int], tuple[int, int]],
    split_betas: Sequence[dict[str, float]],
    cfg: RunConfig,
    five_min: dict[str, pd.DataFrame],
    settlements: Any,
    universe: Sequence[str],
    span_start_ms: int,
    span_end_ms: int,
    exit_ctx: ExitContext | None = None,
    split_exit_models: Sequence[ModelInputs | None] | None = None,
) -> tuple[pd.DataFrame, int]:
    """Daily series of one CPCV path (drift_free and gross_hedged_funding), and the NaN-beta exclusion count.

    For each test group g of the path, the tranches come from the split that tested g in this path and are
    priced with THAT split's betas (estimated on its training set). No averaging, no fallback.
    gross_hedged_funding is gross_hedged plus funding, with no costs. With split_exit_models (E4 and E5), the tranches
    of a group replay with the exit-model pair of the split that tested it (None is that split's counted E1 fallback).
    """
    frames: list[pd.DataFrame] = []
    for (p, _g), (s, j) in sorted(layout.items()):
        if p != path:
            continue
        idx = np.asarray(test_groups_by_split[s][j], dtype=int)
        if len(idx) == 0:
            continue
        if exit_ctx is not None and split_exit_models is not None:
            exit_ctx.set_models(split_exit_models[s])
        tr = _make_tranches(samples.iloc[idx], path_sides[idx], cfg, exit_ctx)
        if not tr:
            continue
        frames.append(beta_hedged_daily(tr, five_min, settlements, betas=split_betas[s], universe=universe))

    if frames:
        combined = pd.concat(frames).groupby("day_start").sum()
        combined["gross_hedged_funding"] = combined["gross_hedged"] + combined["funding"]
    else:
        combined = pd.DataFrame(columns=["drift_free", "excluded_tranches", "gross_hedged_funding"])
        combined.index.name = "day_start"
    excluded = int(combined["excluded_tranches"].sum()) if len(combined) else 0
    daily = pd.concat(
        [
            daily_series(combined, column="drift_free", span_start_ms=span_start_ms, span_end_ms=span_end_ms)[
                "drift_free"
            ],
            daily_series(combined, column="gross_hedged_funding", span_start_ms=span_start_ms, span_end_ms=span_end_ms)[
                "gross_hedged_funding"
            ],
        ],
        axis=1,
    )
    return daily, excluded


def cpcv_path_drift_free(
    path: int,
    path_sides: np.ndarray,
    samples: pd.DataFrame,
    test_groups_by_split: Sequence[Sequence[np.ndarray]],
    layout: dict[tuple[int, int], tuple[int, int]],
    split_betas: Sequence[dict[str, float]],
    cfg: RunConfig,
    five_min: dict[str, pd.DataFrame],
    settlements: Any,
    universe: Sequence[str],
    span_start_ms: int,
    span_end_ms: int,
    exit_ctx: ExitContext | None = None,
) -> tuple[pd.Series, int]:
    """Drift-free daily series of one CPCV path, and how many tranches were excluded for a NaN beta."""
    daily, excluded = cpcv_path_daily(
        path,
        path_sides,
        samples,
        test_groups_by_split,
        layout,
        split_betas,
        cfg,
        five_min,
        settlements,
        universe,
        span_start_ms,
        span_end_ms,
        exit_ctx,
    )
    return daily["drift_free"], excluded


def _sum_books(books: list[pd.DataFrame]) -> pd.DataFrame:
    """Sum fold books by day. An empty list gives an empty frame."""
    if books:
        return pd.concat(books).groupby("day_start").sum()
    empty = pd.DataFrame(columns=["drift_free", "fees", "slippage"])
    empty.index.name = "day_start"
    return empty


def stress_metrics(
    folds: Sequence[FoldRecord],
    drift_free: pd.DataFrame,
    span_start_ms: int,
    span_end_ms: int,
    profile: str = DEFAULT_FEE_PROFILE,
) -> dict[str, float | int]:
    """Lock item 6 stresses on the walk-forward span, from the fold books.

    - stress_cost: fees x BAR["stress_fee_mult"] and slippage x BAR["stress_slippage_mult"], one joint stress;
    - stress_fee and stress_slippage: the same two stresses one at a time (descriptive);
    - stress_maker_as_taker: every maker fill (entry or exit) of a tranche that entered the book is repriced
      as taker and the netted costs are recomputed (a relabelled leg can net against a taker leg), the extra
      cost being the difference on each day.
    """
    fee_extra_mult = float(BAR["stress_fee_mult"]) - 1.0
    slip_extra_mult = float(BAR["stress_slippage_mult"]) - 1.0

    combined = _sum_books([f.book for f in folds if len(f.book)])
    fees = daily_series(combined, "fees", span_start_ms=span_start_ms, span_end_ms=span_end_ms)["fees"]
    slippage = daily_series(combined, "slippage", span_start_ms=span_start_ms, span_end_ms=span_end_ms)["slippage"]
    base = drift_free["drift_free"]

    stress_cost = base - fee_extra_mult * fees - slip_extra_mult * slippage
    stress_fee = base - fee_extra_mult * fees
    stress_slip = base - slip_extra_mult * slippage

    # Maker-as-taker: over the run's one netting set (the non-excluded tranches of all folds, as walk_forward charges
    # them), recompute the netted costs with every maker leg relabelled taker so it can merge with taker legs at the
    # same instant. The extra cost on a day is the relabelled netted total minus the netted total (negative when the
    # merge saves cost).
    extra: dict[int, float] = {}
    n_maker_fills = 0
    kept = []
    for fold in folds:
        for t in fold.tranches:
            beta = fold.betas.get(t.symbol, float("nan"))
            if beta is None or np.isnan(beta):
                continue  # excluded from the book, so it carries no fill
            kept.append(t)
            n_maker_fills += int(t.entry_fill == "maker") + int(t.exit_fill == "maker")
    if kept:
        base_day = netted_costs(kept, profile).by_day
        taker_day = netted_costs(kept, profile, maker_as_taker=True).by_day
        diff = (taker_day["fees"] + taker_day["slippage"]).sub(base_day["fees"] + base_day["slippage"], fill_value=0.0)
        for day, val in diff.items():
            extra[int(day)] = float(val)
    extra_series = pd.Series(extra, dtype=np.float64).reindex(base.index).fillna(0.0)
    stress_maker = base - extra_series

    return {
        "stress_cost": float(stress_cost.mean()),
        "stress_fee": float(stress_fee.mean()),
        "stress_slippage": float(stress_slip.mean()),
        "stress_maker_as_taker": float(stress_maker.mean()),
        "n_maker_fills": n_maker_fills,
    }


def coin_daily_drift_free(
    folds: Sequence[FoldRecord],
    symbol: str,
    five_min: dict[str, pd.DataFrame],
    settlements: Any,
    universe: Sequence[str],
    span_start_ms: int,
    span_end_ms: int,
) -> pd.Series | None:
    """Drift-free daily series of one coin's tranches alone, each fold priced with its own fold betas.

    None when the coin has no tranche at all (no fabricated zero).
    """
    frames: list[pd.DataFrame] = []
    for fold in folds:
        coin_tr = [t for t in fold.tranches if t.symbol == symbol]
        if coin_tr:
            frames.append(beta_hedged_daily(coin_tr, five_min, settlements, betas=fold.betas, universe=universe))
    if not frames:
        return None
    combined = _sum_books(frames)
    return daily_series(combined, "drift_free", span_start_ms=span_start_ms, span_end_ms=span_end_ms)["drift_free"]


def folds_to_json(folds: Sequence[FoldRecord]) -> list[dict[str, Any]]:
    """Fold spans and betas as written to folds.json (NaN betas become null)."""
    out: list[dict[str, Any]] = []
    for f in folds:
        # Exposure of the fold's tranches. None (not zero) when the fold took no tranche.
        n_tr = len(f.tranches)
        long_share = float(sum(1 for t in f.tranches if t.side_val == 1) / n_tr) if n_tr else None
        net_exposure = float(np.mean([t.weight for t in f.tranches])) if n_tr else None
        out.append(
            {
                "start_ms": int(f.start_ms),
                "end_ms": int(f.end_ms),
                "train_cut_ms": None if f.train_cut_ms is None else int(f.train_cut_ms),
                "betas": {k: (None if v is None or np.isnan(v) else float(v)) for k, v in f.betas.items()},
                "long_share": long_share,
                "net_exposure": net_exposure,
            }
        )
    return out


def config_hash_of(raw_config: dict[str, Any]) -> str:
    """sha256 hex of the config without its id, as canonical JSON."""
    body = {k: v for k, v in raw_config.items() if k != "id"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


_ALLOWED_KINDS = ("trial", "control", "retest")
_SHA_RE = re.compile(r"[0-9a-fA-F]{7,40}")


def source_digest(package_dir: Path | str | None = None) -> str:
    """sha256 over the sorted (relative path, file sha256) pairs of every .py file in the r4 package directory."""
    root = Path(package_dir) if package_dir is not None else Path(__file__).resolve().parent
    entries = [
        [p.relative_to(root).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest()] for p in sorted(root.rglob("*.py"))
    ]
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode("utf-8")).hexdigest()


REQUIREMENTS_LOCK = Path(__file__).resolve().parents[1] / "requirements.lock"
_VERSION_PACKAGES: tuple[tuple[str, str], ...] = (
    ("numpy", "numpy"),
    ("pandas", "pandas"),
    ("scipy", "scipy"),
    ("scikit-learn", "scikit-learn"),
    ("lightgbm", "lightgbm"),
    ("pyarrow", "pyarrow"),
)


def reproduction_inputs() -> dict[str, Any]:
    """What a receipt needs to reproduce a run: the r4 source digest, the requirements lock hash and library versions.

    requirements_lock_sha256 is None when the lock file is absent (recorded, not an error). A library that is not
    installed has version None.
    """
    import platform
    from importlib import metadata

    versions: dict[str, str | None] = {"python": platform.python_version()}
    for key, dist in _VERSION_PACKAGES:
        try:
            versions[key] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            versions[key] = None
    lock_sha = hashlib.sha256(REQUIREMENTS_LOCK.read_bytes()).hexdigest() if REQUIREMENTS_LOCK.is_file() else None
    return {"source_sha256": source_digest(), "requirements_lock_sha256": lock_sha, "versions": versions}


def resolve_commit(commit: str | None) -> str:
    """The commit argument, else the R4_COMMIT env var, as a 7 to 40 character hex sha. Never 'unknown'."""
    sha = commit if commit else os.environ.get("R4_COMMIT", "")
    if not _SHA_RE.fullmatch(sha or ""):
        raise ValueError("A commit sha (7 to 40 hex characters) is required: pass commit or set R4_COMMIT")
    return sha


def run_wf(
    config_file: Path | str,
    ds_dir: Path | str,
    out_dir: Path | str,
    cache_dir: Path | str | None = None,
    commit: str | None = None,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
) -> dict[str, Any]:
    """Execute walk-forward, CPCV, and stress tests for a configuration."""
    t_start = time.perf_counter()

    cfg_path = Path(config_file)
    raw_config = json.loads(cfg_path.read_text(encoding="utf-8"))
    run_id = str(raw_config["id"])
    kind = raw_config.get("kind")
    if not isinstance(kind, str) or kind not in _ALLOWED_KINDS:
        raise ValueError(f"Config key kind must be one of {_ALLOWED_KINDS}, got {kind!r}")
    commit_sha = resolve_commit(commit)
    if "first_refit_ms" not in raw_config:
        raise ValueError("Config has no first_refit_ms")
    first_refit_ms = int(raw_config["first_refit_ms"])

    cfg = RunConfig(
        family=raw_config["family"],
        model=raw_config["model"],
        params=raw_config.get("params", {}),
        features=tuple(raw_config["features"]),
        interval=raw_config["interval"],
        h_ms=int(raw_config["h_ms"]),
        label=raw_config.get("label", "fixed"),
        side_rule=raw_config.get("side_rule", "sign" if raw_config["model"] == "ridge" else "prob"),
        threshold=float(raw_config["threshold"]),
        size_rule=raw_config.get("size_rule", "unit"),
        lookback_months=raw_config.get("lookback_months"),
        refit=raw_config.get("refit", "monthly"),
        exit=parse_exit(raw_config.get("exit", "horizon")),
        seed=int(raw_config.get("seed", 7)),
        book=raw_config.get("book", "slot"),
        noise_seed=raw_config.get("noise_seed"),
        plant=raw_config.get("plant"),
    )

    ds_path = Path(ds_dir)
    manifest = read_manifest(ds_path)
    dataset_hash = str(manifest["datasetHash"])
    symbols_to_load = list(manifest["symbols"]) if manifest.get("symbols") else list(UNIVERSE)

    if panel is None:
        panel = load_panel(ds_path, symbols_to_load, cache_dir=cache_dir)
    if cfg.plant is not None:
        panel = apply_plant(panel, cfg.plant)

    universe = list(panel.keys())
    five_min = {s: panel[s]["5m"] for s in universe}
    settlements = {s: panel[s].get("settlements", panel[s].get("funding")) for s in universe}

    funding_dropped = _count_funding_dropped(panel, cfg)
    samples, n_outside_d = restrict_to_d(decision_samples(panel, cfg))

    # 1. Walk-forward on D
    run_res = walk_forward(
        samples,
        cfg,
        first_refit_ms=first_refit_ms,
        end_ms=DEV_END,
        panel=panel,
    )

    # 2. Daily drift-free series metrics
    wf_drift_free = run_res.drift_free["drift_free"]
    wf_mean = float(wf_drift_free.mean())
    wf_sd = float(wf_drift_free.std(ddof=1)) if len(wf_drift_free) > 1 else 0.0
    wf_sharpe = per_period_sharpe(wf_drift_free.to_numpy(dtype=np.float64))
    n_days = len(run_res.drift_free)
    bet_days = int(run_res.drift_free["bet"].sum())

    # 3. Stress variants (lock item 6)
    stress = stress_metrics(run_res.folds, run_res.drift_free, first_refit_ms, DEV_END)

    # 4. CPCV paths on D
    all_ts: list[int] = []
    for df in five_min.values():
        if not df.empty and "t" in df.columns:
            all_ts.append(int(df["t"].min()))
            all_ts.append(int(df["t"].max()))
    if all_ts:
        min_d = (min(all_ts) // DAY_MS) * DAY_MS
        max_d = ((max(all_ts) // DAY_MS) + 1) * DAY_MS
    else:
        min_d = (first_refit_ms // DAY_MS) * DAY_MS
        max_d = ((DEV_END // DAY_MS) + 1) * DAY_MS
    days_seq = list(range(min_d, max_d + DAY_MS, DAY_MS))
    daily_ret = daily_close_log_returns(five_min, days_seq, universe)

    t0_arr = samples["t0"].to_numpy(dtype=np.int64)
    t1_arr = samples["t1_max"].to_numpy(dtype=np.int64)

    splits = list(
        panel_cpcv_splits(
            t0_arr,
            t1_arr,
            n_groups=CPCV_GROUPS,
            n_test_groups=CPCV_TEST_GROUPS,
            embargo_ms=CPCV_EMBARGO_MS,
        )
    )

    split_preds: list[np.ndarray] = []
    test_groups_by_split: list[list[np.ndarray]] = []
    split_betas: list[dict[str, float]] = []
    split_degenerate: list[int] = []
    # E4 and E5: one exit-model pair per split, fitted on that split's own training instants (the purge and embargo the
    # split applied to the entry model's training rows). None is the counted E1 fallback for a split below MIN_SAMPLES.
    exit_factory: ExitModelFactory | None = None
    split_exit_models: list[ModelInputs | None] | None = None
    if parse_exit(cfg.exit).rule in ("E4", "E5"):
        exit_factory = ExitModelFactory.from_config(panel, cfg)
        split_exit_models = []

    for train_idx, test_idx_list in splits:
        train_df = samples.iloc[train_idx]
        test_groups_by_split.append(test_idx_list)
        if cfg.book == "D":
            # The D book ranks the coins of each decision time together, so no time may span two groups.
            assert_whole_decision_times(test_idx_list, samples["T"].to_numpy())

        scaler = StandardScaler()
        x_train = scaler.fit_transform(train_df[list(cfg.features)])
        model = fit_side_model(cfg, x_train, train_df)
        split_degenerate.append(len(model.degenerate_fits))
        if exit_factory is not None and split_exit_models is not None:
            train_instants = np.unique(train_df["T"].to_numpy(dtype=np.int64))
            split_exit_models.append(
                exit_factory.fit(
                    None,
                    np.iinfo(np.int64).max,
                    select=lambda T, S, keep=train_instants: np.isin(T, keep),
                )
            )

        # Betas on the split's own training set (its training days), never on the test groups.
        train_days = sorted({(t // DAY_MS) * DAY_MS for t in train_df["t0"]})
        split_betas.append(estimate_betas(daily_ret.loc[daily_ret.index.isin(train_days)]))

        split_test_idx = np.concatenate(test_idx_list)
        test_df = samples.iloc[split_test_idx]
        x_test = scaler.transform(test_df[list(cfg.features)])
        split_preds.append(_get_decisions(model, x_test, cfg))

    path_ids = cpcv_path_ids(CPCV_GROUPS, CPCV_TEST_GROUPS)
    paths_predictions = cpcv_paths(split_preds, path_ids, test_groups_by_split)
    layout = cpcv_path_layout(path_ids, CPCV_GROUPS, CPCV_TEST_GROUPS)

    if not samples.empty:
        cpcv_span_start = (int(samples["t0"].min()) // DAY_MS) * DAY_MS
        cpcv_span_end = ((int(samples["t1_max"].max()) // DAY_MS) + 1) * DAY_MS
    else:
        cpcv_span_start = min_d
        cpcv_span_end = max_d

    cpcv_path_means: list[float] = []
    cpcv_path_gross_means: list[float] = []
    cpcv_excluded: list[int] = []
    cpcv_exit_ctx = (
        None
        if is_horizon(cfg.exit)
        else ExitContext(five_min, cfg.h_ms, premium=_panel_premium(panel), settlements=settlements)
    )
    for p in range(paths_predictions.shape[0]):
        p_daily, p_excluded = cpcv_path_daily(
            p,
            paths_predictions[p],
            samples,
            test_groups_by_split,
            layout,
            split_betas,
            cfg,
            five_min,
            settlements,
            universe,
            cpcv_span_start,
            cpcv_span_end,
            cpcv_exit_ctx,
            split_exit_models,
        )
        cpcv_path_means.append(float(p_daily["drift_free"].mean()))
        cpcv_path_gross_means.append(float(p_daily["gross_hedged_funding"].mean()))
        cpcv_excluded.append(p_excluded)

    # 5. Per-coin means and the drop-one-coin jackknife, from the fold tranches and fold betas
    coin_means: dict[str, float | None] = {}
    jackknife_means: dict[str, float] = {}
    for sym in UNIVERSE:
        coin_series = coin_daily_drift_free(
            run_res.folds, sym, five_min, settlements, universe, first_refit_ms, DEV_END
        )
        if coin_series is None:
            coin_means[sym] = None
            jackknife_means[sym] = wf_mean  # the book without a coin that never traded is the whole book
        else:
            coin_means[sym] = float(coin_series.mean())
            jackknife_means[sym] = float((wf_drift_free - coin_series).mean())

    runtime_s = round(time.perf_counter() - t_start, 3)

    # 7. Write outputs
    run_out_dir = Path(out_dir) / run_id
    run_out_dir.mkdir(parents=True, exist_ok=True)

    daily_df = run_res.drift_free.copy()
    daily_df.index.name = "day_start"
    combined_book = _sum_books([f.book for f in run_res.folds if len(f.book)])
    for col in ("gross_hedged", "costs", "fees", "slippage", "funding"):
        daily_df[col] = daily_series(combined_book, col, span_start_ms=first_refit_ms, span_end_ms=DEV_END)[col]
    daily_df.to_parquet(run_out_dir / "daily.parquet")

    if run_res.tranches:
        tranches_df = pd.DataFrame([asdict(t) for t in run_res.tranches])
    else:
        tranches_df = pd.DataFrame(
            columns=[
                "symbol",
                "side",
                "entry_ms",
                "exit_ms",
                "entry_price",
                "exit_price",
                "interval",
                "h_ms",
                "size",
                "entry_fill",
                "exit_fill",
                "exit_reason",
                "entry_reason",
                "weight_override",
                "fee_profile",
                "slippage_bps_override",
            ]
        )
    tranches_df.to_parquet(run_out_dir / "tranches.parquet", index=False)

    (run_out_dir / "folds.json").write_text(json.dumps(folds_to_json(run_res.folds), indent=2), encoding="utf-8")

    receipt = {
        "kind": kind,
        "commit": commit_sha,
        **reproduction_inputs(),
        "dataset_hash": dataset_hash,
        "config_hash": config_hash_of(raw_config),
        "config": raw_config,
        "metrics": {
            "wf_mean": wf_mean,
            "wf_sd": wf_sd,
            "wf_sharpe": wf_sharpe,
            "n_days": n_days,
            "bet_days": bet_days,
            "cpcv_path_means": cpcv_path_means,
            "cpcv_path_gross_means": cpcv_path_gross_means,
            "cpcv_excluded_tranches": cpcv_excluded,
            "cpcv_degenerate_fits_per_split": split_degenerate,
            "cpcv_exit_model_fallback_splits": 0
            if split_exit_models is None
            else sum(m is None for m in split_exit_models),
            "coin_means": coin_means,
            "jackknife_means": jackknife_means,
            "stress_cost": stress["stress_cost"],
            "stress_fee": stress["stress_fee"],
            "stress_slippage": stress["stress_slippage"],
            "stress_maker_as_taker": stress["stress_maker_as_taker"],
            "n_maker_fills": stress["n_maker_fills"],
            "excluded_tranches": int(run_res.excluded_tranches),
            "exit_reason_counts": {k: int(v) for k, v in sorted(run_res.exit_reason_counts.items())},
            "missing_sigma_tranches": int(run_res.missing_sigma_tranches),
            "missing_flow_tranches": int(run_res.missing_flow_tranches),
            "missing_funding_tranches": int(run_res.missing_funding_tranches),
            "missing_model_tranches": int(run_res.missing_model_tranches),
            "exit_model_folds": int(run_res.exit_model_folds),
            "exit_model_fallback_folds": int(run_res.exit_model_fallback_folds),
            "exit_model_fallback_tranches": int(run_res.exit_model_fallback_tranches),
            "cpcv_missing_model": 0 if cpcv_exit_ctx is None else int(cpcv_exit_ctx.missing_model),
            "cpcv_missing_sigma": 0 if cpcv_exit_ctx is None else int(cpcv_exit_ctx.missing_sigma),
            "n_samples": int(run_res.n_samples),
            "n_decisions": int(((samples["T"] >= first_refit_ms) & (samples["T"] < DEV_END)).sum()),
            "n_tranches": len(run_res.tranches),
            "n_dropped": int(run_res.n_dropped),
            "n_outside_d": n_outside_d,
            "funding_dropped": int(funding_dropped),
        },
        "runtime_s": runtime_s,
    }
    if isinstance(panel, PlantedPanel):
        receipt["plant"] = {**panel.plant, "dropped_higher_bars": panel.dropped_total}

    (run_out_dir / "receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    return receipt


def run_tripwire(
    config_file: Path | str,
    ds_dir: Path | str,
    out_dir: Path | str,
    cache_dir: Path | str | None = None,
    commit: str | None = None,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
    shifts_days: Sequence[int] = SHIFT_DAYS,
) -> dict[str, Any]:
    """Run the label-shift tripwire (lock M item 4) for one configuration.

    Writes <out_dir>/<id>/tripwire.json (the family_report tripwire input, with "positive" and "n") and one
    non-trial receipt (kind "tripwire") per shift under <out_dir>/<id>/tripwire/shift_<days>/. It adds no trial and
    writes no receipt.json beside tripwire.json.
    """
    t_start = time.perf_counter()
    raw_config = json.loads(Path(config_file).read_text(encoding="utf-8"))
    run_id = str(raw_config["id"])
    commit_sha = resolve_commit(commit)
    if "first_refit_ms" not in raw_config:
        raise ValueError("Config has no first_refit_ms")
    first_refit_ms = int(raw_config["first_refit_ms"])
    cfg = RunConfig(
        family=raw_config["family"],
        model=raw_config["model"],
        params=raw_config.get("params", {}),
        features=tuple(raw_config["features"]),
        interval=raw_config["interval"],
        h_ms=int(raw_config["h_ms"]),
        label=raw_config.get("label", "fixed"),
        side_rule=raw_config.get("side_rule", "sign" if raw_config["model"] == "ridge" else "prob"),
        threshold=float(raw_config["threshold"]),
        size_rule=raw_config.get("size_rule", "unit"),
        lookback_months=raw_config.get("lookback_months"),
        refit=raw_config.get("refit", "monthly"),
        exit=parse_exit(raw_config.get("exit", "horizon")),
        seed=int(raw_config.get("seed", 7)),
        book=raw_config.get("book", "slot"),
        noise_seed=raw_config.get("noise_seed"),
        plant=raw_config.get("plant"),
    )
    ds_path = Path(ds_dir)
    manifest = read_manifest(ds_path)
    symbols_to_load = list(manifest["symbols"]) if manifest.get("symbols") else list(UNIVERSE)
    if panel is None:
        panel = load_panel(ds_path, symbols_to_load, cache_dir=cache_dir)
    if cfg.plant is not None:
        panel = apply_plant(panel, cfg.plant)
    samples, _ = restrict_to_d(decision_samples(panel, cfg))

    run_out = Path(out_dir) / run_id
    config_hash = config_hash_of(raw_config)
    repro = reproduction_inputs()

    def write_shift(entry: dict[str, Any], daily: pd.DataFrame | None) -> None:
        shift_dir = run_out / "tripwire" / f"shift_{entry['shift_days']:03d}"
        shift_dir.mkdir(parents=True, exist_ok=True)
        if daily is not None:
            daily.index.name = "day_start"
            daily.to_parquet(shift_dir / "daily.parquet")
        receipt = {
            "kind": "tripwire",
            "commit": commit_sha,
            **repro,
            "dataset_hash": str(manifest["datasetHash"]),
            "config_hash": config_hash,
            "config": raw_config,
            "shift_days": entry["shift_days"],
            "metrics": {k: v for k, v in entry.items() if k != "shift_days"},
        }
        (shift_dir / "receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")

    result = label_shift_tripwire(
        samples, cfg, first_refit_ms, DEV_END, panel, shifts_days=shifts_days, on_run=write_shift
    )
    result = {
        "kind": "tripwire",
        "commit": commit_sha,
        **repro,
        "dataset_hash": str(manifest["datasetHash"]),
        "config_hash": config_hash,
        "config_id": run_id,
        **result,
        "runtime_s": round(time.perf_counter() - t_start, 3),
    }
    run_out.mkdir(parents=True, exist_ok=True)
    (run_out / "tripwire.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def feature_check(
    ds_dir: Path | str,
    symbol: str,
    interval: str,
) -> pd.DataFrame:
    """Print per-feature NaN share, mean, sd, min, max over D for a symbol."""
    ds_path = Path(ds_dir)
    panel = load_panel(ds_path, [symbol, "BTCUSDT"])

    sym_data = panel[symbol]
    df_5m = sym_data["5m"]
    df_15m = sym_data["15m"]
    df_dec = sym_data[interval]
    df_4h = sym_data["4h"]
    df_1d = sym_data["1d"]
    df_prem = sym_data.get("premium_5m", sym_data.get("premiumIndex", pd.DataFrame()))
    df_settle = sym_data.get("settlements", sym_data.get("funding", pd.DataFrame()))
    btc_dec = panel["BTCUSDT"][interval]

    interval_ms = 3_600_000 if interval == "1h" else 14_400_000
    dec_opens = (
        df_dec["t"].to_numpy(dtype=np.int64)
        if not df_dec.empty and "t" in df_dec.columns
        else np.empty(0, dtype=np.int64)
    )

    feat_df = build_feature_frame(
        five_min=df_5m,
        fifteen_min=df_15m,
        decision_bars=df_dec,
        four_h=df_4h,
        one_d=df_1d,
        premium_5m=df_prem,
        settlements=df_settle,
        btc_decision_bars=btc_dec,
        decision_interval_ms=interval_ms,
        decision_opens=dec_opens,
    )

    # Filter over D: [DEV_START, DEV_END)
    mask = (feat_df.index >= DEV_START) & (feat_df.index < DEV_END)
    df_d = feat_df.loc[mask]

    records = []
    print(f"\nFeature check for {symbol} ({interval}) over D:")
    header = f"{'Feature':<20} {'NaN%':<8} {'Mean':<12} {'SD':<12} {'Min':<12} {'Max':<12}"
    print(header)
    print("-" * len(header))

    for col in ALL_FEATURE_COLUMNS:
        if col in df_d.columns:
            s = df_d[col]
            nan_share = float(s.isna().mean())
            s_valid = s.dropna()
            if len(s_valid) > 0:
                mean_val = float(s_valid.mean())
                sd_val = float(s_valid.std(ddof=1)) if len(s_valid) > 1 else 0.0
                min_val = float(s_valid.min())
                max_val = float(s_valid.max())
            else:
                mean_val = float("nan")
                sd_val = float("nan")
                min_val = float("nan")
                max_val = float("nan")
        else:
            nan_share = 1.0
            mean_val = float("nan")
            sd_val = float("nan")
            min_val = float("nan")
            max_val = float("nan")

        records.append(
            {
                "feature": col,
                "nan_share": nan_share,
                "mean": mean_val,
                "sd": sd_val,
                "min": min_val,
                "max": max_val,
            }
        )
        print(f"{col:<20} {nan_share * 100:>6.2f}% {mean_val:>12.5f} {sd_val:>12.5f} {min_val:>12.5f} {max_val:>12.5f}")

    return pd.DataFrame(records)


def main() -> None:
    """CLI entry point for r4.cli."""
    parser = argparse.ArgumentParser(description="r4 research CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # run-wf
    wf_parser = subparsers.add_parser("run-wf", help="Run walk-forward, CPCV, and stress")
    wf_parser.add_argument("--config", required=True, help="Path to config JSON file")
    wf_parser.add_argument("--ds", required=True, help="Dataset directory")
    wf_parser.add_argument("--out", required=True, help="Output directory")
    wf_parser.add_argument("--cache", required=False, default=None, help="Cache directory")
    wf_parser.add_argument("--commit", required=False, default=None, help="Commit SHA")

    # bar
    bar_parser = subparsers.add_parser("bar", help="Write family exploration bar report")
    bar_parser.add_argument("--family", required=True, help="Family name (e.g. A)")
    bar_parser.add_argument("--runs", required=True, help="Runs directory for family")
    bar_parser.add_argument("--round-runs", required=True, help="All round runs directory")
    bar_parser.add_argument("--ledger-count", required=True, type=int, help="Ledger count N")
    bar_parser.add_argument("--ds", required=True, help="Dataset directory")
    bar_parser.add_argument("--out", required=True, help="Output report JSON file")
    bar_parser.add_argument("--seed", required=False, type=int, default=7, help="Random seed")
    bar_parser.add_argument(
        "--family-index",
        required=False,
        type=int,
        default=0,
        help="Index of the family in the program (the SPA seed is 6,000,000 + this index)",
    )
    bar_parser.add_argument(
        "--tripwire",
        required=False,
        default=None,
        help='JSON file {"positive": int, "n": int} from the label-shift re-runs',
    )

    # feature-check
    fc_parser = subparsers.add_parser("feature-check", help="Check feature statistics over D")
    fc_parser.add_argument("--ds", required=True, help="Dataset directory")
    fc_parser.add_argument("--symbol", required=True, help="Symbol name (e.g. BTCUSDT)")
    fc_parser.add_argument("--interval", required=True, choices=["1h", "4h"], help="Interval")

    tw_parser = subparsers.add_parser("tripwire", help="Run the label-shift tripwire (lock M item 4)")
    tw_parser.add_argument("--config", required=True, help="Path to config JSON file")
    tw_parser.add_argument("--ds", required=True, help="Dataset directory")
    tw_parser.add_argument("--out", required=True, help="Output directory (never a round directory)")
    tw_parser.add_argument("--cache", required=False, default=None, help="Cache directory")
    tw_parser.add_argument("--commit", required=False, default=None, help="Commit SHA")
    tw_parser.add_argument(
        "--shifts", required=False, type=int, default=len(SHIFT_DAYS), help="First N of the 100 locked shifts"
    )

    acct_parser = subparsers.add_parser("account", help="Write the $100-account report (report only)")
    acct_parser.add_argument("--run", required=True, help="Run directory holding tranches.parquet")
    acct_parser.add_argument("--ds", required=True, help="Dataset directory")

    rt_parser = subparsers.add_parser("retest", help="Evaluate a native export as a labelled re-test")
    rt_parser.add_argument("--export", required=True, help="Native export directory (tranches.jsonl, summary.json)")
    rt_parser.add_argument("--ds", required=True, help="Dataset directory")
    rt_parser.add_argument("--calib-v", required=True, type=float, help="Within-cell variance of trial Sharpes")
    rt_parser.add_argument("--out", required=True, help="Output directory (receipt at OUT/<rule>/receipt.json)")
    rt_parser.add_argument("--commit", required=False, default=None, help="Commit SHA")

    cg_parser = subparsers.add_parser("calib-grid", help="Write the registered calibration configs (noise, exit, pc)")
    cg_parser.add_argument("--out", required=True, help="Output directory (noise/, exit/ and pc/ inside)")
    cg_parser.add_argument(
        "--amplitude",
        required=False,
        type=float,
        default=0.0,
        help="Planted amplitude of the pc template (0.0 = template)",
    )

    cd_parser = subparsers.add_parser("calib-dcov", help="D's daily log-return covariance and betas (second moments)")
    cd_parser.add_argument("--ds", required=True, help="Dataset directory")
    cd_parser.add_argument("--out", required=True, help="Output JSON file")

    cn_parser = subparsers.add_parser("calib-null-input", help="Write the daily-null simulator input from a dcov file")
    cn_parser.add_argument("--dcov", required=True, help="JSON from calib-dcov")
    cn_parser.add_argument("--out", required=True, help="Output JSON file for r4.calibration_null --input")
    cn_parser.add_argument("--pilot-paths", required=False, type=int, default=5000, help="Pilot paths (default 5000)")

    ce_parser = subparsers.add_parser("calib-noise-eval", help="Evaluate the noise controls against M's bounds")
    ce_parser.add_argument("--runs", required=True, help="Directory of the noise control runs")
    ce_parser.add_argument("--ds", required=True, help="Dataset directory")
    ce_parser.add_argument("--out", required=True, help="Output JSON file")
    ce_parser.add_argument(
        "--draws", required=False, type=int, default=None, help="Joint-shift draws (default: M's 1000)"
    )

    cp_parser = subparsers.add_parser(
        "calib-power", help="Power simulation: P1 and decoys on synthetic D-shaped panels"
    )
    cp_parser.add_argument("--dcov", required=True, help="JSON from calib-dcov")
    cp_parser.add_argument("--out", required=True, help="Power directory (a<amplitude>/r<replicate>/ inside)")
    cp_parser.add_argument("--commit", required=True, help="Commit SHA")
    cp_parser.add_argument("--amplitudes", required=True, help="Comma-separated registered amplitude grid")
    cp_parser.add_argument("--replicates", required=False, type=int, default=40, help="Replicates (default 40)")
    cp_parser.add_argument("--start-ms", required=False, type=int, default=None, help="Panel start (default DEV_START)")
    cp_parser.add_argument("--end-ms", required=False, type=int, default=None, help="Panel end (default DEV_END)")
    cp_parser.add_argument(
        "--first-refit-ms", required=False, type=int, default=None, help="First refit (default 2023)"
    )
    cp_parser.add_argument("--stop-v", required=False, type=float, default=None, help="Adaptive walk at this variance")

    cc_parser = subparsers.add_parser("calib-power-curve", help="Recompute the power curve at a variance, choose a*")
    cc_parser.add_argument("--power-dir", required=True, help="Directory from calib-power")
    cc_parser.add_argument("--v", required=True, type=float, help="D within-cell V (the margin is applied here)")
    cc_parser.add_argument("--out", required=True, help="Output JSON file")
    cc_parser.add_argument("--margin", required=False, type=float, default=1.2, help="V multiplier (default 1.2)")
    cc_parser.add_argument("--draws", required=False, type=int, default=200, help="Joint-shift draws (default 200)")
    cc_parser.add_argument("--extend", action="store_true", help="Extend the grid by doubling (runs simulations)")
    cc_parser.add_argument("--commit", required=False, default=None, help="Commit SHA (needed with --extend)")

    cpos_parser = subparsers.add_parser("calib-positive", help="Run and evaluate the planted positive control on D")
    cpos_parser.add_argument("--ds", required=True, help="Dataset directory")
    cpos_parser.add_argument("--noise-runs", required=True, help="Noise control runs (their V is used)")
    cpos_parser.add_argument("--out", required=True, help="Output directory")
    cpos_parser.add_argument("--commit", required=True, help="Commit SHA")
    cpos_parser.add_argument("--a-star", required=False, type=float, default=None, help="Planted amplitude")
    cpos_parser.add_argument("--power", required=False, default=None, help="calib-power-curve JSON (reads a_star)")
    cpos_parser.add_argument("--audited", action="store_true", help="A code audit found nothing (needed after a miss)")
    cpos_parser.add_argument("--rerun", action="store_true", help="Use the registered re-run plant and decoy seeds")
    cpos_parser.add_argument("--tripwire-shifts", required=False, type=int, default=len(SHIFT_DAYS), help="Shifts")

    cdo_parser = subparsers.add_parser("calib-dossier", help="Write the Phase 4 dossier once (exclusive create)")
    cdo_parser.add_argument("--out", required=True, help="Output JSON file (must not exist)")
    cdo_parser.add_argument("--null", required=True, help="Daily null simulation JSON")
    cdo_parser.add_argument("--noise", required=True, help="calib-noise-eval JSON")
    cdo_parser.add_argument("--power", required=True, help="calib-power-curve JSON")
    cdo_parser.add_argument("--positive", required=True, help="Positive control JSON")
    cdo_parser.add_argument("--spa", required=True, help="Re-test family SPA JSON")
    cdo_parser.add_argument("--retests", required=True, nargs="+", help="The 6 re-test receipts")
    cdo_parser.add_argument("--commit-order", required=True, help="Commit-order evidence JSON (computed outside)")
    cdo_parser.add_argument("--exit-block", required=False, default=None, help="Exit block result JSON, when run")

    args = parser.parse_args()

    if args.command == "calib-grid":
        from r4 import calibration

        out_root = Path(args.out)
        groups = {
            "noise": calibration.noise_grid(),
            "exit": calibration.exit_block(),
            "pc": calibration.pc_family(args.amplitude),
        }
        for sub, configs in groups.items():
            (out_root / sub).mkdir(parents=True, exist_ok=True)
            for c in configs:
                (out_root / sub / f"{c['id']}.json").write_text(json.dumps(c, indent=2), encoding="utf-8")
        print(f"Wrote {sum(len(v) for v in groups.values())} configs under {out_root}")
    elif args.command == "calib-dcov":
        from r4 import calibration

        dcov = calibration.d_daily_covariance(args.ds)
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(dcov, indent=2), encoding="utf-8")
        print(f"D covariance written to {args.out} ({dcov['n_days']} days)")
    elif args.command == "calib-null-input":
        from r4 import calibration

        dcov = json.loads(Path(args.dcov).read_text(encoding="utf-8"))
        null_input = calibration.daily_null_input(dcov["cov"], dcov["betas"], pilot_paths=args.pilot_paths)
        null_input["dcov_dataset_hash"] = dcov.get("dataset_hash")
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(null_input, indent=2), encoding="utf-8")
        print(f"Daily null input written to {args.out} (scale {null_input['scale']:.6g})")
    elif args.command == "calib-noise-eval":
        from r4 import calibration

        report = calibration.evaluate_noise(args.runs, args.ds, joint_draws=args.draws)
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Noise evaluation written to {args.out}: gate_ok={report['gate_ok']}")
    elif args.command == "calib-power":
        from r4 import calibration

        dcov = json.loads(Path(args.dcov).read_text(encoding="utf-8"))
        extra: dict[str, Any] = {}
        if args.start_ms is not None:
            extra["start_ms"] = args.start_ms
        if args.end_ms is not None:
            extra["end_ms"] = args.end_ms
        if args.first_refit_ms is not None:
            extra["first_refit_ms"] = args.first_refit_ms
        summary = calibration.power_simulation(
            dcov,
            args.out,
            [float(x) for x in args.amplitudes.split(",")],
            n_replicates=args.replicates,
            commit=args.commit,
            stop_v=args.stop_v,
            **extra,
        )
        (Path(args.out) / "power_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(f"Power simulation written to {args.out}: order {summary['order']} in {summary['runtime_s']} s")
    elif args.command == "calib-power-curve":
        from r4 import calibration

        v_margin = args.v * args.margin

        def curve_json(curve: dict[float, dict[str, Any]]) -> dict[str, Any]:
            return {repr(a): e for a, e in sorted(curve.items())}

        curve = calibration.power_curve(args.power_dir, v_margin, joint_draws=args.draws)

        def extend_one(a: float) -> dict[str, Any]:
            calibration.extend_amplitude(args.power_dir, a, commit=args.commit)
            return calibration.power_curve(args.power_dir, v_margin, joint_draws=args.draws)[a]

        if args.extend and not args.commit:
            raise SystemExit("--extend needs --commit")
        chosen = calibration.choose_a_star(curve, extend=extend_one if args.extend else None)
        result = {
            "v": args.v,
            "margin": args.margin,
            "v_margin": v_margin,
            "joint_draws": args.draws,
            "n_trials": 120,
            "curve_at_1_2v": curve_json(chosen["curve"]),
            "a_star": {k: chosen[k] for k in ("a_star", "infeasible", "extensions")},
            "disclosed": "tripwire and SPA are skipped in the power simulation; P2 is omitted",
        }
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"Power curve written to {args.out}: a*={chosen['a_star']} infeasible={chosen['infeasible']}")
    elif args.command == "calib-positive":
        from r4 import calibration

        a_star = args.a_star
        if a_star is None:
            if not args.power:
                raise SystemExit("pass --a-star or --power")
            power_doc = json.loads(Path(args.power).read_text(encoding="utf-8"))
            a_star = power_doc["a_star"]["a_star"]
            if a_star is None:
                raise SystemExit("the power result is infeasible: there is no a* to plant")
        if not 1 <= args.tripwire_shifts <= len(SHIFT_DAYS):
            raise SystemExit(f"--tripwire-shifts must be between 1 and {len(SHIFT_DAYS)}")
        res = calibration.positive_control(
            args.ds,
            float(a_star),
            args.noise_runs,
            args.out,
            commit=args.commit,
            tripwire_shifts=SHIFT_DAYS[: args.tripwire_shifts],
            rerun=args.rerun,
            audited=args.audited,
        )
        print(f"Positive control written to {args.out}: detected={res['detected']} by {res['detected_by']}")
    elif args.command == "calib-dossier":
        from r4 import calibration

        order = json.loads(Path(args.commit_order).read_text(encoding="utf-8"))
        doc = calibration.write_dossier(
            args.out,
            null_simulation=args.null,
            noise_eval=args.noise,
            power=args.power,
            positive_control=args.positive,
            family_spa=args.spa,
            retests=args.retests,
            commit_order=order,
            exit_block=args.exit_block,
        )
        print(f"Dossier written to {args.out}: gate_p_ready={doc['gate_p_ready']} (evidence only)")
    elif args.command == "run-wf":
        receipt = run_wf(
            config_file=args.config,
            ds_dir=args.ds,
            out_dir=args.out,
            cache_dir=args.cache,
            commit=args.commit,
        )
        print(f"Receipt written for run {receipt['config'].get('id', 'unknown')}")
    elif args.command == "bar":
        tripwire_input = None
        if args.tripwire is not None:
            tripwire_input = json.loads(Path(args.tripwire).read_text(encoding="utf-8"))
        family_report(
            family=args.family,
            runs_dir=args.runs,
            round_runs_dir=args.round_runs,
            ledger_count=args.ledger_count,
            ds_dir=args.ds,
            out_file=args.out,
            seed=args.seed,
            tripwire=tripwire_input,
            family_index=args.family_index,
        )
        print(f"Family report written to {args.out}")
    elif args.command == "tripwire":
        if not 1 <= args.shifts <= len(SHIFT_DAYS):
            raise SystemExit(f"--shifts must be between 1 and {len(SHIFT_DAYS)}")
        tw_result = run_tripwire(
            config_file=args.config,
            ds_dir=args.ds,
            out_dir=args.out,
            cache_dir=args.cache,
            commit=args.commit,
            shifts_days=SHIFT_DAYS[: args.shifts],
        )
        print(f"Tripwire written: {tw_result['positive']} of {tw_result['n']} positive, halt={tw_result['halt']}")
    elif args.command == "retest":
        from r4.natives import run_retest

        receipt = run_retest(args.export, args.ds, args.calib_v, args.out, commit=args.commit)
        print(f"Retest receipt written for rule {receipt['rule']}: pass={receipt['pass']}")
    elif args.command == "account":
        from r4.account import account_report

        account_report(args.run, args.ds)
        print(f"Account report written to {Path(args.run) / 'account_100.json'}")
    elif args.command == "feature-check":
        feature_check(
            ds_dir=args.ds,
            symbol=args.symbol,
            interval=args.interval,
        )


if __name__ == "__main__":
    main()
