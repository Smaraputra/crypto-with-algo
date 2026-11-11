"""Tests for the Lighter funding fetch: scripts/research/py/lighter/fetch_funding.py. The network is mocked."""

from __future__ import annotations

import datetime as dt
import io
import json
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlparse

import pyarrow.parquet as pq
import pytest

from lighter import fetch_funding as ff
from lighter import fold_trades as ft

HOUR = 3600


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def reply(payload):
    return FakeResp(json.dumps(payload).encode())


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    sleeps = []
    monkeypatch.setattr(ff, "_sleep", sleeps.append)
    monkeypatch.setattr(ff, "_clock", lambda: 1000.0)
    return sleeps


def params(req):
    q = parse_qs(urlparse(req.full_url).query)
    return {k: int(v[0]) if v[0].lstrip("-").isdigit() else v[0] for k, v in q.items()}


def test_signed_rate_direction():
    assert ff.signed_rate(0.0021, "long") == pytest.approx(0.000021)
    assert ff.signed_rate(0.0021, "short") == pytest.approx(-0.000021)
    with pytest.raises(ft.FoldError):
        ff.signed_rate(0.1, "flat")


def test_rate_limiter_spaces_calls(monkeypatch):
    now = [0.0]
    sleeps = []
    monkeypatch.setattr(ff, "_clock", lambda: now[0])

    def fake_sleep(s):
        sleeps.append(s)
        now[0] += s

    monkeypatch.setattr(ff, "_sleep", fake_sleep)
    lim = ff.RateLimiter(1.2)
    lim.wait()
    now[0] += 0.2
    lim.wait()
    lim.wait()
    assert sleeps == [pytest.approx(1.0), pytest.approx(1.2)]


def test_429_is_retried_with_backoff_and_retry_after(monkeypatch, fast):
    calls = []

    def fake(req, timeout=0):
        calls.append(1)
        if len(calls) == 1:
            raise urllib.error.HTTPError(req.full_url, 429, "slow", {"Retry-After": "30"}, None)
        if len(calls) == 2:
            raise urllib.error.HTTPError(req.full_url, 429, "slow", {}, None)
        return reply({"fundings": []})

    monkeypatch.setattr(ff, "_urlopen", fake)
    assert ff.get_json("https://x/y", ff.RateLimiter(0.0)) == {"fundings": []}
    assert fast == [30.0, 10.0]


def test_non_retryable_http_error_fails_at_once(monkeypatch):
    def fake(req, timeout=0):
        raise urllib.error.HTTPError(req.full_url, 400, "bad", {}, None)

    monkeypatch.setattr(ff, "_urlopen", fake)
    with pytest.raises(ft.FoldError, match="HTTP 400"):
        ff.get_json("https://x/y", ff.RateLimiter())


def test_window_guard_refuses_requests_after_the_last_date(monkeypatch):
    monkeypatch.setattr(ff, "_urlopen", lambda *a, **k: pytest.fail("network must not be used"))
    end = ff.end_exclusive_s()
    assert end == int(dt.datetime(2026, 11, 1, tzinfo=dt.UTC).timestamp())
    with pytest.raises(ft.FoldError, match="reserved forward sample"):
        ff.window_rows(1, end - HOUR, end + HOUR, ff.RateLimiter())


def test_cli_refuses_late_dates(tmp_path, monkeypatch):
    monkeypatch.setattr(ff, "_urlopen", lambda *a, **k: pytest.fail("network must not be used"))
    monkeypatch.setattr(ft, "_urlopen", lambda *a, **k: pytest.fail("network must not be used"))
    assert ff.main(["--out-dir", str(tmp_path), "--to", "2026-11-01"]) == 2


def test_response_at_the_cap_fails(monkeypatch):
    rows = [{"timestamp": 1_737_331_200 + i * HOUR, "value": "0", "rate": "0", "direction": "long"} for i in range(749)]
    monkeypatch.setattr(ff, "_urlopen", lambda req, timeout=0: reply({"fundings": rows}))
    with pytest.raises(ft.FoldError, match="response cap"):
        ff.window_rows(1, 1_737_331_200, 1_737_331_200 + 749 * HOUR, ff.RateLimiter())


class FakeApi:
    """orderBooks plus fundings with the live window rule: a row at t is returned when S + 3600 <= t < E.

    Market 7 has hourly rows from `since` on. `holes` are hours the source lacks. `flaky` are hours that the long
    windows drop while a one-hour direct request still finds them. Market 8 is spot.
    """

    def __init__(self, since, holes=(), flaky=(), until=None, created_at=None, empty_ordinals=()):
        self.since = since
        self.until = until
        self.created_at = since if created_at is None else created_at
        self.empty_ordinals = set(empty_ordinals)  # long-window requests (by order) that return an empty 200
        self.long_requests = 0
        self.holes = set(holes)
        self.flaky = set(flaky)
        self.requests = []
        self.order_book_requests = 0
        self.market_ids_seen = []

    def __call__(self, req, timeout=0):
        url = req.full_url
        if url.startswith(ft.ORDER_BOOKS_URL):
            self.order_book_requests += 1
            books = [
                {"symbol": "AAA", "market_id": 7, "market_type": "perp", "created_at": str(self.created_at * 1000)},
                {"symbol": "BBB", "market_id": 8, "market_type": "spot", "created_at": "0"},
            ]
            return reply({"order_books": books})
        p = params(req)
        self.requests.append(p)
        self.market_ids_seen.append(p["market_id"])
        assert p["count_back"] == 0 and p["resolution"] == "1h"
        assert p["end_timestamp"] <= ff.end_exclusive_s()
        direct = p["end_timestamp"] - p["start_timestamp"] <= HOUR + 1
        rows = []
        if not direct:
            self.long_requests += 1
            if self.long_requests - 1 in self.empty_ordinals:
                return reply({"code": 200, "fundings": []})
        first = p["start_timestamp"] + HOUR
        for ts in range(first + (-first) % HOUR, p["end_timestamp"], HOUR):
            if (
                ts < self.since
                or (self.until is not None and ts >= self.until)
                or ts in self.holes
                or (ts in self.flaky and not direct)
            ):
                continue
            rows.append(
                {
                    "timestamp": ts,
                    "value": "0.5",
                    "rate": "0.0010",
                    "direction": "short" if (ts // HOUR) % 2 else "long",
                }
            )
        return reply({"code": 200, "fundings": rows})


T0 = int(dt.datetime(2026, 9, 1, tzinfo=dt.UTC).timestamp())


def funding_manifest(tmp_path):
    return [json.loads(x) for x in (tmp_path / "funding" / "manifest.jsonl").read_text().splitlines()]


def install(monkeypatch, api):
    monkeypatch.setattr(ff, "_urlopen", api)
    monkeypatch.setattr(ft, "_urlopen", api)


def test_fake_models_the_live_window_rule():
    api = FakeApi(0)
    t0 = 1_788_220_800

    def got(s, e):
        query = f"market_id=7&resolution=1h&start_timestamp={s}&end_timestamp={e}&count_back=0"
        req = urllib.request.Request(f"{ff.FUNDINGS_URL}?{query}")
        return [r["timestamp"] - t0 for r in json.loads(api(req).read())["fundings"]]

    assert got(t0 + 19 * HOUR, t0 + 23 * HOUR) == [20 * HOUR, 21 * HOUR, 22 * HOUR]
    assert got(t0 + 20 * HOUR, t0 + 21 * HOUR) == []
    assert got(t0 + 20 * HOUR - 1, t0 + 22 * HOUR) == [21 * HOUR]


def test_no_hour_is_dropped_across_chained_windows(monkeypatch):
    api = FakeApi(0)
    install(monkeypatch, api)
    monkeypatch.setattr(ff, "WINDOW_HOURS", 100)
    start = T0
    end = T0 + 3 * ff.WINDOW_HOURS * HOUR + 5 * HOUR  # four chained windows
    rows = []
    e = end
    while e > start:
        s = max(start, e - ff.WINDOW_HOURS * HOUR)
        rows += ff.window_rows(7, s, e, ff.RateLimiter(0.0))
        e = s
    stamps = sorted(r["timestamp"] for r in rows)
    assert stamps == list(range(start, end, HOUR))
    # The request start is lagged by an hour so the row at each window start comes back.
    assert all(r["start_timestamp"] % HOUR == 0 for r in api.requests)


def test_run_pages_backwards_and_writes_one_parquet_per_perp(tmp_path, monkeypatch):
    first = T0
    api = FakeApi(first)
    monkeypatch.setattr(ff, "_urlopen", api)
    monkeypatch.setattr(ft, "_urlopen", api)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 0
    assert sorted(p.name for p in (tmp_path / "funding").glob("*.parquet")) == ["market_7.parquet"]
    df = pq.read_table(tmp_path / "funding" / "market_7.parquet").to_pandas()
    assert df.timestamp.min() == first
    assert df.timestamp.max() == ff.end_exclusive_s() - HOUR
    assert df.timestamp.is_monotonic_increasing and df.timestamp.is_unique
    assert len(df) == (ff.end_exclusive_s() - first) // HOUR
    assert set(df.columns) >= {
        "market_id",
        "symbol",
        "timestamp",
        "value",
        "rate",
        "direction",
        "rate_pct",
        "rate_long_pays",
    }
    longs = df[df.direction == "long"].iloc[0]
    shorts = df[df.direction == "short"].iloc[0]
    assert longs.rate == "0.0010" and longs.rate_long_pays == pytest.approx(0.00001)
    assert shorts.rate_long_pays == pytest.approx(-0.00001)
    # Stops soon after the market's created_at instead of walking back to 2025-01-17.
    assert len(api.requests) <= 5
    # Windows are contiguous, never longer than 720 hours, and the first one ends at the guard.
    assert api.requests[0]["end_timestamp"] == ff.end_exclusive_s()
    assert all(r["end_timestamp"] - r["start_timestamp"] <= (ff.WINDOW_HOURS + 1) * HOUR for r in api.requests)


def test_second_run_skips_existing_markets(tmp_path, monkeypatch):
    api = FakeApi(int(dt.datetime(2026, 10, 1, tzinfo=dt.UTC).timestamp()))
    monkeypatch.setattr(ff, "_urlopen", api)
    monkeypatch.setattr(ft, "_urlopen", api)
    ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE)
    n = len(api.requests)
    ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE)
    assert len(api.requests) == n


def test_unknown_market_id_is_rejected(tmp_path, monkeypatch):
    api = FakeApi(0)
    monkeypatch.setattr(ft, "_urlopen", api)
    with pytest.raises(ft.FoldError, match="not perp markets"):
        ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE, {8})


def test_confirmed_missing_hour_is_recorded_and_the_file_is_written(tmp_path, monkeypatch):
    hole = T0 + 100 * HOUR
    api = FakeApi(T0, holes=[hole])
    install(monkeypatch, api)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 0
    df = pq.read_table(tmp_path / "funding" / "market_7.parquet").to_pandas()
    assert hole not in set(df.timestamp)
    assert len(df) == (ff.end_exclusive_s() - T0) // HOUR - 1
    [rec] = funding_manifest(tmp_path)
    assert rec["status"] == "ok" and rec["market_id"] == 7 and rec["rows"] == len(df)
    assert rec["confirmed_missing_hours"] == [hole]
    assert rec["first_ts"] == T0 and rec["last_ts"] == ff.end_exclusive_s() - HOUR
    # The direct confirmation asked for just that hour.
    assert any(r["start_timestamp"] == hole - HOUR and r["end_timestamp"] == hole + 1 for r in api.requests)


def test_hole_the_source_can_fill_fails_the_market(tmp_path, monkeypatch, capsys):
    api = FakeApi(T0, flaky=[T0 + 100 * HOUR])
    install(monkeypatch, api)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 1
    assert not (tmp_path / "funding" / "market_7.parquet").exists()
    [rec] = funding_manifest(tmp_path)
    assert rec["status"] == "failed" and "exists at the source" in rec["reason"]
    assert "FAILED" in capsys.readouterr().err
    # A failed market is retried on the next run.
    n = len(api.requests)
    ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE)
    assert len(api.requests) > n


def test_off_grid_timestamp_fails_the_market():
    with pytest.raises(ff.ContiguityError, match="hourly grid"):
        ff.check_contiguity(7, [T0, T0 + HOUR, T0 + 2 * HOUR + 30], ff.RateLimiter(0.0))


def test_too_many_holes_fails_without_a_request_storm(monkeypatch):
    monkeypatch.setattr(ff, "_urlopen", lambda *a, **k: pytest.fail("no confirmation requests expected"))
    with pytest.raises(ff.ContiguityError, match="more than"):
        ff.check_contiguity(7, [T0, T0 + 100 * HOUR], ff.RateLimiter(0.0))


def test_empty_market_is_recorded_not_written_and_retried(tmp_path, monkeypatch):
    future = ff.end_exclusive_s() + 10 * HOUR
    api = FakeApi(future)
    install(monkeypatch, api)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 0
    assert list((tmp_path / "funding").glob("*.parquet")) == []
    [rec] = funding_manifest(tmp_path)
    assert rec["status"] == "empty" and rec["rows"] == 0
    n = len(api.requests)
    ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE)
    assert len(api.requests) > n and len(funding_manifest(tmp_path)) == 2


def test_write_market_refuses_an_empty_file(tmp_path):
    with pytest.raises(ft.FoldError, match="empty file"):
        ff.write_market(tmp_path / "m.parquet", [])


def test_405_is_treated_like_429(monkeypatch, fast):
    calls = []

    def fake(req, timeout=0):
        calls.append(1)
        if len(calls) < 3:
            raise urllib.error.HTTPError(req.full_url, 405, "rate limited", {}, None)
        return reply({"fundings": []})

    monkeypatch.setattr(ff, "_urlopen", fake)
    assert ff.get_json("https://x/y", ff.RateLimiter(0.0)) == {"fundings": []}
    assert fast == [5.0, 10.0]


def test_pace_is_one_request_every_two_and_a_half_seconds():
    assert ff.MIN_INTERVAL_S >= 2.5


def strip_ends_checked(tmp_path):
    """Rewrite the manifest the way the previous version wrote it (no ends_checked key)."""
    path = tmp_path / "funding" / "manifest.jsonl"
    lines = []
    for rec in funding_manifest(tmp_path):
        rec.pop("ends_checked", None)
        lines.append(json.dumps(rec))
    path.write_text("\n".join(lines) + "\n")


def test_transient_empty_newest_window_fails_the_market(tmp_path, monkeypatch):
    api = FakeApi(T0, empty_ordinals=[0])
    install(monkeypatch, api)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 1
    assert not (tmp_path / "funding" / "market_7.parquet").exists()
    [rec] = funding_manifest(tmp_path)
    assert rec["status"] == "failed" and "after the last row" in rec["reason"] and "ends_checked" not in rec
    # The next run refetches and succeeds.
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 0
    df = pq.read_table(tmp_path / "funding" / "market_7.parquet").to_pandas()
    assert len(df) == (ff.end_exclusive_s() - T0) // HOUR


def test_empty_window_that_trips_the_created_at_stop_fails_the_head(tmp_path, monkeypatch):
    api = FakeApi(T0, empty_ordinals=[2])  # the third window holds the first hour(s) of the market
    install(monkeypatch, api)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 1
    assert not (tmp_path / "funding" / "market_7.parquet").exists()
    [rec] = funding_manifest(tmp_path)
    assert rec["status"] == "failed" and "before the first row" in rec["reason"]


def test_delisted_market_records_ended_early(tmp_path, monkeypatch):
    until = T0 + 400 * HOUR
    api = FakeApi(T0, until=until, created_at=T0 - 5 * HOUR)
    install(monkeypatch, api)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 0
    df = pq.read_table(tmp_path / "funding" / "market_7.parquet").to_pandas()
    assert df.timestamp.max() == until - HOUR and df.timestamp.min() == T0
    [rec] = funding_manifest(tmp_path)
    assert rec["status"] == "ok" and rec["ended_early"] is True and rec["ends_checked"] is True
    assert rec["last_ts"] == until - HOUR and rec["first_ts"] == T0 and rec["created_at_ms"] == (T0 - 5 * HOUR) * 1000


def test_full_market_is_not_ended_early_and_is_flagged_checked(tmp_path, monkeypatch):
    install(monkeypatch, FakeApi(T0))
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 0
    [rec] = funding_manifest(tmp_path)
    assert rec["ended_early"] is False and rec["ends_checked"] is True and rec["created_at_ms"] == T0 * 1000


def test_probe_is_skipped_at_the_range_edges(monkeypatch):
    full = list(range(T0, T0 + 5 * HOUR, HOUR))
    monkeypatch.setattr(ff, "_urlopen", lambda *a, **k: pytest.fail("no probe expected"))
    assert ff.check_ends(7, full, T0, T0 + 5 * HOUR, ff.RateLimiter(0.0)) is False


def test_verify_existing_accepts_a_good_file_and_skips_it_afterwards(tmp_path, monkeypatch):
    api = FakeApi(T0)
    install(monkeypatch, api)
    ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE)
    strip_ends_checked(tmp_path)
    n = len(api.requests)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE, verify_only=True) == 0
    assert (tmp_path / "funding" / "market_7.parquet").exists()
    last = funding_manifest(tmp_path)[-1]
    assert last["status"] == "ok" and last["ends_checked"] is True
    assert len(api.requests) - n == 1  # head probe only: the last row is the final hour
    # With ends_checked on the latest line the file is skipped without any request.
    n = len(api.requests)
    ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE)
    assert len(api.requests) == n


def test_verify_existing_rejects_a_truncated_file_and_the_next_run_refetches(tmp_path, monkeypatch):
    api = FakeApi(T0)
    install(monkeypatch, api)
    ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE)
    path = tmp_path / "funding" / "market_7.parquet"
    table = pq.read_table(path)
    pq.write_table(table.slice(0, table.num_rows - 100), path)
    strip_ends_checked(tmp_path)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE, verify_only=True) == 1
    assert not path.exists()
    last = funding_manifest(tmp_path)[-1]
    assert last["status"] == "failed" and "ends_checked" not in last and "after the last row" in last["reason"]
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 0
    assert pq.read_table(path).num_rows == table.num_rows


def test_verify_only_does_not_fetch_missing_markets(tmp_path, monkeypatch):
    api = FakeApi(T0)
    install(monkeypatch, api)
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE, verify_only=True) == 0
    assert api.requests == [] and not list((tmp_path / "funding").glob("*.parquet"))


def test_normal_run_verifies_an_old_file_instead_of_skipping_it(tmp_path, monkeypatch):
    api = FakeApi(T0)
    install(monkeypatch, api)
    ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE)
    path = tmp_path / "funding" / "market_7.parquet"
    table = pq.read_table(path)
    pq.write_table(table.slice(0, table.num_rows - 100), path)
    strip_ends_checked(tmp_path)
    # A normal run catches the truncation, deletes the file and refetches it in the same run.
    assert ff.run(tmp_path, ft.FIRST_DATE, ft.FOLD_LAST_DATE) == 0
    assert pq.read_table(path).num_rows == table.num_rows
    statuses = [r["status"] for r in funding_manifest(tmp_path)]
    assert statuses[-2:] == ["failed", "ok"]
    assert funding_manifest(tmp_path)[-1]["ends_checked"] is True


def write_markets_file(path, version=3):
    books = [
        {
            "symbol": "MKR",
            "market_id": 28,
            "market_type": "perp",
            "created_at": str(T0 * 1000),
            "listed_in_order_books": False,
        },
        {
            "symbol": "AAA",
            "market_id": 7,
            "market_type": "perp",
            "created_at": str(T0 * 1000),
            "listed_in_order_books": True,
        },
        {
            "symbol": "ZZZ/USDC",
            "market_id": 2055,
            "market_type": "spot",
            "created_at": "0",
            "listed_in_order_books": False,
        },
    ]
    path.write_text(json.dumps({"markets_file_version": version, "order_books": books, "unknown_market_ids": []}))
    return path


def test_markets_file_fetches_a_delisted_market_without_any_orderbooks_request(tmp_path, monkeypatch):
    api = FakeApi(T0)
    install(monkeypatch, api)
    mf = write_markets_file(tmp_path / "markets.json")
    assert ff.run(tmp_path / "out", ft.FIRST_DATE, ft.FOLD_LAST_DATE, {28}, markets_file=mf) == 0
    assert api.order_book_requests == 0
    assert set(api.market_ids_seen) == {28}
    out = tmp_path / "out" / "funding"
    assert [p.name for p in out.glob("*.parquet")] == ["market_28.parquet"]
    df = pq.read_table(out / "market_28.parquet").to_pandas()
    assert df.symbol.iloc[0] == "MKR" and len(df) == (ff.end_exclusive_s() - T0) // HOUR


def test_markets_file_without_market_ids_takes_every_perp_and_skips_spot(tmp_path, monkeypatch):
    api = FakeApi(T0)
    install(monkeypatch, api)
    mf = write_markets_file(tmp_path / "markets.json")
    assert ff.run(tmp_path / "out", ft.FIRST_DATE, ft.FOLD_LAST_DATE, markets_file=mf) == 0
    assert api.order_book_requests == 0
    assert sorted(p.name for p in (tmp_path / "out" / "funding").glob("*.parquet")) == [
        "market_28.parquet",
        "market_7.parquet",
    ]
    assert 2055 not in api.market_ids_seen


def test_markets_file_rejects_an_id_it_does_not_hold_and_a_spot_id(tmp_path, monkeypatch):
    api = FakeApi(T0)
    install(monkeypatch, api)
    mf = write_markets_file(tmp_path / "markets.json")
    with pytest.raises(ft.FoldError, match=r"not perp markets in the markets file: \[999\]"):
        ff.run(tmp_path / "out", ft.FIRST_DATE, ft.FOLD_LAST_DATE, {28, 999}, markets_file=mf)
    with pytest.raises(ft.FoldError, match=r"not perp markets in the markets file: \[2055\]"):
        ff.run(tmp_path / "out", ft.FIRST_DATE, ft.FOLD_LAST_DATE, {2055}, markets_file=mf)
    assert api.requests == []


def test_markets_file_must_be_version_2_or_later(tmp_path, monkeypatch):
    install(monkeypatch, FakeApi(T0))
    mf = write_markets_file(tmp_path / "markets.json", version=1)
    with pytest.raises(ft.FoldError, match="version 2 or later"):
        ff.run(tmp_path / "out", ft.FIRST_DATE, ft.FOLD_LAST_DATE, markets_file=mf)
    with pytest.raises(ft.FoldError, match="cannot read markets file"):
        ff.run(tmp_path / "out", ft.FIRST_DATE, ft.FOLD_LAST_DATE, markets_file=tmp_path / "missing.json")


def test_manifest_records_the_markets_source(tmp_path, monkeypatch):
    install(monkeypatch, FakeApi(T0))
    mf = write_markets_file(tmp_path / "markets.json")
    ff.run(tmp_path / "from_file", ft.FIRST_DATE, ft.FOLD_LAST_DATE, {28}, markets_file=mf)
    [rec] = funding_manifest(tmp_path / "from_file")
    assert rec["markets_source"] == ft.sha256_file(mf) and rec["status"] == "ok" and rec["ends_checked"] is True
    ff.run(tmp_path / "default", ft.FIRST_DATE, ft.FOLD_LAST_DATE)
    [rec] = funding_manifest(tmp_path / "default")
    assert rec["markets_source"] == "orderBooks"


def test_failed_and_empty_manifest_lines_carry_the_source_and_default_mode_is_unchanged(tmp_path, monkeypatch):
    api = FakeApi(T0, empty_ordinals=[0])
    install(monkeypatch, api)
    mf = write_markets_file(tmp_path / "markets.json")
    assert ff.run(tmp_path / "o", ft.FIRST_DATE, ft.FOLD_LAST_DATE, {28}, markets_file=mf) == 1
    assert funding_manifest(tmp_path / "o")[0]["markets_source"] == ft.sha256_file(mf)
    # Default mode still asks orderBooks and still rejects an id it does not list.
    assert api.order_book_requests == 0
    with pytest.raises(ft.FoldError, match="not perp markets in orderBooks"):
        ff.run(tmp_path / "d", ft.FIRST_DATE, ft.FOLD_LAST_DATE, {28})
    assert api.order_book_requests == 1


def test_existing_checked_file_is_skipped_in_markets_file_mode(tmp_path, monkeypatch):
    api = FakeApi(T0)
    install(monkeypatch, api)
    mf = write_markets_file(tmp_path / "markets.json")
    ff.run(tmp_path / "o", ft.FIRST_DATE, ft.FOLD_LAST_DATE, {28}, markets_file=mf)
    n = len(api.requests)
    ff.run(tmp_path / "o", ft.FIRST_DATE, ft.FOLD_LAST_DATE, {28}, markets_file=mf)
    assert len(api.requests) == n


def test_cli_passes_the_markets_file(tmp_path, monkeypatch):
    api = FakeApi(T0)
    install(monkeypatch, api)
    mf = write_markets_file(tmp_path / "markets.json")
    rc = ff.main(["--out-dir", str(tmp_path / "o"), "--markets-file", str(mf), "--market-ids", "28"])
    assert rc == 0 and api.order_book_requests == 0
