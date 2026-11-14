"""Unit tests for horizon-l1 events.py (bursts, retrigger, spread proxy and eligibility)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from horizon.l1 import data as data_mod
from horizon.l1 import lock
from horizon.l1.data import MarketData
from horizon.l1.events import Burst, eligible, find_candidates, select_events, spread_median, x_series


@pytest.fixture(autouse=True)
def patch_grid_span(monkeypatch: pytest.MonkeyPatch) -> None:
    """Use small test grid span for dense arrays."""
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 20_000)


def make_test_md(n_min: int = 15_000, market_id: int = 1, symbol: str = "BTC") -> MarketData:
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


def test_burst_properties() -> None:
    """Verify Burst properties e_index, d_index, duration_min."""
    b = Burst(market_id=1, side="S", i0=100, i1=105, usd=120_000.0, rows=4)
    assert b.e_index == 106
    assert b.d_index == 106 + lock.ENTRY_OFFSET_MIN
    assert b.duration_min == 6


def test_bursts_merge_and_split() -> None:
    """Bursts merge at gap 5, split at gap 6, check USD and row sums, and threshold edges."""
    # 1. Merge at gap 5 (indexes 100 and 105)
    md_merge = make_test_md()
    md_merge.liq_sell_usd[100] = 60_000.0
    md_merge.n_liq_sell[100] = 2
    md_merge.liq_sell_usd[105] = 60_000.0
    md_merge.n_liq_sell[105] = 2

    cands_merge = find_candidates(md_merge, "S")
    assert len(cands_merge) == 1
    burst = cands_merge[0]
    assert burst.i0 == 100
    assert burst.i1 == 105
    assert burst.usd == pytest.approx(120_000.0)
    assert burst.rows == 4
    assert burst.e_index == 106
    assert burst.d_index == 111
    assert burst.duration_min == 6

    # 2. Split at gap 6 (indexes 100 and 106)
    md_split = make_test_md()
    md_split.liq_sell_usd[100] = 100_000.0
    md_split.n_liq_sell[100] = 3
    md_split.liq_sell_usd[106] = 100_000.0
    md_split.n_liq_sell[106] = 3

    cands_split = find_candidates(md_split, "S")
    assert len(cands_split) == 2
    assert cands_split[0].i0 == 100
    assert cands_split[0].i1 == 100
    assert cands_split[1].i0 == 106
    assert cands_split[1].i1 == 106

    # 3. Threshold edges
    # Exactly 100,000 USD and 3 rows is a candidate
    md_edge1 = make_test_md()
    md_edge1.liq_sell_usd[50] = 100_000.0
    md_edge1.n_liq_sell[50] = 3
    assert len(find_candidates(md_edge1, "S")) == 1

    # 99,999.99 USD and 3 rows is NOT a candidate
    md_edge2 = make_test_md()
    md_edge2.liq_sell_usd[50] = 99_999.99
    md_edge2.n_liq_sell[50] = 3
    assert len(find_candidates(md_edge2, "S")) == 0

    # 100,000.0 USD and 2 rows is NOT a candidate
    md_edge3 = make_test_md()
    md_edge3.liq_sell_usd[50] = 100_000.0
    md_edge3.n_liq_sell[50] = 2
    assert len(find_candidates(md_edge3, "S")) == 0


def test_select_events_retrigger() -> None:
    """Event retrigger: blocking at 124 min, kept at 125 min, chaining, and early events."""
    # 1. Event at E=200 blocks candidate at i0=324, keeps candidate at i0=325
    cand_a = Burst(market_id=1, side="S", i0=195, i1=199, usd=100_000.0, rows=3)  # E=200
    cand_blocked = Burst(market_id=1, side="S", i0=324, i1=324, usd=100_000.0, rows=3)
    cand_kept = Burst(market_id=1, side="S", i0=325, i1=325, usd=100_000.0, rows=3)

    events1 = select_events([cand_a, cand_blocked])
    assert events1 == [cand_a]

    events2 = select_events([cand_a, cand_kept])
    assert events2 == [cand_a, cand_kept]

    # 2. Blocked-then-eligible chain:
    # A kept, B blocked by A, C not blocked by A but would have been blocked by B -> keeps A and C only
    burst_a = Burst(market_id=1, side="S", i0=100, i1=100, usd=100_000.0, rows=3)  # e_index = 101
    burst_b = Burst(market_id=1, side="S", i0=150, i1=150, usd=100_000.0, rows=3)  # 150 - 101 = 49 < 125 (blocked)
    burst_c = Burst(market_id=1, side="S", i0=230, i1=230, usd=100_000.0, rows=3)  # 230 - 101 = 129 >= 125 (kept)

    chain_events = select_events([burst_a, burst_b, burst_c])
    assert chain_events == [burst_a, burst_c]

    # 3. Events before EVENTS_FROM_MS still block subsequent candidates
    early_burst = Burst(market_id=1, side="S", i0=10, i1=10, usd=100_000.0, rows=3)  # e_index = 11
    later_burst = Burst(market_id=1, side="S", i0=50, i1=50, usd=100_000.0, rows=3)  # 50 - 11 = 39 < 125
    early_events = select_events([early_burst, later_burst])
    assert early_events == [early_burst]


def test_x_series() -> None:
    """x_series calculation, 2s gap filter, and negative spread clipping."""
    md = make_test_md(n_min=20)

    # Minute 5: buy 10,010 sell 9,990 within 1s -> 20.0 bps
    md.last_buy_px[5] = 10_010.0
    md.last_buy_ts[5] = 100_000.0
    md.last_sell_px[5] = 9_990.0
    md.last_sell_ts[5] = 101_000.0  # gap 1000 ms <= 2000 ms

    # Minute 6: buy 10,010 sell 9,990 with 3s gap -> 0.0, valid False
    md.last_buy_px[6] = 10_010.0
    md.last_buy_ts[6] = 100_000.0
    md.last_sell_px[6] = 9_990.0
    md.last_sell_ts[6] = 103_001.0  # gap 3001 ms > 2000 ms

    # Minute 7: negative spread (buy 9,990, sell 10,010) within 1s -> 0.0, valid True
    md.last_buy_px[7] = 9_990.0
    md.last_buy_ts[7] = 100_000.0
    md.last_sell_px[7] = 10_010.0
    md.last_sell_ts[7] = 101_000.0

    xs, xs_valid = x_series(md)

    assert xs_valid[5]
    assert xs[5] == pytest.approx(20.0)

    assert not xs_valid[6]
    assert xs[6] == 0.0

    assert xs_valid[7]
    assert xs[7] == 0.0


def test_spread_median() -> None:
    """Median of qualifying values, NaN when below SP_MIN_PAIRS, and window edge indices."""
    md = make_test_md(n_min=15_000)
    i_d = 12_000
    start = i_d - lock.SP_WINDOW_DAYS * lock.ACTIVITY_WINDOW_MIN  # 12000 - 10080 = 1920

    xs = np.zeros(15_000, dtype=np.float64)
    xs_valid = np.zeros(15_000, dtype=bool)

    # 1. Fewer than SP_MIN_PAIRS (199 pairs) gives NaN
    xs_valid[2000:2199] = True
    xs[2000:2199] = 15.0
    assert math.isnan(spread_median(md, xs_valid, xs, i_d))

    # 2. Exactly SP_MIN_PAIRS (200 pairs) gives median
    xs_valid[2199] = True
    xs[2199] = 15.0
    assert spread_median(md, xs_valid, xs, i_d) == pytest.approx(15.0)

    # 3. Window edge indices: start (1920) is included, i_d (12000) is excluded
    xs_valid_edge = np.zeros(15_000, dtype=bool)
    xs_edge = np.zeros(15_000, dtype=np.float64)
    # Put 199 values of 10.0 in interior
    xs_valid_edge[2000:2199] = True
    xs_edge[2000:2199] = 10.0

    # Put 200th value at index start = 1920: should make count 200 and be included
    xs_valid_edge[start] = True
    xs_edge[start] = 10.0
    assert spread_median(md, xs_valid_edge, xs_edge, i_d) == pytest.approx(10.0)

    # Put a value at index i_d = 12000: should NOT be included in window [start, i_d)
    xs_valid_edge[start] = False  # drop count back to 199 inside window
    xs_valid_edge[i_d] = True
    xs_edge[i_d] = 10.0
    assert math.isnan(spread_median(md, xs_valid_edge, xs_edge, i_d))


def test_eligible() -> None:
    """Eligibility check: activity threshold (360 active min) and spread proxy availability."""
    md = make_test_md(n_min=15_000)
    i_d = 2_000
    start = i_d - lock.ACTIVITY_WINDOW_MIN  # 2000 - 1440 = 560

    xs = np.zeros(15_000, dtype=np.float64)
    xs_valid = np.zeros(15_000, dtype=bool)
    # Set 200 qualifying pairs for spread median
    xs_valid[600:800] = True
    xs[600:800] = 10.0

    # 1. Exactly 360 active minutes passes
    md.buy_usd[start : start + 360] = 100.0
    is_ok, reason = eligible(md, xs_valid, xs, i_d)
    assert is_ok
    assert reason == "ok"

    # 2. 359 active minutes fails with "activity"
    md.buy_usd[start : start + 360] = 0.0
    md.buy_usd[start : start + 359] = 100.0
    is_ok2, reason2 = eligible(md, xs_valid, xs, i_d)
    assert not is_ok2
    assert reason2 == "activity"

    # 3. i_d - 1440 < 0 fails with "activity"
    is_ok3, reason3 = eligible(md, xs_valid, xs, 1000)
    assert not is_ok3
    assert reason3 == "activity"

    # 4. Enough activity (360 min) but no spread proxy (NaN) fails with "no_spread_proxy"
    xs_valid[:] = False  # no qualifying pairs
    md.buy_usd[start : start + 360] = 100.0
    is_ok4, reason4 = eligible(md, xs_valid, xs, i_d)
    assert not is_ok4
    assert reason4 == "no_spread_proxy"


def test_sides_columns() -> None:
    """find_candidates reads liq_sell_usd for side S and liq_buy_usd for side B."""
    md = make_test_md(n_min=100)

    # Minute 20: forced sell (side S)
    md.liq_sell_usd[20] = 150_000.0
    md.n_liq_sell[20] = 5

    # Minute 40: forced buy (side B)
    md.liq_buy_usd[40] = 200_000.0
    md.n_liq_buy[40] = 6

    cands_s = find_candidates(md, "S")
    assert len(cands_s) == 1
    assert cands_s[0].side == "S"
    assert cands_s[0].i0 == 20
    assert cands_s[0].usd == pytest.approx(150_000.0)
    assert cands_s[0].rows == 5

    cands_b = find_candidates(md, "B")
    assert len(cands_b) == 1
    assert cands_b[0].side == "B"
    assert cands_b[0].i0 == 40
    assert cands_b[0].usd == pytest.approx(200_000.0)
    assert cands_b[0].rows == 6
