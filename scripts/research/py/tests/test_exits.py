"""Tests for r4.exits: the bar-by-bar exit state machine (E1, E2, E3, X1) and its vectorised replay."""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4.book import daily_book
from r4.exits import (
    Bar,
    Close,
    ExitSpec,
    ExitState,
    SigmaTable,
    StepCtx,
    init_state,
    make_sigma_at,
    parse_exit,
    replay_by_steps,
    replay_exits,
    step,
)
from r4.method import ENTRY_DELAY_MS, UNIVERSE
from r4.pipeline import RunConfig, _make_tranches, decision_samples
from tests.test_cli_bar import (
    COMMIT,
    _create_synthetic_dataset_dir,
    _make_fast_synthetic_panel,
)

STEP_MS = 300_000
T0 = 1_672_531_200_000  # 2023-01-01 UTC
SYM = "BTCUSDT"


def _bars(rows: list[tuple[float, float, float, float]], t0: int = T0) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "t": t0 + np.arange(len(rows), dtype=np.int64) * STEP_MS,
            "o": [r[0] for r in rows],
            "h": [r[1] for r in rows],
            "l": [r[2] for r in rows],
            "c": [r[3] for r in rows],
        }
    )


def _const_sigma(value: float):
    def sigma_at(symbol: str, times: np.ndarray) -> np.ndarray:
        return np.full(len(np.atleast_1d(times)), value, dtype=np.float64)

    return sigma_at


def _entry(side: int, n_bars: int, price: float, entry_i: int = 0, t0: int = T0) -> pd.DataFrame:
    """One entry at bar index entry_i, scheduled to exit at the open of bar index n_bars."""
    entry_ms = t0 + entry_i * STEP_MS
    return pd.DataFrame(
        {
            "symbol": [SYM],
            "side": [side],
            "T": [entry_ms - ENTRY_DELAY_MS],
            "entry_ms": [entry_ms],
            "exit_ms": [t0 + n_bars * STEP_MS],
            "entry_price": [price],
        }
    )


def _run(spec, side: int, rows: list[tuple[float, float, float, float]], sigma=0.01, price: float | None = None):
    bars = _bars(rows)
    price = rows[0][0] if price is None else price
    sigma_at = sigma if callable(sigma) else _const_sigma(sigma)
    out = replay_exits(_entry(side, len(rows) - 1, price), {SYM: bars}, spec, sigma_at)
    return out.iloc[0], bars


# ---------------------------------------------------------------------------
# Spec parsing
# ---------------------------------------------------------------------------


def test_parse_exit_accepts_the_four_forms_and_rejects_the_rest():
    assert parse_exit("horizon") == ExitSpec(rule="E1")
    assert parse_exit({"rule": "E2", "k": 1.0}) == ExitSpec(rule="E2", k=1.0)
    assert parse_exit({"rule": "E3", "k": 2.0}) == ExitSpec(rule="E3", k=2.0)
    assert parse_exit({"rule": "X1", "n_bars": 3}) == ExitSpec(rule="X1", n_bars=3)
    for bad in (
        "E2",
        {"rule": "E4", "k": 1.0},
        {"rule": "E1"},
        {"rule": "E2"},
        {"rule": "E2", "k": 1.0, "n_bars": 3},
        {"rule": "E3", "k": -1.0},
        {"rule": "X1", "n_bars": 0},
        {"rule": "X1", "n_bars": 2.5},
        {"rule": "E2", "k": 1.0, "extra": 1},
        7,
    ):
        with pytest.raises(ValueError):
            parse_exit(bad)


# ---------------------------------------------------------------------------
# E1 through the engine equals today's vectorised horizon tranches
# ---------------------------------------------------------------------------


def _horizon_cfg(**over) -> RunConfig:
    base = {
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ("ret_1", "ret_4"),
        "interval": "1h",
        "h_ms": 14_400_000,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0001,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "seed": 7,
    }
    base.update(over)
    return RunConfig(**base)


def test_e1_through_engine_equals_vectorised_horizon():
    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=40, seed=3, inject_signal=True)
    cfg = _horizon_cfg()
    samples = decision_samples(panel, cfg)
    rng = np.random.default_rng(0)
    sides = rng.choice([-1, 0, 1], size=len(samples)).astype(np.int64)
    expected = _make_tranches(samples, sides, cfg)
    assert len(expected) > 100

    entries = pd.DataFrame(
        {
            "symbol": [t.symbol for t in expected],
            "side": [t.side_val for t in expected],
            "T": [t.entry_ms - ENTRY_DELAY_MS for t in expected],
            "entry_ms": [t.entry_ms for t in expected],
            "exit_ms": [t.exit_ms for t in expected],
            "entry_price": [t.entry_price for t in expected],
        }
    )
    five_min = {s: panel[s]["5m"] for s in panel}
    out = replay_exits(entries, five_min, "horizon", make_sigma_at(five_min, cfg.h_ms))
    assert out["exit_ms"].tolist() == [t.exit_ms for t in expected]
    assert out["exit_price"].tolist() == [t.exit_price for t in expected]
    assert out["exit_fill"].tolist() == [t.exit_fill for t in expected]
    assert out["exit_reason"].tolist() == [t.exit_reason for t in expected]


# ---------------------------------------------------------------------------
# Hand paths: E2
# ---------------------------------------------------------------------------


def test_e2_stop_gap_fills_at_open():
    lo = 100.0 * np.exp(-0.01)
    rows = [
        (100.0, 100.5, 99.9, 100.2),
        (98.0, 98.5, 97.5, 98.0),  # gaps below the stop: fills at the open
        (98.0, 98.2, 97.9, 98.1),
        (98.1, 98.3, 98.0, 98.2),
    ]
    row, bars = _run({"rule": "E2", "k": 1.0}, 1, rows)
    assert 98.0 < lo
    assert row["exit_reason"] == "stop"
    assert row["exit_fill"] == "taker"
    assert row["exit_price"] == 98.0
    assert row["exit_ms"] == int(bars["t"].iloc[1]) + STEP_MS

    # A short gaps up through its stop and fills at the (worse) open.
    up = 100.0 * np.exp(0.01)
    rows_s = [(100.0, 100.1, 99.9, 100.0), (102.0, 102.5, 101.9, 102.2), (102.0, 102.1, 101.0, 101.5), (101.5, 1, 1, 1)]
    row, _ = _run({"rule": "E2", "k": 1.0}, -1, rows_s)
    assert 102.0 > up
    assert row["exit_reason"] == "stop" and row["exit_price"] == 102.0


def test_e2_tp_needs_strict_trade_through():
    up = float(100.0 * np.exp(0.01))
    rows = [
        (100.0, up, 99.9, 100.2),  # touches the take-profit exactly: no fill
        (100.2, up, 100.0, 100.4),  # touches again: no fill
        (100.4, np.nextafter(up, 1e9), 100.1, 100.6),  # trades through: fills at the level, maker
        (100.6, 100.7, 100.5, 100.6),
        (100.6, 100.7, 100.5, 100.6),
    ]
    row, bars = _run({"rule": "E2", "k": 1.0}, 1, rows)
    assert row["exit_reason"] == "take_profit"
    assert row["exit_fill"] == "maker"
    assert row["exit_price"] == up
    assert row["exit_ms"] == int(bars["t"].iloc[2]) + STEP_MS

    # With only touches the position runs to the horizon.
    row, _ = _run({"rule": "E2", "k": 1.0}, 1, rows[:2] + [(100.4, up, 100.1, 100.6), (100.6, 100.7, 100.5, 100.6)])
    assert row["exit_reason"] == "horizon" and row["exit_fill"] == "taker"


def test_e2_tie_books_stop():
    up = float(100.0 * np.exp(0.01))
    lo = float(100.0 * np.exp(-0.01))
    rows = [
        (100.0, up * 1.01, lo * 0.99, 100.0),  # trades through both barriers
        (100.0, 100.1, 99.9, 100.0),
        (100.0, 100.1, 99.9, 100.0),
    ]
    row, _ = _run({"rule": "E2", "k": 1.0}, 1, rows)
    assert row["exit_reason"] == "stop"
    assert row["exit_price"] == lo  # the worse of the level and the open (100.0)
    row, _ = _run({"rule": "E2", "k": 1.0}, -1, rows)
    assert row["exit_reason"] == "stop"
    assert row["exit_price"] == up


# ---------------------------------------------------------------------------
# Hand paths: E3
# ---------------------------------------------------------------------------


def test_e3_trail_uses_previous_bar_then_updates():
    trail_1 = float(102.0 * np.exp(-0.01))  # set from bar 0's high, in force on bar 1
    rows = [
        (100.0, 102.0, 100.0, 101.5),
        (101.5, 103.0, 100.5, 102.5),  # makes a new high AND touches the old trail
        (102.5, 103.0, 102.0, 102.8),
        (102.8, 103.0, 102.5, 102.9),
    ]
    row, bars = _run({"rule": "E3", "k": 1.0}, 1, rows)
    assert row["exit_reason"] == "stop"
    assert row["exit_fill"] == "taker"
    assert row["exit_price"] == trail_1
    assert row["exit_ms"] == int(bars["t"].iloc[1]) + STEP_MS

    # Mirror for a short: the trail comes from bar 0's low.
    trail_s = float(98.0 * np.exp(0.01))
    rows_s = [
        (100.0, 100.0, 98.0, 98.5),
        (98.5, 99.5, 97.0, 97.5),  # new low and touches the old trail
        (97.5, 98.0, 97.0, 97.8),
        (97.8, 98.0, 97.5, 97.9),
    ]
    row, _ = _run({"rule": "E3", "k": 1.0}, -1, rows_s)
    assert row["exit_reason"] == "stop" and row["exit_price"] == trail_s


def test_e3_never_loosens():
    t_switch = T0 + 2 * STEP_MS

    def sigma_at(symbol: str, times: np.ndarray) -> np.ndarray:
        return np.where(np.asarray(times) < t_switch, 0.01, 0.05).astype(np.float64)

    tight = float(110.0 * np.exp(-0.01))
    loose = float(110.0 * np.exp(-0.05))
    rows = [
        (100.0, 110.0, 100.0, 110.0),
        (110.0, 110.0, 109.5, 110.0),  # above the tight trail
        (109.0, 109.0, 108.0, 108.5),  # between the loosened and the tight trail
        (108.5, 109.0, 108.0, 108.7),
    ]
    row, bars = _run({"rule": "E3", "k": 1.0}, 1, rows, sigma=sigma_at)
    assert loose < 108.0 < tight
    assert row["exit_reason"] == "stop"
    assert row["exit_price"] == tight
    assert row["exit_ms"] == int(bars["t"].iloc[2]) + STEP_MS


# ---------------------------------------------------------------------------
# Hand paths: X1
# ---------------------------------------------------------------------------


def test_x1_fills_maker_or_falls_back():
    # Schedule exit at bar 6, n_bars 3: the order rests from bar 3 at bar 3's open.
    base = [(100.0, 100.4, 99.6, 100.0)] * 3
    rows_fill = [
        *base,
        (100.0, 100.0, 99.8, 99.9),
        (99.9, 100.3, 99.7, 100.1),
        (100.1, 100.2, 100.0, 100.1),
        (100.1, 100.2, 100.0, 100.0),
    ]
    row, bars = _run({"rule": "X1", "n_bars": 3}, 1, rows_fill)
    assert row["exit_reason"] == "maker_exit"
    assert row["exit_fill"] == "maker"
    assert row["exit_price"] == 100.0  # the open of bar 3
    assert row["exit_ms"] == int(bars["t"].iloc[4]) + STEP_MS  # bar 4 trades through (strictly above)

    # Bars before the resting window may trade through L without a fill.
    # Never strictly above: the schedule exit at the bar-6 open as taker.
    rows_no = [
        *base,
        (100.0, 100.0, 99.8, 99.9),
        (99.9, 100.0, 99.7, 99.8),
        (99.8, 100.0, 99.7, 99.9),
        (99.7, 99.8, 99.6, 99.7),
    ]
    row, bars = _run({"rule": "X1", "n_bars": 3}, 1, rows_no)
    assert row["exit_reason"] == "horizon" and row["exit_fill"] == "taker"
    assert row["exit_price"] == 99.7 and row["exit_ms"] == int(bars["t"].iloc[6])

    # A short rests a buy limit and needs a strict trade-through below L.
    rows_short = [
        *base,
        (100.0, 100.2, 100.0, 100.1),
        (100.1, 100.3, 100.0, 100.2),
        (100.2, 100.3, 99.9, 100.0),
        (100.0, 100.1, 99.9, 100.0),
    ]
    row, bars = _run({"rule": "X1", "n_bars": 3}, -1, rows_short)
    assert row["exit_reason"] == "maker_exit" and row["exit_price"] == 100.0
    assert row["exit_ms"] == int(bars["t"].iloc[5]) + STEP_MS


def test_missing_sigma_holds_and_counts():
    crash = [
        (100.0, 100.1, 99.9, 100.0),
        (100.0, 100.0, 80.0, 85.0),
        (85.0, 86.0, 84.0, 85.0),
        (85.0, 86.0, 84.0, 85.0),
    ]
    nan_sigma = _const_sigma(float("nan"))
    for spec in ({"rule": "E2", "k": 1.0}, {"rule": "E3", "k": 1.0}):
        row, bars = _run(spec, 1, crash, sigma=nan_sigma)
        assert row["exit_reason"] == "horizon"
        assert row["exit_price"] == 85.0
        assert bool(row["missing_sigma"]) is True
    # With a sigma the same path is stopped, and nothing is counted.
    row, _ = _run({"rule": "E3", "k": 1.0}, 1, crash)
    assert row["exit_reason"] == "stop" and bool(row["missing_sigma"]) is False
    # X1 and E1 never need a sigma.
    row, _ = _run({"rule": "X1", "n_bars": 1}, 1, crash, sigma=nan_sigma)
    assert bool(row["missing_sigma"]) is False


def test_scheduled_exit_wins_its_bar():
    spec = parse_exit({"rule": "E2", "k": 1.0})
    state = init_state(spec, 1, 100.0, T0 + 5 * STEP_MS, 0.01)
    breach = Bar(t=T0 + 5 * STEP_MS, o=99.5, h=101.0, l=50.0, c=60.0)
    _, action = step(state, breach, StepCtx(sigma_open=0.01))
    assert action == Close("horizon", 99.5, "taker", T0 + 5 * STEP_MS)

    rows = [(100.0, 100.2, 99.9, 100.0)] * 5 + [(99.5, 101.0, 50.0, 60.0)]
    row, bars = _run({"rule": "E2", "k": 1.0}, 1, rows)
    assert row["exit_reason"] == "horizon" and row["exit_price"] == 99.5
    assert row["exit_ms"] == int(bars["t"].iloc[5])


# ---------------------------------------------------------------------------
# Property: step() over each tranche's bars equals replay_exits(), tranche for tranche
# ---------------------------------------------------------------------------


def _random_world(seed: int, n_tranches: int = 500):
    rng = np.random.default_rng(seed)
    n = 600
    ret = rng.normal(0.0, 0.0015, size=n) * np.exp(rng.normal(0.0, 0.7, size=n))
    c = 100.0 * np.exp(np.cumsum(ret))
    o = np.concatenate(([100.0], c[:-1]))
    jump = rng.random(n) < 0.03
    o = np.where(jump, o * np.exp(rng.normal(0.0, 0.01, size=n)), o)
    # A third of the bars have no wick on a side, so strict trade-through ties (h == o) occur.
    h = np.maximum(o, c) * (1.0 + np.abs(rng.normal(0.0, 0.002, size=n)) * (rng.random(n) > 0.35))
    l = np.minimum(o, c) * (1.0 - np.abs(rng.normal(0.0, 0.002, size=n)) * (rng.random(n) > 0.35))
    t = T0 + np.arange(n, dtype=np.int64) * STEP_MS
    keep = rng.random(n) > 0.02  # a few missing bars
    bars = pd.DataFrame({"t": t, "o": o, "h": h, "l": l, "c": c})
    sigma_arr = np.abs(rng.normal(0.012, 0.006, size=n))
    sigma_arr[rng.random(n) < 0.05] = np.nan
    entry_i = rng.integers(0, n - 80, size=n_tranches)
    length = rng.integers(2, 60, size=n_tranches)
    keep[entry_i + length] = True  # the scheduled bar always exists
    bars = bars[keep].reset_index(drop=True)
    sigma_by_t = dict(zip(t.tolist(), sigma_arr.tolist(), strict=True))

    def sigma_at(symbol: str, times: np.ndarray) -> np.ndarray:
        return np.array([sigma_by_t.get(int(x), np.nan) for x in np.atleast_1d(times)], dtype=np.float64)

    present = set(bars["t"].tolist())
    keep_rows = np.array([int(T0 + (i) * STEP_MS) in present for i in entry_i])
    entry_i, length = entry_i[keep_rows], length[keep_rows]
    t_by = dict(zip(t.tolist(), o.tolist(), strict=True))
    entry_ms = T0 + entry_i * STEP_MS
    side = rng.choice([-1, 1], size=len(entry_i))
    entries = pd.DataFrame(
        {
            "symbol": SYM,
            "side": side,
            "T": entry_ms - ENTRY_DELAY_MS,
            "entry_ms": entry_ms,
            "exit_ms": entry_ms + length * STEP_MS,
            "entry_price": [t_by[int(x)] for x in entry_ms],
        }
    )
    return entries, bars, sigma_at


@pytest.mark.parametrize(
    "spec",
    [
        "horizon",
        {"rule": "E2", "k": 0.5},
        {"rule": "E2", "k": 1.5},
        {"rule": "E3", "k": 0.5},
        {"rule": "E3", "k": 2.0},
        {"rule": "X1", "n_bars": 1},
        {"rule": "X1", "n_bars": 3},
    ],
)
def test_step_equals_replay_property(spec):
    entries, bars, sigma_at = _random_world(seed=11)
    assert (entries["side"] == 1).any() and (entries["side"] == -1).any()
    fast = replay_exits(entries, {SYM: bars}, spec, sigma_at)
    slow = replay_by_steps(entries, {SYM: bars}, spec, sigma_at)
    pd.testing.assert_frame_equal(fast, slow, check_exact=True)
    if spec != "horizon":
        counts = fast["exit_reason"].value_counts().to_dict()
        assert counts.get("horizon", 0) > 0 and sum(v for k, v in counts.items() if k != "horizon") > 0, counts


def test_stamps_on_grid():
    entries, bars, sigma_at = _random_world(seed=5)
    for spec in ({"rule": "E2", "k": 0.5}, {"rule": "E3", "k": 0.5}, {"rule": "X1", "n_bars": 4}):
        out = replay_exits(entries, {SYM: bars}, spec, sigma_at)
        assert (out["exit_ms"].to_numpy() % STEP_MS == 0).all()
        assert (out["exit_ms"].to_numpy() <= entries["exit_ms"].to_numpy()).all()
        assert (out["exit_ms"].to_numpy() > entries["entry_ms"].to_numpy()).all()


# ---------------------------------------------------------------------------
# Sigma table equals labels.trailing_sigma_h
# ---------------------------------------------------------------------------


def test_sigma_table_matches_trailing_sigma_h():
    from r4.labels import trailing_sigma_h

    rng = np.random.default_rng(3)
    n = 288 * 3
    c = 100.0 * np.exp(np.cumsum(rng.normal(0.0, 0.001, size=n)))
    o = np.concatenate(([100.0], c[:-1]))
    bars = pd.DataFrame({"t": T0 + np.arange(n, dtype=np.int64) * STEP_MS, "o": o, "h": c, "l": c, "c": c})
    bars = bars.drop(index=[400]).reset_index(drop=True)  # one missing bar poisons the windows that contain it
    h_ms = 14_400_000
    table = make_sigma_at({SYM: bars}, h_ms)
    assert isinstance(make_sigma_at({SYM: bars}, h_ms), SigmaTable)
    taus = T0 + np.arange(0, n + 1, 7, dtype=np.int64) * STEP_MS
    got = table(SYM, taus)
    want = trailing_sigma_h(taus, bars, h_ms).to_numpy()
    both_nan = np.isnan(got) & np.isnan(want)
    assert (np.isnan(got) == np.isnan(want)).all()
    np.testing.assert_allclose(got[~both_nan], want[~both_nan], rtol=1e-12)
    assert np.isnan(table("UNKNOWN", taus)).all()


# ---------------------------------------------------------------------------
# End to end: run_wf with E3
# ---------------------------------------------------------------------------


def test_run_wf_with_e3_end_to_end(tmp_path: Path):
    from r4.cli import config_hash_of, run_wf

    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=10, inject_signal=True)
    ds_dir = _create_synthetic_dataset_dir(tmp_path / "ds", panel)
    cfg_dict = {
        "id": "e3_run",
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
        "exit": {"rule": "E3", "k": 1.0},
        "first_refit_ms": 1680307200000,
        "seed": 7,
    }
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps(cfg_dict), encoding="utf-8")
    receipt = run_wf(cfg_file, ds_dir, tmp_path / "out", commit=COMMIT, panel=panel)

    m = receipt["metrics"]
    counts = m["exit_reason_counts"]
    tr = pd.read_parquet(tmp_path / "out" / "e3_run" / "tranches.parquet")
    assert counts["stop"] > 0 and counts["horizon"] > 0
    assert set(counts) <= {"horizon", "stop", "take_profit", "maker_exit"}
    assert sum(counts.values()) == len(tr)
    assert counts == tr["exit_reason"].value_counts().to_dict()
    assert m["missing_sigma_tranches"] >= 0
    assert receipt["config_hash"] == config_hash_of(cfg_dict)

    # Weights keep the configured h: a stopped tranche is shorter but weighs the same as a horizon one.
    stops = tr[tr["exit_reason"] == "stop"]
    held = stops["exit_ms"] - stops["entry_ms"]
    assert (held <= 14_400_000).all() and (held < 14_400_000).any()  # a stop never outlives the schedule
    assert (stops["h_ms"] == 14_400_000).all()

    # The book prices a stop at its own fill: the daily gross telescopes to weight x log(fill / entry).
    five_min = {s: panel[s]["5m"] for s in panel}
    settle = {s: panel[s]["settlements"] for s in panel}
    from r4.book import Tranche

    one = stops.iloc[0]
    tranche = Tranche(
        symbol=one["symbol"],
        side=int(one["side"]),
        entry_ms=int(one["entry_ms"]),
        exit_ms=int(one["exit_ms"]),
        entry_price=float(one["entry_price"]),
        exit_price=float(one["exit_price"]),
        interval=one["interval"],
        h_ms=int(one["h_ms"]),
        exit_fill=one["exit_fill"],
        exit_reason="stop",
    )
    book = daily_book([tranche], five_min, settle)
    want = tranche.weight * np.log(tranche.exit_price / tranche.entry_price)
    assert float(book["gross"].sum()) == pytest.approx(want, rel=1e-9, abs=1e-12)


def test_horizon_run_receipt_counts_only_horizon(tmp_path: Path):
    from r4.cli import run_wf

    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=10, inject_signal=True)
    ds_dir = _create_synthetic_dataset_dir(tmp_path / "ds", panel)
    cfg_dict = {
        "id": "h_run",
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
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps(cfg_dict), encoding="utf-8")
    receipt = run_wf(cfg_file, ds_dir, tmp_path / "out", commit=COMMIT, panel=panel)
    counts = receipt["metrics"]["exit_reason_counts"]
    assert set(counts) == {"horizon"} and counts["horizon"] > 0
    assert receipt["metrics"]["missing_sigma_tranches"] == 0


# ---------------------------------------------------------------------------
# Performance
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_replay_performance(capsys):
    """300,000 tranches of up to 288 bars in under 60 s on one core, for the heaviest rule (E3)."""
    rng = np.random.default_rng(1)
    n_bars = 288 * 400
    c = 100.0 * np.exp(np.cumsum(rng.normal(0.0, 0.0008, size=n_bars)))
    o = np.concatenate(([100.0], c[:-1]))
    h = np.maximum(o, c) * 1.0005
    low = np.minimum(o, c) * 0.9995
    bars = pd.DataFrame({"t": T0 + np.arange(n_bars, dtype=np.int64) * STEP_MS, "o": o, "h": h, "l": low, "c": c})
    five_min = {SYM: bars}
    n = 300_000
    entry_i = rng.integers(0, n_bars - 300, size=n)
    length = np.full(n, 288)
    entry_ms = T0 + entry_i * STEP_MS
    entries = pd.DataFrame(
        {
            "symbol": SYM,
            "side": rng.choice([-1, 1], size=n),
            "T": entry_ms - ENTRY_DELAY_MS,
            "entry_ms": entry_ms,
            "exit_ms": entry_ms + length * STEP_MS,
            "entry_price": o[entry_i],
        }
    )
    sigma_at = make_sigma_at(five_min, 86_400_000)
    sigma_at(SYM, np.array([T0 + 300 * STEP_MS]))  # build the table outside the timed region
    timings = {}
    for spec in ({"rule": "E2", "k": 1.0}, {"rule": "E3", "k": 1.0}, {"rule": "X1", "n_bars": 6}):
        start = time.perf_counter()
        out = replay_exits(entries, five_min, spec, sigma_at)
        timings[spec["rule"]] = time.perf_counter() - start
        assert len(out) == n
    with capsys.disabled():
        print(f"\nreplay_exits 300k tranches x 288 bars: {timings}")
    assert max(timings.values()) < 60.0


def test_exit_state_is_a_plain_dataclass():
    state = init_state(parse_exit({"rule": "X1", "n_bars": 2}), -1, 100.0, T0 + 10 * STEP_MS, 0.01)
    assert isinstance(state, ExitState)
    assert state.rest_from_ms == T0 + 8 * STEP_MS
