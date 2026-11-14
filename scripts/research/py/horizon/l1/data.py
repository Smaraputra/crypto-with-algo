"""Guarded reader and in-memory store for horizon-l1 panel, liquidation, and funding data."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from horizon.l1 import lock


def _compute_grid0_ms() -> int:
    d = lock.FOLD_FIRST_DATE
    return int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.UTC).timestamp() * 1000)


GRID0_MS: int = _compute_grid0_ms()
N_MIN: int = (lock.HARD_END_MS - GRID0_MS) // 60_000


class DataError(RuntimeError):
    """Raised when an input file is missing, corrupt or refused by a guard."""


def sha256_file(path: Path) -> str:
    """Compute sha256 hex digest of a file in 1 MB chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def funding_files_digest(funding_dir: Path | str) -> str:
    """sha256 hex over '{name}\t{sha256_file(path)}\n' for every market_*.parquet in funding_dir, sorted by name."""
    fdir = Path(funding_dir).resolve()
    files = sorted(fdir.glob("market_*.parquet"), key=lambda p: p.name)
    h = hashlib.sha256()
    for f in files:
        line = f"{f.name}\t{sha256_file(f)}\n"
        h.update(line.encode("utf-8"))
    return h.hexdigest()


@dataclass
class MarketData:
    """Dense minute arrays for one perpetual market across the study span."""

    market_id: int
    symbol: str
    market_type: str
    present: np.ndarray  # bool, N_MIN: the fold has a row for the minute
    buy_usd: np.ndarray  # float64, 0.0 where absent
    sell_usd: np.ndarray
    last_px: np.ndarray  # float64, NaN where null or absent (same for the next seven columns)
    last_buy_px: np.ndarray
    last_buy_ts: np.ndarray
    last_sell_px: np.ndarray
    last_sell_ts: np.ndarray
    first_buy_px: np.ndarray
    first_buy_ts: np.ndarray
    first_sell_px: np.ndarray
    first_sell_ts: np.ndarray
    liq_sell_usd: np.ndarray  # float64, 0.0 where none
    liq_buy_usd: np.ndarray
    n_liq_sell: np.ndarray  # int32
    n_liq_buy: np.ndarray

    def index_of(self, ms: int) -> int:
        """Return grid index for epoch ms, or raise DataError if outside [0, N_MIN)."""
        idx = (ms - GRID0_MS) // 60_000
        if idx < 0 or idx >= N_MIN:
            raise DataError(f"timestamp {ms} gives index {idx} outside [0, {N_MIN})")
        return int(idx)

    def ms_of(self, index: int) -> int:
        """Return epoch ms for grid index, or raise DataError if outside [0, N_MIN)."""
        if index < 0 or index >= N_MIN:
            raise DataError(f"index {index} outside [0, {N_MIN})")
        return int(GRID0_MS + index * 60_000)

    @property
    def active(self) -> np.ndarray:
        """Boolean mask where buy_usd + sell_usd > 0."""
        return (self.buy_usd + self.sell_usd) > 0.0


class Store:
    """Guarded reader and cache for horizon-l1 market panels, liquidations, and funding."""

    def __init__(
        self,
        fold_dir: Path | str,
        panel_dir: Path | str,
        liq_dir: Path | str,
        funding_dir: Path | str,
    ) -> None:
        self.fold_dir = Path(fold_dir).resolve()
        self.panel_dir = Path(panel_dir).resolve()
        self.liq_dir = Path(liq_dir).resolve()
        self.funding_dir = Path(funding_dir).resolve()

        self._files_read: dict[str, str] = {}
        self._markets: dict[int, dict[str, str]] = {}
        self._panel_manifest: dict[str, Any] = {}
        self._funding_manifest: dict[int, dict[str, Any]] = {}
        self._liq_manifest_by_date: dict[str, dict[str, Any]] = {}
        self._liq_days: list[dt.date] = []
        self._liq_table: pa.Table | None = None
        self._market_cache: dict[int, MarketData] = {}
        self._funding_cache: dict[int, tuple[np.ndarray, np.ndarray]] = {}

        self._load_and_verify()

    def _rel_path(self, path: Path) -> str:
        """Return a relative path representation prefixed by domain directory name."""
        resolved = path.resolve()
        for base in (self.fold_dir, self.panel_dir, self.liq_dir, self.funding_dir):
            try:
                rel = resolved.relative_to(base)
                return f"{base.name}/{rel}"
            except ValueError:
                pass
        return str(path)

    def _record_file(self, path: Path, sha: str) -> None:
        self._files_read[self._rel_path(path)] = sha

    def _load_and_verify(self) -> None:
        # 1. markets.json
        markets_path = self.fold_dir / "markets.json"
        if not markets_path.is_file():
            raise DataError(f"markets.json missing: {markets_path}")
        markets_sha = sha256_file(markets_path)
        self._record_file(markets_path, markets_sha)
        try:
            markets_payload = json.loads(markets_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise DataError(f"failed to parse markets.json: {exc}") from exc

        if not isinstance(markets_payload, dict) or "order_books" not in markets_payload:
            raise DataError("markets.json missing 'order_books' key")
        order_books = markets_payload["order_books"]
        if not isinstance(order_books, list):
            raise DataError("markets.json 'order_books' is not a list")

        for item in order_books:
            if isinstance(item, dict) and "market_id" in item:
                m_id = int(item["market_id"])
                self._markets[m_id] = {
                    "symbol": str(item.get("symbol", "")),
                    "market_type": str(item.get("market_type", "")),
                }

        # 2. Fold manifest
        fold_manifest_path = self.fold_dir / "manifest.jsonl"
        if not fold_manifest_path.is_file():
            raise DataError(f"fold manifest missing: {fold_manifest_path}")
        fold_manifest_sha = sha256_file(fold_manifest_path)
        self._record_file(fold_manifest_path, fold_manifest_sha)

        # 3. Panel manifest
        panel_manifest_path = self.panel_dir / "panel_manifest.json"
        if not panel_manifest_path.is_file():
            raise DataError(f"panel_manifest.json missing: {panel_manifest_path}")
        panel_manifest_sha = sha256_file(panel_manifest_path)
        self._record_file(panel_manifest_path, panel_manifest_sha)
        try:
            self._panel_manifest = json.loads(panel_manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise DataError(f"failed to parse panel_manifest.json: {exc}") from exc

        p_ver = self._panel_manifest.get("panel_version")
        if p_ver != "l1p1":
            raise DataError(f"panel_version {p_ver!r} != 'l1p1'")
        p_fold_sha = self._panel_manifest.get("fold_manifest_sha256")
        if p_fold_sha != fold_manifest_sha:
            raise DataError(
                f"panel fold_manifest_sha256 mismatch: manifest {p_fold_sha} != current {fold_manifest_sha}"
            )
        p_markets_sha = self._panel_manifest.get("markets_sha256")
        if p_markets_sha != markets_sha:
            raise DataError(f"panel markets_sha256 mismatch: manifest {p_markets_sha} != current {markets_sha}")
        scale_jumps = self._panel_manifest.get("scale_jumps", [])
        if scale_jumps:
            raise DataError(f"unresolved scale jumps: {scale_jumps}")

        # 4. Liquidation pass manifest and day files
        liq_manifest_path = self.liq_dir / "manifest.jsonl"
        if not liq_manifest_path.is_file():
            raise DataError(f"liquidation manifest missing: {liq_manifest_path}")
        liq_manifest_sha = sha256_file(liq_manifest_path)
        self._record_file(liq_manifest_path, liq_manifest_sha)
        for line in liq_manifest_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict) and "date" in entry:
                date_str = str(entry["date"])
                if date_str > lock.HARD_LAST_DATE.isoformat():
                    continue
                self._liq_manifest_by_date[date_str] = entry

        cur = lock.FOLD_FIRST_DATE
        self._liq_days = []
        while cur <= lock.HARD_LAST_DATE:
            date_str = cur.isoformat()
            if date_str not in self._liq_manifest_by_date:
                raise DataError(f"missing liquidation manifest line for day {date_str}")
            entry = self._liq_manifest_by_date[date_str]
            l_ver = entry.get("fold_version")
            if l_ver != "l1v1":
                raise DataError(f"day {date_str} has liquidation fold_version {l_ver!r}, expected 'l1v1'")
            inconsistent = entry.get("rows_side_inconsistent", 0)
            if inconsistent > 0:
                raise DataError(f"day {date_str} has {inconsistent} rows_side_inconsistent")
            day_file = self.liq_dir / "v1" / f"date={date_str}.parquet"
            if not day_file.is_file():
                raise DataError(f"missing liquidation file for day {date_str}: {day_file}")
            day_sha = sha256_file(day_file)
            expected_liq_sha = entry.get("output_sha256")
            if day_sha != expected_liq_sha:
                raise DataError(
                    f"liquidation sha256 mismatch for day {date_str}: expected {expected_liq_sha}, got {day_sha}"
                )
            self._record_file(day_file, day_sha)
            self._liq_days.append(cur)
            cur += dt.timedelta(days=1)

        # 5. Funding manifest
        funding_manifest_path = self.funding_dir / "manifest.jsonl"
        if not funding_manifest_path.is_file():
            raise DataError(f"funding manifest missing: {funding_manifest_path}")
        funding_manifest_sha = sha256_file(funding_manifest_path)
        self._record_file(funding_manifest_path, funding_manifest_sha)
        for line in funding_manifest_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict) and "market_id" in entry:
                self._funding_manifest[int(entry["market_id"])] = entry

    def _get_liq_table(self) -> pa.Table:
        if self._liq_table is not None:
            return self._liq_table
        tables: list[pa.Table] = []
        for day in self._liq_days:
            date_str = day.isoformat()
            day_file = self.liq_dir / "v1" / f"date={date_str}.parquet"
            tables.append(pq.read_table(day_file))
        if tables:
            self._liq_table = pa.concat_tables(tables)
        else:
            self._liq_table = pa.Table.from_batches(
                [],
                schema=pa.schema(
                    [
                        ("market_id", pa.int16()),
                        ("minute", pa.int64()),
                        ("liq_sell_usd", pa.float64()),
                        ("liq_buy_usd", pa.float64()),
                        ("n_liq_sell", pa.int32()),
                        ("n_liq_buy", pa.int32()),
                    ]
                ),
            )
        return self._liq_table

    def market_ids(self) -> list[int]:
        """Sorted ids of type perp that have a panel file."""
        panel_markets = self._panel_manifest.get("markets", {})

        # Check: Every market listed in panel manifest must have its market=<id>.parquet file
        for m_str in panel_markets:
            panel_file = self.panel_dir / f"market={m_str}.parquet"
            if not panel_file.is_file():
                raise DataError(f"market {m_str} listed in panel manifest but file is missing: {panel_file}")

        # Check: Every market=<id>.parquet file in panel folder must be listed in panel manifest
        for p in self.panel_dir.glob("market=*.parquet"):
            m_str = p.name[len("market=") : -len(".parquet")]
            if m_str not in panel_markets:
                raise DataError(f"market {m_str} has panel file {p.name} but is not listed in panel manifest")

        # Perp markets in markets.json: if in panel_markets, return; if in neither, stay silently absent
        res: list[int] = []
        for m_id, meta in self._markets.items():
            if meta.get("market_type") == "perp":
                if str(m_id) in panel_markets:
                    res.append(m_id)
        return sorted(res)

    def market(self, market_id: int) -> MarketData:
        """Read panel and liquidation data for one perp market as dense minute arrays."""
        if market_id in self._market_cache:
            return self._market_cache[market_id]

        if market_id not in self._markets:
            raise DataError(f"unknown market_id {market_id}")

        meta = self._markets[market_id]
        symbol = meta["symbol"]
        market_type = meta["market_type"]
        if market_type != "perp":
            raise DataError(f"market {market_id} market_type {market_type!r} is not perp")

        panel_file = self.panel_dir / f"market={market_id}.parquet"
        if not panel_file.is_file():
            raise DataError(f"missing panel file for market {market_id}: {panel_file}")

        panel_markets = self._panel_manifest.get("markets", {})
        if str(market_id) not in panel_markets:
            raise DataError(f"market {market_id} missing from panel manifest")

        expected_sha = panel_markets[str(market_id)]["sha256"]
        actual_sha = sha256_file(panel_file)
        if actual_sha != expected_sha:
            raise DataError(f"sha256 mismatch for panel market {market_id}: expected {expected_sha}, got {actual_sha}")
        self._record_file(panel_file, actual_sha)

        panel_table = pq.read_table(panel_file)
        minutes = panel_table["minute"].to_numpy(zero_copy_only=False)

        if len(minutes) > 0:
            if np.any((minutes < GRID0_MS) | (minutes >= lock.HARD_END_MS)):
                raise DataError(f"market {market_id} contains minutes outside [GRID0_MS, HARD_END_MS)")
            if np.any(minutes % 60_000 != 0):
                raise DataError(f"market {market_id} contains minutes not aligned to 60s")
            indices = (minutes - GRID0_MS) // 60_000
            if len(np.unique(indices)) != len(indices):
                raise DataError(f"market {market_id} duplicate minutes on grid")
        else:
            indices = np.array([], dtype=np.int64)

        present = np.zeros(N_MIN, dtype=bool)
        buy_usd = np.zeros(N_MIN, dtype=np.float64)
        sell_usd = np.zeros(N_MIN, dtype=np.float64)
        last_px = np.full(N_MIN, np.nan, dtype=np.float64)
        last_buy_px = np.full(N_MIN, np.nan, dtype=np.float64)
        last_buy_ts = np.full(N_MIN, np.nan, dtype=np.float64)
        last_sell_px = np.full(N_MIN, np.nan, dtype=np.float64)
        last_sell_ts = np.full(N_MIN, np.nan, dtype=np.float64)
        first_buy_px = np.full(N_MIN, np.nan, dtype=np.float64)
        first_buy_ts = np.full(N_MIN, np.nan, dtype=np.float64)
        first_sell_px = np.full(N_MIN, np.nan, dtype=np.float64)
        first_sell_ts = np.full(N_MIN, np.nan, dtype=np.float64)

        if len(indices) > 0:
            present[indices] = True
            buy_usd[indices] = panel_table["buy_usd"].to_numpy(zero_copy_only=False).astype(np.float64)
            sell_usd[indices] = panel_table["sell_usd"].to_numpy(zero_copy_only=False).astype(np.float64)
            last_px[indices] = panel_table["last_px"].cast(pa.float64()).to_numpy(zero_copy_only=False)
            last_buy_px[indices] = panel_table["last_buy_px"].cast(pa.float64()).to_numpy(zero_copy_only=False)
            last_buy_ts[indices] = panel_table["last_buy_ts"].cast(pa.float64()).to_numpy(zero_copy_only=False)
            last_sell_px[indices] = panel_table["last_sell_px"].cast(pa.float64()).to_numpy(zero_copy_only=False)
            last_sell_ts[indices] = panel_table["last_sell_ts"].cast(pa.float64()).to_numpy(zero_copy_only=False)
            first_buy_px[indices] = panel_table["first_buy_px"].cast(pa.float64()).to_numpy(zero_copy_only=False)
            first_buy_ts[indices] = panel_table["first_buy_ts"].cast(pa.float64()).to_numpy(zero_copy_only=False)
            first_sell_px[indices] = panel_table["first_sell_px"].cast(pa.float64()).to_numpy(zero_copy_only=False)
            first_sell_ts[indices] = panel_table["first_sell_ts"].cast(pa.float64()).to_numpy(zero_copy_only=False)

        liq_tbl = self._get_liq_table()
        liq_sell_usd = np.zeros(N_MIN, dtype=np.float64)
        liq_buy_usd = np.zeros(N_MIN, dtype=np.float64)
        n_liq_sell = np.zeros(N_MIN, dtype=np.int32)
        n_liq_buy = np.zeros(N_MIN, dtype=np.int32)

        if liq_tbl.num_rows > 0:
            mask = pc.equal(liq_tbl["market_id"], market_id)
            sub_liq = liq_tbl.filter(mask)
            if sub_liq.num_rows > 0:
                liq_minutes = sub_liq["minute"].to_numpy(zero_copy_only=False)
                if np.any((liq_minutes < GRID0_MS) | (liq_minutes >= lock.HARD_END_MS)):
                    raise DataError(f"liquidation minute outside span for market {market_id}")
                if np.any(liq_minutes % 60_000 != 0):
                    raise DataError(f"liquidation minute not aligned to 60s for market {market_id}")
                liq_indices = (liq_minutes - GRID0_MS) // 60_000
                if len(np.unique(liq_indices)) != len(liq_indices):
                    raise DataError(f"duplicate liquidation minute for market {market_id}")
                absent_mask = ~present[liq_indices]
                if np.any(absent_mask):
                    missing_min = int(liq_minutes[absent_mask][0])
                    raise DataError(f"liquidation minute {missing_min} has no fold row for market {market_id}")

                liq_sell_usd[liq_indices] = sub_liq["liq_sell_usd"].to_numpy(zero_copy_only=False).astype(np.float64)
                liq_buy_usd[liq_indices] = sub_liq["liq_buy_usd"].to_numpy(zero_copy_only=False).astype(np.float64)
                n_liq_sell[liq_indices] = sub_liq["n_liq_sell"].to_numpy(zero_copy_only=False).astype(np.int32)
                n_liq_buy[liq_indices] = sub_liq["n_liq_buy"].to_numpy(zero_copy_only=False).astype(np.int32)

        md = MarketData(
            market_id=market_id,
            symbol=symbol,
            market_type=market_type,
            present=present,
            buy_usd=buy_usd,
            sell_usd=sell_usd,
            last_px=last_px,
            last_buy_px=last_buy_px,
            last_buy_ts=last_buy_ts,
            last_sell_px=last_sell_px,
            last_sell_ts=last_sell_ts,
            first_buy_px=first_buy_px,
            first_buy_ts=first_buy_ts,
            first_sell_px=first_sell_px,
            first_sell_ts=first_sell_ts,
            liq_sell_usd=liq_sell_usd,
            liq_buy_usd=liq_buy_usd,
            n_liq_sell=n_liq_sell,
            n_liq_buy=n_liq_buy,
        )
        self._market_cache[market_id] = md
        return md

    def funding(self, market_id: int) -> tuple[np.ndarray, np.ndarray]:
        """Read funding timestamps and rates for one market strictly before HARD_END_MS."""
        if market_id in self._funding_cache:
            return self._funding_cache[market_id]

        funding_file = self.funding_dir / f"market_{market_id}.parquet"
        if not funding_file.is_file():
            empty = (np.array([], dtype=np.int64), np.array([], dtype=np.float64))
            self._funding_cache[market_id] = empty
            return empty

        if market_id not in self._funding_manifest:
            raise DataError(f"market {market_id} has funding file but no manifest line")

        entry = self._funding_manifest[market_id]
        status = entry.get("status")
        if status != "ok":
            raise DataError(f"funding status for market {market_id} is {status!r}, expected 'ok'")

        actual_sha = sha256_file(funding_file)
        self._record_file(funding_file, actual_sha)

        hard_end_s = lock.HARD_END_MS // 1000
        table = pq.read_table(
            funding_file,
            columns=["timestamp", "rate_long_pays"],
            filters=[("timestamp", "<", hard_end_s)],
        )

        ts = table["timestamp"].to_numpy(zero_copy_only=False).astype(np.int64)
        rate = table["rate_long_pays"].to_numpy(zero_copy_only=False).astype(np.float64)

        mask = (ts * 1000) < lock.HARD_END_MS
        ts = ts[mask]
        rate = rate[mask]

        if len(ts) > 1:
            diffs = np.diff(ts)
            if np.any(diffs <= 0):
                raise DataError(f"funding timestamps for market {market_id} not sorted or unique")

        res = (ts, rate)
        self._funding_cache[market_id] = res
        return res

    def liq_summary(self) -> dict[str, Any]:
        """Aggregate liquidation counters across days in the study span."""
        n_days = len(self._liq_days)
        rows_side_inconsistent = 0
        rows_side_unchecked = 0
        liquidation_rows = 0
        for day in self._liq_days:
            date_str = day.isoformat()
            entry = self._liq_manifest_by_date.get(date_str, {})
            rows_side_inconsistent += int(entry.get("rows_side_inconsistent", 0))
            rows_side_unchecked += int(entry.get("rows_side_unchecked", 0))
            liquidation_rows += int(entry.get("liquidation_rows", 0))
        return {
            "days": n_days,
            "rows_side_inconsistent": rows_side_inconsistent,
            "rows_side_unchecked": rows_side_unchecked,
            "liquidation_rows": liquidation_rows,
        }

    def files_read(self) -> dict[str, str]:
        """Relative path to sha256 of every file opened so far."""
        return dict(self._files_read)
