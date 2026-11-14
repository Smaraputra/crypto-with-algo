"""Unit tests for horizon-l1 report.py (the six trials, controls, aggregation and JSON output)."""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import pytest

from horizon.l1 import data as data_mod
from horizon.l1 import lock
from horizon.l1.data import MarketData
from horizon.l1.report import run_all, simulate_account


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
    # D + 131 = 4509 >= 4500, so dropped for span end
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
    assert s_counts["bursts"] == 5  # Burst A, Burst B, Event 1, Event 2, Span-end burst
    assert s_counts["candidates"] == 5
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

    # --- Assertion 6: Retrigger bookkeeping ---
    # Candidate B was blocked by retrigger: bursts = 5, events = 4
    assert s_counts["bursts"] == 5
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
