"""Tests for r4.features part A: causal alignment, intrabar features, and causality test."""

from __future__ import annotations

import time
import warnings

import numpy as np
import pandas as pd
import pytest

from r4.causality import assert_future_invariant
from r4.features import (
    FEATURE_COLUMNS,
    bars_inside,
    closed_rows,
    intrabar_features,
    wilder_rsi_15m,
)


def _make_dummy_5m_bar(t: int, o: float = 100.0, c: float = 100.0) -> dict[str, float]:
    return {"t": float(t), "o": o, "h": max(o, c) + 1.0, "l": min(o, c) - 1.0, "c": c, "v": 10.0, "tbv": 5.0}


def _make_dummy_15m_bar(t: int, o: float = 100.0, c: float = 100.0) -> dict[str, float]:
    return {"t": float(t), "o": o, "h": max(o, c) + 1.0, "l": min(o, c) - 1.0, "c": c, "v": 30.0, "tbv": 15.0}


def test_closed_rows_and_bars_inside_boundaries():
    """Requirement 1: closed_rows and bars_inside at exact boundaries.

    A 5m bar opening at T - 300000 is inside and closed, and one opening at T is not.
    """
    T = 3_600_000
    t_b = 0
    interval_ms = 300_000

    # Build 12 bars inside [0, 3600000]: t from 0 to 3300000
    # Plus one bar opening at T (t = 3600000)
    # Plus one bar opening before t_b (t = -300000)
    all_t = [-300_000] + [i * interval_ms for i in range(13)]
    rows = [_make_dummy_5m_bar(t) for t in all_t]
    df = pd.DataFrame(rows)

    # 1. closed_rows test
    closed = closed_rows(df, interval_ms, T)
    closed_t = set(closed["t"].tolist())

    bar_at_T_minus_interval = T - interval_ms  # 3300000
    bar_at_T = T  # 3600000

    assert bar_at_T_minus_interval in closed_t, "Bar opening at T - 300000 must be closed at T"
    assert bar_at_T not in closed_t, "Bar opening at T must not be closed at T"

    # 2. bars_inside test
    # Inside [t_b, T], there should be exactly 12 bars (0 to 3300000)
    inside = bars_inside(df, interval_ms, t_b, T)
    assert inside is not None
    assert len(inside) == 12

    inside_t = set(inside["t"].tolist())
    assert bar_at_T_minus_interval in inside_t, "Bar opening at T - 300000 must be inside [t_b, T]"
    assert bar_at_T not in inside_t, "Bar opening at T must not be inside [t_b, T]"
    assert -300_000 not in inside_t, "Bar opening before t_b must not be inside [t_b, T]"


def test_missing_5m_bar_makes_intrabar_features_nan_for_that_bar_only():
    """Requirement 2: A missing 5m bar makes every intrabar feature NaN for that decision bar only."""
    decision_interval_ms = 3_600_000  # 1h
    t_b1 = 0
    T1 = 3_600_000
    t_b2 = 3_600_000
    T2 = 7_200_000

    # Build 24 5m bars, but omit bar index 4 in decision bar 1
    t_5m = [i * 300_000 for i in range(24) if i != 4]
    df5 = pd.DataFrame([_make_dummy_5m_bar(t) for t in t_5m])

    # Build all 8 15m bars
    t_15m = [i * 900_000 for i in range(8)]
    df15 = pd.DataFrame([_make_dummy_15m_bar(t) for t in t_15m])

    res = intrabar_features(df5, df15, decision_interval_ms, [t_b1, t_b2])

    assert len(res) == 2
    assert list(res.columns) == FEATURE_COLUMNS

    # Bar 1 has missing 5m bar: EVERY feature must be NaN
    row1 = res.loc[T1]
    assert row1.isna().all(), f"All features at T1 must be NaN, got: {row1.to_dict()}"

    # Bar 2 has all 5m and 15m bars: intrabar features must NOT be all NaN
    row2 = res.loc[T2]
    assert not row2.isna().all(), "Features at T2 must not be all NaN"
    assert not np.isnan(row2["rv5"])
    assert not np.isnan(row2["bpv5"])
    assert not np.isnan(row2["close_loc"])


def test_hand_computations_12_bar_hour():
    """Requirement 3: Hand computations on a 12-bar synthetic hour."""
    t_b = 0
    decision_interval_ms = 3_600_000
    T = 3_600_000

    # 12 bars with explicit numbers for hand calculation
    t_vals = [i * 300_000 for i in range(12)]
    o_vals = [100.0, 102.0, 104.0, 101.0, 103.0, 100.0, 105.0, 107.0, 104.0, 102.0, 98.0, 101.0]
    c_vals = [102.0, 104.0, 101.0, 103.0, 100.0, 105.0, 107.0, 104.0, 102.0, 98.0, 101.0, 103.0]
    h_vals = [105.0, 108.0, 106.0, 105.0, 104.0, 107.0, 110.0, 109.0, 106.0, 105.0, 103.0, 106.0]
    l_vals = [95.0, 100.0, 101.0, 98.0, 99.0, 99.0, 103.0, 102.0, 100.0, 97.0, 96.0, 99.0]
    v_vals = [10.0, 20.0, 15.0, 25.0, 30.0, 10.0, 20.0, 10.0, 20.0, 40.0, 50.0, 30.0]
    tbv_vals = [6.0, 15.0, 5.0, 10.0, 20.0, 4.0, 12.0, 3.0, 8.0, 30.0, 25.0, 18.0]

    df5 = pd.DataFrame(
        {
            "t": t_vals,
            "o": o_vals,
            "h": h_vals,
            "l": l_vals,
            "c": c_vals,
            "v": v_vals,
            "tbv": tbv_vals,
        }
    )

    # 4 15m bars inside the hour
    t_15m = [i * 900_000 for i in range(4)]
    df15 = pd.DataFrame([_make_dummy_15m_bar(t) for t in t_15m])

    res = intrabar_features(df5, df15, decision_interval_ms, [t_b])
    row = res.loc[T]

    # Hand calculations
    # Log returns:
    # r0 = log(102/100)
    # r1 = log(104/102)
    # r2 = log(101/104)
    # r3 = log(103/101)
    # r4 = log(100/103)
    # r5 = log(105/100)
    # r6 = log(107/105)
    # r7 = log(104/107)
    # r8 = log(102/104)
    # r9 = log(98/102)
    # r10 = log(101/98)
    # r11 = log(103/101)
    r = np.array(
        [
            np.log(102.0 / 100.0),
            np.log(104.0 / 102.0),
            np.log(101.0 / 104.0),
            np.log(103.0 / 101.0),
            np.log(100.0 / 103.0),
            np.log(105.0 / 100.0),
            np.log(107.0 / 105.0),
            np.log(104.0 / 107.0),
            np.log(102.0 / 104.0),
            np.log(98.0 / 102.0),
            np.log(101.0 / 98.0),
            np.log(103.0 / 101.0),
        ]
    )

    # rv5
    expected_rv5 = float(np.sum(r**2))
    assert row["rv5"] == pytest.approx(expected_rv5, rel=1e-12)

    # bpv5 = (pi / 2) * sum_{i >= 2} |r_i| * |r_{i-1}|
    expected_bpv5 = float((np.pi / 2.0) * np.sum(np.abs(r[1:]) * np.abs(r[:-1])))
    assert row["bpv5"] == pytest.approx(expected_bpv5, rel=1e-12)

    # jump_share = max(0, rv5 - bpv5) / rv5
    expected_jump_share = max(0.0, expected_rv5 - expected_bpv5) / expected_rv5
    assert row["jump_share"] == pytest.approx(expected_jump_share, rel=1e-12)

    # close_loc = (C - L) / (H - L) = (103 - 95) / (110 - 95) = 8 / 15
    expected_close_loc = (103.0 - 95.0) / (110.0 - 95.0)
    assert row["close_loc"] == pytest.approx(expected_close_loc, rel=1e-12)

    # Flat bar check (H == L) -> close_loc == 0.5
    flat_df5 = pd.DataFrame(
        {
            "t": t_vals,
            "o": [100.0] * 12,
            "h": [100.0] * 12,
            "l": [100.0] * 12,
            "c": [100.0] * 12,
            "v": [10.0] * 12,
            "tbv": [5.0] * 12,
        }
    )
    flat_res = intrabar_features(flat_df5, df15, decision_interval_ms, [t_b])
    assert flat_res.loc[T, "close_loc"] == 0.5

    # runup = max(h) / O - 1 = 110 / 100 - 1 = 0.10
    expected_runup = 110.0 / 100.0 - 1.0
    assert row["runup"] == pytest.approx(expected_runup, rel=1e-12)

    # drawdown = min(l) / O - 1 = 95 / 100 - 1 = -0.05
    expected_drawdown = 95.0 / 100.0 - 1.0
    assert row["drawdown"] == pytest.approx(expected_drawdown, rel=1e-12)

    # taker_imb = sum(2 * tbv - v) / sum(v)
    # sum(v) = 280, sum(tbv) = 156, 2 * 156 - 280 = 32 -> 32 / 280 = 4 / 35
    expected_taker_imb = 32.0 / 280.0
    assert row["taker_imb"] == pytest.approx(expected_taker_imb, rel=1e-12)

    # taker_imb_last15: last 3 bars (indices 9, 10, 11)
    # v = [40, 50, 30] -> sum = 120
    # tbv = [30, 25, 18] -> sum = 73
    # 2 * 73 - 120 = 26 -> 26 / 120 = 13 / 60
    expected_taker_imb_last15 = 26.0 / 120.0
    assert row["taker_imb_last15"] == pytest.approx(expected_taker_imb_last15, rel=1e-12)

    # sign_changes: 6 sign changes among 12 nonzero returns -> 6 / 11
    expected_sign_changes = 6.0 / 11.0
    assert row["sign_changes"] == pytest.approx(expected_sign_changes, rel=1e-12)

    # rv_late_early: rv(last 4) / rv(first 4)
    expected_rv_early = float(np.sum(r[:4] ** 2))
    expected_rv_late = float(np.sum(r[-4:] ** 2))
    expected_rv_late_early = expected_rv_late / expected_rv_early
    assert row["rv_late_early"] == pytest.approx(expected_rv_late_early, rel=1e-12)


def test_wilder_rsi7_15m_hand_computed_10_closes():
    """Requirement 4: rsi7_15m against a hand-computed Wilder RSI on 10 closes."""
    # 10 closes:
    c = np.array([100.0, 102.0, 101.0, 104.0, 103.0, 106.0, 105.0, 108.0, 107.0, 110.0])
    # 9 changes:
    # diffs = [+2, -1, +3, -1, +3, -1, +3, -1, +3]
    # gains = [2, 0, 3, 0, 3, 0, 3, 0, 3]
    # losses = [0, 1, 0, 1, 0, 1, 0, 1, 0]
    # First 7 changes:
    # sum(gains[:7]) = 11 -> avg_gain_7 = 11 / 7
    # sum(losses[:7]) = 3 -> avg_loss_7 = 3 / 7
    # 8th change: gain=0, loss=1
    # avg_gain_8 = (11/7 * 6 + 0) / 7 = 66 / 49
    # avg_loss_8 = (3/7 * 6 + 1) / 7 = 25 / 49
    # 9th change: gain=3, loss=0
    # avg_gain_9 = (66/49 * 6 + 3) / 7 = (396/49 + 147/49) / 7 = 543 / 343
    # avg_loss_9 = (25/49 * 6 + 0) / 7 = 150 / 343
    # RS = 543 / 150 = 3.62
    # RSI = 100 - (100 / (1 + 3.62)) = 100 * 543 / 693 = 18100 / 231
    expected_rsi = 18100.0 / 231.0

    calc_rsi = wilder_rsi_15m(c, period=7)
    assert calc_rsi == pytest.approx(expected_rsi, rel=1e-12)

    # Also test through intrabar_features
    # Build 10 15m bars: t from 0 to 9 * 900_000
    t_15m = [i * 900_000 for i in range(10)]
    df15 = pd.DataFrame(
        {
            "t": t_15m,
            "o": [100.0] * 10,
            "h": [120.0] * 10,
            "l": [90.0] * 10,
            "c": c.tolist(),
            "v": [30.0] * 10,
            "tbv": [15.0] * 10,
        }
    )

    # 10th bar closes at 9 * 900_000 + 900_000 = 9_000_000 (which is 2.5 hours)
    # Let decision bar be 1h from 5_400_000 to 9_000_000
    t_b = 5_400_000
    T = 9_000_000
    # Inside [5_400_000, 9_000_000], there are 12 5m bars:
    t_5m = [t_b + i * 300_000 for i in range(12)]
    df5 = pd.DataFrame([_make_dummy_5m_bar(t) for t in t_5m])

    res = intrabar_features(df5, df15, 3_600_000, [t_b])
    assert res.loc[T, "rsi7_15m"] == pytest.approx(expected_rsi, rel=1e-12)


def test_assert_future_invariant_on_synthetic_data():
    """Requirement 5: assert_future_invariant passes for intrabar_features at 1h and 4h on 3+ synthetic days."""
    rng = np.random.default_rng(20261025)

    # Generate 4 days (96 hours) of 5m and 15m synthetic bars
    n_hours = 96

    # 5m bars: 96 * 12 = 1152 bars
    n_5m = n_hours * 12
    t_5m = np.arange(n_5m, dtype=np.int64) * 300_000
    # Price random walk
    log_ret_5m = rng.normal(0.0001, 0.005, size=n_5m)
    p_5m = 1000.0 * np.exp(np.cumsum(log_ret_5m))
    o_5m = np.concatenate(([1000.0], p_5m[:-1]))
    c_5m = p_5m
    h_5m = np.maximum(o_5m, c_5m) * (1.0 + rng.uniform(0.0001, 0.002, size=n_5m))
    l_5m = np.minimum(o_5m, c_5m) * (1.0 - rng.uniform(0.0001, 0.002, size=n_5m))
    v_5m = rng.uniform(10.0, 100.0, size=n_5m)
    tbv_5m = v_5m * rng.uniform(0.3, 0.7, size=n_5m)

    df5 = pd.DataFrame({"t": t_5m, "o": o_5m, "h": h_5m, "l": l_5m, "c": c_5m, "v": v_5m, "tbv": tbv_5m})

    # 15m bars: 96 * 4 = 384 bars
    n_15m = n_hours * 4
    t_15m = np.arange(n_15m, dtype=np.int64) * 900_000
    log_ret_15m = rng.normal(0.0001, 0.008, size=n_15m)
    p_15m = 1000.0 * np.exp(np.cumsum(log_ret_15m))
    o_15m = np.concatenate(([1000.0], p_15m[:-1]))
    c_15m = p_15m
    h_15m = np.maximum(o_15m, c_15m) * (1.0 + rng.uniform(0.0002, 0.004, size=n_15m))
    l_15m = np.minimum(o_15m, c_15m) * (1.0 - rng.uniform(0.0002, 0.004, size=n_15m))
    v_15m = rng.uniform(30.0, 300.0, size=n_15m)
    tbv_15m = v_15m * rng.uniform(0.3, 0.7, size=n_15m)

    df15 = pd.DataFrame({"t": t_15m, "o": o_15m, "h": h_15m, "l": l_15m, "c": c_15m, "v": v_15m, "tbv": tbv_15m})

    inputs = [(df5, 300_000), (df15, 900_000)]

    # 1. Test at 1h (decision_interval_ms = 3600000)
    decision_opens_1h = [i * 3_600_000 for i in range(n_hours)]
    decision_closes_1h = [t_b + 3_600_000 for t_b in decision_opens_1h]
    # Pick 20 random T values from the middle/valid range (leaving plenty of future bars)
    valid_T_1h = decision_closes_1h[10:80]
    sample_T_1h = sorted(rng.choice(valid_T_1h, size=20, replace=False).tolist())

    def build_1h(f5: pd.DataFrame, f15: pd.DataFrame) -> pd.DataFrame:
        return intrabar_features(f5, f15, 3_600_000, decision_opens_1h)

    assert_future_invariant(build_1h, inputs, sample_T_1h, rng=rng)

    # 2. Test at 4h (decision_interval_ms = 14400000)
    n_4h = n_hours // 4  # 24 4h bars
    decision_opens_4h = [i * 14_400_000 for i in range(n_4h)]
    decision_closes_4h = [t_b + 14_400_000 for t_b in decision_opens_4h]
    # Pick 20 random T values from the valid range
    valid_T_4h = decision_closes_4h[2:23]  # 21 bars available
    sample_T_4h = sorted(rng.choice(valid_T_4h, size=20, replace=False).tolist())

    def build_4h(f5: pd.DataFrame, f15: pd.DataFrame) -> pd.DataFrame:
        return intrabar_features(f5, f15, 14_400_000, decision_opens_4h)

    assert_future_invariant(build_4h, inputs, sample_T_4h, rng=rng)


def test_assert_future_invariant_catches_planted_lookahead():
    """Requirement 6: The helper itself catches a planted look-ahead."""
    rng = np.random.default_rng(999)

    # Build 24 5m bars
    n_5m = 24
    t_5m = [i * 300_000 for i in range(n_5m)]
    df5 = pd.DataFrame([_make_dummy_5m_bar(t, o=100.0, c=100.0) for t in t_5m])

    # 8 15m bars
    t_15m = [i * 900_000 for i in range(8)]
    df15 = pd.DataFrame([_make_dummy_15m_bar(t) for t in t_15m])

    inputs = [(df5, 300_000), (df15, 900_000)]

    decision_opens = [0, 3_600_000]
    T_values = [3_600_000]

    # Planted look-ahead builder: reads the first unclosed bar (the bar with t == T)
    def leaky_builder(f5: pd.DataFrame, f15: pd.DataFrame) -> pd.DataFrame:
        rows = []
        for t_b in decision_opens:
            T = t_b + 3_600_000
            # Leaks future unclosed bar opening at T:
            unclosed_bar = f5[f5["t"] == T]
            leak_value = float(unclosed_bar["c"].iloc[0]) if len(unclosed_bar) > 0 else 0.0
            rows.append({"feature": leak_value})
        return pd.DataFrame(rows, index=pd.Index([t_b + 3_600_000 for t_b in decision_opens], name="T"))

    # The helper must fail with AssertionError when running on leaky_builder
    with pytest.raises(AssertionError):
        assert_future_invariant(leaky_builder, inputs, T_values, rng=rng)


def test_rsi7_15m_stationary_window():
    """RSI window test: rsi7_15m uses only the last 64 closed closes and is stationary."""
    rng = np.random.default_rng(42)

    n_200 = 200
    interval_15m = 900_000
    t_15m_200 = [i * interval_15m for i in range(n_200)]
    log_ret_200 = rng.normal(0.0001, 0.005, size=n_200)
    c_200 = 100.0 * np.exp(np.cumsum(log_ret_200))

    df15_200 = pd.DataFrame(
        {
            "t": t_15m_200,
            "o": np.concatenate(([100.0], c_200[:-1])),
            "h": c_200 * 1.01,
            "l": c_200 * 0.99,
            "c": c_200,
            "v": [30.0] * n_200,
            "tbv": [15.0] * n_200,
        }
    )

    T = n_200 * interval_15m
    t_b = T - 3_600_000

    # 12 5m bars inside [t_b, T]
    t_5m = [t_b + i * 300_000 for i in range(12)]
    df5 = pd.DataFrame([_make_dummy_5m_bar(t) for t in t_5m])

    res_200 = intrabar_features(df5, df15_200, 3_600_000, [t_b])
    val_200 = res_200.loc[T, "rsi7_15m"]

    # Must equal wilder_rsi_15m applied to the last 64 closed closes only
    expected_rsi = wilder_rsi_15m(c_200[-64:], period=7)
    assert val_200 == pytest.approx(expected_rsi, rel=1e-12)

    # Prepend 500 extra older 15m bars to the frame
    n_older = 500
    t_older = [(i - n_older) * interval_15m for i in range(n_older)]
    log_ret_older = rng.normal(0.0001, 0.005, size=n_older)
    c_older = 50.0 * np.exp(np.cumsum(log_ret_older))

    df15_older = pd.DataFrame(
        {
            "t": t_older,
            "o": np.concatenate(([50.0], c_older[:-1])),
            "h": c_older * 1.01,
            "l": c_older * 0.99,
            "c": c_older,
            "v": [30.0] * n_older,
            "tbv": [15.0] * n_older,
        }
    )

    df15_700 = pd.concat([df15_older, df15_200], ignore_index=True)

    res_700 = intrabar_features(df5, df15_700, 3_600_000, [t_b])
    val_700 = res_700.loc[T, "rsi7_15m"]

    # Prepending 500 older bars leaves rsi7_15m at T unchanged
    assert val_700 == pytest.approx(expected_rsi, rel=1e-12)
    assert val_700 == pytest.approx(val_200, rel=1e-12)


def test_assert_future_invariant_catches_row_count_dependence():
    """Requirement: truncation check catches planted dependence on future row count."""
    rng = np.random.default_rng(123)

    n_5m = 24
    t_5m = [i * 300_000 for i in range(n_5m)]
    df5 = pd.DataFrame([_make_dummy_5m_bar(t) for t in t_5m])

    t_15m = [i * 900_000 for i in range(8)]
    df15 = pd.DataFrame([_make_dummy_15m_bar(t) for t in t_15m])

    inputs = [(df5, 300_000), (df15, 900_000)]
    T_values = [3_600_000]

    # Fake builder returning len(frame) for every T
    def count_dependent_builder(f5: pd.DataFrame, f15: pd.DataFrame) -> pd.DataFrame:
        return pd.DataFrame(
            {"row_count": [float(len(f5))]},
            index=pd.Index(T_values, name="T"),
        )

    with pytest.raises(AssertionError):
        assert_future_invariant(count_dependent_builder, inputs, T_values, rng=rng)


def test_intrabar_features_scale_one_year():
    """Scale test: 365 days of synthetic 5m and 15m bars with 8,760 1h decision bars finishes in under 20s."""
    rng = np.random.default_rng(20261025)

    n_hours = 365 * 24  # 8,760 hours
    n_5m = n_hours * 12  # 105,120 bars
    t_5m = np.arange(n_5m, dtype=np.int64) * 300_000
    log_ret_5m = rng.normal(0.00001, 0.002, size=n_5m)
    p_5m = 100.0 * np.exp(np.cumsum(log_ret_5m))
    o_5m = np.concatenate(([100.0], p_5m[:-1]))
    c_5m = p_5m
    h_5m = np.maximum(o_5m, c_5m) * (1.0 + rng.uniform(0.0001, 0.001, size=n_5m))
    l_5m = np.minimum(o_5m, c_5m) * (1.0 - rng.uniform(0.0001, 0.001, size=n_5m))
    v_5m = rng.uniform(10.0, 100.0, size=n_5m)
    tbv_5m = v_5m * rng.uniform(0.3, 0.7, size=n_5m)

    df5 = pd.DataFrame({"t": t_5m, "o": o_5m, "h": h_5m, "l": l_5m, "c": c_5m, "v": v_5m, "tbv": tbv_5m})

    n_15m = n_hours * 4  # 35,040 bars
    t_15m = np.arange(n_15m, dtype=np.int64) * 900_000
    log_ret_15m = rng.normal(0.00002, 0.004, size=n_15m)
    p_15m = 100.0 * np.exp(np.cumsum(log_ret_15m))
    o_15m = np.concatenate(([100.0], p_15m[:-1]))
    c_15m = p_15m
    h_15m = np.maximum(o_15m, c_15m) * (1.0 + rng.uniform(0.0001, 0.002, size=n_15m))
    l_15m = np.minimum(o_15m, c_15m) * (1.0 - rng.uniform(0.0001, 0.002, size=n_15m))
    v_15m = rng.uniform(30.0, 300.0, size=n_15m)
    tbv_15m = v_15m * rng.uniform(0.3, 0.7, size=n_15m)

    df15 = pd.DataFrame({"t": t_15m, "o": o_15m, "h": h_15m, "l": l_15m, "c": c_15m, "v": v_15m, "tbv": tbv_15m})

    decision_opens = [i * 3_600_000 for i in range(n_hours)]

    t0 = time.perf_counter()
    res = intrabar_features(df5, df15, 3_600_000, decision_opens)
    elapsed = time.perf_counter() - t0

    warnings.warn(f"Scale test: 8,760 1h decision bars processed in {elapsed:.3f}s", UserWarning, stacklevel=2)

    assert len(res) == 8_760
    assert list(res.columns) == FEATURE_COLUMNS
    assert elapsed < 20.0
