"""The Phase 4 registration (A1.9): the committed synthetic V record binds the registered noise constants.

records/synth_v_81e3c5b0.json is calib-synth-v's output at 81e3c5b0 (the V panel at seed 3,999 and the reference
panels at 3,997 and 3,998). NOISE_REPLACEMENTS, NOISE_V_EXCLUDED and REFERENCE_PANEL_REJECTIONS must be exactly what
it records, and the synthetic values Amendment 2 states must recompute from it.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from r4 import bar
from r4 import calibration as cal
from r4.cli import config_hash_of
from r4.stats import expected_max_sharpe

RECORD = Path(__file__).resolve().parents[1] / "records" / "synth_v_81e3c5b0.json"


def _record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def test_record_is_the_81e3c5b0_run_on_the_registered_panels():
    rec = _record()
    assert str(rec["commit"]).startswith("81e3c5b0")
    assert rec["panel_seeds"] == {"v": cal.SYNTH_V_SEED, "reference": list(cal.REFERENCE_PANEL_SEEDS)}


def test_record_noise_set_is_the_registered_final_set():
    rows = _record()["noise_set"]
    want = {(c["id"], config_hash_of(c), c.get("replaces"), c.get("attempt")) for c in cal.noise_final_set()}
    got = {(r["id"], r["config_hash"], r["replaces"], r["attempt"]) for r in rows}
    assert len(rows) == 40
    assert got == want
    cal._check_noise_set({"noise_set": rows})


def test_noise_replacements_are_the_recorded_trade_floor_failures():
    floor = _record()["trade_floor"]
    replaced = {k: v for k, v in floor.items() if v["final_id"] != k}
    assert {k: int(v["final_id"].rsplit("_alt", 1)[1]) for k, v in replaced.items()} == cal.NOISE_REPLACEMENTS
    for k, v in floor.items():
        # A1.9: a replaced control failed at every attempt before its final one, and attempt 2 is kept even if it fails.
        assert [a["ok"] for a in v["attempts"][:-1]] == [False] * (len(v["attempts"]) - 1), k
        assert v["trade_floor_failed"] is (not v["attempts"][-1]["ok"]), k


def test_v_excluded_are_the_recorded_floor_failures():
    floor = _record()["trade_floor"]
    assert {v["final_id"] for v in floor.values() if v["trade_floor_failed"]} == set(cal.NOISE_V_EXCLUDED)


def test_amendment_2_synthetic_values_recompute_from_the_record():
    # A2.1 states the V panel's within-cell V and SR0 over the 36 controls left after NOISE_V_EXCLUDED, and the
    # all-40 values it replaces. Both recompute from the recorded per-config Sharpes with bar's within-cell rule.
    rec = _record()
    sharpes = rec["variance"]["sharpes"]
    cfg = {c["id"]: c for c in cal.noise_final_set()}

    def within(ids):
        cells: dict = {}
        for i in sorted(ids):
            cells.setdefault(bar.cell_key(cfg[i]), []).append(sharpes[i])
        used = [np.asarray(v) for v in cells.values() if len(v) >= 2]
        return sum(float(np.sum((v - v.mean()) ** 2)) for v in used) / sum(len(v) - 1 for v in used), sum(
            len(v) - 1 for v in used
        )

    v_all, df_all = within(sharpes)
    assert v_all == pytest.approx(rec["variance"]["within_cell"]["V"], rel=1e-12)
    assert df_all == rec["variance"]["within_cell"]["df"] == 29
    v_a2, df_a2 = within(set(sharpes) - set(cal.NOISE_V_EXCLUDED))
    assert (round(v_a2, 4), df_a2) == (0.0060, 25)
    assert round(expected_max_sharpe(cal.N_TRIALS_CALIBRATION, v_a2), 2) == 0.20
    assert (round(v_all, 4), round(expected_max_sharpe(cal.N_TRIALS_CALIBRATION, v_all), 2)) == (0.0310, 0.46)


def test_production_v_exclusion_reproduces_amendment_2_on_the_record():
    # The code path evaluate_noise uses (_v_run_ids, then bar.trial_sharpe_variance), on daily series built to carry
    # each final control's recorded Sharpe exactly: a fixed standardized vector (mean 0, sd 1) plus that Sharpe.
    rec = _record()
    sharpes = rec["variance"]["sharpes"]
    z = np.random.default_rng(20261030).normal(size=400)
    z = (z - z.mean()) / z.std(ddof=1)
    runs = {}
    for c in cal.noise_final_set():
        daily = pd.DataFrame({"drift_free": z + sharpes[c["id"]]})
        daily.attrs["config_hash"] = config_hash_of(c)
        runs[c["id"]] = {"receipt": {"config": c}, "daily": daily}
    v_ids = cal._v_run_ids(runs)
    assert sorted(set(runs) - set(v_ids)) == sorted(cal.NOISE_V_EXCLUDED)

    def v_over(ids):
        res = bar.trial_sharpe_variance(
            {i: runs[i]["daily"] for i in ids}, {i: runs[i]["receipt"]["config"] for i in ids}
        )
        return res["V"], res["df"]

    v_a2, df_a2 = v_over(v_ids)
    v_all, df_all = v_over(sorted(runs))
    assert v_all == pytest.approx(rec["variance"]["within_cell"]["V"], rel=1e-9)
    assert (round(v_a2, 4), df_a2, df_all) == (0.0060, 25, 29)


def test_reference_panel_rejections_are_the_recorded_counts():
    panels = _record()["reference_panels"]
    assert [p["seed"] for p in panels] == list(cal.REFERENCE_PANEL_SEEDS)
    assert all(p["draws"] == 1000 for p in panels)
    assert cal.REFERENCE_PANEL_REJECTIONS == tuple(int(p["n_reject_05"]) for p in panels)
