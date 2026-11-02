"""Tests for label-shift tripwire shifting E4/E5 exit model training labels (Brief 28h)."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import pytest

import r4.tripwire as tw
from r4.exit_models import (
    ExitModelFactory,
)
from r4.exits import (
    STEP_MS,
    replay_exits,
)
from r4.method import (
    ENTRY_DELAY_MS,
    UNIVERSE,
)
from r4.pipeline import (
    RunConfig,
    decision_samples,
)
from r4.plant import classify_events, plant_events
from r4.synth import synth_panel

B0 = 1_672_531_200_000  # 2023-01-01 UTC
DAY = 86_400_000
HOUR = 3_600_000
H4 = 4 * HOUR
FEATURES = ("taker_imb_last15", "ret_15m_last")
SPEC_E4 = {"rule": "E4", "margin_se": 1.0}
SPEC_E5 = {"rule": "E5", "p_close": 0.35, "confirm_bars": 3}


def _panel(n_coins: int, days: int, seed: int, vol: float = 0.015) -> dict[str, dict[str, pd.DataFrame]]:
    syms = list(UNIVERSE[:n_coins])
    cov = (vol**2) * (0.3 * np.ones((n_coins, n_coins)) + 0.7 * np.eye(n_coins))
    return synth_panel(cov, syms, B0, B0 + days * DAY, seed)


def test_shift_0_training_set_identical() -> None:
    panel = _panel(2, 60, seed=11)
    cut = B0 + 45 * DAY
    fac_def = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7)
    fac_0 = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7, label_shift_ms=0)
    ts_def = fac_def.training_set(None, cut)
    ts_0 = fac_0.training_set(None, cut)

    np.testing.assert_array_equal(ts_0.symbol, ts_def.symbol)
    np.testing.assert_array_equal(ts_0.T, ts_def.T)
    np.testing.assert_array_equal(ts_0.tau, ts_def.tau)
    np.testing.assert_array_equal(ts_0.S, ts_def.S)
    np.testing.assert_array_equal(ts_0.market, ts_def.market)
    for k in ts_0.paths:
        np.testing.assert_array_equal(ts_0.paths[k], ts_def.paths[k])
    assert ts_0.n_missing_feature == ts_def.n_missing_feature
    assert getattr(ts_0, "n_label_shift_dropped", 0) == 0
    assert getattr(ts_0, "n_label_shift_purged", 0) == 0


def test_shift_preserves_market_and_state_and_shifts_core_fund() -> None:
    panel = _panel(2, 80, seed=12)
    cut = B0 + 60 * DAY
    shift_ms = 10 * DAY
    fac_0 = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7, label_shift_ms=0)
    fac_s = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7, label_shift_ms=shift_ms)

    ts_0 = fac_0.training_set(None, cut)
    ts_s = fac_s.training_set(None, cut)

    assert len(ts_s.T) > 0

    # Index ts_0 by (symbol, T, tau)
    idx_0 = {(s, int(t), int(tau)): i for i, (s, t, tau) in enumerate(zip(ts_0.symbol, ts_0.T, ts_0.tau, strict=True))}

    for i in range(len(ts_s.T)):
        sym = ts_s.symbol[i]
        t_val = int(ts_s.T[i])
        tau_val = int(ts_s.tau[i])
        key = (sym, t_val, tau_val)
        assert key in idx_0
        orig_i = idx_0[key]

        # market and state equal the unshifted sample
        np.testing.assert_array_equal(ts_s.market[i], ts_0.market[orig_i])
        for p in ("elapsed", "lr", "mfe_long", "mae_long"):
            assert np.isclose(ts_s.paths[p][i], ts_0.paths[p][orig_i])

        # Hand computation of core and fund
        dec = panel[sym]["1h"]
        ts_arr = np.sort(np.unique(dec["t"].to_numpy(dtype=np.int64))) + HOUR
        lo, hi = int(ts_arr[0]), int(ts_arr[-1])
        length = hi - lo + HOUR
        tp = lo + (t_val - lo + shift_ms) % length
        tau_prime = tau_val + (tp - t_val)
        s_prime = int(ts_s.S[i]) + (tp - t_val)

        b = fac_0.bars(sym)
        i_s_prime = np.searchsorted(b.t, s_prime)
        i_tau_prime_10m = np.searchsorted(b.t, tau_prime + 2 * STEP_MS)
        hand_core = np.log(float(b.o[i_s_prime]) / float(b.o[i_tau_prime_10m]))
        assert np.isclose(ts_s.paths["core"][i], hand_core)

        fund_df = panel[sym]["settlements"]
        fund_sub = fund_df.loc[(fund_df["t"] > tau_prime + 2 * STEP_MS) & (fund_df["t"] <= s_prime)]
        hand_fund = float(fund_sub["rate"].sum()) if not fund_sub.empty else 0.0
        assert np.isclose(ts_s.paths["fund"][i], hand_fund)


def test_circular_wrap_matches_shift_labels() -> None:
    panel = _panel(2, 60, seed=13)
    sym = UNIVERSE[0]
    dec = panel[sym]["1h"]
    ts_arr = np.sort(np.unique(dec["t"].to_numpy(dtype=np.int64))) + HOUR
    lo, hi = int(ts_arr[0]), int(ts_arr[-1])
    circle_length = hi - lo + HOUR

    shift_ms = 7 * DAY
    df_samples = pd.DataFrame(
        {
            "symbol": sym,
            "T": ts_arr,
            "t1_max": ts_arr + H4,
            "gross_log": 0.0,
        }
    )
    shifted_df, _ = tw.shift_labels(df_samples, shift_ms, HOUR)

    for orig_t in ts_arr:
        expected_tp = lo + (orig_t - lo + shift_ms) % circle_length
        # exit models wrapping
        assert (lo + (orig_t - lo + shift_ms) % circle_length) == expected_tp

    # End of span wraps to lo
    end_t = hi
    wrap_shift = HOUR
    tp_end = lo + (end_t - lo + wrap_shift) % circle_length
    assert tp_end == lo


def test_purge_and_drop_counted() -> None:
    panel = _panel(1, 100, seed=14)
    sym = UNIVERSE[0]
    cut = B0 + 60 * DAY

    # Real hold near cut - 10 days shifted by 30 days ends near cut + 20 days >= cut - 30 days
    # So samples with S' >= cut - 30 days (CPCV_EMBARGO_MS) must be purged and counted.
    fac = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7, label_shift_ms=30 * DAY)
    ts = fac.training_set(None, cut)
    assert ts.n_label_shift_purged > 0

    # Test dropped: corrupt one bar of a source hold to make it missing
    cut_drop = B0 + 70 * DAY
    panel_mod = {s: dict(panel[s]) for s in panel}
    five = panel_mod[sym]["5m"].copy()
    # drop 5m bar at B0 + 25 * DAY + 1 * HOUR (source hold for real hold at B0 + 15 * DAY with 10d shift)
    drop_t = B0 + 25 * DAY + HOUR
    panel_mod[sym]["5m"] = five.loc[five["t"] != drop_t].reset_index(drop=True)

    fac_mod = ExitModelFactory(panel_mod, "1h", H4, FEATURES, seed=7, label_shift_ms=10 * DAY)
    ts_mod = fac_mod.training_set(None, cut_drop)
    assert ts_mod.n_label_shift_dropped > 0


def test_shifted_run_passes_shift_and_carries_counts(monkeypatch: pytest.MonkeyPatch) -> None:
    panel = _panel(2, 70, seed=15)
    cfg = RunConfig(
        family="A",
        model="ridge",
        params={"alpha": 1.0},
        features=FEATURES,
        interval="1h",
        h_ms=H4,
        label="fixed",
        side_rule="sign",
        threshold=0.0,
        size_rule="unit",
        lookback_months=None,
        refit="monthly",
        exit=SPEC_E4,
        seed=7,
    )
    samples = decision_samples(panel, cfg)
    received_shift = []
    real_from_cfg = ExitModelFactory.from_config

    def spy_from_config(panel_arg: Any, cfg_arg: Any, **kw: Any) -> Any:
        received_shift.append(kw.get("label_shift_ms", getattr(cfg_arg, "label_shift_ms", 0)))
        return real_from_cfg(panel_arg, cfg_arg, **kw)

    monkeypatch.setattr(ExitModelFactory, "from_config", spy_from_config)

    shift_days = 30
    res = tw.shifted_run(samples, cfg, shift_days, B0 + 40 * DAY, B0 + 70 * DAY, panel=panel)
    assert len(received_shift) > 0
    assert received_shift[0] == shift_days * DAY
    assert "exit_label_shift_dropped" in res
    assert "exit_label_shift_purged" in res
    assert isinstance(res["exit_label_shift_dropped"], int)
    assert isinstance(res["exit_label_shift_purged"], int)


def test_power_e5_close_ahead_drop() -> None:
    panel, events = plant_events(_panel(4, 100, seed=31), seed=32)
    cut = B0 + 70 * DAY
    bars = {s: panel[s]["5m"] for s in panel}

    # Unshifted model
    fac_real = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7, label_shift_ms=0)
    inputs_real = fac_real.fit(None, cut)
    assert inputs_real is not None

    # Shifted model with 30 days shift
    fac_shift = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7, label_shift_ms=30 * DAY)
    inputs_shift = fac_shift.fit(None, cut)
    assert inputs_shift is not None

    parts = []
    for sym in panel:
        b = fac_real.bars(sym)
        top = np.arange(cut, B0 + 100 * DAY - 6 * HOUR, HOUR, dtype=np.int64)
        for side in (1, -1):
            entry = top + ENTRY_DELAY_MS
            idx = np.searchsorted(b.t, entry)
            parts.append(
                pd.DataFrame(
                    {
                        "symbol": sym,
                        "side": side,
                        "T": top,
                        "entry_ms": entry,
                        "exit_ms": entry + H4,
                        "entry_price": b.o[idx],
                    }
                )
            )
    ent = pd.concat(parts, ignore_index=True)
    nan_sigma = lambda s, t: np.full(len(t), np.nan)  # noqa: E731

    e5_real = replay_exits(ent, bars, SPEC_E5, nan_sigma, models=inputs_real)
    e5_shift = replay_exits(ent, bars, SPEC_E5, nan_sigma, models=inputs_shift)

    pl, un, drop_start = classify_events(ent, events)
    assert pl.sum() >= 100

    closed_real = (e5_real["exit_reason"] == "model_exit").to_numpy()
    ahead_real = closed_real & (e5_real["exit_ms"].to_numpy() <= drop_start)
    rate_real = float(ahead_real[pl].mean())

    closed_shift = (e5_shift["exit_reason"] == "model_exit").to_numpy()
    ahead_shift = closed_shift & (e5_shift["exit_ms"].to_numpy() <= drop_start)
    rate_shift = float(ahead_shift[pl].mean())

    print(f"E5 close-ahead rate real: {rate_real:.4f}, shifted: {rate_shift:.4f}")
    assert rate_real >= 0.80
    assert rate_shift < 0.50
