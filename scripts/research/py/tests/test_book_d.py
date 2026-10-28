"""Brief 24b: the family D book path (dollar-neutral rank weights, one tranche per non-flat coin)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4.bar import item5
from r4.book import Tranche, _coerce_tranches, daily_book
from r4.cli import config_hash_of, run_wf
from r4.method import UNIVERSE
from r4.pipeline import (
    RunConfig,
    SideModel,
    _get_decisions,
    _make_tranches,
    assert_whole_decision_times,
    rank_weights,
)
from r4.validation import panel_cpcv_splits
from tests.test_cli_bar import BASE_CFG, COMMIT, _create_synthetic_dataset_dir, _make_fast_synthetic_panel

HOUR = 3_600_000
T0 = 1_700_000_000_000


def _cfg(**over) -> RunConfig:
    base = {
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ("ret_1",),
        "interval": "1h",
        "h_ms": 4 * HOUR,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "seed": 7,
        "book": "D",
    }
    base.update(over)
    return RunConfig(**base)


def _frame(scores: list[float], t: int = T0) -> pd.DataFrame:
    n = len(scores)
    return pd.DataFrame(
        {
            "symbol": [f"C{i}USDT" for i in range(n)],
            "T": [t] * n,
            "entry": [100.0] * n,
            "exit": [101.0] * n,
            "t0": [t] * n,
            "t1_max": [t + 4 * HOUR] * n,
        }
    )


def test_d_weights_sum_abs_one_and_neutral():
    scores = np.array([0.3, -1.2, 0.8, 0.1, -0.4, 2.0, -0.9, 0.5, 1.1, -0.2])
    w = rank_weights(np.full(10, T0), scores)
    assert abs(np.abs(w).sum() - 1.0) < 1e-12
    assert abs(w.sum()) < 1e-12
    assert np.all(np.sign(w) == np.sign(scores - np.median(scores)))
    # the lowest score is the most negative weight, the highest the most positive
    assert w[np.argmin(scores)] == w.min()
    assert w[np.argmax(scores)] == w.max()


def test_d_ties_average_rank():
    # ranks of [1, 1, 2, 3, 3, 4] are [1.5, 1.5, 3, 4.5, 4.5, 6] around the mean 3.5
    w = rank_weights(np.full(6, T0), np.array([1.0, 1.0, 2.0, 3.0, 3.0, 4.0]))
    c = np.array([-2.0, -2.0, -0.5, 1.0, 1.0, 2.5])
    np.testing.assert_allclose(w, c / np.abs(c).sum(), atol=1e-15)
    assert w[0] == w[1] and w[3] == w[4]
    # all tied: no weight at all
    assert np.all(rank_weights(np.full(6, T0), np.ones(6)) == 0.0)


def test_d_odd_count_median_flat():
    scores = [5.0, 1.0, 3.0, 2.0, 7.0, 6.0, 4.0]
    w = rank_weights(np.full(7, T0), np.array(scores))
    assert w[scores.index(4.0)] == 0.0
    cfg = _cfg()
    tr = _make_tranches(_frame(scores), np.array(scores), cfg)
    assert len(tr) == 6
    assert "C6USDT" not in {t.symbol for t in tr}  # the median score 4.0 sits on C6


def test_d_fewer_than_6_coins_cash():
    assert np.all(rank_weights(np.full(5, T0), np.arange(5.0)) == 0.0)
    assert _make_tranches(_frame([1.0, 2.0, 3.0, 4.0, 5.0]), np.arange(5.0), _cfg()) == []
    assert _make_tranches(_frame(list(np.arange(6.0))), np.arange(6.0), _cfg()) != []
    # per decision time: a time with 5 coins is cash while a time with 6 trades
    times = np.array([1] * 5 + [2] * 6)
    w = rank_weights(times, np.arange(11.0))
    assert np.all(w[:5] == 0.0)
    assert abs(np.abs(w[5:]).sum() - 1.0) < 1e-12


def test_d_tranche_weight_override():
    scores = np.array([0.5, -0.5, 0.1, -0.1, 0.9, -0.9, 0.3, -0.3, 0.2, -0.2])
    cfg = _cfg()
    tr = _make_tranches(_frame(list(scores)), scores, cfg)
    w = rank_weights(np.full(10, T0), scores)
    assert len(tr) == 10
    for t, wi in zip(tr, w, strict=True):
        assert t.weight == pytest.approx(wi * HOUR / (4 * HOUR), abs=1e-15)
        assert t.side_val == (1 if wi > 0 else -1)
        assert t.weight_override == pytest.approx(t.weight)
    kw = dict(
        symbol="X",
        entry_ms=T0,
        exit_ms=T0 + HOUR,
        entry_price=1.0,
        exit_price=1.0,
        interval="1h",
        h_ms=4 * HOUR,
    )
    ok = Tranche(side=1, weight_override=0.01, **kw)
    assert ok.weight == 0.01
    assert Tranche(side=-1, weight_override=-0.02, size=3.0, **kw).weight == -0.02
    with pytest.raises(ValueError):
        Tranche(side=-1, weight_override=0.01, **kw).weight  # noqa: B018
    with pytest.raises(ValueError):
        Tranche(side=1, weight_override=-0.01, **kw).weight  # noqa: B018
    # the field survives the DataFrame, dict and object coercions
    df = pd.DataFrame([{**kw, "side": 1, "weight_override": 0.01}, {**kw, "side": 1, "weight_override": None}])
    got = _coerce_tranches(df)
    assert got[0].weight_override == 0.01 and got[1].weight_override is None
    got_d = _coerce_tranches([{**kw, "side": -1, "weight_override": -0.5}])
    assert got_d[0].weight_override == -0.5
    assert _coerce_tranches([ok])[0].weight_override == 0.01


def test_d_get_decisions_scores():
    x = np.array([[0.0], [1.0]])
    ridge = SideModel("ridge", type("R", (), {"predict": lambda self, a: a[:, 0] * 2.0})(), None, None, ())
    np.testing.assert_allclose(_get_decisions(ridge, x, _cfg()), [0.0, 2.0])
    cls = type("P", (), {"predict_proba": lambda self, a: np.column_stack([1 - a[:, 0], a[:, 0]])})()
    binary = SideModel("binary", None, cls, 0.2, (), 0.5, 0.1)
    # (p_up - base_up) - (p_dn - base_dn) with p_dn the constant 0.2
    np.testing.assert_allclose(
        _get_decisions(binary, np.array([[0.7], [0.3]]), _cfg(model="logistic")),
        [(0.7 - 0.5) - (0.2 - 0.1), (0.3 - 0.5) - (0.2 - 0.1)],
    )


def test_d_family_requires_book_d_and_size_rule_refused():
    with pytest.raises(ValueError):
        _cfg(family="D", book="slot")
    assert _cfg(family="D", book="D").book == "D"
    assert _cfg(family="A", book="D").book == "D"
    assert _cfg(family="A", book="slot").book == "slot"
    assert _cfg(family="A", book="slot").size_rule == "unit"
    with pytest.raises(ValueError):
        _cfg(book="D", size_rule="vol")
    with pytest.raises(ValueError):
        _cfg(book="bogus")
    assert _cfg(book="slot", size_rule="vol").size_rule == "vol"  # the slot rule is unchanged
    # the key enters the config hash
    h_slot = config_hash_of({**BASE_CFG, "book": "slot"})
    h_d = config_hash_of({**BASE_CFG, "book": "D"})
    assert h_slot != h_d


def test_d_family_requires_book_d(tmp_path: Path):
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=3)
    ds = _create_synthetic_dataset_dir(tmp_path, panel)
    cfg = {**BASE_CFG, "id": "d1", "family": "D"}  # no book key: default slot
    f = tmp_path / "c.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(ValueError):
        run_wf(f, ds, tmp_path / "o", commit=COMMIT, panel=panel)


def test_d_size_rule_refused(tmp_path: Path):
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=3)
    ds = _create_synthetic_dataset_dir(tmp_path, panel)
    cfg = {**BASE_CFG, "id": "d2", "book": "D", "size_rule": "vol"}
    f = tmp_path / "c.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(ValueError):
        run_wf(f, ds, tmp_path / "o", commit=COMMIT, panel=panel)


def test_d_walk_forward_end_to_end(tmp_path: Path):
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=10, inject_signal=True)
    ds = _create_synthetic_dataset_dir(tmp_path, panel)
    cfg = {**BASE_CFG, "id": "d3", "family": "D", "book": "D", "threshold": 0.0}
    f = tmp_path / "c.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    receipt = run_wf(f, ds, tmp_path / "out", commit=COMMIT, panel=panel)

    assert receipt["config"]["book"] == "D"
    assert receipt["config_hash"] == config_hash_of(cfg)
    assert item5(receipt)["rule"] == "jackknife"

    tr_df = pd.read_parquet(tmp_path / "out" / "d3" / "tranches.parquet")
    assert "weight_override" in tr_df.columns
    assert len(tr_df) > 0 and tr_df["weight_override"].notna().all()
    tranches = _coerce_tranches(tr_df)
    # each decision time: sum |w| x h / interval = 1 and the signed sum is zero
    by_entry: dict[int, list[Tranche]] = {}
    for t in tranches:
        by_entry.setdefault(t.entry_ms, []).append(t)
    for group in by_entry.values():
        assert len(group) >= 5
        assert abs(sum(t.weight for t in group)) < 1e-12
        assert abs(sum(abs(t.weight) for t in group) * (4 * HOUR / HOUR) - 1.0) < 1e-12
    # the daily book is dollar-neutral at every day start
    five_min = {s: panel[s]["5m"] for s in panel}
    settlements = {s: panel[s]["settlements"] for s in panel}
    book = daily_book(tranches, five_min, settlements)
    assert len(book) > 30
    assert np.abs(book["net_weight_start"].to_numpy(dtype=float)).max() < 1e-12
    # not an all-slot book: weights are not the +-1/40 slot weights
    assert not np.isclose(np.abs([t.weight for t in tranches]), 1.0 / 40.0).all()


def test_d_cpcv_ranks_within_group():
    rng = np.random.default_rng(0)
    n_t, n_c = 60, 6
    t0 = np.repeat(T0 + np.arange(n_t, dtype=np.int64) * HOUR, n_c)
    t1 = t0 + 4 * HOUR
    splits = list(panel_cpcv_splits(t0, t1, n_groups=6, n_test_groups=2, embargo_ms=0))
    for _train, groups in splits:
        assert_whole_decision_times(groups, t0)
        for g in groups:
            scores = rng.normal(size=len(g))
            w = rank_weights(t0[g], scores)
            for t in np.unique(t0[g]):
                m = t0[g] == t
                assert abs(w[m].sum()) < 1e-12
                assert abs(np.abs(w[m]).sum() - 1.0) < 1e-12
    # a time split across two groups is refused
    bad = [np.array([0, 1, 2]), np.array([3, 4, 5])]
    with pytest.raises(ValueError):
        assert_whole_decision_times(bad, np.array([1, 1, 1, 1, 2, 2]))
    assert_whole_decision_times(bad, np.array([1, 1, 1, 2, 2, 2]))
