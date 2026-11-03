"""Brief 32b: PR #158 review fixes (zero-tranche report, twin binding, tripwire boundary). Synthetic only."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import bar, cli, family_a, phase5
from r4.method import DEV_END
from r4.synth import synth_panel, write_synthetic_dataset

DAY = 86_400_000
COMMIT = "c" * 40
DS_HASH = "e" * 64


def _ev(passing: bool) -> dict[str, Any]:
    return {
        "item1": {"pass": passing, "wf_mean": 0.0},
        "item2": {"pass": passing},
        "item3": {"pass": passing},
        "item4": {"pass": passing},
        "item5": {"pass": passing},
        "item6": {"pass": passing},
        "joint_shift_seed": None,
        "all_pass": passing,
    }


def _run_report(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, positives: list[int]) -> dict[str, Any]:
    configs = family_a.family_a()
    reached = [c["id"] for c in configs[: len(positives)]]
    runs = tmp_path / "runs"
    for c in configs:
        d = runs / c["id"]
        d.mkdir(parents=True)
        daily = pd.DataFrame({"date_ms": np.arange(5) * DAY, "net": np.zeros(5), "costs": np.full(5, 0.0005)})
        daily.to_parquet(d / "daily.parquet")
        pd.DataFrame({"symbol": ["BTCUSDT"]}).to_parquet(d / "tranches.parquet")
        (d / "receipt.json").write_text(json.dumps({"id": c["id"]}), encoding="utf-8")
    counts = dict(zip(reached, positives, strict=True))

    def fake_family_report(family: str, runs_dir: Any, round_dir: Any, count: int, ds: Any, **kw: Any) -> dict:
        two = kw["tripwire"] is not None
        return {
            "configurations": {c["id"]: _ev(c["id"] in counts) for c in configs},
            "candidates": [{"id": reached[0]}] if two else [],
            "finalists": [],
            "variance": {},
            "tripwire": "x",
            "tripwire_input": kw["tripwire"],
        }

    monkeypatch.setattr(phase5, "_load", lambda ds: ({"datasetHash": DS_HASH}, {"BTCUSDT": {}}))
    monkeypatch.setattr(phase5, "check_complete", lambda *a, **k: None)
    monkeypatch.setattr(bar, "family_report", fake_family_report)
    monkeypatch.setattr(bar, "item2", lambda d: {"pbo": 0.1, "pass": True})
    monkeypatch.setattr(cli, "run_tripwire", lambda cfg, *a, **k: {"positive": counts[Path(cfg).stem], "n": 100})
    monkeypatch.setattr(phase5.hedge_cost, "run_hedge_cost", lambda *a, **k: {})
    monkeypatch.setattr(phase5.account, "account_report", lambda *a, **k: {})
    return phase5.report_family(tmp_path / "ds", runs, tmp_path / "out", COMMIT)


def test_tripwire_aggregation_halts_above_sixty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    report = _run_report(tmp_path / "a", monkeypatch, [12, 61])
    assert report["largest_tripwire_positive"] == 61 and report["halted"] is True
    assert report["twin_plan"] == [] and report["n_reached_items_1_to_3"] == 2


def test_tripwire_aggregation_boundary_sixty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    report = _run_report(tmp_path / "b", monkeypatch, [60, 12])
    assert report["largest_tripwire_positive"] == 60 and report["halted"] is False
    assert [e["slot"] for e in report["twin_plan"]] == [0]


def _twin_setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **plan_change: Any) -> tuple[Path, Path, Path]:
    ids = [c["id"] for c in family_a.family_a()]
    cid = ids[3]
    entry = {"id": cid, "registry_index": 3, "slot": 0, "twin_id": f"A_twin0_{cid}", **plan_change}
    runs = tmp_path / "runs"
    for i in ids:
        (runs / i).mkdir(parents=True)
        (runs / i / "receipt.json").write_text(json.dumps({"id": i}), encoding="utf-8")
    report = {
        "commit": COMMIT,
        "dataset_hash": DS_HASH,
        "source_sha256": cli.source_digest(),
        "receipts_sha256": phase5._receipt_hashes(runs),
        "halted": False,
        "pass1": {"candidates": []},
        "pass2": {"candidates": [{"id": cid}]},
        "twin_plan": [entry],
    }
    report_file = tmp_path / "report.json"
    report_file.write_text(json.dumps(report), encoding="utf-8")
    monkeypatch.setattr(phase5, "_load", lambda ds: ({"datasetHash": DS_HASH}, {}))
    monkeypatch.setattr(phase5, "check_complete", lambda *a, **k: None)
    return tmp_path / "runs", report_file, tmp_path / "out"


def test_run_twins_refuses_other_commit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match="not"):
        phase5.run_twins(tmp_path, runs, rf, out, "d" * 40)


@pytest.mark.parametrize(
    ("change", "match"),
    [
        ({"id": "A_nope_C9"}, "candidates"),
        ({"slot": 3}, "outside"),
        ({"slot": True}, "outside"),
        ({"twin_id": "A_twin0_wrong"}, "twin_id"),
    ],
)
def test_run_twins_refuses_bad_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: dict[str, Any], match: str
) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch, **change)
    with pytest.raises(ValueError, match=match):
        phase5.run_twins(tmp_path, runs, rf, out, COMMIT)


def test_run_twins_refuses_undeclared_id_in_candidates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch, id="A_nope_C9", twin_id="A_twin0_A_nope_C9")
    report = json.loads(rf.read_text(encoding="utf-8"))
    report["pass2"]["candidates"] = [{"id": "A_nope_C9"}]
    rf.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError, match="declared"):
        phase5.run_twins(tmp_path, runs, rf, out, COMMIT)


def test_run_twins_refuses_plan_not_the_candidates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch)
    report = json.loads(rf.read_text(encoding="utf-8"))
    report["pass2"]["candidates"] = []
    rf.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError, match="candidates"):
        phase5.run_twins(tmp_path, runs, rf, out, COMMIT)


def test_run_twins_refuses_incomplete_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, rf, out = _twin_setup(tmp_path, monkeypatch)
    monkeypatch.undo()
    monkeypatch.setattr(phase5, "_load", lambda ds: ({"datasetHash": DS_HASH}, {}))
    empty = tmp_path / "empty_runs"
    empty.mkdir()
    with pytest.raises(ValueError, match="not the declared family"):
        phase5.run_twins(tmp_path, empty, rf, out, COMMIT)


@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("dataset_hash", "f" * 64, "dataset"),
        ("source_sha256", "0" * 64, "source digest"),
        ("receipts_sha256", {}, "receipts_sha256"),
    ],
)
def test_run_twins_refuses_a_report_from_other_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, value: Any, match: str
) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch)
    report = json.loads(rf.read_text(encoding="utf-8"))
    report[field] = value
    rf.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError, match=match):
        phase5.run_twins(tmp_path, runs, rf, out, COMMIT)


def test_run_twins_refuses_a_changed_parent_receipt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch)
    first = family_a.family_a()[0]["id"]
    (runs / first / "receipt.json").write_text(json.dumps({"id": first, "changed": True}), encoding="utf-8")
    with pytest.raises(ValueError, match="receipts_sha256"):
        phase5.run_twins(tmp_path, runs, rf, out, COMMIT)


def test_report_family_records_its_binding(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    report = _run_report(tmp_path / "c", monkeypatch, [12])
    assert report["dataset_hash"] == DS_HASH and report["source_sha256"] == cli.source_digest()
    assert report["receipts_sha256"] == phase5._receipt_hashes(tmp_path / "c" / "runs")


def test_zero_tranche_family_report_integration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    n_days = 330
    start = DEV_END - n_days * DAY
    first = start + 240 * DAY
    syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]
    sd = np.array([0.03, 0.035, 0.05, 0.035, 0.045, 0.045])
    corr = np.full((6, 6), 0.7) + 0.3 * np.eye(6)
    panel = synth_panel(corr * np.outer(sd, sd), syms, start, DEV_END, seed=777)
    rng = np.random.default_rng(5)
    for s in syms:
        p = panel[s]["premium_5m"].copy()
        p["c"] = rng.normal(0.0, 2e-4, size=len(p))
        panel[s]["premium_5m"] = p
        panel[s]["premiumIndex"] = p
        f = panel[s]["settlements"].copy()
        f["rate"] = rng.normal(1e-4, 8e-5, size=len(f))
        panel[s]["settlements"] = f
        panel[s]["funding"] = f
    ds = write_synthetic_dataset(panel, tmp_path / "ds")

    by_id = {c["id"]: c for c in family_a.family_a()}
    subset = [
        dict(by_id["A_ridge-t_C4"], threshold=1.0, first_refit_ms=first),
        dict(by_id["A_ridge_C4"], first_refit_ms=first),
        dict(by_id["A_lgbm_C4"], first_refit_ms=first),
    ]
    monkeypatch.setattr(family_a, "family_a", lambda: [dict(c) for c in subset])
    out = tmp_path / "out"
    phase5.run_family(ds, out, COMMIT)
    report = phase5.report_family(ds, out / "runs", out, COMMIT)

    assert (out / "family_a_report.json").is_file()
    assert report["account"]["A_ridge-t_C4"] == {"skipped": "no tranches"}
    for cid in ("A_ridge_C4", "A_lgbm_C4"):
        assert "leverages" in report["account"][cid]
