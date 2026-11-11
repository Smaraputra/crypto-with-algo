"""Lighter stage 2: every input file read happens in this module, behind the span guards of lighter/lock.py.

Guards (no override flag exists):
- Nothing dated 2026-11-01 or later is ever read (NEVER_READ_FROM).
- A reader opened in "dev" mode cannot read past 2026-06-30. A reader in "confirm" mode can read through 2026-10-31.
- Rows are filtered at read time (the funding file is read with a timestamp filter), so rows beyond the allowed end
  never enter memory.
- A fold day absent from the fold manifest (or whose file is absent) is an error, unless the date is listed in
  lock.KNOWN_MISSING_FOLD_DAYS.

Each file read is recorded in the reader's manifest with its sha256 (funding: the sha256 of the allowed rows only, so
the hash never covers a byte beyond the guard). Paths in the manifest are relative to their input directory.

The eligibility reads (`month_cost_stats`) open only the cost and activity columns of the fold (ELIGIBILITY_COLUMNS) and
only check that Binance files exist. They never open a first-print price, a vwap or a Binance file.
"""

from __future__ import annotations

import calendar
import datetime as dt
import gzip
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from lighter import lock
from lighter.fold_trades import day_start_ms

MINUTE_MS = lock.MINUTE_MS
DAY_MS = lock.DAY_MS
# Literal, not taken from lock.py, so no other module can relax it: no input dated on or after this day is read.
NEVER_READ_FROM = dt.date(2026, 11, 1)

BINANCE_COLUMNS = ("open_time", "close", "quote_volume", "taker_buy_quote")
ELIGIBILITY_COLUMNS = ("market_id", "n_trades", "last_buy_px", "last_buy_ts", "last_sell_px", "last_sell_ts")
FOLD_COLUMNS = (
    "market_id",
    "minute",
    "buy_usd_lt_1k",
    "sell_usd_lt_1k",
    "buy_usd_10k_100k",
    "buy_usd_ge_100k",
    "sell_usd_10k_100k",
    "sell_usd_ge_100k",
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


class SpanError(RuntimeError):
    """A read was refused by a span guard."""


class DataError(RuntimeError):
    """An input file is missing or unusable."""


@dataclass(frozen=True)
class Market:
    symbol: str
    market_id: int
    price_decimals: int

    @property
    def coin(self) -> str:
        return self.symbol

    @property
    def cls(self) -> str:
        return lock.symbol_class(self.symbol)

    @property
    def is_leader(self) -> bool:
        return lock.is_leader(self.symbol)

    @property
    def binance_symbol(self) -> str | None:
        return lock.binance_symbol(self.symbol)


@dataclass
class MinuteData:
    """Dense per-minute arrays of one market from t0_ms. Absent values are NaN (flags are False, flows are 0)."""

    market: Market
    t0_ms: int
    n: int
    last_px: np.ndarray
    last_buy_px: np.ndarray
    last_sell_px: np.ndarray
    last_buy_ts: np.ndarray
    last_sell_ts: np.ndarray
    first_buy_px: np.ndarray
    first_sell_px: np.ndarray
    first_buy_ts: np.ndarray
    first_sell_ts: np.ndarray
    buy_small: np.ndarray
    sell_small: np.ndarray
    buy_large: np.ndarray
    sell_large: np.ndarray
    b_has: np.ndarray
    b_close: np.ndarray
    b_qv: np.ndarray
    b_tbq: np.ndarray

    @property
    def has_print(self) -> np.ndarray:
        return ~np.isnan(self.last_px)

    def slice(self, start_minute: int, end_minute: int | None = None) -> MinuteData:
        """The minutes start_minute .. end_minute - 1 as a new MinuteData (t0 moves with it)."""
        end = self.n if end_minute is None else end_minute
        kw = {
            name: getattr(self, name)[start_minute:end]
            for name in (
                "last_px",
                "last_buy_px",
                "last_sell_px",
                "last_buy_ts",
                "last_sell_ts",
                "first_buy_px",
                "first_sell_px",
                "first_buy_ts",
                "first_sell_ts",
                "buy_small",
                "sell_small",
                "buy_large",
                "sell_large",
                "b_has",
                "b_close",
                "b_qv",
                "b_tbq",
            )
        }
        return MinuteData(market=self.market, t0_ms=self.t0_ms + start_minute * MINUTE_MS, n=end - start_minute, **kw)


@dataclass
class CostStats:
    """What the eligibility rule reads about one market in one month."""

    activity_median: float
    qualifying_minutes: int
    spread_proxy_bps: float


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def month_range(first: tuple[int, int], last: tuple[int, int]) -> list[tuple[int, int]]:
    out = []
    y, m = first
    while (y, m) <= (last[0], last[1]):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def month_days(year: int, month: int) -> list[dt.date]:
    return [dt.date(year, month, d) for d in range(1, calendar.monthrange(year, month)[1] + 1)]


def read_json(path: str | Path) -> Any:
    """Reads a small JSON input (finalists, earlier results). Not subject to the span guards."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class DataReader:
    """Reads fold, Binance and funding inputs for one study mode ("dev" or "confirm")."""

    def __init__(
        self,
        *,
        fold_dir: str | Path,
        binance_dir: str | Path | None = None,
        funding_dir: str | Path | None = None,
        mode: str,
        last_date: dt.date | None = None,
    ) -> None:
        if mode not in ("dev", "confirm"):
            raise SpanError(f"unknown mode {mode!r}")
        mode_last = lock.DEV_LAST_DATE if mode == "dev" else lock.CONFIRM_LAST_DATE
        mode_last = min(mode_last, NEVER_READ_FROM - dt.timedelta(days=1))
        if last_date is None:
            last_date = mode_last
        if last_date > mode_last:
            raise SpanError(f"mode {mode} cannot read past {mode_last}, asked for {last_date}")
        self.mode = mode
        self.last_date = last_date
        self.end_ms = day_start_ms(last_date) + DAY_MS
        self.fold_dir = Path(fold_dir)
        self.binance_dir = None if binance_dir is None else Path(binance_dir)
        self.funding_dir = None if funding_dir is None else Path(funding_dir)
        self._hash_cache: dict[Path, str] = {}
        self._fold_days: set[str] | None = None
        self.manifest: dict[str, str] = {}
        self._missing_months: set[str] = set()
        self._known_missing: set[str] = set()
        self._off_grid: dict[int, int] = {}
        self._cost_cache: dict[tuple[int, int], dict[int, CostStats]] = {}
        self.fold_market_ids: set[int] = set()

    # ------------------------------------------------------------------ guards

    def check_day(self, day: dt.date) -> None:
        if day >= NEVER_READ_FROM:
            raise SpanError(f"{day} is in the reserved forward sample (from {NEVER_READ_FROM}): never read")
        if day > self.last_date:
            raise SpanError(f"mode {self.mode} cannot read {day} (last readable day {self.last_date})")

    def check_end_ms(self, end_ms: int) -> None:
        if end_ms > self.end_ms:
            raise SpanError(f"mode {self.mode} cannot read up to {end_ms} (limit {self.end_ms})")
        if end_ms > day_start_ms(NEVER_READ_FROM):
            raise SpanError("nothing at or after 2026-11-01 is ever read")

    # ------------------------------------------------------------------ manifest

    def _record(self, label: str, path: Path, digest: str | None = None) -> None:
        if digest is None:
            digest = self._hash_cache.get(path) or sha256_file(path)
            self._hash_cache[path] = digest
        self.manifest[label] = digest

    # ------------------------------------------------------------------ markets and the fold manifest

    def load_markets(self) -> list[Market]:
        """The perp markets of <fold>/markets.json, sorted by market id."""
        path = self.fold_dir / "markets.json"
        if not path.exists():
            raise DataError(f"{path} is missing")
        doc = json.loads(path.read_bytes())
        if int(doc.get("markets_file_version", 0)) < 2:
            raise DataError("markets.json is not markets_file_version 2")
        self._record("fold/markets.json", path)
        out = []
        for b in doc["order_books"]:
            if b.get("market_type") != "perp":
                continue
            if b.get("supported_price_decimals") is None:
                raise DataError(f"market {b.get('symbol')} has no supported_price_decimals")
            try:
                lock.symbol_class(str(b["symbol"]))
            except ValueError as exc:
                raise DataError(str(exc)) from exc
            out.append(Market(str(b["symbol"]), int(b["market_id"]), int(b["supported_price_decimals"])))
        ids = [m.market_id for m in out]
        if len(set(ids)) != len(ids):
            raise DataError("duplicate market ids in markets.json")
        out.sort(key=lambda m: m.market_id)
        return out

    def _manifest_days(self) -> set[str]:
        if self._fold_days is None:
            path = self.fold_dir / "manifest.jsonl"
            if not path.exists():
                raise DataError(f"the fold manifest {path} is missing")
            days: set[str] = set()
            for line in path.read_text().splitlines():
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(rec, dict) and isinstance(rec.get("date"), str):
                    days.add(rec["date"])
            self._fold_days = days
            self._record("fold/manifest.jsonl", path)
        return self._fold_days

    def fold_path(self, day: dt.date) -> Path:
        return self.fold_dir / "v1" / f"date={day.isoformat()}.parquet"

    def fold_day_present(self, day: dt.date) -> bool:
        """True when the day is in the fold manifest and its file exists. A known-missing day is False, not an error."""
        iso = day.isoformat()
        if iso in self._manifest_days() and self.fold_path(day).exists():
            return True
        if iso in lock.KNOWN_MISSING_FOLD_DAYS:
            self._known_missing.add(iso)
            return False
        raise DataError(f"fold day {iso} is absent from the fold manifest or its file is missing")

    def require_fold_days(self, first: dt.date, last: dt.date) -> None:
        day = first
        while day <= last:
            self.check_day(day)
            self.fold_day_present(day)
            day += dt.timedelta(days=1)

    def _read_fold(self, day: dt.date, columns: list[str], market_id: int | None) -> pa.Table | None:
        self.check_day(day)
        if not self.fold_day_present(day):
            return None
        path = self.fold_path(day)
        self._record(f"fold/{path.name}", path)
        filters = None if market_id is None else [("market_id", "==", market_id)]
        return pq.read_table(path, columns=columns, filters=filters)

    # ------------------------------------------------------------------ eligibility inputs

    def month_cost_stats(self, year: int, month: int) -> dict[int, CostStats]:
        """Activity and spread-proxy figures of every market from the fold rows of one calendar month.

        Reads ELIGIBILITY_COLUMNS only. A market with no row in the month is absent from the result.
        """
        key = (year, month)
        if key in self._cost_cache:
            return self._cost_cache[key]
        days = month_days(year, month)
        per_day: dict[int, np.ndarray] = {}
        spreads: dict[int, list[np.ndarray]] = {}
        for i, day in enumerate(days):
            table = self._read_fold(day, list(ELIGIBILITY_COLUMNS), None)
            if table is None or table.num_rows == 0:
                continue
            grouped = table.group_by("market_id").aggregate([("n_trades", "sum")])
            for mid, total in zip(
                grouped.column("market_id").to_numpy(), grouped.column("n_trades_sum").to_numpy(), strict=True
            ):
                per_day.setdefault(int(mid), np.zeros(len(days), dtype=np.int64))[i] = int(total)

            def num(name: str, table: pa.Table = table) -> np.ndarray:
                return pc.cast(table.column(name), pa.float64()).to_numpy(zero_copy_only=False)

            ids = table.column("market_id").to_numpy()
            bp, sp = num("last_buy_px"), num("last_sell_px")
            bt, st = num("last_buy_ts"), num("last_sell_ts")
            with np.errstate(invalid="ignore"):
                ok = ~np.isnan(bp) & ~np.isnan(sp) & (np.abs(bt - st) <= lock.ELIG_MAX_TS_GAP_MS)
            if ok.any():
                b, s, m = bp[ok], sp[ok], ids[ok]
                x = (b - s) * lock.BPS / ((b + s) / 2.0)
                for mid in np.unique(m):
                    spreads.setdefault(int(mid), []).append(x[m == mid])
        out: dict[int, CostStats] = {}
        self.fold_market_ids |= set(per_day)
        for mid, counts in per_day.items():
            xs = np.concatenate(spreads[mid]) if mid in spreads else np.zeros(0)
            proxy = max(0.0, float(np.median(xs))) if len(xs) else float("nan")
            out[mid] = CostStats(float(np.median(counts)), int(len(xs)), proxy)
        self._cost_cache[key] = out
        return out

    # ------------------------------------------------------------------ Binance

    def binance_path(self, symbol: str, year: int, month: int) -> Path:
        if self.binance_dir is None:
            raise DataError("no Binance directory was given")
        return self.binance_dir / symbol / f"{symbol}-1m-{year:04d}-{month:02d}.csv.gz"

    def binance_month_exists(self, symbol: str, year: int, month: int) -> bool:
        """Existence only: no file is opened, so this is allowed for months beyond the mode's last readable day."""
        if self.binance_dir is None:
            return False
        return self.binance_path(symbol, year, month).exists()

    def _load_binance(self, symbol: str, months: set[tuple[int, int]], t0_ms: int, n: int) -> dict[str, np.ndarray]:
        end_ms = t0_ms + n * MINUTE_MS
        self.check_end_ms(end_ms)
        has = np.zeros(n, dtype=bool)
        close = np.full(n, np.nan)
        qv = np.full(n, np.nan)
        tbq = np.full(n, np.nan)
        for y, m in sorted(months):
            path = self.binance_path(symbol, y, m)
            if not path.exists():
                self._missing_months.add(f"{symbol}-{y:04d}-{m:02d}")
                continue
            self._record(f"binance/{symbol}/{path.name}", path)
            with gzip.open(path, "rb") as f:
                frame = pd.read_csv(f, usecols=list(BINANCE_COLUMNS), dtype=np.float64)
            open_time = frame["open_time"].to_numpy(dtype=np.int64)
            m_lo = day_start_ms(dt.date(y, m, 1))
            m_hi = day_start_ms(dt.date(y + (m == 12), 1 if m == 12 else m + 1, 1))
            if len(open_time) and (open_time.min() < m_lo or open_time.max() >= m_hi):
                raise DataError(f"{path.name} holds a row outside its month")
            if len(np.unique(open_time)) != len(open_time):
                raise DataError(f"{path.name} holds a duplicate open_time")
            keep = (open_time >= t0_ms) & (open_time < end_ms) & (open_time % MINUTE_MS == 0)
            idx = (open_time[keep] - t0_ms) // MINUTE_MS
            has[idx] = True
            close[idx] = frame["close"].to_numpy()[keep]
            qv[idx] = frame["quote_volume"].to_numpy()[keep]
            tbq[idx] = frame["taker_buy_quote"].to_numpy()[keep]
        return {"b_has": has, "b_close": close, "b_qv": qv, "b_tbq": tbq}

    # ------------------------------------------------------------------ minutes

    def load_minutes(
        self,
        market: Market,
        t0_ms: int,
        end_ms: int,
        binance_months: set[tuple[int, int]] | None = None,
        binance_symbol: str | None = None,
    ) -> MinuteData:
        """Fold rows of the market (and the given Binance months) from t0_ms (a day start) to end_ms."""
        self.check_end_ms(end_ms)
        if t0_ms % DAY_MS or end_ms % DAY_MS:
            raise DataError("span edges must be UTC day starts")
        n = (end_ms - t0_ms) // MINUTE_MS
        scale = 10.0**market.price_decimals
        floats = {
            k: np.full(n, np.nan)
            for k in (
                "last_px",
                "last_buy_px",
                "last_sell_px",
                "last_buy_ts",
                "last_sell_ts",
                "first_buy_px",
                "first_sell_px",
                "first_buy_ts",
                "first_sell_ts",
            )
        }
        flows = {k: np.zeros(n) for k in ("buy_small", "sell_small", "buy_large", "sell_large")}
        price_cols = ("last_px", "last_buy_px", "last_sell_px", "first_buy_px", "first_sell_px")
        ts_cols = ("last_buy_ts", "last_sell_ts", "first_buy_ts", "first_sell_ts")
        day = dt.datetime.fromtimestamp(t0_ms / 1000, dt.UTC).date()
        last_day = dt.datetime.fromtimestamp((end_ms - 1) / 1000, dt.UTC).date()
        while day <= last_day:
            table = self._read_fold(day, list(FOLD_COLUMNS), market.market_id)
            day += dt.timedelta(days=1)
            if table is None or table.num_rows == 0:
                continue
            minute = table.column("minute").to_numpy()
            keep = (minute >= t0_ms) & (minute < end_ms)
            if not keep.all():
                raise DataError("fold rows outside the requested span")
            idx = (minute - t0_ms) // MINUTE_MS
            for name in price_cols:
                col = pc.cast(table.column(name), pa.float64()).to_numpy(zero_copy_only=False)
                floats[name][idx] = col / scale
            for name in ts_cols:
                floats[name][idx] = pc.cast(table.column(name), pa.float64()).to_numpy(zero_copy_only=False)

            def num(name: str, table: pa.Table = table) -> np.ndarray:
                return table.column(name).to_numpy(zero_copy_only=False)

            flows["buy_small"][idx] = num("buy_usd_lt_1k")
            flows["sell_small"][idx] = num("sell_usd_lt_1k")
            flows["buy_large"][idx] = num("buy_usd_10k_100k") + num("buy_usd_ge_100k")
            flows["sell_large"][idx] = num("sell_usd_10k_100k") + num("sell_usd_ge_100k")
        if binance_months and binance_symbol:
            b = self._load_binance(binance_symbol, binance_months, t0_ms, n)
        else:
            b = {
                "b_has": np.zeros(n, dtype=bool),
                "b_close": np.full(n, np.nan),
                "b_qv": np.full(n, np.nan),
                "b_tbq": np.full(n, np.nan),
            }
        return MinuteData(market=market, t0_ms=t0_ms, n=n, **floats, **flows, **b)

    # ------------------------------------------------------------------ funding

    def funding_path(self, market_id: int) -> Path:
        if self.funding_dir is None:
            raise DataError("no funding directory was given")
        direct = self.funding_dir / f"market_{market_id}.parquet"
        nested = self.funding_dir / "funding" / f"market_{market_id}.parquet"
        return nested if (not direct.exists() and nested.exists()) else direct

    def funding_exists(self, market_id: int) -> bool:
        return self.funding_dir is not None and self.funding_path(market_id).exists()

    def load_funding(self, market_id: int, end_ms: int) -> tuple[np.ndarray, np.ndarray]:
        """Settlement times (ms) and rate_long_pays, only rows with a timestamp before end_ms. Empty when no file."""
        self.check_end_ms(end_ms)
        if not self.funding_exists(market_id):
            return np.zeros(0, dtype=np.int64), np.zeros(0)
        path = self.funding_path(market_id)
        table = pq.read_table(
            path, columns=["timestamp", "rate_long_pays"], filters=[("timestamp", "<", end_ms // 1000)]
        )
        ts = table.column("timestamp").to_numpy().astype(np.int64) * 1000
        rate = table.column("rate_long_pays").to_numpy(zero_copy_only=False).astype(np.float64)
        order = np.argsort(ts, kind="stable")
        ts, rate = ts[order], rate[order]
        self._off_grid[market_id] = int(np.count_nonzero(ts % lock.HOUR_MS))
        digest = sha256_bytes(ts.tobytes() + rate.tobytes())
        self._record(f"funding/{path.name}", path, digest)
        return ts, rate

    @property
    def quality(self) -> dict[str, Any]:
        """Data-quality counters of everything read so far (sets, so repeated reads do not double count)."""
        return {
            "known_missing_fold_days": sorted(self._known_missing),
            "missing_binance_months": len(self._missing_months),
            "missing_binance_months_first": sorted(self._missing_months)[:20],
            "funding_off_grid_rows": sum(self._off_grid.values()),
        }

    def sorted_manifest(self) -> dict[str, str]:
        return dict(sorted(self.manifest.items()))


SYNTHETIC_MARKER = "SYNTHETIC"


def is_synthetic(fold_dir: str | Path) -> bool:
    """True when the fold directory holds the marker file written by lighter/synthetic.py."""
    return (Path(fold_dir) / SYNTHETIC_MARKER).exists()


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    os.makedirs(p, exist_ok=True)
    return p


__all__ = [
    "DataError",
    "DataReader",
    "Market",
    "MinuteData",
    "SpanError",
    "ensure_dir",
    "month_range",
    "read_json",
]
