"""Lighter stage 2 runner: python -m lighter.run {eligibility,dev,null,report,confirm} (specification: lighter/lock.py).

eligibility  month-by-month eligible markets, tiers and file existence, computed from the previous month's cost and
             activity fields only. It computes no signal and no return, so it may be run BEFORE registration. Writes
             eligibility.json, with the union of mapped Binance symbols (the list to fetch). `--through confirm` is
             allowed only together with a finalists file, as for confirm.
dev          the 2,064-configuration grid on the development span, with the source guard, writes dev_result.json
             (statistics, no trade lists unless --save-trades).
null         one seed (1 to 20): a shift run over F1 to F5 (null_shift_N.json) and a sign-flip run over F6
             (null_f6_N.json).
report       needs dev_result.json and the 20 + 20 null runs: the two noise bars, passing configurations, the mirror
             and spread-sensitivity checks, tripwire, finalists.json, and the account layer for the finalists.
confirm      needs --dev-dir and --finalists: recomputes the finalists, writes a one-time record, recomputes eligibility
             from the data and runs only the finalists on 2026-07-01 to 2026-10-31, with Holm.

All inputs are read by lighter/data.py. Outputs are JSON (sorted keys, a sha256 of the content in content_sha256, a
generated_at stamp excluded from that hash), and Parquet trade lists. Every result records the lock digest (which covers
the code), the git HEAD, and whether the run was synthetic.
"""

from __future__ import annotations

import argparse
import datetime as dt
import functools
import hashlib
import json
import math
import os
import subprocess
import sys
import time
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from lighter import fills, lock, signals, stats
from lighter.data import (
    DataError,
    DataReader,
    Market,
    SpanError,
    ensure_dir,
    is_synthetic,
    month_range,
    read_json,
)
from lighter.fold_trades import day_start_ms

DAY_MS = lock.DAY_MS
TIER_CODE = {"A": 1, "B": 2}
LIGHTER_DIR = Path(__file__).resolve().parent
# Audit and anchor files live OUTSIDE lighter/: editing them must not change the lock digest.
RECORDS_DIR = LIGHTER_DIR.parent / "records"
REGISTRATION_FILE = "lighter_l1_registration.json"
SUSPECT_FILE = "lighter_l1_suspect_cleared.json"
CONFIRM_RECORD_FILE = "confirm_record.json"
RERUN_NOTE_FILE = "lighter_l1_confirm_rerun_note.json"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------------------------
# JSON output and provenance


def sanitize(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {str(k): sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        v = float(obj)
        return v if math.isfinite(v) else None
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


def content_hash(body: dict[str, Any]) -> str:
    clean = {k: v for k, v in body.items() if k not in ("generated_at", "content_sha256")}
    canon = json.dumps(sanitize(clean), sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(canon.encode()).hexdigest()


def write_result(path: Path, body: dict[str, Any]) -> str:
    """Write a result file. The hash covers everything except generated_at (and itself)."""
    out = sanitize(body)
    digest = content_hash(out)
    out["content_sha256"] = digest
    out["generated_at"] = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    Path(path).write_text(json.dumps(out, sort_keys=True, indent=1) + "\n", encoding="utf-8")
    return digest


def _git(args: list[str]) -> str:
    """Read-only git call in the lighter directory (replaced in tests)."""
    return subprocess.run(["git", *args], cwd=LIGHTER_DIR, capture_output=True, text=True, check=True).stdout


def provenance(fold_dir: str | Path) -> dict[str, Any]:
    """Lock digest, git HEAD and the synthetic flag. Refuses a dirty lighter tree unless the fold is synthetic.

    When git is unavailable the commit and a clean-tree attestation come from LIGHTER_GIT_HEAD and LIGHTER_TREE_CLEAN=1
    (recorded as "attested by environment"). When git is available it is always checked directly.
    """
    synthetic = is_synthetic(fold_dir)
    head: str | None = None
    git_ok = True
    try:
        head = _git(["rev-parse", "HEAD"]).strip() or None
    except (OSError, subprocess.CalledProcessError):
        git_ok = False
    source = "git"
    if not git_ok:
        env_head = os.environ.get("LIGHTER_GIT_HEAD") or None
        attested = os.environ.get("LIGHTER_TREE_CLEAN") == "1"
        if synthetic:
            head, source = env_head, "synthetic, git unavailable"
        elif env_head and attested:
            head, source = env_head, "attested by environment"
        else:
            raise SystemExit(
                "git is not available and LIGHTER_GIT_HEAD with LIGHTER_TREE_CLEAN=1 is not set: refusing to run"
            )
    elif not synthetic:
        try:
            dirty = _git(["status", "--porcelain", "--", str(LIGHTER_DIR)]).strip()
        except (OSError, subprocess.CalledProcessError) as exc:
            raise SystemExit("git status failed: refusing to run") from exc
        if dirty:
            raise SystemExit(f"uncommitted changes under scripts/research/py/lighter, refusing to run:\n{dirty}")
    return {
        "lock_sha256": lock.lock_digest(),
        "git_head": head,
        "git_source": source,
        "synthetic": synthetic,
        "versions": {"numpy": np.__version__, "pandas": pd.__version__, "pyarrow": pa.__version__},
    }


def _sha256_file(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def funding_manifest_path(funding_dir: str | Path) -> Path:
    nested = Path(funding_dir) / "funding" / "manifest.jsonl"
    return nested if nested.exists() else Path(funding_dir) / "manifest.jsonl"


_FILE_HASHES: dict[tuple[str, int, int], str] = {}  # per process only: (path, size, mtime) -> sha256 of the bytes


def file_sha256(path: Path) -> str:
    st = path.stat()
    key = (str(path), st.st_size, st.st_mtime_ns)
    if key not in _FILE_HASHES:
        _FILE_HASHES[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    return _FILE_HASHES[key]


def hashed_listing(root: Path, files: list[Path], label: str, progress: bool) -> str:
    """One sha256 over the sorted list of (relative file name, sha256 of the file's bytes)."""
    ordered = sorted(files, key=lambda p: str(p.relative_to(root)))
    entries = []
    for i, path in enumerate(ordered, 1):
        entries.append([str(path.relative_to(root)), file_sha256(path)])
        if progress and (i % 25 == 0 or i == len(ordered)):
            log(f"  hashing {label}: {i}/{len(ordered)} files")
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def anchor_contents(
    fold_dir: str | Path, binance_dir: str | Path, funding_dir: str | Path, progress: bool = False
) -> dict[str, Any]:
    """What the registration anchor file should contain for these data directories."""
    fold, binance, funding = Path(fold_dir), Path(binance_dir), Path(funding_dir)
    binance_files = [p for p in binance.rglob("*") if p.is_file()]
    listing = sorted((str(p.relative_to(binance)), p.stat().st_size) for p in binance_files)
    return {
        "lock_sha256": lock.lock_digest(),
        "fold_manifest_sha256": _sha256_file(fold / "manifest.jsonl"),
        "markets_json_sha256": _sha256_file(fold / "markets.json"),
        "funding_manifest_sha256": _sha256_file(funding_manifest_path(funding)),
        "funding_files_sha256": funding_listing(funding, "funding", progress),
        "binance_files": [list(f) for f in listing],
        "binance_files_sha256": hashed_listing(binance, binance_files, "binance", progress),
    }


def funding_listing(funding: Path, label: str, progress: bool) -> str:
    files = [p for p in funding.rglob("market_*.parquet") if p.is_file()]
    return hashed_listing(funding, files, label, progress)


def anchor_file_sha(prov: dict[str, Any]) -> str | None:
    """The sha256 of the registration anchor file (None for a synthetic run, which needs no anchor)."""
    if prov["synthetic"]:
        return None
    return _sha256_file(RECORDS_DIR / REGISTRATION_FILE)


def check_registration(args: Any, prov: dict[str, Any]) -> None:
    """dev, null, report and confirm refuse on non-synthetic data unless the registration anchor is committed and
    matches the data (every file's bytes, not only names and sizes)."""
    if prov["synthetic"]:
        return
    path = RECORDS_DIR / REGISTRATION_FILE
    if not path.exists():
        raise SystemExit(f"the registration anchor {path} is absent: refusing to run")
    if not record_committed(path):
        raise SystemExit(f"the registration anchor {path} is not committed (tracked and unmodified at HEAD)")
    want = read_json(path)
    got = anchor_contents(args.fold_dir, args.binance_dir, args.funding_dir, progress=True)
    diff = sorted(k for k in got if want.get(k) != got[k])
    if diff:
        raise SystemExit(f"the data or the code differ from the registration anchor in: {diff}")


def start(args: Any, *, stamp: bool = False) -> dict[str, Any]:
    """The checks every study command makes first: provenance, the funding stamp (dev), the registration anchor."""
    prov = provenance(args.fold_dir)
    if stamp and not lock.FUNDING_STAMP_VERIFIED and not prov["synthetic"]:
        raise SystemExit("FUNDING_STAMP_VERIFIED is False: dev refuses to run on non-synthetic data")
    check_registration(args, prov)
    return prov


def load_suspect_cleared(synthetic: bool = False) -> tuple[tuple[str, ...], str | None]:
    """Configuration ids cleared by a committed audit note, and the file's sha256 (None when the file is absent).

    A present file must be committed (tracked and unmodified at HEAD) on a non-synthetic run.
    """
    path = RECORDS_DIR / SUSPECT_FILE
    if not path.exists():
        return (), None
    if not synthetic and not record_committed(path):
        raise SystemExit(f"the audit file {path} is not committed (tracked and unmodified at HEAD)")
    doc = read_json(path)
    entries = doc.get("cleared", doc) if isinstance(doc, dict) else doc
    ids = tuple(e["id"] if isinstance(e, dict) else str(e) for e in entries)
    return ids, _sha256_file(path)


def record_committed(path: Path) -> bool:
    """True when the file is tracked and unmodified at HEAD (or attested by the environment where git is missing)."""
    try:
        _git(["ls-files", "--error-unmatch", "--", str(path)])
        return not _git(["status", "--porcelain", "--", str(path)]).strip()
    except subprocess.CalledProcessError:
        return False
    except OSError:
        return os.environ.get("LIGHTER_RECORD_COMMITTED") == "1"


def check_result_file(doc: dict[str, Any], name: str, prov: dict[str, Any]) -> None:
    """A result file must carry this lock digest, an intact content hash and the same synthetic flag as this run."""
    if doc.get("lock_sha256") != prov["lock_sha256"]:
        raise SystemExit(f"{name} was written under a different lock digest")
    if content_hash(doc) != doc.get("content_sha256"):
        raise SystemExit(f"{name} fails its content hash")
    if bool(doc.get("synthetic")) != bool(prov["synthetic"]):
        raise SystemExit(f"{name} and this run do not agree on synthetic: they cannot be mixed")


# ---------------------------------------------------------------------------------------------------------------
# Span and eligibility


@dataclass(frozen=True)
class Span:
    """A study span: decisions from first to last (inclusive), features warmed up on the WARMUP_DAYS before."""

    first: dt.date
    last: dt.date

    @property
    def start_ms(self) -> int:
        return day_start_ms(self.first)

    @property
    def end_ms(self) -> int:
        return day_start_ms(self.last) + DAY_MS

    @property
    def t0_ms(self) -> int:
        return self.start_ms - lock.WARMUP_DAYS * DAY_MS

    @property
    def ng(self) -> int:
        return (self.end_ms - self.t0_ms) // lock.GRID_MS

    @property
    def start_j(self) -> int:
        return lock.WARMUP_DAYS * lock.GRID_PER_DAY

    @property
    def months(self) -> list[tuple[int, int]]:
        return month_range((self.first.year, self.first.month), (self.last.year, self.last.month))


@dataclass(frozen=True)
class MonthInfo:
    tier: str
    activity_median: float
    spread_proxy_bps: float
    qualifying_minutes: int
    binance_symbol: str | None
    source: str  # "pending" (Binance files exist, the source guard decides) or "lighter"


Eligibility = dict[tuple[int, int], dict[int, MonthInfo]]
Proxies = dict[tuple[int, int], dict[int, float]]


def check_out_of_scope_ids(reader: DataReader, perp_ids: set[int], cost: dict[int, Any], py: int, pm: int) -> None:
    """Stops on a fold id that is not a perp market of markets.json and meets the activity clause in month P.

    A "spot" entry is known and out of scope (ignored). An entry of any other market_type, or an id with no entry at
    all (including the ids listed as unknown), stops the run with the id named (and the type). Below the clause such
    an id is ignored. The one rule used by eligibility and by the confirm pre-flight.
    """
    for mid, cs in sorted(cost.items()):
        if mid in perp_ids or mid in reader.non_perp or cs.activity_median < lock.ELIG_MIN_MEDIAN_TRADES:
            continue
        if mid in reader.other_types:
            raise DataError(
                f"market_id {mid} has market_type {reader.other_types[mid]!r} (neither perp nor spot) and meets the "
                f"activity clause in {py:04d}-{pm:02d}"
            )
        raise DataError(f"market_id {mid} meets the activity clause in {py:04d}-{pm:02d} but is not in markets.json")


def compute_eligibility(reader: DataReader, markets: list[Market], months: list[tuple[int, int]]) -> Eligibility:
    """For each month M the markets eligible in it, from the fold rows of the previous month only."""
    by_id = {m.market_id: m for m in markets}
    out: Eligibility = {}
    for y, mo in months:
        py, pm = lock.previous_month(y, mo)
        cost = reader.month_cost_stats(py, pm)
        check_out_of_scope_ids(reader, set(by_id), cost, py, pm)
        infos: dict[int, MonthInfo] = {}
        for mid, cs in sorted(cost.items()):
            market = by_id.get(mid)
            if market is None:
                continue
            tier = lock.classify_tier(cs.activity_median, cs.qualifying_minutes, cs.spread_proxy_bps)
            if tier is None:
                continue
            sym = market.binance_symbol
            files = bool(sym) and reader.binance_month_exists(sym, py, pm) and reader.binance_month_exists(sym, y, mo)
            infos[mid] = MonthInfo(
                tier,
                cs.activity_median,
                cs.spread_proxy_bps,
                cs.qualifying_minutes,
                sym,
                "pending" if files else "lighter",
            )
        out[(y, mo)] = infos
    return out


def spread_proxies(reader: DataReader, months: list[tuple[int, int]]) -> Proxies:
    """Per month M and market, the spread proxy of the previous month (for markets with enough qualifying minutes)."""
    out: Proxies = {}
    for y, mo in months:
        py, pm = lock.previous_month(y, mo)
        cost = reader.month_cost_stats(py, pm)
        out[(y, mo)] = {
            mid: cs.spread_proxy_bps
            for mid, cs in cost.items()
            if cs.qualifying_minutes >= lock.ELIG_MIN_QUALIFYING_MINUTES and np.isfinite(cs.spread_proxy_bps)
        }
    return out


def sp_per_minute(proxies: Proxies, market_id: int, span: Span) -> np.ndarray:
    """The spread proxy in force at each minute from span.t0: that of the month, else the latest earlier month's.

    Minutes before the first month with a proxy get NaN: they cannot carry a fill.
    """
    n = (span.end_ms - span.t0_ms) // lock.MINUTE_MS
    values: dict[int, float] = {}
    last = float("nan")
    for y, mo in span.months:
        v = proxies.get((y, mo), {}).get(market_id)
        if v is not None:
            last = v
        values[lock.month_index(y, mo)] = last
    out = np.full(n, np.nan)
    month_of_minute = (
        (span.t0_ms + np.arange(n, dtype=np.int64) * lock.MINUTE_MS).astype("datetime64[ms]").astype("datetime64[M]")
    ).astype(np.int64)
    for idx, v in values.items():
        if np.isfinite(v):
            out[month_of_minute == idx] = v
    return out


def eligibility_document(
    elig: Eligibility, markets: list[Market], fold_market_ids: set[int], non_perp: dict[int, str] | None = None
) -> dict[str, Any]:
    by_id = {m.market_id: m for m in markets}
    months: dict[str, Any] = {}
    symbols: set[str] = set()
    needed: dict[str, set[str]] = defaultdict(set)
    for (y, mo), infos in sorted(elig.items()):
        py, pm = lock.previous_month(y, mo)
        rows = []
        for mid, info in sorted(infos.items()):
            rows.append(
                {
                    "market_id": mid,
                    "symbol": by_id[mid].symbol,
                    "class": by_id[mid].cls,
                    "tier": info.tier,
                    "activity_median_trades": info.activity_median,
                    "spread_proxy_bps": info.spread_proxy_bps,
                    "qualifying_minutes": info.qualifying_minutes,
                    "binance_symbol": info.binance_symbol,
                    "source": "source pending guard" if info.source == "pending" else "lighter",
                }
            )
            if info.binance_symbol:
                symbols.add(info.binance_symbol)
                needed[info.binance_symbol] |= {f"{py:04d}-{pm:02d}", f"{y:04d}-{mo:02d}"}
        months[f"{y:04d}-{mo:02d}"] = {"previous_month": f"{py:04d}-{pm:02d}", "eligible": rows}
    return {
        "months": months,
        "binance_symbols": sorted(symbols),
        "binance_months_needed": {k: sorted(v) for k, v in sorted(needed.items())},
        "markets_in_list": len(markets),
        "market_ids_in_fold": sorted(fold_market_ids),
        "non_perp_market_ids": [
            {"market_id": mid, "symbol": sym}
            for mid, sym in sorted((non_perp or {}).items())
            if mid in fold_market_ids and mid not in by_id
        ],
    }


# ---------------------------------------------------------------------------------------------------------------
# The source guard (month P of a month M)


def guard_month(md_p: Any) -> dict[str, Any]:
    """The source guard on one month P of data (a MinuteData holding both Lighter and Binance for the month).

    Level: |median ln(Lighter close / Binance close)| over the 5m grid points where both are valid. Correlation: on
    non-overlapping 15 minute log returns where both closes are valid.
    """
    cl, vl = signals.grid_prices(md_p, "lighter")
    cb, vb = signals.grid_prices(md_p, "binance")
    both = vl & vb
    out: dict[str, Any] = {"points": int(both.sum()), "median_bps": None, "corr": None, "return_points": 0, "ok": False}
    if not both.any():
        return out
    med = float(np.median(np.log(cl[both] / cb[both])))
    rl, rb = signals.log_returns(cl, vl, 3), signals.log_returns(cb, vb, 3)
    on_grid = (np.arange(len(rl)) % 3) == 0  # non-overlapping 15 minute windows
    ok2 = ~np.isnan(rl) & ~np.isnan(rb) & on_grid
    out["median_bps"] = med * lock.BPS
    out["return_points"] = int(ok2.sum())
    if ok2.sum() >= 2:
        a, b = rl[ok2], rb[ok2]
        out["corr"] = float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else None
    out["ok"] = bool(
        abs(med) * lock.BPS <= lock.GUARD_MAX_MEDIAN_BPS
        and out["return_points"] >= lock.GUARD_MIN_POINTS
        and out["corr"] is not None
        and out["corr"] >= lock.GUARD_MIN_CORR
    )
    return out


def guard_key(market_id: int, year: int, month: int) -> str:
    return f"{market_id}:{year:04d}-{month:02d}"


BinanceLoader = Callable[[], Any]  # returns (has, close) arrays on the minute grid, or None


def binance_confirmation(
    c: dict[str, Any], t0_ms: int, closes: tuple[np.ndarray, np.ndarray] | None
) -> tuple[bool | None, float | None]:
    """Did the Binance 1m close move by the same factor as the Lighter jump?

    |ln(close 60 minutes after the jump minute / close 60 minutes before it) - the Lighter ln ratio| < 0.05. None
    (cannot be checked) when there is no Binance data or either of the two bars is missing.
    """
    if closes is None:
        return None, None
    has, close = closes
    i = (c["minute"] - t0_ms) // lock.MINUTE_MS
    a, b = int(i + lock.REAL_MOVE_MINUTES), int(i - lock.REAL_MOVE_MINUTES)
    if b < 0 or a >= len(has) or not (has[a] and has[b]):
        return None, None
    if not (np.isfinite(close[a]) and np.isfinite(close[b]) and close[a] > 0 and close[b] > 0):
        return None, None
    ln_b = float(np.log(close[a] / close[b]))
    return bool(abs(ln_b - c["ln_ratio"]) < lock.REAL_MOVE_TOL), ln_b


def scale_candidates(md: Any, binance: BinanceLoader | None = None) -> list[dict[str, Any]]:
    """Every jump between two consecutive PRINTED minutes that looks like a power-of-ten rescaling.

    |ln(ratio) - k ln 10| < 0.05 for an integer k != 0. `holds` says whether the jump is a level shift: the median mid
    proxy of the next 60 printed minutes (the jump minute included) is within 0.05 (in ln) of the post-jump level, and
    so is the median of the previous 60 printed minutes around the pre-jump level (the return from a crash minute is
    thereby not a rescaling), each window holding at least SCALE_MIN_WINDOW printed minutes (a listing minute or the
    end of the data cannot be confirmed), else the candidate counts as holding. `binance_confirms` says whether the
    Binance 1m close moved by the same factor (a real move, not a rescaling): True, False, or None when it cannot be
    checked. `binance` is called only when there is a candidate. Reads price levels only.
    """
    mid, _ = signals.mid_proxy(md)
    printed = np.flatnonzero(md.has_print)
    out: list[dict[str, Any]] = []
    if len(printed) < 2:
        return out
    m = mid[printed]
    with np.errstate(invalid="ignore", divide="ignore"):
        d = np.log(m[1:] / m[:-1])
    k = np.rint(d / np.log(10.0))
    cand = np.flatnonzero(np.isfinite(d) & (k != 0) & (np.abs(d - k * np.log(10.0)) < lock.SCALE_BREAK_TOL))
    closes = binance() if (binance is not None and len(cand)) else None
    for i in cand:
        after = np.log(m[i + 1 : i + 1 + lock.SCALE_HOLD_MINUTES])
        before = np.log(m[max(0, i + 1 - lock.SCALE_HOLD_MINUTES) : i + 1])
        holds_after = abs(float(np.median(after)) - float(np.log(m[i + 1]))) < lock.SCALE_BREAK_TOL
        holds_before = abs(float(np.median(before)) - float(np.log(m[i]))) < lock.SCALE_BREAK_TOL
        enough = len(after) >= lock.SCALE_MIN_WINDOW and len(before) >= lock.SCALE_MIN_WINDOW
        row = {
            "minute": int(md.t0_ms + int(printed[i + 1]) * lock.MINUTE_MS),
            "ln_ratio": float(d[i]),
            "decades": int(k[i]),
            # fewer than SCALE_MIN_WINDOW printed minutes on a side cannot refute the break: it counts as holding
            "holds": bool(not enough or (holds_after and holds_before)),
            "insufficient_window": bool(not enough),
            "printed_minutes_before": int(len(before)),
            "printed_minutes_after": int(len(after)),
        }
        confirms, ln_b = binance_confirmation(row, md.t0_ms, closes)
        row["binance_confirms"] = confirms
        row["binance_ln_ratio"] = ln_b
        out.append(row)
    return out


def first_excluded_grid(break_minute: int) -> int:
    """First grid point at or after the break minute (ceiling): a decision up to four minutes before it still stands."""
    return -(-int(break_minute) // signals.GRID_MIN)


def is_real_move(c: dict[str, Any], market_id: int) -> bool:
    """A holding candidate that Binance confirms, or one acknowledged by a KNOWN_SCALE_BREAKS entry with k = 0."""
    if c["binance_confirms"] is True:
        return True
    return any(mid == market_id and minute == c["minute"] and k == 0 for mid, minute, k in lock.KNOWN_SCALE_BREAKS)


def holding_breaks(md: Any, binance: BinanceLoader | None = None) -> list[dict[str, Any]]:
    """The candidates that hold (or cannot be refuted) and are not real moves: the scale breaks. Same code for
    scalescan, the development check, the confirmation pre-flight and the exclusion rule."""
    mid = md.market.market_id
    return [c for c in scale_candidates(md, binance) if c["holds"] and not is_real_move(c, mid)]


def check_scale(market: Market, md: Any, binance: BinanceLoader | None = None) -> None:
    """Stops on a scale break: a power-of-ten jump whose new level holds or cannot be refuted, that Binance does not
    confirm as a real move."""
    for c in holding_breaks(md, binance):
        raise DataError(
            f"price-scale break in {market.symbol} (market_id {market.market_id}) at minute {c['minute']} "
            f"({dt.datetime.fromtimestamp(c['minute'] / 1000, dt.UTC).isoformat()})"
        )


# ---------------------------------------------------------------------------------------------------------------
# The grid engine


def eligible_for(cfg: lock.Config, tier_codes: np.ndarray) -> np.ndarray:
    """Grid points at which a market may open a trade in the configuration's universe."""
    return (tier_codes == 1) if cfg.universe == "A" else (tier_codes >= 1)


def trade_frame(market_id: int, ctx: fills.FillContext, batch: fills.TradeBatch) -> pa.Table:
    return pa.table(
        {
            "market_id": pa.array(np.full(batch.n, market_id), pa.int32()),
            "side": pa.array(batch.side, pa.int8()),
            "decision_ms": pa.array(ctx.t0_ms + batch.j * lock.GRID_MS, pa.int64()),
            "entry_ts": pa.array(batch.entry_ts, pa.int64()),
            "exit_ts": pa.array(batch.exit_ts, pa.int64()),
            "entry_px": pa.array(batch.entry_px, pa.float64()),
            "exit_px": pa.array(batch.exit_px, pa.float64()),
            "gross": pa.array(batch.gross, pa.float64()),
            "fund": pa.array(batch.fund, pa.float64()),
            "net": pa.array(batch.net, pa.float64()),
            "flagged": pa.array(batch.flag, pa.bool_()),
        }
    )


def month_selectors(span: Span) -> dict[tuple[int, int], np.ndarray]:
    """Boolean mask over the grid for each month of the span (decision times inside the span only)."""
    gm = signals.grid_month_index(span.t0_ms, span.ng)
    in_span = np.arange(span.ng) >= span.start_j
    return {(y, mo): (gm == lock.month_index(y, mo)) & in_span for y, mo in span.months}


def run_grid(
    reader: DataReader,
    markets: list[Market],
    elig: Eligibility,
    proxies: Proxies,
    configs: list[lock.Config],
    span: Span,
    *,
    shift_days: int | None = None,
    signflip_seed: int | None = None,
    mirror: bool = False,
    spread_mult: float = 1.0,
    trades_dir: Path | None = None,
    guard: dict[str, Any] | None = None,
    scale_policy: str = "stop",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run configs over the span. Returns the stats in config order and per-market data-quality figures.

    scale_policy: "stop" (the default) raises on a holding scale break. "exclude" (the confirmation only) drops the
    market from the first such break on: no signal fires from the grid point holding it, trades open at it exit by
    the fallback rule, flagged, and the breaks are listed in the quality figures.

    guard: the source-guard table (key "market_id:YYYY-MM"). Months missing from it are computed and added to it, so a
    caller can pass {} to receive the table or a cached one to skip the computation.
    """
    reader.check_end_ms(span.end_ms)
    ng, start_j = span.ng, span.start_j
    if guard is None:
        guard = {}
    selectors = month_selectors(span)
    tier = {m.market_id: np.zeros(ng, dtype=np.int8) for m in markets}
    for ym, infos in elig.items():
        for mid, info in infos.items():
            tier[mid][selectors[ym]] = TIER_CODE[info.tier]
    study = [m for m in markets if tier[m.market_id].any()]
    n_days = (span.end_ms - span.start_ms) // DAY_MS
    needed = {c.signal.sig_id for c in configs}
    accs = {c.cid: stats.ConfigAcc(c, span.start_ms, n_days) for c in configs}

    base: dict[int, dict[str, np.ndarray]] = {}
    sigma_comp: dict[int, np.ndarray] = {}
    binj: dict[int, np.ndarray] = {}
    cs_feats: dict[int, dict[str, signals.MarketFeatures]] = {}
    f_exists: dict[int, bool] = {}
    no_funding: dict[int, bool] = {}
    final_source: dict[tuple[int, int], dict[int, str]] = {ym: {} for ym in elig}
    trig: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    f4_ids = {c.signal.sig_id for c in configs if c.family == "F4"}
    if scale_policy not in ("stop", "exclude"):
        raise DataError(f"unknown scale policy {scale_policy!r}")
    break_at: dict[int, int] = {}
    break_list: dict[int, list[dict[str, Any]]] = {}
    for market in study:
        mid = market.market_id
        cand = [ym for ym, infos in sorted(elig.items()) if mid in infos and infos[mid].source == "pending"]
        todo = [ym for ym in cand if guard_key(mid, *ym) not in guard]
        sym = market.binance_symbol
        t0_load = span.t0_ms
        load_months: set[tuple[int, int]] = set()
        if todo:
            p_first = min(lock.previous_month(*ym) for ym in todo)
            t0_load = min(t0_load, day_start_ms(dt.date(p_first[0], p_first[1], 1)))
            load_months = {ym for ym in todo} | {lock.previous_month(*ym) for ym in todo}
        known_ok = [ym for ym in cand if ym not in todo and guard[guard_key(mid, *ym)]["ok"]]
        for ym in known_ok:
            load_months |= {ym, lock.previous_month(*ym)}
        md = reader.load_minutes(market, t0_load, span.end_ms, load_months, sym)
        for ym in todo:
            p = lock.previous_month(*ym)
            a = (day_start_ms(dt.date(p[0], p[1], 1)) - md.t0_ms) // lock.MINUTE_MS
            b = (day_start_ms(dt.date(ym[0], ym[1], 1)) - md.t0_ms) // lock.MINUTE_MS
            guard[guard_key(mid, *ym)] = guard_month(md.slice(a, b))
        ok_months = {ym for ym in cand if guard[guard_key(mid, *ym)]["ok"]}
        for ym in elig:
            if mid in elig[ym]:
                final_source[ym][mid] = "binance" if ym in ok_months else "lighter"
        if t0_load < span.t0_ms:
            md = md.slice((span.t0_ms - t0_load) // lock.MINUTE_MS)
        closes = functools.partial(reader.load_binance_closes, market, md.t0_ms, md.n)
        if scale_policy == "stop":
            check_scale(market, md, closes)
            bj = ng
        else:
            found = holding_breaks(md, closes)
            if found:
                break_list[mid] = found
                break_at[mid] = int((min(c["minute"] for c in found) - md.t0_ms) // lock.MINUTE_MS)
            bj = first_excluded_grid(break_at.get(mid, ng * signals.GRID_MIN))
        funding = reader.load_funding(mid, span.end_ms)
        f_exists[mid] = reader.funding_exists(mid)
        no_funding[mid] = reader.is_no_funding(mid)
        flag = np.zeros(ng, dtype=bool)
        for ym in ok_months:
            flag |= selectors[ym]
        binj[mid] = flag
        by_source = {"lighter": signals.compute_features(md, "lighter", span.start_ms, funding, needed)}
        if ok_months:
            by_source["binance"] = signals.compute_features(md, "binance", span.start_ms, funding, needed)
        if mid in break_at:
            for f in by_source.values():
                f.sigma[bj:] = np.nan
                for k in f.r:
                    f.r[k][bj:] = np.nan
                    f.z[k][bj:] = np.nan
                for arr in f.sides.values():
                    arr[bj:] = 0
                for arr in f.valid.values():
                    arr[bj:] = False
        base[mid], sigma_comp[mid] = signals.compose_by_source(by_source, flag)
        if no_funding[mid]:
            for sig_id in base[mid]:
                if sig_id.startswith("F6-"):
                    base[mid][sig_id][:] = 0  # no funding signal: F6 never trades a no-funding market
        if f4_ids:
            valid = signals.compose_valid(by_source, flag)
            for sig_id in f4_ids:
                if sig_id not in valid:
                    continue
                for universe in lock.UNIVERSES:
                    mask = (tier[mid] == 1) if universe == "A" else (tier[mid] >= 1)
                    t = trig[(sig_id, universe)]
                    t[0] += int(np.count_nonzero(base[mid].get(sig_id, np.zeros(ng, np.int8))[mask]))
                    t[1] += int(np.count_nonzero(valid[sig_id] & mask))
        for f in by_source.values():
            f.sides, f.z, f.valid = {}, {}, {}
        cs_feats[mid] = by_source
        log(f"  features {market.symbol} ({'+'.join(sorted(by_source))})")
        del md
    slices = []
    for ym, infos in sorted(elig.items()):
        idx = np.flatnonzero(selectors[ym])
        if len(idx) == 0:
            continue
        slices.append(
            signals.MonthSlice(
                int(idx[0]), int(idx[-1]) + 1, {m: (i.tier, final_source[ym][m]) for m, i in infos.items()}
            )
        )
    xs = signals.cross_sectional_sides(cs_feats, slices, ng, needed)
    for (xmid, _, _), arr in xs.items():
        if xmid in break_at:
            arr[first_excluded_grid(break_at[xmid]) :] = 0
    del cs_feats
    if shift_days is not None:
        base = {m: {k: stats.shift_sides(v, start_j, shift_days) for k, v in d.items()} for m, d in base.items()}
        xs = {key: stats.shift_sides(v, start_j, shift_days) for key, v in xs.items()}
    if signflip_seed is not None:
        rng = stats.signflip_rng(signflip_seed)
        for m in sorted(base):
            for sig_id in sorted(k for k in base[m] if k.startswith("F6-")):
                base[m][sig_id] = stats.signflip(base[m][sig_id], rng, start_j)
    for (sig_id, universe), (fired, valid) in trig.items():
        if shift_days is None and signflip_seed is None:
            for c in configs:
                if c.signal.sig_id == sig_id and c.universe == universe:
                    accs[c.cid].add_trigger(fired, valid)

    by_hold: dict[int, dict[str, list[lock.Config]]] = defaultdict(lambda: defaultdict(list))
    for c in configs:
        by_hold[c.hold][c.exit].append(c)

    quality: dict[str, Any] = {}
    for market in study:
        mid = market.market_id
        md = reader.load_minutes(market, span.t0_ms, span.end_ms)
        funding = reader.load_funding(mid, span.end_ms)
        mid_px, stale = signals.mid_proxy(md)
        span_stale = stale[start_j * 5 :]
        quality[str(mid)] = {
            "symbol": market.symbol,
            "class": market.cls,
            "eligible_months": sum(1 for infos in elig.values() if mid in infos),
            "binance_months": int(sum(1 for ym in elig if final_source[ym].get(mid) == "binance")),
            "stale_share": float(np.mean(span_stale != 0)),
            "max_stale_minutes": int(span_stale.max()),
        }
        sp = sp_per_minute(proxies, mid, span)
        ctx = fills.build_context(md, sigma_comp[mid], funding, mid_px, sp, spread_mult, break_min=break_at.get(mid))
        if no_funding.get(mid):
            quality[str(mid)]["no_funding"] = True
        if mid in break_at:
            quality[str(mid)]["excluded_scale_breaks"] = [
                {k: c[k] for k in ("minute", "decades", "insufficient_window")} for c in break_list[mid]
            ]
        del md
        masked: dict[tuple[str, str], np.ndarray | None] = {}

        def sides_of(cfg: lock.Config, mid: int = mid, masked: dict = masked) -> np.ndarray | None:
            key = (cfg.signal.sig_id, cfg.universe)
            if key not in masked:
                sig = cfg.signal
                if sig.family in ("F2", "F3"):
                    raw = xs.get((mid, cfg.universe, sig.sig_id))
                else:
                    raw = base[mid].get(sig.sig_id)
                if raw is None:
                    masked[key] = None
                else:
                    gated = np.where(eligible_for(cfg, tier[mid]), raw, 0).astype(np.int8)
                    if mirror:
                        gated = -gated
                    masked[key] = gated if gated.any() else None
            return masked[key]

        for hold in sorted(by_hold):
            kinds = tuple(k for k in lock.EXITS if k in by_hold[hold])
            outs_l = fills.outcomes(ctx, 1, hold, kinds, start_j)
            outs_s = fills.outcomes(ctx, -1, hold, kinds, start_j)
            for kind in kinds:
                ol = outs_l[kind] if outs_l else None
                os_ = outs_s[kind] if outs_s else None
                for cfg in by_hold[hold][kind]:
                    sides = sides_of(cfg)
                    if sides is None:
                        continue
                    batch = fills.select_trades(ctx, sides, ol, os_)
                    if batch.n and not f_exists[mid] and not no_funding[mid]:
                        hint = (
                            " (the funding manifest says empty but the market is still listed in order books)"
                            if reader.empty_but_listed(mid)
                            else ""
                        )
                        raise DataError(f"market {market.symbol} has trades but no funding file{hint}")
                    accs[cfg.cid].add(
                        mid, batch, binj[mid][batch.j] if batch.n else None, market.cls, no_funding=no_funding[mid]
                    )
                    if trades_dir is not None and batch.n:
                        d = ensure_dir(Path(trades_dir) / cfg.cid)
                        pq.write_table(trade_frame(mid, ctx, batch), d / f"market_{mid}.parquet", compression="zstd")
        log(f"  fills {market.symbol}")
    return [accs[c.cid].finalize() for c in configs], quality


# ---------------------------------------------------------------------------------------------------------------
# Commands


def make_reader(args: Any, mode: str, last_date: dt.date | None = None) -> DataReader:
    return DataReader(
        fold_dir=args.fold_dir,
        binance_dir=getattr(args, "binance_dir", None),
        funding_dir=getattr(args, "funding_dir", None),
        mode=mode,
        last_date=last_date,
    )


def study_header(kind: str, reader: DataReader, prov: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": kind,
        **prov,
        "ledger_id": lock.LEDGER_ID,
        "trials": lock.TRIALS,
        "mode": reader.mode,
        "last_date": reader.last_date.isoformat(),
    }


@dataclass
class Prepared:
    markets: list[Market]
    elig: Eligibility
    proxies: Proxies
    doc: dict[str, Any]
    digest: str


def prepare(reader: DataReader, span: Span) -> Prepared:
    markets = reader.load_markets()
    elig = compute_eligibility(reader, markets, span.months)
    proxies = spread_proxies(reader, span.months)
    doc = eligibility_document(elig, markets, reader.fold_market_ids, reader.non_perp)
    return Prepared(markets, elig, proxies, doc, content_hash(doc))


def check_finalists_file(path: str | None, prov: dict[str, Any]) -> dict[str, Any]:
    if not path or not Path(path).exists():
        raise SystemExit("this needs a finalists file")
    doc = read_json(path)
    check_result_file(doc, "the finalists file", prov)
    return doc


def cmd_eligibility(args: Any, last_date: dt.date | None = None, first_date: dt.date | None = None) -> Path:
    """Eligible markets, tiers and file existence per month. Reads cost and activity fields only."""
    through = getattr(args, "through", "dev")
    prov = provenance(args.fold_dir)
    mode = "dev"
    if through == "confirm":
        check_finalists_file(getattr(args, "finalists", None), prov)
        mode = "confirm"
    elif through != "dev":
        raise SystemExit("--through must be dev or confirm")
    out_dir = ensure_dir(args.out_dir)
    reader = make_reader(args, mode, last_date)
    span = Span(first_date or lock.DEV_FIRST_DATE, reader.last_date)
    prep = prepare(reader, span)
    body = study_header("eligibility", reader, prov)
    body.update(prep.doc)
    body.update({"through": through, "eligibility_sha256": prep.digest, "manifest": reader.sorted_manifest()})
    body["data_quality"] = reader.quality
    path = out_dir / "eligibility.json"
    write_result(path, body)
    return path


def cmd_dev(
    args: Any,
    last_date: dt.date | None = None,
    configs: list[lock.Config] | None = None,
    first_date: dt.date | None = None,
) -> Path:
    prov = start(args, stamp=True)
    out_dir = ensure_dir(args.out_dir)
    reader = make_reader(args, "dev", last_date)
    span = Span(first_date or lock.DEV_FIRST_DATE, reader.last_date)
    prep = prepare(reader, span)
    cfgs = list(lock.GRID) if configs is None else configs
    trades_dir = out_dir / "trades" if getattr(args, "save_trades", False) else None
    began = time.monotonic()
    guard: dict[str, Any] = {}
    results, quality = run_grid(
        reader, prep.markets, prep.elig, prep.proxies, cfgs, span, trades_dir=trades_dir, guard=guard
    )
    body = study_header("dev", reader, prov)
    body.update(
        {
            "first_date": span.first.isoformat(),
            "eligibility": prep.doc,
            "eligibility_sha256": prep.digest,
            "source_guard": guard,
            "markets": quality,
            "configs": results,
            "data_quality": reader.quality,
            "manifest": reader.sorted_manifest(),
        }
    )
    path = out_dir / "dev_result.json"
    write_result(path, body)
    log(f"dev done in {time.monotonic() - began:.0f}s: {path}")
    return path


def _cached_guard(out_dir: Path, prov: dict[str, Any], eligibility_sha: str) -> dict[str, Any]:
    path = out_dir / "dev_result.json"
    if not path.exists():
        return {}
    doc = read_json(path)
    check_result_file(doc, "dev_result.json", prov)
    if doc.get("eligibility_sha256") != eligibility_sha:
        raise SystemExit("dev_result.json was computed on different eligibility")
    return dict(doc.get("source_guard", {}))


def cmd_null(
    args: Any,
    last_date: dt.date | None = None,
    configs: list[lock.Config] | None = None,
    first_date: dt.date | None = None,
) -> tuple[Path, Path]:
    """Seed N: the shift run over F1 to F5 and the sign-flip run over F6."""
    if args.seed not in lock.NOISE_SEEDS:
        raise SystemExit(f"seed must be one of {lock.NOISE_SEEDS[0]}..{lock.NOISE_SEEDS[-1]}")
    prov = start(args)
    out_dir = ensure_dir(args.out_dir)
    reader = make_reader(args, "dev", last_date)
    span = Span(first_date or lock.DEV_FIRST_DATE, reader.last_date)
    prep = prepare(reader, span)
    guard = _cached_guard(out_dir, prov, prep.digest)
    cfgs = list(lock.GRID) if configs is None else configs
    paths = []
    for kind, family_test in (("shift", lambda c: c.family != "F6"), ("f6", lambda c: c.family == "F6")):
        sel = [c for c in cfgs if family_test(c)]
        days = stats.noise_offset_days(args.seed) if kind == "shift" else None
        results: list[dict[str, Any]] = []
        if sel:
            results, _ = run_grid(
                reader,
                prep.markets,
                prep.elig,
                prep.proxies,
                sel,
                span,
                shift_days=days,
                signflip_seed=None if kind == "shift" else args.seed,
                guard=guard,
            )
        t_by = {r["id"]: r["t"] for r in results}
        best = max(results, key=lambda r: (r["t"], r["id"])) if results else None
        body = study_header(f"null_{kind}", reader, prov)
        body.update(
            {
                "seed": args.seed,
                "offset_days": days,
                "max_t": best["t"] if best else None,
                "argmax": best["id"] if best else None,
                "t_by_config": t_by,
                "eligibility_sha256": prep.digest,
                "manifest": reader.sorted_manifest(),
            }
        )
        path = out_dir / f"null_{kind}_{args.seed}.json"
        write_result(path, body)
        paths.append(path)
    return paths[0], paths[1]


def load_nulls(
    dev_dir: Path, prov: dict[str, Any], seeds: tuple[int, ...] = lock.NOISE_SEEDS
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    names = [f"null_shift_{s}.json" for s in seeds] + [f"null_f6_{s}.json" for s in seeds]
    missing = [n for n in names if not (dev_dir / n).exists()]
    if missing:
        raise SystemExit(f"missing null result files: {missing}")
    shift = [read_json(dev_dir / f"null_shift_{s}.json") for s in seeds]
    f6 = [read_json(dev_dir / f"null_f6_{s}.json") for s in seeds]
    for name, doc in zip(names, shift + f6, strict=True):
        check_result_file(doc, name, prov)
    return shift, f6


def bars_from_nulls(
    shift: list[dict[str, Any]], f6: list[dict[str, Any]]
) -> tuple[float, float, list[float], list[float]]:
    if any(n["max_t"] is None for n in [*shift, *f6]):
        raise SystemExit("a null run has no maximum t (None): that is an error, not a run to skip")
    m_shift = [n["max_t"] for n in shift]
    m_f6 = [n["max_t"] for n in f6]
    return stats.noise_bar(m_shift), stats.noise_bar(m_f6), m_shift, m_f6


def evaluate_candidates(
    reader: DataReader,
    prep: Prepared,
    span: Span,
    dev: dict[str, Any],
    bar: float,
    f6_bar: float,
    guard: dict[str, Any],
    cleared: tuple[str, ...] = (),
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Candidates (items a to f, not suspect, funding coverage), their mirror and doubled-spread checks, finalists."""
    configs = dev["configs"]
    cand = stats.finalist_candidates(configs, bar, f6_bar, cleared)
    checks: dict[str, dict[str, Any]] = {}
    if cand:
        cfgs = [lock.CONFIG_BY_ID[c["id"]] for c in cand]
        mirror, _ = run_grid(reader, prep.markets, prep.elig, prep.proxies, cfgs, span, mirror=True, guard=guard)
        doubled, _ = run_grid(
            reader,
            prep.markets,
            prep.elig,
            prep.proxies,
            cfgs,
            span,
            spread_mult=lock.SPREAD_SENSITIVITY_MULT,
            guard=guard,
        )
        for c, m, d in zip(cand, mirror, doubled, strict=True):
            checks[c["id"]] = stats.variant_checks(
                c["mean_net_bps"],
                m["mean_net_bps"],
                d["mean_net_bps"],
                c["mean_fill_cost_bps"],
                c.get("no_funding_trades", 0),
                c.get("mean_net_ex_no_funding_bps"),
            )
            checks[c["id"]]["no_funding_block"] = stats.no_funding_block_flags(c, bar, f6_bar)
    return cand, checks, stats.select_finalists(cand, checks)


def cmd_report(
    args: Any,
    last_date: dt.date | None = None,
    seeds: tuple[int, ...] = lock.NOISE_SEEDS,
    first_date: dt.date | None = None,
) -> Path:
    prov = start(args)
    print(lock.REPORT_CAUTION)
    out_dir = ensure_dir(args.out_dir)
    dev = read_json(out_dir / "dev_result.json")
    check_result_file(dev, "dev_result.json", prov)
    shift, f6 = load_nulls(out_dir, prov, seeds)
    bar, f6_bar, m_shift, m_f6 = bars_from_nulls(shift, f6)
    configs = dev["configs"]
    flags = {c["id"]: stats.dev_flags(c, bar, f6_bar) for c in configs}
    passing = [c["id"] for c in configs if flags[c["id"]]["pass"]]
    item_counts = {k: sum(f[k] for f in flags.values()) for k in "abcdef"}
    suspects = [c["id"] for c in configs if stats.is_suspect(c)]

    reader = make_reader(args, "dev", last_date)
    span = Span(first_date or lock.DEV_FIRST_DATE, reader.last_date)
    prep = prepare(reader, span)
    if prep.digest != dev["eligibility_sha256"]:
        raise SystemExit("the eligibility recomputed now differs from the one in dev_result.json")
    guard = dict(dev["source_guard"])
    cleared, cleared_sha = load_suspect_cleared(prov["synthetic"])
    cand, checks, finalists = evaluate_candidates(reader, prep, span, dev, bar, f6_bar, guard, cleared)
    final_doc = {
        **prov,
        "dev_result_sha256": dev["content_sha256"],
        "suspect_cleared_sha256": cleared_sha,
        "noise_bar": bar,
        "f6_bar": f6_bar,
        "finalists": [
            {
                "config_id": c["id"],
                "family": c["family"],
                "class": c["class"],
                "dev_t": c["t"],
                "dev_mean_bps": c["mean_net_bps"],
                **checks.get(c["id"], {}),
            }
            for c in finalists
        ],
    }
    write_result(out_dir / "finalists.json", final_doc)

    account: dict[str, Any] = {}
    rerun_ok: dict[str, bool] = {}
    if finalists:
        cfgs = [lock.CONFIG_BY_ID[c["id"]] for c in finalists]
        trades_dir = out_dir / "trades"
        rerun, _ = run_grid(
            reader, prep.markets, prep.elig, prep.proxies, cfgs, span, trades_dir=trades_dir, guard=guard
        )
        for new in rerun:
            old = next(c for c in configs if c["id"] == new["id"])
            rerun_ok[new["id"]] = bool(new["trades"] == old["trades"] and new["t"] == old["t"])
        if not all(rerun_ok.values()):
            raise SystemExit(f"the finalist re-run differs from the development result: {rerun_ok}")
        account = account_layer(reader, prep.markets, span, cfgs, trades_dir, prep.proxies)
    body = {
        "kind": "report",
        "caution": lock.REPORT_CAUTION,
        **prov,
        "dev_result_sha256": dev["content_sha256"],
        "prediction": lock.PREDICTION,
        "null_runs": {
            "seeds": list(seeds),
            "shift_maxima": m_shift,
            "f6_maxima": m_f6,
            "offset_days": [n["offset_days"] for n in shift],
        },
        "noise_bar": bar,
        "f6_bar": f6_bar,
        "pass_threshold_t": max(lock.PASS_MIN_T, bar),
        "pass_threshold_t_f6": max(lock.PASS_MIN_T, f6_bar),
        "items_passed_counts": item_counts,
        "passing": passing,
        "candidates": [c["id"] for c in cand],
        "variant_checks": checks,
        "finalists": final_doc["finalists"],
        "tripwire": {
            "suspect": suspects,
            "cleared": list(cleared),
            "cleared_file_sha256": cleared_sha,
            "notice": (
                "SUSPECT configurations exist: audit for look-ahead before anything else."
                if suspects
                else "No configuration tripped the tripwire."
            ),
        },
        "rerun_matches_dev": rerun_ok,
        "account_layer": account,
        "configs": [
            {
                "id": c["id"],
                "t": c["t"],
                "mean_net_bps": c["mean_net_bps"],
                "trades": c["trades"],
                "class": c["class"],
                "by_source": c["by_source"],
                "majority_source": c["majority_source"],
                "mean_fill_cost_bps": c["mean_fill_cost_bps"],
                "tie_share": c["tie_share"],
                "no_funding_trades": c.get("no_funding_trades", 0),
                "no_funding_block": stats.no_funding_block_flags(c, bar, f6_bar),
                **flags[c["id"]],
            }
            for c in configs
        ],
    }
    path = out_dir / "report.json"
    write_result(path, body)
    return path


def account_layer(
    reader: DataReader, markets: list[Market], span: Span, cfgs: list[lock.Config], trades_dir: Path, proxies: Proxies
) -> dict[str, Any]:
    by_id = {m.market_id: m for m in markets}
    out: dict[str, Any] = {}
    mids: dict[int, tuple[int, np.ndarray]] = {}
    for cfg in cfgs:
        files = sorted((trades_dir / cfg.cid).glob("market_*.parquet")) if (trades_dir / cfg.cid).exists() else []
        if not files:
            out[cfg.cid] = {"note": "no trades"}
            continue
        merged = pa.concat_tables([pq.read_table(f) for f in files])
        cols = {name: merged.column(name).to_numpy(zero_copy_only=False) for name in merged.column_names}
        for mid in {int(x) for x in cols["market_id"]}:
            if mid not in mids:
                md = reader.load_minutes(by_id[mid], span.t0_ms, span.end_ms)
                mids[mid] = (span.t0_ms, signals.mid_proxy(md)[0])
        out[cfg.cid] = {f"L{lev}": stats.simulate_account(cols, mids, lev) for lev in lock.ACCOUNT_LEVERAGES}
    return out


@dataclass
class DevInputs:
    """What confirm --prepare and --run both establish from the development directory."""

    finalists_doc: dict[str, Any]
    dev: dict[str, Any]
    dev_dir: Path
    hashes: dict[str, str]
    finalists: list[str]
    dev_reader: DataReader
    dev_prep: Prepared
    dev_span: Span
    bars: tuple[float, float]


def verify_dev_inputs(args: Any, prov: dict[str, Any], dev_last_date: dt.date | None) -> DevInputs:
    """Check the finalists file, the dev result and the 20 + 20 null files, recompute the finalists from the data."""
    doc = check_finalists_file(getattr(args, "finalists", None), prov)
    dev_dir_arg = getattr(args, "dev_dir", None)
    if not dev_dir_arg:
        raise SystemExit("confirm needs --dev-dir")
    dev_dir = Path(dev_dir_arg)
    dev = read_json(dev_dir / "dev_result.json")
    check_result_file(dev, "dev_result.json", prov)
    shift, f6 = load_nulls(dev_dir, prov)
    bar, f6_bar, _, _ = bars_from_nulls(shift, f6)
    cleared, cleared_sha = load_suspect_cleared(prov["synthetic"])
    if doc.get("suspect_cleared_sha256") != cleared_sha:
        raise SystemExit("the audit file of cleared SUSPECT configurations differs from the one the finalists used")
    dev_reader = make_reader(args, "dev", dev_last_date)
    dev_span = Span(lock.DEV_FIRST_DATE, dev_reader.last_date)
    dev_prep = prepare(dev_reader, dev_span)
    if dev_prep.digest != dev["eligibility_sha256"]:
        raise SystemExit("the development eligibility recomputed now differs from dev_result.json")
    _, _, finalists = evaluate_candidates(
        dev_reader, dev_prep, dev_span, dev, bar, f6_bar, dict(dev["source_guard"]), cleared
    )
    computed = [c["id"] for c in finalists]
    supplied = [f["config_id"] for f in doc["finalists"]]
    if computed != supplied:
        raise SystemExit(
            f"the finalists recomputed from {dev_dir} ({computed}) differ from the supplied file ({supplied})"
        )
    hashes = {"dev_result.json": dev["content_sha256"]}
    for n in [*shift, *f6]:
        hashes[f"null_{n['kind'].split('_')[1]}_{n['seed']}.json"] = n["content_sha256"]
    return DevInputs(doc, dev, dev_dir, hashes, computed, dev_reader, dev_prep, dev_span, (bar, f6_bar))


def rerun_matches(inputs: DevInputs) -> None:
    """Re-run each finalist on the development data and stop on any difference from the dev result."""
    if not inputs.finalists:
        return
    cfgs = [lock.CONFIG_BY_ID[i] for i in inputs.finalists]
    p = inputs.dev_prep
    rerun, _ = run_grid(
        inputs.dev_reader, p.markets, p.elig, p.proxies, cfgs, inputs.dev_span, guard=dict(inputs.dev["source_guard"])
    )
    for new in rerun:
        old = next(c for c in inputs.dev["configs"] if c["id"] == new["id"])
        if new["trades"] != old["trades"] or new["t"] != old["t"]:
            raise SystemExit(f"finalist {new['id']} re-run on the development data differs from the dev result")


@dataclass(frozen=True)
class ConfirmPaths:
    """Where the confirmation record, the consumed marker and a re-run note live.

    A real run keeps them in records/ (committed). A synthetic rehearsal keeps them beside its other outputs, with a
    "synthetic" suffix, so it can neither block nor consume the real confirmation.
    """

    record: Path
    marker: Path
    note: Path


def confirm_paths(prov: dict[str, Any], out_dir: str | Path) -> ConfirmPaths:
    digest16 = prov["lock_sha256"][:16]
    if prov["synthetic"]:
        base = Path(out_dir)
        return ConfirmPaths(
            base / "confirm_record.synthetic.json",
            base / f"confirm_ran_{digest16}.synthetic.json",
            base / "confirm_rerun_note.synthetic.json",
        )
    return ConfirmPaths(
        RECORDS_DIR / CONFIRM_RECORD_FILE, RECORDS_DIR / f"confirm_ran_{digest16}.json", RECORDS_DIR / RERUN_NOTE_FILE
    )


def cmd_confirm(args: Any, last_date: dt.date | None = None, dev_last_date: dt.date | None = None) -> Path:
    """confirm --prepare writes the record and stops, confirm --run needs the committed record and runs once."""
    prov = start(args)
    prepare_flag, run_flag = bool(getattr(args, "prepare", False)), bool(getattr(args, "run", False))
    if prepare_flag == run_flag:
        raise SystemExit("confirm needs exactly one of --prepare and --run")
    out_dir = ensure_dir(args.out_dir)
    paths = confirm_paths(prov, out_dir)
    inputs = verify_dev_inputs(args, prov, dev_last_date)
    if prepare_flag:
        if paths.record.exists():
            raise SystemExit(f"{paths.record} exists already: confirm is prepared once")
        _, cleared_sha = load_suspect_cleared(prov["synthetic"])
        ensure_dir(paths.record.parent)
        record = {
            "kind": "confirm_record",
            **prov,
            "ran": False,
            "finalists": inputs.finalists,
            "finalists_sha256": inputs.finalists_doc["content_sha256"],
            "suspect_cleared_sha256": cleared_sha,
            "dev_hashes": inputs.hashes,
        }
        write_result(paths.record, record)
        return paths.record
    return confirm_run(args, prov, inputs, paths, last_date)


def check_rerun_note(paths: ConfirmPaths, marker: dict[str, Any], prov: dict[str, Any]) -> str:
    """The one permitted re-run: the marker records a data error, and a committed note names that error.

    The note is a JSON object with "marker_sha256" (the content_sha256 of the marker it answers) and "error" (the
    marker's error text, copied). Returns the sha256 of the note file.
    """
    if not paths.note.exists():
        raise SystemExit(
            f"the consumed marker records a data error ({marker.get('error')}): a re-run needs the committed note "
            f"{paths.note} that names it"
        )
    if not prov["synthetic"] and not record_committed(paths.note):
        raise SystemExit(f"the re-run note {paths.note} is not committed (tracked and unmodified at HEAD)")
    note = read_json(paths.note)
    if not isinstance(note, dict) or note.get("marker_sha256") != marker["content_sha256"]:
        raise SystemExit("the re-run note does not name the consumed marker (marker_sha256 differs)")
    if not marker.get("error") or note.get("error") != marker["error"]:
        raise SystemExit("the re-run note does not name the error recorded in the consumed marker")
    return str(_sha256_file(paths.note))


def confirm_preflight(reader: DataReader, span: Span, prep: Prepared) -> dict[str, Any]:
    """Metadata checks made BEFORE the consumed marker is written. Any failure stops with the marker untouched.

    Every fold day from the previous month of the first confirmation month to the last is in the manifest and
    its file hash matches. No fold id that is not a perp market (or spot) of markets.json meets the activity
    clause. A funding file exists for every market eligible in some confirmation month. Every Binance file the
    source guard may read parses structurally. The scale scan over the confirmation window (warm-up start to
    end, the run-time code path) lists the holding breaks it finds: they are recorded and handled by the
    exclusion rule of the run, they do not stop it.
    """
    first_p = lock.previous_month(span.first.year, span.first.month)
    first_day = dt.date(first_p[0], first_p[1], 1)
    reader.require_fold_days(first_day, span.last)
    perp_ids = {m.market_id for m in prep.markets}
    for y, mo in span.months:  # the same activity condition as eligibility, the same code
        py, pm = lock.previous_month(y, mo)
        check_out_of_scope_ids(reader, perp_ids, reader.month_cost_stats(py, pm), py, pm)
    active = sorted({mid for infos in prep.elig.values() for mid in infos})
    missing_funding = [mid for mid in active if not reader.funding_exists(mid) and not reader.is_no_funding(mid)]
    if missing_funding:
        raise DataError(
            f"no funding file (and no empty manifest line for a delisted market) for market ids {missing_funding}"
        )
    no_funding_markets = [mid for mid in active if reader.is_no_funding(mid)]
    checked: set[tuple[str, int, int]] = set()
    for ym, infos in sorted(prep.elig.items()):
        for info in infos.values():
            if info.source != "pending" or not info.binance_symbol:
                continue
            for y, mo in (lock.previous_month(*ym), ym):
                key = (info.binance_symbol, y, mo)
                if key not in checked:
                    reader.check_binance_structure(*key)
                    checked.add(key)
    by_id = {m.market_id: m for m in prep.markets}
    breaks: list[dict[str, Any]] = []
    real_moves: list[dict[str, Any]] = []
    for mid in active:
        md = reader.load_minutes(by_id[mid], span.t0_ms, span.end_ms, mid_only=True)
        closes = functools.partial(reader.load_binance_closes, by_id[mid], md.t0_ms, md.n)
        for c in scale_candidates(md, closes):
            if c["holds"]:
                row = {"market_id": mid, "symbol": by_id[mid].symbol, **c}
                (real_moves if is_real_move(c, mid) else breaks).append(row)
    return {
        "fold_days_checked": (span.last - first_day).days + 1,
        "funding_files_checked": len(active) - len(no_funding_markets),
        "no_funding_markets": no_funding_markets,
        "binance_files_checked": len(checked),
        "scale_breaks_found": breaks,
        "real_moves_found": real_moves,
    }


def confirm_output_exists(out_dir: Path) -> bool:
    """True when a confirm trade list or a confirm result exists in the out dir."""
    trades = Path(out_dir) / "confirm_trades"
    return (Path(out_dir) / "confirm_result.json").exists() or (trades.exists() and any(trades.rglob("*.parquet")))


def confirm_run(
    args: Any, prov: dict[str, Any], inputs: DevInputs, paths: ConfirmPaths, last_date: dt.date | None
) -> Path:
    out_dir = ensure_dir(args.out_dir)
    if not paths.record.exists():
        raise SystemExit("no confirm record: run confirm --prepare and commit the record first")
    record = read_json(paths.record)
    check_result_file(record, "confirm_record.json", prov)
    if record.get("ran") or (out_dir / "confirm_result.json").exists():
        raise SystemExit("confirm has run already for this lock digest: confirm runs once")
    anchor_sha = anchor_file_sha(prov)
    attempt, previous_marker, note_sha = 1, None, None
    if paths.marker.exists():
        old = read_json(paths.marker)
        check_result_file(old, "the consumed marker", prov)
        if old.get("status") != "error" or int(old.get("attempt", 1)) >= 2:
            raise SystemExit("confirm has run already for this lock digest: confirm runs once")
        if old.get("anchor_sha256") != anchor_sha or old.get("record_sha256") != record["content_sha256"]:
            raise SystemExit("a re-run needs the same registration anchor and confirm record as the first attempt")
        if not prov["synthetic"] and not record_committed(RECORDS_DIR / REGISTRATION_FILE):
            raise SystemExit("the registration anchor is not committed (tracked and unmodified at HEAD)")
        note_sha = check_rerun_note(paths, old, prov)
        attempt, previous_marker = int(old.get("attempt", 1)) + 1, old["content_sha256"]
    if not prov["synthetic"] and not record_committed(paths.record):
        raise SystemExit("the confirm record is not committed (tracked and unmodified at HEAD): commit it first")
    if record["finalists"] != inputs.finalists or record["dev_hashes"] != inputs.hashes:
        raise SystemExit("the finalists or the dev files differ from the committed confirm record")
    if record["finalists_sha256"] != inputs.finalists_doc["content_sha256"]:
        raise SystemExit("the finalists file differs from the committed confirm record")
    if confirm_output_exists(out_dir):
        raise SystemExit(f"{out_dir} holds confirm output already: confirm runs once")
    rerun_matches(inputs)

    reader = make_reader(args, "confirm", last_date)
    span = Span(lock.CONFIRM_FIRST_DATE, reader.last_date)
    prep = prepare(reader, span)
    preflight = confirm_preflight(reader, span, prep)

    ensure_dir(paths.marker.parent)
    marker_body = {
        "kind": "confirm_ran",
        **prov,
        "finalists": inputs.finalists,
        "record_sha256": record["content_sha256"],
        "anchor_sha256": anchor_sha,
        "status": "started",
        "error": None,
        "attempt": attempt,
        "previous_marker_sha256": previous_marker,
        "rerun_note_sha256": note_sha,
    }
    marker_hash = write_result(paths.marker, marker_body)
    try:
        path = confirm_statistics(
            args, prov, inputs, reader, span, prep, preflight, out_dir, record, marker_hash, attempt, note_sha
        )
    except Exception as exc:
        # an error before any trade list or statistic leaves one re-run; after any output the read is spent
        status = "error-after-output" if confirm_output_exists(out_dir) else "error"
        write_result(paths.marker, {**marker_body, "status": status, "error": f"{type(exc).__name__}: {exc}"})
        raise
    print(
        "commit these two files together:\n"
        f"  {paths.marker}  sha256 {_sha256_file(paths.marker)}\n"
        f"  {path}  sha256 {_sha256_file(path)}"
    )
    return path


def confirm_statistics(
    args: Any,
    prov: dict[str, Any],
    inputs: DevInputs,
    reader: DataReader,
    span: Span,
    prep: Prepared,
    preflight: dict[str, Any],
    out_dir: Path,
    record: dict[str, Any],
    marker_hash: str,
    attempt: int,
    note_sha: str | None,
) -> Path:
    cfgs = [lock.CONFIG_BY_ID[i] for i in inputs.finalists]
    body = study_header("confirm", reader, prov)
    body.update(
        {
            "finalists_sha256": inputs.finalists_doc["content_sha256"],
            "confirm_record_sha256": record["content_sha256"],
            "consumed_marker_sha256": marker_hash,
            "attempt": attempt,
            "rerun_note_sha256": note_sha,
            "preflight": preflight,
            "scale_policy": "exclude",
            "eligibility": prep.doc,
            "eligibility_sha256": prep.digest,
        }
    )
    if not cfgs:
        body.update({"results": [], "manifest": reader.sorted_manifest()})
    else:
        guard: dict[str, Any] = {}
        common = {"guard": guard, "scale_policy": "exclude"}
        results, quality = run_grid(
            reader,
            prep.markets,
            prep.elig,
            prep.proxies,
            cfgs,
            span,
            trades_dir=out_dir / "confirm_trades",
            **common,
        )
        mirror, _ = run_grid(reader, prep.markets, prep.elig, prep.proxies, cfgs, span, mirror=True, **common)
        doubled, _ = run_grid(
            reader,
            prep.markets,
            prep.elig,
            prep.proxies,
            cfgs,
            span,
            spread_mult=lock.SPREAD_SENSITIVITY_MULT,
            **common,
        )
        flags: dict[str, dict[str, Any]] = {}
        for r, m, d in zip(results, mirror, doubled, strict=True):
            checks = stats.variant_checks(
                r["mean_net_bps"],
                m["mean_net_bps"],
                d["mean_net_bps"],
                r["mean_fill_cost_bps"],
                r.get("no_funding_trades", 0),
                r.get("mean_net_ex_no_funding_bps"),
            )
            majority = next(c for c in inputs.dev["configs"] if c["id"] == r["id"])["majority_source"]
            flags[r["id"]] = stats.confirm_flags(r, checks, majority)
        stats.apply_holm(flags)
        for r in results:
            r["confirm"] = flags[r["id"]]
            r["tripwire_suspect"] = stats.is_suspect(r)
        body.update(
            {
                "results": results,
                "holm_family_size": len(results),
                "source_guard": guard,
                "markets": quality,
                "data_quality": reader.quality,
                "manifest": reader.sorted_manifest(),
            }
        )
    path = out_dir / "confirm_result.json"
    write_result(path, body)
    return path


def cmd_scalescan(args: Any, last_date: dt.date | None = None, first_date: dt.date | None = None) -> Path:
    """Every candidate price-scale jump of the development span. Reads price levels only (Lighter mid proxy inputs and
    Binance closes): no signal, no return."""
    prov = provenance(args.fold_dir)
    out_dir = ensure_dir(args.out_dir)
    reader = make_reader(args, "dev", last_date)
    span = Span(first_date or lock.DEV_FIRST_DATE, reader.last_date)
    rows: list[dict[str, Any]] = []
    markets = reader.load_markets()
    for market in markets:
        # the same window (warm-up included) and the same code path as the run-time check in run_grid
        md = reader.load_minutes(market, span.t0_ms, span.end_ms, mid_only=True)
        closes = functools.partial(reader.load_binance_closes, market, md.t0_ms, md.n)
        for c in scale_candidates(md, closes):
            rows.append(
                {
                    "market_id": market.market_id,
                    "symbol": market.symbol,
                    **c,
                    "real_move": is_real_move(c, market.market_id),
                }
            )
    body = study_header("scalescan", reader, prov)
    body.update(
        {
            "computes": "price levels only (Lighter mid proxy inputs, Binance closes): no signal, no strategy return",
            "markets_scanned": len(markets),
            "candidates": rows,
            "holding": [r for r in rows if r["holds"]],
            "real_moves": [r for r in rows if r["holds"] and r["real_move"]],
            "would_stop": [r for r in rows if r["holds"] and not r["real_move"]],
            "manifest": reader.sorted_manifest(),
        }
    )
    path = out_dir / "scale_breaks.json"
    write_result(path, body)
    return path


def cmd_register_check(args: Any) -> int:
    """Print what the registration anchor file should contain for these data directories."""
    anchor = anchor_contents(args.fold_dir, args.binance_dir, args.funding_dir, progress=True)
    print(json.dumps(anchor, indent=1, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="lighter.run", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    rc = sub.add_parser("register-check", help="print what the registration anchor file should contain")
    rc.add_argument("--fold-dir", required=True)
    rc.add_argument("--binance-dir", required=True)
    rc.add_argument("--funding-dir", required=True)
    for name in ("eligibility", "scalescan", "dev", "null", "report", "confirm"):
        sp = sub.add_parser(
            name,
            help=(
                "eligible markets per month from cost and activity fields only: computes no signal and no return, "
                "safe to run before registration"
            )
            if name == "eligibility"
            else (
                "every candidate price-scale jump of the development span from mid proxy inputs only: computes no "
                "signal and no strategy return, safe to run before registration"
            )
            if name == "scalescan"
            else None,
        )
        sp.add_argument("--fold-dir", required=True)
        if name != "scalescan":
            sp.add_argument("--binance-dir", required=name != "eligibility")
        else:
            sp.add_argument("--binance-dir", default=None, help="optional: lets the scan check a jump against Binance")
        if name not in ("eligibility", "scalescan"):
            sp.add_argument("--funding-dir", required=True)
        sp.add_argument("--out-dir", required=True)
        if name == "eligibility":
            sp.description = (
                "Writes eligibility.json: per month the eligible markets with tier, activity, spread proxy, "
                "qualifying minutes, mapped Binance symbol and file existence, and the union of Binance symbols. "
                "Reads fold cost and activity fields of the previous month only, checks Binance file existence only, "
                "and computes no signal and no return, so it is safe to run before registration."
            )
            sp.add_argument("--through", choices=("dev", "confirm"), default="dev")
            sp.add_argument("--finalists", default=None, help="required with --through confirm")
        if name == "scalescan":
            sp.description = (
                "Writes scale_breaks.json: every jump between consecutive printed minutes that looks like a power of "
                "ten rescaling, with market, minute, ln ratio, whether the new level holds and whether the Binance 1m "
                "close moved by the same factor (a real move). Reads price levels only (the Lighter mid proxy inputs "
                "and Binance closes) of the development span and computes no signal and no strategy return."
            )
        if name == "dev":
            sp.add_argument("--save-trades", action="store_true", help="write every configuration's trade list (huge)")
        if name == "null":
            sp.add_argument("--seed", type=int, required=True)
        if name == "confirm":
            sp.add_argument("--finalists", required=False, default=None)
            sp.add_argument("--dev-dir", required=False, default=None)
            sp.add_argument(
                "--prepare",
                action="store_true",
                help="write the confirm record (records/ for a real run, the out dir for a synthetic one) and stop",
            )
            sp.add_argument("--run", action="store_true", help="run the confirmation (needs the committed record)")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "register-check":
        return cmd_register_check(args)
    try:
        {
            "eligibility": cmd_eligibility,
            "scalescan": cmd_scalescan,
            "dev": cmd_dev,
            "null": cmd_null,
            "report": cmd_report,
            "confirm": cmd_confirm,
        }[args.cmd](args)
    except (SpanError, DataError) as exc:
        log(f"refused: {exc}")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
