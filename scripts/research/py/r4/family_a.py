"""Phase 5 family A: the 45 declared configurations, the no-refit twin and the refit question (A5.1).

FAMILY A DECLARATION (2026-11-04, declared in the commit that adds this module and the ledger entry round4-family-a,
before any family A configuration reads D). Draft 3 of .superpowers/sdd/round4/family-a-draft.md, reviewed by Opus
(DECLARABLE after its draft 2 check), Codex and agy. Nothing here reads data.
- Configurations: the 45 of family_a() (cap 48, 3 reserved). Features: all 40 of ALL_FEATURE_COLUMNS at 1h, and 39 at
  4h without ret_4h_last (NaN by design at 4h). The ctx block uses FEATURE_COLUMNS_B (27 at 1h, 26 at 4h). Slot book,
  unit size, exit E1, no family C filter, kind trial, first refit 2023-01-01, model seed 7 as a field. joint_shift_seed
  10,000,000 + k in registry order, and 10,000,045 + j for reserve slot j. SPA family index 0. Later families use the
  joint-seed base 10,000,000 + 1,000,000 x the family index.
- Item 3's N is max(120, the round's alpha-bearing count), 120. The report passes the round count (12 re-tests + 45).
- Tripwire: phase5.report_family runs the bar once without a tripwire, runs the 100-shift tripwire for every
  configuration whose items 1 to 3 pass, then runs the bar again with the largest positive count. The family halts if
  it exceeds 60. The second report is the result.
- Refit question: a no-refit twin from the reserve for every configuration in the second report's candidates, in rank
  order, outside the family matrix. refit_question bootstraps configuration minus twin (mean, 1,000 iterations, mean
  block 10 days, alpha 0.10, seed 7,000,000 + the registry index). The refit is adopted only if the lower bound is
  above zero. An unused reserve slot stays for a re-run after a code fix.
- Reports beside the bar, never gating: the A5.2 hedge cost with profile "standard" for every configuration passing
  item 1, the A1.10 account report for every configuration, the within-cell PBO, and the cost drag by cell.
- Family E applies its exits to at most the top 2 family A configurations by walk-forward drift-free daily Sharpe
  among those passing item 1, ties by registry order, and discloses that selection on A's D outcomes. Family D's score
  model is the A-lgbm specification (L1, fixed label, F, 24 months). Its weights and band follow A1.4 unless a further
  amendment changes them, and its cells, horizons and lookback are declared before family A's first D outcome or
  disclosed as chosen after.
- No declared configuration, seed, feature list or reserve rule changes after family A's first D outcome, except as
  M's re-run after a code fix. A defect that needs more re-runs than the reserve holds stops the family unless a
  further amendment provides otherwise.
- Disclosed: the allocation uses Phase 4 outcomes that describe cost structure only (noise drag, lambda, a*), no
  real-feature or re-test outcome. The triple-barrier label at 1h, the L2 setting, real features.py model inputs and
  the no-intercept ridge rest on synthetic checks only (neither the A5.1 reproduction check nor any C4 run covers
  them, A5.1 diff review F8). Item 2 does not bind in a mixed-cell family. The cost drag by cell is the mean daily
  costs column (fees and slippage), not the net mean (A5.1 diff review F1).
- Predictions: PREDICTIONS below (M's, and two diagnostics).
"""

from __future__ import annotations

import copy
from typing import Any

import numpy as np
import pandas as pd

from r4 import calibration, features, stats

FAMILY = "A"
FAMILY_INDEX = 0
JOINT_SEED_BASE = 10_000_000
RESERVE_SEED_BASE = 10_000_045
N_RESERVE = 3
REFIT_SEED_BASE = 7_000_000
FIRST_REFIT_MS = 1_672_531_200_000
MODEL_SEED = 7
REFIT_BOOTSTRAP_ITERATIONS = 1000
REFIT_BOOTSTRAP_BLOCK = 10
REFIT_ALPHA = 0.10

L2_PARAMS: dict[str, Any] = {
    "n_estimators": 400,
    "num_leaves": 7,
    "learning_rate": 0.03,
    "min_child_samples": 300,
    "subsample": 0.8,
    "subsample_freq": 1,
    "colsample_bytree": 0.8,
}

_DROP_4H = "ret_4h_last"
F_1H: tuple[str, ...] = tuple(features.ALL_FEATURE_COLUMNS)
F_4H: tuple[str, ...] = tuple(c for c in F_1H if c != _DROP_4H)
FCTX_1H: tuple[str, ...] = tuple(features.FEATURE_COLUMNS_B)
FCTX_4H: tuple[str, ...] = tuple(c for c in FCTX_1H if c != _DROP_4H)

_ALL_CELLS = ("C1", "C2", "C3", "C4", "C5")
_C245 = ("C2", "C4", "C5")
_C1245 = ("C1", "C2", "C4", "C5")
_NO_INTERCEPT = {"alpha": 1.0, "fit_intercept": False}

# (block, model, params, label, threshold, lookback months, feature set, cells), in the draft's table order.
_BLOCKS: tuple[tuple[str, str, dict[str, Any], str, float, int | None, str, tuple[str, ...]], ...] = (
    ("ridge", "ridge", {"alpha": 1.0}, "fixed", 0, 12, "F", _ALL_CELLS),
    ("ridge-ni", "ridge", _NO_INTERCEPT, "fixed", 0, 12, "F", _C245),
    ("ridge-t", "ridge", _NO_INTERCEPT, "fixed", 0.0015, 12, "F", _C245),
    ("logit", "logistic", {"C": 1.0}, "fixed", 0.02, 24, "F", _ALL_CELLS),
    ("lgbm", "lightgbm", calibration.LGBM_PARAMS, "fixed", 0.02, 24, "F", _ALL_CELLS),
    ("lgbm-m", "lightgbm", calibration.LGBM_PARAMS, "fixed", 0.05, 24, "F", _C1245),
    ("lgbm-r", "lightgbm", L2_PARAMS, "fixed", 0.02, 24, "F", _C1245),
    ("lgbm-tb", "lightgbm", calibration.LGBM_PARAMS, "triple_barrier", 0.02, 24, "F", _ALL_CELLS),
    ("lgbm-tb-m", "lightgbm", calibration.LGBM_PARAMS, "triple_barrier", 0.05, 24, "F", ("C2", "C5")),
    ("lgbm-all", "lightgbm", calibration.LGBM_PARAMS, "fixed", 0.02, None, "F", _C245),
    ("lgbm-12", "lightgbm", calibration.LGBM_PARAMS, "fixed", 0.02, 12, "F", _C245),
    ("lgbm-ctx", "lightgbm", calibration.LGBM_PARAMS, "fixed", 0.02, 24, "Fctx", _C245),
)

PREDICTIONS: dict[str, Any] = {
    "m": "no directional configuration meets the exploration bar",
    "diagnostics": {
        "items_1_to_3_passes": 0,
        "of": 45,
        "cost_drag_worst_first": ["C3", "C1", "C4", "C2", "C5"],
    },
}


def _feature_set(name: str, interval: str) -> list[str]:
    if name == "F":
        return list(F_1H if interval == "1h" else F_4H)
    return list(FCTX_1H if interval == "1h" else FCTX_4H)


def family_a() -> list[dict[str, Any]]:
    """The 45 declared configurations in the draft's table order, cells ascending within a block."""
    out: list[dict[str, Any]] = []
    for block, model, params, label, threshold, lookback, fset, cells in _BLOCKS:
        for cell in cells:
            interval, h_ms = calibration.CELLS[cell]
            out.append(
                {
                    "id": f"A_{block}_{cell}",
                    "kind": "trial",
                    "family": FAMILY,
                    "block": block,
                    "cell": cell,
                    "model": model,
                    "params": copy.deepcopy(params),
                    "features": _feature_set(fset, interval),
                    "interval": interval,
                    "h_ms": h_ms,
                    "label": label,
                    "side_rule": "sign" if model == "ridge" else "prob",
                    "threshold": threshold,
                    "size_rule": "unit",
                    "lookback_months": lookback,
                    "refit": "monthly",
                    "exit": "horizon",
                    "seed": MODEL_SEED,
                    "book": "slot",
                    "joint_shift_seed": JOINT_SEED_BASE + len(out),
                    "first_refit_ms": FIRST_REFIT_MS,
                }
            )
    return out


def family_a_twin(declared_id: str, slot: int) -> dict[str, Any]:
    """The no-refit twin of a declared configuration, run from reserve slot `slot`."""
    if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < N_RESERVE:
        raise ValueError(f"reserve slot must be an int in 0..{N_RESERVE - 1}, got {slot!r}")
    by_id = {c["id"]: c for c in family_a()}
    if declared_id not in by_id:
        raise ValueError(f"{declared_id!r} is not a declared family A configuration")
    twin = copy.deepcopy(by_id[declared_id])
    twin["id"] = f"A_twin{slot}_{declared_id}"
    twin["refit"] = "none"
    twin["lookback_months"] = None
    twin["joint_shift_seed"] = RESERVE_SEED_BASE + slot
    return twin


def refit_question(config_daily: pd.DataFrame, twin_daily: pd.DataFrame, registry_index: int) -> dict[str, Any]:
    """The monthly refit against its no-refit twin: a bootstrap of the daily drift-free difference (M, A5.1).

    The twin is reindexed to the configuration's daily index with 0 for missing days. The statistic is the mean, 1,000
    iterations, mean block 10 days, alpha 0.10, seed 7,000,000 plus the registry index. Adopted only if the lower
    bound is above zero.
    """
    cfg = config_daily["drift_free"].astype(float)
    twin = twin_daily["drift_free"].astype(float).reindex(cfg.index).fillna(0.0)
    diff = (cfg - twin).to_numpy(dtype=np.float64)
    seed = REFIT_SEED_BASE + int(registry_index)
    point, low, high = stats.bootstrap_ci(
        diff, np.mean, REFIT_BOOTSTRAP_ITERATIONS, REFIT_BOOTSTRAP_BLOCK, seed, alpha=REFIT_ALPHA
    )
    return {
        "point": float(point),
        "low": float(low),
        "high": float(high),
        "adopted": bool(low > 0.0),
        "seed": seed,
        "n": int(len(diff)),
        "alpha": REFIT_ALPHA,
        "iterations": REFIT_BOOTSTRAP_ITERATIONS,
        "mean_block": REFIT_BOOTSTRAP_BLOCK,
    }
