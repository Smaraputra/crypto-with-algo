"""Brief 28d-2: synthetic 5m extremes are Brownian-bridge extremes of the path they belong to."""

from __future__ import annotations

import numpy as np
from scipy.stats import kstest

from r4.synth import synth_panel

DAY = 86_400_000
START = 1672531200000
SD = 0.03
N_SYM = 3
SYMS = ["AAAUSDT", "BBBUSDT", "CCCUSDT"]


def _panel(seed: int = 5):
    cov = np.diag([SD**2] * N_SYM)
    # alpha = beta = 0 makes the daily sigma constant, so each 5m bar has variance SD^2 / 288.
    return synth_panel(cov, SYMS, START, START + 24 * DAY, seed=seed, garch=(0.0, 0.0))


def _stacked(panel):
    o = np.concatenate([panel[s]["5m"]["o"].to_numpy() for s in SYMS])
    h = np.concatenate([panel[s]["5m"]["h"].to_numpy() for s in SYMS])
    lo = np.concatenate([panel[s]["5m"]["l"].to_numpy() for s in SYMS])
    c = np.concatenate([panel[s]["5m"]["c"].to_numpy() for s in SYMS])
    return o, h, lo, c


def test_extremes_bound_the_bar_and_are_reproducible():
    o, h, lo, c = _stacked(_panel())
    assert (h >= np.maximum(o, c)).all() and (lo <= np.minimum(o, c)).all()
    assert len(o) == N_SYM * 24 * 288 >= 20_000
    a, b = _stacked(_panel()), _stacked(_panel())
    assert all((x == y).all() for x, y in zip(a, b, strict=True))
    assert not (a[1] == _stacked(_panel(seed=6))[1]).all()


def test_high_and_low_excursions_follow_the_bridge_distribution():
    o, h, lo, c = _stacked(_panel())
    s2 = SD**2 / 288.0
    lo_o, lo_c = np.log(o), np.log(c)
    # P(max >= m) = exp(-2 (m - a)(m - b) / s2) for a bridge from a to b: the transform is Uniform(0, 1).
    u_high = np.exp(-2.0 * (np.log(h) - lo_o) * (np.log(h) - lo_c) / s2)
    u_low = np.exp(-2.0 * (np.log(lo) - lo_o) * (np.log(lo) - lo_c) / s2)
    assert len(u_high) >= 20_000
    assert kstest(u_high[:20_000], "uniform").pvalue > 0.01
    assert kstest(u_low[:20_000], "uniform").pvalue > 0.01
