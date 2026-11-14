"""Statistics helpers for horizon-l1: bootstrap bounds, t bounds, and summary statistics."""

from __future__ import annotations

import math

import numpy as np
import scipy.stats

from horizon.l1 import lock

__all__ = ["bootstrap_bound", "describe", "t_bound"]


def bootstrap_bound(
    values: np.ndarray,
    rng: np.random.Generator,
    resamples: int = lock.BOOT_RESAMPLES,
    alpha: float = lock.TRIAL_ALPHA,
) -> float:
    """One-sided lower bootstrap confidence bound at alpha."""
    arr = np.asarray(values, dtype=np.float64)
    n = len(arr)
    if n < 2:
        rng.integers(0, max(n, 1), size=(resamples, max(n, 1)))
        return float("nan")

    idx = rng.integers(0, n, size=(resamples, n))
    means = arr[idx].mean(axis=1)
    return float(np.quantile(means, alpha, method="linear"))


def t_bound(values: np.ndarray, alpha: float = lock.TRIAL_ALPHA) -> float:
    """One-sided lower t confidence bound at alpha (NaN if n < 2)."""
    arr = np.asarray(values, dtype=np.float64)
    n = len(arr)
    if n < 2:
        return float("nan")
    mean_val = float(np.mean(arr))
    s = float(np.std(arr, ddof=1))
    crit = float(scipy.stats.t.ppf(1.0 - alpha, n - 1))
    bound = mean_val - crit * s / math.sqrt(n)
    return float(bound)


def describe(values: np.ndarray) -> dict:
    """Summary statistics for an array of values."""
    arr = np.asarray(values, dtype=np.float64)
    n = len(arr)

    if n == 0:
        return {
            "n": 0,
            "mean": float("nan"),
            "median": float("nan"),
            "sd": float("nan"),
            "share_positive": float("nan"),
            "t": float("nan"),
        }

    mean_val = float(np.mean(arr))
    med_val = float(np.median(arr))
    pos_count = int(np.count_nonzero(arr > 0))
    share_pos = float(pos_count / n)

    if n < 2:
        sd_val = float("nan")
        t_val = float("nan")
    else:
        sd_val = float(np.std(arr, ddof=1))
        if sd_val == 0.0 or math.isnan(sd_val):
            t_val = float("nan")
        else:
            t_val = float(mean_val / (sd_val / math.sqrt(n)))

    return {
        "n": n,
        "mean": mean_val,
        "median": med_val,
        "sd": sd_val,
        "share_positive": share_pos,
        "t": t_val,
    }
