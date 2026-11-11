"""LIGHTER TRADE ARCHIVE FOLD v1: per-minute bars from the public Lighter trade archive, for a later backtest that
needs signals and taker fill prices. Written 2026-11-11. This module computes no strategy outcome and reads no price
for any decision; it only reshapes the archive.

SOURCE
- One Parquet file per UTC day:
  https://aws-public-blockchain.s3.amazonaws.com/v1.1/lighter/core/mainnet/trades/date=YYYY-MM-DD/trades.parquet
  (anonymous HTTPS). First day 2025-01-17. About 95 GB in total, 5 MB (early 2025) to about 300 MB (2026) per day, so
  each day is downloaded, folded and deleted (unless --keep-raw).
- Schema observed in the 2025-01-20 file (62,792 rows, one row group): id int64, created_at string, updated_at string,
  ask_account_id int64, bid_account_id int64, size int64, price int64, usdc_amount int64, ask_id int64, bid_id int64,
  l2_block_height int64, timestamp int64 (milliseconds), tx_hash string, market_id int16, trade_type string,
  is_maker_ask bool, plus about 28 more columns (fees, margin, pnl) that are null in old files. Only the eight
  columns in REQUIRED_COLUMNS are read; a missing one fails the day with a clear error.
- price and size are scaled integers per market (decimals in the orderBooks metadata). In the sample size x price ==
  usdc_amount exactly, and usdc_amount / 1e6 is the trade value in USD. The fold keeps prices as the raw integers and
  does not rescale them. The size x price identity is counted per day (rows_size_price_mismatch in the manifest) but
  never enforced.
- is_maker_ask true means the resting order was the ask, so the TAKER BOUGHT. trade_type 'trade' is an ordinary
  match. Every other trade_type (for example 'liquidation') is counted as liquidation flow: it adds to liq_usd and to
  n_trades but never becomes a print (no side, no price field, no band).
- Market metadata (symbol, market_id, decimals, market_type) is fetched once from
  https://mainnet.zklighter.elliot.ai/api/v1/orderBooks into out-dir/markets.json with a fetched_at stamp. Only the
  static fields in MARKET_FIELDS are kept (no open interest or prices, which would be post-cutoff data). A file without
  markets_file_version >= 2 is cleaned in place on the next run; version 2 and 3 files are never rewritten by the fold.
  --complete-markets (version 3) adds the delisted markets that orderBooks omits: every market id present in the folded
  files and missing from the file is looked up in orderBookDetails?market_id=N and appended with the same static fields
  and listed_in_order_books false; an id answering 'invalid market index' goes into unknown_market_ids.

HARD GUARD
- FOLD_LAST_DATE = 2026-10-31. Any later date is refused, with no override flag: later days are a reserved forward
  sample. The guard is checked in the CLI, in every function that takes a date, and on the timestamps inside each file
  (a row at or after 2026-11-01 00:00 UTC fails the day).

OUTPUT: out-dir/v1/date=YYYY-MM-DD.parquet, one row per (market_id, UTC minute) with at least one source row,
sorted by market_id then minute, zstd compressed.
- market_id (int16), minute (int64, ms of the minute start).
- n_trades: every source row in the minute, whatever its trade_type (so the sum over a day equals source rows).
- buy_usd, sell_usd: taker-side USD of 'trade' rows. liq_usd: USD of every other trade_type. USD is usdc_amount / 1e6.
  Sums are accumulated as integers (micro USD) and divided once, so they are exact.
- Size bands by the USD of the single print, 'trade' rows only, one column per side and band holding the USD volume
  in that band: buy_usd_lt_1k, buy_usd_1k_10k, buy_usd_10k_100k, buy_usd_ge_100k and the same four for sell. Bands are
  [0, 1,000), [1,000, 10,000), [10,000, 100,000), [100,000, inf). The four bands of a side sum to its _usd total.
- last_px: raw price of the last 'trade' print in the minute. vwap_px: float, USD-weighted price over 'trade' prints.
- last_buy_px, last_buy_ts, last_sell_px, last_sell_ts: the latest 'trade' print of each taker side in the minute.
- first_buy_px, first_buy_ts, first_sell_px, first_sell_ts: the FIRST 'trade' print of that taker side whose timestamp
  is at or after minute start + FILL_DELAY_MS and still inside the minute. A taker order sent at the minute start
  cannot fill earlier: FILL_DELAY_MS = 500 covers the 300 ms venue delay on taker orders, about 50 ms of network and a
  margin. Null where no such print exists.
- Prints inside a market are ordered by (timestamp, id), whatever the file order. Ties on timestamp resolve by id.
- Bucketing uses the `timestamp` column. The archive's `transaction_time` column runs 0 to 420 ms later than
  `timestamp` (median 22 ms, p99 156 ms, measured on 1M rows of 2026-10-30), so the 500 ms rule is conservative. A print
  in the first 500 ms of a minute is never a fill print for a decision taken at the previous minute boundary.
- A row whose timestamp falls outside the file's UTC day fails the day (it would create duplicate market-minute keys
  across days). The rows_outside_day counter stays in the manifest and is always 0 for a folded day. A file holding
  rows after FOLD_LAST_DATE fails the day and its raw file is deleted at once, even with --keep-raw.
- A minute that holds only liquidation rows has liq_usd and n_trades but null prices.

MEMORY: a 2026 day has several million rows and the job runs with a 2 GB limit. The file is streamed in batches of
BATCH_ROWS rows, only the eight required columns are decoded, and every batch is reduced to per (market, minute)
partials that merge exactly (integer sums, ordered first and last picks), so the working set is one batch plus the
running per-minute state (at most 1,440 rows per market). BATCH_ROWS is part of the fold version because it fixes the
float summation order of vwap_px. Parquet readers decode one row group at a time, so the largest row group bounds peak
memory (the sample file has one row group of 62,792 rows); num_row_groups and the largest group are logged.

MANIFEST: out-dir/manifest.jsonl, one JSON line per folded day (the last line of a date wins): date, source_url,
source_bytes, source_rows, rows_by_trade_type, source_usdc_micro, rows_outside_day, rows_size_price_mismatch,
output_rows, output_sha256, fold_version, elapsed_s, folded_at. A day is skipped when its manifest line has the current
fold_version and the output file exists with the recorded sha256; anything else is redone.

Run: python -m lighter.fold_trades --from 2025-01-17 --to 2026-10-31 --raw-dir RAW --out-dir OUT [--keep-raw]
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

FOLD_VERSION = "v1"
FOLD_LAST_DATE = dt.date(2026, 10, 31)
FIRST_DATE = dt.date(2025, 1, 17)
FILL_DELAY_MS = 500
MINUTE_MS = 60_000
DAY_MS = 86_400_000
BATCH_ROWS = 500_000

ARCHIVE_URL = (
    "https://aws-public-blockchain.s3.amazonaws.com/v1.1/lighter/core/mainnet/trades/date={date}/trades.parquet"
)
ORDER_BOOKS_URL = "https://mainnet.zklighter.elliot.ai/api/v1/orderBooks"
MARKETS_FILE_VERSION = 3
# The fold treats a markets.json at this version or later as final and never rewrites it. Version 2 (static fields of
# the orderBooks list) is what the fold produced while it ran; version 3 adds delisted markets (complete_markets).
MIN_MARKETS_FILE_VERSION = 2
ORDER_BOOK_DETAILS_URL = "https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails"
DETAILS_INTERVAL_S = 2.5
INVALID_MARKET_INDEX = 21602
# Static metadata only. Live fields (open interest, prices) would be post-cutoff data next to a dataset that must
# hold none.
MARKET_FIELDS = (
    "symbol",
    "market_id",
    "market_type",
    "status",
    "supported_price_decimals",
    "supported_size_decimals",
    "min_base_amount",
    "min_quote_amount",
    "created_at",
    "maker_fee",
    "taker_fee",
)

REQUIRED_COLUMNS = ("id", "timestamp", "market_id", "price", "size", "usdc_amount", "is_maker_ask", "trade_type")
TRADE_TYPE = "trade"
MICRO = 1_000_000
# Band edges in micro USD: 1,000, 10,000 and 100,000 USD.
BAND_EDGES_MICRO = np.array([1_000 * MICRO, 10_000 * MICRO, 100_000 * MICRO], dtype=np.int64)
BAND_NAMES = ("lt_1k", "1k_10k", "10k_100k", "ge_100k")
BAND_COLS = tuple(f"{side}_usd_{band}" for side in ("buy", "sell") for band in BAND_NAMES)
# Plausible millisecond epoch range, to catch a unit change (seconds or microseconds) in a later file.
TS_MIN_MS = int(dt.datetime(2024, 1, 1, tzinfo=dt.UTC).timestamp() * 1000)
TS_MAX_MS = int(dt.datetime(2030, 1, 1, tzinfo=dt.UTC).timestamp() * 1000)

_KEY = ["market_id", "minute"]

OUTPUT_SCHEMA = pa.schema(
    [
        ("market_id", pa.int16()),
        ("minute", pa.int64()),
        ("n_trades", pa.int64()),
        ("buy_usd", pa.float64()),
        ("sell_usd", pa.float64()),
        ("liq_usd", pa.float64()),
        *[(c, pa.float64()) for c in BAND_COLS],
        ("last_px", pa.int64()),
        ("vwap_px", pa.float64()),
        ("last_buy_px", pa.int64()),
        ("last_buy_ts", pa.int64()),
        ("last_sell_px", pa.int64()),
        ("last_sell_ts", pa.int64()),
        ("first_buy_px", pa.int64()),
        ("first_buy_ts", pa.int64()),
        ("first_sell_px", pa.int64()),
        ("first_sell_ts", pa.int64()),
    ]
)

# Hooks the tests replace.
_urlopen = urllib.request.urlopen
_sleep = time.sleep
_clock = time.monotonic


class FoldError(RuntimeError):
    """A day cannot be folded or a guard refused a request."""


class ForwardSampleError(FoldError):
    """A file holds rows after FOLD_LAST_DATE (reserved forward sample)."""


class DownloadError(FoldError):
    """A download failed after its retries."""


def parse_date(text: str) -> dt.date:
    try:
        return dt.date.fromisoformat(text)
    except ValueError as exc:
        raise FoldError(f"not a YYYY-MM-DD date: {text!r}") from exc


def check_date(day: dt.date) -> None:
    """Refuse any date after FOLD_LAST_DATE (reserved forward sample) or before the first archive day."""
    if day > FOLD_LAST_DATE:
        raise FoldError(f"date {day} is after {FOLD_LAST_DATE}: later days are a reserved forward sample")
    if day < FIRST_DATE:
        raise FoldError(f"date {day} is before the first archive day {FIRST_DATE}")


def day_start_ms(day: dt.date) -> int:
    return int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.UTC).timestamp() * 1000)


def source_url(day: dt.date) -> str:
    check_date(day)
    return ARCHIVE_URL.format(date=day.isoformat())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def http_get_bytes(url: str, *, retries: int = 5, timeout: float = 60.0) -> bytes:
    """GET a small resource with retries on network errors, 429 and 5xx."""
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cryptowithalgo-research"})
            with _urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in (405, 429, 500, 502, 503, 504):
                raise DownloadError(f"GET {url} failed with HTTP {exc.code}") from exc
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            last = exc
        if attempt < retries:
            _sleep(min(60.0, 2.0**attempt))
    raise DownloadError(f"GET {url} failed after {retries} attempts: {last}")


def fetch_order_books() -> dict[str, Any]:
    payload = json.loads(http_get_bytes(ORDER_BOOKS_URL))
    if "order_books" not in payload or not isinstance(payload["order_books"], list):
        raise FoldError("orderBooks response has no order_books list")
    return payload


def static_market_fields(book: dict[str, Any]) -> dict[str, Any]:
    """Keep only the static metadata of one orderBooks entry (no open interest, price or other live fields)."""
    return {k: book[k] for k in MARKET_FIELDS if k in book}


def _write_json(path: Path, doc: dict[str, Any]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=1))
    os.replace(tmp, path)


def _listed_entries(books: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**static_market_fields(b), "listed_in_order_books": True} for b in books]


def write_markets(out_dir: Path) -> bool:
    """Write out-dir/markets.json with static fields only. Returns True when the file was written or rewritten.

    A file at version MIN_MARKETS_FILE_VERSION or later (including the completed version 3) is left alone. An older or
    unversioned file (the first version stored the whole payload, including live open interest) is cleaned in place
    from its own content, keeping its fetched_at, so no post-cutoff market data stays next to the dataset.
    """
    path = out_dir / "markets.json"
    if path.exists():
        try:
            old = json.loads(path.read_text())
        except json.JSONDecodeError:
            old = None
        if isinstance(old, dict) and old.get("markets_file_version", 0) >= MIN_MARKETS_FILE_VERSION:
            return False
        if isinstance(old, dict) and isinstance(old.get("order_books"), list):
            _write_json(
                path,
                {
                    "markets_file_version": MARKETS_FILE_VERSION,
                    "fetched_at": old.get("fetched_at"),
                    "source": ORDER_BOOKS_URL,
                    "order_books": _listed_entries(old["order_books"]),
                    "unknown_market_ids": [],
                },
            )
            return True
    payload = fetch_order_books()
    _write_json(
        path,
        {
            "markets_file_version": MARKETS_FILE_VERSION,
            "fetched_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "source": ORDER_BOOKS_URL,
            "order_books": _listed_entries(payload["order_books"]),
            "unknown_market_ids": [],
        },
    )
    return True


class Pacer:
    """Blocks so that calls are at least min_interval seconds apart."""

    def __init__(self, min_interval: float = DETAILS_INTERVAL_S) -> None:
        self.min_interval = min_interval
        self._last: float | None = None

    def wait(self) -> None:
        now = _clock()
        if self._last is not None:
            gap = self.min_interval - (now - self._last)
            if gap > 0:
                _sleep(gap)
        self._last = _clock()


def folded_market_ids(out_dir: Path) -> set[int]:
    """Every market id present in the folded files (reads the market_id column only)."""
    files = sorted((out_dir / FOLD_VERSION).glob("date=*.parquet"))
    if not files:
        raise FoldError(f"no folded files under {out_dir / FOLD_VERSION}")
    ids: set[int] = set()
    for f in files:
        ids.update(int(x) for x in pc.unique(pq.read_table(f, columns=["market_id"]).column("market_id")).to_pylist())
    return ids


def fetch_market_details(market_id: int, pacer: Pacer, *, retries: int = 6) -> dict[str, Any] | None:
    """Static entry for one market from orderBookDetails, or None for an invalid market index.

    Handles both the perp list (order_book_details) and the spot list (spot_order_book_details). Rate limiting (HTTP
    405 and 429) and 5xx are retried with backoff, Retry-After honoured. An invalid index answers HTTP 400 with code
    21602 in the body.
    """
    url = f"{ORDER_BOOK_DETAILS_URL}?market_id={market_id}"
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        pacer.wait()
        delay = min(120.0, 5.0 * 2 ** (attempt - 1))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cryptowithalgo-research"})
            with _urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code in (405, 429, 500, 502, 503, 504):
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                if retry_after and str(retry_after).isdigit():
                    delay = max(delay, float(retry_after))
            elif exc.code == 400:
                try:
                    body = json.loads(exc.read())
                except (ValueError, OSError):
                    body = None
                if isinstance(body, dict) and body.get("code") == INVALID_MARKET_INDEX:
                    return None
                raise FoldError(f"GET {url} failed with HTTP 400: {body}") from exc
            else:
                raise FoldError(f"GET {url} failed with HTTP {exc.code}") from exc
        except (urllib.error.URLError, OSError, http.client.HTTPException, json.JSONDecodeError) as exc:
            last = exc
        else:
            if isinstance(payload, dict) and payload.get("code") == INVALID_MARKET_INDEX:
                return None
            for key in ("order_book_details", "spot_order_book_details"):
                for entry in (payload.get(key) or []) if isinstance(payload, dict) else []:
                    if int(entry.get("market_id", -1)) == market_id:
                        return {**static_market_fields(entry), "listed_in_order_books": False}
            raise FoldError(f"orderBookDetails for market {market_id} holds no entry for it: {str(payload)[:200]}")
        if attempt < retries:
            _sleep(delay)
    raise FoldError(f"GET {url} failed after {retries} attempts: {last}")


def complete_markets(out_dir: Path, pacer: Pacer | None = None) -> bool:
    """Add delisted markets to markets.json (version 3). Returns True when the file was written.

    Every market id present in the folded files but absent from the file is looked up in orderBookDetails. A market
    found is appended with the same static fields plus listed_in_order_books false. An id the API calls an invalid
    market index goes into unknown_market_ids. Existing entries and fetched_at are kept (entries from a version 2
    file get listed_in_order_books true). Ids already listed or already unknown cost no request, and a run with
    nothing to add to a version 3 file writes nothing, so a second run leaves the file byte for byte identical.
    """
    path = out_dir / "markets.json"
    if not path.exists():
        raise FoldError(f"{path} does not exist: run the fold first")
    doc = json.loads(path.read_text())
    if not isinstance(doc, dict) or doc.get("markets_file_version", 0) < MIN_MARKETS_FILE_VERSION:
        raise FoldError(f"{path} is older than version {MIN_MARKETS_FILE_VERSION}: run the fold once to clean it")
    books = [{**b, "listed_in_order_books": b.get("listed_in_order_books", True)} for b in doc["order_books"]]
    unknown = {int(x) for x in doc.get("unknown_market_ids", [])}
    todo = sorted(folded_market_ids(out_dir) - {int(b["market_id"]) for b in books} - unknown)
    upgrade = doc["markets_file_version"] < MARKETS_FILE_VERSION
    if not todo and not upgrade:
        return False
    pacer = pacer or Pacer()
    for market_id in todo:
        entry = fetch_market_details(market_id, pacer)
        if entry is None:
            unknown.add(market_id)
            print(f"market {market_id}: invalid market index", file=sys.stderr)
        else:
            books.append(entry)
            print(
                f"market {market_id}: {entry.get('symbol')} {entry.get('market_type')} {entry.get('status')}",
                file=sys.stderr,
            )
    _write_json(
        path,
        {
            **{k: v for k, v in doc.items() if k not in ("order_books", "unknown_market_ids", "markets_file_version")},
            "markets_file_version": MARKETS_FILE_VERSION,
            "order_books": books,
            "unknown_market_ids": sorted(unknown),
            "completed_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        },
    )
    return True


def download(url: str, dest: Path, *, retries: int = 5, chunk: int = 1 << 20, timeout: float = 60.0) -> int:
    """Stream url into dest in chunks, check the byte count against Content-Length, retry. Returns bytes written."""
    part = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cryptowithalgo-research"})
            with _urlopen(req, timeout=timeout) as resp:
                header = resp.headers.get("Content-Length")
                if header is None:
                    raise FoldError(f"no Content-Length for {url}")
                expected = int(header)
                written = 0
                with open(part, "wb") as fh:
                    while True:
                        buf = resp.read(chunk)
                        if not buf:
                            break
                        fh.write(buf)
                        written += len(buf)
            if written != expected:
                raise OSError(f"incomplete download of {url}: {written} of {expected} bytes")
            os.replace(part, dest)
            return written
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in (429, 500, 502, 503, 504):
                raise DownloadError(f"GET {url} failed with HTTP {exc.code}") from exc
        except (urllib.error.URLError, OSError, http.client.HTTPException, FoldError) as exc:
            last = exc
        if attempt < retries:
            _sleep(min(60.0, 2.0**attempt))
    part.unlink(missing_ok=True)
    raise DownloadError(f"download of {url} failed after {retries} attempts: {last}")


# ---------------------------------------------------------------------------------------------------------------
# Folding


def _pick_frame(frame: pd.DataFrame, mask: np.ndarray, how: str) -> pd.DataFrame:
    """Keep the first or last row per (market, minute) of the rows in mask. frame is sorted by (key, ts, id)."""
    sub = frame.loc[mask, [*_KEY, "ts", "id", "px"]]
    grouped = sub.groupby(_KEY, sort=False)
    return (grouped.head(1) if how == "head" else grouped.tail(1)).reset_index(drop=True)


_PICKS = {
    "last": "tail",
    "last_buy": "tail",
    "last_sell": "tail",
    "first_buy": "head",
    "first_sell": "head",
}


class Accumulator:
    """Per (market, minute) partials that merge exactly across batches."""

    def __init__(self) -> None:
        self.sums: pd.DataFrame | None = None
        self.picks: dict[str, pd.DataFrame] = {}
        self.rows = 0
        self.usdc_micro = 0
        self.rows_by_type: dict[str, int] = {}
        self.rows_outside_day = 0
        self.rows_size_price_mismatch = 0

    def add(self, batch: pa.RecordBatch, day: dt.date) -> None:
        n = batch.num_rows
        if n == 0:
            return
        for name in REQUIRED_COLUMNS:
            if name != "is_maker_ask" and batch.column(name).null_count:
                raise FoldError(f"column {name} has {batch.column(name).null_count} nulls")
        ts = batch.column("timestamp").to_numpy(zero_copy_only=False).astype(np.int64)
        if int(ts.min()) < TS_MIN_MS or int(ts.max()) >= TS_MAX_MS:
            raise FoldError(f"timestamps outside the plausible millisecond range: {ts.min()} to {ts.max()}")
        if int(ts.max()) >= day_start_ms(FOLD_LAST_DATE) + DAY_MS:
            raise ForwardSampleError(f"file holds rows after {FOLD_LAST_DATE}: reserved forward sample")
        start = day_start_ms(day)
        self.rows_outside_day += int(np.count_nonzero((ts < start) | (ts >= start + DAY_MS)))

        trade_type = batch.column("trade_type")
        for entry in pc.value_counts(trade_type).to_pylist():
            key = str(entry["values"])
            self.rows_by_type[key] = self.rows_by_type.get(key, 0) + int(entry["counts"])
        is_trade = pc.equal(trade_type, TRADE_TYPE).to_numpy(zero_copy_only=False).astype(bool)
        maker_ask_col = batch.column("is_maker_ask")
        maker_ask = pc.fill_null(maker_ask_col, False).to_numpy(zero_copy_only=False).astype(bool)
        if maker_ask_col.null_count and bool(np.any(is_trade & maker_ask_col.is_null().to_numpy(zero_copy_only=False))):
            raise FoldError("is_maker_ask is null on a trade row")
        buy = is_trade & maker_ask
        sell = is_trade & ~maker_ask

        ids = batch.column("id").to_numpy(zero_copy_only=False).astype(np.int64)
        market = batch.column("market_id").to_numpy(zero_copy_only=False).astype(np.int32)
        px = batch.column("price").to_numpy(zero_copy_only=False).astype(np.int64)
        size = batch.column("size").to_numpy(zero_copy_only=False).astype(np.int64)
        usd = batch.column("usdc_amount").to_numpy(zero_copy_only=False).astype(np.int64)
        minute = ts - ts % MINUTE_MS

        self.rows += n
        self.usdc_micro += int(usd.sum(dtype=np.int64))
        with np.errstate(over="ignore"):
            self.rows_size_price_mismatch += int(np.count_nonzero(size * px != usd))

        band = np.searchsorted(BAND_EDGES_MICRO, usd, side="right")
        zero = np.zeros(n, dtype=np.int64)
        cols: dict[str, np.ndarray] = {
            "market_id": market,
            "minute": minute,
            "n_trades": np.ones(n, dtype=np.int64),
            "buy_usd": np.where(buy, usd, zero),
            "sell_usd": np.where(sell, usd, zero),
            "liq_usd": np.where(~is_trade, usd, zero),
        }
        for side, mask in (("buy", buy), ("sell", sell)):
            for k, name in enumerate(BAND_NAMES):
                cols[f"{side}_usd_{name}"] = np.where(mask & (band == k), usd, zero)
        cols["vwap_den"] = np.where(is_trade, usd, zero)
        cols["vwap_num"] = np.where(is_trade, px.astype(np.float64) * usd.astype(np.float64), 0.0)
        partial = pd.DataFrame(cols).groupby(_KEY, sort=False).sum()
        self.sums = partial if self.sums is None else pd.concat([self.sums, partial]).groupby(level=[0, 1]).sum()

        order = np.lexsort((ids, ts, minute, market))
        frame = pd.DataFrame(
            {"market_id": market[order], "minute": minute[order], "ts": ts[order], "id": ids[order], "px": px[order]}
        )
        s_buy, s_sell, s_trade = buy[order], sell[order], is_trade[order]
        fill_ok = (frame["ts"].to_numpy() - frame["minute"].to_numpy()) >= FILL_DELAY_MS
        masks = {
            "last": s_trade,
            "last_buy": s_buy,
            "last_sell": s_sell,
            "first_buy": s_buy & fill_ok,
            "first_sell": s_sell & fill_ok,
        }
        for name, how in _PICKS.items():
            new = _pick_frame(frame, masks[name], how)
            old = self.picks.get(name)
            if old is not None and len(old):
                merged = pd.concat([old, new]).sort_values([*_KEY, "ts", "id"], kind="stable")
                grouped = merged.groupby(_KEY, sort=False)
                new = (grouped.head(1) if how == "head" else grouped.tail(1)).reset_index(drop=True)
            self.picks[name] = new

    def to_table(self) -> pa.Table:
        if self.sums is None:
            return OUTPUT_SCHEMA.empty_table()
        sums = self.sums.sort_index()
        idx = sums.index
        out = pd.DataFrame(index=idx)
        out["n_trades"] = sums["n_trades"].astype(np.int64)
        for name in ("buy_usd", "sell_usd", "liq_usd", *BAND_COLS):
            out[name] = sums[name].to_numpy(dtype=np.int64) / MICRO
        picked: dict[str, pd.DataFrame] = {}
        for name, frame in self.picks.items():
            keyed = frame.set_index(_KEY)[["ts", "px"]].astype("Int64")
            picked[name] = keyed.reindex(idx)
        out["last_px"] = picked["last"]["px"]
        den = sums["vwap_den"].to_numpy(dtype=np.float64)
        num = sums["vwap_num"].to_numpy(dtype=np.float64)
        out["vwap_px"] = np.divide(num, den, out=np.full(len(sums), np.nan), where=den > 0)
        for name in ("last_buy", "last_sell", "first_buy", "first_sell"):
            out[f"{name}_px"] = picked[name]["px"]
            out[f"{name}_ts"] = picked[name]["ts"]
        out = out.reset_index()
        out["market_id"] = out["market_id"].astype(np.int16)
        return pa.Table.from_pandas(out[OUTPUT_SCHEMA.names], schema=OUTPUT_SCHEMA, preserve_index=False)


def fold_file(path: Path, day: dt.date) -> tuple[pa.Table, dict[str, Any]]:
    """Fold one raw day file into the per-minute table and its stats. Streams in BATCH_ROWS batches."""
    check_date(day)
    pf = pq.ParquetFile(path)
    names = set(pf.schema_arrow.names)
    missing = [c for c in REQUIRED_COLUMNS if c not in names]
    if missing:
        raise FoldError(f"{path.name} is missing required columns {missing} (present: {sorted(names)})")
    meta = pf.metadata
    biggest = max((meta.row_group(i).num_rows for i in range(meta.num_row_groups)), default=0)
    print(
        f"  {meta.num_rows:,} rows, {meta.num_row_groups} row groups (largest {biggest:,}), batch {BATCH_ROWS:,}",
        file=sys.stderr,
    )
    acc = Accumulator()
    for batch in pf.iter_batches(batch_size=BATCH_ROWS, columns=list(REQUIRED_COLUMNS)):
        acc.add(batch, day)
    if acc.rows != meta.num_rows:
        raise FoldError(f"read {acc.rows} rows but the footer says {meta.num_rows}")
    if acc.rows_outside_day:
        raise FoldError(
            f"{path.name}: {acc.rows_outside_day} rows have a timestamp outside the UTC day {day} "
            "(they would duplicate market-minute keys across days)"
        )
    table = acc.to_table()

    if acc.sums is not None:
        if int(pc.sum(table["n_trades"]).as_py()) != acc.rows:
            raise FoldError("per-minute n_trades does not add up to the source row count")
        folded_micro = int(acc.sums[["buy_usd", "sell_usd", "liq_usd"]].to_numpy(dtype=np.int64).sum())
        if folded_micro != acc.usdc_micro:
            raise FoldError(f"folded USD {folded_micro} micro differs from source usdc_amount {acc.usdc_micro}")
    stats = {
        "source_rows": acc.rows,
        "rows_by_trade_type": dict(sorted(acc.rows_by_type.items())),
        "source_usdc_micro": acc.usdc_micro,
        "rows_outside_day": acc.rows_outside_day,
        "rows_size_price_mismatch": acc.rows_size_price_mismatch,
        "output_rows": table.num_rows,
    }
    return table, stats


# ---------------------------------------------------------------------------------------------------------------
# Day driver and manifest


def read_manifest(path: Path) -> dict[str, dict[str, Any]]:
    """Last manifest line per date. Malformed lines (a crash mid-append) are ignored."""
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
    if record is None or record.get("fold_version") != FOLD_VERSION or not out_file.is_file():
        return False
    return sha256_file(out_file) == record.get("output_sha256")


def append_manifest(path: Path, record: dict[str, Any]) -> None:
    with open(path, "a") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def _usable_parquet(path: Path) -> bool:
    try:
        pq.ParquetFile(path)
    except Exception:
        return False
    return True


def fold_day(day: dt.date, raw_dir: Path, out_dir: Path, *, keep_raw: bool = False) -> dict[str, Any]:
    """Download, fold, write, record and (unless keep_raw) delete one day. Returns the manifest record."""
    check_date(day)
    began = time.monotonic()
    url = source_url(day)
    raw = raw_dir / f"date={day.isoformat()}.trades.parquet"
    if raw.exists() and not _usable_parquet(raw):
        raw.unlink()
    if not raw.exists():
        download(url, raw)
    source_bytes = raw.stat().st_size
    try:
        table, stats = fold_file(raw, day)
    except ForwardSampleError:
        raw.unlink(missing_ok=True)
        raise

    version_dir = out_dir / FOLD_VERSION
    version_dir.mkdir(parents=True, exist_ok=True)
    out_file = version_dir / f"date={day.isoformat()}.parquet"
    tmp = out_file.with_name(out_file.name + ".tmp")
    pq.write_table(table, tmp, compression="zstd")
    os.replace(tmp, out_file)

    record = {
        "date": day.isoformat(),
        "source_url": url,
        "source_bytes": source_bytes,
        **stats,
        "output_sha256": sha256_file(out_file),
        "fold_version": FOLD_VERSION,
        "elapsed_s": round(time.monotonic() - began, 2),
        "folded_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
    }
    append_manifest(out_dir / "manifest.jsonl", record)
    if not keep_raw:
        raw.unlink(missing_ok=True)
    return record


def run(date_from: dt.date, date_to: dt.date, raw_dir: Path, out_dir: Path, *, keep_raw: bool = False) -> int:
    check_date(date_from)
    check_date(date_to)
    if date_from > date_to:
        raise FoldError(f"--from {date_from} is after --to {date_to}")
    raw_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    if write_markets(out_dir):
        print(f"wrote {out_dir / 'markets.json'}", file=sys.stderr)
    manifest = out_dir / "manifest.jsonl"
    folded = skipped = 0
    day = date_from
    while day <= date_to:
        out_file = out_dir / FOLD_VERSION / f"date={day.isoformat()}.parquet"
        if is_done(read_manifest(manifest).get(day.isoformat()), out_file):
            skipped += 1
        else:
            print(f"{day}: folding", file=sys.stderr)
            rec = fold_day(day, raw_dir, out_dir, keep_raw=keep_raw)
            print(
                f"{day}: {rec['source_rows']:,} rows -> {rec['output_rows']:,} in {rec['elapsed_s']} s",
                file=sys.stderr,
            )
            folded += 1
        day += dt.timedelta(days=1)
    print(f"done: {folded} folded, {skipped} skipped", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fold the Lighter trade archive into per-minute bars")
    parser.add_argument("--from", dest="date_from", help="first UTC date, YYYY-MM-DD")
    parser.add_argument("--to", dest="date_to", help=f"last UTC date, inclusive, at most {FOLD_LAST_DATE}")
    parser.add_argument("--raw-dir", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--keep-raw", action="store_true", help="keep each downloaded day file (default: delete)")
    parser.add_argument(
        "--complete-markets",
        action="store_true",
        help="add delisted markets found in the folded files to markets.json (no folding, needs only --out-dir)",
    )
    args = parser.parse_args(argv)
    try:
        if args.complete_markets:
            written = complete_markets(args.out_dir)
            print("markets.json completed" if written else "markets.json already complete", file=sys.stderr)
            return 0
        if not (args.date_from and args.date_to and args.raw_dir):
            parser.error("--from, --to and --raw-dir are required unless --complete-markets is given")
        return run(
            parse_date(args.date_from),
            parse_date(args.date_to),
            args.raw_dir,
            args.out_dir,
            keep_raw=args.keep_raw,
        )
    except FoldError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
