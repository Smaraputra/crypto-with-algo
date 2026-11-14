"""Tests for horizon-e1 report.py (the four trials, pass clauses, and descriptive tables)."""

from __future__ import annotations

import dataclasses
import json
import math

import numpy as np
import pytest

from horizon.e1 import lock, trade
from horizon.e1.data import Bars, Funding
from horizon.e1.events import Pair, build_pairs
from horizon.e1.report import g0_live_delay_ok, run_trials, to_json_safe


class FakeStore:
    """Duck-typed store providing filtered Bars and Funding."""

    def __init__(
        self,
        bars_map: dict[str, Bars] | None = None,
        funding_map: dict[str, Funding] | None = None,
    ) -> None:
        self._bars = bars_map or {}
        self._funding = funding_map or {}

    def bars(self, symbol: str, start_ms: int, end_ms: int) -> Bars:
        if symbol not in self._bars:
            return Bars.empty()
        return self._bars[symbol].slice_ms(start_ms, end_ms)

    def funding(self, symbol: str, start_ms: int, end_ms: int) -> Funding:
        if symbol not in self._funding:
            return Funding.empty()
        f = self._funding[symbol]
        mask = (f.calc_time >= start_ms) & (f.calc_time <= end_ms)
        return Funding(
            calc_time=f.calc_time[mask],
            interval_hours=f.interval_hours[mask],
            rate=f.rate[mask],
        )


def _make_bars(
    start_ms: int,
    end_ms: int,
    open_p: float = 100.0,
    exit_overrides: dict[int, float] | None = None,
) -> Bars:
    """Create 1m bars from start_ms to end_ms with flat price and optional exit open prices."""
    times = list(range(start_ms, end_ms + 1, lock.MINUTE_MS))
    n = len(times)
    opens = np.full(n, open_p, dtype=np.float64)
    highs = np.full(n, open_p, dtype=np.float64)
    lows = np.full(n, open_p, dtype=np.float64)
    closes = np.full(n, open_p, dtype=np.float64)
    vols = np.full(n, 1.0, dtype=np.float64)

    if exit_overrides:
        time_to_idx = {t: i for i, t in enumerate(times)}
        for t, price in exit_overrides.items():
            if t in time_to_idx:
                idx = time_to_idx[t]
                opens[idx] = price
                highs[idx] = price
                lows[idx] = price
                closes[idx] = price

    return Bars(
        open_time=np.array(times, dtype=np.int64),
        open=opens,
        high=highs,
        low=lows,
        close=closes,
        volume=vols,
    )


def test_horizon_e1_report_synthetic() -> None:
    """Test full four-trial report generation on a small synthetic world."""
    base_ms = 1_700_000_000_000  # 2023-11-14 22:13:20 UTC
    m_start_1 = (base_ms // lock.MINUTE_MS) * lock.MINUTE_MS
    m0_1 = m_start_1 + lock.MINUTE_MS

    stamp_2 = base_ms + 48 * lock.HOUR_MS
    m_start_2 = (stamp_2 // lock.MINUTE_MS) * lock.MINUTE_MS
    m0_2 = m_start_2 + lock.MINUTE_MS

    stamp_3 = base_ms + 96 * lock.HOUR_MS
    m_start_3 = (stamp_3 // lock.MINUTE_MS) * lock.MINUTE_MS
    m0_3 = m_start_3 + lock.MINUTE_MS

    # Synthetic record with 2 class T notices and 1 class D notice
    record = {
        "meta": {"freeze_ms": lock.FREEZE_MS, "from_ms": lock.EVENTS_FROM_MS},
        "archive": {},
        "btc": {"first": "2023-01-01", "last": "2026-11-12"},
        "audit": {},
        "events": [
            {
                "cls": "tag",
                "code": "code_t1",
                "ms": base_ms,
                "day": "2023-11-14",
                "title": "Monitoring tag notice 1",
                "tokens": ["TOK1", "TOK2", "TOK3", "TOKD1"],
                "source": "news",
                "perp": {
                    "TOK1": {
                        "symbol": "TOK1USDT",
                        "reason": "covers-stamp",
                        "missing_days": [],
                        "btc_missing_days": [],
                    },
                    "TOK2": {
                        "symbol": "TOK2USDT",
                        "reason": "covers-stamp",
                        "missing_days": [],
                        "btc_missing_days": [],
                    },
                    "TOK3": {"symbol": None, "reason": "no-archive-symbol"},
                    "TOKD1": {
                        "symbol": "TOKD1USDT",
                        "reason": "covers-stamp",
                        "missing_days": [],
                        "btc_missing_days": [],
                    },
                },
            },
            {
                "cls": "tag",
                "code": "code_t2",
                "ms": stamp_2,
                "day": "2023-11-16",
                "title": "Monitoring tag notice 2",
                "tokens": ["TOK4", "TOK5", "TOK6"],
                "source": "news",
                "perp": {
                    "TOK4": {
                        "symbol": "TOK4USDT",
                        "reason": "covers-stamp",
                        "missing_days": [],
                        "btc_missing_days": [],
                    },
                    "TOK5": {
                        "symbol": "TOK5USDT",
                        "reason": "covers-stamp",
                        "missing_days": [],
                        "btc_missing_days": [],
                    },
                    "TOK6": {"symbol": None, "reason": "no-archive-symbol"},
                },
            },
            {
                "cls": "delist",
                "code": "code_d1",
                "ms": stamp_3,
                "day": "2023-11-18",
                "title": "Delist notice 1",
                "tokens": ["TOKD1", "TOKD2"],
                "source": "delist",
                "perp": {
                    "TOKD1": {
                        "symbol": "TOKD1USDT",
                        "reason": "covers-stamp",
                        "missing_days": [],
                        "btc_missing_days": [],
                    },
                    "TOKD2": {
                        "symbol": "TOKD2USDT",
                        "reason": "covers-stamp",
                        "missing_days": ["2023-11-17"],
                        "btc_missing_days": [],
                    },
                },
            },
        ],
        "futures_delist": [
            {
                "code": "fd_1",
                "ms": base_ms + 2 * lock.HOUR_MS,
                "symbols": ["TOK1USDT"],
                "title": "Futures delist notice for TOK1",
            }
        ],
    }

    pairs = build_pairs(record)

    # Hand-computed exit times for 4h and 24h horizons across all delay profile delays
    exit_overrides: dict[int, float] = {}
    for m0_val in (m0_1, m0_2, m0_3):
        for d in lock.DELAY_PROFILE_MINUTES:
            entry = m0_val + d * lock.MINUTE_MS
            for h in lock.HORIZONS_HOURS:
                te = entry + h * lock.HOUR_MS
                exit_overrides[te] = 90.0

    # Build bars for each symbol
    bars_map: dict[str, Bars] = {}
    total_start = m_start_1 - lock.ACTIVITY_WINDOW_MINUTES * lock.MINUTE_MS
    total_end = stamp_3 + 30 * lock.HOUR_MS

    # BTCUSDT is flat at 30,000.0 everywhere
    bars_map["BTCUSDT"] = _make_bars(total_start, total_end, open_p=30000.0)

    # TOK1, TOK4, TOKD1 have normal activity and fall 10% (100 -> 90) at exits
    bars_map["TOK1USDT"] = _make_bars(total_start, total_end, open_p=100.0, exit_overrides=exit_overrides)
    bars_map["TOK4USDT"] = _make_bars(total_start, total_end, open_p=100.0, exit_overrides=exit_overrides)
    bars_map["TOKD1USDT"] = _make_bars(total_start, total_end, open_p=100.0, exit_overrides=exit_overrides)

    # TOK2: activity failure (only 100 traded minutes in [M - 1440, M))
    times_tok2 = list(range(m_start_1 - 100 * lock.MINUTE_MS, total_end, lock.MINUTE_MS))
    bars_map["TOK2USDT"] = Bars(
        open_time=np.array(times_tok2, dtype=np.int64),
        open=np.full(len(times_tok2), 100.0, dtype=np.float64),
        high=np.full(len(times_tok2), 100.0, dtype=np.float64),
        low=np.full(len(times_tok2), 100.0, dtype=np.float64),
        close=np.full(len(times_tok2), 100.0, dtype=np.float64),
        volume=np.full(len(times_tok2), 1.0, dtype=np.float64),
    )

    # TOK5: entry_bar failure (entry bar at m0_2 + 1m has volume 0.0)
    tok5_bars = _make_bars(total_start, total_end, open_p=100.0, exit_overrides=exit_overrides)
    entry_tok5 = m0_2 + lock.MINUTE_MS
    idx_entry = tok5_bars.index_of(entry_tok5)
    tok5_vols = np.array(tok5_bars.volume, copy=True)
    tok5_vols[idx_entry] = 0.0
    bars_map["TOK5USDT"] = Bars(
        open_time=tok5_bars.open_time,
        open=tok5_bars.open,
        high=tok5_bars.high,
        low=tok5_bars.low,
        close=tok5_bars.close,
        volume=tok5_vols,
    )

    store = FakeStore(bars_map=bars_map, funding_map={})

    # Run trials with fixed seed
    res1 = run_trials(record, pairs, store, seed=lock.BOOT_SEED)
    res2 = run_trials(record, pairs, store, seed=lock.BOOT_SEED)

    # 1. Status counts per class
    # Class T: 4 pairs with symbol (TOK1, TOK2, TOKD1, TOK4, TOK5), wait: TOKD1 was in notice 1
    # Notice 1 has TOK1, TOK2, TOK3, TOKD1. Notice 2 has TOK4, TOK5, TOK6. Total 7 tokens.
    # TOK3, TOK6 have no symbol (2). None have pending delist (0). None have data_missing (0).
    # eligible_by_record: 5.
    st_t = res1["record_status_counts"]["T"]
    assert st_t["no_symbol"] == 2
    assert st_t["futures_delist_pending"] == 0
    assert st_t["data_missing"] == 0
    assert st_t["eligible_by_record"] == 5

    st_d = res1["record_status_counts"]["D"]
    assert st_d["no_symbol"] == 0
    assert st_d["futures_delist_pending"] == 0
    assert st_d["data_missing"] == 1
    assert st_d["eligible_by_record"] == 1

    # 2. Exclusion counts for Class T (trial T-4h): TOK2 fails activity, TOK5 fails entry_bar
    t4 = res1["trials"]["T-4h"]
    assert t4["counts"]["ok"] == 3  # TOK1, TOKD1 (notice 1), TOK4 (notice 2)
    assert t4["counts"]["exclusions"]["activity"] == 1
    assert t4["counts"]["exclusions"]["entry_bar"] == 1
    assert t4["counts"]["exclusions"]["btc_missing"] == 0

    # 3. Unit and cluster counts
    # Notice 1 has 2 ok tokens (TOK1, TOKD1) -> 1 unit. Notice 2 has 1 ok token (TOK4) -> 1 unit.
    # Units at m0_1 and m0_2 are 48h apart -> 2 clusters.
    assert t4["counts"]["units"] == 2
    assert t4["counts"]["clusters"] == 2

    # 4. Judged mean equals hand-computed value to 1e-12
    # Hand calculation:
    # Gross token = (100 - 90)/100 = 0.10, Gross btc = 0.0
    # Fees = 5e-4 * (1 + 0.90 + 1 + 1) = 0.0005 * 3.9 = 0.00195
    # Slip token = 10e-4 * (1.0 + 0.90) = 0.0019, Slip btc = 1e-4 * (1.0 + 1.0) = 0.0002 -> Slip = 0.0021
    # Funding = 0.0
    # Net = 0.10 - 0.00195 - 0.0021 = 0.09595
    expected_net = 0.09595
    assert math.isclose(t4["judgement"]["mean"], expected_net, abs_tol=1e-12)

    # 5. Excluded share by rule 9(e)
    # For Class T:
    # data_missing = 0, entry_bar = 1, btc_missing = 0. Numerator = 1.
    # ok = 3. Denominator = 0 + 3 + 1 + 0 = 4. (Activity failure excluded from denominator!)
    # share = 1 / 4 = 0.25.
    assert math.isclose(t4["judgement"]["excluded_share"], 0.25, abs_tol=1e-12)

    # For Class D (trial D-4h):
    # TOKD1 ok (1), TOKD2 data_missing (1). Numerator = 1, Denominator = 1 + 1 = 2 -> share = 0.5.
    d4 = res1["trials"]["D-4h"]
    assert math.isclose(d4["judgement"]["excluded_share"], 0.5, abs_tol=1e-12)

    # 6. Generator trial order reproducibility: identical judgements across all four trials
    for tid in lock.TRIAL_IDS:
        assert res1["trials"][tid]["judgement"] == res2["trials"][tid]["judgement"]

    # 7. delay_profile has five delays and delay 6 matches hand calculation
    assert len(t4["delay_profile"]) == 5
    assert "6" in t4["delay_profile"]
    assert math.isclose(t4["delay_profile"]["6"]["mean"], expected_net, abs_tol=1e-12)
    assert math.isclose(t4["delay_profile_live_mean"], expected_net, abs_tol=1e-12)

    # 8. g0_ready is False for a failing trial (clusters = 2 < lock.MIN_CLUSTERS = 10)
    assert not t4["judgement"]["passed"]
    assert not t4["g0_ready"]
    assert not g0_live_delay_ok(t4)

    # 9. futures_delist_before_exit for TOK1
    fd = t4["futures_delist_before_exit"]
    assert fd["count"] == 1
    assert fd["items"][0]["token"] == "TOK1"
    assert fd["items"][0]["code"] == "fd_1"
    assert math.isclose(fd["items"][0]["hours_after_stamp"], 2.0, abs_tol=1e-12)

    # 10. tag_overlap for Class D
    tag_ov = d4["tag_overlap"]
    # TOKD1 was tagged in Notice 1, TOKD2 had data_missing (not in class T)
    # D tokens with symbol: TOKD1, TOKD2 (2). Previously tagged: TOKD1 (1).
    assert math.isclose(tag_ov["share_previously_tagged"], 0.5, abs_tol=1e-12)
    assert len(tag_ov["first_tag_lags"]) == 1
    assert math.isclose(tag_ov["first_tag_lags"][0], 4.0, abs_tol=1e-12)
    assert math.isclose(tag_ov["median_first_tag_lag"], 4.0, abs_tol=1e-12)

    # 11. JSON serialization without error and no NaN or inf tokens
    json_str = json.dumps(res1)
    assert "NaN" not in json_str
    assert "Infinity" not in json_str
    assert "-Infinity" not in json_str
    loaded = json.loads(json_str)
    assert isinstance(loaded, dict)
    assert "trials" in loaded
    assert "pairs_rows" in loaded
    assert len(loaded["pairs_rows"]) > 0

    # 12. Rule 2: pairs the record excludes are listed with their reason (TOK3 and TOK6 have no symbol)
    t4_rows = [r for r in res1["pairs_rows"] if r["trial_id"] == "T-4h"]
    record_excluded = {(r["token"], r["reason"]) for r in t4_rows if r["status"] == "record_excluded"}
    assert record_excluded == {("TOK3", "no_symbol"), ("TOK6", "no_symbol")}
    assert {r["token"] for r in t4_rows if r["status"] == "ok"} == {"TOK1", "TOKD1", "TOK4"}

    # 13. Reconciliation with the preprint's Table 1: 2023 holds 2 announcements and 7 tokens of the synthetic record
    rec_2023 = res1["reconciliation"]["2023"]
    assert rec_2023["record_announcements"] == 2
    assert rec_2023["record_first_time_tags"] == 7
    assert (rec_2023["preprint_announcements"], rec_2023["preprint_first_time_tags"]) == (2, 23)
    assert res1["reconciliation"]["2026"]["record_first_time_tags"] == 0
    assert res1["reconciliation"]["2026"]["preprint_first_time_tags"] == 61


def test_to_json_safe_keeps_bools_and_turns_nan_into_null() -> None:
    out = to_json_safe({"a": True, "b": np.bool_(False), "c": 3, "d": float("nan"), "e": np.int64(7), "f": [True, 1]})
    assert out == {"a": True, "b": False, "c": 3, "d": None, "e": 7, "f": [True, 1]}
    assert out["a"] is True
    assert out["b"] is False
    assert out["f"][0] is True
    assert type(out["f"][1]) is int


def _stub_pair(token: str = "STUB", code: str = "n1", stamp_ms: int = 1_700_000_000_000) -> Pair:
    return Pair(
        cls=lock.CLASS_T,
        code=code,
        stamp_ms=stamp_ms,
        day="2023-11-14",
        token=token,
        symbol=f"{token}USDT",
        reason="covers-stamp",
        missing_days=(),
        btc_missing_days=(),
        pending_notice=None,
    )


def test_delay_profile_passes_the_delay_to_the_simulation(monkeypatch: pytest.MonkeyPatch) -> None:
    """The profile entry for delay d must come from a simulation run at delay d (a stub makes net depend on d)."""
    template = trade._make_excluded("STUB", "STUBUSDT", 4, 1, "activity", 0, 0)

    def fake_simulate(pair, store, horizon_hours, delay_minutes=lock.ENTRY_DELAY_MINUTES):
        return dataclasses.replace(
            template,
            status="ok",
            reason=None,
            horizon_hours=horizon_hours,
            delay_minutes=delay_minutes,
            entry_ms=pair.stamp_ms + delay_minutes * lock.MINUTE_MS,
            net=0.05 - 0.001 * delay_minutes,
            max_adverse=0.1,
        )

    monkeypatch.setattr(trade, "simulate", fake_simulate)
    record = {"events": [], "futures_delist": []}
    res = run_trials(record, [_stub_pair()], store=None)
    t4 = res["trials"]["T-4h"]
    for d in lock.DELAY_PROFILE_MINUTES:
        assert t4["delay_profile"][str(d)]["delay_minutes"] == d
        assert t4["delay_profile"][str(d)]["mean"] == pytest.approx(0.05 - 0.001 * d, abs=1e-12)
        assert t4["delay_profile"][str(d)]["n_clusters"] == 1
    assert t4["delay_profile_live_mean"] == pytest.approx(0.044, abs=1e-12)
    assert t4["judgement"]["passed"] is False
    assert t4["g0_ready"] is False


def test_excluded_share_is_null_when_nothing_could_be_judged(monkeypatch: pytest.MonkeyPatch) -> None:
    """A class with no pair has no denominator for clause (e): the share is null and the clause fails."""
    template = trade._make_excluded("STUB", "STUBUSDT", 4, 1, "activity", 0, 0)
    monkeypatch.setattr(trade, "simulate", lambda *a, **k: template)
    res = run_trials({"events": [], "futures_delist": []}, [_stub_pair()], store=None)
    d4 = res["trials"]["D-4h"]["judgement"]
    assert d4["excluded_share"] is None
    assert d4["clause_e"] is False
    assert d4["n_clusters"] == 0
    assert d4["passed"] is False
