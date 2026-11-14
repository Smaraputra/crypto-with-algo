"""Tests for horizon.l1.fold_liq: liquidation-only pass over the Lighter trade archive."""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from horizon.l1 import fold_liq
from lighter import fold_trades as ft

DAY = dt.date(2025, 1, 20)
D0 = ft.day_start_ms(DAY)
M = 60_000


def make_row(
    timestamp: int,
    market_id: int = 1,
    usdc_amount: int = 1_000_000,
    is_maker_ask: bool = True,
    trade_type: str = "liquidation",
    taker_position_size_before: int = -100,
) -> dict[str, Any]:
    return {
        "timestamp": timestamp,
        "market_id": market_id,
        "usdc_amount": usdc_amount,
        "is_maker_ask": is_maker_ask,
        "trade_type": trade_type,
        "taker_position_size_before": taker_position_size_before,
    }


def write_raw(path: Path, rows: list[dict[str, Any]], extra_cols: bool = True) -> Path:
    cols: dict[str, Any] = {
        "timestamp": pa.array([r["timestamp"] for r in rows], pa.int64()),
        "market_id": pa.array([r["market_id"] for r in rows], pa.int16()),
        "usdc_amount": pa.array([r["usdc_amount"] for r in rows], pa.int64()),
        "is_maker_ask": pa.array([r["is_maker_ask"] for r in rows], pa.bool_()),
        "trade_type": pa.array([r["trade_type"] for r in rows], pa.string()),
        "taker_position_size_before": pa.array([r["taker_position_size_before"] for r in rows], pa.int64()),
    }
    if extra_cols:
        cols["price"] = pa.array([1000] * len(rows), pa.int64())
        cols["tx_hash"] = pa.array(["0xfeed"] * len(rows), pa.string())
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table(cols), path)
    return path


def test_two_minutes_two_markets_exact_aggregation(tmp_path: Path) -> None:
    # Two minutes, two markets, forced sells and forced buys with known micro values.
    # Out of order to verify sorting: market 2 before market 1, minute 1 before minute 0.
    rows = [
        # Market 2, Minute 1: forced sell, 500,000 micro (0.5 USD), taker_pos = 10
        make_row(D0 + M + 1000, market_id=2, usdc_amount=500_000, is_maker_ask=False, taker_position_size_before=10),
        # Market 1, Minute 0: forced buy, 1,000,000 micro (1.0 USD), taker_pos = -20
        make_row(D0 + 1000, market_id=1, usdc_amount=1_000_000, is_maker_ask=True, taker_position_size_before=-20),
        # Market 1, Minute 0: forced sell, 2,000,000 micro (2.0 USD), taker_pos = 40
        make_row(D0 + 2000, market_id=1, usdc_amount=2_000_000, is_maker_ask=False, taker_position_size_before=40),
        # Market 1, Minute 1: forced buy, 3,000,000 micro (3.0 USD), taker_pos = -60
        make_row(D0 + M + 1000, market_id=1, usdc_amount=3_000_000, is_maker_ask=True, taker_position_size_before=-60),
        # Market 1, Minute 1: forced buy, 4,000,000 micro (4.0 USD), taker_pos = -80
        make_row(D0 + M + 2000, market_id=1, usdc_amount=4_000_000, is_maker_ask=True, taker_position_size_before=-80),
        # Market 2, Minute 0: forced sell, 6,000,000 micro (6.0 USD), taker_pos = 120
        make_row(D0 + 1000, market_id=2, usdc_amount=6_000_000, is_maker_ask=False, taker_position_size_before=120),
        # Market 2, Minute 0: forced buy, 7,000,000 micro (7.0 USD), taker_pos = -140
        make_row(D0 + 2000, market_id=2, usdc_amount=7_000_000, is_maker_ask=True, taker_position_size_before=-140),
    ]
    raw_path = tmp_path / "raw.parquet"
    write_raw(raw_path, rows)
    table, stats = fold_liq.fold_day(raw_path, DAY)

    assert table.num_rows == 4
    # Sort order: (1, D0), (1, D0+M), (2, D0), (2, D0+M)
    assert table["market_id"].to_pylist() == [1, 1, 2, 2]
    assert table["minute"].to_pylist() == [D0, D0 + M, D0, D0 + M]
    assert table["liq_sell_usd"].to_pylist() == [2.0, 0.0, 6.0, 0.5]
    assert table["liq_buy_usd"].to_pylist() == [1.0, 7.0, 7.0, 0.0]
    assert table["n_liq_sell"].to_pylist() == [1, 0, 1, 1]
    assert table["n_liq_buy"].to_pylist() == [1, 2, 1, 0]

    # Schema dtypes
    assert table.schema.field("market_id").type == pa.int16()
    assert table.schema.field("minute").type == pa.int64()
    assert table.schema.field("liq_sell_usd").type == pa.float64()
    assert table.schema.field("liq_buy_usd").type == pa.float64()
    assert table.schema.field("n_liq_sell").type == pa.int32()
    assert table.schema.field("n_liq_buy").type == pa.int32()

    # Total USD: 0.5 + 1.0 + 2.0 + 3.0 + 4.0 + 6.0 + 7.0 = 23.5
    assert stats["liq_usd_total"] == 23.5
    assert stats["output_rows"] == 4
    assert stats["liquidation_rows"] == 7


def test_trade_types_filtered_and_counted(tmp_path: Path) -> None:
    # Ordinary trade rows not kept; other types counted and not kept
    rows = [
        make_row(D0 + 1000, market_id=1, trade_type="trade", usdc_amount=5_000_000),
        make_row(D0 + 2000, market_id=1, trade_type="deleverage", usdc_amount=3_000_000),
        make_row(D0 + 3000, market_id=1, trade_type="liquidation", usdc_amount=2_000_000, is_maker_ask=True),
    ]
    raw_path = tmp_path / "raw.parquet"
    write_raw(raw_path, rows)
    table, stats = fold_liq.fold_day(raw_path, DAY)

    assert table.num_rows == 1
    assert stats["source_rows"] == 3
    assert stats["rows_by_trade_type"] == {"deleverage": 1, "liquidation": 1, "trade": 1}
    assert stats["liquidation_rows"] == 1
    assert stats["liq_usd_total"] == 2.0
    assert table["liq_buy_usd"][0].as_py() == 2.0
    assert table["liq_sell_usd"][0].as_py() == 0.0


def test_side_consistency_check(tmp_path: Path) -> None:
    # Forced buy with taker_pos < 0 and forced sell with taker_pos > 0 are consistent.
    # One inconsistent row of each kind gives rows_side_inconsistent == 2.
    rows = [
        # Consistent forced buy (short covering): taker_pos < 0 (-50)
        make_row(D0 + 1000, is_maker_ask=True, taker_position_size_before=-50, usdc_amount=1_000_000),
        # Consistent forced sell (long closing): taker_pos > 0 (50)
        make_row(D0 + 2000, is_maker_ask=False, taker_position_size_before=50, usdc_amount=2_000_000),
        # Inconsistent forced buy: taker_pos >= 0 (10)
        make_row(D0 + 3000, is_maker_ask=True, taker_position_size_before=10, usdc_amount=3_000_000),
        # Inconsistent forced sell: taker_pos <= 0 (-10)
        make_row(D0 + 4000, is_maker_ask=False, taker_position_size_before=-10, usdc_amount=4_000_000),
    ]
    raw_path = tmp_path / "raw.parquet"
    write_raw(raw_path, rows)
    table, stats = fold_liq.fold_day(raw_path, DAY)

    assert stats["rows_side_inconsistent"] == 2
    assert stats["liquidation_rows"] == 4
    # All 4 rows stay in their respective sides
    assert table["liq_buy_usd"][0].as_py() == 4.0  # 1.0 + 3.0
    assert table["liq_sell_usd"][0].as_py() == 6.0  # 2.0 + 4.0
    assert table["n_liq_buy"][0].as_py() == 2
    assert table["n_liq_sell"][0].as_py() == 2


def test_row_outside_day_fails_and_raw_deletion(tmp_path: Path) -> None:
    # A row dated the next UTC day fails with FoldError; raw file deleted unless keep_raw
    next_day_ts = D0 + ft.DAY_MS + 1000
    rows = [make_row(next_day_ts)]
    src = tmp_path / "prepared.parquet"
    write_raw(src, rows)

    with pytest.raises(ft.FoldError, match=f"outside the UTC day {DAY.isoformat()}"):
        fold_liq.fold_day(src, DAY)

    raw_dir = tmp_path / "raw"
    out_dir = tmp_path / "out"

    def fake_download_copy(url: str, dest: Path) -> int:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        return dest.stat().st_size

    # With keep_raw=False: raw file is deleted on failure
    with pytest.raises(ft.FoldError, match=f"outside the UTC day {DAY.isoformat()}"):
        fold_liq.run(DAY, DAY, raw_dir, out_dir, keep_raw=False, downloader=fake_download_copy)

    target_raw = raw_dir / f"date={DAY.isoformat()}.parquet"
    assert not target_raw.exists()
    assert not (out_dir / "manifest.jsonl").exists()

    # With keep_raw=True: raw file is kept on failure
    with pytest.raises(ft.FoldError, match=f"outside the UTC day {DAY.isoformat()}"):
        fold_liq.run(DAY, DAY, raw_dir, out_dir, keep_raw=True, downloader=fake_download_copy)

    assert target_raw.exists()


def test_day_with_no_liquidation_rows(tmp_path: Path) -> None:
    # Day with no liquidation rows gives empty table with exact schema and manifest output_rows == 0
    rows = [make_row(D0 + 1000, trade_type="trade", usdc_amount=10_000_000)]
    src = tmp_path / "trade_only.parquet"
    write_raw(src, rows)

    table, stats = fold_liq.fold_day(src, DAY)
    assert table.num_rows == 0
    assert table.schema == fold_liq.OUTPUT_SCHEMA
    assert stats["source_rows"] == 1
    assert stats["liquidation_rows"] == 0
    assert stats["output_rows"] == 0
    assert stats["liq_usd_total"] == 0.0

    raw_dir = tmp_path / "raw"
    out_dir = tmp_path / "out"

    def fake_download_copy(url: str, dest: Path) -> int:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        return dest.stat().st_size

    ret = fold_liq.run(DAY, DAY, raw_dir, out_dir, keep_raw=False, downloader=fake_download_copy)
    assert ret == 0

    out_file = out_dir / "v1" / f"date={DAY.isoformat()}.parquet"
    assert out_file.exists()
    out_table = pq.read_table(out_file)
    assert out_table.num_rows == 0
    assert out_table.schema == fold_liq.OUTPUT_SCHEMA

    manifest = fold_liq.read_manifest(out_dir / "manifest.jsonl")
    assert DAY.isoformat() in manifest
    rec = manifest[DAY.isoformat()]
    assert rec["output_rows"] == 0
    assert rec["liquidation_rows"] == 0
    assert rec["liq_usd_total"] == 0.0
    assert rec["fold_version"] == fold_liq.LIQ_FOLD_VERSION


def test_resumability_and_redoing(tmp_path: Path) -> None:
    # Second run does not call downloader; manifest keeps one line per day;
    # deleting output or changing bytes redoes that day only.
    day1 = dt.date(2025, 1, 20)
    day2 = dt.date(2025, 1, 21)
    d1_ts = ft.day_start_ms(day1)
    d2_ts = ft.day_start_ms(day2)

    src1 = tmp_path / "src1.parquet"
    src2 = tmp_path / "src2.parquet"
    write_raw(src1, [make_row(d1_ts + 1000, market_id=1, usdc_amount=1_000_000)])
    write_raw(src2, [make_row(d2_ts + 1000, market_id=1, usdc_amount=2_000_000)])

    call_log: list[str] = []

    def fake_download(url: str, dest: Path) -> int:
        call_log.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if day1.isoformat() in url:
            dest.write_bytes(src1.read_bytes())
        else:
            dest.write_bytes(src2.read_bytes())
        return dest.stat().st_size

    raw_dir = tmp_path / "raw"
    out_dir = tmp_path / "out"

    # First run
    rc1 = fold_liq.run(day1, day2, raw_dir, out_dir, keep_raw=False, downloader=fake_download)
    assert rc1 == 0
    assert len(call_log) == 2
    assert len((out_dir / "manifest.jsonl").read_text().splitlines()) == 2

    # Second run does not call downloader
    rc2 = fold_liq.run(day1, day2, raw_dir, out_dir, keep_raw=False, downloader=fake_download)
    assert rc2 == 0
    assert len(call_log) == 2
    assert len((out_dir / "manifest.jsonl").read_text().splitlines()) == 2

    # Deleting output file for day1 redoes day1 only
    out1 = out_dir / "v1" / f"date={day1.isoformat()}.parquet"
    out1.unlink()
    rc3 = fold_liq.run(day1, day2, raw_dir, out_dir, keep_raw=False, downloader=fake_download)
    assert rc3 == 0
    assert len(call_log) == 3
    assert day1.isoformat() in call_log[-1]

    # Tampering with bytes of day2 redoes day2 only
    out2 = out_dir / "v1" / f"date={day2.isoformat()}.parquet"
    out2.write_bytes(b"corrupted_output")
    rc4 = fold_liq.run(day1, day2, raw_dir, out_dir, keep_raw=False, downloader=fake_download)
    assert rc4 == 0
    assert len(call_log) == 4
    assert day2.isoformat() in call_log[-1]


def test_date_guards_and_cli_exit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # check_day refuses 2026-07-01 and 2025-01-16, accepts 2026-06-30 and 2025-01-17
    fold_liq.check_day(dt.date(2026, 6, 30))
    fold_liq.check_day(dt.date(2025, 1, 17))

    with pytest.raises(ft.FoldError, match="after"):
        fold_liq.check_day(dt.date(2026, 7, 1))

    with pytest.raises(ft.FoldError, match="before"):
        fold_liq.check_day(dt.date(2025, 1, 16))

    # main returns 2 for a --to after 2026-06-30 and does not call downloader
    def fail_download(url: str, dest: Path) -> int:
        raise AssertionError("downloader should never be called when date guard triggers")

    monkeypatch.setattr(ft, "download", fail_download)

    argv = [
        "--from",
        "2025-01-17",
        "--to",
        "2026-07-01",
        "--raw-dir",
        str(tmp_path / "raw"),
        "--out-dir",
        str(tmp_path / "out"),
    ]
    rc = fold_liq.main(argv)
    assert rc == 2


def test_exactness_micro_usd_sum(tmp_path: Path) -> None:
    # Float 0.1 * 10 != 1.0. Micro USD integer accumulation: 100,000 * 10 = 1,000,000 -> 1.0 exactly.
    # 1 and 2 micro USD sum to 3 micro USD == 0.000003 USD.
    rows = [make_row(D0 + 1000 + i * 100, market_id=1, usdc_amount=100_000, is_maker_ask=True) for i in range(10)]
    rows.append(make_row(D0 + 2000, market_id=1, usdc_amount=1, is_maker_ask=False))
    rows.append(make_row(D0 + 2100, market_id=1, usdc_amount=2, is_maker_ask=False))

    raw_path = tmp_path / "exact.parquet"
    write_raw(raw_path, rows)
    table, stats = fold_liq.fold_day(raw_path, DAY)

    assert table.num_rows == 1
    assert table["liq_buy_usd"][0].as_py() == 1.0
    assert table["n_liq_buy"][0].as_py() == 10

    assert table["liq_sell_usd"][0].as_py() == 0.000003
    assert table["n_liq_sell"][0].as_py() == 2

    assert stats["liq_usd_total"] == 1.000003


def test_null_position_is_counted_unchecked_not_fatal(tmp_path: Path) -> None:
    """Early archive days have taker_position_size_before null: the side still comes from is_maker_ask."""
    rows = [
        make_row(D0 + 1000, usdc_amount=2_000_000, is_maker_ask=False, taker_position_size_before=40),
        make_row(D0 + 2000, usdc_amount=3_000_000, is_maker_ask=True, taker_position_size_before=-5),
        make_row(D0 + 3000, usdc_amount=5_000_000, is_maker_ask=False, taker_position_size_before=0),
    ]
    path = write_raw(tmp_path / "raw.parquet", rows)
    table = pq.read_table(path).to_pylist()
    for i in (0, 1):
        table[i]["taker_position_size_before"] = None
    schema = pa.schema(
        [
            (name, pa.int64() if name == "taker_position_size_before" else typ)
            for name, typ in zip(pq.read_schema(path).names, pq.read_schema(path).types, strict=True)
        ]
    )
    pq.write_table(pa.Table.from_pylist(table, schema=schema), path)

    out, stats = fold_liq.fold_day(path, DAY)
    assert stats["rows_side_unchecked"] == 2
    assert stats["rows_side_inconsistent"] == 1  # the third row: a forced sell with taker position 0 is inconsistent
    assert stats["liquidation_rows"] == 3
    row = out.to_pylist()[0]
    assert row["liq_sell_usd"] == pytest.approx(7.0, abs=1e-12)
    assert row["liq_buy_usd"] == pytest.approx(3.0, abs=1e-12)
    assert (row["n_liq_sell"], row["n_liq_buy"]) == (2, 1)
