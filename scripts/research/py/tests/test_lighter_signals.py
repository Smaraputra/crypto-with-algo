"""Tests for lighter/signals.py: the six families against a literal per-point reference, hand-built triggers and the
look-ahead guard. Synthetic inputs only."""

from __future__ import annotations

import copy
import datetime as dt
import math

import numpy as np
import pytest

from lighter import fold_trades as ft
from lighter import lock, signals
from lighter.data import Market
from lighter.synthetic import blank_minute_data, random_minute_data

DAY = 86_400_000
MIN = 60_000
T0 = ft.day_start_ms(dt.date(2025, 6, 29))
START_MS = T0 + 2 * DAY
DAYS = 4
NG = DAYS * 288
START_J = (START_MS - T0) // lock.GRID_MS

NAN = float("nan")


def market(coin, mid, tier="A", binance=True):
    return Market(coin, mid, 4)


def funding_rows(t0_ms, hours, seed=3, sd=2e-4):
    rng = np.random.default_rng(seed)
    ts = (t0_ms // lock.HOUR_MS + np.arange(hours)) * lock.HOUR_MS
    return ts.astype(np.int64), rng.normal(0, sd, hours)


# ----------------------------------------------------------------------------------------------------------------
# Literal reference implementation of the specification, one grid point at a time.


class Ref:
    def __init__(self, md, source):
        self.md = md
        self.source = source
        self._close = {}
        self._r1 = {}
        self._sigma = {}

    def mid(self, m):
        md = self.md
        while m >= 0:
            lb, ls, lp = md.last_buy_px[m], md.last_sell_px[m], md.last_px[m]
            if not math.isnan(lb) and not math.isnan(ls):
                return (lb + ls) / 2
            if not math.isnan(lp):
                return lp
            m -= 1
        return NAN

    def close(self, j):
        if j in self._close:
            return self._close[j]
        md = self.md
        out = NAN
        if j >= 1:
            minutes = range(5 * j - 5, 5 * j)
            if self.source == "binance":
                if all(md.b_has[m] for m in minutes):
                    out = md.b_close[5 * j - 1]
            elif any(not math.isnan(md.last_px[m]) for m in minutes):
                out = self.mid(5 * j - 1)
        self._close[j] = out
        return out

    def r(self, j, k):
        if j - k < 0:
            return NAN
        a, b = self.close(j), self.close(j - k)
        if math.isnan(a) or math.isnan(b) or a <= 0 or b <= 0:
            return NAN
        return math.log(a / b)

    def sigma(self, j):
        if j in self._sigma:
            return self._sigma[j]
        vals = [self.r(i, 1) for i in range(j - 287, j + 1)]
        vals = [v for v in vals if not math.isnan(v)]
        out = float(np.std(vals, ddof=1)) if len(vals) >= 260 else NAN
        self._sigma[j] = out
        return out

    def z(self, j, k):
        s = self.sigma(j)
        r = self.r(j, k)
        if math.isnan(s) or math.isnan(r) or s <= 0:
            return NAN
        return r / (s * math.sqrt(k))

    def flow(self, j, k, inp):
        md = self.md
        minutes = range(5 * (j - k), 5 * j)
        if j - k < 0:
            return NAN
        if inp == "binance":
            if not all(md.b_has[m] for m in minutes):
                return NAN
            b = sum(md.b_tbq[m] for m in minutes)
            s = sum(md.b_qv[m] - md.b_tbq[m] for m in minutes)
        elif inp == "small":
            b = sum(md.buy_small[m] for m in minutes)
            s = sum(md.sell_small[m] for m in minutes)
        else:
            b = sum(md.buy_large[m] for m in minutes)
            s = sum(md.sell_large[m] for m in minutes)
        if b + s <= 0:
            return NAN
        return (b - s) / (b + s)

    def lp(self, m):
        md = self.md
        if m < 0:
            return NAN
        lb, ls, lpx = md.last_buy_px[m], md.last_sell_px[m], md.last_px[m]
        lighter = (lb + ls) / 2 if not math.isnan(lb) and not math.isnan(ls) else lpx
        stamps = [t for t in (md.last_buy_ts[m], md.last_sell_ts[m]) if not math.isnan(t)]
        if math.isnan(lighter) or not md.b_has[m] or not stamps:
            return NAN
        end = md.t0_ms + (m + 1) * MIN
        if max(stamps) < end - 10_000 or max(stamps) >= end - 500:
            return NAN
        return math.log(lighter / md.b_close[m])


def ref_f1(ref, k, theta, ng=NG, start_j=START_J):
    out = np.zeros(ng, dtype=np.int8)
    for j in range(start_j, ng):
        z = ref.z(j, k)
        if not math.isnan(z) and abs(z) >= theta:
            out[j] = -1 if z > 0 else 1
    return out


def ref_f4(ref, k, q, inp, direction, ng=NG, start_j=START_J):
    out = np.zeros(ng, dtype=np.int8)
    cache = {}

    def flow(j):
        if j not in cache:
            cache[j] = ref.flow(j, k, inp)
        return cache[j]

    for j in range(start_j, ng):
        cur = flow(j)
        window = [flow(i) for i in range(j - 288, j)]
        window = [v for v in window if not math.isnan(v)]
        if math.isnan(cur) or len(window) < 260:
            continue
        hi = np.quantile(window, q)
        lo = np.quantile(window, 1 - q)
        upper, lower = cur >= hi, cur <= lo
        if upper and lower:
            continue
        sign = 1 if direction == "follow" else -1
        if upper:
            out[j] = sign
        elif lower:
            out[j] = -sign
    return out


def ref_f5(ref, theta, variant, ng=NG, start_j=START_J):
    out = np.zeros(ng, dtype=np.int8)
    for j in range(start_j, ng):
        hist = [ref.lp(5 * i - 1) for i in range(j - 288, j)]
        hist = [v for v in hist if not math.isnan(v)]
        if len(hist) < 200:
            continue
        med = float(np.median(hist))
        now = ref.lp(5 * j - 1)
        if math.isnan(now):
            continue
        dev = (now - med) * 1e4
        if abs(dev) < theta:
            continue
        if variant == "persist":
            prev = ref.lp(5 * j - 2)
            if math.isnan(prev):
                continue
            dev2 = (prev - med) * 1e4
            if abs(dev2) < theta or (dev2 > 0) != (dev > 0):
                continue
        out[j] = -1 if dev > 0 else 1
    return out


def ref_f6(t0, ng, f_ts, f_rate, theta, start_j=START_J):
    out = np.zeros(ng, dtype=np.int8)
    for j in range(start_j, ng):
        g = t0 + j * lock.GRID_MS
        if (g // MIN) % 60 != 55:
            continue
        hour_start = g - g % lock.HOUR_MS
        rows = [r for t, r in zip(f_ts, f_rate, strict=True) if t == hour_start]
        if not rows:
            continue
        f = rows[0] * 1e4
        if f >= theta:
            out[j] = -1
        elif f <= -theta:
            out[j] = 1
    return out


@pytest.fixture(scope="module")
def panel():
    """Five markets with random fold-shaped minute data, one on the Lighter price source."""
    specs = [
        (market("BTC", 1, "A"), "binance"),
        (market("ETH", 2, "A"), "binance"),
        (market("SOL", 3, "A"), "binance"),
        (market("XRP", 4, "A"), "binance"),
        (market("XAU", 5, "B", binance=False), "lighter"),
    ]
    out = []
    for i, (m, source) in enumerate(specs):
        md = random_minute_data(m, T0, DAYS, seed=100 + i, binance=source == "binance")
        out.append((md, source))
    funding = funding_rows(T0 - 2 * lock.HOUR_MS, DAYS * 24 + 6)
    return out, funding


def xs_of(feats, needed=None, tiers=None):
    """F2 and F3 sides for one month in which every market of feats is eligible (tier A, XAU tier B by default)."""
    tiers = tiers or {}
    ng = feats[0].ng
    members = {
        f.market.market_id: (tiers.get(f.market.market_id, "B" if f.market.coin == "XAU" else "A"), f.source)
        for f in feats
    }
    by = {f.market.market_id: {f.source: f} for f in feats}
    month = signals.MonthSlice(feats[0].start_j, ng, members)
    return signals.cross_sectional_sides(by, [month], ng, needed)


def features_of(panel_data, needed=None):
    items, funding = panel_data
    return [signals.compute_features(md, src, START_MS, funding, needed) for md, src in items]


# ----------------------------------------------------------------------------------------------------------------


def test_mid_proxy_and_staleness():
    md = blank_minute_data(market("BTC", 1), T0, 10)
    md.last_buy_px[1], md.last_sell_px[1] = 100.0, 102.0
    md.last_px[1] = 102.0
    md.last_px[3] = 105.0
    md.last_buy_px[6], md.last_sell_px[6] = 110.0, 112.0
    md.last_px[6] = 110.0
    mid, stale = signals.mid_proxy(md)
    assert np.isnan(mid[0]) and stale[0] == -1
    assert mid[1] == 101.0 and stale[1] == 0
    assert mid[2] == 101.0 and stale[2] == 1
    assert mid[3] == 105.0 and stale[3] == 0
    assert mid[5] == 105.0 and stale[5] == 2
    assert mid[6] == 111.0
    assert mid[9] == 111.0 and stale[9] == 3


def test_grid_price_validity_rules():
    n = 30
    b = blank_minute_data(market("BTC", 1), T0, n)
    b.b_has[:] = True
    b.b_close[:] = np.arange(100.0, 100.0 + n)
    b.b_has[7] = False  # inside block 1 (minutes 5 to 9), which is the bar ending at grid point 2
    c5, v5 = signals.grid_prices(b, "binance")
    assert not v5[0] and v5[1] and not v5[2] and v5[3]
    assert c5[1] == 104.0 and c5[3] == 114.0  # close of the 1m bar with open_time g - 60 s

    lt = blank_minute_data(market("XAU", 2, binance=False), T0, n)
    lt.last_px[3] = 50.0  # one print in block 0
    lt.last_px[12] = 60.0  # one print in block 2
    c5, v5 = signals.grid_prices(lt, "lighter")
    assert v5[1] and not v5[2] and v5[3]
    assert c5[1] == 50.0 and c5[3] == 60.0


def test_log_returns_need_both_ends():
    c5 = np.array([np.nan, 100.0, 101.0, np.nan, 103.0, 104.0])
    v5 = ~np.isnan(c5)
    r3 = signals.log_returns(c5, v5, 3)
    assert np.isnan(r3[:4]).all()
    assert r3[4] == pytest.approx(math.log(103.0 / 100.0))
    assert r3[5] == pytest.approx(math.log(104.0 / 101.0))  # only the two end closes need to be valid


def test_trailing_quantiles_match_numpy():
    rng = np.random.default_rng(5)
    x = rng.normal(size=900)
    x[rng.random(900) < 0.1] = np.nan
    got = signals.trailing_quantiles(x, [0.5, 0.8, 0.2], 288, 260)
    for j in (288, 400, 650, 899):
        window = x[j - 288 : j]
        valid = window[~np.isnan(window)]
        for qi, q in enumerate([0.5, 0.8, 0.2]):
            if len(valid) >= 260:
                assert got[qi][j] == pytest.approx(np.quantile(valid, q), abs=1e-12)
            else:
                assert np.isnan(got[qi][j])
    assert np.isnan(got[0][:288]).all()


@pytest.mark.parametrize("k", lock.KS_REVERSAL)
def test_f1_matches_reference(panel, k):
    feats = features_of(panel)
    for (md, src), f in zip(panel[0], feats, strict=True):
        ref = Ref(md, src)
        for theta in lock.THETAS:
            sig = f"F1-k{k}-th{theta}"
            want = ref_f1(ref, k, theta)
            assert np.array_equal(f.sides[sig], want), (md.market.coin, sig)
        z = np.array([ref.z(j, k) for j in range(NG)])
        np.testing.assert_allclose(f.z[k][START_J:], z[START_J:], rtol=1e-6, equal_nan=True)
    assert any((f.sides[f"F1-k{k}-th1.0"] != 0).sum() > 20 for f in feats)


@pytest.mark.parametrize("inp", lock.FLOW_INPUTS)
def test_f4_matches_reference(panel, inp):
    feats = features_of(panel)
    checked = 0
    for (md, src), f in zip(panel[0], feats, strict=True):
        ref = Ref(md, src)
        for k in lock.KS_FLOW:
            for q in lock.QS_FLOW:
                for d in lock.FLOW_DIRECTIONS:
                    sig = f"F4-{inp}-k{k}-q{q}-{d}"
                    if inp == "binance" and src != "binance":
                        assert sig not in f.sides
                        continue
                    want = ref_f4(ref, k, q, inp, d)
                    assert np.array_equal(f.sides[sig], want), (md.market.coin, sig)
                    checked += int((want != 0).sum())
    assert checked > 200


def test_f4_ties_at_the_quantile_fire_and_the_trigger_rate_depends_on_them():
    """The rule is I >= the q quantile: when many reference values equal +1 the quantile is exactly +1 and every
    I = +1 fires. With a continuous input the share that fires is 2 (1 - q)."""
    rng = np.random.default_rng(4)
    ref = np.where(rng.random(288) < 0.6, 1.0, rng.uniform(-0.9, 0.9, 288))
    imb = np.concatenate([ref, [1.0, 0.99, 0.0, -0.95]])
    sides, valid = signals.flow_sides_valid(imb, 0.9, "follow")
    assert sides[288] == 1  # a tie with the quantile fires
    assert sides[289] == 0 and sides[290] == 0  # 0.99 is under a quantile of exactly 1, 0 is inside the band
    assert sides[291] == -1  # the lower tail still fires
    assert valid[288:292].all() and not valid[:288].any()
    smooth = rng.uniform(-1, 1, 4000)
    s2, v2 = signals.flow_sides_valid(smooth, 0.9, "follow")
    rate = float(np.count_nonzero(s2[v2])) / int(v2.sum())
    assert abs(rate - 0.2) < 0.03
    heavy = np.where(rng.random(4000) < 0.6, rng.choice([-1.0, 1.0], 4000), rng.uniform(-0.9, 0.9, 4000))
    s3, v3 = signals.flow_sides_valid(heavy, 0.9, "follow")
    assert float(np.count_nonzero(s3[v3])) / int(v3.sum()) > 0.5  # ties fire: far above the nominal 20%


def test_f4_follow_and_fade_are_opposites(panel):
    f = features_of(panel)[0]
    for inp in lock.FLOW_INPUTS:
        a = f.sides[f"F4-{inp}-k3-q0.8-follow"]
        b = f.sides[f"F4-{inp}-k3-q0.8-fade"]
        assert np.array_equal(a, -b)


def test_f4_trigger_on_hand_built_imbalance():
    ref_vals = np.linspace(-1.0, 1.0, 288)
    imb = np.concatenate([ref_vals, [0.95, -0.95, 0.0], ref_vals[:5]])
    follow = signals.flow_sides(imb, 0.8, "follow")
    fade = signals.flow_sides(imb, 0.8, "fade")
    # the reference of point 288 is exactly linspace(-1, 1, 288): its 0.8 quantile is 0.6, its 0.2 quantile -0.6
    assert follow[288] == 1 and fade[288] == -1
    assert follow[289] == -1 and fade[289] == 1
    assert follow[290] == 0 and fade[290] == 0
    assert (follow[:288] == 0).all()


def test_f4_imbalance_formula_by_hand():
    md = blank_minute_data(market("BTC", 1), T0, 40)
    md.b_has[:] = True
    md.b_tbq[:] = 3.0
    md.b_qv[:] = 5.0  # B = 3, S = 2 per minute
    got = signals.flow_imbalance(md, "binance", 3)
    assert got[3] == pytest.approx(0.2)  # B = 3, S = 2 each minute: (3 - 2) / 5
    md.b_has[7] = False  # block 1: windows containing block 1 are invalid
    got = signals.flow_imbalance(md, "binance", 3)
    assert np.isnan(got[2]) and np.isnan(got[3]) and np.isnan(got[4]) and not np.isnan(got[5])


def test_f4_small_window_edge_values():
    md = blank_minute_data(market("BTC", 1), T0, 40)
    md.buy_small[:] = 1.0
    md.sell_small[0:5] = 3.0
    small = signals.flow_imbalance(md, "small", 1)
    assert small[1] == pytest.approx((5 - 15) / 20)
    assert small[2] == pytest.approx(1.0)
    md.buy_small[:] = 0.0
    md.sell_small[:] = 0.0
    assert np.isnan(signals.flow_imbalance(md, "small", 1)[3])


def test_f5_matches_reference(panel):
    feats = features_of(panel)
    n_signals = 0
    for (md, src), f in zip(panel[0], feats, strict=True):
        ref = Ref(md, src)
        for theta in lock.GAP_THETAS_BPS:
            for variant in lock.GAP_VARIANTS:
                sig = f"F5-th{theta}-{variant}"
                if src != "binance":
                    assert sig not in f.sides
                    continue
                want = ref_f5(ref, theta, variant)
                assert np.array_equal(f.sides[sig], want), (md.market.coin, sig)
                n_signals += int((want != 0).sum())
    assert n_signals > 50


def _gap_md(base_bps=0.5, spike_j=700, spike_bps=5.0, prev_bps=None, stamp_offset=5_000):
    n = 4 * 1440
    md = blank_minute_data(market("BTC", 1), T0, n)
    minute_end = T0 + (np.arange(n) + 1) * MIN
    md.b_has[:] = True
    md.b_close[:] = 100.0
    dev = np.full(n, base_bps * 1e-4)
    dev[5 * spike_j - 1] = spike_bps * 1e-4
    if prev_bps is not None:
        dev[5 * spike_j - 2] = prev_bps * 1e-4
    px = 100.0 * np.exp(dev)
    md.last_buy_px[:] = px
    md.last_sell_px[:] = px
    md.last_px[:] = px
    md.last_buy_ts[:] = minute_end - stamp_offset
    md.last_sell_ts[:] = minute_end - stamp_offset
    return md


def test_f5_hand_built_threshold_and_persist():
    j = 700
    md = _gap_md(spike_j=j)
    assert signals.gap_sides(md, 2, "plain")[j] == -1  # dev 4.5 bps >= 2
    assert signals.gap_sides(md, 4, "plain")[j] == -1  # 4.5 >= 4
    assert signals.gap_sides(md, 8, "plain")[j] == 0
    assert signals.gap_sides(md, 2, "persist")[j] == 0  # the minute before is at the median
    md = _gap_md(spike_j=j, prev_bps=5.0)
    assert signals.gap_sides(md, 4, "persist")[j] == -1
    md = _gap_md(spike_j=j, prev_bps=-5.0)
    assert signals.gap_sides(md, 2, "persist")[j] == 0  # opposite sign
    md = _gap_md(base_bps=0.5, spike_j=j, spike_bps=-6.0)
    assert signals.gap_sides(md, 4, "plain")[j] == 1  # Lighter below Binance: long


def test_f5_needs_a_print_in_the_last_ten_seconds():
    j = 700
    md = _gap_md(spike_j=j)
    m = 5 * j - 1
    minute_end = T0 + (m + 1) * MIN
    md.last_buy_ts[m] = minute_end - 10_001
    md.last_sell_ts[m] = minute_end - 10_001
    assert signals.gap_sides(md, 2, "plain")[j] == 0
    md.last_buy_ts[m] = minute_end - 10_000
    assert signals.gap_sides(md, 2, "plain")[j] == -1  # the window is [g - 10 s, g - 0.5 s): 10 s before is inside
    md.last_buy_ts[m] = md.last_sell_ts[m] = minute_end - 501
    assert signals.gap_sides(md, 2, "plain")[j] == -1
    md.last_buy_ts[m] = md.last_sell_ts[m] = minute_end - 500  # a print in the last half second is excluded
    assert signals.gap_sides(md, 2, "plain")[j] == 0
    md.last_buy_ts[m] = md.last_sell_ts[m] = minute_end - 1
    assert signals.gap_sides(md, 2, "plain")[j] == 0


def test_f5_persist_applies_the_same_window_to_the_minute_before():
    j = 700
    md = _gap_md(spike_j=j, prev_bps=5.0)
    m2 = 5 * j - 2
    end2 = T0 + (m2 + 1) * MIN
    assert signals.gap_sides(md, 4, "persist")[j] == -1
    md.last_buy_ts[m2] = md.last_sell_ts[m2] = end2 - 500  # in the last half second of minute g - 120 s
    assert signals.gap_sides(md, 4, "persist")[j] == 0
    md.last_buy_ts[m2] = md.last_sell_ts[m2] = end2 - 10_001  # older than 10 s
    assert signals.gap_sides(md, 4, "persist")[j] == 0


def test_f6_hand_built():
    n = 3 * 288
    h0 = T0 // lock.HOUR_MS
    ts = (h0 + np.arange(80)) * lock.HOUR_MS
    rate = np.zeros(80)
    rate[10] = 2.5e-4  # +2.5 bps/h settled at 10:00 of the first day
    rate[11] = -3.5e-4
    rate[12] = 0.9e-4
    s1 = signals.funding_sides(T0, n, ts, rate, 1)
    s2 = signals.funding_sides(T0, n, ts, rate, 2)
    s4 = signals.funding_sides(T0, n, ts, rate, 4)
    j = lambda hh, mm: (hh * 60 + mm) // 5  # noqa: E731
    assert s1[j(10, 55)] == -1 and s2[j(10, 55)] == -1 and s4[j(10, 55)] == 0
    assert s1[j(11, 55)] == 1 and s2[j(11, 55)] == 1 and s4[j(11, 55)] == 0
    assert s1[j(12, 55)] == 0  # 0.9 bps < 1
    assert s1[j(10, 50)] == 0 and s1[j(10, 0)] == 0 and s1[j(11, 50)] == 0  # only minute-of-hour 55
    # only the row stamped at minute 0 of g's hour counts: an earlier row does not stand in for a missing one
    keep = np.arange(80) != 12
    s = signals.funding_sides(T0, n, ts[keep], rate[keep], 1)
    assert s[j(12, 55)] == 0 and s[j(11, 55)] == 1  # hour 12 has no row: no signal at 12:55
    big = rate.copy()
    big[13] = 9e-4
    s = signals.funding_sides(T0, n, ts[keep], big[keep], 1)
    assert s[j(13, 55)] == -1
    # a row stamped off the hour is no settlement of that hour
    ts_off = ts.copy()
    ts_off[10] += 300_000  # 10:05 instead of 10:00
    assert signals.funding_sides(T0, n, ts_off, rate, 1)[j(10, 55)] == 0
    assert (signals.funding_sides(T0, n, np.zeros(0, dtype=np.int64), np.zeros(0), 1) == 0).all()


def test_f6_matches_reference(panel):
    items, (f_ts, f_rate) = panel
    feats = features_of(panel)
    total = 0
    for (md, _), f in zip(items, feats, strict=True):
        for sig in lock.FUNDING_SIGNALS:
            want = ref_f6(md.t0_ms, NG, f_ts, f_rate, sig.p("theta"))
            assert np.array_equal(f.sides[sig.sig_id], want)
            total += int((want != 0).sum())
    assert total > 100


def _by_id(panel_data):
    return {f.market.market_id: f for f in features_of(panel_data)}


def test_f2_matches_reference(panel):
    items, _ = panel
    feats = features_of(panel)
    xs = xs_of(feats)
    refs = [Ref(md, src) for md, src in items]
    members = {"A": [0, 1, 2, 3], "AB": [0, 1, 2, 3]}  # BTC ETH SOL XRP are all tier A, XAU is tradfi
    produced = 0
    for universe in lock.UNIVERSES:
        grp = members[universe]

        def res(i, j, k, universe=universe, grp=grp):
            r = refs[i].r(j, k)
            others = [refs[o].r(j, k) for o in grp if o != i]
            others = [v for v in others if not math.isnan(v)]
            if math.isnan(r) or len(others) < lock.MIN_OTHERS:
                return NAN
            return r - float(np.mean(others))

        for i in grp:
            r1 = [res(i, j, 1) for j in range(NG)]
            for k in lock.KS_REVERSAL:
                for theta in lock.THETAS:
                    want = np.zeros(NG, dtype=np.int8)
                    for j in range(START_J, NG):
                        win = [v for v in r1[max(0, j - 287) : j + 1] if not math.isnan(v)]
                        rk = res(i, j, k)
                        if len(win) < 260 or math.isnan(rk):
                            continue
                        z = rk / (float(np.std(win, ddof=1)) * math.sqrt(k))
                        if abs(z) >= theta:
                            want[j] = -1 if z > 0 else 1
                    got = xs[(items[i][0].market.market_id, universe, f"F2-k{k}-th{theta}")]
                    assert np.array_equal(got, want), (universe, i, k, theta)
                    produced += int((want != 0).sum())
    assert produced > 100
    assert not any(key[0] == 5 for key in xs)  # the lone tradfi market has no basket


def test_f2_basket_needs_three_others(panel):
    items, funding = panel
    feats = [signals.compute_features(md, src, START_MS, funding) for md, src in items[:3]]  # three crypto markets
    assert xs_of(feats, {"F2-k1-th1.0"}) == {}


def test_f3_follows_btc_and_skips_btc_and_tradfi(panel):
    items, _ = panel
    feats = features_of(panel)
    xs = xs_of(feats)
    btc = Ref(*items[0])
    for k in lock.KS_REVERSAL:
        for theta in lock.THETAS:
            want = np.zeros(NG, dtype=np.int8)
            for j in range(START_J, NG):
                z = btc.z(j, k)
                if not math.isnan(z) and abs(z) >= theta:
                    want[j] = 1 if z > 0 else -1
            sig = f"F3-k{k}-th{theta}"
            for u in lock.UNIVERSES:
                for mid in (2, 3, 4):
                    assert np.array_equal(xs[(mid, u, sig)], want)
                assert (1, u, sig) not in xs  # BTC itself
                assert (5, u, sig) not in xs  # tradfi follower
            assert (want != 0).sum() > 5 or theta == 2.0


def test_f3_needs_btc_in_the_universe(panel):
    items, funding = panel
    others = [signals.compute_features(md, src, START_MS, funding) for md, src in items[1:4]]
    assert xs_of(others, {"F3-k1-th1.0"}) == {}
    feats = [signals.compute_features(items[0][0], "binance", START_MS, funding)] + others
    xs = xs_of(feats, {"F3-k1-th1.0"}, tiers={1: "B"})  # BTC tier B: universe A has no leader
    assert any(key[1] == "AB" for key in xs) and not any(key[1] == "A" for key in xs)


def _c5_md(levels, coin="BTC", mid=1):
    """Binance-source minute data whose 5m closes at grid points 1.. are the given levels."""
    n = len(levels) * 5
    md = blank_minute_data(market(coin, mid), T0, n)
    md.b_has[:] = True
    md.b_close[:] = np.repeat(levels, 5)
    md.b_qv[:] = 100.0
    md.b_tbq[:] = 50.0
    return md


def test_f1_hand_built_jump():
    rng = np.random.default_rng(1)
    r = rng.choice([-1e-4, 1e-4], 600)
    jump = 400
    r[jump] = 1e-3
    levels = 100.0 * np.exp(np.cumsum(r))
    md = _c5_md(levels)
    f = signals.compute_features(md, "binance", T0 + 350 * lock.GRID_MS, (np.zeros(0, np.int64), np.zeros(0)))
    # levels[b] is the close of block b = the 5m close at grid point b + 1, so the jump return sits at grid j = 401
    j = jump + 1
    window = r[jump - 287 : jump + 1]
    z_hand = 1e-3 / (np.std(window, ddof=1))
    assert f.z[1][j] == pytest.approx(z_hand, rel=1e-6)
    for theta in lock.THETAS:
        assert f.sides[f"F1-k1-th{theta}"][j] == -1  # a big up move is faded: short
    assert abs(f.z[1][j - 1]) < 2.0  # the quiet bars before the jump do not trigger theta 2
    assert f.sides["F1-k1-th2.0"][351:j].sum() == 0


def test_f1_hand_built_down_jump_goes_long():
    r = np.tile([-1e-4, 1e-4], 300)
    r[400] = -1e-3
    md = _c5_md(100.0 * np.exp(np.cumsum(r)))
    f = signals.compute_features(md, "binance", T0 + 350 * lock.GRID_MS, (np.zeros(0, np.int64), np.zeros(0)))
    assert f.sides["F1-k1-th2.0"][401] == 1


def test_f2_hand_built_mover_is_shorted_others_bought():
    rng = np.random.default_rng(2)
    n = 500
    moves = rng.normal(0, 1e-4, (5, n))
    mover = 400
    moves[0, mover] += 2e-3
    mds, feats = [], []
    for i in range(5):
        levels = 100.0 * np.exp(np.cumsum(moves[i]))
        mds.append(_c5_md(levels, coin=["BTC", "ETH", "SOL", "XRP", "DOGE"][i], mid=i + 1))
        feats.append(
            signals.compute_features(mds[-1], "binance", T0 + 320 * lock.GRID_MS, (np.zeros(0, np.int64), np.zeros(0)))
        )
    xs = xs_of(feats, {"F2-k1-th2.0"})
    j = mover + 1
    assert xs[(1, "AB", "F2-k1-th2.0")][j] == -1
    for mid in (2, 3, 4, 5):
        assert xs[(mid, "AB", "F2-k1-th2.0")][j] == 1


def test_f3_hand_built_leader_move():
    rng = np.random.default_rng(3)
    n = 500
    moves = rng.normal(0, 1e-4, (3, n))
    moves[0, 400] += 2e-3
    feats = []
    for i, coin in enumerate(["BTC", "ETH", "XAU"]):
        md = _c5_md(100.0 * np.exp(np.cumsum(moves[i])), coin=coin, mid=i + 1)
        feats.append(
            signals.compute_features(md, "binance", T0 + 320 * lock.GRID_MS, (np.zeros(0, np.int64), np.zeros(0)))
        )
    xs = xs_of(feats, {"F3-k1-th2.0"})
    assert xs[(2, "AB", "F3-k1-th2.0")][401] == 1  # BTC up: ETH long (continuation)
    assert (3, "AB", "F3-k1-th2.0") not in xs  # XAU is tradfi
    assert (1, "AB", "F3-k1-th2.0") not in xs


# ----------------------------------------------------------------------------------------------------------------
# Look-ahead: nothing at or after g may change a feature at g.


def _perturb(md, from_minute, seed):
    rng = np.random.default_rng(seed)
    out = copy.deepcopy(md)
    n = out.n
    sl = slice(from_minute, n)
    m = n - from_minute
    for name in (
        "last_px",
        "last_buy_px",
        "last_sell_px",
        "first_buy_px",
        "first_sell_px",
        "b_close",
    ):
        getattr(out, name)[sl] = np.where(rng.random(m) < 0.8, 100.0 * np.exp(rng.normal(0, 0.05, m)), np.nan)
    for name in ("last_buy_ts", "last_sell_ts", "first_buy_ts", "first_sell_ts"):
        getattr(out, name)[sl] = np.where(
            rng.random(m) < 0.8, out.t0_ms + np.arange(from_minute, n) * MIN + 700, np.nan
        )
    for name in ("buy_small", "sell_small", "buy_large", "sell_large"):
        getattr(out, name)[sl] = rng.exponential(1e4, m)
    out.b_has[sl] = rng.random(m) < 0.9
    out.b_qv[sl] = rng.exponential(1e6, m)
    out.b_tbq[sl] = out.b_qv[sl] * rng.random(m)
    return out


def test_no_feature_at_g_uses_data_at_or_after_g(panel):
    items, (f_ts, f_rate) = panel
    jc = START_J + 300
    g_ms = T0 + jc * lock.GRID_MS
    base = [signals.compute_features(md, src, START_MS, (f_ts, f_rate)) for md, src in items]
    fut_rate = np.where(f_ts > g_ms, np.random.default_rng(9).normal(0, 1e-3, len(f_rate)), f_rate)
    pert_items = [(_perturb(md, 5 * jc, 40 + i), src) for i, (md, src) in enumerate(items)]
    pert = [signals.compute_features(md, src, START_MS, (f_ts, fut_rate)) for md, src in pert_items]
    for b, p in zip(base, pert, strict=True):
        assert np.array_equal(b.sigma[: jc + 1], p.sigma[: jc + 1], equal_nan=True)
        for k in lock.KS_REVERSAL:
            assert np.array_equal(b.r[k][: jc + 1], p.r[k][: jc + 1], equal_nan=True)
            assert np.array_equal(b.z[k][: jc + 1], p.z[k][: jc + 1], equal_nan=True)
        assert b.sides.keys() == p.sides.keys()
        for sig_id in b.sides:
            assert np.array_equal(b.sides[sig_id][: jc + 1], p.sides[sig_id][: jc + 1]), sig_id
    xs_b = xs_of(base)
    xs_p = xs_of(pert)
    assert xs_b.keys() == xs_p.keys()
    for key in xs_b:
        assert np.array_equal(xs_b[key][: jc + 1], xs_p[key][: jc + 1]), key
    # the perturbation is real: later points do change
    changed = sum(not np.array_equal(base[0].sides[s][jc + 1 :], pert[0].sides[s][jc + 1 :]) for s in base[0].sides)
    assert changed > 10


def test_look_ahead_guard_catches_a_one_bar_shift():
    """The look-ahead test must be able to fail: feed it a feature that peeks one bar ahead."""
    md = random_minute_data(market("BTC", 1), T0, DAYS, seed=7)
    c5, v5 = signals.grid_prices(md, "binance")
    r = signals.log_returns(c5, v5, 1)
    peek = np.roll(r, -1)  # r at j + 1 placed at j
    jc = START_J + 100
    pert = _perturb(md, 5 * jc, 1)
    c5p, v5p = signals.grid_prices(pert, "binance")
    rp = signals.log_returns(c5p, v5p, 1)
    assert np.array_equal(r[: jc + 1], rp[: jc + 1], equal_nan=True)
    assert not np.array_equal(peek[: jc + 1], np.roll(rp, -1)[: jc + 1], equal_nan=True)


# ----------------------------------------------------------------------------------------------------------------
# Point-in-time universe: baskets by month, source by month


def test_baskets_use_only_the_markets_eligible_that_month_and_universe(panel):
    items, funding = panel
    feats = features_of(panel)
    extra_md = random_minute_data(market("LTC", 6), T0, DAYS, seed=777)
    extra = signals.compute_features(extra_md, "binance", START_MS, funding)
    four = xs_of(feats[:4], {"F2-k1-th1.0"})
    # a fifth crypto market that is tier B this month: universe A ignores it, universe AB uses it
    five = xs_of([*feats[:4], extra], {"F2-k1-th1.0"}, tiers={6: "B"})
    for mid in (1, 2, 3, 4):
        assert np.array_equal(five[(mid, "A", "F2-k1-th1.0")], four[(mid, "A", "F2-k1-th1.0")])
        assert not np.array_equal(five[(mid, "AB", "F2-k1-th1.0")], four[(mid, "AB", "F2-k1-th1.0")])
    # a market that is not a member this month gets no signal and is not part of anyone's basket
    three = xs_of(feats[:3], {"F2-k1-th1.0"})
    assert three == {}
    assert (6, "AB", "F2-k1-th1.0") in five and (6, "A", "F2-k1-th1.0") not in five


def test_baskets_change_with_the_month():
    """Two months of one slice list: a market eligible only in the second month joins baskets only there."""
    rng_md = [
        random_minute_data(market(c, i + 1), T0, DAYS, seed=300 + i)
        for i, c in enumerate(["BTC", "ETH", "SOL", "XRP", "DOGE"])
    ]
    funding = (np.zeros(0, np.int64), np.zeros(0))
    feats = [signals.compute_features(md, "binance", START_MS, funding, {"F2-k1-th1.0"}) for md in rng_md]
    by = {f.market.market_id: {"binance": f} for f in feats}
    mid_j = START_J + 576
    first = signals.MonthSlice(START_J, mid_j, {i: ("A", "binance") for i in (1, 2, 3, 4)})
    second = signals.MonthSlice(mid_j, NG, {i: ("A", "binance") for i in (1, 2, 3, 4, 5)})
    out = signals.cross_sectional_sides(by, [first, second], NG, {"F2-k1-th1.0"})
    assert not out[(1, "A", "F2-k1-th1.0")][:START_J].any()
    assert (5, "A", "F2-k1-th1.0") in out and not out[(5, "A", "F2-k1-th1.0")][:mid_j].any()
    only_second = signals.cross_sectional_sides(by, [second], NG, {"F2-k1-th1.0"})
    assert np.array_equal(out[(1, "A", "F2-k1-th1.0")][mid_j:], only_second[(1, "A", "F2-k1-th1.0")][mid_j:])
    only_first = signals.cross_sectional_sides(by, [first], NG, {"F2-k1-th1.0"})
    assert np.array_equal(out[(1, "A", "F2-k1-th1.0")][:mid_j], only_first[(1, "A", "F2-k1-th1.0")][:mid_j])


def test_grid_month_index_follows_the_utc_month():
    t0 = ft.day_start_ms(dt.date(2025, 7, 31))
    gm = signals.grid_month_index(t0, 3 * 288)
    assert gm[0] == lock.month_index(2025, 7) and gm[287] == lock.month_index(2025, 7)
    assert gm[288] == lock.month_index(2025, 8) and gm[-1] == lock.month_index(2025, 8)
    assert lock.month_of_index(gm[300]) == (2025, 8)


def test_monthly_source_switch_uses_the_months_source_for_the_whole_trailing_window():
    t0 = ft.day_start_ms(dt.date(2025, 7, 29))
    md = random_minute_data(market("BTC", 1), t0, 6, seed=11)
    funding = (np.zeros(0, np.int64), np.zeros(0))
    start_ms = t0 + 2 * DAY
    fb = signals.compute_features(md, "binance", start_ms, funding)
    fl = signals.compute_features(md, "lighter", start_ms, funding)
    gm = signals.grid_month_index(t0, fb.ng)
    binance_mask = gm == lock.month_index(2025, 7)  # July on Binance, August on Lighter only
    sides, sigma = signals.compose_by_source({"binance": fb, "lighter": fl}, binance_mask)
    aug = ~binance_mask
    first_aug = int(np.flatnonzero(aug)[0])
    for sig_id in fl.sides:
        assert np.array_equal(sides[sig_id][aug], fl.sides[sig_id][aug])
    binance_only = [k for k in fb.sides if k not in fl.sides]
    assert any(sides[k][binance_mask].any() for k in binance_only)
    for sig_id in fb.sides:
        if sig_id in fl.sides:
            assert np.array_equal(sides[sig_id][binance_mask], fb.sides[sig_id][binance_mask])
        else:  # F4 binance input and F5 exist only in months whose source is binance
            assert not sides[sig_id][aug].any()
    # the first August decisions use a Lighter trailing window that reaches back into July (month P)
    assert np.array_equal(sigma[first_aug : first_aug + 5], fl.sigma[first_aug : first_aug + 5])
    assert not np.array_equal(fl.sigma[first_aug : first_aug + 5], fb.sigma[first_aug : first_aug + 5])
    assert not np.isnan(sigma[first_aug])  # warmed up on July data
    assert np.array_equal(sigma[binance_mask], fb.sigma[binance_mask], equal_nan=True)
    # no Binance feature set at all: the composition is the Lighter one
    s2, g2 = signals.compose_by_source({"lighter": fl}, np.ones(fl.ng, dtype=bool))
    assert np.array_equal(g2, fl.sigma, equal_nan=True) and all(np.array_equal(s2[k], fl.sides[k]) for k in fl.sides)
