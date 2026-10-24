"""Tests for r4.data: loader, guards, manifest verification, caching, and holdout ledger."""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import pytest

from r4.data import (
    HOLDOUT_A,
    LOCKBOX_START,
    PERP_DAILY_END,
    PERP_INTRADAY_END,
    SPOT_DAILY_END,
    SPOT_INTRADAY_END,
    dataset_hash_of,
    holdout_a_end,
    load_candles,
    load_flow,
    load_funding,
    load_htf,
    load_manifest,
    load_metrics,
    load_options,
    load_perp,
    load_snapshots,
    sha256_file,
    verify_manifest,
)


def _write_jsonl_gz(path: Path, rows: list[dict[str, Any]]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    return sha256_file(path)


def _build_synthetic_dataset(
    dir_path: Path,
    files_data: dict[str, tuple[str, str, str, list[dict[str, Any]]]],
) -> Path:
    """Build a minimal valid synthetic dataset with gzip JSONL files and manifest.json."""
    manifest_files = []
    for rel_path, (kind, symbol, interval, rows) in files_data.items():
        full_path = dir_path / rel_path
        file_sha = _write_jsonl_gz(full_path, rows)
        start_ms = rows[0]["t"] if rows else None
        end_ms = rows[-1]["t"] if rows else None
        manifest_files.append(
            {
                "path": rel_path,
                "kind": kind,
                "symbol": symbol,
                "interval": interval,
                "rowCount": len(rows),
                "startMs": start_ms,
                "endMs": end_ms,
                "sha256": file_sha,
            }
        )

    ds_hash = dataset_hash_of(manifest_files)
    manifest = {
        "version": 1,
        "generatedAt": "2026-10-25T00:00:00.000Z",
        "commit": "abc1234",
        "lockboxStart": "2026-07-01T00:00:00.000Z",
        "holdoutA": {
            "spotIntradayEnd": "2021-10-14T00:00:00.000Z",
            "spotDailyEnd": "2018-10-31T00:00:00.000Z",
            "perpIntradayEnd": "2022-01-01T00:00:00.000Z",
            "perpDailyEnd": "2020-01-01T00:00:00.000Z",
        },
        "symbols": ["BTCUSDT"],
        "intervals": ["1h", "4h", "1d", "5m"],
        "files": manifest_files,
        "datasetHash": ds_hash,
    }
    manifest_path = dir_path / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    return dir_path


def test_1_constants():
    """1. The constants equal the epoch values above."""
    assert LOCKBOX_START == 1782864000000
    assert SPOT_INTRADAY_END == 1634169600000
    assert SPOT_DAILY_END == 1540944000000
    assert PERP_INTRADAY_END == 1640995200000
    assert PERP_DAILY_END == 1577836800000

    assert HOLDOUT_A["spot_intraday_end"] == 1634169600000
    assert HOLDOUT_A["spot_daily_end"] == 1540944000000
    assert HOLDOUT_A["perp_intraday_end"] == 1640995200000
    assert HOLDOUT_A["perp_daily_end"] == 1577836800000

    assert HOLDOUT_A.spot_intraday_end == 1634169600000
    assert HOLDOUT_A.spot_daily_end == 1540944000000
    assert HOLDOUT_A.perp_intraday_end == 1640995200000
    assert HOLDOUT_A.perp_daily_end == 1577836800000


def test_2_holdout_a_end():
    """2. holdout_a_end returns the right end for every listed interval, and raises on 7m and on market x."""
    spot_intraday = ["1m", "3m", "5m", "15m", "30m", "1h", "2h"]
    spot_daily = ["4h", "6h", "8h", "12h", "1d", "3d", "1w"]
    perp_daily = ["1d", "3d", "1w"]
    perp_intraday = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h"]

    for iv in spot_intraday:
        assert holdout_a_end("spot", iv) == SPOT_INTRADAY_END
    for iv in spot_daily:
        assert holdout_a_end("spot", iv) == SPOT_DAILY_END

    for iv in perp_intraday:
        assert holdout_a_end("perp", iv) == PERP_INTRADAY_END
    for iv in perp_daily:
        assert holdout_a_end("perp", iv) == PERP_DAILY_END

    with pytest.raises(ValueError, match="Unknown interval"):
        holdout_a_end("spot", "7m")
    with pytest.raises(ValueError, match="Unknown interval"):
        holdout_a_end("perp", "7m")
    with pytest.raises(ValueError, match="Unknown market"):
        holdout_a_end("x", "1h")


def test_3_holdout_boundaries(tmp_path: Path):
    """3. The perp 1h boundary: rows at perp_intraday_end - 3600000 dropped, at perp_intraday_end kept,

    and holdout_dropped_rows counts correctly. The perp 1d boundary uses perp_daily_end. Perp 4h uses
    perp_intraday_end. Spot 4h uses spot_daily_end.
    """
    row_drop_1h = {
        "t": PERP_INTRADAY_END - 3600000,
        "o": 1.0,
        "h": 2.0,
        "l": 0.5,
        "c": 1.5,
        "v": 10.0,
        "qv": 15.0,
        "n": 5,
        "tbv": 5.0,
    }
    row_keep_1h_0 = {
        "t": PERP_INTRADAY_END,
        "o": 1.5,
        "h": 2.5,
        "l": 1.0,
        "c": 2.0,
        "v": 20.0,
        "qv": 30.0,
        "n": 8,
        "tbv": 10.0,
    }
    row_keep_1h_1 = {
        "t": PERP_INTRADAY_END + 3600000,
        "o": 2.0,
        "h": 3.0,
        "l": 1.5,
        "c": 2.5,
        "v": 15.0,
        "qv": 25.0,
        "n": 6,
        "tbv": 7.0,
    }
    perp_1h_rows = [row_drop_1h, row_keep_1h_0, row_keep_1h_1]

    perp_1d_rows = [
        {
            "t": PERP_DAILY_END - 86400000,
            "o": 1.0,
            "h": 2.0,
            "l": 0.5,
            "c": 1.5,
            "v": 10.0,
            "qv": 15.0,
            "n": 5,
            "tbv": 5.0,
        },
        {"t": PERP_DAILY_END, "o": 1.5, "h": 2.5, "l": 1.0, "c": 2.0, "v": 20.0, "qv": 30.0, "n": 8, "tbv": 10.0},
    ]
    perp_4h_rows = [
        {
            "t": PERP_INTRADAY_END - 14400000,
            "o": 1.0,
            "h": 2.0,
            "l": 0.5,
            "c": 1.5,
            "v": 10.0,
            "qv": 15.0,
            "n": 5,
            "tbv": 5.0,
        },
        {"t": PERP_INTRADAY_END, "o": 1.5, "h": 2.5, "l": 1.0, "c": 2.0, "v": 20.0, "qv": 30.0, "n": 8, "tbv": 10.0},
    ]
    spot_4h_rows = [
        {"t": SPOT_DAILY_END - 14400000, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0, "tbv": 5.0},
        {"t": SPOT_DAILY_END, "o": 1.5, "h": 2.5, "l": 1.0, "c": 2.0, "v": 20.0, "tbv": 10.0},
    ]

    files_data = {
        "perp/BTCUSDT/1h.jsonl.gz": ("perp", "BTCUSDT", "1h", perp_1h_rows),
        "perp/BTCUSDT/1d.jsonl.gz": ("perp", "BTCUSDT", "1d", perp_1d_rows),
        "perp/BTCUSDT/4h.jsonl.gz": ("perp", "BTCUSDT", "4h", perp_4h_rows),
        "candles/BTCUSDT/4h.jsonl.gz": ("candles", "BTCUSDT", "4h", spot_4h_rows),
    }
    ds_dir = _build_synthetic_dataset(tmp_path / "dataset", files_data)

    res_1h = load_perp(ds_dir, "BTCUSDT", "1h")
    assert res_1h.holdout_a_applied is True
    assert res_1h.holdout_a_end == PERP_INTRADAY_END
    assert res_1h.holdout_dropped_rows == 1
    assert len(res_1h.rows) == 2
    assert res_1h.rows["t"].tolist() == [PERP_INTRADAY_END, PERP_INTRADAY_END + 3600000]

    res_1d = load_perp(ds_dir, "BTCUSDT", "1d")
    assert res_1d.holdout_a_applied is True
    assert res_1d.holdout_a_end == PERP_DAILY_END
    assert res_1d.holdout_dropped_rows == 1
    assert len(res_1d.rows) == 1
    assert res_1d.rows["t"].iloc[0] == PERP_DAILY_END

    res_perp_4h = load_perp(ds_dir, "BTCUSDT", "4h")
    assert res_perp_4h.holdout_a_applied is True
    assert res_perp_4h.holdout_a_end == PERP_INTRADAY_END
    assert res_perp_4h.holdout_dropped_rows == 1
    assert len(res_perp_4h.rows) == 1
    assert res_perp_4h.rows["t"].iloc[0] == PERP_INTRADAY_END

    res_spot_4h = load_candles(ds_dir, "BTCUSDT", "4h")
    assert res_spot_4h.holdout_a_applied is True
    assert res_spot_4h.holdout_a_end == SPOT_DAILY_END
    assert res_spot_4h.holdout_dropped_rows == 1
    assert len(res_spot_4h.rows) == 1
    assert res_spot_4h.rows["t"].iloc[0] == SPOT_DAILY_END


def test_4_lockbox_boundary(tmp_path: Path):
    """4. The lockbox boundary: t = LOCKBOX_START - 1 kept, t = LOCKBOX_START dropped, dropped_rows counts correctly."""
    rows = [
        {"t": LOCKBOX_START - 1, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0, "tbv": 5.0},
        {"t": LOCKBOX_START, "o": 1.5, "h": 2.5, "l": 1.0, "c": 2.0, "v": 20.0, "tbv": 10.0},
        {"t": LOCKBOX_START + 3600000, "o": 2.0, "h": 3.0, "l": 1.5, "c": 2.5, "v": 15.0, "tbv": 7.0},
    ]
    files_data = {"candles/BTCUSDT/1h.jsonl.gz": ("candles", "BTCUSDT", "1h", rows)}
    ds_dir = _build_synthetic_dataset(tmp_path / "dataset", files_data)

    res = load_candles(ds_dir, "BTCUSDT", "1h")
    assert res.lockbox_applied is True
    assert res.lockbox_start == LOCKBOX_START
    assert res.dropped_rows == 2
    assert len(res.rows) == 1
    assert res.rows["t"].iloc[0] == LOCKBOX_START - 1


def test_5_metrics_and_funding_lockbox_only(tmp_path: Path):
    """5. Metrics and funding are lockbox-only: pre-2022 rows kept, and the holdout fields are False, None and 0."""
    pre_2022 = 1600000000000
    post_2022 = 1650000000000
    metrics_rows = [
        {
            "t": pre_2022,
            "openInterest": 100.0,
            "openInterestValue": 1000.0,
            "topTraderAccountRatio": 1.1,
            "topTraderPositionRatio": 1.2,
            "globalAccountRatio": 1.0,
            "takerLongShortRatio": 0.9,
            "depthImbalance1": 0.1,
            "depthImbalance2": 0.2,
            "depthImbalance5": 0.3,
            "depthNotional1": 50.0,
            "depthNotional5": 100.0,
        },
        {
            "t": post_2022,
            "openInterest": 200.0,
            "openInterestValue": 2000.0,
            "topTraderAccountRatio": 1.3,
            "topTraderPositionRatio": 1.4,
            "globalAccountRatio": 1.1,
            "takerLongShortRatio": 0.8,
            "depthImbalance1": 0.2,
            "depthImbalance2": 0.3,
            "depthImbalance5": 0.4,
            "depthNotional1": 60.0,
            "depthNotional5": 120.0,
        },
    ]
    funding_rows = [
        {"t": pre_2022, "rate": 0.0001, "intervalHours": 8},
        {"t": post_2022, "rate": 0.0002, "intervalHours": 8},
    ]

    files_data = {
        "metrics/BTCUSDT/5m.jsonl.gz": ("metrics", "BTCUSDT", "5m", metrics_rows),
        "funding/BTCUSDT/settlements.jsonl.gz": ("funding", "BTCUSDT", "settlements", funding_rows),
    }
    ds_dir = _build_synthetic_dataset(tmp_path / "dataset", files_data)

    res_metrics = load_metrics(ds_dir, "BTCUSDT")
    assert res_metrics.holdout_a_applied is False
    assert res_metrics.holdout_a_end is None
    assert res_metrics.holdout_dropped_rows == 0
    assert len(res_metrics.rows) == 2
    assert res_metrics.rows["t"].tolist() == [pre_2022, post_2022]

    res_funding = load_funding(ds_dir, "BTCUSDT")
    assert res_funding.holdout_a_applied is False
    assert res_funding.holdout_a_end is None
    assert res_funding.holdout_dropped_rows == 0
    assert len(res_funding.rows) == 2
    assert res_funding.rows["t"].tolist() == [pre_2022, post_2022]


def test_6_allow_flags(tmp_path: Path):
    """6. The allow_* flags behave as specified, including the reported fields."""
    rows = [
        {
            "t": PERP_INTRADAY_END - 3600000,
            "o": 1.0,
            "h": 2.0,
            "l": 0.5,
            "c": 1.5,
            "v": 10.0,
            "qv": 15.0,
            "n": 5,
            "tbv": 5.0,
        },
        {"t": 1700000000000, "o": 1.5, "h": 2.5, "l": 1.0, "c": 2.0, "v": 20.0, "qv": 30.0, "n": 8, "tbv": 10.0},
        {"t": LOCKBOX_START + 1000, "o": 2.0, "h": 3.0, "l": 1.5, "c": 2.5, "v": 15.0, "qv": 25.0, "n": 6, "tbv": 7.0},
    ]
    files_data = {"perp/BTCUSDT/1h.jsonl.gz": ("perp", "BTCUSDT", "1h", rows)}
    ds_dir = _build_synthetic_dataset(tmp_path / "dataset", files_data)
    ledger = tmp_path / "ledger.jsonl"

    # Default
    res_default = load_perp(ds_dir, "BTCUSDT", "1h")
    assert res_default.holdout_a_applied is True
    assert res_default.holdout_a_end == PERP_INTRADAY_END
    assert res_default.holdout_dropped_rows == 1
    assert res_default.lockbox_applied is True
    assert res_default.lockbox_start == LOCKBOX_START
    assert res_default.dropped_rows == 1
    assert len(res_default.rows) == 1
    assert res_default.rows["t"].iloc[0] == 1700000000000

    # allow_holdout_a=True
    res_allow_holdout = load_perp(
        ds_dir,
        "BTCUSDT",
        "1h",
        allow_holdout_a=True,
        holdout_read_id="r1",
        holdout_ledger=ledger,
    )
    assert res_allow_holdout.holdout_a_applied is False
    assert res_allow_holdout.holdout_a_end == PERP_INTRADAY_END
    assert res_allow_holdout.holdout_dropped_rows == 0
    assert res_allow_holdout.lockbox_applied is True
    assert res_allow_holdout.dropped_rows == 1
    assert len(res_allow_holdout.rows) == 2
    assert res_allow_holdout.rows["t"].tolist() == [PERP_INTRADAY_END - 3600000, 1700000000000]

    # allow_lockbox=True
    res_allow_lockbox = load_perp(ds_dir, "BTCUSDT", "1h", allow_lockbox=True)
    assert res_allow_lockbox.holdout_a_applied is True
    assert res_allow_lockbox.holdout_a_end == PERP_INTRADAY_END
    assert res_allow_lockbox.holdout_dropped_rows == 1
    assert res_allow_lockbox.lockbox_applied is False
    assert res_allow_lockbox.lockbox_start == LOCKBOX_START
    assert res_allow_lockbox.dropped_rows == 0
    assert len(res_allow_lockbox.rows) == 2
    assert res_allow_lockbox.rows["t"].tolist() == [1700000000000, LOCKBOX_START + 1000]

    # Both allow_holdout_a=True and allow_lockbox=True
    res_both = load_perp(
        ds_dir,
        "BTCUSDT",
        "1h",
        allow_lockbox=True,
        allow_holdout_a=True,
        holdout_read_id="r2",
        holdout_ledger=ledger,
    )
    assert res_both.holdout_a_applied is False
    assert res_both.holdout_a_end == PERP_INTRADAY_END
    assert res_both.holdout_dropped_rows == 0
    assert res_both.lockbox_applied is False
    assert res_both.lockbox_start == LOCKBOX_START
    assert res_both.dropped_rows == 0
    assert len(res_both.rows) == 3


def test_7_nulls_load_as_nan(tmp_path: Path):
    """7. Nulls load as NaN."""
    candle_rows = [{"t": 1700000000000, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0, "tbv": None}]
    metrics_rows = [
        {
            "t": 1700000000000,
            "openInterest": None,
            "openInterestValue": None,
            "topTraderAccountRatio": None,
            "topTraderPositionRatio": None,
            "globalAccountRatio": None,
            "takerLongShortRatio": None,
            "depthImbalance1": None,
            "depthImbalance2": None,
            "depthImbalance5": None,
            "depthNotional1": None,
            "depthNotional5": None,
        }
    ]
    funding_rows = [{"t": 1700000000000, "rate": 0.0001, "intervalHours": None}]

    files_data = {
        "candles/BTCUSDT/1h.jsonl.gz": ("candles", "BTCUSDT", "1h", candle_rows),
        "metrics/BTCUSDT/5m.jsonl.gz": ("metrics", "BTCUSDT", "5m", metrics_rows),
        "funding/BTCUSDT/settlements.jsonl.gz": ("funding", "BTCUSDT", "settlements", funding_rows),
    }
    ds_dir = _build_synthetic_dataset(tmp_path / "dataset", files_data)

    res_c = load_candles(ds_dir, "BTCUSDT", "1h")
    val_tbv = res_c.rows["tbv"].iloc[0]
    assert np.isnan(val_tbv)
    assert val_tbv != 0

    res_m = load_metrics(ds_dir, "BTCUSDT")
    val_oi = res_m.rows["openInterest"].iloc[0]
    assert np.isnan(val_oi)
    assert val_oi != 0

    res_f = load_funding(ds_dir, "BTCUSDT")
    val_ih = res_f.rows["intervalHours"].iloc[0]
    assert np.isnan(val_ih)
    assert val_ih != 0


def test_8_dataset_hash_and_verify_manifest(tmp_path: Path):
    """8. dataset_hash_of equals a hand computation. verify_manifest is ok on the synthetic export,

    reports a tampered file's path, and reports manifest.json when only datasetHash is wrong.
    """
    h1 = "1111111111111111111111111111111111111111111111111111111111111111"
    h2 = "2222222222222222222222222222222222222222222222222222222222222222"
    expected = hashlib.sha256(f"{h1}\n{h2}".encode()).hexdigest().lower()
    assert dataset_hash_of([h2, h1]) == expected
    assert dataset_hash_of([{"sha256": h2}, {"sha256": h1}]) == expected

    rows = [{"t": 1700000000000, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0, "tbv": 5.0}]
    files_data = {"candles/BTCUSDT/1h.jsonl.gz": ("candles", "BTCUSDT", "1h", rows)}
    ds_dir = _build_synthetic_dataset(tmp_path / "dataset", files_data)

    ok, mismatches = verify_manifest(ds_dir)
    assert ok is True
    assert mismatches == []

    # Tamper a file's content
    target_file = ds_dir / "candles/BTCUSDT/1h.jsonl.gz"
    with open(target_file, "ab") as f:
        f.write(b"corrupt")

    ok_tampered, mismatches_tampered = verify_manifest(ds_dir)
    assert ok_tampered is False
    assert "candles/BTCUSDT/1h.jsonl.gz" in mismatches_tampered
    assert "manifest.json" in mismatches_tampered

    # Restore file, tamper only datasetHash in manifest.json
    _write_jsonl_gz(target_file, rows)
    manifest_path = ds_dir / "manifest.json"
    manifest_data = load_manifest(ds_dir)
    manifest_data["datasetHash"] = "0" * 64
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, indent=2)

    ok_manifest_tampered, mismatches_manifest = verify_manifest(ds_dir)
    assert ok_manifest_tampered is False
    assert mismatches_manifest == ["manifest.json"]


def test_9_parquet_cache(tmp_path: Path):
    """9. Cache: the first load writes the Parquet file, and the second load returns an identical frame.

    A tampered source_sha256 causes a rebuild. Guards still drop rows when the frame comes from the cache.
    """
    rows = [
        {
            "t": PERP_INTRADAY_END - 3600000,
            "o": 1.0,
            "h": 2.0,
            "l": 0.5,
            "c": 1.5,
            "v": 10.0,
            "qv": 15.0,
            "n": 5,
            "tbv": 5.0,
        },
        {"t": 1700000000000, "o": 1.5, "h": 2.5, "l": 1.0, "c": 2.0, "v": 20.0, "qv": 30.0, "n": 8, "tbv": 10.0},
        {"t": LOCKBOX_START + 1000, "o": 2.0, "h": 3.0, "l": 1.5, "c": 2.5, "v": 15.0, "qv": 25.0, "n": 6, "tbv": 7.0},
    ]
    files_data = {"perp/BTCUSDT/1h.jsonl.gz": ("perp", "BTCUSDT", "1h", rows)}
    ds_dir = _build_synthetic_dataset(tmp_path / "dataset", files_data)
    manifest = load_manifest(ds_dir)
    cache_dir = tmp_path / "cache"

    # First load: writes parquet file
    res1 = load_perp(ds_dir, "BTCUSDT", "1h", cache_dir=cache_dir)
    parquet_path = cache_dir / manifest["datasetHash"] / "perp/BTCUSDT/1h.parquet"
    assert parquet_path.exists()
    assert len(res1.rows) == 1
    assert res1.holdout_dropped_rows == 1
    assert res1.dropped_rows == 1

    # Second load: identical frame
    res2 = load_perp(ds_dir, "BTCUSDT", "1h", cache_dir=cache_dir)
    pd.testing.assert_frame_equal(res1.rows, res2.rows)

    # Tamper source_sha256 in the parquet file schema metadata
    table = pq.read_table(parquet_path)
    tampered_meta = {**table.schema.metadata, b"source_sha256": b"bad_sha256"}
    table = table.replace_schema_metadata(tampered_meta)
    pq.write_table(table, parquet_path)

    # Read again: cache should be rebuilt with the correct sha
    res3 = load_perp(ds_dir, "BTCUSDT", "1h", cache_dir=cache_dir)
    pd.testing.assert_frame_equal(res1.rows, res3.rows)

    # Verify that parquet schema metadata was rebuilt with original sha
    rebuilt_table = pq.read_table(parquet_path)
    original_sha = sha256_file(ds_dir / "perp/BTCUSDT/1h.jsonl.gz")
    assert rebuilt_table.schema.metadata[b"source_sha256"].decode("utf-8") == original_sha


def test_10_holdout_read_once(tmp_path: Path):
    """10. Holdout read-once: allow_holdout_a=True without an id or ledger raises. With both, it returns holdout rows

    and writes one ledger line. The same (read_id, path) again raises.
    """
    rows = [
        {
            "t": PERP_INTRADAY_END - 3600000,
            "o": 1.0,
            "h": 2.0,
            "l": 0.5,
            "c": 1.5,
            "v": 10.0,
            "qv": 15.0,
            "n": 5,
            "tbv": 5.0,
        },
        {"t": 1700000000000, "o": 1.5, "h": 2.5, "l": 1.0, "c": 2.0, "v": 20.0, "qv": 30.0, "n": 8, "tbv": 10.0},
    ]
    files_data = {"perp/BTCUSDT/1h.jsonl.gz": ("perp", "BTCUSDT", "1h", rows)}
    ds_dir = _build_synthetic_dataset(tmp_path / "dataset", files_data)
    ledger_path = tmp_path / "holdout_ledger.jsonl"
    target_file = ds_dir / "perp/BTCUSDT/1h.jsonl.gz"

    # allow_holdout_a=True without id raises PermissionError
    with pytest.raises(PermissionError, match="holdout_read_id"):
        load_perp(ds_dir, "BTCUSDT", "1h", allow_holdout_a=True, holdout_ledger=ledger_path)

    # allow_holdout_a=True without ledger raises PermissionError
    with pytest.raises(PermissionError, match="holdout_ledger"):
        load_perp(ds_dir, "BTCUSDT", "1h", allow_holdout_a=True, holdout_read_id="finalist-lock-1")

    # With both: returns holdout rows and writes one ledger line
    res = load_perp(
        ds_dir,
        "BTCUSDT",
        "1h",
        allow_holdout_a=True,
        holdout_read_id="finalist-lock-1",
        holdout_ledger=ledger_path,
    )
    assert len(res.rows) == 2
    assert (res.rows["t"] < PERP_INTRADAY_END).any()
    assert ledger_path.exists()
    lines = [json.loads(line) for line in ledger_path.read_text(encoding="utf-8").strip().split("\n")]
    assert len(lines) == 1
    assert lines[0]["read_id"] == "finalist-lock-1"
    assert lines[0]["path"] == str(target_file)
    assert "at" in lines[0]

    # The same (read_id, path) again raises PermissionError
    with pytest.raises(PermissionError, match="already completed"):
        load_perp(
            ds_dir,
            "BTCUSDT",
            "1h",
            allow_holdout_a=True,
            holdout_read_id="finalist-lock-1",
            holdout_ledger=ledger_path,
        )

    # A different read_id succeeds and appends a new line
    res2 = load_perp(
        ds_dir,
        "BTCUSDT",
        "1h",
        allow_holdout_a=True,
        holdout_read_id="finalist-lock-2",
        holdout_ledger=ledger_path,
    )
    assert len(res2.rows) == 2
    lines2 = [json.loads(line) for line in ledger_path.read_text(encoding="utf-8").strip().split("\n")]
    assert len(lines2) == 2
    assert lines2[1]["read_id"] == "finalist-lock-2"


def test_11_private_reader_scan():
    """11. The private-reader scan from Raw access."""
    r4_dir = Path(__file__).parent.parent / "r4"
    assert r4_dir.exists() and r4_dir.is_dir()

    py_files = list(r4_dir.glob("**/*.py"))
    assert len(py_files) >= 2  # __init__.py and data.py

    data_py_found = False
    for py_file in py_files:
        content = py_file.read_text(encoding="utf-8")
        if py_file.name == "data.py":
            assert "_read_jsonl_gz(" in content
            data_py_found = True
        else:
            assert "_read_jsonl_gz(" not in content, f"Direct call to _read_jsonl_gz found in {py_file}"

    assert data_py_found is True


def test_12_all_loader_kinds_and_series(tmp_path: Path):
    """Test load_snapshots, load_htf, load_flow, load_options, and perp series variants."""
    t_val = 1700000000000
    snap_rows = [
        {
            "t": t_val,
            "fundingRate": {"rate": 0.0001, "markPrice": 50000.0},
            "longShortRatio": {"ratio": 1.2, "longAccount": 0.6, "shortAccount": 0.4},
            "openInterest": {"value": 100.0, "sumValue": 1000.0},
            "fearGreed": {"index": 50, "label": "Neutral"},
            "newsSentiment": {"count": 10, "avgSentiment": 0.5, "topics": ["btc"]},
        }
    ]
    htf_rows = [{"t": t_val, "context": {"trend": "bullish"}}]
    flow_rows = [
        {
            "t": t_val,
            "trades": 100,
            "aggTrades": 80,
            "buyBase": 10.0,
            "sellBase": 8.0,
            "buyQuote": 500.0,
            "sellQuote": 400.0,
            "buyQuoteSmall": 100.0,
            "buyQuoteMedium": 200.0,
            "buyQuoteLarge": 200.0,
            "sellQuoteSmall": 80.0,
            "sellQuoteMedium": 160.0,
            "sellQuoteLarge": 160.0,
            "buyQuoteOpen10s": 50.0,
            "sellQuoteOpen10s": 40.0,
            "source": "aggTrades",
        }
    ]
    opt_rows = [
        {
            "t": t_val,
            "dvolOpen": 55.0,
            "dvolHigh": 56.0,
            "dvolLow": 54.0,
            "dvolClose": 55.5,
            "callBuyNotional": 100.0,
            "callSellNotional": 90.0,
            "putBuyNotional": 80.0,
            "putSellNotional": 70.0,
            "netDelta": 10.0,
            "netDollarGamma": 5.0,
            "tradeCount": 50,
            "greekTradeCount": 45,
            "vwIv": 55.2,
            "putIv25": 56.0,
            "callIv25": 54.5,
        }
    ]
    perp_prem_rows = [
        {"t": t_val, "o": 0.001, "h": 0.002, "l": 0.0, "c": 0.0015, "v": 0.0, "qv": 0.0, "n": 0, "tbv": None}
    ]
    perp_mark_rows = [
        {"t": t_val, "o": 50000.0, "h": 50100.0, "l": 49900.0, "c": 50050.0, "v": 0.0, "qv": 0.0, "n": 0, "tbv": None}
    ]

    files_data = {
        "snapshots/BTCUSDT/1h.jsonl.gz": ("snapshots", "BTCUSDT", "1h", snap_rows),
        "htf/BTCUSDT/1h.jsonl.gz": ("htf", "BTCUSDT", "1h", htf_rows),
        "flow/BTCUSDT/5m.jsonl.gz": ("flow", "BTCUSDT", "5m", flow_rows),
        "options/BTC/1h.jsonl.gz": ("options", "BTC", "1h", opt_rows),
        "perp/BTCUSDT/1h.premiumIndex.jsonl.gz": ("perp", "BTCUSDT", "1h.premiumIndex", perp_prem_rows),
        "perp/BTCUSDT/1h.markPrice.jsonl.gz": ("perp", "BTCUSDT", "1h.markPrice", perp_mark_rows),
    }
    ds_dir = _build_synthetic_dataset(tmp_path / "dataset", files_data)

    res_snap = load_snapshots(ds_dir, "BTCUSDT", "1h")
    assert len(res_snap.rows) == 1
    assert res_snap.rows["fundingRate"].iloc[0]["rate"] == 0.0001
    assert res_snap.holdout_a_applied is False

    res_htf = load_htf(ds_dir, "BTCUSDT", "1h")
    assert len(res_htf.rows) == 1
    assert res_htf.rows["context"].iloc[0]["trend"] == "bullish"
    assert res_htf.holdout_a_applied is True
    assert res_htf.holdout_a_end == SPOT_INTRADAY_END

    res_flow = load_flow(ds_dir, "BTCUSDT")
    assert len(res_flow.rows) == 1
    assert res_flow.rows["source"].iloc[0] == "aggTrades"
    assert res_flow.holdout_a_applied is False

    res_opt_btc = load_options(ds_dir, "BTC")
    assert len(res_opt_btc.rows) == 1
    assert res_opt_btc.rows["dvolClose"].iloc[0] == 55.5
    assert res_opt_btc.holdout_a_applied is False

    res_opt_btcusdt = load_options(ds_dir, "BTCUSDT")
    assert len(res_opt_btcusdt.rows) == 1
    assert res_opt_btcusdt.rows["dvolClose"].iloc[0] == 55.5

    res_prem = load_perp(ds_dir, "BTCUSDT", "1h", series="premiumIndex")
    assert len(res_prem.rows) == 1
    assert res_prem.rows["c"].iloc[0] == 0.0015

    res_mark = load_perp(ds_dir, "BTCUSDT", "1h", series="markPrice")
    assert len(res_mark.rows) == 1
    assert res_mark.rows["c"].iloc[0] == 50050.0

    with pytest.raises(ValueError, match="Unknown perp series"):
        load_perp(ds_dir, "BTCUSDT", "1h", series="invalid_series")


def test_13_line_lengths():
    """Verify all lines in r4/data.py and tests/test_data.py are <= 120 characters."""
    py_dir = Path(__file__).parent.parent
    files = [py_dir / "r4" / "data.py", py_dir / "tests" / "test_data.py"]
    violations = []
    for file_path in files:
        for idx, line in enumerate(file_path.read_text(encoding="utf-8").splitlines(), start=1):
            if len(line) > 120:
                violations.append(f"{file_path.name}:{idx} (len {len(line)})")
    assert not violations, "Lines exceeding 120 chars: " + ", ".join(violations)
