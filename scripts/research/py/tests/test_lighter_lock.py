"""Tests for lighter/lock.py (grid, constants, symbol mapping) and lighter/data.py plus the eligibility rule of
lighter/run.py (span guards, missing data, monthly eligibility and tiers, the price source by month).
Synthetic files only, all under tmp_path."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import inspect
import json
from collections import Counter
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from lighter import data, lock, run
from lighter import fold_trades as ft
from lighter.data import DataReader, Market, SpanError
from lighter.synthetic import PanelSpec, make_panel

DAY = 86_400_000


@pytest.fixture(autouse=True)
def no_real_git(monkeypatch):
    """No test depends on a real git: by default a clean tree at a fixed head (tests that need more use git_calls)."""
    monkeypatch.setattr(run, "_git", lambda args: "abc\n" if args[0] == "rev-parse" else "")


# ----------------------------------------------------------------------------------------------------------------
# The grid


def test_grid_has_2064_unique_configurations():
    assert len(lock.GRID) == 2064 == lock.TRIALS
    assert len(set(lock.CONFIG_IDS)) == 2064
    assert len(lock.SIGNALS) == 57 and len(lock.FUNDING_SIGNALS) == 6
    by_family = Counter(c.family for c in lock.GRID)
    assert by_family == {"F1": 324, "F2": 324, "F3": 324, "F4": 864, "F5": 216, "F6": 12}
    assert Counter(s.family for s in lock.SIGNALS) == {"F1": 9, "F2": 9, "F3": 9, "F4": 24, "F5": 6}


def test_grid_axes():
    f1 = [c for c in lock.GRID if c.family == "F1"]
    assert {c.hold for c in f1} == {5, 15, 30, 60, 120, 240}
    assert {c.exit for c in f1} == {"time", "stop2_target2", "target1"}
    assert {c.universe for c in f1} == {"A", "AB"}
    f6 = [c for c in lock.GRID if c.family == "F6"]
    assert {c.hold for c in f6} == {10, 20} and {c.exit for c in f6} == {"time"}
    assert lock.CONFIG_BY_ID["F4-small-k12-q0.9-fade-h240-target1-AB"].signal.p("direction") == "fade"
    assert {s.p("k") for s in lock.SIGNALS if s.family == "F4"} == {3, 12}
    assert {s.p("q") for s in lock.SIGNALS if s.family == "F4"} == {0.8, 0.9}
    assert {s.p("theta") for s in lock.SIGNALS if s.family == "F5"} == {2, 4, 8}


def test_ids_and_order_are_frozen():
    digest = hashlib.sha256("\n".join(lock.CONFIG_IDS).encode()).hexdigest()
    assert digest == "5b6b24882c183fc8ac6bb39c7dbcd583fb254e4ba16ca2a1e06961ddef6ee4da"
    assert lock.GRID[0].cid == "F1-k1-th1.0-h5-time-A"
    assert lock.GRID[-1].cid == "F6-th4-x20-time-AB"
    assert len(lock.lock_digest()) == 64


def test_prediction_ledger_and_fill_delay():
    assert lock.PREDICTION == (
        "Registered 2026-11-11 by the lead before any run: no finalist passes the confirmation slice. "
        "Most likely no configuration passes development item (b)."
    )
    assert lock.LEDGER_ID == "lighter-l1"
    assert lock.FILL_DELAY_MS == 500 == ft.FILL_DELAY_MS
    assert lock.__doc__ is not None and "no finalist passes the confirmation slice" in " ".join(lock.__doc__.split())
    for fam in ("F1", "F2", "F3", "F4", "F5", "F6"):
        assert fam in lock.__doc__


def test_class_tuples_are_disjoint_and_sized_as_registered():
    groups = (lock.CRYPTO_SYMBOLS, lock.TRADFI_SYMBOLS, lock.UNCLASSIFIED_SYMBOLS)
    assert [len(g) for g in groups] == [123, 103, 17]
    allsyms = [s for g in groups for s in g]
    assert len(set(allsyms)) == len(allsyms) == 243  # no symbol in two tuples
    assert set(lock.BINANCE_MAP) == set(allsyms)  # the literal map covers every symbol and nothing else


ADDED_2026_11_11 = ("MKR", "RESOLV", "PROVE", "DOLO", "MYX", "EDEN", "FOGO", "URA")


def test_the_eight_symbols_added_for_delisted_markets_classify_and_map():
    for sym in ADDED_2026_11_11[:-1]:
        assert lock.symbol_class(sym) == "crypto" and sym in lock.CRYPTO_SYMBOLS
    assert lock.symbol_class("URA") == "tradfi" and "URA" in lock.TRADFI_SYMBOLS
    for sym in ADDED_2026_11_11:
        assert lock.BINANCE_MAP[sym] == sym + "USDT" and lock.binance_symbol(sym) == sym + "USDT"
        assert Market(sym, 1, 2).binance_symbol == sym + "USDT"
    doc = " ".join(lock.__doc__.split())
    assert "2026-11-11" in doc and "delisted" in doc and "listed_in_order_books false" in doc
    assert "If one meets the activity clause the run stops." in doc


def test_symbol_class_and_markets():
    assert lock.symbol_class("BTC") == "crypto" and lock.symbol_class("1000PEPE") == "crypto"
    assert lock.symbol_class("XAU") == "tradfi" and lock.symbol_class("EURUSD") == "tradfi"
    assert lock.symbol_class("CHIP") == "unclassified"
    for bad in ("kPEPE", "btc", "NOPE", ""):
        with pytest.raises(ValueError, match="in 0 of the three"):
            lock.symbol_class(bad)
    assert Market("ETH", 2, 2).cls == "crypto" and Market("BTC", 1, 2).is_leader and not Market("kBTC", 3, 2).is_leader
    assert Market("ETH", 2, 2).coin == "ETH" and Market("CHIP", 9, 2).cls == "unclassified"


def test_a_symbol_in_two_tuples_is_an_error(monkeypatch):
    monkeypatch.setattr(lock, "TRADFI_SYMBOLS", (*lock.TRADFI_SYMBOLS, "BTC"))
    with pytest.raises(ValueError, match="BTC"):
        lock.symbol_class("BTC")


def test_binance_map_is_literal_and_has_the_registered_exceptions():
    none_symbols = {
        "HYUNDAIUSD",
        "SAMSUNGUSD",
        "SKHYNIXUSD",
        "US100",
        "US10Y",
        "US500",
        "TUR30",
        "USDHKD",
        "USDKRW",
    }
    assert {s for s, v in lock.BINANCE_MAP.items() if v is None} == none_symbols
    for sym, v in lock.BINANCE_MAP.items():
        assert v is None or v == sym + "USDT"
    assert lock.binance_symbol("1000PEPE") == "1000PEPEUSDT" and lock.binance_symbol("US100") is None
    assert lock.binance_symbol("BTC") == "BTCUSDT"
    assert not hasattr(lock, "BINANCE_SYMBOL_OVERRIDES") and not hasattr(lock, "strip_k")
    assert Market("US500", 1, 2).binance_symbol is None
    src = inspect.getsource(lock)
    code = src.split("BINANCE_MAP: dict[str, str | None] = {")[1].split("\n}\n")[0]
    assert " for " not in code and code.count('":') == 243  # written out entry by entry, no comprehension


def test_tier_rule_boundaries():
    assert lock.classify_tier(5000, 1000, 1.0) == "A"
    assert lock.classify_tier(5000, 1000, 0.0) == "A"
    assert lock.classify_tier(5000, 1000, 1.0000001) == "B"
    assert lock.classify_tier(5000, 1000, 2.5) == "B"
    assert lock.classify_tier(5000, 1000, 2.5000001) is None
    assert lock.classify_tier(4999.9, 1000, 0.5) is None
    assert lock.classify_tier(5000, 999, 0.5) is None


def test_the_universe_file_is_gone():
    assert not hasattr(data, "load_universe")
    parser = run.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(
            ["dev", "--fold-dir", "a", "--binance-dir", "b", "--funding-dir", "c", "--universe", "u", "--out-dir", "o"]
        )


# ----------------------------------------------------------------------------------------------------------------
# Span guards


@pytest.fixture(scope="module")
def tiny_panel(tmp_path_factory):
    return make_panel(tmp_path_factory.mktemp("tiny"), PanelSpec(n_markets=2, days=3, seed=2, pre_days=2))


def reader_for(panel, mode="dev", last_date=None):
    return DataReader(
        fold_dir=panel.fold_dir,
        binance_dir=panel.binance_dir,
        funding_dir=panel.funding_dir,
        mode=mode,
        last_date=last_date,
    )


def test_dev_reader_stops_at_2026_06_30(tiny_panel):
    r = reader_for(tiny_panel)
    assert r.last_date == dt.date(2026, 6, 30) == lock.DEV_LAST_DATE
    r.check_day(dt.date(2026, 6, 30))
    with pytest.raises(SpanError):
        r.check_day(dt.date(2026, 7, 1))
    with pytest.raises(SpanError):
        reader_for(tiny_panel, "dev", dt.date(2026, 7, 1))
    with pytest.raises(SpanError):
        r.check_end_ms(ft.day_start_ms(dt.date(2026, 7, 1)) + 60_000)
    m = tiny_panel.markets[0]
    with pytest.raises(SpanError):
        r.load_minutes(m, ft.day_start_ms(dt.date(2026, 6, 30)), ft.day_start_ms(dt.date(2026, 7, 2)))
    with pytest.raises(SpanError):
        r.load_funding(m.market_id, ft.day_start_ms(dt.date(2026, 7, 2)))
    with pytest.raises(SpanError):
        r.month_cost_stats(2026, 7)  # the cost figures of July 2026 are confirmation data


def test_nothing_from_2026_11_01_is_ever_read(tiny_panel, tmp_path, monkeypatch):
    r = reader_for(tiny_panel, "confirm")
    assert r.last_date == dt.date(2026, 10, 31)
    r.check_day(dt.date(2026, 10, 31))
    with pytest.raises(SpanError):
        r.check_day(dt.date(2026, 11, 1))
    with pytest.raises(SpanError):
        reader_for(tiny_panel, "confirm", dt.date(2026, 11, 1))
    with pytest.raises(SpanError):
        r.check_end_ms(ft.day_start_ms(dt.date(2026, 11, 1)) + 1)
    late = tiny_panel.fold_dir / "v1" / "date=2026-11-01.parquet"
    pq.write_table(pa.table({"market_id": pa.array([1], pa.int16()), "n_trades": pa.array([9], pa.int64())}), late)
    opened: list[str] = []
    real = pq.read_table

    def spy(path, *a, **k):
        opened.append(str(path))
        return real(path, *a, **k)

    monkeypatch.setattr(data.pq, "read_table", spy)
    with pytest.raises(SpanError):
        r.month_cost_stats(2026, 11)
    with pytest.raises(SpanError):
        r.load_minutes(
            tiny_panel.markets[0], ft.day_start_ms(dt.date(2026, 10, 31)), ft.day_start_ms(dt.date(2026, 11, 2))
        )
    assert not any("2026-11" in p for p in opened)
    with pytest.raises(SpanError):
        DataReader(fold_dir=tmp_path, binance_dir=tmp_path, funding_dir=tmp_path, mode="forward")


def test_funding_rows_after_the_end_never_enter_memory_or_the_hash(tmp_path):
    def write(late_rate):
        ts = np.arange(10, dtype=np.int64) * 3600 + ft.day_start_ms(dt.date(2025, 7, 1)) // 1000
        rate = np.concatenate([np.full(5, 1e-4), np.full(5, late_rate)])
        pq.write_table(
            pa.table({"timestamp": pa.array(ts), "rate_long_pays": pa.array(rate)}), tmp_path / "market_7.parquet"
        )

    end_ms = ft.day_start_ms(dt.date(2025, 7, 1)) + 5 * 3_600_000
    hashes = []
    for late in (5e-4, -9e-4):
        write(late)
        r = DataReader(
            fold_dir=tmp_path, binance_dir=tmp_path, funding_dir=tmp_path, mode="dev", last_date=dt.date(2025, 7, 1)
        )
        ts, rate = r.load_funding(7, end_ms)
        assert len(ts) == 5 and (rate == 1e-4).all()
        hashes.append(r.manifest["funding/market_7.parquet"])
    assert hashes[0] == hashes[1]  # the hash covers the allowed rows only


def test_confirm_needs_a_finalists_file(tmp_path):
    base = {"fold_dir": tmp_path, "binance_dir": tmp_path, "funding_dir": tmp_path, "out_dir": tmp_path / "out"}
    with pytest.raises(SystemExit):
        run.cmd_confirm(argparse.Namespace(**base, finalists=None))
    with pytest.raises(SystemExit):
        run.cmd_confirm(argparse.Namespace(**base, finalists=str(tmp_path / "missing.json")))
    with pytest.raises(SystemExit):
        run.main(["confirm", *sum(([f"--{k.replace('_', '-')}", str(v)] for k, v in base.items()), [])])


def test_eligibility_through_confirm_needs_the_same_finalists_file(tmp_path):
    base = {"fold_dir": tmp_path, "binance_dir": tmp_path, "out_dir": tmp_path / "out"}
    with pytest.raises(SystemExit):
        run.cmd_eligibility(argparse.Namespace(**base, through="confirm", finalists=None))
    bad = tmp_path / "f.json"
    bad.write_text(json.dumps({"lock_sha256": "0" * 64, "finalists": []}))
    with pytest.raises(SystemExit):
        run.cmd_eligibility(argparse.Namespace(**base, through="confirm", finalists=str(bad)))
    with pytest.raises(SystemExit):
        run.cmd_eligibility(argparse.Namespace(**base, through="forward", finalists=str(bad)))
    # the dev reader refuses dates past 2026-06-30 even when asked for them
    with pytest.raises(SpanError):
        run.cmd_eligibility(argparse.Namespace(**base, through="dev"), last_date=dt.date(2026, 7, 31))


def test_null_seed_must_be_one_to_twenty(tmp_path):
    args = argparse.Namespace(fold_dir=tmp_path, binance_dir=tmp_path, funding_dir=tmp_path, out_dir=tmp_path, seed=21)
    with pytest.raises(SystemExit):
        run.cmd_null(args)


def test_only_data_py_opens_input_data_files():
    """No other module may read fold, Binance or funding files."""
    root = Path(inspect.getfile(data)).parent
    for name in ("signals", "fills", "stats", "run"):
        src = (root / f"{name}.py").read_text()
        for needle in ("read_table", "read_csv", "gzip.open", "ParquetFile", "open("):
            if name == "run" and needle == "read_table":
                continue  # run.py reads back its own trade lists
            assert needle not in src, (name, needle)


# ----------------------------------------------------------------------------------------------------------------
# Hand-built fold months for the eligibility rule

MID_PX = 200_000  # raw price: a diff of d raw units around it is d / 20 bps
TS0 = 1_700_000_000_000


class MM:
    """One market's month: day activity, qualifying minutes and their spread."""

    def __init__(
        self, activity=5000, qualifying=1000, diff=16, gap=0, extra=0, extra_diff=1000, null_rows=0, active_days=None
    ):
        self.activity, self.qualifying, self.diff, self.gap = activity, qualifying, diff, gap
        self.extra, self.extra_diff, self.null_rows, self.active_days = extra, extra_diff, null_rows, active_days


def write_markets_json(root: Path, symbols: dict[int, str], version=2, source="synthetic"):
    books = [
        {"symbol": s, "market_id": i, "market_type": "perp", "supported_price_decimals": 2} for i, s in symbols.items()
    ]
    books.append({"symbol": "ETH/USDC", "market_id": 900, "market_type": "spot", "supported_price_decimals": 2})
    doc = {"markets_file_version": version, "order_books": books}
    if source is not None:
        doc["source"] = source
    (root / "markets.json").write_text(json.dumps(doc))


def write_fold_month(root: Path, year: int, month: int, spec: dict[int, MM], skip=(), manifest=True, files=True):
    (root / "v1").mkdir(parents=True, exist_ok=True)
    days = data.month_days(year, month)
    for d, day in enumerate(days):
        iso = day.isoformat()
        if not files or iso in skip:
            if manifest and iso not in skip:
                with open(root / "manifest.jsonl", "a") as f:
                    f.write(json.dumps({"date": iso, "output_sha256": "0" * 64}) + "\n")
            continue
        cols = {k: [] for k in ("market_id", "n_trades", "last_buy_px", "last_buy_ts", "last_sell_px", "last_sell_ts")}

        def row(mid, n, bpx, bts, spx, sts, cols=cols):
            for k, v in zip(cols, (mid, n, bpx, bts, spx, sts), strict=True):
                cols[k].append(v)

        for mid, m in spec.items():
            active = list(range(len(days))) if m.active_days is None else m.active_days
            if d not in active:
                continue
            row(mid, m.activity, None, None, None, None)
            for i in range(m.qualifying):
                if active[i % len(active)] == d:
                    t = TS0 + i
                    row(mid, 0, MID_PX + m.diff // 2, t, MID_PX - m.diff // 2, t + m.gap)
            for i in range(m.extra):
                if active[i % len(active)] == d:
                    t = TS0 + i
                    row(mid, 0, MID_PX + m.extra_diff // 2, t, MID_PX - m.extra_diff // 2, t + 2001)
            for i in range(m.null_rows):
                if active[i % len(active)] == d:
                    row(mid, 0, MID_PX + 500, TS0, None, None)
        table = pa.table(
            {
                "market_id": pa.array(cols["market_id"], pa.int16()),
                "n_trades": pa.array(cols["n_trades"], pa.int64()),
                "last_buy_px": pa.array(cols["last_buy_px"], pa.int64()),
                "last_buy_ts": pa.array(cols["last_buy_ts"], pa.int64()),
                "last_sell_px": pa.array(cols["last_sell_px"], pa.int64()),
                "last_sell_ts": pa.array(cols["last_sell_ts"], pa.int64()),
            }
        )
        path = root / "v1" / f"date={iso}.parquet"
        pq.write_table(table, path)
        if manifest and iso not in skip:
            with open(root / "manifest.jsonl", "a") as f:
                f.write(
                    json.dumps({"date": iso, "output_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}) + "\n"
                )


NAMES = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LINK", "AVAX", "DOT", "LTC", "BCH", "TRX", "AAVE", "UNI"]
SYMBOLS = {i: NAMES[i - 1] for i in range(1, 15)}
JUNE = {
    1: MM(),  # tier A, proxy 0.8
    2: MM(activity=4999),  # one trade short of the median
    3: MM(qualifying=999),  # one minute short
    4: MM(diff=20),  # exactly 1.0 bps: tier A
    5: MM(diff=22),  # 1.1: tier B
    6: MM(diff=50),  # exactly 2.5: tier B
    7: MM(diff=52),  # 2.6: not eligible
    8: MM(gap=2000),  # a gap of exactly 2,000 ms still qualifies
    9: MM(gap=2001),  # a gap of 2,001 ms never qualifies
    10: MM(extra=1500, extra_diff=1000),  # wide pairs 2,001 ms apart are ignored: tier A
    11: MM(diff=-60),  # last buy below last sell: median -3 bps, floored at 0
    12: MM(activity=6000, active_days=list(range(16))),  # 16 of 30 days with rows: median 6000
    13: MM(activity=6000, active_days=list(range(15))),  # 15 of 30: median 3000
    14: MM(null_rows=2000),  # rows with a missing last_sell_px do not count
}


def june_root(tmp_path, spec=None, **kw):
    root = tmp_path / "fold"
    root.mkdir(exist_ok=True)
    (root / "manifest.jsonl").write_text("")
    (root / "SYNTHETIC").write_text("test\n")
    write_markets_json(root, SYMBOLS)
    write_fold_month(root, 2025, 6, JUNE if spec is None else spec, **kw)
    return root


def dev_reader(root, last=dt.date(2025, 7, 31), binance=None):
    return DataReader(fold_dir=root, binance_dir=binance, mode="dev", last_date=last)


def test_eligibility_clauses_and_boundaries(tmp_path):
    root = june_root(tmp_path)
    r = dev_reader(root)
    markets = r.load_markets()
    assert [m.market_id for m in markets] == list(range(1, 15))  # the spot entry is not a market
    elig = run.compute_eligibility(r, markets, [(2025, 7)])[(2025, 7)]
    tiers = {mid: info.tier for mid, info in elig.items()}
    assert tiers == {1: "A", 4: "A", 5: "B", 6: "B", 8: "A", 10: "A", 11: "A", 12: "A", 14: "A"}
    assert 2 not in elig and 3 not in elig and 7 not in elig and 9 not in elig and 13 not in elig
    assert elig[1].tier == "A" and elig[1].spread_proxy_bps == pytest.approx(0.8) and elig[1].qualifying_minutes == 1000
    assert elig[4].tier == "A" and elig[4].spread_proxy_bps == 1.0  # exactly the tier A limit
    assert elig[5].tier == "B" and elig[5].spread_proxy_bps == pytest.approx(1.1)
    assert elig[6].tier == "B" and elig[6].spread_proxy_bps == 2.5  # exactly the tier B limit
    assert elig[8].tier == "A" and elig[8].qualifying_minutes == 1000
    assert (
        elig[10].tier == "A" and elig[10].qualifying_minutes == 1000 and elig[10].spread_proxy_bps == pytest.approx(0.8)
    )
    assert elig[11].tier == "A" and elig[11].spread_proxy_bps == 0.0
    assert elig[12].activity_median == 6000.0 and elig[12].tier == "A"
    assert elig[14].qualifying_minutes == 1000  # the 2,000 rows without a last_sell_px are not minutes of the proxy
    assert elig[1].activity_median == 5000.0
    stats_13 = r.month_cost_stats(2025, 6)[13]
    assert stats_13.activity_median == 3000.0  # a day without rows counts 0
    assert r.month_cost_stats(2025, 6)[2].activity_median == 4999.0
    assert r.month_cost_stats(2025, 6)[3].qualifying_minutes == 999
    assert r.month_cost_stats(2025, 6)[9].qualifying_minutes == 0


def test_eligibility_of_a_month_uses_only_the_previous_month(tmp_path, monkeypatch):
    root = june_root(tmp_path)
    opened: list[str] = []
    real = pq.read_table

    def spy(path, *a, **k):
        opened.append(str(path))
        return real(path, *a, **k)

    monkeypatch.setattr(data.pq, "read_table", spy)
    r = dev_reader(root)
    before = run.compute_eligibility(r, r.load_markets(), [(2025, 7)])
    assert opened and all("date=2025-06-" in p for p in opened)
    # July and August rows (any content) cannot change July's eligibility
    garbage = {i: MM(activity=1, qualifying=1, diff=9999) for i in range(1, 15)}
    write_fold_month(root, 2025, 7, garbage)
    write_fold_month(root, 2025, 8, garbage)
    r2 = dev_reader(root, dt.date(2025, 8, 31))
    after = run.compute_eligibility(r2, r2.load_markets(), [(2025, 7), (2025, 8)])
    assert after[(2025, 7)] == before[(2025, 7)]
    assert after[(2025, 8)] == {}  # August is decided by July, which is garbage here


def test_eligibility_reads_cost_fields_only_and_never_a_binance_file(tmp_path, monkeypatch):
    root = june_root(tmp_path)
    binance = tmp_path / "binance"
    for sym in ("BTCUSDT", "XRPUSDT"):  # markets 1 and 4
        (binance / sym).mkdir(parents=True)
        for ym in ("2025-06", "2025-07"):
            (binance / sym / f"{sym}-1m-{ym}.csv.gz").write_bytes(b"not a gzip file")
    columns: list[tuple[str, ...]] = []
    real = pq.read_table

    def spy(path, *a, **k):
        columns.append(tuple(k.get("columns") or ()))
        return real(path, *a, **k)

    def boom(*a, **k):
        raise AssertionError("a Binance file was opened")

    monkeypatch.setattr(data.pq, "read_table", spy)
    monkeypatch.setattr(data.gzip, "open", boom)
    monkeypatch.setattr(data.pd, "read_csv", boom)
    args = argparse.Namespace(
        fold_dir=root, binance_dir=binance, out_dir=tmp_path / "out", through="dev", finalists=None
    )
    path = run.cmd_eligibility(args, last_date=dt.date(2025, 7, 31))
    allowed = set(data.ELIGIBILITY_COLUMNS)
    assert columns and all(c and set(c) <= allowed for c in columns)
    forbidden = {"first_buy_px", "first_sell_px", "vwap_px", "last_px", "first_buy_ts", "first_sell_ts"}
    assert not forbidden & {name for c in columns for name in c}
    doc = json.loads(path.read_text())
    by_symbol = {r["symbol"]: r for r in doc["months"]["2025-07"]["eligible"]}
    # existence only: the Binance file is junk bytes, the month says "source pending guard"
    assert by_symbol["BTC"]["source"] == "source pending guard" and by_symbol["XRP"]["source"] == "source pending guard"
    assert by_symbol["DOGE"]["source"] == "lighter"  # no files for DOGEUSDT
    assert (
        doc["kind"] == "eligibility"
        and doc["through"] == "dev"
        and doc["months"]["2025-07"]["previous_month"] == "2025-06"
    )
    eligible = (1, 4, 5, 6, 8, 10, 11, 12, 14)
    assert doc["binance_symbols"] == sorted({NAMES[i - 1] + "USDT" for i in eligible})
    assert doc["binance_months_needed"]["BTCUSDT"] == ["2025-06", "2025-07"]
    assert {r["tier"] for r in doc["months"]["2025-07"]["eligible"]} == {"A", "B"}
    assert not any(k.startswith("binance/") for k in doc["manifest"])
    assert set(doc["manifest"]) >= {"fold/markets.json", "fold/manifest.jsonl", "fold/date=2025-06-01.parquet"}
    assert (
        "computes no signal and no return"
        in run.build_parser()._subparsers._group_actions[0].choices["eligibility"].description
    )


def test_monthly_source_needs_files_for_both_months_and_uses_the_literal_map(tmp_path):
    root = tmp_path / "fold"
    root.mkdir()
    (root / "manifest.jsonl").write_text("")
    (root / "SYNTHETIC").write_text("test\n")
    write_markets_json(root, {1: "BTC", 2: "ETH", 3: "1000PEPE", 4: "XAU"})
    spec = {i: MM() for i in (1, 2, 3, 4)}
    for ym in ((2025, 6), (2025, 7)):
        write_fold_month(root, *ym, spec)
    binance = tmp_path / "binance"

    def touch(sym, y, m):
        (binance / sym).mkdir(parents=True, exist_ok=True)
        (binance / sym / f"{sym}-1m-{y:04d}-{m:02d}.csv.gz").write_bytes(b"")

    touch("BTCUSDT", 2025, 6)
    touch("BTCUSDT", 2025, 7)  # both months: binance in July
    touch("ETHUSDT", 2025, 7)  # only M, not P: lighter
    touch("1000PEPEUSDT", 2025, 6)
    touch("1000PEPEUSDT", 2025, 7)  # 1000PEPE maps to 1000PEPEUSDT
    touch("PEPEUSDT", 2025, 6)  # another name does not count
    r = dev_reader(root, dt.date(2025, 8, 31), binance)
    elig = run.compute_eligibility(r, r.load_markets(), [(2025, 7), (2025, 8)])
    july = elig[(2025, 7)]
    assert [july[i].source for i in (1, 2, 3, 4)] == ["pending", "lighter", "pending", "lighter"]
    assert july[3].binance_symbol == "1000PEPEUSDT" and july[1].binance_symbol == "BTCUSDT"
    # August is eligible only if July's rows qualify it: they do, and the August Binance files are missing: lighter
    aug = elig[(2025, 8)]
    assert {i.source for i in aug.values()} == {"lighter"}
    touch("BTCUSDT", 2025, 8)
    r = dev_reader(root, dt.date(2025, 8, 31), binance)
    assert run.compute_eligibility(r, r.load_markets(), [(2025, 8)])[(2025, 8)][1].source == "pending"
    doc = run.eligibility_document(elig, r.load_markets(), r.fold_market_ids)
    assert "1000PEPEUSDT" in doc["binance_symbols"]
    assert doc["binance_months_needed"]["1000PEPEUSDT"] == ["2025-06", "2025-07", "2025-08"]


def test_eligibility_survives_a_market_going_quiet(tmp_path):
    """A market eligible in July and quiet in July's rows is out in August, and back when it qualifies again."""
    root = june_root(tmp_path, spec={1: MM(), 2: MM()})
    write_fold_month(root, 2025, 7, {1: MM(activity=4000), 2: MM()})
    r = dev_reader(root, dt.date(2025, 8, 31))
    elig = run.compute_eligibility(r, r.load_markets(), [(2025, 7), (2025, 8)])
    assert set(elig[(2025, 7)]) == {1, 2} and set(elig[(2025, 8)]) == {2}


# ----------------------------------------------------------------------------------------------------------------
# Missing data


def test_a_fold_day_absent_from_the_manifest_is_an_error(tmp_path):
    day = "2025-06-10"
    root = june_root(tmp_path, spec={1: MM()}, skip=(day,))  # neither listed nor written
    r = dev_reader(root)
    with pytest.raises(data.DataError, match=day):
        run.compute_eligibility(r, r.load_markets(), [(2025, 7)])
    # listed in the manifest but the file is missing
    (tmp_path / "b").mkdir()
    root2 = june_root(tmp_path / "b", spec={1: MM()}, skip=(day,))
    with open(root2 / "manifest.jsonl", "a") as f:
        f.write(json.dumps({"date": day}) + "\n")
    with pytest.raises(data.DataError, match=day):
        r2 = dev_reader(root2)
        run.compute_eligibility(r2, r2.load_markets(), [(2025, 7)])
    # the file exists but is not in the manifest
    (tmp_path / "c").mkdir()
    root3 = june_root(tmp_path / "c", spec={1: MM()}, manifest=False)
    r3 = dev_reader(root3)
    with pytest.raises(data.DataError, match="2025-06-01"):
        run.compute_eligibility(r3, r3.load_markets(), [(2025, 7)])


def test_a_listed_known_missing_day_is_tolerated_and_reported(tmp_path, monkeypatch):
    day = "2025-06-10"
    root = june_root(tmp_path, spec={1: MM(activity=5000, qualifying=1100)}, skip=(day,))
    r = dev_reader(root)
    monkeypatch.setattr(lock, "KNOWN_MISSING_FOLD_DAYS", (day,))
    elig = run.compute_eligibility(r, r.load_markets(), [(2025, 7)])
    assert 1 in elig[(2025, 7)] and elig[(2025, 7)][1].activity_median == 5000.0
    assert r.quality["known_missing_fold_days"] == [day]


def test_a_market_without_rows_on_a_day_is_normal(tmp_path):
    root = june_root(
        tmp_path, spec={1: MM(activity=6000, active_days=[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])}
    )
    r = dev_reader(root)
    assert run.compute_eligibility(r, r.load_markets(), [(2025, 7)])[(2025, 7)][1].activity_median == 6000.0


def test_markets_json_must_be_version_2_with_decimals(tmp_path):
    root = tmp_path / "fold"
    root.mkdir()
    write_markets_json(root, {1: "BTC"}, version=1)
    with pytest.raises(data.DataError):
        dev_reader(root).load_markets()
    write_markets_json(root, {1: "BTC", 5: "ETH"})
    markets = dev_reader(root).load_markets()
    assert [(m.symbol, m.market_id, m.price_decimals) for m in markets] == [("BTC", 1, 2), ("ETH", 5, 2)]
    (root / "markets.json").write_text(
        json.dumps(
            {
                "markets_file_version": 2,
                "order_books": [
                    {"symbol": "X", "market_id": 1, "market_type": "perp", "supported_price_decimals": None}
                ],
            }
        )
    )
    with pytest.raises(data.DataError):
        dev_reader(root).load_markets()
    (root / "markets.json").unlink()
    with pytest.raises(data.DataError):
        dev_reader(root).load_markets()


def test_a_missing_funding_file_with_trades_is_an_error(tmp_path):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=4, days=3, seed=4, pre_days=30))
    (panel.funding_dir / "market_1.parquet").unlink()
    args = argparse.Namespace(
        fold_dir=panel.fold_dir, binance_dir=panel.binance_dir, funding_dir=panel.funding_dir, out_dir=tmp_path / "o"
    )
    cfgs = [lock.CONFIG_BY_ID["F1-k1-th1.0-h5-time-AB"]]
    with pytest.raises(data.DataError, match="funding"):
        run.cmd_dev(args, last_date=panel.last_date, configs=cfgs)


# ----------------------------------------------------------------------------------------------------------------
# The lock digest covers the code


def test_lock_digest_hashes_every_lighter_py_file_and_changes_with_any_byte(tmp_path, monkeypatch):
    package = Path(inspect.getfile(lock)).parent
    want = hashlib.sha256()
    for path in sorted(package.glob("*.py"), key=lambda p: p.name):
        want.update(path.name.encode() + b"\0" + path.read_bytes() + b"\0")
    assert lock.lock_digest() == want.hexdigest()
    names = {p.name for p in package.glob("*.py")}
    assert {"fold_trades.py", "fetch_funding.py", "lock.py", "run.py", "fills.py", "signals.py"} <= names
    copy = tmp_path / "lighter"
    copy.mkdir()
    for path in package.glob("*.py"):
        (copy / path.name).write_bytes(path.read_bytes())
    monkeypatch.setattr(lock, "__file__", str(copy / "lock.py"))
    lock.lock_digest.cache_clear()
    try:
        assert lock.lock_digest() == want.hexdigest()
        for victim in ("fold_trades.py", "fills.py", "lock.py"):
            original = (copy / victim).read_bytes()
            (copy / victim).write_bytes(original + b"\n# edit\n")
            lock.lock_digest.cache_clear()
            assert lock.lock_digest() != want.hexdigest(), victim
            (copy / victim).write_bytes(original)
        (copy / "extra.py").write_text("x = 1\n")
        lock.lock_digest.cache_clear()
        assert lock.lock_digest() != want.hexdigest()
    finally:
        lock.lock_digest.cache_clear()


# ----------------------------------------------------------------------------------------------------------------
# Provenance: the git guard and the SYNTHETIC marker


@pytest.fixture
def git_calls(monkeypatch):
    """Replace run._git with a scripted one. calls collects the argument lists."""
    state = {"head": "abc123", "dirty": "", "calls": [], "fail": False}

    def fake(args):
        state["calls"].append(args)
        if state["fail"]:
            raise OSError("no git here")
        if args[0] == "rev-parse":
            return state["head"] + "\n"
        if args[0] == "status":
            return state["dirty"]
        raise AssertionError(args)

    monkeypatch.setattr(run, "_git", fake)
    return state


def mark_synthetic(root: Path):
    """The three conditions of a synthetic fold: the marker, markets.json from the generator, no https source."""
    (root / "SYNTHETIC").write_text("x")
    write_markets_json(root, {1: "BTC"})
    (root / "manifest.jsonl").write_text(json.dumps({"date": "2025-06-01"}) + "\n")


def test_a_clean_tree_runs_and_the_head_is_recorded(tmp_path, git_calls):
    prov = run.provenance(tmp_path)
    versions = prov.pop("versions")
    assert prov == {
        "lock_sha256": lock.lock_digest(),
        "git_head": "abc123",
        "git_source": "git",
        "synthetic": False,
    }
    import numpy
    import pandas
    import pyarrow

    assert versions == {"numpy": numpy.__version__, "pandas": pandas.__version__, "pyarrow": pyarrow.__version__}
    status = [c for c in git_calls["calls"] if c[0] == "status"][0]
    assert status[:3] == ["status", "--porcelain", "--"] and status[3].rstrip("/").endswith("lighter")


def test_a_dirty_tree_refuses_unless_the_fold_is_marked_synthetic(tmp_path, git_calls):
    git_calls["dirty"] = " M scripts/research/py/lighter/fills.py\n"
    with pytest.raises(SystemExit, match="uncommitted changes"):
        run.provenance(tmp_path)
    mark_synthetic(tmp_path)
    prov = run.provenance(tmp_path)
    assert prov["synthetic"] is True and prov["git_head"] == "abc123"
    assert not any(c[0] == "status" for c in git_calls["calls"][2:])  # a synthetic run does not even look at the tree


def test_the_synthetic_marker_alone_does_not_disable_the_guards(tmp_path, git_calls):
    git_calls["dirty"] = " M scripts/research/py/lighter/fills.py\n"
    (tmp_path / "SYNTHETIC").write_text("x")  # the marker alone
    assert data.is_synthetic(tmp_path) is False
    with pytest.raises(SystemExit, match="uncommitted"):
        run.provenance(tmp_path)
    write_markets_json(tmp_path, {1: "BTC"}, source=None)  # markets.json without the generator's source
    assert data.is_synthetic(tmp_path) is False
    write_markets_json(tmp_path, {1: "BTC"}, source="https://mainnet.zklighter.elliot.ai/api/v1/orderBooks")
    assert data.is_synthetic(tmp_path) is False
    mark_synthetic(tmp_path)
    assert data.is_synthetic(tmp_path) is True
    (tmp_path / "manifest.jsonl").write_text(json.dumps({"date": "2025-06-01", "source_url": "https://aws.example/x"}))
    assert data.is_synthetic(tmp_path) is False  # a real download is recorded in the manifest
    with pytest.raises(SystemExit, match="uncommitted"):
        run.provenance(tmp_path)


def test_without_git_a_real_run_refuses_and_a_synthetic_one_goes_on(tmp_path, git_calls):
    git_calls["fail"] = True
    with pytest.raises(SystemExit, match="git"):
        run.provenance(tmp_path)
    mark_synthetic(tmp_path)
    assert run.provenance(tmp_path)["git_head"] is None


def test_every_command_refuses_a_dirty_tree_on_real_data(tmp_path, git_calls):
    git_calls["dirty"] = "?? scripts/research/py/lighter/new.py\n"
    base = {"fold_dir": tmp_path, "binance_dir": tmp_path, "funding_dir": tmp_path, "out_dir": tmp_path / "o"}
    for cmd, extra in (
        (run.cmd_eligibility, {"through": "dev", "finalists": None}),
        (run.cmd_dev, {}),
        (run.cmd_null, {"seed": 1}),
        (run.cmd_report, {}),
        (run.cmd_confirm, {"finalists": None, "dev_dir": tmp_path}),
    ):
        with pytest.raises(SystemExit, match="uncommitted"):
            cmd(argparse.Namespace(**base, **extra))


def test_dev_refuses_real_data_while_the_funding_stamp_is_unverified(tmp_path, git_calls):
    assert lock.FUNDING_STAMP_VERIFIED is False
    args = argparse.Namespace(fold_dir=tmp_path, binance_dir=tmp_path, funding_dir=tmp_path, out_dir=tmp_path / "o")
    with pytest.raises(SystemExit, match="FUNDING_STAMP_VERIFIED"):
        run.cmd_dev(args)


def test_results_must_carry_this_lock_digest_a_valid_hash_and_the_same_synthetic_flag(tmp_path, git_calls):
    prov = {"lock_sha256": lock.lock_digest(), "git_head": "abc", "synthetic": True}
    body = {"kind": "x", **prov, "value": 1}
    path = tmp_path / "r.json"
    run.write_result(path, body)
    doc = json.loads(path.read_text())
    run.check_result_file(doc, "r", prov)  # passes
    with pytest.raises(SystemExit, match="different lock digest"):
        run.check_result_file({**doc, "lock_sha256": "0" * 64}, "r", prov)
    with pytest.raises(SystemExit, match="content hash"):
        run.check_result_file({**doc, "value": 2}, "r", prov)
    with pytest.raises(SystemExit, match="synthetic"):
        run.check_result_file(doc, "r", {**prov, "synthetic": False})
    real = {**body, "synthetic": False}
    run.write_result(path, real)
    with pytest.raises(SystemExit, match="synthetic"):
        run.check_result_file(json.loads(path.read_text()), "r", prov)


# ----------------------------------------------------------------------------------------------------------------
# Classes, unknown ids, scale guard, strict Binance files


def test_markets_json_must_be_covered_exactly_by_the_class_tuples(tmp_path):
    root = tmp_path / "fold"
    root.mkdir()
    everything = [*lock.CRYPTO_SYMBOLS, *lock.TRADFI_SYMBOLS, *lock.UNCLASSIFIED_SYMBOLS]
    write_markets_json(root, dict(enumerate(everything, start=1)))
    markets = DataReader(fold_dir=root, mode="dev").load_markets()
    assert len(markets) == 243
    assert {m.cls for m in markets} == {"crypto", "tradfi", "unclassified"}
    write_markets_json(root, {1: "BTC", 2: "NOTLISTED", 3: "ETH"})
    with pytest.raises(data.DataError, match="NOTLISTED"):
        DataReader(fold_dir=root, mode="dev").load_markets()


def _as_version_3(root, unknown, delisted=()):
    """Rewrite markets.json as markets_file_version 3: listed flags, delisted entries and unknown_market_ids."""
    doc = json.loads((root / "markets.json").read_text())
    doc["markets_file_version"] = 3
    for b in doc["order_books"]:
        b["listed_in_order_books"] = b["market_id"] not in delisted
    doc["unknown_market_ids"] = list(unknown)
    (root / "markets.json").write_text(json.dumps(doc))


def test_a_version_3_markets_file_loads_and_a_delisted_entry_is_a_normal_market(tmp_path):
    root = tmp_path / "fold"
    root.mkdir()
    write_markets_json(root, {1: "BTC", 2: "MKR", 3: "URA", 4: "XAU"})
    _as_version_3(root, unknown=[28, 31], delisted={2, 3})
    r = DataReader(fold_dir=root, mode="dev")
    markets = {m.market_id: m for m in r.load_markets()}
    assert sorted(markets) == [1, 2, 3, 4]  # the unknown ids are not markets
    assert markets[2].cls == "crypto" and markets[2].binance_symbol == "MKRUSDT"
    assert markets[3].cls == "tradfi" and markets[3].binance_symbol == "URAUSDT"
    # version 2 still loads, version 4 does not, and a tuple symbol absent from the file is fine
    write_markets_json(root, {1: "BTC"}, version=2)
    assert [m.market_id for m in DataReader(fold_dir=root, mode="dev").load_markets()] == [1]
    write_markets_json(root, {1: "BTC"}, version=4)
    with pytest.raises(data.DataError, match="version"):
        DataReader(fold_dir=root, mode="dev").load_markets()
    # a perp symbol in no tuple still stops, delisted or not
    write_markets_json(root, {1: "BTC", 2: "NOTLISTED"}, version=3)
    with pytest.raises(data.DataError, match="NOTLISTED"):
        DataReader(fold_dir=root, mode="dev").load_markets()


def test_an_unknown_id_below_the_activity_clause_is_ignored_and_one_meeting_it_stops_with_the_id(tmp_path):
    root = june_root(tmp_path, spec={**JUNE, 99: MM(activity=4999)})
    _as_version_3(root, unknown=[99])
    r = dev_reader(root)
    run.compute_eligibility(r, r.load_markets(), [(2025, 7)])  # listed as unknown, quiet: ignored
    assert 99 in r.fold_market_ids
    (tmp_path / "b").mkdir()
    root2 = june_root(tmp_path / "b", spec={**JUNE, 99: MM(activity=5000)})
    _as_version_3(root2, unknown=[99])
    r2 = dev_reader(root2)
    with pytest.raises(data.DataError, match="market_id 99"):
        run.compute_eligibility(r2, r2.load_markets(), [(2025, 7)])


def test_a_spot_entry_with_heavy_activity_is_known_and_ignored_and_listed(tmp_path):
    # markets.json (write_markets_json) holds a spot entry, id 900 "ETH/USDC", beside the perps 1 to 14
    root = june_root(tmp_path, spec={**JUNE, 900: MM(activity=80_000)})
    _as_version_3(root, unknown=[])
    r = dev_reader(root)
    markets = r.load_markets()
    assert r.non_perp == {900: "ETH/USDC"} and 900 not in {m.market_id for m in markets}
    elig = run.compute_eligibility(r, markets, [(2025, 7)])  # no stop
    assert 900 not in elig[(2025, 7)] and 1 in elig[(2025, 7)]
    doc = run.eligibility_document(elig, markets, r.fold_market_ids, r.non_perp)
    assert doc["non_perp_market_ids"] == [{"market_id": 900, "symbol": "ETH/USDC"}]
    # the command writes it once in its output and does not stop
    args = argparse.Namespace(fold_dir=root, out_dir=tmp_path / "out", through="dev", finalists=None)
    out = run.cmd_eligibility(args, last_date=dt.date(2025, 7, 31), first_date=dt.date(2025, 7, 1))
    written = json.loads(out.read_text())
    assert written["non_perp_market_ids"] == [{"market_id": 900, "symbol": "ETH/USDC"}]
    assert all(row["market_id"] != 900 for row in written["months"]["2025-07"]["eligible"])
    # a spot id absent from the fold is not listed
    (tmp_path / "b").mkdir()
    root2 = june_root(tmp_path / "b", spec=JUNE)
    r2 = dev_reader(root2)
    d2 = run.eligibility_document({}, r2.load_markets(), r2.fold_market_ids, r2.non_perp)
    assert d2["non_perp_market_ids"] == []


def test_only_a_spot_entry_is_out_of_scope_any_other_type_with_activity_stops_with_the_type(tmp_path):
    for kind in ("margin", None):
        # below the clause the id is ignored; at the clause it stops, naming the id and the type
        for act, stops in ((4999, False), (5000, True)):
            (tmp_path / f"{kind}{act}").mkdir()
            r2 = june_root(tmp_path / f"{kind}{act}", spec={**JUNE, 900: MM(activity=act)})
            d2 = json.loads((r2 / "markets.json").read_text())
            s2 = next(b for b in d2["order_books"] if b["market_id"] == 900)
            if kind is None:
                del s2["market_type"]
            else:
                s2["market_type"] = kind
            (r2 / "markets.json").write_text(json.dumps(d2))
            reader = dev_reader(r2)
            markets = reader.load_markets()
            assert reader.non_perp == {} and reader.other_types == {900: str(kind)}
            if stops:
                with pytest.raises(data.DataError, match=rf"market_id 900 has market_type '{kind}'"):
                    run.compute_eligibility(reader, markets, [(2025, 7)])
            else:
                run.compute_eligibility(reader, markets, [(2025, 7)])


def test_a_spot_entry_does_not_hide_an_unknown_id_that_meets_the_clause(tmp_path):
    root = june_root(tmp_path, spec={**JUNE, 900: MM(activity=80_000), 99: MM(activity=5000)})
    _as_version_3(root, unknown=[99])
    r = dev_reader(root)
    with pytest.raises(data.DataError, match="market_id 99") as exc:
        run.compute_eligibility(r, r.load_markets(), [(2025, 7)])
    assert "market_id 900" not in str(exc.value)


def test_a_fold_market_id_missing_from_markets_json_that_meets_the_activity_clause_stops_the_run(tmp_path):
    spec = {**JUNE, 99: MM(activity=5000)}
    root = june_root(tmp_path, spec=spec)
    r = dev_reader(root)
    with pytest.raises(data.DataError, match="market_id 99"):
        run.compute_eligibility(r, r.load_markets(), [(2025, 7)])
    root2 = tmp_path / "b"
    root2.mkdir()
    spec2 = {**JUNE, 99: MM(activity=4999)}
    root2 = june_root(root2, spec=spec2)
    r2 = dev_reader(root2)
    run.compute_eligibility(r2, r2.load_markets(), [(2025, 7)])  # quiet unknown ids are fine
    assert 99 in r2.fold_market_ids and set(range(1, 15)) <= r2.fold_market_ids
    doc = run.eligibility_document({}, r2.load_markets(), r2.fold_market_ids)
    assert 99 in doc["market_ids_in_fold"]


def _md_with_prices(prices, has=None):
    from lighter.synthetic import blank_minute_data

    has = [True] * len(prices) if has is None else has
    md = blank_minute_data(Market("BTC", 1, 2), ft.day_start_ms(dt.date(2025, 7, 1)), len(prices))
    for k, (px, h) in enumerate(zip(prices, has, strict=True)):
        if h:
            md.last_px[k] = md.last_buy_px[k] = md.last_sell_px[k] = px
    return md


def test_price_scale_guard_stops_only_on_a_power_of_ten_jump_whose_new_level_holds():
    rng = np.random.default_rng(1)
    noise = 1 + rng.normal(0, 1e-4, 200)
    held = np.concatenate([100.0 * noise[:50], 1000.0 * noise[50:]])  # x10 at minute 50 and it stays
    md = _md_with_prices(held)
    cands = run.scale_candidates(md)
    assert len(cands) == 1 and cands[0]["holds"] and cands[0]["decades"] == 1
    assert cands[0]["minute"] == md.t0_ms + 50 * lock.MINUTE_MS
    assert cands[0]["ln_ratio"] == pytest.approx(np.log(10), abs=1e-3)
    with pytest.raises(data.DataError, match=r"BTC \(market_id 1\) at minute"):
        run.check_scale(md.market, md)
    # downward (k = -1) holds too
    with pytest.raises(data.DataError):
        run.check_scale(md.market, _md_with_prices(held[::-1].copy()))
    # a crash minute: x10 for 5 minutes and back. A candidate, but it does not hold, so the run goes on
    crash = 100.0 * noise.copy()
    crash[50:55] *= 10
    cands = run.scale_candidates(_md_with_prices(crash))
    assert [c["holds"] for c in cands] == [False, False]  # the jump up and the return to the old level
    run.check_scale(md.market, _md_with_prices(crash))
    # too little history before the jump (or after it) cannot refute the break: it counts as holding and stops the run
    short = _md_with_prices(np.concatenate([100.0 * noise[:20], 1000.0 * noise[20:]]))
    [short_c] = run.scale_candidates(short)
    assert short_c["holds"] and short_c["insufficient_window"] and short_c["printed_minutes_before"] == 20
    with pytest.raises(data.DataError):
        run.check_scale(md.market, short)
    ends_soon = _md_with_prices(np.concatenate([100.0 * noise[:150], 1000.0 * noise[150:170]]))
    [ends_c] = run.scale_candidates(ends_soon)
    assert ends_c["holds"] and ends_c["printed_minutes_after"] == 20
    # a listing minute: one printed minute at 10x, then the real level: too little history, so it holds
    listing = 100.0 * noise.copy()
    listing[0] = 1000.0
    [listing_c] = run.scale_candidates(_md_with_prices(listing))
    assert listing_c["holds"] and listing_c["insufficient_window"]
    with pytest.raises(data.DataError):
        run.check_scale(md.market, _md_with_prices(listing))
    # a break with full windows on both sides is not "insufficient"
    assert cands[0]["insufficient_window"] is False
    # not a power of ten: a 2.5x jump that holds is no scale break (and a 3x one neither)
    for factor in (2.5, 3.0, 0.4):
        plain = np.concatenate([100.0 * noise[:50], 100.0 * factor * noise[50:]])
        assert run.scale_candidates(_md_with_prices(plain)) == []
    # the tolerance: 0.05 in ln around k ln 10
    near = np.concatenate([100.0 * noise[:50], 100.0 * np.exp(np.log(10) + 0.04) * noise[50:]])
    assert len(run.scale_candidates(_md_with_prices(near))) == 1
    far = np.concatenate([100.0 * noise[:50], 100.0 * np.exp(np.log(10) + 0.06) * noise[50:]])
    assert run.scale_candidates(_md_with_prices(far)) == []
    # consecutive PRINTED minutes: unprinted minutes between the two do not hide the jump
    gap_has = [True] * 200
    for k in range(48, 52):
        gap_has[k] = False
    gapped = _md_with_prices(held, gap_has)
    assert len(run.scale_candidates(gapped)) == 1
    minute = md.t0_ms + 52 * lock.MINUTE_MS  # the first printed minute at the new level
    assert run.scale_candidates(gapped)[0]["minute"] == minute


def cands_minute(md):
    return md.t0_ms + 50 * lock.MINUTE_MS


def _write_binance(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["open_time,open,high,low,close,volume,quote_volume,trades,taker_buy_base,taker_buy_quote"]
    for t in rows:
        lines.append(f"{t},1,1,1,1,1,1,1,1,1")
    with gzip.open(path, "wt") as f:
        f.write("\n".join(lines) + "\n")


def test_binance_files_fail_on_rows_outside_the_month_and_on_duplicate_open_times(tmp_path):
    t0 = ft.day_start_ms(dt.date(2025, 7, 1))
    reader = DataReader(fold_dir=tmp_path, binance_dir=tmp_path / "b", mode="dev", last_date=dt.date(2025, 7, 31))
    path = tmp_path / "b" / "BTCUSDT" / "BTCUSDT-1m-2025-07.csv.gz"
    _write_binance(path, [t0, t0 + 60_000, t0 + 120_000])
    out = reader._load_binance("BTCUSDT", {(2025, 7)}, t0, 1440)
    assert out["b_has"][:3].all() and not out["b_has"][3]
    _write_binance(path, [t0, t0 + 60_000, t0 + 60_000])
    with pytest.raises(data.DataError, match="duplicate"):
        reader._load_binance("BTCUSDT", {(2025, 7)}, t0, 1440)
    _write_binance(path, [t0, t0 - 60_000])  # a June minute in the July file
    with pytest.raises(data.DataError, match="outside its month"):
        reader._load_binance("BTCUSDT", {(2025, 7)}, t0, 1440)
    _write_binance(path, [t0, ft.day_start_ms(dt.date(2025, 8, 1))])  # an August minute
    with pytest.raises(data.DataError, match="outside its month"):
        reader._load_binance("BTCUSDT", {(2025, 7)}, t0, 1440)
