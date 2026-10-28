"""Brief 28g: the dossier binds its inputs to one dataset, one code freeze and the registered parameters."""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from r4 import calibration as cal
from tests.test_calibration_power import (
    D_V,
    DS_HASH,
    LOCK_SHA,
    RULES,
    SHA2,
    _commit_order,
    _exit_block,
    _inputs,
    _noise_eval,
    _null_sim,
    _positive,
    _power_doc,
    _retest,
)

OTHER = "f" * 64


def _mut(obj: dict[str, Any], fn: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    out = copy.deepcopy(obj)
    fn(out)
    return out


def _versions_differ(o: dict[str, Any]) -> None:
    o["versions"]["numpy"] = "9.9.9"


def _row(block: dict[str, Any], i: int = 0) -> dict[str, Any]:
    return block["configs"][i]


# -- one refusal per binding -------------------------------------------------------------------------------------


def _cases() -> dict[str, dict[str, Any]]:
    ne, ex, po, pw, ns = _noise_eval(), _exit_block(), _positive(), _power_doc(), _null_sim()
    cases: dict[str, dict[str, Any]] = {
        # C-1, the dataset
        "noise receipts on another dataset": {
            "noise_eval": _mut(ne, lambda o: o["provenance"].__setitem__("dataset_hash", [OTHER]))
        },
        "noise receipts on two datasets": {
            "noise_eval": _mut(ne, lambda o: o["provenance"].__setitem__("dataset_hash", [DS_HASH, OTHER]))
        },
        "noise provenance without a dataset": {"noise_eval": _mut(ne, lambda o: o["provenance"].pop("dataset_hash"))},
        "exit receipts on another dataset": {
            "exit_block": _mut(ex, lambda o: o["provenance"].__setitem__("dataset_hash", [OTHER]))
        },
        "positive control on another dataset": {
            "positive_control": _mut(po, lambda o: o.__setitem__("dataset_hash", OTHER))
        },
        "positive receipts on another dataset": {
            "positive_control": _mut(po, lambda o: o["provenance"].__setitem__("dataset_hash", [OTHER]))
        },
        "positive control without a dataset": {"positive_control": _mut(po, lambda o: o.pop("dataset_hash"))},
        "retest on another dataset": {
            "retests": [
                _mut(_retest(RULES[0]), lambda o: o.__setitem__("dataset_hash", OTHER)),
                *map(_retest, RULES[1:]),
            ]
        },
        "null input on another dataset": {
            "null_simulation": _mut(ns, lambda o: o.__setitem__("dcov_dataset_hash", OTHER))
        },
        "null input without a dataset": {"null_simulation": _mut(ns, lambda o: o.pop("dcov_dataset_hash"))},
        "power covariance from another dataset": {
            "power": _mut(pw, lambda o: o.__setitem__("dcov_dataset_hash", OTHER))
        },
        # C-1, the code
        "null without provenance": {"null_simulation": _mut(ns, lambda o: o.pop("provenance"))},
        "null commit differs": {
            "null_simulation": _mut(ns, lambda o: o["provenance"].__setitem__("commits", ["d" * 40]))
        },
        "null source differs": {
            "null_simulation": _mut(ns, lambda o: o["provenance"].__setitem__("source_sha256", [OTHER]))
        },
        "null without reproduction": {"null_simulation": _mut(ns, lambda o: o.pop("reproduction"))},
        "noise provenance lock differs": {
            "noise_eval": _mut(ne, lambda o: o["provenance"].__setitem__("requirements_lock_sha256", [OTHER]))
        },
        "power provenance versions differ": {
            "power": _mut(
                pw,
                lambda o: o["provenance"].__setitem__("versions", [{**o["provenance"]["versions"][0], "numpy": "9"}]),
            )
        },
        "retest lock differs": {
            "retests": [
                _mut(_retest(RULES[0]), lambda o: o.__setitem__("requirements_lock_sha256", OTHER)),
                *map(_retest, RULES[1:]),
            ]
        },
        "retest versions differ": {"retests": [_mut(_retest(RULES[0]), _versions_differ), *map(_retest, RULES[1:])]},
        "retest without versions": {
            "retests": [_mut(_retest(RULES[0]), lambda o: o.pop("versions")), *map(_retest, RULES[1:])]
        },
        # C-1, the parameters
        "power margin": {"power": _mut(pw, lambda o: o.__setitem__("margin", 1.5))},
        "power margin missing": {"power": _mut(pw, lambda o: o.pop("margin"))},
        "power joint draws": {"power": _mut(pw, lambda o: o.__setitem__("joint_draws", 100))},
        "power trials": {"power": _mut(pw, lambda o: o.__setitem__("n_trials", 100))},
        "power replicates": {
            "power": _mut(pw, lambda o: o["curve_at_1_2v"]["0.04"].update(n=20, detected=18, rate=0.9))
        },
        "power grid missing": {"power": _mut(pw, lambda o: o.pop("grid"))},
        "power grid unsorted": {"power": _mut(pw, lambda o: o.__setitem__("grid", [0.04, 0.02]))},
        "power curve outside the grid": {"power": _mut(pw, lambda o: o.__setitem__("grid", [0.04]))},
        "positive tripwire shifts": {"positive_control": _mut(po, lambda o: o.__setitem__("tripwire_shifts", 50))},
        "positive config hash": {
            "positive_control": _mut(po, lambda o: o["config_hashes"].__setitem__("pc_P1", "0" * 64))
        },
        "positive config hashes missing": {"positive_control": _mut(po, lambda o: o.pop("config_hashes"))},
        "positive first-run hashes with the re-run flag": {
            "positive_control": _mut(
                _positive(rerun=True, plant={"seed": 20261029, "amplitude": 0.04}),
                lambda o: o.__setitem__("config_hashes", _positive()["config_hashes"]),
            )
        },
        "exit span end missing": {"exit_block": _mut(ex, lambda o: o.pop("span_end_ms"))},
        "exit span end differs": {
            "exit_block": _mut(ex, lambda o: o.__setitem__("span_end_ms", cal.DEV_END - 86_400_000))
        },
        "retest calibration V differs": {
            "retests": [_mut(_retest(RULES[0]), lambda o: o.__setitem__("calib_v", D_V * 2)), *map(_retest, RULES[1:])]
        },
        "family spa not a rule count": {"family_spa": {"spa_p": 0.5, "n_rules": 5}},
        "family spa p out of range": {"family_spa": {"spa_p": 3.0, "n_rules": 6}},
        "family spa not an object": {"family_spa": [1]},
        # C-2
        "commit order receipt at another commit": {
            "commit_order": _mut(
                _commit_order(),
                lambda o: o["predictions"]["natives_all_six_fail"]["receipts"][0].__setitem__("commit", "d" * 40),
            )
        },
        "commit order omits an input receipt": {
            "commit_order": _mut(_commit_order(), lambda o: o["predictions"]["natives_all_six_fail"]["receipts"].pop(0))
        },
        "commit order omits a noise control": {
            "commit_order": _mut(
                _commit_order(), lambda o: o["predictions"]["noise_items123_at_most_5"]["receipts"].pop()
            )
        },
        "commit order omits an exit config": {
            "commit_order": _mut(
                _commit_order(), lambda o: o["predictions"]["exit_block_at_most_1_of_6_rejects"]["receipts"].pop()
            )
        },
        # A-13
        "retest with no applied hurdle": {"retests": [_retest(RULES[0], applied=False), *map(_retest, RULES[1:])]},
        "retest pass flag disagrees with its hurdles": {
            "retests": [
                _mut(_retest(RULES[0], passed=False), lambda o: o.__setitem__("pass", True)),
                *map(_retest, RULES[1:]),
            ]
        },
    }
    for name in ("noise_eval", "exit_block", "power", "positive_control"):
        base = {"noise_eval": ne, "exit_block": ex, "power": pw, "positive_control": po}[name]
        cases[f"{name} without reproduction"] = {name: _mut(base, lambda o: o.pop("reproduction"))}
        cases[f"{name} evaluated at other source"] = {
            name: _mut(base, lambda o: o["reproduction"].__setitem__("source_sha256", OTHER))
        }
        cases[f"{name} evaluated at other lock"] = {
            name: _mut(base, lambda o: o["reproduction"].__setitem__("requirements_lock_sha256", OTHER))
        }
        cases[f"{name} evaluated at other versions"] = {name: _mut(base, lambda o: _versions_differ(o["reproduction"]))}
    return cases


_CASES = _cases()


def test_baseline_dossier_is_accepted(tmp_path):
    doc = cal.write_dossier(tmp_path / "d.json", **_inputs(tmp_path))
    assert doc["gate_p_ready"] is True


def test_dossier_accepts_no_family_spa(tmp_path):
    ins = _inputs(tmp_path)
    ins.pop("family_spa")
    doc = cal.write_dossier(tmp_path / "d.json", **ins)
    assert doc["gate_p_ready"] is True
    assert "family_spa" not in doc["inputs"]


@pytest.mark.parametrize("label", sorted(_CASES))
def test_dossier_refuses_each_binding(tmp_path, label):
    sub = tmp_path / "case"
    sub.mkdir()
    with pytest.raises(ValueError):
        cal.write_dossier(sub / "x.json", **_inputs(sub, **copy.deepcopy(_CASES[label])))
    assert not (sub / "x.json").exists()


# -- C-5: the dossier recomputes every verdict flag --------------------------------------------------------------


def _opt(fn: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    return _mut(_exit_block(), lambda b: fn(b["optional_stopping"]))


def _diag(fn: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    return _mut(_exit_block(), lambda b: fn(b["diagnostics"]))


def _set_p(rule: str, p2: float, p_pos: float, ok: bool) -> Callable[[dict[str, Any]], None]:
    def apply(o: dict[str, Any]) -> None:
        o["rules"][rule].update(p_two_sided=p2, p_one_sided_positive=p_pos, ok=ok, significant=p2 < 0.01)

    return apply


_FLAG_CASES: dict[str, dict[str, Any]] = {
    "optional stopping ok true on a significant row": _opt(_set_p("E2", 0.001, 0.0005, True)),
    "optional stopping ok false on a quiet row": _opt(_set_p("E2", 0.5, 0.25, False)),
    "X1 negative bias recorded ok": _opt(_set_p("X1", 0.001, 0.9995, True)),
    "X1 positive bias recorded ok": _opt(_set_p("X1", 0.5, 0.001, True)),
    "optional stopping met true with a missing row": _opt(
        lambda o: (_set_p("E2", 0.001, 0.0005, False)(o), o.__setitem__("met", True))
    ),
    "optional stopping met false with every row ok": _opt(lambda o: o.__setitem__("met", False)),
    "optional stopping alpha": _opt(lambda o: o.__setitem__("alpha", 0.05)),
    "loosened row not informative but met": _opt(
        lambda o: o["rules"]["E4_loose"].update(early_share=0.05, informative=False)
    ),
    "loosened informative flag disagrees with its early share": _opt(
        lambda o: o["rules"]["E5_loose"].update(early_share=0.05, informative=True)
    ),
    "loosened informative flag missing": _opt(lambda o: o["rules"]["E5_loose"].pop("informative")),
    "median hold met true on a short hold": _diag(
        lambda d: d["median_hold"]["rules"]["E5"].__setitem__("median_share", 0.5)
    ),
    "median hold met false on long holds": _diag(lambda d: d["median_hold"].__setitem__("met", False)),
    "median hold rules missing": _diag(lambda d: d["median_hold"].__setitem__("rules", {})),
    "planted rule met true on a low close-ahead": _diag(
        lambda d: d["planted_intrabar"]["rules"]["E6"].__setitem__("close_ahead_rate", 0.5)
    ),
    "planted rule met true on a high false-close": _diag(
        lambda d: d["planted_intrabar"]["rules"]["E5"].__setitem__("false_close_rate", 0.5)
    ),
    "planted rule met true on a negative increment": _diag(
        lambda d: d["planted_intrabar"]["rules"]["E4"].__setitem__("increment", -0.001)
    ),
    "planted block met disagrees with its rules": _diag(
        lambda d: (
            d["planted_intrabar"]["rules"]["E4"].update(close_ahead_rate=0.5, met=False),
            d["planted_intrabar"].__setitem__("met", True),
        )
    ),
}


@pytest.mark.parametrize("label", sorted(_FLAG_CASES))
def test_dossier_recomputes_exit_block_flags(tmp_path, label):
    sub = tmp_path / "case"
    sub.mkdir()
    block = copy.deepcopy(_FLAG_CASES[label])
    with pytest.raises(ValueError):
        cal.write_dossier(sub / "x.json", **_inputs(sub, exit_block=block))
    assert not (sub / "x.json").exists()


def test_dossier_recomputes_consistent_misses(tmp_path):
    """The honest miss is still written: the flags agree with the numbers and the prediction is simply unmet."""
    for name, kw, pid in (
        ("opt", {"opt_miss": ("E4",)}, "exit_optional_stopping_zero_mean"),
        ("hold", {"hold_miss": True}, "exit_median_hold_at_least_80pct"),
        ("planted", {"planted_miss": True}, "exit_planted_intrabar_control"),
    ):
        sub = tmp_path / name
        sub.mkdir()
        doc = cal.write_dossier(sub / "d.json", **_inputs(sub, exit_block=_exit_block(**kw)))
        assert doc["predictions"][pid]["as_predicted"] is False


def test_dossier_x1_negative_bias_is_a_miss(tmp_path):
    sub = tmp_path / "x1"
    sub.mkdir()
    block = _exit_block(opt_miss=("X1",))
    block["optional_stopping"]["rules"]["X1"].update(p_one_sided_positive=0.9995, positive=False)
    doc = cal.write_dossier(sub / "d.json", **_inputs(sub, exit_block=block))
    assert doc["predictions"]["exit_optional_stopping_zero_mean"]["as_predicted"] is False


def _positive_with(fn: Callable[[dict[str, Any]], None], **kw: Any) -> dict[str, Any]:
    return _mut(_positive(**kw), fn)


_POSITIVE_CASES: dict[str, dict[str, Any]] = {
    "detected false while P1 passes everything": _positive_with(lambda o: o.__setitem__("detected", False)),
    "detected true while nothing passed": _positive_with(
        lambda o: o["report"]["configurations"]["pc_P1"].update({"all_pass": False}), detected=True
    ),
    "detected true while the tripwire halts": _positive_with(
        lambda o: o["tripwires"]["pc_P1"].__setitem__("halt", True)
    ),
    "all_pass true with a failed item": _positive_with(
        lambda o: o["report"]["configurations"]["pc_P1"]["item4"].__setitem__("pass", False)
    ),
    "detected true without a tripwire record": _positive_with(lambda o: o.__setitem__("tripwires", {})),
    "detected_by disagrees": _positive_with(lambda o: o.__setitem__("detected_by", "pc_P2")),
}


@pytest.mark.parametrize("label", sorted(_POSITIVE_CASES))
def test_dossier_recomputes_positive_detection(tmp_path, label):
    sub = tmp_path / "case"
    sub.mkdir()
    with pytest.raises(ValueError):
        cal.write_dossier(sub / "x.json", **_inputs(sub, positive_control=copy.deepcopy(_POSITIVE_CASES[label])))


def test_dossier_accepts_a_consistent_positive_miss(tmp_path):
    sub = tmp_path / "miss"
    sub.mkdir()
    doc = cal.write_dossier(sub / "d.json", **_inputs(sub, positive_control=_positive(detected=False)))
    assert doc["predictions"]["positive_detected_at_astar"]["as_predicted"] is False


# -- C-2 and the id mapping --------------------------------------------------------------------------------------


def test_commit_order_accepts_a_short_sha_of_the_frozen_commit(tmp_path):
    order = _mut(
        _commit_order(), lambda o: o["predictions"]["natives_all_six_fail"]["receipts"][0].update(commit=SHA2[:12])
    )
    doc = cal.write_dossier(tmp_path / "d.json", **_inputs(tmp_path, commit_order=order))
    assert doc["gate_p_ready"] is True


# -- A-2 and C-4: the optional-stopping rules --------------------------------------------------------------------


def _fake_study(biases: dict[str, float], early: dict[str, float] | None = None, n_tr: int = 400):
    """A replacement for _exit_study_panel: zero-mean noise per rule plus a bias, with a set early share."""
    early = early or {}

    def study(seed: int, n_days: int, rows, start_ms: int = 0):
        rng = np.random.default_rng(seed)
        out = {}
        for name, _ps in rows:
            ret = rng.normal(0.0, 0.01, n_tr) + biases.get(name, 0.0)
            share = early.get(name, 0.5)
            fired = rng.random(n_tr) < share
            out[name] = {"returns": ret, "hold_share": np.where(fired, 0.5, 1.0), "early": fired}
        return out

    return study


def test_x1_negative_bias_is_not_ok(monkeypatch):
    monkeypatch.setattr(cal, "_exit_study_panel", _fake_study({"X1": -0.004}))
    out = cal.optional_stopping_check(n_panels=20, n_days=10, rules=("X1", "E2"), seed_base=1)
    x1 = out["rules"]["X1"]
    assert x1["significant"] is True and x1["positive"] is False and x1["mean"] < 0
    assert x1["ok"] is False
    assert out["rules"]["E2"]["ok"] is True
    assert out["met"] is False


def test_x1_positive_and_clean_rows(monkeypatch):
    monkeypatch.setattr(cal, "_exit_study_panel", _fake_study({"X1": 0.004}))
    out = cal.optional_stopping_check(n_panels=20, n_days=10, rules=("X1",), seed_base=1)
    assert out["rules"]["X1"]["positive"] is True and out["rules"]["X1"]["ok"] is False
    monkeypatch.setattr(cal, "_exit_study_panel", _fake_study({}))
    clean = cal.optional_stopping_check(n_panels=20, n_days=10, rules=("X1", "E2"), seed_base=1)
    assert clean["rules"]["X1"]["ok"] is True and clean["met"] is True


def test_loosened_rows_that_stop_firing_make_the_check_not_met(monkeypatch):
    monkeypatch.setattr(cal, "_exit_study_panel", _fake_study({}, early={"E4_loose": 0.05, "E5_loose": 0.5}))
    out = cal.optional_stopping_check(n_panels=20, n_days=10, rules=("E4_loose", "E5_loose", "E2"), seed_base=1)
    assert out["rules"]["E4_loose"]["informative"] is False
    assert out["rules"]["E5_loose"]["informative"] is True
    assert all(r["ok"] for r in out["rules"].values())
    assert out["met"] is False


def test_loosened_rows_that_fire_keep_the_check_met(monkeypatch):
    monkeypatch.setattr(cal, "_exit_study_panel", _fake_study({}, early={"E4_loose": 0.5, "E5_loose": 0.5}))
    out = cal.optional_stopping_check(n_panels=20, n_days=10, rules=("E4_loose", "E5_loose"), seed_base=1)
    assert out["rules"]["E4_loose"]["informative"] is True and out["rules"]["E5_loose"]["informative"] is True
    assert out["met"] is True


def test_a_subset_without_loosened_rows_is_judged_on_the_rows_it_has(monkeypatch):
    monkeypatch.setattr(cal, "_exit_study_panel", _fake_study({}))
    out = cal.optional_stopping_check(n_panels=20, n_days=10, rules=("E2", "E3"), seed_base=1)
    assert out["met"] is True


# -- C-8 -----------------------------------------------------------------------------------------------------------


def test_item3_refuses_a_dict_of_daily_frames():
    import pandas as pd

    from r4.bar import item3

    frames = {"a": pd.DataFrame({"drift_free": [0.1, 0.2, -0.1, 0.0]}), "b": pd.DataFrame({"drift_free": [0.0] * 4})}
    for f in frames.values():
        f.attrs["config_hash"] = "h"
    with pytest.raises(TypeError, match="float"):
        item3({"metrics": {"wf_sharpe": 0.1, "n_days": 4}}, frames, 120)
    # The float path is unchanged.
    assert item3({"metrics": {"wf_sharpe": 0.1, "n_days": 4}}, 0.01, 120)["num_trials"] == 120


# -- the null writer -------------------------------------------------------------------------------------------


def test_null_output_carries_commit_source_and_dataset(tmp_path, monkeypatch):
    from r4.calibration_null import main as null_main
    from r4.cli import reproduction_inputs

    inp = tmp_path / "in.json"
    payload = {
        "covariance": (0.001 * np.eye(3)).tolist(),
        "betas": [1, 1, 1],
        "scale": 0.04,
        "pilot": {"paths": 10, "seed": 20261024},
        "dcov_dataset_hash": DS_HASH,
    }
    inp.write_text(json.dumps(payload), encoding="utf-8")
    out = tmp_path / "out.json"
    monkeypatch.setenv("R4_COMMIT", SHA2)
    assert null_main(["--input", str(inp), "--paths", "20", "--days", "30", "--out", str(out)]) == 0
    res = json.loads(out.read_text(encoding="utf-8"))
    repro = reproduction_inputs()
    assert res["dcov_dataset_hash"] == DS_HASH
    assert res["provenance"]["commits"] == [SHA2]
    assert res["provenance"]["source_sha256"] == [repro["source_sha256"]]
    assert res["provenance"]["requirements_lock_sha256"] == [repro["requirements_lock_sha256"]]
    assert res["provenance"]["versions"] == [repro["versions"]]
    assert res["reproduction"] == repro
    # A commit flag wins over the environment, and without either the output records no commit (the dossier refuses).
    out2 = tmp_path / "out2.json"
    assert (
        null_main(["--input", str(inp), "--paths", "20", "--days", "30", "--out", str(out2), "--commit", "abc1234"])
        == 0
    )
    assert json.loads(out2.read_text(encoding="utf-8"))["provenance"]["commits"] == ["abc1234"]
    monkeypatch.delenv("R4_COMMIT")
    out3 = tmp_path / "out3.json"
    assert null_main(["--input", str(inp), "--paths", "20", "--days", "30", "--out", str(out3)]) == 0
    assert json.loads(out3.read_text(encoding="utf-8"))["provenance"]["commits"] == [None]


# -- receipt provenance and the reuse rule ---------------------------------------------------------------------


def test_receipt_provenance_lists_dataset_lock_and_versions():
    r1 = {
        "commit": SHA2,
        "source_sha256": "s",
        "dataset_hash": "d1",
        "requirements_lock_sha256": LOCK_SHA,
        "versions": {"a": "1"},
    }
    r2 = {**r1, "dataset_hash": "d2"}
    prov = cal.receipt_provenance([r1, r2, dict(r1)])
    assert prov["commits"] == [SHA2] and prov["source_sha256"] == ["s"]
    assert prov["dataset_hash"] == ["d1", "d2"]
    assert prov["requirements_lock_sha256"] == [LOCK_SHA]
    assert prov["versions"] == [{"a": "1"}]
    assert "dataset_hash" not in cal.receipt_provenance([r1], dataset=False)


def _reuse_world(tmp_path: Path):
    from r4 import cli

    ds = tmp_path / "ds"
    ds.mkdir()
    (ds / "manifest.json").write_text(json.dumps({"datasetHash": "abc", "symbols": [], "files": []}), encoding="utf-8")
    raw = {"id": "cfg1", "family": "x"}
    runs = tmp_path / "runs"
    (runs / "cfg1").mkdir(parents=True)
    receipt = {
        "config_hash": cli.config_hash_of(raw),
        "commit": SHA2,
        "source_sha256": cli.source_digest(),
        "dataset_hash": "abc",
    }
    (runs / "cfg1" / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    return ds, raw, runs, receipt


def test_run_or_reuse_reuses_only_a_matching_run(tmp_path):
    ds, raw, runs, receipt = _reuse_world(tmp_path)
    got = cal._run_or_reuse(tmp_path / "cfg.json", raw, ds, runs, SHA2, None)
    assert got == receipt


@pytest.mark.parametrize("field", ["source_sha256", "dataset_hash", "commit", "config_hash"])
def test_run_or_reuse_refuses_a_run_that_differs(tmp_path, field):
    ds, raw, runs, receipt = _reuse_world(tmp_path)
    receipt[field] = (
        "other" if field in ("dataset_hash", "config_hash") else ("e" * 64 if field == "source_sha256" else "d" * 40)
    )
    (runs / "cfg1" / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    with pytest.raises(ValueError):
        cal._run_or_reuse(tmp_path / "cfg.json", raw, ds, runs, SHA2, None)


# -- power meta ------------------------------------------------------------------------------------------------


def test_power_meta_carries_the_dcov_dataset_hash():
    dcov = {"cov": np.eye(2).tolist(), "symbols": ["A", "B"], "dataset_hash": DS_HASH}
    meta = cal._power_meta(dcov, 3, 0, 10, 5, [0.01, 0.02])
    assert meta["dcov_dataset_hash"] == DS_HASH
    assert (
        cal._power_meta({"cov": np.eye(2).tolist(), "symbols": ["A", "B"]}, 3, 0, 10, 5, [0.01])["dcov_dataset_hash"]
        is None
    )
