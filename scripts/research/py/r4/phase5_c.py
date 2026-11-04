"""Phase 5 committed entry points for family C (A5.1, "Runs and seeds").

run_family_c runs the 9 declared volatility forecasts on the dataset, report_family_c writes the family's criteria,
verdicts, finalist and stay-out flag, and run_family_c_twin runs the finalist's no-refit twin and writes the
descriptive refit comparison. Each is reached through cli.main (family-c-run, family-c-report, family-c-twin). The
rules are those of .superpowers/sdd/round4/family-c-draft.md (draft 5) and the declaration in r4/family_c.py.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4 import bar, cli, family_c, method
from r4.pipeline import load_panel


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


def _check_forecasts(receipt: dict[str, Any], run_dir: Path, where: str) -> None:
    """The run's forecasts.parquet must exist and hash to the receipt's forecasts_sha256."""
    file = run_dir / "forecasts.parquet"
    if not file.is_file():
        raise ValueError(f"{where} has no forecasts.parquet beside it")
    if receipt.get("forecasts_sha256") != _file_sha256(file):
        raise ValueError(f"{where}: forecasts.parquet does not match the receipt's forecasts_sha256")


def _check_receipt(
    receipt: dict[str, Any], config: dict[str, Any], where: str, commit: str, digest: str, dataset_hash: str
) -> None:
    if receipt.get("kind") != config.get("kind"):
        raise ValueError(f"{where} is a {receipt.get('kind')!r} receipt, not a {config.get('kind')!r}")
    if receipt.get("config_hash") != cli.config_hash_of(config):
        raise ValueError(f"{where} holds a different configuration: refusing to overwrite it")
    if receipt.get("commit") != commit:
        raise ValueError(f"{where} was run at commit {receipt.get('commit')!r}, not {commit!r}: code freeze")
    if receipt.get("source_sha256") != digest:
        raise ValueError(f"{where} was run with another r4 source digest than the code in hand: code freeze")
    if receipt.get("dataset_hash") != dataset_hash:
        raise ValueError(
            f"{where} was run on dataset {receipt.get('dataset_hash')!r}, the dataset in hand is {dataset_hash!r}"
        )


def _run_or_reuse(
    config: dict[str, Any],
    runs: Path,
    commit: str,
    dataset_hash: str,
    panel: dict[str, dict[str, pd.DataFrame]],
    cache: dict[str, dict[str, dict[str, Any]]],
) -> dict[str, Any]:
    """Run a configuration into runs/<id>, or reuse a finished run with the same config hash, commit, source, data."""
    run_dir = runs / str(config["id"])
    receipt_file = run_dir / "receipt.json"
    digest = cli.source_digest()
    if receipt_file.exists():
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
        _check_receipt(receipt, config, str(receipt_file), commit, digest, dataset_hash)
        _check_forecasts(receipt, run_dir, str(receipt_file))
        return receipt  # type: ignore[no-any-return]
    started = time.monotonic()
    window = str(config["window"])
    end_ms = int(config["partition_end_ms"])
    key = f"{window}:{end_ms}"
    if key not in cache:
        cache[key] = family_c.prepare_window(panel, window, end_ms)
    forecasts, counts = family_c.compute_forecasts(panel, config, cache[key])
    run_dir.mkdir(parents=True, exist_ok=True)
    forecasts.to_parquet(run_dir / "forecasts.parquet", index=False)
    receipt = {
        "id": config["id"],
        "kind": config.get("kind", "trial"),
        "family": family_c.FAMILY,
        "config": config,
        "config_hash": cli.config_hash_of(config),
        "commit": commit,
        "source_sha256": cli.source_digest(),
        "dataset_hash": dataset_hash,
        **cli.reproduction_inputs(),
        "forecasts_sha256": _file_sha256(run_dir / "forecasts.parquet"),
        "n_forecast_rows": int((forecasts["f"].notna()).sum()),
        "n_rows": int(len(forecasts)),
        "dropped_windows": {
            "incomplete": counts["windows_incomplete"],
            "past_partition_end": counts["windows_past_partition_end"],
            "zero_volume": counts["zero_volume_windows"],
        },
        "zero_volume_by_coin": counts["zero_volume_by_coin"],
        "untrained_coin_folds": counts["untrained_coin_folds"],
        "untrained_by_coin": counts["untrained_by_coin"],
        "n_folds": counts["n_folds"],
        "runtime_s": round(time.monotonic() - started, 3),
    }
    _write_json(receipt_file, receipt)  # written last: a run without a receipt is unfinished
    return receipt


def run_family_c(ds: Path | str, out_dir: Path | str, commit: str) -> list[dict[str, Any]]:
    """Run the 9 declared configurations into out_dir/runs (resumable: finished runs are reused when they match)."""
    out = Path(out_dir)
    manifest, panel = _load(ds)
    sha = cli.resolve_commit(commit)
    dataset_hash = str(manifest["datasetHash"])
    print("dataset", dataset_hash, flush=True)
    cache: dict[str, dict[str, dict[str, Any]]] = {}
    receipts = []
    for config in family_c.family_c():
        receipts.append(_run_or_reuse(config, out / "runs", sha, dataset_hash, panel, cache))
        print(config["id"], "done", flush=True)
    return receipts


def check_complete(
    runs_dir: Path | str,
    *,
    commit: str | None = None,
    source_sha256: str | None = None,
    dataset_hash: str | None = None,
) -> None:
    """The runs directory holds exactly the 9 declared ids, each a trial receipt at its registry config hash."""
    runs = Path(runs_dir)
    declared = {c["id"]: c for c in family_c.family_c()}
    present = {p.name for p in runs.iterdir()}
    if present != set(declared):
        missing = sorted(set(declared) - present)
        extra = sorted(present - set(declared))
        raise ValueError(f"runs directory {runs} is not the declared family: missing {missing}, extra {extra}")
    for cid, config in declared.items():
        receipt_file = runs / cid / "receipt.json"
        if not receipt_file.is_file():
            raise ValueError(f"{cid} has no receipt.json")
        if not (runs / cid / "forecasts.parquet").is_file():
            raise ValueError(f"{cid} has no forecasts.parquet")
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
        if receipt.get("kind") != "trial":
            raise ValueError(f"{cid} is a {receipt.get('kind')!r} receipt, not a trial")
        if receipt.get("config_hash") != cli.config_hash_of(config):
            raise ValueError(f"{cid} was run with a configuration other than its registry entry")
        _check_forecasts(receipt, runs / cid, cid)
        for key, want in (("commit", commit), ("source_sha256", source_sha256), ("dataset_hash", dataset_hash)):
            if want is not None and receipt.get(key) != want:
                raise ValueError(f"{cid} has {key} {receipt.get(key)!r}, not {want!r}")


def _receipt_hashes(runs: Path) -> dict[str, str]:
    """sha256 of each declared run's receipt.json, which binds a report to the exact runs it was written from."""
    return {
        c["id"]: hashlib.sha256((runs / c["id"] / "receipt.json").read_bytes()).hexdigest() for c in family_c.family_c()
    }


def _evaluate(
    runs: Path,
    configs: list[dict[str, Any]],
    uni: tuple[str, ...],
    symbols_min: int | None,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]], dict[str, Any]]:
    """Per-coin criteria, verdicts and the finalist ranking from the runs (shared by the report and the twin check)."""
    per_config: dict[str, Any] = {}
    verdicts: dict[str, dict[str, Any]] = {}
    paired: dict[str, pd.DataFrame] = {}
    for config in configs:
        fc = pd.read_parquet(runs / config["id"] / "forecasts.parquet")
        wms = family_c.WINDOWS[str(config["window"])]
        coins = {str(sym): family_c.coin_criteria(g, wms) for sym, g in fc.groupby("coin", sort=True)}
        paired[config["id"]] = family_c.paired_rows(fc)
        verdict = family_c.config_verdict(coins, uni, symbols_min)
        verdicts[config["id"]] = verdict
        per_config[config["id"]] = {"window": config["window"], "model": config["model"], **verdict, "coins": coins}
    ranking = family_c.finalist_ranking(verdicts, [c["id"] for c in configs], paired)
    return per_config, verdicts, ranking


def report_family_c(
    ds: Path | str,
    runs_dir: Path | str,
    out_dir: Path | str,
    commit: str,
    *,
    universe: tuple[str, ...] | None = None,
    symbols_min: int | None = None,
) -> dict[str, Any]:
    """The family's report: per-coin criteria, verdicts, the finalist and its stay-out flag. It never changes a verdict.

    `universe` and `symbols_min` default to M's fixed 10 coins and 8; they exist so tests can use small panels.
    """
    runs = Path(runs_dir)
    out = Path(out_dir)
    manifest = bar.read_manifest(Path(ds))
    sha = cli.resolve_commit(commit)
    digest = cli.source_digest()
    dataset_hash = str(manifest["datasetHash"])
    check_complete(runs, commit=sha, source_sha256=digest, dataset_hash=dataset_hash)
    configs = family_c.family_c()
    uni = tuple(method.UNIVERSE if universe is None else universe)

    per_config, verdicts, ranking = _evaluate(runs, configs, uni, symbols_min)
    order = [c["id"] for c in configs]
    finalist = ranking["finalist"]
    finalist_block: dict[str, Any] | None = None
    stay_out: dict[str, Any] | None = None
    if finalist is not None:
        index = order.index(finalist)
        finalist_block = {
            "id": finalist,
            "registry_index": index,
            "support": ranking["support"],
            "support_days": ranking["support_days"],
            "scores": ranking["scores"],
        }
        fc = pd.read_parquet(runs / finalist / "forecasts.parquet")
        stay_out = family_c.stay_out_flag(fc, family_c.WINDOWS[configs[index]["window"]], index)

    report = {
        "family": "C",
        "commit": sha,
        "dataset_hash": dataset_hash,
        "source_sha256": digest,
        "receipts_sha256": _receipt_hashes(runs),
        "n_configurations": len(configs),
        "universe": list(uni),
        "symbols_min": int(method.BAR_FORECAST["symbols_min"] if symbols_min is None else symbols_min),
        "configurations": per_config,
        "passing": [cid for cid in order if verdicts[cid]["pass"]],
        "finalist": finalist_block,
        "stay_out": stay_out,
        "h_read_allowed": bool(stay_out is not None and stay_out["pass"]),
        "predictions": family_c.PREDICTIONS,
    }
    _write_json(out / "family_c_report.json", report)
    return report


def run_family_c_twin(
    ds: Path | str,
    runs_dir: Path | str,
    report_file: Path | str,
    out_dir: Path | str,
    commit: str,
    *,
    universe: tuple[str, ...] | None = None,
    symbols_min: int | None = None,
) -> dict[str, Any]:
    """Run the report finalist's no-refit twin into out_dir/twins/runs and write the descriptive refit comparison.

    The finalist is recomputed from the bound runs with the report's own criteria, and a report that names another
    finalist (or one when none passes, or none when one passes) is refused. `universe` and `symbols_min` default to M's.
    """
    out = Path(out_dir)
    runs = Path(runs_dir)
    manifest, panel = _load(ds)
    sha = cli.resolve_commit(commit)
    digest = cli.source_digest()
    dataset_hash = str(manifest["datasetHash"])
    check_complete(runs, commit=sha, source_sha256=digest, dataset_hash=dataset_hash)
    report_bytes = Path(report_file).read_bytes()
    report = json.loads(report_bytes.decode("utf-8"))
    if report.get("commit") != sha:
        raise ValueError(f"the report is at commit {report.get('commit')!r}, not {sha!r}")
    if report.get("dataset_hash") != dataset_hash:
        raise ValueError(f"the report is on dataset {report.get('dataset_hash')!r}, not {dataset_hash!r}")
    if report.get("source_sha256") != digest:
        raise ValueError(f"the report is at source digest {report.get('source_sha256')!r}, not {digest!r}")
    if report.get("receipts_sha256") != _receipt_hashes(runs):
        raise ValueError("the report's receipts_sha256 does not match the receipts in the runs directory")
    configs = family_c.family_c()
    uni = tuple(method.UNIVERSE if universe is None else universe)
    need = int(method.BAR_FORECAST["symbols_min"] if symbols_min is None else symbols_min)
    if report.get("universe") != list(uni):
        raise ValueError(f"the report's universe {report.get('universe')!r} differs from the one in hand {list(uni)!r}")
    if report.get("symbols_min") != need:
        raise ValueError(f"the report's symbols_min {report.get('symbols_min')!r} differs from {need!r} in hand")
    computed = _evaluate(runs, configs, uni, symbols_min)[2]["finalist"]
    named = (report.get("finalist") or {}).get("id")
    if named != computed:
        raise ValueError(f"the report names finalist {named!r} but the bound runs give {computed!r}")
    result: dict[str, Any] = {
        "family": "C",
        "commit": sha,
        "report_sha256": hashlib.sha256(report_bytes).hexdigest(),
        "finalist": None,
    }
    finalist = report.get("finalist")
    if finalist is None:
        result["status"] = "no finalist, no twin run"
        _write_json(out / "refit_comparison.json", result)
        return result
    order = [c["id"] for c in family_c.family_c()]
    if finalist.get("id") not in order or finalist.get("registry_index") != order.index(finalist["id"]):
        raise ValueError(f"the report's finalist {finalist!r} is not a declared configuration at its registry index")
    cid = str(finalist["id"])
    twin = family_c.family_c_twin(cid)
    receipt = _run_or_reuse(twin, out / "twins" / "runs", sha, dataset_hash, panel, {})
    config_rows = pd.read_parquet(runs / cid / "forecasts.parquet")
    twin_rows = pd.read_parquet(out / "twins" / "runs" / twin["id"] / "forecasts.parquet")
    result["finalist"] = cid
    result["twin_id"] = twin["id"]
    result["twin_untrained_coin_folds"] = receipt["untrained_coin_folds"]
    result["refit_comparison"] = family_c.refit_comparison(config_rows, twin_rows, int(finalist["registry_index"]))
    _write_json(out / "refit_comparison.json", result)
    return result
