"""Statistical functions, deflated Sharpe ratio, moments, bootstrap and validation nulls."""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable, Sequence
from typing import Any

import numpy as np
import scipy.stats

EULER_MASCHERONI: float = 0.5772156649


def normal_cdf(x: float) -> float:
    """Cumulative distribution function of the standard normal distribution."""
    return float(scipy.stats.norm.cdf(x))


def normal_quantile(p: float) -> float:
    """Inverse standard normal CDF (quantile function)."""
    if not (0.0 < p < 1.0):
        raise ValueError("p must be in (0, 1)")
    return float(scipy.stats.norm.ppf(p))


def expected_max_sharpe(num_trials: int, variance_of_trial_sharpes: float) -> float:
    """Expected value of the maximum Sharpe ratio observed across num_trials."""
    if variance_of_trial_sharpes < 0.0:
        raise ValueError("variance_of_trial_sharpes must be non-negative")
    if num_trials <= 1:
        return 0.0

    gamma = EULER_MASCHERONI
    n = float(num_trials)
    term1 = (1.0 - gamma) * float(scipy.stats.norm.ppf(1.0 - 1.0 / n))
    term2 = gamma * float(scipy.stats.norm.ppf(1.0 - 1.0 / (n * math.e)))
    return float(math.sqrt(variance_of_trial_sharpes) * (term1 + term2))


def psr_radicand(sr: float, skew: float, kurt: float) -> float:
    """Radicand of the probabilistic Sharpe ratio standard error term."""
    return float(1.0 - skew * sr + ((kurt - 1.0) / 4.0) * (sr**2))


def probabilistic_sharpe(
    sr: float,
    bench: float,
    n: int,
    skew: float,
    kurt: float,
) -> float:
    """Probability that true Sharpe ratio exceeds benchmark."""
    radicand = psr_radicand(sr, skew, kurt)
    if radicand <= 0.0:
        return float("nan")
    numerator = (sr - bench) * math.sqrt(n - 1)
    denominator = math.sqrt(radicand)
    return float(scipy.stats.norm.cdf(numerator / denominator))


def deflated_sharpe(
    observed_sharpe: float,
    num_trials: int,
    variance_of_trial_sharpes: float,
    n_observations: int,
    skewness: float,
    kurtosis: float,
) -> tuple[float, float]:
    """Deflated Sharpe ratio: expected max benchmark and corrected probability."""
    benchmark = expected_max_sharpe(num_trials, variance_of_trial_sharpes)
    prob = probabilistic_sharpe(
        observed_sharpe,
        benchmark,
        n_observations,
        skewness,
        kurtosis,
    )
    return (benchmark, prob)


def per_period_sharpe(returns: Sequence[float] | np.ndarray) -> float:
    """Per-period Sharpe ratio: mean return over sample standard deviation (ddof=1)."""
    arr = np.asarray(returns, dtype=float)
    n = len(arr)
    if n < 2:
        return 0.0
    mean = float(np.mean(arr))
    var = float(np.sum((arr - mean) ** 2) / (n - 1))
    stdev = math.sqrt(var)
    if stdev == 0.0:
        return 0.0
    return mean / stdev


def sample_skewness(values: Sequence[float] | np.ndarray) -> float:
    """Sample skewness: third standardized moment (population style)."""
    arr = np.asarray(values, dtype=float)
    n = len(arr)
    if n == 0:
        return 0.0
    mean = float(np.mean(arr))
    diff = arr - mean
    m2 = float(np.sum(diff**2) / n)
    if m2 == 0.0:
        return 0.0
    m3 = float(np.sum(diff**3) / n)
    return m3 / (m2**1.5)


def sample_kurtosis(values: Sequence[float] | np.ndarray) -> float:
    """Sample kurtosis: raw fourth standardized moment (not excess kurtosis)."""
    arr = np.asarray(values, dtype=float)
    n = len(arr)
    if n == 0:
        return 0.0
    mean = float(np.mean(arr))
    diff = arr - mean
    m2 = float(np.sum(diff**2) / n)
    if m2 == 0.0:
        return 0.0
    m4 = float(np.sum(diff**4) / n)
    return m4 / (m2 * m2)


def stationary_bootstrap_indices(
    n: int,
    mean_block_len: float,
    rng: np.random.Generator | int | None = None,
) -> np.ndarray:
    """Indices of a stationary block bootstrap resample of length n (Politis and Romano)."""
    if n <= 0:
        return np.empty(0, dtype=np.int64)
    gen = np.random.default_rng(rng)
    continue_prob = 1.0 - 1.0 / mean_block_len if mean_block_len > 0 else 0.0
    indices = np.empty(n, dtype=np.int64)
    current = int(gen.integers(0, n))
    indices[0] = current
    for i in range(1, n):
        if gen.random() < continue_prob:
            current = (current + 1) % n
        else:
            current = int(gen.integers(0, n))
        indices[i] = current
    return indices


def _percentile(sorted_vals: np.ndarray, p: float) -> float:
    """Linear interpolation between order statistics matching TypeScript percentile."""
    idx = p * (len(sorted_vals) - 1)
    lower = int(math.floor(idx))
    upper = int(math.ceil(idx))
    if lower == upper:
        return float(sorted_vals[lower])
    weight = idx - lower
    return float(sorted_vals[lower] * (1.0 - weight) + sorted_vals[upper] * weight)


def bootstrap_ci(
    series: Sequence[float] | np.ndarray,
    statistic: Callable[[np.ndarray], float],
    iterations: int,
    mean_block_len: float,
    seed: int,
    alpha: float = 0.05,
) -> tuple[float, float, float]:
    """Percentile bootstrap confidence interval with stationary block bootstrap."""
    arr = np.asarray(series, dtype=float)
    n = len(arr)
    point = float(statistic(arr))
    if n == 0 or iterations <= 0:
        return (point, point, point)

    rng = np.random.default_rng(seed)
    draws = np.empty(iterations, dtype=float)
    for i in range(iterations):
        idx = stationary_bootstrap_indices(n, mean_block_len, rng)
        draws[i] = statistic(arr[idx])

    draws.sort()
    low = _percentile(draws, alpha / 2.0)
    high = _percentile(draws, 1.0 - alpha / 2.0)
    return (point, low, high)


def wilson(
    successes: int,
    n: int,
    z: float = 1.959963984540054,
) -> tuple[float, float]:
    """Wilson score confidence interval for a binomial proportion."""
    if n == 0:
        return (0.0, 1.0)
    if successes == 0:
        denom = 1.0 + (z * z) / n
        upper = (z * z / n) / denom
        return (0.0, float(upper))

    p_hat = successes / n
    denom = 1.0 + (z * z) / n
    center = (p_hat + (z * z) / (2.0 * n)) / denom
    radicand = (p_hat * (1.0 - p_hat)) / n + (z * z) / (4.0 * n * n)
    w = (z / denom) * math.sqrt(max(0.0, radicand))
    lower = max(0.0, float(center - w))
    upper = min(1.0, float(center + w))
    return (lower, upper)


def cscv_pbo(
    perf: Sequence[Sequence[float]] | np.ndarray,
    n_groups: int = 16,
    metric: Callable[[np.ndarray], float] = per_period_sharpe,
) -> tuple[float, np.ndarray]:
    """Probability of backtest overfitting from CSCV."""
    arr = np.asarray(perf, dtype=float)
    if arr.ndim != 2:
        raise ValueError("perf must be a 2-D array of shape (T, N)")
    t_periods, n_configs = arr.shape
    if n_groups % 2 != 0:
        raise ValueError("n_groups must be even")
    if t_periods < n_groups:
        raise ValueError("T must be >= n_groups")
    if n_configs < 2:
        raise ValueError("N must be >= 2")

    group_size = t_periods // n_groups
    groups = [arr[g * group_size : (g + 1) * group_size] for g in range(n_groups)]
    k = n_groups // 2
    combs = list(itertools.combinations(range(n_groups), k))

    is_fast_sharpe = (metric is per_period_sharpe) or (getattr(metric, "__name__", "") == "per_period_sharpe")
    logits = np.empty(len(combs), dtype=float)

    for i, is_idx in enumerate(combs):
        oos_idx = [g for g in range(n_groups) if g not in set(is_idx)]
        is_data = np.concatenate([groups[g] for g in is_idx], axis=0)
        oos_data = np.concatenate([groups[g] for g in oos_idx], axis=0)

        if is_fast_sharpe:
            is_n = len(is_data)
            is_mean = np.mean(is_data, axis=0)
            is_var = np.sum((is_data - is_mean) ** 2, axis=0) / (is_n - 1)
            is_std = np.sqrt(is_var)
            is_scores = np.zeros(n_configs, dtype=float)
            is_valid = is_std > 0
            is_scores[is_valid] = is_mean[is_valid] / is_std[is_valid]

            oos_n = len(oos_data)
            oos_mean = np.mean(oos_data, axis=0)
            oos_var = np.sum((oos_data - oos_mean) ** 2, axis=0) / (oos_n - 1)
            oos_std = np.sqrt(oos_var)
            oos_scores = np.zeros(n_configs, dtype=float)
            oos_valid = oos_std > 0
            oos_scores[oos_valid] = oos_mean[oos_valid] / oos_std[oos_valid]
        else:
            is_scores = np.array([metric(is_data[:, j]) for j in range(n_configs)], dtype=float)
            oos_scores = np.array([metric(oos_data[:, j]) for j in range(n_configs)], dtype=float)

        n_star = int(np.argmax(is_scores))
        oos_ranks = scipy.stats.rankdata(oos_scores)
        rank_star = oos_ranks[n_star]
        omega = rank_star / (n_configs + 1.0)
        logits[i] = math.log(omega / (1.0 - omega))

    pbo = float(np.mean(logits <= 0.0))
    return (pbo, logits)


def p_value(observed: float, null: Sequence[float] | np.ndarray) -> float:
    """One-tailed p-value: (1 + count(null >= observed)) / (1 + len(null))."""
    null_arr = np.asarray(null, dtype=float)
    count = int(np.sum(null_arr >= observed))
    return float((1 + count) / (1 + len(null_arr)))


def random_entry_null(
    evaluate: Callable[[list[tuple[str, int, str]]], float],
    eligible: dict[str, Sequence[int] | np.ndarray],
    n_by_symbol: dict[str, int],
    hold_bars: int,
    side_share: float,
    n_draws: int,
    seed: int,
) -> np.ndarray:
    """Null distribution by sampling random entry bars without overlap per symbol."""
    rng = np.random.default_rng(seed)
    null_stats = np.empty(n_draws, dtype=float)
    eligible_arrs = {sym: np.asarray(bars, dtype=np.int64) for sym, bars in eligible.items()}

    for draw_idx in range(n_draws):
        entries: list[tuple[str, int, str]] = []
        for sym, count in n_by_symbol.items():
            if count <= 0:
                continue
            pool = eligible_arrs[sym]
            if len(pool) < count:
                raise RuntimeError(f"Not enough eligible bars for symbol {sym}: {len(pool)} < {count}")

            accepted = False
            for _ in range(1000):
                chosen = rng.choice(pool, size=count, replace=False)
                chosen.sort()
                if count <= 1 or np.all(np.diff(chosen) >= hold_bars):
                    accepted = True
                    for bar in chosen:
                        side = "long" if rng.random() < side_share else "short"
                        entries.append((sym, int(bar), side))
                    break
            if not accepted:
                raise RuntimeError(f"Failed to find non-overlapping entries for {sym} within 1000 rejection tries")

        null_stats[draw_idx] = evaluate(entries)

    return null_stats


def circular_block_shuffle(
    values: Sequence[Any] | np.ndarray,
    block_len: int,
    rng: np.random.Generator | int | None = None,
) -> np.ndarray:
    """Circular block shuffle: rotate series randomly then permute contiguous blocks."""
    if block_len <= 0:
        raise ValueError("block_len must be positive")
    arr = np.asarray(values)
    n = len(arr)
    if n <= 1:
        return arr.copy()

    gen = np.random.default_rng(rng)
    offset = int(gen.integers(0, n))
    rotated = np.roll(arr, offset, axis=0)

    blocks = [rotated[i : i + block_len] for i in range(0, n, block_len)]
    perm = gen.permutation(len(blocks))
    permuted = [blocks[p] for p in perm]
    return np.concatenate(permuted, axis=0)


def shuffled_label_null(
    run_pipeline: Callable[[dict[str, np.ndarray]], float],
    labels_by_symbol: dict[str, Sequence[Any] | np.ndarray],
    block_len: int,
    n_perm: int,
    seed: int,
) -> np.ndarray:
    """Null distribution by circular-block shuffling labels per symbol independently."""
    rng = np.random.default_rng(seed)
    null_stats = np.empty(n_perm, dtype=float)

    for i in range(n_perm):
        shuffled = {sym: circular_block_shuffle(labels, block_len, rng) for sym, labels in labels_by_symbol.items()}
        null_stats[i] = run_pipeline(shuffled)

    return null_stats


def _parse_side(s: Any) -> float:
    """Parse a trade side indicator into +1.0 (long) or -1.0 (short)."""
    if isinstance(s, (int, float, np.integer, np.floating)):
        return float(s)
    s_str = str(s).strip().lower()
    if s_str in ("long", "buy", "1", "+1"):
        return 1.0
    if s_str in ("short", "sell", "-1"):
        return -1.0
    raise ValueError(f"Unknown side: {s!r}")


def coin_mean_hourly(log_returns_hourly: Sequence[float] | np.ndarray) -> float:
    """Mean of a coin's hourly log returns over the span, NaN-aware."""
    arr = np.asarray(log_returns_hourly, dtype=float)
    if arr.size == 0:
        return float("nan")
    valid = ~np.isnan(arr)
    if not np.any(valid):
        return float("nan")
    return float(np.mean(arr[valid]))


def drift_free_trade_returns(
    sides: Sequence[Any] | np.ndarray | str | float | int,
    gross_log_returns: Sequence[float] | np.ndarray | float,
    hold_hours: Sequence[float] | np.ndarray | float,
    coin_mean_hourly: float | Sequence[float] | np.ndarray,
    costs: Sequence[float] | np.ndarray | float,
) -> np.ndarray:
    """Element-wise drift-free trade returns: side * (r - m * hold) - costs."""
    sides_raw = np.asarray(sides)
    if sides_raw.ndim == 0:
        s: float | np.ndarray = _parse_side(sides_raw.item())
    elif np.issubdtype(sides_raw.dtype, np.number):
        s = sides_raw.astype(float)
    else:
        s = np.array([_parse_side(x) for x in sides_raw.flat], dtype=float).reshape(sides_raw.shape)

    r = np.asarray(gross_log_returns, dtype=float)
    h = np.asarray(hold_hours, dtype=float)
    m = np.asarray(coin_mean_hourly, dtype=float)
    c = np.asarray(costs, dtype=float)

    out = s * (r - m * h) - c
    return np.asarray(out, dtype=float)


def joint_shift_null(
    evaluate: Callable[[list[tuple[str, int, str, float, int]]], float],
    entries: Sequence[tuple[str, int, str, float, int]],
    n_bars: int,
    min_shift_bars: int,
    n_draws: int,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Null distribution by circular time shifts of the joint entry set.

    Preserves entry clustering across coins by shifting all entries by the same offset.
    Drops entries whose holding window wraps past the common bar grid.
    """
    if n_bars <= 0:
        raise ValueError("n_bars must be positive")
    if min_shift_bars < 0:
        raise ValueError("min_shift_bars must be non-negative")
    max_shift = n_bars - min_shift_bars
    if min_shift_bars > max_shift:
        raise ValueError("min_shift_bars must be <= n_bars - min_shift_bars")
    if n_draws < 0:
        raise ValueError("n_draws must be non-negative")

    null_stats = np.empty(n_draws, dtype=float)
    dropped_counts = np.empty(n_draws, dtype=np.int64)
    if n_draws == 0:
        return (null_stats, dropped_counts)

    rng = np.random.default_rng(seed)
    entry_list = list(entries)

    for draw_idx in range(n_draws):
        s = int(rng.integers(min_shift_bars, max_shift, endpoint=True))
        shifted_entries: list[tuple[str, int, str, float, int]] = []
        dropped = 0
        for entry in entry_list:
            sym, bar, side, size, hold = entry
            bar_prime = (bar + s) % n_bars
            if bar_prime + hold > n_bars:
                dropped += 1
            else:
                shifted_entries.append((sym, bar_prime, side, size, hold))

        dropped_counts[draw_idx] = dropped
        null_stats[draw_idx] = evaluate(shifted_entries)

    return (null_stats, dropped_counts)


def hansen_spa(
    returns_matrix: Sequence[Sequence[float]] | np.ndarray,
    n_reps: int,
    mean_block_len: float,
    seed: int,
) -> tuple[float, float]:
    """Hansen (2005) Superior Predictive Ability (SPA) test with consistent p-value."""
    arr = np.asarray(returns_matrix, dtype=float)
    if arr.ndim != 2:
        raise ValueError("returns_matrix must be a 2-D array of shape (T, K)")
    t_periods, n_configs = arr.shape
    if t_periods < 3:
        raise ValueError("T must be >= 3 for Hansen SPA test")
    if n_configs < 1:
        raise ValueError("K must be >= 1")
    if n_reps <= 0:
        raise ValueError("n_reps must be positive")

    mean_k = np.mean(arr, axis=0)
    sqrt_t = math.sqrt(t_periods)

    rng = np.random.default_rng(seed)
    boot_means = np.empty((n_reps, n_configs), dtype=float)
    for b in range(n_reps):
        idx = stationary_bootstrap_indices(t_periods, mean_block_len, rng)
        boot_means[b] = np.mean(arr[idx], axis=0)

    ddof = 1 if n_reps > 1 else 0
    omega_k = np.std(sqrt_t * boot_means, axis=0, ddof=ddof)
    omega_safe = np.where(omega_k > 1e-12, omega_k, 1.0)

    t_k = np.where(omega_k > 1e-12, sqrt_t * mean_k / omega_safe, 0.0)
    t_spa = float(max(0.0, float(np.max(t_k))))

    # Consistent p-value recentering:
    # Recentre by mean_k * 1{ mean_k >= -sqrt(omega_k^2 / T * 2 * log(log(T))) }
    crit = np.sqrt((omega_k**2 / t_periods) * 2.0 * math.log(math.log(t_periods)))
    recentred_k = np.where(mean_k >= -crit, mean_k, 0.0)

    # Bootstrap statistic per rep: max(0, max_k sqrt(T) * (mean*_k - recentred_k) / omega_k)
    boot_stat_k = np.where(omega_k > 1e-12, sqrt_t * (boot_means - recentred_k) / omega_safe, 0.0)
    boot_max_k = np.max(boot_stat_k, axis=1)
    boot_stats = np.maximum(0.0, boot_max_k)

    p_consistent = float(np.mean(boot_stats >= t_spa))
    return (t_spa, p_consistent)
