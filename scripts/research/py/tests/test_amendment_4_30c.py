"""Brief 30c (Amendment 4): hedge funding, item 3 at V0 with lambda, the C4 dossier checks."""

from __future__ import annotations

import copy
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest
import scipy.stats

from r4 import bar, book
from r4 import calibration as cal
from r4.bar import item3, joint_shift_stats
from r4.book import Tranche, beta_hedged_daily
from r4.cli import run_wf
from r4.method import BAR, DEV_END, UNIVERSE
from r4.stats import (
    deflated_sharpe,
    expected_max_sharpe,
    long_run_variance_factor,
    probabilistic_sharpe,
)
from tests.test_calibration_power import (  # noqa: F401  (power_sim is a module fixture)
    D_V,
    RULES,
    _inputs,
    _noise_eval,
    _retest,
    power_sim,
)
from tests.test_cli_bar import COMMIT, _create_synthetic_dataset_dir, _make_fast_synthetic_panel

DAY = 86_400_000
H = 3_600_000
H8 = 8 * H
DAY0 = 1_700_006_400_000  # a UTC midnight
COINS = list(UNIVERSE[:4])
A, B, C, D = COINS


# ---------------------------------------------------------------------------
# stats: long_run_variance_factor, probabilistic_sharpe and deflated_sharpe with lam
# ---------------------------------------------------------------------------


def _ar1(phi: float, n: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    eps = rng.normal(size=n)
    x = np.zeros(n)
    for k in range(1, n):
        x[k] = phi * x[k - 1] + eps[k]
    return x


def test_lrv_iid_is_near_one_and_never_below_one():
    for seed in range(20):
        lam = long_run_variance_factor(np.random.default_rng(seed).normal(size=1277))
        assert lam >= 1.0
    lam = long_run_variance_factor(np.random.default_rng(0).normal(size=200_000))
    assert abs(lam - 1.0) < 0.05


def test_lrv_ar1_matches_the_bartlett_formula():
    phi = 0.5
    want = 1.0 + 2.0 * sum((1.0 - k / 11.0) * phi**k for k in range(1, 11))
    got = long_run_variance_factor(_ar1(phi, 400_000, seed=3))
    assert got == pytest.approx(want, rel=0.02)


def test_lrv_zero_variance_short_and_negative_autocorrelation():
    assert long_run_variance_factor(np.zeros(50)) == 1.0
    assert long_run_variance_factor(np.array([0.3])) == 1.0
    assert long_run_variance_factor(np.array([])) == 1.0
    assert long_run_variance_factor(np.tile([1.0, -1.0], 500)) == 1.0  # lag-1 rho near -1: floored


def test_lrv_exact_value_on_a_short_series():
    x = np.array([1.0, 2.0, 0.0, 3.0, -1.0, 2.0])
    d = x - x.mean()
    c0 = float(np.sum(d * d))
    lags = 3
    rho = [float(np.sum(d[k:] * d[:-k])) / c0 for k in range(1, lags + 1)]
    want = max(1.0, 1.0 + 2.0 * sum((1.0 - k / (lags + 1)) * r for k, r in zip(range(1, lags + 1), rho, strict=True)))
    assert long_run_variance_factor(x, lags=lags) == pytest.approx(want, rel=1e-12)


def test_psr_dsr_lam_one_reproduces_the_old_numbers_and_larger_lam_lowers_the_probability():
    sr, n, skew, kurt = 0.12, 1277, 0.2, 5.0
    bench = expected_max_sharpe(120, 1.0 / 1276)
    old = float(
        scipy.stats.norm.cdf((sr - bench) * math.sqrt(n - 1) / math.sqrt(1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr**2))
    )
    assert probabilistic_sharpe(sr, bench, n, skew, kurt) == old
    assert probabilistic_sharpe(sr, bench, n, skew, kurt, lam=1.0) == old
    assert probabilistic_sharpe(sr, bench, n, skew, kurt, lam=2.0) < old
    b1, p1 = deflated_sharpe(sr, 120, 1.0 / 1276, n, skew, kurt)
    b2, p2 = deflated_sharpe(sr, 120, 1.0 / 1276, n, skew, kurt, lam=1.0)
    b3, p3 = deflated_sharpe(sr, 120, 1.0 / 1276, n, skew, kurt, lam=1.5)
    assert (b1, p1) == (b2, p2) and b3 == b1 and p3 < p1
    with pytest.raises(ValueError, match="lam"):
        probabilistic_sharpe(sr, bench, n, skew, kurt, lam=0.9)


# ---------------------------------------------------------------------------
# item3 at V0
# ---------------------------------------------------------------------------


def _daily(values: np.ndarray) -> pd.DataFrame:
    return pd.DataFrame({"drift_free": values}, index=pd.Index(range(len(values)), name="day_start"))


def _iid_series(n: int = 1277, seed: int = 1, mean: float = 0.0) -> np.ndarray:
    return np.random.default_rng(seed).normal(mean, 0.01, size=n)


def test_item3_benchmark_constants_at_t_1277_with_lam_one(monkeypatch):
    monkeypatch.setattr("r4.stats.long_run_variance_factor", lambda x, lags=10: 1.0)
    res = item3({}, 0.0597, 120, candidate_daily=_daily(_iid_series()))
    assert res["lambda"] == 1.0 and res["t_days"] == 1277
    assert res["v0"] == pytest.approx(1.0 / 1276)
    assert res["v_item3"] == pytest.approx(1.0 / 1276)
    assert res["benchmark"] == pytest.approx(0.0726, abs=5e-5)
    assert res["benchmark_program"] == pytest.approx(0.0976, abs=5e-5)
    assert res["variance_mode"] == "a4_v0"
    assert res["margin"] == 1.0
    assert res["var_trial_sharpes"] == 0.0597  # the diagnostic V is reported unchanged


def test_item3_v_item3_is_margin_lambda_v0():
    x = _ar1(0.4, 600, seed=5) * 0.01 + 0.0005
    res = item3({}, 0.01, 120, candidate_daily=_daily(x), margin=1.2)
    lam = long_run_variance_factor(x)
    assert res["lambda"] == pytest.approx(lam)
    assert res["margin"] == 1.2
    assert res["v0"] == pytest.approx(1.0 / 599)
    assert res["v_item3"] == pytest.approx(1.2 * lam / 599)
    assert res["benchmark"] == pytest.approx(expected_max_sharpe(120, 1.2 * lam / 599))


def test_item3_ignores_the_diagnostic_variance_for_the_benchmark():
    s = _daily(_iid_series())
    a = item3({}, 0.0001, 120, candidate_daily=s)
    b = item3({}, 5.0, 120, candidate_daily=s)
    assert a["benchmark"] == b["benchmark"] and a["dsr_prob"] == b["dsr_prob"]
    assert (a["var_trial_sharpes"], b["var_trial_sharpes"]) == (0.0001, 5.0)


def test_item3_fails_closed():
    good = _daily(_iid_series(50))
    with pytest.raises(ValueError, match="candidate_daily"):
        item3({"metrics": {"wf_sharpe": 0.1, "n_days": 50}}, 0.01, 120)
    with pytest.raises(ValueError, match="candidate_daily"):
        item3({}, 0.01, 120, candidate_daily=_daily(np.array([])))
    with pytest.raises(ValueError, match="at least 3"):
        item3({}, 0.01, 120, candidate_daily=_daily(np.array([0.1, 0.2])))
    with pytest.raises(ValueError, match="finite"):
        item3({}, 0.01, 120, candidate_daily=_daily(np.array([0.1, np.nan, 0.2, 0.3])))
    with pytest.raises(ValueError, match="margin"):
        item3({}, 0.01, 120, candidate_daily=good, margin=0.99)


# ---------------------------------------------------------------------------
# book: hedge funding
# ---------------------------------------------------------------------------


def _five(coins: list[str], times: list[int], seed: int = 0) -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    out = {}
    for c in coins:
        px = 100.0 * np.exp(np.cumsum(rng.normal(0, 0.01, size=len(times))))
        out[c] = pd.DataFrame({"t": times, "o": px})
    return out


def _settle(rates: dict[str, float], start: int = DAY0 - H8, end: int = DAY0 + 4 * H8) -> dict[str, pd.DataFrame]:
    ts = list(range(start, end + 1, H8))
    return {c: pd.DataFrame({"t": ts, "rate": [r] * len(ts)}) for c, r in rates.items()}


def _tr(sym: str, w: float, entry: int, exit_: int, **kw: Any) -> Tranche:
    return Tranche(
        symbol=sym,
        side=1 if w > 0 else -1,
        entry_ms=entry,
        exit_ms=exit_,
        entry_price=100.0,
        exit_price=100.0,
        interval="1h",
        h_ms=exit_ - entry,
        weight_override=w,
        **kw,
    )


ENTRY, EXIT = DAY0 + 2 * H, DAY0 + 10 * H
GRID = [DAY0, ENTRY, DAY0 + 8 * H, EXIT, DAY0 + DAY]


def test_equal_weight_short_book_has_zero_total_funding():
    rates = {A: 0.0003, B: -0.0001, C: 0.0007, D: 0.0002}
    five = _five(COINS, GRID)
    trs = [_tr(c, -0.25, ENTRY, EXIT) for c in COINS]
    res = beta_hedged_daily(trs, five, _settle(rates), {c: 1.0 for c in COINS}, COINS)
    row = res.loc[DAY0]
    assert abs(row["funding"]) < 1e-12
    assert row["funding_coin"] > 0.0  # shorts collect positive funding through the coin leg
    assert row["funding_hedge"] == pytest.approx(-row["funding_coin"], abs=1e-12)
    assert row["n_basket_funding_min"] == 4
    assert row["funding"] == pytest.approx(row["funding_coin"] + row["funding_hedge"], abs=1e-15)
    assert row["drift_free"] == pytest.approx(row["gross_hedged"] - row["costs"] + row["funding"], abs=1e-15)


def test_coin_specific_difference_leaves_the_residual():
    rates = {A: 0.0009, B: 0.0001, C: 0.0002, D: 0.0003}
    beta, w = 1.3, 0.5
    five = _five(COINS, GRID)
    res = beta_hedged_daily([_tr(A, w, ENTRY, EXIT)], five, _settle(rates), {A: beta}, COINS)
    # (ENTRY, EXIT] holds the 08:00 settlement only
    f_coin = rates[A]
    f_ew = float(np.mean(list(rates.values())))
    assert res.loc[DAY0, "funding_coin"] == pytest.approx(-w * f_coin, abs=1e-15)
    assert res.loc[DAY0, "funding_hedge"] == pytest.approx(beta * w * f_ew, abs=1e-15)
    assert res.loc[DAY0, "funding"] == pytest.approx(-w * (f_coin - beta * f_ew), abs=1e-15)


def test_short_with_positive_basket_funding_pays_on_the_hedge():
    rates = dict.fromkeys(COINS, 0.0004)
    res = beta_hedged_daily([_tr(A, -0.4, ENTRY, EXIT)], _five(COINS, GRID), _settle(rates), {A: 1.0}, COINS)
    assert res.loc[DAY0, "funding_hedge"] < 0.0
    assert res.loc[DAY0, "funding_coin"] > 0.0


def test_intrabar_exit_excludes_the_stamp_in_both_legs():
    stamp = DAY0 + 8 * H  # a settlement instant
    rates = dict.fromkeys(COINS, 0.0005)
    five = _five(COINS, [DAY0, ENTRY, stamp, DAY0 + DAY])
    stop = _tr(A, 0.5, ENTRY, stamp, exit_reason="stop")
    horizon = _tr(A, 0.5, ENTRY, stamp)
    r_stop = beta_hedged_daily([stop], five, _settle(rates), {A: 1.0}, COINS).loc[DAY0]
    r_hor = beta_hedged_daily([horizon], five, _settle(rates), {A: 1.0}, COINS).loc[DAY0]
    assert r_stop["funding_coin"] == 0.0 and r_stop["funding_hedge"] == 0.0
    assert r_hor["funding_coin"] == pytest.approx(-0.5 * 0.0005, abs=1e-15)
    assert r_hor["funding_hedge"] == pytest.approx(0.5 * 0.0005, abs=1e-15)


def _record(times_h: list[float], hours: list[float] | float = 8.0, rate: float = 0.0003) -> pd.DataFrame:
    """A settlement record at DAY0 + the given hours, with its stated intervalHours."""
    ts = [DAY0 + int(h * H) for h in times_h]
    iv = hours if isinstance(hours, list) else [hours] * len(ts)
    return pd.DataFrame({"t": ts, "rate": [rate] * len(ts), "intervalHours": iv})


def test_coverage_a_d_like_record_ending_eight_hours_before_data_end_covers_an_exit_at_the_span_end():
    # Prices end at DAY0 + 24h - 5m, so data_end is DAY0 + 24h. The record ends at 16:00: the 24:00 settlement is
    # due at data_end, outside the span, and so not missing.
    last_bar = DAY0 + DAY - 300_000
    five = _five(COINS, [DAY0, DAY0 + 20 * H, last_bar])
    rec = {c: _record([-8, 0, 8, 16]) for c in COINS}
    tr = _tr(A, 0.5, DAY0 + 20 * H, last_bar)
    res = beta_hedged_daily([tr], five, rec, {A: 1.0}, COINS)
    assert res.loc[DAY0, "n_basket_funding_min"] == 4
    assert res.loc[DAY0, "funding_hedge"] == pytest.approx(0.0, abs=1e-15)  # nothing settles in (20:00, 23:55]


def test_coverage_unpatched_synth_panel_prices_a_tranche_exiting_in_the_last_eight_hours():
    from r4.synth import synth_panel

    syms = list(UNIVERSE[:4])
    cov = (0.02**2) * (0.3 * np.ones((4, 4)) + 0.7 * np.eye(4))
    panel = synth_panel(cov, syms, DAY0, DAY0 + 3 * DAY, seed=2)
    last = int(panel[A]["5m"]["t"].iloc[-1])
    assert int(panel[A]["settlements"]["t"].iloc[-1]) == DAY0 + 3 * DAY - H8  # the record stops 8h short
    five = {c: panel[c]["5m"] for c in syms}
    settle = {c: panel[c]["settlements"] for c in syms}
    tr = _tr(A, 0.5, last - 5 * H, last)
    res = beta_hedged_daily([tr], five, settle, {A: 1.0}, syms)
    assert res.loc[DAY0 + 2 * DAY, "n_basket_funding_min"] == 4
    assert abs(res.loc[DAY0 + 2 * DAY, "funding"]) < 1e-15  # synthetic funding is zero


def test_coverage_interior_gap_in_one_coin_leaves_it_out_and_in_all_coins_raises():
    five = _five(COINS, GRID)
    gap = _record([-8, 0, 16, 24, 32])  # the 08:00 settlement, due inside (02:00, 10:00], is missing
    rec = {c: _record([-8, 0, 8, 16, 24, 32], rate=0.0004) for c in COINS}
    rec[D] = gap
    res = beta_hedged_daily([_tr(A, 0.5, ENTRY, EXIT)], five, rec, {A: 1.0}, COINS)
    assert res.loc[DAY0, "n_basket_funding_min"] == 3
    assert res.loc[DAY0, "funding_hedge"] == pytest.approx(0.5 * 0.0004, abs=1e-15)
    with pytest.raises(ValueError, match="basket"):
        beta_hedged_daily([_tr(A, 0.5, ENTRY, EXIT)], five, dict.fromkeys(COINS, gap), {A: 1.0}, COINS)


def test_coverage_interior_gap_in_all_coins_raises_in_the_joint_shift_too():
    n_days = 24
    times = list(range(DAY0, DAY0 + n_days * DAY, 300_000))
    five = _five(COINS, times, seed=4)
    ts = [t for t in range(DAY0 - H8, DAY0 + (n_days + 2) * DAY, H8) if t != DAY0 + 3 * DAY + 8 * H]
    rec = {c: pd.DataFrame({"t": ts, "rate": 0.0002, "intervalHours": 8}) for c in COINS}
    panel = {c: {"5m": five[c], "settlements": rec[c], "funding": rec[c]} for c in COINS}
    tr = [_tr(A, 0.3, DAY0 + 3 * DAY + 2 * H, DAY0 + 3 * DAY + 14 * H)]
    folds = [{"start_ms": DAY0, "end_ms": DAY0 + n_days * DAY, "betas": dict.fromkeys(COINS, 1.0)}]
    with pytest.raises(ValueError, match="basket"):
        joint_shift_stats(tr, panel, folds, DAY0, DAY0 + n_days * DAY, n_draws=3, seed=1)


def test_coverage_record_starting_after_a_due_settlement_is_not_covered():
    five = _five(COINS, GRID)
    late = _record([16, 24, 32])  # nothing at 08:00, which was due inside the window and before the first row
    with pytest.raises(ValueError, match="basket"):
        beta_hedged_daily([_tr(A, 0.5, ENTRY, EXIT)], five, dict.fromkeys(COINS, late), {A: 1.0}, COINS)
    rec = dict.fromkeys(COINS, _record([-8, 0, 8, 16, 24]))
    rec[D] = late
    res = beta_hedged_daily([_tr(A, 0.5, ENTRY, EXIT)], five, rec, {A: 1.0}, COINS)
    assert res.loc[DAY0, "n_basket_funding_min"] == 3


def test_coverage_a_record_with_no_rows_is_not_covered_and_a_record_ending_inside_the_window_is_not():
    five = _five(COINS, GRID)
    ends_early = _record([-8, 0])  # the 08:00 settlement is due and absent after the last row
    with pytest.raises(ValueError, match="basket"):
        beta_hedged_daily([_tr(A, 0.5, ENTRY, EXIT)], five, dict.fromkeys(COINS, ends_early), {A: 1.0}, COINS)
    with pytest.raises(ValueError, match="basket"):
        beta_hedged_daily([_tr(A, 0.5, ENTRY, EXIT)], five, None, {A: 1.0}, COINS)


def test_coverage_interval_switch_from_eight_to_four_hours_with_nothing_missing_is_covered():
    grid = [DAY0, ENTRY, DAY0 + 22 * H, DAY0 + DAY]
    five = _five(COINS, grid)
    rec = {c: _record([-8, 0, 8, 12, 16, 20, 24], hours=[8, 8, 8, 4, 4, 4, 4], rate=0.0003) for c in COINS}
    res = beta_hedged_daily([_tr(A, 0.5, ENTRY, DAY0 + 22 * H)], five, rec, {A: 1.0}, COINS)
    assert res.loc[DAY0, "n_basket_funding_min"] == 4
    # 08:00, 12:00, 16:00 and 20:00 settle inside (02:00, 22:00]
    assert res.loc[DAY0, "funding_hedge"] == pytest.approx(0.5 * 4 * 0.0003, abs=1e-15)
    # a four-hour record with 16:00 missing is a real gap
    broken = _record([-8, 0, 8, 12, 20, 24], hours=[8, 8, 8, 4, 4, 4])
    with pytest.raises(ValueError, match="basket"):
        beta_hedged_daily([_tr(A, 0.5, ENTRY, DAY0 + 22 * H)], five, dict.fromkeys(COINS, broken), {A: 1.0}, COINS)


def test_coverage_intrabar_exit_at_a_stamp_does_not_need_that_settlement():
    stamp = DAY0 + 8 * H
    five = _five(COINS, [DAY0, ENTRY, stamp, DAY0 + DAY])
    missing_stamp = dict.fromkeys(COINS, _record([-8, 0, 16, 24]))  # the 08:00 settlement is absent
    stop = _tr(A, 0.5, ENTRY, stamp, exit_reason="stop")
    res = beta_hedged_daily([stop], five, missing_stamp, {A: 1.0}, COINS)
    assert res.loc[DAY0, "n_basket_funding_min"] == 4  # the open region ends before the stamp
    with pytest.raises(ValueError, match="basket"):
        beta_hedged_daily([_tr(A, 0.5, ENTRY, stamp)], five, missing_stamp, {A: 1.0}, COINS)


def test_settlements_of_non_traded_basket_coins_are_loaded():
    five = _five(COINS, GRID)
    only_others = {c: _settle({c: 0.0008})[c] for c in COINS[1:]}
    only_others[A] = _settle({A: 0.0})[A]
    res = beta_hedged_daily([_tr(A, 0.5, ENTRY, EXIT)], five, only_others, {A: 1.0}, COINS)
    assert res.loc[DAY0, "funding_hedge"] == pytest.approx(0.5 * (0.0 + 3 * 0.0008) / 4, abs=1e-15)


# ---------------------------------------------------------------------------
# parity: the joint-shift observed statistic against the book, hedge term included
# ---------------------------------------------------------------------------


def test_joint_shift_observed_statistic_equals_the_books_drift_free():
    n_days = 24
    start = DAY0
    times = list(range(start, start + n_days * DAY, 300_000))
    five = _five(COINS, times, seed=4)
    ts = list(range(start - H8, start + (n_days + 2) * DAY, H8))
    rng = np.random.default_rng(9)
    settle = {c: pd.DataFrame({"t": ts, "rate": rng.normal(0.0002, 0.0003, size=len(ts))}) for c in COINS}
    betas = {A: 1.2, B: 0.7, C: 1.1, D: 0.9}
    trs = [
        _tr(A, 0.3, start + 3 * DAY + 2 * H, start + 3 * DAY + 14 * H),
        _tr(B, -0.2, start + 5 * DAY + 20 * H, start + 6 * DAY + 4 * H),  # crosses midnight
        _tr(C, 0.25, start + 8 * DAY + 5 * H, start + 8 * DAY + 13 * H),
        _tr(D, -0.35, start + 9 * DAY + 7 * H, start + 9 * DAY + 19 * H),
    ]
    daily = beta_hedged_daily(trs, five, settle, betas, COINS)
    panel = {c: {"5m": five[c], "settlements": settle[c], "funding": settle[c]} for c in COINS}
    folds = [{"start_ms": start, "end_ms": start + n_days * DAY, "betas": betas}]
    st = joint_shift_stats(trs, panel, folds, start, start + n_days * DAY, n_draws=5, seed=3)
    assert st.obs_weight_sum is not None
    assert float(daily["drift_free"].sum()) == pytest.approx(st.obs_stat * st.obs_weight_sum, abs=1e-12)
    assert float(daily["funding_hedge"].abs().sum()) > 0.0


# ---------------------------------------------------------------------------
# run_wf: the daily frame's funding columns
# ---------------------------------------------------------------------------


def test_run_wf_writes_the_funding_split(tmp_path: Path):
    import json

    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=10, inject_signal=True)
    ds_dir = _create_synthetic_dataset_dir(tmp_path / "ds", panel)
    cfg = {
        "id": "run_a4",
        "kind": "trial",
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ["ret_1", "ret_4"],
        "interval": "1h",
        "h_ms": 14_400_000,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0001,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "first_refit_ms": 1680307200000,
        "seed": 7,
    }
    f = tmp_path / "config.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    run_wf(f, ds_dir, tmp_path / "out", commit=COMMIT, panel=panel)
    daily = pd.read_parquet(tmp_path / "out" / "run_a4" / "daily.parquet")
    for col in ("funding_coin", "funding_hedge", "n_basket_funding_min"):
        assert col in daily.columns
    np.testing.assert_allclose(daily["funding_coin"] + daily["funding_hedge"], daily["funding"], atol=1e-15, rtol=0)
    assert float(daily["funding_hedge"].abs().sum()) > 0.0
    bet = daily["n_basket_funding_min"] > 0
    assert bet.any() and daily.loc[bet, "n_basket_funding_min"].max() <= 6


# ---------------------------------------------------------------------------
# power: margin 1.2 inside item3, recorded
# ---------------------------------------------------------------------------


def test_curve_entry_uses_margin_and_records_it(power_sim, monkeypatch):  # noqa: F811
    seen: list[dict[str, Any]] = []
    real = bar.item3

    def spy(*a: Any, **k: Any) -> dict[str, Any]:
        seen.append(k)
        return real(*a, **k)

    monkeypatch.setattr(bar, "item3", spy)
    curve = cal.power_curve(power_sim["dir"], D_V, joint_draws=20)
    assert seen and all(k.get("margin") == cal.POWER_MARGIN == 1.2 for k in seen)
    for entry in curve.values():
        assert entry["margin"] == 1.2 and entry["item3_variance"] == "a4_v0"


def test_power_simulation_summary_records_margin_and_item3_variance(power_sim):  # noqa: F811
    out = power_sim["out"]
    assert out["margin"] == cal.POWER_MARGIN
    assert out["item3_variance"] == "a4_v0"
    assert "stop_v" in out


def test_power_parameters_require_the_a4_fields(tmp_path: Path):
    from tests.test_calibration_power import _power_doc

    star = {"a_star": 0.0015, "infeasible": False, "extensions": []}
    cal._check_power_parameters(_power_doc(), star)
    for key in ("item3_variance", "margin"):
        doc = _power_doc()
        doc.pop(key, None)
        with pytest.raises(ValueError, match=key):
            cal._check_power_parameters(doc, star)
    with pytest.raises(ValueError, match="item3_variance"):
        cal._check_power_parameters(_power_doc(item3_variance="within_cell"), star)


# ---------------------------------------------------------------------------
# dossier: the V0 formula and the re-test recomputation
# ---------------------------------------------------------------------------


def _mut(obj: dict[str, Any], fn: Any) -> dict[str, Any]:
    out = copy.deepcopy(obj)
    fn(out)
    return out


def _first_cfg(ne: dict[str, Any]) -> dict[str, Any]:
    return ne["configs"][sorted(ne["configs"])[0]]


def test_dossier_accepts_consistent_a4_inputs(tmp_path: Path):
    doc = cal.write_dossier(tmp_path / "d.json", **_inputs(tmp_path))
    assert "predictions" in doc


@pytest.mark.parametrize(
    ("label", "mutate", "match"),
    [
        ("v0", lambda b: b.__setitem__("v0", b["v0"] * 2), "v0"),
        ("v_item3", lambda b: b.__setitem__("v_item3", b["v_item3"] * 1.5), "v_item3"),
        ("margin", lambda b: b.update(margin=1.2, v_item3=1.2 * b["lambda"] * b["v0"]), "margin"),
        ("lambda", lambda b: b.update({"lambda": 0.9, "v_item3": 0.9 * b["v0"]}), "lambda"),
        ("missing", lambda b: b.pop("v0"), "v0"),
    ],
)
def test_dossier_refuses_a_noise_item3_block_off_its_formula(tmp_path: Path, label, mutate, match):
    ne = _noise_eval()
    mutate(_first_cfg(ne)["item3"])
    with pytest.raises(ValueError, match=match):
        cal.write_dossier(tmp_path / f"{label}.json", **_inputs(tmp_path, noise_eval=ne))


@pytest.mark.parametrize(
    ("label", "mutate", "match"),
    [
        ("v0", lambda r: r["item3"].__setitem__("v0", 0.5), "v0"),
        ("v_item3", lambda r: r["item3"].__setitem__("v_item3", 0.5), "v_item3"),
        ("margin", lambda r: r["item3"].update(margin=1.2, v_item3=1.2 * r["item3"]["v0"]), "margin"),
        ("lambda", lambda r: r["item3"].update({"lambda": 0.5}), "lambda"),
    ],
)
def test_dossier_refuses_a_retest_item3_block_off_its_formula(tmp_path: Path, label, mutate, match):
    rows = [_mut(_retest(RULES[0]), mutate), *map(_retest, RULES[1:])]
    with pytest.raises(ValueError, match=match):
        cal.write_dossier(tmp_path / f"{label}.json", **_inputs(tmp_path, retests=rows))


def test_dossier_refuses_a_cost_free_item3_block_off_its_formula(tmp_path: Path):
    ne = _noise_eval()
    cid = sorted(ne["diagnostics"]["cost_free"]["configs"])[0]
    ne["diagnostics"]["cost_free"]["configs"][cid]["item3"]["v_item3"] *= 2
    with pytest.raises(ValueError, match="cost_free.*v_item3"):
        cal.write_dossier(tmp_path / "cf.json", **_inputs(tmp_path, noise_eval=ne))
    ne = _noise_eval()
    ne["diagnostics"]["cost_free"]["configs"][cid]["item3_cost_free_total_v"]["v0"] = 0.5
    with pytest.raises(ValueError, match="total_v.*v0"):
        cal.write_dossier(tmp_path / "cf2.json", **_inputs(tmp_path, noise_eval=ne))
    ne = _noise_eval()
    del ne["diagnostics"]["cost_free"]["configs"]
    with pytest.raises(ValueError, match="cost_free.configs"):
        cal.write_dossier(tmp_path / "cf3.json", **_inputs(tmp_path, noise_eval=ne))


@pytest.mark.parametrize(
    ("label", "mutate", "match"),
    [
        ("v0", lambda b: b.__setitem__("v0", 0.5), "v0"),
        ("lambda", lambda b: b.__setitem__("lambda", 0.5), "lambda"),
        ("margin", lambda b: b.update(margin=1.2, v_item3=1.2 * b["v0"]), "margin"),
        ("v_item3", lambda b: b.__setitem__("v_item3", 0.5), "v_item3"),
    ],
)
def test_dossier_refuses_a_positive_control_item3_block_off_its_formula(tmp_path: Path, label, mutate, match):
    from tests.test_calibration_power import _positive

    pos = _positive()
    mutate(pos["report"]["configurations"]["pc_P1"]["item3"])
    with pytest.raises(ValueError, match=match):
        cal.write_dossier(tmp_path / f"{label}.json", **_inputs(tmp_path, positive_control=pos))


def _hurdle(r: dict[str, Any], test: str) -> dict[str, Any]:
    return next(h for h in r["hurdles"] if h["test"] == test)


@pytest.mark.parametrize(
    ("label", "mutate", "match"),
    [
        # p says pass (below 0.05) while the hurdle and the receipt both say fail
        ("joint flag", lambda r: _hurdle(r, "joint_shift_null").__setitem__("value", 0.01), "joint_shift_null"),
        ("dsr flag", lambda r: _hurdle(r, "deflated_sharpe").__setitem__("value", 0.99), "deflated_sharpe"),
        ("wf flag", lambda r: _hurdle(r, "walk_forward_mean").__setitem__("value", 0.001), "walk_forward_mean"),
        ("cpcv flag", lambda r: _hurdle(r, "cpcv_paths").__setitem__("value", 5), "cpcv_paths"),
        ("breadth flag", lambda r: _hurdle(r, "coin_breadth").__setitem__("value", 9), "coin_breadth"),
        ("stress flag", lambda r: _hurdle(r, "stress_cost").__setitem__("value", 0.0002), "stress_cost"),
        ("span", lambda r: r["span"].__setitem__("start_ms", r["span"]["start_ms"] + 86_400_000), "span"),
        ("trials", lambda r: r.__setitem__("n_trials", 100), "n_trials"),
        ("lookback", lambda r: r.__setitem__("lookback_months", 6), "lookback_months"),
    ],
)
def test_dossier_recomputes_the_retest_hurdle_flags(tmp_path: Path, label, mutate, match):
    rows = [_mut(_retest(RULES[0]), mutate), *map(_retest, RULES[1:])]
    with pytest.raises(ValueError, match=match):
        cal.write_dossier(tmp_path / f"{label.replace(' ', '_')}.json", **_inputs(tmp_path, retests=rows))


def test_the_registered_constants_match_the_signed_text():
    assert BAR["dsr_min"] == 0.95 and cal.POWER_MARGIN == 1.2 and DEV_END == 1782864000000
    assert cal.A4_RETEST_LOOKBACK_MONTHS == 12
    assert cal.A4_ITEM3_VARIANCE == "a4_v0"
    assert cal.A4_VARIANCE_MARGIN == 1.0
    assert book.beta_hedged_daily is beta_hedged_daily
