"""Tests for r4.labels: fixed-horizon, triple-barrier, and average uniqueness."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from r4.costs import trade_net_return
from r4.labels import average_uniqueness, fixed_horizon, triple_barrier


def _build_5m_path(
    bars_data: list[tuple[int, float, float, float, float]],
) -> pd.DataFrame:
    """Helper to build a DataFrame of 5m bars with columns t, o, h, l, c."""
    return pd.DataFrame(bars_data, columns=["t", "o", "h", "l", "c"])


def test_fixed_horizon_hand_computation_and_missing_bars() -> None:
    """Requirement 1: fixed_horizon execution timing, net math, and missing bar handling."""
    t_decision = 1_000_000_000
    delay_ms = 600_000
    h_ms = 3_600_000
    t_entry = t_decision + delay_ms
    t_exit = t_decision + delay_ms + h_ms

    bars = _build_5m_path(
        [
            (t_decision, 95.0, 96.0, 94.0, 95.5),
            (t_decision + 300_000, 95.5, 96.5, 95.0, 96.0),
            (t_entry, 100.0, 102.0, 99.0, 101.0),
            (t_entry + 300_000, 101.0, 103.0, 100.5, 102.0),
            (t_exit - 300_000, 108.0, 109.0, 107.0, 108.5),
            (t_exit, 110.0, 111.0, 109.5, 110.5),
        ]
    )

    # Funding settlement inside (t_entry, t_exit]
    settlements = pd.DataFrame(
        {
            "t": [t_entry - 100, t_entry + 1_800_000, t_exit + 100],
            "rate": [0.005, 0.001, 0.005],
        }
    )

    # Long trade (+1)
    df_long = fixed_horizon(
        decision_times=[t_decision],
        five_min=bars,
        h_ms=h_ms,
        side=1,
        interval="1h",
        settlements=settlements,
        delay_ms=delay_ms,
    )
    assert len(df_long) == 1
    row_long = df_long.loc[t_decision]
    assert row_long["t0"] == t_decision
    assert row_long["t1"] == t_exit
    assert row_long["entry"] == 100.0
    assert row_long["exit"] == 110.0
    assert row_long["gross"] == pytest.approx(0.10)
    assert row_long["funding"] == pytest.approx(0.001)

    expected_net_long = trade_net_return(
        side=1,
        entry_price=100.0,
        exit_price=110.0,
        funding_sum=0.001,
        interval="1h",
        entry_fill="taker",
        exit_fill="taker",
    )
    # Hand calculation: gross(0.10) - funding(0.001) - 2*0.0005(fees) - 2*0.0003(slippage) = 0.0974
    assert expected_net_long == pytest.approx(0.0974)
    assert row_long["net"] == pytest.approx(0.0974)

    # Short trade (-1)
    df_short = fixed_horizon(
        decision_times=[t_decision],
        five_min=bars,
        h_ms=h_ms,
        side=-1,
        interval="1h",
        settlements=settlements,
        delay_ms=delay_ms,
    )
    row_short = df_short.loc[t_decision]
    assert row_short["t0"] == t_decision
    assert row_short["t1"] == t_exit
    assert row_short["entry"] == 100.0
    assert row_short["exit"] == 110.0
    assert row_short["gross"] == pytest.approx(-0.10)
    assert row_short["funding"] == pytest.approx(0.001)

    expected_net_short = trade_net_return(
        side=-1,
        entry_price=100.0,
        exit_price=110.0,
        funding_sum=0.001,
        interval="1h",
        entry_fill="taker",
        exit_fill="taker",
    )
    # Hand calculation: gross(-0.10) - (-1 * 0.001) - 2*0.0005 - 2*0.0003 = -0.10 + 0.001 - 0.0016 = -0.1006
    assert expected_net_short == pytest.approx(-0.1006)
    assert row_short["net"] == pytest.approx(-0.1006)

    # Missing entry bar gives NaN label, t1 remains correct
    bars_no_entry = bars[bars["t"] != t_entry]
    df_missing_entry = fixed_horizon([t_decision], bars_no_entry, h_ms=h_ms, side=1, interval="1h")
    assert np.isnan(df_missing_entry.loc[t_decision, "net"])
    assert np.isnan(df_missing_entry.loc[t_decision, "gross"])
    assert df_missing_entry.loc[t_decision, "t1"] == t_exit

    # Missing exit bar gives NaN label, t1 remains correct
    bars_no_exit = bars[bars["t"] != t_exit]
    df_missing_exit = fixed_horizon([t_decision], bars_no_exit, h_ms=h_ms, side=1, interval="1h")
    assert np.isnan(df_missing_exit.loc[t_decision, "net"])
    assert np.isnan(df_missing_exit.loc[t_decision, "gross"])
    assert df_missing_exit.loc[t_decision, "t1"] == t_exit


def test_triple_barrier_long_and_short_cases() -> None:
    """Requirement 2: Triple-barrier for long and short across all barrier touch scenarios."""
    t_decision = 1_000_000_000
    delay_ms = 600_000
    h_ms = 1_200_000  # 4 bars: 0, 1, 2, 3
    t_entry = t_decision + delay_ms
    t_horizon = t_decision + delay_ms + h_ms

    entry_price = 100.0
    sigma_h = 0.02
    k_up = 1.0
    k_down = 1.0
    upper_price = entry_price * np.exp(k_up * sigma_h)  # ~102.020134
    lower_price = entry_price * np.exp(-k_down * sigma_h)  # ~98.019867

    # Case A: Long - Take-profit first
    bars_tp_long = _build_5m_path(
        [
            (t_entry, 100.0, 101.0, 99.5, 100.5),
            (t_entry + 300_000, 100.5, 103.0, 99.0, 102.5),  # hits upper (103.0 >= 102.02), low 99.0 > lower
            (t_entry + 600_000, 102.5, 102.5, 102.0, 102.0),
            (t_entry + 900_000, 102.0, 102.0, 101.5, 101.5),
            (t_horizon, 101.5, 101.5, 101.0, 101.0),
        ]
    )
    res_tp_l = triple_barrier([t_decision], bars_tp_long, h_ms, sigma_h, k_up, k_down, side=1, interval="1h")
    row = res_tp_l.loc[t_decision]
    assert row["label"] == 1.0
    assert row["exit"] == pytest.approx(upper_price)
    assert row["ambiguous"] is False or row["ambiguous"] == False  # noqa: E712
    expected_net = trade_net_return(
        side=1,
        entry_price=entry_price,
        exit_price=upper_price,
        funding_sum=0.0,
        interval="1h",
        entry_fill="taker",
        exit_fill="maker",
    )
    assert row["net"] == pytest.approx(expected_net)

    # Case B: Long - Stop first
    bars_sl_long = _build_5m_path(
        [
            (t_entry, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 300_000, 100.0, 100.5, 97.0, 97.5),  # hits lower (97.0 <= 98.02), high 100.5 < upper
            (t_entry + 600_000, 97.5, 98.0, 97.0, 97.5),
            (t_entry + 900_000, 97.5, 98.0, 97.0, 97.5),
            (t_horizon, 97.5, 98.0, 97.0, 97.5),
        ]
    )
    res_sl_l = triple_barrier([t_decision], bars_sl_long, h_ms, sigma_h, k_up, k_down, side=1, interval="1h")
    row = res_sl_l.loc[t_decision]
    assert row["label"] == -1.0
    assert row["exit"] == pytest.approx(lower_price)
    assert row["ambiguous"] is False or row["ambiguous"] == False  # noqa: E712
    expected_net = trade_net_return(
        side=1,
        entry_price=entry_price,
        exit_price=lower_price,
        funding_sum=0.0,
        interval="1h",
        entry_fill="taker",
        exit_fill="taker",
    )
    assert row["net"] == pytest.approx(expected_net)

    # Case C: Long - Neither hit (horizon exit)
    horizon_open = 100.5
    bars_neither = _build_5m_path(
        [
            (t_entry, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 300_000, 100.0, 101.0, 99.0, 100.0),
            (t_entry + 600_000, 100.0, 101.0, 99.0, 100.0),
            (t_entry + 900_000, 100.0, 101.0, 99.0, 100.0),
            (t_horizon, horizon_open, 101.0, 99.5, 100.5),
        ]
    )
    res_neither_l = triple_barrier([t_decision], bars_neither, h_ms, sigma_h, k_up, k_down, side=1, interval="1h")
    row = res_neither_l.loc[t_decision]
    assert row["label"] == 0.0
    assert row["exit"] == horizon_open
    assert row["ambiguous"] is False or row["ambiguous"] == False  # noqa: E712
    expected_net = trade_net_return(
        side=1,
        entry_price=entry_price,
        exit_price=horizon_open,
        funding_sum=0.0,
        interval="1h",
        entry_fill="taker",
        exit_fill="taker",
    )
    assert row["net"] == pytest.approx(expected_net)

    # Case D: Long - Both in one bar (ambiguous, books stop)
    bars_both = _build_5m_path(
        [
            (t_entry, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 300_000, 100.0, 103.0, 97.0, 100.0),  # reaches upper and lower
            (t_entry + 600_000, 100.0, 101.0, 99.0, 100.0),
            (t_entry + 900_000, 100.0, 101.0, 99.0, 100.0),
            (t_horizon, 100.0, 101.0, 99.0, 100.0),
        ]
    )
    res_both_l = triple_barrier([t_decision], bars_both, h_ms, sigma_h, k_up, k_down, side=1, interval="1h")
    row = res_both_l.loc[t_decision]
    assert row["label"] == -1.0
    assert row["exit"] == pytest.approx(lower_price)
    assert bool(row["ambiguous"]) is True

    # Same 4 cases for Short (side = -1) with barriers swapped

    # Case A: Short - Take-profit first (lower barrier reached first)
    res_tp_s = triple_barrier([t_decision], bars_sl_long, h_ms, sigma_h, k_up, k_down, side=-1, interval="1h")
    row = res_tp_s.loc[t_decision]
    assert row["label"] == 1.0
    assert row["exit"] == pytest.approx(lower_price)
    assert row["ambiguous"] is False or row["ambiguous"] == False  # noqa: E712
    expected_net = trade_net_return(
        side=-1,
        entry_price=entry_price,
        exit_price=lower_price,
        funding_sum=0.0,
        interval="1h",
        entry_fill="taker",
        exit_fill="maker",
    )
    assert row["net"] == pytest.approx(expected_net)

    # Case B: Short - Stop first (upper barrier reached first)
    res_sl_s = triple_barrier([t_decision], bars_tp_long, h_ms, sigma_h, k_up, k_down, side=-1, interval="1h")
    row = res_sl_s.loc[t_decision]
    assert row["label"] == -1.0
    assert row["exit"] == pytest.approx(upper_price)
    assert row["ambiguous"] is False or row["ambiguous"] == False  # noqa: E712
    expected_net = trade_net_return(
        side=-1,
        entry_price=entry_price,
        exit_price=upper_price,
        funding_sum=0.0,
        interval="1h",
        entry_fill="taker",
        exit_fill="taker",
    )
    assert row["net"] == pytest.approx(expected_net)

    # Case C: Short - Neither hit
    res_neither_s = triple_barrier([t_decision], bars_neither, h_ms, sigma_h, k_up, k_down, side=-1, interval="1h")
    row = res_neither_s.loc[t_decision]
    assert row["label"] == 0.0
    assert row["exit"] == horizon_open
    assert row["ambiguous"] is False or row["ambiguous"] == False  # noqa: E712
    expected_net = trade_net_return(
        side=-1,
        entry_price=entry_price,
        exit_price=horizon_open,
        funding_sum=0.0,
        interval="1h",
        entry_fill="taker",
        exit_fill="taker",
    )
    assert row["net"] == pytest.approx(expected_net)

    # Case D: Short - Both in one bar (ambiguous, books upper stop)
    res_both_s = triple_barrier([t_decision], bars_both, h_ms, sigma_h, k_up, k_down, side=-1, interval="1h")
    row = res_both_s.loc[t_decision]
    assert row["label"] == -1.0
    assert row["exit"] == pytest.approx(upper_price)
    assert bool(row["ambiguous"]) is True


def test_triple_barrier_timings() -> None:
    """Requirement 3: t1_touch equals deciding bar open + 300000, and t1_max equals horizon time."""
    t_decision = 1_000_000_000
    delay_ms = 600_000
    h_ms = 1_200_000
    t_entry = t_decision + delay_ms
    t_horizon = t_decision + delay_ms + h_ms

    # Deciding bar at index 1 (t = t_entry + 300_000)
    bars_hit_bar1 = _build_5m_path(
        [
            (t_entry, 100.0, 101.0, 99.5, 100.5),
            (t_entry + 300_000, 100.5, 105.0, 100.0, 104.0),  # deciding bar
            (t_entry + 600_000, 104.0, 104.5, 103.5, 104.0),
            (t_entry + 900_000, 104.0, 104.5, 103.5, 104.0),
            (t_horizon, 104.0, 104.5, 103.5, 104.0),
        ]
    )
    res = triple_barrier([t_decision], bars_hit_bar1, h_ms, sigma_h=0.02, k_up=1.0, k_down=1.0, side=1, interval="1h")
    assert res.loc[t_decision, "t1_touch"] == t_entry + 300_000 + 300_000
    assert res.loc[t_decision, "t1_max"] == t_horizon

    # Deciding bar at index 0 (t = t_entry)
    bars_hit_bar0 = _build_5m_path(
        [
            (t_entry, 100.0, 105.0, 99.5, 104.5),  # deciding bar
            (t_entry + 300_000, 104.5, 105.0, 104.0, 104.5),
            (t_entry + 600_000, 104.5, 105.0, 104.0, 104.5),
            (t_entry + 900_000, 104.5, 105.0, 104.0, 104.5),
            (t_horizon, 104.5, 105.0, 104.0, 104.5),
        ]
    )
    res_b0 = triple_barrier(
        [t_decision], bars_hit_bar0, h_ms, sigma_h=0.02, k_up=1.0, k_down=1.0, side=1, interval="1h"
    )
    assert res_b0.loc[t_decision, "t1_touch"] == t_entry + 300_000
    assert res_b0.loc[t_decision, "t1_max"] == t_horizon

    # Horizon exit: t1_touch equals horizon time
    bars_neither = _build_5m_path(
        [
            (t_entry, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 300_000, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 600_000, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 900_000, 100.0, 101.0, 99.5, 100.0),
            (t_horizon, 100.0, 101.0, 99.5, 100.0),
        ]
    )
    res_horizon = triple_barrier(
        [t_decision], bars_neither, h_ms, sigma_h=0.02, k_up=1.0, k_down=1.0, side=1, interval="1h"
    )
    assert res_horizon.loc[t_decision, "t1_touch"] == t_horizon
    assert res_horizon.loc[t_decision, "t1_max"] == t_horizon


def test_nan_sigma_h_gives_nan_row() -> None:
    """Requirement 4: A NaN sigma_h gives a NaN row."""
    t_decision = 1_000_000_000
    delay_ms = 600_000
    h_ms = 1_200_000
    t_entry = t_decision + delay_ms
    t_horizon = t_decision + delay_ms + h_ms

    bars = _build_5m_path(
        [
            (t_entry, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 300_000, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 600_000, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 900_000, 100.0, 101.0, 99.5, 100.0),
            (t_horizon, 100.0, 101.0, 99.5, 100.0),
        ]
    )

    res = triple_barrier([t_decision], bars, h_ms=h_ms, sigma_h=np.nan, k_up=1.0, k_down=1.0, side=1, interval="1h")
    row = res.loc[t_decision]
    assert np.isnan(row["label"])
    assert np.isnan(row["entry"])
    assert np.isnan(row["exit"])
    assert np.isnan(row["gross"])
    assert np.isnan(row["funding"])
    assert np.isnan(row["net"])
    assert np.isnan(row["t1_touch"])
    assert row["t0"] == t_decision
    assert row["t1_max"] == t_horizon
    assert row["ambiguous"] is False or row["ambiguous"] == False  # noqa: E712

    # A missing 5m bar in the window also produces a NaN row
    bars_missing_bar = bars[bars["t"] != (t_entry + 300_000)]
    res_missing = triple_barrier(
        [t_decision], bars_missing_bar, h_ms=h_ms, sigma_h=0.02, k_up=1.0, k_down=1.0, side=1, interval="1h"
    )
    row_m = res_missing.loc[t_decision]
    assert np.isnan(row_m["label"])
    assert np.isnan(row_m["net"])
    assert np.isnan(row_m["t1_touch"])
    assert row_m["t0"] == t_decision
    assert row_m["t1_max"] == t_horizon


def test_average_uniqueness() -> None:
    """Requirement 5: Uniqueness for non-overlapping, identical, and partial-overlap labels."""
    grid_ms = 100

    # Two labels that never overlap both get 1.0
    u_no_overlap = average_uniqueness(t0=[0, 1000], t1=[500, 1500], grid_ms=grid_ms)
    assert np.allclose(u_no_overlap, [1.0, 1.0])

    # Two identical labels both get 0.5
    u_identical = average_uniqueness(t0=[0, 0], t1=[500, 500], grid_ms=grid_ms)
    assert np.allclose(u_identical, [0.5, 0.5])

    # Hand-computed partial overlap:
    # Label 0: [0, 300) -> grid points {0, 100, 200}
    # Label 1: [100, 400) -> grid points {100, 200, 300}
    # Concurrency: c(0)=1, c(100)=2, c(200)=2, c(300)=1
    # Uniqueness Label 0: mean(1/1, 1/2, 1/2) = (1 + 0.5 + 0.5) / 3 = 2/3
    # Uniqueness Label 1: mean(1/2, 1/2, 1/1) = (0.5 + 0.5 + 1) / 3 = 2/3
    u_partial = average_uniqueness(t0=[0, 100], t1=[300, 400], grid_ms=grid_ms)
    assert np.allclose(u_partial, [2.0 / 3.0, 2.0 / 3.0])


def test_causality_leaves_label_unchanged() -> None:
    """Requirement 6: Changing any 5m bar with t < T + delay_ms leaves the label at T unchanged."""
    t_decision = 1_000_000_000
    delay_ms = 600_000
    h_ms = 1_200_000
    t_entry = t_decision + delay_ms
    t_horizon = t_decision + delay_ms + h_ms

    base_bars = [
        # Bars before T + delay_ms
        (t_decision - 600_000, 50.0, 52.0, 49.0, 51.0),
        (t_decision - 300_000, 51.0, 53.0, 50.0, 52.0),
        (t_decision, 52.0, 54.0, 51.0, 53.0),
        (t_decision + 300_000, 53.0, 55.0, 52.0, 54.0),
        # Execution bars starting at T + delay_ms
        (t_entry, 100.0, 101.0, 99.5, 100.5),
        (t_entry + 300_000, 100.5, 103.0, 99.0, 102.5),
        (t_entry + 600_000, 102.5, 102.5, 102.0, 102.0),
        (t_entry + 900_000, 102.0, 102.0, 101.5, 101.5),
        (t_horizon, 101.5, 101.5, 101.0, 101.0),
    ]
    df_bars_original = _build_5m_path(base_bars)

    fixed_orig = fixed_horizon(
        decision_times=[t_decision], five_min=df_bars_original, h_ms=h_ms, side=1, interval="1h", delay_ms=delay_ms
    )
    triple_orig = triple_barrier(
        decision_times=[t_decision],
        five_min=df_bars_original,
        h_ms=h_ms,
        sigma_h=0.02,
        k_up=1.0,
        k_down=1.0,
        side=1,
        interval="1h",
        delay_ms=delay_ms,
    )

    # Mutate all bars before T + delay_ms: change prices drastically
    mutated_bars = [
        (t_decision - 600_000, 9999.0, 10000.0, 9990.0, 9995.0),
        (t_decision - 300_000, 9995.0, 10005.0, 9990.0, 10000.0),
        (t_decision, 10000.0, 10010.0, 9995.0, 10005.0),
        (t_decision + 300_000, 10005.0, 10020.0, 10000.0, 10015.0),
        # Keep execution bars exactly identical
        (t_entry, 100.0, 101.0, 99.5, 100.5),
        (t_entry + 300_000, 100.5, 103.0, 99.0, 102.5),
        (t_entry + 600_000, 102.5, 102.5, 102.0, 102.0),
        (t_entry + 900_000, 102.0, 102.0, 101.5, 101.5),
        (t_horizon, 101.5, 101.5, 101.0, 101.0),
    ]
    df_bars_mutated = _build_5m_path(mutated_bars)

    fixed_mut = fixed_horizon(
        decision_times=[t_decision], five_min=df_bars_mutated, h_ms=h_ms, side=1, interval="1h", delay_ms=delay_ms
    )
    triple_mut = triple_barrier(
        decision_times=[t_decision],
        five_min=df_bars_mutated,
        h_ms=h_ms,
        sigma_h=0.02,
        k_up=1.0,
        k_down=1.0,
        side=1,
        interval="1h",
        delay_ms=delay_ms,
    )

    # Fixed horizon results must be identical
    pd.testing.assert_frame_equal(fixed_orig, fixed_mut)

    # Triple barrier results must be identical
    pd.testing.assert_frame_equal(triple_orig, triple_mut)


def test_edge_cases_and_input_validation() -> None:
    """Test input validation, empty inputs, side string parsing, and sparse uniqueness fallback."""
    # Empty decision times
    empty_df = fixed_horizon([], pd.DataFrame(columns=["t", "o", "h", "l", "c"]), h_ms=3_600_000, side=1, interval="1h")
    assert len(empty_df) == 0
    assert list(empty_df.columns) == ["t0", "t1", "entry", "exit", "gross", "funding", "net"]

    empty_tb = triple_barrier(
        [],
        pd.DataFrame(columns=["t", "o", "h", "l", "c"]),
        h_ms=3_600_000,
        sigma_h=0.02,
        k_up=1.0,
        k_down=1.0,
        side=1,
        interval="1h",
    )
    assert len(empty_tb) == 0
    assert list(empty_tb.columns) == [
        "t0",
        "t1_touch",
        "t1_max",
        "label",
        "entry",
        "exit",
        "gross",
        "funding",
        "net",
        "ambiguous",
    ]

    # Side as string and array
    t_decision = 1_000_000_000
    delay_ms = 600_000
    h_ms = 1_200_000
    t_entry = t_decision + delay_ms
    t_horizon = t_decision + delay_ms + h_ms
    bars = _build_5m_path(
        [
            (t_entry, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 300_000, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 600_000, 100.0, 101.0, 99.5, 100.0),
            (t_entry + 900_000, 100.0, 101.0, 99.5, 100.0),
            (t_horizon, 100.0, 101.0, 99.5, 100.0),
        ]
    )

    df_str_long = fixed_horizon([t_decision], bars, h_ms=h_ms, side="long", interval="1h")
    df_int_long = fixed_horizon([t_decision], bars, h_ms=h_ms, side=1, interval="1h")
    pd.testing.assert_frame_equal(df_str_long, df_int_long)

    df_str_short = fixed_horizon([t_decision], bars, h_ms=h_ms, side="short", interval="1h")
    df_int_short = fixed_horizon([t_decision], bars, h_ms=h_ms, side=-1, interval="1h")
    pd.testing.assert_frame_equal(df_str_short, df_int_short)

    tb_arr_side = triple_barrier(
        [t_decision],
        bars,
        h_ms=h_ms,
        sigma_h=[0.02],
        k_up=1.0,
        k_down=1.0,
        side=["long"],
        interval="1h",
    )
    assert len(tb_arr_side) == 1

    # sigma_h <= 0 gives NaN row
    tb_zero_sigma = triple_barrier(
        [t_decision], bars, h_ms=h_ms, sigma_h=0.0, k_up=1.0, k_down=1.0, side=1, interval="1h"
    )
    assert np.isnan(tb_zero_sigma.loc[t_decision, "label"])

    # Invalid h_ms
    with pytest.raises(ValueError, match="multiple of 300000"):
        triple_barrier([t_decision], bars, h_ms=100_000, sigma_h=0.02, k_up=1.0, k_down=1.0, side=1, interval="1h")

    # Invalid k_up or k_down
    with pytest.raises(ValueError, match="must be positive"):
        triple_barrier([t_decision], bars, h_ms=h_ms, sigma_h=0.02, k_up=-1.0, k_down=1.0, side=1, interval="1h")

    # Invalid delay_ms
    with pytest.raises(ValueError, match="non-negative multiple of 300000"):
        triple_barrier(
            [t_decision],
            bars,
            h_ms=h_ms,
            sigma_h=0.02,
            k_up=1.0,
            k_down=1.0,
            side=1,
            interval="1h",
            delay_ms=100_000,
        )

    # Invalid side
    with pytest.raises(ValueError, match="side must be"):
        fixed_horizon([t_decision], bars, h_ms=h_ms, side=2, interval="1h")

    # Side length mismatch
    with pytest.raises(ValueError, match="does not match decision_times length"):
        fixed_horizon([t_decision], bars, h_ms=h_ms, side=[1, -1], interval="1h")

    # Average uniqueness input validation
    with pytest.raises(ValueError, match="grid_ms must be positive"):
        average_uniqueness([0], [100], grid_ms=0)

    with pytest.raises(ValueError, match="same length"):
        average_uniqueness([0, 100], [100], grid_ms=100)

    with pytest.raises(ValueError, match="t1 must be >= t0"):
        average_uniqueness([100], [50], grid_ms=100)

    # Empty average uniqueness
    empty_u = average_uniqueness([], [], grid_ms=100)
    assert len(empty_u) == 0

    # Zero length intervals (t0 == t1)
    zero_len_u = average_uniqueness([100, 200], [100, 200], grid_ms=100)
    assert np.allclose(zero_len_u, [1.0, 1.0])

    # Sparse average uniqueness fallback (span > 5_000_000)
    huge_t0 = [0, 6_000_000 * 100]
    huge_t1 = [100, 6_000_000 * 100 + 100]
    sparse_u = average_uniqueness(huge_t0, huge_t1, grid_ms=100)
    assert np.allclose(sparse_u, [1.0, 1.0])
