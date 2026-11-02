"""Briefs 22 and 24a: two binary classifiers (up and down) with a margin-over-base-rate side rule."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from r4.costs import default_cost_percent
from r4.pipeline import RunConfig, SideModel, _get_decisions, fit_side_model


def _cfg(model: str, label: str = "fixed", threshold: float = 0.55, params: dict | None = None) -> RunConfig:
    if params is None:
        params = {"alpha": 1.0} if model == "ridge" else {}
    return RunConfig(
        family="A",
        model=model,
        params=params,
        features=("a",),
        interval="1h",
        h_ms=14_400_000,
        label=label,
        side_rule="sign" if model == "ridge" else "prob",
        threshold=threshold,
        size_rule="unit",
        lookback_months=None,
        refit="monthly",
        exit="horizon",
        seed=7,
    )


class _Stub:
    def __init__(self, p: float) -> None:
        self.p = p

    def predict_proba(self, x: np.ndarray) -> np.ndarray:
        return np.column_stack([np.full(len(x), 1 - self.p), np.full(len(x), self.p)])


def test_classifier_symmetric_on_symmetric_data():
    rng = np.random.default_rng(1)
    n = 4000
    x = rng.normal(size=(n, 1))
    rt = default_cost_percent("1h") / 100.0
    # up when x is high, down when x is low, symmetric about zero, with magnitudes beyond the cost
    gross = np.where(x[:, 0] > 0.5, 2 * rt, np.where(x[:, 0] < -0.5, -2 * rt, 0.0))
    df = pd.DataFrame({"gross_log": gross, "symbol": "BTCUSDT"})
    cfg = _cfg("logistic", threshold=0.05)
    model = fit_side_model(cfg, x, df)
    sides = _get_decisions(model, x, cfg)
    long_share = (sides == 1).sum() / max(1, (sides != 0).sum())
    assert (sides != 0).sum() > 100
    assert 0.4 <= long_share <= 0.6
    assert model.degenerate_fits == ()


def test_classifier_margin_over_base_rate():
    cfg = _cfg("logistic", threshold=0.02)
    x = np.zeros((1, 1))
    expected = {
        (0.50, 0.40): 1,
        (0.47, 0.47): 0,
        (0.40, 0.50): -1,
        (0.47, 0.40): 0,  # margin 0.01 does not exceed 0.02
        (0.60, 0.60): 0,  # a tie is flat
        (0.60, 0.55): 1,  # margins 0.14 and 0.09: the larger margin wins
        (0.55, 0.60): -1,
        (0.40, 0.30): 0,
    }
    for (p_up, p_dn), want in expected.items():
        model = SideModel(
            kind="binary",
            ridge=None,
            up=_Stub(p_up),
            dn=_Stub(p_dn),
            degenerate_fits=(),
            base_up=0.46,
            base_dn=0.46,
        )
        assert _get_decisions(model, x, cfg).tolist() == [want], (p_up, p_dn)


def test_classifier_margin_uses_each_sides_base_rate():
    cfg = _cfg("logistic", threshold=0.02)
    x = np.zeros((1, 1))
    # base rates 0.30 and 0.60: p (0.40, 0.65) has margins 0.10 and 0.05, so long; p (0.31, 0.70) short
    model = SideModel("binary", None, _Stub(0.40), _Stub(0.65), (), base_up=0.30, base_dn=0.60)
    assert _get_decisions(model, x, cfg).tolist() == [1]
    model = SideModel("binary", None, _Stub(0.31), _Stub(0.70), (), base_up=0.30, base_dn=0.60)
    assert _get_decisions(model, x, cfg).tolist() == [-1]


def test_classifier_trades_near_base_rate():
    rng = np.random.default_rng(11)
    rt = default_cost_percent("1h") / 100.0
    sigma = rt / 0.1004  # P(gross > rt) = P(gross < -rt) = 0.46 for a zero-mean normal
    n_train, n_test = 3000, 2000
    x_train = rng.normal(size=(n_train, 3))
    x_test = rng.normal(size=(n_test, 3))
    df = pd.DataFrame({"gross_log": rng.normal(0.0, sigma, size=n_train), "symbol": "BTCUSDT"})
    params = {"n_estimators": 20, "num_leaves": 4, "learning_rate": 0.05, "min_child_samples": 100}
    cfg = _cfg("lightgbm", threshold=0.02, params=params)
    model = fit_side_model(cfg, x_train, df)
    assert 0.42 < model.base_up < 0.50 and 0.42 < model.base_dn < 0.50
    traded = float((_get_decisions(model, x_test, cfg) != 0).mean())
    assert traded >= 0.05, traded
    # The old absolute rule at threshold 0.55 for contrast: almost nothing clears it at a 0.46 base rate.
    p_up = model.up.predict_proba(x_test)[:, 1]
    p_dn = model.dn.predict_proba(x_test)[:, 1]
    old_share = float((((p_up > 0.55) & (p_up > p_dn)) | ((p_dn > 0.55) & (p_dn > p_up))).mean())
    assert old_share < 0.01, old_share


def test_fit_stores_base_rates():
    rng = np.random.default_rng(4)
    n = 400
    x = rng.normal(size=(n, 1))
    rt = default_cost_percent("1h") / 100.0
    gross = np.where(x[:, 0] > 0.5, 2 * rt, np.where(x[:, 0] < -0.5, -2 * rt, 0.0))
    df = pd.DataFrame({"gross_log": gross, "symbol": "BTCUSDT"})
    model = fit_side_model(_cfg("logistic", threshold=0.05), x, df)
    assert model.base_up == float((gross > 2 * rt * 0.5).mean())
    assert model.base_dn == float((gross < -2 * rt * 0.5).mean())


def test_triple_barrier_short_label():
    """y_dn counts only a short take-profit that trades strictly through, not a long stop touch."""
    from r4.labels import triple_barrier
    from r4.pipeline import _binary_labels

    sigma = 0.01
    entry = 100.0
    lower = entry * math.exp(-sigma)

    def path(low_at_bar_3: float, n_bars: int = 14) -> pd.DataFrame:
        t = np.arange(n_bars, dtype=np.int64) * 300_000
        low = np.full(n_bars, 99.9)
        low[3] = low_at_bar_3
        return pd.DataFrame({"t": t, "o": entry, "h": 100.1, "l": low, "c": entry})

    def labels(low_at_bar_3: float) -> tuple[float, float]:
        bars = path(low_at_bar_3)
        kwargs = {
            "decision_times": [0],
            "five_min": bars,
            "h_ms": 3_600_000,
            "sigma_h": sigma,
            "k_up": 1.0,
            "k_down": 1.0,
            "delay_ms": 0,
        }
        long_label = float(triple_barrier(side=1, **kwargs)["label"].iloc[0])
        short_label = float(triple_barrier(side=-1, **kwargs)["label"].iloc[0])
        return long_label, short_label

    def y_dn(long_label: float, short_label: float) -> int:
        df = pd.DataFrame({"tb_label": [long_label], "tb_label_short": [short_label], "gross_log": [0.0]})
        cfg = _cfg("lightgbm", label="triple_barrier")
        return int(_binary_labels(df, cfg)[1][0])

    # The low touches the lower barrier exactly: a long stop, but the short take-profit needs a strict trade-through.
    touch = labels(lower)
    assert touch == (-1.0, 0.0)
    assert y_dn(*touch) == 0
    # The low trades through the lower barrier: the long stops out and the short takes profit.
    through = labels(lower * 0.999)
    assert through == (-1.0, 1.0)
    assert y_dn(*through) == 1


def test_degenerate_side():
    rng = np.random.default_rng(2)
    n = 300
    x = rng.normal(size=(n, 1))
    rt = default_cost_percent("1h") / 100.0
    gross = np.where(x[:, 0] > 0, 2 * rt, 0.0)  # never below -rt: no down labels
    df = pd.DataFrame({"gross_log": gross, "symbol": "BTCUSDT"})
    cfg = _cfg("logistic", threshold=0.05)
    model = fit_side_model(cfg, x, df)
    assert model.degenerate_fits == ("down",)
    assert model.base_dn == 0.0
    # A degenerate side keeps p at its base rate, so its margin is 0 and it never trades.
    assert _get_decisions(model, x, cfg).min() == 0
    sides = _get_decisions(model, x, cfg)
    assert (sides == -1).sum() == 0
    assert (sides == 1).sum() > 0


def test_triple_barrier_labels_map():
    rng = np.random.default_rng(3)
    n = 600
    x = rng.normal(size=(n, 1))
    tb = np.where(x[:, 0] > 0.5, 1.0, np.where(x[:, 0] < -0.5, -1.0, 0.0))
    tb_short = np.where(x[:, 0] < -0.5, 1.0, np.where(x[:, 0] > 0.5, -1.0, 0.0))
    df = pd.DataFrame({"gross_log": np.zeros(n), "tb_label": tb, "tb_label_short": tb_short})
    cfg = _cfg("lightgbm", label="triple_barrier", threshold=0.2, params={"n_estimators": 30, "num_leaves": 4})
    model = fit_side_model(cfg, x, df)
    probe = np.array([[2.0], [-2.0], [0.0]])
    assert model.up.predict_proba(probe)[:, 1].tolist()[0] > 0.9
    assert model.up.predict_proba(probe)[:, 1].tolist()[1] < 0.1
    assert model.dn.predict_proba(probe)[:, 1].tolist()[1] > 0.9
    assert model.dn.predict_proba(probe)[:, 1].tolist()[0] < 0.1
    assert model.up.predict_proba(probe)[2, 1] < 0.1 and model.dn.predict_proba(probe)[2, 1] < 0.1
    assert _get_decisions(model, probe, cfg).tolist() == [1, -1, 0]


def test_ridge_unchanged():
    rng = np.random.default_rng(5)
    x = rng.normal(size=(200, 3))
    g = 0.002 * x[:, 0] + 0.001 * rng.normal(size=200)
    cfg = _cfg("ridge", threshold=0.0008)
    model = fit_side_model(cfg, x, pd.DataFrame({"gross_log": g}))
    assert _get_decisions(model, x[:12], cfg).tolist() == [-1, 0, -1, 1, -1, -1, -1, 1, 0, 0, -1, 0]
    assert int(_get_decisions(model, x, cfg).sum()) == 2


def test_lightgbm_pair_deterministic():
    rng = np.random.default_rng(3)
    n = 600
    x = rng.normal(size=(n, 3))
    rt = default_cost_percent("1h") / 100.0
    gross = rt * 3 * x[:, 0] + rt * rng.normal(size=n)
    df = pd.DataFrame({"gross_log": gross, "symbol": "BTCUSDT"})
    cfg = _cfg(
        "lightgbm",
        threshold=0.1,
        params={"n_estimators": 30, "num_leaves": 8, "subsample": 0.7, "subsample_freq": 1, "colsample_bytree": 0.6},
    )
    first = _get_decisions(fit_side_model(cfg, x, df), x, cfg)
    second = _get_decisions(fit_side_model(cfg, x, df), x, cfg)
    assert np.array_equal(first, second)
    assert (first != 0).sum() > 0
