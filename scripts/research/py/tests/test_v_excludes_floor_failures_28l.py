"""Brief 28l: the registered trade-floor failures leave the calibration V (Amendment 2, A2.1)."""

from __future__ import annotations

import pytest

from r4 import bar
from r4 import calibration as cal
from tests.test_lazy_tranches_28j import noise_runs  # noqa: F401  (module fixture)

FLOOR_FAILURES = {
    "noise_26_logit_C2_s1_alt2",
    "noise_27_logit_C2_s2_alt2",
    "noise_28_logit_C4_s1_alt2",
    "noise_29_logit_C4_s2_alt2",
}


def _run(noise_runs):  # noqa: F811
    return cal.evaluate_noise(noise_runs["runs"], noise_runs["ds"], panel=noise_runs["panel"], joint_draws=5)


def _v_over(noise_runs, keep):  # noqa: F811
    runs = cal._load_noise_runs(noise_runs["runs"])
    daily = {i: runs[i]["daily"] for i in keep}
    configs = {i: runs[i]["receipt"]["config"] for i in keep}
    cf = {i: cal._cost_free_frame(runs[i]["daily"]) for i in keep}
    for i in keep:
        cf[i].attrs["config_hash"] = runs[i]["daily"].attrs["config_hash"]
    return (
        bar.trial_sharpe_variance(daily, configs, "within_cell"),
        bar.trial_sharpe_variance(cf, configs, "within_cell"),
    )


def test_constant_lists_the_four_alt2_ids():
    assert cal.NOISE_V_EXCLUDED == FLOOR_FAILURES
    assert isinstance(cal.NOISE_V_EXCLUDED, frozenset)
    assert FLOOR_FAILURES <= {c["id"] for c in cal.noise_final_set()}


def test_evaluate_noise_excludes_from_v(noise_runs, monkeypatch):  # noqa: F811
    ids = sorted(c["id"] for c in noise_runs["pick"])
    drop = next(c["id"] for c in noise_runs["pick"] if c["cell"] == "C4")  # the C2 pair keeps one df
    keep = [i for i in ids if i != drop]
    all3_v, _ = _v_over(noise_runs, ids)
    kept_v, _ = _v_over(noise_runs, keep)
    # the fixture ids are not in the final set, so patch the final-set membership check alongside the constant
    monkeypatch.setattr(cal, "NOISE_V_EXCLUDED", frozenset({drop}))
    monkeypatch.setattr(cal, "_check_v_excluded", lambda excluded: None)
    out = _run(noise_runs)
    assert out["variance"]["V"] == kept_v["V"]
    # the dropped C4 run is a singleton cell, so the within-cell V is unchanged but the cell count and total mode move
    assert out["variance"]["modes"]["within_cell"] == kept_v
    assert kept_v["cells_singleton"] == 0 and all3_v["cells_singleton"] == 1
    assert out["variance"]["modes"]["total"]["df"] == len(keep) - 1
    assert out["variance"]["excluded_from_v"] == [drop]
    assert out["variance"]["within_cell_with_excluded"] == all3_v
    assert sorted(out["configs"]) == ids
    for i in ids:
        e = out["configs"][i]
        assert {"item1", "item3", "joint_shift"} <= set(e)
        assert e["joint_shift"]["draws"] == 5
    ref = bar.item3(
        cal._load_noise_runs(noise_runs["runs"])[drop]["receipt"],
        kept_v["V"],
        cal.N_TRIALS_CALIBRATION,
        candidate_daily=cal._load_noise_runs(noise_runs["runs"])[drop]["daily"],
    )
    got = {k: v for k, v in out["configs"][drop]["item3"].items() if k != "variance_mode"}
    assert got == ref


def test_real_constant_changes_nothing_on_the_fixture(noise_runs):  # noqa: F811
    ids = sorted(c["id"] for c in noise_runs["pick"])
    all3_v, all3_cf = _v_over(noise_runs, ids)
    out = _run(noise_runs)
    assert out["variance"]["V"] == all3_v["V"]
    assert out["variance"]["excluded_from_v"] == []
    assert out["variance"]["within_cell_with_excluded"] == all3_v
    assert out["diagnostics"]["cost_free"]["variance"]["V"] == all3_cf["V"]


def test_cost_free_v_excludes_the_id(noise_runs, monkeypatch):  # noqa: F811
    ids = sorted(c["id"] for c in noise_runs["pick"])
    drop = next(c["id"] for c in noise_runs["pick"] if c["cell"] == "C4")  # the C2 pair keeps one df
    keep = [i for i in ids if i != drop]
    _, kept_cf = _v_over(noise_runs, keep)
    monkeypatch.setattr(cal, "NOISE_V_EXCLUDED", frozenset({drop}))
    monkeypatch.setattr(cal, "_check_v_excluded", lambda excluded: None)
    out = _run(noise_runs)
    cfd = out["diagnostics"]["cost_free"]
    assert cfd["variance"]["V"] == kept_cf["V"]
    assert sorted(cfd["configs"]) == ids


def test_family_report_v_exclude_matches_evaluate_noise(noise_runs, monkeypatch):  # noqa: F811
    drop = next(c["id"] for c in noise_runs["pick"] if c["cell"] == "C4")
    monkeypatch.setattr(cal, "NOISE_V_EXCLUDED", frozenset({drop}))
    monkeypatch.setattr(cal, "_check_v_excluded", lambda excluded: None)
    out = _run(noise_runs)
    rep = bar.family_report(
        family=noise_runs["pick"][0]["family"],
        runs_dir=noise_runs["runs"],
        round_runs_dir=noise_runs["runs"],
        ledger_count=cal.N_TRIALS_CALIBRATION,
        ds_dir=noise_runs["ds"],
        panel=noise_runs["panel"],
        calibration=True,
        v_exclude={drop},
    )
    assert rep["variance"]["V"] == out["variance"]["V"]
    assert rep["variance"]["v_excluded"] == [drop]


def test_family_report_default_keeps_all_runs(noise_runs):  # noqa: F811
    ids = sorted(c["id"] for c in noise_runs["pick"])
    all3_v, _ = _v_over(noise_runs, ids)
    rep = bar.family_report(
        family=noise_runs["pick"][0]["family"],
        runs_dir=noise_runs["runs"],
        round_runs_dir=noise_runs["runs"],
        ledger_count=cal.N_TRIALS_CALIBRATION,
        ds_dir=noise_runs["ds"],
        panel=noise_runs["panel"],
        calibration=True,
    )
    assert rep["variance"]["V"] == all3_v["V"]
    assert "v_excluded" not in rep["variance"]


def test_excluded_id_outside_final_set_raises(noise_runs, monkeypatch):  # noqa: F811
    monkeypatch.setattr(cal, "NOISE_V_EXCLUDED", frozenset({"noise_nope"}))
    with pytest.raises(ValueError, match="noise_nope"):
        _run(noise_runs)


def test_positive_control_passes_v_exclude(monkeypatch, tmp_path):
    seen = {}

    class Stop(Exception):
        pass

    def spy(**kw):
        seen.update(kw)
        raise Stop

    monkeypatch.setattr(cal.bar, "family_report", spy)
    monkeypatch.setattr("r4.cli.run_wf", lambda *a, **k: None)
    monkeypatch.setattr(cal, "pc_family", lambda a: [{"id": "pc_P1", "plant": {}, "family": "pc"}])
    monkeypatch.setattr(cal, "_check_receipts_dataset", lambda *a, **k: None)
    monkeypatch.setattr("r4.plant.apply_plant", lambda panel, plant: panel)
    monkeypatch.setattr(bar, "read_manifest", lambda p: {"datasetHash": "x", "symbols": []})
    with pytest.raises(Stop):
        cal.positive_control(tmp_path, 0.1, tmp_path, tmp_path / "out", panel={})
    assert seen["v_exclude"] == cal.NOISE_V_EXCLUDED
