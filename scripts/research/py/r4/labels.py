"""Fixed-horizon and triple-barrier labelers at the research lab execution timing."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import numpy as np
import pandas as pd

from r4.costs import DEFAULT_FEE_PROFILE, FeeProfile, trade_funding, trade_net_return

__all__ = [
    "average_uniqueness",
    "fixed_horizon",
    "trailing_sigma_h",
    "triple_barrier",
]


def _parse_side(side: Any) -> int:
    """Normalize side argument to +1 (long) or -1 (short)."""
    if isinstance(side, str):
        s_clean = side.strip().lower()
        if s_clean in ("long", "+1", "1"):
            return 1
        if s_clean in ("short", "-1"):
            return -1
        raise ValueError(f"side must be +1, -1, 'long', or 'short', got: {side!r}")
    if isinstance(side, (int, np.integer)):
        if side in (1, -1):
            return int(side)
        raise ValueError(f"side must be +1 or -1, got: {side}")
    if isinstance(side, (float, np.floating)):
        if side == 1.0:
            return 1
        if side == -1.0:
            return -1
        raise ValueError(f"side must be +1 or -1, got: {side}")
    raise ValueError(f"side must be +1, -1, 'long', or 'short', got: {side!r}")


def fixed_horizon(
    decision_times: Sequence[int] | np.ndarray | pd.Series | pd.Index,
    five_min: pd.DataFrame,
    h_ms: int,
    side: int | str | Sequence[int | str] | np.ndarray | pd.Series,
    interval: str,
    settlements: pd.DataFrame | None = None,
    delay_ms: int = 600000,
    profile: str | FeeProfile = DEFAULT_FEE_PROFILE,
    symbol: str | None = None,
) -> pd.DataFrame:
    """Fixed-horizon net labels at the research lab execution timing.

    Enters at the open of the 5m bar at T + delay_ms (default 10m).
    Exits at the open of the 5m bar at T + delay_ms + h_ms.
    Charges trading costs and funding via r4.costs with taker fills both ways.
    """
    dt_arr = np.asarray(decision_times, dtype=np.int64)
    n = len(dt_arr)

    cols = ["t0", "t1", "entry", "exit", "gross", "funding", "net"]
    idx_name = decision_times.name if isinstance(decision_times, (pd.Index, pd.Series)) else "t"
    if n == 0:
        return pd.DataFrame(columns=cols, index=pd.Index([], dtype=np.int64, name=idx_name))

    if np.isscalar(side) or isinstance(side, str):
        side_val = _parse_side(side)
        side_arr = np.full(n, side_val, dtype=np.int64)
    else:
        side_seq = list(side)  # type: ignore[arg-type]
        if len(side_seq) != n:
            raise ValueError(f"side length {len(side_seq)} does not match decision_times length {n}")
        side_arr = np.array([_parse_side(s) for s in side_seq], dtype=np.int64)

    bars = five_min.set_index("t") if "t" in five_min.columns else five_min
    if bars.index.has_duplicates:
        bars = bars[~bars.index.duplicated(keep="last")]

    open_series = bars["o"]

    entry_times = dt_arr + delay_ms
    exit_times = dt_arr + delay_ms + h_ms

    entry_reindexed = open_series.reindex(entry_times).to_numpy(dtype=np.float64)
    exit_reindexed = open_series.reindex(exit_times).to_numpy(dtype=np.float64)

    valid_mask = ~np.isnan(entry_reindexed) & ~np.isnan(exit_reindexed)

    gross_arr = np.full(n, np.nan, dtype=np.float64)
    funding_arr = np.full(n, np.nan, dtype=np.float64)
    net_arr = np.full(n, np.nan, dtype=np.float64)

    has_settlements = settlements is not None and not settlements.empty
    if has_settlements:
        s_times = settlements["t"].to_numpy(dtype=np.int64)  # type: ignore[index]
        s_rates = settlements["rate"].to_numpy(dtype=np.float64)  # type: ignore[index]

    for i in np.where(valid_mask)[0]:
        s = int(side_arr[i])
        e_price = float(entry_reindexed[i])
        x_price = float(exit_reindexed[i])
        e_time = int(entry_times[i])
        x_time = int(exit_times[i])

        fund = trade_funding(s_times, s_rates, e_time, x_time) if has_settlements else 0.0
        funding_arr[i] = fund

        gross = s * (x_price / e_price - 1.0)
        gross_arr[i] = gross

        net_arr[i] = trade_net_return(
            side=s,
            entry_price=e_price,
            exit_price=x_price,
            funding_sum=fund,
            interval=interval,
            entry_fill="taker",
            exit_fill="taker",
            profile=profile,
            symbol=symbol,
        )

    t0_arr = dt_arr
    t1_arr = exit_times

    return pd.DataFrame(
        {
            "t0": t0_arr,
            "t1": t1_arr,
            "entry": entry_reindexed,
            "exit": exit_reindexed,
            "gross": gross_arr,
            "funding": funding_arr,
            "net": net_arr,
        },
        index=pd.Index(dt_arr, name=idx_name),
    )


def trailing_sigma_h(
    decision_times: Sequence[int] | np.ndarray | pd.Series | pd.Index,
    five_min: pd.DataFrame,
    h_ms: int,
    trailing_ms: int = 86400000,
) -> pd.Series:
    """Trailing realized barrier width sigma_h from closed 5m bars.

    Computes sqrt(sum(r_5m**2) * h_ms / trailing_ms) over 5m bars closed in
    (T - trailing_ms, T]. Log returns are close-to-close between consecutive 5m bars
    in the window, with the first bar using its own open.
    Returns NaN for any decision time if any 5m bar in the window is missing.
    Uses only bars with t + 300000 <= T.
    """
    if trailing_ms <= 0 or trailing_ms % 300000 != 0:
        raise ValueError(f"trailing_ms must be a positive multiple of 300000 ms (5m), got {trailing_ms}")
    if h_ms <= 0:
        raise ValueError(f"h_ms must be positive, got {h_ms}")

    dt_arr = np.asarray(decision_times, dtype=np.int64)
    n = len(dt_arr)
    idx_name = decision_times.name if isinstance(decision_times, (pd.Index, pd.Series)) else "t"

    if n == 0:
        return pd.Series(dtype=np.float64, index=pd.Index([], dtype=np.int64, name=idx_name), name="sigma_h")

    bars = five_min.set_index("t") if "t" in five_min.columns else five_min
    if bars.index.has_duplicates:
        bars = bars[~bars.index.duplicated(keep="last")]

    bar_ts = bars.index.to_numpy(dtype=np.int64)
    bar_o = bars["o"].to_numpy(dtype=np.float64) if "o" in bars.columns else np.empty(0, dtype=np.float64)
    bar_c = bars["c"].to_numpy(dtype=np.float64) if "c" in bars.columns else np.empty(0, dtype=np.float64)

    bar_map: dict[int, tuple[float, float]] = {
        int(t): (float(o), float(c)) for t, o, c in zip(bar_ts, bar_o, bar_c, strict=True)
    }

    result_arr = np.full(n, np.nan, dtype=np.float64)
    step = 300000
    m = trailing_ms // step
    scale = h_ms / trailing_ms

    for i in range(n):
        t_decision = int(dt_arr[i])
        t_start = t_decision - trailing_ms

        first_bar = bar_map.get(t_start)
        if first_bar is None:
            continue
        o0, prev_c = first_bar
        if not (o0 > 0.0 and prev_c > 0.0):
            continue

        r0 = math.log(prev_c / o0)
        sum_sq = r0 * r0

        curr_t = t_start + step
        missing = False
        for _ in range(1, m):
            bar = bar_map.get(curr_t)
            if bar is None:
                missing = True
                break
            _, curr_c = bar
            if not (curr_c > 0.0):
                missing = True
                break
            r = math.log(curr_c / prev_c)
            sum_sq += r * r
            prev_c = curr_c
            curr_t += step

        if not missing:
            result_arr[i] = math.sqrt(sum_sq * scale)

    return pd.Series(
        result_arr,
        index=pd.Index(dt_arr, name=idx_name),
        name="sigma_h",
    )


def triple_barrier(
    decision_times: Sequence[int] | np.ndarray | pd.Series | pd.Index,
    five_min: pd.DataFrame,
    h_ms: int,
    sigma_h: float | Sequence[float] | np.ndarray | pd.Series | None = None,
    k_up: float = 1.0,
    k_down: float = 1.0,
    side: int | str | Sequence[int | str] | np.ndarray | pd.Series = 1,
    interval: str = "1h",
    settlements: pd.DataFrame | None = None,
    delay_ms: int = 600000,
    profile: str | FeeProfile = DEFAULT_FEE_PROFILE,
    symbol: str | None = None,
    maker_as_taker: bool = False,
) -> pd.DataFrame:
    """Triple-barrier labeler at the research lab execution timing.

    Walks 5m bars in [T + delay_ms, T + delay_ms + h_ms).
    Upper barrier: entry * exp(k_up * sigma_h).
    Lower barrier: entry * exp(-k_down * sigma_h).
    Take-profit fires when high is strictly above upper barrier (long) or low is
    strictly below lower barrier (short). Fills as maker at the barrier price
    (or taker when maker_as_taker=True).
    Stop fires when low is at or below lower barrier (long) or high is at or above
    upper barrier (short). Fills as taker at min(lower, bar open) for long and
    max(upper, bar open) for short.
    Both touched in one bar books stop with gap-aware fill price and ambiguous=True.
    No barrier touched exits at horizon open as taker.
    Missing 5m bar anywhere in the execution window produces a NaN row.
    When sigma_h is None, computes trailing_sigma_h with trailing_ms=86400000.
    """
    if h_ms <= 0 or h_ms % 300000 != 0:
        raise ValueError(f"h_ms must be a positive multiple of 300000 ms (5m), got {h_ms}")
    if k_up <= 0 or k_down <= 0:
        raise ValueError(f"k_up and k_down must be positive, got k_up={k_up}, k_down={k_down}")
    if delay_ms < 0 or delay_ms % 300000 != 0:
        raise ValueError(f"delay_ms must be a non-negative multiple of 300000 ms (5m), got {delay_ms}")

    dt_arr = np.asarray(decision_times, dtype=np.int64)
    n = len(dt_arr)

    cols = ["t0", "t1_touch", "t1_max", "label", "entry", "exit", "gross", "funding", "net", "ambiguous"]
    idx_name = decision_times.name if isinstance(decision_times, (pd.Index, pd.Series)) else "t"
    if n == 0:
        return pd.DataFrame(columns=cols, index=pd.Index([], dtype=np.int64, name=idx_name))

    # Resolve sigma_h
    if sigma_h is None:
        sigma_series = trailing_sigma_h(dt_arr, five_min, h_ms=h_ms, trailing_ms=86400000)
        sigma_arr = sigma_series.to_numpy(dtype=np.float64)
    elif np.isscalar(sigma_h):
        sigma_arr = np.full(n, float(sigma_h), dtype=np.float64)  # type: ignore[arg-type]
    else:
        sigma_seq = list(sigma_h)  # type: ignore[arg-type]
        if len(sigma_seq) != n:
            raise ValueError(f"sigma_h length {len(sigma_seq)} does not match decision_times length {n}")
        sigma_arr = np.asarray(sigma_seq, dtype=np.float64)

    # Resolve side
    if np.isscalar(side) or isinstance(side, str):
        side_val = _parse_side(side)
        side_arr = np.full(n, side_val, dtype=np.int64)
    else:
        side_seq = list(side)  # type: ignore[arg-type]
        if len(side_seq) != n:
            raise ValueError(f"side length {len(side_seq)} does not match decision_times length {n}")
        side_arr = np.array([_parse_side(s) for s in side_seq], dtype=np.int64)

    bars = five_min.set_index("t") if "t" in five_min.columns else five_min
    if bars.index.has_duplicates:
        bars = bars[~bars.index.duplicated(keep="last")]

    bar_ts = bars.index.to_numpy(dtype=np.int64)
    bar_o = bars["o"].to_numpy(dtype=np.float64)
    bar_h = bars["h"].to_numpy(dtype=np.float64)
    bar_l = bars["l"].to_numpy(dtype=np.float64)
    bar_c = bars["c"].to_numpy(dtype=np.float64)

    bar_map: dict[int, tuple[float, float, float, float]] = {
        int(t): (float(o), float(h), float(lo), float(c))
        for t, o, h, lo, c in zip(bar_ts, bar_o, bar_h, bar_l, bar_c, strict=True)
    }

    t0_arr = dt_arr
    t1_max_arr = dt_arr + delay_ms + h_ms

    t1_touch_arr = np.full(n, np.nan, dtype=np.float64)
    label_arr = np.full(n, np.nan, dtype=np.float64)
    entry_arr = np.full(n, np.nan, dtype=np.float64)
    exit_arr = np.full(n, np.nan, dtype=np.float64)
    gross_arr = np.full(n, np.nan, dtype=np.float64)
    funding_arr = np.full(n, np.nan, dtype=np.float64)
    net_arr = np.full(n, np.nan, dtype=np.float64)
    ambiguous_arr = np.zeros(n, dtype=bool)

    has_settlements = settlements is not None and not settlements.empty
    if has_settlements:
        s_times = settlements["t"].to_numpy(dtype=np.int64)  # type: ignore[index]
        s_rates = settlements["rate"].to_numpy(dtype=np.float64)  # type: ignore[index]

    for i in range(n):
        t_decision = int(dt_arr[i])
        t_entry = t_decision + delay_ms
        t_horizon = t_decision + delay_ms + h_ms

        sig = float(sigma_arr[i])
        if np.isnan(sig) or sig <= 0.0:
            continue

        s = int(side_arr[i])

        window_times = range(t_entry, t_horizon, 300000)

        missing_bar = False
        for t_bar in window_times:
            if t_bar not in bar_map:
                missing_bar = True
                break
        if missing_bar:
            continue

        entry_bar = bar_map[t_entry]
        entry_price = entry_bar[0]

        upper_price = entry_price * math.exp(k_up * sig)
        lower_price = entry_price * math.exp(-k_down * sig)

        hit = False
        deciding_bar_t = 0
        exit_fill = "taker"
        exit_price = 0.0
        row_label = 0.0
        is_ambiguous = False

        for t_bar in window_times:
            o_val, h_val, l_val, _ = bar_map[t_bar]

            if s == 1:
                tp_fired = h_val > upper_price
                sl_fired = l_val <= lower_price
                sl_exit_price = min(lower_price, o_val)
                tp_exit_price = upper_price
            else:
                tp_fired = l_val < lower_price
                sl_fired = h_val >= upper_price
                sl_exit_price = max(upper_price, o_val)
                tp_exit_price = lower_price

            if tp_fired and sl_fired:
                hit = True
                deciding_bar_t = t_bar
                is_ambiguous = True
                row_label = -1.0
                exit_fill = "taker"
                exit_price = sl_exit_price
                break
            if tp_fired:
                hit = True
                deciding_bar_t = t_bar
                is_ambiguous = False
                row_label = 1.0
                exit_fill = "taker" if maker_as_taker else "maker"
                exit_price = tp_exit_price
                break
            if sl_fired:
                hit = True
                deciding_bar_t = t_bar
                is_ambiguous = False
                row_label = -1.0
                exit_fill = "taker"
                exit_price = sl_exit_price
                break

        if hit:
            t_touch = deciding_bar_t + 300000
        else:
            if t_horizon not in bar_map:
                continue
            horizon_bar = bar_map[t_horizon]
            exit_price = horizon_bar[0]
            exit_fill = "taker"
            row_label = 0.0
            is_ambiguous = False
            t_touch = t_horizon

        t1_touch_arr[i] = t_touch
        label_arr[i] = row_label
        entry_arr[i] = entry_price
        exit_arr[i] = exit_price
        ambiguous_arr[i] = is_ambiguous

        fund = trade_funding(s_times, s_rates, t_entry, t_touch) if has_settlements else 0.0
        funding_arr[i] = fund

        gross = s * (exit_price / entry_price - 1.0)
        gross_arr[i] = gross

        net_arr[i] = trade_net_return(
            side=s,
            entry_price=entry_price,
            exit_price=exit_price,
            funding_sum=fund,
            interval=interval,
            entry_fill="taker",
            exit_fill=exit_fill,
            profile=profile,
            symbol=symbol,
        )

    # Cast t1_touch to int64 if no NaNs are present
    t1_touch_col: np.ndarray = t1_touch_arr.astype(np.int64) if not np.isnan(t1_touch_arr).any() else t1_touch_arr

    return pd.DataFrame(
        {
            "t0": t0_arr,
            "t1_touch": t1_touch_col,
            "t1_max": t1_max_arr,
            "label": label_arr,
            "entry": entry_arr,
            "exit": exit_arr,
            "gross": gross_arr,
            "funding": funding_arr,
            "net": net_arr,
            "ambiguous": ambiguous_arr,
        },
        index=pd.Index(dt_arr, name=idx_name),
    )


def average_uniqueness(
    t0: Sequence[int] | np.ndarray | pd.Series,
    t1: Sequence[int] | np.ndarray | pd.Series,
    grid_ms: int,
) -> np.ndarray:
    """Compute average uniqueness on a grid of step grid_ms (López de Prado AFML Ch 4).

    The concurrency at each grid point is the number of labels whose [t0, t1) contains it.
    A label's uniqueness is the mean of 1 / concurrency over its grid points.
    Returns an array aligned with the labels.
    """
    if grid_ms <= 0:
        raise ValueError(f"grid_ms must be positive, got {grid_ms}")

    t0_arr = np.asarray(t0, dtype=np.int64)
    t1_arr = np.asarray(t1, dtype=np.int64)

    if t0_arr.ndim != 1 or t1_arr.ndim != 1:
        raise ValueError("t0 and t1 must be 1-dimensional arrays")
    if len(t0_arr) != len(t1_arr):
        raise ValueError(f"t0 and t1 must have the same length, got {len(t0_arr)} and {len(t1_arr)}")
    if np.any(t1_arr < t0_arr):
        raise ValueError("t1 must be >= t0 for all samples")

    n = len(t0_arr)
    if n == 0:
        return np.empty(0, dtype=np.float64)

    # Grid indices covering [t0, t1)
    # k * grid_ms in [t0, t1) <=> ceil(t0 / grid_ms) <= k < ceil(t1 / grid_ms)
    k_start = (t0_arr + grid_ms - 1) // grid_ms
    k_end = (t1_arr + grid_ms - 1) // grid_ms
    lengths = k_end - k_start

    active_mask = lengths > 0
    if not np.any(active_mask):
        return np.ones(n, dtype=np.float64)

    min_k = int(np.min(k_start[active_mask]))
    max_k = int(np.max(k_end[active_mask]))
    span = max_k - min_k

    if span > 5_000_000:
        # Sparse fallback for huge spans
        counts: dict[int, int] = {}
        for i in np.where(active_mask)[0]:
            for k in range(int(k_start[i]), int(k_end[i])):
                counts[k] = counts.get(k, 0) + 1
        uniqueness = np.ones(n, dtype=np.float64)
        for i in np.where(active_mask)[0]:
            tot = sum(1.0 / counts[k] for k in range(int(k_start[i]), int(k_end[i])))
            uniqueness[i] = tot / float(lengths[i])
        return uniqueness

    # Dense difference array
    diff = np.zeros(span + 1, dtype=np.int64)
    np.add.at(diff, k_start[active_mask] - min_k, 1)
    np.add.at(diff, k_end[active_mask] - min_k, -1)

    concurrency = np.cumsum(diff[:-1])

    inv_c = np.zeros(span, dtype=np.float64)
    nonzero = concurrency > 0
    inv_c[nonzero] = 1.0 / concurrency[nonzero]

    prefix_inv = np.zeros(span + 1, dtype=np.float64)
    np.cumsum(inv_c, out=prefix_inv[1:])

    uniqueness = np.ones(n, dtype=np.float64)
    for i in np.where(active_mask)[0]:
        s_idx = int(k_start[i] - min_k)
        e_idx = int(k_end[i] - min_k)
        total_inv = prefix_inv[e_idx] - prefix_inv[s_idx]
        uniqueness[i] = total_inv / float(lengths[i])

    return uniqueness
