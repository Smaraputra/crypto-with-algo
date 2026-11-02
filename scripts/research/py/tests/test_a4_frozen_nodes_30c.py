"""Brief 30c (Amendment 4, A4.3): every r4 top-level node equals its frozen text, bar the named exceptions.

Two baselines: 5250b8ea (A3's allowed set plus A4's) and b23a7b26 (A3's nodes keep that text, bar the ones A4 names).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from tests.a3_nodes_gen import METHOD, nodes_from_source

PY = Path(__file__).resolve().parents[1]
R4 = PY / "r4"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIXTURE_A3 = FIXTURES / "a3_nodes_b23a7b26.json"

# The nodes Amendment 4 may change, per module. The lead copies these names into the amendment text (A4.3).
A4_ALLOWED_CHANGED: dict[str, frozenset[str]] = {
    "book.py": frozenset({"def:beta_hedged_daily"}),
    "bar.py": frozenset({"def:item3", "def:joint_shift_stats", "def:joint_shift_null", "def:family_report"}),
    "stats.py": frozenset({"def:deflated_sharpe", "def:probabilistic_sharpe"}),
    "cli.py": frozenset({"def:run_wf", "def:main"}),
    "calibration.py": frozenset(
        {
            "def:evaluate_noise",
            "def:_cost_free_diagnostics",
            "def:_curve_entry",
            "def:power_simulation",
            "def:_check_power_parameters",
            "def:_positive_preflight",
            "def:positive_control",
            "def:write_dossier",
            "def:_validate_retests",
            "assign:POWER_STOP_V",
            "assign:SYNTH_V_A2",
        }
    ),
    "natives.py": frozenset({"def:evaluate_retest"}),
}
# The nodes Amendment 4 may add, per module. calibration.py's new constants are named A4_*.
A4_ALLOWED_NEW: dict[str, frozenset[str]] = {
    "stats.py": frozenset({"def:long_run_variance_factor"}),
    "calibration.py": frozenset(
        {"assign:A4_ITEM3_VARIANCE", "assign:A4_RETEST_LOOKBACK_MONTHS", "assign:A4_VARIANCE_MARGIN"}
    ),
}

# sha256 of the two lock files at 5250b8ea (git show 5250b8ea:scripts/research/py/<name> | shasum -a 256).
LOCK_SHA256: dict[str, str] = {
    "requirements.lock": "73d0c30008fda2363e334ede40ddca2534a269d168166eb2a14ff6711a0e13d1",
    "requirements-test.lock": "87307b15b65879b3e74d3930fcf5f8db18be2e67fced1da0ab3ad6d4f5104732",
}

_FIXTURE = json.loads(FIXTURE_A3.read_text(encoding="utf-8"))
_MODULES = sorted(_FIXTURE["modules"])


def test_fixture_is_the_a3_commit():
    assert _FIXTURE["commit"] == "b23a7b26599f8efe02edb5d259cfef0a9dbe1ccd"
    assert METHOD in _MODULES and "calibration.py" in _MODULES and "natives.py" in _MODULES


def test_allowed_sets_are_exactly_the_amendment_lists():
    assert {m: sorted(v) for m, v in A4_ALLOWED_CHANGED.items()} == {
        "bar.py": ["def:family_report", "def:item3", "def:joint_shift_null", "def:joint_shift_stats"],
        "book.py": ["def:beta_hedged_daily"],
        "calibration.py": [
            "assign:POWER_STOP_V",
            "assign:SYNTH_V_A2",
            "def:_check_power_parameters",
            "def:_cost_free_diagnostics",
            "def:_curve_entry",
            "def:_positive_preflight",
            "def:_validate_retests",
            "def:evaluate_noise",
            "def:positive_control",
            "def:power_simulation",
            "def:write_dossier",
        ],
        "cli.py": ["def:main", "def:run_wf"],
        "natives.py": ["def:evaluate_retest"],
        "stats.py": ["def:deflated_sharpe", "def:probabilistic_sharpe"],
    }
    assert {m: sorted(v) for m, v in A4_ALLOWED_NEW.items()} == {
        "calibration.py": ["assign:A4_ITEM3_VARIANCE", "assign:A4_RETEST_LOOKBACK_MONTHS", "assign:A4_VARIANCE_MARGIN"],
        "stats.py": ["def:long_run_variance_factor"],
    }


def test_new_calibration_constants_are_named_a4():
    assert all(k.startswith("assign:A4_") for k in A4_ALLOWED_NEW["calibration.py"])


def test_no_module_was_added_or_removed():
    assert sorted(p.name for p in R4.glob("*.py")) == _MODULES


@pytest.mark.parametrize("module", _MODULES)
def test_top_level_nodes_match_the_b23a7b26_digests_bar_a4(module):
    frozen = _FIXTURE["modules"][module]
    head = nodes_from_source((R4 / module).read_text(encoding="utf-8"), skip_module_docstring=module == METHOD)
    head_nodes: dict[str, str] = head["nodes"]  # type: ignore[assignment]
    frozen_nodes: dict[str, str] = frozen["nodes"]
    missing = sorted(k for k in frozen_nodes if k not in head_nodes)
    changed = sorted(k for k, v in frozen_nodes.items() if k in head_nodes and head_nodes[k] != v)
    new = sorted(k for k in head_nodes if k not in frozen_nodes)
    assert missing == [], f"{module}: nodes removed or renamed since b23a7b26"
    assert set(changed) <= A4_ALLOWED_CHANGED.get(module, frozenset()), f"{module}: changed outside A4: {changed}"
    assert set(new) <= A4_ALLOWED_NEW.get(module, frozenset()), f"{module}: added outside A4: {new}"
    assert head["other"] == frozen["other"], f"{module}: imports or other statements changed"


@pytest.mark.parametrize("name", sorted(LOCK_SHA256))
def test_requirement_locks_are_unchanged_from_5250b8ea(name):
    assert hashlib.sha256((PY / name).read_bytes()).hexdigest() == LOCK_SHA256[name]
