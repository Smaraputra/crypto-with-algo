"""Amendment 5 C5 pins: the node digests of the files on disk that A5.1 pins to their C5 text.

Usage (from scripts/research/py):
    python -m tests.a5_pins_gen [--out PATH]
The default output is tests/fixtures/a5_pins_c5.json beside this file. It holds bar.py's def:joint_shift_stats and
def:joint_shift_null, the whole of hedge_cost.py (its nodes and its other statements) and every extension node of
pipeline.py and cli.py, computed with a3_nodes_gen's digest rules. Run it last, after every other change, so the pins
are the C5 text.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from tests.a3_nodes_gen import nodes_from_source

R4 = Path(__file__).resolve().parents[1] / "r4"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "a5_pins_c5.json"
BAR_PINNED = ("def:joint_shift_stats", "def:joint_shift_null")
# A5.1: the extension nodes per module. Each is pinned to its current text; a change needs a family commit that
# re-pins it, reviewed by Opus.
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


def pins() -> dict[str, object]:
    bar_nodes = nodes_from_source((R4 / "bar.py").read_text(encoding="utf-8"))["nodes"]
    hedge = nodes_from_source((R4 / "hedge_cost.py").read_text(encoding="utf-8"))
    extensions: dict[str, dict[str, str]] = {}
    for module, keys in sorted(EXTENSION_NODES.items()):
        nodes = nodes_from_source((R4 / module).read_text(encoding="utf-8"))["nodes"]
        extensions[module] = {k: nodes[k] for k in sorted(keys)}  # type: ignore[index]
    return {
        "bar.py": {"nodes": {k: bar_nodes[k] for k in BAR_PINNED}},  # type: ignore[index]
        "hedge_cost.py": hedge,
        "extensions": extensions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(FIXTURE))
    args = parser.parse_args()
    Path(args.out).write_text(json.dumps({"modules": pins()}, indent=1, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
