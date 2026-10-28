"""Phase 4 calibration: the registered grids, the D covariance input and the noise-control evaluation.

Sources: calibration spec sections 3 to 5, 9 and 12 (section 12 wins), and the owner amendment of 2026-10-28 (the
trial-Sharpe variance V is pooled within cost cells, and calibration uses the same V as round close).

Everything here is a pure function of its inputs. noise_grid, exit_block and pc_family only build config dicts. The
evaluation reads finished run directories and calls the `r4.bar` functions, never a re-implementation.
"""

from __future__ import annotations

import copy
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4 import bar
from r4.book import DAY_MS
from r4.data import load_perp
from r4.method import BAR, DEV_END, DEV_START

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
        "diagnostic", "E4, E5 and E6 beat E1 on planted tranches with a false-close rate of at most 20%."
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
            "tranches": pd.read_parquet(tr_file) if tr_file.exists() else pd.DataFrame(),
            "folds": json.loads((p / "folds.json").read_text(encoding="utf-8")),
        }
    if not runs:
        raise ValueError(f"no control runs found in {runs_dir}")
    return runs


def _cost_free_frame(daily: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame(
        {"drift_free": (daily["gross_hedged"] + daily["funding"]).to_numpy(dtype=np.float64)}, index=daily.index
    )


def _binom_tail(n: int, p: float, k: int) -> float:
    return float(sum(math.comb(n, j) * p**j * (1 - p) ** (n - j) for j in range(k, n + 1)))


def _cost_free_diagnostics(
    runs: dict[str, dict[str, Any]], v_within: float, v_cost_free: float | None
) -> dict[str, Any]:
    ids = sorted(runs)
    if any("gross_hedged" not in runs[i]["daily"].columns or "funding" not in runs[i]["daily"].columns for i in ids):
        return {"error": "daily.parquet has no gross_hedged and funding columns"}
    cf = {i: _cost_free_frame(runs[i]["daily"]) for i in ids}
    for i in ids:
        cf[i].attrs["config_hash"] = runs[i]["daily"].attrs["config_hash"]
    item2_cf = bar.item2(cf)
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
        r3 = bar.item3(receipt, v_within, N_TRIALS_CALIBRATION, candidate_daily=cf[i])
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
        "item1": {i: per_config[i]["item1"]["pass"] for i in ids},
        "item3": {i: per_config[i]["item3"]["pass"] for i in ids},
        "configs": per_config,
        "group_pbo": group_pbo,
    }


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
    if panel is None:
        panel = load_panel(Path(ds_dir), list(manifest["symbols"]))

    round_daily = {i: runs[i]["daily"] for i in ids}
    round_configs = {i: runs[i]["receipt"]["config"] for i in ids}
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

    item2_res = bar.item2({i: runs[i]["daily"] for i in ids})

    configs: dict[str, Any] = {}
    for i in ids:
        run = runs[i]
        cfg = run["receipt"]["config"]
        res1 = bar.item1(run["receipt"])
        res3 = bar.item3(run["receipt"], v_within, N_TRIALS_CALIBRATION, candidate_daily=run["daily"])
        res3["variance_mode"] = "within_cell"
        seed = int(cfg["joint_shift_seed"])
        p, drop, obs, _ = bar.joint_shift_null(
            run["tranches"],
            panel,
            run["folds"],
            span_start_ms=int(cfg["first_refit_ms"]),
            span_end_ms=DEV_END,
            n_draws=draws,
            min_shift_days=int(BAR["random_entry_shift_min_days"]),
            seed=seed,
        )
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
            "pass_items_1_to_3": bool(res1["pass"] and item2_res["pass"] and res3["pass"]),
        }

    n = len(ids)
    n_pass = sum(c["pass_items_1_to_3"] for c in configs.values())
    rej_p = float(BAR["random_entry_p_max"])
    n_rej = sum(c["joint_shift"]["p"] < rej_p for c in configs.values())

    cost_free = _cost_free_diagnostics(runs, v_within, None if v_cf is None else float(v_cf))
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
    put("noise_joint_shift_reference_panels", int(n_rej), None)  # judged against 2 synthetic panels, not computed here

    gate_ok = all(v["met"] for v in verdict.values() if v["status"] == "gated")
    return {
        "n_configs": n,
        "dataset_hash": str(manifest["datasetHash"]),
        "configs": configs,
        "item2": item2_res,
        "variance": {"mode": "within_cell", "V": v_within, "modes": variance_modes},
        "gated": {
            "n_pass_items_1_to_3": int(n_pass),
            "n_reject_joint_shift_05": int(n_rej),
            "bounds": {"items_1_to_3_max": 5, "joint_shift_reject_max": 6},
        },
        "diagnostics": diagnostics,
        "verdict": verdict,
        "gate_ok": bool(gate_ok),
    }


__all__ = [
    "CELLS",
    "EXIT_BLOCK_SPECS",
    "P2_PRICE_FEATURES",
    "PREDICTIONS",
    "cov_betas_from_daily_closes",
    "d_daily_covariance",
    "daily_null_input",
    "evaluate_noise",
    "exit_block",
    "noise_alternative",
    "noise_grid",
    "pc_family",
    "trade_floor_ok",
]
