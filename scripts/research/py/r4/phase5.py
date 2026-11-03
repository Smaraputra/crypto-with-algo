"""Phase 5 committed entry points for family A (A5.1, "Runs and seeds").

run_family runs the 45 declared configurations on the dataset, report_family writes the family's two-pass bar report
with its tripwires, hedge cost, account report and diagnostics, and run_twins runs the no-refit twins of the second
report's candidates. Each is reached through cli.main (family-run, family-report, family-twins). The rules are those
of .superpowers/sdd/round4/family-a-draft.md (draft 3), "Rules declared now".
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4 import account, bar, calibration, cli, family_a, hedge_cost
from r4.pipeline import load_panel

RETESTS_ALPHA_COUNT = 12
ROUND_ALPHA_COUNT = RETESTS_ALPHA_COUNT + 45
TRIPWIRE_SHIFTS = 100
TRIPWIRE_HALT_ABOVE = 60
HEDGE_PROFILE = "standard"


def _load(ds: Path | str) -> tuple[dict[str, Any], dict[str, dict[str, pd.DataFrame]]]:
    manifest = bar.read_manifest(Path(ds))
    return manifest, load_panel(Path(ds), list(manifest["symbols"]))


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def run_family(ds: Path | str, out_dir: Path | str, commit: str) -> list[dict[str, Any]]:
    """Run the 45 declared configurations into out_dir/runs, with configs written to out_dir/cfg."""
    out = Path(out_dir)
    manifest, panel = _load(ds)
    print("dataset", manifest["datasetHash"], flush=True)
    receipts: list[dict[str, Any]] = []
    for config in family_a.family_a():
        config_file = out / "cfg" / f"{config['id']}.json"
        _write_json(config_file, config)
        receipt = calibration._run_or_reuse(config_file, config, Path(ds), out / "runs", commit, panel)
        receipts.append(receipt)
        print(config["id"], "done", flush=True)
    return receipts


def check_complete(
    runs_dir: Path | str,
    *,
    commit: str | None = None,
    source_sha256: str | None = None,
    dataset_hash: str | None = None,
) -> None:
    """The runs directory holds exactly the 45 declared ids, each a trial receipt at its registry config hash.

    When given, every receipt must also carry this commit, r4 source digest and dataset hash (A5.1: one source digest
    per Phase 5 D outcome, the one the reproduction check matched).
    """
    runs = Path(runs_dir)
    declared = {c["id"]: c for c in family_a.family_a()}
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


def _passes_1_to_3(evaluation: dict[str, Any]) -> bool:
    return bool(evaluation["item1"]["pass"] and evaluation["item2"]["pass"] and evaluation["item3"]["pass"])


def _summary(report: dict[str, Any]) -> dict[str, Any]:
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


def report_family(ds: Path | str, runs_dir: Path | str, out_dir: Path | str, commit: str) -> dict[str, Any]:
    """The family's report (draft 3, "Rules declared now"). It never changes a verdict."""
    runs = Path(runs_dir)
    out = Path(out_dir)
    manifest, panel = _load(ds)
    check_complete(
        runs,
        commit=cli.resolve_commit(commit),
        source_sha256=cli.source_digest(),
        dataset_hash=str(manifest["datasetHash"]),
    )
    universe = list(panel.keys())
    configs = {c["id"]: c for c in family_a.family_a()}

    def family_report(tripwire: dict[str, Any] | None, out_file: Path) -> dict[str, Any]:
        return bar.family_report(
            "A",
            runs,
            runs,
            ROUND_ALPHA_COUNT,
            Path(ds),
            out_file=out_file,
            panel=panel,
            tripwire=tripwire,
            family_index=family_a.FAMILY_INDEX,
        )

    pass1 = family_report(None, out / "bar_pass1.json")
    reached = sorted(cid for cid, ev in pass1["configurations"].items() if _passes_1_to_3(ev))

    tripwires: dict[str, Any] = {}
    pass2: dict[str, Any] | None = None
    largest: int | None = None
    halted = False
    if reached:
        for cid in reached:
            config_file = out / "cfg" / f"{cid}.json"
            _write_json(config_file, configs[cid])
            result = cli.run_tripwire(config_file, Path(ds), out / "tripwires", commit=commit, panel=panel)
            tripwires[cid] = {"positive": int(result["positive"]), "n": int(result["n"])}
        largest = max(t["positive"] for t in tripwires.values())
        halted = largest > TRIPWIRE_HALT_ABOVE
        pass2 = family_report({"positive": largest, "n": TRIPWIRE_SHIFTS}, out / "bar_pass2.json")
    result_report = pass2 if pass2 is not None else pass1

    hedge: dict[str, Any] = {}
    for cid, ev in sorted(pass1["configurations"].items()):
        if ev["item1"]["pass"]:
            hedge[cid] = hedge_cost.run_hedge_cost(runs / cid, panel, universe, profile=HEDGE_PROFILE)

    accounts: dict[str, Any] = {}
    for cid in sorted(configs):
        accounts[cid] = account.account_report(runs / cid, Path(ds))

    daily = {cid: pd.read_parquet(runs / cid / "daily.parquet") for cid in sorted(configs)}
    by_cell: dict[str, list[str]] = {}
    for cid, c in configs.items():
        by_cell.setdefault(c["cell"], []).append(cid)
    within_cell_pbo: dict[str, Any] = {}
    for cell, ids in sorted(by_cell.items()):
        if len(ids) < 2:
            continue
        try:
            res = bar.item2({cid: daily[cid] for cid in ids})
            within_cell_pbo[cell] = {"pbo": res["pbo"], "pass": res["pass"], "n_configs": len(ids)}
        except ValueError as exc:
            within_cell_pbo[cell] = {"error": str(exc), "n_configs": len(ids)}

    # The cost drag is the daily costs column (fees and slippage, positive), not the net walk-forward mean.
    drag = {
        cell: float(np.mean([daily[cid]["costs"].astype(np.float64).mean() for cid in ids]))
        for cell, ids in sorted(by_cell.items())
    }
    cost_drag = {
        "mean_daily_costs_by_cell": drag,
        "ranked_worst_first": sorted(drag, key=lambda cell: drag[cell], reverse=True),
        "registered_prediction": family_a.PREDICTIONS["diagnostics"]["cost_drag_worst_first"],
    }

    index_of = {c["id"]: i for i, c in enumerate(family_a.family_a())}
    candidates = [] if halted else list(result_report["candidates"])
    twin_plan = [
        {
            "id": cand["id"],
            "registry_index": index_of[cand["id"]],
            "slot": slot,
            "twin_id": f"A_twin{slot}_{cand['id']}",
        }
        for slot, cand in enumerate(candidates[: family_a.N_RESERVE])
    ]
    twin_shortfall = [cand["id"] for cand in candidates[family_a.N_RESERVE :]]

    report = {
        "family": "A",
        "commit": commit,
        "n_configurations": len(configs),
        "round_alpha_count": ROUND_ALPHA_COUNT,
        "reached_items_1_to_3": reached,
        "n_reached_items_1_to_3": len(reached),
        "tripwires": tripwires,
        "largest_tripwire_positive": largest,
        "halted": halted,
        "result_pass": 2 if pass2 is not None else 1,
        "pass1": _summary(pass1),
        "pass2": _summary(pass2) if pass2 is not None else None,
        "hedge_cost": hedge,
        "account": accounts,
        "within_cell_pbo": within_cell_pbo,
        "cost_drag_by_cell": cost_drag,
        "predictions": family_a.PREDICTIONS,
        "twin_plan": twin_plan,
        "twin_shortfall": twin_shortfall,
    }
    _write_json(out / "family_a_report.json", report)
    return report


def run_twins(
    ds: Path | str, runs_dir: Path | str, report_file: Path | str, out_dir: Path | str, commit: str
) -> dict[str, Any]:
    """Run the report's twins into out_dir/twins/runs and answer the refit question for each."""
    out = Path(out_dir)
    runs = Path(runs_dir)
    report = json.loads(Path(report_file).read_text(encoding="utf-8"))
    _, panel = _load(ds)
    questions: dict[str, Any] = {}
    for entry in report["twin_plan"]:
        twin = family_a.family_a_twin(entry["id"], int(entry["slot"]))
        config_file = out / "twins" / "cfg" / f"{twin['id']}.json"
        _write_json(config_file, twin)
        calibration._run_or_reuse(config_file, twin, Path(ds), out / "twins" / "runs", commit, panel)
        config_daily = pd.read_parquet(runs / entry["id"] / "daily.parquet")
        twin_daily = pd.read_parquet(out / "twins" / "runs" / twin["id"] / "daily.parquet")
        question = family_a.refit_question(config_daily, twin_daily, int(entry["registry_index"]))
        questions[entry["id"]] = {"twin_id": twin["id"], "slot": int(entry["slot"]), **question}
    result = {"family": "A", "commit": commit, "refit_questions": questions}
    _write_json(out / "refit_questions.json", result)
    return result
