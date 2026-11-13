"""Tests for horizon-e1 stats.py (rules 8 to 10)."""

from __future__ import annotations

import math
import statistics

import numpy as np
import pytest
import scipy.stats

from horizon.e1 import lock
from horizon.e1.stats import (
    Unit,
    bootstrap_bound,
    describe,
    judge_trial,
    leave_one_out_min,
    make_clusters,
    t_bound,
)


def test_make_clusters() -> None:
    """Three chained units form one cluster; units beyond gap form two; mixed classes raise."""
    h_ms = lock.HOUR_MS
    # Three units at 0 h, 20 h and 41 h chain into ONE cluster (each within 24 h of its predecessor)
    units_chain = [
        Unit(cls=lock.CLASS_T, code="code_1", entry_ms=0, value=0.03, n_tokens=1),
        Unit(cls=lock.CLASS_T, code="code_2", entry_ms=20 * h_ms, value=0.06, n_tokens=1),
        Unit(cls=lock.CLASS_T, code="code_3", entry_ms=41 * h_ms, value=0.09, n_tokens=1),
    ]
    clusters_1 = make_clusters(units_chain, gap_hours=24)
    assert len(clusters_1) == 1
    c1 = clusters_1[0]
    assert c1.cls == lock.CLASS_T
    assert c1.entry_ms == 0
    assert math.isclose(c1.value, 0.06, rel_tol=1e-12)
    assert c1.codes == ("code_1", "code_2", "code_3")

    # Units at 0 h and 25 h are two clusters
    units_split = [
        Unit(cls=lock.CLASS_T, code="code_a", entry_ms=0, value=0.04, n_tokens=1),
        Unit(cls=lock.CLASS_T, code="code_b", entry_ms=25 * h_ms, value=0.08, n_tokens=1),
    ]
    clusters_2 = make_clusters(units_split, gap_hours=24)
    assert len(clusters_2) == 2
    assert clusters_2[0].entry_ms == 0
    assert math.isclose(clusters_2[0].value, 0.04, rel_tol=1e-12)
    assert clusters_2[0].codes == ("code_a",)
    assert clusters_2[1].entry_ms == 25 * h_ms
    assert math.isclose(clusters_2[1].value, 0.08, rel_tol=1e-12)
    assert clusters_2[1].codes == ("code_b",)

    # Empty units returns empty list
    assert make_clusters([]) == []

    # Mixed classes raise ValueError
    mixed = [
        Unit(cls=lock.CLASS_T, code="c_t", entry_ms=0, value=0.05, n_tokens=1),
        Unit(cls=lock.CLASS_D, code="c_d", entry_ms=1000, value=0.05, n_tokens=1),
    ]
    with pytest.raises(ValueError):
        make_clusters(mixed)


def test_leave_one_out_min() -> None:
    """LOO min on [1, 2, 3, 10] is 2.0 (drop 10: mean of 1, 2, 3), and NaN for n < 2."""
    arr = np.array([1.0, 2.0, 3.0, 10.0])
    assert math.isclose(leave_one_out_min(arr), 2.0, rel_tol=1e-12)

    assert math.isnan(leave_one_out_min(np.array([5.0])))
    assert math.isnan(leave_one_out_min(np.array([])))


def test_t_bound() -> None:
    """t_bound for [0.04, 0.06, 0.05, 0.07] matches hand-computed scipy expectation."""
    vals = [0.04, 0.06, 0.05, 0.07]
    alpha = 0.0125
    m = statistics.mean(vals)
    s = statistics.stdev(vals)
    crit = float(scipy.stats.t.ppf(1.0 - alpha, len(vals) - 1))
    expected = m - crit * s / math.sqrt(len(vals))

    tb = t_bound(np.array(vals), alpha=alpha)
    assert math.isclose(tb, expected, rel_tol=1e-12)

    assert math.isnan(t_bound(np.array([0.05]), alpha=alpha))
    assert math.isnan(t_bound(np.array([]), alpha=alpha))


def test_bootstrap_bound() -> None:
    """Bootstrap bound reproducibility, lower bound property, constant array, and n < 2 draw advancing."""
    arr = np.array([0.01, 0.03, 0.05, 0.07, 0.09])
    seed = 20261114
    rng1 = np.random.default_rng(seed)
    rng2 = np.random.default_rng(seed)

    b1 = bootstrap_bound(arr, rng1)
    b2 = bootstrap_bound(arr, rng2)
    assert b1 == b2
    assert b1 < float(np.mean(arr))

    # Constant array has identical bound
    const_arr = np.full(10, 0.05)
    b_const = bootstrap_bound(const_arr, np.random.default_rng(12345))
    assert math.isclose(b_const, 0.05, rel_tol=1e-12)

    # For n < 2, returns NaN and advances rng identically to size=(resamples, 1)
    rng_a = np.random.default_rng(999)
    rng_b = np.random.default_rng(999)
    res_nan1 = bootstrap_bound(np.array([0.05]), rng_a)
    res_nan0 = bootstrap_bound(np.array([]), rng_b)
    assert math.isnan(res_nan1)
    assert math.isnan(res_nan0)
    assert rng_a.integers(0, 1000) == rng_b.integers(0, 1000)


def test_judge_trial() -> None:
    """Hand-built cases where each clause fails alone, all pass, or bound is NaN."""
    rng = np.random.default_rng(lock.BOOT_SEED)

    # All pass: 12 clusters with values 0.05 to 0.07
    vals_pass = np.array([0.05, 0.06, 0.07, 0.055, 0.065, 0.058, 0.062, 0.051, 0.069, 0.053, 0.067, 0.059])
    j_pass = judge_trial("T-4h", vals_pass, 0.05, rng)
    assert j_pass.clause_a
    assert j_pass.clause_b
    assert j_pass.clause_c
    assert j_pass.clause_d
    assert j_pass.clause_e
    assert j_pass.passed

    # Fails clause_a alone: mean 0.019 (< lock.PASS_MIN_MEAN = 0.02)
    vals_a = np.full(12, 0.019)
    j_a = judge_trial("T-4h", vals_a, 0.05, rng)
    assert not j_a.clause_a
    assert j_a.clause_b
    assert j_a.clause_c
    assert j_a.clause_d
    assert j_a.clause_e
    assert not j_a.passed

    # Fails clause_b alone: bound below zero
    vals_b = np.array([0.05, -0.08, 0.06, -0.07, 0.05, 0.06, -0.05, 0.07, 0.04, -0.06, 0.05, 0.08])
    j_b = judge_trial("T-4h", vals_b, 0.05, rng)
    assert not j_b.clause_b
    assert not j_b.passed

    # Fails clause_c alone: dominated by one outlier
    vals_c = np.array([0.005] * 11 + [0.30])
    j_c = judge_trial("T-4h", vals_c, 0.05, rng)
    assert not j_c.clause_c
    assert not j_c.passed

    # Fails clause_d alone: 9 values (< lock.MIN_CLUSTERS = 10)
    vals_d = np.full(9, 0.06)
    j_d = judge_trial("T-4h", vals_d, 0.05, rng)
    assert not j_d.clause_d
    assert not j_d.passed

    # Fails clause_e alone: excluded share 0.11 (> lock.MAX_EXCLUDED_SHARE = 0.10)
    vals_e = np.full(12, 0.06)
    j_e = judge_trial("T-4h", vals_e, 0.11, rng)
    assert not j_e.clause_e
    assert not j_e.passed

    # Bound is NaN (n < 2) -> passed is False
    j_nan = judge_trial("T-4h", np.array([0.05]), 0.05, rng)
    assert math.isnan(j_nan.bound)
    assert not j_nan.passed


def test_describe() -> None:
    """describe on [1, 2, 3, 4] matches hand-computed values exactly."""
    vals = np.array([1.0, 2.0, 3.0, 4.0])
    d = describe(vals)
    assert d["n"] == 4
    assert d["mean"] == 2.5
    assert d["median"] == 2.5
    assert math.isclose(d["sd"], 1.2909944487358056, rel_tol=1e-12)
    assert d["share_positive"] == 1.0
    expected_t = 2.5 / (1.2909944487358056 / 2.0)
    assert math.isclose(d["t"], expected_t, rel_tol=1e-12)

    # Empty array
    d_empty = describe(np.array([]))
    assert d_empty["n"] == 0
    assert math.isnan(d_empty["mean"])

    # Single value
    d_one = describe(np.array([5.0]))
    assert d_one["n"] == 1
    assert d_one["mean"] == 5.0
    assert math.isnan(d_one["sd"])
    assert math.isnan(d_one["t"])
