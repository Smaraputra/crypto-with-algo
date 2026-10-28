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

- E6 {"rule": "E6", "flow_bars", "flow_lookback_days", "flow_z", "funding_threshold"}: an information exit with no
  price-level trigger. At every 5m close tau inside the hold (tau in (entry, S - 10 min]) it checks (a) the taker-buy
  share of the last flow_bars bars against its trailing mean +- flow_z SD over flow_lookback_days, and (b) Binance's
  predicted next funding rate against +-funding_threshold. The first tau at which either fires (flow first on a tie)
  schedules a taker close at the 5m open at tau + 10 min, stamped there. If tau + 10 min >= S the close is the horizon
  exit. Between tau and the close the position stays open and nothing else can fire. Disclosed approximations: Binance
  averages the premium index over 1-minute samples, this uses 5m closes; the interest term I = 0.0001 x (interval / 8h)
  is scaled by the interval. The SD is the sample SD (ddof 1). A missing close bar is filled by the first bar at or
  after tau + 10 min. Missing flow or funding inputs mean no trigger at that tau and flag the tranche.

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
EXIT_REASONS = ("horizon", "stop", "take_profit", "maker_exit", "flow_exit", "funding_exit")
FLOW_MIN_SHARE = 0.8
E6_INTEREST = 0.0001
E6_CLAMP = 0.0005
FUNDING_BASE_MS = 8 * 3_600_000

SigmaAt = Callable[[str, np.ndarray], np.ndarray]


# ---------------------------------------------------------------------------
# Spec
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExitSpec:
    rule: str = "E1"
    k: float | None = None
    n_bars: int | None = None
    flow_bars: int | None = None
    flow_lookback_days: float | None = None
    flow_z: float | None = None
    funding_threshold: float | None = None


_E6_KEYS = {"rule", "flow_bars", "flow_lookback_days", "flow_z", "funding_threshold"}


def _num(x: Any) -> bool:
    return not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(x)


def _parse_e6(raw: dict[str, Any]) -> ExitSpec:
    if set(raw) != _E6_KEYS:
        raise ValueError(f"exit E6 takes exactly the keys {sorted(_E6_KEYS)}, got {sorted(raw)}")
    fb, days, z, thr = raw["flow_bars"], raw["flow_lookback_days"], raw["flow_z"], raw["funding_threshold"]
    if isinstance(fb, bool) or not isinstance(fb, int) or fb < 1:
        raise ValueError(f"exit E6 needs an integer flow_bars >= 1, got {fb!r}")
    if not _num(days) or days <= 0 or round(days * 288) < fb:
        raise ValueError(f"exit E6 needs flow_lookback_days > 0 covering at least flow_bars bars, got {days!r}")
    if not _num(z) or z <= 0:
        raise ValueError(f"exit E6 needs a finite flow_z > 0, got {z!r}")
    if not _num(thr) or thr <= 0:
        raise ValueError(f"exit E6 needs a finite funding_threshold > 0, got {thr!r}")
    return ExitSpec(rule="E6", flow_bars=fb, flow_lookback_days=days, flow_z=float(z), funding_threshold=float(thr))


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
    if rule == "E6":
        return _parse_e6(raw)
    raise ValueError(f"unknown exit rule {rule!r}: expected 'horizon', E2, E3, E6 or X1")


def _spec_to_raw(spec: ExitSpec) -> Any:
    if spec.rule == "E1":
        return "horizon"
    if spec.rule == "X1":
        return {"rule": "X1", "n_bars": spec.n_bars}
    if spec.rule == "E6":
        return {
            "rule": "E6",
            "flow_bars": spec.flow_bars,
            "flow_lookback_days": spec.flow_lookback_days,
            "flow_z": spec.flow_z,
            "funding_threshold": spec.funding_threshold,
        }
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


def _flow_ok(w: Any, mu: Any, sd: Any) -> Any:
    """The flow trigger has usable inputs: finite w, mu, sd and sd > 0."""
    with np.errstate(invalid="ignore"):
        return np.isfinite(w) & np.isfinite(mu) & np.isfinite(sd) & (sd > 0.0)


def _flow_fire(side: int, w: Any, mu: Any, sd: Any, z: float) -> Any:
    """Long: w below mu - z sd. Short: w above mu + z sd."""
    with np.errstate(invalid="ignore"):
        hit = (w < mu - z * sd) if side == 1 else (w > mu + z * sd)
    return _flow_ok(w, mu, sd) & hit


def _predicted_funding(p: Any, interval_ms: Any) -> Any:
    """F = P + clamp(I - P, -0.0005, +0.0005), I = 0.0001 x (interval / 8h)."""
    i = E6_INTEREST * (interval_ms / FUNDING_BASE_MS)
    return p + np.clip(i - p, -E6_CLAMP, E6_CLAMP)


def _fund_fire(side: int, f: Any, tau: Any, next_ms: Any, thr: float) -> Any:
    """Long: F > thr. Short: F < -thr. Both only while tau + 10 min is before the next settlement."""
    with np.errstate(invalid="ignore"):
        hit = (f > thr) if side == 1 else (f < -thr)
        timing = (tau + 2 * STEP_MS) < next_ms
    return np.isfinite(f) & hit & timing


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
    # E6 inputs at tau = bar close: flow share w with its trailing mean and SD, predicted funding F, next settlement
    flow_w: float = math.nan
    flow_mu: float = math.nan
    flow_sd: float = math.nan
    fund_f: float = math.nan
    fund_next_ms: int = 0


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
    flow_z: float = math.nan
    fund_thr: float = math.nan
    pending_ms: int = 0
    pending_reason: str = ""
    missing_flow: bool = False
    missing_funding: bool = False


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
    if spec.rule == "E6":
        assert spec.flow_z is not None and spec.funding_threshold is not None
        return replace(base, flow_z=spec.flow_z, fund_thr=spec.funding_threshold)
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

    if state.rule == "E6":
        if st.pending_ms and bar.t >= st.pending_ms:
            return st, Close(st.pending_reason, bar.o, "taker", bar.t)
        if not st.pending_ms and stamp + 2 * STEP_MS <= st.scheduled_exit_ms:
            f_ok = bool(_flow_ok(ctx.flow_w, ctx.flow_mu, ctx.flow_sd))
            u_ok = bool(np.isfinite(ctx.fund_f))
            st = replace(st, missing_flow=st.missing_flow or not f_ok, missing_funding=st.missing_funding or not u_ok)
            reason = ""
            if _flow_fire(s, ctx.flow_w, ctx.flow_mu, ctx.flow_sd, st.flow_z):
                reason = "flow_exit"
            elif _fund_fire(s, ctx.fund_f, stamp, ctx.fund_next_ms, st.fund_thr):
                reason = "funding_exit"
            if reason:
                st = replace(st, pending_ms=stamp + 2 * STEP_MS, pending_reason=reason)
        return st, HOLD

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
    v: np.ndarray | None = None
    tbv: np.ndarray | None = None


def _prepare_one(df: pd.DataFrame) -> _Bars:
    missing = [c for c in ("t", "o", "h", "l", "c") if c not in df.columns]
    if missing:
        raise ValueError(f"exit engine needs 5m bars with columns t, o, h, l, c; missing {missing}")
    d = df.sort_values("t", kind="stable")
    d = d[~d["t"].duplicated(keep="last")]
    arr = d[["t", "o", "h", "l", "c"]].to_numpy(dtype=np.float64)
    ok = np.isfinite(arr).all(axis=1)
    arr = arr[ok]
    vol = {}
    for name in ("v", "tbv"):
        if name in d.columns:
            vol[name] = np.ascontiguousarray(d[name].to_numpy(dtype=np.float64)[ok])
    return _Bars(
        t=np.ascontiguousarray(arr[:, 0]).astype(np.int64),
        o=np.ascontiguousarray(arr[:, 1]),
        h=np.ascontiguousarray(arr[:, 2]),
        l=np.ascontiguousarray(arr[:, 3]),
        c=np.ascontiguousarray(arr[:, 4]),
        v=vol.get("v"),
        tbv=vol.get("tbv"),
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
# E6 inputs: flow and predicted-funding series on the dense 5m grid, computed causally
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class E6Series:
    """Per grid index j (bar open t0 + j x 5m, tau = its close): flow share w with trailing mean mu and SD sd, the
    predicted next funding f (NaN when it cannot be formed) and the next settlement time nxt (0 when unknown)."""

    t0: int
    w: np.ndarray
    mu: np.ndarray
    sd: np.ndarray
    f: np.ndarray
    nxt: np.ndarray

    def pos(self, times: np.ndarray) -> np.ndarray:
        return ((np.asarray(times, dtype=np.int64) - self.t0) // STEP_MS).astype(np.int64)


def _times_values(df: pd.DataFrame | None, col: str) -> tuple[np.ndarray, np.ndarray]:
    if df is None or len(df) == 0 or "t" not in df.columns or col not in df.columns:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.float64)
    d = df.sort_values("t", kind="stable")
    d = d[~d["t"].duplicated(keep="last")]
    return d["t"].to_numpy(dtype=np.int64), d[col].to_numpy(dtype=np.float64)


def build_e6_series(
    b: _Bars,
    premium: pd.DataFrame | None,
    settlements: pd.DataFrame | None,
    flow_bars: int,
    flow_lookback_days: float,
) -> E6Series:
    """The E6 trigger inputs at every 5m close of one coin. Every value at grid index j uses only data closed by j."""
    if b.v is None or b.tbv is None:
        raise ValueError("exit E6 needs 5m bars with columns v and tbv")
    n = int((b.t[-1] - b.t[0]) // STEP_MS) + 1
    t0 = int(b.t[0])
    pos = ((b.t - t0) // STEP_MS).astype(np.int64)
    v_d = np.full(n, np.nan)
    tbv_d = np.full(n, np.nan)
    v_d[pos] = np.where(b.v > 0.0, b.v, np.nan)
    tbv_d[pos] = b.tbv
    w = np.full(n, np.nan)
    if n >= flow_bars:
        sv = sliding_window_view(v_d, flow_bars).sum(axis=1)
        st = sliding_window_view(tbv_d, flow_bars).sum(axis=1)
        w[flow_bars - 1 :] = st / sv
    m = int(round(flow_lookback_days * 288))
    min_p = int(math.ceil(FLOW_MIN_SHARE * m - 1e-9))
    roll = pd.Series(w).rolling(m, min_periods=min_p)
    mu = roll.mean().to_numpy()
    sd = roll.std(ddof=1).to_numpy()

    tau = t0 + (np.arange(n, dtype=np.int64) + 1) * STEP_MS
    f = np.full(n, np.nan)
    nxt = np.zeros(n, dtype=np.int64)
    pt, pc = _times_values(premium, "c")
    stt, _ = _times_values(settlements, "t")
    if len(pt) and len(stt) >= 2:
        fin = np.isfinite(pc)
        cs = np.concatenate(([0.0], np.cumsum(np.where(fin, pc, 0.0))))
        cc = np.concatenate(([0], np.cumsum(fin.astype(np.int64))))
        li = np.searchsorted(stt, tau, side="right") - 1
        ok = li >= 1
        li = np.maximum(li, 1)
        last = stt[li]
        interval = last - stt[li - 1]
        ok &= interval > 0
        lo = np.searchsorted(pt, last - STEP_MS, side="right")
        hi = np.searchsorted(pt, tau - STEP_MS, side="right")
        cnt = cc[hi] - cc[lo]
        ok &= (hi > lo) & (cnt > 0)
        with np.errstate(invalid="ignore", divide="ignore"):
            p = (cs[hi] - cs[lo]) / np.maximum(cnt, 1)
            fv = _predicted_funding(p, interval.astype(np.float64))
        f = np.where(ok, fv, np.nan)
        nxt = np.where(ok, last + interval, 0).astype(np.int64)
    return E6Series(t0=t0, w=w, mu=mu, sd=sd, f=f, nxt=nxt)


class E6Data:
    """Per-coin premium-index and settlement frames for E6, with a cache of the built series."""

    def __init__(self, premium: Mapping[str, pd.DataFrame | None], settlements: Mapping[str, pd.DataFrame | None]):
        self.premium = premium
        self.settlements = settlements
        self._cache: dict[tuple[str, int, float, int], E6Series] = {}

    def series(self, symbol: str, b: _Bars, spec: ExitSpec) -> E6Series:
        assert spec.flow_bars is not None and spec.flow_lookback_days is not None
        key = (symbol, spec.flow_bars, float(spec.flow_lookback_days), id(b))
        if key not in self._cache:
            self._cache[key] = build_e6_series(
                b,
                self.premium.get(symbol),
                self.settlements.get(symbol),
                spec.flow_bars,
                spec.flow_lookback_days,
            )
        return self._cache[key]


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
        "missing_flow": np.zeros(n, dtype=bool),
        "missing_funding": np.zeros(n, dtype=bool),
    }


def _finish(res: dict[str, np.ndarray]) -> pd.DataFrame:
    return pd.DataFrame(res)


def replay_exits(
    entries: pd.DataFrame,
    five_min: Mapping[str, pd.DataFrame | _Bars],
    spec: Any,
    sigma_at: SigmaAt,
    e6: E6Data | None = None,
) -> pd.DataFrame:
    """Replay the exit rule over every entry's bars. Equal to stepping step() tranche for tranche.

    entries (one row per tranche, any order): symbol, side (+1/-1), T (decision time), entry_ms, exit_ms (the
    scheduled exit), entry_price. Returns a frame aligned to entries.reset_index(): exit_ms, exit_price, exit_fill,
    exit_reason, missing_sigma, missing_flow, missing_funding. E6 also needs e6 (premium and settlements).
    Every entry needs a 5m bar at its scheduled exit; a missing one raises.
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
        _replay_symbol(str(s), b, rows, side, t_dec, entry_ms, sched, entry_px, spec, sigma_at, res, e6)
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
    e6: E6Data | None = None,
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
    if spec.rule == "E6":
        _replay_e6(sym, b, rows, side[rows], i0, i1, sched[rows], spec, e6, res)
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


def _replay_e6(
    sym: str,
    b: _Bars,
    rows: np.ndarray,
    side_r: np.ndarray,
    i0: np.ndarray,
    i1: np.ndarray,
    sched_r: np.ndarray,
    spec: ExitSpec,
    e6: E6Data | None,
    res: dict[str, np.ndarray],
) -> None:
    if e6 is None:
        raise ValueError("exit E6 needs premium and settlement data (pass e6=E6Data)")
    assert spec.flow_z is not None and spec.funding_threshold is not None
    ser = e6.series(sym, b, spec)
    pos = ser.pos(b.t)
    w, mu, sd, f, nxt = ser.w[pos], ser.mu[pos], ser.sd[pos], ser.f[pos], ser.nxt[pos]
    tau = b.t + STEP_MS
    nb = len(b.t)
    miss_flow = np.concatenate(([0], np.cumsum(~_flow_ok(w, mu, sd))))
    miss_fund = np.concatenate(([0], np.cumsum(~np.isfinite(f))))
    # bars whose close tau satisfies tau + 10 min <= S, that is bar.t <= S - 15 min
    ie = np.maximum(np.searchsorted(b.t, sched_r - 3 * STEP_MS, side="right"), i0)
    for s in (1, -1):
        sel = np.flatnonzero(side_r == s)
        if len(sel) == 0:
            continue
        flow_fire = _flow_fire(s, w, mu, sd, spec.flow_z)
        fund_fire = _fund_fire(s, f, tau, nxt, spec.funding_threshold)
        idxs = np.flatnonzero(flow_fire | fund_fire)
        lo, hi = i0[sel], ie[sel]
        k = np.searchsorted(idxs, lo, side="left")
        cand = idxs[np.minimum(k, max(len(idxs) - 1, 0))] if len(idxs) else np.zeros(len(sel), dtype=np.int64)
        has = (k < len(idxs)) & (cand < hi)
        end = np.where(has, cand + 1, hi)
        g = rows[sel]
        res["missing_flow"][g] = (miss_flow[end] - miss_flow[lo]) > 0
        res["missing_funding"][g] = (miss_fund[end] - miss_fund[lo]) > 0
        fill_i = np.searchsorted(b.t, b.t[np.minimum(cand, nb - 1)] + 3 * STEP_MS, side="left")
        close = has & (fill_i < i1[sel])
        ci = np.flatnonzero(close)
        if len(ci):
            gg = g[ci]
            fi = fill_i[ci]
            res["exit_ms"][gg] = b.t[fi]
            res["exit_price"][gg] = b.o[fi]
            res["exit_fill"][gg] = "taker"
            res["exit_reason"][gg] = np.where(flow_fire[cand[ci]], "flow_exit", "funding_exit")


def replay_by_steps(
    entries: pd.DataFrame,
    five_min: Mapping[str, pd.DataFrame | _Bars],
    spec: Any,
    sigma_at: SigmaAt,
    e6: E6Data | None = None,
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
        ser = None
        if spec.rule == "E6":
            if e6 is None:
                raise ValueError("exit E6 needs premium and settlement data (pass e6=E6Data)")
            ser = e6.series(sym, b, spec)
        closed = False
        j = i0
        while j < len(b.t) and int(b.t[j]) <= sched:
            bar = Bar(int(b.t[j]), float(b.o[j]), float(b.h[j]), float(b.l[j]), float(b.c[j]))
            sig_open = float(_clean_sigma(sigma_at(sym, np.array([bar.t])))[0]) if spec.rule == "E3" else math.nan
            ctx = StepCtx(sigma_open=sig_open)
            if ser is not None:
                q = int(ser.pos(np.array([bar.t]))[0])
                ctx = StepCtx(
                    flow_w=float(ser.w[q]),
                    flow_mu=float(ser.mu[q]),
                    flow_sd=float(ser.sd[q]),
                    fund_f=float(ser.f[q]),
                    fund_next_ms=int(ser.nxt[q]),
                )
            state, action = step(state, bar, ctx)
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
        res["missing_flow"][i] = state.missing_flow
        res["missing_funding"][i] = state.missing_funding
    return _finish(res)


# ---------------------------------------------------------------------------
# Context for the pipeline: prepared bars, one sigma table, and the run's exit counters
# ---------------------------------------------------------------------------


class ExitContext:
    """Everything _make_tranches needs to apply a non-horizon exit, and the counters the receipt reports."""

    def __init__(
        self,
        five_min: Mapping[str, pd.DataFrame],
        h_ms: int,
        premium: Mapping[str, pd.DataFrame | None] | None = None,
        settlements: Mapping[str, pd.DataFrame | None] | None = None,
    ):
        self.bars = prepare_bars(five_min)
        self.sigma_at = SigmaTable(five_min, h_ms)
        self.e6 = None if premium is None and settlements is None else E6Data(premium or {}, settlements or {})
        self.reasons: Counter[str] = Counter()
        self.missing_sigma = 0
        self.missing_flow = 0
        self.missing_funding = 0

    def replay(self, entries: pd.DataFrame, spec: ExitSpec) -> pd.DataFrame:
        out = replay_exits(entries, self.bars, spec, self.sigma_at, self.e6)
        self.reasons.update(out["exit_reason"].tolist())
        self.missing_sigma += int(out["missing_sigma"].sum())
        self.missing_flow += int(out["missing_flow"].sum())
        self.missing_funding += int(out["missing_funding"].sum())
        return out


__all__ = [
    "EXIT_REASONS",
    "HOLD",
    "STEP_MS",
    "Bar",
    "Close",
    "E6Data",
    "E6Series",
    "ExitContext",
    "ExitSpec",
    "ExitState",
    "Hold",
    "SigmaTable",
    "StepCtx",
    "build_e6_series",
    "init_state",
    "is_horizon",
    "make_sigma_at",
    "parse_exit",
    "prepare_bars",
    "replay_by_steps",
    "replay_exits",
    "step",
]
