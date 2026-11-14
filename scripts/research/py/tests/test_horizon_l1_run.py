"""Tests for horizon-l1 run CLI (lock.py specification)."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from horizon.l1 import data as data_mod
from horizon.l1 import lock
from horizon.l1 import run as run_mod
from horizon.l1.data import MarketData
from horizon.l1.run import main


class MockGitRunner:
    """Mock git runner providing controlled responses for rev-parse and status."""

    def __init__(self, head: str = "0123456789abcdef0123456789abcdef01234567", clean: bool = True) -> None:
        self.head = head
        self.clean = clean
        self.calls: list[list[str]] = []

    def __call__(self, cmd: list[str], cwd: Any = None) -> subprocess.CompletedProcess[str]:
        self.calls.append(cmd)
        if "rev-parse" in cmd:
            return subprocess.CompletedProcess(cmd, returncode=0, stdout=self.head + "\n", stderr="")
        if "status" in cmd:
            stdout = "" if self.clean else " M scripts/research/py/horizon/l1/run.py\n"
            return subprocess.CompletedProcess(cmd, returncode=0, stdout=stdout, stderr="")
        return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")


def make_test_md(n_min: int = 4_500, market_id: int = 1, symbol: str = "BTC") -> MarketData:
    """Construct a MarketData object for testing."""
    present = np.zeros(n_min, dtype=bool)
    buy_usd = np.zeros(n_min, dtype=np.float64)
    sell_usd = np.zeros(n_min, dtype=np.float64)
    last_px = np.full(n_min, np.nan, dtype=np.float64)
    last_buy_px = np.full(n_min, np.nan, dtype=np.float64)
    last_buy_ts = np.full(n_min, np.nan, dtype=np.float64)
    last_sell_px = np.full(n_min, np.nan, dtype=np.float64)
    last_sell_ts = np.full(n_min, np.nan, dtype=np.float64)
    first_buy_px = np.full(n_min, np.nan, dtype=np.float64)
    first_buy_ts = np.full(n_min, np.nan, dtype=np.float64)
    first_sell_px = np.full(n_min, np.nan, dtype=np.float64)
    first_sell_ts = np.full(n_min, np.nan, dtype=np.float64)
    liq_sell_usd = np.zeros(n_min, dtype=np.float64)
    liq_buy_usd = np.zeros(n_min, dtype=np.float64)
    n_liq_sell = np.zeros(n_min, dtype=np.int32)
    n_liq_buy = np.zeros(n_min, dtype=np.int32)
    return MarketData(
        market_id=market_id,
        symbol=symbol,
        market_type="perp",
        present=present,
        buy_usd=buy_usd,
        sell_usd=sell_usd,
        last_px=last_px,
        last_buy_px=last_buy_px,
        last_buy_ts=last_buy_ts,
        last_sell_px=last_sell_px,
        last_sell_ts=last_sell_ts,
        first_buy_px=first_buy_px,
        first_buy_ts=first_buy_ts,
        first_sell_px=first_sell_px,
        first_sell_ts=first_sell_ts,
        liq_sell_usd=liq_sell_usd,
        liq_buy_usd=liq_buy_usd,
        n_liq_sell=n_liq_sell,
        n_liq_buy=n_liq_buy,
    )


class FakeStoreForRun:
    """Fake store providing files_read for run pipeline tests."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.args = args
        self.kwargs = kwargs
        self._files_read = {"panel/market=1.parquet": "dummy_panel_sha256"}

    def files_read(self) -> dict[str, str]:
        return dict(self._files_read)


class FakeStoreForEventCount:
    """Fake store providing market data for event-count tests."""

    def __init__(self, market_data: dict[int, MarketData]) -> None:
        self._market_data = market_data

    def market_ids(self) -> list[int]:
        return sorted(self._market_data.keys())

    def market(self, market_id: int) -> MarketData:
        return self._market_data[market_id]

    def funding(self, market_id: int) -> tuple[np.ndarray, np.ndarray]:
        return np.array([], dtype=np.int64), np.array([], dtype=np.float64)

    def files_read(self) -> dict[str, str]:
        return {}


def _setup_test_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Create small fake files for manifests, markets, and external modules."""
    fold_dir = tmp_path / "fold"
    panel_dir = tmp_path / "panel"
    liq_dir = tmp_path / "liq"
    funding_dir = tmp_path / "funding"
    for d in (fold_dir, panel_dir, liq_dir, funding_dir):
        d.mkdir(parents=True, exist_ok=True)

    fold_manifest = fold_dir / "manifest.jsonl"
    fold_manifest.write_text('{"date": "2025-01-17", "status": "ok"}\n', encoding="utf-8")

    liq_manifest = liq_dir / "manifest.jsonl"
    liq_manifest.write_text('{"date": "2025-01-17", "status": "ok_liq"}\n', encoding="utf-8")

    markets = fold_dir / "markets.json"
    markets.write_text('{"order_books": [{"market_id": 1, "market_type": "perp"}]}\n', encoding="utf-8")

    funding_manifest = funding_dir / "manifest.jsonl"
    funding_manifest.write_text('{"market_id": 1, "status": "ok_funding"}\n', encoding="utf-8")

    panel_manifest = panel_dir / "panel_manifest.json"
    panel_manifest.write_text('{"panel_version": "l1p1", "scale_jumps": []}\n', encoding="utf-8")

    fake_fold_trades = tmp_path / "fake_fold_trades.py"
    fake_fold_trades.write_text("# fake lighter fold_trades\n", encoding="utf-8")

    fake_lighter_lock = tmp_path / "fake_lighter_lock.py"
    fake_lighter_lock.write_text("# fake lighter lock\n", encoding="utf-8")

    monkeypatch.setattr(run_mod, "_fold_trades_path", lambda: fake_fold_trades)
    monkeypatch.setattr(run_mod, "_lighter_lock_path", lambda: fake_lighter_lock)
    lock.lock_digest.cache_clear()

    expected_hashes = {
        "fold_manifest_sha256": hashlib.sha256(fold_manifest.read_bytes()).hexdigest(),
        "fold_trades_sha256": hashlib.sha256(fake_fold_trades.read_bytes()).hexdigest(),
        "funding_manifest_sha256": hashlib.sha256(funding_manifest.read_bytes()).hexdigest(),
        "ledger_id": lock.LEDGER_ID,
        "lighter_lock_sha256": hashlib.sha256(fake_lighter_lock.read_bytes()).hexdigest(),
        "liq_manifest_sha256": hashlib.sha256(liq_manifest.read_bytes()).hexdigest(),
        "lock_digest": lock.lock_digest(),
        "markets_sha256": hashlib.sha256(markets.read_bytes()).hexdigest(),
        "panel_manifest_sha256": hashlib.sha256(panel_manifest.read_bytes()).hexdigest(),
    }

    return {
        "expected_hashes": expected_hashes,
        "fake_fold_trades": fake_fold_trades,
        "fake_lighter_lock": fake_lighter_lock,
        "fold_dir": fold_dir,
        "fold_manifest": fold_manifest,
        "funding_dir": funding_dir,
        "funding_manifest": funding_manifest,
        "liq_dir": liq_dir,
        "liq_manifest": liq_manifest,
        "markets": markets,
        "panel_dir": panel_dir,
        "panel_manifest": panel_manifest,
    }


# -------------------------------------------------------------------------------------------------------------------
# (1) register-check tests
# -------------------------------------------------------------------------------------------------------------------


def test_register_check_prints_expected_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """register-check prints all expected keys with correct sha256 values and exits 0 without anchor."""
    env = _setup_test_env(tmp_path, monkeypatch)
    ret = main(
        [
            "register-check",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
        ]
    )
    assert ret == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    for k, v in env["expected_hashes"].items():
        assert payload[k] == v
    assert set(payload.keys()) == set(env["expected_hashes"].keys())


def test_register_check_matching_anchor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """register-check exits 0 with anchor_matches true and empty differences when anchor matches."""
    env = _setup_test_env(tmp_path, monkeypatch)
    anchor_path = tmp_path / "anchor.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "2026-11-14", "lock_digest": lock.lock_digest()}
    anchor_content["registered_utc"] = "2026-11-14T00:00:00Z"
    anchor_path.write_text(json.dumps(anchor_content, sort_keys=True, indent=1), encoding="utf-8")

    ret = main(
        [
            "register-check",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
        ]
    )
    assert ret == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["anchor_matches"] is True
    assert payload["differences"] == []


@pytest.mark.parametrize(
    "corrupt_key",
    [
        "fold_manifest_sha256",
        "fold_trades_sha256",
        "funding_manifest_sha256",
        "ledger_id",
        "lighter_lock_sha256",
        "liq_manifest_sha256",
        "lock_digest",
        "markets_sha256",
        "panel_manifest_sha256",
    ],
)
def test_register_check_differing_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], corrupt_key: str
) -> None:
    """register-check exits 1 naming the differing key for each changed key in turn."""
    env = _setup_test_env(tmp_path, monkeypatch)
    anchor_path = tmp_path / f"anchor_{corrupt_key}.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "2026-11-14", "lock_digest": lock.lock_digest()}
    anchor_content["registered_utc"] = "2026-11-14T00:00:00Z"
    anchor_content[corrupt_key] = "corrupted_value_for_test"
    anchor_path.write_text(json.dumps(anchor_content), encoding="utf-8")

    ret = main(
        [
            "register-check",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
        ]
    )
    assert ret == 1
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["anchor_matches"] is False
    assert payload["differences"] == [corrupt_key]


def test_register_check_ignores_owner_signature_and_registered_utc(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """register-check ignores differences in owner_signature and registered_utc."""
    env = _setup_test_env(tmp_path, monkeypatch)
    anchor_path = tmp_path / "anchor_ignored.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "different_date", "lock_digest": "different_digest"}
    anchor_content["registered_utc"] = "2020-01-01T00:00:00Z"
    anchor_path.write_text(json.dumps(anchor_content), encoding="utf-8")

    ret = main(
        [
            "register-check",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
        ]
    )
    assert ret == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["anchor_matches"] is True
    assert payload["differences"] == []


# -------------------------------------------------------------------------------------------------------------------
# (2) run guard failure tests
# -------------------------------------------------------------------------------------------------------------------


def test_run_guard_anchor_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """run exits 2 and store factory is never called when anchor file is missing."""
    env = _setup_test_env(tmp_path, monkeypatch)
    runner = MockGitRunner(clean=True)
    out_path = tmp_path / "out.json"

    store_calls: list[Any] = []

    def spy_store_factory(*args: Any, **kwargs: Any) -> Any:
        store_calls.append((args, kwargs))
        raise AssertionError("store factory should never be called")

    ret = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(tmp_path / "nonexistent_anchor.json"),
            "--out",
            str(out_path),
        ],
        runner=runner,
        store_factory=spy_store_factory,
    )
    assert ret == 2
    assert len(store_calls) == 0
    assert not out_path.exists()
    captured = capsys.readouterr()
    assert "guard failure:" in captured.err


def test_run_guard_existing_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """run exits 2 and store factory is never called when output file already exists."""
    env = _setup_test_env(tmp_path, monkeypatch)
    runner = MockGitRunner(clean=True)
    out_path = tmp_path / "existing_out.json"
    out_path.write_text("existing content", encoding="utf-8")

    anchor_path = tmp_path / "anchor.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "2026-11-14", "lock_digest": lock.lock_digest()}
    anchor_path.write_text(json.dumps(anchor_content), encoding="utf-8")

    store_calls: list[Any] = []

    def spy_store_factory(*args: Any, **kwargs: Any) -> Any:
        store_calls.append((args, kwargs))
        raise AssertionError("store factory should never be called")

    ret = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
            "--out",
            str(out_path),
        ],
        runner=runner,
        store_factory=spy_store_factory,
    )
    assert ret == 2
    assert len(store_calls) == 0
    assert out_path.read_text(encoding="utf-8") == "existing content"
    captured = capsys.readouterr()
    assert "output file already exists" in captured.err


def test_run_guard_git_tree_not_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """run exits 2 and store factory is never called when git working tree is not clean."""
    env = _setup_test_env(tmp_path, monkeypatch)
    runner = MockGitRunner(clean=False)
    out_path = tmp_path / "out.json"

    anchor_path = tmp_path / "anchor.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "2026-11-14", "lock_digest": lock.lock_digest()}
    anchor_path.write_text(json.dumps(anchor_content), encoding="utf-8")

    store_calls: list[Any] = []

    def spy_store_factory(*args: Any, **kwargs: Any) -> Any:
        store_calls.append((args, kwargs))
        raise AssertionError("store factory should never be called")

    ret = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
            "--out",
            str(out_path),
        ],
        runner=runner,
        store_factory=spy_store_factory,
    )
    assert ret == 2
    assert len(store_calls) == 0
    assert not out_path.exists()
    captured = capsys.readouterr()
    assert "git working tree under scripts/research/py/horizon/l1 is not clean" in captured.err


def test_run_guard_git_unavailable_without_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """run exits 2 and store factory is never called when git is unavailable and env vars are missing."""
    env = _setup_test_env(tmp_path, monkeypatch)
    out_path = tmp_path / "out.json"

    def failing_runner(cmd: list[str], cwd: Any = None) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, returncode=1, stdout="", stderr="git error")

    monkeypatch.delenv("HORIZON_GIT_HEAD", raising=False)
    monkeypatch.delenv("HORIZON_TREE_CLEAN", raising=False)

    anchor_path = tmp_path / "anchor.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "2026-11-14", "lock_digest": lock.lock_digest()}
    anchor_path.write_text(json.dumps(anchor_content), encoding="utf-8")

    store_calls: list[Any] = []

    def spy_store_factory(*args: Any, **kwargs: Any) -> Any:
        store_calls.append((args, kwargs))
        raise AssertionError("store factory should never be called")

    ret = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
            "--out",
            str(out_path),
        ],
        runner=failing_runner,
        store_factory=spy_store_factory,
    )
    assert ret == 2
    assert len(store_calls) == 0
    captured = capsys.readouterr()
    assert "HORIZON_GIT_HEAD is missing or empty" in captured.err


def test_run_guard_git_unavailable_with_invalid_clean_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """run exits 2 when git is unavailable and HORIZON_TREE_CLEAN is not '1'."""
    env = _setup_test_env(tmp_path, monkeypatch)
    out_path = tmp_path / "out.json"

    def failing_runner(cmd: list[str], cwd: Any = None) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, returncode=1, stdout="", stderr="git error")

    monkeypatch.setenv("HORIZON_GIT_HEAD", "commit123456")
    monkeypatch.setenv("HORIZON_TREE_CLEAN", "0")

    anchor_path = tmp_path / "anchor.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "2026-11-14", "lock_digest": lock.lock_digest()}
    anchor_path.write_text(json.dumps(anchor_content), encoding="utf-8")

    store_calls: list[Any] = []

    def spy_store_factory(*args: Any, **kwargs: Any) -> Any:
        store_calls.append((args, kwargs))
        raise AssertionError("store factory should never be called")

    ret = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
            "--out",
            str(out_path),
        ],
        runner=failing_runner,
        store_factory=spy_store_factory,
    )
    assert ret == 2
    assert len(store_calls) == 0
    captured = capsys.readouterr()
    assert "HORIZON_TREE_CLEAN is not '1'" in captured.err


@pytest.mark.parametrize(
    "corrupt_key",
    [
        "fold_manifest_sha256",
        "fold_trades_sha256",
        "funding_manifest_sha256",
        "ledger_id",
        "lighter_lock_sha256",
        "liq_manifest_sha256",
        "lock_digest",
        "markets_sha256",
        "panel_manifest_sha256",
    ],
)
def test_run_guard_hash_differs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], corrupt_key: str
) -> None:
    """run exits 2 and store factory is never called when any hash in anchor differs."""
    env = _setup_test_env(tmp_path, monkeypatch)
    runner = MockGitRunner(clean=True)
    out_path = tmp_path / "out.json"

    anchor_path = tmp_path / f"anchor_{corrupt_key}.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "2026-11-14", "lock_digest": lock.lock_digest()}
    anchor_content[corrupt_key] = "corrupted_hash"
    anchor_path.write_text(json.dumps(anchor_content), encoding="utf-8")

    store_calls: list[Any] = []

    def spy_store_factory(*args: Any, **kwargs: Any) -> Any:
        store_calls.append((args, kwargs))
        raise AssertionError("store factory should never be called")

    ret = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
            "--out",
            str(out_path),
        ],
        runner=runner,
        store_factory=spy_store_factory,
    )
    assert ret == 2
    assert len(store_calls) == 0
    assert not out_path.exists()
    captured = capsys.readouterr()
    assert f"anchor key {corrupt_key} mismatch" in captured.err


def test_run_guard_signature_lock_digest_differs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """run exits 2 and store factory is never called when owner_signature lock_digest differs."""
    env = _setup_test_env(tmp_path, monkeypatch)
    runner = MockGitRunner(clean=True)
    out_path = tmp_path / "out.json"

    anchor_path = tmp_path / "anchor_bad_sig.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "2026-11-14", "lock_digest": "corrupted_lock_digest"}
    anchor_path.write_text(json.dumps(anchor_content), encoding="utf-8")

    store_calls: list[Any] = []

    def spy_store_factory(*args: Any, **kwargs: Any) -> Any:
        store_calls.append((args, kwargs))
        raise AssertionError("store factory should never be called")

    ret = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
            "--out",
            str(out_path),
        ],
        runner=runner,
        store_factory=spy_store_factory,
    )
    assert ret == 2
    assert len(store_calls) == 0
    assert not out_path.exists()
    captured = capsys.readouterr()
    assert "anchor owner_signature lock_digest mismatch" in captured.err


# -------------------------------------------------------------------------------------------------------------------
# (3) run success tests
# -------------------------------------------------------------------------------------------------------------------


def test_run_success_git_and_attested(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """run success with matching anchor, clean runner, verified output structure and second run refusal."""
    env = _setup_test_env(tmp_path, monkeypatch)
    runner = MockGitRunner(head="abc1234567890abcdef1234567890abcdef1234", clean=True)
    out_path = tmp_path / "result.json"

    anchor_path = tmp_path / "anchor.json"
    anchor_content = dict(env["expected_hashes"])
    anchor_content["owner_signature"] = {"date": "2026-11-14", "lock_digest": lock.lock_digest()}
    anchor_path.write_text(json.dumps(anchor_content), encoding="utf-8")

    stub_trials = {
        tid: {
            "judgement": {
                "bound": 0.0003,
                "mean": 0.0009,
                "n_clusters": 45,
                "passed": True,
            }
        }
        for tid in lock.TRIAL_IDS
    }
    stub_report = {"trials": stub_trials}
    monkeypatch.setattr(run_mod.report, "run_all", lambda store: stub_report)

    # 1. Run via clean git runner
    ret = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
            "--out",
            str(out_path),
        ],
        runner=runner,
        store_factory=FakeStoreForRun,
    )
    assert ret == 0
    assert out_path.is_file()

    captured = capsys.readouterr()
    lines = [ln.strip() for ln in captured.out.splitlines() if ln.strip()]
    assert len(lines) == len(lock.TRIAL_IDS)
    for tid, line in zip(lock.TRIAL_IDS, lines, strict=True):
        assert line == f"{tid} clusters=45 mean=+0.0009 bound=+0.0003 passed=True"

    payload = json.loads(out_path.read_text(encoding="utf-8"))

    # Expected top-level keys
    expected_keys = {
        "constants",
        "files_read",
        "fold_manifest_sha256",
        "fold_trades_sha256",
        "funding_manifest_sha256",
        "hard_last_date",
        "ledger_id",
        "lighter_lock_sha256",
        "liq_manifest_sha256",
        "lock",
        "lock_digest",
        "markets_sha256",
        "panel_manifest_sha256",
        "prediction",
        "report",
        "versions",
    }
    assert set(payload.keys()) == expected_keys

    assert payload["ledger_id"] == lock.LEDGER_ID
    assert payload["hard_last_date"] == lock.HARD_LAST_DATE.isoformat()
    assert payload["prediction"] == lock.PREDICTION
    assert payload["lock"]["digest"] == lock.lock_digest()
    assert payload["lock"]["git_head"] == runner.head
    assert payload["lock"]["attested_by_environment"] is False
    assert payload["files_read"] == {"panel/market=1.parquet": "dummy_panel_sha256"}
    assert payload["report"] == stub_report

    # Check constants match lock.py
    consts = payload["constants"]
    assert consts["BURST_MIN_USD"] == lock.BURST_MIN_USD
    assert consts["BURST_MIN_ROWS"] == lock.BURST_MIN_ROWS
    assert consts["ENTRY_PROFILE_MIN"] == list(lock.ENTRY_PROFILE_MIN)
    assert consts["EXIT_OFFSETS_MIN"] == list(lock.EXIT_OFFSETS_MIN)

    # 2. A second run with the same --out exits 2
    ret2 = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
            "--out",
            str(out_path),
        ],
        runner=runner,
        store_factory=FakeStoreForRun,
    )
    assert ret2 == 2

    # 3. Attested environment path
    def failing_runner(cmd: list[str], cwd: Any = None) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, returncode=1, stdout="", stderr="git error")

    monkeypatch.setenv("HORIZON_GIT_HEAD", "attested_commit_abcdef")
    monkeypatch.setenv("HORIZON_TREE_CLEAN", "1")

    out_attested = tmp_path / "result_attested.json"
    ret_attested = main(
        [
            "run",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
            "--anchor",
            str(anchor_path),
            "--out",
            str(out_attested),
        ],
        runner=failing_runner,
        store_factory=FakeStoreForRun,
    )
    assert ret_attested == 0
    payload_attested = json.loads(out_attested.read_text(encoding="utf-8"))
    assert payload_attested["lock"]["attested_by_environment"] is True
    assert payload_attested["lock"]["git_head"] == "attested_commit_abcdef"


# -------------------------------------------------------------------------------------------------------------------
# (4) event-count tests
# -------------------------------------------------------------------------------------------------------------------


def test_event_count_on_fake_store_never_touches_fills(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """event-count prints counts and never touches fills or simulate_trade."""
    env = _setup_test_env(tmp_path, monkeypatch)

    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 4_500)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 1_000 * lock.MINUTE_MS)

    md = make_test_md(n_min=4_500, market_id=1, symbol="BTC")
    for m in range(4_500):
        md.present[m] = True
        md.buy_usd[m] = 500.0
        md.sell_usd[m] = 500.0
        md.last_px[m] = 100.0
        ts = md.ms_of(m) + 600.0
        md.last_buy_px[m] = 100.0
        md.last_buy_ts[m] = ts
        md.last_sell_px[m] = 100.0
        md.last_sell_ts[m] = ts

    # Burst 1: minute 200-202 (warm-up, < EVENTS_FROM_MS)
    md.liq_sell_usd[200:203] = 50_000.0
    md.n_liq_sell[200:203] = 1

    # Burst 2: minute 1500-1502 (traded, eligible)
    md.liq_sell_usd[1500:1503] = 50_000.0
    md.n_liq_sell[1500:1503] = 1

    # Burst 3: minute 4450-4452 (traded, drops for span end)
    md.liq_sell_usd[4450:4453] = 50_000.0
    md.n_liq_sell[4450:4453] = 1

    fake_store = FakeStoreForEventCount({1: md})

    # Monkeypatch fills and controls functions to ensure they are never called
    def forbidden_call(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("fill/control function was called during event-count")

    monkeypatch.setattr("horizon.l1.fills.order_fill", forbidden_call)
    monkeypatch.setattr("horizon.l1.fills.simulate_trade", forbidden_call)
    monkeypatch.setattr("horizon.l1.controls.find_controls", forbidden_call)

    ret = main(
        [
            "event-count",
            "--fold-dir",
            str(env["fold_dir"]),
            "--panel-dir",
            str(env["panel_dir"]),
            "--liq-dir",
            str(env["liq_dir"]),
            "--funding-dir",
            str(env["funding_dir"]),
        ],
        store_factory=lambda **kw: fake_store,
    )
    assert ret == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert "markets" in payload
    assert "total" in payload
    assert "1" in payload["markets"]

    m1_s = payload["markets"]["1"]["S"]
    assert m1_s["candidates"] == 3
    assert m1_s["events"] == 3
    assert m1_s["traded_events"] == 2
    assert m1_s["span_end"] == 1
    assert m1_s["eligible"] == 1
    assert m1_s["distinct_days"] == 1
    assert len(m1_s["by_month"]) >= 1


# -------------------------------------------------------------------------------------------------------------------
# (5) panel tests
# -------------------------------------------------------------------------------------------------------------------


def test_panel_summary_and_exit_code_on_scale_jumps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """panel prints summary and exits 1 when manifest has scale jumps, exits 0 when empty."""
    fold_dir = tmp_path / "fold"
    out_dir = tmp_path / "panel_out"
    fold_dir.mkdir()
    out_dir.mkdir()

    # Case 1: scale_jumps non-empty -> exit 1
    manifest_with_jumps = {
        "days": 10,
        "markets": {
            "1": {"rows": 100},
            "2": {"rows": 250},
        },
        "scale_jumps": [[1, 1_700_000_000_000, 2.3]],
    }
    monkeypatch.setattr(run_mod.panel, "build_panel", lambda fold, out: manifest_with_jumps)

    ret1 = main(["panel", "--fold-dir", str(fold_dir), "--out-dir", str(out_dir)])
    assert ret1 == 1

    captured1 = capsys.readouterr()
    summary1 = json.loads(captured1.out.strip())
    assert summary1["days"] == 10
    assert summary1["markets"] == 2
    assert summary1["rows"] == 350
    assert summary1["scale_jumps"] == [[1, 1_700_000_000_000, 2.3]]

    # Case 2: scale_jumps empty -> exit 0
    manifest_clean = {
        "days": 10,
        "markets": {
            "1": {"rows": 100},
            "2": {"rows": 250},
        },
        "scale_jumps": [],
    }
    monkeypatch.setattr(run_mod.panel, "build_panel", lambda fold, out: manifest_clean)

    ret0 = main(["panel", "--fold-dir", str(fold_dir), "--out-dir", str(out_dir)])
    assert ret0 == 0

    captured0 = capsys.readouterr()
    summary0 = json.loads(captured0.out.strip())
    assert summary0["scale_jumps"] == []


# -------------------------------------------------------------------------------------------------------------------
# (6) CLI argument error and --help tests
# -------------------------------------------------------------------------------------------------------------------


def test_cli_bogus_and_help(capsys: pytest.CaptureFixture[str]) -> None:
    """main(['bogus']) returns non-zero without traceback; --help raises SystemExit(0)."""
    # Bogus argument returns 3
    ret = main(["bogus"])
    assert ret != 0
    assert ret == 3
    captured = capsys.readouterr()
    assert "traceback" not in captured.err.lower()

    # No subcommand returns 3
    ret_empty = main([])
    assert ret_empty != 0
    assert ret_empty == 3

    # --help raises SystemExit(0)
    with pytest.raises(SystemExit) as exc_info:
        main(["--help"])
    assert exc_info.value.code == 0

    # Subcommand --help raises SystemExit(0)
    with pytest.raises(SystemExit) as exc_info_sub:
        main(["run", "--help"])
    assert exc_info_sub.value.code == 0
