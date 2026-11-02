"""Tests for r4.synth: the D-shaped synthetic panel and its on-disk dataset."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import kurtosis

from r4.cli import run_wf
from r4.data import verify_manifest
from r4.method import UNIVERSE
from r4.pipeline import load_panel
from r4.synth import synth_panel, write_synthetic_dataset

DAY = 86_400_000
START = 1672531200000  # 2023-01-01 UTC


def _cov(k: int) -> np.ndarray:
    vol = np.linspace(0.02, 0.04, k)
    corr = np.full((k, k), 0.6) + 0.4 * np.eye(k)
    return corr * np.outer(vol, vol)


def test_panel_format_and_alignment() -> None:
    syms = UNIVERSE[:3]
    p = synth_panel(_cov(3), syms, START, START + 10 * DAY, seed=1)
    assert list(p) == list(syms)
    d = p[syms[0]]
    assert {"5m", "15m", "1h", "4h", "1d", "premium_5m", "premiumIndex", "settlements", "funding"} <= set(d)
    assert len(d["5m"]) == 10 * 288 and len(d["15m"]) == 10 * 96 and len(d["1h"]) == 240
    assert len(d["4h"]) == 60 and len(d["1d"]) == 10
    assert int(d["5m"]["t"].iloc[0]) == START and int(d["5m"]["t"].iloc[-1]) == START + 10 * DAY - 300_000
    assert (d["5m"]["o"].iloc[1:].to_numpy() == d["5m"]["c"].iloc[:-1].to_numpy()).all()
    assert (d["5m"]["h"] >= d["5m"][["o", "c"]].max(axis=1)).all()
    assert (d["5m"]["l"] <= d["5m"][["o", "c"]].min(axis=1)).all()
    assert np.allclose(d["1d"]["v"], d["5m"]["v"].to_numpy().reshape(10, 288).sum(axis=1))
    assert np.allclose(d["1h"]["tbv"], d["5m"]["tbv"].to_numpy().reshape(240, 12).sum(axis=1))
    share = (d["5m"]["tbv"] / d["5m"]["v"]).mean()
    assert abs(share - 0.5) < 0.01
    assert len(d["settlements"]) == 30 and (d["settlements"]["rate"] == 0).all()
    assert (d["settlements"]["t"] % (8 * 3_600_000) == 0).all()
    assert len(d["premium_5m"]) == 10 * 288 and (d["premium_5m"]["c"] == 0).all()


def test_daily_covariance_within_10_percent() -> None:
    k = 3
    cov = _cov(k)
    n_days = 8000
    p = synth_panel(cov, UNIVERSE[:k], START, START + n_days * DAY, seed=2)
    closes = np.column_stack([np.log(p[s]["5m"]["c"].to_numpy())[287::288] for s in UNIVERSE[:k]])
    daily = np.diff(np.vstack([np.full(k, np.log(100.0)), closes]), axis=0)
    sample = daily.T @ daily / n_days
    err = np.linalg.norm(sample - cov) / np.linalg.norm(cov)
    assert err < 0.10, err


def test_fat_tails_and_vol_clustering() -> None:
    n_days = 1500
    p = synth_panel(_cov(2), UNIVERSE[:2], START, START + n_days * DAY, seed=3)
    c = np.log(p[UNIVERSE[0]]["5m"]["c"].to_numpy())
    r5 = np.diff(c)
    assert kurtosis(r5, fisher=False) > 3.0
    daily = np.diff(c[287::288])
    sq = daily**2
    ac1 = np.corrcoef(sq[:-1], sq[1:])[0, 1]
    assert ac1 > 0.0


def test_fixed_seed_reproduces_identical_bytes(tmp_path: Path) -> None:
    syms = UNIVERSE[:3]
    for name, seed in (("a", 9), ("b", 9), ("c", 10)):
        write_synthetic_dataset(synth_panel(_cov(3), syms, START, START + 6 * DAY, seed=seed), tmp_path / name)
    files = sorted(p.relative_to(tmp_path / "a") for p in (tmp_path / "a").rglob("*") if p.is_file())
    assert files
    for f in files:
        assert (tmp_path / "a" / f).read_bytes() == (tmp_path / "b" / f).read_bytes()
    assert (tmp_path / "a" / "manifest.json").read_bytes() != (tmp_path / "c" / "manifest.json").read_bytes()


def test_written_dataset_verifies_and_round_trips(tmp_path: Path) -> None:
    syms = UNIVERSE[:3]
    p = synth_panel(_cov(3), syms, START, START + 6 * DAY, seed=4)
    write_synthetic_dataset(p, tmp_path / "ds")
    ok, bad = verify_manifest(tmp_path / "ds")
    assert ok, bad
    m = json.loads((tmp_path / "ds" / "manifest.json").read_text())
    assert m["symbols"] == list(syms) and m["datasetHash"]
    q = load_panel(tmp_path / "ds", syms)
    for s in syms:
        for key in ("5m", "15m", "1h", "4h", "1d"):
            pd.testing.assert_frame_equal(q[s][key], p[s][key], check_dtype=False)
        assert len(q[s]["settlements"]) == len(p[s]["settlements"])
        assert len(q[s]["premium_5m"]) == len(p[s]["premium_5m"])


def test_run_wf_end_to_end_on_written_dataset(tmp_path: Path) -> None:
    syms = UNIVERSE[:6]
    p = synth_panel(_cov(6), syms, START, START + 130 * DAY, seed=5)
    ds = write_synthetic_dataset(p, tmp_path / "ds")
    cfg = {
        "id": "synth_run",
        "kind": "trial",
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ["ret_1", "ret_4"],
        "interval": "1h",
        "h_ms": 14_400_000,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0001,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "first_refit_ms": 1680307200000,
        "seed": 7,
    }
    f = tmp_path / "cfg.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    r = run_wf(f, ds, tmp_path / "out", commit="abc1234")
    assert r["metrics"]["n_samples"] > 1000
    assert r["metrics"]["n_days"] > 30
    assert np.isfinite(r["metrics"]["wf_mean"])
