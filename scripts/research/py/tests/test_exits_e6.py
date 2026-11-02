"""Tests for exit E6: a flow and funding information exit evaluated at every 5m close."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from r4.exits import (
    STEP_MS,
    E6Data,
    ExitContext,
    ExitSpec,
    build_e6_series,
    parse_exit,
    prepare_bars,
    replay_by_steps,
    replay_exits,
)
from r4.method import ENTRY_DELAY_MS

B0 = 1_672_531_200_000  # 2023-01-01 UTC, a funding settlement time
SYM = "BTCUSDT"
H8 = 8 * 3_600_000
SPEC = {"rule": "E6", "flow_bars": 12, "flow_lookback_days": 1, "flow_z": 2.0, "funding_threshold": 0.0005}


def _bars(v: np.ndarray, tbv: np.ndarray) -> pd.DataFrame:
    n = len(v)
    return pd.DataFrame(
        {
            "t": B0 + np.arange(n, dtype=np.int64) * STEP_MS,
            "o": np.full(n, 100.0),
            "h": np.full(n, 100.5),
            "l": np.full(n, 99.5),
            "c": np.full(n, 100.0),
            "v": v,
            "tbv": tbv,
        }
    )


def _quiet(n: int, seed: int = 3, noise: float = 0.2) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    return np.full(n, 100.0), 50.0 + rng.normal(0.0, noise, size=n)


def _premium(n: int, value: float | np.ndarray = 0.0001, start: int = 0) -> pd.DataFrame:
    return pd.DataFrame({"t": B0 + (start + np.arange(n, dtype=np.int64)) * STEP_MS, "c": value})


def _settle(idx: list[int], rate: float = 0.0001) -> pd.DataFrame:
    return pd.DataFrame({"t": [B0 + i * STEP_MS for i in idx], "rate": rate})


def _entry(side: int, entry_i: int, exit_i: int) -> pd.DataFrame:
    entry_ms = B0 + entry_i * STEP_MS
    return pd.DataFrame(
        {
            "symbol": [SYM],
            "side": [side],
            "T": [entry_ms - ENTRY_DELAY_MS],
            "entry_ms": [entry_ms],
            "exit_ms": [B0 + exit_i * STEP_MS],
            "entry_price": [100.0],
        }
    )


def _data(premium: pd.DataFrame | None, settle: pd.DataFrame | None) -> E6Data:
    return E6Data({SYM: premium}, {SYM: settle})


def _run(bars, side, entry_i, exit_i, premium=None, settle=None, spec=SPEC, reference=False):
    fn = replay_by_steps if reference else replay_exits
    out = fn(
        _entry(side, entry_i, exit_i),
        {SYM: bars},
        spec,
        lambda s, t: np.full(len(np.atleast_1d(t)), 0.01),
        _data(premium, settle),
    )
    return out.iloc[0]


def _naive_flow_fire(v, tbv, j, side, fb=12, m=288, z=2.0) -> bool:
    """Independent reference for the flow trigger at the close of bar j (no gaps)."""
    w = np.array([tbv[k - fb + 1 : k + 1].sum() / v[k - fb + 1 : k + 1].sum() for k in range(j - m + 1, j + 1)])
    mu, sd = w.mean(), w.std(ddof=1)
    return bool(w[-1] < mu - z * sd) if side == 1 else bool(w[-1] > mu + z * sd)


# ---------------------------------------------------------------------------
# parse
# ---------------------------------------------------------------------------


def test_parse_e6():
    s = parse_exit(SPEC)
    assert s == ExitSpec(rule="E6", flow_bars=12, flow_lookback_days=1, flow_z=2.0, funding_threshold=0.0005)
    assert parse_exit(s) == s
    for bad in (
        {"rule": "E6"},
        {**SPEC, "extra": 1},
        {**SPEC, "flow_bars": 0},
        {**SPEC, "flow_bars": 2.5},
        {**SPEC, "flow_z": -1.0},
        {**SPEC, "funding_threshold": float("nan")},
        {**SPEC, "flow_lookback_days": 0},
    ):
        with pytest.raises(ValueError):
            parse_exit(bad)


# ---------------------------------------------------------------------------
# flow trigger
# ---------------------------------------------------------------------------


def _drop_world(n: int, drop_i: int):
    v, tbv = _quiet(n)
    tbv[drop_i] = 0.0
    return _bars(v, tbv), v, tbv


def test_e6_flow_trigger_hand_path():
    bars, v, tbv = _drop_world(340, 325)
    assert [j for j in range(320, 333) if _naive_flow_fire(v, tbv, j, 1)][:1] == [325]
    assert not any(_naive_flow_fire(v, tbv, j, -1) for j in range(320, 333))
    for ref in (False, True):
        row = _run(bars, 1, 320, 335, reference=ref)
        assert row["exit_reason"] == "flow_exit" and row["exit_fill"] == "taker"
        assert int(row["exit_ms"]) == B0 + 328 * STEP_MS  # tau = bar 325 close, plus 10 minutes
        assert row["exit_price"] == bars["o"].iloc[328]
        short = _run(bars, -1, 320, 335, reference=ref)
        assert short["exit_reason"] == "horizon" and int(short["exit_ms"]) == B0 + 335 * STEP_MS


def test_e6_pending_close_holds_through_two_bars():
    bars, _, _ = _drop_world(340, 325)
    bars.loc[326:327, ["h", "l"]] = [[200.0, 1.0]]  # wild bars between tau and the scheduled close: nothing fires
    row = _run(bars, 1, 320, 335)
    assert row["exit_reason"] == "flow_exit" and int(row["exit_ms"]) == B0 + 328 * STEP_MS


def test_e6_close_after_cutoff_becomes_horizon():
    bars, v, tbv = _drop_world(340, 327)
    assert [j for j in range(320, 328) if _naive_flow_fire(v, tbv, j, 1)] == [327]
    for ref in (False, True):
        row = _run(bars, 1, 320, 330, reference=ref)  # tau + 10min == S
        assert row["exit_reason"] == "horizon" and int(row["exit_ms"]) == B0 + 330 * STEP_MS
        ctrl = _run(bars, 1, 320, 331, reference=ref)  # one bar later the same fire closes early
        assert ctrl["exit_reason"] == "flow_exit" and int(ctrl["exit_ms"]) == B0 + 330 * STEP_MS
    late, _, _ = _drop_world(340, 328)  # tau = S - 5min is past the last check
    assert _run(late, 1, 320, 330)["exit_reason"] == "horizon"


# ---------------------------------------------------------------------------
# funding trigger
# ---------------------------------------------------------------------------


def _fund_series(prem_c, settle_idx, n=120):
    v, tbv = _quiet(n)
    bars = prepare_bars({SYM: _bars(v, tbv)})[SYM]
    prem = pd.DataFrame({"t": B0 + (-3 + np.arange(len(prem_c), dtype=np.int64)) * STEP_MS, "c": prem_c})
    return build_e6_series(bars, prem, _settle(settle_idx), 12, 1)


def test_e6_funding_formula():
    # premium bar -3..-1 hold 9.9 and close at or before the settlement, so they must be ignored
    prem_c = np.concatenate(([9.9, 9.9, 9.9, 0.0010, 0.0020, 0.0030], np.full(114, 0.0001)))
    ser = _fund_series(prem_c, [-96, 0])
    j = 2  # tau = B0 + 15min: P = mean(0.001, 0.002, 0.003) = 0.002, I = 0.0001, clamp(-0.0019) = -0.0005
    assert ser.f[j] == pytest.approx(0.0015)
    assert ser.nxt[j] == B0 + H8
    j = 10
    p = (0.001 + 0.002 + 0.003 + 8 * 0.0001) / 11
    assert ser.f[j] == pytest.approx(p + np.clip(0.0001 - p, -0.0005, 0.0005))
    neg = _fund_series(np.full(120 + 3, -0.001), [-96, 0])
    assert neg.f[5] == pytest.approx(-0.0005)  # clamp(0.0011) = +0.0005
    half = _fund_series(np.full(120 + 3, 0.0), [-48, 0])  # a 4h interval halves I
    assert half.f[5] == pytest.approx(0.00005)
    assert half.nxt[5] == B0 + H8 // 2


def test_e6_funding_timing_guard():
    n = 330
    v, tbv = _quiet(n)
    bars = _bars(v, tbv)
    prem = _premium(n, 0.003)
    settle = _settle([100, 196])  # next settlement at bar 292
    ok = _run(bars, 1, 288, 300, prem, settle)
    assert ok["exit_reason"] == "funding_exit" and int(ok["exit_ms"]) == B0 + 291 * STEP_MS
    assert _run(bars, 1, 288, 300, prem, settle, reference=True)["exit_ms"] == ok["exit_ms"]
    for entry_i in (289, 290):  # tau + 10min is at or after the settlement
        blocked = _run(bars, 1, entry_i, 300, prem, settle)
        assert blocked["exit_reason"] == "horizon" and int(blocked["exit_ms"]) == B0 + 300 * STEP_MS
    assert _run(bars, -1, 288, 300, prem, settle)["exit_reason"] == "horizon"
    shorty = _run(bars, -1, 288, 300, _premium(n, -0.003), settle)
    assert shorty["exit_reason"] == "funding_exit"


# ---------------------------------------------------------------------------
# missing inputs
# ---------------------------------------------------------------------------


def test_e6_missing_inputs_hold_and_count():
    n = 340
    v, tbv = _quiet(n)
    tbv[325] = 0.0
    v[323] = 0.0  # a zero volume inside every window that contains the drop
    bars = _bars(v, tbv)
    for ref in (False, True):
        row = _run(bars, 1, 320, 335, reference=ref)
        assert row["exit_reason"] == "horizon" and int(row["exit_ms"]) == B0 + 335 * STEP_MS
        assert bool(row["missing_flow"]) is True and bool(row["missing_funding"]) is True
    # sufficient flow history and funding inputs: nothing missing, and the drop closes
    clean, _, _ = _drop_world(n, 325)
    row = _run(clean, 1, 320, 335, _premium(n), _settle([-96, 0, 96, 192, 288]))
    assert bool(row["missing_flow"]) is False and bool(row["missing_funding"]) is False
    # fewer than 80% of the lookback points exist: no flow trigger at all
    v2, tbv2 = _quiet(200)
    tbv2[150] = 0.0
    short_hist = _run(_bars(v2, tbv2), 1, 120, 170, _premium(200), _settle([-96, 0, 96]))
    assert short_hist["exit_reason"] == "horizon" and bool(short_hist["missing_flow"]) is True
    assert bool(short_hist["missing_funding"]) is False


# ---------------------------------------------------------------------------
# causality
# ---------------------------------------------------------------------------


def test_e6_causal():
    n, cut = 700, 400
    rng = np.random.default_rng(9)
    v = rng.uniform(50, 150, size=n)
    tbv = v * rng.uniform(0.3, 0.7, size=n)
    prem = _premium(n, 0.0001 + rng.normal(0, 0.0004, size=n))
    settle = _settle(list(range(-96, n + 96, 96)), 0.0001)
    base = prepare_bars({SYM: _bars(v, tbv)})[SYM]
    ser = build_e6_series(base, prem, settle, 12, 1)
    v2, tbv2, p2 = v.copy(), tbv.copy(), prem["c"].to_numpy().copy()
    v2[cut + 1 :] = rng.uniform(1, 500, size=n - cut - 1)
    tbv2[cut + 1 :] = v2[cut + 1 :] * rng.uniform(0, 1, size=n - cut - 1)
    p2[cut + 1 :] = rng.normal(0.01, 0.01, size=n - cut - 1)
    prem2 = prem.assign(c=p2)
    settle2 = pd.concat([settle[settle["t"] <= B0 + (cut + 1) * STEP_MS], _settle([cut + 40, cut + 97])]).reset_index(
        drop=True
    )
    ser2 = build_e6_series(prepare_bars({SYM: _bars(v2, tbv2)})[SYM], prem2, settle2, 12, 1)
    for name in ("w", "mu", "sd", "f", "nxt"):
        np.testing.assert_array_equal(getattr(ser, name)[: cut + 1], getattr(ser2, name)[: cut + 1], err_msg=name)
    assert not np.array_equal(ser.w[cut + 1 :], ser2.w[cut + 1 :], equal_nan=True)


# ---------------------------------------------------------------------------
# property: step() equals the replay
# ---------------------------------------------------------------------------


def _e6_world(seed: int, n_tr: int = 500):
    rng = np.random.default_rng(seed)
    n = 3000
    v = rng.lognormal(4.0, 0.4, size=n)
    v[rng.random(n) < 0.01] = 0.0
    tbv = v * rng.beta(8, 8, size=n)
    tbv[rng.random(n) < 0.005] = np.nan
    bars = _bars(v, tbv)
    keep = rng.random(n) > 0.015
    entry_i = rng.integers(300, n - 90, size=n_tr)
    length = rng.integers(2, 80, size=n_tr)
    keep[entry_i] = True
    keep[entry_i + length] = True
    bars = bars[keep].reset_index(drop=True)
    prem_c = np.repeat(rng.normal(0, 0.002, size=n // 150 + 1), 150)[:n]
    prem = _premium(n, prem_c)
    prem = prem[rng.random(n) > 0.02].reset_index(drop=True)
    idx = sorted(set(range(-96, n + 96, 96)) - set(rng.choice(np.arange(0, n, 96), size=2).tolist()))
    settle = _settle([i - (48 if i > 1500 else 0) if i % 5 == 0 else i for i in idx])
    side = rng.choice([-1, 1], size=n_tr)
    entry_ms = B0 + entry_i * STEP_MS
    entries = pd.DataFrame(
        {
            "symbol": SYM,
            "side": side,
            "T": entry_ms - ENTRY_DELAY_MS,
            "entry_ms": entry_ms,
            "exit_ms": entry_ms + length * STEP_MS,
            "entry_price": 100.0,
        }
    )
    return entries, bars, prem, settle


def test_step_equals_replay_e6():
    entries, bars, prem, settle = _e6_world(21)
    spec = {**SPEC, "flow_z": 1.5, "funding_threshold": 0.0004}
    data = _data(prem, settle)
    sig = lambda s, t: np.full(len(np.atleast_1d(t)), 0.01)  # noqa: E731
    fast = replay_exits(entries, {SYM: bars}, spec, sig, data)
    slow = replay_by_steps(entries, {SYM: bars}, spec, sig, data)
    pd.testing.assert_frame_equal(fast, slow, check_exact=True)
    assert (entries["side"] == 1).any() and (entries["side"] == -1).any()
    counts = fast["exit_reason"].value_counts().to_dict()
    assert {"horizon", "flow_exit", "funding_exit"} <= set(counts), counts
    assert fast["missing_flow"].any() and fast["missing_funding"].any()
    for s in (1, -1):
        assert set(fast.loc[entries["side"] == s, "exit_reason"]) >= {"flow_exit", "funding_exit"}
    assert ((fast["exit_ms"] - B0) % STEP_MS == 0).all()
    assert (fast["exit_ms"] <= entries["exit_ms"]).all()


def test_e6_requires_data():
    v, tbv = _quiet(100)
    with pytest.raises(ValueError):
        replay_exits(_entry(1, 20, 40), {SYM: _bars(v, tbv)}, SPEC, lambda s, t: np.zeros(1))


def test_exit_context_counts_e6():
    bars, _, _ = _drop_world(340, 325)
    ctx = ExitContext({SYM: bars}, 3_600_000, premium={SYM: None}, settlements={SYM: None})
    out = ctx.replay(_entry(1, 320, 335), parse_exit(SPEC))
    assert out["exit_reason"].iloc[0] == "flow_exit"
    assert ctx.reasons["flow_exit"] == 1 and ctx.missing_funding == 1 and ctx.missing_flow == 0


# ---------------------------------------------------------------------------
# registered diagnostic
# ---------------------------------------------------------------------------


def test_e6_noise_close_time_diagnostic(capsys):
    rng = np.random.default_rng(5)
    n = 12_000
    v = rng.lognormal(4.0, 0.3, size=n)
    tbv = v * rng.uniform(0.35, 0.65, size=n)  # iid flow, no information
    bars = _bars(v, tbv)
    n_tr = 400
    entry_i = rng.integers(9_000, n - 60, size=n_tr)
    length = np.full(n_tr, 48)
    entry_ms = B0 + entry_i * STEP_MS
    entries = pd.DataFrame(
        {
            "symbol": SYM,
            "side": rng.choice([-1, 1], size=n_tr),
            "T": entry_ms - ENTRY_DELAY_MS,
            "entry_ms": entry_ms,
            "exit_ms": entry_ms + length * STEP_MS,
            "entry_price": 100.0,
        }
    )
    spec = {"rule": "E6", "flow_bars": 12, "flow_lookback_days": 30, "flow_z": 2.0, "funding_threshold": 0.0005}
    data = _data(_premium(n, 0.0001), _settle(list(range(-96, n + 96, 96))))
    out = replay_exits(entries, {SYM: bars}, spec, lambda s, t: np.zeros(len(np.atleast_1d(t))), data)
    share = float(np.median((out["exit_ms"] - entries["entry_ms"]) / (entries["exit_ms"] - entries["entry_ms"])))
    with capsys.disabled():
        print(f"\nE6 noise diagnostic: median hold share of h = {share:.4f}")
    assert 0.0 <= share <= 1.0
