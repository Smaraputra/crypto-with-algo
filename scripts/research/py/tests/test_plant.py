"""Tests for r4.plant: the planted cross-sectional offset and its 4h hash feature."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4.cli import run_wf
from r4.hashfeat import NOISE_DOMAIN, hash_normal
from r4.method import UNIVERSE
from r4.pipeline import RunConfig, decision_samples, load_panel
from r4.plant import apply_plant, plant_offsets, plant_u, plant_z, validate_plant
from r4.synth import synth_panel, write_synthetic_dataset
from tests.test_cli_bar import _make_fast_synthetic_panel

H4 = 14_400_000
SYMS = UNIVERSE[:4]
START = 1672531200000  # 2023-01-01 UTC


def _cfg(features, plant=None, noise_seed=None, interval="4h", h_ms=H4) -> RunConfig:
    return RunConfig(
        family="A",
        model="ridge",
        params={"alpha": 1.0},
        features=tuple(features),
        interval=interval,
        h_ms=h_ms,
        label="fixed",
        side_rule="sign",
        threshold=0.0,
        size_rule="unit",
        lookback_months=None,
        refit="monthly",
        exit="horizon",
        noise_seed=noise_seed,
        plant=plant,
    )


def _panel(n_days: int = 20):
    return _make_fast_synthetic_panel(symbols=SYMS, n_days=n_days, seed=5)


def test_validate_plant() -> None:
    validate_plant({"seed": 1, "amplitude": 0.001}, "4h", H4)
    for bad in ({"seed": 1}, {"amplitude": 0.1}, {"seed": 1.5, "amplitude": 0.1}, {"seed": 1, "amplitude": "x"}):
        with pytest.raises(ValueError):
            validate_plant(bad, "4h", H4)
    with pytest.raises(ValueError, match="4h"):
        validate_plant({"seed": 1, "amplitude": 0.001}, "1h", H4)
    with pytest.raises(ValueError, match="4h"):
        validate_plant({"seed": 1, "amplitude": 0.001}, "4h", 3_600_000)
    with pytest.raises(ValueError, match="4h"):
        _cfg(("planted_z",), plant={"seed": 1, "amplitude": 0.001}, interval="1h")


def test_z_is_cross_sectionally_demeaned() -> None:
    t = START + np.arange(50, dtype=np.int64) * H4
    z = plant_z(3, SYMS, t)
    assert z.shape == (len(SYMS), 50)
    assert np.allclose(z.sum(axis=0), 0.0, atol=1e-12)
    assert z.std() > 0.3


def test_offsets_sum_to_zero_and_ramp() -> None:
    panel = _panel()
    t5 = panel[SYMS[0]]["5m"]["t"].to_numpy(dtype=np.int64)
    p = plant_offsets(SYMS, 3, 0.01, t5, span=(int(t5.min()), int(t5.max())))
    assert np.allclose(p.sum(axis=0), 0.0, atol=1e-12)
    assert np.abs(p).max() > 0.0
    # linear ramp over the 4h after T + 10 minutes
    T = START + 8 * H4
    z = plant_z(3, SYMS, np.array([T], dtype=np.int64))[:, 0]
    base = plant_offsets(SYMS, 3, 0.01, np.array([T + 600_000], dtype=np.int64), span=(int(t5.min()), int(t5.max())))
    mid = plant_offsets(
        SYMS, 3, 0.01, np.array([T + 600_000 + H4 // 2], dtype=np.int64), span=(int(t5.min()), int(t5.max()))
    )
    np.testing.assert_allclose((mid - base)[:, 0], 0.01 * z * 0.5, atol=1e-13)


def test_planted_gross_return_difference_equals_a_times_z() -> None:
    panel = _panel(30)
    amp = 0.004
    plant = {"seed": 17, "amplitude": amp}
    planted = apply_plant(panel, plant)
    base = decision_samples(panel, _cfg(("noise_00",), noise_seed=1))
    pl = decision_samples(planted, _cfg(("planted_z",), plant=plant))
    assert len(base) == len(pl) > 100
    assert np.array_equal(base["T"].to_numpy(), pl["T"].to_numpy())
    assert np.array_equal(base["symbol"].to_numpy(), pl["symbol"].to_numpy())
    diff = pl["gross_log"].to_numpy() - base["gross_log"].to_numpy()
    idx = np.array([SYMS.index(s) for s in pl["symbol"]])
    z = plant_z(17, SYMS, pl["T"].to_numpy(dtype=np.int64))
    expect = amp * z[idx, np.arange(len(pl))]
    assert np.max(np.abs(diff - expect)) < 1e-12
    assert np.allclose(pl["planted_z"].to_numpy(), z[idx, np.arange(len(pl))], atol=1e-15)


def test_high_low_bounds_and_untouched_series() -> None:
    panel = _panel()
    planted = apply_plant(panel, {"seed": 2, "amplitude": 0.05})
    for s in SYMS:
        d = planted[s]["5m"]
        assert (d["h"] >= d[["o", "c"]].max(axis=1) - 1e-12).all()
        assert (d["l"] <= d[["o", "c"]].min(axis=1) + 1e-12).all()
        pd.testing.assert_series_equal(d["v"], panel[s]["5m"]["v"])
        pd.testing.assert_series_equal(d["tbv"], panel[s]["5m"]["tbv"])
        pd.testing.assert_frame_equal(planted[s]["settlements"], panel[s]["settlements"])
        pd.testing.assert_frame_equal(planted[s]["premium_5m"], panel[s]["premium_5m"])
        for iv in ("15m", "1h", "4h", "1d"):
            assert (planted[s][iv]["h"] >= planted[s][iv][["o", "c"]].max(axis=1) - 1e-12).all()
        assert not np.allclose(d["c"].to_numpy(), panel[s]["5m"]["c"].to_numpy())


def test_reaggregation_from_5m() -> None:
    panel = _panel()
    planted = apply_plant(panel, {"seed": 2, "amplitude": 0.02})
    s = SYMS[1]
    five = planted[s]["5m"]
    for iv, n in (("15m", 3), ("1h", 12), ("4h", 48), ("1d", 288)):
        b = planted[s][iv]
        m = len(b)
        assert m > 0
        o = five["o"].to_numpy()[: m * n].reshape(m, n)
        assert np.allclose(b["o"].to_numpy(), o[:, 0], rtol=1e-13)
        assert np.allclose(b["c"].to_numpy(), five["c"].to_numpy()[: m * n].reshape(m, n)[:, -1], rtol=1e-13)
        assert np.allclose(b["h"].to_numpy(), five["h"].to_numpy()[: m * n].reshape(m, n).max(axis=1), rtol=1e-13)
        assert np.allclose(b["l"].to_numpy(), five["l"].to_numpy()[: m * n].reshape(m, n).min(axis=1), rtol=1e-13)
        assert np.allclose(b["v"].to_numpy(), five["v"].to_numpy()[: m * n].reshape(m, n).sum(axis=1), rtol=1e-13)
        assert np.allclose(b["tbv"].to_numpy(), five["tbv"].to_numpy()[: m * n].reshape(m, n).sum(axis=1), rtol=1e-13)


def test_missing_5m_bar_drops_and_counts_higher_bars() -> None:
    panel = _panel()
    s = SYMS[0]
    five = panel[s]["5m"]
    gap_t = int(five["t"].iloc[100])  # inside 1h bar 8, 15m bar 33, 4h bar 2, 1d bar 0
    panel[s]["5m"] = five[five["t"] != gap_t].reset_index(drop=True)
    planted = apply_plant(panel, {"seed": 2, "amplitude": 0.01})
    iv_ms = {"15m": 900_000, "1h": 3_600_000, "4h": H4, "1d": 86_400_000}
    for iv, ms in iv_ms.items():
        assert (gap_t // ms) * ms not in set(planted[s][iv]["t"])
        assert planted.dropped[s][iv] == 1
    assert planted.dropped[SYMS[1]]["1d"] == 0


def test_apply_plant_does_not_mutate_input() -> None:
    panel = _panel()
    before = {s: panel[s]["5m"].copy() for s in SYMS}
    apply_plant(panel, {"seed": 1, "amplitude": 0.05})
    for s in SYMS:
        pd.testing.assert_frame_equal(panel[s]["5m"], before[s])


def test_noise_and_plant_streams_uncorrelated() -> None:
    t = np.arange(100_000, dtype=np.int64) * H4
    for sym_idx in (0, 3):
        a = hash_normal(NOISE_DOMAIN, 7, sym_idx, 0, t)
        b = plant_u(7, sym_idx, t)
        assert abs(np.corrcoef(a, b)[0, 1]) < 0.02


def _file_hashes(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def test_run_wf_applies_plant_and_leaves_dataset_unchanged(tmp_path: Path) -> None:
    n_days = 150
    cov = np.eye(6) * 4e-4 + 1e-4
    panel = synth_panel(cov, UNIVERSE[:6], START, START + n_days * 86_400_000, seed=3)
    ds = tmp_path / "ds"
    write_synthetic_dataset(panel, ds)
    before = _file_hashes(ds)
    cfg = {
        "id": "plant_run",
        "kind": "control",
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ["planted_z"],
        "interval": "4h",
        "h_ms": H4,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "first_refit_ms": 1680307200000,
        "seed": 7,
        "plant": {"seed": 5, "amplitude": 0.004},
    }
    f = tmp_path / "cfg.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    r = run_wf(f, ds, tmp_path / "out", commit="abc1234")
    assert r["plant"]["seed"] == 5 and r["plant"]["amplitude"] == 0.004
    assert r["plant"]["dropped_higher_bars"] == 0
    assert r["metrics"]["wf_mean"] > 0.0
    assert _file_hashes(ds) == before
    # the dataset on disk still loads to the unplanted panel
    again = load_panel(ds, UNIVERSE[:6])
    pd.testing.assert_frame_equal(again[UNIVERSE[0]]["5m"], panel[UNIVERSE[0]]["5m"])
