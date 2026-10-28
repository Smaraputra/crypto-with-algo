"""Brief 28b: power simulation, positive control, Phase 4 dossier (synthetic, small panels, reduced draws)."""

from __future__ import annotations

import copy
import json
import sys
import time
from pathlib import Path

import numpy as np
import pytest

import r4.cli
from r4 import calibration as cal
from r4.bar import trial_sharpe_variance
from r4.cli import main
from r4.method import DEV_END, UNIVERSE
from r4.synth import synth_panel, write_synthetic_dataset
from r4.tripwire import SHIFT_DAYS
from tests.test_calibration import _write_cell_family
from tests.test_cli_bar import COMMIT

DAY = 86_400_000
N_DAYS = 220
START = DEV_END - N_DAYS * DAY
FIRST_REFIT = START + 100 * DAY
SYMS = list(UNIVERSE)
_SD = 0.03
COV10 = (_SD**2 * (0.4 * np.eye(10) + 0.6 * np.ones((10, 10)))).tolist()
DCOV = {"cov": COV10, "betas": [1.0] * 10, "symbols": SYMS}
SMALL = {"start_ms": START, "end_ms": DEV_END, "first_refit_ms": FIRST_REFIT}
TW_SHIFTS = tuple(SHIFT_DAYS[:1])
A_LO, A_HI = 0.0003, 0.03
V_SMALL = 0.002


@pytest.fixture(scope="module")
def power_sim(tmp_path_factory):
    root = tmp_path_factory.mktemp("power")
    t0 = time.perf_counter()
    out = cal.power_simulation(DCOV, root / "power", [A_LO, A_HI], n_replicates=3, commit=COMMIT, **SMALL)
    out["wall_s"] = time.perf_counter() - t0
    return {"root": root, "dir": root / "power", "out": out}


# ---------------------------------------------------------------------------
# Power simulation
# ---------------------------------------------------------------------------


def test_power_simulation_small(power_sim):
    out, pdir = power_sim["out"], power_sim["dir"]
    # Adaptive order: the middle first, then the nearest neighbours; recorded.
    assert out["order"] == [A_HI, A_LO] or out["order"] == [A_LO, A_HI]
    assert sorted(out["evaluated"]) == [A_LO, A_HI]
    assert out["panel_seeds"] == [4000, 4001, 4002]
    for a in (A_LO, A_HI):
        for r in range(3):
            run_dir = pdir / f"a{a!r}" / f"r{r}"
            ids = sorted(p.name for p in run_dir.iterdir() if p.is_dir())
            assert ids == ["pc_D1", "pc_D2", "pc_D3", "pc_D4", "pc_P1"]  # P2 is omitted (disclosed)
            for rid in ids:
                assert (run_dir / rid / "daily.parquet").exists()
                rc = json.loads((run_dir / rid / "receipt.json").read_text(encoding="utf-8"))
                assert rc["kind"] == "control"
                assert rc["config"]["plant"] == {"seed": 30_000 + r, "amplitude": a}
                assert rc["config"]["first_refit_ms"] == FIRST_REFIT
    # The temporary synthetic datasets are deleted after each replicate.
    assert not any(p.name == "manifest.json" for p in pdir.rglob("manifest.json"))
    meta = json.loads((pdir / "power_meta.json").read_text(encoding="utf-8"))
    assert meta["panel_seed_base"] == 4000 and meta["plant_seed_base"] == 30_000 and meta["n_replicates"] == 3
    # Rates are monotone in the amplitude: nothing at the tiny plant, everything at the large one.
    curve = cal.power_curve(pdir, V_SMALL, joint_draws=50)
    assert curve[A_LO]["rate"] <= curve[A_HI]["rate"]
    assert curve[A_HI]["rate"] == 1.0 and curve[A_HI]["detected"] == 3 and curve[A_HI]["n"] == 3
    assert curve[A_LO]["rate"] == 0.0
    lo, hi = curve[A_HI]["wilson95"]
    assert 0.0 <= lo <= hi <= 1.0
    print(f"\nsmall power simulation: {out['wall_s']:.1f} s")


def test_power_curve_recomputes_at_given_v(power_sim, monkeypatch):
    pdir = power_sim["dir"]

    def boom(*a, **k):
        raise AssertionError("power_curve must not run a walk-forward")

    monkeypatch.setattr(r4.cli, "run_wf", boom)
    small_v = cal.power_curve(pdir, V_SMALL, joint_draws=50)
    big_v = cal.power_curve(pdir, 50.0, joint_draws=50)
    assert small_v[A_HI]["detected"] == 3
    assert big_v[A_HI]["detected"] == 0  # the same series, a variance so large the DSR benchmark is out of reach
    assert big_v[A_HI]["rate"] == 0.0
    # The margin helper multiplies V by 1.2 and nothing else.
    seen = []
    real = cal.power_curve

    def spy(power_dir, v, **k):
        seen.append(v)
        return real(power_dir, v, **k)

    monkeypatch.setattr(cal, "power_curve", spy)
    cal.power_curve_at_margin(pdir, V_SMALL, joint_draws=20)
    assert seen == [pytest.approx(V_SMALL * 1.2)]


def test_adaptive_order_and_stop(tmp_path, monkeypatch):
    assert cal.adaptive_order([1, 2, 3, 4, 5]) == [3, 4, 2, 5, 1]
    assert cal.adaptive_order([1, 2]) == [2, 1]
    assert cal.adaptive_order([7]) == [7]
    assert cal.adaptive_order([]) == []

    # With a stop variance the walk goes down from the middle while the rate is >= 0.8, up otherwise, one neighbour
    # at a time, and stops at the first change of side.
    rates = {1.0: 0.0, 2.0: 0.0, 3.0: 0.9, 4.0: 0.95, 5.0: 1.0}
    ran = []

    def fake_one(power_dir, a, **kw):
        ran.append(a)

    monkeypatch.setattr(cal, "_simulate_amplitude", fake_one)
    monkeypatch.setattr(cal, "_amplitude_rate", lambda power_dir, a, v, n_trials, joint_draws, **kw: rates[a])
    out = cal.power_simulation(
        DCOV, tmp_path / "p", [1.0, 2.0, 3.0, 4.0, 5.0], n_replicates=2, commit=COMMIT, stop_v=0.01, **SMALL
    )
    assert ran == [3.0, 2.0]  # 3 qualifies, 2 does not: a* lies between, nothing else is needed
    assert out["order"][:2] == [3.0, 2.0]
    ran.clear()
    rates.update({3.0: 0.1, 4.0: 0.5, 5.0: 0.85})
    cal.power_simulation(
        DCOV, tmp_path / "p2", [1.0, 2.0, 3.0, 4.0, 5.0], n_replicates=2, commit=COMMIT, stop_v=0.01, **SMALL
    )
    assert ran == [3.0, 4.0, 5.0]


# ---------------------------------------------------------------------------
# a*
# ---------------------------------------------------------------------------


def _curve(rates: dict[float, float], n: int = 40) -> dict[float, dict]:
    return {a: {"detected": round(r * n), "n": n, "rate": r, "wilson95": [0.0, 1.0]} for a, r in rates.items()}


def test_choose_a_star_margin_and_extension():
    # The smallest amplitude at a rate of at least 0.8 (0.8 itself qualifies), not the first in a monotone sense.
    res = cal.choose_a_star(_curve({0.01: 0.1, 0.02: 0.8, 0.04: 0.95, 0.03: 0.3}))
    assert res["infeasible"] is False and res["a_star"] == 0.02 and res["extensions"] == []
    assert cal.choose_a_star(_curve({0.01: 0.79, 0.02: 0.5}), extend=None)["infeasible"] is True

    # No grid amplitude qualifies: extend upward by doubling the largest, at most 3 times, same replicate seeds.
    calls: list[float] = []

    def extend(a: float) -> dict:
        calls.append(a)
        return {"detected": 36 if a >= 0.16 else 4, "n": 40, "rate": 0.9 if a >= 0.16 else 0.1, "wilson95": [0.0, 1.0]}

    res = cal.choose_a_star(_curve({0.02: 0.1, 0.04: 0.5}), extend=extend)
    assert calls == [0.08, 0.16]
    assert res["a_star"] == 0.16 and res["infeasible"] is False and res["extensions"] == [0.08, 0.16]
    assert 0.16 in res["curve"] and 0.08 in res["curve"]

    # Infeasible: three doublings, none reaches 0.8.
    calls.clear()

    def never(a: float) -> dict:
        calls.append(a)
        return {"detected": 1, "n": 40, "rate": 0.025, "wilson95": [0.0, 0.1]}

    res = cal.choose_a_star(_curve({0.02: 0.1, 0.04: 0.5}), extend=never)
    assert calls == [0.08, 0.16, 0.32]
    assert res["infeasible"] is True and res["a_star"] is None
    with pytest.raises(ValueError):
        cal.choose_a_star({})


# ---------------------------------------------------------------------------
# Positive control
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def pos_env(tmp_path_factory):
    root = tmp_path_factory.mktemp("pos")
    panel = synth_panel(COV10, SYMS, START, DEV_END, seed=77)
    ds = write_synthetic_dataset(panel, root / "ds")
    (root / "noise").mkdir()
    noise_runs, _ = _write_cell_family(root / "noise")
    return {"root": root, "panel": panel, "ds": ds, "noise": noise_runs}


def test_positive_control_small_detects_large_plant(pos_env, tmp_path):
    out = tmp_path / "pos"
    rep = cal.positive_control(
        pos_env["ds"],
        A_HI,
        pos_env["noise"],
        out,
        commit=COMMIT,
        first_refit_ms=FIRST_REFIT,
        tripwire_shifts=TW_SHIFTS,
        panel=pos_env["panel"],
    )
    runs = out / "runs"
    assert sorted(p.name for p in runs.iterdir()) == ["pc_D1", "pc_D2", "pc_D3", "pc_D4", "pc_P1", "pc_P2"]
    for p in runs.iterdir():
        assert json.loads((p / "receipt.json").read_text(encoding="utf-8"))["kind"] == "control"
    assert rep["a_star"] == A_HI and rep["n_trials"] == 120
    # V is the within-cell V of the noise controls, not of the pc family.
    noise_v = rep["variance"]["V"]
    assert rep["variance"]["mode"] == "within_cell"
    assert rep["report"]["variance"]["V"] == noise_v
    assert rep["report"]["calibration"] is True
    # The tripwire runs only for P1 and P2 and only when they pass items 1 to 3.
    for rid, ev in rep["report"]["configurations"].items():
        p123 = ev["item1"]["pass"] and ev["item2"]["pass"] and ev["item3"]["pass"]
        has_tw = rid in rep["tripwires"]
        assert has_tw == (rid in ("pc_P1", "pc_P2") and p123), rid
    assert rep["detected"] is True
    assert rep["detected_by"] in ("pc_P1", "pc_P2")
    assert not (out / "positive_miss.json").exists()
    json.dumps(rep)
    assert trial_sharpe_variance  # keep the import used


def test_positive_miss_writes_failure_record_and_blocks_rerun(pos_env, tmp_path):
    out = tmp_path / "miss"
    rep = cal.positive_control(
        pos_env["ds"],
        0.0,
        pos_env["noise"],
        out,
        commit=COMMIT,
        first_refit_ms=FIRST_REFIT,
        tripwire_shifts=TW_SHIFTS,
        panel=pos_env["panel"],
    )
    assert rep["detected"] is False
    miss = json.loads((out / "positive_miss.json").read_text(encoding="utf-8"))
    assert miss["a_star"] == 0.0 and "audit" in miss["next_step"]
    with pytest.raises(ValueError, match="audit"):
        cal.positive_control(
            pos_env["ds"],
            0.0,
            pos_env["noise"],
            out,
            commit=COMMIT,
            first_refit_ms=FIRST_REFIT,
            tripwire_shifts=TW_SHIFTS,
            panel=pos_env["panel"],
        )


def test_pc_rerun_configs():
    base = cal.pc_family(0.1)
    re = cal.pc_rerun_family(0.1)
    assert [c["plant"]["seed"] for c in re] == [20261029] * 6
    assert [c.get("noise_seed") for c in re[2:]] == [2_000_011, 2_000_012, 2_000_013, 2_000_014]
    assert [c["id"] for c in re] == [c["id"] for c in base]


# ---------------------------------------------------------------------------
# Dossier
# ---------------------------------------------------------------------------

SHA = "a" * 40
SHA2 = "b" * 40


def _noise_eval() -> dict:
    verdict = {}
    for pid, spec in cal.PREDICTIONS.items():
        if pid.startswith("noise_"):
            verdict[pid] = {
                "status": spec["status"],
                "text": spec["text"],
                "observed": 0,
                "met": None if pid == "noise_joint_shift_reference_panels" else True,
            }
    return {
        "n_configs": 40,
        "gated": {"n_pass_items_1_to_3": 0, "n_reject_joint_shift_05": 2},
        "verdict": verdict,
        "gate_ok": True,
    }


def _null_sim(count: int = 3, n: int = 50_000) -> dict:
    return {
        "crossing_count": count,
        "crossing_rate": count / n,
        "parameters": {"n_paths": n},
        "wilson_95": [0.0, 0.001],
    }


def _exit_block(rejects: tuple[bool, ...] = (False,) * 6) -> dict:
    cfgs = [{"id": f"exit_{i}", "p": 0.01 if r else 0.5, "rejected": r} for i, r in enumerate(rejects)]
    return {"configs": cfgs, "n_rejected": int(sum(rejects))}


RULES = ("rv-v1", "lab-v4-s1", "lab-v4-s2", "v8-1h", "v8-4h", "c1")


def _retest(rule: str, passed: bool = False) -> dict:
    return {"kind": "retest", "rule": rule, "pass": passed}


def _commit_order() -> dict:
    return {
        "predictions": {
            pid: {
                "registration_commit": SHA,
                "receipts": [{"id": f"r_{pid}", "commit": SHA2, "is_ancestor": True}],
            }
            for pid in cal.PREDICTIONS
        }
    }


def _put(tmp: Path, name: str, obj) -> Path:
    p = tmp / f"{name}.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    return p


def _inputs(tmp: Path, **over) -> dict:
    curve = _curve({0.02: 0.5, 0.04: 0.9})
    d = {
        "null_simulation": _null_sim(),
        "noise_eval": _noise_eval(),
        "power": {
            "curve_at_1_2v": {str(a): v for a, v in curve.items()},
            "a_star": {"a_star": 0.04, "infeasible": False},
        },
        "positive_control": {"detected": True, "a_star": 0.04},
        "family_spa": {"spa_p": 0.5, "n_rules": 6},
        "exit_block": _exit_block(),
        "retests": [_retest(r) for r in RULES],
        "commit_order": _commit_order(),
    }
    d.update(over)
    kw = {}
    for k, v in d.items():
        if k == "retests":
            kw["retests"] = [_put(tmp, f"retest_{i}", r) for i, r in enumerate(v)]
        elif k == "commit_order":
            kw["commit_order"] = v
        elif v is None:
            kw[k] = None
        else:
            kw[k] = _put(tmp, k, v)
    return kw


def test_dossier_refuses_overwrite_and_bad_counters(tmp_path):
    out = tmp_path / "d" / "dossier.json"
    doc = cal.write_dossier(out, **_inputs(tmp_path))
    assert out.exists() and json.loads(out.read_text(encoding="utf-8"))["gate_p_ready"] is doc["gate_p_ready"]
    # Every input is referenced by path plus sha256.
    for name in ("null_simulation", "noise_eval", "power", "positive_control", "family_spa", "exit_block"):
        ref = doc["inputs"][name]
        assert ref["sha256"] == __import__("hashlib").sha256(Path(ref["path"]).read_bytes()).hexdigest()
    assert len(doc["inputs"]["retests"]) == 6
    with pytest.raises(FileExistsError):
        cal.write_dossier(out, **_inputs(tmp_path))

    bad_cases = {
        "negative count": {"null_simulation": _null_sim(-1)},
        "bool count": {"null_simulation": {**_null_sim(), "crossing_count": True}},
        "count above paths": {"null_simulation": {**_null_sim(), "crossing_count": 60_000}},
        "float count": {"null_simulation": {**_null_sim(), "crossing_count": 2.5}},
        "rate above 1": {"null_simulation": {**_null_sim(), "crossing_rate": 1.5}},
        "noise count": {
            "noise_eval": {**_noise_eval(), "gated": {"n_pass_items_1_to_3": -1, "n_reject_joint_shift_05": 0}}
        },
        "noise count above n": {
            "noise_eval": {**_noise_eval(), "gated": {"n_pass_items_1_to_3": 41, "n_reject_joint_shift_05": 0}}
        },
        "power rate": {
            "power": {
                "curve_at_1_2v": {"0.04": {"detected": 4, "n": 4, "rate": 2.0, "wilson95": [0.0, 1.0]}},
                "a_star": {"a_star": 0.04, "infeasible": False},
            }
        },
        "power detected above n": {
            "power": {
                "curve_at_1_2v": {"0.04": {"detected": 5, "n": 4, "rate": 1.0, "wilson95": [0.0, 1.0]}},
                "a_star": {"a_star": 0.04, "infeasible": False},
            }
        },
        "retest count": {"retests": [_retest(r) for r in RULES[:5]]},
        "retest duplicate": {"retests": [_retest(r) for r in (*RULES[:5], RULES[0])]},
    }
    for label, over in bad_cases.items():
        sub = tmp_path / label.replace(" ", "_")
        sub.mkdir()
        with pytest.raises(ValueError):
            cal.write_dossier(sub / "x.json", **_inputs(sub, **over))
        assert not (sub / "x.json").exists(), label


def test_exit_block_shape_validation(tmp_path):
    ok = tmp_path / "ok"
    ok.mkdir()
    doc = cal.write_dossier(
        ok / "d.json", **_inputs(ok, exit_block=_exit_block((True, False, False, False, False, False)))
    )
    assert doc["predictions"]["exit_block_at_most_1_of_6_rejects"]["observed"] == 1
    assert doc["predictions"]["exit_block_at_most_1_of_6_rejects"]["as_predicted"] is True
    two = tmp_path / "two"
    two.mkdir()
    doc = cal.write_dossier(
        two / "d.json", **_inputs(two, exit_block=_exit_block((True, True, False, False, False, False)))
    )
    assert doc["predictions"]["exit_block_at_most_1_of_6_rejects"]["as_predicted"] is False
    assert doc["gate_p_ready"] is False

    good = _exit_block()
    shapes = {
        "not a dict": [1, 2],
        "no configs": {"n_rejected": 0},
        "five configs": {**good, "configs": good["configs"][:5]},
        "p out of range": {**good, "configs": [{**good["configs"][0], "p": 1.2}, *good["configs"][1:]]},
        "rejected not bool": {**good, "configs": [{**good["configs"][0], "rejected": 1}, *good["configs"][1:]]},
        "rejected disagrees with p": {
            **good,
            "configs": [{**good["configs"][0], "rejected": True}, *good["configs"][1:]],
        },
        "count mismatch": {**good, "n_rejected": 3},
        "negative count": {**good, "n_rejected": -1},
        "missing id": {**good, "configs": [{"p": 0.5, "rejected": False}, *good["configs"][1:]]},
    }
    for label, shape in shapes.items():
        sub = tmp_path / label.replace(" ", "_")
        sub.mkdir()
        with pytest.raises(ValueError):
            cal.write_dossier(sub / "x.json", **_inputs(sub, exit_block=shape))


def test_dossier_commit_order_validation(tmp_path):
    def attempt(name: str, order: dict):
        sub = tmp_path / name
        sub.mkdir()
        return cal.write_dossier(sub / "d.json", **_inputs(sub, commit_order=order))

    good = _commit_order()
    assert attempt("good", good)["commit_order"]["predictions"]["natives_all_six_fail"]["registration_commit"] == SHA

    def mutate(fn):
        o = copy.deepcopy(good)
        fn(o)
        return o

    first = next(iter(cal.PREDICTIONS))
    cases = {
        "not ancestor": mutate(lambda o: o["predictions"][first]["receipts"][0].update(is_ancestor=False)),
        "ancestor not bool": mutate(lambda o: o["predictions"][first]["receipts"][0].update(is_ancestor="yes")),
        "bad registration sha": mutate(lambda o: o["predictions"][first].update(registration_commit="unknown")),
        "bad receipt sha": mutate(lambda o: o["predictions"][first]["receipts"][0].update(commit="zz")),
        "missing prediction": mutate(lambda o: o["predictions"].pop(first)),
        "no receipts": mutate(lambda o: o["predictions"][first].update(receipts=[])),
        "unknown prediction": mutate(lambda o: o["predictions"].update(bogus=o["predictions"][first])),
        "no predictions key": {},
    }
    for name, order in cases.items():
        with pytest.raises(ValueError):
            attempt(name.replace(" ", "_"), order)


def test_dossier_gate_ready_logic(tmp_path):
    def run(name: str, **over):
        sub = tmp_path / name
        sub.mkdir()
        return cal.write_dossier(sub / "d.json", **_inputs(sub, **over))

    base = run("base")
    preds = base["predictions"]
    assert set(preds) == set(cal.PREDICTIONS)
    assert all(p["gated"] == (cal.PREDICTIONS[k]["status"] == "gated") for k, p in preds.items())
    assert preds["natives_all_six_fail"]["as_predicted"] is True
    assert preds["daily_null_crossing_rate_at_most_1_over_600"]["as_predicted"] is True  # 3 / 50,000 = 6e-5
    # Diagnostics not evaluated here stay None and never block the gate.
    assert preds["exit_median_hold_at_least_80pct"]["as_predicted"] is None
    assert preds["noise_joint_shift_reference_panels"]["as_predicted"] is None
    assert base["gate_p_ready"] is True

    # A diagnostic miss does not flip it.
    ne = _noise_eval()
    ne["verdict"]["noise_family_pbo_net_below_0_1"]["met"] = False
    ne["verdict"]["noise_cost_free_items123_0_to_2"]["met"] = False
    d = run("diag", noise_eval=ne, null_simulation=_null_sim(count=11))
    assert d["predictions"]["noise_family_pbo_net_below_0_1"]["as_predicted"] is False
    assert d["predictions"]["daily_null_at_most_10_crossings"]["as_predicted"] is False
    assert d["gate_p_ready"] is True

    # Each gated miss flips it.
    ne = _noise_eval()
    ne["verdict"]["noise_items123_zero_of_40"]["met"] = False
    assert run("g1", noise_eval=ne)["gate_p_ready"] is False
    assert run("g2", positive_control={"detected": False, "a_star": 0.04})["gate_p_ready"] is False
    assert (
        run("g3", retests=[*[_retest(r) for r in RULES[:5]], _retest(RULES[5], passed=True)])["gate_p_ready"] is False
    )
    assert run("g4", null_simulation=_null_sim(count=100))["gate_p_ready"] is False  # 100 / 50,000 > 1/600
    # An exit block that was not run is not "as predicted".
    nb = run("g5", exit_block=None)
    assert nb["predictions"]["exit_block_at_most_1_of_6_rejects"]["as_predicted"] is None
    assert nb["gate_p_ready"] is False
    # An infeasible power grid leaves the positive prediction unmet.
    inf = run(
        "g6",
        power={"curve_at_1_2v": {"0.04": _curve({0.04: 0.1})[0.04]}, "a_star": {"a_star": None, "infeasible": True}},
        positive_control={"detected": None, "a_star": None},
    )
    assert inf["predictions"]["positive_detected_at_astar"]["as_predicted"] is False
    assert inf["gate_p_ready"] is False


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_cli_power_curve_and_dossier(power_sim, tmp_path, monkeypatch):
    def run(*argv: str) -> None:
        monkeypatch.setattr(sys, "argv", ["r4", *argv])
        main()

    run(
        "calib-power-curve",
        "--power-dir",
        str(power_sim["dir"]),
        "--v",
        str(V_SMALL / 1.2),
        "--out",
        str(tmp_path / "pc.json"),
        "--draws",
        "20",
    )
    pc = json.loads((tmp_path / "pc.json").read_text(encoding="utf-8"))
    assert pc["margin"] == 1.2 and pc["v"] == pytest.approx(V_SMALL / 1.2)
    assert pc["a_star"]["a_star"] == A_HI and pc["a_star"]["infeasible"] is False
    assert str(A_HI) in pc["curve_at_1_2v"] or repr(A_HI) in pc["curve_at_1_2v"]

    ins = _inputs(tmp_path, power=pc)
    argv = [
        "calib-dossier",
        "--out",
        str(tmp_path / "dossier.json"),
        "--commit-order",
        str(_put(tmp_path, "co", _commit_order())),
    ]
    for flag, key in (
        ("--null", "null_simulation"),
        ("--noise", "noise_eval"),
        ("--power", "power"),
        ("--positive", "positive_control"),
        ("--spa", "family_spa"),
        ("--exit-block", "exit_block"),
    ):
        argv += [flag, str(ins[key])]
    argv += ["--retests", *map(str, ins["retests"])]
    run(*argv)
    doc = json.loads((tmp_path / "dossier.json").read_text(encoding="utf-8"))
    assert doc["gate_p_ready"] is True
    assert len(doc["predictions"]) == len(cal.PREDICTIONS)
