"""Brief 29b: the native re-test reader and the evaluation of the hurdles that apply to a fixed rule."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

import r4.natives as natives
from r4.book import (
    DAY_MS,
    daily_close_log_returns,
    estimate_betas,
)
from r4.method import UNIVERSE
from r4.natives import (
    NATIVE_RULES,
    evaluate_retest,
    mechanical_parity,
    read_export,
    retest_family_spa,
    summarise_hurdles,
)
from r4.synth import synth_panel, write_synthetic_dataset
from r4.validation import panel_cpcv_splits

COMMIT = "abc1234"
HOUR = 3_600_000
FIVE = 300_000


def _ms(y: int, m: int, d: int) -> int:
    return int(datetime(y, m, d, tzinfo=UTC).timestamp() * 1000)


PANEL_START = _ms(2022, 10, 1)
PANEL_END = _ms(2023, 5, 10)
SPAN_START = _ms(2023, 2, 1)
SPAN_END = _ms(2023, 5, 1)
DATASET_HASH = "a" * 64


@pytest.fixture(scope="module")
def panel() -> dict[str, dict[str, pd.DataFrame]]:
    k = len(UNIVERSE)
    cov = 0.0009 * (0.4 + 0.6 * np.eye(k))
    return synth_panel(cov, UNIVERSE, PANEL_START, PANEL_END, seed=11)


def _open_at(panel: dict[str, dict[str, pd.DataFrame]], sym: str, t: int) -> float:
    return float(panel[sym]["5m"]["o"].to_numpy()[(t - PANEL_START) // FIVE])


def _row(panel, rule: str, sym: str, side: int, entry: int, hold: int, reason: str = "horizon", priced=True) -> dict:
    exit_ms = entry + hold
    return {
        "rule": rule,
        "symbol": sym,
        "side": side,
        "entry_ms": entry,
        "exit_ms": exit_ms,
        "entry_price": _open_at(panel, sym, entry),
        "exit_price": _open_at(panel, sym, exit_ms) if priced else None,
        "weight": side * 0.1,
        "exit_reason": reason,
        "price_source": "perp",
    }


def _random_rows(panel, rule: str, n: int, seed: int, lo: int, hi: int, hold: int = 8 * HOUR) -> list[dict]:
    rng = np.random.default_rng(seed)
    rows = []
    for _ in range(n):
        sym = UNIVERSE[int(rng.integers(0, len(UNIVERSE)))]
        entry = lo + int(rng.integers(0, (hi - lo) // FIVE)) * FIVE
        side = int(rng.choice([-1, 1]))
        rows.append(_row(panel, rule, sym, side, entry, hold))
    return rows


def _summary(rule: str, n: int, hash_: str = DATASET_HASH, costs: dict | None = None) -> dict[str, Any]:
    default_costs = {"fee_taker": 0.0005, "fee_maker": 0.0002, "slippage_bps": 2, "round_trip": 0.0014}
    if rule == "c1":
        default_costs = {"fee_taker": 0.0005, "fee_maker": None, "slippage_bps": 3, "round_trip": 0.0016}
    return {
        "rule": rule,
        "n_tranches": n,
        "mean_net_native": -0.001,
        "manifest_hash": hash_,
        "costs": costs or default_costs,
        "parity": {"recorded_trades": 10, "export_trades": n, "trades_diff": n - 10, "reference": "fixture"},
    }


def _write_export(tmp_path: Path, rows: list[dict], summary: dict, name: str = "exp") -> Path:
    d = tmp_path / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "tranches.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    (d / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
    return d


def _tranches(tmp_path: Path, panel, rule: str, rows: list[dict], name: str = "exp"):
    d = _write_export(tmp_path, rows, _summary(rule, len(rows)), name)
    return read_export(d, DATASET_HASH)


def _retest(rule, tranches, panel, summary=None, **kw):
    kw.setdefault("span_start", SPAN_START)
    kw.setdefault("span_end", SPAN_END)
    kw.setdefault("n_draws", 100)
    return evaluate_retest(rule, tranches, panel, 0.01, summary=summary, dataset_hash=DATASET_HASH, commit=COMMIT, **kw)


# ------------------------------------------------------------------------------------------------ the reader


def test_native_rules_table():
    assert set(NATIVE_RULES) == {"rv-v1", "s1", "s2", "c1", "v8-1h", "v8-4h"}
    assert NATIVE_RULES["rv-v1"].interval == "8h" and NATIVE_RULES["rv-v1"].item5 == "jackknife"
    assert NATIVE_RULES["s1"].slippage_bps == 2.0 and NATIVE_RULES["s1"].item5 == "coin_count"
    assert NATIVE_RULES["c1"].slippage_bps == 3.0
    assert NATIVE_RULES["v8-1h"].from_summary and NATIVE_RULES["v8-4h"].interval == "4h"


def test_read_export_maps_and_drops_unpriced_stops(tmp_path, panel):
    t0 = SPAN_START + 3 * DAY_MS
    rows = [
        _row(panel, "v8-1h", "BTCUSDT", 1, t0, 4 * HOUR, "horizon"),
        _row(panel, "v8-1h", "ETHUSDT", -1, t0, 4 * HOUR, "rebalance"),
        _row(panel, "v8-1h", "SOLUSDT", 1, t0, 4 * HOUR, "end_of_data"),
        _row(panel, "v8-1h", "ADAUSDT", -1, t0, 2 * HOUR, "stop"),
        _row(panel, "v8-1h", "DOTUSDT", 1, t0, 2 * HOUR, "stop", priced=False),
    ]
    costs = {"fee_taker": 0.00045, "fee_maker": 0.00018, "slippage_bps": 4, "round_trip": 0.0}
    d = _write_export(tmp_path, rows, _summary("v8-1h", 5, costs=costs))
    tranches, summary, dropped = read_export(d, DATASET_HASH)

    assert summary["rule"] == "v8-1h"
    assert [t.symbol for t in tranches] == ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT"]
    assert [t.exit_reason for t in tranches] == ["horizon", "horizon", "horizon", "stop"]
    assert dropped["unpriced_stop"] == 1
    assert dropped["share"] == pytest.approx(1 / 5)
    assert dropped["total_rows"] == 5
    for t, r in zip(tranches, rows[:4], strict=True):
        assert t.weight == r["weight"]  # weight_override carries the exported weight
        assert t.interval == "1h"
        assert t.entry_price == r["entry_price"] and t.exit_price == r["exit_price"]
        assert t.fee_profile == "bnb" and t.slippage_bps_override == 4.0  # the native cost the export reports
        assert t.entry_fill == "taker" and t.exit_fill == "taker"
    assert tranches[3].exit_priced and not tranches[0].exit_priced


def test_read_export_native_cost_for_fixed_rule(tmp_path, panel):
    rows = _random_rows(panel, "c1", 5, 1, SPAN_START, SPAN_START + DAY_MS, hold=24 * HOUR)
    tranches, _, dropped = read_export(_write_export(tmp_path, rows, _summary("c1", 5)), DATASET_HASH)
    assert {(t.fee_profile, t.slippage_bps_override) for t in tranches} == {("standard", 3.0)}
    assert dropped["unpriced_stop"] == 0 and dropped["share"] == 0.0
    # A summary whose costs disagree with the rule's native cost is refused.
    bad = _summary("c1", 5, costs={"fee_taker": 0.0005, "fee_maker": None, "slippage_bps": 2, "round_trip": 0.0})
    with pytest.raises(ValueError, match="native cost"):
        read_export(_write_export(tmp_path, rows, bad, "bad"), DATASET_HASH)


def test_read_export_requires_grid(tmp_path, panel):
    rows = _random_rows(panel, "s1", 3, 2, SPAN_START, SPAN_START + DAY_MS, hold=HOUR)
    rows[1] = {**rows[1], "entry_ms": rows[1]["entry_ms"] + 1}
    with pytest.raises(ValueError, match="300000"):
        read_export(_write_export(tmp_path, rows, _summary("s1", 3)), DATASET_HASH)
    rows = _random_rows(panel, "s1", 3, 2, SPAN_START, SPAN_START + DAY_MS, hold=HOUR)
    rows[2] = {**rows[2], "exit_ms": rows[2]["exit_ms"] + 60_000}
    with pytest.raises(ValueError, match="300000"):
        read_export(_write_export(tmp_path, rows, _summary("s1", 3), "b"), DATASET_HASH)


def test_read_export_manifest_check(tmp_path, panel):
    rows = _random_rows(panel, "s2", 3, 3, SPAN_START, SPAN_START + DAY_MS, hold=HOUR)
    d = _write_export(tmp_path, rows, _summary("s2", 3, hash_="b" * 64))
    with pytest.raises(ValueError, match="manifest"):
        read_export(d, DATASET_HASH)
    read_export(d, "b" * 64)


def test_read_export_rejects_unknown_reason_and_rule_mismatch(tmp_path, panel):
    rows = _random_rows(panel, "s1", 2, 4, SPAN_START, SPAN_START + DAY_MS, hold=HOUR)
    with pytest.raises(ValueError, match="exit_reason"):
        read_export(_write_export(tmp_path, [{**rows[0], "exit_reason": "magic"}], _summary("s1", 1)), DATASET_HASH)
    with pytest.raises(ValueError, match="rule"):
        read_export(_write_export(tmp_path, [{**rows[0], "rule": "s2"}], _summary("s1", 1), "m"), DATASET_HASH)


def test_mechanical_parity_returns_the_export_block():
    s = _summary("s1", 7)
    s["sharpe_ann"] = 0.5
    out = mechanical_parity(s)
    assert out["rule"] == "s1" and out["n_tranches"] == 7 and out["mean_net_native"] == -0.001
    assert out["parity"] == s["parity"]
    with pytest.raises(ValueError, match="parity"):
        mechanical_parity({"rule": "s1"})


# ------------------------------------------------------------------------------------------------ the evaluation


def test_retest_span_and_monthly_betas(tmp_path, panel):
    early = _random_rows(panel, "s1", 4, 5, _ms(2023, 1, 5), _ms(2023, 1, 20))
    inside = _random_rows(panel, "s1", 40, 6, SPAN_START, SPAN_START + 10 * DAY_MS)
    late = _random_rows(panel, "s1", 6, 7, _ms(2023, 3, 20), _ms(2023, 4, 10))
    after = _random_rows(panel, "s1", 3, 8, SPAN_END + DAY_MS, SPAN_END + 3 * DAY_MS)
    tr, summary, _ = _tranches(tmp_path, panel, "s1", early + inside + late + after)
    r = _retest("s1", tr, panel, summary)

    assert r["span"] == {"start_ms": SPAN_START, "end_ms": SPAN_END}
    assert r["n_tranches"] == 46 and r["n_out_of_span"] == 7
    assert [f["start_ms"] for f in r["folds"]] == [SPAN_START, _ms(2023, 3, 1), _ms(2023, 4, 1)]

    five_min_days = list(range(PANEL_START, PANEL_END + DAY_MS, DAY_MS))
    daily_ret = daily_close_log_returns({s: panel[s]["5m"] for s in panel}, five_min_days, list(panel))
    for fold, window_start in zip(r["folds"], [_ms(2022, 2, 1), _ms(2022, 3, 1), _ms(2022, 4, 1)], strict=True):
        assert fold["beta_window"] == {"start_ms": window_start, "end_ms": fold["start_ms"]}
        want = estimate_betas(daily_ret, start_ms=window_start, end_ms=fold["start_ms"])
        for sym in ("BTCUSDT", "ADAUSDT"):
            assert fold["betas"][sym] == pytest.approx(want[sym], rel=1e-9)

    daily = r["daily_drift_free"]
    assert daily["start_ms"] == SPAN_START and len(daily["values"]) == 89 and r["n_days"] == 89
    assert daily["values"][30] == 0.0  # no tranche open on 2023-03-03: a zero, not a gap


def test_retest_cpcv_fixed_rule_uses_split_betas(tmp_path, panel, monkeypatch):
    # A long span and a short embargo, so that the split training sets have the 60 days a beta needs.
    start = _ms(2022, 11, 1)
    embargo = 2 * DAY_MS
    monkeypatch.setattr(natives, "CPCV_EMBARGO_MS", embargo)
    rows = _random_rows(panel, "s2", 900, 9, start, SPAN_END - 2 * DAY_MS, hold=4 * HOUR)
    tr, summary, _ = _tranches(tmp_path, panel, "s2", rows)

    beta_calls: list[tuple[tuple, dict]] = []
    real_beta = natives.estimate_betas

    def spy(frame, *a, **k):
        beta_calls.append((tuple(int(i) for i in frame.index), dict(k)))
        return real_beta(frame, *a, **k)

    used: list[float] = []
    real_hedged = natives.beta_hedged_daily

    def spy_hedged(tranches, five_min, settlements, betas, universe, profile="standard"):
        used.append(round(float(betas["BTCUSDT"]), 12))
        return real_hedged(tranches, five_min, settlements, betas, universe, profile)

    monkeypatch.setattr(natives, "estimate_betas", spy)
    monkeypatch.setattr(natives, "beta_hedged_daily", spy_hedged)
    r = _retest("s2", tr, panel, summary, span_start=start)

    in_span = [t for t in tr if start <= t.entry_ms < SPAN_END]
    t0 = np.array([t.entry_ms for t in in_span])
    t1 = np.array([t.exit_ms for t in in_span])
    splits = list(panel_cpcv_splits(t0, t1, 6, 2, embargo))
    cpcv_calls = [c for c in beta_calls if not c[1]]  # the walk-forward calls pass start_ms and end_ms
    assert len(cpcv_calls) == len(splits) == 15
    expected_betas = []
    for (train_idx, _tests), (days, _kw) in zip(splits, cpcv_calls, strict=True):
        want_days = sorted({(int(t) // DAY_MS) * DAY_MS for t in t0[train_idx]})
        assert list(days) == want_days  # the betas come from the split's own training days
        # Build the expected beta of that split the same way.
        five_min_days = list(range(PANEL_START, PANEL_END + DAY_MS, DAY_MS))
        dr = daily_close_log_returns({s: panel[s]["5m"] for s in panel}, five_min_days, list(panel))
        beta = float(real_beta(dr.loc[dr.index.isin(want_days)])["BTCUSDT"])
        assert np.isfinite(beta)
        expected_betas.append(round(beta, 12))
    # Every CPCV pricing call (after the 3 walk-forward folds and the stress/jackknife calls) used one of them.
    assert set(expected_betas) <= set(used)
    assert r["item1"]["cpcv"]["n_splits"] == 15
    assert len(r["item1"]["cpcv"]["path_means"]) == 5
    assert r["item1"]["cpcv"]["positive_paths"] == sum(1 for m in r["item1"]["cpcv"]["path_means"] if m > 0)
    assert r["item1"]["cpcv"]["min_positive_required"] == 4


def test_retest_joint_shift_unavailable_with_stops(tmp_path, panel):
    rows = _random_rows(panel, "v8-1h", 60, 10, SPAN_START, SPAN_END - 2 * DAY_MS, hold=4 * HOUR)
    for i in range(3):
        rows.append(_row(panel, "v8-1h", UNIVERSE[i], 1, SPAN_START + (5 + i) * DAY_MS, 2 * HOUR, "stop"))
    tr, summary, _ = _tranches(tmp_path, panel, "v8-1h", rows)
    assert sum(1 for t in tr if t.exit_reason == "stop") == 3
    r = _retest("v8-1h", tr, panel, summary)

    js = r["item4"]["joint_shift"]
    assert js["status"] == "unavailable"
    assert "stop" in js["reason"] and "replay" in js["reason"]
    row = next(x for x in r["hurdles"] if x["test"] == "joint_shift_null")
    assert row["status"] == "unavailable" and "pass" not in row
    assert r["fully_assessed"] is False


def test_summarise_hurdles_never_counts_unavailable_as_passed():
    rows = [
        {"item": 1, "test": "a", "status": "applied", "pass": True},
        {"item": 3, "test": "b", "status": "applied", "pass": True},
        {"item": 4, "test": "c", "status": "unavailable", "reason": "no replay"},
        {"item": 2, "test": "d", "status": "not applicable", "reason": "one rule"},
    ]
    out = summarise_hurdles(rows)
    assert out["pass"] is True  # every APPLIED hurdle passes
    assert out["hurdles_passed"] == ["a", "b"]
    assert out["hurdles_unavailable"] == ["c"] and out["hurdles_not_applicable"] == ["d"]
    assert out["hurdles_failed"] == [] and out["fully_assessed"] is False
    rows[1] = {**rows[1], "pass": False}
    assert summarise_hurdles(rows)["pass"] is False
    assert summarise_hurdles(rows)["hurdles_failed"] == ["b"]
    # With nothing applied there is nothing to pass.
    assert summarise_hurdles(rows[2:])["pass"] is False


def test_retest_applicability_never_passes_unavailable(tmp_path, panel):
    rows = _random_rows(panel, "v8-4h", 50, 12, SPAN_START, SPAN_END - 3 * DAY_MS, hold=4 * HOUR)
    rows.append(_row(panel, "v8-4h", "BTCUSDT", 1, SPAN_START + 4 * DAY_MS, 2 * HOUR, "stop"))
    tr, summary, _ = _tranches(tmp_path, panel, "v8-4h", rows)
    r = _retest("v8-4h", tr, panel, summary)

    table = {(x["item"], x["test"]): x for x in r["hurdles"]}
    assert {k[0] for k in table} == {1, 2, 3, 4, 5, 6}
    assert all(x["status"] in ("applied", "not applicable", "unavailable") for x in r["hurdles"])
    assert all(("reason" in x) == (x["status"] != "applied") for x in r["hurdles"])
    assert table[(2, "pbo")]["status"] == "not applicable"
    assert table[(4, "spa")]["status"] == "not applicable"
    assert table[(4, "label_shift_tripwire")]["status"] == "not applicable"
    assert "fixed rule" in table[(4, "label_shift_tripwire")]["reason"]
    assert table[(6, "maker_as_taker")]["status"] == "not applicable"
    assert table[(4, "joint_shift_null")]["status"] == "unavailable"
    for x in r["hurdles"]:
        if x["status"] != "applied":
            assert x["test"] not in r["hurdles_passed"]
    applied = [x for x in r["hurdles"] if x["status"] == "applied"]
    assert r["pass"] == (bool(applied) and all(x["pass"] for x in applied))
    assert r["fully_assessed"] is False


def test_retest_rv_uses_jackknife(tmp_path, panel):
    rows = _random_rows(panel, "rv-v1", 80, 13, SPAN_START, SPAN_END - 2 * DAY_MS, hold=8 * HOUR)
    tr, summary, _ = _tranches(tmp_path, panel, "rv-v1", rows)
    r = _retest("rv-v1", tr, panel, summary)
    assert r["item5"]["rule"] == "jackknife"
    assert set(r["item5"]["jackknife_means"]) == set(UNIVERSE)
    assert r["item5"]["jackknife_total"] == 10

    rows = _random_rows(panel, "s1", 80, 13, SPAN_START, SPAN_END - 2 * DAY_MS, hold=8 * HOUR)
    tr, summary, _ = _tranches(tmp_path, panel, "s1", rows, "other")
    r2 = _retest("s1", tr, panel, summary)
    assert r2["item5"]["rule"] == "coin_count" and r2["item5"]["min_required"] == 7
    assert len(r2["item5"]["coin_means"]) == 10


def test_retest_end_to_end_synthetic(tmp_path, panel):
    receipts = {}
    for k, rule in enumerate(("s1", "s2", "c1")):
        rows = _random_rows(panel, rule, 150, 20 + k, SPAN_START, SPAN_END - 2 * DAY_MS, hold=6 * HOUR)
        tr, summary, _ = _tranches(tmp_path, panel, rule, rows, rule)
        receipts[rule] = evaluate_retest(
            rule,
            tr,
            panel,
            0.01,
            summary=summary,
            dataset_hash=DATASET_HASH,
            commit=COMMIT,
            span_start=SPAN_START,
            span_end=SPAN_END,
        )
    r = receipts["s1"]
    assert r["kind"] == "retest" and r["rule"] == "s1" and r["commit"] == COMMIT
    assert r["dataset_hash"] == DATASET_HASH
    assert len(r["export_summary_sha256"]) == 64 and len(r["source_sha256"]) == 64
    assert r["item3"]["phase4_reread"] is True
    assert r["item3"]["num_trials"] == 120 and r["item3"]["program_trials"] == 2204 + 120
    assert "dsr_prob_program" in r["item3"]
    assert r["item4"]["joint_shift"]["status"] == "applied"
    assert r["item4"]["joint_shift"]["draws"] == 1000
    assert r["item4"]["label_shift_tripwire"].startswith("not applicable")
    assert r["item6"]["stress_cost"] is not None
    assert r["item6"]["maker_as_taker"]["status"] == "not applicable"
    assert r["item2"]["status"] == "not applicable"
    json.dumps(r, allow_nan=False)  # complete and strict JSON
    # On noise with native costs the rule fails: the prediction "fails" holds for every rule.
    assert all(x["pass"] is False for x in receipts.values())
    assert all(x["fully_assessed"] is True for x in receipts.values())

    fam = retest_family_spa(receipts)
    assert fam["reported_only"] is True and fam["n_rules"] == 3
    assert fam["pbo"].startswith("not applicable") and "selection family" in fam["pbo"]
    assert 0.0 <= fam["spa_p"] <= 1.0
    assert fam["common_span"]["start_ms"] == SPAN_START
    json.dumps(fam, allow_nan=False)


def test_retest_run_and_cli(tmp_path, panel, monkeypatch):
    ds = write_synthetic_dataset(panel, tmp_path / "ds")
    manifest_hash = json.loads((ds / "manifest.json").read_text())["datasetHash"]
    rows = _random_rows(panel, "s1", 60, 31, SPAN_START, SPAN_END - 2 * DAY_MS, hold=6 * HOUR)
    exp = _write_export(tmp_path, rows, _summary("s1", 60, hash_=manifest_hash))
    out = tmp_path / "out"
    import r4.cli as cli

    monkeypatch.setattr(natives, "WF_SPAN", (SPAN_START, SPAN_END))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "r4.cli",
            "retest",
            "--export",
            str(exp),
            "--ds",
            str(ds),
            "--calib-v",
            "0.01",
            "--out",
            str(out),
            "--commit",
            COMMIT,
        ],
    )
    cli.main()
    receipt = json.loads((out / "s1" / "receipt.json").read_text())
    assert receipt["kind"] == "retest" and receipt["dataset_hash"] == manifest_hash
    assert receipt["commit"] == COMMIT and receipt["calib_v"] == 0.01
