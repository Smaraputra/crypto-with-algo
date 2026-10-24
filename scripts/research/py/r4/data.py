"""Data loader for the research dataset export with lockbox and holdout guards."""

from __future__ import annotations

import gzip
import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

LOCKBOX_START = 1782864000000

SPOT_INTRADAY_END = 1634169600000
SPOT_DAILY_END = 1540944000000
PERP_INTRADAY_END = 1640995200000
PERP_DAILY_END = 1577836800000


class _HoldoutA(dict[str, int]):
    spot_intraday_end: int = SPOT_INTRADAY_END
    spot_daily_end: int = SPOT_DAILY_END
    perp_intraday_end: int = PERP_INTRADAY_END
    perp_daily_end: int = PERP_DAILY_END
    spotIntradayEnd: int = SPOT_INTRADAY_END
    spotDailyEnd: int = SPOT_DAILY_END
    perpIntradayEnd: int = PERP_INTRADAY_END
    perpDailyEnd: int = PERP_DAILY_END

    def __init__(self) -> None:
        super().__init__(
            spot_intraday_end=self.spot_intraday_end,
            spot_daily_end=self.spot_daily_end,
            perp_intraday_end=self.perp_intraday_end,
            perp_daily_end=self.perp_daily_end,
            spotIntradayEnd=self.spotIntradayEnd,
            spotDailyEnd=self.spotDailyEnd,
            perpIntradayEnd=self.perpIntradayEnd,
            perpDailyEnd=self.perpDailyEnd,
        )


HOLDOUT_A = _HoldoutA()

SPOT_INTRADAY_INTERVALS = {"1m", "3m", "5m", "15m", "30m", "1h", "2h"}
SPOT_DAILY_INTERVALS = {"4h", "6h", "8h", "12h", "1d", "3d", "1w"}
PERP_DAILY_INTERVALS = {"1d", "3d", "1w"}
KNOWN_INTERVALS = SPOT_INTRADAY_INTERVALS | SPOT_DAILY_INTERVALS


def holdout_a_end(market: str, interval: str) -> int:
    """Return the holdout A end timestamp (epoch ms UTC) for a market and interval."""
    if interval not in KNOWN_INTERVALS:
        raise ValueError(f"Unknown interval: {interval}")
    if market == "spot":
        if interval in SPOT_INTRADAY_INTERVALS:
            return HOLDOUT_A.spot_intraday_end
        return HOLDOUT_A.spot_daily_end
    if market == "perp":
        if interval in PERP_DAILY_INTERVALS:
            return HOLDOUT_A.perp_daily_end
        return HOLDOUT_A.perp_intraday_end
    raise ValueError(f"Unknown market: {market}")


@dataclass
class LoadResult:
    rows: pd.DataFrame
    lockbox_applied: bool
    lockbox_start: int
    dropped_rows: int
    holdout_a_applied: bool
    holdout_a_end: int | None
    holdout_dropped_rows: int


def load_manifest(dir: str | Path) -> dict[str, Any]:
    """Load and parse manifest.json from the dataset directory."""
    manifest_path = Path(dir) / "manifest.json"
    with open(manifest_path, encoding="utf-8") as f:
        return json.load(f)


def sha256_file(path: str | Path) -> str:
    """Compute lowercase hex sha256 of the raw file bytes."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest().lower()


def dataset_hash_of(files_or_hashes: Sequence[dict[str, Any] | str]) -> str:
    """Compute dataset hash from file sha256s sorted lexicographically."""
    hashes = [f["sha256"] if isinstance(f, dict) else f for f in files_or_hashes]
    sorted_hashes = sorted(hashes)
    joined = "\n".join(sorted_hashes)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest().lower()


def verify_manifest(dir: str | Path) -> tuple[bool, list[str]]:
    """Recompute sha256 of every listed file and dataset hash, returning (ok, mismatches)."""
    manifest = load_manifest(dir)
    mismatches: list[str] = []
    actual_hashes: list[str] = []

    for file_info in manifest.get("files", []):
        rel_path = file_info["path"]
        target = Path(dir) / rel_path
        if not target.exists():
            mismatches.append(rel_path)
            continue
        actual_sha = sha256_file(target)
        if actual_sha != file_info.get("sha256"):
            mismatches.append(rel_path)
        actual_hashes.append(actual_sha)

    live_dataset_hash = dataset_hash_of(actual_hashes)
    if live_dataset_hash != manifest.get("datasetHash"):
        mismatches.append("manifest.json")

    return (len(mismatches) == 0, mismatches)


def _read_jsonl_gz(path: str | Path) -> pd.DataFrame:
    """Private reader: read a gzip JSON-lines file into a pandas DataFrame."""
    records: list[dict[str, Any]] = []
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                records.append(json.loads(stripped))

    if not records:
        return pd.DataFrame()

    df = pd.DataFrame(records)

    nested_columns = {"context", "fundingRate", "longShortRatio", "fearGreed", "newsSentiment"}
    for col in df.columns:
        if col in nested_columns or col == "source":
            continue
        try:
            sample = df[col].dropna()
            if not sample.empty and isinstance(sample.iloc[0], (dict, list)):
                continue
            df[col] = pd.to_numeric(df[col])
        except (ValueError, TypeError):
            pass

    return df


def _record_holdout_read(file_path: Path, read_id: str, ledger_path: str | Path) -> None:
    ledger_p = Path(ledger_path)
    target_path_str = str(file_path)

    if ledger_p.exists():
        with open(ledger_p, encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    entry = json.loads(stripped)
                except Exception:
                    continue
                if entry.get("read_id") == read_id and entry.get("path") == target_path_str:
                    raise PermissionError(
                        f"Holdout read already completed for read_id '{read_id}' on path '{target_path_str}'"
                    )

    ledger_p.parent.mkdir(parents=True, exist_ok=True)
    utc_now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    ledger_entry = {"read_id": read_id, "path": target_path_str, "at": utc_now}
    with open(ledger_p, "a", encoding="utf-8") as f:
        f.write(json.dumps(ledger_entry) + "\n")


def _load_raw_rows(
    dir_path: Path,
    rel_path: str,
    cache_dir: str | Path | None,
) -> pd.DataFrame:
    file_path = dir_path / rel_path

    if cache_dir is None:
        return _read_jsonl_gz(file_path)

    manifest = load_manifest(dir_path)
    dataset_hash = manifest.get("datasetHash", "")

    parquet_rel = rel_path[:-9] + ".parquet" if rel_path.endswith(".jsonl.gz") else rel_path + ".parquet"
    cache_file = Path(cache_dir) / dataset_hash / parquet_rel

    file_sha = sha256_file(file_path)

    if cache_file.exists():
        try:
            parquet_file = pq.ParquetFile(cache_file)
            metadata = parquet_file.schema_arrow.metadata or {}
            cached_sha = metadata.get(b"source_sha256")
            if cached_sha is not None and cached_sha.decode("utf-8") == file_sha:
                return parquet_file.read().to_pandas()
        except Exception:
            pass

    df = _read_jsonl_gz(file_path)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pandas(df)
    existing_meta = table.schema.metadata or {}
    new_meta = {**existing_meta, b"source_sha256": file_sha.encode("utf-8")}
    table = table.replace_schema_metadata(new_meta)
    pq.write_table(table, cache_file)
    return df


def _load_dataset_file_with_holdout(
    dir: str | Path,
    rel_path: str,
    market: str,
    interval: str,
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    if allow_holdout_a:
        if not holdout_read_id or not isinstance(holdout_read_id, str) or not holdout_read_id.strip():
            raise PermissionError("allow_holdout_a=True requires a non-empty holdout_read_id")
        if not holdout_ledger:
            raise PermissionError("allow_holdout_a=True requires holdout_ledger")

    dir_p = Path(dir)
    file_p = dir_p / rel_path
    raw_df = _load_raw_rows(dir_p, rel_path, cache_dir)

    end = holdout_a_end(market, interval)
    holdout_dropped = 0
    holdout_applied = False

    if raw_df.empty or "t" not in raw_df.columns:
        filtered_df = raw_df.copy()
    else:
        if allow_holdout_a:
            filtered_df = raw_df.copy()
            holdout_applied = False
            holdout_dropped = 0
        else:
            kept_mask = raw_df["t"] >= end
            filtered_df = raw_df[kept_mask].copy()
            holdout_applied = True
            holdout_dropped = int((~kept_mask).sum())

    lockbox_applied = False
    lockbox_dropped = 0

    if filtered_df.empty or "t" not in filtered_df.columns:
        final_df = filtered_df
    else:
        if allow_lockbox:
            final_df = filtered_df
            lockbox_applied = False
            lockbox_dropped = 0
        else:
            kept_mask = filtered_df["t"] < LOCKBOX_START
            final_df = filtered_df[kept_mask].copy()
            lockbox_applied = True
            lockbox_dropped = int((~kept_mask).sum())

    if not final_df.empty and "t" in final_df.columns:
        final_df = final_df.sort_values("t", ascending=True).reset_index(drop=True)
    else:
        final_df = final_df.reset_index(drop=True)

    if allow_holdout_a and not final_df.empty and "t" in final_df.columns:
        if (final_df["t"] < end).any():
            _record_holdout_read(file_p, holdout_read_id, holdout_ledger)

    return LoadResult(
        rows=final_df,
        lockbox_applied=lockbox_applied,
        lockbox_start=LOCKBOX_START,
        dropped_rows=lockbox_dropped,
        holdout_a_applied=holdout_applied,
        holdout_a_end=end,
        holdout_dropped_rows=holdout_dropped,
    )


def _load_dataset_file_lockbox_only(
    dir: str | Path,
    rel_path: str,
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    dir_p = Path(dir)
    raw_df = _load_raw_rows(dir_p, rel_path, cache_dir)

    lockbox_applied = False
    lockbox_dropped = 0

    if raw_df.empty or "t" not in raw_df.columns:
        final_df = raw_df.copy()
    else:
        if allow_lockbox:
            final_df = raw_df.copy()
            lockbox_applied = False
            lockbox_dropped = 0
        else:
            kept_mask = raw_df["t"] < LOCKBOX_START
            final_df = raw_df[kept_mask].copy()
            lockbox_applied = True
            lockbox_dropped = int((~kept_mask).sum())

    if not final_df.empty and "t" in final_df.columns:
        final_df = final_df.sort_values("t", ascending=True).reset_index(drop=True)
    else:
        final_df = final_df.reset_index(drop=True)

    return LoadResult(
        rows=final_df,
        lockbox_applied=lockbox_applied,
        lockbox_start=LOCKBOX_START,
        dropped_rows=lockbox_dropped,
        holdout_a_applied=False,
        holdout_a_end=None,
        holdout_dropped_rows=0,
    )


def load_candles(
    dir: str | Path,
    symbol: str,
    interval: str,
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    """Load spot candles with holdout and lockbox guards."""
    rel_path = f"candles/{symbol}/{interval}.jsonl.gz"
    return _load_dataset_file_with_holdout(
        dir,
        rel_path,
        market="spot",
        interval=interval,
        allow_lockbox=allow_lockbox,
        allow_holdout_a=allow_holdout_a,
        holdout_read_id=holdout_read_id,
        holdout_ledger=holdout_ledger,
        cache_dir=cache_dir,
    )


def load_perp(
    dir: str | Path,
    symbol: str,
    interval: str,
    series: str = "klines",
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    """Load perpetual bars with holdout and lockbox guards."""
    if series == "klines":
        suffix = interval
    elif series in ("premiumIndex", "markPrice"):
        suffix = f"{interval}.{series}"
    else:
        raise ValueError(f"Unknown perp series: {series}")

    rel_path = f"perp/{symbol}/{suffix}.jsonl.gz"
    return _load_dataset_file_with_holdout(
        dir,
        rel_path,
        market="perp",
        interval=interval,
        allow_lockbox=allow_lockbox,
        allow_holdout_a=allow_holdout_a,
        holdout_read_id=holdout_read_id,
        holdout_ledger=holdout_ledger,
        cache_dir=cache_dir,
    )


def load_snapshots(
    dir: str | Path,
    symbol: str,
    interval: str,
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    """Load snapshots with lockbox guard."""
    rel_path = f"snapshots/{symbol}/{interval}.jsonl.gz"
    return _load_dataset_file_lockbox_only(
        dir,
        rel_path,
        allow_lockbox=allow_lockbox,
        allow_holdout_a=allow_holdout_a,
        holdout_read_id=holdout_read_id,
        holdout_ledger=holdout_ledger,
        cache_dir=cache_dir,
    )


def load_htf(
    dir: str | Path,
    symbol: str,
    interval: str,
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    """Load higher-timeframe context rows with holdout and lockbox guards."""
    rel_path = f"htf/{symbol}/{interval}.jsonl.gz"
    return _load_dataset_file_with_holdout(
        dir,
        rel_path,
        market="spot",
        interval=interval,
        allow_lockbox=allow_lockbox,
        allow_holdout_a=allow_holdout_a,
        holdout_read_id=holdout_read_id,
        holdout_ledger=holdout_ledger,
        cache_dir=cache_dir,
    )


def load_metrics(
    dir: str | Path,
    symbol: str,
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    """Load 5m metrics rows with lockbox guard."""
    rel_path = f"metrics/{symbol}/5m.jsonl.gz"
    return _load_dataset_file_lockbox_only(
        dir,
        rel_path,
        allow_lockbox=allow_lockbox,
        allow_holdout_a=allow_holdout_a,
        holdout_read_id=holdout_read_id,
        holdout_ledger=holdout_ledger,
        cache_dir=cache_dir,
    )


def load_flow(
    dir: str | Path,
    symbol: str,
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    """Load 5m taker flow rows with lockbox guard."""
    rel_path = f"flow/{symbol}/5m.jsonl.gz"
    return _load_dataset_file_lockbox_only(
        dir,
        rel_path,
        allow_lockbox=allow_lockbox,
        allow_holdout_a=allow_holdout_a,
        holdout_read_id=holdout_read_id,
        holdout_ledger=holdout_ledger,
        cache_dir=cache_dir,
    )


def load_options(
    dir: str | Path,
    currency: str,
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    """Load 1h options rows for BTC or ETH with lockbox guard."""
    currency_clean = {"BTCUSDT": "BTC", "ETHUSDT": "ETH"}.get(currency, currency)
    rel_path = f"options/{currency_clean}/1h.jsonl.gz"
    return _load_dataset_file_lockbox_only(
        dir,
        rel_path,
        allow_lockbox=allow_lockbox,
        allow_holdout_a=allow_holdout_a,
        holdout_read_id=holdout_read_id,
        holdout_ledger=holdout_ledger,
        cache_dir=cache_dir,
    )


def load_funding(
    dir: str | Path,
    symbol: str,
    allow_lockbox: bool = False,
    allow_holdout_a: bool = False,
    holdout_read_id: str | None = None,
    holdout_ledger: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> LoadResult:
    """Load funding settlements with lockbox guard."""
    rel_path = f"funding/{symbol}/settlements.jsonl.gz"
    return _load_dataset_file_lockbox_only(
        dir,
        rel_path,
        allow_lockbox=allow_lockbox,
        allow_holdout_a=allow_holdout_a,
        holdout_read_id=holdout_read_id,
        holdout_ledger=holdout_ledger,
        cache_dir=cache_dir,
    )
