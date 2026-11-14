"""Unit tests for horizon-l1 report.py (the six trials, controls, aggregation and JSON output)."""

from __future__ import annotations

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


def make_35_event_world(unfillable_days: Sequence[int] = ()) -> tuple[MarketData, FakeStore]:
    """Build a world with 35 S-events across 35 distinct UTC days."""
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

        # Exit prices at h in (30, 60, 120) -> 102.0
        for h in lock.EXIT_OFFSETS_MIN:
            exit_idx = e_index + h
            md.first_sell_px[exit_idx] = 102.0
            md.first_buy_px[exit_idx] = 102.0
            md.last_sell_px[exit_idx] = 102.0
            md.last_buy_px[exit_idx] = 102.0
            md.last_px[exit_idx] = 102.0

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


def test_report_seed_and_generator_order_replay(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replay bootstrap with default_rng(BOOT_SEED) over TRIAL_IDS and verify bounds match."""
    monkeypatch.setattr(data_mod, "GRID0_MS", 0)
    monkeypatch.setattr(data_mod, "N_MIN", 38 * 1440)
    monkeypatch.setattr(lock, "EVENTS_FROM_MS", 0)
    monkeypatch.setattr(lock, "BOOT_RESAMPLES", 50)

    _, store = make_35_event_world()
    res = run_all(store)

    # Replay judgement generator
    replay_rng = np.random.default_rng(lock.BOOT_SEED)
    for trial_id in lock.TRIAL_IDS:
        side = trial_id.split("-")[0]
        if side == "S":
            c_vals = np.full(35, 0.02, dtype=np.float64)
        else:
            c_vals = np.array([], dtype=np.float64)

        expected_boot = bootstrap_bound(
            c_vals,
            replay_rng,
            resamples=50,
            alpha=lock.TRIAL_ALPHA,
        )
        actual_boot = res["trials"][trial_id]["judgement"]["boot_bound"]
        if math.isnan(expected_boot):
            assert actual_boot is None or math.isnan(actual_boot)
        else:
            assert actual_boot == pytest.approx(expected_boot)

    # Replay claim generator (seeded BOOT_SEED + 1)
    claim_replay_rng = np.random.default_rng(lock.BOOT_SEED + 1)
    for trial_id in lock.TRIAL_IDS:
        side = trial_id.split("-")[0]
        if side == "S":
            claim_c_vals = np.full(35, 0.02, dtype=np.float64)
        else:
            claim_c_vals = np.array([], dtype=np.float64)

        expected_claim_boot = bootstrap_bound(
            claim_c_vals,
            claim_replay_rng,
            resamples=50,
            alpha=lock.CLAIM_ALPHA,
        )
        claim_tb = t_bound(claim_c_vals, alpha=lock.CLAIM_ALPHA)
        expected_min = (
            float(min(expected_claim_boot, claim_tb))
            if not (math.isnan(expected_claim_boot) or math.isnan(claim_tb))
            else float("nan")
        )
        actual_claim_bound = res["trials"][trial_id]["claim"]["claim_bound"]
        if math.isnan(expected_min):
            assert actual_claim_bound is None or math.isnan(actual_claim_bound)
        else:
            assert actual_claim_bound == pytest.approx(expected_min)


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
