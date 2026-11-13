"""Tests for horizon-e1 data reader, store, and file guards."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from horizon.e1 import data as data_mod


def make_kline_gz(
    path: Path,
    rows: list[list[int | float]],
    header: list[str] | None = None,
) -> tuple[str, int]:
    if header is None:
        header = [
            "open_time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "quote_volume",
            "trades",
            "taker_buy_base",
            "taker_buy_quote",
        ]
    lines = [",".join(header)]
    for r in rows:
        lines.append(",".join(str(x) for x in r))
    content = ("\n".join(lines) + "\n").encode("utf-8")
    raw = gzip.compress(content)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest(), len(raw)


def make_funding_gz(
    path: Path,
    rows: list[tuple[int, str, str]],
    header: list[str] | None = None,
) -> tuple[str, int]:
    if header is None:
        header = ["calc_time", "funding_interval_hours", "last_funding_rate"]
    lines = [",".join(header)]
    for t, inv, r in rows:
        lines.append(f"{t},{inv},{r}")
    content = ("\n".join(lines) + "\n").encode("utf-8")
    raw = gzip.compress(content)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest(), len(raw)


def write_manifest(manifest_path: Path, entries: list[dict]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e) + "\n")


def test_round_trip(tmp_path: Path):
    symbol = "BTCUSDT"
    day = "2024-01-01"
    day_start_ms = int(dt.datetime(2024, 1, 1, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)

    rows = []
    for i in range(5):
        t = day_start_ms + i * 60_000
        rows.append([t, 42000.0 + i, 42010.0 + i, 41990.0 + i, 42005.0 + i, 1.5 + i, 63000.0, 100, 0.8, 33600.0])

    kline_file = tmp_path / "klines" / symbol / f"{symbol}-1m-{day}.csv.gz"
    h, size = make_kline_gz(kline_file, rows)

    manifest_file = tmp_path / "manifest.jsonl"
    entry = {
        "kind": "klines",
        "symbol": symbol,
        "date": day,
        "status": "ok",
        "rows": 5,
        "firstTs": day_start_ms,
        "lastTs": day_start_ms + 4 * 60_000,
        "gaps": 0,
        "badRows": 0,
        "duplicates": 0,
        "sha256": h,
        "bytes": size,
    }
    write_manifest(manifest_file, [entry])

    store = data_mod.Store(tmp_path, verify_hashes=True)
    bars = store.klines(symbol, day)

    assert bars is not None
    assert len(bars) == 5
    assert bars.open_time.dtype == np.int64
    assert bars.open.dtype == np.float64
    assert bars.high.dtype == np.float64
    assert bars.low.dtype == np.float64
    assert bars.close.dtype == np.float64
    assert bars.volume.dtype == np.float64

    assert list(bars.open_time) == [day_start_ms + i * 60_000 for i in range(5)]
    assert list(bars.open) == [42000.0 + i for i in range(5)]
    assert list(bars.high) == [42010.0 + i for i in range(5)]
    assert list(bars.low) == [41990.0 + i for i in range(5)]
    assert list(bars.close) == [42005.0 + i for i in range(5)]
    assert list(bars.volume) == [1.5 + i for i in range(5)]

    rel_path = f"klines/{symbol}/{symbol}-1m-{day}.csv.gz"
    assert store.files_read() == {rel_path: h}


def test_guards(tmp_path: Path):
    symbol = "BTCUSDT"
    day = "2024-01-01"
    day_start_ms = int(dt.datetime(2024, 1, 1, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)

    # 1. Missing manifest file
    empty_dir = tmp_path / "empty_dir"
    empty_dir.mkdir()
    with pytest.raises(data_mod.DataError, match="manifest file missing"):
        data_mod.Store(empty_dir)

    # Prepare base dir with manifest
    data_dir = tmp_path / "data"
    manifest_file = data_dir / "manifest.jsonl"
    kline_file = data_dir / "klines" / symbol / f"{symbol}-1m-{day}.csv.gz"

    base_rows = [
        [day_start_ms, 40000.0, 40010.0, 39990.0, 40005.0, 1.0, 40000.0, 10, 0.5, 20000.0],
        [day_start_ms + 60_000, 40005.0, 40015.0, 39995.0, 40010.0, 1.0, 40000.0, 10, 0.5, 20000.0],
    ]
    h, size = make_kline_gz(kline_file, base_rows)

    entry = {
        "kind": "klines",
        "symbol": symbol,
        "date": day,
        "status": "ok",
        "rows": 2,
        "firstTs": day_start_ms,
        "lastTs": day_start_ms + 60_000,
        "gaps": 0,
        "badRows": 0,
        "duplicates": 0,
        "sha256": h,
        "bytes": size,
    }
    missing_entry = {
        "kind": "klines",
        "symbol": symbol,
        "date": "2024-01-02",
        "status": "missing",
        "rows": 0,
        "firstTs": None,
        "lastTs": None,
        "gaps": None,
        "badRows": 0,
        "duplicates": 0,
        "sha256": None,
        "bytes": 0,
    }
    write_manifest(manifest_file, [entry, missing_entry])

    # 2. File with no manifest line
    store = data_mod.Store(data_dir)
    with pytest.raises(data_mod.DataError, match="no manifest line"):
        store.klines("ETHUSDT", "2024-01-01")

    # 3. Manifest missing returns None
    assert store.klines(symbol, "2024-01-02") is None

    # 4. Day after hard last date (in klines and through bars)
    with pytest.raises(data_mod.DataError, match="after HARD_LAST_DATE"):
        store.klines(symbol, "2026-11-13")

    late_start_ms = int(dt.datetime(2026, 11, 12, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
    late_end_ms = int(dt.datetime(2026, 11, 13, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
    with pytest.raises(data_mod.DataError, match="after HARD_LAST_DATE"):
        store.bars(symbol, late_start_ms, late_end_ms)

    # 5. sha256 mismatch
    bad_hash_entry = dict(entry)
    bad_hash_entry["sha256"] = "0000000000000000000000000000000000000000000000000000000000000000"
    write_manifest(manifest_file, [bad_hash_entry])
    store_bad_hash = data_mod.Store(data_dir, verify_hashes=True)
    with pytest.raises(data_mod.DataError, match="sha256 mismatch"):
        store_bad_hash.klines(symbol, day)

    # 6. Header mismatch
    bad_header_dir = tmp_path / "bad_header"
    bad_h_file = bad_header_dir / "klines" / symbol / f"{symbol}-1m-{day}.csv.gz"
    bh_h, bh_sz = make_kline_gz(
        bad_h_file,
        base_rows,
        header=["open_time", "open", "wrong_col", "low", "close", "volume", "qv", "tr", "tbb", "tbq"],
    )
    write_manifest(
        bad_header_dir / "manifest.jsonl",
        [
            {
                "kind": "klines",
                "symbol": symbol,
                "date": day,
                "status": "ok",
                "rows": 2,
                "firstTs": day_start_ms,
                "lastTs": day_start_ms + 60_000,
                "gaps": 0,
                "badRows": 0,
                "duplicates": 0,
                "sha256": bh_h,
                "bytes": bh_sz,
            }
        ],
    )
    store_bh = data_mod.Store(bad_header_dir)
    with pytest.raises(data_mod.DataError, match="header mismatch"):
        store_bh.klines(symbol, day)

    # 7. Row outside the day
    outside_dir = tmp_path / "outside_dir"
    outside_file = outside_dir / "klines" / symbol / f"{symbol}-1m-{day}.csv.gz"
    outside_rows = [
        [day_start_ms - 60_000, 40000.0, 40010.0, 39990.0, 40005.0, 1.0, 40000.0, 10, 0.5, 20000.0],
    ]
    out_h, out_sz = make_kline_gz(outside_file, outside_rows)
    write_manifest(
        outside_dir / "manifest.jsonl",
        [
            {
                "kind": "klines",
                "symbol": symbol,
                "date": day,
                "status": "ok",
                "rows": 1,
                "firstTs": day_start_ms - 60_000,
                "lastTs": day_start_ms - 60_000,
                "gaps": 0,
                "badRows": 0,
                "duplicates": 0,
                "sha256": out_h,
                "bytes": out_sz,
            }
        ],
    )
    store_out = data_mod.Store(outside_dir)
    with pytest.raises(data_mod.DataError, match="outside UTC day"):
        store_out.klines(symbol, day)

    # 8. Duplicate open_time
    dup_dir = tmp_path / "dup_dir"
    dup_file = dup_dir / "klines" / symbol / f"{symbol}-1m-{day}.csv.gz"
    dup_rows = [
        [day_start_ms, 40000.0, 40010.0, 39990.0, 40005.0, 1.0, 40000.0, 10, 0.5, 20000.0],
        [day_start_ms, 40005.0, 40015.0, 39995.0, 40010.0, 1.0, 40000.0, 10, 0.5, 20000.0],
    ]
    dup_h, dup_sz = make_kline_gz(dup_file, dup_rows)
    write_manifest(
        dup_dir / "manifest.jsonl",
        [
            {
                "kind": "klines",
                "symbol": symbol,
                "date": day,
                "status": "ok",
                "rows": 2,
                "firstTs": day_start_ms,
                "lastTs": day_start_ms,
                "gaps": 0,
                "badRows": 0,
                "duplicates": 1,
                "sha256": dup_h,
                "bytes": dup_sz,
            }
        ],
    )
    store_dup = data_mod.Store(dup_dir)
    with pytest.raises(data_mod.DataError, match="duplicate open_time"):
        store_dup.klines(symbol, day)

    # 9. Unsorted rows
    unsorted_dir = tmp_path / "unsorted_dir"
    unsorted_file = unsorted_dir / "klines" / symbol / f"{symbol}-1m-{day}.csv.gz"
    unsorted_rows = [
        [day_start_ms + 60_000, 40000.0, 40010.0, 39990.0, 40005.0, 1.0, 40000.0, 10, 0.5, 20000.0],
        [day_start_ms, 40005.0, 40015.0, 39995.0, 40010.0, 1.0, 40000.0, 10, 0.5, 20000.0],
    ]
    uns_h, uns_sz = make_kline_gz(unsorted_file, unsorted_rows)
    write_manifest(
        unsorted_dir / "manifest.jsonl",
        [
            {
                "kind": "klines",
                "symbol": symbol,
                "date": day,
                "status": "ok",
                "rows": 2,
                "firstTs": day_start_ms + 60_000,
                "lastTs": day_start_ms,
                "gaps": 0,
                "badRows": 0,
                "duplicates": 0,
                "sha256": uns_h,
                "bytes": uns_sz,
            }
        ],
    )
    store_uns = data_mod.Store(unsorted_dir)
    with pytest.raises(data_mod.DataError, match="unsorted rows"):
        store_uns.klines(symbol, day)


def test_bars_across_days_with_missing_middle(tmp_path: Path):
    symbol = "SOLUSDT"
    d1 = "2024-01-01"
    d2 = "2024-01-02"
    d3 = "2024-01-03"

    t1_0 = int(dt.datetime(2024, 1, 1, 10, 0, tzinfo=dt.UTC).timestamp() * 1000)
    t1_1 = t1_0 + 60_000
    t3_0 = int(dt.datetime(2024, 1, 3, 10, 0, tzinfo=dt.UTC).timestamp() * 1000)
    t3_1 = t3_0 + 60_000

    f1 = tmp_path / "klines" / symbol / f"{symbol}-1m-{d1}.csv.gz"
    h1, sz1 = make_kline_gz(
        f1,
        [
            [t1_0, 100.0, 101.0, 99.0, 100.5, 5.0, 500.0, 20, 2.5, 250.0],
            [t1_1, 100.5, 102.0, 100.0, 101.5, 6.0, 600.0, 25, 3.0, 300.0],
        ],
    )

    f3 = tmp_path / "klines" / symbol / f"{symbol}-1m-{d3}.csv.gz"
    h3, sz3 = make_kline_gz(
        f3,
        [
            [t3_0, 110.0, 111.0, 109.0, 110.5, 7.0, 770.0, 30, 3.5, 385.0],
            [t3_1, 110.5, 112.0, 110.0, 111.5, 8.0, 890.0, 35, 4.0, 445.0],
        ],
    )

    entries = [
        {
            "kind": "klines",
            "symbol": symbol,
            "date": d1,
            "status": "ok",
            "rows": 2,
            "firstTs": t1_0,
            "lastTs": t1_1,
            "gaps": 0,
            "badRows": 0,
            "duplicates": 0,
            "sha256": h1,
            "bytes": sz1,
        },
        {
            "kind": "klines",
            "symbol": symbol,
            "date": d2,
            "status": "missing",
            "rows": 0,
            "firstTs": None,
            "lastTs": None,
            "gaps": None,
            "badRows": 0,
            "duplicates": 0,
            "sha256": None,
            "bytes": 0,
        },
        {
            "kind": "klines",
            "symbol": symbol,
            "date": d3,
            "status": "ok",
            "rows": 2,
            "firstTs": t3_0,
            "lastTs": t3_1,
            "gaps": 0,
            "badRows": 0,
            "duplicates": 0,
            "sha256": h3,
            "bytes": sz3,
        },
    ]
    write_manifest(tmp_path / "manifest.jsonl", entries)

    store = data_mod.Store(tmp_path)
    all_bars = store.bars(symbol, t1_0, t3_1)

    assert len(all_bars) == 4
    assert list(all_bars.open_time) == [t1_0, t1_1, t3_0, t3_1]

    # Inclusive slice bounds
    sub_bars = store.bars(symbol, t1_1, t3_0)
    assert len(sub_bars) == 2
    assert list(sub_bars.open_time) == [t1_1, t3_0]


def test_funding(tmp_path: Path):
    symbol = "BTCUSDT"
    m1 = "2026-10"
    m2 = "2026-11"

    t1_0 = int(dt.datetime(2026, 10, 15, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
    t1_1 = int(dt.datetime(2026, 10, 15, 8, 0, tzinfo=dt.UTC).timestamp() * 1000)

    # 2026-11 contains HARD_LAST_DATE (2026-11-12)
    # Day after is 2026-11-13 00:00 UTC = 1794528000000 ms
    t2_allowed = int(dt.datetime(2026, 11, 12, 16, 0, tzinfo=dt.UTC).timestamp() * 1000)
    t2_at_limit = int(dt.datetime(2026, 11, 13, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
    t2_after_limit = int(dt.datetime(2026, 11, 13, 8, 0, tzinfo=dt.UTC).timestamp() * 1000)

    f1_file = tmp_path / "funding" / symbol / f"{symbol}-fundingRate-{m1}.csv.gz"
    # Empty interval field for first row, text 0.00010000 parsed to 1e-4
    h1, sz1 = make_funding_gz(
        f1_file,
        [
            (t1_0, "", "0.00010000"),
            (t1_1, "8", "0.00015000"),
        ],
    )

    f2_file = tmp_path / "funding" / symbol / f"{symbol}-fundingRate-{m2}.csv.gz"
    h2, sz2 = make_funding_gz(
        f2_file,
        [
            (t2_allowed, "8", "0.00020000"),
            (t2_at_limit, "8", "0.00025000"),
            (t2_after_limit, "8", "0.00030000"),
        ],
    )

    entries = [
        {
            "kind": "funding",
            "symbol": symbol,
            "date": m1,
            "status": "ok",
            "rows": 2,
            "firstTs": t1_0,
            "lastTs": t1_1,
            "gaps": 0,
            "badRows": 0,
            "duplicates": 0,
            "sha256": h1,
            "bytes": sz1,
        },
        {
            "kind": "funding",
            "symbol": symbol,
            "date": m2,
            "status": "ok",
            "rows": 3,
            "firstTs": t2_allowed,
            "lastTs": t2_after_limit,
            "gaps": 0,
            "badRows": 0,
            "duplicates": 0,
            "sha256": h2,
            "bytes": sz2,
        },
    ]
    write_manifest(tmp_path / "manifest.jsonl", entries)

    store = data_mod.Store(tmp_path)

    # 1. Check funding_month for m2: rows at or after 2026-11-13 are dropped at read time
    fm2 = store.funding_month(symbol, m2)
    assert fm2 is not None
    assert len(fm2) == 1
    assert list(fm2.calc_time) == [t2_allowed]
    assert list(fm2.rate) == [0.0002]

    # 2. Check funding() merged series with [start_ms, end_ms] restriction
    f_all = store.funding(symbol, t1_0, t2_allowed)
    assert len(f_all) == 3
    assert list(f_all.calc_time) == [t1_0, t1_1, t2_allowed]

    # Empty interval is NaN
    assert np.isnan(f_all.interval_hours[0])
    assert f_all.interval_hours[1] == 8.0

    # Raw text 0.00010000 parsed to 1e-4
    assert f_all.rate[0] == 1e-4

    # Restriction window
    f_sub = store.funding(symbol, t1_1, t2_allowed)
    assert len(f_sub) == 2
    assert list(f_sub.calc_time) == [t1_1, t2_allowed]

    # 3. Duplicate calc_time raises
    dup_dir = tmp_path / "dup_funding"
    dup_file = dup_dir / "funding" / symbol / f"{symbol}-fundingRate-{m1}.csv.gz"
    dup_h, dup_sz = make_funding_gz(
        dup_file,
        [
            (t1_0, "8", "0.0001"),
            (t1_0, "8", "0.0001"),
        ],
    )
    write_manifest(
        dup_dir / "manifest.jsonl",
        [
            {
                "kind": "funding",
                "symbol": symbol,
                "date": m1,
                "status": "ok",
                "rows": 2,
                "firstTs": t1_0,
                "lastTs": t1_0,
                "gaps": 0,
                "badRows": 0,
                "duplicates": 1,
                "sha256": dup_h,
                "bytes": dup_sz,
            }
        ],
    )
    store_dup = data_mod.Store(dup_dir)
    with pytest.raises(data_mod.DataError, match="duplicate calc_time"):
        store_dup.funding_month(symbol, m1)


def test_bars_index_of_and_slice():
    times = np.array([10_000, 30_000, 50_000], dtype=np.int64)
    vals = np.array([1.0, 2.0, 3.0], dtype=np.float64)
    b = data_mod.Bars(
        open_time=times,
        open=vals,
        high=vals,
        low=vals,
        close=vals,
        volume=vals,
    )

    # index_of
    assert b.index_of(10_000) == 0
    assert b.index_of(30_000) == 1
    assert b.index_of(50_000) == 2
    assert b.index_of(20_000) == -1
    assert b.index_of(5_000) == -1
    assert b.index_of(60_000) == -1

    # slice_ms on array with a gap
    s1 = b.slice_ms(15_000, 45_000)
    assert list(s1.open_time) == [30_000]

    s2 = b.slice_ms(10_000, 30_000)
    assert list(s2.open_time) == [10_000, 30_000]

    s3 = b.slice_ms(35_000, 45_000)
    assert len(s3) == 0

    empty = data_mod.Bars.empty()
    assert len(empty) == 0
    assert empty.index_of(10_000) == -1
    assert len(empty.slice_ms(0, 10_000)) == 0


def test_one_letter_symbol_is_read(tmp_path: Path):
    """The D token trades as DUSDT: a one-letter ticker must pass the symbol guard and read back exactly."""
    day = "2026-01-02"
    day_start_ms = int(dt.datetime(2026, 1, 2, tzinfo=dt.UTC).timestamp() * 1000)
    rows = [[day_start_ms + i * 60_000, 0.5, 0.6, 0.4, 0.55, 10.0, 5.0, 3, 1.0, 0.5] for i in range(3)]
    path = tmp_path / "klines" / "DUSDT" / f"DUSDT-1m-{day}.csv.gz"
    h, size = make_kline_gz(path, rows)
    entry = {"kind": "klines", "symbol": "DUSDT", "date": day, "status": "ok", "rows": 3, "sha256": h, "bytes": size}
    write_manifest(tmp_path / "manifest.jsonl", [entry])
    bars = data_mod.Store(tmp_path).klines("DUSDT", day)
    assert bars is not None
    assert list(bars.open) == [0.5, 0.5, 0.5]
    with pytest.raises(data_mod.DataError, match="invalid symbol"):
        data_mod.Store(tmp_path).klines("USDT", day)


def test_plan_problems(tmp_path: Path):
    """A planned file must have an ok manifest line with no duplicates and no bad rows (rule 2, rule 13)."""
    ok = {"kind": "klines", "symbol": "AAAUSDT", "date": "2026-03-01", "status": "ok", "duplicates": 0, "badRows": 0}
    missing = {"kind": "klines", "symbol": "BBBUSDT", "date": "2026-03-01", "status": "missing"}
    dup = {"kind": "klines", "symbol": "CCCUSDT", "date": "2026-03-01", "status": "ok", "duplicates": 2, "badRows": 0}
    bad = {"kind": "funding", "symbol": "AAAUSDT", "date": "2026-03", "status": "ok", "duplicates": 0, "badRows": 1}
    fine = {"kind": "funding", "symbol": "BBBUSDT", "date": "2026-03", "status": "ok"}
    gap = {"kind": "funding", "symbol": "CCCUSDT", "date": "2026-03", "status": "missing"}
    write_manifest(tmp_path / "manifest.jsonl", [ok, missing, dup, bad, fine, gap])
    store = data_mod.Store(tmp_path)
    plan = {
        "version": 1,
        "klines": [
            {"symbol": "AAAUSDT", "day": "2026-03-01"},
            {"symbol": "BBBUSDT", "day": "2026-03-01"},
            {"symbol": "CCCUSDT", "day": "2026-03-01"},
            {"symbol": "DDDUSDT", "day": "2026-03-01"},
        ],
        "funding": [
            {"symbol": "AAAUSDT", "month": "2026-03"},
            {"symbol": "BBBUSDT", "month": "2026-03"},
            {"symbol": "CCCUSDT", "month": "2026-03"},
        ],
    }
    problems = store.plan_problems(plan)
    assert problems == [
        "klines BBBUSDT 2026-03-01: manifest status 'missing'",
        "klines CCCUSDT 2026-03-01: manifest records 2 duplicates and 0 bad rows",
        "klines DDDUSDT 2026-03-01: no manifest line",
        "funding AAAUSDT 2026-03: manifest records 0 duplicates and 1 bad rows",
    ]
    # A funding month the archive does not have is a funding gap (rule 7), never a stop
    assert store.plan_problems({"version": 1, "klines": [], "funding": [plan["funding"][2]]}) == []
    assert store.plan_problems({"version": 1, "klines": [plan["klines"][0]], "funding": [plan["funding"][1]]}) == []
