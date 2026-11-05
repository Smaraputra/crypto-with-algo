"""Phase 5 committed entry points for family B (A8, "Code binding", the mini-control A8.6 and the bar and reports).

noise_synth_check runs the mini-control's synthetic activity check (synthetic panels only, D's daily covariance as its
only read), run_noise_b and evaluate_noise_b run and judge the 8 registered controls on D, run_family_b runs the 18
declared configurations once the noise gates are met, report_family_b writes the family's two-pass bar report with its
tripwires, hedge cost, account report, paired comparisons and decision-level reports, and run_twins_b runs the
no-refit twin of the eligible candidate from a logged reserve slot. Each is reached through cli.main
(family-b-noise-synth, family-b-noise-run, family-b-noise-eval, family-b-run, family-b-report,
family-b-twins). The rules are those of
.superpowers/sdd/round4/family-b-draft.md (draft 4) and the declaration in r4/family_b.py. The patterns are those of
r4/phase5.py (family A) and r4/phase5_d.py (family D), copied and not patched.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4 import account, bar, calibration, cli, family_b, hedge_cost
from r4.book import parse_interval_ms
from r4.method import BAR, DEV_END, DEV_START, ENTRY_DELAY_MS
from r4.pipeline import load_panel

TRIPWIRE_SHIFTS = 100
TRIPWIRE_HALT_ABOVE = 60
HEDGE_PROFILE = "standard"
N_TRIALS = 120  # the caps sum to 120 (A 48, B 24, D 12, E 24, re-tests 12): item 3's N whatever the round count is
RESERVE_LOG_FILE = Path(__file__).resolve().parents[1] / "records" / "family_b_reserve.json"
SYNTH_FILE = "synth_b_noise.json"
NOISE_EVAL_FILE = "noise_eval_b.json"
REPORT_FILE = "family_b_report.json"
FRAMES = ("sti", "pos")  # the two frames of the mini-control

# Each primary's recorded native result, reported beside its rule configuration (draft 4, "What is already known").
NATIVE_RESULTS: dict[str, dict[str, str]] = {
    "v8": {
        "result": "CONFIRM 2025-01-01 to 2026-10-09: 1h -0.165% a trade (3,614), 4h +0.030% (411)",
        "source": "direction-exit study (dx-d0, E1)",
    },
    "ll": {
        "result": "Round 1, S0: 1h -0.1507% a trade, 4h -0.1540%, 15m -0.1472%, walk-forward selected over 18 cells",
        "source": "exploration-families.ts:73, 82, 96",
    },
    "rsi": {
        "result": "win-rate excess only: +1.32 and +0.82 points at confirmation, +0.48 (A1) and +1.46 (A2) forward, "
        "FAIL, economically unusable",
        "source": "forward-test.ts:96-112, snipe.ts:252",
    },
    "sti": {
        "result": "hold-out IC -0.0154 (t -5.86), forward 2026-07 to 2026-10 IC -0.0225 (t -3.28), FAIL",
        "source": "forward-test.ts:96-112",
    },
    "pos": {
        "result": "Phase 3b within-symbol IC 1d h32 -0.218. Phase 4c per-coin grid: 4h -0.217% a trade, 1d +0.752%, "
        "6 to 7 of 8 gates failed. L4-8h (cross-sectional) runs in lab-v1 forward",
        "source": "strategy-families.ts:1158-1213, lab-forward-v1.ts:33-36, 58-61",
    },
}


def _clean(obj: Any) -> Any:
    """JSON-safe copy: numpy scalars to Python, non-finite floats to null."""
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, list | tuple):
        return [_clean(v) for v in obj]
    if isinstance(obj, np.generic):
        obj = obj.item()
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_clean(obj), indent=2), encoding="utf-8")


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def v8_export_dirs(v8_exports: Mapping[str, Path | str] | Path | str | None) -> dict[str, Path] | None:
    """The v8 export directories by interval: a mapping as given, or v8-1h/ and v8-4h/ inside one directory."""
    if v8_exports is None:
        return None
    if isinstance(v8_exports, Mapping):
        return {str(k): Path(v) for k, v in v8_exports.items()}
    root = Path(v8_exports)
    return {"1h": root / "v8-1h", "4h": root / "v8-4h"}


def _load(
    ds: Path | str, v8_exports: Mapping[str, Path | str] | Path | str | None = None
) -> tuple[dict[str, Any], dict[str, dict[str, pd.DataFrame]]]:
    """The manifest and the panel with every family B input (Tier B rows and, when given, the v8 decisions)."""
    manifest = bar.read_manifest(Path(ds))
    panel = load_panel(Path(ds), list(manifest["symbols"]), tier_b=True, v8_exports=v8_export_dirs(v8_exports))
    return manifest, panel


def _run_config(
    config: dict[str, Any], ds: Path, cfg_dir: Path, runs_dir: Path, commit: str, panel: Any
) -> dict[str, Any]:
    config_file = cfg_dir / f"{config['id']}.json"
    _write_json(config_file, config)
    return calibration._run_or_reuse(config_file, config, ds, runs_dir, commit, panel)  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------------------------------------------------
# The mini-control's synthetic activity check (A8.6), before registration
# ---------------------------------------------------------------------------------------------------------------------


def noise_synth_check(
    out_dir: Path | str,
    commit: str,
    dcov_path: Path | str,
    *,
    start_ms: int | None = None,
    end_ms: int | None = None,
    first_refit_ms: int | None = None,
) -> dict[str, Any]:
    """Run the 8 controls on a synthetic D-shaped panel and settle their final seeds, or return the design to the owner.

    The panel is built as calibration.synthetic_v builds the V panel, from D's daily covariance (the dcov file of
    calib-dcov: second moments only, the read A1.11 allows for calibration) at family_b.SYNTH_SEED, with synthetic
    flow and metrics rows from 2023-01-01. A control below TRADE_FLOOR_TRANCHES walk-forward tranches is replaced by
    its attempt 1, then attempt 2 (noise_seed + 100 x attempt, joint_shift_seed unchanged). If any control is still
    below the floor after attempt 2 the verdict is "returned to owner" and nothing is registered. It reads no
    dataset: only the covariance file. It computes no D outcome and adds no count. Writes
    out_dir/synth_b_noise.json, never over an existing file.
    """
    from r4.synth import synth_panel, write_synthetic_dataset

    out = Path(out_dir)
    target = out / SYNTH_FILE
    if target.exists():
        raise ValueError(f"{target} exists: refusing to overwrite it")
    sha = cli.resolve_commit(commit)
    start = DEV_START if start_ms is None else int(start_ms)
    end = DEV_END if end_ms is None else int(end_ms)
    refit = family_b.FIRST_REFIT_MS if first_refit_ms is None else int(first_refit_ms)
    dcov_bytes = Path(dcov_path).read_bytes()
    dcov = json.loads(dcov_bytes.decode("utf-8"))
    symbols = list(dcov["symbols"])
    cov = np.asarray(dcov["cov"], dtype=np.float64)
    if cov.shape != (len(symbols), len(symbols)):
        raise ValueError(f"dcov covariance shape {cov.shape} does not match {len(symbols)} symbols")
    work = out / "synth_b"
    runs_dir = work / "runs"
    tmp = work / "_tmp"
    floor = int(family_b.TRADE_FLOOR_TRANCHES)
    controls: list[dict[str, Any]] = []
    final_attempts: list[int] = []
    try:
        panel = synth_panel(
            cov,
            symbols,
            start,
            end,
            seed=family_b.SYNTH_SEED,
            garch=calibration._SYNTH_GARCH,
            t_df=calibration._SYNTH_T_DF,
        )
        family_b.synthetic_tier_b(panel, family_b.SYNTH_SEED)
        ds = write_synthetic_dataset(panel, tmp / "ds")
        ds_hash = str(bar.read_manifest(ds)["datasetHash"])
        n_controls = len(family_b.family_b_noise())
        for j in range(n_controls):
            tried: list[dict[str, Any]] = []
            for attempt in range(family_b.NOISE_MAX_ATTEMPT + 1):
                attempts = [0] * n_controls
                attempts[j] = attempt
                cfg = family_b.family_b_noise(attempts)[j]
                cfg["first_refit_ms"] = refit
                receipt = _run_config(cfg, ds, tmp / "cfg", runs_dir, sha, panel)
                b = receipt["b"]
                tried.append(
                    {
                        "id": cfg["id"],
                        "attempt": attempt,
                        "noise_seed": cfg["noise_seed"],
                        "wf_tranches": int(b["wf_tranches"]),
                        "primary_decisions": int(b["wf_primary_decisions"]),
                        "acted_decisions": int(b["wf_acted_decisions"]),
                        "act_share": b["act_share"],
                        "floor_met": bool(b["wf_tranches"] >= floor),
                    }
                )
                if tried[-1]["floor_met"]:
                    break
            final = tried[-1]
            final_attempts.append(final["attempt"])
            controls.append(
                {
                    "j": j,
                    "attempts": tried,
                    "final_attempt": final["attempt"],
                    "final_id": final["id"],
                    "floor_met": final["floor_met"],
                }
            )
        del panel
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    register = all(c["floor_met"] for c in controls)
    registered = (
        [
            {"id": c["id"], "noise_seed": c["noise_seed"], "joint_shift_seed": c["joint_shift_seed"]}
            for c in family_b.family_b_noise(final_attempts)
        ]
        if register
        else []
    )
    record = {
        "kind": "synth_b_noise",
        "commit": sha,
        "panel_seed": family_b.SYNTH_SEED,
        "span": {"start_ms": start, "end_ms": end, "first_refit_ms": refit},
        "floor_tranches": floor,
        "dataset_hash": ds_hash,
        "dcov_sha256": hashlib.sha256(dcov_bytes).hexdigest(),
        "dcov_dataset_hash": dcov.get("dataset_hash"),
        "controls": controls,
        "final_attempts": final_attempts if register else None,
        "verdict": "register" if register else "returned to owner",
        "registered": registered,
        "reproduction": cli.reproduction_inputs(),
    }
    _write_json(target, record)
    return record


# ---------------------------------------------------------------------------------------------------------------------
# The mini-control on D
# ---------------------------------------------------------------------------------------------------------------------


def check_synth_record(record: Mapping[str, Any]) -> None:
    """Refuse unless the synthetic record says "register" and holds the registry's ids and seeds."""
    if record.get("kind") != "synth_b_noise":
        raise ValueError("the file is not a synthetic activity record of the family B mini-control")
    if record.get("verdict") != "register":
        raise ValueError(f"the synthetic activity check's verdict is {record.get('verdict')!r}, not 'register'")
    want = [
        {"id": c["id"], "noise_seed": c["noise_seed"], "joint_shift_seed": c["joint_shift_seed"]}
        for c in family_b.family_b_noise()
    ]
    if record.get("registered") != want:
        raise ValueError("the synthetic record's registered seeds are not the registry's family_b_noise()")
    if record.get("floor_tranches") != family_b.TRADE_FLOOR_TRANCHES:
        raise ValueError("the synthetic record was taken at another tranche floor")
    span = record.get("span")
    want_span = {"start_ms": DEV_START, "end_ms": DEV_END, "first_refit_ms": family_b.FIRST_REFIT_MS}
    if not isinstance(span, Mapping) or {k: span.get(k) for k in want_span} != want_span:
        raise ValueError(
            "the synthetic record was not taken over D's span (DEV_START to DEV_END, first refit 2024-01-01)"
        )
    if record.get("panel_seed") != family_b.SYNTH_SEED:
        raise ValueError("the synthetic record's panel seed is not SYNTH_SEED")


def run_noise_b(
    ds: Path | str,
    out_dir: Path | str,
    commit: str,
    v8_exports: Mapping[str, Path | str] | Path | str | None = None,
    synth_record: Path | str | None = None,
) -> list[dict[str, Any]]:
    """Run the 8 registered controls into out_dir/noise/runs, once the committed synthetic record says "register"."""
    if synth_record is None:
        raise ValueError("run_noise_b needs the committed synthetic record (records/synth_b_noise_<sha>.json)")
    record = json.loads(Path(synth_record).read_text(encoding="utf-8"))
    check_synth_record(record)
    out = Path(out_dir)
    manifest, panel = _load(ds, v8_exports)
    if record.get("dcov_dataset_hash") != manifest["datasetHash"]:
        raise ValueError(
            f"the synthetic record's covariance came from dataset {record.get('dcov_dataset_hash')!r}, "
            f"not this dataset {manifest['datasetHash']!r}"
        )
    print("dataset", manifest["datasetHash"], flush=True)
    receipts: list[dict[str, Any]] = []
    for config in family_b.family_b_noise():
        receipts.append(_run_config(config, Path(ds), out / "noise" / "cfg", out / "noise" / "runs", commit, panel))
        print(config["id"], "done", flush=True)
    return receipts


def noise_gates(
    active_by_frame: Mapping[str, int], n_pass_items_1_to_3: int, n_reject_joint_shift: int
) -> dict[str, Any]:
    """A8.6's gates: informative, 0 of 8 pass items 1 to 3, at most 2 of 8 reject the joint-shift null at 0.05."""
    informative = all(int(active_by_frame.get(f, 0)) >= family_b.INFORMATIVE_MIN_PER_FRAME for f in FRAMES)
    items_ok = int(n_pass_items_1_to_3) <= family_b.NOISE_BOUNDS["pass_items_1_to_3_max"]
    shift_ok = int(n_reject_joint_shift) <= family_b.NOISE_BOUNDS["joint_shift_reject_max"]
    return {
        "informative": bool(informative),
        "items_1_to_3": bool(items_ok),
        "joint_shift": bool(shift_ok),
        "gates_met": bool(informative and items_ok and shift_ok),
    }


def _frame_of(config: Mapping[str, Any]) -> str:
    return str(config["side_rule"]).removeprefix("b_noise_")


def evaluate_noise_b(
    ds: Path | str,
    noise_runs: Path | str,
    out_dir: Path | str,
    commit: str,
    joint_draws: int | None = None,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
) -> dict[str, Any]:
    """Judge the 8 controls on D by A8.6 and write out_dir/noise_eval_b.json (with the receipts' sha256).

    The calls calibration.evaluate_noise makes, on the 8 controls: item 1 per control, item 2 as one PBO on their
    matrix, item 3 at V0 with N = 120 (the within-cell V as the diagnostic), and the joint-shift null of every control
    (1,000 draws, each control's own seed, over [first refit, DEV_END)). It never calls calibration's noise verdicts,
    gate_ok or trade floor (Opus E5). A control is active at TRADE_FLOOR_TRANCHES walk-forward tranches, the
    mini-control is informative when at least INFORMATIVE_MIN_PER_FRAME controls of each frame are active, and the
    gates are the bounds of NOISE_BOUNDS. joint_draws exists so tests can shorten the null.
    """
    draws = int(BAR["random_entry_draws"]) if joint_draws is None else int(joint_draws)
    sha = cli.resolve_commit(commit)
    manifest = bar.read_manifest(Path(ds))
    runs = calibration._load_noise_runs(noise_runs)
    want_ids = [c["id"] for c in family_b.family_b_noise()]
    if sorted(runs) != sorted(want_ids):
        raise ValueError(f"the noise runs {sorted(runs)} are not the registered controls {sorted(want_ids)}")
    ids = sorted(runs)
    ds_hash = str(manifest["datasetHash"])
    source = cli.source_digest()
    for i in ids:
        r = runs[i]["receipt"]
        for key, want in (("commit", sha), ("source_sha256", source), ("dataset_hash", ds_hash)):
            if r.get(key) != want:
                raise ValueError(f"control {i} has {key} {r.get(key)!r}, not {want!r}")
        if "b" not in r:
            raise ValueError(f"control {i} has no b block in its receipt")
    registry = {c["id"]: c for c in family_b.family_b_noise()}
    for i in ids:
        if runs[i]["receipt"].get("config_hash") != cli.config_hash_of(registry[i]):
            raise ValueError(f"control {i} was run with a configuration other than its registered one")
    if panel is None:
        panel = load_panel(Path(ds), list(manifest["symbols"]))

    round_daily = {i: runs[i]["daily"] for i in ids}
    round_configs = {i: runs[i]["receipt"]["config"] for i in ids}
    variance_modes: dict[str, Any] = {}
    for vm in bar.VARIANCE_MODES:
        try:
            variance_modes[vm] = bar.trial_sharpe_variance(round_daily, round_configs, vm)
        except ValueError as exc:
            if vm == "within_cell":
                raise
            variance_modes[vm] = {"error": str(exc)}
    v_within = float(variance_modes["within_cell"]["V"])
    item2_res = bar.item2(round_daily)

    controls: dict[str, Any] = {}
    reject_p = float(BAR["random_entry_p_max"])
    for i in ids:
        run = runs[i]
        receipt = run["receipt"]
        cfg = receipt["config"]
        tranches = calibration._read_tranches(run["tranches_path"])
        res1 = bar.item1(receipt)
        res3 = bar.item3(receipt, v_within, N_TRIALS, candidate_daily=run["daily"])
        res3["variance_mode"] = "within_cell"
        seed = int(cfg["joint_shift_seed"])
        stats = bar.joint_shift_stats(
            tranches,
            panel,
            run["folds"],
            span_start_ms=int(cfg["first_refit_ms"]),
            span_end_ms=DEV_END,
            n_draws=draws,
            min_shift_days=int(BAR["random_entry_shift_min_days"]),
            seed=seed,
        )
        p, drop = bar.joint_shift_p(stats, draws)
        obs = float("nan") if (stats.n_tranches == 0 or not stats.shifts) else stats.obs_stat
        anchor = calibration._book_anchor(tranches, stats, run["daily"], label=i)
        b = receipt["b"]
        n_tr = int(b["wf_tranches"])
        controls[i] = {
            "frame": _frame_of(cfg),
            "cell": list(bar.cell_key(cfg)),
            "noise_seed": cfg.get("noise_seed"),
            "item1": res1,
            "item3": res3,
            "joint_shift": {
                "p": float(p),
                "seed": seed,
                "draws": draws,
                "drop_share": float(drop),
                "observed": float(obs) if np.isfinite(obs) else None,
            },
            "book_anchor": anchor,
            "wf_tranches": n_tr,
            "primary_decisions": int(b["wf_primary_decisions"]),
            "act_share": b["act_share"],
            "active": bool(n_tr >= family_b.TRADE_FLOOR_TRANCHES),
            "pass_items_1_to_3": bool(res1["pass"] and item2_res["pass"] and res3["pass"]),
        }
        del tranches, stats

    n_pass = sum(c["pass_items_1_to_3"] for c in controls.values())
    n_rej = sum(c["joint_shift"]["p"] < reject_p for c in controls.values())
    active_by_frame = {f: sum(1 for c in controls.values() if c["frame"] == f and c["active"]) for f in FRAMES}
    gates = noise_gates(active_by_frame, int(n_pass), int(n_rej))
    cost_by_frame = {
        f: float(
            np.mean([runs[i]["daily"]["costs"].astype(np.float64).mean() for i in ids if controls[i]["frame"] == f])
        )
        for f in FRAMES
    }
    n = len(ids)
    result = {
        "kind": "noise_eval_b",
        "commit": sha,
        "source_sha256": source,
        "dataset_hash": ds_hash,
        "receipts_sha256": {i: _file_sha256(Path(noise_runs) / i / "receipt.json") for i in ids},
        "n_controls": n,
        "controls": controls,
        "item2": item2_res,
        "variance": {"mode": "within_cell", "V": v_within, "modes": variance_modes},
        "activity": {
            "floor_tranches": family_b.TRADE_FLOOR_TRANCHES,
            "informative_min_per_frame": family_b.INFORMATIVE_MIN_PER_FRAME,
            "active_by_frame": active_by_frame,
            "informative": gates["informative"],
        },
        "gated": {
            "n_pass_items_1_to_3": int(n_pass),
            "n_reject_joint_shift_05": int(n_rej),
            "bounds": dict(family_b.NOISE_BOUNDS),
        },
        "diagnostics": {
            "act_share": {i: controls[i]["act_share"] for i in ids},
            "wf_tranches": {i: controls[i]["wf_tranches"] for i in ids},
            "mean_daily_costs_by_frame": cost_by_frame,
            "binomial_independence_benchmark": {
                "label": "independence benchmark only (binomial, not a guaranteed error rate)",
                "n": n,
                "p": reject_p,
                "expected_rejections": n * reject_p,
                "p_at_least_observed": calibration._binom_tail(n, reject_p, int(n_rej)),
            },
        },
        "gates": gates,
        "gates_met": gates["gates_met"],
        "reproduction": cli.reproduction_inputs(),
    }
    _write_json(Path(out_dir) / NOISE_EVAL_FILE, result)
    return result


# ---------------------------------------------------------------------------------------------------------------------
# The declared configurations
# ---------------------------------------------------------------------------------------------------------------------


def check_noise_gates_met(noise_eval: Path | str, commit: str, dataset_hash: str) -> dict[str, Any]:
    """Refuse unless noise_eval_b.json exists at this commit, source digest and dataset hash with gates_met true."""
    f = Path(noise_eval)
    if not f.is_file():
        raise ValueError(f"no noise evaluation at {f}: the mini-control must be evaluated before family B runs")
    data = json.loads(f.read_text(encoding="utf-8"))
    if data.get("kind") != "noise_eval_b":
        raise ValueError(f"{f} is not a family B noise evaluation")
    for key, want in (
        ("commit", cli.resolve_commit(commit)),
        ("source_sha256", cli.source_digest()),
        ("dataset_hash", dataset_hash),
    ):
        if data.get(key) != want:
            raise ValueError(f"the noise evaluation has {key} {data.get(key)!r}, not {want!r}")
    controls = data.get("controls")
    draws = int(BAR["random_entry_draws"])
    if (
        not isinstance(controls, Mapping)
        or len(controls) != len(family_b.family_b_noise())
        or any(c.get("joint_shift", {}).get("draws") != draws for c in controls.values())
    ):
        raise ValueError(f"the noise evaluation does not hold {draws} joint-shift draws for every control (A8.6)")
    if data.get("gates_met") is not True:
        raise ValueError("the noise evaluation did not meet its gates: family B does not run (A8.6)")
    return data  # type: ignore[no-any-return]


def run_family_b(
    ds: Path | str,
    out_dir: Path | str,
    commit: str,
    v8_exports: Mapping[str, Path | str] | Path | str | None = None,
    noise_eval: Path | str | None = None,
) -> list[dict[str, Any]]:
    """Run the 18 declared configurations into out_dir/runs, once the noise gates are met at this commit and dataset."""
    out = Path(out_dir)
    manifest = bar.read_manifest(Path(ds))
    check_noise_gates_met(
        out / NOISE_EVAL_FILE if noise_eval is None else noise_eval, commit, str(manifest["datasetHash"])
    )
    _, panel = _load(ds, v8_exports)
    print("dataset", manifest["datasetHash"], flush=True)
    receipts: list[dict[str, Any]] = []
    for config in family_b.family_b():
        receipts.append(_run_config(config, Path(ds), out / "cfg", out / "runs", commit, panel))
        print(config["id"], "done", flush=True)
    return receipts


def check_complete(
    runs_dir: Path | str,
    *,
    commit: str | None = None,
    source_sha256: str | None = None,
    dataset_hash: str | None = None,
) -> None:
    """The runs directory holds exactly the declared ids, each a trial receipt at its registry config hash.

    When given, every receipt must also carry this commit, r4 source digest and dataset hash. Every receipt must carry
    its b block, decisions_sha256 and meta_fits_sha256, and both parquet files must hash to them.
    """
    runs = Path(runs_dir)
    declared = {c["id"]: c for c in family_b.family_b()}
    present = {p.name for p in runs.iterdir()}
    if present != set(declared):
        missing = sorted(set(declared) - present)
        extra = sorted(present - set(declared))
        raise ValueError(f"runs directory {runs} is not the declared family: missing {missing}, extra {extra}")
    for cid, config in declared.items():
        receipt_file = runs / cid / "receipt.json"
        if not receipt_file.is_file():
            raise ValueError(f"{cid} has no receipt.json")
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
        if receipt.get("kind") != "trial":
            raise ValueError(f"{cid} is a {receipt.get('kind')!r} receipt, not a trial")
        if receipt.get("config_hash") != cli.config_hash_of(config):
            raise ValueError(f"{cid} was run with a configuration other than its registry entry")
        for key, want in (("commit", commit), ("source_sha256", source_sha256), ("dataset_hash", dataset_hash)):
            if want is not None and receipt.get(key) != want:
                raise ValueError(f"{cid} has {key} {receipt.get(key)!r}, not {want!r}")
        if not isinstance(receipt.get("b"), dict):
            raise ValueError(f"{cid} has no b block in its receipt")
        for sha_key, name in (("decisions_sha256", "decisions.parquet"), ("meta_fits_sha256", "meta_fits.parquet")):
            if not receipt.get(sha_key):
                raise ValueError(f"{cid} has no {sha_key} in its receipt")
            f = runs / cid / name
            if not f.is_file():
                raise ValueError(f"{cid} has no {name} beside its receipt")
            if _file_sha256(f) != receipt[sha_key]:
                raise ValueError(f"{cid}: {name} does not match the receipt's {sha_key}")


def read_reserve_log(path: Path | str | None = None) -> list[dict[str, Any]]:
    """records/family_b_reserve.json: one entry per consumed reserve slot (slot, id, purpose, ledger_entry)."""
    f = Path(path) if path is not None else RESERVE_LOG_FILE
    if not f.is_file():
        raise ValueError(f"the reserve log {f} is missing: create it as an empty list before the report")
    log = json.loads(f.read_text(encoding="utf-8"))
    if not isinstance(log, list):
        raise ValueError("the reserve log must be a list")
    seen: set[int] = set()
    for e in log:
        if not isinstance(e, dict) or not {"slot", "id", "purpose", "ledger_entry"} <= set(e):
            raise ValueError("a reserve log entry needs slot, id, purpose and ledger_entry")
        slot = e["slot"]
        if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < family_b.N_RESERVE:
            raise ValueError(f"reserve log slot {slot!r} is outside 0..{family_b.N_RESERVE - 1}")
        if slot in seen:
            raise ValueError(f"reserve log slot {slot} appears twice")
        seen.add(slot)
    return log


def round_alpha_count(log: list[dict[str, Any]]) -> int:
    """The round's alpha-bearing count after family B: 66 before it, the 18 declared, and each consumed reserve slot."""
    return family_b.ALPHA_BEFORE_B + family_b.N_DECLARED + len(log)


def _passes_1_to_3(evaluation: Mapping[str, Any]) -> bool:
    return bool(evaluation["item1"]["pass"] and evaluation["item2"]["pass"] and evaluation["item3"]["pass"])


def _summary(report: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "tripwire": report["tripwire"],
        "tripwire_input": report["tripwire_input"],
        "candidates": report["candidates"],
        "finalists": report["finalists"],
        "variance": report["variance"],
        "items": {
            cid: {
                "item1": ev["item1"]["pass"],
                "item2": ev["item2"]["pass"],
                "item3": ev["item3"]["pass"],
                "item4": ev["item4"].get("pass", False),
                "item5": ev["item5"]["pass"],
                "item6": ev["item6"]["pass"],
                "all_pass": ev["all_pass"],
                "joint_shift_seed": ev["joint_shift_seed"],
            }
            for cid, ev in sorted(report["configurations"].items())
        },
    }


def _n_tranches(run_dir: Path) -> int:
    f = run_dir / "tranches.parquet"
    return int(len(pd.read_parquet(f))) if f.is_file() else 0


def _receipt_hashes(runs: Path) -> dict[str, str]:
    """sha256 of each declared run's receipt.json, which binds a report to the exact runs it was written from."""
    return {c["id"]: _file_sha256(runs / c["id"] / "receipt.json") for c in family_b.family_b()}


def _abs_weights(tranches: pd.DataFrame) -> np.ndarray:
    """|weight| of each tranche of a slot book: size x (interval / h) / 10 (book.Tranche.weight)."""
    interval = tranches["interval"].map(parse_interval_ms).to_numpy(dtype=np.float64)
    return (
        np.abs(tranches["size"].to_numpy(dtype=np.float64))
        * interval
        / tranches["h_ms"].to_numpy(dtype=np.float64)
        / 10.0
    )


def _kept_mask(tr: pd.DataFrame, run_dir: Path) -> np.ndarray:
    """True for each tranche the book keeps: its fold's beta for its coin is finite (A8.4). All True without folds.json.

    A tranche belongs to the fold whose block [start, end) holds its decision time (entry minus the 10-minute delay).
    """
    folds_file = run_dir / "folds.json"
    if not folds_file.is_file():
        return np.ones(len(tr), dtype=bool)
    folds = json.loads(folds_file.read_text(encoding="utf-8"))
    decision = tr["entry_ms"].to_numpy(dtype=np.int64) - ENTRY_DELAY_MS
    kept = np.zeros(len(tr), dtype=bool)
    seen = np.zeros(len(tr), dtype=bool)
    symbols = tr["symbol"].to_numpy()
    for fold in folds:
        inside = (decision >= int(fold["start_ms"])) & (decision < int(fold["end_ms"]))
        betas = fold["betas"]
        for i in np.flatnonzero(inside):
            seen[i] = True
            beta = betas.get(str(symbols[i]))
            kept[i] = beta is not None and math.isfinite(float(beta))
    if not seen.all():
        raise ValueError(f"{run_dir} holds tranches outside every fold of its folds.json")
    return kept


def _run_statistic(run_dir: Path, first_refit_ms: int) -> dict[str, Any]:
    """A run's kept tranche count and drift-free return per unit of their weight over [first refit, DEV_END)."""
    f = run_dir / "tranches.parquet"
    tr = pd.read_parquet(f) if f.is_file() else pd.DataFrame()
    daily = pd.read_parquet(run_dir / "daily.parquet")
    w = _abs_weights(tr) if len(tr) else np.zeros(0)
    if len(tr):
        w = w[_kept_mask(tr, run_dir)]
    return {
        "tranche_count": int(len(w)),
        "abs_weight_sum": float(w.sum()),
        "per_unit_weight_mean": family_b.per_unit_weight_mean(daily, w, first_refit_ms),
    }


def _shift_comparison(cid: str, result: Mapping[str, Any], configs: Mapping[str, Any], runs: Path) -> dict[str, Any]:
    """Beside a tripwire, per shift: the shifted run's tranche count and per-unit-weight mean, and the matching rule
    configuration's own over the same span (A8.4). Descriptive, for the leakage review."""
    rule = family_b.rule_of(cid)
    first = int(configs[cid]["first_refit_ms"])
    rule_stat = _run_statistic(runs / rule["id"], first)
    meta_stat = _run_statistic(runs / cid, first)
    shifts = [
        {
            "shift_days": s.get("shift_days"),
            "wf_mean": s.get("wf_mean"),
            "tranche_count": s.get("tranche_count"),
            "per_unit_weight_mean": s.get("per_unit_weight_mean"),
        }
        for s in result.get("shifts", [])
    ]
    per_unit = [s["per_unit_weight_mean"] for s in shifts if s["per_unit_weight_mean"] is not None]
    rule_pu = rule_stat["per_unit_weight_mean"]
    return {
        "rule_id": rule["id"],
        "rule": rule_stat,
        "meta": meta_stat,
        "shifts": shifts,
        "n_shifts_recorded": len(per_unit),
        "n_shifts_with_no_tranche": sum(1 for s in shifts if s["tranche_count"] == 0),
        "median_shift_tranche_count": float(
            np.median([s["tranche_count"] for s in shifts if s["tranche_count"] is not None])
        )
        if any(s["tranche_count"] is not None for s in shifts)
        else None,
        "median_shift_per_unit_weight_mean": float(np.median(per_unit)) if per_unit else None,
        "n_shifts_per_unit_above_rule": (
            sum(1 for v in per_unit if rule_pu is not None and v > rule_pu) if rule_pu is not None else None
        ),
    }


def _eligible_candidates(evals: Mapping[str, Mapping[str, Any]], configs: Mapping[str, Any]) -> list[dict[str, Any]]:
    """bar._rank_candidates over the all-pass evaluations that pass family_b.eligible (A8.2, A8.3)."""
    passing = [
        {**dict(ev), "id": cid}
        for cid, ev in sorted(evals.items())
        if ev["all_pass"] and family_b.eligible(configs[cid])
    ]
    return bar._rank_candidates(passing)


def _decision_report(run_dir: Path) -> dict[str, Any]:
    """Act shares, sizes and precision of one run from decisions.parquet, and its fit counts from meta_fits.parquet."""
    dec = pd.read_parquet(run_dir / "decisions.parquet")
    fits = pd.read_parquet(run_dir / "meta_fits.parquet")
    wf = dec.loc[dec["phase"] == "wf"]
    acted = wf.loc[wf["acted"]]
    n, k = int(len(wf)), int(len(acted))
    paths = {}
    for phase, g in dec.loc[dec["phase"].astype(str).str.startswith("cpcv:")].groupby("phase"):
        paths[str(phase)] = {
            "primary_decisions": int(len(g)),
            "acted": int(g["acted"].sum()),
            "act_share": float(g["acted"].mean()) if len(g) else None,
        }
    deg = fits["degenerate"].astype(str) != ""
    return {
        "wf_primary_decisions": n,
        "wf_acted": k,
        "wf_act_share": (k / n) if n else None,
        "wf_mean_size": float(acted["size"].mean()) if k else None,
        "wf_precision_acted": float((acted["net"] > 0).mean()) if k else None,
        "wf_precision_all_primary": float((wf["net"] > 0).mean()) if n else None,
        "cpcv_by_path": paths,
        "fits": {
            "total": int(len(fits)),
            "by_phase": {str(p): int(c) for p, c in fits["phase"].value_counts().sort_index().items()},
            "degenerate": int(deg.sum()),
            "min_primary_rows": int(fits["rows"].min()) if len(fits) else None,
            "median_primary_rows": float(fits["rows"].median()) if len(fits) else None,
        },
    }


def _arm_divergence(configs: Mapping[str, Any], runs: Path) -> dict[str, Any]:
    """Per primary and cell, the first walk-forward refit at which a lookback arm differs from the all-history arm.

    The arms coincide at every refit whose longer window reaches the frame's start (Opus R7). A fit's first training
    row (train_t_min) is the test: the first fold where two arms start at another row.
    """
    out: dict[str, Any] = {}
    groups: dict[tuple[str, str], list[str]] = {}
    for cid, c in configs.items():
        if c["model"] == "lightgbm":
            groups.setdefault((c["primary"], c["cell"]), []).append(cid)
    for (primary, cell), ids in sorted(groups.items()):
        full = [i for i in ids if configs[i]["lookback_months"] is None]
        if not full:
            continue
        ref = pd.read_parquet(runs / full[0] / "meta_fits.parquet")
        ref_wf = ref.loc[ref["phase"] == "wf"].reset_index(drop=True)
        for cid in ids:
            if cid == full[0] or configs[cid]["lookback_months"] is None:
                continue
            fits = pd.read_parquet(runs / cid / "meta_fits.parquet")
            wf = fits.loc[fits["phase"] == "wf"].reset_index(drop=True)
            n = min(len(wf), len(ref_wf))
            differ = np.flatnonzero(wf["train_t_min"].to_numpy()[:n] != ref_wf["train_t_min"].to_numpy()[:n])
            first = int(differ[0]) if len(differ) else None
            month = None
            if first is not None:
                month = int(
                    (
                        pd.to_datetime(int(configs[cid]["first_refit_ms"]), unit="ms", utc=True)
                        + pd.DateOffset(months=first)
                    ).timestamp()
                    * 1000
                )
            out[cid] = {
                "primary": primary,
                "cell": cell,
                "compared_with": full[0],
                "n_folds_compared": int(n),
                "first_differing_wf_fit": first,
                "first_differing_refit_ms": month,
            }
    return out


def report_family_b(
    ds: Path | str,
    runs_dir: Path | str,
    out_dir: Path | str,
    commit: str,
    v8_exports: Mapping[str, Path | str] | Path | str | None = None,
    reserve_log: Path | str | None = None,
) -> dict[str, Any]:
    """The family's report (draft 4, "The bar and reports"). It never changes a verdict."""
    runs = Path(runs_dir)
    out = Path(out_dir)
    manifest, panel = _load(ds, v8_exports)
    sha = cli.resolve_commit(commit)
    check_complete(runs, commit=sha, source_sha256=cli.source_digest(), dataset_hash=str(manifest["datasetHash"]))
    log = read_reserve_log(reserve_log)
    count = round_alpha_count(log)
    universe = list(panel.keys())
    configs = {c["id"]: c for c in family_b.family_b()}
    index_of = {cid: i for i, cid in enumerate(configs)}

    def family_report(tripwire: dict[str, Any] | None, out_file: Path) -> dict[str, Any]:
        return bar.family_report(
            family_b.FAMILY,
            runs,
            runs,
            count,
            Path(ds),
            out_file=out_file,
            panel=panel,
            tripwire=tripwire,
            family_index=family_b.FAMILY_INDEX,
        )

    pass1 = family_report(None, out / "bar_pass1.json")
    reached_all = sorted(cid for cid, ev in pass1["configurations"].items() if _passes_1_to_3(ev))
    # A8.2: a "rule" configuration never gets a tripwire, never triggers or relaxes the halt.
    reached = [cid for cid in reached_all if configs[cid]["model"] == "lightgbm"]
    rule_reached = [cid for cid in reached_all if configs[cid]["model"] == "rule"]

    tripwires: dict[str, Any] = {}
    tripwire_records: dict[str, Any] = {}
    pass2: dict[str, Any] | None = None
    largest: int | None = None
    halted = False
    if reached:
        for cid in reached:
            config_file = out / "cfg" / f"{cid}.json"
            _write_json(config_file, configs[cid])
            result = cli.run_tripwire(config_file, Path(ds), out / "tripwires", commit=commit, panel=panel)
            tripwires[cid] = {"positive": int(result["positive"]), "n": int(result["n"])}
            tripwire_records[cid] = _shift_comparison(cid, result, configs, runs)
        largest = max(t["positive"] for t in tripwires.values())
        halted = largest > TRIPWIRE_HALT_ABOVE
        pass2 = family_report({"positive": largest, "n": TRIPWIRE_SHIFTS}, out / "bar_pass2.json")
    result_report = pass2 if pass2 is not None else pass1

    evals = result_report["configurations"]
    eligible_candidates = [] if halted else _eligible_candidates(evals, configs)
    tripwire_passed = pass2 is not None and not halted
    finalists = eligible_candidates if tripwire_passed else []
    ineligible_passes = sorted(
        cid for cid, ev in evals.items() if ev["all_pass"] and not family_b.eligible(configs[cid])
    )

    hedge: dict[str, Any] = {}
    for cid, ev in sorted(pass1["configurations"].items()):
        if not ev["item1"]["pass"]:
            continue
        if _n_tranches(runs / cid) == 0:
            hedge[cid] = {"skipped": "no tranches"}
        else:
            hedge[cid] = hedge_cost.run_hedge_cost(runs / cid, panel, universe, profile=HEDGE_PROFILE)

    accounts: dict[str, Any] = {}
    for cid in sorted(configs):
        if _n_tranches(runs / cid) == 0:
            accounts[cid] = {"skipped": "no tranches"}
        else:
            accounts[cid] = account.account_report(runs / cid, Path(ds))

    daily = {cid: pd.read_parquet(runs / cid / "daily.parquet") for cid in sorted(configs)}
    by_cell: dict[str, list[str]] = {}
    by_block: dict[str, list[str]] = {}
    for cid, c in configs.items():
        by_cell.setdefault(c["cell"], []).append(cid)
        by_block.setdefault(c["block"], []).append(cid)
    within_cell_pbo: dict[str, Any] = {}
    for cell, ids in sorted(by_cell.items()):
        if len(ids) < 2:
            continue
        try:
            res = bar.item2({cid: daily[cid] for cid in ids})
            within_cell_pbo[cell] = {"pbo": res["pbo"], "pass": res["pass"], "n_configs": len(ids)}
        except ValueError as exc:
            within_cell_pbo[cell] = {"error": str(exc), "n_configs": len(ids)}

    mean_costs = {cid: float(daily[cid]["costs"].astype(np.float64).mean()) for cid in sorted(configs)}
    drag_cell = {cell: float(np.mean([mean_costs[cid] for cid in ids])) for cell, ids in sorted(by_cell.items())}
    drag_block = {block: float(np.mean([mean_costs[cid] for cid in ids])) for block, ids in sorted(by_block.items())}
    cost_drag = {
        "mean_daily_costs_by_config": mean_costs,
        "mean_daily_costs_by_cell": drag_cell,
        "mean_daily_costs_by_block": drag_block,
        "ranked_worst_first": sorted(drag_cell, key=lambda cell: drag_cell[cell], reverse=True),
    }

    # The paired comparison of each meta-labelled configuration with its primary alone (descriptive, never gating).
    paired: dict[str, Any] = {}
    cost_below_rule: dict[str, bool] = {}
    for cid, c in configs.items():
        if c["model"] != "lightgbm":
            continue
        rid = family_b.rule_of(cid)["id"]
        paired[cid] = {"rule_id": rid, **family_b.paired_comparison(daily[cid], daily[rid], index_of[cid])}
        cost_below_rule[cid] = bool(mean_costs[cid] < mean_costs[rid])

    receipts = {cid: json.loads((runs / cid / "receipt.json").read_text(encoding="utf-8")) for cid in sorted(configs)}
    decision_reports = {cid: _decision_report(runs / cid) for cid in sorted(configs)}

    twin_plan: list[dict[str, Any]] = []
    twin_shortfall: list[str] = []
    if eligible_candidates:
        cand = eligible_candidates[0]
        used = {e["slot"] for e in log}
        free = [s for s in range(family_b.N_RESERVE) if s not in used]
        # A regenerated report keeps the slot already logged for this candidate's twin.
        logged = [e["slot"] for e in log if e["id"] == f"B_twin{e['slot']}_{cand['id']}"]
        if logged:
            slot: int | None = int(logged[0])
        elif free:
            slot = free[0]
        else:
            slot = None
        if slot is not None:
            twin_plan.append(
                {
                    "id": cand["id"],
                    "registry_index": index_of[cand["id"]],
                    "slot": slot,
                    "twin_id": f"B_twin{slot}_{cand['id']}",
                }
            )
        else:
            twin_shortfall.append(cand["id"])

    report = {
        "family": family_b.FAMILY,
        "commit": commit,
        "dataset_hash": str(manifest["datasetHash"]),
        "source_sha256": cli.source_digest(),
        "receipts_sha256": _receipt_hashes(runs),
        "n_configurations": len(configs),
        "round_alpha_count": count,
        "reserve_log": log,
        "n_item_3": N_TRIALS,
        "reached_items_1_to_3": reached_all,
        "n_reached_items_1_to_3": len(reached_all),
        "tripwire_set": reached,
        "rule_baseline_passes": rule_reached,
        "rule_baseline_note": "a rule configuration that meets every applicable item is presumed defective until an "
        "independent re-implementation agrees (A8.2)",
        "tripwires": tripwires,
        "tripwire_records": tripwire_records,
        "largest_tripwire_positive": largest,
        "halted": halted,
        "result_pass": 2 if pass2 is not None else 1,
        "pass1": _summary(pass1),
        "pass2": _summary(pass2) if pass2 is not None else None,
        "bar_candidates": result_report["candidates"],
        "eligible_candidates": eligible_candidates,
        "finalists": finalists,
        "ineligible_all_pass": ineligible_passes,
        "hedge_cost": hedge,
        "account": accounts,
        "within_cell_pbo": within_cell_pbo,
        "cost_drag": cost_drag,
        "paired_comparisons": paired,
        "meta_cost_below_rule": cost_below_rule,
        "decision_reports": decision_reports,
        "lookback_arm_divergence": _arm_divergence(configs, runs),
        "b_blocks": {cid: receipts[cid]["b"] for cid in sorted(configs)},
        "native_results": {c["primary"]: NATIVE_RESULTS[c["primary"]] for c in configs.values()},
        "predictions": family_b.PREDICTIONS,
        "twin_plan": twin_plan,
        "twin_shortfall": twin_shortfall,
    }
    _write_json(out / REPORT_FILE, report)
    return report


def run_twins_b(
    ds: Path | str,
    runs_dir: Path | str,
    report_file: Path | str,
    out_dir: Path | str,
    commit: str,
    v8_exports: Mapping[str, Path | str] | Path | str | None = None,
    reserve_log: Path | str | None = None,
) -> dict[str, Any]:
    """Run the report's twin into out_dir/twins/runs and answer the refit question for it.

    The reserve slot must already be in the reserve log with the twin's id (the lead logs it and its ledger entry
    first): a slot the log does not hold is refused.
    """
    out = Path(out_dir)
    runs = Path(runs_dir)
    manifest, panel = _load(ds, v8_exports)
    sha = cli.resolve_commit(commit)
    check_complete(runs, commit=sha, source_sha256=cli.source_digest(), dataset_hash=str(manifest["datasetHash"]))
    report_bytes = Path(report_file).read_bytes()
    report = json.loads(report_bytes.decode("utf-8"))
    if report.get("commit") != sha:
        raise ValueError(f"the report is at commit {report.get('commit')!r}, not {sha!r}")
    if report.get("dataset_hash") != str(manifest["datasetHash"]):
        raise ValueError(f"the report is on dataset {report.get('dataset_hash')!r}, not {manifest['datasetHash']!r}")
    if report.get("source_sha256") != cli.source_digest():
        raise ValueError(f"the report is at source digest {report.get('source_sha256')!r}, not {cli.source_digest()!r}")
    if report.get("receipts_sha256") != _receipt_hashes(runs):
        raise ValueError("the report's receipts_sha256 does not match the receipts in the runs directory")
    configs = {c["id"]: c for c in family_b.family_b()}
    index_of = {cid: i for i, cid in enumerate(configs)}
    expected = [] if report.get("halted") else [c["id"] for c in report.get("eligible_candidates", [])][:1]
    plan = report["twin_plan"]
    if [e["id"] for e in plan] != expected[: len(plan)] or len(plan) > 1:
        raise ValueError(f"the twin plan {[e['id'] for e in plan]} is not the report's eligible candidate {expected}")
    log = {e["slot"]: e for e in read_reserve_log(reserve_log)}
    for entry in plan:
        slot = entry["slot"]
        if entry["id"] not in configs or configs[entry["id"]]["model"] != "lightgbm":
            raise ValueError(f"twin plan id {entry['id']!r} is not a declared meta-labelled configuration")
        if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < family_b.N_RESERVE:
            raise ValueError(f"twin plan slot {slot!r} is outside 0..{family_b.N_RESERVE - 1}")
        if entry["twin_id"] != f"B_twin{slot}_{entry['id']}":
            raise ValueError(
                f"twin plan twin_id {entry['twin_id']!r} does not match slot {slot} and id {entry['id']!r}"
            )
        held = log.get(slot)
        if held is None or held["id"] != entry["twin_id"]:
            raise ValueError(f"reserve slot {slot} is not in the reserve log for {entry['twin_id']!r}: log it first")
    questions: dict[str, Any] = {}
    for entry in plan:
        twin = family_b.family_b_twin(entry["id"], int(entry["slot"]))
        _run_config(twin, Path(ds), out / "twins" / "cfg", out / "twins" / "runs", sha, panel)
        config_daily = pd.read_parquet(runs / entry["id"] / "daily.parquet")
        twin_daily = pd.read_parquet(out / "twins" / "runs" / twin["id"] / "daily.parquet")
        question = family_b.refit_question(config_daily, twin_daily, index_of[entry["id"]])
        questions[entry["id"]] = {"twin_id": twin["id"], "slot": int(entry["slot"]), **question}
    result = {
        "family": family_b.FAMILY,
        "commit": sha,
        "report_sha256": hashlib.sha256(report_bytes).hexdigest(),
        "refit_questions": questions,
    }
    _write_json(out / "refit_questions.json", result)
    return result
