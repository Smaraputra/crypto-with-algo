"""Brief 32a: Phase 5 family A code (registry, twin, refit question, runner, report, dispatch). Synthetic only."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import bar, calibration, cli, family_a, features, phase5, pipeline, stats, synth

DAY = 86_400_000
SYMS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"]


@pytest.fixture(scope="module")
def configs() -> list[dict[str, Any]]:
    return family_a.family_a()


def test_registry_counts_and_seeds(configs: list[dict[str, Any]]) -> None:
    assert len(configs) == 45
    ids = [c["id"] for c in configs]
    assert len(set(ids)) == 45
    assert [c["joint_shift_seed"] for c in configs] == [10_000_000 + k for k in range(45)]
    per_cell = {cell: sum(1 for c in configs if c["cell"] == cell) for cell in calibration.CELLS}
    assert per_cell == {"C1": 6, "C2": 12, "C3": 4, "C4": 11, "C5": 12}
    per_block: dict[str, int] = {}
    for c in configs:
        per_block[c["block"]] = per_block.get(c["block"], 0) + 1
    assert per_block == {
        "ridge": 5,
        "ridge-ni": 3,
        "ridge-t": 3,
        "logit": 5,
        "lgbm": 5,
        "lgbm-m": 4,
        "lgbm-r": 4,
        "lgbm-tb": 5,
        "lgbm-tb-m": 2,
        "lgbm-all": 3,
        "lgbm-12": 3,
        "lgbm-ctx": 3,
    }
    assert ids[0] == "A_ridge_C1" and "A_lgbm-tb-m_C5" in ids and ids[-1] == "A_lgbm-ctx_C5"
    cells_in_block = [c["cell"] for c in configs if c["block"] == "lgbm-r"]
    assert cells_in_block == ["C1", "C2", "C4", "C5"]


def test_registry_fields(configs: list[dict[str, Any]]) -> None:
    for c in configs:
        rc = pipeline.run_config_from_raw(c)
        assert c["kind"] == "trial" and c["family"] == "A"
        assert c["first_refit_ms"] == 1_672_531_200_000
        assert c["seed"] == 7 and rc.seed == 7
        assert "seed" not in c["params"] and "random_state" not in c["params"]
        assert c["side_rule"] == ("sign" if c["model"] == "ridge" else "prob")
        assert (c["size_rule"], c["book"], c["exit"], c["refit"]) == ("unit", "slot", "horizon", "monthly")
        assert (c["interval"], c["h_ms"]) == calibration.CELLS[c["cell"]]
    by_id = {c["id"]: c for c in configs}
    assert by_id["A_ridge-ni_C2"]["params"] == {"alpha": 1.0, "fit_intercept": False}
    assert by_id["A_ridge-t_C4"]["threshold"] == 0.0015
    assert by_id["A_logit_C1"]["params"] == {"C": 1.0}
    assert by_id["A_lgbm_C1"]["params"] == calibration.LGBM_PARAMS
    assert by_id["A_lgbm-r_C1"]["params"] == family_a.L2_PARAMS
    assert by_id["A_lgbm-tb_C3"]["label"] == "triple_barrier"
    assert by_id["A_lgbm-tb-m_C2"]["threshold"] == 0.05
    assert by_id["A_lgbm-all_C2"]["lookback_months"] is None
    assert by_id["A_lgbm-12_C2"]["lookback_months"] == 12
    assert by_id["A_lgbm_C2"]["lookback_months"] == 24
    assert by_id["A_ridge_C5"]["lookback_months"] == 12


def test_feature_sets(configs: list[dict[str, Any]]) -> None:
    for c in configs:
        ctx = c["block"] == "lgbm-ctx"
        full = list(features.FEATURE_COLUMNS_B if ctx else features.ALL_FEATURE_COLUMNS)
        if c["interval"] == "1h":
            assert c["features"] == full
            assert "ret_4h_last" in c["features"]
        else:
            assert c["features"] == [f for f in full if f != "ret_4h_last"]
    assert len(family_a.F_1H) == 40 and len(family_a.F_4H) == 39
    assert len(family_a.FCTX_1H) == 27 and len(family_a.FCTX_4H) == 26


@pytest.fixture(scope="module")
def panel() -> dict[str, dict[str, pd.DataFrame]]:
    cov = np.diag([4e-4] * 3) + 1e-4
    start = 1_672_531_200_000
    out = synth.synth_panel(cov, SYMS, start, start + 120 * DAY, seed=5)
    rng = np.random.default_rng(9)
    for data in out.values():
        # the synthetic premium and funding are constant zero, so their z-scores would be NaN everywhere
        data["premium_5m"] = data["premium_5m"].assign(c=rng.normal(0.0, 1e-4, len(data["premium_5m"])))
        data["settlements"] = data["settlements"].assign(rate=rng.normal(1e-4, 5e-5, len(data["settlements"])))
    return out


def test_every_block_and_interval_yields_decision_samples(
    configs: list[dict[str, Any]], panel: dict[str, dict[str, pd.DataFrame]]
) -> None:
    seen: set[tuple[Any, ...]] = set()
    for c in configs:
        key = (c["interval"], tuple(c["features"]), c["label"])
        if key in seen:
            continue
        seen.add(key)
        samples = pipeline.decision_samples(panel, pipeline.run_config_from_raw(c))
        assert len(samples) > 0, c["id"]
    blocks_run = {(c["block"], c["interval"]) for c in configs}
    assert any(b == "lgbm-ctx" and i == "1h" for b, i in blocks_run)
    assert len(seen) >= 6


def test_twin(configs: list[dict[str, Any]]) -> None:
    twin = family_a.family_a_twin("A_lgbm_C5", 2)
    base = next(c for c in configs if c["id"] == "A_lgbm_C5")
    assert twin["id"] == "A_twin2_A_lgbm_C5"
    assert twin["refit"] == "none" and twin["lookback_months"] is None
    assert twin["joint_shift_seed"] == 10_000_047
    for k in base:
        if k not in ("id", "refit", "lookback_months", "joint_shift_seed"):
            assert twin[k] == base[k]
    pipeline.run_config_from_raw(twin)
    for bad in (-1, 3, True):
        with pytest.raises(ValueError):
            family_a.family_a_twin("A_lgbm_C5", bad)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        family_a.family_a_twin("A_nope_C1", 0)
    assert family_a.family_a_twin("A_ridge_C1", 0)["joint_shift_seed"] == 10_000_045


def _daily(values: np.ndarray, start: int = 0) -> pd.DataFrame:
    idx = pd.Index(start + np.arange(len(values), dtype=np.int64) * DAY, name="day_start")
    return pd.DataFrame({"drift_free": values}, index=idx)


def test_refit_question_matches_hand_bootstrap() -> None:
    rng = np.random.default_rng(1)
    cfg = _daily(rng.normal(0.001, 0.01, 200))
    twin = _daily(rng.normal(0.0, 0.01, 190))  # 10 missing days count as 0
    res = family_a.refit_question(cfg, twin, 4)
    twin_full = twin["drift_free"].reindex(cfg.index).fillna(0.0)
    diff = (cfg["drift_free"] - twin_full).to_numpy()
    point, low, high = stats.bootstrap_ci(diff, np.mean, 1000, 10, 7_000_004, alpha=0.10)
    assert (res["point"], res["low"], res["high"]) == (point, low, high)
    assert res["seed"] == 7_000_004 and res["n"] == 200
    assert res["adopted"] == (low > 0)


def test_refit_question_zero_difference_not_adopted() -> None:
    cfg = _daily(np.random.default_rng(2).normal(0, 0.01, 100))
    res = family_a.refit_question(cfg, cfg.copy(), 0)
    assert res["point"] == 0.0 and res["low"] == 0.0 and res["high"] == 0.0
    assert res["adopted"] is False


def _write_runs(
    root: Path, configs: list[dict[str, Any]], kind: str = "trial", mutate: dict[str, Any] | None = None
) -> None:
    for c in configs:
        d = root / c["id"]
        d.mkdir(parents=True)
        receipt = {"kind": kind, "config_hash": cli.config_hash_of(c), "config": c}
        (d / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    if mutate:
        for cid, change in mutate.items():
            f = root / cid / "receipt.json"
            r = json.loads(f.read_text(encoding="utf-8"))
            r.update(change)
            f.write_text(json.dumps(r), encoding="utf-8")


def test_check_complete(tmp_path: Path, configs: list[dict[str, Any]]) -> None:
    ok = tmp_path / "ok"
    _write_runs(ok, configs)
    phase5.check_complete(ok)

    missing = tmp_path / "missing"
    _write_runs(missing, configs[1:])
    with pytest.raises(ValueError, match="missing"):
        phase5.check_complete(missing)

    extra = tmp_path / "extra"
    _write_runs(extra, configs)
    (extra / "noise_00_ridge_C1_s1").mkdir()
    with pytest.raises(ValueError, match="extra"):
        phase5.check_complete(extra)

    control = tmp_path / "control"
    _write_runs(control, configs, mutate={configs[3]["id"]: {"kind": "control"}})
    with pytest.raises(ValueError, match="not a trial"):
        phase5.check_complete(control)

    wrong_hash = tmp_path / "hash"
    _write_runs(wrong_hash, configs, mutate={configs[4]["id"]: {"config_hash": "0" * 64}})
    with pytest.raises(ValueError, match="registry entry"):
        phase5.check_complete(wrong_hash)

    bound = {"commit": "c" * 40, "source_sha256": "d" * 64, "dataset_hash": "e" * 64}
    same = tmp_path / "same"
    _write_runs(same, configs, mutate={c["id"]: bound for c in configs})
    phase5.check_complete(same, **bound)
    for key in bound:
        other = tmp_path / f"other_{key}"
        _write_runs(other, configs, mutate={c["id"]: bound for c in configs})
        f = other / configs[5]["id"] / "receipt.json"
        r = json.loads(f.read_text(encoding="utf-8"))
        r[key] = "0" * len(bound[key])
        f.write_text(json.dumps(r), encoding="utf-8")
        with pytest.raises(ValueError, match=key):
            phase5.check_complete(other, **bound)


def test_report_family_uses_standard_hedge_profile(
    tmp_path: Path, configs: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    runs = tmp_path / "runs"
    _write_runs(runs, configs)
    for c in configs:
        # The cost drag reads the daily costs column (A5.1 diff review F1): C3 carries the highest costs here, while
        # its net walk-forward mean below is the best, so a net-mean ranking would not put C3 first.
        daily = _daily(np.zeros(5))
        daily["costs"] = 0.002 if c["cell"] == "C3" else 0.0005
        daily.to_parquet(runs / c["id"] / "daily.parquet")
    passing = "A_lgbm_C5"

    def ev(cid: str) -> dict[str, Any]:
        p = cid == passing
        return {
            "item1": {"pass": p, "wf_mean": 0.001 if cid.endswith("C3") else 0.0},
            "item2": {"pass": True},
            "item3": {"pass": p},
            "item4": {"pass": p},
            "item5": {"pass": p},
            "item6": {"pass": p},
            "joint_shift_seed": None,
            "all_pass": p,
        }

    calls: list[Any] = []

    def fake_family_report(family: str, runs_dir: Any, round_dir: Any, count: int, ds: Any, **kw: Any) -> dict:
        calls.append((count, kw["tripwire"], kw["family_index"], Path(kw["out_file"]).name))
        two = kw["tripwire"] is not None
        return {
            "configurations": {c["id"]: ev(c["id"]) for c in configs},
            "candidates": [{"id": passing}] if two else [],
            "finalists": [],
            "variance": {},
            "tripwire": "passed" if two else "pending",
            "tripwire_input": kw["tripwire"],
        }

    hedge_calls: list[tuple[str, str]] = []

    def fake_hedge(run_dir: Any, panel: Any, universe: Any, profile: str = "other") -> dict:
        hedge_calls.append((Path(run_dir).name, profile))
        return {}

    complete_calls: list[dict[str, Any]] = []
    monkeypatch.setattr(phase5, "_load", lambda ds: ({"datasetHash": "e" * 64}, {s: {} for s in SYMS}))
    monkeypatch.setattr(phase5, "check_complete", lambda runs_dir, **kw: complete_calls.append(kw))
    monkeypatch.setattr(bar, "family_report", fake_family_report)
    monkeypatch.setattr(bar, "item2", lambda d: {"pbo": 0.1, "pass": True})
    monkeypatch.setattr(cli, "run_tripwire", lambda *a, **k: {"positive": 12, "n": 100})
    monkeypatch.setattr(phase5.hedge_cost, "run_hedge_cost", fake_hedge)
    monkeypatch.setattr(phase5.account, "account_report", lambda *a, **k: {})

    out = tmp_path / "out"
    report = phase5.report_family(tmp_path / "ds", runs, out, "abc1234")
    assert hedge_calls == [(passing, "standard")]
    assert calls == [
        (57, None, 0, "bar_pass1.json"),
        (57, {"positive": 12, "n": 100}, 0, "bar_pass2.json"),
    ]
    assert report["largest_tripwire_positive"] == 12 and report["halted"] is False
    assert report["twin_plan"] == [
        {
            "id": passing,
            "registry_index": [c["id"] for c in configs].index(passing),
            "slot": 0,
            "twin_id": f"A_twin0_{passing}",
        }
    ]
    assert report["cost_drag_by_cell"]["ranked_worst_first"][0] == "C3"
    assert complete_calls == [{"commit": "abc1234", "source_sha256": cli.source_digest(), "dataset_hash": "e" * 64}]
    assert (out / "family_a_report.json").is_file()


def test_cli_dispatch_refuses_other_families(monkeypatch: pytest.MonkeyPatch) -> None:
    for cmd in (
        ["family-run", "--family", "B", "--ds", "d", "--out", "o", "--commit", "c"],
        ["family-report", "--family", "B", "--ds", "d", "--runs", "r", "--out", "o", "--commit", "c"],
        ["family-twins", "--family", "B", "--ds", "d", "--runs", "r", "--report", "p", "--out", "o", "--commit", "c"],
    ):
        monkeypatch.setattr("sys.argv", ["r4.cli", *cmd])
        with pytest.raises(SystemExit):
            cli.main()
