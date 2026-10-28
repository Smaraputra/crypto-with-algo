"""Pure daily e-process calibration simulator.

Conservative consistency check of the statistical recurrence under a simplified
correlated no-edge daily beta-hedged simulation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np

from r4.stats import wilson

WARMUP_BETS: int = 30
VARIANCE_EPS: float = 1e-6
CAP_LAMBDA: float = 0.5


def daily_eprocess(
    x: np.ndarray | Sequence[float],
    threshold: float = 600.0,
) -> dict[str, Any]:
    """Scalar reference recurrence for b=0, warmup=30, lambda=clip(m/(v+1e-6), 0, 0.5).

    Evaluates bets strictly from previous history.
    Ignores nonfinite observations and no-bet NaNs.
    x is capped above at 1.0. A value below -2.0 is counted at -2.0 and ends the test,
    per signed M, regardless of lambda.

    Parameters
    ----------
    x : np.ndarray or Sequence[float]
        1D array of daily betting outcomes.
    threshold : float, default=600.0
        Stopping boundary for test e-process. Must be finite and > 1.0.

    Returns
    -------
    dict[str, Any]
        Dictionary with keys:
        - n_bets: int (total bets processed before stopping)
        - crossed_at: int | None (observation index of first crossing, or None)
        - ended: bool (whether test was terminated by an observation < -2.0)
        - log_e: float (final log wealth)
        - lambdas: np.ndarray (bet sizes, one per observation in original array)
        - validated: bool (crossed_at is not None and not ended)
    """
    if not isinstance(threshold, (int, float, np.floating, np.integer)):
        raise ValueError("threshold must be a numeric value")
    if not np.isfinite(threshold) or threshold <= 1.0:
        raise ValueError(f"threshold must be finite and > 1.0, got {threshold}")

    x_arr = np.asarray(x, dtype=np.float64)
    if x_arr.ndim != 1:
        raise ValueError(f"x must be 1-dimensional, got shape {x_arr.shape}")

    n_obs = len(x_arr)
    lambdas = np.zeros(n_obs, dtype=np.float64)

    n_bets = 0
    sum_x = 0.0
    sum_x2 = 0.0
    log_e = 0.0
    crossed_at: int | None = None
    ended = False

    threshold_log = math.log(threshold)

    for i in range(n_obs):
        if ended:
            lambdas[i] = 0.0
            continue

        val = x_arr[i]
        if not np.isfinite(val):
            lambdas[i] = 0.0
            continue

        # Predictable bet size strictly from previous bets
        if n_bets < WARMUP_BETS:
            lam = 0.0
        else:
            m = sum_x / n_bets
            v = max(0.0, (sum_x2 / n_bets) - (m * m))
            raw = m / (v + VARIANCE_EPS)
            lam = float(np.clip(raw, 0.0, CAP_LAMBDA))

        lambdas[i] = lam

        # Cap above at 1
        x_cap = min(float(val), 1.0)

        # A value below -2 is counted at -2 and ends the test
        if x_cap < -2.0:
            x_eff = -2.0
            hit_end = True
        else:
            x_eff = x_cap
            hit_end = False

        # Update running stats
        n_bets += 1
        sum_x += x_eff
        sum_x2 += x_eff * x_eff

        # Update log wealth
        factor = 1.0 + lam * x_eff
        if factor <= 0.0:
            log_e = -math.inf
        else:
            log_e += math.log(factor)

        if hit_end:
            ended = True
            # Ended test cannot validate or cross
        elif crossed_at is None and log_e >= threshold_log:
            crossed_at = i

    validated = (crossed_at is not None) and (not ended)

    return {
        "n_bets": n_bets,
        "crossed_at": crossed_at,
        "ended": ended,
        "log_e": log_e,
        "lambdas": lambdas,
        "validated": validated,
    }


def simulate_daily_null(
    covariance: np.ndarray | Sequence[Sequence[float]],
    betas: np.ndarray | Sequence[float],
    *,
    n_paths: int,
    n_days: int = 730,
    seed: int = 20261025,
    scale: float,
    batch_size: int = 256,
    threshold: float = 600.0,
) -> dict[str, Any]:
    """Simulate daily beta-hedged null paths under multivariate Gaussian returns.

    Parameters
    ----------
    covariance : ndarray
        Symmetric positive semi-definite covariance matrix of daily log returns.
    betas : ndarray
        1D array of hedge betas matching covariance dimension.
    n_paths : int
        Number of independent paths to simulate. Must be positive.
    n_days : int, default=730
        Number of days per path. Must be positive.
    seed : int, default=20261025
        RNG seed for reproducibility.
    scale : float
        Scaling divisor for daily outcome x = min(D_d / scale, 1.0). Must be positive.
    batch_size : int, default=256
        Batch size for path vectorization to bound memory. Must be positive.
    threshold : float, default=600.0
        E-process threshold. Default 600.0.

    Returns
    -------
    dict[str, Any]
        Dictionary with simulation metrics, parameters, and assumptions.
    """
    # Validate covariance
    cov = np.asarray(covariance, dtype=np.float64)
    if cov.ndim != 2 or cov.shape[0] != cov.shape[1]:
        raise ValueError(f"covariance must be a 2D square matrix, got shape {cov.shape}")
    if not np.all(np.isfinite(cov)):
        raise ValueError("covariance must contain only finite values")
    if not np.allclose(cov, cov.T, atol=1e-8, rtol=1e-5):
        raise ValueError("covariance must be symmetric")

    n_coins = cov.shape[0]
    if n_coins == 0:
        raise ValueError("covariance matrix dimension must be positive")

    # Eigendecomposition allowing singular PSD
    evals, evecs = np.linalg.eigh(cov)
    min_eval = float(np.min(evals))
    roundoff = 10 * np.finfo(np.float64).eps * n_coins * float(np.max(np.abs(evals)))
    if min_eval < -roundoff:
        raise ValueError(f"covariance must be positive semi-definite; minimum eigenvalue is {min_eval:.6e}")
    evals_clipped = np.maximum(evals, 0.0)
    l_factor = evecs * np.sqrt(evals_clipped)  # cov = l_factor @ l_factor.T

    # Validate betas
    b_arr = np.asarray(betas, dtype=np.float64)
    if b_arr.ndim != 1 or b_arr.shape[0] != n_coins:
        raise ValueError(f"betas dimension ({b_arr.shape}) must match covariance dimension ({n_coins},)")
    if not np.all(np.isfinite(b_arr)):
        raise ValueError("betas must contain only finite values")

    # Validate integer / scalar counts
    if not isinstance(n_paths, (int, np.integer)) or n_paths <= 0:
        raise ValueError(f"n_paths must be a positive integer, got {n_paths}")
    if not isinstance(n_days, (int, np.integer)) or n_days <= 0:
        raise ValueError(f"n_days must be a positive integer, got {n_days}")
    if not isinstance(batch_size, (int, np.integer)) or batch_size <= 0:
        raise ValueError(f"batch_size must be a positive integer, got {batch_size}")
    if not isinstance(seed, (int, np.integer)):
        raise ValueError(f"seed must be an integer, got {seed}")
    if not isinstance(scale, (int, float, np.floating, np.integer)) or not np.isfinite(scale) or scale <= 0.0:
        raise ValueError(f"scale must be a positive finite number, got {scale}")
    if (
        not isinstance(threshold, (int, float, np.floating, np.integer))
        or not np.isfinite(threshold)
        or threshold <= 1.0
    ):
        raise ValueError(f"threshold must be finite and > 1.0, got {threshold}")

    threshold_log = math.log(threshold)

    # Deterministic per-path seeds to guarantee batch-size independence
    ss = np.random.SeedSequence(seed)
    child_seeds = ss.spawn(n_paths)

    total_crossing_count = 0
    total_ended_count = 0
    total_validated_count = 0

    for p_start in range(0, n_paths, batch_size):
        p_end = min(p_start + batch_size, n_paths)
        b_size = p_end - p_start

        # Draw iid standard normal per path
        z = np.empty((b_size, n_days, n_coins), dtype=np.float64)
        for i, p_idx in enumerate(range(p_start, p_end)):
            rng = np.random.default_rng(child_seeds[p_idx])
            z[i] = rng.standard_normal((n_days, n_coins))

        # Log returns R = Z @ L.T
        r = z @ l_factor.T

        # Predictable weights: side=sign(previous day's return), zero on day zero
        w = np.zeros_like(r)
        if n_days > 1:
            w[:, 1:, :] = np.sign(r[:, :-1, :]) / float(n_coins)

        # Portfolio daily return D_d = sum w_i * (r_i - beta_i * mean(r))
        mean_r = np.mean(r, axis=-1, keepdims=True)  # (b_size, n_days, 1)
        excess_r = r - b_arr * mean_r  # (b_size, n_days, n_coins)
        d = np.sum(w * excess_r, axis=-1)  # (b_size, n_days)
        if not np.all(np.isfinite(d)):
            raise ValueError("simulated returns must remain finite")

        # All values below -2 have the same stopping effect. Keep overflow negative.
        with np.errstate(over="ignore"):
            x_series = np.clip(d / scale, -3.0, 1.0)
        x_series[~np.any(w != 0.0, axis=-1)] = np.nan

        # Vectorized state across paths in batch
        log_e = np.zeros(b_size, dtype=np.float64)
        n_bets = np.zeros(b_size, dtype=np.int32)
        sum_x = np.zeros(b_size, dtype=np.float64)
        sum_x2 = np.zeros(b_size, dtype=np.float64)
        crossed = np.zeros(b_size, dtype=bool)
        ended = np.zeros(b_size, dtype=bool)

        for day in range(n_days):
            if np.all(ended):
                break
            active = (~ended) & np.isfinite(x_series[:, day])
            if not np.any(active):
                continue

            x_val = x_series[:, day]
            lam = np.zeros(b_size, dtype=np.float64)

            # Warmup check: paths with at least 30 bets
            warmed = active & (n_bets >= WARMUP_BETS)
            if np.any(warmed):
                m = sum_x[warmed] / n_bets[warmed]
                v = np.maximum(0.0, (sum_x2[warmed] / n_bets[warmed]) - (m * m))
                raw = m / (v + VARIANCE_EPS)
                lam[warmed] = np.clip(raw, 0.0, CAP_LAMBDA)

            # Value below -2 ends test and is counted at -2
            hit_end = active & (x_val < -2.0)
            x_eff = np.where(hit_end, -2.0, x_val)

            # Update wealth factor
            factor = 1.0 + lam * x_eff
            pos_factor = active & (factor > 0.0)
            log_e[pos_factor] += np.log(factor[pos_factor])
            zero_factor = active & (factor <= 0.0)
            log_e[zero_factor] = -np.inf

            # Update running moments
            sum_x[active] += x_eff[active]
            sum_x2[active] += x_eff[active] * x_eff[active]
            n_bets[active] += 1

            # Check crossing on this step for paths that did not end
            now_crossed = active & (~hit_end) & (~crossed) & (log_e >= threshold_log)
            crossed |= now_crossed

            ended |= hit_end

        # Ville's bound concerns any crossing, including paths that later end.
        total_crossing_count += int(np.sum(crossed))
        total_ended_count += int(np.sum(ended))
        total_validated_count += int(np.sum(crossed & ~ended))

    crossing_rate = float(total_crossing_count / n_paths)
    ended_rate = float(total_ended_count / n_paths)
    w_low, w_high = wilson(total_crossing_count, n_paths)
    nominal_bound = float(1.0 / threshold)

    assumptions = (
        "This is a simplified daily book, not an exact finalist replay or proof of validity. "
        "Evaluates zero-mean Gaussian daily returns under empirical covariance with prior-day sign weights."
    )

    parameters = {
        "n_paths": n_paths,
        "n_days": n_days,
        "scale": float(scale),
        "batch_size": batch_size,
        "threshold": float(threshold),
        "n_coins": n_coins,
    }

    return {
        "parameters": parameters,
        "assumptions": assumptions,
        "crossing_count": total_crossing_count,
        "crossing_rate": crossing_rate,
        "ended_count": total_ended_count,
        "ended_rate": ended_rate,
        "validated_count": total_validated_count,
        "wilson_95": [float(w_low), float(w_high)],
        "wilson_95_interval": [float(w_low), float(w_high)],
        "nominal_bound": nominal_bound,
        "seed": seed,
    }


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entrypoint for r4.calibration_null."""
    parser = argparse.ArgumentParser(
        description="Pure daily e-process calibration simulator CLI",
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Path to input JSON containing covariance, betas, scale",
    )
    parser.add_argument(
        "--paths",
        type=int,
        required=True,
        help="Number of simulation paths",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=730,
        help="Number of days per path (default: 730)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=20261025,
        help="RNG seed (default: 20261025)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=256,
        help="Batch size for vectorization (default: 256)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=600.0,
        help="E-process threshold (default: 600.0)",
    )
    parser.add_argument(
        "--commit",
        default=None,
        help="Commit sha of the code (default: the R4_COMMIT environment variable, else none is recorded)",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Path to output JSON file",
    )

    args = parser.parse_args(argv)

    input_path = Path(args.input)
    if not input_path.exists():
        sys.stderr.write(f"Error: input file '{args.input}' does not exist\n")
        return 1

    input_bytes = input_path.read_bytes()
    input_sha256 = hashlib.sha256(input_bytes).hexdigest()

    try:
        payload = json.loads(input_bytes.decode("utf-8"))
    except Exception as exc:
        sys.stderr.write(f"Error parsing input JSON: {exc}\n")
        return 1

    if not isinstance(payload, dict):
        sys.stderr.write("Error: input JSON must be a top-level dictionary\n")
        return 1

    for required_key in ("covariance", "betas", "scale"):
        if required_key not in payload:
            sys.stderr.write(f"Error: missing required input key '{required_key}'\n")
            return 1

    cov_raw = payload["covariance"]
    betas_raw = payload["betas"]
    scale_raw = payload["scale"]

    try:
        cov = np.asarray(cov_raw, dtype=np.float64)
        betas = np.asarray(betas_raw, dtype=np.float64)
        scale = float(scale_raw)
    except Exception as exc:
        sys.stderr.write(f"Error converting input numeric arrays: {exc}\n")
        return 1

    if not np.all(np.isfinite(cov)) or not np.all(np.isfinite(betas)) or not np.isfinite(scale):
        sys.stderr.write("Error: non-finite values detected in input\n")
        return 1

    try:
        result = simulate_daily_null(
            cov,
            betas,
            n_paths=args.paths,
            n_days=args.days,
            seed=args.seed,
            scale=scale,
            batch_size=args.batch_size,
            threshold=args.threshold,
        )
    except Exception as exc:
        sys.stderr.write(f"Simulation error: {exc}\n")
        return 1

    from r4.cli import _SHA_RE, reproduction_inputs

    commit = args.commit if args.commit else os.environ.get("R4_COMMIT") or None
    if commit is not None and not _SHA_RE.fullmatch(commit):
        sys.stderr.write(f"Error: the commit {commit!r} is not a 7 to 40 character hex sha\n")
        return 1
    repro = reproduction_inputs()
    result["input_sha256"] = input_sha256
    result["pilot"] = payload.get("pilot")
    # The code freeze evidence the dossier checks, and the dataset D's covariance was taken from.
    result["dcov_dataset_hash"] = payload.get("dcov_dataset_hash")
    result["provenance"] = {
        "commits": [commit],
        "source_sha256": [repro["source_sha256"]],
        "requirements_lock_sha256": [repro["requirements_lock_sha256"]],
        "versions": [repro["versions"]],
    }
    result["reproduction"] = repro

    try:
        out_json_str = json.dumps(result, allow_nan=False, indent=2)
    except ValueError as exc:
        sys.stderr.write(f"Serialization error (non-finite or NaN in output): {exc}\n")
        return 1

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(out_json_str, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
