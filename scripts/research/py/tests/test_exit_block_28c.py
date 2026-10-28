"""Brief 28c: replay reproduction, the exit-control block and the gate's checks (synthetic data only)."""

from __future__ import annotations

import copy
import dataclasses
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4 import calibration as cal
from r4.cli import main, run_wf
from r4.method import UNIVERSE
from r4.synth import synth_panel, write_synthetic_dataset
from tests.test_calibration_power import _exit_block as dossier_exit_block
from tests.test_calibration_power import _inputs, _noise_eval, _prov
from tests.test_cli_bar import COMMIT

DAY = 86_400_000
START = 1672531200000  # 2023-01-01 UTC
N_DAYS = 185
FIRST_REFIT = 1_680_307_200_000  # 2023-04-01 UTC, test only: the panel starts 2023-01-01
SPAN_END = START + N_DAYS * DAY
SYMS = tuple(UNIVERSE[:6])
RULES = ("E2", "E3", "E4", "E5", "E6", "X1")


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    root = tmp_path_factory.mktemp("exit_block")
    cov = (0.02**2) * (0.3 * np.ones((6, 6)) + 0.7 * np.eye(6))
    panel = synth_panel(cov, SYMS, START, SPAN_END, seed=31)
    ds = write_synthetic_dataset(panel, root / "ds")
    base = next(c for c in cal.noise_grid() if c["block"] == "ridge" and c["cell"] == "C4" and c["seed_ordinal"] == 1)
    cfg = {**base, "first_refit_ms": FIRST_REFIT}
    cfg_dir = root / "cfg"
    cfg_dir.mkdir()
    (cfg_dir / f"{cfg['id']}.json").write_text(json.dumps(cfg), encoding="utf-8")
    run_wf(cfg_dir / f"{cfg['id']}.json", ds, root / "noise", commit=COMMIT, panel=panel)
    out = root / "exit"
    res = cal.evaluate_exit_block(
        ds,
        root / "noise",
        out,
        commit=COMMIT,
        panel=panel,
        joint_draws=10,
        first_refit_ms=FIRST_REFIT,
        span_end_ms=SPAN_END,
        synthetic_panels=3,
        synthetic_days=60,
    )
    return {"panel": panel, "ds": ds, "noise": root / "noise", "out": out, "res": res, "root": root, "base": cfg}


def _run_dirs(world) -> dict[str, Path]:
    return {c["id"]: world["out"] / "runs" / c["id"] for c in cal.exit_block()}


def test_replay_reproduces_all_exit_rules(world):
    dirs = _run_dirs(world)
    assert len(dirs) == 6
    for cid, d in dirs.items():
        out = cal.check_replay_reproduces(d, world["ds"], panel=world["panel"])
        assert out["n"] > 100, cid
        assert out["mismatches"] == 0, (cid, out["first_mismatch"])
        assert out["first_mismatch"] is None
        assert out["n"] == len(pd.read_parquet(d / "tranches.parquet"))


def test_replay_reproduction_detects_altered_model(world, monkeypatch):
    from r4.exit_models import ExitModelFactory, ExitModelInputs

    d = next(p for cid, p in _run_dirs(world).items() if "_E4_" in cid)
    honest = cal.check_replay_reproduces(d, world["ds"], panel=world["panel"])
    assert honest["mismatches"] == 0
    original = ExitModelFactory.fit

    def altered(self, t_start, cut_ms, select=None):
        fitted = original(self, t_start, cut_ms, select)
        pair = dataclasses.replace(fitted.pair, ridge_intercept=fitted.pair.ridge_intercept - 50.0)
        return ExitModelInputs(pair, fitted.frames)

    monkeypatch.setattr(ExitModelFactory, "fit", altered)
    bad = cal.check_replay_reproduces(d, world["ds"], panel=world["panel"])
    assert bad["mismatches"] > 0 and bad["first_mismatch"] is not None
    assert bad["n"] == honest["n"]


def test_exit_block_small(world, tmp_path):
    res = world["res"]
    assert [c["id"] for c in res["configs"]] == [c["id"] for c in cal.exit_block()]
    assert res["gated_max"] == 1 and res["rejected"] == res["n_rejected"]
    assert res["as_predicted"] is (res["rejected"] <= 1)
    for c in res["configs"]:
        assert 0.0 < c["p"] <= 1.0 and c["rejected"] is (c["p"] < 0.05)
        assert c["draws"] == 10
    # The small run (10 draws, 3 panels of 60 days, a test-only first refit) is not the registered block, and the
    # dossier validator says so. Restoring only the fields reduced for speed makes it acceptable.
    with pytest.raises(ValueError):
        cal._validate_exit_block(res)
    from r4.cli import config_hash_of
    from r4.method import BAR

    registered = copy.deepcopy(res)
    for row, cfg in zip(registered["configs"], cal.exit_block(), strict=True):
        row["draws"] = BAR["random_entry_draws"]
        row["config_hash"] = config_hash_of(cfg)
    registered["optional_stopping"]["n_panels"] = cal.OPT_STOP_PANELS
    registered["optional_stopping"]["n_days"] = cal.OPT_STOP_DAYS
    assert cal._validate_exit_block(registered) == res["rejected"]
    assert res["provenance"]["commits"] == [COMMIT] and len(res["provenance"]["source_sha256"]) == 1
    json.dumps(res)
    # And the dossier takes it (the freeze check needs the other inputs' provenance, so borrow the test commit).
    shaped = {**registered, "provenance": _prov()}
    noise = {**_noise_eval(), "dataset_hash": res["dataset_hash"]}
    doc = cal.write_dossier(tmp_path / "d.json", **_inputs(tmp_path, exit_block=shaped, noise_eval=noise))
    assert doc["predictions"]["exit_block_at_most_1_of_6_rejects"]["observed"] == res["rejected"]


def test_exit_block_p_equals_the_engine_null(world):
    """The recorded p is the one joint_shift_null gives for the same replay, tranches, draws and seed."""
    from r4 import bar

    cid = next(c["id"] for c in cal.exit_block() if c["exit"]["rule"] == "E3")
    d = world["out"] / "runs" / cid
    receipt = json.loads((d / "receipt.json").read_text(encoding="utf-8"))
    folds = json.loads((d / "folds.json").read_text(encoding="utf-8"))
    replay = bar.build_exit_replay(world["panel"], receipt["config"], folds)
    p, drop, obs, _ = bar.joint_shift_null(
        pd.read_parquet(d / "tranches.parquet"),
        world["panel"],
        folds,
        FIRST_REFIT,
        SPAN_END,
        n_draws=10,
        seed=int(receipt["config"]["joint_shift_seed"]),
        exit_replay=replay,
    )
    row = next(c for c in world["res"]["configs"] if c["id"] == cid)
    assert row["p"] == p and row["drop_share"] == drop and row["seed"] == receipt["config"]["joint_shift_seed"]
    assert row["observed"] == obs


def test_exit_block_raises_on_replay_mismatch(world, monkeypatch, tmp_path):
    monkeypatch.setattr(
        cal,
        "check_replay_reproduces",
        lambda *a, **k: {"n": 5, "mismatches": 2, "first_mismatch": {"row": 1, "field": "exit_ms"}},
    )
    with pytest.raises(ValueError, match="replay"):
        cal.evaluate_exit_block(
            world["ds"],
            world["noise"],
            tmp_path / "x",
            commit=COMMIT,
            panel=world["panel"],
            joint_draws=5,
            first_refit_ms=FIRST_REFIT,
            span_end_ms=SPAN_END,
            synthetic_panels=1,
            synthetic_days=40,
        )


def test_shift_zero_identity(world, monkeypatch, tmp_path):
    """The observed statistic from the stored tranches equals the replay path at zero shift, for every rule."""
    for c in world["res"]["configs"]:
        z = c["shift_zero"]
        assert z["ok"] is True and z["abs_diff"] <= 1e-12 * max(1.0, abs(z["observed"])), c["id"]
        assert np.isfinite(z["observed"]) and np.isfinite(z["replayed"])
    # A broken identity raises.
    from r4 import bar

    real = bar.joint_shift_stats

    def skewed(*a, **k):
        s = real(*a, **k)
        return s._replace(zero_shift_stat=s.obs_stat + 1e-3)

    monkeypatch.setattr(bar, "joint_shift_stats", skewed)
    with pytest.raises(ValueError, match="shift-zero"):
        cal.evaluate_exit_block(
            world["ds"],
            world["noise"],
            world["out"],
            commit=COMMIT,
            panel=world["panel"],
            joint_draws=5,
            first_refit_ms=FIRST_REFIT,
            span_end_ms=SPAN_END,
            synthetic_panels=1,
            synthetic_days=40,
        )


def test_joint_shift_stats_zero_shift_matches_observed_without_exit_replay_for_a_time_exit(world):
    """The zero-shift value is only produced with a replay, and is None otherwise."""
    from r4 import bar

    d = next(p for cid, p in _run_dirs(world).items() if "_E2_" in cid)
    folds = json.loads((d / "folds.json").read_text(encoding="utf-8"))
    receipt = json.loads((d / "receipt.json").read_text(encoding="utf-8"))
    tr = pd.read_parquet(d / "tranches.parquet")
    replay = bar.build_exit_replay(world["panel"], receipt["config"], folds)
    with_zero = bar.joint_shift_stats(
        tr, world["panel"], folds, FIRST_REFIT, SPAN_END, n_draws=3, seed=1, exit_replay=replay, zero_shift=True
    )
    without = bar.joint_shift_stats(
        tr, world["panel"], folds, FIRST_REFIT, SPAN_END, n_draws=3, seed=1, exit_replay=replay
    )
    assert with_zero.zero_shift_stat is not None and without.zero_shift_stat is None
    assert with_zero.zero_shift_stat == pytest.approx(with_zero.obs_stat, abs=1e-12)
    assert np.array_equal(with_zero.null_stats, without.null_stats)


def test_exit_block_entries_match_base(world, tmp_path):
    for c in world["res"]["configs"]:
        assert c["entries_match_base"] is True and c["n_entries"] > 100
    base_id = world["base"]["id"]
    # Drop one tranche of the base run: the entry sets differ and the evaluation raises.
    noise = tmp_path / "noise"
    shutil.copytree(world["noise"], noise)
    f = noise / base_id / "tranches.parquet"
    df = pd.read_parquet(f)
    df.iloc[1:].to_parquet(f, index=False)
    with pytest.raises(ValueError, match="entry set"):
        cal.evaluate_exit_block(
            world["ds"],
            noise,
            world["out"],
            commit=COMMIT,
            panel=world["panel"],
            joint_draws=5,
            first_refit_ms=FIRST_REFIT,
            span_end_ms=SPAN_END,
            synthetic_panels=1,
            synthetic_days=40,
        )


def test_exit_block_counters_and_fire_rates(world):
    for c in world["res"]["configs"]:
        rule = c["rule"]
        n = c["n_entries"]
        ctr = c["counters"]
        for k in ("missing_model", "missing_sigma", "missing_flow", "missing_funding"):
            assert 0.0 <= ctr[f"{k}_share"] <= 1.0, (c["id"], k)
        assert 0.0 <= ctr["joint_shift_drop_share"] <= 1.0 and ctr["joint_shift_drop_share"] == c["drop_share"]
        if rule in ("E4", "E5"):
            assert ctr["exit_model_fallback_folds"] == 0
            assert ctr["exit_model_folds"] >= 1
        fr = c["fire_rates"]
        assert sum(fr["by_reason_counts"].values()) == n
        assert fr["early_share"] == pytest.approx(1.0 - fr["by_reason_counts"].get("horizon", 0) / n)
        assert fr["never_fires"] is (fr["early_share"] == 0.0)
        assert sum(fr["by_reason_share"].values()) == pytest.approx(1.0)
        # Diagnostics of section 2.
        assert 0.0 < c["median_hold_share_of_h"] <= 1.0 + 1e-12
        assert set(c["increment_vs_e1"]) >= {"wf_mean", "cost_free_mean"}
        assert c["increment_vs_e1"]["wf_mean"] == pytest.approx(
            c["wf_mean"] - world["res"]["base"]["wf_mean"], abs=1e-15
        )


def test_exit_block_raises_on_exit_model_fallback(world, monkeypatch, tmp_path):
    monkeypatch.setattr("r4.exit_models.MIN_SAMPLES", 10**9)
    only_e4 = [c for c in cal.exit_block() if c["exit"]["rule"] == "E4"]
    monkeypatch.setattr(cal, "exit_block", lambda: only_e4)
    with pytest.raises(ValueError, match="fallback"):
        cal.evaluate_exit_block(
            world["ds"],
            world["noise"],
            tmp_path / "fb",
            commit=COMMIT,
            panel=world["panel"],
            joint_draws=5,
            first_refit_ms=FIRST_REFIT,
            span_end_ms=SPAN_END,
            synthetic_panels=1,
            synthetic_days=40,
        )


def test_exit_block_determinism(world):
    det = world["res"]["determinism"]
    assert det["identical"] is True and det["differences"] == []
    assert set(det["rules"]) == set(RULES)
    assert set(det["model_coefficients_compared"]) == {"E4", "E5"}
    assert det["model_fits_compared"] >= 2


def test_receipt_comparison_flags_a_difference():
    a = {"metrics": {"x": 1.0}, "runtime_s": 3.0, "config": {"id": "a"}}
    b = {"metrics": {"x": 1.0}, "runtime_s": 9.0, "config": {"id": "a"}}
    assert cal._receipt_differences(a, b) == []
    b["metrics"]["x"] = 1.0000001
    assert cal._receipt_differences(a, b) == ["metrics.x"]


def test_optional_stopping_catches_future_information(monkeypatch):
    """An exit that reads the horizon price before deciding profits on a martingale, and the check flags it."""
    from r4.exits import STEP_MS, ExitContext

    honest = cal.optional_stopping_check(n_panels=8, n_days=22, rules=("E2", "X1"), seed_base=777)
    assert honest["rules"]["E2"]["significant"] is False
    original = ExitContext.replay

    def peeking(self, entries, spec):
        out = original(self, entries, spec).copy()
        if getattr(spec, "rule", None) != "E2":
            return out
        for i, row in enumerate(entries.itertuples(index=False)):
            b = self.bars[row.symbol]
            j = int(np.searchsorted(b.t, row.exit_ms))
            if row.side * (b.o[j] - row.entry_price) < 0:
                out.loc[i, ["exit_ms", "exit_price", "exit_fill", "exit_reason"]] = [
                    row.entry_ms + STEP_MS,
                    row.entry_price,
                    "taker",
                    "stop",
                ]
        return out

    monkeypatch.setattr(ExitContext, "replay", peeking)
    cheat = cal.optional_stopping_check(n_panels=8, n_days=22, rules=("E2", "X1"), seed_base=777)
    assert cheat["rules"]["E2"]["significant"] is True and cheat["rules"]["E2"]["mean"] > 0.0
    assert cheat["rules"]["E2"]["p_two_sided"] < 0.01


def test_optional_stopping_clean_on_martingale_panels():
    out = cal.optional_stopping_check(n_panels=20, n_days=30, rules=("E2", "E3", "E6", "X1"), seed_base=100)
    assert out["n_panels"] == 20 and out["alpha"] == 0.01
    for rule in ("E2", "E3", "E6"):
        r = out["rules"][rule]
        assert r["significant"] is False and r["p_two_sided"] >= 0.01, (rule, r)
        assert len(r["panel_means"]) == 20 and r["n_tranches"] > 1000
    x1 = out["rules"]["X1"]
    assert x1["positive"] is False and x1["p_one_sided_positive"] >= 0.01
    assert out["met"] is True


def test_registered_diagnostics_shapes(world):
    diag = world["res"]["diagnostics"]
    mh = diag["median_hold"]
    assert set(mh["rules"]) == {"E4", "E5", "E6"} and mh["threshold"] == 0.8
    for r in mh["rules"].values():
        assert 0.0 < r["median_share"] <= 1.0 + 1e-12 and r["n_tranches"] > 0
    assert mh["met"] is all(r["median_share"] >= 0.8 for r in mh["rules"].values())
    pl = diag["planted_intrabar"]
    assert set(pl["rules"]) == {"E4", "E5", "E6"} and pl["max_false_close_rate"] == 0.2
    for r in pl["rules"].values():
        assert {"increment", "close_ahead_rate", "false_close_rate", "n_planted", "n_unplanted", "met"} <= set(r)
        assert 0.0 <= r["false_close_rate"] <= 1.0 and 0.0 <= r["close_ahead_rate"] <= 1.0
    assert pl["met"] is all(r["met"] for r in pl["rules"].values())
    assert world["res"]["optional_stopping"]["rules"].keys() == set(RULES) | {"E4_loose", "E5_loose"}


def test_planted_control_records_the_registered_e6_result():
    """The registered control (brief 28e) records E6's increment and both rates on the spec's planted reversal."""
    out = cal.planted_intrabar_control(rules=("E6",))
    r = out["rules"]["E6"]
    assert set(out["rules"]) == {"E6"} and r["n_planted"] > 50 and r["n_unplanted"] > 50
    assert r["met"] is bool(r["increment"] > 0.0 and r["close_ahead_rate"] >= 0.8 and r["false_close_rate"] <= 0.2)


def test_dossier_evaluates_registered_diagnostics(tmp_path):
    def block(**diag):
        b = dossier_exit_block()
        b["diagnostics"]["median_hold"]["met"] = diag.get("hold", True)
        b["diagnostics"]["planted_intrabar"]["met"] = diag.get("planted", True)
        return b

    def run(name, exit_block):
        sub = tmp_path / name
        sub.mkdir()
        return cal.write_dossier(sub / "d.json", **_inputs(sub, exit_block=exit_block))

    ok = run("ok", block())
    assert ok["predictions"]["exit_median_hold_at_least_80pct"]["as_predicted"] is True
    assert ok["predictions"]["exit_planted_intrabar_control"]["as_predicted"] is True
    assert ok["predictions"]["exit_planted_intrabar_control"]["evidence"] == "exit_block"
    miss = run("miss", block(hold=False, planted=False))
    assert miss["predictions"]["exit_median_hold_at_least_80pct"]["as_predicted"] is False
    assert miss["predictions"]["exit_planted_intrabar_control"]["as_predicted"] is False
    assert miss["gate_p_ready"] is True  # diagnostics never block the gate
    # An exit block without the diagnostics is refused (brief 28e): they are no longer optional.
    old = dossier_exit_block()
    del old["diagnostics"]
    with pytest.raises(ValueError):
        run("old", old)
    # A malformed diagnostic raises.
    bad = block()
    bad["diagnostics"]["median_hold"]["met"] = "yes"
    with pytest.raises(ValueError):
        run("bad", bad)


def test_cli_calib_exits(tmp_path, monkeypatch):
    seen = {}

    def fake(ds, noise, out, commit=None, **kw):
        seen.update(ds=ds, noise=noise, out=out, commit=commit, kw=kw)
        return {"configs": [], "n_rejected": 0}

    monkeypatch.setattr(cal, "evaluate_exit_block", fake)
    monkeypatch.setattr(
        sys,
        "argv",
        ["r4", "calib-exits", "--ds", "D", "--noise-runs", "N", "--out", str(tmp_path / "o"), "--commit", "abc1234"],
    )
    main()
    assert (seen["ds"], seen["noise"], seen["commit"]) == ("D", "N", "abc1234")
    written = json.loads((tmp_path / "o" / "exit_block.json").read_text(encoding="utf-8"))
    assert written["n_rejected"] == 0


def test_exit_block_config_unchanged_by_the_evaluation(world):
    """The evaluation runs the registered configs as registered (apart from the test-only first refit)."""
    for cfg in cal.exit_block():
        run = json.loads((world["out"] / "runs" / cfg["id"] / "receipt.json").read_text(encoding="utf-8"))
        want = copy.deepcopy(cfg)
        want["first_refit_ms"] = FIRST_REFIT
        assert run["config"] == want
        assert run["kind"] == "control"


def test_replay_reproduces_model_exits_that_fire(tmp_path):
    """E4 and E5 with real features and thresholds that fire: the replay still reproduces every stored exit.

    The registered noise-feature E4 and E5 configs close nothing on noise, so they would reproduce trivially.
    """
    from tests.test_cli_bar import _make_fast_synthetic_panel

    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=125, seed=10, inject_signal=True)
    ds = write_synthetic_dataset(panel, tmp_path / "ds")
    specs = {"E4": {"rule": "E4", "margin_se": 0.05}, "E5": {"rule": "E5", "p_close": 0.5, "confirm_bars": 1}}
    for rule, spec in specs.items():
        cfg = {
            "id": f"fire_{rule}",
            "kind": "control",
            "family": "A",
            "model": "ridge",
            "params": {"alpha": 1.0},
            "features": ["ret_1", "ret_4"],
            "interval": "1h",
            "h_ms": 14_400_000,
            "label": "fixed",
            "side_rule": "sign",
            "threshold": 0.0001,
            "size_rule": "unit",
            "lookback_months": None,
            "refit": "monthly",
            "exit": spec,
            "first_refit_ms": FIRST_REFIT,
            "seed": 7,
            "joint_shift_seed": 1,
        }
        f = tmp_path / f"{cfg['id']}.json"
        f.write_text(json.dumps(cfg), encoding="utf-8")
        receipt = run_wf(f, ds, tmp_path / "runs", commit=COMMIT, panel=panel)
        tr = pd.read_parquet(tmp_path / "runs" / cfg["id"] / "tranches.parquet")
        assert (tr["exit_reason"] == "model_exit").sum() > 50, rule
        assert receipt["metrics"]["exit_model_fallback_folds"] == 0
        out = cal.check_replay_reproduces(tmp_path / "runs" / cfg["id"], ds, panel=panel)
        assert out["n"] == len(tr) and out["mismatches"] == 0, (rule, out["first_mismatch"])
