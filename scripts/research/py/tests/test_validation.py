"""Tests for r4.validation module."""

from __future__ import annotations

from datetime import UTC, datetime

import numpy as np
import pytest
from skfolio.model_selection import CombinatorialPurgedCV

from r4.validation import (
    assign_groups,
    cpcv_path_ids,
    cpcv_paths,
    cpcv_splits,
    purge_and_embargo,
    walk_forward_splits,
)


def test_assign_groups_remainder():
    """Requirement 1: assign_groups(603, 6) gives sizes [100, 100, 100, 100, 100, 103]."""
    groups = assign_groups(603, 6)
    assert len(groups) == 6
    assert [len(g) for g in groups] == [100, 100, 100, 100, 100, 103]
    # Check that indices partition 0..602 contiguously
    all_indices = np.concatenate(groups)
    assert np.array_equal(all_indices, np.arange(603))


@pytest.mark.parametrize("n", [600, 603])
def test_cpcv_splits_no_overlap_oracle(n: int):
    """Requirement 2: With t1 = t0 (no overlap) and embargo_ms = 0, splits match skfolio."""
    h_ms = 3600000
    t0 = np.arange(n, dtype=np.int64) * h_ms
    t1 = t0.copy()

    cv = CombinatorialPurgedCV(n_folds=6, n_test_folds=2, purged_size=0, embargo_size=0)
    x = np.zeros((n, 1))

    our_splits = list(cpcv_splits(t0, t1, n_groups=6, n_test_groups=2, embargo_ms=0))
    skfolio_splits = list(cv.split(x))

    assert len(our_splits) == len(skfolio_splits) == 15

    for split_idx, ((our_train, our_tests), (sk_train, sk_tests)) in enumerate(
        zip(our_splits, skfolio_splits, strict=True)
    ):
        assert np.array_equal(our_train, sk_train), f"Train mismatch in split {split_idx}"
        assert len(our_tests) == len(sk_tests)
        for g_idx, (our_g, sk_g) in enumerate(zip(our_tests, sk_tests, strict=True)):
            assert np.array_equal(our_g, sk_g), f"Test group {g_idx} mismatch in split {split_idx}"


# Derivation of oracle equality with skfolio CombinatorialPurgedCV:
# Why this holds (observed by Claude on skfolio 1.8.1, 2026-10-25): skfolio treats adjacent test groups
# as one contiguous region. Around each region it removes purged_size samples before it and
# purged_size + embargo_size samples after it. For test groups 2 and 3 (indices 200 to 399) with
# p = 4 and e = 6 it removed 196 to 199 and 400 to 409.
#
# Our definitions give the same for a block [a, b]:
# - the purge removes j in [a - h, b + h], because j*H <= (b+h)*H and (j+h)*H >= a*H;
# - the embargo removes j in [b + h + 1, b + h + e].
# - Between two adjacent test groups, everything removed is a test sample anyway.
@pytest.mark.parametrize("n", [600, 603])
@pytest.mark.parametrize("h,e", [(4, 6), (8, 24), (1, 0)])
def test_cpcv_splits_oracle_equality_with_horizon(n: int, h: int, e: int):
    """Requirement 3: Exact oracle equality with skfolio with label horizon and embargo."""
    h_ms = 3600000
    t0 = np.arange(n, dtype=np.int64) * h_ms
    t1 = t0 + h * h_ms
    embargo_ms = e * h_ms

    cv = CombinatorialPurgedCV(n_folds=6, n_test_folds=2, purged_size=h, embargo_size=e)
    x = np.zeros((n, 1))

    our_splits = list(cpcv_splits(t0, t1, n_groups=6, n_test_groups=2, embargo_ms=embargo_ms))
    skfolio_splits = list(cv.split(x))

    assert len(our_splits) == len(skfolio_splits) == 15

    for split_idx, ((our_train, our_tests), (sk_train, sk_tests)) in enumerate(
        zip(our_splits, skfolio_splits, strict=True)
    ):
        assert len(our_tests) == len(sk_tests)
        for g_idx, (our_g, sk_g) in enumerate(zip(our_tests, sk_tests, strict=True)):
            assert np.array_equal(our_g, sk_g), (
                f"Test group mismatch at split {split_idx}, group {g_idx} (n={n}, h={h}, e={e})"
            )
        assert np.array_equal(our_train, sk_train), f"Train mismatch at split {split_idx} (n={n}, h={h}, e={e})"


def test_cpcv_path_ids():
    """Requirement 4: cpcv_path_ids(6, 2) equals skfolio get_path_ids() and pinned array."""
    expected = np.array(
        [
            [0, 0],
            [1, 0],
            [2, 0],
            [3, 0],
            [4, 0],
            [1, 1],
            [2, 1],
            [3, 1],
            [4, 1],
            [2, 2],
            [3, 2],
            [4, 2],
            [3, 3],
            [4, 3],
            [4, 4],
        ],
        dtype=int,
    )
    pids = cpcv_path_ids(6, 2)
    assert np.array_equal(pids, expected)

    cv = CombinatorialPurgedCV(n_folds=6, n_test_folds=2)
    assert np.array_equal(pids, cv.get_path_ids())


def test_cpcv_paths_covers_all_samples():
    """Requirement 5: cpcv_paths gives 5 paths, each covering all samples once."""
    n = 600
    h_ms = 3600000
    t0 = np.arange(n, dtype=np.int64) * h_ms
    t1 = t0.copy()

    splits = list(cpcv_splits(t0, t1, n_groups=6, n_test_groups=2, embargo_ms=0))
    test_groups_by_split = [tests for _, tests in splits]
    path_ids = cpcv_path_ids(6, 2)

    # Predict the sample index itself for each test sample
    predictions_by_split = [[g.copy().astype(float) for g in tg] for tg in test_groups_by_split]

    paths = cpcv_paths(predictions_by_split, path_ids, test_groups_by_split)

    assert paths.shape == (5, n)
    # Every path must reconstruct the identity sequence 0..n-1 exactly once in sample order
    for p in range(5):
        assert np.array_equal(paths[p], np.arange(n, dtype=float))


def test_purge_hand_built():
    """Requirement 6: Purge on a hand-built example with exact boundaries."""
    t0 = np.array([100, 200, 300, 400, 500, 600])
    t1 = np.array([150, 399, 400, 450, 550, 650])
    # Test block is index 3: span [400, 450]
    test_block = np.array([3])
    candidate_train = np.array([0, 1, 2, 4, 5])

    # Sample 1 ends at 399 (block_start - 1) -> must be kept
    # Sample 2 ends at 400 (block_start) -> must be removed
    # Sample 4 has t0 = 500, t1 = 550 (overlaps [400, 450] ? no, t0 > block_end) -> kept
    filtered = purge_and_embargo(candidate_train, t0, t1, [test_block], embargo_ms=0)
    assert 1 in filtered
    assert 2 not in filtered
    assert np.array_equal(filtered, np.array([0, 1, 4, 5]))


def test_embargo_hand_built():
    """Requirement 7: Embargo on a hand-built example at the exact boundary."""
    # Test block at index 1: t0 = 100, t1 = 200. block_end = 200.
    # Embargo ms = 50. Embargo span: (200, 250].
    t0 = np.array([50, 100, 201, 250, 251])
    t1 = np.array([80, 200, 260, 290, 300])
    test_block = np.array([1])
    candidate_train = np.array([0, 2, 3, 4])

    # Sample 2 (t0 = 201): 200 < 201 <= 250 -> embargoed (removed)
    # Sample 3 (t0 = 250): 200 < 250 <= 250 -> embargoed (removed)
    # Sample 4 (t0 = 251): 251 > 250 -> kept
    filtered = purge_and_embargo(candidate_train, t0, t1, [test_block], embargo_ms=50)
    assert np.array_equal(filtered, np.array([0, 4]))


def test_walk_forward_three_months_hourly():
    """Requirement 8: Walk-forward on 3 months of hourly samples with h = 8 hours."""
    hour_ms = 3600 * 1000
    h_ms = 8 * hour_ms
    lookback_ms = 30 * 24 * hour_ms

    refit_1 = int(datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC).timestamp()) * 1000
    refit_2 = int(datetime(2024, 2, 1, 0, 0, 0, tzinfo=UTC).timestamp()) * 1000
    refit_3 = int(datetime(2024, 3, 1, 0, 0, 0, tzinfo=UTC).timestamp()) * 1000
    end_ms = int(datetime(2024, 4, 1, 0, 0, 0, tzinfo=UTC).timestamp()) * 1000

    # Provide training data starting 45 days before the first refit
    samples_start_ms = refit_1 - 45 * 24 * hour_ms
    t0 = np.arange(samples_start_ms, end_ms, hour_ms, dtype=np.int64)
    t1 = t0 + h_ms

    splits = list(
        walk_forward_splits(
            t0,
            t1,
            start_ms=refit_1,
            end_ms=end_ms,
            refit="monthly",
            lookback_ms=lookback_ms,
            embargo_ms=0,
        )
    )

    # 1. Three folds, with refit times at the month starts
    assert len(splits) == 3
    refits = [s[0] for s in splits]
    assert refits == [refit_1, refit_2, refit_3]

    for refit, train, test in splits:
        assert len(train) > 0
        assert len(test) > 0
        # 2. No training sample has t1 >= refit
        assert np.all(t1[train] < refit)
        # 3. With a 30-day lookback, no training sample is older than 30 days before refit
        assert np.all(t0[train] >= refit - lookback_ms)

    # 4. Test blocks partition the samples after the first refit
    all_tests = np.concatenate([s[2] for s in splits])
    assert len(all_tests) == len(np.unique(all_tests))
    expected_test_indices = np.flatnonzero((t0 >= refit_1) & (t0 < end_ms))
    assert np.array_equal(all_tests, expected_test_indices)


def test_invalid_inputs_raise_value_error():
    """Requirement 9: Inputs with unsorted t0, or t1 < t0, raise ValueError."""
    # Unsorted t0
    t0_unsorted = np.array([100, 50, 200])
    t1_valid = np.array([150, 100, 250])

    with pytest.raises(ValueError, match="sorted ascending"):
        purge_and_embargo(np.array([0, 1]), t0_unsorted, t1_valid, [np.array([2])])

    with pytest.raises(ValueError, match="sorted ascending"):
        list(cpcv_splits(t0_unsorted, t1_valid, n_groups=3, n_test_groups=1))

    with pytest.raises(ValueError, match="sorted ascending"):
        list(walk_forward_splits(t0_unsorted, t1_valid, start_ms=0, end_ms=300))

    # t1 < t0
    t0_valid = np.array([100, 200, 300])
    t1_invalid = np.array([150, 180, 350])  # index 1 has t1 (180) < t0 (200)

    with pytest.raises(ValueError, match="t1 must be >= t0"):
        purge_and_embargo(np.array([0, 1]), t0_valid, t1_invalid, [np.array([2])])

    with pytest.raises(ValueError, match="t1 must be >= t0"):
        list(cpcv_splits(t0_valid, t1_invalid, n_groups=3, n_test_groups=1))

    with pytest.raises(ValueError, match="t1 must be >= t0"):
        list(walk_forward_splits(t0_valid, t1_invalid, start_ms=0, end_ms=400))
