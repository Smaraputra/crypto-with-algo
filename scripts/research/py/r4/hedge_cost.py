"""The netted hedge-cost estimate of Amendment 5 (A5.2), beside every item 1 pass.

Over each daily part of its life, a tranche of the run's netting set holds -beta x w / n in each of the n coins of
that part's basket (the coins used for r_EW). The hedge legs are taker fills at 5m opens, never intrabar. A1.1's
netting runs once over the coin legs and the hedge legs together, and H_d is the netted fees and slippage of both
minus those of the coin legs alone, each booked on the UTC day that holds the fill instant. The report gives the mean
of H_d and of D_d - H_d in bps a day, with the cost stress and the maker-as-taker repricing. It never gates.

This module is frozen at C5 (A5.1). It calls frozen code (book.netted_costs, book.Tranche, book.FiveMinLookup)
unchanged.

Not modelled (disclosed in A5.2): hedge drift between fills (no rebalance inside a tranche unless its basket
changes), lot sizes, and maker hedging. Funding of the hedge is already in D_d (A4.1), so D_d - H_d stays an estimate.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4.book import (
    DAY_MS,
    FIVE_MIN_MS,
    FiveMinLookup,
    Tranche,
    _coerce_tranches,
    netted_costs,
)

BPS = 1e4
STRESS_FEE_MULT = 1.5
STRESS_SLIPPAGE_MULT = 2.0


class HedgeLegs(list):
    """The hedge legs, a plain list of Tranche that also remembers the basket size n of each daily part."""

    basket_sizes: list[int]

    def __init__(self, legs: Sequence[Tranche] = (), basket_sizes: Sequence[int] = ()) -> None:
        super().__init__(legs)
        self.basket_sizes = list(basket_sizes)


def hedge_legs(
    tranches: Sequence[Tranche],
    betas: Sequence[float],
    lookup: FiveMinLookup,
    universe: Sequence[str],
) -> HedgeLegs:
    """The hedge legs of a netting set: one taker-in, taker-out Tranche per basket coin per daily part.

    tranches is the run's netting set (finite beta only) and betas[k] is the book's beta for tranches[k]. A part runs
    from max(entry, day start) to min(hedge end, day end), the hedge end being the next 5m boundary at or after the
    exit for a priced exit, else the exit. The basket is the universe coins with an exact 5m open above 0 at both
    ends. Each leg holds -beta x w / n and is never intrabar. A zero hedge weight makes no leg.
    """
    if len(betas) != len(tranches):
        raise ValueError(f"{len(betas)} betas were given for {len(tranches)} tranches")
    legs: list[Tranche] = []
    sizes: list[int] = []
    for t, beta in zip(tranches, betas, strict=True):
        beta = float(beta)
        if not np.isfinite(beta):
            raise ValueError(f"Tranche on {t.symbol} at {t.entry_ms} has a non-finite beta, so it is not in the set")
        w = t.weight
        day = t.entry_ms // DAY_MS * DAY_MS
        while day < t.exit_ms:
            d_end = day + DAY_MS
            start = max(t.entry_ms, day)
            end = min(t.exit_ms, d_end)
            if end <= start:
                day = d_end
                continue
            hedge_end = end
            if end == t.exit_ms and t.exit_priced:
                hedge_end = -(-end // FIVE_MIN_MS) * FIVE_MIN_MS
            opens: list[tuple[str, float, float]] = []
            for coin in universe:
                p0 = lookup.get_exact_open(coin, start)
                p1 = lookup.get_exact_open(coin, hedge_end)
                if p0 is not None and p1 is not None and p0 > 0 and p1 > 0:
                    opens.append((coin, p0, p1))
            if not opens:
                raise ValueError(
                    f"No basket coin has 5m opens at both ends of [{start}, {hedge_end}] for {t.symbol}, "
                    "so the hedge is undefined"
                )
            n = len(opens)
            sizes.append(n)
            hedge_w = -beta * w / n
            if hedge_w != 0.0:
                side = 1 if hedge_w > 0 else -1
                for coin, p0, p1 in opens:
                    legs.append(
                        Tranche(
                            symbol=coin,
                            side=side,
                            entry_ms=start,
                            exit_ms=hedge_end,
                            entry_price=p0,
                            exit_price=p1,
                            interval=t.interval,
                            h_ms=t.h_ms,
                            entry_fill="taker",
                            exit_fill="taker",
                            exit_reason="horizon",
                            weight_override=hedge_w,
                        )
                    )
            day = d_end
    return HedgeLegs(legs, sizes)


def hedge_cost_daily(
    coin_tranches: Sequence[Tranche],
    hedge: Sequence[Tranche],
    profile: str = "standard",
    maker_as_taker: bool = False,
) -> pd.DataFrame:
    """H_d per UTC day: the netted costs of coin and hedge legs together minus those of the coin legs alone.

    Columns fees and slippage are those differences and h is their sum. A day absent from one netting counts 0 there,
    and h may be negative. maker_as_taker reprices every maker leg as taker before both nettings.
    """
    coin_list = list(coin_tranches)
    both = netted_costs(coin_list + list(hedge), profile, maker_as_taker).by_day
    alone = netted_costs(coin_list, profile, maker_as_taker).by_day
    days = both.index.union(alone.index)
    fees = both["fees"].reindex(days, fill_value=0.0) - alone["fees"].reindex(days, fill_value=0.0)
    slippage = both["slippage"].reindex(days, fill_value=0.0) - alone["slippage"].reindex(days, fill_value=0.0)
    out = pd.DataFrame({"fees": fees, "slippage": slippage, "h": fees + slippage}).sort_index()
    out.index.name = "day_start"
    return out.astype(np.float64)


def hedge_cost_report(
    daily: pd.DataFrame,
    coin_tranches: Sequence[Tranche],
    hedge: Sequence[Tranche],
    profile: str = "standard",
) -> dict[str, Any]:
    """The A5.2 estimate over the run's daily index, in bps a day. It reports and never gates.

    Fees and slippage in the daily frame are positive costs inside drift_free (drift_free = gross - costs + funding),
    so the stress of D_d subtracts the extra cost, as cli.stress_metrics does.
    """
    idx = daily.index
    base = hedge_cost_daily(coin_tranches, hedge, profile)
    h = base.reindex(idx, fill_value=0.0)
    d = daily["drift_free"].astype(np.float64)

    stress_h = STRESS_FEE_MULT * h["fees"] + STRESS_SLIPPAGE_MULT * h["slippage"]
    stress_d = (
        d
        - (STRESS_FEE_MULT - 1.0) * daily["fees"].astype(np.float64)
        - (STRESS_SLIPPAGE_MULT - 1.0) * daily["slippage"].astype(np.float64)
    )

    h_mat = hedge_cost_daily(coin_tranches, hedge, profile, maker_as_taker=True).reindex(idx, fill_value=0.0)
    coin_mat = netted_costs(list(coin_tranches), profile, maker_as_taker=True).by_day.reindex(idx, fill_value=0.0)
    d_mat = d + daily["fees"].astype(np.float64) + daily["slippage"].astype(np.float64)
    d_mat = d_mat - coin_mat["fees"] - coin_mat["slippage"]

    sizes = getattr(hedge, "basket_sizes", None)
    return {
        "h_mean": float(h["h"].mean() * BPS),
        "net_mean": float((d - h["h"]).mean() * BPS),
        "stress_h_mean": float(stress_h.mean() * BPS),
        "stress_net_mean": float((stress_d - stress_h).mean() * BPS),
        "mat_h_mean": float(h_mat["h"].mean() * BPS),
        "mat_net_mean": float((d_mat - h_mat["h"]).mean() * BPS),
        "n_days": int(len(idx)),
        "n_hedge_legs": int(len(hedge)),
        "basket_min": int(min(sizes)) if sizes else None,
        "basket_max": int(max(sizes)) if sizes else None,
    }


def _fold_betas(folds: Sequence[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]]]:
    rows = sorted(folds, key=lambda f: int(f["start_ms"]))
    starts = np.array([int(f["start_ms"]) for f in rows], dtype=np.int64)
    ends = np.array([int(f["end_ms"]) for f in rows], dtype=np.int64)
    return starts, ends, rows


def run_hedge_cost(
    run_dir: str | Path,
    panel: dict[str, Any],
    universe: Sequence[str],
    profile: str = "standard",
) -> dict[str, Any]:
    """Read a run's tranches.parquet, folds.json and daily.parquet and return the A5.2 report.

    The netting set is the tranches with a finite beta in the fold that holds their entry (start_ms <= entry < end_ms),
    as the book includes them. The 5m opens come from the panel.
    """
    p = Path(run_dir)
    tranche_list = _coerce_tranches(pd.read_parquet(p / "tranches.parquet"))
    folds = json.loads((p / "folds.json").read_text(encoding="utf-8"))
    daily = pd.read_parquet(p / "daily.parquet")
    lookup = FiveMinLookup({s: panel[s]["5m"] for s in panel if "5m" in panel[s]})

    starts, ends, rows = _fold_betas(folds)
    kept: list[Tranche] = []
    betas: list[float] = []
    for t in tranche_list:
        f = int(np.searchsorted(starts, t.entry_ms, side="right")) - 1
        if f < 0 or t.entry_ms >= ends[f]:
            continue
        v = rows[f]["betas"].get(t.symbol)
        if v is None or not np.isfinite(float(v)):
            continue
        kept.append(t)
        betas.append(float(v))
    hedge = hedge_legs(kept, betas, lookup, universe)
    return hedge_cost_report(daily, kept, hedge, profile)
