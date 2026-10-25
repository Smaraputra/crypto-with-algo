"""Tests for r4.book: lock-v2 BOOK RULE tranches to daily mark-to-market book returns,

drift-hedged returns, and drift-free trade returns.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from r4.book import (
    DAY_MS,
    Tranche,
    daily_book,
    drift_hedged,
    equal_weight_market,
    trade_level,
)


def test_single_long_tranche_inside_one_day() -> None:
    """1. A single long tranche fully inside one day, size = 1, h = 8h at 1h:

    - weight = 1 / 8 / 10;
    - gross = weight x log(exit / entry);
    - costs = abs(weight) x 2 x (taker + slippage);
    - net is correct.
    """
    day_0 = 1700006400000  # Multiple of 86400000
    assert day_0 % DAY_MS == 0

    entry_ms = day_0 + 3_600_000  # 01:00 UTC
    exit_ms = day_0 + 9 * 3_600_000  # 09:00 UTC
    entry_price = 100.0
    exit_price = 105.0

    tranche = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=entry_price,
        exit_price=exit_price,
        interval="1h",
        h_ms=8 * 3_600_000,
        size=1.0,
        entry_fill="taker",
        exit_fill="taker",
    )

    expected_weight = 1.0 / 8.0 / 10.0
    assert tranche.weight == expected_weight

    df_5m = pd.DataFrame({"t": [day_0, day_0 + DAY_MS], "o": [100.0, 106.0]})
    five_min = {"BTCUSDT": df_5m}

    df_book = daily_book([tranche], five_min, settlements=None)
    assert len(df_book) == 1
    assert df_book.index[0] == day_0

    row = df_book.loc[day_0]
    expected_gross = expected_weight * float(np.log(exit_price / entry_price))
    taker_fee = 0.0005
    slippage = 0.0003  # 3 bps for 1h
    expected_costs = abs(expected_weight) * 2.0 * (taker_fee + slippage)
    expected_funding = 0.0
    expected_net = expected_gross - expected_costs + expected_funding

    assert np.isclose(row["gross"], expected_gross, rtol=1e-12, atol=1e-12)
    assert np.isclose(row["costs"], expected_costs, rtol=1e-12, atol=1e-12)
    assert np.isclose(row["funding"], expected_funding, rtol=1e-12, atol=1e-12)
    assert np.isclose(row["net"], expected_net, rtol=1e-12, atol=1e-12)
    assert row["net_weight_start"] == 0.0
    assert row["n_open"] == 1
    assert row["substitutions"] == 0


def test_tranche_spanning_midnight() -> None:
    """2. A tranche spanning midnight:

    the gross is split across two days at the 00:00 5m open,
    and the two days' gross add up to weight x log(exit / entry) exactly (to 1e-12).
    """
    day_1 = 1700006400000
    day_2 = day_1 + DAY_MS

    entry_ms = day_1 + 20 * 3_600_000  # 20:00 Day 1
    exit_ms = day_2 + 4 * 3_600_000  # 04:00 Day 2
    entry_price = 100.0
    exit_price = 110.0
    p_midnight = 104.0

    tranche = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=entry_price,
        exit_price=exit_price,
        interval="1h",
        h_ms=8 * 3_600_000,
        size=1.0,
    )

    df_5m = pd.DataFrame({"t": [day_1, day_2, day_2 + DAY_MS], "o": [98.0, p_midnight, 112.0]})
    five_min = {"BTCUSDT": df_5m}

    df_book = daily_book([tranche], five_min, settlements=None)
    assert len(df_book) == 2
    assert list(df_book.index) == [day_1, day_2]

    gross_1 = df_book.loc[day_1, "gross"]
    gross_2 = df_book.loc[day_2, "gross"]
    w = tranche.weight

    expected_gross_1 = w * float(np.log(p_midnight / entry_price))
    expected_gross_2 = w * float(np.log(exit_price / p_midnight))
    assert np.isclose(gross_1, expected_gross_1, rtol=1e-12, atol=1e-12)
    assert np.isclose(gross_2, expected_gross_2, rtol=1e-12, atol=1e-12)

    total_gross = gross_1 + gross_2
    expected_total_gross = w * float(np.log(exit_price / entry_price))
    assert abs(total_gross - expected_total_gross) < 1e-12

    taker_fee = 0.0005
    slippage = 0.0003
    single_fill_cost = abs(w) * (taker_fee + slippage)
    assert np.isclose(df_book.loc[day_1, "costs"], single_fill_cost, rtol=1e-12, atol=1e-12)
    assert np.isclose(df_book.loc[day_2, "costs"], single_fill_cost, rtol=1e-12, atol=1e-12)


def test_missing_midnight_bar_carry_forward() -> None:
    """3. A missing 00:00 bar: the carry-forward is used and substitutions == 1."""
    day_1 = 1700006400000
    day_2 = day_1 + DAY_MS

    entry_ms = day_1 + 20 * 3_600_000  # 20:00 Day 1
    exit_ms = day_2 + 4 * 3_600_000  # 04:00 Day 2
    entry_price = 100.0
    exit_price = 110.0

    tranche = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=entry_price,
        exit_price=exit_price,
        interval="1h",
        h_ms=8 * 3_600_000,
        size=1.0,
    )

    # Missing bar at day_2 (00:00). Last bar before midnight is at 23:55 (day_2 - 300_000)
    p_carry = 103.5
    df_5m = pd.DataFrame(
        {
            "t": [day_1, day_2 - 300_000, day_2 + DAY_MS],
            "o": [98.0, p_carry, 112.0],
        }
    )
    five_min = {"BTCUSDT": df_5m}

    df_book = daily_book([tranche], five_min, settlements=None)
    w = tranche.weight

    expected_gross_1 = w * float(np.log(p_carry / entry_price))
    expected_gross_2 = w * float(np.log(exit_price / p_carry))

    assert np.isclose(df_book.loc[day_1, "gross"], expected_gross_1, rtol=1e-12, atol=1e-12)
    assert np.isclose(df_book.loc[day_2, "gross"], expected_gross_2, rtol=1e-12, atol=1e-12)
    assert df_book.loc[day_1, "substitutions"] == 1
    assert df_book.loc[day_2, "substitutions"] == 1


def test_funding_assignment_and_signs() -> None:
    """4. Funding:

    - settlement at 08:00 inside the hold is charged to that day with right sign;
    - settlement exactly at the exit time is included;
    - settlement exactly at the entry time is not;
    - settlement at 00:00 goes to the earlier day.
    """
    day_1 = 1700006400000
    day_2 = day_1 + DAY_MS
    day_3 = day_2 + DAY_MS

    # 4a: A settlement at 08:00 inside the hold is charged with the right sign (long pays positive rate)
    t_entry_4a = day_1 + 6 * 3_600_000
    t_exit_4a = day_1 + 14 * 3_600_000
    tranche_4a = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=t_entry_4a,
        exit_ms=t_exit_4a,
        entry_price=100.0,
        exit_price=100.0,
        interval="1h",
        h_ms=8 * 3_600_000,
    )
    t_settle_8h = day_1 + 8 * 3_600_000
    settlements_4a = [(t_settle_8h, 0.0001)]
    df_5m = pd.DataFrame({"t": [day_1, day_2], "o": [100.0, 100.0]})
    five_min = {"BTCUSDT": df_5m}

    res_4a = daily_book([tranche_4a], five_min, settlements=settlements_4a)
    w_4a = tranche_4a.weight
    expected_funding_4a = -w_4a * 0.0001
    assert expected_funding_4a < 0.0
    assert np.isclose(res_4a.loc[day_1, "funding"], expected_funding_4a, rtol=1e-12, atol=1e-12)

    # 4b: A settlement exactly at exit time is included
    t_entry_4b = day_1 + 6 * 3_600_000
    t_exit_4b = t_settle_8h
    tranche_4b = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=t_entry_4b,
        exit_ms=t_exit_4b,
        entry_price=100.0,
        exit_price=100.0,
        interval="1h",
        h_ms=2 * 3_600_000,
    )
    res_4b = daily_book([tranche_4b], five_min, settlements=settlements_4a)
    expected_funding_4b = -tranche_4b.weight * 0.0001
    assert np.isclose(res_4b.loc[day_1, "funding"], expected_funding_4b, rtol=1e-12, atol=1e-12)

    # 4c: A settlement exactly at entry time is NOT included
    t_entry_4c = t_settle_8h
    t_exit_4c = day_1 + 16 * 3_600_000
    tranche_4c = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=t_entry_4c,
        exit_ms=t_exit_4c,
        entry_price=100.0,
        exit_price=100.0,
        interval="1h",
        h_ms=8 * 3_600_000,
    )
    res_4c = daily_book([tranche_4c], five_min, settlements=settlements_4a)
    assert res_4c.loc[day_1, "funding"] == 0.0

    # 4d: A settlement at 00:00 goes to the earlier day
    settlements_4d = [(day_2, 0.0002)]
    tranche_4d = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=day_1 + 20 * 3_600_000,
        exit_ms=day_2 + 4 * 3_600_000,
        entry_price=100.0,
        exit_price=100.0,
        interval="1h",
        h_ms=8 * 3_600_000,
    )
    df_5m_4d = pd.DataFrame({"t": [day_1, day_2, day_3], "o": [100.0, 100.0, 100.0]})
    res_4d = daily_book([tranche_4d], {"BTCUSDT": df_5m_4d}, settlements=settlements_4d)
    w_4d = tranche_4d.weight
    assert np.isclose(res_4d.loc[day_1, "funding"], -w_4d * 0.0002, rtol=1e-12, atol=1e-12)
    assert res_4d.loc[day_2, "funding"] == 0.0


def test_stacking_eight_overlapping_tranches() -> None:
    """5. Stacking:

    8 overlapping long tranches on one coin at 1h with h = 8h give
    net_weight_start of 0.1 (one full slot) at a midnight where all 8 are open.
    """
    midnight = 1700006400000 + DAY_MS
    day_1 = 1700006400000
    day_2 = midnight
    day_3 = midnight + DAY_MS

    offsets_hours = [7.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.0, 0.5]
    tranches = []
    for off in offsets_hours:
        e = int(midnight - off * 3_600_000)
        x = int(e + 8 * 3_600_000)
        assert e < midnight < x
        tranches.append(
            Tranche(
                symbol="BTCUSDT",
                side=1,
                entry_ms=e,
                exit_ms=x,
                entry_price=100.0,
                exit_price=100.0,
                interval="1h",
                h_ms=8 * 3_600_000,
                size=1.0,
            )
        )

    df_5m = pd.DataFrame({"t": [day_1, day_2, day_3], "o": [100.0, 100.0, 100.0]})
    five_min = {"BTCUSDT": df_5m}

    df_book = daily_book(tranches, five_min, settlements=None)
    net_weight_start = df_book.loc[day_2, "net_weight_start"]
    assert np.isclose(net_weight_start, 0.1, rtol=1e-12, atol=1e-12)


def test_drift_hedged_gross_zero_when_long_all_coins() -> None:
    """6. drift_hedged:

    for a book that is long one full slot of every coin all day (10 tranches),
    the drift-hedged gross is about 0 (to 1e-9) on that day.
    """
    day_1 = 1700006400000
    day_2 = day_1 + DAY_MS

    coins = [f"COIN{i}USDT" for i in range(10)]
    five_min = {}
    tranches = []

    rng = np.random.default_rng(42)
    for coin in coins:
        p_start = float(rng.uniform(50.0, 200.0))
        p_end = float(p_start * rng.uniform(0.9, 1.1))

        df_coin = pd.DataFrame({"t": [day_1, day_2], "o": [p_start, p_end]})
        five_min[coin] = df_coin

        tranches.append(
            Tranche(
                symbol=coin,
                side=1,
                entry_ms=day_1 - 3_600_000,
                exit_ms=day_2 + 3_600_000,
                entry_price=p_start,
                exit_price=p_end,
                interval="1h",
                h_ms=3_600_000,  # h_ms == interval_ms => weight = 0.1 (one slot)
                size=1.0,
            )
        )

    df_book = daily_book(tranches, five_min, settlements=None)
    df_market = equal_weight_market(five_min, [day_1], universe=coins)

    dh_gross = drift_hedged(df_book, df_market, col="gross")
    assert abs(dh_gross.loc[day_1]) < 1e-9

    dh_net = drift_hedged(df_book, df_market)
    assert abs(dh_net.loc[day_1]) < 1e-9


def test_trade_level_drift_free_and_plain_net() -> None:
    """7. trade_level drift-free equals a hand computation, and for m = 0 equals the plain net."""
    entry_ms = 0
    exit_ms = 4 * 3_600_000
    entry_price = 100.0
    exit_price = 105.0

    tranche = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=entry_price,
        exit_price=exit_price,
        interval="1h",
        h_ms=4 * 3_600_000,
        entry_fill="taker",
        exit_fill="taker",
    )

    settlements = [(2 * 3_600_000, 0.0001)]
    m = 0.0002
    hold_hours = 4.0

    fees = 0.0005 + 0.0005  # standard taker fee = 0.001
    slip = 0.0003 + 0.0003  # 1h slippage = 3 bps each = 0.0006
    costs = fees + slip  # 0.0016
    signed_funding = 1 * 0.0001
    gross_log = float(np.log(105.0 / 100.0))

    expected_drift_free = 1 * (gross_log - m * hold_hours) - costs - signed_funding

    res = trade_level([tranche], settlements, coin_mean_hourly={"BTCUSDT": m})
    assert len(res) == 1
    assert np.isclose(res.loc[0, "hold_hours"], 4.0, rtol=1e-12, atol=1e-12)
    assert np.isclose(res.loc[0, "drift_free_return"], expected_drift_free, rtol=1e-12, atol=1e-12)

    # For m = 0 on a flat trade (entry_price == exit_price), drift_free equals plain net
    flat_tranche = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=100.0,
        exit_price=100.0,
        interval="1h",
        h_ms=4 * 3_600_000,
        entry_fill="taker",
        exit_fill="taker",
    )
    res_flat = trade_level([flat_tranche], settlements, coin_mean_hourly={"BTCUSDT": 0.0})
    assert np.isclose(res_flat.loc[0, "drift_free_return"], res_flat.loc[0, "net_return"], rtol=1e-12, atol=1e-12)


def test_day_with_no_tranche_omitted() -> None:
    """8. A day with no tranche is omitted."""
    day_1 = 1700006400000
    day_2 = day_1 + DAY_MS
    day_3 = day_2 + DAY_MS
    day_4 = day_3 + DAY_MS

    t1 = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=day_1 + 3_600_000,
        exit_ms=day_1 + 6 * 3_600_000,
        entry_price=100.0,
        exit_price=102.0,
        interval="1h",
        h_ms=3 * 3_600_000,
    )
    t2 = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=day_3 + 3_600_000,
        exit_ms=day_3 + 6 * 3_600_000,
        entry_price=105.0,
        exit_price=107.0,
        interval="1h",
        h_ms=3 * 3_600_000,
    )

    df_5m = pd.DataFrame({"t": [day_1, day_2, day_3, day_4], "o": [100.0, 102.0, 105.0, 107.0]})
    five_min = {"BTCUSDT": df_5m}

    df_book = daily_book([t1, t2], five_min, settlements=None)
    assert list(df_book.index) == [day_1, day_3]
    assert day_2 not in df_book.index


def test_equal_weight_market_missing_coin() -> None:
    """Check equal_weight_market when a coin in universe is missing."""
    day_1 = 1700006400000
    day_2 = day_1 + DAY_MS

    # Universe of 3 coins: BTC, ETH, and SOL. SOL has no data.
    df_btc = pd.DataFrame({"t": [day_1, day_2], "o": [100.0, 110.0]})
    df_eth = pd.DataFrame({"t": [day_1, day_2], "o": [10.0, 9.0]})
    five_min = {"BTCUSDT": df_btc, "ETHUSDT": df_eth}

    universe = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    res = equal_weight_market(five_min, [day_1], universe)

    assert len(res) == 1
    assert res.loc[day_1, "n_coins"] == 2

    expected_btc = np.log(110.0 / 100.0)
    expected_eth = np.log(9.0 / 10.0)
    expected_mean = float(np.mean([expected_btc, expected_eth]))
    assert np.isclose(res.loc[day_1, "market"], expected_mean, rtol=1e-12, atol=1e-12)


def test_tranches_dataframe_input() -> None:
    """Check that daily_book and trade_level accept tranches as pd.DataFrame."""
    day_0 = 1700006400000
    df_tranches = pd.DataFrame(
        [
            {
                "symbol": "BTCUSDT",
                "side": 1,
                "entry_ms": day_0 + 3_600_000,
                "exit_ms": day_0 + 9 * 3_600_000,
                "entry_price": 100.0,
                "exit_price": 105.0,
                "interval": "1h",
                "h_ms": 8 * 3_600_000,
                "size": 1.0,
                "entry_fill": "taker",
                "exit_fill": "taker",
            }
        ]
    )

    df_5m = pd.DataFrame({"t": [day_0, day_0 + DAY_MS], "o": [100.0, 106.0]})
    five_min = {"BTCUSDT": df_5m}

    df_book = daily_book(df_tranches, five_min, settlements=None)
    assert len(df_book) == 1
    assert df_book.loc[day_0, "n_open"] == 1

    tl = trade_level(df_tranches, settlements=None)
    assert len(tl) == 1
    assert tl.loc[0, "hold_hours"] == 8.0


def test_empty_tranches() -> None:
    """Check daily_book and trade_level with empty tranches."""
    five_min = {"BTCUSDT": pd.DataFrame({"t": [1700006400000], "o": [100.0]})}
    book_empty = daily_book([], five_min, settlements=None)
    assert book_empty.empty
    assert "gross" in book_empty.columns
    assert "net" in book_empty.columns

    tl_empty = trade_level([], settlements=None)
    assert tl_empty.empty
    assert "net_return" in tl_empty.columns
