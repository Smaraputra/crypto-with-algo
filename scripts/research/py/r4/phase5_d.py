"""Phase 5 committed entry points for family D (A6, "The bar and reports", "Seeds", "Code").

run_family_d runs the 9 declared configurations on the dataset, report_family_d writes the family's two-pass bar report
with its tripwires, hedge cost, account report, diagnostics and the decision-level reports, and run_twins_d runs the
no-refit twins of the second report's candidates. Each is reached through cli.main (family-d-run, family-d-report,
family-d-twins). The rules are those of .superpowers/sdd/round4/family-d-draft.md (draft 3) and the declaration in
r4/family_d.py. The patterns are those of r4/phase5.py (family A), copied and not patched.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4 import account, bar, calibration, cli, family_d, hedge_cost
from r4.pipeline import load_panel

RETESTS_ALPHA_COUNT = 12
ROUND_ALPHA_COUNT = RETESTS_ALPHA_COUNT + 45 + 9
TRIPWIRE_SHIFTS = 100
TRIPWIRE_HALT_ABOVE = 60
HEDGE_PROFILE = "standard"
NEAR_DUPLICATE_BELOW = 0.01
CPCV_GROSS_ABS_MAX = 0.0001


def _load(ds: Path | str) -> tuple[dict[str, Any], dict[str, dict[str, pd.DataFrame]]]:
    manifest = bar.read_manifest(Path(ds))
    return manifest, load_panel(Path(ds), list(manifest["symbols"]))


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


def run_family_d(ds: Path | str, out_dir: Path | str, commit: str) -> list[dict[str, Any]]:
    """Run the 9 declared configurations into out_dir/runs, with configs written to out_dir/cfg."""
    out = Path(out_dir)
    manifest, panel = _load(ds)
    print("dataset", manifest["datasetHash"], flush=True)
    receipts: list[dict[str, Any]] = []
    for config in family_d.family_d():
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
    """The runs directory holds exactly the 9 declared ids, each a trial receipt at its registry config hash.

    When given, every receipt must also carry this commit, r4 source digest and dataset hash. Every receipt must carry
    d_vol and decisions_sha256, and its decisions.parquet must hash to it.
    """
    runs = Path(runs_dir)
    declared = {c["id"]: c for c in family_d.family_d()}
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
        if not isinstance(receipt.get("d_vol"), dict):
            raise ValueError(f"{cid} has no d_vol in its receipt")
        if not receipt.get("decisions_sha256"):
            raise ValueError(f"{cid} has no decisions_sha256 in its receipt")
        decisions = runs / cid / "decisions.parquet"
        if not decisions.is_file():
            raise ValueError(f"{cid} has no decisions.parquet beside its receipt")
        if _file_sha256(decisions) != receipt["decisions_sha256"]:
            raise ValueError(f"{cid}: decisions.parquet does not match the receipt's decisions_sha256")


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


def _n_tranches(run_dir: Path) -> int:
    """Rows in a run's tranches.parquet, 0 when the run traded nothing (or wrote no file)."""
    f = run_dir / "tranches.parquet"
    return int(len(pd.read_parquet(f))) if f.is_file() else 0


def _receipt_hashes(runs: Path) -> dict[str, str]:
    """sha256 of each declared run's receipt.json, which binds a report to the exact runs it was written from."""
    return {c["id"]: _file_sha256(runs / c["id"] / "receipt.json") for c in family_d.family_d()}


def _decision_times(decisions: pd.DataFrame) -> pd.DataFrame:
    """One row per (phase, call, T): the ranked count, whether the target was cash and whether w_prev was taken."""
    if decisions.empty:
        return pd.DataFrame(
            {
                "phase": pd.Series(dtype=object),
                "call": pd.Series(dtype=np.int64),
                "T": pd.Series(dtype=np.int64),
                "n_ranked": pd.Series(dtype=np.int64),
                "cash": pd.Series(dtype=bool),
                "took": pd.Series(dtype=bool),
            }
        )
    grouped = decisions.groupby(["phase", "call", "T"], sort=True).agg(
        n_ranked=("ranked", "sum"), cash=("cash", "all"), took=("took_prev", "all")
    )
    return grouped.reset_index()


def _cash_shares(times: pd.DataFrame) -> dict[str, Any]:
    n = int(len(times))
    if n == 0:
        return {"n_times": 0, "cash_share": None, "all_tie_cash_share": None, "fewer_than_6_cash_share": None}
    cash = times["cash"].to_numpy(dtype=bool)
    ranked = times["n_ranked"].to_numpy(dtype=np.int64)
    all_tie = int((cash & (ranked >= family_d.MIN_D_COINS)).sum())
    few = int((cash & (ranked < family_d.MIN_D_COINS)).sum())
    return {
        "n_times": n,
        "cash_share": float(cash.sum() / n),
        "all_tie_cash_share": float(all_tie / n),
        "fewer_than_6_cash_share": float(few / n),
    }


def _decision_report(config: dict[str, Any], run_dir: Path, receipt: dict[str, Any]) -> dict[str, Any]:
    """The D-specific, never gating, numbers of one configuration from its decisions.parquet and receipt."""
    times = _decision_times(pd.read_parquet(run_dir / "decisions.parquet"))
    wf = times[times["phase"] == "wf"]
    cpcv = times[times["phase"].astype(str).str.startswith("cpcv:")]
    non_cash_wf = wf[~wf["cash"]]
    n_took = int(wf["took"].sum())
    take_share = float(n_took / len(non_cash_wf)) if len(non_cash_wf) else None
    take_share_all = float(n_took / len(wf)) if len(wf) else None
    band = float(config["d_band"])
    near_duplicate = bool(band > 0.0 and take_share is not None and take_share < NEAR_DUPLICATE_BELOW)
    per_call = {
        int(call): _cash_shares(g.sort_values("T")) for call, g in sorted(cpcv.groupby("call"), key=lambda kv: kv[0])
    }
    per_path = {
        int(str(phase).split(":", 1)[1]): _cash_shares(g.sort_values(["call", "T"]))
        for phase, g in sorted(cpcv.groupby("phase"), key=lambda kv: int(str(kv[0]).split(":", 1)[1]))
    }
    gross = [float(v) for v in receipt["metrics"]["cpcv_path_gross_means"]]
    gross_mean = float(np.mean(gross)) if gross else None
    every_cpcv_cash = bool(len(cpcv) == 0 or cpcv["cash"].all())
    return {
        "band": band,
        "wf_take_prev_count": n_took,
        "wf_non_cash_times": int(len(non_cash_wf)),
        "wf_all_times": int(len(wf)),
        "wf_take_prev_share": take_share,
        "wf_take_prev_share_all_times": take_share_all,
        "near_duplicate_of_b0": near_duplicate,
        "wf_cash": _cash_shares(wf),
        "cpcv_cash_by_path": per_path,
        "cpcv_cash_by_call": per_call,
        "cpcv_gross": {
            "path_means": gross,
            "mean": gross_mean,
            "abs_at_most": CPCV_GROSS_ABS_MAX,
            "within_bound": bool(gross_mean is not None and abs(gross_mean) <= CPCV_GROSS_ABS_MAX),
            "uninformative": every_cpcv_cash,
        },
    }


def report_family_d(ds: Path | str, runs_dir: Path | str, out_dir: Path | str, commit: str) -> dict[str, Any]:
    """The family's report (draft 3, "The bar and reports"). It never changes a verdict."""
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
    configs = {c["id"]: c for c in family_d.family_d()}

    def family_report(tripwire: dict[str, Any] | None, out_file: Path) -> dict[str, Any]:
        return bar.family_report(
            "D",
            runs,
            runs,
            ROUND_ALPHA_COUNT,
            Path(ds),
            out_file=out_file,
            panel=panel,
            tripwire=tripwire,
            family_index=family_d.FAMILY_INDEX,
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
    by_band: dict[str, list[str]] = {}
    for cid, c in configs.items():
        by_cell.setdefault(c["cell"], []).append(cid)
        by_band.setdefault(repr(float(c["d_band"])), []).append(cid)
    within_cell_pbo: dict[str, Any] = {}
    for cell, ids in sorted(by_cell.items()):
        if len(ids) < 2:
            continue
        try:
            res = bar.item2({cid: daily[cid] for cid in ids})
            within_cell_pbo[cell] = {"pbo": res["pbo"], "pass": res["pass"], "n_configs": len(ids)}
        except ValueError as exc:
            within_cell_pbo[cell] = {"error": str(exc), "n_configs": len(ids)}

    # The cost drag is the daily costs column (fees and slippage, positive), by cell and by band.
    mean_costs = {cid: float(daily[cid]["costs"].astype(np.float64).mean()) for cid in sorted(configs)}
    drag_cell = {cell: float(np.mean([mean_costs[cid] for cid in ids])) for cell, ids in sorted(by_cell.items())}
    drag_band = {band: float(np.mean([mean_costs[cid] for cid in ids])) for band, ids in sorted(by_band.items())}
    cost_drag = {
        "mean_daily_costs_by_config": mean_costs,
        "mean_daily_costs_by_cell": drag_cell,
        "mean_daily_costs_by_band": drag_band,
        "ranked_worst_first": sorted(drag_cell, key=lambda cell: drag_cell[cell], reverse=True),
    }

    # The cost check: within each cell the mean daily cost is non-increasing in the band.
    cost_check: dict[str, Any] = {}
    for cell, ids in sorted(by_cell.items()):
        ordered = sorted(ids, key=lambda cid: float(configs[cid]["d_band"]))
        series = [mean_costs[cid] for cid in ordered]
        cost_check[cell] = {
            "ids_by_band": ordered,
            "mean_daily_costs": series,
            "non_increasing": bool(all(b <= a for a, b in zip(series, series[1:], strict=False))),
        }
    cost_check["registered_prediction"] = family_d.PREDICTIONS["diagnostics"][
        "mean_daily_cost_non_increasing_in_band_within_cell"
    ]

    # Decision-level reports and the f parity values, from the receipts and decisions.parquet.
    receipts = {cid: json.loads((runs / cid / "receipt.json").read_text(encoding="utf-8")) for cid in sorted(configs)}
    decision_reports = {cid: _decision_report(configs[cid], runs / cid, receipts[cid]) for cid in sorted(configs)}
    d_vol = {cid: receipts[cid]["d_vol"] for cid in sorted(configs)}
    first = next(iter(d_vol.values()))
    parity = {
        "parity_digest": first["parity_digest"],
        "parity_rows": first["parity_rows"],
        "full_grid_digest": first["full_grid_digest"],
        "full_grid_rows": first["full_grid_rows"],
        "missing_wf_hours_by_coin": first["missing_wf_hours_by_coin"],
        "n_keys_differing": first["n_keys_differing"],
        "max_rel_diff": first["max_rel_diff"],
        "identical_across_configurations": bool(all(v == first for v in d_vol.values())),
    }

    index_of = {c["id"]: i for i, c in enumerate(family_d.family_d())}
    candidates = [] if halted else list(result_report["candidates"])
    twin_plan = [
        {
            "id": cand["id"],
            "registry_index": index_of[cand["id"]],
            "slot": slot,
            "twin_id": f"D_twin{slot}_{cand['id']}",
        }
        for slot, cand in enumerate(candidates[: family_d.N_RESERVE])
    ]
    twin_shortfall = [cand["id"] for cand in candidates[family_d.N_RESERVE :]]

    report = {
        "family": "D",
        "commit": commit,
        "dataset_hash": str(manifest["datasetHash"]),
        "source_sha256": cli.source_digest(),
        "receipts_sha256": _receipt_hashes(runs),
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
        "cost_drag": cost_drag,
        "cost_check": cost_check,
        "decision_reports": decision_reports,
        "f_parity": parity,
        "predictions": family_d.PREDICTIONS,
        "twin_plan": twin_plan,
        "twin_shortfall": twin_shortfall,
    }
    _write_json(out / "family_d_report.json", report)
    return report


def run_twins_d(
    ds: Path | str, runs_dir: Path | str, report_file: Path | str, out_dir: Path | str, commit: str
) -> dict[str, Any]:
    """Run the report's twins into out_dir/twins/runs and answer the refit question for each."""
    out = Path(out_dir)
    runs = Path(runs_dir)
    manifest, panel = _load(ds)
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
    index_of = {c["id"]: i for i, c in enumerate(family_d.family_d())}
    result_pass = report.get("pass2") or report.get("pass1")
    expected = [] if report.get("halted") else [c["id"] for c in result_pass["candidates"]][: family_d.N_RESERVE]
    plan = report["twin_plan"]
    if [e["id"] for e in plan] != expected:
        raise ValueError(f"the twin plan {[e['id'] for e in plan]} is not the report's candidates {expected}")
    for entry in plan:
        slot = entry["slot"]
        if entry["id"] not in index_of:
            raise ValueError(f"twin plan id {entry['id']!r} is not a declared configuration")
        if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < family_d.N_RESERVE:
            raise ValueError(f"twin plan slot {slot!r} is outside 0..{family_d.N_RESERVE - 1}")
        if entry["twin_id"] != f"D_twin{slot}_{entry['id']}":
            raise ValueError(
                f"twin plan twin_id {entry['twin_id']!r} does not match slot {slot} and id {entry['id']!r}"
            )
    questions: dict[str, Any] = {}
    for entry in plan:
        twin = family_d.family_d_twin(entry["id"], int(entry["slot"]))
        config_file = out / "twins" / "cfg" / f"{twin['id']}.json"
        _write_json(config_file, twin)
        calibration._run_or_reuse(config_file, twin, Path(ds), out / "twins" / "runs", sha, panel)
        config_daily = pd.read_parquet(runs / entry["id"] / "daily.parquet")
        twin_daily = pd.read_parquet(out / "twins" / "runs" / twin["id"] / "daily.parquet")
        question = family_d.refit_question(config_daily, twin_daily, index_of[entry["id"]])
        questions[entry["id"]] = {"twin_id": twin["id"], "slot": int(entry["slot"]), **question}
    result = {
        "family": "D",
        "commit": sha,
        "report_sha256": hashlib.sha256(report_bytes).hexdigest(),
        "refit_questions": questions,
    }
    _write_json(out / "refit_questions.json", result)
    return result
