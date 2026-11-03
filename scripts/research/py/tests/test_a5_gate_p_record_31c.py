"""Brief 31c (Amendment 5, A5.4): the Gate P record of the C4 re-run parses and carries each required item."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

RECORD = Path(__file__).resolve().parents[1] / "records" / "gate_p_c4.json"
_HEX64 = re.compile(r"[0-9a-f]{64}")
RUN_IDS = (
    "noise_00_ridge_C1_s1",
    "noise_12_lgbm_C2_s1",
    "noise_22_lgbmtb_C4_s1",
    "noise_28_logit_C4_s1_alt2",
    "noise_30_noref_C2_s1",
    "noise_36_d_C4_s1",
    "exit_0_E2_noise_06_ridge_C4_s1",
    "exit_3_E5_noise_06_ridge_C4_s1",
)


@pytest.fixture(scope="module")
def record() -> dict:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def test_decision_and_c4_block(record):
    assert record["decision"] == "PASS WITH CONDITIONS"
    assert record["c4"]["commit"] == "dfe1ebf51794011b5ef7bd9c31e32d908bd19ec5"
    assert record["c4"]["r4_source_sha256"] == "de431740038ba19982ea24fa02940bdb724a6afdea7e8185c0d5507ed9217882"


def test_conditions_are_met_by_the_named_sections(record):
    by_id = {c["id"]: c for c in record["conditions"]}
    assert sorted(by_id) == ["C1", "C2", "C3", "codex-1"]
    for cid, section in (("C1", "A5.4"), ("C2", "A5.1"), ("C3", "A5.2"), ("codex-1", "A5.3")):
        met_by = by_id[cid]["met_by"]
        assert met_by.strip() and section in met_by, cid


def test_disclosures_cover_the_sources(record):
    texts = {d["source"]: d["text"] for d in record["disclosures"]}
    wanted = [f"C4 review finding {n}" for n in (2, 5, 6, 7, 8, 9, 10, 14)]
    wanted += [f"First review finding {n} at C4" for n in (3, 4, 6, 9, 11)]
    for source in wanted:
        assert texts.get(source, "").strip(), source


def test_c1_carry_analysis_is_present(record):
    assert str(record["c1_carry_analysis"]).strip()


def test_predictions_and_gated_ones_as_predicted(record):
    preds = record["predictions"]
    assert len(preds) == 15
    gated = [p for p in preds if p["status"] == "gated"]
    assert len(gated) == 8
    assert all(p["as_predicted"] is True for p in gated)


def test_file_digests_are_sha256_hex(record):
    for key in ("untracked_files_sha256", "c4_reference_files_sha256"):
        assert record[key], key
        assert all(_HEX64.fullmatch(v) for v in record[key].values()), key


def test_reference_map_covers_the_eight_runs(record):
    ref = record["c4_reference_files_sha256"]
    assert len(ref) == 35
    for run_id in RUN_IDS:
        for name in ("tranches.parquet", "daily.parquet", "folds.json", "receipt.json"):
            assert sum(k.endswith(f"/{run_id}/{name}") for k in ref) == 1, (run_id, name)
    for tail in ("noise_eval.json", "exits/exit_block.json", "dossier.json"):
        assert sum(k.endswith(tail) for k in ref) == 1, tail
