"""Brief 33b: the Codex review fixes of family C (draft 4 rules)."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import family_c, stats

H = 3_600_000
DAY = 86_400_000
BAR = 300_000


def _spy(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    sizes: list[int] = []
    real = stats.stationary_bootstrap_indices

    def spy(n: int, mean_block_len: float, rng: Any = None) -> np.ndarray:
        sizes.append(int(n))
        return real(n, mean_block_len, rng)

    monkeypatch.setattr(stats, "stationary_bootstrap_indices", spy)
    return sizes


def test_refit_bootstrap_runs_on_the_calendar_day_grid(monkeypatch: pytest.MonkeyPatch) -> None:
    days = np.array([90, 100], dtype=np.int64)
    T = days * DAY
    cfg = pd.DataFrame({"coin": "BTCUSDT", "T": T, "y": [1.0, 2.0], "f": [1.0, 1.0]})
    twin = pd.DataFrame({"coin": "BTCUSDT", "T": T, "f": [2.0, 2.0]})
    sizes = _spy(monkeypatch)
    res = family_c.refit_comparison(cfg, twin, 0)
    # Days 90 and 100 are 10 grid positions apart: the grid holds 11 days, 2 with a value.
    assert set(sizes) == {11}
    assert res["status"] == "descriptive" and res["n_days"] == 2 and res["n_grid_days"] == 11
    expected = np.mean(
        [family_c.qlike(1.0, 2.0) - family_c.qlike(1.0, 1.0), family_c.qlike(2.0, 2.0) - family_c.qlike(2.0, 1.0)]
    )
    assert res["point"] == pytest.approx(float(expected))


def test_refit_bootstrap_all_empty_draws_are_counted(monkeypatch: pytest.MonkeyPatch) -> None:
    days = np.array([90, 100], dtype=np.int64)
    T = days * DAY
    cfg = pd.DataFrame({"coin": "BTCUSDT", "T": T, "y": [1.0, 2.0], "f": [1.0, 1.0]})
    twin = pd.DataFrame({"coin": "BTCUSDT", "T": T, "f": [2.0, 2.0]})
    # Every draw lands on an empty grid day (position 5 of 11), so no draw has a value.
    monkeypatch.setattr(stats, "stationary_bootstrap_indices", lambda n, b, rng=None: np.full(n, 5, dtype=np.int64))
    res = family_c.refit_comparison(cfg, twin, 0)
    assert res["status"] == "inconclusive"
    assert res["n_empty_draws"] == family_c.BOOTSTRAP_ITERATIONS == res["iterations"]


def _stay_two_days_apart() -> pd.DataFrame:
    # One forecast per day for 200 days, with a gap of days 150 to 159 (no window).
    days = np.array([d for d in range(200) if not 150 <= d < 160], dtype=np.int64)
    T = days * DAY
    hot = np.isin(days, [100, 120, 140, 170, 190])
    sd_f = np.where(hot, 2.0, 1.0)
    sd_y = np.where(hot, 3.0, 1.0)
    return pd.DataFrame({"coin": "BTCUSDT", "T": T, "y": sd_y**2, "f": sd_f**2, "G": 1.0})


def test_flag1_bootstrap_runs_on_the_calendar_day_grid(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = _stay_two_days_apart()
    sizes = _spy(monkeypatch)
    res = family_c.stay_out_flag(rows, DAY, 3)["flag1"]
    # Eligible days run from 90 to 199: a grid of 110 days although days 150 to 159 have no window.
    assert set(sizes) == {110}
    assert res["n_days"] == 110 and res["n_days_with_windows"] == 100
    assert res["ratio"] == pytest.approx(3.0) and res["seed"] == 12_100_003


def test_flag1_eligibility_needs_ninety_days_and_a_forecast_in_the_lookback() -> None:
    t = np.array([0, 100], dtype=np.int64) * DAY
    eligible, flagged = family_c.trailing_vol_flags(t, np.array([1.0, 4.0]), DAY)
    assert eligible.tolist() == [False, False] and flagged.tolist() == [False, False]
    # Day 100 with a forecast on day 50 in the lookback is eligible and flagged.
    t2 = np.array([0, 50, 100], dtype=np.int64) * DAY
    eligible, flagged = family_c.trailing_vol_flags(t2, np.array([1.0, 1.0, 4.0]), DAY)
    assert eligible.tolist() == [False, False, True] and flagged.tolist() == [False, False, True]


def test_qlike_floors_both_arguments() -> None:
    assert family_c.qlike(0.0, 1e-12)[()] == pytest.approx(0.0)
    assert family_c.qlike(0.0, 1.0)[()] == pytest.approx(1e-12 - math.log(1e-12) - 1.0)
    assert family_c.log_mse(0.0, 1e-12)[()] == pytest.approx(0.0)
    assert family_c.qlike(1.0, 0.0)[()] == pytest.approx(1e12 - math.log(1e12) - 1.0)


def test_window_needs_the_exact_five_minute_grid() -> None:
    rng = np.random.default_rng(3)
    c = 100.0 * np.exp(np.cumsum(rng.normal(0.0, 0.001, 24)))
    o = np.concatenate(([100.0], c[:-1]))
    df = pd.DataFrame(
        {"t": np.arange(24) * BAR, "o": o, "h": np.maximum(o, c) + 0.1, "l": np.minimum(o, c) - 0.1, "c": c}
    )
    win, info = family_c.window_table(df, H)
    assert np.isfinite(win["RV"]).all() and info["n_incomplete"] == 0
    shifted = df.copy()
    shifted.loc[11, "t"] += 1
    win, info = family_c.window_table(shifted, H)
    assert np.isnan(win.loc[0, "RV"]) and np.isfinite(win.loc[H, "RV"])
    assert info["n_incomplete"] == 1


def test_configurations_carry_the_joint_shift_seed() -> None:
    seeds = [c["joint_shift_seed"] for c in family_c.family_c()]
    assert seeds == [12_000_000 + i for i in range(9)]
    assert family_c.family_c_twin("C_LHAR_1d")["joint_shift_seed"] == 12_000_006
    assert family_c.STAY_OUT_SEED_BASE == 12_100_000 and family_c.REFIT_SEED_BASE == 7_100_000
