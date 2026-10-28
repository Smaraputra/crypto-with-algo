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
)
from r4.costs import DEFAULT_FEE_PROFILE, STUDY_SLIPPAGE_BPS, resolve_fee_profile
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
    _get_target,
    _make_model,
    _make_tranches,
    compute_missing_settlement_times,
    decision_samples,
    load_panel,
    walk_forward,
)
from r4.stats import per_period_sharpe
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
) -> tuple[pd.DataFrame, int]:
    """Daily series of one CPCV path (drift_free and gross_hedged_funding), and the NaN-beta exclusion count.

    For each test group g of the path, the tranches come from the split that tested g in this path and are
    priced with THAT split's betas (estimated on its training set). No averaging, no fallback.
    gross_hedged_funding is gross_hedged plus funding, with no costs.
    """
    frames: list[pd.DataFrame] = []
    for (p, _g), (s, j) in sorted(layout.items()):
        if p != path:
            continue
        idx = np.asarray(test_groups_by_split[s][j], dtype=int)
        if len(idx) == 0:
            continue
        tr = _make_tranches(samples.iloc[idx], path_sides[idx], cfg)
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
      as taker, adding abs(w) x (taker_fee - maker_fee + slippage_rate) on the fill's day.
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

    extra: dict[int, float] = {}
    n_maker_fills = 0
    for fold in folds:
        for t in fold.tranches:
            beta = fold.betas.get(t.symbol, float("nan"))
            if beta is None or np.isnan(beta):
                continue  # excluded from the book, so it carries no fill
            slip_bps = STUDY_SLIPPAGE_BPS.get(t.interval_str)
            if slip_bps is None:
                raise ValueError(f"No slippage configured for interval: {t.interval_str}")
            fee = resolve_fee_profile(profile, t.symbol)
            add = abs(t.weight) * (fee.taker_fee - fee.maker_fee + slip_bps / 10000.0)
            if t.entry_fill == "maker":
                day = (t.entry_ms // DAY_MS) * DAY_MS
                extra[day] = extra.get(day, 0.0) + add
                n_maker_fills += 1
            if t.exit_fill == "maker":
                day = ((t.exit_ms - 1) // DAY_MS) * DAY_MS
                extra[day] = extra.get(day, 0.0) + add
                n_maker_fills += 1
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
        exit=raw_config.get("exit", "horizon"),
        seed=int(raw_config.get("seed", 7)),
    )

    ds_path = Path(ds_dir)
    manifest = read_manifest(ds_path)
    dataset_hash = str(manifest["datasetHash"])
    symbols_to_load = list(manifest["symbols"]) if manifest.get("symbols") else list(UNIVERSE)

    if panel is None:
        panel = load_panel(ds_path, symbols_to_load, cache_dir=cache_dir)

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

    for train_idx, test_idx_list in splits:
        train_df = samples.iloc[train_idx]
        test_groups_by_split.append(test_idx_list)

        scaler = StandardScaler()
        x_train = scaler.fit_transform(train_df[list(cfg.features)])
        y_train = _get_target(train_df, cfg)
        model = _make_model(cfg)
        model.fit(x_train, y_train)

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
            ]
        )
    tranches_df.to_parquet(run_out_dir / "tranches.parquet", index=False)

    (run_out_dir / "folds.json").write_text(json.dumps(folds_to_json(run_res.folds), indent=2), encoding="utf-8")

    receipt = {
        "kind": kind,
        "commit": commit_sha,
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
            "coin_means": coin_means,
            "jackknife_means": jackknife_means,
            "stress_cost": stress["stress_cost"],
            "stress_fee": stress["stress_fee"],
            "stress_slippage": stress["stress_slippage"],
            "stress_maker_as_taker": stress["stress_maker_as_taker"],
            "n_maker_fills": stress["n_maker_fills"],
            "excluded_tranches": int(run_res.excluded_tranches),
            "n_samples": int(run_res.n_samples),
            "n_dropped": int(run_res.n_dropped),
            "n_outside_d": n_outside_d,
            "funding_dropped": int(funding_dropped),
        },
        "runtime_s": runtime_s,
    }

    (run_out_dir / "receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    return receipt


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

    args = parser.parse_args()

    if args.command == "run-wf":
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
        )
        print(f"Family report written to {args.out}")
    elif args.command == "feature-check":
        feature_check(
            ds_dir=args.ds,
            symbol=args.symbol,
            interval=args.interval,
        )


if __name__ == "__main__":
    main()
