"""Brief 28n: the dossier recomputes the noise evaluation (Gate P review 3, F1, F5 and F6)."""

from __future__ import annotations

import copy
import json
import shutil

import pytest

from r4 import calibration as cal
from tests.test_calibration_power import _noise_eval
from tests.test_lazy_tranches_28j import noise_runs  # noqa: F401  (module fixture)


def _run(noise_runs):  # noqa: F811
    return cal.evaluate_noise(noise_runs["runs"], noise_runs["ds"], panel=noise_runs["panel"], joint_draws=5)


def _bad(mutate, match):
    d = _noise_eval()
    mutate(d)
    with pytest.raises(ValueError, match=match):
        cal._validate_noise(d)


# ---- F1: _noise_verdicts and evaluate_noise ------------------------------------------------------------------


def test_noise_verdicts_has_the_seven_entries():
    v = cal._noise_verdicts(0, 2, 0.05, 1, 0.5, (1, 2))
    assert len(v) == 7
    assert v["noise_joint_shift_reference_panels"]["reference_counts"] == [1, 2]
    assert v["noise_joint_shift_reference_panels"]["met"] is True
    assert v["noise_items123_zero_of_40"]["met"] is True
    assert cal._noise_verdicts(1, 9, 0.2, None, None, None)["noise_joint_shift_reference_panels"]["met"] is None


def test_evaluate_noise_verdict_matches_independent_expectation(noise_runs):  # noqa: F811
    out = _run(noise_runs)
    n_pass = sum(c["pass_items_1_to_3"] for c in out["configs"].values())
    n_rej = sum(c["joint_shift"]["p"] < 0.05 for c in out["configs"].values())
    wsg = out["diagnostics"]["within_seed_group_pbo"]["median"]
    cf_n = out["diagnostics"]["cost_free"]["n_pass_items_1_to_3"]
    pbo = float(out["item2"]["pbo"])
    pairs = {
        "noise_items123_at_most_5": (n_pass, n_pass <= 5),
        "noise_items123_zero_of_40": (n_pass, n_pass == 0),
        "noise_joint_shift_at_most_6": (n_rej, n_rej <= 6),
        "noise_family_pbo_net_below_0_1": (pbo, pbo < 0.1),
        "noise_cost_free_items123_0_to_2": (cf_n, None if cf_n is None else cf_n <= 2),
        "noise_within_seed_group_pbo_median_0_3_to_0_7": (wsg, None if wsg is None else 0.3 <= wsg <= 0.7),
        "noise_joint_shift_reference_panels": (n_rej, 1 <= n_rej <= 2),
    }
    expected = {
        pid: {
            "status": cal.PREDICTIONS[pid]["status"],
            "text": cal.PREDICTIONS[pid]["text"],
            "observed": obs,
            "met": met,
        }
        for pid, (obs, met) in pairs.items()
    }
    expected["noise_joint_shift_reference_panels"]["reference_counts"] = [1, 2]
    assert json.dumps(out["verdict"], sort_keys=True) == json.dumps(expected, sort_keys=True)


# ---- F1: _validate_noise -------------------------------------------------------------------------------------


def test_validate_noise_accepts_a_consistent_document():
    d = _noise_eval()
    assert cal._validate_noise(d) is d["verdict"]
    assert cal._validate_noise(_noise_eval(n_pass=1, n_rej=7, pbo=0.4, cf_n=3, wsg_median=0.9))


def test_validate_noise_missing_configs():
    _bad(lambda d: d.pop("configs"), "configs")


def test_validate_noise_configs_ids_differ_from_noise_set():
    def mut(d):
        d["configs"]["noise_xx"] = d["configs"].pop(next(iter(d["configs"])))

    _bad(mut, "configs ids differ")


def test_validate_noise_five_draws():
    def mut(d):
        d["configs"][next(iter(d["configs"]))]["joint_shift"]["draws"] = 5

    _bad(mut, "draws")


def test_validate_noise_wrong_seed():
    def mut(d):
        d["configs"][next(iter(d["configs"]))]["joint_shift"]["seed"] += 1

    _bad(mut, "seed")


def test_validate_noise_gated_count_differs_from_recount():
    def mut(d):
        d["gated"]["n_reject_joint_shift_05"] += 1

    _bad(mut, "n_reject_joint_shift_05")


def test_validate_noise_gated_pass_count_differs_from_recount():
    def mut(d):
        d["gated"]["n_pass_items_1_to_3"] += 1

    _bad(mut, "n_pass_items_1_to_3")


def test_validate_noise_flipped_met():
    def mut(d):
        v = d["verdict"]["noise_items123_zero_of_40"]
        v["met"] = not v["met"]

    _bad(mut, "noise_items123_zero_of_40")


def test_validate_noise_altered_reference_counts():
    def mut(d):
        d["verdict"]["noise_joint_shift_reference_panels"]["reference_counts"] = [0, 40]

    _bad(mut, "noise_joint_shift_reference_panels")


def test_validate_noise_excluded_from_v_empty():
    def mut(d):
        d["variance"]["excluded_from_v"] = []

    _bad(mut, "excluded_from_v")


def test_validate_noise_verdict_with_stale_pbo():
    def mut(d):
        d["item2"]["pbo"] = 0.5

    _bad(mut, "noise_family_pbo_net_below_0_1")


def test_validate_noise_with_patched_registration(monkeypatch):
    d = _noise_eval()
    monkeypatch.setattr(cal, "NOISE_V_EXCLUDED", frozenset({"other"}))
    with pytest.raises(ValueError, match="excluded_from_v"):
        cal._validate_noise(copy.deepcopy(d))


# ---- F5 ------------------------------------------------------------------------------------------------------


def test_evaluate_noise_reports_trade_floor(noise_runs):  # noqa: F811
    out = _run(noise_runs)
    failed = []
    for i, c in out["configs"].items():
        tf = c["trade_floor"]
        receipt = noise_runs["receipts"][i]
        n_tr, n_dec = cal._trade_counts(receipt)
        assert tf["n_tranches"] == n_tr and tf["n_decisions"] == n_dec
        assert tf["trade_share"] == (n_tr / n_dec if n_dec else None)
        assert tf["ok"] is cal.trade_floor_ok(receipt)
        if not tf["ok"]:
            failed.append(i)
    assert out["trade_floor_failed"] == sorted(failed)
    # reported only: the fixture is far below 1,000 tranches, yet the gate and V are untouched
    assert out["variance"]["excluded_from_v"] == []


# ---- F6 ------------------------------------------------------------------------------------------------------


def test_load_noise_runs_rejects_a_renamed_directory(noise_runs, tmp_path):  # noqa: F811
    dst = tmp_path / "runs"
    shutil.copytree(noise_runs["runs"], dst)
    first = sorted(p for p in dst.iterdir() if p.is_dir())[0]
    first.rename(dst / "renamed_run")
    with pytest.raises(ValueError, match="renamed_run"):
        cal._load_noise_runs(dst)
    assert len(cal._load_noise_runs(noise_runs["runs"])) == 3
