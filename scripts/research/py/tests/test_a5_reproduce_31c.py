"""Brief 31c (Amendment 5, A5.1): the reproduction driver's pure parts, on synthetic files (no D)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from r4 import reproduce as rp

A5_RUNS = [
    "noise_00_ridge_C1_s1",
    "noise_12_lgbm_C2_s1",
    "noise_22_lgbmtb_C4_s1",
    "noise_28_logit_C4_s1_alt2",
    "noise_30_noref_C2_s1",
    "noise_36_d_C4_s1",
    "exit_0_E2_noise_06_ridge_C4_s1",
    "exit_3_E5_noise_06_ridge_C4_s1",
]


def _run(path: Path, *, tranches: bytes = b"t", receipt: dict | None = None) -> Path:
    path.mkdir(parents=True)
    (path / "tranches.parquet").write_bytes(tranches)
    (path / "daily.parquet").write_bytes(b"d")
    (path / "folds.json").write_text("[]", encoding="utf-8")
    (path / "receipt.json").write_text(json.dumps(receipt or {"a": 1}), encoding="utf-8")
    return path


def test_the_eight_runs_are_the_amendments_list_in_order():
    assert list(rp.REPRODUCED_RUNS) == A5_RUNS


def test_the_registry_holds_all_eight_configs():
    assert list(rp.registered_configs()) == A5_RUNS


def test_an_existing_out_dir_is_refused(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(FileExistsError):
        rp.reproduce(tmp_path, tmp_path, out, "abcdef1")


def _baseline(tmp_path: Path) -> tuple[Path, Path]:
    c4 = tmp_path / "c4"
    (c4 / "exits").mkdir(parents=True)
    files = {"noise_eval.json": b"n", "exits/exit_block.json": b"e"}
    for rel, data in files.items():
        (c4 / rel).write_bytes(data)
    ref = {f"~/round4-out/phase4-c4/d/{rel}": hashlib.sha256(d).hexdigest() for rel, d in files.items()}
    record = tmp_path / "record.json"
    record.write_text(json.dumps({"c4_reference_files_sha256": ref}), encoding="utf-8")
    return c4, record


def test_a_correct_baseline_passes_the_check(tmp_path):
    c4, record = _baseline(tmp_path)
    res = rp.authenticate_baseline(c4, record)
    assert res["files_checked"] == 2 and len(res["record_sha256"]) == 64


def test_a_tampered_reference_file_stops_reproduce_before_any_run(tmp_path):
    c4, record = _baseline(tmp_path)
    (c4 / "noise_eval.json").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="noise_eval.json"):
        rp.reproduce(tmp_path, c4, tmp_path / "out", "abcdef1", record)
    assert not (tmp_path / "out").exists()


def test_a_missing_reference_file_is_refused(tmp_path):
    c4, record = _baseline(tmp_path)
    (c4 / "exits" / "exit_block.json").unlink()
    with pytest.raises(ValueError, match="exit_block.json"):
        rp.authenticate_baseline(c4, record)


def test_the_real_record_is_found_beside_the_package():
    assert rp.GATE_P_RECORD.is_file()


def test_strip_removes_the_three_keys_at_any_depth():
    doc = {"commit": "x", "source_sha256": "y", "runtime_s": 1, "k": [{"commit": "z", "v": 2}], "n": {"runtime_s": 3}}
    assert rp.strip(doc) == {"k": [{"v": 2}], "n": {}}


def test_receipt_differing_only_in_stripped_keys_matches(tmp_path):
    old = _run(tmp_path / "old", receipt={"a": 1, "commit": "c4", "metrics": {"runtime_s": 9}})
    new = _run(tmp_path / "new", receipt={"a": 1, "commit": "c5", "metrics": {"runtime_s": 1}})
    res = rp.compare_run_files(old, new)
    assert res["receipt"]["match"] and all(f["match"] for f in res["files"].values())


def test_one_differing_file_or_receipt_value_is_a_mismatch(tmp_path):
    old = _run(tmp_path / "old")
    assert not rp.compare_run_files(old, _run(tmp_path / "n1", tranches=b"x"))["files"]["tranches.parquet"]["match"]
    assert not rp.compare_run_files(old, _run(tmp_path / "n2", receipt={"a": 2}))["receipt"]["match"]


def _entry(files_ok: bool = True, receipt_ok: bool = True, joint_ok: bool = True) -> dict:
    return {
        "files": {"tranches.parquet": {"match": files_ok}},
        "receipt": {"match": receipt_ok},
        "joint_shift": {"match": joint_ok},
    }


def test_all_match_needs_every_comparison_of_all_eight_runs():
    full = {i: _entry() for i in A5_RUNS}
    assert rp.all_match(full)
    for bad in (_entry(files_ok=False), _entry(receipt_ok=False), _entry(joint_ok=False)):
        assert not rp.all_match({**full, A5_RUNS[3]: bad})
    assert not rp.all_match({i: _entry() for i in A5_RUNS[:7]})


def test_joint_shift_comparison_is_exact():
    c4 = {"p": 0.5, "seed": 1, "draws": 1000, "drop_share": 0.0, "observed": 1.25}
    assert rp.compare_joint(c4, dict(c4))["match"]
    assert not rp.compare_joint(c4, {**c4, "p": 0.5000000000000001})["match"]
    assert rp.compare_joint({**c4, "observed": None}, {**c4, "observed": None})["match"]


def test_a_joint_key_on_one_side_only_is_a_mismatch():
    c4 = {"p": 0.5, "seed": 1}
    assert not rp.compare_joint(c4, {**c4, "extra": 1})["match"]
    assert not rp.compare_joint({**c4, "extra": None}, c4)["match"]
