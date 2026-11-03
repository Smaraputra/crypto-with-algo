"""Brief 31a (Amendment 5, A5.3): the joint-shift basket is judged per daily part of a tranche, as the book does."""

from __future__ import annotations

import functools
import sys
import types
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4.bar import joint_shift_p, joint_shift_stats
from r4.book import Tranche, beta_hedged_daily
from r4.method import UNIVERSE
from tests.a3_nodes_gen import nodes_from_source

# The C4 text of r4/bar.py (git show dfe1ebf5:scripts/research/py/r4/bar.py). The fast-path tests run it beside the
# C5 code on the same machine, because the last bits of a float sum differ between platforms (the GitHub runner gave
# -0.07616431549792911 where the Mac and the VPS image give -0.07616431549792917).
C4_BAR_SOURCE = Path(__file__).resolve().parent / "fixtures" / "bar_dfe1ebf5.py.txt"
C4_NODES = Path(__file__).resolve().parent / "fixtures" / "a5_nodes_dfe1ebf5.json"

DAY = 86_400_000
H = 3_600_000
H8 = 8 * H
STEP = 300_000
DAY0 = 1_700_006_400_000  # a UTC midnight
N_DAYS = 24
COINS = list(UNIVERSE[:4])
A, B, C, D = COINS
BETAS = {A: 1.2, B: 0.7, C: 1.1, D: 0.9}
SPAN_END = DAY0 + N_DAYS * DAY
FOLDS = [{"start_ms": DAY0, "end_ms": SPAN_END, "betas": BETAS}]

# The observed and null statistics at the C4 text of joint_shift_stats on the complete panel below, recorded on the Mac
# before the A5.3 edit (plain path and exit-replay path). The bit-for-bit check runs against the C4 text itself; these
# recorded values are checked to 1e-12 on any platform.
C4_PLAIN: dict[str, Any] = {
    "obs_stat": -0.07616431549792917,
    "null_stats": [
        0.17161990652420245,
        -0.008166406786596655,
        0.0230442044473166,
        -0.008166406786596655,
        -0.03623029431074098,
        -0.03623029431074098,
        0.046654840690051734,
        -0.0357718672463045,
        0.13296216513579515,
        0.0230442044473166,
        -0.0357718672463045,
        0.026031748470392364,
    ],
    "total_dropped": 2,
    "shifts": [14, 15, 7, 15, 12, 12, 13, 10, 17, 7, 10, 11],
}
C4_REPLAY: dict[str, Any] = {
    "obs_stat": 0.0031942058106434862,
    "null_stats": [
        0.09908458131571571,
        -0.015562172402118291,
        -0.07966671609406639,
        -0.015562172402118291,
        -0.017825114836637648,
        -0.017825114836637648,
        -0.02849706048927864,
        -0.12226934911405941,
        0.08812945217803723,
        -0.07966671609406639,
        -0.12226934911405941,
        0.010560879922373511,
    ],
    "total_dropped": 2,
    "shifts": [14, 15, 7, 15, 12, 12, 13, 10, 17, 7, 10, 11],
}


def _world(
    drop_open: dict[str, list[int]] | None = None,
    drop_settle: dict[str, list[int]] | None = None,
    list_at: dict[str, int] | None = None,
) -> tuple[dict[str, pd.DataFrame], dict[str, pd.DataFrame]]:
    """(5m opens, settlements) of the four coins, complete unless a hole is asked for."""
    times = list(range(DAY0, SPAN_END, STEP))
    rng = np.random.default_rng(4)
    ts = list(range(DAY0 - H8, DAY0 + (N_DAYS + 2) * DAY, H8))
    rng_s = np.random.default_rng(9)
    five, settle = {}, {}
    for c in COINS:
        px = 100.0 * np.exp(np.cumsum(rng.normal(0, 0.01, size=len(times))))
        five[c] = pd.DataFrame({"t": times, "o": px})
        settle[c] = pd.DataFrame({"t": ts, "rate": rng_s.normal(0.0002, 0.0003, size=len(ts))})
    for c, hole in (drop_open or {}).items():
        five[c] = five[c][~five[c]["t"].isin(hole)].reset_index(drop=True)
    for c, hole in (drop_settle or {}).items():
        settle[c] = settle[c][~settle[c]["t"].isin(hole)].reset_index(drop=True)
    for c, first in (list_at or {}).items():
        five[c] = five[c][five[c]["t"] >= first].reset_index(drop=True)
        settle[c] = settle[c][settle[c]["t"] >= first].reset_index(drop=True)
    return five, settle


def _panel(five: dict[str, pd.DataFrame], settle: dict[str, pd.DataFrame]) -> dict[str, dict[str, pd.DataFrame]]:
    return {c: {"5m": five[c], "settlements": settle[c], "funding": settle[c]} for c in COINS}


def _open(five: dict[str, pd.DataFrame], coin: str, t: int) -> float:
    df = five[coin]
    return float(df.loc[df["t"] == t, "o"].iloc[0])


def _tr(sym: str, w: float, entry: int, exit_: int, **kw: Any) -> Tranche:
    return Tranche(
        symbol=sym,
        side=1 if w > 0 else -1,
        entry_ms=entry,
        exit_ms=exit_,
        entry_price=kw.pop("entry_price", 100.0),
        exit_price=kw.pop("exit_price", 100.0),
        interval="1h",
        h_ms=kw.pop("h_ms", exit_ - entry),
        weight_override=w,
        **kw,
    )


def _horizon_set() -> list[Tranche]:
    """Four horizon tranches, three of which cross a UTC midnight (the first crosses two)."""
    return [
        _tr(A, 0.3, DAY0 + 5 * DAY + 20 * H, DAY0 + 7 * DAY + 4 * H),
        _tr(B, -0.2, DAY0 + 9 * DAY + 22 * H, DAY0 + 10 * DAY + 6 * H),
        _tr(C, 0.25, DAY0 + 12 * DAY + 5 * H, DAY0 + 12 * DAY + 13 * H),
        _tr(D, -0.35, DAY0 + 14 * DAY + 20 * H, DAY0 + 16 * DAY + 2 * H),
    ]


STOP_BACK = 2 * H - 100_000  # the long tranches of the replay set stop this long before their scheduled exit


def _replay_set(five: dict[str, pd.DataFrame]) -> list[Tranche]:
    """The horizon set with its longs replaced by intrabar stops in their last part (shorts keep the horizon)."""
    out = []
    for t in _horizon_set():
        if t.side_val > 0:
            entry_px = _open(five, t.symbol, t.entry_ms)
            out.append(
                _tr(
                    t.symbol,
                    t.weight,
                    t.entry_ms,
                    t.exit_ms - STOP_BACK,
                    h_ms=t.h_ms,
                    entry_price=entry_px,
                    exit_price=entry_px * 1.001,
                    exit_reason="stop",
                )
            )
        else:
            out.append(t)
    return out


class _StubReplay:
    """An exit replay: longs stop STOP_BACK before the scheduled exit, shorts exit at it."""

    def __call__(self, frame: pd.DataFrame) -> pd.DataFrame:
        long = frame["side"].to_numpy() > 0
        sched = frame["exit_ms"].to_numpy(dtype=np.int64)
        px = frame["entry_price"].to_numpy(dtype=np.float64)
        return pd.DataFrame(
            {
                "exit_ms": np.where(long, sched - STOP_BACK, sched),
                "exit_price": np.where(long, px * 1.001, px),
                "exit_fill": "taker",
                "exit_reason": np.where(long, "stop", "horizon"),
            }
        )


def _book_sum(trs: list[Tranche], five: dict[str, pd.DataFrame], settle: dict[str, pd.DataFrame]) -> float:
    daily = beta_hedged_daily(trs, five, settle, BETAS, COINS)
    return float(daily["drift_free"].sum())


@functools.cache
def _c4_bar() -> types.ModuleType:
    """The C4 text of r4/bar.py as its own module, so the C4 and C5 joint shifts share this machine's arithmetic."""
    module = types.ModuleType("r4_bar_c4")
    module.__file__ = str(C4_BAR_SOURCE)
    sys.modules[module.__name__] = module
    exec(compile(C4_BAR_SOURCE.read_text(encoding="utf-8"), str(C4_BAR_SOURCE), "exec"), module.__dict__)
    return module


def _run(trs: list[Tranche], five, settle, replay: bool = False, n_draws: int = 12, seed: int = 5, fn=None, **kw: Any):
    return (fn or joint_shift_stats)(
        trs,
        _panel(five, settle),
        FOLDS,
        DAY0,
        SPAN_END,
        n_draws=n_draws,
        seed=seed,
        exit_replay=_StubReplay() if replay else None,
        **kw,
    )


# ---------------------------------------------------------------------------
# the fast path keeps C4's numbers exactly
# ---------------------------------------------------------------------------


def test_the_c4_bar_fixture_is_the_c4_text():
    c4 = __import__("json").loads(C4_NODES.read_text(encoding="utf-8"))["modules"]["bar.py"]
    assert nodes_from_source(C4_BAR_SOURCE.read_text(encoding="utf-8")) == c4


def _same(st, c4) -> None:
    assert st.obs_stat == c4.obs_stat
    assert np.array_equal(st.null_stats, c4.null_stats)
    assert st.total_dropped == c4.total_dropped
    assert st.shifts == c4.shifts


def test_complete_panel_plain_path_is_bit_identical_to_c4():
    five, settle = _world()
    st = _run(_horizon_set(), five, settle)
    _same(st, _run(_horizon_set(), five, settle, fn=_c4_bar().joint_shift_stats))
    assert st.obs_stat == pytest.approx(C4_PLAIN["obs_stat"], rel=1e-12)
    assert [float(x) for x in st.null_stats] == pytest.approx(C4_PLAIN["null_stats"], rel=1e-12)
    assert st.total_dropped == C4_PLAIN["total_dropped"]
    assert st.shifts == C4_PLAIN["shifts"]


def test_complete_panel_replay_path_is_bit_identical_to_c4():
    five, settle = _world()
    st = _run(_replay_set(five), five, settle, replay=True, zero_shift=True)
    c4 = _run(_replay_set(five), five, settle, replay=True, zero_shift=True, fn=_c4_bar().joint_shift_stats)
    _same(st, c4)
    assert st.zero_shift_stat == c4.zero_shift_stat == st.obs_stat
    assert st.obs_stat == pytest.approx(C4_REPLAY["obs_stat"], rel=1e-12)
    assert [float(x) for x in st.null_stats] == pytest.approx(C4_REPLAY["null_stats"], rel=1e-12)
    assert st.total_dropped == C4_REPLAY["total_dropped"]


# ---------------------------------------------------------------------------
# book-to-null parity where the basket changes inside a tranche
# ---------------------------------------------------------------------------

MID_6 = DAY0 + 6 * DAY  # the first midnight inside the first tranche
CASES = {
    "missing_midnight_open": {"drop_open": {B: [MID_6]}},
    "missing_settlement_in_one_part": {"drop_settle": {B: [MID_6 + 8 * H]}},
    "listing_inside": {"list_at": {B: MID_6 + 8 * H}},
}


@pytest.mark.parametrize("case", list(CASES))
def test_plain_path_matches_the_book_where_the_basket_changes(case):
    five, settle = _world(**CASES[case])
    trs = _horizon_set()
    st = _run(trs, five, settle)
    assert st.obs_weight_sum is not None
    assert _book_sum(trs, five, settle) == pytest.approx(st.obs_stat * st.obs_weight_sum, abs=1e-12)


@pytest.mark.parametrize("case", list(CASES))
def test_replay_path_matches_the_book_with_an_intrabar_exit_in_a_later_part(case):
    five, settle = _world(**CASES[case])
    trs = _replay_set(five)
    assert trs[0].exit_intrabar and trs[0].exit_ms // DAY > MID_6 // DAY
    st = _run(trs, five, settle, replay=True, zero_shift=True)
    assert st.obs_weight_sum is not None
    assert _book_sum(trs, five, settle) == pytest.approx(st.obs_stat * st.obs_weight_sum, abs=1e-12)
    assert st.zero_shift_stat == st.obs_stat


@pytest.mark.parametrize("case", list(CASES))
def test_the_cases_differ_from_the_whole_window_basket(case):
    """Each hole changes the book's number against the complete panel, so the parity above is not vacuous."""
    five0, settle0 = _world()
    five, settle = _world(**CASES[case])
    trs = _horizon_set()
    assert _book_sum(trs, five, settle) != _book_sum(trs, five0, settle0)


# ---------------------------------------------------------------------------
# drops
# ---------------------------------------------------------------------------


def test_shifted_tranche_without_its_own_settlement_is_dropped_observed_is_not():
    obs = [_tr(A, 0.3, DAY0 + 3 * DAY + 10 * H, DAY0 + 3 * DAY + 22 * H)]
    five, settle = _world()
    base = _run(obs, five, settle, n_draws=200, seed=2)
    assert base.total_dropped == 0
    # A's 16:00 settlement of day 12 is missing: a shift of 9 days puts the window over it.
    hole = DAY0 + 12 * DAY + 16 * H
    five, settle = _world(drop_settle={A: [hole]})
    st = _run(obs, five, settle, n_draws=200, seed=2)
    n_hit = sum(1 for s in st.shifts if s == 9)
    assert n_hit > 0
    assert st.total_dropped == n_hit
    assert np.isfinite(st.obs_stat) and st.obs_n_kept == 1
    assert st.obs_stat == base.obs_stat
    assert joint_shift_p(st, 200)[1] == pytest.approx(n_hit / 200)
    assert joint_shift_p(base, 200)[1] == 0.0


def test_part_with_all_priced_coins_uncovered_drops_a_shifted_tranche_and_raises_observed():
    mid = DAY0 + 14 * DAY
    # A has no open at the midnight, so the first part's price basket is B, C, D, none of which has the 00:00
    # settlement the part is due. The whole window still has A covered, which hid this at C4.
    five, settle = _world(drop_open={A: [mid]}, drop_settle={B: [mid], C: [mid], D: [mid]})
    obs_clean = [_tr(A, 0.3, DAY0 + 2 * DAY + 20 * H, DAY0 + 3 * DAY + 4 * H)]
    st = _run(obs_clean, five, settle, n_draws=200, seed=2)
    n_hit = sum(1 for s in st.shifts if s == 11)
    assert n_hit > 0
    assert st.total_dropped == n_hit
    obs_bad = [_tr(A, 0.3, DAY0 + 13 * DAY + 20 * H, DAY0 + 14 * DAY + 4 * H)]
    with pytest.raises(ValueError, match="basket"):
        _run(obs_bad, five, settle, n_draws=3, seed=2)


def test_part_with_an_empty_price_basket_drops_the_tranche():
    mid = DAY0 + 6 * DAY
    five, settle = _world(drop_open=dict.fromkeys(COINS, [mid]))
    trs = [
        _tr(A, 0.3, DAY0 + 5 * DAY + 20 * H, DAY0 + 6 * DAY + 4 * H),
        _tr(C, 0.25, DAY0 + 12 * DAY + 5 * H, DAY0 + 12 * DAY + 13 * H),
    ]
    st = _run(trs, five, settle, n_draws=3, seed=2)
    assert st.obs_n_kept == 1
