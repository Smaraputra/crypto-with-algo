"""The family C H procedure for C_LHAR-X_1h under its finalist lock and Amendment 11 (A11.2).

New code: family_c.py stays frozen, family_c.run_holdout stays the stub that raises, and cli.py gains no subcommand.
The entry point is `python -m r4.holdout_c` with the subcommands artifact (the final model on D), rehearse (a full
run on a synthetic H export with a scratch ledger) and read (the one read of H). The read happens only from
`run_read` in mode "read", with the bindings of the signed lock record
scripts/research/py/records/c_lhar_x_1h_finalist_lock.json, and only after every check that does not depend on an H
value has passed. After the first guarded load nothing this module controls raises: a coin's exception, a load that
differs from its bound file entry, or an exception in the flag fails that coin or the pooled stay-out flag and is
recorded (A11.1, OD10, OD11). The gated results are printed (H VERDICT, H RECORD) before any descriptive work or file
write. Data is read only through r4.data's loaders. Spec: .superpowers/sdd/round4/c-holdout-engineering.md (draft 6)
and .superpowers/sdd/round4/c-finalist-lock-draft.md (draft 6).
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import functools
import hashlib
import json
import math
import multiprocessing
import os
import re
import resource
import shutil
import sys
import time
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4 import cli, data, family_c, family_d, method, pipeline
from r4.synth import synth_panel

# ---------------------------------------------------------------------------------------------------------------------
# Constants (each asserted by a test)
# ---------------------------------------------------------------------------------------------------------------------

FINALIST_CONFIG_ID = "C_LHAR-X_1h"
FINALIST_ID = "c-lhar-x-1h"
REHEARSAL_FINALIST_ID = "c-lhar-x-1h-rehearsal"
REGISTRY_INDEX = 2
WINDOW = "1h"
WINDOW_MS = family_c.WINDOWS["1h"]
BTC = family_c.BTC
DAY_MS = family_c.DAY_MS

CUTOFF_MS = method.DEV_END - 30 * family_c.DAY_MS
LOOKBACK_MONTHS = 24
LOOKBACK_START_MS = family_c.lookback_start(CUTOFF_MS, LOOKBACK_MONTHS)
MIN_TRAIN = family_c.MIN_TRAIN_WINDOWS
EARLIEST_INPUT_MS = LOOKBACK_START_MS - 30 * family_c.DAY_MS - WINDOW_MS - family_c.FUND_MAX_AGE_MS

H_SEED = family_c.STAY_OUT_H_SEED_BASE + REGISTRY_INDEX
H_SEED_INDEX_ARG = REGISTRY_INDEX + family_c.STAY_OUT_H_SEED_BASE - family_c.STAY_OUT_SEED_BASE

D_DATASET_HASH = "11c87b9c8a97c367b6cd7c0c983f4d2bd9e940f62856a85c6e76537ac18a9a62"
FAMILY_C_COMMIT = "c8f5849f43cb4d0459f2311789d2a7e1e233ec7a"
CONFIG_HASH = "8a1f0f209466f9383ff166162819b0808b15e92300979c95eef1617f705df59d"
REFERENCE_FORECASTS_SHA256 = "696c5ef14613b4fb6964a057bfbae5a88146a0e5a80af1516f39d3e55b86f557"
REFERENCE_FINITE_F_DIGEST = "a6ed91ee3228f2c6645536b7b51c200deb34630e0c71bcd68da4fdfdc37ed6da"
REFERENCE_FINITE_F_ROWS = 276_840
REQUIREMENTS_LOCK_SHA256 = "73d0c30008fda2363e334ede40ddca2534a269d168166eb2a14ff6711a0e13d1"
VERSIONS: dict[str, str] = {
    "python": "3.12.15",
    "numpy": "2.5.4",
    "pandas": "3.0.6",
    "scipy": "1.18.1",
    "scikit-learn": "1.9.1",
    "lightgbm": "4.7.0",
    "pyarrow": "26.0.0",
}
FROZEN_FILES_SHA256: dict[str, str] = {
    "family_c.py": "ae5798a15ac50409ca9a1d0f7ba7df2a7293f535290b2041c77154d851b40249",
    "phase5_c.py": "3097466c3b11c038686c18e39473d3a517057d43b781ff4e07fa20eb16a776fb",
    "data.py": "7de159b99ece51da52dfde36439655ad12dfde9ae34f4c13f7d6b0a5e9eb826b",
    "stats.py": "5a38b1f9edc091816dde283cf61046830d8b97ccbf4542f0427552f89655cd35",
    "costs.py": "5d31699801009ab368eda893d9dd9a9abb896c2aef9943fbba54bd57587d5ae4",
    "family_d.py": "5e91a9f7e1bf05136bf8a3b44ae836a3f5bd0ba499d8c1992483eab3bc5db7b8",
}
METHOD_EXPECTED: dict[str, Any] = {
    "DEV_START": 1_640_995_200_000,
    "DEV_END": 1_782_864_000_000,
    "H_START": 1_577_836_800_000,
    "H_END": 1_640_995_200_000,
    "UNIVERSE": (
        "BTCUSDT",
        "ETHUSDT",
        "BNBUSDT",
        "SOLUSDT",
        "XRPUSDT",
        "ADAUSDT",
        "DOGEUSDT",
        "AVAXUSDT",
        "DOTUSDT",
        "LINKUSDT",
    ),
    "BAR_FORECAST": {
        "dm_p_max": 0.05,
        "coverage_levels": (0.8, 0.95),
        "coverage_tolerance": 0.02,
        "symbols_min": 8,
        "ewma_halflife_windows": 7,
    },
    "STAY_OUT": {
        "vol_percentile": 0.9,
        "vol_percentile_lookback_days": 90,
        "range_cost_multiple": 3.0,
        "range_share_min": 0.6,
    },
    "STAY_OUT_BLOCK_DAYS": 10,
    "MAX_H_READ_IDS": 4,
}

D_DIR = "/ds"
H_DIR = "/h"
LEDGER_PATH = "/ledger/holdout-reads.jsonl"
REF_PATH = "/ref/forecasts.parquet"
OUT_DIR = "/out"
REHEARSAL_H_DIR = "/rh"
REHEARSAL_LEDGER_PATH = "/scratch/ledger.jsonl"

ARTIFACT_KIND = "round4-family-c-final-model"
H_GUARDED = ("perp/{c}/5m.jsonl.gz", "perp/{c}/5m.premiumIndex.jsonl.gz")
H_FUNDING = "funding/{c}/settlements.jsonl.gz"
LEDGER_KEYS = ("at", "finalist_id", "path", "read_id")
MIN_FREE_BYTES = 1 << 30
MAX_LEDGER_READ_IDS = 4

_SHA40 = re.compile(r"^[0-9a-f]{40}$")
_COMMIT_RE = re.compile(r"^[0-9a-f]{7,40}$")
_SHA64 = re.compile(r"^[0-9a-f]{64}$")
_PKG_DIR = Path(__file__).resolve().parent
LOCK_RECORD_PATH = str(_PKG_DIR.parent / "records" / "c_lhar_x_1h_finalist_lock.json")
ARTIFACT_RECORD_PATH = str(_PKG_DIR.parent / "records" / "c_lhar_x_1h_final_model.json")


@dataclass(frozen=True)
class Spec:
    """The locked values behind the entry points. Tests replace SPEC with smaller values, the module never does."""

    coins: tuple[str, ...] = method.UNIVERSE
    dev_start: int = method.DEV_START
    dev_end: int = method.DEV_END
    h_start: int = method.H_START
    h_end: int = method.H_END
    cutoff_ms: int = CUTOFF_MS
    lookback_months: int = LOOKBACK_MONTHS
    min_train: int = MIN_TRAIN
    symbols_min: int | None = None
    h_seed: int = H_SEED
    h_seed_index_arg: int = H_SEED_INDEX_ARG
    d_dataset_hash: str = D_DATASET_HASH
    reference_sha256: str = REFERENCE_FORECASTS_SHA256
    reference_finite_digest: str = REFERENCE_FINITE_F_DIGEST
    reference_finite_rows: int = REFERENCE_FINITE_F_ROWS
    config: dict[str, Any] = field(default_factory=lambda: dict(family_c.family_c()[REGISTRY_INDEX]))
    dry_days: int = 150
    dry_seed: int = 12_200_002


SPEC = Spec()


def _expected_spec() -> Spec:
    """The locked values, each from its module constant. Tests that run on a smaller SPEC replace this function."""
    return Spec(
        coins=tuple(method.UNIVERSE),
        dev_start=method.DEV_START,
        dev_end=method.DEV_END,
        h_start=method.H_START,
        h_end=method.H_END,
        cutoff_ms=CUTOFF_MS,
        lookback_months=LOOKBACK_MONTHS,
        min_train=MIN_TRAIN,
        symbols_min=None,
        h_seed=H_SEED,
        h_seed_index_arg=H_SEED_INDEX_ARG,
        d_dataset_hash=D_DATASET_HASH,
        reference_sha256=REFERENCE_FORECASTS_SHA256,
        reference_finite_digest=REFERENCE_FINITE_F_DIGEST,
        reference_finite_rows=REFERENCE_FINITE_F_ROWS,
    )


def check_spec(spec: Spec) -> None:
    """Refuses unless every field of `spec` equals the locked value. Pre-load only, raises ValueError."""
    want = _expected_spec()
    differ = [f.name for f in fields(Spec) if getattr(spec, f.name) != getattr(want, f.name)]
    if differ:
        raise ValueError(f"SPEC differs from the locked values in {differ}")


# ---------------------------------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------------------------------


def _log(message: str) -> None:
    """One log line on stdout. Tests intercept it."""
    print(message, flush=True)


def _read_bytes(path: Path | str) -> bytes:
    return Path(path).read_bytes()


def _sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _sha256_path(path: Path | str) -> str:
    return _sha256_bytes(_read_bytes(path))


def _err(exc: BaseException) -> str:
    try:
        return f"{type(exc).__name__}: {exc}"
    except Exception:
        return type(exc).__name__


def _safe_log(build: Any) -> None:
    """Logs build() and swallows any failure of the message or of stdout. Used after the first guarded load."""
    try:
        _log(build() if callable(build) else build)
    except Exception:
        pass


def _plain(obj: Any) -> Any:
    """Numpy scalars and arrays to Python values. Raises on a type it does not know."""
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, dict):
        return {str(k): _plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_plain(v) for v in obj]
    return obj


def canonical_bytes(obj: Any) -> bytes:
    """json.dumps(sort_keys, compact, ASCII, no NaN) in UTF-8, numpy scalars converted first."""
    return json.dumps(_plain(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode(
        "utf-8"
    )


def to_jsonable(obj: Any, _depth: int = 0) -> Any:
    """A JSON-safe copy: keys to str, arrays to lists, non-finite floats None, other objects their str. Never raises."""
    try:
        if _depth > 60:
            return str(obj)
        if obj is None or isinstance(obj, (bool, str)):
            return obj
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, (int, np.integer)):
            return int(obj)
        if isinstance(obj, (float, np.floating)):
            v = float(obj)
            return v if math.isfinite(v) else None
        if isinstance(obj, dict):
            return {str(k): to_jsonable(v, _depth + 1) for k, v in obj.items()}
        if isinstance(obj, (list, tuple, set, frozenset)):
            return [to_jsonable(v, _depth + 1) for v in obj]
        if isinstance(obj, np.ndarray):
            return to_jsonable(obj.tolist(), _depth + 1)
        if isinstance(obj, pd.Timestamp):
            return obj.isoformat()
        if isinstance(obj, pd.DataFrame):
            return {str(c): to_jsonable(obj[c].tolist(), _depth + 1) for c in obj.columns}
        if isinstance(obj, pd.Series):
            return to_jsonable(obj.tolist(), _depth + 1)
        return str(obj)
    except Exception:
        try:
            return str(obj)
        except Exception:
            return "<unprintable>"


def _peaks() -> dict[str, float]:
    """Peak resident memory of this process and of its finished children, in MiB."""
    div = 1024.0 * 1024.0 if sys.platform == "darwin" else 1024.0
    return {
        "self_mib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / div,
        "children_mib": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / div,
    }


def _strict_path(path: str | Path, what: str) -> str:
    """The path as a string. Raises unless it is absolute and none of its components, as given, is '.' or '..'."""
    text = os.fspath(path)
    if not os.path.isabs(text):
        raise ValueError(f"{what} {text!r}: the path is not absolute")
    if any(part in (".", "..") for part in text.split(os.sep)):
        raise ValueError(f"{what} {text!r}: the path has a '.' or '..' component")
    return text


def contained(path: str | Path, root: str | Path, kind: str) -> str:
    """The path itself, after proving it is absolute, has no '.' or '..' component and no symlink on the way, lies
    under `root` and is a `kind`. Callers use the returned path, never the argument.

    kind is "file" (a regular file) or "dir". Raises ValueError otherwise. Pre-load only.
    """
    if kind not in ("file", "dir"):
        raise ValueError(f"unknown kind {kind!r}")
    p = _strict_path(path, "path")
    real = os.path.realpath(p)
    if real != p:
        raise ValueError(f"{path}: resolves to {real}, a symlink or a non-canonical form is on the way")
    real_root = os.path.realpath(os.path.normpath(os.path.abspath(str(root))))
    if os.path.commonpath([real, real_root]) != real_root:
        raise ValueError(f"{path}: lies outside {root}")
    if kind == "file" and not os.path.isfile(real):
        raise ValueError(f"{path}: not a regular file")
    if kind == "dir" and not os.path.isdir(real):
        raise ValueError(f"{path}: not a directory")
    return p


def check_code(bindings: dict[str, Any] | None) -> dict[str, Any]:
    """The file pins, method constants, registry entry, requirements lock and versions (and the bound digests).

    Raises ValueError listing every difference. Pre-load only. Returns the reproduction inputs it checked.
    """
    problems: list[str] = []
    for name, want in FROZEN_FILES_SHA256.items():
        got = _sha256_bytes(_read_bytes(_PKG_DIR / name))
        if got != want:
            problems.append(f"{name}: sha256 {got} differs from the pin {want}")
    for key, want in METHOD_EXPECTED.items():
        got = getattr(method, key, None)
        if got != want:
            problems.append(f"method.{key} differs from the lock")
    if data.MAX_HOLDOUT_READ_IDS != method.MAX_H_READ_IDS:
        problems.append("data.MAX_HOLDOUT_READ_IDS differs from method.MAX_H_READ_IDS")
    if not EARLIEST_INPUT_MS > method.DEV_START:
        problems.append("EARLIEST_INPUT_MS is not after DEV_START")
    entry = family_c.family_c()[REGISTRY_INDEX]
    if entry["id"] != FINALIST_CONFIG_ID:
        problems.append(f"registry entry {REGISTRY_INDEX} is {entry['id']!r}, not {FINALIST_CONFIG_ID!r}")
    if cli.config_hash_of(entry) != CONFIG_HASH:
        problems.append("the registry entry's config hash differs from the lock")
    repro = cli.reproduction_inputs()
    if repro["requirements_lock_sha256"] != REQUIREMENTS_LOCK_SHA256:
        problems.append("requirements.lock differs from the lock")
    if repro["versions"] != VERSIONS:
        problems.append(f"library versions {repro['versions']} differ from {VERSIONS}")
    own = _sha256_bytes(_read_bytes(Path(__file__).resolve()))
    if bindings is not None:
        try:
            check_spec(SPEC)
        except ValueError as exc:
            problems.append(str(exc))
        if repro["source_sha256"] != bindings.get("source_sha256"):
            problems.append("the r4 source digest differs from bindings.source_sha256")
        if own != bindings.get("holdout_c_sha256"):
            problems.append("holdout_c.py's sha256 differs from bindings.holdout_c_sha256")
    if problems:
        raise ValueError("check_code: " + "; ".join(problems))
    return {"reproduction_inputs": repro, "holdout_c_sha256": own}


# ---------------------------------------------------------------------------------------------------------------------
# The final model (D)
# ---------------------------------------------------------------------------------------------------------------------


def training_mask(x: pd.DataFrame, rv: pd.Series, window_ms: int, cutoff_ms: int, lookback_months: int | None) -> Any:
    """fit_fold's training mask, replicated for the record only."""
    T = x.index.to_numpy(dtype=np.int64)
    xv = x.to_numpy(dtype=np.float64)
    y = rv.reindex(x.index).to_numpy(dtype=np.float64)
    mask = np.isfinite(xv).all(axis=1) & np.isfinite(y) & (T + window_ms < cutoff_ms)
    lb = family_c.lookback_start(cutoff_ms, lookback_months)
    if lb is not None:
        mask &= T >= lb
    return mask


def final_model(
    prep: dict[str, dict[str, Any]],
    *,
    cutoff_ms: int = CUTOFF_MS,
    lookback_months: int = LOOKBACK_MONTHS,
    min_train: int = MIN_TRAIN,
    coins: tuple[str, ...] = method.UNIVERSE,
) -> dict[str, dict[str, Any]]:
    """Per coin, family_c.fit_fold at the cutoff with its record. A coin without a fit raises."""
    out: dict[str, dict[str, Any]] = {}
    for c in coins:
        p = prep[c]
        x = family_c.design(p["comp"], p["exog"], "LHAR-X", WINDOW, c == BTC)
        fit = family_c.fit_fold(x, p["win"]["RV"], p["win"]["R"], WINDOW_MS, cutoff_ms, lookback_months, min_train)
        if fit is None:
            raise ValueError(f"{c}: fewer than {min_train} training windows, no final model")
        mask = training_mask(x, p["win"]["RV"], WINDOW_MS, cutoff_ms, lookback_months)
        n_mask = int(mask.sum())
        if n_mask != fit["n_train"]:
            raise ValueError(f"{c}: the training mask has {n_mask} rows, the fit {fit['n_train']}")
        xv = x.to_numpy(dtype=np.float64)[mask]
        fitted = xv @ fit["beta"]
        with np.errstate(all="ignore"):
            f_fit = np.exp(fitted + fit["s2"] / 2.0)
            r_tr = p["win"]["R"].reindex(x.index).to_numpy(dtype=np.float64)[mask]
            z = r_tr / np.sqrt(np.maximum(f_fit, family_c.LOG_FLOOR))
        T = x.index.to_numpy(dtype=np.int64)[mask]
        out[c] = {
            "fit": fit,
            "columns": list(x.columns),
            "n_z": int(np.isfinite(z).sum()),
            "mask_count": n_mask,
            "train_T_first_ms": int(T.min()),
            "train_T_last_ms": int(T.max()),
            "train_t1_max_ms": int(T.max()) + WINDOW_MS,
            "descriptive": {
                col: {"min": float(xv[:, i].min()), "max": float(xv[:, i].max()), "mean": float(xv[:, i].mean())}
                for i, col in enumerate(x.columns)
            },
        }
    return out


def model_object(final: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """The artifact's `model`: per coin the columns, beta, s2, q, counts and the training range. No descriptive part."""
    return {
        c: {
            "columns": list(r["columns"]),
            "beta": [float(v) for v in r["fit"]["beta"]],
            "s2": float(r["fit"]["s2"]),
            "q": [float(v) for v in r["fit"]["q"]],
            "n_train": int(r["fit"]["n_train"]),
            "n_z": int(r["n_z"]),
            "train_T_first_ms": int(r["train_T_first_ms"]),
            "train_T_last_ms": int(r["train_T_last_ms"]),
            "train_t1_max_ms": int(r["train_t1_max_ms"]),
        }
        for c, r in final.items()
    }


def parse_model(model: dict[str, Any], *, coins: tuple[str, ...] = method.UNIVERSE) -> dict[str, dict[str, Any]]:
    """Per coin a fit dict as fit_fold returns it, plus `columns`. Raises on a missing coin or a bad value."""
    out: dict[str, dict[str, Any]] = {}
    for c in coins:
        if c not in model:
            raise ValueError(f"the model has no entry for {c}")
        m = model[c]
        cols = list(m["columns"])
        beta = np.asarray(m["beta"], dtype=np.float64)
        want = 7 if c == BTC else 8
        if len(cols) != want or len(beta) != len(cols):
            raise ValueError(f"{c}: {len(cols)} columns and {len(beta)} coefficients, expected {want}")
        q = [float(v) for v in m["q"]]
        s2 = float(m["s2"])
        if len(q) != 4 or not np.isfinite(beta).all() or not np.isfinite(q).all() or not math.isfinite(s2):
            raise ValueError(f"{c}: a coefficient, s2 or quantile is missing or not finite")
        out[c] = {"beta": beta, "s2": s2, "q": q, "n_train": int(m["n_train"]), "columns": cols}
    return out


def expected_columns() -> dict[str, list[str]]:
    """family_c.design's columns per coin on a one-row synthetic input."""
    names = [f"{kind}_{span}" for kind in ("rv", "c", "j") for span in ("prev", "1d", "7d", "30d")]
    comp = pd.DataFrame({n: [1.0] for n in names}, index=pd.Index([0], name="T"))
    exog = pd.DataFrame({"abs_fund": [0.0], "abs_prem": [0.0], "btc_lrv_prev": [0.0]}, index=comp.index)
    return {c: list(family_c.design(comp, exog, "LHAR-X", WINDOW, c == BTC).columns) for c in method.UNIVERSE}


# ---------------------------------------------------------------------------------------------------------------------
# Per-coin preparation and the forecast builder
# ---------------------------------------------------------------------------------------------------------------------


def prepare_btc(panel: dict[str, dict[str, pd.DataFrame]], end_ms: int) -> tuple[pd.DataFrame, dict[str, int]]:
    """BTC's window table: BTC's own windows and every other coin's BTC term (family_c.prepare_window, line 459)."""
    return family_c.window_table(panel[BTC]["5m"], WINDOW_MS, end_ms)


def prepare_coin(
    panel: dict[str, dict[str, pd.DataFrame]], c: str, btc_wt: tuple[pd.DataFrame, dict[str, int]], end_ms: int
) -> dict[str, Any]:
    """One coin's preparation, the frozen functions in prepare_window's order (family_c.py:459-477)."""
    d = panel[c]
    win, info = btc_wt if c == BTC else family_c.window_table(d["5m"], WINDOW_MS, end_ms)
    T = win.index.to_numpy(dtype=np.int64)
    comp = family_c.component_frame(win, WINDOW_MS, T)
    return {
        "win": win,
        "info": info,
        "comp": comp,
        "exog": family_c.exog_frame(T, WINDOW_MS, d.get("settlements"), d.get("premium_5m"), btc_wt[0]),
        "persistence": family_c.persistence_forecast(comp),
        "ewma": family_c.ewma_forecast(win["RV"]),
    }


def _empty_forecasts() -> pd.DataFrame:
    out = pd.DataFrame({c: pd.Series(dtype=np.float64) for c in family_c.FORECAST_COLUMNS})
    out["coin"] = out["coin"].astype(object)
    return out[family_c.FORECAST_COLUMNS]


def forecast_frame(
    prep: dict[str, dict[str, Any]],
    fits: dict[str, dict[str, Any]],
    t_lo: int,
    t_hi: int,
    *,
    coins: tuple[str, ...] = method.UNIVERSE,
    fold_ms: int = CUTOFF_MS,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """compute_forecasts' rows (family_c.py:533-582) for the fold [t_lo, t_hi) with a given fit.

    One apply_fit call per coin over all its rows (the batch rule). A coin with an empty window table or no finite-RV
    row in the fold is skipped, with no frame at all the empty frame has every FORECAST_COLUMNS column. The second
    value lists the skipped coins. No counting and no descriptive work.
    """
    frames: list[pd.DataFrame] = []
    skipped: dict[str, str] = {}
    for sym in coins:
        if sym not in prep:
            continue
        p = prep[sym]
        win = p["win"]
        if win.empty:
            skipped[sym] = "no window table"
            continue
        x = family_c.design(p["comp"], p["exog"], "LHAR-X", WINDOW, sym == BTC)
        fit = fits[sym]
        if list(x.columns) != list(fit["columns"]):
            raise ValueError(f"{sym}: the artifact's columns {list(fit['columns'])} differ from the design's")
        T = win.index.to_numpy(dtype=np.int64)
        rows = np.isfinite(win["RV"].to_numpy()) & (T >= t_lo) & (T < t_hi)
        if not rows.any():
            skipped[sym] = "no finite-RV row in the fold"
            continue
        sub = win.loc[rows]
        f = family_c.apply_fit(fit, x.loc[sub.index])
        q = np.asarray(fit["q"], dtype=np.float64)
        sd = np.sqrt(f)
        frames.append(
            pd.DataFrame(
                {
                    "coin": sym,
                    "T": sub.index.to_numpy(dtype=np.int64),
                    "y": sub["RV"].to_numpy(),
                    "f": f,
                    "persistence": p["persistence"].reindex(sub.index).to_numpy(),
                    "ewma": p["ewma"].reindex(sub.index).to_numpy(),
                    "R": sub["R"].to_numpy(),
                    "G": sub["G"].to_numpy(),
                    "fold": np.int64(fold_ms),
                    "lo80": q[0] * sd,
                    "hi80": q[1] * sd,
                    "lo95": q[2] * sd,
                    "hi95": q[3] * sd,
                }
            )
        )
    out = pd.concat(frames, ignore_index=True) if frames else _empty_forecasts()
    return out[family_c.FORECAST_COLUMNS], {"skipped": skipped}


# ---------------------------------------------------------------------------------------------------------------------
# Bitwise comparison and the bindings B1 to B4
# ---------------------------------------------------------------------------------------------------------------------


def _diff(a: pd.DataFrame | pd.Series, b: pd.DataFrame | pd.Series, *, coin_values: bool = False) -> dict[str, Any]:
    """Bitwise comparison of two frames or series: index, column order, dtypes and float columns as uint64 views.

    NaN equals NaN whatever its payload, 0.0 and -0.0 differ. With coin_values the object or str `coin` column is
    compared by value and its dtype is not compared. Returns {"equal", "reason", "n_rows_differ", "max_rel"}.
    """
    res: dict[str, Any] = {"equal": False, "reason": None, "n_rows_differ": 0, "max_rel": 0.0}
    if isinstance(a, pd.Series) != isinstance(b, pd.Series):
        res["reason"] = "one is a Series, the other a frame"
        return res
    if isinstance(a, pd.Series):
        if a.name != b.name:
            res["reason"] = f"series names differ: {a.name!r} and {b.name!r}"
            return res
        a, b = a.to_frame("v"), b.to_frame("v")
    if list(a.columns) != list(b.columns):
        res["reason"] = f"columns differ: {list(a.columns)} and {list(b.columns)}"
        return res
    if len(a) != len(b):
        res["reason"] = f"lengths differ: {len(a)} and {len(b)}"
        res["n_rows_differ"] = abs(len(a) - len(b))
        return res
    if a.index.name != b.index.name or a.index.dtype != b.index.dtype:
        res["reason"] = "index name or dtype differ"
        return res
    if not np.array_equal(a.index.to_numpy(), b.index.to_numpy()):
        res["reason"] = "index values differ"
        res["n_rows_differ"] = int((a.index.to_numpy() != b.index.to_numpy()).sum())
        return res
    for col in a.columns:
        if coin_values and col == "coin":
            continue
        if a[col].dtype != b[col].dtype:
            res["reason"] = f"dtype of {col} differs: {a[col].dtype} and {b[col].dtype}"
            return res
    bad = np.zeros(len(a), dtype=bool)
    max_rel = 0.0
    for col in a.columns:
        if coin_values and col == "coin":
            bad |= np.asarray(a[col].astype(str).to_numpy() != b[col].astype(str).to_numpy())
            continue
        x, y = a[col].to_numpy(), b[col].to_numpy()
        if x.dtype == np.float64:
            xf, yf = np.ascontiguousarray(x), np.ascontiguousarray(y)
            both_nan = np.isnan(xf) & np.isnan(yf)
            neq = (xf.view(np.uint64) != yf.view(np.uint64)) & ~both_nan
            both = neq & np.isfinite(xf) & np.isfinite(yf)
            if both.any():
                den = np.maximum(np.maximum(np.abs(xf[both]), np.abs(yf[both])), 1e-300)
                max_rel = max(max_rel, float((np.abs(xf[both] - yf[both]) / den).max()))
        else:
            neq = np.asarray(x != y)
        bad |= neq
    res["n_rows_differ"] = int(bad.sum())
    res["max_rel"] = max_rel
    res["equal"] = not bad.any()
    if not res["equal"]:
        res["reason"] = "values differ"
    return res


def _sorted_rows(df: pd.DataFrame) -> pd.DataFrame:
    return df.sort_values(["coin", "T"], kind="stable").reset_index(drop=True)


def _require_equal(label: str, d: dict[str, Any]) -> None:
    if not d["equal"]:
        raise ValueError(
            f"{label}: {d['reason']} ({d['n_rows_differ']} differing rows, largest relative difference {d['max_rel']})"
        )


def bind_d(
    panel_d: dict[str, dict[str, pd.DataFrame]],
    prep_d: dict[str, dict[str, Any]],
    reference: pd.DataFrame,
    fits: dict[str, dict[str, Any]],
    *,
    spec: Spec | None = None,
    full: bool = True,
    final: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The binding checks on D (lock 5.2). A mismatch raises with the differing rows and the largest relative gap.

    B2 and B4 always run. With full (the artifact run) B1 runs too, and B3 when `final` is given. `prep_d` is
    family_c.prepare_window on D, `fits` the parsed artifact.
    """
    sp = spec or SPEC
    coins = sp.coins
    out: dict[str, Any] = {}
    ref = _sorted_rows(reference)
    if full:
        fc, _ = family_c.compute_forecasts(panel_d, sp.config, prep_d)
        d1 = _diff(_sorted_rows(fc), ref, coin_values=True)
        _require_equal("B1 (family C reproduction)", d1)
        finite = fc.loc[np.isfinite(fc["f"].to_numpy(dtype=np.float64))]
        digest = family_d.canonical_digest(finite, "f")
        if digest != sp.reference_finite_digest or len(finite) != sp.reference_finite_rows:
            raise ValueError(
                f"B1: the finite-f digest {digest} over {len(finite)} rows differs from "
                f"{sp.reference_finite_digest} over {sp.reference_finite_rows}"
            )
        out["B1"] = {"equal": True, "rows": int(len(fc)), "finite_f_rows": int(len(finite)), "finite_f_digest": digest}
    btc_wt = prepare_btc(panel_d, sp.dev_end)
    per_coin = {c: prepare_coin(panel_d, c, btc_wt, sp.dev_end) for c in coins}
    fold_rows = ref.loc[ref["fold"].to_numpy() == sp.cutoff_ms].reset_index(drop=True)
    parts = [
        forecast_frame({c: per_coin[c]}, fits, sp.cutoff_ms, sp.dev_end, coins=(c,), fold_ms=sp.cutoff_ms)[0]
        for c in coins
    ]
    parts = [x for x in parts if len(x)]
    fr = pd.concat(parts, ignore_index=True) if parts else _empty_forecasts()
    d2 = _diff(_sorted_rows(fr), _sorted_rows(fold_rows), coin_values=True)
    _require_equal("B2 (the cutoff fold through the H builder)", d2)
    out["B2"] = {"equal": True, "rows": int(len(fr)), "fold": int(sp.cutoff_ms)}
    if final is not None:
        for c in coins:
            if c not in fits or final[c]["mask_count"] != fits[c]["n_train"]:
                raise ValueError(f"B3: {c} has no fit or its mask count differs from n_train")
        out["B3"] = {"coins": len(coins), "n_train": {c: int(fits[c]["n_train"]) for c in coins}}
    b4: dict[str, Any] = {}
    for c in coins:
        for key in ("win", "comp", "exog", "persistence", "ewma"):
            _require_equal(f"B4 ({c}, {key})", _diff(per_coin[c][key], prep_d[c][key]))
        if per_coin[c]["info"] != prep_d[c]["info"]:
            raise ValueError(f"B4 ({c}, info): {per_coin[c]['info']} differs from {prep_d[c]['info']}")
        b4[c] = True
    out["B4"] = b4
    return out


# ---------------------------------------------------------------------------------------------------------------------
# The D phase
# ---------------------------------------------------------------------------------------------------------------------


def load_d(ds: str | Path, *, spec: Spec | None = None) -> tuple[dict[str, dict[str, pd.DataFrame]], dict[str, Any]]:
    """D through r4.data: manifest verified, datasetHash bound, panel from pipeline.load_panel with no cache.

    Every 5m kline and 5m premium row must lie in [dev_start, dev_end). The earliest and latest t of each funding and
    1d frame are recorded (those loaders admit older rows). Returns the panel and the partition record.
    """
    sp = spec or SPEC
    ds_p = Path(contained(ds, ds, "dir"))
    contained(ds_p / "manifest.json", ds_p, "file")
    ok, mismatches = data.verify_manifest(ds_p)
    if not ok:
        raise ValueError(f"D: verify_manifest failed: {mismatches[:5]}")
    manifest = data.load_manifest(ds_p)
    for entry in manifest.get("files", []):
        contained(ds_p / str(entry["path"]), ds_p, "file")
    if manifest.get("datasetHash") != sp.d_dataset_hash:
        raise ValueError(f"D: datasetHash {manifest.get('datasetHash')} differs from {sp.d_dataset_hash}")
    symbols = list(manifest["symbols"])
    panel = pipeline.load_panel(ds_p, symbols)
    spans: dict[str, Any] = {}
    for sym, d in panel.items():
        rec: dict[str, Any] = {}
        for key in ("5m", "premium_5m"):
            t = d[key]["t"].to_numpy(dtype=np.int64) if len(d[key]) else np.empty(0, dtype=np.int64)
            if len(t) and (t.min() < sp.dev_start or t.max() >= sp.dev_end):
                raise ValueError(f"D partition: {sym} {key} has rows outside [{sp.dev_start}, {sp.dev_end})")
            rec[key] = {"rows": int(len(t)), "first": int(t.min()) if len(t) else None}
            rec[key]["last"] = int(t.max()) if len(t) else None
        for key in ("settlements", "1d"):
            t = d[key]["t"].to_numpy(dtype=np.int64) if len(d[key]) else np.empty(0, dtype=np.int64)
            rec[key] = {
                "rows": int(len(t)),
                "first": int(t.min()) if len(t) else None,
                "last": int(t.max()) if len(t) else None,
            }
        spans[sym] = rec
    return panel, {
        "dataset_hash": manifest["datasetHash"],
        "verify_manifest": {"ok": True, "mismatches": []},
        "symbols": symbols,
        "spans": spans,
    }


D_SPAN_FILES = (("5m", "perp/{c}/5m.jsonl.gz"), ("premium_5m", "perp/{c}/5m.premiumIndex.jsonl.gz"))


_D_SERIES = {"5m": "klines", "premium_5m": "premiumIndex"}


def compare_d_manifest(ds: str | Path, coins: tuple[str, ...]) -> dict[str, Any]:
    """D's manifest rowCount, startMs and endMs of each coin's 5m klines and 5m premium file against data.load_perp in
    D mode (the loader behind pipeline.load_panel), with the read's `_span` and `_matches`. Artifact run only.

    D mode drops rows before the holdout-A end and at or after LOCKBOX_START, which the read's H mode never does on H,
    and the exporter's end bound is inclusive, so a D file may hold the DEV_END bar. The manifest rowCount must equal
    the rows returned plus the rows the loader reports dropped. With nothing dropped the comparison is `_matches`
    exactly. A side that dropped rows needs its manifest bound beyond the loader's cut. A difference raises.
    """
    table = {str(f["path"]): f for f in data.load_manifest(ds).get("files", [])}
    records: list[dict[str, Any]] = []
    bad: list[str] = []
    for c in coins:
        for key, template in D_SPAN_FILES:
            path = template.format(c=c)
            entry = table.get(path)
            res = data.load_perp(ds, c, "5m", series=_D_SERIES[key])
            rows, first, last = _span(res.rows)
            below, above = int(res.holdout_dropped_rows), int(res.dropped_rows)
            if below == 0 and above == 0:
                ok = _matches(rows, first, last, entry)
            else:
                start = entry.get("startMs") if entry is not None else None
                end = entry.get("endMs") if entry is not None else None
                ok = (
                    entry is not None
                    and first is not None
                    and last is not None
                    and entry.get("rowCount") == rows + below + above
                    and (
                        start == first if below == 0 else isinstance(start, int) and start < res.holdout_a_end <= first
                    )
                    and (end == last if above == 0 else isinstance(end, int) and last < res.lockbox_start <= end)
                )
            records.append(
                {
                    "coin": c,
                    "path": path,
                    "rows": rows,
                    "first_t": first,
                    "last_t": last,
                    "dropped_before": below,
                    "dropped_after": above,
                    "match": ok,
                }
            )
            if not ok:
                bad.append(f"{path}: loader {rows} rows from {first} to {last} ({below} and {above} dropped), {entry}")
    if bad:
        raise ValueError(f"D manifest spans differ from the loaders' spans: {bad[:5]}")
    return {"files": len(records), "all_match": True, "records": records}


def _d_core(
    ds: str | Path,
    ref: str | Path,
    spec: Spec,
    artifact_model: dict[str, Any] | None,
    full: bool,
) -> dict[str, Any]:
    """Load D, prepare it, fit the final model, bind it. Used by the artifact run and the child process."""
    panel, partition = load_d(ds, spec=spec)
    d_manifest = compare_d_manifest(ds, spec.coins) if full else None
    prep_d = family_c.prepare_window(panel, WINDOW, spec.dev_end)
    final = final_model(
        prep_d,
        cutoff_ms=spec.cutoff_ms,
        lookback_months=spec.lookback_months,
        min_train=spec.min_train,
        coins=spec.coins,
    )
    model = model_object(final)
    model_bytes = canonical_bytes(model)
    if artifact_model is not None and canonical_bytes(artifact_model) != model_bytes:
        raise ValueError("the recomputed model differs from the artifact's model bytes")
    ref_p = Path(ref)
    ref_sha = _sha256_path(ref_p)
    if ref_sha != spec.reference_sha256:
        raise ValueError(f"the reference forecasts sha256 {ref_sha} differs from {spec.reference_sha256}")
    reference = pd.read_parquet(ref_p)
    fits = parse_model(json.loads(model_bytes), coins=spec.coins)
    binding = bind_d(panel, prep_d, reference, fits, spec=spec, full=full, final=final)
    if d_manifest is not None:
        binding["D_manifest"] = d_manifest
    return {
        "model": model,
        "model_sha256": _sha256_bytes(model_bytes),
        "reference_sha256": ref_sha,
        "partition": partition,
        "binding": binding,
        "descriptive": {c: r["descriptive"] for c, r in final.items()},
    }


def _d_phase_child(
    ds: str, ref: str, artifact_bytes: bytes, spec: Spec, full: bool
) -> dict[str, Any]:  # pragma: no cover - runs in the child process
    artifact = json.loads(artifact_bytes)
    res = _d_core(ds, ref, spec, artifact["model"], full)
    res["peak_mib"] = _peaks()["self_mib"]
    res.pop("model")
    return to_jsonable(res)  # type: ignore[no-any-return]


def d_phase(
    ds: str | Path, ref: str | Path, artifact_bytes: bytes, *, spec: Spec | None = None, full: bool = False
) -> dict[str, Any]:
    """The D binding of the read image, run in a child process so the parent never holds D (lock 4.3 check 6).

    The child recomputes the final model and compares its canonical bytes with the artifact's `model`, checks the
    reference file's sha256 and runs B2 and B4 (and B1 and B3 with full). A child that raises or exits non-zero raises
    here, before any guarded load.
    """
    sp = spec or SPEC
    ctx = multiprocessing.get_context("spawn")
    with concurrent.futures.ProcessPoolExecutor(max_workers=1, mp_context=ctx) as ex:
        return ex.submit(_d_phase_child, str(ds), str(ref), artifact_bytes, sp, full).result()  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------------------------------------------------
# Pre-load checks: the ledger, the H manifest, funding, the seed and the dry run
# ---------------------------------------------------------------------------------------------------------------------


def read_ledger(path: str | Path) -> bytes:
    """The ledger's bytes. It must already be a regular file."""
    p = Path(path)
    if not p.is_file():
        raise ValueError(f"{path}: the ledger is not a regular file")
    return p.read_bytes()


def ledger_precheck(raw: bytes, read_id: str, state: dict[str, Any], finalist_id: str) -> dict[str, Any]:
    """Fail closed on anything r4.data would skip. Pre-load only. See lock 3.3.

    Every non-empty line is a JSON object with exactly LEDGER_KEYS, a 40-hex read id, a finalist id matching r4.data's
    regex, an absolute path and an ISO UTC time. The file ends in a line feed, its first state["bytes"] bytes hash to
    state["sha256"], no line carries this finalist id or read id, and fewer than 4 distinct read ids are present.
    """
    if raw and not raw.endswith(b"\n"):
        raise ValueError("the ledger ends in a partial line")
    n = int(state["bytes"])
    if n < 0 or n > len(raw) or _sha256_bytes(raw[:n]) != state["sha256"]:
        raise ValueError("the ledger does not begin with the bound state")
    if n and raw[n - 1 : n] != b"\n":
        raise ValueError("the bound ledger state does not end on a line boundary")
    ids: set[str] = set()
    after: list[dict[str, Any]] = []
    count = 0
    offset = 0
    for chunk in raw.splitlines(keepends=True):
        start = offset
        offset += len(chunk)
        text = chunk.decode("utf-8").strip()
        if not text:
            continue
        try:
            entry = json.loads(text)
        except ValueError as exc:
            raise ValueError(f"the ledger has an unparsable line at byte {start}") from exc
        if not isinstance(entry, dict) or set(entry) != set(LEDGER_KEYS):
            raise ValueError(f"the ledger line at byte {start} does not have exactly the keys {LEDGER_KEYS}")
        rid, fid, path, at = entry["read_id"], entry["finalist_id"], entry["path"], entry["at"]
        if not isinstance(rid, str) or not _SHA40.fullmatch(rid):
            raise ValueError(f"the ledger line at byte {start} has a read id of the wrong form")
        if not isinstance(fid, str) or not data._FINALIST_ID_RE.fullmatch(fid):
            raise ValueError(f"the ledger line at byte {start} has a finalist id of the wrong form")
        if not isinstance(path, str) or not os.path.isabs(path):
            raise ValueError(f"the ledger line at byte {start} has a path that is not absolute")
        try:
            stamp = datetime.datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"the ledger line at byte {start} has a time that is not ISO") from exc
        if stamp.tzinfo is None or stamp.utcoffset() != datetime.timedelta(0):
            raise ValueError(f"the ledger line at byte {start} has a time that is not UTC")
        if fid == finalist_id or rid == read_id:
            raise ValueError(f"the ledger already holds a line for finalist {finalist_id!r} or read id {read_id}")
        ids.add(rid)
        count += 1
        if start >= n:
            after.append(entry)
    if len(ids) >= MAX_LEDGER_READ_IDS:
        raise ValueError(f"the ledger already holds {len(ids)} distinct read ids")
    return {"lines": count, "distinct_read_ids": sorted(ids), "lines_after_state": after}


def _expected_paths(coins: tuple[str, ...]) -> list[str]:
    return sorted(p.format(c=c) for c in coins for p in (*H_GUARDED, H_FUNDING))


_ENTRY_KEYS = ("path", "rowCount", "startMs", "endMs", "sha256")


def check_h_manifest(
    h_dir: str | Path,
    h_dataset_hash: str,
    h_files: list[dict[str, Any]] | None,
    *,
    coins: tuple[str, ...] = method.UNIVERSE,
    h_start: int = method.H_START,
    h_end: int = method.H_END,
    forbidden_sha256: set[str] | None = None,
) -> dict[str, Any]:
    """The H export against its bound table (lock 4.3 check 7). Pre-load only.

    verify_manifest must hold, the datasetHash must equal the bound one, the file set must be exactly the 3 files per
    coin, and each file's rowCount, startMs, endMs and sha256 must equal `h_files` (when `h_files` is None, as in
    the rehearsal, the manifest's own table is the bound one and no file may carry a hash in `forbidden_sha256`).
    Every rowCount is above 0, perp startMs is at or after h_start and every endMs is before h_end.
    """
    root = Path(h_dir)
    contained(root, root, "dir")
    contained(root / "manifest.json", root, "file")
    ok, mismatches = data.verify_manifest(root)
    if not ok:
        raise ValueError(f"H: verify_manifest failed: {mismatches[:5]}")
    manifest = data.load_manifest(root)
    if manifest.get("datasetHash") != h_dataset_hash:
        raise ValueError(f"H: datasetHash {manifest.get('datasetHash')} differs from the bound {h_dataset_hash}")
    table = {str(f["path"]): {k: f.get(k) for k in _ENTRY_KEYS} for f in manifest.get("files", [])}
    want_paths = _expected_paths(coins)
    n_files = len(manifest.get("files", []))
    if n_files != len(want_paths) or len(table) != n_files:
        raise ValueError(f"H: the manifest has {n_files} entries, {len(table)} distinct, {len(want_paths)} expected")
    if sorted(table) != want_paths:
        raise ValueError(f"H: the manifest's file set differs from the {len(want_paths)} expected files")
    if forbidden_sha256:
        for entry in table.values():
            if entry["sha256"] in forbidden_sha256:
                raise ValueError(f"H: {entry['path']} carries a hash of the real H export")
    bound = table if h_files is None else {str(f["path"]): {k: f.get(k) for k in _ENTRY_KEYS} for f in h_files}
    if sorted(bound) != want_paths or (h_files is not None and len(h_files) != len(want_paths)):
        raise ValueError("H: the bound file table differs from the expected file set")
    for path in want_paths:
        entry, want = table[path], bound[path]
        contained(root / path, root, "file")
        if entry != want:
            raise ValueError(f"H: {path} is {entry}, the bound entry is {want}")
        if not isinstance(entry["rowCount"], int) or entry["rowCount"] <= 0:
            raise ValueError(f"H: {path} has no rows")
        if entry["endMs"] is None or entry["endMs"] >= h_end:
            raise ValueError(f"H: {path} ends at or after H_END")
        if path.startswith("perp/") and entry["startMs"] < h_start:
            raise ValueError(f"H: {path} starts before H_START")
    return {"dataset_hash": manifest["datasetHash"], "files": [table[p] for p in want_paths]}


def _span(frame: pd.DataFrame) -> tuple[int, int | None, int | None]:
    if frame is None or len(frame) == 0 or "t" not in frame.columns:
        return 0, None, None
    try:
        t = frame["t"].to_numpy()
        return int(len(frame)), int(t.min()), int(t.max())
    except Exception:
        return int(len(frame)), None, None


def _matches(rows: int, first: int | None, last: int | None, entry: dict[str, Any] | None) -> bool:
    return (
        entry is not None
        and first is not None
        and last is not None
        and rows == entry.get("rowCount")
        and first == entry.get("startMs")
        and last == entry.get("endMs")
    )


def load_funding_h(
    h_dir: str | Path, h_files: list[dict[str, Any]], *, coins: tuple[str, ...] = method.UNIVERSE
) -> dict[str, Any]:
    """Funding settlements of H through r4.data (a read input, unguarded, no cache). Pre-load only.

    The row count and first and last t of each file must equal its bound entry, else this raises.
    """
    by_path = {str(f["path"]): f for f in h_files}
    frames: dict[str, pd.DataFrame] = {}
    records: list[dict[str, Any]] = []
    for c in coins:
        path = H_FUNDING.format(c=c)
        frame = data.load_funding(h_dir, c).rows
        rows, first, last = _span(frame)
        if not _matches(rows, first, last, by_path.get(path)):
            raise ValueError(f"H funding {path}: {rows} rows from {first} to {last} differ from the bound entry")
        frames[c] = frame
        records.append({"path": path, "rows": rows, "first_t": first, "last_t": last})
    return {"frames": frames, "records": records}


def _flag_frame(spec: Spec) -> pd.DataFrame:
    """A fixed synthetic frame of at least 150 days: one coin, hourly rows, both flag 1 groups non-empty."""
    rng = np.random.default_rng(spec.dry_seed)
    n = 160 * 24
    f = np.exp(rng.normal(-9.0, 0.5, n))
    return pd.DataFrame(
        {
            "coin": BTC,
            "T": spec.h_start + np.arange(n, dtype=np.int64) * WINDOW_MS,
            "y": f * np.exp(rng.normal(0.0, 0.3, n)),
            "f": f,
            "G": np.abs(rng.normal(0.0, 0.01, n)) + 0.001,
        }
    )


def seed_precheck(*, spec: Spec | None = None) -> dict[str, Any]:
    """family_c.stay_out_flag on a fixed synthetic frame with the H argument: flag 1's seed must be H_SEED and its
    bootstrap must run with a finite lower bound. Pre-load only, raises on failure."""
    sp = spec or SPEC
    res = family_c.stay_out_flag(_flag_frame(sp), WINDOW_MS, sp.h_seed_index_arg)
    flag1 = res["flag1"]
    if flag1.get("seed") != sp.h_seed:
        raise ValueError(f"seed precheck: flag 1 seed {flag1.get('seed')} is not {sp.h_seed}")
    if not np.isfinite(flag1.get("low", float("nan"))):
        raise ValueError(f"seed precheck: flag 1's bootstrap did not run ({flag1.get('reason')})")
    return {"seed": flag1["seed"], "low": float(flag1["low"]), "n_eligible": int(flag1["n_eligible"])}


@functools.lru_cache(maxsize=4)
def _dry_panel(coins: tuple[str, ...], days: int, seed: int, h_start: int) -> dict[str, dict[str, pd.DataFrame]]:
    """A deterministic H-shaped panel: the last coin has 5m rows but no complete window."""
    k = len(coins)
    cov = 0.0009 * (0.5 * np.eye(k) + 0.5 * np.ones((k, k)))
    full = synth_panel(cov, list(coins), h_start, h_start + days * DAY_MS, seed)
    rng = np.random.default_rng(seed + 1)
    panel: dict[str, dict[str, pd.DataFrame]] = {}
    for c in coins:
        prem = full[c]["premium_5m"].copy()
        prem["c"] = rng.normal(0.0001, 0.00005, size=len(prem))
        fund = full[c]["settlements"].copy()
        fund["rate"] = rng.normal(0.0001, 0.00002, size=len(fund))
        panel[c] = {"5m": full[c]["5m"], "premium_5m": prem, "settlements": fund}
    panel[coins[-1]]["5m"] = panel[coins[-1]]["5m"].iloc[:6].reset_index(drop=True)
    return panel


def _matching_records(coins: tuple[str, ...]) -> list[dict[str, Any]]:
    return [
        {"coin": c, "series": s, "path": f"dry/{c}/{s}", "rows": 1, "first_t": 0, "last_t": 0, "match": True}
        for c in coins
        for s in ("klines", "premium")
    ]


def dry_run(fits: dict[str, dict[str, Any]], *, spec: Spec | None = None) -> dict[str, Any]:
    """The gated evaluation end to end on a synthetic H-shaped panel with the real fits (lock 4.3 check 5).

    It requires that no exception was caught in any stage (N5), no "forecasts undefined" reason, rows with a finite f
    for every coin but the one without a complete window, and a flag 1 whose bootstrap ran. Pre-load only.
    """
    sp = spec or SPEC
    panel = _dry_panel(sp.coins, sp.dry_days, sp.dry_seed, sp.h_start)
    rec, pooled, _ = evaluate_gated(panel, fits, _matching_records(sp.coins), spec=sp)
    if rec["errors"]:
        raise ValueError(f"dry run: caught exceptions {rec['errors']}")
    if rec["forecasts_undefined"] or rec["stay_out"]["reason"] is not None or rec["stay_out"]["error"]:
        raise ValueError(f"dry run: the stay-out flag failed by rule or exception: {rec['stay_out']}")
    if pooled is None:
        raise ValueError("dry run: no pooled rows")
    for c in sp.coins[:-1]:
        sub = pooled.loc[pooled["coin"] == c, "f"].to_numpy(dtype=np.float64)
        if not np.isfinite(sub).any():
            raise ValueError(f"dry run: {c} has no row with a finite f")
    flag1 = rec["stay_out"]["flag1"] or {}
    if not np.isfinite(flag1.get("low", float("nan"))):
        raise ValueError("dry run: flag 1's bootstrap did not run")
    if flag1.get("seed") != sp.h_seed:
        raise ValueError(f"dry run: flag 1 seed {flag1.get('seed')} is not {sp.h_seed}")
    json.dumps(to_jsonable(rec), allow_nan=False, sort_keys=True)
    return {"rows": int(len(pooled)), "coins": list(sp.coins), "flag1_low": float(rec["stay_out"]["flag1"]["low"])}


# ---------------------------------------------------------------------------------------------------------------------
# The guarded load and the gated evaluation
# ---------------------------------------------------------------------------------------------------------------------


def load_h(
    h_dir: str | Path,
    read_id: str,
    ledger_path: str | Path,
    finalist_id: str,
    h_files: list[dict[str, Any]],
    funding: dict[str, pd.DataFrame],
    *,
    coins: tuple[str, ...] = method.UNIVERSE,
) -> tuple[dict[str, dict[str, pd.DataFrame]], list[dict[str, Any]]]:
    """The 20 guarded files through data.load_perp, per coin klines then premium. Catches no loader exception.

    Each loaded file's rows and first and last t are compared with its bound entry, and a difference is recorded in
    the load record and never raised (OD11). Each coin's entry holds exactly the three frames the loaders returned.
    """
    by_path = {str(f["path"]): f for f in h_files}
    panel: dict[str, dict[str, pd.DataFrame]] = {}
    records: list[dict[str, Any]] = []
    for c in coins:
        loaded: dict[str, pd.DataFrame] = {}
        for series, key, template in (("klines", "5m", H_GUARDED[0]), ("premiumIndex", "premium_5m", H_GUARDED[1])):
            frame = data.load_perp(
                h_dir,
                c,
                "5m",
                series=series,
                allow_holdout_a=True,
                holdout_read_id=read_id,
                holdout_finalist_id=finalist_id,
                holdout_ledger=ledger_path,
            ).rows
            path = template.format(c=c)
            rows, first, last = _span(frame)
            records.append(
                {
                    "coin": c,
                    "series": "klines" if series == "klines" else "premium",
                    "path": path,
                    "rows": rows,
                    "first_t": first,
                    "last_t": last,
                    "match": _matches(rows, first, last, by_path.get(path)),
                }
            )
            loaded[key] = frame
        panel[c] = {"5m": loaded["5m"], "premium_5m": loaded["premium_5m"], "settlements": funding[c]}
    return panel, records


def _describe_mismatch(records: list[dict[str, Any]], coin: str) -> str:
    bad = [r for r in records if r["coin"] == coin and not r["match"]]
    return "; ".join(f"{r['series']} {r['path']}: {r['rows']} rows from {r['first_t']} to {r['last_t']}" for r in bad)


def evaluate_gated(
    panel_h: dict[str, dict[str, pd.DataFrame]],
    fits: dict[str, dict[str, Any]],
    load_records: list[dict[str, Any]],
    *,
    spec: Spec | None = None,
) -> tuple[dict[str, Any], pd.DataFrame | None, dict[str, dict[str, Any]]]:
    """The gated results of lock 4.5 to 4.8. Each step is in its own guard and nothing here raises on its own.

    Order: load mismatches (OD11), BTC's window table, per coin preparation then forecasts then criteria, the
    configuration verdict, the pooled stay-out flag. A caught exception is recorded with its coin and stage. A
    coin's preparation or forecast exception, a BTC window table exception or a load mismatch fails the coin and the
    pooled flag ("forecasts undefined"). A criteria exception fails only the coin and its rows stay in the flag's
    input. Returns the gated record, the pooled frame (None if it could not be built) and the per-coin preparations.
    """
    sp = spec or SPEC
    coins = sp.coins
    errors: list[dict[str, Any]] = []
    undefined: list[str] = []
    per_coin: dict[str, dict[str, Any]] = {}
    preps: dict[str, dict[str, Any]] = {}
    frames: list[pd.DataFrame] = []
    skipped: dict[str, str] = {}
    mismatched = [c for c in coins if any(r["coin"] == c and not r["match"] for r in load_records)]

    btc_wt = None
    btc_error = ""
    try:
        btc_wt = prepare_btc(panel_h, sp.h_end)
    except Exception as exc:
        btc_error = _err(exc)
    if btc_wt is None:
        for c in coins:
            errors.append({"coin": c, "stage": "btc window table", "error": btc_error})
            undefined.append(c)
    else:
        for c in coins:
            if c in mismatched:
                errors.append({"coin": c, "stage": "load mismatch", "error": _describe_mismatch(load_records, c)})
                undefined.append(c)
                continue
            try:
                prep_c = prepare_coin(panel_h, c, btc_wt, sp.h_end)
            except Exception as exc:
                errors.append({"coin": c, "stage": "preparation", "error": _err(exc)})
                undefined.append(c)
                continue
            preps[c] = prep_c
            try:
                fr, info = forecast_frame({c: prep_c}, fits, sp.h_start, sp.h_end, coins=(c,), fold_ms=sp.cutoff_ms)
            except Exception as exc:
                errors.append({"coin": c, "stage": "forecasts", "error": _err(exc)})
                undefined.append(c)
                continue
            skipped.update(info.get("skipped", {}))
            if len(fr):
                frames.append(fr)
            try:
                per_coin[c] = family_c.coin_criteria(fr, WINDOW_MS)
            except Exception as exc:
                errors.append({"coin": c, "stage": "criteria", "error": _err(exc)})

    try:
        verdict = family_c.config_verdict(per_coin, coins, sp.symbols_min)
    except Exception as exc:
        errors.append({"coin": None, "stage": "verdict", "error": _err(exc)})
        verdict = {"pass": False, "n_coins_pass": 0, "n_coins": len(coins), "error": _err(exc)}

    pooled: pd.DataFrame | None = None
    computed: dict[str, Any] | None = None
    flag_error: str | None = None
    try:
        pooled = pd.concat(frames, ignore_index=True) if frames else _empty_forecasts()
        computed = family_c.stay_out_flag(pooled, WINDOW_MS, sp.h_seed_index_arg)
    except Exception as exc:
        flag_error = _err(exc)
        errors.append({"coin": None, "stage": "stay-out flag", "error": flag_error})

    stay: dict[str, Any] = {
        "pass": False,
        "flag1_pass": False,
        "flag2_pass": False,
        "flag1": None,
        "flag2": None,
        "reason": None,
        "coins": [],
        "error": flag_error,
    }
    if undefined:
        stay["reason"] = "forecasts undefined"
        stay["coins"] = list(undefined)
    elif computed is not None:
        stay.update(
            {
                "pass": bool(computed["pass"]),
                "flag1_pass": bool(computed["flag1"]["pass"]),
                "flag2_pass": bool(computed["flag2"]["pass"]),
                "flag1": computed["flag1"],
                "flag2": computed["flag2"],
            }
        )
    record: dict[str, Any] = {
        "per_coin": per_coin,
        "errors": errors,
        "skipped": skipped,
        "verdict": verdict,
        "stay_out": stay,
        "forecasts_undefined": list(undefined),
        "h_pass": bool(verdict["pass"]) and bool(stay["pass"]),
    }
    if undefined:
        record["stay_out_descriptive"] = computed
    return record, pooled, preps


def describe_h(
    preps: dict[str, dict[str, Any]],
    frame: pd.DataFrame | None,
    fits: dict[str, dict[str, Any]],
    load_records: list[dict[str, Any]],
    *,
    d_descriptive: dict[str, Any] | None = None,
    spec: Spec | None = None,
) -> dict[str, Any]:
    """Every descriptive field of lock 4.9, each in its own try block that records its exception as its error."""
    sp = spec or SPEC
    out: dict[str, Any] = {}

    def field_of(name: str, fn: Any) -> None:
        try:
            out[name] = fn()
        except Exception as exc:
            out[name] = {"error": _err(exc)}

    def forecast_range() -> dict[str, Any]:
        res: dict[str, Any] = {}
        for c in sp.coins:
            sub = frame.loc[frame["coin"] == c] if frame is not None else pd.DataFrame()
            fin = sub.loc[np.isfinite(sub["f"].to_numpy(dtype=np.float64))] if len(sub) else sub
            res[c] = {
                "rows": int(len(sub)),
                "finite_f_rows": int(len(fin)),
                "first_T_finite_f": int(fin["T"].min()) if len(fin) else None,
                "last_T_finite_f": int(fin["T"].max()) if len(fin) else None,
            }
        return res

    def drop_reasons() -> dict[str, Any]:
        res: dict[str, Any] = {}
        for c, p in preps.items():
            has_target = np.isfinite(p["win"]["RV"].to_numpy(dtype=np.float64))
            comp_ok = np.isfinite(p["comp"][["rv_prev", "rv_1d", "rv_7d", "rv_30d"]].to_numpy()).all(axis=1)
            res[c] = {
                "windows_with_target": int(has_target.sum()),
                "missing_component": int((has_target & ~comp_ok).sum()),
                "stale_or_missing_funding": int((has_target & ~np.isfinite(p["exog"]["abs_fund"].to_numpy())).sum()),
                "missing_premium_bar": int((has_target & ~np.isfinite(p["exog"]["abs_prem"].to_numpy())).sum()),
                "missing_btc_term": int(
                    (has_target & ~np.isfinite(p["exog"]["btc_lrv_prev"].to_numpy())).sum() if c != BTC else 0
                ),
            }
        return res

    def prep_info() -> dict[str, Any]:
        return {c: p["info"] for c, p in preps.items()}

    def regressor_ranges() -> dict[str, Any]:
        res: dict[str, Any] = {}
        for c, p in preps.items():
            x = family_c.design(p["comp"], p["exog"], "LHAR-X", WINDOW, c == BTC)
            ok = np.isfinite(x.to_numpy(dtype=np.float64)).all(axis=1) & np.isfinite(p["win"]["RV"].to_numpy())
            res[c] = {
                col: {
                    "h_min": float(x.loc[ok, col].min()) if ok.any() else None,
                    "h_max": float(x.loc[ok, col].max()) if ok.any() else None,
                    "h_mean": float(x.loc[ok, col].mean()) if ok.any() else None,
                    "d_training": (d_descriptive or {}).get(c, {}).get(col),
                }
                for col in x.columns
            }
        return res

    def loads() -> list[dict[str, Any]]:
        return list(load_records)

    field_of("forecast_range", forecast_range)
    field_of("drop_reasons", drop_reasons)
    field_of("window_info", prep_info)
    field_of("regressor_ranges", regressor_ranges)
    field_of("load_records", loads)
    return out


# ---------------------------------------------------------------------------------------------------------------------
# The artifact run and the read
# ---------------------------------------------------------------------------------------------------------------------


def _check_out(out: str | Path) -> str:
    """The output directory: a real, empty, writable directory with at least MIN_FREE_BYTES free. Pre-load only."""
    real = contained(out, out, "dir")
    if os.listdir(real):
        raise ValueError(f"{out}: the output directory is not empty")
    probe = Path(real) / ".probe"
    probe.write_bytes(b"probe")
    probe.unlink()
    free = shutil.disk_usage(real).free
    if free < MIN_FREE_BYTES:
        raise ValueError(f"{out}: {free} bytes free, at least {MIN_FREE_BYTES} are required")
    return real


def _write_bytes(path: Path, raw: bytes) -> None:
    path.write_bytes(raw)


def _json_bytes(obj: Any) -> bytes:
    return json.dumps(to_jsonable(obj), sort_keys=True, indent=1, ensure_ascii=True, allow_nan=False).encode("utf-8")


def run_artifact(ds: str, ref: str, out: str, commit: str, reproduction: str) -> dict[str, Any]:
    """The final model on D: writes artifact.json (canonical bytes), binding.json and receipt.json (last) into `out`.

    Refuses unless the A5.1 reproduction record has all_match true and an r4_source_sha256 equal to this image's
    digest. B1 to B4 must all hold.
    """
    spec = SPEC
    t0 = time.time()
    if not _COMMIT_RE.fullmatch(commit):
        raise ValueError("commit must be 7 to 40 lowercase hex characters")
    code = check_code(None)
    ds = contained(ds, ds, "dir")
    ref = contained(ref, os.path.dirname(ref), "file")
    reproduction = contained(reproduction, os.path.dirname(reproduction), "file")
    out_real = _check_out(out)
    rep_bytes = _read_bytes(reproduction)
    rep = json.loads(rep_bytes)
    if rep.get("all_match") is not True:
        raise ValueError("the reproduction record does not have all_match true")
    if rep.get("dataset_hash") != spec.d_dataset_hash:
        raise ValueError("the reproduction record's dataset_hash differs from the D dataset hash")
    if rep.get("r4_source_sha256") != code["reproduction_inputs"]["source_sha256"]:
        raise ValueError("the reproduction record was made at another r4 source digest")
    res = _d_core(ds, ref, spec, None, True)
    model = res["model"]
    model_sha = res["model_sha256"]
    entry = spec.config
    artifact = {
        "artifact": ARTIFACT_KIND,
        "finalist": FINALIST_CONFIG_ID,
        "finalist_id": FINALIST_ID,
        "registry_index": REGISTRY_INDEX,
        "config": entry,
        "config_hash": cli.config_hash_of(entry),
        "rule": {
            "cutoff_ms": spec.cutoff_ms,
            "t1_rule": "t1 strictly before the cutoff",
            "lookback_months": spec.lookback_months,
            "lookback_start_ms": family_c.lookback_start(spec.cutoff_ms, spec.lookback_months),
            "min_train_windows": spec.min_train,
            "window_ms": WINDOW_MS,
            "partition_end_ms": spec.dev_end,
        },
        "model": model,
        "model_sha256": model_sha,
        "descriptive": res["descriptive"],
        "provenance": {
            "commit": commit,
            "reproduction_inputs": code["reproduction_inputs"],
            "holdout_c_sha256": code["holdout_c_sha256"],
            "d_dataset_hash": res["partition"]["dataset_hash"],
            "d_verify_manifest": res["partition"]["verify_manifest"],
            "d_partition": res["partition"],
            "file_pins": FROZEN_FILES_SHA256,
            "reproduction_record": {"path": str(reproduction), "sha256": _sha256_bytes(rep_bytes)},
            "binding": res["binding"],
        },
    }
    artifact_bytes = canonical_bytes(artifact)
    out_p = Path(out_real)
    _write_bytes(out_p / "artifact.json", artifact_bytes)
    _write_bytes(
        out_p / "binding.json",
        _json_bytes({"model_sha256": model_sha, "artifact_sha256": _sha256_bytes(artifact_bytes), **res["binding"]}),
    )
    receipt = {
        "kind": "artifact",
        "commit": commit,
        "reproduction_inputs": code["reproduction_inputs"],
        "holdout_c_sha256": code["holdout_c_sha256"],
        "artifact_sha256": _sha256_bytes(artifact_bytes),
        "model_sha256": model_sha,
        "outputs_sha256": {n: _sha256_path(out_p / n) for n in ("artifact.json", "binding.json")},
        "peak_mib": _peaks(),
        "runtime_s": time.time() - t0,
    }
    _write_bytes(out_p / "receipt.json", _json_bytes(receipt))
    return {"artifact_sha256": _sha256_bytes(artifact_bytes), "model_sha256": model_sha, "binding": res["binding"]}


_REQUIRED_BINDINGS = (
    "source_sha256",
    "holdout_c_sha256",
    "artifact_sha256",
    "model_sha256",
    "reference_forecasts_sha256",
    "h_dataset_hash",
    "h_files",
    "ledger_state",
)


def _same_path(a: str, b: str) -> bool:
    """Exact string equality after the component rule: `a` must be absolute with no '.' or '..' component."""
    return _strict_path(a, "path") == str(b)


def run_read(
    *,
    mode: str,
    ds: str,
    h: str,
    ref: str,
    lock: str | None,
    artifact: str,
    read_id: str,
    commit: str,
    ledger: str,
    out: str,
    bindings_path: str | None = None,
) -> dict[str, Any]:
    """The read (mode "read") or its rehearsal on a synthetic export with a scratch ledger (mode "rehearsal").

    Everything before the first guarded load can raise and may be repeated. From load_h on, nothing this function
    controls raises (lock 4.4 and 4.10): load_h's own loader exceptions end the run, and the rest is guarded.
    """
    spec = SPEC
    t0 = time.time()
    if mode not in ("read", "rehearsal"):
        raise ValueError(f"unknown mode {mode!r}")
    rehearsal = mode == "rehearsal"
    finalist_id = REHEARSAL_FINALIST_ID if rehearsal else FINALIST_ID
    if not _SHA40.fullmatch(read_id) or not _SHA40.fullmatch(commit):
        raise ValueError("read id and commit must be 40 lowercase hex characters")
    if not rehearsal and read_id != commit:
        raise ValueError("in read mode the read id must equal the commit")
    h_want, ledger_want = (REHEARSAL_H_DIR, REHEARSAL_LEDGER_PATH) if rehearsal else (H_DIR, LEDGER_PATH)
    if rehearsal and (_same_path(h, H_DIR) or _same_path(ledger, LEDGER_PATH)):
        raise ValueError("rehearsal mode never touches the real H directory or the real ledger")
    for name, got, want in (
        ("H directory", h, h_want),
        ("ledger", ledger, ledger_want),
        ("D directory", ds, D_DIR),
        ("reference", ref, REF_PATH),
        ("output", out, OUT_DIR),
    ):
        if not _same_path(got, want):
            raise ValueError(f"{mode} mode: the {name} must be {want}, got {got}")
    if not rehearsal:
        for name, got, want in (
            ("lock record", lock or "", LOCK_RECORD_PATH),
            ("artifact", artifact, ARTIFACT_RECORD_PATH),
        ):
            if not _same_path(got, want):
                raise ValueError(f"read mode: the {name} must be {want}, got {got}")
    ds = contained(ds, ds, "dir")
    h = contained(h, h, "dir")
    ref = contained(ref, os.path.dirname(ref), "file")
    ledger = contained(ledger, os.path.dirname(ledger), "file")
    artifact = contained(artifact, os.path.dirname(artifact), "file")
    out_real = _check_out(out)

    if rehearsal:
        if not bindings_path:
            raise ValueError("rehearsal mode needs --bindings")
        bindings_path = contained(bindings_path, os.path.dirname(bindings_path), "file")
        lock_bytes = _read_bytes(bindings_path)
        lock_rec = json.loads(lock_bytes)
        bindings = lock_rec.get("bindings", lock_rec)
    else:
        if not lock:
            raise ValueError("read mode needs --lock")
        lock = contained(lock, os.path.dirname(lock), "file")
        lock_bytes = _read_bytes(lock)
        lock_rec = json.loads(lock_bytes)
        bindings = lock_rec.get("bindings")
        if lock_rec.get("finalist_id") != FINALIST_ID or not isinstance(bindings, dict):
            raise ValueError("the lock record has no finalist_id c-lhar-x-1h or no bindings object")
        for key, want in (
            ("finalist", FINALIST_CONFIG_ID),
            ("registry_index", REGISTRY_INDEX),
            ("config_hash", CONFIG_HASH),
        ):
            if lock_rec.get(key) != want:
                raise ValueError(f"the lock record's {key} is not {want!r}")
    needed = (*_REQUIRED_BINDINGS, "rehearsal_h_dataset_hash") if rehearsal else _REQUIRED_BINDINGS
    missing = [k for k in needed if k not in bindings]
    if missing:
        raise ValueError(f"the bindings lack {missing}")
    if bindings["reference_forecasts_sha256"] != spec.reference_sha256:
        raise ValueError("bindings.reference_forecasts_sha256 differs from the reference hash")

    code = check_code(bindings)

    artifact_bytes = _read_bytes(artifact)
    artifact_sha = _sha256_bytes(artifact_bytes)
    if artifact_sha != bindings["artifact_sha256"]:
        raise ValueError("the artifact file's sha256 differs from bindings.artifact_sha256")
    art = json.loads(artifact_bytes)
    model_sha = _sha256_bytes(canonical_bytes(art["model"]))
    if model_sha != bindings["model_sha256"] or model_sha != art.get("model_sha256"):
        raise ValueError("the artifact's model sha256 differs from the bindings")
    if (art.get("artifact"), art.get("finalist_id"), art.get("config_hash"), art.get("registry_index")) != (
        ARTIFACT_KIND,
        FINALIST_ID,
        cli.config_hash_of(spec.config),
        REGISTRY_INDEX,
    ):
        raise ValueError("the artifact's identity fields differ from the lock")
    cols = expected_columns()
    for c in spec.coins:
        if art["model"].get(c, {}).get("columns") != cols[c]:
            raise ValueError(f"the artifact's columns for {c} differ from the design's")
    fits = parse_model(json.loads(canonical_bytes(art["model"])), coins=spec.coins)

    seed_rec = seed_precheck(spec=spec)
    dry_rec = dry_run(fits, spec=spec)
    d_rec = d_phase(ds, ref, artifact_bytes, spec=spec, full=False)

    h_files = bindings["h_files"]
    if rehearsal:
        if not isinstance(h_files, list) or sorted(str(f["path"]) for f in h_files) != _expected_paths(spec.coins):
            raise ValueError("rehearsal mode needs the real H export's full file table in bindings.h_files")
        real_hashes = {str(f["sha256"]) for f in h_files}
        if not all(_SHA64.fullmatch(x) for x in real_hashes):
            raise ValueError("bindings.h_files must carry a 64-hex sha256 for every real H file")
        if bindings["rehearsal_h_dataset_hash"] == bindings["h_dataset_hash"]:
            raise ValueError("the rehearsal datasetHash equals the real H datasetHash")
        manifest_rec = check_h_manifest(
            h,
            bindings["rehearsal_h_dataset_hash"],
            None,
            coins=spec.coins,
            h_start=spec.h_start,
            h_end=spec.h_end,
            forbidden_sha256=real_hashes,
        )
        bound_files = manifest_rec["files"]
    else:
        manifest_rec = check_h_manifest(
            h, bindings["h_dataset_hash"], h_files, coins=spec.coins, h_start=spec.h_start, h_end=spec.h_end
        )
        bound_files = h_files
    funding = load_funding_h(h, bound_files, coins=spec.coins)
    raw_ledger = read_ledger(ledger)
    ledger_rec = ledger_precheck(raw_ledger, read_id, bindings["ledger_state"], finalist_id)

    peaks_before = _peaks()
    _log(
        "PRELOAD OK "
        + json.dumps(
            to_jsonable(
                {
                    "mode": mode,
                    "read_id": read_id,
                    "finalist_id": finalist_id,
                    "bindings": bindings,
                    "seed": seed_rec,
                    "dry_run": dry_rec,
                    "ledger": {k: v for k, v in ledger_rec.items() if k != "lines_after_state"},
                    "peaks_mib": peaks_before,
                }
            ),
            sort_keys=True,
        )
    )
    if read_ledger(ledger) != raw_ledger:
        raise ValueError("the ledger changed between the precheck and the first load")

    # From here on nothing this function controls raises. load_h's loader exceptions end the run (read, no verdict).
    panel_h, load_records = load_h(h, read_id, ledger, finalist_id, bound_files, funding["frames"], coins=spec.coins)
    record, pooled, preps = evaluate_gated(panel_h, fits, load_records, spec=spec)
    out_p = Path(out_real)
    failures: list[str] = []

    def guarded(name: str, fn: Any) -> None:
        try:
            fn()
        except Exception as exc:
            text = f"{name}: {_err(exc)}"
            failures.append(text)
            _safe_log(f"WRITE FAILED {text}")

    def verdict_line() -> str:
        stay = record["stay_out"]
        return (
            f"H VERDICT {finalist_id} pass={record['h_pass']} coins_pass={record['verdict'].get('n_coins_pass')} "
            f"flag1={stay['flag1_pass']} flag2={stay['flag2_pass']}"
        )

    def record_line() -> str:
        return "H RECORD " + json.dumps(to_jsonable(record), sort_keys=True, allow_nan=False)

    _safe_log(verdict_line)
    _safe_log(record_line)
    guarded(
        "verdict.txt",
        lambda: _write_bytes(out_p / "verdict.txt", (verdict_line() + "\n" + record_line() + "\n").encode("utf-8")),
    )

    descriptive: Any
    try:
        descriptive = describe_h(preps, pooled, fits, load_records, d_descriptive=d_rec.get("descriptive"), spec=spec)
    except Exception as exc:
        descriptive = {"error": _err(exc)}
    report = {
        "mode": mode,
        "read_id": read_id,
        "finalist_id": finalist_id,
        "gated": record,
        "descriptive": descriptive,
        "load_records": load_records,
        "funding_records": funding["records"],
        "d_training_ranges": d_rec.get("descriptive"),
    }
    guarded("h_report.json", lambda: _write_bytes(out_p / "h_report.json", _json_bytes(report)))
    guarded(
        "h_forecasts.parquet",
        lambda: (pooled if pooled is not None else _empty_forecasts()).to_parquet(out_p / "h_forecasts.parquet"),
    )

    def write_receipt() -> None:
        added: list[Any] = []
        try:
            for line in read_ledger(ledger).decode("utf-8").splitlines():
                entry = json.loads(line) if line.strip() else None
                if isinstance(entry, dict) and entry.get("read_id") == read_id:
                    added.append(entry)
        except Exception as exc:
            added = [{"error": _err(exc)}]
        outputs: dict[str, Any] = {}
        for name in ("verdict.txt", "h_report.json", "h_forecasts.parquet"):
            try:
                outputs[name] = _sha256_path(out_p / name)
            except Exception as exc:
                outputs[name] = {"error": _err(exc)}
        receipt = {
            "mode": mode,
            "read_id": read_id,
            "finalist_id": finalist_id,
            "commit": commit,
            "reproduction_inputs": code["reproduction_inputs"],
            "d_dataset_hash": d_rec.get("partition", {}).get("dataset_hash"),
            "h_dataset_hash": manifest_rec["dataset_hash"],
            "lock_record_sha256": _sha256_bytes(lock_bytes),
            "artifact_sha256": artifact_sha,
            "model_sha256": model_sha,
            "d_phase": d_rec,
            "ledger_lines_added": added,
            "load_records": load_records,
            "funding_records": funding["records"],
            "outputs_sha256": outputs,
            "write_failures": failures,
            "peaks_mib_before_preload_ok": peaks_before,
            "peaks_mib_after": _peaks(),
            "runtime_s": time.time() - t0,
        }
        _write_bytes(out_p / "receipt.json", _json_bytes(receipt))

    guarded("receipt.json", write_receipt)
    return {"record": record, "report": report, "write_failures": failures, "h_pass": record["h_pass"]}


def main(argv: list[str] | None = None) -> int:
    """`python -m r4.holdout_c artifact|read|rehearse`. No option overrides a locked value."""
    parser = argparse.ArgumentParser(prog="python -m r4.holdout_c", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    pa = sub.add_parser("artifact", help="the final model on D")
    for opt in ("--ds", "--ref", "--out", "--commit", "--reproduction"):
        pa.add_argument(opt, required=True)
    for name in ("read", "rehearse"):
        pr = sub.add_parser(name, help="the one read of H" if name == "read" else "a rehearsal on a synthetic export")
        for opt in ("--ds", "--h", "--ref", "--artifact", "--read-id", "--commit", "--ledger", "--out"):
            pr.add_argument(opt, required=True)
        pr.add_argument("--lock", required=name == "read")
        if name == "rehearse":
            pr.add_argument("--bindings", required=True)
    args = parser.parse_args(argv)
    check_spec(SPEC)
    if args.cmd == "artifact":
        run_artifact(args.ds, args.ref, args.out, args.commit, args.reproduction)
        return 0
    run_read(
        mode="read" if args.cmd == "read" else "rehearsal",
        ds=args.ds,
        h=args.h,
        ref=args.ref,
        lock=args.lock,
        artifact=args.artifact,
        read_id=args.read_id,
        commit=args.commit,
        ledger=args.ledger,
        out=args.out,
        bindings_path=getattr(args, "bindings", None),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
