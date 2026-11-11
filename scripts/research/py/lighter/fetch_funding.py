"""LIGHTER HOURLY FUNDING FETCH v1: hourly funding per perp market from the public Lighter API, written 2026-11-11.

API: GET https://mainnet.zklighter.elliot.ai/api/v1/fundings?market_id=M&resolution=1h&start_timestamp=S
&end_timestamp=E&count_back=N (unix seconds). Rows: {timestamp, value, rate, direction}. `rate` is a PERCENT per hour
as a string. `direction` names the paying side, "long" or "short".

BEHAVIOUR OBSERVED 2026-11-11 (market 1, probes of start S and end E in seconds)
- count_back is required (omitting it returns an "invalid param" error). With count_back=0 no extra rows are added;
  a positive count_back adds that many rows before S, so this module always sends count_back=0.
- The window is NOT [S, E). A row with timestamp t comes back only when t >= S + 3600 and t < E. Seen with t0 a whole
  hour: S=t0-4h, E=t0 gave the rows at t0-3h, t0-2h, t0-1h; S=t0, E=t0+1h gave nothing; S=t0, E=t0+2h gave t0+1h;
  S=t0-3600 returned the row at t0 while S=t0-3599 (and S=t0-1) did not; E=t0+1 returned the row at t0 while E=t0 did
  not. So the start is lagged by one hour (a row at t is the period that began at t-3600 and must start at or after S)
  and the end is exclusive. Requesting S=start_s would silently drop the row at start_s of every window. This module
  therefore requests S = start_s - 3600 and also filters client side to start_s <= t < end_s. (An earlier note that
  both ends are exclusive is wrong: S=start_s-1 still drops the row at start_s.)
- A response holds at most 749 rows and, when the window is longer, keeps the LATEST rows ending at E and drops the
  start silently. Windows are therefore WINDOW_HOURS = 720 hours (30 days), below the cap, and a response of 749 rows
  or more fails the market rather than risk a silent gap.
- Rate limiting answers HTTP 429, and also HTTP 405. Both are retried with backoff. The limit is 60 requests a minute
  per IP, shared with other jobs, and REST rate limiting also throttles WebSocket connections from the same IP, so the
  pace is one request every MIN_INTERVAL_S = 2.5 s.
- Paging runs backwards from the end of FOLD_LAST_DATE, window by window, until the window start reaches the first
  archive day, or an empty window lies at or before the market's own created_at (orderBooks, milliseconds, plus one
  window of margin), after which no earlier data is expected. Rows are de-duplicated on timestamp.

CONTIGUITY CHECK: after a market is fetched, consecutive timestamps between its first and last row must be exactly 3,600
s apart. Each missing hour is asked for directly (S = hour - 3600, E = hour + 1, which returns that one hour if it
exists). A hole the direct request also finds empty is confirmed missing at the source and is listed in
confirmed_missing_hours in the manifest. Any other hole (a direct request that finds the row, an off-grid timestamp, or
more than MAX_HOLES_TO_CONFIRM holes) fails the market: its file is not written and the manifest records the failure.
A market with no rows is recorded as empty, never written as a file, and is retried on the next run.

END CHECK: the contiguity check cannot see hours missing at either end of a series (a transient empty HTTP 200 for the
newest window, or an empty window that trips the created_at stop rule, leaves a short but gap-free series). So after
paging, the hour before the first row and the hour after the last row are each asked for directly. If the source
returns either row the market FAILS and says which end. The probe before the first row is skipped when the first row is
the start of the requested range, and the probe after the last row when the last row is the final hour of the range
(2026-10-31 23:00 UTC by default). When the last row is earlier than the final hour and the next hour is confirmed
absent, the manifest records ended_early: true (a delisted or halted market) next to last_ts, and every line also
carries first_ts and created_at_ms (the orderBooks creation time) so the head can be compared with the listing.

ends_checked: every manifest line written by this version carries ends_checked: true when the market passed both
checks. A market file whose latest manifest line lacks it (written by an older version) is verified, not trusted: a
normal run does this before skipping the file, and --verify-existing does it for every such file and nothing else. A
file that fails is deleted and marked failed in the manifest, so the next normal run refetches it.

HARD GUARD: nothing at or after 2026-11-01 00:00 UTC is requested or written (same FOLD_LAST_DATE as the trade fold).
Later funding is a reserved forward sample. There is no override flag.

RATE LIMIT: at most one request every MIN_INTERVAL_S = 2.5 s, HTTP 405, 429 and 5xx retried with exponential backoff
(Retry-After honoured).

OUTPUT: out-dir/funding/market_<id>.parquet per perp market, written only when the whole history of the market was
fetched, non-empty and contiguous, and skipped on a rerun when the file exists. out-dir/funding/manifest.jsonl gets one
line per market attempt: market_id, symbol, status (ok, empty or failed), rows, first_ts, last_ts,
confirmed_missing_hours, fetched_at and, for a failure, the reason. Parquet columns: market_id, symbol, timestamp (unix
seconds), value (string, raw), rate (string, raw, percent per hour), direction (string, raw), rate_pct (float,
rate as a number), rate_long_pays (float, signed fraction per hour: rate / 100 if direction is "long", minus
that if "short", so a positive number is a cost to a long and a credit to a short).

ASSUMPTION TO CHECK: that direction names the side that PAYS (so rate_long_pays is correct) is read from the API field
name and an example, not verified. It must be checked against one realised funding payment on a real account before
any result uses the sign of this column.

Run: python -m lighter.fetch_funding --out-dir OUT [--from 2025-01-17] [--to 2026-10-31] [--market-ids 1,2]
     [--verify-existing]
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from lighter import fold_trades
from lighter.fold_trades import FIRST_DATE, FOLD_LAST_DATE, FoldError, check_date, day_start_ms, parse_date

FUNDINGS_URL = "https://mainnet.zklighter.elliot.ai/api/v1/fundings"
MIN_INTERVAL_S = 2.5
WINDOW_HOURS = 720
RESPONSE_CAP = 749
HOUR_S = 3600
API_START_LAG_S = 3600
MAX_HOLES_TO_CONFIRM = 48
RETRYABLE_HTTP = (405, 429, 500, 502, 503, 504)
MAX_RETRIES = 6

SCHEMA = pa.schema(
    [
        ("market_id", pa.int32()),
        ("symbol", pa.string()),
        ("timestamp", pa.int64()),
        ("value", pa.string()),
        ("rate", pa.string()),
        ("direction", pa.string()),
        ("rate_pct", pa.float64()),
        ("rate_long_pays", pa.float64()),
    ]
)

# Hooks the tests replace.
_urlopen = urllib.request.urlopen
_sleep = time.sleep
_clock = time.monotonic


class ContiguityError(FoldError):
    """A market's hourly series has a hole or an off-grid timestamp that the source does not confirm."""


class RateLimiter:
    """Blocks so that calls are at least min_interval seconds apart."""

    def __init__(self, min_interval: float = MIN_INTERVAL_S) -> None:
        self.min_interval = min_interval
        self._last: float | None = None

    def wait(self) -> None:
        now = _clock()
        if self._last is not None:
            gap = self.min_interval - (now - self._last)
            if gap > 0:
                _sleep(gap)
        self._last = _clock()


def end_exclusive_s() -> int:
    """First second that must never be requested: 00:00 UTC the day after FOLD_LAST_DATE."""
    return (day_start_ms(FOLD_LAST_DATE) + fold_trades.DAY_MS) // 1000


def get_json(url: str, limiter: RateLimiter, *, retries: int = MAX_RETRIES) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        limiter.wait()
        delay = min(120.0, 5.0 * 2 ** (attempt - 1))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cryptowithalgo-research"})
            with _urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read())
            if not isinstance(payload, dict):
                raise FoldError(f"unexpected response from {url}")
            return payload
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in RETRYABLE_HTTP:
                raise FoldError(f"GET {url} failed with HTTP {exc.code}") from exc
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            if retry_after and retry_after.isdigit():
                delay = max(delay, float(retry_after))
        except (urllib.error.URLError, OSError, http.client.HTTPException, json.JSONDecodeError) as exc:
            last = exc
        if attempt < retries:
            _sleep(delay)
    raise FoldError(f"GET {url} failed after {retries} attempts: {last}")


def window_rows(market_id: int, start_s: int, end_s: int, limiter: RateLimiter) -> list[dict[str, Any]]:
    """Funding rows with start_s <= timestamp < end_s (the API start is lagged by an hour, see the header)."""
    if end_s > end_exclusive_s():
        raise FoldError(f"window end {end_s} is after {FOLD_LAST_DATE}: reserved forward sample")
    url = (
        f"{FUNDINGS_URL}?market_id={market_id}&resolution=1h"
        f"&start_timestamp={start_s - API_START_LAG_S}&end_timestamp={end_s}&count_back=0"
    )
    payload = get_json(url, limiter)
    if "fundings" not in payload:
        raise FoldError(f"market {market_id}: no fundings field in response ({payload.get('message', payload)})")
    rows = payload["fundings"]
    if len(rows) >= RESPONSE_CAP:
        raise FoldError(f"market {market_id}: window {start_s}-{end_s} returned {len(rows)} rows, at the response cap")
    return [r for r in rows if start_s <= int(r["timestamp"]) < end_s]


def signed_rate(rate_pct: float, direction: str) -> float:
    """Fraction per hour, positive when longs pay. See the assumption in the module header."""
    if direction == "long":
        return rate_pct / 100.0
    if direction == "short":
        return -rate_pct / 100.0
    raise FoldError(f"unknown funding direction {direction!r}")


def check_contiguity(market_id: int, stamps: list[int], limiter: RateLimiter) -> list[int]:
    """Check hourly spacing from the first to the last timestamp. Returns the hours confirmed missing at the source."""
    missing: list[int] = []
    for prev, cur in zip(stamps, stamps[1:], strict=False):
        gap = cur - prev
        if gap == HOUR_S:
            continue
        if gap % HOUR_S or gap <= 0:
            raise ContiguityError(f"market {market_id}: timestamps {prev} and {cur} are not on the hourly grid")
        missing.extend(range(prev + HOUR_S, cur, HOUR_S))
        if len(missing) > MAX_HOLES_TO_CONFIRM:
            raise ContiguityError(f"market {market_id}: more than {MAX_HOLES_TO_CONFIRM} missing hours")
    confirmed = []
    for hour in missing:
        if window_rows(market_id, hour, hour + 1, limiter):
            raise ContiguityError(
                f"market {market_id}: hour {hour} exists at the source but the window fetch missed it"
            )
        confirmed.append(hour)
    return confirmed


def range_bounds(date_from: dt.date, date_to: dt.date) -> tuple[int, int]:
    """First second of the range and the first second after it (both unix seconds)."""
    return day_start_ms(date_from) // 1000, (day_start_ms(date_to) + fold_trades.DAY_MS) // 1000


def check_ends(market_id: int, stamps: list[int], earliest_s: int, end_s: int, limiter: RateLimiter) -> bool:
    """Probe the hour before the first row and the hour after the last. Returns True when the series ended early.

    A row at either probe means the paging dropped data at that end, so the market fails.
    """
    first, last = stamps[0], stamps[-1]
    if first > earliest_s and window_rows(market_id, first - HOUR_S, first, limiter):
        raise ContiguityError(f"market {market_id}: an hour before the first row ({first}) exists at the source")
    if last >= end_s - HOUR_S:
        return False
    if window_rows(market_id, last + HOUR_S, last + HOUR_S + 1, limiter):
        raise ContiguityError(f"market {market_id}: an hour after the last row ({last}) exists at the source")
    return True


def check_series(
    market_id: int, stamps: list[int], earliest_s: int, end_s: int, limiter: RateLimiter
) -> dict[str, Any]:
    """Contiguity plus both end probes for a non-empty sorted series. Returns the manifest facts."""
    confirmed = check_contiguity(market_id, stamps, limiter)
    ended_early = check_ends(market_id, stamps, earliest_s, end_s, limiter)
    return {"confirmed_missing_hours": confirmed, "ended_early": ended_early}


def fetch_market(
    market: dict[str, Any], date_from: dt.date, date_to: dt.date, limiter: RateLimiter
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """All hourly rows of one market in the range, and the checked facts (confirmed holes, ended_early)."""
    market_id = int(market["market_id"])
    earliest_s, range_end_s = range_bounds(date_from, date_to)
    end_s = range_end_s
    created_ms = int(market.get("created_at") or 0)
    created_s = created_ms // 1000
    window_s = WINDOW_HOURS * HOUR_S
    by_ts: dict[int, dict[str, Any]] = {}
    while end_s > earliest_s:
        start_s = max(earliest_s, end_s - window_s)
        rows = window_rows(market_id, start_s, end_s, limiter)
        for r in rows:
            by_ts[int(r["timestamp"])] = r
        if not rows and created_s and end_s <= created_s + window_s:
            break
        end_s = start_s
    stamps = sorted(by_ts)
    info = check_series(market_id, stamps, earliest_s, range_end_s, limiter) if stamps else {}
    out = []
    for ts in stamps:
        r = by_ts[ts]
        pct = float(r["rate"])
        out.append(
            {
                "market_id": market_id,
                "symbol": str(market.get("symbol", "")),
                "timestamp": ts,
                "value": str(r["value"]),
                "rate": str(r["rate"]),
                "direction": str(r["direction"]),
                "rate_pct": pct,
                "rate_long_pays": signed_rate(pct, str(r["direction"])),
            }
        )
    return out, info


def write_market(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        raise FoldError(f"refusing to write an empty file {path.name}")
    table = pa.Table.from_pylist(rows, schema=SCHEMA)
    tmp = path.with_name(path.name + ".tmp")
    pq.write_table(table, tmp, compression="zstd")
    os.replace(tmp, path)


def append_manifest(path: Path, record: dict[str, Any]) -> None:
    with open(path, "a") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def latest_manifest(path: Path) -> dict[int, dict[str, Any]]:
    """Latest manifest line per market. Torn lines are ignored."""
    latest: dict[int, dict[str, Any]] = {}
    if not path.exists():
        return latest
    for line in path.read_text().splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and "market_id" in rec:
            latest[int(rec["market_id"])] = rec
    return latest


def base_record(market: dict[str, Any]) -> dict[str, Any]:
    return {
        "market_id": int(market["market_id"]),
        "symbol": str(market.get("symbol", "")),
        "fetched_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
    }


def ok_record(market: dict[str, Any], stamps: list[int], info: dict[str, Any]) -> dict[str, Any]:
    return {
        **base_record(market),
        "status": "ok",
        "rows": len(stamps),
        "first_ts": stamps[0],
        "last_ts": stamps[-1],
        "created_at_ms": int(market.get("created_at") or 0),
        "confirmed_missing_hours": info["confirmed_missing_hours"],
        "ended_early": info["ended_early"],
        "ends_checked": True,
    }


def needs_verification(path: Path, latest: dict[int, dict[str, Any]], market_id: int) -> bool:
    rec = latest.get(market_id)
    return path.exists() and not (rec is not None and rec.get("status") == "ok" and rec.get("ends_checked") is True)


def verify_existing_file(
    market: dict[str, Any], path: Path, date_from: dt.date, date_to: dt.date, limiter: RateLimiter, manifest: Path
) -> bool:
    """Check a market file already on disk. Appends an ends_checked line, or deletes the file and marks it failed."""
    market_id = int(market["market_id"])
    earliest_s, end_s = range_bounds(date_from, date_to)
    try:
        stamps = sorted(int(t) for t in pq.read_table(path, columns=["timestamp"]).column("timestamp").to_pylist())
        if not stamps:
            raise ContiguityError(f"market {market_id}: the file has no rows")
        info = check_series(market_id, stamps, earliest_s, end_s, limiter)
    except ContiguityError as exc:
        path.unlink(missing_ok=True)
        append_manifest(manifest, {**base_record(market), "status": "failed", "reason": f"verify: {exc}"})
        print(f"market {market_id} {market.get('symbol')}: verify FAILED, file deleted: {exc}", file=sys.stderr)
        return False
    append_manifest(manifest, ok_record(market, stamps, info))
    print(f"market {market_id} {market.get('symbol')}: verified {len(stamps):,} rows", file=sys.stderr)
    return True


def run(
    out_dir: Path,
    date_from: dt.date,
    date_to: dt.date,
    market_ids: set[int] | None = None,
    limiter: RateLimiter | None = None,
    verify_only: bool = False,
) -> int:
    """Fetch (or only verify) the selected perp markets. Returns 1 when any market failed its checks, else 0."""
    check_date(date_from)
    check_date(date_to)
    if date_from > date_to:
        raise FoldError(f"--from {date_from} is after --to {date_to}")
    limiter = limiter or RateLimiter()
    books = fold_trades.fetch_order_books()["order_books"]
    markets = [m for m in books if m.get("market_type") == "perp"]
    if market_ids is not None:
        known = {int(m["market_id"]) for m in markets}
        unknown = sorted(market_ids - known)
        if unknown:
            raise FoldError(f"not perp markets in orderBooks: {unknown}")
        markets = [m for m in markets if int(m["market_id"]) in market_ids]
    target = out_dir / "funding"
    target.mkdir(parents=True, exist_ok=True)
    manifest = target / "manifest.jsonl"
    done = skipped = empty = failed = verified = 0
    for market in sorted(markets, key=lambda m: int(m["market_id"])):
        market_id = int(market["market_id"])
        path = target / f"market_{market_id}.parquet"
        if path.exists():
            if needs_verification(path, latest_manifest(manifest), market_id):
                if verify_existing_file(market, path, date_from, date_to, limiter, manifest):
                    verified += 1
                    continue
                if verify_only:
                    failed += 1
                    continue
                # The deleted file is refetched below in this same run.
            else:
                skipped += 1
                continue
        elif verify_only:
            continue
        try:
            rows, info = fetch_market(market, date_from, date_to, limiter)
        except ContiguityError as exc:
            append_manifest(manifest, {**base_record(market), "status": "failed", "reason": str(exc)})
            print(f"market {market_id} {market.get('symbol')}: FAILED {exc}", file=sys.stderr)
            failed += 1
            continue
        if not rows:
            append_manifest(
                manifest,
                {
                    **base_record(market),
                    "status": "empty",
                    "rows": 0,
                    "first_ts": None,
                    "last_ts": None,
                    "created_at_ms": int(market.get("created_at") or 0),
                    "confirmed_missing_hours": [],
                    "ends_checked": True,
                },
            )
            print(f"market {market_id} {market.get('symbol')}: empty, retried on the next run", file=sys.stderr)
            empty += 1
            continue
        write_market(path, rows)
        append_manifest(manifest, ok_record(market, [r["timestamp"] for r in rows], info))
        done += 1
        suffix = " (ended early)" if info["ended_early"] else ""
        print(f"market {market_id} {market.get('symbol')}: {len(rows):,} rows{suffix}", file=sys.stderr)
    print(
        f"done: {done} fetched, {verified} verified, {skipped} skipped, {empty} empty, {failed} failed",
        file=sys.stderr,
    )
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch hourly Lighter funding per perp market")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--from", dest="date_from", default=FIRST_DATE.isoformat())
    parser.add_argument("--to", dest="date_to", default=FOLD_LAST_DATE.isoformat())
    parser.add_argument("--market-ids", default=None, help="comma separated market ids (default: every perp)")
    parser.add_argument(
        "--verify-existing",
        action="store_true",
        help="only verify market files whose latest manifest line lacks ends_checked (no fetching)",
    )
    args = parser.parse_args(argv)
    try:
        ids = {int(x) for x in args.market_ids.split(",")} if args.market_ids else None
        return run(
            args.out_dir, parse_date(args.date_from), parse_date(args.date_to), ids, verify_only=args.verify_existing
        )
    except (FoldError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
