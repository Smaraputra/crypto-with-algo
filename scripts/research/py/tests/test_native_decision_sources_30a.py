"""Brief 30a (Amendment 3): re-tests read registered decision sources (the dossier binding is in the 30b file)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

import r4.natives as natives
from r4.method import UNIVERSE
from r4.natives import NATIVE_DECISION_SOURCES, NATIVE_RULES, decision_source, read_export
from r4.synth import synth_panel, write_synthetic_dataset
from tests.test_calibration_power import DS_HASH
from tests.test_natives import (
    COMMIT,
    DATASET_HASH,
    PANEL_END,
    PANEL_START,
    SPAN_END,
    SPAN_START,
    _random_rows,
    _summary,
    _write_export,
)

OTHER = "f" * 64
REGISTERED = {
    "rv-v1": "bc3566f4c6c6b0fe09e0c6984fca4aa8ba4f4c3a3fe8837826aad57f9c4137c8",
    "c1": "414fef1ee6ccf45fcb6e6a7e25ad8a5c3a3ea24176b40cfd7158e8cf2a906e5f",
    "v8-1h": "48ff79609080f11a48c45822f27cd609818b913b2d42455cddf4ea1ef4806e93",
    "v8-4h": "48ff79609080f11a48c45822f27cd609818b913b2d42455cddf4ea1ef4806e93",
}


@pytest.fixture(scope="module")
def panel() -> dict[str, dict[str, pd.DataFrame]]:
    k = len(UNIVERSE)
    cov = 0.0009 * (0.4 + 0.6 * np.eye(k))
    return synth_panel(cov, UNIVERSE, PANEL_START, PANEL_END, seed=11)


# -- the registry and the reader ---------------------------------------------------------------------------------


def test_decision_source_registry():
    assert NATIVE_DECISION_SOURCES == REGISTERED
    assert set(NATIVE_DECISION_SOURCES) <= set(NATIVE_RULES)
    for rule in NATIVE_RULES:
        assert decision_source(rule, DS_HASH) == REGISTERED.get(rule, DS_HASH)


def _export(tmp_path: Path, panel, rule: str, hash_: str, name: str = "exp") -> Path:
    rows = _random_rows(panel, rule, 3, 3, SPAN_START, SPAN_START + 86_400_000, hold=3_600_000)
    return _write_export(tmp_path, rows, _summary(rule, 3, hash_=hash_), name)


def test_read_export_accepts_the_registered_source_of_a_listed_rule(tmp_path, panel):
    d = _export(tmp_path, panel, "c1", REGISTERED["c1"])
    _, summary, _ = read_export(d, DS_HASH)
    assert summary["manifest_hash"] == REGISTERED["c1"]


def test_read_export_refuses_a_listed_rule_on_d(tmp_path, panel):
    d = _export(tmp_path, panel, "c1", DS_HASH)
    with pytest.raises(ValueError, match="c1") as err:
        read_export(d, DS_HASH)
    assert REGISTERED["c1"] in str(err.value) and DS_HASH in str(err.value)


def test_read_export_unlisted_rule_requires_d(tmp_path, panel):
    read_export(_export(tmp_path, panel, "s1", DS_HASH), DS_HASH)
    with pytest.raises(ValueError, match="s1") as err:
        read_export(_export(tmp_path, panel, "s1", OTHER, "other"), DS_HASH)
    assert OTHER in str(err.value) and DS_HASH in str(err.value)
    with pytest.raises(ValueError, match="s1"):
        read_export(_export(tmp_path, panel, "s1", REGISTERED["c1"], "reg"), DS_HASH)


def test_run_retest_receipt_carries_the_decision_source(tmp_path, panel, monkeypatch):
    ds = write_synthetic_dataset(panel, tmp_path / "ds")
    d_hash = json.loads((ds / "manifest.json").read_text())["datasetHash"]
    monkeypatch.setattr(natives, "WF_SPAN", (SPAN_START, SPAN_END))
    rows = _random_rows(panel, "s1", 60, 31, SPAN_START, SPAN_END - 2 * 86_400_000, hold=6 * 3_600_000)
    exp = _write_export(tmp_path, rows, _summary("s1", 60, hash_=d_hash))
    receipt = natives.run_retest(exp, ds, 0.01, tmp_path / "out", commit=COMMIT, n_draws=50)
    assert receipt["dataset_hash"] == d_hash and receipt["decision_dataset_hash"] == d_hash
    keys = list(receipt)
    assert keys.index("decision_dataset_hash") == keys.index("dataset_hash") + 1
    # A listed rule: the book prices on D and the decision source is the registered one.
    rows = _random_rows(panel, "c1", 60, 32, SPAN_START, SPAN_END - 2 * 86_400_000, hold=6 * 3_600_000)
    exp = _write_export(tmp_path, rows, _summary("c1", 60, hash_=REGISTERED["c1"]), "c1exp")
    receipt = natives.run_retest(exp, ds, 0.01, tmp_path / "out", commit=COMMIT, n_draws=50)
    assert receipt["dataset_hash"] == d_hash and receipt["decision_dataset_hash"] == REGISTERED["c1"]


def test_evaluate_retest_decision_hash(tmp_path, panel):
    rows = _random_rows(panel, "c1", 40, 5, SPAN_START, SPAN_END - 2 * 86_400_000, hold=6 * 3_600_000)
    d = _write_export(tmp_path, rows, _summary("c1", 40, hash_=REGISTERED["c1"]))
    tr, summary, dropped = read_export(d, DATASET_HASH)
    kw: dict[str, Any] = {
        "summary": summary,
        "dropped": dropped,
        "dataset_hash": DATASET_HASH,
        "commit": COMMIT,
        "span_start": SPAN_START,
        "span_end": SPAN_END,
        "n_draws": 50,
    }
    r = natives.evaluate_retest("c1", tr, panel, 0.01, decision_dataset_hash=REGISTERED["c1"], **kw)
    assert r["decision_dataset_hash"] == REGISTERED["c1"] and r["dataset_hash"] == DATASET_HASH
    with pytest.raises(ValueError, match="decision_dataset_hash"):
        natives.evaluate_retest("c1", tr, panel, 0.01, **kw)
    with pytest.raises(ValueError, match="decision_dataset_hash"):
        natives.evaluate_retest("c1", tr, panel, 0.01, decision_dataset_hash=OTHER, **kw)
