"""Brief 28i: the synthetic V panel and the two reference panels (synthetic, small spans, few draws)."""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import pytest

import r4.cli
import r4.synth
from r4 import calibration as cal
from r4.cli import config_hash_of, main
from r4.method import DEV_END, UNIVERSE
from tests.test_cli_bar import COMMIT

DAY = 86_400_000
N_DAYS = 150
START = DEV_END - N_DAYS * DAY
FIRST_REFIT = START + 70 * DAY
SYMS = list(UNIVERSE[:6])
_SD = 0.03
COV6 = (_SD**2 * (0.4 * np.eye(6) + 0.6 * np.ones((6, 6)))).tolist()
SMALL = {"start_ms": START, "end_ms": DEV_END, "first_refit_ms": FIRST_REFIT, "joint_draws": 4}
DCOV_HASH = "dcov-hash-for-tests"


@pytest.fixture(autouse=True)
def small_refit(monkeypatch):
    """noise_grid() builds its configs with FIRST_REFIT_MS, so the small span needs the same constant."""
    monkeypatch.setattr(cal, "FIRST_REFIT_MS", FIRST_REFIT)


def _write_dcov(tmp_path: Path) -> Path:
    f = tmp_path / "dcov.json"
    f.write_text(
        json.dumps({"cov": COV6, "betas": [1.0] * 6, "symbols": SYMS, "dataset_hash": DCOV_HASH, "n_days": 10}),
        encoding="utf-8",
    )
    return f


def _two_configs(monkeypatch):
    """A 2-config grid in one cost cell (enough for a within-cell V) for the cheap behavioural tests."""
    full = cal.noise_grid()
    sub = [full[0], full[1]]
    monkeypatch.setattr(cal, "noise_grid", lambda: [dict(c) for c in sub])
    return sub


def _floor_fails(monkeypatch, failing: set[str]):
    def fake(receipt):
        return receipt["config"]["id"] not in failing

    monkeypatch.setattr(cal, "trade_floor_ok", fake)


def test_constants():
    assert cal.SYNTH_V_SEED == 3999
    assert cal.REFERENCE_PANEL_SEEDS == (3997, 3998)


def test_seeds_used_in_order(tmp_path, monkeypatch):
    _two_configs(monkeypatch)
    _floor_fails(monkeypatch, set())
    seen: list[int] = []
    real = r4.synth.synth_panel

    def spy(*a, **kw):
        seen.append(int(kw["seed"]))
        return real(*a, **kw)

    monkeypatch.setattr(r4.synth, "synth_panel", spy)
    dcov = json.loads(_write_dcov(tmp_path).read_text())
    cal.synthetic_v(_write_dcov(tmp_path), tmp_path / "out", COMMIT, **SMALL)
    assert dcov["symbols"] == SYMS
    assert seen == [3999, 3997, 3998]


def test_replacement_attempts(tmp_path, monkeypatch):
    sub = _two_configs(monkeypatch)
    a, b = sub[0]["id"], sub[1]["id"]
    alt1 = cal.noise_alternative(sub[0], 1)
    alt2 = cal.noise_alternative(sub[0], 2)

    _floor_fails(monkeypatch, {a})
    out = cal.synthetic_v(_write_dcov(tmp_path), tmp_path / "o1", COMMIT, **SMALL)
    rows = {r["replaces"] or r["id"]: r for r in out["noise_set"]}
    assert rows[a]["id"] == alt1["id"] and rows[a]["attempt"] == 1 and rows[a]["replaces"] == a
    assert rows[a]["config_hash"] == config_hash_of({**alt1, "first_refit_ms": FIRST_REFIT})
    assert rows[b]["id"] == b and rows[b]["attempt"] is None and rows[b]["replaces"] is None
    assert out["trade_floor"][a]["final_id"] == alt1["id"]
    assert not out["trade_floor"][a]["trade_floor_failed"]

    _floor_fails(monkeypatch, {a, alt1["id"]})
    out = cal.synthetic_v(_write_dcov(tmp_path), tmp_path / "o2", COMMIT, **SMALL)
    row = next(r for r in out["noise_set"] if r["replaces"] == a)
    assert row["id"] == alt2["id"] and row["attempt"] == 2
    assert not out["trade_floor"][a]["trade_floor_failed"]

    _floor_fails(monkeypatch, {a, alt1["id"], alt2["id"]})
    out = cal.synthetic_v(_write_dcov(tmp_path), tmp_path / "o3", COMMIT, **SMALL)
    row = next(r for r in out["noise_set"] if r["replaces"] == a)
    assert row["id"] == alt2["id"] and row["attempt"] == 2
    assert out["trade_floor"][a]["trade_floor_failed"] is True
    assert out["trade_floor"][b]["trade_floor_failed"] is False
    # the reference panels run the final set (the attempt 2 replacement)
    for ref in out["reference_panels"]:
        assert alt2["id"] in ref["rejections_by_config"]


def test_resume_reuses_runs_and_cli_refuses_overwrite(tmp_path, monkeypatch, capsys):
    _two_configs(monkeypatch)
    _floor_fails(monkeypatch, set())
    dcov = _write_dcov(tmp_path)
    cal.synthetic_v(dcov, tmp_path / "out", COMMIT, **SMALL)
    calls: list[str] = []
    real = r4.cli.run_wf

    def spy(*a, **kw):
        calls.append(str(a[0]))
        return real(*a, **kw)

    monkeypatch.setattr(r4.cli, "run_wf", spy)
    cal.synthetic_v(dcov, tmp_path / "out", COMMIT, **SMALL)
    assert calls == []

    argv = [
        "r4.cli",
        "calib-synth-v",
        "--dcov",
        str(dcov),
        "--out",
        str(tmp_path / "out"),
        "--commit",
        COMMIT,
        "--start-ms",
        str(START),
        "--end-ms",
        str(DEV_END),
        "--first-refit-ms",
        str(FIRST_REFIT),
        "--draws",
        "4",
    ]
    (tmp_path / "out" / "synth_v.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", argv)
    with pytest.raises((SystemExit, ValueError, FileExistsError)):
        main()
    assert (tmp_path / "out" / "synth_v.json").read_text(encoding="utf-8") == "{}"


@pytest.fixture(scope="module")
def full_run(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    mp.setattr(cal, "FIRST_REFIT_MS", FIRST_REFIT)
    mp.setattr(cal, "trade_floor_ok", lambda receipt: True)
    root = tmp_path_factory.mktemp("synthv")
    dcov = _write_dcov(root)
    t0 = time.perf_counter()
    out = cal.synthetic_v(dcov, root / "out", COMMIT, **SMALL)
    wall = time.perf_counter() - t0
    yield {"root": root, "dcov": dcov, "out": out, "wall": wall}
    mp.undo()


def test_full_run_keys_and_noise_set(full_run):
    out, root = full_run["out"], full_run["root"]
    written = json.loads((root / "out" / "synth_v.json").read_text(encoding="utf-8"))
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
        assert key in written, key
    assert written["panel_seeds"] == {"v": 3999, "reference": [3997, 3998]}
    assert written["dcov_sha256"] == hashlib.sha256(full_run["dcov"].read_bytes()).hexdigest()
    assert written["dcov_dataset_hash"] == DCOV_HASH
    assert len(written["noise_set"]) == 40
    # Every trade floor passes here, so the rows are the plain grid. The registered final set (A1.9) also needs the
    # four recorded replacements, so the plain grid is refused until they are substituted.
    with pytest.raises(ValueError, match="noise_26_logit_C2_s1_alt2"):
        cal._check_noise_set({"noise_set": written["noise_set"]})
    v = written["variance"]
    assert v["within_cell"]["V"] > 0 and v["total"]["V"] > 0
    assert set(v["within_seed_group"]) >= {"V", "df"}
    assert "between_group" in v
    assert written["sr0"]["N"] == 120 and written["sr0"]["within_cell"] > 0
    assert len(written["trade_floor"]) == 40
    row = next(iter(written["trade_floor"].values()))
    assert {"final_id", "trade_floor_failed", "n_tranches", "trade_share", "attempts"} <= set(row)
    assert out["noise_set"] == written["noise_set"]


def test_reference_counts_are_integers(full_run):
    refs = full_run["out"]["reference_panels"]
    assert [r["seed"] for r in refs] == [3997, 3998]
    for r in refs:
        assert isinstance(r["n_reject_05"], int) and 0 <= r["n_reject_05"] <= 40
        assert len(r["rejections_by_config"]) == 40
        assert r["draws"] == 4


def test_print_wall_time(full_run, capsys):
    with capsys.disabled():
        print(f"\nsynthetic_v full small run: {full_run['wall']:.1f} s")
