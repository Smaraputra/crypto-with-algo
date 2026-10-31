"""Amendment 3 node-digest generator: the top-level AST nodes of every r4 module at the frozen commit.

Usage (repo root, stdlib only):
    python scripts/research/py/tests/a3_nodes_gen.py [--commit 5250b8ea] [--out PATH]
The default output is tests/fixtures/a3_nodes_5250b8ea.json beside this file.

Each module maps to {"nodes": {key: sha256 of the node's source text}, "other": sorted list of those digests}. A
node's text is its exact source lines, from its first decorator (or its own first line) to its last line, docstrings
and comments inside it included. Source text is the same under every Python version, where ast.dump output is not
(3.13 omits empty fields that 3.12 prints, and the research image runs 3.12). Keys: "def:<name>" (functions),
"class:<name>", "assign:<targets joined by ,>" (Assign and AnnAssign) and, for any other statement (imports,
expressions, control flow), an entry in "other". method.py's module docstring is excluded (it is the text the signed
amendments append to); every other module's docstring is an "other" node like any other statement. A name defined
twice gets "#2", "#3", ... suffixes in file order.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import subprocess
from pathlib import Path

FROZEN_COMMIT = "5250b8ea"
R4_DIR = "scripts/research/py/r4"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "a3_nodes_5250b8ea.json"
METHOD = "method.py"


def _digest(node: ast.stmt, lines: list[str]) -> str:
    start = min([node.lineno, *(d.lineno for d in getattr(node, "decorator_list", []))])
    end = node.end_lineno if node.end_lineno is not None else node.lineno
    return hashlib.sha256("\n".join(lines[start - 1 : end]).encode("utf-8")).hexdigest()


def _target_names(targets: list[ast.expr]) -> str:
    names: list[str] = []
    for target in targets:
        names.extend(sub.id for sub in ast.walk(target) if isinstance(sub, ast.Name))
    return ",".join(names)


def nodes_from_source(source: str, *, skip_module_docstring: bool = False) -> dict[str, object]:
    """{"nodes": {key: digest}, "other": [digests]} of one module's top-level statements."""
    lines = source.splitlines()
    body = ast.parse(source).body
    if skip_module_docstring and body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        if isinstance(body[0].value.value, str):
            body = body[1:]
    nodes: dict[str, str] = {}
    other: list[str] = []
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            key = f"def:{node.name}"
        elif isinstance(node, ast.ClassDef):
            key = f"class:{node.name}"
        elif isinstance(node, ast.Assign):
            key = f"assign:{_target_names(node.targets)}"
        elif isinstance(node, ast.AnnAssign):
            key = f"assign:{_target_names([node.target])}"
        else:
            other.append(_digest(node, lines))
            continue
        base, n = key, 1
        while key in nodes:
            n += 1
            key = f"{base}#{n}"
        nodes[key] = _digest(node, lines)
    return {"nodes": nodes, "other": sorted(other)}


def modules_at(commit: str, repo_root: Path) -> dict[str, dict[str, object]]:
    names = subprocess.run(
        ["git", "ls-tree", "--name-only", commit, f"{R4_DIR}/"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    out: dict[str, dict[str, object]] = {}
    for path in sorted(n for n in names if n.endswith(".py")):
        src = subprocess.run(
            ["git", "show", f"{commit}:{path}"], cwd=repo_root, check=True, capture_output=True, text=True
        ).stdout
        name = path.rsplit("/", 1)[1]
        out[name] = nodes_from_source(src, skip_module_docstring=name == METHOD)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--commit", default=FROZEN_COMMIT)
    parser.add_argument("--out", default=str(FIXTURE))
    args = parser.parse_args()
    root = Path(
        subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True
        ).stdout.strip()
    )
    full = subprocess.run(
        ["git", "rev-parse", args.commit], cwd=root, check=True, capture_output=True, text=True
    ).stdout.strip()
    doc = {"commit": full, "modules": modules_at(full, root)}
    Path(args.out).write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
