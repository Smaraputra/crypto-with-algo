"""Tests for r4.cli and r4.bar: run receipts, CPCV paths, stress variants, and exploration bar."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4.bar import (
    family_report,
    item1,
    item2,
    item3,
    item5,
    item6,
    joint_shift_null,
    shift_tranche_times,
)
from r4.book import Tranche, beta_hedged_daily, daily_book
from r4.cli import (
    config_hash_of,
    cpcv_path_drift_free,
    cpcv_path_layout,
    restrict_to_d,
    run_wf,
    stress_metrics,
)
from r4.costs import coin_slippage_bps, resolve_fee_profile
from r4.method import (
    BAR,
    CPCV_GROUPS,
    CPCV_TEST_GROUPS,
    DEV_END,
    DEV_START,
    UNIVERSE,
)
from r4.pipeline import (
    RunConfig,
    decision_samples,
    walk_forward,
)
from r4.validation import cpcv_path_ids

DAY = 86_400_000
COMMIT = "abc1234"


def _make_fast_synthetic_panel(
    symbols: tuple[str, ...] = UNIVERSE[:6],
    n_days: int = 120,
    start_ms: int = 1672531200000,  # 2023-01-01 UTC
    seed: int = 42,
    inject_signal: bool = False,
) -> dict[str, dict[str, pd.DataFrame]]:
    """Generate a consistent multi-timeframe synthetic panel."""
    panel: dict[str, dict[str, pd.DataFrame]] = {}

    for sym_idx, sym in enumerate(symbols):
        sym_seed = seed + sym_idx * 1000 + 13
        rng = np.random.default_rng(sym_seed)

        n_5m = n_days * 288
        t_5m = start_ms + np.arange(n_5m, dtype=np.int64) * 300_000
        n_1h = n_days * 24

        if inject_signal:
            ret_1h = np.zeros(n_1h, dtype=np.float64)
            innovations = rng.normal(0.0, 0.005, size=n_1h)
            for k in range(1, n_1h):
                ret_1h[k] = 0.65 * ret_1h[k - 1] + innovations[k]
            ret_5m = np.repeat(ret_1h / 12.0, 12) + rng.normal(0.0, 0.0001, size=n_5m)
        else:
            ret_5m = rng.normal(0.0, 0.0005, size=n_5m)

        p_5m = 100.0 * np.exp(np.cumsum(ret_5m))
        o_5m = np.concatenate(([100.0], p_5m[:-1]))
        c_5m = p_5m
        h_5m = np.maximum(o_5m, c_5m) * 1.0005
        l_5m = np.minimum(o_5m, c_5m) * 0.9995
        v_5m = rng.uniform(10.0, 100.0, size=n_5m)
        tbv_5m = v_5m * 0.5
        df_5m = pd.DataFrame({"t": t_5m, "o": o_5m, "h": h_5m, "l": l_5m, "c": c_5m, "v": v_5m, "tbv": tbv_5m})

        n_15m = n_days * 96
        t_15m = start_ms + np.arange(n_15m, dtype=np.int64) * 900_000
        df_15m = pd.DataFrame(
            {
                "t": t_15m,
                "o": o_5m[::3],
                "h": np.maximum.reduce([h_5m[0::3], h_5m[1::3], h_5m[2::3]]),
                "l": np.minimum.reduce([l_5m[0::3], l_5m[1::3], l_5m[2::3]]),
                "c": c_5m[2::3],
                "v": v_5m[0::3] + v_5m[1::3] + v_5m[2::3],
                "tbv": tbv_5m[0::3] + tbv_5m[1::3] + tbv_5m[2::3],
            }
        )

        n_1h = n_days * 24
        t_1h = start_ms + np.arange(n_1h, dtype=np.int64) * 3_600_000
        df_1h = pd.DataFrame(
            {
                "t": t_1h,
                "o": o_5m[::12],
                "h": np.maximum(o_5m[::12], c_5m[11::12]) * 1.001,
                "l": np.minimum(o_5m[::12], c_5m[11::12]) * 0.999,
                "c": c_5m[11::12],
                "v": np.array([v_5m[i * 12 : (i + 1) * 12].sum() for i in range(n_1h)]),
                "tbv": np.array([tbv_5m[i * 12 : (i + 1) * 12].sum() for i in range(n_1h)]),
            }
        )

        n_4h = n_days * 6
        t_4h = start_ms + np.arange(n_4h, dtype=np.int64) * 14_400_000
        df_4h = pd.DataFrame(
            {
                "t": t_4h,
                "o": o_5m[::48],
                "h": np.maximum(o_5m[::48], c_5m[47::48]) * 1.002,
                "l": np.minimum(o_5m[::48], c_5m[47::48]) * 0.998,
                "c": c_5m[47::48],
                "v": np.array([v_5m[i * 48 : (i + 1) * 48].sum() for i in range(n_4h)]),
                "tbv": np.array([tbv_5m[i * 48 : (i + 1) * 48].sum() for i in range(n_4h)]),
            }
        )

        t_1d = start_ms + np.arange(n_days, dtype=np.int64) * 86_400_000
        df_1d = pd.DataFrame(
            {
                "t": t_1d,
                "o": o_5m[::288],
                "h": np.maximum(o_5m[::288], c_5m[287::288]) * 1.005,
                "l": np.minimum(o_5m[::288], c_5m[287::288]) * 0.995,
                "c": c_5m[287::288],
                "v": np.array([v_5m[i * 288 : (i + 1) * 288].sum() for i in range(n_days)]),
                "tbv": np.array([tbv_5m[i * 288 : (i + 1) * 288].sum() for i in range(n_days)]),
            }
        )

        df_prem = pd.DataFrame({"t": t_5m, "c": rng.normal(0.0001, 0.00005, size=n_5m)})

        n_settle = n_days * 3
        t_settle = start_ms + np.arange(n_settle, dtype=np.int64) * (8 * 3_600_000)
        df_settle = pd.DataFrame(
            {"t": t_settle, "rate": rng.normal(0.0001, 0.00002, size=n_settle), "intervalHours": [8] * n_settle}
        )

        panel[sym] = {
            "5m": df_5m,
            "15m": df_15m,
            "1h": df_1h,
            "4h": df_4h,
            "1d": df_1d,
            "premium_5m": df_prem,
            "premiumIndex": df_prem,
            "settlements": df_settle,
            "funding": df_settle,
        }

    return panel


def _create_synthetic_dataset_dir(tmp_path: Path, panel: dict[str, dict[str, pd.DataFrame]]) -> Path:
    """Write synthetic manifest.json to directory."""
    ds_dir = tmp_path / "ds"
    ds_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "version": 1,
        "datasetHash": "11c87b9c8a97synthetic",
        "symbols": list(panel.keys()),
        "files": [],
    }
    (ds_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return ds_dir


# ---------------------------------------------------------------------------
# Test 1: run-wf writes receipt with every listed key; identical metrics on rerun
# ---------------------------------------------------------------------------


def test_1_run_wf_receipt_keys_and_determinism(tmp_path: Path):
    """1. run-wf on a synthetic panel writes a receipt with every listed key.

    Running it twice gives identical metrics.
    """
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=10, inject_signal=True)
    ds_dir = _create_synthetic_dataset_dir(tmp_path / "t1_ds", panel)

    cfg_dict = {
        "id": "run_001",
        "kind": "trial",
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ["ret_1", "ret_4"],
        "interval": "1h",
        "h_ms": 14_400_000,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0001,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "first_refit_ms": 1680307200000,  # 2023-04-01 UTC (90 days)
        "seed": 7,
    }
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps(cfg_dict, indent=2), encoding="utf-8")

    out_dir_1 = tmp_path / "out_1"
    receipt_1 = run_wf(cfg_file, ds_dir, out_dir_1, commit=COMMIT, panel=panel)

    # Check top-level receipt keys
    assert "commit" in receipt_1
    assert receipt_1["commit"] == COMMIT
    assert "dataset_hash" in receipt_1
    assert receipt_1["dataset_hash"] != "unknown"
    assert "config" in receipt_1
    assert "metrics" in receipt_1
    assert "runtime_s" in receipt_1

    # Check all required metrics keys
    m = receipt_1["metrics"]
    required_metrics_keys = [
        "wf_mean",
        "wf_sd",
        "wf_sharpe",
        "n_days",
        "bet_days",
        "cpcv_path_means",
        "coin_means",
        "stress_fee",
        "stress_slippage",
        "stress_maker_as_taker",
        "stress_cost",
        "n_maker_fills",
        "jackknife_means",
        "cpcv_excluded_tranches",
        "n_outside_d",
        "excluded_tranches",
        "n_samples",
        "n_dropped",
        "funding_dropped",
    ]
    for k in required_metrics_keys:
        assert k in m, f"Missing metric key: {k}"
    assert receipt_1["config_hash"] == config_hash_of(cfg_dict)
    assert len(receipt_1["config_hash"]) == 64
    assert len(m["cpcv_excluded_tranches"]) == 5
    assert m["n_outside_d"] == 0
    assert m["n_maker_fills"] == 0
    assert set(m["jackknife_means"]) == set(UNIVERSE)
    # Coins absent from the 6-coin panel have no tranche, so their mean is null, never zero.
    for sym in UNIVERSE[6:]:
        assert m["coin_means"][sym] is None

    # Verify written files
    run_dir = out_dir_1 / "run_001"
    assert (run_dir / "receipt.json").exists()
    assert (run_dir / "daily.parquet").exists()
    assert (run_dir / "tranches.parquet").exists()
    folds_json = json.loads((run_dir / "folds.json").read_text(encoding="utf-8"))
    assert len(folds_json) >= 1
    assert set(folds_json[0]) == {"start_ms", "end_ms", "train_cut_ms", "betas", "long_share", "net_exposure"}
    assert folds_json[0]["start_ms"] == cfg_dict["first_refit_ms"]

    daily_df = pd.read_parquet(run_dir / "daily.parquet")
    assert "drift_free" in daily_df.columns
    assert "bet" in daily_df.columns

    tranches_df = pd.read_parquet(run_dir / "tranches.parquet")
    assert "symbol" in tranches_df.columns
    assert "side" in tranches_df.columns

    # Run twice and check identical metrics
    out_dir_2 = tmp_path / "out_2"
    receipt_2 = run_wf(cfg_file, ds_dir, out_dir_2, commit=COMMIT, panel=panel)

    assert receipt_1["metrics"] == receipt_2["metrics"]


# ---------------------------------------------------------------------------
# Test 2: CPCV path means are 5 finite numbers when panel has signal
# ---------------------------------------------------------------------------


def test_2_cpcv_path_means_finite_numbers(tmp_path: Path):
    """2. The CPCV path means are 5 finite numbers when the panel has signal."""
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=20, inject_signal=True)
    ds_dir = _create_synthetic_dataset_dir(tmp_path / "t2_ds", panel)

    cfg_dict = {
        "id": "run_002",
        "kind": "trial",
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ["ret_1"],
        "interval": "1h",
        "h_ms": 14_400_000,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.00005,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "first_refit_ms": 1680307200000,
        "seed": 7,
    }
    cfg_file = tmp_path / "config_2.json"
    cfg_file.write_text(json.dumps(cfg_dict, indent=2), encoding="utf-8")

    out_dir = tmp_path / "out_2"
    receipt = run_wf(cfg_file, ds_dir, out_dir, commit=COMMIT, panel=panel)

    cpcv_means = receipt["metrics"]["cpcv_path_means"]
    assert len(cpcv_means) == 5
    for idx, mean_val in enumerate(cpcv_means):
        assert isinstance(mean_val, float)
        assert np.isfinite(mean_val), f"CPCV path {idx} mean is not finite: {mean_val}"


# ---------------------------------------------------------------------------
# Test 3: Planted-edge passes items 1, 5, 6; pure noise fails item 1 in most seeds
# ---------------------------------------------------------------------------


def test_3_planted_edge_passes_items_1_5_6_noise_fails_item_1(tmp_path: Path):
    """3. On a planted-edge synthetic panel, items 1, 5 and 6 pass.

    On a pure-noise panel, item 1 fails in most seeds.
    """
    # 1. Planted-edge panel: 10 coins, 150 days
    panel_planted = _make_fast_synthetic_panel(symbols=UNIVERSE, n_days=150, seed=30, inject_signal=True)
    ds_dir_planted = _create_synthetic_dataset_dir(tmp_path / "t3_ds_planted", panel_planted)

    cfg_planted_dict = {
        "id": "run_planted",
        "kind": "trial",
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 0.01},
        "features": ["ret_1"],
        "interval": "1h",
        "h_ms": 14_400_000,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.00001,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "first_refit_ms": 1680307200000,
        "seed": 42,
    }
    cfg_file_p = tmp_path / "config_p.json"
    cfg_file_p.write_text(json.dumps(cfg_planted_dict, indent=2), encoding="utf-8")

    receipt_p = run_wf(cfg_file_p, ds_dir_planted, tmp_path / "out_p", commit=COMMIT, panel=panel_planted)

    res1 = item1(receipt_p)
    res5 = item5(receipt_p)
    res6 = item6(receipt_p)

    assert res1["pass"] is True
    assert res5["pass"] is True
    assert res6["pass"] is True

    # 2. Pure noise panel: item 1 fails in most seeds
    fail_count = 0
    test_seeds = [101, 202]
    for s in test_seeds:
        panel_noise = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=s, inject_signal=False)
        ds_dir_noise = _create_synthetic_dataset_dir(tmp_path / f"t3_ds_noise_{s}", panel_noise)
        cfg_noise_dict = {
            "id": f"run_noise_{s}",
            "kind": "trial",
            "family": "A",
            "model": "ridge",
            "params": {"alpha": 10.0},
            "features": ["ret_1", "ret_4"],
            "interval": "1h",
            "h_ms": 14_400_000,
            "label": "fixed",
            "side_rule": "sign",
            "threshold": 0.0001,
            "size_rule": "unit",
            "lookback_months": None,
            "refit": "monthly",
            "exit": "horizon",
            "first_refit_ms": 1680307200000,
            "seed": s,
        }
        cfg_file_n = tmp_path / f"config_n_{s}.json"
        cfg_file_n.write_text(json.dumps(cfg_noise_dict, indent=2), encoding="utf-8")
        receipt_n = run_wf(cfg_file_n, ds_dir_noise, tmp_path / f"out_n_{s}", commit=COMMIT, panel=panel_noise)
        if not item1(receipt_n)["pass"]:
            fail_count += 1

    assert fail_count >= 1  # Fails in noise seeds


# ---------------------------------------------------------------------------
# Test 4: item2 PBO above 0.9 on IS winner/OOS loser, below 0.1 on dominating
# ---------------------------------------------------------------------------


def test_4_item2_pbo_contrast():
    """4. item2 on a matrix where the IS winner is the OOS loser gives PBO above 0.9,

    and below 0.1 when one configuration dominates.
    """
    # 4a. IS winner / OOS loser matrix
    planted = np.zeros((160, 2), dtype=np.float64)
    group_size = 10
    for g in range(16):
        start = g * group_size
        end = (g + 1) * group_size
        if g % 2 == 0:
            planted[start:end, 0] = 1.0
            planted[start:end, 1] = -1.0
        else:
            planted[start:end, 0] = -1.0
            planted[start:end, 1] = 1.0

    res_planted = item2(planted)
    assert res_planted["pbo"] > 0.9
    assert res_planted["pass"] is False

    # 4b. One configuration dominates all periods
    t_periods = 160
    n_configs = 5
    dom = np.zeros((t_periods, n_configs), dtype=np.float64)
    dom[:, 0] = [1.0 if t % 2 == 0 else 2.0 for t in range(t_periods)]
    col_other = np.array([-1.0 if t % 2 == 0 else -0.5 for t in range(t_periods)])
    dom[:, 1:] = col_other[:, None]

    res_dom = item2(dom)
    assert res_dom["pbo"] < 0.1
    assert res_dom["pass"] is True


# ---------------------------------------------------------------------------
# Test 5: item3 trials max(120, count) and program prob <= round prob
# ---------------------------------------------------------------------------


def test_5_item3_num_trials_and_program_prob_monotonic():
    """5. item3: N is max(120, ledger_count), and the program-count probability

    is never higher than the round-count probability.
    """
    receipt = {
        "metrics": {
            "wf_sharpe": 1.25,
            "n_days": 250,
            "skew": 0.05,
            "kurt": 3.1,
        }
    }
    # Test with ledger_count < 120
    res_small = item3(receipt, round_daily=0.04, ledger_count=50)
    assert res_small["num_trials"] == 120
    assert res_small["dsr_prob_program"] <= res_small["dsr_prob"]

    # Test with ledger_count > 120
    res_large = item3(receipt, round_daily=0.04, ledger_count=200)
    assert res_large["num_trials"] == 200
    assert res_large["dsr_prob_program"] <= res_large["dsr_prob"]


# ---------------------------------------------------------------------------
# Test 7: book.py fees + slippage == costs to 1e-15, existing tests pass
# ---------------------------------------------------------------------------


def test_7_book_fees_plus_slippage_equals_costs():
    """7. book.py: fees + slippage == costs to 1e-15, and the existing book tests still pass."""
    day_0 = 1700006400000
    tranche_1 = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=day_0 + 3_600_000,
        exit_ms=day_0 + 9 * 3_600_000,
        entry_price=100.0,
        exit_price=105.0,
        interval="1h",
        h_ms=8 * 3_600_000,
        size=1.0,
        entry_fill="taker",
        exit_fill="taker",
    )
    tranche_2 = Tranche(
        symbol="BTCUSDT",
        side=-1,
        entry_ms=day_0 + 4 * 3_600_000,
        exit_ms=day_0 + 12 * 3_600_000,
        entry_price=102.0,
        exit_price=98.0,
        interval="1h",
        h_ms=8 * 3_600_000,
        size=0.5,
        entry_fill="maker",
        exit_fill="taker",
    )

    df_5m = pd.DataFrame(
        {
            "t": [
                day_0,
                day_0 + 3_600_000,
                day_0 + 4 * 3_600_000,
                day_0 + 9 * 3_600_000,
                day_0 + 12 * 3_600_000,
                day_0 + 86_400_000,
            ],
            "o": [100.0, 100.0, 102.0, 105.0, 98.0, 99.0],
        }
    )
    five_min = {"BTCUSDT": df_5m}

    # Test daily_book
    df_book = daily_book([tranche_1, tranche_2], five_min, settlements=None)
    assert not df_book.empty
    assert "fees" in df_book.columns
    assert "slippage" in df_book.columns
    assert "costs" in df_book.columns

    for _, row in df_book.iterrows():
        sum_split = row["fees"] + row["slippage"]
        cost_val = row["costs"]
        assert abs(sum_split - cost_val) <= 1e-15

    # Test beta_hedged_daily
    betas = {"BTCUSDT": 1.0}
    df_hedged = beta_hedged_daily([tranche_1, tranche_2], five_min, settlements=None, betas=betas, universe=["BTCUSDT"])
    assert not df_hedged.empty
    assert "fees" in df_hedged.columns
    assert "slippage" in df_hedged.columns
    assert "costs" in df_hedged.columns

    for _, row in df_hedged.iterrows():
        sum_split = row["fees"] + row["slippage"]
        cost_val = row["costs"]
        assert abs(sum_split - cost_val) <= 1e-15


# ---------------------------------------------------------------------------
# Shared helpers for the fix-round tests
# ---------------------------------------------------------------------------

BASE_CFG: dict = {
    "id": "base",
    "kind": "trial",
    "family": "A",
    "model": "ridge",
    "params": {"alpha": 1.0},
    "features": ["ret_1", "ret_4"],
    "interval": "1h",
    "h_ms": 14_400_000,
    "label": "fixed",
    "side_rule": "sign",
    "threshold": 0.0001,
    "size_rule": "unit",
    "lookback_months": None,
    "refit": "monthly",
    "exit": "horizon",
    "first_refit_ms": 1680307200000,  # 2023-04-01 UTC
    "seed": 7,
}


def _cfg_file(tmp_path: Path, name: str, **over) -> tuple[Path, dict]:
    cfg = {**BASE_CFG, **over}
    path = tmp_path / f"{name}.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    return path, cfg


def _run_config(cfg: dict) -> RunConfig:
    return RunConfig(
        family=cfg["family"],
        model=cfg["model"],
        params=cfg["params"],
        features=tuple(cfg["features"]),
        interval=cfg["interval"],
        h_ms=cfg["h_ms"],
        label=cfg["label"],
        side_rule=cfg["side_rule"],
        threshold=cfg["threshold"],
        size_rule=cfg["size_rule"],
        lookback_months=cfg["lookback_months"],
        refit=cfg["refit"],
        exit=cfg["exit"],
        seed=cfg["seed"],
    )


def _pulse_panel(
    start_ms: int,
    n_days: int,
    pulse_days: list[int],
    btc_days: int | None = None,
    seed: int = 5,
) -> dict[str, dict[str, pd.DataFrame]]:
    """Six coins of 5m opens. BTC carries +3% pulses from hour 6 to hour 10 on the pulse days, then falls back."""
    panel: dict[str, dict[str, pd.DataFrame]] = {}
    n_bars = n_days * 288
    t = start_ms + np.arange(n_bars, dtype=np.int64) * 300_000
    for i, sym in enumerate(UNIVERSE[:6]):
        rng = np.random.default_rng(seed + i)
        ret = rng.normal(0.0, 0.0004, size=n_bars)
        if sym == "BTCUSDT":
            for d in pulse_days:
                base = d * 288
                ret[base + 72 : base + 120] += 0.03 / 48
                ret[base + 120 : base + 168] -= 0.03 / 48
        o = 100.0 * np.exp(np.concatenate(([0.0], np.cumsum(ret)[:-1])))
        df = pd.DataFrame({"t": t, "o": o})
        if sym == "BTCUSDT" and btc_days is not None:
            df = df[df["t"] < start_ms + btc_days * DAY].reset_index(drop=True)
        settle = pd.DataFrame({"t": np.empty(0, dtype=np.int64), "rate": np.empty(0, dtype=np.float64)})
        panel[sym] = {"5m": df, "settlements": settle, "funding": settle}
    return panel


def _price(panel: dict, sym: str, ms: int) -> float:
    df = panel[sym]["5m"]
    return float(df.loc[df["t"] == ms, "o"].iloc[0])


def _pulse_tranches(panel: dict, start_ms: int, days: list[int], side: int = 1, sym: str = "BTCUSDT") -> list[Tranche]:
    out = []
    for d in days:
        e = start_ms + d * DAY + 6 * 3_600_000
        x = e + 4 * 3_600_000
        out.append(
            Tranche(
                symbol=sym,
                side=side,
                entry_ms=e,
                exit_ms=x,
                entry_price=_price(panel, sym, e),
                exit_price=_price(panel, sym, x),
                interval="1h",
                h_ms=14_400_000,
                size=1.0,
            )
        )
    return out


def _one_fold(start_ms: int, n_days: int, beta: float = 1.0) -> list[dict]:
    return [
        {
            "start_ms": start_ms,
            "end_ms": start_ms + n_days * DAY,
            "train_cut_ms": None,
            "betas": {s: beta for s in UNIVERSE},
        }
    ]


# ---------------------------------------------------------------------------
# Test 2: RunResult.folds and RunResult.tranches
# ---------------------------------------------------------------------------


def test_2_run_result_folds_match_tranches_and_book():
    """2. The concatenated fold tranches equal RunResult.tranches, and the fold books sum to drift_free."""
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=22, inject_signal=True)
    cfg_dict = {**BASE_CFG, "threshold": 0.00005, "features": ["ret_1"]}
    cfg = _run_config(cfg_dict)
    samples = decision_samples(panel, cfg)
    res = walk_forward(samples, cfg, first_refit_ms=cfg_dict["first_refit_ms"], end_ms=DEV_END, panel=panel)

    assert len(res.folds) >= 2
    assert [t for f in res.folds for t in f.tranches] == res.tranches
    assert len(res.tranches) > 0
    starts = [f.start_ms for f in res.folds]
    assert starts == sorted(starts)

    books = [f.book for f in res.folds if len(f.book)]
    summed = pd.concat(books).groupby("day_start")["drift_free"].sum()
    got = res.drift_free["drift_free"].reindex(summed.index)
    assert np.max(np.abs(got.to_numpy() - summed.to_numpy())) <= 1e-12
    # Days outside every fold book are zero in drift_free.
    outside = res.drift_free["drift_free"].drop(summed.index)
    assert float(np.abs(outside.to_numpy()).max()) == 0.0


# ---------------------------------------------------------------------------
# Test 3: CPCV path betas come from the split that tests the group
# ---------------------------------------------------------------------------


def test_3_cpcv_group_priced_with_the_splits_own_betas():
    """3. A path's group g is priced with the betas of the split that tests g in that path."""
    import itertools

    path_ids = cpcv_path_ids(CPCV_GROUPS, CPCV_TEST_GROUPS)
    layout = cpcv_path_layout(path_ids, CPCV_GROUPS, CPCV_TEST_GROUPS)
    combos = list(itertools.combinations(range(CPCV_GROUPS), CPCV_TEST_GROUPS))
    assert len(layout) == 5 * CPCV_GROUPS
    for (p, g), (s, j) in layout.items():
        assert combos[s][j] == g
        assert path_ids[s, j] == p
    for p in range(5):
        assert sorted(g for (pp, g) in layout if pp == p) == list(range(CPCV_GROUPS))

    day0 = 1672531200000
    n_days = 8
    n_bars = n_days * 288
    t5 = day0 + np.arange(n_bars, dtype=np.int64) * 300_000
    five_min = {}
    for sym in UNIVERSE[:6]:
        o = 100.0 * np.exp(0.001 * np.arange(n_bars)) if sym == "BTCUSDT" else np.full(n_bars, 100.0)
        five_min[sym] = pd.DataFrame({"t": t5, "o": o})
    empty = pd.DataFrame({"t": np.empty(0, dtype=np.int64), "rate": np.empty(0, dtype=np.float64)})
    settlements = {s: empty for s in five_min}

    rows = []
    for g in range(CPCV_GROUPS):
        e = day0 + g * DAY + 3_600_000
        x = e + 14_400_000
        rows.append(
            {
                "symbol": "BTCUSDT",
                "t0": e - 600_000,
                "t1_max": x,
                "entry": float(five_min["BTCUSDT"].loc[five_min["BTCUSDT"]["t"] == e, "o"].iloc[0]),
                "exit": float(five_min["BTCUSDT"].loc[five_min["BTCUSDT"]["t"] == x, "o"].iloc[0]),
            }
        )
    samples = pd.DataFrame(rows)
    cfg = _run_config({**BASE_CFG})
    test_groups_by_split = [[np.array([g]) for g in combo] for combo in combos]
    split_betas = [
        {**{c: 1.0 for c in five_min}, "BTCUSDT": (0.2 + 0.1 * s) if s != 0 else float("nan")}
        for s in range(len(combos))
    ]
    path_sides = np.ones(CPCV_GROUPS, dtype=np.int64)

    fee = resolve_fee_profile("standard", "BTCUSDT")
    slip = coin_slippage_bps("BTCUSDT") / 10000.0  # per-coin slippage (was the 3 bp 1h budget)
    weight = 1.0 / 4.0 / 10.0
    cost = weight * (2 * fee.taker_fee + 2 * slip)
    r_coin = 0.001 * 48
    r_ew = r_coin / 6.0

    for p in range(5):
        series, excluded = cpcv_path_drift_free(
            p,
            path_sides,
            samples,
            test_groups_by_split,
            layout,
            split_betas,
            cfg,
            five_min,
            settlements,
            list(five_min),
            day0,
            day0 + n_days * DAY,
        )
        expect_excluded = 0
        for g in range(CPCV_GROUPS):
            s, _ = layout[(p, g)]
            day_val = float(series.loc[day0 + g * DAY])
            if s == 0:
                expect_excluded += 1
                assert day_val == 0.0
            else:
                beta = 0.2 + 0.1 * s
                assert day_val == pytest.approx(weight * (r_coin - beta * r_ew) - cost, abs=1e-12)
        assert excluded == expect_excluded


# ---------------------------------------------------------------------------
# Test 4: stress variants
# ---------------------------------------------------------------------------


def test_4_stress_cost_and_maker_as_taker():
    """4. stress_cost is the joint fee and slippage stress, and a maker entry lowers the maker stress exactly."""
    assert float(BAR["stress_fee_mult"]) == 1.5
    assert float(BAR["stress_slippage_mult"]) == 2.0

    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=44, inject_signal=True)
    cfg_dict = {**BASE_CFG, "threshold": 0.00005, "features": ["ret_1"]}
    cfg = _run_config(cfg_dict)
    samples = decision_samples(panel, cfg)
    first_refit = cfg_dict["first_refit_ms"]
    res = walk_forward(samples, cfg, first_refit_ms=first_refit, end_ms=DEV_END, panel=panel)

    base = res.drift_free["drift_free"]
    wf_mean = float(base.mean())
    n = len(base)
    books = pd.concat([f.book for f in res.folds if len(f.book)]).groupby("day_start").sum()
    fees = books["fees"].reindex(base.index).fillna(0.0)
    slip = books["slippage"].reindex(base.index).fillna(0.0)

    out = stress_metrics(res.folds, res.drift_free, first_refit, DEV_END)
    assert out["stress_cost"] == pytest.approx(wf_mean - 0.5 * float(fees.mean()) - 1.0 * float(slip.mean()), abs=1e-12)
    assert out["stress_fee"] == pytest.approx(wf_mean - 0.5 * float(fees.mean()), abs=1e-12)
    assert out["stress_slippage"] == pytest.approx(wf_mean - 1.0 * float(slip.mean()), abs=1e-12)
    assert out["n_maker_fills"] == 0
    assert out["stress_maker_as_taker"] == wf_mean

    # Change one tranche (with a finite beta) to a maker entry.
    fold_pos = next(i for i, f in enumerate(res.folds) if f.tranches)
    fold = res.folds[fold_pos]
    k = next(i for i, t in enumerate(fold.tranches) if np.isfinite(fold.betas[t.symbol]))
    changed = dataclasses.replace(fold.tranches[k], entry_fill="maker")
    new_tranches = list(fold.tranches)
    new_tranches[k] = changed
    folds2 = list(res.folds)
    folds2[fold_pos] = dataclasses.replace(fold, tranches=new_tranches)

    out2 = stress_metrics(folds2, res.drift_free, first_refit, DEV_END)
    fee = resolve_fee_profile("standard", changed.symbol)
    rate = fee.taker_fee + coin_slippage_bps(changed.symbol) / 10000.0
    # Hand netting at the changed fill's instant: the taker legs there sum to s_taker, the maker leg is the changed
    # entry. Relabelled taker, the entry nets against the other taker legs (other fills at that instant).
    instant = changed.entry_ms
    s_taker = 0.0
    for t in fold.tranches:
        if t.symbol != changed.symbol or np.isnan(fold.betas[t.symbol]):
            continue
        if t.entry_ms == instant and t is not fold.tranches[k]:
            s_taker += t.weight
        if t.exit_ms == instant:
            s_taker -= t.weight
    base_cost = abs(s_taker) * rate + abs(changed.weight) * fee.maker_fee
    relabelled_cost = abs(s_taker + changed.weight) * rate
    extra = relabelled_cost - base_cost
    assert out2["n_maker_fills"] == 1
    assert out2["stress_maker_as_taker"] == pytest.approx(wf_mean - extra / n, abs=1e-15)


# ---------------------------------------------------------------------------
# Test 5: joint shift
# ---------------------------------------------------------------------------


def test_5_shift_tranche_times_whole_days_keeps_time_of_day_and_hold():
    """5a. The entry moves by whole days and keeps its intraday time and the hold."""
    day0 = 1672531200000
    entry = day0 + 5 * DAY + 3_600_000
    exit_ = entry + 14_400_000
    for s_days in (7, 10, 50, 93):
        e2, x2 = shift_tranche_times(entry, exit_, s_days, day0, 100)
        assert (e2 - entry) % DAY == 0
        assert (e2 - day0) % DAY == 3_600_000
        assert x2 - e2 == exit_ - entry
        assert e2 == day0 + ((5 + s_days) % 100) * DAY + 3_600_000
    e3, _ = shift_tranche_times(entry, exit_, 98, day0, 100)
    assert e3 == day0 + 3 * DAY + 3_600_000  # wrapped inside the span


def _ref_statistic(
    tranches: list[Tranche],
    entries: list[int],
    exits: list[int],
    panel: dict,
    folds: list[dict],
) -> float:
    """Slow scalar reference of the lock's per-tranche statistic (taker fills, no funding)."""
    from r4.book import FiveMinLookup

    lookup = FiveMinLookup({s: panel[s]["5m"] for s in panel})
    num = den = 0.0
    for t, e, x in zip(tranches, entries, exits, strict=True):
        pe = lookup.get_exact_open(t.symbol, e)
        px = lookup.get_exact_open(t.symbol, x)
        if pe is None or px is None:
            continue
        ew = []
        for u in panel:
            a = lookup.get_exact_open(u, e)
            b = lookup.get_exact_open(u, x)
            if a is not None and b is not None:
                ew.append(float(np.log(b / a)))
        fold = next((f for f in folds if f["start_ms"] <= e < f["end_ms"]), None)
        if fold is None or not ew:
            continue
        beta = fold["betas"].get(t.symbol)
        if beta is None or np.isnan(beta):
            continue
        fee = resolve_fee_profile("standard", t.symbol)
        slip = coin_slippage_bps(t.symbol) / 10000.0
        # No two tranches here share a coin and an instant, so the netted cost equals the per-tranche cost.
        costs = 2 * fee.taker_fee + 2 * slip
        ret = t.side_val * (float(np.log(px / pe)) - beta * float(np.mean(ew))) - costs
        num += abs(t.weight) * ret
        den += abs(t.weight)
    return num / den if den > 0 else float("inf")


def test_5_joint_shift_matches_scalar_reference_and_p_formula():
    """5b/5c. Shifts are integers in [7, n-7], and p equals (1 + k) / (1 + draws) from a scalar reference."""
    start = 1672531200000
    n_days = 100
    pulse_days = [8, 13, 21, 29, 40, 44, 55, 61, 69, 77, 84, 93]
    panel = _pulse_panel(start, n_days, pulse_days)
    tr = _pulse_tranches(panel, start, pulse_days)
    tr += [
        dataclasses.replace(t, symbol="ETHUSDT", side=-1, size=0.5, entry_price=_price(panel, "ETHUSDT", t.entry_ms))
        for t in _pulse_tranches(panel, start, [3, 17, 33, 52, 71], sym="ETHUSDT")
    ]
    tr = [
        dataclasses.replace(
            t, exit_price=_price(panel, t.symbol, t.exit_ms), entry_price=_price(panel, t.symbol, t.entry_ms)
        )
        for t in tr
    ]
    folds = [
        {
            "start_ms": start,
            "end_ms": start + 50 * DAY,
            "train_cut_ms": None,
            "betas": {"BTCUSDT": 1.0, "ETHUSDT": 0.7, **{s: 1.0 for s in UNIVERSE[2:]}},
        },
        {
            "start_ms": start + 50 * DAY,
            "end_ms": start + n_days * DAY,
            "train_cut_ms": None,
            "betas": {"BTCUSDT": 0.4, "ETHUSDT": 1.3, **{s: 1.0 for s in UNIVERSE[2:]}},
        },
    ]
    n_draws = 60
    span_end = start + n_days * DAY
    p, drop_share, obs, shifts = joint_shift_null(
        tr,
        panel,
        folds,
        start,
        span_end,
        n_draws=n_draws,
        min_shift_days=int(BAR["random_entry_shift_min_days"]),
        seed=3,
    )

    assert len(shifts) == n_draws
    assert all(isinstance(s, int) and 7 <= s <= n_days - 7 for s in shifts)

    obs_ref = _ref_statistic(tr, [t.entry_ms for t in tr], [t.exit_ms for t in tr], panel, folds)
    assert obs == pytest.approx(obs_ref, abs=1e-12)

    null = []
    dropped = 0
    for s_days in shifts:
        ent, ext = [], []
        for t in tr:
            e2, x2 = shift_tranche_times(t.entry_ms, t.exit_ms, s_days, start, n_days)
            ent.append(e2)
            ext.append(x2)
        late = [x > span_end for x in ext]
        keep_tr = [(t, e, x) for t, e, x, lt in zip(tr, ent, ext, late, strict=True) if not lt]
        dropped += len(tr) - len(keep_tr)
        kt = [a for a, _, _ in keep_tr]
        ke = [b for _, b, _ in keep_tr]
        kx = [c for _, _, c in keep_tr]
        null.append(_ref_statistic(kt, ke, kx, panel, folds))
    k = sum(1 for v in null if v >= obs_ref)
    assert p == pytest.approx((1 + k) / (1 + n_draws), abs=0.0)
    assert drop_share == pytest.approx(dropped / (n_draws * len(tr)), abs=1e-12)


def test_5_joint_shift_detects_planted_edge_and_validates_span():
    """5d. Tranches on the right side of big moves give p below 0.05. A span under 14 days raises."""
    start = 1672531200000
    n_days = 100
    pulse_days = [8, 13, 21, 29, 40, 44, 55, 61, 69, 77, 84, 93]
    panel = _pulse_panel(start, n_days, pulse_days)
    tr = _pulse_tranches(panel, start, pulse_days)
    folds = _one_fold(start, n_days)
    p, _drop, obs, _shifts = joint_shift_null(tr, panel, folds, start, start + n_days * DAY, n_draws=200, seed=11)
    assert obs > 0.01
    assert p < 0.05

    with pytest.raises(ValueError):
        joint_shift_null(tr, panel, folds, start, start + 13 * DAY, n_draws=10)

    # A NaN beta leaves no kept tranche: the result is the conservative p of 1.
    nan_folds = [{**folds[0], "betas": {s: None for s in UNIVERSE}}]
    p_nan, drop_nan, obs_nan, _ = joint_shift_null(tr, panel, nan_folds, start, start + n_days * DAY, n_draws=10)
    assert p_nan == 1.0
    assert drop_nan == 1.0
    assert np.isnan(obs_nan)


def test_5_shifted_tranche_on_missing_price_is_dropped_and_counted():
    """5e. A tranche landing where the coin has no 5m open is dropped, and the drop share counts it."""
    start = 1672531200000
    n_days = 100
    panel = _pulse_panel(start, n_days, [10], btc_days=20)
    tr = _pulse_tranches(panel, start, [10])
    folds = _one_fold(start, n_days)
    n_draws = 80
    span_end = start + n_days * DAY
    _p, drop_share, _obs, shifts = joint_shift_null(tr, panel, folds, start, span_end, n_draws=n_draws, seed=3)

    limit = start + 20 * DAY
    expected = 0
    for s_days in shifts:
        e2, x2 = shift_tranche_times(tr[0].entry_ms, tr[0].exit_ms, s_days, start, n_days)
        if x2 > span_end or x2 >= limit:
            expected += 1
    assert 0 < expected < n_draws
    assert drop_share == pytest.approx(expected / n_draws, abs=1e-12)


# ---------------------------------------------------------------------------
# Test 6: item5
# ---------------------------------------------------------------------------


def test_6_item5_jackknife_and_coin_count_rules():
    """6. Family D passes on an all-positive jackknife, and a null coin mean is not positive."""
    jk_ok = {s: 0.001 for s in UNIVERSE}
    rec = {"config": {"family": "D"}, "metrics": {"jackknife_means": jk_ok, "coin_means": {s: -1.0 for s in UNIVERSE}}}
    res = item5(rec)
    assert res["pass"] is True
    assert res["rule"] == "jackknife"

    rec_bad = {"config": {"family": "D"}, "metrics": {"jackknife_means": {**jk_ok, "BTCUSDT": -0.0001}}}
    assert item5(rec_bad)["pass"] is False
    rec_null = {"config": {"family": "D"}, "metrics": {"jackknife_means": {**jk_ok, "BTCUSDT": None}}}
    assert item5(rec_null)["pass"] is False
    with pytest.raises(ValueError):
        item5({"config": {"family": "D"}, "metrics": {"coin_means": jk_ok}})

    seven = {s: (0.001 if i < 7 else None) for i, s in enumerate(UNIVERSE)}
    r7 = item5({"config": {"family": "A"}, "metrics": {"coin_means": seven}})
    assert r7["pass"] is True
    assert r7["rule"] == "coin_count"
    six_plus_null = {s: (0.001 if i < 6 else (None if i == 6 else -0.001)) for i, s in enumerate(UNIVERSE)}
    r6 = item5({"config": {"family": "A"}, "metrics": {"coin_means": six_plus_null}})
    assert r6["pass"] is False
    assert r6["positive_coins"] == 6


def test_6_item6_joint_stress_and_maker():
    """6b. Item 6 passes on stress_cost and stress_maker_as_taker only."""
    base = {"stress_cost": 0.0, "stress_maker_as_taker": 0.0, "stress_fee": -1.0, "stress_slippage": -1.0}
    assert item6({"metrics": base})["pass"] is True
    assert item6({"metrics": {**base, "stress_cost": -1e-9}})["pass"] is False
    assert item6({"metrics": {**base, "stress_maker_as_taker": -1e-9}})["pass"] is False


# ---------------------------------------------------------------------------
# Test 7: item3 counts identical configurations once
# ---------------------------------------------------------------------------


def test_7_item3_takes_a_variance_not_a_mapping_of_frames():
    """7. Brief 28g (review C-8): item3's mapping branch took the TOTAL variance, contradicting A1.8's within-cell V.

    No caller passed a mapping, so the branch is gone and a mapping raises. The one-count-per-config_hash rule lives
    in trial_sharpe_variance, which family_report and the calibration evaluators call.
    """
    rng = np.random.default_rng(1)
    days = [i * DAY for i in range(120)]

    def frame(mu: float, h: str) -> pd.DataFrame:
        df = pd.DataFrame({"drift_free": mu + rng.normal(0, 0.002, 120)}, index=pd.Index(days, name="day_start"))
        df.attrs["config_hash"] = h
        return df

    a = frame(0.001, "hash_a")
    b = frame(0.002, "hash_b")
    receipt = {"metrics": {"wf_sharpe": 0.5, "n_days": 120}}
    with pytest.raises(TypeError, match="mapping"):
        item3(receipt, {"r1": a, "r2": a.copy(), "r3": b}, ledger_count=120)
    with pytest.raises(TypeError, match="mapping"):
        item3(receipt, {"r1": pd.DataFrame({"drift_free": [0.1, 0.2]})}, ledger_count=120)


# ---------------------------------------------------------------------------
# Test 8: family_report candidates, tripwire and finalists
# ---------------------------------------------------------------------------


def _write_planted_family(tmp_path: Path) -> tuple[Path, Path, dict]:
    """Two configurations with a strong, steady edge, the pulse tranches, folds.json and a manifest."""
    start = DEV_END - 100 * DAY
    panel = _pulse_panel(start, 100, [8, 13, 21, 29, 40, 44, 55, 61, 69, 77, 84, 93])
    ds_dir = _create_synthetic_dataset_dir(tmp_path, panel)
    runs_dir = tmp_path / "runs"
    tr = _pulse_tranches(panel, start, [8, 13, 21, 29, 40, 44, 55, 61, 69, 77, 84, 93])
    days = [start + i * DAY for i in range(100)]
    rng = np.random.default_rng(9)
    noise = rng.normal(0.0, 0.0005, 100)
    for i in range(2):
        run_id = f"cfg_{i}"
        r_dir = runs_dir / run_id
        r_dir.mkdir(parents=True, exist_ok=True)
        daily = pd.DataFrame(
            {"drift_free": 0.002 + 0.0005 * i + noise, "bet": [True] * 100}, index=pd.Index(days, name="day_start")
        )
        daily.to_parquet(r_dir / "daily.parquet")
        pd.DataFrame([dataclasses.asdict(t) for t in tr]).to_parquet(r_dir / "tranches.parquet", index=False)
        (r_dir / "folds.json").write_text(json.dumps(_one_fold(start, 100)), encoding="utf-8")
        config = {
            "id": run_id,
            "family": "A",
            "model": "ridge" if i == 0 else "logistic",
            "first_refit_ms": start,
            "variant": i,
        }
        receipt = {
            "kind": "trial",
            "commit": "abc",
            "dataset_hash": "hash123",
            "config_hash": config_hash_of(config),
            "config": config,
            "metrics": {
                "wf_mean": 0.002 + 0.0005 * i,
                "wf_sd": 0.0005,
                "wf_sharpe": 4.0 + i,
                "n_days": 100,
                "bet_days": 100,
                "cpcv_path_means": [0.001] * 5,
                "coin_means": {s: 0.001 for s in UNIVERSE},
                "jackknife_means": {s: 0.001 for s in UNIVERSE},
                "stress_cost": 0.0015,
                "stress_fee": 0.0018,
                "stress_slippage": 0.0018,
                "stress_maker_as_taker": 0.002,
                "n_maker_fills": 0,
                "excluded_tranches": 0,
                "n_samples": 100,
                "n_dropped": 0,
                "funding_dropped": 0,
            },
            "runtime_s": 1.0,
        }
        (r_dir / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    return ds_dir, runs_dir, panel


def test_8_family_report_candidates_tripwire_and_finalists(tmp_path: Path):
    """8. No tripwire gives candidates and no finalists. 61 of 100 halts. 60 of 100 selects finalists."""
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)

    def report(tripwire):
        return family_report(
            family="A",
            runs_dir=runs_dir,
            round_runs_dir=runs_dir,
            ledger_count=120,
            ds_dir=ds_dir,
            out_file=tmp_path / "report.json",
            seed=7,
            panel=panel,
            tripwire=tripwire,
        )

    rep = report(None)
    assert all(c["all_pass"] for c in rep["configurations"].values())
    assert rep["tripwire"] == "pending"
    assert rep["finalists"] == []
    assert len(rep["candidates"]) == 2
    assert [c["id"] for c in rep["candidates"]] == ["cfg_1", "cfg_0"]  # ranked by wf_sharpe
    assert rep["configurations"]["cfg_0"]["item3"]["n_unique_configs"] == 2
    assert (tmp_path / "report.json").exists()

    halted = report({"positive": 61, "n": 100})
    assert halted["tripwire"] == "halted"
    assert halted["finalists"] == []
    assert len(halted["candidates"]) == 2

    passed = report({"positive": 60, "n": 100})
    assert passed["tripwire"] == "passed"
    assert [f["id"] for f in passed["finalists"]] == ["cfg_1", "cfg_0"]

    with pytest.raises(ValueError):
        report({"positive": 3})


# ---------------------------------------------------------------------------
# Test 9: manifest is required
# ---------------------------------------------------------------------------


def test_9_missing_manifest_raises(tmp_path: Path):
    """9. run_wf and family_report raise on a missing manifest or a manifest without datasetHash."""
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=90)
    cfg_file, _ = _cfg_file(tmp_path, "cfg9")
    empty_ds = tmp_path / "ds_missing"
    empty_ds.mkdir()
    with pytest.raises(ValueError, match="manifest"):
        run_wf(cfg_file, empty_ds, tmp_path / "out9", commit=COMMIT, panel=panel)

    no_hash_ds = tmp_path / "ds_nohash"
    no_hash_ds.mkdir()
    (no_hash_ds / "manifest.json").write_text(json.dumps({"symbols": ["BTCUSDT"]}), encoding="utf-8")
    with pytest.raises(ValueError, match="datasetHash"):
        run_wf(cfg_file, no_hash_ds, tmp_path / "out9", commit=COMMIT, panel=panel)

    runs = tmp_path / "runs9"
    runs.mkdir()
    with pytest.raises(ValueError, match="manifest"):
        family_report("A", runs, runs, 120, empty_ds, panel=panel)


# ---------------------------------------------------------------------------
# Test 10: samples outside D
# ---------------------------------------------------------------------------


def test_10_samples_outside_d_removed_and_counted(tmp_path: Path):
    """10. restrict_to_d keeps t0 >= DEV_START and t1_max < DEV_END. run_wf reports n_outside_d."""
    frame = pd.DataFrame(
        {
            "t0": [
                DEV_START - 1,
                DEV_START,
                DEV_END - 10,
                DEV_END - 10,
                DEV_END - 10,
            ],
            "t1_max": [
                DEV_START + 5,
                DEV_START + 5,
                DEV_END - 1,
                DEV_END,
                DEV_END + 1,
            ],
        }
    )
    frame.attrs["dataset"] = "synthetic_d"
    kept, removed = restrict_to_d(frame)
    assert removed == 3
    assert len(kept) == 2
    assert kept["t0"].tolist() == [DEV_START, DEV_END - 10]
    assert kept["t1_max"].tolist() == [DEV_START + 5, DEV_END - 1]
    assert kept.attrs == {"dataset": "synthetic_d"}

    start = DEV_START - 40 * DAY
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=170, start_ms=start, seed=100, inject_signal=True)
    ds_dir = _create_synthetic_dataset_dir(tmp_path / "t10_ds", panel)
    first_refit = DEV_START + 30 * DAY
    cfg_file, cfg_dict = _cfg_file(tmp_path, "cfg10", first_refit_ms=first_refit, features=["ret_1"], threshold=0.00005)
    raw = decision_samples(panel, _run_config(cfg_dict))
    expected_outside = int((raw["t0"] < DEV_START).sum())
    assert expected_outside > 0

    receipt = run_wf(cfg_file, ds_dir, tmp_path / "out10", commit=COMMIT, panel=panel)
    assert receipt["metrics"]["n_outside_d"] == expected_outside
    assert receipt["metrics"]["n_samples"] == len(raw) - expected_outside


# ---------------------------------------------------------------------------
# Brief 21: receipts, commit guard, item 3 guard, family_report controls and seeds
# ---------------------------------------------------------------------------


def _small_run(tmp_path: Path, name: str, **over):
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=10, inject_signal=True)
    ds_dir = _create_synthetic_dataset_dir(tmp_path / f"{name}_ds", panel)
    cfg_file, cfg = _cfg_file(tmp_path, name, id=name, **over)
    return panel, ds_dir, cfg_file, cfg


def test_run_wf_daily_has_cost_columns(tmp_path: Path):
    """daily.parquet carries the cost columns, the receipt the gross paths and the folds their exposure."""
    panel, ds_dir, cfg_file, _ = _small_run(tmp_path, "cols")
    receipt = run_wf(cfg_file, ds_dir, tmp_path / "out", commit=COMMIT, panel=panel)
    run_dir = tmp_path / "out" / "cols"

    daily = pd.read_parquet(run_dir / "daily.parquet")
    for col in ("drift_free", "bet", "gross_hedged", "costs", "fees", "slippage", "funding"):
        assert col in daily.columns, col
    assert daily["bet"].any() and not daily["bet"].all()
    idle = daily.loc[~daily["bet"]]
    assert (idle[["drift_free", "gross_hedged", "costs", "fees", "slippage", "funding"]] == 0.0).all().all()
    np.testing.assert_allclose(
        daily["drift_free"], daily["gross_hedged"] - daily["costs"] + daily["funding"], rtol=1e-9, atol=1e-12
    )
    np.testing.assert_allclose(daily["costs"], daily["fees"] + daily["slippage"], rtol=1e-9, atol=1e-15)
    assert (daily["costs"] >= 0.0).all() and daily["costs"].sum() > 0.0

    m = receipt["metrics"]
    assert len(m["cpcv_path_gross_means"]) == 5
    assert all(np.isfinite(v) for v in m["cpcv_path_gross_means"])
    # Gross paths add no costs, so they sit at or above the net paths (a path with no tranche has both at zero).
    pairs = list(zip(m["cpcv_path_gross_means"], m["cpcv_path_means"], strict=True))
    assert all(g >= n for g, n in pairs) and any(g > n for g, n in pairs)

    folds = json.loads((run_dir / "folds.json").read_text(encoding="utf-8"))
    assert receipt["kind"] == "trial"
    run_tranches = pd.read_parquet(run_dir / "tranches.parquet")
    traded = [f for f in folds if f["long_share"] is not None]
    assert traded
    for f in traded:
        assert 0.0 <= f["long_share"] <= 1.0
        assert -1.0 <= f["net_exposure"] <= 1.0
    assert len(run_tranches) > 0


def test_run_wf_requires_commit(tmp_path: Path, monkeypatch):
    """No sha argument and no R4_COMMIT gives a ValueError, never the string 'unknown'. A non-hex sha is refused."""
    from r4.cli import resolve_commit

    panel, ds_dir, cfg_file, _ = _small_run(tmp_path, "nocommit")
    monkeypatch.delenv("R4_COMMIT", raising=False)
    with pytest.raises(ValueError, match="commit"):
        run_wf(cfg_file, ds_dir, tmp_path / "out", panel=panel)
    with pytest.raises(ValueError, match="commit"):
        run_wf(cfg_file, ds_dir, tmp_path / "out", commit="not-a-sha", panel=panel)
    assert not (tmp_path / "out").exists()

    monkeypatch.setenv("R4_COMMIT", "0123abcd")
    assert resolve_commit(None) == "0123abcd"
    assert resolve_commit("ABCDEF1") == "ABCDEF1"
    for bad in ("abc12", "g" * 7, "a" * 41, "unknown", ""):
        monkeypatch.setenv("R4_COMMIT", bad)
        with pytest.raises(ValueError, match="commit"):
            resolve_commit(None)


@pytest.mark.parametrize("kind", [None, "bogus", "Trial", 3])
def test_receipt_kind_required(tmp_path: Path, kind):
    """The config key kind must be trial, control or retest, else run_wf raises before any work."""
    panel, ds_dir, _, cfg = _small_run(tmp_path, "kind")
    cfg = {k: v for k, v in cfg.items() if k != "kind"}
    if kind is not None:
        cfg["kind"] = kind
    path = tmp_path / "kind_cfg.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(ValueError, match="kind"):
        run_wf(path, ds_dir, tmp_path / "out", commit=COMMIT, panel=panel)


def test_item3_raises_below_two_configs():
    """Fewer than two finite trial Sharpes (sequence path) cannot give a variance. A mapping raises (brief 28g)."""
    receipt = {"metrics": {"wf_sharpe": 0.5, "n_days": 120}}
    days = [i * DAY for i in range(120)]

    def frame(h: str) -> pd.DataFrame:
        df = pd.DataFrame({"drift_free": np.linspace(-0.001, 0.003, 120)}, index=pd.Index(days, name="day_start"))
        df.attrs["config_hash"] = h
        return df

    with pytest.raises(TypeError, match="mapping"):
        item3(receipt, {"r1": frame("h"), "r2": frame("h")}, ledger_count=120)
    with pytest.raises(TypeError, match="mapping"):
        item3(receipt, {}, ledger_count=120)
    with pytest.raises(ValueError, match="at least 2"):
        item3(receipt, [0.1], ledger_count=120)
    with pytest.raises(ValueError, match="at least 2"):
        item3(receipt, [0.1, float("nan")], ledger_count=120)
    ok = item3(receipt, [0.1, 0.3], ledger_count=120)
    assert ok["n_unique_configs"] is None and ok["var_trial_sharpes"] == pytest.approx(0.02)


def _set_kind(runs_dir: Path, kinds: dict[str, str]) -> None:
    for run_id, kind in kinds.items():
        path = runs_dir / run_id / "receipt.json"
        rec = json.loads(path.read_text(encoding="utf-8"))
        rec["kind"] = kind
        path.write_text(json.dumps(rec), encoding="utf-8")


def _set_config_seeds(runs_dir: Path, seeds: dict[str, int]) -> None:
    for run_id, seed in seeds.items():
        path = runs_dir / run_id / "receipt.json"
        rec = json.loads(path.read_text(encoding="utf-8"))
        rec["config"]["joint_shift_seed"] = seed
        path.write_text(json.dumps(rec), encoding="utf-8")


def test_family_report_refuses_controls_in_round_variance(tmp_path: Path):
    """A control receipt in the round directory raises: controls are excluded from the round-close variance."""
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    round_dir = tmp_path / "round"
    for run_id in ("cfg_0", "cfg_1"):
        (round_dir / run_id).mkdir(parents=True)
        for name in ("receipt.json", "daily.parquet"):
            (round_dir / run_id / name).write_bytes((runs_dir / run_id / name).read_bytes())
    _set_kind(round_dir, {"cfg_1": "control"})
    with pytest.raises(ValueError, match="controls are excluded from the round-close variance"):
        family_report("A", runs_dir, round_dir, 120, ds_dir, panel=panel)


def test_family_report_calibration_mode(tmp_path: Path):
    """calibration=True accepts only control receipts. calibration=False (default) never sees them."""
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    with pytest.raises(ValueError, match="control"):
        family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, calibration=True)  # trial receipts
    _set_kind(runs_dir, {"cfg_0": "control", "cfg_1": "control"})
    _set_config_seeds(runs_dir, {"cfg_0": 11, "cfg_1": 12})
    rep = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, calibration=True)
    assert rep["n_configurations"] == 2 and rep["calibration"] is True
    with pytest.raises(ValueError, match="controls are excluded"):
        family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel)


def test_joint_shift_seeds_per_config(tmp_path: Path, monkeypatch):
    """Each config's joint-shift seed is seed_base + its index in sorted run ids, and the report records it."""
    import r4.bar as bar

    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    seen: list[int] = []
    original = bar.joint_shift_null

    def recording(*args, **kwargs):
        seen.append(kwargs["seed"])
        return original(*args, **kwargs)

    monkeypatch.setattr(bar, "joint_shift_null", recording)
    rep = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel)
    assert seen == [5_000_000, 5_000_001]
    assert [rep["configurations"][c]["joint_shift_seed"] for c in ("cfg_0", "cfg_1")] == seen
    assert rep["seed_base"] == 5_000_000

    seen.clear()
    rep2 = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, seed_base=42)
    assert seen == [42, 43]
    assert rep2["configurations"]["cfg_1"]["joint_shift_seed"] == 43


def test_joint_shift_observed_uses_fill_prices(monkeypatch):
    """The observed tranche takes its own exit price (stop at an off-grid time, hedge to the next 5m boundary).

    The path-exit refusal is bypassed here so the fill-price arithmetic stays covered until the exit engine exists.
    """
    import r4.bar as bar

    monkeypatch.setattr(bar, "_refuse_path_exits", lambda tranche_list: None)
    start = 1672531200000
    n_days = 100
    panel = _pulse_panel(start, n_days, [])
    entry_ms = start + 10 * DAY + 6 * 3_600_000
    exit_ms = entry_ms + 3_600_000 + 120_000  # off the 5m grid
    entry_price = _price(panel, "BTCUSDT", entry_ms)
    exit_price = entry_price * 0.98
    tr = [
        Tranche("BTCUSDT", 1, entry_ms, exit_ms, entry_price, exit_price, "1h", 14_400_000, exit_reason="stop"),
    ]
    _p, _drop, obs, _ = joint_shift_null(
        tr, panel, _one_fold(start, n_days), start, start + n_days * DAY, n_draws=10, seed=3
    )
    hedge_end = -(-exit_ms // 300_000) * 300_000
    r_ew = np.mean([np.log(_price(panel, s, hedge_end) / _price(panel, s, entry_ms)) for s in UNIVERSE[:6]])
    fees = resolve_fee_profile("standard", "BTCUSDT")
    costs = 2 * fees.taker_fee + 2 * coin_slippage_bps("BTCUSDT") / 10000.0
    assert obs == pytest.approx(np.log(exit_price / entry_price) - 1.0 * r_ew - costs, rel=1e-9, abs=1e-12)


# ---------------------------------------------------------------------------
# Brief 24a: path-exit refusal, source digest, config seeds, SPA seed
# ---------------------------------------------------------------------------


def test_joint_shift_refuses_path_exits():
    start = 1672531200000
    n_days = 100
    panel = _pulse_panel(start, n_days, [])
    entry_ms = start + 10 * DAY + 6 * 3_600_000
    price = _price(panel, "BTCUSDT", entry_ms)
    tr = [Tranche("BTCUSDT", 1, entry_ms, entry_ms + 3_600_000, price, price, "1h", 14_400_000, exit_reason="stop")]
    with pytest.raises(ValueError, match="exit-engine replay"):
        joint_shift_null(tr, panel, _one_fold(start, n_days), start, start + n_days * DAY, n_draws=10, seed=3)
    horizon = [dataclasses.replace(tr[0], exit_reason="horizon")]
    joint_shift_null(horizon, panel, _one_fold(start, n_days), start, start + n_days * DAY, n_draws=10, seed=3)


def test_source_digest_changes(tmp_path: Path):
    import shutil

    from r4.cli import source_digest

    pkg = Path(__file__).resolve().parents[1] / "r4"
    copy = tmp_path / "r4"
    shutil.copytree(pkg, copy, ignore=shutil.ignore_patterns("__pycache__"))
    base = source_digest(copy)
    assert len(base) == 64 and base == source_digest(copy)
    assert source_digest() == base  # the live package digest equals the copy's
    target = copy / "costs.py"
    target.write_text(target.read_text(encoding="utf-8") + "\n# changed\n", encoding="utf-8")
    changed = source_digest(copy)
    assert changed != base
    target.write_text(target.read_text(encoding="utf-8").replace("\n# changed\n", ""), encoding="utf-8")
    assert source_digest(copy) == base


def test_run_wf_receipt_has_source_sha256(tmp_path: Path):
    from r4.cli import source_digest

    panel, ds_dir, cfg_file, _ = _small_run(tmp_path, "srcsha")
    receipt = run_wf(cfg_file, ds_dir, tmp_path / "out", commit=COMMIT, panel=panel)
    assert receipt["source_sha256"] == source_digest()


def test_family_report_uses_config_seed(tmp_path: Path, monkeypatch):
    import r4.bar as bar

    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    _set_config_seeds(runs_dir, {"cfg_0": 111})  # cfg_1 has none and falls back to seed_base + index
    seen: list[int] = []
    original = bar.joint_shift_null

    def recording(*args, **kwargs):
        seen.append(kwargs["seed"])
        return original(*args, **kwargs)

    monkeypatch.setattr(bar, "joint_shift_null", recording)
    rep = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel)
    assert seen == [111, 5_000_001]
    assert [rep["configurations"][c]["joint_shift_seed"] for c in ("cfg_0", "cfg_1")] == seen


def test_calibration_requires_config_seed(tmp_path: Path):
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    _set_kind(runs_dir, {"cfg_0": "control", "cfg_1": "control"})
    _set_config_seeds(runs_dir, {"cfg_0": 11})
    with pytest.raises(ValueError, match="joint_shift_seed"):
        family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, calibration=True)


def test_spa_seed_param(tmp_path: Path, monkeypatch):
    import r4.bar as bar

    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    seen: list[int] = []
    original = bar.hansen_spa

    def recording(*args, **kwargs):
        seen.append(kwargs["seed"])
        return original(*args, **kwargs)

    monkeypatch.setattr(bar, "hansen_spa", recording)
    rep = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, seed=5)
    assert seen == [6_000_000, 6_000_000]
    assert rep["spa_seed"] == 6_000_000 and rep["seed"] == 5
    seen.clear()
    rep2 = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, seed=5, spa_seed=99)
    assert seen == [99, 99] and rep2["spa_seed"] == 99
