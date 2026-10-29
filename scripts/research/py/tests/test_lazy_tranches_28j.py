"""Brief 28j: read tranche frames one config at a time (lazy tranches)."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4 import bar
from r4 import calibration as cal
from r4.cli import config_hash_of, run_wf
from r4.method import DEV_END, UNIVERSE
from r4.synth import write_synthetic_dataset
from tests.test_cli_bar import (
    COMMIT,
    _create_synthetic_dataset_dir,
    _make_fast_synthetic_panel,
    _one_fold,
    _pulse_panel,
    _pulse_tranches,
)

DAY = 86_400_000
FIRST_REFIT = 1_680_307_200_000


@pytest.fixture(scope="module")
def noise_runs(tmp_path_factory):
    root = tmp_path_factory.mktemp("lazy_noise")
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=21)
    ds_dir = write_synthetic_dataset(panel, root / "ds")
    grid = cal.noise_grid()
    pick = [
        next(c for c in grid if c["block"] == "ridge" and c["cell"] == "C2" and c["seed_ordinal"] == 1),
        next(c for c in grid if c["block"] == "ridge" and c["cell"] == "C2" and c["seed_ordinal"] == 2),
        next(c for c in grid if c["block"] == "ridge" and c["cell"] == "C4" and c["seed_ordinal"] == 1),
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


def test_load_noise_runs_stores_path_not_dataframe(noise_runs):
    runs = cal._load_noise_runs(noise_runs["runs"])
    assert len(runs) == 3
    for rid, entry in runs.items():
        assert "tranches" not in entry
        assert "tranches_path" in entry
        tp = entry["tranches_path"]
        assert isinstance(tp, Path)
        assert tp == noise_runs["runs"] / rid / "tranches.parquet"
        assert tp.is_file()
        assert [k for k, v in entry.items() if isinstance(v, pd.DataFrame)] == ["daily"]
        df_read = cal._read_tranches(tp)
        df_direct = pd.read_parquet(tp)
        pd.testing.assert_frame_equal(df_read, df_direct)

    # Missing file returns empty DataFrame
    assert cal._read_tranches(None).empty


def test_evaluate_noise_interleaving(noise_runs, monkeypatch):
    log: list[tuple[str, str]] = []
    real_read_parquet = pd.read_parquet

    def spy_read_parquet(path, *a, **kw):
        p = Path(path)
        if p.name == "tranches.parquet":
            log.append(("read", p.parent.name))
        return real_read_parquet(path, *a, **kw)

    monkeypatch.setattr(cal.pd, "read_parquet", spy_read_parquet)

    seed_to_id = {int(c["joint_shift_seed"]): c["id"] for c in noise_runs["pick"]}
    real_joint_stats = bar.joint_shift_stats

    def spy_joint_stats(tranches, panel, folds, **kw):
        seed = kw["seed"]
        log.append(("joint", seed_to_id[seed]))
        return real_joint_stats(tranches, panel, folds, **kw)

    monkeypatch.setattr(cal.bar, "joint_shift_stats", spy_joint_stats)

    cal.evaluate_noise(noise_runs["runs"], noise_runs["ds"], panel=noise_runs["panel"], joint_draws=5)

    expected: list[tuple[str, str]] = []
    for rid in sorted(c["id"] for c in noise_runs["pick"]):
        expected.append(("read", rid))
        expected.append(("joint", rid))

    assert log == expected


def test_evaluate_noise_values_unchanged(noise_runs):
    out = cal.evaluate_noise(noise_runs["runs"], noise_runs["ds"], panel=noise_runs["panel"], joint_draws=5)
    ids = sorted(c["id"] for c in noise_runs["pick"])
    assert out["n_configs"] == len(ids)
    assert sorted(out["configs"]) == ids
    for c in noise_runs["pick"]:
        e = out["configs"][c["id"]]
        assert {"item1", "item3", "joint_shift", "pass_items_1_to_3", "cell", "book_anchor"} <= set(e)
        assert e["joint_shift"]["seed"] == c["joint_shift_seed"]
        assert e["joint_shift"]["draws"] == 5
        assert 0.0 < e["joint_shift"]["p"] <= 1.0
        assert e["book_anchor"]["ok"] is True
    assert out["variance"]["mode"] == "within_cell"
    assert out["gated"]["n_pass_items_1_to_3"] == sum(e["pass_items_1_to_3"] for e in out["configs"].values())


def test_load_run_with_tranches_flag(noise_runs, monkeypatch):
    run_dir = noise_runs["runs"] / noise_runs["pick"][0]["id"]
    full = cal._load_run(run_dir, with_tranches=True)
    assert "tranches" in full
    assert isinstance(full["tranches"], pd.DataFrame)
    assert not full["tranches"].empty

    read_calls: list[str] = []
    real_read_parquet = pd.read_parquet

    def spy_read(path, *a, **kw):
        read_calls.append(Path(path).name)
        return real_read_parquet(path, *a, **kw)

    monkeypatch.setattr(cal.pd, "read_parquet", spy_read)

    no_tr = cal._load_run(run_dir, with_tranches=False)
    assert "tranches.parquet" not in read_calls
    assert "tranches" not in no_tr
    assert no_tr["receipt"] == full["receipt"]
    assert no_tr["folds"] == full["folds"]
    pd.testing.assert_frame_equal(no_tr["daily"], full["daily"])


def test_synthetic_v_loads_v_runs_without_tranches(tmp_path, monkeypatch):
    from tests import test_synth_v_28i as t28i

    t28i._two_configs(monkeypatch)
    t28i._floor_fails(monkeypatch, set())
    monkeypatch.setattr(cal, "FIRST_REFIT_MS", t28i.FIRST_REFIT)

    calls: list[tuple[str, bool]] = []
    real_load_run = cal._load_run

    def spy_load_run(run_dir, *, with_tranches: bool = True):
        calls.append((str(run_dir), with_tranches))
        return real_load_run(run_dir, with_tranches=with_tranches)

    monkeypatch.setattr(cal, "_load_run", spy_load_run)

    dcov = t28i._write_dcov(tmp_path)
    out = cal.synthetic_v(dcov, tmp_path / "out", COMMIT, **t28i.SMALL)

    v_calls = [c for c in calls if f"v_{cal.SYNTH_V_SEED}/runs" in c[0]]
    assert [w for _, w in v_calls] == [False, False]

    ref_calls = [c for c in calls if f"v_{cal.SYNTH_V_SEED}/runs" not in c[0]]
    assert all("/ref_" in p for p, _ in ref_calls)
    assert [w for _, w in ref_calls] == [True] * 4

    written = json.loads((tmp_path / "out" / "synth_v.json").read_text(encoding="utf-8"))
    for key in (
        "panel_seeds",
        "noise_set",
        "variance",
        "sr0",
        "trade_floor",
        "reference_panels",
        "dcov_sha256",
        "dcov_dataset_hash",
        "provenance",
        "reproduction",
    ):
        assert key in written
    assert written["panel_seeds"] == {"v": 3999, "reference": [3997, 3998]}
    assert len(written["noise_set"]) == 2
    assert out["noise_set"] == written["noise_set"]


def test_family_report_lazily_reads_tranches_only_for_passing_runs(tmp_path, monkeypatch):
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
            {"drift_free": 0.002 + 0.0005 * i + noise, "bet": [True] * 100},
            index=pd.Index(days, name="day_start"),
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
        # cfg_0 passes item 1; cfg_1 fails item 1 by negative wf_sharpe and negative wf_mean
        wf_mean = 0.002 if i == 0 else -0.01
        wf_sharpe = 4.0 if i == 0 else -1.0
        receipt = {
            "kind": "trial",
            "commit": "abc",
            "dataset_hash": "hash123",
            "config_hash": config_hash_of(config),
            "config": config,
            "metrics": {
                "wf_mean": wf_mean,
                "wf_sd": 0.0005,
                "wf_sharpe": wf_sharpe,
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

    tranches_read: list[str] = []
    real_read_parquet = pd.read_parquet

    def spy_read(path, *a, **kw):
        p = Path(path)
        if p.name == "tranches.parquet":
            tranches_read.append(p.parent.name)
        return real_read_parquet(path, *a, **kw)

    monkeypatch.setattr(bar.pd, "read_parquet", spy_read)

    rep = bar.family_report(
        family="A",
        runs_dir=runs_dir,
        round_runs_dir=runs_dir,
        ledger_count=120,
        ds_dir=ds_dir,
        out_file=tmp_path / "report.json",
        seed=7,
        panel=panel,
    )

    assert rep["configurations"]["cfg_0"]["item1"]["pass"] is True
    assert rep["configurations"]["cfg_1"]["item1"]["pass"] is False
    assert tranches_read == ["cfg_0"]
    assert len(rep["candidates"]) == 1
    assert rep["candidates"][0]["id"] == "cfg_0"
