"""Command-line interface and guards for horizon-e1 (rules 12 and 13)."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import scipy

from horizon.e1 import lock, report
from horizon.e1.data import Store
from horizon.e1.events import (
    build_fetch_plan,
    build_pairs,
    load_record,
    plan_bytes,
    sha256_file,
)

# The sha256 of the one frozen event record (the lock fixes it). Tests replace it to run on a synthetic record.
FROZEN_EVENTS_SHA256 = lock.EVENTS_SHA256


class GuardError(RuntimeError):
    """Raised when a pre-registration, git, or anchor guard fails."""


def _find_repo_root(start: Path) -> Path:
    """Find git repository root by ascending until .git is found."""
    for p in [start, *start.parents]:
        if (p / ".git").exists():
            return p
    if len(start.parents) >= 4:
        return start.parents[3]
    return start


def _default_runner(cmd: list[str], cwd: Path | str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False)


def git_state(
    runner: Callable[..., Any] | None = None,
    env: Mapping[str, str] | None = None,
    here: Path | None = None,
) -> dict[str, Any]:
    """Inspect git state or verify attested environment variables (rule 13)."""
    if env is None:
        env = os.environ
    if runner is None:
        runner = _default_runner
    if here is None:
        here = Path(__file__).resolve().parent

    is_git_repo = False
    git_head = ""
    is_clean = False

    try:
        res_head = runner(["git", "-C", str(here), "rev-parse", "HEAD"])
        rc_head = getattr(res_head, "returncode", -1)
        out_head = getattr(res_head, "stdout", "")
        if rc_head == 0 and out_head.strip():
            is_git_repo = True
            git_head = out_head.strip()

            repo_root = _find_repo_root(here)
            res_status = runner(
                ["git", "-C", str(repo_root), "status", "--porcelain", "--", "scripts/research/py/horizon/e1"]
            )
            rc_status = getattr(res_status, "returncode", -1)
            out_status = getattr(res_status, "stdout", "")
            if rc_status == 0:
                is_clean = len(out_status.strip()) == 0
            else:
                is_clean = False
    except (FileNotFoundError, OSError, Exception):
        is_git_repo = False

    if is_git_repo:
        if not is_clean:
            raise GuardError("git working tree under scripts/research/py/horizon/e1 is not clean")
        return {
            "attested": False,
            "clean": True,
            "head": git_head,
        }

    head = env.get("HORIZON_GIT_HEAD")
    if not head or not head.strip():
        raise GuardError("git unavailable/not a repository and HORIZON_GIT_HEAD is missing or empty")

    clean_val = env.get("HORIZON_TREE_CLEAN")
    if clean_val != "1":
        raise GuardError(f"git unavailable/not a repository and HORIZON_TREE_CLEAN is not '1' (got {clean_val!r})")

    return {
        "attested": True,
        "clean": True,
        "head": head.strip(),
    }


def get_constants() -> dict[str, Any]:
    """Upper-case numeric or tuple constants of trading and statistics rules from lock.py."""
    return {
        "BOOT_RESAMPLES": lock.BOOT_RESAMPLES,
        "BOOT_SEED": lock.BOOT_SEED,
        "CLUSTER_GAP_HOURS": lock.CLUSTER_GAP_HOURS,
        "DELAY_PROFILE_MINUTES": list(lock.DELAY_PROFILE_MINUTES),
        "ENTRY_DELAY_MINUTES": lock.ENTRY_DELAY_MINUTES,
        "LIVE_DELAY_MINUTES": lock.LIVE_DELAY_MINUTES,
        "MAX_EXCLUDED_SHARE": lock.MAX_EXCLUDED_SHARE,
        "MIN_CLUSTERS": lock.MIN_CLUSTERS,
        "PASS_LOO_MIN_MEAN": lock.PASS_LOO_MIN_MEAN,
        "PASS_MIN_MEAN": lock.PASS_MIN_MEAN,
        "SLIP_BTC_BPS": lock.SLIP_BTC_BPS,
        "SLIP_TOKEN_FLOOR_BPS": lock.SLIP_TOKEN_FLOOR_BPS,
        "SLIP_TOKEN_RANGE_SHARE": lock.SLIP_TOKEN_RANGE_SHARE,
        "STALE_EXIT_MINUTES": lock.STALE_EXIT_MINUTES,
        "STOP_ADVERSE": lock.STOP_ADVERSE,
        "TAKER_FEE_BPS": lock.TAKER_FEE_BPS,
        "TRIAL_ALPHA": lock.TRIAL_ALPHA,
    }


def fetch_plan(
    events_path: Path | str,
    out_path: Path | str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build and write fetch plan from event record (subcommand fetch-plan)."""
    record = load_record(events_path)
    pairs = build_pairs(record)
    plan = build_fetch_plan(record, pairs)
    raw_bytes = plan_bytes(plan)

    out_p = Path(out_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    out_p.write_bytes(raw_bytes)

    sha = hashlib.sha256(raw_bytes).hexdigest()
    summary = {
        "funding": len(plan.get("funding", [])),
        "klines": len(plan.get("klines", [])),
        "plan_sha256": sha,
    }
    return plan, summary


def register_check(
    events_path: Path | str,
    plan_path: Path | str,
    data_dir: Path | str,
    anchor_path: Path | str | None = None,
) -> tuple[dict[str, Any], int]:
    """Compute registration hashes and compare against anchor if provided (subcommand register-check)."""
    record = load_record(events_path)
    pairs = build_pairs(record)
    recomputed_plan = build_fetch_plan(record, pairs)
    recomputed_bytes = plan_bytes(recomputed_plan)

    plan_p = Path(plan_path)
    if not plan_p.is_file():
        raise FileNotFoundError(f"plan file not found: {plan_p}")
    plan_bytes_on_disk = plan_p.read_bytes()
    plan_matches_record = plan_bytes_on_disk == recomputed_bytes
    plan_hash = hashlib.sha256(plan_bytes_on_disk).hexdigest()

    manifest_p = Path(data_dir) / "manifest.jsonl"
    if not manifest_p.is_file():
        raise FileNotFoundError(f"manifest file not found: {manifest_p}")
    manifest_hash = sha256_file(manifest_p)
    events_hash = sha256_file(events_path)

    result: dict[str, Any] = {
        "events_sha256": events_hash,
        "ledger_id": lock.LEDGER_ID,
        "lock_digest": lock.lock_digest(),
        "manifest_sha256": manifest_hash,
        "plan_matches_record": plan_matches_record,
        "plan_sha256": plan_hash,
    }

    if anchor_path is None:
        return result, 0

    anchor_p = Path(anchor_path)
    if not anchor_p.is_file():
        raise FileNotFoundError(f"anchor file not found: {anchor_p}")

    anchor_data = json.loads(anchor_p.read_text(encoding="utf-8"))
    if not isinstance(anchor_data, dict):
        raise ValueError("anchor JSON must be an object")

    differences: set[str] = set()
    anchor_keys = set(anchor_data.keys()) - {"owner_signature", "registered_utc"}

    for k in anchor_keys:
        if k not in result or anchor_data[k] != result[k]:
            differences.add(k)

    for k in ("ledger_id", "lock_digest", "events_sha256", "plan_sha256", "manifest_sha256"):
        if k not in anchor_data:
            differences.add(k)

    if not plan_matches_record:
        differences.add("plan_matches_record")

    diff_list = sorted(differences)
    matches = len(diff_list) == 0

    result["anchor_matches"] = matches
    result["differences"] = diff_list
    exit_code = 0 if matches else 1
    return result, exit_code


def data_check(plan_path: Path | str, data_dir: Path | str, *, store_cls: type = Store) -> tuple[dict[str, Any], int]:
    """Parse every file of the plan through the guarded reader and report structure only (subcommand data-check).

    It counts files and rows and lists problems. It computes no return, no statistic and reads no price into any
    result, so it is safe to run before registration.
    """
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    store = store_cls(Path(data_dir))
    kline_ok = kline_missing = funding_ok = funding_missing = rows = 0
    problems: list[str] = list(store.plan_problems(plan))
    for job in plan.get("klines", []):
        try:
            bars = store.klines(job["symbol"], job["day"])
        except Exception as exc:
            problems.append(f"klines {job['symbol']} {job['day']}: {exc}")
            continue
        if bars is None:
            kline_missing += 1
        else:
            kline_ok += 1
            rows += len(bars)
    for job in plan.get("funding", []):
        try:
            funding = store.funding_month(job["symbol"], job["month"])
        except Exception as exc:
            problems.append(f"funding {job['symbol']} {job['month']}: {exc}")
            continue
        if funding is None:
            funding_missing += 1
        else:
            funding_ok += 1
            rows += len(funding)
    summary = {
        "funding_missing": funding_missing,
        "funding_ok": funding_ok,
        "klines_missing": kline_missing,
        "klines_ok": kline_ok,
        "problems": problems,
        "rows": rows,
    }
    return summary, (0 if not problems else 1)


def _check_synthetic_allowed(events_path: Path | str, manifest_path: Path, events_hash: str) -> None:
    """The SYNTHETIC marker alone never disables a guard (rule 13 of the Lighter lock, kept here).

    It is refused for the frozen record, and it also needs the record to say meta.synthetic true and every line of the
    manifest to carry synthetic true. The real downloader writes neither flag.
    """
    if events_hash == FROZEN_EVENTS_SHA256:
        raise GuardError("the SYNTHETIC marker is refused for the frozen event record")
    try:
        meta = json.loads(Path(events_path).read_text(encoding="utf-8")).get("meta", {})
    except Exception as exc:
        raise GuardError(f"synthetic mode cannot read the event record: {exc}") from exc
    if not isinstance(meta, dict) or meta.get("synthetic") is not True:
        raise GuardError("synthetic mode needs meta.synthetic true in the event record")
    if not manifest_path.is_file():
        raise GuardError(f"manifest file missing: {manifest_path}")
    lines = [ln for ln in manifest_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    try:
        entries = [json.loads(ln) for ln in lines]
    except ValueError as exc:
        raise GuardError(f"synthetic mode cannot parse the manifest: {exc}") from exc
    if not entries or any(not isinstance(e, dict) or e.get("synthetic") is not True for e in entries):
        raise GuardError("synthetic mode needs synthetic true on every manifest line")


def _raise_on_plan_problems(store: Store, plan_path: Path) -> None:
    """A planned file that is missing, repaired or not ok stops the run (rule 2): it is never an exclusion."""
    problems = store.plan_problems(json.loads(plan_path.read_text(encoding="utf-8")))
    if problems:
        shown = "; ".join(problems[:5])
        extra = f" (and {len(problems) - 5} more)" if len(problems) > 5 else ""
        raise GuardError(f"planned files are not all downloaded cleanly: {shown}{extra}")


def smoke(
    events_path: Path | str, plan_path: Path | str, data_dir: Path | str, *, store_cls: type = Store
) -> dict[str, Any]:
    """Run the whole pipeline in memory on the real files and return only return-free counts (subcommand smoke).

    It exists to find a crash before registration. It needs the frozen record and a clean plan, prints counts of
    pairs by outcome and exclusion reason and the number of clusters, and never a return, a bound or a pass flag.
    """
    if sha256_file(events_path) != FROZEN_EVENTS_SHA256:
        raise GuardError("smoke runs on the frozen event record only")
    record = load_record(events_path)
    pairs = build_pairs(record)
    plan_p = Path(plan_path)
    if plan_p.read_bytes() != plan_bytes(build_fetch_plan(record, pairs)):
        raise GuardError("plan file bytes differ from recomputed plan from record")
    store = store_cls(Path(data_dir))
    _raise_on_plan_problems(store, plan_p)
    result = report.run_trials(record, pairs, store)
    json.dumps(result)  # the full result must serialise, but it is discarded here
    counts: dict[str, Any] = {}
    for tid in lock.TRIAL_IDS:
        trial = result["trials"][tid]["counts"]
        counts[tid] = {
            "announcements": trial["announcements"],
            "tokens": trial["tokens"],
            "tokens_with_symbol": trial["tokens_with_symbol"],
            "eligible_by_record": trial["eligible_by_record"],
            "priced_ok": trial["ok"],
            "exclusions": trial["exclusions"],
            "units": trial["units"],
            "clusters": trial["clusters"],
        }
    return counts


def run_pipeline(
    events_path: Path | str,
    plan_path: Path | str,
    data_dir: Path | str,
    anchor_path: Path | str,
    out_path: Path | str,
    *,
    runner: Callable[..., Any] | None = None,
    store_cls: type = Store,
) -> tuple[dict[str, Any], list[str]]:
    """Execute guarded run on events, plan, and data files (subcommand run)."""
    out_p = Path(out_path)
    if out_p.exists():
        raise GuardError(f"output file already exists: {out_p}")

    data_dir_p = Path(data_dir)
    synthetic_marker = data_dir_p / "SYNTHETIC"
    is_synthetic = synthetic_marker.exists()

    # The marker alone never disables a guard, and a real run needs the frozen record.
    events_hash = sha256_file(events_path)
    if is_synthetic:
        _check_synthetic_allowed(events_path, data_dir_p / "manifest.jsonl", events_hash)
    elif events_hash != FROZEN_EVENTS_SHA256:
        raise GuardError("the event record differs from the frozen record (lock.EVENTS_SHA256)")

    git_info: dict[str, Any]
    if is_synthetic:
        git_info = {"attested": False, "clean": True, "head": "synthetic"}
    else:
        git_info = git_state(runner=runner)
        if not git_info.get("clean", False):
            raise GuardError("git working tree under scripts/research/py/horizon/e1 is not clean")

        anchor_p = Path(anchor_path)
        if not anchor_p.is_file():
            raise GuardError(f"anchor file missing: {anchor_p}")

        try:
            anchor_data = json.loads(anchor_p.read_text(encoding="utf-8"))
        except Exception as exc:
            raise GuardError(f"anchor file invalid JSON: {exc}") from exc

        if not isinstance(anchor_data, dict):
            raise GuardError("anchor JSON must be an object")

        for req_k in (
            "ledger_id",
            "lock_digest",
            "events_sha256",
            "plan_sha256",
            "manifest_sha256",
            "owner_signature",
        ):
            if req_k not in anchor_data:
                raise GuardError(f"anchor missing key: {req_k}")

        manifest_p = data_dir_p / "manifest.jsonl"
        if not manifest_p.is_file():
            raise GuardError(f"manifest file missing: {manifest_p}")

        expected_anchor = {
            "ledger_id": lock.LEDGER_ID,
            "lock_digest": lock.lock_digest(),
            "events_sha256": sha256_file(events_path),
            "plan_sha256": sha256_file(plan_path),
            "manifest_sha256": sha256_file(manifest_p),
        }

        for k, expected_v in expected_anchor.items():
            actual_v = anchor_data.get(k)
            if actual_v != expected_v:
                raise GuardError(f"anchor key {k} mismatch: expected {expected_v}, got {actual_v}")

        sig = anchor_data.get("owner_signature")
        if not isinstance(sig, dict):
            raise GuardError("anchor key owner_signature must be a dict")
        if "date" not in sig:
            raise GuardError("anchor owner_signature missing key: date")
        if "lock_digest" not in sig:
            raise GuardError("anchor owner_signature missing key: lock_digest")
        if sig["lock_digest"] != lock.lock_digest():
            raise GuardError(
                f"anchor owner_signature lock_digest mismatch: expected {lock.lock_digest()}, got {sig['lock_digest']}"
            )

    try:
        record = load_record(events_path)
    except Exception as exc:
        raise GuardError(f"failed to load event record: {exc}") from exc

    pairs = build_pairs(record)
    recomputed_plan = build_fetch_plan(record, pairs)
    recomputed_bytes = plan_bytes(recomputed_plan)

    plan_p = Path(plan_path)
    if not plan_p.is_file():
        raise GuardError(f"plan file missing: {plan_p}")
    if plan_p.read_bytes() != recomputed_bytes:
        raise GuardError("plan file bytes differ from recomputed plan from record")

    manifest_file = data_dir_p / "manifest.jsonl"
    manifest_hash = sha256_file(manifest_file) if manifest_file.is_file() else ""

    store = store_cls(data_dir_p)
    _raise_on_plan_problems(store, plan_p)
    trials_report = report.run_trials(record, pairs, store)

    result_obj: dict[str, Any] = {
        "constants": get_constants(),
        "events_sha256": sha256_file(events_path),
        "files_read": store.files_read(),
        "freeze_ms": lock.FREEZE_MS,
        "hard_last_date": lock.HARD_LAST_DATE.isoformat(),
        "ledger_id": lock.LEDGER_ID,
        "lock": {
            "attested_by_environment": git_info["attested"],
            "digest": lock.lock_digest(),
            "git_head": git_info["head"],
        },
        "manifest_sha256": manifest_hash,
        "plan_sha256": sha256_file(plan_path),
        "prediction": lock.PREDICTION,
        "report": trials_report,
        "synthetic": is_synthetic,
        "versions": {
            "numpy": getattr(np, "__version__", "unknown"),
            "pandas": getattr(pd, "__version__", "unknown"),
            "python": platform.python_version(),
            "scipy": getattr(scipy, "__version__", "unknown"),
        },
    }

    out_p.parent.mkdir(parents=True, exist_ok=True)
    with open(out_p, "w", encoding="utf-8") as f:
        json.dump(result_obj, f, sort_keys=True, indent=1)
        f.write("\n")

    summary_lines: list[str] = []
    trials_dict = trials_report.get("trials", {})
    for tid in lock.TRIAL_IDS:
        trial = trials_dict.get(tid, {})
        j = trial.get("judgement", {})
        n_clusters = j.get("n_clusters", 0)
        mean_val = j.get("mean")
        bound_val = j.get("bound")
        passed = j.get("passed", False)
        mean_str = "None" if mean_val is None else f"{mean_val:+.4f}"
        bound_str = "None" if bound_val is None else f"{bound_val:+.4f}"
        summary_lines.append(f"{tid} clusters={n_clusters} mean={mean_str} bound={bound_str} passed={passed}")

    return result_obj, summary_lines


def build_parser() -> argparse.ArgumentParser:
    """Build command-line parser with subcommands fetch-plan, register-check, and run."""
    parser = argparse.ArgumentParser(
        prog="python -m horizon.e1.run",
        description="Horizon E1 command-line interface.",
    )
    subparsers = parser.add_subparsers(dest="cmd")

    p_fetch = subparsers.add_parser("fetch-plan", help="Build and write fetch plan.")
    p_fetch.add_argument("--events", required=True, type=Path, help="Path to event record JSON.")
    p_fetch.add_argument("--out", required=True, type=Path, help="Path to output fetch plan JSON.")

    p_check = subparsers.add_parser("register-check", help="Verify registration hashes against anchor.")
    p_check.add_argument("--events", required=True, type=Path, help="Path to event record JSON.")
    p_check.add_argument("--plan", required=True, type=Path, help="Path to fetch plan JSON.")
    p_check.add_argument("--data-dir", required=True, type=Path, help="Path to data directory.")
    p_check.add_argument("--anchor", required=False, default=None, type=Path, help="Path to registration anchor JSON.")

    p_data = subparsers.add_parser("data-check", help="Parse every planned file and report structure only.")
    p_data.add_argument("--plan", required=True, type=Path, help="Path to fetch plan JSON.")
    p_data.add_argument("--data-dir", required=True, type=Path, help="Path to data directory.")

    p_smoke = subparsers.add_parser("smoke", help="Run in memory and print return-free counts only.")
    p_smoke.add_argument("--events", required=True, type=Path, help="Path to event record JSON.")
    p_smoke.add_argument("--plan", required=True, type=Path, help="Path to fetch plan JSON.")
    p_smoke.add_argument("--data-dir", required=True, type=Path, help="Path to data directory.")

    p_run = subparsers.add_parser("run", help="Run trials with guards.")
    p_run.add_argument("--events", required=True, type=Path, help="Path to event record JSON.")
    p_run.add_argument("--plan", required=True, type=Path, help="Path to fetch plan JSON.")
    p_run.add_argument("--data-dir", required=True, type=Path, help="Path to data directory.")
    p_run.add_argument("--anchor", required=True, type=Path, help="Path to registration anchor JSON.")
    p_run.add_argument("--out", required=True, type=Path, help="Path to output result JSON.")

    return parser


def main(argv: list[str] | None = None, *, runner: Callable[..., Any] | None = None) -> int:
    """Command-line entrypoint for horizon-e1 run CLI."""
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        if exc.code == 0:
            raise
        return 3
    except Exception as exc:
        sys.stderr.write(f"argument error: {exc}\n")
        return 3

    if args.cmd is None:
        sys.stderr.write("no sub-command specified\n")
        return 3

    try:
        if args.cmd == "fetch-plan":
            _, summary = fetch_plan(args.events, args.out)
            print(json.dumps(summary, sort_keys=True))
            return 0

        if args.cmd == "register-check":
            report_dict, code = register_check(args.events, args.plan, args.data_dir, args.anchor)
            print(json.dumps(report_dict, sort_keys=True, indent=1))
            return code

        if args.cmd == "data-check":
            check_dict, code = data_check(args.plan, args.data_dir)
            print(json.dumps(check_dict, sort_keys=True, indent=1))
            return code

        if args.cmd == "smoke":
            print(json.dumps(smoke(args.events, args.plan, args.data_dir), sort_keys=True, indent=1))
            return 0

        if args.cmd == "run":
            _, summary_lines = run_pipeline(
                args.events,
                args.plan,
                args.data_dir,
                args.anchor,
                args.out,
                runner=runner,
            )
            for line in summary_lines:
                print(line)
            return 0

        sys.stderr.write(f"unknown command: {args.cmd}\n")
        return 3
    except GuardError as exc:
        sys.stderr.write(f"guard failure: {exc}\n")
        return 2
    except Exception as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
