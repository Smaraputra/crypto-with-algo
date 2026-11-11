"""Tests for lighter/stats.py: Newey-West t, daily series, noise control, the passing rules, finalists and the
account layer. Synthetic inputs only."""

from __future__ import annotations

import datetime as dt
import math

import numpy as np
import pytest

from lighter import fills, lock, stats
from lighter import fold_trades as ft

MIN = 60_000
DAY = 86_400_000
D0 = ft.day_start_ms(dt.date(2025, 7, 1))


def hand_newey_west(x, lags=5):
    """Straight from the formula, with plain loops."""
    n = len(x)
    mean = sum(x) / n
    d = [v - mean for v in x]

    def gamma(lag):
        return sum(d[t] * d[t - lag] for t in range(lag, n)) / n

    var = gamma(0)
    for lag in range(1, lags + 1):
        if lag < n:
            var += 2 * (1 - lag / (lags + 1)) * gamma(lag)
    se = math.sqrt(var / n)
    return mean, se, mean / se


def test_newey_west_matches_hand_computation():
    x = [1.5, -0.5, 2.0, 0.3, -1.2, 0.8, 1.1, -0.4, 0.9, 2.2, -0.7, 0.1]
    mean, se, t = stats.newey_west(np.array(x))
    h_mean, h_se, h_t = hand_newey_west(x)
    assert mean == pytest.approx(h_mean, abs=1e-12)
    assert se == pytest.approx(h_se, abs=1e-12)
    assert t == pytest.approx(h_t, abs=1e-10)
    # a worked number: weights 5/6, 4/6, 3/6, 2/6, 1/6
    d = np.array(x) - np.mean(x)
    var = d @ d / 12 + 2 * sum((1 - lag / 6) * (d[lag:] @ d[:-lag]) / 12 for lag in range(1, 6))
    assert se == pytest.approx(math.sqrt(var / 12))


def test_newey_west_autocorrelated_series_has_a_larger_error_than_iid():
    rng = np.random.default_rng(1)
    e = rng.normal(size=400)
    x = np.convolve(e, np.ones(4) / 2, mode="valid")  # strongly autocorrelated
    _, se_nw, _ = stats.newey_west(x)
    assert se_nw > x.std(ddof=0) / math.sqrt(len(x)) * 1.5


def test_newey_west_degenerate_inputs():
    assert stats.newey_west(np.zeros(0)) == (0.0, 0.0, 0.0)
    assert stats.newey_west(np.array([2.0])) == (2.0, 0.0, 0.0)
    assert stats.newey_west(np.full(10, 3.0))[2] == 0.0  # no variance: t is 0, not infinity
    m, se, t = stats.newey_west(np.array([1.0, 2.0, 4.0]))  # fewer observations than lags
    assert se > 0 and t == pytest.approx(m / se)


def test_normal_sf():
    assert stats.normal_sf(0.0) == pytest.approx(0.5)
    assert stats.normal_sf(1.6448536269514722) == pytest.approx(0.05, abs=1e-9)


def batch(exit_ts, net, flag=None, side=1, miss=0, unfilled=0, nsettle=1, cost=2.0, ties=0):
    n = len(exit_ts)
    z = np.zeros(n)
    return fills.TradeBatch(
        j=np.arange(n),
        side=np.full(n, side, np.int8),
        entry_ts=np.asarray(exit_ts, np.int64) - 1000,
        exit_ts=np.asarray(exit_ts, np.int64),
        entry_px=z + 100,
        exit_px=z + 100,
        gross=np.asarray(net, float),
        fund=z,
        net=np.asarray(net, float),
        flag=np.zeros(n, bool) if flag is None else np.asarray(flag, bool),
        miss=np.full(n, miss, np.int64),
        nsettle=np.full(n, nsettle, np.int64),
        cost=np.full(n, cost),
        ties=np.full(n, ties, np.int64),
        unfilled=unfilled,
    )


CFG = lock.GRID[0]


def test_daily_series_zero_fills_and_buckets_by_exit_day():
    acc = stats.ConfigAcc(CFG, D0, 6)
    acc.add(7, batch([D0 + DAY + 5, D0 + 2 * DAY - 1, D0 + 2 * DAY, D0 + 4 * DAY + 100], [0.001, 0.002, -0.004, 0.01]))
    out = acc.finalize()
    # every configuration has the whole span as its series: days 0 to 5, sums 0, 0.003, -0.004, 0, 0.01, 0
    mean, se, t = hand_newey_west([0.0, 0.003, -0.004, 0.0, 0.01, 0.0])
    assert out["days"] == 6
    assert out["mean_daily_net"] == pytest.approx(mean)
    assert out["t"] == pytest.approx(t)
    assert out["trades"] == 4
    assert out["mean_net_bps"] == pytest.approx((0.001 + 0.002 - 0.004 + 0.01) / 4 * 1e4)
    assert out["entries_per_hour"] == pytest.approx(4 / (6 * 24))
    assert out["class"] == "slow"


def test_class_desk_and_counters():
    acc = stats.ConfigAcc(CFG, D0, 2)
    n = 500
    acc.add(1, batch(np.full(n, D0 + 100), np.full(n, 0.0001), flag=np.arange(n) < 7, miss=1, unfilled=3))
    out = acc.finalize()
    assert out["class"] == "desk"  # 500 trades in 48 hours = 10.4 per hour
    assert out["flagged_exits"] == 7 and out["missing_funding"] == n and out["unfilled"] == 3


def test_a_config_with_no_trade_has_a_zero_series_and_no_mean():
    out = stats.ConfigAcc(CFG, D0, 3).finalize()
    assert out["trades"] == 0 and out["t"] == 0.0 and out["mean_net_bps"] is None
    assert out["days"] == 3 and out["pos_month_share"] is None and out["pos_market_share"] is None


def test_month_and_market_shares():
    acc = stats.ConfigAcc(CFG, D0, 90)  # 1 July to 28 September 2025
    days = [D0 + 5 * DAY, D0 + 40 * DAY, D0 + 70 * DAY]  # July, August, September
    acc.add(1, batch([days[0]] * 150, np.full(150, 0.001)))  # market 1: 150 winners
    acc.add(2, batch([days[1]] * 120, np.full(120, -0.001)))  # market 2: 120 losers
    acc.add(3, batch([days[2]] * 50, np.full(50, 0.01)))  # market 3: positive but under 100 trades
    out = acc.finalize()
    months = {m["month"]: m for m in out["months"]}
    assert months["2025-07"]["trades"] == 150 and months["2025-08"]["net"] == pytest.approx(-0.12)
    assert out["pos_month_share"] == pytest.approx(2 / 3)
    assert out["markets_100"] == 2 and out["pos_market_share"] == 0.5


def test_a_trade_outside_the_span_is_an_error():
    acc = stats.ConfigAcc(CFG, D0, 2)
    with pytest.raises(ValueError):
        acc.add(1, batch([D0 + 2 * DAY], [0.1]))


# ----------------------------------------------------------------------------------------------------------------
# Noise control


def test_noise_offsets_are_twenty_distinct_values_from_the_registered_generator():
    offsets = [stats.noise_offset_days(s) for s in lock.NOISE_SEEDS]
    assert len(offsets) == 20 and len(set(offsets)) == 20  # distinct
    assert all(lock.NOISE_MIN_DAYS <= d <= lock.NOISE_MAX_DAYS for d in offsets)
    want = np.random.default_rng(20261111).choice(np.arange(7, 61), size=20, replace=False)
    assert offsets == [int(x) for x in want]
    assert offsets == lock.noise_offsets()


def test_signflip_is_an_independent_fair_sign_per_decision_inside_the_span_only():
    sides = np.zeros(20 * 288, dtype=np.int8)
    sides[600:] = 1
    a = stats.signflip(sides, stats.signflip_rng(3), 576)
    b = stats.signflip(sides, stats.signflip_rng(3), 576)
    c = stats.signflip(sides, stats.signflip_rng(4), 576)
    assert np.array_equal(a, b) and not np.array_equal(a, c)  # reproducible from the seed, different across runs
    assert np.array_equal(a[:576], sides[:576])  # the warm-up is untouched
    assert set(np.unique(a[600:])) == {-1, 1}
    assert abs(a[600:].mean()) < 0.06  # fair: 5,000 draws
    assert (a[576:600] == 0).all()  # zero stays zero


def test_shift_is_circular_within_the_span_and_common():
    rng = np.random.default_rng(4)
    ng = 90 * 288
    sides = rng.choice([-1, 0, 1], ng, p=[0.1, 0.8, 0.1]).astype(np.int8)
    start_j = 576
    d = stats.noise_offset_days(3)
    out = stats.shift_sides(sides, start_j, d)
    assert np.array_equal(out[:start_j], sides[:start_j])  # warm-up untouched
    assert np.array_equal(out[start_j:], np.roll(sides[start_j:], d * 288))
    assert sorted(out[start_j:].tolist()) == sorted(sides[start_j:].tolist())  # a pure re-ordering: circular
    # the point at the start of the span now holds what was d days before the end of the span
    assert out[start_j] == sides[ng - d * 288]
    # common across markets: the same D on every market
    other = rng.choice([-1, 0, 1], ng - 100).astype(np.int8)
    out2 = stats.shift_sides(other, start_j, d)
    assert out2[start_j] == other[len(other) - d * 288]


def test_shift_keeps_the_funding_phase():
    ng = 90 * 288
    sides = np.zeros(ng, dtype=np.int8)
    sides[11::12] = 1  # grid points at minute-of-hour 55
    out = stats.shift_sides(sides, 576, 17)  # a span of whole days, as in the study
    assert ((np.flatnonzero(out[576:]) + 576) % 12 == 11).all()
    assert out[576:].sum() == sides[576:].sum()


def test_noise_bar_is_the_largest_of_the_maxima():
    maxima = [float(x) for x in range(1, 21)]
    assert stats.noise_bar(maxima) == 20.0
    assert stats.noise_bar([2.0] * 20) == 2.0
    assert stats.noise_bar([-3.0, -1.0]) == -1.0


# ----------------------------------------------------------------------------------------------------------------
# Passing rules


def good(**over):
    base = {
        "id": "F1-x",
        "family": "F1",
        "mean_net_bps": 1.0,
        "t": 4.0,
        "pos_month_share": 0.8,
        "months_with_trades": 8,
        "pos_market_share": 0.7,
        "markets_100": 6,
        "trades": 2500,
        "flagged_exits": 0,
        "missing_funding_share": 0.0,
        "class": "slow",
    }
    base.update(over)
    return base


def test_each_development_item_can_fail_on_its_own():
    assert stats.dev_flags(good(), 0.0)["pass"]
    assert not stats.dev_flags(good(mean_net_bps=0.0), 0.0)["a"]
    assert not stats.dev_flags(good(mean_net_bps=None), 0.0)["a"]
    assert not stats.dev_flags(good(t=2.99), 0.0)["b"]
    assert stats.dev_flags(good(t=3.0), 0.0)["b"]
    assert not stats.dev_flags(good(t=3.5), 3.6)["b"]  # the noise bar above 3 takes over
    assert stats.dev_flags(good(t=3.6), 3.6)["b"]
    assert not stats.dev_flags(good(pos_month_share=0.69), 0.0)["c"]
    assert stats.dev_flags(good(pos_month_share=0.70), 0.0)["c"]
    assert not stats.dev_flags(good(pos_month_share=None), 0.0)["c"]
    assert not stats.dev_flags(good(months_with_trades=5), 0.0)["c"]  # fewer than 6 months with a trade
    assert stats.dev_flags(good(months_with_trades=6), 0.0)["c"]
    assert not stats.dev_flags(good(pos_market_share=0.59), 0.0)["d"]
    assert stats.dev_flags(good(pos_market_share=0.60), 0.0)["d"]
    assert not stats.dev_flags(good(pos_market_share=None), 0.0)["d"]
    assert not stats.dev_flags(good(markets_100=4), 0.0)["d"]  # fewer than 5 markets with 100 trades
    assert stats.dev_flags(good(markets_100=5), 0.0)["d"]
    assert not stats.dev_flags(good(trades=1999), 0.0)["e"]
    assert stats.dev_flags(good(trades=2000), 0.0)["e"]
    assert stats.dev_flags(good(trades=2500, flagged_exits=25), 0.0)["f"]  # exactly 1%
    assert not stats.dev_flags(good(trades=2500, flagged_exits=26), 0.0)["f"]
    cases = {
        "a": {"mean_net_bps": -1},
        "b": {"t": 1},
        "c": {"pos_month_share": 0.1},
        "d": {"pos_market_share": 0.1},
        "e": {"trades": 5},
        "f": {"flagged_exits": 500},
    }
    for item, over in cases.items():
        flags = stats.dev_flags(good(**over), 0.0)
        assert not flags[item] and not flags["pass"]


def test_item_b_uses_the_f6_bar_for_f6_and_the_noise_bar_for_the_rest():
    f6 = good(family="F6", t=5.0)
    f1 = good(family="F1", t=5.0)
    assert stats.dev_flags(f6, 6.0, 4.0)["b"] and not stats.dev_flags(f1, 6.0, 4.0)["b"]
    assert not stats.dev_flags(f6, 4.0, 6.0)["b"] and stats.dev_flags(f1, 4.0, 6.0)["b"]


def test_tripwire():
    assert not stats.is_suspect(good())
    assert stats.is_suspect(good(mean_net_bps=5.01))
    assert not stats.is_suspect(good(mean_net_bps=5.0))
    assert stats.is_suspect(good(t=8.01))
    assert not stats.is_suspect(good(t=8.0))
    assert not stats.is_suspect(good(mean_net_bps=None, t=0.0))


def checked(*ids):
    return {i: stats.variant_checks(1.0, -1.0, 0.5) for i in ids}


def test_finalists_are_one_per_family_desk_first_at_most_three():
    stats_list = [
        good(id="F1-slow", family="F1", t=7.9, **{"class": "slow"}),
        good(id="F1-desk", family="F1", t=5.0, **{"class": "desk"}),  # desk wins inside the family
        good(id="F2-a", family="F2", t=4.0),
        good(id="F2-b", family="F2", t=6.0),  # best slow of F2
        good(id="F3-a", family="F3", t=3.5),
        good(id="F4-a", family="F4", t=3.2),
        good(id="F5-fail", family="F5", t=50.0, trades=10),  # does not pass
        good(id="F6-a", family="F6", t=3.1),
    ]
    cand = stats.finalist_candidates(stats_list, 0.0, 0.0)
    ids = [c["id"] for c in cand]
    assert "F5-fail" not in ids
    got = [s["id"] for s in stats.select_finalists(cand, checked(*ids))]
    assert got == ["F2-b", "F1-desk", "F3-a"]
    assert stats.select_finalists([]) == []
    # a noise bar of 5.5 knocks out the desk configuration (t 5), so the slow one of F1 is the family best
    cand2 = stats.finalist_candidates(stats_list, 5.5, 5.5)
    got = [s["id"] for s in stats.select_finalists(cand2, checked(*[c["id"] for c in cand2]))]
    assert got == ["F1-slow", "F2-b"]


def test_finalists_need_the_mirror_and_the_doubled_spread_and_funding_coverage_and_no_unaudited_suspect():
    a = good(id="F1-a", family="F1", t=5.0)
    cand = stats.finalist_candidates([a], 0.0, 0.0)
    ok = {"F1-a": stats.variant_checks(2.0, 0.0, 0.5)}  # (2 - 0) / 2 = 1 > 0, doubled mean 0.5 > 0
    assert [s["id"] for s in stats.select_finalists(cand, ok)] == ["F1-a"]
    no_mirror = {"F1-a": stats.variant_checks(2.0, 2.0, 0.5)}  # (2 - 2) / 2 = 0: no directional edge
    assert stats.select_finalists(cand, no_mirror) == []
    assert stats.select_finalists(cand, {"F1-a": stats.variant_checks(1.0, 3.0, 0.5)}) == []  # the mirror does better
    no_double = {"F1-a": stats.variant_checks(2.0, 0.0, -0.1)}
    assert stats.select_finalists(cand, no_double) == []
    assert stats.finalist_candidates([good(id="F1-m", missing_funding_share=0.0101)], 0.0, 0.0) == []
    assert len(stats.finalist_candidates([good(id="F1-m", missing_funding_share=0.01)], 0.0, 0.0)) == 1
    suspect = good(id="F1-s", t=8.5)
    assert stats.finalist_candidates([suspect], 0.0, 0.0) == []
    assert len(stats.finalist_candidates([suspect], 0.0, 0.0, cleared=("F1-s",))) == 1


def test_the_mirror_diagnostic_must_beat_the_modelled_fill_cost():
    # (3 - (-1)) / 2 = 2 bps of directional edge
    assert stats.variant_checks(3.0, -1.0, 1.0, cost_bps=1.9)["mirror_ok"]
    assert not stats.variant_checks(3.0, -1.0, 1.0, cost_bps=2.0)["mirror_ok"]  # equal is not enough
    assert not stats.variant_checks(3.0, -1.0, 1.0, cost_bps=3.5)["mirror_ok"]
    c = stats.variant_checks(3.0, -1.0, 1.0, cost_bps=1.5)
    assert c["mean_fill_cost_bps"] == 1.5 and c["mirror_diagnostic_bps"] == 2.0


def test_variant_checks_formula():
    c = stats.variant_checks(3.0, -1.0, 1.0)
    assert c["mirror_diagnostic_bps"] == 2.0 and c["mirror_ok"] and c["doubled_ok"]
    c = stats.variant_checks(None, 1.0, 1.0)
    assert c["mirror_diagnostic_bps"] is None and not c["mirror_ok"]
    assert not stats.variant_checks(1.0, 1.0, None)["doubled_ok"]


def test_no_funding_trades_are_counted_kept_out_of_the_missing_share_and_the_mean_without_them_is_exact():
    cfg = next(c for c in lock.GRID if c.family == "F1")
    acc = stats.ConfigAcc(cfg, D0, 4)
    # market 1 has funding: two trades, one missing settlement of two crossed
    acc.add(1, batch([D0 + 10, D0 + DAY + 10], [0.0010, 0.0020], miss=1, nsettle=2))
    # market 2 is a no-funding market: its settlements are all "missing" in the engine and must not count
    acc.add(2, batch([D0 + 2 * DAY + 10, D0 + 3 * DAY + 10], [-0.0050, 0.0040], miss=5, nsettle=5), no_funding=True)
    out = acc.finalize()
    assert out["trades"] == 4 and out["no_funding_trades"] == 2 and out["trades_ex_no_funding"] == 2
    assert out["missing_funding"] == 2 and out["settlements_crossed"] == 4  # market 1 only: 1 + 1 of 2 + 2
    assert out["missing_funding_share"] == pytest.approx(0.5)
    assert out["mean_net_bps"] == pytest.approx((0.0010 + 0.0020 - 0.0050 + 0.0040) / 4 * 1e4)
    assert out["mean_net_ex_no_funding_bps"] == pytest.approx((0.0010 + 0.0020) / 2 * 1e4)  # 15 bps by hand
    # every trade in no-funding markets: nothing is left, the mean without them is undefined
    only = stats.ConfigAcc(cfg, D0, 4)
    only.add(2, batch([D0 + 10], [0.0030]), no_funding=True)
    got = only.finalize()
    assert got["trades_ex_no_funding"] == 0 and got["mean_net_ex_no_funding_bps"] is None
    assert got["missing_funding_share"] == 0.0
    # no no-funding trades: the mean without them is the mean
    plain = stats.ConfigAcc(cfg, D0, 4)
    plain.add(1, batch([D0 + 10], [0.0030]))
    assert plain.finalize()["mean_net_ex_no_funding_bps"] == pytest.approx(30.0)


def test_a_configuration_that_profits_only_from_a_no_funding_market_is_not_a_finalist_and_does_not_confirm():
    a = good(id="F1-a", family="F1", t=5.0)
    cand = stats.finalist_candidates([a], 0.0, 0.0)
    # mean +3 bps overall, but -1 bps once the no-funding market's 50 trades are removed
    bad = stats.variant_checks(3.0, -3.0, 2.0, 0.5, no_funding_trades=50, mean_ex_no_funding=-1.0)
    assert bad["mirror_ok"] and bad["doubled_ok"] and not bad["no_funding_ok"]
    assert bad["no_funding_trades"] == 50 and bad["mean_net_ex_no_funding_bps"] == -1.0
    assert stats.select_finalists(cand, {"F1-a": bad}) == []
    fine = stats.variant_checks(3.0, -3.0, 2.0, 0.5, no_funding_trades=50, mean_ex_no_funding=0.4)
    assert fine["no_funding_ok"] and [s["id"] for s in stats.select_finalists(cand, {"F1-a": fine})] == ["F1-a"]
    # nothing left once they are removed counts as failing, no no-funding trades passes trivially
    assert not stats.variant_checks(3.0, -3.0, 2.0, 0.5, no_funding_trades=9, mean_ex_no_funding=None)["no_funding_ok"]
    assert stats.variant_checks(3.0, -3.0, 2.0, 0.5)["no_funding_ok"]
    # the same condition blocks a confirmation
    months = [{"month": f"2026-{m:02d}", "net": 1.0, "trades": 10} for m in (7, 8, 9, 10)]
    ok = stats.confirm_flags(good(t=3.0, months=months), stats.variant_checks(3.0, -3.0, 2.0, 0.5))
    assert ok["pre_holm_ok"]
    blocked = stats.confirm_flags(good(t=3.0, months=months), bad)
    assert not blocked["checks_ok"] and not blocked["pre_holm_ok"] and blocked["no_funding_ok"] is False


def test_holm_with_one_two_and_three_finalists():
    assert stats.holm({"a": 0.049}) == {"a": True}
    assert stats.holm({"a": 0.05}) == {"a": False}
    # two: the smallest needs p < 0.025, then the next p < 0.05
    assert stats.holm({"a": 0.01, "b": 0.04}) == {"a": True, "b": True}
    assert stats.holm({"a": 0.026, "b": 0.04}) == {"a": False, "b": False}  # stops at the first failure
    assert stats.holm({"a": 0.01, "b": 0.06}) == {"a": True, "b": False}
    # three: 0.05/3, 0.05/2, 0.05
    assert stats.holm({"a": 0.016, "b": 0.02, "c": 0.04}) == {"a": True, "b": True, "c": True}
    assert stats.holm({"a": 0.016, "b": 0.03, "c": 0.04}) == {"a": True, "b": False, "c": False}
    assert stats.holm({"a": 0.03, "b": 0.001, "c": 0.04}) == {"a": False, "b": True, "c": False}  # stops at a
    assert stats.holm({"a": 0.0166, "b": 0.0, "c": 0.049}) == {"a": True, "b": True, "c": True}
    assert stats.holm({}) == {}


def test_confirmation_rules_and_holm_over_the_finalists():
    months = [{"month": f"2026-{m:02d}", "net": v, "trades": 10} for m, v in ((7, 1.0), (8, -1.0), (9, 2.0), (10, 3.0))]
    checks = stats.variant_checks(2.0, 0.0, 0.5)
    ok = stats.confirm_flags(good(t=2.5, months=months), checks)
    assert ok["pre_holm_ok"] and ok["positive_months"] == 3 and ok["checks_ok"]
    assert ok["p_one_sided"] == pytest.approx(stats.normal_sf(2.5))
    # months, mean and the two checks each block
    two = [dict(m) for m in months]
    two[3]["net"] = -1.0
    assert not stats.confirm_flags(good(t=3.0, months=two), checks)["months_ok"]
    assert not stats.confirm_flags(good(t=3.0, mean_net_bps=-0.1, months=months), checks)["pre_holm_ok"]
    assert not stats.confirm_flags(good(t=3.0, months=months[:2]), checks)["pre_holm_ok"]
    assert not stats.confirm_flags(good(t=3.0, months=months), stats.variant_checks(2.0, 2.0, 0.5))["pre_holm_ok"]
    assert not stats.confirm_flags(good(t=3.0, months=months), stats.variant_checks(2.0, 0.0, -0.5))["pre_holm_ok"]
    # Holm: with two finalists the smaller p must beat 0.025 (t > 1.96)
    one = stats.confirm_flags(good(t=2.0, months=months), checks)
    other = stats.confirm_flags(good(t=1.7, months=months), checks)
    flags = {"x": one, "y": other}
    stats.apply_holm(flags)
    assert flags["x"]["pass"] and flags["y"]["pass"]  # p 0.0228 < 0.025, then p 0.0446 < 0.05
    flags = {"x": stats.confirm_flags(good(t=1.9, months=months), checks), "y": other}
    stats.apply_holm(flags)
    assert not flags["x"]["pass"] and not flags["y"]["pass"]  # 0.0287 is not < 0.025: nothing passes
    single = {"x": stats.confirm_flags(good(t=1.7, months=months), checks)}
    stats.apply_holm(single)
    assert single["x"]["pass"]  # alone, p 0.0446 < 0.05


def test_by_source_split_and_trigger_rate():
    cfg = next(c for c in lock.GRID if c.family == "F4")
    acc = stats.ConfigAcc(cfg, D0, 4)
    acc.add(
        1, batch([D0 + 10, D0 + DAY + 10, D0 + 2 * DAY + 10], [0.001, -0.002, 0.003]), np.array([True, False, True])
    )
    acc.add_trigger(30, 100)
    acc.add_trigger(10, 100)
    out = acc.finalize()
    assert out["trades"] == 3 and out["trigger_rate"] == 0.2 and out["trigger_valid_points"] == 200
    assert out["by_source"]["binance"]["trades"] == 2
    assert out["by_source"]["binance"]["mean_net_bps"] == pytest.approx(20.0)  # (0.001 + 0.003) / 2 in bps
    assert out["by_source"]["lighter"]["trades"] == 1
    assert out["by_source"]["lighter"]["mean_net_bps"] == pytest.approx(-20.0)
    assert out["by_source"]["binance"]["trades"] + out["by_source"]["lighter"]["trades"] == out["trades"]
    assert out["missing_funding_share"] == 0.0 and out["flagged_share"] == 0.0


def test_missing_funding_share_counts_settlements_crossed():
    acc = stats.ConfigAcc(CFG, D0, 2)
    acc.add(1, batch([D0 + 10] * 4, [0.0] * 4, miss=1, nsettle=3))
    out = acc.finalize()
    assert out["missing_funding"] == 4 and out["settlements_crossed"] == 12
    assert out["missing_funding_share"] == pytest.approx(1 / 3)


def trades_dict(rows):
    """rows: (market, side, entry_min, exit_min, entry_px, exit_px, fund)."""
    arr = {
        "market_id": np.array([r[0] for r in rows]),
        "side": np.array([r[1] for r in rows]),
        "entry_ts": np.array([D0 + r[2] * MIN for r in rows], np.int64),
        "exit_ts": np.array([D0 + r[3] * MIN for r in rows], np.int64),
        "entry_px": np.array([r[4] for r in rows], float),
        "exit_px": np.array([r[5] for r in rows], float),
        "fund": np.array([r[6] for r in rows], float),
    }
    return arr


def flat_mids(markets, n=400, level=100.0):
    return {m: (D0, np.full(n, level)) for m in markets}


def test_account_single_winner_and_the_notional_rule():
    t = trades_dict([(1, 1, 10, 20, 100.0, 101.0, 0.0)])
    out = stats.simulate_account(t, flat_mids([1]), 10)
    # equity 100 x 10 / 10 = 100 USD notional, +1% = +1 USD
    assert out["final_equity"] == pytest.approx(101.0)
    assert out["entries_taken"] == 1 and out["entries_skipped"] == 0 and not out["liquidated"]
    out3 = stats.simulate_account(t, flat_mids([1]), 3)
    assert out3["final_equity"] == pytest.approx(100.0 + 30.0 * 0.01)  # notional 30


def test_account_funding_and_shorts():
    t = trades_dict([(1, -1, 10, 20, 100.0, 99.0, -0.001)])  # a short that received funding
    out = stats.simulate_account(t, flat_mids([1]), 10)
    assert out["final_equity"] == pytest.approx(100.0 + 100.0 * (0.01 + 0.001))


def test_account_skips_at_ten_positions():
    rows = [(m, 1, 10, 30, 100.0, 100.0, 0.0) for m in range(1, 13)]
    out = stats.simulate_account(trades_dict(rows), flat_mids(range(1, 13)), 10)
    assert out["entries_taken"] == 10 and out["entries_skipped"] == 2


def test_account_skips_when_equity_is_too_small_for_the_minimum_notional():
    mids = {1: (D0, np.full(400, 100.0))}
    # 10x: a 92% loss leaves 8 USD, and 8 x 10 / 10 = 8 < 10: the next entry is skipped
    rows = [(1, 1, 10, 20, 100.0, 8.0, 0.0), (1, 1, 30, 40, 100.0, 100.0, 0.0)]
    out = stats.simulate_account(trades_dict(rows), mids, 10)
    assert out["entries_taken"] == 1 and out["entries_skipped"] == 1
    assert out["final_equity"] == pytest.approx(8.0)
    # a 90% loss leaves exactly 10 USD: equity x L / 10 = 10 is not below the minimum, so the entry is taken
    rows = [(1, 1, 10, 20, 100.0, 10.0, 0.0), (1, 1, 30, 40, 100.0, 100.0, 0.0)]
    out = stats.simulate_account(trades_dict(rows), mids, 10)
    assert out["entries_taken"] == 2 and out["entries_skipped"] == 0
    assert out["final_equity"] == pytest.approx(10.0)


def test_account_liquidation_and_minimum_equity():
    # 20x: notional 200. The mark falls 60% at minute 15: equity -20, below 1.2% of notional: liquidated
    mid = np.full(400, 100.0)
    mid[15:] = 40.0
    t = trades_dict([(1, 1, 10, 30, 100.0, 40.0, 0.0)])
    out = stats.simulate_account(t, {1: (D0, mid)}, 20)
    assert out["liquidated"] and out["final_equity"] == 0.0 and out["min_equity"] < 0
    # a mild dip is marked each minute and shows up in the minimum equity but not in a liquidation
    mid = np.full(400, 100.0)
    mid[12:15] = 99.0
    t = trades_dict([(1, 1, 10, 30, 100.0, 100.0, 0.0)])
    out = stats.simulate_account(t, {1: (D0, mid)}, 10)
    assert not out["liquidated"] and out["min_equity"] == pytest.approx(99.0)
    assert out["final_equity"] == pytest.approx(100.0)


def test_account_with_no_trades():
    out = stats.simulate_account(trades_dict([]), {}, 10)
    assert out["final_equity"] == 100.0 and out["entries_taken"] == 0


def test_majority_source_condition_for_candidates_and_for_confirmation():
    good_src = good(id="F1-a", majority_source="binance", majority_source_mean_net_bps=0.4)
    bad_src = good(id="F1-b", majority_source="binance", majority_source_mean_net_bps=-0.1)
    assert [c["id"] for c in stats.finalist_candidates([good_src, bad_src], 0.0, 0.0)] == ["F1-a"]
    months = [{"month": f"2026-{m:02d}", "net": 1.0, "trades": 10} for m in (7, 8, 9, 10)]
    checks = stats.variant_checks(2.0, 0.0, 0.5, 0.5)
    stat = good(t=3.0, months=months, by_source={"binance": {"mean_net_bps": -0.5}, "lighter": {"mean_net_bps": 2.0}})
    assert not stats.confirm_flags(stat, checks, "binance")["pre_holm_ok"]  # positive overall, negative in its source
    assert stats.confirm_flags(stat, checks, "lighter")["pre_holm_ok"]
    assert stats.confirm_flags(stat, checks)["source_ok"]  # no development source given: not applied


def test_majority_source_class_split_cost_and_ties_in_finalize():
    cfg = next(c for c in lock.GRID if c.family == "F2")
    acc = stats.ConfigAcc(cfg, D0, 3)
    acc.add(1, batch([D0 + 10] * 3, [0.001] * 3, cost=1.0, ties=1), np.array([True, True, False]), "crypto")
    acc.add(2, batch([D0 + 20] * 2, [-0.001] * 2, cost=3.0, ties=0), np.array([False, False]), "tradfi")
    out = stats.ConfigAcc.finalize(acc)
    assert out["by_source"]["binance"]["trades"] == 2 and out["by_source"]["lighter"]["trades"] == 3
    assert out["majority_source"] == "lighter"
    assert out["majority_source_mean_net_bps"] == pytest.approx((10 - 20) / 3)
    assert out["by_class"]["crypto"]["trades"] == 3 and out["by_class"]["tradfi"]["trades"] == 2
    assert "unclassified" not in out["by_class"]
    assert out["mean_fill_cost_bps"] == pytest.approx((3 * 1.0 + 2 * 3.0) / 5)
    assert out["tie_share"] == pytest.approx(3 / 10)  # three ties over ten fills
    f1 = stats.ConfigAcc(next(c for c in lock.GRID if c.family == "F1"), D0, 3)
    f1.add(1, batch([D0 + 10], [0.001]), None, "crypto")
    assert "by_class" not in f1.finalize()
