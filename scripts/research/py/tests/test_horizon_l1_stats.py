"""Unit tests for horizon.l1.stats: t_bound, bootstrap_bound, and describe."""

from __future__ import annotations

import math

import numpy as np
import pytest
import scipy.stats

from horizon.l1 import lock
from horizon.l1.stats import bootstrap_bound, describe, t_bound


def test_t_bound_known_array_formula() -> None:
    """t_bound on a known array matches mean - t.ppf(1 - alpha, n - 1) * s / sqrt(n)."""
    arr = np.array([0.02, 0.05, 0.03, 0.08, 0.04], dtype=np.float64)
    alpha = 0.01
    n = len(arr)
    mean_val = float(np.mean(arr))
    s = float(np.std(arr, ddof=1))
    crit = float(scipy.stats.t.ppf(1.0 - alpha, n - 1))
    expected = mean_val - crit * s / math.sqrt(n)

    actual = t_bound(arr, alpha=alpha)
    assert actual == pytest.approx(expected, rel=1e-12)

    assert math.isnan(t_bound(np.array([0.05]), alpha=alpha))
    assert math.isnan(t_bound(np.array([]), alpha=alpha))


def test_bootstrap_bound_constant_array() -> None:
    """bootstrap_bound on a constant array equals that constant value."""
    const_val = 0.042
    arr = np.full(20, const_val, dtype=np.float64)
    rng = np.random.default_rng(12345)
    bound = bootstrap_bound(arr, rng)
    assert bound == pytest.approx(const_val, rel=1e-12)


def test_bootstrap_bound_n_below_2_draw_consumption() -> None:
    """For n < 2 bootstrap_bound returns NaN and advances the generator by size=(resamples, 1)."""
    resamples = lock.BOOT_RESAMPLES

    # n = 0
    rng_a0 = np.random.default_rng(111)
    rng_b0 = np.random.default_rng(111)
    res0 = bootstrap_bound(np.array([]), rng_a0, resamples=resamples)
    assert math.isnan(res0)
    rng_b0.integers(0, 1, size=(resamples, 1))
    assert rng_a0.integers(0, 10**9) == rng_b0.integers(0, 10**9)

    # n = 1
    rng_a1 = np.random.default_rng(222)
    rng_b1 = np.random.default_rng(222)
    res1 = bootstrap_bound(np.array([0.05]), rng_a1, resamples=resamples)
    assert math.isnan(res1)
    rng_b1.integers(0, 1, size=(resamples, 1))
    assert rng_a1.integers(0, 10**9) == rng_b1.integers(0, 10**9)


def test_bootstrap_bound_independent_replay() -> None:
    """bootstrap_bound result equals an independent step-by-step replay."""
    seed = 20261114
    arr = np.array([0.01, -0.02, 0.03, 0.05, 0.02, -0.01], dtype=np.float64)
    resamples = 500
    alpha = 0.05

    rng_func = np.random.default_rng(seed)
    actual = bootstrap_bound(arr, rng_func, resamples=resamples, alpha=alpha)

    rng_replay = np.random.default_rng(seed)
    n = len(arr)
    idx = rng_replay.integers(0, n, size=(resamples, n))
    means = arr[idx].mean(axis=1)
    expected = float(np.quantile(means, alpha, method="linear"))

    assert actual == pytest.approx(expected, rel=1e-12)


def test_describe_cases() -> None:
    """describe on empty, one value, normal array, and zero-variance array."""
    # Empty
    d_empty = describe(np.array([]))
    assert d_empty["n"] == 0
    assert math.isnan(d_empty["mean"])
    assert math.isnan(d_empty["median"])
    assert math.isnan(d_empty["sd"])
    assert math.isnan(d_empty["share_positive"])
    assert math.isnan(d_empty["t"])

    # One value
    d_one = describe(np.array([5.5]))
    assert d_one["n"] == 1
    assert d_one["mean"] == 5.5
    assert d_one["median"] == 5.5
    assert math.isnan(d_one["sd"])
    assert d_one["share_positive"] == 1.0
    assert math.isnan(d_one["t"])

    # Normal array
    vals = np.array([1.0, 2.0, 3.0, 4.0])
    d_norm = describe(vals)
    assert d_norm["n"] == 4
    assert d_norm["mean"] == 2.5
    assert d_norm["median"] == 2.5
    expected_sd = float(np.std(vals, ddof=1))
    assert d_norm["sd"] == pytest.approx(expected_sd, rel=1e-12)
    assert d_norm["share_positive"] == 1.0
    expected_t = 2.5 / (expected_sd / math.sqrt(4))
    assert d_norm["t"] == pytest.approx(expected_t, rel=1e-12)

    # Zero-variance array
    vals_zero = np.array([3.0, 3.0, 3.0, 3.0])
    d_zero = describe(vals_zero)
    assert d_zero["n"] == 4
    assert d_zero["mean"] == 3.0
    assert d_zero["median"] == 3.0
    assert d_zero["sd"] == 0.0
    assert d_zero["share_positive"] == 1.0
    assert math.isnan(d_zero["t"])
