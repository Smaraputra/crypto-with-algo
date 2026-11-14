"""Order execution model and round-trip trade simulation for horizon-l1."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from horizon.l1 import lock
from horizon.l1.data import MarketData

__all__ = ["Fill", "Trade", "order_fill", "simulate_trade"]


@dataclass(frozen=True)
class Fill:
    """Result of an order execution simulation."""

    found: bool
    index: int  # grid index of the fill minute, -1 when not found
    px: float  # NaN when not found
    ts: int  # fill timestamp in ms, -1 when not found
    sp: float  # the SP in bps that priced the fill (0.0 when own-side print was used)
    tie: bool
    fallback: bool  # True for an exit filled by the fallback


def order_fill(
    md: MarketData,
    xs: np.ndarray,
    spm: float,
    order_side: int,
    boundary_index: int,
    search_min: int,
    is_exit: bool,
    min_index: int = 0,
) -> Fill:
    """Simulate a taker order fill at or after boundary_index + 500 ms."""
    if math.isnan(spm):
        return Fill(found=False, index=-1, px=float("nan"), ts=-1, sp=float("nan"), tie=False, fallback=False)

    if order_side not in (1, -1):
        raise ValueError(f"order_side must be +1 (buy) or -1 (sell), got {order_side!r}")

    boundary_ms = md.ms_of(boundary_index)
    cutoff_ts = boundary_ms + lock.FILL_DELAY_MS
    max_m = boundary_index + search_min
    n_records = len(md.present)

    for m in range(boundary_index, max_m + 1):
        if m < 0 or m >= n_records:
            continue

        has_buy = (
            np.isfinite(md.first_buy_px[m]) and np.isfinite(md.first_buy_ts[m]) and (md.first_buy_ts[m] >= cutoff_ts)
        )
        has_sell = (
            np.isfinite(md.first_sell_px[m]) and np.isfinite(md.first_sell_ts[m]) and (md.first_sell_ts[m] >= cutoff_ts)
        )

        if not (has_buy or has_sell):
            continue

        sp_cands = [spm, float(xs[m])]
        if m >= 1:
            sp_cands.append(float(xs[m - 1]))
        sp = max(sp_cands)

        if order_side == 1:  # Buy
            has_own = has_buy
            own_px = float(md.first_buy_px[m]) if has_buy else float("nan")
            own_ts = int(md.first_buy_ts[m]) if has_buy else -1

            has_opp = has_sell
            opp_px = float(md.first_sell_px[m]) if has_sell else float("nan")
            opp_ts = int(md.first_sell_ts[m]) if has_sell else -1

            adj_opp_px = opp_px * (1.0 + sp / 10_000.0)
        else:  # Sell
            has_own = has_sell
            own_px = float(md.first_sell_px[m]) if has_sell else float("nan")
            own_ts = int(md.first_sell_ts[m]) if has_sell else -1

            has_opp = has_buy
            opp_px = float(md.first_buy_px[m]) if has_buy else float("nan")
            opp_ts = int(md.first_buy_ts[m]) if has_buy else -1

            adj_opp_px = opp_px * (1.0 - sp / 10_000.0)

        if has_own and has_opp:
            if own_ts < opp_ts:
                return Fill(found=True, index=m, px=own_px, ts=own_ts, sp=0.0, tie=False, fallback=False)
            if opp_ts < own_ts:
                return Fill(found=True, index=m, px=adj_opp_px, ts=opp_ts, sp=sp, tie=False, fallback=False)

            # Equal timestamps: tie
            if order_side == 1:
                if adj_opp_px > own_px:
                    fill_px = adj_opp_px
                    fill_sp = sp
                else:
                    fill_px = own_px
                    fill_sp = 0.0
            else:
                if adj_opp_px < own_px:
                    fill_px = adj_opp_px
                    fill_sp = sp
                else:
                    fill_px = own_px
                    fill_sp = 0.0
            return Fill(found=True, index=m, px=fill_px, ts=own_ts, sp=fill_sp, tie=True, fallback=False)

        if has_own:
            return Fill(found=True, index=m, px=own_px, ts=own_ts, sp=0.0, tie=False, fallback=False)

        # has_opp only
        return Fill(found=True, index=m, px=adj_opp_px, ts=opp_ts, sp=sp, tie=False, fallback=False)

    if not is_exit:
        return Fill(found=False, index=-1, px=float("nan"), ts=-1, sp=float("nan"), tie=False, fallback=False)

    # Exit fallback
    fallback_max = boundary_index + lock.EXIT_SEARCH_MIN
    fallback_min = max(0, min_index)
    start_search = min(fallback_max, n_records - 1)

    for m in range(start_search, fallback_min - 1, -1):
        px_val = md.last_px[m]
        if np.isfinite(px_val):
            sp_cands = [spm, float(xs[m])]
            if m >= 1:
                sp_cands.append(float(xs[m - 1]))
            sp = max(sp_cands)
            fallback_sp = sp / 2.0
            if order_side == 1:
                fill_px = float(px_val * (1.0 + fallback_sp / 10_000.0))
            else:
                fill_px = float(px_val * (1.0 - fallback_sp / 10_000.0))
            fill_ts = int(md.ms_of(m) + 60_000)
            return Fill(found=True, index=m, px=fill_px, ts=fill_ts, sp=fallback_sp, tie=False, fallback=True)

    return Fill(found=False, index=-1, px=float("nan"), ts=-1, sp=float("nan"), tie=False, fallback=False)


@dataclass(frozen=True)
class Trade:
    """Simulation record of one round-trip trade."""

    status: str  # "ok", "no_entry_fill", or "no_exit"
    side: str  # "S" (long trade) or "B" (short trade)
    entry: Fill
    exit: Fill
    raw_return: float  # before funding
    funding: float  # funding cashflow as a fraction of notional (costs negative)
    ret: float  # raw_return + funding
    funding_gap: bool
    adverse: float  # largest adverse move, a fraction >= 0
    latency_entry_ms: int
    latency_exit_ms: int


def simulate_trade(
    md: MarketData,
    xs: np.ndarray,
    spm: float,
    funding_ts: np.ndarray,
    funding_rate: np.ndarray,
    side: str,
    entry_index: int,
    exit_index: int,
) -> Trade:
    """Simulate a trade opened at entry_index and closed at exit_index."""
    if side == "S":
        entry_side = 1
        exit_side = -1
    elif side == "B":
        entry_side = -1
        exit_side = 1
    else:
        raise ValueError(f"side must be 'S' or 'B', got {side!r}")

    nan = float("nan")
    empty_fill = Fill(found=False, index=-1, px=nan, ts=-1, sp=nan, tie=False, fallback=False)

    entry = order_fill(
        md=md,
        xs=xs,
        spm=spm,
        order_side=entry_side,
        boundary_index=entry_index,
        search_min=0,
        is_exit=False,
    )
    if not entry.found:
        return Trade(
            status="no_entry_fill",
            side=side,
            entry=entry,
            exit=empty_fill,
            raw_return=nan,
            funding=nan,
            ret=nan,
            funding_gap=False,
            adverse=nan,
            latency_entry_ms=-1,
            latency_exit_ms=-1,
        )

    latency_entry_ms = int(entry.ts - md.ms_of(entry_index))

    exit = order_fill(
        md=md,
        xs=xs,
        spm=spm,
        order_side=exit_side,
        boundary_index=exit_index,
        search_min=lock.EXIT_SEARCH_MIN,
        is_exit=True,
        min_index=entry.index,
    )
    if not exit.found:
        return Trade(
            status="no_exit",
            side=side,
            entry=entry,
            exit=exit,
            raw_return=nan,
            funding=nan,
            ret=nan,
            funding_gap=False,
            adverse=nan,
            latency_entry_ms=latency_entry_ms,
            latency_exit_ms=-1,
        )

    latency_exit_ms = int(exit.ts - md.ms_of(exit_index))

    if side == "S":
        raw_return = float(exit.px / entry.px - 1.0)
    else:
        raw_return = float(1.0 - exit.px / entry.px)

    s_entry = entry.ts / 1000.0
    s_exit = exit.ts / 1000.0

    k_min = math.floor(s_entry / 3600.0) + 1
    k_max = math.floor(s_exit / 3600.0)
    expected_hours = max(0, int(k_max - k_min + 1))

    if len(funding_ts) > 0:
        f_ts_float = funding_ts.astype(np.float64)
        mask = (f_ts_float > s_entry) & (f_ts_float <= s_exit)
        n_stamps = int(np.count_nonzero(mask))
        rate_sum = float(np.sum(funding_rate[mask])) if n_stamps > 0 else 0.0
    else:
        n_stamps = 0
        rate_sum = 0.0

    funding_gap = n_stamps < expected_hours

    if side == "S":
        funding = -rate_sum
    else:
        funding = rate_sum

    ret = raw_return + funding

    m0 = min(entry.index, exit.index)
    m1 = max(entry.index, exit.index)
    window_px = md.last_px[m0 : m1 + 1]
    valid_px = window_px[np.isfinite(window_px)]

    if len(valid_px) > 0:
        if side == "S":
            moves = np.maximum(0.0, -(valid_px / entry.px - 1.0))
        else:
            moves = np.maximum(0.0, valid_px / entry.px - 1.0)
        adverse = float(np.max(moves))
    else:
        adverse = 0.0

    return Trade(
        status="ok",
        side=side,
        entry=entry,
        exit=exit,
        raw_return=raw_return,
        funding=funding,
        ret=ret,
        funding_gap=funding_gap,
        adverse=adverse,
        latency_entry_ms=latency_entry_ms,
        latency_exit_ms=latency_exit_ms,
    )
