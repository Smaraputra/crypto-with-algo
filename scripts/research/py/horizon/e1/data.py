"""Guarded file reader and in-memory store for Binance klines and funding files (rule 13)."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from horizon.e1 import lock

SYMBOL_RE = re.compile(r"^[A-Z0-9]{1,20}USDT$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

KLINE_HEADER = [
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
FUNDING_HEADER = ["calc_time", "funding_interval_hours", "last_funding_rate"]


class DataError(RuntimeError):
    """Raised when an input file is missing, corrupt or refused by a guard."""


@dataclass(frozen=True)
class Bars:
    """Equal-length 1m bar arrays, sorted by open_time, unique."""

    open_time: np.ndarray  # int64 epoch ms
    open: np.ndarray  # float64
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray

    def __len__(self) -> int:
        return len(self.open_time)

    @classmethod
    def empty(cls) -> Bars:
        return cls(
            open_time=np.array([], dtype=np.int64),
            open=np.array([], dtype=np.float64),
            high=np.array([], dtype=np.float64),
            low=np.array([], dtype=np.float64),
            close=np.array([], dtype=np.float64),
            volume=np.array([], dtype=np.float64),
        )

    def slice_ms(self, start_ms: int, end_ms: int) -> Bars:
        """Slice bars for open_time in [start_ms, end_ms] (both inclusive)."""
        mask = (self.open_time >= start_ms) & (self.open_time <= end_ms)
        return Bars(
            open_time=self.open_time[mask],
            open=self.open[mask],
            high=self.high[mask],
            low=self.low[mask],
            close=self.close[mask],
            volume=self.volume[mask],
        )

    def index_of(self, ms: int) -> int:
        """Position of the bar whose open_time == ms, or -1."""
        idx = int(np.searchsorted(self.open_time, ms))
        if idx < len(self.open_time) and self.open_time[idx] == ms:
            return idx
        return -1


@dataclass(frozen=True)
class Funding:
    """Funding rate settlement series, sorted by calc_time, unique."""

    calc_time: np.ndarray  # int64
    interval_hours: np.ndarray  # float64, NaN when empty
    rate: np.ndarray  # float64

    def __len__(self) -> int:
        return len(self.calc_time)

    @classmethod
    def empty(cls) -> Funding:
        return cls(
            calc_time=np.array([], dtype=np.int64),
            interval_hours=np.array([], dtype=np.float64),
            rate=np.array([], dtype=np.float64),
        )


class Store:
    """Guarded reader and cache for Binance klines and funding files."""

    def __init__(self, data_dir: Path | str, *, verify_hashes: bool = True) -> None:
        self.data_dir = Path(data_dir)
        self.verify_hashes = verify_hashes
        self._manifest: dict[tuple[str, str, str], dict] = {}
        self._kline_cache: dict[tuple[str, str], Bars | None] = {}
        self._funding_cache: dict[tuple[str, str], Funding | None] = {}
        self._files_read: dict[str, str] = {}

        manifest_path = self.data_dir / "manifest.jsonl"
        if not manifest_path.is_file():
            raise DataError(f"manifest file missing: {manifest_path}")

        try:
            with open(manifest_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except Exception:
                        # Torn last line is ignored
                        continue
                    if not isinstance(entry, dict):
                        continue
                    kind = entry.get("kind")
                    symbol = entry.get("symbol")
                    date = entry.get("date")
                    if kind in ("klines", "funding") and isinstance(symbol, str) and isinstance(date, str):
                        self._manifest[(kind, symbol, date)] = entry
        except Exception as exc:
            if isinstance(exc, DataError):
                raise
            raise DataError(f"failed to read manifest {manifest_path}: {exc}") from exc

    def plan_problems(self, plan: dict) -> list[str]:
        """Plan jobs whose manifest line is absent, not ok, or records duplicates or bad rows (no file is opened).

        A listed kline day that failed to download, or a file the downloader had to repair, stops the run: it is never
        an exclusion (rule 2). A funding month the archive does not have is a funding gap, not a stop (rule 7).
        """
        problems: list[str] = []
        for kind, jobs, field in (
            ("klines", plan.get("klines", []), "day"),
            ("funding", plan.get("funding", []), "month"),
        ):
            for job in jobs:
                key = (kind, job["symbol"], job[field])
                label = f"{kind} {job['symbol']} {job[field]}"
                entry = self._manifest.get(key)
                if entry is None:
                    problems.append(f"{label}: no manifest line")
                elif kind == "funding" and entry.get("status") == "missing":
                    # Rule 7: a funding month the archive does not have leaves its settlements missing. The pair is
                    # flagged funding_gap and kept, so this is never a stop (a missing kline day is).
                    continue
                elif entry.get("status") != "ok":
                    problems.append(f"{label}: manifest status {entry.get('status')!r}")
                elif entry.get("duplicates", 0) or entry.get("badRows", 0):
                    problems.append(
                        f"{label}: manifest records {entry.get('duplicates', 0)} duplicates and "
                        f"{entry.get('badRows', 0)} bad rows"
                    )
        return problems

    def klines(self, symbol: str, day: str) -> Bars | None:
        """Read 1m klines for one symbol and UTC day."""
        if not SYMBOL_RE.match(symbol):
            raise DataError(f"invalid symbol '{symbol}': {symbol} {day}")
        if not DAY_RE.match(day):
            raise DataError(f"invalid day shape '{day}': {symbol} {day}")
        try:
            d = dt.date.fromisoformat(day)
        except ValueError as exc:
            raise DataError(f"invalid calendar day '{day}': {symbol} {day}") from exc

        if d > lock.HARD_LAST_DATE:
            raise DataError(f"day {day} is after HARD_LAST_DATE {lock.HARD_LAST_DATE}: {symbol} {day}")

        cache_key = (symbol, day)
        if cache_key in self._kline_cache:
            return self._kline_cache[cache_key]

        manifest_key = ("klines", symbol, day)
        if manifest_key not in self._manifest:
            raise DataError(f"no manifest line for klines {symbol} {day}")

        manifest_entry = self._manifest[manifest_key]
        status = manifest_entry.get("status")
        if status == "missing":
            self._kline_cache[cache_key] = None
            return None
        if status != "ok":
            raise DataError(f"unexpected manifest status '{status}' for klines {symbol} {day}")

        rel_path = f"klines/{symbol}/{symbol}-1m-{day}.csv.gz"
        file_path = self.data_dir / "klines" / symbol / f"{symbol}-1m-{day}.csv.gz"
        if not file_path.is_file():
            raise DataError(f"file absent from disk: {file_path} for {symbol} {day}")

        try:
            raw_bytes = file_path.read_bytes()
        except OSError as exc:
            raise DataError(f"cannot read file {file_path} for {symbol} {day}: {exc}") from exc

        actual_sha256 = hashlib.sha256(raw_bytes).hexdigest()
        if self.verify_hashes:
            expected_sha256 = manifest_entry.get("sha256")
            if expected_sha256 is None or actual_sha256 != expected_sha256:
                raise DataError(
                    f"sha256 mismatch for klines {symbol} {day}: expected {expected_sha256}, got {actual_sha256}"
                )

        try:
            decompressed = gzip.decompress(raw_bytes).decode("utf-8")
        except Exception as exc:
            raise DataError(f"failed to decompress {file_path} for {symbol} {day}: {exc}") from exc

        lines = decompressed.splitlines()
        if len(lines) == 0:
            raise DataError(f"empty klines file for {symbol} {day}")

        header = lines[0].strip().split(",")
        if header != KLINE_HEADER:
            raise DataError(
                f"header mismatch for klines {symbol} {day}: expected {','.join(KLINE_HEADER)}, got {lines[0]}"
            )

        rows = [line.strip().split(",") for line in lines[1:] if line.strip()]
        if not rows:
            bars = Bars.empty()
        else:
            try:
                open_time = np.array([int(r[0]) for r in rows], dtype=np.int64)
                open_p = np.array([float(r[1]) for r in rows], dtype=np.float64)
                high_p = np.array([float(r[2]) for r in rows], dtype=np.float64)
                low_p = np.array([float(r[3]) for r in rows], dtype=np.float64)
                close_p = np.array([float(r[4]) for r in rows], dtype=np.float64)
                volume = np.array([float(r[5]) for r in rows], dtype=np.float64)
            except (ValueError, IndexError) as exc:
                raise DataError(f"invalid row data in klines {symbol} {day}: {exc}") from exc

            day_start_ms = int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.UTC).timestamp() * 1000)
            day_end_ms = day_start_ms + 86_400_000
            if open_time.min() < day_start_ms or open_time.max() >= day_end_ms:
                raise DataError(f"row open_time outside UTC day for klines {symbol} {day}")

            if len(open_time) > 1:
                diffs = np.diff(open_time)
                if np.any(diffs < 0):
                    raise DataError(f"unsorted rows in klines {symbol} {day}")
                if np.any(diffs == 0):
                    raise DataError(f"duplicate open_time in klines {symbol} {day}")

            bars = Bars(
                open_time=open_time,
                open=open_p,
                high=high_p,
                low=low_p,
                close=close_p,
                volume=volume,
            )

        self._files_read[rel_path] = actual_sha256
        self._kline_cache[cache_key] = bars
        return bars

    def bars(self, symbol: str, start_ms: int, end_ms: int) -> Bars:
        """Concatenate daily files covering [start_ms, end_ms] and slice."""
        if not SYMBOL_RE.match(symbol):
            raise DataError(f"invalid symbol '{symbol}'")
        if start_ms > end_ms:
            raise DataError(f"start_ms {start_ms} > end_ms {end_ms} for {symbol}")

        start_day = dt.datetime.fromtimestamp(start_ms / 1000, tz=dt.UTC).date()
        end_day = dt.datetime.fromtimestamp(end_ms / 1000, tz=dt.UTC).date()

        if end_day > lock.HARD_LAST_DATE:
            raise DataError(
                f"requested span extends to {end_day.isoformat()}, after HARD_LAST_DATE {lock.HARD_LAST_DATE}: "
                f"{symbol} {end_day.isoformat()}"
            )

        curr = start_day
        bars_list: list[Bars] = []
        while curr <= end_day:
            day_str = curr.isoformat()
            day_bars = self.klines(symbol, day_str)
            if day_bars is not None and len(day_bars) > 0:
                bars_list.append(day_bars)
            curr += dt.timedelta(days=1)

        if not bars_list:
            merged = Bars.empty()
        elif len(bars_list) == 1:
            merged = bars_list[0]
        else:
            merged = Bars(
                open_time=np.concatenate([b.open_time for b in bars_list]),
                open=np.concatenate([b.open for b in bars_list]),
                high=np.concatenate([b.high for b in bars_list]),
                low=np.concatenate([b.low for b in bars_list]),
                close=np.concatenate([b.close for b in bars_list]),
                volume=np.concatenate([b.volume for b in bars_list]),
            )

        return merged.slice_ms(start_ms, end_ms)

    def funding_month(self, symbol: str, month: str) -> Funding | None:
        """Read funding settlements for one symbol and calendar month."""
        if not SYMBOL_RE.match(symbol):
            raise DataError(f"invalid symbol '{symbol}': {symbol} {month}")
        if not MONTH_RE.match(month):
            raise DataError(f"invalid month shape '{month}': {symbol} {month}")

        y, m = map(int, month.split("-"))
        first_day = dt.date(y, m, 1)
        if first_day > lock.HARD_LAST_DATE:
            raise DataError(f"month {month} first day is after HARD_LAST_DATE {lock.HARD_LAST_DATE}: {symbol} {month}")

        cache_key = (symbol, month)
        if cache_key in self._funding_cache:
            return self._funding_cache[cache_key]

        manifest_key = ("funding", symbol, month)
        if manifest_key not in self._manifest:
            raise DataError(f"no manifest line for funding {symbol} {month}")

        entry = self._manifest[manifest_key]
        status = entry.get("status")
        if status == "missing":
            self._funding_cache[cache_key] = None
            return None
        if status != "ok":
            raise DataError(f"unexpected manifest status '{status}' for funding {symbol} {month}")

        rel_path = f"funding/{symbol}/{symbol}-fundingRate-{month}.csv.gz"
        file_path = self.data_dir / "funding" / symbol / f"{symbol}-fundingRate-{month}.csv.gz"
        if not file_path.is_file():
            raise DataError(f"file absent from disk: {file_path} for {symbol} {month}")

        try:
            raw_bytes = file_path.read_bytes()
        except OSError as exc:
            raise DataError(f"cannot read file {file_path} for {symbol} {month}: {exc}") from exc

        actual_sha256 = hashlib.sha256(raw_bytes).hexdigest()
        if self.verify_hashes:
            expected_sha256 = entry.get("sha256")
            if expected_sha256 is None or actual_sha256 != expected_sha256:
                raise DataError(
                    f"sha256 mismatch for funding {symbol} {month}: expected {expected_sha256}, got {actual_sha256}"
                )

        try:
            decompressed = gzip.decompress(raw_bytes).decode("utf-8")
        except Exception as exc:
            raise DataError(f"failed to decompress {file_path} for {symbol} {month}: {exc}") from exc

        lines = decompressed.splitlines()
        if len(lines) == 0:
            raise DataError(f"empty funding file for {symbol} {month}")

        header = lines[0].strip().split(",")
        if header != FUNDING_HEADER:
            raise DataError(
                f"header mismatch for funding {symbol} {month}: expected {','.join(FUNDING_HEADER)}, got {lines[0]}"
            )

        hard_last_month = lock.HARD_LAST_DATE.strftime("%Y-%m")
        is_hard_last_month = month == hard_last_month
        day_after = lock.HARD_LAST_DATE + dt.timedelta(days=1)
        hard_limit_ms = int(
            dt.datetime(day_after.year, day_after.month, day_after.day, tzinfo=dt.UTC).timestamp() * 1000
        )

        calc_times: list[int] = []
        intervals: list[float] = []
        rates: list[float] = []

        for line in lines[1:]:
            line = line.strip()
            if not line:
                continue
            parts = line.split(",")
            if len(parts) != 3:
                raise DataError(f"invalid row in funding {symbol} {month}: {line}")
            try:
                t = int(parts[0])
            except ValueError as exc:
                raise DataError(f"invalid calc_time in funding {symbol} {month}: {parts[0]}") from exc

            if is_hard_last_month and t >= hard_limit_ms:
                continue

            interval_str = parts[1].strip()
            if not interval_str:
                interval = float("nan")
            else:
                try:
                    interval = float(interval_str)
                except ValueError as exc:
                    raise DataError(f"invalid funding_interval_hours in funding {symbol} {month}: {parts[1]}") from exc

            rate_str = parts[2].strip()
            try:
                rate = float(rate_str)
            except ValueError as exc:
                raise DataError(f"unparseable rate in funding {symbol} {month}: {parts[2]}") from exc

            calc_times.append(t)
            intervals.append(interval)
            rates.append(rate)

        if len(calc_times) > 1:
            diffs = np.diff(calc_times)
            if np.any(diffs < 0):
                raise DataError(f"unsorted rows in funding {symbol} {month}")
            if np.any(diffs == 0):
                raise DataError(f"duplicate calc_time in funding {symbol} {month}")

        funding = Funding(
            calc_time=np.array(calc_times, dtype=np.int64),
            interval_hours=np.array(intervals, dtype=np.float64),
            rate=np.array(rates, dtype=np.float64),
        )
        self._files_read[rel_path] = actual_sha256
        self._funding_cache[cache_key] = funding
        return funding

    def funding(self, symbol: str, start_ms: int, end_ms: int) -> Funding:
        """Merge monthly funding series covering [start_ms, end_ms] and restrict."""
        if not SYMBOL_RE.match(symbol):
            raise DataError(f"invalid symbol '{symbol}'")
        if start_ms > end_ms:
            raise DataError(f"start_ms {start_ms} > end_ms {end_ms} for {symbol}")

        start_dt = dt.datetime.fromtimestamp(start_ms / 1000, tz=dt.UTC)
        end_dt = dt.datetime.fromtimestamp(end_ms / 1000, tz=dt.UTC)

        cur_y, cur_m = start_dt.year, start_dt.month
        end_y, end_m = end_dt.year, end_dt.month

        months: list[str] = []
        while (cur_y, cur_m) <= (end_y, end_m):
            months.append(f"{cur_y:04d}-{cur_m:02d}")
            if cur_m == 12:
                cur_y += 1
                cur_m = 1
            else:
                cur_m += 1

        funding_list: list[Funding] = []
        for m_str in months:
            m_fund = self.funding_month(symbol, m_str)
            if m_fund is not None and len(m_fund.calc_time) > 0:
                funding_list.append(m_fund)

        if not funding_list:
            merged = Funding.empty()
        elif len(funding_list) == 1:
            merged = funding_list[0]
        else:
            merged = Funding(
                calc_time=np.concatenate([f.calc_time for f in funding_list]),
                interval_hours=np.concatenate([f.interval_hours for f in funding_list]),
                rate=np.concatenate([f.rate for f in funding_list]),
            )

        mask = (merged.calc_time >= start_ms) & (merged.calc_time <= end_ms)
        return Funding(
            calc_time=merged.calc_time[mask],
            interval_hours=merged.interval_hours[mask],
            rate=merged.rate[mask],
        )

    def files_read(self) -> dict[str, str]:
        """Relative path to sha256 of gzip bytes for every file opened so far."""
        return dict(self._files_read)
