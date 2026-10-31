"""Brief 30b (Amendment 3, review F2): every r4 top-level node equals its 5250b8ea digest, bar the named exceptions."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.a3_nodes_gen import METHOD, nodes_from_source

R4 = Path(__file__).resolve().parents[1] / "r4"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "a3_nodes_5250b8ea.json"

# The nodes Amendment 3 may change, per module. The lead copies these names into the amendment text (A3.2).
ALLOWED_CHANGED: dict[str, frozenset[str]] = {
    "calibration.py": frozenset(
        {
            "def:_bind_commit_order",
            "def:_check_code_freeze",
            "def:_validate_commit_order",
            "def:_validate_retests",
            "def:write_dossier",
        }
    ),
    "natives.py": frozenset({"def:read_export", "def:evaluate_retest", "def:run_retest"}),
}
# The nodes Amendment 3 may add, per module.
ALLOWED_NEW: dict[str, frozenset[str]] = {
    "calibration.py": frozenset(
        {
            "assign:A3_CODE_CHANGE_FILES",
            "assign:A3_CODE_CHANGE_PREFIXES",
            "assign:A3_FROZEN_COMMIT",
            "def:_prefix_match",
            "def:_check_retest_sources",
            "def:_validate_code_change",
        }
    ),
    "natives.py": frozenset(
        {"assign:NATIVE_DECISION_SOURCES", "assign:RV_V1_RESOLUTIONS_SHA256", "def:decision_source"}
    ),
}

_FIXTURE = json.loads(FIXTURE.read_text(encoding="utf-8"))
_MODULES = sorted(_FIXTURE["modules"])


def test_fixture_is_the_frozen_commit():
    assert _FIXTURE["commit"] == "5250b8eaf30b5bb4cf073bbcb9eb2529fb8b8701"
    assert METHOD in _MODULES and "calibration.py" in _MODULES and "natives.py" in _MODULES


def test_allowed_sets_are_exactly_the_amendment_lists():
    assert {m: sorted(v) for m, v in ALLOWED_CHANGED.items()} == {
        "calibration.py": [
            "def:_bind_commit_order",
            "def:_check_code_freeze",
            "def:_validate_commit_order",
            "def:_validate_retests",
            "def:write_dossier",
        ],
        "natives.py": ["def:evaluate_retest", "def:read_export", "def:run_retest"],
    }
    assert {m: sorted(v) for m, v in ALLOWED_NEW.items()} == {
        "calibration.py": [
            "assign:A3_CODE_CHANGE_FILES",
            "assign:A3_CODE_CHANGE_PREFIXES",
            "assign:A3_FROZEN_COMMIT",
            "def:_check_retest_sources",
            "def:_prefix_match",
            "def:_validate_code_change",
        ],
        "natives.py": ["assign:NATIVE_DECISION_SOURCES", "assign:RV_V1_RESOLUTIONS_SHA256", "def:decision_source"],
    }


def test_no_module_was_added_or_removed():
    on_disk = sorted(p.name for p in R4.glob("*.py"))
    assert on_disk == _MODULES


@pytest.mark.parametrize("module", _MODULES)
def test_top_level_nodes_match_the_frozen_digests(module):
    frozen = _FIXTURE["modules"][module]
    head = nodes_from_source((R4 / module).read_text(encoding="utf-8"), skip_module_docstring=module == METHOD)
    allowed_changed = ALLOWED_CHANGED.get(module, frozenset())
    allowed_new = ALLOWED_NEW.get(module, frozenset())
    head_nodes: dict[str, str] = head["nodes"]  # type: ignore[assignment]
    frozen_nodes: dict[str, str] = frozen["nodes"]
    missing = sorted(k for k in frozen_nodes if k not in head_nodes)
    changed = sorted(k for k, v in frozen_nodes.items() if k in head_nodes and head_nodes[k] != v)
    new = sorted(k for k in head_nodes if k not in frozen_nodes)
    assert missing == [], f"{module}: nodes removed or renamed since 5250b8ea"
    assert set(changed) <= allowed_changed, f"{module}: nodes changed outside the allowed set: {changed}"
    assert set(new) <= allowed_new, f"{module}: nodes added outside the allowed set: {new}"
    assert head["other"] == frozen["other"], f"{module}: imports or other statements changed"
