"""Amendment 5 A5.2: the netted hedge-cost estimate (r4/hedge_cost.py), on synthetic data only."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from r4.book import DAY_MS, FIVE_MIN_MS, FiveMinLookup, Tranche, netted_costs
from r4.costs import coin_slippage_bps
from r4.hedge_cost import hedge_cost_daily, hedge_cost_report, hedge_legs

UNIVERSE = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"]
OUTSIDE = "ADAUSDT"  # not in the basket, so a coin leg on it never nets with a hedge leg
TAKER = 0.0005
D0 = 20_000 * DAY_MS
H = 3_600_000


def make_lookup(drop: dict[str, set[int]] | None = None) -> FiveMinLookup:
    times = np.arange(D0, D0 + 3 * DAY_MS, FIVE_MIN_MS, dtype=np.int64)
    frames = {}
    for k, sym in enumerate([*UNIVERSE, OUTSIDE]):
        df = pd.DataFrame({"t": times, "o": 100.0 + k + 0.001 * np.arange(len(times))})
        gone = (drop or {}).get(sym, set())
        frames[sym] = df[~df["t"].isin(gone)].reset_index(drop=True)
    return FiveMinLookup(frames)


def tr(sym: str, entry: int, exit_: int, w: float = 0.1, **kw) -> Tranche:
    return Tranche(
        symbol=sym,
        side=1 if w > 0 else -1,
        entry_ms=entry,
        exit_ms=exit_,
        entry_price=100.0,
        exit_price=101.0,
        interval="1h",
        h_ms=exit_ - entry,
        weight_override=w,
        **kw,
    )


def cost_rate(sym: str) -> float:
    return TAKER + coin_slippage_bps(sym) / 1e4


def test_zero_beta_gives_zero_h() -> None:
    coin = [tr(OUTSIDE, D0 + H, D0 + 5 * H)]
    hedge = hedge_legs(coin, [0.0], make_lookup(), UNIVERSE)
    assert len(hedge) == 0
    assert hedge.basket_sizes == [4]
    out = hedge_cost_daily(coin, hedge)
    assert (out["h"] == 0.0).all() and len(out) == 1


def test_closed_form_one_tranche_one_day() -> None:
    w, beta = 0.1, 0.8
    coin = [tr(OUTSIDE, D0 + H, D0 + 5 * H, w)]
    hedge = hedge_legs(coin, [beta], make_lookup(), UNIVERSE)
    assert len(hedge) == 4
    assert all(abs(leg.weight) == pytest.approx(beta * w / 4) for leg in hedge)
    assert all(leg.weight < 0 for leg in hedge)
    out = hedge_cost_daily(coin, hedge)
    expected = sum(2 * abs(beta * w) / 4 * cost_rate(s) for s in UNIVERSE)
    assert out["h"].sum() == pytest.approx(expected)
    assert out.loc[D0, "h"] == pytest.approx(expected)


def test_negative_beta_flips_hedge_side() -> None:
    coin = [tr(OUTSIDE, D0 + H, D0 + 2 * H, 0.1)]
    hedge = hedge_legs(coin, [-0.5], make_lookup(), UNIVERSE)
    assert all(leg.weight > 0 and leg.side_val == 1 for leg in hedge)


def test_offsetting_tranches_net_to_zero() -> None:
    coin = [tr(OUTSIDE, D0 + H, D0 + 5 * H, 0.1), tr(OUTSIDE, D0 + H, D0 + 5 * H, -0.1)]
    hedge = hedge_legs(coin, [1.0, 1.0], make_lookup(), UNIVERSE)
    assert len(hedge) == 8
    out = hedge_cost_daily(coin, hedge)
    assert out["h"].abs().max() == pytest.approx(0.0, abs=1e-15)


def test_fully_hedged_equal_weight_book_is_minus_coin_cost() -> None:
    coin = [tr(s, D0 + H, D0 + 5 * H, 0.1) for s in UNIVERSE]
    hedge = hedge_legs(coin, [1.0] * 4, make_lookup(), UNIVERSE)
    out = hedge_cost_daily(coin, hedge)
    alone = netted_costs(coin).by_day
    assert (alone["fees"] + alone["slippage"]).sum() > 0
    assert out["h"].sum() == pytest.approx(-(alone["fees"] + alone["slippage"]).sum())
    assert out["h"].sum() + (alone["fees"] + alone["slippage"]).sum() == pytest.approx(0.0, abs=1e-15)


def test_midnight_with_unchanged_basket_cancels() -> None:
    w, beta = 0.1, 1.0
    entry, exit_ = D0 + 12 * H, D0 + DAY_MS + 12 * H
    coin = [tr(OUTSIDE, entry, exit_, w)]
    hedge = hedge_legs(coin, [beta], make_lookup(), UNIVERSE)
    assert hedge.basket_sizes == [4, 4]
    assert len(hedge) == 8
    out = hedge_cost_daily(coin, hedge)
    per_leg = sum(abs(beta * w) / 4 * cost_rate(s) for s in UNIVERSE)
    assert out.loc[D0, "h"] == pytest.approx(per_leg)
    assert out.loc[D0 + DAY_MS, "h"] == pytest.approx(per_leg)
    assert out["h"].sum() == pytest.approx(2 * per_leg)


def test_midnight_basket_change_trades_only_the_difference() -> None:
    w, beta = 0.1, 1.0
    entry, exit_ = D0 + 12 * H, D0 + DAY_MS + 12 * H
    lookup = make_lookup({"DOGEUSDT": {entry}})
    coin = [tr(OUTSIDE, entry, exit_, w)]
    hedge = hedge_legs(coin, [beta], lookup, UNIVERSE)
    assert hedge.basket_sizes == [3, 4]
    out = hedge_cost_daily(coin, hedge)
    mid = D0 + DAY_MS
    bw = beta * w
    day0 = sum(bw / 3 * cost_rate(s) for s in UNIVERSE[:3])
    diff = sum(abs(bw / 3 - bw / 4) * cost_rate(s) for s in UNIVERSE[:3]) + bw / 4 * cost_rate("DOGEUSDT")
    exit_legs = sum(bw / 4 * cost_rate(s) for s in UNIVERSE)
    assert out.loc[D0, "h"] == pytest.approx(day0)
    assert out.loc[mid, "h"] == pytest.approx(diff + exit_legs)
    # Without netting the midnight would cost every coin's full close and open.
    gross_mid = sum((bw / 3 + bw / 4) * cost_rate(s) for s in UNIVERSE[:3]) + bw / 4 * cost_rate("DOGEUSDT")
    assert diff < gross_mid


def test_maker_exit_nets_with_hedge_only_as_taker() -> None:
    entry, exit_ = D0 + H, D0 + 5 * H
    coin = [tr("BTCUSDT", entry, exit_, 0.1, exit_fill="maker")]
    hedge = hedge_legs(coin, [1.0], make_lookup(), UNIVERSE)
    plain = hedge_cost_daily(coin, hedge)
    mat = hedge_cost_daily(coin, hedge, maker_as_taker=True)
    assert plain["h"].sum() != pytest.approx(mat["h"].sum())

    idx = pd.Index([D0, D0 + DAY_MS], name="day_start")
    alone = netted_costs(coin).by_day.reindex(idx, fill_value=0.0)
    daily = pd.DataFrame(
        {"drift_free": [0.01, 0.0], "fees": alone["fees"], "slippage": alone["slippage"]},
        index=idx,
    )
    rep = hedge_cost_report(daily, coin, hedge)
    assert rep["mat_h_mean"] == pytest.approx(mat["h"].reindex(idx, fill_value=0.0).mean() * 1e4)
    assert rep["h_mean"] == pytest.approx(plain["h"].reindex(idx, fill_value=0.0).mean() * 1e4)
    assert rep["mat_h_mean"] != pytest.approx(rep["h_mean"])
    # The coin-only cost reprices too: D_d moves by the coin legs' extra cost.
    mat_coin = netted_costs(coin, maker_as_taker=True).by_day.reindex(idx, fill_value=0.0)
    extra = (mat_coin["fees"] + mat_coin["slippage"] - alone["fees"] - alone["slippage"]).to_numpy()
    d_mat = daily["drift_free"].to_numpy() - extra
    expect = (d_mat - mat["h"].reindex(idx, fill_value=0.0).to_numpy()).mean() * 1e4
    assert rep["mat_net_mean"] == pytest.approx(expect)


def test_stress_fields_use_fee_x1_5_and_slippage_x2() -> None:
    entry, exit_ = D0 + 12 * H, D0 + DAY_MS + 12 * H
    coin = [tr(OUTSIDE, entry, exit_, 0.1), tr("SOLUSDT", entry + H, exit_ + H, -0.05)]
    hedge = hedge_legs(coin, [0.9, 1.2], make_lookup(), UNIVERSE)
    with_h = netted_costs(coin + list(hedge)).by_day
    alone = netted_costs(coin).by_day
    idx = pd.Index([D0 - DAY_MS, D0, D0 + DAY_MS, D0 + 2 * DAY_MS], name="day_start")
    fee_h = (with_h["fees"].reindex(idx, fill_value=0.0) - alone["fees"].reindex(idx, fill_value=0.0)).to_numpy()
    slip_h = (
        with_h["slippage"].reindex(idx, fill_value=0.0) - alone["slippage"].reindex(idx, fill_value=0.0)
    ).to_numpy()
    fees = alone["fees"].reindex(idx, fill_value=0.0).to_numpy()
    slip = alone["slippage"].reindex(idx, fill_value=0.0).to_numpy()
    drift = np.array([0.0, 0.004, -0.002, 0.001])
    daily = pd.DataFrame({"drift_free": drift, "fees": fees, "slippage": slip}, index=idx)
    rep = hedge_cost_report(daily, coin, hedge)

    h = fee_h + slip_h
    stress_h = 1.5 * fee_h + 2.0 * slip_h
    stress_d = drift - 0.5 * fees - 1.0 * slip
    assert rep["h_mean"] == pytest.approx(h.mean() * 1e4)
    assert rep["net_mean"] == pytest.approx((drift - h).mean() * 1e4)
    assert rep["stress_h_mean"] == pytest.approx(stress_h.mean() * 1e4)
    assert rep["stress_net_mean"] == pytest.approx((stress_d - stress_h).mean() * 1e4)
    assert rep["n_days"] == 4
    assert rep["n_hedge_legs"] == len(hedge)
    assert (rep["basket_min"], rep["basket_max"]) == (4, 4)
    assert not any("pass" in k for k in rep)


def test_hedge_legs_are_taker_horizon_and_never_intrabar() -> None:
    entry = D0 + H
    exit_ = D0 + 5 * H + 77_000  # a stop stamped between 5m opens
    coin = [tr(OUTSIDE, entry, exit_, 0.1, exit_reason="stop")]
    hedge = hedge_legs(coin, [1.0], make_lookup(), UNIVERSE)
    ceil = -(-exit_ // FIVE_MIN_MS) * FIVE_MIN_MS
    assert len(hedge) == 4
    for leg in hedge:
        assert leg.exit_ms == ceil and leg.entry_ms == entry
        assert leg.entry_fill == "taker" and leg.exit_fill == "taker"
        assert leg.exit_reason == "horizon" and not leg.exit_intrabar and not leg.exit_priced
        assert leg.side_val == -1 and leg.weight == pytest.approx(-0.1 / 4)
