"""Planted signal: a known cross-sectional edge injected into the 5m prices of a panel, in memory only.

On the 4h grid T (00, 04, ..., 20 UTC) each coin c gets z(c, T), a seeded standard normal minus its cross-sectional
mean. The price offset P_c(t) ramps linearly by amplitude x z(c, T) over the 4h after T + 10 minutes (the entry delay),
so a 4h tranche entered at T + 10 minutes earns exactly amplitude x z(c, T) more than on the original prices. The
offsets sum to zero across coins at every t, so the plant is market neutral.

Only prices change: volume, taker volume, premium index and funding are untouched (disclosed). 15m, 1h, 4h and 1d bars
are re-aggregated from the planted 5m bars. A higher bar with a missing 5m bar inside is dropped and counted.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np
import pandas as pd

from r4.hashfeat import PLANT_DOMAIN, mix64, normal_from_hash, universe_index
from r4.method import ENTRY_DELAY_MS

H4_MS = 14_400_000
BAR_MS = 300_000
HIGHER_BARS: dict[str, int] = {"15m": 900_000, "1h": 3_600_000, "4h": H4_MS, "1d": 86_400_000}


def validate_plant(plant: dict[str, Any], interval: str, h_ms: int) -> None:
    """A plant is {"seed": int, "amplitude": float} and needs the 4h decision interval and the 4h horizon."""
    if not isinstance(plant, dict) or set(plant) != {"seed", "amplitude"}:
        raise ValueError('plant must be {"seed": int, "amplitude": float}')
    seed, amp = plant["seed"], plant["amplitude"]
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("plant seed must be an int")
    if isinstance(amp, bool) or not isinstance(amp, (int, float)) or not np.isfinite(amp):
        raise ValueError("plant amplitude must be a finite number")
    if interval != "4h" or int(h_ms) != H4_MS:
        raise ValueError("plant requires interval '4h' and h_ms of 4h")


def plant_u(seed: int, sym_idx: int, t_ms: np.ndarray) -> np.ndarray:
    """The raw standard normal of the plant stream for one coin (own domain tag, independent of the noise stream)."""
    minutes = np.asarray(t_ms, dtype=np.int64) // 60_000
    return normal_from_hash(mix64(PLANT_DOMAIN, seed, sym_idx, minutes))


def plant_z(seed: int, symbols: Sequence[str], t_ms: np.ndarray) -> np.ndarray:
    """z(c, T) for every panel coin (rows, in the order of `symbols`) at the times t_ms: u minus the mean over coins."""
    t = np.asarray(t_ms, dtype=np.int64)
    u = np.vstack([plant_u(seed, universe_index(s), t) for s in symbols])
    return u - u.mean(axis=0, keepdims=True)


class _Offsets:
    """The cumulative z table on the 4h grid inside a span, evaluated at any time."""

    def __init__(self, symbols: Sequence[str], seed: int, span: tuple[int, int]) -> None:
        self.s0 = -(-int(span[0]) // H4_MS)
        s1 = int(span[1]) // H4_MS
        self.n = max(s1 - self.s0 + 1, 0)
        grid = (self.s0 + np.arange(self.n, dtype=np.int64)) * H4_MS
        self.z = plant_z(seed, symbols, grid) if self.n else np.zeros((len(symbols), 0))
        self.cum = np.concatenate([np.zeros((len(symbols), 1)), np.cumsum(self.z, axis=1)], axis=1)

    def at(self, t_ms: np.ndarray, rows: slice | int = slice(None)) -> np.ndarray:
        """P / amplitude at the times, for the given row selection (all coins by default)."""
        x = np.asarray(t_ms, dtype=np.int64) - ENTRY_DELAY_MS
        s = x // H4_MS
        frac = (x - s * H4_MS) / H4_MS
        g = s - self.s0
        nfull = np.clip(g, 0, self.n)
        inside = (g >= 0) & (g < self.n)
        zcur = self.z[rows][..., np.clip(g, 0, max(self.n - 1, 0))] if self.n else 0.0
        return self.cum[rows][..., nfull] + np.where(inside, zcur * frac, 0.0)


def plant_offsets(
    symbols: Sequence[str], seed: int, amplitude: float, t_ms: np.ndarray, span: tuple[int, int]
) -> np.ndarray:
    """P_c(t) for every coin (rows) at the times t_ms, with the 4h grid taken inside `span` (first, last 5m open)."""
    return float(amplitude) * _Offsets(symbols, seed, span).at(t_ms)


class PlantedPanel(dict[str, dict[str, pd.DataFrame]]):
    """A planted panel. `dropped[symbol][interval]` counts the higher bars lost to a missing 5m bar."""

    dropped: dict[str, dict[str, int]]
    plant: dict[str, Any]

    def __deepcopy__(self, memo: dict[int, Any]) -> PlantedPanel:
        memo[id(self)] = self
        return self

    @property
    def dropped_total(self) -> int:
        return sum(sum(d.values()) for d in self.dropped.values())


def _aggregate(five: pd.DataFrame, ms: int) -> pd.DataFrame:
    t = five["t"].to_numpy(dtype=np.int64)
    if len(t) == 0:
        return pd.DataFrame({k: [] for k in ("t", "o", "h", "l", "c", "v", "tbv")})
    bins = t // ms
    ub, first, counts = np.unique(bins, return_index=True, return_counts=True)
    full = counts == ms // BAR_MS
    f_first = first[full]
    out: dict[str, Any] = {"t": ub[full] * ms}
    o = five["o"].to_numpy(dtype=np.float64)
    c = five["c"].to_numpy(dtype=np.float64)
    out["o"] = o[f_first]
    out["h"] = np.maximum.reduceat(five["h"].to_numpy(dtype=np.float64), first)[full]
    out["l"] = np.minimum.reduceat(five["l"].to_numpy(dtype=np.float64), first)[full]
    out["c"] = c[f_first + counts[full] - 1]
    for col in ("v", "tbv"):
        if col in five.columns:
            out[col] = np.add.reduceat(five[col].to_numpy(dtype=np.float64), first)[full]
    return pd.DataFrame(out)


def apply_plant(panel: dict[str, dict[str, pd.DataFrame]], plant: dict[str, Any]) -> PlantedPanel:
    """A NEW panel with the planted offsets applied to the prices. The input panel and the dataset are untouched."""
    seed, amp = int(plant["seed"]), float(plant["amplitude"])
    symbols = list(panel)
    ends = [(int(d["5m"]["t"].min()), int(d["5m"]["t"].max())) for d in panel.values() if len(d["5m"])]
    span = (min(a for a, _ in ends), max(b for _, b in ends)) if ends else (0, -1)
    table = _Offsets(symbols, seed, span)

    out = PlantedPanel()
    out.plant = {"seed": seed, "amplitude": amp}
    out.dropped = {}
    for i, sym in enumerate(symbols):
        frames = dict(panel[sym])
        five = panel[sym]["5m"].sort_values("t").reset_index(drop=True)
        new5 = five.copy()
        if len(five):
            t0 = five["t"].to_numpy(dtype=np.int64)
            p0 = amp * table.at(t0, i)
            p1 = amp * table.at(t0 + BAR_MS, i)
            new5["o"] = five["o"].to_numpy(dtype=np.float64) * np.exp(p0)
            new5["c"] = five["c"].to_numpy(dtype=np.float64) * np.exp(p1)
            new5["h"] = five["h"].to_numpy(dtype=np.float64) * np.exp(np.maximum(p0, p1))
            new5["l"] = five["l"].to_numpy(dtype=np.float64) * np.exp(np.minimum(p0, p1))
        frames["5m"] = new5
        drops: dict[str, int] = {}
        for iv, ms in HIGHER_BARS.items():
            agg = _aggregate(new5, ms)
            old = panel[sym].get(iv)
            old_t = set(old["t"].tolist()) if old is not None and len(old) else set()
            drops[iv] = len(old_t - set(agg["t"].tolist()))
            frames[iv] = agg
        out.dropped[sym] = drops
        out[sym] = frames
    return out


# ---------------------------------------------------------------------------
# The planted reversal of the exit controls (calibration spec lines 171 and 269)
# ---------------------------------------------------------------------------

EVENT_AMP = 0.02
_HOUR_MS = 3_600_000
_MIN_MS = 60_000


def plant_events(
    panel: dict[str, dict[str, pd.DataFrame]], seed: int
) -> tuple[dict[str, dict[str, pd.DataFrame]], dict[str, tuple[np.ndarray, np.ndarray]]]:
    """A copy of the panel with a planted reversal that is observable from taker flow before the price moves.

    Events sit at hour tops, 6 to 15 hours apart (the first 30 hours in). For an event at e with sign s the taker
    buy share of the three 5m bars in [e - 15m, e) is 0.95 (s > 0) or 0.05 (s < 0), then the price ramps by
    s x EVENT_AMP (2%) over the twelve 5m bars of [e + 30m, e + 90m). The ramp is cumulative and permanent. Only 5m
    prices and taker volume change, and the higher bars are re-aggregated. Returns the new panel and
    {symbol: (event times, signs)}.
    """
    rng = np.random.default_rng(seed)
    out: dict[str, dict[str, pd.DataFrame]] = {}
    events: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for sym, d in panel.items():
        five = d["5m"].copy()
        t0 = int(five["t"].iloc[0])
        n = len(five)
        hours = []
        h = 30
        while h < n // 12 - 3:
            hours.append(h)
            h += int(rng.integers(6, 16))
        e = t0 + np.array(hours, dtype=np.int64) * _HOUR_MS
        sign = rng.choice([-1, 1], size=len(e))
        inc = np.zeros(n + 12)
        for ee, sg in zip(e, sign, strict=True):
            a = int((ee + 30 * _MIN_MS - t0) // BAR_MS)
            inc[a : a + 12] += sg * EVENT_AMP / 12.0
        cum = np.cumsum(inc)[:n]
        off_open = np.concatenate(([0.0], cum[:-1]))
        off_close = cum
        five["o"] = five["o"].to_numpy() * np.exp(off_open)
        five["c"] = five["c"].to_numpy() * np.exp(off_close)
        five["h"] = five["h"].to_numpy() * np.exp(np.maximum(off_open, off_close))
        five["l"] = five["l"].to_numpy() * np.exp(np.minimum(off_open, off_close))
        tbv = five["tbv"].to_numpy().copy()
        v = five["v"].to_numpy()
        for ee, sg in zip(e, sign, strict=True):
            a = int((ee - 15 * _MIN_MS - t0) // BAR_MS)
            tbv[a : a + 3] = v[a : a + 3] * (0.95 if sg > 0 else 0.05)
        five["tbv"] = tbv
        frames = dict(d)
        frames["5m"] = five
        for iv, ms in HIGHER_BARS.items():
            frames[iv] = _aggregate(five, ms)
        out[sym] = frames
        events[sym] = (e, sign)
    return out, events


def classify_events(
    ent: pd.DataFrame, events: dict[str, tuple[np.ndarray, np.ndarray]]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per entry row: the planted mask, the unplanted mask and the drop start of the first adverse event.

    A tranche is planted when an event against its side (sign x side < 0) falls in [entry + 15m, exit - 2h], and the
    drop starts 30 minutes after that event. It is unplanted when no event lies in [entry - 90m, exit + 15m]. The
    rest (a favourable event, or an event too close to the edges) is neither.
    """
    planted = np.zeros(len(ent), dtype=bool)
    unplanted = np.zeros(len(ent), dtype=bool)
    drop_start = np.full(len(ent), np.iinfo(np.int64).max, dtype=np.int64)
    for sym, (e, sg) in events.items():
        rows = np.flatnonzero((ent["symbol"] == sym).to_numpy())
        entry = ent["entry_ms"].to_numpy()[rows]
        sched = ent["exit_ms"].to_numpy()[rows]
        side = ent["side"].to_numpy()[rows]
        for r, en, sc, sd in zip(rows, entry, sched, side, strict=True):
            adverse = (e >= en + 15 * _MIN_MS) & (e <= sc - 2 * _HOUR_MS) & (sg * sd < 0)
            near = (e >= en - 90 * _MIN_MS) & (e <= sc + 15 * _MIN_MS)
            if adverse.any():
                planted[r] = True
                drop_start[r] = int(e[adverse][0]) + 30 * _MIN_MS
            elif not near.any():
                unplanted[r] = True
    return planted, unplanted, drop_start
