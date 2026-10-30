"""Models for the E4 and E5 exits: the tau feature frame, side-symmetric in-hold training, and the fitted pair.

Brief 25c, calibration spec section 2 as amended by N3 and N4.

- Feature instants. Position state updates at every 5m close tau, and the market features at tau are those of
  tau_f = floor(tau to the 15m grid). For a decision interval I (1h or 4h) and each phase in {0, 15m, ..., I - 15m}
  the coin's 5m bars are aggregated into bars [t_b, t_b + I) with t_b = phase (mod I), a bar is missing when any of
  its 5m bars is, and `features.build_feature_frame` runs on those phase bars. The union over phases gives the
  features at every tau_f. Phase 0 also uses the 5m aggregates, so training and serving see one definition. The frame
  is cached per (dataset hash, source digest, coin, interval) as float32 parquet, outside the dataset directory.
- Training (one pair per fold, on the fold's training window only). At every decision instant T with a valid entry
  and scheduled-exit price, for BOTH sides, the hypothetical hold runs from T + 10m to S = T + 10m + h. Four tau,
  uniform over the 5m closes in (T + 10m, S - 10m] and drawn once per hold (the two sides share them), give the
  samples. A sample is the market features at tau_f, the state (side, elapsed share, running P&L, MFE, MAE) and the
  label y = side x log(open(S) / open(tau + 10m)) - side x (settlements in (tau + 10m, S]). Samples with S at or after
  the fold's refit cut are purged, and a sample with a missing market feature is dropped and counted.
- Model inputs. The market features are standardised, and a linear model cannot flip the sign of a feature's effect
  with the side, so the design is [x, side x x, side, elapsed, pnl, mfe, mae] (the state columns standardised). That
  interaction is this module's reading of "with side as a feature" (disclosed ambiguity).
- E4 is a ridge (alpha 1.0) on y with SE the SD of its training residuals. E5 is a logistic regression on 1[y > 0].
  A fold with fewer than MIN_SAMPLES samples fits nothing and falls back to E1.
"""

from __future__ import annotations

import hashlib
import zlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression, Ridge

from r4.exits import STEP_MS, TAU_GRID_MS, _Bars, prepare_bars
from r4.features import ALL_FEATURE_COLUMNS, build_feature_frame
from r4.hashfeat import hash_feature_matrix, is_hash_feature
from r4.method import CPCV_EMBARGO_MS, ENTRY_DELAY_MS

SAMPLES_PER_HOLD = 4
MIN_SAMPLES = 1000
RIDGE_ALPHA = 1.0
STATE_COLUMNS = ("side", "elapsed", "pnl", "mfe", "mae")
_PATH_CHUNK = 20_000
_BTC = "BTCUSDT"


# ---------------------------------------------------------------------------
# Phase bars and the tau frame
# ---------------------------------------------------------------------------


def phase_bars(five: pd.DataFrame, interval_ms: int, phase_ms: int) -> pd.DataFrame:
    """The coin's 5m bars aggregated into bars [t_b, t_b + interval) with t_b = phase (mod interval).

    open = first 5m open, close = last 5m close, high = max, low = min, v and tbv summed. A bar with any 5m bar
    missing (or non-finite) is absent from the result.
    """
    if interval_ms <= 0 or interval_ms % STEP_MS or phase_ms % STEP_MS or not 0 <= phase_ms < interval_ms:
        raise ValueError(f"need a 5m-aligned interval and a phase in [0, interval), got {interval_ms}, {phase_ms}")
    cols = ["t", "o", "h", "l", "c"]
    extra = [c for c in ("v", "tbv") if c in five.columns]
    d = five.sort_values("t", kind="stable")
    d = d[~d["t"].duplicated(keep="last")]
    t_all = d["t"].to_numpy(dtype=np.int64)
    arr = d[cols].to_numpy(dtype=np.float64)
    ok = np.isfinite(arr).all(axis=1) & (t_all % STEP_MS == 0)
    d = d[ok]
    t = t_all[ok]
    if len(t) == 0:
        return pd.DataFrame({k: [] for k in [*cols, *extra]})
    bins = (t - phase_ms) // interval_ms
    ub, first, counts = np.unique(bins, return_index=True, return_counts=True)
    full = counts == interval_ms // STEP_MS
    f_first = first[full]
    out: dict[str, Any] = {"t": ub[full] * interval_ms + phase_ms}
    o = d["o"].to_numpy(dtype=np.float64)
    c = d["c"].to_numpy(dtype=np.float64)
    out["o"] = o[f_first]
    out["h"] = np.maximum.reduceat(d["h"].to_numpy(dtype=np.float64), first)[full]
    out["l"] = np.minimum.reduceat(d["l"].to_numpy(dtype=np.float64), first)[full]
    out["c"] = c[f_first + counts[full] - 1]
    for col in extra:
        out[col] = np.add.reduceat(d[col].to_numpy(dtype=np.float64), first)[full]
    return pd.DataFrame(out)


def build_tau_frame(coin: Mapping[str, pd.DataFrame], btc_five: pd.DataFrame, interval_ms: int) -> pd.DataFrame:
    """All feature columns at every 15m-grid instant tau_f, indexed by T, float32 (the union over the phases)."""
    five = coin["5m"]
    prem = coin.get("premium_5m", coin.get("premiumIndex"))
    settle = coin.get("settlements", coin.get("funding"))
    parts: list[pd.DataFrame] = []
    for phase in range(0, interval_ms, TAU_GRID_MS):
        pb = phase_bars(five, interval_ms, phase)
        if pb.empty:
            continue
        btc_pb = phase_bars(btc_five, interval_ms, phase)
        parts.append(
            build_feature_frame(
                five_min=five,
                fifteen_min=coin["15m"],
                decision_bars=pb,
                four_h=coin["4h"],
                one_d=coin["1d"],
                premium_5m=prem if prem is not None else pd.DataFrame(),
                settlements=settle if settle is not None else pd.DataFrame(),
                btc_decision_bars=btc_pb,
                decision_interval_ms=interval_ms,
                decision_opens=pb["t"].to_numpy(dtype=np.int64),
            )
        )
    if not parts:
        out = pd.DataFrame(columns=ALL_FEATURE_COLUMNS, index=pd.Index([], dtype=np.int64, name="T"))
    else:
        out = pd.concat(parts).sort_index()
    out = out.reindex(columns=ALL_FEATURE_COLUMNS).astype(np.float32)
    out.index = out.index.astype(np.int64)
    out.index.name = "T"
    return out


def source_digest() -> str:
    """Digest of the code that defines the frame: the feature builder and this module."""
    h = hashlib.sha256()
    for name in ("features.py", "exit_models.py"):
        h.update((Path(__file__).parent / name).read_bytes())
    return h.hexdigest()


def tau_cache_path(cache_dir: Path | str, dataset_hash: str, coin: str, interval: str) -> Path:
    key = hashlib.sha256(f"{dataset_hash}|{source_digest()}|{coin}|{interval}".encode()).hexdigest()[:20]
    return Path(cache_dir) / "exit_tau" / f"{coin}_{interval}_{key}.parquet"


def cached_tau_frame(
    coin: str,
    interval: str,
    build: Callable[[], pd.DataFrame],
    cache_dir: Path | str | None,
    dataset_hash: str | None,
    dataset_dir: Path | str | None = None,
) -> pd.DataFrame:
    """The float32 tau frame from the cache, built and written on a miss. No cache without a dataset hash."""
    if cache_dir is None or dataset_hash is None:
        return build()
    if dataset_dir is not None and Path(dataset_dir).resolve() in Path(cache_dir).resolve().parents:
        raise ValueError("the tau cache must not live inside the dataset directory")
    path = tau_cache_path(cache_dir, dataset_hash, coin, interval)
    if path.exists():
        return pd.read_parquet(path, engine="pyarrow")
    frame = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    frame.to_parquet(tmp, engine="pyarrow")
    tmp.replace(path)
    return frame


@dataclass(frozen=True)
class TauFrame:
    """Market features dense on the 15m grid: row i is the instant t0 + i x 15m, NaN where missing."""

    t0: int
    columns: tuple[str, ...]
    values: np.ndarray  # (n, F) float32

    def market(self, tau_f: np.ndarray, dtype: Any = np.float64) -> np.ndarray:
        tau_f = np.asarray(tau_f, dtype=np.int64)
        rel = tau_f - self.t0
        k = rel // TAU_GRID_MS
        ok = (rel % TAU_GRID_MS == 0) & (k >= 0) & (k < len(self.values))
        out = np.full((len(tau_f), self.values.shape[1]), np.nan, dtype=dtype)
        out[ok] = self.values[k[ok]]
        return out


def dense_tau_frame(frame: pd.DataFrame, columns: tuple[str, ...], grid: tuple[int, int] | None = None) -> TauFrame:
    """Dense 15m-grid arrays of the chosen columns. `grid` (first, last) overrides the frame's own span."""
    if grid is None:
        if len(frame) == 0:
            return TauFrame(0, columns, np.empty((0, len(columns)), dtype=np.float32))
        grid = (int(frame.index.min()), int(frame.index.max()))
    t0, t1 = grid
    n = (t1 - t0) // TAU_GRID_MS + 1
    vals = np.full((n, len(columns)), np.nan, dtype=np.float32)
    real = [c for c in columns if not is_hash_feature(c)]
    if real and len(frame):
        idx = (frame.index.to_numpy(dtype=np.int64) - t0) // TAU_GRID_MS
        inside = (idx >= 0) & (idx < n)
        pos = [columns.index(c) for c in real]
        vals[np.ix_(idx[inside], pos)] = frame[real].to_numpy(dtype=np.float32)[inside]
    return TauFrame(t0, columns, vals)


# ---------------------------------------------------------------------------
# Hold paths: the state and the label of a hypothetical hold at chosen tau
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HoldPaths:
    """Per (hold, tau) arrays of shape (n, m). Long-side MFE/MAE; the short side's are -MAE and -MFE."""

    elapsed: np.ndarray
    lr: np.ndarray  # log(c(tau) / entry open): the long running P&L
    mfe_long: np.ndarray  # log(max high so far / entry), at least 0
    mae_long: np.ndarray  # log(min low so far / entry), at most 0
    core: np.ndarray  # log(open(S) / open(tau + 10m))
    fund: np.ndarray  # sum of settlements in (tau + 10m, S]


def hold_paths(
    b: _Bars,
    settle_t: np.ndarray,
    settle_rate: np.ndarray,
    i0: np.ndarray,
    length: int,
    k: np.ndarray,
) -> HoldPaths:
    """Paths of holds that start at bar index i0 and last `length` 5m bars (S is the open of bar i0 + length).

    k (n, m) holds integers in [1, length - 2]: tau = entry + k x 5m, the close of bar i0 + k - 1. Every bar from i0
    to i0 + length must exist (the caller checks).
    """
    i0 = np.asarray(i0, dtype=np.int64)
    k = np.asarray(k, dtype=np.int64)
    n, m = k.shape
    elapsed = np.empty((n, m))
    lr = np.empty((n, m))
    mfe = np.empty((n, m))
    mae = np.empty((n, m))
    core = np.empty((n, m))
    fund = np.empty((n, m))
    cs = np.concatenate(([0.0], np.cumsum(np.asarray(settle_rate, dtype=np.float64))))
    st = np.asarray(settle_t, dtype=np.int64)
    for a in range(0, n, _PATH_CHUNK):
        sl = slice(a, min(a + _PATH_CHUNK, n))
        ii, kk = i0[sl], k[sl]
        entry_ms = b.t[ii]
        entry = b.o[ii]
        win = ii[:, None] + np.arange(length)[None, :]
        hmax = np.maximum.accumulate(b.h[win], axis=1)
        lmin = np.minimum.accumulate(b.l[win], axis=1)
        r = np.arange(len(ii))[:, None]
        with np.errstate(invalid="ignore", divide="ignore"):
            mfe[sl] = np.maximum(np.log(hmax[r, kk - 1] / entry[:, None]), 0.0)
            mae[sl] = np.minimum(np.log(lmin[r, kk - 1] / entry[:, None]), 0.0)
            lr[sl] = np.log(b.c[ii[:, None] + kk - 1] / entry[:, None])
            core[sl] = np.log(b.o[ii + length][:, None] / b.o[ii[:, None] + kk + 2])
        tau = entry_ms[:, None] + kk * STEP_MS
        s_ms = (entry_ms + length * STEP_MS)[:, None]
        elapsed[sl] = (tau - entry_ms[:, None]) / (s_ms - entry_ms[:, None])
        fund[sl] = (
            cs[np.searchsorted(st, s_ms, side="right")] - cs[np.searchsorted(st, tau + 2 * STEP_MS, side="right")]
        )
    return HoldPaths(elapsed=elapsed, lr=lr, mfe_long=mfe, mae_long=mae, core=core, fund=fund)


# ---------------------------------------------------------------------------
# Training set
# ---------------------------------------------------------------------------


@dataclass
class TrainingSet:
    """Hold-level samples (one row per hold and tau). Both sides are derived from each row, so the set is symmetric."""

    symbol: np.ndarray  # (N,) object
    T: np.ndarray
    tau: np.ndarray
    S: np.ndarray
    market: np.ndarray  # (N, F) float32
    paths: dict[str, np.ndarray]  # elapsed, lr, mfe_long, mae_long, core, fund as (N,)
    columns: tuple[str, ...]
    n_missing_feature: int = 0
    n_label_shift_dropped: int = 0
    n_label_shift_purged: int = 0

    @property
    def n_samples(self) -> int:
        return 2 * len(self.T)

    def state_for(self, side: int) -> np.ndarray:
        p = self.paths
        mfe = p["mfe_long"] if side == 1 else -p["mae_long"]
        mae = p["mae_long"] if side == 1 else -p["mfe_long"]
        return np.column_stack([np.full(len(self.T), float(side)), p["elapsed"], side * p["lr"], mfe, mae])

    def label_for(self, side: int) -> np.ndarray:
        return side * self.paths["core"] - side * self.paths["fund"]

    def rows(self) -> pd.DataFrame:
        """Long-form listing for inspection: symbol, T, tau, S, side, y (both sides stacked)."""
        parts = []
        for s in (1, -1):
            parts.append(
                pd.DataFrame(
                    {
                        "symbol": self.symbol,
                        "T": self.T,
                        "tau": self.tau,
                        "S": self.S,
                        "side": s,
                        "y": self.label_for(s),
                    }
                )
            )
        return pd.concat(parts, ignore_index=True)


@dataclass(frozen=True)
class ExitModelPair:
    """The E4 ridge and the E5 logistic regression of one fold, with their scalers."""

    columns: tuple[str, ...]
    mu: np.ndarray
    sd: np.ndarray
    st_mu: np.ndarray
    st_sd: np.ndarray
    ridge_coef: np.ndarray
    ridge_intercept: float
    logit_coef: np.ndarray
    logit_intercept: float
    se: float
    n_samples: int

    def design(self, market: np.ndarray, state: np.ndarray) -> np.ndarray:
        """[x, side x x, side, elapsed, pnl, mfe, mae] with x and the state standardised."""
        xs = (np.asarray(market, dtype=np.float64) - self.mu) / self.sd
        state = np.asarray(state, dtype=np.float64)
        side = state[:, :1]
        rest = (state[:, 1:] - self.st_mu) / self.st_sd
        return np.hstack([xs, side * xs, side, rest])

    def forecast(self, market: np.ndarray, state: np.ndarray) -> np.ndarray:
        return self.design(market, state) @ self.ridge_coef + self.ridge_intercept

    def prob_up(self, market: np.ndarray, state: np.ndarray) -> np.ndarray:
        z = self.design(market, state) @ self.logit_coef + self.logit_intercept
        return 1.0 / (1.0 + np.exp(-z))


def _scaler(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mu = x.mean(axis=0)
    sd = x.std(axis=0)
    return mu, np.where(sd > 1e-12, sd, 1.0)


def fit_pair(ts: TrainingSet, seed: int) -> ExitModelPair | None:
    """Fit the E4 ridge and the E5 logistic regression on both sides of the set. None below MIN_SAMPLES."""
    if ts.n_samples < MIN_SAMPLES:
        return None
    mu, sd = _scaler(ts.market.astype(np.float64))
    states = np.vstack([ts.state_for(1), ts.state_for(-1)])
    st_mu, st_sd = _scaler(states[:, 1:])
    y = np.concatenate([ts.label_for(1), ts.label_for(-1)])
    pair0 = ExitModelPair(
        ts.columns, mu, sd, st_mu, st_sd, np.empty(0), 0.0, np.empty(0), 0.0, float("nan"), ts.n_samples
    )
    mk2 = np.vstack([ts.market, ts.market])
    x = np.empty((len(y), 2 * mu.size + 5), dtype=np.float32)
    for a in range(0, len(y), 100_000):
        sl = slice(a, min(a + 100_000, len(y)))
        x[sl] = pair0.design(mk2[sl], states[sl])
    del mk2
    ridge = Ridge(alpha=RIDGE_ALPHA, random_state=seed).fit(x, y)
    resid = y - ridge.predict(x).astype(np.float64)
    se = float(resid.std(ddof=1))
    label = (y > 0.0).astype(np.int64)
    if label.min() == label.max():
        rate = float(np.clip(label.mean(), 1e-6, 1.0 - 1e-6))
        w, b0 = np.zeros(x.shape[1]), float(np.log(rate / (1.0 - rate)))
    else:
        logit = LogisticRegression(max_iter=1000, random_state=seed).fit(x, label)
        w, b0 = logit.coef_[0].astype(np.float64), float(logit.intercept_[0])
    return ExitModelPair(
        ts.columns,
        mu,
        sd,
        st_mu,
        st_sd,
        ridge.coef_.astype(np.float64),
        float(ridge.intercept_),
        w,
        b0,
        se,
        ts.n_samples,
    )


@dataclass(frozen=True)
class ExitModelInputs:
    """A fitted pair with the per-coin tau frames: what the replay and the state machine consume."""

    pair: ExitModelPair
    frames: Mapping[str, TauFrame]

    def market(self, symbol: str, tau_f: np.ndarray) -> np.ndarray:
        return self.frames[symbol].market(tau_f)


class ExitModelFactory:
    """Builds the tau frames of a panel once and fits one model pair per fold."""

    def __init__(
        self,
        panel: Mapping[str, Mapping[str, pd.DataFrame]],
        interval: str,
        h_ms: int,
        features: tuple[str, ...],
        seed: int,
        noise_seed: int | None = None,
        plant: dict[str, Any] | None = None,
        cache_dir: Path | str | None = None,
        dataset_hash: str | None = None,
        dataset_dir: Path | str | None = None,
        label_shift_ms: int = 0,
    ):
        if "planted_z" in features:
            raise ValueError("planted_z is keyed to decision times and cannot be served at tau_f")
        self.panel = panel
        self.interval = interval
        self.interval_ms = {"1h": 3_600_000, "4h": 14_400_000}[interval]
        self.h_ms = int(h_ms)
        self.features = tuple(features)
        self.seed = int(seed)
        self.noise_seed = noise_seed
        self.plant = plant
        self.cache_dir = cache_dir
        self.dataset_hash = dataset_hash
        self.dataset_dir = dataset_dir
        self.label_shift_ms = int(label_shift_ms)
        self.length = self.h_ms // STEP_MS
        if self.h_ms % STEP_MS or self.length < 6:
            raise ValueError(f"h_ms must be a multiple of 5m and at least 30m, got {h_ms}")
        self._bars: dict[str, _Bars] = {}
        self._frames: dict[str, TauFrame] | None = None
        self._missing: dict[str, np.ndarray] = {}
        self.last_dropped = 0
        self.last_purged = 0

    @classmethod
    def from_config(
        cls,
        panel: Mapping[str, Mapping[str, pd.DataFrame]],
        cfg: Any,
        label_shift_ms: int = 0,
        **kw: Any,
    ) -> ExitModelFactory:
        shift = kw.pop("label_shift_ms", label_shift_ms)
        return cls(
            panel,
            cfg.interval,
            cfg.h_ms,
            tuple(cfg.features),
            cfg.seed,
            cfg.noise_seed,
            cfg.plant,
            label_shift_ms=shift,
            **kw,
        )

    def bars(self, symbol: str) -> _Bars:
        if symbol not in self._bars:
            self._bars[symbol] = prepare_bars({symbol: self.panel[symbol]["5m"]})[symbol]
        return self._bars[symbol]

    def frames(self) -> dict[str, TauFrame]:
        if self._frames is None:
            real = [f for f in self.features if not is_hash_feature(f)]
            out: dict[str, TauFrame] = {}
            for sym in self.panel:
                if real:
                    if _BTC not in self.panel:
                        raise ValueError("the tau frame needs BTCUSDT in the panel")
                    base = cached_tau_frame(
                        sym,
                        self.interval,
                        lambda sym=sym: build_tau_frame(self.panel[sym], self.panel[_BTC]["5m"], self.interval_ms),
                        self.cache_dir,
                        self.dataset_hash,
                        self.dataset_dir,
                    )
                    tf = dense_tau_frame(base, self.features)
                else:
                    b = self.bars(sym)
                    base = pd.DataFrame()
                    first = int(-(-int(b.t[0]) // TAU_GRID_MS) * TAU_GRID_MS) if len(b.t) else 0
                    last = int(b.t[-1] // TAU_GRID_MS * TAU_GRID_MS) if len(b.t) else 0
                    tf = dense_tau_frame(base, self.features, (first, last))
                hashed = [f for f in self.features if is_hash_feature(f)]
                if hashed:
                    grid = tf.t0 + np.arange(len(tf.values), dtype=np.int64) * TAU_GRID_MS
                    hv = hash_feature_matrix(hashed, sym, list(self.panel), grid, self.noise_seed, self.plant)
                    vals = tf.values.copy()
                    vals[:, [self.features.index(f) for f in hashed]] = hv.astype(np.float32)
                    tf = TauFrame(tf.t0, tf.columns, vals)
                out[sym] = tf
            self._frames = out
        return self._frames

    def _missing_settlements(self, symbol: str) -> np.ndarray:
        if symbol not in self._missing:
            from r4.pipeline import compute_missing_settlement_times

            fr = self.panel[symbol]
            settle = fr.get("settlements", fr.get("funding"))
            self._missing[symbol] = np.array(sorted(compute_missing_settlement_times(settle)), dtype=np.int64)
        return self._missing[symbol]

    def _settlements(self, symbol: str) -> tuple[np.ndarray, np.ndarray]:
        fr = self.panel[symbol]
        settle = fr.get("settlements", fr.get("funding"))
        if settle is None or len(settle) == 0:
            return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.float64)
        d = settle.sort_values("t", kind="stable")
        d = d[~d["t"].duplicated(keep="last")]
        return d["t"].to_numpy(dtype=np.int64), d["rate"].to_numpy(dtype=np.float64)

    def training_set(
        self,
        t_start: int | None,
        cut_ms: int,
        select: Callable[[np.ndarray, np.ndarray], np.ndarray] | None = None,
    ) -> TrainingSet:
        """The samples of the holds with T >= t_start and S < cut_ms (and select(T, S), when given)."""
        frames = self.frames()
        cols = self.features
        parts: dict[str, list[np.ndarray]] = {k: [] for k in ("symbol", "T", "tau", "S", "market")}
        path_parts: dict[str, list[np.ndarray]] = {
            k: [] for k in ("elapsed", "lr", "mfe_long", "mae_long", "core", "fund")
        }
        n_missing = 0
        n_shift_dropped = 0
        n_shift_purged = 0
        length = self.length
        n_k = length - 2
        n_draw = min(SAMPLES_PER_HOLD, n_k)
        for sym in self.panel:
            b = self.bars(sym)
            dec = self.panel[sym].get(self.interval)
            if dec is None or len(dec) == 0 or len(b.t) == 0:
                continue
            T = np.sort(dec["t"].to_numpy(dtype=np.int64)) + self.interval_ms
            entry = T + ENTRY_DELAY_MS
            S = entry + self.h_ms
            keep = S < cut_ms
            if t_start is not None:
                keep &= T >= t_start
            if select is not None:
                keep &= np.asarray(select(T, S), dtype=bool)
            nb = len(b.t)
            i0 = np.searchsorted(b.t, entry)
            i1 = np.searchsorted(b.t, S)
            keep &= (i0 < nb) & (i1 < nb)
            i0c, i1c = np.minimum(i0, nb - 1), np.minimum(i1, nb - 1)
            keep &= (b.t[i0c] == entry) & (b.t[i1c] == S) & (i1 - i0 == length)
            keep &= (b.o[i0c] > 0.0) & (b.o[i1c] > 0.0)
            miss = self._missing_settlements(sym)
            if len(miss):
                keep &= np.searchsorted(miss, S, side="right") == np.searchsorted(miss, entry, side="right")
            sel = np.flatnonzero(keep)
            if len(sel) == 0:
                continue
            rng = np.random.default_rng([self.seed, zlib.crc32(sym.encode())])
            draw = np.argsort(rng.random((len(sel), n_k)), axis=1)[:, :n_draw] + 1
            draw.sort(axis=1)

            if self.label_shift_ms == 0:
                st, sr = self._settlements(sym)
                hp = hold_paths(b, st, sr, i0[sel], length, draw)
                tau = entry[sel][:, None] + draw * STEP_MS
                tau_f = tau - tau % TAU_GRID_MS
                mk = frames[sym].market(tau_f.ravel(), dtype=np.float32)
                good = np.isfinite(mk).all(axis=1)
                for p in path_parts:
                    path_parts[p].append(getattr(hp, p).ravel()[good])
                n_missing += int((~good).sum())
                parts["symbol"].append(np.full(int(good.sum()), sym, dtype=object))
                parts["T"].append(np.repeat(T[sel], n_draw)[good])
                parts["tau"].append(tau.ravel()[good])
                parts["S"].append(np.repeat(S[sel], n_draw)[good])
                parts["market"].append(mk[good])
            else:
                T_all = np.sort(np.unique(dec["t"].to_numpy(dtype=np.int64))) + self.interval_ms
                lo = int(T_all[0])
                hi = int(T_all[-1])
                circle_length = hi - lo + self.interval_ms

                T_sel = T[sel]
                entry_sel = entry[sel]
                S_sel = S[sel]
                tp = lo + (T_sel - lo + self.label_shift_ms) % circle_length
                pos = np.searchsorted(T_all, tp)
                pos_c = np.minimum(pos, len(T_all) - 1)
                exists = (pos < len(T_all)) & (T_all[pos_c] == tp)

                entry_prime = tp + ENTRY_DELAY_MS
                S_prime = entry_prime + self.h_ms

                purged = S_prime >= (cut_ms - CPCV_EMBARGO_MS)

                valid = exists & (~purged)
                i0_src = np.searchsorted(b.t, entry_prime)
                i1_src = np.searchsorted(b.t, S_prime)
                valid &= (i0_src < nb) & (i1_src < nb)
                i0c_src, i1c_src = np.minimum(i0_src, nb - 1), np.minimum(i1_src, nb - 1)
                valid &= (b.t[i0c_src] == entry_prime) & (b.t[i1c_src] == S_prime) & (i1_src - i0_src == length)
                valid &= (b.o[i0c_src] > 0.0) & (b.o[i1c_src] > 0.0)
                if len(miss):
                    valid &= np.searchsorted(miss, S_prime, side="right") == np.searchsorted(
                        miss, entry_prime, side="right"
                    )

                dropped = (~purged) & (~valid)
                n_shift_purged += int(purged.sum()) * n_draw
                n_shift_dropped += int(dropped.sum()) * n_draw

                sel_valid = np.flatnonzero(valid)
                if len(sel_valid) == 0:
                    continue

                draw_v = draw[sel_valid]
                i0_v_src = i0_src[sel_valid]
                i1_v_src = i1_src[sel_valid]
                entry_prime_v = entry_prime[sel_valid]
                S_prime_v = S_prime[sel_valid]

                o_tau_prime_10m = b.o[i0_v_src[:, None] + draw_v + 2]
                o_S_prime = b.o[i1_v_src][:, None]
                pos_opens = (o_tau_prime_10m > 0.0) & np.isfinite(o_tau_prime_10m)

                st, sr = self._settlements(sym)
                cs = np.concatenate(([0.0], np.cumsum(np.asarray(sr, dtype=np.float64))))
                tau_prime = entry_prime_v[:, None] + draw_v * STEP_MS
                tau_prime_10m = tau_prime + 2 * STEP_MS
                s_prime_mat = S_prime_v[:, None]
                fund_v = (
                    cs[np.searchsorted(st, s_prime_mat, side="right")]
                    - cs[np.searchsorted(st, tau_prime_10m, side="right")]
                )

                with np.errstate(invalid="ignore", divide="ignore"):
                    core_v = np.log(o_S_prime / o_tau_prime_10m)

                hp = hold_paths(b, st, sr, i0[sel][sel_valid], length, draw_v)

                tau_real = entry_sel[sel_valid][:, None] + draw_v * STEP_MS
                tau_f = tau_real - tau_real % TAU_GRID_MS
                mk = frames[sym].market(tau_f.ravel(), dtype=np.float32)
                good = np.isfinite(mk).all(axis=1)

                pos_opens_flat = pos_opens.ravel()
                bad_src = ~pos_opens_flat
                if bad_src.any():
                    n_shift_dropped += int(bad_src.sum())

                keep_sample = pos_opens_flat & good
                n_missing += int((pos_opens_flat & ~good).sum())

                if not keep_sample.any():
                    continue

                path_parts["elapsed"].append(hp.elapsed.ravel()[keep_sample])
                path_parts["lr"].append(hp.lr.ravel()[keep_sample])
                path_parts["mfe_long"].append(hp.mfe_long.ravel()[keep_sample])
                path_parts["mae_long"].append(hp.mae_long.ravel()[keep_sample])
                path_parts["core"].append(core_v.ravel()[keep_sample])
                path_parts["fund"].append(fund_v.ravel()[keep_sample])

                parts["symbol"].append(np.full(int(keep_sample.sum()), sym, dtype=object))
                parts["T"].append(np.repeat(T_sel[sel_valid], n_draw)[keep_sample])
                parts["tau"].append(tau_real.ravel()[keep_sample])
                parts["S"].append(np.repeat(S_sel[sel_valid], n_draw)[keep_sample])
                parts["market"].append(mk[keep_sample])

        self.last_dropped = n_shift_dropped
        self.last_purged = n_shift_purged

        if not parts["T"]:
            return TrainingSet(
                np.empty(0, dtype=object),
                np.empty(0, dtype=np.int64),
                np.empty(0, dtype=np.int64),
                np.empty(0, dtype=np.int64),
                np.empty((0, len(cols)), dtype=np.float32),
                {k: np.empty(0) for k in path_parts},
                cols,
                n_missing,
                n_shift_dropped,
                n_shift_purged,
            )
        return TrainingSet(
            np.concatenate(parts["symbol"]),
            np.concatenate(parts["T"]),
            np.concatenate(parts["tau"]),
            np.concatenate(parts["S"]),
            np.concatenate(parts["market"]),
            {k: np.concatenate(v) for k, v in path_parts.items()},
            cols,
            n_missing,
            n_shift_dropped,
            n_shift_purged,
        )

    def fit(
        self,
        t_start: int | None,
        cut_ms: int,
        select: Callable[[np.ndarray, np.ndarray], np.ndarray] | None = None,
    ) -> ExitModelInputs | None:
        """The fold's model pair with the tau frames, or None when the window gives fewer than MIN_SAMPLES samples."""
        pair = fit_pair(self.training_set(t_start, cut_ms, select), self.seed)
        return None if pair is None else ExitModelInputs(pair, self.frames())


def exit_hold_diagnostic(entries: pd.DataFrame, replayed: pd.DataFrame) -> float:
    """Median over tranches of (actual hold) / (scheduled hold), from entry_ms. Registered (not gated) at >= 0.8 on
    synthetic no-edge panels. entries and replayed are aligned row for row (replayed is a replay_exits result)."""
    entry = entries["entry_ms"].to_numpy(dtype=np.float64)
    sched = entries["exit_ms"].to_numpy(dtype=np.float64)
    actual = replayed["exit_ms"].to_numpy(dtype=np.float64)
    if len(entry) == 0:
        return float("nan")
    return float(np.median((actual - entry) / (sched - entry)))


__all__ = [
    "MIN_SAMPLES",
    "SAMPLES_PER_HOLD",
    "STATE_COLUMNS",
    "ExitModelFactory",
    "ExitModelInputs",
    "ExitModelPair",
    "HoldPaths",
    "TauFrame",
    "TrainingSet",
    "build_tau_frame",
    "cached_tau_frame",
    "dense_tau_frame",
    "exit_hold_diagnostic",
    "fit_pair",
    "hold_paths",
    "phase_bars",
    "source_digest",
    "tau_cache_path",
]
