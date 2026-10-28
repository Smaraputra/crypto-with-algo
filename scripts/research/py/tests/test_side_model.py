"""Brief 22: two binary classifiers (up and down) replace the asymmetric classifier side rule."""

from __future__ import annotations

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
    cfg = _cfg("logistic", threshold=0.5)
    model = fit_side_model(cfg, x, df)
    sides = _get_decisions(model, x, cfg)
    long_share = (sides == 1).sum() / max(1, (sides != 0).sum())
    assert (sides != 0).sum() > 100
    assert 0.4 <= long_share <= 0.6
    assert model.degenerate_fits == ()


def test_classifier_rule_exact():
    cfg = _cfg("logistic", threshold=0.55)
    x = np.zeros((1, 1))
    expected = {(0.7, 0.2): 1, (0.2, 0.7): -1, (0.6, 0.6): 0, (0.4, 0.3): 0}
    for (p_up, p_dn), want in expected.items():
        model = SideModel(kind="binary", ridge=None, up=_Stub(p_up), dn=_Stub(p_dn), degenerate_fits=())
        assert _get_decisions(model, x, cfg).tolist() == [want], (p_up, p_dn)


def test_degenerate_side():
    rng = np.random.default_rng(2)
    n = 300
    x = rng.normal(size=(n, 1))
    rt = default_cost_percent("1h") / 100.0
    gross = np.where(x[:, 0] > 0, 2 * rt, 0.0)  # never below -rt: no down labels
    df = pd.DataFrame({"gross_log": gross, "symbol": "BTCUSDT"})
    cfg = _cfg("logistic", threshold=0.5)
    model = fit_side_model(cfg, x, df)
    assert model.degenerate_fits == ("down",)
    sides = _get_decisions(model, x, cfg)
    assert (sides == -1).sum() == 0
    assert (sides == 1).sum() > 0


def test_triple_barrier_labels_map():
    rng = np.random.default_rng(3)
    n = 600
    x = rng.normal(size=(n, 1))
    tb = np.where(x[:, 0] > 0.5, 1.0, np.where(x[:, 0] < -0.5, -1.0, 0.0))
    df = pd.DataFrame({"gross_log": np.zeros(n), "tb_label": tb})
    cfg = _cfg("lightgbm", label="triple_barrier", threshold=0.6, params={"n_estimators": 30, "num_leaves": 4})
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
        threshold=0.4,
        params={"n_estimators": 30, "num_leaves": 8, "subsample": 0.7, "subsample_freq": 1, "colsample_bytree": 0.6},
    )
    first = _get_decisions(fit_side_model(cfg, x, df), x, cfg)
    second = _get_decisions(fit_side_model(cfg, x, df), x, cfg)
    assert np.array_equal(first, second)
    assert (first != 0).sum() > 0
