"""Tests for horizon.l1.panel and horizon.l1.data."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from horizon.l1 import data as data_mod
from horizon.l1 import lock, panel

D1 = dt.date(2025, 1, 17)
D2 = dt.date(2025, 1, 18)
D3 = dt.date(2025, 1, 19)

D1_MS = int(dt.datetime(2025, 1, 17, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
D2_MS = int(dt.datetime(2025, 1, 18, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
D3_MS = int(dt.datetime(2025, 1, 19, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
HARD_END_MS = int(dt.datetime(2025, 1, 20, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
N_MIN = (HARD_END_MS - D1_MS) // 60_000


@pytest.fixture(autouse=True)
def patch_lock_span(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep test grid small across all tests."""
    monkeypatch.setattr(lock, "FOLD_FIRST_DATE", D1)
    monkeypatch.setattr(lock, "HARD_LAST_DATE", D3)
    monkeypatch.setattr(lock, "HARD_END_MS", HARD_END_MS)
    monkeypatch.setattr(data_mod, "GRID0_MS", D1_MS)
    monkeypatch.setattr(data_mod, "N_MIN", N_MIN)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_manifest_lines(path: Path, lines: list[dict[str, Any]]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "".join(json.dumps(r, sort_keys=True) + "\n" for r in lines).encode("utf-8")
    path.write_bytes(content)
    return sha256_bytes(content)


def make_fold_day(path: Path, rows: list[dict[str, Any]]) -> tuple[Path, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pydict(
        {
            "market_id": pa.array([r["market_id"] for r in rows], pa.int16()),
            "minute": pa.array([r["minute"] for r in rows], pa.int64()),
            "n_trades": pa.array([r.get("n_trades", 1) for r in rows], pa.int64()),
            "buy_usd": pa.array([r.get("buy_usd", 0.0) for r in rows], pa.float64()),
            "sell_usd": pa.array([r.get("sell_usd", 0.0) for r in rows], pa.float64()),
            "liq_usd": pa.array([r.get("liq_usd", 0.0) for r in rows], pa.float64()),
            "last_px": pa.array([r.get("last_px") for r in rows], pa.int64()),
            "vwap_px": pa.array([r.get("vwap_px", 0.0) for r in rows], pa.float64()),
            "last_buy_px": pa.array([r.get("last_buy_px") for r in rows], pa.int64()),
            "last_buy_ts": pa.array([r.get("last_buy_ts") for r in rows], pa.int64()),
            "last_sell_px": pa.array([r.get("last_sell_px") for r in rows], pa.int64()),
            "last_sell_ts": pa.array([r.get("last_sell_ts") for r in rows], pa.int64()),
            "first_buy_px": pa.array([r.get("first_buy_px") for r in rows], pa.int64()),
            "first_buy_ts": pa.array([r.get("first_buy_ts") for r in rows], pa.int64()),
            "first_sell_px": pa.array([r.get("first_sell_px") for r in rows], pa.int64()),
            "first_sell_ts": pa.array([r.get("first_sell_ts") for r in rows], pa.int64()),
        }
    )
    pq.write_table(table, path, compression="zstd")
    return path, panel.sha256_file(path)


def make_markets_json(path: Path, order_books: list[dict[str, Any]]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps({"order_books": order_books}, sort_keys=True).encode("utf-8")
    path.write_bytes(content)
    return sha256_bytes(content)


def make_liq_day(path: Path, rows: list[dict[str, Any]]) -> tuple[Path, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pydict(
        {
            "market_id": pa.array([r["market_id"] for r in rows], pa.int16()),
            "minute": pa.array([r["minute"] for r in rows], pa.int64()),
            "liq_sell_usd": pa.array([r.get("liq_sell_usd", 0.0) for r in rows], pa.float64()),
            "liq_buy_usd": pa.array([r.get("liq_buy_usd", 0.0) for r in rows], pa.float64()),
            "n_liq_sell": pa.array([r.get("n_liq_sell", 0) for r in rows], pa.int32()),
            "n_liq_buy": pa.array([r.get("n_liq_buy", 0) for r in rows], pa.int32()),
        }
    )
    pq.write_table(table, path, compression="zstd")
    return path, panel.sha256_file(path)


def make_funding_file(path: Path, rows: list[tuple[int, float]]) -> tuple[Path, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pydict(
        {
            "timestamp": pa.array([r[0] for r in rows], pa.int64()),
            "rate_long_pays": pa.array([r[1] for r in rows], pa.float64()),
        }
    )
    pq.write_table(table, path, compression="zstd")
    return path, panel.sha256_file(path)


def test_build_panel_round_trip(tmp_path: Path) -> None:
    fold_dir = tmp_path / "fold"
    panel_dir = tmp_path / "panel"

    markets = [
        {"market_id": 1, "symbol": "BTC", "market_type": "perp"},
        {"market_id": 2, "symbol": "ETH", "market_type": "perp"},
    ]
    markets_sha = make_markets_json(fold_dir / "markets.json", markets)

    d1_rows = [
        {"market_id": 1, "minute": D1_MS + 60_000, "buy_usd": 100.0, "sell_usd": 50.0, "last_px": 50000},
        {"market_id": 2, "minute": D1_MS + 120_000, "buy_usd": 200.0, "sell_usd": 0.0, "last_px": 3000},
    ]
    d2_rows = [
        {"market_id": 1, "minute": D2_MS, "buy_usd": 150.0, "sell_usd": 20.0, "last_px": None},
        {"market_id": 2, "minute": D2_MS + 60_000, "buy_usd": 0.0, "sell_usd": 50.0, "last_px": 3100},
    ]
    d3_rows = [
        {"market_id": 1, "minute": D3_MS + 60_000, "buy_usd": 50.0, "sell_usd": 10.0, "last_px": 50500},
        {"market_id": 2, "minute": D3_MS + 120_000, "buy_usd": 10.0, "sell_usd": 10.0, "last_px": 3200},
    ]

    _, sha1 = make_fold_day(fold_dir / "v1" / "date=2025-01-17.parquet", d1_rows)
    _, sha2 = make_fold_day(fold_dir / "v1" / "date=2025-01-18.parquet", d2_rows)
    _, sha3 = make_fold_day(fold_dir / "v1" / "date=2025-01-19.parquet", d3_rows)

    manifest_entries = [
        {"date": "2025-01-17", "fold_version": "v1", "output_sha256": sha1, "output_rows": 2},
        {"date": "2025-01-18", "fold_version": "v1", "output_sha256": sha2, "output_rows": 2},
        {"date": "2025-01-19", "fold_version": "v1", "output_sha256": sha3, "output_rows": 2},
    ]
    fold_manifest_sha = write_manifest_lines(fold_dir / "manifest.jsonl", manifest_entries)

    res = panel.build_panel(fold_dir, panel_dir)

    assert res["panel_version"] == "l1p1"
    assert res["days"] == 3
    assert res["first_date"] == "2025-01-17"
    assert res["last_date"] == "2025-01-19"
    assert res["fold_manifest_sha256"] == fold_manifest_sha
    assert res["markets_sha256"] == markets_sha
    assert res["scale_jumps"] == []

    p1 = panel_dir / "market=1.parquet"
    p2 = panel_dir / "market=2.parquet"
    assert p1.is_file()
    assert p2.is_file()

    expected_p1_sha = panel.sha256_file(p1)
    assert res["markets"]["1"]["rows"] == 3
    assert res["markets"]["1"]["sha256"] == expected_p1_sha
    assert res["markets"]["1"]["first_minute"] == D1_MS + 60_000
    assert res["markets"]["1"]["last_minute"] == D3_MS + 60_000

    tbl1 = pq.read_table(p1)
    assert tbl1.column_names == ["minute", *panel.FOLD_COLS]
    assert "market_id" not in tbl1.column_names
    assert tbl1["minute"].to_pylist() == [D1_MS + 60_000, D2_MS, D3_MS + 60_000]
    assert tbl1["buy_usd"].to_pylist() == [100.0, 150.0, 50.0]
    assert tbl1["last_px"].to_pylist() == [50000, None, 50500]

    with pytest.raises(panel.PanelError, match="already holds panel files"):
        panel.build_panel(fold_dir, panel_dir)


def test_scale_check_and_filtering(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fold_dir = tmp_path / "fold"
    panel_dir = tmp_path / "panel"

    make_markets_json(
        fold_dir / "markets.json",
        [{"market_id": 1, "symbol": "BTC", "market_type": "perp"}],
    )

    jump_minute = D3_MS + 60_000
    d1_rows = [{"market_id": 1, "minute": D1_MS, "last_px": 1000}]
    d2_rows = [{"market_id": 1, "minute": D2_MS, "last_px": None}]
    d3_rows = [{"market_id": 1, "minute": jump_minute, "last_px": 10000}]

    _, sha1 = make_fold_day(fold_dir / "v1" / "date=2025-01-17.parquet", d1_rows)
    _, sha2 = make_fold_day(fold_dir / "v1" / "date=2025-01-18.parquet", d2_rows)
    _, sha3 = make_fold_day(fold_dir / "v1" / "date=2025-01-19.parquet", d3_rows)

    manifest_entries = [
        {"date": "2025-01-17", "fold_version": "v1", "output_sha256": sha1, "output_rows": 1},
        {"date": "2025-01-18", "fold_version": "v1", "output_sha256": sha2, "output_rows": 1},
        {"date": "2025-01-19", "fold_version": "v1", "output_sha256": sha3, "output_rows": 1},
    ]
    write_manifest_lines(fold_dir / "manifest.jsonl", manifest_entries)

    res = panel.build_panel(fold_dir, panel_dir)
    assert len(res["scale_jumps"]) == 1
    jump = res["scale_jumps"][0]
    assert jump[0] == 1
    assert jump[1] == jump_minute
    assert jump[2] == pytest.approx(math.log(10.0))

    monkeypatch.setattr(lock, "KNOWN_SCALE_JUMPS", ((1, jump_minute),))
    panel_dir_filtered = tmp_path / "panel_filtered"
    res_filtered = panel.build_panel(fold_dir, panel_dir_filtered)
    assert res_filtered["scale_jumps"] == []


def test_fold_guards(tmp_path: Path) -> None:
    fold_dir = tmp_path / "fold"
    panel_dir = tmp_path / "panel"

    make_markets_json(
        fold_dir / "markets.json",
        [{"market_id": 1, "symbol": "BTC", "market_type": "perp"}],
    )

    d1_rows = [{"market_id": 1, "minute": D1_MS}]
    d2_rows = [{"market_id": 1, "minute": D2_MS}]
    d3_rows = [{"market_id": 1, "minute": D3_MS}]

    f1, sha1 = make_fold_day(fold_dir / "v1" / "date=2025-01-17.parquet", d1_rows)
    f2, sha2 = make_fold_day(fold_dir / "v1" / "date=2025-01-18.parquet", d2_rows)
    f3, sha3 = make_fold_day(fold_dir / "v1" / "date=2025-01-19.parquet", d3_rows)

    manifest_path = fold_dir / "manifest.jsonl"

    # 1. Missing manifest line for 2025-01-18
    write_manifest_lines(
        manifest_path,
        [
            {"date": "2025-01-17", "fold_version": "v1", "output_sha256": sha1, "output_rows": 1},
            {"date": "2025-01-19", "fold_version": "v1", "output_sha256": sha3, "output_rows": 1},
        ],
    )
    with pytest.raises(panel.PanelError, match="2025-01-18"):
        panel.build_panel(fold_dir, panel_dir)

    # 2. Wrong sha256 for 2025-01-17
    write_manifest_lines(
        manifest_path,
        [
            {"date": "2025-01-17", "fold_version": "v1", "output_sha256": "wrong_sha", "output_rows": 1},
            {"date": "2025-01-18", "fold_version": "v1", "output_sha256": sha2, "output_rows": 1},
            {"date": "2025-01-19", "fold_version": "v1", "output_sha256": sha3, "output_rows": 1},
        ],
    )
    with pytest.raises(panel.PanelError, match="2025-01-17"):
        panel.build_panel(fold_dir, panel_dir)

    # 3. Day file missing for 2025-01-19
    f3.unlink()
    write_manifest_lines(
        manifest_path,
        [
            {"date": "2025-01-17", "fold_version": "v1", "output_sha256": sha1, "output_rows": 1},
            {"date": "2025-01-18", "fold_version": "v1", "output_sha256": sha2, "output_rows": 1},
            {"date": "2025-01-19", "fold_version": "v1", "output_sha256": sha3, "output_rows": 1},
        ],
    )
    with pytest.raises(panel.PanelError, match="2025-01-19"):
        panel.build_panel(fold_dir, panel_dir)

    # 4. Minute outside day for 2025-01-18
    make_fold_day(f3, d3_rows)
    bad_d2_rows = [{"market_id": 1, "minute": D1_MS}]
    _, bad_sha2 = make_fold_day(f2, bad_d2_rows)
    write_manifest_lines(
        manifest_path,
        [
            {"date": "2025-01-17", "fold_version": "v1", "output_sha256": sha1, "output_rows": 1},
            {"date": "2025-01-18", "fold_version": "v1", "output_sha256": bad_sha2, "output_rows": 1},
            {"date": "2025-01-19", "fold_version": "v1", "output_sha256": sha3, "output_rows": 1},
        ],
    )
    with pytest.raises(panel.PanelError, match="2025-01-18"):
        panel.build_panel(fold_dir, panel_dir)


def test_store_market_grid_and_dtypes(tmp_path: Path) -> None:
    fold_dir = tmp_path / "fold"
    panel_dir = tmp_path / "panel"
    liq_dir = tmp_path / "liq"
    funding_dir = tmp_path / "funding"

    make_markets_json(
        fold_dir / "markets.json",
        [
            {"market_id": 1, "symbol": "BTC", "market_type": "perp"},
            {"market_id": 2, "symbol": "ETH", "market_type": "perp"},
            {"market_id": 3, "symbol": "SOL-SPOT", "market_type": "spot"},
        ],
    )

    m1_min = D1_MS + 60_000
    d1_rows = [
        {
            "market_id": 1,
            "minute": m1_min,
            "buy_usd": 100.0,
            "sell_usd": 50.0,
            "last_px": 50000,
            "last_buy_px": 50010,
            "last_buy_ts": m1_min + 1000,
            "last_sell_px": 49990,
            "last_sell_ts": m1_min + 1500,
            "first_buy_px": 50005,
            "first_buy_ts": m1_min + 600,
            "first_sell_px": 49995,
            "first_sell_ts": m1_min + 700,
        },
        {"market_id": 3, "minute": m1_min, "buy_usd": 10.0, "sell_usd": 0.0, "last_px": 200},
    ]
    d2_rows = [
        {
            "market_id": 1,
            "minute": D2_MS,
            "buy_usd": 0.0,
            "sell_usd": 0.0,
            "last_px": None,
        }
    ]
    d3_rows = [
        {
            "market_id": 1,
            "minute": D3_MS,
            "buy_usd": 0.0,
            "sell_usd": 0.0,
            "last_px": 51000,
        }
    ]

    _, s1 = make_fold_day(fold_dir / "v1" / "date=2025-01-17.parquet", d1_rows)
    _, s2 = make_fold_day(fold_dir / "v1" / "date=2025-01-18.parquet", d2_rows)
    _, s3 = make_fold_day(fold_dir / "v1" / "date=2025-01-19.parquet", d3_rows)

    write_manifest_lines(
        fold_dir / "manifest.jsonl",
        [
            {"date": "2025-01-17", "fold_version": "v1", "output_sha256": s1, "output_rows": 2},
            {"date": "2025-01-18", "fold_version": "v1", "output_sha256": s2, "output_rows": 1},
            {"date": "2025-01-19", "fold_version": "v1", "output_sha256": s3, "output_rows": 1},
        ],
    )
    panel.build_panel(fold_dir, panel_dir)

    l1_rows = [
        {
            "market_id": 1,
            "minute": m1_min,
            "liq_sell_usd": 75.0,
            "liq_buy_usd": 0.0,
            "n_liq_sell": 3,
            "n_liq_buy": 0,
        }
    ]
    _, ls1 = make_liq_day(liq_dir / "v1" / "date=2025-01-17.parquet", l1_rows)
    _, ls2 = make_liq_day(liq_dir / "v1" / "date=2025-01-18.parquet", [])
    _, ls3 = make_liq_day(liq_dir / "v1" / "date=2025-01-19.parquet", [])

    write_manifest_lines(
        liq_dir / "manifest.jsonl",
        [
            {
                "date": "2025-01-17",
                "fold_version": "l1v1",
                "output_sha256": ls1,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 1,
            },
            {
                "date": "2025-01-18",
                "fold_version": "l1v1",
                "output_sha256": ls2,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-19",
                "fold_version": "l1v1",
                "output_sha256": ls3,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
        ],
    )

    write_manifest_lines(
        funding_dir / "manifest.jsonl",
        [
            {
                "market_id": 1,
                "status": "ok",
                "first_ts": D1_MS // 1000,
                "last_ts": D3_MS // 1000,
                "rows": 1,
                "confirmed_missing_hours": 0,
            }
        ],
    )

    store = data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)
    assert store.market_ids() == [1]

    # Spot market refused
    with pytest.raises(data_mod.DataError, match="spot"):
        store.market(3)

    m1 = store.market(1)
    assert m1.market_id == 1
    assert m1.symbol == "BTC"
    assert m1.market_type == "perp"

    # Dtypes
    assert m1.present.dtype == bool
    assert m1.buy_usd.dtype == np.float64
    assert m1.sell_usd.dtype == np.float64
    assert m1.last_px.dtype == np.float64
    assert m1.last_buy_px.dtype == np.float64
    assert m1.last_buy_ts.dtype == np.float64
    assert m1.last_sell_px.dtype == np.float64
    assert m1.last_sell_ts.dtype == np.float64
    assert m1.first_buy_px.dtype == np.float64
    assert m1.first_buy_ts.dtype == np.float64
    assert m1.first_sell_px.dtype == np.float64
    assert m1.first_sell_ts.dtype == np.float64
    assert m1.liq_sell_usd.dtype == np.float64
    assert m1.liq_buy_usd.dtype == np.float64
    assert m1.n_liq_sell.dtype == np.int32
    assert m1.n_liq_buy.dtype == np.int32
    assert m1.active.dtype == bool

    # Index 1 (m1_min)
    idx1 = m1.index_of(m1_min)
    assert idx1 == 1
    assert bool(m1.present[idx1])
    assert m1.buy_usd[idx1] == 100.0
    assert m1.sell_usd[idx1] == 50.0
    assert m1.last_px[idx1] == 50000.0
    assert m1.last_buy_px[idx1] == 50010.0
    assert m1.last_buy_ts[idx1] == float(m1_min + 1000)
    assert m1.last_sell_px[idx1] == 49990.0
    assert m1.last_sell_ts[idx1] == float(m1_min + 1500)
    assert m1.first_buy_px[idx1] == 50005.0
    assert m1.first_buy_ts[idx1] == float(m1_min + 600)
    assert m1.first_sell_px[idx1] == 49995.0
    assert m1.first_sell_ts[idx1] == float(m1_min + 700)
    assert m1.liq_sell_usd[idx1] == 75.0
    assert m1.liq_buy_usd[idx1] == 0.0
    assert m1.n_liq_sell[idx1] == 3
    assert m1.n_liq_buy[idx1] == 0
    assert bool(m1.active[idx1])

    # Index 0 (absent minute)
    assert not bool(m1.present[0])
    assert m1.buy_usd[0] == 0.0
    assert m1.sell_usd[0] == 0.0
    assert np.isnan(m1.last_px[0])
    assert np.isnan(m1.last_buy_px[0])
    assert m1.liq_sell_usd[0] == 0.0
    assert m1.n_liq_sell[0] == 0
    assert not bool(m1.active[0])

    # Day 2 minute (D2_MS) with null price
    idx_d2 = m1.index_of(D2_MS)
    assert bool(m1.present[idx_d2])
    assert np.isnan(m1.last_px[idx_d2])
    assert not bool(m1.active[idx_d2])

    # Round trip
    assert m1.index_of(m1.ms_of(5)) == 5
    assert m1.ms_of(0) == D1_MS

    # Out of range
    with pytest.raises(data_mod.DataError):
        m1.index_of(D1_MS - 60_000)
    with pytest.raises(data_mod.DataError):
        m1.index_of(HARD_END_MS)
    with pytest.raises(data_mod.DataError):
        m1.ms_of(-1)
    with pytest.raises(data_mod.DataError):
        m1.ms_of(N_MIN)


def test_store_guards(tmp_path: Path) -> None:
    fold_dir = tmp_path / "fold"
    panel_dir = tmp_path / "panel"
    liq_dir = tmp_path / "liq"
    funding_dir = tmp_path / "funding"

    make_markets_json(
        fold_dir / "markets.json",
        [{"market_id": 1, "symbol": "BTC", "market_type": "perp"}],
    )

    d1_rows = [{"market_id": 1, "minute": D1_MS, "last_px": 100}]
    _, s1 = make_fold_day(fold_dir / "v1" / "date=2025-01-17.parquet", d1_rows)
    _, s2 = make_fold_day(fold_dir / "v1" / "date=2025-01-18.parquet", [])
    _, s3 = make_fold_day(fold_dir / "v1" / "date=2025-01-19.parquet", [])

    write_manifest_lines(
        fold_dir / "manifest.jsonl",
        [
            {"date": "2025-01-17", "fold_version": "v1", "output_sha256": s1, "output_rows": 1},
            {"date": "2025-01-18", "fold_version": "v1", "output_sha256": s2, "output_rows": 0},
            {"date": "2025-01-19", "fold_version": "v1", "output_sha256": s3, "output_rows": 0},
        ],
    )
    panel.build_panel(fold_dir, panel_dir)

    _, ls1 = make_liq_day(liq_dir / "v1" / "date=2025-01-17.parquet", [])
    _, ls2 = make_liq_day(liq_dir / "v1" / "date=2025-01-18.parquet", [])
    _, ls3 = make_liq_day(liq_dir / "v1" / "date=2025-01-19.parquet", [])

    write_manifest_lines(
        liq_dir / "manifest.jsonl",
        [
            {
                "date": "2025-01-17",
                "fold_version": "l1v1",
                "output_sha256": ls1,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-18",
                "fold_version": "l1v1",
                "output_sha256": ls2,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-19",
                "fold_version": "l1v1",
                "output_sha256": ls3,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
        ],
    )
    write_manifest_lines(funding_dir / "manifest.jsonl", [])

    panel_manifest_path = panel_dir / "panel_manifest.json"
    orig_panel_manifest_text = panel_manifest_path.read_text(encoding="utf-8")

    # 1. Panel manifest with different fold manifest hash
    bad_manifest = json.loads(orig_panel_manifest_text)
    bad_manifest["fold_manifest_sha256"] = "different_sha"
    panel_manifest_path.write_text(json.dumps(bad_manifest), encoding="utf-8")
    with pytest.raises(data_mod.DataError, match="fold_manifest_sha256 mismatch"):
        data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)

    # 2. Non-empty scale_jumps
    bad_manifest = json.loads(orig_panel_manifest_text)
    bad_manifest["scale_jumps"] = [[1, D1_MS, 2.5]]
    panel_manifest_path.write_text(json.dumps(bad_manifest), encoding="utf-8")
    with pytest.raises(data_mod.DataError, match="unresolved scale jumps"):
        data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)

    # Restore panel manifest
    panel_manifest_path.write_text(orig_panel_manifest_text, encoding="utf-8")

    # 3. Tampered panel file
    p1 = panel_dir / "market=1.parquet"
    p1_bytes = p1.read_bytes()
    p1.write_bytes(p1_bytes + b"\x00")
    store = data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)
    with pytest.raises(data_mod.DataError, match="sha256 mismatch for panel"):
        store.market(1)
    p1.write_bytes(p1_bytes)

    # 4. Liquidation day with bad sha256
    write_manifest_lines(
        liq_dir / "manifest.jsonl",
        [
            {
                "date": "2025-01-17",
                "fold_version": "l1v1",
                "output_sha256": ls1,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-18",
                "fold_version": "l1v1",
                "output_sha256": "bad_sha",
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-19",
                "fold_version": "l1v1",
                "output_sha256": ls3,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
        ],
    )
    with pytest.raises(data_mod.DataError, match="2025-01-18"):
        data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)

    # 5. Liquidation line with rows_side_inconsistent > 0
    write_manifest_lines(
        liq_dir / "manifest.jsonl",
        [
            {
                "date": "2025-01-17",
                "fold_version": "l1v1",
                "output_sha256": ls1,
                "rows_side_inconsistent": 1,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-18",
                "fold_version": "l1v1",
                "output_sha256": ls2,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-19",
                "fold_version": "l1v1",
                "output_sha256": ls3,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
        ],
    )
    with pytest.raises(data_mod.DataError, match="2025-01-17"):
        data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)

    # 6. Liquidation line dated after lock.HARD_LAST_DATE (ignored, not opened)
    future_file = liq_dir / "v1" / "date=2025-01-20.parquet"
    future_file.write_bytes(b"corrupt non-parquet content")
    write_manifest_lines(
        liq_dir / "manifest.jsonl",
        [
            {
                "date": "2025-01-17",
                "fold_version": "l1v1",
                "output_sha256": ls1,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-18",
                "fold_version": "l1v1",
                "output_sha256": ls2,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-19",
                "fold_version": "l1v1",
                "output_sha256": ls3,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-20",
                "fold_version": "l1v1",
                "output_sha256": "any",
                "rows_side_inconsistent": 99,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
        ],
    )
    clean_store = data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)
    read_files = clean_store.files_read()
    assert not any("2025-01-20" in k for k in read_files)


def test_funding(tmp_path: Path) -> None:
    fold_dir = tmp_path / "fold"
    panel_dir = tmp_path / "panel"
    liq_dir = tmp_path / "liq"
    funding_dir = tmp_path / "funding"

    make_markets_json(
        fold_dir / "markets.json",
        [
            {"market_id": 1, "symbol": "BTC", "market_type": "perp"},
            {"market_id": 2, "symbol": "ETH", "market_type": "perp"},
        ],
    )

    _, s1 = make_fold_day(fold_dir / "v1" / "date=2025-01-17.parquet", [])
    _, s2 = make_fold_day(fold_dir / "v1" / "date=2025-01-18.parquet", [])
    _, s3 = make_fold_day(fold_dir / "v1" / "date=2025-01-19.parquet", [])
    write_manifest_lines(
        fold_dir / "manifest.jsonl",
        [
            {"date": "2025-01-17", "fold_version": "v1", "output_sha256": s1, "output_rows": 0},
            {"date": "2025-01-18", "fold_version": "v1", "output_sha256": s2, "output_rows": 0},
            {"date": "2025-01-19", "fold_version": "v1", "output_sha256": s3, "output_rows": 0},
        ],
    )
    panel.build_panel(fold_dir, panel_dir)

    _, ls1 = make_liq_day(liq_dir / "v1" / "date=2025-01-17.parquet", [])
    _, ls2 = make_liq_day(liq_dir / "v1" / "date=2025-01-18.parquet", [])
    _, ls3 = make_liq_day(liq_dir / "v1" / "date=2025-01-19.parquet", [])
    write_manifest_lines(
        liq_dir / "manifest.jsonl",
        [
            {
                "date": "2025-01-17",
                "fold_version": "l1v1",
                "output_sha256": ls1,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-18",
                "fold_version": "l1v1",
                "output_sha256": ls2,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
            {
                "date": "2025-01-19",
                "fold_version": "l1v1",
                "output_sha256": ls3,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 0,
                "liquidation_rows": 0,
            },
        ],
    )

    t0 = D1_MS // 1000
    t1 = (D1_MS + 3_600_000) // 1000
    t_end = HARD_END_MS // 1000
    t_post = (HARD_END_MS + 3_600_000) // 1000

    make_funding_file(
        funding_dir / "market_1.parquet",
        [(t0, 0.0001), (t1, 0.0002), (t_end, 0.0003), (t_post, 0.0004)],
    )

    write_manifest_lines(
        funding_dir / "manifest.jsonl",
        [
            {
                "market_id": 1,
                "status": "ok",
                "first_ts": t0,
                "last_ts": t_post,
                "rows": 4,
                "confirmed_missing_hours": 0,
            }
        ],
    )

    store = data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)

    ts, rates = store.funding(1)
    assert len(ts) == 2
    assert len(rates) == 2
    assert list(ts) == [t0, t1]
    assert list(rates) == [0.0001, 0.0002]
    assert np.all(ts * 1000 < HARD_END_MS)

    # Empty result when market has no file
    ts_empty, rates_empty = store.funding(2)
    assert len(ts_empty) == 0
    assert len(rates_empty) == 0

    # Bad status
    write_manifest_lines(
        funding_dir / "manifest.jsonl",
        [
            {
                "market_id": 1,
                "status": "corrupt",
                "first_ts": t0,
                "last_ts": t_post,
                "rows": 4,
                "confirmed_missing_hours": 0,
            }
        ],
    )
    bad_store = data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)
    with pytest.raises(data_mod.DataError, match="corrupt"):
        bad_store.funding(1)


def test_liq_summary_and_files_read(tmp_path: Path) -> None:
    fold_dir = tmp_path / "fold"
    panel_dir = tmp_path / "panel"
    liq_dir = tmp_path / "liq"
    funding_dir = tmp_path / "funding"

    make_markets_json(
        fold_dir / "markets.json",
        [{"market_id": 1, "symbol": "BTC", "market_type": "perp"}],
    )

    _, s1 = make_fold_day(fold_dir / "v1" / "date=2025-01-17.parquet", [])
    _, s2 = make_fold_day(fold_dir / "v1" / "date=2025-01-18.parquet", [])
    _, s3 = make_fold_day(fold_dir / "v1" / "date=2025-01-19.parquet", [])
    write_manifest_lines(
        fold_dir / "manifest.jsonl",
        [
            {"date": "2025-01-17", "fold_version": "v1", "output_sha256": s1, "output_rows": 0},
            {"date": "2025-01-18", "fold_version": "v1", "output_sha256": s2, "output_rows": 0},
            {"date": "2025-01-19", "fold_version": "v1", "output_sha256": s3, "output_rows": 0},
        ],
    )
    panel.build_panel(fold_dir, panel_dir)

    _, ls1 = make_liq_day(liq_dir / "v1" / "date=2025-01-17.parquet", [])
    _, ls2 = make_liq_day(liq_dir / "v1" / "date=2025-01-18.parquet", [])
    _, ls3 = make_liq_day(liq_dir / "v1" / "date=2025-01-19.parquet", [])

    write_manifest_lines(
        liq_dir / "manifest.jsonl",
        [
            {
                "date": "2025-01-17",
                "fold_version": "l1v1",
                "output_sha256": ls1,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 10,
                "liquidation_rows": 5,
            },
            {
                "date": "2025-01-18",
                "fold_version": "l1v1",
                "output_sha256": ls2,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 20,
                "liquidation_rows": 8,
            },
            {
                "date": "2025-01-19",
                "fold_version": "l1v1",
                "output_sha256": ls3,
                "rows_side_inconsistent": 0,
                "rows_side_unchecked": 30,
                "liquidation_rows": 12,
            },
        ],
    )
    write_manifest_lines(funding_dir / "manifest.jsonl", [])

    store = data_mod.Store(fold_dir, panel_dir, liq_dir, funding_dir)

    summary = store.liq_summary()
    assert summary["days"] == 3
    assert summary["rows_side_inconsistent"] == 0
    assert summary["rows_side_unchecked"] == 60
    assert summary["liquidation_rows"] == 25

    files = store.files_read()
    assert "fold/markets.json" in files
    assert "fold/manifest.jsonl" in files
    assert "panel/panel_manifest.json" in files
    assert "liq/manifest.jsonl" in files
    assert "funding/manifest.jsonl" in files
    assert "liq/v1/date=2025-01-17.parquet" in files
    assert "liq/v1/date=2025-01-18.parquet" in files
    assert "liq/v1/date=2025-01-19.parquet" in files


def test_failed_build_leaves_no_partial_files_but_a_refusal_deletes_nothing(tmp_path: Path) -> None:
    """A build that fails halfway can be started again; refusing an occupied directory deletes nothing."""
    fold_dir, panel_dir = tmp_path / "fold", tmp_path / "panel"
    fold_dir.mkdir()
    panel_dir.mkdir()
    (fold_dir / "manifest.jsonl").write_text("", encoding="utf-8")
    (fold_dir / "markets.json").write_text("{}", encoding="utf-8")
    # no manifest line for the first day: the build fails before writing, then after a partial file exists
    (panel_dir / "market=7.parquet").write_bytes(b"partial")
    with pytest.raises(panel.PanelError, match="already holds"):
        panel.build_panel(fold_dir, panel_dir)
    assert (panel_dir / "market=7.parquet").exists()  # the refusal deleted nothing

    empty_dir = tmp_path / "panel2"
    with pytest.raises(panel.PanelError):
        panel.build_panel(fold_dir, empty_dir)  # fails on the missing manifest line of the first day
    assert list(empty_dir.glob("market=*.parquet")) == []
