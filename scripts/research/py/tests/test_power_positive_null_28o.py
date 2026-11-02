"""Brief 28o: Gate P pre-run review 3, F2 (positive control preflight), F3, F4, F7 (grid) and F9 (null pilot)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4 import bar, cli
from r4 import calibration as cal
from r4.cli import config_hash_of, main
from r4.method import DEV_END, DEV_START
from tests.test_calibration_power import DCOV, SMALL, _curve, _null_sim, _power_doc  # noqa: F401
from tests.test_registration_phase4 import _record

REGISTERED_GRID = [0.0010, 0.0012, 0.0013, 0.0014, 0.0015, 0.0016, 0.0017, 0.0018, 0.0020, 0.0024]
RECORD_DCOV_SHA = "bcfd511f5ccff9be2744af1486fb257559114b5af81812640f25526fde91bf9b"


def _registered_meta() -> dict:
    return {
        "start_ms": DEV_START,
        "end_ms": DEV_END,
        "first_refit_ms": cal.FIRST_REFIT_MS,
        "panel_seed_base": 4000,
        "plant_seed_base": 30_000,
        "joint_seed_base": 9_000_000,
        "n_replicates": 40,
        "garch": [0.08, 0.88],
        "t_df": 4.5,
        "dcov_dataset_hash": "9" * 64,
        "dcov_sha256": RECORD_DCOV_SHA,
    }


def _doc(**over) -> dict:
    d = _power_doc()
    d["power_meta"] = _registered_meta()
    d.update(over)
    return d


# ---------------------------------------------------------------------------
# F7: the grid
# ---------------------------------------------------------------------------


def test_grid_is_the_re_registered_ten_amplitudes_with_the_new_middle():
    assert cal.POWER_AMPLITUDE_GRID == tuple(REGISTERED_GRID)
    assert cal.POWER_AMPLITUDE_GRID[len(cal.POWER_AMPLITUDE_GRID) // 2] == 0.0016


# ---------------------------------------------------------------------------
# F3: the bound power meta
# ---------------------------------------------------------------------------


def test_dcov_sha256_constant_equals_the_record():
    assert cal.DCOV_SHA256 == RECORD_DCOV_SHA == _record()["dcov_sha256"]


def test_dossier_accepts_the_registered_power_meta():
    d = _doc()
    cal._check_power_parameters(d, d["a_star"])


@pytest.mark.parametrize(
    ("field", "bad"),
    [
        ("start_ms", DEV_START + 86_400_000),
        ("end_ms", DEV_END - 86_400_000),
        ("first_refit_ms", cal.FIRST_REFIT_MS + 86_400_000),
        ("panel_seed_base", 4001),
        ("plant_seed_base", 30_001),
        ("joint_seed_base", 9_000_001),
        ("n_replicates", 39),
        ("garch", [0.1, 0.8]),
        ("t_df", 5.0),
        ("dcov_sha256", "0" * 64),
        ("dcov_sha256", None),
    ],
)
def test_dossier_refuses_a_different_power_meta_field(field, bad):
    d = _doc()
    d["power_meta"][field] = bad
    with pytest.raises(ValueError, match=field):
        cal._check_power_parameters(d, d["a_star"])


def test_dossier_refuses_a_missing_power_meta():
    d = _power_doc()
    d.pop("power_meta", None)
    with pytest.raises(ValueError, match="power_meta"):
        cal._check_power_parameters(d, d["a_star"])


def _run(monkeypatch, *argv: str) -> None:
    monkeypatch.setattr(sys, "argv", ["r4", *argv])
    main()


def test_calib_power_refuses_another_stop_v_when_the_span_is_d(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("power_simulation must not run")

    monkeypatch.setattr(cal, "power_simulation", boom)
    dcov = tmp_path / "dcov.json"
    dcov.write_text(json.dumps(DCOV), encoding="utf-8")
    base = ["calib-power", "--dcov", str(dcov), "--out", str(tmp_path / "p"), "--commit", "c0ffee"]
    for span in (
        ["--start-ms", str(DEV_START)],
        ["--end-ms", str(DEV_END)],
        ["--first-refit-ms", str(cal.FIRST_REFIT_MS)],
    ):
        with pytest.raises(SystemExit) as exc:
            _run(monkeypatch, *base, "--stop-v", "0.01", *span)
        assert exc.value.code not in (0, None)


def test_calib_power_passes_the_dcov_file_sha256(tmp_path, monkeypatch):
    import hashlib

    seen: dict = {}

    def fake(dcov, out, amplitudes, **kw):
        Path(out).mkdir(parents=True, exist_ok=True)
        seen.update(kw)
        return {"order": [], "runtime_s": 0.0, "stop_v": kw["stop_v"]}

    monkeypatch.setattr(cal, "power_simulation", fake)
    dcov = tmp_path / "dcov.json"
    dcov.write_text(json.dumps(DCOV), encoding="utf-8")
    _run(monkeypatch, "calib-power", "--dcov", str(dcov), "--out", str(tmp_path / "p"), "--commit", "c0ffee")
    assert seen["dcov_sha256"] == hashlib.sha256(dcov.read_bytes()).hexdigest()


def test_power_meta_records_dcov_sha256():
    assert cal._power_meta(DCOV, 3, 0, 10, 5, [0.01], dcov_sha256="ab")["dcov_sha256"] == "ab"
    assert cal._power_meta(DCOV, 3, 0, 10, 5, [0.01])["dcov_sha256"] is None


def test_power_curve_carries_power_meta(tmp_path, monkeypatch):
    pdir = tmp_path / "power"
    pdir.mkdir()
    meta = cal._power_meta(DCOV, 3, 0, 10, 5, [0.01, 0.02], dcov_sha256="cd")
    (pdir / "power_meta.json").write_text(json.dumps(meta), encoding="utf-8")
    monkeypatch.setattr(
        cal,
        "select_a_star",
        lambda *a, **k: {
            "curve": {0.01: _curve({0.01: 0.9})[0.01]},
            "a_star": 0.01,
            "infeasible": False,
            "extensions": [],
        },
    )
    monkeypatch.setattr(cal, "power_provenance", lambda d: {})
    _run(monkeypatch, "calib-power-curve", "--power-dir", str(pdir), "--v", "0.002", "--out", str(tmp_path / "o.json"))
    got = json.loads((tmp_path / "o.json").read_text(encoding="utf-8"))["power_meta"]
    keys = {
        "start_ms",
        "end_ms",
        "first_refit_ms",
        "panel_seed_base",
        "plant_seed_base",
        "joint_seed_base",
        "n_replicates",
        "garch",
        "t_df",
        "dcov_dataset_hash",
        "dcov_sha256",
    }
    assert set(got) == keys
    assert got["dcov_sha256"] == "cd" and got["n_replicates"] == 3 and "cov" not in got


# ---------------------------------------------------------------------------
# F4: an infeasible a* needs the doublings and the grid above the smallest evaluated amplitude
# ---------------------------------------------------------------------------


def _infeasible(extensions, amps):
    curve = {str(a): e for a, e in _curve({a: 0.1 for a in amps}).items()}
    return _doc(curve_at_1_2v=curve, a_star={"a_star": None, "infeasible": True, "extensions": extensions})


def _doublings(n):
    return [max(cal.POWER_AMPLITUDE_GRID) * 2.0 ** (k + 1) for k in range(n)]


def test_dossier_accepts_a_full_infeasible_result():
    grid = [a for a in cal.POWER_AMPLITUDE_GRID if a >= 0.0016]
    d = _infeasible(_doublings(3), grid + _doublings(3))
    cal._check_power_parameters(d, d["a_star"])


@pytest.mark.parametrize("n", [0, 1, 2])
def test_dossier_refuses_an_infeasible_result_with_fewer_doublings(n):
    grid = [a for a in cal.POWER_AMPLITUDE_GRID if a >= 0.0016]
    d = _infeasible(_doublings(n), grid + _doublings(n))
    with pytest.raises(ValueError, match="doublings"):
        cal._check_power_parameters(d, d["a_star"])


def test_dossier_refuses_an_infeasible_result_missing_a_grid_amplitude():
    grid = [a for a in cal.POWER_AMPLITUDE_GRID if a >= 0.0016 and a != 0.0018]
    d = _infeasible(_doublings(3), grid + _doublings(3))
    with pytest.raises(ValueError, match="0.0018"):
        cal._check_power_parameters(d, d["a_star"])


# ---------------------------------------------------------------------------
# F9: the daily null's pilot
# ---------------------------------------------------------------------------


def test_null_pilot_constant():
    assert cal.NULL_PILOT_PATHS == 5000


@pytest.mark.parametrize(("field", "bad"), [("paths", 1000), ("n_days", 365), ("paths", None), ("n_days", None)])
def test_dossier_refuses_a_different_pilot(field, bad):
    nul = _null_sim()
    cal._check_null_parameters(nul)
    nul["pilot"][field] = bad
    with pytest.raises(ValueError, match=f"pilot.{field}"):
        cal._check_null_parameters(nul)


# ---------------------------------------------------------------------------
# F2: positive_control checks its inputs before any D work
# ---------------------------------------------------------------------------

COMMIT_OK = "abcdef1234567"
SRC = "5" * 64
DS = "7" * 64


def _write_final_set(root: Path, *, commit=COMMIT_OK, src=SRC, ds=DS, drop=0, seed=0) -> dict[str, float]:
    """Fake noise runs for the registered final set: random daily series, receipts with the freeze fields."""
    rng = np.random.default_rng(seed)
    root.mkdir(parents=True, exist_ok=True)
    final = cal.noise_final_set()
    configs = {}
    for c in final[: len(final) - drop]:
        cfg = {**c, "joint_shift_seed": 1}
        run = root / c["id"]
        run.mkdir()
        receipt = {
            "kind": "control",
            "config": cfg,
            "config_hash": config_hash_of(c),
            "commit": commit,
            "source_sha256": src,
            "dataset_hash": ds,
        }
        (run / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
        pd.DataFrame({"drift_free": rng.normal(0.0, 0.01, 60)}).to_parquet(run / "daily.parquet")
        (run / "folds.json").write_text("[]", encoding="utf-8")
        configs[c["id"]] = cfg
    return configs


def _v_of(root: Path) -> float:
    runs = cal._load_noise_runs(root)
    ids = cal._v_run_ids(runs)
    return float(
        bar.trial_sharpe_variance(
            {i: runs[i]["daily"] for i in ids}, {i: runs[i]["receipt"]["config"] for i in ids}, "within_cell"
        )["V"]
    )


class Reached(Exception):
    pass


@pytest.fixture
def world(monkeypatch, tmp_path):
    monkeypatch.setattr(bar, "read_manifest", lambda p: {"datasetHash": DS, "symbols": []})
    monkeypatch.setattr(cli, "source_digest", lambda *a, **k: SRC)

    def spy(*a, **k):
        raise Reached

    monkeypatch.setattr(cli, "run_wf", spy)
    noise = tmp_path / "noise"
    _write_final_set(noise)
    return {"noise": noise, "out": tmp_path / "out", "ds": tmp_path / "ds"}


def _pc(w, **kw):
    kw.setdefault("commit", COMMIT_OK)
    return cal.positive_control(w["ds"], 0.0015, w["noise"], w["out"], panel={}, **kw)


def _empty(out: Path) -> bool:
    return not out.exists() or not any(out.iterdir())


def test_preflight_passes_the_registered_set_and_reaches_the_runs(world):
    with pytest.raises(Reached):
        _pc(world, expected_v=_v_of(world["noise"]))
    with pytest.raises(Reached):
        _pc(world)


def test_positive_control_refuses_an_unregistered_noise_set(world, tmp_path):
    bad = tmp_path / "noise39"
    _write_final_set(bad, drop=1)
    world["noise"] = bad
    with pytest.raises(ValueError, match="noise"):
        _pc(world)
    assert _empty(world["out"])


def test_positive_control_refuses_a_different_receipt_commit(world, tmp_path):
    bad = tmp_path / "noise_commit"
    _write_final_set(bad, commit="1234567abcdef")
    world["noise"] = bad
    with pytest.raises(ValueError, match="commit"):
        _pc(world)
    assert _empty(world["out"])


def test_positive_control_refuses_a_different_source_digest(world, tmp_path):
    bad = tmp_path / "noise_src"
    _write_final_set(bad, src="6" * 64)
    world["noise"] = bad
    with pytest.raises(ValueError, match="source"):
        _pc(world)
    assert _empty(world["out"])


def test_positive_control_refuses_a_different_dataset(world, tmp_path):
    bad = tmp_path / "noise_ds"
    _write_final_set(bad, ds="8" * 64)
    world["noise"] = bad
    with pytest.raises(ValueError, match="dataset"):
        _pc(world)
    assert _empty(world["out"])


def test_positive_control_refuses_an_expected_v_that_disagrees_before_any_run(world):
    v = _v_of(world["noise"])
    with pytest.raises(ValueError, match="expected"):
        _pc(world, expected_v=v * 1.01)
    assert _empty(world["out"])


def test_a_preflight_failure_does_not_block_a_later_valid_run(world, tmp_path):
    v = _v_of(world["noise"])
    with pytest.raises(ValueError):
        _pc(world, expected_v=v * 2)
    with pytest.raises(Reached):
        _pc(world, expected_v=v)
