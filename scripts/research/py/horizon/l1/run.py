"""Command-line interface and guards for horizon-l1 (specification: lock.py)."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import subprocess
import sys
from collections import defaultdict
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import scipy

from horizon.l1 import lock, panel, report
from horizon.l1.data import Store, funding_files_digest, sha256_file
from horizon.l1.events import (
    eligible,
    find_bursts,
    find_candidates,
    select_events,
    span_end_dropped,
    x_series,
)


class GuardError(RuntimeError):
    """Raised when a pre-registration, git, or anchor guard fails."""


def _find_repo_root(start: Path) -> Path | None:
    """Find git repository root by ascending until .git (file or directory) is found, or None."""
    for p in [start, *start.parents]:
        if (p / ".git").exists():
            return p
    return None


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

    repo_root = _find_repo_root(here)
    if repo_root is not None:
        try:
            res_head = runner(["git", "-C", str(here), "rev-parse", "HEAD"])
            rc_head = getattr(res_head, "returncode", -1)
            out_head = getattr(res_head, "stdout", "")
            if rc_head != 0 or not out_head.strip():
                raise GuardError(f"git rev-parse HEAD failed with exit code {rc_head}")
            git_head = out_head.strip()

            res_status = runner(
                ["git", "-C", str(repo_root), "status", "--porcelain", "--", "scripts/research/py/horizon/l1"]
            )
            rc_status = getattr(res_status, "returncode", -1)
            out_status = getattr(res_status, "stdout", "")
            if rc_status != 0:
                raise GuardError(f"git status failed with exit code {rc_status}")
            if len(out_status.strip()) != 0:
                raise GuardError("git working tree under scripts/research/py/horizon/l1 is not clean")

            return {
                "attested": False,
                "clean": True,
                "head": git_head,
            }
        except GuardError:
            raise
        except Exception as exc:
            raise GuardError(f"git command execution failed: {exc}") from exc

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
    """Numeric and tuple constants of lock.py trading and statistics rules."""
    return {
        "BOOT_RESAMPLES": lock.BOOT_RESAMPLES,
        "BOOT_SEED": lock.BOOT_SEED,
        "BURST_GAP_MS": lock.BURST_GAP_MS,
        "BURST_MIN_ROWS": lock.BURST_MIN_ROWS,
        "BURST_MIN_USD": lock.BURST_MIN_USD,
        "CLAIM_ALPHA": lock.CLAIM_ALPHA,
        "CONTROLS_MIN": lock.CONTROLS_MIN,
        "CONTROLS_PER_EVENT": lock.CONTROLS_PER_EVENT,
        "ENTRY_OFFSET_MIN": lock.ENTRY_OFFSET_MIN,
        "ENTRY_PROFILE_MIN": list(lock.ENTRY_PROFILE_MIN),
        "EXIT_OFFSETS_MIN": list(lock.EXIT_OFFSETS_MIN),
        "EXIT_SEARCH_MIN": lock.EXIT_SEARCH_MIN,
        "FILL_DELAY_MS": lock.FILL_DELAY_MS,
        "MAX_EXCLUDED_SHARE": lock.MAX_EXCLUDED_SHARE,
        "MIN_CLUSTERS": lock.MIN_CLUSTERS,
        "PASS_MIN_BOUND": lock.PASS_MIN_BOUND,
        "PASS_MIN_MEAN": lock.PASS_MIN_MEAN,
        "RETRIGGER_MIN": lock.RETRIGGER_MIN,
        "SP_MIN_PAIRS": lock.SP_MIN_PAIRS,
        "TRIAL_ALPHA": lock.TRIAL_ALPHA,
    }


def _fold_trades_path() -> Path:
    """Find path to lighter/fold_trades.py."""
    import lighter.fold_trades

    path_str = getattr(lighter.fold_trades, "__file__", None)
    if not path_str:
        raise FileNotFoundError("cannot find __file__ for lighter.fold_trades")
    p = Path(path_str).resolve()
    if p.suffix == ".pyc":
        p = p.with_suffix(".py")
    return p


def _lighter_lock_path() -> Path:
    """Find path to lighter/lock.py."""
    import lighter.lock

    path_str = getattr(lighter.lock, "__file__", None)
    if not path_str:
        raise FileNotFoundError("cannot find __file__ for lighter.lock")
    p = Path(path_str).resolve()
    if p.suffix == ".pyc":
        p = p.with_suffix(".py")
    return p


def panel_cmd(fold_dir: Path | str, out_dir: Path | str) -> tuple[dict[str, Any], int]:
    """Execute panel subcommand: build per-market panels and check scale jumps."""
    manifest = panel.build_panel(fold_dir, out_dir)
    markets = manifest.get("markets", {})
    days = manifest.get("days", 0)
    scale_jumps = manifest.get("scale_jumps", [])
    total_rows = sum(m.get("rows", 0) for m in markets.values())

    summary = {
        "days": days,
        "markets": len(markets),
        "rows": total_rows,
        "scale_jumps": scale_jumps,
    }
    code = 0 if not scale_jumps else 1
    return summary, code


def event_count_cmd(
    fold_dir: Path | str,
    panel_dir: Path | str,
    liq_dir: Path | str,
    funding_dir: Path | str,
    *,
    store_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Execute event-count subcommand: count burst candidates, events, and eligibility."""
    if store_factory is None:
        store_factory = Store

    store = store_factory(fold_dir=fold_dir, panel_dir=panel_dir, liq_dir=liq_dir, funding_dir=funding_dir)

    markets_res: dict[str, Any] = {}
    total_counts: dict[str, Any] = {
        side: {
            "bursts": 0,
            "by_month": defaultdict(int),
            "candidates": 0,
            "distinct_days": 0,
            "eligible": 0,
            "events": 0,
            "ineligible_by_reason": {"activity": 0, "no_spread_proxy": 0},
            "span_end": 0,
            "traded_events": 0,
        }
        for side in lock.SIDES
    }
    total_days: dict[str, set[str]] = {side: set() for side in lock.SIDES}

    for m_id in store.market_ids():
        md = store.market(m_id)
        xs, xs_valid = x_series(md)

        mkt_entry: dict[str, Any] = {
            "market_id": m_id,
            "symbol": md.symbol,
        }

        for side in lock.SIDES:
            bursts = find_bursts(md, side)
            n_bursts = len(bursts)
            candidates = find_candidates(md, side)
            n_candidates = len(candidates)
            evs = select_events(candidates)
            n_events = len(evs)

            n_traded = 0
            n_span_end = 0
            n_eligible = 0
            inelig_reasons: dict[str, int] = {"activity": 0, "no_spread_proxy": 0}
            distinct_days_set: set[str] = set()
            by_month: dict[str, int] = defaultdict(int)

            for e in evs:
                e_ms = md.ms_of(e.e_index)
                if e_ms < lock.EVENTS_FROM_MS:
                    continue
                n_traded += 1

                d_idx = e.d_index
                if span_end_dropped(d_idx, len(md.present)):
                    n_span_end += 1
                    continue

                is_elig, reason = eligible(md, xs_valid, xs, d_idx)
                if not is_elig:
                    if reason in inelig_reasons:
                        inelig_reasons[reason] += 1
                    else:
                        inelig_reasons[reason] = inelig_reasons.get(reason, 0) + 1
                    continue

                n_eligible += 1
                d_ms = md.ms_of(d_idx)
                day_str = dt.datetime.fromtimestamp(d_ms / 1000, tz=dt.UTC).strftime("%Y-%m-%d")
                month_str = dt.datetime.fromtimestamp(d_ms / 1000, tz=dt.UTC).strftime("%Y-%m")

                distinct_days_set.add(day_str)
                total_days[side].add(day_str)
                by_month[month_str] += 1
                total_counts[side]["by_month"][month_str] += 1

            total_counts[side]["bursts"] += n_bursts
            total_counts[side]["candidates"] += n_candidates
            total_counts[side]["events"] += n_events
            total_counts[side]["traded_events"] += n_traded
            total_counts[side]["span_end"] += n_span_end
            total_counts[side]["eligible"] += n_eligible
            for rk, rv in inelig_reasons.items():
                total_counts[side]["ineligible_by_reason"][rk] = (
                    total_counts[side]["ineligible_by_reason"].get(rk, 0) + rv
                )

            side_summary = {
                "bursts": n_bursts,
                "by_month": dict(sorted(by_month.items())),
                "candidates": n_candidates,
                "distinct_days": len(distinct_days_set),
                "eligible": n_eligible,
                "events": n_events,
                "ineligible_by_reason": inelig_reasons,
                "span_end": n_span_end,
                "traded_events": n_traded,
            }
            mkt_entry[side] = side_summary

        markets_res[str(m_id)] = mkt_entry

        # Release the market's dense arrays before the next one is read (as report.run_all does)
        del md, xs, xs_valid
        if hasattr(store, "_market_cache") and isinstance(store._market_cache, dict):
            store._market_cache.clear()

    total_out: dict[str, Any] = {}
    for side in lock.SIDES:
        tc = total_counts[side]
        total_out[side] = {
            "bursts": tc["bursts"],
            "by_month": dict(sorted(tc["by_month"].items())),
            "candidates": tc["candidates"],
            "distinct_days": len(total_days[side]),
            "eligible": tc["eligible"],
            "events": tc["events"],
            "ineligible_by_reason": tc["ineligible_by_reason"],
            "span_end": tc["span_end"],
            "traded_events": tc["traded_events"],
        }

    return {
        "markets": markets_res,
        "total": total_out,
    }


def register_check(
    fold_dir: Path | str,
    panel_dir: Path | str,
    liq_dir: Path | str,
    funding_dir: Path | str,
    anchor_path: Path | str | None = None,
) -> tuple[dict[str, Any], int]:
    """Verify registration hashes and compare against anchor if provided."""
    fold_p = Path(fold_dir)
    panel_p = Path(panel_dir)
    liq_p = Path(liq_dir)
    funding_p = Path(funding_dir)

    fold_manifest_p = fold_p / "manifest.jsonl"
    if not fold_manifest_p.is_file():
        raise FileNotFoundError(f"fold manifest file not found: {fold_manifest_p}")

    liq_manifest_p = liq_p / "manifest.jsonl"
    if not liq_manifest_p.is_file():
        raise FileNotFoundError(f"liquidation manifest file not found: {liq_manifest_p}")

    markets_p = fold_p / "markets.json"
    if not markets_p.is_file():
        raise FileNotFoundError(f"markets file not found: {markets_p}")

    funding_manifest_p = funding_p / "manifest.jsonl"
    if not funding_manifest_p.is_file():
        raise FileNotFoundError(f"funding manifest file not found: {funding_manifest_p}")

    panel_manifest_p = panel_p / "panel_manifest.json"
    if not panel_manifest_p.is_file():
        raise FileNotFoundError(f"panel manifest file not found: {panel_manifest_p}")

    fold_trades_p = _fold_trades_path()
    if not fold_trades_p.is_file():
        raise FileNotFoundError(f"lighter/fold_trades.py not found: {fold_trades_p}")

    lighter_lock_p = _lighter_lock_path()
    if not lighter_lock_p.is_file():
        raise FileNotFoundError(f"lighter/lock.py not found: {lighter_lock_p}")

    result: dict[str, Any] = {
        "fold_manifest_sha256": sha256_file(fold_manifest_p),
        "fold_trades_sha256": sha256_file(fold_trades_p),
        "funding_files_sha256": funding_files_digest(funding_p),
        "funding_manifest_sha256": sha256_file(funding_manifest_p),
        "ledger_id": lock.LEDGER_ID,
        "lighter_lock_sha256": sha256_file(lighter_lock_p),
        "liq_manifest_sha256": sha256_file(liq_manifest_p),
        "lock_digest": lock.lock_digest(),
        "markets_sha256": sha256_file(markets_p),
        "panel_manifest_sha256": sha256_file(panel_manifest_p),
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

    for k in result:
        if k not in anchor_data:
            differences.add(k)

    diff_list = sorted(differences)
    matches = len(diff_list) == 0

    result["anchor_matches"] = matches
    result["differences"] = diff_list
    exit_code = 0 if matches else 1
    return result, exit_code


def run_pipeline(
    fold_dir: Path | str,
    panel_dir: Path | str,
    liq_dir: Path | str,
    funding_dir: Path | str,
    anchor_path: Path | str,
    out_path: Path | str,
    *,
    runner: Callable[..., Any] | None = None,
    store_factory: Callable[..., Any] | None = None,
    here: Path | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Execute guarded run on fold, panel, liquidation, and funding data."""
    # (a) Refuse an existing --out
    out_p = Path(out_path)
    if out_p.exists():
        raise GuardError(f"output file already exists: {out_p}")

    # (b) Git guard for scripts/research/py/horizon/l1
    git_info = git_state(runner=runner, here=here)
    if not git_info.get("clean", False):
        raise GuardError("git working tree under scripts/research/py/horizon/l1 is not clean")

    # (c) Anchor file check
    anchor_p = Path(anchor_path)
    if not anchor_p.is_file():
        raise GuardError(f"anchor file missing: {anchor_p}")

    try:
        anchor_data = json.loads(anchor_p.read_text(encoding="utf-8"))
    except Exception as exc:
        raise GuardError(f"anchor file invalid JSON: {exc}") from exc

    if not isinstance(anchor_data, dict):
        raise GuardError("anchor JSON must be an object")

    required_keys = (
        "fold_manifest_sha256",
        "fold_trades_sha256",
        "funding_files_sha256",
        "funding_manifest_sha256",
        "ledger_id",
        "lighter_lock_sha256",
        "liq_manifest_sha256",
        "lock_digest",
        "markets_sha256",
        "owner_signature",
        "panel_manifest_sha256",
    )
    for req_k in required_keys:
        if req_k not in anchor_data:
            raise GuardError(f"anchor missing key: {req_k}")

    fold_p = Path(fold_dir)
    panel_p = Path(panel_dir)
    liq_p = Path(liq_dir)
    funding_p = Path(funding_dir)

    fold_manifest_p = fold_p / "manifest.jsonl"
    if not fold_manifest_p.is_file():
        raise GuardError(f"fold manifest file missing: {fold_manifest_p}")

    liq_manifest_p = liq_p / "manifest.jsonl"
    if not liq_manifest_p.is_file():
        raise GuardError(f"liquidation manifest file missing: {liq_manifest_p}")

    markets_p = fold_p / "markets.json"
    if not markets_p.is_file():
        raise GuardError(f"markets file missing: {markets_p}")

    funding_manifest_p = funding_p / "manifest.jsonl"
    if not funding_manifest_p.is_file():
        raise GuardError(f"funding manifest file missing: {funding_manifest_p}")

    panel_manifest_p = panel_p / "panel_manifest.json"
    if not panel_manifest_p.is_file():
        raise GuardError(f"panel manifest file missing: {panel_manifest_p}")

    fold_trades_p = _fold_trades_path()
    if not fold_trades_p.is_file():
        raise GuardError(f"lighter/fold_trades.py missing: {fold_trades_p}")

    lighter_lock_p = _lighter_lock_path()
    if not lighter_lock_p.is_file():
        raise GuardError(f"lighter/lock.py missing: {lighter_lock_p}")

    expected_hashes = {
        "fold_manifest_sha256": sha256_file(fold_manifest_p),
        "fold_trades_sha256": sha256_file(fold_trades_p),
        "funding_files_sha256": funding_files_digest(funding_p),
        "funding_manifest_sha256": sha256_file(funding_manifest_p),
        "ledger_id": lock.LEDGER_ID,
        "lighter_lock_sha256": sha256_file(lighter_lock_p),
        "liq_manifest_sha256": sha256_file(liq_manifest_p),
        "lock_digest": lock.lock_digest(),
        "markets_sha256": sha256_file(markets_p),
        "panel_manifest_sha256": sha256_file(panel_manifest_p),
    }

    for k, expected_v in expected_hashes.items():
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

    # (d) Construct Store and call report.run_all
    if store_factory is None:
        store_factory = Store

    store = store_factory(fold_dir=fold_dir, panel_dir=panel_dir, liq_dir=liq_dir, funding_dir=funding_dir)
    trials_report = report.run_all(store)

    result_obj: dict[str, Any] = {
        "constants": get_constants(),
        "files_read": store.files_read() if hasattr(store, "files_read") else {},
        "fold_manifest_sha256": expected_hashes["fold_manifest_sha256"],
        "fold_trades_sha256": expected_hashes["fold_trades_sha256"],
        "funding_files_sha256": expected_hashes["funding_files_sha256"],
        "funding_manifest_sha256": expected_hashes["funding_manifest_sha256"],
        "hard_last_date": lock.HARD_LAST_DATE.isoformat(),
        "ledger_id": lock.LEDGER_ID,
        "lighter_lock_sha256": expected_hashes["lighter_lock_sha256"],
        "liq_manifest_sha256": expected_hashes["liq_manifest_sha256"],
        "lock": {
            "attested_by_environment": git_info["attested"],
            "digest": lock.lock_digest(),
            "git_head": git_info["head"],
        },
        "lock_digest": lock.lock_digest(),
        "markets_sha256": expected_hashes["markets_sha256"],
        "panel_manifest_sha256": expected_hashes["panel_manifest_sha256"],
        "prediction": lock.PREDICTION,
        "report": trials_report,
        "versions": {
            "numpy": getattr(np, "__version__", "unknown"),
            "pandas": getattr(pd, "__version__", "unknown"),
            "python": platform.python_version(),
            "scipy": getattr(scipy, "__version__", "unknown"),
        },
    }

    out_p.parent.mkdir(parents=True, exist_ok=True)
    with open(out_p, "x", encoding="utf-8") as f:
        json.dump(result_obj, f, sort_keys=True, indent=1)
        f.write("\n")

    summary_lines: list[str] = []
    trials_dict = trials_report.get("trials", {})
    for tid in lock.TRIAL_IDS:
        trial = trials_dict.get(tid, {})
        j = trial.get("judgement", trial)
        n_clusters = j.get("n_clusters", trial.get("n_clusters", 0))
        mean_val = j.get("mean", trial.get("mean"))
        bound_val = j.get("bound", trial.get("bound"))
        passed = j.get("passed", trial.get("passed", False))
        mean_str = "None" if mean_val is None else f"{mean_val:+.4f}"
        bound_str = "None" if bound_val is None else f"{bound_val:+.4f}"
        summary_lines.append(f"{tid} clusters={n_clusters} mean={mean_str} bound={bound_str} passed={passed}")

    return result_obj, summary_lines


def build_parser() -> argparse.ArgumentParser:
    """Build command-line parser with subcommands panel, event-count, register-check, and run."""
    parser = argparse.ArgumentParser(
        prog="python -m horizon.l1.run",
        description="Horizon L1 command-line interface.",
    )
    subparsers = parser.add_subparsers(dest="cmd")

    p_panel = subparsers.add_parser("panel", help="Build per-market panel files and check scale jumps.")
    p_panel.add_argument("--fold-dir", required=True, type=Path, help="Directory containing Lighter trade fold.")
    p_panel.add_argument("--out-dir", required=True, type=Path, help="Output directory for per-market panels.")

    p_count = subparsers.add_parser("event-count", help="Count burst candidates, events, and eligibility.")
    p_count.add_argument("--fold-dir", required=True, type=Path, help="Directory containing Lighter trade fold.")
    p_count.add_argument("--panel-dir", required=True, type=Path, help="Directory containing per-market panels.")
    p_count.add_argument("--liq-dir", required=True, type=Path, help="Directory containing liquidation pass.")
    p_count.add_argument("--funding-dir", required=True, type=Path, help="Directory containing funding settlements.")

    p_check = subparsers.add_parser("register-check", help="Verify registration hashes against anchor.")
    p_check.add_argument("--fold-dir", required=True, type=Path, help="Directory containing Lighter trade fold.")
    p_check.add_argument("--panel-dir", required=True, type=Path, help="Directory containing per-market panels.")
    p_check.add_argument("--liq-dir", required=True, type=Path, help="Directory containing liquidation pass.")
    p_check.add_argument("--funding-dir", required=True, type=Path, help="Directory containing funding settlements.")
    p_check.add_argument("--anchor", required=False, default=None, type=Path, help="Path to registration anchor JSON.")

    p_run = subparsers.add_parser("run", help="Run trials with guards.")
    p_run.add_argument("--fold-dir", required=True, type=Path, help="Directory containing Lighter trade fold.")
    p_run.add_argument("--panel-dir", required=True, type=Path, help="Directory containing per-market panels.")
    p_run.add_argument("--liq-dir", required=True, type=Path, help="Directory containing liquidation pass.")
    p_run.add_argument("--funding-dir", required=True, type=Path, help="Directory containing funding settlements.")
    p_run.add_argument("--anchor", required=True, type=Path, help="Path to registration anchor JSON.")
    p_run.add_argument("--out", required=True, type=Path, help="Path to output result JSON.")

    return parser


def main(
    argv: list[str] | None = None,
    *,
    runner: Callable[..., Any] | None = None,
    store_factory: Callable[..., Any] | None = None,
    here: Path | None = None,
) -> int:
    """Command-line entrypoint for horizon-l1 run CLI."""
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
        if args.cmd == "panel":
            summary, code = panel_cmd(args.fold_dir, args.out_dir)
            print(json.dumps(summary, sort_keys=True))
            return code

        if args.cmd == "event-count":
            counts = event_count_cmd(
                args.fold_dir,
                args.panel_dir,
                args.liq_dir,
                args.funding_dir,
                store_factory=store_factory,
            )
            print(json.dumps(counts, sort_keys=True, indent=1))
            return 0

        if args.cmd == "register-check":
            report_dict, code = register_check(
                args.fold_dir,
                args.panel_dir,
                args.liq_dir,
                args.funding_dir,
                args.anchor,
            )
            print(json.dumps(report_dict, sort_keys=True, indent=1))
            return code

        if args.cmd == "run":
            _, summary_lines = run_pipeline(
                args.fold_dir,
                args.panel_dir,
                args.liq_dir,
                args.funding_dir,
                args.anchor,
                args.out,
                runner=runner,
                store_factory=store_factory,
                here=here,
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
