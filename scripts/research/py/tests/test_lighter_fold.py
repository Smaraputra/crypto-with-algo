"""Tests for the Lighter trade fold: scripts/research/py/lighter/fold_trades.py.

Synthetic Parquet inputs only, no network calls (the download and orderBooks hooks are replaced), no files outside
tmp_path.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import urllib.error
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from lighter import fold_trades as ft

DAY = dt.date(2025, 1, 20)
D0 = ft.day_start_ms(DAY)
M = 60_000


def trade(i, ts, market=1, price=1000, usd=100.0, taker_buys=True, kind="trade", size=None):
    """One source row. usd is in dollars; size x price == usdc_amount as in the real archive when size is None."""
    micro = int(round(usd * 1_000_000))
    return {
        "id": i,
        "timestamp": ts,
        "market_id": market,
        "price": price,
        "size": micro // price if size is None else size,
        "usdc_amount": micro,
        "is_maker_ask": taker_buys,
        "trade_type": kind,
    }


def write_raw(path: Path, rows, extra_cols=True, drop=None, row_group_size=None):
    cols = {
        "id": pa.array([r["id"] for r in rows], pa.int64()),
        "timestamp": pa.array([r["timestamp"] for r in rows], pa.int64()),
        "market_id": pa.array([r["market_id"] for r in rows], pa.int16()),
        "price": pa.array([r["price"] for r in rows], pa.int64()),
        "size": pa.array([r["size"] for r in rows], pa.int64()),
        "usdc_amount": pa.array([r["usdc_amount"] for r in rows], pa.int64()),
        "is_maker_ask": pa.array([r["is_maker_ask"] for r in rows], pa.bool_()),
        "trade_type": pa.array([r["trade_type"] for r in rows], pa.string()),
    }
    if extra_cols:
        cols["tx_hash"] = pa.array(["0x"] * len(rows), pa.string())
        cols["ask_fee"] = pa.array([None] * len(rows), pa.int64())
    for name in drop or []:
        del cols[name]
    pq.write_table(pa.table(cols), path, row_group_size=row_group_size)


def fold(tmp_path, rows, **kw):
    raw = tmp_path / "raw.parquet"
    write_raw(raw, rows, **kw)
    table, stats = ft.fold_file(raw, DAY)
    return table.to_pandas(), stats


def one(df, market=1, minute=D0):
    sel = df[(df.market_id == market) & (df.minute == minute)]
    assert len(sel) == 1
    return sel.iloc[0]


def test_buy_sell_encoding_from_is_maker_ask(tmp_path):
    df, _ = fold(
        tmp_path,
        [
            trade(1, D0 + 1000, usd=10, taker_buys=True),
            trade(2, D0 + 2000, usd=30, taker_buys=False),
        ],
    )
    row = one(df)
    assert row.buy_usd == 10.0
    assert row.sell_usd == 30.0
    assert row.last_buy_ts == D0 + 1000
    assert row.last_sell_ts == D0 + 2000
    assert row.n_trades == 2


def test_fill_delay_edge(tmp_path):
    rows = [
        trade(1, D0 + 499, price=111, taker_buys=True),
        trade(2, D0 + 500, price=222, taker_buys=True),
        trade(3, D0 + 499, price=333, taker_buys=False),
        trade(4, D0 + M + 499, price=444, taker_buys=False),
    ]
    df, _ = fold(tmp_path, rows)
    first = one(df)
    assert ft.FILL_DELAY_MS == 500
    assert first.first_buy_px == 222 and first.first_buy_ts == D0 + 500
    assert first.last_buy_px == 222
    # The only sell in minute 0 is at +499 ms: no fill print, but it is still the last sell.
    assert pd.isna(first.first_sell_px)
    assert first.last_sell_px == 333
    # Minute 1: a sell at m + 499 ms is not a fill print either.
    second = one(df, minute=D0 + M)
    assert second.last_sell_px == 444
    assert pd.isna(second.first_sell_ts)


def test_ordering_by_timestamp_then_id_when_unsorted(tmp_path):
    rows = [
        trade(9, D0 + 5000, price=300),
        trade(2, D0 + 5000, price=200),
        trade(5, D0 + 1000, price=100),
        trade(7, D0 + 9000, price=400, taker_buys=False),
        trade(3, D0 + 9000, price=500, taker_buys=False),
    ]
    df, _ = fold(tmp_path, rows)
    row = one(df)
    # Latest timestamp wins (sell ids 3 and 7 tie, id 7 is later).
    assert row.last_px == 400
    assert row.last_buy_px == 300  # ts tie at +5000, id 9 after id 2
    assert row.first_buy_px == 100
    assert row.first_sell_px == 500  # ts tie at +9000, id 3 first


def test_batching_does_not_change_the_result(tmp_path, monkeypatch):
    rows = [
        trade(i, D0 + (i * 7919) % (3 * M), market=1 + i % 3, price=1000 + i, usd=5 + i * 13.5, taker_buys=i % 2 == 0)
        for i in range(1, 400)
    ]
    rows[10]["trade_type"] = "liquidation"
    big, _ = fold(tmp_path, rows)
    monkeypatch.setattr(ft, "BATCH_ROWS", 7)
    small, _ = fold(tmp_path, rows)
    assert big.equals(small)


def test_band_boundaries(tmp_path):
    prints = [
        (1, 999.999999, True),
        (2, 1000.0, True),
        (3, 9999.999999, True),
        (4, 10000.0, True),
        (5, 99999.999999, True),
        (6, 100000.0, True),
        (7, 999.0, False),
        (8, 1000.0, False),
        (9, 100000.0, False),
    ]
    rows = [trade(i, D0 + 1000 + i, usd=usd, taker_buys=b) for i, usd, b in prints]
    row = one(fold(tmp_path, rows)[0])
    assert row.buy_usd_lt_1k == pytest.approx(999.999999)
    assert row.buy_usd_1k_10k == pytest.approx(1000.0 + 9999.999999)
    assert row.buy_usd_10k_100k == pytest.approx(10000.0 + 99999.999999)
    assert row.buy_usd_ge_100k == 100000.0
    assert row.sell_usd_lt_1k == 999.0
    assert row.sell_usd_1k_10k == 1000.0
    assert row.sell_usd_10k_100k == 0.0
    assert row.sell_usd_ge_100k == 100000.0
    buy_bands = row.buy_usd_lt_1k + row.buy_usd_1k_10k + row.buy_usd_10k_100k + row.buy_usd_ge_100k
    assert buy_bands == pytest.approx(row.buy_usd)


def test_liquidations_count_in_liq_usd_but_never_print(tmp_path):
    rows = [
        trade(1, D0 + 1000, price=100, usd=50, taker_buys=True),
        trade(2, D0 + 2000, price=999, usd=70_000, taker_buys=True, kind="liquidation"),
        trade(3, D0 + 3000, price=998, usd=20, taker_buys=False, kind="liquidation"),
        trade(4, D0 + M + 1000, price=555, usd=40, taker_buys=False, kind="liquidation"),
    ]
    df, stats = fold(tmp_path, rows)
    row = one(df)
    assert row.liq_usd == pytest.approx(70_020.0)
    assert row.buy_usd == 50.0 and row.sell_usd == 0.0
    assert row.last_px == 100 and row.last_buy_px == 100
    assert row.vwap_px == 100.0
    assert row.n_trades == 3
    assert row.buy_usd_ge_100k == 0.0 and row.buy_usd_10k_100k == 0.0
    # A minute with only liquidations still gets a row, with no prices.
    only_liq = one(df, minute=D0 + M)
    assert only_liq.liq_usd == 40.0 and only_liq.n_trades == 1
    assert pd.isna(only_liq.last_px) and pd.isna(only_liq.vwap_px)
    assert stats["rows_by_trade_type"] == {"liquidation": 3, "trade": 1}


def test_vwap_is_usd_weighted(tmp_path):
    rows = [
        trade(1, D0 + 1000, price=100, usd=100, taker_buys=True),
        trade(2, D0 + 2000, price=200, usd=300, taker_buys=False),
    ]
    row = one(fold(tmp_path, rows)[0])
    assert row.vwap_px == pytest.approx((100 * 100 + 200 * 300) / 400)


def test_usd_total_is_conserved_and_output_is_sorted(tmp_path):
    rows = [
        trade(
            i, D0 + (i * 104_729) % (90 * M), market=m, usd=1.234567 * i, kind="liquidation" if i % 11 == 0 else "trade"
        )
        for i, m in [(i, 5 - i % 3) for i in range(1, 200)]
    ]
    df, stats = fold(tmp_path, rows)
    assert stats["source_rows"] == 199 and df.n_trades.sum() == 199
    assert stats["source_usdc_micro"] == sum(r["usdc_amount"] for r in rows)
    assert (df.buy_usd + df.sell_usd + df.liq_usd).sum() == pytest.approx(stats["source_usdc_micro"] / 1e6)
    keys = list(zip(df.market_id, df.minute, strict=True))
    assert keys == sorted(keys) and len(set(keys)) == len(keys)


def test_size_price_mismatch_is_counted_not_enforced(tmp_path):
    rows = [trade(1, D0 + 1000, usd=10), trade(2, D0 + 2000, usd=10, size=1)]
    _, stats = fold(tmp_path, rows)
    assert stats["rows_size_price_mismatch"] == 1


def test_missing_required_column_fails_clearly(tmp_path):
    raw = tmp_path / "raw.parquet"
    write_raw(raw, [trade(1, D0 + 1000)], drop=["usdc_amount"])
    with pytest.raises(ft.FoldError, match="missing required columns.*usdc_amount"):
        ft.fold_file(raw, DAY)


def test_null_in_required_column_fails(tmp_path):
    raw = tmp_path / "raw.parquet"
    write_raw(raw, [trade(1, D0 + 1000)])
    t = pq.read_table(raw)
    t = t.set_column(t.schema.get_field_index("price"), "price", pa.array([None], pa.int64()))
    pq.write_table(t, raw)
    with pytest.raises(ft.FoldError, match="price has 1 nulls"):
        ft.fold_file(raw, DAY)


def test_timestamp_unit_change_fails(tmp_path):
    raw = tmp_path / "raw.parquet"
    write_raw(raw, [trade(1, 1_737_331_200)])  # seconds, not milliseconds
    with pytest.raises(ft.FoldError, match="plausible millisecond range"):
        ft.fold_file(raw, DAY)


def test_file_with_rows_after_the_guard_fails(tmp_path):
    raw = tmp_path / "raw.parquet"
    day = ft.FOLD_LAST_DATE
    after = ft.day_start_ms(day) + ft.DAY_MS + 5
    write_raw(raw, [trade(1, after)])
    with pytest.raises(ft.FoldError, match="reserved forward sample"):
        ft.fold_file(raw, day)


def test_rows_outside_the_day_fail_the_day(tmp_path):
    raw = tmp_path / "raw.parquet"
    write_raw(raw, [trade(1, D0 + 1000), trade(2, D0 - 1000), trade(3, D0 + ft.DAY_MS)])
    with pytest.raises(ft.FoldError, match="2 rows have a timestamp outside the UTC day"):
        ft.fold_file(raw, DAY)


def test_rows_on_the_day_edges_are_inside(tmp_path):
    _, stats = fold(tmp_path, [trade(1, D0), trade(2, D0 + ft.DAY_MS - 1)])
    assert stats["rows_outside_day"] == 0


def test_empty_file_gives_empty_table(tmp_path):
    df, stats = fold(tmp_path, [])
    assert len(df) == 0 and stats["source_rows"] == 0


def test_output_schema(tmp_path):
    raw = tmp_path / "raw.parquet"
    write_raw(raw, [trade(1, D0 + 1000)])
    table, _ = ft.fold_file(raw, DAY)
    assert table.schema.equals(ft.OUTPUT_SCHEMA)
    assert table.schema.field("market_id").type == pa.int16()


# ---- date guard -----------------------------------------------------------------------------------------------


def test_date_guard_refuses_dates_after_the_last_fold_date():
    assert ft.FOLD_LAST_DATE == dt.date(2026, 10, 31)
    ft.check_date(dt.date(2026, 10, 31))
    with pytest.raises(ft.FoldError, match="reserved forward sample"):
        ft.check_date(dt.date(2026, 11, 1))
    with pytest.raises(ft.FoldError, match="before the first archive day"):
        ft.check_date(dt.date(2025, 1, 16))
    with pytest.raises(ft.FoldError):
        ft.source_url(dt.date(2026, 11, 1))


def test_cli_refuses_late_dates_without_touching_the_network(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("network must not be used")

    monkeypatch.setattr(ft, "_urlopen", boom)
    rc = ft.main(
        [
            "--from",
            "2026-10-31",
            "--to",
            "2026-11-01",
            "--raw-dir",
            str(tmp_path / "r"),
            "--out-dir",
            str(tmp_path / "o"),
        ]
    )
    assert rc == 2
    assert not (tmp_path / "o" / "markets.json").exists()


def test_fold_day_itself_refuses_late_dates(tmp_path):
    with pytest.raises(ft.FoldError):
        ft.fold_day(dt.date(2026, 11, 2), tmp_path / "r", tmp_path / "o")


# ---- download, resumability, manifest -------------------------------------------------------------------------


class FakeResp(io.BytesIO):
    def __init__(self, data: bytes, length: int | None):
        super().__init__(data)
        self.headers = {} if length is None else {"Content-Length": str(length)}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def no_sleep(monkeypatch):
    monkeypatch.setattr(ft, "_sleep", lambda s: None)


def test_download_checks_content_length_and_retries(tmp_path, monkeypatch, no_sleep):
    payload = b"x" * 5000
    calls = []

    def fake(req, timeout=0):
        calls.append(1)
        if len(calls) == 1:
            return FakeResp(payload[:100], len(payload))  # truncated
        if len(calls) == 2:
            raise urllib.error.URLError("reset")
        return FakeResp(payload, len(payload))

    monkeypatch.setattr(ft, "_urlopen", fake)
    dest = tmp_path / "d" / "f.parquet"
    assert ft.download("https://x/y", dest, chunk=1024) == 5000
    assert dest.read_bytes() == payload and len(calls) == 3
    assert not dest.with_name("f.parquet.part").exists()


def test_download_gives_up_and_leaves_no_file(tmp_path, monkeypatch, no_sleep):
    monkeypatch.setattr(ft, "_urlopen", lambda req, timeout=0: FakeResp(b"abc", 10))
    dest = tmp_path / "f.parquet"
    with pytest.raises(ft.DownloadError, match="incomplete download"):
        ft.download("https://x/y", dest, retries=3)
    assert not dest.exists() and not dest.with_name("f.parquet.part").exists()


def test_download_does_not_retry_a_404(tmp_path, monkeypatch, no_sleep):
    calls = []

    def fake(req, timeout=0):
        calls.append(1)
        raise urllib.error.HTTPError("https://x", 404, "nope", {}, None)

    monkeypatch.setattr(ft, "_urlopen", fake)
    with pytest.raises(ft.DownloadError, match="HTTP 404"):
        ft.download("https://x/y", tmp_path / "f")
    assert len(calls) == 1


def test_download_requires_content_length(tmp_path, monkeypatch, no_sleep):
    monkeypatch.setattr(ft, "_urlopen", lambda req, timeout=0: FakeResp(b"abc", None))
    with pytest.raises(ft.DownloadError, match="Content-Length"):
        ft.download("https://x/y", tmp_path / "f", retries=2)


@pytest.fixture
def archive(monkeypatch, tmp_path):
    """Replace the network: each day is served from a synthetic file, orderBooks from a stub."""
    served: list[str] = []
    rows = [
        trade(1, D0 + 1000, market=1, price=100, usd=10, taker_buys=True),
        trade(2, D0 + 2000, market=2, price=200, usd=20, taker_buys=False),
        trade(3, D0 + 3000, market=2, price=210, usd=5, taker_buys=True, kind="liquidation"),
    ]

    def fake_download(url, dest, **kw):
        served.append(url)
        day = dt.date.fromisoformat(url.split("date=")[1].split("/")[0])
        shift = ft.day_start_ms(day) - D0
        dest.parent.mkdir(parents=True, exist_ok=True)
        write_raw(dest, [{**r, "timestamp": r["timestamp"] + shift} for r in rows])
        return dest.stat().st_size

    monkeypatch.setattr(ft, "download", fake_download)
    monkeypatch.setattr(ft, "fetch_order_books", lambda: {"order_books": [{"symbol": "ETH", "market_id": 0}]})
    return served


def read_lines(path):
    return [json.loads(x) for x in path.read_text().splitlines()]


def test_run_writes_output_manifest_markets_and_deletes_raw(tmp_path, archive):
    raw, out = tmp_path / "raw", tmp_path / "out"
    assert ft.run(DAY, DAY, raw, out) == 0
    out_file = out / "v1" / "date=2025-01-20.parquet"
    assert out_file.is_file() and list(raw.iterdir()) == []
    [rec] = read_lines(out / "manifest.jsonl")
    assert rec["date"] == "2025-01-20" and rec["fold_version"] == "v1"
    assert rec["source_rows"] == 3 and rec["output_rows"] == 2
    assert rec["rows_by_trade_type"] == {"liquidation": 1, "trade": 2}
    assert rec["output_sha256"] == ft.sha256_file(out_file)
    assert rec["source_bytes"] > 0 and rec["elapsed_s"] >= 0
    assert rec["source_url"].endswith("date=2025-01-20/trades.parquet")
    markets = json.loads((out / "markets.json").read_text())
    assert markets["order_books"][0]["symbol"] == "ETH" and "fetched_at" in markets
    assert pq.read_table(out_file).num_rows == 2


def test_keep_raw_keeps_the_download(tmp_path, archive):
    ft.run(DAY, DAY, tmp_path / "raw", tmp_path / "out", keep_raw=True)
    assert len(list((tmp_path / "raw").iterdir())) == 1


def test_second_run_skips_and_corrupt_output_is_redone(tmp_path, archive):
    raw, out = tmp_path / "raw", tmp_path / "out"
    ft.run(DAY, DAY, raw, out)
    assert len(archive) == 1
    ft.run(DAY, DAY, raw, out)
    assert len(archive) == 1 and len(read_lines(out / "manifest.jsonl")) == 1

    out_file = out / "v1" / "date=2025-01-20.parquet"
    good = out_file.read_bytes()
    out_file.write_bytes(good[:-20] + b"corrupted-bytes-here")
    ft.run(DAY, DAY, raw, out)
    assert len(archive) == 2
    assert out_file.read_bytes() == good
    assert ft.sha256_file(out_file) == read_lines(out / "manifest.jsonl")[-1]["output_sha256"]
    assert len(read_lines(out / "manifest.jsonl")) == 2

    out_file.unlink()
    ft.run(DAY, DAY, raw, out)
    assert len(archive) == 3 and out_file.is_file()


def test_other_fold_version_in_manifest_is_redone(tmp_path, archive, monkeypatch):
    raw, out = tmp_path / "raw", tmp_path / "out"
    ft.run(DAY, DAY, raw, out)
    monkeypatch.setattr(ft, "FOLD_VERSION", "v0")
    out_file = out / "v0" / "date=2025-01-20.parquet"
    assert not ft.is_done(ft.read_manifest(out / "manifest.jsonl").get("2025-01-20"), out_file)


def test_torn_manifest_line_is_ignored(tmp_path, archive):
    raw, out = tmp_path / "raw", tmp_path / "out"
    ft.run(DAY, DAY, raw, out)
    with open(out / "manifest.jsonl", "a") as fh:
        fh.write('{"date": "2025-01-21", "output_')
    assert set(ft.read_manifest(out / "manifest.jsonl")) == {"2025-01-20"}


def test_unreadable_leftover_raw_file_is_downloaded_again(tmp_path, archive):
    raw, out = tmp_path / "raw", tmp_path / "out"
    raw.mkdir()
    (raw / "date=2025-01-20.trades.parquet").write_bytes(b"not parquet")
    ft.run(DAY, DAY, raw, out)
    assert len(archive) == 1


def test_multi_day_range_and_bad_range(tmp_path, archive):
    ft.run(DAY, DAY + dt.timedelta(days=1), tmp_path / "raw", tmp_path / "out")
    assert len(archive) == 2
    with pytest.raises(ft.FoldError, match="after --to"):
        ft.run(DAY + dt.timedelta(days=1), DAY, tmp_path / "raw", tmp_path / "out")


def test_markets_json_is_written_once(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(ft, "fetch_order_books", lambda: calls.append(1) or {"order_books": []})
    assert ft.write_markets(tmp_path) is True
    assert ft.write_markets(tmp_path) is False and len(calls) == 1


def test_fold_day_deletes_raw_when_the_file_holds_rows_after_the_guard(tmp_path, monkeypatch):
    day = ft.FOLD_LAST_DATE
    src = tmp_path / "served.parquet"
    write_raw(src, [trade(1, ft.day_start_ms(day) + ft.DAY_MS + 5)])

    def fake_download(url, dest, **kw):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        return dest.stat().st_size

    monkeypatch.setattr(ft, "download", fake_download)
    raw_dir = tmp_path / "raw"
    with pytest.raises(ft.ForwardSampleError):
        ft.fold_day(day, raw_dir, tmp_path / "out", keep_raw=True)
    assert list(raw_dir.iterdir()) == []
    assert not (tmp_path / "out" / "manifest.jsonl").exists()


def test_fold_day_keeps_raw_when_the_day_fails_for_another_reason(tmp_path, monkeypatch):
    src = tmp_path / "served.parquet"
    write_raw(src, [trade(1, D0 + 1000), trade(2, D0 - 5)])

    def fake_download(url, dest, **kw):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        return dest.stat().st_size

    monkeypatch.setattr(ft, "download", fake_download)
    with pytest.raises(ft.FoldError, match="outside the UTC day"):
        ft.fold_day(DAY, tmp_path / "raw", tmp_path / "out")
    assert not (tmp_path / "out" / "v1").exists() or list((tmp_path / "out" / "v1").iterdir()) == []


LIVE_BOOK = {
    "symbol": "ETH",
    "market_id": 0,
    "market_type": "perp",
    "status": "active",
    "supported_price_decimals": 2,
    "supported_size_decimals": 4,
    "min_base_amount": "0.0050",
    "min_quote_amount": "10.000000",
    "created_at": "1700000000000",
    "maker_fee": "0.0000",
    "taker_fee": "0.0000",
    "open_interest": "123.4",
    "open_interest_usd": "99999.9",
    "last_trade_price": "3500.1",
    "daily_volume": "5",
}


def test_markets_json_keeps_only_static_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "fetch_order_books", lambda: {"order_books": [LIVE_BOOK]})
    assert ft.write_markets(tmp_path) is True
    doc = json.loads((tmp_path / "markets.json").read_text())
    assert doc["markets_file_version"] == ft.MARKETS_FILE_VERSION and "fetched_at" in doc
    [book] = doc["order_books"]
    assert set(book) == set(ft.MARKET_FIELDS)
    assert book["symbol"] == "ETH" and book["created_at"] == "1700000000000"
    assert "open_interest" not in json.dumps(doc)


def test_unversioned_markets_json_is_cleaned_in_place(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "fetch_order_books", lambda: pytest.fail("no refetch needed"))
    old = {"fetched_at": "2026-11-10T00:00:00+00:00", "source": ft.ORDER_BOOKS_URL, "order_books": [LIVE_BOOK]}
    (tmp_path / "markets.json").write_text(json.dumps(old))
    assert ft.write_markets(tmp_path) is True
    doc = json.loads((tmp_path / "markets.json").read_text())
    assert doc["fetched_at"] == "2026-11-10T00:00:00+00:00"
    assert doc["markets_file_version"] == ft.MARKETS_FILE_VERSION
    assert set(doc["order_books"][0]) == set(ft.MARKET_FIELDS)
    # A second call leaves the cleaned file alone.
    assert ft.write_markets(tmp_path) is False


def test_unreadable_markets_json_is_refetched(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "fetch_order_books", lambda: {"order_books": [LIVE_BOOK]})
    (tmp_path / "markets.json").write_text("{not json")
    assert ft.write_markets(tmp_path) is True
    assert json.loads((tmp_path / "markets.json").read_text())["order_books"][0]["symbol"] == "ETH"
