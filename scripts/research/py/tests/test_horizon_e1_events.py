"""Tests for horizon-e1 events loading, pairs, record status, and fetch plan."""

from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
from pathlib import Path

import pytest

from horizon.e1 import events as ev_mod
from horizon.e1 import lock


def make_record(
    *,
    events: list[dict] | None = None,
    archive: dict | None = None,
    btc: dict | None = None,
    audit: list[dict] | None = None,
    futures_delist: list[dict] | None = None,
    meta: dict | None = None,
) -> dict:
    if meta is None:
        meta = {
            "articles": 10,
            "catalogs": {},
            "delist_notices": 0,
            "freeze_ms": lock.FREEZE_MS,
            "from_ms": lock.EVENTS_FROM_MS,
            "intro_body_text_sha256": "dummy",
            "intro_code": "dummy",
            "scan_utc": "2026-11-13T00:00:00Z",
            "tag_notices": 0,
            "unclassified_titles": 0,
        }
    return {
        "meta": meta,
        "events": [] if events is None else events,
        "archive": {} if archive is None else archive,
        "btc": {"first": "2020-01-01", "last": "2026-11-12", "missing_days": [], "n_days": 2500, "symbol": "BTCUSDT"}
        if btc is None
        else btc,
        "audit": [] if audit is None else audit,
        "futures_delist": [] if futures_delist is None else futures_delist,
    }


def test_build_pairs_synthetic():
    t1_ms = lock.EVENTS_FROM_MS + 10_000
    t2_ms = lock.EVENTS_FROM_MS + 20_000
    d1_ms = lock.EVENTS_FROM_MS + 30_000

    t1_day = dt.datetime.fromtimestamp(t1_ms / 1000, tz=dt.UTC).strftime("%Y-%m-%d")
    t2_day = dt.datetime.fromtimestamp(t2_ms / 1000, tz=dt.UTC).strftime("%Y-%m-%d")
    d1_day = dt.datetime.fromtimestamp(d1_ms / 1000, tz=dt.UTC).strftime("%Y-%m-%d")

    ev1 = {
        "cls": "tag",
        "code": "t_code_1",
        "ms": t1_ms,
        "title": "Tag 1",
        "tokens": ["ALPHA", "BETA"],
        "source": "title",
        "day": t1_day,
        "perp": {
            "ALPHA": {
                "symbol": "ALPHAUSDT",
                "reason": "covers-stamp",
                "missing_days": ["2022-01-02"],
                "btc_missing_days": [],
                "futures_delist_pending": None,
            },
            "BETA": {
                "symbol": None,
                "reason": "no-archive-symbol",
            },
        },
    }
    ev2 = {
        "cls": "tag",
        "code": "t_code_2",
        "ms": t2_ms,
        "title": "Tag 2",
        "tokens": ["ALPHA", "GAMMA"],
        "source": "title",
        "day": t2_day,
        "perp": {
            "ALPHA": {
                "symbol": "ALPHAUSDT",
                "reason": "covers-stamp",
                "missing_days": [],
                "btc_missing_days": [],
                "futures_delist_pending": None,
            },
            "GAMMA": {
                "symbol": "GAMMAUSDT",
                "reason": "covers-stamp",
                "missing_days": [],
                "btc_missing_days": [],
                "futures_delist_pending": None,
            },
        },
    }
    ev3 = {
        "cls": "delist",
        "code": "d_code_1",
        "ms": d1_ms,
        "title": "Delist 1",
        "tokens": ["ALPHA"],
        "source": "title",
        "day": d1_day,
        "perp": {
            "ALPHA": {
                "symbol": "ALPHAUSDT",
                "reason": "covers-stamp",
                "missing_days": [],
                "btc_missing_days": [],
                "futures_delist_pending": None,
            }
        },
    }

    record = make_record(events=[ev1, ev2, ev3])
    pairs = ev_mod.build_pairs(record)

    # ALPHA appears once in T at t1_ms, once in D at d1_ms
    # BETA appears once in T at t1_ms
    # GAMMA appears once in T at t2_ms
    assert len(pairs) == 4

    expected_order = [
        (lock.CLASS_T, t1_ms, "t_code_1", "ALPHA"),
        (lock.CLASS_T, t1_ms, "t_code_1", "BETA"),
        (lock.CLASS_T, t2_ms, "t_code_2", "GAMMA"),
        (lock.CLASS_D, d1_ms, "d_code_1", "ALPHA"),
    ]
    observed_order = [(p.cls, p.stamp_ms, p.code, p.token) for p in pairs]
    assert observed_order == expected_order

    beta_pair = next(p for p in pairs if p.token == "BETA")
    assert beta_pair.symbol is None
    assert beta_pair.missing_days == ()
    assert beta_pair.btc_missing_days == ()
    assert beta_pair.pending_notice is None


def test_load_record_validations(tmp_path: Path):
    rec_path = tmp_path / "rec.json"
    valid_ms = lock.EVENTS_FROM_MS + 10_000
    valid_day = dt.datetime.fromtimestamp(valid_ms / 1000, tz=dt.UTC).strftime("%Y-%m-%d")

    base_event = {
        "cls": "tag",
        "code": "c1",
        "ms": valid_ms,
        "title": "T1",
        "tokens": ["TOK"],
        "source": "title",
        "day": valid_day,
        "perp": {"TOK": {"symbol": "TOKUSDT", "reason": "covers-stamp"}},
    }

    def write_and_load(d: dict):
        rec_path.write_text(json.dumps(d), encoding="utf-8")
        return ev_mod.load_record(rec_path)

    # 1. Wrong freeze_ms
    d = make_record(events=[base_event])
    d["meta"]["freeze_ms"] = lock.FREEZE_MS + 1000
    with pytest.raises(ev_mod.RecordError, match="meta freeze_ms mismatch"):
        write_and_load(d)

    # 2. Stamp at exactly lock.FREEZE_MS
    ev_at_freeze = copy.deepcopy(base_event)
    ev_at_freeze["ms"] = lock.FREEZE_MS
    ev_at_freeze["day"] = dt.datetime.fromtimestamp(lock.FREEZE_MS / 1000, tz=dt.UTC).strftime("%Y-%m-%d")
    with pytest.raises(ev_mod.RecordError, match="out of bounds"):
        write_and_load(make_record(events=[ev_at_freeze]))

    # 3. Stamp one millisecond before lock.EVENTS_FROM_MS
    ev_before = copy.deepcopy(base_event)
    ev_before["ms"] = lock.EVENTS_FROM_MS - 1
    ev_before["day"] = dt.datetime.fromtimestamp((lock.EVENTS_FROM_MS - 1) / 1000, tz=dt.UTC).strftime("%Y-%m-%d")
    with pytest.raises(ev_mod.RecordError, match="out of bounds"):
        write_and_load(make_record(events=[ev_before]))

    # 4. Unknown cls
    ev_bad_cls = copy.deepcopy(base_event)
    ev_bad_cls["cls"] = "unknown_cls"
    with pytest.raises(ev_mod.RecordError, match="unknown cls"):
        write_and_load(make_record(events=[ev_bad_cls]))

    # 5. Duplicate code
    ev_dup1 = copy.deepcopy(base_event)
    ev_dup2 = copy.deepcopy(base_event)
    ev_dup2["ms"] = valid_ms + 1000
    ev_dup2["day"] = dt.datetime.fromtimestamp(ev_dup2["ms"] / 1000, tz=dt.UTC).strftime("%Y-%m-%d")
    with pytest.raises(ev_mod.RecordError, match="duplicate event code"):
        write_and_load(make_record(events=[ev_dup1, ev_dup2]))

    # 6. Unsorted event list
    ev_s1 = copy.deepcopy(base_event)
    ev_s1["code"] = "code_a"
    ev_s1["ms"] = valid_ms + 5000
    ev_s1["day"] = dt.datetime.fromtimestamp(ev_s1["ms"] / 1000, tz=dt.UTC).strftime("%Y-%m-%d")

    ev_s2 = copy.deepcopy(base_event)
    ev_s2["code"] = "code_b"
    ev_s2["ms"] = valid_ms + 1000
    ev_s2["day"] = dt.datetime.fromtimestamp(ev_s2["ms"] / 1000, tz=dt.UTC).strftime("%Y-%m-%d")

    with pytest.raises(ev_mod.RecordError, match="events not sorted"):
        write_and_load(make_record(events=[ev_s1, ev_s2]))

    # 7. Day does not match stamp
    ev_bad_day = copy.deepcopy(base_event)
    ev_bad_day["day"] = "2020-01-01"
    with pytest.raises(ev_mod.RecordError, match="does not match ms UTC day"):
        write_and_load(make_record(events=[ev_bad_day]))

    # 8. Token with no perp entry
    ev_no_perp = copy.deepcopy(base_event)
    ev_no_perp["tokens"] = ["TOK", "OTHER"]
    with pytest.raises(ev_mod.RecordError, match="missing from perp"):
        write_and_load(make_record(events=[ev_no_perp]))


def test_record_status():
    # 1. no_symbol
    p1 = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="c1",
        stamp_ms=1000,
        day="2024-01-01",
        token="TOK",
        symbol=None,
        reason="no-archive-symbol",
        missing_days=(),
        btc_missing_days=(),
        pending_notice=None,
    )
    assert ev_mod.record_status(p1) == "no_symbol"

    p1_pending = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="c1",
        stamp_ms=1000,
        day="2024-01-01",
        token="TOK",
        symbol=None,
        reason="no-archive-symbol",
        missing_days=(),
        btc_missing_days=(),
        pending_notice="fnotice",
    )
    assert ev_mod.record_status(p1_pending) == "no_symbol"

    # 2. futures_delist_pending
    p2 = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="c2",
        stamp_ms=1000,
        day="2024-01-01",
        token="TOK",
        symbol="TOKUSDT",
        reason="covers-stamp",
        missing_days=(),
        btc_missing_days=(),
        pending_notice="fnotice123",
    )
    assert ev_mod.record_status(p2) == "futures_delist_pending"

    p2_and_3 = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="c2",
        stamp_ms=1000,
        day="2024-01-01",
        token="TOK",
        symbol="TOKUSDT",
        reason="covers-stamp",
        missing_days=("2024-01-02",),
        btc_missing_days=(),
        pending_notice="fnotice123",
    )
    assert ev_mod.record_status(p2_and_3) == "futures_delist_pending"

    # 3. data_missing
    p3_tok = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="c3",
        stamp_ms=1000,
        day="2024-01-01",
        token="TOK",
        symbol="TOKUSDT",
        reason="covers-stamp",
        missing_days=("2024-01-02",),
        btc_missing_days=(),
        pending_notice=None,
    )
    assert ev_mod.record_status(p3_tok) == "data_missing"

    p3_btc = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="c3",
        stamp_ms=1000,
        day="2024-01-01",
        token="TOK",
        symbol="TOKUSDT",
        reason="covers-stamp",
        missing_days=(),
        btc_missing_days=("2024-01-02",),
        pending_notice=None,
    )
    assert ev_mod.record_status(p3_btc) == "data_missing"

    # 4. Clean pair
    p_clean = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="c4",
        stamp_ms=1000,
        day="2024-01-01",
        token="TOK",
        symbol="TOKUSDT",
        reason="covers-stamp",
        missing_days=(),
        btc_missing_days=(),
        pending_notice=None,
    )
    assert ev_mod.record_status(p_clean) is None


def test_build_fetch_plan_synthetic():
    p1 = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="code1",
        stamp_ms=int(dt.datetime(2026, 10, 31, 12, 0, tzinfo=dt.UTC).timestamp() * 1000),
        day="2026-10-31",
        token="TOKA",
        symbol="TOKAUSDT",
        reason="covers-stamp",
        missing_days=(),
        btc_missing_days=(),
        pending_notice=None,
    )

    p2 = ev_mod.Pair(
        cls=lock.CLASS_D,
        code="code2",
        stamp_ms=int(dt.datetime(2024, 5, 10, 12, 0, tzinfo=dt.UTC).timestamp() * 1000),
        day="2024-05-10",
        token="TOKB",
        symbol="TOKBUSDT",
        reason="covers-stamp",
        missing_days=(),
        btc_missing_days=(),
        pending_notice=None,
    )

    p3 = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="code3",
        stamp_ms=int(dt.datetime(2026, 11, 11, 12, 0, tzinfo=dt.UTC).timestamp() * 1000),
        day="2026-11-11",
        token="TOKC",
        symbol="TOKCUSDT",
        reason="covers-stamp",
        missing_days=(),
        btc_missing_days=(),
        pending_notice=None,
    )

    p4_pending = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="code4",
        stamp_ms=int(dt.datetime(2024, 6, 1, 12, 0, tzinfo=dt.UTC).timestamp() * 1000),
        day="2024-06-01",
        token="TOKD",
        symbol="TOKDUSDT",
        reason="covers-stamp",
        missing_days=(),
        btc_missing_days=(),
        pending_notice="pend123",
    )

    p5_missing = ev_mod.Pair(
        cls=lock.CLASS_T,
        code="code5",
        stamp_ms=int(dt.datetime(2024, 6, 1, 12, 0, tzinfo=dt.UTC).timestamp() * 1000),
        day="2024-06-01",
        token="TOKE",
        symbol="TOKEUSDT",
        reason="covers-stamp",
        missing_days=("2024-06-01",),
        btc_missing_days=(),
        pending_notice=None,
    )

    archive = {
        "TOKA": {"candidates": [{"symbol": "TOKAUSDT", "first": "2026-01-01", "last": "2026-11-12"}]},
        "TOKB": {"candidates": [{"symbol": "TOKBUSDT", "first": "2024-05-10", "last": "2024-05-11"}]},
        "TOKC": {"candidates": [{"symbol": "TOKCUSDT", "first": "2026-01-01", "last": "2026-11-30"}]},
        "TOKD": {"candidates": [{"symbol": "TOKDUSDT", "first": "2024-01-01", "last": "2026-11-12"}]},
        "TOKE": {"candidates": [{"symbol": "TOKEUSDT", "first": "2024-01-01", "last": "2026-11-12"}]},
    }
    btc = {"symbol": "BTCUSDT", "first": "2020-01-01", "last": "2026-11-12", "missing_days": []}
    record = make_record(archive=archive, btc=btc)

    pairs = [p1, p2, p3, p4_pending, p5_missing]
    plan = ev_mod.build_fetch_plan(record, pairs)

    assert plan["version"] == 1

    toka_days = [k["day"] for k in plan["klines"] if k["symbol"] == "TOKAUSDT"]
    assert toka_days == ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]

    tokb_days = [k["day"] for k in plan["klines"] if k["symbol"] == "TOKBUSDT"]
    assert tokb_days == ["2024-05-10", "2024-05-11"]

    tokc_days = [k["day"] for k in plan["klines"] if k["symbol"] == "TOKCUSDT"]
    assert tokc_days == ["2026-11-10", "2026-11-11", "2026-11-12"]

    all_syms = {k["symbol"] for k in plan["klines"]}
    assert "TOKDUSDT" not in all_syms
    assert "TOKEUSDT" not in all_syms

    btc_days = [k["day"] for k in plan["klines"] if k["symbol"] == "BTCUSDT"]
    expected_btc_days = sorted(
        {
            "2026-10-30",
            "2026-10-31",
            "2026-11-01",
            "2026-11-02",
            "2024-05-09",
            "2024-05-10",
            "2024-05-11",
            "2024-05-12",
            "2026-11-10",
            "2026-11-11",
            "2026-11-12",
        }
    )
    assert btc_days == expected_btc_days

    toka_months = [f["month"] for f in plan["funding"] if f["symbol"] == "TOKAUSDT"]
    assert toka_months == ["2026-10", "2026-11"]

    kline_keys = [(k["symbol"], k["day"]) for k in plan["klines"]]
    assert kline_keys == sorted(kline_keys)
    funding_keys = [(f["symbol"], f["month"]) for f in plan["funding"]]
    assert funding_keys == sorted(funding_keys)

    b = ev_mod.plan_bytes(plan)
    expected_sha = hashlib.sha256(b).hexdigest()
    assert ev_mod.plan_sha256(plan) == expected_sha


def test_real_record():
    path = Path(__file__).resolve().parents[1] / "records" / "horizon_e1_events.json"
    record = ev_mod.load_record(path)
    assert record is not None

    pairs = ev_mod.build_pairs(record)
    t_pairs = [p for p in pairs if p.cls == lock.CLASS_T]
    d_pairs = [p for p in pairs if p.cls == lock.CLASS_D]

    assert len(t_pairs) == 166
    assert sum(1 for p in t_pairs if p.symbol is not None) == 102
    assert sum(1 for p in d_pairs if p.symbol is not None) == 76

    for p in pairs:
        assert p.pending_notice is None
        assert len(p.missing_days) == 0
        assert len(p.btc_missing_days) == 0
        st = ev_mod.record_status(p)
        assert st in (None, "no_symbol")

    first_tags = ev_mod.first_tag_per_token(pairs)
    assert len(first_tags) == 166

    plan = ev_mod.build_fetch_plan(record, pairs)
    assert plan["version"] == 1

    for k in plan["klines"]:
        assert k["day"] <= "2026-11-12"

    btc_days = [k["day"] for k in plan["klines"] if k["symbol"] == "BTCUSDT"]
    assert len(btc_days) > 0

    pair_symbols = {p.symbol for p in pairs if p.symbol is not None}
    for k in plan["klines"]:
        if k["symbol"] != "BTCUSDT":
            assert k["symbol"] in pair_symbols

    p_bytes = ev_mod.plan_bytes(plan)
    assert ev_mod.plan_sha256(plan) == hashlib.sha256(p_bytes).hexdigest()
