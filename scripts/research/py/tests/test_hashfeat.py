"""Tests for r4.hashfeat and the hash-feature hook (and fast path) of pipeline.decision_samples."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from scipy.stats import kstest, norm

import r4.pipeline as pipeline
from r4.hashfeat import (
    NOISE_DOMAIN,
    hash_feature_matrix,
    hash_normal,
    is_hash_feature,
    normal_from_hash,
    splitmix64,
)
from r4.method import UNIVERSE
from r4.pipeline import RunConfig, decision_samples
from tests.test_cli_bar import _make_fast_synthetic_panel

M64 = (1 << 64) - 1


def _splitmix_ref(x: int) -> int:
    x = (x + 0x9E3779B97F4A7C15) & M64
    z = x
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & M64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & M64
    return z ^ (z >> 31)


def _cfg(features: tuple[str, ...], **kw) -> RunConfig:
    base = {
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": features,
        "interval": "1h",
        "h_ms": 14_400_000,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
    }
    base.update(kw)
    return RunConfig(**base)


def test_splitmix64_matches_reference() -> None:
    xs = [0, 1, 12345, M64, 0x123456789ABCDEF0]
    got = splitmix64(np.array(xs, dtype=np.uint64))
    assert [int(g) for g in got] == [_splitmix_ref(x) for x in xs]


def test_uniform_strictly_inside_unit_interval() -> None:
    z = normal_from_hash(np.array([0, M64, 1 << 63], dtype=np.uint64))
    assert np.all(np.isfinite(z))
    assert z[0] < -7.0 and z[1] > 7.0 and abs(z[2]) < 1e-6


def test_hash_normal_deterministic_and_separated() -> None:
    t = np.arange(0, 3_600_000 * 2000, 3_600_000, dtype=np.int64)
    a = hash_normal(NOISE_DOMAIN, 5, 2, 7, t)
    assert np.array_equal(a, hash_normal(NOISE_DOMAIN, 5, 2, 7, t))
    for other in (
        hash_normal(NOISE_DOMAIN, 6, 2, 7, t),
        hash_normal(NOISE_DOMAIN, 5, 3, 7, t),
        hash_normal(NOISE_DOMAIN, 5, 2, 8, t),
    ):
        assert not np.array_equal(a, other)
        assert abs(np.corrcoef(a, other)[0, 1]) < 0.1


def test_hash_normal_is_standard_normal() -> None:
    t = np.arange(100_000, dtype=np.int64) * 60_000
    x = hash_normal(NOISE_DOMAIN, 1, 0, 0, t)
    assert abs(x.mean()) < 0.02
    assert abs(x.std() - 1.0) < 0.02
    assert kstest(x, norm.cdf).pvalue > 0.001


def test_is_hash_feature() -> None:
    assert is_hash_feature("noise_00") and is_hash_feature("noise_99") and is_hash_feature("planted_z")
    assert not is_hash_feature("noise_100") and not is_hash_feature("noise_5") and not is_hash_feature("ret_1")


def test_noise_feature_requires_noise_seed() -> None:
    with pytest.raises(ValueError, match="noise_seed"):
        _cfg(("noise_00",))
    assert _cfg(("noise_00",), noise_seed=3).noise_seed == 3


def test_planted_z_requires_plant() -> None:
    with pytest.raises(ValueError, match="plant"):
        _cfg(("planted_z",))


def test_decision_samples_noise_values_match_hash() -> None:
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:3], n_days=20, seed=1)
    cfg = _cfg(("noise_00", "noise_07"), noise_seed=11)
    s = decision_samples(panel, cfg)
    assert len(s) > 0
    for sym in UNIVERSE[:3]:
        sub = s[s["symbol"] == sym]
        idx = UNIVERSE.index(sym)
        t = sub["T"].to_numpy(dtype=np.int64)
        assert np.array_equal(sub["noise_00"].to_numpy(), hash_normal(NOISE_DOMAIN, 11, idx, 0, t))
        assert np.array_equal(sub["noise_07"].to_numpy(), hash_normal(NOISE_DOMAIN, 11, idx, 7, t))


def test_hash_feature_matrix_columns() -> None:
    t = np.arange(10, dtype=np.int64) * 3_600_000
    m = hash_feature_matrix(("noise_03", "noise_04"), "ETHUSDT", UNIVERSE[:3], t, noise_seed=2, plant=None)
    assert m.shape == (10, 2)
    assert np.array_equal(m[:, 1], hash_normal(NOISE_DOMAIN, 2, 1, 4, t))


def test_fast_path_skips_feature_frame_and_matches_slow(monkeypatch: pytest.MonkeyPatch) -> None:
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:4], n_days=25, seed=3)
    cfg = _cfg(("noise_00", "noise_01", "noise_02"), noise_seed=9)

    real = pipeline.build_feature_frame
    calls = {"n": 0}

    def spy(*a, **k):
        calls["n"] += 1
        return real(*a, **k)

    monkeypatch.setattr(pipeline, "build_feature_frame", spy)
    fast = decision_samples(panel, cfg)
    assert calls["n"] == 0

    monkeypatch.setattr(pipeline, "_FORCE_SLOW_PATH", True)
    slow = decision_samples(panel, cfg)
    assert calls["n"] == len(panel)

    pd.testing.assert_frame_equal(fast, slow)
    assert fast.attrs["n_dropped"] == slow.attrs["n_dropped"]
    assert not fast[["noise_00", "noise_01", "noise_02"]].isna().any().any()


def test_mixed_features_use_feature_frame_and_drop_nan_rows() -> None:
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:3], n_days=40, seed=4)
    mixed = decision_samples(panel, _cfg(("ret_1", "noise_00"), noise_seed=1))
    plain = decision_samples(panel, _cfg(("ret_1",)))
    assert len(mixed) == len(plain) > 0
    assert list(mixed.columns[2:4]) == ["ret_1", "noise_00"]
    assert np.array_equal(mixed["ret_1"].to_numpy(), plain["ret_1"].to_numpy())
    fast = decision_samples(panel, _cfg(("noise_00",), noise_seed=1))
    assert len(fast) >= len(mixed)
