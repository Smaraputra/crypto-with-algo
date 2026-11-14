"""Unit tests for horizon-l1 report.py (the six trials, controls, aggregation and JSON output)."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from horizon.l1 import data as data_mod
from horizon.l1 import lock
from horizon.l1.data import MarketData
from horizon.l1.report import run_all, simulate_account
from horizon.l1.stats import bootstrap_bound, t_bound


class FakeStore:
    """Duck-typed store providing MarketData and funding for horizon-l1 report tests."""

    def __init__(
        self,
        market_data: dict[int, MarketData],
        funding_data: dict[int, tuple[np.ndarray, np.ndarray]] | None = None,
        liq_summary_data: dict[str, Any] | None = None,
    ) -> None:
        self._market_data = market_data
        self._funding = funding_data or {}
        self._liq_summary = liq_summary_data or {
            "days": 1,
            "rows_side_inconsistent": 0,
            "rows_side_unchecked": 0,
            "liquidation_rows": 0,
        }

    def market_ids(self) -> list[int]:
        return sorted(self._market_data.keys())

    def market(self, market_id: int) -> MarketData:
        return self._market_data[market_id]

    def funding(self, market_id: int) -> tuple[np.ndarray, np.ndarray]:
        if market_id in self._funding:
            return self._funding[market_id]
        return np.array([], dtype=np.int64), np.array([], dtype=np.float64)

    def liq_summary(self) -> dict[str, Any]:
        return dict(self._liq_summary)


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


def make_three_event_world() -> FakeStore:
    """Hand-built 4,500-minute world: warm-up and blocked S bursts, two traded S events, one traded B event.

    Needs GRID0_MS 0, N_MIN 4,500 and EVENTS_FROM_MS at minute 1,000 (set by the caller).
    """
    n_min = 4_500
    md = make_test_md(n_min=n_min, market_id=1, symbol="BTC")

    # Baseline active history and prices (flat 100.0)
    for m in range(n_min):
        md.present[m] = True
        md.buy_usd[m] = 500.0
        md.sell_usd[m] = 500.0
        md.last_px[m] = 100.0
        ts = md.ms_of(m) + 600.0
        md.last_buy_px[m] = 100.0
        md.last_buy_ts[m] = ts
        md.last_sell_px[m] = 100.0
        md.last_sell_ts[m] = ts
        md.first_buy_px[m] = 100.0
        md.first_buy_ts[m] = ts
        md.first_sell_px[m] = 100.0
        md.first_sell_ts[m] = ts

    # 1. Day 0 Retrigger candidates (side S):
    # Burst A at [200, 202], E = 203 (< EVENTS_FROM_MS, so not traded)
    md.liq_sell_usd[200:203] = 50_000.0
    md.n_liq_sell[200:203] = 1
    # Burst B at [250, 252]: 250 - 203 = 47 < lock.RETRIGGER_MIN (125), blocked by retrigger
    md.liq_sell_usd[250:253] = 50_000.0
    md.n_liq_sell[250:253] = 1

    # Extra undersized sell burst at [2000, 2002] (< BURST_MIN_USD 100_000, < BURST_MIN_ROWS 3)
    md.liq_sell_usd[2000:2003] = 10_000.0
    md.n_liq_sell[2000:2003] = 1

    # 2. Traded Event 1 (Day 1, side S forced-sell):
    # i0 = 1500, i1 = 1502, e_index = 1503, D = 1508
    md.liq_sell_usd[1500:1503] = 50_000.0
    md.n_liq_sell[1500:1503] = 2
    # At exit offsets h=30 (1533), h=60 (1563), h=120 (1623): price rises to 105.0
    for h in lock.EXIT_OFFSETS_MIN:
        exit_m = 1503 + h
        md.first_sell_px[exit_m] = 105.0
        md.first_buy_px[exit_m] = 105.0
        md.last_px[exit_m] = 105.0

    # 3. Traded Event 2 (Day 2, side S forced-sell):
    # i0 = 3000, i1 = 3002, e_index = 3003, D = 3008
    md.liq_sell_usd[3000:3003] = 50_000.0
    md.n_liq_sell[3000:3003] = 2
    # At exit offsets h=30 (3033), h=60 (3063), h=120 (3123): price rises to 102.0
    for h in lock.EXIT_OFFSETS_MIN:
        exit_m = 3003 + h
        md.first_sell_px[exit_m] = 102.0
        md.first_buy_px[exit_m] = 102.0
        md.last_px[exit_m] = 102.0

    # 4. Traded Event 3 (Day 2, side B forced-buy):
    # i0 = 3200, i1 = 3202, e_index = 3203, D = 3208
    md.liq_buy_usd[3200:3203] = 50_000.0
    md.n_liq_buy[3200:3203] = 2
    # At exit offsets h=30 (3233), h=60 (3263), h=120 (3323): price drops to 95.0
    for h in lock.EXIT_OFFSETS_MIN:
        exit_m = 3203 + h
        md.first_buy_px[exit_m] = 95.0
        md.first_sell_px[exit_m] = 95.0
        md.last_px[exit_m] = 95.0

    # 5. Span-end drop candidate (Day 3, side S):
    # i0 = 4370, i1 = 4372, e_index = 4373, D = 4378
    # D + 130 = 4508 >= 4500, so dropped for span end
    md.liq_sell_usd[4370:4373] = 50_000.0
    md.n_liq_sell[4370:4373] = 2

    # Funding setup:
    # Funding stamp 1: minute 1520 (inside Event 1 hold), rate = 0.002
    # Funding stamp 2: minute 3220 (inside Event 3 hold), rate = 0.001
    f_ts = np.array([md.ms_of(1520) // 1000, md.ms_of(3220) // 1000], dtype=np.int64)
    f_rate = np.array([0.002, 0.001], dtype=np.float64)

    store = FakeStore(
        market_data={1: md},
        funding_data={1: (f_ts, f_rate)},
    )
    return store


def test_simulate_account_cap() -> None:
    """simulate_account skips events when 10 positions are open at entry fill time."""
    # 11 simultaneous events: 10 taken, 1 skipped
    events = [
        {
            "d_index": 100,
            "entry_ts": 1_000_000,
            "exit_ts": 2_000_000,
            "ret": 0.05,
            "market_id": i,
        }
        for i in range(11)
    ]
    res = simulate_account(events, max_positions=10, trade_usd=10.0)
    assert res["taken"] == 10
    assert res["skipped"] == 1
    assert res["mean_return"] == pytest.approx(0.05)
    # Profit: 10 taken * 10 USD * 0.05 = 5.0 USD
    assert res["total_usd_profit"] == pytest.approx(5.0)

    # Empty events
    res_empty = simulate_account([], max_positions=10)
    assert res_empty["taken"] == 0
    assert res_empty["skipped"] == 0


def test_horizon_l1_report_synthetic(monkeypatch: pytest.MonkeyPatch) -> None:
    """Synthetic world with controlled prices, forced sells/buys, funding, and clause checks."""
    # Lock thresholds monkeypatched:
    # GRID0_MS and N_MIN set to a 4,500-minute grid span (~3.1 days).
    # EVENTS_FROM_MS set to minute 1,000 so earlier events test retrigger bookkeeping.
    # BOOT_RESAMPLES set to 50 for fast test execution.
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 4_500)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 1_000 * lock.MINUTE_MS)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)

    store = make_three_event_world()

    res = run_all(store)

    # --- Assertion 1: Exact event and trade counts ---
    s_counts = res["trials"]["S-30"]["counts"]
    assert s_counts["bursts"] == 6  # Burst A, Burst B, Undersized, Event 1, Event 2, Span-end burst
    assert s_counts["candidates"] == 5  # Undersized burst filtered out
    assert s_counts["events"] == 4  # Burst B dropped by retrigger
    assert s_counts["traded_events"] == 3  # Burst A is before EVENTS_FROM_MS
    assert s_counts["span_end"] == 1  # Last burst dropped by span end
    assert s_counts["eligible"] == 2  # Event 1 and Event 2
    assert s_counts["no_entry_fill"] == 0
    assert s_counts["ok"] == 2
    assert s_counts["clusters"] == 2  # Day 1 and Day 2

    b_counts = res["trials"]["B-30"]["counts"]
    assert b_counts["bursts"] == 1
    assert b_counts["candidates"] == 1
    assert b_counts["events"] == 1
    assert b_counts["traded_events"] == 1
    assert b_counts["span_end"] == 0
    assert b_counts["eligible"] == 1
    assert b_counts["no_entry_fill"] == 0
    assert b_counts["ok"] == 1
    assert b_counts["clusters"] == 1

    # --- Assertion 2: Hand-computed returns of long and short ---
    # Long (Event 1, S-30):
    # Entry buy at 100.0, exit sell at 105.0 -> raw return = 105.0 / 100.0 - 1.0 = +0.05
    # Funding: long pays rate 0.002 -> funding = -0.002
    # Net return = 0.05 - 0.002 = 0.048
    row_ev1 = [r for r in res["rows"] if r["trial_id"] == "S-30" and r["i0"] == 1500][0]
    assert row_ev1["raw_return"] == pytest.approx(0.05)
    assert row_ev1["funding"] == pytest.approx(-0.002)
    assert row_ev1["ret"] == pytest.approx(0.048)

    # Long (Event 2, S-30):
    # Entry buy at 100.0, exit sell at 102.0 -> raw return = 0.02, funding = 0.0 -> ret = 0.02
    row_ev2 = [r for r in res["rows"] if r["trial_id"] == "S-30" and r["i0"] == 3000][0]
    assert row_ev2["raw_return"] == pytest.approx(0.02)
    assert row_ev2["funding"] == pytest.approx(0.0)
    assert row_ev2["ret"] == pytest.approx(0.02)

    # Short (Event 3, B-30):
    # Entry sell at 100.0, exit buy at 95.0 -> raw return = 1.0 - 95.0 / 100.0 = +0.05
    # Funding: short receives rate 0.001 -> funding = +0.001
    # Net return = 0.05 + 0.001 = 0.051
    row_ev3 = [r for r in res["rows"] if r["trial_id"] == "B-30" and r["i0"] == 3200][0]
    assert row_ev3["raw_return"] == pytest.approx(0.05)
    assert row_ev3["funding"] == pytest.approx(0.001)
    assert row_ev3["ret"] == pytest.approx(0.051)

    # --- Assertion 3: Cluster values and mean ---
    # S-30 has Day 1 cluster (0.048) and Day 2 cluster (0.020)
    # Mean of clusters = (0.048 + 0.020) / 2 = 0.034
    assert res["trials"]["S-30"]["judgement"]["mean"] == pytest.approx(0.034)

    # --- Assertion 4: Clause flags (fails clause c with 2 clusters < 30) ---
    j_s30 = res["trials"]["S-30"]["judgement"]
    assert j_s30["clause_a"] is True  # mean 0.034 >= 0.0005
    assert j_s30["clause_c"] is False  # 2 clusters < lock.MIN_CLUSTERS (30)
    assert j_s30["passed"] is False

    # --- Assertion 5: Span-end drop ---
    assert s_counts["span_end"] == 1

    # --- Assertion 6: Retrigger and burst bookkeeping ---
    # Candidate B was blocked by retrigger: bursts = 6, candidates = 5, events = 4
    assert s_counts["bursts"] == 6
    assert s_counts["candidates"] == 5
    assert s_counts["events"] == 4

    # --- Assertion 7: Claim excess against hand-built control ---
    # Event 2 has matched controls from the quiet history [1440, 2880]
    # Control trade returns are 0.00 (flat baseline price 100.0)
    # Excess for Event 2 = 0.02 - 0.00 = +0.02
    assert row_ev2["excess"] == pytest.approx(0.02)
    assert row_ev2["control_mean"] == pytest.approx(0.0)
    assert row_ev2["n_controls"] >= 3

    # --- Assertion 8: Two runs give identical judgement dicts ---
    res2 = run_all(store)
    assert res["trials"]["S-30"]["judgement"] == res2["trials"]["S-30"]["judgement"]
    assert res["trials"]["S-30"]["claim"] == res2["trials"]["S-30"]["claim"]

    # --- Assertion 9: Every bool in the JSON is a bool ---
    assert isinstance(j_s30["clause_a"], bool)
    assert isinstance(j_s30["clause_b"], bool)
    assert isinstance(j_s30["clause_c"], bool)
    assert isinstance(j_s30["clause_d"], bool)
    assert isinstance(j_s30["passed"], bool)
    assert isinstance(res["trials"]["S-30"]["claim"]["claim_holds"], bool)

    # --- Assertion 10: json.dumps(result) works and has no NaN token ---
    dumped = json.dumps(res)
    assert "NaN" not in dumped
    assert "Infinity" not in dumped


# -------------------------------------------------------------------------------------------------------------------
# Helper and tests for Item 9 (gaps 9a through 9f)
# -------------------------------------------------------------------------------------------------------------------


def make_35_event_world(
    unfillable_days: Sequence[int] = (),
    exit_prices: Sequence[float] | None = None,
    b_days: Sequence[int] = (),
    b_exit_prices: Sequence[float] | None = None,
) -> tuple[MarketData, FakeStore]:
    """Build a world with 35 S-events across 35 distinct UTC days.

    exit_prices: the S exit price of day d (1 to 35) is exit_prices[(d - 1) % len] (default 102.0 on every day).
    b_days: days (1 to 37) that also carry a B event (forced buys) at minute 1,000 of the day, after that day's S trades
    are closed. The B exit price of the i-th b_days entry is b_exit_prices[i % len] (default 98.0). All prices before
    minute 2,043 stay flat 100.0, so every control of every event trades flat.
    """
    n_days = 38
    n_min = n_days * 1440
    md = make_test_md(n_min=n_min, market_id=1, symbol="BTC")

    # Baseline: active, flat price 100.0 everywhere
    md.present[:] = True
    md.buy_usd[:] = 500.0
    md.sell_usd[:] = 500.0
    md.last_px[:] = 100.0
    all_ms = md.ms_of(0) + np.arange(n_min, dtype=np.float64) * 60_000.0
    md.first_buy_px[:] = 100.0
    md.first_buy_ts[:] = all_ms + 600.0
    md.first_sell_px[:] = 100.0
    md.first_sell_ts[:] = all_ms + 600.0
    md.last_buy_px[:] = 100.0
    md.last_buy_ts[:] = all_ms + 600.0
    md.last_sell_px[:] = 100.0
    md.last_sell_ts[:] = all_ms + 600.0

    # Place 35 bursts on days 1 to 35
    for day in range(1, 36):
        t0 = day * 1440 + 600
        # Burst of 3 minutes (150k USD >= 100k, 3 rows >= 3)
        md.liq_sell_usd[t0 : t0 + 3] = 50_000.0
        md.n_liq_sell[t0 : t0 + 3] = 1

        e_index = t0 + 3
        d_index = e_index + 5  # t0 + 8

        # Profile offset 10 entry price = 101.0
        offset_10_idx = e_index + 10  # t0 + 13
        md.first_buy_px[offset_10_idx] = 101.0
        md.first_sell_px[offset_10_idx] = 101.0
        md.last_buy_px[offset_10_idx] = 101.0
        md.last_sell_px[offset_10_idx] = 101.0
        md.last_px[offset_10_idx] = 101.0

        # Exit prices at h in (30, 60, 120) -> 102.0 unless a per-day list is given
        day_exit_px = 102.0 if exit_prices is None else float(exit_prices[(day - 1) % len(exit_prices)])
        for h in lock.EXIT_OFFSETS_MIN:
            exit_idx = e_index + h
            md.first_sell_px[exit_idx] = day_exit_px
            md.first_buy_px[exit_idx] = day_exit_px
            md.last_sell_px[exit_idx] = day_exit_px
            md.last_buy_px[exit_idx] = day_exit_px
            md.last_px[exit_idx] = day_exit_px

        # If unfillable on this day, clear prints at d_index
        if day in unfillable_days:
            md.first_buy_px[d_index] = np.nan
            md.first_buy_ts[d_index] = np.nan
            md.first_sell_px[d_index] = np.nan
            md.first_sell_ts[d_index] = np.nan
            md.last_buy_px[d_index] = np.nan
            md.last_buy_ts[d_index] = np.nan
            md.last_sell_px[d_index] = np.nan
            md.last_sell_ts[d_index] = np.nan
            md.last_px[d_index] = np.nan

    # B events (forced buys, the trade is a short), three minutes of 50,000 USD each, on the requested days
    for i, day in enumerate(b_days):
        t0_b = day * 1440 + 1000
        md.liq_buy_usd[t0_b : t0_b + 3] = 50_000.0
        md.n_liq_buy[t0_b : t0_b + 3] = 1
        b_px = 98.0 if b_exit_prices is None else float(b_exit_prices[i % len(b_exit_prices)])
        for h in lock.EXIT_OFFSETS_MIN:
            exit_idx = t0_b + 3 + h
            md.first_sell_px[exit_idx] = b_px
            md.first_buy_px[exit_idx] = b_px
            md.last_sell_px[exit_idx] = b_px
            md.last_buy_px[exit_idx] = b_px
            md.last_px[exit_idx] = b_px

    store = FakeStore(market_data={1: md})
    return md, store


def test_report_world_35_events_all_clauses_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    """35 events across 35 distinct UTC days with positive return pass all clauses for S-30."""
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 38 * 1440)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 0)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)

    _, store = make_35_event_world()
    res = run_all(store)

    s30 = res["trials"]["S-30"]
    j = s30["judgement"]

    assert j["clause_a"] is True
    assert j["clause_b"] is True
    assert j["clause_c"] is True
    assert j["clause_d"] is True
    assert j["passed"] is True
    assert s30["passed"] is True

    # Exact cluster mean: 35 days, each with net trade return 0.02
    assert j["n_clusters"] == 35
    assert j["mean"] == pytest.approx(0.02)
    assert j["bound"] == pytest.approx(0.02)
    assert j["excluded_share"] == pytest.approx(0.0)


def test_report_world_unfillable_events_clause_d_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same world with 5 unfillable events at entry: excluded_share is 5/35 > 10%, clause_d fails."""
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 38 * 1440)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 0)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)

    _, store = make_35_event_world(unfillable_days=(1, 2, 3, 4, 5))
    res = run_all(store)

    s30 = res["trials"]["S-30"]
    j = s30["judgement"]
    counts = s30["counts"]

    # All 35 events are eligible at D
    assert counts["eligible"] == 35
    assert counts["no_entry_fill"] == 5
    assert counts["ok"] == 30
    assert counts["clusters"] == 30

    # Excluded share is 5 / 35 (approx 14.29%), exceeding MAX_EXCLUDED_SHARE (10%)
    assert j["excluded_share"] == pytest.approx(5.0 / 35.0)
    assert j["clause_d"] is False
    assert j["passed"] is False
    assert s30["passed"] is False


def _cluster_values(rows: list[dict], trial_id: str, key: str) -> np.ndarray:
    """Per-day mean of key over the finite ok rows of one trial, days in ascending order."""
    by_day: dict[int, list[float]] = {}
    for r in rows:
        if r["trial_id"] == trial_id and r["status"] == "ok" and r[key] is not None:
            by_day.setdefault(r["day"], []).append(r[key])
    return np.array([float(np.mean(by_day[d])) for d in sorted(by_day)], dtype=np.float64)


def test_report_seed_and_generator_order_replay(monkeypatch: pytest.MonkeyPatch) -> None:
    """One default_rng(BOOT_SEED) in TRIAL_IDS order, and one default_rng(BOOT_SEED + 1) for the claim bounds.

    Per-day returns differ on both sides (S 1 to 5 percent, B 1 to 5 percent) so every bootstrap is non-trivial. The
    test catches a fresh generator per trial, a different trial order, a wrong seed and a shared generator for
    judgement and claim: the final loop shows that a fresh generator per trial would give another value.
    """
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 38 * 1440)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 0)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)

    _, store = make_35_event_world(
        exit_prices=(101.0, 102.0, 103.0, 104.0, 105.0),
        b_days=(1, 2, 3, 4, 5, 6),
        b_exit_prices=(99.0, 97.0, 95.0),
    )
    res = run_all(store)
    rows = res["rows"]

    # B clusters: 6 distinct days with short returns 1 - px / 100 = 0.01, 0.03, 0.05, 0.01, 0.03, 0.05 (cycling)
    assert res["trials"]["B-30"]["n_clusters"] == 6
    assert res["trials"]["S-30"]["n_clusters"] == 35

    for kind, key, seed_offset, alpha in (
        ("judged", "ret", 0, lock.TRIAL_ALPHA),
        ("claim", "excess", 1, lock.CLAIM_ALPHA),
    ):
        shared = np.random.default_rng(lock.BOOT_SEED + seed_offset)
        fresh_differs = 0
        for trial_id in lock.TRIAL_IDS:
            values = _cluster_values(rows, trial_id, key)
            assert len(values) >= 2
            assert len(set(values.tolist())) >= 3, "cluster values must differ for the replay to mean something"
            expected = bootstrap_bound(values, shared, resamples=50, alpha=alpha)
            fresh_rng = np.random.default_rng(lock.BOOT_SEED + seed_offset)
            fresh = bootstrap_bound(values, fresh_rng, resamples=50, alpha=alpha)
            trial = res["trials"][trial_id]
            if kind == "judged":
                assert trial["judgement"]["boot_bound"] == pytest.approx(expected, abs=1e-15)
            else:
                expected_claim = min(expected, t_bound(values, alpha=alpha))
                assert trial["claim"]["claim_bound"] == pytest.approx(expected_claim, abs=1e-15)
            if not math.isclose(expected, fresh, rel_tol=0.0, abs_tol=1e-12):
                fresh_differs += 1
        # the first trial is identical by construction, so a fresh generator per trial must differ on later trials
        assert fresh_differs >= 1, f"{kind}: a fresh generator per trial would give the same bounds"


def _patch_35_world(monkeypatch: pytest.MonkeyPatch) -> None:
    """Grid and lock patches shared by the 35-event worlds."""
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 38 * 1440)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 0)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)


def test_report_clauses_a_and_b_fail_when_every_event_loses(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rule 6: 35 days that each lose 2 percent fail (a) and (b) while (c) and (d) still hold.

    Catches a pass flag that ignores the sign of the mean, and clause (c) or (d) failing for the wrong reason.
    """
    _patch_35_world(monkeypatch)
    _, store = make_35_event_world(exit_prices=(98.0,))
    j = run_all(store)["trials"]["S-30"]["judgement"]

    assert j["n_clusters"] == 35
    assert j["mean"] == pytest.approx(-0.02)
    assert j["bound"] == pytest.approx(-0.02)
    assert j["clause_a"] is False
    assert j["clause_b"] is False
    assert j["clause_c"] is True
    assert j["clause_d"] is True
    assert j["passed"] is False


def test_report_clause_b_fails_alone_when_mean_clears_but_bound_does_not(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rule 6: alternating +5 and -4 percent days give a mean above PASS_MIN_MEAN and a bound below PASS_MIN_BOUND.

    Days 1 to 35: odd days (18) return +0.05, even days (17) return -0.04, so the mean is (18 x 0.05 - 17 x 0.04) / 35 =
    0.22 / 35 = 0.0062857. The sample sd (ddof 1) is 0.04564 and the t bound is about -0.0132 at alpha 0.05 / 6 with 34
    degrees of freedom (critical value near 2.5). Catches a pass flag that tests only the mean (clause a) or that
    forgets the bound clause.
    """
    _patch_35_world(monkeypatch)
    _, store = make_35_event_world(exit_prices=(105.0, 96.0))
    j = run_all(store)["trials"]["S-30"]["judgement"]

    assert j["n_clusters"] == 35
    assert j["mean"] == pytest.approx(0.22 / 35.0)
    assert j["mean"] >= lock.PASS_MIN_MEAN
    assert j["clause_a"] is True
    assert j["t_bound"] == pytest.approx(-0.0132, abs=0.001)
    assert j["t_bound"] < lock.PASS_MIN_BOUND
    assert j["bound"] < lock.PASS_MIN_BOUND
    assert j["clause_b"] is False
    assert j["clause_c"] is True
    assert j["clause_d"] is True
    assert j["passed"] is False


def test_report_claim_excess_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hand-built flat controls produce zero return, so excess equals trade return and claim holds."""
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 38 * 1440)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 0)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)

    _, store = make_35_event_world()
    res = run_all(store)

    s30_claim = res["trials"]["S-30"]["claim"]
    assert s30_claim["claim_clusters"] == 35
    assert s30_claim["claim_mean"] == pytest.approx(0.02)
    assert s30_claim["claim_bound"] == pytest.approx(0.02)
    assert s30_claim["claim_holds"] is True


def test_report_entry_offset_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    """Entry offset profile has keys '5', '6', '10', '15' and exact values for differing offsets."""
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 38 * 1440)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 0)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)

    _, store = make_35_event_world()
    res = run_all(store)

    profile = res["trials"]["S-30"]["descriptive"]["entry_offset_profile"]
    assert set(profile.keys()) == {"5", "6", "10", "15"}

    # Offset 5 entry at 100.0, exit at 102.0 -> return 0.02
    assert profile["5"] == pytest.approx(0.02)
    # Offset 6 entry at 100.0, exit at 102.0 -> return 0.02
    assert profile["6"] == pytest.approx(0.02)
    # Offset 10 entry at 101.0, exit at 102.0 -> return 1.0 / 101.0
    assert profile["10"] == pytest.approx(1.0 / 101.0)
    # Offset 15 entry at 100.0, exit at 102.0 -> return 0.02
    assert profile["15"] == pytest.approx(0.02)


# -------------------------------------------------------------------------------------------------------------------
# Controls (rule 8), clusters (rule 5) and descriptive outputs (rule 7) on small hand-built worlds
# -------------------------------------------------------------------------------------------------------------------


def _flat_md(n_min: int, market_id: int = 1, symbol: str = "BTC") -> MarketData:
    """Active market with flat price 100.0 and a first and last print of both sides 600 ms into every minute."""
    md = make_test_md(n_min=n_min, market_id=market_id, symbol=symbol)
    md.present[:] = True
    md.buy_usd[:] = 500.0
    md.sell_usd[:] = 500.0
    md.last_px[:] = 100.0
    ts = md.ms_of(0) + np.arange(n_min, dtype=np.float64) * 60_000.0 + 600.0
    for name in ("first_buy", "first_sell", "last_buy", "last_sell"):
        getattr(md, f"{name}_px")[:] = 100.0
        getattr(md, f"{name}_ts")[:] = ts
    return md


def _set_px(md: MarketData, minute: int, px: float) -> None:
    """Set every price column of one minute to px (both sides print at px, so the spread proxy stays 0)."""
    for name in ("first_buy", "first_sell", "last_buy", "last_sell"):
        getattr(md, f"{name}_px")[minute] = px
    md.last_px[minute] = px


def _add_burst(md: MarketData, side: str, i0: int, minutes: int, usd_per_min: float, rows_per_min: int = 1) -> int:
    """Add a liquidation burst of consecutive minutes and return its end index E = i1 + 1."""
    usd = md.liq_sell_usd if side == "S" else md.liq_buy_usd
    rows = md.n_liq_sell if side == "S" else md.n_liq_buy
    usd[i0 : i0 + minutes] = usd_per_min
    rows[i0 : i0 + minutes] = rows_per_min
    return i0 + minutes


def _rows_of(res: dict, trial_id: str) -> list[dict]:
    """The report rows of one trial."""
    return [r for r in res["rows"] if r["trial_id"] == trial_id]


def _patch_small_world(monkeypatch: pytest.MonkeyPatch, n_min: int, grid0_ms: int = 0) -> None:
    """Grid and lock patches for the small hand-built worlds (all events traded, 50 bootstrap draws)."""
    monkeypatch.setattr(data_mod, "GRID0_MS", grid0_ms)
    monkeypatch.setattr(data_mod, "N_MIN", n_min)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 0)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)


def test_report_controls_trade_the_events_side_and_offsets_on_rising_prices(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rule 8: a control is traded like its event (same side, same offsets) on a world whose price rises in the holds.

    World (4,200 minutes, flat 100.0): an S event with burst 2040 to 2042 (E 2043, D 2048) and a B event with burst 4000
    to 4002 (E 4003, D 4008). With r_pre 0 everywhere the controls are the earliest quiet candidates 125 minutes apart:
    D' 1440, 1565, 1690, 1815 for the S event (the latest allowed D' is 2040 - 120 = 1920) and those four plus 1940 for
    the B event. A control's exit order goes out at D' + h - 5, and the price there is 101.0 for h 30, 102.0 for h 60
    and 103.0 for h 120 (no other minute is changed, so r_pre of the chosen candidates stays 0).
    S event: entry 100.0, exit 105.0, return 0.05. Controls are long: +0.01, +0.02, +0.03. Excess 0.04, 0.03, 0.02.
    B event: entry 100.0, exit 95.0, return 1 - 0.95 = 0.05. Controls are short: -0.01, -0.02, -0.03. Excess 0.06,
    0.07, 0.08. A control traded on the wrong side, or exiting at D' + h instead of D' + h - 5, fails these values.
    """
    n_min = 4_200
    _patch_small_world(monkeypatch, n_min)
    md = _flat_md(n_min)
    e_s = _add_burst(md, "S", 2040, 3, 50_000.0)
    e_b = _add_burst(md, "B", 4000, 3, 50_000.0)
    for h in lock.EXIT_OFFSETS_MIN:
        _set_px(md, e_s + h, 105.0)
        _set_px(md, e_b + h, 95.0)
    for x in (1440, 1565, 1690, 1815, 1940):
        for h, px in ((30, 101.0), (60, 102.0), (120, 103.0)):
            _set_px(md, x + h - lock.ENTRY_OFFSET_MIN, px)

    res = run_all(FakeStore(market_data={1: md}))

    for h, ctrl_px_move in ((30, 0.01), (60, 0.02), (120, 0.03)):
        (row_s,) = _rows_of(res, f"S-{h}")
        assert row_s["status"] == "ok"
        assert row_s["n_controls"] == 4
        assert row_s["ret"] == pytest.approx(0.05)
        assert row_s["control_mean"] > 0.0
        assert row_s["control_mean"] == pytest.approx(ctrl_px_move)
        assert row_s["excess"] == pytest.approx(0.05 - ctrl_px_move)

        (row_b,) = _rows_of(res, f"B-{h}")
        assert row_b["status"] == "ok"
        assert row_b["n_controls"] == 5
        assert row_b["ret"] == pytest.approx(0.05)
        assert row_b["control_mean"] < 0.0
        assert row_b["control_mean"] == pytest.approx(-ctrl_px_move)
        assert row_b["excess"] == pytest.approx(0.05 + ctrl_px_move)


def _few_controls_world() -> MarketData:
    """4,200-minute world: S event 1 has exactly 2 quiet control candidates, S event 2 has 5.

    Tiny forced-buy minutes (1 USD, below every burst threshold) at 1440, 1454, 1580, 1705 and 1830 make every
    candidate D' in 1440 to 1920 non-quiet except 1440 and 1580: D' is quiet only when no liquidation minute lies in
    [D' - 125, D'), so each tiny minute L blocks L + 1 to L + 125. The blocked ranges are 1441 to 1565, 1455 to 1579,
    1581 to 1705, 1706 to 1830 and 1831 to 1955, which leave 1440 and 1580 (140 minutes apart) among the candidates
    up to 1920. Event 1 is an S burst at 2040 to 2042 (D 2048, exits at 104.0), event 2 an S burst at 4000 to 4002
    (D 4008, exits at 102.0).
    """
    md = _flat_md(4_200)
    for tiny in (1440, 1454, 1580, 1705, 1830):
        _add_burst(md, "B", tiny, 1, 1.0)
    e1 = _add_burst(md, "S", 2040, 3, 50_000.0)
    e2 = _add_burst(md, "S", 4000, 3, 50_000.0)
    for h in lock.EXIT_OFFSETS_MIN:
        _set_px(md, e1 + h, 104.0)
        _set_px(md, e2 + h, 102.0)
    return md


def test_report_controls_min_two_controls_means_no_control(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rule 8: an event with 2 controls (fewer than CONTROLS_MIN = 3) has no control and is counted.

    Event 1 keeps its judged return (0.04) but has NaN (None) control_mean and excess, is counted once per trial in
    no_controls and is missing from the claim clusters. Event 2 (D' candidates 1440, 1580, 1956, 2168, 2293, derived in
    the docstring of _few_controls_world and the lock) has 5 controls, flat, so its excess is its return 0.02. Catches a
    CONTROLS_MIN of 2 or less, a mean over two controls, and an event dropped from the judged clusters.
    """
    _patch_small_world(monkeypatch, 4_200)
    res = run_all(FakeStore(market_data={1: _few_controls_world()}))

    for h in lock.EXIT_OFFSETS_MIN:
        trial_id = f"S-{h}"
        row1, row2 = sorted(_rows_of(res, trial_id), key=lambda r: r["i0"])
        assert (row1["i0"], row2["i0"]) == (2040, 4000)
        assert row1["n_controls"] == 2
        assert row1["ret"] == pytest.approx(0.04)
        assert row1["control_mean"] is None
        assert row1["excess"] is None
        assert row2["n_controls"] == 5
        assert row2["control_mean"] == pytest.approx(0.0)
        assert row2["excess"] == pytest.approx(0.02)

        trial = res["trials"][trial_id]
        assert trial["counts"]["no_controls"] == 1
        assert trial["n_clusters"] == 2  # both events are judged
        assert trial["mean"] == pytest.approx(0.03)  # (0.04 + 0.02) / 2
        assert trial["claim_clusters"] == 1  # only event 2 carries an excess
        assert trial["claim_mean"] == pytest.approx(0.02)
    for trial_id in ("B-30", "B-60", "B-120"):
        assert res["trials"][trial_id]["counts"]["no_controls"] == 0


def test_report_cluster_is_the_utc_day_of_d_not_of_e(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rule 5: a burst that ends at 23:57 UTC on 2025-03-31 decides at 00:02 on 2025-04-01 and is in the April cluster.

    Grid origin is 2025-03-29 00:00 UTC. The burst minutes are 4314 to 4316 (23:54 to 23:56 on 31 March), so
    E = 4317 is 23:57 and D = 4322 is 00:02 on 1 April (index 4320 is midnight). The row day must be the epoch day of
    1 April 2025 and the month "2025-04". Catches a cluster or month keyed on E (or on the burst start) instead of D.
    """
    grid0 = int(dt.datetime(2025, 3, 29, tzinfo=dt.UTC).timestamp() * 1000)
    _patch_small_world(monkeypatch, 5_000, grid0_ms=grid0)
    md = _flat_md(5_000)
    e = _add_burst(md, "S", 4314, 3, 50_000.0)
    assert e == 4317
    for h in lock.EXIT_OFFSETS_MIN:
        _set_px(md, e + h, 102.0)

    res = run_all(FakeStore(market_data={1: md}))

    apr1_ms = int(dt.datetime(2025, 4, 1, tzinfo=dt.UTC).timestamp() * 1000)
    mar31_ms = int(dt.datetime(2025, 3, 31, tzinfo=dt.UTC).timestamp() * 1000)
    assert md.ms_of(e) == mar31_ms + (23 * 60 + 57) * 60_000
    for h in lock.EXIT_OFFSETS_MIN:
        (row,) = _rows_of(res, f"S-{h}")
        assert row["status"] == "ok"
        assert row["d_ms"] == apr1_ms + 2 * 60_000
        assert row["day"] == apr1_ms // lock.DAY_MS
        assert row["day"] != mar31_ms // lock.DAY_MS
        assert row["month"] == "2025-04"
        assert res["trials"][f"S-{h}"]["n_clusters"] == 1


def test_report_descriptive_outputs_on_three_event_world(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rule 7: hand-computed descriptive values of S-30 and B-30 on the three-event world.

    S-30 has two ok events (returns 0.048 with funding -0.002, and 0.02; both 150,000 USD, 6 rows, 3 minutes). B-30 has
    one (0.051, funding +0.001). Every print is 600 ms into its minute, so both latencies are 600 ms. Prices only
    rise inside the S holds and only fall inside the B hold, so no trade moves against its side. The grid starts in
    1970, so 2025-10-10 is absent and the Oct 10 view equals the plain one. BTC is "crypto" in lighter.lock.
    """
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 4_500)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 1_000 * lock.MINUTE_MS)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)
    res = run_all(make_three_event_world())

    d = res["trials"]["S-30"]["descriptive"]
    assert d["burst_duration_median"] == pytest.approx(3.0)
    assert d["burst_duration_p90"] == pytest.approx(3.0)
    assert d["volume_weighted_mean_return"] == pytest.approx(0.034)  # equal USD, so the plain mean
    assert d["by_class"] == {"crypto": {"n": 2, "mean_return": pytest.approx(0.034)}}
    assert d["by_market"] == [{"market_id": 1, "symbol": "BTC", "n": 2, "mean_return": pytest.approx(0.034)}]
    assert d["by_month"] == {"1970-01": {"n": 2, "mean_return": pytest.approx(0.034)}}
    assert d["without_2025_10_10"]["n_events"] == 2
    assert d["without_2025_10_10"]["n_clusters"] == 2
    assert d["without_2025_10_10"]["cluster_mean"] == pytest.approx(0.034)
    assert d["without_2025_10_10"]["event_mean"] == pytest.approx(0.034)
    assert d["worst_adverse"] == pytest.approx(0.0)
    assert d["share_adverse_gt_2pct"] == pytest.approx(0.0)
    assert d["share_adverse_gt_30pct"] == pytest.approx(0.0)
    assert d["cost_minus_2bps_mean"] == pytest.approx(0.034 - 0.0002)
    assert d["cost_minus_4bps_mean"] == pytest.approx(0.034 - 0.0004)
    assert d["funding_sum"] == pytest.approx(-0.002)
    assert d["latency_entry_mean_ms"] == pytest.approx(600.0)
    assert d["latency_exit_mean_ms"] == pytest.approx(600.0)
    assert d["account_run"]["taken"] == 2
    assert d["account_run"]["skipped"] == 0
    assert d["account_run"]["mean_return"] == pytest.approx(0.034)
    assert d["account_run"]["total_usd_profit"] == pytest.approx(10.0 * (0.048 + 0.02))

    b = res["trials"]["B-30"]["descriptive"]
    assert b["by_class"] == {"crypto": {"n": 1, "mean_return": pytest.approx(0.051)}}
    assert b["funding_sum"] == pytest.approx(0.001)
    assert b["cost_minus_2bps_mean"] == pytest.approx(0.051 - 0.0002)
    assert b["worst_adverse"] == pytest.approx(0.0)
    assert b["account_run"]["taken"] == 1


def _descriptive_world() -> tuple[MarketData, np.ndarray, np.ndarray]:
    """Five-day world starting 2025-10-09 UTC with four S events of different size, length, return and path.

    event  burst (minutes)         USD/min  D     exit px  note
    E1     2040 to 2042 (3)         50,000  2048  102.0    on 2025-10-10 (index 1440 is its midnight)
    E2     3480 to 3483 (4)         40,000  3489  104.0    last_px dips to 97.0 at 3500 inside the hold
    E3     3780 to 3784 (5)         60,000  3790  101.0    dip to 99.0 at 3800, funding 0.001 paid at 3800
    E4     4920 to 4925 (6)         20,000  4931  105.0
    """
    md = _flat_md(5_200)
    plan = (
        (2040, 3, 50_000.0, 102.0),
        (3480, 4, 40_000.0, 104.0),
        (3780, 5, 60_000.0, 101.0),
        (4920, 6, 20_000.0, 105.0),
    )
    for i0, minutes, usd, px in plan:
        e = _add_burst(md, "S", i0, minutes, usd)
        for h in lock.EXIT_OFFSETS_MIN:
            _set_px(md, e + h, px)
    md.last_px[3500] = 97.0
    md.last_px[3800] = 99.0
    f_ts = np.array([md.ms_of(3800) // 1000], dtype=np.int64)
    f_rate = np.array([0.001], dtype=np.float64)
    return md, f_ts, f_rate


def test_report_descriptive_outputs_with_distinct_events_and_oct_10(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rule 7 values of S-30 on four different events, one of them on 2025-10-10.

    Returns (S-30): E1 102/100 - 1 = 0.02, E2 0.04, E3 0.01 - 0.001 funding = 0.009, E4 0.05.
    Event mean = 0.119 / 4 = 0.02975. Clusters by D day: Oct 10 {0.02}, Oct 11 {0.04, 0.009} = 0.0245, Oct 12 {0.05}.
    Durations 3, 4, 5, 6: median 4.5, 90th percentile (linear) 5 + 0.7 = 5.7. USD 150,000, 160,000, 300,000 and
    120,000 give a volume weighted mean of (3,000 + 6,400 + 2,700 + 6,000) / 730,000 = 18,100 / 730,000.
    Adverse moves: E2 dips to 97.0 against an entry of 100.0 (0.03), E3 to 99.0 (0.01): worst 0.03, one of four events
    above 2 percent, none above 30 percent. Without Oct 10: 3 events, 2 clusters ((0.0245 + 0.05) / 2), event mean
    (0.04 + 0.009 + 0.05) / 3 = 0.033.
    """
    grid0 = int(dt.datetime(2025, 10, 9, tzinfo=dt.UTC).timestamp() * 1000)
    _patch_small_world(monkeypatch, 5_200, grid0_ms=grid0)
    md, f_ts, f_rate = _descriptive_world()
    res = run_all(FakeStore(market_data={1: md}, funding_data={1: (f_ts, f_rate)}))

    trial = res["trials"]["S-30"]
    counts = trial["counts"]
    assert (counts["bursts"], counts["candidates"], counts["events"], counts["traded_events"]) == (4, 4, 4, 4)
    assert (counts["eligible"], counts["ok"], counts["clusters"], counts["markets"]) == (4, 4, 3, 1)
    assert trial["mean"] == pytest.approx((0.02 + 0.0245 + 0.05) / 3)

    d = trial["descriptive"]
    assert d["burst_duration_median"] == pytest.approx(4.5)
    assert d["burst_duration_p90"] == pytest.approx(5.7)
    assert d["volume_weighted_mean_return"] == pytest.approx(18_100.0 / 730_000.0)
    assert d["event_describe"]["mean"] == pytest.approx(0.02975)
    assert d["by_month"] == {"2025-10": {"n": 4, "mean_return": pytest.approx(0.02975)}}
    assert d["by_class"] == {"crypto": {"n": 4, "mean_return": pytest.approx(0.02975)}}
    assert d["by_market"] == [{"market_id": 1, "symbol": "BTC", "n": 4, "mean_return": pytest.approx(0.02975)}]
    assert d["without_2025_10_10"]["n_events"] == 3
    assert d["without_2025_10_10"]["n_clusters"] == 2
    assert d["without_2025_10_10"]["cluster_mean"] == pytest.approx((0.0245 + 0.05) / 2)
    assert d["without_2025_10_10"]["event_mean"] == pytest.approx(0.033)
    assert d["worst_adverse"] == pytest.approx(0.03)
    assert d["share_adverse_gt_2pct"] == pytest.approx(0.25)
    assert d["share_adverse_gt_30pct"] == pytest.approx(0.0)
    assert d["cost_minus_2bps_mean"] == pytest.approx(0.02975 - 0.0002)
    assert d["cost_minus_4bps_mean"] == pytest.approx(0.02975 - 0.0004)
    assert d["funding_sum"] == pytest.approx(-0.001)
    assert d["latency_entry_mean_ms"] == pytest.approx(600.0)
    assert d["latency_exit_mean_ms"] == pytest.approx(600.0)
    assert d["account_run"]["taken"] == 4
    assert d["account_run"]["skipped"] == 0
    assert d["account_run"]["total_usd_profit"] == pytest.approx(10.0 * 0.119)


def test_report_account_run_skips_events_when_ten_positions_are_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rule 7: 12 markets with the same event at the same time give 10 taken and 2 skipped in the account run.

    Each market has one S event (burst 2040 to 2042, exit 102.0 so the return is 0.02), the holds overlap fully, and
    the cap is 10 positions of 10 USD, so profit is 10 x 10 x 0.02 = 2.0 USD. Catches a missing cap or a cap counted
    on events instead of open positions.
    """
    n_min = 2_300
    _patch_small_world(monkeypatch, n_min)
    markets: dict[int, MarketData] = {}
    for mid in range(1, 13):
        md = _flat_md(n_min, market_id=mid)
        e = _add_burst(md, "S", 2040, 3, 50_000.0)
        for h in lock.EXIT_OFFSETS_MIN:
            if e + h < n_min:
                _set_px(md, e + h, 102.0)
        markets[mid] = md
    # D = 2048, h 30 exit at 2073, h 60 at 2103, h 120 at 2163: all inside 2,300 minutes, the search ends at 2178 < 2300
    res = run_all(FakeStore(market_data=markets))
    for h in lock.EXIT_OFFSETS_MIN:
        acc = res["trials"][f"S-{h}"]["descriptive"]["account_run"]
        assert res["trials"][f"S-{h}"]["counts"]["ok"] == 12
        assert acc["taken"] == 10
        assert acc["skipped"] == 2
        assert acc["total_usd_profit"] == pytest.approx(2.0)


def test_report_warm_up_event_is_counted_blocks_and_is_not_traded(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rules 2 and 3: a warm-up event (E before EVENTS_FROM) is an event, blocks a candidate, and is not traded.

    EVENTS_FROM is minute 1,000. Bursts W (200 to 202, E 203, warm-up), X (327 to 329, 327 - 203 = 124 < 125, blocked)
    and Y (1500 to 1502, D 1508). Counts per S trial: 3 bursts, 3 candidates, 2 events (W and Y), 1 traded event (Y),
    and the only report row is Y. Catches a retrigger that ignores warm-up events (X would become a traded event) and
    a traded count that includes the warm-up event.
    """
    n_min = 1_700
    _patch_small_world(monkeypatch, n_min)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 1_000 * lock.MINUTE_MS)
    md = _flat_md(n_min)
    for i0 in (200, 327, 1500):
        _add_burst(md, "S", i0, 3, 50_000.0)

    res = run_all(FakeStore(market_data={1: md}))

    for h in lock.EXIT_OFFSETS_MIN:
        counts = res["trials"][f"S-{h}"]["counts"]
        assert (counts["bursts"], counts["candidates"], counts["events"], counts["traded_events"]) == (3, 3, 2, 1)
        assert counts["eligible"] == 1
        assert [r["i0"] for r in _rows_of(res, f"S-{h}")] == [1500]


def test_lock_digest_recomputation() -> None:
    """lock_digest() equals the sha256 byte stream over sorted horizon/l1/*.py files."""
    l1_dir = Path(lock.__file__).resolve().parent
    paths = sorted(l1_dir.glob("*.py"), key=lambda p: p.name)
    names = [p.name for p in paths]

    # Verify covered names include stats.py, run.py, report.py, and lock.py
    assert "stats.py" in names
    assert "run.py" in names
    assert "report.py" in names
    assert "lock.py" in names

    h = hashlib.sha256()
    for p in paths:
        h.update(p.name.encode() + b"\0")
        h.update(p.read_bytes())
        h.update(b"\0")
    expected_digest = h.hexdigest()

    lock.lock_digest.cache_clear()
    assert lock.lock_digest() == expected_digest
