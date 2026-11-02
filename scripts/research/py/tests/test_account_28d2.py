"""Brief 28d-2: the $100 account prices intrabar exits at their fill and checks liquidation at 5m extremes."""

from __future__ import annotations

import pandas as pd
import pytest

from r4.account import simulate_account
from r4.costs import coin_slippage_bps
from tests.test_account import BAR, DAY, HOUR, START, TWO_DAYS, _bars, _tr


def _with_wick(frame: pd.DataFrame, bar: int, high: float | None = None, low: float | None = None) -> pd.DataFrame:
    out = frame.copy()
    if high is not None:
        out.loc[bar, "h"] = high
    if low is not None:
        out.loc[bar, "l"] = low
    return out


def _stop_fill(side_w: float, reason: str, exit_fill: str = "taker"):
    five = {"SOLUSDT": _bars(100.0, TWO_DAYS)}
    tr = [
        _tr(
            "SOLUSDT",
            side_w,
            START + HOUR,
            START + 6 * HOUR,
            exit_price=95.0 if side_w > 0 else 105.0,
            exit_reason=reason,
            exit_fill=exit_fill,
        )
    ]
    return simulate_account(tr, five, {}, equity0=100.0, leverage=10)


def test_stop_is_priced_at_its_fill_plus_taker_slippage():
    slip = coin_slippage_bps("SOLUSDT") / 10000.0
    long_stop = _stop_fill(0.1, "stop")
    assert list(long_stop.fills["kind"]) == ["taker", "taker"]
    assert long_stop.fills["price"].iloc[-1] == pytest.approx(95.0 * (1.0 - slip), rel=1e-12)
    short_stop = _stop_fill(-0.1, "stop")
    assert short_stop.fills["price"].iloc[-1] == pytest.approx(105.0 * (1.0 + slip), rel=1e-12)
    # The slippage cost of the stop is measured against its fill level, not against the 5m open at the stamp.
    entry_slip = 1.0 * 100.0 * slip
    assert long_stop.slippage_cost == pytest.approx(entry_slip + 1.0 * 95.0 * slip, rel=1e-9)


def test_take_profit_and_maker_exit_fill_at_their_price_without_slippage():
    tp = _stop_fill(0.1, "take_profit")
    assert tp.fills["price"].iloc[-1] == pytest.approx(95.0, rel=1e-12)
    maker = _stop_fill(0.1, "maker_exit", exit_fill="maker")
    assert maker.fills["kind"].iloc[-1] == "maker"
    assert maker.fills["price"].iloc[-1] == pytest.approx(95.0, rel=1e-12)


def test_horizon_exit_still_fills_at_the_open_with_slippage():
    slip = coin_slippage_bps("SOLUSDT") / 10000.0
    res = _stop_fill(0.1, "horizon")
    assert res.fills["price"].iloc[-1] == pytest.approx(100.0 * (1.0 - slip), rel=1e-12)


def test_liquidation_is_checked_at_the_bar_low_for_longs():
    # 50x on SOL, 5 SOL long entered at 100.02. Every 5m open stays at 100, but one bar wicks to 80.5.
    base = _bars(100.0, TWO_DAYS)
    tr = [_tr("SOLUSDT", 0.1, START + 6 * BAR, START + DAY)]
    calm = simulate_account(tr, {"SOLUSDT": base}, {}, equity0=100.0, leverage=50)
    assert calm.liquidation is None
    wick = _with_wick(base, 24, low=80.5)
    res = simulate_account(tr, {"SOLUSDT": wick}, {}, equity0=100.0, leverage=50)
    assert res.liquidation is not None
    assert res.liquidation["t"] == START + 24 * BAR
    assert res.liquidation["equity_before"] == pytest.approx(100 - 0.25005 + 5 * (80.5 - 100.02), rel=1e-9)
    assert res.liquidation["notional"] == pytest.approx(5 * 80.5, rel=1e-9)
    # A wick that stays above the maintenance line does not liquidate.
    shallow = _with_wick(base, 24, low=90.0)
    assert simulate_account(tr, {"SOLUSDT": shallow}, {}, equity0=100.0, leverage=50).liquidation is None
    # A spike HIGH does not hurt a long.
    spike = _with_wick(base, 24, high=140.0)
    assert simulate_account(tr, {"SOLUSDT": spike}, {}, equity0=100.0, leverage=50).liquidation is None


def test_liquidation_is_checked_at_the_bar_high_for_shorts():
    base = _bars(100.0, TWO_DAYS)
    tr = [_tr("SOLUSDT", -0.1, START + 6 * BAR, START + DAY)]
    assert simulate_account(tr, {"SOLUSDT": base}, {}, equity0=100.0, leverage=50).liquidation is None
    spike = _with_wick(base, 24, high=119.5)
    res = simulate_account(tr, {"SOLUSDT": spike}, {}, equity0=100.0, leverage=50)
    assert res.liquidation is not None and res.liquidation["t"] == START + 24 * BAR
    drop = _with_wick(base, 24, low=60.0)
    assert simulate_account(tr, {"SOLUSDT": drop}, {}, equity0=100.0, leverage=50).liquidation is None
