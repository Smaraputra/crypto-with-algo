"""Unit tests for horizon-l1 controls.py (r_pre, liquidation prefix sums, matched controls)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from horizon.l1 import data as data_mod
from horizon.l1 import lock
from horizon.l1.controls import find_controls, liq_any_prefix, r_pre_series
from horizon.l1.data import MarketData
from horizon.l1.events import x_series


@pytest.fixture(autouse=True)
def patch_grid_span(monkeypatch: pytest.MonkeyPatch) -> None:
    """Use small test grid span for dense arrays."""
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 5_000)


def make_test_md(n_min: int = 3_000, market_id: int = 1, symbol: str = "BTC") -> MarketData:
    """Construct a MarketData object for testing."""
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


def populate_active_and_fills(md: MarketData, start_m: int, end_m: int, price: float = 100.0) -> None:
    """Populate active minutes, price prints and qualifying pairs."""
    for m in range(start_m, end_m):
        md.present[m] = True
        md.buy_usd[m] = 500.0
        md.sell_usd[m] = 500.0
        md.last_px[m] = price
        ts = md.ms_of(m) + 600.0
        md.last_buy_px[m] = price
        md.last_buy_ts[m] = ts
        md.last_sell_px[m] = price
        md.last_sell_ts[m] = ts
        md.first_buy_px[m] = price
        md.first_buy_ts[m] = ts
        md.first_sell_px[m] = price
        md.first_sell_ts[m] = ts


def test_r_pre_series_values_and_carry_back() -> None:
    """r_pre_series computes 60m return, forward-filling up to 5 minutes but not 6."""
    md = make_test_md(n_min=200)

    # Base price at minute 10
    md.last_px[10] = 100.0
    # Minutes 11 to 15 are NaN (gap of 5 minutes from minute 10)
    # Minute 16 is NaN (gap of 6 minutes)
    # Prices at minute 70, 75, 76
    md.last_px[70] = 110.0
    md.last_px[75] = 115.0
    md.last_px[76] = 120.0

    r_pre = r_pre_series(md)

    # Minute X = 71: uses minute 70 (110.0) and minute 70 - 60 = 10 (100.0)
    # 110.0 / 100.0 - 1.0 = 0.10
    assert r_pre[71] == pytest.approx(0.10)

    # Minute X = 76: uses minute 75 (115.0) and minute 75 - 60 = 15
    # Minute 15 is NaN, but age is 15 - 10 = 5 <= 5, so forward-filled from minute 10 (100.0)
    # 115.0 / 100.0 - 1.0 = 0.15
    assert r_pre[76] == pytest.approx(0.15)

    # Minute X = 77: uses minute 76 (120.0) and minute 76 - 60 = 16
    # Minute 16 is NaN, age is 16 - 10 = 6 > 5 (gap of 6 minutes, not carried)
    # r_pre[77] must be NaN
    assert math.isnan(r_pre[77])

    # Minutes before index 61 cannot have a 60m lookback
    assert math.isnan(r_pre[50])

    # Empty array handling
    md_empty = make_test_md(n_min=0)
    assert len(r_pre_series(md_empty)) == 0


def test_liq_any_prefix_counts() -> None:
    """liq_any_prefix computes prefix sums of minutes with any liquidation."""
    md = make_test_md(n_min=100)
    md.liq_sell_usd[10] = 1000.0
    md.liq_buy_usd[20] = 2000.0
    md.liq_sell_usd[30] = 500.0
    md.liq_buy_usd[30] = 500.0  # Both sides in same minute

    p = liq_any_prefix(md)
    assert len(p) == 101
    assert p[0] == 0
    assert p[10] == 0
    assert p[11] == 1
    assert p[20] == 1
    assert p[21] == 2
    assert p[30] == 2
    assert p[31] == 3
    assert p[100] == 3

    # Query intervals [start, end)
    # [10, 11) has liquidation at minute 10
    assert p[11] - p[10] == 1
    # [11, 20) has no liquidations
    assert p[20] - p[11] == 0
    # [0, 100) has 3 distinct liquidation minutes
    assert p[100] - p[0] == 3


def test_find_controls_r_pre_non_finite() -> None:
    """find_controls returns [] when r_pre[event_d_index] is not finite."""
    md = make_test_md(n_min=1_000)
    xs, xs_valid = x_series(md)
    liq_prefix = liq_any_prefix(md)
    r_pre = np.full(1_000, np.nan, dtype=np.float64)

    ctrls = find_controls(
        md=md,
        xs=xs,
        xs_valid=xs_valid,
        event_d_index=500,
        event_i0=495,
        liq_any_prefix=liq_prefix,
        r_pre=r_pre,
    )
    assert ctrls == []


def test_find_controls_hold_before_burst(monkeypatch: pytest.MonkeyPatch) -> None:
    """find_controls enforces X + lock.CONTROL_HOLD_MIN <= event_i0."""
    monkeypatch.setattr(lock, "ACTIVITY_WINDOW_MIN", 50)
    monkeypatch.setattr(lock, "ACTIVITY_MIN_ACTIVE_MIN", 10)
    monkeypatch.setattr(lock, "SP_WINDOW_DAYS", 1)
    monkeypatch.setattr(lock, "SP_MIN_PAIRS", 10)
    monkeypatch.setattr(lock, "CONTROL_LOOKBACK_DAYS", 2)

    md = make_test_md(n_min=2_000)
    populate_active_and_fills(md, 0, 2_000, price=100.0)
    xs, xs_valid = x_series(md)
    liq_prefix = liq_any_prefix(md)

    r_pre = np.full(2_000, np.nan, dtype=np.float64)
    r_pre[1000] = 0.05  # event D index

    # Candidate A at 875: 875 + 120 = 995 <= 995 (event_i0 = 995)
    r_pre[875] = 0.05
    # Candidate B at 876: 876 + 120 = 996 > 995 (exceeds event_i0)
    r_pre[876] = 0.05

    ctrls = find_controls(
        md=md,
        xs=xs,
        xs_valid=xs_valid,
        event_d_index=1000,
        event_i0=995,
        liq_any_prefix=liq_prefix,
        r_pre=r_pre,
    )
    assert 875 in ctrls
    assert 876 not in ctrls


def test_find_controls_quiet_window(monkeypatch: pytest.MonkeyPatch) -> None:
    """find_controls rejects candidate with liquidation 124 minutes before and accepts 125."""
    monkeypatch.setattr(lock, "ACTIVITY_WINDOW_MIN", 50)
    monkeypatch.setattr(lock, "ACTIVITY_MIN_ACTIVE_MIN", 10)
    monkeypatch.setattr(lock, "SP_WINDOW_DAYS", 1)
    monkeypatch.setattr(lock, "SP_MIN_PAIRS", 10)
    monkeypatch.setattr(lock, "CONTROL_LOOKBACK_DAYS", 2)

    md = make_test_md(n_min=2_000)
    populate_active_and_fills(md, 0, 2_000, price=100.0)

    # Candidate 1 at X = 500: quiet window is [500 - 125, 500) = [375, 500)
    # Liquidation at minute 375 is in [375, 500) (124 minutes from minute 376 to 500) -> rejected
    md.liq_sell_usd[375] = 100_000.0

    # Candidate 2 at X = 800: quiet window is [800 - 125, 800) = [675, 800)
    # Liquidation at minute 674 is outside [675, 800) (125 minutes from minute 675 to 800) -> accepted
    md.liq_sell_usd[674] = 100_000.0

    xs, xs_valid = x_series(md)
    liq_prefix = liq_any_prefix(md)

    r_pre = np.full(2_000, np.nan, dtype=np.float64)
    r_pre[1500] = 0.05
    r_pre[500] = 0.05
    r_pre[800] = 0.05

    ctrls = find_controls(
        md=md,
        xs=xs,
        xs_valid=xs_valid,
        event_d_index=1500,
        event_i0=1495,
        liq_any_prefix=liq_prefix,
        r_pre=r_pre,
    )
    assert 500 not in ctrls  # rejected (124 minutes quiet)
    assert 800 in ctrls  # accepted (125 minutes quiet)


def test_find_controls_nearest_r_pre_and_ties(monkeypatch: pytest.MonkeyPatch) -> None:
    """find_controls picks candidate nearest by r_pre and breaks ties by smaller X."""
    monkeypatch.setattr(lock, "ACTIVITY_WINDOW_MIN", 50)
    monkeypatch.setattr(lock, "ACTIVITY_MIN_ACTIVE_MIN", 10)
    monkeypatch.setattr(lock, "SP_WINDOW_DAYS", 1)
    monkeypatch.setattr(lock, "SP_MIN_PAIRS", 10)
    monkeypatch.setattr(lock, "CONTROL_LOOKBACK_DAYS", 2)

    md = make_test_md(n_min=2_000)
    populate_active_and_fills(md, 0, 2_000, price=100.0)
    xs, xs_valid = x_series(md)
    liq_prefix = liq_any_prefix(md)

    r_pre = np.full(2_000, np.nan, dtype=np.float64)
    r_pre[1500] = 0.05  # event r_pre

    # Candidate A at 400: r_pre = 0.052, diff = 0.002
    r_pre[400] = 0.052
    # Candidate B at 600: r_pre = 0.048, diff = 0.002 (tie with A, but A has smaller X)
    r_pre[600] = 0.048
    # Candidate C at 800: r_pre = 0.040, diff = 0.010 (larger diff)
    r_pre[800] = 0.040

    ctrls = find_controls(
        md=md,
        xs=xs,
        xs_valid=xs_valid,
        event_d_index=1500,
        event_i0=1495,
        liq_any_prefix=liq_prefix,
        r_pre=r_pre,
    )
    # Expected rank order: 400 (diff 0.002, smaller X), 600 (diff 0.002), 800 (diff 0.010)
    assert ctrls == [400, 600, 800]


def test_find_controls_spacing_and_small_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """find_controls enforces 125m spacing and returns fewer than 5 when pool is small."""
    monkeypatch.setattr(lock, "ACTIVITY_WINDOW_MIN", 50)
    monkeypatch.setattr(lock, "ACTIVITY_MIN_ACTIVE_MIN", 10)
    monkeypatch.setattr(lock, "SP_WINDOW_DAYS", 1)
    monkeypatch.setattr(lock, "SP_MIN_PAIRS", 10)
    monkeypatch.setattr(lock, "CONTROL_LOOKBACK_DAYS", 2)

    md = make_test_md(n_min=2_000)
    populate_active_and_fills(md, 0, 2_000, price=100.0)
    xs, xs_valid = x_series(md)
    liq_prefix = liq_any_prefix(md)

    r_pre = np.full(2_000, np.nan, dtype=np.float64)
    r_pre[1500] = 0.05

    # Candidate A at 500
    r_pre[500] = 0.051
    # Candidate B at 550 (within 50 < 125 min of 500)
    r_pre[550] = 0.051
    # Candidate C at 630 (130 >= 125 min from 500)
    r_pre[630] = 0.052

    ctrls = find_controls(
        md=md,
        xs=xs,
        xs_valid=xs_valid,
        event_d_index=1500,
        event_i0=1495,
        liq_any_prefix=liq_prefix,
        r_pre=r_pre,
    )
    # 550 is rejected because 500 is accepted and |550 - 500| < 125
    assert ctrls == [500, 630]
    assert len(ctrls) == 2  # returns fewer than 5


def test_find_controls_fills_requirement(monkeypatch: pytest.MonkeyPatch) -> None:
    """find_controls rejects candidates where order fills are not found."""
    monkeypatch.setattr(lock, "ACTIVITY_WINDOW_MIN", 50)
    monkeypatch.setattr(lock, "ACTIVITY_MIN_ACTIVE_MIN", 10)
    monkeypatch.setattr(lock, "SP_WINDOW_DAYS", 1)
    monkeypatch.setattr(lock, "SP_MIN_PAIRS", 10)
    monkeypatch.setattr(lock, "CONTROL_LOOKBACK_DAYS", 2)

    md = make_test_md(n_min=2_000)
    populate_active_and_fills(md, 0, 2_000, price=100.0)

    # Candidate at 500 has no first print of either side, so no entry fill exists for any order
    # (a buy with no buy print would still fill through the sell print plus the spread)
    md.first_buy_px[500] = np.nan
    md.first_sell_px[500] = np.nan

    # Candidate at 800 has all fills
    # (already populated)

    xs, xs_valid = x_series(md)
    liq_prefix = liq_any_prefix(md)

    r_pre = np.full(2_000, np.nan, dtype=np.float64)
    r_pre[1500] = 0.05
    r_pre[500] = 0.05
    r_pre[800] = 0.05

    ctrls = find_controls(
        md=md,
        xs=xs,
        xs_valid=xs_valid,
        event_d_index=1500,
        event_i0=1495,
        liq_any_prefix=liq_prefix,
        r_pre=r_pre,
    )
    assert 500 not in ctrls
    assert 800 in ctrls
