"""Brief 33a: Phase 5 family C code against M's text (A5.1). Synthetic data only, nothing reads D."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import cli, family_c, features, method, phase5_c, stats
from r4.causality import assert_future_invariant
from r4.method import DEV_END
from r4.synth import synth_panel, write_synthetic_dataset

H = 3_600_000
DAY = 86_400_000
BAR = 300_000
COMMIT = "c" * 40


def _bars(n_bars: int, start: int = 0, seed: int = 1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    r = rng.normal(0.0, 0.001, size=n_bars)
    c = 100.0 * np.exp(np.cumsum(r))
    o = np.concatenate(([100.0], c[:-1]))
    up = rng.uniform(0.0, 0.0005, size=n_bars)
    dn = rng.uniform(0.0, 0.0005, size=n_bars)
    return pd.DataFrame(
        {
            "t": start + np.arange(n_bars, dtype=np.int64) * BAR,
            "o": o,
            "h": np.maximum(o, c) * (1 + up),
            "l": np.minimum(o, c) * (1 - dn),
            "c": c,
            "v": np.ones(n_bars),
            "tbv": np.ones(n_bars) / 2,
        }
    )


# ---------------------------------------------------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------------------------------------------------


def test_registry_is_the_nine_declared_configurations() -> None:
    configs = family_c.family_c()
    ids = [c["id"] for c in configs]
    assert ids == [
        "C_LHAR_1h",
        "C_LHAR-CJ_1h",
        "C_LHAR-X_1h",
        "C_LHAR_4h",
        "C_LHAR-CJ_4h",
        "C_LHAR-X_4h",
        "C_LHAR_1d",
        "C_LHAR-CJ_1d",
        "C_LHAR-X_1d",
    ]
    for i, c in enumerate(configs):
        assert c["index"] == i
        assert c["family"] == "C" and c["kind"] == "trial" and c["refit"] == "monthly"
        assert c["window"] in family_c.WINDOWS and c["model"] in family_c.MODELS
        assert c["id"] == f"C_{c['model']}_{c['window']}"
        assert c["lookback_months"] == 24
        assert c["first_refit_ms"] == 1_672_531_200_000
        assert c["min_train_windows"] == 500
        assert c["partition_end_ms"] == DEV_END
    assert len({cli.config_hash_of(c) for c in configs}) == 9
    assert family_c.FAMILY_INDEX == 2 and family_c.N_RESERVE == 3
    assert family_c.STAY_OUT_SEED_BASE == 12_100_000 and family_c.REFIT_SEED_BASE == 7_100_000
    assert [c["joint_shift_seed"] for c in configs] == [12_000_000 + i for i in range(9)]


def test_twin_is_the_no_refit_copy() -> None:
    twin = family_c.family_c_twin("C_LHAR-CJ_4h")
    base = family_c.family_c()[4]
    assert twin["id"] == "C_twin_C_LHAR-CJ_4h" and twin["refit"] == "none"
    assert twin["window"] == base["window"] and twin["model"] == base["model"] and twin["index"] == base["index"]
    with pytest.raises(ValueError):
        family_c.family_c_twin("C_nope")


# ---------------------------------------------------------------------------------------------------------------------
# Windows, returns, targets
# ---------------------------------------------------------------------------------------------------------------------


def test_window_values_on_hand_numbers() -> None:
    # One 1h window of 12 bars: open 100 and closes 101, 100, 102, then flat.
    closes = [101.0, 100.0, 102.0] + [102.0] * 9
    opens = [100.0] + closes[:-1]
    df = pd.DataFrame(
        {
            "t": np.arange(12) * BAR,
            "o": opens,
            "h": [max(a, b) + 0.5 for a, b in zip(opens, closes, strict=True)],
            "l": [min(a, b) - 0.5 for a, b in zip(opens, closes, strict=True)],
            "c": closes,
        }
    )
    win, info = family_c.window_table(df, H)
    r = [math.log(101 / 100), math.log(100 / 101), math.log(102 / 100)] + [0.0] * 9
    assert win.index.tolist() == [0]
    assert win.loc[0, "RV"] == pytest.approx(sum(x * x for x in r))
    bpv = (math.pi / 2) * (abs(r[1]) * abs(r[0]) + abs(r[2]) * abs(r[1]))
    assert win.loc[0, "BPV"] == pytest.approx(bpv)
    assert win.loc[0, "R"] == pytest.approx(math.log(102 / 100))
    assert win.loc[0, "G"] == pytest.approx(math.log(df["h"].max() / df["l"].min()))
    assert info["n_incomplete"] == 0


def test_window_alignment_and_the_n_w_rule() -> None:
    # Bars from 02:00 UTC: the 4h window [00:00, 04:00) has 24 of 48 bars and is dropped, [04:00, 08:00) is complete.
    start = 2 * H
    df = _bars(48 * 3, start=start)
    win, info = family_c.window_table(df, 4 * H)
    assert all(t % (4 * H) == 0 for t in win.index)
    assert np.isnan(win.loc[0, "RV"])
    assert win.loc[4 * H, "RV"] > 0 and win.loc[8 * H, "RV"] > 0
    assert info["n_incomplete"] >= 1
    # Remove one bar from an hourly window.
    full = _bars(36)
    gap = full.drop(index=15).reset_index(drop=True)
    w1, i1 = family_c.window_table(gap, H)
    assert np.isnan(w1.loc[H, "RV"]) and np.isfinite(w1.loc[0, "RV"]) and np.isfinite(w1.loc[2 * H, "RV"])
    assert i1["n_incomplete"] == 1
    # Window starts at every UTC hour for 1h and 00:00 for 1d.
    d1, _ = family_c.window_table(_bars(288 * 3, start=DAY), DAY)
    assert d1.index.tolist() == [DAY, 2 * DAY, 3 * DAY]


def test_rv5_convention_matches_features() -> None:
    syms = ["BTCUSDT", "ETHUSDT"]
    cov = np.array([[0.0016, 0.0008], [0.0008, 0.0025]])
    panel = synth_panel(cov, syms, DEV_END - 6 * DAY, DEV_END, seed=3)
    d = panel["BTCUSDT"]
    win, _ = family_c.window_table(d["5m"], H)
    opens = [DEV_END - 6 * DAY + k * H for k in (5, 40, 77, 120)]
    feats = features.intrabar_features(d["5m"], d["15m"], H, opens)
    for t_b in opens:
        row = feats.loc[t_b + H]
        assert win.loc[t_b, "RV"] == pytest.approx(row["rv5"], rel=1e-12)
        assert win.loc[t_b, "BPV"] == pytest.approx(row["bpv5"], rel=1e-12)


def test_windows_at_the_partition_end_are_dropped() -> None:
    df = _bars(12 * 5)
    win, info = family_c.window_table(df, H, end_ms=4 * H)
    # t1 = T + W: windows 0, 1, 2 end at 1h, 2h, 3h (kept), window 3 ends at 4h = end (dropped), window 4 too.
    assert np.isfinite(win.loc[: 2 * H, "RV"]).all()
    assert np.isnan(win.loc[3 * H, "RV"]) and np.isnan(win.loc[4 * H, "RV"])
    assert info["n_partition_end"] == 2


# ---------------------------------------------------------------------------------------------------------------------
# Components, exogenous terms, designs, benchmarks
# ---------------------------------------------------------------------------------------------------------------------


def _synthetic_windows(n: int = 1000) -> pd.DataFrame:
    rv = np.arange(1, n + 1, dtype=float) * 1e-4
    return pd.DataFrame(
        {"RV": rv, "BPV": rv * 0.5, "R": np.zeros(n), "G": np.zeros(n)},
        index=pd.Index(np.arange(n, dtype=np.int64) * H, name="T"),
    )


def test_components_use_complete_earlier_windows_only() -> None:
    win = _synthetic_windows()
    p = 800
    comp = family_c.component_frame(win, H, [p * H])
    rv = win["RV"].to_numpy()
    row = comp.loc[p * H]
    assert row["rv_prev"] == rv[p - 1]
    assert row["rv_1d"] == pytest.approx(rv[p - 24 : p].mean())
    assert row["rv_7d"] == pytest.approx(rv[p - 168 : p].mean())
    assert row["rv_30d"] == pytest.approx(rv[p - 720 : p].mean())
    assert row["c_30d"] == pytest.approx(0.5 * rv[p - 720 : p].mean())
    assert row["j_7d"] == pytest.approx(0.5 * rv[p - 168 : p].mean())
    # A gap inside the 7-day span drops the 7d and 30d components only.
    holed = win.copy()
    holed.iloc[p - 100] = np.nan
    row = family_c.component_frame(holed, H, [p * H]).loc[p * H]
    assert np.isfinite(row["rv_1d"]) and np.isnan(row["rv_7d"]) and np.isnan(row["rv_30d"])


def test_ewma_forecast_by_hand() -> None:
    vals = np.arange(1.0, 21.0)
    vals[10] = np.nan
    rv = pd.Series(vals, index=np.arange(20) * H)
    out = family_c.ewma_forecast(rv)
    alpha = 1 - 0.5 ** (1 / 7)
    assert np.isnan(out.iloc[:7]).all()
    state = np.mean(vals[:7])
    assert out.iloc[7] == pytest.approx(state)
    state = alpha * vals[7] + (1 - alpha) * state
    assert out.iloc[8] == pytest.approx(state)
    state = alpha * vals[8] + (1 - alpha) * state
    state = alpha * vals[9] + (1 - alpha) * state
    assert out.iloc[10] == pytest.approx(state)
    assert out.iloc[11] == pytest.approx(state)  # the NaN window leaves the state alone
    assert method.BAR_FORECAST["ewma_halflife_windows"] == 7


def test_persistence_is_floored() -> None:
    comp = pd.DataFrame({"rv_prev": [0.0, 2e-4, np.nan]})
    out = family_c.persistence_forecast(comp)
    assert out.iloc[0] == family_c.LOG_FLOOR and out.iloc[1] == 2e-4 and np.isnan(out.iloc[2])


def test_exog_terms_and_their_closing_rules() -> None:
    settle = pd.DataFrame({"t": [0, 28_800_000], "rate": [-0.001, 0.002]})
    prem = pd.DataFrame({"t": [28_800_000 - BAR, 28_800_000 + 3 * H - BAR], "c": [-0.003, 0.004]})
    btc = pd.DataFrame(
        {"RV": [1e-4, 2e-4, 3e-4, 4e-4], "BPV": 0.0, "R": 0.0, "G": 0.0}, index=pd.Index([0, H, 2 * H, 3 * H], name="T")
    )
    t_ok = 28_800_000
    t_edge = 28_800_000 + 8 * H + 60_000
    t_old = t_edge + 1
    ex = family_c.exog_frame([t_ok, t_edge, t_old], H, settle, prem, btc)
    assert ex.loc[t_ok, "abs_fund"] == pytest.approx(0.002)
    assert ex.loc[t_edge, "abs_fund"] == pytest.approx(0.002)
    assert np.isnan(ex.loc[t_old, "abs_fund"])
    assert ex.loc[t_ok, "abs_prem"] == pytest.approx(0.003)
    assert np.isnan(ex.loc[t_edge, "abs_prem"])  # no premium bar at T - 5m
    ex2 = family_c.exog_frame([2 * H, 3 * H], H, settle, prem, btc)
    assert ex2.loc[3 * H, "btc_lrv_prev"] == pytest.approx(math.log(3e-4))
    assert ex2.loc[2 * H, "btc_lrv_prev"] == pytest.approx(math.log(2e-4))
    # Before any settlement: missing.
    assert np.isnan(family_c.exog_frame([-H], H, settle, prem, btc).loc[-H, "abs_fund"])


@pytest.mark.parametrize(
    ("model", "window", "is_btc", "n_cols"),
    [
        ("LHAR", "1h", False, 5),
        ("LHAR", "1d", False, 4),
        ("LHAR-CJ", "4h", False, 8),
        ("LHAR-CJ", "1d", False, 7),
        ("LHAR-X", "1h", False, 8),
        ("LHAR-X", "1h", True, 7),
        ("LHAR-X", "1d", False, 7),
    ],
)
def test_design_columns(model: str, window: str, is_btc: bool, n_cols: int) -> None:
    win = _synthetic_windows(1000)
    T = win.index.to_numpy()[800:803]
    comp = family_c.component_frame(win, H, T)
    ex = pd.DataFrame({"abs_fund": 1e-4, "abs_prem": 2e-4, "btc_lrv_prev": -9.0}, index=comp.index)
    x = family_c.design(comp, ex, model, window, is_btc)
    assert x.shape == (3, n_cols)
    assert (x["const"] == 1.0).all()
    assert ("btc_lrv_prev" in x.columns) == (model == "LHAR-X" and not is_btc)
    if model == "LHAR-CJ":
        row = comp.iloc[0]
        assert x.iloc[0]["lj_prev"] == pytest.approx(math.log(1 + row["j_prev"] / row["c_prev"]))
    if window == "1d":
        assert not any("1d" in c for c in x.columns)


def test_design_floors_the_logs() -> None:
    comp = pd.DataFrame(
        {
            "rv_prev": [0.0],
            "rv_1d": [1.0],
            "rv_7d": [1.0],
            "rv_30d": [1.0],
        }
    )
    x = family_c.design(comp, pd.DataFrame(index=comp.index), "LHAR", "1h", False)
    assert x.iloc[0]["lrv_prev"] == pytest.approx(math.log(1e-12))


# ---------------------------------------------------------------------------------------------------------------------
# Walk-forward
# ---------------------------------------------------------------------------------------------------------------------


def test_refit_times_and_lookback() -> None:
    jan = 1_672_531_200_000  # 2023-01-01
    t = family_c.refit_times(jan, jan + 90 * DAY)
    assert t[0] == jan and len(t) == 3
    assert t[1] == jan + 31 * DAY and t[2] == jan + 59 * DAY
    assert family_c.refit_times(jan, jan) == []
    mid = family_c.refit_times(jan + 14 * DAY, jan + 70 * DAY)
    assert mid == [jan + 14 * DAY, jan + 31 * DAY, jan + 59 * DAY]
    two_years_on = 1_735_689_600_000  # 2025-01-01
    assert family_c.lookback_start(two_years_on, 24) == jan
    assert family_c.lookback_start(two_years_on, None) is None


def _const_x(n: int) -> tuple[pd.DataFrame, pd.Series, pd.Series]:
    idx = pd.Index(np.arange(n, dtype=np.int64) * H, name="T")
    return pd.DataFrame({"const": np.ones(n)}, index=idx), pd.Series(1.0, index=idx), pd.Series(0.0, index=idx)


def test_fit_fold_training_windows_and_minimum() -> None:
    x, rv, big_r = _const_x(200)
    refit = 150 * H
    fit = family_c.fit_fold(x, rv, big_r, H, refit, None, 1)
    assert fit is not None
    # t1 = T + W must be below the refit: T <= 148 h, so 149 windows (0..148).
    assert fit["n_train"] == 149
    fit = family_c.fit_fold(x, rv, big_r, H, refit, None, 150)
    assert fit is None
    # Lookback of one month starts the training at refit minus one calendar month.
    long_x, long_rv, long_r = _const_x(24 * 90)
    refit2 = 24 * 80 * H
    fit = family_c.fit_fold(long_x, long_rv, long_r, H, refit2, 1, 1)
    lb = family_c.lookback_start(refit2, 1)
    assert lb is not None
    assert fit is not None and fit["n_train"] == (refit2 - 2 * H - lb) // H + 1


def test_fit_fold_ols_retransformation_and_quantiles() -> None:
    rng = np.random.default_rng(11)
    n = 600
    idx = pd.Index(np.arange(n, dtype=np.int64) * H, name="T")
    xv = rng.normal(size=n)
    x = pd.DataFrame({"const": np.ones(n), "x": xv}, index=idx)
    ylog = 0.5 + 0.8 * xv + rng.normal(0, 0.3, size=n)
    rv = pd.Series(np.exp(ylog), index=idx)
    big_r = pd.Series(np.arange(n, dtype=float), index=idx)
    refit = 580 * H
    fit = family_c.fit_fold(x, rv, big_r, H, refit, None, 100)
    assert fit is not None
    m = (idx.to_numpy() + H) < refit
    beta, *_ = np.linalg.lstsq(x.to_numpy()[m], ylog[m], rcond=None)
    assert fit["beta"] == pytest.approx(beta)
    resid = ylog[m] - x.to_numpy()[m] @ beta
    assert fit["s2"] == pytest.approx(float(resid @ resid) / (m.sum() - 2))
    f = family_c.apply_fit(fit, x.iloc[[10]])
    assert f[0] == pytest.approx(math.exp(float(x.iloc[10].to_numpy() @ beta) + fit["s2"] / 2))
    # A row with a missing input has no forecast.
    nan_row = x.iloc[[10]].copy()
    nan_row.iloc[0, 1] = np.nan
    assert np.isnan(family_c.apply_fit(fit, nan_row)).all()
    # Coverage quantiles come from the training z = R / sqrt(f_fit) with numpy linear interpolation.
    f_fit = np.exp(x.to_numpy()[m] @ beta + fit["s2"] / 2)
    z = big_r.to_numpy()[m] / np.sqrt(f_fit)
    assert fit["q"] == pytest.approx(np.quantile(z, [0.10, 0.90, 0.025, 0.975]))


def test_fit_fold_known_quantiles() -> None:
    # A constant RV of 1 gives f_fit = 1, so z = R and the quantiles are those of R (linear interpolation).
    n = 1001
    x, rv, _ = _const_x(n)
    big_r = pd.Series(np.arange(n, dtype=float), index=x.index)
    fit = family_c.fit_fold(x, rv, big_r, H, (n + 1) * H, None, 1)
    assert fit is not None
    assert fit["q"] == pytest.approx([100.0, 900.0, 25.0, 975.0])


# ---------------------------------------------------------------------------------------------------------------------
# Criteria
# ---------------------------------------------------------------------------------------------------------------------


def test_qlike_and_log_mse_on_hand_values() -> None:
    assert family_c.qlike(1.0, 1.0)[()] == pytest.approx(0.0)
    assert family_c.qlike(2.0, 1.0)[()] == pytest.approx(1.0 - math.log(2.0))
    assert family_c.qlike(0.5, 1.0)[()] == pytest.approx(0.5 + math.log(2.0) - 1.0)
    assert family_c.qlike(4.0, 2.0)[()] == pytest.approx(2.0 - math.log(2.0) - 1.0)
    assert family_c.log_mse(math.e**2, 1.0)[()] == pytest.approx(4.0)
    assert family_c.log_mse(3.0, 3.0)[()] == pytest.approx(0.0)
    # A forecast of 0 is floored at 1e-12.
    assert family_c.qlike(1.0, 0.0)[()] == pytest.approx(1e12 - math.log(1e12) - 1.0)
    assert family_c.log_mse(1.0, 0.0)[()] == pytest.approx(math.log(1e-12) ** 2)


def test_dm_statistic_against_a_hand_computation() -> None:
    res = family_c.dm_test([1.0, 2.0, 3.0, 4.0])
    # mean 2.5, centred [-1.5 -0.5 0.5 1.5], gamma0 = 1.25, gamma1 = 1.25 / 4, Bartlett weight 1/2 at lag 1.
    lrv = 1.25 + 2 * 0.5 * (1.25 / 4)
    assert res["stat"] == pytest.approx(2.5 / math.sqrt(lrv / 4))
    assert res["stat"] == pytest.approx(4.0)
    assert res["p"] == pytest.approx(stats.normal_cdf(4.0))
    neg = family_c.dm_test([-1.0, -2.0, -3.0, -4.0])
    assert neg["stat"] == pytest.approx(-4.0) and neg["p"] < 1e-4
    # Undefined statistics: constant, too short, non-finite.
    for bad in ([1.0, 1.0, 1.0], [1.0], [], [1.0, np.nan, 2.0]):
        r = family_c.dm_test(bad)
        assert np.isnan(r["stat"]) and np.isnan(r["p"])


def _coin_frame(n: int, good: bool, seed: int = 0, lo: float = -1.0, hi: float = 1.0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    y = np.exp(rng.normal(0.0, 1.0, size=n)) * 1e-4
    f = y * np.exp(rng.normal(0.0, 0.3, size=n)) if good else np.full(n, 1e-4 * 50)
    return pd.DataFrame(
        {
            "coin": "BTCUSDT",
            "T": np.arange(n) * H,
            "y": y,
            "f": f,
            "persistence": np.concatenate(([np.nan], y[:-1])),
            "ewma": np.full(n, np.exp(0.5) * 1e-4),
            "R": rng.uniform(-1, 1, size=n),
            "G": 0.01,
            "fold": 0,
            "lo80": lo * 0.8,
            "hi80": hi * 0.8,
            "lo95": lo * 0.95,
            "hi95": hi * 0.95,
        }
    )


def test_coverage_on_a_known_series() -> None:
    df = pd.DataFrame(
        {
            "R": np.linspace(-1, 1, 1000),
            "lo80": -0.8,
            "hi80": 0.8,
            "lo95": -0.95,
            "hi95": 0.95,
        }
    )
    c80 = family_c.coverage(df, "80")
    c95 = family_c.coverage(df, "95")
    assert c80["n"] == 1000 and c80["coverage"] == pytest.approx(0.8, abs=0.002)
    assert c95["coverage"] == pytest.approx(0.95, abs=0.002)
    # Rows without bounds or R do not count.
    df.loc[:99, "lo80"] = np.nan
    assert family_c.coverage(df, "80")["n"] == 900


def test_coin_criteria_pass_and_each_way_to_fail() -> None:
    good = family_c.coin_criteria(_coin_frame(3000, True, seed=1))
    assert good["n_paired"] == 2999
    assert all(t["pass"] for t in good["tests"].values()), good["tests"]
    assert set(good["tests"]) == {"qlike_vs_persistence", "qlike_vs_ewma", "logmse_vs_persistence", "logmse_vs_ewma"}
    assert good["coverage"]["80"]["pass"] and good["coverage"]["95"]["pass"]
    assert good["pass"]
    # Coverage off by more than 2 points fails the coin even if the DM tests pass.
    wide = family_c.coin_criteria(_coin_frame(3000, True, seed=1, lo=-1.2, hi=1.2))
    assert not wide["coverage"]["80"]["pass"] and not wide["pass"]
    # A flat poor forecast fails the DM tests.
    bad = family_c.coin_criteria(_coin_frame(3000, False, seed=1))
    assert not bad["pass"] and not bad["tests"]["qlike_vs_ewma"]["pass"]
    # No paired rows: nothing can pass.
    empty = family_c.coin_criteria(_coin_frame(3000, True).assign(f=np.nan))
    assert not empty["pass"] and empty["n_paired"] == 0


def test_pairing_requires_the_configuration_and_both_benchmarks() -> None:
    df = _coin_frame(10, True)
    df.loc[3, "ewma"] = np.nan
    df.loc[4, "f"] = np.nan
    paired = family_c.paired_rows(df)
    assert 3 not in paired.index and 4 not in paired.index and 0 not in paired.index
    assert len(paired) == 10 - 3


def _per_coin(passes: list[bool]) -> dict[str, dict[str, Any]]:
    return {s: {"pass": p, "mean_qlike": 0.1} for s, p in zip(method.UNIVERSE, passes, strict=False)}


def test_eight_of_ten_rule() -> None:
    assert family_c.config_verdict(_per_coin([True] * 8 + [False] * 2))["pass"]
    assert not family_c.config_verdict(_per_coin([True] * 7 + [False] * 3))["pass"]
    # A coin missing from the output fails.
    assert not family_c.config_verdict(_per_coin([True] * 7))["pass"]
    assert family_c.config_verdict(_per_coin([True] * 10))["n_coins_pass"] == 10
    # The universe and threshold can be narrowed for tests.
    small = family_c.config_verdict(_per_coin([True, True, False]), universe=method.UNIVERSE[:3], symbols_min=2)
    assert small["pass"] and small["n_coins"] == 3


def _fin(passing: bool, qlike_by_coin: dict[str, float]) -> dict[str, Any]:
    return {"pass": passing, "coin_qlike": qlike_by_coin}


def test_finalist_is_the_lowest_qlike_among_passing_with_ties_by_registry_order() -> None:
    order = ["a", "b", "c", "d"]
    coins = ("X", "Y")
    v = {
        "a": _fin(True, dict.fromkeys(coins, 0.30)),
        "b": _fin(False, dict.fromkeys(coins, 0.10)),
        "c": _fin(True, dict.fromkeys(coins, 0.20)),
        "d": _fin(True, dict.fromkeys(coins, 0.20)),
    }
    assert family_c.pick_finalist(v, order) == "c"
    assert family_c.pick_finalist(v, ["d", "c", "b", "a"]) == "d"
    assert family_c.pick_finalist({k: {**x, "pass": False} for k, x in v.items()}, order) is None
    v["c"]["coin_qlike"] = dict.fromkeys(coins, float("nan"))
    # A passing configuration without a finite mean on any coin leaves no common support: nothing can be ranked.
    assert family_c.pick_finalist(v, order) is None
    v["c"]["pass"] = False
    assert family_c.pick_finalist(v, order) == "d"


def test_finalist_is_ranked_on_the_common_coin_support() -> None:
    order = ["a", "b"]
    v = {
        "a": _fin(True, {"X": 0.10, "Y": 0.50, "Z": float("nan")}),
        "b": _fin(True, {"X": 0.20, "Y": 0.30, "Z": 0.01}),
    }
    rank = family_c.finalist_ranking(v, order)
    assert rank["support"] == ["X", "Y"]
    assert rank["scores"] == {"a": pytest.approx(0.30), "b": pytest.approx(0.25)}
    assert rank["finalist"] == "b"
    # On b's own three coins its mean is 0.17, on the shared coins 0.25: a (0.30) still loses either way here.
    assert family_c.pick_finalist(v, order) == "b"


# ---------------------------------------------------------------------------------------------------------------------
# Stay-out flag
# ---------------------------------------------------------------------------------------------------------------------


def _stay_rows(elevated_days: set[int], n_days: int = 200, coin: str = "BTCUSDT") -> pd.DataFrame:
    w = 4 * H
    T = np.arange(n_days * 6, dtype=np.int64) * w
    day = T // DAY
    hot = np.isin(day, list(elevated_days))
    sd_f = np.where(hot, 2.0, 1.0)
    sd_y = np.where(hot, 3.0, 1.0)
    return pd.DataFrame({"coin": coin, "T": T, "y": sd_y**2, "f": sd_f**2, "G": 1.0})


def test_flag1_passes_when_high_forecasts_precede_high_realised_volatility() -> None:
    rows = _stay_rows(set(range(100, 200, 17)))
    res = family_c.stay_out_flag(rows, 4 * H, registry_index=7)
    f1 = res["flag1"]
    assert f1["seed"] == 12_100_007
    assert f1["ratio"] == pytest.approx(3.0)
    assert f1["low"] > 1.0 and f1["pass"]
    again = family_c.stay_out_flag(rows, 4 * H, registry_index=7)["flag1"]
    assert again["low"] == f1["low"] and again["high"] == f1["high"]
    # Flagged windows start only after 90 full days of earlier forecasts.
    early = _stay_rows({50, 51})
    f = family_c.stay_out_flag(early, 4 * H, 0)["flag1"]
    assert f["n_flagged"] == 0 and not f["pass"] and f["reason"] == "empty group"


def test_flag1_failure_rules() -> None:
    # No flagged window: constant forecasts never exceed their own percentile.
    flat = _stay_rows(set())
    res = family_c.stay_out_flag(flat, 4 * H, 0)["flag1"]
    assert not res["pass"] and res["reason"] == "empty group"
    # No data at all.
    none = family_c.stay_out_flag(flat.iloc[:0], 4 * H, 0)["flag1"]
    assert not none["pass"] and none["reason"] == "empty group"
    # A single flagged day: bootstrap draws without it have no flagged window, and the condition fails with no redraw.
    one = _stay_rows({150})
    res = family_c.stay_out_flag(one, 4 * H, 0)["flag1"]
    assert res["n_flagged"] > 0 and not res["pass"] and res["reason"] == "degenerate draw"
    # Realised volatility no higher when flagged: the interval is not above 1.
    same = _stay_rows(set(range(100, 200, 17)))
    same["y"] = 1.0
    res = family_c.stay_out_flag(same, 4 * H, 0)["flag1"]
    assert not res["pass"] and res["ratio"] == pytest.approx(1.0)


def test_flag1_zero_denominator_fails() -> None:
    rows = _stay_rows(set(range(100, 200, 17)))
    rows.loc[rows["f"] < 2, "y"] = 0.0
    res = family_c.stay_out_flag(rows, 4 * H, 0)["flag1"]
    assert not res["pass"] and res["reason"] == "zero denominator"


def test_round_trip_uses_the_coin_slippage() -> None:
    from r4 import costs

    assert family_c.round_trip("BTCUSDT") == pytest.approx(2 * (0.0005 + costs.coin_slippage_bps("BTCUSDT") / 1e4))
    assert family_c.round_trip("ADAUSDT") == pytest.approx(0.002)


def _dead_rows(n_flagged: int, n_below: int, coin: str = "BTCUSDT") -> pd.DataFrame:
    g = np.where(np.arange(n_flagged) < n_below, 0.001, 0.01)
    return pd.DataFrame({"coin": coin, "T": np.arange(n_flagged) * H, "y": 1e-6, "f": 1e-6, "G": g})


def test_flag2_share_of_flagged_windows_below_three_round_trips() -> None:
    # sqrt(8 / pi) x 0.001 = 0.0016 < 3 x 0.0012 = 0.0036, so every row is flagged.
    ok = family_c.stay_out_flag(_dead_rows(10, 6), H, 0)["flag2"]
    assert ok["n_flagged"] == 10 and ok["share"] == pytest.approx(0.6) and ok["pass"]
    no = family_c.stay_out_flag(_dead_rows(10, 5), H, 0)["flag2"]
    assert no["share"] == pytest.approx(0.5) and not no["pass"]
    # No flagged window: not met.
    big = _dead_rows(10, 10).assign(f=1e-2)
    res = family_c.stay_out_flag(big, H, 0)["flag2"]
    assert res["n_flagged"] == 0 and not res["pass"]
    # Pooled over coins with their own round trips: ADA's 3 round trips is 0.006.
    pooled = pd.concat([_dead_rows(5, 5, "BTCUSDT"), _dead_rows(5, 0, "ADAUSDT").assign(G=0.005)], ignore_index=True)
    res = family_c.stay_out_flag(pooled, H, 0)["flag2"]
    assert res["n_flagged"] == 10 and res["n_below"] == 10 and res["pass"]


def test_stay_out_passes_only_when_both_conditions_pass() -> None:
    rows = _stay_rows(set(range(100, 200, 17)))
    res = family_c.stay_out_flag(rows, 4 * H, 0)
    assert res["flag1"]["pass"] and not res["flag2"]["pass"] and res["pass"] is False
    dead = _stay_rows(set(range(100, 200, 17))).assign(f=lambda d: np.where(d["f"] > 1, 4e-6, 1e-6), G=0.001)
    res = family_c.stay_out_flag(dead, 4 * H, 0)
    assert res["flag2"]["pass"]


# ---------------------------------------------------------------------------------------------------------------------
# The refit question and H
# ---------------------------------------------------------------------------------------------------------------------


def _refit_rows(n_days: int, twin_bias: float, coin: str = "BTCUSDT") -> tuple[pd.DataFrame, pd.DataFrame]:
    rng = np.random.default_rng(5)
    T = np.arange(n_days * 24, dtype=np.int64) * H
    y = np.exp(rng.normal(0, 0.5, size=len(T)))
    cfg = pd.DataFrame({"coin": coin, "T": T, "y": y, "f": y * np.exp(rng.normal(0, 0.2, size=len(T)))})
    twin = pd.DataFrame({"coin": coin, "T": T, "f": cfg["f"].to_numpy() * twin_bias})
    return cfg, twin


def test_refit_comparison_is_a_descriptive_block_bootstrap() -> None:
    cfg, twin = _refit_rows(150, twin_bias=3.0)
    res = family_c.refit_comparison(cfg, twin, 4)
    assert res["status"] == "descriptive" and res["authorizes_live_refit"] is False
    assert res["seed"] == 7_100_004 and res["alpha"] == 0.10
    diff = family_c.qlike(cfg["y"], twin["f"]) - family_c.qlike(cfg["y"], cfg["f"])
    daily = pd.Series(diff).groupby(cfg["T"].to_numpy() // DAY).mean().to_numpy()
    point, low, high = stats.bootstrap_ci(daily, np.mean, 1000, 10, 7_100_004, alpha=0.10)
    assert (res["point"], res["low"], res["high"]) == (point, low, high)
    assert res["refit_better"] is True and res["n_days"] == 150
    same = family_c.refit_comparison(cfg, cfg.rename(columns={}), 4)
    assert same["point"] == pytest.approx(0.0) and same["refit_better"] is False


def test_untrainable_twin_is_inconclusive() -> None:
    cfg, twin = _refit_rows(10, twin_bias=1.0)
    res = family_c.refit_comparison(cfg, twin.assign(f=np.nan), 6)
    assert res["status"] == "inconclusive" and res["authorizes_live_refit"] is False
    # An untrained twin from the walk-forward (1d window, fewer than 500 windows) has no forecasts.
    n = 40
    start = DEV_END - n * DAY
    panel = synth_panel(np.array([[0.0016]]), ["BTCUSDT"], start, DEV_END, seed=2)
    config = family_c.family_c_twin("C_LHAR_1d") | {"first_refit_ms": start + 30 * DAY}
    fc, counts = family_c.compute_forecasts(panel, config)
    assert counts["untrained_coin_folds"] == 1 and fc["f"].isna().all()
    assert family_c.refit_comparison(fc, fc, 6)["status"] == "inconclusive"


def test_h_procedure_is_a_stub() -> None:
    with pytest.raises(NotImplementedError):
        family_c.run_holdout()


# ---------------------------------------------------------------------------------------------------------------------
# Causality
# ---------------------------------------------------------------------------------------------------------------------


def test_components_exog_ewma_and_fit_are_future_invariant() -> None:
    n_days = 70
    panel = synth_panel(np.array([[0.0016, 0.0008], [0.0008, 0.0025]]), ["BTCUSDT", "ETHUSDT"], 0, n_days * DAY, seed=9)
    eth = panel["ETHUSDT"]
    btc = panel["BTCUSDT"]
    rng = np.random.default_rng(1)
    eth = {
        **eth,
        "premium_5m": eth["premium_5m"].assign(c=rng.normal(0, 1e-3, size=len(eth["premium_5m"]))),
        "settlements": eth["settlements"].assign(rate=rng.normal(1e-4, 5e-5, size=len(eth["settlements"]))),
    }
    Ts = [int(40 * DAY + k * 3 * H) for k in (0, 1, 5, 17)]

    def comp_build(five: pd.DataFrame) -> pd.DataFrame:
        win, _ = family_c.window_table(five, H)
        return family_c.component_frame(win, H, Ts)

    assert_future_invariant(comp_build, (eth["5m"], BAR), Ts)

    def ewma_build(five: pd.DataFrame) -> pd.DataFrame:
        win, _ = family_c.window_table(five, H)
        ext = family_c._extended(win["RV"], H, np.asarray(Ts))
        out = family_c.ewma_forecast(ext).reindex(Ts)
        out.index.name = "T"
        return out.to_frame("ewma")

    assert_future_invariant(ewma_build, (eth["5m"], BAR), Ts)

    def exog_build(five_btc: pd.DataFrame, settle: pd.DataFrame, prem: pd.DataFrame) -> pd.DataFrame:
        win, _ = family_c.window_table(five_btc, H)
        return family_c.exog_frame(Ts, H, settle, prem, win)

    assert_future_invariant(exog_build, [(btc["5m"], BAR), (eth["settlements"], 0), (eth["premium_5m"], BAR)], Ts)

    refit = int(40 * DAY)

    def fit_build(five: pd.DataFrame) -> pd.DataFrame:
        win, _ = family_c.window_table(five, H)
        T_all = win.index.to_numpy()
        comp = family_c.component_frame(win, H, T_all)
        x = family_c.design(comp, pd.DataFrame(index=comp.index), "LHAR", "1h", False)
        fit = family_c.fit_fold(x, win["RV"], win["R"], H, refit, 24, 100)
        assert fit is not None
        row = {f"b{i}": v for i, v in enumerate(fit["beta"])} | {"s2": fit["s2"], "n": fit["n_train"]}
        row |= {f"q{i}": v for i, v in enumerate(fit["q"])}
        return pd.DataFrame([row], index=pd.Index([refit], name="T"))

    assert_future_invariant(fit_build, (eth["5m"], BAR), [refit])


# ---------------------------------------------------------------------------------------------------------------------
# End to end on a synthetic dataset
# ---------------------------------------------------------------------------------------------------------------------

SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]


@pytest.fixture(scope="module")
def e2e(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("fc")
    n_days = 120
    start = DEV_END - n_days * DAY
    cov = np.array([[0.0016, 0.0009, 0.001], [0.0009, 0.0025, 0.0012], [0.001, 0.0012, 0.0036]])
    panel = synth_panel(cov, SYMS, start, DEV_END, seed=21)
    rng = np.random.default_rng(4)
    for s in SYMS:
        p = panel[s]["premium_5m"].copy()
        p["c"] = rng.normal(0.0, 2e-4, size=len(p))
        panel[s]["premium_5m"] = p
        panel[s]["premiumIndex"] = p
        f = panel[s]["settlements"].copy()
        f["rate"] = rng.normal(1e-4, 8e-5, size=len(f))
        panel[s]["settlements"] = f
        panel[s]["funding"] = f
    ds = write_synthetic_dataset(panel, root / "ds")
    first = start + 75 * DAY
    declared = [dict(c, first_refit_ms=first, min_train_windows=100) for c in family_c.family_c()]
    return {"root": root, "ds": ds, "start": start, "first": first, "configs": declared, "panel": panel}


@pytest.fixture
def patched(e2e: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    monkeypatch.setattr(family_c, "family_c", lambda: [dict(c) for c in e2e["configs"]])
    return e2e


@pytest.fixture(scope="module")
def e2e_run(e2e: dict[str, Any]) -> dict[str, Any]:
    mp = pytest.MonkeyPatch()
    mp.setattr(family_c, "family_c", lambda: [dict(c) for c in e2e["configs"]])
    try:
        out = e2e["root"] / "out"
        receipts = phase5_c.run_family_c(e2e["ds"], out, COMMIT)
        report = phase5_c.report_family_c(e2e["ds"], out / "runs", out, COMMIT, universe=tuple(SYMS), symbols_min=2)
    finally:
        mp.undo()
    return {"out": out, "receipts": receipts, "report": report}


def test_end_to_end_run_writes_forecasts_and_receipts(patched: dict[str, Any], e2e_run: dict[str, Any]) -> None:
    out = e2e_run["out"]
    ids = [c["id"] for c in patched["configs"]]
    assert sorted(p.name for p in (out / "runs").iterdir()) == sorted(ids)
    manifest = json.loads((patched["ds"] / "manifest.json").read_text(encoding="utf-8"))
    for config in patched["configs"]:
        d = out / "runs" / config["id"]
        receipt = json.loads((d / "receipt.json").read_text(encoding="utf-8"))
        assert receipt["kind"] == "trial" and receipt["family"] == "C" and receipt["config"] == config
        assert receipt["config_hash"] == cli.config_hash_of(config)
        assert receipt["commit"] == COMMIT and receipt["source_sha256"] == cli.source_digest()
        assert receipt["dataset_hash"] == manifest["datasetHash"]
        assert {"incomplete", "past_partition_end"} == set(receipt["dropped_windows"])
        assert "untrained_coin_folds" in receipt and receipt["runtime_s"] >= 0
        fc = pd.read_parquet(d / "forecasts.parquet")
        assert list(fc.columns) == family_c.FORECAST_COLUMNS
        wms = family_c.WINDOWS[config["window"]]
        assert (fc["T"] >= config["first_refit_ms"]).all()
        assert (fc["T"] + wms < DEV_END).all()
        assert (fc["T"] % wms == 0).all()
        assert (fc["T"] >= fc["fold"]).all()
    one = pd.read_parquet(out / "runs" / "C_LHAR_1h" / "forecasts.parquet")
    assert one["f"].notna().sum() > 1000 and one["persistence"].notna().all()
    assert (one.loc[one["f"].notna(), "lo80"] < one.loc[one["f"].notna(), "hi80"]).all()
    d1 = json.loads((out / "runs" / "C_LHAR_1d" / "receipt.json").read_text(encoding="utf-8"))
    assert d1["untrained_coin_folds"] > 0 and d1["n_forecast_rows"] == 0
    # The last 1h window ends at DEV_END and is dropped (counted).
    h1 = json.loads((out / "runs" / "C_LHAR_1h" / "receipt.json").read_text(encoding="utf-8"))
    assert h1["dropped_windows"]["past_partition_end"] == len(SYMS)


def test_end_to_end_report(patched: dict[str, Any], e2e_run: dict[str, Any]) -> None:
    report = e2e_run["report"]
    out = e2e_run["out"]
    assert (out / "family_c_report.json").is_file()
    assert report["dataset_hash"] == json.loads((patched["ds"] / "manifest.json").read_text())["datasetHash"]
    assert report["source_sha256"] == cli.source_digest()
    assert report["receipts_sha256"] == phase5_c._receipt_hashes(out / "runs")
    assert list(report["configurations"]) == [c["id"] for c in patched["configs"]]
    cfg = report["configurations"]["C_LHAR_1h"]
    assert set(cfg["coins"]) == set(SYMS)
    assert set(cfg["coins"]["BTCUSDT"]["tests"]) == {
        "qlike_vs_persistence",
        "qlike_vs_ewma",
        "logmse_vs_persistence",
        "logmse_vs_ewma",
    }
    assert cfg["coins"]["BTCUSDT"]["n_paired"] > 500
    assert not report["configurations"]["C_LHAR_1d"]["pass"]
    if report["finalist"] is None:
        assert report["stay_out"] is None and report["h_read_allowed"] is False
    else:
        assert report["finalist"]["id"] in report["passing"]


def test_run_is_resumable_and_refuses_a_mismatch(
    patched: dict[str, Any], e2e_run: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    out = e2e_run["out"]

    def boom(*a: Any, **k: Any) -> Any:
        raise AssertionError("a finished run must be reused")

    monkeypatch.setattr(family_c, "compute_forecasts", boom)
    before = {p: p.read_bytes() for p in (out / "runs").glob("*/receipt.json")}
    receipts = phase5_c.run_family_c(patched["ds"], out, COMMIT)
    assert len(receipts) == 9
    assert {p: p.read_bytes() for p in (out / "runs").glob("*/receipt.json")} == before
    with pytest.raises(ValueError, match="code freeze"):
        phase5_c.run_family_c(patched["ds"], out, "d" * 40)
    first = patched["configs"][0]
    changed = [dict(first, min_train_windows=101), *patched["configs"][1:]]
    monkeypatch.setattr(family_c, "family_c", lambda: [dict(c) for c in changed])
    with pytest.raises(ValueError, match="different configuration"):
        phase5_c.run_family_c(patched["ds"], out, COMMIT)


def test_reuse_refuses_another_digest_or_dataset(
    patched: dict[str, Any], e2e_run: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    out = e2e_run["out"]
    monkeypatch.setattr(cli, "source_digest", lambda *a, **k: "0" * 64)
    with pytest.raises(ValueError, match="source digest"):
        phase5_c.run_family_c(patched["ds"], out, COMMIT)
    monkeypatch.undo()
    monkeypatch.setattr(family_c, "family_c", lambda: [dict(c) for c in patched["configs"]])
    monkeypatch.setattr(phase5_c, "_load", lambda ds: ({"datasetHash": "f" * 64, "symbols": []}, {}))
    with pytest.raises(ValueError, match="dataset"):
        phase5_c.run_family_c(patched["ds"], out, COMMIT)


def _copy_runs(src: Path, dst: Path) -> Path:
    import shutil

    shutil.copytree(src, dst)
    return dst


def test_report_checks_completeness_and_binding(
    patched: dict[str, Any], e2e_run: dict[str, Any], tmp_path: Path
) -> None:
    runs = _copy_runs(e2e_run["out"] / "runs", tmp_path / "runs")
    # Missing run.
    import shutil

    shutil.rmtree(runs / "C_LHAR_4h")
    with pytest.raises(ValueError, match="missing"):
        phase5_c.report_family_c(patched["ds"], runs, tmp_path / "o1", COMMIT)
    runs = _copy_runs(e2e_run["out"] / "runs", tmp_path / "runs2")
    (runs / "C_extra").mkdir()
    with pytest.raises(ValueError, match="extra"):
        phase5_c.report_family_c(patched["ds"], runs, tmp_path / "o2", COMMIT)
    runs = _copy_runs(e2e_run["out"] / "runs", tmp_path / "runs3")
    rc = runs / "C_LHAR_1h" / "receipt.json"
    receipt = json.loads(rc.read_text())
    rc.write_text(json.dumps(receipt | {"config_hash": "0" * 64}))
    with pytest.raises(ValueError, match="registry entry"):
        phase5_c.report_family_c(patched["ds"], runs, tmp_path / "o3", COMMIT)
    rc.write_text(json.dumps(receipt | {"commit": "e" * 40}))
    with pytest.raises(ValueError, match="commit"):
        phase5_c.report_family_c(patched["ds"], runs, tmp_path / "o4", COMMIT)
    rc.write_text(json.dumps(receipt | {"dataset_hash": "1" * 64}))
    with pytest.raises(ValueError, match="dataset_hash"):
        phase5_c.report_family_c(patched["ds"], runs, tmp_path / "o5", COMMIT)
    rc.write_text(json.dumps(receipt | {"kind": "control"}))
    with pytest.raises(ValueError, match="not a trial"):
        phase5_c.report_family_c(patched["ds"], runs, tmp_path / "o6", COMMIT)


def test_twin_runs_only_for_a_finalist_and_binds_the_report(
    patched: dict[str, Any], e2e_run: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = e2e_run["out"]
    runs = out / "runs"
    kw: dict[str, Any] = {"universe": tuple(SYMS), "symbols_min": 2}
    report_file = out / "family_c_report.json"
    report = json.loads(report_file.read_text())
    assert report["finalist"] is None
    # With no finalist nothing runs.
    none_file = tmp_path / "none.json"
    none_file.write_text(json.dumps(report | {"finalist": None}))
    res = phase5_c.run_family_c_twin(patched["ds"], runs, none_file, tmp_path / "t0", COMMIT, **kw)
    assert res["finalist"] is None and not (tmp_path / "t0" / "twins").exists()
    assert (tmp_path / "t0" / "refit_comparison.json").is_file()
    # A report naming a configuration that does not pass (here no configuration passes) is refused.
    fake = tmp_path / "fake.json"
    fake.write_text(json.dumps(report | {"finalist": {"id": "C_LHAR_1h", "registry_index": 0}}))
    with pytest.raises(ValueError, match="names finalist"):
        phase5_c.run_family_c_twin(patched["ds"], runs, fake, tmp_path / "tf", COMMIT, **kw)
    assert not (tmp_path / "tf").exists()
    # With the recomputed finalist forced to C_LHAR_1h the twin runs (the 1h twin has windows to fit on).
    forced = {"id": "C_LHAR_1h"}
    monkeypatch.setattr(
        family_c,
        "finalist_ranking",
        lambda verdicts, order: {"finalist": forced["id"], "support": list(SYMS), "scores": {}},
    )
    fin_file = tmp_path / "fin.json"
    fin_file.write_text(json.dumps(report | {"finalist": {"id": "C_LHAR_1h", "registry_index": 0}}))
    res = phase5_c.run_family_c_twin(patched["ds"], runs, fin_file, tmp_path / "t1", COMMIT, **kw)
    twin_dir = tmp_path / "t1" / "twins" / "runs" / "C_twin_C_LHAR_1h"
    receipt = json.loads((twin_dir / "receipt.json").read_text())
    assert receipt["config"]["refit"] == "none" and receipt["n_folds"] == 1
    assert res["refit_comparison"]["status"] == "descriptive"
    assert res["refit_comparison"]["seed"] == 7_100_000
    assert res["report_sha256"] and (tmp_path / "t1" / "refit_comparison.json").is_file()
    # The twin of the 1d window cannot be trained: inconclusive.
    forced["id"] = "C_LHAR_1d"
    d_file = tmp_path / "d.json"
    d_file.write_text(json.dumps(report | {"finalist": {"id": "C_LHAR_1d", "registry_index": 6}}))
    res = phase5_c.run_family_c_twin(patched["ds"], runs, d_file, tmp_path / "t2", COMMIT, **kw)
    assert res["refit_comparison"]["status"] == "inconclusive"
    # A report from other runs, another commit or a wrong registry index is refused.
    for field, value, match in (
        ("commit", "e" * 40, "commit"),
        ("dataset_hash", "1" * 64, "dataset"),
        ("source_sha256", "2" * 64, "source digest"),
        ("receipts_sha256", {"x": "y"}, "receipts_sha256"),
    ):
        bad = tmp_path / f"bad_{field}.json"
        bad.write_text(json.dumps(report | {field: value}))
        with pytest.raises(ValueError, match=match):
            phase5_c.run_family_c_twin(patched["ds"], runs, bad, tmp_path / "tb", COMMIT, **kw)
    forced["id"] = "C_LHAR_1h"
    wrong = tmp_path / "wrong.json"
    wrong.write_text(json.dumps(report | {"finalist": {"id": "C_LHAR_1h", "registry_index": 3}}))
    with pytest.raises(ValueError, match="registry index"):
        phase5_c.run_family_c_twin(patched["ds"], runs, wrong, tmp_path / "tw", COMMIT, **kw)


def test_cli_dispatches_the_family_c_subcommands(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, tuple[Any, ...]]] = []
    monkeypatch.setattr(phase5_c, "run_family_c", lambda *a: calls.append(("run", a)))
    monkeypatch.setattr(phase5_c, "report_family_c", lambda *a: calls.append(("report", a)))
    monkeypatch.setattr(phase5_c, "run_family_c_twin", lambda *a: calls.append(("twin", a)))
    import sys

    for argv, name, want in (
        (["family-c-run", "--ds", "d", "--out", "o", "--commit", "c"], "run", ("d", "o", "c")),
        (
            ["family-c-report", "--ds", "d", "--runs", "r", "--out", "o", "--commit", "c"],
            "report",
            ("d", "r", "o", "c"),
        ),
        (
            ["family-c-twin", "--ds", "d", "--runs", "r", "--report", "p", "--out", "o", "--commit", "c"],
            "twin",
            ("d", "r", "p", "o", "c"),
        ),
    ):
        monkeypatch.setattr(sys, "argv", ["r4.cli", *argv])
        cli.main()
        assert calls[-1] == (name, want)
