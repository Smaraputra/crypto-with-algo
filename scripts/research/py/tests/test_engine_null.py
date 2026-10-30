"""Tests for brief 25d: the joint-shift null that re-runs the exit engine from each shifted entry."""

from __future__ import annotations

import dataclasses
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4.book import DAY_MS, Tranche, netted_costs
from r4.costs import coin_slippage_bps, resolve_fee_profile
from r4.exits import ExitContext
from r4.method import UNIVERSE
from tests.test_cli_bar import (
    COMMIT,
    _create_synthetic_dataset_dir,
    _make_fast_synthetic_panel,
    _one_fold,
    _price,
    _pulse_panel,
    _pulse_tranches,
)

DAY = DAY_MS
H4 = 14_400_000
START = 1672531200000  # 2023-01-01 UTC
SYMS = UNIVERSE[:6]


def _ohlc(panel: dict) -> dict:
    """Add h, l, c (equal to o) to a pulse panel so the exit engine can read it."""
    out = {}
    for s, parts in panel.items():
        df = parts["5m"].copy()
        for col in ("h", "l", "c"):
            df[col] = df["o"]
        out[s] = {**parts, "5m": df}
    return out


def _ctx(panel: dict, h_ms: int = H4) -> ExitContext:
    return ExitContext({s: panel[s]["5m"] for s in panel}, h_ms)


def _const_sigma(ctx: ExitContext, value: float) -> None:
    ctx.sigma_at = lambda symbol, times: np.full(len(np.atleast_1d(times)), value, dtype=np.float64)  # type: ignore[assignment]


def _crash_panel(n_days: int, crash_day: int, crash_hour: float = 6.5) -> dict:
    """Six flat coins at 100. BTC has one crash bar (low 98) at crash_day, then trades at 99 until 08:00."""
    n_bars = n_days * 288
    t = START + np.arange(n_bars, dtype=np.int64) * 300_000
    panel = {}
    empty = pd.DataFrame({"t": np.empty(0, dtype=np.int64), "rate": np.empty(0, dtype=np.float64)})
    for s in SYMS:
        o = np.full(n_bars, 100.0)
        h = o.copy()
        low = o.copy()
        c = o.copy()
        if s == "BTCUSDT":
            k = crash_day * 288 + int(crash_hour * 12)
            low[k] = 98.0
            c[k] = 99.0
            end = crash_day * 288 + 8 * 12
            o[k + 1 : end] = 99.0
            h[k + 1 : end] = 99.0
            low[k + 1 : end] = 99.0
            c[k + 1 : end] = 99.0
        panel[s] = {
            "5m": pd.DataFrame({"t": t, "o": o, "h": h, "l": low, "c": c}),
            "settlements": empty,
            "funding": empty,
        }
    return panel


def _fee_rate(sym: str = "BTCUSDT") -> float:
    return resolve_fee_profile("standard", sym).taker_fee + coin_slippage_bps(sym) / 10000.0


# ---------------------------------------------------------------------------
# Draw for draw equality with the horizon null under E1
# ---------------------------------------------------------------------------


def test_engine_null_horizon_equals_current():
    from r4.bar import joint_shift_null, joint_shift_stats, make_exit_replay

    n_days = 100
    pulse_days = [8, 13, 21, 29, 40, 44, 55, 61, 69, 77, 84, 93]
    panel = _ohlc(_pulse_panel(START, n_days, pulse_days))
    tr = _pulse_tranches(panel, START, pulse_days)
    tr += [
        dataclasses.replace(t, symbol="ETHUSDT", side=-1, size=0.5, entry_price=_price(panel, "ETHUSDT", t.entry_ms))
        for t in _pulse_tranches(panel, START, [3, 17, 33, 52, 71], sym="ETHUSDT")
    ]
    tr = [
        dataclasses.replace(
            t, exit_price=_price(panel, t.symbol, t.exit_ms), entry_price=_price(panel, t.symbol, t.entry_ms)
        )
        for t in tr
    ]
    folds = [
        {"start_ms": START, "end_ms": START + 50 * DAY, "train_cut_ms": None, "betas": {s: 1.0 for s in UNIVERSE}},
        {
            "start_ms": START + 50 * DAY,
            "end_ms": START + n_days * DAY,
            "train_cut_ms": None,
            "betas": {"BTCUSDT": 0.4, "ETHUSDT": 1.3, **{s: 1.0 for s in UNIVERSE[2:]}},
        },
    ]
    end = START + n_days * DAY
    replay = make_exit_replay(_ctx(panel), "horizon")
    base = joint_shift_null(tr, panel, folds, START, end, n_draws=120, seed=3)
    eng = joint_shift_null(tr, panel, folds, START, end, n_draws=120, seed=3, exit_replay=replay)
    assert eng[0] == base[0]
    assert eng[1] == base[1]
    assert eng[2] == pytest.approx(base[2], abs=1e-12)
    assert eng[3] == base[3]
    s_base = joint_shift_stats(tr, panel, folds, START, end, n_draws=120, seed=3)
    s_eng = joint_shift_stats(tr, panel, folds, START, end, n_draws=120, seed=3, exit_replay=replay)
    np.testing.assert_allclose(s_eng.null_stats, s_base.null_stats, rtol=0, atol=1e-12)
    assert s_eng.total_dropped == s_base.total_dropped


# ---------------------------------------------------------------------------
# A stop is re-applied on the shifted path
# ---------------------------------------------------------------------------


def test_engine_null_reapplies_stop():
    from r4.bar import joint_shift_stats, make_exit_replay
    from r4.exits import parse_exit

    n_days = 60
    panel = _crash_panel(n_days, crash_day=40)
    entry = START + 10 * DAY + 6 * 3_600_000
    tr = [Tranche("BTCUSDT", 1, entry, entry + H4, 100.0, 100.0, "1h", H4, exit_reason="horizon")]
    ctx = _ctx(panel)
    _const_sigma(ctx, 0.01)
    replay = make_exit_replay(ctx, parse_exit({"rule": "E2", "k": 1.0}))
    folds = _one_fold(START, n_days)
    st = joint_shift_stats(tr, panel, folds, START, START + n_days * DAY, n_draws=400, seed=5, exit_replay=replay)
    assert 30 in set(st.shifts)
    rate = _fee_rate()
    stop_fill = 100.0 * np.exp(-0.01)
    r_ew = np.log(99.0 / 100.0) / 6.0
    want_stop = (np.log(stop_fill / 100.0) - 1.0 * r_ew) - 2.0 * rate
    hit = [i for i, s in enumerate(st.shifts) if s == 30]
    for i in hit:
        assert st.null_stats[i] == pytest.approx(want_stop, abs=1e-12)
    # Every other draw is a quiet horizon exit on a flat path: only the costs remain.
    quiet = [i for i, s in enumerate(st.shifts) if s != 30]
    for i in quiet:
        assert st.null_stats[i] == pytest.approx(-2.0 * rate, abs=1e-12)
    # Closing at its old hold instead would have given the flat horizon result, not the stop.
    assert want_stop != pytest.approx(-2.0 * rate, abs=1e-6)


# ---------------------------------------------------------------------------
# Netting is recomputed on the shifted, replayed set
# ---------------------------------------------------------------------------


def test_engine_null_recomputes_netting():
    from r4.bar import joint_shift_stats, make_exit_replay
    from r4.exits import parse_exit

    n_days = 60
    panel = _crash_panel(n_days, crash_day=40)
    e_a = START + 10 * DAY + 6 * 3_600_000
    e_b = e_a + H4  # B enters at A's scheduled exit: the two legs net at that instant
    tr = [
        Tranche("BTCUSDT", 1, e_a, e_a + H4, 100.0, 100.0, "1h", H4),
        Tranche("BTCUSDT", 1, e_b, e_b + H4, 100.0, 100.0, "1h", H4),
    ]
    ctx = _ctx(panel)
    _const_sigma(ctx, 0.01)
    replay = make_exit_replay(ctx, parse_exit({"rule": "E2", "k": 1.0}))
    st = joint_shift_stats(
        tr, panel, _one_fold(START, n_days), START, START + n_days * DAY, n_draws=400, seed=5, exit_replay=replay
    )
    rate = _fee_rate()
    # Quiet draws keep the netting: A's exit nets against B's entry, so each tranche pays one rate.
    quiet = [i for i, s in enumerate(st.shifts) if s != 30]
    assert quiet
    for i in quiet:
        assert st.null_stats[i] == pytest.approx(-rate, abs=1e-12)
    # On the crash draw A stops at 06:35, B still enters at 10:00: nothing nets, each pays two rates.
    hit = [i for i, s in enumerate(st.shifts) if s == 30]
    assert hit
    stop_ret = np.log(np.exp(-0.01)) - np.log(99.0 / 100.0) / 6.0
    want = (stop_ret - 2.0 * rate + (0.0 - 2.0 * rate)) / 2.0
    for i in hit:
        assert st.null_stats[i] == pytest.approx(want, abs=1e-12)
    # Reusing the observed allocation would have given the netted figure.
    reused = (stop_ret - rate + (0.0 - rate)) / 2.0
    assert want != pytest.approx(reused, abs=1e-6)


def test_vectorised_netting_equals_netted_costs():
    from r4.bar import _unit_costs

    rng = np.random.default_rng(4)
    n = 300
    syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    base = START
    rows = []
    for _ in range(n):
        e = base + int(rng.integers(0, 40)) * 300_000
        x = e + int(rng.integers(1, 4)) * 300_000
        side = int(rng.choice([-1, 1]))
        rows.append(
            Tranche(
                str(rng.choice(syms)),
                side,
                e,
                x,
                100.0,
                100.0,
                "1h",
                H4,
                size=float(rng.choice([0.5, 1.0])),
                entry_fill=str(rng.choice(["taker", "maker"])),
                exit_fill=str(rng.choice(["taker", "maker"])),
                exit_reason="stop",
                slippage_bps_override=None if rng.random() < 0.7 else 3.0,
                fee_profile=None if rng.random() < 0.8 else "standard",
            )
        )
    want = netted_costs(rows, "standard")
    got = _unit_costs(rows, "standard")
    w_abs = np.array([abs(t.weight) for t in rows])
    np.testing.assert_allclose(got * w_abs, want.tranche_cost, rtol=1e-12, atol=1e-15)


# ---------------------------------------------------------------------------
# E4 and E5 use the model of the fold holding the shifted entry
# ---------------------------------------------------------------------------


class _FakeCtx:
    """Records the models in force at each replay and closes every entry with a model-dependent price."""

    def __init__(self) -> None:
        self.models = None
        self.calls: list[tuple[object, pd.DataFrame]] = []

    def set_models(self, models) -> None:
        self.models = models

    def replay(self, entries: pd.DataFrame, spec) -> pd.DataFrame:
        self.calls.append((self.models, entries.copy()))
        mult = {"up": 1.01, "down": 0.99}[self.models]
        n = len(entries)
        return pd.DataFrame(
            {
                "exit_ms": entries["entry_ms"].to_numpy(dtype=np.int64) + 300_000,
                "exit_price": entries["entry_price"].to_numpy(dtype=np.float64) * mult,
                "exit_fill": np.full(n, "taker", dtype=object),
                "exit_reason": np.full(n, "model_exit", dtype=object),
            }
        )


def test_engine_null_uses_shifted_fold_model():
    from r4.bar import joint_shift_stats, make_exit_replay

    n_days = 100
    panel = _ohlc(_pulse_panel(START, n_days, []))
    entry = START + 10 * DAY + 6 * 3_600_000
    price = _price(panel, "BTCUSDT", entry)
    tr = [Tranche("BTCUSDT", 1, entry, entry + H4, price, price, "1h", H4)]
    split = START + 50 * DAY
    folds = [
        {"start_ms": START, "end_ms": split, "train_cut_ms": None, "betas": {s: 1.0 for s in UNIVERSE}},
        {"start_ms": split, "end_ms": START + n_days * DAY, "train_cut_ms": None, "betas": {s: 1.0 for s in UNIVERSE}},
    ]
    fake = _FakeCtx()
    requested: list[int] = []

    def fold_models(fold: dict) -> str:
        requested.append(int(fold["start_ms"]))
        return "up" if int(fold["start_ms"]) == START else "down"

    replay = make_exit_replay(fake, {"rule": "E4", "margin_se": 1.0}, folds=folds, fold_models=fold_models)
    st = joint_shift_stats(tr, panel, folds, START, START + n_days * DAY, n_draws=200, seed=2, exit_replay=replay)
    assert fake.calls
    for models, frame in fake.calls:
        in_first = (frame["entry_ms"] < split).to_numpy()
        assert in_first.all() if models == "up" else (~in_first).all()
    rate = _fee_rate()
    seen = set()
    for i, s in enumerate(st.shifts):
        e_sh = START + ((10 + s) % n_days) * DAY + 6 * 3_600_000
        r_ew_stat = 0.0  # flat panel with no pulses is a random walk: use the draw's own basket return
        # The basket hedge ends at the model exit stamp: rebuild it from the panel.
        stamp = e_sh + 300_000
        lr = [np.log(_price(panel, c, stamp) / _price(panel, c, e_sh)) for c in panel]
        r_ew_stat = float(np.mean(lr))
        mult = 1.01 if e_sh < split else 0.99
        want = np.log(mult) - r_ew_stat - 2.0 * rate
        if e_sh + H4 <= START + n_days * DAY:
            assert st.null_stats[i] == pytest.approx(want, abs=1e-10)
            seen.add(mult)
    assert seen == {1.01, 0.99}
    assert set(requested) == {START, split}


# ---------------------------------------------------------------------------
# Refusal without a replay is kept
# ---------------------------------------------------------------------------


def test_refusal_without_replay_kept():
    from r4.bar import joint_shift_null, make_exit_replay

    n_days = 100
    panel = _ohlc(_pulse_panel(START, n_days, []))
    entry = START + 10 * DAY + 6 * 3_600_000
    price = _price(panel, "BTCUSDT", entry)
    tr = [Tranche("BTCUSDT", 1, entry, entry + 3_600_000, price, price, "1h", H4, exit_reason="stop")]
    folds = _one_fold(START, n_days)
    end = START + n_days * DAY
    with pytest.raises(ValueError, match="exit-engine replay"):
        joint_shift_null(tr, panel, folds, START, end, n_draws=10, seed=3)
    # With a replay the same set runs.
    replay = make_exit_replay(_ctx(panel), "horizon")
    p, _drop, obs, shifts = joint_shift_null(tr, panel, folds, START, end, n_draws=10, seed=3, exit_replay=replay)
    assert 0.0 < p <= 1.0 and len(shifts) == 10 and np.isfinite(obs)
    # Horizon-only sets still run without one.
    horizon = [dataclasses.replace(tr[0], exit_reason="horizon")]
    joint_shift_null(horizon, panel, folds, START, end, n_draws=10, seed=3)


# ---------------------------------------------------------------------------
# From a run's outputs: the rebuilt replay
# ---------------------------------------------------------------------------


def test_build_exit_replay_from_run_outputs(tmp_path: Path):
    from r4.bar import build_exit_replay, item4, joint_shift_null
    from r4.cli import run_wf

    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=10, inject_signal=True)
    ds_dir = _create_synthetic_dataset_dir(tmp_path / "ds", panel)
    cfg_dict = {
        "id": "e3_null",
        "kind": "trial",
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ["ret_1", "ret_4"],
        "interval": "1h",
        "h_ms": H4,
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
    run_dir = tmp_path / "out" / "e3_null"
    tranches = pd.read_parquet(run_dir / "tranches.parquet")
    folds = json.loads((run_dir / "folds.json").read_text(encoding="utf-8"))
    assert (tranches["exit_reason"] == "stop").any()

    replay = build_exit_replay(panel, receipt["config"], folds)
    first = receipt["config"]["first_refit_ms"]
    end = 1688169600000  # 2023-07-01
    p, drop, obs, shifts = joint_shift_null(tranches, panel, folds, first, end, n_draws=20, seed=3, exit_replay=replay)
    assert 0.0 < p <= 1.0 and 0.0 <= drop < 1.0 and len(shifts) == 20 and np.isfinite(obs)
    # item4 accepts the replay too.
    rng = np.random.default_rng(0)
    res = item4(
        receipt,
        tranches,
        panel,
        rng.normal(size=(60, 3)),
        folds,
        end_ms=end,
        exit_replay=replay,
    )
    assert "joint_shift_p" in res


# ---------------------------------------------------------------------------
# Size on no-edge panels
# ---------------------------------------------------------------------------


def _no_edge_case(seed: int, n_days: int = 50):
    from r4.exits import parse_exit
    from r4.synth import synth_panel

    syms = list(SYMS)
    vol = 0.02
    cov = (vol**2) * (0.3 * np.ones((6, 6)) + 0.7 * np.eye(6))
    panel = synth_panel(cov, syms, START, START + n_days * DAY, seed)
    five = {s: panel[s]["5m"] for s in panel}
    ctx = ExitContext(five, H4)
    spec = parse_exit({"rule": "E3", "k": 1.0})
    rng = np.random.default_rng(seed + 1000)
    rows = []
    for s in syms:
        df = five[s].set_index("t")["o"]
        for e in range(START + 3 * DAY, START + (n_days - 1) * DAY, 4 * 3_600_000):
            e_ms = e + 600_000
            rows.append((s, int(rng.choice([-1, 1])), e_ms, float(df.loc[e_ms])))
    ent = pd.DataFrame(rows, columns=["symbol", "side", "entry_ms", "entry_price"])
    ent["T"] = ent["entry_ms"] - 600_000
    ent["exit_ms"] = ent["entry_ms"] + H4
    out = ctx.replay(ent, spec)
    tranches = [
        Tranche(
            r.symbol,
            int(r.side),
            int(r.entry_ms),
            int(o.exit_ms),
            float(r.entry_price),
            float(o.exit_price),
            "1h",
            H4,
            exit_fill=str(o.exit_fill),
            exit_reason=str(o.exit_reason),
        )
        for r, o in zip(ent.itertuples(index=False), out.itertuples(index=False), strict=True)
    ]
    from r4.bar import make_exit_replay

    folds = _one_fold(START, n_days)
    folds[0]["betas"] = {s: 1.0 for s in UNIVERSE}
    return panel, tranches, folds, make_exit_replay(ctx, spec)


@pytest.mark.slow
def test_engine_null_no_edge_size(capsys):
    from r4.bar import joint_shift_null

    n_panels = 20
    n_days = 50
    rejected = 0
    ps = []
    for k in range(n_panels):
        panel, tranches, folds, replay = _no_edge_case(100 + k, n_days)
        p, _drop, _obs, _sh = joint_shift_null(
            tranches,
            panel,
            folds,
            START,
            START + n_days * DAY,
            n_draws=200,
            seed=900 + k,
            exit_replay=replay,
        )
        ps.append(p)
        rejected += int(p < 0.05)
    with capsys.disabled():
        print(f"\nno-edge engine null: rejected {rejected}/{n_panels} at 0.05, p = {np.round(ps, 3).tolist()}")
    # A binomial(20, 0.05) 95% band: P(X > 3) = 0.016 and P(X > 2) = 0.075, so at most 3 rejections.
    assert rejected <= 3


# ---------------------------------------------------------------------------
# Time per draw at 450 days
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_engine_null_time_per_draw(capsys):
    from r4.bar import joint_shift_stats, make_exit_replay
    from r4.exit_models import ExitModelFactory
    from r4.exits import parse_exit
    from r4.synth import synth_panel

    n_days = 450
    syms = list(UNIVERSE[:10])
    vol = 0.02
    cov = (vol**2) * (0.3 * np.ones((10, 10)) + 0.7 * np.eye(10))
    panel = synth_panel(cov, syms, START, START + n_days * DAY, 61)
    five = {s: panel[s]["5m"] for s in panel}
    rng = np.random.default_rng(3)
    parts = []
    for s in syms:
        t_idx = five[s]["t"].to_numpy()
        o = five[s]["o"].to_numpy()
        top = np.arange(START + 30 * DAY, START + (n_days - 1) * DAY, 3_600_000, dtype=np.int64)
        entry = top + 600_000
        parts.append(
            pd.DataFrame(
                {
                    "symbol": s,
                    "side": rng.choice([-1, 1], size=len(top)),
                    "T": top,
                    "entry_ms": entry,
                    "exit_ms": entry + H4,
                    "entry_price": o[np.searchsorted(t_idx, entry)],
                }
            )
        )
    ent = pd.concat(parts, ignore_index=True)
    timings: dict[str, float] = {}
    n_draws = 3
    folds = [
        {"start_ms": START, "end_ms": START + n_days * DAY, "train_cut_ms": None, "betas": {s: 1.0 for s in UNIVERSE}}
    ]
    end = START + n_days * DAY
    for name, spec_raw in (("E3", {"rule": "E3", "k": 1.0}), ("E4", {"rule": "E4", "margin_se": 1.0})):
        spec = parse_exit(spec_raw)
        ctx = ExitContext(five, H4)
        fold_models = None
        if spec.rule == "E4":
            fac = ExitModelFactory(panel, "1h", H4, ("taker_imb_last15", "ret_15m_last"), seed=7)
            models = fac.fit(None, START + 360 * DAY)
            assert models is not None
            fold_models = lambda fold, m=models: m  # noqa: E731
        replay = make_exit_replay(ctx, spec, folds=folds, fold_models=fold_models)
        out = replay(ent)
        tr = [
            Tranche(
                r.symbol,
                int(r.side),
                int(r.entry_ms),
                int(o.exit_ms),
                float(r.entry_price),
                float(o.exit_price),
                "1h",
                H4,
                exit_fill=str(o.exit_fill),
                exit_reason=str(o.exit_reason),
            )
            for r, o in zip(ent.itertuples(index=False), out.itertuples(index=False), strict=True)
        ]
        t0 = time.perf_counter()
        joint_shift_stats(tr, panel, folds, START, end, n_draws=n_draws, seed=1, exit_replay=replay)
        timings[name] = (time.perf_counter() - t0) / n_draws
    with capsys.disabled():
        print(f"\nengine null seconds per draw ({len(ent)} tranches, 450 days, 1h): {timings}")
    assert max(timings.values()) < 120.0
