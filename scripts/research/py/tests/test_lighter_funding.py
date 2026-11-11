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

    def __init__(self, since, holes=(), flaky=()):
        self.since = since
        self.holes = set(holes)
        self.flaky = set(flaky)
        self.requests = []

    def __call__(self, req, timeout=0):
        url = req.full_url
        if url.startswith(ft.ORDER_BOOKS_URL):
            books = [
                {"symbol": "AAA", "market_id": 7, "market_type": "perp", "created_at": str(self.since * 1000)},
                {"symbol": "BBB", "market_id": 8, "market_type": "spot", "created_at": "0"},
            ]
            return reply({"order_books": books})
        p = params(req)
        self.requests.append(p)
        assert p["count_back"] == 0 and p["resolution"] == "1h"
        assert p["end_timestamp"] <= ff.end_exclusive_s()
        direct = p["end_timestamp"] - p["start_timestamp"] <= HOUR + 1
        rows = []
        first = p["start_timestamp"] + HOUR
        for ts in range(first + (-first) % HOUR, p["end_timestamp"], HOUR):
            if ts < self.since or ts in self.holes or (ts in self.flaky and not direct):
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
