"""Round 4 pipeline: panel loader, decision samples, and walk-forward runner."""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.preprocessing import StandardScaler

from r4.book import (
    DAY_MS,
    LegCosts,
    Tranche,
    _beta_missing,
    beta_hedged_daily,
    daily_book,
    daily_close_log_returns,
    daily_series,
    estimate_betas,
    netted_costs,
    parse_interval_ms,
    trade_level,
)
from r4.costs import DEFAULT_FEE_PROFILE, coin_slippage_bps, resolve_fee_profile
from r4.data import load_funding, load_perp
from r4.exit_models import ExitModelFactory
from r4.exits import ExitContext, ExitSpec, is_horizon, parse_exit
from r4.features import ALL_FEATURE_COLUMNS, build_feature_frame
from r4.hashfeat import hash_feature_matrix, is_hash_feature, is_noise_feature
from r4.labels import trailing_sigma_h, triple_barrier
from r4.method import (
    CPCV_EMBARGO_MS,
    DEV_END,
    DEV_START,
    ENTRY_DELAY_MS,
    SIGMA_TRAILING_MS,
    TRIPLE_BARRIER_K,
    UNIVERSE,
)
from r4.plant import validate_plant

logger = logging.getLogger(__name__)

# Column a shifted-label frame carries: the window end (t1_max) of the row its labels came from.
SOURCE_WINDOW_COLUMN = "label_t1_max"

# Test-only: build the feature frame even when every feature is a hash feature (parity check of the fast path).
_FORCE_SLOW_PATH = False


class _SharedPanel(dict[str, dict[str, pd.DataFrame]]):
    """Share read-only input frames when pandas copies sample attrs within a run."""

    def __deepcopy__(self, memo: dict[int, Any]) -> _SharedPanel:
        memo[id(self)] = self
        return self


@dataclass(frozen=True)
class RunConfig:
    family: str
    model: str  # "ridge", "logistic", or "lightgbm"
    params: dict[str, Any]
    features: tuple[str, ...]
    interval: str  # "1h" or "4h"
    h_ms: int
    label: str  # "fixed" or "triple_barrier"
    side_rule: str  # "sign" or "prob"
    threshold: float
    size_rule: str  # "unit"
    lookback_months: int | None
    refit: str  # "monthly" or "none"
    exit: str | ExitSpec  # "horizon" (E1) or a parsed E2, E3 or X1 spec; a dict is parsed on construction
    seed: int = 7
    book: str = "slot"  # "slot" (per-coin slot tranches) or "D" (dollar-neutral rank weights)
    noise_seed: int | None = None  # required when a feature is noise_00 to noise_99
    plant: dict[str, Any] | None = None  # {"seed", "amplitude"}: planted signal, required by planted_z

    def __post_init__(self) -> None:
        if self.size_rule != "unit":
            raise ValueError(f"unknown size_rule {self.size_rule!r}: only 'unit' exists")
        if self.label not in ("fixed", "triple_barrier"):
            raise ValueError(f"unknown label {self.label!r}: use 'fixed' or 'triple_barrier'")
        expected_side_rule = "sign" if self.model == "ridge" else "prob"
        if self.side_rule != expected_side_rule:
            raise ValueError(
                f"side_rule {self.side_rule!r} does not match model {self.model!r}: "
                f"ridge uses 'sign', the classifiers use 'prob' (expected {expected_side_rule!r})"
            )
        if self.plant is not None:
            validate_plant(self.plant, self.interval, self.h_ms)
        if "planted_z" in self.features and self.plant is None:
            raise ValueError("feature planted_z requires a plant")
        if any(is_noise_feature(f) for f in self.features) and (
            isinstance(self.noise_seed, bool) or not isinstance(self.noise_seed, int)
        ):
            raise ValueError("noise features require an int noise_seed")
        parsed = parse_exit(self.exit)
        object.__setattr__(self, "exit", "horizon" if parsed.rule == "E1" else parsed)
        if self.book not in ("slot", "D"):
            raise ValueError(f"book must be 'slot' or 'D', got {self.book!r}")
        if self.family == "D" and self.book != "D":
            raise ValueError("family D requires book 'D'")


@dataclass
class FoldRecord:
    """One evaluated walk-forward fold: its span, the betas used, its tranches and its beta-hedged book."""

    start_ms: int
    end_ms: int
    train_cut_ms: int | None  # None means all history
    betas: dict[str, float]  # as used for the fold, NaN where not estimable
    tranches: list[Tranche]
    book: pd.DataFrame  # beta_hedged_daily output for this fold's tranches


@dataclass
class RunResult:
    trades: pd.DataFrame
    book_raw: pd.DataFrame
    drift_free: pd.DataFrame
    refits: int
    n_samples: int
    n_dropped: int
    config: dict[str, Any]
    excluded_tranches: int = 0
    folds: list[FoldRecord] = field(default_factory=list)
    tranches: list[Tranche] = field(default_factory=list)
    exit_reason_counts: dict[str, int] = field(default_factory=dict)
    missing_sigma_tranches: int = 0
    missing_flow_tranches: int = 0
    missing_funding_tranches: int = 0
    missing_model_tranches: int = 0
    exit_model_folds: int = 0  # E4 and E5: folds that fitted a model pair
    exit_model_fallback_folds: int = 0  # E4 and E5: folds with too few samples, run as E1
    exit_model_fallback_tranches: int = 0


def load_panel(
    ds_dir: str | Path,
    symbols: Sequence[str],
    cache_dir: str | Path | None = None,
) -> dict[str, dict[str, pd.DataFrame]]:
    """Load perpetual klines, premium index, and funding settlements for symbols."""
    panel: dict[str, dict[str, pd.DataFrame]] = {}
    for sym in symbols:
        p_5m = load_perp(ds_dir, sym, "5m", series="klines", cache_dir=cache_dir).rows
        p_15m = load_perp(ds_dir, sym, "15m", series="klines", cache_dir=cache_dir).rows
        p_1h = load_perp(ds_dir, sym, "1h", series="klines", cache_dir=cache_dir).rows
        p_4h = load_perp(ds_dir, sym, "4h", series="klines", cache_dir=cache_dir).rows
        p_1d = load_perp(ds_dir, sym, "1d", series="klines", cache_dir=cache_dir).rows
        prem = load_perp(ds_dir, sym, "5m", series="premiumIndex", cache_dir=cache_dir).rows
        fund = load_funding(ds_dir, sym, cache_dir=cache_dir).rows

        panel[sym] = {
            "5m": p_5m,
            "15m": p_15m,
            "1h": p_1h,
            "4h": p_4h,
            "1d": p_1d,
            "premium_5m": prem,
            "premiumIndex": prem,
            "settlements": fund,
            "funding": fund,
        }
    return panel


def compute_missing_settlement_times(settlements: pd.DataFrame | None) -> set[int]:
    """Compute expected funding settlement times that are missing from settlements DataFrame."""
    if settlements is None or settlements.empty or "t" not in settlements.columns:
        return set()

    df = settlements.sort_values("t").reset_index(drop=True)
    t_vals = df["t"].to_numpy(dtype=np.int64)
    has_interval = "intervalHours" in df.columns

    missing: set[int] = set()
    n = len(t_vals)
    for i in range(1, n):
        prev_t = int(t_vals[i - 1])
        curr_t = int(t_vals[i])
        hours = 8
        if has_interval:
            val = df["intervalHours"].iloc[i]
            if pd.notna(val) and float(val) > 0:
                hours = int(val)
        step_ms = hours * 3_600_000

        expected_t = prev_t + step_ms
        while expected_t < curr_t:
            missing.add(expected_t)
            expected_t += step_ms

    if n > 0:
        last_t = int(t_vals[-1])
        hours = 8
        if has_interval:
            val = df["intervalHours"].iloc[-1]
            if pd.notna(val) and float(val) > 0:
                hours = int(val)
        step_ms = hours * 3_600_000
        expected_t = last_t + step_ms
        while expected_t < DEV_END:
            missing.add(expected_t)
            expected_t += step_ms

    return missing


def decision_samples(
    panel: dict[str, dict[str, pd.DataFrame]],
    cfg: RunConfig,
    btc_symbol: str = "BTCUSDT",
) -> pd.DataFrame:
    """Generate aligned decision samples across panel symbols."""
    interval_ms = 3_600_000 if cfg.interval == "1h" else 14_400_000
    btc_dec = panel[btc_symbol][cfg.interval]

    per_symbol_dfs: list[pd.DataFrame] = []
    total_dropped = 0

    for s, data_dict in panel.items():
        dec_bars = data_dict[cfg.interval]
        if dec_bars.empty or "t" not in dec_bars.columns:
            continue

        dec_sorted = dec_bars.sort_values("t").reset_index(drop=True)
        dec_opens = dec_sorted["t"].to_numpy(dtype=np.int64)
        T_arr = dec_opens + interval_ms
        n_candidates = len(T_arr)
        if n_candidates == 0:
            continue

        df_5m = data_dict["5m"]
        df_15m = data_dict["15m"]
        df_4h = data_dict["4h"]
        df_1d = data_dict["1d"]
        df_prem = data_dict.get("premium_5m", data_dict.get("premiumIndex", pd.DataFrame()))
        df_settle = data_dict.get("settlements", data_dict.get("funding", pd.DataFrame()))

        feat_names = list(cfg.features)
        real_idx = [i for i, f in enumerate(feat_names) if not is_hash_feature(f)]
        hash_idx = [i for i, f in enumerate(feat_names) if is_hash_feature(f)]
        sub_feats = np.empty((n_candidates, len(feat_names)), dtype=np.float64)
        # Hash features are never NaN, so a configuration made only of them needs no feature frame.
        if real_idx or _FORCE_SLOW_PATH:
            feat_df = build_feature_frame(
                five_min=df_5m,
                fifteen_min=df_15m,
                decision_bars=dec_bars,
                four_h=df_4h,
                one_d=df_1d,
                premium_5m=df_prem,
                settlements=df_settle,
                btc_decision_bars=btc_dec,
                decision_interval_ms=interval_ms,
                decision_opens=dec_opens,
            )
            if real_idx:
                real_names = [feat_names[i] for i in real_idx]
                sub_feats[:, real_idx] = feat_df.reindex(index=T_arr)[real_names].to_numpy(dtype=np.float64)
        if hash_idx:
            sub_feats[:, hash_idx] = hash_feature_matrix(
                [feat_names[i] for i in hash_idx], s, list(panel), T_arr, cfg.noise_seed, cfg.plant
            )
        feat_has_nan = np.isnan(sub_feats).any(axis=1)

        t_5m = df_5m["t"].to_numpy(dtype=np.int64) if "t" in df_5m.columns else np.empty(0, dtype=np.int64)
        o_5m = df_5m["o"].to_numpy(dtype=np.float64) if "o" in df_5m.columns else np.empty(0, dtype=np.float64)

        if len(t_5m) > 0:
            sort_5m = np.argsort(t_5m)
            t_5m_sorted = t_5m[sort_5m]
            o_5m_sorted = o_5m[sort_5m]

            entry_times = T_arr + ENTRY_DELAY_MS
            exit_times = entry_times + cfg.h_ms

            idx_e = np.searchsorted(t_5m_sorted, entry_times)
            valid_e = (idx_e < len(t_5m_sorted)) & (t_5m_sorted[np.minimum(idx_e, len(t_5m_sorted) - 1)] == entry_times)
            entries = np.full(n_candidates, np.nan, dtype=np.float64)
            entries[valid_e] = o_5m_sorted[idx_e[valid_e]]

            idx_x = np.searchsorted(t_5m_sorted, exit_times)
            valid_x = (idx_x < len(t_5m_sorted)) & (t_5m_sorted[np.minimum(idx_x, len(t_5m_sorted) - 1)] == exit_times)
            exits = np.full(n_candidates, np.nan, dtype=np.float64)
            exits[valid_x] = o_5m_sorted[idx_x[valid_x]]
        else:
            entry_times = T_arr + ENTRY_DELAY_MS
            exit_times = entry_times + cfg.h_ms
            entries = np.full(n_candidates, np.nan, dtype=np.float64)
            exits = np.full(n_candidates, np.nan, dtype=np.float64)

        valid_prices = (entries > 0.0) & (exits > 0.0)
        gross_log = np.full(n_candidates, np.nan, dtype=np.float64)
        gross_log[valid_prices] = np.log(exits[valid_prices] / entries[valid_prices])

        missing_settle_times = compute_missing_settlement_times(df_settle)
        sorted_missing = (
            np.array(sorted(missing_settle_times), dtype=np.int64)
            if missing_settle_times
            else np.empty(0, dtype=np.int64)
        )
        if len(sorted_missing) > 0:
            idx_l = np.searchsorted(sorted_missing, entry_times, side="right")
            idx_r = np.searchsorted(sorted_missing, exit_times, side="right")
            lacks_funding = idx_r > idx_l
        else:
            lacks_funding = np.zeros(n_candidates, dtype=bool)

        exceeds_dev = exit_times >= DEV_END

        if cfg.label == "triple_barrier":
            sigma_series = trailing_sigma_h(
                T_arr,
                df_5m,
                h_ms=cfg.h_ms,
                trailing_ms=SIGMA_TRAILING_MS,
            )
            tb_df = triple_barrier(
                decision_times=T_arr,
                five_min=df_5m,
                h_ms=cfg.h_ms,
                sigma_h=sigma_series,
                k_up=TRIPLE_BARRIER_K,
                k_down=TRIPLE_BARRIER_K,
                side=1,
                interval=cfg.interval,
                settlements=df_settle,
                delay_ms=ENTRY_DELAY_MS,
                symbol=s,
            )
            tb_short_df = triple_barrier(
                decision_times=T_arr,
                five_min=df_5m,
                h_ms=cfg.h_ms,
                sigma_h=sigma_series,
                k_up=TRIPLE_BARRIER_K,
                k_down=TRIPLE_BARRIER_K,
                side=-1,
                interval=cfg.interval,
                settlements=df_settle,
                delay_ms=ENTRY_DELAY_MS,
                symbol=s,
            )
            tb_label = tb_df["label"].to_numpy(dtype=np.float64)
            tb_net = tb_df["net"].to_numpy(dtype=np.float64)
            tb_exit = tb_df["exit"].to_numpy(dtype=np.float64)
            tb_label_short = tb_short_df["label"].to_numpy(dtype=np.float64)
            tb_net_short = tb_short_df["net"].to_numpy(dtype=np.float64)
            tb_exit_short = tb_short_df["exit"].to_numpy(dtype=np.float64)
            label_has_nan = np.isnan(tb_label) | np.isnan(tb_label_short)
        else:
            tb_label = None
            tb_net = None
            tb_exit = None
            tb_label_short = None
            tb_net_short = None
            tb_exit_short = None
            label_has_nan = np.isnan(gross_log)

        drop_mask = exceeds_dev | lacks_funding | feat_has_nan | label_has_nan
        n_dropped_sym = int(np.sum(drop_mask))
        total_dropped += n_dropped_sym

        keep_mask = ~drop_mask
        n_kept = int(np.sum(keep_mask))
        if n_kept == 0:
            continue

        sym_cols: dict[str, Any] = {
            "symbol": np.full(n_kept, s, dtype=object),
            "T": T_arr[keep_mask],
        }
        for feat_idx, col in enumerate(cfg.features):
            sym_cols[col] = sub_feats[keep_mask, feat_idx]

        sym_cols["entry"] = entries[keep_mask]
        sym_cols["exit"] = exits[keep_mask]
        sym_cols["gross_log"] = gross_log[keep_mask]
        sym_cols["t0"] = T_arr[keep_mask]
        sym_cols["t1_max"] = exit_times[keep_mask]

        if cfg.label == "triple_barrier":
            assert tb_label is not None and tb_net is not None and tb_exit is not None
            sym_cols["tb_label"] = tb_label[keep_mask]
            sym_cols["tb_net"] = tb_net[keep_mask]
            sym_cols["tb_exit"] = tb_exit[keep_mask]
            assert tb_label_short is not None and tb_net_short is not None and tb_exit_short is not None
            sym_cols["tb_label_short"] = tb_label_short[keep_mask]
            sym_cols["tb_net_short"] = tb_net_short[keep_mask]
            sym_cols["tb_exit_short"] = tb_exit_short[keep_mask]

        per_symbol_dfs.append(pd.DataFrame(sym_cols))

    if per_symbol_dfs:
        combined = pd.concat(per_symbol_dfs, ignore_index=True)
        combined = combined.sort_values(["T", "symbol"]).reset_index(drop=True)
    else:
        out_cols = ["symbol", "T", *cfg.features, "entry", "exit", "gross_log", "t0", "t1_max"]
        if cfg.label == "triple_barrier":
            out_cols.extend(["tb_label", "tb_net", "tb_exit", "tb_label_short", "tb_net_short", "tb_exit_short"])
        combined = pd.DataFrame(columns=out_cols)

    combined.attrs["n_dropped"] = total_dropped
    combined.attrs["panel"] = _SharedPanel({symbol: dict(frames) for symbol, frames in panel.items()})
    logger.info("decision_samples: dropped %d rows, kept %d rows", total_dropped, len(combined))
    return combined


def _make_model(cfg: RunConfig) -> Any:
    params = dict(cfg.params)
    if cfg.model == "ridge":
        params.setdefault("random_state", cfg.seed)
        return Ridge(**params)
    if cfg.model == "logistic":
        params.setdefault("max_iter", 1000)
        params.setdefault("random_state", cfg.seed)
        return LogisticRegression(**params)
    if cfg.model == "lightgbm":
        params.setdefault("random_state", cfg.seed)
        params.setdefault("deterministic", True)
        params.setdefault("force_row_wise", True)  # LightGBM pairs deterministic with a forced histogram layout
        params.setdefault("n_jobs", 2)
        params.setdefault("verbose", -1)
        return LGBMClassifier(**params)
    raise ValueError(f"Unknown model: {cfg.model}")


@dataclass(frozen=True)
class SideModel:
    """A fitted side model: one ridge, or an independent up and down binary pair.

    `up` and `dn` are fitted classifiers or, for a degenerate side, the constant training base rate.
    `degenerate_fits` names the sides ("up", "down") whose training labels held a single class.
    `base_up` and `base_dn` are the training base rates of the two labels.
    The classifier threshold is a margin over them.
    """

    kind: str  # "ridge" or "binary"
    ridge: Any
    up: Any
    dn: Any
    degenerate_fits: tuple[str, ...]
    base_up: float = 0.0
    base_dn: float = 0.0


def _binary_labels(train_df: pd.DataFrame, cfg: RunConfig) -> tuple[np.ndarray, np.ndarray]:
    if cfg.label == "triple_barrier":
        # Each side counts only its own take-profit: label 1 of the side=1 run (long) and of the side=-1 run (short).
        y_up = (train_df["tb_label"] == 1.0).astype(int).to_numpy()
        y_dn = (train_df["tb_label_short"] == 1.0).astype(int).to_numpy()
        return y_up, y_dn
    # Per-coin round trip: 2 x (taker fee + the coin's slippage), from each training row's symbol.
    taker_fee = resolve_fee_profile(DEFAULT_FEE_PROFILE).taker_fee
    rt_by_symbol = {
        sym: 2.0 * (taker_fee + coin_slippage_bps(str(sym)) / 10_000.0) for sym in train_df["symbol"].unique()
    }
    rt_cost = train_df["symbol"].map(rt_by_symbol).to_numpy(dtype=np.float64)
    gross = train_df["gross_log"].to_numpy(dtype=np.float64)
    return (gross > rt_cost).astype(int), (gross < -rt_cost).astype(int)


def fit_side_model(cfg: RunConfig, x_train: np.ndarray, train_df: pd.DataFrame) -> SideModel:
    if cfg.model == "ridge":
        ridge = _make_model(cfg)
        ridge.fit(x_train, train_df["gross_log"].to_numpy(dtype=np.float64))
        return SideModel("ridge", ridge, None, None, ())
    y_up, y_dn = _binary_labels(train_df, cfg)
    fitted: list[Any] = []
    degenerate: list[str] = []
    for name, y in (("up", y_up), ("down", y_dn)):
        if len(np.unique(y)) < 2:
            degenerate.append(name)
            logger.warning("degenerate %s fit: training labels hold one class", name)
            fitted.append(float(y.mean()) if len(y) else 0.0)
            continue
        model = _make_model(cfg)
        model.fit(x_train, y)
        fitted.append(model)
    base_up = float(y_up.mean()) if len(y_up) else 0.0
    base_dn = float(y_dn.mean()) if len(y_dn) else 0.0
    return SideModel("binary", None, fitted[0], fitted[1], tuple(degenerate), base_up, base_dn)


def _side_proba(side: Any, x_test: np.ndarray) -> np.ndarray:
    if isinstance(side, float):
        return np.full(len(x_test), side, dtype=np.float64)
    return side.predict_proba(x_test)[:, 1]


MIN_D_COINS = 6


def rank_weights(times: np.ndarray, scores: np.ndarray) -> np.ndarray:
    """Family D dollar-neutral target weights, ranked among the rows that share a decision time.

    At each time with at least MIN_D_COINS rows: average ranks (ties share), centred c = rank - (n + 1) / 2,
    w = c / sum |c|, so sum |w| = 1 and sum w = 0. Fewer rows, or all scores tied, give zero weights (cash).
    A median coin of an odd count gets exactly 0.
    """
    times = np.asarray(times)
    scores = np.asarray(scores, dtype=np.float64)
    out = np.zeros(len(scores), dtype=np.float64)
    if len(scores) == 0:
        return out
    ranks = pd.Series(scores).groupby(times).rank(method="average").to_numpy(dtype=np.float64)
    counts = pd.Series(times).map(pd.Series(times).value_counts()).to_numpy(dtype=np.float64)
    centred = ranks - (counts + 1.0) / 2.0
    abs_sum = pd.Series(np.abs(centred)).groupby(times).transform("sum").to_numpy(dtype=np.float64)
    ok = (counts >= MIN_D_COINS) & (abs_sum > 0.0)
    out[ok] = centred[ok] / abs_sum[ok]
    return out


def assert_whole_decision_times(groups: Sequence[np.ndarray], times: np.ndarray) -> None:
    """Raise ValueError when a decision time appears in more than one of the index groups."""
    times = np.asarray(times)
    seen: set[Any] = set()
    for g in groups:
        ts = set(np.unique(times[np.asarray(g, dtype=int)]).tolist())
        dup = ts & seen
        if dup:
            raise ValueError(f"decision time {sorted(dup)[0]} is split across groups: the D book ranks whole times")
        seen |= ts


def _get_decisions(model: SideModel, X_test: np.ndarray, cfg: RunConfig) -> np.ndarray:
    """Sides in {-1, 0, 1} for the slot book. For the D book, the float score per row instead.

    The D score is the ridge prediction, or (p_up - base_up) - (p_dn - base_dn) for the classifiers.
    """
    n = len(X_test)
    if cfg.book == "D":
        if n == 0:
            return np.zeros(0, dtype=np.float64)
        if model.kind == "ridge":
            return np.asarray(model.ridge.predict(X_test), dtype=np.float64)
        p_up = _side_proba(model.up, X_test)
        p_dn = _side_proba(model.dn, X_test)
        return (p_up - model.base_up) - (p_dn - model.base_dn)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    sides = np.zeros(n, dtype=np.int64)
    if model.kind == "ridge":
        preds = model.ridge.predict(X_test)
        sides[preds > cfg.threshold] = 1
        sides[preds < -cfg.threshold] = -1
        return sides
    p_up = _side_proba(model.up, X_test)
    p_dn = _side_proba(model.dn, X_test)
    # For classifiers the threshold is a margin over each side's training base rate.
    m_up = p_up - model.base_up
    m_dn = p_dn - model.base_dn
    sides[(m_up > cfg.threshold) & (m_up > m_dn)] = 1
    sides[(m_dn > cfg.threshold) & (m_dn > m_up)] = -1
    return sides


def _panel_premium(panel: dict[str, dict[str, pd.DataFrame]] | None) -> dict[str, pd.DataFrame | None] | None:
    """The 5m premium-index frame per coin, for the E6 exit (None when there is no panel)."""
    if panel is None:
        return None
    return {s: panel[s].get("premium_5m", panel[s].get("premiumIndex")) for s in panel}


def _make_tranches(
    test_df: pd.DataFrame,
    sides: np.ndarray,
    cfg: RunConfig,
    exit_ctx: ExitContext | None = None,
) -> list[Tranche]:
    """Tranches of one block. `sides` is the side per row, or for the D book the score per row.

    The D book ranks the rows by their decision time T, so test_df must hold whole decision times.
    A non-horizon exit needs exit_ctx (the 5m bars and sigma table): the exit engine then sets each tranche's exit
    time, price, fill and reason. The weight keeps the configured h either way.
    """
    tranches: list[Tranche] = []
    if cfg.book == "D":
        weights = rank_weights(test_df["T"].to_numpy(dtype=np.int64), sides)
        scale = float(parse_interval_ms(cfg.interval)) / float(cfg.h_ms)
    else:
        weights = None
        scale = 1.0
    syms = test_df["symbol"].to_numpy()
    entries = test_df["entry"].to_numpy(dtype=np.float64)
    exits = test_df["exit"].to_numpy(dtype=np.float64)
    t0s = test_df["t0"].to_numpy(dtype=np.int64)
    t1s = test_df["t1_max"].to_numpy(dtype=np.int64)

    kept: list[int] = []
    kept_sides: list[int] = []
    for i in range(len(sides)):
        if weights is not None:
            if weights[i] == 0.0:
                continue
            s = 1 if weights[i] > 0.0 else -1
        else:
            s = int(sides[i])
            if s == 0:
                continue
        kept.append(i)
        kept_sides.append(s)

    exit_ms_arr: list[int] | np.ndarray = [int(t1s[i]) for i in kept]
    exit_px_arr: list[float] | np.ndarray = [float(exits[i]) for i in kept]
    exit_fill_arr: list[str] | np.ndarray = ["taker"] * len(kept)
    exit_reason_arr: list[str] | np.ndarray = ["horizon"] * len(kept)
    if not is_horizon(cfg.exit) and kept:
        if exit_ctx is None:
            raise ValueError("a non-horizon exit needs an ExitContext with the 5m bars")
        idx = np.asarray(kept, dtype=np.int64)
        entry_frame = pd.DataFrame(
            {
                "symbol": syms[idx],
                "side": np.asarray(kept_sides, dtype=np.int64),
                "T": t0s[idx],
                "entry_ms": t0s[idx] + ENTRY_DELAY_MS,
                "exit_ms": t1s[idx],
                "entry_price": entries[idx],
            }
        )
        replayed = exit_ctx.replay(entry_frame, parse_exit(cfg.exit))
        exit_ms_arr = replayed["exit_ms"].to_numpy(dtype=np.int64)
        exit_px_arr = replayed["exit_price"].to_numpy(dtype=np.float64)
        exit_fill_arr = replayed["exit_fill"].to_numpy()
        exit_reason_arr = replayed["exit_reason"].to_numpy()

    for n, i in enumerate(kept):
        entry_ms = int(t0s[i]) + ENTRY_DELAY_MS
        tranches.append(
            Tranche(
                symbol=str(syms[i]),
                side=kept_sides[n],
                entry_ms=entry_ms,
                exit_ms=int(exit_ms_arr[n]),
                entry_price=float(entries[i]),
                exit_price=float(exit_px_arr[n]),
                interval=cfg.interval,
                h_ms=cfg.h_ms,
                size=1.0,
                entry_fill="taker",
                exit_fill=str(exit_fill_arr[n]),
                exit_reason=str(exit_reason_arr[n]),
                weight_override=None if weights is None else float(weights[i]) * scale,
            )
        )
    return tranches


def _compute_coin_mean_hourly(
    coin: str,
    five_min: dict[str, pd.DataFrame],
    span_start_ms: int,
    span_end_ms: int,
) -> float:
    if coin not in five_min or five_min[coin].empty or "t" not in five_min[coin].columns:
        return 0.0
    df = five_min[coin].sort_values("t")
    t_arr = df["t"].to_numpy(dtype=np.int64)
    o_arr = df["o"].to_numpy(dtype=np.float64)
    if len(t_arr) == 0:
        return 0.0

    idx_s = int(np.searchsorted(t_arr, span_start_ms))
    idx_s = min(idx_s, len(t_arr) - 1)
    p_start = float(o_arr[idx_s])

    idx_e = int(np.searchsorted(t_arr, span_end_ms))
    idx_e = min(idx_e, len(t_arr) - 1)
    p_end = float(o_arr[idx_e])

    hours = (span_end_ms - span_start_ms) / 3_600_000.0
    if hours > 0.0 and p_start > 0.0 and p_end > 0.0:
        return float(np.log(p_end / p_start)) / hours
    return 0.0


def run_config_from_raw(raw_config: dict[str, Any]) -> RunConfig:
    """The RunConfig of a receipt's config dict, with the defaults run_wf applies."""
    return RunConfig(
        family=raw_config["family"],
        model=raw_config["model"],
        params=raw_config.get("params", {}),
        features=tuple(raw_config["features"]),
        interval=raw_config["interval"],
        h_ms=int(raw_config["h_ms"]),
        label=raw_config.get("label", "fixed"),
        side_rule=raw_config.get("side_rule", "sign" if raw_config["model"] == "ridge" else "prob"),
        threshold=float(raw_config["threshold"]),
        size_rule=raw_config.get("size_rule", "unit"),
        lookback_months=raw_config.get("lookback_months"),
        refit=raw_config.get("refit", "monthly"),
        exit=parse_exit(raw_config.get("exit", "horizon")),
        seed=int(raw_config.get("seed", 7)),
        book=raw_config.get("book", "slot"),
        noise_seed=raw_config.get("noise_seed"),
        plant=raw_config.get("plant"),
    )


def _train_window_mask(samples: pd.DataFrame, cut_ms: int) -> pd.Series:
    """Training rows of a refit at cut_ms: label window ended before the cut.

    A frame that carries SOURCE_WINDOW_COLUMN (a label-shift tripwire run, see r4.tripwire) also needs the source row's
    window to end before the cut less the embargo, so no training label comes from the test period.
    """
    mask = samples["t1_max"] < cut_ms
    if SOURCE_WINDOW_COLUMN in samples.columns:
        mask = mask & (samples[SOURCE_WINDOW_COLUMN] < cut_ms - CPCV_EMBARGO_MS)
    return mask


def walk_forward(
    samples: pd.DataFrame,
    cfg: RunConfig,
    first_refit_ms: int,
    end_ms: int,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
    exit_cache_dir: Path | str | None = None,
    dataset_hash: str | None = None,
) -> RunResult:
    """Execute walk-forward cross-validation for configured model.

    E4 and E5 fit their exit-model pair per fold (the fold's training window only). exit_cache_dir and dataset_hash
    switch on the on-disk tau-frame cache.
    """
    if panel is None:
        panel = samples.attrs.get("panel")

    if panel is not None:
        five_min = {s: panel[s]["5m"] for s in panel}
        settlements = {s: panel[s].get("settlements", panel[s].get("funding")) for s in panel}
        universe = list(panel.keys())
    else:
        universe = sorted(samples["symbol"].unique().tolist()) if not samples.empty else list(UNIVERSE)
        five_min = {s: pd.DataFrame({"t": [first_refit_ms, end_ms], "o": [100.0, 100.0]}) for s in universe}
        settlements = {s: pd.DataFrame() for s in universe}

    start_dt = pd.to_datetime(first_refit_ms, unit="ms", utc=True)
    end_dt = pd.to_datetime(end_ms, unit="ms", utc=True)
    boundaries: list[int] = []
    cur = start_dt
    while cur < end_dt:
        boundaries.append(int(cur.timestamp() * 1000))
        cur = cur + pd.DateOffset(months=1)
    boundaries.append(int(end_dt.timestamp() * 1000))

    all_ts: list[int] = []
    for df in five_min.values():
        if not df.empty and "t" in df.columns:
            all_ts.append(int(df["t"].min()))
            all_ts.append(int(df["t"].max()))
    if all_ts:
        min_d = (min(all_ts) // DAY_MS) * DAY_MS
        max_d = ((max(all_ts) // DAY_MS) + 1) * DAY_MS
    else:
        min_d = (first_refit_ms // DAY_MS) * DAY_MS
        max_d = ((end_ms // DAY_MS) + 1) * DAY_MS
    days_seq = list(range(min_d, max_d + DAY_MS, DAY_MS))
    daily_ret = daily_close_log_returns(five_min, days_seq, universe)

    exit_ctx = (
        None
        if is_horizon(cfg.exit)
        else ExitContext(
            five_min,
            cfg.h_ms,
            premium=_panel_premium(panel),
            settlements=settlements if panel is not None else None,
        )
    )

    exit_factory: ExitModelFactory | None = None
    model_folds = fallback_folds = 0
    if exit_ctx is not None and parse_exit(cfg.exit).rule in ("E4", "E5"):
        if panel is None:
            raise ValueError("exits E4 and E5 need the panel (5m, 15m, 4h, 1d, premium and settlements)")
        exit_factory = ExitModelFactory.from_config(panel, cfg, cache_dir=exit_cache_dir, dataset_hash=dataset_hash)

    def fit_fold_models(t_start: int | None, cut: int) -> None:
        nonlocal model_folds, fallback_folds
        if exit_factory is None or exit_ctx is None:
            return
        fitted = exit_factory.fit(t_start, cut)
        exit_ctx.set_models(fitted)
        if fitted is None:
            fallback_folds += 1
        else:
            model_folds += 1

    all_tranches: list[Tranche] = []
    all_fold_dfs: list[pd.DataFrame] = []
    fold_records: list[FoldRecord] = []
    block_times: list[np.ndarray] = []  # row positions of each monthly test block
    # (start_ms, end_ms, train_cut_ms, betas, tranches) per evaluated fold. The fold books are built after the loop,
    # because fees and slippage net once over the whole run's included tranches (Amendment 1, A1.1).
    pending_folds: list[tuple[int, int, int | None, dict[str, float], list[Tranche]]] = []

    if cfg.refit == "none":
        train_mask = _train_window_mask(samples, first_refit_ms)
        train_df = samples.loc[train_mask]
        scaler = StandardScaler()
        X_train = scaler.fit_transform(train_df[list(cfg.features)])
        model = fit_side_model(cfg, X_train, train_df)
        fit_fold_models(None, first_refit_ms)

        betas_0 = estimate_betas(daily_ret, start_ms=None, end_ms=first_refit_ms)

        for k in range(len(boundaries) - 1):
            b_start = boundaries[k]
            b_end = boundaries[k + 1]
            test_mask = (samples["T"] >= b_start) & (samples["T"] < b_end)
            test_df = samples.loc[test_mask]
            if test_df.empty:
                continue
            block_times.append(np.flatnonzero(test_mask.to_numpy()))
            X_test = scaler.transform(test_df[list(cfg.features)])
            sides = _get_decisions(model, X_test, cfg)
            tranches_k = _make_tranches(test_df, sides, cfg, exit_ctx)
            all_tranches.extend(tranches_k)
            pending_folds.append((b_start, b_end, None, dict(betas_0), tranches_k))
        refits_count = 1
    else:
        refits_count = 0
        for k in range(len(boundaries) - 1):
            b_start = boundaries[k]
            b_end = boundaries[k + 1]
            test_mask = (samples["T"] >= b_start) & (samples["T"] < b_end)
            test_df = samples.loc[test_mask]
            block_times.append(np.flatnonzero(test_mask.to_numpy()))

            train_mask = _train_window_mask(samples, b_start)
            if cfg.lookback_months is not None:
                b_dt = pd.to_datetime(b_start, unit="ms", utc=True)
                cut_dt = b_dt - pd.DateOffset(months=cfg.lookback_months)
                cut_ms = int(cut_dt.timestamp() * 1000)
                train_mask = train_mask & (samples["T"] >= cut_ms)
            else:
                cut_ms = None

            train_df = samples.loc[train_mask]
            refits_count += 1
            if train_df.empty:
                continue

            scaler = StandardScaler()
            X_train = scaler.fit_transform(train_df[list(cfg.features)])
            model = fit_side_model(cfg, X_train, train_df)
            fit_fold_models(cut_ms, b_start)

            betas_k = estimate_betas(daily_ret, start_ms=cut_ms, end_ms=b_start)

            if test_df.empty:
                continue
            X_test = scaler.transform(test_df[list(cfg.features)])
            sides = _get_decisions(model, X_test, cfg)
            tranches_k = _make_tranches(test_df, sides, cfg, exit_ctx)
            all_tranches.extend(tranches_k)
            pending_folds.append((b_start, b_end, cut_ms, dict(betas_k), tranches_k))

    if cfg.book == "D":
        # The D book ranks the coins of one decision time together: no time may be split across blocks.
        assert_whole_decision_times(block_times, samples["T"].to_numpy())

    # One netting set per run: the tranches with a finite beta in their fold, across all folds, so an exit in one
    # fold and an entry at the same open in the next net. Each fold book then charges its tranches' legs.
    run_tranches = [t for f in pending_folds for t in f[4]]
    in_set = [not _beta_missing(f[3], t.symbol) for f in pending_folds for t in f[4]]
    included_idx = [i for i, ok in enumerate(in_set) if ok]
    run_legs = LegCosts.from_netted(
        netted_costs([run_tranches[i] for i in included_idx]), included_idx, len(run_tranches)
    )
    offset = 0
    for b_start, b_end, cut, betas_f, tranches_f in pending_folds:
        fold_df = beta_hedged_daily(
            tranches_f,
            five_min,
            settlements,
            betas=betas_f,
            universe=universe,
            leg_costs=run_legs.take(offset, offset + len(tranches_f)),
        )
        offset += len(tranches_f)
        if tranches_f:
            all_fold_dfs.append(fold_df)
        fold_records.append(FoldRecord(b_start, b_end, cut, betas_f, tranches_f, fold_df))

    book_raw = daily_book(all_tranches, five_min, settlements)

    if all_fold_dfs:
        combined_book = pd.concat(all_fold_dfs).groupby("day_start").sum()
    else:
        combined_book = pd.DataFrame(columns=["drift_free"])
        combined_book.index.name = "day_start"

    drift_free = daily_series(combined_book, column="drift_free", span_start_ms=first_refit_ms, span_end_ms=end_ms)

    coin_means: dict[str, float] = {}
    for u in universe:
        coin_means[u] = _compute_coin_mean_hourly(u, five_min, first_refit_ms, end_ms)

    trades = trade_level(all_tranches, settlements, coin_mean_hourly=coin_means)

    n_samples = len(samples)
    n_dropped = samples.attrs.get("n_dropped", 0)
    config_dict = asdict(cfg)
    total_excluded = int(sum(df["excluded_tranches"].sum() for df in all_fold_dfs)) if all_fold_dfs else 0

    return RunResult(
        trades=trades,
        book_raw=book_raw,
        drift_free=drift_free,
        refits=refits_count,
        n_samples=n_samples,
        n_dropped=n_dropped,
        config=config_dict,
        excluded_tranches=total_excluded,
        folds=fold_records,
        tranches=all_tranches,
        exit_reason_counts=dict(Counter(t.exit_reason for t in all_tranches)),
        missing_sigma_tranches=0 if exit_ctx is None else exit_ctx.missing_sigma,
        missing_flow_tranches=0 if exit_ctx is None else exit_ctx.missing_flow,
        missing_funding_tranches=0 if exit_ctx is None else exit_ctx.missing_funding,
        missing_model_tranches=0 if exit_ctx is None else exit_ctx.missing_model,
        exit_model_folds=model_folds,
        exit_model_fallback_folds=fallback_folds,
        exit_model_fallback_tranches=0 if exit_ctx is None else exit_ctx.fallback_tranches,
    )


__all__ = [
    "ALL_FEATURE_COLUMNS",
    "DEV_END",
    "DEV_START",
    "ENTRY_DELAY_MS",
    "FoldRecord",
    "RunConfig",
    "RunResult",
    "SIGMA_TRAILING_MS",
    "TRIPLE_BARRIER_K",
    "UNIVERSE",
    "assert_whole_decision_times",
    "compute_missing_settlement_times",
    "decision_samples",
    "load_panel",
    "rank_weights",
    "run_config_from_raw",
    "walk_forward",
]
