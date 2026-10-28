"""Brief 29b: per-tranche native costs, and fill groups that never net across different cost profiles."""

from __future__ import annotations

from dataclasses import asdict

import numpy as np
import pandas as pd
import pytest

import r4.book as book
from r4.book import Tranche, _coerce_tranches, netted_costs

HOUR = 3_600_000
DAY0 = 1_700_006_400_000  # a UTC midnight
TAKER = 0.0005


def _tr(sym: str, side: int, entry_h: float, exit_h: float, **extra) -> Tranche:
    return Tranche(
        symbol=sym,
        side=side,
        entry_ms=DAY0 + int(entry_h * HOUR),
        exit_ms=DAY0 + int(exit_h * HOUR),
        entry_price=100.0,
        exit_price=101.0,
        interval="1h",
        h_ms=4 * HOUR,
        weight_override=side * 0.1,
        **extra,
    )


def _plain_reference_set() -> list[Tranche]:
    rng = np.random.default_rng(5)
    syms = ["BTCUSDT", "ETHUSDT", "ADAUSDT", "SOLUSDT"]
    out: list[Tranche] = []
    for _ in range(60):
        e = DAY0 + int(rng.integers(0, 12)) * HOUR
        x = e + int(rng.integers(1, 6)) * HOUR
        out.append(
            Tranche(
                symbol=syms[int(rng.integers(0, 4))],
                side=int(rng.choice([-1, 1])),
                entry_ms=e,
                exit_ms=x,
                entry_price=100.0,
                exit_price=101.0,
                interval="1h",
                h_ms=4 * HOUR,
                entry_fill=str(rng.choice(["taker", "maker"])),
                exit_fill="taker",
            )
        )
    return out


def test_native_cost_override_and_grouping():
    # Two rules, same coin, same instant, opposite sides: without a native cost they would net to nothing.
    a = _tr("BTCUSDT", 1, 1, 5, fee_profile="standard", slippage_bps_override=2.0)
    b = _tr("BTCUSDT", -1, 1, 5, fee_profile="standard", slippage_bps_override=3.0)
    n = netted_costs([a, b])
    entry = n.groups[n.groups["instant_ms"] == DAY0 + HOUR]
    assert len(entry) == 2  # the two slippage settings never share a group
    assert (entry["traded"] == 0.1).all()
    slips = sorted(entry["slippage"].tolist())
    assert slips[0] == pytest.approx(0.1 * 2.0 / 10000.0, rel=1e-12)
    assert slips[1] == pytest.approx(0.1 * 3.0 / 10000.0, rel=1e-12)
    assert entry["fee"].tolist() == pytest.approx([0.1 * TAKER] * 2, rel=1e-12)
    # Native slippage replaces the per-coin table (BTC would pay 1 bps).
    assert n.tranche_slippage[0] == pytest.approx(2 * 0.1 * 2.0 / 10000.0, rel=1e-12)

    # The same two legs with identical native costs do net (the control).
    c = _tr("BTCUSDT", -1, 1, 5, fee_profile="standard", slippage_bps_override=2.0)
    m = netted_costs([a, c])
    assert (m.groups["traded"] == 0.0).all()
    assert m.tranche_cost.sum() == 0.0


def test_native_fee_profile_changes_the_rate():
    a = _tr("BTCUSDT", 1, 1, 5, fee_profile="bnb", slippage_bps_override=0.0)
    n = netted_costs([a])
    assert n.groups["fee"].tolist() == pytest.approx([0.1 * 0.00045] * 2, rel=1e-12)
    assert n.groups["slippage"].tolist() == [0.0, 0.0]
    # A tranche without its own profile uses the function argument, unchanged.
    plain = _tr("BTCUSDT", 1, 1, 5)
    assert netted_costs([plain], profile="bnb").groups["fee"].tolist() == pytest.approx([0.1 * 0.00045] * 2, rel=1e-12)


def test_plain_tranches_are_bit_identical():
    n = netted_costs(_plain_reference_set())
    # Values recorded from the code before this brief (brief 23 netting).
    assert len(n.groups) == 70
    assert float(n.tranche_fee.sum()) == 0.0009050000000000001
    assert float(n.tranche_slippage.sum()) == 0.0003875000000000001
    assert float(n.tranche_fee[3]) == 1.7500000000000002e-05
    assert float(n.tranche_slippage[7]) == 2.5e-05
    assert float(n.by_day["fees"].sum()) == 0.0009050000000000001
    assert list(n.groups.columns) == ["symbol", "instant_ms", "fill", "traded", "fee", "slippage", "day_start"]


def test_new_fields_default_and_round_trip(tmp_path):
    plain = _tr("ETHUSDT", 1, 0, 4)
    assert plain.fee_profile is None and plain.slippage_bps_override is None
    native = _tr("ETHUSDT", -1, 0, 4, fee_profile="bnb", slippage_bps_override=3.0)
    # dict input, object input and the parquet round trip all carry the fields.
    from_dict = _coerce_tranches([asdict(native), asdict(plain)])
    assert [(t.fee_profile, t.slippage_bps_override) for t in from_dict] == [("bnb", 3.0), (None, None)]
    df = pd.DataFrame([asdict(native), asdict(plain)])
    df.to_parquet(tmp_path / "t.parquet", index=False)
    back = _coerce_tranches(pd.read_parquet(tmp_path / "t.parquet"))
    assert [(t.fee_profile, t.slippage_bps_override) for t in back] == [("bnb", 3.0), (None, None)]
    assert book.Tranche.__dataclass_fields__["fee_profile"].default is None
