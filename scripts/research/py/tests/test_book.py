"""Tests for r4.book: lock-v2 BOOK RULE tranches to daily mark-to-market book returns,

drift-hedged returns, and drift-free trade returns.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from r4.book import (
    DAY_MS,
    Tranche,
    beta_hedged_daily,
    daily_book,
    daily_close_log_returns,
    daily_series,
    equal_weight_market,
    estimate_betas,
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


def test_beta_hedged_identical_moves_beta_one_and_zero() -> None:
    """1. One long tranche inside one day, at beta 1, on a panel where every coin moves identically:
    drift_free equals minus the costs (the hedge removes all the market move), to 1e-12.

    2. The same tranche at beta 0: drift_free equals the raw net of daily_book.
    """
    day_0 = 1700006400000
    entry_ms = day_0 + 3_600_000
    exit_ms = day_0 + 9 * 3_600_000
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

    universe = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT"]
    five_min = {}
    for coin in universe:
        df_coin = pd.DataFrame(
            {
                "t": [day_0, entry_ms, exit_ms, day_0 + DAY_MS],
                "o": [100.0, entry_price, exit_price, 105.0],
            }
        )
        five_min[coin] = df_coin

    # 1. At beta 1
    betas_1 = {coin: 1.0 for coin in universe}
    df_hedged_1 = beta_hedged_daily([tranche], five_min, settlements=None, betas=betas_1, universe=universe)
    assert len(df_hedged_1) == 1
    row_1 = df_hedged_1.loc[day_0]

    assert abs(row_1["gross_hedged"]) < 1e-12
    assert row_1["costs"] > 0.0
    assert row_1["funding"] == 0.0
    assert np.isclose(row_1["drift_free"], -row_1["costs"], rtol=1e-12, atol=1e-12)
    assert row_1["n_open"] == 1
    assert row_1["ew_coins_min"] == len(universe)
    assert row_1["excluded_tranches"] == 0

    # 2. At beta 0
    betas_0 = {coin: 0.0 for coin in universe}
    df_hedged_0 = beta_hedged_daily([tranche], five_min, settlements=None, betas=betas_0, universe=universe)
    df_raw = daily_book([tranche], five_min, settlements=None)

    row_0 = df_hedged_0.loc[day_0]
    row_raw = df_raw.loc[day_0]

    assert np.isclose(row_0["drift_free"], row_raw["net"], rtol=1e-12, atol=1e-12)
    assert np.isclose(row_0["gross_hedged"], row_raw["gross"], rtol=1e-12, atol=1e-12)
    assert np.isclose(row_0["costs"], row_raw["costs"], rtol=1e-12, atol=1e-12)
    assert np.isclose(row_0["funding"], row_raw["funding"], rtol=1e-12, atol=1e-12)


def test_beta_hedged_mid_day_r_ew() -> None:
    """3. A tranche opened mid-day: r_EW is measured over [entry, next 00:00] only,

    not the whole day. Check it against a hand computation with distinct coin paths.
    """
    day_0 = 1700006400000
    day_1 = day_0 + DAY_MS
    entry_ms = day_0 + 12 * 3_600_000
    exit_ms = day_1 + 4 * 3_600_000

    universe = ["BTCUSDT", "ETHUSDT"]
    five_min = {
        "BTCUSDT": pd.DataFrame(
            {
                "t": [day_0, entry_ms, day_1, exit_ms],
                "o": [100.0, 120.0, 150.0, 160.0],
            }
        ),
        "ETHUSDT": pd.DataFrame(
            {
                "t": [day_0, entry_ms, day_1, exit_ms],
                "o": [200.0, 180.0, 216.0, 220.0],
            }
        ),
    }

    tranche = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=120.0,
        exit_price=160.0,
        interval="1h",
        h_ms=2 * 3_600_000,
        size=1.0,
    )

    r_btc_in_day = float(np.log(150.0 / 120.0))
    r_eth_in_day = float(np.log(216.0 / 180.0))
    expected_r_ew = float(np.mean([r_btc_in_day, r_eth_in_day]))

    r_btc_whole_day = float(np.log(150.0 / 100.0))
    r_eth_whole_day = float(np.log(216.0 / 200.0))
    whole_day_r_ew = float(np.mean([r_btc_whole_day, r_eth_whole_day]))
    assert not np.isclose(expected_r_ew, whole_day_r_ew)

    beta = 1.2
    betas = {"BTCUSDT": beta, "ETHUSDT": 1.0}
    df_res = beta_hedged_daily([tranche], five_min, settlements=None, betas=betas, universe=universe)

    w = tranche.weight
    expected_gross_d0 = w * (r_btc_in_day - beta * expected_r_ew)
    assert np.isclose(df_res.loc[day_0, "gross_hedged"], expected_gross_d0, rtol=1e-12, atol=1e-12)
    assert not np.isclose(df_res.loc[day_0, "gross_hedged"], w * (r_btc_in_day - beta * whole_day_r_ew))


def test_beta_hedged_spanning_midnight_telescoping() -> None:
    """4. A tranche spanning midnight: both days are hedged over their own parts,

    and the sum over the two days of w x (r_coin - beta x r_EW) equals the hand
    computation over the whole hold.
    """
    day_1 = 1700006400000
    day_2 = day_1 + DAY_MS
    day_3 = day_2 + DAY_MS

    entry_ms = day_1 + 18 * 3_600_000
    exit_ms = day_2 + 6 * 3_600_000

    universe = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    five_min = {
        "BTCUSDT": pd.DataFrame(
            {
                "t": [day_1, entry_ms, day_2, exit_ms, day_3],
                "o": [95.0, 100.0, 108.0, 115.0, 120.0],
            }
        ),
        "ETHUSDT": pd.DataFrame(
            {
                "t": [day_1, entry_ms, day_2, exit_ms, day_3],
                "o": [45.0, 50.0, 48.0, 55.0, 60.0],
            }
        ),
        "SOLUSDT": pd.DataFrame(
            {
                "t": [day_1, entry_ms, day_2, exit_ms, day_3],
                "o": [18.0, 20.0, 22.0, 21.0, 25.0],
            }
        ),
    }

    tranche = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=100.0,
        exit_price=115.0,
        interval="1h",
        h_ms=12 * 3_600_000,
        size=1.0,
    )

    beta = 0.8
    betas = {"BTCUSDT": beta, "ETHUSDT": 1.0, "SOLUSDT": 1.0}
    df_res = beta_hedged_daily([tranche], five_min, settlements=None, betas=betas, universe=universe)

    assert len(df_res) == 2
    assert list(df_res.index) == [day_1, day_2]

    gross_1 = df_res.loc[day_1, "gross_hedged"]
    gross_2 = df_res.loc[day_2, "gross_hedged"]
    total_gross = gross_1 + gross_2

    w = tranche.weight
    r_btc_whole = float(np.log(115.0 / 100.0))
    r_eth_whole = float(np.log(55.0 / 50.0))
    r_sol_whole = float(np.log(21.0 / 20.0))
    r_ew_whole = float(np.mean([r_btc_whole, r_eth_whole, r_sol_whole]))
    expected_whole = w * (r_btc_whole - beta * r_ew_whole)

    assert np.isclose(total_gross, expected_whole, rtol=1e-12, atol=1e-12)


def test_estimate_betas_planted_and_nan() -> None:
    """5. estimate_betas recovers a planted beta (a coin constructed as 1.5 x the market

    plus noise, 200 days) within 0.05. It gives NaN with fewer than 60 valid days.
    """
    rng = np.random.default_rng(42)
    n_days = 200
    day_0 = 1700006400000
    days = [day_0 + i * DAY_MS for i in range(n_days)]

    m = rng.normal(0.0005, 0.02, size=n_days)

    data: dict[str, np.ndarray] = {}
    planted_beta = 1.5
    noise = rng.normal(0.0, 0.001, size=n_days)
    data["PLANTED"] = planted_beta * m + noise

    # To make row mean of the 10 coins equal m, the other 9 coins average (8.5 * m - noise) / 9
    other_base = (8.5 * m - noise) / 9.0
    for i in range(9):
        data[f"COIN_{i}"] = other_base + rng.normal(0.0, 0.0005, size=n_days)

    df_returns = pd.DataFrame(data, index=days)

    betas_full = estimate_betas(df_returns, start_ms=days[0], end_ms=days[-1] + DAY_MS)
    est_beta = betas_full["PLANTED"]
    assert abs(est_beta - planted_beta) < 0.05

    # Short window: exactly 59 days (< 60) gives NaN
    df_short = df_returns.iloc[:59]
    betas_short = estimate_betas(df_short, start_ms=days[0], end_ms=days[59])
    assert np.isnan(betas_short["PLANTED"])

    # Exactly 60 days gives valid beta
    df_60 = df_returns.iloc[:60]
    betas_60 = estimate_betas(df_60, start_ms=days[0], end_ms=days[60])
    assert not np.isnan(betas_60["PLANTED"])
    assert abs(betas_60["PLANTED"] - planted_beta) < 0.05


def test_daily_series_reindexing_and_flags() -> None:
    """6. daily_series zero-fills no-bet days and flags them, and the length equals

    the number of UTC days in the span.
    """
    day_0 = 1700006400000
    span_len = 10
    span_start = day_0
    span_end = day_0 + span_len * DAY_MS

    day_2 = day_0 + 2 * DAY_MS
    day_6 = day_0 + 6 * DAY_MS
    df_book = pd.DataFrame(
        {
            "drift_free": [0.0125, -0.0084],
            "n_open": [1, 2],
        },
        index=[day_2, day_6],
    )
    df_book.index.name = "day_start"

    res = daily_series(df_book, "drift_free", span_start, span_end)

    assert len(res) == span_len
    assert list(res.columns) == ["drift_free", "bet"]

    for d in range(span_start, span_end, DAY_MS):
        if d in (day_2, day_6):
            assert bool(res.loc[d, "bet"]) is True
            assert np.isclose(res.loc[d, "drift_free"], df_book.loc[d, "drift_free"], rtol=1e-12)
        else:
            assert bool(res.loc[d, "bet"]) is False
            assert res.loc[d, "drift_free"] == 0.0


def test_weights_use_configured_h_even_if_early_exit() -> None:
    """7. Weights use the configured h even when the tranche's exit_ms is earlier

    than entry_ms + h_ms.
    """
    day_0 = 1700006400000
    entry_ms = day_0 + 3_600_000
    h_ms = 8 * 3_600_000
    exit_ms = entry_ms + 2 * 3_600_000

    tranche = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=100.0,
        exit_price=102.0,
        interval="1h",
        h_ms=h_ms,
        size=1.0,
        entry_fill="taker",
        exit_fill="taker",
    )

    expected_w = 1.0 / 8.0 / 10.0
    assert tranche.weight == expected_w

    universe = ["BTCUSDT"]
    five_min = {
        "BTCUSDT": pd.DataFrame(
            {
                "t": [day_0, entry_ms, exit_ms, day_0 + DAY_MS],
                "o": [100.0, 100.0, 102.0, 103.0],
            }
        )
    }

    betas = {"BTCUSDT": 0.0}
    res = beta_hedged_daily([tranche], five_min, settlements=None, betas=betas, universe=universe)

    expected_gross = expected_w * float(np.log(102.0 / 100.0))
    expected_costs = abs(expected_w) * 2.0 * (0.0005 + 0.0003)
    assert np.isclose(res.loc[day_0, "gross_hedged"], expected_gross, rtol=1e-12, atol=1e-12)
    assert np.isclose(res.loc[day_0, "costs"], expected_costs, rtol=1e-12, atol=1e-12)


def test_daily_close_log_returns() -> None:
    """Check daily_close_log_returns computes log(next 00:00 / 00:00) and handles NaNs."""
    day_0 = 1700006400000
    day_1 = day_0 + DAY_MS
    day_2 = day_1 + DAY_MS

    five_min = {
        "BTCUSDT": pd.DataFrame(
            {
                "t": [day_0, day_1, day_2],
                "o": [100.0, 110.0, 121.0],
            }
        ),
        "ETHUSDT": pd.DataFrame(
            {
                "t": [day_0, day_1],
                "o": [10.0, 12.0],
            }
        ),
    }

    universe = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    df_ret = daily_close_log_returns(five_min, [day_0, day_1], universe)

    assert len(df_ret) == 2
    assert list(df_ret.columns) == universe

    assert np.isclose(df_ret.loc[day_0, "BTCUSDT"], float(np.log(110.0 / 100.0)), rtol=1e-12)
    assert np.isclose(df_ret.loc[day_0, "ETHUSDT"], float(np.log(12.0 / 10.0)), rtol=1e-12)
    assert np.isnan(df_ret.loc[day_0, "SOLUSDT"])

    assert np.isclose(df_ret.loc[day_1, "BTCUSDT"], float(np.log(121.0 / 110.0)), rtol=1e-12)
    assert np.isnan(df_ret.loc[day_1, "ETHUSDT"])
    assert np.isnan(df_ret.loc[day_1, "SOLUSDT"])


def test_beta_hedged_excluded_tranches_nan_beta() -> None:
    """Check that tranches with NaN beta are excluded and counted."""
    day_0 = 1700006400000
    tranche_valid = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=day_0 + 3_600_000,
        exit_ms=day_0 + 6 * 3_600_000,
        entry_price=100.0,
        exit_price=102.0,
        interval="1h",
        h_ms=3 * 3_600_000,
    )
    tranche_nan = Tranche(
        symbol="NEWUSDT",
        side=1,
        entry_ms=day_0 + 3_600_000,
        exit_ms=day_0 + 6 * 3_600_000,
        entry_price=10.0,
        exit_price=12.0,
        interval="1h",
        h_ms=3 * 3_600_000,
    )

    five_min = {
        "BTCUSDT": pd.DataFrame(
            {
                "t": [day_0, day_0 + 3_600_000, day_0 + 6 * 3_600_000, day_0 + DAY_MS],
                "o": [100.0, 100.0, 102.0, 102.0],
            }
        ),
        "NEWUSDT": pd.DataFrame(
            {
                "t": [day_0, day_0 + 3_600_000, day_0 + 6 * 3_600_000, day_0 + DAY_MS],
                "o": [10.0, 10.0, 12.0, 12.0],
            }
        ),
    }
    betas = {"BTCUSDT": 1.0, "NEWUSDT": float("nan")}
    res = beta_hedged_daily(
        [tranche_valid, tranche_nan], five_min, settlements=None, betas=betas, universe=["BTCUSDT", "NEWUSDT"]
    )

    assert len(res) == 1
    assert res.loc[day_0, "n_open"] == 1
    assert res.loc[day_0, "excluded_tranches"] == 1


def test_estimate_betas_other_coins_threshold() -> None:
    """Only days where the coin and at least 5 other coins are present count."""
    rng = np.random.default_rng(123)
    n_days = 65
    day_0 = 1700006400000
    days = [day_0 + i * DAY_MS for i in range(n_days)]

    # 10 coins total
    coins = ["COIN_A"] + [f"OTHER_{i}" for i in range(9)]
    df = pd.DataFrame(index=days, columns=coins, dtype=float)

    for c in coins:
        df[c] = rng.normal(0, 0.01, size=n_days)

    # For the first 10 days, keep only 4 other coins (total 5 coins present with COIN_A)
    # 5 other coins are set to NaN for days 0..9
    for i in range(4, 9):
        df.iloc[:10, df.columns.get_loc(f"OTHER_{i}")] = np.nan

    # Now on days 0..9, COIN_A has only 4 other coins present (< 5 other coins)
    # So valid days for COIN_A is 65 - 10 = 55 days (< 60)
    betas = estimate_betas(df, start_ms=days[0], end_ms=days[-1] + DAY_MS)
    assert np.isnan(betas["COIN_A"])

    # If we instead keep 5 other coins (OTHER_0..OTHER_4) and set only 4 coins to NaN (OTHER_5..OTHER_8):
    for i in range(10):
        df.iloc[i, df.columns.get_loc("OTHER_4")] = rng.normal(0, 0.01)

    # Now on days 0..9, COIN_A has 5 other coins present (>= 5 other coins)
    # Valid days = 65 (>= 60)
    betas_valid = estimate_betas(df, start_ms=days[0], end_ms=days[-1] + DAY_MS)
    assert not np.isnan(betas_valid["COIN_A"])


def test_beta_hedged_with_funding() -> None:
    """Beta-hedged daily incorporates funding settlements inside tranche hold."""
    day_0 = 1700006400000
    entry_ms = day_0 + 2 * 3_600_000
    exit_ms = day_0 + 10 * 3_600_000
    settle_ms = day_0 + 8 * 3_600_000
    rate = 0.0002

    tranche = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=100.0,
        exit_price=100.0,
        interval="1h",
        h_ms=8 * 3_600_000,
    )

    five_min = {
        "BTCUSDT": pd.DataFrame(
            {
                "t": [day_0, entry_ms, exit_ms, day_0 + DAY_MS],
                "o": [100.0, 100.0, 100.0, 100.0],
            }
        )
    }
    settlements = [(settle_ms, rate)]
    betas = {"BTCUSDT": 1.0}
    res = beta_hedged_daily([tranche], five_min, settlements=settlements, betas=betas, universe=["BTCUSDT"])

    w = tranche.weight
    expected_funding = -w * rate
    assert np.isclose(res.loc[day_0, "funding"], expected_funding, rtol=1e-12, atol=1e-12)
    assert np.isclose(
        res.loc[day_0, "drift_free"],
        res.loc[day_0, "gross_hedged"] - res.loc[day_0, "costs"] + expected_funding,
        rtol=1e-12,
        atol=1e-12,
    )


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


def _scalar_daily_reference(tranches, prices, settlements, betas=None, universe=()):
    """Independent scalar oracle for the standard 1h fee profile used below."""
    import math

    raw_columns = [
        "gross",
        "costs",
        "fees",
        "slippage",
        "funding",
        "net",
        "net_weight_start",
        "n_open",
        "substitutions",
    ]
    hedged_columns = [
        "drift_free",
        "gross_hedged",
        "costs",
        "fees",
        "slippage",
        "funding",
        "n_open",
        "ew_coins_min",
        "excluded_tranches",
    ]
    quotes = {s: dict(zip(df["t"], df["o"], strict=True)) for s, df in prices.items()}

    def carry(symbol, stamp):
        return quotes[symbol][max(t for t in quotes[symbol] if t <= stamp)]

    first = min(t.entry_ms for t in tranches) // DAY_MS * DAY_MS
    last = max(t.exit_ms for t in tranches)
    rows, days = [], []
    for day in range(first, last, DAY_MS):
        active = [t for t in tranches if t.entry_ms < day + DAY_MS and t.exit_ms > day]
        if not active:
            continue
        gross = fees = slip = funding = net_weight = 0.0
        substitutions, counts = set(), []
        opened = excluded = 0
        for t in active:
            if betas is not None and math.isnan(betas[t.symbol]):
                excluded += 1
                continue
            opened += 1
            weight = t.side * t.size * 3_600_000 / t.h_ms / 10
            start, end = max(day, t.entry_ms), min(day + DAY_MS, t.exit_ms)
            if t.entry_ms < day < t.exit_ms:
                net_weight += weight
            if betas is None:
                p0 = t.entry_price if start == t.entry_ms else carry(t.symbol, start)
                p1 = t.exit_price if end == t.exit_ms else carry(t.symbol, end)
                for stamp in (start, end):
                    if stamp not in (t.entry_ms, t.exit_ms) and stamp not in quotes[t.symbol]:
                        substitutions.add((t.symbol, stamp))
            else:
                p0 = quotes[t.symbol].get(start)
                p1 = quotes[t.symbol].get(end)
                if p0 is None:
                    p0 = t.entry_price if start == t.entry_ms else carry(t.symbol, start)
                if p1 is None:
                    p1 = t.exit_price if end == t.exit_ms else carry(t.symbol, end)
            ret = math.log(p1 / p0)
            if betas is not None:
                basket = [
                    math.log(quotes[s][end] / quotes[s][start])
                    for s in universe
                    if start in quotes.get(s, {})
                    and end in quotes.get(s, {})
                    and quotes[s][start] > 0
                    and quotes[s][end] > 0
                ]
                counts.append(len(basket))
                ret -= betas[t.symbol] * (sum(basket) / len(basket) if basket else 0.0)
            gross += weight * ret
            fills = []
            if day <= t.entry_ms < day + DAY_MS:
                fills.append(t.entry_fill)
            if day < t.exit_ms <= day + DAY_MS:
                fills.append(t.exit_fill)
            for fill in fills:
                fees += abs(weight) * (0.0002 if fill == "maker" else 0.0005)
                slip += abs(weight) * (0.0003 if fill == "taker" else 0)
            for stamp, rate in sorted(settlements[t.symbol]):
                if start < stamp <= end:
                    funding += -weight * rate
        costs = fees + slip
        net = gross - costs + funding
        if betas is None:
            rows.append([gross, costs, fees, slip, funding, net, net_weight, opened, len(substitutions)])
        else:
            rows.append([net, gross, costs, fees, slip, funding, opened, min(counts, default=0), excluded])
        days.append(day)
    return pd.DataFrame(
        rows, index=pd.Index(days, name="day_start"), columns=raw_columns if betas is None else hedged_columns
    )


def _runtime_parity_case():
    hour = 3_600_000
    tranches = [
        Tranche("ETHUSDT", -1, 23 * hour, DAY_MS + 3 * hour, 110, 106, "1h", 8 * hour, size=0.7, entry_fill="maker"),
        Tranche("BTCUSDT", 1, 22 * hour, 2 * DAY_MS, 102, 118, "1h", 48 * hour, exit_fill="maker"),
        Tranche("SOLUSDT", -1, hour, DAY_MS + 2 * hour, 90, 95, "1h", 32 * hour),
        Tranche("BTCUSDT", -1, 22 * hour, DAY_MS + 3 * hour, 103, 111, "1h", 12 * hour),
        Tranche("ETHUSDT", 1, 22 * hour, DAY_MS + 3 * hour, 109, 107, "1h", 8 * hour),
    ]
    stamps = [0, hour, 22 * hour, 23 * hour, DAY_MS - 300_000, DAY_MS, DAY_MS + 2 * hour, DAY_MS + 3 * hour, 2 * DAY_MS]
    prices = {}
    for i, symbol in enumerate(("BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT")):
        rows = [
            (stamp, 100 + i * 7 + j * 1.3)
            for j, stamp in enumerate(stamps)
            if not (symbol == "BTCUSDT" and stamp == DAY_MS)
            and not (symbol == "BNBUSDT" and stamp == DAY_MS + 3 * hour)
        ]
        prices[symbol] = pd.DataFrame(rows[::-1], columns=["t", "o"])
    settlements = {
        s: [(2 * DAY_MS, 0.0003), (22 * hour, 0.0009), (DAY_MS, -0.0002), (DAY_MS + 3 * hour, 0.0004), (DAY_MS, 0.0001)]
        for s in prices
    }
    betas = {"BTCUSDT": 1.2, "ETHUSDT": -0.3, "SOLUSDT": np.nan}
    return tranches, prices, settlements, betas, list(prices) + ["ABSENT"]


def test_daily_runtime_scalar_parity():
    tranches, prices, settlements, _, _ = _runtime_parity_case()
    expected = _scalar_daily_reference(tranches, prices, settlements)
    actual = daily_book(tranches, prices, settlements)
    pd.testing.assert_frame_equal(actual, expected, rtol=1e-12, atol=1e-12)
    pd.testing.assert_frame_equal(
        actual[["n_open", "substitutions"]], expected[["n_open", "substitutions"]], check_exact=True
    )


def test_hedged_runtime_scalar_parity():
    tranches, prices, settlements, betas, universe = _runtime_parity_case()
    expected = _scalar_daily_reference(tranches, prices, settlements, betas, universe)
    actual = beta_hedged_daily(tranches, prices, settlements, betas, universe)
    pd.testing.assert_frame_equal(actual, expected, rtol=1e-12, atol=1e-12)
    counters = ["n_open", "ew_coins_min", "excluded_tranches"]
    pd.testing.assert_frame_equal(actual[counters], expected[counters], check_exact=True)


def test_active_day_membership_scales_with_intersections():
    class CountedTranche(Tranche):
        entry_reads = 0

        def __getattribute__(self, name):
            if name == "entry_ms":
                type(self).entry_reads += 1
            return super().__getattribute__(name)

    n_days = 40
    tranches = [
        CountedTranche("BTCUSDT", 1, d * DAY_MS + 3_600_000, d * DAY_MS + 7_200_000, 100, 101, "1h", 14_400_000)
        for d in range(n_days)
    ]
    prices = {"BTCUSDT": pd.DataFrame({"t": [0], "o": [100.0]})}
    for hedged in (False, True):
        CountedTranche.entry_reads = 0
        if hedged:
            result = beta_hedged_daily(tranches, prices, None, {"BTCUSDT": 1.0}, ["BTCUSDT"])
        else:
            result = daily_book(tranches, prices, None)
        assert len(result) == n_days
        assert CountedTranche.entry_reads < 15 * n_days


def test_coincident_hedges_reuse_basket_lookups(monkeypatch):
    from r4.book import FiveMinLookup

    original = FiveMinLookup.get_exact_open
    basket_reads = []

    def counted(self, symbol, stamp):
        if symbol == "ETHUSDT":
            basket_reads.append(stamp)
        return original(self, symbol, stamp)

    monkeypatch.setattr(FiveMinLookup, "get_exact_open", counted)
    tranches = [Tranche("BTCUSDT", 1, 3_600_000, 7_200_000, 100, 101, "1h", 14_400_000)] * 20
    prices = {s: pd.DataFrame({"t": [3_600_000, 7_200_000], "o": [100.0, 101.0]}) for s in ("BTCUSDT", "ETHUSDT")}
    result = beta_hedged_daily(tranches, prices, None, {"BTCUSDT": 1.0}, list(prices))
    assert result.loc[0, "n_open"] == 20
    assert basket_reads == [3_600_000, 7_200_000]
    prices["ETHUSDT"].loc[1, "o"] = 120.0
    updated = beta_hedged_daily(tranches, prices, None, {"BTCUSDT": 1.0}, list(prices))
    assert updated.loc[0, "gross_hedged"] != result.loc[0, "gross_hedged"]


def test_monotonic_price_lookup_avoids_sorting(monkeypatch):
    from r4.book import FiveMinLookup

    original = np.argsort
    sorted_lengths = []

    def counted(values, *args, **kwargs):
        sorted_lengths.append(len(values))
        return original(values, *args, **kwargs)

    monkeypatch.setattr(np, "argsort", counted)
    lookup = FiveMinLookup(
        {
            "SORTED": pd.DataFrame({"t": [0, 1, 2], "o": [100.0, 101.0, 102.0]}),
            "UNSORTED": pd.DataFrame({"t": [2, 0, 1], "o": [102.0, 100.0, 101.0]}),
        }
    )
    assert lookup.get_exact_open("SORTED", 1) == 101.0
    assert lookup.get_open_or_carry("UNSORTED", 3) == (102.0, True)
    assert sorted_lengths == [3]
