"""Tests for panel CPCV in r4.validation module."""

from __future__ import annotations

import itertools

import numpy as np
import pytest

from r4.validation import (
    cpcv_path_ids,
    cpcv_paths,
    cpcv_splits,
    panel_cpcv_splits,
)


def test_panel_ties_all_coins_in_test_groups():
    """Requirement 1: 10 coins with identical timestamps.

    Every split's test groups contain all 10 coins' samples at each included timestamp.
    No timestamp appears in two groups.
    """
    n_hours = 600
    n_coins = 10
    h_ms = 3600000
    base_t0 = np.arange(n_hours, dtype=np.int64) * h_ms
    base_t1 = base_t0 + 4 * h_ms

    t0 = np.repeat(base_t0, n_coins)
    t1 = np.repeat(base_t1, n_coins)
    coin_ids = np.tile(np.arange(n_coins), n_hours)

    splits = list(panel_cpcv_splits(t0, t1, n_groups=6, n_test_groups=2, embargo_ms=6 * h_ms))
    assert len(splits) == 15

    group_timestamps: dict[int, set[int]] = {}
    for test_comb, (_train_idx, test_idx_list) in zip(itertools.combinations(range(6), 2), splits, strict=True):
        for g, tg in zip(test_comb, test_idx_list, strict=True):
            ts_in_group = set(t0[tg].tolist())
            if g in group_timestamps:
                assert group_timestamps[g] == ts_in_group
            else:
                group_timestamps[g] = ts_in_group

            unique_ts_in_tg = np.unique(t0[tg])
            assert len(tg) == len(unique_ts_in_tg) * n_coins
            for ts in unique_ts_in_tg:
                mask = t0[tg] == ts
                assert np.sum(mask) == n_coins
                assert set(coin_ids[tg[mask]]) == set(range(n_coins))

    # Assert no timestamp appears in two groups
    for g1 in range(6):
        for g2 in range(g1 + 1, 6):
            overlap = group_timestamps[g1] & group_timestamps[g2]
            assert len(overlap) == 0, f"Timestamp overlap between group {g1} and {g2}: {overlap}"


def test_panel_single_coin_exact_equality():
    """Requirement 2: With a single coin, panel_cpcv_splits matches cpcv_splits exactly."""
    n = 600
    h = 4
    e = 6
    h_ms = 3600000
    t0 = np.arange(n, dtype=np.int64) * h_ms
    t1 = t0 + h * h_ms
    embargo_ms = e * h_ms

    cpcv = list(cpcv_splits(t0, t1, n_groups=6, n_test_groups=2, embargo_ms=embargo_ms))
    panel = list(panel_cpcv_splits(t0, t1, n_groups=6, n_test_groups=2, embargo_ms=embargo_ms))

    assert len(cpcv) == len(panel) == 15

    for split_idx, ((sk_train, sk_tests), (pn_train, pn_tests)) in enumerate(zip(cpcv, panel, strict=True)):
        assert np.array_equal(pn_train, sk_train), f"Train mismatch at split {split_idx}"
        assert len(pn_tests) == len(sk_tests)
        for g_idx, (pn_g, sk_g) in enumerate(zip(pn_tests, sk_tests, strict=True)):
            assert np.array_equal(pn_g, sk_g), f"Test group {g_idx} mismatch at split {split_idx}"


def test_panel_cross_coin_purge_hand_built():
    """Requirement 3: Cross-coin purge on a hand-built panel.

    Coin A's training sample, whose label overlaps the test span defined by coin B's
    samples, is removed, although coin A has no sample in that test group at that time.
    """
    # 3 unique timestamps: 100, 200, 300 -> 3 groups (0, 1, 2)
    # Samples:
    # 0: Coin A at t0 = 100, t1 = 250 (Group 0)
    # 1: Coin B at t0 = 100, t1 = 150 (Group 0)
    # 2: Coin B at t0 = 200, t1 = 300 (Group 1) -> Coin A has NO sample at t0 = 200!
    # 3: Coin A at t0 = 300, t1 = 350 (Group 2)
    # 4: Coin B at t0 = 300, t1 = 350 (Group 2)
    t0 = np.array([100, 100, 200, 300, 300])
    t1 = np.array([250, 150, 300, 350, 350])

    splits = list(panel_cpcv_splits(t0, t1, n_groups=3, n_test_groups=1, embargo_ms=0))
    # 3 splits corresponding to test group (0,), (1,), (2,)
    assert len(splits) == 3

    # Split 1 tests group 1 (index combination (1,))
    train_idx_split1, test_groups_split1 = splits[1]

    # Verify Coin A has no sample in test group 1
    assert len(test_groups_split1) == 1
    assert np.array_equal(test_groups_split1[0], np.array([2]))

    # Test group 1 has span [200, 300]
    # Sample 0 (Coin A) has t0 = 100, t1 = 250: overlaps [200, 300] -> PURGED
    # Sample 1 (Coin B) has t0 = 100, t1 = 150: t1 < 200 -> KEPT
    # Samples 3 and 4 have t0 = 300 <= 300, t1 = 350 >= 200 -> PURGED
    assert 0 not in train_idx_split1
    assert 1 in train_idx_split1
    assert np.array_equal(train_idx_split1, np.array([1]))


def test_panel_embargo_exact_boundary_across_coins():
    """Requirement 4: Embargo at the exact boundary across coins.

    A sample at block_end + embargo_ms is removed, one at block_end + embargo_ms + 1 is kept.
    """
    # 4 unique timestamps: 100, 200, 250, 251 with n_groups = 3
    # size = 4 // 3 = 1
    # Rank 0 (100) -> Group 0
    # Rank 1 (200) -> Group 1
    # Rank 2 (250) -> Group 2
    # Rank 3 (251) -> Group 2
    #
    # Group 0 test block: Coin B sample at t0 = 100, t1 = 200.
    # block_end = 200. With embargo_ms = 50, embargo window is (200, 250].
    # Coin A has samples:
    # t0 = 250, t1 = 260 (at block_end + embargo_ms) -> must be removed
    # t0 = 251, t1 = 260 (at block_end + embargo_ms + 1) -> must be kept
    t0 = np.array([100, 200, 250, 251])
    t1 = np.array([200, 220, 260, 260])

    splits = list(panel_cpcv_splits(t0, t1, n_groups=3, n_test_groups=1, embargo_ms=50))
    assert len(splits) == 3

    # Split 0 tests group 0 (sample 0)
    train_idx_split0, test_groups_split0 = splits[0]
    assert np.array_equal(test_groups_split0[0], np.array([0]))

    # Sample 1 (t0 = 200 <= block_end) -> purged
    # Sample 2 (t0 = 250 == block_end + embargo_ms) -> embargoed (removed)
    # Sample 3 (t0 = 251 == block_end + embargo_ms + 1) -> kept
    assert 2 not in train_idx_split0
    assert 3 in train_idx_split0
    assert np.array_equal(train_idx_split0, np.array([3]))


def test_panel_unsorted_input_order():
    """Requirement 5: Shuffling the input order preserves mapped train and test sets."""
    rng = np.random.default_rng(42)
    n_hours = 60
    n_coins = 3
    h_ms = 3600000
    base_t0 = np.arange(n_hours, dtype=np.int64) * h_ms
    base_t1 = base_t0 + 4 * h_ms

    t0 = np.repeat(base_t0, n_coins)
    t1 = np.repeat(base_t1, n_coins)
    n_samples = len(t0)

    splits_orig = list(panel_cpcv_splits(t0, t1, n_groups=6, n_test_groups=2, embargo_ms=6 * h_ms))

    perm = rng.permutation(n_samples)
    t0_shuf = t0[perm]
    t1_shuf = t1[perm]

    splits_shuf = list(panel_cpcv_splits(t0_shuf, t1_shuf, n_groups=6, n_test_groups=2, embargo_ms=6 * h_ms))

    assert len(splits_shuf) == len(splits_orig)

    for (train_orig, tests_orig), (train_shuf, tests_shuf) in zip(splits_orig, splits_shuf, strict=True):
        mapped_train = perm[train_shuf]
        assert set(mapped_train) == set(train_orig)
        assert len(mapped_train) == len(train_orig)

        assert len(tests_shuf) == len(tests_orig)
        for tg_orig, tg_shuf in zip(tests_orig, tests_shuf, strict=True):
            mapped_tg = perm[tg_shuf]
            assert set(mapped_tg) == set(tg_orig)
            assert len(mapped_tg) == len(tg_orig)


def test_panel_invalid_t1_less_than_t0():
    """Requirement 6: Inputs with t1 < t0 raise ValueError."""
    t0 = np.array([100, 200, 300])
    t1 = np.array([150, 180, 350])  # index 1 has t1 < t0

    with pytest.raises(ValueError, match="t1 must be >= t0"):
        list(panel_cpcv_splits(t0, t1, n_groups=3, n_test_groups=1))


def test_panel_cpcv_paths_reconstruction():
    """Verify cpcv_path_ids and cpcv_paths work unchanged on panel output."""
    n_hours = 60
    n_coins = 4
    h_ms = 3600000
    base_t0 = np.arange(n_hours, dtype=np.int64) * h_ms
    base_t1 = base_t0 + 2 * h_ms

    t0 = np.repeat(base_t0, n_coins)
    t1 = np.repeat(base_t1, n_coins)
    n_samples = len(t0)

    splits = list(panel_cpcv_splits(t0, t1, n_groups=6, n_test_groups=2, embargo_ms=0))
    test_groups_by_split = [tests for _, tests in splits]
    path_ids = cpcv_path_ids(6, 2)

    predictions_by_split = [[g.copy().astype(float) for g in tg] for tg in test_groups_by_split]
    paths = cpcv_paths(predictions_by_split, path_ids, test_groups_by_split)

    assert paths.shape == (5, n_samples)
    for p in range(5):
        assert np.array_equal(paths[p], np.arange(n_samples, dtype=float))


def test_panel_validation_errors():
    """Verify panel_cpcv_splits validates inputs and group parameters."""
    t0 = np.array([100, 200, 300])
    t1 = np.array([150, 250, 350])

    with pytest.raises(ValueError, match="n_groups must be at least 3"):
        list(panel_cpcv_splits(t0, t1, n_groups=2, n_test_groups=1))

    with pytest.raises(ValueError, match="n_test_groups must be at least 1"):
        list(panel_cpcv_splits(t0, t1, n_groups=3, n_test_groups=0))

    with pytest.raises(ValueError, match="must be greater than n_test_groups"):
        list(panel_cpcv_splits(t0, t1, n_groups=3, n_test_groups=3))

    with pytest.raises(ValueError, match="embargo_ms cannot be negative"):
        list(panel_cpcv_splits(t0, t1, n_groups=3, n_test_groups=1, embargo_ms=-1))

    with pytest.raises(ValueError, match="1-dimensional"):
        list(panel_cpcv_splits(t0.reshape(-1, 1), t1, n_groups=3, n_test_groups=1))

    with pytest.raises(ValueError, match="same length"):
        list(panel_cpcv_splits(t0[:-1], t1, n_groups=3, n_test_groups=1))

    t0_few = np.array([100, 100, 100])
    t1_few = np.array([150, 150, 150])
    with pytest.raises(ValueError, match="Number of unique t0"):
        list(panel_cpcv_splits(t0_few, t1_few, n_groups=3, n_test_groups=1))
