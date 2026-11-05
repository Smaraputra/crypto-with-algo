"""Phase 5 family D: the 9 declared inverse-volatility, banded rank books, the full-grid f and its parity (A6).

FAMILY D DECLARATION (2026-11-05, declared in the commit that adds this module and the ledger entry round4-family-d,
before any family D configuration reads D). Draft 3 of .superpowers/sdd/round4/family-d-draft.md under Amendment 6
(A6.1 to A6.4, signed by the owner on 2026-11-05). Nothing here reads data.
- Plan of record: rank the 10 signal coins at 1h and 4h by a family A score, weights inverse to forecast volatility,
  dollar-neutral, book-level band, two-leg costs. Cap 12, alpha-bearing, family index 3.
- The score is family A's A-lgbm specification (LightGBM with calibration.LGBM_PARAMS, the fixed label, feature set F,
  24-month lookback, monthly refit from 2023-01-01, model seed 7), through the existing C4 rule (p_up - base_up) -
  (p_dn - base_dn). Every configuration copies its fields from the A-lgbm entry of its cell (family_a.family_a()).
- Configurations: cells C2 (1h/8h), C4 (4h/8h) and C5 (4h/24h) times bands 0, 0.045 and 0.09, in registry order cells
  C2, C4, C5 and within each cell b ascending. Ids D_invvol_b0_<cell>, D_invvol_b045_<cell>, D_invvol_b09_<cell>. Every
  configuration: family D, book D, weight rule inv_vol (A6.1) with f from the family C finalist C_LHAR-X_1h on the full
  1h grid (A6.2), exit E1, no family C filter, kind trial. The cells, the bands and the volatility input were chosen
  after family A's and family C's outcomes and are disclosed as such. Nothing was chosen from a family D outcome.
- Reserve: 3 slots, j = 0 to 2, for the no-refit twins of M's refit question (the twin freezes the score model only and
  keeps the walk-forward f), then for re-runs after a code fix.
- Bar and reports: items 1 to 6 as for family A (item 5 the drop-one-coin jackknife), item 3's N max(120, the round's
  alpha-bearing count), the label-shift tripwire for every configuration whose items 1 to 3 pass (halt above 60), the
  SPA with seed 6,000,003. Beside the bar, never gating: the A5.2 hedge cost, the A1.10 account report, the within-cell
  PBO, the cost drag by cell and by band, and the decision-level reports computed from decisions.parquet (share of
  decision times that take w_prev, cash shares, the parity and full-grid digests, the cost check and the CPCV gross
  diagnostic).
- The w_prev share (draft 4) is, over walk-forward decision times, the times whose taken target is w_prev divided by
  the times whose w_new is defined (not cash). The report also gives the numerator and the all-times denominator. The
  near-duplicate flag (b > 0 and the share under 0.01) uses the non-cash share. The CPCV cash share is reported for
  each of the five CPCV paths (every decision time of the path's calls), with the per-call detail beside it.
- Seeds: joint_shift_seed 13,000,000 + k in registry order and 13,000,009 + j for reserve slot j, the refit-question
  bootstrap 7,300,000 + the registry index, the SPA 6,000,003, the model seed 7. No other randomness.
- Parity (Amendment 7, A7.1, blocking; it amends A6.2): before any D outcome three checks must hold, else the run
  stops. (1) The canonical digest of family C's compute_forecasts finite-f rows equals PARITY_REFERENCE for the
  dataset. (2) Exact model binding: every coin-fold (beta, s2) from family_c.fit_fold on the full grid's design equals
  bit for bit the fit on compute_forecasts' design. (3) compute_forecasts' finite-f (coin, T) keys are unique, each is
  in the full grid with a finite f, and abs(f_full - f_C) <= 1e-12 * f_C. The batch rule: the full grid calls
  family_c.apply_fit once per coin and fold on every hour of the fold's month, so the batch is calendar-fixed.
- No configuration, cell, band, seed, weight rule, volatility input or reserve rule changes after family D's first D
  outcome, except as M's re-run after a code fix. Ledger: round4-family-d, 9 trials, 2,387 to 2,396.
- Predictions: PREDICTIONS below (M's, and three diagnostics).
"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import struct
from collections.abc import Iterator
from typing import Any

import numpy as np
import pandas as pd

from r4 import family_a, family_c, stats
from r4.pipeline import rank_weights

FAMILY = "D"
FAMILY_INDEX = 3
N_RESERVE = 3
JOINT_SHIFT_SEED_BASE = 13_000_000
RESERVE_SEED_BASE = 13_000_009
REFIT_SEED_BASE = 7_300_000
MIN_D_COINS = 6
BANDS: tuple[float, ...] = (0.0, 0.045, 0.09)
_H1 = 3_600_000
CELLS: dict[str, tuple[str, int]] = {"C2": ("1h", 8 * _H1), "C4": ("4h", 8 * _H1), "C5": ("4h", 24 * _H1)}
FINALIST_ID = "C_LHAR-X_1h"
PARITY_REFERENCE: dict[str, str] = {
    "11c87b9c8a97c367b6cd7c0c983f4d2bd9e940f62856a85c6e76537ac18a9a62": (
        "a6ed91ee3228f2c6645536b7b51c200deb34630e0c71bcd68da4fdfdc37ed6da"
    )
}

PREDICTIONS: dict[str, Any] = {
    "m": "no directional configuration meets the exploration bar",
    "diagnostics": {
        "items_1_to_3_passes": 0,
        "of": 9,
        "mean_daily_cost_non_increasing_in_band_within_cell": True,
        "near_duplicate_take_prev_share_below": 0.01,
        "cpcv_gross_mean_abs_at_most": 0.0001,
        "all_cash_cpcv_configuration": "reported as uninformative",
    },
}

DECISION_COLUMNS = [
    "phase",
    "call",
    "block_start",
    "T",
    "symbol",
    "ranked",
    "f",
    "w_new",
    "w_taken",
    "took_prev",
    "cash",
]


# ---------------------------------------------------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------------------------------------------------


def band_tag(band: float) -> str:
    """0 -> 'b0', 0.045 -> 'b045', 0.09 -> 'b09' (the id fragment)."""
    if band == 0:
        return "b0"
    return "b" + f"{band:.3f}".split(".")[1].rstrip("0")


def family_d() -> list[dict[str, Any]]:
    """The 9 declared configurations: cells C2, C4, C5, and within each cell bands 0, 0.045, 0.09."""
    a_by_id = {c["id"]: c for c in family_a.family_a()}
    out: list[dict[str, Any]] = []
    for cell in CELLS:
        src = a_by_id[f"A_lgbm_{cell}"]
        for band in BANDS:
            out.append(
                {
                    "id": f"D_invvol_{band_tag(band)}_{cell}",
                    "kind": "trial",
                    "family": FAMILY,
                    "cell": cell,
                    "model": src["model"],
                    "params": copy.deepcopy(src["params"]),
                    "features": list(src["features"]),
                    "interval": src["interval"],
                    "h_ms": src["h_ms"],
                    "label": src["label"],
                    "side_rule": src["side_rule"],
                    "threshold": src["threshold"],
                    "size_rule": src["size_rule"],
                    "lookback_months": src["lookback_months"],
                    "refit": src["refit"],
                    "exit": "horizon",
                    "seed": src["seed"],
                    "book": "D",
                    "d_weights": "inv_vol",
                    "d_band": float(band),
                    "joint_shift_seed": JOINT_SHIFT_SEED_BASE + len(out),
                    "first_refit_ms": src["first_refit_ms"],
                }
            )
    return out


def family_d_twin(declared_id: str, slot: int) -> dict[str, Any]:
    """The no-refit twin of a declared configuration, run from reserve slot `slot` (the walk-forward f is kept)."""
    if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < N_RESERVE:
        raise ValueError(f"reserve slot must be an int in 0..{N_RESERVE - 1}, got {slot!r}")
    by_id = {c["id"]: c for c in family_d()}
    if declared_id not in by_id:
        raise ValueError(f"{declared_id!r} is not a declared family D configuration")
    twin = copy.deepcopy(by_id[declared_id])
    twin["id"] = f"D_twin{slot}_{declared_id}"
    twin["refit"] = "none"
    twin["lookback_months"] = None
    twin["joint_shift_seed"] = RESERVE_SEED_BASE + slot
    return twin


def refit_question(config_daily: pd.DataFrame, twin_daily: pd.DataFrame, registry_index: int) -> dict[str, Any]:
    """The monthly refit against its no-refit twin: a bootstrap of the daily drift-free difference (M, A5.1).

    As family A's, with the seed 7,300,000 plus the registry index.
    """
    cfg = config_daily["drift_free"].astype(float)
    twin = twin_daily["drift_free"].astype(float).reindex(cfg.index).fillna(0.0)
    diff = (cfg - twin).to_numpy(dtype=np.float64)
    seed = REFIT_SEED_BASE + int(registry_index)
    point, low, high = stats.bootstrap_ci(
        diff,
        np.mean,
        family_a.REFIT_BOOTSTRAP_ITERATIONS,
        family_a.REFIT_BOOTSTRAP_BLOCK,
        seed,
        alpha=family_a.REFIT_ALPHA,
    )
    return {
        "point": float(point),
        "low": float(low),
        "high": float(high),
        "adopted": bool(low > 0.0),
        "seed": seed,
        "n": int(len(diff)),
        "alpha": family_a.REFIT_ALPHA,
        "iterations": family_a.REFIT_BOOTSTRAP_ITERATIONS,
        "mean_block": family_a.REFIT_BOOTSTRAP_BLOCK,
    }


# ---------------------------------------------------------------------------------------------------------------------
# The f input (A6.2)
# ---------------------------------------------------------------------------------------------------------------------


def canonical_digest(df: pd.DataFrame, value_col: str) -> str:
    """A6.2's canonical digest: one SHA-256 over the rows with a finite value, ordered by coin and then T.

    Each row is the coin's UTF-8 bytes, a NUL byte, T (epoch ms) as a little-endian int64 and the value as a
    little-endian float64. Coins order by code point.
    """
    vals = df[value_col].to_numpy(dtype=np.float64)
    finite = df.loc[np.isfinite(vals)]
    h = hashlib.sha256()
    for coin in sorted(finite["coin"].unique().tolist()):
        sub = finite.loc[finite["coin"] == coin].sort_values("T", kind="stable")
        prefix = str(coin).encode("utf-8") + b"\0"
        for t, v in zip(sub["T"].to_numpy(dtype=np.int64).tolist(), sub[value_col].tolist(), strict=True):
            h.update(prefix + struct.pack("<qd", t, v))
    return h.hexdigest()


def _finalist(finalist: dict[str, Any] | None) -> dict[str, Any]:
    if finalist is not None:
        return finalist
    by_id = {c["id"]: c for c in family_c.family_c()}
    return by_id[FINALIST_ID]


def _grid_fits(panel: dict[str, dict[str, pd.DataFrame]], fin: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Per coin, the 1h grid, its design x and one family_c.fit_fold result (or None) per refit fold.

    This is the single source of the grid design and the fits: full_grid_forecasts applies the fits to the grid, and
    check_parity's model binding compares the same fits. The result maps coin to {"grid", "x", "bounds", "fits"}.
    """
    window = str(fin["window"])
    wms = family_c.WINDOWS[window]
    end_ms = int(fin["partition_end_ms"])
    refits = family_c.refit_times(int(fin["first_refit_ms"]), end_ms)
    bounds = list(zip(refits, [*refits[1:], end_ms], strict=True))
    wins = {sym: family_c.window_table(d["5m"], wms, end_ms)[0] for sym, d in panel.items()}
    btc_win = wins.get(family_c.BTC)
    out: dict[str, dict[str, Any]] = {}
    for sym, d in panel.items():
        bars = d["5m"]
        if bars is None or len(bars) == 0:
            continue
        win = wins[sym]
        first_hour = (int(bars["t"].min()) // wms) * wms
        grid = np.arange(first_hour, end_ms - wms + 1, wms, dtype=np.int64)
        if len(grid) == 0:
            continue
        comp = family_c.component_frame(win, wms, grid)
        exog = family_c.exog_frame(grid, wms, d.get("settlements"), d.get("premium_5m"), btc_win)
        x = family_c.design(comp, exog, str(fin["model"]), window, sym == family_c.BTC)
        fits: list[dict[str, Any] | None] = []
        for refit, _nxt in bounds:
            fits.append(
                family_c.fit_fold(
                    x,
                    win["RV"],
                    win["R"],
                    wms,
                    refit,
                    fin.get("lookback_months"),
                    int(fin["min_train_windows"]),
                )
            )
        out[sym] = {"grid": grid, "x": x, "bounds": bounds, "fits": fits}
    return out


def full_grid_forecasts(
    panel: dict[str, dict[str, pd.DataFrame]], finalist: dict[str, Any] | None = None
) -> pd.DataFrame:
    """The finalist's variance forecast f at every T of the 1h grid, whether or not [T, T + 1h) is complete (A6.2).

    Per coin, T runs over every hour from the hour of the coin's first 5m bar to the last hour with T + 1h at or
    before the partition end. x_i(T) is family_c.design on component_frame and exog_frame at the requested T. For each
    refit month, family_c.fit_fold fits exactly as compute_forecasts does and family_c.apply_fit evaluates every T in
    [refit, next refit). T before the first refit, an untrained fold, a non-finite design row and a non-finite or
    non-positive result give NaN. `finalist` replaces the registry entry (tests only).

    Batch rule (A7.1): family_c.apply_fit is called once per coin and fold, on every hour of the fold's month (from
    its refit to the next refit or the partition end), so the batch is fixed by the calendar and never by the data.
    A data-dependent batch (compute_forecasts' complete windows) would change f in the last bits through the matrix
    product and break A6.4's exact causality test.
    """
    fin = _finalist(finalist)
    frames: list[pd.DataFrame] = []
    for sym, g in _grid_fits(panel, fin).items():
        grid, x = g["grid"], g["x"]
        f = np.full(len(grid), np.nan)
        for (refit, nxt), fit in zip(g["bounds"], g["fits"], strict=True):
            if fit is None:
                continue
            pos = np.flatnonzero((grid >= refit) & (grid < nxt))
            if len(pos) == 0:
                continue
            f[pos] = family_c.apply_fit(fit, x.iloc[pos])
        f = np.where(np.isfinite(f) & (f > 0.0), f, np.nan)
        frames.append(pd.DataFrame({"coin": sym, "T": grid, "f": f}))
    if not frames:
        return pd.DataFrame(
            {"coin": pd.Series(dtype=object), "T": pd.Series(dtype=np.int64), "f": pd.Series(dtype=float)}
        )
    return pd.concat(frames, ignore_index=True)


def _fits_equal(a: dict[str, Any] | None, b: dict[str, Any] | None) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return bool(np.array_equal(a["beta"], b["beta"])) and a["s2"] == b["s2"]


def check_parity(
    panel: dict[str, dict[str, pd.DataFrame]],
    dataset_hash: str,
    full: pd.DataFrame,
    finalist: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A7.1's three blocking parity checks against family C's compute_forecasts. Any failure raises ValueError.

    In order: (1) exact binding, the canonical digest of compute_forecasts' finite-f rows equals PARITY_REFERENCE;
    (2) exact model binding, every coin-fold (beta, s2) from family_c.fit_fold on compute_forecasts' design equals bit
    for bit the one on the full grid's design (both None together); (3) the full grid, compute_forecasts' finite-f
    (coin, T) keys are unique, each is in `full` with a finite f, and abs(f_full - f_C) <= 1e-12 * f_C.
    """
    if dataset_hash not in PARITY_REFERENCE:
        raise ValueError(f"dataset {dataset_hash!r} has no family C parity reference: the run stops")
    fin = _finalist(finalist)
    forecasts, _ = family_c.compute_forecasts(panel, fin)
    rows = forecasts.loc[np.isfinite(forecasts["f"].to_numpy(dtype=np.float64)), ["coin", "T", "f"]]
    digest = canonical_digest(rows, "f")
    if digest != PARITY_REFERENCE[dataset_hash]:
        raise ValueError(f"family D parity: digest {digest} is not the reference {PARITY_REFERENCE[dataset_hash]}")
    _check_model_binding(panel, fin)
    if rows.duplicated(["coin", "T"]).any():
        raise ValueError("family D parity: compute_forecasts has duplicated (coin, T) keys")
    merged = rows.merge(full[["coin", "T", "f"]], on=["coin", "T"], how="left", suffixes=("", "_full"))
    got = merged["f_full"].to_numpy(dtype=np.float64)
    want = merged["f"].to_numpy(dtype=np.float64)
    if len(merged) != len(rows) or not np.isfinite(got).all():
        raise ValueError("family D parity: a compute_forecasts key is missing from the full grid or has a non-finite f")
    if not (want > 0.0).all():
        raise ValueError("family D parity: compute_forecasts has a non-positive f")
    diff = np.abs(got - want)
    if not (diff <= 1e-12 * want).all():
        raise ValueError("family D parity: the full-grid f differs from compute_forecasts by more than 1e-12 relative")
    n_differing = int((got != want).sum())
    max_rel = float((diff / want).max()) if len(want) else 0.0
    first = int(fin["first_refit_ms"])
    end_ms = int(fin["partition_end_ms"])
    window = family_c.WINDOWS[str(fin["window"])]
    after = full.loc[(full["T"] >= first) & (full["T"] <= end_ms - window)]
    missing = {
        str(coin): int((~np.isfinite(g["f"].to_numpy(dtype=np.float64))).sum()) for coin, g in after.groupby("coin")
    }
    return {
        "parity_digest": digest,
        "parity_rows": int(len(rows)),
        "full_grid_digest": canonical_digest(full, "f"),
        "full_grid_rows": int(np.isfinite(full["f"].to_numpy(dtype=np.float64)).sum()),
        "missing_wf_hours_by_coin": missing,
        "n_keys_differing": n_differing,
        "max_rel_diff": max_rel,
    }


def _check_model_binding(panel: dict[str, dict[str, pd.DataFrame]], fin: dict[str, Any]) -> None:
    """A7.1's exact model binding: per coin and fold, the grid's fit equals compute_forecasts' fit bit for bit."""
    window = str(fin["window"])
    wms = family_c.WINDOWS[window]
    end_ms = int(fin["partition_end_ms"])
    grid_fits = _grid_fits(panel, fin)
    prep = family_c.prepare_window(panel, window, end_ms)
    refits = family_c.refit_times(int(fin["first_refit_ms"]), end_ms)
    for sym, g in grid_fits.items():
        p = prep.get(sym)
        if p is None or p["win"].empty:
            ref: list[dict[str, Any] | None] = [None] * len(refits)
        else:
            win = p["win"]
            x = family_c.design(p["comp"], p["exog"], str(fin["model"]), window, sym == family_c.BTC)
            ref = [
                family_c.fit_fold(
                    x, win["RV"], win["R"], wms, refit, fin.get("lookback_months"), int(fin["min_train_windows"])
                )
                for refit in refits
            ]
        for k, (a, b) in enumerate(zip(ref, g["fits"], strict=True)):
            if not _fits_equal(a, b):
                raise ValueError(f"family D parity: model binding failed for {sym} at fold {k}")


# ---------------------------------------------------------------------------------------------------------------------
# Weights (A6.1) and the band (A6.3)
# ---------------------------------------------------------------------------------------------------------------------


def inv_vol_weights(times: np.ndarray, scores: np.ndarray, f: np.ndarray) -> np.ndarray:
    """A6.1 inverse-volatility target weights per row, ranked among the rows that share a decision time.

    Ranked rows have a finite score and a finite f > 0. Fewer than MIN_D_COINS ranked, or all scores tied, is cash.
    c is the centred average rank, u = c / sqrt(f), the long side is scaled to sum 0.5 and the short side to -0.5.
    Unranked rows get 0.
    """
    times = np.asarray(times)
    scores = np.asarray(scores, dtype=np.float64)
    fv = np.asarray(f, dtype=np.float64)
    out = np.zeros(len(scores), dtype=np.float64)
    if len(scores) == 0:
        return out
    with np.errstate(invalid="ignore"):
        ok = np.isfinite(scores) & np.isfinite(fv) & (fv > 0.0)
    if not ok.any():
        return out
    pos = np.flatnonzero(ok)
    t = times[pos]
    frame = pd.DataFrame({"t": t, "s": scores[pos]})
    grp = frame.groupby("t")["s"]
    ranks = grp.rank(method="average").to_numpy(dtype=np.float64)
    counts = grp.transform("size").to_numpy(dtype=np.float64)
    centred = ranks - (counts + 1.0) / 2.0
    u = centred / np.sqrt(fv[pos])
    side = pd.DataFrame({"t": t, "up": np.where(u > 0.0, u, 0.0), "dn": np.where(u < 0.0, -u, 0.0)})
    up_sum = side.groupby("t")["up"].transform("sum").to_numpy(dtype=np.float64)
    dn_sum = side.groupby("t")["dn"].transform("sum").to_numpy(dtype=np.float64)
    valid = (counts >= MIN_D_COINS) & (up_sum > 0.0) & (dn_sum > 0.0)
    w = np.zeros(len(pos), dtype=np.float64)
    long_ = valid & (u > 0.0)
    short = valid & (u < 0.0)
    w[long_] = (0.5 * u[long_]) / up_sum[long_]
    w[short] = (0.5 * u[short]) / dn_sum[short]
    out[pos] = w
    return out


class Recorder:
    """Collects one row per input row of every banded or inverse-volatility book_weights call."""

    def __init__(self) -> None:
        self.phase = "unset"
        self.calls = 0
        self._frames: list[pd.DataFrame] = []

    def add(self, frame: pd.DataFrame) -> None:
        self._frames.append(frame)

    def frame(self) -> pd.DataFrame:
        if not self._frames:
            return pd.DataFrame(
                {
                    "phase": pd.Series(dtype=object),
                    "call": pd.Series(dtype=np.int64),
                    "block_start": pd.Series(dtype=np.int64),
                    "T": pd.Series(dtype=np.int64),
                    "symbol": pd.Series(dtype=object),
                    "ranked": pd.Series(dtype=bool),
                    "f": pd.Series(dtype=np.float64),
                    "w_new": pd.Series(dtype=np.float64),
                    "w_taken": pd.Series(dtype=np.float64),
                    "took_prev": pd.Series(dtype=bool),
                    "cash": pd.Series(dtype=bool),
                }
            )[DECISION_COLUMNS]
        return pd.concat(self._frames, ignore_index=True)[DECISION_COLUMNS]


_RECORDER: Recorder | None = None


@contextlib.contextmanager
def recording(recorder: Recorder | None = None) -> Iterator[Recorder]:
    """Activate a recorder (a fresh one unless given) for the duration of the block, and yield it."""
    global _RECORDER
    previous = _RECORDER
    active = recorder if recorder is not None else Recorder()
    _RECORDER = active
    try:
        yield active
    finally:
        _RECORDER = previous


def set_phase(name: str) -> None:
    """Label the rows recorded from now on. Raises when no recorder is active."""
    if _RECORDER is None:
        raise RuntimeError("set_phase needs an active recorder")
    _RECORDER.phase = str(name)


def book_weights(
    times: np.ndarray,
    symbols: np.ndarray,
    scores: np.ndarray,
    f: np.ndarray | None,
    cfg_weights: str,
    band: float,
    h_ms: int,
    interval_ms: int,
    recorder_tag: str | None = None,
) -> np.ndarray:
    """The weight taken per row of one test block: the target of the weight rule, then A6.3's band.

    cfg_weights is "rank" (pipeline.rank_weights) or "inv_vol" (inv_vol_weights, needs f). For band b > 0, decision
    times run ascending and w_prev is the weight taken at T - h_ms when that time is in this block, was not cash and
    has the same ranked coin set (a zero-weight median coin is ranked). The decision takes w_prev when
    max abs(w_new - w_prev) <= b, else w_new. Band 0 never repeats. The state lives in this call (one test block).
    With a recorder active, one row per input row is appended (the phase is recorder_tag when given).
    """
    times = np.asarray(times, dtype=np.int64)
    symbols = np.asarray(symbols)
    scores = np.asarray(scores, dtype=np.float64)
    n = len(scores)
    if cfg_weights not in ("rank", "inv_vol"):
        raise ValueError(f"unknown weight rule {cfg_weights!r}")
    if h_ms <= 0 or interval_ms <= 0 or h_ms % interval_ms:
        raise ValueError("h_ms must be a positive multiple of interval_ms")
    fv = np.full(n, np.nan) if f is None else np.asarray(f, dtype=np.float64)
    if cfg_weights == "inv_vol":
        if f is None:
            raise ValueError("the inv_vol weight rule needs f")
        w_new = inv_vol_weights(times, scores, fv)
        with np.errstate(invalid="ignore"):
            ranked = np.isfinite(scores) & np.isfinite(fv) & (fv > 0.0)
    else:
        w_new = rank_weights(times, scores)
        ranked = np.isfinite(scores)
    taken = w_new.copy()
    took = np.zeros(n, dtype=bool)
    cash = np.zeros(n, dtype=bool)
    if n:
        order = np.argsort(times, kind="stable")
        sorted_t = times[order]
        starts = np.flatnonzero(np.concatenate(([True], sorted_t[1:] != sorted_t[:-1])))
        ends = np.concatenate((starts[1:], [n]))
        state: dict[int, tuple[frozenset[str], dict[str, float], bool]] = {}
        for lo, hi in zip(starts.tolist(), ends.tolist(), strict=True):
            idx = order[lo:hi]
            t = int(sorted_t[lo])
            syms = [str(s) for s in symbols[idx]]
            coins = frozenset(s for s, r in zip(syms, ranked[idx], strict=True) if r)
            wn = w_new[idx]
            cash[idx] = not bool(np.any(wn != 0.0))
            if band > 0.0:
                prev = state.get(t - h_ms)
                if prev is not None and not prev[2] and prev[0] == coins:
                    wp = np.array([prev[1].get(s, 0.0) for s in syms], dtype=np.float64)
                    if float(np.max(np.abs(wn - wp))) <= band:
                        taken[idx] = wp
                        took[idx] = True
            taken_here = taken[idx]
            state[t] = (coins, dict(zip(syms, taken_here.tolist(), strict=True)), not bool(np.any(taken_here != 0.0)))
    if _RECORDER is not None and n:
        rec = _RECORDER
        phase = rec.phase if recorder_tag is None else str(recorder_tag)
        rec.add(
            pd.DataFrame(
                {
                    "phase": phase,
                    "call": np.int64(rec.calls),
                    "block_start": np.int64(times.min()),
                    "T": times,
                    "symbol": symbols.astype(object),
                    "ranked": ranked,
                    "f": fv,
                    "w_new": w_new,
                    "w_taken": taken,
                    "took_prev": took,
                    "cash": cash,
                }
            )
        )
    if _RECORDER is not None:
        _RECORDER.calls += 1
    return taken
