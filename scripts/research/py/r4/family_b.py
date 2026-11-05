"""Phase 5 family B: the 18 declared meta-labelled and primary-alone books and the Tier B noise mini-control (A8).

FAMILY B DECLARATION (draft 4 of .superpowers/sdd/round4/family-b-draft.md under Amendment 8, A8.1 to A8.6, signed by
the owner on 2026-11-05). This module is declared in the commit that adds the ledger entries round4-family-b and
round4-family-b-noise, before any family B configuration reads D. Nothing here reads D. The code outline is
.superpowers/sdd/round4/family-b-engineering.md.
- Plan of record: a secondary LightGBM classifier that predicts whether a primary signal's trade nets above zero, acts
  above a fixed probability and sizes by it. Primaries: v8 direction (research only, A8.3), BTC lead-lag continuation
  (ll), the 5m RSI(7) reversal (rsi), the small-trade imbalance fade (sti, Tier B) and the positioning fade (pos,
  Tier B). The primary's own result at size 1 is the baseline (model "rule", A8.2). Cap 24, alpha-bearing, family
  index 1.
- Configurations: 18 declared in the order of the draft's table (blocks rule, meta24, metaall, meta12, metaall of Tier
  B, and within a block v8 at 1h, v8 at 4h, ll, rsi, sti, pos), 6 reserved. Every configuration: family B, book slot,
  exit E1, label "meta", kind trial, first refit 2024-01-01, monthly refit, model seed 7. joint_shift_seed 11,000,000
  + k in registry order and 11,000,018 + j for reserve slot j. Rule configurations take the primary's side at size 1
  (A8.2). Meta configurations act at p > 0.5 and size by 2 Phi((p - 0.5) / sqrt(p (1 - p))) - 1 (A8.4).
- The mini-control (A8.6): 8 controls, kind control, a hash-noise side and hash-noise features on the rows of the real
  sti or pos frame, activity floor 1,000 walk-forward tranches, a synthetic activity check before registration.
- Seeds: refit-question bootstrap 7,200,000 + the registry index, paired comparisons 11,800,000 (net) and 11,900,000
  (cost-free) + the meta configuration's registry index, mini-control noise_seed 11,500,000 + j + 100 x attempt and
  joint_shift_seed 11,600,000 + j, the synthetic panel 11,700,000, the SPA 6,000,001, the model seed 7. No other
  randomness.
- Ledger: round4-family-b 18 trials and round4-family-b-noise 8 controls. Reserve slots are appended when consumed.
- No configuration, frame, feature list, primary definition, seed, bound or reserve rule changes after the first D
  read, except as M's re-run after a code fix.
- Predictions: PREDICTIONS below.
"""

from __future__ import annotations

import contextlib
import copy
import dataclasses
import hashlib
import json
import math
from collections.abc import Iterator, Mapping, Sequence
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy.special import ndtr

from r4 import calibration, features, hashfeat, labels, stats
from r4.method import (
    DEV_END,
    ENTRY_DELAY_MS,
    TIER_B_START,
    WF_FIRST_REFIT_TIER_B,
)

FAMILY = "B"
FAMILY_INDEX = 1
CAP = 24
FIRST_REFIT_MS = WF_FIRST_REFIT_TIER_B
JOINT_SHIFT_SEED_BASE = 11_000_000
REFIT_SEED_BASE = 7_200_000
PAIR_SEED_NET = 11_800_000
PAIR_SEED_CF = 11_900_000
NOISE_SEED_BASE = 11_500_000
NOISE_JOINT_SEED_BASE = 11_600_000
NOISE_ALT_STEP = 100
NOISE_MAX_ATTEMPT = 2
SYNTH_SEED = 11_700_000
NOISE_SIDE_INDEX = 99
P_STAR = 0.5
MODEL_SEED = 7

H1_MS = 3_600_000
M5_MS = 300_000
DAY_MS = 86_400_000

PRIMARIES: tuple[str, ...] = ("b_v8", "b_ll", "b_rsi", "b_sti", "b_pos")
NOISE_SIDE_RULES: tuple[str, ...] = ("b_noise_sti", "b_noise_pos")
# The real primary whose frame a noise side rule borrows (A8.6: "The frame is the rows of the real sti or pos
# configuration").
NOISE_FRAME_RULE: dict[str, str] = {"b_noise_sti": "b_sti", "b_noise_pos": "b_pos"}
# The model feature a primary adds beside F and b_side (v8 has none: the export carries no score).
SIGNAL_COLUMN: dict[str, str] = {"b_ll": "b_ll_z", "b_rsi": "b_rsi5", "b_sti": "b_sti", "b_pos": "b_pos_z"}
EXTRA_COLUMNS: tuple[str, ...] = ("b_side", *SIGNAL_COLUMN.values())

# Lead-lag (ll): the port of computeBtcLeadLagRaw, trailingZScore and shiftForwardOneBar.
LL_Z = 1.5
LL_WINDOW_ROWS = 720
LL_MIN_SAMPLES = 30
LL_WARMUP_BARS = 199  # b_ll_fixture.json params.warmupBars_W (strategy-harness.ts:733-735 at 1h)
# 5m RSI(7) and its monthly 10% tails (rsi).
RSI_PERIOD = 7
RSI_WARMUP_BARS = 51  # b_rsi_fixture.json params.matrix_warmupBars (computeFactorMatrix, scalping style)
RSI_TAIL = 0.10
RSI_LOOKBACK_DAYS = 90
RSI_MIN_VALUES = 200
# Small-trade imbalance (sti, Tier B).
STI_WARMUP_BARS = 199  # b_sti_fixture.json params.matrix_warmupBars_W (computeFactorMatrix at 1h)
STI_BUCKETS = 12
QUARTER_HOUR_MS = 900_000
# Positioning (pos, Tier B).
POS_POINTS = 180
POS_PERIOD_MS = POS_LAG_MS = 4 * H1_MS
POS_HOURS_UTC: tuple[int, ...] = (0, 8, 16)

# The v8 decisions (A8.1).
V8_DECISION_SOURCE = "48ff79609080f11a48c45822f27cd609818b913b2d42455cddf4ea1ef4806e93"
V8_SUMMARY_CANONICAL_SHA256: dict[str, str] = {
    "1h": "1a217d0c794d11507561a2f7e88ed009f83c307967ceefc97c9a4a5faa02a7ef",
    "4h": "87a5c1da2e8fb926143ab21bff99a548aec9837e9fea236fe46005a817872a74",
}
V8_TRANCHES_SHA256: dict[str, str] = {
    "1h": "2778c45b5adef5e3881f1717e9b62fd7edfc33dbe558dfeaf5600bfcdce377d8",
    "4h": "50fd3966acfb41c4b79c2d073f2f42f79283c5e10580d6d486e6d4f78895c7fd",
}
V8_MAX_HOLD_MS: dict[str, int] = {"1h": 24 * H1_MS, "4h": 120 * H1_MS}
V8_ASSERT_FROM_MS = 1_701_475_200_000  # 2023-12-02 UTC
V8_GRID_CERT: tuple[str, str] = (
    "records/v8_spot_grid_48ff7960.json",
    "410dd7c733f1d1095504ac5cd05320772cdace4952271ce21d58cc55220a5880",
)
_PY_ROOT = Path(__file__).resolve().parents[1]

# The mini-control (A8.6).
TRADE_FLOOR_TRANCHES = 1000
INFORMATIVE_MIN_PER_FRAME = 3
NOISE_BOUNDS: dict[str, int] = {"pass_items_1_to_3_max": 0, "joint_shift_reject_max": 2}

# Counting: 12 re-tests + 45 family A + 9 family D. Family D used no reserve slot.
ALPHA_BEFORE_B = 66

PREDICTIONS: dict[str, Any] = {
    "m": "no directional configuration meets the exploration bar",
    "gated": {
        "mini_control": {
            "informative_min_active_per_frame": INFORMATIVE_MIN_PER_FRAME,
            "of_per_frame": 4,
            "trade_floor_tranches": TRADE_FLOOR_TRANCHES,
            "items_1_to_3_passes_at_most": NOISE_BOUNDS["pass_items_1_to_3_max"],
            "of": 8,
            "joint_shift_rejections_at_most": NOISE_BOUNDS["joint_shift_reject_max"],
        }
    },
    "diagnostics": {
        "items_1_to_3_passes": 0,
        "of": 18,
        "b_rule_v8_c5_fails_item_3": True,
        "meta_acts_on_fewer_than_half_of_primary_decisions": True,
        "of_meta_configurations": 12,
        "meta_mean_daily_cost_below_its_rule_configuration": True,
        "of_pairs": 12,
    },
}

DECISION_COLUMNS = [
    "phase",
    "block_start",
    "T",
    "symbol",
    "b_side",
    "p",
    "acted",
    "size",
    "abs_weight",
    "net",
]
FIT_COLUMNS = [
    "phase",
    "fit",
    "train_t_min",
    "train_t_max",
    "n_train",
    "rows",
    "positives",
    "base_rate",
    "degenerate",
]


def _n_bars(interval: str, h_ms: int) -> float:
    return float(h_ms) / float(3_600_000 if interval == "1h" else 14_400_000)


# ---------------------------------------------------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------------------------------------------------

# (primary, cell) in the declaration's order. v8 appears twice: at 1h (C2) and at 4h (C5).
_PRIMARY_CELLS: tuple[tuple[str, str], ...] = (
    ("v8", "C2"),
    ("v8", "C5"),
    ("ll", "C1"),
    ("rsi", "C1"),
    ("sti", "C1"),
    ("pos", "C4"),
)
_TIER_B_PRIMARIES = ("sti", "pos")

# (block, model, lookback months or None, the primaries of the block), in the declaration's order.
_BLOCKS: tuple[tuple[str, str, int | None, tuple[str, ...]], ...] = (
    ("rule", "rule", None, ("v8:C2", "v8:C5", "ll:C1", "rsi:C1", "sti:C1", "pos:C4")),
    ("meta24", "lightgbm", 24, ("v8:C2", "v8:C5", "ll:C1", "rsi:C1")),
    ("metaall", "lightgbm", None, ("v8:C2", "v8:C5", "ll:C1", "rsi:C1")),
    ("meta12", "lightgbm", 12, ("sti:C1", "pos:C4")),
    ("metaall", "lightgbm", None, ("sti:C1", "pos:C4")),
)


def frame_features(interval: str) -> tuple[str, ...]:
    """F: ALL_FEATURE_COLUMNS at 1h and the same less ret_4h_last at 4h (family A's F)."""
    cols = tuple(features.ALL_FEATURE_COLUMNS)
    return cols if interval == "1h" else tuple(c for c in cols if c != "ret_4h_last")


def _config_features(primary: str, interval: str) -> list[str]:
    cols = [*frame_features(interval), "b_side"]
    sig = SIGNAL_COLUMN.get(f"b_{primary}")
    if sig is not None:
        cols.append(sig)
    return cols


def family_b() -> list[dict[str, Any]]:
    """The 18 declared configurations, k = 0 to 17, in the draft's table order."""
    out: list[dict[str, Any]] = []
    for block, model, lookback, entries in _BLOCKS:
        for entry in entries:
            primary, cell = entry.split(":")
            interval, h_ms = calibration.CELLS[cell]
            rule = model == "rule"
            tag = "metaall" if block == "metaall" else block
            out.append(
                {
                    "id": f"B_{tag}_{primary}_{cell}",
                    "kind": "trial",
                    "family": FAMILY,
                    "block": block,
                    "cell": cell,
                    "primary": primary,
                    "model": model,
                    "params": {} if rule else copy.deepcopy(calibration.LGBM_PARAMS),
                    "features": _config_features(primary, interval),
                    "interval": interval,
                    "h_ms": h_ms,
                    "label": "meta",
                    "side_rule": f"b_{primary}",
                    "threshold": 0.0 if rule else P_STAR,
                    "size_rule": "unit" if rule else "afml",
                    "lookback_months": lookback,
                    "refit": "monthly",
                    "exit": "horizon",
                    "seed": MODEL_SEED,
                    "book": "slot",
                    "joint_shift_seed": JOINT_SHIFT_SEED_BASE + len(out),
                    "first_refit_ms": FIRST_REFIT_MS,
                }
            )
    return out


N_DECLARED = len(family_b())
N_RESERVE = CAP - N_DECLARED
RESERVE_SEED_BASE = JOINT_SHIFT_SEED_BASE + N_DECLARED

# j = 0 to 7: (frame, cell, lookback months or None, tag of the lookback, seed ordinal), in the declaration's order.
_NOISE_SPECS: tuple[tuple[str, str, int | None, str, int], ...] = (
    ("sti", "C1", 12, "12", 1),
    ("sti", "C1", 12, "12", 2),
    ("sti", "C1", None, "all", 1),
    ("sti", "C1", None, "all", 2),
    ("pos", "C4", 12, "12", 1),
    ("pos", "C4", 12, "12", 2),
    ("pos", "C4", None, "all", 1),
    ("pos", "C4", None, "all", 2),
)


# The attempt of each control j after the synthetic activity check (A8.6). The declaring commit carries the final
# attempts of the check's record (records/synth_b_noise_<sha>.json); until then every control is at attempt 0.
NOISE_FINAL_ATTEMPTS: tuple[int, ...] = (0, 0, 0, 0, 0, 0, 0, 0)


def family_b_noise(attempts: Sequence[int] | None = None) -> list[dict[str, Any]]:
    """The 8 mini-control configurations (kind control). attempts[j] is the attempt of control j.

    The default is NOISE_FINAL_ATTEMPTS, the final seeds of the synthetic activity check.

    noise_seed is 11,500,000 + j + 100 x attempt, joint_shift_seed 11,600,000 + j whatever the attempt. An attempt 1 or
    2 adds the id suffix _alt<attempt> and the fields replaces and attempt, as calibration.noise_alternative does.
    """
    att = [int(a) for a in (NOISE_FINAL_ATTEMPTS if attempts is None else attempts)]
    if len(att) != len(_NOISE_SPECS):
        raise ValueError(f"attempts must hold {len(_NOISE_SPECS)} entries, got {len(att)}")
    out: list[dict[str, Any]] = []
    for j, (frame, cell, lookback, tag, ordinal) in enumerate(_NOISE_SPECS):
        attempt = att[j]
        if isinstance(attempt, bool) or attempt not in range(NOISE_MAX_ATTEMPT + 1):
            raise ValueError(f"attempt must be 0, 1 or 2, got {attempt!r}")
        interval, h_ms = calibration.CELLS[cell]
        base_id = f"B_noise_{frame}_{cell}_{tag}_s{ordinal}"
        cfg: dict[str, Any] = {
            "id": base_id if attempt == 0 else f"{base_id}_alt{attempt}",
            "kind": "control",
            "family": FAMILY,
            "block": f"noise_{frame}_{tag}",
            "cell": cell,
            "model": "lightgbm",
            "params": copy.deepcopy(calibration.LGBM_PARAMS),
            "features": [*calibration.NOISE_FEATURES, "b_side"],
            "interval": interval,
            "h_ms": h_ms,
            "label": "meta",
            "side_rule": f"b_noise_{frame}",
            "threshold": P_STAR,
            "size_rule": "afml",
            "lookback_months": lookback,
            "refit": "monthly",
            "exit": "horizon",
            "seed": MODEL_SEED,
            "book": "slot",
            "noise_seed": NOISE_SEED_BASE + j + NOISE_ALT_STEP * attempt,
            "joint_shift_seed": NOISE_JOINT_SEED_BASE + j,
            "first_refit_ms": FIRST_REFIT_MS,
        }
        if attempt:
            cfg["replaces"] = base_id
            cfg["attempt"] = attempt
        out.append(cfg)
    return out


def rule_of(meta_id: str) -> dict[str, Any]:
    """The rule configuration with the same primary and cell as a declared meta-labelled configuration."""
    by_id = {c["id"]: c for c in family_b()}
    if meta_id not in by_id:
        raise ValueError(f"{meta_id!r} is not a declared family B configuration")
    meta = by_id[meta_id]
    if meta["model"] != "lightgbm":
        raise ValueError(f"{meta_id!r} is not a meta-labelled configuration")
    for c in by_id.values():
        if c["model"] == "rule" and c["primary"] == meta["primary"] and c["cell"] == meta["cell"]:
            return copy.deepcopy(c)
    raise ValueError(f"no rule configuration for {meta_id!r}")  # pragma: no cover


def family_b_twin(declared_id: str, slot: int) -> dict[str, Any]:
    """The no-refit twin of a declared meta-labelled configuration, run from reserve slot `slot`."""
    if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < N_RESERVE:
        raise ValueError(f"reserve slot must be an int in 0..{N_RESERVE - 1}, got {slot!r}")
    by_id = {c["id"]: c for c in family_b()}
    if declared_id not in by_id:
        raise ValueError(f"{declared_id!r} is not a declared family B configuration")
    if by_id[declared_id]["model"] != "lightgbm":
        raise ValueError(f"{declared_id!r} has no fitted component: only lightgbm configurations have a twin")
    twin = copy.deepcopy(by_id[declared_id])
    twin["id"] = f"B_twin{slot}_{declared_id}"
    twin["refit"] = "none"
    twin["lookback_months"] = None
    twin["joint_shift_seed"] = RESERVE_SEED_BASE + slot
    return twin


def eligible(config: Mapping[str, Any]) -> bool:
    """A candidate or finalist is lightgbm with a primary other than v8 (A8.2, A8.3)."""
    return bool(config.get("model") == "lightgbm" and config.get("side_rule") != "b_v8")


ALLOWED_EXITS: tuple[str, ...] = ("E1", "E2", "E3", "E6", "X1")


def allowed_exits(config: Mapping[str, Any] | Any = None) -> tuple[str, ...]:
    """The exits family E may apply to a family B configuration (D11, A8.5). E4 and E5 are never applied.

    Every family B configuration carries b_side, which is no features.py column and no hash feature, so A5.1 refuses
    the two model exits there. Family E's own code calls this, or check_exit_allowed, before it applies an exit.
    """
    fam = config.get("family") if isinstance(config, Mapping) else getattr(config, "family", FAMILY)
    if fam != FAMILY:
        raise ValueError(f"allowed_exits is for family B configurations, got family {fam!r}")
    return ALLOWED_EXITS


def check_exit_allowed(config: Mapping[str, Any] | Any, rule: str) -> None:
    """Raise unless `rule` (E1, E2, ...) may be applied to the family B configuration. E4 and E5 raise."""
    if rule not in allowed_exits(config):
        raise ValueError(f"exit {rule} is never applied to a family B configuration (A8.5): allowed {ALLOWED_EXITS}")


def refit_question(config_daily: pd.DataFrame, twin_daily: pd.DataFrame, registry_index: int) -> dict[str, Any]:
    """The monthly refit against its no-refit twin: a bootstrap of the daily drift-free difference (M, A5.1).

    As family A's, with the seed 7,200,000 plus the registry index.
    """
    from r4 import family_a

    cfg = config_daily["drift_free"].astype(float)
    twin = twin_daily["drift_free"].astype(float).reindex(cfg.index).fillna(0.0)
    diff = (cfg - twin).to_numpy(dtype=np.float64)
    seed = REFIT_SEED_BASE + int(registry_index)
    point, low, high = stats.bootstrap_ci(
        diff,
        np.mean,
        family_a.REFIT_BOOTSTRAP_ITERATIONS,
        family_a.REFIT_BOOTSTRAP_BLOCK,
        seed,
        alpha=family_a.REFIT_ALPHA,
    )
    return {
        "point": float(point),
        "low": float(low),
        "high": float(high),
        "adopted": bool(low > 0.0),
        "seed": seed,
        "n": int(len(diff)),
        "alpha": family_a.REFIT_ALPHA,
        "iterations": family_a.REFIT_BOOTSTRAP_ITERATIONS,
        "mean_block": family_a.REFIT_BOOTSTRAP_BLOCK,
    }


PAIR_ITERATIONS = 1000
PAIR_MEAN_BLOCK = 10
PAIR_ALPHA = 0.10


def _cost_free(daily: pd.DataFrame) -> pd.Series:
    return (daily["gross_hedged"].astype(float) + daily["funding"].astype(float)).rename("cost_free")


def paired_comparison(meta_daily: pd.DataFrame, rule_daily: pd.DataFrame, registry_index: int) -> dict[str, Any]:
    """A meta-labelled configuration against its primary alone, over the common span, no-bet days zero.

    The daily difference of the drift-free (net) series and of the cost-free series (gross_hedged plus funding), each
    with its mean and a stationary block bootstrap 90% interval (mean block 10 days, 1,000 iterations). The seeds are
    11,800,000 (net) and 11,900,000 (cost-free) plus the meta configuration's registry index. Descriptive only.
    """
    common = meta_daily.index.intersection(rule_daily.index)
    net = (
        meta_daily["drift_free"].astype(float).reindex(common).fillna(0.0)
        - rule_daily["drift_free"].astype(float).reindex(common).fillna(0.0)
    ).to_numpy(dtype=np.float64)
    cf = (
        _cost_free(meta_daily).reindex(common).fillna(0.0) - _cost_free(rule_daily).reindex(common).fillna(0.0)
    ).to_numpy(dtype=np.float64)
    out: dict[str, Any] = {"n": int(len(common)), "iterations": PAIR_ITERATIONS, "mean_block": PAIR_MEAN_BLOCK}
    for name, arr, base in (("net", net, PAIR_SEED_NET), ("cost_free", cf, PAIR_SEED_CF)):
        seed = base + int(registry_index)
        point, low, high = stats.bootstrap_ci(arr, np.mean, PAIR_ITERATIONS, PAIR_MEAN_BLOCK, seed, alpha=PAIR_ALPHA)
        out[name] = {
            "mean": float(point),
            "low": float(low),
            "high": float(high),
            "seed": seed,
            "alpha": PAIR_ALPHA,
        }
    return out


def per_unit_weight_mean(
    daily: pd.DataFrame, abs_weights: Sequence[float] | np.ndarray, start_ms: int | None = None
) -> float | None:
    """M item 4's statistic: the sum of the daily drift_free over [start_ms, DEV_END) over the sum of abs weights.

    start_ms defaults to FIRST_REFIT_MS (every declared configuration's first refit). None when the run has no tranche
    (or the weights sum to 0).
    """
    start = FIRST_REFIT_MS if start_ms is None else int(start_ms)
    w = np.abs(np.asarray(abs_weights, dtype=np.float64))
    total = float(w.sum()) if len(w) else 0.0
    if len(w) == 0 or total <= 0.0:
        return None
    idx = daily.index.to_numpy(dtype=np.int64)
    sel = (idx >= start) & (idx < DEV_END)
    return float(daily["drift_free"].to_numpy(dtype=np.float64)[sel].sum() / total)


# ---------------------------------------------------------------------------------------------------------------------
# Validation of a family B RunConfig (A8.5)
# ---------------------------------------------------------------------------------------------------------------------


def validate_config(cfg: Any) -> None:
    """The family "B" branch of RunConfig.__post_init__. Raises ValueError on any breach of A8.5's values."""
    if cfg.model not in ("rule", "lightgbm"):
        raise ValueError(f"family B model must be 'rule' or 'lightgbm', got {cfg.model!r}")
    if cfg.label != "meta":
        raise ValueError(f"family B label must be 'meta', got {cfg.label!r}")
    if cfg.side_rule not in PRIMARIES and cfg.side_rule not in NOISE_SIDE_RULES:
        raise ValueError(f"family B side_rule must be one of {PRIMARIES + NOISE_SIDE_RULES}, got {cfg.side_rule!r}")
    has_noise = any(hashfeat.is_noise_feature(f) for f in cfg.features)
    seed_ok = isinstance(cfg.noise_seed, int) and not isinstance(cfg.noise_seed, bool)
    if cfg.side_rule in NOISE_SIDE_RULES and not has_noise:
        raise ValueError("a family B noise side rule needs noise features")
    if has_noise != seed_ok:
        raise ValueError("family B takes an int noise_seed exactly when noise features are present")
    if "b_side" not in cfg.features:
        raise ValueError("family B features must hold b_side")
    own = SIGNAL_COLUMN.get(cfg.side_rule)
    foreign = [c for c in SIGNAL_COLUMN.values() if c != own and c in cfg.features]
    if foreign or (own is not None and own not in cfg.features):
        raise ValueError(f"family B side rule {cfg.side_rule!r} takes exactly its own signal column {own!r}")
    if cfg.model == "rule":
        want_size, want_threshold = "unit", 0.0
    else:
        want_size, want_threshold = "afml", P_STAR
    if cfg.size_rule != want_size:
        raise ValueError(f"family B {cfg.model} needs size_rule {want_size!r}, got {cfg.size_rule!r}")
    if isinstance(cfg.threshold, bool) or float(cfg.threshold) != want_threshold:
        raise ValueError(f"family B {cfg.model} needs threshold {want_threshold}, got {cfg.threshold!r}")
    if cfg.book != "slot":
        raise ValueError(f"family B needs book 'slot', got {cfg.book!r}")
    if cfg.exit != "horizon":
        raise ValueError("family B needs exit E1 (horizon)")
    if cfg.d_weights != "rank" or cfg.d_band != 0:
        raise ValueError("family B takes no family D weight rule or band")
    if cfg.plant is not None:
        raise ValueError("family B takes no plant")


def base_config(cfg: Any) -> Any:
    """The plain non-B configuration whose frozen decision_samples sets every price, label window and drop rule."""
    return dataclasses.replace(
        cfg,
        family="B-frame",
        model="lightgbm",
        params={},
        side_rule="prob",
        label="fixed",
        size_rule="unit",
        threshold=0.0,
        features=_frame_features_of(cfg),
        noise_seed=None,
    )


def _frame_features_of(cfg: Any) -> tuple[str, ...]:
    if cfg.side_rule in NOISE_SIDE_RULES:
        return frame_features(cfg.interval)
    return tuple(f for f in cfg.features if f not in EXTRA_COLUMNS)


def needs_tier_b(cfg: Any) -> bool:
    """True when the configuration reads the flow or metrics frames (sti, pos and their noise frames)."""
    rule = NOISE_FRAME_RULE.get(cfg.side_rule, cfg.side_rule)
    return rule in ("b_sti", "b_pos")


def needs_v8(cfg: Any) -> bool:
    return bool(cfg.side_rule == "b_v8")


# ---------------------------------------------------------------------------------------------------------------------
# Ported signals
# ---------------------------------------------------------------------------------------------------------------------


def trailing_zscore(series: np.ndarray, window_bars: int, min_samples: int) -> np.ndarray:
    """Port of src/lib/stats/trailing-z.ts trailingZScore: running sums in the TypeScript's operation order.

    NaN entries join neither the mean nor the count. Sample variance (count - 1). A variance at or below the
    cancellation scale 1e-12 x max(sumSq / count, mean^2, Number.MIN_VALUE) is no spread and gives NaN. A rolling
    window computed another way differs in the last bits and on near-constant stretches (Opus E3).
    """
    values = np.asarray(series, dtype=np.float64).tolist()
    n = len(values)
    out = [math.nan] * n
    count = 0
    total = 0.0
    sum_sq = 0.0
    number_min_value = 5e-324  # JavaScript Number.MIN_VALUE, the smallest subnormal
    isfinite = math.isfinite
    for i in range(n):
        entering = values[i]
        if isfinite(entering):
            count += 1
            total += entering
            sum_sq += entering * entering
        leaving_index = i - window_bars
        if leaving_index >= 0:
            leaving = values[leaving_index]
            if isfinite(leaving):
                count -= 1
                total -= leaving
                sum_sq -= leaving * leaving
        value = values[i]
        if not isfinite(value) or count < min_samples:
            continue
        mean = total / count
        mean_sq = mean * mean
        variance = (sum_sq - count * mean_sq) / (count - 1)
        epsilon = 1e-12 * max(sum_sq / count, mean_sq, number_min_value)
        if variance <= epsilon:
            continue
        out[i] = (value - mean) / math.sqrt(variance)
    return np.asarray(out, dtype=np.float64)


def ll_z(btc_1h: pd.DataFrame | None, coin_1h: pd.DataFrame, symbol: str = "") -> pd.Series:
    """The frozen btcLeadLagZ as family B reads it: a Series indexed by the decision close T = bar open + 1h.

    raw_j = BTC's one-bar return at the coin's bar time minus the coin's own return to the array-adjacent previous bar
    (a gap in the coin's own series is spanned, as in research-columns.ts:586), NaN for the coin's first LL_WARMUP_BARS
    rows (and row 0), where BTC lacks the bar or for BTCUSDT. z is trailingZScore over LL_WINDOW_ROWS rows and
    LL_MIN_SAMPLES samples, then shifted forward one bar: the value at T = the close of bar i is the z of bar i - 1.
    """
    coin = coin_1h.sort_values("t")
    t = coin["t"].to_numpy(dtype=np.int64)
    c = coin["c"].to_numpy(dtype=np.float64)
    n = len(t)
    raw = np.full(n, np.nan)
    if symbol != "BTCUSDT" and btc_1h is not None and len(btc_1h) > 0 and n > 1:
        btc = btc_1h.sort_values("t")
        bt = btc["t"].to_numpy(dtype=np.int64)
        bc = btc["c"].to_numpy(dtype=np.float64)
        prev_b, now_b = bc[:-1], bc[1:]
        with np.errstate(invalid="ignore"):
            ok_b = (prev_b > 0) & (now_b > 0)
        ret_t = bt[1:][ok_b]
        ret_v = ((now_b - prev_b) / prev_b)[ok_b]
        start = max(1, LL_WARMUP_BARS)
        if start < n:
            idx = np.arange(start, n)
            prev_c, now_c = c[idx - 1], c[idx]
            with np.errstate(invalid="ignore"):
                ok = (prev_c > 0) & (now_c > 0)
            pos = np.searchsorted(ret_t, t[idx])
            pos_c = np.minimum(pos, max(len(ret_t) - 1, 0))
            found = (pos < len(ret_t)) & (ret_t[pos_c] == t[idx]) if len(ret_t) else np.zeros(len(idx), dtype=bool)
            use = ok & found
            sel = idx[use]
            raw[sel] = ret_v[pos_c[use]] - (now_c[use] - prev_c[use]) / prev_c[use]
    z = trailing_zscore(raw, LL_WINDOW_ROWS, LL_MIN_SAMPLES)
    shifted = np.full(n, np.nan)
    if n > 1:
        shifted[1:] = z[:-1]
    return pd.Series(shifted, index=pd.Index(t + H1_MS, name="T"), name="b_ll_z")


def ll_side(z: np.ndarray | pd.Series) -> np.ndarray:
    """+1 if z >= LL_Z, -1 if z <= -LL_Z, else 0. NaN where z is NaN."""
    v = np.asarray(z, dtype=np.float64)
    out = np.zeros(len(v), dtype=np.float64)
    out[v >= LL_Z] = 1.0
    out[v <= -LL_Z] = -1.0
    out[np.isnan(v)] = np.nan
    return out


def _js_to_fixed2(x: np.ndarray) -> np.ndarray:
    """parseFloat(x.toFixed(2)) for non-negative finite x: round half up on the exact decimal value of the double."""
    scaled = x * 100.0
    out = np.rint(scaled) / 100.0
    near = np.abs((scaled - np.floor(scaled)) - 0.5) < 1e-7
    for i in np.flatnonzero(near):
        out[i] = float(Decimal(float(x[i])).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    return out


def rsi5(five_min: pd.DataFrame) -> pd.Series:
    """raw.rsi at 5m: the technicalindicators RSI(7) of the closes, a Series indexed by the 5m bar open time.

    Wilder averages over array positions (a gap between rows is spanned), the value rounded to two decimals as the
    library does, NaN for the first RSI_WARMUP_BARS rows of the series (the factor matrix's own warm-up, Opus E4).
    """
    bars = five_min.sort_values("t")
    t = bars["t"].to_numpy(dtype=np.int64)
    close = bars["c"].to_numpy(dtype=np.float64).tolist()
    n = len(close)
    avg_g = np.full(n, np.nan)
    avg_l = np.full(n, np.nan)
    if n > RSI_PERIOD:
        gain_sum = loss_sum = 0.0
        ag = al = 0.0
        for k in range(1, n):
            gain = close[k] - close[k - 1]
            gain = gain if gain > 0 else 0.0
            loss = close[k - 1] - close[k]
            loss = loss if loss > 0 else 0.0
            if k <= RSI_PERIOD:
                gain_sum += gain
                loss_sum += loss
            if k == RSI_PERIOD:
                ag = gain_sum / RSI_PERIOD
                al = loss_sum / RSI_PERIOD
            elif k > RSI_PERIOD:
                ag = ((ag * (RSI_PERIOD - 1)) + gain) / RSI_PERIOD
                al = ((al * (RSI_PERIOD - 1)) + loss) / RSI_PERIOD
            else:
                continue
            avg_g[k] = ag
            avg_l[k] = al
    rsi = np.full(n, np.nan)
    have = np.isfinite(avg_g)
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = avg_g / avg_l
        rs = np.where(np.isnan(rs) & have, 0.0, rs)
        raw = 100.0 - (100.0 / (1.0 + rs))
    mid = have & (avg_l != 0) & (avg_g != 0)
    rsi[mid] = _js_to_fixed2(raw[mid])
    rsi[have & (avg_l == 0)] = 100.0
    rsi[have & (avg_l != 0) & (avg_g == 0)] = 0.0
    rsi[: min(RSI_WARMUP_BARS, n)] = np.nan
    return pd.Series(rsi, index=pd.Index(t, name="t"), name="b_rsi5")


def _month_start_ms(ms: np.ndarray) -> np.ndarray:
    return (
        np.asarray(ms, dtype=np.int64)
        .astype("datetime64[ms]")
        .astype("datetime64[M]")
        .astype("datetime64[ms]")
        .astype(np.int64)
    )


def _quantile_sorted(sorted_values: np.ndarray, p: float) -> float:
    """Type 7 quantile of an ascending array, in snipe-tails.ts quantileSorted's operation order."""
    n = len(sorted_values)
    h = (n - 1) * p
    lo = int(math.floor(h))
    if lo + 1 >= n:
        return float(sorted_values[-1])
    return float(sorted_values[lo] + (h - lo) * (sorted_values[lo + 1] - sorted_values[lo]))


def rsi_thresholds(
    t: np.ndarray | pd.Index,
    rsi: np.ndarray | pd.Series,
    lookback_days: float | None = None,
    interval_ms: int = M5_MS,
    min_values: int = RSI_MIN_VALUES,
    probs: Sequence[float] = (RSI_TAIL, 1.0 - RSI_TAIL),
) -> dict[int, tuple[float, ...] | None]:
    """Port of snipe-tails.ts monthlyThresholds: per UTC month, the quantiles of the preceding lookback window.

    None for a month whose window starts before the series (A1-2), holds fewer than half its expected rows, no finite
    value or fewer than min_values finite values (A2-1). `t` ascending, rows with a NaN rsi count as rows.
    """
    lookback_days = RSI_LOOKBACK_DAYS if lookback_days is None else lookback_days
    ts = np.asarray(t, dtype=np.int64)
    vals = np.asarray(rsi, dtype=np.float64)
    out: dict[int, tuple[float, ...] | None] = {}
    if len(ts) == 0:
        return out
    lookback_ms = int(lookback_days * DAY_MS)
    expected = lookback_days * DAY_MS / interval_ms
    series_start = int(ts[0])
    for m in np.unique(_month_start_ms(ts)).tolist():
        if m - lookback_ms < series_start:
            out[m] = None
            continue
        lo = int(np.searchsorted(ts, m - lookback_ms, side="left"))
        hi = int(np.searchsorted(ts, m, side="left"))
        window = vals[lo:hi]
        window = window[np.isfinite(window)]
        if hi - lo < expected / 2 or len(window) == 0 or len(window) < min_values:
            out[m] = None
            continue
        srt = np.sort(window)
        out[m] = tuple(_quantile_sorted(srt, p) for p in probs)
    return out


def rsi_side(
    T: np.ndarray | pd.Index,
    t_open: np.ndarray | pd.Index,
    rsi: np.ndarray | pd.Series,
    thresholds: Mapping[int, tuple[float, ...] | None],
) -> pd.DataFrame:
    """The hour-close RSI extreme at decision closes T: b_rsi5 and b_side, indexed by T.

    r is the RSI of the 5m bar opening at T - 5 minutes (closed at T), with the thresholds of the month holding that
    bar's open time. b_side is +1 if r <= p10 only, -1 if r >= p90 only, 0 if both hold or neither (Codex R5). NaN for
    an absent bar, a NaN r or a month without thresholds.
    """
    t_arr = np.asarray(T, dtype=np.int64)
    ts = np.asarray(t_open, dtype=np.int64)
    vals = np.asarray(rsi, dtype=np.float64)
    want = t_arr - M5_MS
    pos = np.searchsorted(ts, want)
    pos_c = np.minimum(pos, max(len(ts) - 1, 0))
    found = (pos < len(ts)) & (ts[pos_c] == want) if len(ts) else np.zeros(len(t_arr), dtype=bool)
    r = np.where(found, vals[pos_c] if len(ts) else np.nan, np.nan)
    months = _month_start_ms(want)
    side = np.full(len(t_arr), np.nan)
    for m in np.unique(months).tolist():
        th = thresholds.get(m)
        if th is None:
            continue
        sel = (months == m) & np.isfinite(r)
        low = r[sel] <= th[0]
        high = r[sel] >= th[1]
        s = np.zeros(int(sel.sum()))
        s[low & ~high] = 1.0
        s[high & ~low] = -1.0
        side[sel] = s
    return pd.DataFrame({"b_rsi5": r, "b_side": side}, index=pd.Index(t_arr, name="T"))


def rsi_signal(five_min: pd.DataFrame, T: np.ndarray | pd.Index, lookback_days: float | None = None) -> pd.DataFrame:
    """rsi5, its monthly thresholds and rsi_side at the decision closes T."""
    series = rsi5(five_min)
    th = rsi_thresholds(series.index, series.to_numpy(), lookback_days)
    return rsi_side(T, series.index, series.to_numpy(), th)


def _usable(d: np.ndarray) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        return (d > 0) & np.isfinite(d)


def sti(flow_5m: pd.DataFrame, one_h: pd.DataFrame) -> pd.Series:
    """raw.smallTakerImb at 1h as family B reads it, indexed by the decision close T = 1h bar open + 1h.

    The STI_BUCKETS flow rows with bucket open t in {T - 60m, ..., T - 5m} (each usable at T: t + 5m <= T). NaN when
    any of them is absent, when the quarter-hour open-10s total, the other-mark open-10s total or the total quote is
    not positive (the locked COLUMNS rule, factors.ts:1278-1280), and for the first STI_WARMUP_BARS bars of the 1h
    series (Opus E4). Flow rows with t < TIER_B_START are not read. The sums run bucket by bucket in the TypeScript's
    order.
    """
    bars = one_h.sort_values("t")
    t_bar = bars["t"].to_numpy(dtype=np.int64)
    T = t_bar + H1_MS
    out = np.full(len(T), np.nan)
    cols = ["buyQuote", "sellQuote", "buyQuoteSmall", "sellQuoteSmall", "buyQuoteOpen10s", "sellQuoteOpen10s"]
    flow = flow_5m.loc[flow_5m["t"] >= TIER_B_START]
    flow = flow.loc[flow["t"] % M5_MS == 0].drop_duplicates("t", keep="last")
    if len(flow) and len(T) > STI_WARMUP_BARS:
        k = (flow["t"].to_numpy(dtype=np.int64) // M5_MS).astype(np.int64)
        kmin, kmax = int(k.min()), int(k.max())
        size = kmax - kmin + 1
        present = np.zeros(size, dtype=bool)
        present[k - kmin] = True
        dense = {c: np.full(size, np.nan) for c in cols}
        for c in cols:
            dense[c][k - kmin] = flow[c].to_numpy(dtype=np.float64)
        sel = np.arange(STI_WARMUP_BARS, len(T))
        k0 = (T[sel] - STI_BUCKETS * M5_MS) // M5_MS
        base = k0 - kmin
        inside = (base >= 0) & (base + STI_BUCKETS - 1 < size)
        sel, k0, base = sel[inside], k0[inside], base[inside]
        if len(sel):
            all_present = np.ones(len(sel), dtype=bool)
            qh_total = np.zeros(len(sel))
            five_total = np.zeros(len(sel))
            total = np.zeros(len(sel))
            small_diff = np.zeros(len(sel))
            for j in range(STI_BUCKETS):
                idx = base + j
                all_present &= present[idx]
                s10 = dense["buyQuoteOpen10s"][idx] + dense["sellQuoteOpen10s"][idx]
                is_qh = ((k0 + j) * M5_MS) % QUARTER_HOUR_MS == 0
                qh_total = qh_total + np.where(is_qh, s10, 0.0)
                five_total = five_total + np.where(is_qh, 0.0, s10)
                small_diff = small_diff + (dense["buyQuoteSmall"][idx] - dense["sellQuoteSmall"][idx])
                total = total + (dense["buyQuote"][idx] + dense["sellQuote"][idx])
            good = all_present & _usable(qh_total) & _usable(five_total) & _usable(total)
            vals = np.full(len(sel), np.nan)
            with np.errstate(invalid="ignore", divide="ignore"):
                vals[good] = small_diff[good] / total[good]
            out[sel] = vals
    return pd.Series(out, index=pd.Index(T, name="T"), name="b_sti")


def sti_side(value: np.ndarray | pd.Series) -> np.ndarray:
    """-1 if sti > 0, +1 if sti < 0, 0 if sti = 0 (the fade). NaN where sti is NaN."""
    v = np.asarray(value, dtype=np.float64)
    out = np.where(v > 0, -1.0, np.where(v < 0, 1.0, 0.0))
    out[np.isnan(v)] = np.nan
    return out


def positioning_z(points: Sequence[tuple[int, float]], bar_close: int) -> tuple[float | None, str | None]:
    """Port of src/lib/signals/lab/factors.ts positioningZ. Returns (z, None) or (None, skip reason).

    Points stamped after barClose - 4h are ignored, a duplicate stamp keeps the last point, the latest kept point must
    be stamped exactly at the cutoff, at least POS_POINTS kept points, the last POS_POINTS exactly 4h apart with finite
    positive ratios, and a finite non-zero sample SD.
    """
    cutoff = bar_close - POS_LAG_MS
    kept_map: dict[int, float] = {}
    for ts, ratio in points:
        if ts <= cutoff:
            kept_map[int(ts)] = float(ratio)
    kept = sorted(kept_map.items())
    if not kept:
        return None, "ratio_stale"
    if kept[-1][0] != cutoff:
        return None, "ratio_stale"
    if len(kept) < POS_POINTS:
        return None, "ratio_incomplete"
    window = kept[-POS_POINTS:]
    for _, ratio in window:
        if not math.isfinite(ratio) or ratio <= 0:
            return None, "ratio_incomplete"
    for i in range(1, len(window)):
        if window[i][0] - window[i - 1][0] != POS_PERIOD_MS:
            return None, "ratio_incomplete"
    n = len(window)
    total = 0.0
    for _, ratio in window:
        total += ratio
    mean = total / n
    sum_sq_diff = 0.0
    for _, ratio in window:
        diff = ratio - mean
        sum_sq_diff += diff * diff
    sd = math.sqrt(sum_sq_diff / (n - 1))
    if not math.isfinite(sd) or sd == 0:
        return None, "ratio_no_spread"
    return (window[-1][1] - mean) / sd, None


def pos_z(metrics_5m: pd.DataFrame) -> pd.Series:
    """positioningZ over D's archive proxy, indexed by the decision close T = point stamp + 4h.

    Points are the rows with t % 4h == 0 and t >= TIER_B_START (a duplicate stamp keeps the last). The value at T is
    NaN on every skip reason of positioningZ, which positioning_z reports (this vectorised form is tested against it).
    """
    m = metrics_5m.loc[(metrics_5m["t"] >= TIER_B_START) & (metrics_5m["t"] % POS_PERIOD_MS == 0)]
    m = m.sort_values("t").drop_duplicates("t", keep="last")
    ts = m["t"].to_numpy(dtype=np.int64)
    vals = m["topTraderPositionRatio"].to_numpy(dtype=np.float64)
    n = len(ts)
    z = np.full(n, np.nan)
    if n >= POS_POINTS:
        bad = ~(np.isfinite(vals) & (vals > 0))
        badcum = np.concatenate(([0], np.cumsum(bad.astype(np.int64))))
        span = (POS_POINTS - 1) * POS_PERIOD_MS
        for i in range(POS_POINTS - 1, n):
            lo = i - POS_POINTS + 1
            if ts[i] - ts[lo] != span or badcum[i + 1] - badcum[lo] > 0:
                continue
            w = vals[lo : i + 1]
            mean = w.sum() / POS_POINTS
            sd = math.sqrt(float(((w - mean) ** 2).sum()) / (POS_POINTS - 1))
            if not math.isfinite(sd) or sd == 0:
                continue
            z[i] = (w[-1] - mean) / sd
    return pd.Series(z, index=pd.Index(ts + POS_LAG_MS, name="T"), name="b_pos_z")


def pos_scheduled(T: np.ndarray | pd.Index) -> np.ndarray:
    """True at the 8h closes 00:00, 08:00 and 16:00 UTC (the 4h closes between them are in the frame with side 0)."""
    t = np.asarray(T, dtype=np.int64)
    hour = (t // H1_MS) % 24
    return (t % H1_MS == 0) & np.isin(hour, POS_HOURS_UTC)


def pos_side(z: np.ndarray | pd.Series, T: np.ndarray | pd.Index) -> np.ndarray:
    """-1 if z > 0, +1 if z < 0, 0 if z = 0 (Codex R5), only at 00:00, 08:00 and 16:00 UTC. 0 at the other 4h closes."""
    v = np.asarray(z, dtype=np.float64)
    side = np.where(v > 0, -1.0, np.where(v < 0, 1.0, 0.0))
    side = np.where(pos_scheduled(T), side, 0.0)
    return np.where(np.isnan(v) & pos_scheduled(T), np.nan, side)


def noise_side(symbol: str, T: np.ndarray | pd.Index, noise_seed: int, side_rule: str) -> np.ndarray:
    """The sign of hash_normal(NOISE_DOMAIN, noise_seed, coin index, 99, T): the mini-control's side.

    For "b_noise_pos" it is 0 at every T whose UTC hour is not 0, 8 or 16 (Codex R3). Feature index 99 is reserved for
    the side, so it is independent of noise_00 to noise_19.
    """
    if side_rule not in NOISE_SIDE_RULES:
        raise ValueError(f"not a noise side rule: {side_rule!r}")
    t = np.asarray(T, dtype=np.int64)
    z = hashfeat.hash_normal(
        hashfeat.NOISE_DOMAIN, int(noise_seed), hashfeat.universe_index(symbol), NOISE_SIDE_INDEX, t
    )
    side = np.sign(z).astype(np.float64)
    if side_rule == "b_noise_pos":
        side = np.where(pos_scheduled(t), side, 0.0)
    return side


# ---------------------------------------------------------------------------------------------------------------------
# The v8 decisions (A8.1)
# ---------------------------------------------------------------------------------------------------------------------


def _canonical_sha256(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _int_ms(value: Any, field: str, line: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float) or float(value) != int(value):
        raise ValueError(f"v8 export line {line}: {field} {value!r} is not an integer millisecond time")
    return int(value)


def read_v8_decisions(export_dir: Path | str, interval: str, cert_path: Path | str | None = None) -> pd.DataFrame:
    """The v8 primary's decisions from a C4 native export (A8.1), never through natives.read_export.

    Checks, each raising ValueError: the summary's canonical sha256 and the tranches file's byte sha256 against the
    declared digests, the certificate's byte sha256 against V8_GRID_CERT with all_gap_free true and its dataset equal to
    V8_DECISION_SOURCE, the summary's rule and manifest_hash, every row's rule, entry_ms on the interval grid, no
    duplicate (symbol, entry_ms), and exit_ms <= entry_ms + H on every row with entry_ms from 2023-12-02. No row is
    dropped for its exit (a stop without an exit price stays). The frame holds (symbol, T = entry_ms, side) of every row
    with T + H < DEV_END, and records the digests, the decision source, the summary's span_end_dropped and the number of
    rows the terminal exclusion removed in its attrs.
    """
    if interval not in V8_MAX_HOLD_MS:
        raise ValueError(f"interval must be '1h' or '4h', got {interval!r}")
    interval_ms = H1_MS if interval == "1h" else 4 * H1_MS
    hold_ms = V8_MAX_HOLD_MS[interval]
    root = Path(export_dir)
    summary = json.loads((root / "summary.json").read_text(encoding="utf-8"))
    summary_sha = _canonical_sha256(summary)
    if summary_sha != V8_SUMMARY_CANONICAL_SHA256[interval]:
        raise ValueError(
            f"v8-{interval} summary canonical sha256 {summary_sha} is not the declared "
            f"{V8_SUMMARY_CANONICAL_SHA256[interval]}"
        )
    tranches_bytes = (root / "tranches.jsonl").read_bytes()
    tranches_sha = hashlib.sha256(tranches_bytes).hexdigest()
    if tranches_sha != V8_TRANCHES_SHA256[interval]:
        raise ValueError(
            f"v8-{interval} tranches.jsonl sha256 {tranches_sha} is not the declared {V8_TRANCHES_SHA256[interval]}"
        )
    cert_file = Path(cert_path) if cert_path is not None else _PY_ROOT / V8_GRID_CERT[0]
    cert_bytes = cert_file.read_bytes()
    cert_sha = hashlib.sha256(cert_bytes).hexdigest()
    if cert_sha != V8_GRID_CERT[1]:
        raise ValueError(f"the v8 spot-grid certificate sha256 {cert_sha} is not the declared {V8_GRID_CERT[1]}")
    cert = json.loads(cert_bytes.decode("utf-8"))
    if cert.get("all_gap_free") is not True or cert.get("dataset") != V8_DECISION_SOURCE:
        raise ValueError("the v8 spot-grid certificate is not all_gap_free on the decision source")
    rule = f"v8-{interval}"
    if summary.get("rule") != rule:
        raise ValueError(f"the export's rule {summary.get('rule')!r} is not {rule!r}")
    if summary.get("manifest_hash") != V8_DECISION_SOURCE:
        raise ValueError(f"the export's manifest_hash {summary.get('manifest_hash')!r} is not the decision source")

    rows: list[tuple[str, int, int]] = []
    seen: set[tuple[str, int]] = set()
    for line_no, line in enumerate(tranches_bytes.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("rule") != rule:
            raise ValueError(f"v8 export line {line_no}: rule {row.get('rule')!r} is not the summary's rule {rule!r}")
        entry_ms = _int_ms(row.get("entry_ms"), "entry_ms", line_no)
        exit_ms = _int_ms(row.get("exit_ms"), "exit_ms", line_no)
        side = _int_ms(row.get("side"), "side", line_no)
        if side not in (-1, 1):
            raise ValueError(f"v8 export line {line_no}: side {side} is not -1 or 1")
        if entry_ms % interval_ms:
            raise ValueError(f"v8 export line {line_no}: entry_ms {entry_ms} is off the {interval} grid")
        symbol = str(row["symbol"])
        if (symbol, entry_ms) in seen:
            raise ValueError(f"v8 export line {line_no}: duplicate decision ({symbol}, {entry_ms})")
        seen.add((symbol, entry_ms))
        if entry_ms >= V8_ASSERT_FROM_MS and exit_ms > entry_ms + hold_ms:
            raise ValueError(
                f"v8 export line {line_no}: exit_ms {exit_ms} is after entry_ms + H ({entry_ms + hold_ms}) "
                "from 2023-12-02: the terminal exclusion does not hold"
            )
        rows.append((symbol, entry_ms, side))
    frame = pd.DataFrame(rows, columns=["symbol", "T", "side"])
    frame["T"] = frame["T"].astype(np.int64)
    frame["side"] = frame["side"].astype(np.int64)
    keep = (frame["T"] + hold_ms) < DEV_END
    removed = int((~keep).sum())
    frame = frame.loc[keep].sort_values(["symbol", "T"]).reset_index(drop=True)
    frame.attrs = {
        "interval": interval,
        "rule": rule,
        "decision_source": V8_DECISION_SOURCE,
        "summary_sha256": summary_sha,
        "tranches_sha256": tranches_sha,
        "cert_sha256": cert_sha,
        "span_end_dropped": summary.get("span_end_dropped"),
        "n_rows_read": int(len(rows)),
        "n_terminal_excluded": removed,
    }
    return frame


def attach_v8(panel: dict[str, dict[str, pd.DataFrame]], v8_exports: Mapping[str, Path | str]) -> None:
    """Add each coin's v8 decisions (b_v8_1h and b_v8_4h) to the panel, an empty frame for a coin with no row."""
    for interval, directory in v8_exports.items():
        frame = read_v8_decisions(directory, interval)
        for sym in panel:
            sub = frame.loc[frame["symbol"] == sym].reset_index(drop=True)
            sub.attrs = {**frame.attrs, "n_coin_rows": int(len(sub))}
            panel[sym][f"b_v8_{interval}"] = sub


def load_tier_b(ds_dir: Path | str, symbol: str, cache_dir: Path | str | None = None) -> dict[str, pd.DataFrame]:
    """One coin's flow_5m and metrics_5m frames (A8.5), only the columns family B reads, only from TIER_B_START."""
    from r4.data import load_flow, load_metrics

    flow_cols = ["t", "buyQuote", "sellQuote", "buyQuoteSmall", "sellQuoteSmall", "buyQuoteOpen10s", "sellQuoteOpen10s"]
    flow = load_flow(ds_dir, symbol, cache_dir=cache_dir).rows
    flow = flow.loc[flow["t"] >= TIER_B_START, flow_cols].reset_index(drop=True)
    metrics = load_metrics(ds_dir, symbol, cache_dir=cache_dir).rows
    metrics = metrics.loc[
        (metrics["t"] >= TIER_B_START) & (metrics["t"] % POS_PERIOD_MS == 0), ["t", "topTraderPositionRatio"]
    ].reset_index(drop=True)
    return {"flow_5m": flow, "metrics_5m": metrics}


def check_panel(panel: dict[str, dict[str, pd.DataFrame]], cfg: Any) -> dict[str, Any] | None:
    """Refuse a panel that lacks the frames the configuration reads. For v8, return the decision record.

    A v8 configuration needs the b_v8_<interval> frame of every coin, with attrs digests equal to the declared
    constants. A Tier B configuration needs flow_5m and metrics_5m of every coin.
    """
    if needs_tier_b(cfg):
        for sym, d in panel.items():
            if "flow_5m" not in d or "metrics_5m" not in d:
                raise ValueError(f"{sym}: the panel has no flow_5m and metrics_5m: load it with tier_b=True")
    if not needs_v8(cfg):
        return None
    key = f"b_v8_{cfg.interval}"
    record: dict[str, Any] | None = None
    for sym, d in panel.items():
        frame = d.get(key)
        if frame is None:
            raise ValueError(f"{sym}: the panel has no {key}: build it with load_panel(v8_exports=...)")
        a = frame.attrs
        want = {
            "decision_source": V8_DECISION_SOURCE,
            "summary_sha256": V8_SUMMARY_CANONICAL_SHA256[cfg.interval],
            "tranches_sha256": V8_TRANCHES_SHA256[cfg.interval],
            "cert_sha256": V8_GRID_CERT[1],
        }
        for k, v in want.items():
            if a.get(k) != v:
                raise ValueError(f"{sym}: {key} attrs {k} {a.get(k)!r} is not the declared {v!r}")
        record = {k: a.get(k) for k in (*want, "span_end_dropped", "n_rows_read", "n_terminal_excluded")}
    return record


# ---------------------------------------------------------------------------------------------------------------------
# The recorder
# ---------------------------------------------------------------------------------------------------------------------


class Recorder:
    """Collects the primary's decision rows (one per row with b_side not 0) and the meta fits of a run."""

    def __init__(self, scope: str = "") -> None:
        self.scope = (
            scope  # which entry point owns the recorder ("run_wf", "run_tripwire"), so a nested call is told apart
        )
        self.phase = "unset"
        self.fit_count = 0
        self._decisions: list[pd.DataFrame] = []
        self._fits: list[dict[str, Any]] = []

    def add_decisions(self, frame: pd.DataFrame) -> None:
        self._decisions.append(frame)

    def add_fit(self, row: dict[str, Any]) -> None:
        self._fits.append(row)

    def frame(self) -> pd.DataFrame:
        if not self._decisions:
            return pd.DataFrame(
                {
                    "phase": pd.Series(dtype=object),
                    "block_start": pd.Series(dtype=np.int64),
                    "T": pd.Series(dtype=np.int64),
                    "symbol": pd.Series(dtype=object),
                    "b_side": pd.Series(dtype=np.float64),
                    "p": pd.Series(dtype=np.float64),
                    "acted": pd.Series(dtype=bool),
                    "size": pd.Series(dtype=np.float64),
                    "abs_weight": pd.Series(dtype=np.float64),
                    "net": pd.Series(dtype=np.float64),
                }
            )[DECISION_COLUMNS]
        return pd.concat(self._decisions, ignore_index=True)[DECISION_COLUMNS]

    def fits(self) -> pd.DataFrame:
        if not self._fits:
            return pd.DataFrame(
                {
                    "phase": pd.Series(dtype=object),
                    "fit": pd.Series(dtype=np.int64),
                    "train_t_min": pd.Series(dtype=np.int64),
                    "train_t_max": pd.Series(dtype=np.int64),
                    "n_train": pd.Series(dtype=np.int64),
                    "rows": pd.Series(dtype=np.int64),
                    "positives": pd.Series(dtype=np.int64),
                    "base_rate": pd.Series(dtype=np.float64),
                    "degenerate": pd.Series(dtype=object),
                }
            )[FIT_COLUMNS]
        return pd.DataFrame(self._fits)[FIT_COLUMNS]

    def drain(self) -> pd.DataFrame:
        """Return the decision rows recorded since the last drain and clear the decisions and the fits."""
        out = self.frame()
        self._decisions = []
        self._fits = []
        return out


_RECORDER: Recorder | None = None


@contextlib.contextmanager
def recording(recorder: Recorder | None = None) -> Iterator[Recorder]:
    """Activate a recorder (a fresh one unless given) for the duration of the block, and yield it."""
    global _RECORDER
    previous = _RECORDER
    active = recorder if recorder is not None else Recorder()
    _RECORDER = active
    try:
        yield active
    finally:
        _RECORDER = previous


def current_recorder() -> Recorder | None:
    return _RECORDER


def set_phase(name: str) -> None:
    """Label the rows recorded from now on. Raises when no recorder is active."""
    if _RECORDER is None:
        raise RuntimeError("set_phase needs an active recorder")
    _RECORDER.phase = str(name)


def shift_record(decisions: pd.DataFrame, daily: pd.DataFrame | None, start_ms: int | None = None) -> dict[str, Any]:
    """One shifted tripwire run's record (A8.4): its tranche count, sum of abs weights and drift-free mean per weight.

    `decisions` is the recorder's drain after the shift. The statistic is M item 4's: the sum of the shifted run's daily
    drift-free returns over [first refit, DEV_END) over the sum of the absolute weights of its tranches.
    """
    acted = decisions.loc[decisions["acted"].to_numpy(dtype=bool)]
    weights = acted["abs_weight"].to_numpy(dtype=np.float64)
    return {
        "tranche_count": int(len(acted)),
        "abs_weight_sum": float(weights.sum()),
        "per_unit_weight_mean": None if daily is None else per_unit_weight_mean(daily, weights, start_ms),
    }


def receipt_block(
    cfg: Any,
    samples: pd.DataFrame,
    decisions: pd.DataFrame,
    fits: pd.DataFrame,
    n_wf_tranches: int,
    v8_record: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """The "b" block of a family B receipt: the primary, the frame, the decision counts, fits and the trade floor."""
    wf = decisions.loc[decisions["phase"] == "wf"]
    n_primary = int(len(wf))
    n_acted = int(wf["acted"].sum())
    degenerate = fits["degenerate"].astype(str) != ""
    in_wf = fits["phase"] == "wf"
    block: dict[str, Any] = {
        "primary": cfg.side_rule,
        "frame_rows": int(len(samples)),
        "wf_primary_decisions": n_primary,
        "wf_acted_decisions": n_acted,
        "act_share": (n_acted / n_primary) if n_primary else None,
        "wf_mean_size": float(wf.loc[wf["acted"], "size"].mean()) if n_acted else None,
        "fits": int(len(fits)),
        "degenerate_fits": {"wf": int((degenerate & in_wf).sum()), "cpcv": int((degenerate & ~in_wf).sum())},
        "wf_tranches": int(n_wf_tranches),
        "trade_floor": {"floor": TRADE_FLOOR_TRANCHES, "met": bool(n_wf_tranches >= TRADE_FLOOR_TRANCHES)},
        "per_coin": samples.attrs.get("b_record", {}),
        "v8": None if v8_record is None else dict(v8_record),
    }
    return block


# ---------------------------------------------------------------------------------------------------------------------
# The meta model (A8.4)
# ---------------------------------------------------------------------------------------------------------------------


def fit_meta(cfg: Any, x_train: np.ndarray, train_df: pd.DataFrame) -> Any:
    """fit_side_model for family B: "rule" has no fit, "lightgbm" is one binary classifier on the primary's decisions.

    The training rows are those with b_side not 0 and the label is 1 when the primary's trade nets above zero at E1:
    tb_net for a long, tb_net_short for a short. Numpy arrays only, so a train_df index that does not start at 0 selects
    the right rows. With no row the model is 0.0, with one class the training base rate (0.0 or 1.0), both named in
    degenerate_fits.
    """
    from r4.pipeline import SideModel, _make_model

    if cfg.model == "rule":
        return SideModel("rule", None, None, None, ())
    side = train_df["b_side"].to_numpy(dtype=np.float64)
    rows = side != 0
    net = np.where(
        side > 0, train_df["tb_net"].to_numpy(dtype=np.float64), train_df["tb_net_short"].to_numpy(dtype=np.float64)
    )
    y = (net[rows] > 0).astype(int)
    x = np.asarray(x_train)[rows]
    degenerate: list[str] = []
    fitted: Any
    if len(y) == 0:
        degenerate.append("no_rows")
        base_rate = 0.0
        fitted = 0.0
    elif len(np.unique(y)) < 2:
        degenerate.append("one_class")
        base_rate = float(y.mean())
        fitted = base_rate
    else:
        base_rate = float(y.mean())
        fitted = _make_model(cfg).fit(x, y)
    rec = _RECORDER
    if rec is not None:
        t = train_df["T"].to_numpy(dtype=np.int64)
        rec.add_fit(
            {
                "phase": rec.phase,
                "fit": rec.fit_count,
                "train_t_min": int(t.min()) if len(t) else 0,
                "train_t_max": int(t.max()) if len(t) else 0,
                "n_train": int(len(train_df)),
                "rows": int(rows.sum()),
                "positives": int(y.sum()),
                "base_rate": base_rate,
                "degenerate": ",".join(degenerate),
            }
        )
        rec.fit_count += 1
    return SideModel("meta", None, fitted, None, tuple(degenerate), base_up=base_rate)


def meta_proba(model: Any, X_test: np.ndarray) -> np.ndarray:
    """The probability that the primary's trade nets above zero, float64 in [0, 1]. 1 for every row of a rule model.

    Raises unless every p is finite and in [0, 1] (A8.4). Float64 matters: validation.cpcv_paths takes the dtype of the
    first prediction, so an integer array would zero every CPCV path (Opus E5).
    """
    from r4.pipeline import _side_proba

    n = len(X_test)
    if model.kind == "rule":
        return np.ones(n, dtype=np.float64)
    p = np.zeros(0, dtype=np.float64) if n == 0 else np.asarray(_side_proba(model.up, X_test), dtype=np.float64)
    if len(p) and not (np.isfinite(p).all() and (p >= 0.0).all() and (p <= 1.0).all()):
        raise ValueError("the meta classifier's p must be finite and in [0, 1]")
    return p


def afml_size(p: Any) -> Any:
    """0 for p <= 0.5, 1 for p = 1, else 2 Phi((p - 0.5) / sqrt(p (1 - p))) - 1 (A8.4, Lopez de Prado 2018, ch. 10).

    Accepts a scalar or an array. Raises outside [0, 1] or on NaN.
    """
    arr = np.asarray(p, dtype=np.float64)
    if not (np.isfinite(arr).all() and (arr >= 0.0).all() and (arr <= 1.0).all()):
        raise ValueError("p must be finite and in [0, 1]")
    mid = (arr > 0.5) & (arr < 1.0)
    safe = np.where(mid, arr, 0.75)
    val = 2.0 * ndtr((safe - 0.5) / np.sqrt(safe * (1.0 - safe))) - 1.0
    out = np.where(mid, val, np.where(arr >= 1.0, 1.0, 0.0))
    return float(out) if np.ndim(p) == 0 else out


def make_tranches_b(test_df: pd.DataFrame, p: np.ndarray, cfg: Any) -> list[Any]:
    """The tranches of one block: the primary's side where p > the configuration's threshold, at the A8.4 size.

    Rule configurations (threshold 0, p = 1) act on every non-zero side at size 1. Each tranche is built as the slot
    path builds it (entry at t0 + 10 minutes, exit at t1_max, taker both ways, reason "horizon", no weight override)
    with its size. With a recorder active one row per row with b_side not 0 is appended.
    """
    from r4.book import Tranche

    p = np.asarray(p, dtype=np.float64)
    if len(p) != len(test_df):
        raise ValueError(f"p has {len(p)} entries for {len(test_df)} rows")
    side = test_df["b_side"].to_numpy(dtype=np.float64)
    acted = (side != 0) & (p > float(cfg.threshold))
    if cfg.size_rule == "afml":
        size = np.where(acted, afml_size(np.where(acted, p, 0.5)), 0.0)
    else:
        size = np.where(acted, 1.0, 0.0)
    syms = test_df["symbol"].to_numpy()
    entries = test_df["entry"].to_numpy(dtype=np.float64)
    exits = test_df["exit"].to_numpy(dtype=np.float64)
    t0s = test_df["t0"].to_numpy(dtype=np.int64)
    t1s = test_df["t1_max"].to_numpy(dtype=np.int64)
    scale = _n_bars(cfg.interval, int(cfg.h_ms))
    abs_w = np.where(acted, size / scale / 10.0, 0.0)

    rec = _RECORDER
    if rec is not None and len(test_df):
        rows = np.flatnonzero(side != 0)
        net = np.where(
            side[rows] > 0,
            test_df["tb_net"].to_numpy(dtype=np.float64)[rows],
            test_df["tb_net_short"].to_numpy(dtype=np.float64)[rows],
        )
        rec.add_decisions(
            pd.DataFrame(
                {
                    "phase": rec.phase,
                    "block_start": np.int64(test_df["T"].min()),
                    "T": test_df["T"].to_numpy(dtype=np.int64)[rows],
                    "symbol": syms[rows].astype(object),
                    "b_side": side[rows],
                    "p": p[rows],
                    "acted": acted[rows],
                    "size": size[rows],
                    "abs_weight": abs_w[rows],
                    "net": net,
                }
            )
        )

    tranches: list[Tranche] = []
    for i in np.flatnonzero(acted).tolist():
        tranches.append(
            Tranche(
                symbol=str(syms[i]),
                side=1 if side[i] > 0 else -1,
                entry_ms=int(t0s[i]) + ENTRY_DELAY_MS,
                exit_ms=int(t1s[i]),
                entry_price=float(entries[i]),
                exit_price=float(exits[i]),
                interval=cfg.interval,
                h_ms=cfg.h_ms,
                size=float(size[i]),
                entry_fill="taker",
                exit_fill="taker",
                exit_reason="horizon",
                weight_override=None,
            )
        )
    return tranches


# ---------------------------------------------------------------------------------------------------------------------
# The decision frame
# ---------------------------------------------------------------------------------------------------------------------


def _primary_columns(
    rule: str, panel: Mapping[str, Mapping[str, pd.DataFrame]], sym: str, interval: str, T: np.ndarray
) -> tuple[np.ndarray, np.ndarray | None]:
    """(b_side, the primary's own signal) at the decision closes T of one coin. NaN marks an undefined input."""
    d = panel[sym]
    if rule == "b_v8":
        key = f"b_v8_{interval}"
        if key not in d:
            raise ValueError(f"{sym}: the panel has no {key}: build it with load_panel(v8_exports=...)")
        dec = d[key]
        side = np.zeros(len(T), dtype=np.float64)
        if len(dec):
            dt = dec["T"].to_numpy(dtype=np.int64)
            order = np.argsort(dt)
            pos = np.searchsorted(dt[order], T)
            pos_c = np.minimum(pos, len(dt) - 1)
            hit = (pos < len(dt)) & (dt[order][pos_c] == T)
            side[hit] = dec["side"].to_numpy(dtype=np.float64)[order][pos_c[hit]]
        side[(T + V8_MAX_HOLD_MS[interval]) >= DEV_END] = np.nan
        return side, None
    if rule == "b_ll":
        if "BTCUSDT" not in panel:
            raise ValueError("b_ll needs BTCUSDT in the panel")
        z = ll_z(panel["BTCUSDT"]["1h"], d["1h"], sym).reindex(T).to_numpy(dtype=np.float64)
        return ll_side(z), z
    if rule == "b_rsi":
        sig = rsi_signal(d["5m"], T)
        return sig["b_side"].to_numpy(dtype=np.float64), sig["b_rsi5"].to_numpy(dtype=np.float64)
    if rule == "b_sti":
        if "flow_5m" not in d:
            raise ValueError(f"{sym}: the panel has no flow_5m: load it with tier_b=True")
        v = sti(d["flow_5m"], d["1h"]).reindex(T).to_numpy(dtype=np.float64)
        return sti_side(v), v
    if rule == "b_pos":
        if "metrics_5m" not in d:
            raise ValueError(f"{sym}: the panel has no metrics_5m: load it with tier_b=True")
        z = pos_z(d["metrics_5m"]).reindex(T).to_numpy(dtype=np.float64)
        return pos_side(z, T), z
    raise ValueError(f"unknown primary {rule!r}")


def decision_samples_b(panel: dict[str, dict[str, pd.DataFrame]], cfg: Any) -> pd.DataFrame:
    """The decision frame of a family B configuration (reached from pipeline.decision_samples).

    The base frame is the frozen decision_samples run on a plain non-B configuration (base_config), so entry, exit,
    gross_log, t0, t1_max and every drop rule are unchanged. Per coin this adds b_side and the primary's own signal,
    and the labels tb_net and tb_net_short (labels.fixed_horizon's net for a long and for a short at the configuration's
    horizon). The mini-control keeps the real frame's rows (F, the named primary's signal and both labels finite) and
    swaps the features for the hash-noise features. Rows with any NaN in the features, b_side, tb_net or tb_net_short
    are dropped and counted in attrs["n_dropped"].
    """
    from r4.pipeline import decision_samples

    noise = cfg.side_rule in NOISE_SIDE_RULES
    frame_rule = NOISE_FRAME_RULE.get(cfg.side_rule, cfg.side_rule)
    base = decision_samples(panel, base_config(cfg))
    out_cols = ["symbol", "T", *cfg.features, "entry", "exit", "gross_log", "t0", "t1_max", "tb_net", "tb_net_short"]
    parts: list[pd.DataFrame] = []
    extra_dropped = 0
    record: dict[str, Any] = {}
    symbols = list(panel)
    for sym, rows in base.groupby("symbol", sort=True):
        sym = str(sym)
        rows = rows.sort_values("T").reset_index(drop=True)
        T = rows["T"].to_numpy(dtype=np.int64)
        side, signal = _primary_columns(frame_rule, panel, sym, cfg.interval, T)
        d = panel[sym]
        net_long = labels.fixed_horizon(
            T, d["5m"], cfg.h_ms, 1, cfg.interval, d.get("settlements"), delay_ms=ENTRY_DELAY_MS, symbol=sym
        )["net"].to_numpy(dtype=np.float64)
        net_short = labels.fixed_horizon(
            T, d["5m"], cfg.h_ms, -1, cfg.interval, d.get("settlements"), delay_ms=ENTRY_DELAY_MS, symbol=sym
        )["net"].to_numpy(dtype=np.float64)
        sub = rows.copy()
        sub["tb_net"] = net_long
        sub["tb_net_short"] = net_short
        mask = np.isfinite(net_long) & np.isfinite(net_short)
        if noise:
            sub["b_side"] = noise_side(sym, T, int(cfg.noise_seed), cfg.side_rule)
            noise_cols = hashfeat.hash_feature_matrix(
                list(calibration.NOISE_FEATURES), sym, symbols, T, cfg.noise_seed, None
            )
            for c, name in enumerate(calibration.NOISE_FEATURES):
                sub[name] = noise_cols[:, c]
            if signal is not None:
                mask &= np.isfinite(signal)
        else:
            sub["b_side"] = side
            if signal is not None:
                sub[SIGNAL_COLUMN[frame_rule]] = signal
        for col in cfg.features:
            mask &= np.isfinite(sub[col].to_numpy(dtype=np.float64))
        extra_dropped += int((~mask).sum())
        kept = sub.loc[mask]
        if frame_rule == "b_v8":
            dec = d.get(f"b_v8_{cfg.interval}")
            n_read = int(len(dec)) if dec is not None else 0
            in_frame = (
                int(np.isin(dec["T"].to_numpy(dtype=np.int64), kept["T"].to_numpy(dtype=np.int64)).sum())
                if n_read
                else 0
            )
            attrs = dec.attrs if dec is not None else {}
            record[sym] = {
                "n_decisions_read": n_read,
                "n_terminal_excluded": attrs.get("n_terminal_excluded"),
                "n_outside_frame": n_read - in_frame,
                "first_T": int(kept["T"].min()) if len(kept) else None,
            }
        else:
            record[sym] = {"first_T": int(kept["T"].min()) if len(kept) else None}
        if len(kept):
            parts.append(kept[out_cols])
    if parts:
        combined = pd.concat(parts, ignore_index=True).sort_values(["T", "symbol"]).reset_index(drop=True)
    else:
        combined = pd.DataFrame(columns=out_cols)
    combined.attrs["n_dropped"] = int(base.attrs.get("n_dropped", 0)) + extra_dropped
    combined.attrs["panel"] = base.attrs["panel"]
    combined.attrs["b_record"] = record
    return combined


# ---------------------------------------------------------------------------------------------------------------------
# Synthetic Tier B rows (tests and the mini-control's synthetic activity check only)
# ---------------------------------------------------------------------------------------------------------------------


def synthetic_tier_b(panel: dict[str, dict[str, pd.DataFrame]], seed: int) -> dict[str, dict[str, pd.DataFrame]]:
    """Add synthetic flow_5m and metrics_5m rows from 2023-01-01 to a synthetic panel (r4.synth carries none).

    Flow: buyQuote and sellQuote from each 5m bar's taker-buy volume and the remainder times its close, the small
    class and the open-10s fields as seeded positive fractions of them. Metrics: a seeded positive random walk of
    topTraderPositionRatio at the 4h stamps. The panel is changed in place and returned. Synthetic data only.
    """
    for j, d in enumerate(panel.values()):
        rng = np.random.default_rng([int(seed), j])
        bars = d["5m"].loc[d["5m"]["t"] >= TIER_B_START].reset_index(drop=True)
        n = len(bars)
        close = bars["c"].to_numpy(dtype=np.float64)
        v = bars["v"].to_numpy(dtype=np.float64)
        tbv = bars["tbv"].to_numpy(dtype=np.float64)
        buy = tbv * close
        sell = (v - tbv) * close
        d["flow_5m"] = pd.DataFrame(
            {
                "t": bars["t"].to_numpy(dtype=np.int64),
                "buyQuote": buy,
                "sellQuote": sell,
                "buyQuoteSmall": buy * rng.uniform(0.2, 0.5, size=n),
                "sellQuoteSmall": sell * rng.uniform(0.2, 0.5, size=n),
                "buyQuoteOpen10s": buy * rng.uniform(0.02, 0.1, size=n),
                "sellQuoteOpen10s": sell * rng.uniform(0.02, 0.1, size=n),
            }
        )
        stamps = bars["t"].to_numpy(dtype=np.int64)
        stamps = stamps[stamps % POS_PERIOD_MS == 0]
        walk = np.exp(np.cumsum(rng.normal(0.0, 0.05, size=len(stamps))))
        d["metrics_5m"] = pd.DataFrame({"t": stamps, "topTraderPositionRatio": walk})
    return panel
