"""Phase 4 calibration: the registered grids, the D covariance input and the noise-control evaluation.

Sources: calibration spec sections 3 to 5, 9 and 12 (section 12 wins), and the owner amendment of 2026-10-28 (the
trial-Sharpe variance V is pooled within cost cells, and calibration uses the same V as round close).

Everything here is a pure function of its inputs. noise_grid, exit_block and pc_family only build config dicts. The
evaluation reads finished run directories and calls the `r4.bar` functions, never a re-implementation.
"""

from __future__ import annotations

import copy
import dataclasses
import json
import math
import re
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4 import bar
from r4.book import DAY_MS
from r4.data import load_perp
from r4.method import BAR, DEV_END, DEV_START, UNIVERSE
from r4.stats import expected_max_sharpe, per_period_sharpe

H1_MS = 3_600_000
FIRST_REFIT_MS = int(datetime(2023, 1, 1, tzinfo=UTC).timestamp() * 1000)

# Cost cells of spec section 12 N2: interval and horizon.
CELLS: dict[str, tuple[str, int]] = {
    "C1": ("1h", 4 * H1_MS),
    "C2": ("1h", 8 * H1_MS),
    "C3": ("4h", 4 * H1_MS),
    "C4": ("4h", 8 * H1_MS),
    "C5": ("4h", 24 * H1_MS),
}

LGBM_PARAMS: dict[str, Any] = {
    "n_estimators": 200,
    "num_leaves": 15,
    "learning_rate": 0.05,
    "min_child_samples": 100,
    "subsample": 1.0,
    "colsample_bytree": 1.0,
}

NOISE_FEATURES: tuple[str, ...] = tuple(f"noise_{i:02d}" for i in range(20))
NOISE_SEED_BASE = 1_000_000
JOINT_SHIFT_SEED_BASE = 5_000_000
PC_JOINT_SHIFT_SEED_BASE = 5_100_000
EXIT_JOINT_SHIFT_SEED_BASE = 8_000_000
PC_DECOY_SEED_BASE = 2_000_001
PLANT_SEED = 20261028
NOISE_ALT_SEED_STEP = 100
N_TRIALS_CALIBRATION = 120

# (block, model, label, cells, threshold or margin m, lookback months, refit, book)
_BLOCKS: tuple[tuple[str, str, str, tuple[str, ...], float, int | None, str, str], ...] = (
    ("ridge", "ridge", "fixed", ("C1", "C2", "C3", "C4", "C5"), 0, 12, "monthly", "slot"),
    ("lgbm", "lightgbm", "fixed", ("C1", "C2", "C3", "C4", "C5"), 0.02, 24, "monthly", "slot"),
    ("lgbmtb", "lightgbm", "triple_barrier", ("C3", "C4", "C5"), 0.02, 24, "monthly", "slot"),
    ("logit", "logistic", "fixed", ("C2", "C4"), 0.05, None, "monthly", "slot"),
    ("noref", "ridge", "fixed", ("C2", "C4"), 0, None, "none", "slot"),
    ("d", "ridge", "fixed", ("C2", "C4", "C5"), 0, 12, "monthly", "D"),
)
_BLOCK_PARAMS: dict[str, dict[str, Any]] = {
    "ridge": {"alpha": 1.0},
    "lgbm": LGBM_PARAMS,
    "lgbmtb": LGBM_PARAMS,
    "logit": {"C": 1.0},
    "noref": {"alpha": 1.0},
    "d": {"alpha": 1.0},
}
SEEDS_PER_CELL = 2

# The 10 price-only features of the positive control's P2 (see pc_family). Five intrabar shape features of the
# decision window (volatility, close location, run-up, drawdown, 15m RSI) and five slower price features (lagged
# 1, 4 and 24 bar returns, 24 bar volatility, 4h trend). All come from OHLC only, so the plant (which moves only
# prices) reaches them, and none needs Tier B data, volume, taker flow, premium index or funding (which the plant
# leaves untouched), another coin, or the calendar.
P2_PRICE_FEATURES: tuple[str, ...] = (
    "rv5",
    "close_loc",
    "runup",
    "drawdown",
    "rsi7_15m",
    "ret_1",
    "ret_4",
    "ret_24",
    "vol_24",
    "trend_4h",
)

# The E5 exit spec must match whatever the E5 task commits (spec: p_close 0.35, confirm_bars 3; fallback 0.30 / 6).
EXIT_BLOCK_SPECS: tuple[Any, ...] = (
    {"rule": "E2", "k": 1.0},
    {"rule": "E3", "k": 2.0},
    {"rule": "E4", "margin_se": 1.0},
    {"rule": "E5", "p_close": 0.35, "confirm_bars": 3},
    {"rule": "E6", "flow_bars": 12, "flow_lookback_days": 30, "flow_z": 2.0, "funding_threshold": 0.0005},
    {"rule": "X1", "n_bars": 3},
)


def _prediction(status: str, text: str) -> dict[str, str]:
    return {"status": status, "text": text}


# Every registered prediction. "gated" ones decide Gate P (spec section 12 N9), the rest are diagnostics whose miss
# triggers a review, not a rejection.
PREDICTIONS: dict[str, dict[str, str]] = {
    "noise_items123_at_most_5": _prediction("gated", "At most 5 of the 40 noise controls pass items 1 to 3 (M bound)."),
    "noise_items123_zero_of_40": _prediction(
        "gated", "0 of the 40 noise controls pass items 1 to 3 (costs make it so)."
    ),
    "noise_joint_shift_at_most_6": _prediction(
        "gated", "At most 6 of the 40 reject the joint-shift null at 0.05 (1,000 draws each, M bound)."
    ),
    "positive_detected_at_astar": _prediction(
        "gated", "The planted control is detected (items 1 to 6) at the amplitude a*."
    ),
    "natives_all_six_fail": _prediction("gated", "All 6 native re-tests fail."),
    "daily_null_crossing_rate_at_most_1_over_600": _prediction(
        "gated", "The daily null's false-crossing rate is at most 1/600."
    ),
    "exit_block_at_most_1_of_6_rejects": _prediction(
        "gated", "At most 1 of the 6 exit controls rejects its random-entry-same-exit null at p < 0.05."
    ),
    "noise_family_pbo_net_below_0_1": _prediction("diagnostic", "Family PBO (net) of the 40 is below 0.1."),
    "noise_cost_free_items123_0_to_2": _prediction(
        "diagnostic", "0 to 2 of 40 pass items 1 to 3 on the cost-free series (gross hedged plus funding)."
    ),
    "noise_within_seed_group_pbo_median_0_3_to_0_7": _prediction(
        "diagnostic", "The median PBO within seed groups on the cost-free series is between 0.3 and 0.7."
    ),
    "noise_joint_shift_reference_panels": _prediction(
        "diagnostic", "The joint-shift rejection count sits inside the empirical count of 2 synthetic D-shaped panels."
    ),
    "daily_null_at_most_10_crossings": _prediction(
        "diagnostic", "At most 10 crossings in 50,000 daily-null paths (Wilson lower bound not above 1/600)."
    ),
    "exit_median_hold_at_least_80pct": _prediction(
        "diagnostic", "On synthetic no-edge panels the median hold under E4, E5 and E6 is at least 80% of h."
    ),
    "exit_planted_intrabar_control": _prediction(
        "diagnostic",
        "On the planted reversal E4, E5 and E6 beat E1 on planted tranches, close ahead of the drop on at least 80% "
        "of them, and falsely close at most 20% of unplanted tranches.",
    ),
    "exit_optional_stopping_zero_mean": _prediction(
        "gated",
        "On 20 zero-drift synthetic panels of 75 days no exit's cost-free mean per tranche differs from zero "
        "(two-sided 0.01), and X1's is not positive. E4 and E5 fit on each panel's own real features, at the "
        "registered and loosened thresholds.",
    ),
}


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------


def noise_grid() -> list[dict[str, Any]]:
    """The 40 registered noise controls (spec section 12 N2), in a fixed order with index 0 to 39."""
    grid: list[dict[str, Any]] = []
    for block, model, label, cells, thr, lookback, refit, book in _BLOCKS:
        for cell in cells:
            interval, h_ms = CELLS[cell]
            for ordinal in range(1, SEEDS_PER_CELL + 1):
                i = len(grid)
                grid.append(
                    {
                        "id": f"noise_{i:02d}_{block}_{cell}_s{ordinal}",
                        "kind": "control",
                        "family": "noise",
                        "block": block,
                        "cell": cell,
                        "seed_ordinal": ordinal,
                        "model": model,
                        "params": copy.deepcopy(_BLOCK_PARAMS[block]),
                        "features": list(NOISE_FEATURES),
                        "interval": interval,
                        "h_ms": h_ms,
                        "label": label,
                        "side_rule": "sign" if model == "ridge" else "prob",
                        "threshold": thr,
                        "size_rule": "unit",
                        "lookback_months": lookback,
                        "refit": refit,
                        "exit": "horizon",
                        "seed": i,
                        "book": book,
                        "noise_seed": NOISE_SEED_BASE + i,
                        "joint_shift_seed": JOINT_SHIFT_SEED_BASE + i,
                        "first_refit_ms": FIRST_REFIT_MS,
                    }
                )
    return grid


# A1.9: the trade-floor outcome of the synthetic V panel (seed 3,999, calib-synth-v at 81e3c5b0). Registered
# before any D noise run. Every other noise control keeps its registered config.
NOISE_REPLACEMENTS: dict[str, int] = {
    "noise_26_logit_C2_s1": 2,
    "noise_27_logit_C2_s2": 2,
    "noise_28_logit_C4_s1": 2,
    "noise_29_logit_C4_s2": 2,
}


# A2.1: the registered trade-floor failures of the synthetic V panel. They stay in the noise set, items 1 to 3, the PBO,
# the joint-shift null and every report, and are left out of every calibration variance (V, 1.2 x V, SR0, total and
# cost-free).
NOISE_V_EXCLUDED: frozenset[str] = frozenset(
    {
        "noise_26_logit_C2_s1_alt2",
        "noise_27_logit_C2_s2_alt2",
        "noise_28_logit_C4_s1_alt2",
        "noise_29_logit_C4_s2_alt2",
    }
)


def _check_v_excluded(excluded: Collection[str]) -> None:
    ids = {c["id"] for c in noise_final_set()}
    for cid in sorted(excluded):
        if cid not in ids:
            raise ValueError(f"NOISE_V_EXCLUDED names {cid!r}, which is not a noise_final_set() id")


def noise_final_set() -> list[dict[str, Any]]:
    """noise_grid() in its order, with each NOISE_REPLACEMENTS id replaced by its registered alternative."""
    grid = noise_grid()
    ids = {c["id"] for c in grid}
    for cid, attempt in NOISE_REPLACEMENTS.items():
        if cid not in ids:
            raise ValueError(f"NOISE_REPLACEMENTS names {cid!r}, which is not a noise_grid() id")
        if attempt not in (1, 2) or isinstance(attempt, bool):
            raise ValueError(f"NOISE_REPLACEMENTS[{cid!r}] is {attempt!r}, only attempts 1 and 2 exist")
    return [noise_alternative(c, NOISE_REPLACEMENTS[c["id"]]) if c["id"] in NOISE_REPLACEMENTS else c for c in grid]


def noise_alternative(config: dict[str, Any], attempt: int) -> dict[str, Any]:
    """The pre-declared replacement of a noise control that fails the trade floor.

    Classifiers (a margin m > 0): attempt 1 halves m. Attempt 2 keeps the halved m and moves the noise seed by 100.
    A config with no margin (ridge, m = 0) has nothing to halve, so attempt 1 moves the seed by 100 and attempt 2 by
    200. The replacement records `replaces` (the original id) and `attempt`. Only attempts 1 and 2 exist.
    """
    if attempt not in (1, 2):
        raise ValueError(f"attempt must be 1 or 2, got {attempt!r}")
    alt = copy.deepcopy(config)
    margin = float(config["threshold"])
    if margin > 0.0:
        alt["threshold"] = margin / 2.0
        if attempt == 2:
            alt["noise_seed"] = int(config["noise_seed"]) + NOISE_ALT_SEED_STEP
    else:
        alt["noise_seed"] = int(config["noise_seed"]) + NOISE_ALT_SEED_STEP * attempt
    alt["replaces"] = config["id"]
    alt["attempt"] = attempt
    alt["id"] = f"{config['id']}_alt{attempt}"
    return alt


def trade_floor_ok(receipt: dict[str, Any]) -> bool:
    """At least 5% of the decisions traded and at least 1,000 tranches (spec section 12 N2).

    Decisions are metrics.n_decisions (the samples inside the walk-forward span). Tranches are metrics.n_tranches,
    else the sum of metrics.exit_reason_counts.
    """
    m = receipt["metrics"]
    if "n_decisions" not in m:
        raise ValueError("receipt metrics have no n_decisions: re-run with the current run_wf")
    if "n_tranches" in m:
        n_tr = int(m["n_tranches"])
    elif "exit_reason_counts" in m:
        n_tr = int(sum(m["exit_reason_counts"].values()))
    else:
        raise ValueError("receipt metrics have neither n_tranches nor exit_reason_counts")
    return bool(n_tr >= 1000 and n_tr * 20 >= int(m["n_decisions"]))


def exit_block() -> list[dict[str, Any]]:
    """The 6 exit controls: the ridge-fixed C4 seed-1 noise entry with only the exit changed (and id, joint seed)."""
    base = next(c for c in noise_grid() if c["block"] == "ridge" and c["cell"] == "C4" and c["seed_ordinal"] == 1)
    out: list[dict[str, Any]] = []
    for i, spec in enumerate(EXIT_BLOCK_SPECS):
        c = copy.deepcopy(base)
        c["exit"] = copy.deepcopy(spec)
        c["id"] = f"exit_{i}_{spec['rule']}_{base['id']}"
        c["joint_shift_seed"] = EXIT_JOINT_SHIFT_SEED_BASE + i
        out.append(c)
    return out


def pc_family(amplitude: float) -> list[dict[str, Any]]:
    """The positive-control family at one planted amplitude: P1, P2 and the decoys D1 to D4."""
    plant = {"seed": PLANT_SEED, "amplitude": amplitude}
    specs: list[tuple[str, list[str], int | None]] = [
        ("P1", ["planted_z"], None),
        ("P2", ["planted_z", *P2_PRICE_FEATURES], None),
    ]
    specs += [(f"D{j}", list(NOISE_FEATURES), PC_DECOY_SEED_BASE + j - 1) for j in range(1, 5)]
    out: list[dict[str, Any]] = []
    for i, (name, features, noise_seed) in enumerate(specs):
        c: dict[str, Any] = {
            "id": f"pc_{name}",
            "kind": "control",
            "family": "pc",
            "model": "ridge",
            "params": {"alpha": 1.0},
            "features": features,
            "interval": "4h",
            "h_ms": 4 * H1_MS,
            "label": "fixed",
            "side_rule": "sign",
            "threshold": 0,
            "size_rule": "unit",
            "lookback_months": 12,
            "refit": "monthly",
            "exit": "horizon",
            "seed": i,
            "book": "slot",
            "joint_shift_seed": PC_JOINT_SHIFT_SEED_BASE + i,
            "first_refit_ms": FIRST_REFIT_MS,
            "plant": dict(plant),
        }
        if noise_seed is not None:
            c["noise_seed"] = noise_seed
        out.append(c)
    return out


# ---------------------------------------------------------------------------
# D inputs for the daily null
# ---------------------------------------------------------------------------


def cov_betas_from_daily_closes(
    closes: dict[str, pd.DataFrame], start_ms: int = DEV_START, end_ms: int = DEV_END
) -> dict[str, Any]:
    """ddof=1 covariance of daily log returns, and each coin's OLS slope on the equal-weight daily mean.

    closes maps symbol to a frame with t (UTC day start, ms) and c. Closes outside [start_ms, end_ms) are ignored. A
    return needs the close of the day and of the day before, for every coin, so a missing close drops two days.
    """
    syms = list(closes)
    wide = pd.DataFrame(
        {s: closes[s].loc[(closes[s]["t"] >= start_ms) & (closes[s]["t"] < end_ms)].set_index("t")["c"] for s in syms}
    )
    if wide.empty:
        raise ValueError("no daily closes inside the span")
    full = np.arange(int(wide.index.min()), int(wide.index.max()) + DAY_MS, DAY_MS, dtype=np.int64)
    logc = np.log(wide.reindex(full).to_numpy(dtype=np.float64))
    ret = logc[1:] - logc[:-1]
    ret = ret[np.all(np.isfinite(ret), axis=1)]
    if len(ret) < 3:
        raise ValueError(f"only {len(ret)} days with all coins: too few for a covariance")
    cov = np.cov(ret.T, ddof=1)
    m = ret.mean(axis=1)
    m_c = m - m.mean()
    betas = ((ret - ret.mean(axis=0)).T @ m_c) / float(m_c @ m_c)
    return {"cov": cov.tolist(), "betas": [float(b) for b in betas], "symbols": syms, "n_days": int(len(ret))}


def d_daily_covariance(ds_dir: Path | str) -> dict[str, Any]:
    """D's 1d log-return covariance and betas from the perp 1d closes over [DEV_START, DEV_END).

    Second moments only, which M allows for the lab-v5 null. Returns {cov, betas, symbols, n_days, dataset_hash}.
    """
    manifest = bar.read_manifest(ds_dir)
    symbols = list(manifest["symbols"])
    closes = {s: load_perp(ds_dir, s, "1d", series="klines").rows[["t", "c"]] for s in symbols}
    out = cov_betas_from_daily_closes(closes, DEV_START, DEV_END)
    out["dataset_hash"] = str(manifest["datasetHash"])
    return out


def _pilot_sd(cov: np.ndarray, betas: np.ndarray, n_paths: int, n_days: int, seed: int, batch_size: int = 256) -> float:
    """SD of the simulated D_d over bet days (days 1 to n_days - 1), the same draws as simulate_daily_null."""
    n_coins = cov.shape[0]
    evals, evecs = np.linalg.eigh(cov)
    l_factor = evecs * np.sqrt(np.maximum(evals, 0.0))
    child_seeds = np.random.SeedSequence(seed).spawn(n_paths)
    count = 0
    s1 = 0.0
    s2 = 0.0
    for p0 in range(0, n_paths, batch_size):
        p1 = min(p0 + batch_size, n_paths)
        z = np.empty((p1 - p0, n_days, n_coins), dtype=np.float64)
        for i, p in enumerate(range(p0, p1)):
            z[i] = np.random.default_rng(child_seeds[p]).standard_normal((n_days, n_coins))
        r = z @ l_factor.T
        w = np.sign(r[:, :-1, :]) / float(n_coins)
        r_next = r[:, 1:, :]
        excess = r_next - betas * np.mean(r_next, axis=-1, keepdims=True)
        d = np.sum(w * excess, axis=-1)
        count += d.size
        s1 += float(d.sum())
        s2 += float((d * d).sum())
    var = (s2 - s1 * s1 / count) / (count - 1)
    return math.sqrt(var)


def daily_null_input(
    cov: Any, betas: Any, pilot_paths: int = 5000, pilot_seed: int = 20261024, n_days: int = 730
) -> dict[str, Any]:
    """The JSON input of `r4.calibration_null`: covariance, betas and the scale c = 4 x the pilot SD of D_d."""
    cov_a = np.asarray(cov, dtype=np.float64)
    b = np.asarray(betas, dtype=np.float64)
    if cov_a.ndim != 2 or cov_a.shape[0] != cov_a.shape[1]:
        raise ValueError(f"covariance must be square, got shape {cov_a.shape}")
    if b.shape != (cov_a.shape[0],):
        raise ValueError(f"betas shape {b.shape} does not match the covariance {cov_a.shape}")
    sd = _pilot_sd(cov_a, b, int(pilot_paths), int(n_days), int(pilot_seed))
    return {
        "covariance": cov_a.tolist(),
        "betas": b.tolist(),
        "scale": 4.0 * sd,
        "pilot": {
            "paths": int(pilot_paths),
            "seed": int(pilot_seed),
            "n_days": int(n_days),
            "sd": sd,
            "multiplier": 4.0,
        },
    }


# ---------------------------------------------------------------------------
# The noise evaluation
# ---------------------------------------------------------------------------

BOOK_ANCHOR_TOL = 1e-9


def _cli() -> Any:
    from r4 import cli

    return cli


def _book_anchor(
    tranches: pd.DataFrame, stats: Any, daily: pd.DataFrame, label: str = "run", tol: float = BOOK_ANCHOR_TOL
) -> dict[str, Any]:
    """The run-time tie between the null's observed statistic and the independent book (brief 28g, review C-3).

    obs_stat x sum(|w|) over the kept tranches is the observed set's weighted net return, computed in the null by
    hedge_terms and the netting. The book (beta_hedged_daily, stored as daily.parquet) computes the same quantity as
    the sum over days of drift_free. They share no code, so a defect in hedge_terms or in the netting, which enters
    the observed value, the shift-zero value and every draw alike, shows up here. Raises beyond tol relative.

    The identity holds when every tranche is kept by the null (a finite return) and lies inside the daily series'
    window. It can differ legitimately in exactly two cases, and then the difference is recorded with the case in
    "explained" and does not raise: "tranches_not_kept" (a missing price or a NaN beta drops a tranche from the
    null's kept set while the book handles it by its own rule) and "tranche_outside_daily_window" (a tranche leg
    falls on a day the stored daily series does not cover). An unexplained difference raises.
    """
    n_tr = int(stats.n_tranches)
    n_kept = int(stats.obs_n_kept or 0)
    obs = float(stats.obs_stat)
    w_sum = stats.obs_weight_sum
    if n_tr == 0 or w_sum is None or not np.isfinite(obs) or n_kept == 0:
        return {
            "checked": False,
            "ok": True,
            "obs_weighted_sum": None,
            "book_sum": None,
            "abs_diff": None,
            "rel_diff": None,
            "n_tranches": n_tr,
            "n_kept": n_kept,
            "explained": None,
        }
    if "drift_free" not in daily.columns or len(daily) == 0:
        raise ValueError(f"{label}: book anchor needs the run's daily drift_free series")
    obs_sum = obs * float(w_sum)
    book_daily = daily["drift_free"].to_numpy(dtype=np.float64)
    book_sum = float(np.sum(book_daily))
    abs_diff = abs(obs_sum - book_sum)
    # Relative to the series' gross magnitude, so a sum that cancels to near zero cannot turn rounding into a miss.
    scale = max(abs(obs_sum), abs(book_sum), float(np.sum(np.abs(book_daily))), 1e-12)
    rel = abs_diff / scale
    causes: list[str] = []
    if rel > tol:
        if n_kept < n_tr:
            causes.append("tranches_not_kept")
        idx = daily.index.to_numpy(dtype=np.int64)
        lo, hi = int(idx.min()), int(idx.max()) + DAY_MS
        if len(tranches) and (
            (tranches["entry_ms"].to_numpy(dtype=np.int64) < lo).any()
            or (tranches["exit_ms"].to_numpy(dtype=np.int64) > hi).any()
        ):
            causes.append("tranche_outside_daily_window")
    explained = "+".join(causes) if causes else None
    if rel > tol and explained is None:
        raise ValueError(
            f"{label}: book anchor broken: obs_stat x sum|w| = {obs_sum!r} against the book's summed drift_free "
            f"{book_sum!r} (relative difference {rel:.3e}, tolerance {tol:.0e}) with every tranche kept and inside "
            "the daily window"
        )
    return {
        "checked": True,
        "ok": True,
        "obs_weighted_sum": obs_sum,
        "book_sum": book_sum,
        "abs_diff": abs_diff,
        "rel_diff": rel,
        "n_tranches": n_tr,
        "n_kept": n_kept,
        "explained": explained,
    }


def _load_noise_runs(runs_dir: Path | str) -> dict[str, dict[str, Any]]:
    runs: dict[str, dict[str, Any]] = {}
    for p in sorted(Path(runs_dir).iterdir()):
        if not (p.is_dir() and (p / "receipt.json").exists() and (p / "daily.parquet").exists()):
            continue
        receipt = json.loads((p / "receipt.json").read_text(encoding="utf-8"))
        if receipt.get("kind") != "control":
            raise ValueError(f"{p / 'receipt.json'} is not a control receipt: the noise evaluation takes controls only")
        if receipt["config"].get("joint_shift_seed") is None:
            raise ValueError(f"{p / 'receipt.json'} has no config.joint_shift_seed")
        daily = pd.read_parquet(p / "daily.parquet")
        daily.attrs["config_hash"] = str(receipt["config_hash"])
        tr_file = p / "tranches.parquet"
        runs[p.name] = {
            "receipt": receipt,
            "daily": daily,
            "tranches_path": tr_file if tr_file.exists() else None,
            "folds": json.loads((p / "folds.json").read_text(encoding="utf-8")),
        }
    if not runs:
        raise ValueError(f"no control runs found in {runs_dir}")
    return runs


def _read_tranches(path: Path | None) -> pd.DataFrame:
    return pd.read_parquet(path) if path is not None else pd.DataFrame()


def _cost_free_frame(daily: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame(
        {"drift_free": (daily["gross_hedged"] + daily["funding"]).to_numpy(dtype=np.float64)}, index=daily.index
    )


def _binom_tail(n: int, p: float, k: int) -> float:
    return float(sum(math.comb(n, j) * p**j * (1 - p) ** (n - j) for j in range(k, n + 1)))


def _v_run_ids(runs: Mapping[str, dict[str, Any]]) -> list[str]:
    """The run ids that enter the calibration V: every run whose receipt config id is not in NOISE_V_EXCLUDED."""
    return sorted(i for i in runs if runs[i]["receipt"]["config"].get("id") not in NOISE_V_EXCLUDED)


def _cost_free_diagnostics(runs: dict[str, dict[str, Any]], v_cost_free: float | None) -> dict[str, Any]:
    """Cost-free items 1 to 3 on gross_hedged + funding, with the within-cell V of the COST-FREE Sharpes.

    The net within-cell V belongs to the net series. The cost-free series has its own trial-Sharpe spread, so item 3
    here is evaluated at the same pooled-within-cell statistic taken on the cost-free Sharpes (brief 28d-2). The
    total-V reading stays as a second, secondary count.
    """
    ids = sorted(runs)
    if any("gross_hedged" not in runs[i]["daily"].columns or "funding" not in runs[i]["daily"].columns for i in ids):
        return {"error": "daily.parquet has no gross_hedged and funding columns"}
    cf = {i: _cost_free_frame(runs[i]["daily"]) for i in ids}
    for i in ids:
        cf[i].attrs["config_hash"] = runs[i]["daily"].attrs["config_hash"]
    item2_cf = bar.item2(cf)
    v_ids = _v_run_ids(runs)
    v_cf_within = float(
        bar.trial_sharpe_variance(
            {i: cf[i] for i in v_ids}, {i: runs[i]["receipt"]["config"] for i in v_ids}, "within_cell"
        )["V"]
    )
    per_config: dict[str, Any] = {}
    n_pass = 0
    n_pass_cf_v = 0
    for i in ids:
        receipt = runs[i]["receipt"]
        gross_paths = receipt["metrics"].get("cpcv_path_gross_means")
        if gross_paths is None:
            raise ValueError(f"receipt {i} has no cpcv_path_gross_means: cannot evaluate the cost-free item 1")
        pseudo = {
            "metrics": {
                "wf_mean": float(cf[i]["drift_free"].mean()),
                "cpcv_path_means": gross_paths,
            }
        }
        r1 = bar.item1(pseudo)
        r3 = bar.item3(receipt, v_cf_within, N_TRIALS_CALIBRATION, candidate_daily=cf[i])
        passed = bool(r1["pass"] and item2_cf["pass"] and r3["pass"])
        n_pass += passed
        entry = {"item1": r1, "item3": r3, "pass_items_1_to_3": passed}
        if v_cost_free is not None:
            r3b = bar.item3(receipt, v_cost_free, N_TRIALS_CALIBRATION, candidate_daily=cf[i])
            entry["item3_cost_free_total_v"] = r3b
            n_pass_cf_v += bool(r1["pass"] and item2_cf["pass"] and r3b["pass"])
        per_config[i] = entry

    # PBO within seed groups: configs that differ only in their noise seed.
    groups: dict[str, list[str]] = {}
    for i in ids:
        cfg = runs[i]["receipt"]["config"]
        groups.setdefault(f"{cfg.get('block')}_{cfg.get('cell')}", []).append(i)
    group_pbo = {
        g: float(bar.item2({m: cf[m] for m in members})["pbo"])
        for g, members in sorted(groups.items())
        if len(members) >= 2
    }
    return {
        "n_pass_items_1_to_3": int(n_pass),
        "n_pass_items_1_to_3_cost_free_total_v": int(n_pass_cf_v) if v_cost_free is not None else None,
        "pbo": float(item2_cf["pbo"]),
        "variance": {"mode": "within_cell_cost_free", "V": v_cf_within},
        "item1": {i: per_config[i]["item1"]["pass"] for i in ids},
        "item3": {i: per_config[i]["item3"]["pass"] for i in ids},
        "configs": per_config,
        "group_pbo": group_pbo,
    }


def _canon(v: Any) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), default=str)


def receipt_provenance(receipts: Sequence[dict[str, Any]], dataset: bool = True) -> dict[str, list[Any]]:
    """The distinct code-freeze and dataset evidence among receipts (what the dossier checks).

    commits, source digests, requirements-lock hashes and library-version maps, plus the dataset hashes when the
    receipts ran on a dataset (dataset=False for the synthetic power simulation, whose panels are generated).
    """
    out: dict[str, list[Any]] = {
        "commits": sorted({r.get("commit") for r in receipts}, key=str),
        "source_sha256": sorted({r.get("source_sha256") for r in receipts}, key=str),
        "requirements_lock_sha256": sorted({r.get("requirements_lock_sha256") for r in receipts}, key=str),
        "versions": [json.loads(c) for c in sorted({_canon(r.get("versions")) for r in receipts})],
    }
    if dataset:
        out["dataset_hash"] = sorted({r.get("dataset_hash") for r in receipts}, key=str)
    return out


def _check_receipts_dataset(receipts: Sequence[dict[str, Any]], manifest_hash: str, label: str) -> None:
    """Every receipt must have run on the dataset whose manifest the evaluator reads (brief 28g, C-1)."""
    bad = sorted({str(r.get("dataset_hash")) for r in receipts if r.get("dataset_hash") != manifest_hash})
    if bad:
        raise ValueError(f"{label}: receipts carry dataset hash {bad}, the dataset read has {manifest_hash!r}")


def evaluate_noise(
    noise_runs_dir: Path | str,
    ds_dir: Path | str,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
    joint_draws: int | None = None,
) -> dict[str, Any]:
    """Evaluate the noise controls against M's bounds and the registered predictions.

    Item 1 per config, item 2 as one PBO on the whole matrix, item 3 with the within-cell V and N = 120, and the
    joint-shift null for ALL configs (draws default to M's 1,000, each config's own joint_shift_seed). Joint_draws
    exists so tests can shorten the null. Reads receipts, daily series, tranches and folds only.
    """
    from r4.pipeline import load_panel

    draws = int(BAR["random_entry_draws"]) if joint_draws is None else int(joint_draws)
    manifest = bar.read_manifest(ds_dir)
    runs = _load_noise_runs(noise_runs_dir)
    ids = sorted(runs)
    _check_receipts_dataset([runs[i]["receipt"] for i in ids], str(manifest["datasetHash"]), "noise controls")
    if panel is None:
        panel = load_panel(Path(ds_dir), list(manifest["symbols"]))

    _check_v_excluded(NOISE_V_EXCLUDED)
    v_ids = _v_run_ids(runs)
    round_daily = {i: runs[i]["daily"] for i in v_ids}
    round_configs = {i: runs[i]["receipt"]["config"] for i in v_ids}
    variance_modes: dict[str, Any] = {}
    for vm in bar.VARIANCE_MODES:
        try:
            variance_modes[vm] = bar.trial_sharpe_variance(round_daily, round_configs, vm)
        except ValueError as exc:
            if vm == "within_cell":
                raise
            variance_modes[vm] = {"error": str(exc)}
    v_within = float(variance_modes["within_cell"]["V"])
    v_cf = variance_modes["cost_free_total"].get("V")
    excluded_ids = sorted(str(runs[i]["receipt"]["config"]["id"]) for i in set(ids) - set(v_ids))
    # disclosure only: the within-cell V over every run, never used
    with_excluded = bar.trial_sharpe_variance(
        {i: runs[i]["daily"] for i in ids}, {i: runs[i]["receipt"]["config"] for i in ids}, "within_cell"
    )

    item2_res = bar.item2({i: runs[i]["daily"] for i in ids})

    configs: dict[str, Any] = {}
    for i in ids:
        run = runs[i]
        tranches = _read_tranches(run["tranches_path"])
        cfg = run["receipt"]["config"]
        res1 = bar.item1(run["receipt"])
        res3 = bar.item3(run["receipt"], v_within, N_TRIALS_CALIBRATION, candidate_daily=run["daily"])
        res3["variance_mode"] = "within_cell"
        seed = int(cfg["joint_shift_seed"])
        stats = bar.joint_shift_stats(
            tranches,
            panel,
            run["folds"],
            span_start_ms=int(cfg["first_refit_ms"]),
            span_end_ms=DEV_END,
            n_draws=draws,
            min_shift_days=int(BAR["random_entry_shift_min_days"]),
            seed=seed,
        )
        p, drop = bar.joint_shift_p(stats, draws)
        obs = float("nan") if (stats.n_tranches == 0 or not stats.shifts) else stats.obs_stat
        anchor = _book_anchor(tranches, stats, run["daily"], label=i)
        configs[i] = {
            "cell": list(bar.cell_key(cfg)),
            "block": cfg.get("block"),
            "item1": res1,
            "item3": res3,
            "joint_shift": {
                "p": float(p),
                "seed": seed,
                "draws": draws,
                "drop_share": float(drop),
                "observed": float(obs) if np.isfinite(obs) else None,
            },
            "book_anchor": anchor,
            "pass_items_1_to_3": bool(res1["pass"] and item2_res["pass"] and res3["pass"]),
        }
        del tranches, stats

    n = len(ids)
    n_pass = sum(c["pass_items_1_to_3"] for c in configs.values())
    rej_p = float(BAR["random_entry_p_max"])
    n_rej = sum(c["joint_shift"]["p"] < rej_p for c in configs.values())

    cost_free = _cost_free_diagnostics(runs, None if v_cf is None else float(v_cf))
    group_pbo = cost_free.get("group_pbo", {})
    wsg_median = float(np.median(list(group_pbo.values()))) if group_pbo else None
    diagnostics = {
        "family_pbo_net": float(item2_res["pbo"]),
        "cost_free": cost_free,
        "within_seed_group_pbo": {"groups": group_pbo, "median": wsg_median},
        "binomial_independence_benchmark": {
            "label": "independence benchmark only (binomial, not the reference distribution)",
            "n": n,
            "p": rej_p,
            "expected_rejections": n * rej_p,
            "p_at_least_observed": _binom_tail(n, rej_p, int(n_rej)),
        },
    }

    verdict: dict[str, dict[str, Any]] = {}

    def put(pid: str, observed: Any, met: bool | None) -> None:
        verdict[pid] = {
            "status": PREDICTIONS[pid]["status"],
            "text": PREDICTIONS[pid]["text"],
            "observed": observed,
            "met": None if met is None else bool(met),
        }

    put("noise_items123_at_most_5", int(n_pass), n_pass <= 5)
    put("noise_items123_zero_of_40", int(n_pass), n_pass == 0)
    put("noise_joint_shift_at_most_6", int(n_rej), n_rej <= 6)
    put("noise_family_pbo_net_below_0_1", float(item2_res["pbo"]), item2_res["pbo"] < 0.1)
    cf_n = cost_free.get("n_pass_items_1_to_3")
    put("noise_cost_free_items123_0_to_2", cf_n, None if cf_n is None else cf_n <= 2)
    put(
        "noise_within_seed_group_pbo_median_0_3_to_0_7",
        wsg_median,
        None if wsg_median is None else 0.3 <= wsg_median <= 0.7,
    )
    ref_pair = REFERENCE_PANEL_REJECTIONS
    if ref_pair is None:
        put("noise_joint_shift_reference_panels", int(n_rej), None)  # not registered yet
    else:
        put("noise_joint_shift_reference_panels", int(n_rej), min(ref_pair) <= n_rej <= max(ref_pair))
        verdict["noise_joint_shift_reference_panels"]["reference_counts"] = list(ref_pair)

    gate_ok = all(v["met"] for v in verdict.values() if v["status"] == "gated")
    noise_set = [
        {
            "id": i,
            "config_hash": str(runs[i]["receipt"]["config_hash"]),
            "replaces": runs[i]["receipt"]["config"].get("replaces"),
            "attempt": runs[i]["receipt"]["config"].get("attempt"),
        }
        for i in ids
    ]
    return {
        "n_configs": n,
        "dataset_hash": str(manifest["datasetHash"]),
        "noise_set": noise_set,
        "provenance": receipt_provenance([runs[i]["receipt"] for i in ids]),
        "reproduction": _cli().reproduction_inputs(),
        "configs": configs,
        "item2": item2_res,
        "variance": {
            "mode": "within_cell",
            "V": v_within,
            "modes": variance_modes,
            "excluded_from_v": excluded_ids,
            "within_cell_with_excluded": with_excluded,
        },
        "gated": {
            "n_pass_items_1_to_3": int(n_pass),
            "n_reject_joint_shift_05": int(n_rej),
            "bounds": {"items_1_to_3_max": 5, "joint_shift_reject_max": 6},
        },
        "diagnostics": diagnostics,
        "verdict": verdict,
        "gate_ok": bool(gate_ok),
    }


# ---------------------------------------------------------------------------
# Synthetic V panel and reference panels (spec sections 5 and 9, Amendment 1 A1.9)
# ---------------------------------------------------------------------------

SYNTH_V_SEED = 3999
REFERENCE_PANEL_SEEDS: tuple[int, ...] = (3997, 3998)
# Rejection counts at p < 0.05 of the reference panels 3,997 and 3,998 (records/synth_v_81e3c5b0.json). Registered
# before any D noise run; A2.2 judges D's count against them.
REFERENCE_PANEL_REJECTIONS: tuple[int, int] | None = (1, 2)
SYNTH_V_FILE = "synth_v.json"
_SYNTH_GARCH = (0.08, 0.88)
_SYNTH_T_DF = 4.5


def _trade_counts(receipt: Mapping[str, Any]) -> tuple[int, int]:
    """(n_tranches, n_decisions) of a receipt, read as trade_floor_ok reads them."""
    m = receipt["metrics"]
    if "n_tranches" in m:
        n_tr = int(m["n_tranches"])
    else:
        n_tr = int(sum(m["exit_reason_counts"].values()))
    return n_tr, int(m["n_decisions"])


def _load_run(run_dir: Path, *, with_tranches: bool = True) -> dict[str, Any]:
    receipt = json.loads((run_dir / "receipt.json").read_text(encoding="utf-8"))
    daily = pd.read_parquet(run_dir / "daily.parquet")
    daily.attrs["config_hash"] = str(receipt["config_hash"])
    out: dict[str, Any] = {
        "receipt": receipt,
        "daily": daily,
        "folds": json.loads((run_dir / "folds.json").read_text(encoding="utf-8")),
    }
    if with_tranches:
        tr_file = run_dir / "tranches.parquet"
        out["tranches"] = pd.read_parquet(tr_file) if tr_file.exists() else pd.DataFrame()
    return out


def _seed_group_split(sharpes: Mapping[str, float], groups: Mapping[str, str]) -> dict[str, Any]:
    """Split the variance of the trial Sharpes into between-group and within-seed-group parts.

    A seed group holds the configurations that differ only in their noise seed (block and cell, as the cost-free
    diagnostics group them). within = pooled over groups of at least 2, sum of squared deviations from the group
    mean over the sum of (n - 1). between = the ddof=1 variance of the group means over all groups. ss_between and
    ss_within add up to the total sum of squares about the grand mean.
    """
    by_group: dict[str, list[float]] = {}
    for i in sorted(sharpes):
        by_group.setdefault(groups[i], []).append(float(sharpes[i]))
    allv = np.asarray([x for v in by_group.values() for x in v])
    ss_within = float(sum(np.sum((np.asarray(v) - np.mean(v)) ** 2) for v in by_group.values()))
    df_within = int(sum(len(v) - 1 for v in by_group.values() if len(v) >= 2))
    means = np.asarray([np.mean(v) for v in by_group.values()])
    ss_total = float(np.sum((allv - allv.mean()) ** 2))
    return {
        "V": ss_within / df_within if df_within >= 1 else None,
        "df": df_within,
        "n_groups": len(by_group),
        "n_groups_used": sum(1 for v in by_group.values() if len(v) >= 2),
        "between_group_V": float(np.var(means, ddof=1)) if len(means) >= 2 else None,
        "ss_within": ss_within,
        "ss_between": max(ss_total - ss_within, 0.0),
        "ss_total": ss_total,
    }


def synthetic_v(
    dcov_path: Path | str,
    out_dir: Path | str,
    commit: str,
    *,
    start_ms: int | None = None,
    end_ms: int | None = None,
    first_refit_ms: int | None = None,
    joint_draws: int | None = None,
) -> dict[str, Any]:
    """The 40 noise controls on the synthetic V panel (seed 3,999), then on the 2 reference panels (3,997 and 3,998).

    V panel: every noise_grid() config runs on a D-shaped panel built from the calib-dcov covariance exactly as the
    power panels are. A config that fails trade_floor_ok is replaced by noise_alternative(config, 1), then (2). If
    attempt 2 fails too it is kept and recorded with trade_floor_failed (A1.9: reported and still counted in V). V,
    its between-group and within-seed-group split and SR0 (N = 120) are taken on the final set. Reference panels
    run the FINAL set and the joint-shift null of every config (draws default to M's 1,000, each config's own seed),
    and record the count with p < M's rejection p. Writes out_dir/synth_v.json (an existing file is replaced by the
    same content: refusing is the CLI's job). Finished runs are reused through _run_or_reuse, and finished
    joint-shift records when their config hash, dataset, commit and draws match. Synthetic datasets are deleted
    after their runs. start_ms, end_ms, first_refit_ms and joint_draws exist so tests can shrink the work.
    """
    import hashlib
    import shutil

    from r4 import cli
    from r4.synth import synth_panel, write_synthetic_dataset

    start = DEV_START if start_ms is None else int(start_ms)
    end = DEV_END if end_ms is None else int(end_ms)
    refit = FIRST_REFIT_MS if first_refit_ms is None else int(first_refit_ms)
    draws = int(BAR["random_entry_draws"]) if joint_draws is None else int(joint_draws)
    rej_p = float(BAR["random_entry_p_max"])
    dcov_file = Path(dcov_path)
    dcov_bytes = dcov_file.read_bytes()
    dcov = json.loads(dcov_bytes.decode("utf-8"))
    symbols = list(dcov["symbols"])
    cov = np.asarray(dcov["cov"], dtype=np.float64)
    if cov.shape != (len(symbols), len(symbols)):
        raise ValueError(f"dcov covariance shape {cov.shape} does not match {len(symbols)} symbols")
    out_root = Path(out_dir)
    out_root.mkdir(parents=True, exist_ok=True)

    def prepare(c: dict[str, Any]) -> dict[str, Any]:
        c = copy.deepcopy(c)
        c["first_refit_ms"] = refit
        return c

    def panel_and_ds(seed: int, tmp: Path) -> tuple[dict[str, dict[str, pd.DataFrame]], Path]:
        panel = synth_panel(cov, symbols, start, end, seed=seed, garch=_SYNTH_GARCH, t_df=_SYNTH_T_DF)
        return panel, write_synthetic_dataset(panel, tmp / "ds")

    def run_one(c: dict[str, Any], tmp: Path, ds: Path, runs: Path, panel: Any) -> dict[str, Any]:
        cfg_file = tmp / "cfg" / f"{c['id']}.json"
        cfg_file.parent.mkdir(parents=True, exist_ok=True)
        cfg_file.write_text(json.dumps(c, indent=2), encoding="utf-8")
        return _run_or_reuse(cfg_file, c, ds, runs, commit, panel)

    # ---- V panel ----
    v_dir = out_root / f"v_{SYNTH_V_SEED}"
    v_runs, v_tmp = v_dir / "runs", v_dir / "_tmp"
    final_cfgs: list[dict[str, Any]] = []
    floor: dict[str, Any] = {}
    v_dataset_hash: str
    try:
        panel, ds = panel_and_ds(SYNTH_V_SEED, v_tmp)
        v_dataset_hash = str(bar.read_manifest(ds)["datasetHash"])
        for reg in noise_grid():
            base = prepare(reg)
            tried: list[dict[str, Any]] = []
            cur = base
            for attempt in (0, 1, 2):
                if attempt:
                    cur = noise_alternative(base, attempt)
                receipt = run_one(cur, v_tmp, ds, v_runs, panel)
                n_tr, n_dec = _trade_counts(receipt)
                ok = bool(trade_floor_ok(receipt))
                tried.append(
                    {
                        "id": cur["id"],
                        "attempt": attempt,
                        "n_tranches": n_tr,
                        "n_decisions": n_dec,
                        "trade_share": (n_tr / n_dec) if n_dec else None,
                        "ok": ok,
                    }
                )
                if ok:
                    break
            final_cfgs.append(cur)
            last = tried[-1]
            floor[reg["id"]] = {
                "final_id": cur["id"],
                "attempts": tried,
                "trade_floor_failed": not last["ok"],
                "n_tranches": last["n_tranches"],
                "n_decisions": last["n_decisions"],
                "trade_share": last["trade_share"],
            }
        del panel
    finally:
        shutil.rmtree(v_tmp, ignore_errors=True)

    v_loaded = {c["id"]: _load_run(v_runs / c["id"], with_tranches=False) for c in final_cfgs}
    ids = sorted(v_loaded)
    daily = {i: v_loaded[i]["daily"] for i in ids}
    configs = {i: v_loaded[i]["receipt"]["config"] for i in ids}
    modes = {m: bar.trial_sharpe_variance(daily, configs, m) for m in ("within_cell", "total")}
    sharpes = {i: float(per_period_sharpe(daily[i]["drift_free"].to_numpy(dtype=np.float64))) for i in ids}
    groups = {i: f"{configs[i].get('block')}_{configs[i].get('cell')}" for i in ids}
    split = _seed_group_split(sharpes, groups)
    sr0 = {"N": N_TRIALS_CALIBRATION}
    for name, val in (
        ("within_cell", modes["within_cell"]["V"]),
        ("total", modes["total"]["V"]),
        ("within_seed_group", split["V"]),
    ):
        sr0[name] = None if val is None else float(expected_max_sharpe(N_TRIALS_CALIBRATION, float(val)))

    # ---- reference panels ----
    ref_out: list[dict[str, Any]] = []
    ref_receipts: list[dict[str, Any]] = []
    ref_datasets: list[str] = []
    for seed in REFERENCE_PANEL_SEEDS:
        r_dir = out_root / f"ref_{seed}"
        r_runs, r_tmp, r_joint = r_dir / "runs", r_dir / "_tmp", r_dir / "joint"
        r_joint.mkdir(parents=True, exist_ok=True)
        by_cfg: dict[str, Any] = {}
        try:
            panel, ds = panel_and_ds(seed, r_tmp)
            ds_hash = str(bar.read_manifest(ds)["datasetHash"])
            ref_datasets.append(ds_hash)
            for c in final_cfgs:
                receipt = run_one(c, r_tmp, ds, r_runs, panel)
                ref_receipts.append(receipt)
                jf = r_joint / f"{c['id']}.json"
                want = {
                    "config_hash": str(receipt["config_hash"]),
                    "dataset_hash": ds_hash,
                    "commit": cli.resolve_commit(commit),
                    "draws": draws,
                    "seed": int(c["joint_shift_seed"]),
                    "span_end_ms": end,
                }
                rec: dict[str, Any] | None = None
                if jf.is_file():
                    old = json.loads(jf.read_text(encoding="utf-8"))
                    if all(old.get(k) == v for k, v in want.items()):
                        rec = old
                if rec is None:
                    run = _load_run(r_runs / c["id"])
                    stats = bar.joint_shift_stats(
                        run["tranches"],
                        panel,
                        run["folds"],
                        span_start_ms=int(c["first_refit_ms"]),
                        span_end_ms=end,
                        n_draws=draws,
                        min_shift_days=int(BAR["random_entry_shift_min_days"]),
                        seed=int(c["joint_shift_seed"]),
                    )
                    p, drop = bar.joint_shift_p(stats, draws)
                    rec = {**want, "p": float(p), "drop_share": float(drop)}
                    jf.write_text(json.dumps(rec, indent=2), encoding="utf-8")
                    del run, stats
                by_cfg[c["id"]] = {"p": rec["p"], "drop_share": rec["drop_share"], "seed": rec["seed"]}
            del panel
        finally:
            shutil.rmtree(r_tmp, ignore_errors=True)
        ref_out.append(
            {
                "seed": seed,
                "dataset_hash": ds_hash,
                "draws": draws,
                "n_reject_05": int(sum(v["p"] < rej_p for v in by_cfg.values())),
                "reject_p": rej_p,
                "rejections_by_config": by_cfg,
            }
        )

    all_receipts = [v_loaded[i]["receipt"] for i in ids] + ref_receipts
    noise_set = [
        {
            "id": i,
            "config_hash": str(v_loaded[i]["receipt"]["config_hash"]),
            "replaces": v_loaded[i]["receipt"]["config"].get("replaces"),
            "attempt": v_loaded[i]["receipt"]["config"].get("attempt"),
        }
        for i in ids
    ]
    result = {
        "panel_seeds": {"v": SYNTH_V_SEED, "reference": list(REFERENCE_PANEL_SEEDS)},
        "span": {"start_ms": start, "end_ms": end, "first_refit_ms": refit},
        "commit": cli.resolve_commit(commit),
        "noise_set": noise_set,
        "trade_floor": floor,
        "variance": {
            "within_cell": modes["within_cell"],
            "total": modes["total"],
            "within_seed_group": split,
            "between_group": {"V": split["between_group_V"], "ss_between": split["ss_between"]},
            "sharpes": sharpes,
        },
        "sr0": sr0,
        "reference_panels": ref_out,
        "v_dataset_hash": v_dataset_hash,
        "reference_dataset_hashes": ref_datasets,
        "dcov_sha256": hashlib.sha256(dcov_bytes).hexdigest(),
        "dcov_dataset_hash": dcov.get("dataset_hash"),
        "provenance": receipt_provenance(all_receipts, dataset=False),
        "reproduction": cli.reproduction_inputs(),
    }
    (out_root / SYNTH_V_FILE).write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


# ---------------------------------------------------------------------------
# Power simulation (spec sections 5 and 12 N1): synthetic panels only
# ---------------------------------------------------------------------------

POWER_PANEL_SEED_BASE = 4000
POWER_PLANT_SEED_BASE = 30_000
POWER_JOINT_SEED_BASE = 9_000_000
POWER_REPLICATES = 40
POWER_JOINT_DRAWS = 200
POWER_MARGIN = 1.2
POWER_TARGET = 0.8
POWER_MAX_DOUBLINGS = 3
PC_RERUN_PLANT_SEED = 20261029
PC_RERUN_DECOY_BASE = 2_000_011
POSITIVE_MISS_FILE = "positive_miss.json"
# P1 and the four decoys: P2 is omitted in the power simulation (disclosed).
POWER_RUN_IDS: tuple[str, ...] = ("pc_P1", "pc_D1", "pc_D2", "pc_D3", "pc_D4")


def _amp_dir(power_dir: Path | str, amplitude: float) -> Path:
    return Path(power_dir) / f"a{float(amplitude)!r}"


def power_family(amplitude: float, replicate: int, first_refit_ms: int = FIRST_REFIT_MS) -> list[dict[str, Any]]:
    """P1 and D1 to D4 at one amplitude, with the plant seed of this replicate (30,000 + r)."""
    out: list[dict[str, Any]] = []
    for c in pc_family(amplitude):
        if c["id"] == "pc_P2":
            continue
        c["plant"] = {"seed": POWER_PLANT_SEED_BASE + int(replicate), "amplitude": float(amplitude)}
        c["first_refit_ms"] = int(first_refit_ms)
        out.append(c)
    return out


def adaptive_order(grid: Sequence[float]) -> list[float]:
    """Middle amplitude first, then the nearest neighbours outward, the upper one before the lower one."""
    g = sorted(float(a) for a in grid)
    n = len(g)
    if n == 0:
        return []
    mid = n // 2
    order = [g[mid]]
    k = 1
    while len(order) < n:
        for idx in (mid + k, mid - k):
            if 0 <= idx < n:
                order.append(g[idx])
        k += 1
    return order


def _power_meta(
    dcov: dict[str, Any], n_replicates: int, start_ms: int, end_ms: int, first_refit_ms: int, grid: Sequence[float]
) -> dict[str, Any]:
    cov = np.asarray(dcov["cov"], dtype=np.float64)
    symbols = list(dcov["symbols"])
    if cov.shape != (len(symbols), len(symbols)):
        raise ValueError(f"dcov covariance shape {cov.shape} does not match {len(symbols)} symbols")
    return {
        "symbols": symbols,
        "cov": cov.tolist(),
        "start_ms": int(start_ms),
        "end_ms": int(end_ms),
        "first_refit_ms": int(first_refit_ms),
        "panel_seed_base": POWER_PANEL_SEED_BASE,
        "plant_seed_base": POWER_PLANT_SEED_BASE,
        "joint_seed_base": POWER_JOINT_SEED_BASE,
        "n_replicates": int(n_replicates),
        "grid": [float(a) for a in grid],
        "garch": [0.08, 0.88],
        "t_df": 4.5,
        "dcov_dataset_hash": dcov.get("dataset_hash"),
    }


def _read_power_meta(power_dir: Path | str) -> dict[str, Any]:
    f = Path(power_dir) / "power_meta.json"
    if not f.is_file():
        raise ValueError(f"{f} is missing: not a power simulation directory")
    return json.loads(f.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def _simulate_amplitude(power_dir: Path | str, amplitude: float, meta: dict[str, Any], commit: str | None) -> None:
    """Run P1 and the decoys for every replicate at one amplitude. A finished replicate is not re-run."""
    import shutil

    from r4 import cli
    from r4.synth import synth_panel, write_synthetic_dataset

    adir = _amp_dir(power_dir, amplitude)
    for r in range(int(meta["n_replicates"])):
        run_dir = adir / f"r{r}"
        if all((run_dir / rid / "receipt.json").is_file() for rid in POWER_RUN_IDS):
            continue
        panel = synth_panel(
            meta["cov"],
            meta["symbols"],
            int(meta["start_ms"]),
            int(meta["end_ms"]),
            seed=int(meta["panel_seed_base"]) + r,
            garch=tuple(meta["garch"]),
            t_df=float(meta["t_df"]),
        )
        tmp = run_dir / "_tmp"
        try:
            ds = write_synthetic_dataset(panel, tmp / "ds")
            for c in power_family(amplitude, r, int(meta["first_refit_ms"])):
                cfg_file = tmp / "cfg" / f"{c['id']}.json"
                cfg_file.parent.mkdir(parents=True, exist_ok=True)
                cfg_file.write_text(json.dumps(c, indent=2), encoding="utf-8")
                cli.run_wf(cfg_file, ds, run_dir, commit=commit, panel=panel)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        del panel


def _amplitude_rate(
    power_dir: Path | str, amplitude: float, v: float, n_trials: int, joint_draws: int, **kw: Any
) -> float:
    entry = _curve_entry(Path(power_dir), _read_power_meta(power_dir), amplitude, v, n_trials, joint_draws)
    return float(entry["rate"])


def power_simulation(
    dcov: dict[str, Any],
    out_dir: Path | str,
    amplitudes: Sequence[float],
    n_replicates: int = POWER_REPLICATES,
    commit: str | None = None,
    *,
    start_ms: int = DEV_START,
    end_ms: int = DEV_END,
    first_refit_ms: int = FIRST_REFIT_MS,
    stop_v: float | None = None,
    n_trials: int = N_TRIALS_CALIBRATION,
    joint_draws: int = POWER_JOINT_DRAWS,
) -> dict[str, Any]:
    """Run the power simulation: P1 and decoys D1 to D4 on synthetic D-shaped panels, one stored series per run.

    For each amplitude and replicate r the panel is synth_panel(cov, seed 4,000 + r) (common across amplitudes),
    written to a temporary synthetic dataset that is deleted afterwards, and run through run_wf with the plant seed
    30,000 + r. Runs land under out_dir/a{amplitude}/r{r}/<run id>/ with daily.parquet, receipt.json, tranches and
    folds. Amplitudes are evaluated in adaptive order (middle first, then outward). Without stop_v all of them run.
    With stop_v the walk follows the detection rate at that variance (an evaluation at the synthetic V): from the
    middle it goes down while the rate is at least 0.8, up otherwise, one neighbour at a time, and stops at the first
    change of side. start_ms, end_ms and first_refit_ms exist so tests can shrink the span.
    """
    if n_replicates < 1:
        raise ValueError("n_replicates must be at least 1")
    grid = sorted({float(a) for a in amplitudes})
    if not grid:
        raise ValueError("amplitudes must not be empty")
    t0 = time.perf_counter()
    power_dir = Path(out_dir)
    meta = _power_meta(dcov, n_replicates, start_ms, end_ms, first_refit_ms, grid)
    meta_file = power_dir / "power_meta.json"
    if meta_file.is_file():
        if _read_power_meta(power_dir) != meta:
            raise ValueError(f"{meta_file} differs from the requested simulation: use a fresh directory")
    else:
        power_dir.mkdir(parents=True, exist_ok=True)
        meta_file.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    order = adaptive_order(grid)
    evaluated: list[float] = []
    if stop_v is None:
        for a in order:
            _simulate_amplitude(power_dir, a, meta=meta, commit=commit)
            evaluated.append(a)
    else:
        i = len(grid) // 2
        _simulate_amplitude(power_dir, grid[i], meta=meta, commit=commit)
        evaluated.append(grid[i])
        qualifies = _amplitude_rate(power_dir, grid[i], stop_v, n_trials, joint_draws) >= POWER_TARGET - 1e-12
        step = -1 if qualifies else 1
        j = i + step
        while 0 <= j < len(grid):
            _simulate_amplitude(power_dir, grid[j], meta=meta, commit=commit)
            evaluated.append(grid[j])
            ok = _amplitude_rate(power_dir, grid[j], stop_v, n_trials, joint_draws) >= POWER_TARGET - 1e-12
            if ok != qualifies:
                break
            j += step
        order = list(evaluated)
    return {
        "power_dir": str(power_dir),
        "amplitudes": grid,
        "order": order,
        "evaluated": evaluated,
        "panel_seeds": [POWER_PANEL_SEED_BASE + r for r in range(n_replicates)],
        "plant_seeds": [POWER_PLANT_SEED_BASE + r for r in range(n_replicates)],
        "n_replicates": int(n_replicates),
        "stop_v": stop_v,
        "commit": commit,
        "runtime_s": round(time.perf_counter() - t0, 3),
    }


def extend_amplitude(power_dir: Path | str, amplitude: float, commit: str | None = None) -> None:
    """Simulate one more amplitude into an existing power directory, with the same replicate seeds."""
    _simulate_amplitude(power_dir, amplitude, meta=_read_power_meta(power_dir), commit=commit)


def _curve_entry(
    power_dir: Path, meta: dict[str, Any], amplitude: float, v: float, n_trials: int, joint_draws: int
) -> dict[str, Any]:
    """Detection at one amplitude: P1 passes items 1, 2 (5-config PBO), 3 at v, 5, 6, then the joint shift."""
    from r4 import bar
    from r4.plant import apply_plant
    from r4.stats import wilson
    from r4.synth import synth_panel

    adir = _amp_dir(power_dir, amplitude)
    detail: list[dict[str, Any]] = []
    detected = 0
    for r in range(int(meta["n_replicates"])):
        run_dir = adir / f"r{r}"
        missing = [rid for rid in POWER_RUN_IDS if not (run_dir / rid / "receipt.json").is_file()]
        if missing:
            raise ValueError(f"replicate {r} at amplitude {amplitude} has no stored runs for {missing}")
        receipts = {
            rid: json.loads((run_dir / rid / "receipt.json").read_text(encoding="utf-8")) for rid in POWER_RUN_IDS
        }
        dailies = {rid: pd.read_parquet(run_dir / rid / "daily.parquet") for rid in POWER_RUN_IDS}
        p1, d1 = receipts["pc_P1"], dailies["pc_P1"]
        res1 = bar.item1(p1)
        res2 = bar.item2(dailies)
        res3 = bar.item3(p1, v, n_trials, candidate_daily=d1)
        res5 = bar.item5(p1)
        res6 = bar.item6(p1)
        cheap = bool(res1["pass"] and res2["pass"] and res3["pass"] and res5["pass"] and res6["pass"])
        row: dict[str, Any] = {
            "replicate": r,
            "item1": bool(res1["pass"]),
            "item2": bool(res2["pass"]),
            "item3": bool(res3["pass"]),
            "item5": bool(res5["pass"]),
            "item6": bool(res6["pass"]),
            "joint_shift_p": None,
            "detected": False,
        }
        if cheap:
            plant = {"seed": POWER_PLANT_SEED_BASE + r, "amplitude": float(amplitude)}
            panel = synth_panel(
                meta["cov"],
                meta["symbols"],
                int(meta["start_ms"]),
                int(meta["end_ms"]),
                seed=int(meta["panel_seed_base"]) + r,
                garch=tuple(meta["garch"]),
                t_df=float(meta["t_df"]),
            )
            planted = apply_plant(panel, plant)
            p_joint, _drop, _obs, _sh = bar.joint_shift_null(
                pd.read_parquet(run_dir / "pc_P1" / "tranches.parquet"),
                planted,
                json.loads((run_dir / "pc_P1" / "folds.json").read_text(encoding="utf-8")),
                span_start_ms=int(meta["first_refit_ms"]),
                span_end_ms=DEV_END,
                n_draws=int(joint_draws),
                min_shift_days=int(BAR["random_entry_shift_min_days"]),
                seed=POWER_JOINT_SEED_BASE + r,
            )
            row["joint_shift_p"] = float(p_joint)
            row["detected"] = bool(p_joint < float(BAR["random_entry_p_max"]))
        detected += int(row["detected"])
        detail.append(row)
    n = int(meta["n_replicates"])
    lo, hi = wilson(detected, n)
    return {
        "detected": int(detected),
        "n": n,
        "rate": detected / n,
        "wilson95": [float(lo), float(hi)],
        "replicates": detail,
    }


def power_curve(
    power_dir: Path | str, v: float, n_trials: int = N_TRIALS_CALIBRATION, joint_draws: int = POWER_JOINT_DRAWS
) -> dict[float, dict[str, Any]]:
    """Detection rate per stored amplitude at the trial-Sharpe variance v: a pure recomputation over stored series.

    Detection for replicate r means P1 passes item 1, item 2 (PBO of the 5-config matrix), item 3 at v, items 5 and
    6, and then item 4's joint shift at joint_draws draws (seed 9,000,000 + r), which runs only when the others pass.
    The joint shift reads the replicate's synthetic panel (regenerated from its seed) with the plant applied. The
    tripwire and the SPA are skipped (disclosed). Returns {amplitude: {detected, n, rate, wilson95, replicates}}.
    """
    pdir = Path(power_dir)
    meta = _read_power_meta(pdir)
    amps = sorted(float(p.name[1:]) for p in pdir.iterdir() if p.is_dir() and p.name.startswith("a"))
    if not amps:
        raise ValueError(f"no amplitudes stored under {pdir}")
    return {a: _curve_entry(pdir, meta, a, float(v), int(n_trials), int(joint_draws)) for a in amps}


def power_curve_at_margin(
    power_dir: Path | str, v: float, margin: float = POWER_MARGIN, **kw: Any
) -> dict[float, dict[str, Any]]:
    """The power curve at margin x v (registered margin 1.2), which is the curve a* is chosen on."""
    return power_curve(power_dir, float(v) * float(margin), **kw)


def choose_a_star(
    curve: dict[float, dict[str, Any]],
    extend: Callable[[float], dict[str, Any]] | None = None,
    grid: Sequence[float] | None = None,
) -> dict[str, Any]:
    """a* = the smallest grid amplitude with a detection rate of at least 0.8 on a curve taken at 1.2 x V.

    The next lower grid amplitude must have been evaluated and failed, unless a* is the grid minimum (A1.9). grid is
    the registered amplitude grid (power_meta.json). Without it the grid is the evaluated amplitudes. If the lower
    neighbour was never simulated the result is {"needs": amplitude}: the caller simulates it with the same replicate
    seeds and asks again. If no evaluated amplitude qualifies and extend is given, the grid is extended upward by
    doubling its largest amplitude, at most 3 times, calling extend(amplitude) for each new curve entry. If it
    still fails the result is infeasible. Returns {"a_star", "infeasible", "extensions", "curve"} or {"needs"}.
    """
    if not curve:
        raise ValueError("an empty curve has no a*")
    work = {float(a): dict(e) for a, e in curve.items()}
    registered = {float(a) for a in grid} if grid is not None else set()
    extensions: list[float] = []

    def pick() -> float | None:
        ok = [a for a, e in sorted(work.items()) if float(e["rate"]) >= POWER_TARGET - 1e-12]
        return ok[0] if ok else None

    def lower_neighbour(star: float) -> float | None:
        below = [a for a in registered | set(work) if a < star]
        return max(below) if below else None

    star = pick()
    while star is None and extend is not None and len(extensions) < POWER_MAX_DOUBLINGS:
        a_new = 2.0 * max(work)
        work[a_new] = dict(extend(a_new))
        extensions.append(a_new)
        star = pick()
    if star is not None:
        lower = lower_neighbour(star)
        if lower is not None and lower not in work:
            return {"needs": lower}
    return {"a_star": star, "infeasible": star is None, "extensions": extensions, "curve": work}


def select_a_star(
    power_dir: Path | str,
    v_margin: float,
    commit: str | None,
    *,
    extend_up: bool = False,
    joint_draws: int = POWER_JOINT_DRAWS,
) -> dict[str, Any]:
    """choose_a_star on the stored power directory, simulating any needed lower grid amplitude first.

    v_margin is 1.2 x the noise controls' D within-cell V. Each needed amplitude is simulated with the same replicate
    seeds (extend_amplitude) and the curve is recomputed, until the rule holds. extend_up also allows the registered
    upward doubling. Both kinds of simulation need a commit.
    """
    meta = _read_power_meta(power_dir)
    grid = meta.get("grid")
    if not grid:
        raise ValueError(f"{Path(power_dir) / 'power_meta.json'} records no registered amplitude grid")

    def curve_now() -> dict[float, dict[str, Any]]:
        return power_curve(power_dir, v_margin, joint_draws=joint_draws)

    def extend_one(a: float) -> dict[str, Any]:
        if not commit:
            raise ValueError("a commit is required to simulate another amplitude")
        extend_amplitude(power_dir, a, commit=commit)
        return curve_now()[a]

    while True:
        chosen = choose_a_star(curve_now(), extend=extend_one if extend_up else None, grid=grid)
        if "needs" not in chosen:
            return chosen
        if not commit:
            raise ValueError(f"amplitude {chosen['needs']} must be simulated first: a commit is required")
        extend_amplitude(power_dir, chosen["needs"], commit=commit)


def power_provenance(power_dir: Path | str) -> dict[str, list[Any]]:
    """The distinct commits and source digests among every stored power-simulation receipt."""
    receipts = [json.loads(f.read_text(encoding="utf-8")) for f in sorted(Path(power_dir).glob("a*/r*/*/receipt.json"))]
    if not receipts:
        raise ValueError(f"no power receipts found under {power_dir}")
    return receipt_provenance(receipts, dataset=False)


# ---------------------------------------------------------------------------
# Positive control on D
# ---------------------------------------------------------------------------


def pc_rerun_family(amplitude: float) -> list[dict[str, Any]]:
    """The registered plant re-run: plant seed 20261029 and decoy noise seeds 2,000,011 to 2,000,014."""
    out = pc_family(amplitude)
    for c in out:
        c["plant"] = {"seed": PC_RERUN_PLANT_SEED, "amplitude": float(amplitude)}
        if c["id"].startswith("pc_D"):
            c["noise_seed"] = PC_RERUN_DECOY_BASE + int(c["id"][4:]) - 1
    return out


def positive_control(
    ds_dir: Path | str,
    a_star: float,
    noise_runs_dir: Path | str,
    out_dir: Path | str,
    commit: str | None = None,
    *,
    first_refit_ms: int | None = None,
    tripwire_shifts: Sequence[int] | None = None,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
    rerun: bool = False,
    audited: bool = False,
    n_trials: int = N_TRIALS_CALIBRATION,
    expected_v: float | None = None,
    provenance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the pc family (P1, P2, D1 to D4) with the plant at a* on D and evaluate it with the calibration bar.

    Receipts are kind "control". Item 3 uses the within-cell V of the NOISE controls (noise_runs_dir is the round
    directory of family_report) and N = 120. Item 4's joint shift and the SPA read the PLANTED panel, because the
    observed statistic is priced from the panel and the plant only exists there. The label-shift tripwire runs for
    P1 and P2 only when they pass items 1 to 3. Detection means P1 or P2 passes items 1 to 6 and the tripwire does
    not halt. A miss writes positive_miss.json. The failure tree (spec section 8, A1.9) then allows exactly one
    re-run: rerun=True (plant seed 20261029, decoy seeds 2,000,011 to 2,000,014) with audited=True after a code
    audit. A re-run without a miss, a re-run without the audit, an audited call at the original seed, and any call
    after a second miss ("second miss is terminal") all raise. expected_v, when given, is the noise controls' D
    within-cell V from the noise-evaluation file: a different V in this run raises before anything is written.
    provenance records the input files (path and sha256) in the result.
    """
    from r4 import bar, cli
    from r4.pipeline import load_panel
    from r4.plant import apply_plant
    from r4.tripwire import SHIFT_DAYS

    out = Path(out_dir)
    miss_file = out / POSITIVE_MISS_FILE
    runs = out / "runs"
    has_attempt = any(out.glob("attempt_*"))
    if miss_file.exists():
        if has_attempt:
            raise ValueError(
                f"{miss_file} exists after a re-run: the second miss is terminal, the pipeline is presumed insensitive"
            )
        if not rerun:
            raise ValueError(
                f"{miss_file} exists: the one allowed re-run needs rerun=True (fresh plant seed) after a code audit"
            )
        if not audited:
            raise ValueError(
                f"{miss_file} exists: a code audit must find nothing before the re-run (pass audited=True)"
            )
    elif rerun:
        raise ValueError(f"rerun=True but {miss_file} does not exist: a re-run follows a recorded miss only")
    attempt_tag = 1
    while (out / f"attempt_{attempt_tag}").exists():
        attempt_tag += 1
    if miss_file.exists():
        archive = out / f"attempt_{attempt_tag}"
        archive.mkdir(parents=True)
        miss_file.rename(archive / POSITIVE_MISS_FILE)
        if runs.exists():
            runs.rename(archive / "runs")
        for name in ("tripwire", "configs", "family_report.json", "positive_control.json"):
            if (out / name).exists():
                (out / name).rename(archive / name)
    elif runs.exists() and any(runs.iterdir()):
        raise ValueError(f"{runs} already holds runs and no miss record: refusing to overwrite them")

    configs = pc_rerun_family(a_star) if rerun else pc_family(a_star)
    if first_refit_ms is not None:
        for c in configs:
            c["first_refit_ms"] = int(first_refit_ms)
    cfg_dir = out / "configs"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    cfg_files: dict[str, Path] = {}
    for c in configs:
        f = cfg_dir / f"{c['id']}.json"
        f.write_text(json.dumps(c, indent=2), encoding="utf-8")
        cfg_files[c["id"]] = f

    ds = Path(ds_dir)
    if panel is None:
        manifest = bar.read_manifest(ds)
        panel = load_panel(ds, list(manifest["symbols"]))
    for c in configs:
        cli.run_wf(cfg_files[c["id"]], ds, runs, commit=commit, panel=panel)

    run_receipts = [json.loads(f.read_text(encoding="utf-8")) for f in sorted(runs.glob("*/receipt.json"))]
    _check_receipts_dataset(run_receipts, str(bar.read_manifest(ds)["datasetHash"]), "positive control")
    planted = apply_plant(panel, configs[0]["plant"])
    _check_v_excluded(NOISE_V_EXCLUDED)
    report = bar.family_report(
        family="pc",
        runs_dir=runs,
        round_runs_dir=noise_runs_dir,
        ledger_count=n_trials,
        ds_dir=ds,
        out_file=out / "family_report.json",
        panel=planted,
        calibration=True,
        v_exclude=NOISE_V_EXCLUDED,
    )
    shifts = tuple(SHIFT_DAYS if tripwire_shifts is None else tripwire_shifts)
    tripwires: dict[str, Any] = {}
    detected_by: str | None = None
    for rid in ("pc_P1", "pc_P2"):
        ev = report["configurations"][rid]
        passes123 = bool(ev["item1"]["pass"] and ev["item2"]["pass"] and ev["item3"]["pass"])
        if not passes123:
            continue
        tw = cli.run_tripwire(cfg_files[rid], ds, out / "tripwire", commit=commit, panel=panel, shifts_days=shifts)
        tripwires[rid] = {"positive": int(tw["positive"]), "n": int(tw["n"]), "halt": bool(tw["halt"])}
        if ev["all_pass"] and not tw["halt"] and detected_by is None:
            detected_by = rid

    if expected_v is not None and not math.isclose(
        float(report["variance"]["V"]), float(expected_v), rel_tol=1e-9, abs_tol=1e-15
    ):
        raise ValueError(
            f"the positive control's variance V {report['variance']['V']} differs from the noise evaluation's "
            f"{expected_v}"
        )
    slim = dict(report)
    slim["configurations"] = {
        k: {kk: vv for kk, vv in ev.items() if kk != "receipt"} for k, ev in report["configurations"].items()
    }
    result: dict[str, Any] = {
        "a_star": float(a_star),
        "n_trials": int(n_trials),
        "rerun": bool(rerun),
        "plant": dict(configs[0]["plant"]),
        "variance": report["variance"],
        "report": slim,
        "tripwires": tripwires,
        "tripwire_shifts": len(shifts),
        "detected": detected_by is not None,
        "detected_by": detected_by,
        "dataset_hash": report["inputs_hashes"]["dataset_hash"],
        "commit": commit,
        "config_hashes": {str(r["config"]["id"]): str(r["config_hash"]) for r in run_receipts},
        "provenance": receipt_provenance(run_receipts),
        "reproduction": cli.reproduction_inputs(),
        "inputs": provenance,
    }
    (out / "positive_control.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    if detected_by is None:
        miss_file.write_text(
            json.dumps(
                {
                    "a_star": float(a_star),
                    "plant": dict(configs[0]["plant"]),
                    "next_step": "failure tree (spec section 8): a code audit must find nothing, then one re-run "
                    "at the fresh plant seed 20261029 with audited=True; a second miss means the pipeline is "
                    "presumed insensitive",
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    return result


# ---------------------------------------------------------------------------
# The exit-control block (brief 28c)
# ---------------------------------------------------------------------------

EXIT_REPLAY_TOL = 1e-12
OPT_STOP_ALPHA = 0.01
OPT_STOP_PANELS = 20
OPT_STOP_DAYS = 75
OPT_STOP_SEED_BASE = 6000
OPT_STOP_VOL = 0.02
OPT_STOP_LOOSE_MIN_EARLY = 0.10
HOLD_SHARE_MIN = 0.8
FALSE_CLOSE_MAX = 0.2
CLOSE_AHEAD_MIN = 0.8
PLANT_SEED_BASE = 7000
PLANT_PANELS = 4
PLANT_PANEL_SEEDS: tuple[int, ...] = tuple(PLANT_SEED_BASE + 2 * k for k in range(PLANT_PANELS))
PLANT_EVENT_SEEDS: tuple[int, ...] = tuple(PLANT_SEED_BASE + 1 + 2 * k for k in range(PLANT_PANELS))
PLANT_DAYS = 100
PLANT_FIT_DAYS = 70
PLANT_COINS = 4
PLANT_VOL = 0.015
PLANT_MODEL_SEED = 7
DETERMINISM_FOLDS = 3
_ENTRY_ARRAYS = ("symbol", "side", "entry_ms", "entry_price")
_REPLAY_FIELDS = ("exit_ms", "exit_price", "exit_fill", "exit_reason")


def _exit_base_config() -> dict[str, Any]:
    """The noise control the exit block is derived from (ridge, fixed label, C4, seed 1)."""
    return next(c for c in noise_grid() if c["block"] == "ridge" and c["cell"] == "C4" and c["seed_ordinal"] == 1)


def _entry_frame(tranches: pd.DataFrame, h_ms: int | None = None) -> pd.DataFrame:
    """The entries of stored tranches as the exit engine takes them: T, entry stamp, scheduled exit, entry price."""
    from r4.method import ENTRY_DELAY_MS

    side = tranches["side"].map(lambda v: 1 if v in (1, "long", "buy") else -1).to_numpy(dtype=np.int64)
    entry = tranches["entry_ms"].to_numpy(dtype=np.int64)
    hold = tranches["h_ms"].to_numpy(dtype=np.int64) if h_ms is None else np.full(len(tranches), int(h_ms))
    return pd.DataFrame(
        {
            "symbol": tranches["symbol"].to_numpy(),
            "side": side,
            "T": entry - ENTRY_DELAY_MS,
            "entry_ms": entry,
            "exit_ms": entry + hold,
            "entry_price": tranches["entry_price"].to_numpy(dtype=np.float64),
        }
    )


def _run_panel(
    run_dir: Path, ds_dir: Path | str, panel: dict[str, dict[str, pd.DataFrame]] | None, config: dict[str, Any]
) -> dict[str, dict[str, pd.DataFrame]]:
    from r4.pipeline import load_panel
    from r4.plant import apply_plant

    if panel is None:
        panel = load_panel(Path(ds_dir), list(bar.read_manifest(ds_dir)["symbols"]))
    if config.get("plant") is not None:
        panel = apply_plant(panel, config["plant"])
    return panel


def check_replay_reproduces(
    run_dir: Path | str,
    ds_dir: Path | str,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
    replay: Callable[[pd.DataFrame], pd.DataFrame] | None = None,
) -> dict[str, Any]:
    """Rebuild the run's exit replay and feed it the run's OBSERVED entries (brief 28c, section 1).

    The entries are the stored tranches' symbols, sides, entry stamps (T is the stamp less the entry delay) and the
    scheduled exit entry + h. Every replayed exit_ms, exit_price, exit_fill and exit_reason must equal the stored
    tranche's, exactly for the integers and strings and to 1e-12 (relative to max(1, |price|)) for the price, NaN
    equal to NaN. A mismatch means the null's refitted fold models describe a different strategy than the observed
    run. replay may be passed to reuse an already built replay (its fold-model cache). Returns
    {"n", "mismatches", "first_mismatch", "by_field"}, mismatches counting rows.
    """
    d = Path(run_dir)
    receipt = json.loads((d / "receipt.json").read_text(encoding="utf-8"))
    tranches = pd.read_parquet(d / "tranches.parquet")
    n = len(tranches)
    if n == 0:
        return {"n": 0, "mismatches": 0, "first_mismatch": None, "by_field": dict.fromkeys(_REPLAY_FIELDS, 0)}
    if replay is None:
        folds = json.loads((d / "folds.json").read_text(encoding="utf-8"))
        replay = bar.build_exit_replay(_run_panel(d, ds_dir, panel, receipt["config"]), receipt["config"], folds)
    entries = _entry_frame(tranches)
    got = replay(entries).reset_index(drop=True)
    if len(got) != n:
        raise ValueError("the replay must return one row per stored tranche")
    bad = {
        "exit_ms": got["exit_ms"].to_numpy(dtype=np.int64) != tranches["exit_ms"].to_numpy(dtype=np.int64),
        "exit_fill": got["exit_fill"].to_numpy().astype(str) != tranches["exit_fill"].to_numpy().astype(str),
        "exit_reason": got["exit_reason"].to_numpy().astype(str) != tranches["exit_reason"].to_numpy().astype(str),
    }
    a = got["exit_price"].to_numpy(dtype=np.float64)
    b = tranches["exit_price"].to_numpy(dtype=np.float64)
    both_nan = np.isnan(a) & np.isnan(b)
    with np.errstate(invalid="ignore"):
        close = np.abs(a - b) <= EXIT_REPLAY_TOL * np.maximum(1.0, np.abs(b))
    bad["exit_price"] = ~(both_nan | close)
    any_bad = np.zeros(n, dtype=bool)
    for v in bad.values():
        any_bad |= v
    first: dict[str, Any] | None = None
    if any_bad.any():
        i = int(np.flatnonzero(any_bad)[0])
        field = next(f for f in _REPLAY_FIELDS if bad[f][i])
        first = {
            "row": i,
            "symbol": str(tranches["symbol"].iloc[i]),
            "entry_ms": int(tranches["entry_ms"].iloc[i]),
            "field": field,
            "stored": tranches[field].iloc[i].item()
            if hasattr(tranches[field].iloc[i], "item")
            else tranches[field].iloc[i],
            "replayed": got[field].iloc[i].item() if hasattr(got[field].iloc[i], "item") else got[field].iloc[i],
        }
    return {
        "n": int(n),
        "mismatches": int(any_bad.sum()),
        "first_mismatch": first,
        "by_field": {f: int(bad[f].sum()) for f in _REPLAY_FIELDS},
    }


def _flatten(prefix: str, obj: Any, out: dict[str, Any]) -> None:
    if isinstance(obj, dict):
        for k in obj:
            _flatten(f"{prefix}.{k}" if prefix else str(k), obj[k], out)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _flatten(f"{prefix}.{i}", v, out)
    else:
        out[prefix] = obj


def _receipt_differences(a: dict[str, Any], b: dict[str, Any]) -> list[str]:
    """Dotted paths at which two receipts differ, ignoring runtime_s. NaN equals NaN, floats compare exactly."""
    fa: dict[str, Any] = {}
    fb: dict[str, Any] = {}
    _flatten("", {k: v for k, v in a.items() if k != "runtime_s"}, fa)
    _flatten("", {k: v for k, v in b.items() if k != "runtime_s"}, fb)
    diff: list[str] = []
    for k in sorted(set(fa) | set(fb)):
        if k not in fa or k not in fb:
            diff.append(k)
            continue
        x, y = fa[k], fb[k]
        if isinstance(x, float) and isinstance(y, float) and math.isnan(x) and math.isnan(y):
            continue
        if x != y:
            diff.append(k)
    return diff


def _model_pairs_identical(
    panel: dict[str, dict[str, pd.DataFrame]], config: dict[str, Any], folds: Sequence[dict[str, Any]]
) -> tuple[int, list[str]]:
    """Fit the E4/E5 pair twice, independent factories, on up to three folds. Returns (fits, differences)."""
    from r4.exit_models import ExitModelFactory
    from r4.pipeline import run_config_from_raw

    cfg = run_config_from_raw(config)
    rows = sorted(folds, key=lambda f: int(f["start_ms"]))
    if not rows:
        return 0, []
    picks = sorted({0, len(rows) // 2, len(rows) - 1})[:DETERMINISM_FOLDS]
    refit_none = cfg.refit == "none"
    diffs: list[str] = []
    fx, fy = ExitModelFactory.from_config(panel, cfg), ExitModelFactory.from_config(panel, cfg)
    for i in picks:
        fold = rows[i]
        if refit_none:
            args: tuple[int | None, int] = (None, int(config["first_refit_ms"]))
        else:
            cut = fold.get("train_cut_ms")
            args = (None if cut is None else int(cut), int(fold["start_ms"]))
        mx, my = fx.fit(*args), fy.fit(*args)
        if (mx is None) != (my is None):
            diffs.append(f"fold {i}: one fit fell back")
            continue
        if mx is None or my is None:
            continue
        for f in dataclasses.fields(mx.pair):
            vx, vy = getattr(mx.pair, f.name), getattr(my.pair, f.name)
            if isinstance(vx, np.ndarray):
                same = bool(vx.dtype == vy.dtype and np.array_equal(vx, vy, equal_nan=True))
            else:
                same = bool(vx == vy)
            if not same:
                diffs.append(f"fold {i}: {f.name}")
    return len(picks), diffs


# -- synthetic martingale panels: optional stopping, median hold, planted intrabar control ------------------------


def _syn_cov(n_coins: int = 6) -> np.ndarray:
    return (OPT_STOP_VOL**2) * (0.3 * np.ones((n_coins, n_coins)) + 0.7 * np.eye(n_coins))


def _grid_entries(
    panel: dict[str, dict[str, pd.DataFrame]], start_ms: int, end_ms: int, interval_ms: int, h_ms: int, seed: int
) -> pd.DataFrame:
    """One entry per coin and decision time T on the interval grid in [start_ms, end_ms - h), random sides (seeded)."""
    from r4.method import ENTRY_DELAY_MS

    rng = np.random.default_rng(seed)
    first = -(-start_ms // interval_ms) * interval_ms
    grid = np.arange(first, end_ms - h_ms - 2 * interval_ms, interval_ms, dtype=np.int64)
    parts = []
    for sym in panel:
        t5 = panel[sym]["5m"]["t"].to_numpy(dtype=np.int64)
        o5 = panel[sym]["5m"]["o"].to_numpy(dtype=np.float64)
        entry = grid + ENTRY_DELAY_MS
        idx = np.searchsorted(t5, entry)
        px = o5[np.minimum(idx, len(o5) - 1)]
        parts.append(
            pd.DataFrame(
                {
                    "symbol": sym,
                    "side": np.where(rng.random(len(grid)) < 0.5, 1, -1).astype(np.int64),
                    "T": grid,
                    "entry_ms": entry,
                    "exit_ms": entry + h_ms,
                    "entry_price": px,
                }
            )
        )
    return pd.concat(parts, ignore_index=True)


def _cost_free_returns(bars: Mapping[str, Any], entries: pd.DataFrame, res: pd.DataFrame) -> np.ndarray:
    """side x log(exit price / entry price) per tranche. A horizon exit prices at the 5m open at its stamp."""
    px = res["exit_price"].to_numpy(dtype=np.float64).copy()
    stamp = res["exit_ms"].to_numpy(dtype=np.int64)
    horizon = (res["exit_reason"].to_numpy() == "horizon") | ~np.isfinite(px)
    sym = entries["symbol"].to_numpy()
    for s in np.unique(sym):
        rows = np.flatnonzero((sym == s) & horizon)
        if len(rows):
            b = bars[str(s)]
            idx = np.minimum(np.searchsorted(b.t, stamp[rows]), len(b.t) - 1)
            px[rows] = b.o[idx]
    side = entries["side"].to_numpy(dtype=np.float64)
    return side * np.log(px / entries["entry_price"].to_numpy(dtype=np.float64))


PLANT_FEATURES: tuple[str, ...] = ("taker_imb_last15", "ret_15m_last")


# The loosened model-exit rows of the optional-stopping check: same per-panel pair as the registered row, but
# thresholds that fire often, so the engine's model-exit path is exercised. The engine refuses margin_se <= 0 (and
# the replay re-parses every spec), so "margin 0" is margin_se 1e-12, which is zero for any practical purpose.
OPT_STOP_LOOSE: tuple[tuple[str, str], ...] = (("E4_loose", "E4"), ("E5_loose", "E5"))


_LOOSE_NAMES: frozenset[str] = frozenset(n for n, _ in OPT_STOP_LOOSE)


def _opt_met(rules: Mapping[str, Mapping[str, Any]]) -> bool:
    """Every row ok, and every loosened row present closed early on at least 10% of tranches (else it tests nothing)."""
    return bool(
        all(v["ok"] for v in rules.values()) and all(v["informative"] for n, v in rules.items() if n in _LOOSE_NAMES)
    )


def _opt_rows() -> list[tuple[str, Any]]:
    from r4.exits import parse_exit

    rows: list[tuple[str, Any]] = [(str(s["rule"]), parse_exit(s)) for s in EXIT_BLOCK_SPECS]
    rows.append(("E4_loose", parse_exit({"rule": "E4", "margin_se": 1e-12})))
    rows.append(("E5_loose", parse_exit({"rule": "E5", "p_close": 0.5, "confirm_bars": 1})))
    return rows


def _exit_study_panel(
    seed: int,
    n_days: int,
    rows: Sequence[tuple[str, Any]],
    start_ms: int = 1672531200000,
) -> dict[str, dict[str, np.ndarray]]:
    """One zero-drift synthetic panel and a fixed noise entry set, replayed under every row (name, parsed spec).

    The entry configuration is the exit block's (C4: 4h decisions, 8h hold). E4 and E5 (and their loosened rows)
    fit ONE pair on this panel's own first 60% (the cut), with the real features taker_imb_last15 and ret_15m_last,
    the block's 4h interval and hold and model seed 7, and are scored on entries after the cut. A model that learns
    leaked future information from those features would fire on it and profit. A fallback fit raises.
    """
    from r4.exit_models import ExitModelFactory
    from r4.exits import ExitContext
    from r4.pipeline import _panel_premium
    from r4.synth import synth_panel

    base = _exit_base_config()
    h_ms, interval_ms = int(base["h_ms"]), 4 * H1_MS
    end_ms = start_ms + n_days * DAY_MS
    panel = synth_panel(_syn_cov(), UNIVERSE[:6], start_ms, end_ms, seed)
    cut = start_ms + (n_days * 3 // 5) * DAY_MS
    entries = _grid_entries(panel, cut, end_ms, interval_ms, h_ms, seed + 1)
    settlements = {s: panel[s]["settlements"] for s in panel}
    ctx = ExitContext({s: panel[s]["5m"] for s in panel}, h_ms, premium=_panel_premium(panel), settlements=settlements)
    models: Any = None
    out: dict[str, dict[str, np.ndarray]] = {}
    for name, ps in rows:
        if ps.rule in ("E4", "E5"):
            if models is None:
                fac = ExitModelFactory(panel, "4h", h_ms, PLANT_FEATURES, PLANT_MODEL_SEED)
                models = fac.fit(None, cut)
                if models is None:
                    raise ValueError("the synthetic panel is too short to fit the E4/E5 models (fallback)")
            ctx.set_models(models)
        res = ctx.replay(entries, ps)
        ret = _cost_free_returns(ctx.bars, entries, res)
        hold = (res["exit_ms"].to_numpy(dtype=np.float64) - entries["entry_ms"].to_numpy(dtype=np.float64)) / float(
            h_ms
        )
        out[name] = {
            "returns": ret,
            "hold_share": hold,
            "early": (res["exit_reason"].to_numpy() != "horizon"),
        }
    return out


def optional_stopping_check(
    n_panels: int = OPT_STOP_PANELS,
    n_days: int = OPT_STOP_DAYS,
    rules: Sequence[str] | None = None,
    seed_base: int = OPT_STOP_SEED_BASE,
    alpha: float = OPT_STOP_ALPHA,
) -> dict[str, Any]:
    """The optional-stopping check (gate P code review, point 6), on zero-drift synthetic panels.

    The engine-replay null cannot see a look-ahead or fill bias in an exit, because shifted entries share it. On a
    martingale a legitimate exit has a zero cost-free mean per tranche, whatever the sides. Per rule and panel the
    mean of side x log(exit / entry) is taken over a fixed noise entry set (the same for every rule), then a one-sample
    t-test across the panels. Every row fails when the mean differs from zero two-sided at alpha, and X1 (a maker
    order that must not profit) also when it is positive one-sided at alpha. The check is met only when every row is
    ok and each loosened row closes early on at least 10% of tranches (else it exercises nothing and is not
    evaluated). Also records the pooled median hold as a share of h (the registered median-hold diagnostic uses it)
    and the share of tranches closed early.

    E4 and E5 fit on each panel's own real features (see _exit_study_panel), and the rows E4_loose and E5_loose
    replay the same pair at thresholds that fire often. Brief 28c fitted them on hash noise features (E4 never
    closed, E5 about 1%), and brief 28e on a planted panel whose flow pattern the zero-drift panels never show
    (E4 0%, E5 1.3%): both were blind to a look-ahead in a model exit.
    """
    from scipy import stats

    rows = [(n, ps) for n, ps in _opt_rows() if rules is None or n in rules]
    per: dict[str, dict[str, list[np.ndarray]]] = {n: {"returns": [], "hold": [], "early": []} for n, _ in rows}
    for k in range(n_panels):
        study = _exit_study_panel(seed_base + k, n_days, rows)
        for rule, d in study.items():
            per[rule]["returns"].append(d["returns"])
            per[rule]["hold"].append(d["hold_share"])
            per[rule]["early"].append(d["early"])
    out: dict[str, Any] = {}
    for rule, d in per.items():
        means = np.array([float(np.mean(r)) for r in d["returns"]])
        t, p2 = stats.ttest_1samp(means, 0.0)
        p_pos = float(p2 / 2.0 if t > 0 else 1.0 - p2 / 2.0)
        hold = np.concatenate(d["hold"])
        early = np.concatenate(d["early"])
        entry = {
            "panel_means": [float(m) for m in means],
            "mean": float(means.mean()),
            "sd": float(means.std(ddof=1)),
            "t": float(t),
            "p_two_sided": float(p2),
            "p_one_sided_positive": p_pos,
            "significant": bool(p2 < alpha),
            "positive": bool(p_pos < alpha),
            "n_tranches": int(sum(len(r) for r in d["returns"])),
            "median_hold_share": float(np.median(hold)),
            "early_share": float(early.mean()),
        }
        entry["ok"] = (not entry["significant"]) and (rule != "X1" or not entry["positive"])
        if rule in _LOOSE_NAMES:
            entry["informative"] = bool(entry["early_share"] >= OPT_STOP_LOOSE_MIN_EARLY)
        out[rule] = entry
    return {
        "n_panels": int(n_panels),
        "n_days": int(n_days),
        "alpha": float(alpha),
        "seed_base": int(seed_base),
        "rules": out,
        "met": _opt_met(out),
    }


def _planted_entries(panel: dict[str, dict[str, pd.DataFrame]], cut_ms: int, end_ms: int, h_ms: int) -> pd.DataFrame:
    """1h decisions at every hour top from the cut to 6 hours before the end, both sides, for every coin."""
    from r4.method import ENTRY_DELAY_MS

    top = np.arange(cut_ms, end_ms - 6 * H1_MS, H1_MS, dtype=np.int64)
    parts = []
    for sym in panel:
        t5 = panel[sym]["5m"]["t"].to_numpy(dtype=np.int64)
        o5 = panel[sym]["5m"]["o"].to_numpy(dtype=np.float64)
        entry = top + ENTRY_DELAY_MS
        px = o5[np.minimum(np.searchsorted(t5, entry), len(o5) - 1)]
        for side in (1, -1):
            parts.append(
                pd.DataFrame(
                    {
                        "symbol": sym,
                        "side": side,
                        "T": top,
                        "entry_ms": entry,
                        "exit_ms": entry + h_ms,
                        "entry_price": px,
                    }
                )
            )
    return pd.concat(parts, ignore_index=True)


def planted_intrabar_control(rules: Sequence[str] = ("E4", "E5", "E6")) -> dict[str, Any]:
    """The registered planted intrabar control (calibration spec lines 171 and 269): E4, E5 and E6 against E1.

    The planted reversal is the spec's (r4.plant.plant_events): taker flow in [e - 15m, e) shows it, the price ramps
    2% over [e + 30m, e + 90m), events are 6 to 15 hours apart. Setup: synth_panel with vol 0.015, 4 coins, 100 days,
    1h decisions at every hour top from day 70, a 4h hold, both sides, E4 and E5 fitted on the first 70 days with
    taker_imb_last15 and ret_15m_last (model seed 7) and evaluated after the cut. Registered seeds: 4 panels with
    panel seed 7000 + 2k and event seed 7001 + 2k, k = 0..3. Rates are pooled over the 4 panels. Per rule:
    - increment: the mean cost-free return of the rule minus E1's on the planted tranches (an adverse event inside
      the hold, see r4.plant.classify_events);
    - close_ahead_rate: the share of the planted tranches closed early at or before the start of the drop;
    - false_close_rate: the share of the unplanted tranches (no event near the hold) closed early;
    - n_planted and n_unplanted.
    A rule meets the prediction when increment > 0, close_ahead_rate >= 0.80 and false_close_rate <= 0.20.

    Disclosure: brief 28c's first design (a price burst with simultaneous flow and continued drift, false closes
    counted over every non-adverse tranche, favourable bursts included) measured E5 false closes of 22 to 29% at
    seeds 7000 to 7003. It was replaced because it was not the spec's design. Nothing here was tuned: a miss at the
    registered seeds is kept and reported.
    """
    from r4.exit_models import ExitModelFactory
    from r4.exits import ExitContext, parse_exit
    from r4.pipeline import _panel_premium
    from r4.plant import classify_events, plant_events
    from r4.synth import synth_panel

    start_ms = 1672531200000
    h_ms = 4 * H1_MS
    end_ms = start_ms + PLANT_DAYS * DAY_MS
    cut = start_ms + PLANT_FIT_DAYS * DAY_MS
    syms = list(UNIVERSE[:PLANT_COINS])
    cov = (PLANT_VOL**2) * (0.3 * np.ones((PLANT_COINS, PLANT_COINS)) + 0.7 * np.eye(PLANT_COINS))
    specs = {s["rule"]: s for s in EXIT_BLOCK_SPECS}
    acc: dict[str, dict[str, list[Any]]] = {r: {"inc": [], "ahead": [], "false": [], "per_seed": []} for r in rules}
    for panel_seed, event_seed in zip(PLANT_PANEL_SEEDS, PLANT_EVENT_SEEDS, strict=True):
        panel, events = plant_events(synth_panel(cov, syms, start_ms, end_ms, panel_seed), event_seed)
        entries = _planted_entries(panel, cut, end_ms, h_ms)
        planted, unplanted, drop_start = classify_events(entries, events)
        ctx = ExitContext(
            {s: panel[s]["5m"] for s in syms},
            h_ms,
            premium=_panel_premium(panel),
            settlements={s: panel[s]["settlements"] for s in syms},
        )
        base_ret = _cost_free_returns(ctx.bars, entries, ctx.replay(entries, parse_exit("horizon")))
        models: Any = None
        for rule in rules:
            if rule in ("E4", "E5"):
                if models is None:
                    models = ExitModelFactory(panel, "1h", h_ms, PLANT_FEATURES, PLANT_MODEL_SEED).fit(None, cut)
                    if models is None:
                        raise ValueError("the planted panel is too short to fit the E4/E5 models (fallback)")
                ctx.set_models(models)
            res = ctx.replay(entries, parse_exit(specs[rule]))
            ret = _cost_free_returns(ctx.bars, entries, res)
            early = res["exit_reason"].to_numpy() != "horizon"
            ahead = early & (res["exit_ms"].to_numpy(dtype=np.int64) <= drop_start)
            inc = (ret - base_ret)[planted]
            a = acc[rule]
            a["inc"].append(inc)
            a["ahead"].append(ahead[planted])
            a["false"].append(early[unplanted])
            a["per_seed"].append(
                {
                    "panel_seed": int(panel_seed),
                    "event_seed": int(event_seed),
                    "n_planted": int(planted.sum()),
                    "n_unplanted": int(unplanted.sum()),
                    "increment": float(inc.mean()) if len(inc) else float("nan"),
                    "close_ahead_rate": float(ahead[planted].mean()) if planted.any() else float("nan"),
                    "false_close_rate": float(early[unplanted].mean()) if unplanted.any() else float("nan"),
                }
            )
    out: dict[str, Any] = {}
    for rule in rules:
        a = acc[rule]
        inc, ahead, false = np.concatenate(a["inc"]), np.concatenate(a["ahead"]), np.concatenate(a["false"])
        inc_m = float(inc.mean()) if len(inc) else float("nan")
        ahead_r = float(ahead.mean()) if len(ahead) else float("nan")
        false_r = float(false.mean()) if len(false) else float("nan")
        out[rule] = {
            "spec": dict(specs[rule]),
            "increment": inc_m,
            "close_ahead_rate": ahead_r,
            "false_close_rate": false_r,
            "n_planted": int(len(inc)),
            "n_unplanted": int(len(false)),
            "per_seed": a["per_seed"],
            "met": bool(inc_m > 0.0 and ahead_r >= CLOSE_AHEAD_MIN and false_r <= FALSE_CLOSE_MAX),
        }
    return {
        "rules": out,
        "panel_seeds": list(PLANT_PANEL_SEEDS),
        "event_seeds": list(PLANT_EVENT_SEEDS),
        "n_panels": PLANT_PANELS,
        "n_days": PLANT_DAYS,
        "n_coins": PLANT_COINS,
        "vol": PLANT_VOL,
        "interval": "1h",
        "h_ms": h_ms,
        "fit_days": PLANT_FIT_DAYS,
        "model_seed": PLANT_MODEL_SEED,
        "features": list(PLANT_FEATURES),
        "min_close_ahead_rate": CLOSE_AHEAD_MIN,
        "max_false_close_rate": FALSE_CLOSE_MAX,
        "met": bool(all(v["met"] for v in out.values())),
    }


def _entry_key(tranches: pd.DataFrame) -> pd.DataFrame:
    """The entry set of a tranche table: symbol, side as +-1, entry stamp and entry price, in one fixed order."""
    side = tranches["side"].map(lambda v: 1 if v in (1, "long", "buy") else -1)
    key = pd.DataFrame(
        {
            "symbol": tranches["symbol"].astype(str).to_numpy(),
            "side": side.to_numpy(dtype=np.int64),
            "entry_ms": tranches["entry_ms"].to_numpy(dtype=np.int64),
            "entry_price": tranches["entry_price"].to_numpy(dtype=np.float64),
        }
    )
    return key.sort_values(["symbol", "entry_ms", "side"], kind="stable").reset_index(drop=True)


def _cost_free_mean(daily: pd.DataFrame) -> float:
    return float((daily["gross_hedged"] + daily["funding"]).mean())


def _run_or_reuse(
    cfg_file: Path, raw: dict[str, Any], ds: Path, runs: Path, commit: str | None, panel: Any
) -> dict[str, Any]:
    """Run a config with run_wf, or reuse a finished run of the same config hash, commit, source and dataset.

    A run is reused only when its config hash, its commit, its r4 source digest and its dataset hash all match the
    code and the dataset in hand (brief 28g, C-1): a run made by other code or on another dataset raises.
    """
    from r4 import cli

    rc = runs / str(raw["id"]) / "receipt.json"
    if rc.exists():
        receipt = json.loads(rc.read_text(encoding="utf-8"))
        if receipt.get("config_hash") != cli.config_hash_of(raw):
            raise ValueError(f"{rc} holds a different configuration: refusing to overwrite it")
        if receipt.get("commit") != cli.resolve_commit(commit):
            raise ValueError(f"{rc} was run at commit {receipt.get('commit')!r}, not {commit!r}: code freeze")
        if receipt.get("source_sha256") != cli.source_digest():
            raise ValueError(f"{rc} was run with another r4 source digest than the code in hand: code freeze")
        manifest_hash = str(bar.read_manifest(ds)["datasetHash"])
        if receipt.get("dataset_hash") != manifest_hash:
            raise ValueError(
                f"{rc} was run on dataset {receipt.get('dataset_hash')!r}, the dataset in hand is {manifest_hash!r}"
            )
        return receipt  # type: ignore[no-any-return]
    return cli.run_wf(cfg_file, ds, runs, commit=commit, panel=panel)


def evaluate_exit_block(
    ds_dir: Path | str,
    noise_runs_dir: Path | str,
    out_dir: Path | str,
    commit: str | None = None,
    *,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
    joint_draws: int | None = None,
    first_refit_ms: int | None = None,
    span_end_ms: int | None = None,
    synthetic_panels: int = OPT_STOP_PANELS,
    synthetic_days: int = OPT_STOP_DAYS,
    determinism: bool = True,
) -> dict[str, Any]:
    """The exit-control block (calibration spec 6 and 12 N5, A1.6, brief 28c).

    Runs the 6 exit_block() configs (kind control) with run_wf on the dataset (a finished run of the same config
    hash and commit under out_dir/runs is reused). Per config, in this order, each of which raises ValueError:
    - E4/E5 with a walk-forward exit-model fallback fold (the run is not the configuration under test);
    - an entry set that differs from the base noise control's (noise_*_ridge_C4_s1 in noise_runs_dir);
    - a replay that does not reproduce the stored exits (check_replay_reproduces);
    - an observed statistic that differs from the replay path at zero shift.
    Then the engine-replay joint-shift null (joint_draws, default 1,000, the config's joint_shift_seed), p and
    rejected (p < 0.05), and the diagnostics: median hold as a share of h, exit-reason counts and fire rates, the
    counters, and the increment of the drift-free mean against the base (E1) run. The block adds the optional-stopping
    check, the two registered diagnostics (median hold and the planted intrabar control) and a determinism check.
    Gated: at most 1 of 6 rejected. first_refit_ms and span_end_ms (default 2023-01-01 and DEV_END) and the
    synthetic_* sizes exist so tests can use small panels.
    """
    from r4.exits import parse_exit

    ds = Path(ds_dir)
    out = Path(out_dir)
    draws = int(BAR["random_entry_draws"]) if joint_draws is None else int(joint_draws)
    span_end = DEV_END if span_end_ms is None else int(span_end_ms)
    cli = _cli()
    base_cfg = _exit_base_config()
    if first_refit_ms is not None:
        base_cfg = {**base_cfg, "first_refit_ms": int(first_refit_ms)}
    base_dir = Path(noise_runs_dir) / base_cfg["id"]
    if not (base_dir / "receipt.json").exists():
        raise ValueError(f"the base noise control {base_cfg['id']} has no run in {noise_runs_dir}")
    base_receipt = json.loads((base_dir / "receipt.json").read_text(encoding="utf-8"))
    manifest_hash = str(bar.read_manifest(ds)["datasetHash"])
    # The base run supplies the entry set and the increments against E1, so it is checked before anything runs.
    if base_receipt.get("config_hash") != cli.config_hash_of(base_cfg):
        raise ValueError(f"the base noise control {base_cfg['id']} does not carry the registered configuration hash")
    if base_receipt.get("commit") != cli.resolve_commit(commit):
        raise ValueError(
            f"the base noise control {base_cfg['id']} was run at commit {base_receipt.get('commit')!r}, "
            f"not {commit!r}: code freeze"
        )
    if base_receipt.get("dataset_hash") != manifest_hash:
        raise ValueError(
            f"the base noise control {base_cfg['id']} ran on dataset {base_receipt.get('dataset_hash')!r}, "
            f"the dataset in hand is {manifest_hash!r}"
        )
    base_tr = pd.read_parquet(base_dir / "tranches.parquet")
    base_key = _entry_key(base_tr)
    base_cf = _cost_free_mean(pd.read_parquet(base_dir / "daily.parquet"))
    if panel is None:
        from r4.pipeline import load_panel

        panel = load_panel(ds, list(bar.read_manifest(ds)["symbols"]))

    # A-9: the base E1 configuration's own joint-shift p, under the same replay path, draws and the base config's
    # seed, so a reader can tell the base entries' place in their own null from what the exits add.
    base_folds = json.loads((base_dir / "folds.json").read_text(encoding="utf-8"))
    base_stats = bar.joint_shift_stats(
        base_tr,
        panel,
        base_folds,
        span_start_ms=int(base_receipt["config"]["first_refit_ms"]),
        span_end_ms=span_end,
        n_draws=draws,
        min_shift_days=int(BAR["random_entry_shift_min_days"]),
        seed=int(base_receipt["config"]["joint_shift_seed"]),
        exit_replay=bar.build_exit_replay(panel, base_receipt["config"], base_folds),
    )
    p_e1, p_e1_drop = bar.joint_shift_p(base_stats, draws)

    cfg_dir = out / "configs"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    runs = out / "runs"
    configs = exit_block()
    rows: list[dict[str, Any]] = []
    receipts: list[dict[str, Any]] = []
    for cfg in configs:
        if first_refit_ms is not None:
            cfg["first_refit_ms"] = int(first_refit_ms)
        f = cfg_dir / f"{cfg['id']}.json"
        f.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        receipt = _run_or_reuse(f, cfg, ds, runs, commit, panel)
        _check_receipts_dataset([receipt], manifest_hash, f"exit control {cfg['id']}")
        receipts.append(receipt)
        rule = parse_exit(cfg["exit"]).rule
        m = receipt["metrics"]
        if rule in ("E4", "E5") and int(m.get("exit_model_fallback_folds", 0)) > 0:
            raise ValueError(
                f"{cfg['id']}: {m['exit_model_fallback_folds']} walk-forward fold(s) fell back to E1 (exit-model "
                "fallback): the run is not the configuration under test"
            )
        d = runs / cfg["id"]
        tr = pd.read_parquet(d / "tranches.parquet")
        folds = json.loads((d / "folds.json").read_text(encoding="utf-8"))
        key = _entry_key(tr)
        if not key.equals(base_key):
            raise ValueError(
                f"{cfg['id']}: entry set differs from the base control {base_cfg['id']} "
                f"({len(key)} against {len(base_key)} entries)"
            )
        replay = bar.build_exit_replay(panel, receipt["config"], folds)
        rep = check_replay_reproduces(d, ds, panel=panel, replay=replay)
        if rep["mismatches"] > 0:
            raise ValueError(
                f"{cfg['id']}: the exit replay does not reproduce the run's stored exits "
                f"({rep['mismatches']} of {rep['n']} tranches, first {rep['first_mismatch']})"
            )
        first_ms = int(receipt["config"]["first_refit_ms"])
        stats = bar.joint_shift_stats(
            tr,
            panel,
            folds,
            span_start_ms=first_ms,
            span_end_ms=span_end,
            n_draws=draws,
            min_shift_days=int(BAR["random_entry_shift_min_days"]),
            seed=int(receipt["config"]["joint_shift_seed"]),
            exit_replay=replay,
            zero_shift=True,
        )
        obs, zero = stats.obs_stat, stats.zero_shift_stat
        if zero is None or not (
            (math.isnan(obs) and math.isnan(zero)) or abs(obs - zero) <= EXIT_REPLAY_TOL * max(1.0, abs(obs))
        ):
            raise ValueError(f"{cfg['id']}: shift-zero identity broken: observed {obs!r} against replay path {zero!r}")
        anchor = _book_anchor(tr, stats, pd.read_parquet(d / "daily.parquet"), label=str(cfg["id"]))
        p, drop = bar.joint_shift_p(stats, draws)
        n = int(len(tr))
        reasons = tr["exit_reason"].astype(str).value_counts()
        counts = {str(r): int(c) for r, c in sorted(reasons.items())}
        h_ms = tr["h_ms"].to_numpy(dtype=np.float64)
        hold_share = (tr["exit_ms"].to_numpy(dtype=np.float64) - tr["entry_ms"].to_numpy(dtype=np.float64)) / h_ms
        daily = pd.read_parquet(d / "daily.parquet")
        denom = max(n, 1)
        rows.append(
            {
                "id": cfg["id"],
                "config_hash": str(receipt["config_hash"]),
                "rule": rule,
                "exit": cfg["exit"],
                "p": p,
                "rejected": bool(p < _REJECT_P),
                "draws": draws,
                "seed": int(receipt["config"]["joint_shift_seed"]),
                "drop_share": drop,
                "observed": float(obs) if np.isfinite(obs) else None,
                "entries_match_base": True,
                "n_entries": n,
                "replay_reproduction": {"n": rep["n"], "mismatches": rep["mismatches"]},
                "shift_zero": {
                    "observed": float(obs),
                    "replayed": float(zero),
                    "abs_diff": float(abs(obs - zero)),
                    "ok": True,
                },
                "anchor": anchor,
                "counters": {
                    "missing_model_share": float(m["missing_model_tranches"]) / denom,
                    "missing_sigma_share": float(m["missing_sigma_tranches"]) / denom,
                    "missing_flow_share": float(m["missing_flow_tranches"]) / denom,
                    "missing_funding_share": float(m["missing_funding_tranches"]) / denom,
                    "joint_shift_drop_share": drop,
                    "exit_model_folds": int(m.get("exit_model_folds", 0)),
                    "exit_model_fallback_folds": int(m.get("exit_model_fallback_folds", 0)),
                },
                "fire_rates": {
                    "by_reason_counts": counts,
                    "by_reason_share": {r: c / denom for r, c in counts.items()},
                    "early_share": float(1.0 - counts.get("horizon", 0) / denom),
                    "never_fires": bool(counts.get("horizon", 0) == n),
                },
                "repeats_e1": bool(counts.get("horizon", 0) == n),
                "median_hold_share_of_h": float(np.median(hold_share)) if n else float("nan"),
                "wf_mean": float(m["wf_mean"]),
                "cost_free_mean": _cost_free_mean(daily),
                "increment_vs_e1": {
                    "wf_mean": float(m["wf_mean"]) - float(base_receipt["metrics"]["wf_mean"]),
                    "cost_free_mean": _cost_free_mean(daily) - base_cf,
                },
            }
        )

    det: dict[str, Any] = {"identical": None, "differences": [], "rules": [], "skipped": not determinism}
    if determinism:
        diffs: list[str] = []
        det_runs = out / "runs_repeat"
        n_fits = 0
        coef_rules: list[str] = []
        for cfg, first in zip(configs, receipts, strict=True):
            rule = parse_exit(cfg["exit"]).rule
            again = _run_or_reuse(cfg_dir / f"{cfg['id']}.json", cfg, ds, det_runs, commit, panel)
            diffs += [f"{rule}: receipt {x}" for x in _receipt_differences(first, again)]
            for name in ("tranches", "daily"):
                a = pd.read_parquet(runs / cfg["id"] / f"{name}.parquet")
                b = pd.read_parquet(det_runs / cfg["id"] / f"{name}.parquet")
                if not a.equals(b):
                    diffs.append(f"{rule}: {name}.parquet")
            if (runs / cfg["id"] / "folds.json").read_text(encoding="utf-8") != (
                det_runs / cfg["id"] / "folds.json"
            ).read_text(encoding="utf-8"):
                diffs.append(f"{rule}: folds.json")
            det["rules"].append(rule)
            if rule in ("E4", "E5"):
                folds = json.loads((runs / cfg["id"] / "folds.json").read_text(encoding="utf-8"))
                fits, md = _model_pairs_identical(panel, first["config"], folds)
                n_fits += fits
                coef_rules.append(rule)
                diffs += [f"{rule}: model {x}" for x in md]
        det.update(
            {
                "identical": not diffs,
                "differences": diffs,
                "model_coefficients_compared": coef_rules,
                "model_fits_compared": n_fits,
            }
        )

    opt = optional_stopping_check(synthetic_panels, synthetic_days)
    planted = planted_intrabar_control()
    hold_rules = {
        r: {
            "median_share": opt["rules"][r]["median_hold_share"],
            "n_tranches": opt["rules"][r]["n_tranches"],
            "early_share": opt["rules"][r]["early_share"],
        }
        for r in ("E4", "E5", "E6")
    }
    diagnostics = {
        "median_hold": {
            "threshold": HOLD_SHARE_MIN,
            "rules": hold_rules,
            "n_panels": opt["n_panels"],
            "met": bool(all(v["median_share"] >= HOLD_SHARE_MIN for v in hold_rules.values())),
        },
        "planted_intrabar": planted,
    }
    n_rej = sum(r["rejected"] for r in rows)
    return {
        "configs": rows,
        "rejected": int(n_rej),
        "n_rejected": int(n_rej),
        "gated_max": 1,
        "as_predicted": bool(n_rej <= 1),
        "dataset_hash": manifest_hash,
        "span_end_ms": int(span_end),
        "base": {
            "id": base_cfg["id"],
            "n_entries": int(len(base_key)),
            "wf_mean": float(base_receipt["metrics"]["wf_mean"]),
            "cost_free_mean": base_cf,
            "p_e1": p_e1,
            "p_e1_drop_share": p_e1_drop,
            "joint_shift_seed": int(base_receipt["config"]["joint_shift_seed"]),
            "draws": draws,
        },
        "never_fires": [r["rule"] for r in rows if r["fire_rates"]["never_fires"]],
        "optional_stopping": opt,
        "determinism": det,
        "diagnostics": diagnostics,
        "provenance": receipt_provenance([*receipts, base_receipt]),
        "reproduction": cli.reproduction_inputs(),
    }


# ---------------------------------------------------------------------------
# The dossier
# ---------------------------------------------------------------------------

_SHA_HEX = re.compile(r"[0-9a-f]{7,40}")
_REJECT_P = float(BAR["random_entry_p_max"])
N_RETESTS = 6
N_EXIT_CONFIGS = 6


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _count(v: Any, name: str, maximum: int | None = None) -> int:
    if not _is_int(v) or v < 0 or (maximum is not None and v > maximum):
        bound = "" if maximum is None else f" and at most {maximum}"
        raise ValueError(f"{name} must be a non-negative integer{bound}, got {v!r}")
    return int(v)


def _rate(v: Any, name: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0.0 <= v <= 1.0:
        raise ValueError(f"{name} must be a rate in [0, 1], got {v!r}")
    return float(v)


def _load_json(path: Path | str, name: str) -> tuple[Any, dict[str, str]]:
    from r4.data import sha256_file

    p = Path(path)
    if not p.is_file():
        raise ValueError(f"dossier input {name} is missing: {p}")
    return json.loads(p.read_text(encoding="utf-8")), {"path": str(p.resolve()), "sha256": sha256_file(p)}


def _check_wilson(v: Any, name: str) -> None:
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise ValueError(f"{name} must be a pair of rates")
    lo, hi = _rate(v[0], f"{name}[0]"), _rate(v[1], f"{name}[1]")
    if lo > hi:
        raise ValueError(f"{name} is not ordered: {v!r}")


def _validate_null(d: Any) -> tuple[int, int]:
    if not isinstance(d, dict):
        raise ValueError("null_simulation must be a JSON object")
    n = d.get("parameters", {}).get("n_paths") if isinstance(d.get("parameters"), dict) else None
    n = _count(n, "null_simulation.parameters.n_paths")
    if n < 1:
        raise ValueError("null_simulation.parameters.n_paths must be positive")
    count = _count(d.get("crossing_count"), "null_simulation.crossing_count", n)
    rate = _rate(d.get("crossing_rate"), "null_simulation.crossing_rate")
    if abs(rate - count / n) > 1e-9:
        raise ValueError(f"null_simulation.crossing_rate {rate} disagrees with {count}/{n}")
    _check_wilson(d.get("wilson_95"), "null_simulation.wilson_95")
    return count, n


def _validate_noise(d: Any) -> dict[str, Any]:
    if not isinstance(d, dict):
        raise ValueError("noise_eval must be a JSON object")
    n = _count(d.get("n_configs"), "noise_eval.n_configs")
    gated = d.get("gated")
    if not isinstance(gated, dict):
        raise ValueError("noise_eval.gated is missing")
    for key in ("n_pass_items_1_to_3", "n_reject_joint_shift_05"):
        _count(gated.get(key), f"noise_eval.gated.{key}", n)
    verdict = d.get("verdict")
    if not isinstance(verdict, dict):
        raise ValueError("noise_eval.verdict is missing")
    for pid, v in verdict.items():
        if pid not in PREDICTIONS:
            raise ValueError(f"noise_eval.verdict has an unregistered prediction {pid!r}")
        if not isinstance(v, dict) or v.get("met") not in (True, False, None):
            raise ValueError(f"noise_eval.verdict[{pid!r}].met must be true, false or null")
    return verdict  # type: ignore[no-any-return]


def _validate_power(d: Any) -> dict[str, Any]:
    if not isinstance(d, dict) or not isinstance(d.get("curve_at_1_2v"), dict):
        raise ValueError("power must be an object with curve_at_1_2v")
    for a, e in d["curve_at_1_2v"].items():
        n = _count(e.get("n") if isinstance(e, dict) else None, f"power curve {a} n")
        if n < 1:
            raise ValueError(f"power curve {a}: n must be positive")
        det = _count(e.get("detected"), f"power curve {a} detected", n)
        rate = _rate(e.get("rate"), f"power curve {a} rate")
        if abs(rate - det / n) > 1e-9:
            raise ValueError(f"power curve {a}: rate {rate} disagrees with {det}/{n}")
        _check_wilson(e.get("wilson95"), f"power curve {a} wilson95")
    star = d.get("a_star")
    if not isinstance(star, dict) or not isinstance(star.get("infeasible"), bool):
        raise ValueError("power.a_star must be an object with a boolean infeasible")
    value = star.get("a_star")
    if star["infeasible"] != (value is None):
        raise ValueError("power.a_star: infeasible must be true exactly when a_star is null")
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0):
        raise ValueError(f"power.a_star.a_star must be a positive number, got {value!r}")
    return star  # type: ignore[no-any-return]


def _check_power_parameters(d: dict[str, Any], star: dict[str, Any]) -> None:
    """The registered power parameters (brief 28g, C-1): margin, draws, trials, replicates and the amplitude grid."""
    if not _same_number(d.get("margin"), POWER_MARGIN):
        raise ValueError(f"power.margin is {d.get('margin')!r}, registered {POWER_MARGIN}")
    if d.get("joint_draws") != POWER_JOINT_DRAWS or not _is_int(d.get("joint_draws")):
        raise ValueError(f"power.joint_draws is {d.get('joint_draws')!r}, registered {POWER_JOINT_DRAWS}")
    if d.get("n_trials") != N_TRIALS_CALIBRATION or not _is_int(d.get("n_trials")):
        raise ValueError(f"power.n_trials is {d.get('n_trials')!r}, registered {N_TRIALS_CALIBRATION}")
    curve = {float(a): e for a, e in d["curve_at_1_2v"].items()}
    for a, e in curve.items():
        if e["n"] != POWER_REPLICATES:
            raise ValueError(f"power curve {a}: {e['n']} replicates, registered {POWER_REPLICATES}")
    grid = d.get("grid")
    if (
        not isinstance(grid, list)
        or not grid
        or not all(isinstance(g, (int, float)) and not isinstance(g, bool) and g > 0 for g in grid)
        or any(x >= y for x, y in zip(grid, grid[1:], strict=False))
    ):
        raise ValueError("power.grid must list the registered amplitudes, positive and strictly increasing")
    extensions = star.get("extensions", [])
    doubled = (
        [float(max(grid)) * 2.0 ** (k + 1) for k in range(len(extensions))] if isinstance(extensions, list) else None
    )
    if (
        doubled is None
        or len(extensions) > POWER_MAX_DOUBLINGS
        or not all(_same_number(x, y) for x, y in zip(extensions, doubled, strict=True))
    ):
        raise ValueError("power.a_star.extensions must be the registered doublings of the grid maximum")
    allowed = [float(g) for g in grid] + doubled
    stray = sorted(a for a in curve if not any(math.isclose(a, g, rel_tol=1e-12) for g in allowed))
    if stray:
        raise ValueError(f"power curve amplitudes {stray} are outside the registered grid {grid}")
    qualifying = sorted(a for a, e in curve.items() if float(e["rate"]) >= POWER_TARGET - 1e-12)
    if star["infeasible"]:
        if qualifying:
            raise ValueError(f"power.a_star is infeasible but amplitudes {qualifying} reach {POWER_TARGET}")
        return
    value = float(star["a_star"])
    if not qualifying or not math.isclose(qualifying[0], value, rel_tol=1e-12):
        raise ValueError(f"power.a_star {value} is not the smallest evaluated amplitude with a rate of {POWER_TARGET}")
    below = [float(g) for g in grid if float(g) < value]
    if below and not any(math.isclose(max(below), a, rel_tol=1e-12) for a in curve):
        raise ValueError(f"power.a_star {value}: the next lower grid amplitude {max(below)} was never evaluated")


def _validate_positive(d: Any) -> Any:
    if not isinstance(d, dict) or d.get("detected") not in (True, False, None):
        raise ValueError("positive_control must be an object with detected true, false or null")
    return d["detected"]


def _recompute_positive(pos: dict[str, Any]) -> tuple[bool, str | None]:
    """Detection as the failure tree defines it, from the recorded per-item results (brief 28g, C-5).

    A pc_P1 or pc_P2 detects when items 1 to 6 all pass and its label-shift tripwire ran and did not halt.
    """
    report = pos.get("report")
    configs = report.get("configurations") if isinstance(report, dict) else None
    tripwires = pos.get("tripwires")
    if not isinstance(configs, dict) or not isinstance(tripwires, dict):
        raise ValueError("positive_control needs report.configurations and tripwires to recompute detection")
    by: str | None = None
    for rid in ("pc_P1", "pc_P2"):
        ev = configs.get(rid)
        if not isinstance(ev, dict):
            raise ValueError(f"positive_control.report.configurations lacks {rid}")
        items = [ev.get(f"item{i}") for i in range(1, 7)]
        if not all(isinstance(it, dict) and isinstance(it.get("pass"), bool) for it in items):
            raise ValueError(f"positive_control {rid}: items 1 to 6 need a boolean pass")
        all_pass = all(it["pass"] for it in items)
        if ev.get("all_pass") is not all_pass:
            raise ValueError(f"positive_control {rid}: all_pass {ev.get('all_pass')!r} disagrees with its items")
        tw = tripwires.get(rid)
        if all_pass and isinstance(tw, dict) and tw.get("halt") is False and by is None:
            by = rid
    return by is not None, by


def _validate_retests(rows: Sequence[Any]) -> int:
    if len(rows) != N_RETESTS:
        raise ValueError(f"expected {N_RETESTS} native re-test receipts, got {len(rows)}")
    rules: set[str] = set()
    n_pass = 0
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("rule"), str) or not isinstance(r.get("pass"), bool):
            raise ValueError("a re-test receipt needs a string rule and a boolean pass")
        if r.get("kind") != "retest":
            raise ValueError(f"re-test receipt for {r['rule']!r} is not kind 'retest'")
        hurdles = r.get("hurdles")
        if not isinstance(hurdles, list) or not all(isinstance(h, dict) for h in hurdles):
            raise ValueError(f"re-test receipt for {r['rule']!r} lists no hurdles")
        applied = [h for h in hurdles if h.get("status") == "applied"]
        if not applied:
            raise ValueError(
                f"re-test receipt for {r['rule']!r} has no applied hurdle: a rule with nothing applied is not evaluated"
            )
        if not all(isinstance(h.get("pass"), bool) for h in applied):
            raise ValueError(f"re-test receipt for {r['rule']!r}: an applied hurdle needs a boolean pass")
        if r["pass"] is not all(h["pass"] for h in applied):
            raise ValueError(f"re-test receipt for {r['rule']!r}: pass disagrees with its applied hurdles")
        rules.add(r["rule"])
        n_pass += int(r["pass"])
    if len(rules) != N_RETESTS:
        raise ValueError("the native re-test receipts name duplicate rules")
    return n_pass


def _validate_family_spa(spa: Any, rules: set[str]) -> None:
    """The re-test family SPA is evidence only (no prediction reads it): its shape must still be the registered one."""
    if not isinstance(spa, dict):
        raise ValueError("family_spa must be a JSON object")
    if spa.get("n_rules") != N_RETESTS or not _is_int(spa.get("n_rules")):
        raise ValueError(f"family_spa.n_rules is {spa.get('n_rules')!r}, expected {N_RETESTS}")
    _rate(spa.get("spa_p"), "family_spa.spa_p")
    if "rules" in spa and (not isinstance(spa["rules"], list) or set(spa["rules"]) != rules):
        raise ValueError("family_spa.rules differ from the re-tested rules")


def _check_optional_stopping(opt: dict[str, Any]) -> None:
    """Recompute every optional-stopping flag from the recorded p-values (brief 28g, C-5, C-4, A-2)."""
    if not _same_number(opt.get("alpha"), OPT_STOP_ALPHA):
        raise ValueError(f"exit_block.optional_stopping.alpha is {opt.get('alpha')!r}, registered {OPT_STOP_ALPHA}")
    rules = opt["rules"]
    for rule, e in rules.items():
        p2 = _rate(e.get("p_two_sided"), f"optional_stopping {rule} p_two_sided")
        pp = _rate(e.get("p_one_sided_positive"), f"optional_stopping {rule} p_one_sided_positive")
        significant, positive = bool(p2 < OPT_STOP_ALPHA), bool(pp < OPT_STOP_ALPHA)
        ok = (not significant) and (rule != "X1" or not positive)
        for key, want in (("significant", significant), ("positive", positive), ("ok", ok)):
            if e.get(key) is not want:
                raise ValueError(
                    f"exit_block.optional_stopping.rules.{rule}.{key} is {e.get(key)!r}, recomputed {want!r} from "
                    f"p {p2} (two-sided) and {pp} (one-sided positive) at alpha {OPT_STOP_ALPHA}"
                )
        if rule in _LOOSE_NAMES:
            informative = bool(
                _rate(e.get("early_share"), f"optional_stopping {rule} early_share") >= OPT_STOP_LOOSE_MIN_EARLY
            )
            if e.get("informative") is not informative:
                raise ValueError(
                    f"exit_block.optional_stopping.rules.{rule}.informative is {e.get('informative')!r}, "
                    f"recomputed {informative!r} from its early share"
                )
    if opt.get("met") is not _opt_met(rules):
        raise ValueError(f"exit_block.optional_stopping.met is {opt.get('met')!r}, recomputed {_opt_met(rules)!r}")


def _check_diagnostics(diag: dict[str, Any]) -> None:
    """Recompute the median-hold and planted-control verdicts from their recorded numbers (brief 28g, C-5)."""
    mh = diag["median_hold"]
    if not _same_number(mh.get("threshold"), HOLD_SHARE_MIN):
        raise ValueError(f"median_hold.threshold is {mh.get('threshold')!r}, registered {HOLD_SHARE_MIN}")
    hold = mh.get("rules")
    if not isinstance(hold, dict) or set(hold) != {"E4", "E5", "E6"}:
        raise ValueError("median_hold.rules must cover exactly E4, E5 and E6")
    shares = []
    for r, e in hold.items():
        v = e.get("median_share") if isinstance(e, dict) else None
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ValueError(f"median_hold.rules.{r}.median_share must be a finite number")
        shares.append(float(v))
    if mh["met"] is not bool(all(v >= HOLD_SHARE_MIN for v in shares)):
        raise ValueError("median_hold.met disagrees with the median shares")
    pl = diag["planted_intrabar"]
    if not _same_number(pl.get("min_close_ahead_rate"), CLOSE_AHEAD_MIN) or not _same_number(
        pl.get("max_false_close_rate"), FALSE_CLOSE_MAX
    ):
        raise ValueError("planted_intrabar thresholds differ from the registered 0.8 and 0.2")
    prules = pl.get("rules")
    if not isinstance(prules, dict) or set(prules) != {"E4", "E5", "E6"}:
        raise ValueError("planted_intrabar.rules must cover exactly E4, E5 and E6")
    for r, e in prules.items():
        vals = [
            e.get(k) if isinstance(e, dict) else None for k in ("increment", "close_ahead_rate", "false_close_rate")
        ]
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in vals):
            raise ValueError(f"planted_intrabar.rules.{r}: increment and both rates must be finite numbers")
        want = bool(vals[0] > 0.0 and vals[1] >= CLOSE_AHEAD_MIN and vals[2] <= FALSE_CLOSE_MAX)
        if e.get("met") is not want:
            raise ValueError(f"planted_intrabar.rules.{r}.met is {e.get('met')!r}, recomputed {want!r}")
    if pl["met"] is not bool(all(e["met"] for e in prules.values())):
        raise ValueError("planted_intrabar.met disagrees with its rules")


def _validate_exit_block(d: Any) -> int:
    """An exit-block result as the registered evaluation writes it (briefs 28e, 28g). Returns the gated count.

    Refuses unless the 6 configs carry the registered ids and config hashes in order, and every row ran the
    registered draws and joint-shift seed with a clean replay reproduction, shift-zero identity, book anchor and
    entry match. The span must end at DEV_END, and the base E1 p must be recorded under the base config's seed. The
    determinism check must have run and be identical. The optional-stopping check must cover the eight rows at the
    registered sizes and seed base, and the planted control the registered seeds and sizes. Both diagnostics must
    be present, and every verdict flag is recomputed from the numbers beside it.
    """
    from r4.cli import config_hash_of

    if not isinstance(d, dict):
        raise ValueError("exit_block must be a JSON object")
    cfgs = d.get("configs")
    if not isinstance(cfgs, list) or len(cfgs) != N_EXIT_CONFIGS:
        raise ValueError(f"exit_block.configs must list {N_EXIT_CONFIGS} configurations")
    if d.get("span_end_ms") != DEV_END or not _is_int(d.get("span_end_ms")):
        raise ValueError(f"exit_block.span_end_ms is {d.get('span_end_ms')!r}, registered {DEV_END} (DEV_END)")
    base = d.get("base")
    base_cfg = _exit_base_config()
    if (
        not isinstance(base, dict)
        or base.get("id") != base_cfg["id"]
        or base.get("joint_shift_seed") != base_cfg["joint_shift_seed"]
        or base.get("draws") != int(BAR["random_entry_draws"])
    ):
        raise ValueError("exit_block.base must record the base control's id, joint-shift seed and registered draws")
    _rate(base.get("p_e1"), "exit_block.base.p_e1")
    registered = exit_block()
    n_rej = 0
    for i, (c, reg) in enumerate(zip(cfgs, registered, strict=True)):
        if not isinstance(c, dict) or not isinstance(c.get("id"), str) or not c["id"]:
            raise ValueError("every exit_block config needs a non-empty string id")
        if c["id"] != reg["id"]:
            raise ValueError(f"exit_block config {i} is {c['id']!r}, registered {reg['id']!r}")
        if c.get("config_hash") != config_hash_of(reg):
            raise ValueError(f"exit_block {c['id']} does not match its registered config hash")
        p = _rate(c.get("p"), f"exit_block {c['id']} p")
        if not isinstance(c.get("rejected"), bool):
            raise ValueError(f"exit_block {c['id']}: rejected must be a boolean")
        if c["rejected"] != (p < _REJECT_P):
            raise ValueError(f"exit_block {c['id']}: rejected disagrees with p {p} against {_REJECT_P}")
        if c.get("draws") != int(BAR["random_entry_draws"]) or not _is_int(c.get("draws")):
            raise ValueError(f"exit_block {c['id']}: draws {c.get('draws')!r}, registered {BAR['random_entry_draws']}")
        if c.get("seed") != reg["joint_shift_seed"] or not _is_int(c.get("seed")):
            raise ValueError(
                f"exit_block {c['id']}: joint-shift seed {c.get('seed')!r}, registered {reg['joint_shift_seed']}"
            )
        rep = c.get("replay_reproduction")
        if not isinstance(rep, dict) or rep.get("mismatches") != 0 or not _is_int(rep.get("mismatches")):
            raise ValueError(f"exit_block {c['id']}: the exit replay must reproduce the stored exits (mismatches 0)")
        sz = c.get("shift_zero")
        if not isinstance(sz, dict) or sz.get("ok") is not True:
            raise ValueError(f"exit_block {c['id']}: the shift-zero identity must hold")
        anchor = c.get("anchor")
        if not isinstance(anchor, dict) or anchor.get("checked") is not True or anchor.get("ok") is not True:
            raise ValueError(f"exit_block {c['id']}: the book anchor must be checked and hold")
        rel = anchor.get("rel_diff")
        if isinstance(rel, bool) or not isinstance(rel, (int, float)) or not math.isfinite(rel):
            raise ValueError(f"exit_block {c['id']}: the book anchor needs a finite relative difference")
        if rel > BOOK_ANCHOR_TOL and not (isinstance(anchor.get("explained"), str) and anchor["explained"]):
            raise ValueError(f"exit_block {c['id']}: an unexplained book-anchor difference of {rel:.3e}")
        if c.get("entries_match_base") is not True:
            raise ValueError(f"exit_block {c['id']}: the entry set must match the base control")
        fire = c.get("fire_rates")
        never = fire.get("never_fires") if isinstance(fire, dict) else None
        if not isinstance(never, bool) or c.get("repeats_e1") is not never:
            raise ValueError(f"exit_block {c['id']}: repeats_e1 must be recorded and equal never_fires")
        n_rej += int(c["rejected"])
    if _count(d.get("n_rejected"), "exit_block.n_rejected", N_EXIT_CONFIGS) != n_rej:
        raise ValueError(f"exit_block.n_rejected {d['n_rejected']} disagrees with the {n_rej} rejected configs")

    det = d.get("determinism")
    if not isinstance(det, dict) or det.get("skipped") is not False or det.get("identical") is not True:
        raise ValueError("exit_block.determinism must have run (skipped false) and be identical")

    opt = d.get("optional_stopping")
    if not isinstance(opt, dict):
        raise ValueError("exit_block.optional_stopping is missing")
    for key, want in (("n_panels", OPT_STOP_PANELS), ("n_days", OPT_STOP_DAYS), ("seed_base", OPT_STOP_SEED_BASE)):
        if opt.get(key) != want or not _is_int(opt.get(key)):
            raise ValueError(f"exit_block.optional_stopping.{key} is {opt.get(key)!r}, registered {want}")
    rules = opt.get("rules")
    want_rules = {str(s["rule"]) for s in EXIT_BLOCK_SPECS} | {n for n, _ in OPT_STOP_LOOSE}
    if not isinstance(rules, dict) or set(rules) != want_rules:
        raise ValueError(f"exit_block.optional_stopping.rules must cover exactly {sorted(want_rules)}")
    for rule, entry in rules.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("ok"), bool):
            raise ValueError(f"exit_block.optional_stopping.rules.{rule}.ok must be a boolean")
    _check_optional_stopping(opt)

    diag = d.get("diagnostics")
    if not isinstance(diag, dict):
        raise ValueError("exit_block.diagnostics is missing")
    for key in ("median_hold", "planted_intrabar"):
        entry = diag.get(key)
        if not isinstance(entry, dict) or not isinstance(entry.get("met"), bool):
            raise ValueError(f"exit_block.diagnostics.{key}.met must be a boolean")
    pl = diag["planted_intrabar"]
    for key, want in (
        ("panel_seeds", list(PLANT_PANEL_SEEDS)),
        ("event_seeds", list(PLANT_EVENT_SEEDS)),
        ("n_panels", PLANT_PANELS),
        ("n_days", PLANT_DAYS),
        ("n_coins", PLANT_COINS),
    ):
        if pl.get(key) != want:
            raise ValueError(f"exit_block.diagnostics.planted_intrabar.{key} is {pl.get(key)!r}, registered {want}")
    _check_diagnostics(diag)
    return n_rej


NULL_PATHS = 50_000
NULL_DAYS = 730
NULL_THRESHOLD = 600.0
NULL_SEED = 20261025
NULL_PILOT_SEED = 20261024


def _same_number(a: Any, b: Any) -> bool:
    ok = (int, float)
    return (
        isinstance(a, ok)
        and isinstance(b, ok)
        and not isinstance(a, bool)
        and not isinstance(b, bool)
        and math.isclose(float(a), float(b), rel_tol=1e-12, abs_tol=0.0)
    )


def _check_null_parameters(nul: dict[str, Any]) -> None:
    params = nul["parameters"]
    wanted = {"n_paths": NULL_PATHS, "n_days": NULL_DAYS, "threshold": NULL_THRESHOLD}
    for key, want in wanted.items():
        if not _same_number(params.get(key), want):
            raise ValueError(f"null_simulation.parameters.{key} is {params.get(key)!r}, registered {want}")
    if nul.get("seed") != NULL_SEED:
        raise ValueError(f"null_simulation.seed is {nul.get('seed')!r}, registered {NULL_SEED}")
    pilot = nul.get("pilot")
    if not isinstance(pilot, dict) or pilot.get("seed") != NULL_PILOT_SEED:
        raise ValueError(f"null_simulation.pilot.seed must be the registered pilot seed {NULL_PILOT_SEED}")


def _check_noise_set(noi: dict[str, Any]) -> None:
    """The 40 registered noise_grid() ids and config hashes, after any recorded trade-floor replacement."""
    from r4.cli import config_hash_of

    rows = noi.get("noise_set")
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise ValueError("noise_eval.noise_set must list the evaluated configurations")
    registered = noise_grid()
    if len(rows) != len(registered):
        raise ValueError(f"noise_eval.noise_set has {len(rows)} configurations, registered {len(registered)}")
    claimed: set[int] = set()
    for g in registered:
        mine = [i for i, r in enumerate(rows) if r.get("id") == g["id"] or r.get("replaces") == g["id"]]
        if len(mine) != 1:
            raise ValueError(f"noise control {g['id']} must appear exactly once (original or its replacement)")
        row = rows[mine[0]]
        if row.get("id") == g["id"]:
            want = config_hash_of(g)
            if row.get("replaces") is not None or row.get("attempt") is not None:
                raise ValueError(f"noise control {g['id']} is marked as a replacement but keeps the registered id")
        else:
            attempt = row.get("attempt")
            if attempt not in (1, 2) or isinstance(attempt, bool):
                raise ValueError(f"noise replacement of {g['id']} has attempt {attempt!r}, only 1 and 2 exist")
            alt = noise_alternative(g, int(attempt))
            if row.get("id") != alt["id"]:
                raise ValueError(f"noise replacement of {g['id']} has id {row.get('id')!r}, registered {alt['id']!r}")
            want = config_hash_of(alt)
        if row.get("config_hash") != want:
            raise ValueError(f"noise control {row.get('id')} does not match its registered config hash")
        claimed.add(mine[0])
    if len(claimed) != len(rows):
        raise ValueError("noise_eval.noise_set holds a configuration that is not in the registered grid")
    # A1.9: the rows must also be the registered final set (the V panel's trade-floor replacements), in any order.
    for f in noise_final_set():
        hits = [r for r in rows if r.get("id") == f["id"]]
        row = hits[0] if len(hits) == 1 else None
        if (
            row is None
            or row.get("config_hash") != config_hash_of(f)
            or row.get("replaces") != f.get("replaces")
            or row.get("attempt") != f.get("attempt")
        ):
            raise ValueError(f"noise control {f['id']} is not in the registered final noise set (A1.9)")


_FREEZE_KEYS = ("commits", "source_sha256", "requirements_lock_sha256", "versions")


def _freeze_values(name: str, obj: Any) -> dict[str, set[str]]:
    """The code-freeze evidence of one dossier input: its receipts' provenance and the code that evaluated them.

    Per key (commit, source digest, requirements-lock hash, library versions) the receipts' values and the
    evaluation-time reproduction record contribute to one set. A missing or non-string value raises.
    """
    prov = obj.get("provenance") if isinstance(obj, dict) else None
    repro = obj.get("reproduction") if isinstance(obj, dict) else None
    if not isinstance(prov, dict):
        raise ValueError(f"{name} carries no provenance (commit, source, lock and versions of its receipts)")
    if not isinstance(repro, dict):
        raise ValueError(f"{name} carries no reproduction record of the code that evaluated it")
    out: dict[str, set[str]] = {}
    for key in _FREEZE_KEYS:
        vals = prov.get(key)
        if not isinstance(vals, list) or not vals:
            raise ValueError(f"{name}.provenance.{key} must list the receipts' values")
        if key == "versions":
            if not all(isinstance(v, dict) and v for v in vals):
                raise ValueError(f"{name}.provenance.versions must list library-version maps")
            got = {_canon(v) for v in vals}
        else:
            if not all(isinstance(v, str) and v for v in vals):
                raise ValueError(f"{name}.provenance.{key} must list the receipts' string values")
            got = set(vals)
        if key == "commits":
            pass  # the evaluation-time record has no commit: it is the code, not a git object
        elif key == "versions":
            rv = repro.get("versions")
            if not isinstance(rv, dict) or not rv:
                raise ValueError(f"{name}.reproduction.versions must be a library-version map")
            got.add(_canon(rv))
        else:
            rv = repro.get(key)
            if not isinstance(rv, str) or not rv:
                raise ValueError(f"{name}.reproduction.{key} must be a string")
            got.add(rv)
        out[key] = got
    return out


def _check_code_freeze(named: dict[str, Any], retests: Sequence[Any]) -> str:
    """Every input shares ONE commit, source digest, lock hash and library-version map (spec section 8 code freeze).

    The inputs are the evaluation outputs (each with its receipts' provenance and the evaluation-time reproduction
    record), the daily null simulation, and the re-test receipts. Returns the frozen commit.
    """
    pools: dict[str, set[str]] = {k: set() for k in _FREEZE_KEYS}
    for name, obj in named.items():
        for key, vals in _freeze_values(name, obj).items():
            pools[key] |= vals
    for i, r in enumerate(retests):
        for key, rkey in zip(
            _FREEZE_KEYS, ("commit", "source_sha256", "requirements_lock_sha256", "versions"), strict=True
        ):
            v = r.get(rkey)
            if key == "versions":
                if not isinstance(v, dict) or not v:
                    raise ValueError(f"retests[{i}] needs a library-version map")
                pools[key].add(_canon(v))
            else:
                if not isinstance(v, str) or not v:
                    raise ValueError(f"retests[{i}] needs a {rkey}")
                pools[key].add(v)
    for key, vals in pools.items():
        if len(vals) != 1:
            raise ValueError(f"inputs must share one {key}, found {sorted(vals)}")
    return next(iter(pools["commits"]))


def _check_one_dataset(named: dict[str, Any], retests: Sequence[Any]) -> str:
    """One D dataset hash across every input that carries one (brief 28g, C-1). Returns it."""
    seen: dict[str, str] = {}

    def add(label: str, v: Any) -> None:
        if not isinstance(v, str) or not v:
            raise ValueError(f"{label} carries no dataset hash")
        seen[label] = v

    for name, obj in named.items():
        if name == "null_simulation":
            add("null_simulation.dcov_dataset_hash", obj.get("dcov_dataset_hash"))
        elif name == "power":
            add("power.dcov_dataset_hash", obj.get("dcov_dataset_hash"))
        else:
            add(f"{name}.dataset_hash", obj.get("dataset_hash"))
            prov = obj.get("provenance", {}).get("dataset_hash")
            if not isinstance(prov, list) or not prov:
                raise ValueError(f"{name}.provenance carries no dataset hash of its receipts")
            for j, v in enumerate(prov):
                add(f"{name}.provenance.dataset_hash[{j}]", v)
    for i, r in enumerate(retests):
        add(f"retests[{i}].dataset_hash", r.get("dataset_hash"))
    if len(set(seen.values())) != 1:
        raise ValueError(f"the inputs span more than one dataset: {seen}")
    return next(iter(seen.values()))


def _check_positive_binding(pos: dict[str, Any], star: dict[str, Any], pwr: dict[str, Any], v_noise: float) -> None:
    from r4.cli import config_hash_of
    from r4.tripwire import SHIFT_DAYS

    if not _same_number(pos.get("a_star"), star.get("a_star")):
        raise ValueError(
            f"positive_control.a_star {pos.get('a_star')!r} differs from power.a_star {star.get('a_star')!r}"
        )
    if pos.get("n_trials") != N_TRIALS_CALIBRATION:
        raise ValueError(f"positive_control.n_trials must be {N_TRIALS_CALIBRATION}, got {pos.get('n_trials')!r}")
    var = pos.get("variance")
    if not isinstance(var, dict) or not _same_number(var.get("V"), v_noise):
        raise ValueError("positive_control.variance.V differs from the noise evaluation's V")
    plant = pos.get("plant")
    seed = plant.get("seed") if isinstance(plant, dict) else None
    rerun = pos.get("rerun")
    if rerun is True:
        legal = seed == PC_RERUN_PLANT_SEED
    elif rerun is False:
        legal = seed == PLANT_SEED
    else:
        legal = False
    if not legal:
        raise ValueError(
            f"positive_control plant seed {seed!r} with rerun {rerun!r} is not {PLANT_SEED}, "
            f"or {PC_RERUN_PLANT_SEED} for the one re-run"
        )
    if pos.get("tripwire_shifts") != len(SHIFT_DAYS) or not _is_int(pos.get("tripwire_shifts")):
        raise ValueError(
            f"positive_control.tripwire_shifts is {pos.get('tripwire_shifts')!r}, registered {len(SHIFT_DAYS)}"
        )
    family = pc_rerun_family(float(star["a_star"])) if rerun else pc_family(float(star["a_star"]))
    want_hashes = {c["id"]: config_hash_of(c) for c in family}
    if pos.get("config_hashes") != want_hashes:
        raise ValueError(
            "positive_control.config_hashes differ from the registered "
            f"{'pc_rerun_family' if rerun else 'pc_family'}(a*): a shortened first refit or other decoys were run"
        )
    detected, by = _recompute_positive(pos)
    if pos.get("detected") is not detected or pos.get("detected_by") != by:
        raise ValueError(
            f"positive_control.detected {pos.get('detected')!r} by {pos.get('detected_by')!r} disagrees with the "
            f"recomputed {detected!r} by {by!r}"
        )


def _expected_receipt_ids(
    noi: dict[str, Any], exb: dict[str, Any], pos: dict[str, Any] | None, retests: Sequence[Any]
) -> dict[str, set[str] | None]:
    """The receipt ids each prediction's evidence must list. None means any non-empty list (the daily null)."""
    exp: dict[str, set[str] | None] = {}
    noise_ids = {str(r["id"]) for r in noi["noise_set"]}
    exit_ids = {str(c["id"]) for c in exb["configs"]}
    rules = {str(r["rule"]) for r in retests}
    for pid in PREDICTIONS:
        if pid.startswith("noise_"):
            exp[pid] = noise_ids
        elif pid.startswith("exit_"):
            exp[pid] = exit_ids
        elif pid == "natives_all_six_fail":
            exp[pid] = rules
        elif pid == "positive_detected_at_astar":
            exp[pid] = None if pos is None else set(pos["config_hashes"])
        else:
            exp[pid] = None
    return exp


def _bind_commit_order(order: dict[str, Any], commit: str, expected: dict[str, set[str] | None]) -> None:
    """The commit-order evidence must be about the frozen commit's receipts (brief 28g, C-2).

    Every receipt commit listed under a prediction equals the frozen commit (a short sha is accepted when it is a
    prefix of it), and every input receipt id of that prediction appears among them.
    """
    for pid, entry in order["predictions"].items():
        for rc in entry["receipts"]:
            sha = rc["commit"]
            if not (commit.startswith(sha) or sha.startswith(commit)):
                raise ValueError(
                    f"commit_order {pid}: receipt {rc.get('id')!r} is at {sha}, not the frozen commit {commit}"
                )
        want = expected.get(pid)
        if want is not None:
            have = {str(rc.get("id")) for rc in entry["receipts"]}
            missing = sorted(want - have)
            if missing:
                raise ValueError(f"commit_order {pid}: input receipts {missing} are not listed")


def _validate_commit_order(d: Any) -> dict[str, Any]:
    """{"predictions": {id: {"registration_commit": sha, "receipts": [{"id", "commit", "is_ancestor": True}]}}}.

    is_ancestor is the lead's `git merge-base --is-ancestor <registration> <receipt commit>` result. Every registered
    prediction needs an entry with at least one receipt, and every receipt must be marked an ancestor.
    """
    preds = d.get("predictions") if isinstance(d, dict) else None
    if not isinstance(preds, dict):
        raise ValueError("commit_order must be an object with predictions")
    if set(preds) != set(PREDICTIONS):
        missing, extra = sorted(set(PREDICTIONS) - set(preds)), sorted(set(preds) - set(PREDICTIONS))
        raise ValueError(f"commit_order predictions differ from the registry: missing {missing}, unregistered {extra}")
    for pid, entry in preds.items():
        reg = entry.get("registration_commit") if isinstance(entry, dict) else None
        if not isinstance(reg, str) or not _SHA_HEX.fullmatch(reg):
            raise ValueError(f"commit_order {pid}: registration_commit must be a 7 to 40 character lowercase hex sha")
        receipts = entry.get("receipts")
        if not isinstance(receipts, list) or not receipts:
            raise ValueError(f"commit_order {pid}: needs at least one receipt")
        for rc in receipts:
            sha = rc.get("commit") if isinstance(rc, dict) else None
            if not isinstance(sha, str) or not _SHA_HEX.fullmatch(sha):
                raise ValueError(f"commit_order {pid}: a receipt commit must be a 7 to 40 character lowercase hex sha")
            if rc.get("is_ancestor") is not True:
                raise ValueError(
                    f"commit_order {pid}: receipt {rc.get('id')!r} is not marked as built after its registration"
                )
    return d  # type: ignore[no-any-return]


def write_dossier(
    out_path: Path | str,
    *,
    null_simulation: Path | str,
    noise_eval: Path | str,
    power: Path | str,
    positive_control: Path | str,
    retests: Sequence[Path | str],
    commit_order: dict[str, Any],
    exit_block: Path | str | None,
    family_spa: Path | str | None = None,
) -> dict[str, Any]:
    """Assemble the Phase 4 dossier once: every registered prediction against its observed value.

    Inputs are JSON files, each referenced by absolute path and sha256. exit_block is required (brief 28e). The
    dossier refuses unless every input is bound to ONE D dataset hash, ONE commit, r4 source digest, requirements-lock
    hash and library-version map (receipts and the evaluation-time record alike, the daily null and the re-tests
    included), to the registered parameters (power margin, draws, trials, replicates and grid, positive-control
    tripwire count and configurations, the exit null's span, the re-tests' calibration V), and to the receipts the
    commit-order evidence lists (brief 28g). Every verdict flag is recomputed from the numbers beside it. family_spa
    is optional evidence that no prediction reads: when given, its shape is validated. gate_p_ready is true when
    every GATED prediction is as predicted. It is evidence for the review and is not the Gate P decision.
    commit_order is the lead's git evidence, validated here (the research image has no git). All inputs are
    validated before the file is created with exclusive create.
    """
    refs: dict[str, Any] = {}
    nul, refs["null_simulation"] = _load_json(null_simulation, "null_simulation")
    noi, refs["noise_eval"] = _load_json(noise_eval, "noise_eval")
    pwr, refs["power"] = _load_json(power, "power")
    pos, refs["positive_control"] = _load_json(positive_control, "positive_control")
    spa: Any = None
    if family_spa is not None:
        spa, refs["family_spa"] = _load_json(family_spa, "family_spa")
    rts: list[Any] = []
    refs["retests"] = []
    for i, f in enumerate(retests):
        obj, ref = _load_json(f, f"retests[{i}]")
        rts.append(obj)
        refs["retests"].append(ref)
    if exit_block is None:
        raise ValueError("exit_block is required: run the exit-control block (calib-exits) first")
    exb, refs["exit_block"] = _load_json(exit_block, "exit_block")

    n_cross, n_paths = _validate_null(nul)
    _check_null_parameters(nul)
    verdict = _validate_noise(noi)
    star = _validate_power(pwr)
    detected = _validate_positive(pos)
    n_native_pass = _validate_retests(rts)
    n_exit_rej = _validate_exit_block(exb)
    order = _validate_commit_order(commit_order)
    if spa is not None:
        _validate_family_spa(spa, {str(r["rule"]) for r in rts})

    _check_noise_set(noi)
    v_noise = noi.get("variance", {}).get("V") if isinstance(noi.get("variance"), dict) else None
    if isinstance(v_noise, bool) or not isinstance(v_noise, (int, float)) or not math.isfinite(v_noise) or v_noise <= 0:
        raise ValueError("noise_eval.variance.V must be a positive number")
    if not _same_number(pwr.get("v"), v_noise):
        raise ValueError(f"power.v {pwr.get('v')!r} differs from the noise evaluation's V {v_noise!r}")
    _check_power_parameters(pwr, star)
    for i, r in enumerate(rts):
        if not _same_number(r.get("calib_v"), v_noise):
            raise ValueError(f"retests[{i}].calib_v {r.get('calib_v')!r} differs from the noise evaluation's V")
    frozen: dict[str, Any] = {"null_simulation": nul, "noise_eval": noi, "power": pwr}
    if star["infeasible"]:
        pass  # no a* to plant: there is no positive-control run to bind
    else:
        _check_positive_binding(pos, star, pwr, float(v_noise))
        frozen["positive_control"] = pos
    frozen["exit_block"] = exb
    _check_one_dataset(frozen, rts)
    commit = _check_code_freeze(frozen, rts)
    _bind_commit_order(order, commit, _expected_receipt_ids(noi, exb, None if star["infeasible"] else pos, rts))

    predictions: dict[str, dict[str, Any]] = {}

    def put(pid: str, observed: Any, met: bool | None, evidence: str) -> None:
        spec = PREDICTIONS[pid]
        predictions[pid] = {
            "status": spec["status"],
            "text": spec["text"],
            "gated": spec["status"] == "gated",
            "observed": observed,
            "as_predicted": None if met is None else bool(met),
            "evidence": evidence,
        }

    for pid in PREDICTIONS:
        if pid.startswith("noise_"):
            v = verdict.get(pid)
            put(pid, None if v is None else v.get("observed"), None if v is None else v.get("met"), "noise_eval")
    rate = n_cross / n_paths
    put("daily_null_crossing_rate_at_most_1_over_600", rate, rate <= 1.0 / 600.0, "null_simulation")
    put(
        "daily_null_at_most_10_crossings",
        n_cross,
        n_cross <= 10 and float(nul["wilson_95"][0]) <= 1.0 / 600.0,
        "null_simulation",
    )
    if star["infeasible"]:
        put("positive_detected_at_astar", {"detected": None, "infeasible": True}, False, "power")
    else:
        put("positive_detected_at_astar", detected, None if detected is None else bool(detected), "positive_control")
    put("natives_all_six_fail", n_native_pass, n_native_pass == 0, "retests")
    put(
        "exit_block_at_most_1_of_6_rejects",
        n_exit_rej,
        n_exit_rej <= 1,
        "exit_block",
    )
    diag = exb["diagnostics"]
    put("exit_median_hold_at_least_80pct", diag["median_hold"].get("rules"), diag["median_hold"]["met"], "exit_block")
    put(
        "exit_planted_intrabar_control",
        diag["planted_intrabar"].get("rules"),
        diag["planted_intrabar"]["met"],
        "exit_block",
    )
    opt_ok = {r: bool(v["ok"]) for r, v in exb["optional_stopping"]["rules"].items()}
    put("exit_optional_stopping_zero_mean", opt_ok, bool(exb["optional_stopping"]["met"]), "exit_block")
    missing = sorted(set(PREDICTIONS) - set(predictions))
    if missing:
        raise ValueError(f"predictions without an evaluation rule: {missing}")

    gate_ready = all(p["as_predicted"] is True for p in predictions.values() if p["gated"])
    doc = {
        "version": 1,
        "created_utc": datetime.now(UTC).isoformat(),
        "inputs": refs,
        "predictions": predictions,
        "gate_p_ready": bool(gate_ready),
        "gate_p_note": "Evidence only. The Opus review decides Gate P, not this file.",
        "power": {"a_star": star, "curve_at_1_2v": pwr["curve_at_1_2v"]},
        "commit_order": order,
    }
    if spa is not None:
        doc["family_spa"] = spa
    target = Path(out_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(doc, indent=2))
    return doc


__all__ = [
    "CELLS",
    "check_replay_reproduces",
    "evaluate_exit_block",
    "optional_stopping_check",
    "planted_intrabar_control",
    "POWER_RUN_IDS",
    "adaptive_order",
    "choose_a_star",
    "extend_amplitude",
    "pc_rerun_family",
    "positive_control",
    "power_curve",
    "power_curve_at_margin",
    "power_family",
    "power_simulation",
    "write_dossier",
    "EXIT_BLOCK_SPECS",
    "P2_PRICE_FEATURES",
    "PREDICTIONS",
    "cov_betas_from_daily_closes",
    "d_daily_covariance",
    "daily_null_input",
    "evaluate_noise",
    "exit_block",
    "noise_alternative",
    "noise_final_set",
    "noise_grid",
    "pc_family",
    "trade_floor_ok",
]
