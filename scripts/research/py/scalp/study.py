"""Scalp Study S1: 1h-context scalping on Binance USDT-M perpetuals, span R.

Implementation of the study registered in scripts/research/py/scalp/lock.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4.account import simulate_account
from r4.book import Tranche
from r4.costs import coin_slippage_bps
from scalp.lock import (
    BNB_MAKER_FEE,
    BNB_TAKER_FEE,
    CONFIG_IDS,
    DAY_MS,
    EMA_SPAN,
    FIVE_MIN_MS,
    HOLDS_MS,
    HOUR_MS,
    IMB_BARS,
    IMB_QUANTILE,
    LEVERAGES,
    MAKER_FEE,
    MAKER_ROUND_TRIP,
    MONTHS,
    PASS_MONTHS,
    PASS_T,
    SIGMA_BARS,
    SLOTS,
    SPAN_END_MS,
    SPAN_START_MS,
    START_EQUITY,
    SYMBOLS,
    TAKER_FEE,
    TRADE_START_MS,
    TRADING_DAYS,
)


def load(data_dir: str | Path) -> tuple[dict[str, pd.DataFrame], pd.DataFrame]:
    """Load and verify input datasets per data contract.

    Verifies sha256 of every file listed in manifest.json against the file contents.
    Refuses any bar outside [SPAN_START_MS, SPAN_END_MS).
    """
    p_dir = Path(data_dir)
    manifest_path = p_dir / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Missing manifest.json in {data_dir}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files_map: dict[str, str] = manifest.get("files", {})

    # Verify hashes
    for fname, expected_hash in files_map.items():
        file_path = p_dir / fname
        if not file_path.exists():
            raise FileNotFoundError(f"File listed in manifest does not exist: {fname}")
        content = file_path.read_bytes()
        actual_hash = hashlib.sha256(content).hexdigest()
        if actual_hash != expected_hash:
            raise ValueError(f"sha256 mismatch for {fname}: expected {expected_hash}, got {actual_hash}")

    frames: dict[str, pd.DataFrame] = {}
    for sym in manifest.get("symbols", SYMBOLS):
        fpath = p_dir / f"klines_{sym}.parquet"
        if fpath.exists():
            df = pd.read_parquet(fpath)
            # Refuse bars outside [SPAN_START_MS, SPAN_END_MS)
            if len(df) > 0:
                t_min = df["t"].min()
                t_max = df["t"].max()
                if t_min < SPAN_START_MS or t_max >= SPAN_END_MS:
                    raise ValueError(
                        f"Bar outside span for {sym}: min_t={t_min} (start={SPAN_START_MS}), "
                        f"max_t={t_max} (end={SPAN_END_MS})"
                    )
            frames[sym] = df

    funding_path = p_dir / "funding.parquet"
    if funding_path.exists():
        funding = pd.read_parquet(funding_path)
    else:
        funding = pd.DataFrame(columns=["symbol", "t", "rate"])

    return frames, funding


def features(frame: pd.DataFrame) -> pd.DataFrame:
    """Compute features at each 5m close T from bars closing at or before T.

    Missing bars: no decision at a bar whose own bar or previous bar is missing.
    The 288-bar windows require 288 present values, else no decision.
    1h bars are aggregated from 5m bars on the UTC hour grid, and an hour with any
    missing 5m bar is missing. The EMA skips missing hours by carrying the last value.
    """
    if len(frame) == 0:
        return pd.DataFrame(columns=["T", "r5", "s5", "trend", "imb", "q", "valid"])

    df = frame.sort_values("t").copy()

    # Place on regular 5m grid between min(t) and max(t)
    t_start = int((df["t"].min() // FIVE_MIN_MS) * FIVE_MIN_MS)
    t_end = int(df["t"].max()) + FIVE_MIN_MS
    all_t = np.arange(t_start, t_end, FIVE_MIN_MS, dtype=np.int64)

    grid = pd.DataFrame({"t": all_t})
    grid = grid.merge(df, on="t", how="left")

    # Decision instant T is the close of the bar with open time t
    grid["T"] = grid["t"] + FIVE_MIN_MS

    # Missing bar indicator
    present = ~grid["c"].isna()
    prev_present = present.shift(1).fillna(False)
    both_present = present & prev_present

    # r5(T) = log(c(T) / c(T - 5m))
    r5 = np.where(both_present, np.log(grid["c"] / grid["c"].shift(1)), np.nan)
    grid["r5"] = r5

    # s5(T) = sample SD of the last 288 values of r5 ending at T.
    # min_periods=288 requires exactly 288 present values of r5
    grid["s5"] = grid["r5"].rolling(SIGMA_BARS, min_periods=SIGMA_BARS).std(ddof=1)

    # imb(T) = 2 x taker buy volume / volume - 1 for the bar ending at T, 0 when volume is 0
    vol = grid["v"].to_numpy(dtype=np.float64)
    tbv = grid["tbv"].to_numpy(dtype=np.float64)
    imb = np.full(len(grid), np.nan, dtype=np.float64)
    valid_vol = present.to_numpy()
    imb[valid_vol & (vol == 0.0)] = 0.0
    non_zero = valid_vol & (vol > 0.0)
    imb[non_zero] = 2.0 * tbv[non_zero] / vol[non_zero] - 1.0
    grid["imb"] = imb

    # q(T) = 80th percentile of abs(imb) over the last 288 bars ending at T
    abs_imb = pd.Series(np.abs(grid["imb"]))
    grid["q"] = abs_imb.rolling(IMB_BARS, min_periods=IMB_BARS).quantile(IMB_QUANTILE)

    # 1h bar aggregation on UTC hour grid
    # An hour starts at H (where H % HOUR_MS == 0) and has 12 5m bars.
    # If any of the 12 bars is missing, the 1h bar is missing.
    h_start = int((t_start // HOUR_MS) * HOUR_MS)
    h_end = int((t_end // HOUR_MS + 2) * HOUR_MS)
    all_hours = np.arange(h_start, h_end, HOUR_MS, dtype=np.int64)

    # Fast bar lookup by open time t
    grid_t = grid["t"].to_numpy(dtype=np.int64)
    grid_c = grid["c"].to_numpy(dtype=np.float64)
    grid_present = present.to_numpy(dtype=bool)

    t_idx_map = {int(t_val): idx for idx, t_val in enumerate(grid_t)}

    hour_completes = np.zeros(len(all_hours), dtype=bool)
    hour_closes = np.full(len(all_hours), np.nan, dtype=np.float64)

    for hi, h_ts in enumerate(all_hours):
        # 12 bars at h_ts + k * 5m for k in 0..11
        all_12 = True
        for k in range(12):
            bar_t = int(h_ts + k * FIVE_MIN_MS)
            idx = t_idx_map.get(bar_t)
            if idx is None or not grid_present[idx]:
                all_12 = False
                break
        if all_12:
            last_bar_idx = t_idx_map[int(h_ts + 11 * FIVE_MIN_MS)]
            hour_completes[hi] = True
            hour_closes[hi] = grid_c[last_bar_idx]

    # EMA of completed 1h closes with alpha 2 / 21, seeded by first 20 closes' mean.
    # The EMA skips missing hours by carrying the last value.
    alpha = 2.0 / (EMA_SPAN + 1.0)
    ema_series = np.full(len(all_hours), np.nan, dtype=np.float64)
    last_c_series = np.full(len(all_hours), np.nan, dtype=np.float64)

    valid_closes: list[float] = []
    current_ema: float | None = None
    last_valid_c: float | None = None

    for i in range(len(all_hours)):
        if hour_completes[i]:
            c_val = hour_closes[i]
            last_valid_c = c_val
            if current_ema is None:
                valid_closes.append(c_val)
                if len(valid_closes) == EMA_SPAN:
                    current_ema = float(np.mean(valid_closes))
            else:
                current_ema = alpha * c_val + (1.0 - alpha) * current_ema

        ema_series[i] = current_ema if current_ema is not None else np.nan
        last_c_series[i] = last_valid_c if last_valid_c is not None else np.nan

    hour_df = pd.DataFrame(
        {
            "complete_time": all_hours + HOUR_MS,
            "C": last_c_series,
            "ema": ema_series,
        }
    )

    # Merge completed 1h metrics back to decision instant T
    # At instant T, the latest 1h bar completed at or before T is the one completing at (T // HOUR_MS) * HOUR_MS
    grid["complete_time"] = (grid["T"] // HOUR_MS) * HOUR_MS

    grid = grid.merge(
        hour_df,
        on="complete_time",
        how="left",
    )

    # trend(T) = sign(C - E), 0 when C == E
    c_arr = grid["C"].to_numpy(dtype=np.float64)
    ema_arr = grid["ema"].to_numpy(dtype=np.float64)
    trend = np.full(len(grid), np.nan, dtype=np.float64)
    has_trend = (~np.isnan(c_arr)) & (~np.isnan(ema_arr))
    diff = c_arr[has_trend] - ema_arr[has_trend]
    trend[has_trend] = np.where(diff > 0, 1.0, np.where(diff < 0, -1.0, 0.0))
    grid["trend"] = trend

    # Valid decision: own bar present, prev bar present, 288 s5 present, 288 q present, trend present
    valid = (
        both_present.to_numpy()
        & (~np.isnan(grid["s5"].to_numpy()))
        & (~np.isnan(grid["q"].to_numpy()))
        & (~np.isnan(grid["trend"].to_numpy()))
    )
    grid["valid"] = valid

    return grid[["T", "r5", "s5", "trend", "imb", "q", "valid"]].copy()


def signals(feat: pd.DataFrame, rule: str) -> pd.Series:
    """Generate trade signals for rule P1, P2 or P3 per decision instant T.

    Returns side +1 (long), -1 (short), or 0. Decisions only from TRADE_START_MS.
    """
    if len(feat) == 0:
        return pd.Series([], dtype=np.int64)

    t_arr = feat["T"].to_numpy(dtype=np.int64)
    valid_arr = feat["valid"].to_numpy(dtype=bool)
    eligible = (t_arr >= TRADE_START_MS) & valid_arr

    side = np.zeros(len(feat), dtype=np.int64)
    r5 = feat["r5"].to_numpy(dtype=np.float64)
    s5 = feat["s5"].to_numpy(dtype=np.float64)
    trend = feat["trend"].to_numpy(dtype=np.float64)
    imb = feat["imb"].to_numpy(dtype=np.float64)
    q = feat["q"].to_numpy(dtype=np.float64)

    if rule == "P1":
        # P1 trend pullback: trend +1 and r5 <= -s5 gives long; trend -1 and r5 >= +s5 gives short
        long_mask = eligible & (s5 > 0) & (trend == 1.0) & (r5 <= -s5)
        short_mask = eligible & (s5 > 0) & (trend == -1.0) & (r5 >= s5)
        side[long_mask] = 1
        side[short_mask] = -1
    elif rule == "P2":
        # P2 short-term reversal: r5 >= +s5 gives short; r5 <= -s5 gives long
        long_mask = eligible & (s5 > 0) & (r5 <= -s5)
        short_mask = eligible & (s5 > 0) & (r5 >= s5)
        side[long_mask] = 1
        side[short_mask] = -1
    elif rule == "P3":
        # P3 flow with trend: trend +1 and imb >= q gives long; trend -1 and imb <= -q gives short
        long_mask = eligible & (q > 0) & (trend == 1.0) & (imb >= q)
        short_mask = eligible & (q > 0) & (trend == -1.0) & (imb <= -q)
        side[long_mask] = 1
        side[short_mask] = -1
    else:
        raise ValueError(f"Unknown rule: {rule}")

    return pd.Series(side, index=feat.index, dtype=np.int64)


def simulate(
    frames: dict[str, pd.DataFrame],
    funding: pd.DataFrame,
    rule: str,
    hold: str | int,
    execution: str,
) -> pd.DataFrame:
    """Simulate trading for a given configuration across symbols."""
    hold_ms = HOLDS_MS[hold] if isinstance(hold, str) and hold in HOLDS_MS else int(hold)
    all_trades: list[dict[str, Any]] = []

    total_maker_orders_placed = 0
    total_missing_exits = 0
    total_dropped_trades = 0

    # Index funding settlements by symbol
    fund_by_sym: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    if funding is not None and not funding.empty:
        for sym in frames:
            sub = funding[funding["symbol"] == sym]
            if not sub.empty:
                s_t = sub["t"].to_numpy(dtype=np.int64)
                s_r = sub["rate"].to_numpy(dtype=np.float64)
                order = np.argsort(s_t)
                fund_by_sym[sym] = (s_t[order], s_r[order])

    for sym, df_raw in sorted(frames.items()):
        if len(df_raw) == 0:
            continue
        df = df_raw.sort_values("t").reset_index(drop=True)
        feat = features(df)
        sig = signals(feat, rule)

        # Quick lookup for bars by timestamp t
        t_to_row = {int(t): i for i, t in enumerate(df["t"])}

        coin_trades: list[dict[str, Any]] = []
        coin_free_at = 0

        slip_rate = coin_slippage_bps(sym) / 10000.0

        for i in range(len(feat)):
            t_instant = int(feat["T"].iloc[i])
            side = int(sig.iloc[i])

            if t_instant < coin_free_at:
                continue

            if side == 0:
                continue

            if t_instant >= SPAN_END_MS - hold_ms:
                continue

            # Index of bar ending at T (which has t = T - 5m)
            t_bar_ending = t_instant - FIVE_MIN_MS
            if t_bar_ending not in t_to_row:
                continue
            row_ending = df.iloc[t_to_row[t_bar_ending]]
            limit_px = float(row_ending["c"])

            # Bar starting at T (the entry bar)
            if t_instant not in t_to_row:
                # Entry bar missing
                continue
            row_entry = df.iloc[t_to_row[t_instant]]

            if execution == "taker":
                entry_fill = "taker"
                entry_px = float(row_entry["o"])
                entry_ms = t_instant
            elif execution == "maker":
                total_maker_orders_placed += 1
                # Maker entry checks strict trade-through in bar [T, T + 5m)
                low_val = float(row_entry["l"])
                high_val = float(row_entry["h"])
                filled = False
                if side == 1 and low_val < limit_px:
                    filled = True
                elif side == -1 and high_val > limit_px:
                    filled = True

                if not filled:
                    coin_free_at = t_instant + FIVE_MIN_MS
                    continue

                entry_fill = "maker"
                entry_px = limit_px
                entry_ms = t_instant
            else:
                raise ValueError(f"Unknown execution: {execution}")

            # Exit logic
            scheduled_exit = entry_ms + hold_ms
            if scheduled_exit in t_to_row:
                exit_ms = scheduled_exit
                exit_px = float(df.iloc[t_to_row[exit_ms]]["o"])
            else:
                # Missing exit bar: find next present open
                future_bars = df[df["t"] > scheduled_exit]
                if len(future_bars) > 0:
                    next_bar = future_bars.iloc[0]
                    exit_ms = int(next_bar["t"])
                    exit_px = float(next_bar["o"])
                    total_missing_exits += 1
                else:
                    exit_ms = SPAN_END_MS
                    exit_px = float("nan")

            if exit_ms >= SPAN_END_MS:
                total_dropped_trades += 1
                coin_free_at = exit_ms
                continue

            coin_free_at = exit_ms

            # Funding calculation: side x rate for settlements in (entry_ms, exit_ms]
            fund_val = 0.0
            if sym in fund_by_sym:
                f_t, f_r = fund_by_sym[sym]
                mask = (f_t > entry_ms) & (f_t <= exit_ms)
                if np.any(mask):
                    fund_val = float(side * np.sum(f_r[mask]))

            coin_trades.append(
                {
                    "symbol": sym,
                    "side": side,
                    "T": t_instant,
                    "entry_ms": entry_ms,
                    "exit_ms": exit_ms,
                    "entry_px": entry_px,
                    "exit_px": exit_px,
                    "entry_fill": entry_fill,
                    "exit_fill": "taker",
                    "funding": fund_val,
                }
            )

        # Netting calculation for this symbol's trades
        n_tr = len(coin_trades)
        for idx in range(n_tr):
            tr = coin_trades[idx]
            # Unnetted costs
            fee_in = MAKER_FEE if tr["entry_fill"] == "maker" else TAKER_FEE
            slip_in = 0.0 if tr["entry_fill"] == "maker" else slip_rate
            fee_out = TAKER_FEE
            slip_out = slip_rate

            tr["cost"] = fee_in + slip_in + fee_out + slip_out

            fee_in_bnb = BNB_MAKER_FEE if tr["entry_fill"] == "maker" else BNB_TAKER_FEE
            tr["cost_bnb"] = fee_in_bnb + slip_in + BNB_TAKER_FEE + slip_out

            # Check netting with previous trade
            if idx > 0:
                prev_tr = coin_trades[idx - 1]
                if (
                    prev_tr["exit_ms"] == tr["entry_ms"]
                    and prev_tr["exit_fill"] == "taker"
                    and tr["entry_fill"] == "taker"
                ):
                    if prev_tr["side"] == tr["side"]:
                        # Same-side continuation: pair pays nothing at this open
                        # Credit exit leg of prev_tr and entry leg of tr
                        prev_tr["cost"] -= fee_out + slip_out
                        prev_tr["cost_bnb"] -= BNB_TAKER_FEE + slip_out
                        tr["cost"] -= fee_in + slip_in
                        tr["cost_bnb"] -= fee_in_bnb + slip_in

            gross = tr["side"] * np.log(tr["exit_px"] / tr["entry_px"])
            tr["gross"] = gross
            tr["net"] = gross - tr["cost"] - tr["funding"]
            tr["net_bnb"] = gross - tr["cost_bnb"] - tr["funding"]

        all_trades.extend(coin_trades)

    cols = [
        "symbol",
        "side",
        "T",
        "entry_ms",
        "exit_ms",
        "entry_px",
        "exit_px",
        "entry_fill",
        "exit_fill",
        "gross",
        "cost",
        "funding",
        "net",
        "cost_bnb",
        "net_bnb",
    ]
    if len(all_trades) == 0:
        res_df = pd.DataFrame(columns=cols)
    else:
        res_df = pd.DataFrame(all_trades).sort_values(["entry_ms", "symbol"]).reset_index(drop=True)

    res_df.attrs["maker_orders_placed"] = total_maker_orders_placed
    res_df.attrs["missing_exits"] = total_missing_exits
    res_df.attrs["dropped_trades"] = total_dropped_trades

    return res_df


def metrics(trades: pd.DataFrame, maker_orders_placed: int | None = None) -> dict[str, Any]:
    """Compute summary statistics and decision table evaluation."""
    n_trades = len(trades)

    if maker_orders_placed is None:
        maker_orders_placed = getattr(trades, "attrs", {}).get("maker_orders_placed", None)

    maker_fills = (trades["entry_fill"] == "maker").sum() if n_trades > 0 else 0
    if maker_orders_placed and maker_orders_placed > 0:
        maker_fill_rate = float(maker_fills) / float(maker_orders_placed)
    else:
        maker_fill_rate = 0.0

    if n_trades > 0:
        gross_mean_bps = float(trades["gross"].mean()) * 10000.0
        cost_mean_bps = float(trades["cost"].mean()) * 10000.0
        funding_mean_bps = float(trades["funding"].mean()) * 10000.0
        net_mean_bps = float(trades["net"].mean()) * 10000.0
        net_bnb_mean_bps = float(trades["net_bnb"].mean()) * 10000.0
        hit_rate = float((trades["net"] > 0).mean())
    else:
        gross_mean_bps = 0.0
        cost_mean_bps = 0.0
        funding_mean_bps = 0.0
        net_mean_bps = 0.0
        net_bnb_mean_bps = 0.0
        hit_rate = 0.0

    trades_per_day = float(n_trades) / float(TRADING_DAYS)

    # Daily net series over the 117 trading days
    day_starts = [TRADE_START_MS + k * DAY_MS for k in range(TRADING_DAYS)]
    daily_net_map = {ds: 0.0 for ds in day_starts}

    if n_trades > 0:
        exit_days = (trades["exit_ms"].to_numpy(dtype=np.int64) // DAY_MS) * DAY_MS
        for d, net_v in zip(exit_days, trades["net"].to_numpy(dtype=np.float64), strict=False):
            if d in daily_net_map:
                daily_net_map[d] += float(net_v)

    daily_net_series = [daily_net_map[ds] for ds in day_starts]
    d_arr = np.array(daily_net_series, dtype=np.float64)
    d_mean = float(d_arr.mean())
    d_sd = float(d_arr.std(ddof=1)) if len(d_arr) > 1 else 0.0
    t_stat = float(d_mean / (d_sd / np.sqrt(TRADING_DAYS))) if d_sd > 0 else 0.0

    # Monthly net sums for July, August, September, October
    monthly_net: dict[str, float] = {}
    for m_name, m_start, m_end in MONTHS:
        m_sum = 0.0
        if n_trades > 0:
            mask = (trades["exit_ms"] >= m_start) & (trades["exit_ms"] < m_end)
            m_sum = float(trades.loc[mask, "net"].sum())
        monthly_net[m_name] = m_sum

    positive_months = sum(1 for v in monthly_net.values() if v > 0)
    passes = (net_mean_bps > 0) and (t_stat >= PASS_T) and (positive_months >= PASS_MONTHS)

    return {
        "trades": n_trades,
        "trades_per_day": trades_per_day,
        "gross_mean_bps": gross_mean_bps,
        "cost_mean_bps": cost_mean_bps,
        "funding_mean_bps": funding_mean_bps,
        "net_mean_bps": net_mean_bps,
        "net_bnb_mean_bps": net_bnb_mean_bps,
        "hit_rate": hit_rate,
        "maker_fill_rate": maker_fill_rate,
        "daily_net": daily_net_series,
        "t": t_stat,
        "monthly_net": monthly_net,
        "positive_months": positive_months,
        "passes": bool(passes),
    }


def account(
    trades: pd.DataFrame,
    frames: dict[str, pd.DataFrame],
    funding: pd.DataFrame,
    leverage: int | float,
) -> dict[str, Any]:
    """Replay trades on a $100 account at chosen leverage through r4.account.simulate_account.

    Mapping to Tranche:
    simulate_account sizes target notional as math.floor(abs(new_w) * equity * leverage / ref / step) * step.
    By setting Tranche.weight_override = side * (1.0 / SLOTS), abs(new_w) = 1.0 / SLOTS = 0.1,
    so target entry notional is equity * leverage / SLOTS, satisfying the brief requirement.
    """
    if len(trades) == 0:
        return {
            "final_equity": float(START_EQUITY),
            "drawdown": 0.0,
            "liquidation_instant": None,
            "refused_orders": 0,
            "max_drawdown": 0.0,
            "orders_skipped": 0,
            "orders_total": 0,
            "orders_executed": 0,
            "liquidation": None,
        }

    tranches: list[Tranche] = []
    for _, tr in trades.iterrows():
        side_val = int(tr["side"])
        tranches.append(
            Tranche(
                symbol=str(tr["symbol"]),
                side=side_val,
                entry_ms=int(tr["entry_ms"]),
                exit_ms=int(tr["exit_ms"]),
                entry_price=float(tr["entry_px"]),
                exit_price=float(tr["exit_px"]),
                interval="5m",
                h_ms=int(tr["exit_ms"] - tr["entry_ms"]),
                entry_fill=str(tr["entry_fill"]),
                exit_fill=str(tr["exit_fill"]),
                weight_override=side_val * (1.0 / SLOTS),
            )
        )

    try:
        res = simulate_account(
            tranches=tranches,
            five_min=frames,
            settlements=funding,
            equity0=START_EQUITY,
            leverage=float(leverage),
        )
        s = res.summary(include_daily=False)
        return {
            "final_equity": float(res.final_equity),
            "drawdown": float(s["max_drawdown"]),
            "liquidation_instant": int(res.liquidation["t"]) if res.liquidation is not None else None,
            "refused_orders": int(res.orders_skipped),
            **s,
        }
    except Exception as exc:
        return {"unavailable": str(exc)}


def break_even(frames: dict[str, pd.DataFrame]) -> dict[str, Any]:
    """Compute break-even reference metrics per coin for 15m and 60m holds."""
    out: dict[str, dict[str, float]] = {}

    for sym, df_raw in sorted(frames.items()):
        if len(df_raw) == 0:
            continue
        df = df_raw.sort_values("t")
        closes = df["c"].to_numpy(dtype=np.float64)

        out[sym] = {}
        slip = coin_slippage_bps(sym) / 10000.0
        taker_rt = 2.0 * (TAKER_FEE + slip)
        out[sym]["taker_round_trip"] = taker_rt
        out[sym]["maker_round_trip"] = MAKER_ROUND_TRIP

        for h_name, step in (("15m", 3), ("60m", 12)):
            sub_closes = closes[::step]
            if len(sub_closes) > 1:
                rets = np.log(sub_closes[1:] / sub_closes[:-1])
                s_h = float(np.std(rets, ddof=1))
            else:
                s_h = 0.0

            rho_taker = float(taker_rt / (0.798 * s_h)) if s_h > 0 else 0.0
            rho_maker = float(MAKER_ROUND_TRIP / (0.798 * s_h)) if s_h > 0 else 0.0

            out[sym][f"s_{h_name}"] = s_h
            out[sym][f"rho_taker_{h_name}"] = rho_taker
            out[sym][f"rho_maker_{h_name}"] = rho_maker

    return out


def run(data_dir: str | Path, out_path: str | Path, commit: str) -> dict[str, Any]:
    """Execute all 12 CONFIG_IDS, account simulations, break_even and output JSON."""
    out_p = Path(out_path)
    if out_p.exists():
        raise FileExistsError(f"Output path already exists: {out_path}")

    # Read lock sha256
    lock_file = Path(__file__).parent / "lock.py"
    lock_sha256 = hashlib.sha256(lock_file.read_bytes()).hexdigest()

    frames, funding = load(data_dir)

    # Manifest file hashes
    manifest_p = Path(data_dir) / "manifest.json"
    manifest = json.loads(manifest_p.read_text(encoding="utf-8")) if manifest_p.exists() else {}
    manifest_hashes = manifest.get("files", {})

    # Compute missing bars across the full span
    total_missing_bars = 0
    span_bars = int((SPAN_END_MS - SPAN_START_MS) // FIVE_MIN_MS)
    for sym in frames:
        total_missing_bars += max(0, span_bars - len(frames[sym]))

    configs_result: dict[str, Any] = {}
    total_missing_exits = 0
    total_dropped_trades = 0

    for cfg_id in CONFIG_IDS:
        rule, hold, execution = cfg_id.split("_")
        trades = simulate(frames, funding, rule, hold, execution)

        total_missing_exits += int(trades.attrs.get("missing_exits", 0))
        total_dropped_trades += int(trades.attrs.get("dropped_trades", 0))

        m = metrics(trades)

        account_res: dict[str, Any] = {}
        for lev in LEVERAGES:
            account_res[str(lev)] = account(trades, frames, funding, lev)

        configs_result[cfg_id] = {
            "metrics": m,
            "account": account_res,
        }

    be_result = break_even(frames)

    # Decision table evaluation
    passes_per_config = {cid: bool(configs_result[cid]["metrics"]["passes"]) for cid in CONFIG_IDS}
    number_passing = sum(1 for p in passes_per_config.values() if p)

    taker_gross_below_cost = True
    for cid in CONFIG_IDS:
        if "taker" in cid:
            m = configs_result[cid]["metrics"]
            if m["gross_mean_bps"] >= m["cost_mean_bps"]:
                taker_gross_below_cost = False

    prediction_met = (number_passing == 0) and taker_gross_below_cost

    result = {
        "lock_sha256": lock_sha256,
        "commit": commit,
        "manifest_hashes": manifest_hashes,
        "configs": configs_result,
        "break_even": be_result,
        "counts": {
            "missing_bars": total_missing_bars,
            "missing_exits": total_missing_exits,
            "dropped_trades": total_dropped_trades,
        },
        "decision_table": {
            "passes_per_config": passes_per_config,
            "number_passing": number_passing,
            "all_taker_gross_below_cost": taker_gross_below_cost,
            "prediction_met": prediction_met,
        },
    }

    out_p.parent.mkdir(parents=True, exist_ok=True)
    out_p.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Scalp Study S1 Runner")
    parser.add_argument("--data", required=True, help="Path to input data directory")
    parser.add_argument("--out", required=True, help="Path to output JSON file")
    parser.add_argument("--commit", required=True, help="Git commit SHA")
    args = parser.parse_args()

    run(data_dir=args.data, out_path=args.out, commit=args.commit)


if __name__ == "__main__":
    main()
