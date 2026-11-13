"""Tests for horizon-e1 run CLI (rules 12 and 13)."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from horizon.e1 import lock
from horizon.e1 import run as run_mod
from horizon.e1.data import Store
from horizon.e1.events import build_fetch_plan, build_pairs, plan_bytes
from horizon.e1.run import main


def _make_kline_gz(path: Path, rows: list[list[int | float]]) -> tuple[str, int]:
    """Compress rows into Binance daily 1m klines gzip CSV."""
    header = [
        "open_time",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "quote_volume",
        "trades",
        "taker_buy_base",
        "taker_buy_quote",
    ]
    lines = [",".join(header)]
    for r in rows:
        lines.append(",".join(str(x) for x in r))
    content = ("\n".join(lines) + "\n").encode("utf-8")
    raw = gzip.compress(content)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest(), len(raw)


def _make_funding_gz(path: Path, rows: list[tuple[int, float, float]]) -> tuple[str, int]:
    """Compress rows into Binance monthly funding settlements gzip CSV."""
    header = ["calc_time", "funding_interval_hours", "last_funding_rate"]
    lines = [",".join(header)]
    for t, inv, r in rows:
        lines.append(f"{t},{inv},{r}")
    content = ("\n".join(lines) + "\n").encode("utf-8")
    raw = gzip.compress(content)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest(), len(raw)


def _setup_world(root: Path) -> dict[str, Any]:
    """Build small synthetic world with 1 tag event, 1 delist event, and data files."""
    data_dir = root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    t1_ms = 1_700_000_000_000  # 2023-11-14 22:13:20 UTC
    t2_ms = t1_ms + 48 * lock.HOUR_MS  # 2023-11-16 22:13:20 UTC

    record = {
        "meta": {
            "articles": 2,
            "catalogs": {},
            "delist_notices": 1,
            "freeze_ms": lock.FREEZE_MS,
            "from_ms": lock.EVENTS_FROM_MS,
            "intro_body_text_sha256": "dummy",
            "intro_code": "dummy",
            "scan_utc": "2026-11-13T00:00:00Z",
            "tag_notices": 1,
            "unclassified_titles": 0,
        },
        "archive": {
            "ALPHA": {"candidates": [{"first": "2023-01-01", "last": "2026-11-12", "symbol": "ALPHAUSDT"}]},
            "BETA": {"candidates": [{"first": "2023-01-01", "last": "2026-11-12", "symbol": "BETAUSDT"}]},
        },
        "btc": {
            "first": "2020-01-01",
            "last": "2026-11-12",
            "missing_days": [],
            "n_days": 2500,
            "symbol": "BTCUSDT",
        },
        "audit": [],
        "futures_delist": [],
        "events": [
            {
                "cls": "tag",
                "code": "tag_1",
                "ms": t1_ms,
                "title": "Extend the Monitoring Tag to Include ALPHA",
                "tokens": ["ALPHA"],
                "source": "title",
                "day": "2023-11-14",
                "perp": {
                    "ALPHA": {
                        "btc_missing_days": [],
                        "futures_delist_pending": None,
                        "missing_days": [],
                        "reason": "covers-stamp",
                        "symbol": "ALPHAUSDT",
                    }
                },
            },
            {
                "cls": "delist",
                "code": "delist_1",
                "ms": t2_ms,
                "title": "Binance Will Delist BETA on 2023-11-20",
                "tokens": ["BETA"],
                "source": "title",
                "day": "2023-11-16",
                "perp": {
                    "BETA": {
                        "btc_missing_days": [],
                        "futures_delist_pending": None,
                        "missing_days": [],
                        "reason": "covers-stamp",
                        "symbol": "BETAUSDT",
                    }
                },
            },
        ],
    }

    events_path = root / "events.json"
    events_path.write_text(json.dumps(record, indent=1), encoding="utf-8")

    pairs = build_pairs(record)
    plan = build_fetch_plan(record, pairs)
    plan_path = root / "plan.json"
    plan_path.write_bytes(plan_bytes(plan))

    manifest_entries: list[dict[str, Any]] = []
    manifest_map: dict[str, str] = {}

    days_by_symbol = {
        "ALPHAUSDT": ["2023-11-13", "2023-11-14", "2023-11-15", "2023-11-16"],
        "BETAUSDT": ["2023-11-15", "2023-11-16", "2023-11-17", "2023-11-18"],
        "BTCUSDT": ["2023-11-13", "2023-11-14", "2023-11-15", "2023-11-16", "2023-11-17", "2023-11-18"],
    }

    for sym, days in days_by_symbol.items():
        price = 40000.0 if sym == "BTCUSDT" else 100.0
        for day_str in days:
            d = dt.date.fromisoformat(day_str)
            start_ms = int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.UTC).timestamp() * 1000)
            rows = [
                [start_ms + i * lock.MINUTE_MS, price, price, price, price, 10.0, price * 10.0, 10, 5.0, price * 5.0]
                for i in range(1440)
            ]
            k_path = data_dir / "klines" / sym / f"{sym}-1m-{day_str}.csv.gz"
            k_sha, k_bytes = _make_kline_gz(k_path, rows)
            rel_k = f"klines/{sym}/{sym}-1m-{day_str}.csv.gz"
            manifest_map[rel_k] = k_sha
            manifest_entries.append(
                {
                    "badRows": 0,
                    "bytes": k_bytes,
                    "date": day_str,
                    "duplicates": 0,
                    "firstTs": start_ms,
                    "gaps": 0,
                    "kind": "klines",
                    "lastTs": start_ms + 1439 * lock.MINUTE_MS,
                    "rows": 1440,
                    "sha256": k_sha,
                    "status": "ok",
                    "symbol": sym,
                }
            )

    start_nov_ms = int(dt.datetime(2023, 11, 1, tzinfo=dt.UTC).timestamp() * 1000)
    funding_rows: list[tuple[int, float, float]] = []
    for day_i in range(30):
        for h in (0, 8, 16):
            funding_rows.append((start_nov_ms + (day_i * 24 + h) * lock.HOUR_MS, 8.0, 0.0001))

    for sym in ("ALPHAUSDT", "BETAUSDT", "BTCUSDT"):
        f_path = data_dir / "funding" / sym / f"{sym}-fundingRate-2023-11.csv.gz"
        f_sha, f_bytes = _make_funding_gz(f_path, funding_rows)
        rel_f = f"funding/{sym}/{sym}-fundingRate-2023-11.csv.gz"
        manifest_map[rel_f] = f_sha
        manifest_entries.append(
            {
                "badRows": 0,
                "bytes": f_bytes,
                "date": "2023-11",
                "duplicates": 0,
                "firstTs": funding_rows[0][0],
                "gaps": 0,
                "kind": "funding",
                "lastTs": funding_rows[-1][0],
                "rows": len(funding_rows),
                "sha256": f_sha,
                "status": "ok",
                "symbol": sym,
            }
        )

    manifest_file = data_dir / "manifest.jsonl"
    with open(manifest_file, "w", encoding="utf-8") as f:
        for entry in manifest_entries:
            f.write(json.dumps(entry) + "\n")

    return {
        "data_dir": data_dir,
        "events_path": events_path,
        "manifest_file": manifest_file,
        "manifest_map": manifest_map,
        "plan": plan,
        "plan_path": plan_path,
        "record": record,
    }


def test_fetch_plan_command(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Requirement 1: fetch-plan writes canonical plan, prints sha256 and counts, identical on rerun."""
    world = _setup_world(tmp_path)
    out_plan = tmp_path / "fetched_plan.json"

    ret1 = main(["fetch-plan", "--events", str(world["events_path"]), "--out", str(out_plan)])
    assert ret1 == 0
    assert out_plan.is_file()

    plan_bytes_1 = out_plan.read_bytes()
    expected_sha = hashlib.sha256(plan_bytes_1).hexdigest()

    captured1 = capsys.readouterr()
    summary1 = json.loads(captured1.out)
    assert summary1["plan_sha256"] == expected_sha
    assert summary1["klines"] == len(world["plan"]["klines"])
    assert summary1["funding"] == len(world["plan"]["funding"])

    # Running it twice produces identical bytes
    ret2 = main(["fetch-plan", "--events", str(world["events_path"]), "--out", str(out_plan)])
    assert ret2 == 0
    assert out_plan.read_bytes() == plan_bytes_1


def test_register_check_command(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Requirement 2: register-check reports hashes, verifies anchor match, flags differences."""
    world = _setup_world(tmp_path)
    events_p = world["events_path"]
    plan_p = world["plan_path"]
    data_dir = world["data_dir"]

    # Without --anchor
    ret0 = main(["register-check", "--events", str(events_p), "--plan", str(plan_p), "--data-dir", str(data_dir)])
    assert ret0 == 0
    out0 = json.loads(capsys.readouterr().out)
    assert out0["ledger_id"] == lock.LEDGER_ID
    assert out0["lock_digest"] == lock.lock_digest()
    assert out0["events_sha256"] == hashlib.sha256(events_p.read_bytes()).hexdigest()
    assert out0["plan_sha256"] == hashlib.sha256(plan_p.read_bytes()).hexdigest()
    assert out0["manifest_sha256"] == hashlib.sha256((data_dir / "manifest.jsonl").read_bytes()).hexdigest()
    assert out0["plan_matches_record"] is True
    assert "anchor_matches" not in out0

    # With matching anchor
    matching_anchor = {
        "events_sha256": out0["events_sha256"],
        "ledger_id": lock.LEDGER_ID,
        "lock_digest": lock.lock_digest(),
        "manifest_sha256": out0["manifest_sha256"],
        "owner_signature": {"date": "2026-11-14", "lock_digest": lock.lock_digest()},
        "plan_sha256": out0["plan_sha256"],
        "registered_utc": "2026-11-14T00:00:00Z",
    }
    anchor_p = tmp_path / "anchor.json"
    anchor_p.write_text(json.dumps(matching_anchor, indent=1), encoding="utf-8")

    ret1 = main(
        [
            "register-check",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
        ]
    )
    assert ret1 == 0
    out1 = json.loads(capsys.readouterr().out)
    assert out1["anchor_matches"] is True
    assert out1["differences"] == []

    # Changing any one key gives exit code 1 and names that key in differences
    for k in ("ledger_id", "lock_digest", "events_sha256", "plan_sha256", "manifest_sha256"):
        mutated = dict(matching_anchor)
        mutated[k] = "mutated_value"
        anchor_p.write_text(json.dumps(mutated, indent=1), encoding="utf-8")

        ret_mut = main(
            [
                "register-check",
                "--events",
                str(events_p),
                "--plan",
                str(plan_p),
                "--data-dir",
                str(data_dir),
                "--anchor",
                str(anchor_p),
            ]
        )
        assert ret_mut == 1
        out_mut = json.loads(capsys.readouterr().out)
        assert out_mut["anchor_matches"] is False
        assert k in out_mut["differences"]

    # owner_signature and registered_utc differences are ignored
    ignored_mutated = dict(matching_anchor)
    ignored_mutated["registered_utc"] = "2099-01-01T00:00:00Z"
    ignored_mutated["owner_signature"] = {"date": "2099-01-01", "lock_digest": "different"}
    anchor_p.write_text(json.dumps(ignored_mutated, indent=1), encoding="utf-8")

    ret_ign = main(
        [
            "register-check",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
        ]
    )
    assert ret_ign == 0
    out_ign = json.loads(capsys.readouterr().out)
    assert out_ign["anchor_matches"] is True
    assert out_ign["differences"] == []


def test_run_synthetic_mode(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Requirement 3: run in synthetic mode outputs result, files_read, trial ids, no verdict, refuses overwrite."""
    world = _setup_world(tmp_path)
    events_p = world["events_path"]
    plan_p = world["plan_path"]
    data_dir = world["data_dir"]
    (data_dir / "SYNTHETIC").write_text("1\n", encoding="utf-8")

    anchor_p = tmp_path / "dummy_anchor.json"
    anchor_p.write_text("{}", encoding="utf-8")
    out_p = tmp_path / "result.json"

    ret = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
            "--out",
            str(out_p),
        ]
    )
    assert ret == 0
    assert out_p.is_file()

    result = json.loads(out_p.read_text(encoding="utf-8"))
    assert result["synthetic"] is True
    assert "verdict" not in result
    assert "verdict" not in result.get("report", {})

    report_trials = result.get("report", {}).get("trials", {})
    for tid in lock.TRIAL_IDS:
        assert tid in report_trials

    files_read = result.get("files_read", {})
    assert len(files_read) > 0

    manifest_map = world["manifest_map"]
    for rel_path, file_sha in files_read.items():
        assert rel_path in manifest_map
        assert file_sha == manifest_map[rel_path]

    stdout = capsys.readouterr().out
    for tid in lock.TRIAL_IDS:
        assert tid in stdout
        assert "clusters=" in stdout
        assert "mean=" in stdout
        assert "bound=" in stdout
        assert "passed=" in stdout

    # Second run with same --out fails with exit code 2
    ret2 = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
            "--out",
            str(out_p),
        ]
    )
    assert ret2 == 2


def test_run_guards_not_synthetic(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Requirement 4: not-synthetic run fails on guard violations without opening price files."""
    world = _setup_world(tmp_path)
    events_p = world["events_path"]
    plan_p = world["plan_path"]
    data_dir = world["data_dir"]

    syn_file = data_dir / "SYNTHETIC"
    if syn_file.exists():
        syn_file.unlink()

    # The world's synthetic record plays the frozen record here (the real run refuses any other record).
    monkeypatch.setattr(run_mod, "FROZEN_EVENTS_SHA256", hashlib.sha256(events_p.read_bytes()).hexdigest())

    store_opened_count = [0]
    orig_init = Store.__init__

    def spy_init(self, *args, **kwargs):
        store_opened_count[0] += 1
        return orig_init(self, *args, **kwargs)

    monkeypatch.setattr(Store, "__init__", spy_init)

    valid_anchor = {
        "events_sha256": hashlib.sha256(events_p.read_bytes()).hexdigest(),
        "ledger_id": lock.LEDGER_ID,
        "lock_digest": lock.lock_digest(),
        "manifest_sha256": hashlib.sha256((data_dir / "manifest.jsonl").read_bytes()).hexdigest(),
        "owner_signature": {"date": "2026-11-14", "lock_digest": lock.lock_digest()},
        "plan_sha256": hashlib.sha256(plan_p.read_bytes()).hexdigest(),
        "registered_utc": "2026-11-14T00:00:00Z",
    }
    anchor_p = tmp_path / "valid_anchor.json"
    anchor_p.write_text(json.dumps(valid_anchor, indent=1), encoding="utf-8")

    def clean_runner(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if "status" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="")
        return subprocess.CompletedProcess(cmd, 0, stdout="mock_git_head_1234\n")

    def dirty_runner(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if "status" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout=" M scripts/research/py/horizon/e1/run.py\n")
        return subprocess.CompletedProcess(cmd, 0, stdout="mock_git_head_1234\n")

    def fail_runner(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, 128, stdout="", stderr="fatal: not a git repository\n")

    # a. Missing anchor file
    store_opened_count[0] = 0
    missing_anchor = tmp_path / "nonexistent_anchor.json"
    out_fail = tmp_path / "out_fail_missing.json"
    ret = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(missing_anchor),
            "--out",
            str(out_fail),
        ],
        runner=clean_runner,
    )
    assert ret == 2
    assert store_opened_count[0] == 0
    assert not out_fail.exists()

    # b. Anchor hash differs
    for bad_key in ("ledger_id", "lock_digest", "events_sha256", "plan_sha256", "manifest_sha256"):
        store_opened_count[0] = 0
        bad_anchor = dict(valid_anchor)
        bad_anchor[bad_key] = "corrupted_val"
        bad_anchor_p = tmp_path / f"bad_anchor_{bad_key}.json"
        bad_anchor_p.write_text(json.dumps(bad_anchor, indent=1), encoding="utf-8")
        out_fail_key = tmp_path / f"out_fail_{bad_key}.json"
        ret = main(
            [
                "run",
                "--events",
                str(events_p),
                "--plan",
                str(plan_p),
                "--data-dir",
                str(data_dir),
                "--anchor",
                str(bad_anchor_p),
                "--out",
                str(out_fail_key),
            ],
            runner=clean_runner,
        )
        assert ret == 2
        assert store_opened_count[0] == 0
        assert not out_fail_key.exists()

    # c. Lock digest in owner_signature differs
    store_opened_count[0] = 0
    bad_sig_anchor = dict(valid_anchor)
    bad_sig_anchor["owner_signature"] = {"date": "2026-11-14", "lock_digest": "different_digest"}
    bad_sig_p = tmp_path / "bad_sig_anchor.json"
    bad_sig_p.write_text(json.dumps(bad_sig_anchor, indent=1), encoding="utf-8")
    out_fail_sig = tmp_path / "out_fail_sig.json"
    ret = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(bad_sig_p),
            "--out",
            str(out_fail_sig),
        ],
        runner=clean_runner,
    )
    assert ret == 2
    assert store_opened_count[0] == 0
    assert not out_fail_sig.exists()

    # d. Tree is not clean
    store_opened_count[0] = 0
    out_fail_dirty = tmp_path / "out_fail_dirty.json"
    ret = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
            "--out",
            str(out_fail_dirty),
        ],
        runner=dirty_runner,
    )
    assert ret == 2
    assert store_opened_count[0] == 0
    assert not out_fail_dirty.exists()

    # e. Git unavailable and HORIZON_GIT_HEAD missing
    store_opened_count[0] = 0
    monkeypatch.delenv("HORIZON_GIT_HEAD", raising=False)
    monkeypatch.delenv("HORIZON_TREE_CLEAN", raising=False)
    out_fail_nohead = tmp_path / "out_fail_nohead.json"
    ret = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
            "--out",
            str(out_fail_nohead),
        ],
        runner=fail_runner,
    )
    assert ret == 2
    assert store_opened_count[0] == 0
    assert not out_fail_nohead.exists()

    # f. Git unavailable and HORIZON_TREE_CLEAN missing or != "1"
    store_opened_count[0] = 0
    monkeypatch.setenv("HORIZON_GIT_HEAD", "envhead123")
    monkeypatch.delenv("HORIZON_TREE_CLEAN", raising=False)
    out_fail_noclean = tmp_path / "out_fail_noclean.json"
    ret = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
            "--out",
            str(out_fail_noclean),
        ],
        runner=fail_runner,
    )
    assert ret == 2
    assert store_opened_count[0] == 0
    assert not out_fail_noclean.exists()

    monkeypatch.setenv("HORIZON_TREE_CLEAN", "0")
    ret = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
            "--out",
            str(out_fail_noclean),
        ],
        runner=fail_runner,
    )
    assert ret == 2
    assert store_opened_count[0] == 0
    assert not out_fail_noclean.exists()

    # g. Succeeds past guards with matching anchor and clean git tree
    store_opened_count[0] = 0
    out_clean = tmp_path / "out_clean.json"
    ret_clean = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
            "--out",
            str(out_clean),
        ],
        runner=clean_runner,
    )
    assert ret_clean == 0
    assert store_opened_count[0] > 0
    assert out_clean.is_file()
    res_clean = json.loads(out_clean.read_text(encoding="utf-8"))
    assert res_clean["synthetic"] is False
    assert res_clean["lock"]["attested_by_environment"] is False
    assert res_clean["lock"]["git_head"] == "mock_git_head_1234"

    # h. Succeeds past guards with matching anchor and attested environment
    store_opened_count[0] = 0
    monkeypatch.setenv("HORIZON_GIT_HEAD", "env_attested_head_5678")
    monkeypatch.setenv("HORIZON_TREE_CLEAN", "1")
    out_attested = tmp_path / "out_attested.json"
    ret_att = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
            "--out",
            str(out_attested),
        ],
        runner=fail_runner,
    )
    assert ret_att == 0
    assert store_opened_count[0] > 0
    assert out_attested.is_file()
    res_att = json.loads(out_attested.read_text(encoding="utf-8"))
    assert res_att["synthetic"] is False
    assert res_att["lock"]["attested_by_environment"] is True
    assert res_att["lock"]["git_head"] == "env_attested_head_5678"


def test_plan_mismatch_fails_in_synthetic_mode(tmp_path: Path) -> None:
    """Requirement 5: plan file differing from recomputed plan fails with exit code 2."""
    world = _setup_world(tmp_path)
    events_p = world["events_path"]
    plan_p = world["plan_path"]
    data_dir = world["data_dir"]
    (data_dir / "SYNTHETIC").write_text("1\n", encoding="utf-8")

    plan_p.write_bytes(b'{"funding": [], "klines": [], "version": 1}\n')
    anchor_p = tmp_path / "dummy_anchor.json"
    anchor_p.write_text("{}", encoding="utf-8")
    out_p = tmp_path / "out_plan_diff.json"

    ret = main(
        [
            "run",
            "--events",
            str(events_p),
            "--plan",
            str(plan_p),
            "--data-dir",
            str(data_dir),
            "--anchor",
            str(anchor_p),
            "--out",
            str(out_p),
        ]
    )
    assert ret == 2
    assert not out_p.exists()


def test_main_argument_handling() -> None:
    """Requirement 6: bogus arguments return non-zero code without traceback; --help raises SystemExit(0)."""
    ret = main(["bogus"])
    assert ret != 0

    with pytest.raises(SystemExit) as exc_info:
        main(["--help"])
    assert exc_info.value.code == 0


def _run_args(world: dict[str, Any], anchor: Path, out: Path) -> list[str]:
    return [
        "run",
        "--events",
        str(world["events_path"]),
        "--plan",
        str(world["plan_path"]),
        "--data-dir",
        str(world["data_dir"]),
        "--anchor",
        str(anchor),
        "--out",
        str(out),
    ]


def test_synthetic_marker_is_refused_for_the_frozen_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The marker alone never disables a guard: with the frozen record it is a guard failure (exit code 2)."""
    world = _setup_world(tmp_path)
    (world["data_dir"] / "SYNTHETIC").write_text("", encoding="utf-8")
    monkeypatch.setattr(run_mod, "FROZEN_EVENTS_SHA256", hashlib.sha256(world["events_path"].read_bytes()).hexdigest())
    out = tmp_path / "out_marker.json"
    assert main(_run_args(world, tmp_path / "no_anchor.json", out)) == 2
    assert not out.exists()


def test_real_run_refuses_a_record_that_is_not_the_frozen_one(tmp_path: Path) -> None:
    """Without the marker the record must be the one frozen in lock.EVENTS_SHA256 (the world's record is not)."""
    world = _setup_world(tmp_path)
    marker = world["data_dir"] / "SYNTHETIC"
    if marker.exists():
        marker.unlink()
    out = tmp_path / "out_other_record.json"
    assert main(_run_args(world, tmp_path / "no_anchor.json", out)) == 2
    assert not out.exists()


def test_lock_events_sha256_is_the_committed_record() -> None:
    record = Path(__file__).resolve().parents[1] / "records" / "horizon_e1_events.json"
    assert hashlib.sha256(record.read_bytes()).hexdigest() == lock.EVENTS_SHA256


def test_data_check_counts_files_and_flags_a_tampered_one(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """data-check reads every planned file for structure only: counts them, and names a file whose hash differs."""
    world = _setup_world(tmp_path)
    plan = json.loads(world["plan_path"].read_text(encoding="utf-8"))
    n_klines, n_funding = len(plan["klines"]), len(plan["funding"])
    assert n_klines > 0 and n_funding > 0

    args = ["data-check", "--plan", str(world["plan_path"]), "--data-dir", str(world["data_dir"])]
    assert main(args) == 0
    report_ok = json.loads(capsys.readouterr().out)
    assert report_ok["problems"] == []
    assert report_ok["klines_ok"] + report_ok["klines_missing"] == n_klines
    assert report_ok["funding_ok"] + report_ok["funding_missing"] == n_funding
    assert report_ok["rows"] > 0

    job = plan["klines"][0]
    victim = world["data_dir"] / "klines" / job["symbol"] / f"{job['symbol']}-1m-{job['day']}.csv.gz"
    victim.write_bytes(victim.read_bytes() + b"x")
    assert main(args) == 1
    report_bad = json.loads(capsys.readouterr().out)
    assert len(report_bad["problems"]) == 1
    assert job["symbol"] in report_bad["problems"][0]
    assert "sha256" in report_bad["problems"][0]
