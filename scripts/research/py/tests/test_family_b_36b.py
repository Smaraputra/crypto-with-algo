"""Brief 36b: family B entry points (synthetic check, noise run and evaluation, run, report, twins). Synthetic only."""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import bar, calibration, cli, family_b, phase5_b, stats
from r4.book import DAY_MS
from r4.method import DEV_END, UNIVERSE
from r4.synth import _jsonl_gz_bytes, write_synthetic_dataset
from tests.test_cli_bar import _make_fast_synthetic_panel

H = 3_600_000
DAY = 86_400_000
COMMIT = "b" * 40
FIRST_REFIT = 1680307200000  # 2023-04-01 UTC
SYMS = list(UNIVERSE[:6])
SMALL_F = ("ret_1", "ret_4")
SMALL_PARAMS = {"n_estimators": 8, "num_leaves": 5, "min_child_samples": 10}
REAL_NOISE = family_b.family_b_noise
REAL_FAMILY = family_b.family_b
REAL_ELIGIBLE = family_b.eligible
CHEAP_IDS = ["B_rule_sti_C1", "B_meta12_sti_C1", "B_rule_ll_C1", "B_meta24_ll_C1"]


def _cheap_noise(attempts: Any = None) -> list[dict[str, Any]]:
    out = REAL_NOISE(attempts)
    for c in out:
        c["params"] = dict(SMALL_PARAMS)
        c["first_refit_ms"] = FIRST_REFIT
    return out


def _cheap_family() -> list[dict[str, Any]]:
    by_id = {c["id"]: c for c in REAL_FAMILY()}
    out = []
    for cid in CHEAP_IDS:
        c = copy.deepcopy(by_id[cid])
        sig = family_b.SIGNAL_COLUMN[c["side_rule"]]
        c["features"] = [*SMALL_F, "b_side", sig]
        c["params"] = {} if c["model"] == "rule" else dict(SMALL_PARAMS)
        c["first_refit_ms"] = FIRST_REFIT
        out.append(c)
    return out


@pytest.fixture
def cheap(monkeypatch: pytest.MonkeyPatch) -> None:
    """The registries and the frame features shrunk so a run takes seconds. The floor stays a parameter of each test."""
    monkeypatch.setattr(family_b, "frame_features", lambda interval: SMALL_F)
    monkeypatch.setattr(family_b, "family_b_noise", _cheap_noise)
    monkeypatch.setattr(family_b, "family_b", _cheap_family)


def _manifest_dir(tmp: Path, symbols: list[str], name: str = "ds", ds_hash: str = "b-synth-hash") -> Path:
    d = tmp / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "manifest.json").write_text(
        json.dumps({"version": 1, "datasetHash": ds_hash, "symbols": symbols, "files": []}), encoding="utf-8"
    )
    return d


def _dcov_file(tmp: Path) -> Path:
    base = np.full((6, 6), 0.0009)
    cov = base + np.diag(np.array([0.0007, 0.0016, 0.0020, 0.0027, 0.0011, 0.0018]))
    f = tmp / "dcov.json"
    f.write_text(json.dumps({"symbols": SYMS, "cov": cov.tolist(), "dataset_hash": "d-hash", "n_days": 100}))
    return f


# ---------------------------------------------------------------------------------------------------------------------
# The synthetic activity check (A8.6)
# ---------------------------------------------------------------------------------------------------------------------

T_START = 1_672_531_200_000  # 2023-01-01


def _scripted_runs(
    monkeypatch: pytest.MonkeyPatch, counts: dict[tuple[int, int], int], log: list[dict[str, Any]]
) -> None:
    """Replace the control run by a stub that reports the scripted walk-forward tranche count of (j, attempt)."""

    def fake(
        config: dict[str, Any], ds: Path, cfg_dir: Path, runs_dir: Path, commit: str, panel: Any
    ) -> dict[str, Any]:
        j = next(i for i, c in enumerate(REAL_NOISE()) if config["id"].startswith(c["id"]))
        attempt = int(config.get("attempt", 0))
        n = counts.get((j, attempt), 5000)
        log.append({"id": config["id"], "noise_seed": config["noise_seed"], "panel": panel, "ds": ds})
        return {
            "b": {
                "wf_tranches": n,
                "wf_primary_decisions": 4 * n,
                "wf_acted_decisions": n,
                "act_share": 0.25,
            }
        }

    monkeypatch.setattr(phase5_b, "_run_config", fake)


def test_synth_check_attempt_sequence_registers_the_final_seeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log: list[dict[str, Any]] = []
    # control 2 misses the 1,000 floor by one tranche at attempt 0, control 5 misses twice, the rest are fine
    _scripted_runs(monkeypatch, {(2, 0): 999, (2, 1): 1000, (5, 0): 10, (5, 1): 999, (5, 2): 1000}, log)
    monkeypatch.setattr(
        phase5_b.family_b, "TRADE_FLOOR_TRANCHES", 1000
    )  # the owner's floor, stated here so the boundary is explicit
    rec = phase5_b.noise_synth_check(
        tmp_path / "o", COMMIT, _dcov_file(tmp_path), start_ms=T_START, end_ms=T_START + 60 * DAY
    )
    assert rec["verdict"] == "register" and rec["final_attempts"] == [0, 0, 1, 0, 0, 2, 0, 0]
    ids = [e["id"] for e in log]
    assert ids == [
        "B_noise_sti_C1_12_s1", "B_noise_sti_C1_12_s2",
        "B_noise_sti_C1_all_s1", "B_noise_sti_C1_all_s1_alt1",
        "B_noise_sti_C1_all_s2",
        "B_noise_pos_C4_12_s1",
        "B_noise_pos_C4_12_s2", "B_noise_pos_C4_12_s2_alt1", "B_noise_pos_C4_12_s2_alt2",
        "B_noise_pos_C4_all_s1", "B_noise_pos_C4_all_s2",
    ]  # fmt: skip
    seeds = {e["id"]: e["noise_seed"] for e in log}
    assert seeds["B_noise_sti_C1_all_s1_alt1"] == 11_500_002 + 100
    assert seeds["B_noise_pos_C4_12_s2_alt2"] == 11_500_005 + 200
    c2 = rec["controls"][2]
    assert [(a["attempt"], a["wf_tranches"], a["floor_met"]) for a in c2["attempts"]] == [
        (0, 999, False),
        (1, 1000, True),
    ]
    assert c2["final_attempt"] == 1 and c2["final_id"] == "B_noise_sti_C1_all_s1_alt1" and c2["floor_met"] is True
    assert rec["controls"][5]["final_attempt"] == 2 and len(rec["controls"][5]["attempts"]) == 3
    assert (
        rec["controls"][0]["attempts"][0]["act_share"] == 0.25
        and rec["controls"][0]["attempts"][0]["primary_decisions"] == 20000
    )
    # the registered set is the registry at the final attempts, with the unchanged joint seeds
    want = [
        {"id": c["id"], "noise_seed": c["noise_seed"], "joint_shift_seed": c["joint_shift_seed"]}
        for c in REAL_NOISE([0, 0, 1, 0, 0, 2, 0, 0])
    ]
    assert rec["registered"] == want and [r["joint_shift_seed"] for r in rec["registered"]] == [
        11_600_000 + j for j in range(8)
    ]
    assert rec["floor_tranches"] == 1000 and rec["panel_seed"] == 11_700_000 == family_b.SYNTH_SEED
    assert (
        rec["dcov_dataset_hash"] == "d-hash"
        and rec["dcov_sha256"] == hashlib.sha256((tmp_path / "dcov.json").read_bytes()).hexdigest()
    )
    saved = json.loads((tmp_path / "o" / "synth_b_noise.json").read_text(encoding="utf-8"))
    assert saved["verdict"] == "register" and saved["registered"] == want
    # the panel is the synthetic D-shaped panel with synthetic flow and metrics rows from 2023-01-01
    panel = log[0]["panel"]
    assert set(panel) == set(SYMS) and {"flow_5m", "metrics_5m"} <= set(panel["BTCUSDT"])
    assert panel["BTCUSDT"]["flow_5m"]["t"].min() >= T_START
    # the synthetic dataset is deleted afterwards and nothing but the record and the runs remain
    assert not (tmp_path / "o" / "synth_b" / "_tmp").exists()
    # it never overwrites
    with pytest.raises(ValueError, match="refusing to overwrite"):
        phase5_b.noise_synth_check(
            tmp_path / "o", COMMIT, _dcov_file(tmp_path), start_ms=T_START, end_ms=T_START + 60 * DAY
        )
    assert json.loads((tmp_path / "o" / "synth_b_noise.json").read_text(encoding="utf-8")) == saved


def test_synth_check_returns_the_design_to_the_owner_when_a_control_stays_below_the_floor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log: list[dict[str, Any]] = []
    _scripted_runs(monkeypatch, {(3, 0): 400, (3, 1): 999, (3, 2): 999}, log)
    rec = phase5_b.noise_synth_check(
        tmp_path / "o", COMMIT, _dcov_file(tmp_path), start_ms=T_START, end_ms=T_START + 60 * DAY
    )
    assert rec["verdict"] == "returned to owner" and rec["registered"] == [] and rec["final_attempts"] is None
    assert rec["controls"][3]["floor_met"] is False and len(rec["controls"][3]["attempts"]) == 3
    assert [e["id"] for e in log].count("B_noise_sti_C1_all_s2_alt2") == 1
    assert not any(e["id"].endswith("_alt3") for e in log)
    # nothing is registered: the registry's default attempts are untouched
    assert family_b.NOISE_FINAL_ATTEMPTS == (0,) * 8
    # a record that says "returned to owner" never starts the controls
    rec_file = tmp_path / "o" / "synth_b_noise.json"
    with pytest.raises(ValueError, match="not 'register'"):
        phase5_b.run_noise_b(tmp_path, tmp_path / "x", COMMIT, None, rec_file)


def test_synth_check_reads_only_the_covariance_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import r4.data as data

    def boom(*a: Any, **k: Any) -> Any:
        raise AssertionError("the synthetic activity check read a dataset file")

    monkeypatch.setattr(data, "_load_dataset_file", boom)
    log: list[dict[str, Any]] = []
    _scripted_runs(monkeypatch, {}, log)
    rec = phase5_b.noise_synth_check(
        tmp_path / "o", COMMIT, _dcov_file(tmp_path), start_ms=T_START, end_ms=T_START + 60 * DAY
    )
    assert rec["verdict"] == "register" and len(log) == 8
    import inspect

    assert list(inspect.signature(phase5_b.noise_synth_check).parameters)[:3] == ["out_dir", "commit", "dcov_path"]


def test_synth_check_real_runs_on_a_small_synthetic_panel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cheap: None
) -> None:
    monkeypatch.setattr(family_b, "TRADE_FLOOR_TRANCHES", 1)
    rec = phase5_b.noise_synth_check(
        tmp_path / "o",
        COMMIT,
        _dcov_file(tmp_path),
        start_ms=T_START,
        end_ms=T_START + 130 * DAY,
        first_refit_ms=FIRST_REFIT,
    )
    assert rec["verdict"] == "register" and len(rec["controls"]) == 8
    for c in rec["controls"]:
        a = c["attempts"][-1]
        assert a["wf_tranches"] >= 1 and a["primary_decisions"] > a["acted_decisions"] >= a["wf_tranches"] - 0
        assert a["act_share"] == a["acted_decisions"] / a["primary_decisions"]
    runs = tmp_path / "o" / "synth_b" / "runs"
    first = json.loads((runs / "B_noise_sti_C1_12_s1" / "receipt.json").read_text(encoding="utf-8"))
    assert first["kind"] == "control" and first["b"]["wf_tranches"] == rec["controls"][0]["attempts"][0]["wf_tranches"]
    assert (
        rec["registered"][0]["id"] == "B_noise_sti_C1_12_s1"
        and rec["reproduction"]["source_sha256"] == cli.source_digest()
    )


# ---------------------------------------------------------------------------------------------------------------------
# run_noise_b
# ---------------------------------------------------------------------------------------------------------------------


def _synth_record(tmp: Path, **change: Any) -> Path:
    rec: dict[str, Any] = {
        "kind": "synth_b_noise",
        "verdict": "register",
        "floor_tranches": family_b.TRADE_FLOOR_TRANCHES,
        "registered": [
            {"id": c["id"], "noise_seed": c["noise_seed"], "joint_shift_seed": c["joint_shift_seed"]}
            for c in REAL_NOISE()
        ],
    }
    rec.update(change)
    f = tmp / "record.json"
    f.write_text(json.dumps(rec), encoding="utf-8")
    return f


def test_run_noise_b_refuses_a_bad_record_and_runs_the_registered_controls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ds = _manifest_dir(tmp_path, SYMS)
    calls: list[tuple[str, Path, Path]] = []
    monkeypatch.setattr(phase5_b, "_load", lambda ds_, v8: ({"datasetHash": "h"}, {}))
    monkeypatch.setattr(
        phase5_b,
        "_run_config",
        lambda cfg, ds_, cfg_dir, runs, commit, panel: calls.append((cfg["id"], cfg_dir, runs)) or {},
    )
    out = tmp_path / "out"
    with pytest.raises(ValueError, match="needs the committed synthetic record"):
        phase5_b.run_noise_b(ds, out, COMMIT, None, None)
    with pytest.raises(ValueError, match="not 'register'"):
        phase5_b.run_noise_b(ds, out, COMMIT, None, _synth_record(tmp_path, verdict="returned to owner", registered=[]))
    seeds = _synth_record(tmp_path).read_text(encoding="utf-8")
    bad = json.loads(seeds)
    bad["registered"][4]["noise_seed"] += 1
    with pytest.raises(ValueError, match="registered seeds"):
        phase5_b.run_noise_b(ds, out, COMMIT, None, _synth_record(tmp_path, registered=bad["registered"]))
    alt = [
        {"id": c["id"], "noise_seed": c["noise_seed"], "joint_shift_seed": c["joint_shift_seed"]}
        for c in REAL_NOISE([0, 1, 0, 0, 0, 0, 0, 0])
    ]
    with pytest.raises(ValueError, match="registered seeds"):
        phase5_b.run_noise_b(ds, out, COMMIT, None, _synth_record(tmp_path, registered=alt))
    with pytest.raises(ValueError, match="not a synthetic activity record"):
        phase5_b.run_noise_b(ds, out, COMMIT, None, _synth_record(tmp_path, kind="other"))
    with pytest.raises(ValueError, match="tranche floor"):
        phase5_b.run_noise_b(ds, out, COMMIT, None, _synth_record(tmp_path, floor_tranches=500))
    assert calls == []
    phase5_b.run_noise_b(ds, out, COMMIT, None, _synth_record(tmp_path))
    assert [c[0] for c in calls] == [c["id"] for c in REAL_NOISE()]
    assert all(c[1] == out / "noise" / "cfg" and c[2] == out / "noise" / "runs" for c in calls)


def test_v8_export_dirs() -> None:
    assert phase5_b.v8_export_dirs(None) is None
    assert phase5_b.v8_export_dirs("/x/exp") == {"1h": Path("/x/exp/v8-1h"), "4h": Path("/x/exp/v8-4h")}
    assert phase5_b.v8_export_dirs({"1h": "/a", "4h": "/b"}) == {"1h": Path("/a"), "4h": Path("/b")}


# ---------------------------------------------------------------------------------------------------------------------
# The noise evaluation (A8.6)
# ---------------------------------------------------------------------------------------------------------------------


def test_noise_gates_at_the_bounds_and_one_over() -> None:
    g = phase5_b.noise_gates
    assert g({"sti": 3, "pos": 3}, 0, 2)["gates_met"] is True
    assert g({"sti": 4, "pos": 4}, 0, 2)["gates_met"] is True
    assert g({"sti": 2, "pos": 4}, 0, 0) == {
        "informative": False,
        "items_1_to_3": True,
        "joint_shift": True,
        "gates_met": False,
    }
    assert g({"sti": 4, "pos": 2}, 0, 0)["informative"] is False  # 2 of 4 active in one frame is not informative
    assert (
        g({"sti": 3, "pos": 3}, 1, 0)["gates_met"] is False and g({"sti": 3, "pos": 3}, 1, 0)["items_1_to_3"] is False
    )
    assert g({"sti": 3, "pos": 3}, 0, 3)["gates_met"] is False and g({"sti": 3, "pos": 3}, 0, 3)["joint_shift"] is False
    assert g({"sti": 3}, 0, 0)["informative"] is False  # a frame with no control entry
    assert g({}, 0, 0)["gates_met"] is False
    assert family_b.NOISE_BOUNDS == {"pass_items_1_to_3_max": 0, "joint_shift_reject_max": 2}
    assert family_b.INFORMATIVE_MIN_PER_FRAME == 3 and family_b.TRADE_FLOOR_TRANCHES == 1000


def _fake_noise_runs(
    tmp: Path, ds_hash: str, tranches: list[int], *, commit: str = COMMIT, source: str | None = None
) -> Path:
    runs = tmp / "noise" / "runs"
    idx = pd.Index(np.arange(FIRST_REFIT, FIRST_REFIT + 40 * DAY, DAY), name="day_start")
    rng = np.random.default_rng(1)
    for j, cfg in enumerate(REAL_NOISE()):
        d = runs / cfg["id"]
        d.mkdir(parents=True)
        daily = pd.DataFrame(
            {
                "drift_free": rng.normal(0, 0.001, len(idx)),
                "costs": np.full(len(idx), 0.0001 * (1 + j)),
                "gross_hedged": rng.normal(0, 0.001, len(idx)),
                "funding": np.zeros(len(idx)),
            },
            index=idx,
        )
        daily.to_parquet(d / "daily.parquet")
        (d / "folds.json").write_text("[]", encoding="utf-8")
        receipt = {
            "kind": "control",
            "commit": commit,
            "source_sha256": source or cli.source_digest(),
            "dataset_hash": ds_hash,
            "config": cfg,
            "config_hash": cli.config_hash_of(cfg),
            "b": {"wf_tranches": tranches[j], "wf_primary_decisions": 4 * tranches[j], "act_share": 0.25},
        }
        (d / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    return runs


def _stub_bar(monkeypatch: pytest.MonkeyPatch, *, passes: set[str], pvals: dict[int, float]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(bar, "item1", lambda r: {"pass": r["config"]["id"] in passes})
    monkeypatch.setattr(bar, "item2", lambda d: {"pbo": 0.1, "pass": True})
    monkeypatch.setattr(bar, "item3", lambda r, v, n, candidate_daily=None: {"pass": True, "n": n, "v": v})
    monkeypatch.setattr(bar, "trial_sharpe_variance", lambda d, c, mode="within_cell": {"V": 1e-6, "df": 6})

    def stats_stub(tranches: Any, panel: Any, folds: Any, **kw: Any) -> SimpleNamespace:
        calls.append(kw)
        return SimpleNamespace(n_tranches=3, shifts=[1], obs_stat=0.01, seed=kw["seed"])

    monkeypatch.setattr(bar, "joint_shift_stats", stats_stub)
    monkeypatch.setattr(bar, "joint_shift_p", lambda st, n: (pvals.get(st.seed - 11_600_000, 0.5), 0.0))
    monkeypatch.setattr(calibration, "_book_anchor", lambda *a, **k: {"checked": False})

    def never(*a: Any, **k: Any) -> Any:
        raise AssertionError("calibration's noise verdicts or trade floor were called on family B")

    for name in ("evaluate_noise", "trade_floor_ok", "_noise_verdicts"):
        monkeypatch.setattr(calibration, name, never)
    return calls


def test_evaluate_noise_b_activity_rule_at_999_and_1000_tranches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ds = _manifest_dir(tmp_path, SYMS)
    # sti: 3 of 4 active (one at 999), pos: 4 of 4 active (one at exactly 1,000)
    runs = _fake_noise_runs(tmp_path, "b-synth-hash", [1000, 999, 5000, 1001, 1000, 2000, 3000, 4000])
    calls = _stub_bar(monkeypatch, passes=set(), pvals={})
    res = phase5_b.evaluate_noise_b(ds, runs, tmp_path / "out", COMMIT, panel={})
    act = {i: c["active"] for i, c in res["controls"].items()}
    assert act["B_noise_sti_C1_12_s2"] is False and act["B_noise_sti_C1_12_s1"] is True
    assert act["B_noise_pos_C4_12_s1"] is True
    assert res["activity"]["active_by_frame"] == {"sti": 3, "pos": 4} and res["activity"]["informative"] is True
    assert res["gates_met"] is True and res["gates"] == {
        "informative": True, "items_1_to_3": True, "joint_shift": True, "gates_met": True
    }  # fmt: skip
    # the default draws are M's 1,000, each control uses its own seed over [first refit, DEV_END)
    assert len(calls) == 8 and all(c["n_draws"] == 1000 for c in calls)
    assert sorted(c["seed"] for c in calls) == [11_600_000 + j for j in range(8)]  # one per control, in sorted id order
    assert all(c["span_start_ms"] == family_b.FIRST_REFIT_MS and c["span_end_ms"] == DEV_END for c in calls)
    assert res["controls"]["B_noise_sti_C1_12_s1"]["joint_shift"]["draws"] == 1000
    # item 3 at N = 120 and the within-cell V as the diagnostic
    assert res["controls"]["B_noise_sti_C1_12_s1"]["item3"]["n"] == 120 == phase5_b.N_TRIALS
    saved = json.loads((tmp_path / "out" / "noise_eval_b.json").read_text(encoding="utf-8"))
    assert saved["receipts_sha256"] == {
        i: hashlib.sha256((runs / i / "receipt.json").read_bytes()).hexdigest() for i in sorted(act)
    }
    assert (
        saved["commit"] == COMMIT
        and saved["source_sha256"] == cli.source_digest()
        and saved["dataset_hash"] == "b-synth-hash"
    )
    assert saved["kind"] == "noise_eval_b" and saved["gates_met"] is True
    d = saved["diagnostics"]
    assert d["binomial_independence_benchmark"]["n"] == 8 and set(d["mean_daily_costs_by_frame"]) == {"sti", "pos"}
    assert d["act_share"]["B_noise_pos_C4_all_s2"] == 0.25 and d["wf_tranches"]["B_noise_pos_C4_all_s2"] == 4000


def test_evaluate_noise_b_two_of_four_active_in_a_frame_is_not_informative(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ds = _manifest_dir(tmp_path, SYMS)
    runs = _fake_noise_runs(tmp_path, "b-synth-hash", [5000, 5000, 10, 10, 5000, 5000, 5000, 5000])
    _stub_bar(monkeypatch, passes=set(), pvals={})
    res = phase5_b.evaluate_noise_b(ds, runs, tmp_path / "out", COMMIT, panel={}, joint_draws=7)
    assert res["activity"]["active_by_frame"] == {"sti": 2, "pos": 4}
    assert res["activity"]["informative"] is False and res["gates_met"] is False
    assert res["gates"]["items_1_to_3"] is True and res["gates"]["joint_shift"] is True
    assert res["controls"]["B_noise_sti_C1_12_s1"]["joint_shift"]["draws"] == 7


@pytest.mark.parametrize(
    ("n_pass", "n_rej", "met"), [(0, 0, True), (0, 2, True), (0, 3, False), (1, 0, False), (1, 3, False)]
)
def test_evaluate_noise_b_gate_counts_at_the_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, n_pass: int, n_rej: int, met: bool
) -> None:
    ds = _manifest_dir(tmp_path, SYMS)
    runs = _fake_noise_runs(tmp_path, "b-synth-hash", [5000] * 8)
    ids = [c["id"] for c in REAL_NOISE()]
    _stub_bar(monkeypatch, passes=set(ids[:n_pass]), pvals={j: 0.01 for j in range(n_rej)} | {7: 0.05})
    res = phase5_b.evaluate_noise_b(ds, runs, tmp_path / "out", COMMIT, panel={}, joint_draws=5)
    assert (
        res["gated"]["n_pass_items_1_to_3"] == n_pass and res["gated"]["n_reject_joint_shift_05"] == n_rej
    )  # p = 0.05 is no rejection
    assert res["gated"]["bounds"] == {"pass_items_1_to_3_max": 0, "joint_shift_reject_max": 2}
    assert res["gates_met"] is met


def test_evaluate_noise_b_refuses_other_runs_commits_sources_and_datasets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ds = _manifest_dir(tmp_path, SYMS)
    _stub_bar(monkeypatch, passes=set(), pvals={})
    runs = _fake_noise_runs(tmp_path, "b-synth-hash", [5000] * 8)
    with pytest.raises(ValueError, match="commit"):
        phase5_b.evaluate_noise_b(ds, runs, tmp_path / "o1", "c" * 40, panel={})
    with pytest.raises(ValueError, match="dataset_hash"):
        phase5_b.evaluate_noise_b(
            _manifest_dir(tmp_path, SYMS, "ds2", "other"), runs, tmp_path / "o2", COMMIT, panel={}
        )
    import shutil

    shutil.rmtree(runs / "B_noise_pos_C4_all_s2")
    with pytest.raises(ValueError, match="registered controls"):
        phase5_b.evaluate_noise_b(ds, runs, tmp_path / "o3", COMMIT, panel={})
    other = _fake_noise_runs(tmp_path / "other", "b-synth-hash", [5000] * 8, source="0" * 64)
    with pytest.raises(ValueError, match="source_sha256"):
        phase5_b.evaluate_noise_b(ds, other, tmp_path / "o4", COMMIT, panel={})


# ---------------------------------------------------------------------------------------------------------------------
# The real chain: dataset directory, controls, evaluation, the declared runs
# ---------------------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def chain_dataset(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("fb36b")
    panel = family_b.synthetic_tier_b(
        _make_fast_synthetic_panel(symbols=tuple(SYMS), n_days=130, seed=3, inject_signal=True), 11
    )
    ds = write_synthetic_dataset(panel, root / "ds")
    for sym, d in panel.items():
        (ds / "flow" / sym).mkdir(parents=True, exist_ok=True)
        (ds / "flow" / sym / "5m.jsonl.gz").write_bytes(_jsonl_gz_bytes(d["flow_5m"]))
        (ds / "metrics" / sym).mkdir(parents=True, exist_ok=True)
        (ds / "metrics" / sym / "5m.jsonl.gz").write_bytes(_jsonl_gz_bytes(d["metrics_5m"]))
    manifest = json.loads((ds / "manifest.json").read_text(encoding="utf-8"))
    return {"root": root, "ds": ds, "hash": manifest["datasetHash"], "panel": panel}


@pytest.fixture(scope="module")
def chain(chain_dataset: dict[str, Any]) -> dict[str, Any]:
    mp = pytest.MonkeyPatch()
    mp.setattr(family_b, "frame_features", lambda interval: SMALL_F)
    mp.setattr(family_b, "family_b_noise", _cheap_noise)
    mp.setattr(family_b, "family_b", _cheap_family)
    mp.setattr(family_b, "TRADE_FLOOR_TRANCHES", 1)
    root = chain_dataset["root"]
    out = root / "out"
    try:
        record_file = root / "synth_record.json"
        record_file.write_text(
            json.dumps(
                {
                    "kind": "synth_b_noise",
                    "verdict": "register",
                    "floor_tranches": 1,
                    "registered": [
                        {"id": c["id"], "noise_seed": c["noise_seed"], "joint_shift_seed": c["joint_shift_seed"]}
                        for c in _cheap_noise()
                    ],
                }
            ),
            encoding="utf-8",
        )
        noise_receipts = phase5_b.run_noise_b(chain_dataset["ds"], out, COMMIT, None, record_file)
        noise_eval = phase5_b.evaluate_noise_b(
            chain_dataset["ds"], out / "noise" / "runs", out, COMMIT, joint_draws=3, panel=chain_dataset["panel"]
        )
        # the declared runs need a passing evaluation: take the real file and set only its verdict
        passing = {**noise_eval, "gates_met": True}
        (out / "noise_eval_b.json").write_text(json.dumps(passing), encoding="utf-8")
        run_receipts = phase5_b.run_family_b(chain_dataset["ds"], out, COMMIT)
    finally:
        mp.undo()
    return {
        **chain_dataset,
        "out": out,
        "noise_receipts": noise_receipts,
        "noise_eval": noise_eval,
        "runs": run_receipts,
    }


def test_the_real_chain_runs_the_controls_and_judges_them(chain: dict[str, Any]) -> None:
    out = chain["out"]
    ids = [c["id"] for c in REAL_NOISE()]
    assert sorted(p.name for p in (out / "noise" / "runs").iterdir()) == sorted(ids)
    for r in chain["noise_receipts"]:
        assert r["kind"] == "control" and r["b"]["primary"].startswith("b_noise_") and "decisions_sha256" in r
    ev = chain["noise_eval"]
    assert ev["n_controls"] == 8 and set(ev["controls"]) == set(ids)
    for cid, c in ev["controls"].items():
        assert c["joint_shift"]["draws"] == 3 and c["joint_shift"]["seed"] == 11_600_000 + ids.index(cid)
        assert c["frame"] in ("sti", "pos") and isinstance(c["pass_items_1_to_3"], bool)
        assert c["wf_tranches"] == chain["noise_receipts"][ids.index(cid)]["metrics"]["n_tranches"]
        assert c["book_anchor"]["ok"] is True
    assert ev["gates_met"] == (
        ev["gates"]["informative"] and ev["gates"]["items_1_to_3"] and ev["gates"]["joint_shift"]
    )
    assert ev["commit"] == COMMIT and ev["dataset_hash"] == chain["hash"] and ev["variance"]["mode"] == "within_cell"
    assert set(ev["receipts_sha256"]) == set(ids)


def _eval_file(tmp: Path, ds_hash: str, **change: Any) -> Path:
    data = {
        "kind": "noise_eval_b",
        "commit": COMMIT,
        "source_sha256": cli.source_digest(),
        "dataset_hash": ds_hash,
        "gates_met": True,
    }
    data.update(change)
    f = tmp / "noise_eval_b.json"
    f.write_text(json.dumps(data), encoding="utf-8")
    return f


def test_run_family_b_refuses_a_missing_failed_or_mismatched_noise_evaluation(
    chain: dict[str, Any], tmp_path: Path, cheap: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran: list[str] = []
    monkeypatch.setattr(phase5_b, "_load", lambda ds, v8: ({"datasetHash": chain["hash"]}, {}))
    monkeypatch.setattr(phase5_b, "_run_config", lambda cfg, *a, **k: ran.append(cfg["id"]) or {})
    ds = chain["ds"]
    out = tmp_path / "o"
    with pytest.raises(ValueError, match="no noise evaluation"):
        phase5_b.run_family_b(ds, out, COMMIT)
    for change, match in (
        ({"gates_met": False}, "did not meet"),
        ({"gates_met": None}, "did not meet"),
        ({"commit": "c" * 40}, "commit"),
        ({"source_sha256": "0" * 64}, "source_sha256"),
        ({"dataset_hash": "other"}, "dataset_hash"),
        ({"kind": "noise_eval"}, "not a family B noise evaluation"),
    ):
        f = _eval_file(tmp_path, chain["hash"], **change)
        with pytest.raises(ValueError, match=match):
            phase5_b.run_family_b(ds, out, COMMIT, None, f)
    assert ran == []
    phase5_b.run_family_b(ds, out, COMMIT, None, _eval_file(tmp_path, chain["hash"]))
    assert ran == CHEAP_IDS


def test_the_real_declared_runs_and_check_complete(chain: dict[str, Any], cheap: None) -> None:
    runs = chain["out"] / "runs"
    assert [r["config"]["id"] for r in chain["runs"]] == CHEAP_IDS
    for r in chain["runs"]:
        assert r["kind"] == "trial" and r["b"]["primary"] in ("b_sti", "b_ll")
    kw = {"commit": COMMIT, "source_sha256": cli.source_digest(), "dataset_hash": chain["hash"]}
    phase5_b.check_complete(runs, **kw)
    for key, want in (("commit", "c" * 40), ("source_sha256", "0" * 64), ("dataset_hash", "x")):
        with pytest.raises(ValueError, match=key):
            phase5_b.check_complete(runs, **{**kw, key: want})
    import shutil

    work = chain["root"] / "check_copy"
    shutil.copytree(runs, work, dirs_exist_ok=True)
    (work / "extra").mkdir()
    with pytest.raises(ValueError, match="extra"):
        phase5_b.check_complete(work, **kw)
    shutil.rmtree(work / "extra")
    with open(work / "B_meta12_sti_C1" / "decisions.parquet", "ab") as f:
        f.write(b"x")
    with pytest.raises(ValueError, match="decisions_sha256"):
        phase5_b.check_complete(work, **kw)
    shutil.copy(runs / "B_meta12_sti_C1" / "decisions.parquet", work / "B_meta12_sti_C1" / "decisions.parquet")
    rc = json.loads((work / "B_rule_sti_C1" / "receipt.json").read_text(encoding="utf-8"))
    rc.pop("b")
    (work / "B_rule_sti_C1" / "receipt.json").write_text(json.dumps(rc), encoding="utf-8")
    with pytest.raises(ValueError, match="no b block"):
        phase5_b.check_complete(work, **kw)
    shutil.rmtree(work / "B_meta24_ll_C1")
    with pytest.raises(ValueError, match="missing"):
        phase5_b.check_complete(work, **kw)


# ---------------------------------------------------------------------------------------------------------------------
# The report
# ---------------------------------------------------------------------------------------------------------------------


def _ev(passing: bool, sharpe: float = 0.1, model: str = "lightgbm", cid: str = "x") -> dict[str, Any]:
    return {
        "id": cid,
        "item1": {"pass": passing, "wf_mean": 0.0},
        "item2": {"pass": passing},
        "item3": {"pass": passing},
        "item4": {"pass": passing},
        "item5": {"pass": passing},
        "item6": {"pass": passing},
        "joint_shift_seed": None,
        "all_pass": passing,
        "receipt": {
            "config": {"family": "B", "model": model},
            "metrics": {"wf_sharpe": sharpe, "wf_mean": sharpe / 10},
        },
    }


def _fake_bar(
    monkeypatch: pytest.MonkeyPatch,
    configs: list[dict[str, Any]],
    reached: list[str],
    sharpe: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    sharpe = sharpe or {}

    def fake_family_report(family: str, runs_dir: Any, round_dir: Any, count: int, ds: Any, **kw: Any) -> dict:
        calls.append({"family": family, "count": count, **kw})
        two = kw["tripwire"] is not None
        evs = {c["id"]: _ev(c["id"] in reached, sharpe.get(c["id"], 0.1), c["model"], c["id"]) for c in configs}
        passing = [e for e in evs.values() if e["all_pass"]]
        return {
            "configurations": evs,
            "candidates": bar._rank_candidates(passing) if two else [],
            "finalists": [],
            "variance": {},
            "tripwire": "passed" if two else "pending",
            "tripwire_input": kw["tripwire"],
        }

    monkeypatch.setattr(bar, "family_report", fake_family_report)
    monkeypatch.setattr(bar, "item2", lambda d: {"pbo": 0.1, "pass": True})
    monkeypatch.setattr(phase5_b.hedge_cost, "run_hedge_cost", lambda *a, **k: {"profile": k.get("profile")})
    monkeypatch.setattr(phase5_b.account, "account_report", lambda *a, **k: {"ok": True})
    return calls


def _tripwire_result(positive: int, shifts: int = 3) -> dict[str, Any]:
    return {
        "positive": positive,
        "n": 100,
        "shifts": [
            {
                "shift_days": 30 + 7 * k,
                "wf_mean": 0.001,
                "tranche_count": 100 + k,
                "per_unit_weight_mean": 0.0001 * (k + 1),
            }
            for k in range(shifts)
        ],
    }


def _reserve_log(tmp: Path, entries: list[dict[str, Any]]) -> Path:
    tmp.mkdir(parents=True, exist_ok=True)
    f = tmp / "reserve.json"
    f.write_text(json.dumps(entries), encoding="utf-8")
    return f


def _report(chain: dict[str, Any], tmp: Path, **kw: Any) -> dict[str, Any]:
    log = kw.pop("reserve_log", None)
    if log is None:
        log = _reserve_log(tmp, [])
    return phase5_b.report_family_b(chain["ds"], chain["out"] / "runs", tmp / "rep", COMMIT, None, reserve_log=log)


def test_report_bindings_round_count_and_reports_from_the_runs(
    chain: dict[str, Any], tmp_path: Path, cheap: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    configs = _cheap_family()
    calls = _fake_bar(monkeypatch, configs, [])
    runs = chain["out"] / "runs"
    report = _report(chain, tmp_path)
    assert json.loads((tmp_path / "rep" / "family_b_report.json").read_text(encoding="utf-8"))["commit"] == COMMIT
    assert report["family"] == "B" and report["commit"] == COMMIT and report["dataset_hash"] == chain["hash"]
    assert report["source_sha256"] == cli.source_digest() and report["receipts_sha256"] == phase5_b._receipt_hashes(
        runs
    )
    assert (
        report["round_alpha_count"] == 84 == family_b.ALPHA_BEFORE_B + family_b.N_DECLARED and report["n_item_3"] == 120
    )
    assert [c["family"] for c in calls] == ["B"] and calls[0]["count"] == 84 and calls[0]["family_index"] == 1
    assert calls[0]["tripwire"] is None and report["result_pass"] == 1 and report["pass2"] is None
    assert report["n_reached_items_1_to_3"] == 0 and report["tripwires"] == {} and report["twin_plan"] == []
    assert report["account"].keys() == {c["id"] for c in configs}
    assert report["hedge_cost"] == {}
    assert report["predictions"] == family_b.PREDICTIONS and report["reserve_log"] == []
    # cost drag by cell and by block
    mean_costs = {c["id"]: float(pd.read_parquet(runs / c["id"] / "daily.parquet")["costs"].mean()) for c in configs}
    assert report["cost_drag"]["mean_daily_costs_by_config"] == pytest.approx(mean_costs, abs=0.0)
    assert set(report["cost_drag"]["mean_daily_costs_by_cell"]) == {"C1"}
    assert report["cost_drag"]["mean_daily_costs_by_cell"]["C1"] == pytest.approx(
        np.mean(list(mean_costs.values())), abs=1e-15
    )
    assert set(report["cost_drag"]["mean_daily_costs_by_block"]) == {"rule", "meta12", "meta24"}
    assert report["within_cell_pbo"] == {"C1": {"pbo": 0.1, "pass": True, "n_configs": 4}}
    # the paired comparison of each meta configuration with its own rule configuration, against hand values
    assert set(report["paired_comparisons"]) == {"B_meta12_sti_C1", "B_meta24_ll_C1"}
    for k, (meta, rule) in enumerate((("B_meta12_sti_C1", "B_rule_sti_C1"), ("B_meta24_ll_C1", "B_rule_ll_C1"))):
        idx = 1 + 2 * k  # the meta configurations are registry indices 1 and 3 of the shrunk registry
        dm = pd.read_parquet(runs / meta / "daily.parquet")
        dr = pd.read_parquet(runs / rule / "daily.parquet")
        pc = report["paired_comparisons"][meta]
        assert pc["rule_id"] == rule and pc["n"] == len(dm)
        net = (dm["drift_free"] - dr["drift_free"]).to_numpy()
        assert abs(pc["net"]["mean"] - net.mean()) < 1e-15 and pc["net"]["seed"] == 11_800_000 + idx
        cf = ((dm["gross_hedged"] + dm["funding"]) - (dr["gross_hedged"] + dr["funding"])).to_numpy()
        assert abs(pc["cost_free"]["mean"] - cf.mean()) < 1e-15 and pc["cost_free"]["seed"] == 11_900_000 + idx
        _, low, high = stats.bootstrap_ci(net, np.mean, 1000, 10, 11_800_000 + idx, alpha=0.10)
        assert (pc["net"]["low"], pc["net"]["high"]) == (low, high)
        assert report["meta_cost_below_rule"][meta] is bool(mean_costs[meta] < mean_costs[rule])
    # act shares, sizes and precision from decisions.parquet, fit counts from meta_fits.parquet
    for meta in ("B_meta12_sti_C1", "B_meta24_ll_C1"):
        dec = pd.read_parquet(runs / meta / "decisions.parquet")
        wf = dec[dec["phase"] == "wf"]
        dr = report["decision_reports"][meta]
        assert dr["wf_primary_decisions"] == len(wf) and dr["wf_acted"] == int(wf["acted"].sum())
        assert dr["wf_act_share"] == wf["acted"].mean()
        assert dr["wf_precision_all_primary"] == (wf["net"] > 0).mean()
        acted = wf.loc[wf["acted"]]
        assert dr["wf_precision_acted"] == ((acted["net"] > 0).mean() if len(acted) else None)
        assert dr["wf_mean_size"] == (acted["size"].mean() if len(acted) else None)
        fits = pd.read_parquet(runs / meta / "meta_fits.parquet")
        assert dr["fits"]["total"] == len(fits) and dr["fits"]["by_phase"]["cpcv_fit"] == 15
    assert report["decision_reports"]["B_rule_sti_C1"]["fits"]["total"] == 0
    assert report["native_results"]["sti"]["source"].startswith("forward-test") and "ll" in report["native_results"]
    # the b blocks are carried and the arms divergence lists the lookback arms against the all-history arm
    assert report["b_blocks"]["B_rule_sti_C1"]["primary"] == "b_sti" and report["lookback_arm_divergence"] == {}


def test_tripwires_run_for_lightgbm_configurations_only_and_record_each_shift_beside_the_rule(
    chain: dict[str, Any], tmp_path: Path, cheap: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    configs = _cheap_family()
    meta, rule = "B_meta12_sti_C1", "B_rule_sti_C1"
    calls = _fake_bar(
        monkeypatch, configs, [meta, rule, "B_meta24_ll_C1"], {meta: 0.3, rule: 0.9, "B_meta24_ll_C1": 0.2}
    )
    ran: list[str] = []

    def tw(config_file: Any, ds: Any, out: Any, **k: Any) -> dict[str, Any]:
        cid = json.loads(Path(config_file).read_text(encoding="utf-8"))["id"]
        ran.append(cid)
        return _tripwire_result(12 if cid == meta else 20)

    monkeypatch.setattr(cli, "run_tripwire", tw)
    report = _report(chain, tmp_path)
    assert ran == ["B_meta12_sti_C1", "B_meta24_ll_C1"]  # never the rule configuration
    assert report["n_reached_items_1_to_3"] == 3 and report["tripwire_set"] == ran
    assert report["rule_baseline_passes"] == [rule] and "re-implementation" in report["rule_baseline_note"]
    # the halt input is the largest count over the lightgbm configurations: the rule's would have been larger
    assert report["largest_tripwire_positive"] == 20 and report["halted"] is False
    assert calls[1]["tripwire"] == {"positive": 20, "n": 100} and report["result_pass"] == 2
    # per shift, the shifted run's tranche count and per-unit-weight mean, beside the rule configuration's
    rec = report["tripwire_records"][meta]
    assert rec["rule_id"] == rule and [s["tranche_count"] for s in rec["shifts"]] == [100, 101, 102]
    assert [s["per_unit_weight_mean"] for s in rec["shifts"]] == pytest.approx([0.0001, 0.0002, 0.0003], abs=1e-15)
    runs = chain["out"] / "runs"
    tr = pd.read_parquet(runs / rule / "tranches.parquet")
    weights = tr["size"].to_numpy() * 1.0 / 4.0 / 10.0  # 1h interval, 4h hold
    daily = pd.read_parquet(runs / rule / "daily.parquet")
    inside = (daily.index >= FIRST_REFIT) & (daily.index < DEV_END)
    assert rec["rule"]["tranche_count"] == len(tr) and abs(rec["rule"]["abs_weight_sum"] - weights.sum()) < 1e-12
    assert (
        abs(rec["rule"]["per_unit_weight_mean"] - daily["drift_free"].to_numpy()[inside].sum() / weights.sum()) < 1e-12
    )
    assert rec["n_shifts_recorded"] == 3 and rec["median_shift_tranche_count"] == 101.0
    assert rec["n_shifts_per_unit_above_rule"] in (0, 1, 2, 3)


def test_a_rule_configuration_passing_items_1_to_3_gets_no_tripwire_and_no_second_pass(
    chain: dict[str, Any], tmp_path: Path, cheap: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    configs = _cheap_family()
    calls = _fake_bar(monkeypatch, configs, ["B_rule_sti_C1", "B_rule_ll_C1"])

    def boom(*a: Any, **k: Any) -> Any:
        raise AssertionError("a tripwire ran for a rule configuration")

    monkeypatch.setattr(cli, "run_tripwire", boom)
    report = _report(chain, tmp_path)
    assert report["tripwires"] == {} and report["largest_tripwire_positive"] is None and report["pass2"] is None
    assert len(calls) == 1 and report["halted"] is False and report["result_pass"] == 1
    assert report["rule_baseline_passes"] == ["B_rule_ll_C1", "B_rule_sti_C1"] and report["finalists"] == []
    assert report["eligible_candidates"] == [] and report["twin_plan"] == []


def test_an_ineligible_configuration_ranked_first_does_not_take_the_eligible_slot() -> None:
    real = {c["id"]: c for c in REAL_FAMILY()}
    evs = {
        "B_meta24_v8_C2": _ev(True, 0.5, "lightgbm", "B_meta24_v8_C2"),
        "B_meta24_ll_C1": _ev(True, 0.2, "lightgbm", "B_meta24_ll_C1"),
        "B_rule_sti_C1": _ev(True, 0.9, "rule", "B_rule_sti_C1"),
        "B_meta12_pos_C4": _ev(False, 0.8, "lightgbm", "B_meta12_pos_C4"),
    }
    everything = bar._rank_candidates([{**e, "id": k} for k, e in evs.items() if e["all_pass"]])
    # the bar's own list: the rule configuration takes (B, rule) and the v8 secondary takes the single (B, lightgbm)
    # slot, so the eligible ll secondary is displaced
    assert [c["id"] for c in everything] == ["B_rule_sti_C1", "B_meta24_v8_C2"]
    cands = phase5_b._eligible_candidates(evs, real)
    assert [c["id"] for c in cands] == ["B_meta24_ll_C1"]


def test_report_ranks_the_eligible_candidate_and_plans_one_twin(
    chain: dict[str, Any], tmp_path: Path, cheap: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    configs = _cheap_family()
    meta_sti, meta_ll = "B_meta12_sti_C1", "B_meta24_ll_C1"
    _fake_bar(monkeypatch, configs, [meta_sti, meta_ll], {meta_sti: 0.5, meta_ll: 0.2})
    monkeypatch.setattr(cli, "run_tripwire", lambda f, *a, **k: _tripwire_result(10))
    # treat the sti secondary as ineligible: it is ranked first by the bar and must not take the eligible slot
    monkeypatch.setattr(family_b, "eligible", lambda c: c["primary"] != "sti" and REAL_ELIGIBLE(c))
    log = _reserve_log(
        tmp_path,
        [{"slot": 0, "id": "B_twin0_x", "purpose": "re-run after a fix", "ledger_entry": "round4-family-b-reserve-0"}],
    )
    report = _report(chain, tmp_path, reserve_log=log)
    assert [c["id"] for c in report["bar_candidates"]] == [meta_sti]  # one per (family, model): sti took the slot
    assert [c["id"] for c in report["eligible_candidates"]] == [meta_ll]
    assert report["ineligible_all_pass"] == [meta_sti]
    assert report["finalists"] == report["eligible_candidates"]
    # a consumed slot raises the round count, and the twin takes the first free slot
    assert report["round_alpha_count"] == 85 and report["n_item_3"] == 120
    assert report["twin_plan"] == [{"id": meta_ll, "registry_index": 3, "slot": 1, "twin_id": f"B_twin1_{meta_ll}"}]
    assert report["twin_shortfall"] == []
    # no free slot: a shortfall, no plan
    full = _reserve_log(
        tmp_path,
        [{"slot": s, "id": f"x{s}", "purpose": "p", "ledger_entry": "e"} for s in range(family_b.N_RESERVE)],
    )
    report2 = _report(chain, tmp_path / "again", reserve_log=full)
    assert report2["twin_plan"] == [] and report2["twin_shortfall"] == [meta_ll] and report2["round_alpha_count"] == 90


def test_a_halting_tripwire_leaves_no_finalist_candidate_or_twin(
    chain: dict[str, Any], tmp_path: Path, cheap: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    configs = _cheap_family()
    _fake_bar(monkeypatch, configs, ["B_meta24_ll_C1"])
    monkeypatch.setattr(cli, "run_tripwire", lambda f, *a, **k: _tripwire_result(61))
    report = _report(chain, tmp_path)
    assert report["largest_tripwire_positive"] == 61 and report["halted"] is True
    assert report["eligible_candidates"] == [] and report["finalists"] == [] and report["twin_plan"] == []


def test_the_reserve_log_is_required_and_validated(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="missing"):
        phase5_b.read_reserve_log(tmp_path / "nope.json")
    for bad, match in (
        ({"slot": 0}, "list"),
        ([{"slot": 0, "id": "a"}], "needs slot"),
        ([{"slot": 6, "id": "a", "purpose": "p", "ledger_entry": "e"}], "outside"),
        ([{"slot": True, "id": "a", "purpose": "p", "ledger_entry": "e"}], "outside"),
        ([{"slot": 1, "id": "a", "purpose": "p", "ledger_entry": "e"}] * 2, "twice"),
    ):
        with pytest.raises(ValueError, match=match):
            phase5_b.read_reserve_log(_reserve_log(tmp_path, bad))  # type: ignore[arg-type]
    ok = [{"slot": 2, "id": "a", "purpose": "p", "ledger_entry": "e"}]
    assert phase5_b.read_reserve_log(_reserve_log(tmp_path, ok)) == ok
    assert phase5_b.round_alpha_count([]) == 84 and phase5_b.round_alpha_count(ok) == 85
    assert (
        phase5_b.RESERVE_LOG_FILE.name == "family_b_reserve.json" and phase5_b.RESERVE_LOG_FILE.parent.name == "records"
    )


def test_report_refuses_incomplete_runs_and_a_missing_reserve_log(
    chain: dict[str, Any], tmp_path: Path, cheap: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_bar(monkeypatch, _cheap_family(), [])
    with pytest.raises(ValueError, match="reserve log"):
        phase5_b.report_family_b(
            chain["ds"], chain["out"] / "runs", tmp_path / "r1", COMMIT, None, reserve_log=tmp_path / "x.json"
        )
    with pytest.raises(ValueError, match="commit"):
        phase5_b.report_family_b(
            chain["ds"], chain["out"] / "runs", tmp_path / "r2", "c" * 40, None, reserve_log=_reserve_log(tmp_path, [])
        )
    assert not (tmp_path / "r1" / "family_b_report.json").exists()


# ---------------------------------------------------------------------------------------------------------------------
# The twins
# ---------------------------------------------------------------------------------------------------------------------


def _twin_report(
    chain: dict[str, Any], tmp: Path, monkeypatch: pytest.MonkeyPatch, **plan_change: Any
) -> tuple[Path, Path]:
    configs = _cheap_family()
    _fake_bar(monkeypatch, configs, ["B_meta24_ll_C1"])
    monkeypatch.setattr(cli, "run_tripwire", lambda f, *a, **k: _tripwire_result(10))
    report = _report(chain, tmp)
    plan = report["twin_plan"]
    assert len(plan) == 1
    plan[0].update(plan_change)
    f = tmp / "report.json"
    f.write_text(json.dumps(report), encoding="utf-8")
    return f, _reserve_log(
        tmp,
        [{"slot": 0, "id": "B_twin0_B_meta24_ll_C1", "purpose": "twin", "ledger_entry": "round4-family-b-reserve-0"}],
    )


def test_run_twins_b_runs_the_logged_slot_and_answers_the_refit_question(
    chain: dict[str, Any], tmp_path: Path, cheap: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    report_file, log = _twin_report(chain, tmp_path, monkeypatch)
    out = tmp_path / "tw"
    res = phase5_b.run_twins_b(chain["ds"], chain["out"] / "runs", report_file, out, COMMIT, None, log)
    twin = json.loads((out / "twins" / "runs" / "B_twin0_B_meta24_ll_C1" / "receipt.json").read_text(encoding="utf-8"))
    assert twin["config"]["joint_shift_seed"] == 11_000_018 and twin["config"]["refit"] == "none"
    assert twin["config"]["lookback_months"] is None and twin["kind"] == "trial"
    q = res["refit_questions"]["B_meta24_ll_C1"]
    assert q["seed"] == 7_200_003 and q["twin_id"] == "B_twin0_B_meta24_ll_C1" and q["slot"] == 0
    cfg_daily = pd.read_parquet(chain["out"] / "runs" / "B_meta24_ll_C1" / "daily.parquet")
    twin_daily = pd.read_parquet(out / "twins" / "runs" / "B_twin0_B_meta24_ll_C1" / "daily.parquet")
    want = family_b.refit_question(cfg_daily, twin_daily, 3)
    assert {k: q[k] for k in want} == want
    assert res["report_sha256"] == hashlib.sha256(report_file.read_bytes()).hexdigest()
    assert json.loads((out / "refit_questions.json").read_text(encoding="utf-8"))["family"] == "B"


def test_run_twins_b_refuses_an_unlogged_slot_and_a_bad_plan(
    chain: dict[str, Any], tmp_path: Path, cheap: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    report_file, log = _twin_report(chain, tmp_path, monkeypatch)
    runs = chain["out"] / "runs"
    out = tmp_path / "tw"
    empty = _reserve_log(tmp_path / "e", [])
    with pytest.raises(ValueError, match="not in the reserve log"):
        phase5_b.run_twins_b(chain["ds"], runs, report_file, out, COMMIT, None, empty)
    other = _reserve_log(
        tmp_path / "o", [{"slot": 0, "id": "B_twin0_B_rule_ll_C1", "purpose": "twin", "ledger_entry": "e"}]
    )
    with pytest.raises(ValueError, match="not in the reserve log"):
        phase5_b.run_twins_b(chain["ds"], runs, report_file, out, COMMIT, None, other)
    with pytest.raises(ValueError, match="commit"):
        phase5_b.run_twins_b(chain["ds"], runs, report_file, out, "c" * 40, None, log)
    base = json.loads(report_file.read_text(encoding="utf-8"))
    for field, value, match in (
        ("commit", "c" * 40, "report is at commit"),
        ("dataset_hash", "other", "report is on dataset"),
        ("source_sha256", "0" * 64, "source digest"),
        ("receipts_sha256", {}, "receipts_sha256"),
    ):
        f = tmp_path / f"r_{field}.json"
        f.write_text(json.dumps({**base, field: value}), encoding="utf-8")
        with pytest.raises(ValueError, match=match):
            phase5_b.run_twins_b(chain["ds"], runs, f, out, COMMIT, None, log)
    for change in (
        {"id": "B_rule_ll_C1"},
        {"id": "B_nope_C9"},
        {"slot": 6},
        {"slot": True},
        {"twin_id": "B_twin0_wrong"},
    ):
        f = tmp_path / "plan.json"
        plan_base = json.loads(report_file.read_text(encoding="utf-8"))
        plan_base["twin_plan"][0].update(change)
        f.write_text(json.dumps(plan_base), encoding="utf-8")
        with pytest.raises(ValueError):
            phase5_b.run_twins_b(chain["ds"], runs, f, out, COMMIT, None, log)
    tampered = json.loads(report_file.read_text(encoding="utf-8"))
    tampered["twin_plan"] = tampered["twin_plan"] * 2
    f = tmp_path / "two.json"
    f.write_text(json.dumps(tampered), encoding="utf-8")
    with pytest.raises(ValueError, match="twin plan"):
        phase5_b.run_twins_b(chain["ds"], runs, f, out, COMMIT, None, log)
    assert not (out / "twins").exists()


# ---------------------------------------------------------------------------------------------------------------------
# cli.main dispatch
# ---------------------------------------------------------------------------------------------------------------------


def _run_main(monkeypatch: pytest.MonkeyPatch, argv: list[str]) -> None:
    monkeypatch.setattr(sys, "argv", ["r4.cli", *argv])
    cli.main()


def test_cli_dispatches_the_six_family_b_subcommands(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
    ok_eval = {"gates_met": True}
    monkeypatch.setattr(
        phase5_b, "noise_synth_check", lambda *a, **k: calls.append(("synth", a, k)) or {"verdict": "register"}
    )
    monkeypatch.setattr(phase5_b, "run_noise_b", lambda *a, **k: calls.append(("noise-run", a, k)))
    monkeypatch.setattr(phase5_b, "evaluate_noise_b", lambda *a, **k: calls.append(("noise-eval", a, k)) or ok_eval)
    monkeypatch.setattr(phase5_b, "run_family_b", lambda *a, **k: calls.append(("run", a, k)))
    monkeypatch.setattr(phase5_b, "report_family_b", lambda *a, **k: calls.append(("report", a, k)))
    monkeypatch.setattr(phase5_b, "run_twins_b", lambda *a, **k: calls.append(("twins", a, k)))
    _run_main(monkeypatch, ["family-b-noise-synth", "--dcov", "/d.json", "--out", "/o", "--commit", COMMIT])
    _run_main(
        monkeypatch,
        [
            "family-b-noise-run",
            "--dataset-dir",
            "/ds",
            "--v8-exports",
            "/v8",
            "--synth-record",
            "/rec.json",
            "--out",
            "/o",
            "--commit",
            COMMIT,
        ],
    )
    _run_main(monkeypatch, ["family-b-noise-eval", "--ds", "/ds", "--out", "/o", "--commit", COMMIT])
    _run_main(monkeypatch, ["family-b-run", "--ds", "/ds", "--v8-exports", "/v8", "--out", "/o", "--commit", COMMIT])
    _run_main(
        monkeypatch,
        [
            "family-b-report",
            "--ds",
            "/ds",
            "--v8-exports",
            "/v8",
            "--runs",
            "/o/runs",
            "--out",
            "/o/report",
            "--commit",
            COMMIT,
        ],
    )
    twins_argv = [
        "family-b-twins", "--ds", "/ds", "--v8-exports", "/v8", "--runs", "/o/runs",
        "--report", "/o/report/family_b_report.json", "--out", "/o/tw", "--commit", COMMIT,
        "--reserve-log", "/log.json",
    ]  # fmt: skip
    _run_main(monkeypatch, twins_argv)
    names = [c[0] for c in calls]
    assert names == ["synth", "noise-run", "noise-eval", "run", "report", "twins"]
    by = {c[0]: c for c in calls}
    assert by["synth"][1] == ("/o", COMMIT, "/d.json") and by["synth"][2] == {
        "start_ms": None,
        "end_ms": None,
        "first_refit_ms": None,
    }
    assert by["noise-run"][1] == ("/ds", "/o", COMMIT, "/v8", "/rec.json")
    assert by["noise-eval"][1] == ("/ds", Path("/o/noise/runs"), "/o", COMMIT) and by["noise-eval"][2] == {
        "joint_draws": None
    }
    assert by["run"][1] == ("/ds", "/o", COMMIT, "/v8", None)
    assert by["report"][1] == ("/ds", "/o/runs", "/o/report", COMMIT, "/v8", None)
    assert by["twins"][1] == ("/ds", "/o/runs", "/o/report/family_b_report.json", "/o/tw", COMMIT, "/v8", "/log.json")


def test_cli_exit_codes_for_a_failed_check_and_unmet_gates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(phase5_b, "noise_synth_check", lambda *a, **k: {"verdict": "returned to owner"})
    with pytest.raises(SystemExit) as e1:
        _run_main(monkeypatch, ["family-b-noise-synth", "--dcov", "/d", "--out", "/o", "--commit", COMMIT])
    assert e1.value.code == 2
    monkeypatch.setattr(phase5_b, "evaluate_noise_b", lambda *a, **k: {"gates_met": False})
    with pytest.raises(SystemExit) as e2:
        _run_main(
            monkeypatch, ["family-b-noise-eval", "--ds", "/ds", "--out", "/o", "--commit", COMMIT, "--draws", "5"]
        )
    assert e2.value.code == 1


def test_phase5_b_constants() -> None:
    assert (
        phase5_b.TRIPWIRE_SHIFTS == 100 and phase5_b.TRIPWIRE_HALT_ABOVE == 60 and phase5_b.HEDGE_PROFILE == "standard"
    )
    assert DAY_MS == DAY
