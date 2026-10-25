"""Tests for pure daily e-process calibration simulator."""

from __future__ import annotations

import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from r4.calibration_null import daily_eprocess, simulate_daily_null


def test_eprocess_warmup_and_31st_bet() -> None:
    """First 30 bets lambda zero, 31st on thirty x=0.5 gives lambda=0.5 and log_e=log(1.25)."""
    # 31 bets of 0.5
    x = np.full(31, 0.5, dtype=np.float64)
    res = daily_eprocess(x, threshold=600.0)

    assert res["n_bets"] == 31
    assert len(res["lambdas"]) == 31
    # First 30 bets must have lambda = 0
    np.testing.assert_array_equal(res["lambdas"][:30], np.zeros(30))
    # 31st bet (index 30) must have lambda = 0.5
    assert res["lambdas"][30] == pytest.approx(0.5, abs=1e-9)
    # log_e must equal log(1.25)
    assert res["log_e"] == pytest.approx(math.log(1.25), abs=1e-9)
    assert res["crossed_at"] is None
    assert res["ended"] is False


def test_eprocess_predictable_lambda_prefix() -> None:
    """Today's x cannot affect its own lambda; compare prefixes."""
    rng = np.random.default_rng(42)
    # 35 bets so warmup (30) is complete and m, v are non-trivial
    prefix = rng.uniform(-0.3, 0.4, size=35)

    arr_a = np.append(prefix, [0.8])
    arr_b = np.append(prefix, [-1.5])
    arr_c = np.append(prefix, [0.0])

    res_a = daily_eprocess(arr_a)
    res_b = daily_eprocess(arr_b)
    res_c = daily_eprocess(arr_c)

    # Bet at index 35 must be identical regardless of what value occurs at index 35
    assert res_a["lambdas"][35] == res_b["lambdas"][35] == res_c["lambdas"][35]
    assert np.all(res_a["lambdas"][:35] == res_b["lambdas"][:35])


def test_eprocess_nans_ignore_and_no_bet_cannot_cross() -> None:
    """NaNs do not warm up; a no-bet day cannot cross."""
    # 29 finite values interspersed with NaNs: total finite bets = 29 < 30
    x = np.array([0.5, np.nan, 0.5, np.nan] * 14 + [0.5, np.nan], dtype=np.float64)  # 29 finite, 29 NaNs
    res = daily_eprocess(x, threshold=600.0)

    assert res["n_bets"] == 29
    assert np.all(res["lambdas"] == 0.0)
    assert res["log_e"] == pytest.approx(0.0)
    assert res["crossed_at"] is None
    assert res["ended"] is False

    # A sequence of only NaNs does not warm up or cross
    all_nans = np.full(50, np.nan, dtype=np.float64)
    res_nans = daily_eprocess(all_nans)
    assert res_nans["n_bets"] == 0
    assert res_nans["log_e"] == pytest.approx(0.0)
    assert res_nans["crossed_at"] is None
    assert res_nans["ended"] is False


def test_eprocess_loss_below_minus_two_ends_test() -> None:
    """x below -2 ends the test even during warmup, later positives cannot validate."""
    # 10 bets of 0.1 during warmup, then x = -2.5 (< -2.0), followed by 50 bets of 1.0
    x = np.concatenate(
        [
            np.full(10, 0.1, dtype=np.float64),
            np.array([-2.5], dtype=np.float64),
            np.full(50, 1.0, dtype=np.float64),
        ]
    )

    # Threshold set low so that 50 bets of 1.0 would definitely cross if test had not ended
    res = daily_eprocess(x, threshold=1.5)

    assert res["ended"] is True
    assert res["crossed_at"] is None
    assert res.get("validated") is False
    # Ended test ceased betting
    assert res["n_bets"] == 11  # 10 + 1 ending bet
    # Subsequent observations have lambda == 0
    assert np.all(res["lambdas"][11:] == 0.0)


def test_simulation_counts_crossing_before_a_later_loss_floor(monkeypatch) -> None:
    """An anytime crossing remains in the false-crossing rate after a later loss."""

    class FixedPath:
        def standard_normal(self, shape):
            path = np.full(shape, 0.5)
            path[-1] = -3.0
            return path

    monkeypatch.setattr(np.random, "default_rng", lambda seed: FixedPath())
    result = simulate_daily_null(
        [[1.0]],
        [0.0],
        n_paths=1,
        n_days=40,
        scale=1.0,
        threshold=1.5,
    )
    assert result["ended_count"] == 1
    assert result["crossing_count"] == 1
    assert result["crossing_rate"] == 1.0
    assert result["validated_count"] == 0


def test_simulation_does_not_warm_up_on_the_initial_cash_day(monkeypatch) -> None:
    class FixedPath:
        def standard_normal(self, shape):
            return np.full(shape, 0.5)

    monkeypatch.setattr(np.random, "default_rng", lambda seed: FixedPath())
    result = simulate_daily_null(
        [[1.0]],
        [0.0],
        n_paths=1,
        n_days=31,
        scale=1.0,
        threshold=1.1,
    )
    assert result["crossing_count"] == 0


def test_small_negative_variance_is_not_a_valid_zero_variance_null() -> None:
    with pytest.raises(ValueError, match="positive semi-definite"):
        simulate_daily_null([[-1e-9]], [0.0], n_paths=1, scale=1.0)


def test_scaling_overflow_cannot_turn_a_terminal_loss_into_a_non_bet(monkeypatch) -> None:
    class FixedPath:
        def standard_normal(self, shape):
            path = np.full(shape, 0.5)
            path[-1] = -0.5
            return path

    monkeypatch.setattr(np.random, "default_rng", lambda seed: FixedPath())
    result = simulate_daily_null([[1.0]], [0.0], n_paths=1, n_days=60, scale=1e-310)
    assert result["crossing_count"] == 1
    assert result["ended_count"] == 1
    assert result["validated_count"] == 0


def test_simulate_daily_null_batch_independence_and_singular_cov() -> None:
    """Batching preserves results, singular PSD works, malformed covariance fails."""
    # Singular PSD covariance (rank 2 in 3D)
    v1 = np.array([0.02, 0.01, 0.0])
    v2 = np.array([0.0, 0.01, 0.02])
    cov = np.outer(v1, v1) + np.outer(v2, v2)
    betas = np.array([1.0, 0.9, 1.1])

    # Batch independence
    res16 = simulate_daily_null(cov, betas, n_paths=64, n_days=50, seed=123, scale=0.02, batch_size=16)
    res64 = simulate_daily_null(cov, betas, n_paths=64, n_days=50, seed=123, scale=0.02, batch_size=64)
    res7 = simulate_daily_null(cov, betas, n_paths=64, n_days=50, seed=123, scale=0.02, batch_size=7)

    assert res16["crossing_count"] == res64["crossing_count"] == res7["crossing_count"]
    assert res16["ended_count"] == res64["ended_count"] == res7["ended_count"]
    assert res16["wilson_95"] == res64["wilson_95"] == res7["wilson_95"]

    # Reject indefinite covariance (negative eigenvalue)
    indef_cov = np.array([[1.0, 2.0], [2.0, 1.0]])
    with pytest.raises(ValueError, match="positive semi-definite|eigenvalue"):
        simulate_daily_null(indef_cov, np.array([1.0, 1.0]), n_paths=10, scale=0.02)

    # Reject asymmetric covariance
    asym_cov = np.array([[1.0, 0.5], [0.1, 1.0]])
    with pytest.raises(ValueError, match="symmetric"):
        simulate_daily_null(asym_cov, np.array([1.0, 1.0]), n_paths=10, scale=0.02)

    # Reject dimension mismatch
    with pytest.raises(ValueError, match="dimension|match"):
        simulate_daily_null(cov, np.array([1.0, 1.0]), n_paths=10, scale=0.02)

    # Reject non-positive parameters
    with pytest.raises(ValueError, match="positive"):
        simulate_daily_null(cov, betas, n_paths=0, scale=0.02)
    with pytest.raises(ValueError, match="positive"):
        simulate_daily_null(cov, betas, n_paths=10, scale=-0.02)


def test_simulate_daily_null_practical_scale() -> None:
    """A representative batch run reports all requested paths and days."""
    cov = np.array([[0.0004, 0.0001], [0.0001, 0.0004]], dtype=np.float64)
    betas = np.array([1.0, 1.0], dtype=np.float64)

    res = simulate_daily_null(cov, betas, n_paths=5000, n_days=730, seed=42, scale=0.02, batch_size=512)

    assert res["parameters"]["n_paths"] == 5000
    assert res["parameters"]["n_days"] == 730
    assert 0 <= res["crossing_count"] <= 5000
    assert 0 <= res["ended_count"] <= 5000


def test_simulate_daily_null_matches_scalar_daily_eprocess() -> None:
    """Vectorized result equals scalar daily_eprocess on a small explicitly generated path set."""
    cov = np.array([[0.0004, 0.0002], [0.0002, 0.0005]], dtype=np.float64)
    betas = np.array([0.95, 1.05], dtype=np.float64)
    n_paths = 5
    n_days = 60
    seed = 20261025
    scale = 0.02

    sim = simulate_daily_null(cov, betas, n_paths=n_paths, n_days=n_days, seed=seed, scale=scale, batch_size=5)

    # Reconstruct the paths exactly as simulate_daily_null does
    evals, evecs = np.linalg.eigh(cov)
    evals = np.maximum(evals, 0.0)
    l_factor = evecs * np.sqrt(evals)

    ss = np.random.SeedSequence(seed)
    child_seeds = ss.spawn(n_paths)

    scalar_crossings = 0
    scalar_ended = 0

    for p in range(n_paths):
        rng = np.random.default_rng(child_seeds[p])
        z = rng.standard_normal((n_days, 2))
        r = z @ l_factor.T  # (n_days, 2)

        # Portfolio returns
        w = np.zeros_like(r)
        w[1:] = np.sign(r[:-1]) / 2.0

        mean_r = np.mean(r, axis=-1, keepdims=True)
        excess_r = r - betas * mean_r
        d = np.sum(w * excess_r, axis=-1)
        x = np.minimum(d / scale, 1.0)
        x[~np.any(w != 0.0, axis=-1)] = np.nan

        scalar_res = daily_eprocess(x, threshold=600.0)
        if scalar_res["crossed_at"] is not None:
            scalar_crossings += 1
        if scalar_res["ended"]:
            scalar_ended += 1

    assert sim["crossing_count"] == scalar_crossings
    assert sim["ended_count"] == scalar_ended


def test_cli_temp_input_output_hashes_and_reproducibility(tmp_path: Path) -> None:
    """CLI temp input/output with strict hashes and reproducibility."""
    cov = [[0.0004, 0.0001], [0.0001, 0.0004]]
    betas = [1.0, 1.0]
    scale = 0.02
    input_payload = {
        "covariance": cov,
        "betas": betas,
        "scale": scale,
    }

    input_file = tmp_path / "input.json"
    out_file1 = tmp_path / "out1.json"
    out_file2 = tmp_path / "out2.json"

    input_bytes = json.dumps(input_payload).encode("utf-8")
    input_file.write_bytes(input_bytes)
    expected_sha256 = hashlib.sha256(input_bytes).hexdigest()

    import os

    py_root = str(Path(__file__).resolve().parent.parent)
    env = {**os.environ, "PYTHONPATH": py_root}

    # Run CLI
    cmd = [
        sys.executable,
        "-m",
        "r4.calibration_null",
        "--input",
        str(input_file),
        "--paths",
        "50",
        "--days",
        "100",
        "--seed",
        "20261025",
        "--batch-size",
        "16",
        "--out",
        str(out_file1),
    ]
    res1 = subprocess.run(cmd, capture_output=True, text=True, check=True, env=env)
    assert res1.returncode == 0

    assert out_file1.exists()
    out1_data = json.loads(out_file1.read_text(encoding="utf-8"))

    # Strict hash check
    assert out1_data["input_sha256"] == expected_sha256
    assert out1_data["parameters"]["n_paths"] == 50
    assert out1_data["parameters"]["n_days"] == 100
    assert out1_data["nominal_bound"] == pytest.approx(1.0 / 600.0)
    assert "assumptions" in out1_data
    assert "simplified daily book" in out1_data["assumptions"].lower()

    # Reproducibility run
    cmd[cmd.index(str(out_file1))] = str(out_file2)
    res2 = subprocess.run(cmd, capture_output=True, text=True, check=True, env=env)
    assert res2.returncode == 0
    assert out_file1.read_bytes() == out_file2.read_bytes()

    # Reject non-finite in input
    bad_input_file = tmp_path / "bad_input.json"
    bad_input_file.write_text(json.dumps({"covariance": [[None, 0.0], [0.0, 1.0]], "betas": [1.0, 1.0], "scale": 0.02}))
    bad_out = tmp_path / "bad_out.json"
    res_bad = subprocess.run(
        [
            sys.executable,
            "-m",
            "r4.calibration_null",
            "--input",
            str(bad_input_file),
            "--paths",
            "10",
            "--out",
            str(bad_out),
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert res_bad.returncode != 0
