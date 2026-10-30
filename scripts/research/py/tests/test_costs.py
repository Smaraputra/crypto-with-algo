"""Tests for r4.costs: fee schedules, slippage budgets, funding rates, and net trade returns."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from r4.costs import (
    BINANCE_FUTURES_MAKER_FEE,
    BINANCE_FUTURES_TAKER_FEE,
    DEFAULT_FEE_PROFILE,
    FEE_PROFILES,
    FUNDING_INTERVAL_MS,
    STUDY_SLIPPAGE_BPS,
    apply_slippage,
    default_cost_percent,
    funding_crossings,
    funding_pnl,
    funding_sums_for,
    resolve_fee_profile,
    study_cost_config,
    trade_funding,
    trade_net_return,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "costs.json"


@pytest.fixture(scope="module")
def costs_fixture() -> dict[str, Any]:
    with FIXTURE_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def test_constants_and_fee_profiles(costs_fixture: dict[str, Any]) -> None:
    constants = costs_fixture["constants"]
    assert BINANCE_FUTURES_MAKER_FEE == constants["BINANCE_FUTURES_MAKER_FEE"]
    assert BINANCE_FUTURES_TAKER_FEE == constants["BINANCE_FUTURES_TAKER_FEE"]
    assert STUDY_SLIPPAGE_BPS == constants["STUDY_SLIPPAGE_BPS"]
    assert FUNDING_INTERVAL_MS == constants["FUNDING_INTERVAL_MS"]
    assert DEFAULT_FEE_PROFILE == "standard"

    for name, expected_profile in constants["FEE_PROFILES"].items():
        assert name in FEE_PROFILES
        actual = FEE_PROFILES[name]
        assert actual == expected_profile
        assert actual.name == expected_profile["name"]
        assert actual.maker_fee == pytest.approx(expected_profile["makerFee"], rel=1e-8, abs=1e-15)
        assert actual.taker_fee == pytest.approx(expected_profile["takerFee"], rel=1e-8, abs=1e-15)
        assert actual.note == expected_profile["note"]
        if "symbols" in expected_profile:
            assert actual.symbols is not None
            assert list(actual.symbols) == expected_profile["symbols"]
        if "fallback" in expected_profile:
            assert actual.fallback == expected_profile["fallback"]


def test_cost_cases(costs_fixture: dict[str, Any]) -> None:
    for case in costs_fixture["costCases"]:
        interval = case["interval"]
        profile = case["profile"]
        symbol = case["symbol"]

        resolved = resolve_fee_profile(profile, symbol)
        assert resolved.name == case["resolvedProfile"]

        cost_pct = default_cost_percent(interval, profile, symbol)
        assert cost_pct == pytest.approx(case["defaultCostPercent"], rel=1e-8, abs=1e-15)

        cfg = study_cost_config(interval, profile, symbol)
        expected_cfg = case["studyCostConfig"]
        assert cfg["fee_percent"] == pytest.approx(expected_cfg["feePercent"], rel=1e-8, abs=1e-15)
        assert cfg["maker_fee_percent"] == pytest.approx(expected_cfg["makerFeePercent"], rel=1e-8, abs=1e-15)
        assert cfg["taker_fee_percent"] == pytest.approx(expected_cfg["takerFeePercent"], rel=1e-8, abs=1e-15)
        assert cfg["slippage_bps"] == expected_cfg["slippageBps"]


def test_slippage_cases(costs_fixture: dict[str, Any]) -> None:
    for case in costs_fixture["slippageCases"]:
        price = case["price"]
        direction = case["direction"]
        bps = case["bps"]
        expected = case["result"]
        actual = apply_slippage(price, direction, bps)
        assert actual == pytest.approx(expected, rel=1e-8, abs=1e-15)


def test_crossing_cases(costs_fixture: dict[str, Any]) -> None:
    for case in costs_fixture["crossingCases"]:
        prev = case["prevCloseTime"]
        close = case["closeTime"]
        expected = case["crossings"]
        actual = funding_crossings(prev, close)
        assert actual == expected
        assert isinstance(actual, int)


def test_pnl_cases(costs_fixture: dict[str, Any]) -> None:
    for case in costs_fixture["pnlCases"]:
        notional = case["notional"]
        rate = case["fundingRate"]
        side = case["side"]
        crossings = case["crossings"]
        expected = case["pnl"]
        actual = funding_pnl(notional, rate, side, crossings)
        assert actual == pytest.approx(expected, rel=1e-8, abs=1e-15)


def test_sums_cases(costs_fixture: dict[str, Any]) -> None:
    settlements = costs_fixture["settlements"]
    for case in costs_fixture["sumsCases"]:
        opens = case["opens"]
        interval_ms = case["intervalMs"]
        expected = np.array(case["sums"], dtype=np.float64)

        actual = funding_sums_for(opens, interval_ms, settlements)
        assert actual.dtype == np.float64
        assert len(actual) == len(expected)
        np.testing.assert_allclose(actual, expected, rtol=1e-8, atol=1e-15)

        settlements_tuples = [(s["t"], s["rate"]) for s in settlements]
        actual_tuples = funding_sums_for(opens, interval_ms, settlements_tuples)
        np.testing.assert_allclose(actual_tuples, expected, rtol=1e-8, atol=1e-15)


def test_trade_funding_boundaries() -> None:
    # A settlement exactly at entry_ms is excluded, and one exactly at exit_ms is included.
    times = [1000, 1500, 2000]
    rates = [0.001, 0.002, 0.004]

    # Exactly at entry_ms (1000) is excluded; within window (1500) and at exit_ms (2000) are included
    res = trade_funding(times, rates, entry_ms=1000, exit_ms=2000)
    assert res == pytest.approx(0.002 + 0.004, rel=1e-8, abs=1e-15)

    # When entry_ms=999, 1000 is included
    res2 = trade_funding(times, rates, entry_ms=999, exit_ms=1000)
    assert res2 == pytest.approx(0.001, rel=1e-8, abs=1e-15)

    # When exit_ms=1999, 2000 is excluded
    res3 = trade_funding(times, rates, entry_ms=1000, exit_ms=1999)
    assert res3 == pytest.approx(0.002, rel=1e-8, abs=1e-15)

    # Empty interval or reversed interval returns 0.0
    assert trade_funding(times, rates, entry_ms=2000, exit_ms=2000) == 0.0
    assert trade_funding(times, rates, entry_ms=3000, exit_ms=2000) == 0.0


def test_trade_net_return_hand_computation() -> None:
    # Interval "1h": slippage is 3 bps = 0.0003
    # Profile "standard": maker_fee = 0.0002, taker_fee = 0.0005
    # entry_price = 100.0, exit_price = 105.0 -> gross price change = 105 / 100 - 1 = +0.05
    # funding_sum = +0.0001
    entry_p = 100.0
    exit_p = 105.0
    funding = 0.0001
    interval = "1h"

    # 1. Long (+1), taker/taker:
    # gross = +0.05
    # funding term: long pays positive funding -> - (+1) * 0.0001 = -0.0001
    # fees: 0.0005 (taker) + 0.0005 (taker) = 0.0010
    # slip: 0.0003 + 0.0003 = 0.0006
    # net = 0.05 - 0.0001 - 0.0010 - 0.0006 = 0.0483
    ret_long_taker_taker = trade_net_return(
        side=1,
        entry_price=entry_p,
        exit_price=exit_p,
        funding_sum=funding,
        interval=interval,
        entry_fill="taker",
        exit_fill="taker",
    )
    assert ret_long_taker_taker == pytest.approx(0.0483, rel=1e-8, abs=1e-15)

    # 2. Long (+1), maker/taker:
    # fees: 0.0002 (maker) + 0.0005 (taker) = 0.0007
    # slip: 0.0 (maker) + 0.0003 (taker) = 0.0003
    # net = 0.05 - 0.0001 - 0.0007 - 0.0003 = 0.0489
    ret_long_maker_taker = trade_net_return(
        side=1,
        entry_price=entry_p,
        exit_price=exit_p,
        funding_sum=funding,
        interval=interval,
        entry_fill="maker",
        exit_fill="taker",
    )
    assert ret_long_maker_taker == pytest.approx(0.0489, rel=1e-8, abs=1e-15)

    # 3. Long (+1), maker/maker:
    # fees: 0.0002 (maker) + 0.0002 (maker) = 0.0004
    # slip: 0.0 + 0.0 = 0.0
    # net = 0.05 - 0.0001 - 0.0004 - 0.0 = 0.0495
    ret_long_maker_maker = trade_net_return(
        side=1,
        entry_price=entry_p,
        exit_price=exit_p,
        funding_sum=funding,
        interval=interval,
        entry_fill="maker",
        exit_fill="maker",
    )
    assert ret_long_maker_maker == pytest.approx(0.0495, rel=1e-8, abs=1e-15)

    # 4. Short (-1), taker/taker:
    # gross = -1 * (105 / 100 - 1) = -0.05
    # funding term: short receives positive funding -> - (-1) * 0.0001 = +0.0001
    # fees: 0.0005 + 0.0005 = 0.0010
    # slip: 0.0003 + 0.0003 = 0.0006
    # net = -0.05 + 0.0001 - 0.0010 - 0.0006 = -0.0515
    ret_short_taker_taker = trade_net_return(
        side=-1,
        entry_price=entry_p,
        exit_price=exit_p,
        funding_sum=funding,
        interval=interval,
        entry_fill="taker",
        exit_fill="taker",
    )
    assert ret_short_taker_taker == pytest.approx(-0.0515, rel=1e-8, abs=1e-15)

    # 5. Short (-1), maker/taker:
    # fees: 0.0002 + 0.0005 = 0.0007
    # slip: 0.0 + 0.0003 = 0.0003
    # net = -0.05 + 0.0001 - 0.0007 - 0.0003 = -0.0509
    ret_short_maker_taker = trade_net_return(
        side=-1,
        entry_price=entry_p,
        exit_price=exit_p,
        funding_sum=funding,
        interval=interval,
        entry_fill="maker",
        exit_fill="taker",
    )
    assert ret_short_maker_taker == pytest.approx(-0.0509, rel=1e-8, abs=1e-15)

    # 6. Short (-1), maker/maker:
    # fees: 0.0002 + 0.0002 = 0.0004
    # slip: 0.0
    # net = -0.05 + 0.0001 - 0.0004 = -0.0503
    ret_short_maker_maker = trade_net_return(
        side=-1,
        entry_price=entry_p,
        exit_price=exit_p,
        funding_sum=funding,
        interval=interval,
        entry_fill="maker",
        exit_fill="maker",
    )
    assert ret_short_maker_maker == pytest.approx(-0.0503, rel=1e-8, abs=1e-15)

    # Explicit check for funding sign:
    # Long pays positive funding: net return with positive funding < net return with zero funding
    ret_long_zero_fund = trade_net_return(side=1, entry_price=100.0, exit_price=100.0, funding_sum=0.0, interval="1h")
    ret_long_pos_fund = trade_net_return(side=1, entry_price=100.0, exit_price=100.0, funding_sum=0.01, interval="1h")
    assert ret_long_pos_fund == pytest.approx(ret_long_zero_fund - 0.01, rel=1e-8, abs=1e-15)

    # Short receives positive funding: net return with positive funding > net return with zero funding
    ret_short_zero_fund = trade_net_return(side=-1, entry_price=100.0, exit_price=100.0, funding_sum=0.0, interval="1h")
    ret_short_pos_fund = trade_net_return(side=-1, entry_price=100.0, exit_price=100.0, funding_sum=0.01, interval="1h")
    assert ret_short_pos_fund == pytest.approx(ret_short_zero_fund + 0.01, rel=1e-8, abs=1e-15)


def test_unknown_profile_and_interval_raise() -> None:
    with pytest.raises(ValueError, match="Unknown fee profile"):
        resolve_fee_profile("unknown_schedule")

    with pytest.raises(ValueError, match="No slippage budget configured"):
        study_cost_config("2m")

    with pytest.raises(ValueError, match="No slippage budget configured"):
        default_cost_percent("2m")

    with pytest.raises(ValueError, match="No slippage budget configured"):
        trade_net_return(1, 100.0, 105.0, 0.0, "2m")

    with pytest.raises(ValueError, match="side must be"):
        trade_net_return(0, 100.0, 105.0, 0.0, "1h")

    with pytest.raises(ValueError, match="Unknown entry_fill"):
        trade_net_return(1, 100.0, 105.0, 0.0, "1h", entry_fill="other")

    with pytest.raises(ValueError, match="Unknown exit_fill"):
        trade_net_return(1, 100.0, 105.0, 0.0, "1h", exit_fill="other")

    with pytest.raises(ValueError, match="Unknown direction"):
        apply_slippage(100.0, "hold", 5)

    with pytest.raises(ValueError, match="Unknown side"):
        funding_pnl(1.0, 0.0001, "flat", 1)
