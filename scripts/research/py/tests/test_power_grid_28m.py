"""Brief 28m: the registered power amplitude grid and walk variance, bound in the CLI and the dossier."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

from r4 import bar
from r4 import calibration as cal
from r4.cli import main
from tests.test_calibration_power import DCOV, SMALL, V_SMALL, _power_doc, power_sim  # noqa: F401
from tests.test_registration_phase4 import _record

REGISTERED_GRID = [0.0010, 0.0012, 0.0013, 0.0014, 0.0015, 0.0016, 0.0018, 0.0020, 0.0024]
GRID_ARG = ",".join(repr(a) for a in REGISTERED_GRID)


def test_registered_constants_have_the_exact_values():
    assert cal.POWER_AMPLITUDE_GRID == tuple(REGISTERED_GRID)
    assert cal.POWER_AMPLITUDE_GRID[len(cal.POWER_AMPLITUDE_GRID) // 2] == 0.0015
    assert cal.SYNTH_V_A2 == 0.005999340537151945
    assert cal.POWER_STOP_V == cal.POWER_MARGIN * cal.SYNTH_V_A2


def test_synth_v_a2_is_the_within_cell_v_of_the_committed_record():
    # The same recomputation as test_registration_phase4: bar's within-cell rule over the 36 controls left after
    # NOISE_V_EXCLUDED.
    import numpy as np

    sharpes = _record()["variance"]["sharpes"]
    cfg = {c["id"]: c for c in cal.noise_final_set()}
    cells: dict = {}
    for i in sorted(set(sharpes) - set(cal.NOISE_V_EXCLUDED)):
        cells.setdefault(bar.cell_key(cfg[i]), []).append(sharpes[i])
    used = [np.asarray(v) for v in cells.values() if len(v) >= 2]
    v = sum(float(np.sum((x - x.mean()) ** 2)) for x in used) / sum(len(x) - 1 for x in used)
    assert abs(v - cal.SYNTH_V_A2) < 1e-15


def _doc(**over):
    return _power_doc(**over)


def test_dossier_accepts_the_registered_grid_and_stop_v():
    d = _doc()
    assert d["grid"] == list(cal.POWER_AMPLITUDE_GRID) and d["stop_v"] == cal.POWER_STOP_V
    cal._check_power_parameters(d, d["a_star"])


def test_dossier_refuses_another_increasing_grid():
    grid = [a for a in cal.POWER_AMPLITUDE_GRID if a != 0.0013]
    d = _doc(grid=grid)
    with pytest.raises(ValueError, match="registered amplitude grid"):
        cal._check_power_parameters(d, d["a_star"])


@pytest.mark.parametrize("bad", [None, 0.01, 0.0072])
def test_dossier_refuses_a_wrong_or_missing_stop_v(bad):
    d = _doc(stop_v=bad)
    with pytest.raises(ValueError, match="stop_v"):
        cal._check_power_parameters(d, d["a_star"])


def _run(monkeypatch, *argv: str) -> None:
    monkeypatch.setattr(sys, "argv", ["r4", *argv])
    main()


def _forbid_simulation(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("power_simulation must not run")

    monkeypatch.setattr(cal, "power_simulation", boom)


def _base(tmp_path: Path) -> list[str]:
    dcov = tmp_path / "dcov.json"
    dcov.write_text(json.dumps(DCOV), encoding="utf-8")
    return ["calib-power", "--dcov", str(dcov), "--out", str(tmp_path / "p"), "--commit", "c0ffee"]


def test_cli_refuses_a_non_registered_grid_before_any_simulation(tmp_path, monkeypatch):
    _forbid_simulation(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        _run(monkeypatch, *_base(tmp_path), "--amplitudes", "0.001,0.002")
    assert exc.value.code not in (0, None)


def test_cli_refuses_a_non_registered_stop_v_on_the_full_span(tmp_path, monkeypatch):
    _forbid_simulation(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        _run(monkeypatch, *_base(tmp_path), "--amplitudes", GRID_ARG, "--stop-v", "0.01")
    assert exc.value.code not in (0, None)


def test_cli_defaults_to_the_registered_grid_and_stop_v(tmp_path, monkeypatch):
    seen: dict = {}

    def fake(dcov, out, amplitudes, **kw):
        Path(out).mkdir(parents=True, exist_ok=True)
        seen.update(amplitudes=list(amplitudes), **kw)
        return {"order": [], "runtime_s": 0.0, "stop_v": kw["stop_v"]}

    monkeypatch.setattr(cal, "power_simulation", fake)
    _run(monkeypatch, *_base(tmp_path))
    assert seen["amplitudes"] == REGISTERED_GRID and seen["stop_v"] == cal.POWER_STOP_V
    seen.clear()
    _run(monkeypatch, *_base(tmp_path), "--amplitudes", GRID_ARG, "--stop-v", repr(cal.POWER_STOP_V))
    assert seen["amplitudes"] == REGISTERED_GRID and seen["stop_v"] == cal.POWER_STOP_V


def test_cli_allows_another_stop_v_only_with_the_test_span_options(tmp_path, monkeypatch):
    seen: dict = {}

    def fake(dcov, out, amplitudes, **kw):
        Path(out).mkdir(parents=True, exist_ok=True)
        seen.update(kw)
        return {"order": [], "runtime_s": 0.0, "stop_v": kw["stop_v"]}

    monkeypatch.setattr(cal, "power_simulation", fake)
    _run(monkeypatch, *_base(tmp_path), "--stop-v", "0.01", "--start-ms", str(SMALL["start_ms"]))
    assert seen["stop_v"] == 0.01


def test_power_curve_carries_stop_v_from_the_power_summary(power_sim, tmp_path, monkeypatch):  # noqa: F811
    pdir = tmp_path / "power"
    shutil.copytree(power_sim["dir"], pdir)
    args = ["calib-power-curve", "--power-dir", str(pdir), "--v", str(V_SMALL / 1.2), "--draws", "20"]
    _run(monkeypatch, *args, "--out", str(tmp_path / "none.json"))
    assert json.loads((tmp_path / "none.json").read_text(encoding="utf-8"))["stop_v"] is None
    (pdir / "power_summary.json").write_text(json.dumps({"stop_v": 0.123}), encoding="utf-8")
    _run(monkeypatch, *args, "--out", str(tmp_path / "with.json"))
    assert json.loads((tmp_path / "with.json").read_text(encoding="utf-8"))["stop_v"] == 0.123


def _fail(rate: float = 0.1) -> dict:
    return {"rate": rate, "n": cal.POWER_REPLICATES}


def test_choose_a_star_asks_for_the_next_registered_amplitude_before_doubling():
    # The walk evaluated 0.0014 and 0.0015 at the synthetic V; at 1.2 x D V both fail. The registered grid continues
    # above, so the next grid amplitude is needed, not a doubling of the largest evaluated one.
    calls: list[float] = []
    curve = {0.0014: _fail(), 0.0015: _fail()}
    out = cal.choose_a_star(curve, extend=lambda a: calls.append(a) or _fail(), grid=cal.POWER_AMPLITUDE_GRID)
    assert out == {"needs": 0.0016}
    assert calls == []
    curve[0.0016] = _fail(0.85)
    out = cal.choose_a_star(curve, extend=lambda a: calls.append(a) or _fail(), grid=cal.POWER_AMPLITUDE_GRID)
    assert out["a_star"] == 0.0016 and out["extensions"] == [] and calls == []


def test_choose_a_star_doubles_from_the_grid_maximum_only_after_the_grid():
    curve = {a: _fail() for a in cal.POWER_AMPLITUDE_GRID if a >= 0.0014}
    out = cal.choose_a_star(curve, extend=lambda a: _fail(0.9), grid=cal.POWER_AMPLITUDE_GRID)
    assert out["extensions"] == [2.0 * max(cal.POWER_AMPLITUDE_GRID)]
    assert out["a_star"] == 2.0 * max(cal.POWER_AMPLITUDE_GRID)
