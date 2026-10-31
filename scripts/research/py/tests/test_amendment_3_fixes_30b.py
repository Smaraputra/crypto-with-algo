"""Brief 30b (Amendment 3 review fixes): the dossier binds the re-test code to a registered tree, and the exports."""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

import r4.cli
import r4.natives as natives
from r4 import calibration as cal
from r4.method import UNIVERSE
from r4.natives import (
    NATIVE_DECISION_SOURCES,
    RV_V1_RESOLUTIONS_SHA256,
    decision_source,
    evaluate_retest,
    read_export,
)
from r4.synth import synth_panel, write_synthetic_dataset
from tests.test_calibration_power import (
    RULES,
    SHA2,
    _commit_order,
    _inputs,
    _noise_eval,
    _retest,
)
from tests.test_natives import (
    COMMIT,
    DATASET_HASH,
    HOUR,
    PANEL_END,
    PANEL_START,
    SPAN_END,
    SPAN_START,
    _random_rows,
    _row,
    _summary,
    _write_export,
)

C3 = "c" * 40
C3_SRC = "e" * 64
OTHER = "f" * 64
FROZEN = SHA2  # the fixtures' frozen commit, standing in for A3_FROZEN_COMMIT through the patch below


@pytest.fixture(scope="module")
def panel() -> dict[str, dict[str, pd.DataFrame]]:
    k = len(UNIVERSE)
    cov = 0.0009 * (0.4 + 0.6 * np.eye(k))
    return synth_panel(cov, UNIVERSE, PANEL_START, PANEL_END, seed=11)


# -- the dossier -----------------------------------------------------------------------------------------------


def _mut(obj: dict[str, Any], fn: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    out = copy.deepcopy(obj)
    fn(out)
    return out


def _code_change(**over: Any) -> dict[str, Any]:
    d: dict[str, Any] = {
        "from": FROZEN,
        "to": C3,
        "to_source_sha256": C3_SRC,
        "is_ancestor": True,
        "files": [
            "scripts/research/py/r4/natives.py",
            "scripts/research/py/r4/calibration.py",
            "scripts/research/py/tests/test_amendment_3_fixes_30b.py",
            "changelogs/CHANGELOG.md",
        ],
    }
    d.update(over)
    return d


def _c3_retest(rule: str, **over: Any) -> dict[str, Any]:
    r = {**_retest(rule), "commit": C3, "source_sha256": C3_SRC}
    r.update(over)
    return r


def _c3_order(**over: Any) -> dict[str, Any]:
    order = _commit_order()
    for rc in order["predictions"]["natives_all_six_fail"]["receipts"]:
        rc["commit"] = C3
    order["code_change"] = _code_change()
    order.update(over)
    return order


def _c3_inputs(tmp: Path, **over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"retests": [_c3_retest(r) for r in RULES], "commit_order": _c3_order()}
    base.update(over)
    return _inputs(tmp, **base)


def _repro(source: str) -> Callable[[], dict[str, Any]]:
    def reproduction_inputs() -> dict[str, Any]:
        return {"source_sha256": source, "requirements_lock_sha256": "d" * 64, "versions": {"python": "3.13.0"}}

    return reproduction_inputs


@pytest.fixture
def a3(monkeypatch):
    """The fixtures' frozen commit stands in for 5250b8ea, and the dossier run is a clean checkout of C3."""
    monkeypatch.setattr(cal, "A3_FROZEN_COMMIT", FROZEN)
    monkeypatch.setattr(r4.cli, "reproduction_inputs", _repro(C3_SRC))


def test_single_commit_dossier_accepted_without_code_change(tmp_path):
    doc = cal.write_dossier(tmp_path / "d.json", **_inputs(tmp_path))
    assert doc["gate_p_ready"] is True
    assert doc["code_change"] is None and doc["retest_commit"] == SHA2
    assert doc["dossier_reproduction"] == r4.cli.reproduction_inputs()


def test_single_commit_dossier_refuses_a_code_change(tmp_path, a3):
    order = _mut(_commit_order(), lambda o: o.__setitem__("code_change", _code_change()))
    with pytest.raises(ValueError, match="did not move"):
        cal.write_dossier(tmp_path / "x.json", **_inputs(tmp_path, commit_order=order))


def test_second_commit_dossier_accepted(tmp_path, a3):
    doc = cal.write_dossier(tmp_path / "d.json", **_c3_inputs(tmp_path))
    assert doc["gate_p_ready"] is True
    assert doc["retest_commit"] == C3
    assert doc["code_change"] == _code_change()
    assert doc["dossier_reproduction"]["source_sha256"] == C3_SRC
    sources = {s["rule"]: s for s in doc["retest_sources"]}
    assert set(sources) == set(RULES)
    assert sources["rv-v1"]["decision_dataset_hash"] == NATIVE_DECISION_SOURCES["rv-v1"]
    assert sources["s1"]["decision_dataset_hash"] == _retest("s1")["dataset_hash"]
    assert all(s["dataset_hash"] == _retest(s["rule"])["dataset_hash"] for s in sources.values())


def test_short_receipt_commit_binds_by_prefix_to_a_full_to(tmp_path, a3):
    retests = [_c3_retest(r, commit=C3[:9]) for r in RULES]
    order = _c3_order()
    for rc in order["predictions"]["natives_all_six_fail"]["receipts"]:
        rc["commit"] = C3[:9]
    cal.write_dossier(tmp_path / "d.json", **_c3_inputs(tmp_path, retests=retests, commit_order=order))


def _c3_cases() -> dict[str, tuple[dict[str, Any], str]]:
    rts = [_c3_retest(r) for r in RULES]
    dirty = [{**_retest(r), "source_sha256": OTHER} for r in RULES]
    frozen_order = _mut(_c3_order(), lambda o: None)
    for rc in frozen_order["predictions"]["natives_all_six_fail"]["receipts"]:
        rc["commit"] = SHA2
    path_case = lambda f: (  # noqa: E731
        {"commit_order": _c3_order(code_change=_code_change(files=[f]))},
        "normalised relative path",
    )
    return {
        "second commit with no code_change": (
            {"commit_order": _mut(_c3_order(), lambda o: o.pop("code_change"))},
            "no code_change is recorded",
        ),
        "code_change.from not the frozen commit": (
            {"commit_order": _c3_order(code_change=_code_change(**{"from": "d" * 40}))},
            "is not the frozen commit",
        ),
        "code_change.from a short sha": (
            {"commit_order": _c3_order(code_change=_code_change(**{"from": FROZEN[:7]}))},
            "40 character",
        ),
        "code_change.to a short sha": (
            {"commit_order": _c3_order(code_change=_code_change(to=C3[:7]))},
            "40 character",
        ),
        "code_change.from not hex": (
            {"commit_order": _c3_order(code_change=_code_change(**{"from": "XYZ"}))},
            "40 character",
        ),
        "from and to the same commit": (
            {"commit_order": _c3_order(code_change=_code_change(to=FROZEN))},
            "must be different commits",
        ),
        "code_change.to not the retest commit": (
            {"commit_order": _c3_order(code_change=_code_change(to="d" * 40))},
            "is not the re-test commit",
        ),
        "retest digest is not to_source_sha256": (
            {"commit_order": _c3_order(code_change=_code_change(to_source_sha256=OTHER))},
            "is not code_change.to_source_sha256",
        ),
        "to_source_sha256 missing": (
            {"commit_order": _c3_order(code_change=_mut(_code_change(), lambda o: o.pop("to_source_sha256")))},
            "to_source_sha256 must be",
        ),
        "to_source_sha256 too short": (
            {"commit_order": _c3_order(code_change=_code_change(to_source_sha256=C3_SRC[:40]))},
            "to_source_sha256 must be",
        ),
        "is_ancestor false": (
            {"commit_order": _c3_order(code_change=_code_change(is_ancestor=False))},
            "is_ancestor must be true",
        ),
        "is_ancestor not a bool": (
            {"commit_order": _c3_order(code_change=_code_change(is_ancestor="yes"))},
            "is_ancestor must be true",
        ),
        "file outside the list": (
            {
                "commit_order": _c3_order(
                    code_change=_code_change(
                        files=["scripts/research/py/r4/natives.py", "scripts/research/py/r4/bar.py"]
                    )
                )
            },
            "outside the Amendment 3 list",
        ),
        "no files": ({"commit_order": _c3_order(code_change=_code_change(files=[]))}, "non-empty list"),
        "dotdot path": path_case("scripts/research/py/tests/../r4/bar.py"),
        "leading slash": path_case("/scripts/research/py/r4/natives.py"),
        "backslash path": path_case("scripts\\research\\py\\r4\\natives.py"),
        "dot segment": path_case("scripts/research/py/./r4/natives.py"),
        "trailing slash": path_case("scripts/research/py/tests/"),
        "duplicate file": (
            {
                "commit_order": _c3_order(
                    code_change=_code_change(files=["changelogs/CHANGELOG.md", "changelogs/CHANGELOG.md"])
                )
            },
            "lists a path twice",
        ),
        "code_change not an object": ({"commit_order": _c3_order(code_change=[1])}, "must be an object"),
        "retest with another lock": (
            {"retests": [_mut(rts[0], lambda o: o.__setitem__("requirements_lock_sha256", OTHER)), *rts[1:]]},
            "requirements_lock_sha256",
        ),
        "retest with other versions": (
            {"retests": [_mut(rts[0], lambda o: o["versions"].__setitem__("numpy", "9.9.9")), *rts[1:]]},
            "versions",
        ),
        "retests at two commits": (
            {"retests": [_mut(rts[0], lambda o: o.__setitem__("commit", "d" * 40)), *rts[1:]]},
            "share one commits",
        ),
        "retests with two source digests": (
            {"retests": [_mut(rts[0], lambda o: o.__setitem__("source_sha256", OTHER)), *rts[1:]]},
            "share one source_sha256",
        ),
        "dirty tree at the frozen commit with a code_change": (
            {"retests": dirty, "commit_order": _mut(frozen_order, lambda o: None)},
            "tree was not clean",
        ),
        "dirty tree at the frozen commit without a code_change": (
            {"retests": dirty, "commit_order": _mut(frozen_order, lambda o: o.pop("code_change"))},
            "tree was not clean",
        ),
        "retest not on its registered source": (
            {
                "retests": [
                    _mut(rts[0], lambda o: o.__setitem__("decision_dataset_hash", rts[1]["dataset_hash"])),
                    *rts[1:],
                ]
            },
            "is not its decision source",
        ),
        "unlisted retest on a registered source": (
            {
                "retests": [
                    *rts[:1],
                    _mut(rts[1], lambda o: o.__setitem__("decision_dataset_hash", NATIVE_DECISION_SOURCES["c1"])),
                    *rts[2:],
                ]
            },
            "is not its decision source",
        ),
        "retest without a decision source": (
            {"retests": [_mut(rts[0], lambda o: o.pop("decision_dataset_hash")), *rts[1:]]},
            "decision_dataset_hash",
        ),
        "rule set other than NATIVE_RULES": (
            {"retests": [*rts[:5], _mut(rts[5], lambda o: o.__setitem__("rule", "C1"))]},
            "expected",
        ),
        "non-native prediction listed at the retest commit": (
            {
                "commit_order": _mut(
                    _c3_order(),
                    lambda o: o["predictions"]["noise_items123_at_most_5"]["receipts"][0].__setitem__("commit", C3),
                )
            },
            "not the frozen commit",
        ),
        "native prediction listed at the frozen commit": (
            {
                "commit_order": _mut(
                    _c3_order(),
                    lambda o: o["predictions"]["natives_all_six_fail"]["receipts"][0].__setitem__("commit", SHA2),
                )
            },
            "not the re-test commit",
        ),
        "unknown top-level key in the commit order": ({"commit_order": _c3_order(extra={"x": 1})}, "unknown keys"),
    }


_CASES = _c3_cases()


@pytest.mark.parametrize("label", sorted(_CASES))
def test_dossier_refuses_each_retest_binding(tmp_path, a3, label):
    over, match = _CASES[label]
    sub = tmp_path / "case"
    sub.mkdir()
    with pytest.raises(ValueError, match=match):
        cal.write_dossier(sub / "x.json", **_c3_inputs(sub, **copy.deepcopy(over)))
    assert not (sub / "x.json").exists()


def test_dossier_own_digest_must_be_to_source_sha256(tmp_path, a3, monkeypatch):
    monkeypatch.setattr(r4.cli, "reproduction_inputs", _repro(OTHER))
    with pytest.raises(ValueError, match="dossier's own source digest"):
        cal.write_dossier(tmp_path / "x.json", **_c3_inputs(tmp_path))
    assert not (tmp_path / "x.json").exists()


def test_frozen_inputs_must_be_at_the_amendment_frozen_commit(tmp_path, monkeypatch):
    """Without the patch, A3_FROZEN_COMMIT is 5250b8ea: inputs frozen at another commit cannot take a code_change."""
    monkeypatch.setattr(r4.cli, "reproduction_inputs", _repro(C3_SRC))
    over = {"commit_order": _c3_order(code_change=_code_change(**{"from": cal.A3_FROZEN_COMMIT}))}
    with pytest.raises(ValueError, match="not the Amendment 3 frozen commit"):
        cal.write_dossier(tmp_path / "x.json", **_c3_inputs(tmp_path, **over))


def test_unknown_key_refused_on_the_single_commit_path(tmp_path):
    order = _mut(_commit_order(), lambda o: o.__setitem__("extra", {}))
    with pytest.raises(ValueError, match="extra"):
        cal.write_dossier(tmp_path / "x.json", **_inputs(tmp_path, commit_order=order))


def test_other_inputs_stay_frozen_at_the_frozen_commit(tmp_path, a3):
    """The frozen inputs still share one commit: a re-test commit does not loosen them."""
    ne = _mut(_noise_eval(), lambda o: o["provenance"].__setitem__("commits", [C3]))
    with pytest.raises(ValueError, match="inputs must share one commits"):
        cal.write_dossier(tmp_path / "x.json", **_c3_inputs(tmp_path, noise_eval=ne))


def test_constants_match_the_amendment():
    assert cal.A3_CODE_CHANGE_FILES == frozenset(
        {
            "scripts/research/py/r4/natives.py",
            "scripts/research/py/r4/calibration.py",
            "scripts/research/py/r4/method.py",
            "scripts/research/round4-native-export.ts",
            "scripts/research/round4-native-export.test.ts",
            "changelogs/CHANGELOG.md",
        }
    )
    assert cal.A3_CODE_CHANGE_PREFIXES == ("scripts/research/py/tests/",)
    assert cal.A3_FROZEN_COMMIT == "5250b8eaf30b5bb4cf073bbcb9eb2529fb8b8701"
    assert RV_V1_RESOLUTIONS_SHA256 == "bc4d30b25232a572555c9b09fb00972dab75bdff7c55ba4818d598196f3f0657"
    assert NATIVE_DECISION_SOURCES == {
        "rv-v1": "bc3566f4c6c6b0fe09e0c6984fca4aa8ba4f4c3a3fe8837826aad57f9c4137c8",
        "c1": "414fef1ee6ccf45fcb6e6a7e25ad8a5c3a3ea24176b40cfd7158e8cf2a906e5f",
        "v8-1h": "48ff79609080f11a48c45822f27cd609818b913b2d42455cddf4ea1ef4806e93",
        "v8-4h": "48ff79609080f11a48c45822f27cd609818b913b2d42455cddf4ea1ef4806e93",
    }


# -- the exports: resolutions (F3), export commit (F5), D opens (F11), the DEV_END boundary (F4) -----------------


def _export(tmp_path: Path, panel, rule: str, summary_over: dict[str, Any] | None = None, name: str = "exp") -> Path:
    rows = _random_rows(panel, rule, 5, 3, SPAN_START, SPAN_START + 86_400_000, hold=HOUR)
    summary = {**_summary(rule, 5), **(summary_over or {})}
    return _write_export(tmp_path, rows, summary, name)


def test_rv_export_needs_the_reviewed_resolutions(tmp_path, panel):
    read_export(_export(tmp_path, panel, "rv-v1"), DATASET_HASH)
    other = {"panel": {"resolutions_sha256": OTHER}}
    with pytest.raises(ValueError, match="reviewed resolutions file"):
        read_export(_export(tmp_path, panel, "rv-v1", other, "other"), DATASET_HASH)
    with pytest.raises(ValueError, match="resolutions_sha256 None"):
        read_export(_export(tmp_path, panel, "rv-v1", {"panel": {}}, "empty"), DATASET_HASH)
    bare = _mut(_summary("rv-v1", 5), lambda o: o.pop("panel"))
    d = _write_export(
        tmp_path, _random_rows(panel, "rv-v1", 5, 3, SPAN_START, SPAN_START + 86_400_000, HOUR), bare, "b"
    )
    with pytest.raises(ValueError, match="resolutions_sha256 None"):
        read_export(d, DATASET_HASH)


def _evaluate(rule: str, tmp_path: Path, panel, summary_over: dict[str, Any] | None = None, **kw: Any):
    d = _export(tmp_path, panel, rule, summary_over, f"ev-{rule}-{len(list(tmp_path.iterdir()))}")
    tr, summary, dropped = read_export(d, DATASET_HASH)
    return evaluate_retest(
        rule,
        tr,
        panel,
        0.01,
        summary=summary,
        dropped=dropped,
        dataset_hash=DATASET_HASH,
        decision_dataset_hash=summary["manifest_hash"],
        commit=kw.pop("commit", COMMIT),
        span_start=SPAN_START,
        span_end=SPAN_END,
        n_draws=20,
    )


def test_rv_receipt_records_the_resolutions_sha(tmp_path, panel):
    assert _evaluate("rv-v1", tmp_path, panel)["rv_resolutions_sha256"] == RV_V1_RESOLUTIONS_SHA256
    assert _evaluate("s1", tmp_path, panel)["rv_resolutions_sha256"] is None


def test_summary_needs_an_export_commit_matching_the_receipt(tmp_path, panel):
    with pytest.raises(ValueError, match="export_commit None"):
        _evaluate("s1", tmp_path, panel, {"export_commit": None})
    with pytest.raises(ValueError, match="export_commit 'deadbee'"):
        _evaluate("s1", tmp_path, panel, {"export_commit": "deadbee"})
    # A short export commit is a prefix of the receipt's full sha, and the reverse also binds.
    assert _evaluate("s1", tmp_path, panel, {"export_commit": "abc1"})["commit"] == COMMIT
    assert _evaluate("s1", tmp_path, panel, {"export_commit": COMMIT + "5678"})["commit"] == COMMIT


def test_run_retest_refuses_a_booked_instant_without_a_d_open(tmp_path, panel, monkeypatch):
    ds = write_synthetic_dataset(panel, tmp_path / "ds")
    d_hash = json.loads((ds / "manifest.json").read_text())["datasetHash"]
    monkeypatch.setattr(natives, "WF_SPAN", (SPAN_START, SPAN_END))
    rows = _random_rows(panel, "s1", 20, 31, SPAN_START, SPAN_END - 2 * 86_400_000, hold=6 * HOUR)
    late = PANEL_END + 10 * 300_000
    rows += [
        {**rows[0], "entry_ms": late, "exit_ms": late + HOUR},
        {**rows[1], "exit_ms": PANEL_END + HOUR},
    ]
    exp = _write_export(tmp_path, rows, _summary("s1", len(rows), hash_=d_hash))
    with pytest.raises(ValueError, match=r"3 booked instants have no exact D 5m open, first \[\('"):
        natives.run_retest(exp, ds, 0.01, tmp_path / "out", commit=COMMIT, n_draws=20)


def test_a_trade_may_exit_exactly_at_dev_end(tmp_path, panel, monkeypatch):
    """An exit at the span end (the last v8 close instant) is booked like any other, on D's bar at that instant."""
    ds = write_synthetic_dataset(panel, tmp_path / "ds")
    monkeypatch.setattr(natives, "WF_SPAN", (SPAN_START, SPAN_END))
    rows = _random_rows(panel, "v8-1h", 40, 41, SPAN_START, SPAN_END - 2 * 86_400_000, hold=6 * HOUR)
    rows.append(_row(panel, "v8-1h", "BTCUSDT", 1, SPAN_END - 6 * HOUR, 6 * HOUR))
    assert rows[-1]["exit_ms"] == SPAN_END
    exp = _write_export(tmp_path, rows, _summary("v8-1h", len(rows), hash_=NATIVE_DECISION_SOURCES["v8-1h"]))
    receipt = natives.run_retest(exp, ds, 0.01, tmp_path / "out", commit=COMMIT, n_draws=20)
    assert receipt["n_tranches"] == len(rows)


def test_decision_source_still_routes_unknown_rules_to_d():
    assert decision_source("C1", DATASET_HASH) == DATASET_HASH
