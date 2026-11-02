"""Tests for scalp study S1: scripts/research/py/scalp/study.py.

Synthetic frames only, no network calls, no files outside tmp_path.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4.costs import coin_slippage_bps
from scalp.lock import (
    DAY_MS,
    FIVE_MIN_MS,
    HOUR_MS,
    MONTHS,
    SPAN_END_MS,
    SPAN_START_MS,
    SYMBOLS,
    TAKER_FEE,
    TRADE_START_MS,
    TRADING_DAYS,
)
from scalp.study import (
    features,
    load,
    metrics,
    run,
    signals,
    simulate,
)


def _make_bar_df(
    n_bars: int,
    start_ms: int = SPAN_START_MS,
    base_price: float = 100.0,
    price_step: float = 0.0,
    v: float = 100.0,
    tbv: float = 50.0,
) -> pd.DataFrame:
    """Helper to generate a synthetic 5m kline DataFrame."""
    times = start_ms + np.arange(n_bars, dtype=np.int64) * FIVE_MIN_MS
    prices = base_price + np.arange(n_bars, dtype=np.float64) * price_step
    return pd.DataFrame(
        {
            "t": times,
            "o": prices,
            "h": prices + 0.1,
            "l": prices - 0.1,
            "c": prices,
            "v": np.full(n_bars, v, dtype=np.float64),
            "tbv": np.full(n_bars, tbv, dtype=np.float64),
        }
    )


def test_causality():
    """Altering any bar after T leaves every feature and signal at T unchanged."""
    n_bars = 400
    df = _make_bar_df(n_bars, price_step=0.05)
    feat_orig = features(df)
    sig_orig = signals(feat_orig, "P1")

    # Pick an instant T around bar 320
    idx_t = 320
    t_val = df["t"].iloc[idx_t] + FIVE_MIN_MS

    # Modify bars after T (index > idx_t)
    df_mod = df.copy(deep=True)
    df_mod.loc[df_mod["t"] > df["t"].iloc[idx_t], "c"] *= 1.5
    df_mod.loc[df_mod["t"] > df["t"].iloc[idx_t], "h"] *= 1.6
    df_mod.loc[df_mod["t"] > df["t"].iloc[idx_t], "l"] *= 1.4
    df_mod.loc[df_mod["t"] > df["t"].iloc[idx_t], "v"] *= 2.0
    df_mod.loc[df_mod["t"] > df["t"].iloc[idx_t], "tbv"] *= 2.0

    feat_mod = features(df_mod)
    sig_mod = signals(feat_mod, "P1")

    # Check that rows with T <= t_val are identical
    mask = feat_orig["T"] <= t_val
    for col in ("r5", "s5", "trend", "imb", "q"):
        np.testing.assert_allclose(
            feat_orig.loc[mask, col].to_numpy(),
            feat_mod.loc[mask, col].to_numpy(),
            equal_nan=True,
            err_msg=f"Feature {col} violated causality",
        )

    np.testing.assert_array_equal(
        sig_orig[mask].to_numpy(),
        sig_mod[mask].to_numpy(),
        err_msg="Signal violated causality",
    )


def test_hand_computations_s5_and_ema():
    """s5 against a hand computation, and the EMA trend against a hand computation."""
    # 1. s5 hand check: 289 bars to yield 288 returns ending at T
    n_bars = 289
    # Geometric series so r5 is constant or simple
    r_val = 0.001
    prices = 100.0 * np.exp(np.arange(n_bars) * r_val)
    df = pd.DataFrame(
        {
            "t": SPAN_START_MS + np.arange(n_bars, dtype=np.int64) * FIVE_MIN_MS,
            "o": prices,
            "h": prices + 0.1,
            "l": prices - 0.1,
            "c": prices,
            "v": 100.0,
            "tbv": 50.0,
        }
    )
    feat = features(df)
    last_row = feat.iloc[-1]
    # Hand computation of s5: sample standard deviation of 288 constant values is 0.0
    assert last_row["s5"] == pytest.approx(0.0, abs=1e-12)

    # Now with varying prices for s5
    rng = np.random.default_rng(42)
    varying_prices = 100.0 * np.exp(np.cumsum(rng.normal(0, 0.002, size=n_bars)))
    df_var = df.copy()
    df_var["c"] = varying_prices
    feat_var = features(df_var)
    # Compute hand returns for last 288 bars
    r5_hand = np.log(varying_prices[1:] / varying_prices[:-1])
    s5_hand = float(np.std(r5_hand[-288:], ddof=1))
    assert feat_var.iloc[-1]["s5"] == pytest.approx(s5_hand, rel=1e-6)

    # 2. EMA trend hand check:
    # 25 1h bars = 25 * 12 = 300 5m bars
    n_hours = 25
    n_5m = n_hours * 12
    # Closes for each 1h bar:
    hour_closes = [100.0 + i * 2.0 for i in range(n_hours)]
    # Repeat each hour close across the 12 5m bars
    c_5m = []
    for hc in hour_closes:
        c_5m.extend([hc] * 12)

    df_ema = pd.DataFrame(
        {
            "t": SPAN_START_MS + np.arange(n_5m, dtype=np.int64) * FIVE_MIN_MS,
            "o": c_5m,
            "h": [x + 0.5 for x in c_5m],
            "l": [x - 0.5 for x in c_5m],
            "c": c_5m,
            "v": 100.0,
            "tbv": 50.0,
        }
    )
    feat_ema = features(df_ema)

    # Hand calculate EMA:
    # First 20 hours: seed = mean of first 20 closes
    seed = float(np.mean(hour_closes[:20]))
    alpha = 2.0 / 21.0
    ema = seed
    for k in range(20, n_hours):
        ema = alpha * hour_closes[k] + (1.0 - alpha) * ema

    # At the end of hour 25 (last bar), C = hour_closes[-1], and E = ema
    # Since prices were steadily increasing, C > E, so trend must be +1
    last_trend = feat_ema.iloc[-1]["trend"]
    assert last_trend == 1
    assert hour_closes[-1] > ema


def test_p1_p2_p3_sides_hand_built():
    """P1, P2 and P3 sides on hand-built bars."""
    # Build enough bars to pass warm-up and 288-bar window
    # 48h warm-up = 576 bars
    n_bars = 600
    df = _make_bar_df(n_bars, start_ms=SPAN_START_MS)
    features(df)

    # We can inspect signals() on crafted feature rows
    # Craft a DataFrame with feature columns:
    # T >= TRADE_START_MS
    test_t = TRADE_START_MS + 10 * FIVE_MIN_MS
    craft = pd.DataFrame(
        [
            # P1: trend +1, r5 <= -s5 -> +1
            {"T": test_t, "trend": 1, "r5": -0.02, "s5": 0.01, "imb": 0.0, "q": 0.5, "valid": True},
            # P1: trend -1, r5 >= +s5 -> -1
            {"T": test_t + FIVE_MIN_MS, "trend": -1, "r5": 0.02, "s5": 0.01, "imb": 0.0, "q": 0.5, "valid": True},
            # P1: trend +1, r5 >= +s5 -> 0 (no pullback)
            {
                "T": test_t + 2 * FIVE_MIN_MS,
                "trend": 1,
                "r5": 0.02,
                "s5": 0.01,
                "imb": 0.0,
                "q": 0.5,
                "valid": True,
            },
            # P2: r5 >= +s5 -> -1
            {
                "T": test_t + 3 * FIVE_MIN_MS,
                "trend": 0,
                "r5": 0.02,
                "s5": 0.01,
                "imb": 0.0,
                "q": 0.5,
                "valid": True,
            },
            # P2: r5 <= -s5 -> +1
            {
                "T": test_t + 4 * FIVE_MIN_MS,
                "trend": 0,
                "r5": -0.02,
                "s5": 0.01,
                "imb": 0.0,
                "q": 0.5,
                "valid": True,
            },
            # P3: trend +1, imb >= q -> +1
            {"T": test_t + 5 * FIVE_MIN_MS, "trend": 1, "r5": 0.0, "s5": 0.01, "imb": 0.8, "q": 0.5, "valid": True},
            # P3: trend -1, imb <= -q -> -1
            {
                "T": test_t + 6 * FIVE_MIN_MS,
                "trend": -1,
                "r5": 0.0,
                "s5": 0.01,
                "imb": -0.8,
                "q": 0.5,
                "valid": True,
            },
            # Before TRADE_START_MS -> 0
            {"T": SPAN_START_MS, "trend": 1, "r5": -0.02, "s5": 0.01, "imb": 0.8, "q": 0.5, "valid": True},
            # Invalid -> 0
            {"T": test_t + 7 * FIVE_MIN_MS, "trend": 1, "r5": -0.02, "s5": 0.01, "imb": 0.8, "q": 0.5, "valid": False},
        ]
    )

    s_p1 = signals(craft, "P1").tolist()
    assert s_p1[0] == 1
    assert s_p1[1] == -1
    assert s_p1[2] == 0
    assert s_p1[7] == 0
    assert s_p1[8] == 0

    s_p2 = signals(craft, "P2").tolist()
    assert s_p2[3] == -1
    assert s_p2[4] == 1
    assert s_p2[7] == 0

    s_p3 = signals(craft, "P3").tolist()
    assert s_p3[5] == 1
    assert s_p3[6] == -1
    assert s_p3[7] == 0


def test_taker_fill_prices_and_costed_round_trip():
    """taker fill prices and a costed round trip on a hand example (BTC: fee 5 bps x 2 plus 1 bp x 2 gives 12 bps)."""
    # 600 bars so decisions start after TRADE_START_MS
    n_bars = 600
    df_btc = _make_bar_df(n_bars, base_price=100.0)
    # Set a sharp drop to trigger P2 reversal long (r5 <= -s5) at bar 580
    idx_trig = 580
    t_trig = df_btc["t"].iloc[idx_trig] + FIVE_MIN_MS
    assert t_trig >= TRADE_START_MS

    # Make bar 580 drop sharply
    df_btc.loc[idx_trig, "c"] = 80.0
    # Next bar (entry open) price
    df_btc.loc[idx_trig + 1, "o"] = 80.0
    # Exit bar (entry + 15m = 3 bars later = idx_trig + 4) open price
    df_btc.loc[idx_trig + 4, "o"] = 80.0

    frames = {"BTCUSDT": df_btc}
    funding = pd.DataFrame(columns=["symbol", "t", "rate"])

    trades = simulate(frames, funding, rule="P2", hold="15m", execution="taker")
    assert len(trades) >= 1

    first = trades.iloc[0]
    assert first["symbol"] == "BTCUSDT"
    assert first["entry_px"] == 80.0
    assert first["exit_px"] == 80.0
    assert first["entry_fill"] == "taker"
    assert first["exit_fill"] == "taker"

    # BTC fee is 5 bps + 1 bp slippage per leg = 6 bps per leg = 12 bps round trip
    btc_slip = coin_slippage_bps("BTCUSDT") / 10000.0  # 0.0001
    expected_cost = 2 * (TAKER_FEE + btc_slip)  # 0.0012 = 12 bps
    assert first["cost"] == pytest.approx(expected_cost, abs=1e-9)
    assert first["gross"] == pytest.approx(0.0, abs=1e-9)
    assert first["net"] == pytest.approx(-expected_cost, abs=1e-9)


def test_maker_fill_strict_trade_through():
    """A maker fill only on a strict trade-through, and no fill at an equal low or high."""
    n_bars = 600
    df = _make_bar_df(n_bars, base_price=100.0)
    idx_trig = 580
    # Drop to trigger P2 long
    df.loc[idx_trig, "c"] = 90.0  # Limit buy price will be 90.0

    # 1. Strict trade-through: low < 90.0
    df_strict = df.copy(deep=True)
    df_strict.loc[idx_trig:, "c"] = 90.0
    df_strict.loc[idx_trig + 1, "l"] = 89.9
    df_strict.loc[idx_trig + 1, "h"] = 95.0
    no_funding = pd.DataFrame(columns=["symbol", "t", "rate"])
    trades_strict = simulate({"BTCUSDT": df_strict}, no_funding, "P2", "15m", "maker")
    assert len(trades_strict) >= 1
    assert trades_strict.iloc[0]["entry_fill"] == "maker"
    assert trades_strict.iloc[0]["entry_px"] == 90.0

    # 2. Equal low: low == 90.0 -> no fill
    df_equal = df.copy(deep=True)
    df_equal.loc[idx_trig:, "c"] = 90.0
    df_equal.loc[idx_trig + 1, "l"] = 90.0
    df_equal.loc[idx_trig + 1, "h"] = 95.0
    trades_equal = simulate({"BTCUSDT": df_equal}, pd.DataFrame(columns=["symbol", "t", "rate"]), "P2", "15m", "maker")
    assert len(trades_equal) == 0

    # 3. High <= 90.0 for short
    df_short = _make_bar_df(n_bars, base_price=100.0)
    # Spike to trigger P2 short
    df_short.loc[idx_trig:, "c"] = 110.0  # Limit sell price is 110.0
    df_short_equal = df_short.copy(deep=True)
    df_short_equal.loc[idx_trig + 1, "h"] = 110.0
    df_short_equal.loc[idx_trig + 1, "l"] = 105.0
    trades_short_equal = simulate({"BTCUSDT": df_short_equal}, no_funding, "P2", "15m", "maker")
    assert len(trades_short_equal) == 0


def test_netting_same_side_and_flip():
    """Netting: an exit and a same-side re-entry at one open pay nothing for that pair, and a flip pays one unit."""
    n_bars = 620
    df = _make_bar_df(n_bars, base_price=100.0)
    idx_1 = 580  # triggers trade 1, enters at 581, exits at 581 + 3 = 584
    # Make trade 2 trigger at 583 (close at 584, enters at 584)
    # Trade 1 exits at open of 584, Trade 2 enters at open of 584
    # Case A: Same side (both long)
    df_same = df.copy(deep=True)
    df_same.loc[idx_1, "c"] = 80.0  # long
    df_same.loc[idx_1 + 3, "c"] = 70.0  # long again at 583
    trades_same = simulate({"BTCUSDT": df_same}, pd.DataFrame(columns=["symbol", "t", "rate"]), "P2", "15m", "taker")
    assert len(trades_same) == 2
    t1, t2 = trades_same.iloc[0], trades_same.iloc[1]
    assert t1["exit_ms"] == t2["entry_ms"]
    assert t1["side"] == t2["side"]
    # Single leg cost for BTC
    single_leg = TAKER_FEE + coin_slippage_bps("BTCUSDT") / 10000.0
    # Both trades pay only one leg because the roll open paid 0!
    assert t1["cost"] == pytest.approx(single_leg, abs=1e-9)
    assert t2["cost"] == pytest.approx(single_leg, abs=1e-9)

    # Case B: Flip (long then short)
    df_flip = df.copy(deep=True)
    df_flip.loc[idx_1, "c"] = 80.0  # long
    df_flip.loc[idx_1 + 3, "c"] = 120.0  # short at 583
    trades_flip = simulate({"BTCUSDT": df_flip}, pd.DataFrame(columns=["symbol", "t", "rate"]), "P2", "15m", "taker")
    assert len(trades_flip) == 2
    f1, f2 = trades_flip.iloc[0], trades_flip.iloc[1]
    assert f1["exit_ms"] == f2["entry_ms"]
    assert f1["side"] != f2["side"]
    # In a flip, each leg pays normally: round trip cost each
    expected_rt = 2 * single_leg
    assert f1["cost"] == pytest.approx(expected_rt, abs=1e-9)
    assert f2["cost"] == pytest.approx(expected_rt, abs=1e-9)


def test_funding_inside_hold_not_at_entry():
    """Funding at a settlement inside the hold, and none at the entry stamp."""
    n_bars = 600
    df = _make_bar_df(n_bars, base_price=100.0)
    idx_trig = 580
    df.loc[idx_trig, "c"] = 80.0  # long trade

    # Trade enters at df["t"].iloc[idx_trig + 1] and exits at df["t"].iloc[idx_trig + 4]
    t_entry = int(df["t"].iloc[idx_trig + 1])
    t_exit = int(df["t"].iloc[idx_trig + 4])
    t_inside = t_entry + 5 * 60_000

    funding = pd.DataFrame(
        [
            {"symbol": "BTCUSDT", "t": t_entry, "rate": 0.005},  # At entry stamp -> must be ignored!
            {"symbol": "BTCUSDT", "t": t_inside, "rate": 0.002},  # Inside hold -> included
            {"symbol": "BTCUSDT", "t": t_exit, "rate": 0.003},  # At exit stamp -> included
            {"symbol": "BTCUSDT", "t": t_exit + 1000, "rate": 0.009},  # After exit -> ignored
        ]
    )

    trades = simulate({"BTCUSDT": df}, funding, "P2", "15m", "taker")
    assert len(trades) >= 1
    tr = trades.iloc[0]
    # side is +1 (long), so funding = side * sum(rates) = 1 * (0.002 + 0.003) = 0.005
    assert tr["funding"] == pytest.approx(0.005, abs=1e-9)


def test_one_position_per_coin():
    """One position per coin: signals while that coin is held by the configuration are ignored."""
    n_bars = 610
    df = _make_bar_df(n_bars, base_price=100.0)
    # Trigger signals on consecutive bars 580, 581, 582
    df.loc[580, "c"] = 80.0
    df.loc[581, "c"] = 75.0
    df.loc[582:, "c"] = 70.0

    trades = simulate({"BTCUSDT": df}, pd.DataFrame(columns=["symbol", "t", "rate"]), "P2", "15m", "taker")
    # Hold is 15m (3 bars): enters at 581, exits at 584. Signals at 581 and 582 while held must be ignored!
    assert len(trades) == 1
    assert trades.iloc[0]["entry_ms"] == df["t"].iloc[581]
    assert trades.iloc[0]["exit_ms"] == df["t"].iloc[584]


def test_missing_bars_and_counters():
    """Missing-bar handling and its counters."""
    n_bars = 620
    df = _make_bar_df(n_bars, base_price=100.0)
    # Drop one bar to create a missing bar
    missing_idx = 570
    df_dropped = df.drop(index=missing_idx).reset_index(drop=True)

    feat = features(df_dropped)
    # Bar whose own bar is missing or previous bar is missing has no decision
    # Check invalid flag at the gap
    assert feat["valid"].sum() < len(feat)

    # Missing exit bar handling:
    # Trigger at 580, normal exit is 584. If bar 584 is missing, exit at next present (585)
    df_no_exit = df.copy(deep=True)
    df_no_exit.loc[580, "c"] = 80.0  # entry at 581, scheduled exit at 584
    t_scheduled_exit = df["t"].iloc[584]
    df_no_exit = df_no_exit[df_no_exit["t"] != t_scheduled_exit].reset_index(drop=True)

    trades = simulate({"BTCUSDT": df_no_exit}, pd.DataFrame(columns=["symbol", "t", "rate"]), "P2", "15m", "taker")
    assert len(trades) >= 1
    tr = trades.iloc[0]
    assert tr["exit_ms"] == df["t"].iloc[585]
    # Check missing exit counter in attrs
    assert trades.attrs.get("missing_exits", 0) >= 1


def test_daily_series_includes_zero_days():
    """The daily series includes zero days over the 117 trading days."""
    # Construct a trade DataFrame with a single trade on day 5
    t_day5 = TRADE_START_MS + 5 * DAY_MS + 10 * FIVE_MIN_MS
    trades = pd.DataFrame(
        [
            {
                "symbol": "BTCUSDT",
                "side": 1,
                "T": t_day5 - FIVE_MIN_MS,
                "entry_ms": t_day5,
                "exit_ms": t_day5 + 15 * 60_000,
                "entry_px": 100.0,
                "exit_px": 101.0,
                "entry_fill": "taker",
                "exit_fill": "taker",
                "gross": 0.01,
                "cost": 0.0012,
                "funding": 0.0,
                "net": 0.0088,
                "cost_bnb": 0.0010,
                "net_bnb": 0.0090,
            }
        ]
    )
    m = metrics(trades)
    daily = m["daily_net"]
    assert len(daily) == TRADING_DAYS
    # 116 days should have exactly 0.0
    zero_count = sum(1 for x in daily if x == 0.0)
    assert zero_count == TRADING_DAYS - 1


def test_passes_decision_table():
    """`passes` follows the decision table on constructed trades."""
    # Case 1: Pass
    # Positive net mean, t >= 3.0, >= 3 positive months
    records = []
    # Create trades across all 4 months with positive returns
    for _month_name, m_start, m_end in MONTHS:
        for d in range(25):
            t_exit = m_start + d * DAY_MS + 12 * HOUR_MS
            if t_exit < m_end and t_exit < SPAN_END_MS:
                records.append(
                    {
                        "symbol": "BTCUSDT",
                        "side": 1,
                        "T": t_exit - 15 * 60_000,
                        "entry_ms": t_exit - 15 * 60_000,
                        "exit_ms": t_exit,
                        "entry_px": 100.0,
                        "exit_px": 102.0,
                        "entry_fill": "taker",
                        "exit_fill": "taker",
                        "gross": 0.02,
                        "cost": 0.0012,
                        "funding": 0.0,
                        "net": 0.0188,
                        "cost_bnb": 0.0010,
                        "net_bnb": 0.0190,
                    }
                )
    df_pass = pd.DataFrame(records)
    m_pass = metrics(df_pass)
    assert m_pass["net_mean_bps"] > 0
    assert m_pass["t"] >= 3.0
    assert sum(v > 0 for v in m_pass["monthly_net"].values()) >= 3
    assert m_pass["passes"] is True

    # Case 2: Fail because net mean is negative
    df_fail = df_pass.copy()
    df_fail["net"] = -0.01
    m_fail = metrics(df_fail)
    assert m_fail["passes"] is False


def test_random_walk_panel():
    """A pure random walk gives a net mean near minus the cost for the taker configurations (gross within 4 se of 0)."""
    rng = np.random.default_rng(123)
    # Generate 1500 bars for all 10 symbols
    n_bars = 1500
    frames = {}
    for sym in SYMBOLS:
        rets = rng.normal(0, 0.002, size=n_bars)
        prices = 100.0 * np.exp(np.cumsum(rets))
        v = rng.uniform(50, 150, size=n_bars)
        tbv = v * rng.uniform(0.3, 0.7, size=n_bars)
        frames[sym] = pd.DataFrame(
            {
                "t": SPAN_START_MS + np.arange(n_bars, dtype=np.int64) * FIVE_MIN_MS,
                "o": prices,
                "h": prices * 1.001,
                "l": prices * 0.999,
                "c": prices,
                "v": v,
                "tbv": tbv,
            }
        )

    funding = pd.DataFrame(columns=["symbol", "t", "rate"])
    trades = simulate(frames, funding, rule="P2", hold="15m", execution="taker")
    assert len(trades) > 30

    gross_arr = trades["gross"].to_numpy()
    gross_mean = float(gross_arr.mean())
    se = float(gross_arr.std(ddof=1) / np.sqrt(len(gross_arr)))
    # Assert gross mean is within 4 standard errors of 0
    assert abs(gross_mean) <= 4.0 * se


def test_load_refusals(tmp_path: Path):
    """`load` refuses a sha256 mismatch and a bar outside the span."""
    # Set up valid manifest and files
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    # Create dummy klines for BTCUSDT
    df_btc = _make_bar_df(10, start_ms=SPAN_START_MS)
    btc_path = data_dir / "klines_BTCUSDT.parquet"
    df_btc.to_parquet(btc_path)

    # Empty funding
    df_fund = pd.DataFrame(columns=["symbol", "t", "rate"])
    fund_path = data_dir / "funding.parquet"
    df_fund.to_parquet(fund_path)

    # Generate manifest
    files_map = {
        "klines_BTCUSDT.parquet": hashlib.sha256(btc_path.read_bytes()).hexdigest(),
        "funding.parquet": hashlib.sha256(fund_path.read_bytes()).hexdigest(),
    }
    manifest = {
        "symbols": ["BTCUSDT"],
        "files": files_map,
        "span_start_ms": SPAN_START_MS,
        "span_end_ms": SPAN_END_MS,
    }
    (data_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    # Valid load passes
    frames, fund = load(data_dir)
    assert "BTCUSDT" in frames

    # 1. SHA256 mismatch
    files_bad = dict(files_map)
    files_bad["klines_BTCUSDT.parquet"] = "0" * 64
    manifest["files"] = files_bad
    (data_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="sha256 mismatch"):
        load(data_dir)

    # Restore correct hash
    manifest["files"] = files_map
    (data_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    # 2. Bar outside span (t < SPAN_START_MS)
    df_bad = _make_bar_df(10, start_ms=SPAN_START_MS - FIVE_MIN_MS)
    df_bad.to_parquet(btc_path)
    manifest["files"]["klines_BTCUSDT.parquet"] = hashlib.sha256(btc_path.read_bytes()).hexdigest()
    (data_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="outside span"):
        load(data_dir)


def test_run_refuses_existing_output(tmp_path: Path):
    """`run` refuses an existing output."""
    out_file = tmp_path / "out.json"
    out_file.write_text("existing", encoding="utf-8")
    with pytest.raises(FileExistsError):
        run(tmp_path, out_file, "dummy_commit")


def test_determinism(tmp_path: Path):
    """Determinism: two runs give identical JSON apart from nothing."""
    # Build complete synthetic dataset
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    n_bars = 600
    files_map = {}
    for sym in SYMBOLS:
        df = _make_bar_df(n_bars, start_ms=SPAN_START_MS)
        p = data_dir / f"klines_{sym}.parquet"
        df.to_parquet(p)
        files_map[f"klines_{sym}.parquet"] = hashlib.sha256(p.read_bytes()).hexdigest()

    df_fund = pd.DataFrame(columns=["symbol", "t", "rate"])
    fund_p = data_dir / "funding.parquet"
    df_fund.to_parquet(fund_p)
    files_map["funding.parquet"] = hashlib.sha256(fund_p.read_bytes()).hexdigest()

    manifest = {
        "symbols": list(SYMBOLS),
        "files": files_map,
        "span_start_ms": SPAN_START_MS,
        "span_end_ms": SPAN_END_MS,
    }
    (data_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    out1 = tmp_path / "out1.json"
    out2 = tmp_path / "out2.json"

    run(data_dir, out1, commit="abc1234")
    run(data_dir, out2, commit="abc1234")

    assert out1.read_text(encoding="utf-8") == out2.read_text(encoding="utf-8")
