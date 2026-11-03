"""Brief 31c (Amendment 5, A5.1): one node guard against the C4 fixture of every r4 module.

C4 is dfe1ebf5. Frozen modules keep their C4 nodes and other statements, bar bar.py's two C5 nodes (pinned). cli.py
and pipeline.py may gain nodes and statements, and only A5.1's extension nodes may change. hedge_cost.py equals its C5
pins. Any module not at C4 is new family code. The pins are written by tests/a5_pins_gen.py.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from tests.a3_nodes_gen import METHOD, nodes_from_source
from tests.a5_pins_gen import BAR_PINNED, pins

PY = Path(__file__).resolve().parents[1]
R4 = PY / "r4"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIXTURE_C4 = FIXTURES / "a5_nodes_dfe1ebf5.json"
PINS_C5 = FIXTURES / "a5_pins_c5.json"

# A5.1: the extension nodes that may change, per module (cli.py and pipeline.py may also gain nodes and imports).
EXTENSION_NODES: dict[str, frozenset[str]] = {
    "pipeline.py": frozenset(
        {
            "class:RunConfig",
            "def:run_config_from_raw",
            "def:load_panel",
            "def:decision_samples",
            "def:_make_model",
            "def:_binary_labels",
            "def:fit_side_model",
            "def:_get_decisions",
            "def:_make_tranches",
        }
    ),
    "cli.py": frozenset({"def:run_wf", "def:run_tripwire", "def:main"}),
}
# sha256 of the two lock files at C4 (unchanged since 5250b8ea).
LOCK_SHA256: dict[str, str] = {
    "requirements.lock": "73d0c30008fda2363e334ede40ddca2534a269d168166eb2a14ff6711a0e13d1",
    "requirements-test.lock": "87307b15b65879b3e74d3930fcf5f8db18be2e67fced1da0ab3ad6d4f5104732",
}

_FIXTURE = json.loads(FIXTURE_C4.read_text(encoding="utf-8"))
_C4_MODULES = sorted(_FIXTURE["modules"])
_FROZEN = [m for m in _C4_MODULES if m not in EXTENSION_NODES]
_PINS = json.loads(PINS_C5.read_text(encoding="utf-8"))["modules"]


def _head(module: str) -> dict[str, object]:
    return nodes_from_source((R4 / module).read_text(encoding="utf-8"), skip_module_docstring=module == METHOD)


def test_fixture_is_the_c4_commit():
    assert _FIXTURE["commit"] == "dfe1ebf51794011b5ef7bd9c31e32d908bd19ec5"
    assert METHOD in _C4_MODULES and "cli.py" in _C4_MODULES and "pipeline.py" in _C4_MODULES


def test_extension_list_is_exactly_the_amendment_list():
    assert {m: sorted(v) for m, v in EXTENSION_NODES.items()} == {
        "cli.py": ["def:main", "def:run_tripwire", "def:run_wf"],
        "pipeline.py": [
            "class:RunConfig",
            "def:_binary_labels",
            "def:_get_decisions",
            "def:_make_model",
            "def:_make_tranches",
            "def:decision_samples",
            "def:fit_side_model",
            "def:load_panel",
            "def:run_config_from_raw",
        ],
    }
    for module, keys in EXTENSION_NODES.items():
        assert keys <= set(_FIXTURE["modules"][module]["nodes"]), f"{module}: extension node not at C4"


def test_pins_hold_the_bar_nodes_and_all_of_hedge_cost():
    assert sorted(_PINS["bar.py"]["nodes"]) == sorted(BAR_PINNED)
    assert _PINS["hedge_cost.py"]["nodes"] and "other" in _PINS["hedge_cost.py"]


def test_every_c4_module_still_exists():
    assert [m for m in _C4_MODULES if not (R4 / m).is_file()] == []


@pytest.mark.parametrize("module", _FROZEN)
def test_frozen_module_equals_c4_bar_the_c5_pins(module):
    frozen = _FIXTURE["modules"][module]
    head = _head(module)
    head_nodes: dict[str, str] = head["nodes"]  # type: ignore[assignment]
    frozen_nodes: dict[str, str] = dict(frozen["nodes"])
    if module == "bar.py":
        pinned = _PINS["bar.py"]["nodes"]
        assert set(pinned) <= set(frozen_nodes)
        for key, digest in pinned.items():
            assert head_nodes.get(key) == digest, f"bar.py {key}: not the C5 pin"
            frozen_nodes[key] = digest
    assert head_nodes == frozen_nodes, f"{module}: nodes differ from C4"
    assert head["other"] == frozen["other"], f"{module}: imports or other statements differ from C4"


@pytest.mark.parametrize("module", sorted(EXTENSION_NODES))
def test_extension_modules_keep_c4_bar_the_extension_nodes(module):
    frozen = _FIXTURE["modules"][module]
    head = _head(module)
    head_nodes: dict[str, str] = head["nodes"]  # type: ignore[assignment]
    frozen_nodes: dict[str, str] = frozen["nodes"]
    missing = sorted(k for k in frozen_nodes if k not in head_nodes)
    changed = sorted(k for k, v in frozen_nodes.items() if k in head_nodes and head_nodes[k] != v)
    assert missing == [], f"{module}: C4 nodes removed or renamed"
    assert set(changed) <= EXTENSION_NODES[module], f"{module}: changed outside the extension list: {changed}"
    lost = sorted(set(frozen["other"]) - set(head["other"]))  # type: ignore[arg-type]
    assert lost == [], f"{module}: C4 statements removed or changed"


def test_hedge_cost_equals_its_c5_pins():
    head = _head("hedge_cost.py")
    assert head["nodes"] == _PINS["hedge_cost.py"]["nodes"]
    assert head["other"] == _PINS["hedge_cost.py"]["other"]


def test_pins_on_disk_equal_a_fresh_computation():
    assert json.loads(json.dumps(pins())) == _PINS


@pytest.mark.parametrize("name", sorted(LOCK_SHA256))
def test_requirement_locks_are_unchanged_from_c4(name):
    assert hashlib.sha256((PY / name).read_bytes()).hexdigest() == LOCK_SHA256[name]
