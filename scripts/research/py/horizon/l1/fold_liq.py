"""LIQUIDATION FOLD l1v1: liquidation-only pass over the public Lighter trade archive, with the forced side."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from lighter import fold_trades as ft

LIQ_FOLD_VERSION = "l1v1"
LAST_DATE = dt.date(2026, 6, 30)
FIRST_DATE = ft.FIRST_DATE
LIQ_TYPE = "liquidation"
COLUMNS = (
    "timestamp",
    "market_id",
    "usdc_amount",
    "is_maker_ask",
    "trade_type",
    "taker_position_size_before",
)

OUTPUT_SCHEMA = pa.schema(
    [
        ("market_id", pa.int16()),
        ("minute", pa.int64()),
        ("liq_sell_usd", pa.float64()),
        ("liq_buy_usd", pa.float64()),
        ("n_liq_sell", pa.int32()),
        ("n_liq_buy", pa.int32()),
    ]
)


class DateGuardError(ft.FoldError):
    """A date is before FIRST_DATE or after LAST_DATE."""


def check_day(day: dt.date) -> None:
    """Refuse any date after LAST_DATE or before FIRST_DATE."""
    if day > LAST_DATE:
        raise DateGuardError(f"date {day} is after {LAST_DATE}: later days are a reserved forward sample")
    if day < FIRST_DATE:
        raise DateGuardError(f"date {day} is before the first archive day {FIRST_DATE}")


def read_manifest(path: Path) -> dict[str, dict[str, Any]]:
    """Last manifest line per date. Malformed lines are ignored."""
    latest: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return latest
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and "date" in rec:
            latest[rec["date"]] = rec
    return latest


def is_done(record: dict[str, Any] | None, out_file: Path) -> bool:
    """True when record has LIQ_FOLD_VERSION and out_file exists with matching sha256."""
    if record is None or record.get("fold_version") != LIQ_FOLD_VERSION or not out_file.is_file():
        return False
    return ft.sha256_file(out_file) == record.get("output_sha256")


def append_manifest(path: Path, record: dict[str, Any]) -> None:
    """Append one record line atomically to the manifest."""
    with open(path, "a") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def fold_day(raw_path: Path, day: dt.date) -> tuple[pa.Table, dict[str, Any]]:
    """Fold one raw day file into per-minute liquidation bars and stats."""
    check_day(day)
    pf = pq.ParquetFile(raw_path)
    file_columns = set(pf.schema_arrow.names)
    missing = [c for c in COLUMNS if c not in file_columns]
    if missing:
        raise ft.FoldError(f"{raw_path.name} is missing required columns {missing} (present: {sorted(file_columns)})")

    day_start = ft.day_start_ms(day)
    day_end = day_start + ft.DAY_MS

    source_rows = 0
    rows_by_trade_type: dict[str, int] = {}
    liquidation_rows = 0
    rows_side_inconsistent = 0
    liq_micro_total = 0
    sums: pd.DataFrame | None = None

    for batch in pf.iter_batches(batch_size=ft.BATCH_ROWS, columns=list(COLUMNS)):
        n = batch.num_rows
        if n == 0:
            continue
        source_rows += n

        ts_col = batch.column("timestamp")
        if ts_col.null_count:
            raise ft.FoldError("timestamp has null values")
        ts = ts_col.to_numpy(zero_copy_only=False).astype(np.int64)

        outside = int(np.count_nonzero((ts < day_start) | (ts >= day_end)))
        if outside:
            raise ft.FoldError(
                f"{raw_path.name}: {outside} rows have a timestamp outside the UTC day {day.isoformat()}"
            )

        trade_type_col = batch.column("trade_type")
        if trade_type_col.null_count:
            raise ft.FoldError("trade_type has null values")
        for entry in pc.value_counts(trade_type_col).to_pylist():
            k = str(entry["values"])
            rows_by_trade_type[k] = rows_by_trade_type.get(k, 0) + int(entry["counts"])

        is_liq = pc.equal(trade_type_col, LIQ_TYPE).to_numpy(zero_copy_only=False).astype(bool)
        n_liq = int(np.count_nonzero(is_liq))
        if n_liq == 0:
            continue

        liquidation_rows += n_liq

        liq_ts = ts[is_liq]
        liq_minute = liq_ts - (liq_ts % 60_000)

        market_col = batch.column("market_id")
        if market_col.null_count and bool(np.any(is_liq & market_col.is_null().to_numpy(zero_copy_only=False))):
            raise ft.FoldError("market_id is null on a liquidation row")
        liq_market = market_col.to_numpy(zero_copy_only=False).astype(np.int32)[is_liq]

        usdc_col = batch.column("usdc_amount")
        if usdc_col.null_count and bool(np.any(is_liq & usdc_col.is_null().to_numpy(zero_copy_only=False))):
            raise ft.FoldError("usdc_amount is null on a liquidation row")
        liq_usdc = usdc_col.to_numpy(zero_copy_only=False).astype(np.int64)[is_liq]

        maker_ask_col = batch.column("is_maker_ask")
        if maker_ask_col.null_count and bool(np.any(is_liq & maker_ask_col.is_null().to_numpy(zero_copy_only=False))):
            raise ft.FoldError("is_maker_ask is null on a liquidation row")
        is_maker_ask = pc.fill_null(maker_ask_col, False).to_numpy(zero_copy_only=False).astype(bool)[is_liq]

        pos_col = batch.column("taker_position_size_before")
        if pos_col.null_count and bool(np.any(is_liq & pos_col.is_null().to_numpy(zero_copy_only=False))):
            raise ft.FoldError("taker_position_size_before is null on a liquidation row")
        taker_pos = pos_col.to_numpy(zero_copy_only=False).astype(np.int64)[is_liq]

        # Side check: forced buy with taker_pos >= 0 or forced sell with taker_pos <= 0 is inconsistent.
        buy_inconsistent = is_maker_ask & (taker_pos >= 0)
        sell_inconsistent = (~is_maker_ask) & (taker_pos <= 0)
        inconsistent = buy_inconsistent | sell_inconsistent
        rows_side_inconsistent += int(np.count_nonzero(inconsistent))

        liq_micro_total += int(liq_usdc.sum(dtype=np.int64))

        zero_int64 = np.zeros(n_liq, dtype=np.int64)
        zero_int32 = np.zeros(n_liq, dtype=np.int32)
        one_int32 = np.ones(n_liq, dtype=np.int32)

        liq_sell_micro = np.where(~is_maker_ask, liq_usdc, zero_int64)
        liq_buy_micro = np.where(is_maker_ask, liq_usdc, zero_int64)
        n_liq_sell = np.where(~is_maker_ask, one_int32, zero_int32)
        n_liq_buy = np.where(is_maker_ask, one_int32, zero_int32)

        partial = (
            pd.DataFrame(
                {
                    "market_id": liq_market,
                    "minute": liq_minute,
                    "liq_sell_micro": liq_sell_micro,
                    "liq_buy_micro": liq_buy_micro,
                    "n_liq_sell": n_liq_sell,
                    "n_liq_buy": n_liq_buy,
                }
            )
            .groupby(["market_id", "minute"], sort=False)
            .sum()
        )

        if sums is None:
            sums = partial
        else:
            sums = pd.concat([sums, partial]).groupby(level=[0, 1]).sum()

    meta = pf.metadata
    if source_rows != meta.num_rows:
        raise ft.FoldError(f"read {source_rows} rows but the footer says {meta.num_rows}")

    if sums is None or len(sums) == 0:
        table = OUTPUT_SCHEMA.empty_table()
    else:
        sums = sums.sort_index()
        out = sums.reset_index()
        out_df = pd.DataFrame(
            {
                "market_id": out["market_id"].astype(np.int16),
                "minute": out["minute"].astype(np.int64),
                "liq_sell_usd": out["liq_sell_micro"].to_numpy(dtype=np.int64) / ft.MICRO,
                "liq_buy_usd": out["liq_buy_micro"].to_numpy(dtype=np.int64) / ft.MICRO,
                "n_liq_sell": out["n_liq_sell"].astype(np.int32),
                "n_liq_buy": out["n_liq_buy"].astype(np.int32),
            }
        )[OUTPUT_SCHEMA.names]
        table = pa.Table.from_pandas(out_df, schema=OUTPUT_SCHEMA, preserve_index=False)

    stats = {
        "source_rows": source_rows,
        "rows_by_trade_type": dict(sorted(rows_by_trade_type.items())),
        "liquidation_rows": liquidation_rows,
        "rows_side_inconsistent": rows_side_inconsistent,
        "rows_outside_day": 0,
        "output_rows": table.num_rows,
        "liq_usd_total": float(liq_micro_total / ft.MICRO),
    }
    return table, stats


def run(
    from_day: dt.date,
    to_day: dt.date,
    raw_dir: Path,
    out_dir: Path,
    keep_raw: bool = False,
    downloader: Callable[[str, Path], int] = ft.download,
) -> int:
    """Pass loop streaming and folding days sequentially."""
    check_day(from_day)
    check_day(to_day)
    if from_day > to_day:
        raise ft.FoldError(f"--from {from_day} is after --to {to_day}")

    raw_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    version_dir = out_dir / "v1"
    version_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.jsonl"

    day = from_day
    folded = 0
    skipped = 0

    while day <= to_day:
        out_file = version_dir / f"date={day.isoformat()}.parquet"
        manifest_records = read_manifest(manifest_path)
        if is_done(manifest_records.get(day.isoformat()), out_file):
            skipped += 1
            print(f"{day}: skipped (already done)", file=sys.stderr)
            day += dt.timedelta(days=1)
            continue

        check_day(day)
        began = time.monotonic()
        url = ft.source_url(day)
        raw_path = raw_dir / f"date={day.isoformat()}.parquet"

        try:
            downloader(url, raw_path)
            source_bytes = raw_path.stat().st_size
            table, stats = fold_day(raw_path, day)

            tmp_out = out_file.with_name(out_file.name + ".tmp")
            pq.write_table(table, tmp_out, compression="zstd")
            os.replace(tmp_out, out_file)

            elapsed_s = round(time.monotonic() - began, 2)
            record = {
                "date": day.isoformat(),
                "source_url": url,
                "source_bytes": source_bytes,
                "source_rows": stats["source_rows"],
                "rows_by_trade_type": stats["rows_by_trade_type"],
                "liquidation_rows": stats["liquidation_rows"],
                "rows_side_inconsistent": stats["rows_side_inconsistent"],
                "rows_outside_day": stats["rows_outside_day"],
                "output_rows": stats["output_rows"],
                "output_sha256": ft.sha256_file(out_file),
                "liq_usd_total": stats["liq_usd_total"],
                "fold_version": LIQ_FOLD_VERSION,
                "elapsed_s": elapsed_s,
                "completed_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            }
            append_manifest(manifest_path, record)
            if not keep_raw:
                raw_path.unlink(missing_ok=True)

            print(
                f"{day}: {stats['source_rows']:,} rows -> {stats['output_rows']:,} in {elapsed_s} s",
                file=sys.stderr,
            )
            folded += 1
        except Exception as exc:
            if not keep_raw:
                raw_path.unlink(missing_ok=True)
            print(f"error on {day}: {exc}", file=sys.stderr)
            if isinstance(exc, ft.FoldError):
                raise
            raise ft.FoldError(f"{day} failed: {exc}") from exc

        day += dt.timedelta(days=1)

    print(f"done: {folded} folded, {skipped} skipped", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for the liquidation-only fold pass."""
    parser = argparse.ArgumentParser(
        description="Liquidation-only pass over the public Lighter trade archive, with the forced side"
    )
    parser.add_argument("--from", dest="date_from", required=True, help="first UTC date, YYYY-MM-DD")
    parser.add_argument("--to", dest="date_to", required=True, help=f"last UTC date, inclusive, at most {LAST_DATE}")
    parser.add_argument("--raw-dir", type=Path, required=True, help="directory for raw downloaded files")
    parser.add_argument("--out-dir", type=Path, required=True, help="directory for output files and manifest")
    parser.add_argument("--keep-raw", action="store_true", help="keep each downloaded day file (default: delete)")

    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code is None or exc.code != 0 else 0

    try:
        from_day = ft.parse_date(args.date_from)
        check_day(from_day)
        to_day = ft.parse_date(args.date_to)
        check_day(to_day)
        if from_day > to_day:
            raise ft.FoldError(f"--from {from_day} is after --to {to_day}")
    except ft.FoldError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    try:
        return run(
            from_day,
            to_day,
            args.raw_dir,
            args.out_dir,
            keep_raw=args.keep_raw,
        )
    except DateGuardError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except ft.FoldError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
