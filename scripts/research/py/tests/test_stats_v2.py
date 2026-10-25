"""Tests for r4.stats lock v2 additions: joint-shift null, Hansen SPA test, and drift-free returns."""

from __future__ import annotations

import math

import numpy as np

from r4.stats import (
    coin_mean_hourly,
    drift_free_trade_returns,
    hansen_spa,
    joint_shift_null,
    p_value,
    random_entry_null,
)


def test_joint_shift_null_properties() -> None:
    """Verify structural properties of joint_shift_null:

    - Every draw shifts all entries by the same offset.
    - The offset is never below min_shift_bars.
    - Relative timing between entries is preserved modulo wrap for kept entries.
    - Drops happen only for windows that wrap past the grid.
    """
    n_bars = 500
    min_shift_bars = 50
    entries = [
        ("BTC", 50, "long", 1.0, 20),
        ("ETH", 100, "short", 2.0, 30),
        ("SOL", 300, "long", 0.5, 50),
        ("ADA", 450, "short", 1.5, 60),
    ]

    captured: list[list[tuple[str, int, str, float, int]]] = []

    def eval_fn(shifted: list[tuple[str, int, str, float, int]]) -> float:
        captured.append(shifted)
        return float(len(shifted))

    null_stats, dropped_counts = joint_shift_null(
        eval_fn,
        entries,
        n_bars=n_bars,
        min_shift_bars=min_shift_bars,
        n_draws=100,
        seed=42,
    )

    assert len(null_stats) == 100
    assert len(dropped_counts) == 100
    orig_by_sym = {sym: (bar, side, size, hold) for sym, bar, side, size, hold in entries}

    for d in range(100):
        shifted = captured[d]
        dropped = int(dropped_counts[d])
        assert len(shifted) + dropped == len(entries)
        assert null_stats[d] == float(len(shifted))
        if not shifted:
            continue

        first_sym, first_bar, _, _, _ = shifted[0]
        orig_first_bar = orig_by_sym[first_sym][0]
        s = (first_bar - orig_first_bar) % n_bars

        # Offset is never below min_shift_bars
        assert min_shift_bars <= s <= n_bars - min_shift_bars

        # Every kept entry has the exact same shift offset
        for sym, bar_p, side, size, hold in shifted:
            orig_b, orig_side, orig_size, orig_hold = orig_by_sym[sym]
            assert bar_p == (orig_b + s) % n_bars
            assert side == orig_side
            assert size == orig_size
            assert hold == orig_hold

        # Relative timing between entries is preserved for kept entries
        for i in range(len(shifted)):
            for j in range(i + 1, len(shifted)):
                sym_i, bp_i = shifted[i][0], shifted[i][1]
                sym_j, bp_j = shifted[j][0], shifted[j][1]
                orig_b_i = orig_by_sym[sym_i][0]
                orig_b_j = orig_by_sym[sym_j][0]
                assert (bp_i - bp_j) % n_bars == (orig_b_i - orig_b_j) % n_bars

        # Drops happen only for windows that wrap past the end
        kept_syms = {sym for sym, _, _, _, _ in shifted}
        for sym, orig_b, _, _, orig_hold in entries:
            bp = (orig_b + s) % n_bars
            wraps = bp + orig_hold > n_bars
            if wraps:
                assert sym not in kept_syms
            else:
                assert sym in kept_syms


def test_clustered_entry_joint_shift_vs_old_null() -> None:
    """Clustered-entry case where old independent null is anti-conservative and joint shift is not:

    - 10 correlated zero-drift coins (rho 0.7) on 5,000 hourly bars.
    - Clustered entries on the same 20 bars across all coins, 8-bar hold.
    - Over 200 seeds, share with p_value < 0.05 under joint_shift_null is at most 0.10.
    - Record the same share under random_entry_null in a printed message.
    """
    n_coins = 10
    n_bars = 5000
    rho = 0.7
    hold_bars = 8
    cluster_bars = [100 + i * 200 for i in range(20)]
    coins = [f"c{i}" for i in range(n_coins)]
    sym_idx = {f"c{i}": i for i in range(n_coins)}
    entries = [(sym, b, "long", 1.0, hold_bars) for b in cluster_bars for sym in coins]

    eligible = {f"c{i}": np.arange(n_bars - hold_bars) for i in range(n_coins)}
    n_by_symbol = {f"c{i}": len(cluster_bars) for i in range(n_coins)}

    n_seeds = 200
    n_draws = 500
    p_joint_sig = 0
    p_old_sig = 0

    for sim_seed in range(n_seeds):
        rng = np.random.default_rng(sim_seed)
        market = rng.standard_normal(n_bars)
        idio = rng.standard_normal((n_bars, n_coins))
        returns = math.sqrt(rho) * market[:, None] + math.sqrt(1.0 - rho) * idio
        cum = np.vstack([np.zeros((1, n_coins)), np.cumsum(returns, axis=0)])

        def eval_joint(shifted: list[tuple[str, int, str, float, int]], cum: np.ndarray = cum) -> float:
            if not shifted:
                return 0.0
            tot = 0.0
            for sym, bp, side, _, h in shifted:
                c = sym_idx[sym]
                ret = cum[bp + h, c] - cum[bp, c]
                tot += ret if side == "long" else -ret
            return tot / len(shifted)

        def eval_old(entry_list: list[tuple[str, int, str]], cum: np.ndarray = cum) -> float:
            if not entry_list:
                return 0.0
            tot = 0.0
            for sym, bp, side in entry_list:
                c = sym_idx[sym]
                ret = cum[bp + hold_bars, c] - cum[bp, c]
                tot += ret if side == "long" else -ret
            return tot / len(entry_list)

        obs = eval_joint(entries)

        null_joint, _ = joint_shift_null(
            eval_joint,
            entries,
            n_bars=n_bars,
            min_shift_bars=50,
            n_draws=n_draws,
            seed=sim_seed + 10000,
        )
        if p_value(obs, null_joint) < 0.05:
            p_joint_sig += 1

        null_old = random_entry_null(
            eval_old,
            eligible,
            n_by_symbol,
            hold_bars=hold_bars,
            side_share=1.0,
            n_draws=n_draws,
            seed=sim_seed + 20000,
        )
        if p_value(obs, null_old) < 0.05:
            p_old_sig += 1

    share_joint = p_joint_sig / n_seeds
    share_old = p_old_sig / n_seeds

    print(
        f"\nClustered-entry null comparison over {n_seeds} seeds: "
        f"joint_shift_null share(p < 0.05) = {share_joint:.3f}, "
        f"random_entry_null share(p < 0.05) = {share_old:.3f}"
    )

    assert share_joint <= 0.10


def test_hansen_spa() -> None:
    """Hansen (2005) SPA test verification:

    - With K = 20 zero-mean iid columns (T = 1,000), share of p below 0.05 over 100 seeds <= 0.10.
    - With one column given mean 0.2 SD and 19 noise columns, p below 0.05 in >= 80 of 100 seeds.
    - Deterministic for a given seed.
    """
    n_reps = 250
    block_len = 5.0
    t_len = 1000
    k_cols = 20

    # 1. Null distribution calibration
    sig_count_null = 0
    for seed in range(100):
        rng = np.random.default_rng(seed)
        matrix = rng.standard_normal((t_len, k_cols))
        _, p = hansen_spa(matrix, n_reps=n_reps, mean_block_len=block_len, seed=seed + 500)
        if p < 0.05:
            sig_count_null += 1

    share_null = sig_count_null / 100
    assert share_null <= 0.10

    # 2. Power test: one column has mean 0.2 SD
    sig_count_power = 0
    for seed in range(100):
        rng = np.random.default_rng(seed + 1000)
        matrix = rng.standard_normal((t_len, k_cols))
        matrix[:, 0] += 0.2
        _, p = hansen_spa(matrix, n_reps=n_reps, mean_block_len=block_len, seed=seed + 1500)
        if p < 0.05:
            sig_count_power += 1

    assert sig_count_power >= 80

    # 3. Determinism
    rng = np.random.default_rng(999)
    matrix = rng.standard_normal((t_len, k_cols))
    t1, p1 = hansen_spa(matrix, n_reps=100, mean_block_len=block_len, seed=42)
    t2, p2 = hansen_spa(matrix, n_reps=100, mean_block_len=block_len, seed=42)
    assert t1 == t2
    assert p1 == p2


def test_drift_free_trade_returns() -> None:
    """Verify drift_free_trade_returns and coin_mean_hourly."""
    # 1. Hand computation comparison
    sides = ["long", "short"]
    gross_log_returns = [0.03, -0.01]
    hold_hours = [10.0, 5.0]
    m = 0.001
    costs = [0.0005, 0.0005]

    # Expected:
    # Long:  1.0 * (0.03 - 0.001 * 10.0) - 0.0005 = 0.0195
    # Short: -1.0 * (-0.01 - 0.001 * 5.0) - 0.0005 = -1.0 * (-0.015) - 0.0005 = 0.0145
    res = drift_free_trade_returns(sides, gross_log_returns, hold_hours, m, costs)
    assert np.allclose(res, [0.0195, 0.0145])

    # Also test numeric sides (+1, -1)
    res_num = drift_free_trade_returns([1, -1], gross_log_returns, hold_hours, m, costs)
    assert np.allclose(res_num, [0.0195, 0.0145])

    # 2. Long-only set of trades on a coin whose drift is only source of return
    rng = np.random.default_rng(42)
    m_coin = 0.002
    n_trades = 1000
    hold = 10.0

    hourly_noise = rng.normal(0.0, 0.005, size=(n_trades, int(hold)))
    hourly_returns = m_coin + hourly_noise
    trade_gross_returns = np.sum(hourly_returns, axis=1)

    raw_returns = trade_gross_returns
    df_returns = drift_free_trade_returns(
        np.ones(n_trades),
        trade_gross_returns,
        hold_hours=hold,
        coin_mean_hourly=m_coin,
        costs=0.0,
    )

    raw_mean = float(np.mean(raw_returns))
    df_mean = float(np.mean(df_returns))
    assert raw_mean > 0.015
    assert abs(df_mean) < 0.0015

    # 3. coin_mean_hourly behavior
    assert abs(coin_mean_hourly([0.01, 0.02, 0.03]) - 0.02) < 1e-9
    assert abs(coin_mean_hourly([0.01, np.nan, 0.03]) - 0.02) < 1e-9
    assert math.isnan(coin_mean_hourly([np.nan, np.nan]))
    assert math.isnan(coin_mean_hourly([]))
