"""Lighter stage 2: entry and exit fills, the three exit rules, funding and the one-position-per-market selection.

Everything is vectorised over grid points. For one (market, side, hold) the outcome of entering at EVERY grid point is
computed once per exit rule (`outcomes`), and each signal configuration then only picks its own entries and walks the
chain of non-overlapping trades (`select_trades`), which loops over the trades taken and nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from lighter import lock
from lighter.data import MinuteData
from lighter.signals import GRID_MIN, mid_proxy

BIG = 1 << 40
_PATH_CHUNK = 4096

STATUS_OUT = 0
STATUS_OK = 1
STATUS_UNFILLED = 2
STATUS_NO_SIGMA = 3
STATUS_NO_EXIT = 4


@dataclass
class FillContext:
    t0_ms: int
    n: int
    ng: int
    mid: np.ndarray
    logmid: np.ndarray
    fb_px: np.ndarray
    fb_ts: np.ndarray
    fs_px: np.ndarray
    fs_ts: np.ndarray
    nxt_any: np.ndarray  # next minute at or after m with a first print of either side
    sp_bps: np.ndarray  # spread proxy of the month containing each minute, in bps (NaN: none yet, cannot carry a fill)
    xs: np.ndarray  # x(m): last_buy_px - last_sell_px over the mid in bps, 0 where the minute has no pair 2 s apart
    sp_mult: float
    sigma: np.ndarray
    hour0: int
    cum_rate: np.ndarray
    cum_miss: np.ndarray
    break_min: int = BIG  # first minute of an excluded scale break (confirmation only): trades open then exit at it


def quote_spread(md: MinuteData) -> np.ndarray:
    """x(m) in bps: (last_buy_px - last_sell_px) / ((last_buy_px + last_sell_px) / 2) when both exist in minute m and
    |last_buy_ts - last_sell_ts| <= 2,000 ms (the pair rule of the eligibility proxy), else 0. Negative values count
    as 0.

    It is used only to price a fill, never a decision.
    """
    with np.errstate(invalid="ignore", divide="ignore"):
        pair = (
            ~np.isnan(md.last_buy_px)
            & ~np.isnan(md.last_sell_px)
            & (np.abs(md.last_buy_ts - md.last_sell_ts) <= lock.ELIG_MAX_TS_GAP_MS)
        )
        x = (md.last_buy_px - md.last_sell_px) * lock.BPS / ((md.last_buy_px + md.last_sell_px) / 2.0)
    return np.where(pair & np.isfinite(x), np.maximum(x, 0.0), 0.0)


def _next_valid(valid: np.ndarray) -> np.ndarray:
    idx = np.where(valid, np.arange(len(valid), dtype=np.int64), BIG)
    return np.minimum.accumulate(idx[::-1])[::-1]


def build_context(
    md: MinuteData,
    sigma: np.ndarray,
    funding: tuple[np.ndarray, np.ndarray],
    mid: np.ndarray | None = None,
    sp_bps: np.ndarray | float = 0.0,
    sp_mult: float = 1.0,
    break_min: int | None = None,
) -> FillContext:
    if mid is None:
        mid, _ = mid_proxy(md)
    with np.errstate(invalid="ignore", divide="ignore"):
        logmid = np.where(mid > 0, np.log(np.where(mid > 0, mid, 1.0)), np.nan)
    hour0 = md.t0_ms // lock.HOUR_MS
    nh = md.n // 60 + 3
    rate = np.full(nh, np.nan)
    f_ts, f_rate = funding
    if len(f_ts):
        on_grid = (f_ts % lock.HOUR_MS) == 0
        h = f_ts[on_grid] // lock.HOUR_MS - hour0
        inside = (h >= 0) & (h < nh)
        rate[h[inside]] = f_rate[on_grid][inside]
    cum_rate = np.concatenate([[0.0], np.cumsum(np.nan_to_num(rate))])
    cum_miss = np.concatenate([[0], np.cumsum(np.isnan(rate))]).astype(np.int64)
    sp = np.full(md.n, float(sp_bps)) if np.isscalar(sp_bps) else np.asarray(sp_bps, dtype=np.float64)
    brk = BIG if break_min is None else int(break_min)
    if brk < md.n:
        logmid = logmid.copy()
        logmid[brk:] = np.nan  # no stop/target mark across a scale break
    return FillContext(
        t0_ms=md.t0_ms,
        n=md.n,
        ng=md.n // GRID_MIN,
        mid=mid,
        logmid=logmid,
        fb_px=md.first_buy_px,
        fb_ts=md.first_buy_ts,
        fs_px=md.first_sell_px,
        fs_ts=md.first_sell_ts,
        nxt_any=_next_valid(~np.isnan(md.first_buy_px) | ~np.isnan(md.first_sell_px)),
        sp_bps=sp,
        xs=quote_spread(md),
        sp_mult=float(sp_mult),
        sigma=sigma,
        hour0=hour0,
        cum_rate=cum_rate,
        cum_miss=cum_miss,
        break_min=brk,
    )


@dataclass
class Outcomes:
    """The result of entering at grid points j0..j1 on one side with one hold and exit rule."""

    j0: int
    j1: int
    status: np.ndarray
    entry_ts: np.ndarray
    exit_ts: np.ndarray
    entry_px: np.ndarray
    exit_px: np.ndarray
    flag: np.ndarray
    gross: np.ndarray
    fund: np.ndarray
    net: np.ndarray
    miss: np.ndarray
    nsettle: np.ndarray
    cost: np.ndarray  # (sp_fill at entry + sp_fill at exit) / 2, in bps: the cost the model charges this trade
    ties: np.ndarray  # number of fills (0 to 2) whose two first prints shared a timestamp


def last_entry_j(ctx: FillContext, hold: int) -> int:
    """Last grid point whose exit decision and exit search (a fallback stamp before the end) fit."""
    room = hold + lock.EXIT_SEARCH_MINUTES
    return min(ctx.ng - 1, (ctx.n - 2 - room) // GRID_MIN)


def first_print_fill(
    ctx: FillContext, order_side: int, m: np.ndarray, search: int = lock.EXIT_SEARCH_MINUTES
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Fill of a taker order of side order_side (+1 buy, -1 sell) sent at the start of minute m.

    The first print of either side in minutes m .. m + search (an entry searches minute m only, an exit 16 minutes).
    Returns (found, minute, price, timestamp, sp_fill in bps, tie). A print of the other side is moved against the
    order by sp_fill = max(the month's proxy at m, x(t'), x(t' - 1 minute)) x sp_mult, where t' is the fill minute.
    When the two first prints share a timestamp the fill is the WORSE of the same-side price and the adjusted
    opposite-side price.
    """
    f = ctx.nxt_any[m]
    found = (f - m) <= search
    fc = np.where(found, f, m)
    tb, tsl = ctx.fb_ts[fc], ctx.fs_ts[fc]
    pb, ps = ctx.fb_px[fc], ctx.fs_px[fc]
    spf = np.maximum(np.maximum(ctx.sp_bps[m], ctx.xs[fc]), ctx.xs[np.maximum(fc - 1, 0)]) * ctx.sp_mult
    adj = spf / lock.BPS
    buy_ok, sell_ok = ~np.isnan(tb), ~np.isnan(tsl)
    tie = buy_ok & sell_ok & (tb == tsl)
    if order_side > 0:
        same_first = buy_ok & (~sell_ok | (tb < tsl))
        opp = ps * (1.0 + adj)
        px = np.where(same_first, pb, np.where(tie, np.maximum(pb, opp), opp))
    else:
        same_first = sell_ok & (~buy_ok | (tsl < tb))
        opp = pb * (1.0 - adj)
        px = np.where(same_first, ps, np.where(tie, np.minimum(ps, opp), opp))
    ts = np.fmin(tb, tsl)
    return found, fc, px, ts, spf, tie & found


def _first_hits(
    ctx: FillContext,
    side: int,
    hold: int,
    mg: np.ndarray,
    ent_px: np.ndarray,
    sig_h: np.ndarray,
    can: np.ndarray,
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """First column (0 = the minute t = g + 1 min) at which each early-exit rule fires, per row."""
    nrow = len(mg)
    first = {k: np.zeros(nrow, dtype=np.int64) for k in ("stop2_target2", "target1")}
    hit = {k: np.zeros(nrow, dtype=bool) for k in first}
    rows = np.flatnonzero(can)
    if len(rows) == 0 or hold < 2:
        return {k: (first[k], hit[k]) for k in first}
    cols = hold - 1
    view = sliding_window_view(ctx.logmid, cols)
    ent_log = np.log(ent_px[rows])
    for lo in range(0, len(rows), _PATH_CHUNK):
        sl = rows[lo : lo + _PATH_CHUNK]
        marks = view[mg[sl]]
        with np.errstate(invalid="ignore"):
            u = side * (marks - ent_log[lo : lo + len(sl), None])
            s = sig_h[sl][:, None]
            h2 = (u <= -lock.STOP_MULT * s) | (u >= lock.TARGET_MULT * s)
            h1 = u >= lock.TARGET1_MULT * s
        for name, h in (("stop2_target2", h2), ("target1", h1)):
            idx = h.argmax(axis=1)
            first[name][sl] = idx
            hit[name][sl] = h[np.arange(len(sl)), idx]
    return {k: (first[k], hit[k]) for k in first}


def _finish(
    ctx: FillContext,
    side: int,
    j: np.ndarray,
    e: np.ndarray,
    ent_px: np.ndarray,
    ent_ts: np.ndarray,
    status: np.ndarray,
    ent_sp: np.ndarray,
    ent_tie: np.ndarray,
) -> Outcomes:
    """Exit fills at decision minute e (the fill search, the fallback), funding and returns."""
    # A trade still open at an excluded scale break exits there by the fallback rule, flagged: when its exit is decided
    # at or after the break minute, or its found fill lies at or after it, or nothing is found and the search window
    # (e .. e + 15) reaches it. A fill on the later scale is never booked.
    decided_late = e >= ctx.break_min
    e = np.where(decided_late, ctx.break_min - 1, e)
    found, x_min, x_px, x_ts, x_sp, x_tie = first_print_fill(ctx, -side, e)
    forced = (
        decided_late | (found & (x_min >= ctx.break_min)) | (~found & (e + lock.EXIT_SEARCH_MINUTES >= ctx.break_min))
    )
    found = found & ~forced
    fallback_min = np.where(forced, ctx.break_min - 1, e + lock.EXIT_SEARCH_MINUTES)
    fb_sp = np.maximum(np.maximum(ctx.sp_bps[e], ctx.xs[fallback_min]), ctx.xs[np.maximum(fallback_min - 1, 0)])
    fb_sp = fb_sp * ctx.sp_mult
    half = 0.5 * fb_sp / lock.BPS
    # the exit of a long is a sell: the fallback mid is moved down, the exit of a short is a buy: moved up
    fb_px = ctx.mid[fallback_min] * (1.0 - side * half)
    exit_px = np.where(found, x_px, fb_px)
    stamp = ctx.t0_ms + (fallback_min + 1) * lock.MINUTE_MS  # the end of minute e + 15, or the break minute's start
    exit_ts_f = np.where(found, x_ts, stamp.astype(np.float64))
    ok = status == STATUS_OK
    bad_exit = ok & ~(np.isfinite(exit_px) & (exit_px > 0) & np.isfinite(exit_ts_f))
    status = np.where(bad_exit, STATUS_NO_EXIT, status)
    ok = status == STATUS_OK
    exit_ts = np.where(ok, np.nan_to_num(exit_ts_f), 0.0).astype(np.int64)
    entry_ts = np.where(ok, np.nan_to_num(ent_ts), 0.0).astype(np.int64)
    with np.errstate(invalid="ignore", divide="ignore"):
        gross = np.where(ok, side * (np.log(np.where(ok, exit_px, 1.0)) - np.log(np.where(ok, ent_px, 1.0))), np.nan)
    h_lo = entry_ts // lock.HOUR_MS + 1 - ctx.hour0
    h_hi = exit_ts // lock.HOUR_MS - ctx.hour0
    last = len(ctx.cum_rate) - 1
    lo_i = np.clip(h_lo, 0, last)
    hi_i = np.clip(h_hi + 1, 0, last)
    has_window = ok & (h_hi >= h_lo)
    rate_sum = np.where(has_window, ctx.cum_rate[hi_i] - ctx.cum_rate[lo_i], 0.0)
    miss = np.where(has_window, ctx.cum_miss[hi_i] - ctx.cum_miss[lo_i], 0)
    nsettle = np.where(has_window, h_hi - h_lo + 1, 0)
    fund = side * rate_sum
    net = np.where(ok, gross - fund, np.nan)
    return Outcomes(
        j0=int(j[0]),
        j1=int(j[-1]),
        status=status.astype(np.int8),
        entry_ts=entry_ts,
        exit_ts=exit_ts,
        entry_px=ent_px,
        exit_px=np.where(ok, exit_px, np.nan),
        flag=ok & ~found,
        gross=gross,
        fund=np.where(ok, fund, np.nan),
        net=net,
        miss=miss.astype(np.int64),
        nsettle=nsettle.astype(np.int64),
        cost=np.where(ok, (ent_sp + np.where(found, x_sp, fb_sp)) / 2.0, np.nan),
        ties=(ent_tie.astype(np.int64) + x_tie.astype(np.int64)),
    )


def outcomes(ctx: FillContext, side: int, hold: int, kinds: tuple[str, ...], j_lo: int) -> dict[str, Outcomes] | None:
    """Outcomes of entering at every grid point from j_lo, per exit rule. None when no grid point has room."""
    j_hi = last_entry_j(ctx, hold)
    if j_hi < j_lo:
        return None
    j = np.arange(j_lo, j_hi + 1, dtype=np.int64)
    mg = j * GRID_MIN
    filled, _, ent_px, ent_ts, ent_sp, ent_tie = first_print_fill(ctx, side, mg, search=0)
    filled = filled & np.isfinite(ent_px) & np.isfinite(ent_sp) & (mg < ctx.break_min)  # no entry from a break on
    sig_h = ctx.sigma[j] * np.sqrt(hold / GRID_MIN)
    has_sigma = np.isfinite(sig_h)
    hits: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    if any(k != "time" for k in kinds):
        hits = _first_hits(ctx, side, hold, mg, ent_px, sig_h, filled & has_sigma)
    out: dict[str, Outcomes] = {}
    for kind in kinds:
        status = np.where(filled, STATUS_OK, STATUS_UNFILLED).astype(np.int8)
        e = mg + hold
        if kind != "time":
            first, hit = hits[kind]
            status = np.where(filled & ~has_sigma, STATUS_NO_SIGMA, status).astype(np.int8)
            e = np.where(hit, mg + first + 1, e)
        out[kind] = _finish(ctx, side, j, e, ent_px, ent_ts, status, ent_sp, ent_tie)
    return out


@dataclass
class TradeBatch:
    """The trades one configuration takes in one market, in entry order, plus the candidates it could not trade."""

    j: np.ndarray
    side: np.ndarray
    entry_ts: np.ndarray
    exit_ts: np.ndarray
    entry_px: np.ndarray
    exit_px: np.ndarray
    gross: np.ndarray
    fund: np.ndarray
    net: np.ndarray
    flag: np.ndarray
    miss: np.ndarray
    nsettle: np.ndarray
    cost: np.ndarray
    ties: np.ndarray
    unfilled: int = 0
    no_sigma: int = 0
    no_exit: int = 0

    @property
    def n(self) -> int:
        return len(self.j)


def empty_batch() -> TradeBatch:
    z = np.zeros(0)
    zi = np.zeros(0, dtype=np.int64)
    return TradeBatch(zi, zi.astype(np.int8), zi, zi, z, z, z, z, z, np.zeros(0, dtype=bool), zi, zi, z, zi)


def select_trades(
    ctx: FillContext, sides: np.ndarray, out_long: Outcomes | None, out_short: Outcomes | None
) -> TradeBatch:
    """Walk the signal's entries in time order and take each one that is free (one position per market)."""
    if out_long is None or out_short is None:
        return empty_batch()
    j0, j1 = out_long.j0, out_long.j1
    cj = np.flatnonzero(sides)
    cj = cj[(cj >= j0) & (cj <= j1)]
    if len(cj) == 0:
        return empty_batch()
    s = sides[cj].astype(np.int64)
    loc = cj - j0
    is_long = s > 0

    def pick(name: str) -> np.ndarray:
        return np.where(is_long, getattr(out_long, name)[loc], getattr(out_short, name)[loc])

    status = pick("status")
    exit_ts = pick("exit_ts")
    g = ctx.t0_ms + cj * lock.GRID_MS
    ok_pos = np.flatnonzero(status == STATUS_OK)
    taken_pos = np.zeros(0, dtype=np.int64)
    if len(ok_pos):
        g_ok = g[ok_pos]
        nxt = np.searchsorted(g_ok, exit_ts[ok_pos], side="left")
        n_ok = len(ok_pos)
        if np.array_equal(nxt, np.arange(1, n_ok + 1)):
            chain = np.arange(n_ok)
        else:
            nl = nxt.tolist()
            taken: list[int] = []
            i = 0
            while i < n_ok:
                taken.append(i)
                i = nl[i]
            chain = np.array(taken, dtype=np.int64)
        taken_pos = ok_pos[chain]
    batch = TradeBatch(
        j=cj[taken_pos],
        side=s[taken_pos].astype(np.int8),
        entry_ts=pick("entry_ts")[taken_pos],
        exit_ts=exit_ts[taken_pos],
        entry_px=pick("entry_px")[taken_pos],
        exit_px=pick("exit_px")[taken_pos],
        gross=pick("gross")[taken_pos],
        fund=pick("fund")[taken_pos],
        net=pick("net")[taken_pos],
        flag=pick("flag")[taken_pos],
        miss=pick("miss")[taken_pos],
        nsettle=pick("nsettle")[taken_pos],
        cost=pick("cost")[taken_pos],
        ties=pick("ties")[taken_pos],
    )
    other = np.flatnonzero(status != STATUS_OK)
    if len(other):
        if len(taken_pos):
            g_taken = g[taken_pos]
            p = np.searchsorted(g_taken, g[other], side="right") - 1
            blocked = (p >= 0) & (exit_ts[taken_pos][np.maximum(p, 0)] > g[other])
        else:
            blocked = np.zeros(len(other), dtype=bool)
        free = status[other[~blocked]]
        batch.unfilled = int(np.count_nonzero(free == STATUS_UNFILLED))
        batch.no_sigma = int(np.count_nonzero(free == STATUS_NO_SIGMA))
        batch.no_exit = int(np.count_nonzero(free == STATUS_NO_EXIT))
    return batch
