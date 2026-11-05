"""Brief 36a: family B core (Amendment 8): the ported signals, the v8 reader, the frame, the meta model and the
extension branches. Synthetic data and the lead's synthetic TypeScript parity fixtures only."""

from __future__ import annotations

import ast
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest
from scipy.stats import norm

from r4 import calibration, cli, family_a, family_b, family_c, family_d, labels, tripwire, validation
from r4.book import _beta_missing
from r4.causality import assert_future_invariant
from r4.costs import coin_slippage_bps, trade_net_return
from r4.method import DEV_END, ENTRY_DELAY_MS, TIER_B_STAMP_MS, TIER_B_START, UNIVERSE
from r4.pipeline import RunConfig, decision_samples, load_panel, run_config_from_raw, walk_forward
from r4.synth import _jsonl_gz_bytes, write_synthetic_dataset
from tests.test_cli_bar import _make_fast_synthetic_panel

PY = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
H = 3_600_000
M5 = 300_000
DAY = 86_400_000
T0 = 1_700_000_000_000 // H * H
COMMIT = "b" * 40
FIRST_REFIT = 1680307200000  # 2023-04-01 UTC, 90 days into the synthetic panels
SMALL_F = ("ret_1", "ret_4")


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _arr(values: list[float | None]) -> np.ndarray:
    return np.array([np.nan if v is None else v for v in values], dtype=np.float64)


# ---------------------------------------------------------------------------------------------------------------------
# The ported signals against the TypeScript fixtures
# ---------------------------------------------------------------------------------------------------------------------


def _ll_series(fx: dict[str, Any]) -> dict[str, pd.DataFrame]:
    """The three 1h series of b_ll_fixture.json.

    Every stored close is the series the generator passed to buildResearchColumns (the lead fixed the generator's
    double selection of the BTC closes on 2026-11-05 and regenerated the fixture, which left every output unchanged).
    """
    p = fx["params"]
    series = {name: fx["series"][name]["close"] for name in ("BTCUSDT", "ALTAUSDT", "ALTBUSDT")}
    assert all(v is not None for close in series.values() for v in close)
    out = {}
    for name, close in series.items():
        grid = np.array(fx["series"][name]["grid_index"])
        out[name] = pd.DataFrame({"t": p["t0_ms"] + grid * p["step_ms"], "c": np.array(close, dtype=np.float64)})
    return out


def test_constants_equal_the_fixtures_warmups() -> None:
    assert family_b.LL_WARMUP_BARS == _fixture("b_ll_fixture.json")["params"]["warmupBars_W"]
    assert family_b.RSI_WARMUP_BARS == _fixture("b_rsi_fixture.json")["params"]["matrix_warmupBars"]
    assert family_b.STI_WARMUP_BARS == _fixture("b_sti_fixture.json")["params"]["matrix_warmupBars_W"]
    assert family_b.LL_WINDOW_ROWS == _fixture("b_ll_fixture.json")["params"]["window_bars"] == 720
    assert family_b.LL_MIN_SAMPLES == _fixture("b_ll_fixture.json")["params"]["min_samples"] == 30


def test_ll_z_matches_the_fixture_including_warmup_windows_gaps_and_the_flat_stretch() -> None:
    fx = _fixture("b_ll_fixture.json")
    frames = _ll_series(fx)
    w = fx["params"]["warmupBars_W"]
    for name, run in fx["series"].items():
        got = family_b.ll_z(frames["BTCUSDT"], frames[name], name)
        want = _arr(run["btcLeadLagZ"])
        assert list(got.index) == list(frames[name]["t"] + H)
        g = got.to_numpy()
        assert np.array_equal(np.isnan(g), np.isnan(want)), name
        if np.isfinite(want).any():
            assert np.max(np.abs(g - want)[np.isfinite(want)]) < 1e-12, name
    # the cases the fixture was built for: windows starting inside the mask, at its edge and after it, the flat
    # stretch (epsilon rule), the BTC gap and the alt's own gap
    want_a = _arr(fx["series"]["ALTAUSDT"]["btcLeadLagZ"])
    got_a = family_b.ll_z(frames["BTCUSDT"], frames["ALTAUSDT"], "ALTAUSDT").to_numpy()
    assert np.isnan(got_a[: w + 31]).all()  # raw NaN through the mask, then fewer than 30 samples
    assert np.isfinite(got_a[w + 31 + 60 : w + 31 + 70]).any() or np.isfinite(want_a[w + 100 :]).any()
    assert np.isnan(got_a[w + 31 : w + 45]).all()  # the flat stretch: no spread
    for name in ("ALTAUSDT", "ALTBUSDT"):
        g = family_b.ll_z(frames["BTCUSDT"], frames[name], name).to_numpy()
        assert np.isfinite(g[w + 721 :]).sum() > 0  # after the mask the window holds finite rows only
    # BTCUSDT and a missing market series give all NaN
    assert family_b.ll_z(frames["BTCUSDT"], frames["BTCUSDT"], "BTCUSDT").isna().all()
    assert family_b.ll_z(None, frames["ALTAUSDT"], "ALTAUSDT").isna().all()
    assert family_b.ll_z(frames["BTCUSDT"].iloc[0:0], frames["ALTAUSDT"], "ALTAUSDT").isna().all()


def test_trailing_zscore_is_the_running_sum_form_not_a_rolling_window() -> None:
    fx = _fixture("b_ll_fixture.json")
    frames = _ll_series(fx)
    w = fx["params"]["warmupBars_W"]
    # raw series of ALTBUSDT: a stretch that is constant to rounding noise (the epsilon case)
    btc = frames["BTCUSDT"].set_index("t")["c"]
    alt = frames["ALTBUSDT"]
    btc_ret = (btc / btc.shift(1) - 1.0).reindex(alt["t"]).to_numpy()
    own = alt["c"].to_numpy()
    own_ret = np.r_[np.nan, own[1:] / own[:-1] - 1.0]
    raw = btc_ret - own_ret
    raw[:w] = np.nan
    want = _arr(fx["series"]["ALTBUSDT"]["btcLeadLagZ"])
    ours = np.r_[np.nan, family_b.trailing_zscore(raw, 720, 30)[:-1]]
    assert np.array_equal(np.isnan(ours), np.isnan(want))
    # a near-constant stretch by hand: the running sums cannot resolve a spread below 1e-12 of the mean square, so the
    # epsilon rule gives NaN, while a rolling window recomputed from scratch is finite (Opus E3)
    rng = np.random.default_rng(5)
    near = 1e8 + rng.normal(0.0, 1e-4, 200)
    ported = family_b.trailing_zscore(near, 100, 30)
    assert np.isnan(ported).all()
    roll = pd.Series(near)
    naive = ((roll - roll.rolling(100, min_periods=30).mean()) / roll.rolling(100, min_periods=30).std()).to_numpy()
    assert np.isfinite(naive[30:]).all()
    # an exactly constant stretch and a stretch that stops moving give NaN
    assert np.isnan(family_b.trailing_zscore(np.full(100, 0.1), 50, 30)).all()
    series = np.r_[np.linspace(0.0, 1.0, 40), np.full(60, 0.3)]
    out = family_b.trailing_zscore(series, 30, 10)
    assert np.isfinite(out[:40][10:]).all() and np.isnan(out[75:]).all()
    # the window and the minimum sample count: NaN entries join neither
    x = np.r_[rng.normal(size=20), np.nan, rng.normal(size=20)]
    z = family_b.trailing_zscore(x, 25, 5)
    assert np.isnan(z[:4]).all() and np.isfinite(z[4]) and np.isnan(z[20])
    window = x[41 - 25 : 41]
    window = window[np.isfinite(window)]
    assert abs(z[40] - (x[40] - window.mean()) / window.std(ddof=1)) < 1e-12


def test_rsi5_thresholds_and_months_match_the_fixture() -> None:
    fx = _fixture("b_rsi_fixture.json")
    p = fx["params"]
    five = pd.DataFrame({"t": fx["t"], "c": fx["close"]})
    r = family_b.rsi5(five)
    want = _arr(fx["rsi"])
    got = r.to_numpy()
    assert np.array_equal(np.isnan(got), np.isnan(want))
    assert np.isnan(got[: p["matrix_warmupBars"]]).all() and np.isfinite(got[p["matrix_warmupBars"] :]).all()
    assert np.max(np.abs(got - want)[np.isfinite(want)]) < 1e-10
    th = family_b.rsi_thresholds(r.index, got, p["lookbackDays"], p["intervalMs"], p["minValues"], tuple(p["probs"]))
    months = fx["thresholds_by_month"]
    assert sorted(th) == [m["month_start_ms"] for m in months]
    for m in months:
        have = th[m["month_start_ms"]]
        if m["thresholds"] is None:
            assert have is None, m["month_iso"]
        else:
            assert have is not None and max(abs(a - b) for a, b in zip(have, m["thresholds"], strict=True)) < 1e-12
    by_iso = {m["month_iso"]: m["thresholds"] for m in months}
    # the cases: first month, half-window rule, below 200 finite values, p10 >= p90, exactly 200 passes, 199 fails
    for iso in ("2024-03", "2024-05", "2024-06", "2024-10"):
        assert by_iso[iso] is None
    assert by_iso["2024-07"][0] >= by_iso["2024-07"][1]
    assert by_iso["2024-09"] is not None
    # the default lookback is 90 days
    assert family_b.RSI_LOOKBACK_DAYS == 90 and family_b.RSI_MIN_VALUES == p["minValues"] == 200


def test_rsi_side_rules_and_boundary_cases() -> None:
    m = 1_711_929_600_000  # 2024-04-01
    t_open = m + np.arange(6) * M5
    rsi = np.array([20.0, 30.0, 50.0, 70.0, 80.0, np.nan])
    th = {m: (30.0, 70.0)}
    T = t_open + M5
    out = family_b.rsi_side(T, t_open, rsi, th)
    assert out["b_side"].iloc[:5].tolist() == [1.0, 1.0, 0.0, -1.0, -1.0]  # <= p10 long, >= p90 short, between 0
    assert np.isnan(out["b_side"].iloc[5]) and np.isnan(out["b_rsi5"].iloc[5])
    # p10 >= p90: a value at or beyond both gives side 0, a value beyond only one gives that side
    both = family_b.rsi_side(T[:3], t_open[:3], np.array([60.0, 50.0, 40.0]), {m: (50.0, 50.0)})
    assert both["b_side"].tolist() == [-1.0, 0.0, 1.0]
    both = family_b.rsi_side(T[:1], t_open[:1], np.array([50.0]), {m: (60.0, 40.0)})
    assert both["b_side"].tolist() == [0.0]  # r <= p10 and r >= p90 both hold
    # a month without thresholds and an absent 5m bar are NaN
    none = family_b.rsi_side(T[:2], t_open[:2], rsi[:2], {m: None})
    assert none["b_side"].isna().all()
    absent = family_b.rsi_side(np.array([m + 40 * M5]), t_open, rsi, th)
    assert absent["b_side"].isna().all()
    # the bar opening at T - 5 minutes is read: T on a month start reads the previous month's last bar
    march = 1_709_251_200_000
    edge = family_b.rsi_side(np.array([m]), np.array([m - M5]), np.array([20.0]), {march: (30.0, 70.0), m: None})
    assert edge["b_side"].tolist() == [1.0]
    assert (
        family_b.rsi_side(np.array([m]), np.array([m - M5]), np.array([20.0]), {m: (30.0, 70.0)})["b_side"].isna().all()
    )


def _flow_frame(fx: dict[str, Any]) -> pd.DataFrame:
    return pd.DataFrame(fx["flow"])


def test_sti_matches_the_fixture_including_absent_buckets_and_zero_totals() -> None:
    fx = _fixture("b_sti_fixture.json")
    p = fx["params"]
    one_h = pd.DataFrame({"t": p["t0_ms"] + np.arange(p["bars"]) * p["step_ms"]})
    got = family_b.sti(_flow_frame(fx), one_h)
    want = _arr(fx["output"]["smallTakerImb"])
    assert list(got.index) == list(one_h["t"] + H)
    g = got.to_numpy()
    assert np.array_equal(np.isnan(g), np.isnan(want))
    assert np.max(np.abs(g - want)[np.isfinite(want)]) < 1e-12
    w = p["matrix_warmupBars_W"]
    assert np.isnan(g[:w]).all() and np.isfinite(g[w])  # bars with full flow before W are still NaN
    # the case bars of the fixture: absent bucket (middle, first, last), whole hour absent, zero totals
    for off in (5, 6, 7, 8, 10, 11, 12):
        assert np.isnan(g[w + off]), off
    for off in (13, 14):
        assert np.isfinite(g[w + off]), off


def test_sti_side_and_a_zero_value() -> None:
    assert family_b.sti_side(np.array([0.2, -0.2, 0.0, np.nan])).tolist()[:3] == [-1.0, 1.0, 0.0]
    assert np.isnan(family_b.sti_side(np.array([np.nan]))[0])


def test_positioning_z_matches_the_fixture_with_every_skip_reason() -> None:
    fx = _fixture("b_pos_fixture.json")
    seen_reasons = set()
    for case in fx["cases"]:
        z, reason = family_b.positioning_z([(a, b) for a, b in case["points"]], case["barClose"])
        res = case["result"]
        if "skip" in res:
            assert z is None and reason == res["skip"], case["name"]
            seen_reasons.add(reason)
        else:
            assert reason is None and z is not None and abs(z - res["z"]) < 1e-12, case["name"]
    assert seen_reasons == {"ratio_stale", "ratio_incomplete", "ratio_no_spread"}
    zero = next(c for c in fx["cases"] if c["name"] == "z_exactly_zero")
    z, _ = family_b.positioning_z([(a, b) for a, b in zero["points"]], zero["barClose"])
    assert z == 0.0
    assert family_b.pos_side(np.array([z]), np.array([zero["barClose"]])).tolist() == [0.0]


def test_pos_z_vectorised_equals_positioning_z_on_every_fixture_case_and_on_random_data() -> None:
    fx = _fixture("b_pos_fixture.json")
    for case in fx["cases"]:
        pts = pd.DataFrame(case["points"], columns=["t", "topTraderPositionRatio"])
        pts = pts.loc[pts["t"] % family_b.POS_PERIOD_MS == 0]
        got = family_b.pos_z(pts)
        z, _ = family_b.positioning_z([(a, b) for a, b in case["points"]], case["barClose"])
        have = got.get(case["barClose"], np.nan)
        if z is None:
            assert np.isnan(have), case["name"]
        else:
            assert abs(have - z) < 1e-12, case["name"]
    rng = np.random.default_rng(3)
    stamps = TIER_B_START + np.arange(900) * family_b.POS_PERIOD_MS
    vals = np.exp(np.cumsum(rng.normal(0, 0.05, 900)))
    vals[400] = -1.0
    keep = np.ones(900, dtype=bool)
    keep[500] = False
    m = pd.DataFrame({"t": stamps[keep], "topTraderPositionRatio": vals[keep]})
    z = family_b.pos_z(m)
    pts = list(zip(m["t"].tolist(), m["topTraderPositionRatio"].tolist(), strict=True))
    for T in z.index[::37]:
        ref, _ = family_b.positioning_z(pts, int(T))
        assert (np.isnan(z.loc[T]) and ref is None) or abs(z.loc[T] - ref) < 1e-12


def test_the_pos_noise_schedule_is_00_08_16_only() -> None:
    day = 1_700_000_000_000 // DAY * DAY
    T = day + np.arange(6) * 4 * H  # 00:00, 04:00, ... 20:00
    s = family_b.noise_side("BTCUSDT", T, 11_500_004, "b_noise_pos")
    assert s[[1, 3, 5]].tolist() == [0.0, 0.0, 0.0]  # 04:00, 12:00, 20:00
    assert (s[[0, 2, 4]] != 0).all()  # 00:00, 08:00, 16:00
    every = family_b.noise_side("BTCUSDT", T, 11_500_004, "b_noise_sti")
    assert (every != 0).all() and set(np.unique(every)) <= {-1.0, 1.0}
    with pytest.raises(ValueError):
        family_b.noise_side("BTCUSDT", T, 1, "b_pos")
    # the same hash as the declaration: the sign of hash_normal(NOISE_DOMAIN, seed, coin index, 99, T)
    from r4 import hashfeat

    z = hashfeat.hash_normal(hashfeat.NOISE_DOMAIN, 11_500_000, hashfeat.universe_index("ETHUSDT"), 99, T)
    assert np.array_equal(family_b.noise_side("ETHUSDT", T, 11_500_000, "b_noise_sti"), np.sign(z))


# ---------------------------------------------------------------------------------------------------------------------
# Causality (A5.1): future invariance at each input's closing rule
# ---------------------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def synth_panel() -> dict[str, dict[str, pd.DataFrame]]:
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=3, inject_signal=True)
    return family_b.synthetic_tier_b(panel, 11)


def _t_values(frame_t: pd.Series, interval_ms: int, picks: list[int]) -> list[int]:
    return [int(frame_t.iloc[i]) + interval_ms for i in picks]


def test_ll_z_is_future_invariant(synth_panel: dict[str, dict[str, pd.DataFrame]]) -> None:
    btc = synth_panel["BTCUSDT"]["1h"]
    eth = synth_panel["ETHUSDT"]["1h"]

    def build(btc_1h: pd.DataFrame, coin_1h: pd.DataFrame) -> pd.DataFrame:
        return family_b.ll_z(btc_1h, coin_1h, "ETHUSDT").to_frame()

    base = build(btc, eth)
    Ts = _t_values(eth["t"], H, [260, 700, 1500, 2500])
    assert all(np.isfinite(base.loc[T, "b_ll_z"]) for T in Ts)
    assert_future_invariant(build, [(btc, H), (eth, H)], Ts)


def test_rsi_signal_is_future_invariant_thresholds_included(
    synth_panel: dict[str, dict[str, pd.DataFrame]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(family_b, "RSI_LOOKBACK_DAYS", 20)
    five = synth_panel["ETHUSDT"]["5m"]
    t_grid = np.asarray(synth_panel["ETHUSDT"]["1h"]["t"], dtype=np.int64) + H

    def build(five_min: pd.DataFrame) -> pd.DataFrame:
        return family_b.rsi_signal(five_min, t_grid)

    Ts = [int(t_grid[i]) for i in (900, 1400, 2200, 2900)]  # all after the first month with thresholds
    base = build(five)
    assert all(np.isfinite(base.loc[T, "b_side"]) for T in Ts)
    assert_future_invariant(build, (five, M5), Ts)
    # rsi5 on its own, indexed by the bar open
    r = family_b.rsi5(five)
    assert r.index[0] == five["t"].iloc[0]


def test_sti_is_future_invariant_and_a_leaky_variant_fails(synth_panel: dict[str, dict[str, pd.DataFrame]]) -> None:
    flow = synth_panel["ETHUSDT"]["flow_5m"]
    one_h = synth_panel["ETHUSDT"]["1h"]
    Ts = _t_values(one_h["t"], H, [600, 1200, 2000])

    def build(flow_5m: pd.DataFrame, bars: pd.DataFrame) -> pd.DataFrame:
        return family_b.sti(flow_5m, bars).to_frame()

    assert all(np.isfinite(build(flow, one_h).loc[T, "b_sti"]) for T in Ts)
    assert_future_invariant(build, [(flow, TIER_B_STAMP_MS), (one_h, H)], Ts)
    _perturb_columns_and_assert_unchanged(build, flow, one_h, Ts, "flow")

    def leaky(flow_5m: pd.DataFrame, bars: pd.DataFrame) -> pd.DataFrame:
        # a port that also reads the bucket stamped T: every row appears five minutes earlier
        return family_b.sti(flow_5m.assign(t=flow_5m["t"] - M5), bars).to_frame()

    with pytest.raises(AssertionError):
        assert_future_invariant(leaky, [(flow, TIER_B_STAMP_MS), (one_h, H)], Ts)
    with pytest.raises(AssertionError):
        _perturb_columns_and_assert_unchanged(leaky, flow, one_h, Ts, "flow")


def _perturb_columns_and_assert_unchanged(
    build: Any, frame: pd.DataFrame, other: pd.DataFrame | None, Ts: list[int], kind: str
) -> None:
    """Opus E1: assert_future_invariant perturbs only o, h, l, c, v, tbv and rate, so perturb the Tier B columns too."""
    cols = (
        ["buyQuote", "sellQuote", "buyQuoteSmall", "sellQuoteSmall", "buyQuoteOpen10s", "sellQuoteOpen10s"]
        if kind == "flow"
        else ["topTraderPositionRatio"]
    )
    rng = np.random.default_rng(9)
    for T in Ts:
        args = (frame,) if other is None else (frame, other)
        base = build(*args).loc[T]
        pert = frame.copy()
        unclosed = pert["t"] + TIER_B_STAMP_MS > T
        for c in cols:
            pert.loc[unclosed, c] = pert.loc[unclosed, c] * rng.uniform(0.5, 2.0, size=int(unclosed.sum()))
        args2 = (pert,) if other is None else (pert, other)
        again = build(*args2).loc[T]
        pd.testing.assert_series_equal(base, again, check_exact=True)


def test_pos_z_is_future_invariant_and_a_leaky_variant_fails(synth_panel: dict[str, dict[str, pd.DataFrame]]) -> None:
    metrics = synth_panel["ETHUSDT"]["metrics_5m"]

    def build(m: pd.DataFrame) -> pd.DataFrame:
        return family_b.pos_z(m).to_frame()

    z = build(metrics)
    Ts = [int(t) for t in z.index[z["b_pos_z"].notna()][[20, 120, 300]]]
    assert_future_invariant(build, (metrics, TIER_B_STAMP_MS), Ts)
    _perturb_columns_and_assert_unchanged(build, metrics, None, Ts, "metrics")

    def leaky(m: pd.DataFrame) -> pd.DataFrame:
        # a port that reads the point stamped T itself (cutoff = T instead of T - 4h)
        return family_b.pos_z(m).rename(index=lambda t: t - family_b.POS_PERIOD_MS).to_frame()

    with pytest.raises(AssertionError):
        _perturb_columns_and_assert_unchanged(leaky, metrics, None, Ts, "metrics")


@pytest.mark.parametrize("rule", ["b_ll", "b_rsi", "b_sti", "b_pos"])
def test_the_frame_s_side_and_signal_columns_are_future_invariant(
    rule: str, synth_panel: dict[str, dict[str, pd.DataFrame]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(family_b, "RSI_LOOKBACK_DAYS", 20)
    interval = "4h" if rule == "b_pos" else "1h"
    ims = 4 * H if rule == "b_pos" else H
    eth, btc = synth_panel["ETHUSDT"], synth_panel["BTCUSDT"]

    def build(btc_1h: pd.DataFrame, bars: pd.DataFrame, five: pd.DataFrame, flow: pd.DataFrame, metrics: pd.DataFrame):
        d = {interval: bars, "1h": bars if interval == "1h" else eth["1h"], "5m": five}
        panel = {"BTCUSDT": {"1h": btc_1h}, "ETHUSDT": {**d, "flow_5m": flow, "metrics_5m": metrics}}
        T = bars["t"].to_numpy(dtype=np.int64) + ims
        side, sig = family_b._primary_columns(rule, panel, "ETHUSDT", interval, T)
        return pd.DataFrame({"b_side": side, "signal": sig}, index=pd.Index(T, name="T"))

    inputs = {
        "btc_1h": (btc["1h"], H),
        "bars": (eth[interval], ims),
        "five": (eth["5m"], M5),
        "flow": (eth["flow_5m"], TIER_B_STAMP_MS),
        "metrics": (eth["metrics_5m"], TIER_B_STAMP_MS),
    }
    base = build(**{k: v[0] for k, v in inputs.items()})
    ok = base.index[base["b_side"].notna() & base["signal"].notna()]
    if rule == "b_pos":
        ok = ok[family_b.pos_scheduled(ok)]
    picks = [int(ok[i]) for i in np.linspace(len(ok) // 5, len(ok) - 5, 3).astype(int)]
    assert len(picks) == 3
    assert_future_invariant(build, inputs, picks)


def test_rows_before_the_tier_b_start_never_change_sti_or_pos_z() -> None:
    # 1h bars from 2022-12-01, flow rows throughout: only rows from 2023-01-01 may be read
    t_bar = np.arange(TIER_B_START - 31 * DAY, TIER_B_START + 40 * DAY, H, dtype=np.int64)
    one_h = pd.DataFrame({"t": t_bar})
    buckets = np.arange(TIER_B_START - 31 * DAY, TIER_B_START + 40 * DAY, M5, dtype=np.int64)
    rng = np.random.default_rng(1)
    n = len(buckets)
    flow = pd.DataFrame(
        {
            "t": buckets,
            "buyQuote": rng.uniform(1, 2, n),
            "sellQuote": rng.uniform(1, 2, n),
            "buyQuoteSmall": rng.uniform(0.1, 0.5, n),
            "sellQuoteSmall": rng.uniform(0.1, 0.5, n),
            "buyQuoteOpen10s": rng.uniform(0.1, 0.2, n),
            "sellQuoteOpen10s": rng.uniform(0.1, 0.2, n),
        }
    )
    full = family_b.sti(flow, one_h)
    cut = family_b.sti(flow.loc[flow["t"] >= TIER_B_START], one_h)
    assert full.equals(cut)
    # the first value that can be finite needs 12 buckets from 2023-01-01
    first_possible = TIER_B_START + 12 * M5
    assert full.loc[full.index < first_possible].isna().all()
    assert full.loc[full.index >= max(first_possible, int(one_h["t"].iloc[family_b.STI_WARMUP_BARS]) + H)].notna().any()
    # a flow row before the start never leaks in: perturb it
    odd = flow.copy()
    odd.loc[odd["t"] < TIER_B_START, "buyQuote"] = 1e9
    assert family_b.sti(odd, one_h).equals(full)
    # pos_z: 180 points are needed after the start
    stamps = np.arange(
        TIER_B_START - 400 * family_b.POS_PERIOD_MS, TIER_B_START + 400 * family_b.POS_PERIOD_MS, family_b.POS_PERIOD_MS
    )
    ratio = 1 + 0.01 * rng.standard_normal(len(stamps)).cumsum() ** 2 / 50 + 1.0
    m = pd.DataFrame({"t": stamps, "topTraderPositionRatio": ratio})
    z = family_b.pos_z(m)
    z_cut = family_b.pos_z(m.loc[m["t"] >= TIER_B_START])
    assert z.equals(z_cut)
    first_finite = int(z.index[z.notna()][0])
    assert first_finite == TIER_B_START + (family_b.POS_POINTS - 1) * family_b.POS_PERIOD_MS + family_b.POS_LAG_MS


# ---------------------------------------------------------------------------------------------------------------------
# The v8 reader (A8.1)
# ---------------------------------------------------------------------------------------------------------------------

SYN_DECISION_SOURCE = "d" * 64


def _canon(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _v8_export(
    tmp: Path,
    interval: str,
    rows: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    name: str = "exp",
    **summary_extra: Any,
) -> Path:
    root = tmp / f"{name}_{interval}"
    root.mkdir(parents=True, exist_ok=True)
    summary = {
        "rule": f"v8-{interval}",
        "manifest_hash": SYN_DECISION_SOURCE,
        "span_end_dropped": 7,
        "n_tranches": len(rows),
        **summary_extra,
    }
    # a summary that a plain (unsorted, spaced) dump would hash differently from the canonical form
    (root / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    body = "".join(json.dumps(r) + "\n" for r in rows)
    (root / "tranches.jsonl").write_text(body, encoding="utf-8")
    cert = tmp / "cert.json"
    cert.write_text(json.dumps({"all_gap_free": True, "dataset": SYN_DECISION_SOURCE}), encoding="utf-8")
    monkeypatch.setattr(family_b, "V8_DECISION_SOURCE", SYN_DECISION_SOURCE)
    monkeypatch.setitem(family_b.V8_SUMMARY_CANONICAL_SHA256, interval, _canon(summary))
    monkeypatch.setitem(family_b.V8_TRANCHES_SHA256, interval, hashlib.sha256(body.encode()).hexdigest())
    monkeypatch.setattr(family_b, "V8_GRID_CERT", (str(cert), hashlib.sha256(cert.read_bytes()).hexdigest()))
    return root


def _row(
    interval: str, symbol: str, entry: int, side: int = 1, hold: int | None = None, **extra: Any
) -> dict[str, Any]:
    h = {"1h": 24 * H, "4h": 120 * H}[interval]
    return {
        "rule": f"v8-{interval}",
        "symbol": symbol,
        "side": side,
        "entry_ms": entry,
        "exit_ms": entry + (h if hold is None else hold),
        "entry_price": 100.0,
        "exit_price": 101.0,
        "weight": 0.05,
        "exit_reason": "horizon",
        **extra,
    }


def test_v8_reader_accepts_the_canonical_digest_where_a_byte_digest_differs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows = [_row("1h", "BTCUSDT", T0), _row("1h", "ETHUSDT", T0 + 3 * H, -1)]
    root = _v8_export(tmp_path, "1h", rows, monkeypatch)
    frame = family_b.read_v8_decisions(root, "1h")
    assert frame.to_dict("records") == [
        {"symbol": "BTCUSDT", "T": T0, "side": 1},
        {"symbol": "ETHUSDT", "T": T0 + 3 * H, "side": -1},
    ]
    summary_bytes = (root / "summary.json").read_bytes()
    assert hashlib.sha256(summary_bytes).hexdigest() != family_b.V8_SUMMARY_CANONICAL_SHA256["1h"]
    a = frame.attrs
    assert a["decision_source"] == SYN_DECISION_SOURCE and a["span_end_dropped"] == 7
    assert a["summary_sha256"] == family_b.V8_SUMMARY_CANONICAL_SHA256["1h"]
    assert a["tranches_sha256"] == family_b.V8_TRANCHES_SHA256["1h"]
    assert a["cert_sha256"] == family_b.V8_GRID_CERT[1] and a["n_terminal_excluded"] == 0


def test_v8_reader_refuses_a_wrong_digest_certificate_rule_or_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows = [_row("1h", "BTCUSDT", T0)]
    root = _v8_export(tmp_path, "1h", rows, monkeypatch)
    family_b.read_v8_decisions(root, "1h")
    # a wrong tranches byte digest
    with monkeypatch.context() as m:
        m.setitem(family_b.V8_TRANCHES_SHA256, "1h", "0" * 64)
        with pytest.raises(ValueError, match="tranches.jsonl sha256"):
            family_b.read_v8_decisions(root, "1h")
    # a wrong canonical summary digest
    with monkeypatch.context() as m:
        m.setitem(
            family_b.V8_SUMMARY_CANONICAL_SHA256, "1h", hashlib.sha256((root / "summary.json").read_bytes()).hexdigest()
        )
        with pytest.raises(ValueError, match="summary canonical sha256"):
            family_b.read_v8_decisions(root, "1h")
    # a wrong certificate digest
    with monkeypatch.context() as m:
        m.setattr(family_b, "V8_GRID_CERT", (family_b.V8_GRID_CERT[0], "0" * 64))
        with pytest.raises(ValueError, match="certificate sha256"):
            family_b.read_v8_decisions(root, "1h")
    # a certificate that is not gap free, or on another dataset, with its own (matching) digest
    for body in ({"all_gap_free": False, "dataset": SYN_DECISION_SOURCE}, {"all_gap_free": True, "dataset": "x"}):
        bad = tmp_path / "bad_cert.json"
        bad.write_text(json.dumps(body), encoding="utf-8")
        with monkeypatch.context() as m:
            m.setattr(family_b, "V8_GRID_CERT", (str(bad), hashlib.sha256(bad.read_bytes()).hexdigest()))
            with pytest.raises(ValueError, match="all_gap_free"):
                family_b.read_v8_decisions(root, "1h")
    # the wrong interval for the export's rule, and a wrong manifest hash
    other = _v8_export(tmp_path, "4h", [_row("4h", "BTCUSDT", T0 // (4 * H) * 4 * H)], monkeypatch, name="o")
    with pytest.raises(ValueError, match="rule"):
        # the 1h digests are declared for the 1h export: read the 4h export as 1h with its digests patched
        with monkeypatch.context() as m:
            m.setitem(family_b.V8_SUMMARY_CANONICAL_SHA256, "1h", family_b.V8_SUMMARY_CANONICAL_SHA256["4h"])
            m.setitem(family_b.V8_TRANCHES_SHA256, "1h", family_b.V8_TRANCHES_SHA256["4h"])
            family_b.read_v8_decisions(other, "1h")
    wrong_src = _v8_export(tmp_path, "1h", rows, monkeypatch, name="w", manifest_hash="e" * 64)
    with pytest.raises(ValueError, match="manifest_hash"):
        family_b.read_v8_decisions(wrong_src, "1h")
    with pytest.raises(ValueError, match="interval"):
        family_b.read_v8_decisions(root, "15m")


def test_v8_reader_row_checks_stop_rows_duplicates_grid_and_the_hold_assertion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # a stop row with no exit price stays: no row is dropped for its exit
    stop = _row("1h", "BTCUSDT", T0, exit_price=None, exit_reason="stop", hold=5 * H)
    root = _v8_export(tmp_path, "1h", [stop, _row("1h", "BTCUSDT", T0 + 6 * H)], monkeypatch)
    assert family_b.read_v8_decisions(root, "1h")["T"].tolist() == [T0, T0 + 6 * H]
    dup = _v8_export(tmp_path, "1h", [_row("1h", "BTCUSDT", T0), _row("1h", "BTCUSDT", T0, -1)], monkeypatch, name="d")
    with pytest.raises(ValueError, match="duplicate"):
        family_b.read_v8_decisions(dup, "1h")
    off = _v8_export(tmp_path, "1h", [_row("1h", "BTCUSDT", T0 + 5 * M5)], monkeypatch, name="g")
    with pytest.raises(ValueError, match="grid"):
        family_b.read_v8_decisions(off, "1h")
    off4 = _v8_export(tmp_path, "4h", [_row("4h", "BTCUSDT", T0 // (4 * H) * 4 * H + H)], monkeypatch, name="g4")
    with pytest.raises(ValueError, match="grid"):
        family_b.read_v8_decisions(off4, "4h")
    badside = _v8_export(tmp_path, "1h", [_row("1h", "BTCUSDT", T0, 0)], monkeypatch, name="s")
    with pytest.raises(ValueError, match="side"):
        family_b.read_v8_decisions(badside, "1h")
    wrong_rule = _v8_export(tmp_path, "1h", [_row("1h", "BTCUSDT", T0, rule="v8-4h")], monkeypatch, name="r")
    with pytest.raises(ValueError, match="rule"):
        family_b.read_v8_decisions(wrong_rule, "1h")
    # exit_ms > entry_ms + H from 2023-12-02 raises, and the same row before 2023-12-02 is accepted
    after = family_b.V8_ASSERT_FROM_MS + 10 * H
    bad = _v8_export(tmp_path, "1h", [_row("1h", "BTCUSDT", after, hold=24 * H + H)], monkeypatch, name="a")
    with pytest.raises(ValueError, match="terminal exclusion"):
        family_b.read_v8_decisions(bad, "1h")
    before = family_b.V8_ASSERT_FROM_MS - 100 * H
    ok = _v8_export(tmp_path, "1h", [_row("1h", "BTCUSDT", before, hold=24 * H + H)], monkeypatch, name="b")
    assert family_b.read_v8_decisions(ok, "1h")["T"].tolist() == [before]
    edge = _v8_export(tmp_path, "1h", [_row("1h", "BTCUSDT", family_b.V8_ASSERT_FROM_MS)], monkeypatch, name="e")
    assert len(family_b.read_v8_decisions(edge, "1h")) == 1
    never = _v8_export(
        tmp_path, "4h", [_row("4h", "BTCUSDT", after // (4 * H) * 4 * H, hold=121 * H)], monkeypatch, name="n"
    )
    with pytest.raises(ValueError, match="terminal exclusion"):
        family_b.read_v8_decisions(never, "4h")


def test_the_terminal_exclusion_uses_t_alone_and_never_depends_on_dropped_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hold = family_b.V8_MAX_HOLD_MS["1h"]
    cut = DEV_END - hold  # a decision at T has T + H < DEV_END exactly when T < cut
    cut -= cut % H
    below = [_row("1h", "BTCUSDT", cut - 30 * H), _row("1h", "ETHUSDT", cut - 2 * H, -1)]
    # a harness-like export on contiguous bars: rows at or after the cut would exit past DEV_END and are dropped
    kept_rows = [*below, _row("1h", "BTCUSDT", cut - H, hold=hold)]
    with_end = [*kept_rows, _row("1h", "SOLUSDT", cut, hold=hold - 3 * H), _row("1h", "ADAUSDT", cut + 5 * H)]
    a = family_b.read_v8_decisions(_v8_export(tmp_path, "1h", with_end, monkeypatch, name="full"), "1h")
    b = family_b.read_v8_decisions(_v8_export(tmp_path, "1h", kept_rows, monkeypatch, name="cutoff"), "1h")
    assert a.equals(b)
    assert a["T"].max() < cut and len(a) == 3
    assert a.attrs["n_terminal_excluded"] == 2 and b.attrs["n_terminal_excluded"] == 0
    # the boundary itself: T = cut - H is kept, T = cut is not
    assert (a["T"] + hold < DEV_END).all()


def test_the_committed_certificate_has_its_declared_digest() -> None:
    cert = PY / family_b.V8_GRID_CERT[0]
    assert hashlib.sha256(cert.read_bytes()).hexdigest() == family_b.V8_GRID_CERT[1]
    body = json.loads(cert.read_text(encoding="utf-8"))
    assert body["all_gap_free"] is True and body["dataset"] == family_b.V8_DECISION_SOURCE
    assert family_b.V8_DECISION_SOURCE == "48ff79609080f11a48c45822f27cd609818b913b2d42455cddf4ea1ef4806e93"
    assert family_b.V8_ASSERT_FROM_MS == 1_701_475_200_000
    assert family_b.V8_MAX_HOLD_MS == {"1h": 24 * H, "4h": 120 * H}
    assert family_b.V8_SUMMARY_CANONICAL_SHA256["1h"].startswith("1a217d0c")
    assert family_b.V8_SUMMARY_CANONICAL_SHA256["4h"].startswith("87a5c1da")
    assert family_b.V8_TRANCHES_SHA256["1h"].startswith("2778c45b")
    assert family_b.V8_TRANCHES_SHA256["4h"].startswith("50fd3966")


def test_family_b_never_calls_natives_read_export() -> None:
    src = (PY / "r4" / "family_b.py").read_text(encoding="utf-8")
    assert "read_export" not in src.replace("natives.read_export", "").replace("never through", "")
    tree = ast.parse(src)
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "read_export"]
    assert calls == []
    imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module == "r4" for a in n.names}
    assert "natives" not in imported


def test_v8_side_lookup_and_the_terminal_cut_in_the_frame_columns() -> None:
    hold = family_b.V8_MAX_HOLD_MS["1h"]
    T = DEV_END - hold + np.arange(-3, 4) * H
    dec = pd.DataFrame({"symbol": ["BTCUSDT"] * 2, "T": [int(T[0]), int(T[1])], "side": [1, -1]})
    panel = {"BTCUSDT": {"b_v8_1h": dec}}
    side, sig = family_b._primary_columns("b_v8", panel, "BTCUSDT", "1h", T)
    assert sig is None
    assert side[:2].tolist() == [1.0, -1.0] and side[2] == 0.0  # no entry: 0
    # T + H at or after DEV_END is undefined (NaN), T + H before it is defined
    assert np.isnan(side[3:]).all() and np.isfinite(side[:3]).all()
    assert T[2] + hold < DEV_END <= T[3] + hold
    with pytest.raises(ValueError, match="b_v8_4h"):
        family_b._primary_columns("b_v8", panel, "BTCUSDT", "4h", T)


# ---------------------------------------------------------------------------------------------------------------------
# The frame
# ---------------------------------------------------------------------------------------------------------------------


ORIGINAL_FRAME_FEATURES = family_b.frame_features


@pytest.fixture
def real_frame_features(monkeypatch: pytest.MonkeyPatch) -> None:
    """Undo the autouse patch below for a test that needs family A's full F (40 features at 1h)."""
    monkeypatch.setattr(family_b, "frame_features", ORIGINAL_FRAME_FEATURES)


@pytest.fixture(autouse=True)
def _small_frame_features(monkeypatch: pytest.MonkeyPatch) -> None:
    """The noise frames use frame_features(interval): the tests use two cheap features so the panels stay small."""
    monkeypatch.setattr(family_b, "frame_features", lambda interval: SMALL_F)


def _cfg(
    rule: str = "b_sti",
    model: str = "lightgbm",
    *,
    interval: str = "1h",
    h_ms: int = 4 * H,
    lookback: int | None = None,
    params: dict[str, Any] | None = None,
    noise_seed: int | None = None,
    no_seed: bool = False,
    **over: Any,
) -> RunConfig:
    sig = family_b.SIGNAL_COLUMN.get(rule)
    noise = rule in family_b.NOISE_SIDE_RULES
    feats = (*calibration.NOISE_FEATURES, "b_side") if noise else (*SMALL_F, "b_side", *([] if sig is None else [sig]))
    is_rule = model == "rule"
    kwargs: dict[str, Any] = {
        "family": "B",
        "model": model,
        "params": {} if is_rule else (params or {"n_estimators": 12, "num_leaves": 7, "min_child_samples": 10}),
        "features": feats,
        "interval": interval,
        "h_ms": h_ms,
        "label": "meta",
        "side_rule": rule,
        "threshold": 0.0 if is_rule else 0.5,
        "size_rule": "unit" if is_rule else "afml",
        "lookback_months": lookback,
        "refit": "monthly",
        "exit": "horizon",
        "seed": 7,
        "book": "slot",
        "noise_seed": None if no_seed else ((11_500_000 if noise else None) if noise_seed is None else noise_seed),
    }
    kwargs.update(over)
    return RunConfig(**kwargs)


def test_runconfig_validation_for_each_rule() -> None:
    assert _cfg().family == "B" and _cfg().exit == "horizon"
    assert _cfg("b_v8").side_rule == "b_v8"
    assert _cfg("b_pos", interval="4h", h_ms=8 * H).side_rule == "b_pos"
    assert _cfg("b_noise_sti").noise_seed == 11_500_000
    assert _cfg("b_sti", "rule").size_rule == "unit"
    bad: list[dict[str, Any]] = [
        {"model": "ridge", "params": {}},
        {"model": "logistic", "params": {}},
        {"label": "fixed"},
        {"side_rule": "prob"},
        {"side_rule": "b_bogus"},
        {"size_rule": "unit"},  # lightgbm needs afml
        {"threshold": 0.4},
        {"threshold": 0.0},
        {"book": "D"},
        {"exit": {"rule": "E2", "k": 2.0}},
        {"exit": {"rule": "E4", "margin_se": 1.0}},
        {"d_weights": "inv_vol"},
        {"d_band": 0.045},
        {"noise_seed": 5},  # an int noise_seed without noise features
        {"features": (*SMALL_F, "b_sti")},  # no b_side
        {"features": (*SMALL_F, "b_side")},  # sti without its own signal
        {"features": (*SMALL_F, "b_side", "b_sti", "b_pos_z")},  # a foreign signal
        {"plant": {"seed": 1, "amplitude": 0.1}},
    ]
    for over in bad:
        with pytest.raises(ValueError):
            _cfg(**over)
    with pytest.raises(ValueError):
        _cfg("b_sti", "rule", threshold=0.5)
    with pytest.raises(ValueError):
        _cfg("b_sti", "rule", size_rule="afml")
    with pytest.raises(ValueError):
        _cfg("b_noise_sti", no_seed=True)  # noise features need a seed
    with pytest.raises(ValueError):
        _cfg("b_noise_pos", features=(*SMALL_F, "b_side"))  # a noise side rule needs noise features
    with pytest.raises(ValueError):
        _cfg("b_noise_sti", features=(*calibration.NOISE_FEATURES, "b_side", "b_sti"))
    with pytest.raises(ValueError):
        _cfg("b_v8", features=(*SMALL_F, "b_side", "b_ll_z"))
    # no field was added to RunConfig: asdict keeps its C4 keys
    fields = set(RunConfig.__dataclass_fields__)
    assert fields == {
        "family", "model", "params", "features", "interval", "h_ms", "label", "side_rule", "threshold", "size_rule",
        "lookback_months", "refit", "exit", "seed", "book", "noise_seed", "plant", "d_weights", "d_band",
    }  # fmt: skip
    # the non-B validation is unchanged
    with pytest.raises(ValueError, match="size_rule"):
        RunConfig(
            family="A", model="ridge", params={}, features=("ret_1",), interval="1h", h_ms=4 * H, label="fixed",
            side_rule="sign", threshold=0.0, size_rule="afml", lookback_months=None, refit="monthly", exit="horizon",
        )  # fmt: skip


def test_pipeline_and_cli_import_family_b_only_inside_branches() -> None:
    for module in ("pipeline.py", "cli.py"):
        tree = ast.parse((PY / "r4" / module).read_text(encoding="utf-8"))
        for node in tree.body:
            if isinstance(node, ast.ImportFrom):
                names = {a.name for a in node.names}
                assert "family_b" not in names and node.module != "r4.family_b", module
            if isinstance(node, ast.Import):
                assert all(a.name != "r4.family_b" for a in node.names), module
    code = "import sys, r4.pipeline, r4.cli; assert 'r4.family_b' not in sys.modules"
    subprocess.run([sys.executable, "-c", code], check=True, cwd=PY, env={"PYTHONPATH": str(PY), "PATH": ""})


def test_every_registry_configuration_builds_and_its_base_frame_config_is_a_plain_non_b_one(
    real_frame_features: None,
) -> None:
    for raw in [*family_b.family_b(), *family_b.family_b_noise()]:
        rc = run_config_from_raw(raw)
        assert rc.family == "B"
        base = family_b.base_config(rc)
        assert base.family == "B-frame" and base.label == "fixed" and base.model == "lightgbm"
        assert base.noise_seed is None and base.book == "slot" and base.exit == "horizon"
        assert not set(base.features) & set(family_b.EXTRA_COLUMNS)
        assert not any(f.startswith("noise_") for f in base.features)
        assert list(base.features) == list(family_a.F_1H if rc.interval == "1h" else family_a.F_4H)


# ---------------------------------------------------------------------------------------------------------------------
# Frame parity, rule and meta frames, labels
# ---------------------------------------------------------------------------------------------------------------------


def test_frame_parity_with_the_frozen_decision_samples_and_hand_labels(
    synth_panel: dict[str, dict[str, pd.DataFrame]],
) -> None:
    cfg = _cfg("b_sti")
    got = decision_samples(synth_panel, cfg)
    a_cfg = RunConfig(
        family="A", model="lightgbm", params={}, features=SMALL_F, interval="1h", h_ms=4 * H, label="fixed",
        side_rule="prob", threshold=0.02, size_rule="unit", lookback_months=24, refit="monthly", exit="horizon",
    )  # fmt: skip
    ref = decision_samples(synth_panel, a_cfg)
    keys = ["symbol", "T", *SMALL_F, "entry", "exit", "gross_log", "t0", "t1_max"]
    merged = got[keys].merge(ref[keys], on=["symbol", "T"], suffixes=("", "_ref"), how="inner")
    assert len(merged) == len(got) and len(got) > 1000
    for c in (*SMALL_F, "entry", "exit", "gross_log", "t0", "t1_max"):
        assert np.array_equal(merged[c].to_numpy(), merged[f"{c}_ref"].to_numpy()), c
    assert list(got.columns) == [
        "symbol",
        "T",
        *cfg.features,
        "entry",
        "exit",
        "gross_log",
        "t0",
        "t1_max",
        "tb_net",
        "tb_net_short",
    ]
    assert got[["T", "symbol"]].equals(got[["T", "symbol"]].sort_values(["T", "symbol"], ignore_index=True))
    assert got.attrs["panel"] is not None and got.attrs["n_dropped"] >= ref.attrs["n_dropped"]
    # tb_net by hand on three rows, one of them with a settlement inside the hold (entry, exit]
    d = synth_panel["ETHUSDT"]
    s_t = d["settlements"]["t"].to_numpy()
    s_r = d["settlements"]["rate"].to_numpy()
    eth = got.loc[got["symbol"] == "ETHUSDT"].reset_index(drop=True)
    with_settlement = None
    for i in range(len(eth)):
        e, x = int(eth["t0"].iloc[i]) + ENTRY_DELAY_MS, int(eth["t1_max"].iloc[i])
        if ((s_t > e) & (s_t <= x)).any():
            with_settlement = i
            break
    assert with_settlement is not None
    for i in (0, len(eth) // 2, with_settlement):
        row = eth.iloc[i]
        e_ms, x_ms = int(row["t0"]) + ENTRY_DELAY_MS, int(row["t1_max"])
        fund = float(s_r[(s_t > e_ms) & (s_t <= x_ms)].sum())
        slip = coin_slippage_bps("ETHUSDT") / 10_000.0
        fee = 0.0005
        for side, col in ((1, "tb_net"), (-1, "tb_net_short")):
            want = side * (row["exit"] / row["entry"] - 1.0) - side * fund - 2 * fee - 2 * slip
            assert abs(row[col] - want) < 1e-12, (i, col)
    by_label = labels.fixed_horizon(
        eth["T"].to_numpy(), d["5m"], 4 * H, 1, "1h", d["settlements"], delay_ms=ENTRY_DELAY_MS, symbol="ETHUSDT"
    )["net"].to_numpy()
    assert np.array_equal(by_label, eth["tb_net"].to_numpy())
    assert (
        abs(
            trade_net_return(1, 100.0, 101.0, 0.0, "1h", symbol="ETHUSDT", slippage_bps=coin_slippage_bps("ETHUSDT"))
            - (0.01 - 0.001 - 2 * coin_slippage_bps("ETHUSDT") / 10_000)
        )
        < 1e-12
    )


def test_a_rule_configuration_and_its_meta_configurations_build_identical_frames(
    synth_panel: dict[str, dict[str, pd.DataFrame]],
) -> None:
    rule = decision_samples(synth_panel, _cfg("b_ll", "rule"))
    meta = decision_samples(synth_panel, _cfg("b_ll", "lightgbm", lookback=12))
    meta_all = decision_samples(synth_panel, _cfg("b_ll", "lightgbm"))
    pd.testing.assert_frame_equal(rule, meta)
    pd.testing.assert_frame_equal(rule, meta_all)
    assert set(rule["symbol"]) == set(UNIVERSE[1:6])  # BTCUSDT never trades: its z is NaN by design
    assert rule["b_ll_z"].notna().all() and set(np.unique(rule["b_side"])) <= {-1.0, 0.0, 1.0}


def test_primary_frames_carry_their_own_signal_and_side(synth_panel: dict[str, dict[str, pd.DataFrame]]) -> None:
    sti = decision_samples(synth_panel, _cfg("b_sti"))
    assert set(np.unique(sti["b_side"])) <= {-1.0, 1.0}
    assert (sti["b_side"] == -np.sign(sti["b_sti"])).all()
    assert sti["T"].min() >= TIER_B_START + 12 * M5
    pos = decision_samples(synth_panel, _cfg("b_pos", interval="4h", h_ms=8 * H))
    sched = family_b.pos_scheduled(pos["T"])
    assert (pos.loc[~sched, "b_side"] == 0).all() and (pos.loc[sched, "b_side"] != 0).any()
    assert (pos.loc[sched, "b_side"] == -np.sign(pos.loc[sched, "b_pos_z"])).all()
    ll = decision_samples(synth_panel, _cfg("b_ll"))
    z = ll["b_ll_z"]
    assert (ll.loc[z >= family_b.LL_Z, "b_side"] == 1).all() and (ll.loc[z <= -family_b.LL_Z, "b_side"] == -1).all()
    assert (ll.loc[z.abs() < family_b.LL_Z, "b_side"] == 0).all()


def test_the_rsi_frame_uses_the_hour_close_five_minute_bar(
    synth_panel: dict[str, dict[str, pd.DataFrame]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(family_b, "RSI_LOOKBACK_DAYS", 20)
    rsi = decision_samples(synth_panel, _cfg("b_rsi"))
    assert len(rsi) > 500 and set(np.unique(rsi["b_side"])) <= {-1.0, 0.0, 1.0} and (rsi["b_side"] != 0).any()
    eth = rsi.loc[rsi["symbol"] == "ETHUSDT"]
    series = family_b.rsi5(synth_panel["ETHUSDT"]["5m"])
    want = series.reindex(eth["T"].to_numpy() - M5).to_numpy()
    assert np.array_equal(eth["b_rsi5"].to_numpy(), want)


def test_labels_y_matches_the_side_net_tripwire_moves_labels_and_leaves_side_and_features(
    synth_panel: dict[str, dict[str, pd.DataFrame]],
) -> None:
    cfg = _cfg("b_sti")
    samples, _ = cli.restrict_to_d(decision_samples(synth_panel, cfg))
    train = samples.loc[(samples["T"] < FIRST_REFIT) & (samples["T"] >= TIER_B_START)].iloc[3:]
    x = train[list(cfg.features)].to_numpy()
    seen: dict[str, Any] = {}

    class Spy:
        def fit(self, X: np.ndarray, y: np.ndarray) -> Spy:
            seen["X"], seen["y"] = X.copy(), y.copy()
            return self

    import r4.pipeline as pl

    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(pl, "_make_model", lambda c: Spy())
        model = family_b.fit_meta(cfg, x, train)
    finally:
        mp.undo()
    side = train["b_side"].to_numpy()
    net = np.where(side > 0, train["tb_net"], train["tb_net_short"])
    assert np.array_equal(seen["y"], (net[side != 0] > 0).astype(int))
    assert np.array_equal(seen["X"], x[side != 0]) and model.kind == "meta"
    # the tripwire shifts the labels and leaves b_side and the features where they are
    shifted, dropped = tripwire.shift_labels(samples, 30 * DAY, H)
    assert dropped >= 0
    keep = samples.merge(shifted[["symbol", "T"]], on=["symbol", "T"])
    assert len(keep) == len(shifted)
    a = samples.set_index(["symbol", "T"]).loc[shifted.set_index(["symbol", "T"]).index]
    s = shifted.set_index(["symbol", "T"])
    assert np.array_equal(a["b_side"].to_numpy(), s["b_side"].to_numpy())
    for f in cfg.features:
        assert np.array_equal(a[f].to_numpy(), s[f].to_numpy())
    assert not np.array_equal(a["tb_net"].to_numpy(), s["tb_net"].to_numpy())
    assert not np.array_equal(a["tb_net_short"].to_numpy(), s["tb_net_short"].to_numpy())
    # a shifted walk-forward trains on the shifted nets
    fits: list[np.ndarray] = []
    real_fit = family_b.fit_meta

    def capture(c: RunConfig, x_train: np.ndarray, train_df: pd.DataFrame) -> Any:
        sd = train_df["b_side"].to_numpy()
        fits.append((np.where(sd > 0, train_df["tb_net"], train_df["tb_net_short"])[sd != 0] > 0).astype(int))
        return real_fit(c, x_train, train_df)

    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(family_b, "fit_meta", capture)
        shifted_s, _ = tripwire.shift_labels(samples, 30 * DAY, H, with_source_window=True)
        walk_forward(shifted_s, cfg, FIRST_REFIT, FIRST_REFIT + 40 * DAY, panel=synth_panel)
        shifted_fits = list(fits)
        fits.clear()
        walk_forward(samples, cfg, FIRST_REFIT, FIRST_REFIT + 40 * DAY, panel=synth_panel)
    finally:
        mp.undo()
    assert len(shifted_fits) >= 1 and len(fits) == len(shifted_fits)
    # the shifted run trained on other labels than the real run, fold by fold
    assert not all(np.array_equal(a, b) for a, b in zip(shifted_fits, fits, strict=True))
    # the shifted labels are those of the same coin 30 days later (the shift_labels contract)
    real_eth = samples.loc[samples["symbol"] == "ETHUSDT"].set_index("T")
    shifted_eth = shifted.loc[shifted["symbol"] == "ETHUSDT"].set_index("T")
    probe = shifted_eth.index[5]
    assert shifted_eth.loc[probe, "tb_net"] == real_eth.loc[probe + 30 * DAY, "tb_net"]


# ---------------------------------------------------------------------------------------------------------------------
# The meta model and the size (A8.4)
# ---------------------------------------------------------------------------------------------------------------------


def _train_df(side: list[float], nets_long: list[float], nets_short: list[float], start: int = 7) -> pd.DataFrame:
    n = len(side)
    return pd.DataFrame(
        {
            "T": T0 + np.arange(n) * H,
            "b_side": side,
            "tb_net": nets_long,
            "tb_net_short": nets_short,
        },
        index=np.arange(start, start + n),
    )


def test_rows_with_no_side_never_train_and_a_non_zero_based_index_selects_the_right_rows() -> None:
    cfg = _cfg("b_sti")
    df = _train_df(
        [1, -1, 0, 1, -1, 0, 1, -1],
        [0.1, 0.1, 0.1, -0.1, 0.2, 0.3, 0.1, -0.2],
        [0.1, -0.1, 0.5, 0.1, 0.2, 0.3, 0.1, 0.2],
    )
    x = np.arange(16, dtype=np.float64).reshape(8, 2)
    seen: dict[str, Any] = {}

    class Spy:
        def fit(self, X: np.ndarray, y: np.ndarray) -> Spy:
            seen["X"], seen["y"] = X, y
            return self

    import r4.pipeline as pl

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(pl, "_make_model", lambda c: Spy())
        family_b.fit_meta(cfg, x, df)
    rows = [0, 1, 3, 4, 6, 7]
    assert np.array_equal(seen["X"], x[rows])
    # long nets for sides +1, short nets for sides -1: rows 0,1,3,4,6,7 -> 0.1, -0.1, -0.1, 0.2, 0.1, 0.2
    assert seen["y"].tolist() == [1, 0, 0, 1, 1, 1]
    assert family_b.fit_meta(_cfg("b_sti", "rule"), x, df).kind == "rule"


def test_degenerate_fits_and_meta_proba() -> None:
    cfg = _cfg("b_sti")
    x = np.zeros((4, 2))
    none = family_b.fit_meta(cfg, x, _train_df([0, 0, 0, 0], [1.0] * 4, [1.0] * 4))
    assert none.up == 0.0 and none.degenerate_fits == ("no_rows",)
    p = family_b.meta_proba(none, np.zeros((3, 2)))
    assert p.dtype == np.float64 and p.tolist() == [0.0] * 3  # no row: p 0, no act
    pos = family_b.fit_meta(cfg, x, _train_df([1, -1, 1, -1], [0.1, 0.1, 0.1, 0.1], [0.1, 0.1, 0.1, 0.1]))
    assert pos.up == 1.0 and pos.degenerate_fits == ("one_class",) and pos.base_up == 1.0
    assert family_b.meta_proba(pos, np.zeros((2, 2))).tolist() == [1.0, 1.0]
    neg = family_b.fit_meta(cfg, x, _train_df([1, -1, 1, -1], [-0.1] * 4, [-0.1] * 4))
    assert neg.up == 0.0 and family_b.meta_proba(neg, np.zeros((2, 2))).tolist() == [0.0, 0.0]
    assert family_b.meta_proba(neg, np.zeros((0, 2))).dtype == np.float64
    # all positive acts at size 1, all negative never acts
    test_df = _test_df([1.0, -1.0])
    t_pos = family_b.make_tranches_b(test_df, family_b.meta_proba(pos, np.zeros((2, 2))), cfg)
    assert [t.size for t in t_pos] == [1.0, 1.0]
    assert family_b.make_tranches_b(test_df, family_b.meta_proba(neg, np.zeros((2, 2))), cfg) == []
    # a rule model: p = 1 everywhere
    rule = family_b.fit_meta(_cfg("b_sti", "rule"), x, _train_df([1] * 4, [0.1] * 4, [0.1] * 4))
    assert family_b.meta_proba(rule, np.zeros((3, 2))).tolist() == [1.0] * 3
    # a fitted classifier gives p in [0, 1] as float64; a broken one raises
    rng = np.random.default_rng(0)
    xs = rng.normal(size=(300, 2))
    ys = rng.normal(size=300)
    df = _train_df(list(rng.choice([-1.0, 1.0], 300)), list(ys), list(ys))
    fitted = family_b.fit_meta(cfg, xs, df)
    pf = family_b.meta_proba(fitted, xs)
    assert pf.dtype == np.float64 and ((pf >= 0) & (pf <= 1)).all() and fitted.degenerate_fits == ()

    class Bad:
        def predict_proba(self, X: np.ndarray) -> np.ndarray:
            return np.column_stack([np.zeros(len(X)), np.full(len(X), np.nan)])

    from r4.pipeline import SideModel

    with pytest.raises(ValueError, match="finite"):
        family_b.meta_proba(SideModel("meta", None, Bad(), None, ()), np.zeros((2, 2)))

    class Out:
        def predict_proba(self, X: np.ndarray) -> np.ndarray:
            return np.column_stack([np.zeros(len(X)), np.full(len(X), 1.2)])

    with pytest.raises(ValueError, match="finite"):
        family_b.meta_proba(SideModel("meta", None, Out(), None, ()), np.zeros((2, 2)))


def _test_df(sides: list[float], p_cfg: RunConfig | None = None) -> pd.DataFrame:
    n = len(sides)
    return pd.DataFrame(
        {
            "T": T0 + np.arange(n) * H,
            "symbol": ["ETHUSDT"] * n,
            "b_side": sides,
            "entry": [100.0] * n,
            "exit": [101.0] * n,
            "t0": T0 + np.arange(n) * H,
            "t1_max": T0 + np.arange(n) * H + ENTRY_DELAY_MS + 4 * H,
            "tb_net": [0.01] * n,
            "tb_net_short": [-0.01] * n,
        }
    )


def test_act_is_strictly_above_one_half_and_afml_size_matches_the_formula() -> None:
    cfg = _cfg("b_sti")
    sides = [1.0, 1.0, 1.0, -1.0, 1.0, 0.0]
    p = np.array([0.5, 0.5000001, 0.55, 0.6, 1.0, 0.9])
    tr = family_b.make_tranches_b(_test_df(sides), p, cfg)
    assert [t.side for t in tr] == [1, 1, -1, 1]  # p = 0.5 and the side-0 row never act
    assert tr[0].size == family_b.afml_size(0.5000001) and 0 < tr[0].size < 1e-6
    for pv, want in ((0.5, 0.0), (0.55, 0.0801), (0.6, 0.1617), (0.7, 0.3375), (1.0, 1.0), (0.0, 0.0)):
        got = family_b.afml_size(pv)
        assert abs(got - want) < 5e-5, pv
    pv = 0.8
    assert abs(family_b.afml_size(pv) - (2 * norm.cdf((pv - 0.5) / np.sqrt(pv * (1 - pv))) - 1)) < 1e-15
    arr = family_b.afml_size(np.array([0.2, 0.5, 0.6, 1.0]))
    assert arr.dtype == np.float64 and arr[0] == 0.0 and arr[1] == 0.0 and arr[3] == 1.0
    for bad in (-0.01, 1.01, np.nan, np.inf):
        with pytest.raises(ValueError):
            family_b.afml_size(bad)
    with pytest.raises(ValueError):
        family_b.afml_size(np.array([0.6, np.nan]))
    # tranche fields: built as the slot path builds them
    t = tr[1]
    assert t.entry_ms == T0 + 2 * H + ENTRY_DELAY_MS and t.exit_ms == T0 + 2 * H + ENTRY_DELAY_MS + 4 * H
    assert (t.entry_fill, t.exit_fill, t.exit_reason, t.weight_override) == ("taker", "taker", "horizon", None)
    assert t.interval == "1h" and t.h_ms == 4 * H and t.entry_price == 100.0 and t.exit_price == 101.0
    assert abs(t.weight - t.size / 4.0 / 10.0) < 1e-15 and t.side == 1
    # a rule configuration: every non-zero side at size 1
    rule = family_b.make_tranches_b(_test_df(sides), np.ones(6), _cfg("b_sti", "rule"))
    assert [t.size for t in rule] == [1.0] * 5 and [t.side for t in rule] == [1, 1, 1, -1, 1]
    with pytest.raises(ValueError):
        family_b.make_tranches_b(_test_df(sides), np.ones(2), cfg)


def test_a_nan_beta_tranche_is_in_neither_the_numerator_nor_the_denominator_of_the_shift_statistic() -> None:
    cfg = _cfg("b_sti")
    df = _test_df([1.0, 1.0, -1.0, 1.0])
    df["symbol"] = ["ETHUSDT", "SOLUSDT", "ETHUSDT", "SOLUSDT"]
    with family_b.recording() as rec:
        family_b.set_phase("tripwire")
        rec.betas = {"ETHUSDT": 0.9, "SOLUSDT": float("nan")}
        family_b.make_tranches_b(df, np.full(4, 0.9), cfg)
        rec.betas = {"ETHUSDT": 0.9}  # SOLUSDT absent from the fold's betas is missing too
        family_b.make_tranches_b(df.iloc[:2], np.full(2, 0.9), cfg)
        rec.betas = None  # no betas seen: every tranche is kept
        family_b.make_tranches_b(df.iloc[:1], np.full(1, 0.9), cfg)
        dec = rec.drain()
    assert dec["kept"].tolist() == [True, False, True, False, True, False, True]
    assert dec["acted"].all()
    daily = pd.DataFrame(
        {"drift_free": [0.02, 0.03]}, index=pd.Index([family_b.FIRST_REFIT_MS, family_b.FIRST_REFIT_MS + DAY])
    )
    w = dec["abs_weight"].to_numpy()
    kept_w = w[dec["kept"].to_numpy()]
    got = family_b.shift_record(dec, daily)
    assert got["tranche_count"] == 4 and abs(got["abs_weight_sum"] - kept_w.sum()) < 1e-15
    assert abs(got["per_unit_weight_mean"] - 0.05 / kept_w.sum()) < 1e-12
    assert got["abs_weight_sum"] < w.sum()  # the all-acted denominator would differ


def test_the_recorder_notes_the_fold_betas_estimate_betas_returns_and_the_wrapper_is_removed() -> None:
    from r4 import pipeline

    original = pipeline.estimate_betas
    idx = pd.Index(np.arange(40, dtype=np.int64) * DAY)
    rng = np.random.default_rng(5)
    daily_ret = pd.DataFrame({"AUSDT": rng.normal(0, 0.01, 40), "BUSDT": rng.normal(0, 0.01, 40)}, index=idx)
    with family_b.recording() as rec:
        assert pipeline.estimate_betas is not original
        got = pipeline.estimate_betas(daily_ret, start_ms=None, end_ms=None)
        assert rec.betas is not None and set(rec.betas) == set(got) == {"AUSDT", "BUSDT"}
    assert pipeline.estimate_betas is original and family_b.current_recorder() is None


def test_recorder_rows_for_decisions_and_fits() -> None:
    cfg = _cfg("b_sti")
    with family_b.recording() as rec:
        family_b.set_phase("wf")
        family_b.make_tranches_b(_test_df([1.0, 0.0, -1.0, 1.0]), np.array([0.7, 0.9, 0.4, 0.6]), cfg)
        family_b.set_phase("cpcv:2")
        family_b.make_tranches_b(_test_df([-1.0]), np.array([0.99]), cfg)
        family_b.fit_meta(cfg, np.zeros((4, 2)), _train_df([1, 1, 0, 1], [0.1, -0.1, 0.0, 0.1], [0.0] * 4))
        fits = rec.fits()
        dec = rec.frame()
    assert list(dec.columns) == family_b.DECISION_COLUMNS and list(fits.columns) == family_b.FIT_COLUMNS
    assert len(dec) == 4  # the side-0 row is not recorded
    assert dec["phase"].tolist() == ["wf", "wf", "wf", "cpcv:2"]
    assert dec["acted"].tolist() == [True, False, True, True]
    assert dec["size"].iloc[1] == 0.0 and dec["abs_weight"].iloc[1] == 0.0
    assert abs(dec["abs_weight"].iloc[0] - dec["size"].iloc[0] / 4.0 / 10.0) < 1e-15
    assert dec["net"].tolist() == [0.01, -0.01, 0.01, -0.01]  # the long net for a +1 side, the short net for a -1 side
    assert fits["phase"].tolist() == ["cpcv:2"] and fits["rows"].tolist() == [3] and fits["positives"].tolist() == [2]
    assert abs(fits["base_rate"].iloc[0] - 2 / 3) < 1e-12 and fits["degenerate"].tolist() == [""]
    assert fits["train_t_min"].iloc[0] == T0 and fits["n_train"].iloc[0] == 4
    # inactive by default: no state, set_phase raises
    assert family_b.current_recorder() is None
    with pytest.raises(RuntimeError):
        family_b.set_phase("wf")
    family_b.make_tranches_b(_test_df([1.0]), np.array([0.9]), cfg)  # no recorder: nothing recorded, no error
    with family_b.recording() as r2:
        r2.phase = "wf"
        family_b.make_tranches_b(_test_df([1.0, -1.0]), np.array([0.9, 0.9]), cfg)
        drained = r2.drain()
        assert len(drained) == 2 and len(r2.frame()) == 0 and len(r2.fits()) == 0


# ---------------------------------------------------------------------------------------------------------------------
# Registries
# ---------------------------------------------------------------------------------------------------------------------


def test_registry_ids_order_seeds_and_counts(real_frame_features: None) -> None:
    cfgs = family_b.family_b()
    assert [c["id"] for c in cfgs] == [
        "B_rule_v8_C2", "B_rule_v8_C5", "B_rule_ll_C1", "B_rule_rsi_C1", "B_rule_sti_C1", "B_rule_pos_C4",
        "B_meta24_v8_C2", "B_meta24_v8_C5", "B_meta24_ll_C1", "B_meta24_rsi_C1",
        "B_metaall_v8_C2", "B_metaall_v8_C5", "B_metaall_ll_C1", "B_metaall_rsi_C1",
        "B_meta12_sti_C1", "B_meta12_pos_C4", "B_metaall_sti_C1", "B_metaall_pos_C4",
    ]  # fmt: skip
    assert [c["joint_shift_seed"] for c in cfgs] == [11_000_000 + k for k in range(18)]
    assert (family_b.N_DECLARED, family_b.N_RESERVE, family_b.RESERVE_SEED_BASE) == (18, 6, 11_000_018)
    assert family_b.ALPHA_BEFORE_B == 66 and family_b.CAP == 24 and family_b.FAMILY_INDEX == 1
    assert len({cli.config_hash_of(c) for c in cfgs}) == 18
    f1h = list(family_a.F_1H)
    f4h = list(family_a.F_4H)
    assert len(f1h) == 40 and len(f4h) == 39 and family_b.frame_features is not None
    for c in cfgs:
        assert c["family"] == "B" and c["kind"] == "trial" and c["book"] == "slot" and c["exit"] == "horizon"
        assert c["label"] == "meta" and c["refit"] == "monthly" and c["seed"] == 7
        assert c["first_refit_ms"] == 1_704_067_200_000 == family_b.FIRST_REFIT_MS
        assert (c["interval"], c["h_ms"]) == calibration.CELLS[c["cell"]]
        rule = c["model"] == "rule"
        assert (c["threshold"], c["size_rule"]) == ((0.0, "unit") if rule else (0.5, "afml"))
        assert c["params"] == ({} if rule else calibration.LGBM_PARAMS)
        sig = family_b.SIGNAL_COLUMN.get(c["side_rule"])
        base = f1h if c["interval"] == "1h" else f4h
        assert c["features"] == [*base, "b_side", *([] if sig is None else [sig])]
    # the table: lookbacks per block, cells per primary, features per row
    lookbacks = {c["id"]: c["lookback_months"] for c in cfgs}
    assert (
        lookbacks["B_rule_ll_C1"] is None
        and lookbacks["B_meta24_rsi_C1"] == 24
        and lookbacks["B_metaall_v8_C5"] is None
    )
    assert (
        lookbacks["B_meta12_sti_C1"] == 12
        and lookbacks["B_meta12_pos_C4"] == 12
        and lookbacks["B_metaall_sti_C1"] is None
    )
    cells = {c["id"]: c["cell"] for c in cfgs}
    assert {cells[i] for i in cells if "_v8_C2" in i} == {"C2"} and cells["B_metaall_pos_C4"] == "C4"
    by_id = {c["id"]: c for c in cfgs}
    assert len(by_id["B_meta12_pos_C4"]["features"]) == 41 and len(by_id["B_rule_v8_C5"]["features"]) == 40
    assert len(by_id["B_rule_v8_C2"]["features"]) == 41 and len(by_id["B_rule_ll_C1"]["features"]) == 42
    # copies, not references
    cfgs[6]["params"]["n_estimators"] = -1
    assert family_b.family_b()[6]["params"] == calibration.LGBM_PARAMS


def test_noise_registry_seeds_attempts_and_ids() -> None:
    noise = family_b.family_b_noise()
    assert [c["id"] for c in noise] == [
        "B_noise_sti_C1_12_s1", "B_noise_sti_C1_12_s2", "B_noise_sti_C1_all_s1", "B_noise_sti_C1_all_s2",
        "B_noise_pos_C4_12_s1", "B_noise_pos_C4_12_s2", "B_noise_pos_C4_all_s1", "B_noise_pos_C4_all_s2",
    ]  # fmt: skip
    assert [c["noise_seed"] for c in noise] == [11_500_000 + j for j in range(8)]
    assert [c["joint_shift_seed"] for c in noise] == [11_600_000 + j for j in range(8)]
    assert all(c["kind"] == "control" and c["family"] == "B" for c in noise)
    assert [c["lookback_months"] for c in noise] == [12, 12, None, None] * 2
    assert [c["side_rule"] for c in noise] == ["b_noise_sti"] * 4 + ["b_noise_pos"] * 4
    assert [c["cell"] for c in noise] == ["C1"] * 4 + ["C4"] * 4
    assert all(c["features"] == [*calibration.NOISE_FEATURES, "b_side"] for c in noise)
    assert all(c["threshold"] == 0.5 and c["size_rule"] == "afml" and "replaces" not in c for c in noise)
    alt = family_b.family_b_noise([1, 0, 2, 0, 0, 0, 0, 1])
    assert alt[0]["id"] == "B_noise_sti_C1_12_s1_alt1" and alt[0]["noise_seed"] == 11_500_000 + 100
    assert (
        alt[0]["joint_shift_seed"] == 11_600_000
        and alt[0]["replaces"] == "B_noise_sti_C1_12_s1"
        and alt[0]["attempt"] == 1
    )
    assert alt[2]["id"] == "B_noise_sti_C1_all_s1_alt2" and alt[2]["noise_seed"] == 11_500_002 + 200
    assert alt[7]["noise_seed"] == 11_500_007 + 100 and alt[1]["id"] == "B_noise_sti_C1_12_s2"
    with pytest.raises(ValueError):
        family_b.family_b_noise([3] + [0] * 7)
    with pytest.raises(ValueError):
        family_b.family_b_noise([0, 0])
    assert family_b.NOISE_MAX_ATTEMPT == 2 and family_b.SYNTH_SEED == 11_700_000
    assert family_b.NOISE_FINAL_ATTEMPTS == (0,) * 8  # until the synthetic check settles other seeds


def test_rule_of_twin_and_eligible_and_allowed_exits() -> None:
    assert family_b.rule_of("B_meta24_ll_C1")["id"] == "B_rule_ll_C1"
    assert family_b.rule_of("B_metaall_v8_C5")["id"] == "B_rule_v8_C5"
    assert family_b.rule_of("B_meta12_pos_C4")["id"] == "B_rule_pos_C4"
    with pytest.raises(ValueError):
        family_b.rule_of("B_rule_ll_C1")
    with pytest.raises(ValueError):
        family_b.rule_of("A_lgbm_C2")
    twin = family_b.family_b_twin("B_meta24_ll_C1", 2)
    base = {c["id"]: c for c in family_b.family_b()}["B_meta24_ll_C1"]
    assert twin["id"] == "B_twin2_B_meta24_ll_C1" and twin["refit"] == "none" and twin["lookback_months"] is None
    assert twin["joint_shift_seed"] == 11_000_018 + 2
    for k in ("features", "params", "side_rule", "threshold", "size_rule", "cell", "model"):
        assert twin[k] == base[k]
    for bad in (-1, 6, True, 1.0):
        with pytest.raises(ValueError):
            family_b.family_b_twin("B_meta24_ll_C1", bad)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="fitted"):
        family_b.family_b_twin("B_rule_ll_C1", 0)
    with pytest.raises(ValueError, match="declared"):
        family_b.family_b_twin("A_lgbm_C2", 0)
    run_config_from_raw(twin)
    ids = [c["id"] for c in family_b.family_b() if family_b.eligible(c)]
    assert ids == [
        "B_meta24_ll_C1", "B_meta24_rsi_C1", "B_metaall_ll_C1", "B_metaall_rsi_C1",
        "B_meta12_sti_C1", "B_meta12_pos_C4", "B_metaall_sti_C1", "B_metaall_pos_C4",
    ]  # fmt: skip
    assert [k for k, c in enumerate(family_b.family_b()) if family_b.eligible(c)] == [8, 9, 12, 13, 14, 15, 16, 17]
    assert not family_b.eligible({"model": "rule", "side_rule": "b_ll"})
    for c in family_b.family_b():
        assert family_b.allowed_exits(c) == ("E1", "E2", "E3", "E6", "X1")
        for ok in ("E1", "E2", "E3", "E6", "X1"):
            family_b.check_exit_allowed(c, ok)
        for refused in ("E4", "E5"):
            with pytest.raises(ValueError, match="never applied"):
                family_b.check_exit_allowed(c, refused)
    assert family_b.allowed_exits(_cfg()) == family_b.ALLOWED_EXITS
    with pytest.raises(ValueError):
        family_b.allowed_exits({"family": "A"})


def test_refit_question_paired_comparison_and_per_unit_weight_mean() -> None:
    cfg_daily = pd.DataFrame({"drift_free": np.full(40, 0.001)})
    twin_daily = pd.DataFrame({"drift_free": np.zeros(40)})
    q = family_b.refit_question(cfg_daily, twin_daily, 12)
    assert q["seed"] == 7_200_012 and q["adopted"] is True and q["n"] == 40 and q["iterations"] == 1000
    idx = pd.Index(np.arange(60) * DAY + family_b.FIRST_REFIT_MS, name="day_start")
    rng = np.random.default_rng(4)
    meta = pd.DataFrame(
        {
            "drift_free": rng.normal(0.001, 0.01, 60),
            "gross_hedged": rng.normal(0, 0.01, 60),
            "funding": rng.normal(0, 0.001, 60),
        },
        index=idx,
    )
    rule = pd.DataFrame(
        {
            "drift_free": rng.normal(0, 0.01, 60),
            "gross_hedged": rng.normal(0, 0.01, 60),
            "funding": rng.normal(0, 0.001, 60),
        },
        index=idx,
    )
    out = family_b.paired_comparison(meta, rule.iloc[5:], 14)
    assert out["n"] == 55
    net = (meta["drift_free"] - rule["drift_free"]).iloc[5:].to_numpy()
    assert abs(out["net"]["mean"] - net.mean()) < 1e-15 and out["net"]["seed"] == 11_800_014
    cf = ((meta["gross_hedged"] + meta["funding"]) - (rule["gross_hedged"] + rule["funding"])).iloc[5:].to_numpy()
    assert abs(out["cost_free"]["mean"] - cf.mean()) < 1e-15 and out["cost_free"]["seed"] == 11_900_014
    from r4 import stats

    _, low, high = stats.bootstrap_ci(net, np.mean, 1000, 10, 11_800_014, alpha=0.10)
    assert out["net"]["low"] == low and out["net"]["high"] == high and out["net"]["alpha"] == 0.10
    # per-unit weight mean: the sum of drift_free over [first refit, DEV_END) over the sum of abs weights
    daily = pd.DataFrame(
        {"drift_free": [0.01, 0.02, 0.5]}, index=[family_b.FIRST_REFIT_MS - DAY, family_b.FIRST_REFIT_MS, DEV_END]
    )
    assert abs(family_b.per_unit_weight_mean(daily, [0.1, -0.3]) - 0.02 / 0.4) < 1e-15
    assert abs(family_b.per_unit_weight_mean(daily, [0.1, -0.3], family_b.FIRST_REFIT_MS - DAY) - 0.03 / 0.4) < 1e-15
    assert family_b.per_unit_weight_mean(daily, []) is None
    assert family_b.per_unit_weight_mean(daily, [0.0]) is None


# ---------------------------------------------------------------------------------------------------------------------
# The mini-control
# ---------------------------------------------------------------------------------------------------------------------


def test_noise_side_is_independent_of_the_noise_features_and_the_real_signal_is_no_feature(
    synth_panel: dict[str, dict[str, pd.DataFrame]],
) -> None:
    T = T0 + np.arange(20000) * H
    from r4 import hashfeat

    side = family_b.noise_side("SOLUSDT", T, 11_500_000, "b_noise_sti")
    feats = hashfeat.hash_feature_matrix(list(calibration.NOISE_FEATURES), "SOLUSDT", UNIVERSE, T, 11_500_000, None)
    for j in range(20):
        assert abs(np.corrcoef(side, feats[:, j])[0, 1]) < 0.03, j
    cfg = _cfg("b_noise_sti")
    frame = decision_samples(synth_panel, cfg)
    assert list(frame.columns) == [
        "symbol",
        "T",
        *calibration.NOISE_FEATURES,
        "b_side",
        "entry",
        "exit",
        "gross_log",
        "t0",
        "t1_max",
        "tb_net",
        "tb_net_short",
    ]
    assert "b_sti" not in frame.columns and not set(family_b.SIGNAL_COLUMN.values()) & set(frame.columns)
    # the side is the noise sign at every T, and its features carry no real signal
    for sym, g in frame.groupby("symbol"):
        assert np.array_equal(
            g["b_side"].to_numpy(), family_b.noise_side(str(sym), g["T"].to_numpy(), 11_500_000, "b_noise_sti")
        )
    for j in (0, 7, 19):
        col = frame[f"noise_{j:02d}"]
        assert abs(np.corrcoef(col, frame["tb_net"])[0, 1]) < 0.05
        assert abs(np.corrcoef(col, frame["gross_log"])[0, 1]) < 0.05


def test_the_noise_frame_equals_the_real_frames_rows(synth_panel: dict[str, dict[str, pd.DataFrame]]) -> None:
    real_sti = decision_samples(synth_panel, _cfg("b_sti"))
    noise_sti = decision_samples(synth_panel, _cfg("b_noise_sti"))
    assert real_sti[["symbol", "T"]].equals(noise_sti[["symbol", "T"]])
    for c in ("entry", "exit", "gross_log", "t0", "t1_max", "tb_net", "tb_net_short"):
        assert np.array_equal(real_sti[c].to_numpy(), noise_sti[c].to_numpy())
    real_pos = decision_samples(synth_panel, _cfg("b_pos", interval="4h", h_ms=8 * H))
    noise_pos = decision_samples(synth_panel, _cfg("b_noise_pos", interval="4h", h_ms=8 * H))
    assert real_pos[["symbol", "T"]].equals(noise_pos[["symbol", "T"]])
    sched = family_b.pos_scheduled(noise_pos["T"])
    assert (noise_pos.loc[~sched, "b_side"] == 0).all() and (noise_pos.loc[sched, "b_side"] != 0).all()
    # a different seed changes the side and the features, not the rows
    other = decision_samples(synth_panel, _cfg("b_noise_sti", noise_seed=11_500_100))
    assert other[["symbol", "T"]].equals(noise_sti[["symbol", "T"]])
    assert not np.array_equal(other["b_side"].to_numpy(), noise_sti["b_side"].to_numpy())


# ---------------------------------------------------------------------------------------------------------------------
# CPCV dtype, the joint shift identity and calibration's verdicts
# ---------------------------------------------------------------------------------------------------------------------


def _write_config(tmp: Path, raw: dict[str, Any]) -> Path:
    f = tmp / f"{raw['id']}.json"
    f.write_text(json.dumps(raw), encoding="utf-8")
    return f


def _raw(
    cid: str,
    rule: str = "b_sti",
    model: str = "lightgbm",
    *,
    interval: str = "1h",
    h_ms: int = 4 * H,
    kind: str = "trial",
    lookback: int | None = None,
    **over: Any,
) -> dict[str, Any]:
    cfg = _cfg(rule, model, interval=interval, h_ms=h_ms, lookback=lookback)
    raw: dict[str, Any] = {
        "id": cid,
        "kind": kind,
        "family": "B",
        "model": cfg.model,
        "params": cfg.params,
        "features": list(cfg.features),
        "interval": interval,
        "h_ms": h_ms,
        "label": "meta",
        "side_rule": rule,
        "threshold": cfg.threshold,
        "size_rule": cfg.size_rule,
        "lookback_months": lookback,
        "refit": "monthly",
        "exit": "horizon",
        "seed": 7,
        "book": "slot",
        "first_refit_ms": FIRST_REFIT,
        "joint_shift_seed": 11_000_000,
    }
    if cfg.noise_seed is not None:
        raw["noise_seed"] = cfg.noise_seed
    raw.update(over)
    return raw


@pytest.fixture(scope="module")
def runs(tmp_path_factory: pytest.TempPathFactory, synth_panel: dict[str, dict[str, pd.DataFrame]]) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("fb")
    ds = root / "ds"
    ds.mkdir()
    (ds / "manifest.json").write_text(
        json.dumps({"version": 1, "datasetHash": "b-synthetic-hash", "symbols": list(synth_panel), "files": []}),
        encoding="utf-8",
    )
    out: dict[str, Any] = {"root": root, "ds": ds, "out": root / "out", "receipts": {}}
    for cid, rule, model in (("b_rule_sti", "b_sti", "rule"), ("b_meta_sti", "b_sti", "lightgbm")):
        f = _write_config(root, _raw(cid, rule, model))
        out["receipts"][cid] = cli.run_wf(f, ds, out["out"], commit=COMMIT, panel=synth_panel)
    return out


def test_cpcv_path_predictions_are_float64_in_unit_interval_and_keep_sizes(
    runs: dict[str, Any], synth_panel: dict[str, dict[str, pd.DataFrame]]
) -> None:
    for cid, model in (("b_rule_sti", "rule"), ("b_meta_sti", "lightgbm")):
        cfg = run_config_from_raw(runs["receipts"][cid]["config"])
        samples, _ = cli.restrict_to_d(decision_samples(synth_panel, cfg))
        splits = list(
            validation.panel_cpcv_splits(
                samples["t0"].to_numpy(),
                samples["t1_max"].to_numpy(),
                n_groups=6,
                n_test_groups=2,
                embargo_ms=2_592_000_000,
            )
        )
        from sklearn.preprocessing import StandardScaler

        preds, groups = [], []
        for train_idx, test_list in splits:
            tr = samples.iloc[train_idx]
            sc = StandardScaler()
            m = family_b.fit_meta(cfg, sc.fit_transform(tr[list(cfg.features)]), tr)
            te = samples.iloc[np.concatenate(test_list)]
            preds.append(family_b.meta_proba(m, sc.transform(te[list(cfg.features)])))
            groups.append(test_list)
        paths = validation.cpcv_paths(preds, validation.cpcv_path_ids(6, 2), groups)
        assert paths.dtype == np.float64 and ((paths >= 0) & (paths <= 1)).all() and paths.shape[0] == 5
        if model == "rule":
            assert (paths == 1.0).all()
        else:
            assert len(np.unique(paths)) > 5  # an integer array would have zeroed every path


def test_the_joint_shift_statistic_at_zero_shift_equals_the_book_with_continuous_sizes(
    runs: dict[str, Any], synth_panel: dict[str, dict[str, pd.DataFrame]]
) -> None:
    from r4 import bar

    run_dir = runs["out"] / "b_meta_sti"
    tr = pd.read_parquet(run_dir / "tranches.parquet")
    assert tr["size"].between(0, 1).all() and (tr["size"] < 1).any() and (tr["size"] > 0).all()
    daily = pd.read_parquet(run_dir / "daily.parquet")
    folds = json.loads((run_dir / "folds.json").read_text(encoding="utf-8"))
    stats = bar.joint_shift_stats(
        tr, synth_panel, folds, span_start_ms=FIRST_REFIT, span_end_ms=DEV_END, n_draws=3, min_shift_days=7, seed=1
    )
    anchor = calibration._book_anchor(tr, stats, daily, label="b_meta_sti")
    assert anchor["checked"] is True and anchor["ok"] is True and (anchor["rel_diff"] or 0.0) < 1e-9


def test_family_b_never_uses_calibrations_noise_verdicts_trade_floor_or_gate() -> None:
    src = (PY / "r4" / "family_b.py").read_text(encoding="utf-8")
    code = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith(("#", '"', "'")))
    for name in ("evaluate_noise", "gate_ok", "trade_floor_ok", "_noise_verdicts"):
        assert name not in code.replace('"""', ""), name


# ---------------------------------------------------------------------------------------------------------------------
# End to end (run_wf) and the tripwire records
# ---------------------------------------------------------------------------------------------------------------------


def test_run_wf_receipt_b_block_decisions_fits_and_sizes(runs: dict[str, Any]) -> None:
    for cid, model in (("b_rule_sti", "rule"), ("b_meta_sti", "lightgbm")):
        receipt = runs["receipts"][cid]
        run_dir = runs["out"] / cid
        b = receipt["b"]
        assert b["primary"] == "b_sti" and b["frame_rows"] > 1000 and b["v8"] is None
        assert (
            b["wf_tranches"] == receipt["metrics"]["n_tranches"] == len(pd.read_parquet(run_dir / "tranches.parquet"))
        )
        assert b["trade_floor"] == {"floor": 1000, "met": b["wf_tranches"] >= 1000}
        assert (
            b["wf_acted_decisions"] == b["wf_tranches"]
            and b["act_share"] == b["wf_acted_decisions"] / b["wf_primary_decisions"]
        )
        dec_file, fits_file = run_dir / "decisions.parquet", run_dir / "meta_fits.parquet"
        assert receipt["decisions_sha256"] == hashlib.sha256(dec_file.read_bytes()).hexdigest()
        assert receipt["meta_fits_sha256"] == hashlib.sha256(fits_file.read_bytes()).hexdigest()
        saved = json.loads((run_dir / "receipt.json").read_text(encoding="utf-8"))
        assert saved["b"] == b and saved["decisions_sha256"] == receipt["decisions_sha256"]
        dec = pd.read_parquet(dec_file)
        assert list(dec.columns) == family_b.DECISION_COLUMNS
        assert set(dec["phase"]) == {"wf"} | {f"cpcv:{p}" for p in range(5)}
        tr = pd.read_parquet(run_dir / "tranches.parquet")
        if model == "rule":
            assert (
                (tr["size"] == 1.0).all()
                and (dec["size"].isin([0.0, 1.0])).all()
                and len(pd.read_parquet(fits_file)) == 0
            )
        else:
            assert tr["size"].between(0, 1, inclusive="right").all() and tr["size"].nunique() > 5
            fits = pd.read_parquet(fits_file)
            assert {"wf", "cpcv_fit"} == set(fits["phase"]) and (fits["phase"] == "cpcv_fit").sum() == 15
            assert b["fits"] == len(fits) and b["degenerate_fits"]["wf"] == 0
        # sizes of the tranches are the sizes of the acted decision rows, back through the book's coercion
        wf = dec[(dec["phase"] == "wf") & dec["acted"]]
        assert np.allclose(np.sort(wf["size"].to_numpy()), np.sort(tr["size"].to_numpy()))
        # back through the book's coercion: the sizes (and so the weights) survive
        from r4.book import _coerce_tranches

        back = _coerce_tranches(tr)
        assert [t.size for t in back] == tr["size"].tolist()
        assert np.allclose(sorted(abs(t.weight) for t in back), sorted(tr["size"].to_numpy() / (4.0 * 10.0)))


def test_rule_and_meta_receipts_share_a_frame_and_other_receipts_keep_their_keys(
    runs: dict[str, Any], synth_panel: dict[str, dict[str, pd.DataFrame]]
) -> None:
    assert runs["receipts"]["b_rule_sti"]["b"]["frame_rows"] == runs["receipts"]["b_meta_sti"]["b"]["frame_rows"]
    # a non-B configuration writes none of the family B keys or files
    raw = {
        "id": "a_plain", "kind": "trial", "family": "A", "model": "ridge", "params": {"alpha": 1.0},
        "features": list(SMALL_F), "interval": "1h", "h_ms": 4 * H, "label": "fixed", "side_rule": "sign",
        "threshold": 0.0, "size_rule": "unit", "lookback_months": None, "refit": "monthly", "exit": "horizon",
        "first_refit_ms": FIRST_REFIT,
    }  # fmt: skip
    f = _write_config(runs["root"], raw)
    receipt = cli.run_wf(f, runs["ds"], runs["out"], commit=COMMIT, panel=synth_panel)
    assert not {"b", "meta_fits_sha256", "decisions_sha256"} & set(receipt)
    assert not (runs["out"] / "a_plain" / "decisions.parquet").exists()


def test_non_b_paths_never_reach_family_b_and_are_identical_with_it_poisoned(
    synth_panel: dict[str, dict[str, pd.DataFrame]], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ds = tmp_path / "ds"
    ds.mkdir()
    (ds / "manifest.json").write_text(
        json.dumps({"version": 1, "datasetHash": "plain-hash", "symbols": list(synth_panel), "files": []}),
        encoding="utf-8",
    )
    base = {
        "kind": "trial",
        "family": "A",
        "interval": "1h",
        "h_ms": 4 * H,
        "label": "fixed",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "first_refit_ms": FIRST_REFIT,
    }
    small = {"n_estimators": 8, "num_leaves": 5, "min_child_samples": 10}
    configs = [
        {**base, "id": "a_ridge", "model": "ridge", "params": {"alpha": 1.0}, "features": list(SMALL_F)}
        | {"side_rule": "sign"},
        {**base, "id": "a_lgbm", "model": "lightgbm", "threshold": 0.02, "side_rule": "prob", "params": small}
        | {"features": list(SMALL_F)},
        {**base, "id": "c_noise", "family": "C4", "model": "lightgbm", "threshold": 0.02, "side_rule": "prob"}
        | {"params": small, "features": [f"noise_{i:02d}" for i in range(4)], "noise_seed": 5, "kind": "control"},
        # family D with inv_vol weights and a band (the outline's required case). 120 days from 2023-01-01 end on a
        # month boundary, which family D's bit-exact parity check needs.
        {**base, "id": "d_invvol", "family": "D", "model": "ridge", "params": {"alpha": 1.0}, "side_rule": "sign"}
        | {"features": list(SMALL_F), "book": "D", "d_weights": "inv_vol", "d_band": 0.045, "seed": 7},
    ]
    d_panel = _make_fast_synthetic_panel(n_days=120, seed=10, inject_signal=True)
    fc, _ = family_c.compute_forecasts(d_panel, {c["id"]: c for c in family_c.family_c()}[family_d.FINALIST_ID])
    monkeypatch.setitem(
        family_d.PARITY_REFERENCE, "plain-hash", family_d.canonical_digest(fc[np.isfinite(fc["f"])], "f")
    )

    def run_all(tag: str) -> dict[str, dict[str, Any]]:
        res = {}
        for raw in configs:
            is_d = raw["family"] == "D"
            panel = d_panel if is_d else synth_panel
            f = _write_config(tmp_path, {**raw, "id": f"{tag}_{raw['id']}"})
            cfg = run_config_from_raw({**raw, "id": raw["id"]})
            frame = None if is_d else decision_samples(panel, cfg)
            receipt = cli.run_wf(f, ds, tmp_path / tag, commit=COMMIT, panel=panel)
            rd = tmp_path / tag / f"{tag}_{raw['id']}"
            res[raw["id"]] = {
                "frame": frame,
                "receipt": {k: v for k, v in receipt.items() if k not in ("runtime_s", "config", "config_hash")},
                "tranches": (rd / "tranches.parquet").read_bytes(),
                "daily": (rd / "daily.parquet").read_bytes(),
            }
        return res

    first = run_all("one")

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("a non-B configuration reached family_b")

    for name in (
        "decision_samples_b",
        "fit_meta",
        "meta_proba",
        "make_tranches_b",
        "load_tier_b",
        "attach_v8",
        "check_panel",
        "validate_config",
    ):
        monkeypatch.setattr(family_b, name, boom)
    second = run_all("two")
    for cid in first:
        if first[cid]["frame"] is not None:
            pd.testing.assert_frame_equal(first[cid]["frame"], second[cid]["frame"], check_exact=True)
        assert first[cid]["tranches"] == second[cid]["tranches"] and first[cid]["daily"] == second[cid]["daily"]
        assert first[cid]["receipt"] == second[cid]["receipt"]
        assert not {"b", "meta_fits_sha256"} & set(first[cid]["receipt"])


def test_load_panel_defaults_return_the_c4_panel_and_the_keywords_add_the_tier_b_and_v8_frames(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=40, seed=8)
    ds = write_synthetic_dataset(panel, tmp_path / "ds")
    keys = {"5m", "15m", "1h", "4h", "1d", "premium_5m", "premiumIndex", "settlements", "funding"}
    plain = load_panel(ds, list(panel))
    assert all(set(d) == keys for d in plain.values())
    panel_b = family_b.synthetic_tier_b(_make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=40, seed=8), 5)
    for sym, d in panel_b.items():
        flow = d["flow_5m"].assign(source="synthetic", trades=1)
        (ds / "flow" / sym).mkdir(parents=True, exist_ok=True)
        (ds / "flow" / sym / "5m.jsonl.gz").write_bytes(
            _jsonl_gz_bytes(pd.concat([flow, flow.iloc[:5].assign(t=TIER_B_START - 5 * M5 * np.arange(1, 6))]))
        )
        junk = d["metrics_5m"].iloc[:3].assign(t=lambda m: m["t"] + M5, topTraderPositionRatio=999.0)
        early = d["metrics_5m"].iloc[:3].assign(t=lambda m: TIER_B_START - (np.arange(3) + 1) * family_b.POS_PERIOD_MS)
        metrics = pd.concat([d["metrics_5m"], junk, early]).assign(openInterest=1.0)
        (ds / "metrics" / sym).mkdir(parents=True, exist_ok=True)
        (ds / "metrics" / sym / "5m.jsonl.gz").write_bytes(_jsonl_gz_bytes(metrics))
    loaded = load_panel(ds, list(panel), tier_b=True)
    for sym, d in loaded.items():
        assert set(d) == keys | {"flow_5m", "metrics_5m"}
        assert list(d["flow_5m"].columns) == [
            "t",
            "buyQuote",
            "sellQuote",
            "buyQuoteSmall",
            "sellQuoteSmall",
            "buyQuoteOpen10s",
            "sellQuoteOpen10s",
        ]
        assert (d["flow_5m"]["t"] >= TIER_B_START).all() and len(d["flow_5m"]) == len(panel_b[sym]["flow_5m"])
        assert list(d["metrics_5m"].columns) == ["t", "topTraderPositionRatio"]
        assert (d["metrics_5m"]["t"] % family_b.POS_PERIOD_MS == 0).all() and (
            d["metrics_5m"]["t"] >= TIER_B_START
        ).all()
        assert len(d["metrics_5m"]) == len(panel_b[sym]["metrics_5m"])
        pd.testing.assert_frame_equal(d["5m"], plain[sym]["5m"])
    # v8 exports add b_v8_1h and b_v8_4h with an empty frame for a coin with no row
    rows1 = [_row("1h", "BTCUSDT", T0), _row("1h", "ETHUSDT", T0 + H, -1)]
    e1 = _v8_export(tmp_path, "1h", rows1, monkeypatch)
    e4 = _v8_export(tmp_path, "4h", [_row("4h", "SOLUSDT", T0 // (4 * H) * 4 * H)], monkeypatch)
    with_v8 = load_panel(ds, list(panel), v8_exports={"1h": e1, "4h": e4})
    assert len(with_v8["BTCUSDT"]["b_v8_1h"]) == 1 and len(with_v8["ADAUSDT"]["b_v8_1h"]) == 0
    assert len(with_v8["SOLUSDT"]["b_v8_4h"]) == 1 and with_v8["ADAUSDT"]["b_v8_4h"].columns.tolist() == [
        "symbol",
        "T",
        "side",
    ]
    assert with_v8["ADAUSDT"]["b_v8_1h"].attrs["decision_source"] == SYN_DECISION_SOURCE
    assert "flow_5m" not in with_v8["BTCUSDT"]
    # check_panel: a v8 configuration needs the frames and the declared digests
    cfg = _cfg("b_v8")
    rec = family_b.check_panel(with_v8, cfg)
    assert rec is not None and rec["decision_source"] == SYN_DECISION_SOURCE and rec["span_end_dropped"] == 7
    with pytest.raises(ValueError, match="b_v8_1h"):
        family_b.check_panel(plain, cfg)
    monkeypatch.setitem(family_b.V8_TRANCHES_SHA256, "1h", "0" * 64)
    with pytest.raises(ValueError, match="tranches_sha256"):
        family_b.check_panel(with_v8, cfg)
    with pytest.raises(ValueError, match="flow_5m"):
        family_b.check_panel(plain, _cfg("b_sti"))
    assert family_b.check_panel(plain, _cfg("b_ll")) is None


def test_run_wf_loads_the_tier_b_panel_itself_and_refuses_a_v8_configuration_without_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    panel = family_b.synthetic_tier_b(
        _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=3, inject_signal=True), 11
    )
    ds = write_synthetic_dataset(panel, tmp_path / "ds")
    for sym, d in panel.items():
        (ds / "flow" / sym).mkdir(parents=True, exist_ok=True)
        (ds / "flow" / sym / "5m.jsonl.gz").write_bytes(_jsonl_gz_bytes(d["flow_5m"]))
        (ds / "metrics" / sym).mkdir(parents=True, exist_ok=True)
        (ds / "metrics" / sym / "5m.jsonl.gz").write_bytes(_jsonl_gz_bytes(d["metrics_5m"]))
    f = _write_config(tmp_path, _raw("e2e_sti_rule", "b_sti", "rule"))
    from_disk = cli.run_wf(f, ds, tmp_path / "o1", commit=COMMIT)
    in_memory = cli.run_wf(f, ds, tmp_path / "o2", commit=COMMIT, panel=panel)
    assert from_disk["b"] == in_memory["b"] and from_disk["metrics"]["n_tranches"] == in_memory["metrics"]["n_tranches"]
    assert from_disk["metrics"]["wf_mean"] == in_memory["metrics"]["wf_mean"]
    fv = _write_config(tmp_path, _raw("e2e_v8_rule", "b_v8", "rule", interval="1h", h_ms=8 * H))
    with pytest.raises(ValueError, match="v8_exports"):
        cli.run_wf(fv, ds, tmp_path / "o3", commit=COMMIT)
    # an end to end v8 run on a synthetic export: one rule and one meta configuration
    rng = np.random.default_rng(2)
    t_grid = (FIRST_REFIT - 60 * DAY) // H * H + np.arange(100 * 24) * H
    pick = rng.choice(len(t_grid), 600, replace=False)
    rows = [_row("1h", UNIVERSE[int(i) % 6], int(t_grid[i]), int(rng.choice([-1, 1]))) for i in sorted(pick.tolist())]
    rows = list({(r["symbol"], r["entry_ms"]): r for r in rows}.values())
    export = _v8_export(tmp_path, "1h", rows, monkeypatch)
    v8_panel = load_panel(ds, list(panel), v8_exports={"1h": export})
    for cid, model in (("e2e_v8_rule", "rule"), ("e2e_v8_meta", "lightgbm")):
        raw = _raw(cid, "b_v8", model, interval="1h", h_ms=8 * H)
        r = cli.run_wf(_write_config(tmp_path, raw), ds, tmp_path / "o4", commit=COMMIT, panel=v8_panel)
        v8 = r["b"]["v8"]
        assert (
            v8["decision_source"] == SYN_DECISION_SOURCE
            and v8["span_end_dropped"] == 7
            and v8["n_terminal_excluded"] == 0
        )
        assert v8["summary_sha256"] == family_b.V8_SUMMARY_CANONICAL_SHA256["1h"]
        assert (
            v8["tranches_sha256"] == family_b.V8_TRANCHES_SHA256["1h"] and v8["cert_sha256"] == family_b.V8_GRID_CERT[1]
        )
        assert r["b"]["primary"] == "b_v8" and r["b"]["wf_primary_decisions"] > 0
        assert set(r["b"]["per_coin"]) == set(UNIVERSE[:6])
        dec = pd.read_parquet(tmp_path / "o4" / cid / "decisions.parquet")
        assert set(dec["phase"]) == {"wf"} | {f"cpcv:{p}" for p in range(5)}
        assert dec["size"].between(0, 1).all()
    with monkeypatch.context() as m:
        m.setitem(family_b.V8_SUMMARY_CANONICAL_SHA256, "1h", "0" * 64)
        with pytest.raises(ValueError):
            cli.run_wf(
                _write_config(tmp_path, _raw("e2e_v8_bad", "b_v8", "rule", h_ms=8 * H)),
                ds,
                tmp_path / "o5",
                commit=COMMIT,
                panel=load_panel(ds, list(panel), v8_exports={"1h": export}),
            )


def test_tripwire_records_each_shifts_tranche_count_and_per_unit_weight_mean(
    runs: dict[str, Any], synth_panel: dict[str, dict[str, pd.DataFrame]]
) -> None:
    raw = _raw("b_tw_meta", "b_sti", "lightgbm")
    f = _write_config(runs["root"], raw)
    result = cli.run_tripwire(
        f, runs["ds"], runs["root"] / "tw", commit=COMMIT, panel=synth_panel, shifts_days=[30, 37]
    )
    cfg = run_config_from_raw(raw)
    samples, _ = cli.restrict_to_d(decision_samples(synth_panel, cfg))
    assert result["n"] == 2
    for entry in result["shifts"]:
        shift_ms = entry["shift_days"] * DAY
        shifted, _ = tripwire.shift_labels(samples, shift_ms, H, with_source_window=True)
        res = walk_forward(shifted, cfg, FIRST_REFIT, DEV_END, panel=synth_panel, exit_label_shift_ms=shift_ms)
        # the kept tranches: those the book keeps, a NaN fold beta excludes a tranche from both sides (A8.4)
        weights = [abs(t.weight) for f in res.folds for t in f.tranches if not _beta_missing(f.betas, t.symbol)]
        assert entry["tranche_count"] == len(weights) > 0
        assert abs(entry["abs_weight_sum"] - sum(weights)) < 1e-12
        want = float(res.drift_free["drift_free"].sum()) / sum(weights)
        assert abs(entry["per_unit_weight_mean"] - want) < 1e-12
        receipt = json.loads(
            (
                runs["root"] / "tw" / "b_tw_meta" / "tripwire" / f"shift_{entry['shift_days']:03d}" / "receipt.json"
            ).read_text()
        )
        assert receipt["metrics"]["tranche_count"] == entry["tranche_count"]
        assert receipt["metrics"]["per_unit_weight_mean"] == entry["per_unit_weight_mean"]
    saved = json.loads((runs["root"] / "tw" / "b_tw_meta" / "tripwire.json").read_text())
    assert [e["tranche_count"] for e in saved["shifts"]] == [e["tranche_count"] for e in result["shifts"]]
    # a rule configuration is refused (A8.2)
    rule_raw = _raw("b_tw_rule", "b_sti", "rule")
    with pytest.raises(ValueError, match="rule configuration"):
        cli.run_tripwire(
            _write_config(runs["root"], rule_raw),
            runs["ds"],
            runs["root"] / "tw",
            commit=COMMIT,
            panel=synth_panel,
            shifts_days=[30],
        )
    assert family_b.current_recorder() is None


def test_run_wf_for_a_noise_control_end_to_end(
    runs: dict[str, Any], synth_panel: dict[str, dict[str, pd.DataFrame]]
) -> None:
    raw = _raw("b_noise_e2e", "b_noise_sti", "lightgbm", kind="control")
    r = cli.run_wf(_write_config(runs["root"], raw), runs["ds"], runs["out"], commit=COMMIT, panel=synth_panel)
    assert r["kind"] == "control" and r["b"]["primary"] == "b_noise_sti"
    assert r["b"]["frame_rows"] == runs["receipts"]["b_meta_sti"]["b"]["frame_rows"]
    assert r["b"]["wf_tranches"] == r["metrics"]["n_tranches"]


# ---------------------------------------------------------------------------------------------------------------------
# Pins for the rule-changing mutations the Opus A5.1 review found surviving (R6)
# ---------------------------------------------------------------------------------------------------------------------


def test_ll_side_threshold_is_1_5_and_inclusive() -> None:
    z = np.array([1.4999, 1.5, 1.5001, 2.5, -1.4999, -1.5, -1.5001, 1.0, -1.0, 0.0, np.nan])
    got = family_b.ll_side(z)
    assert family_b.LL_Z == 1.5
    assert got[:10].tolist() == [0.0, 1.0, 1.0, 1.0, 0.0, -1.0, -1.0, 0.0, 0.0, 0.0] and np.isnan(got[10])


def _rsi_frame_series(start: int, rows: int) -> pd.Series:
    """A period-288 ramp 0..100, so every 288-row window holds exactly np.linspace(0, 100, 288)."""
    t = start + np.arange(rows, dtype=np.int64) * M5
    return pd.Series((np.arange(rows) % 288) / 287.0 * 100.0, index=pd.Index(t, name="t"), name="b_rsi5")


def test_rsi_tails_are_the_10th_and_90th_percentiles_on_the_frame_path(monkeypatch: pytest.MonkeyPatch) -> None:
    feb = int(pd.Timestamp("2023-02-01", tz="UTC").value // 1_000_000)
    series = _rsi_frame_series(feb - 2 * DAY, 5 * 288)
    # at the decision closes T the bar opening at T - 5m is read: set it to the probe values
    probes = {7.0: 1.0, 15.0: 0.0, 50.0: 0.0, 85.0: 0.0, 93.0: -1.0}
    T = np.array([feb + DAY + (k + 1) * H for k in range(len(probes))], dtype=np.int64)
    vals = series.copy()
    for tt, v in zip(T, probes, strict=True):
        vals.loc[int(tt) - M5] = v
    monkeypatch.setattr(family_b, "rsi5", lambda five_min: vals)
    got = family_b.rsi_signal(pd.DataFrame(), T, lookback_days=1)
    # window = one full ramp: p10 = 10.0 and p90 = 90.0 (5% / 20% tails would flip 7, 15, 85 and 93)
    assert family_b.RSI_TAIL == 0.10
    assert got["b_side"].tolist() == list(probes.values())


def test_rsi_thresholds_exist_for_a_month_whose_window_starts_exactly_at_the_series_start() -> None:
    feb = int(pd.Timestamp("2023-02-01", tz="UTC").value // 1_000_000)
    series = _rsi_frame_series(feb - DAY, 2 * 288)
    th = family_b.rsi_thresholds(series.index, series.to_numpy(), lookback_days=1)
    assert th[feb] is not None  # the window starts at the first row: allowed
    short = _rsi_frame_series(feb - DAY + M5, 2 * 288)  # one row short of the window
    th2 = family_b.rsi_thresholds(short.index, short.to_numpy(), lookback_days=1)
    assert th2[feb] is None


def test_pos_side_is_zero_at_z_zero_on_every_scheduled_close_and_signed_elsewhere() -> None:
    day = 20_000 * DAY
    sched = np.array([day, day + 8 * H, day + 16 * H], dtype=np.int64)
    assert family_b.pos_scheduled(sched).all()
    assert family_b.pos_side(np.zeros(3), sched).tolist() == [0.0, 0.0, 0.0]
    assert family_b.pos_side(np.array([1.0, -1.0, 1e-12]), sched).tolist() == [-1.0, 1.0, -1.0]
    off = np.array([day + 4 * H, day + 12 * H, day + 20 * H], dtype=np.int64)
    assert family_b.pos_side(np.array([1.0, -1.0, 0.0]), off).tolist() == [0.0, 0.0, 0.0]
    nan_sched = family_b.pos_side(np.array([np.nan, np.nan]), np.array([day, day + 4 * H], dtype=np.int64))
    assert np.isnan(nan_sched[0]) and nan_sched[1] == 0.0


def test_noise_features_use_the_configurations_noise_seed(synth_panel: dict[str, dict[str, pd.DataFrame]]) -> None:
    from r4 import hashfeat

    for seed in (11_500_000, 11_500_100):
        frame = decision_samples(synth_panel, _cfg("b_noise_sti", noise_seed=seed))
        for sym, g in frame.groupby("symbol"):
            want = hashfeat.hash_feature_matrix(
                list(calibration.NOISE_FEATURES), str(sym), list(synth_panel), g["T"].to_numpy(), seed, None
            )
            assert np.array_equal(g[list(calibration.NOISE_FEATURES)].to_numpy(), want)


def test_the_v8_terminal_exclusion_assertion_starts_exactly_on_2023_12_02(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    start = family_b.V8_ASSERT_FROM_MS
    assert start == 1_701_475_200_000
    over = _v8_export(tmp_path, "1h", [_row("1h", "BTCUSDT", start, hold=24 * H + H)], monkeypatch, name="on")
    with pytest.raises(ValueError, match="terminal exclusion"):
        family_b.read_v8_decisions(over, "1h")
    just_before = _v8_export(
        tmp_path, "1h", [_row("1h", "BTCUSDT", start - H, hold=24 * H + H)], monkeypatch, name="pre"
    )
    assert family_b.read_v8_decisions(just_before, "1h")["T"].tolist() == [start - H]


def test_the_receipts_trade_floor_is_met_at_exactly_the_floor() -> None:
    assert family_b.TRADE_FLOOR_TRANCHES == 1000
    rec = family_b.Recorder()
    for n, met in ((999, False), (1000, True), (1001, True)):
        block = family_b.receipt_block(_cfg("b_sti"), pd.DataFrame(), rec.frame(), rec.fits(), n, None)
        assert block["trade_floor"] == {"floor": 1000, "met": met}
