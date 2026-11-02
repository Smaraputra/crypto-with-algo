"""Purged walk-forward and combinatorial purged cross-validation for Round 4."""

from __future__ import annotations

import itertools
from collections.abc import Iterator, Sequence
from datetime import UTC, datetime
from typing import Any

import numpy as np


def assign_groups(n_samples: int, n_groups: int = 6) -> list[np.ndarray]:
    """Assign sample indices 0..n_samples-1 to n_groups contiguous groups.

    Group assignment matches skfolio exactly:
    size = n_samples // n_groups
    group[i] = min(i // size, n_groups - 1)
    The last group absorbs the remainder. This is NOT np.array_split.

    Parameters
    ----------
    n_samples : int
        Total number of samples.
    n_groups : int, default=6
        Number of groups (must be >= 1 and <= n_samples).

    Returns
    -------
    list[np.ndarray]
        List of 1D integer arrays containing the sample indices for each group.
    """
    if n_groups <= 0:
        raise ValueError(f"n_groups must be positive, got {n_groups}")
    if n_samples < n_groups:
        raise ValueError(f"n_samples ({n_samples}) must be >= n_groups ({n_groups})")

    size = n_samples // n_groups
    groups: list[np.ndarray] = []
    for g in range(n_groups - 1):
        groups.append(np.arange(g * size, (g + 1) * size, dtype=int))
    groups.append(np.arange((n_groups - 1) * size, n_samples, dtype=int))
    return groups


def _validate_t0_t1(t0: Any, t1: Any) -> tuple[np.ndarray, np.ndarray]:
    """Validate sample decision times t0 and label availability times t1."""
    t0_arr = np.asarray(t0)
    t1_arr = np.asarray(t1)
    if t0_arr.ndim != 1 or t1_arr.ndim != 1:
        raise ValueError("t0 and t1 must be 1-dimensional arrays")
    if len(t0_arr) != len(t1_arr):
        raise ValueError(f"t0 and t1 must have the same length, got {len(t0_arr)} and {len(t1_arr)}")
    if len(t0_arr) > 1 and np.any(np.diff(t0_arr) < 0):
        raise ValueError("t0 must be sorted ascending")
    if np.any(t1_arr < t0_arr):
        raise ValueError("t1 must be >= t0 for all samples")
    return t0_arr, t1_arr


def _normalize_blocks(test_blocks: Any, t0: np.ndarray, t1: np.ndarray) -> list[tuple[int | float, int | float]]:
    """Convert test_blocks into a list of (block_start, block_end) spans."""
    if (
        isinstance(test_blocks, tuple)
        and len(test_blocks) == 2
        and isinstance(test_blocks[0], (int, float, np.integer, np.floating))
        and isinstance(test_blocks[1], (int, float, np.integer, np.floating))
    ):
        return [(test_blocks[0], test_blocks[1])]

    if len(test_blocks) == 0:
        return []

    if isinstance(test_blocks, np.ndarray) and test_blocks.ndim == 1:
        return [(int(np.min(t0[test_blocks])), int(np.max(t1[test_blocks])))]
    if (
        isinstance(test_blocks, (list, tuple))
        and len(test_blocks) > 0
        and isinstance(test_blocks[0], (int, np.integer))
    ):
        idx = np.asarray(test_blocks, dtype=int)
        return [(int(np.min(t0[idx])), int(np.max(t1[idx])))]

    spans: list[tuple[int | float, int | float]] = []
    for b in test_blocks:
        if (
            isinstance(b, tuple)
            and len(b) == 2
            and isinstance(b[0], (int, float, np.integer, np.floating))
            and isinstance(b[1], (int, float, np.integer, np.floating))
        ):
            spans.append((b[0], b[1]))
        else:
            b_arr = np.asarray(b, dtype=int)
            if len(b_arr) > 0:
                spans.append((int(np.min(t0[b_arr])), int(np.max(t1[b_arr]))))
    return spans


def purge_and_embargo(
    train_idx: Any,
    t0: Any,
    t1: Any,
    test_blocks: Any,
    embargo_ms: int = 0,
) -> np.ndarray:
    """Purge overlapping samples and apply embargo after test blocks.

    A training sample is removed when its label interval overlaps a test block's
    span [min t0 over the block, max t1 over the block].
    Overlap means t0_train <= block_end and t1_train >= block_start.

    After each test block, training samples with
    block_end_t1 < t0_train <= block_end_t1 + embargo_ms are also removed.
    The embargo applies after a block only, never before it.

    Parameters
    ----------
    train_idx : array-like
        Candidate training sample indices.
    t0 : array-like
        Decision time in epoch ms for all samples (sorted ascending).
    t1 : array-like
        Label end time in epoch ms for all samples (t1 >= t0).
    test_blocks : sequence of blocks or single block
        Each block can be an array of test sample indices or a (start_ms, end_ms) tuple.
    embargo_ms : int, default=0
        Embargo duration in milliseconds after each test block.

    Returns
    -------
    np.ndarray
        Filtered integer array of training sample indices.
    """
    t0_arr, t1_arr = _validate_t0_t1(t0, t1)
    if embargo_ms < 0:
        raise ValueError(f"embargo_ms cannot be negative, got {embargo_ms}")

    train = np.asarray(train_idx, dtype=int).reshape(-1)
    if len(train) == 0:
        return np.array([], dtype=int)

    spans = _normalize_blocks(test_blocks, t0_arr, t1_arr)
    if len(spans) == 0:
        return train

    t0_tr = t0_arr[train]
    t1_tr = t1_arr[train]
    keep_mask = np.ones(len(train), dtype=bool)

    for block_start, block_end in spans:
        purge_mask = (t0_tr <= block_end) & (t1_tr >= block_start)
        if embargo_ms > 0:
            embargo_mask = (t0_tr > block_end) & (t0_tr <= block_end + embargo_ms)
        else:
            embargo_mask = False
        keep_mask &= ~(purge_mask | embargo_mask)

    return train[keep_mask]


def cpcv_splits(
    t0: Any,
    t1: Any,
    n_groups: int = 6,
    n_test_groups: int = 2,
    embargo_ms: int = 0,
) -> Iterator[tuple[np.ndarray, list[np.ndarray]]]:
    """Generate train and test splits for Combinatorial Purged Cross-Validation.

    Group assignment matches skfolio exactly:
    size = n // n_groups, group[i] = min(i // size, n_groups - 1).
    Splits come in lexicographic order of the test-group combinations.
    Each split yields (train_idx, [test_idx_for_each_test_group in ascending group order]).

    Parameters
    ----------
    t0 : array-like
        Decision time in epoch ms for all samples (sorted ascending).
    t1 : array-like
        Label end time in epoch ms for all samples (t1 >= t0).
    n_groups : int, default=6
        Number of groups.
    n_test_groups : int, default=2
        Number of test groups per split.
    embargo_ms : int, default=0
        Embargo duration in milliseconds after each test block.

    Yields
    ------
    train_idx : np.ndarray
        Integer array of training sample indices after purging and embargo.
    test_idx_list : list[np.ndarray]
        List of integer arrays containing sample indices for each test group in ascending order.
    """
    t0_arr, t1_arr = _validate_t0_t1(t0, t1)
    n = len(t0_arr)
    if n_groups <= 2:
        raise ValueError(f"n_groups must be at least 3, got {n_groups}")
    if n_test_groups <= 0:
        raise ValueError(f"n_test_groups must be at least 1, got {n_test_groups}")
    if n_test_groups >= n_groups:
        raise ValueError(f"n_groups ({n_groups}) must be greater than n_test_groups ({n_test_groups})")

    groups = assign_groups(n, n_groups)

    for test_comb in itertools.combinations(range(n_groups), n_test_groups):
        test_idx_list = [groups[g] for g in test_comb]
        test_all = np.concatenate(test_idx_list) if test_idx_list else np.array([], dtype=int)

        is_test = np.zeros(n, dtype=bool)
        is_test[test_all] = True
        candidate_train = np.flatnonzero(~is_test)

        train_idx = purge_and_embargo(candidate_train, t0_arr, t1_arr, test_idx_list, embargo_ms)
        yield train_idx, test_idx_list


def cpcv_path_ids(n_groups: int, n_test_groups: int) -> np.ndarray:
    """Return the path id of each test group in each split.

    Shape is (n_splits, n_test_groups). Entry [s, j] is the path id of
    split s's j-th test group.

    Rule: within each group g, the splits that test g are numbered 0, 1, 2, ...
    in split order, and that number is the path id.
    """
    if n_groups <= 2:
        raise ValueError(f"n_groups must be at least 3, got {n_groups}")
    if n_test_groups <= 0 or n_test_groups >= n_groups:
        raise ValueError(f"n_test_groups must be between 1 and n_groups - 1, got {n_test_groups}")

    splits = list(itertools.combinations(range(n_groups), n_test_groups))
    n_splits = len(splits)

    group_split_counts: dict[int, int] = {g: 0 for g in range(n_groups)}
    path_ids = np.zeros((n_splits, n_test_groups), dtype=int)

    for s, test_groups in enumerate(splits):
        for j, g in enumerate(test_groups):
            path_ids[s, j] = group_split_counts[g]
            group_split_counts[g] += 1

    return path_ids


def cpcv_paths(
    predictions_by_split: Sequence[Any],
    path_ids: Any,
    test_groups_by_split: Sequence[Sequence[Any]],
) -> np.ndarray:
    """Assemble each path's out-of-sample predictions in sample order.

    Each path covers every sample exactly once.

    Parameters
    ----------
    predictions_by_split : sequence
        Predictions for each split. Split s can provide predictions either as a list of
        arrays (one per test group in test_groups_by_split[s]) or as a single array of
        concatenated predictions.
    path_ids : array-like of shape (n_splits, n_test_groups)
        Path ids for each test group in each split.
    test_groups_by_split : sequence of sequences of integer arrays
        The test group index arrays for each split, in ascending group order.

    Returns
    -------
    np.ndarray
        Array of shape (n_paths, n_samples) (or (n_paths, n_samples, ...) for multi-output)
        containing out-of-sample predictions in sample order for each path.
    """
    path_ids_arr = np.asarray(path_ids)
    n_splits = len(path_ids_arr)
    if n_splits == 0:
        return np.array([])

    n_test_groups = path_ids_arr.shape[1]
    n_paths = int(np.max(path_ids_arr)) + 1

    max_idx = -1
    for s in range(n_splits):
        for tg in test_groups_by_split[s]:
            tg_arr = np.asarray(tg, dtype=int)
            if len(tg_arr) > 0:
                max_idx = max(max_idx, int(np.max(tg_arr)))
    n_samples = max_idx + 1

    first_pred_val = None
    for s in range(n_splits):
        preds = predictions_by_split[s]
        if isinstance(preds, (list, tuple)) and len(preds) == n_test_groups and not isinstance(preds, np.ndarray):
            for p in preds:
                p_arr = np.asarray(p)
                if len(p_arr) > 0:
                    first_pred_val = p_arr
                    break
        else:
            p_arr = np.asarray(preds)
            if len(p_arr) > 0:
                first_pred_val = p_arr
                break
        if first_pred_val is not None:
            break

    if first_pred_val is None:
        return np.empty((n_paths, n_samples))

    dtype = first_pred_val.dtype
    extra_shape = first_pred_val.shape[1:]

    out = np.empty((n_paths, n_samples, *extra_shape), dtype=dtype)

    for s in range(n_splits):
        s_preds = predictions_by_split[s]
        s_tgs = test_groups_by_split[s]

        if isinstance(s_preds, (list, tuple)) and len(s_preds) == len(s_tgs) and not isinstance(s_preds, np.ndarray):
            group_preds = [np.asarray(p) for p in s_preds]
        else:
            s_preds_arr = np.asarray(s_preds)
            group_preds = []
            offset = 0
            for tg in s_tgs:
                sz = len(tg)
                group_preds.append(s_preds_arr[offset : offset + sz])
                offset += sz

        for j in range(len(s_tgs)):
            p_id = path_ids_arr[s, j]
            idx = np.asarray(s_tgs[j], dtype=int)
            out[p_id, idx] = group_preds[j]

    return out


def panel_cpcv_splits(
    t0: Any,
    t1: Any,
    n_groups: int = 6,
    n_test_groups: int = 2,
    embargo_ms: int = 2592000000,
) -> Iterator[tuple[np.ndarray, list[np.ndarray]]]:
    """Generate train and test splits for panel Combinatorial Purged Cross-Validation.

    Samples from multiple assets are pooled into a single panel. Group assignment
    partitions the sorted unique values of decision time t0 into n_groups contiguous
    time runs using the same rule as assign_groups:
    size = n_unique // n_groups
    group = min(rank // size, n_groups - 1)
    All samples sharing a t0 timestamp are assigned to the same group, so tied
    timestamps always share a group.

    Splits come in the same lexicographic order of test group combinations as
    cpcv_splits. Each split yields (train_idx, [test_idx per test group]) with
    indices in ascending order into the original input arrays.

    For each test group in a split, the block span across all coins is:
    block_start = min t0 over that group's samples
    block_end = max t1 over that group's samples

    A candidate training sample is purged if:
    t0_train <= block_end and t1_train >= block_start
    for any test group.

    When embargo_ms > 0, a training sample is also removed if:
    block_end < t0_train <= block_end + embargo_ms
    for any test group. The default embargo_ms is 2592000000 (30 days in ms).

    cpcv_path_ids and cpcv_paths work unchanged on the panel output produced by
    this generator, as test groups partition all panel samples and each path
    covers every sample in the panel exactly once.

    Parameters
    ----------
    t0 : array-like
        Decision time in epoch ms for all panel samples (in any order).
    t1 : array-like
        Label end time in epoch ms for all panel samples (t1 >= t0).
    n_groups : int, default=6
        Number of groups.
    n_test_groups : int, default=2
        Number of test groups per split.
    embargo_ms : int, default=2592000000
        Embargo duration in milliseconds after each test block (default 30 days).

    Yields
    ------
    train_idx : np.ndarray
        Integer array of training sample indices after purging and embargo,
        in ascending order of original array indices.
    test_idx_list : list[np.ndarray]
        List of integer arrays containing sample indices for each test group in
        ascending group order, each with indices in ascending order into the
        original arrays.

    Raises
    ------
    ValueError
        If t0 and t1 have mismatched shapes or lengths, if any t1 < t0,
        if n_groups <= 2, n_test_groups <= 0, n_test_groups >= n_groups,
        or if the number of unique t0 values is less than n_groups.
    """
    t0_arr = np.asarray(t0)
    t1_arr = np.asarray(t1)
    if t0_arr.ndim != 1 or t1_arr.ndim != 1:
        raise ValueError("t0 and t1 must be 1-dimensional arrays")
    if len(t0_arr) != len(t1_arr):
        raise ValueError(f"t0 and t1 must have the same length, got {len(t0_arr)} and {len(t1_arr)}")
    if np.any(t1_arr < t0_arr):
        raise ValueError("t1 must be >= t0 for all samples")
    if n_groups <= 2:
        raise ValueError(f"n_groups must be at least 3, got {n_groups}")
    if n_test_groups <= 0:
        raise ValueError(f"n_test_groups must be at least 1, got {n_test_groups}")
    if n_test_groups >= n_groups:
        raise ValueError(f"n_groups ({n_groups}) must be greater than n_test_groups ({n_test_groups})")
    if embargo_ms < 0:
        raise ValueError(f"embargo_ms cannot be negative, got {embargo_ms}")

    unique_t0, inv = np.unique(t0_arr, return_inverse=True)
    n_unique = len(unique_t0)
    if n_unique < n_groups:
        raise ValueError(f"Number of unique t0 ({n_unique}) must be >= n_groups ({n_groups})")

    size = n_unique // n_groups
    sample_group = np.minimum(inv // size, n_groups - 1)

    group_indices = [np.flatnonzero(sample_group == g) for g in range(n_groups)]

    for test_comb in itertools.combinations(range(n_groups), n_test_groups):
        test_idx_list = [group_indices[g] for g in test_comb]

        is_test = np.isin(sample_group, test_comb)
        candidate_train = np.flatnonzero(~is_test)

        if len(candidate_train) == 0:
            yield np.array([], dtype=int), test_idx_list
            continue

        t0_tr = t0_arr[candidate_train]
        t1_tr = t1_arr[candidate_train]
        keep_mask = np.ones(len(candidate_train), dtype=bool)

        for tg in test_idx_list:
            block_start = np.min(t0_arr[tg])
            block_end = np.max(t1_arr[tg])

            purge_mask = (t0_tr <= block_end) & (t1_tr >= block_start)
            if embargo_ms > 0:
                embargo_mask = (t0_tr > block_end) & (t0_tr <= block_end + embargo_ms)
            else:
                embargo_mask = False

            keep_mask &= ~(purge_mask | embargo_mask)

        train_idx = candidate_train[keep_mask]
        yield train_idx, test_idx_list


def _month_starts(start_ms: int, end_ms: int) -> list[int]:
    """Return epoch ms of the first instant of each UTC calendar month in [start_ms, end_ms)."""
    dt_start = datetime.fromtimestamp(start_ms / 1000, tz=UTC)
    cur = datetime(dt_start.year, dt_start.month, 1, 0, 0, 0, tzinfo=UTC)
    if int(cur.timestamp()) * 1000 < start_ms:
        year = cur.year + (1 if cur.month == 12 else 0)
        month = 1 if cur.month == 12 else cur.month + 1
        cur = datetime(year, month, 1, 0, 0, 0, tzinfo=UTC)

    res: list[int] = []
    while True:
        ms = int(cur.timestamp()) * 1000
        if ms >= end_ms:
            break
        res.append(ms)
        year = cur.year + (1 if cur.month == 12 else 0)
        month = 1 if cur.month == 12 else cur.month + 1
        cur = datetime(year, month, 1, 0, 0, 0, tzinfo=UTC)
    return res


def walk_forward_splits(
    t0: Any,
    t1: Any,
    start_ms: int,
    end_ms: int,
    refit: str = "monthly",
    lookback_ms: int | None = None,
    embargo_ms: int = 0,
) -> Iterator[tuple[int, np.ndarray, np.ndarray]]:
    """Generate purged walk-forward splits.

    Refit times are the first instant of each UTC calendar month from start_ms
    up to end_ms. Test block k is [refit_k, refit_{k+1}) by t0, and the last block
    runs to end_ms.

    Train holds samples with t1 < refit_k (the purge: a label must be known
    before the test block starts) and, when lookback_ms is set,
    t0 >= refit_k - lookback_ms. None means all earlier data.

    Training never follows the test block in a walk-forward, so the embargo
    is a no-op there. The embargo_ms argument is accepted for a uniform signature.

    Empty test blocks are skipped.

    Parameters
    ----------
    t0 : array-like
        Decision time in epoch ms for all samples (sorted ascending).
    t1 : array-like
        Label end time in epoch ms for all samples (t1 >= t0).
    start_ms : int
        Start timestamp in epoch ms.
    end_ms : int
        End timestamp in epoch ms (must be > start_ms).
    refit : str, default="monthly"
        Refit schedule. Currently only "monthly" is supported.
    lookback_ms : int | None, default=None
        Maximum lookback window in milliseconds for training data. If None,
        all available prior data is used.
    embargo_ms : int, default=0
        Accepted for a uniform signature. Training never follows the test
        block in a walk-forward, so embargo is a no-op.

    Yields
    ------
    refit_ms : int
        Refit epoch timestamp in ms.
    train_idx : np.ndarray
        Integer array of training sample indices.
    test_idx : np.ndarray
        Integer array of test sample indices.
    """
    t0_arr, t1_arr = _validate_t0_t1(t0, t1)
    if start_ms >= end_ms:
        raise ValueError(f"start_ms ({start_ms}) must be < end_ms ({end_ms})")
    if refit != "monthly":
        raise ValueError(f"Unsupported refit schedule: {refit}")
    if lookback_ms is not None and lookback_ms <= 0:
        raise ValueError(f"lookback_ms must be positive, got {lookback_ms}")
    if embargo_ms < 0:
        raise ValueError(f"embargo_ms cannot be negative, got {embargo_ms}")

    refit_times = _month_starts(start_ms, end_ms)

    for k, refit_ms in enumerate(refit_times):
        block_start = refit_ms
        block_end = refit_times[k + 1] if k < len(refit_times) - 1 else end_ms

        test_mask = (t0_arr >= block_start) & (t0_arr < block_end)
        test_idx = np.flatnonzero(test_mask)
        if len(test_idx) == 0:
            continue

        train_mask = t1_arr < refit_ms
        if lookback_ms is not None:
            train_mask &= t0_arr >= (refit_ms - lookback_ms)
        train_idx = np.flatnonzero(train_mask)

        yield refit_ms, train_idx, test_idx
