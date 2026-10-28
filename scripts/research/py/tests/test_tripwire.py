"""Tests for r4.tripwire: the label-shift tripwire (lock M, exploration bar item 4)."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import r4.tripwire as tw
from r4.bar import family_report
from r4.cli import main, run_tripwire
from r4.method import UNIVERSE
from r4.pipeline import RunConfig, decision_samples, walk_forward
from r4.plant import _aggregate
from r4.synth import synth_panel, write_synthetic_dataset
from tests.test_cli_bar import _set_kind, _write_planted_family

DAY = 86_400_000
H1 = 3_600_000
H4 = 14_400_000
START = 1672531200000  # 2023-01-01 UTC
SYMS = UNIVERSE[:6]


def _cov() -> np.ndarray:
    return np.eye(6) * 4e-4 + 1e-4


def _cfg_dict(features, interval="4h", h_ms=H4, first_refit_ms=START + 60 * DAY, **over) -> dict:
    cfg = {
        "id": "tw_run",
        "kind": "trial",
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": list(features),
        "interval": interval,
        "h_ms": h_ms,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "first_refit_ms": first_refit_ms,
        "seed": 7,
    }
    cfg.update(over)
    return cfg


def _run_config(cfg: dict) -> RunConfig:
    return RunConfig(
        family=cfg["family"],
        model=cfg["model"],
        params=cfg["params"],
        features=tuple(cfg["features"]),
        interval=cfg["interval"],
        h_ms=cfg["h_ms"],
        label=cfg["label"],
        side_rule=cfg["side_rule"],
        threshold=cfg["threshold"],
        size_rule=cfg["size_rule"],
        lookback_months=cfg["lookback_months"],
        refit=cfg["refit"],
        exit=cfg["exit"],
        seed=cfg["seed"],
        plant=cfg.get("plant"),
    )


def _with_drift(panel: dict, mu: dict[str, float]) -> dict:
    """The panel with a constant log drift per 5m bar added to each coin, higher bars re-aggregated from 5m."""
    out = {}
    for sym, d in panel.items():
        frames = dict(d)
        five = d["5m"].copy()
        i = np.arange(len(five), dtype=np.float64)
        m = mu[sym]
        five["o"] = five["o"].to_numpy() * np.exp(m * i)
        five["c"] = five["c"].to_numpy() * np.exp(m * (i + 1.0))
        five["h"] = five["h"].to_numpy() * np.exp(m * (i + 1.0))
        five["l"] = five["l"].to_numpy() * np.exp(m * i)
        frames["5m"] = five
        for iv, ms in (("15m", 900_000), ("1h", H1), ("4h", H4), ("1d", DAY)):
            frames[iv] = _aggregate(five, ms)
        out[sym] = frames
    return out


# ---------------------------------------------------------------------------
# shift_labels
# ---------------------------------------------------------------------------


def _toy_samples(drop: set[int]) -> pd.DataFrame:
    n = 24 * 40
    t = START + np.arange(n, dtype=np.int64) * H1
    df = pd.DataFrame(
        {
            "symbol": "AAA",
            "T": t,
            "f1": np.arange(n, dtype=np.float64),
            "entry": 100.0 + np.arange(n),
            "exit": 200.0 + np.arange(n),
            "gross_log": np.arange(n, dtype=np.float64) * 0.001,
            "t0": t,
            "t1_max": t + H4,
        }
    )
    return df.drop(index=sorted(drop)).reset_index(drop=True)


def test_shift_maps_by_time_not_row():
    """With irregular missing rows, T' is found by time: a row whose T' has no sample is dropped."""
    n = 24 * 40
    drop = {5, 6, 7, 100, 250, 251, 700, 900}
    s = _toy_samples(drop)
    shifted, n_dropped = tw.shift_labels(s, 30 * DAY, H1)
    present = {i for i in range(n)} - drop
    lo, hi = min(present), max(present)
    length = (hi - lo + 1) * H1
    expected_rows = []
    for i in sorted(present):
        tp = START + lo * H1 + ((i - lo) * H1 + 30 * DAY) % length
        j = (tp - START) // H1
        if j in present:
            expected_rows.append((i, j))
    assert n_dropped == len(present) - len(expected_rows) > 0
    assert len(shifted) == len(expected_rows)
    for (i, j), (_, row) in zip(expected_rows, shifted.iterrows(), strict=True):
        assert row["T"] == START + i * H1
        assert row["gross_log"] == pytest.approx(j * 0.001)
    # by row index the wrong value would result wherever rows are missing before the shifted position
    by_row = s["gross_log"].to_numpy()[(np.arange(len(s)) + 30 * 24) % len(s)]
    assert not np.allclose(shifted["gross_log"].to_numpy(), by_row[: len(shifted)])


def test_features_and_prices_unshifted():
    s = _toy_samples({3, 50, 400})
    s["tb_label"] = np.arange(len(s), dtype=np.float64)
    s["tb_net"] = s["tb_label"] * 2
    s["tb_exit"] = s["tb_label"] * 3
    s["tb_label_short"] = -s["tb_label"]
    s["tb_net_short"] = -s["tb_net"]
    s["tb_exit_short"] = -s["tb_exit"]
    shifted, _ = tw.shift_labels(s, 37 * DAY, H1)
    keep = s["T"].isin(shifted["T"])
    base = s.loc[keep].reset_index(drop=True)
    for col in ("symbol", "T", "f1", "entry", "exit", "t0", "t1_max"):
        pd.testing.assert_series_equal(shifted[col], base[col])
    for col in tw.LABEL_COLUMNS:
        if col in s.columns:
            assert not np.array_equal(shifted[col].to_numpy(), base[col].to_numpy())
    # only existing label columns are touched, and the other labels follow the same source row
    assert set(shifted.columns) == set(s.columns)
    assert np.allclose(shifted["tb_net"].to_numpy(), 2 * shifted["tb_label"].to_numpy())
    assert np.allclose(shifted["tb_label_short"].to_numpy(), -shifted["tb_label"].to_numpy())


# ---------------------------------------------------------------------------
# halt rule
# ---------------------------------------------------------------------------


def test_halt_rule_exact(monkeypatch):
    """60 of 100 does not halt, 61 does. Driven both directly and through the loop."""
    assert tw.halt_decision(60, 100) is False
    assert tw.halt_decision(61, 100) is True

    def make_runner(n_pos: int):
        def fake(samples, cfg, shift_days, first_refit_ms, end_ms, panel):
            k = (shift_days - 30) // 7
            return {
                "shift_days": shift_days,
                "wf_mean": 0.001 if k < n_pos else -0.001,
                "cost_free_mean": 0.002 if k < n_pos else -0.002,
                "n_rows": 10,
                "n_dropped": 1,
                "drop_share": 0.1,
                "effective_shift_days": float(shift_days),
            }

        return fake

    cfg = _run_config(_cfg_dict(["f1"], interval="1h", h_ms=H4))
    samples = _toy_samples(set())
    for n_pos, halt in ((60, False), (61, True)):
        monkeypatch.setattr(tw, "shifted_run", make_runner(n_pos))
        res = tw.label_shift_tripwire(samples, cfg, first_refit_ms=START, end_ms=START + 40 * DAY, panel=None)
        assert [s["shift_days"] for s in res["shifts"]] == [30 + 7 * k for k in range(100)]
        assert res["n"] == 100 and res["positive"] == n_pos and res["halt"] is halt
        assert res["positive_cost_free"] == n_pos
        assert res["drop_share_mean"] == pytest.approx(0.1)


# ---------------------------------------------------------------------------
# synthetic panels
# ---------------------------------------------------------------------------

SHIFTS = [30 + 7 * k for k in range(12)]


def test_tripwire_on_planted_signal_does_not_halt():
    """A planted feature predicts its own label, so the unshifted run is positive and shifts break the link."""
    panel = synth_panel(_cov(), SYMS, START, START + 150 * DAY, seed=3)
    raw = _cfg_dict(["planted_z"], plant={"seed": 5, "amplitude": 0.004}, first_refit_ms=START + 90 * DAY)
    cfg = _run_config(raw)
    from r4.plant import apply_plant

    planted = apply_plant(panel, cfg.plant)
    samples = decision_samples(planted, cfg)
    base = walk_forward(samples, cfg, first_refit_ms=raw["first_refit_ms"], end_ms=START + 150 * DAY, panel=planted)
    assert float(base.drift_free["drift_free"].mean()) > 0.0
    res = tw.label_shift_tripwire(
        samples,
        cfg,
        first_refit_ms=raw["first_refit_ms"],
        end_ms=START + 150 * DAY,
        panel=planted,
        shifts_days=SHIFTS,
    )
    assert res["n"] == 12 and res["halt"] is False
    assert res["positive"] <= 0.6 * 12
    assert 0.0 <= res["drop_share_mean"] < 1.0


def test_tripwire_detects_non_feature_profit():
    """The tripwire catches profit that survives breaking the feature-label link.

    Three coins get a persistent positive idiosyncratic drift and three a negative one, summing to zero, so the
    equal-weight basket and the beta hedge leave the coin-specific drift in the book. One ridge on trend_1d fits a
    pooled intercept and slope: up-drifting coins have a high trailing trend, so trend "predicts" the label. A
    circular shift of at least 30 days moves each coin's labels along its own time axis, and a coin's labels keep
    their drift sign under any shift, so the same trend-to-label relation is still fitted and the book still goes
    long the up-drifting coins. The shifted runs are therefore mostly positive and the tripwire halts: the profit
    does not come from a feature-label link. A leak that runs only through the features would NOT survive the
    shift (the shifted labels no longer match the leaked feature), so catching that is the job of the causality and
    perturbation tests, not of this tripwire.
    """
    n_days = 150
    panel = synth_panel(_cov(), SYMS, START, START + n_days * DAY, seed=11)
    mu = {s: (1e-4 if i < 3 else -1e-4) for i, s in enumerate(SYMS)}
    panel = _with_drift(panel, mu)
    raw = _cfg_dict(["trend_1d"])
    cfg = _run_config(raw)
    end_ms = START + n_days * DAY
    samples = decision_samples(panel, cfg)
    base = walk_forward(samples, cfg, first_refit_ms=raw["first_refit_ms"], end_ms=end_ms, panel=panel)
    assert float(base.drift_free["drift_free"].mean()) > 0.0
    res = tw.label_shift_tripwire(
        samples, cfg, first_refit_ms=raw["first_refit_ms"], end_ms=end_ms, panel=panel, shifts_days=SHIFTS
    )
    assert res["positive"] > 0.6 * res["n"]
    assert res["halt"] is True


# ---------------------------------------------------------------------------
# receipts and CLI
# ---------------------------------------------------------------------------


def test_tripwire_receipts_rejected_in_round_dir(tmp_path: Path):
    """A receipt of kind tripwire in the round directory or the family directory raises."""
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    round_dir = tmp_path / "round"
    for run_id in ("cfg_0", "cfg_1"):
        (round_dir / run_id).mkdir(parents=True)
        for name in ("receipt.json", "daily.parquet"):
            (round_dir / run_id / name).write_bytes((runs_dir / run_id / name).read_bytes())
    _set_kind(round_dir, {"cfg_1": "tripwire"})
    with pytest.raises(ValueError, match="tripwire"):
        family_report("A", runs_dir, round_dir, 120, ds_dir, panel=panel)
    fam_dir = tmp_path / "fam"
    shutil.copytree(runs_dir, fam_dir)
    _set_kind(fam_dir, {"cfg_0": "tripwire"})
    with pytest.raises(ValueError, match="tripwire"):
        family_report("A", fam_dir, runs_dir, 120, ds_dir, panel=panel)


def _small_dataset(tmp_path: Path) -> tuple[Path, Path]:
    panel = synth_panel(_cov(), SYMS, START, START + 130 * DAY, seed=21)
    ds = tmp_path / "ds"
    write_synthetic_dataset(panel, ds)
    cfg = _cfg_dict(["ret_24", "trend_1d"], first_refit_ms=START + 80 * DAY)
    f = tmp_path / "cfg.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    return ds, f


def test_run_tripwire_writes_json_and_non_trial_receipts(tmp_path: Path):
    ds, cfg_file = _small_dataset(tmp_path)
    out = tmp_path / "out"
    res = run_tripwire(cfg_file, ds, out, commit="abc1234", shifts_days=[30, 37, 44])
    run_dir = out / "tw_run"
    on_disk = json.loads((run_dir / "tripwire.json").read_text(encoding="utf-8"))
    assert on_disk["n"] == 3 and on_disk["positive"] == res["positive"] and on_disk["halt"] is res["halt"]
    assert [s["shift_days"] for s in on_disk["shifts"]] == [30, 37, 44]
    receipts = sorted((run_dir / "tripwire").glob("*/receipt.json"))
    assert len(receipts) == 3
    for r in receipts:
        rec = json.loads(r.read_text(encoding="utf-8"))
        assert rec["kind"] == "tripwire" and rec["commit"] == "abc1234"
        assert rec["config_hash"] and rec["shift_days"] in (30, 37, 44)
    # the run directory itself holds no trial receipt
    assert not (run_dir / "receipt.json").exists()
    # the file feeds family_report's tripwire input
    assert {"positive", "n"} <= set(on_disk)


def test_cli_tripwire_subcommand(tmp_path: Path, monkeypatch, capsys):
    ds, cfg_file = _small_dataset(tmp_path)
    out = tmp_path / "out2"
    monkeypatch.setattr(
        sys,
        "argv",
        ["r4", "tripwire", "--config", str(cfg_file), "--ds", str(ds), "--out", str(out), "--commit", "abc1234",
         "--shifts", "2"],
    )  # fmt: skip
    main()
    data = json.loads((out / "tw_run" / "tripwire.json").read_text(encoding="utf-8"))
    assert data["n"] == 2
    assert "tripwire" in capsys.readouterr().out.lower()


def test_shifted_run_trains_on_no_label_from_the_test_period(monkeypatch):
    """Finding 8: the source label window of every training row ends before the refit cut less the embargo."""
    import r4.pipeline as pl
    from r4.method import CPCV_EMBARGO_MS

    n_days = 190
    panel = synth_panel(_cov(), SYMS, START, START + n_days * DAY, seed=3)
    raw = _cfg_dict(["ret_24", "trend_1d"], first_refit_ms=START + 70 * DAY)
    cfg = _run_config(raw)
    end_ms = START + n_days * DAY
    samples = decision_samples(panel, cfg)

    seen: list[tuple[int, int, int]] = []  # (training rows, max source window end, max real window end)
    real_fit = pl.fit_side_model

    def spy(c, x, train_df):
        seen.append((len(train_df), int(train_df["label_t1_max"].max()), int(train_df["t1_max"].max())))
        return real_fit(c, x, train_df)

    monkeypatch.setattr(pl, "fit_side_model", spy)
    out = tw.shifted_run(samples, cfg, 100, raw["first_refit_ms"], end_ms, panel)
    assert out["shift_days"] == 100

    cuts = []
    cur = pd.to_datetime(raw["first_refit_ms"], unit="ms", utc=True)
    while cur < pd.to_datetime(end_ms, unit="ms", utc=True):
        cuts.append(int(cur.timestamp() * 1000))
        cur = cur + pd.DateOffset(months=1)
    # a leading fold whose purged training set is empty is skipped, so the fits belong to the last cuts
    assert len(seen) >= 3
    for cut, (_n, src_end, _real_end) in zip(cuts[-len(seen) :], seen, strict=True):
        assert src_end < cut - CPCV_EMBARGO_MS
    # the purge is what removes them: the real-label cut alone would have let some source window reach the cut
    shifted, _ = tw.shift_labels(samples, 100 * DAY, H1, with_source_window=True)
    leaks = [int(shifted.loc[shifted["t1_max"] < cut, "label_t1_max"].max()) >= cut - CPCV_EMBARGO_MS for cut in cuts]
    assert any(leaks)


def test_shift_labels_source_window_column_is_opt_in():
    s = _toy_samples({3, 50})
    plain, _ = tw.shift_labels(s, 37 * DAY, H1)
    assert "label_t1_max" not in plain.columns
    with_src, _ = tw.shift_labels(s, 37 * DAY, H1, with_source_window=True)
    assert (with_src["label_t1_max"] - with_src["T"]).nunique() > 1  # the source row's window end, not the row's own
    # the window end belongs to the same source row as the label
    src_t1 = dict(zip(s["gross_log"].round(9), s["t1_max"], strict=True))
    for g, w in zip(with_src["gross_log"].round(9), with_src["label_t1_max"], strict=True):
        assert src_t1[g] == w
