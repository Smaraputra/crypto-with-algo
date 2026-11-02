"""Brief 23: same-instant fills net per coin, and slippage is per coin (Binance USDT-M one-way mode)."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

import r4.book as book
import r4.costs as costs
from r4.book import DAY_MS, Tranche
from r4.cli import stress_metrics
from r4.pipeline import RunConfig, _binary_labels

HOUR = 3_600_000
DAY0 = 1_700_006_400_000  # a UTC midnight
TAKER = 0.0005
MAKER = 0.0002
W = 1.0 / 4.0 / 10.0  # size 1, h 4h at 1h


def _tr(
    sym: str,
    side: int,
    entry_h: float,
    exit_h: float,
    entry_fill: str = "taker",
    exit_fill: str = "taker",
    interval: str = "1h",
    h_ms: int = 4 * HOUR,
) -> Tranche:
    return Tranche(
        symbol=sym,
        side=side,
        entry_ms=DAY0 + int(entry_h * HOUR),
        exit_ms=DAY0 + int(exit_h * HOUR),
        entry_price=100.0,
        exit_price=101.0,
        interval=interval,
        h_ms=h_ms,
        entry_fill=entry_fill,
        exit_fill=exit_fill,
    )


def _group(groups: pd.DataFrame, sym: str, hour: float, fill: str) -> pd.Series:
    sel = groups[
        (groups["symbol"] == sym) & (groups["instant_ms"] == DAY0 + int(hour * HOUR)) & (groups["fill"] == fill)
    ]
    assert len(sel) == 1
    return sel.iloc[0]


def test_same_side_roll_nets_to_zero():
    a = _tr("BTCUSDT", 1, 1, 5)
    b = _tr("BTCUSDT", 1, 5, 9)
    n = book.netted_costs([a, b])
    roll = _group(n.groups, "BTCUSDT", 5, "taker")
    assert roll["traded"] == pytest.approx(0.0, abs=1e-15)
    assert roll["fee"] + roll["slippage"] == pytest.approx(0.0, abs=1e-15)
    rate = TAKER + 0.0001  # BTC slippage 1 bp
    first = _group(n.groups, "BTCUSDT", 1, "taker")
    last = _group(n.groups, "BTCUSDT", 9, "taker")
    assert first["fee"] + first["slippage"] == pytest.approx(W * rate, abs=1e-15)
    assert last["fee"] + last["slippage"] == pytest.approx(W * rate, abs=1e-15)
    assert n.tranche_cost[0] == pytest.approx(W * rate, abs=1e-15)
    assert n.tranche_cost[1] == pytest.approx(W * rate, abs=1e-15)


def test_opposite_roll_charges_double():
    a = _tr("BTCUSDT", 1, 1, 5)
    b = _tr("BTCUSDT", -1, 5, 9)
    n = book.netted_costs([a, b])
    roll = _group(n.groups, "BTCUSDT", 5, "taker")
    assert roll["traded"] == pytest.approx(2 * W, abs=1e-15)
    assert roll["fee"] == pytest.approx(2 * W * TAKER, abs=1e-15)
    assert roll["slippage"] == pytest.approx(2 * W * 0.0001, abs=1e-15)


def test_maker_and_taker_not_merged():
    a = _tr("BTCUSDT", 1, 1, 5, exit_fill="maker")
    b = _tr("BTCUSDT", 1, 5, 9)
    n = book.netted_costs([a, b])
    maker = _group(n.groups, "BTCUSDT", 5, "maker")
    taker = _group(n.groups, "BTCUSDT", 5, "taker")
    assert maker["traded"] == pytest.approx(W, abs=1e-15)
    assert maker["fee"] == pytest.approx(W * MAKER, abs=1e-15)
    assert maker["slippage"] == 0.0
    assert taker["traded"] == pytest.approx(W, abs=1e-15)
    assert taker["fee"] == pytest.approx(W * TAKER, abs=1e-15)
    assert taker["slippage"] == pytest.approx(W * 0.0001, abs=1e-15)


@pytest.mark.parametrize("interval,h_ms,step", [("1h", 4 * HOUR, 1), ("4h", 4 * HOUR, 4)])
def test_random_sides_cost_about_half(interval, h_ms, step):
    rng = np.random.default_rng(11)
    for sym in ("BTCUSDT", "ADAUSDT"):
        sides = rng.choice([-1, 1], size=2000)
        trs = [_tr(sym, int(s), i * step, i * step + 4, interval=interval, h_ms=h_ms) for i, s in enumerate(sides)]
        n = book.netted_costs(trs)
        per_tranche = sum(2.0 * abs(t.weight) for t in trs) * (TAKER + costs.coin_slippage_bps(sym) / 1e4)
        netted = float(n.groups["fee"].sum() + n.groups["slippage"].sum())
        assert 0.45 <= netted / per_tranche <= 0.55, (sym, netted / per_tranche)


def test_allocation_sums_to_total():
    rng = np.random.default_rng(5)
    trs = []
    for _i in range(300):
        sym = ["BTCUSDT", "ETHUSDT", "ADAUSDT"][int(rng.integers(0, 3))]
        side = int(rng.choice([-1, 1]))
        ef = "maker" if rng.random() < 0.3 else "taker"
        xf = "maker" if rng.random() < 0.3 else "taker"
        start = int(rng.integers(0, 60))
        trs.append(_tr(sym, side, start, start + 4, entry_fill=ef, exit_fill=xf))
    n = book.netted_costs(trs)
    total = float(n.groups["fee"].sum() + n.groups["slippage"].sum())
    assert float(n.tranche_cost.sum()) == pytest.approx(total, abs=1e-12)
    assert float(n.tranche_fee.sum()) == pytest.approx(float(n.groups["fee"].sum()), abs=1e-12)
    assert float(n.tranche_slippage.sum()) == pytest.approx(float(n.groups["slippage"].sum()), abs=1e-12)
    assert float(n.by_day["fees"].sum() + n.by_day["slippage"].sum()) == pytest.approx(total, abs=1e-12)


def test_coin_slippage_table_and_unknown_raises():
    assert costs.COIN_SLIPPAGE_BPS == {
        "BTCUSDT": 1,
        "ETHUSDT": 1,
        "BNBUSDT": 2,
        "SOLUSDT": 2,
        "XRPUSDT": 2,
        "DOGEUSDT": 2,
        "AVAXUSDT": 3,
        "DOTUSDT": 3,
        "LINKUSDT": 3,
        "ADAUSDT": 5,
    }
    assert costs.coin_slippage_bps("ADAUSDT") == 5.0
    assert costs.coin_slippage_bps("BTCUSDT") == 1.0
    with pytest.raises(ValueError):
        costs.coin_slippage_bps("NEWUSDT")


def _fold(trs, betas=None):
    n = book.netted_costs(trs)
    frame = n.by_day.copy()
    frame["drift_free"] = 0.0
    return SimpleNamespace(book=frame, tranches=trs, betas=betas or {"BTCUSDT": 1.0})


def test_stress_maker_as_taker_recomputed():
    # A's maker exit and B's taker entry share an instant. As taker they net, so the stress is a cost cut there.
    a = _tr("BTCUSDT", 1, 1, 5, exit_fill="maker")
    b = _tr("BTCUSDT", 1, 5, 9)
    fold = _fold([a, b])
    idx = pd.Index([DAY0, DAY0 + DAY_MS], name="day_start")
    drift = pd.DataFrame({"drift_free": [0.01, 0.02]}, index=idx)
    out = stress_metrics([fold], drift, DAY0, DAY0 + 2 * DAY_MS)
    rate_taker = TAKER + 0.0001
    base_costs = W * rate_taker + W * MAKER + W * rate_taker + W * rate_taker
    relabelled = W * rate_taker + 0.0 + W * rate_taker
    extra = relabelled - base_costs  # negative: the netting saves
    assert extra == pytest.approx(-W * (MAKER + rate_taker), abs=1e-15)
    assert out["n_maker_fills"] == 1
    assert out["stress_maker_as_taker"] == pytest.approx((0.01 + 0.02) / 2 - extra / 2, abs=1e-15)


def test_binary_labels_per_coin_cost():
    cfg = RunConfig(
        family="A",
        model="logistic",
        params={},
        features=("a",),
        interval="1h",
        h_ms=14_400_000,
        label="fixed",
        side_rule="prob",
        threshold=0.55,
        size_rule="unit",
        lookback_months=None,
        refit="monthly",
        exit="horizon",
        seed=7,
    )
    # BTC round trip 2 x (0.0005 + 0.0001) = 0.0012, ADA 2 x (0.0005 + 0.0005) = 0.0020.
    df = pd.DataFrame(
        {
            "symbol": ["BTCUSDT", "ADAUSDT", "BTCUSDT", "ADAUSDT"],
            "gross_log": [0.0015, 0.0015, -0.0015, -0.0015],
        }
    )
    up, dn = _binary_labels(df, cfg)
    assert up.tolist() == [1, 0, 0, 0]
    assert dn.tolist() == [0, 0, 1, 0]


def test_joint_shift_uses_allocated_costs():
    from r4.bar import joint_shift_null
    from tests.test_cli_bar import UNIVERSE, _one_fold, _price, _pulse_panel

    start = 1672531200000
    n_days = 100
    panel = _pulse_panel(start, n_days, [])
    e = start + 10 * DAY_MS + 6 * HOUR
    px = lambda ms: _price(panel, "BTCUSDT", ms)  # noqa: E731
    a = Tranche("BTCUSDT", 1, e, e + 4 * HOUR, px(e), px(e + 4 * HOUR), "1h", 4 * HOUR)
    b = Tranche("BTCUSDT", 1, e + 4 * HOUR, e + 8 * HOUR, px(e + 4 * HOUR), px(e + 8 * HOUR), "1h", 4 * HOUR)
    _p, _drop, obs, _ = joint_shift_null(
        [a, b], panel, _one_fold(start, n_days), start, start + n_days * DAY_MS, n_draws=10, seed=3
    )

    def raw(t: Tranche) -> float:
        r_ew = np.mean([np.log(_price(panel, s, t.exit_ms) / _price(panel, s, t.entry_ms)) for s in UNIVERSE[:6]])
        return float(np.log(t.exit_price / t.entry_price) - r_ew)

    # The roll nets to zero, so each tranche carries its own entry or exit only: 1 x (taker + 1 bp).
    unit = TAKER + 0.0001
    assert obs == pytest.approx((raw(a) + raw(b)) / 2 - unit, rel=1e-9, abs=1e-12)


def test_parity_functions_unchanged():
    assert costs.STUDY_SLIPPAGE_BPS == {"1m": 5, "5m": 5, "15m": 3, "1h": 3, "4h": 2, "8h": 2, "1d": 2}
    assert costs.default_cost_percent("1h") == pytest.approx(2.0 * TAKER * 100.0 + 2.0 * 3 / 100.0)
    cfg = costs.study_cost_config("4h")
    assert cfg["slippage_bps"] == 2 and cfg["taker_fee_percent"] == TAKER
    net = costs.trade_net_return(1, 100.0, 101.0, 0.0, "1h")
    assert net == pytest.approx(0.01 - 2 * TAKER - 2 * 0.0003)


def test_joint_shift_nets_only_included_tranches():
    """The null charges the book's costs: a NaN-beta tranche is excluded, so it cannot net away another's fill."""
    from r4.bar import joint_shift_null
    from tests.test_cli_bar import UNIVERSE, _price, _pulse_panel

    start = 1672531200000
    n_days = 100
    panel = _pulse_panel(start, n_days, [])
    e = start + 10 * DAY_MS + 6 * HOUR
    cut = e + 4 * HOUR
    folds = [
        {
            "start_ms": start,
            "end_ms": cut,
            "train_cut_ms": None,
            "betas": {s: (None if s == "BTCUSDT" else 1.0) for s in UNIVERSE},
        },
        {"start_ms": cut, "end_ms": start + n_days * DAY_MS, "train_cut_ms": None, "betas": {s: 1.0 for s in UNIVERSE}},
    ]
    px = lambda ms: _price(panel, "BTCUSDT", ms)  # noqa: E731
    a = Tranche("BTCUSDT", 1, e, cut, px(e), px(cut), "1h", 4 * HOUR)  # entry fold has a NaN beta: excluded
    b = Tranche("BTCUSDT", 1, cut, cut + 4 * HOUR, px(cut), px(cut + 4 * HOUR), "1h", 4 * HOUR)
    _p, _drop, obs, _ = joint_shift_null([a, b], panel, folds, start, start + n_days * DAY_MS, n_draws=10, seed=3)

    r_ew = np.mean([np.log(_price(panel, s, b.exit_ms) / _price(panel, s, b.entry_ms)) for s in UNIVERSE[:6]])
    raw_b = float(np.log(b.exit_price / b.entry_price) - r_ew)
    # a is excluded, so b's entry is not netted against a's exit: b pays its entry and its exit.
    assert obs == pytest.approx(raw_b - 2 * (TAKER + 0.0001), rel=1e-9, abs=1e-12)
