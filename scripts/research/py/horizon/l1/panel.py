"""Build per-market panel files from Lighter trade fold and check price scale."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from horizon.l1 import lock

PANEL_VERSION = "l1p1"

FOLD_COLS = (
    "buy_usd",
    "sell_usd",
    "last_px",
    "last_buy_px",
    "last_buy_ts",
    "last_sell_px",
    "last_sell_ts",
    "first_buy_px",
    "first_buy_ts",
    "first_sell_px",
    "first_sell_ts",
)

PANEL_SCHEMA = pa.schema(
    [
        ("minute", pa.int64()),
        ("buy_usd", pa.float64()),
        ("sell_usd", pa.float64()),
        ("last_px", pa.int64()),
        ("last_buy_px", pa.int64()),
        ("last_buy_ts", pa.int64()),
        ("last_sell_px", pa.int64()),
        ("last_sell_ts", pa.int64()),
        ("first_buy_px", pa.int64()),
        ("first_buy_ts", pa.int64()),
        ("first_sell_px", pa.int64()),
        ("first_sell_ts", pa.int64()),
    ]
)


class PanelError(RuntimeError):
    """Raised when panel build fails guard checks or encounters invalid data."""


def sha256_file(path: Path) -> str:
    """Compute sha256 hex digest of a file in 1 MB chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_manifest(path: Path) -> dict[str, dict[str, Any]]:
    """Parse a manifest jsonl file where the last record per date wins."""
    latest: dict[str, dict[str, Any]] = {}
    if not path.is_file():
        return latest
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and "date" in rec:
            latest[str(rec["date"])] = rec
    return latest


class PanelExistsError(PanelError):
    """The output directory already holds panel files (nothing is overwritten and nothing is deleted)."""


def build_panel(fold_dir: Path | str, out_dir: Path | str) -> dict[str, Any]:
    """Rewrite Lighter trade fold into per-market panels and check price scale.

    A build that fails halfway removes the partial files it wrote, so it can be started again. A refusal because the
    directory already holds panels deletes nothing.
    """
    try:
        return _build_panel(fold_dir, out_dir)
    except PanelExistsError:
        raise
    except BaseException:
        out_path = Path(out_dir)
        for partial in out_path.glob("market=*.parquet"):
            partial.unlink(missing_ok=True)
        (out_path / "panel_manifest.json").unlink(missing_ok=True)
        raise


def _build_panel(fold_dir: Path | str, out_dir: Path | str) -> dict[str, Any]:
    fold_path = Path(fold_dir)
    out_path = Path(out_dir)

    if out_path.exists():
        existing_panels = list(out_path.glob("market=*.parquet"))
        has_manifest = (out_path / "panel_manifest.json").exists()
        if existing_panels or has_manifest:
            raise PanelExistsError(f"output directory {out_path} already holds panel files")
    out_path.mkdir(parents=True, exist_ok=True)

    fold_manifest_path = fold_path / "manifest.jsonl"
    if not fold_manifest_path.is_file():
        raise PanelError(f"missing fold manifest: {fold_manifest_path}")
    fold_manifest_sha256 = sha256_file(fold_manifest_path)

    markets_path = fold_path / "markets.json"
    if not markets_path.is_file():
        raise PanelError(f"missing markets.json: {markets_path}")
    markets_sha256 = sha256_file(markets_path)

    fold_manifest_by_date = read_manifest(fold_manifest_path)

    cur_day = lock.FOLD_FIRST_DATE
    days: list[dt.date] = []
    while cur_day <= lock.HARD_LAST_DATE:
        days.append(cur_day)
        cur_day += dt.timedelta(days=1)

    writers: dict[int, pq.ParquetWriter] = {}
    last_minute_seen: dict[int, int] = {}
    market_row_counts: dict[int, int] = {}
    market_first_minute: dict[int, int] = {}
    market_last_minute: dict[int, int] = {}

    projection = ["market_id", "minute", *FOLD_COLS]

    for day in days:
        date_str = day.isoformat()
        if date_str not in fold_manifest_by_date:
            raise PanelError(f"missing fold manifest line for day {date_str}")

        manifest_entry = fold_manifest_by_date[date_str]
        fold_ver = manifest_entry.get("fold_version")
        if fold_ver != "v1":
            raise PanelError(f"day {date_str} has fold_version {fold_ver!r}, expected 'v1'")

        day_file = fold_path / "v1" / f"date={date_str}.parquet"
        if not day_file.is_file():
            raise PanelError(f"missing fold file for day {date_str}: {day_file}")

        actual_file_sha = sha256_file(day_file)
        expected_sha = manifest_entry.get("output_sha256")
        if actual_file_sha != expected_sha:
            raise PanelError(f"sha256 mismatch for day {date_str}: expected {expected_sha}, got {actual_file_sha}")

        day_table = pq.read_table(day_file, columns=projection)
        if day_table.num_rows == 0:
            continue

        day_start_ms = int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.UTC).timestamp() * 1000)
        day_end_ms = day_start_ms + 86_400_000

        minutes = day_table["minute"].to_numpy(zero_copy_only=False)
        if np.any((minutes < day_start_ms) | (minutes >= day_end_ms)):
            raise PanelError(f"day {date_str} contains minute outside the UTC day")
        if np.any(minutes % 60_000 != 0):
            raise PanelError(f"day {date_str} contains minute not aligned to 60s")

        market_col = day_table["market_id"]
        market_ids = pc.unique(market_col).to_pylist()
        market_ids.sort()

        for m_id in market_ids:
            mask = pc.equal(market_col, m_id)
            subtable = day_table.filter(mask).drop(["market_id"]).cast(PANEL_SCHEMA)

            sub_minutes = subtable["minute"].to_numpy(zero_copy_only=False)
            if len(sub_minutes) > 1 and np.any(np.diff(sub_minutes) <= 0):
                raise PanelError(f"day {date_str} market {m_id} minutes not strictly increasing")

            if m_id in last_minute_seen:
                prev_m = last_minute_seen[m_id]
                if sub_minutes[0] <= prev_m:
                    raise PanelError(
                        f"day {date_str} market {m_id} minute {sub_minutes[0]} <= previous minute {prev_m}"
                    )

            last_minute_seen[m_id] = int(sub_minutes[-1])

            if m_id not in writers:
                out_file = out_path / f"market={m_id}.parquet"
                writers[m_id] = pq.ParquetWriter(out_file, schema=PANEL_SCHEMA, compression="zstd")
                market_first_minute[m_id] = int(sub_minutes[0])
                market_row_counts[m_id] = 0

            writers[m_id].write_table(subtable)
            market_row_counts[m_id] += len(sub_minutes)
            market_last_minute[m_id] = int(sub_minutes[-1])

    for writer in writers.values():
        writer.close()

    scale_jumps: list[list[Any]] = []
    market_manifest_entries: dict[str, dict[str, Any]] = {}

    for m_id in sorted(writers.keys()):
        out_file = out_path / f"market={m_id}.parquet"
        file_sha = sha256_file(out_file)
        market_manifest_entries[str(m_id)] = {
            "first_minute": market_first_minute[m_id],
            "last_minute": market_last_minute[m_id],
            "rows": market_row_counts[m_id],
            "sha256": file_sha,
        }

        panel_tbl = pq.read_table(out_file, columns=["minute", "last_px"])
        all_min = panel_tbl["minute"].to_numpy(zero_copy_only=False)
        if len(all_min) > 1 and np.any(np.diff(all_min) <= 0):
            raise PanelError(f"panel file market={m_id}.parquet minutes not strictly increasing")

        valid_mask = pc.is_valid(panel_tbl["last_px"])
        valid_tbl = panel_tbl.filter(valid_mask)
        if valid_tbl.num_rows >= 2:
            val_min = valid_tbl["minute"].to_numpy(zero_copy_only=False)
            val_px = valid_tbl["last_px"].to_numpy(zero_copy_only=False).astype(np.float64)
            for i in range(1, len(val_px)):
                px_prev = val_px[i - 1]
                px_curr = val_px[i]
                if px_prev <= 0 or px_curr <= 0:
                    continue
                ln_ratio = math.log(px_curr / px_prev)
                if abs(ln_ratio) > lock.SCALE_JUMP_LN:
                    later_minute = int(val_min[i])
                    if (m_id, later_minute) not in lock.KNOWN_SCALE_JUMPS:
                        scale_jumps.append([m_id, later_minute, ln_ratio])

    manifest: dict[str, Any] = {
        "days": len(days),
        "first_date": lock.FOLD_FIRST_DATE.isoformat(),
        "fold_manifest_sha256": fold_manifest_sha256,
        "last_date": lock.HARD_LAST_DATE.isoformat(),
        "markets": market_manifest_entries,
        "markets_sha256": markets_sha256,
        "panel_version": PANEL_VERSION,
        "scale_jumps": scale_jumps,
    }

    manifest_path = out_path / "panel_manifest.json"
    manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=1) + "\n", encoding="utf-8")
    return manifest


def main(argv: list[str] | None = None) -> None:
    """CLI helper to build per-market panel files."""
    parser = argparse.ArgumentParser(description="Build horizon-l1 per-market panel files.")
    parser.add_argument("--fold-dir", type=Path, required=True, help="Directory containing Lighter trade fold.")
    parser.add_argument("--out-dir", type=Path, required=True, help="Output directory for per-market panels.")
    args = parser.parse_args(argv)
    build_panel(args.fold_dir, args.out_dir)


if __name__ == "__main__":
    main()
