"""Tests for the E4 and E5 exits (brief 25c): phase bars, the tau frame, side-symmetric training, the models' rules."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4.causality import assert_future_invariant
from r4.exit_models import (
    MIN_SAMPLES,
    ExitModelFactory,
    build_tau_frame,
    cached_tau_frame,
    exit_hold_diagnostic,
    hold_paths,
    phase_bars,
    tau_cache_path,
)
from r4.exits import (
    STEP_MS,
    ExitContext,
    ExitSpec,
    init_state,
    parse_exit,
    prepare_bars,
    replay_by_steps,
    replay_exits,
)
from r4.method import ENTRY_DELAY_MS, UNIVERSE
from r4.pipeline import RunConfig, decision_samples, walk_forward
from r4.plant import classify_events, plant_events
from r4.synth import synth_panel

B0 = 1_672_531_200_000  # 2023-01-01 UTC
DAY = 86_400_000
HOUR = 3_600_000
H4 = 4 * HOUR
FEATURES = ("taker_imb_last15", "ret_15m_last")
SPEC_E4 = {"rule": "E4", "margin_se": 1.0}
SPEC_E5 = {"rule": "E5", "p_close": 0.35, "confirm_bars": 3}
SPEC_E5_SINGLE = {"rule": "E5", "p_close": 0.4, "confirm_bars": 1}


def _panel(n_coins: int, days: int, seed: int, vol: float = 0.015) -> dict[str, dict[str, pd.DataFrame]]:
    syms = list(UNIVERSE[:n_coins])
    cov = (vol**2) * (0.3 * np.ones((n_coins, n_coins)) + 0.7 * np.eye(n_coins))
    return synth_panel(cov, syms, B0, B0 + days * DAY, seed)


# ---------------------------------------------------------------------------
# Spec parsing
# ---------------------------------------------------------------------------


def test_parse_e4_e5_specs() -> None:
    assert parse_exit(SPEC_E4) == ExitSpec(rule="E4", margin_se=1.0)
    assert parse_exit(SPEC_E5) == ExitSpec(rule="E5", p_close=0.35, confirm_bars=3)
    assert parse_exit(parse_exit(SPEC_E5)) == parse_exit(SPEC_E5)
    assert parse_exit(parse_exit(SPEC_E4)) == parse_exit(SPEC_E4)
    for bad in (
        {"rule": "E4"},
        {"rule": "E4", "margin_se": 0},
        {"rule": "E4", "margin_se": float("nan")},
        {"rule": "E4", "margin_se": 1.0, "p_close": 0.4},
        {"rule": "E5", "p_close": 1.0, "confirm_bars": 3},
        {"rule": "E5", "p_close": 0.0, "confirm_bars": 3},
        {"rule": "E5", "margin_se": 1.0, "confirm_bars": 3},
        {"rule": "E5", "p_close": 0.4},  # confirm_bars is required
        {"rule": "E5", "confirm_bars": 3},
        {"rule": "E5", "p_close": 0.4, "confirm_bars": 0},
        {"rule": "E5", "p_close": 0.4, "confirm_bars": 2.5},
        {"rule": "E5", "p_close": 0.4, "confirm_bars": True},
        {"rule": "E4", "margin_se": 1.0, "confirm_bars": 3},
    ):
        with pytest.raises(ValueError):
            parse_exit(bad)


# ---------------------------------------------------------------------------
# Phase bars and the tau frame
# ---------------------------------------------------------------------------


def test_phase_bars_aggregate_exactly() -> None:
    rng = np.random.default_rng(1)
    n = 36  # three hours of 5m bars
    o = 100.0 + rng.normal(size=n)
    c = o + rng.normal(size=n)
    five = pd.DataFrame(
        {
            "t": B0 + np.arange(n, dtype=np.int64) * STEP_MS,
            "o": o,
            "h": np.maximum(o, c) + rng.random(n),
            "l": np.minimum(o, c) - rng.random(n),
            "c": c,
            "v": rng.uniform(1.0, 5.0, n),
            "tbv": rng.uniform(0.1, 1.0, n),
        }
    )
    missing_t = int(five["t"].iloc[17])
    five = five.drop(index=17).reset_index(drop=True)
    for phase in (0, 900_000, 1_800_000, 2_700_000):
        pb = phase_bars(five, HOUR, phase)
        starts = [B0 - HOUR + phase + k * HOUR for k in range(6)]
        want = []
        for tb in starts:
            sub = five[(five["t"] >= tb) & (five["t"] < tb + HOUR)]
            if len(sub) == 12:
                want.append(
                    (
                        tb,
                        sub["o"].iloc[0],
                        sub["h"].max(),
                        sub["l"].min(),
                        sub["c"].iloc[-1],
                        sub["v"].sum(),
                        sub["tbv"].sum(),
                    )
                )
        assert len(want) >= 1
        got = [tuple(r) for r in pb[["t", "o", "h", "l", "c", "v", "tbv"]].itertuples(index=False, name=None)]
        assert len(got) == len(want)
        for g, w in zip(got, want, strict=True):
            assert g[0] == w[0]
            np.testing.assert_allclose(g[1:], w[1:], rtol=0, atol=1e-12)
        # a missing 5m bar marks every phase bar that contains it as missing
        for t_b in pb["t"]:
            assert not (t_b <= missing_t < t_b + HOUR)
    # phase 0 and phase 30m: the hour holding bar 17 is missing and so are the two phase bars overlapping it
    assert len(phase_bars(five, HOUR, 0)) == 2
    with pytest.raises(ValueError):
        phase_bars(five, HOUR, 100_000)


def _build_for_causality(five, fifteen, four_h, one_d, prem, settle, btc5) -> pd.DataFrame:
    coin = {"5m": five, "15m": fifteen, "4h": four_h, "1d": one_d, "premium_5m": prem, "settlements": settle}
    return build_tau_frame(coin, btc5, HOUR)


def test_tau_frame_causal() -> None:
    panel = _panel(2, 30, seed=11)
    d, btc = panel[UNIVERSE[1]], panel[UNIVERSE[0]]
    inputs = {
        "five": (d["5m"], STEP_MS),
        "fifteen": (d["15m"], 900_000),
        "four_h": (d["4h"], H4),
        "one_d": (d["1d"], DAY),
        "prem": (d["premium_5m"], STEP_MS),
        "settle": (d["settlements"], 0),
        "btc5": (btc["5m"], STEP_MS),
    }
    t_values = [B0 + 20 * DAY + 7 * HOUR + 900_000, B0 + 25 * DAY + 3 * HOUR, B0 + 27 * DAY + 13 * HOUR + 1_800_000]
    base = _build_for_causality(**{k: v[0] for k, v in inputs.items()})
    for t in t_values:
        assert t in base.index
        assert base.loc[t].notna().sum() > 25  # the check is not vacuous: most features exist at these instants
    assert_future_invariant(_build_for_causality, inputs, t_values, rng=np.random.default_rng(3))


def _build_for_causality_4h(five, fifteen, four_h, one_d, prem, settle, btc5) -> pd.DataFrame:
    coin = {"5m": five, "15m": fifteen, "4h": four_h, "1d": one_d, "premium_5m": prem, "settlements": settle}
    return build_tau_frame(coin, btc5, H4)


def test_tau_frame_causal_at_4h_with_nonzero_phases() -> None:
    """The exit block and the optional-stopping check run at 4h: 16 phases, shifted higher-timeframe lookups."""
    panel = _panel(2, 30, seed=11)
    d, btc = panel[UNIVERSE[1]], panel[UNIVERSE[0]]
    inputs = {
        "five": (d["5m"], STEP_MS),
        "fifteen": (d["15m"], 900_000),
        "four_h": (d["4h"], H4),
        "one_d": (d["1d"], DAY),
        "prem": (d["premium_5m"], STEP_MS),
        "settle": (d["settlements"], 0),
        "btc5": (btc["5m"], STEP_MS),
    }
    t_values = [
        B0 + 20 * DAY + H4 + 900_000,
        B0 + 25 * DAY + H4 + 3 * HOUR + 2_700_000,
        B0 + 27 * DAY + 2 * H4 + 1_800_000,
    ]
    base = _build_for_causality_4h(**{k: v[0] for k, v in inputs.items()})
    for t in t_values:
        assert t in base.index
        assert (t - B0) % H4 != 0  # a non-zero phase of the 4h interval
        assert base.loc[t].notna().sum() > 25  # the check is not vacuous
    assert_future_invariant(_build_for_causality_4h, inputs, t_values, rng=np.random.default_rng(3))


def test_tau_frame_union_covers_every_15m_instant() -> None:
    panel = _panel(2, 12, seed=5)
    d, btc = panel[UNIVERSE[1]], panel[UNIVERSE[0]]
    fr = build_tau_frame(d, btc["5m"], H4)
    assert str(fr.dtypes.unique()[0]) == "float32"
    t = fr.index.to_numpy()
    assert (np.diff(t) == 900_000).all()  # 16 phases of the 4h interval tile the 15m grid
    assert len(t) == (12 * DAY - H4) // 900_000 + 1


def test_tau_cache_roundtrip(tmp_path: Path) -> None:
    panel = _panel(2, 6, seed=6)
    d, btc = panel[UNIVERSE[1]], panel[UNIVERSE[0]]
    calls: list[int] = []

    def build() -> pd.DataFrame:
        calls.append(1)
        return build_tau_frame(d, btc["5m"], HOUR)

    first = cached_tau_frame("ETHUSDT", "1h", build, tmp_path / "cache", "abc123")
    second = cached_tau_frame("ETHUSDT", "1h", build, tmp_path / "cache", "abc123")
    assert len(calls) == 1
    assert tau_cache_path(tmp_path / "cache", "abc123", "ETHUSDT", "1h").exists()
    assert tau_cache_path(tmp_path / "cache", "abc124", "ETHUSDT", "1h") != tau_cache_path(
        tmp_path / "cache", "abc123", "ETHUSDT", "1h"
    )
    pd.testing.assert_frame_equal(first, second)
    assert str(second.dtypes.unique()[0]) == "float32"
    ds = tmp_path / "ds"
    with pytest.raises(ValueError):
        cached_tau_frame("ETHUSDT", "1h", build, ds / "cache", "abc123", dataset_dir=ds)
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# Training samples
# ---------------------------------------------------------------------------


def test_label_hand_value() -> None:
    n = 20
    o = 100.0 + np.arange(n)
    bars = prepare_bars(
        {
            "X": pd.DataFrame(
                {"t": B0 + np.arange(n, dtype=np.int64) * STEP_MS, "o": o, "h": o + 1.5, "l": o - 1.0, "c": o + 0.5}
            )
        }
    )["X"]
    entry_ms = B0
    # one settlement inside (tau + 10m, S], one before tau + 10m, one after S
    st = np.array([entry_ms + 15 * 60_000, entry_ms + 30 * 60_000, entry_ms + 61 * 60_000], dtype=np.int64)
    sr = np.array([0.5, 0.001, 0.25])
    hp = hold_paths(bars, st, sr, np.array([0]), 12, np.array([[3]]))
    assert hp.elapsed[0, 0] == pytest.approx(3 / 12)
    assert hp.lr[0, 0] == pytest.approx(np.log(102.5 / 100.0))  # c of bar 2
    assert hp.mfe_long[0, 0] == pytest.approx(np.log(103.5 / 100.0))  # max high of bars 0..2 = 102 + 1.5
    assert hp.mae_long[0, 0] == pytest.approx(np.log(99.0 / 100.0))  # min low is bar 0's open - 1
    assert hp.core[0, 0] == pytest.approx(np.log(112.0 / 105.0))  # open(S) over open(tau + 10m) = bar 5
    assert hp.fund[0, 0] == pytest.approx(0.001)
    # a short sees the mirror image: y = s x core - s x funding
    for side in (1, -1):
        y = side * hp.core[0, 0] - side * hp.fund[0, 0]
        assert y == pytest.approx(side * (np.log(112.0 / 105.0) - 0.001))


@pytest.fixture(scope="module")
def small_factory() -> tuple[ExitModelFactory, int]:
    panel = _panel(3, 40, seed=21)
    fac = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7)
    return fac, B0 + 30 * DAY


def test_training_samples_side_symmetric(small_factory: tuple[ExitModelFactory, int]) -> None:
    fac, cut = small_factory
    ts = fac.training_set(None, cut)
    rows = ts.rows()
    assert ts.n_samples == len(rows) > 0
    assert (rows["side"] == 1).sum() == (rows["side"] == -1).sum()
    per_hold = rows.groupby(["symbol", "T", "side"]).size()
    assert (per_hold == 4).all()
    assert (rows["S"] < cut).all()
    # four distinct tau per hold, all on the 5m grid inside (T + 10m, S - 10m]
    assert (rows["tau"] % STEP_MS == 0).all()
    assert (rows["tau"] > rows["T"] + ENTRY_DELAY_MS).all() and (rows["tau"] <= rows["S"] - 2 * STEP_MS).all()
    assert rows.groupby(["symbol", "T", "side"])["tau"].nunique().eq(4).all()
    # the purge bites: a later cut admits more holds, and nothing past the early cut is in the early set
    later = fac.training_set(None, cut + 5 * DAY)
    assert later.n_samples > ts.n_samples
    assert (later.S >= cut).any()
    # the draws are seeded
    again = fac.training_set(None, cut)
    np.testing.assert_array_equal(again.tau, ts.tau)
    # a start bound drops earlier holds
    assert fac.training_set(B0 + 20 * DAY, cut).n_samples < ts.n_samples


def test_training_sample_state_matches_label_arithmetic(small_factory: tuple[ExitModelFactory, int]) -> None:
    fac, cut = small_factory
    ts = fac.training_set(None, cut)
    for side in (1, -1):
        st = ts.state_for(side)
        assert (st[:, 0] == side).all()
        assert (st[:, 3] >= 0).all() and (st[:, 4] <= 0).all()  # MFE >= 0 >= MAE for both sides
        assert ((st[:, 1] > 0) & (st[:, 1] < 1)).all()
    np.testing.assert_allclose(ts.label_for(-1), -ts.label_for(1))


def test_fit_below_min_samples_falls_back(small_factory: tuple[ExitModelFactory, int]) -> None:
    fac, _ = small_factory
    assert fac.fit(None, B0 + 12 * HOUR) is None  # nothing to learn from yet: the fold runs as E1
    assert MIN_SAMPLES == 1000


# ---------------------------------------------------------------------------
# Rules on stubbed models
# ---------------------------------------------------------------------------


class _StubPair:
    def __init__(self, se: float = 0.01):
        self.se = se

    def forecast(self, market: np.ndarray, state: np.ndarray) -> np.ndarray:
        return market[:, 0].copy()

    def prob_up(self, market: np.ndarray, state: np.ndarray) -> np.ndarray:
        return market[:, 0].copy()


class _StubInputs:
    def __init__(self, fn: Any):
        self.pair = _StubPair()
        self.fn = fn

    def market(self, symbol: str, tau_f: np.ndarray) -> np.ndarray:
        return np.asarray(self.fn(symbol, np.asarray(tau_f)), dtype=np.float64)[:, None]


def _flat_bars(n: int = 60) -> pd.DataFrame:
    o = 100.0 + 0.1 * np.arange(n)
    return pd.DataFrame(
        {"t": B0 + np.arange(n, dtype=np.int64) * STEP_MS, "o": o, "h": o + 0.2, "l": o - 0.2, "c": o + 0.05}
    )


def _entry_frame(symbols: list[str], side: int = 1, entry_i: int = 2, length: int = 12) -> pd.DataFrame:
    entry_ms = B0 + entry_i * STEP_MS
    return pd.DataFrame(
        {
            "symbol": symbols,
            "side": side,
            "T": B0,
            "entry_ms": entry_ms,
            "exit_ms": entry_ms + length * STEP_MS,
            "entry_price": 100.0 + 0.1 * entry_i,
        }
    )


def _replay_both(entries: pd.DataFrame, bars: dict[str, pd.DataFrame], spec: Any, inputs: Any) -> pd.DataFrame:
    fast = replay_exits(entries, bars, spec, lambda s, t: np.full(len(t), np.nan), models=inputs)
    slow = replay_by_steps(entries, bars, spec, lambda s, t: np.full(len(t), np.nan), models=inputs)
    pd.testing.assert_frame_equal(fast, slow)
    return fast


def _step_fn(first_bad_tau_f: int, good: float, bad: float):
    return lambda sym, tf: np.where(tf >= first_bad_tau_f, bad, good)


def test_e4_margin_rule() -> None:
    bars = {"X": _flat_bars()}
    ent = _entry_frame(["X"])
    o = bars["X"]["o"].to_numpy()
    # forecast -0.0101 against SE 0.01 x margin 1.0 closes at the first tau whose tau_f is B0 + 30m: tau = B0 + 30m
    out = _replay_both(ent, bars, SPEC_E4, _StubInputs(_step_fn(B0 + 30 * 60_000, -0.0099, -0.0101)))
    assert out["exit_reason"][0] == "model_exit" and out["exit_fill"][0] == "taker"
    assert out["exit_ms"][0] == B0 + 40 * 60_000  # the open at tau + 10m, stamped there
    assert out["exit_price"][0] == o[8]
    # exactly -1.0 x SE does not close (strict), a wider margin does not close either
    held = _replay_both(ent, bars, SPEC_E4, _StubInputs(_step_fn(B0 + 30 * 60_000, -0.0099, -0.01)))
    assert held["exit_reason"][0] == "horizon"
    wide = _replay_both(ent, bars, {"rule": "E4", "margin_se": 2.0}, _StubInputs(_step_fn(0, -0.0101, -0.0101)))
    assert wide["exit_reason"][0] == "horizon"
    # a trigger at tau = S - 10m has tau + 10m == S: it is the horizon exit, not a model exit
    edge = _replay_both(ent, bars, SPEC_E4, _StubInputs(_step_fn(B0 + 60 * 60_000, 0.0, -0.05)))
    assert edge["exit_reason"][0] == "horizon" and edge["exit_ms"][0] == ent["exit_ms"][0]
    # a trigger only after S - 10m is never scored
    late = _replay_both(ent, bars, SPEC_E4, _StubInputs(_step_fn(B0 + 75 * 60_000, 0.0, -0.05)))
    assert late["exit_reason"][0] == "horizon"
    # a short uses the same forecast (the model's output already carries the side)
    short = _replay_both(
        _entry_frame(["X"], side=-1), bars, SPEC_E4, _StubInputs(_step_fn(B0 + 30 * 60_000, 0.0, -0.05))
    )
    assert short["exit_reason"][0] == "model_exit"


def test_e5_threshold_rule() -> None:
    bars = {"X": _flat_bars()}
    ent = _entry_frame(["X"])
    out = _replay_both(ent, bars, SPEC_E5_SINGLE, _StubInputs(_step_fn(B0 + 30 * 60_000, 0.6, 0.399)))
    assert out["exit_reason"][0] == "model_exit" and out["exit_ms"][0] == B0 + 40 * 60_000
    held = _replay_both(ent, bars, SPEC_E5_SINGLE, _StubInputs(_step_fn(B0 + 30 * 60_000, 0.6, 0.4)))
    assert held["exit_reason"][0] == "horizon"  # P exactly 0.4 does not close
    other = _replay_both(
        ent, bars, {"rule": "E5", "p_close": 0.3, "confirm_bars": 1}, _StubInputs(_step_fn(0, 0.35, 0.35))
    )
    assert other["exit_reason"][0] == "horizon"


class _ElapsedPair:
    """P(y > 0) is low exactly at the checks whose k = elapsed x 12 is in `lows` (entry_i 3, length 12)."""

    se = 0.01

    def __init__(self, lows: set[int]):
        self.lows = lows

    def forecast(self, market: np.ndarray, state: np.ndarray) -> np.ndarray:
        return market[:, 0].copy()

    def prob_up(self, market: np.ndarray, state: np.ndarray) -> np.ndarray:
        k = np.rint(state[:, 1] * 12).astype(int)
        return np.where(np.isin(k, list(self.lows)), 0.1, 0.9)


class _ElapsedInputs:
    def __init__(self, lows: set[int]):
        self.pair = _ElapsedPair(lows)

    def market(self, symbol: str, tau_f: np.ndarray) -> np.ndarray:
        return np.ones((len(tau_f), 1))


def test_e5_requires_consecutive_confirmation() -> None:
    bars = {"X": _flat_bars()}
    ent = _entry_frame(["X"], entry_i=3)  # entry B0 + 15m, S = B0 + 75m; check k is at tau = entry + 5m x k
    o = bars["X"]["o"].to_numpy()
    spec = SPEC_E5  # P < 0.35 at 3 consecutive 5m closes
    two = _replay_both(ent, bars, spec, _ElapsedInputs({3, 4}))
    assert two["exit_reason"][0] == "horizon"
    # 3 consecutive lows at k = 3, 4, 5: confirmed at the third close tau = B0 + 15m + 25m, the fill is at tau + 10m
    three = _replay_both(ent, bars, spec, _ElapsedInputs({3, 4, 5}))
    assert three["exit_reason"][0] == "model_exit" and three["exit_fill"][0] == "taker"
    assert three["exit_ms"][0] == B0 + 50 * 60_000
    assert three["exit_price"][0] == o[10]
    # lows broken by a high are not consecutive: 3, 4, 6, 7 never reaches three in a row
    broken = _replay_both(ent, bars, spec, _ElapsedInputs({3, 4, 6, 7}))
    assert broken["exit_reason"][0] == "horizon"
    # a longer run closes at the third bar of the run, not the first
    run = _replay_both(ent, bars, spec, _ElapsedInputs({2, 3, 4, 5, 6}))
    assert run["exit_ms"][0] == B0 + 45 * 60_000
    # a run whose third bar is not scored (tau + 10m > S) never closes: k = 9, 10, 11
    late = _replay_both(ent, bars, spec, _ElapsedInputs({9, 10, 11}))
    assert late["exit_reason"][0] == "horizon"
    # confirm_bars 1 is the old single-bar rule
    one = _replay_both(ent, bars, {"rule": "E5", "p_close": 0.35, "confirm_bars": 1}, _ElapsedInputs({4}))
    assert one["exit_reason"][0] == "model_exit" and one["exit_ms"][0] == B0 + 45 * 60_000


def test_e5_missing_feature_resets_count() -> None:
    bars = {"X": _flat_bars()}
    ent = _entry_frame(["X"], entry_i=3)
    always_low = lambda sym, tf: np.full(len(tf), 0.1)  # noqa: E731
    clean = _replay_both(ent, bars, SPEC_E5, _StubInputs(always_low))
    assert clean["exit_reason"][0] == "model_exit" and clean["exit_ms"][0] == B0 + 40 * 60_000  # k = 3
    assert not clean["missing_model"][0]
    # tau_f = B0 + 30m covers the checks k = 3, 4, 5: the run (k = 1, 2) is reset, the run restarts at k = 6 and is
    # confirmed at k = 8 (tau = B0 + 55m), filled at tau + 10m
    gap = lambda sym, tf: np.where(tf == B0 + 30 * 60_000, np.nan, 0.1)  # noqa: E731
    out = _replay_both(ent, bars, SPEC_E5, _StubInputs(gap))
    assert out["exit_reason"][0] == "model_exit" and out["exit_ms"][0] == B0 + 65 * 60_000
    assert out["missing_model"][0]


def test_missing_feature_holds_and_counts() -> None:
    bars = {"A": _flat_bars(), "B": _flat_bars(), "C": _flat_bars()}
    ent = _entry_frame(["A", "B", "C"])

    def fn(sym: str, tf: np.ndarray) -> np.ndarray:
        bad = np.where(tf >= B0 + 45 * 60_000, -0.05, 0.0)
        if sym == "A":  # NaN for tau_f in [30m, 45m), then the trigger: held through the gap, closes at 45m
            return np.where((tf >= B0 + 30 * 60_000) & (tf < B0 + 45 * 60_000), np.nan, bad)
        if sym == "B":  # never any feature
            return np.full(len(tf), np.nan)
        return bad  # C: nothing missing, closes at 45m

    out = _replay_both(ent, bars, SPEC_E4, _StubInputs(fn))
    assert out["missing_model"].tolist() == [True, True, False]
    assert out["exit_reason"].tolist() == ["model_exit", "horizon", "model_exit"]
    assert out["exit_ms"][0] == out["exit_ms"][2] == B0 + 55 * 60_000
    # NaN at the trigger bar itself: the missing tau holds, and the flag counts it
    ctx = ExitContext({"A": bars["A"]}, 3_600_000)
    ctx.set_models(_StubInputs(fn))
    ctx.replay(ent.iloc[[0]], parse_exit(SPEC_E4))
    assert ctx.missing_model == 1 and ctx.reasons["model_exit"] == 1


def test_context_requires_models_or_explicit_fallback() -> None:
    bars = {"X": _flat_bars()}
    ctx = ExitContext(bars, 3_600_000)
    with pytest.raises(ValueError):
        ctx.replay(_entry_frame(["X"]), parse_exit(SPEC_E4))
    ctx.set_models(None)  # the fold fitted nothing: E1
    out = ctx.replay(_entry_frame(["X"]), parse_exit(SPEC_E4))
    assert out["exit_reason"][0] == "horizon" and ctx.fallback_tranches == 1


def test_init_state_needs_entry_ms_for_model_exits() -> None:
    with pytest.raises(ValueError):
        init_state(parse_exit(SPEC_E4), 1, 100.0, B0 + HOUR, math_nan())
    st = init_state(parse_exit(SPEC_E4), 1, 100.0, B0 + HOUR, math_nan(), entry_ms=B0)
    assert st.entry_ms == B0 and st.mfe == 0.0 and st.mae == 0.0


def math_nan() -> float:
    return float("nan")


class _NonlinearPair:
    se = 0.004

    def forecast(self, market: np.ndarray, state: np.ndarray) -> np.ndarray:
        return 0.004 * market[:, 0] + 0.6 * state[:, 2] + 0.8 * state[:, 4] - 0.002 * state[:, 1] * state[:, 0]

    def prob_up(self, market: np.ndarray, state: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-400.0 * self.forecast(market, state)))


class _NonlinearInputs:
    pair = _NonlinearPair()

    def market(self, symbol: str, tau_f: np.ndarray) -> np.ndarray:
        phase = (np.asarray(tau_f) // 900_000 + len(symbol)) % 17
        v = np.sin(phase * 0.9)
        v = np.where(phase == 5, np.nan, v)
        return v[:, None]


def _random_world() -> tuple[dict[str, pd.DataFrame], pd.DataFrame]:
    rng = np.random.default_rng(9)
    n = 3 * 288
    bars = {}
    for sym in ("AAA", "BBBB"):
        r = rng.normal(0.0, 0.0012, n)
        c = 100.0 * np.exp(np.cumsum(r))
        o = np.concatenate(([100.0], c[:-1]))
        bars[sym] = pd.DataFrame(
            {
                "t": B0 + np.arange(n, dtype=np.int64) * STEP_MS,
                "o": o,
                "h": np.maximum(o, c) * (1 + rng.random(n) * 0.001),
                "l": np.minimum(o, c) * (1 - rng.random(n) * 0.001),
                "c": c,
            }
        )
    rows = []
    for _ in range(160):
        sym = str(rng.choice(["AAA", "BBBB"]))
        i = int(rng.integers(2, n - 60))
        length = int(rng.choice([12, 24, 48]))
        rows.append((sym, int(rng.choice([1, -1])), i, length))
    ent = pd.DataFrame(
        {
            "symbol": [r[0] for r in rows],
            "side": [r[1] for r in rows],
            "T": [B0 + (r[2] - 2) * STEP_MS for r in rows],
            "entry_ms": [B0 + r[2] * STEP_MS for r in rows],
            "exit_ms": [B0 + (r[2] + r[3]) * STEP_MS for r in rows],
            "entry_price": [float(bars[r[0]]["o"].iloc[r[2]]) for r in rows],
        }
    )
    return bars, ent


def test_step_equals_replay_e4_e5() -> None:
    bars, ent = _random_world()
    for spec in (SPEC_E4, SPEC_E5):
        out = _replay_both(ent, bars, spec, _NonlinearInputs())
        reasons = out["exit_reason"].value_counts()
        assert reasons.get("model_exit", 0) >= 10 and reasons.get("horizon", 0) >= 10, reasons.to_dict()
        assert out["missing_model"].any()
        assert (out.loc[out["exit_reason"] == "model_exit", "exit_fill"] == "taker").all()


def test_step_equals_replay_e5_confirm() -> None:
    bars, ent = _random_world()
    closes = {}
    for confirm in (1, 2, 3, 6):
        spec = {"rule": "E5", "p_close": 0.35, "confirm_bars": confirm}
        out = _replay_both(ent, bars, spec, _NonlinearInputs())  # step() and replay_exits() equal tranche for tranche
        closes[confirm] = int((out["exit_reason"] == "model_exit").sum())
        assert out["missing_model"].any()
    # a longer confirmation can only remove closes, and the loose settings still close some tranches
    assert closes[1] >= closes[2] >= closes[3] >= closes[6]
    assert closes[1] > closes[3] > 0, closes


# ---------------------------------------------------------------------------
# A planted reversal observable from taker flow halfway through the hold
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def planted() -> dict[str, Any]:
    panel, events = plant_events(_panel(4, 100, seed=31), seed=32)
    fac = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7)
    cut = B0 + 70 * DAY
    inputs = fac.fit(None, cut)
    assert inputs is not None
    bars = {s: panel[s]["5m"] for s in panel}
    parts = []
    for sym in panel:
        b = fac.bars(sym)
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
    e1 = replay_exits(ent, bars, "horizon", nan_sigma)
    e4 = replay_exits(ent, bars, SPEC_E4, nan_sigma, models=inputs)
    e5 = replay_exits(ent, bars, SPEC_E5, nan_sigma, models=inputs)
    return {"panel": panel, "events": events, "fac": fac, "inputs": inputs, "ent": ent, "e1": e1, "e4": e4, "e5": e5}


@pytest.mark.parametrize("rule", ["e4", "e5"])
def test_e4_closes_on_planted_reversal(planted: dict[str, Any], rule: str) -> None:
    ent, res, e1 = planted["ent"], planted[rule], planted["e1"]
    pl, un, drop_start = classify_events(ent, planted["events"])
    assert pl.sum() >= 100 and un.sum() >= 100
    closed = (res["exit_reason"] == "model_exit").to_numpy()
    ahead = closed & (res["exit_ms"].to_numpy() <= drop_start)
    planted_rate = float(ahead[pl].mean())
    false_rate = float(closed[un].mean())
    side = ent["side"].to_numpy()
    entry_px = ent["entry_price"].to_numpy()
    gross = lambda r: side * np.log(r["exit_price"].to_numpy() / entry_px)  # noqa: E731
    increment = float((gross(res) - gross(e1))[pl].mean())
    print(
        f"{rule}: planted close-ahead rate {planted_rate:.3f}, unplanted false-close rate {false_rate:.3f}, "
        f"increment vs E1 on planted {increment:.5f} (n planted {int(pl.sum())}, n unplanted {int(un.sum())})"
    )
    assert increment > 0.0
    assert planted_rate >= 0.80
    assert false_rate <= 0.20  # the registered false-close bound, for both rules


def test_e4_e5_diagnostic_runs_on_a_no_edge_panel() -> None:
    panel = _panel(3, 90, seed=41)
    fac = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7)
    inputs = fac.fit(None, B0 + 60 * DAY)
    assert inputs is not None
    ent_rows = []
    for sym in panel:
        b = fac.bars(sym)
        top = np.arange(B0 + 60 * DAY, B0 + 90 * DAY - 6 * HOUR, 2 * HOUR, dtype=np.int64)
        entry = top + ENTRY_DELAY_MS
        ent_rows.append(
            pd.DataFrame(
                {
                    "symbol": sym,
                    "side": 1,
                    "T": top,
                    "entry_ms": entry,
                    "exit_ms": entry + H4,
                    "entry_price": b.o[np.searchsorted(b.t, entry)],
                }
            )
        )
    ent = pd.concat(ent_rows, ignore_index=True)
    bars = {s: panel[s]["5m"] for s in panel}
    for spec in (SPEC_E4, SPEC_E5):
        out = replay_exits(ent, bars, spec, lambda s, t: np.full(len(t), np.nan), models=inputs)
        share = exit_hold_diagnostic(ent, out)
        print(f"hold diagnostic {spec['rule']}: median hold share of h = {share:.3f}")
        assert 0.0 < share <= 1.0
    assert np.isnan(exit_hold_diagnostic(ent.iloc[:0], out.iloc[:0]))


# ---------------------------------------------------------------------------
# walk_forward: one pair per fold, a counted fallback for a thin fold
# ---------------------------------------------------------------------------


def test_walk_forward_fits_per_fold_and_counts_fallback() -> None:
    panel = {UNIVERSE[0]: _panel(1, 100, seed=51)[UNIVERSE[0]]}
    cfg = RunConfig(
        family="A",
        model="ridge",
        params={},
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
    res = walk_forward(samples, cfg, first_refit_ms=B0 + 3 * DAY, end_ms=B0 + 96 * DAY, panel=panel)
    assert res.exit_model_fallback_folds >= 1  # the first fold trains on three days: too thin, run as E1
    assert res.exit_model_folds >= 1
    assert res.exit_model_fallback_tranches > 0
    assert len(res.tranches) > 0
    assert "model_exit" in {t.exit_reason for t in res.tranches} or res.exit_model_folds >= 1


# ---------------------------------------------------------------------------
# Scale
# ---------------------------------------------------------------------------


def _scale_job() -> None:
    """10 coins, 450 synthetic days, 1h: frames, fit and replay. Prints one JSON line with the stage times."""
    t_all = time.perf_counter()
    panel = _panel(10, 450, seed=61)
    fac = ExitModelFactory(panel, "1h", H4, FEATURES, seed=7)
    t = time.perf_counter()
    fac.frames()
    t_frames = time.perf_counter() - t
    t = time.perf_counter()
    inputs = fac.fit(None, B0 + 360 * DAY)
    t_fit = time.perf_counter() - t
    assert inputs is not None
    parts = []
    for i, sym in enumerate(panel):
        b = fac.bars(sym)
        top = np.arange(B0 + 30 * DAY, B0 + 450 * DAY - 6 * HOUR, HOUR, dtype=np.int64)
        entry = top + ENTRY_DELAY_MS
        parts.append(
            pd.DataFrame(
                {
                    "symbol": sym,
                    "side": 1 if i % 2 == 0 else -1,
                    "T": top,
                    "entry_ms": entry,
                    "exit_ms": entry + H4,
                    "entry_price": b.o[np.searchsorted(b.t, entry)],
                }
            )
        )
    ent = pd.concat(parts, ignore_index=True)
    bars = {s: panel[s]["5m"] for s in panel}
    t = time.perf_counter()
    out4 = replay_exits(ent, bars, SPEC_E4, lambda s, x: np.full(len(x), np.nan), models=inputs)
    out5 = replay_exits(ent, bars, SPEC_E5, lambda s, x: np.full(len(x), np.nan), models=inputs)
    t_replay = time.perf_counter() - t
    print(
        json.dumps(
            {
                "t_frames": t_frames,
                "t_fit": t_fit,
                "t_replay_e4_e5": t_replay,
                "t_total": time.perf_counter() - t_all,
                "n_train_samples": inputs.pair.n_samples,
                "n_entries": len(ent),
                "e4_closed": int((out4["exit_reason"] == "model_exit").sum()),
                "e5_closed": int((out5["exit_reason"] == "model_exit").sum()),
            }
        )
    )


@pytest.mark.slow
def test_e4_e5_scale() -> None:
    import resource

    root = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        [sys.executable, "-c", "from tests.test_exit_models import _scale_job; _scale_job()"],
        cwd=root,
        env={"PYTHONPATH": str(root), "PATH": "/usr/bin:/bin", "OMP_NUM_THREADS": "2"},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=3000,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    stats = json.loads(proc.stdout.strip().splitlines()[-1])
    peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    peak_gb = peak / (1024**3 if sys.platform == "darwin" else 1024**2)
    print(f"scale: {stats}, peak RSS {peak_gb:.2f} GB")
    assert peak_gb < 2.0
    assert stats["n_train_samples"] >= 100_000
    assert stats["n_entries"] > 50_000  # 10 coins x ~420 days of hourly entries, replayed under both rules


# ---------------------------------------------------------------------------
# CPCV: one exit-model pair per split, fitted on that split's own training instants
# ---------------------------------------------------------------------------


def test_cpcv_e4_uses_split_models(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from r4.cli import restrict_to_d, run_wf
    from r4.exits import ExitContext as Ctx
    from r4.method import CPCV_EMBARGO_MS, CPCV_GROUPS, CPCV_TEST_GROUPS
    from r4.validation import panel_cpcv_splits

    panel = _panel(4, 170, seed=71)
    ds = tmp_path / "ds"
    ds.mkdir()
    (ds / "manifest.json").write_text(
        json.dumps({"version": 1, "datasetHash": "synthetic71", "symbols": list(panel), "files": []}),
        encoding="utf-8",
    )
    raw = {
        "id": "cpcv_e4",
        "kind": "trial",
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": list(FEATURES),
        "interval": "1h",
        "h_ms": H4,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": SPEC_E4,
        "first_refit_ms": B0 + 60 * DAY,
        "seed": 7,
    }
    cfg_file = tmp_path / "cfg.json"
    cfg_file.write_text(json.dumps(raw), encoding="utf-8")

    events: list[tuple[str, Any, Any]] = []
    real_fit = ExitModelFactory.fit
    real_set = Ctx.set_models

    def spy_fit(self: ExitModelFactory, t_start: Any, cut_ms: int, select: Any = None) -> Any:
        out = real_fit(self, t_start, cut_ms, select)
        events.append(("fit", select, out))
        return out

    def spy_set(self: Ctx, models: Any) -> None:
        events.append(("set", None, models))
        real_set(self, models)

    monkeypatch.setattr(ExitModelFactory, "fit", spy_fit)
    monkeypatch.setattr(Ctx, "set_models", spy_set)
    receipt = run_wf(cfg_file, ds, tmp_path / "out", commit="abc1234", panel=panel)

    # the expected splits, rebuilt independently from the same samples
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
        exit=parse_exit(SPEC_E4),
        seed=7,
    )
    samples, _ = restrict_to_d(decision_samples(panel, cfg))
    splits = list(
        panel_cpcv_splits(
            samples["t0"].to_numpy(dtype=np.int64),
            samples["t1_max"].to_numpy(dtype=np.int64),
            n_groups=CPCV_GROUPS,
            n_test_groups=CPCV_TEST_GROUPS,
            embargo_ms=CPCV_EMBARGO_MS,
        )
    )
    cpcv_fits = [e for e in events if e[0] == "fit" and e[1] is not None]
    assert len(cpcv_fits) == len(splits) == 15  # one fit per split, in split order
    probe = np.unique(samples["T"].to_numpy(dtype=np.int64))
    probe_s = probe + ENTRY_DELAY_MS + H4
    for (_, select, _out), (train_idx, test_list) in zip(cpcv_fits, splits, strict=True):
        train_t = samples.iloc[train_idx]["T"].to_numpy(dtype=np.int64)
        got = np.asarray(select(probe, probe_s), dtype=bool)
        np.testing.assert_array_equal(got, np.isin(probe, train_t))
        test_t = samples.iloc[np.concatenate(test_list)]["T"].to_numpy(dtype=np.int64)
        assert not got[np.isin(probe, test_t)].any()  # a test instant is never trained on
    # every CPCV replay used one of the split pairs (or the counted E1 fallback), and every pair was used
    first = events.index(cpcv_fits[0])
    split_models = [e[2] for e in cpcv_fits]
    used = [e[2] for e in events[first:] if e[0] == "set"]
    assert used and all(u is None or any(u is m for m in split_models) for u in used)
    assert all(m is None or any(m is u for u in used) for m in split_models)
    fallback = sum(m is None for m in split_models)
    assert receipt["metrics"]["cpcv_exit_model_fallback_splits"] == fallback
    assert len(receipt["metrics"]["cpcv_path_means"]) == 5  # item 1's CPCV paths all completed
    assert fallback < len(splits)
