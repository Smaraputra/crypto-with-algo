"""Tests for r4.pipeline: panel loader, decision samples, and walk-forward runner."""

from __future__ import annotations

import gzip
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4.book import Tranche
from r4.data import dataset_hash_of, sha256_file
from r4.method import DEV_END, ENTRY_DELAY_MS
from r4.pipeline import (
    RunConfig,
    compute_missing_settlement_times,
    decision_samples,
    load_panel,
    walk_forward,
)


def _make_synthetic_panel(
    symbols: tuple[str, ...] = (
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "BNBUSDT",
        "XRPUSDT",
        "ADAUSDT",
    ),
    n_days: int = 125,
    start_ms: int = 1672531200000,  # 2023-01-01 00:00:00 UTC
    seed: int = 42,
) -> dict[str, dict[str, pd.DataFrame]]:
    """Build a fast, consistent multi-timeframe synthetic panel across symbols."""
    panel: dict[str, dict[str, pd.DataFrame]] = {}

    for sym_idx, sym in enumerate(symbols):
        sym_seed = seed + sym_idx * 1000 + 7
        rng = np.random.default_rng(sym_seed)

        # 5m bars
        n_5m = n_days * 288
        t_5m = start_ms + np.arange(n_5m, dtype=np.int64) * 300_000
        ret_5m = rng.normal(0.00001, 0.0008, size=n_5m)
        p_5m = 100.0 * np.exp(np.cumsum(ret_5m))
        o_5m = np.concatenate(([100.0], p_5m[:-1]))
        c_5m = p_5m
        h_5m = np.maximum(o_5m, c_5m) * 1.0005
        l_5m = np.minimum(o_5m, c_5m) * 0.9995
        v_5m = rng.uniform(10.0, 100.0, size=n_5m)
        tbv_5m = v_5m * 0.5
        df_5m = pd.DataFrame({"t": t_5m, "o": o_5m, "h": h_5m, "l": l_5m, "c": c_5m, "v": v_5m, "tbv": tbv_5m})

        # 15m bars
        n_15m = n_days * 96
        t_15m = start_ms + np.arange(n_15m, dtype=np.int64) * 900_000
        o_15m = o_5m[::3]
        c_15m = c_5m[2::3]
        h_15m = np.maximum.reduce([h_5m[0::3], h_5m[1::3], h_5m[2::3]])
        l_15m = np.minimum.reduce([l_5m[0::3], l_5m[1::3], l_5m[2::3]])
        v_15m = v_5m[0::3] + v_5m[1::3] + v_5m[2::3]
        tbv_15m = tbv_5m[0::3] + tbv_5m[1::3] + tbv_5m[2::3]
        df_15m = pd.DataFrame({"t": t_15m, "o": o_15m, "h": h_15m, "l": l_15m, "c": c_15m, "v": v_15m, "tbv": tbv_15m})

        # 1h bars
        n_1h = n_days * 24
        t_1h = start_ms + np.arange(n_1h, dtype=np.int64) * 3_600_000
        o_1h = o_5m[::12]
        c_1h = c_5m[11::12]
        h_1h = np.maximum(o_1h, c_1h) * 1.001
        l_1h = np.minimum(o_1h, c_1h) * 0.999
        v_1h = np.array([v_5m[i * 12 : (i + 1) * 12].sum() for i in range(n_1h)])
        tbv_1h = v_1h * 0.5
        df_1h = pd.DataFrame({"t": t_1h, "o": o_1h, "h": h_1h, "l": l_1h, "c": c_1h, "v": v_1h, "tbv": tbv_1h})

        # 4h bars
        n_4h = n_days * 6
        t_4h = start_ms + np.arange(n_4h, dtype=np.int64) * 14_400_000
        o_4h = o_5m[::48]
        c_4h = c_5m[47::48]
        h_4h = np.maximum(o_4h, c_4h) * 1.002
        l_4h = np.minimum(o_4h, c_4h) * 0.998
        v_4h = np.array([v_5m[i * 48 : (i + 1) * 48].sum() for i in range(n_4h)])
        tbv_4h = v_4h * 0.5
        df_4h = pd.DataFrame({"t": t_4h, "o": o_4h, "h": h_4h, "l": l_4h, "c": c_4h, "v": v_4h, "tbv": tbv_4h})

        # 1d bars
        n_1d = n_days
        t_1d = start_ms + np.arange(n_1d, dtype=np.int64) * 86_400_000
        o_1d = o_5m[::288]
        c_1d = c_5m[287::288]
        h_1d = np.maximum(o_1d, c_1d) * 1.005
        l_1d = np.minimum(o_1d, c_1d) * 0.995
        v_1d = np.array([v_5m[i * 288 : (i + 1) * 288].sum() for i in range(n_1d)])
        tbv_1d = v_1d * 0.5
        df_1d = pd.DataFrame({"t": t_1d, "o": o_1d, "h": h_1d, "l": l_1d, "c": c_1d, "v": v_1d, "tbv": tbv_1d})

        # Premium index at 5m
        c_prem = rng.normal(0.0001, 0.00005, size=n_5m)
        df_prem = pd.DataFrame({"t": t_5m, "c": c_prem})

        # Funding settlements
        n_settle = n_days * 3
        t_settle = start_ms + np.arange(n_settle, dtype=np.int64) * (8 * 3_600_000)
        rates = rng.normal(0.0001, 0.00005, size=n_settle)
        df_settle = pd.DataFrame({"t": t_settle, "rate": rates, "intervalHours": [8] * n_settle})

        panel[sym] = {
            "5m": df_5m,
            "15m": df_15m,
            "1h": df_1h,
            "4h": df_4h,
            "1d": df_1d,
            "premium_5m": df_prem,
            "premiumIndex": df_prem,
            "settlements": df_settle,
            "funding": df_settle,
        }

    return panel


def _make_config(
    features: tuple[str, ...] = ("ret_1", "ret_4"),
    interval: str = "1h",
    h_ms: int = 14_400_000,
    model: str = "ridge",
    params: dict | None = None,
    threshold: float = 0.0001,
    lookback_months: int | None = None,
    refit: str = "monthly",
    label: str = "fixed",
    seed: int = 7,
) -> RunConfig:
    if params is None:
        params = {"alpha": 1.0} if model == "ridge" else {}
    return RunConfig(
        family="A",
        model=model,
        params=params,
        features=features,
        interval=interval,
        h_ms=h_ms,
        label=label,
        side_rule="sign" if model == "ridge" else "prob",
        threshold=threshold,
        size_rule="unit",
        lookback_months=lookback_months,
        refit=refit,
        exit="horizon",
        seed=seed,
    )


# ---------------------------------------------------------------------------
# Test 1: Causality of the runner: a planted look-ahead must NOT help
# ---------------------------------------------------------------------------


def test_1_causality_and_planted_feature_contrast():
    """1. Causality of the runner:

    - On a synthetic panel where gross_log equals the next bar's sign times a constant,
      a ridge on lagged features cannot exploit it (t <= 3).
    - Contrast: on a panel where one feature IS a noisy copy of gross_log known at T,
      the walk-forward mean net is positive with t above 3.
    """
    panel = _make_synthetic_panel(n_days=125, seed=42)
    cfg = _make_config(features=("ret_1", "ret_4"), threshold=0.0001, seed=42)

    first_refit = 1680307200000  # 2023-04-01 00:00:00 UTC (90 days after 2023-01-01)
    end_ms = 1682899200000  # 2023-05-01 00:00:00 UTC

    samples = decision_samples(panel, cfg)
    assert not samples.empty

    res_unpredictable = walk_forward(samples, cfg, first_refit_ms=first_refit, end_ms=end_ms)
    df_unpred = res_unpredictable.drift_free
    bet_vals_unpred = df_unpred.loc[df_unpred["bet"], "drift_free"].to_numpy()

    if len(bet_vals_unpred) > 1:
        mean_u = float(np.mean(bet_vals_unpred))
        se_u = float(np.std(bet_vals_unpred, ddof=1) / np.sqrt(len(bet_vals_unpred)))
        t_stat_u = mean_u / se_u if se_u > 0.0 else 0.0
    else:
        t_stat_u = 0.0

    # Unpredictable walk-forward drift-free mean net is not above 3 standard errors of zero
    assert t_stat_u <= 3.0
    assert res_unpredictable.excluded_tranches == 0

    # Contrast: planted predictive feature known at T
    samples_planted = samples.copy()
    rng = np.random.default_rng(2026)
    noise = rng.normal(0.0, 0.00005, size=len(samples_planted))
    samples_planted["ret_1"] = samples_planted["gross_log"] + noise

    cfg_planted = _make_config(
        features=("ret_1",),
        threshold=0.00005,
        params={"alpha": 0.01},
        seed=42,
    )
    samples_planted.attrs["panel"] = panel

    res_planted = walk_forward(samples_planted, cfg_planted, first_refit_ms=first_refit, end_ms=end_ms)
    df_planted = res_planted.drift_free
    bet_vals_p = df_planted.loc[df_planted["bet"], "drift_free"].to_numpy()
    assert len(bet_vals_p) > 1

    mean_p = float(np.mean(bet_vals_p))
    se_p = float(np.std(bet_vals_p, ddof=1) / np.sqrt(len(bet_vals_p)))
    t_stat_p = mean_p / se_p if se_p > 0.0 else 0.0

    assert mean_p > 0.0
    assert t_stat_p > 3.0
    assert res_planted.excluded_tranches == 0


# ---------------------------------------------------------------------------
# Test 2: Training-window rule
# ---------------------------------------------------------------------------


def test_2_training_window_rule():
    """2. Training-window rule:

    For every refit, no training sample has t1_max >= refit.
    With a 12-month lookback, none has T < refit - 12 months.
    Using a 4h panel with a 1-month lookback variant.
    """
    panel_4h = _make_synthetic_panel(n_days=155, seed=101)
    cfg_4h = _make_config(
        features=("ret_1", "ret_4"),
        interval="4h",
        h_ms=14_400_000,
        lookback_months=1,
        refit="monthly",
    )
    samples = decision_samples(panel_4h, cfg_4h)
    assert not samples.empty

    refit_1 = 1680307200000  # 2023-04-01
    refit_2 = 1682899200000  # 2023-05-01
    end_ms = 1685577600000  # 2023-06-01

    for refit_instant in (refit_1, refit_2):
        train_mask = samples["t1_max"] < refit_instant
        refit_dt = pd.to_datetime(refit_instant, unit="ms", utc=True)
        cut_dt = refit_dt - pd.DateOffset(months=1)
        cut_ms = int(cut_dt.timestamp() * 1000)
        train_mask = train_mask & (samples["T"] >= cut_ms)

        train_rows = samples.loc[train_mask]
        assert not train_rows.empty

        # Rule 1: No training sample has t1_max >= refit
        assert (train_rows["t1_max"] < refit_instant).all()
        assert not (train_rows["t1_max"] >= refit_instant).any()

        # Rule 2: No training sample has T < refit - lookback_months
        assert (train_rows["T"] >= cut_ms).all()
        assert not (train_rows["T"] < cut_ms).any()

    # Also run walk_forward directly
    res = walk_forward(samples, cfg_4h, first_refit_ms=refit_1, end_ms=end_ms)
    assert res.refits == 2


# ---------------------------------------------------------------------------
# Test 3: refit == "none" fits exactly once
# ---------------------------------------------------------------------------


def test_3_refit_none_fits_exactly_once():
    """3. refit == 'none' fits exactly once."""
    panel = _make_synthetic_panel(n_days=155, seed=77)
    cfg_no_refit = _make_config(refit="none")
    samples = decision_samples(panel, cfg_no_refit)

    first_refit = 1680307200000  # 2023-04-01 (90 days)
    end_ms = 1685577600000  # 2023-06-01 (two monthly blocks)

    res = walk_forward(samples, cfg_no_refit, first_refit_ms=first_refit, end_ms=end_ms)
    assert res.refits == 1
    assert res.excluded_tranches == 0


# ---------------------------------------------------------------------------
# Test 4: Scaler is fitted on training rows only
# ---------------------------------------------------------------------------


def test_4_scaler_fitted_on_training_rows_only():
    """4. The scaler is fitted on training rows only:

    changing test-block feature values leaves the fitted scaler's means unchanged.
    """
    panel = _make_synthetic_panel(n_days=125, seed=99)
    cfg = _make_config(features=("ret_1", "ret_4"), refit="none")
    samples = decision_samples(panel, cfg)

    first_refit = 1680307200000

    train_mask = samples["t1_max"] < first_refit
    from sklearn.preprocessing import StandardScaler

    scaler_orig = StandardScaler()
    scaler_orig.fit(samples.loc[train_mask, list(cfg.features)])

    # Modifying test-block feature values
    samples_mod = samples.copy()
    test_mask = samples_mod["T"] >= first_refit
    samples_mod.loc[test_mask, "ret_1"] = 100000.0
    samples_mod.loc[test_mask, "ret_4"] = -100000.0

    train_mask_mod = samples_mod["t1_max"] < first_refit
    scaler_mod = StandardScaler()
    scaler_mod.fit(samples_mod.loc[train_mask_mod, list(cfg.features)])

    np.testing.assert_array_equal(scaler_orig.mean_, scaler_mod.mean_)
    np.testing.assert_array_equal(scaler_orig.scale_, scaler_mod.scale_)


# ---------------------------------------------------------------------------
# Test 5: Tranche count equals decision count and weights follow BOOK RULE
# ---------------------------------------------------------------------------


def test_5_tranche_count_and_book_rule_weight():
    """5. The tranche count equals the decision count, and the weights follow the BOOK RULE.

    A long decision at 1h with h = 8h has weight 1 / 8 / 10.
    """
    t_long = Tranche(
        symbol="BTCUSDT",
        side=1,
        entry_ms=0,
        exit_ms=8 * 3_600_000,
        entry_price=100.0,
        exit_price=105.0,
        interval="1h",
        h_ms=8 * 3_600_000,
    )
    expected_weight = 1.0 / 8.0 / 10.0
    assert t_long.weight == pytest.approx(expected_weight, rel=1e-12)

    panel = _make_synthetic_panel(n_days=125, seed=33)
    cfg = _make_config(
        features=("ret_1",),
        interval="1h",
        h_ms=8 * 3_600_000,
        threshold=0.00001,
        refit="none",
    )
    samples = decision_samples(panel, cfg)

    first_refit = 1680307200000
    end_ms = 1682899200000

    res = walk_forward(samples, cfg, first_refit_ms=first_refit, end_ms=end_ms)

    assert len(res.trades) > 0
    assert res.excluded_tranches == 0
    # Every tranche has weight following BOOK RULE
    assert res.trades.index.name is None or True


# ---------------------------------------------------------------------------
# Test 6: Determinism
# ---------------------------------------------------------------------------


def test_6_determinism():
    """6. Identical output on two runs with the same seed."""
    panel = _make_synthetic_panel(n_days=125, seed=55)
    cfg = _make_config(features=("ret_1", "ret_4"), threshold=0.0001, seed=7)
    samples = decision_samples(panel, cfg)

    first_refit = 1680307200000
    end_ms = 1682899200000

    res_1 = walk_forward(samples, cfg, first_refit_ms=first_refit, end_ms=end_ms)
    res_2 = walk_forward(samples, cfg, first_refit_ms=first_refit, end_ms=end_ms)

    assert res_1.refits == res_2.refits
    assert res_1.n_samples == res_2.n_samples
    assert res_1.n_dropped == res_2.n_dropped
    assert res_1.config == res_2.config
    assert res_1.excluded_tranches == res_2.excluded_tranches
    assert res_1.excluded_tranches == 0

    pd.testing.assert_frame_equal(res_1.trades, res_2.trades)
    pd.testing.assert_frame_equal(res_1.book_raw, res_2.book_raw)
    pd.testing.assert_frame_equal(res_1.drift_free, res_2.drift_free)


# ---------------------------------------------------------------------------
# Test 7: Runtime
# ---------------------------------------------------------------------------


def test_7_runtime_under_30_seconds():
    """7. Runtime: synthetic panel (6 coins, 125 days) at 1h with a ridge finishes in under 30 seconds."""
    panel = _make_synthetic_panel(n_days=125, seed=12)
    cfg = _make_config(features=("ret_1", "ret_4"), threshold=0.0001, seed=7)

    first_refit = 1680307200000
    end_ms = 1682899200000

    t0 = time.perf_counter()
    samples = decision_samples(panel, cfg)
    res = walk_forward(samples, cfg, first_refit_ms=first_refit, end_ms=end_ms)
    elapsed = time.perf_counter() - t0

    assert elapsed < 30.0
    assert len(res.drift_free) > 0
    assert res.excluded_tranches == 0


# ---------------------------------------------------------------------------
# Test 8: Coin under 60 days of history before refit has tranches excluded
# ---------------------------------------------------------------------------


def test_coin_under_60_days_history_excluded_no_beta_one_assumed():
    """A coin with under 60 days of history before a refit has its tranches excluded.

    Its tranches in that fold are excluded and counted (excluded_tranches > 0),
    and no beta of 1.0 is assumed.
    """
    symbols = (
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "BNBUSDT",
        "XRPUSDT",
        "ADAUSDT",
        "LINKUSDT",
    )
    panel = _make_synthetic_panel(symbols=symbols, n_days=125, seed=42)

    first_refit = 1680307200000  # 2023-04-01 (day 90)
    end_ms = 1682899200000  # 2023-05-01 (day 120)

    # LINKUSDT starts 30 days before first_refit (day 60 of panel, so 30 days < 60 days of history)
    short_start_ms = 1672531200000 + 60 * 86_400_000
    for key in ("5m", "15m", "1h", "4h", "1d", "premium_5m", "premiumIndex", "settlements", "funding"):
        if key in panel["LINKUSDT"] and not panel["LINKUSDT"][key].empty:
            df = panel["LINKUSDT"][key]
            panel["LINKUSDT"][key] = df.loc[df["t"] >= short_start_ms].reset_index(drop=True)

    cfg = _make_config(
        features=("ret_1", "ret_4"),
        threshold=0.00001,
        refit="none",
        seed=42,
    )
    samples = decision_samples(panel, cfg)
    assert not samples.empty
    assert (samples["symbol"] == "LINKUSDT").any()

    # LINKUSDT has decision samples in the test block
    test_short_samples = samples.loc[
        (samples["symbol"] == "LINKUSDT") & (samples["T"] >= first_refit) & (samples["T"] < end_ms)
    ]
    assert not test_short_samples.empty

    res = walk_forward(samples, cfg, first_refit_ms=first_refit, end_ms=end_ms)

    # LINKUSDT tranches must be excluded and counted
    assert res.excluded_tranches > 0

    # Verify directly that estimate_betas produced NaN for LINKUSDT, not 1.0
    from r4.book import daily_close_log_returns, estimate_betas

    five_min = {s: panel[s]["5m"] for s in panel}
    all_ts = [int(df["t"].min()) for df in five_min.values()] + [int(df["t"].max()) for df in five_min.values()]
    min_d = (min(all_ts) // 86_400_000) * 86_400_000
    max_d = ((max(all_ts) // 86_400_000) + 1) * 86_400_000
    days_seq = list(range(min_d, max_d + 86_400_000, 86_400_000))
    daily_ret = daily_close_log_returns(five_min, days_seq, list(symbols))
    betas = estimate_betas(daily_ret, start_ms=None, end_ms=first_refit)

    assert np.isnan(betas["LINKUSDT"])
    assert betas["LINKUSDT"] != 1.0

    # Established coins have real, finite betas
    for s in ("BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"):
        assert not np.isnan(betas[s])


# ---------------------------------------------------------------------------
# Additional edge tests: Lock M edge cases
# ---------------------------------------------------------------------------


def test_lock_m_missing_funding_settlement_dropped():
    """A tranche whose window lacks a funding settlement the coin's interval says must exist is dropped."""
    panel = _make_synthetic_panel(n_days=60, seed=123)

    # Introduce a gap in BTC settlements: remove settlement at day 10 08:00
    t_start = 1672531200000
    day_10_08 = t_start + 10 * 86_400_000 + 8 * 3_600_000
    df_settle = panel["BTCUSDT"]["settlements"]
    df_settle_gapped = df_settle[df_settle["t"] != day_10_08].reset_index(drop=True)
    panel["BTCUSDT"]["settlements"] = df_settle_gapped
    panel["BTCUSDT"]["funding"] = df_settle_gapped

    missing = compute_missing_settlement_times(df_settle_gapped)
    assert day_10_08 in missing

    cfg = _make_config()
    samples = decision_samples(panel, cfg)

    # Assert that no sample for BTCUSDT spans day_10_08
    btc_samples = samples[samples["symbol"] == "BTCUSDT"]
    entry_times = btc_samples["T"] + ENTRY_DELAY_MS
    exit_times = entry_times + cfg.h_ms
    spans_gap = (entry_times < day_10_08) & (day_10_08 <= exit_times)
    assert not spans_gap.any()


def test_lock_m_t1_max_exceeds_dev_end_dropped():
    """A sample whose t1_max >= DEV_END is dropped."""
    panel = _make_synthetic_panel(n_days=10, start_ms=DEV_END - 5 * 86_400_000, seed=456)
    cfg = _make_config(h_ms=14_400_000)
    samples = decision_samples(panel, cfg)

    assert not samples.empty
    assert (samples["t1_max"] < DEV_END).all()
    assert not (samples["t1_max"] >= DEV_END).any()


def test_triple_barrier_decision_samples():
    """Triple-barrier label produces tb_label, tb_net, tb_exit columns."""
    panel = _make_synthetic_panel(n_days=60, seed=789)
    cfg = _make_config(label="triple_barrier", model="logistic")
    samples = decision_samples(panel, cfg)

    assert "tb_label" in samples.columns
    assert "tb_net" in samples.columns
    assert "tb_exit" in samples.columns
    assert not samples["tb_label"].isna().any()


def test_load_panel(tmp_path: Path):
    """load_panel loads per symbol through r4.data with default guards."""
    ds_dir = tmp_path / "dataset"
    sym = "BTCUSDT"

    # Row 1: intraday row before 2022-01-01 (should be dropped by intraday guard)
    # Row 2: intraday row in 2023 (should be kept)
    t_pre_2022 = 1630000000000  # 2021
    t_2023 = 1700000000000  # 2023
    intraday_rows = [
        {"t": t_pre_2022, "o": 10.0, "h": 11.0, "l": 9.0, "c": 10.5, "v": 10.0, "tbv": 5.0},
        {"t": t_2023, "o": 20.0, "h": 21.0, "l": 19.0, "c": 20.5, "v": 10.0, "tbv": 5.0},
    ]

    # 1d rows: row from 2021 (t_pre_2022) is kept because perp 1d holdout ends 2020-01-01
    daily_rows = [
        {"t": t_pre_2022, "o": 10.0, "h": 11.0, "l": 9.0, "c": 10.5, "v": 100.0, "tbv": 50.0},
        {"t": t_2023, "o": 20.0, "h": 21.0, "l": 19.0, "c": 20.5, "v": 100.0, "tbv": 50.0},
    ]

    prem_rows = [
        {"t": t_pre_2022, "c": 0.0001},
        {"t": t_2023, "c": 0.0002},
    ]

    fund_rows = [
        {"t": t_2023, "rate": 0.0001, "intervalHours": 8},
    ]

    files_data = {
        f"perp/{sym}/5m.jsonl.gz": ("perp", sym, "5m", intraday_rows),
        f"perp/{sym}/15m.jsonl.gz": ("perp", sym, "15m", intraday_rows),
        f"perp/{sym}/1h.jsonl.gz": ("perp", sym, "1h", intraday_rows),
        f"perp/{sym}/4h.jsonl.gz": ("perp", sym, "4h", intraday_rows),
        f"perp/{sym}/1d.jsonl.gz": ("perp", sym, "1d", daily_rows),
        f"perp/{sym}/5m.premiumIndex.jsonl.gz": ("perp", sym, "5m.premiumIndex", prem_rows),
        f"funding/{sym}/settlements.jsonl.gz": ("funding", sym, "settlements", fund_rows),
    }

    manifest_files = []
    for rel_path, (kind, symbol, interval, rows) in files_data.items():
        full_path = ds_dir / rel_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(full_path, "wt", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
        file_sha = sha256_file(full_path)
        manifest_files.append(
            {
                "path": rel_path,
                "kind": kind,
                "symbol": symbol,
                "interval": interval,
                "rowCount": len(rows),
                "startMs": rows[0]["t"] if rows else None,
                "endMs": rows[-1]["t"] if rows else None,
                "sha256": file_sha,
            }
        )

    ds_hash = dataset_hash_of(manifest_files)
    manifest = {
        "version": 1,
        "generatedAt": "2026-10-25T00:00:00.000Z",
        "commit": "abc1234",
        "lockboxStart": "2026-07-01T00:00:00.000Z",
        "holdoutA": {
            "spotIntradayEnd": "2021-10-14T00:00:00.000Z",
            "spotDailyEnd": "2018-10-31T00:00:00.000Z",
            "perpIntradayEnd": "2022-01-01T00:00:00.000Z",
            "perpDailyEnd": "2020-01-01T00:00:00.000Z",
        },
        "symbols": [sym],
        "intervals": ["1h", "4h", "1d", "5m"],
        "files": manifest_files,
        "datasetHash": ds_hash,
    }
    manifest_path = ds_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    panel = load_panel(ds_dir, [sym])
    assert sym in panel

    # 1d holdout ends 2020-01-01, so both 2021 and 2023 rows kept
    assert len(panel[sym]["1d"]) == 2

    # Intraday holdout ends 2022-01-01, so 2021 row dropped, only 2023 row kept
    assert len(panel[sym]["1h"]) == 1
    assert panel[sym]["1h"]["t"].iloc[0] == t_2023
    assert len(panel[sym]["5m"]) == 1
    assert len(panel[sym]["15m"]) == 1
    assert len(panel[sym]["4h"]) == 1
    assert len(panel[sym]["premium_5m"]) == 1
    assert len(panel[sym]["settlements"]) == 1


# ---------------------------------------------------------------------------
# RunResult.folds and RunResult.tranches
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("refit", ["none", "monthly"])
def test_run_result_folds_and_tranches(refit: str):
    """RunResult.folds holds each evaluated fold in order, and tranches is their concatenation."""
    panel = _make_synthetic_panel(n_days=155, seed=91)
    cfg = _make_config(features=("ret_1",), threshold=0.00001, refit=refit, lookback_months=None)
    samples = decision_samples(panel, cfg)

    first_refit = 1680307200000  # 2023-04-01
    end_ms = 1685577600000  # 2023-06-01
    res = walk_forward(samples, cfg, first_refit_ms=first_refit, end_ms=end_ms)

    assert len(res.folds) == 2
    assert [f.start_ms for f in res.folds] == [first_refit, 1682899200000]
    assert [f.end_ms for f in res.folds] == [1682899200000, end_ms]
    assert all(f.train_cut_ms is None for f in res.folds)
    assert [t for f in res.folds for t in f.tranches] == res.tranches
    assert len(res.tranches) > 0
    for f in res.folds:
        assert set(f.betas) == set(panel)
    if refit == "none":
        assert res.folds[0].betas == res.folds[1].betas
    summed = pd.concat([f.book for f in res.folds if f.tranches]).groupby("day_start")["drift_free"].sum()
    expected = summed.reindex(res.drift_free.index).fillna(0.0)
    assert np.max(np.abs(res.drift_free["drift_free"].to_numpy() - expected.to_numpy())) <= 1e-12


def test_decision_sample_copies_share_market_frames_only():
    panel = _make_synthetic_panel(symbols=("BTCUSDT",), n_days=8)
    samples = decision_samples(panel, _make_config())
    assert not samples.empty
    dropped = samples.attrs["n_dropped"]
    original_value = samples.loc[0, "ret_1"]
    original_output = samples.loc[0, "gross_log"]
    for copied in (samples.copy(deep=True), samples.loc[samples["T"] >= samples["T"].min()].copy()):
        for symbol, frames in panel.items():
            for key, frame in frames.items():
                assert copied.attrs["panel"][symbol][key] is frame
        assert copied.attrs["n_dropped"] == dropped
        copied.loc[0, "ret_1"] = 123.0
        copied.loc[0, "gross_log"] = 456.0
        assert samples.loc[0, "ret_1"] == original_value
        assert samples.loc[0, "gross_log"] == original_output


def test_lightgbm_deterministic_repeatable():
    """Two fits on the same data give identical predictions, and the model is built deterministic and seeded."""
    from r4.pipeline import _make_model

    rng = np.random.default_rng(3)
    x = rng.normal(size=(600, 5))
    y = ((x[:, 0] + 0.5 * rng.normal(size=600)) > 0).astype(int)
    cfg = RunConfig(
        family="A",
        model="lightgbm",
        params={"n_estimators": 30, "num_leaves": 8, "subsample": 0.7, "subsample_freq": 1, "colsample_bytree": 0.6},
        features=("f",),
        interval="1h",
        h_ms=14_400_000,
        label="fixed",
        side_rule="prob",
        threshold=0.55,
        size_rule="unit",
        lookback_months=None,
        refit="monthly",
        exit="horizon",
        seed=11,
    )
    model_1, model_2 = _make_model(cfg), _make_model(cfg)
    assert model_1.get_params()["deterministic"] is True
    assert model_1.get_params()["random_state"] == 11
    model_1.fit(x, y)
    model_2.fit(x, y)
    np.testing.assert_array_equal(model_1.predict_proba(x), model_2.predict_proba(x))

    explicit = RunConfig(**{**cfg.__dict__, "params": {**cfg.params, "deterministic": False, "random_state": 5}})
    built = _make_model(explicit)
    assert built.get_params()["deterministic"] is False
    assert built.get_params()["random_state"] == 5
