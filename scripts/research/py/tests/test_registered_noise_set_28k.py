"""Brief 28k: the registered final noise set (A1.9) and the reference-panel judgement."""

from __future__ import annotations

import json
import sys

import pytest

from r4 import calibration as cal
from r4.cli import config_hash_of, main
from tests.test_lazy_tranches_28j import noise_runs  # noqa: F401  (module fixture)

REPLACED = {
    "noise_26_logit_C2_s1": "noise_26_logit_C2_s1_alt2",
    "noise_27_logit_C2_s2": "noise_27_logit_C2_s2_alt2",
    "noise_28_logit_C4_s1": "noise_28_logit_C4_s1_alt2",
    "noise_29_logit_C4_s2": "noise_29_logit_C4_s2_alt2",
}


def _rows(configs):
    return [
        {
            "id": c["id"],
            "config_hash": config_hash_of(c),
            "replaces": c.get("replaces"),
            "attempt": c.get("attempt"),
        }
        for c in configs
    ]


def test_noise_replacements_constant():
    assert cal.NOISE_REPLACEMENTS == {k: 2 for k in REPLACED}


def test_final_set_shape():
    grid = cal.noise_grid()
    final = cal.noise_final_set()
    assert len(final) == 40
    for g, f in zip(grid, final, strict=True):
        if g["id"] in REPLACED:
            assert f["id"] == REPLACED[g["id"]]
            assert f["attempt"] == 2
            assert f["replaces"] == g["id"]
            assert f["threshold"] == g["threshold"] / 2.0
            assert f["noise_seed"] == g["noise_seed"] + cal.NOISE_ALT_SEED_STEP
            assert f == cal.noise_alternative(g, 2)
        else:
            assert f == g
    assert sorted(f["id"] for f in final if f["id"].endswith("_alt2")) == sorted(REPLACED.values())


def test_final_set_rejects_bad_registry(monkeypatch):
    monkeypatch.setattr(cal, "NOISE_REPLACEMENTS", {"noise_nope": 2})
    with pytest.raises(ValueError):
        cal.noise_final_set()
    monkeypatch.setattr(cal, "NOISE_REPLACEMENTS", {"noise_26_logit_C2_s1": 3})
    with pytest.raises(ValueError):
        cal.noise_final_set()


def test_check_noise_set_accepts_final_set():
    cal._check_noise_set({"noise_set": _rows(cal.noise_final_set())})


def test_check_noise_set_rejects_plain_grid():
    with pytest.raises(ValueError, match="noise_26_logit_C2_s1"):
        cal._check_noise_set({"noise_set": _rows(cal.noise_grid())})


def test_check_noise_set_rejects_unregistered_replacement():
    final = cal.noise_final_set()
    grid = cal.noise_grid()
    final[0] = cal.noise_alternative(grid[0], 1)
    with pytest.raises(ValueError, match="noise_00"):
        cal._check_noise_set({"noise_set": _rows(final)})


def test_check_noise_set_rejects_wrong_attempt_for_registered():
    final = cal.noise_final_set()
    grid = cal.noise_grid()
    final[28] = cal.noise_alternative(grid[28], 1)
    with pytest.raises(ValueError, match="noise_28"):
        cal._check_noise_set({"noise_set": _rows(final)})


def test_calib_grid_writes_final_set(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["r4", "calib-grid", "--out", str(tmp_path)])
    main()
    final = cal.noise_final_set()
    names = sorted(p.name for p in (tmp_path / "noise").glob("*.json"))
    assert names == sorted(f"{c['id']}.json" for c in final)
    assert "noise_26_logit_C2_s1_alt2.json" in names
    assert not (tmp_path / "noise" / "noise_26_logit_C2_s1.json").exists()
    for c in final:
        got = json.loads((tmp_path / "noise" / f"{c['id']}.json").read_text(encoding="utf-8"))
        assert got == c


@pytest.mark.parametrize(
    ("pair", "met"),
    [((0, 40), True), ((39, 40), False), (None, None)],
)
def test_reference_panel_judgement(noise_runs, monkeypatch, pair, met):  # noqa: F811
    monkeypatch.setattr(cal, "REFERENCE_PANEL_REJECTIONS", pair, raising=False)
    out = cal.evaluate_noise(noise_runs["runs"], noise_runs["ds"], panel=noise_runs["panel"], joint_draws=5)
    v = out["verdict"]["noise_joint_shift_reference_panels"]
    assert v["met"] is met
    if pair is None:
        assert "reference_counts" not in v
    else:
        assert v["reference_counts"] == list(pair)
        assert v["observed"] == out["gated"]["n_reject_joint_shift_05"]
