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

FEATURE_COLUMNS_B = [
    "ret_1",
    "ret_4",
    "ret_24",
    "vol_24",
    "vol_72",
    "ret_4h_last",
    "trend_4h",
    "ret_1d_last",
    "trend_1d",
    "atr14_1d",
    "dist_pdh",
    "dist_pdl",
    "rv_prev_day",
    "dist_poc",
    "in_value_area",
    "basis",
    "basis_z7d",
    "funding_last",
    "funding_sum_7d",
    "funding_z30d",
    "btc_ret_last",
    "beta_72",
    "resid_ret",
    "hour_sin",
    "hour_cos",
    "dow_sin",
    "dow_cos",
]

ALL_FEATURE_COLUMNS = FEATURE_COLUMNS + FEATURE_COLUMNS_B

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


def compute_ema_trend(c: np.ndarray) -> float:
    """Calculate (ema12 - ema26) / ema26 on window of closes, seeded with c[0].

    alpha = 2 / (n + 1). Requires len(c) >= 52, else returns NaN.
    """
    if len(c) < 52:
        return float(np.nan)
    ema12 = float(c[0])
    ema26 = float(c[0])
    a12 = 2.0 / 13.0
    a26 = 2.0 / 27.0
    for p in c[1:]:
        val = float(p)
        ema12 = ema12 + a12 * (val - ema12)
        ema26 = ema26 + a26 * (val - ema26)
    if ema26 == 0.0 or np.isnan(ema26):
        return float(np.nan)
    return float((ema12 - ema26) / ema26)


def compute_wilder_atr_14(h: np.ndarray, l: np.ndarray, c: np.ndarray) -> float:
    """Calculate Wilder ATR(14) of 64 closed 1d bars.

    Seeded with the simple mean of the first 14 true ranges.
    Requires len(h) >= 64, else returns NaN.
    """
    if len(h) < 64:
        return float(np.nan)
    hl = h[1:] - l[1:]
    hc = np.abs(h[1:] - c[:-1])
    lc = np.abs(l[1:] - c[:-1])
    tr = np.maximum(hl, np.maximum(hc, lc))
    if len(tr) < 14:
        return float(np.nan)
    atr = float(np.mean(tr[:14]))
    for tr_val in tr[14:]:
        atr = (atr * 13.0 + float(tr_val)) / 14.0
    if atr <= 0.0 or np.isnan(atr):
        return float(np.nan)
    return float(atr)


def decision_features(decision_bars: pd.DataFrame, decision_interval_ms: int) -> pd.DataFrame:
    """Extract decision-interval return and volatility features.

    Columns indexed by T:
    - ret_1, ret_4, ret_24: log(c_T / c_{T - k bars}) over closed decision bars.
    - vol_24, vol_72: sample SD of the last 24 or 72 closed decision-bar log returns.
    NaN when not enough closed bars exist or any needed bar is missing.
    """
    cols = ["ret_1", "ret_4", "ret_24", "vol_24", "vol_72"]
    if len(decision_bars) == 0:
        return pd.DataFrame(columns=cols, index=pd.Index([], name="T"))

    df = decision_bars.sort_values("t").reset_index(drop=True)
    t = df["t"].to_numpy(dtype=np.int64)
    c = df["c"].to_numpy(dtype=float)
    n = len(t)
    T_vals = t + decision_interval_ms

    bad_steps = (np.diff(t) != decision_interval_ms).astype(int)
    cum_bad = np.concatenate(([0], np.cumsum(bad_steps)))

    ret_1 = np.full(n, np.nan, dtype=float)
    ret_4 = np.full(n, np.nan, dtype=float)
    ret_24 = np.full(n, np.nan, dtype=float)

    for k, ret_arr in ((1, ret_1), (4, ret_4), (24, ret_24)):
        if n > k:
            valid_k = (cum_bad[k:] - cum_bad[:-k]) == 0
            valid_k &= (c[k:] > 0) & (c[:-k] > 0)
            ret_arr[k:] = np.where(valid_k, np.log(c[k:] / c[:-k]), np.nan)

    # 1-bar log returns for rolling volatility
    r1 = np.full(n, np.nan, dtype=float)
    if n > 1:
        valid_1 = (cum_bad[1:] - cum_bad[:-1]) == 0
        valid_1 &= (c[1:] > 0) & (c[:-1] > 0)
        r1[1:] = np.where(valid_1, np.log(c[1:] / c[:-1]), np.nan)

    r1_series = pd.Series(r1)
    std_24 = r1_series.rolling(24).std(ddof=1).to_numpy()
    valid_24 = np.zeros(n, dtype=bool)
    if n >= 25:
        valid_24[24:] = (cum_bad[24:] - cum_bad[:-24]) == 0
    vol_24 = np.where(valid_24, std_24, np.nan)

    std_72 = r1_series.rolling(72).std(ddof=1).to_numpy()
    valid_72 = np.zeros(n, dtype=bool)
    if n >= 73:
        valid_72[72:] = (cum_bad[72:] - cum_bad[:-72]) == 0
    vol_72 = np.where(valid_72, std_72, np.nan)

    return pd.DataFrame(
        {
            "ret_1": ret_1,
            "ret_4": ret_4,
            "ret_24": ret_24,
            "vol_24": vol_24,
            "vol_72": vol_72,
        },
        index=pd.Index(T_vals, name="T"),
    )


def htf_features(
    T_values: Iterable[int],
    four_h: pd.DataFrame,
    one_d: pd.DataFrame,
    five_min: pd.DataFrame,
    decision_interval_ms: int,
) -> pd.DataFrame:
    """Extract higher-timeframe features from closed 4h and 1d bars."""
    cols = [
        "ret_4h_last",
        "trend_4h",
        "ret_1d_last",
        "trend_1d",
        "atr14_1d",
        "dist_pdh",
        "dist_pdl",
        "rv_prev_day",
        "dist_poc",
        "in_value_area",
    ]
    T_list = list(T_values)
    if not T_list:
        return pd.DataFrame(columns=cols, index=pd.Index([], name="T"))

    df4 = four_h.sort_values("t").reset_index(drop=True)
    df1 = one_d.sort_values("t").reset_index(drop=True)
    df5 = five_min.sort_values("t").reset_index(drop=True)

    t4 = df4["t"].to_numpy(dtype=np.int64) if "t" in df4.columns else np.empty(0, dtype=np.int64)
    c4 = df4["c"].to_numpy(dtype=float) if "c" in df4.columns else np.empty(0, dtype=float)
    n4 = len(t4)
    cum_bad4 = (
        np.concatenate(([0], np.cumsum((np.diff(t4) != 14_400_000).astype(int)))) if n4 > 1 else np.zeros(n4, dtype=int)
    )

    t1 = df1["t"].to_numpy(dtype=np.int64) if "t" in df1.columns else np.empty(0, dtype=np.int64)
    h1 = df1["h"].to_numpy(dtype=float) if "h" in df1.columns else np.empty(0, dtype=float)
    l1 = df1["l"].to_numpy(dtype=float) if "l" in df1.columns else np.empty(0, dtype=float)
    c1 = df1["c"].to_numpy(dtype=float) if "c" in df1.columns else np.empty(0, dtype=float)
    n1 = len(t1)
    cum_bad1 = (
        np.concatenate(([0], np.cumsum((np.diff(t1) != 86_400_000).astype(int)))) if n1 > 1 else np.zeros(n1, dtype=int)
    )

    t5 = df5["t"].to_numpy(dtype=np.int64) if "t" in df5.columns else np.empty(0, dtype=np.int64)
    o5 = df5["o"].to_numpy(dtype=float) if "o" in df5.columns else np.empty(0, dtype=float)
    h5 = df5["h"].to_numpy(dtype=float) if "h" in df5.columns else np.empty(0, dtype=float)
    l5 = df5["l"].to_numpy(dtype=float) if "l" in df5.columns else np.empty(0, dtype=float)
    c5 = df5["c"].to_numpy(dtype=float) if "c" in df5.columns else np.empty(0, dtype=float)
    v5 = df5["v"].to_numpy(dtype=float) if "v" in df5.columns else np.empty(0, dtype=float)

    # Precompute 4h features per bar
    trend4_by_bar = np.full(n4, np.nan, dtype=float)
    for i in range(51, n4):
        W = min(i + 1, 200)
        start = i + 1 - W
        if cum_bad4[i] - cum_bad4[start] == 0:
            trend4_by_bar[i] = compute_ema_trend(c4[start : i + 1])

    ret4_by_bar = np.full(n4, np.nan, dtype=float)
    for i in range(1, n4):
        if t4[i] - t4[i - 1] == 14_400_000 and c4[i] > 0 and c4[i - 1] > 0:
            ret4_by_bar[i] = float(np.log(c4[i] / c4[i - 1]))

    # Precompute 1d features per bar
    trend1_by_bar = np.full(n1, np.nan, dtype=float)
    for i in range(51, n1):
        W = min(i + 1, 200)
        start = i + 1 - W
        if cum_bad1[i] - cum_bad1[start] == 0:
            trend1_by_bar[i] = compute_ema_trend(c1[start : i + 1])

    ret1_by_bar = np.full(n1, np.nan, dtype=float)
    for i in range(1, n1):
        if t1[i] - t1[i - 1] == 86_400_000 and c1[i] > 0 and c1[i - 1] > 0:
            ret1_by_bar[i] = float(np.log(c1[i] / c1[i - 1]))

    atr1_by_bar = np.full(n1, np.nan, dtype=float)
    for i in range(63, n1):
        start = i + 1 - 64
        if cum_bad1[i] - cum_bad1[start] == 0:
            atr1_by_bar[i] = compute_wilder_atr_14(h1[start : i + 1], l1[start : i + 1], c1[start : i + 1])

    day_cache: dict[int, tuple[float, float, float, float]] = {}

    def get_day_va_and_rv(t_day: int) -> tuple[float, float, float, float]:
        if t_day in day_cache:
            return day_cache[t_day]
        s5 = _bars_inside_slice(t5, 300_000, t_day, t_day + 86_400_000)
        if s5 is None:
            res = (float(np.nan), float(np.nan), float(np.nan), float(np.nan))
            day_cache[t_day] = res
            return res
        i_start, i_end = s5
        c_day = c5[i_start:i_end]
        o_day = o5[i_start:i_end]
        h_day = h5[i_start:i_end]
        l_day = l5[i_start:i_end]
        v_day = v5[i_start:i_end]

        r_day = np.empty(288, dtype=float)
        r_day[0] = np.log(c_day[0] / o_day[0])
        r_day[1:] = np.log(c_day[1:] / c_day[:-1])
        rv = float(np.sum(r_day**2))

        d_low = float(np.min(l_day))
        d_high = float(np.max(h_day))
        tot_v = float(np.sum(v_day))
        if d_high <= d_low or tot_v <= 0.0:
            res = (rv, float(np.nan), float(np.nan), float(np.nan))
            day_cache[t_day] = res
            return res

        w = (d_high - d_low) / 50.0
        tp = (h_day + l_day + c_day) / 3.0
        b_idx = np.clip(((tp - d_low) / w).astype(int), 0, 49)
        bin_vols = np.zeros(50, dtype=float)
        np.add.at(bin_vols, b_idx, v_day)

        poc_b = int(np.argmax(bin_vols))
        poc = d_low + (poc_b + 0.5) * w

        target_v = 0.70 * tot_v
        left = poc_b
        right = poc_b
        va_vol = float(bin_vols[poc_b])
        while va_vol < target_v and (left > 0 or right < 49):
            if left > 0 and right < 49:
                if bin_vols[right + 1] >= bin_vols[left - 1]:
                    right += 1
                    va_vol += float(bin_vols[right])
                else:
                    left -= 1
                    va_vol += float(bin_vols[left])
            elif right < 49:
                right += 1
                va_vol += float(bin_vols[right])
            else:
                left -= 1
                va_vol += float(bin_vols[left])

        val = d_low + left * w
        vah = d_low + (right + 1) * w
        res = (rv, poc, val, vah)
        day_cache[t_day] = res
        return res

    out_ret_4h_last = []
    out_trend_4h = []
    out_ret_1d_last = []
    out_trend_1d = []
    out_atr14_1d = []
    out_dist_pdh = []
    out_dist_pdl = []
    out_rv_prev_day = []
    out_dist_poc = []
    out_in_value_area = []

    for T in T_list:
        # 4h features
        if n4 > 0:
            idx4 = int(np.searchsorted(t4, T - 14_400_000, side="right")) - 1
            if idx4 >= 0:
                trend_4h_val = trend4_by_bar[idx4]
                if decision_interval_ms == 3_600_000:
                    ret_4h_last_val = ret4_by_bar[idx4]
                else:
                    ret_4h_last_val = float(np.nan)
            else:
                trend_4h_val = float(np.nan)
                ret_4h_last_val = float(np.nan)
        else:
            trend_4h_val = float(np.nan)
            ret_4h_last_val = float(np.nan)

        out_trend_4h.append(trend_4h_val)
        out_ret_4h_last.append(ret_4h_last_val)

        # 1d features
        if n1 > 0:
            idx1 = int(np.searchsorted(t1, T - 86_400_000, side="right")) - 1
            if idx1 >= 0:
                t_day = int(t1[idx1])
                ret_1d_val = ret1_by_bar[idx1]
                trend_1d_val = trend1_by_bar[idx1]
                atr14_val = atr1_by_bar[idx1]
                pdh = float(h1[idx1])
                pdl = float(l1[idx1])
                rv_prev, poc, val, vah = get_day_va_and_rv(t_day)

                # C: close of last closed 5m bar at T
                if len(t5) > 0:
                    idx5 = int(np.searchsorted(t5, T - 300_000, side="right")) - 1
                    if idx5 >= 0 and t5[idx5] == T - 300_000:
                        C = float(c5[idx5])
                    else:
                        C = float(np.nan)
                else:
                    C = float(np.nan)

                if not np.isnan(C) and not np.isnan(atr14_val) and atr14_val > 0.0:
                    dist_pdh_val = float((C - pdh) / atr14_val)
                    dist_pdl_val = float((C - pdl) / atr14_val)
                    dist_poc_val = float((C - poc) / atr14_val) if not np.isnan(poc) else float(np.nan)
                else:
                    dist_pdh_val = float(np.nan)
                    dist_pdl_val = float(np.nan)
                    dist_poc_val = float(np.nan)

                if not np.isnan(C) and not np.isnan(val) and not np.isnan(vah):
                    in_va_val = 1.0 if (val <= C <= vah) else 0.0
                else:
                    in_va_val = float(np.nan)

                rv_prev_val = rv_prev
            else:
                ret_1d_val = float(np.nan)
                trend_1d_val = float(np.nan)
                atr14_val = float(np.nan)
                dist_pdh_val = float(np.nan)
                dist_pdl_val = float(np.nan)
                rv_prev_val = float(np.nan)
                dist_poc_val = float(np.nan)
                in_va_val = float(np.nan)
        else:
            ret_1d_val = float(np.nan)
            trend_1d_val = float(np.nan)
            atr14_val = float(np.nan)
            dist_pdh_val = float(np.nan)
            dist_pdl_val = float(np.nan)
            rv_prev_val = float(np.nan)
            dist_poc_val = float(np.nan)
            in_va_val = float(np.nan)

        out_ret_1d_last.append(ret_1d_val)
        out_trend_1d.append(trend_1d_val)
        out_atr14_1d.append(atr14_val)
        out_dist_pdh.append(dist_pdh_val)
        out_dist_pdl.append(dist_pdl_val)
        out_rv_prev_day.append(rv_prev_val)
        out_dist_poc.append(dist_poc_val)
        out_in_value_area.append(in_va_val)

    return pd.DataFrame(
        {
            "ret_4h_last": out_ret_4h_last,
            "trend_4h": out_trend_4h,
            "ret_1d_last": out_ret_1d_last,
            "trend_1d": out_trend_1d,
            "atr14_1d": out_atr14_1d,
            "dist_pdh": out_dist_pdh,
            "dist_pdl": out_dist_pdl,
            "rv_prev_day": out_rv_prev_day,
            "dist_poc": out_dist_poc,
            "in_value_area": out_in_value_area,
        },
        index=pd.Index(T_list, name="T"),
    )


def premium_features(T_values: Iterable[int], premium_5m: pd.DataFrame) -> pd.DataFrame:
    """Extract perp premium features (basis and 7d rolling z-score)."""
    cols = ["basis", "basis_z7d"]
    T_list = list(T_values)
    if not T_list:
        return pd.DataFrame(columns=cols, index=pd.Index([], name="T"))

    df = premium_5m.sort_values("t").reset_index(drop=True)
    t = df["t"].to_numpy(dtype=np.int64) if "t" in df.columns else np.empty(0, dtype=np.int64)
    c = df["c"].to_numpy(dtype=float) if "c" in df.columns else np.empty(0, dtype=float)
    n = len(t)

    cum_bad = np.concatenate(([0], np.cumsum((np.diff(t) != 300_000).astype(int)))) if n > 1 else np.zeros(n, dtype=int)

    s_c = pd.Series(c)
    roll_mean = s_c.rolling(2016).mean().to_numpy()
    roll_std = s_c.rolling(2016).std(ddof=1).to_numpy()

    out_basis = []
    out_basis_z7d = []

    for T in T_list:
        if n == 0:
            out_basis.append(float(np.nan))
            out_basis_z7d.append(float(np.nan))
            continue

        idx = int(np.searchsorted(t, T - 300_000, side="right")) - 1
        if idx < 0 or t[idx] != T - 300_000:
            out_basis.append(float(np.nan))
            out_basis_z7d.append(float(np.nan))
            continue

        basis_val = float(c[idx])
        out_basis.append(basis_val)

        if idx < 2015 or (cum_bad[idx] - cum_bad[idx - 2015] != 0):
            out_basis_z7d.append(float(np.nan))
        else:
            sd = float(roll_std[idx])
            if sd == 0.0 or np.isnan(sd):
                out_basis_z7d.append(float(np.nan))
            else:
                out_basis_z7d.append(float((basis_val - roll_mean[idx]) / sd))

    return pd.DataFrame(
        {"basis": out_basis, "basis_z7d": out_basis_z7d},
        index=pd.Index(T_list, name="T"),
    )


def funding_features(T_values: Iterable[int], settlements: pd.DataFrame) -> pd.DataFrame:
    """Extract funding rate features from actual settlements."""
    cols = ["funding_last", "funding_sum_7d", "funding_z30d"]
    T_list = list(T_values)
    if not T_list:
        return pd.DataFrame(columns=cols, index=pd.Index([], name="T"))

    df = settlements.sort_values("t").reset_index(drop=True)
    t = df["t"].to_numpy(dtype=np.int64) if "t" in df.columns else np.empty(0, dtype=np.int64)
    r = df["rate"].to_numpy(dtype=float) if "rate" in df.columns else np.empty(0, dtype=float)
    n = len(t)

    out_last = []
    out_sum_7d = []
    out_z30d = []

    for T in T_list:
        if n == 0:
            out_last.append(float(np.nan))
            out_sum_7d.append(float(np.nan))
            out_z30d.append(float(np.nan))
            continue

        idx_r = int(np.searchsorted(t, T, side="right"))
        if idx_r == 0:
            out_last.append(float(np.nan))
            out_sum_7d.append(float(np.nan))
            out_z30d.append(float(np.nan))
            continue

        last_val = float(r[idx_r - 1])
        out_last.append(last_val)

        # 7 days sum: T - 7 days < t <= T
        idx_l_7d = int(np.searchsorted(t, T - 604_800_000, side="right"))
        if idx_l_7d >= idx_r:
            out_sum_7d.append(float(np.nan))
        else:
            out_sum_7d.append(float(np.sum(r[idx_l_7d:idx_r])))

        # 30 days z-score: T - 30 days < t <= T
        idx_l_30d = int(np.searchsorted(t, T - 2_592_000_000, side="right"))
        count_30d = idx_r - idx_l_30d
        if count_30d < 30:
            out_z30d.append(float(np.nan))
        else:
            rates_30d = r[idx_l_30d:idx_r]
            mean_f = float(np.mean(rates_30d))
            sd_f = float(np.std(rates_30d, ddof=1))
            if sd_f == 0.0 or np.isnan(sd_f):
                out_z30d.append(float(np.nan))
            else:
                out_z30d.append(float((last_val - mean_f) / sd_f))

    return pd.DataFrame(
        {
            "funding_last": out_last,
            "funding_sum_7d": out_sum_7d,
            "funding_z30d": out_z30d,
        },
        index=pd.Index(T_list, name="T"),
    )


def btc_features(
    decision_bars: pd.DataFrame,
    btc_decision_bars: pd.DataFrame,
    decision_interval_ms: int,
) -> pd.DataFrame:
    """Extract BTC-relative return and beta features aligned on T."""
    cols = ["btc_ret_last", "beta_72", "resid_ret"]
    if len(decision_bars) == 0:
        return pd.DataFrame(columns=cols, index=pd.Index([], name="T"))

    df_coin = decision_bars.sort_values("t").reset_index(drop=True)
    df_btc = btc_decision_bars.sort_values("t").reset_index(drop=True)

    t_coin = df_coin["t"].to_numpy(dtype=np.int64)
    c_coin = df_coin["c"].to_numpy(dtype=float)
    n_coin = len(t_coin)

    t_btc = df_btc["t"].to_numpy(dtype=np.int64) if "t" in df_btc.columns else np.empty(0, dtype=np.int64)
    c_btc = df_btc["c"].to_numpy(dtype=float) if "c" in df_btc.columns else np.empty(0, dtype=float)
    n_btc = len(t_btc)

    cum_bad_coin = (
        np.concatenate(([0], np.cumsum((np.diff(t_coin) != decision_interval_ms).astype(int))))
        if n_coin > 1
        else np.zeros(n_coin, dtype=int)
    )

    cum_bad_btc = (
        np.concatenate(([0], np.cumsum((np.diff(t_btc) != decision_interval_ms).astype(int))))
        if n_btc > 1
        else np.zeros(n_btc, dtype=int)
    )

    T_vals = t_coin + decision_interval_ms
    out_btc_ret = []
    out_beta_72 = []
    out_resid_ret = []

    for i in range(n_coin):
        t_bar = t_coin[i]

        # Coin 1-bar return
        if i >= 1 and t_coin[i] - t_coin[i - 1] == decision_interval_ms and c_coin[i] > 0 and c_coin[i - 1] > 0:
            coin_ret_1 = float(np.log(c_coin[i] / c_coin[i - 1]))
        else:
            coin_ret_1 = float(np.nan)

        # Locate BTC bar closing at T (opening at t_bar)
        idx_btc = int(np.searchsorted(t_btc, t_bar)) if n_btc > 0 else -1
        if 0 <= idx_btc < n_btc and t_btc[idx_btc] == t_bar:
            if (
                idx_btc >= 1
                and t_btc[idx_btc] - t_btc[idx_btc - 1] == decision_interval_ms
                and c_btc[idx_btc] > 0
                and c_btc[idx_btc - 1] > 0
            ):
                btc_ret = float(np.log(c_btc[idx_btc] / c_btc[idx_btc - 1]))
            else:
                btc_ret = float(np.nan)

            # Beta 72
            if (
                i >= 72
                and idx_btc >= 72
                and cum_bad_coin[i] - cum_bad_coin[i - 72] == 0
                and cum_bad_btc[idx_btc] - cum_bad_btc[idx_btc - 72] == 0
                and t_coin[i - 72] == t_btc[idx_btc - 72]
            ):
                win_c_coin = c_coin[i - 72 : i + 1]
                win_c_btc = c_btc[idx_btc - 72 : idx_btc + 1]
                if np.all(win_c_coin > 0) and np.all(win_c_btc > 0):
                    y = np.diff(np.log(win_c_coin))
                    x = np.diff(np.log(win_c_btc))
                    mx = float(np.mean(x))
                    my = float(np.mean(y))
                    denom = float(np.sum((x - mx) ** 2))
                    if denom == 0.0 or np.isnan(denom):
                        beta_val = float(np.nan)
                    else:
                        beta_val = float(np.sum((x - mx) * (y - my)) / denom)
                else:
                    beta_val = float(np.nan)
            else:
                beta_val = float(np.nan)

            if not np.isnan(coin_ret_1) and not np.isnan(beta_val) and not np.isnan(btc_ret):
                resid_val = float(coin_ret_1 - beta_val * btc_ret)
            else:
                resid_val = float(np.nan)
        else:
            btc_ret = float(np.nan)
            beta_val = float(np.nan)
            resid_val = float(np.nan)

        out_btc_ret.append(btc_ret)
        out_beta_72.append(beta_val)
        out_resid_ret.append(resid_val)

    return pd.DataFrame(
        {
            "btc_ret_last": out_btc_ret,
            "beta_72": out_beta_72,
            "resid_ret": out_resid_ret,
        },
        index=pd.Index(T_vals, name="T"),
    )


def calendar_features(T_values: Iterable[int]) -> pd.DataFrame:
    """Extract cyclical hour and day-of-week calendar features from UTC timestamp."""
    cols = ["hour_sin", "hour_cos", "dow_sin", "dow_cos"]
    T_list = list(T_values)
    if not T_list:
        return pd.DataFrame(columns=cols, index=pd.Index([], name="T"))

    T_arr = np.asarray(T_list, dtype=np.int64)
    dt = pd.to_datetime(T_arr, unit="ms", utc=True)
    hour = dt.hour.to_numpy(dtype=float)
    dow = dt.dayofweek.to_numpy(dtype=float)

    hour_sin = np.sin(2.0 * np.pi * hour / 24.0)
    hour_cos = np.cos(2.0 * np.pi * hour / 24.0)
    dow_sin = np.sin(2.0 * np.pi * dow / 7.0)
    dow_cos = np.cos(2.0 * np.pi * dow / 7.0)

    return pd.DataFrame(
        {
            "hour_sin": hour_sin,
            "hour_cos": hour_cos,
            "dow_sin": dow_sin,
            "dow_cos": dow_cos,
        },
        index=pd.Index(T_list, name="T"),
    )


def build_feature_frame(
    five_min: pd.DataFrame,
    fifteen_min: pd.DataFrame,
    decision_bars: pd.DataFrame,
    four_h: pd.DataFrame,
    one_d: pd.DataFrame,
    premium_5m: pd.DataFrame,
    settlements: pd.DataFrame,
    btc_decision_bars: pd.DataFrame,
    decision_interval_ms: int = 3_600_000,
    decision_opens: Iterable[int] | None = None,
) -> pd.DataFrame:
    """Extract and align all part A and part B features for one symbol."""
    if decision_opens is None:
        sorted_dec = decision_bars.sort_values("t")
        decision_opens_list = sorted_dec["t"].tolist() if "t" in sorted_dec.columns else []
    else:
        decision_opens_list = list(decision_opens)

    T_values = [t_b + decision_interval_ms for t_b in decision_opens_list]

    df_a = intrabar_features(five_min, fifteen_min, decision_interval_ms, decision_opens_list)
    df_dec = decision_features(decision_bars, decision_interval_ms).reindex(index=T_values)
    df_htf = htf_features(T_values, four_h, one_d, five_min, decision_interval_ms)
    df_prem = premium_features(T_values, premium_5m)
    df_fund = funding_features(T_values, settlements)
    df_btc = btc_features(decision_bars, btc_decision_bars, decision_interval_ms).reindex(index=T_values)
    df_cal = calendar_features(T_values)

    combined = pd.concat([df_a, df_dec, df_htf, df_prem, df_fund, df_btc, df_cal], axis=1)
    reindexed = combined.reindex(columns=ALL_FEATURE_COLUMNS)
    reindexed.index.name = "T"
    return reindexed
