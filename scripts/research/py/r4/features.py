"""Causal alignment and intrabar 5m and 15m feature extraction for Round 4."""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np
import pandas as pd

FEATURE_COLUMNS = [
    "rv5",
    "bpv5",
    "jump_share",
    "close_loc",
    "runup",
    "drawdown",
    "taker_imb",
    "taker_imb_last15",
    "sign_changes",
    "rv_late_early",
    "rsi7_15m",
    "ret_15m_last",
    "ret_15m_4",
]

# Fixed trailing window size of closed 15m bars for Wilder RSI calculation.
RSI_WINDOW = 64


def closed_rows(frame: pd.DataFrame, interval_ms: int, T: int) -> pd.DataFrame:
    """Return the rows of frame with t + interval_ms <= T."""
    return frame[frame["t"] + interval_ms <= T]


def bars_inside(frame: pd.DataFrame, interval_ms: int, t_b: int, T: int) -> pd.DataFrame | None:
    """Return the rows with t_b <= t and t + interval_ms <= T.

    Returns None if the count differs from (T - t_b) / interval_ms.
    """
    if interval_ms <= 0 or (T - t_b) % interval_ms != 0:
        return None
    expected_count = (T - t_b) // interval_ms
    if expected_count <= 0:
        return None
    sub = frame[(frame["t"] >= t_b) & (frame["t"] + interval_ms <= T)]
    if len(sub) != expected_count:
        return None
    return sub.sort_values("t")


def _bars_inside_slice(
    t_arr: np.ndarray,
    interval_ms: int,
    t_b: int,
    T: int,
) -> tuple[int, int] | None:
    """Locate row index slice for bars with t_b <= t and t + interval_ms <= T in sorted t_arr.

    Returns (start, end) index slice or None if count differs from expected.
    """
    if interval_ms <= 0 or (T - t_b) % interval_ms != 0:
        return None
    expected_count = (T - t_b) // interval_ms
    if expected_count <= 0:
        return None
    start = int(np.searchsorted(t_arr, t_b, side="left"))
    end = int(np.searchsorted(t_arr, T - interval_ms, side="right"))
    if (end - start) != expected_count:
        return None
    return start, end


def wilder_rsi_15m(c: np.ndarray, period: int = 7) -> float:
    """Calculate Wilder RSI on a series of closes.

    Seed with the simple average of the first period changes.
    Requires at least (period + 1) closes, else returns NaN.
    """
    if len(c) < period + 1:
        return float(np.nan)

    diffs = np.diff(c)
    gains = np.maximum(diffs, 0.0)
    losses = np.maximum(-diffs, 0.0)

    avg_gain = float(np.mean(gains[:period]))
    avg_loss = float(np.mean(losses[:period]))

    for k in range(period, len(diffs)):
        avg_gain = (avg_gain * (period - 1.0) + gains[k]) / period
        avg_loss = (avg_loss * (period - 1.0) + losses[k]) / period

    if avg_gain + avg_loss == 0.0:
        return 50.0
    return float(100.0 * avg_gain / (avg_gain + avg_loss))


def intrabar_features(
    five_min: pd.DataFrame,
    fifteen_min: pd.DataFrame,
    decision_interval_ms: int,
    decision_opens: Iterable[int],
) -> pd.DataFrame:
    """Extract causal intrabar features from 5m and 15m bars for decision bars.

    Returns a DataFrame indexed by decision close T with FEATURE_COLUMNS.
    If any required intrabar 5m or 15m bar is missing, every feature for that
    decision bar is NaN.
    """
    df5 = five_min.sort_values("t")
    df15 = fifteen_min.sort_values("t")

    t5 = df5["t"].to_numpy(dtype=np.int64)
    o5_all = df5["o"].to_numpy(dtype=float)
    h5_all = df5["h"].to_numpy(dtype=float)
    l5_all = df5["l"].to_numpy(dtype=float)
    c5_all = df5["c"].to_numpy(dtype=float)
    v5_all = df5["v"].to_numpy(dtype=float)
    tbv5_all = df5["tbv"].to_numpy(dtype=float)

    t15 = df15["t"].to_numpy(dtype=np.int64)
    c15_all = df15["c"].to_numpy(dtype=float)

    rows: list[dict[str, float]] = []
    T_index: list[int] = []

    for t_b in decision_opens:
        T = t_b + decision_interval_ms
        T_index.append(T)

        slice5 = _bars_inside_slice(t5, 300_000, t_b, T)
        slice15 = _bars_inside_slice(t15, 900_000, t_b, T)

        # If any intrabar 5m or 15m bar is missing, every intrabar feature is NaN
        if slice5 is None or slice15 is None:
            nan_row = {col: float(np.nan) for col in FEATURE_COLUMNS}
            rows.append(nan_row)
            continue

        i5_start, i5_end = slice5
        n_5 = i5_end - i5_start
        c5 = c5_all[i5_start:i5_end]
        o5 = o5_all[i5_start:i5_end]
        h5 = h5_all[i5_start:i5_end]
        l5 = l5_all[i5_start:i5_end]
        v5 = v5_all[i5_start:i5_end]
        tbv5 = tbv5_all[i5_start:i5_end]

        # Log returns within the bar: first return uses first 5m open o, subsequent use log(c_i / c_{i-1})
        r = np.empty(n_5, dtype=float)
        r[0] = np.log(c5[0] / o5[0])
        if n_5 > 1:
            r[1:] = np.log(c5[1:] / c5[:-1])

        # rv5: sum of squared 5m log returns inside the bar
        rv5 = float(np.sum(r**2))

        # bpv5: (pi / 2) * sum_{i >= 2} |r_i| * |r_{i-1}| inside the bar
        if n_5 >= 2:
            bpv5 = float((np.pi / 2.0) * np.sum(np.abs(r[1:]) * np.abs(r[:-1])))
        else:
            bpv5 = float(np.nan)

        # jump_share: max(0, rv5 - bpv5) / rv5, NaN when rv5 == 0
        if rv5 == 0.0 or np.isnan(rv5):
            jump_share = float(np.nan)
        else:
            jump_share = float(max(0.0, rv5 - bpv5) / rv5)

        # close_loc: (C - L) / (H - L) with the bar's H, L, C from 5m bars, and 0.5 when H == L
        H = float(np.max(h5))
        L = float(np.min(l5))
        C = float(c5[-1])
        if H == L:
            close_loc = 0.5
        else:
            close_loc = (C - L) / (H - L)

        # runup: max(h) / O - 1. drawdown: min(l) / O - 1. O is the first 5m open.
        open_price = float(o5[0])
        runup = float(H / open_price - 1.0)
        drawdown = float(L / open_price - 1.0)

        # taker_imb: sum(2 * tbv - v) / sum(v) over the bar's 5m bars. NaN if any tbv is NaN or sum(v) == 0.
        sum_v = float(np.sum(v5))
        if np.isnan(tbv5).any() or sum_v == 0.0:
            taker_imb = float(np.nan)
        else:
            taker_imb = float(np.sum(2.0 * tbv5 - v5) / sum_v)

        # taker_imb_last15: the same over the last 3 5m bars
        if n_5 < 3:
            taker_imb_last15 = float(np.nan)
        else:
            v_last15 = v5[-3:]
            tbv_last15 = tbv5[-3:]
            sum_v_last15 = float(np.sum(v_last15))
            if np.isnan(tbv_last15).any() or sum_v_last15 == 0.0:
                taker_imb_last15 = float(np.nan)
            else:
                taker_imb_last15 = float(np.sum(2.0 * tbv_last15 - v_last15) / sum_v_last15)

        # sign_changes: count of sign changes between consecutive nonzero 5m returns / (num nonzero returns - 1)
        nonzero_r = r[r != 0.0]
        if len(nonzero_r) < 2:
            sign_changes = float(np.nan)
        else:
            signs = np.sign(nonzero_r)
            changes = int(np.sum(signs[:-1] != signs[1:]))
            sign_changes = float(changes / (len(nonzero_r) - 1))

        # rv_late_early: rv of the last third of 5m returns divided by rv of the first third
        third = n_5 // 3
        if third == 0:
            rv_late_early = float(np.nan)
        else:
            rv_early = float(np.sum(r[:third] ** 2))
            rv_late = float(np.sum(r[-third:] ** 2))
            if rv_early == 0.0:
                rv_late_early = float(np.nan)
            else:
                rv_late_early = float(rv_late / rv_early)

        # 15m series features using only 15m bars closed at T
        idx15_closed = int(np.searchsorted(t15, T - 900_000, side="right"))
        n_closed_15 = idx15_closed

        # rsi7_15m: Wilder RSI with period 7 on the last RSI_WINDOW closed 15m closes.
        # Needs at least 8 closed 15m closes, else NaN.
        if n_closed_15 < 8:
            rsi7_15m = float(np.nan)
        else:
            start_rsi = max(0, idx15_closed - RSI_WINDOW)
            c15_window = c15_all[start_rsi:idx15_closed]
            rsi7_15m = wilder_rsi_15m(c15_window, period=7)

        # ret_15m_last: the log return of the last closed 15m bar
        if n_closed_15 < 2:
            ret_15m_last = float(np.nan)
        else:
            c15_last = float(c15_all[idx15_closed - 1])
            c15_prev = float(c15_all[idx15_closed - 2])
            ret_15m_last = float(np.log(c15_last / c15_prev))

        # ret_15m_4: the log return over the last 4 closed 15m bars
        if n_closed_15 < 5:
            ret_15m_4 = float(np.nan)
        else:
            c15_last = float(c15_all[idx15_closed - 1])
            c15_4_ago = float(c15_all[idx15_closed - 5])
            ret_15m_4 = float(np.log(c15_last / c15_4_ago))

        row = {
            "rv5": rv5,
            "bpv5": bpv5,
            "jump_share": jump_share,
            "close_loc": close_loc,
            "runup": runup,
            "drawdown": drawdown,
            "taker_imb": taker_imb,
            "taker_imb_last15": taker_imb_last15,
            "sign_changes": sign_changes,
            "rv_late_early": rv_late_early,
            "rsi7_15m": rsi7_15m,
            "ret_15m_last": ret_15m_last,
            "ret_15m_4": ret_15m_4,
        }
        rows.append(row)

    index = pd.Index(T_index, name="T")
    return pd.DataFrame(rows, index=index, columns=FEATURE_COLUMNS)
