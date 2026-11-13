"""Tests for horizon-e1 trade simulation (rules 2 to 7)."""

from __future__ import annotations

import datetime as dt
import math

import numpy as np
import pytest

from horizon.e1 import lock
from horizon.e1.data import Bars, Funding
from horizon.e1.events import Pair
from horizon.e1.trade import simulate


class FakeStore:
    """Duck-typed store providing filtered Bars and Funding."""

    def __init__(
        self,
        bars_map: dict[str, Bars] | None = None,
        funding_map: dict[str, Funding] | None = None,
    ) -> None:
        self._bars = bars_map or {}
        self._funding = funding_map or {}

    def bars(self, symbol: str, start_ms: int, end_ms: int) -> Bars:
        if symbol not in self._bars:
            return Bars.empty()
        return self._bars[symbol].slice_ms(start_ms, end_ms)

    def funding(self, symbol: str, start_ms: int, end_ms: int) -> Funding:
        if symbol not in self._funding:
            return Funding.empty()
        f = self._funding[symbol]
        mask = (f.calc_time >= start_ms) & (f.calc_time <= end_ms)
        return Funding(
            calc_time=f.calc_time[mask],
            interval_hours=f.interval_hours[mask],
            rate=f.rate[mask],
        )


def make_flat_bars(
    start_ms: int,
    end_ms: int,
    *,
    open_p: float = 100.0,
    high_p: float = 100.0,
    low_p: float = 100.0,
    close_p: float = 100.0,
    volume: float = 1.0,
    step_ms: int = lock.MINUTE_MS,
    overrides: dict[int, dict[str, float]] | None = None,
) -> Bars:
    times = list(range(start_ms, end_ms + 1, step_ms))
    n = len(times)
    opens = np.full(n, open_p, dtype=np.float64)
    highs = np.full(n, high_p, dtype=np.float64)
    lows = np.full(n, low_p, dtype=np.float64)
    closes = np.full(n, close_p, dtype=np.float64)
    volumes = np.full(n, volume, dtype=np.float64)

    if overrides:
        time_to_idx = {t: i for i, t in enumerate(times)}
        for t, bar_dict in overrides.items():
            if t in time_to_idx:
                idx = time_to_idx[t]
                if "open" in bar_dict:
                    opens[idx] = bar_dict["open"]
                if "high" in bar_dict:
                    highs[idx] = bar_dict["high"]
                if "low" in bar_dict:
                    lows[idx] = bar_dict["low"]
                if "close" in bar_dict:
                    closes[idx] = bar_dict["close"]
                if "volume" in bar_dict:
                    volumes[idx] = bar_dict["volume"]

    return Bars(
        open_time=np.array(times, dtype=np.int64),
        open=opens,
        high=highs,
        low=lows,
        close=closes,
        volume=volumes,
    )


def make_funding(rows: list[tuple[int, float, float]]) -> Funding:
    if not rows:
        return Funding.empty()
    calc_time = np.array([r[0] for r in rows], dtype=np.int64)
    interval_hours = np.array([r[1] for r in rows], dtype=np.float64)
    rate = np.array([r[2] for r in rows], dtype=np.float64)
    return Funding(calc_time=calc_time, interval_hours=interval_hours, rate=rate)


def make_pair(
    *,
    token: str = "FOO",
    symbol: str | None = "FOOUSDT",
    stamp_ms: int = 1_772_611_212_000,
    day: str = "2026-03-04",
    cls: str = lock.CLASS_T,
    code: str = "test_code",
    reason: str = "covers-stamp",
    missing_days: tuple[str, ...] = (),
    btc_missing_days: tuple[str, ...] = (),
    pending_notice: str | None = None,
) -> Pair:
    return Pair(
        cls=cls,
        code=code,
        stamp_ms=stamp_ms,
        day=day,
        token=token,
        symbol=symbol,
        reason=reason,
        missing_days=missing_days,
        btc_missing_days=btc_missing_days,
        pending_notice=pending_notice,
    )


def build_case_a_setup():
    stamp_ms = int(dt.datetime(2026, 3, 4, 8, 0, 12, tzinfo=dt.UTC).timestamp() * 1000)
    m_start = int(dt.datetime(2026, 3, 4, 8, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
    entry_ms = m_start + 2 * lock.MINUTE_MS  # 08:02
    te_ms = entry_ms + 4 * lock.HOUR_MS  # 12:02
    t_1159 = te_ms - 3 * lock.MINUTE_MS  # 11:59

    # 1440 bars before 08:00 with volume 1
    act_start = m_start - 1440 * lock.MINUTE_MS
    act_end = m_start - lock.MINUTE_MS
    pre_bars = make_flat_bars(act_start, act_end, open_p=99.0, high_p=105.0, low_p=90.0, close_p=99.0, volume=1.0)

    # Bars from 08:00 to 12:03
    post_overrides = {
        entry_ms: {"open": 100.0, "high": 100.4, "low": 99.6, "close": 100.1, "volume": 5.0},
        t_1159: {"open": 99.0, "high": 105.0, "low": 90.0, "close": 95.0, "volume": 5.0},
        te_ms: {"open": 94.0, "high": 94.2, "low": 93.8, "close": 94.1, "volume": 5.0},
    }
    post_bars = make_flat_bars(
        m_start,
        te_ms + lock.MINUTE_MS,
        open_p=99.0,
        high_p=105.0,
        low_p=90.0,
        close_p=99.0,
        volume=5.0,
        overrides=post_overrides,
    )

    token_bars = Bars(
        open_time=np.concatenate([pre_bars.open_time, post_bars.open_time]),
        open=np.concatenate([pre_bars.open, post_bars.open]),
        high=np.concatenate([pre_bars.high, post_bars.high]),
        low=np.concatenate([pre_bars.low, post_bars.low]),
        close=np.concatenate([pre_bars.close, post_bars.close]),
        volume=np.concatenate([pre_bars.volume, post_bars.volume]),
    )

    btc_overrides = {
        entry_ms: {"open": 50000.0, "high": 50200.0, "low": 50000.0, "close": 50200.0, "volume": 5.0},
        t_1159: {"open": 50200.0, "high": 50400.0, "low": 50200.0, "close": 50400.0, "volume": 5.0},
        te_ms: {"open": 50500.0, "high": 50500.0, "low": 50200.0, "close": 50200.0, "volume": 5.0},
    }
    btc_bars = make_flat_bars(
        entry_ms,
        te_ms + lock.MINUTE_MS,
        open_p=50200.0,
        high_p=50200.0,
        low_p=50200.0,
        close_p=50200.0,
        volume=5.0,
        overrides=btc_overrides,
    )

    t_f1 = m_start + 5  # 08:00:00.005
    t_f2 = m_start + 4 * lock.HOUR_MS + 5  # 12:00:00.005
    t_f3 = m_start + 8 * lock.HOUR_MS + 5  # 16:00:00.005

    token_funding = make_funding([(t_f1, 4.0, 0.0001), (t_f2, 4.0, 0.0001), (t_f3, 4.0, 0.0001)])
    btc_funding = make_funding([(t_f1, 4.0, 0.00005), (t_f2, 4.0, 0.00005), (t_f3, 4.0, 0.00005)])

    store = FakeStore(
        bars_map={"FOOUSDT": token_bars, "BTCUSDT": btc_bars},
        funding_map={"FOOUSDT": token_funding, "BTCUSDT": btc_funding},
    )
    pair = make_pair(token="FOO", symbol="FOOUSDT", stamp_ms=stamp_ms)
    return pair, store, stamp_ms, entry_ms, te_ms


def test_golden_case_a():
    pair, store, stamp_ms, entry_ms, te_ms = build_case_a_setup()
    res = simulate(pair, store, horizon_hours=4, delay_minutes=1)

    assert res.token == "FOO"
    assert res.symbol == "FOOUSDT"
    assert res.horizon_hours == 4
    assert res.delay_minutes == 1
    assert res.status == "ok"
    assert res.reason is None
    assert res.entry_ms == entry_ms
    assert res.te_ms == te_ms
    assert res.exit_ms == te_ms

    pe = 100.0
    px = 94.0
    be = 50000.0
    bx = 50500.0
    assert res.pe == pytest.approx(pe, abs=1e-12)
    assert res.px == pytest.approx(px, abs=1e-12)
    assert res.be == pytest.approx(be, abs=1e-12)
    assert res.bx == pytest.approx(bx, abs=1e-12)

    assert res.stopped is False
    assert res.truncated is False
    assert res.btc_carried is False
    assert res.funding_gap is False
    assert res.n_settlements == 1

    expected_gross_token = (100.0 - 94.0) / 100.0  # 0.06
    expected_gross_btc = (50500.0 - 50000.0) / 50000.0  # 0.01
    assert res.gross_token == pytest.approx(expected_gross_token, abs=1e-12)
    assert res.gross_btc == pytest.approx(expected_gross_btc, abs=1e-12)

    vt = 94.0 / 100.0  # 0.94
    vb = 50500.0 / 50000.0  # 1.01
    expected_fees = 5.0 * 1e-4 * (1.0 + vt + 1.0 + vb)  # 0.001975
    assert res.fees == pytest.approx(expected_fees, abs=1e-12)

    # Slippage arithmetic
    entry_range_bps = (100.4 - 99.6) / 100.0 * 1e4  # 80.0
    entry_slip_bps = max(10.0, 0.25 * entry_range_bps)  # 20.0
    entry_slip_token = entry_slip_bps * 1e-4 * 1.0  # 0.0020

    exit_range_bps = (94.2 - 93.8) / 94.0 * 1e4
    exit_slip_bps = max(10.0, 0.25 * exit_range_bps)
    exit_slip_token = exit_slip_bps * 1e-4 * vt  # 0.0010
    token_slip = entry_slip_token + exit_slip_token  # 0.0030

    btc_slip = 1.0 * 1e-4 * (1.0 + vb)  # 0.000201
    expected_slippage = token_slip + btc_slip  # 0.003201
    assert res.slippage == pytest.approx(expected_slippage, abs=1e-12)

    expected_funding_token = 0.0001 * (95.0 / 100.0)  # 9.5e-5
    expected_funding_btc = -0.00005 * (50400.0 / 50000.0)  # -5.04e-5
    assert res.funding_token == pytest.approx(expected_funding_token, abs=1e-12)
    assert res.funding_btc == pytest.approx(expected_funding_btc, abs=1e-12)

    expected_net = (
        expected_gross_token
        + expected_gross_btc
        - expected_fees
        - expected_slippage
        + expected_funding_token
        + expected_funding_btc
    )  # 0.06486860
    assert res.net == pytest.approx(expected_net, abs=1e-12)

    token_fees = 5.0 * 1e-4 * (1.0 + vt)  # 0.000970
    expected_net_unhedged = expected_gross_token - token_fees - token_slip + expected_funding_token  # 0.056125
    assert res.net_unhedged == pytest.approx(expected_net_unhedged, abs=1e-12)

    expected_net_stress = (
        expected_gross_token
        + expected_gross_btc
        - expected_fees
        - 2.0 * expected_slippage
        + expected_funding_token
        + expected_funding_btc
    )  # 0.0616676
    assert res.net_stress == pytest.approx(expected_net_stress, abs=1e-12)

    expected_max_adverse = 105.0 / 100.0 - 1.0  # 0.05
    assert res.max_adverse == pytest.approx(expected_max_adverse, abs=1e-12)


def test_case_b_stop():
    pair, store, stamp_ms, entry_ms, te_ms = build_case_a_setup()
    t_0910 = entry_ms + 68 * lock.MINUTE_MS  # 09:10

    # Variant 1: open 125.0, high 131.0
    token_bars = store._bars["FOOUSDT"]
    idx_0910 = token_bars.index_of(t_0910)
    new_high = token_bars.high.copy()
    new_open = token_bars.open.copy()
    new_high[idx_0910] = 131.0
    new_open[idx_0910] = 125.0
    store._bars["FOOUSDT"] = Bars(
        open_time=token_bars.open_time,
        open=new_open,
        high=new_high,
        low=token_bars.low,
        close=token_bars.close,
        volume=token_bars.volume,
    )

    res = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res.status == "ok"
    assert res.stopped is True
    assert res.truncated is False
    assert res.exit_ms == t_0910
    assert res.px == pytest.approx(130.0, abs=1e-12)
    assert res.gross_token == pytest.approx((100.0 - 130.0) / 100.0, abs=1e-12)  # -0.30
    assert res.bx == pytest.approx(50200.0, abs=1e-12)
    assert res.n_settlements == 0
    assert res.funding_token == pytest.approx(0.0, abs=1e-12)
    assert res.funding_btc == pytest.approx(0.0, abs=1e-12)
    assert res.max_adverse == pytest.approx(131.0 / 100.0 - 1.0, abs=1e-12)  # 0.31

    # Variant 2: open 135.0, high 140.0 gives px = 135.0 (gap fill at the open)
    new_open[idx_0910] = 135.0
    new_high[idx_0910] = 140.0
    store._bars["FOOUSDT"] = Bars(
        open_time=token_bars.open_time,
        open=new_open,
        high=new_high,
        low=token_bars.low,
        close=token_bars.close,
        volume=token_bars.volume,
    )
    res2 = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res2.stopped is True
    assert res2.px == pytest.approx(135.0, abs=1e-12)
    assert res2.gross_token == pytest.approx((100.0 - 135.0) / 100.0, abs=1e-12)  # -0.35


def test_case_c_truncated():
    pair, store, stamp_ms, entry_ms, te_ms = build_case_a_setup()
    t_1000 = entry_ms + 118 * lock.MINUTE_MS  # 10:00
    t_1001 = t_1000 + lock.MINUTE_MS  # 10:01

    token_bars = store._bars["FOOUSDT"]
    # Truncate bars so they end at 10:00
    mask = token_bars.open_time <= t_1000
    sub_open = token_bars.open[mask].copy()
    sub_high = token_bars.high[mask].copy()
    sub_low = token_bars.low[mask].copy()
    sub_close = token_bars.close[mask].copy()
    sub_vol = token_bars.volume[mask].copy()
    sub_time = token_bars.open_time[mask].copy()

    # Last traded bar at 10:00: open 90.5, high 91.0, low 89.0, close 90.0, volume 5.0
    sub_open[-1] = 90.5
    sub_high[-1] = 91.0
    sub_low[-1] = 89.0
    sub_close[-1] = 90.0
    sub_vol[-1] = 5.0

    store._bars["FOOUSDT"] = Bars(
        open_time=sub_time,
        open=sub_open,
        high=sub_high,
        low=sub_low,
        close=sub_close,
        volume=sub_vol,
    )

    res = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res.status == "ok"
    assert res.stopped is False
    assert res.truncated is True
    assert res.exit_ms == t_1001
    assert res.px == pytest.approx(90.0, abs=1e-12)
    assert res.bx == pytest.approx(50200.0, abs=1e-12)
    assert res.n_settlements == 0
    assert res.funding_token == pytest.approx(0.0, abs=1e-12)
    assert res.funding_btc == pytest.approx(0.0, abs=1e-12)

    # Exit slippage uses 10:00 bar's range:
    vt = 90.0 / 100.0
    exit_range_bps = (91.0 - 89.0) / 90.5 * 1e4
    exit_slip_bps = max(10.0, 0.25 * exit_range_bps)
    expected_exit_slip = exit_slip_bps * 1e-4 * vt
    entry_slip = 20.0 * 1e-4 * 1.0
    token_slip = entry_slip + expected_exit_slip
    btc_slip = 1.0 * 1e-4 * (1.0 + 50200.0 / 50000.0)
    assert res.slippage == pytest.approx(token_slip + btc_slip, abs=1e-12)


def test_case_d_missing_exit_bar_within_30_minutes():
    pair, store, stamp_ms, entry_ms, te_ms = build_case_a_setup()
    t_1200 = te_ms - 2 * lock.MINUTE_MS  # 12:00

    token_bars = store._bars["FOOUSDT"]
    # Drop bars after 12:00, set 12:00 bar close to 94.5
    mask = token_bars.open_time <= t_1200
    sub_open = token_bars.open[mask].copy()
    sub_high = token_bars.high[mask].copy()
    sub_low = token_bars.low[mask].copy()
    sub_close = token_bars.close[mask].copy()
    sub_vol = token_bars.volume[mask].copy()
    sub_time = token_bars.open_time[mask].copy()
    sub_close[-1] = 94.5

    store._bars["FOOUSDT"] = Bars(
        open_time=sub_time,
        open=sub_open,
        high=sub_high,
        low=sub_low,
        close=sub_close,
        volume=sub_vol,
    )

    res = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res.status == "ok"
    assert res.stopped is False
    assert res.truncated is False
    assert res.exit_ms == te_ms
    assert res.px == pytest.approx(94.5, abs=1e-12)

    # Variant: bar at 12:02 exists but has volume 0
    full_bars = store._bars["FOOUSDT"]
    re_bars = make_flat_bars(
        int(full_bars.open_time[0]),
        te_ms,
        open_p=99.0,
        high_p=105.0,
        low_p=90.0,
        close_p=99.0,
        volume=5.0,
        overrides={
            entry_ms: {"open": 100.0, "high": 100.4, "low": 99.6, "close": 100.1, "volume": 5.0},
            t_1200: {"open": 99.0, "high": 105.0, "low": 90.0, "close": 94.5, "volume": 5.0},
            te_ms - 60_000: {"open": 99.0, "high": 105.0, "low": 90.0, "close": 99.0, "volume": 0.0},
            te_ms: {"open": 99.0, "high": 105.0, "low": 90.0, "close": 99.0, "volume": 0.0},
        },
    )
    store._bars["FOOUSDT"] = re_bars
    res_zero_vol = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res_zero_vol.status == "ok"
    assert res_zero_vol.stopped is False
    assert res_zero_vol.truncated is False
    assert res_zero_vol.exit_ms == te_ms
    assert res_zero_vol.px == pytest.approx(94.5, abs=1e-12)


def test_case_e_stamp_on_boundary():
    # 08:00:00.000 -> M = 08:00, m0 = 08:01, entry = 08:02
    t_0800_exact = int(dt.datetime(2026, 3, 4, 8, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
    t_0800_59999 = t_0800_exact + 59_999
    t_0801_exact = t_0800_exact + 60_000

    _, store, _, _, _ = build_case_a_setup()

    p1 = make_pair(stamp_ms=t_0800_exact)
    res1 = simulate(p1, store, horizon_hours=4, delay_minutes=1)
    expected_entry1 = t_0800_exact + 2 * lock.MINUTE_MS  # 08:02
    assert res1.entry_ms == expected_entry1

    p2 = make_pair(stamp_ms=t_0800_59999)
    res2 = simulate(p2, store, horizon_hours=4, delay_minutes=1)
    assert res2.entry_ms == expected_entry1

    # Need extra bars for 08:01 stamp (entry at 08:03, te at 12:03)
    extra_token_bars = make_flat_bars(
        t_0800_exact - 1440 * lock.MINUTE_MS,
        t_0800_exact + 250 * lock.MINUTE_MS,
        open_p=100.0,
        high_p=100.0,
        low_p=100.0,
        close_p=100.0,
        volume=5.0,
    )
    extra_btc_bars = make_flat_bars(
        t_0800_exact,
        t_0800_exact + 250 * lock.MINUTE_MS,
        open_p=50000.0,
        high_p=50000.0,
        low_p=50000.0,
        close_p=50000.0,
        volume=5.0,
    )
    extra_store = FakeStore(
        bars_map={"FOOUSDT": extra_token_bars, "BTCUSDT": extra_btc_bars},
        funding_map=store._funding,
    )
    p3 = make_pair(stamp_ms=t_0801_exact)
    res3 = simulate(p3, extra_store, horizon_hours=4, delay_minutes=1)
    expected_entry3 = t_0801_exact + 2 * lock.MINUTE_MS  # 08:03
    assert res3.entry_ms == expected_entry3


def test_case_f_activity_and_entry_checks():
    pair, store, stamp_ms, entry_ms, te_ms = build_case_a_setup()
    m_start = int(dt.datetime(2026, 3, 4, 8, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)

    # 1. Exactly 360 traded minutes passes
    # Build 1440 bars before 08:00 where only 360 have volume > 0
    act_start = m_start - 1440 * lock.MINUTE_MS
    act_end = m_start - lock.MINUTE_MS
    vols = np.zeros(1440, dtype=np.float64)
    vols[:360] = 1.0  # 360 bars with volume 1
    pre_bars = Bars(
        open_time=np.array(list(range(act_start, act_end + 1, lock.MINUTE_MS)), dtype=np.int64),
        open=np.full(1440, 99.0, dtype=np.float64),
        high=np.full(1440, 105.0, dtype=np.float64),
        low=np.full(1440, 90.0, dtype=np.float64),
        close=np.full(1440, 99.0, dtype=np.float64),
        volume=vols,
    )
    post_bars = store._bars["FOOUSDT"].slice_ms(m_start, te_ms + lock.MINUTE_MS)
    store._bars["FOOUSDT"] = Bars(
        open_time=np.concatenate([pre_bars.open_time, post_bars.open_time]),
        open=np.concatenate([pre_bars.open, post_bars.open]),
        high=np.concatenate([pre_bars.high, post_bars.high]),
        low=np.concatenate([pre_bars.low, post_bars.low]),
        close=np.concatenate([pre_bars.close, post_bars.close]),
        volume=np.concatenate([pre_bars.volume, post_bars.volume]),
    )
    res_pass = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res_pass.status == "ok"

    # 2. 359 traded minutes gives excluded/activity
    vols[359] = 0.0
    pre_bars_359 = Bars(
        open_time=pre_bars.open_time,
        open=pre_bars.open,
        high=pre_bars.high,
        low=pre_bars.low,
        close=pre_bars.close,
        volume=vols,
    )
    store._bars["FOOUSDT"] = Bars(
        open_time=np.concatenate([pre_bars_359.open_time, post_bars.open_time]),
        open=np.concatenate([pre_bars_359.open, post_bars.open]),
        high=np.concatenate([pre_bars_359.high, post_bars.high]),
        low=np.concatenate([pre_bars_359.low, post_bars.low]),
        close=np.concatenate([pre_bars_359.close, post_bars.close]),
        volume=np.concatenate([pre_bars_359.volume, post_bars.volume]),
    )
    res_act = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res_act.status == "excluded"
    assert res_act.reason == "activity"
    assert res_act.exit_ms == 0
    assert math.isnan(res_act.pe)
    assert math.isnan(res_act.net)

    # 3. Entry bar with volume 0 gives excluded/entry_bar
    _, store_entry_vol0, _, entry_ms, _ = build_case_a_setup()
    tb = store_entry_vol0._bars["FOOUSDT"]
    idx_ent = tb.index_of(entry_ms)
    tb.volume[idx_ent] = 0.0
    res_ent = simulate(pair, store_entry_vol0, horizon_hours=4, delay_minutes=1)
    assert res_ent.status == "excluded"
    assert res_ent.reason == "entry_bar"

    # 4. Missing BTC entry bar gives excluded/btc_missing
    _, store_btc_miss, _, entry_ms, _ = build_case_a_setup()
    bb = store_btc_miss._bars["BTCUSDT"]
    mask_no_entry = bb.open_time != entry_ms
    store_btc_miss._bars["BTCUSDT"] = Bars(
        open_time=bb.open_time[mask_no_entry],
        open=bb.open[mask_no_entry],
        high=bb.high[mask_no_entry],
        low=bb.low[mask_no_entry],
        close=bb.close[mask_no_entry],
        volume=bb.volume[mask_no_entry],
    )
    res_btc = simulate(pair, store_btc_miss, horizon_hours=4, delay_minutes=1)
    assert res_btc.status == "excluded"
    assert res_btc.reason == "btc_missing"


def test_case_g_delay_profile():
    stamp_ms = int(dt.datetime(2026, 3, 4, 8, 0, 12, tzinfo=dt.UTC).timestamp() * 1000)
    m_start = int(dt.datetime(2026, 3, 4, 8, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)
    pair = make_pair(stamp_ms=stamp_ms)

    # Make bars covering 48 hours
    start_ms = m_start - 1440 * lock.MINUTE_MS
    end_ms = m_start + 2880 * lock.MINUTE_MS
    token_bars = make_flat_bars(start_ms, end_ms, open_p=100.0, volume=5.0)
    btc_bars = make_flat_bars(start_ms, end_ms, open_p=50000.0, volume=5.0)
    store = FakeStore(bars_map={"FOOUSDT": token_bars, "BTCUSDT": btc_bars})

    # delay_minutes = 6 moves entry to 08:07 and te to 12:07 for horizon 4
    res_delay6 = simulate(pair, store, horizon_hours=4, delay_minutes=6)
    expected_entry6 = m_start + 7 * lock.MINUTE_MS  # 08:07
    expected_te6 = expected_entry6 + 4 * lock.HOUR_MS  # 12:07
    assert res_delay6.entry_ms == expected_entry6
    assert res_delay6.te_ms == expected_te6

    # horizon_hours = 24 with delay 1 gives te = next day 08:02
    res_h24 = simulate(pair, store, horizon_hours=24, delay_minutes=1)
    expected_entry1 = m_start + 2 * lock.MINUTE_MS  # 08:02
    expected_te24 = expected_entry1 + 24 * lock.HOUR_MS  # next day 08:02
    assert res_h24.entry_ms == expected_entry1
    assert res_h24.te_ms == expected_te24


def test_case_h_funding_gap():
    pair, store, stamp_ms, entry_ms, te_ms = build_case_a_setup()
    m_start = int(dt.datetime(2026, 3, 4, 8, 0, 0, tzinfo=dt.UTC).timestamp() * 1000)

    # 1. Series with rows only at 04:00 and 16:00 (interval 4) is flagged
    t_0400 = m_start - 4 * lock.HOUR_MS + 5
    t_1600 = m_start + 8 * lock.HOUR_MS + 5
    gap_funding = make_funding([(t_0400, 4.0, 0.0001), (t_1600, 4.0, 0.0001)])
    store._funding["FOOUSDT"] = gap_funding
    res_gap1 = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res_gap1.funding_gap is True

    # 2. Series with no row at or before entry is flagged
    t_1200 = m_start + 4 * lock.HOUR_MS + 5
    no_pre_funding = make_funding([(t_1200, 4.0, 0.0001), (t_1600, 4.0, 0.0001)])
    store._funding["FOOUSDT"] = no_pre_funding
    res_gap2 = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res_gap2.funding_gap is True

    # 3. Series with NaN interval is flagged
    nan_inv_funding = make_funding(
        [
            (m_start + 5, float("nan"), 0.0001),
            (t_1200, 4.0, 0.0001),
            (t_1600, 4.0, 0.0001),
        ]
    )
    store._funding["FOOUSDT"] = nan_inv_funding
    res_gap3 = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res_gap3.funding_gap is True

    # 4. Negative rate flips sign of token funding
    neg_rate_funding = make_funding(
        [
            (m_start + 5, 4.0, 0.0001),
            (t_1200, 4.0, -0.0001),
            (t_1600, 4.0, 0.0001),
        ]
    )
    store._funding["FOOUSDT"] = neg_rate_funding
    res_neg = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res_neg.funding_gap is False
    assert res_neg.funding_token == pytest.approx(-9.5e-5, abs=1e-12)


def test_case_i_costs_floor_and_range():
    pair, store, stamp_ms, entry_ms, te_ms = build_case_a_setup()

    # Small range (10 bps): open 100, high 100.05, low 99.95 -> range 10 bps
    # Range share = 0.25 * 10 = 2.5 bps. Floor 10 bps binds.
    tb = store._bars["FOOUSDT"]
    idx_ent = tb.index_of(entry_ms)
    tb.open[idx_ent] = 100.0
    tb.high[idx_ent] = 100.05
    tb.low[idx_ent] = 99.95
    tb.close[idx_ent] = 100.0

    res_floor = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    # Entry slip is floor 10 bps * 1e-4 * 1.0 = 0.0010
    entry_slip = 10.0 * 1e-4 * 1.0
    exit_range_bps = (94.2 - 93.8) / 94.0 * 1e4
    exit_slip_bps = max(10.0, 0.25 * exit_range_bps)
    exit_slip = exit_slip_bps * 1e-4 * (94.0 / 100.0)
    btc_slip = 1.0 * 1e-4 * (1.0 + 50500.0 / 50000.0)
    assert res_floor.slippage == pytest.approx(entry_slip + exit_slip + btc_slip, abs=1e-12)

    # Large range (200 bps): open 100, high 101.0, low 99.0 -> range 200 bps
    # Range share = 0.25 * 200 = 50 bps. Binds at 50 bps.
    tb.high[idx_ent] = 101.0
    tb.low[idx_ent] = 99.0
    res_range = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    entry_slip_large = 50.0 * 1e-4 * 1.0
    assert res_range.slippage == pytest.approx(entry_slip_large + exit_slip + btc_slip, abs=1e-12)


def test_case_j_max_adverse():
    pair, store, stamp_ms, entry_ms, te_ms = build_case_a_setup()

    # 1. Maximum high on entry bar
    tb = store._bars["FOOUSDT"]
    idx_ent = tb.index_of(entry_ms)
    tb.high[idx_ent] = 115.0
    res_ent_high = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    expected_max_adv1 = 115.0 / 100.0 - 1.0  # 0.15
    assert res_ent_high.max_adverse == pytest.approx(expected_max_adv1, abs=1e-12)

    # 2. Stop fires, value is not cut at the stop
    # Stop fires at 09:10 (high 130.5), but bar at 11:00 has high 135.0
    t_0910 = entry_ms + 68 * lock.MINUTE_MS
    t_1100 = entry_ms + 178 * lock.MINUTE_MS
    idx_0910 = tb.index_of(t_0910)
    idx_1100 = tb.index_of(t_1100)
    tb.high[idx_ent] = 100.4  # reset entry high
    tb.high[idx_0910] = 130.5
    tb.open[idx_0910] = 125.0
    tb.high[idx_1100] = 135.0

    res_stop_adv = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res_stop_adv.stopped is True
    assert res_stop_adv.exit_ms == t_0910
    # Scan range is full range up to 12:01, including 11:00 bar
    expected_max_adv2 = 135.0 / 100.0 - 1.0  # 0.35
    assert res_stop_adv.max_adverse == pytest.approx(expected_max_adv2, abs=1e-12)


def test_simulate_ineligible_pair_assertion():
    _, store, _, _, _ = build_case_a_setup()

    # Pair with no symbol raises AssertionError
    p_no_symbol = make_pair(symbol=None)
    with pytest.raises(AssertionError):
        simulate(p_no_symbol, store, horizon_hours=4)

    # Pair with missing days raises AssertionError
    p_missing = make_pair(missing_days=("2026-03-04",))
    with pytest.raises(AssertionError):
        simulate(p_missing, store, horizon_hours=4)


def test_btc_exit_missing_carries_the_last_close():
    pair, store, stamp_ms, entry_ms, te_ms = build_case_a_setup()
    # BTC has entry bar at 08:02, but no bars within 30 minutes of exit at 12:02
    # Keep only entry bar
    bb = store._bars["BTCUSDT"]
    idx_entry = bb.index_of(entry_ms)
    store._bars["BTCUSDT"] = Bars(
        open_time=np.array([bb.open_time[idx_entry]], dtype=np.int64),
        open=np.array([bb.open[idx_entry]], dtype=np.float64),
        high=np.array([bb.high[idx_entry]], dtype=np.float64),
        low=np.array([bb.low[idx_entry]], dtype=np.float64),
        close=np.array([bb.close[idx_entry]], dtype=np.float64),
        volume=np.array([bb.volume[idx_entry]], dtype=np.float64),
    )

    # No BTC bar at the exit: the close of the last BTC bar at or before it (the entry bar, close 50200) is carried,
    # the pair stays in and is flagged (rule 2: nothing after the entry excludes a pair).
    res = simulate(pair, store, horizon_hours=4, delay_minutes=1)
    assert res.status == "ok"
    assert res.reason is None
    assert res.btc_carried is True
    assert res.bx == pytest.approx(50200.0, abs=1e-12)
    assert res.gross_btc == pytest.approx((50200.0 - 50000.0) / 50000.0, abs=1e-12)
    assert res.exit_ms == te_ms
    assert res.px == pytest.approx(94.0, abs=1e-12)
    assert not math.isnan(res.net)
