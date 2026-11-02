"""Causality test helper: assert features are invariant to future unclosed data."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd


def _call_build(
    build: Callable[..., pd.DataFrame],
    frames: list[pd.DataFrame],
    mode: str,
    keys: list[str],
) -> pd.DataFrame:
    if mode == "mapping":
        kwargs = dict(zip(keys, frames, strict=True))
        return build(**kwargs)
    elif mode == "single":
        return build(frames[0])
    else:
        return build(*frames)


def assert_future_invariant(
    build: Callable[..., pd.DataFrame],
    inputs: (Sequence[tuple[pd.DataFrame, int]] | Mapping[str, tuple[pd.DataFrame, int]] | tuple[pd.DataFrame, int]),
    T_values: Iterable[int],
    rng: np.random.Generator | np.random.RandomState | None = None,
) -> None:
    """Assert that feature rows at T are invariant to changes in unclosed future inputs.

    Parameters
    ----------
    build : Callable[..., pd.DataFrame]
        Function that accepts the input frames and returns a features DataFrame
        indexed by decision close T.
    inputs : Sequence or Mapping of (frame, interval_ms) tuples
        The input series with their bar interval in ms. For event/settlement series,
        interval_ms is 0 so rows with t > T are considered unclosed.
    T_values : Iterable[int]
        Decision close timestamps T at which to verify future invariance.
    rng : np.random.Generator or RandomState, optional
        Random number generator for perturbations.
    """
    if rng is None:
        rng = np.random.default_rng(42)

    mode: str
    keys: list[str] = []
    normalized_inputs: list[tuple[pd.DataFrame, int]] = []

    if isinstance(inputs, Mapping):
        mode = "mapping"
        keys = list(inputs.keys())
        normalized_inputs = [inputs[k] for k in keys]
    elif isinstance(inputs, tuple) and len(inputs) == 2 and isinstance(inputs[0], pd.DataFrame):
        mode = "single"
        normalized_inputs = [inputs]
    elif isinstance(inputs, Sequence):
        mode = "sequence"
        normalized_inputs = list(inputs)
    else:
        mode = "sequence"
        normalized_inputs = list(inputs)  # type: ignore[arg-type]

    raw_frames = [item[0] for item in normalized_inputs]
    base_df = _call_build(build, raw_frames, mode, keys)

    for T in T_values:
        if T not in base_df.index:
            raise AssertionError(f"Decision time T={T} not found in base features index")
        base_row = base_df.loc[T]

        # 1. Perturbation check: unclosed future values are randomized
        perturbed_frames: list[pd.DataFrame] = []
        for frame, interval_ms in normalized_inputs:
            f_copy = frame.copy()
            unclosed = ~(f_copy["t"] + interval_ms <= T)
            n_unclosed = int(unclosed.sum())
            if n_unclosed > 0:
                for col in ("o", "h", "l", "c"):
                    if col in f_copy.columns:
                        factors = rng.uniform(0.5, 2.0, size=n_unclosed)
                        f_copy.loc[unclosed, col] = f_copy.loc[unclosed, col] * factors
                if "v" in f_copy.columns:
                    f_copy.loc[unclosed, "v"] = rng.uniform(1.0, 1000.0, size=n_unclosed)
                if "tbv" in f_copy.columns:
                    v_vals = f_copy.loc[unclosed, "v"].to_numpy(dtype=float)
                    f_copy.loc[unclosed, "tbv"] = v_vals * rng.uniform(0.0, 1.0, size=n_unclosed)
                if "rate" in f_copy.columns:
                    f_copy.loc[unclosed, "rate"] = rng.uniform(-0.01, 0.01, size=n_unclosed)
            perturbed_frames.append(f_copy)

        rebuilt_df = _call_build(build, perturbed_frames, mode, keys)
        if T not in rebuilt_df.index:
            raise AssertionError(f"Decision time T={T} not found in rebuilt features index")
        rebuilt_row = rebuilt_df.loc[T]

        if isinstance(base_row, pd.DataFrame):
            pd.testing.assert_frame_equal(base_row, rebuilt_row, check_exact=True)
        else:
            pd.testing.assert_series_equal(base_row, rebuilt_row, check_exact=True)

        # 2. Truncation check: unclosed future rows are dropped
        truncated_frames: list[pd.DataFrame] = [
            frame[frame["t"] + interval_ms <= T].copy() for frame, interval_ms in normalized_inputs
        ]
        truncated_df = _call_build(build, truncated_frames, mode, keys)
        if T not in truncated_df.index:
            raise AssertionError(f"Decision time T={T} not found in truncated features index")
        truncated_row = truncated_df.loc[T]

        if isinstance(base_row, pd.DataFrame):
            pd.testing.assert_frame_equal(base_row, truncated_row, check_exact=True)
        else:
            pd.testing.assert_series_equal(base_row, truncated_row, check_exact=True)
