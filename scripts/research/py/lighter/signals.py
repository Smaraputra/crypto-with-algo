"""Lighter stage 2: features and decision arrays (the side per 5-minute grid point) for the six families of lock.py.

Grid point j of a market is the decision time g_j = t0_ms + j x 300,000 ms. Everything at j uses minutes up to
minute 5j - 1 (the minute that starts at g_j - 60 s) and nothing later. Sides are int8: +1 long, -1 short, 0 none.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from lighter import lock
from lighter.data import Market, MinuteData

GRID_MIN = 5
KS = lock.KS_REVERSAL
_CHUNK = 2048


def mid_proxy(md: MinuteData) -> tuple[np.ndarray, np.ndarray]:
    """Mid proxy per minute (carried forward) and staleness in minutes (-1 where nothing has ever been seen)."""
    both = ~np.isnan(md.last_buy_px) & ~np.isnan(md.last_sell_px)
    raw = np.where(both, (md.last_buy_px + md.last_sell_px) / 2.0, md.last_px)
    real = ~np.isnan(raw)
    idx = np.where(real, np.arange(md.n), -1)
    last = np.maximum.accumulate(idx)
    seen = last >= 0
    mid = np.where(seen, raw[np.maximum(last, 0)], np.nan)
    stale = np.where(seen, np.arange(md.n) - last, -1).astype(np.int32)
    return mid, stale


def grid_prices(md: MinuteData, source: str) -> tuple[np.ndarray, np.ndarray]:
    """5m close at every grid point and its validity. Grid point j uses the five minutes 5j - 5 to 5j - 1."""
    ng = md.n // GRID_MIN
    if source == "binance":
        has = md.b_has[: ng * 5].reshape(ng, 5).all(axis=1)
        close = md.b_close[: ng * 5].reshape(ng, 5)[:, 4]
    else:
        mid, _ = mid_proxy(md)
        has = md.has_print[: ng * 5].reshape(ng, 5).any(axis=1)
        close = mid[: ng * 5].reshape(ng, 5)[:, 4]
    c5 = np.full(ng, np.nan)
    v5 = np.zeros(ng, dtype=bool)
    c5[1:] = close[:-1]
    v5[1:] = has[:-1]
    v5 &= np.isfinite(c5) & (c5 > 0)
    return c5, v5


def log_returns(c5: np.ndarray, v5: np.ndarray, k: int) -> np.ndarray:
    """r_k at every grid point: ln(close(j) / close(j - k)), NaN unless both closes are valid."""
    with np.errstate(invalid="ignore", divide="ignore"):
        logc = np.where(v5, np.log(np.where(v5, c5, 1.0)), np.nan)
    out = np.full(len(c5), np.nan)
    out[k:] = logc[k:] - logc[:-k]
    return out


def rolling_std(x: np.ndarray, window: int, min_valid: int) -> np.ndarray:
    """Sample sd (ddof 1) of the last `window` values ending at each point, NaN below min_valid valid values."""
    out = np.array(pd.Series(x).rolling(window, min_periods=min_valid).std(ddof=1).to_numpy(), dtype=np.float64)
    out[~(out > 0)] = np.nan
    return out


def trailing_quantiles(x: np.ndarray, qs: list[float], window: int, min_valid: int) -> list[np.ndarray]:
    """Quantiles (numpy linear) of the `window` values strictly before each point: x[j - window : j].

    NaN where fewer than min_valid of them are valid. NaN values are ignored.
    """
    n = len(x)
    out = [np.full(n, np.nan) for _ in qs]
    if n <= window:
        return out
    view = sliding_window_view(x, window)[: n - window]
    for lo in range(0, n - window, _CHUNK):
        hi = min(lo + _CHUNK, n - window)
        blk = np.sort(view[lo:hi], axis=1)
        cnt = (~np.isnan(blk)).sum(axis=1)
        ok = cnt >= min_valid
        rows = np.arange(hi - lo)
        top = np.maximum(cnt - 1, 0)
        for qi, q in enumerate(qs):
            pos = top * q
            lo_i = np.floor(pos).astype(np.int64)
            hi_i = np.minimum(lo_i + 1, top)
            gam = pos - lo_i
            a = blk[rows, lo_i]
            b = blk[rows, hi_i]
            diff = b - a
            val = np.where(gam >= 0.5, b - diff * (1.0 - gam), a + diff * gam)
            val[~ok] = np.nan
            out[qi][lo + window : hi + window] = val
    return out


def reversal_sides(z: np.ndarray, theta: float) -> np.ndarray:
    """-sign(z) where |z| >= theta (F1, F2)."""
    s = np.zeros(len(z), dtype=np.int8)
    with np.errstate(invalid="ignore"):
        s[z >= theta] = -1
        s[z <= -theta] = 1
    return s


def continuation_sides(z: np.ndarray, theta: float) -> np.ndarray:
    """+sign(z) where |z| >= theta (F3)."""
    return -reversal_sides(z, theta)


def flow_imbalance(md: MinuteData, inp: str, k: int) -> np.ndarray:
    """I = (B - S) / (B + S) over the last k 5m bars at every grid point (NaN when not computable)."""
    ng = md.n // GRID_MIN
    m = ng * GRID_MIN
    if inp == "binance":
        blk_ok = md.b_has[:m].reshape(ng, GRID_MIN).all(axis=1)
        b_min = np.nan_to_num(md.b_tbq[:m])
        s_min = np.nan_to_num(md.b_qv[:m]) - b_min
    elif inp == "small":
        blk_ok = np.ones(ng, dtype=bool)
        b_min, s_min = md.buy_small[:m], md.sell_small[:m]
    elif inp == "large":
        blk_ok = np.ones(ng, dtype=bool)
        b_min, s_min = md.buy_large[:m], md.sell_large[:m]
    else:
        raise ValueError(f"unknown flow input {inp!r}")
    b_blk = b_min.reshape(ng, GRID_MIN).sum(axis=1)
    s_blk = s_min.reshape(ng, GRID_MIN).sum(axis=1)
    out = np.full(ng, np.nan)
    if ng <= k:
        return out
    b_win = sliding_window_view(b_blk, k).sum(axis=1)[: ng - k]
    s_win = sliding_window_view(s_blk, k).sum(axis=1)[: ng - k]
    ok = sliding_window_view(blk_ok, k).all(axis=1)[: ng - k]
    tot = b_win + s_win
    ok &= tot > 0
    with np.errstate(invalid="ignore", divide="ignore"):
        val = (b_win - s_win) / tot
    out[k:] = np.where(ok, val, np.nan)
    return out


def flow_sides(imb: np.ndarray, q: float, direction: str) -> np.ndarray:
    return flow_sides_valid(imb, q, direction)[0]


def flow_sides_valid(imb: np.ndarray, q: float, direction: str) -> tuple[np.ndarray, np.ndarray]:
    """F4 sides, and the grid points where the rule could be evaluated (I and its reference are valid)."""
    lo_ref, hi_ref = trailing_quantiles(imb, [1.0 - q, q], lock.REF_BARS, lock.REF_MIN_VALID)
    with np.errstate(invalid="ignore"):
        upper = imb >= hi_ref
        lower = imb <= lo_ref
    both = upper & lower
    sign = 1 if direction == "follow" else -1
    s = np.zeros(len(imb), dtype=np.int8)
    s[upper & ~both] = sign
    s[lower & ~both] = -sign
    return s, ~np.isnan(imb) & ~np.isnan(hi_ref)


def gap_series(md: MinuteData) -> np.ndarray:
    """ln(L / P) per minute, NaN unless the minute has a trade print in its last 10 s and a Binance bar."""
    both = ~np.isnan(md.last_buy_px) & ~np.isnan(md.last_sell_px)
    lighter = np.where(both, (md.last_buy_px + md.last_sell_px) / 2.0, md.last_px)
    last_ts = np.fmax(md.last_buy_ts, md.last_sell_ts)
    minute_end = md.t0_ms + (np.arange(md.n) + 1) * lock.MINUTE_MS
    with np.errstate(invalid="ignore", divide="ignore"):
        ok = (
            md.b_has
            & (lighter > 0)
            & (md.b_close > 0)
            & (last_ts >= minute_end - lock.PRINT_WINDOW_MS)
            & (last_ts < minute_end - lock.PRINT_WINDOW_END_MS)
        )
        return np.where(ok, np.log(np.where(ok, lighter, 1.0) / np.where(ok, md.b_close, 1.0)), np.nan)


def gap_sides(md: MinuteData, theta_bps: float, variant: str, cache: dict | None = None) -> np.ndarray:
    ng = md.n // GRID_MIN
    if cache is not None and "gap" in cache:
        lp5, lp_prev, med = cache["gap"]
    else:
        lp = gap_series(md)[: ng * GRID_MIN].reshape(ng, GRID_MIN)
        lp5 = np.full(ng, np.nan)
        lp_prev = np.full(ng, np.nan)
        lp5[1:] = lp[:-1, 4]
        lp_prev[1:] = lp[:-1, 3]
        med = trailing_quantiles(lp5, [0.5], lock.REF_BARS, lock.GAP_REF_MIN_VALID)[0]
        if cache is not None:
            cache["gap"] = (lp5, lp_prev, med)
    dev1 = (lp5 - med) * lock.BPS
    dev2 = (lp_prev - med) * lock.BPS
    with np.errstate(invalid="ignore"):
        up = dev1 >= theta_bps
        dn = dev1 <= -theta_bps
        if variant == "persist":
            up &= dev2 >= theta_bps
            dn &= dev2 <= -theta_bps
    s = np.zeros(ng, dtype=np.int8)
    s[up] = -1
    s[dn] = 1
    return s


def funding_sides(t0_ms: int, ng: int, f_ts: np.ndarray, f_rate: np.ndarray, theta_bps: float) -> np.ndarray:
    """F6: at minute-of-hour 55, short when the rate stamped at minute 0 of the hour is >= theta bps (long when <=
    -theta).

    A missing row for that hour gives no signal.
    """
    g_ms = t0_ms + np.arange(ng, dtype=np.int64) * lock.GRID_MS
    s = np.zeros(ng, dtype=np.int8)
    if len(f_ts) == 0:
        return s
    hour_start = g_ms - g_ms % lock.HOUR_MS
    idx = np.minimum(np.searchsorted(f_ts, hour_start, side="left"), len(f_ts) - 1)
    present = f_ts[idx] == hour_start
    at55 = ((g_ms // lock.MINUTE_MS) % 60 == lock.F6_MINUTE_OF_HOUR) & present
    f = np.where(at55, f_rate[idx] * lock.BPS, np.nan)
    with np.errstate(invalid="ignore"):
        s[f >= theta_bps] = -1
        s[f <= -theta_bps] = 1
    return s


@dataclass
class MarketFeatures:
    market: Market
    source: str
    start_ms: int
    t0_ms: int
    ng: int
    start_j: int
    sigma: np.ndarray
    r: dict[int, np.ndarray]
    z: dict[int, np.ndarray]
    sides: dict[str, np.ndarray] = field(default_factory=dict)
    valid: dict[str, np.ndarray] = field(default_factory=dict)

    def live(self) -> np.ndarray:
        m = np.zeros(self.ng, dtype=bool)
        m[self.start_j :] = True
        return m


def compute_features(
    md: MinuteData,
    source: str,
    start_ms: int,
    funding: tuple[np.ndarray, np.ndarray],
    needed: set[str] | None = None,
) -> MarketFeatures:
    """Own-market features and the families that need no other market (F1, F4, F5, F6)."""
    ng = md.n // GRID_MIN
    start_j = (start_ms - md.t0_ms) // lock.GRID_MS
    c5, v5 = grid_prices(md, source)
    r = {k: log_returns(c5, v5, k) for k in KS}
    sigma = rolling_std(r[1], lock.SIGMA_BARS, lock.SIGMA_MIN_VALID)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = {k: r[k] / (sigma * np.sqrt(k)) for k in KS}
    feats = MarketFeatures(md.market, source, start_ms, md.t0_ms, ng, start_j, sigma, r, z)
    live = feats.live()

    def want(sig: lock.Signal) -> bool:
        return needed is None or sig.sig_id in needed

    for sig in lock.SIGNALS:
        if sig.family == "F1" and want(sig):
            feats.sides[sig.sig_id] = reversal_sides(z[sig.p("k")], sig.p("theta")) * live
    cache: dict = {}
    flow_cache: dict[tuple[str, int], np.ndarray] = {}
    for sig in lock.SIGNALS:
        if not want(sig):
            continue
        if sig.family == "F4":
            if sig.p("input") == "binance" and source != "binance":
                continue
            key = (sig.p("input"), sig.p("k"))
            if key not in flow_cache:
                flow_cache[key] = flow_imbalance(md, *key)
            sides, valid = flow_sides_valid(flow_cache[key], sig.p("q"), sig.p("direction"))
            feats.sides[sig.sig_id] = sides * live
            feats.valid[sig.sig_id] = valid & live
        elif sig.family == "F5":
            if source != "binance":
                continue
            feats.sides[sig.sig_id] = gap_sides(md, sig.p("theta"), sig.p("variant"), cache) * live
    for sig in lock.FUNDING_SIGNALS:
        if want(sig):
            feats.sides[sig.sig_id] = funding_sides(md.t0_ms, ng, funding[0], funding[1], sig.p("theta")) * live
    return feats


def grid_month_index(t0_ms: int, ng: int) -> np.ndarray:
    """Month (months since 1970-01, lock.month_index) of every grid point's decision time."""
    ts = (t0_ms + np.arange(ng, dtype=np.int64) * lock.GRID_MS).astype("datetime64[ms]")
    return ts.astype("datetime64[M]").astype(np.int64)


def compose_by_source(
    by_source: dict[str, MarketFeatures], binance_mask: np.ndarray
) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """Per grid point take the sides and sigma of the month's source: binance where binance_mask, else lighter."""
    lighter = by_source["lighter"]
    binance = by_source.get("binance")
    if binance is None:
        binance_mask = np.zeros(lighter.ng, dtype=bool)
    sides: dict[str, np.ndarray] = {}
    for sig_id in set(lighter.sides) | (set(binance.sides) if binance else set()):
        out = np.zeros(lighter.ng, dtype=np.int8)
        if binance is not None and sig_id in binance.sides:
            out[binance_mask] = binance.sides[sig_id][binance_mask]
        if sig_id in lighter.sides:
            out[~binance_mask] = lighter.sides[sig_id][~binance_mask]
        sides[sig_id] = out
    sigma = lighter.sigma.copy()
    if binance is not None:
        sigma[binance_mask] = binance.sigma[binance_mask]
    return sides, sigma


def compose_valid(by_source: dict[str, MarketFeatures], binance_mask: np.ndarray) -> dict[str, np.ndarray]:
    """The F4 evaluable-point arrays, composed the same way as the sides."""
    lighter = by_source["lighter"]
    binance = by_source.get("binance")
    if binance is None:
        binance_mask = np.zeros(lighter.ng, dtype=bool)
    out: dict[str, np.ndarray] = {}
    for sig_id in set(lighter.valid) | (set(binance.valid) if binance else set()):
        arr = np.zeros(lighter.ng, dtype=bool)
        if binance is not None and sig_id in binance.valid:
            arr[binance_mask] = binance.valid[sig_id][binance_mask]
        if sig_id in lighter.valid:
            arr[~binance_mask] = lighter.valid[sig_id][~binance_mask]
        out[sig_id] = arr
    return out


@dataclass(frozen=True)
class MonthSlice:
    """One calendar month of decisions: grid points lo..hi-1, and the markets eligible in it (id -> (tier, source))."""

    lo: int
    hi: int
    members: dict[int, tuple[str, str]]


def _in_universe(tier: str, universe: str) -> bool:
    return tier == "A" or (universe == "AB" and tier == "B")


def cross_sectional_sides(
    feats: dict[int, dict[str, MarketFeatures]], months: list[MonthSlice], ng: int, needed: set[str] | None = None
) -> dict[tuple[int, str, str], np.ndarray]:
    """F2 and F3 sides keyed by (market_id, universe, sig_id), arrays over the whole grid.

    Each month is computed on its own: the baskets and the F3 leader are the markets eligible in that month, in the
    universe, and every member's returns come from the source it has in that month. The window before the month
    (WARMUP_DAYS) is read from the same source.
    """
    out: dict[tuple[int, str, str], np.ndarray] = {}
    sigs = [s for s in lock.SIGNALS if s.family in ("F2", "F3") and (needed is None or s.sig_id in needed)]
    if not sigs:
        return out
    warm = lock.WARMUP_DAYS * lock.GRID_PER_DAY

    def put(mid: int, universe: str, sig_id: str, month: MonthSlice, a: int, sides: np.ndarray) -> None:
        arr = out.setdefault((mid, universe, sig_id), np.zeros(ng, dtype=np.int8))
        arr[month.lo : month.hi] = sides[month.lo - a : month.hi - a]

    for month in months:
        a = max(0, month.lo - warm)
        for universe in lock.UNIVERSES:
            members = [mid for mid, (tier, _) in sorted(month.members.items()) if _in_universe(tier, universe)]
            if not members:
                continue
            market_of = {mid: next(iter(feats[mid].values())).market for mid in members}
            cls_of = {mid: market_of[mid].cls for mid in members}
            if any(s.family == "F2" for s in sigs):
                for cls in ("crypto", "tradfi"):
                    grp = [mid for mid in members if cls_of[mid] == cls]
                    if len(grp) < lock.MIN_OTHERS + 1:
                        continue
                    res = {}
                    for k in KS:
                        rk = np.vstack([feats[mid][month.members[mid][1]].r[k][a : month.hi] for mid in grp])
                        valid = ~np.isnan(rk)
                        total = np.where(valid, rk, 0.0).sum(axis=0)
                        cnt = valid.sum(axis=0)
                        oc = cnt[None, :] - valid
                        with np.errstate(invalid="ignore", divide="ignore"):
                            om = (total[None, :] - np.where(valid, rk, 0.0)) / oc
                        res[k] = np.where(valid & (oc >= lock.MIN_OTHERS), rk - om, np.nan)
                    sd_res = np.vstack([rolling_std(row, lock.SIGMA_BARS, lock.SIGMA_MIN_VALID) for row in res[1]])
                    for sig in sigs:
                        if sig.family != "F2":
                            continue
                        k = sig.p("k")
                        with np.errstate(invalid="ignore", divide="ignore"):
                            zres = res[k] / (sd_res * np.sqrt(k))
                        sides = np.zeros(zres.shape, dtype=np.int8)
                        with np.errstate(invalid="ignore"):
                            sides[zres >= sig.p("theta")] = -1
                            sides[zres <= -sig.p("theta")] = 1
                        for row, mid in enumerate(grp):
                            put(mid, universe, sig.sig_id, month, a, sides[row])
            if any(s.family == "F3" for s in sigs):
                leaders = [mid for mid in members if market_of[mid].is_leader]
                if not leaders:
                    continue
                lead = leaders[0]
                lf = feats[lead][month.members[lead][1]]
                for sig in sigs:
                    if sig.family != "F3":
                        continue
                    k = sig.p("k")
                    with np.errstate(invalid="ignore", divide="ignore"):
                        z_lead = lf.r[k][a : month.hi] / (lf.sigma[a : month.hi] * np.sqrt(k))
                    side = continuation_sides(z_lead, sig.p("theta"))
                    for mid in members:
                        if mid != lead and cls_of[mid] == "crypto":
                            put(mid, universe, sig.sig_id, month, a, side)
    return out
