"""Brief 33c: the Opus review fixes of family C (draft 5 rules). Synthetic data only, nothing reads D."""

from __future__ import annotations

import inspect
import json
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import cli, family_c, phase5_c
from r4.method import DEV_END
from r4.synth import synth_panel, write_synthetic_dataset

H = 3_600_000
DAY = 86_400_000
BAR = 300_000
COMMIT = "c" * 40
SYMS = ["BTCUSDT", "ETHUSDT", "ADAUSDT"]


def _bars(n_bars: int, start: int = 0, seed: int = 1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    c = 100.0 * np.exp(np.cumsum(rng.normal(0.0, 0.001, size=n_bars)))
    o = np.concatenate(([100.0], c[:-1]))
    return pd.DataFrame(
        {
            "t": start + np.arange(n_bars, dtype=np.int64) * BAR,
            "o": o,
            "h": np.maximum(o, c) * 1.0002,
            "l": np.minimum(o, c) * 0.9998,
            "c": c,
            "v": np.ones(n_bars),
            "tbv": np.ones(n_bars) / 2,
        }
    )


# ---------------------------------------------------------------------------------------------------------------------
# Zero-volume bars (R1)
# ---------------------------------------------------------------------------------------------------------------------


def test_a_zero_volume_bar_voids_its_window_and_the_successors_persistence() -> None:
    df = _bars(12 * 5)
    df.loc[15, "v"] = 0.0  # a bar inside the window [1h, 2h)
    win, info = family_c.window_table(df, H)
    assert np.isnan(win.loc[H, "RV"]) and np.isnan(win.loc[H, "BPV"]) and np.isnan(win.loc[H, "R"])
    assert np.isfinite(win.loc[[0, 2 * H, 3 * H, 4 * H], "RV"]).all()
    assert info["n_zero_volume_bars"] == 1 and info["n_zero_volume_windows"] == 1
    assert info["n_incomplete"] == 1
    comp = family_c.component_frame(win, H, win.index)
    persistence = family_c.persistence_forecast(comp)
    assert np.isnan(persistence.loc[2 * H]) and np.isfinite(persistence.loc[3 * H])


def test_a_nan_volume_bar_does_the_same() -> None:
    df = _bars(12 * 5)
    df.loc[15, "v"] = np.nan
    win, info = family_c.window_table(df, H)
    assert np.isnan(win.loc[H, "RV"]) and np.isfinite(win.loc[2 * H, "RV"])
    assert info["n_zero_volume_bars"] == 1 and info["n_zero_volume_windows"] == 1
    persistence = family_c.persistence_forecast(family_c.component_frame(win, H, win.index))
    assert np.isnan(persistence.loc[2 * H])


def test_zero_volume_counts_bars_and_windows_before_the_partition_end_cut() -> None:
    df = _bars(12 * 5)
    df.loc[[15, 16, 40], "v"] = 0.0  # two bars in window 1, one in window 3
    win, info = family_c.window_table(df, H)
    assert info["n_zero_volume_bars"] == 3 and info["n_zero_volume_windows"] == 2
    assert np.isnan(win.loc[[H, 3 * H], "RV"]).all()
    # A zero-volume bar in a window past the partition end is still counted as a bar, and the window is not "kept".
    cut, cinfo = family_c.window_table(df, H, end_ms=3 * H)
    assert cinfo["n_zero_volume_bars"] == 3
    assert cinfo["n_partition_end"] == 2  # windows 2 and 4 end at or past 3h, window 3 is void and not counted here
    clean, clean_info = family_c.window_table(_bars(24), H)
    assert clean_info["n_zero_volume_bars"] == 0 and clean_info["n_zero_volume_windows"] == 0
    assert np.isfinite(clean["RV"]).all() and len(cut) == 5


def test_a_frame_without_volume_raises() -> None:
    df = _bars(24).drop(columns=["v"])
    with pytest.raises(ValueError, match="volume"):
        family_c.window_table(df, H)


def _flat_hour_panel(flat: bool) -> dict[str, dict[str, pd.DataFrame]]:
    n_days = 240
    start = DEV_END - n_days * DAY
    cov = np.array([[0.0009, 0.0006], [0.0006, 0.0016]])
    panel = synth_panel(cov, ["BTCUSDT", "ETHUSDT"], start, DEV_END, seed=31)
    if flat:
        flat_t = start + 70 * DAY + 100 * DAY + 20 * H
        for s in panel:
            df = panel[s]["5m"].copy()
            m = (df["t"] >= flat_t) & (df["t"] < flat_t + H)
            prev_c = float(df.loc[df["t"] == flat_t - BAR, "c"].iloc[0])
            for col in ("o", "h", "l", "c"):
                df.loc[m, col] = prev_c
            df.loc[m, "v"] = 0.0
            panel[s] = {**panel[s], "5m": df}
    return panel


def test_a_flat_zero_volume_hour_does_not_pin_the_qlike_dm_test() -> None:
    n_days = 240
    first = DEV_END - n_days * DAY + 70 * DAY
    config = dict(next(c for c in family_c.family_c() if c["id"] == "C_LHAR_1h"), first_refit_ms=first)
    stats_by_case = {}
    for flat in (False, True):
        fc, counts = family_c.compute_forecasts(_flat_hour_panel(flat), config)
        stats_by_case[flat] = (
            counts,
            {s: family_c.coin_criteria(g, H) for s, g in fc.groupby("coin", sort=True)},
        )
    counts, crit = stats_by_case[True]
    assert counts["zero_volume_bars"] == 24 and counts["zero_volume_windows"] == 2
    for coin in ("BTCUSDT", "ETHUSDT"):
        stat = crit[coin]["tests"]["qlike_vs_persistence"]["stat"]
        # With the flat hour kept, persistence for the next hour floors at 1e-12 and the statistic is pinned at -1.
        assert abs(stat + 1.0) > 0.5 and stat < -5.0
        assert crit[coin]["n_paired"] < stats_by_case[False][1][coin]["n_paired"]


def _small_panel(zero_btc_t: int | None = None) -> tuple[dict[str, dict[str, pd.DataFrame]], int, int]:
    n_days = 70
    start = DEV_END - n_days * DAY
    cov = np.array([[0.0009, 0.0006], [0.0006, 0.0016]])
    panel = synth_panel(cov, ["BTCUSDT", "ETHUSDT"], start, DEV_END, seed=5)
    if zero_btc_t is not None:
        df = panel["BTCUSDT"]["5m"].copy()
        df.loc[df["t"] == zero_btc_t, "v"] = 0.0
        panel["BTCUSDT"] = {**panel["BTCUSDT"], "5m": df}
    return panel, start, start + 45 * DAY


def test_compute_forecasts_counts_zero_volume_and_the_btc_term_follows() -> None:
    panel, start, first = _small_panel()
    k = start + 55 * DAY + 5 * H  # an hour of BTC with one zero-volume bar
    panel, _, _ = _small_panel(zero_btc_t=k + 2 * BAR)
    base = dict(next(c for c in family_c.family_c() if c["id"] == "C_LHAR-X_1h"), first_refit_ms=first)
    base["min_train_windows"] = 300
    fc, counts = family_c.compute_forecasts(panel, base)
    assert counts["zero_volume_bars"] == 1 and counts["zero_volume_windows"] == 1
    assert counts["zero_volume_by_coin"] == {
        "BTCUSDT": {"bars": 1, "windows": 1},
        "ETHUSDT": {"bars": 0, "windows": 0},
    }
    eth = fc[fc["coin"] == "ETHUSDT"].set_index("T")
    assert np.isfinite(eth.loc[k - H, "f"])
    # BTC's window [k, k + 1h) is void, so ETH's LHAR-X (which reads BTC's log RV_prev) has no forecast at k + 1h.
    assert np.isnan(eth.loc[k + H, "f"])
    plain = dict(next(c for c in family_c.family_c() if c["id"] == "C_LHAR_1h"), first_refit_ms=first)
    plain["min_train_windows"] = 300
    fc2, _ = family_c.compute_forecasts(panel, plain)
    eth2 = fc2[fc2["coin"] == "ETHUSDT"].set_index("T")
    assert np.isfinite(eth2.loc[k + H, "f"])


# ---------------------------------------------------------------------------------------------------------------------
# Coverage bounds mapping (R4)
# ---------------------------------------------------------------------------------------------------------------------


def test_forecast_bounds_are_the_training_quantiles_times_sqrt_f() -> None:
    panel, start, first = _small_panel()
    config = dict(next(c for c in family_c.family_c() if c["id"] == "C_LHAR_1h"), first_refit_ms=first)
    config["min_train_windows"] = 300
    fc, _ = family_c.compute_forecasts(panel, config)
    # Independent fit of the first fold for BTC, from the window table and the design only.
    win, _ = family_c.window_table(panel["BTCUSDT"]["5m"], H, DEV_END)
    comp = family_c.component_frame(win, H, win.index)
    x = family_c.design(comp, pd.DataFrame(index=comp.index), "LHAR", "1h", True)
    xv = x.to_numpy()
    y = win["RV"].to_numpy()
    T = win.index.to_numpy()
    assert start > first - 24 * 31 * DAY  # the 24-month lookback reaches the start of the data
    mask = np.isfinite(xv).all(axis=1) & np.isfinite(y) & (T + H < first)
    beta, *_ = np.linalg.lstsq(xv[mask], np.log(y[mask]), rcond=None)
    fitted = xv[mask] @ beta
    resid = np.log(y[mask]) - fitted
    s2 = float(resid @ resid) / (int(mask.sum()) - xv.shape[1])
    z = win["R"].to_numpy()[mask] / np.sqrt(np.exp(fitted + s2 / 2.0))
    q80_lo, q80_hi = np.quantile(z, 0.10), np.quantile(z, 0.90)
    q95_lo, q95_hi = np.quantile(z, 0.025), np.quantile(z, 0.975)
    assert q95_lo < q80_lo < 0.0 < q80_hi < q95_hi
    rows = fc[(fc["coin"] == "BTCUSDT") & (fc["fold"] == first) & fc["f"].notna()]
    assert len(rows) > 100
    sd = np.sqrt(rows["f"].to_numpy())
    assert rows["lo80"].to_numpy() == pytest.approx(q80_lo * sd)
    assert rows["hi80"].to_numpy() == pytest.approx(q80_hi * sd)
    assert rows["lo95"].to_numpy() == pytest.approx(q95_lo * sd)
    assert rows["hi95"].to_numpy() == pytest.approx(q95_hi * sd)
    assert (rows["lo95"] < rows["lo80"]).all() and (rows["hi80"] < rows["hi95"]).all()


# ---------------------------------------------------------------------------------------------------------------------
# End to end with a finalist (R4), receipts, forecasts hash, twin binding (R5, R6, R7)
# ---------------------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def fin(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("fc33c")
    start = DEV_END - 260 * DAY
    cov = np.array([[0.0009, 0.0006, 0.0007], [0.0006, 0.0016, 0.001], [0.0007, 0.001, 0.0025]])
    panel = synth_panel(cov, SYMS, start, DEV_END, seed=77)
    rng = np.random.default_rng(3)
    for s in SYMS:
        p = panel[s]["premium_5m"].copy()
        p["c"] = rng.normal(0.0, 2e-4, size=len(p))
        panel[s]["premium_5m"] = p
        panel[s]["premiumIndex"] = p
        f = panel[s]["settlements"].copy()
        f["rate"] = rng.normal(1e-4, 8e-5, size=len(f))
        panel[s]["settlements"] = f
        panel[s]["funding"] = f
    zero_t = start + 100 * DAY + 3 * H + 2 * BAR
    eth = panel["ETHUSDT"]["5m"].copy()
    eth.loc[eth["t"] == zero_t, "v"] = 0.0
    panel["ETHUSDT"] = {**panel["ETHUSDT"], "5m": eth}
    ds = write_synthetic_dataset(panel, root / "ds")
    first = start + 60 * DAY
    configs = [dict(c, first_refit_ms=first, min_train_windows=300) for c in family_c.family_c()]
    # No configuration passes the DM tests on pure noise, so the coin verdict is set by "has paired rows". Everything
    # else (runs, receipts, pairing, ranking, stay-out) is the real code path.
    real_criteria = family_c.coin_criteria

    def lenient(df: pd.DataFrame, window_ms: int) -> dict[str, Any]:
        res = real_criteria(df, window_ms)
        res["pass"] = bool(res["n_paired"] > 0)
        return res

    mp = pytest.MonkeyPatch()
    mp.setattr(family_c, "family_c", lambda: [dict(c) for c in configs])
    mp.setattr(family_c, "coin_criteria", lenient)
    try:
        out = root / "out"
        receipts = phase5_c.run_family_c(ds, out, COMMIT)
        report = phase5_c.report_family_c(ds, out / "runs", out, COMMIT, universe=tuple(SYMS), symbols_min=1)
    finally:
        mp.undo()
    return {"root": root, "ds": ds, "out": out, "configs": configs, "receipts": receipts, "report": report}


@pytest.fixture
def patched(fin: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    monkeypatch.setattr(family_c, "family_c", lambda: [dict(c) for c in fin["configs"]])
    real_criteria = family_c.coin_criteria

    def lenient(df: pd.DataFrame, window_ms: int) -> dict[str, Any]:
        res = real_criteria(df, window_ms)
        res["pass"] = bool(res["n_paired"] > 0)
        return res

    monkeypatch.setattr(family_c, "coin_criteria", lenient)
    return fin


def test_end_to_end_report_with_a_finalist_and_its_stay_out(fin: dict[str, Any]) -> None:
    report = fin["report"]
    order = [c["id"] for c in fin["configs"]]
    assert report["passing"] and report["finalist"] is not None
    block = report["finalist"]
    assert block["id"] in report["passing"]
    assert block["registry_index"] == order.index(block["id"])
    assert block["support"] == sorted(SYMS)
    assert set(block["support_days"]) == set(SYMS) and all(n > 0 for n in block["support_days"].values())
    assert set(block["scores"]) == set(report["passing"])
    best = min(block["scores"].values())
    assert block["scores"][block["id"]] == best
    stay_out = report["stay_out"]
    assert stay_out is not None
    assert stay_out["flag1"]["seed"] == 12_100_000 + block["registry_index"]
    assert stay_out["flag1"]["n_eligible"] > 0 and "ratio" in stay_out["flag1"]
    assert "n_flagged" in stay_out["flag2"]
    assert report["h_read_allowed"] == stay_out["pass"]
    on_disk = json.loads((fin["out"] / "family_c_report.json").read_text())
    assert on_disk["finalist"]["id"] == block["id"]


def test_receipts_carry_reproduction_inputs_hash_and_zero_volume_counts(fin: dict[str, Any]) -> None:
    for config in fin["configs"]:
        d = fin["out"] / "runs" / config["id"]
        receipt = json.loads((d / "receipt.json").read_text())
        assert "requirements_lock_sha256" in receipt and isinstance(receipt["versions"], dict)
        assert "python" in receipt["versions"]
        assert receipt["forecasts_sha256"] == phase5_c._file_sha256(d / "forecasts.parquet")
        assert receipt["dropped_windows"]["zero_volume"] == 1
        assert receipt["zero_volume_by_coin"] == {
            "BTCUSDT": {"bars": 0, "windows": 0},
            "ETHUSDT": {"bars": 1, "windows": 1},
            "ADAUSDT": {"bars": 0, "windows": 0},
        }


def test_a_rewritten_forecasts_file_is_refused(patched: dict[str, Any], tmp_path: Path) -> None:
    out = tmp_path / "out"
    shutil.copytree(patched["out"], out)
    target = out / "runs" / "C_LHAR_1h" / "forecasts.parquet"
    fc = pd.read_parquet(target)
    fc.loc[fc.index[0], "y"] = fc.loc[fc.index[0], "y"] * 1.5
    fc.to_parquet(target, index=False)
    assert len(pd.read_parquet(target)) == len(fc)
    with pytest.raises(ValueError, match="forecasts_sha256"):
        phase5_c.report_family_c(patched["ds"], out / "runs", out, COMMIT, universe=tuple(SYMS), symbols_min=1)
    with pytest.raises(ValueError, match="forecasts_sha256"):
        phase5_c.run_family_c(patched["ds"], out, COMMIT)


def test_twin_receipt_and_the_twin_criteria_binding(patched: dict[str, Any], tmp_path: Path) -> None:
    runs = patched["out"] / "runs"
    report_file = patched["out"] / "family_c_report.json"
    kw: dict[str, Any] = {"universe": tuple(SYMS), "symbols_min": 1}
    res = phase5_c.run_family_c_twin(patched["ds"], runs, report_file, tmp_path / "t", COMMIT, **kw)
    assert res["finalist"] == patched["report"]["finalist"]["id"]
    twin_dir = tmp_path / "t" / "twins" / "runs" / res["twin_id"]
    receipt = json.loads((twin_dir / "receipt.json").read_text())
    assert "requirements_lock_sha256" in receipt and "versions" in receipt
    assert receipt["forecasts_sha256"] == phase5_c._file_sha256(twin_dir / "forecasts.parquet")
    # A report whose recorded symbols_min or universe differ from those recomputed with is refused.
    with pytest.raises(ValueError, match="symbols_min"):
        phase5_c.run_family_c_twin(
            patched["ds"], runs, report_file, tmp_path / "t2", COMMIT, universe=tuple(SYMS), symbols_min=2
        )
    with pytest.raises(ValueError, match="universe"):
        phase5_c.run_family_c_twin(
            patched["ds"], runs, report_file, tmp_path / "t3", COMMIT, universe=tuple(SYMS[:2]), symbols_min=1
        )
    default_uni = json.loads(report_file.read_text()) | {"universe": ["BTCUSDT"]}
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps(default_uni))
    with pytest.raises(ValueError, match="universe"):
        phase5_c.run_family_c_twin(patched["ds"], runs, bad, tmp_path / "t4", COMMIT, **kw)
    assert not (tmp_path / "t2").exists() and not (tmp_path / "t3").exists() and not (tmp_path / "t4").exists()


def test_reproduction_inputs_keys_come_from_the_cli() -> None:
    repro = cli.reproduction_inputs()
    assert {"requirements_lock_sha256", "versions"} <= set(repro)


# ---------------------------------------------------------------------------------------------------------------------
# Descriptive long-lag DM p (R10)
# ---------------------------------------------------------------------------------------------------------------------


def _frame(n: int, seed: int = 1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    y = np.exp(rng.normal(0.0, 1.0, size=n)) * 1e-4
    return pd.DataFrame(
        {
            "coin": "BTCUSDT",
            "T": np.arange(n) * H,
            "y": y,
            "f": y * np.exp(rng.normal(0.0, 0.3, size=n)),
            "persistence": np.concatenate(([np.nan], y[:-1])),
            "ewma": np.full(n, np.exp(0.5) * 1e-4),
            "R": rng.uniform(-1, 1, size=n),
            "G": 0.01,
            "fold": 0,
            "lo80": -0.8,
            "hi80": 0.8,
            "lo95": -0.95,
            "hi95": 0.95,
        }
    )


@pytest.mark.parametrize(("window", "lag"), [("1h", 240), ("4h", 60), ("1d", 10)])
def test_long_lag_is_ten_calendar_days_per_window(window: str, lag: int) -> None:
    wms = family_c.WINDOWS[window]
    res = family_c.coin_criteria(_frame(3000), wms)
    assert lag == 10 * DAY // wms
    for t in res["tests"].values():
        assert t["lag_long"] == lag
        assert {"stat_long", "p_long"} <= set(t)
    t = res["tests"]["qlike_vs_ewma"]
    rows = family_c.paired_rows(_frame(3000))
    d = family_c.qlike(rows["y"], rows["f"]) - family_c.qlike(rows["y"], rows["ewma"])
    want = family_c.dm_test(d, lag)
    assert t["stat_long"] == pytest.approx(want["stat"]) and t["p_long"] == pytest.approx(want["p"])


def test_the_long_lag_p_never_gates(monkeypatch: pytest.MonkeyPatch) -> None:
    df = _frame(3000)
    base = family_c.coin_criteria(df, H)
    assert all(t["lag_long"] == 240 for t in base["tests"].values())
    real = family_c.dm_test

    def failing_long(d: Any, lag: int = 1) -> dict[str, Any]:
        res = real(d, lag)
        if lag > 1:
            res = {**res, "p": 0.99, "stat": 5.0}
        return res

    monkeypatch.setattr(family_c, "dm_test", failing_long)
    res = family_c.coin_criteria(df, H)
    assert res["pass"] == base["pass"]
    for name, t in res["tests"].items():
        assert t["pass"] == base["tests"][name]["pass"] and t["p"] == base["tests"][name]["p"]
        assert t["p_long"] == 0.99 and t["lag_long"] == 240


# ---------------------------------------------------------------------------------------------------------------------
# Seeds, predictions, signature (R2, R3, agy note)
# ---------------------------------------------------------------------------------------------------------------------


def test_h_seed_base_and_the_registered_flag2_prediction() -> None:
    assert family_c.STAY_OUT_H_SEED_BASE == 12_200_000
    assert family_c.STAY_OUT_SEED_BASE == 12_100_000 and family_c.REFIT_SEED_BASE == 7_100_000
    flag2 = family_c.PREDICTIONS["flag2"]
    assert "no flagged window" in flag2["1d_finalist"] and "condition 2" in flag2["1d_finalist"]
    assert "almost surely" in flag2["4h_finalist"]
    assert "blocked from H" in flag2["consequence"]
    with pytest.raises(NotImplementedError):
        family_c.run_holdout()


def test_trailing_vol_flags_has_no_window_parameter() -> None:
    assert list(inspect.signature(family_c.trailing_vol_flags).parameters) == ["t", "f"]


@pytest.mark.parametrize("stay_out_pass", [True, False])
def test_h_read_allowed_follows_a_passing_and_a_failing_stay_out(
    patched: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stay_out_pass: bool
) -> None:
    real_flag = family_c.stay_out_flag

    def forced(rows: pd.DataFrame, window_ms: int, registry_index: int) -> dict[str, Any]:
        res = real_flag(rows, window_ms, registry_index)
        res["pass"] = stay_out_pass
        return res

    monkeypatch.setattr(family_c, "stay_out_flag", forced)
    report = phase5_c.report_family_c(
        patched["ds"], patched["out"] / "runs", tmp_path, COMMIT, universe=tuple(SYMS), symbols_min=1
    )
    assert report["finalist"] is not None
    assert report["stay_out"]["pass"] is stay_out_pass
    assert report["h_read_allowed"] is stay_out_pass
