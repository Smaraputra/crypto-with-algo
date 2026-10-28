"""$100-account execution layer. REPORT ONLY: nothing here gates, selects or is read by r4.bar.

The research book is scale-free (weights are fractions of equity, fills have no lot or minimum). On a small
account those constraints bind. This module replays a run's tranches on a $100 account at a chosen leverage
with lot sizes, minimum notionals, maintenance margin and liquidation, and reports how far the account
drifts from the research book.

Disclosed assumptions:
- FILTERS are today's Binance USDT-M filters (fapi/v1/exchangeInfo, fetched 2026-10-28). Historical filters are
  not in the dataset, so historical prices are used with today's filters.
- MMR is the maintenance margin rate of the smallest bracket. The bracket endpoint needs an API key, so it is a
  declared assumption. LIQ_FEE is a declared fraction of the liquidated notional.
- A close to zero is always allowed (reduce-only), whatever its notional. A partial reduction is not.
- Every order at an instant uses the equity marked at that instant before any of its fills.
- A coin's orders at one instant are netted. They fill as maker (at the level of the largest leg) only when every
  leg is maker, else as a taker at the 5m open plus or minus the coin slippage.
- Cross margin: equity is cash plus the unrealised PnL of all positions, and one maintenance requirement covers
  the whole account.
- After a liquidation the account is bust and the simulation stops. The bust day's log return uses the equity
  after liquidation, floored at BUST_FLOOR so the logarithm stays finite.
- The zero-position share counts, per coin, the days on which the research book holds the coin at the day's end
  but the account holds none.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple

import numpy as np
import pandas as pd

from r4.book import (
    DAY_MS,
    FIVE_MIN_MS,
    FiveMinLookup,
    _coerce_tranches,
    _extract_settlements_for_symbol,
    daily_book,
)
from r4.costs import apply_slippage, coin_slippage_bps, resolve_fee_profile


class SymbolFilter(NamedTuple):
    step: float  # LOT_SIZE stepSize
    min_qty: float  # LOT_SIZE minQty
    min_notional: float  # MIN_NOTIONAL, in USDT


# Source: fapi/v1/exchangeInfo, fetched 2026-10-28. Today's filters, applied to historical prices (disclosed).
FILTERS: dict[str, SymbolFilter] = {
    "BTCUSDT": SymbolFilter(0.001, 0.001, 50.0),
    "ETHUSDT": SymbolFilter(0.001, 0.001, 20.0),
    "LINKUSDT": SymbolFilter(0.01, 0.01, 20.0),
    "BNBUSDT": SymbolFilter(0.01, 0.01, 5.0),
    "AVAXUSDT": SymbolFilter(1.0, 1.0, 5.0),
    "SOLUSDT": SymbolFilter(0.01, 0.01, 5.0),
    "XRPUSDT": SymbolFilter(0.1, 0.1, 5.0),
    "ADAUSDT": SymbolFilter(1.0, 1.0, 5.0),
    "DOGEUSDT": SymbolFilter(1.0, 1.0, 5.0),
    "DOTUSDT": SymbolFilter(0.1, 0.1, 5.0),
}

# Maintenance margin rate of the smallest notional bracket (declared assumption: the bracket endpoint needs a key).
MMR: dict[str, float] = {
    "BTCUSDT": 0.005,
    "ETHUSDT": 0.005,
    "BNBUSDT": 0.01,
    "SOLUSDT": 0.01,
    "XRPUSDT": 0.01,
    "ADAUSDT": 0.01,
    "DOGEUSDT": 0.01,
    "AVAXUSDT": 0.01,
    "DOTUSDT": 0.01,
    "LINKUSDT": 0.01,
}

# Liquidation fee as a fraction of the liquidated notional (declared assumption).
LIQ_FEE: float = 0.005

BUST_FLOOR: float = 0.01
EPS_W: float = 1e-12
DEFAULT_LEVERAGES: tuple[int, ...] = (10, 20, 50)
ACCOUNT_FILE: str = "account_100.json"
BARS_PER_DAY: int = DAY_MS // FIVE_MIN_MS

DISCLOSURES: tuple[str, ...] = (
    "REPORT ONLY: never a gate, never read by the exploration bar.",
    "Filters are today's (fapi/v1/exchangeInfo, 2026-10-28) applied to historical prices.",
    "MMR is the smallest-bracket rate, a declared assumption (the bracket endpoint needs an API key).",
    "LIQ_FEE is a declared 0.5% of the liquidated notional.",
    "Closing to zero is always allowed (reduce-only), partial reductions below the minimum are skipped.",
    "Orders per coin and instant are netted, sized with the equity marked before the instant's fills.",
    "Cross margin, one maintenance requirement for the account, liquidation stops the simulation (bust).",
)


@dataclass
class AccountResult:
    """Output of simulate_account. funding is a net PnL (negative means paid)."""

    equity0: float
    leverage: float
    profile: str
    daily: pd.DataFrame
    fills: pd.DataFrame
    orders_total: int
    orders_skipped: int
    orders_closes: int
    fees: float
    slippage_cost: float
    funding: float
    liquidation: dict[str, Any] | None
    tracking: dict[str, float | int | None]
    zero_position_share: dict[str, float | None]
    final_equity: float = field(default=float("nan"))

    @property
    def orders_executed(self) -> int:
        return self.orders_total - self.orders_skipped

    def summary(self, include_daily: bool = True) -> dict[str, Any]:
        log_ret = self.daily["log_return"].to_numpy(dtype=np.float64) if len(self.daily) else np.zeros(0)
        total = float(log_ret.sum()) if len(log_ret) else 0.0
        equity = self.daily["equity"].to_numpy(dtype=np.float64) if len(self.daily) else np.zeros(0)
        curve = np.concatenate(([self.equity0], equity))
        peak = np.maximum.accumulate(curve)
        max_dd = float(np.max(1.0 - curve / peak)) if len(curve) else 0.0
        out: dict[str, Any] = {
            "leverage": self.leverage,
            "equity0": self.equity0,
            "final_equity": self.final_equity,
            "total_log_return": total,
            "mean_daily_log_return": float(log_ret.mean()) if len(log_ret) else 0.0,
            "sd_daily_log_return": float(log_ret.std(ddof=1)) if len(log_ret) > 1 else 0.0,
            "max_drawdown": max_dd,
            "n_days": int(len(self.daily)),
            "orders_total": self.orders_total,
            "orders_skipped": self.orders_skipped,
            "orders_closes": self.orders_closes,
            "orders_executed": self.orders_executed,
            "fees": self.fees,
            "slippage_cost": self.slippage_cost,
            "funding": self.funding,
            "liquidation": self.liquidation,
            "bust": self.liquidation is not None,
            "zero_position_share": self.zero_position_share,
            "tracking_mean_daily": self.tracking["mean_daily"],
            "tracking": self.tracking,
        }
        if include_daily:
            out["daily"] = {
                "day_start": [int(x) for x in self.daily.index],
                "equity": [float(x) for x in self.daily["equity"]],
                "log_return": [float(x) for x in self.daily["log_return"]],
            }
        return out


def _grid_prices(five_min: dict[str, pd.DataFrame], symbols: list[str], t0: int, n: int) -> np.ndarray:
    """5m open matrix (n x symbols) on the grid t0 + k x 5m, carrying the last open forward over gaps."""
    lookup = FiveMinLookup(five_min)
    out = np.empty((n, len(symbols)), dtype=np.float64)
    for j, sym in enumerate(symbols):
        if not lookup.has_symbol(sym):
            raise ValueError(f"No 5m prices for {sym}")
        times, opens = lookup._symbols[sym]
        col = np.full(n, np.nan)
        idx = (times - t0) // FIVE_MIN_MS
        keep = (idx >= 0) & (idx < n) & ((times - t0) % FIVE_MIN_MS == 0)
        col[idx[keep]] = opens[keep]
        if np.isnan(col[0]):
            prior = np.nonzero(times <= t0)[0]
            col[0] = opens[prior[-1]] if len(prior) else opens[0]
        valid = ~np.isnan(col)
        last = np.maximum.accumulate(np.where(valid, np.arange(n), 0))
        out[:, j] = col[last]
    return out


def _research_daily(tranches: Any, five_min: dict[str, pd.DataFrame], settlements: Any, profile: str) -> pd.DataFrame:
    return daily_book(tranches, five_min, settlements, profile)


def simulate_account(
    tranches: Any,
    five_min: dict[str, pd.DataFrame],
    settlements: Any,
    equity0: float = 100.0,
    leverage: float = 10,
    profile: str = "standard",
    research_daily: pd.DataFrame | None = None,
) -> AccountResult:
    """Replay the research book's tranches on a small account (see the module docstring)."""
    tr = _coerce_tranches(tranches)
    if not tr:
        raise ValueError("simulate_account needs at least one tranche")
    symbols = sorted({t.symbol for t in tr})
    for sym in symbols:
        if sym not in FILTERS or sym not in MMR:
            raise ValueError(f"No exchange filters configured for symbol: {sym}")
    sidx = {s: i for i, s in enumerate(symbols)}
    n_sym = len(symbols)

    filt = [FILTERS[s] for s in symbols]
    step = np.array([f.step for f in filt])
    min_qty = np.array([f.min_qty for f in filt])
    min_notional = np.array([f.min_notional for f in filt])
    mmr = np.array([MMR[s] for s in symbols])
    slip_bps = np.array([coin_slippage_bps(s) for s in symbols])
    fee_sched = [resolve_fee_profile(profile, s) for s in symbols]
    maker_fee = np.array([f.maker_fee for f in fee_sched])
    taker_fee = np.array([f.taker_fee for f in fee_sched])

    first_ms = min(min(t.entry_ms, t.exit_ms) for t in tr)
    last_ms = max(max(t.entry_ms, t.exit_ms) for t in tr)
    t0 = (first_ms // DAY_MS) * DAY_MS
    t1 = (last_ms // DAY_MS + 1) * DAY_MS
    n_grid = int((t1 - t0) // FIVE_MIN_MS) + 1
    prices = _grid_prices(five_min, symbols, t0, n_grid)

    # Legs: an entry (+w) and an exit (-w) per tranche, aggregated per (grid index, coin).
    weights = np.array([t.weight for t in tr], dtype=np.float64)
    leg_idx = np.concatenate(
        (
            np.array([t.entry_ms for t in tr], dtype=np.int64),
            np.array([t.exit_ms for t in tr], dtype=np.int64),
        )
    )
    leg_idx = (leg_idx - t0) // FIVE_MIN_MS
    legs = pd.DataFrame(
        {
            "idx": leg_idx,
            "sym": np.array([sidx[t.symbol] for t in tr] * 2, dtype=np.int64),
            "dw": np.concatenate((weights, -weights)),
            "maker": np.array([t.entry_fill == "maker" for t in tr] + [t.exit_fill == "maker" for t in tr]),
            "level": np.concatenate(
                (
                    np.array([t.entry_price for t in tr], dtype=np.float64),
                    np.array([t.exit_price for t in tr], dtype=np.float64),
                )
            ),
            "absw": np.abs(np.concatenate((weights, weights))),
        }
    )
    legs["nonmaker"] = (~legs["maker"]).astype(np.int64)
    legs = legs.sort_values(["idx", "sym", "absw"], kind="stable")
    grouped = legs.groupby(["idx", "sym"], sort=True)
    agg = pd.DataFrame(
        {
            "dw": grouped["dw"].sum(),
            "taker_legs": grouped["nonmaker"].sum(),
            "level": grouped["level"].last(),
        }
    ).reset_index()
    ev_idx = agg["idx"].to_numpy()
    ev_sym = agg["sym"].to_numpy()
    ev_dw = agg["dw"].to_numpy()
    ev_maker = agg["taker_legs"].to_numpy() == 0
    ev_level = agg["level"].to_numpy()
    fill_idx_unique, fill_starts = np.unique(ev_idx, return_index=True)
    fill_ends = np.append(fill_starts[1:], len(ev_idx))
    fill_at = {int(i): (int(a), int(b)) for i, a, b in zip(fill_idx_unique, fill_starts, fill_ends, strict=True)}

    # Funding settlements strictly inside the traded span, per coin, as (grid index, rate).
    fund_events: dict[int, list[tuple[int, float]]] = {}
    first_fill = int(fill_idx_unique[0])
    last_fill = int(fill_idx_unique[-1])
    for sym in symbols:
        s_t, s_r = _extract_settlements_for_symbol(settlements, sym)
        for ts, rate in zip(s_t, s_r, strict=True):
            k = int((int(ts) - t0) // FIVE_MIN_MS)
            if first_fill <= k <= last_fill:
                fund_events.setdefault(k, []).append((sidx[sym], float(rate)))

    event_idx = sorted(set(fill_at) | set(fund_events))

    q = np.zeros(n_sym)
    avg = np.zeros(n_sym)
    wcur = np.zeros(n_sym)  # the research book's net weight per coin
    cash = float(equity0)

    fees_total = 0.0
    slip_total = 0.0
    funding_total = 0.0
    orders_total = 0
    orders_skipped = 0
    orders_closes = 0
    fill_rows: list[tuple[int, str, float, float, float, float, str]] = []
    liquidation: dict[str, Any] | None = None

    mid_idx: list[int] = []
    mid_eq: list[float] = []
    zero_days = np.zeros(n_sym, dtype=np.int64)
    research_days = np.zeros(n_sym, dtype=np.int64)

    def midnights_between(a: int, b: int) -> np.ndarray:
        """Grid indices in [a, b) that are UTC midnights."""
        first = -(-a // BARS_PER_DAY) * BARS_PER_DAY
        return np.arange(first, b, BARS_PER_DAY, dtype=np.int64)

    def note_days(count: int) -> None:
        if count:
            held = np.abs(wcur) > EPS_W
            research_days[held] += count
            zero_days[held & (np.abs(q) < 0.5 * step)] += count

    def liquidate(k: int, eq_before: float) -> None:
        nonlocal liquidation, cash
        notional = float(np.sum(np.abs(q) * prices[k]))
        fee = LIQ_FEE * notional
        eq_after = eq_before - fee
        liquidation = {
            "t": int(t0 + k * FIVE_MIN_MS),
            "equity_before": float(eq_before),
            "equity_after": float(eq_after),
            "notional": notional,
            "fee": float(fee),
        }
        q[:] = 0.0
        avg[:] = 0.0
        cash = eq_after

    def scan(a: int, b: int, record: bool) -> bool:
        """Mark grid indices [a, b) under the current state. True when the account was liquidated inside."""
        if b <= a:
            return False
        block = prices[a:b]
        eq = cash + (block - avg) @ q
        maint = block @ (np.abs(q) * mmr)
        hit = np.nonzero(eq <= maint)[0]
        end = b
        if len(hit):
            end = a + int(hit[0])
        if record:
            mids = midnights_between(a, end)
            if len(mids):
                mid_idx.extend(int(m) for m in mids)
                mid_eq.extend(float(x) for x in eq[mids - a])
                note_days(len(mids))
        if len(hit):
            liquidate(end, float(eq[hit[0]]))
            return True
        return False

    # Day 0 starts flat at the first midnight.
    cursor = 0
    bust = False
    for e in event_idx:
        if scan(cursor, e, record=True):
            bust = True
            break
        # 1. funding at e (it belongs to the day that ends at e), then the pre-fill mark
        for j, rate in fund_events.get(e, []):
            pay = -q[j] * prices[e, j] * rate
            cash += pay
            funding_total += pay
        if scan(e, e + 1, record=True):
            bust = True
            break
        # 2. the fills at e
        if e in fill_at:
            a, b = fill_at[e]
            equity_now = float(cash + (prices[e] - avg) @ q)
            for r in range(a, b):
                j = int(ev_sym[r])
                new_w = wcur[j] + ev_dw[r]
                if abs(new_w) < EPS_W:
                    new_w = 0.0
                if abs(new_w - wcur[j]) <= EPS_W:
                    continue
                wcur[j] = new_w
                ref = float(prices[e, j])
                target_abs = math.floor(abs(new_w) * equity_now * leverage / ref / step[j] + 1e-9) * step[j]
                target = math.copysign(round(target_abs, 12), new_w) if target_abs >= min_qty[j] else 0.0
                delta = target - q[j]
                if abs(delta) < 0.5 * step[j]:
                    continue
                orders_total += 1
                if target == 0.0:
                    orders_closes += 1
                elif abs(delta) * ref < min_notional[j]:
                    orders_skipped += 1
                    continue
                if ev_maker[r]:
                    px = float(ev_level[r])
                    rate = float(maker_fee[j])
                    kind = "maker"
                else:
                    px = apply_slippage(ref, "buy" if delta > 0 else "sell", float(slip_bps[j]))
                    rate = float(taker_fee[j])
                    kind = "taker"
                fee = abs(delta) * px * rate
                cash -= fee
                fees_total += fee
                slip_total += abs(delta) * abs(px - ref) if kind == "taker" else 0.0
                # realise PnL on the part that shrinks, then update the average entry
                old = float(q[j])
                newq = old + delta
                if old != 0.0 and (old > 0) != (delta > 0):
                    closed = min(abs(delta), abs(old)) * math.copysign(1.0, old)
                    cash += (px - avg[j]) * closed
                    if abs(newq) < 0.5 * step[j]:
                        newq = 0.0
                        avg[j] = 0.0
                    elif (newq > 0) != (old > 0):
                        avg[j] = px
                else:
                    avg[j] = (avg[j] * abs(old) + px * abs(delta)) / abs(newq)
                q[j] = newq
                fill_rows.append((int(t0 + e * FIVE_MIN_MS), symbols[j], float(delta), px, abs(delta) * px, fee, kind))
            if scan(e, e + 1, record=False):
                bust = True
                break
        cursor = e + 1
    if not bust:
        bust = scan(cursor, n_grid, record=True)

    # Daily equity at midnights, with the bust day closed at the equity after liquidation.
    mid_idx_arr = np.array(mid_idx, dtype=np.int64)
    mid_eq_arr = np.array(mid_eq, dtype=np.float64)
    if liquidation is not None:
        k = (liquidation["t"] - t0) // FIVE_MIN_MS
        end_mid = -(-k // BARS_PER_DAY) * BARS_PER_DAY
        keep = mid_idx_arr < end_mid
        mid_idx_arr = np.append(mid_idx_arr[keep], end_mid)
        mid_eq_arr = np.append(mid_eq_arr[keep], max(liquidation["equity_after"], BUST_FLOOR))
    day_starts = t0 + mid_idx_arr[:-1] * FIVE_MIN_MS
    eq_end = mid_eq_arr[1:]
    eq_start = mid_eq_arr[:-1]
    log_ret = np.log(np.maximum(eq_end, BUST_FLOOR) / np.maximum(eq_start, BUST_FLOOR))
    daily = pd.DataFrame({"equity": eq_end, "log_return": log_ret}, index=pd.Index(day_starts, name="day_start"))

    if research_daily is None:
        research_daily = _research_daily(tranches, five_min, settlements, profile)
    daily["research_net"] = research_daily["net"].reindex(daily.index) if len(research_daily) else np.nan
    daily["tracking"] = daily["log_return"] - leverage * daily["research_net"]
    tr_vals = daily["tracking"].dropna()
    tracking: dict[str, float | int | None] = {
        "n_days": int(len(tr_vals)),
        "mean_daily": float(tr_vals.mean()) if len(tr_vals) else 0.0,
        "rmse_daily": float(np.sqrt((tr_vals**2).mean())) if len(tr_vals) else 0.0,
        "cumulative": float(tr_vals.sum()) if len(tr_vals) else 0.0,
        "account_cumulative": float(daily.loc[tr_vals.index, "log_return"].sum()) if len(tr_vals) else 0.0,
        "research_x_leverage_cumulative": float((leverage * daily.loc[tr_vals.index, "research_net"]).sum())
        if len(tr_vals)
        else 0.0,
    }

    fills = pd.DataFrame(fill_rows, columns=["t", "symbol", "qty", "price", "notional", "fee", "kind"])
    zero_share = {
        s: (float(zero_days[i] / research_days[i]) if research_days[i] > 0 else None) for s, i in sidx.items()
    }
    final_equity = float(daily["equity"].iloc[-1]) if len(daily) else float(equity0)
    return AccountResult(
        equity0=float(equity0),
        leverage=float(leverage),
        profile=profile,
        daily=daily,
        fills=fills,
        orders_total=orders_total,
        orders_skipped=orders_skipped,
        orders_closes=orders_closes,
        fees=fees_total,
        slippage_cost=slip_total,
        funding=funding_total,
        liquidation=liquidation,
        tracking=tracking,
        zero_position_share=zero_share,
        final_equity=final_equity,
    )


def account_report(
    run_dir: str | Path,
    ds_dir: str | Path,
    leverages: tuple[int, ...] = DEFAULT_LEVERAGES,
    equity0: float = 100.0,
    profile: str = "standard",
) -> dict[str, Any]:
    """Run a run's tranches at each leverage and write account_100.json beside its receipt (report only)."""
    from r4.data import load_funding, load_perp

    run_path = Path(run_dir)
    ds_path = Path(ds_dir)
    tranches = pd.read_parquet(run_path / "tranches.parquet")
    symbols = sorted(tranches["symbol"].unique())
    five_min = {s: load_perp(ds_path, s, "5m", series="klines").rows for s in symbols}
    settlements = {s: load_funding(ds_path, s).rows for s in symbols}

    research = _research_daily(tranches, five_min, settlements, profile)
    results: dict[str, Any] = {}
    for lev in leverages:
        res = simulate_account(tranches, five_min, settlements, equity0, lev, profile, research_daily=research)
        results[str(lev)] = res.summary()

    dataset_hash = None
    manifest = ds_path / "manifest.json"
    if manifest.exists():
        dataset_hash = json.loads(manifest.read_text(encoding="utf-8")).get("datasetHash")
    report: dict[str, Any] = {
        "report_only": True,
        "equity0": float(equity0),
        "profile": profile,
        "filters_source": "fapi/v1/exchangeInfo 2026-10-28",
        "filters": {s: f._asdict() for s, f in FILTERS.items() if s in symbols},
        "mmr": {s: MMR[s] for s in symbols},
        "liq_fee": LIQ_FEE,
        "disclosures": list(DISCLOSURES),
        "dataset_hash": dataset_hash,
        "run_dir": str(run_path),
        "n_tranches": int(len(tranches)),
        "leverages": results,
    }
    (run_path / ACCOUNT_FILE).write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report
