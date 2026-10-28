"""Brief 28a: within-cell V, the registered calibration grids, D covariance input and the noise evaluation."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4 import calibration as cal
from r4.bar import cell_key, family_report, item3, trial_sharpe_variance
from r4.calibration_null import simulate_daily_null
from r4.cli import config_hash_of, main, run_wf
from r4.features import ALL_FEATURE_COLUMNS
from r4.method import DEV_END, DEV_START, UNIVERSE
from r4.pipeline import RunConfig
from r4.synth import synth_panel, write_synthetic_dataset
from tests.test_cli_bar import COMMIT, _make_fast_synthetic_panel

DAY = 86_400_000
H = 3_600_000


# ---------------------------------------------------------------------------
# cell_key and the within-cell variance
# ---------------------------------------------------------------------------


def _frame(sharpe: float, h: str, n: int = 3) -> pd.DataFrame:
    """A daily series [S-1, S, S+1] has mean S and SD 1, so its per-period Sharpe is exactly S."""
    base = np.array([sharpe - 1.0, sharpe, sharpe + 1.0])
    df = pd.DataFrame({"drift_free": base})
    df.attrs["config_hash"] = h
    return df


def _cfg(interval: str, h_ms: int, **over) -> dict:
    return {"interval": interval, "h_ms": h_ms, "label": "fixed", "exit": "horizon", **over}


def test_cell_key_and_within_cell_variance_hand_values():
    """Two cells of three configs, a singleton cell and a duplicate hash that counts once."""
    daily = {
        "a1": _frame(0.5, "ha1"),
        "a2": _frame(1.0, "ha2"),
        "a3": _frame(1.5, "ha3"),
        "a1_dup": _frame(0.5, "ha1"),  # the same config as a1, counted once
        "b1": _frame(0.2, "hb1"),
        "b2": _frame(0.4, "hb2"),
        "b3": _frame(0.9, "hb3"),
        "c1": _frame(3.0, "hc1"),  # a singleton cell
    }
    cell_a = _cfg("1h", 4 * H)
    cell_b = _cfg("4h", 8 * H, exit={"rule": "E2", "k": 1.0})
    cfgs = {k: cell_a for k in ("a1", "a2", "a3", "a1_dup")}
    cfgs.update({k: cell_b for k in ("b1", "b2", "b3")})
    cfgs["c1"] = _cfg("4h", 24 * H)

    out = trial_sharpe_variance(daily, cfgs, "within_cell")
    # cell a: mean 1.0, sum of squares 0.5. cell b: mean 0.5, sum of squares 0.26. df = 2 + 2.
    assert out["df"] == 4
    assert out["V"] == pytest.approx((0.5 + 0.26) / 4)
    assert out["cells_used"] == 2
    assert out["cells_singleton"] == 1

    # Total mode: the 7 unique Sharpes (a1 once) with ddof 1.
    tot = trial_sharpe_variance(daily, cfgs, "total")
    sr = [0.5, 1.0, 1.5, 0.2, 0.4, 0.9, 3.0]
    assert tot["V"] == pytest.approx(np.var(sr, ddof=1))
    assert tot["df"] == 6

    # The cell key: interval, h, label, canonical exit, book (default slot).
    assert cell_key(cell_a) == ("1h", 4 * H, "fixed", "horizon", "slot")
    assert cell_key(cell_b)[3] == json.dumps({"k": 1.0, "rule": "E2"}, sort_keys=True)
    assert cell_key({**cell_a, "book": "D"}) != cell_key(cell_a)
    assert cell_key({**cell_b, "exit": {"k": 1.0, "rule": "E2"}}) == cell_key(cell_b)  # key order does not matter

    # Every cell a singleton: the pooled degrees of freedom are below 1.
    with pytest.raises(ValueError, match="degrees of freedom"):
        trial_sharpe_variance({"a1": daily["a1"], "b1": daily["b1"]}, {"a1": cell_a, "b1": cell_b}, "within_cell")
    with pytest.raises(ValueError, match="mode"):
        trial_sharpe_variance(daily, cfgs, "nope")


def test_cost_free_total_uses_gross_plus_funding():
    a = pd.DataFrame({"drift_free": [0.0, 0.1, 0.2], "gross_hedged": [1.0, 2.0, 3.0], "funding": [0.5, 0.5, 0.5]})
    a.attrs["config_hash"] = "x"
    b = pd.DataFrame({"drift_free": [0.0, 0.1, 0.2], "gross_hedged": [1.0, 1.0, 4.0], "funding": [0.0, 0.0, 0.0]})
    b.attrs["config_hash"] = "y"
    cfgs = {"a": _cfg("1h", 4 * H), "b": _cfg("1h", 4 * H)}
    out = trial_sharpe_variance({"a": a, "b": b}, cfgs, "cost_free_total")
    s_a = 2.5 / 1.0  # [1.5, 2.5, 3.5] has mean 2.5 and SD 1
    s_b = float(np.mean([1, 1, 4]) / np.std([1, 1, 4], ddof=1))
    assert out["V"] == pytest.approx(np.var([s_a, s_b], ddof=1))
    assert out["df"] == 1
    bad = pd.DataFrame({"drift_free": [0.0, 0.1, 0.2]})
    bad.attrs["config_hash"] = "z"
    with pytest.raises(ValueError, match="gross_hedged"):
        trial_sharpe_variance({"a": a, "z": bad}, {"a": cfgs["a"], "z": cfgs["a"]}, "cost_free_total")


def _write_cell_family(tmp_path: Path) -> tuple[Path, Path]:
    """Four control runs in two cells (2 + 2) with a manifest. Returns (runs_dir, ds_dir)."""
    rng = np.random.default_rng(3)
    ds_dir = tmp_path / "ds"
    ds_dir.mkdir()
    (ds_dir / "manifest.json").write_text(
        json.dumps({"version": 1, "datasetHash": "abc", "symbols": list(UNIVERSE[:2]), "files": []}), encoding="utf-8"
    )
    start = DEV_END - 120 * DAY
    days = [start + i * DAY for i in range(120)]
    runs_dir = tmp_path / "runs"
    for i, (interval, h_ms) in enumerate([("1h", 4 * H), ("1h", 4 * H), ("4h", 8 * H), ("4h", 8 * H)]):
        run_id = f"r{i}"
        d = runs_dir / run_id
        d.mkdir(parents=True)
        drift = rng.normal(0.0, 0.001, 120) + 0.0001 * i
        daily = pd.DataFrame(
            {"drift_free": drift, "bet": True, "gross_hedged": drift + 0.0005, "funding": 0.0},
            index=pd.Index(days, name="day_start"),
        )
        daily.to_parquet(d / "daily.parquet")
        config = {
            "id": run_id,
            "family": "noise",
            "model": "ridge",
            "interval": interval,
            "h_ms": h_ms,
            "label": "fixed",
            "exit": "horizon",
            "first_refit_ms": start,
            "joint_shift_seed": 5_000_000 + i,
            "variant": i,
        }
        receipt = {
            "kind": "control",
            "commit": COMMIT,
            "dataset_hash": "abc",
            "config_hash": config_hash_of(config),
            "config": config,
            "metrics": {
                "wf_mean": float(drift.mean()),
                "wf_sd": 0.001,
                "wf_sharpe": float(drift.mean() / drift.std(ddof=1)),
                "n_days": 120,
                "bet_days": 120,
                "cpcv_path_means": [-0.001] * 5,
                "coin_means": {s: -0.001 for s in UNIVERSE},
                "jackknife_means": {s: -0.001 for s in UNIVERSE},
                "stress_cost": -0.001,
                "stress_fee": -0.001,
                "stress_slippage": -0.001,
                "stress_maker_as_taker": -0.001,
                "n_maker_fills": 0,
                "n_samples": 100,
            },
        }
        (d / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    return runs_dir, ds_dir


def test_family_report_uses_within_cell_by_default_and_records_all_modes(tmp_path: Path):
    runs_dir, ds_dir = _write_cell_family(tmp_path)
    kw = {"panel": {}, "calibration": True}
    rep = family_report("noise", runs_dir, runs_dir, 120, ds_dir, **kw)
    var = rep["variance"]
    assert var["mode"] == "within_cell"
    assert set(var["modes"]) == {"within_cell", "total", "cost_free_total"}
    wc = var["modes"]["within_cell"]
    assert wc["df"] == 2 and wc["cells_used"] == 2
    assert var["V"] == pytest.approx(wc["V"])
    assert var["modes"]["total"]["df"] == 3
    # item 3 received the within-cell V.
    for cfg_eval in rep["configurations"].values():
        assert cfg_eval["item3"]["var_trial_sharpes"] == pytest.approx(wc["V"])
        assert cfg_eval["item3"]["variance_mode"] == "within_cell"
    # The total mode is selectable and differs.
    rep_total = family_report("noise", runs_dir, runs_dir, 120, ds_dir, variance_mode="total", **kw)
    assert rep_total["variance"]["mode"] == "total"
    first = next(iter(rep_total["configurations"].values()))
    assert first["item3"]["var_trial_sharpes"] == pytest.approx(rep_total["variance"]["modes"]["total"]["V"])
    assert rep_total["variance"]["modes"]["total"]["V"] != pytest.approx(wc["V"])


def test_item3_accepts_a_precomputed_variance():
    receipt = {"metrics": {"wf_sharpe": 0.1, "n_days": 700}}
    res = item3(receipt, 0.0025, 120)
    assert res["var_trial_sharpes"] == 0.0025


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------

LGBM = {
    "n_estimators": 200,
    "num_leaves": 15,
    "learning_rate": 0.05,
    "min_child_samples": 100,
    "subsample": 1.0,
    "colsample_bytree": 1.0,
}


def _run_config(c: dict) -> RunConfig:
    return RunConfig(
        family=c["family"],
        model=c["model"],
        params=c["params"],
        features=tuple(c["features"]),
        interval=c["interval"],
        h_ms=c["h_ms"],
        label=c["label"],
        side_rule=c["side_rule"],
        threshold=c["threshold"],
        size_rule=c["size_rule"],
        lookback_months=c["lookback_months"],
        refit=c["refit"],
        exit=c["exit"],
        seed=c["seed"],
        book=c.get("book", "slot"),
        noise_seed=c.get("noise_seed"),
        plant=c.get("plant"),
    )


def test_noise_grid_exact():
    grid = cal.noise_grid()
    assert len(grid) == 40
    assert json.loads(json.dumps(grid)) == grid  # plain JSON

    counts: dict[str, int] = {}
    for c in grid:
        counts[c["block"]] = counts.get(c["block"], 0) + 1
    assert counts == {"ridge": 10, "lgbm": 10, "lgbmtb": 6, "logit": 4, "noref": 4, "d": 6}

    # Every cost cell holds at least 2, and the five cells are the registered ones.
    cells: dict[tuple, int] = {}
    for c in grid:
        cells[cell_key(c)] = cells.get(cell_key(c), 0) + 1
    assert min(cells.values()) >= 2
    assert {k[:2] for k in cells} == {("1h", 4 * H), ("1h", 8 * H), ("4h", 4 * H), ("4h", 8 * H), ("4h", 24 * H)}

    ids = [c["id"] for c in grid]
    assert len(set(ids)) == 40
    assert [c["noise_seed"] for c in grid] == [1_000_000 + i for i in range(40)]
    assert [c["joint_shift_seed"] for c in grid] == [5_000_000 + i for i in range(40)]
    assert [c["seed"] for c in grid] == list(range(40))
    assert ids[0] == "noise_00_ridge_C1_s1" and ids[1] == "noise_01_ridge_C1_s2"

    names = [f"noise_{i:02d}" for i in range(20)]
    for c in grid:
        assert c["family"] == "noise" and c["kind"] == "control" and c["exit"] == "horizon"
        assert c["features"] == names
        assert c["first_refit_ms"] == 1_672_531_200_000
        _run_config(c)  # accepted by RunConfig

    by_block = {b: [c for c in grid if c["block"] == b] for b in counts}
    assert all(c["model"] == "ridge" and c["threshold"] == 0 and c["lookback_months"] == 12 for c in by_block["ridge"])
    assert all(c["refit"] == "monthly" and c["label"] == "fixed" for c in by_block["ridge"])
    assert all(c["model"] == "lightgbm" and c["params"] == LGBM and c["threshold"] == 0.02 for c in by_block["lgbm"])
    assert all(c["lookback_months"] == 24 and c["label"] == "fixed" for c in by_block["lgbm"])
    assert all(c["label"] == "triple_barrier" and c["cell"] in ("C3", "C4", "C5") for c in by_block["lgbmtb"])
    assert all(c["model"] == "logistic" and c["threshold"] == 0.05 for c in by_block["logit"])
    assert all(c["lookback_months"] is None and c["refit"] == "monthly" for c in by_block["logit"])
    assert {c["cell"] for c in by_block["logit"]} == {"C2", "C4"}
    assert all(c["refit"] == "none" and c["model"] == "ridge" for c in by_block["noref"])
    assert all(c["book"] == "D" and c["family"] == "noise" for c in by_block["d"])
    assert {c["cell"] for c in by_block["d"]} == {"C2", "C4", "C5"}
    assert all(
        c.get("book", "slot") == "slot" for b in ("ridge", "lgbm", "lgbmtb", "logit", "noref") for c in by_block[b]
    )


def test_noise_alternative_sequence():
    grid = cal.noise_grid()
    logit = next(c for c in grid if c["block"] == "logit")
    snapshot = json.loads(json.dumps(logit))
    a1 = cal.noise_alternative(logit, 1)
    assert a1["threshold"] == pytest.approx(logit["threshold"] / 2)
    assert a1["noise_seed"] == logit["noise_seed"]
    assert a1["replaces"] == logit["id"] and a1["attempt"] == 1 and a1["id"] != logit["id"]
    a2 = cal.noise_alternative(logit, 2)
    assert a2["threshold"] == pytest.approx(logit["threshold"] / 2)  # still halved
    assert a2["noise_seed"] == logit["noise_seed"] + 100
    assert a2["replaces"] == logit["id"] and a2["attempt"] == 2 and a2["id"] not in (logit["id"], a1["id"])
    assert logit == snapshot  # the original is untouched
    _run_config(a1)
    _run_config(a2)

    # A config with no margin: both attempts move the seed.
    ridge = next(c for c in grid if c["block"] == "ridge")
    r1 = cal.noise_alternative(ridge, 1)
    r2 = cal.noise_alternative(ridge, 2)
    assert r1["threshold"] == 0 and r1["noise_seed"] == ridge["noise_seed"] + 100
    assert r2["noise_seed"] == ridge["noise_seed"] + 200
    for bad in (0, 3):
        with pytest.raises(ValueError, match="attempt"):
            cal.noise_alternative(logit, bad)


def test_trade_floor_ok():
    ok = {"metrics": {"n_decisions": 20_000, "n_tranches": 1_000}}
    assert cal.trade_floor_ok(ok)
    assert not cal.trade_floor_ok({"metrics": {"n_decisions": 20_001, "n_tranches": 1_000}})  # 4.9995%
    assert not cal.trade_floor_ok({"metrics": {"n_decisions": 1_000, "n_tranches": 999}})
    # Without n_tranches the exit-reason counts give the tranche count.
    legacy = {"metrics": {"n_decisions": 10_000, "exit_reason_counts": {"horizon": 800, "stop": 300}}}
    assert cal.trade_floor_ok(legacy)
    with pytest.raises(ValueError, match="n_decisions"):
        cal.trade_floor_ok({"metrics": {"n_tranches": 5000}})


def test_exit_block_and_pc_family_shapes():
    grid = cal.noise_grid()
    base = next(c for c in grid if c["block"] == "ridge" and c["cell"] == "C4" and c["seed_ordinal"] == 1)
    block = cal.exit_block()
    assert [c["exit"]["rule"] for c in block] == ["E2", "E3", "E4", "E5", "E6", "X1"]
    assert block[0]["exit"] == {"rule": "E2", "k": 1.0}
    assert block[1]["exit"] == {"rule": "E3", "k": 2.0}
    assert block[2]["exit"] == {"rule": "E4", "margin_se": 1.0}
    # Must match whatever the E5 task commits: p_close 0.35, confirm_bars 3 (fallback 0.30 / 6).
    assert block[3]["exit"] == {"rule": "E5", "p_close": 0.35, "confirm_bars": 3}
    assert block[4]["exit"] == {
        "rule": "E6",
        "flow_bars": 12,
        "flow_lookback_days": 30,
        "flow_z": 2.0,
        "funding_threshold": 0.0005,
    }
    assert block[5]["exit"] == {"rule": "X1", "n_bars": 3}
    assert [c["joint_shift_seed"] for c in block] == [8_000_000 + i for i in range(6)]
    assert len({c["id"] for c in block}) == 6
    for c in block:
        assert c["kind"] == "control"
        diff = {k for k in base if base[k] != c[k]}
        assert diff <= {"id", "exit", "joint_shift_seed"}, diff
        assert c["noise_seed"] == base["noise_seed"] and c["model"] == "ridge" and c["cell"] == "C4"
    for c in block[:3] + block[4:]:
        _run_config(c)  # E5 is checked by the E5 task's parser

    fam = cal.pc_family(0.01)
    assert [c["id"] for c in fam] == ["pc_P1", "pc_P2", "pc_D1", "pc_D2", "pc_D3", "pc_D4"]
    assert fam[0]["features"] == ["planted_z"]
    assert fam[1]["features"][0] == "planted_z" and len(fam[1]["features"]) == 11
    p2 = fam[1]["features"][1:]
    assert len(set(p2)) == 10 and all(f in ALL_FEATURE_COLUMNS for f in p2)
    assert cal.P2_PRICE_FEATURES == tuple(p2)
    for f in p2:  # price only: no flow, funding, basis, calendar or cross-coin features
        assert not f.startswith(("taker", "funding", "basis", "btc_", "beta", "resid", "hour", "dow"))
    for i, c in enumerate(fam):
        assert c["kind"] == "control" and c["family"] == "pc"
        assert (c["interval"], c["h_ms"], c["label"], c["refit"], c["lookback_months"]) == (
            "4h",
            4 * H,
            "fixed",
            "monthly",
            12,
        )
        assert c["exit"] == "horizon" and c["model"] == "ridge" and c["threshold"] == 0
        assert c["plant"] == {"seed": 20261028, "amplitude": 0.01}
        assert c["joint_shift_seed"] == 5_100_000 + i
        _run_config(c)
    for i, c in enumerate(fam[2:]):
        assert c["features"] == [f"noise_{j:02d}" for j in range(20)]
        assert c["noise_seed"] == 2_000_001 + i
    assert fam[0].get("noise_seed") is None


def test_predictions_gated_set():
    gated = {k for k, v in cal.PREDICTIONS.items() if v["status"] == "gated"}
    assert gated == {
        "noise_items123_at_most_5",
        "noise_items123_zero_of_40",
        "noise_joint_shift_at_most_6",
        "positive_detected_at_astar",
        "natives_all_six_fail",
        "daily_null_crossing_rate_at_most_1_over_600",
        "exit_block_at_most_1_of_6_rejects",
    }
    for k, v in cal.PREDICTIONS.items():
        assert v["status"] in ("gated", "diagnostic"), k
        assert v["text"]
    diag = {k for k, v in cal.PREDICTIONS.items() if v["status"] == "diagnostic"}
    assert {
        "noise_family_pbo_net_below_0_1",
        "noise_cost_free_items123_0_to_2",
        "noise_within_seed_group_pbo_median_0_3_to_0_7",
        "noise_joint_shift_reference_panels",
        "daily_null_at_most_10_crossings",
    } <= diag


# ---------------------------------------------------------------------------
# D inputs
# ---------------------------------------------------------------------------

SYMS3 = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
COV3 = np.array([[4.0e-4, 2.4e-4, 1.8e-4], [2.4e-4, 6.0e-4, 2.7e-4], [1.8e-4, 2.7e-4, 9.0e-4]])


def test_d_daily_covariance_on_synthetic(tmp_path: Path):
    # The pure estimator recovers the generating covariance on a long panel.
    panel = synth_panel(COV3, SYMS3, DEV_START, DEV_START + 1500 * DAY, seed=11)
    closes = {s: panel[s]["1d"][["t", "c"]] for s in SYMS3}
    est = cal.cov_betas_from_daily_closes(closes, DEV_START, DEV_END)
    assert est["n_days"] == 1499  # the first close has no previous close
    cov = np.asarray(est["cov"])
    scale = np.sqrt(np.outer(np.diag(COV3), np.diag(COV3)))
    # Persistent GARCH volatility makes the sample variances noisy, so the levels get a loose band and the
    # correlations a tight one.
    assert np.all(np.abs(cov - COV3) <= 0.5 * scale)
    corr = cov / np.sqrt(np.outer(np.diag(cov), np.diag(cov)))
    corr_true = COV3 / scale
    assert np.all(np.abs(corr - corr_true) <= 0.06)
    m = np.ones(3) / 3
    true_beta = (COV3 @ m) / (m @ COV3 @ m)
    assert np.allclose(est["betas"], true_beta, atol=0.25)

    # The reader: files in, the same numbers out, plus the hash. A gap day drops its return and the next one.
    small = synth_panel(COV3, SYMS3, DEV_START, DEV_START + 40 * DAY, seed=5)
    ds = write_synthetic_dataset(small, tmp_path / "ds")
    out = cal.d_daily_covariance(ds)
    assert out["symbols"] == list(SYMS3) and out["n_days"] == 39
    ref = cal.cov_betas_from_daily_closes({s: small[s]["1d"][["t", "c"]] for s in SYMS3}, DEV_START, DEV_END)
    np.testing.assert_allclose(out["cov"], ref["cov"])
    np.testing.assert_allclose(out["betas"], ref["betas"])
    manifest = json.loads((ds / "manifest.json").read_text(encoding="utf-8"))
    assert out["dataset_hash"] == manifest["datasetHash"]
    # ddof = 1 sample covariance of the log returns.
    r = np.column_stack([np.diff(np.log(small[s]["1d"]["c"].to_numpy())) for s in SYMS3])
    np.testing.assert_allclose(out["cov"], np.cov(r.T, ddof=1))
    mean_r = r.mean(axis=1)
    np.testing.assert_allclose(out["betas"], [np.polyfit(mean_r, r[:, j], 1)[0] for j in range(3)])

    gap = {s: small[s]["1d"][["t", "c"]].copy() for s in SYMS3}
    gap[SYMS3[0]] = gap[SYMS3[0]].drop(index=20).reset_index(drop=True)
    est_gap = cal.cov_betas_from_daily_closes(gap, DEV_START, DEV_END)
    assert est_gap["n_days"] == 37  # days 20 and 21 lose their return


def test_daily_null_input_scale(tmp_path: Path):
    inp = cal.daily_null_input(COV3, [1.0, 1.1, 0.9], pilot_paths=1500)
    assert set(inp) >= {"covariance", "betas", "scale"}
    # Analytical SD of D_d: E[sign_i sign_j] = (2 / pi) arcsin(rho_ij), weights sign / n, independent of r_d.
    n = 3
    sd = np.sqrt(np.diag(COV3))
    rho = COV3 / np.outer(sd, sd)
    wcov = (2.0 / math.pi) * np.arcsin(np.clip(rho, -1.0, 1.0)) / n**2
    b = np.array([1.0, 1.1, 0.9])
    mmat = np.eye(n) - np.outer(b, np.ones(n) / n)
    var_d = float(np.trace(wcov @ (mmat @ COV3 @ mmat.T)))
    assert inp["scale"] == pytest.approx(4.0 * math.sqrt(var_d), rel=0.04)
    assert inp["pilot"]["paths"] == 1500 and inp["pilot"]["seed"] == 20261024 and inp["pilot"]["sd"] > 0
    # Deterministic.
    assert cal.daily_null_input(COV3, [1.0, 1.1, 0.9], pilot_paths=1500)["scale"] == inp["scale"]
    # The simulator accepts the input as written.
    res = simulate_daily_null(inp["covariance"], inp["betas"], n_paths=40, n_days=60, scale=inp["scale"], seed=1)
    assert res["crossing_count"] == 0
    with pytest.raises(ValueError):
        cal.daily_null_input(COV3, [1.0, 1.1], pilot_paths=10)


# ---------------------------------------------------------------------------
# The noise evaluation on a small synthetic subset
# ---------------------------------------------------------------------------

FIRST_REFIT = 1_680_307_200_000  # 2023-04-01 UTC, test only: the panel starts 2023-01-01


@pytest.fixture(scope="module")
def noise_runs(tmp_path_factory):
    root = tmp_path_factory.mktemp("noise_eval")
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=21)
    ds_dir = write_synthetic_dataset(panel, root / "ds")
    grid = cal.noise_grid()
    pick = [
        next(c for c in grid if c["block"] == blk and c["cell"] == cell and c["seed_ordinal"] == s)
        for blk, cell in (("ridge", "C2"), ("noref", "C2"), ("ridge", "C4"))
        for s in (1, 2)
    ]
    cfg_dir = root / "cfg"
    cfg_dir.mkdir()
    runs = root / "runs"
    receipts = {}
    for c in pick:
        c = {**c, "first_refit_ms": FIRST_REFIT}
        f = cfg_dir / f"{c['id']}.json"
        f.write_text(json.dumps(c), encoding="utf-8")
        receipts[c["id"]] = run_wf(f, ds_dir, runs, commit=COMMIT, panel=panel)
    return {"panel": panel, "ds": ds_dir, "runs": runs, "receipts": receipts, "pick": pick}


def test_run_wf_receipt_has_decision_and_tranche_counts(noise_runs):
    for rid, rc in noise_runs["receipts"].items():
        m = rc["metrics"]
        assert m["n_decisions"] > 0 and m["n_tranches"] >= 0, rid
        assert m["n_decisions"] <= m["n_samples"]
        assert m["n_tranches"] == sum(m["exit_reason_counts"].values())
        assert isinstance(cal.trade_floor_ok(rc), bool)


def test_evaluate_noise_on_synthetic_small(noise_runs):
    out = cal.evaluate_noise(noise_runs["runs"], noise_runs["ds"], panel=noise_runs["panel"], joint_draws=20)
    ids = sorted(c["id"] for c in noise_runs["pick"])
    assert out["n_configs"] == 6
    assert sorted(out["configs"]) == ids
    for c in noise_runs["pick"]:
        e = out["configs"][c["id"]]
        assert {"item1", "item3", "joint_shift", "pass_items_1_to_3", "cell"} <= set(e)
        assert e["joint_shift"]["seed"] == c["joint_shift_seed"]
        assert e["joint_shift"]["draws"] == 20
        assert 0.0 < e["joint_shift"]["p"] <= 1.0
        assert e["item3"]["num_trials"] == 120
    assert "pbo" in out["item2"] and out["item2"]["configs"] == ids

    var = out["variance"]
    assert var["mode"] == "within_cell"
    assert var["modes"]["within_cell"]["df"] == 4  # a 4-config cell and a 2-config cell
    assert set(var["modes"]) == {"within_cell", "total", "cost_free_total"}
    assert all(out["configs"][i]["item3"]["var_trial_sharpes"] == pytest.approx(var["V"]) for i in ids)

    n_pass = sum(e["pass_items_1_to_3"] for e in out["configs"].values())
    n_rej = sum(e["joint_shift"]["p"] < 0.05 for e in out["configs"].values())
    assert out["gated"]["n_pass_items_1_to_3"] == n_pass
    assert out["gated"]["n_reject_joint_shift_05"] == n_rej
    assert out["gated"]["bounds"] == {"items_1_to_3_max": 5, "joint_shift_reject_max": 6}

    diag = out["diagnostics"]
    assert {"family_pbo_net", "cost_free", "within_seed_group_pbo", "binomial_independence_benchmark"} <= set(diag)
    assert {"n_pass_items_1_to_3", "pbo", "item1", "item3"} <= set(diag["cost_free"])
    wsg = diag["within_seed_group_pbo"]
    assert len(wsg["groups"]) == 3 and wsg["median"] == pytest.approx(np.median(list(wsg["groups"].values())))
    assert diag["binomial_independence_benchmark"]["label"].startswith("independence benchmark")

    ver = out["verdict"]
    assert set(ver) <= set(cal.PREDICTIONS) and len(ver) >= 7
    assert ver["noise_items123_zero_of_40"]["met"] is (n_pass == 0)
    assert ver["noise_items123_at_most_5"]["met"] is (n_pass <= 5)
    assert ver["noise_joint_shift_at_most_6"]["met"] is (n_rej <= 6)
    assert ver["noise_family_pbo_net_below_0_1"]["status"] == "diagnostic"
    assert ver["noise_items123_zero_of_40"]["status"] == "gated"
    gated_met = all(v["met"] for v in ver.values() if v["status"] == "gated")
    assert out["gate_ok"] is gated_met
    json.dumps(out)  # serialisable


def test_cli_calib_subcommands(tmp_path: Path, monkeypatch, noise_runs):
    def run(*argv: str) -> None:
        monkeypatch.setattr(sys, "argv", ["r4", *argv])
        main()

    run("calib-grid", "--out", str(tmp_path / "grid"))
    assert len(list((tmp_path / "grid" / "noise").glob("*.json"))) == 40
    assert len(list((tmp_path / "grid" / "exit").glob("*.json"))) == 6
    assert len(list((tmp_path / "grid" / "pc").glob("*.json"))) == 6
    one = json.loads(next((tmp_path / "grid" / "noise").glob("noise_00_*.json")).read_text(encoding="utf-8"))
    assert one["id"] == "noise_00_ridge_C1_s1"

    small = synth_panel(COV3, SYMS3, DEV_START, DEV_START + 40 * DAY, seed=5)
    ds = write_synthetic_dataset(small, tmp_path / "dsd")
    run("calib-dcov", "--ds", str(ds), "--out", str(tmp_path / "dcov.json"))
    dcov = json.loads((tmp_path / "dcov.json").read_text(encoding="utf-8"))
    assert dcov["n_days"] == 39 and len(dcov["cov"]) == 3

    run(
        "calib-null-input",
        "--dcov",
        str(tmp_path / "dcov.json"),
        "--out",
        str(tmp_path / "null.json"),
        "--pilot-paths",
        "50",
    )
    nul = json.loads((tmp_path / "null.json").read_text(encoding="utf-8"))
    assert nul["scale"] > 0 and len(nul["covariance"]) == 3 and len(nul["betas"]) == 3

    run(
        "calib-noise-eval",
        "--runs",
        str(noise_runs["runs"]),
        "--ds",
        str(noise_runs["ds"]),
        "--out",
        str(tmp_path / "eval.json"),
        "--draws",
        "10",
    )
    ev = json.loads((tmp_path / "eval.json").read_text(encoding="utf-8"))
    assert ev["n_configs"] == 6 and ev["gated"]["n_pass_items_1_to_3"] >= 0
