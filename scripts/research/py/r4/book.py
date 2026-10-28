"""Mark-to-market book returns, drift-hedged returns, and drift-free trade returns.

Implements the lock-v2 BOOK RULE: tranches to daily mark-to-market book returns,
drift-hedged returns, and drift-free trade returns.
"""

from __future__ import annotations

from bisect import bisect_left
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from r4.costs import (
    STUDY_SLIPPAGE_BPS,
    resolve_fee_profile,
    trade_funding,
    trade_net_return,
)

DAY_MS: int = 86_400_000
FIVE_MIN_MS: int = 300_000
INTERVAL_MS: dict[str, int] = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "6h": 21_600_000,
    "8h": 28_800_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
}


def parse_interval_ms(interval: str | int) -> int:
    """Convert an interval string like '1h' or '4h' to milliseconds."""
    if isinstance(interval, (int, np.integer)):
        return int(interval)
    if interval in INTERVAL_MS:
        return INTERVAL_MS[interval]
    raise ValueError(f"Unknown interval: {interval}")


@dataclass(frozen=True)
class Tranche:
    """A position tranche on a single coin."""

    symbol: str
    side: int | str
    entry_ms: int
    exit_ms: int
    entry_price: float
    exit_price: float
    interval: str | int
    h_ms: int
    size: float = 1.0
    entry_fill: str = "taker"
    exit_fill: str = "taker"
    exit_reason: str = "horizon"
    entry_reason: str = "open"

    @property
    def entry_priced(self) -> bool:
        """True when the entry fills at its own entry_price rather than at the 5m open at entry_ms."""
        return self.entry_reason != "open"

    @property
    def exit_priced(self) -> bool:
        """True when the exit fills at its own exit_price (stop, take-profit, model close), not the horizon open."""
        return self.exit_reason != "horizon"

    @property
    def side_val(self) -> int:
        if self.side in (1, +1, "long", "buy"):
            return 1
        if self.side in (-1, "short", "sell"):
            return -1
        raise ValueError(f"Unknown side: {self.side}")

    @property
    def interval_str(self) -> str:
        if isinstance(self.interval, str):
            return self.interval
        for k, v in INTERVAL_MS.items():
            if v == self.interval:
                return k
        return str(self.interval)

    @property
    def interval_ms(self) -> int:
        return parse_interval_ms(self.interval)

    @property
    def weight(self) -> float:
        """Fraction of total equity: side * size / (h_ms / interval_ms) / 10."""
        bars = float(self.h_ms) / float(self.interval_ms)
        return (self.side_val * float(self.size) / bars) / 10.0


def _coerce_tranches(
    tranches: pd.DataFrame | Sequence[dict[str, Any] | Tranche | Any],
) -> list[Tranche]:
    """Coerce various representations of tranches to a list of Tranche instances."""
    if isinstance(tranches, pd.DataFrame):
        rows: list[Tranche] = []
        for _, row in tranches.iterrows():
            rows.append(
                Tranche(
                    symbol=str(row["symbol"]),
                    side=row["side"],
                    entry_ms=int(row["entry_ms"]),
                    exit_ms=int(row["exit_ms"]),
                    entry_price=float(row["entry_price"]),
                    exit_price=float(row["exit_price"]),
                    interval=row["interval"],
                    h_ms=int(row["h_ms"]),
                    size=float(row["size"]) if "size" in row and pd.notna(row["size"]) else 1.0,
                    entry_fill=str(row["entry_fill"])
                    if "entry_fill" in row and pd.notna(row["entry_fill"])
                    else "taker",
                    exit_fill=str(row["exit_fill"]) if "exit_fill" in row and pd.notna(row["exit_fill"]) else "taker",
                    exit_reason=str(row["exit_reason"])
                    if "exit_reason" in row and pd.notna(row["exit_reason"])
                    else "horizon",
                    entry_reason=str(row["entry_reason"])
                    if "entry_reason" in row and pd.notna(row["entry_reason"])
                    else "open",
                )
            )
        return rows

    out: list[Tranche] = []
    for item in tranches:
        if isinstance(item, Tranche):
            out.append(item)
        elif isinstance(item, dict):
            out.append(
                Tranche(
                    symbol=str(item["symbol"]),
                    side=item["side"],
                    entry_ms=int(item["entry_ms"]),
                    exit_ms=int(item["exit_ms"]),
                    entry_price=float(item["entry_price"]),
                    exit_price=float(item["exit_price"]),
                    interval=item["interval"],
                    h_ms=int(item["h_ms"]),
                    size=float(item.get("size", 1.0)),
                    entry_fill=str(item.get("entry_fill", "taker")),
                    exit_fill=str(item.get("exit_fill", "taker")),
                    exit_reason=str(item.get("exit_reason", "horizon")),
                    entry_reason=str(item.get("entry_reason", "open")),
                )
            )
        else:
            out.append(
                Tranche(
                    symbol=str(item.symbol),
                    side=item.side,
                    entry_ms=int(item.entry_ms),
                    exit_ms=int(item.exit_ms),
                    entry_price=float(item.entry_price),
                    exit_price=float(item.exit_price),
                    interval=item.interval,
                    h_ms=int(item.h_ms),
                    size=float(getattr(item, "size", 1.0)),
                    entry_fill=str(getattr(item, "entry_fill", "taker")),
                    exit_fill=str(getattr(item, "exit_fill", "taker")),
                    exit_reason=str(getattr(item, "exit_reason", "horizon")),
                    entry_reason=str(getattr(item, "entry_reason", "open")),
                )
            )
    return out


def _extract_settlement_record(s: Any) -> tuple[int, float]:
    if isinstance(s, dict):
        return int(s["t"]), float(s["rate"])
    if isinstance(s, (tuple, list)):
        return int(s[0]), float(s[1])
    return int(s.t), float(s.rate)


def _extract_settlements_arrays(
    data: pd.DataFrame | Sequence[Any] | None,
) -> tuple[np.ndarray, np.ndarray]:
    if data is None:
        return np.array([], dtype=np.int64), np.array([], dtype=np.float64)
    if isinstance(data, pd.DataFrame):
        if data.empty:
            return np.array([], dtype=np.int64), np.array([], dtype=np.float64)
        times = data["t"].to_numpy(dtype=np.int64)
        rates = data["rate"].to_numpy(dtype=np.float64)
        order = np.argsort(times)
        return times[order], rates[order]
    if not data:
        return np.array([], dtype=np.int64), np.array([], dtype=np.float64)
    parsed = [_extract_settlement_record(x) for x in data]
    parsed.sort(key=lambda x: x[0])
    times = np.array([x[0] for x in parsed], dtype=np.int64)
    rates = np.array([x[1] for x in parsed], dtype=np.float64)
    return times, rates


def _extract_settlements_for_symbol(
    settlements: Any,
    symbol: str,
) -> tuple[np.ndarray, np.ndarray]:
    if settlements is None:
        return np.array([], dtype=np.int64), np.array([], dtype=np.float64)
    if isinstance(settlements, dict):
        sym_settle = settlements.get(symbol)
        return _extract_settlements_arrays(sym_settle)
    if isinstance(settlements, pd.DataFrame):
        if "symbol" in settlements.columns:
            subset = settlements[settlements["symbol"] == symbol]
            return _extract_settlements_arrays(subset)
        return _extract_settlements_arrays(settlements)
    return _extract_settlements_arrays(settlements)


class FiveMinLookup:
    """Lookup and carry-forward for 5m open prices."""

    def __init__(self, five_min: dict[str, pd.DataFrame]) -> None:
        self._symbols: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        for sym, df in five_min.items():
            if "t" in df.columns and "o" in df.columns:
                times = df["t"].to_numpy(dtype=np.int64)
                opens = df["o"].to_numpy(dtype=np.float64)
            elif df.index.name == "t" and "o" in df.columns:
                times = df.index.to_numpy(dtype=np.int64)
                opens = df["o"].to_numpy(dtype=np.float64)
            else:
                times = df.iloc[:, 0].to_numpy(dtype=np.int64)
                opens = df.iloc[:, 1].to_numpy(dtype=np.float64)
            if len(times) < 2 or np.all(times[1:] > times[:-1]):
                self._symbols[sym] = (times, opens)
            else:
                # Retain argsort's existing tie ordering for duplicate timestamps.
                order = np.argsort(times)
                self._symbols[sym] = (times[order], opens[order])

    def has_symbol(self, symbol: str) -> bool:
        return symbol in self._symbols

    def get_exact_open(self, symbol: str, timestamp_ms: int) -> float | None:
        """Return exact open at timestamp_ms, or None if missing."""
        if symbol not in self._symbols:
            return None
        times, opens = self._symbols[symbol]
        idx = bisect_left(times, timestamp_ms)
        if idx < len(times) and times[idx] == timestamp_ms:
            return float(opens[idx])
        return None

    def get_open_or_carry(self, symbol: str, timestamp_ms: int) -> tuple[float, bool]:
        """Return (open_price, was_substituted).

        If bar at timestamp_ms exists: (open, False).
        Else if last bar before timestamp_ms exists: (last_open, True).
        Else raises ValueError.
        """
        if symbol not in self._symbols:
            raise ValueError(f"Symbol {symbol} not found in five_min prices")
        times, opens = self._symbols[symbol]
        idx = bisect_left(times, timestamp_ms)
        if idx < len(times) and times[idx] == timestamp_ms:
            return float(opens[idx]), False
        if idx > 0:
            return float(opens[idx - 1]), True
        raise ValueError(f"No 5m bar found at or before {timestamp_ms} for symbol {symbol}")


def _tranches_by_day(tranches: Sequence[Tranche]) -> dict[int, list[Tranche]]:
    """Bucket intersecting UTC days while retaining input accumulation order."""
    by_day: dict[int, list[Tranche]] = {}
    for tranche in tranches:
        start_day = (tranche.entry_ms // DAY_MS) * DAY_MS
        end_day = ((tranche.exit_ms - 1) // DAY_MS) * DAY_MS
        for day in range(start_day, end_day + DAY_MS, DAY_MS):
            by_day.setdefault(day, []).append(tranche)
    return by_day


def daily_book(
    tranches: pd.DataFrame | Sequence[dict[str, Any] | Tranche | Any],
    five_min: dict[str, pd.DataFrame],
    settlements: Any,
    profile: str = "standard",
) -> pd.DataFrame:
    """Compute daily mark-to-market book returns per UTC day.

    Returns a DataFrame indexed by UTC day start (ms) with:
      gross, costs, funding, net, net_weight_start, n_open, substitutions.
    Days with no open tranche are omitted.
    """
    tranche_list = _coerce_tranches(tranches)
    columns = [
        "gross",
        "costs",
        "fees",
        "slippage",
        "funding",
        "net",
        "net_weight_start",
        "n_open",
        "substitutions",
    ]
    if not tranche_list:
        df_empty = pd.DataFrame(columns=columns)
        df_empty.index.name = "day_start"
        return df_empty

    lookup = FiveMinLookup(five_min)

    unique_symbols = {t.symbol for t in tranche_list}
    symbol_funding: dict[str, tuple[np.ndarray, np.ndarray]] = {
        sym: _extract_settlements_for_symbol(settlements, sym) for sym in unique_symbols
    }

    day_tranches = _tranches_by_day(tranche_list)
    sorted_days = sorted(day_tranches)
    records: list[dict[str, Any]] = []

    for d_start in sorted_days:
        d_end = d_start + DAY_MS

        open_tranches = day_tranches[d_start]

        n_open = len(open_tranches)
        net_weight_start = sum(t.weight for t in open_tranches if t.entry_ms < d_start < t.exit_ms)

        gross = 0.0
        day_fees = 0.0
        day_slippage = 0.0
        funding = 0.0
        substituted_midnights: set[tuple[str, int]] = set()

        for t in open_tranches:
            w = t.weight

            if t.entry_ms >= d_start:
                p_start = t.entry_price
            else:
                p_start, was_sub = lookup.get_open_or_carry(t.symbol, d_start)
                if was_sub:
                    substituted_midnights.add((t.symbol, d_start))

            if t.exit_ms <= d_end:
                p_end = t.exit_price
            else:
                p_end, was_sub = lookup.get_open_or_carry(t.symbol, d_end)
                if was_sub:
                    substituted_midnights.add((t.symbol, d_end))

            in_day_log_ret = float(np.log(p_end / p_start))
            gross += w * in_day_log_ret

            fees = resolve_fee_profile(profile, t.symbol)
            slip_bps = STUDY_SLIPPAGE_BPS.get(t.interval_str)
            if slip_bps is None:
                raise ValueError(f"No slippage configured for interval: {t.interval_str}")
            slip_rate = slip_bps / 10000.0

            if d_start <= t.entry_ms < d_end:
                fee_in = fees.maker_fee if t.entry_fill == "maker" else fees.taker_fee
                slip_in = slip_rate if t.entry_fill == "taker" else 0.0
                day_fees += abs(w) * fee_in
                day_slippage += abs(w) * slip_in

            if d_start < t.exit_ms <= d_end:
                fee_out = fees.maker_fee if t.exit_fill == "maker" else fees.taker_fee
                slip_out = slip_rate if t.exit_fill == "taker" else 0.0
                day_fees += abs(w) * fee_out
                day_slippage += abs(w) * slip_out

            s_times, s_rates = symbol_funding[t.symbol]
            if len(s_times) > 0:
                left = int(np.searchsorted(s_times, max(d_start, t.entry_ms), side="right"))
                right = int(np.searchsorted(s_times, min(d_end, t.exit_ms), side="right"))
                if left < right:
                    funding += float(np.sum(-w * s_rates[left:right]))

        costs = day_fees + day_slippage
        net = gross - costs + funding
        records.append(
            {
                "day_start": d_start,
                "gross": gross,
                "costs": costs,
                "fees": day_fees,
                "slippage": day_slippage,
                "funding": funding,
                "net": net,
                "net_weight_start": net_weight_start,
                "n_open": n_open,
                "substitutions": len(substituted_midnights),
            }
        )

    if not records:
        df_empty = pd.DataFrame(columns=columns)
        df_empty.index.name = "day_start"
        return df_empty

    df_out = pd.DataFrame.from_records(records, index="day_start")
    return df_out[columns]


def equal_weight_market(
    five_min: dict[str, pd.DataFrame],
    days: Sequence[int] | pd.Index,
    universe: Sequence[str],
    carry_forward: bool = False,
) -> pd.DataFrame:
    """Compute equal-weight market log return per day over universe.

    For each day, the mean over the coins in universe of:
        log(open at the next 00:00 / open at 00:00)
    NaN if a coin is missing (then the mean is over the coins present,
    with their count recorded).
    """
    lookup = FiveMinLookup(five_min)
    records: list[dict[str, Any]] = []

    for d in days:
        d_start = int(d)
        d_end = d_start + DAY_MS
        coin_returns: list[float] = []

        for sym in universe:
            if not lookup.has_symbol(sym):
                continue
            if carry_forward:
                try:
                    o_start, _ = lookup.get_open_or_carry(sym, d_start)
                    o_end, _ = lookup.get_open_or_carry(sym, d_end)
                    coin_returns.append(float(np.log(o_end / o_start)))
                except ValueError:
                    pass
            else:
                o_start = lookup.get_exact_open(sym, d_start)
                o_end = lookup.get_exact_open(sym, d_end)
                if o_start is not None and o_end is not None and o_start > 0 and o_end > 0:
                    coin_returns.append(float(np.log(o_end / o_start)))

        n_coins = len(coin_returns)
        market_val = float(np.mean(coin_returns)) if n_coins > 0 else float("nan")
        records.append(
            {
                "day_start": d_start,
                "market": market_val,
                "n_coins": n_coins,
            }
        )

    df_out = pd.DataFrame.from_records(records, index="day_start")
    return df_out


def daily_close_log_returns(
    five_min: dict[str, pd.DataFrame],
    days: Sequence[int] | pd.Index,
    universe: Sequence[str],
) -> pd.DataFrame:
    """Compute daily close log returns for each coin and each UTC day.

    For each coin and each UTC day, log(open at the next 00:00 / open at 00:00)
    from the 5m bars. NaN where missing. Returns a days by coins DataFrame.
    """
    lookup = FiveMinLookup(five_min)
    days_list = [int(d) for d in days]
    data: dict[str, list[float]] = {coin: [] for coin in universe}

    for d_start in days_list:
        d_end = d_start + DAY_MS
        for coin in universe:
            if not lookup.has_symbol(coin):
                data[coin].append(np.nan)
                continue
            o_start = lookup.get_exact_open(coin, d_start)
            o_end = lookup.get_exact_open(coin, d_end)
            if o_start is not None and o_end is not None and o_start > 0 and o_end > 0:
                data[coin].append(float(np.log(o_end / o_start)))
            else:
                data[coin].append(np.nan)

    df_out = pd.DataFrame(data, index=pd.Index(days_list, name="day_start"))
    return df_out


def estimate_betas(
    daily_returns: pd.DataFrame,
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> dict[str, float]:
    """Estimate per-coin OLS beta on equal-weight daily mean over [start_ms, end_ms).

    - per coin, the OLS slope (with intercept) of its daily log return on the row mean
      of all coins daily log returns, over days in [start_ms, end_ms).
    - only days where the coin and at least 5 other coins are present count.
    - fewer than 60 valid days gives NaN for that coin.
    Returns a dict mapping symbol to estimated beta slope.
    """
    df_window = daily_returns
    if start_ms is not None:
        df_window = df_window.loc[df_window.index >= start_ms]
    if end_ms is not None:
        df_window = df_window.loc[df_window.index < end_ms]

    betas: dict[str, float] = {}
    coins = list(daily_returns.columns)
    if df_window.empty or len(coins) == 0:
        return {coin: float("nan") for coin in coins}

    row_means = df_window.mean(axis=1, skipna=True)
    row_counts = df_window.notna().sum(axis=1)

    for coin in coins:
        series_coin = df_window[coin]
        valid_mask = series_coin.notna() & (row_counts >= 6)
        n_valid = int(valid_mask.sum())
        if n_valid < 60:
            betas[coin] = float("nan")
            continue

        y = series_coin.loc[valid_mask].to_numpy(dtype=np.float64)
        x = row_means.loc[valid_mask].to_numpy(dtype=np.float64)

        var_x = float(np.var(x, ddof=1))
        if var_x <= 0.0 or np.isnan(var_x):
            betas[coin] = float("nan")
            continue

        cov_xy = float(np.cov(x, y)[0, 1])
        betas[coin] = cov_xy / var_x

    return betas


def beta_hedged_daily(
    tranches: pd.DataFrame | Sequence[dict[str, Any] | Tranche | Any],
    five_min: dict[str, pd.DataFrame],
    settlements: Any,
    betas: dict[str, float],
    universe: Sequence[str],
    profile: str = "standard",
) -> pd.DataFrame:
    """Compute beta-hedged drift-free daily returns per UTC day.

    For every tranche and every UTC day it is open, split the tranche part
    inside the day at [start, end] (entry or 00:00, exit or the next 00:00).

    r_coin = log(P(end) / P(start)) from the coin 5m opens.
    r_EW is the mean over universe coins of log(P_j(end) / P_j(start)) over the SAME
    [start, end], using each coin 5m opens at those instants, over the coins present.

    Daily D_d = sum w x (r_coin - beta x r_EW) - costs_d + funding_d.
    A tranche whose coin beta is NaN is excluded and counted.

    Returns a DataFrame by day with columns:
      drift_free, gross_hedged, costs, funding, n_open, ew_coins_min, excluded_tranches.
    """
    tranche_list = _coerce_tranches(tranches)
    columns = [
        "drift_free",
        "gross_hedged",
        "costs",
        "fees",
        "slippage",
        "funding",
        "n_open",
        "ew_coins_min",
        "excluded_tranches",
    ]
    if not tranche_list:
        df_empty = pd.DataFrame(columns=columns)
        df_empty.index.name = "day_start"
        return df_empty

    lookup = FiveMinLookup(five_min)
    ew_cache: dict[tuple[int, int], tuple[float, int]] = {}

    unique_symbols = {t.symbol for t in tranche_list}
    symbol_funding: dict[str, tuple[np.ndarray, np.ndarray]] = {
        sym: _extract_settlements_for_symbol(settlements, sym) for sym in unique_symbols
    }

    day_tranches = _tranches_by_day(tranche_list)
    sorted_days = sorted(day_tranches)
    records: list[dict[str, Any]] = []

    for d_start in sorted_days:
        d_end = d_start + DAY_MS

        open_tranches = day_tranches[d_start]

        n_open = 0
        excluded_tranches = 0
        gross_hedged = 0.0
        day_fees = 0.0
        day_slippage = 0.0
        funding = 0.0
        ew_coins_counts: list[int] = []

        for t in open_tranches:
            beta = betas.get(t.symbol, float("nan"))
            if beta is None or np.isnan(beta):
                excluded_tranches += 1
                continue

            n_open += 1
            w = t.weight
            start = max(t.entry_ms, d_start)
            end = min(t.exit_ms, d_end)

            if start == t.entry_ms and t.entry_priced:
                p_start = t.entry_price
            else:
                p_start = lookup.get_exact_open(t.symbol, start)
                if p_start is None:
                    if start == t.entry_ms:
                        p_start = t.entry_price
                    else:
                        p_start, _ = lookup.get_open_or_carry(t.symbol, start)

            # A priced exit closes the position at t = exit_ms, so the coin leg ends there, and the basket
            # hedge runs to the next 5m boundary at or after t (grid instants only). The coin leg's part
            # from t to that boundary is zero.
            hedge_end = end
            if end == t.exit_ms and t.exit_priced:
                p_end = t.exit_price
                hedge_end = -(-end // FIVE_MIN_MS) * FIVE_MIN_MS
            else:
                p_end = lookup.get_exact_open(t.symbol, end)
                if p_end is None:
                    if end == t.exit_ms:
                        p_end = t.exit_price
                    else:
                        p_end, _ = lookup.get_open_or_carry(t.symbol, end)

            r_coin = float(np.log(p_end / p_start))

            boundary = (start, hedge_end)
            if boundary not in ew_cache:
                ew_returns: list[float] = []
                for u_coin in universe:
                    u_p_start = lookup.get_exact_open(u_coin, start)
                    u_p_end = lookup.get_exact_open(u_coin, hedge_end)
                    if u_p_start is not None and u_p_end is not None and u_p_start > 0 and u_p_end > 0:
                        ew_returns.append(float(np.log(u_p_end / u_p_start)))
                n_present = len(ew_returns)
                if n_present == 0:
                    raise ValueError(
                        f"No basket coin has 5m opens at both ends of the interval [{start}, {hedge_end}] "
                        f"for {t.symbol}, so r_EW is undefined"
                    )
                ew_cache[boundary] = (float(np.mean(ew_returns)), n_present)
            r_ew, n_present = ew_cache[boundary]
            ew_coins_counts.append(n_present)

            gross_hedged += w * (r_coin - beta * r_ew)

            fees = resolve_fee_profile(profile, t.symbol)
            slip_bps = STUDY_SLIPPAGE_BPS.get(t.interval_str)
            if slip_bps is None:
                raise ValueError(f"No slippage configured for interval: {t.interval_str}")
            slip_rate = slip_bps / 10000.0

            if d_start <= t.entry_ms < d_end:
                fee_in = fees.maker_fee if t.entry_fill == "maker" else fees.taker_fee
                slip_in = slip_rate if t.entry_fill == "taker" else 0.0
                day_fees += abs(w) * fee_in
                day_slippage += abs(w) * slip_in

            if d_start < t.exit_ms <= d_end:
                fee_out = fees.maker_fee if t.exit_fill == "maker" else fees.taker_fee
                slip_out = slip_rate if t.exit_fill == "taker" else 0.0
                day_fees += abs(w) * fee_out
                day_slippage += abs(w) * slip_out

            s_times, s_rates = symbol_funding[t.symbol]
            if len(s_times) > 0:
                left = int(np.searchsorted(s_times, max(d_start, t.entry_ms), side="right"))
                right = int(np.searchsorted(s_times, min(d_end, t.exit_ms), side="right"))
                if left < right:
                    funding += float(np.sum(-w * s_rates[left:right]))

        costs = day_fees + day_slippage
        drift_free = gross_hedged - costs + funding
        ew_coins_min = min(ew_coins_counts) if ew_coins_counts else 0

        records.append(
            {
                "day_start": d_start,
                "drift_free": drift_free,
                "gross_hedged": gross_hedged,
                "costs": costs,
                "fees": day_fees,
                "slippage": day_slippage,
                "funding": funding,
                "n_open": n_open,
                "ew_coins_min": ew_coins_min,
                "excluded_tranches": excluded_tranches,
            }
        )

    if not records:
        df_empty = pd.DataFrame(columns=columns)
        df_empty.index.name = "day_start"
        return df_empty

    df_out = pd.DataFrame.from_records(records, index="day_start")
    return df_out[columns]


def daily_series(
    frame: pd.DataFrame,
    column: str,
    span_start_ms: int,
    span_end_ms: int,
) -> pd.DataFrame:
    """Reindex to every UTC day in [span_start, span_end).

    Days with no row are filled with 0.0, and a boolean 'bet' column
    flags days where a row existed in frame.
    """
    first_day = (span_start_ms // DAY_MS) * DAY_MS
    if first_day < span_start_ms:
        first_day += DAY_MS
    span_days = [d for d in range(first_day, span_end_ms, DAY_MS)]

    index_name = frame.index.name if frame.index.name else "day_start"
    idx = pd.Index(span_days, name=index_name)

    if frame.empty or column not in frame.columns:
        return pd.DataFrame(
            {
                column: np.zeros(len(span_days), dtype=np.float64),
                "bet": np.zeros(len(span_days), dtype=bool),
            },
            index=idx,
        )

    series_col = frame[column].reindex(idx).fillna(0.0).astype(float)
    bet_series = idx.isin(frame.index)

    return pd.DataFrame(
        {
            column: series_col,
            "bet": bet_series,
        },
        index=idx,
    )


def trade_level(
    tranches: pd.DataFrame | Sequence[dict[str, Any] | Tranche | Any],
    settlements: Any,
    coin_mean_hourly: dict[str, float] | float | None = None,
    profile: str = "standard",
) -> pd.DataFrame:
    """Per-tranche net return and hold in hours, plus drift-free return if coin_mean_hourly given."""
    tranche_list = _coerce_tranches(tranches)
    if not tranche_list:
        cols = ["net_return", "hold_hours"]
        if coin_mean_hourly is not None:
            cols.append("drift_free_return")
        return pd.DataFrame(columns=cols)

    unique_symbols = {t.symbol for t in tranche_list}
    symbol_funding: dict[str, tuple[np.ndarray, np.ndarray]] = {
        sym: _extract_settlements_for_symbol(settlements, sym) for sym in unique_symbols
    }

    records: list[dict[str, Any]] = []
    for t in tranche_list:
        hold_hours = (t.exit_ms - t.entry_ms) / 3_600_000.0
        s_times, s_rates = symbol_funding[t.symbol]
        funding_sum = trade_funding(s_times, s_rates, t.entry_ms, t.exit_ms)

        net_ret = trade_net_return(
            side=t.side,
            entry_price=t.entry_price,
            exit_price=t.exit_price,
            funding_sum=funding_sum,
            interval=t.interval_str,
            entry_fill=t.entry_fill,
            exit_fill=t.exit_fill,
            profile=profile,
            symbol=t.symbol,
        )

        rec: dict[str, Any] = {
            "net_return": net_ret,
            "hold_hours": hold_hours,
        }

        if coin_mean_hourly is not None:
            if isinstance(coin_mean_hourly, dict):
                m = coin_mean_hourly.get(t.symbol, 0.0)
            else:
                m = float(coin_mean_hourly)

            fees = resolve_fee_profile(profile, t.symbol)
            fee_in = fees.maker_fee if t.entry_fill == "maker" else fees.taker_fee
            fee_out = fees.maker_fee if t.exit_fill == "maker" else fees.taker_fee

            slip_bps = STUDY_SLIPPAGE_BPS.get(t.interval_str)
            if slip_bps is None:
                raise ValueError(f"No slippage configured for interval: {t.interval_str}")
            slip_rate = slip_bps / 10000.0
            slip_in = slip_rate if t.entry_fill == "taker" else 0.0
            slip_out = slip_rate if t.exit_fill == "taker" else 0.0

            costs = fee_in + fee_out + slip_in + slip_out
            signed_funding = t.side_val * funding_sum
            gross_log = float(np.log(t.exit_price / t.entry_price))

            drift_free = t.side_val * (gross_log - m * hold_hours) - costs - signed_funding
            rec["drift_free_return"] = drift_free

        records.append(rec)

    idx = tranches.index if isinstance(tranches, pd.DataFrame) else None
    return pd.DataFrame(records, index=idx)
