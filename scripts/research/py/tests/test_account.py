"""Tests for r4.account: the $100-account execution layer (report only). Synthetic data only."""

from __future__ import annotations

import dataclasses
import gzip
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import r4.bar
from r4.account import account_report, simulate_account
from r4.bar import family_report
from r4.book import Tranche
from r4.costs import coin_slippage_bps
from r4.method import UNIVERSE
from tests.test_cli_bar import _write_planted_family

DAY = 86_400_000
HOUR = 3_600_000
BAR = 300_000
START = 19_700 * DAY  # a UTC midnight


def _bars(prices: float | list[tuple[int, float]], n_bars: int, start: int = START) -> pd.DataFrame:
    """A 5m frame of n_bars. prices is a constant, or (first_bar_index, price) steps."""
    t = start + np.arange(n_bars, dtype=np.int64) * BAR
    if isinstance(prices, (int, float)):
        o = np.full(n_bars, float(prices))
    else:
        o = np.empty(n_bars)
        steps = sorted(prices)
        for i, (k, p) in enumerate(steps):
            end = steps[i + 1][0] if i + 1 < len(steps) else n_bars
            o[k:end] = p
    return pd.DataFrame({"t": t, "o": o, "h": o, "l": o, "c": o, "v": 1.0})


def _tr(symbol: str, w: float, entry_ms: int, exit_ms: int, **kw) -> Tranche:
    return Tranche(
        symbol=symbol,
        side=1 if w > 0 else -1,
        entry_ms=entry_ms,
        exit_ms=exit_ms,
        entry_price=kw.pop("entry_price", 1.0),
        exit_price=kw.pop("exit_price", 1.0),
        interval="1h",
        h_ms=HOUR,
        weight_override=w,
        **kw,
    )


TWO_DAYS = 2 * 288 + 1


def test_rounds_toward_zero_and_skips_below_min():
    # DOGE: step 1, minNotional 5. 0.1 x 100 x 10 = 100 notional at 0.37 is 270.27 coins: rounds to 270, not 271.
    five = {"DOGEUSDT": _bars(0.37, TWO_DAYS)}
    tr = [
        _tr("DOGEUSDT", 0.1, START + HOUR, START + DAY),
        # +0.001 weight for a while: target 272.97 -> 272, delta 2 coins x 0.37 = 0.74 < 5: skipped
        _tr("DOGEUSDT", 0.001, START + 2 * HOUR, START + 5 * HOUR),
    ]
    res = simulate_account(tr, five, {}, equity0=100.0, leverage=10)
    assert res.fills.iloc[0]["qty"] == 270.0
    assert res.orders_skipped == 1
    assert res.orders_total == 3  # open, the skipped top-up, the close; the step back to 270 needs no order
    assert res.orders_closes == 1
    assert len(res.fills) == 2
    assert res.fills.iloc[1]["qty"] == -270.0

    # a short rounds toward zero as well (-270, not -271)
    short = simulate_account([_tr("DOGEUSDT", -0.1, START + HOUR, START + DAY)], five, {}, 100.0, 10)
    assert short.fills.iloc[0]["qty"] == -270.0


def test_close_always_allowed():
    # Short 270 DOGE at 0.37, the price then collapses to 0.01: the close is 2.7 notional, below the 5 minimum.
    five = {"DOGEUSDT": _bars([(0, 0.37), (200, 0.01)], TWO_DAYS)}
    exit_ms = START + 200 * BAR
    res = simulate_account([_tr("DOGEUSDT", -0.1, START + HOUR, exit_ms)], five, {}, 100.0, 10)
    assert res.orders_skipped == 0
    assert res.orders_closes == 1
    assert len(res.fills) == 2
    assert res.fills.iloc[1]["qty"] == 270.0
    assert res.liquidation is None


def test_btc_needs_leverage():
    five = {"BTCUSDT": _bars(81_000.0, TWO_DAYS)}
    tr = [_tr("BTCUSDT", 0.1, START + HOUR, START + DAY)]
    one = simulate_account(tr, five, {}, equity0=100.0, leverage=1)
    assert len(one.fills) == 0
    assert one.orders_total == 0
    assert one.zero_position_share["BTCUSDT"] == 1.0

    ten = simulate_account(tr, five, {}, equity0=100.0, leverage=10)
    assert ten.fills.iloc[0]["qty"] == 0.001  # one lot, $81 notional >= the $50 minimum
    assert ten.zero_position_share["BTCUSDT"] == 0.0


def test_fees_on_executed_notional():
    five = {"DOGEUSDT": _bars(0.37, TWO_DAYS)}
    slip = coin_slippage_bps("DOGEUSDT") / 10_000.0
    buy = 0.37 * (1 + slip)
    sell = 0.37 * (1 - slip)

    taker = simulate_account([_tr("DOGEUSDT", 0.1, START + HOUR, START + DAY)], five, {}, 100.0, 10)
    assert taker.fees == pytest.approx(270 * buy * 0.0005 + 270 * sell * 0.0005, rel=1e-12)
    assert taker.fills.iloc[0]["price"] == pytest.approx(buy)

    # a maker entry fills at its level, no slippage, maker fee on the executed notional; the quantity still
    # comes from the open
    maker = simulate_account(
        [_tr("DOGEUSDT", 0.1, START + HOUR, START + DAY, entry_fill="maker", entry_price=0.365)],
        five,
        {},
        100.0,
        10,
    )
    assert maker.fills.iloc[0]["qty"] == 270.0
    assert maker.fills.iloc[0]["price"] == pytest.approx(0.365)
    assert maker.fees == pytest.approx(270 * 0.365 * 0.0002 + 270 * sell * 0.0005, rel=1e-12)


def test_funding_on_position_notional():
    # Settlement at 8h, when the price is 0.40: the payment is qty x that open x rate, longs pay.
    five = {"DOGEUSDT": _bars([(0, 0.37), (96, 0.40)], TWO_DAYS)}
    settle = {"DOGEUSDT": pd.DataFrame({"t": [START + 8 * HOUR], "rate": [0.001]})}
    long = simulate_account([_tr("DOGEUSDT", 0.1, START + HOUR, START + DAY)], five, settle, 100.0, 10)
    assert long.funding == pytest.approx(-270 * 0.40 * 0.001, rel=1e-12)
    short = simulate_account([_tr("DOGEUSDT", -0.1, START + HOUR, START + DAY)], five, settle, 100.0, 10)
    assert short.funding == pytest.approx(270 * 0.40 * 0.001, rel=1e-12)


def test_liquidation_stops_and_records():
    # 50x on SOL: 0.1 x 100 x 50 = 500 notional = 5 SOL at 100. Filled at 100.02 (2 bps), fee 0.25005.
    # At 90 the account holds; at 80.5 equity is 2.14995 against a maintenance of 5 x 80.5 x 0.01 = 4.025.
    five = {"SOLUSDT": _bars([(0, 100.0), (12, 90.0), (24, 80.5)], TWO_DAYS)}
    tr = [_tr("SOLUSDT", 0.1, START + 6 * BAR, START + DAY)]
    res = simulate_account(tr, five, {}, equity0=100.0, leverage=50)
    assert res.liquidation is not None
    liq = res.liquidation
    assert liq["t"] == START + 24 * BAR
    assert liq["equity_before"] == pytest.approx(100 - 0.25005 + 5 * (80.5 - 100.02), rel=1e-9)
    assert liq["equity_after"] == pytest.approx(liq["equity_before"] - 0.005 * 5 * 80.5, rel=1e-9)
    assert len(res.fills) == 1  # the scheduled close at START + DAY never runs
    assert len(res.daily) == 1
    assert res.daily.index[-1] == START
    assert res.daily["equity"].iloc[-1] == pytest.approx(liq["equity_after"])
    assert math.isfinite(res.daily["log_return"].iloc[-1])

    # the same book at 10x does not liquidate on this path
    calm = simulate_account(tr, five, {}, equity0=100.0, leverage=10)
    assert calm.liquidation is None


def test_report_only_not_read_by_bar(tmp_path: Path):
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)

    def report():
        rep = family_report(
            family="A",
            runs_dir=runs_dir,
            round_runs_dir=runs_dir,
            ledger_count=120,
            ds_dir=ds_dir,
            out_file=tmp_path / "report.json",
            seed=7,
            panel=panel,
            tripwire={"positive": 60, "n": 100},
        )
        return json.loads(json.dumps(rep))

    before = report()
    for run in runs_dir.iterdir():
        (run / "account_100.json").write_text(json.dumps({"leverages": {"10": {"final_equity": 1.0}}}))
    after = report()
    assert before == after
    assert "account_100" not in Path(r4.bar.__file__).read_text(encoding="utf-8")


def _write_jsonl_gz(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")


def test_end_to_end_synthetic(tmp_path: Path):
    start = 1_672_531_200_000  # 2023-01-01 UTC
    n_days = 12
    n_bars = n_days * 288
    rng = np.random.default_rng(5)
    base = {"BTCUSDT": 20_000.0, "ETHUSDT": 1_500.0, "BNBUSDT": 250.0, "SOLUSDT": 12.0, "XRPUSDT": 0.35}
    ds_dir = tmp_path / "ds"
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    rows_out: list[Tranche] = []
    for sym in UNIVERSE:
        p0 = base.get(sym, 1.0)
        o = p0 * np.exp(np.cumsum(rng.normal(0.0, 0.0002, n_bars)))
        t = start + np.arange(n_bars, dtype=np.int64) * BAR
        _write_jsonl_gz(
            ds_dir / "perp" / sym / "5m.jsonl.gz",
            [
                {"t": int(a), "o": float(b), "h": float(b), "l": float(b), "c": float(b), "v": 1.0}
                for a, b in zip(t, o, strict=True)
            ],
        )
        settle = [
            {"t": int(start + k * 8 * HOUR), "rate": 0.0001, "intervalHours": 8} for k in range(1, n_days * 3 + 1)
        ]
        _write_jsonl_gz(ds_dir / "funding" / sym / "settlements.jsonl.gz", settle)
        sign = 1 if rng.random() < 0.5 else -1
        for k in range(1, 9 * 24):
            e = start + k * HOUR + 10 * 60_000
            ie = (e - start) // BAR
            rows_out.append(
                Tranche(
                    symbol=sym,
                    side=sign,
                    entry_ms=e,
                    exit_ms=e + 4 * HOUR,
                    entry_price=float(o[ie]),
                    exit_price=float(o[ie + 48]),
                    interval="1h",
                    h_ms=4 * HOUR,
                )
            )
    (ds_dir / "manifest.json").write_text(json.dumps({"datasetHash": "synthetic", "files": []}), encoding="utf-8")
    pd.DataFrame([dataclasses.asdict(r) for r in rows_out]).to_parquet(run_dir / "tranches.parquet", index=False)

    rep = account_report(run_dir, ds_dir)
    assert set(rep["leverages"]) == {"10", "20", "50"}
    assert rep["report_only"] is True
    for lev, block in rep["leverages"].items():
        for key in ("final_equity", "total_log_return", "fees", "funding", "tracking_mean_daily"):
            assert math.isfinite(block[key]), (lev, key)
        assert block["n_days"] > 0
        assert block["orders_total"] > 0
    written = json.loads((run_dir / "account_100.json").read_text(encoding="utf-8"))
    assert written["leverages"].keys() == rep["leverages"].keys()
    assert written["leverages"]["10"]["final_equity"] == pytest.approx(rep["leverages"]["10"]["final_equity"])
