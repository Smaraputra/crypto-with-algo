"""Brief 34b: family D entry points (run, report, twins) and the decision-level reports. Synthetic only."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import bar, cli, family_c, family_d, phase5_d
from r4.method import UNIVERSE
from r4.pipeline import load_panel
from r4.synth import synth_panel, write_synthetic_dataset

H = 3_600_000
DAY = 86_400_000
COMMIT = "c" * 40
DS_HASH = "e" * 64
START = 1_672_531_200_000  # 2023-01-01 UTC: 120 days end exactly at a month boundary
SYMS = list(UNIVERSE[:6])


def _short_configs() -> list[dict[str, Any]]:
    """Three fast ridge configurations in the shape of the family D registry (one cell, three bands)."""
    out = []
    for band, tag in ((0.0, "b0"), (0.045, "b045"), (0.09, "b09")):
        out.append(
            {
                "id": f"D_invvol_{tag}_C2",
                "kind": "trial",
                "family": "D",
                "cell": "C2",
                "model": "ridge",
                "params": {"alpha": 1.0},
                "features": ["ret_1", "ret_4"],
                "interval": "1h",
                "h_ms": 4 * H,
                "label": "fixed",
                "side_rule": "sign",
                "threshold": 0.0,
                "size_rule": "unit",
                "lookback_months": None,
                "refit": "monthly",
                "exit": "horizon",
                "seed": 7,
                "book": "D",
                "d_weights": "inv_vol",
                "d_band": band,
                "joint_shift_seed": 13_000_000 + len(out),
                "first_refit_ms": 1_680_307_200_000,
            }
        )
    return out


@pytest.fixture(scope="module")
def e2e(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("fd34b")
    base = np.full((6, 6), 0.0009)
    cov = base + np.diag(np.array([0.0007, 0.0016, 0.0020, 0.0027, 0.0011, 0.0018]))
    panel = synth_panel(cov, SYMS, START, START + 120 * DAY, seed=31)
    ds = write_synthetic_dataset(panel, root / "ds")
    manifest = json.loads((ds / "manifest.json").read_text(encoding="utf-8"))
    loaded = load_panel(ds, list(manifest["symbols"]))
    finalist = {c["id"]: c for c in family_c.family_c()}[family_d.FINALIST_ID]
    fc, _ = family_c.compute_forecasts(loaded, finalist)
    digest = family_d.canonical_digest(fc[np.isfinite(fc["f"])], "f")
    return {"root": root, "ds": ds, "hash": manifest["datasetHash"], "digest": digest, "configs": _short_configs()}


@pytest.fixture(scope="module")
def e2e_run(e2e: dict[str, Any]) -> dict[str, Any]:
    mp = pytest.MonkeyPatch()
    mp.setattr(family_d, "family_d", lambda: [dict(c) for c in e2e["configs"]])
    mp.setitem(family_d.PARITY_REFERENCE, e2e["hash"], e2e["digest"])
    try:
        out = e2e["root"] / "out"
        receipts = phase5_d.run_family_d(e2e["ds"], out, COMMIT)
    finally:
        mp.undo()
    return {"out": out, "receipts": receipts}


@pytest.fixture
def patched(e2e: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    monkeypatch.setattr(family_d, "family_d", lambda: [dict(c) for c in e2e["configs"]])
    monkeypatch.setitem(family_d.PARITY_REFERENCE, e2e["hash"], e2e["digest"])
    return e2e


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


def _fake_bar(monkeypatch: pytest.MonkeyPatch, configs: list[dict[str, Any]], reached: list[str]) -> list[dict]:
    calls: list[dict[str, Any]] = []

    def fake_family_report(family: str, runs_dir: Any, round_dir: Any, count: int, ds: Any, **kw: Any) -> dict:
        calls.append({"family": family, "count": count, **kw})
        two = kw["tripwire"] is not None
        return {
            "configurations": {c["id"]: _ev(c["id"] in reached) for c in configs},
            "candidates": [{"id": reached[0]}] if (two and reached) else [],
            "finalists": [],
            "variance": {},
            "tripwire": "x",
            "tripwire_input": kw["tripwire"],
        }

    monkeypatch.setattr(bar, "family_report", fake_family_report)
    monkeypatch.setattr(bar, "item2", lambda d: {"pbo": 0.1, "pass": True})
    monkeypatch.setattr(cli, "run_tripwire", lambda cfg, *a, **k: {"positive": 12, "n": 100})
    monkeypatch.setattr(phase5_d.hedge_cost, "run_hedge_cost", lambda *a, **k: {"profile": k.get("profile")})
    monkeypatch.setattr(phase5_d.account, "account_report", lambda *a, **k: {"ok": True})
    return calls


# ---------------------------------------------------------------------------------------------------------------------
# End to end
# ---------------------------------------------------------------------------------------------------------------------


def test_run_family_d_writes_runs_with_decision_records(patched: dict[str, Any], e2e_run: dict[str, Any]) -> None:
    out = e2e_run["out"]
    ids = [c["id"] for c in patched["configs"]]
    assert sorted(p.name for p in (out / "runs").iterdir()) == sorted(ids)
    assert [r["config"]["id"] for r in e2e_run["receipts"]] == ids
    for cid in ids:
        d = out / "runs" / cid
        receipt = json.loads((d / "receipt.json").read_text(encoding="utf-8"))
        assert receipt["d_vol"]["parity_digest"] == patched["digest"]
        assert receipt["d_vol"]["n_keys_differing"] >= 0 and 0.0 <= receipt["d_vol"]["max_rel_diff"] <= 1e-12
        assert receipt["decisions_sha256"] == hashlib.sha256((d / "decisions.parquet").read_bytes()).hexdigest()
        assert json.loads((out / "cfg" / f"{cid}.json").read_text(encoding="utf-8"))["id"] == cid
    phase5_d.check_complete(
        out / "runs",
        commit=COMMIT,
        source_sha256=cli.source_digest(),
        dataset_hash=patched["hash"],
    )


def test_report_family_d_bindings_and_decision_reports(
    patched: dict[str, Any], e2e_run: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs = e2e_run["out"] / "runs"
    configs = patched["configs"]
    calls = _fake_bar(monkeypatch, configs, [configs[1]["id"]])
    report = phase5_d.report_family_d(patched["ds"], runs, tmp_path / "rep", COMMIT)
    out_file = tmp_path / "rep" / "family_d_report.json"
    assert json.loads(out_file.read_text(encoding="utf-8"))["commit"] == COMMIT
    assert report["family"] == "D" and report["commit"] == COMMIT
    assert report["dataset_hash"] == patched["hash"]
    assert report["source_sha256"] == cli.source_digest()
    assert report["receipts_sha256"] == phase5_d._receipt_hashes(runs)
    assert report["round_alpha_count"] == 66 == phase5_d.ROUND_ALPHA_COUNT
    assert [c["family"] for c in calls] == ["D", "D"]
    assert all(c["family_index"] == 3 and c["count"] == 66 for c in calls)
    assert calls[0]["tripwire"] is None and calls[1]["tripwire"] == {"positive": 12, "n": 100}
    assert report["n_reached_items_1_to_3"] == 1 and report["tripwires"] == {
        configs[1]["id"]: {"positive": 12, "n": 100}
    }
    assert report["halted"] is False and report["result_pass"] == 2
    assert report["hedge_cost"] == {configs[1]["id"]: {"profile": "standard"}}
    assert set(report["account"]) == {c["id"] for c in configs}
    assert report["within_cell_pbo"] == {"C2": {"pbo": 0.1, "pass": True, "n_configs": 3}}
    assert report["twin_plan"] == [
        {
            "id": configs[1]["id"],
            "registry_index": 1,
            "slot": 0,
            "twin_id": f"D_twin0_{configs[1]['id']}",
        }
    ]
    assert report["twin_shortfall"] == []
    assert report["predictions"] == family_d.PREDICTIONS
    # cost drag by cell and by band, and the cost check
    assert set(report["cost_drag"]["mean_daily_costs_by_cell"]) == {"C2"}
    assert set(report["cost_drag"]["mean_daily_costs_by_band"]) == {"0.0", "0.045", "0.09"}
    costs = [
        float(pd.read_parquet(runs / c["id"] / "daily.parquet")["costs"].mean()) for c in configs
    ]  # ordered by band
    assert report["cost_check"]["C2"]["mean_daily_costs"] == pytest.approx(costs, abs=0.0)
    assert report["cost_check"]["C2"]["non_increasing"] is bool(costs[1] <= costs[0] and costs[2] <= costs[1])
    assert report["cost_check"]["registered_prediction"] is True
    # parity values, identical across configurations
    parity = report["f_parity"]
    assert parity["identical_across_configurations"] is True and parity["parity_digest"] == patched["digest"]
    assert set(parity["missing_wf_hours_by_coin"]) == set(SYMS)
    assert parity["n_keys_differing"] >= 0 and 0.0 <= parity["max_rel_diff"] <= 1e-12
    # per configuration decision reports from decisions.parquet
    for c in configs:
        dec = pd.read_parquet(runs / c["id"] / "decisions.parquet")
        rep = report["decision_reports"][c["id"]]
        wf = dec[dec["phase"] == "wf"].groupby("T").agg(cash=("cash", "all"), took=("took_prev", "all"))
        counted = wf[~wf["cash"]]
        assert rep["wf_non_cash_times"] == len(counted) and rep["wf_all_times"] == len(wf)
        assert rep["wf_take_prev_count"] == int(wf["took"].sum())
        assert rep["wf_take_prev_share"] == pytest.approx(float(wf["took"].sum() / len(counted)))
        assert rep["wf_take_prev_share_all_times"] == pytest.approx(float(wf["took"].mean()))
        assert rep["near_duplicate_of_b0"] is bool(c["d_band"] > 0 and rep["wf_take_prev_share"] < 0.01)
        assert rep["wf_cash"]["n_times"] == len(wf)
        cp = dec[dec["phase"].str.startswith("cpcv:")]
        assert set(rep["cpcv_cash_by_call"]) == {int(k) for k in cp["call"].unique()}
        assert set(rep["cpcv_cash_by_path"]) == {int(ph.split(":")[1]) for ph in cp["phase"].unique()}
        assert set(rep["cpcv_cash_by_path"]) == set(range(5))
        gross = json.loads((runs / c["id"] / "receipt.json").read_text())["metrics"]["cpcv_path_gross_means"]
        assert rep["cpcv_gross"]["mean"] == pytest.approx(float(np.mean(gross)))
        assert rep["cpcv_gross"]["within_bound"] is bool(abs(np.mean(gross)) <= 0.0001)
    assert report["decision_reports"][configs[0]["id"]]["wf_take_prev_share"] == 0.0
    assert report["decision_reports"][configs[0]["id"]]["near_duplicate_of_b0"] is False
    assert report["decision_reports"][configs[2]["id"]]["wf_take_prev_share"] > 0.0


def test_report_skips_hedge_and_account_when_a_run_has_no_tranches(
    patched: dict[str, Any], e2e_run: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs = shutil.copytree(e2e_run["out"] / "runs", tmp_path / "runs")
    first = patched["configs"][0]["id"]
    (runs / first / "tranches.parquet").unlink()
    _fake_bar(monkeypatch, patched["configs"], [first])
    report = phase5_d.report_family_d(patched["ds"], runs, tmp_path / "rep", COMMIT)
    assert report["hedge_cost"][first] == {"skipped": "no tranches"}
    assert report["account"][first] == {"skipped": "no tranches"}


def test_report_halts_the_family_above_sixty(
    patched: dict[str, Any], e2e_run: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    configs = patched["configs"]
    _fake_bar(monkeypatch, configs, [configs[0]["id"]])
    monkeypatch.setattr(cli, "run_tripwire", lambda cfg, *a, **k: {"positive": 61, "n": 100})
    report = phase5_d.report_family_d(patched["ds"], e2e_run["out"] / "runs", tmp_path / "rep", COMMIT)
    assert report["largest_tripwire_positive"] == 61 and report["halted"] is True
    assert report["twin_plan"] == []


def _copy_runs(src: Path, dst: Path) -> Path:
    shutil.copytree(src, dst)
    return dst


def test_check_complete_refuses_a_rewritten_decision_record_and_other_defects(
    patched: dict[str, Any], e2e_run: dict[str, Any], tmp_path: Path
) -> None:
    kw: dict[str, Any] = {"commit": COMMIT, "source_sha256": cli.source_digest(), "dataset_hash": patched["hash"]}
    first = patched["configs"][0]["id"]
    runs = _copy_runs(e2e_run["out"] / "runs", tmp_path / "r1")
    phase5_d.check_complete(runs, **kw)
    dec_file = runs / first / "decisions.parquet"
    dec = pd.read_parquet(dec_file)
    dec.loc[dec.index[0], "w_taken"] = 0.5
    dec.to_parquet(dec_file, index=False)
    with pytest.raises(ValueError, match="decisions.parquet does not match"):
        phase5_d.check_complete(runs, **kw)
    with pytest.raises(ValueError, match="decisions.parquet does not match"):
        phase5_d.report_family_d(patched["ds"], runs, tmp_path / "o1", COMMIT)
    runs = _copy_runs(e2e_run["out"] / "runs", tmp_path / "r2")
    (runs / first / "decisions.parquet").unlink()
    with pytest.raises(ValueError, match="no decisions.parquet"):
        phase5_d.check_complete(runs, **kw)
    rc = e2e_run["out"] / "runs" / first / "receipt.json"
    receipt = json.loads(rc.read_text())
    for key, match in (("d_vol", "no d_vol"), ("decisions_sha256", "no decisions_sha256")):
        runs = _copy_runs(e2e_run["out"] / "runs", tmp_path / f"r_{key}")
        (runs / first / "receipt.json").write_text(json.dumps({k: v for k, v in receipt.items() if k != key}))
        with pytest.raises(ValueError, match=match):
            phase5_d.check_complete(runs, **kw)
    runs = _copy_runs(e2e_run["out"] / "runs", tmp_path / "r3")
    shutil.rmtree(runs / first)
    with pytest.raises(ValueError, match="missing"):
        phase5_d.check_complete(runs, **kw)
    runs = _copy_runs(e2e_run["out"] / "runs", tmp_path / "r4")
    (runs / "D_extra").mkdir()
    with pytest.raises(ValueError, match="extra"):
        phase5_d.check_complete(runs, **kw)
    runs = _copy_runs(e2e_run["out"] / "runs", tmp_path / "r5")
    (runs / first / "receipt.json").write_text(json.dumps(receipt | {"config_hash": "0" * 64}))
    with pytest.raises(ValueError, match="registry entry"):
        phase5_d.check_complete(runs, **kw)
    (runs / first / "receipt.json").write_text(json.dumps(receipt | {"kind": "control"}))
    with pytest.raises(ValueError, match="not a trial"):
        phase5_d.check_complete(runs, **kw)
    for key, value in (("commit", "e" * 40), ("dataset_hash", "1" * 64), ("source_sha256", "2" * 64)):
        (runs / first / "receipt.json").write_text(json.dumps(receipt | {key: value}))
        with pytest.raises(ValueError, match=key):
            phase5_d.check_complete(runs, **kw)


def test_run_twins_d_runs_the_planned_twin_and_answers_the_refit_question(
    patched: dict[str, Any], e2e_run: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs = e2e_run["out"] / "runs"
    configs = patched["configs"]
    _fake_bar(monkeypatch, configs, [configs[1]["id"]])
    phase5_d.report_family_d(patched["ds"], runs, tmp_path / "rep", COMMIT)
    monkeypatch.undo()
    monkeypatch.setattr(family_d, "family_d", lambda: [dict(c) for c in configs])
    monkeypatch.setitem(family_d.PARITY_REFERENCE, patched["hash"], patched["digest"])
    report_file = tmp_path / "rep" / "family_d_report.json"
    res = phase5_d.run_twins_d(patched["ds"], runs, report_file, tmp_path / "tw", COMMIT)
    q = res["refit_questions"][configs[1]["id"]]
    assert q["twin_id"] == f"D_twin0_{configs[1]['id']}" and q["slot"] == 0 and q["seed"] == 7_300_001
    assert res["report_sha256"] == hashlib.sha256(report_file.read_bytes()).hexdigest()
    twin_dir = tmp_path / "tw" / "twins" / "runs" / q["twin_id"]
    twin_receipt = json.loads((twin_dir / "receipt.json").read_text())
    assert twin_receipt["config"]["refit"] == "none" and twin_receipt["config"]["d_weights"] == "inv_vol"
    assert twin_receipt["config"]["joint_shift_seed"] == 13_000_009 and twin_receipt["d_vol"]
    assert (tmp_path / "tw" / "refit_questions.json").is_file()


# ---------------------------------------------------------------------------------------------------------------------
# Hand numbers for the decision-level reports
# ---------------------------------------------------------------------------------------------------------------------


def _decisions(took_flags: list[bool], phase: str = "wf", call: int = 0, n_ranked: int = 7) -> pd.DataFrame:
    rows = []
    for k, took in enumerate(took_flags):
        for i in range(7):
            rows.append(
                {
                    "phase": phase,
                    "call": call,
                    "block_start": 0,
                    "T": k * H,
                    "symbol": f"C{i}USDT",
                    "ranked": i < n_ranked,
                    "f": 1e-4,
                    "w_new": 0.1,
                    "w_taken": 0.1,
                    "took_prev": took,
                    "cash": False,
                }
            )
    return pd.DataFrame(rows)


def _receipt(gross: list[float]) -> dict[str, Any]:
    return {"metrics": {"cpcv_path_gross_means": gross}}


def test_decision_report_near_duplicate_threshold_on_hand_numbers(tmp_path: Path) -> None:
    config = {"d_band": 0.045}
    flags = [True] + [False] * 199  # 1 of 200 decisions takes w_prev: 0.005
    _decisions(flags).to_parquet(tmp_path / "decisions.parquet", index=False)
    rep = phase5_d._decision_report(config, tmp_path, _receipt([0.0]))
    assert rep["wf_take_prev_share"] == 0.005 and rep["near_duplicate_of_b0"] is True
    flags = [True] * 2 + [False] * 198  # exactly 0.01 is not under 1 percent
    _decisions(flags).to_parquet(tmp_path / "decisions.parquet", index=False)
    rep = phase5_d._decision_report(config, tmp_path, _receipt([0.0]))
    assert rep["wf_take_prev_share"] == 0.01 and rep["near_duplicate_of_b0"] is False
    # b = 0 is never flagged
    _decisions([False] * 50).to_parquet(tmp_path / "decisions.parquet", index=False)
    rep = phase5_d._decision_report({"d_band": 0.0}, tmp_path, _receipt([0.0]))
    assert rep["wf_take_prev_share"] == 0.0 and rep["near_duplicate_of_b0"] is False
    rep = phase5_d._decision_report(config, tmp_path, _receipt([0.0]))
    assert rep["near_duplicate_of_b0"] is True


def test_decision_report_cash_shares_and_cpcv_diagnostic_on_hand_numbers(tmp_path: Path) -> None:
    wf = _decisions([False] * 4)
    wf["cash"] = wf["T"].isin([0, H])  # times 0 and 1 are cash
    wf.loc[wf["T"] == H, "ranked"] = wf.loc[wf["T"] == H, "symbol"].isin(["C0USDT", "C1USDT", "C2USDT"])  # 3 ranked
    cpcv0 = _decisions([False] * 2, phase="cpcv:0", call=3)
    cpcv0["cash"] = True
    cpcv1 = _decisions([False] * 2, phase="cpcv:1", call=4)
    pd.concat([wf, cpcv0, cpcv1], ignore_index=True).to_parquet(tmp_path / "decisions.parquet", index=False)
    rep = phase5_d._decision_report({"d_band": 0.0}, tmp_path, _receipt([0.00004, 0.00008, 0.00012]))
    assert rep["wf_cash"] == {
        "n_times": 4,
        "cash_share": 0.5,
        "all_tie_cash_share": 0.25,  # time 0: 7 ranked, cash
        "fewer_than_6_cash_share": 0.25,  # time 1: 3 ranked, cash
    }
    assert rep["wf_non_cash_times"] == 2 and rep["wf_all_times"] == 4
    assert rep["cpcv_cash_by_call"][3]["cash_share"] == 1.0 and rep["cpcv_cash_by_call"][4]["cash_share"] == 0.0
    assert rep["cpcv_cash_by_path"][0]["cash_share"] == 1.0 and rep["cpcv_cash_by_path"][1]["cash_share"] == 0.0
    assert rep["cpcv_gross"]["mean"] == pytest.approx(0.00008)
    assert rep["cpcv_gross"]["within_bound"] is True and rep["cpcv_gross"]["uninformative"] is False
    # a bound just beyond 1 bp a day, and an all-cash CPCV
    cpcv1["cash"] = True
    pd.concat([wf, cpcv0, cpcv1], ignore_index=True).to_parquet(tmp_path / "decisions.parquet", index=False)
    rep = phase5_d._decision_report({"d_band": 0.0}, tmp_path, _receipt([0.0002]))
    assert rep["cpcv_gross"]["within_bound"] is False and rep["cpcv_gross"]["uninformative"] is True


def test_decision_report_w_prev_share_denominator_is_the_non_cash_times(tmp_path: Path) -> None:
    config = {"d_band": 0.045}
    # 200 walk-forward times: the first 100 are cash, one of the others repeats w_prev
    rows = _decisions([False] * 200)
    rows["cash"] = rows["T"] < 100 * H
    rows.loc[rows["T"] == 150 * H, "took_prev"] = True
    rows.to_parquet(tmp_path / "decisions.parquet", index=False)
    rep = phase5_d._decision_report(config, tmp_path, _receipt([0.0]))
    assert (rep["wf_take_prev_count"], rep["wf_non_cash_times"], rep["wf_all_times"]) == (1, 100, 200)
    assert rep["wf_take_prev_share"] == 0.01 and rep["wf_take_prev_share_all_times"] == 0.005
    assert rep["near_duplicate_of_b0"] is False  # exactly 0.01 is not under 1 percent
    # with 101 non-cash times the share is 1 of 101, under 1 percent
    rows["cash"] = rows["T"] < 99 * H
    rows.to_parquet(tmp_path / "decisions.parquet", index=False)
    rep = phase5_d._decision_report(config, tmp_path, _receipt([0.0]))
    assert rep["wf_non_cash_times"] == 101 and rep["wf_take_prev_share"] == 1 / 101
    assert rep["near_duplicate_of_b0"] is True
    # all cash: no defined share and no flag
    rows["cash"] = True
    rows.loc[:, "took_prev"] = False
    rows.to_parquet(tmp_path / "decisions.parquet", index=False)
    rep = phase5_d._decision_report(config, tmp_path, _receipt([0.0]))
    assert rep["wf_take_prev_share"] is None and rep["near_duplicate_of_b0"] is False


def test_decision_report_cpcv_cash_share_per_path_on_a_hand_count(tmp_path: Path) -> None:
    # path 0 has calls 10, 11, 12 and path 1 has calls 13, 14, 15, each call with 2 decision times (14 rows each).
    # path 0 cash times: call 10 both, call 11 none, call 12 one: 3 of 6. Path 1: call 13 none, 14 none, 15 one: 1 of 6.
    parts = []
    cash_times = {10: [0, 1], 11: [], 12: [1], 13: [], 14: [], 15: [0]}
    for call, path in zip(range(10, 16), [0, 0, 0, 1, 1, 1], strict=True):
        part = _decisions([False, False], phase=f"cpcv:{path}", call=call)
        part["cash"] = part["T"].isin([k * H for k in cash_times[call]])
        parts.append(part)
    pd.concat([_decisions([False] * 3), *parts], ignore_index=True).to_parquet(
        tmp_path / "decisions.parquet", index=False
    )
    rep = phase5_d._decision_report({"d_band": 0.0}, tmp_path, _receipt([0.0]))
    assert sorted(rep["cpcv_cash_by_path"]) == [0, 1]
    assert rep["cpcv_cash_by_path"][0]["n_times"] == 6 and rep["cpcv_cash_by_path"][0]["cash_share"] == 0.5
    assert rep["cpcv_cash_by_path"][1]["n_times"] == 6 and rep["cpcv_cash_by_path"][1]["cash_share"] == 1 / 6
    assert sorted(rep["cpcv_cash_by_call"]) == [10, 11, 12, 13, 14, 15]
    assert rep["cpcv_cash_by_call"][10]["cash_share"] == 1.0 and rep["cpcv_cash_by_call"][12]["cash_share"] == 0.5


# ---------------------------------------------------------------------------------------------------------------------
# Twins: binding checks
# ---------------------------------------------------------------------------------------------------------------------


def _twin_setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **plan_change: Any) -> tuple[Path, Path, Path]:
    ids = [c["id"] for c in family_d.family_d()]
    cid = ids[3]
    entry = {"id": cid, "registry_index": 3, "slot": 0, "twin_id": f"D_twin0_{cid}", **plan_change}
    runs = tmp_path / "runs"
    for i in ids:
        (runs / i).mkdir(parents=True)
        (runs / i / "receipt.json").write_text(json.dumps({"id": i}), encoding="utf-8")
    report = {
        "commit": COMMIT,
        "dataset_hash": DS_HASH,
        "source_sha256": cli.source_digest(),
        "receipts_sha256": phase5_d._receipt_hashes(runs),
        "halted": False,
        "pass1": {"candidates": []},
        "pass2": {"candidates": [{"id": cid}]},
        "twin_plan": [entry],
    }
    report_file = tmp_path / "report.json"
    report_file.write_text(json.dumps(report), encoding="utf-8")
    monkeypatch.setattr(phase5_d, "_load", lambda ds: ({"datasetHash": DS_HASH}, {}))
    monkeypatch.setattr(phase5_d, "check_complete", lambda *a, **k: None)
    return runs, report_file, tmp_path / "out"


def test_run_twins_d_refuses_other_commit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match="not"):
        phase5_d.run_twins_d(tmp_path, runs, rf, out, "d" * 40)


@pytest.mark.parametrize(
    ("field", "value", "match"),
    [
        ("dataset_hash", "1" * 64, "dataset"),
        ("source_sha256", "2" * 64, "source digest"),
        ("receipts_sha256", {"x": "y"}, "receipts_sha256"),
    ],
)
def test_run_twins_d_refuses_a_report_from_other_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, value: Any, match: str
) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch)
    report = json.loads(rf.read_text(encoding="utf-8"))
    report[field] = value
    rf.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError, match=match):
        phase5_d.run_twins_d(tmp_path, runs, rf, out, COMMIT)


@pytest.mark.parametrize(
    ("change", "match"),
    [
        ({"id": "D_nope_C9"}, "candidates"),
        ({"slot": 3}, "outside"),
        ({"slot": True}, "outside"),
        ({"twin_id": "D_twin0_wrong"}, "twin_id"),
    ],
)
def test_run_twins_d_refuses_bad_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: dict[str, Any], match: str
) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch, **change)
    with pytest.raises(ValueError, match=match):
        phase5_d.run_twins_d(tmp_path, runs, rf, out, COMMIT)


def test_run_twins_d_refuses_undeclared_id_and_plan_not_the_candidates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch, id="D_nope_C9", twin_id="D_twin0_D_nope_C9")
    report = json.loads(rf.read_text(encoding="utf-8"))
    report["pass2"]["candidates"] = [{"id": "D_nope_C9"}]
    rf.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError, match="declared"):
        phase5_d.run_twins_d(tmp_path, runs, rf, out, COMMIT)
    runs, rf, out = _twin_setup(tmp_path / "b", monkeypatch)
    report = json.loads(rf.read_text(encoding="utf-8"))
    report["pass2"]["candidates"] = []
    rf.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError, match="candidates"):
        phase5_d.run_twins_d(tmp_path, runs, rf, out, COMMIT)
    runs, rf, out = _twin_setup(tmp_path / "c", monkeypatch)
    report = json.loads(rf.read_text(encoding="utf-8"))
    report["halted"] = True
    rf.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError, match="candidates"):
        phase5_d.run_twins_d(tmp_path, runs, rf, out, COMMIT)


def test_run_twins_d_refuses_incomplete_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runs, rf, out = _twin_setup(tmp_path, monkeypatch)
    monkeypatch.undo()
    monkeypatch.setattr(phase5_d, "_load", lambda ds: ({"datasetHash": DS_HASH}, {}))
    with pytest.raises(ValueError, match="receipt|d_vol|kind"):
        phase5_d.run_twins_d(tmp_path, runs, rf, out, COMMIT)


# ---------------------------------------------------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------------------------------------------------


def test_cli_dispatches_the_family_d_subcommands(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, tuple[Any, ...]]] = []
    monkeypatch.setattr(phase5_d, "run_family_d", lambda *a: calls.append(("run", a)))
    monkeypatch.setattr(phase5_d, "report_family_d", lambda *a: calls.append(("report", a)))
    monkeypatch.setattr(phase5_d, "run_twins_d", lambda *a: calls.append(("twins", a)))
    for argv, name, want in (
        (["family-d-run", "--ds", "d", "--out", "o", "--commit", "c"], "run", ("d", "o", "c")),
        (
            ["family-d-report", "--ds", "d", "--runs", "r", "--out", "o", "--commit", "c"],
            "report",
            ("d", "r", "o", "c"),
        ),
        (
            ["family-d-twins", "--ds", "d", "--runs", "r", "--report", "p", "--out", "o", "--commit", "c"],
            "twins",
            ("d", "r", "p", "o", "c"),
        ),
    ):
        monkeypatch.setattr(sys, "argv", ["r4.cli", *argv])
        cli.main()
        assert calls[-1] == (name, want)
    assert len(calls) == 3


def test_constants() -> None:
    assert phase5_d.ROUND_ALPHA_COUNT == 12 + 45 + 9
    assert phase5_d.TRIPWIRE_SHIFTS == 100 and phase5_d.TRIPWIRE_HALT_ABOVE == 60
    assert phase5_d.HEDGE_PROFILE == "standard"
