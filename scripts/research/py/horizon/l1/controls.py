"""Matched control selection, prefix sums of liquidation minutes, and pre-event returns."""

from __future__ import annotations

import math

import numpy as np

from horizon.l1 import lock
from horizon.l1.data import MarketData
from horizon.l1.events import eligible, spread_median
from horizon.l1.fills import order_fill

__all__ = ["find_controls", "liq_any_prefix", "r_pre_series"]


def r_pre_series(md: MarketData) -> np.ndarray:
    """Forward-fill last_px up to lock.CARRY_BACK_MIN minutes and compute 60m return r_pre."""
    px = md.last_px
    n = len(px)
    if n == 0:
        return np.array([], dtype=np.float64)

    ff = np.full(n, np.nan, dtype=np.float64)
    valid_mask = np.isfinite(px)
    if not np.any(valid_mask):
        return ff

    idx_arr = np.where(valid_mask, np.arange(n), -1)
    last_valid_idx = np.maximum.accumulate(idx_arr)
    age = np.arange(n) - last_valid_idx
    carry_mask = (last_valid_idx >= 0) & (age <= lock.CARRY_BACK_MIN)
    ff[carry_mask] = px[last_valid_idx[carry_mask]]

    r_pre = np.full(n, np.nan, dtype=np.float64)
    start_x = lock.RPRE_LOOKBACK_MIN + 1
    if start_x < n:
        num_idx = np.arange(start_x, n) - 1
        denom_idx = num_idx - lock.RPRE_LOOKBACK_MIN
        num = ff[num_idx]
        denom = ff[denom_idx]
        calc_mask = np.isfinite(num) & np.isfinite(denom) & (denom != 0.0)
        valid_x = np.arange(start_x, n)[calc_mask]
        r_pre[valid_x] = (num[calc_mask] / denom[calc_mask]) - 1.0

    return r_pre


def liq_any_prefix(md: MarketData) -> np.ndarray:
    """Prefix sums of minutes with any liquidation volume, length N_MIN + 1."""
    has_liq = (md.liq_sell_usd > 0.0) | (md.liq_buy_usd > 0.0)
    p = np.empty(len(has_liq) + 1, dtype=np.int64)
    p[0] = 0
    p[1:] = np.cumsum(has_liq.astype(np.int64))
    return p


MIN_PER_DAY = lock.DAY_MS // lock.MINUTE_MS


def find_controls(
    md: MarketData,
    xs: np.ndarray,
    xs_valid: np.ndarray,
    event_d_index: int,
    event_i0: int,
    liq_any_prefix: np.ndarray,
    r_pre: np.ndarray,
) -> list[int]:
    """Find up to lock.CONTROLS_PER_EVENT matched control grid indexes for an event.

    r_pre[event_d_index] must be finite else the event has no controls (return []).
    """
    if event_d_index < 0 or event_d_index >= len(r_pre):
        return []
    r_pre_event = float(r_pre[event_d_index])
    if not math.isfinite(r_pre_event):
        return []

    min_x = max(
        0,
        event_i0 - lock.CONTROL_LOOKBACK_DAYS * MIN_PER_DAY,
        lock.CONTROL_QUIET_BEFORE_MIN,
    )
    max_x = min(len(r_pre) - 1, event_i0 - lock.CONTROL_HOLD_MIN)
    if min_x > max_x:
        return []

    x_cands = np.arange(min_x, max_x + 1, dtype=np.int64)

    quiet_counts = liq_any_prefix[x_cands] - liq_any_prefix[x_cands - lock.CONTROL_QUIET_BEFORE_MIN]
    quiet_mask = quiet_counts == 0
    finite_mask = np.isfinite(r_pre[x_cands])

    cand_mask = quiet_mask & finite_mask
    valid_cands = x_cands[cand_mask]
    if len(valid_cands) == 0:
        return []

    diffs = np.abs(r_pre[valid_cands] - r_pre_event)
    sort_order = np.lexsort((valid_cands, diffs))
    ranked_cands = valid_cands[sort_order]

    accepted: list[int] = []
    for x_val in ranked_cands:
        x_int = int(x_val)

        if any(abs(x_int - c) < lock.CONTROL_SPACING_MIN for c in accepted):
            continue

        is_elig, _ = eligible(md, xs_valid, xs, x_int)
        if not is_elig:
            continue

        spm = spread_median(md, xs_valid, xs, x_int)
        if math.isnan(spm):
            continue

        entry_both_ok = True
        for side_val in (1, -1):
            f = order_fill(
                md=md,
                xs=xs,
                spm=spm,
                order_side=side_val,
                boundary_index=x_int,
                search_min=0,
                is_exit=False,
            )
            if not f.found:
                entry_both_ok = False
                break
        if not entry_both_ok:
            continue

        exits_both_ok = True
        for side_val in (1, -1):
            for h in lock.EXIT_OFFSETS_MIN:
                exit_boundary = x_int + h - lock.ENTRY_OFFSET_MIN
                f = order_fill(
                    md=md,
                    xs=xs,
                    spm=spm,
                    order_side=side_val,
                    boundary_index=exit_boundary,
                    search_min=lock.EXIT_SEARCH_MIN,
                    is_exit=True,
                    min_index=x_int,
                )
                if not f.found:
                    exits_both_ok = False
                    break
            if not exits_both_ok:
                break
        if not exits_both_ok:
            continue

        accepted.append(x_int)
        if len(accepted) == lock.CONTROLS_PER_EVENT:
            break

    return accepted
