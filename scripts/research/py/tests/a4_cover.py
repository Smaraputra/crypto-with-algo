"""Test helper for Amendment 4 (A4.1): a record of zero-rate settlements for a test that builds its own prices.

The hedge leg reads the settlements of every basket coin and raises when none covers a window, so a test that
constructs prices without any settlements needs a record that spans them. Zero rates leave every funding at zero.
"""

from __future__ import annotations

from collections.abc import Mapping

import numpy as np
import pandas as pd

FUNDING_MS = 8 * 3_600_000


def zero_settlements(five_min: Mapping[str, pd.DataFrame], rate: float = 0.0) -> dict[str, pd.DataFrame]:
    """One settlement frame per coin on the 8h grid, from one interval before its first price to one after its last."""
    out: dict[str, pd.DataFrame] = {}
    for sym, df in five_min.items():
        if df.empty:
            continue
        lo = (int(df["t"].min()) // FUNDING_MS - 1) * FUNDING_MS
        hi = (int(df["t"].max()) // FUNDING_MS + 2) * FUNDING_MS
        t = np.arange(lo, hi + 1, FUNDING_MS, dtype=np.int64)
        out[sym] = pd.DataFrame({"t": t, "rate": np.full(len(t), rate), "intervalHours": np.full(len(t), 8)})
    return out
