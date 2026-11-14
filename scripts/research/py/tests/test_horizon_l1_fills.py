"""Unit tests for horizon-l1 fills.py (order fills, fallback and trade simulation)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from horizon.l1 import data as data_mod
from horizon.l1 import lock
from horizon.l1.data import MarketData
from horizon.l1.fills import order_fill, simulate_trade


@pytest.fixture(autouse=True)
def patch_grid_span(monkeypatch: pytest.MonkeyPatch) -> None:
    """Use small test grid span for dense arrays."""
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 20_000)


def make_test_md(n_min: int = 1_000, market_id: int = 1, symbol: str = "BTC") -> MarketData:
    """Construct an empty MarketData object for testing."""
    present = np.zeros(n_min, dtype=bool)
    buy_usd = np.zeros(n_min, dtype=np.float64)
    sell_usd = np.zeros(n_min, dtype=np.float64)
    last_px = np.full(n_min, np.nan, dtype=np.float64)
    last_buy_px = np.full(n_min, np.nan, dtype=np.float64)
    last_buy_ts = np.full(n_min, np.nan, dtype=np.float64)
    last_sell_px = np.full(n_min, np.nan, dtype=np.float64)
    last_sell_ts = np.full(n_min, np.nan, dtype=np.float64)
    first_buy_px = np.full(n_min, np.nan, dtype=np.float64)
    first_buy_ts = np.full(n_min, np.nan, dtype=np.float64)
    first_sell_px = np.full(n_min, np.nan, dtype=np.float64)
    first_sell_ts = np.full(n_min, np.nan, dtype=np.float64)
    liq_sell_usd = np.zeros(n_min, dtype=np.float64)
    liq_buy_usd = np.zeros(n_min, dtype=np.float64)
    n_liq_sell = np.zeros(n_min, dtype=np.int32)
    n_liq_buy = np.zeros(n_min, dtype=np.int32)
    return MarketData(
        market_id=market_id,
        symbol=symbol,
        market_type="perp",
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


def test_own_side_first_print() -> None:
    """Buy order fills at own-side print price with sp=0.0 when own-side print is earlier."""
    md = make_test_md()
    m = 10
    xs = np.zeros(1000, dtype=np.float64)

    # Buy order (+1)
    md.first_buy_px[m] = 100.0
    md.first_buy_ts[m] = md.ms_of(m) + 600.0  # earlier
    md.first_sell_px[m] = 101.0
    md.first_sell_ts[m] = md.ms_of(m) + 800.0  # later

    fill = order_fill(md, xs, spm=20.0, order_side=1, boundary_index=m, search_min=0, is_exit=False)
    assert fill.found
    assert fill.index == m
    assert fill.px == pytest.approx(100.0)
    assert fill.ts == int(md.ms_of(m) + 600)
    assert fill.sp == 0.0
    assert not fill.tie
    assert not fill.fallback

    # Sell order (-1) with earlier sell print
    md2 = make_test_md()
    md2.first_sell_px[m] = 100.0
    md2.first_sell_ts[m] = md2.ms_of(m) + 600.0  # earlier
    md2.first_buy_px[m] = 99.0
    md2.first_buy_ts[m] = md2.ms_of(m) + 800.0  # later

    fill_sell = order_fill(md2, xs, spm=20.0, order_side=-1, boundary_index=m, search_min=0, is_exit=False)
    assert fill_sell.found
    assert fill_sell.index == m
    assert fill_sell.px == pytest.approx(100.0)
    assert fill_sell.ts == int(md2.ms_of(m) + 600)
    assert fill_sell.sp == 0.0
    assert not fill_sell.tie
    assert not fill_sell.fallback


def test_other_side_first_print() -> None:
    """Buy order fills at sell_px * (1 + SP/10000) with SP = max(spm, xs[m], xs[m-1])."""
    md = make_test_md()
    m = 10
    # Earlier print is sell print (600 ms vs 800 ms)
    md.first_sell_px[m] = 100.0
    md.first_sell_ts[m] = md.ms_of(m) + 600.0
    md.first_buy_px[m] = 105.0
    md.first_buy_ts[m] = md.ms_of(m) + 800.0

    xs = np.zeros(1000, dtype=np.float64)

    # Case a: spm largest (spm=30, xs[m]=10, xs[m-1]=20) -> SP=30
    xs[m] = 10.0
    xs[m - 1] = 20.0
    fill_a = order_fill(md, xs, spm=30.0, order_side=1, boundary_index=m, search_min=0, is_exit=False)
    assert fill_a.found
    assert fill_a.sp == 30.0
    # 100 * (1 + 30 / 10000) = 100.3
    assert fill_a.px == pytest.approx(100.3)
    assert fill_a.ts == int(md.ms_of(m) + 600)
    assert not fill_a.tie

    # Case b: x(m) largest (spm=10, xs[m]=40, xs[m-1]=20) -> SP=40
    xs[m] = 40.0
    xs[m - 1] = 20.0
    fill_b = order_fill(md, xs, spm=10.0, order_side=1, boundary_index=m, search_min=0, is_exit=False)
    assert fill_b.found
    assert fill_b.sp == 40.0
    # 100 * (1 + 40 / 10000) = 100.4
    assert fill_b.px == pytest.approx(100.4)

    # Case c: x(m-1) largest (spm=10, xs[m]=20, xs[m-1]=50) -> SP=50
    xs[m] = 20.0
    xs[m - 1] = 50.0
    fill_c = order_fill(md, xs, spm=10.0, order_side=1, boundary_index=m, search_min=0, is_exit=False)
    assert fill_c.found
    assert fill_c.sp == 50.0
    # 100 * (1 + 50 / 10000) = 100.5
    assert fill_c.px == pytest.approx(100.5)


def test_tie() -> None:
    """Timestamp tie: worse price for the order is used, and tie is true."""
    md = make_test_md()
    m = 10
    xs = np.zeros(1000, dtype=np.float64)
    spm = 30.0  # 30 bps

    # 1. Buy order (+1): adjusted sell is worse (higher)
    # own buy = 100.0; sell = 99.8 -> adj = 99.8 * 1.0030 = 100.0994 > 100.0
    md.first_buy_px[m] = 100.0
    md.first_buy_ts[m] = md.ms_of(m) + 600.0
    md.first_sell_px[m] = 99.8
    md.first_sell_ts[m] = md.ms_of(m) + 600.0

    fill_buy = order_fill(md, xs, spm=spm, order_side=1, boundary_index=m, search_min=0, is_exit=False)
    assert fill_buy.found
    assert fill_buy.tie
    assert fill_buy.px == pytest.approx(100.0994)
    assert fill_buy.sp == 30.0

    # Buy order (+1): own buy is worse (higher)
    md.first_buy_px[m] = 101.0
    fill_buy2 = order_fill(md, xs, spm=spm, order_side=1, boundary_index=m, search_min=0, is_exit=False)
    assert fill_buy2.found
    assert fill_buy2.tie
    assert fill_buy2.px == pytest.approx(101.0)
    assert fill_buy2.sp == 0.0

    # 2. Sell order (-1): adjusted buy is worse (lower)
    # own sell = 100.0; buy = 100.2 -> adj = 100.2 * 0.9970 = 99.8994 < 100.0
    md2 = make_test_md()
    md2.first_sell_px[m] = 100.0
    md2.first_sell_ts[m] = md2.ms_of(m) + 600.0
    md2.first_buy_px[m] = 100.2
    md2.first_buy_ts[m] = md2.ms_of(m) + 600.0

    fill_sell = order_fill(md2, xs, spm=spm, order_side=-1, boundary_index=m, search_min=0, is_exit=False)
    assert fill_sell.found
    assert fill_sell.tie
    assert fill_sell.px == pytest.approx(99.8994)
    assert fill_sell.sp == 30.0


def test_entry_no_print() -> None:
    """Entry searches boundary minute only; if no print, order is not found."""
    md = make_test_md()
    m = 10
    xs = np.zeros(1000, dtype=np.float64)

    # Next minute (m+1) has prints, but minute m does not
    md.first_buy_px[m + 1] = 100.0
    md.first_buy_ts[m + 1] = md.ms_of(m + 1) + 600.0

    fill = order_fill(md, xs, spm=20.0, order_side=1, boundary_index=m, search_min=0, is_exit=False)
    assert not fill.found
    assert fill.index == -1
    assert math.isnan(fill.px)
    assert fill.ts == -1


def test_exit_search_window() -> None:
    """Exit searches boundary_index .. boundary_index + 15 (found at +15, not at +16)."""
    md = make_test_md()
    b = 10
    xs = np.zeros(1000, dtype=np.float64)

    # Print in minute b + 15 (minute 25)
    md.first_buy_px[b + 15] = 100.0
    md.first_buy_ts[b + 15] = md.ms_of(b + 15) + 600.0

    fill = order_fill(md, xs, spm=20.0, order_side=1, boundary_index=b, search_min=lock.EXIT_SEARCH_MIN, is_exit=True)
    assert fill.found
    assert fill.index == b + 15
    assert not fill.fallback

    # Print only in minute b + 16 (minute 26); no last_px for fallback
    md2 = make_test_md()
    md2.first_buy_px[b + 16] = 100.0
    md2.first_buy_ts[b + 16] = md2.ms_of(b + 16) + 600.0

    fill2 = order_fill(md2, xs, spm=20.0, order_side=1, boundary_index=b, search_min=lock.EXIT_SEARCH_MIN, is_exit=True)
    assert not fill2.found
    assert fill2.index == -1


def test_fallback_exit() -> None:
    """When exit finds no print in 16 min, fallback uses last_px moved by spm/2 bps."""
    md = make_test_md()
    b = 10
    xs = np.zeros(1000, dtype=np.float64)
    spm = 20.0  # spm / 2 = 10 bps

    # No first prints, but last_px at minute 20
    md.last_px[20] = 200.0

    # Sell exit order (-1): moved against order: 200 * (1 - 10 / 10000) = 199.8
    fill_sell = order_fill(
        md, xs, spm=spm, order_side=-1, boundary_index=b, search_min=lock.EXIT_SEARCH_MIN, is_exit=True, min_index=5
    )
    assert fill_sell.found
    assert fill_sell.index == 20
    assert fill_sell.px == pytest.approx(199.8)
    assert fill_sell.ts == md.ms_of(20) + 60_000
    assert fill_sell.sp == pytest.approx(10.0)
    assert fill_sell.fallback
    assert not fill_sell.tie

    # Buy exit order (+1): moved against order: 200 * (1 + 10 / 10000) = 200.2
    fill_buy = order_fill(
        md, xs, spm=spm, order_side=1, boundary_index=b, search_min=lock.EXIT_SEARCH_MIN, is_exit=True, min_index=5
    )
    assert fill_buy.found
    assert fill_buy.index == 20
    assert fill_buy.px == pytest.approx(200.2)
    assert fill_buy.ts == md.ms_of(20) + 60_000
    assert fill_buy.fallback


def test_simulate_trade() -> None:
    """Trade simulation: golden long/short, funding signs and edges, gaps, adverse, latencies."""
    md = make_test_md()
    entry_m = 10
    exit_m = 40
    xs = np.zeros(1000, dtype=np.float64)
    spm = 0.0

    # Set entry print (minute 10)
    md.first_buy_px[entry_m] = 100.0
    md.first_buy_ts[entry_m] = md.ms_of(entry_m) + 600.0  # latency 600 ms
    md.first_sell_px[entry_m] = 100.0
    md.first_sell_ts[entry_m] = md.ms_of(entry_m) + 600.0

    # Set exit print (minute 40)
    md.first_buy_px[exit_m] = 101.0
    md.first_buy_ts[exit_m] = md.ms_of(exit_m) + 700.0  # latency 700 ms
    md.first_sell_px[exit_m] = 101.0
    md.first_sell_ts[exit_m] = md.ms_of(exit_m) + 700.0

    # Intermediate last_px for adverse excursion
    md.last_px[10] = 100.0
    md.last_px[20] = 95.0  # 5% adverse for long
    md.last_px[30] = 105.0  # 5% adverse for short
    md.last_px[40] = 101.0

    # Funding stamp inside hold
    entry_ts_s = (md.ms_of(entry_m) + 600) // 1000
    exit_ts_s = (md.ms_of(exit_m) + 700) // 1000
    settle_s = (entry_ts_s + exit_ts_s) // 2

    funding_ts = np.array([settle_s], dtype=np.int64)
    funding_rate = np.array([0.0005], dtype=np.float64)

    # 1. Golden long (side "S"): raw return = 101 / 100 - 1 = +0.01
    trade_long = simulate_trade(
        md=md,
        xs=xs,
        spm=spm,
        funding_ts=funding_ts,
        funding_rate=funding_rate,
        side="S",
        entry_index=entry_m,
        exit_index=exit_m,
    )
    assert trade_long.status == "ok"
    assert trade_long.raw_return == pytest.approx(0.01)
    # Long pays funding: funding = -0.0005
    assert trade_long.funding == pytest.approx(-0.0005)
    assert trade_long.ret == pytest.approx(0.01 - 0.0005)
    assert trade_long.adverse == pytest.approx(0.05)  # 1 - 95/100 = 0.05
    assert trade_long.latency_entry_ms == 600
    assert trade_long.latency_exit_ms == 700

    # 2. Golden short (side "B"): raw return = 1 - exit / entry
    # Test with 100 to 99: raw return = 1 - 99 / 100 = +0.01
    md.first_buy_px[exit_m] = 99.0
    md.first_sell_px[exit_m] = 99.0
    trade_short = simulate_trade(
        md=md,
        xs=xs,
        spm=spm,
        funding_ts=funding_ts,
        funding_rate=funding_rate,
        side="B",
        entry_index=entry_m,
        exit_index=exit_m,
    )
    assert trade_short.status == "ok"
    assert trade_short.raw_return == pytest.approx(0.01)
    # Short receives funding: funding = +0.0005
    assert trade_short.funding == pytest.approx(0.0005)
    assert trade_short.ret == pytest.approx(0.01 + 0.0005)
    assert trade_short.adverse == pytest.approx(0.05)  # 105/100 - 1 = 0.05

    # Short formula check: 100 to 110 must give -0.10, NOT (100/110 - 1 = -0.0909)
    md.first_buy_px[exit_m] = 110.0
    md.first_sell_px[exit_m] = 110.0
    trade_short_loss = simulate_trade(
        md=md,
        xs=xs,
        spm=spm,
        funding_ts=funding_ts,
        funding_rate=funding_rate,
        side="B",
        entry_index=entry_m,
        exit_index=exit_m,
    )
    assert trade_short_loss.raw_return == pytest.approx(-0.10)

    # 3. Strict on left, inclusive on right funding edges
    # Stamp at exact entry time: excluded
    # Stamp at exact exit time: included
    f_ts = np.array([1000, 2000], dtype=np.int64)
    # Entry at 1000.0 s, Exit at 2000.0 s:
    md_e = make_test_md()
    md_e.first_buy_px[10] = 100.0
    md_e.first_buy_ts[10] = 1_000_000.0  # 1000.0 s
    md_e.first_sell_px[10] = 100.0
    md_e.first_sell_ts[10] = 1_000_000.0

    md_e.first_buy_px[20] = 100.0
    md_e.first_buy_ts[20] = 2_000_000.0  # 2000.0 s
    md_e.first_sell_px[20] = 100.0
    md_e.first_sell_ts[20] = 2_000_000.0

    f_rates = np.array([0.001, 0.002], dtype=np.float64)
    trade_edge_test = simulate_trade(
        md=md_e,
        xs=xs,
        spm=spm,
        funding_ts=f_ts,
        funding_rate=f_rates,
        side="S",
        entry_index=10,
        exit_index=20,
    )
    # 1000.0 is NOT > 1000.0 (excluded), 2000.0 IS <= 2000.0 (included)
    # So rate sum is 0.002, funding is -0.002
    assert trade_edge_test.funding == pytest.approx(-0.002)

    # 4. funding_gap
    # Window spans from 3000 s to 7500 s: contains hour boundaries 3600 and 7200 (expected 2)
    md_gap = make_test_md()
    md_gap.first_buy_px[50] = 100.0
    md_gap.first_buy_ts[50] = 3_000_600.0
    md_gap.first_sell_px[50] = 100.0
    md_gap.first_sell_ts[50] = 3_000_600.0
    md_gap.first_buy_px[125] = 100.0
    md_gap.first_buy_ts[125] = 7_500_600.0
    md_gap.first_sell_px[125] = 100.0
    md_gap.first_sell_ts[125] = 7_500_600.0

    # Empty series when hour boundary is inside -> funding_gap True
    trade_gap_empty = simulate_trade(
        md=md_gap,
        xs=xs,
        spm=spm,
        funding_ts=np.array([], dtype=np.int64),
        funding_rate=np.array([], dtype=np.float64),
        side="S",
        entry_index=50,
        exit_index=125,
    )
    assert trade_gap_empty.funding_gap

    # 1 stamp when 2 expected -> funding_gap True
    trade_gap_1 = simulate_trade(
        md=md_gap,
        xs=xs,
        spm=spm,
        funding_ts=np.array([3600], dtype=np.int64),
        funding_rate=np.array([0.0001], dtype=np.float64),
        side="S",
        entry_index=50,
        exit_index=125,
    )
    assert trade_gap_1.funding_gap

    # 2 stamps when 2 expected -> funding_gap False
    trade_gap_ok = simulate_trade(
        md=md_gap,
        xs=xs,
        spm=spm,
        funding_ts=np.array([3600, 7200], dtype=np.int64),
        funding_rate=np.array([0.0001, 0.0001], dtype=np.float64),
        side="S",
        entry_index=50,
        exit_index=125,
    )
    assert not trade_gap_ok.funding_gap


def test_no_entry_fill_status() -> None:
    """simulate_trade returns status='no_entry_fill' with NaN returns when entry order fails."""
    md = make_test_md()
    xs = np.zeros(1000, dtype=np.float64)

    # No prints at entry minute
    trade = simulate_trade(
        md=md,
        xs=xs,
        spm=20.0,
        funding_ts=np.array([], dtype=np.int64),
        funding_rate=np.array([], dtype=np.float64),
        side="S",
        entry_index=10,
        exit_index=40,
    )
    assert trade.status == "no_entry_fill"
    assert not trade.entry.found
    assert not trade.exit.found
    assert math.isnan(trade.raw_return)
    assert math.isnan(trade.funding)
    assert math.isnan(trade.ret)
    assert math.isnan(trade.adverse)
    assert trade.latency_entry_ms == -1
    assert trade.latency_exit_ms == -1

    # Test status "no_exit" when exit fails completely
    md.first_buy_px[10] = 100.0
    md.first_buy_ts[10] = md.ms_of(10) + 600.0
    md.first_sell_px[10] = 100.0
    md.first_sell_ts[10] = md.ms_of(10) + 600.0
    # No exit prints and no last_px in range
    trade_no_exit = simulate_trade(
        md=md,
        xs=xs,
        spm=20.0,
        funding_ts=np.array([], dtype=np.int64),
        funding_rate=np.array([], dtype=np.float64),
        side="S",
        entry_index=10,
        exit_index=40,
    )
    assert trade_no_exit.status == "no_exit"
    assert trade_no_exit.entry.found
    assert not trade_no_exit.exit.found
    assert math.isnan(trade_no_exit.raw_return)
    assert trade_no_exit.latency_entry_ms == 600
    assert trade_no_exit.latency_exit_ms == -1
