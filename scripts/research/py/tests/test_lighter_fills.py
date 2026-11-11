"""Tests for lighter/fills.py: entry and exit fills, the three exits, funding, one position per market.
Hand-built paths and a literal loop reference on random data. Synthetic inputs only."""

from __future__ import annotations

import datetime as dt
import math

import numpy as np
import pytest

from lighter import fills, lock
from lighter import fold_trades as ft
from lighter.data import Market
from lighter.synthetic import blank_minute_data, random_minute_data

MIN = 60_000
HOUR = 3_600_000
T0 = ft.day_start_ms(dt.date(2025, 7, 1))
MKT = Market("BTC", 1, 4)
NAN = float("nan")


def flat_md(n=400, level=100.0, spread=1e-4):
    """Mid 100 in every minute, a taker-buy and a taker-sell first print in every minute (spread either side)."""
    md = blank_minute_data(MKT, T0, n)
    minute = T0 + np.arange(n, dtype=np.int64) * MIN
    for name in ("last_px", "last_buy_px", "last_sell_px"):
        getattr(md, name)[:] = level
    md.first_buy_px[:] = level * (1 + spread)
    md.first_sell_px[:] = level * (1 - spread)
    md.first_buy_ts[:] = minute + 700
    md.first_sell_ts[:] = minute + 700
    md.last_buy_ts[:] = minute + 50_000
    md.last_sell_ts[:] = minute + 50_000
    return md


def set_path(md, path):
    """Mid proxy follows path; the first prints stay a hair either side of it."""
    path = np.asarray(path, dtype=np.float64)
    for name in ("last_px", "last_buy_px", "last_sell_px"):
        getattr(md, name)[:] = path
    md.first_buy_px[:] = path * 1.0001
    md.first_sell_px[:] = path * 0.9999


SP = 2.0  # the spread proxy in bps used by the hand-built contexts


def ctx_for(md, sigma=0.001, funding=None, sp=SP, sp_mult=1.0):
    ng = md.n // 5
    sig = np.full(ng, sigma) if np.isscalar(sigma) else sigma
    f = funding if funding is not None else (np.zeros(0, np.int64), np.zeros(0))
    return fills.build_context(md, sig, f, sp_bps=sp, sp_mult=sp_mult)


def empty_minutes(md, lo, hi):
    """No first print of either side in minutes lo .. hi - 1."""
    for name in ("first_buy_px", "first_sell_px", "first_buy_ts", "first_sell_ts"):
        getattr(md, name)[lo:hi] = NAN


def one(ctx, side, hold, kind, j):
    out = fills.outcomes(ctx, side, hold, (kind,), 0)[kind]
    i = j - out.j0
    return out, i


def test_entry_is_the_first_print_not_last_px():
    md = flat_md()
    md.last_px[10] = 150.0  # a far-away last print must be ignored
    md.first_buy_px[10] = 100.4
    md.first_sell_px[10] = 99.6
    md.first_sell_px[15] = 99.0
    md.first_buy_px[15] = 101.0
    ctx = ctx_for(md)
    out, i = one(ctx, 1, 5, "time", 2)
    assert out.status[i] == fills.STATUS_OK
    assert out.entry_px[i] == 100.4
    assert out.exit_px[i] == 99.0  # a long closes at the first taker SELL print of minute e
    assert out.entry_ts[i] == T0 + 10 * MIN + 700
    assert out.exit_ts[i] == T0 + 15 * MIN + 700
    assert out.gross[i] == pytest.approx(math.log(99.0 / 100.4))
    out, i = one(ctx, -1, 5, "time", 2)
    assert out.entry_px[i] == 99.6 and out.exit_px[i] == 101.0  # a short enters on the sell print, closes on the buy
    assert out.gross[i] == pytest.approx(-math.log(101.0 / 99.6))


def test_no_print_of_either_side_in_the_entry_minute_means_unfilled_and_is_counted_once():
    md = flat_md()
    empty_minutes(md, 10, 11)  # an entry searches minute t only
    ctx = ctx_for(md)
    out, i = one(ctx, 1, 5, "time", 2)
    assert out.status[i] == fills.STATUS_UNFILLED
    sides = np.zeros(ctx.ng, dtype=np.int8)
    sides[2] = 1
    out_s = fills.outcomes(ctx, -1, 5, ("time",), 0)["time"]
    out_l = fills.outcomes(ctx, 1, 5, ("time",), 0)["time"]
    batch = fills.select_trades(ctx, sides, out_l, out_s)
    assert batch.n == 0 and batch.unfilled == 1


def test_unfilled_entry_does_not_hold_the_position():
    md = flat_md()
    empty_minutes(md, 10, 11)
    ctx = ctx_for(md)
    sides = np.zeros(ctx.ng, dtype=np.int8)
    sides[2] = 1
    sides[3] = 1  # one bar later, would be blocked had the first one filled
    ol = fills.outcomes(ctx, 1, 5, ("time",), 0)["time"]
    os_ = fills.outcomes(ctx, -1, 5, ("time",), 0)["time"]
    batch = fills.select_trades(ctx, sides, ol, os_)
    assert batch.n == 1 and batch.j[0] == 3 and batch.unfilled == 1


def test_exit_fill_tries_following_minutes_then_falls_back_flagged():
    md = flat_md()
    empty_minutes(md, 15, 19)  # long closes on a sell order; e = 15 for the entry at 10 with hold 5
    md.first_sell_px[19] = 98.0
    ctx = ctx_for(md)
    out, i = one(ctx, 1, 5, "time", 2)
    assert out.exit_px[i] == 98.0 and not out.flag[i]
    assert out.exit_ts[i] == T0 + 19 * MIN + 700

    md = flat_md()
    empty_minutes(md, 15, 30)  # minutes 15..29 are empty, minute 30 = e + 15 is the last one tried
    md.first_sell_px[30] = 97.0
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.exit_px[i] == 97.0 and not out.flag[i]

    md = flat_md()
    empty_minutes(md, 15, 31)  # nothing in the 16 minutes e .. e + 15
    md.last_px[30] = md.last_buy_px[30] = md.last_sell_px[30] = 96.5  # the mid proxy of minute e + 15
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.flag[i]
    assert out.exit_px[i] == pytest.approx(96.5 * (1 - 0.5 * SP / 1e4))  # a long exit sells: down by half the proxy
    assert out.exit_ts[i] == T0 + 31 * MIN  # stamped with the end of minute e + 15
    out, i = one(ctx_for(md), -1, 5, "time", 2)  # a short exit buys: up by half the proxy
    assert out.flag[i] and out.exit_px[i] == pytest.approx(96.5 * (1 + 0.5 * SP / 1e4))


# ----------------------------------------------------------------------------------------------------------------
# The print-selection rule: first print of EITHER side, the far quote for an opposite-side print


def one_sided_minute(md, m, side, px, ts_off=700):
    """Minute m holds only a taker print of `side` (+1 buy, -1 sell)."""
    empty_minutes(md, m, m + 1)
    if side > 0:
        md.first_buy_px[m], md.first_buy_ts[m] = px, T0 + m * MIN + ts_off
    else:
        md.first_sell_px[m], md.first_sell_ts[m] = px, T0 + m * MIN + ts_off


def test_an_opposite_side_print_is_moved_by_the_spread_proxy_against_the_order():
    md = flat_md()
    one_sided_minute(md, 10, -1, 99.9)  # only a taker SELL print in the entry minute
    ctx = ctx_for(md)
    out, i = one(ctx, 1, 5, "time", 2)  # a long entry is a buy order: it fills at sell_px x (1 + sp)
    assert out.entry_px[i] == pytest.approx(99.9 * (1 + SP / 1e4))
    assert out.entry_ts[i] == T0 + 10 * MIN + 700
    md = flat_md()
    one_sided_minute(md, 10, 1, 100.1)  # only a taker BUY print
    out, i = one(ctx_for(md), -1, 5, "time", 2)  # a short entry is a sell order: buy_px x (1 - sp)
    assert out.entry_px[i] == pytest.approx(100.1 * (1 - SP / 1e4))
    # exits: the sell order of a long exit meets only a buy print, the buy order of a short exit only a sell print
    md = flat_md()
    one_sided_minute(md, 15, 1, 100.2)
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.exit_px[i] == pytest.approx(100.2 * (1 - SP / 1e4)) and not out.flag[i]
    md = flat_md()
    one_sided_minute(md, 15, -1, 99.8)
    out, i = one(ctx_for(md), -1, 5, "time", 2)
    assert out.exit_px[i] == pytest.approx(99.8 * (1 + SP / 1e4))


def test_the_earlier_of_the_two_first_prints_decides_and_a_tie_goes_to_the_same_side():
    md = flat_md()
    md.first_buy_ts[10], md.first_sell_ts[10] = T0 + 10 * MIN + 900, T0 + 10 * MIN + 600  # the sell came first
    md.first_buy_px[10], md.first_sell_px[10] = 100.5, 99.5
    ctx = ctx_for(md)
    out, i = one(ctx, 1, 5, "time", 2)  # buy order: the earlier print is a sell, moved up
    assert out.entry_px[i] == pytest.approx(99.5 * (1 + SP / 1e4)) and out.entry_ts[i] == T0 + 10 * MIN + 600
    out, i = one(ctx, -1, 5, "time", 2)  # sell order: the earlier print is a sell: same side, its own price
    assert out.entry_px[i] == pytest.approx(99.5) and out.entry_ts[i] == T0 + 10 * MIN + 600
    md.first_buy_ts[10], md.first_sell_ts[10] = T0 + 10 * MIN + 600, T0 + 10 * MIN + 900  # the buy came first
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.entry_px[i] == pytest.approx(100.5)
    out, i = one(ctx_for(md), -1, 5, "time", 2)
    assert out.entry_px[i] == pytest.approx(100.5 * (1 - SP / 1e4))
    md.first_buy_ts[10] = md.first_sell_ts[10] = T0 + 10 * MIN + 750  # a tie: the WORSE of the two prices
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.entry_px[i] == pytest.approx(100.5)  # same-side 100.5 against the adjusted 99.5 x (1 + sp)
    assert out.ties[i] == 2  # the entry minute and the exit minute of flat_md both tie
    out, i = one(ctx_for(md), -1, 5, "time", 2)
    assert out.entry_px[i] == pytest.approx(99.5)
    # a crossed book makes the adjusted opposite-side price the worse one: it is the one charged
    md.first_buy_px[10], md.first_sell_px[10] = 99.5, 100.5
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.entry_px[i] == pytest.approx(100.5 * (1 + SP / 1e4))
    out, i = one(ctx_for(md), -1, 5, "time", 2)
    assert out.entry_px[i] == pytest.approx(99.5 * (1 - SP / 1e4))


def test_an_entry_searches_its_own_minute_only_and_an_exit_sixteen_minutes():
    md = flat_md()
    empty_minutes(md, 10, 11)  # no print in the entry minute: unfilled, although minute 11 has prints
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.status[i] == fills.STATUS_UNFILLED
    md = flat_md()
    one_sided_minute(md, 10, -1, 99.9, ts_off=500)  # a print exactly at t + 500 ms fills
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.status[i] == fills.STATUS_OK and out.entry_ts[i] == T0 + 10 * MIN + 500
    # exits: minute t first, then t + 1 .. t + 15, the proxy is that of the month of t
    md = flat_md()
    empty_minutes(md, 15, 17)
    one_sided_minute(md, 17, 1, 100.2)
    sp = np.full(md.n, 1.0)
    sp[17:] = 50.0  # the fill minute is in a month with another proxy: the proxy of minute t (15) is used
    out, i = one(ctx_for(md, sp=sp), 1, 5, "time", 2)
    assert out.exit_px[i] == pytest.approx(100.2 * (1 - 1.0 / 1e4)) and out.exit_ts[i] == T0 + 17 * MIN + 700
    md = flat_md()
    empty_minutes(md, 15, 30)  # the print is in minute 30 = t + 15: still found
    assert one(ctx_for(md), 1, 5, "time", 2)[0].flag[2] == False  # noqa: E712
    md = flat_md()
    empty_minutes(md, 15, 31)  # minute 31 = t + 16 is out of reach: the flagged fallback
    assert one(ctx_for(md), 1, 5, "time", 2)[0].flag[2]


def test_sp_fill_is_the_max_of_the_month_proxy_and_the_quoted_spread_of_the_fill_minute_and_the_one_before():
    md = flat_md()
    one_sided_minute(md, 10, -1, 99.9)  # a buy order meets a sell print: moved by sp_fill
    # x(10): both last prints 1 s apart and 6 bps apart
    md.last_buy_px[10], md.last_sell_px[10] = 100.03, 99.97
    md.last_buy_ts[10], md.last_sell_ts[10] = T0 + 10 * MIN + 30_000, T0 + 10 * MIN + 31_000
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    x10 = (100.03 - 99.97) / 100.0 * 1e4
    assert out.entry_px[i] == pytest.approx(99.9 * (1 + max(SP, x10) / 1e4))
    assert out.cost[i] == pytest.approx((max(SP, x10) + SP) / 2)  # entry sp_fill and the exit's month proxy
    # the minute before counts too
    md = flat_md()
    one_sided_minute(md, 10, -1, 99.9)
    md.last_buy_px[9], md.last_sell_px[9] = 100.05, 99.95
    md.last_buy_ts[9], md.last_sell_ts[9] = T0 + 9 * MIN + 30_000, T0 + 9 * MIN + 30_000
    x9 = (100.05 - 99.95) / 100.0 * 1e4
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.entry_px[i] == pytest.approx(99.9 * (1 + max(SP, x9) / 1e4))
    # a pair more than 2 s apart is undefined, a negative x counts as 0
    md = flat_md()
    one_sided_minute(md, 10, -1, 99.9)
    md.last_buy_px[10], md.last_sell_px[10] = 100.2, 99.8
    md.last_buy_ts[10], md.last_sell_ts[10] = T0 + 10 * MIN + 30_000, T0 + 10 * MIN + 32_001
    assert one(ctx_for(md), 1, 5, "time", 2)[0].entry_px[2] == pytest.approx(99.9 * (1 + SP / 1e4))
    md.last_buy_ts[10] = T0 + 10 * MIN + 32_000  # exactly 2,000 ms: defined
    assert one(ctx_for(md), 1, 5, "time", 2)[0].entry_px[2] > 99.9 * (1 + 3 * SP / 1e4)
    md.last_buy_px[10], md.last_sell_px[10] = 99.8, 100.2  # crossed: negative x is 0
    assert one(ctx_for(md), 1, 5, "time", 2)[0].entry_px[2] == pytest.approx(99.9 * (1 + SP / 1e4))
    # the fallback uses sp_fill / 2 with t' = t + 15
    md = flat_md()
    empty_minutes(md, 15, 31)
    md.last_buy_px[30], md.last_sell_px[30] = 100.1, 99.9
    md.last_buy_ts[30] = md.last_sell_ts[30] = T0 + 30 * MIN + 1000
    out, i = one(ctx_for(md), 1, 5, "time", 2)
    assert out.flag[i] and out.exit_px[i] == pytest.approx(100.0 * (1 - 0.5 * 20.0 / 1e4))


def test_the_doubled_spread_proxy_moves_every_use_of_sp():
    md = flat_md()
    one_sided_minute(md, 10, -1, 99.9)
    out, i = one(ctx_for(md, sp_mult=2.0), 1, 5, "time", 2)
    assert out.entry_px[i] == pytest.approx(99.9 * (1 + 2 * SP / 1e4))
    md = flat_md()
    empty_minutes(md, 15, 31)
    out, i = one(ctx_for(md, sp_mult=2.0), 1, 5, "time", 2)
    assert out.flag[i] and out.exit_px[i] == pytest.approx(100.0 * (1 - 0.5 * 2 * SP / 1e4))


def test_one_position_per_market_and_boundary_equality():
    md = flat_md()
    ctx = ctx_for(md)
    sides = np.zeros(ctx.ng, dtype=np.int8)
    sides[[2, 3, 4, 5]] = 1  # entries at 10, 15, 20, 25 minutes, hold 5
    ol = fills.outcomes(ctx, 1, 5, ("time",), 0)["time"]
    os_ = fills.outcomes(ctx, -1, 5, ("time",), 0)["time"]
    batch = fills.select_trades(ctx, sides, ol, os_)
    # the exit fill of the entry at 10 is at 15 min + 0.7 s, after the next grid point: blocked. Entry 20 is free.
    assert batch.j.tolist() == [2, 4]
    assert batch.exit_ts.tolist() == [T0 + 15 * MIN + 700, T0 + 25 * MIN + 700]

    # exit fill exactly at the next grid time is allowed ("at or before g"), one millisecond later is not
    for delta, expect in ((0, [2, 3]), (1, [2])):
        outs = fills.Outcomes(
            j0=0,
            j1=9,
            status=np.full(10, fills.STATUS_OK, np.int8),
            entry_ts=np.zeros(10, np.int64),
            exit_ts=np.full(10, T0 + 15 * MIN + delta, np.int64),
            entry_px=np.full(10, 100.0),
            exit_px=np.full(10, 100.0),
            flag=np.zeros(10, bool),
            gross=np.zeros(10),
            fund=np.zeros(10),
            net=np.zeros(10),
            miss=np.zeros(10, np.int64),
            nsettle=np.zeros(10, np.int64),
            cost=np.zeros(10),
            ties=np.zeros(10, np.int64),
        )
        # entry 2 releases at grid point 3 exactly (delta 0) or one ms after it
        outs.exit_ts[2] = T0 + 3 * lock.GRID_MS + delta
        outs.exit_ts[3] = T0 + 4 * lock.GRID_MS - 1
        sides = np.zeros(10, dtype=np.int8)
        sides[[2, 3]] = 1
        b = fills.select_trades(ctx, sides, outs, outs)
        assert b.j.tolist() == expect


def test_unfilled_while_a_position_is_open_is_not_counted():
    md = flat_md()
    empty_minutes(md, 15, 31)
    ctx = ctx_for(md)
    sides = np.zeros(ctx.ng, dtype=np.int8)
    sides[[2, 3]] = 1  # the second would be unfilled, but the first position is still open
    ol = fills.outcomes(ctx, 1, 5, ("time",), 0)["time"]
    os_ = fills.outcomes(ctx, -1, 5, ("time",), 0)["time"]
    batch = fills.select_trades(ctx, sides, ol, os_)
    assert batch.j.tolist() == [2] and batch.unfilled == 0


def _path_md(moves: dict[int, float], n=400, base=100.0):
    """Mid path = base except the given minute -> level map (levels hold until the next entry)."""
    path = np.full(n, base)
    for m, v in sorted(moves.items()):
        path[m:] = v
    md = flat_md(n)
    set_path(md, path)
    return md


SIGMA = 0.001
HOLD = 30
SIGMA_H = SIGMA * math.sqrt(HOLD / 5)  # 0.00245


def _exit_minute(md, side, kind, hold=HOLD, j=2):
    ctx = ctx_for(md, SIGMA)
    out = fills.outcomes(ctx, side, hold, (kind,), 0)[kind]
    i = j - out.j0
    px = md.first_sell_px if side > 0 else md.first_buy_px
    minute = int(round((out.exit_ts[i] - T0 - 700) / MIN))
    assert px[minute] == pytest.approx(out.exit_px[i], rel=1e-6)  # a tie at the fill: within 1e-8 of the print
    return minute - 5 * j, out, i  # minutes after the entry


def test_target1_long_fires_at_first_mark_above_sigma_h():
    # +0.3% from minute mg + 8 on (mg = 10): the mark of minute 18 belongs to t = 19, so e - mg = 9
    md = _path_md({18: 100.3})
    m, out, i = _exit_minute(md, 1, "target1")
    assert m == 9
    assert out.net[i] == pytest.approx(math.log(100.3 * 0.9999 / (100.0 * 1.0001)), abs=1e-7)  # ties: 1e-8 off


def test_stop2_target2_needs_two_sigma():
    md = _path_md({18: 100.3})  # 0.3% < 0.49%: only target1 fires
    assert _exit_minute(md, 1, "stop2_target2")[0] == HOLD
    md = _path_md({18: 100.3, 22: 100.6})  # 0.6% > 0.49%
    assert _exit_minute(md, 1, "stop2_target2")[0] == 13
    md = _path_md({20: 99.4})  # a stop: u = -0.6%
    assert _exit_minute(md, 1, "stop2_target2")[0] == 11
    assert _exit_minute(md, 1, "target1")[0] == HOLD  # a loss never trips target1


def test_exits_for_a_short():
    md = _path_md({18: 99.7})  # price falls 0.3%: the short is up 0.3%
    assert _exit_minute(md, -1, "target1")[0] == 9
    assert _exit_minute(md, -1, "stop2_target2")[0] == HOLD
    md = _path_md({18: 100.6})  # price rises 0.6%: the short is stopped
    assert _exit_minute(md, -1, "stop2_target2")[0] == 9


def test_only_marks_strictly_inside_the_hold_are_examined():
    # marks are the mid of minutes mg .. mg + hold - 2 (t = g + 1 min .. g + hold - 1 min)
    last_examined = 10 + HOLD - 2
    md = _path_md({last_examined: 100.4})
    assert _exit_minute(md, 1, "target1")[0] == HOLD - 1
    md = _path_md({last_examined + 1: 100.4})  # the mark at t = g + hold is not looked at
    assert _exit_minute(md, 1, "target1")[0] == HOLD
    md = _path_md({10: 100.4})  # the very first mark, the mid of minute mg, already counts
    md.first_buy_px[10] = 100.0  # the entry print of that minute was before the move
    md.first_sell_px[10] = 99.0  # (and the tie rule must not pick the opposite print: its adjusted price is lower)
    assert _exit_minute(md, 1, "target1")[0] == 1


def test_first_hit_wins_and_exit_fill_uses_the_print_not_the_mark():
    md = _path_md({15: 99.4, 18: 100.7})  # the stop at 15 comes first, a later target does not matter
    m, out, i = _exit_minute(md, 1, "stop2_target2")
    assert m == 6
    assert out.exit_px[i] == pytest.approx(99.4 * 0.9999)


def test_candidate_without_sigma_is_counted_not_traded():
    md = flat_md()
    ctx = ctx_for(md, sigma=np.where(np.arange(80) == 2, np.nan, 0.001))
    out = fills.outcomes(ctx, 1, 15, ("time", "target1"), 0)
    assert out["time"].status[2] == fills.STATUS_OK
    assert out["target1"].status[2] == fills.STATUS_NO_SIGMA
    sides = np.zeros(ctx.ng, dtype=np.int8)
    sides[2] = 1
    os_ = fills.outcomes(ctx, -1, 15, ("target1",), 0)["target1"]
    batch = fills.select_trades(ctx, sides, out["target1"], os_)
    assert batch.n == 0 and batch.no_sigma == 1


# ----------------------------------------------------------------------------------------------------------------
# Funding


def funding_for(rates: dict[int, float], hours=12):
    """rate_long_pays per absolute hour h (hour h is T0 + h hours); missing hours are simply absent."""
    hs = sorted(rates)
    ts = np.array([T0 + h * HOUR for h in hs], dtype=np.int64)
    return ts, np.array([rates[h] for h in hs])


def funded_trade(side, entry_ts, exit_ts, rates, hold=60):
    md = flat_md(500)
    mg = 60  # entry grid point 12, exit decision at minute 120
    # the order's own side prints at the stamp, the other side a second later (so the order's side is the earlier)
    for m, ts in ((mg, entry_ts), (mg + hold, exit_ts)):
        own_buy = (side > 0) if m == mg else (side < 0)
        if own_buy:
            md.first_buy_ts[m], md.first_sell_ts[m] = ts, ts + 1000
        else:
            md.first_sell_ts[m], md.first_buy_ts[m] = ts, ts + 1000
    ctx = ctx_for(md, funding=funding_for(rates))
    out = fills.outcomes(ctx, side, hold, ("time",), 0)["time"]
    i = 12 - out.j0
    return out, i


RATES = {1: 1e-4, 2: 2e-4, 3: 4e-4}


def test_funding_window_edges_and_sign():
    h1, h2 = T0 + 1 * HOUR, T0 + 2 * HOUR
    # entry exactly on settlement 1 (excluded: entry < s), exit exactly on settlement 2 (included: s <= exit)
    out, i = funded_trade(1, h1, h2, RATES)
    assert out.fund[i] == pytest.approx(2e-4)  # a long pays a positive rate
    assert out.net[i] == pytest.approx(out.gross[i] - 2e-4)
    out, i = funded_trade(-1, h1, h2, RATES)
    assert out.fund[i] == pytest.approx(-2e-4)  # a short receives it
    assert out.net[i] == pytest.approx(out.gross[i] + 2e-4)
    # one millisecond earlier on entry: settlement 1 now counts. One millisecond earlier on exit: settlement 2 drops
    out, i = funded_trade(1, h1 - 1, h2, RATES)
    assert out.fund[i] == pytest.approx(3e-4)
    out, i = funded_trade(1, h1, h2 - 1, RATES)
    assert out.fund[i] == pytest.approx(0.0)
    out, i = funded_trade(1, h1 - 1, h2 + 2 * HOUR, RATES)  # 1, 2, 3 (exit decision still minute 120, stamp is later)
    assert out.fund[i] == pytest.approx(7e-4)


def test_negative_rate_pays_the_long_back_and_missing_rows_count_zero():
    h1, h2 = T0 + 1 * HOUR, T0 + 2 * HOUR
    out, i = funded_trade(1, h1 - 1, h2, {1: -1e-4, 2: -2e-4})
    assert out.fund[i] == pytest.approx(-3e-4)
    assert out.net[i] == pytest.approx(out.gross[i] + 3e-4)
    assert out.miss[i] == 0
    out, i = funded_trade(1, h1 - 1, h2, {1: 1e-4})  # settlement 2 has no row
    assert out.fund[i] == pytest.approx(1e-4)
    assert out.miss[i] == 1
    out, i = funded_trade(1, h1 - 1, h2, {})
    assert out.fund[i] == 0.0 and out.miss[i] == 2


def test_off_grid_funding_rows_are_not_used():
    md = flat_md(500)
    ts = np.array([T0 + HOUR + 1], dtype=np.int64)
    ctx = ctx_for(md, funding=(ts, np.array([5e-4])))
    out = fills.outcomes(ctx, 1, 60, ("time",), 0)["time"]
    assert np.nansum(np.abs(out.fund)) == 0.0


# ----------------------------------------------------------------------------------------------------------------
# A literal loop against the vectorised engine


def ref_xs(md):
    """x(m) in bps, one minute at a time (spec text)."""
    out = np.zeros(md.n)
    for m in range(md.n):
        b, a = md.last_buy_px[m], md.last_sell_px[m]
        if math.isnan(b) or math.isnan(a):
            continue
        if abs(md.last_buy_ts[m] - md.last_sell_ts[m]) > 2000:
            continue
        out[m] = max(0.0, (b - a) * 1e4 / ((b + a) / 2))
    return out


def ref_fill(md, sp, xs, order_side, m, search):
    """The first print of either side in minutes m .. m + search (spec text, one minute at a time).

    Returns (minute, price, timestamp, sp_fill, tie) or None.
    """
    for k in range(m, m + search + 1):
        tb, tsl = md.first_buy_ts[k], md.first_sell_ts[k]
        has_b, has_s = not math.isnan(tb), not math.isnan(tsl)
        if not (has_b or has_s):
            continue
        spf = max(sp[m], xs[k], xs[max(k - 1, 0)])
        adj = spf / 1e4
        tie = has_b and has_s and tb == tsl
        if order_side > 0:
            if has_b and (not has_s or tb < tsl):
                return k, md.first_buy_px[k], int(tb), spf, False
            if tie:
                return k, max(md.first_buy_px[k], md.first_sell_px[k] * (1 + adj)), int(tb), spf, True
            return k, md.first_sell_px[k] * (1 + adj), int(tsl), spf, False
        if has_s and (not has_b or tsl < tb):
            return k, md.first_sell_px[k], int(tsl), spf, False
        if tie:
            return k, min(md.first_sell_px[k], md.first_buy_px[k] * (1 - adj)), int(tsl), spf, True
        return k, md.first_buy_px[k] * (1 - adj), int(tb), spf, False
    return None


def ref_run(md, ctx, sides, hold, kind, f_map, sp):
    """One trade at a time, straight from the specification."""
    mid = ctx.mid
    sigma = ctx.sigma
    n = md.n
    xs = ref_xs(md)
    j1 = (n - 2 - hold - 15) // 5
    trades, unfilled, no_sigma = [], 0, 0
    busy = -(10**18)
    for j in range(len(sides)):
        if sides[j] == 0 or j > j1:
            continue
        g = T0 + j * lock.GRID_MS
        if g < busy:
            continue
        side = int(sides[j])
        mg = 5 * j
        fill = ref_fill(md, sp, xs, side, mg, 0)
        if fill is None:
            unfilled += 1
            continue
        _, entry_px, entry_ts, e_sp, e_tie = fill
        e = mg + hold
        if kind != "time":
            s = sigma[j]
            if math.isnan(s):
                no_sigma += 1
                continue
            sh = s * math.sqrt(hold / 5)
            for t in range(1, hold):
                u = side * math.log(mid[mg + t - 1] / entry_px)
                if (kind == "stop2_target2" and (u <= -2 * sh or u >= 2 * sh)) or (kind == "target1" and u >= sh):
                    e = mg + t
                    break
        xfill = ref_fill(md, sp, xs, -side, e, 15)
        if xfill is None:
            flagged = True
            x_sp = max(sp[e], xs[e + 15], xs[e + 14])
            exit_px = mid[e + 15] * (1 - side * 0.5 * x_sp / 1e4)
            exit_ts = T0 + (e + 16) * MIN
            x_tie = False
        else:
            flagged = False
            _, exit_px, exit_ts, x_sp, x_tie = xfill
        fund, miss = 0.0, 0
        for h in range(int(entry_ts) // HOUR + 1, exit_ts // HOUR + 1):
            r = f_map.get(h * HOUR)
            if r is None:
                miss += 1
            else:
                fund += r
        net = side * math.log(exit_px / entry_px) - side * fund
        trades.append((j, net, exit_ts, flagged, miss, (e_sp + x_sp) / 2, int(e_tie) + int(x_tie)))
        busy = exit_ts
    return trades, unfilled, no_sigma


@pytest.mark.parametrize("hold", lock.HOLDS)
def test_engine_matches_literal_loop_on_random_data(hold):
    md = random_minute_data(MKT, T0, 2, seed=hold)
    rng = np.random.default_rng(hold)
    ng = md.n // 5
    sigma = np.where(rng.random(ng) < 0.9, 4e-4 * (0.5 + rng.random(ng)), np.nan)
    h0 = T0 // HOUR
    f_ts = (h0 + np.arange(60)) * HOUR
    f_rate = rng.normal(0, 2e-4, 60)
    keep = rng.random(60) < 0.9
    f_map = {int(t): float(r) for t, r, k in zip(f_ts, f_rate, keep, strict=True) if k}
    sp = 0.5 + 3.0 * rng.random(md.n)
    ctx = fills.build_context(md, sigma, (f_ts[keep], f_rate[keep]), sp_bps=sp)
    kinds = lock.EXITS
    ol = fills.outcomes(ctx, 1, hold, kinds, 0)
    os_ = fills.outcomes(ctx, -1, hold, kinds, 0)
    total = 0
    for density in (0.03, 0.5):
        sides = np.where(rng.random(ng) < density, rng.choice([-1, 1], ng), 0).astype(np.int8)
        for kind in kinds:
            want, unf, nos = ref_run(md, ctx, sides, hold, kind, f_map, sp)
            got = fills.select_trades(ctx, sides, ol[kind], os_[kind])
            assert got.j.tolist() == [w[0] for w in want], (hold, kind, density)
            np.testing.assert_allclose(got.net, [w[1] for w in want], rtol=1e-9, atol=1e-12)
            assert got.exit_ts.tolist() == [w[2] for w in want]
            assert got.flag.tolist() == [w[3] for w in want]
            assert got.miss.tolist() == [w[4] for w in want]
            np.testing.assert_allclose(got.cost, [w[5] for w in want], rtol=1e-9, atol=1e-12)
            assert got.ties.tolist() == [w[6] for w in want]
            assert (got.unfilled, got.no_sigma) == (unf, nos)
            total += len(want)
    assert total > 20


# ----------------------------------------------------------------------------------------------------------------
# Regression: the print-selection bias (the old rule waited for a print of the order's own side)


def old_rule_gross(md, sides, mg, hold):
    """The REJECTED rule: enter at the first same-side print of minute g, exit at the first same-side print at or
    after the exit minute (up to 15 minutes later). Kept only to show the defect. NaN where it does not fill."""
    fb, fs = md.first_buy_px, md.first_sell_px
    nxt_b = fills._next_valid(~np.isnan(fb))
    nxt_s = fills._next_valid(~np.isnan(fs))
    e = mg + hold
    gross = np.full(len(mg), np.nan)
    for k, side in enumerate(sides):
        entry = fb[mg[k]] if side > 0 else fs[mg[k]]
        nxt = nxt_s[e[k]] if side > 0 else nxt_b[e[k]]  # a long closes with a sell order, a short with a buy order
        if np.isnan(entry) or nxt - e[k] > 15:
            continue
        exit_px = fs[nxt] if side > 0 else fb[nxt]
        gross[k] = side * (np.log(exit_px) - np.log(entry))
    return gross


@pytest.fixture(scope="module")
def micro_panel(tmp_path_factory):
    from lighter import run
    from lighter.data import DataReader
    from lighter.synthetic import PanelSpec, make_panel

    root = tmp_path_factory.mktemp("micro")
    panel = make_panel(
        root, PanelSpec(n_markets=2, days=8, seed=17, micro=True, half_spreads_bps=(1.0, 1.0), micro_impact_bps=0.5)
    )
    reader = DataReader(
        fold_dir=panel.fold_dir,
        binance_dir=panel.binance_dir,
        funding_dir=panel.funding_dir,
        mode="dev",
        last_date=panel.last_date,
    )
    span = run.Span(lock.DEV_FIRST_DATE, panel.last_date)
    cost = reader.month_cost_stats(2025, 6)
    out = []
    for market in reader.load_markets():
        md = reader.load_minutes(market, span.t0_ms, span.end_ms)
        out.append((md, cost[market.market_id].spread_proxy_bps, span))
    return out


def test_old_rule_nets_above_minus_the_spread_and_the_new_rule_about_minus_the_spread(micro_panel):
    hold = 15
    diffs, new_all, old_all, proxies = [], [], [], []
    for k, (md, proxy, span) in enumerate(micro_panel):
        ng = md.n // 5
        ctx = fills.build_context(md, np.full(ng, 1e-3), (np.zeros(0, np.int64), np.zeros(0)), sp_bps=proxy)
        j_lo = span.start_j
        ol = fills.outcomes(ctx, 1, hold, ("time",), j_lo)["time"]
        os_ = fills.outcomes(ctx, -1, hold, ("time",), j_lo)["time"]
        rng = np.random.default_rng(100 + k)
        j = np.arange(ol.j0, ol.j1 + 1)
        sides = rng.choice(np.array([-1, 1]), size=len(j))  # random sides, independent of everything
        new = np.where(sides > 0, ol.gross, os_.gross)
        ok_new = np.where(sides > 0, ol.status, os_.status) == fills.STATUS_OK
        old = old_rule_gross(md, sides, j * 5, hold)
        keep = ok_new & ~np.isnan(old)
        diffs.append((old - new)[keep])
        new_all.append(new[keep])
        old_all.append(old[keep])
        proxies.append(proxy)
    new, old, d = np.concatenate(new_all), np.concatenate(old_all), np.concatenate(diffs)
    spread = float(np.mean(proxies))  # bps; the measured proxy is the full round-trip cost of crossing the spread
    assert 1.2 < spread < 2.4, spread  # half spread 1 bp each side, less the impact between the two last prints
    # decisions every 5 minutes with a 15 minute hold overlap three deep: inflate the standard error by sqrt(3)
    se_new = new.std() / np.sqrt(len(new) / 3) * 1e4
    se_diff = d.std() / np.sqrt(len(d) / 3) * 1e4
    mean_new, mean_old = new.mean() * 1e4, old.mean() * 1e4
    diff = d.mean() * 1e4
    print(f"spread {spread:.3f} new {mean_new:.3f}+-{se_new:.3f} old {mean_old:.3f} diff {diff:.3f}+-{se_diff:.3f}")
    # the engine's rule: about minus one spread (tolerance: 3 standard errors, and not less than 0.3 bps for the
    # proxy's own estimation error)
    assert abs(mean_new + spread) < max(3 * se_new, 0.3)
    # the old rule gains from waiting out runs against it: clearly above minus the spread, by many standard errors
    assert d.mean() * 1e4 > 5 * se_diff
    assert mean_old > -spread + 0.3
