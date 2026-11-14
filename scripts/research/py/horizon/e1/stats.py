"""Clusters, confidence bounds, pass clauses, and descriptive statistics for horizon-e1 (rules 8 to 10)."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import scipy.stats

from horizon.e1 import lock

__all__ = [
    "Cluster",
    "TrialJudgement",
    "Unit",
    "bootstrap_bound",
    "describe",
    "judge_trial",
    "leave_one_out_min",
    "make_clusters",
    "t_bound",
]


@dataclass(frozen=True)
class Unit:
    """One announcement of one class."""

    cls: str
    code: str
    entry_ms: int
    value: float
    n_tokens: int


@dataclass(frozen=True)
class Cluster:
    """A cluster of chained units within gap_hours."""

    cls: str
    entry_ms: int
    value: float
    codes: tuple[str, ...]


def make_clusters(units: Sequence[Unit], gap_hours: float = lock.CLUSTER_GAP_HOURS) -> list[Cluster]:
    """Sort units of one class by (entry_ms, code) and merge chained units within gap_hours."""
    if not units:
        return []

    target_cls = units[0].cls
    if any(u.cls != target_cls for u in units):
        raise ValueError("make_clusters received units with mixed classes")

    sorted_units = sorted(units, key=lambda u: (u.entry_ms, u.code))
    gap_ms = int(gap_hours * lock.HOUR_MS)

    clusters: list[Cluster] = []
    current_cluster: list[Unit] = [sorted_units[0]]

    for u in sorted_units[1:]:
        prev_u = current_cluster[-1]
        if (u.entry_ms - prev_u.entry_ms) > gap_ms:
            cluster_val = float(np.mean([x.value for x in current_cluster]))
            clusters.append(
                Cluster(
                    cls=target_cls,
                    entry_ms=current_cluster[0].entry_ms,
                    value=cluster_val,
                    codes=tuple(x.code for x in current_cluster),
                )
            )
            current_cluster = [u]
        else:
            current_cluster.append(u)

    if current_cluster:
        cluster_val = float(np.mean([x.value for x in current_cluster]))
        clusters.append(
            Cluster(
                cls=target_cls,
                entry_ms=current_cluster[0].entry_ms,
                value=cluster_val,
                codes=tuple(x.code for x in current_cluster),
            )
        )

    return clusters


def leave_one_out_min(values: np.ndarray) -> float:
    """Minimum over i of the sample mean leaving out element i (NaN if n < 2)."""
    arr = np.asarray(values, dtype=np.float64)
    n = len(arr)
    if n < 2:
        return float("nan")
    total = float(np.sum(arr))
    loo_means = (total - arr) / (n - 1)
    return float(np.min(loo_means))


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


@dataclass(frozen=True)
class TrialJudgement:
    """Judgement results and rule 9 pass clauses for one trial."""

    trial_id: str
    n_clusters: int
    mean: float
    boot_bound: float
    t_bound: float
    bound: float
    loo_min: float
    excluded_share: float
    clause_a: bool
    clause_b: bool
    clause_c: bool
    clause_d: bool
    clause_e: bool
    passed: bool


def judge_trial(
    trial_id: str,
    values: np.ndarray,
    excluded_share: float,
    rng: np.random.Generator,
) -> TrialJudgement:
    """Evaluate the 5 pass clauses of rule 9 for one trial."""
    arr = np.asarray(values, dtype=np.float64)
    n = len(arr)

    if n == 0:
        mean_val = float("nan")
    else:
        mean_val = float(np.mean(arr))

    boot = bootstrap_bound(arr, rng)
    tb = t_bound(arr)

    if math.isnan(boot) or math.isnan(tb):
        bound_val = float("nan")
    else:
        bound_val = float(min(boot, tb))

    loo = leave_one_out_min(arr)

    clause_a = bool(not math.isnan(mean_val) and mean_val >= lock.PASS_MIN_MEAN)
    clause_b = bool(not math.isnan(bound_val) and bound_val > 0.0)
    clause_c = bool(not math.isnan(loo) and loo >= lock.PASS_LOO_MIN_MEAN)
    clause_d = bool(n >= lock.MIN_CLUSTERS)
    clause_e = bool(not math.isnan(excluded_share) and excluded_share <= lock.MAX_EXCLUDED_SHARE)
    passed = bool(clause_a and clause_b and clause_c and clause_d and clause_e)

    return TrialJudgement(
        trial_id=trial_id,
        n_clusters=n,
        mean=mean_val,
        boot_bound=boot,
        t_bound=tb,
        bound=bound_val,
        loo_min=loo,
        excluded_share=float(excluded_share),
        clause_a=clause_a,
        clause_b=clause_b,
        clause_c=clause_c,
        clause_d=clause_d,
        clause_e=clause_e,
        passed=passed,
    )


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
