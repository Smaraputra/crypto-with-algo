"""Round 4 pipeline: panel loader, decision samples, and walk-forward runner."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.preprocessing import StandardScaler

from r4.book import (
    DAY_MS,
    Tranche,
    beta_hedged_daily,
    daily_book,
    daily_close_log_returns,
    daily_series,
    estimate_betas,
    trade_level,
)
from r4.costs import default_cost_percent
from r4.data import load_funding, load_perp
from r4.features import ALL_FEATURE_COLUMNS, build_feature_frame
from r4.labels import trailing_sigma_h, triple_barrier
from r4.method import (
    DEV_END,
    DEV_START,
    ENTRY_DELAY_MS,
    SIGMA_TRAILING_MS,
    TRIPLE_BARRIER_K,
    UNIVERSE,
)

logger = logging.getLogger(__name__)


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
    exit: str  # "horizon"
    seed: int = 7


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

        sub_feats = feat_df.reindex(index=T_arr)[list(cfg.features)].to_numpy(dtype=np.float64)
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
            tb_label = tb_df["label"].to_numpy(dtype=np.float64)
            tb_net = tb_df["net"].to_numpy(dtype=np.float64)
            tb_exit = tb_df["exit"].to_numpy(dtype=np.float64)
            label_has_nan = np.isnan(tb_label)
        else:
            tb_label = None
            tb_net = None
            tb_exit = None
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

        per_symbol_dfs.append(pd.DataFrame(sym_cols))

    if per_symbol_dfs:
        combined = pd.concat(per_symbol_dfs, ignore_index=True)
        combined = combined.sort_values(["T", "symbol"]).reset_index(drop=True)
    else:
        out_cols = ["symbol", "T", *cfg.features, "entry", "exit", "gross_log", "t0", "t1_max"]
        if cfg.label == "triple_barrier":
            out_cols.extend(["tb_label", "tb_net", "tb_exit"])
        combined = pd.DataFrame(columns=out_cols)

    combined.attrs["n_dropped"] = total_dropped
    combined.attrs["panel"] = panel
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
        params.setdefault("n_jobs", 2)
        params.setdefault("verbose", -1)
        return LGBMClassifier(**params)
    raise ValueError(f"Unknown model: {cfg.model}")


def _get_target(train_df: pd.DataFrame, cfg: RunConfig) -> np.ndarray:
    if cfg.model == "ridge":
        return train_df["gross_log"].to_numpy(dtype=np.float64)
    if cfg.label == "triple_barrier":
        return (train_df["tb_label"] == 1.0).astype(int).to_numpy()
    rt_cost = default_cost_percent(cfg.interval) / 100.0
    return (train_df["gross_log"] > rt_cost).astype(int).to_numpy()


def _get_decisions(model: Any, X_test: np.ndarray, cfg: RunConfig) -> np.ndarray:
    n = len(X_test)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    if cfg.model == "ridge":
        preds = model.predict(X_test)
        sides = np.zeros(n, dtype=np.int64)
        sides[preds > cfg.threshold] = 1
        sides[preds < -cfg.threshold] = -1
        return sides
    probs = model.predict_proba(X_test)[:, 1]
    sides = np.zeros(n, dtype=np.int64)
    sides[probs > cfg.threshold] = 1
    sides[probs < (1.0 - cfg.threshold)] = -1
    return sides


def _make_tranches(test_df: pd.DataFrame, sides: np.ndarray, cfg: RunConfig) -> list[Tranche]:
    tranches: list[Tranche] = []
    syms = test_df["symbol"].to_numpy()
    entries = test_df["entry"].to_numpy(dtype=np.float64)
    exits = test_df["exit"].to_numpy(dtype=np.float64)
    t0s = test_df["t0"].to_numpy(dtype=np.int64)
    t1s = test_df["t1_max"].to_numpy(dtype=np.int64)

    for i in range(len(sides)):
        s = int(sides[i])
        if s == 0:
            continue
        entry_ms = int(t0s[i]) + ENTRY_DELAY_MS
        exit_ms = int(t1s[i])
        tranches.append(
            Tranche(
                symbol=str(syms[i]),
                side=s,
                entry_ms=entry_ms,
                exit_ms=exit_ms,
                entry_price=float(entries[i]),
                exit_price=float(exits[i]),
                interval=cfg.interval,
                h_ms=cfg.h_ms,
                size=1.0,
                entry_fill="taker",
                exit_fill="taker",
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


def walk_forward(
    samples: pd.DataFrame,
    cfg: RunConfig,
    first_refit_ms: int,
    end_ms: int,
    panel: dict[str, dict[str, pd.DataFrame]] | None = None,
) -> RunResult:
    """Execute walk-forward cross-validation for configured model."""
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

    all_tranches: list[Tranche] = []
    all_fold_dfs: list[pd.DataFrame] = []

    if cfg.refit == "none":
        train_mask = samples["t1_max"] < first_refit_ms
        train_df = samples.loc[train_mask]
        scaler = StandardScaler()
        X_train = scaler.fit_transform(train_df[list(cfg.features)])
        y_train = _get_target(train_df, cfg)
        model = _make_model(cfg)
        model.fit(X_train, y_train)

        betas_0 = estimate_betas(daily_ret, start_ms=None, end_ms=first_refit_ms)

        for k in range(len(boundaries) - 1):
            b_start = boundaries[k]
            b_end = boundaries[k + 1]
            test_mask = (samples["T"] >= b_start) & (samples["T"] < b_end)
            test_df = samples.loc[test_mask]
            if test_df.empty:
                continue
            X_test = scaler.transform(test_df[list(cfg.features)])
            sides = _get_decisions(model, X_test, cfg)
            tranches_k = _make_tranches(test_df, sides, cfg)
            all_tranches.extend(tranches_k)
            if tranches_k:
                fold_df = beta_hedged_daily(tranches_k, five_min, settlements, betas=betas_0, universe=universe)
                all_fold_dfs.append(fold_df)
        refits_count = 1
    else:
        refits_count = 0
        for k in range(len(boundaries) - 1):
            b_start = boundaries[k]
            b_end = boundaries[k + 1]
            test_mask = (samples["T"] >= b_start) & (samples["T"] < b_end)
            test_df = samples.loc[test_mask]

            train_mask = samples["t1_max"] < b_start
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
            y_train = _get_target(train_df, cfg)
            model = _make_model(cfg)
            model.fit(X_train, y_train)

            betas_k = estimate_betas(daily_ret, start_ms=cut_ms, end_ms=b_start)

            if test_df.empty:
                continue
            X_test = scaler.transform(test_df[list(cfg.features)])
            sides = _get_decisions(model, X_test, cfg)
            tranches_k = _make_tranches(test_df, sides, cfg)
            all_tranches.extend(tranches_k)
            if tranches_k:
                fold_df = beta_hedged_daily(tranches_k, five_min, settlements, betas=betas_k, universe=universe)
                all_fold_dfs.append(fold_df)

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
    )


__all__ = [
    "ALL_FEATURE_COLUMNS",
    "DEV_END",
    "DEV_START",
    "ENTRY_DELAY_MS",
    "RunConfig",
    "RunResult",
    "SIGMA_TRAILING_MS",
    "TRIPLE_BARRIER_K",
    "UNIVERSE",
    "compute_missing_settlement_times",
    "decision_samples",
    "load_panel",
    "walk_forward",
]
