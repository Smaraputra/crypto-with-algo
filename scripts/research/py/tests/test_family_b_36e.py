"""Brief 36e: Amendment 10 (the withdrawn sti frame, the gate record, the carry-over). Synthetic only."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from r4 import cli, family_b, phase5_b

COMMIT = "b" * 40
EVAL_COMMIT = "ce7053dc"
EVAL_DIGEST = "e" * 64
DS_HASH = "d" * 64
WITHDRAWN = ("B_rule_sti_C1", "B_meta12_sti_C1", "B_metaall_sti_C1")


def _eval_data(
    pos_tranches: tuple[int, ...] = (2887, 4000, 5000, 6358),
    n_pass: int = 0,
    n_reject: int = 0,
    **change: Any,
) -> dict[str, Any]:
    controls: dict[str, Any] = {}
    pos_i = 0
    n_p = n_r = 0
    for k, c in enumerate(family_b.family_b_noise()):
        frame = c["side_rule"].removeprefix("b_noise_")
        if frame == "pos":
            tr = pos_tranches[pos_i]
            pos_i += 1
        else:
            tr = 227 if k < 2 else 258  # the sti frame: inactive, as at ce7053dc
        passed = n_p < n_pass
        n_p += int(passed)
        rejected = n_r < n_reject
        n_r += int(rejected)
        controls[c["id"]] = {
            "frame": frame,
            "wf_tranches": tr,
            "active": tr >= 1000,
            "pass_items_1_to_3": passed,
            "joint_shift": {"p": 0.01 if rejected else 0.5, "draws": 1000},
        }
    data = {
        "kind": "noise_eval_b",
        "commit": EVAL_COMMIT,
        "source_sha256": EVAL_DIGEST,
        "dataset_hash": DS_HASH,
        "receipts_sha256": {i: hashlib.sha256(i.encode()).hexdigest() for i in controls},
        "controls": controls,
        "gates_met": False,
    }
    data.update(change)
    return data


def _bind(monkeypatch: pytest.MonkeyPatch, f: Path) -> tuple[tuple[str, str], ...]:
    """The synthetic evaluation's sha256, commit, digest and dataset as the bound values (the writer's default)."""
    bound = (
        ("eval_sha256", hashlib.sha256(f.read_bytes()).hexdigest()),
        ("eval_commit", EVAL_COMMIT),
        ("eval_digest", EVAL_DIGEST),
        ("dataset_hash", DS_HASH),
    )
    monkeypatch.setitem(phase5_b.write_a10_gate_record.__kwdefaults__, "bound", bound)  # type: ignore[arg-type]
    return bound


def _write_eval(tmp: Path, monkeypatch: pytest.MonkeyPatch, name: str = "ev.json", **kw: Any) -> Path:
    f = tmp / name
    f.write_text(json.dumps(_eval_data(**kw)), encoding="utf-8")
    _bind(monkeypatch, f)
    return f


def _repro(tmp: Path, name: str = "repro.json", **change: Any) -> Path:
    data = {
        "commit": COMMIT[:8],
        "r4_source_sha256": cli.source_digest(),
        "dataset_hash": DS_HASH,
        "all_match": True,
    }
    data.update(change)
    f = tmp / name
    f.write_text(json.dumps(data), encoding="utf-8")
    return f


def _record(tmp: Path, monkeypatch: pytest.MonkeyPatch, out: Path, **kw: Any) -> dict[str, Any]:
    return phase5_b.write_a10_gate_record(_write_eval(tmp, monkeypatch, **kw), out, COMMIT, _repro(tmp))


# ---------------------------------------------------------------------------------------------------------------------
# A10.1: the 15 configurations
# ---------------------------------------------------------------------------------------------------------------------


def test_the_withdrawn_constant_and_the_declared_registry() -> None:
    declared = family_b.family_b()
    assert family_b.WITHDRAWN_IDS == WITHDRAWN
    assert len(declared) == 18 == family_b.N_DECLARED and family_b.N_RESERVE == 6
    assert [k for k, c in enumerate(declared) if c["id"] in WITHDRAWN] == [4, 14, 16]
    assert [
        k for k, c in enumerate(declared) if c["id"] in ("B_rule_pos_C4", "B_meta12_pos_C4", "B_metaall_pos_C4")
    ] == [
        5,
        15,
        17,
    ]
    assert family_b.RESERVE_SEED_BASE == 11_000_018
    assert phase5_b.round_alpha_count([]) == 84  # the 18 stay counted


def _stub_run(monkeypatch: pytest.MonkeyPatch, ran: list[dict[str, Any]]) -> None:
    monkeypatch.setattr(phase5_b.bar, "read_manifest", lambda ds: {"datasetHash": DS_HASH})
    monkeypatch.setattr(phase5_b, "_load", lambda ds, v8: ({"datasetHash": DS_HASH}, {}))
    monkeypatch.setattr(phase5_b, "_run_config", lambda cfg, *a, **k: ran.append(cfg) or {"config": cfg})


def test_run_family_b_runs_the_15_unchanged_and_never_a_withdrawn_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran: list[dict[str, Any]] = []
    _stub_run(monkeypatch, ran)
    out = tmp_path / "out"
    _record(tmp_path, monkeypatch, out)
    phase5_b.run_family_b(tmp_path, out, COMMIT)
    declared = family_b.family_b()
    assert len(ran) == 15 and not {c["id"] for c in ran} & set(WITHDRAWN)
    assert ran == [c for c in declared if c["id"] not in WITHDRAWN]  # ids, order, seeds, every field unchanged
    for c in ran:
        k = next(i for i, d in enumerate(declared) if d["id"] == c["id"])
        assert c["joint_shift_seed"] == 11_000_000 + k
    assert [c["joint_shift_seed"] - 11_000_000 for c in ran] == [k for k in range(18) if k not in (4, 14, 16)]


# ---------------------------------------------------------------------------------------------------------------------
# A10.2 and A10.3: the gate record
# ---------------------------------------------------------------------------------------------------------------------


def test_the_gate_record_restates_the_three_gates_and_binds_the_receiving_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rec = _record(tmp_path, monkeypatch, tmp_path / "out")
    saved = json.loads((tmp_path / "out" / "noise_gate_a10.json").read_text(encoding="utf-8"))
    assert saved == rec and rec["kind"] == "noise_gate_a10" and rec["gates_met"] is True
    g = rec["gates"]
    assert g["pos_activity"]["active"] == 4 and g["pos_activity"]["of"] == 4 and g["pos_activity"]["met"] is True
    assert g["items_1_to_3"]["n_pass"] == 0 and g["joint_shift"]["n_reject"] == 0
    assert (
        rec["source_commit"] == EVAL_COMMIT and rec["source_digest"] == EVAL_DIGEST and rec["dataset_hash"] == DS_HASH
    )
    assert rec["source_file_sha256"] == dict(phase5_b.write_a10_gate_record.__kwdefaults__["bound"])["eval_sha256"]  # type: ignore[index]
    assert rec["withdrawn_ids"] == list(WITHDRAWN) and len(rec["receipts_sha256"]) == 8
    r = rec["receiving"]
    assert r["commit"] == COMMIT and r["source_digest"] == cli.source_digest() and r["dataset_hash"] == DS_HASH
    assert r["reproduction_sha256"] == hashlib.sha256((tmp_path / "repro.json").read_bytes()).hexdigest()


def test_the_signed_defaults_are_the_values_the_amendment_names() -> None:
    bound = dict(phase5_b.write_a10_gate_record.__kwdefaults__["bound"])  # type: ignore[index]
    assert bound == {
        "eval_sha256": "4174bbd914689f58a044696b440d68319e3fecf3fa452ff84d615c7b44410ef6",
        "eval_commit": "ce7053dc",
        "eval_digest": "863cf087c3108f10b92f3797fb4babdcf0be170603215ba3c1df4668fdb69aaa",
        "dataset_hash": "11c87b9c8a97c367b6cd7c0c983f4d2bd9e940f62856a85c6e76537ac18a9a62",
    }


def test_the_activity_gate_reads_the_pos_frame_not_the_sti_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A8.6 would fail this evaluation on sti (0 of 4 active). A10.2 reads the pos frame only."""
    f = _write_eval(tmp_path, monkeypatch)
    ev = json.loads(f.read_text(encoding="utf-8"))
    assert sum(c["active"] for c in ev["controls"].values() if c["frame"] == "sti") == 0
    assert phase5_b.write_a10_gate_record(f, tmp_path / "o", COMMIT, _repro(tmp_path))["gates_met"] is True


@pytest.mark.parametrize(
    ("kw", "gate"),
    [
        ({"pos_tranches": (5000, 5000, 999, 10)}, "pos_activity"),  # 2 of 4
        ({"pos_tranches": (1000, 1000, 1000, 999)}, None),  # 3 of 4, one at the floor exactly: met
        ({"pos_tranches": (1000, 1000, 999, 999)}, "pos_activity"),
        ({"n_pass": 1}, "items_1_to_3"),
        ({"n_reject": 3}, "joint_shift"),
        ({"n_reject": 2}, None),
    ],
)
def test_the_gate_record_at_the_bounds_and_one_over(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kw: dict[str, Any], gate: str | None
) -> None:
    rec = _record(tmp_path, monkeypatch, tmp_path / "o", **kw)
    if gate is None:
        assert rec["gates_met"] is True
    else:
        assert rec["gates_met"] is False and [k for k, v in rec["gates"].items() if not v["met"]] == [gate]
    assert (tmp_path / "o" / "noise_gate_a10.json").is_file()  # written either way


def test_the_writer_recomputes_the_gates_and_ignores_the_evaluations_verdicts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = _write_eval(tmp_path, monkeypatch, pos_tranches=(5, 5, 5, 5), gates_met=True, gates={"gates_met": True})
    rec = phase5_b.write_a10_gate_record(f, tmp_path / "o", COMMIT, _repro(tmp_path))
    assert rec["gates_met"] is False and rec["gates"]["pos_activity"]["active"] == 0


def test_the_writer_refuses_a_wrong_sha256_commit_digest_dataset_or_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repro = _repro(tmp_path)
    f = _write_eval(tmp_path, monkeypatch)
    phase5_b.write_a10_gate_record(f, tmp_path / "ok", COMMIT, repro)
    bad = tmp_path / "bad"
    good = dict(phase5_b.write_a10_gate_record.__kwdefaults__["bound"])  # type: ignore[index]
    with pytest.raises(ValueError, match="sha256"):
        phase5_b.write_a10_gate_record(f, bad, COMMIT, repro, bound=tuple({**good, "eval_sha256": "0" * 64}.items()))
    for field, value, match in (
        ("commit", "c" * 8, "commit"),
        ("source_sha256", "0" * 64, "source_sha256"),
        ("dataset_hash", "other", "dataset_hash"),
        ("kind", "noise_eval", "not a family B noise evaluation"),
        ("receipts_sha256", {}, "receipts_sha256"),
        ("receipts_sha256", None, "receipts_sha256"),
    ):
        g = _write_eval(tmp_path, monkeypatch, name=f"{field}.json", **{field: value})
        with pytest.raises(ValueError, match=match):
            phase5_b.write_a10_gate_record(g, bad, COMMIT, repro)
    for mutate, match in (
        (lambda ev: ev["controls"].pop("B_noise_pos_C4_all_s2"), "8 registered controls"),
        (lambda ev: ev["controls"]["B_noise_pos_C4_all_s2"]["joint_shift"].update(draws=5), "joint-shift draws"),
    ):
        ev = _eval_data()
        mutate(ev)
        h = tmp_path / "shape.json"
        h.write_text(json.dumps(ev), encoding="utf-8")
        _bind(monkeypatch, h)
        with pytest.raises(ValueError, match=match):
            phase5_b.write_a10_gate_record(h, bad, COMMIT, repro)
    f = _write_eval(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match="no noise evaluation"):
        phase5_b.write_a10_gate_record(tmp_path / "missing.json", bad, COMMIT, repro)
    assert not bad.exists()


def test_the_writer_refuses_a_reproduction_of_another_commit_digest_dataset_or_a_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = _write_eval(tmp_path, monkeypatch)
    bad = tmp_path / "bad"
    for change in (
        {"commit": "c" * 8},
        {"r4_source_sha256": "0" * 64},
        {"dataset_hash": "other"},
        {"all_match": False},
        {"commit": ""},
    ):
        with pytest.raises(ValueError, match="matching eight-run reproduction"):
            phase5_b.write_a10_gate_record(f, bad, COMMIT, _repro(tmp_path, "r2.json", **change))
    with pytest.raises(ValueError, match="no reproduction record"):
        phase5_b.write_a10_gate_record(f, bad, COMMIT, tmp_path / "none.json")
    assert not bad.exists()


# ---------------------------------------------------------------------------------------------------------------------
# A10.3: run_family_b requires the record
# ---------------------------------------------------------------------------------------------------------------------


def test_run_family_b_refuses_a_missing_false_or_wrongly_bound_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran: list[dict[str, Any]] = []
    _stub_run(monkeypatch, ran)
    out = tmp_path / "out"
    with pytest.raises(ValueError, match="no A10 gate record"):
        phase5_b.run_family_b(tmp_path, out, COMMIT)
    rec = _record(tmp_path, monkeypatch, out)
    f = out / "noise_gate_a10.json"
    gates = rec["gates"]
    cases: list[tuple[dict[str, Any], str]] = [
        ({"gates_met": False}, "did not meet"),
        ({"gates_met": None}, "did not meet"),
        ({"source_file_sha256": "0" * 64}, "source_file_sha256"),  # another evaluation
        ({"source_commit": "c" * 8}, "source_commit"),
        ({"source_digest": "0" * 64}, "source_digest"),
        ({"dataset_hash": "other"}, "dataset_hash"),
        ({"kind": "noise_eval_b"}, "not an A10 gate record"),
        ({"gates": {}}, "all three gates"),
        ({"gates": {**gates, "joint_shift": {**gates["joint_shift"], "met": False}}}, "all three gates"),
        ({"gates": {**gates, "pos_activity": {**gates["pos_activity"], "met": False}}}, "all three gates"),
        ({"receiving": None}, "receiving block"),
        ({"receiving": {**rec["receiving"], "commit": "c" * 40}}, "receiving commit"),
        ({"receiving": {**rec["receiving"], "source_digest": "0" * 64}}, "receiving source_digest"),
        ({"receiving": {**rec["receiving"], "dataset_hash": "other"}}, "receiving dataset_hash"),
        ({"receiving": {**rec["receiving"], "reproduction_sha256": "0" * 64}}, "reproduction_sha256"),
        ({"receiving": {**rec["receiving"], "reproduction_record": str(tmp_path / "gone.json")}}, "does not exist"),
        ({"receiving": {**rec["receiving"], "reproduction_sha256": ""}}, "receiving block must hold"),
    ]
    for change, match in cases:
        f.write_text(json.dumps({**rec, **change}), encoding="utf-8")
        with pytest.raises(ValueError, match=match):
            phase5_b.run_family_b(tmp_path, out, COMMIT)
    assert ran == []
    with pytest.raises(ValueError, match="dataset_hash"):  # the dataset in hand is not the record's
        monkeypatch.setattr(phase5_b.bar, "read_manifest", lambda ds: {"datasetHash": "other"})
        f.write_text(json.dumps(rec), encoding="utf-8")
        phase5_b.run_family_b(tmp_path, out, COMMIT)
    monkeypatch.setattr(phase5_b.bar, "read_manifest", lambda ds: {"datasetHash": DS_HASH})
    with pytest.raises(ValueError, match="receiving commit"):  # another commit in hand
        phase5_b.run_family_b(tmp_path, out, "c" * 40)
    assert ran == []
    phase5_b.run_family_b(tmp_path, out, COMMIT)
    assert len(ran) == 15
    with pytest.raises(ValueError, match="not both"):
        phase5_b.run_family_b(tmp_path, out, COMMIT, None, f, f)


def test_run_family_b_reads_a_relative_reproduction_path_beside_the_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran: list[dict[str, Any]] = []
    _stub_run(monkeypatch, ran)
    out = tmp_path / "out"
    rec = _record(tmp_path, monkeypatch, out)
    (out / "repro.json").write_bytes((tmp_path / "repro.json").read_bytes())
    (out / "noise_gate_a10.json").write_text(
        json.dumps({**rec, "receiving": {**rec["receiving"], "reproduction_record": "repro.json"}}), encoding="utf-8"
    )
    phase5_b.run_family_b(tmp_path, out, COMMIT)
    assert len(ran) == 15


def test_run_family_b_keeps_the_a86_path_for_an_explicit_noise_evaluation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran: list[dict[str, Any]] = []
    _stub_run(monkeypatch, ran)
    f = tmp_path / "noise_eval_b.json"
    data = {
        "kind": "noise_eval_b",
        "commit": COMMIT,
        "source_sha256": cli.source_digest(),
        "dataset_hash": DS_HASH,
        "gates_met": True,
        "controls": {c["id"]: {"joint_shift": {"draws": 1000}} for c in family_b.family_b_noise()},
    }
    f.write_text(json.dumps(data), encoding="utf-8")
    phase5_b.run_family_b(tmp_path, tmp_path / "o", COMMIT, None, f)
    assert len(ran) == 15 and not {c["id"] for c in ran} & set(WITHDRAWN)


# ---------------------------------------------------------------------------------------------------------------------
# The cli subcommand
# ---------------------------------------------------------------------------------------------------------------------


def _run_main(monkeypatch: pytest.MonkeyPatch, argv: list[str]) -> None:
    monkeypatch.setattr(sys, "argv", ["r4.cli", *argv])
    cli.main()


def test_cli_dispatches_family_b_noise_a10_and_exits_1_when_the_gates_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[Any, ...]] = []
    monkeypatch.setattr(phase5_b, "write_a10_gate_record", lambda *a, **k: calls.append((a, k)) or {"gates_met": True})
    argv = [
        "family-b-noise-a10",
        "--noise-eval",
        "/e.json",
        "--reproduction",
        "/r.json",
        "--out",
        "/o",
        "--commit",
        COMMIT,
    ]
    _run_main(monkeypatch, argv)
    assert calls == [(("/e.json", "/o", COMMIT, "/r.json"), {})]
    monkeypatch.setattr(phase5_b, "write_a10_gate_record", lambda *a, **k: {"gates_met": False})
    with pytest.raises(SystemExit) as e:
        _run_main(monkeypatch, argv)
    assert e.value.code == 1
    runs: list[tuple[Any, ...]] = []
    monkeypatch.setattr(phase5_b, "run_family_b", lambda *a, **k: runs.append(a))
    _run_main(monkeypatch, ["family-b-run", "--ds", "/ds", "--v8-exports", "/v8", "--out", "/o", "--commit", COMMIT])
    assert runs == [("/ds", "/o", COMMIT, "/v8", None)]  # no --noise-eval: run_family_b reads the A10 record


def test_dropping_one_id_from_the_withdrawn_set_puts_it_back_in_the_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran: list[dict[str, Any]] = []
    _stub_run(monkeypatch, ran)
    out = tmp_path / "out"
    _record(tmp_path, monkeypatch, out)
    monkeypatch.setattr(family_b, "WITHDRAWN_IDS", WITHDRAWN[:2])
    phase5_b.run_family_b(tmp_path, out, COMMIT)
    assert len(ran) == 16 and "B_metaall_sti_C1" in {c["id"] for c in ran}
