"""Tests for r4.features part B: decision features, HTF closed context, premium, funding, BTC, calendar."""

from __future__ import annotations

import time
import warnings

import numpy as np
import pandas as pd
import pytest

from r4.causality import assert_future_invariant
from r4.features import (
    ALL_FEATURE_COLUMNS,
    btc_features,
    build_feature_frame,
    calendar_features,
    compute_ema_trend,
    compute_wilder_atr_14,
    decision_features,
    funding_features,
    htf_features,
    premium_features,
)


def _make_bar(
    t: int,
    o: float = 100.0,
    h: float = 105.0,
    l: float = 95.0,
    c: float = 100.0,
    v: float = 10.0,
    tbv: float = 5.0,
) -> dict[str, float]:
    return {"t": float(t), "o": o, "h": h, "l": l, "c": c, "v": v, "tbv": tbv}


# ---------------------------------------------------------------------------
# Requirement 1: Hand computations on small synthetic frames
# ---------------------------------------------------------------------------


def test_hand_computation_ret_k_and_vol_k():
    """Requirement 1.1: ret_k and vol_k hand computation."""
    dt = 3_600_000  # 1h decision interval
    n_bars = 75

    # Known prices: p[i] = 100.0 * 1.01^i
    t_vals = [i * dt for i in range(n_bars)]
    c_vals = [100.0 * (1.01**i) for i in range(n_bars)]
    df = pd.DataFrame({"t": t_vals, "o": c_vals, "h": c_vals, "l": c_vals, "c": c_vals, "v": [10.0] * n_bars})

    res = decision_features(df, dt)
    assert len(res) == n_bars
    assert list(res.columns) == ["ret_1", "ret_4", "ret_24", "vol_24", "vol_72"]

    # Check at bar 74 (T = 75 * dt)
    T74 = t_vals[74] + dt
    row74 = res.loc[T74]

    expected_ret_1 = float(np.log(c_vals[74] / c_vals[73]))
    expected_ret_4 = float(np.log(c_vals[74] / c_vals[70]))
    expected_ret_24 = float(np.log(c_vals[74] / c_vals[50]))

    assert row74["ret_1"] == pytest.approx(expected_ret_1, rel=1e-12)
    assert row74["ret_4"] == pytest.approx(expected_ret_4, rel=1e-12)
    assert row74["ret_24"] == pytest.approx(expected_ret_24, rel=1e-12)

    # All returns are identical (log(1.01)), so sample SD must be exactly 0.0
    assert row74["vol_24"] == pytest.approx(0.0, abs=1e-12)
    assert row74["vol_72"] == pytest.approx(0.0, abs=1e-12)

    # Check boundaries for vol_24 and vol_72
    # Bar 23 (T = 24 * dt) has only 23 returns -> vol_24 must be NaN
    T23 = t_vals[23] + dt
    assert np.isnan(res.loc[T23, "vol_24"])

    # Bar 24 (T = 25 * dt) has 24 returns -> vol_24 must not be NaN
    T24 = t_vals[24] + dt
    assert not np.isnan(res.loc[T24, "vol_24"])

    # Bar 71 (T = 72 * dt) has only 71 returns -> vol_72 must be NaN
    T71 = t_vals[71] + dt
    assert np.isnan(res.loc[T71, "vol_72"])

    # Bar 72 (T = 73 * dt) has 72 returns -> vol_72 must not be NaN
    T72 = t_vals[72] + dt
    assert not np.isnan(res.loc[T72, "vol_72"])


def test_hand_computation_vol_varying():
    """Requirement 1.1b: vol_24 on varying returns against direct numpy std."""
    dt = 3_600_000
    n_bars = 30
    rng = np.random.default_rng(42)
    log_ret = rng.normal(0.001, 0.02, size=n_bars)
    prices = 100.0 * np.exp(np.cumsum(log_ret))

    t_vals = [i * dt for i in range(n_bars)]
    df = pd.DataFrame({"t": t_vals, "o": prices, "h": prices, "l": prices, "c": prices, "v": [10.0] * n_bars})

    res = decision_features(df, dt)
    T_last = t_vals[-1] + dt
    val_vol24 = res.loc[T_last, "vol_24"]

    # Last 24 returns from closes:
    last_25_c = prices[-25:]
    direct_r = np.diff(np.log(last_25_c))
    expected_vol24 = float(np.std(direct_r, ddof=1))

    assert val_vol24 == pytest.approx(expected_vol24, rel=1e-12)


def test_hand_computation_ema_trend():
    """Requirement 1.2: EMA trend on constant series (trend 0) and linear ramp against loop recursion."""
    # 1. Constant series: trend must be exactly 0
    const_closes = np.full(60, 100.0)
    assert compute_ema_trend(const_closes) == pytest.approx(0.0, abs=1e-12)

    # 2. Linear ramp
    ramp_closes = 100.0 + np.arange(60, dtype=float) * 0.5
    trend_calc = compute_ema_trend(ramp_closes)

    # Direct loop computation in test
    ema12 = ramp_closes[0]
    ema26 = ramp_closes[0]
    a12 = 2.0 / 13.0
    a26 = 2.0 / 27.0
    for p in ramp_closes[1:]:
        ema12 = ema12 + a12 * (p - ema12)
        ema26 = ema26 + a26 * (p - ema26)
    expected_trend = (ema12 - ema26) / ema26

    assert trend_calc == pytest.approx(expected_trend, rel=1e-12)

    # Fewer than 52 bars gives NaN
    assert np.isnan(compute_ema_trend(ramp_closes[:51]))
    assert not np.isnan(compute_ema_trend(ramp_closes[:52]))


def test_hand_computation_atr14_1d():
    """Requirement 1.3: ATR(14) on 64 closed 1d bars against hand-calculated recursion."""
    rng = np.random.default_rng(123)
    n_days = 64
    c = 100.0 + np.cumsum(rng.normal(0, 2, size=n_days))
    h = c + rng.uniform(1, 3, size=n_days)
    l = c - rng.uniform(1, 3, size=n_days)

    calc_atr = compute_wilder_atr_14(h, l, c)

    # Hand calculation:
    # TR for bars 1..63:
    hl = h[1:] - l[1:]
    hc = np.abs(h[1:] - c[:-1])
    lc = np.abs(l[1:] - c[:-1])
    tr = np.maximum(hl, np.maximum(hc, lc))

    seed = float(np.mean(tr[:14]))
    expected_atr = seed
    for tr_val in tr[14:]:
        expected_atr = (expected_atr * 13.0 + float(tr_val)) / 14.0

    assert calc_atr == pytest.approx(expected_atr, rel=1e-12)

    # Fewer than 64 bars gives NaN
    assert np.isnan(compute_wilder_atr_14(h[:63], l[:63], c[:63]))


def test_hand_computation_dist_pdh_and_pdl():
    """Requirement 1.4: dist_pdh and dist_pdl hand calculation."""
    # Create 65 1d bars so the last closed 1d bar has known high and low
    dt_1d = 86_400_000
    n_1d = 65
    t_1d = [i * dt_1d for i in range(n_1d)]

    # Known high and low on bar 63 (last closed 1d bar for a decision on day 64)
    h_1d = [110.0] * n_1d
    l_1d = [90.0] * n_1d
    c_1d = [100.0] * n_1d
    h_1d[63] = 120.0
    l_1d[63] = 80.0

    df1 = pd.DataFrame({"t": t_1d, "o": c_1d, "h": h_1d, "l": l_1d, "c": c_1d, "v": [100.0] * n_1d})

    # 4h bars (dummy)
    df4 = pd.DataFrame({"t": [0], "o": [100.0], "h": [100.0], "l": [100.0], "c": [100.0], "v": [10.0]})

    # Decision at T = day 64 at 12:00 UTC = 64 * 86400000 + 12 * 3600000
    T = 64 * dt_1d + 12 * 3_600_000

    # 5m bar closing at T with C = 110.0
    t_5m = T - 300_000
    df5 = pd.DataFrame({"t": [t_5m], "o": [100.0], "h": [115.0], "l": [95.0], "c": [110.0], "v": [10.0]})

    res = htf_features([T], df4, df1, df5, decision_interval_ms=3_600_000)
    row = res.loc[T]

    atr = row["atr14_1d"]
    assert not np.isnan(atr)
    expected_dist_pdh = (110.0 - 120.0) / atr
    expected_dist_pdl = (110.0 - 80.0) / atr

    assert row["dist_pdh"] == pytest.approx(expected_dist_pdh, rel=1e-12)
    assert row["dist_pdl"] == pytest.approx(expected_dist_pdl, rel=1e-12)


def test_hand_computation_value_area():
    """Requirement 1.5: value area on a hand-built day (POC, VAH, VAL, and in_value_area)."""
    # Build 1 day of 288 5m bars: day 64 (so 64 closed 1d bars exist before decision at day 65)
    dt_1d = 86_400_000
    day_idx = 64
    t_day = day_idx * dt_1d
    dt_5m = 300_000
    n_5m = 288

    # Day low = 100.0, day high = 150.0. Range = 50.0 -> 50 bins of width 1.0
    # Bin b covers [100 + b, 100 + b + 1), centre 100.5 + b
    # Bar 0 has low = 100.0, high = 101.0, close = 100.5 (typical price = 100.5, bin 0)
    # Bar 1 has low = 149.0, high = 150.0, close = 149.5 (typical price = 149.5, bin 49)
    # Let bar 2 to 287 be distributed:
    # Put 50 volume in bin 25 (tp = 125.5, centre of [125, 126))
    # Put 25 volume in bin 26 (tp = 126.5)
    # Put 15 volume in bin 24 (tp = 124.5)
    # Put 0.05 volume in the remaining 285 bars (total 14.25 volume)
    # Total volume = 50 + 25 + 15 + 14.25 = 104.25

    t_vals = [t_day + i * dt_5m for i in range(n_5m)]
    o_vals = [125.5] * n_5m
    h_vals = [125.5] * n_5m
    l_vals = [125.5] * n_5m
    c_vals = [125.5] * n_5m
    v_vals = [0.05] * n_5m

    # Bar 0 sets day low
    l_vals[0] = 100.0
    h_vals[0] = 101.0
    c_vals[0] = 100.5
    o_vals[0] = 100.5

    # Bar 1 sets day high
    l_vals[1] = 149.0
    h_vals[1] = 150.0
    c_vals[1] = 149.5
    o_vals[1] = 149.5

    # Bar 2 in bin 25 with 50 volume
    l_vals[2] = 125.0
    h_vals[2] = 126.0
    c_vals[2] = 125.5
    o_vals[2] = 125.5
    v_vals[2] = 50.0

    # Bar 3 in bin 26 with 25 volume
    l_vals[3] = 126.0
    h_vals[3] = 127.0
    c_vals[3] = 126.5
    o_vals[3] = 126.5
    v_vals[3] = 25.0

    # Bar 4 in bin 24 with 15 volume
    l_vals[4] = 124.0
    h_vals[4] = 125.0
    c_vals[4] = 124.5
    o_vals[4] = 124.5
    v_vals[4] = 15.0

    df5 = pd.DataFrame({"t": t_vals, "o": o_vals, "h": h_vals, "l": l_vals, "c": c_vals, "v": v_vals})

    # Day 64 is closed at T = 65 * dt_1d. Decision at day 65 01:00 UTC (T = 65 * dt_1d + 3600000)
    T = (day_idx + 1) * dt_1d + 3_600_000

    # 1d bars: need 65 bars so ATR is valid on day 64
    t_1d = [i * dt_1d for i in range(day_idx + 1)]
    df1 = pd.DataFrame(
        {
            "t": t_1d,
            "o": [100.0] * (day_idx + 1),
            "h": [150.0] * (day_idx + 1),
            "l": [100.0] * (day_idx + 1),
            "c": [125.0] * (day_idx + 1),
            "v": [100.0] * (day_idx + 1),
        }
    )

    # 5m bar at T with close C = 126.0 (inside value area [125.0, 127.0])
    df5_with_T = pd.concat(
        [
            df5,
            pd.DataFrame(
                [
                    {
                        "t": T - 300_000,
                        "o": 126.0,
                        "h": 127.0,
                        "l": 125.0,
                        "c": 126.0,
                        "v": 10.0,
                    }
                ]
            ),
        ],
        ignore_index=True,
    )

    df4 = pd.DataFrame({"t": [0], "o": [100.0], "h": [100.0], "l": [100.0], "c": [100.0], "v": [10.0]})

    res = htf_features([T], df4, df1, df5_with_T, decision_interval_ms=3_600_000)
    row = res.loc[T]

    # Hand calculations:
    # Day low = 100, day high = 150, width = 1.0
    # Bin 25 has max volume (50) -> POC = 100 + 25.5 = 125.5
    # Total volume = 50 + 25 + 15 + 0.05 * 284 + 0.05 * 2 = 104.3
    # 70% of 104.3 = 73.01
    # POC bin volume = 50 < 73.01
    # Neighbours: bin 24 (15 vol) vs bin 26 (25 vol) -> bin 26 chosen
    # Area volume = 50 + 25 = 75 >= 73.01 -> stop!
    # Included bins: [25, 26]
    # VAL = 125.0, VAH = 127.0
    # C = 126.0 -> VAL <= C <= VAH -> in_value_area == 1.0!
    assert row["in_value_area"] == 1.0

    atr = row["atr14_1d"]
    expected_dist_poc = (126.0 - 125.5) / atr
    assert row["dist_poc"] == pytest.approx(expected_dist_poc, rel=1e-12)

    # If C was 128.0 (outside VA):
    df5_outside = pd.concat(
        [
            df5,
            pd.DataFrame(
                [
                    {
                        "t": T - 300_000,
                        "o": 128.0,
                        "h": 129.0,
                        "l": 127.0,
                        "c": 128.0,
                        "v": 10.0,
                    }
                ]
            ),
        ],
        ignore_index=True,
    )
    res_outside = htf_features([T], df4, df1, df5_outside, decision_interval_ms=3_600_000)
    assert res_outside.loc[T, "in_value_area"] == 0.0


def test_hand_computation_basis_and_basis_z7d():
    """Requirement 1.6: basis and basis_z7d hand calculation."""
    dt_5m = 300_000
    n_bars = 2016
    t_vals = [i * dt_5m for i in range(n_bars)]
    rng = np.random.default_rng(99)
    c_vals = rng.normal(0.0005, 0.0002, size=n_bars)

    df_prem = pd.DataFrame({"t": t_vals, "c": c_vals})
    T = t_vals[-1] + dt_5m

    res = premium_features([T], df_prem)
    row = res.loc[T]

    expected_basis = float(c_vals[-1])
    expected_mean = float(np.mean(c_vals))
    expected_sd = float(np.std(c_vals, ddof=1))
    expected_z = (expected_basis - expected_mean) / expected_sd

    assert row["basis"] == pytest.approx(expected_basis, rel=1e-12)
    assert row["basis_z7d"] == pytest.approx(expected_z, rel=1e-12)


def test_hand_computation_funding_columns():
    """Requirement 1.7: funding columns (settlement at T counts, at T - 7d does not)."""
    T = 1_000_000_000_000
    seven_days = 7 * 86_400_000  # 604_800_000
    thirty_days = 30 * 86_400_000  # 2_592_000_000

    t_at_T_minus_7d = T - seven_days
    t_at_T_minus_3d = T - 3 * 86_400_000
    t_at_T = T

    # Settlements:
    # 1. At T - 7d: rate = 0.005 (MUST NOT count in 7d sum)
    # 2. At T - 3d: rate = 0.002 (counts)
    # 3. At T: rate = 0.003 (counts, and is funding_last)
    # Also add 30 settlements in (T - 30d, T - 7d) so funding_z30d has >= 30 settlements
    earlier_t = [T - thirty_days + (i + 1) * 60_000_000 for i in range(30)]
    earlier_rates = [0.0001 * (i % 3) for i in range(30)]

    all_t = earlier_t + [t_at_T_minus_7d, t_at_T_minus_3d, t_at_T]
    all_rates = earlier_rates + [0.0050, 0.0020, 0.0030]

    df_settle = pd.DataFrame({"t": all_t, "rate": all_rates})

    res = funding_features([T], df_settle)
    row = res.loc[T]

    # funding_last
    assert row["funding_last"] == pytest.approx(0.0030, rel=1e-12)

    # funding_sum_7d: exactly 0.0020 + 0.0030 = 0.0050 (0.0050 at T - 7d is strictly excluded)
    assert row["funding_sum_7d"] == pytest.approx(0.0050, rel=1e-12)

    # funding_z30d:
    rates_30d = [r for t, r in zip(all_t, all_rates, strict=True) if T - thirty_days < t <= T]
    assert len(rates_30d) >= 30
    exp_mean = float(np.mean(rates_30d))
    exp_sd = float(np.std(rates_30d, ddof=1))
    exp_z = (0.0030 - exp_mean) / exp_sd
    assert row["funding_z30d"] == pytest.approx(exp_z, rel=1e-12)


def test_hand_computation_beta_72_against_polyfit():
    """Requirement 1.8: beta_72 against numpy.polyfit and BTC identity."""
    dt = 3_600_000
    n_bars = 75
    rng = np.random.default_rng(2026)

    # Synthetic returns
    btc_ret = rng.normal(0.0005, 0.01, size=n_bars)
    coin_ret = 1.35 * btc_ret + rng.normal(0.0001, 0.005, size=n_bars)

    btc_c = 50000.0 * np.exp(np.cumsum(btc_ret))
    coin_c = 100.0 * np.exp(np.cumsum(coin_ret))

    t_vals = [i * dt for i in range(n_bars)]
    df_btc = pd.DataFrame({"t": t_vals, "c": btc_c})
    df_coin = pd.DataFrame({"t": t_vals, "c": coin_c})

    res = btc_features(df_coin, df_btc, dt)
    T_last = t_vals[-1] + dt
    row = res.loc[T_last]

    # OLS slope of last 72 closed returns on BTC's
    last_72_coin_r = np.diff(np.log(coin_c[-73:]))
    last_72_btc_r = np.diff(np.log(btc_c[-73:]))

    expected_slope = float(np.polyfit(last_72_btc_r, last_72_coin_r, deg=1)[0])
    assert row["beta_72"] == pytest.approx(expected_slope, rel=1e-9)

    # resid_ret = ret_1 - beta_72 * btc_ret_last
    ret_1 = float(np.log(coin_c[-1] / coin_c[-2]))
    btc_ret_last = float(np.log(btc_c[-1] / btc_c[-2]))
    expected_resid = ret_1 - expected_slope * btc_ret_last
    assert row["resid_ret"] == pytest.approx(expected_resid, rel=1e-9)

    # Test BTC itself: beta_72 == 1.0, resid_ret == 0.0
    res_btc = btc_features(df_btc, df_btc, dt)
    row_btc = res_btc.loc[T_last]
    assert row_btc["beta_72"] == pytest.approx(1.0, rel=1e-9)
    assert row_btc["resid_ret"] == pytest.approx(0.0, abs=1e-12)


def test_hand_computation_calendar_known_times():
    """Requirement 1.9: calendar features at known UTC times."""
    # 2026-03-16 06:00:00 UTC
    # 2026-03-16 was a Monday (weekday = 0)
    ts = int(pd.Timestamp("2026-03-16 06:00:00+00:00").timestamp() * 1000)

    res = calendar_features([ts])
    row = res.loc[ts]

    # Hour 6: sin(2*pi*6/24) = sin(pi/2) = 1.0, cos = 0.0
    assert row["hour_sin"] == pytest.approx(1.0, abs=1e-12)
    assert row["hour_cos"] == pytest.approx(0.0, abs=1e-12)

    # Monday (0): sin(0) = 0.0, cos(0) = 1.0
    assert row["dow_sin"] == pytest.approx(0.0, abs=1e-12)
    assert row["dow_cos"] == pytest.approx(1.0, abs=1e-12)


# ---------------------------------------------------------------------------
# Requirement 2: Closed-bar rule
# ---------------------------------------------------------------------------


def test_closed_bar_rule_htf_forming_day_invariant():
    """Requirement 2: at a 1h decision at 14:00 UTC, the 1d context uses the bar that opened

    the previous day. Changing today's forming 1d bar changes nothing.
    """
    dt_1d = 86_400_000
    n_days = 70

    # Day 0 to 69
    # Decision is on Day 69 at 14:00 UTC
    t_day_69 = 69 * dt_1d
    T = t_day_69 + 14 * 3_600_000  # 14:00 UTC on day 69

    t_1d = [i * dt_1d for i in range(n_days)]
    h_1d = [110.0] * n_days
    l_1d = [90.0] * n_days
    c_1d = [100.0] * n_days
    o_1d = [100.0] * n_days

    # Set Day 68 (previous day, opened at day 68 00:00, closed at day 69 00:00)
    h_1d[68] = 115.0
    l_1d[68] = 85.0
    c_1d[68] = 105.0

    # Day 69 is forming (closes at Day 70 00:00 > T)
    h_1d[69] = 120.0
    l_1d[69] = 80.0
    c_1d[69] = 108.0

    df1_orig = pd.DataFrame({"t": t_1d, "o": o_1d, "h": h_1d, "l": l_1d, "c": c_1d, "v": [100.0] * n_days})

    # 4h bars (dummy)
    df4 = pd.DataFrame({"t": [0], "o": [100.0], "h": [100.0], "l": [100.0], "c": [100.0], "v": [10.0]})

    # 5m bars for day 68 (288 bars) + bar at T
    t_5m_day68 = [68 * dt_1d + i * 300_000 for i in range(288)]
    df5_day68 = pd.DataFrame(
        {
            "t": t_5m_day68,
            "o": [100.0] * 288,
            "h": [105.0] * 288,
            "l": [95.0] * 288,
            "c": [100.0] * 288,
            "v": [10.0] * 288,
        }
    )
    df5_T = pd.DataFrame([{"t": T - 300_000, "o": 102.0, "h": 103.0, "l": 101.0, "c": 102.0, "v": 10.0}])
    df5 = pd.concat([df5_day68, df5_T], ignore_index=True)

    res_orig = htf_features([T], df4, df1_orig, df5, decision_interval_ms=3_600_000)

    # Mutate today's forming 1d bar (index 69) with completely different values
    df1_mutated = df1_orig.copy()
    df1_mutated.loc[69, "h"] = 9999.0
    df1_mutated.loc[69, "l"] = 1.0
    df1_mutated.loc[69, "c"] = 5555.0
    df1_mutated.loc[69, "o"] = 4444.0
    df1_mutated.loc[69, "v"] = 888888.0

    res_mutated = htf_features([T], df4, df1_mutated, df5, decision_interval_ms=3_600_000)

    # Changing today's forming 1d bar changes NOTHING in the 1d context
    cols_to_check = [
        "ret_1d_last",
        "trend_1d",
        "atr14_1d",
        "dist_pdh",
        "dist_pdl",
        "rv_prev_day",
        "dist_poc",
        "in_value_area",
    ]
    pd.testing.assert_frame_equal(res_orig[cols_to_check], res_mutated[cols_to_check], check_exact=True)


# ---------------------------------------------------------------------------
# Requirement 3: Future invariance (causality check)
# ---------------------------------------------------------------------------


def _aggregate_bars(df5: pd.DataFrame, interval_ms: int) -> pd.DataFrame:
    """Aggregate 5m bars into a higher timeframe (15m, 1h, 4h, 1d).

    Open of first, max high, min low, close of last, sum volume and taker buy volume.
    """
    k = interval_ms // 300_000
    n_agg = len(df5) // k
    truncated_len = n_agg * k

    t_in = df5["t"].to_numpy(dtype=np.int64)[:truncated_len]
    o_in = df5["o"].to_numpy(dtype=float)[:truncated_len]
    h_in = df5["h"].to_numpy(dtype=float)[:truncated_len]
    l_in = df5["l"].to_numpy(dtype=float)[:truncated_len]
    c_in = df5["c"].to_numpy(dtype=float)[:truncated_len]
    v_in = df5["v"].to_numpy(dtype=float)[:truncated_len]

    t_out = t_in.reshape(n_agg, k)[:, 0]
    o_out = o_in.reshape(n_agg, k)[:, 0]
    h_out = np.max(h_in.reshape(n_agg, k), axis=1)
    l_out = np.min(l_in.reshape(n_agg, k), axis=1)
    c_out = c_in.reshape(n_agg, k)[:, -1]
    v_out = np.sum(v_in.reshape(n_agg, k), axis=1)

    data: dict[str, np.ndarray] = {
        "t": t_out,
        "o": o_out,
        "h": h_out,
        "l": l_out,
        "c": c_out,
        "v": v_out,
    }
    if "tbv" in df5.columns:
        tbv_in = df5["tbv"].to_numpy(dtype=float)[:truncated_len]
        data["tbv"] = np.sum(tbv_in.reshape(n_agg, k), axis=1)

    return pd.DataFrame(data)


def test_assert_future_invariant_on_synthetic_data_1h_and_4h():
    """Requirement 3: assert_future_invariant passes on >=90 synthetic days at 1h and 4h with full coverage."""
    rng = np.random.default_rng(20261025)
    n_days = 90
    n_hours = n_days * 24

    # 1. 5m bars for coin: 90 * 24 * 12 = 25,920 bars
    n_5m = n_hours * 12
    t_5m = np.arange(n_5m, dtype=np.int64) * 300_000
    p_5m = 1000.0 * np.exp(np.cumsum(rng.normal(0.0001, 0.002, size=n_5m)))
    o_5m = np.concatenate(([1000.0], p_5m[:-1]))
    c_5m = p_5m
    h_5m = np.maximum(o_5m, c_5m) * (1.0 + rng.uniform(0.0001, 0.001, size=n_5m))
    l_5m = np.minimum(o_5m, c_5m) * (1.0 - rng.uniform(0.0001, 0.001, size=n_5m))
    v_5m = rng.uniform(10.0, 100.0, size=n_5m)
    tbv_5m = v_5m * rng.uniform(0.3, 0.7, size=n_5m)
    df5 = pd.DataFrame({"t": t_5m, "o": o_5m, "h": h_5m, "l": l_5m, "c": c_5m, "v": v_5m, "tbv": tbv_5m})

    # 2. 5m bars for BTC built the same way
    p_btc_5m = 50000.0 * np.exp(np.cumsum(rng.normal(0.0001, 0.002, size=n_5m)))
    o_btc_5m = np.concatenate(([50000.0], p_btc_5m[:-1]))
    c_btc_5m = p_btc_5m
    h_btc_5m = np.maximum(o_btc_5m, c_btc_5m) * (1.0 + rng.uniform(0.0001, 0.001, size=n_5m))
    l_btc_5m = np.minimum(o_btc_5m, c_btc_5m) * (1.0 - rng.uniform(0.0001, 0.001, size=n_5m))
    v_btc_5m = rng.uniform(10.0, 100.0, size=n_5m)
    tbv_btc_5m = v_btc_5m * rng.uniform(0.3, 0.7, size=n_5m)
    df5_btc = pd.DataFrame(
        {
            "t": t_5m,
            "o": o_btc_5m,
            "h": h_btc_5m,
            "l": l_btc_5m,
            "c": c_btc_5m,
            "v": v_btc_5m,
            "tbv": tbv_btc_5m,
        }
    )

    # 3. Derive 15m, 1h, 4h, and 1d bars FROM 5m bars by aggregation
    df15 = _aggregate_bars(df5, 900_000)
    df_dec_1h = _aggregate_bars(df5, 3_600_000)
    df_dec_4h = _aggregate_bars(df5, 14_400_000)
    df4 = df_dec_4h.copy()
    df1 = _aggregate_bars(df5, 86_400_000)

    df_btc_1h = _aggregate_bars(df5_btc, 3_600_000)
    df_btc_4h = _aggregate_bars(df5_btc, 14_400_000)

    # 4. Premium 5m bars over whole span
    c_prem = rng.normal(0.0005, 0.0002, size=n_5m)
    df_prem = pd.DataFrame(
        {
            "t": t_5m,
            "o": c_prem,
            "h": c_prem + 0.0001,
            "l": c_prem - 0.0001,
            "c": c_prem,
            "v": [10.0] * n_5m,
        }
    )

    # 5. Settlements every 8h over whole span
    n_settle = (n_days * 24) // 8
    t_settle = np.arange(n_settle, dtype=np.int64) * (8 * 3_600_000)
    rate_settle = rng.normal(0.0001, 0.0002, size=n_settle)
    df_settle = pd.DataFrame({"t": t_settle, "rate": rate_settle})

    # Sample 25 random T values from the last 20 days for each of 1h and 4h
    t_start_20d = (n_days - 20) * 86_400_000
    t_end = n_days * 86_400_000

    decision_closes_1h = [int(t + 3_600_000) for t in df_dec_1h["t"]]
    valid_T_1h = [T for T in decision_closes_1h if t_start_20d <= T < t_end]
    sample_T_1h = sorted(rng.choice(valid_T_1h, size=25, replace=False).tolist())

    decision_closes_4h = [int(t + 14_400_000) for t in df_dec_4h["t"]]
    valid_T_4h = [T for T in decision_closes_4h if t_start_20d <= T < t_end]
    sample_T_4h = sorted(rng.choice(valid_T_4h, size=25, replace=False).tolist())

    # 6. Test at 1h
    inputs_1h = {
        "five_min": (df5, 300_000),
        "fifteen_min": (df15, 900_000),
        "decision_bars": (df_dec_1h, 3_600_000),
        "four_h": (df4, 14_400_000),
        "one_d": (df1, 86_400_000),
        "premium_5m": (df_prem, 300_000),
        "settlements": (df_settle, 0),
        "btc_decision_bars": (df_btc_1h, 3_600_000),
    }

    def wrapper_1h(
        five_min: pd.DataFrame,
        fifteen_min: pd.DataFrame,
        decision_bars: pd.DataFrame,
        four_h: pd.DataFrame,
        one_d: pd.DataFrame,
        premium_5m: pd.DataFrame,
        settlements: pd.DataFrame,
        btc_decision_bars: pd.DataFrame,
    ) -> pd.DataFrame:
        return build_feature_frame(
            five_min=five_min,
            fifteen_min=fifteen_min,
            decision_bars=decision_bars,
            four_h=four_h,
            one_d=one_d,
            premium_5m=premium_5m,
            settlements=settlements,
            btc_decision_bars=btc_decision_bars,
            decision_interval_ms=3_600_000,
        )

    # Coverage assertion for 1h: every column in ALL_FEATURE_COLUMNS must have at least one finite value
    base_df_1h = wrapper_1h(**{k: v[0] for k, v in inputs_1h.items()})
    sampled_1h = base_df_1h.loc[sample_T_1h]
    for col in ALL_FEATURE_COLUMNS:
        assert np.isfinite(sampled_1h[col]).any(), (
            f"Coverage assertion failed for 1h: column '{col}' is NaN at every sampled T"
        )

    assert_future_invariant(wrapper_1h, inputs_1h, sample_T_1h, rng=rng)

    # 7. Test at 4h
    inputs_4h = {
        "five_min": (df5, 300_000),
        "fifteen_min": (df15, 900_000),
        "decision_bars": (df_dec_4h, 14_400_000),
        "four_h": (df4, 14_400_000),
        "one_d": (df1, 86_400_000),
        "premium_5m": (df_prem, 300_000),
        "settlements": (df_settle, 0),
        "btc_decision_bars": (df_btc_4h, 14_400_000),
    }

    def wrapper_4h(
        five_min: pd.DataFrame,
        fifteen_min: pd.DataFrame,
        decision_bars: pd.DataFrame,
        four_h: pd.DataFrame,
        one_d: pd.DataFrame,
        premium_5m: pd.DataFrame,
        settlements: pd.DataFrame,
        btc_decision_bars: pd.DataFrame,
    ) -> pd.DataFrame:
        return build_feature_frame(
            five_min=five_min,
            fifteen_min=fifteen_min,
            decision_bars=decision_bars,
            four_h=four_h,
            one_d=one_d,
            premium_5m=premium_5m,
            settlements=settlements,
            btc_decision_bars=btc_decision_bars,
            decision_interval_ms=14_400_000,
        )

    # Coverage assertion for 4h: every column except ret_4h_last must have at least one finite value
    base_df_4h = wrapper_4h(**{k: v[0] for k, v in inputs_4h.items()})
    sampled_4h = base_df_4h.loc[sample_T_4h]
    for col in ALL_FEATURE_COLUMNS:
        if col == "ret_4h_last":
            assert sampled_4h[col].isna().all(), (
                "ret_4h_last is expected to be NaN for 4h decisions, got non-NaN values"
            )
            continue
        assert np.isfinite(sampled_4h[col]).any(), (
            f"Coverage assertion failed for 4h: column '{col}' is NaN at every sampled T"
        )

    assert_future_invariant(wrapper_4h, inputs_4h, sample_T_4h, rng=rng)


# ---------------------------------------------------------------------------
# Requirement 4: Gap handling
# ---------------------------------------------------------------------------


def test_gap_in_window_gives_nan_for_affected_columns_only():
    """Requirement 4: A gap anywhere in a window gives NaN for exactly the affected columns at that T."""
    dt = 3_600_000
    n_bars = 40

    # Build 40 1h bars, but omit bar 10
    t_vals = [i * dt for i in range(n_bars) if i != 10]
    c_vals = [100.0 * (1.001**i) for i in range(len(t_vals))]
    df = pd.DataFrame({"t": t_vals, "o": c_vals, "h": c_vals, "l": c_vals, "c": c_vals, "v": [10.0] * len(t_vals)})

    res = decision_features(df, dt)

    # For bar at i = 12 (t = 12 * dt):
    # ret_1 uses bar 12 and bar 11: both exist and are contiguous -> ret_1 is not NaN!
    T12 = 12 * dt + dt
    assert not np.isnan(res.loc[T12, "ret_1"])

    # But ret_4 at bar 12 uses window [8..12] which spans missing bar 10 -> ret_4 must be NaN!
    assert np.isnan(res.loc[T12, "ret_4"])

    # ret_24 at bar 25 uses window [1..25] which spans missing bar 10 -> ret_24 must be NaN!
    T25 = 25 * dt + dt
    assert np.isnan(res.loc[T25, "ret_24"])
    assert np.isnan(res.loc[T25, "vol_24"])

    # At bar 36 (window [12..36] does not contain missing bar 10):
    T36 = 36 * dt + dt
    assert not np.isnan(res.loc[T36, "ret_24"])
    assert not np.isnan(res.loc[T36, "vol_24"])


# ---------------------------------------------------------------------------
# Requirement 5: Scale test
# ---------------------------------------------------------------------------


def test_build_feature_frame_scale_one_year():
    """Requirement 5: Scale: 365 synthetic days with 1h decisions, build_feature_frame under 60 seconds."""
    rng = np.random.default_rng(2026)
    n_days = 365
    n_hours = n_days * 24  # 8,760 hours

    # 5m: 8760 * 12 = 105,120 bars
    n_5m = n_hours * 12
    t_5m = np.arange(n_5m, dtype=np.int64) * 300_000
    p_5m = 100.0 * np.exp(np.cumsum(rng.normal(0.00001, 0.001, size=n_5m)))
    o_5m = np.concatenate(([100.0], p_5m[:-1]))
    c_5m = p_5m
    h_5m = np.maximum(o_5m, c_5m) * 1.0005
    l_5m = np.minimum(o_5m, c_5m) * 0.9995
    v_5m = rng.uniform(10.0, 100.0, size=n_5m)
    tbv_5m = v_5m * 0.5
    df5 = pd.DataFrame({"t": t_5m, "o": o_5m, "h": h_5m, "l": l_5m, "c": c_5m, "v": v_5m, "tbv": tbv_5m})

    # 15m: 8760 * 4 = 35,040 bars
    n_15m = n_hours * 4
    t_15m = np.arange(n_15m, dtype=np.int64) * 900_000
    p_15m = 100.0 * np.exp(np.cumsum(rng.normal(0.00002, 0.002, size=n_15m)))
    o_15m = np.concatenate(([100.0], p_15m[:-1]))
    c_15m = p_15m
    h_15m = np.maximum(o_15m, c_15m) * 1.001
    l_15m = np.minimum(o_15m, c_15m) * 0.999
    v_15m = rng.uniform(30.0, 300.0, size=n_15m)
    tbv_15m = v_15m * 0.5
    df15 = pd.DataFrame({"t": t_15m, "o": o_15m, "h": h_15m, "l": l_15m, "c": c_15m, "v": v_15m, "tbv": tbv_15m})

    # 1h decision bars: 8,760 bars
    t_1h = np.arange(n_hours, dtype=np.int64) * 3_600_000
    p_1h = 100.0 * np.exp(np.cumsum(rng.normal(0.00005, 0.003, size=n_hours)))
    o_1h = np.concatenate(([100.0], p_1h[:-1]))
    c_1h = p_1h
    df_dec = pd.DataFrame(
        {
            "t": t_1h,
            "o": o_1h,
            "h": c_1h * 1.001,
            "l": c_1h * 0.999,
            "c": c_1h,
            "v": [100.0] * n_hours,
        }
    )

    # 4h bars: 2,190 bars
    n_4h = n_hours // 4
    t_4h = np.arange(n_4h, dtype=np.int64) * 14_400_000
    p_4h = 100.0 * np.exp(np.cumsum(rng.normal(0.0001, 0.005, size=n_4h)))
    o_4h = np.concatenate(([100.0], p_4h[:-1]))
    c_4h = p_4h
    df4 = pd.DataFrame(
        {
            "t": t_4h,
            "o": o_4h,
            "h": c_4h * 1.002,
            "l": c_4h * 0.998,
            "c": c_4h,
            "v": [500.0] * n_4h,
        }
    )

    # 1d bars: 365 bars
    t_1d = np.arange(n_days, dtype=np.int64) * 86_400_000
    p_1d = 100.0 * np.exp(np.cumsum(rng.normal(0.0002, 0.01, size=n_days)))
    o_1d = np.concatenate(([100.0], p_1d[:-1]))
    c_1d = p_1d
    df1 = pd.DataFrame(
        {
            "t": t_1d,
            "o": o_1d,
            "h": c_1d * 1.01,
            "l": c_1d * 0.99,
            "c": c_1d,
            "v": [2000.0] * n_days,
        }
    )

    # Premium: 105,120 bars
    c_prem = rng.normal(0.0005, 0.0001, size=n_5m)
    df_prem = pd.DataFrame({"t": t_5m, "c": c_prem})

    # Settlements: 365 * 3 = 1095 settlements
    n_settle = n_days * 3
    t_settle = np.arange(n_settle, dtype=np.int64) * (8 * 3_600_000)
    rates = rng.normal(0.0001, 0.0001, size=n_settle)
    df_settle = pd.DataFrame({"t": t_settle, "rate": rates})

    # BTC 1h bars: 8,760 bars
    p_btc = 50000.0 * np.exp(np.cumsum(rng.normal(0.00005, 0.002, size=n_hours)))
    o_btc = np.concatenate(([50000.0], p_btc[:-1]))
    c_btc = p_btc
    df_btc = pd.DataFrame(
        {
            "t": t_1h,
            "o": o_btc,
            "h": c_btc * 1.001,
            "l": c_btc * 0.999,
            "c": c_btc,
            "v": [500.0] * n_hours,
        }
    )

    t0 = time.perf_counter()
    feat_df = build_feature_frame(
        five_min=df5,
        fifteen_min=df15,
        decision_bars=df_dec,
        four_h=df4,
        one_d=df1,
        premium_5m=df_prem,
        settlements=df_settle,
        btc_decision_bars=df_btc,
        decision_interval_ms=3_600_000,
    )
    elapsed = time.perf_counter() - t0

    warnings.warn(f"Scale test: 8,760 1h decision bars processed in {elapsed:.3f}s", UserWarning, stacklevel=2)

    assert len(feat_df) == 8_760
    assert list(feat_df.columns) == ALL_FEATURE_COLUMNS
    assert elapsed < 60.0
