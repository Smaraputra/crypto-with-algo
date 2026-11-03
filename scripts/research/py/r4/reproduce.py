"""The C5 reproduction check (Amendment 5, A5.1): eight C4 runs re-made from the registry into a new directory.

Each run is rebuilt with the committed path the C4 chain used (calibration._run_or_reuse on the panel load_panel
returns for the manifest's dataset), then compared with the C4 files: tranches.parquet, daily.parquet and folds.json
byte for byte (sha256), receipt.json after removing commit, source_sha256 and runtime_s at any depth, and the joint
shift at the run's C4 seed and 1,000 draws against noise_eval.json or exit_block.json, with the exit rows' zero-shift
identity. The result is written to OUT/reproduction.json; all_match is true only if every comparison holds.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4 import bar, calibration
from r4 import cli as r4_cli
from r4.method import BAR, DEV_END

REPRODUCED_RUNS: tuple[str, ...] = (
    "noise_00_ridge_C1_s1",
    "noise_12_lgbm_C2_s1",
    "noise_22_lgbmtb_C4_s1",
    "noise_28_logit_C4_s1_alt2",
    "noise_30_noref_C2_s1",
    "noise_36_d_C4_s1",
    "exit_0_E2_noise_06_ridge_C4_s1",
    "exit_3_E5_noise_06_ridge_C4_s1",
)
BYTE_FILES: tuple[str, ...] = ("tranches.parquet", "daily.parquet", "folds.json")
_IGNORED_RECEIPT_KEYS = ("commit", "source_sha256", "runtime_s")


def strip(d: Any) -> Any:
    """The receipt with commit, source_sha256 and runtime_s removed at any depth."""
    if isinstance(d, dict):
        return {k: strip(v) for k, v in d.items() if k not in _IGNORED_RECEIPT_KEYS}
    if isinstance(d, list):
        return [strip(v) for v in d]
    return d


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _same(a: Any, b: Any) -> bool:
    """Exact equality, two NaN counting as equal."""
    if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
        return True
    return bool(a == b)


def is_exit_run(run_id: str) -> bool:
    return run_id.startswith("exit_")


def c4_run_dir(c4_dir: Path, run_id: str) -> Path:
    if is_exit_run(run_id):
        return c4_dir / "exits" / "runs" / run_id
    return c4_dir / "noise_runs" / run_id


def compare_run_files(c4_run: Path, new_run: Path) -> dict[str, Any]:
    """Per-file verdicts of one reproduced run against its C4 run: sha256 pairs and the stripped receipt."""
    files: dict[str, Any] = {}
    for name in BYTE_FILES:
        old, new = _sha256(c4_run / name), _sha256(new_run / name)
        files[name] = {"c4_sha256": old, "c5_sha256": new, "match": old == new}
    old_receipt = strip(json.loads((c4_run / "receipt.json").read_text(encoding="utf-8")))
    new_receipt = strip(json.loads((new_run / "receipt.json").read_text(encoding="utf-8")))
    receipt = {"match": old_receipt == new_receipt}
    return {"files": files, "receipt": receipt}


def compare_joint(c4: dict[str, Any], c5: dict[str, Any]) -> dict[str, Any]:
    """Exact comparison of the C4 joint-shift entry with the recomputed one, key by key."""
    keys = {k: {"c4": c4.get(k), "c5": c5.get(k), "match": _same(c4.get(k), c5.get(k))} for k in sorted(c5)}
    return {"keys": keys, "match": all(v["match"] for v in keys.values())}


def run_matches(entry: dict[str, Any]) -> bool:
    return bool(
        all(f["match"] for f in entry["files"].values()) and entry["receipt"]["match"] and entry["joint_shift"]["match"]
    )


def _noise_joint(run_dir: Path, receipt: dict[str, Any], panel: Any, draws: int) -> dict[str, Any]:
    tranches = pd.read_parquet(run_dir / "tranches.parquet")
    folds = json.loads((run_dir / "folds.json").read_text(encoding="utf-8"))
    cfg = receipt["config"]
    seed = int(cfg["joint_shift_seed"])
    stats = bar.joint_shift_stats(
        tranches,
        panel,
        folds,
        span_start_ms=int(cfg["first_refit_ms"]),
        span_end_ms=DEV_END,
        n_draws=draws,
        min_shift_days=int(BAR["random_entry_shift_min_days"]),
        seed=seed,
    )
    p, drop = bar.joint_shift_p(stats, draws)
    obs = float("nan") if (stats.n_tranches == 0 or not stats.shifts) else stats.obs_stat
    return {
        "p": float(p),
        "seed": seed,
        "draws": draws,
        "drop_share": float(drop),
        "observed": float(obs) if np.isfinite(obs) else None,
    }


def _exit_joint(run_dir: Path, receipt: dict[str, Any], panel: Any, draws: int) -> dict[str, Any]:
    tranches = pd.read_parquet(run_dir / "tranches.parquet")
    folds = json.loads((run_dir / "folds.json").read_text(encoding="utf-8"))
    cfg = receipt["config"]
    seed = int(cfg["joint_shift_seed"])
    replay = bar.build_exit_replay(panel, cfg, folds)
    stats = bar.joint_shift_stats(
        tranches,
        panel,
        folds,
        span_start_ms=int(cfg["first_refit_ms"]),
        span_end_ms=DEV_END,
        n_draws=draws,
        min_shift_days=int(BAR["random_entry_shift_min_days"]),
        seed=seed,
        exit_replay=replay,
        zero_shift=True,
    )
    obs, zero = stats.obs_stat, stats.zero_shift_stat
    if zero is None or not (
        (math.isnan(obs) and math.isnan(zero)) or abs(obs - zero) <= calibration.EXIT_REPLAY_TOL * max(1.0, abs(obs))
    ):
        raise ValueError(f"{cfg['id']}: shift-zero identity broken: observed {obs!r} against replay path {zero!r}")
    p, drop = bar.joint_shift_p(stats, draws)
    return {
        "p": p,
        "seed": seed,
        "draws": draws,
        "drop_share": drop,
        "observed": float(obs) if np.isfinite(obs) else None,
        "shift_zero_observed": float(obs),
        "shift_zero_replayed": float(zero),
    }


def _c4_joint(c4_dir: Path, run_id: str) -> dict[str, Any]:
    """The C4 joint-shift entry of a run, in the keys _noise_joint and _exit_joint produce."""
    if is_exit_run(run_id):
        doc = json.loads((c4_dir / "exits" / "exit_block.json").read_text(encoding="utf-8"))
        rows = [r for r in doc["configs"] if r["id"] == run_id]
        if len(rows) != 1:
            raise ValueError(f"exit_block.json holds {len(rows)} rows for {run_id}")
        r = rows[0]
        return {
            "p": r["p"],
            "seed": r["seed"],
            "draws": r["draws"],
            "drop_share": r["drop_share"],
            "observed": r["observed"],
            "shift_zero_observed": r["shift_zero"]["observed"],
            "shift_zero_replayed": r["shift_zero"]["replayed"],
        }
    doc = json.loads((c4_dir / "noise_eval.json").read_text(encoding="utf-8"))
    return dict(doc["configs"][run_id]["joint_shift"])


def registered_configs() -> dict[str, dict[str, Any]]:
    """The eight runs' configurations from the registry (never from files)."""
    pool = {c["id"]: c for c in [*calibration.noise_final_set(), *calibration.exit_block()]}
    missing = [i for i in REPRODUCED_RUNS if i not in pool]
    if missing:
        raise ValueError(f"not in the registry: {missing}")
    return {i: pool[i] for i in REPRODUCED_RUNS}


def reproduce(ds: Path | str, c4_dir: Path | str, out_dir: Path | str, commit: str) -> dict[str, Any]:
    """Re-run the eight C4 runs into a new OUT directory and compare them with C4. Writes OUT/reproduction.json."""
    ds, c4, out = Path(ds), Path(c4_dir), Path(out_dir)
    if out.exists():
        raise FileExistsError(f"{out} exists: the reproduction goes into a new directory")
    configs = registered_configs()
    for run_id, cfg in configs.items():
        c4_receipt = json.loads((c4_run_dir(c4, run_id) / "receipt.json").read_text(encoding="utf-8"))
        if c4_receipt.get("config_hash") != r4_cli.config_hash_of(cfg):
            raise ValueError(f"{run_id}: the registry's configuration hash differs from the C4 receipt's")
    manifest = bar.read_manifest(ds)
    from r4.pipeline import load_panel

    panel = load_panel(ds, list(manifest["symbols"]))
    cfg_dir, runs = out / "cfg", out / "runs"
    cfg_dir.mkdir(parents=True)
    draws = int(BAR["random_entry_draws"])
    result_runs: dict[str, Any] = {}
    for run_id, cfg in configs.items():
        cfg_file = cfg_dir / f"{run_id}.json"
        cfg_file.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        receipt = calibration._run_or_reuse(cfg_file, cfg, ds, runs, commit, panel)
        new_run = runs / run_id
        entry = compare_run_files(c4_run_dir(c4, run_id), new_run)
        joint = (_exit_joint if is_exit_run(run_id) else _noise_joint)(new_run, receipt, panel, draws)
        entry["joint_shift"] = compare_joint(_c4_joint(c4, run_id), joint)
        entry["match"] = run_matches(entry)
        result_runs[run_id] = entry
    result = {
        "commit": r4_cli.resolve_commit(commit),
        "r4_source_sha256": r4_cli.source_digest(),
        "dataset_hash": str(manifest["datasetHash"]),
        "runs": result_runs,
        "all_match": all_match(result_runs),
    }
    (out / "reproduction.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def all_match(result_runs: dict[str, Any]) -> bool:
    """True only if all eight runs are present and every comparison of every run holds."""
    return set(result_runs) == set(REPRODUCED_RUNS) and all(run_matches(e) for e in result_runs.values())
