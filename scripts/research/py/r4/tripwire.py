"""Label-shift tripwire (lock M, exploration bar item 4).

100 panel-wide circular shifts of the labels against the features, each by s_k = 30 + 7k days (k = 0 to 99, no
seed). Features, entry and exit prices and the sample times stay where they are, so training sees shifted labels while
decisions are booked at real prices. If more than 60 of the 100 shifted walk-forwards give a positive drift-free daily
mean, the family halts for a leakage review. The tripwire adds no trials.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from fractions import Fraction
from typing import Any

import numpy as np
import pandas as pd

from r4.bar import _TRIPWIRE_HALT_SHARE
from r4.book import DAY_MS, daily_series
from r4.pipeline import SOURCE_WINDOW_COLUMN, RunConfig, walk_forward

SHIFT_DAYS: tuple[int, ...] = tuple(30 + 7 * k for k in range(100))
LABEL_COLUMNS: tuple[str, ...] = (
    "gross_log",
    "tb_label",
    "tb_net",
    "tb_exit",
    "tb_label_short",
    "tb_net_short",
    "tb_exit_short",
)
MIN_SEPARATION_DAYS = 30


def halt_decision(positive: int, n: int) -> bool:
    """True when strictly more than the halt share of the n shifts are positive (60 of 100 does not halt)."""
    return Fraction(int(positive)) > _TRIPWIRE_HALT_SHARE * int(n)


def shift_labels(
    samples: pd.DataFrame, shift_ms: int, interval_ms: int, with_source_window: bool = False
) -> tuple[pd.DataFrame, int]:
    """Replace each row's label columns with those of the same symbol at T' = T + shift, wrapped circularly.

    The wrap is within the symbol's sample span: the sorted unique decision times, a circle of length
    (last T - first T + interval_ms). T' is looked up by time, never by row position, and a row whose T' has no sample
    is dropped. Feature, price and time columns are untouched. Returns the shifted frame (attrs kept) and the number
    of rows dropped.

    with_source_window adds the column label_t1_max: the t1_max of the row each label came from. walk_forward then
    keeps a row out of training when that source window reaches the refit cut (less the embargo).
    """
    present = [c for c in LABEL_COLUMNS if c in samples.columns]
    n = len(samples)
    if n == 0:
        return samples.copy(), 0
    sym = samples["symbol"].to_numpy()
    t = samples["T"].to_numpy(dtype=np.int64)
    src = np.full(n, -1, dtype=np.int64)
    for s in pd.unique(sym):
        rows = np.flatnonzero(sym == s)
        order = rows[np.argsort(t[rows], kind="stable")]
        ts = t[order]
        lo, hi = int(ts[0]), int(ts[-1])
        length = hi - lo + int(interval_ms)
        tp = lo + (ts - lo + int(shift_ms)) % length
        pos = np.searchsorted(ts, tp)
        pos_c = np.minimum(pos, len(ts) - 1)
        ok = (pos < len(ts)) & (ts[pos_c] == tp)
        src[order[ok]] = order[pos_c[ok]]
    keep = src >= 0
    out = samples.loc[keep].reset_index(drop=True)
    for col in present:
        out[col] = samples[col].to_numpy()[src[keep]]
    if with_source_window:
        out[SOURCE_WINDOW_COLUMN] = samples["t1_max"].to_numpy(dtype=np.int64)[src[keep]]
    out.attrs = dict(samples.attrs)
    return out, int(n - keep.sum())


def _effective_shift_days(samples: pd.DataFrame, shift_days: int, interval_ms: int) -> float:
    """Circular distance in days between T and T' on the widest symbol span (below 30 flags a wrapped near-identity)."""
    if samples.empty:
        return float(shift_days)
    spans = samples.groupby("symbol")["T"].agg(["min", "max"])
    length = int((spans["max"] - spans["min"]).max()) + int(interval_ms)
    s = (int(shift_days) * DAY_MS) % length
    return min(s, length - s) / DAY_MS


def shifted_run(
    samples: pd.DataFrame,
    cfg: RunConfig,
    shift_days: int,
    first_refit_ms: int,
    end_ms: int,
    panel: dict[str, dict[str, pd.DataFrame]] | None,
) -> dict[str, Any]:
    """One shifted walk-forward. The daily frame travels under the private key '_daily'."""
    interval_ms = 3_600_000 if cfg.interval == "1h" else 14_400_000
    shifted, n_dropped = shift_labels(samples, int(shift_days) * DAY_MS, interval_ms, with_source_window=True)
    n_rows = len(samples)
    res = walk_forward(shifted, cfg, first_refit_ms=first_refit_ms, end_ms=end_ms, panel=panel)
    books = [f.book for f in res.folds if len(f.book)]
    combined = pd.concat(books).groupby("day_start").sum() if books else pd.DataFrame()
    gross = daily_series(combined, "gross_hedged", span_start_ms=first_refit_ms, span_end_ms=end_ms)["gross_hedged"]
    funding = daily_series(combined, "funding", span_start_ms=first_refit_ms, span_end_ms=end_ms)["funding"]
    daily = res.drift_free.copy()
    daily["gross_hedged"] = gross
    daily["funding"] = funding
    return {
        "shift_days": int(shift_days),
        "effective_shift_days": _effective_shift_days(samples, shift_days, interval_ms),
        "wf_mean": float(res.drift_free["drift_free"].mean()),
        "cost_free_mean": float((gross + funding).mean()),
        "n_rows": int(n_rows),
        "n_dropped": int(n_dropped),
        "drop_share": float(n_dropped / n_rows) if n_rows else 0.0,
        "_daily": daily,
    }


def label_shift_tripwire(
    samples: pd.DataFrame,
    cfg: RunConfig,
    first_refit_ms: int,
    end_ms: int,
    panel: dict[str, dict[str, pd.DataFrame]] | None,
    shifts_days: Sequence[int] = SHIFT_DAYS,
    on_run: Callable[[dict[str, Any], pd.DataFrame | None], None] | None = None,
) -> dict[str, Any]:
    """Run every shift and apply the halt rule.

    shifts_days defaults to the locked 100 shifts. A shorter list is for tests only and the result then carries its
    own n. on_run(entry, daily) is called after each shift.
    """
    entries: list[dict[str, Any]] = []
    for s in shifts_days:
        if int(s) < MIN_SEPARATION_DAYS:
            raise ValueError(f"shift of {s} days is below the {MIN_SEPARATION_DAYS}-day minimum")
        entry = shifted_run(samples, cfg, int(s), first_refit_ms, end_ms, panel)
        daily = entry.pop("_daily", None)
        entry["positive"] = bool(entry["wf_mean"] > 0.0)
        entry["positive_cost_free"] = bool(entry["cost_free_mean"] > 0.0)
        entries.append(entry)
        if on_run is not None:
            on_run(entry, daily)
    n = len(entries)
    n_pos = sum(1 for e in entries if e["positive"])
    n_pos_cf = sum(1 for e in entries if e["positive_cost_free"])
    return {
        "shifts": entries,
        "n": n,
        "positive": n_pos,
        "positive_cost_free": n_pos_cf,
        "halt": halt_decision(n_pos, n),
        "drop_share_mean": float(np.mean([e["drop_share"] for e in entries])) if entries else 0.0,
        "short_shifts": sum(1 for e in entries if e["effective_shift_days"] < MIN_SEPARATION_DAYS),
    }
