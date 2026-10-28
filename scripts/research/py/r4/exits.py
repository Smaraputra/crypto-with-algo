"""Exit engine: a bar-by-bar state machine over closed 5m bars, and its vectorised replay.

Rules (calibration spec section 2, as amended by N3, N6 and N10.6):
- E1 "horizon": exit at the scheduled exit, at the open of that 5m bar, taker.
- E2 {"rule": "E2", "k"}: barriers at entry x exp(+-k x sigma_h(T)), fixed for the hold. A stop fills taker at the
  worse of the level and the touching bar's open. A take-profit needs a strict trade-through and fills maker at the
  level. A bar trading through both books the stop.
- E3 {"rule": "E3", "k"}: a trailing stop with no take-profit. The stop in force on bar j comes from information up
  to the close of bar j-1 and is never loosened. It is checked before bar j's own extreme is added.
- X1 {"rule": "X1", "n_bars"}: a resting maker order at the open of the bar n_bars x 5m before the scheduled exit,
  filled on a strict trade-through, else E1 at the scheduled exit as taker.

Every intrabar fill is stamped at the close of the touching bar (bar.t + 5m), which is on the 5m grid. The scheduled
exit always wins its own bar. sigma_h is the trailing 24h realized width of labels.trailing_sigma_h. A missing or
non-positive sigma_h means no barrier or trail: the position holds, and the tranche is counted in missing_sigma.

step() is the canonical machine. replay_exits() is its numpy replay over each tranche's bar window, and
replay_by_steps() drives step() bar by bar as the reference the two are tested against.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from r4.method import SIGMA_TRAILING_MS

STEP_MS = 300_000
EXIT_REASONS = ("horizon", "stop", "take_profit", "maker_exit")

SigmaAt = Callable[[str, np.ndarray], np.ndarray]


# ---------------------------------------------------------------------------
# Spec
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExitSpec:
    rule: str = "E1"
    k: float | None = None
    n_bars: int | None = None


def parse_exit(raw: Any) -> ExitSpec:
    """The string "horizon" (E1), or a dict of the form E2/E3 {rule, k} or X1 {rule, n_bars}. Anything else raises."""
    if isinstance(raw, ExitSpec):
        return parse_exit(_spec_to_raw(raw))
    if raw == "horizon" and isinstance(raw, str):
        return ExitSpec(rule="E1")
    if not isinstance(raw, dict):
        raise ValueError(f"exit must be 'horizon' or a dict with a rule, got {raw!r}")
    rule = raw.get("rule")
    if rule in ("E2", "E3"):
        if set(raw) != {"rule", "k"}:
            raise ValueError(f"exit {rule} takes exactly the keys rule and k, got {sorted(raw)}")
        k = raw["k"]
        if isinstance(k, bool) or not isinstance(k, (int, float)) or not math.isfinite(k) or k <= 0:
            raise ValueError(f"exit {rule} needs a finite k > 0, got {k!r}")
        return ExitSpec(rule=rule, k=float(k))
    if rule == "X1":
        if set(raw) != {"rule", "n_bars"}:
            raise ValueError(f"exit X1 takes exactly the keys rule and n_bars, got {sorted(raw)}")
        n = raw["n_bars"]
        if isinstance(n, bool) or not isinstance(n, int) or n < 1:
            raise ValueError(f"exit X1 needs an integer n_bars >= 1, got {n!r}")
        return ExitSpec(rule="X1", n_bars=n)
    raise ValueError(f"unknown exit rule {rule!r}: expected 'horizon', E2, E3 or X1")


def _spec_to_raw(spec: ExitSpec) -> Any:
    if spec.rule == "E1":
        return "horizon"
    if spec.rule == "X1":
        return {"rule": "X1", "n_bars": spec.n_bars}
    return {"rule": spec.rule, "k": spec.k}


def is_horizon(exit_cfg: Any) -> bool:
    """True when the configured exit is plain E1 (the string 'horizon' or an E1 spec)."""
    return parse_exit(exit_cfg).rule == "E1"


# ---------------------------------------------------------------------------
# Shared arithmetic: the same expressions in the state machine and in the replay, so results are bit-identical
# ---------------------------------------------------------------------------


def _e2_levels(entry: Any, k: float, sigma: Any) -> tuple[Any, Any]:
    """(upper, lower) barriers at entry x exp(+-k x sigma)."""
    return entry * np.exp(k * sigma), entry * np.exp(-k * sigma)


def _trail_candidate(extreme: Any, side: int, k: float, sigma: Any) -> Any:
    """long: extreme x exp(-k sigma); short: extreme x exp(+k sigma)."""
    return extreme * np.exp((-side * k) * sigma)


# ---------------------------------------------------------------------------
# The canonical state machine
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Bar:
    t: int
    o: float
    h: float
    l: float
    c: float


@dataclass(frozen=True)
class StepCtx:
    """sigma_open is sigma_h at the close of the previous bar (the open time of this bar)."""

    sigma_open: float = math.nan


@dataclass(frozen=True)
class Hold:
    pass


@dataclass(frozen=True)
class Close:
    reason: str
    fill_price: float
    fill_type: str
    stamp_ms: int


HOLD = Hold()


@dataclass(frozen=True)
class ExitState:
    rule: str
    side: int
    entry_price: float
    scheduled_exit_ms: int
    k: float = math.nan
    stop: float = math.nan
    tp: float = math.nan
    extreme: float = math.nan
    limit: float = math.nan
    rest_from_ms: int = 0
    missing_sigma: bool = False


def init_state(spec: ExitSpec, side: int, entry_price: float, scheduled_exit_ms: int, sigma_t: float) -> ExitState:
    """The state at entry. sigma_t is sigma_h at the decision time T (used by E2 only)."""
    if side not in (1, -1):
        raise ValueError(f"side must be +1 or -1, got {side!r}")
    base = ExitState(
        rule=spec.rule, side=side, entry_price=float(entry_price), scheduled_exit_ms=int(scheduled_exit_ms)
    )
    if spec.rule == "E2":
        assert spec.k is not None
        if sigma_t > 0.0:
            up, lo = _e2_levels(np.float64(entry_price), spec.k, np.float64(sigma_t))
            stop, tp = (float(lo), float(up)) if side == 1 else (float(up), float(lo))
            return replace(base, k=spec.k, stop=stop, tp=tp)
        return replace(base, k=spec.k, missing_sigma=True)
    if spec.rule == "E3":
        assert spec.k is not None
        return replace(base, k=spec.k, extreme=float(entry_price))
    if spec.rule == "X1":
        assert spec.n_bars is not None
        return replace(base, rest_from_ms=int(scheduled_exit_ms) - spec.n_bars * STEP_MS)
    return base


def _stop_fill(side: int, stop: float, bar_open: float) -> float:
    return float(min(stop, bar_open)) if side == 1 else float(max(stop, bar_open))


def step(state: ExitState, bar: Bar, ctx: StepCtx) -> tuple[ExitState, Hold | Close]:
    """Advance one closed 5m bar. Order: (1) scheduled exit, (2) price-level triggers, (3) state update."""
    if bar.t == state.scheduled_exit_ms:
        return state, Close("horizon", bar.o, "taker", bar.t)
    s = state.side
    st = state
    stamp = bar.t + STEP_MS

    if state.rule == "E3":
        sig = ctx.sigma_open
        if sig > 0.0:
            cand = float(_trail_candidate(np.float64(state.extreme), s, state.k, np.float64(sig)))
            if math.isnan(state.stop):
                new_stop = cand
            else:
                new_stop = max(state.stop, cand) if s == 1 else min(state.stop, cand)
            st = replace(st, stop=new_stop)
        else:
            st = replace(st, missing_sigma=True)

    stop_hit = (bar.l <= st.stop) if s == 1 else (bar.h >= st.stop)  # NaN compares False: no stop
    if stop_hit:
        return st, Close("stop", _stop_fill(s, st.stop, bar.o), "taker", stamp)
    if state.rule == "E2":
        tp_hit = (bar.h > st.tp) if s == 1 else (bar.l < st.tp)
        if tp_hit:
            return st, Close("take_profit", st.tp, "maker", stamp)
    if state.rule == "X1":
        if math.isnan(st.limit) and bar.t >= st.rest_from_ms:
            st = replace(st, limit=bar.o)
        if not math.isnan(st.limit):
            filled = (bar.h > st.limit) if s == 1 else (bar.l < st.limit)
            if filled:
                return st, Close("maker_exit", st.limit, "maker", stamp)
    if state.rule == "E3":
        st = replace(st, extreme=max(st.extreme, bar.h) if s == 1 else min(st.extreme, bar.l))
    return st, HOLD


# ---------------------------------------------------------------------------
# Bars and sigma
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Bars:
    t: np.ndarray
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray


def _prepare_one(df: pd.DataFrame) -> _Bars:
    missing = [c for c in ("t", "o", "h", "l", "c") if c not in df.columns]
    if missing:
        raise ValueError(f"exit engine needs 5m bars with columns t, o, h, l, c; missing {missing}")
    d = df[["t", "o", "h", "l", "c"]].sort_values("t", kind="stable")
    d = d[~d["t"].duplicated(keep="last")]
    arr = d.to_numpy(dtype=np.float64)
    ok = np.isfinite(arr).all(axis=1)
    arr = arr[ok]
    return _Bars(
        t=np.ascontiguousarray(arr[:, 0]).astype(np.int64),
        o=np.ascontiguousarray(arr[:, 1]),
        h=np.ascontiguousarray(arr[:, 2]),
        l=np.ascontiguousarray(arr[:, 3]),
        c=np.ascontiguousarray(arr[:, 4]),
    )


def prepare_bars(five_min: Mapping[str, pd.DataFrame | _Bars]) -> dict[str, _Bars]:
    """Sort, dedupe (last wins) and drop non-finite 5m bars, per symbol. A dropped bar is a missing bar."""
    return {s: (v if isinstance(v, _Bars) else _prepare_one(v)) for s, v in five_min.items()}


class SigmaTable:
    """sigma_h(tau) per symbol, equal to labels.trailing_sigma_h at every 5m grid time tau.

    Window (tau - 24h, tau]: the first bar uses its own open, the rest close to close. Any missing bar in the window,
    or a non-positive price, makes it NaN. Callable as table(symbol, times) -> array. Tables are built lazily.
    """

    def __init__(self, five_min: Mapping[str, pd.DataFrame], h_ms: int, trailing_ms: int = SIGMA_TRAILING_MS):
        if h_ms <= 0:
            raise ValueError(f"h_ms must be positive, got {h_ms}")
        if trailing_ms <= 0 or trailing_ms % STEP_MS != 0:
            raise ValueError(f"trailing_ms must be a positive multiple of {STEP_MS}, got {trailing_ms}")
        self._five_min = five_min
        self._scale = h_ms / trailing_ms
        self._m = trailing_ms // STEP_MS
        self._cache: dict[str, tuple[int, np.ndarray] | None] = {}

    def _build(self, symbol: str) -> tuple[int, np.ndarray] | None:
        df = self._five_min.get(symbol)
        if df is None or len(df) == 0:
            return None
        if isinstance(df, _Bars):
            t, o, c = df.t, df.o, df.c
        else:
            d = df[["t", "o", "c"]].sort_values("t", kind="stable")
            d = d[~d["t"].duplicated(keep="last")]
            t = d["t"].to_numpy(dtype=np.int64)
            o = d["o"].to_numpy(dtype=np.float64)
            c = d["c"].to_numpy(dtype=np.float64)
        t_min = int(t[0])
        n = int((t[-1] - t_min) // STEP_MS) + 1
        m = self._m
        if n < m:
            return None
        pos = ((t - t_min) // STEP_MS).astype(np.int64)
        od = np.full(n, np.nan)
        cd = np.full(n, np.nan)
        od[pos] = np.where(o > 0.0, o, np.nan)
        cd[pos] = np.where(c > 0.0, c, np.nan)
        with np.errstate(invalid="ignore", divide="ignore"):
            own2 = np.log(cd / od) ** 2
            cc2 = np.full(n, np.nan)
            cc2[1:] = np.log(cd[1:] / cd[:-1]) ** 2
            # s_win[j] = sum of cc2[j .. j + m - 2] (m - 1 close-to-close terms)
            s_win = sliding_window_view(cc2, m - 1).sum(axis=1) if m > 1 else np.zeros(n)
        sig = np.full(n + 1, np.nan)
        ks = np.arange(m, n + 1)
        with np.errstate(invalid="ignore"):
            sig2 = (own2[ks - m] + s_win[ks - (m - 1)]) * self._scale
            sig[ks] = np.sqrt(sig2)
        return t_min, sig

    def __call__(self, symbol: str, times: np.ndarray) -> np.ndarray:
        if symbol not in self._cache:
            self._cache[symbol] = self._build(symbol)
        built = self._cache[symbol]
        times = np.atleast_1d(np.asarray(times, dtype=np.int64))
        out = np.full(len(times), np.nan)
        if built is None:
            return out
        t_min, sig = built
        rel = times - t_min
        k = rel // STEP_MS
        ok = (rel % STEP_MS == 0) & (k >= 0) & (k < len(sig))
        out[ok] = sig[k[ok]]
        return out


def make_sigma_at(five_min: Mapping[str, pd.DataFrame], h_ms: int) -> SigmaTable:
    return SigmaTable(five_min, h_ms)


def _clean_sigma(x: np.ndarray) -> np.ndarray:
    """Non-positive and NaN sigma are missing."""
    x = np.asarray(x, dtype=np.float64)
    return np.where(x > 0.0, x, np.nan)


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------

_CHUNK_CELLS = 2_000_000
_REQUIRED = ("symbol", "side", "T", "entry_ms", "exit_ms", "entry_price")


def _check_entries(entries: pd.DataFrame) -> None:
    missing = [c for c in _REQUIRED if c not in entries.columns]
    if missing:
        raise ValueError(f"entries need columns {_REQUIRED}; missing {missing}")
    if not np.isin(entries["side"].to_numpy(), (1, -1)).all():
        raise ValueError("entries side must be +1 or -1")


def _empty_result(n: int) -> dict[str, np.ndarray]:
    return {
        "exit_ms": np.zeros(n, dtype=np.int64),
        "exit_price": np.full(n, np.nan),
        "exit_fill": np.full(n, "taker", dtype=object),
        "exit_reason": np.full(n, "horizon", dtype=object),
        "missing_sigma": np.zeros(n, dtype=bool),
    }


def _finish(res: dict[str, np.ndarray]) -> pd.DataFrame:
    return pd.DataFrame(res)


def replay_exits(
    entries: pd.DataFrame,
    five_min: Mapping[str, pd.DataFrame | _Bars],
    spec: Any,
    sigma_at: SigmaAt,
) -> pd.DataFrame:
    """Replay the exit rule over every entry's bars. Equal to stepping step() tranche for tranche.

    entries (one row per tranche, any order): symbol, side (+1/-1), T (decision time), entry_ms, exit_ms (the
    scheduled exit), entry_price. Returns a frame aligned to entries.reset_index(): exit_ms, exit_price, exit_fill,
    exit_reason, missing_sigma. Every entry needs a 5m bar at its scheduled exit; a missing one raises.
    """
    spec = parse_exit(spec)
    _check_entries(entries)
    bars = prepare_bars(five_min)
    n = len(entries)
    res = _empty_result(n)
    if n == 0:
        return _finish(res)
    sym = entries["symbol"].to_numpy()
    side = entries["side"].to_numpy(dtype=np.int64)
    t_dec = entries["T"].to_numpy(dtype=np.int64)
    entry_ms = entries["entry_ms"].to_numpy(dtype=np.int64)
    sched = entries["exit_ms"].to_numpy(dtype=np.int64)
    entry_px = entries["entry_price"].to_numpy(dtype=np.float64)
    res["exit_ms"][:] = sched

    for s in pd.unique(sym):
        rows = np.flatnonzero(sym == s)
        b = bars.get(str(s))
        if b is None or len(b.t) == 0:
            raise ValueError(f"no 5m bars for symbol {s!r}")
        _replay_symbol(str(s), b, rows, side, t_dec, entry_ms, sched, entry_px, spec, sigma_at, res)
    return _finish(res)


def _replay_symbol(
    sym: str,
    b: _Bars,
    rows: np.ndarray,
    side: np.ndarray,
    t_dec: np.ndarray,
    entry_ms: np.ndarray,
    sched: np.ndarray,
    entry_px: np.ndarray,
    spec: ExitSpec,
    sigma_at: SigmaAt,
    res: dict[str, np.ndarray],
) -> None:
    n_bars = len(b.t)
    i0 = np.searchsorted(b.t, entry_ms[rows], side="left")
    i1 = np.searchsorted(b.t, sched[rows], side="left")
    has_h = (i1 < n_bars) & (b.t[np.minimum(i1, n_bars - 1)] == sched[rows])
    if not has_h.all():
        bad = int(sched[rows][~has_h][0])
        raise ValueError(f"no 5m bar at the scheduled exit {bad} for {sym}")
    res["exit_price"][rows] = b.o[i1]
    if spec.rule == "E1":
        return
    n_path = np.maximum(i1 - i0, 0)
    side_r = side[rows]

    if spec.rule == "E2":
        assert spec.k is not None
        sig_t = _clean_sigma(sigma_at(sym, t_dec[rows]))
        res["missing_sigma"][rows] = np.isnan(sig_t)

    sig_open_all = None
    if spec.rule == "E3":
        sig_open_all = _clean_sigma(sigma_at(sym, b.t))

    for s in (1, -1):
        sel = np.flatnonzero((side_r == s) & (n_path > 0))
        if len(sel) == 0:
            continue
        lmax = int(n_path[sel].max())
        per_chunk = max(1, _CHUNK_CELLS // max(lmax, 1))
        for c0 in range(0, len(sel), per_chunk):
            part = sel[c0 : c0 + per_chunk]
            g = rows[part]
            i0p, npp = i0[part], n_path[part]
            lc = int(npp.max())
            pos = np.arange(lc)
            valid = pos[None, :] < npp[:, None]
            idx = np.minimum(i0p[:, None] + pos[None, :], n_bars - 1)
            o_m = np.where(valid, b.o[idx], np.nan)
            h_m = np.where(valid, b.h[idx], np.nan)
            l_m = np.where(valid, b.l[idx], np.nan)
            entry = entry_px[g]

            if spec.rule == "E2":
                sig = sig_t[part]
                with np.errstate(invalid="ignore"):
                    up, lo = _e2_levels(entry, spec.k, sig)
                stop_lv, tp_lv = (lo, up) if s == 1 else (up, lo)
                if s == 1:
                    sl = l_m <= stop_lv[:, None]
                    tp = h_m > tp_lv[:, None]
                else:
                    sl = h_m >= stop_lv[:, None]
                    tp = l_m < tp_lv[:, None]
                ev = sl | tp
                first, any_ev = ev.argmax(axis=1), ev.any(axis=1)
                r = np.arange(len(g))
                sl_at = sl[r, first]
                o_at = o_m[r, first]
                fill_stop = np.minimum(stop_lv, o_at) if s == 1 else np.maximum(stop_lv, o_at)
                price = np.where(sl_at, fill_stop, tp_lv)
                reason = np.where(sl_at, "stop", "take_profit")
                fill = np.where(sl_at, "taker", "maker")
            elif spec.rule == "E3":
                assert sig_open_all is not None and spec.k is not None
                sg = np.where(valid, sig_open_all[idx], 1.0)
                if s == 1:
                    cm = np.maximum.accumulate(np.where(valid, h_m, -np.inf), axis=1)
                    ext = np.empty_like(cm)
                    ext[:, 0] = entry
                    ext[:, 1:] = np.maximum(entry[:, None], cm[:, :-1])
                else:
                    cm = np.minimum.accumulate(np.where(valid, l_m, np.inf), axis=1)
                    ext = np.empty_like(cm)
                    ext[:, 0] = entry
                    ext[:, 1:] = np.minimum(entry[:, None], cm[:, :-1])
                with np.errstate(invalid="ignore"):
                    cand = _trail_candidate(ext, s, spec.k, sg)
                if s == 1:
                    stop_m = np.maximum.accumulate(np.where(np.isnan(cand), -np.inf, cand), axis=1)
                    sl = l_m <= stop_m
                else:
                    stop_m = np.minimum.accumulate(np.where(np.isnan(cand), np.inf, cand), axis=1)
                    sl = h_m >= stop_m
                first, any_ev = sl.argmax(axis=1), sl.any(axis=1)
                r = np.arange(len(g))
                o_at = o_m[r, first]
                stop_at = stop_m[r, first]
                price = np.minimum(stop_at, o_at) if s == 1 else np.maximum(stop_at, o_at)
                reason = np.full(len(g), "stop", dtype=object)
                fill = np.full(len(g), "taker", dtype=object)
                jx = np.where(any_ev, first, npp - 1)
                bad = valid & np.isnan(sg) & (pos[None, :] <= jx[:, None])
                res["missing_sigma"][g] = bad.any(axis=1)
            else:  # X1
                assert spec.n_bars is not None
                start = np.maximum(np.searchsorted(b.t, sched[g] - spec.n_bars * STEP_MS, side="left"), i0p)
                js = start - i0p
                r = np.arange(len(g))
                limit = o_m[r, np.minimum(js, lc - 1)]
                active = valid & (pos[None, :] >= js[:, None])
                hit = (h_m > limit[:, None]) if s == 1 else (l_m < limit[:, None])
                ev = hit & active
                first, any_ev = ev.argmax(axis=1), ev.any(axis=1)
                price = limit
                reason = np.full(len(g), "maker_exit", dtype=object)
                fill = np.full(len(g), "maker", dtype=object)

            hit_rows = np.flatnonzero(any_ev)
            if len(hit_rows):
                gg = g[hit_rows]
                res["exit_ms"][gg] = b.t[i0p[hit_rows] + first[hit_rows]] + STEP_MS
                res["exit_price"][gg] = price[hit_rows]
                res["exit_fill"][gg] = fill[hit_rows]
                res["exit_reason"][gg] = reason[hit_rows]


def replay_by_steps(
    entries: pd.DataFrame,
    five_min: Mapping[str, pd.DataFrame | _Bars],
    spec: Any,
    sigma_at: SigmaAt,
) -> pd.DataFrame:
    """The reference: drive step() bar by bar for each entry. Same output as replay_exits()."""
    spec = parse_exit(spec)
    _check_entries(entries)
    bars = prepare_bars(five_min)
    res = _empty_result(len(entries))
    for i, row in enumerate(entries.itertuples(index=False)):
        sym = str(row.symbol)
        b = bars[sym]
        sched = int(row.exit_ms)
        i0 = int(np.searchsorted(b.t, int(row.entry_ms), side="left"))
        side = int(row.side)
        sig_t = float(_clean_sigma(sigma_at(sym, np.array([int(row.T)])))[0])
        state = init_state(spec, side, float(row.entry_price), sched, sig_t)
        closed = False
        j = i0
        while j < len(b.t) and int(b.t[j]) <= sched:
            bar = Bar(int(b.t[j]), float(b.o[j]), float(b.h[j]), float(b.l[j]), float(b.c[j]))
            sig_open = float(_clean_sigma(sigma_at(sym, np.array([bar.t])))[0]) if spec.rule == "E3" else math.nan
            state, action = step(state, bar, StepCtx(sigma_open=sig_open))
            if isinstance(action, Close):
                res["exit_ms"][i] = action.stamp_ms
                res["exit_price"][i] = action.fill_price
                res["exit_fill"][i] = action.fill_type
                res["exit_reason"][i] = action.reason
                closed = True
                break
            j += 1
        if not closed:
            raise ValueError(f"no 5m bar at the scheduled exit {sched} for {sym}")
        res["missing_sigma"][i] = state.missing_sigma
    return _finish(res)


# ---------------------------------------------------------------------------
# Context for the pipeline: prepared bars, one sigma table, and the run's exit counters
# ---------------------------------------------------------------------------


class ExitContext:
    """Everything _make_tranches needs to apply a non-horizon exit, and the counters the receipt reports."""

    def __init__(self, five_min: Mapping[str, pd.DataFrame], h_ms: int):
        self.bars = prepare_bars(five_min)
        self.sigma_at = SigmaTable(five_min, h_ms)
        self.reasons: Counter[str] = Counter()
        self.missing_sigma = 0

    def replay(self, entries: pd.DataFrame, spec: ExitSpec) -> pd.DataFrame:
        out = replay_exits(entries, self.bars, spec, self.sigma_at)
        self.reasons.update(out["exit_reason"].tolist())
        self.missing_sigma += int(out["missing_sigma"].sum())
        return out


__all__ = [
    "EXIT_REASONS",
    "HOLD",
    "STEP_MS",
    "Bar",
    "Close",
    "ExitContext",
    "ExitSpec",
    "ExitState",
    "Hold",
    "SigmaTable",
    "StepCtx",
    "init_state",
    "is_horizon",
    "make_sigma_at",
    "parse_exit",
    "prepare_bars",
    "replay_by_steps",
    "replay_exits",
    "step",
]
