"""Burst identification, retrigger event selection, spread proxy series and eligibility."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from horizon.l1 import lock
from horizon.l1.data import MarketData

__all__ = [
    "Burst",
    "eligible",
    "find_bursts",
    "find_candidates",
    "last_search_index",
    "select_events",
    "span_end_dropped",
    "spread_median",
    "x_series",
]


@dataclass(frozen=True)
class Burst:
    """A contiguous sequence of liquidation minutes within lock.BURST_GAP_MS."""

    market_id: int
    side: str  # "S" forced sells, "B" forced buys
    i0: int  # grid index of the first liquidation minute
    i1: int  # grid index of the last liquidation minute
    usd: float  # sum of the side's liquidation USD
    rows: int  # sum of the side's liquidation row counts

    @property
    def e_index(self) -> int:
        """Burst end grid index E = i1 + 1."""
        return self.i1 + 1

    @property
    def d_index(self) -> int:
        """Decision time grid index D = e_index + lock.ENTRY_OFFSET_MIN."""
        return self.e_index + lock.ENTRY_OFFSET_MIN

    @property
    def duration_min(self) -> int:
        """Burst duration in grid minutes i1 - i0 + 1."""
        return self.i1 - self.i0 + 1


def find_bursts(md: MarketData, side: str) -> list[Burst]:
    """Find all gap-merged liquidation bursts for side with no size filter."""
    if side == "S":
        usd_arr = md.liq_sell_usd
        rows_arr = md.n_liq_sell
    elif side == "B":
        usd_arr = md.liq_buy_usd
        rows_arr = md.n_liq_buy
    else:
        raise ValueError(f"side must be 'S' or 'B', got {side!r}")

    (liq_indices,) = np.where(usd_arr > 0.0)
    if len(liq_indices) == 0:
        return []

    max_gap = lock.BURST_GAP_MS // 60_000  # 5 minutes
    diffs = np.diff(liq_indices)
    split_indices = np.where(diffs > max_gap)[0]

    starts = np.r_[0, split_indices + 1]
    ends = np.r_[split_indices, len(liq_indices) - 1]

    bursts: list[Burst] = []
    for s_idx, e_idx in zip(starts, ends, strict=True):
        i0 = int(liq_indices[s_idx])
        i1 = int(liq_indices[e_idx])
        burst_usd = float(np.sum(usd_arr[i0 : i1 + 1]))
        burst_rows = int(np.sum(rows_arr[i0 : i1 + 1]))
        bursts.append(
            Burst(
                market_id=md.market_id,
                side=side,
                i0=i0,
                i1=i1,
                usd=burst_usd,
                rows=burst_rows,
            )
        )
    return bursts


def find_candidates(md: MarketData, side: str) -> list[Burst]:
    """Find candidate bursts where liquidation USD >= BURST_MIN_USD and rows >= BURST_MIN_ROWS."""
    bursts = find_bursts(md, side)
    return [b for b in bursts if b.usd >= lock.BURST_MIN_USD and b.rows >= lock.BURST_MIN_ROWS]


def last_search_index(d_index: int) -> int:
    """Return the last searched minute grid index for an event with decision time d_index."""
    return d_index + (lock.EXIT_OFFSETS_MIN[-1] - lock.ENTRY_OFFSET_MIN) + lock.EXIT_SEARCH_MIN


def span_end_dropped(d_index: int, n_records: int) -> bool:
    """True when the event's last exit search passes the readable grid span."""
    return last_search_index(d_index) >= n_records


def select_events(candidates: Sequence[Burst]) -> list[Burst]:
    """Filter candidates of one market and side by the retrigger rule."""
    events: list[Burst] = []
    for cand in candidates:
        blocked = False
        for ev in events:
            if (cand.i0 - ev.e_index) < lock.RETRIGGER_MIN:
                blocked = True
                break
        if not blocked:
            events.append(cand)
    return events


def x_series(md: MarketData) -> tuple[np.ndarray, np.ndarray]:
    """Compute x(m) in bps and the boolean mask of qualifying minutes where the pair rule holds."""
    n = len(md.present)
    xs = np.zeros(n, dtype=np.float64)
    valid_mask = (
        np.isfinite(md.last_buy_px)
        & np.isfinite(md.last_sell_px)
        & np.isfinite(md.last_buy_ts)
        & np.isfinite(md.last_sell_ts)
        & (np.abs(md.last_buy_ts - md.last_sell_ts) <= lock.PAIR_MAX_GAP_MS)
        & ((md.last_buy_px + md.last_sell_px) > 0.0)
    )
    if np.any(valid_mask):
        bp = md.last_buy_px[valid_mask]
        sp = md.last_sell_px[valid_mask]
        mid = (bp + sp) / 2.0
        val = ((bp - sp) / mid) * 10_000.0
        xs[valid_mask] = np.maximum(val, 0.0)
    return xs, valid_mask


def spread_median(md: MarketData, xs_valid: np.ndarray, xs: np.ndarray, i_d: int) -> float:
    """Compute the median spread proxy SPM over qualifying minutes in [i_d - 7 * 1440, i_d)."""
    start = max(0, i_d - lock.SP_WINDOW_DAYS * lock.ACTIVITY_WINDOW_MIN)
    end = min(len(xs), max(0, i_d))
    if start >= end:
        return float("nan")
    valid_window = xs_valid[start:end]
    if int(np.count_nonzero(valid_window)) < lock.SP_MIN_PAIRS:
        return float("nan")
    return float(np.median(xs[start:end][valid_window]))


def eligible(md: MarketData, xs_valid: np.ndarray, xs: np.ndarray, i_d: int) -> tuple[bool, str]:
    """Check decision time eligibility: activity in [i_d - 1440, i_d) and valid spread proxy."""
    start = i_d - lock.ACTIVITY_WINDOW_MIN
    if start < 0 or i_d > len(md.buy_usd):
        return False, "activity"
    active_window = (md.buy_usd[start:i_d] + md.sell_usd[start:i_d]) > 0.0
    if int(np.count_nonzero(active_window)) < lock.ACTIVITY_MIN_ACTIVE_MIN:
        return False, "activity"
    spm = spread_median(md, xs_valid, xs, i_d)
    if math.isnan(spm):
        return False, "no_spread_proxy"
    return True, "ok"
