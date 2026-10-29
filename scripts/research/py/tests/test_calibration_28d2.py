"""Brief 28d-2: a* and its grid, the positive-control failure tree, dossier cross-checks, cost-free V."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4 import calibration as cal
from r4.bar import trial_sharpe_variance
from r4.cli import main
from r4.method import DEV_END
from tests.test_calibration import _write_cell_family
from tests.test_calibration_power import (
    D_V,
    FIRST_REFIT,
    SHA2,
    TW_SHIFTS,
    _commit_order,
    _curve,
    _inputs,
    _noise_eval,
    _null_sim,
    _positive,
    _power_doc,
    _prov,
    pos_env,  # noqa: F401  (module fixture reused)
)

# ---------------------------------------------------------------------------
# Finding 1: a* is the smallest registered grid amplitude, the next lower one evaluated and failed
# ---------------------------------------------------------------------------


def test_choose_a_star_needs_the_next_lower_grid_amplitude():
    grid = [0.01, 0.02, 0.04]
    # Only 0.02 and 0.04 were evaluated and 0.02 qualifies: 0.01 was never simulated, so it is needed first.
    res = cal.choose_a_star(_curve({0.02: 0.9, 0.04: 0.95}), grid=grid)
    assert res == {"needs": 0.01}
    # 0.01 evaluated and failed: 0.02 is a*.
    res = cal.choose_a_star(_curve({0.01: 0.5, 0.02: 0.9, 0.04: 0.95}), grid=grid)
    assert res["a_star"] == 0.02 and res["infeasible"] is False
    # The grid minimum needs no lower neighbour.
    res = cal.choose_a_star(_curve({0.01: 0.9, 0.04: 0.95}), grid=grid)
    assert res["a_star"] == 0.01
    # A lower amplitude that was evaluated and also qualifies is the smallest.
    res = cal.choose_a_star(_curve({0.01: 0.85, 0.02: 0.9}), grid=grid)
    assert res["a_star"] == 0.01
    # The middle of a sparse walk: 0.02 failed, 0.04 qualifies, nothing in between on this grid.
    res = cal.choose_a_star(_curve({0.02: 0.3, 0.04: 0.9}), grid=grid)
    assert res["a_star"] == 0.04


def test_power_meta_stores_the_registered_grid(tmp_path, monkeypatch):
    monkeypatch.setattr(cal, "_simulate_amplitude", lambda *a, **k: None)
    cal.power_simulation(
        {"cov": np.eye(2).tolist(), "symbols": ["A", "B"]},
        tmp_path / "p",
        [0.04, 0.01, 0.02],
        n_replicates=2,
        commit=SHA2,
        start_ms=DEV_END - 86_400_000 * 10,
        end_ms=DEV_END,
        first_refit_ms=DEV_END - 86_400_000 * 5,
    )
    meta = json.loads((tmp_path / "p" / "power_meta.json").read_text(encoding="utf-8"))
    assert meta["grid"] == [0.01, 0.02, 0.04]


def test_select_a_star_simulates_the_needed_amplitude(tmp_path, monkeypatch):
    pdir = tmp_path / "power"
    pdir.mkdir()
    (pdir / "power_meta.json").write_text(json.dumps({"grid": [0.01, 0.02, 0.04]}), encoding="utf-8")
    simulated = {0.02, 0.04}
    rates = {0.01: 0.4, 0.02: 0.9, 0.04: 0.95}
    ran: list[float] = []

    def fake_curve(power_dir, v, **kw):
        return _curve({a: rates[a] for a in sorted(simulated)})

    def fake_extend(power_dir, a, commit=None):
        ran.append(a)
        simulated.add(a)

    monkeypatch.setattr(cal, "power_curve", fake_curve)
    monkeypatch.setattr(cal, "extend_amplitude", fake_extend)
    res = cal.select_a_star(pdir, 0.0123 * 1.2, commit=SHA2)
    assert ran == [0.01]
    assert res["a_star"] == 0.02 and res["infeasible"] is False
    assert sorted(res["curve"]) == [0.01, 0.02, 0.04]

    # Without a commit the needed simulation cannot run.
    simulated.discard(0.01)
    with pytest.raises(ValueError, match="commit"):
        cal.select_a_star(pdir, 0.0123 * 1.2, commit=None)


def test_calib_positive_reads_v_and_a_star_by_path(tmp_path, monkeypatch):
    noise = tmp_path / "noise_eval.json"
    noise.write_text(json.dumps(_noise_eval()), encoding="utf-8")
    power = tmp_path / "power.json"
    power.write_text(
        json.dumps({"v": D_V, "a_star": {"a_star": 0.04, "infeasible": False, "extensions": []}}), encoding="utf-8"
    )
    seen: dict = {}

    def fake_pc(ds, a_star, noise_runs, out, **kw):
        seen.update(a_star=a_star, **kw)
        return {"detected": True, "detected_by": "pc_P1"}

    monkeypatch.setattr(cal, "positive_control", fake_pc)
    argv = [
        "r4",
        "calib-positive",
        "--ds",
        str(tmp_path),
        "--noise-runs",
        str(tmp_path),
        "--out",
        str(tmp_path / "o"),
        "--commit",
        SHA2,
        "--power",
        str(power),
        "--noise-eval",
        str(noise),
    ]
    monkeypatch.setattr(sys, "argv", argv)
    main()
    assert seen["a_star"] == 0.04
    assert seen["expected_v"] == D_V
    from r4.data import sha256_file

    assert seen["provenance"]["noise_eval"]["sha256"] == sha256_file(noise)
    assert seen["provenance"]["power"]["sha256"] == sha256_file(power)

    # A typed a* is gone, and a power file whose V disagrees with the noise file is refused.
    monkeypatch.setattr(sys, "argv", [*argv, "--a-star", "0.1"])
    with pytest.raises(SystemExit):
        main()
    power.write_text(json.dumps({"v": D_V * 2, "a_star": {"a_star": 0.04, "infeasible": False}}), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", argv)
    with pytest.raises(SystemExit):
        main()


# ---------------------------------------------------------------------------
# Finding 2: the failure tree
# ---------------------------------------------------------------------------


def _pc(pos_env, out, **kw):  # noqa: F811
    return cal.positive_control(
        pos_env["ds"],
        0.0,
        pos_env["noise"],
        out,
        commit=SHA2,
        first_refit_ms=FIRST_REFIT,
        tripwire_shifts=TW_SHIFTS,
        panel=pos_env["panel"],
        **kw,
    )


def test_failure_tree_rerun_is_one_audited_fresh_seed_run(pos_env, tmp_path):  # noqa: F811
    out = tmp_path / "tree"
    first = _pc(pos_env, out)
    assert first["detected"] is False and first["plant"]["seed"] == 20261028
    assert (out / "positive_miss.json").exists()

    # A re-run without the code audit, or an audited run at the same seed, is refused.
    with pytest.raises(ValueError, match="audit"):
        _pc(pos_env, out, rerun=True)
    with pytest.raises(ValueError, match="rerun"):
        _pc(pos_env, out, audited=True)
    assert not (out / "attempt_1").exists()

    # The legal path: audited and at the fresh seed.
    second = _pc(pos_env, out, rerun=True, audited=True)
    assert second["rerun"] is True and second["plant"]["seed"] == 20261029
    assert (out / "attempt_1").is_dir()
    assert second["detected"] is False  # a* 0 plants nothing: a second miss

    # A second miss is terminal: no flag combination runs again.
    for kw in ({}, {"audited": True}, {"rerun": True}, {"rerun": True, "audited": True}):
        with pytest.raises(ValueError, match="second miss is terminal"):
            _pc(pos_env, out, **kw)
    assert not (out / "attempt_2").exists()


def test_rerun_without_a_miss_is_refused(pos_env, tmp_path):  # noqa: F811
    with pytest.raises(ValueError, match="miss"):
        _pc(pos_env, tmp_path / "fresh", rerun=True, audited=True)


def test_expected_v_mismatch_is_refused(pos_env, tmp_path):  # noqa: F811
    with pytest.raises(ValueError, match="variance"):
        _pc(pos_env, tmp_path / "v", expected_v=123.0)


# ---------------------------------------------------------------------------
# Findings 1 and 12: the dossier cross-checks
# ---------------------------------------------------------------------------


def _dossier(tmp: Path, name: str, **over):
    sub = tmp / name
    sub.mkdir()
    return cal.write_dossier(sub / "d.json", **_inputs(sub, **over))


def test_dossier_good_baseline_passes(tmp_path):
    doc = _dossier(tmp_path, "good")
    assert doc["gate_p_ready"] is True
    # A re-run positive control at the re-run seed is legal.
    ok = _dossier(
        tmp_path,
        "rerun",
        positive_control=_positive(rerun=True, plant={"seed": 20261029, "amplitude": 0.04}),
    )
    assert ok["gate_p_ready"] is True


def _drop(d: dict, *path: str) -> dict:
    d = copy.deepcopy(d)
    cur = d
    for k in path[:-1]:
        cur = cur[k]
    del cur[path[-1]]
    return d


def _power(**over) -> dict:
    return _power_doc(**over)


def _case_map() -> dict[str, dict]:
    ne = _noise_eval()
    reg = ne["noise_set"]
    swapped = copy.deepcopy(ne)
    swapped["noise_set"][0]["config_hash"] = "0" * 64
    short = copy.deepcopy(ne)
    short["noise_set"] = reg[:39]
    renamed = copy.deepcopy(ne)
    renamed["noise_set"][3]["id"] = "noise_xx"
    both = copy.deepcopy(ne)
    both["noise_set"].append({**reg[0], "id": reg[0]["id"] + "_alt1", "replaces": reg[0]["id"], "attempt": 1})
    other_commit = copy.deepcopy(ne)
    other_commit["provenance"] = {"commits": ["d" * 40], "source_sha256": [ne["provenance"]["source_sha256"][0]]}
    two_commits = copy.deepcopy(ne)
    two_commits["provenance"]["commits"] = [SHA2, "d" * 40]
    no_prov = _drop(ne, "provenance")
    other_src = copy.deepcopy(ne)
    other_src["provenance"] = {"commits": ne["provenance"]["commits"], "source_sha256": ["e" * 64]}
    ns = _null_sim()
    return {
        "positive a_star differs from power a_star": {"positive_control": _positive(a_star=0.02)},
        "power v differs from noise V": {"power": _power(v=D_V * 1.5)},
        "positive V differs from noise V": {"positive_control": _positive(variance={"mode": "within_cell", "V": 0.5})},
        "positive n_trials not 120": {"positive_control": _positive(n_trials=40)},
        "positive plant seed wrong": {"positive_control": _positive(plant={"seed": 7, "amplitude": 0.04})},
        "rerun seed without rerun flag": {
            "positive_control": _positive(plant={"seed": 20261029, "amplitude": 0.04}, rerun=False)
        },
        "first seed with rerun flag": {"positive_control": _positive(rerun=True)},
        "positive commit differs": {"positive_control": _positive(provenance={**_prov(), "commits": ["d" * 40]})},
        "positive source differs": {"positive_control": _positive(provenance={**_prov(), "source_sha256": ["e" * 64]})},
        "positive without provenance": {"positive_control": _drop(_positive(), "provenance")},
        "power commit differs": {"power": _power(provenance={**_prov(), "commits": ["d" * 40]})},
        "power without provenance": {"power": _drop(_power(), "provenance")},
        "noise commit differs": {"noise_eval": other_commit},
        "noise two commits": {"noise_eval": two_commits},
        "noise source differs": {"noise_eval": other_src},
        "noise without provenance": {"noise_eval": no_prov},
        "retest commit differs": {"retests_commit": "d" * 40},
        "exit block commit differs": {"exit_block": {**_exit(), "provenance": {**_prov(), "commits": ["d" * 40]}}},
        "noise hash not registered": {"noise_eval": swapped},
        "noise set short": {"noise_eval": short},
        "noise id unregistered": {"noise_eval": renamed},
        "noise original and replacement both present": {"noise_eval": both},
        "null paths": {"null_simulation": _null_sim(n=40_000)},
        "null days": {"null_simulation": {**ns, "parameters": {**ns["parameters"], "n_days": 365}}},
        "null threshold": {"null_simulation": {**ns, "parameters": {**ns["parameters"], "threshold": 400.0}}},
        "null seed": {"null_simulation": {**ns, "seed": 1}},
        "null pilot seed": {"null_simulation": {**ns, "pilot": {**ns["pilot"], "seed": 2}}},
        "null pilot missing": {"null_simulation": _drop(ns, "pilot")},
    }


def _exit() -> dict:
    from tests.test_calibration_power import _exit_block

    return _exit_block()


@pytest.mark.parametrize("label", sorted(_case_map()))
def test_dossier_refuses_each_cross_check(tmp_path, label):
    over = dict(_case_map()[label])
    retests_commit = over.pop("retests_commit", None)
    sub = tmp_path / "case"
    sub.mkdir()
    ins = _inputs(sub, **over)
    if retests_commit is not None:
        first = Path(ins["retests"][0])
        obj = json.loads(first.read_text(encoding="utf-8"))
        obj["commit"] = retests_commit
        first.write_text(json.dumps(obj), encoding="utf-8")
    with pytest.raises(ValueError):
        cal.write_dossier(sub / "x.json", **ins)
    assert not (sub / "x.json").exists()


def test_dossier_registered_trade_floor_replacement_is_accepted(tmp_path):
    ne = _noise_eval()
    assert sum(r["replaces"] is not None for r in ne["noise_set"]) == 4
    doc = _dossier(tmp_path, "alt", noise_eval=ne, commit_order=_commit_order([r["id"] for r in ne["noise_set"]]))
    assert doc["gate_p_ready"] is True


def test_dossier_unregistered_trade_floor_replacement_is_refused(tmp_path):
    ne = _noise_eval()
    orig = cal.noise_grid()[5]
    alt = cal.noise_alternative(orig, 1)
    from r4.cli import config_hash_of

    ne["noise_set"][5] = {"id": alt["id"], "config_hash": config_hash_of(alt), "replaces": orig["id"], "attempt": 1}
    with pytest.raises(ValueError, match=orig["id"]):
        _dossier(tmp_path, "alt", noise_eval=ne, commit_order=_commit_order([r["id"] for r in ne["noise_set"]]))


# ---------------------------------------------------------------------------
# Finding 13: the cost-free diagnostic uses the within-cell V of the cost-free Sharpes
# ---------------------------------------------------------------------------


def test_cost_free_items_use_the_cost_free_within_cell_v(tmp_path):
    runs_dir, _ds = _write_cell_family(tmp_path)
    runs = {}
    for d in sorted(Path(runs_dir).iterdir()):
        receipt = json.loads((d / "receipt.json").read_text(encoding="utf-8"))
        daily = pd.read_parquet(d / "daily.parquet")
        daily.attrs["config_hash"] = receipt["config_hash"]
        receipt["metrics"]["cpcv_path_gross_means"] = [0.001] * 5
        runs[d.name] = {"receipt": receipt, "daily": daily}
    cf = {}
    for rid, run in runs.items():
        daily = run["daily"]
        frame = pd.DataFrame({"drift_free": (daily["gross_hedged"] + daily["funding"]).to_numpy()}, index=daily.index)
        frame.attrs["config_hash"] = daily.attrs["config_hash"]
        cf[rid] = frame
    configs = {rid: runs[rid]["receipt"]["config"] for rid in runs}
    expected = trial_sharpe_variance(cf, configs, "within_cell")["V"]
    net = trial_sharpe_variance({r: runs[r]["daily"] for r in runs}, configs, "within_cell")["V"]
    out = cal._cost_free_diagnostics(runs, None)
    assert out["variance"] == {"mode": "within_cell_cost_free", "V": pytest.approx(expected)}
    for rid in runs:
        assert out["configs"][rid]["item3"]["var_trial_sharpes"] == pytest.approx(expected)
    # The fixture is built so the cost-free V differs from the net V: the test can tell the two apart.
    assert expected != pytest.approx(net, rel=0.05)


def test_null_simulation_output_carries_the_pilot(tmp_path):
    from r4.calibration_null import main as null_main

    cov = (0.001 * np.eye(3)).tolist()
    inp = tmp_path / "in.json"
    pilot = {"paths": 10, "seed": 20261024, "n_days": 30, "sd": 0.01, "multiplier": 4.0}
    inp.write_text(json.dumps({"covariance": cov, "betas": [1, 1, 1], "scale": 0.04, "pilot": pilot}), encoding="utf-8")
    out = tmp_path / "out.json"
    assert null_main(["--input", str(inp), "--paths", "20", "--days", "30", "--out", str(out)]) == 0
    res = json.loads(out.read_text(encoding="utf-8"))
    assert res["pilot"]["seed"] == 20261024 and res["seed"] == 20261025
