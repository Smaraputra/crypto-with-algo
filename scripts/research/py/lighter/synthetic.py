"""Synthetic inputs for the Lighter stage 2 tests. No real data is read or imitated beyond the file formats.

Panel (`make_panel`): per market a random-walk latent price (one level per minute), taker-buy prints at price x
(1 + half spread) and taker-sell prints at price x (1 - half spread) at random times, folded by the real fold code
(lighter/fold_trades.py) into the per-minute Parquet files, matching Binance 1m files (price x (1 + noise)), hourly
funding Parquet files and markets.json. With edge_bps > 0 the generator plants a reversal: after a 5m move of at
least 1.5 sd (the F1 z at k = 1, theta = 1.5, computed on the signal price the generator itself exposes) the next
60 minutes carry a drift against the move of edge_bps in total.

Microstructure mode 2 (`micro=True`): several prints per minute at different prices. Taker signs follow a two-state
Markov chain (stay probability `micro_stay`, 0.7 by default), every print moves the mid permanently by
`micro_impact_bps` in its own direction, arrivals are Poisson, quotes sit at mid plus or minus half the spread. In this
mode a rule that waits for a print of its own side is biased in the trader's favour (it waits out the runs against it),
which mode 1 (every print of a minute at one price, independent arrivals) cannot show.

`random_minute_data` builds a MinuteData directly (no files) for the reference comparisons in the unit tests.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import gzip
import hashlib
import io
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from lighter import fetch_funding
from lighter import fold_trades as ft
from lighter.data import SYNTHETIC_MARKER, Market, MinuteData
from lighter.lock import symbol_class

MINUTE = 60_000
DAY = 86_400_000
BINANCE_HEADER = "open_time,open,high,low,close,volume,quote_volume,trades,taker_buy_base,taker_buy_quote\n"

COINS = (
    "BTC",
    "ETH",
    "SOL",
    "XRP",
    "DOGE",
    "XAU",
    "ADA",
    "LINK",
    "AVAX",
    "DOT",
    "LTC",
    "BCH",
    "TRX",
    "GRAM",
    "AAVE",
    "UNI",
    "ENA",
    "1000PEPE",
    "WLD",
    "ARB",
    "OP",
    "XAG",
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "AAPL",
    "WTI",
    "BRENTOIL",
)
TIERS = ("A", "A", "A", "B", "B", "B", "A", "B")
# Half spread in bps per tier. The spread proxy of the eligibility rule is twice this: 0.8 bps (tier A) or 2.0 (tier B).
HALF_SPREAD_BPS = {"A": 0.4, "B": 1.0}


@dataclass
class PanelSpec:
    """pre_days is the number of days written before start: by default the whole previous month (so that the
    eligibility of the first month can be computed), 2 days when start is not a first of month."""

    n_markets: int = 6
    start: dt.date = dt.date(2025, 7, 1)
    days: int = 31
    pre_days: int | None = None
    seed: int = 1
    edge_bps: float = 0.0
    half_spreads_bps: tuple[float, ...] | None = None
    prints_per_side: float = 2.5
    vol_1m_bps: float = 3.0
    binance_noise_bps: float = 1.5
    funding_sd: float = 1.5e-4
    price_decimals: int = 4
    plant_z: float = 1.5
    plant_minutes: int = 60
    micro: bool = False
    micro_prints_per_min: float = 6.0
    micro_impact_bps: float = 0.4
    micro_stay: float = 0.7
    micro_burst_frac: float = 0.0  # share of minutes in which the half spread is multiplied by micro_burst_factor
    micro_burst_factor: float = 10.0
    # market ids made no-funding markets: no funding file and a funding manifest line with status "empty" (a delisted
    # market on the venue). The other markets get a manifest line with status "ok".
    no_funding_markets: tuple[int, ...] = ()


@dataclass
class Panel:
    root: Path
    spec: PanelSpec
    fold_dir: Path
    binance_dir: Path
    funding_dir: Path
    last_date: dt.date
    markets: list[Market]
    start_ms: int
    half_spreads_bps: dict[int, float]
    first_day_ms: int = 0
    quote_half_bps: dict[int, np.ndarray] | None = None  # the generator's own half spread per minute from first_day_ms


def _month_starts(first: dt.date, last: dt.date) -> list[tuple[int, int]]:
    out = []
    y, m = first.year, first.month
    while (y, m) <= (last.year, last.month):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _micro_events(spec: PanelSpec, n_min: int, rng: np.random.Generator) -> dict[str, np.ndarray]:
    """Print stream of mode 2: counts per minute, minute and in-minute offset of every print, Markov signs, impacts."""
    counts = rng.poisson(spec.micro_prints_per_min, n_min)
    minute = np.repeat(np.arange(n_min), counts)
    n = len(minute)
    offset = rng.integers(0, MINUTE, n)
    order = np.lexsort((offset, minute))
    offset = offset[order]
    flips = rng.random(n) > spec.micro_stay
    flips[0] = False
    sign = rng.choice(np.array([-1, 1]), size=1)[0] * (1 - 2 * (np.cumsum(flips) % 2))
    steps = sign * spec.micro_impact_bps
    after = np.cumsum(steps)
    before = after - steps
    cum = np.cumsum(counts)
    end_bps = np.where(cum > 0, after[np.maximum(cum - 1, 0)], 0.0)
    burst = rng.random(n_min) < spec.micro_burst_frac
    return {
        "burst_factor": np.where(burst, spec.micro_burst_factor, 1.0),
        "counts": counts,
        "cum": cum,
        "minute": minute,
        "offset": offset,
        "sign": sign,
        "before_bps": before,
        "impact_end": end_bps * 1e-4,
    }


def _latent_path(
    spec: PanelSpec,
    n_min: int,
    rng: np.random.Generator,
    vol_scale: float,
    binance: bool,
    impact_end: np.ndarray | None = None,
):
    """Latent log price per minute (the level the prints of that minute use) and the Binance noise per minute."""
    vol = spec.vol_1m_bps * vol_scale * 1e-4
    inc = rng.normal(0.0, vol, n_min)
    eps = rng.normal(0.0, spec.binance_noise_bps * 1e-4, n_min) if binance else np.zeros(n_min)
    p = np.zeros(n_min)
    n_grid = n_min // 5
    mu = spec.edge_bps * 1e-4
    drift = np.zeros(n_min + spec.plant_minutes + 6)
    imp = np.zeros(n_min) if impact_end is None else impact_end
    closes = np.zeros(n_grid)
    cool_until = -1
    for b in range(n_grid):
        for m in range(5 * b, 5 * b + 5):
            p[m] = (p[m - 1] if m else 0.0) + inc[m] + drift[m]
        closes[b] = p[5 * b + 4] + imp[5 * b + 4] + eps[5 * b + 4]
        if mu <= 0 or b < 290:
            continue
        window = np.diff(closes[b - 288 : b + 1])
        sd = window.std(ddof=1)
        z = window[-1] / sd if sd > 0 else 0.0
        g = 5 * (b + 1)
        if abs(z) >= spec.plant_z and g > cool_until and g + spec.plant_minutes < n_min:
            drift[g + 1 : g + 1 + spec.plant_minutes] += -np.sign(z) * mu / spec.plant_minutes
            cool_until = g + spec.plant_minutes
    return p, eps


def _raw_day(
    spec: PanelSpec,
    day_start_ms: int,
    day_index: int,
    market_ids: list[int],
    paths: dict[int, np.ndarray],
    half: dict[int, float],
    rng: np.random.Generator,
    next_id: int,
    events: dict[int, dict[str, np.ndarray]] | None = None,
) -> tuple[pa.Table, int]:
    cols: dict[str, list[np.ndarray]] = {
        k: [] for k in ("id", "timestamp", "market_id", "price", "size", "usdc_amount", "is_maker_ask")
    }
    scale = 10.0**spec.price_decimals
    for mid in market_ids:
        h = half[mid] * 1e-4
        p = paths[mid][day_index * 1440 : (day_index + 1) * 1440]
        if events is not None:
            ev = events[mid]
            m0, m1 = day_index * 1440, (day_index + 1) * 1440
            lo = int(ev["cum"][m0 - 1]) if m0 > 0 else 0
            hi = int(ev["cum"][m1 - 1])
            minute = ev["minute"][lo:hi] - m0
            sign = ev["sign"][lo:hi]
            n = hi - lo
            ts = day_start_ms + minute * MINUTE + ev["offset"][lo:hi]
            hf = h * ev["burst_factor"][ev["minute"][lo:hi]]
            px = np.exp(p[minute] + ev["before_bps"][lo:hi] * 1e-4) * 100.0 * (1.0 + sign * hf)
            raw = np.rint(px * scale).astype(np.int64)
            usd = np.exp(rng.normal(6.5, 1.5, n))
            micro = np.rint(usd * 1e6).astype(np.int64)
            cols["timestamp"].append(ts.astype(np.int64))
            cols["market_id"].append(np.full(n, mid, dtype=np.int16))
            cols["price"].append(raw)
            cols["size"].append(micro // raw)
            cols["usdc_amount"].append(micro)
            cols["is_maker_ask"].append(sign > 0)
            continue
        for buys in (True, False):
            cnt = rng.poisson(spec.prints_per_side, 1440)
            minute = np.repeat(np.arange(1440), cnt)
            n = len(minute)
            ts = day_start_ms + minute * MINUTE + rng.integers(0, MINUTE, n)
            px = np.exp(p[minute]) * 100.0 * ((1 + h) if buys else (1 - h))
            raw = np.rint(px * scale).astype(np.int64)
            usd = np.exp(rng.normal(6.5, 1.5, n))
            micro = np.rint(usd * 1e6).astype(np.int64)
            cols["timestamp"].append(ts.astype(np.int64))
            cols["market_id"].append(np.full(n, mid, dtype=np.int16))
            cols["price"].append(raw)
            cols["size"].append(micro // raw)
            cols["usdc_amount"].append(micro)
            cols["is_maker_ask"].append(np.full(n, buys))
    ts_all = np.concatenate(cols["timestamp"])
    n_all = len(ts_all)
    ids = np.arange(next_id, next_id + n_all, dtype=np.int64)
    order = rng.permutation(n_all)
    table = pa.table(
        {
            "id": pa.array(ids, pa.int64()),
            "timestamp": pa.array(ts_all[order], pa.int64()),
            "market_id": pa.array(np.concatenate(cols["market_id"])[order], pa.int16()),
            "price": pa.array(np.concatenate(cols["price"])[order], pa.int64()),
            "size": pa.array(np.concatenate(cols["size"])[order], pa.int64()),
            "usdc_amount": pa.array(np.concatenate(cols["usdc_amount"])[order], pa.int64()),
            "is_maker_ask": pa.array(np.concatenate(cols["is_maker_ask"])[order], pa.bool_()),
            "trade_type": pa.array(["trade"] * n_all, pa.string()),
        }
    )
    return table, next_id + n_all


def make_panel(root: Path, spec: PanelSpec) -> Panel:
    """Write fold (with its manifest and markets.json), Binance and funding files for a synthetic panel."""
    root = Path(root)
    if spec.pre_days is not None:
        pre_days = spec.pre_days
    elif spec.start.day == 1:
        pre_days = (spec.start - (spec.start - dt.timedelta(days=1)).replace(day=1)).days
    else:
        pre_days = 2
    n_days = spec.days + pre_days
    first_day = spec.start - dt.timedelta(days=pre_days)
    last_day = spec.start + dt.timedelta(days=spec.days - 1)
    t0 = ft.day_start_ms(first_day)
    n_min = n_days * 1440
    rng = np.random.default_rng(spec.seed)
    fold_dir, binance_dir, funding_dir = root / "fold", root / "binance", root / "funding"
    (fold_dir / "v1").mkdir(parents=True, exist_ok=True)
    (fold_dir / "manifest.jsonl").write_text("")
    (fold_dir / SYNTHETIC_MARKER).write_text("written by lighter/synthetic.py: results from this fold are synthetic\n")
    funding_dir.mkdir(parents=True, exist_ok=True)

    markets: list[Market] = []
    half: dict[int, float] = {}
    events: dict[int, dict[str, np.ndarray]] = {}
    impacts: dict[int, np.ndarray] = {}
    paths: dict[int, np.ndarray] = {}
    eps: dict[int, np.ndarray] = {}
    for i in range(spec.n_markets):
        coin = COINS[i]
        has_binance = symbol_class(coin) == "crypto"
        market = Market(coin, i + 1, spec.price_decimals)
        markets.append(market)
        if spec.half_spreads_bps is not None:
            half[market.market_id] = spec.half_spreads_bps[i]
        else:
            half[market.market_id] = HALF_SPREAD_BPS[TIERS[i % 8]]
        mrng = np.random.default_rng([spec.seed, i])
        impact = None
        if spec.micro:
            events[market.market_id] = _micro_events(spec, n_min, np.random.default_rng([spec.seed, 5, i]))
            impact = events[market.market_id]["impact_end"]
        impacts[market.market_id] = np.zeros(n_min) if impact is None else impact
        paths[market.market_id], eps[market.market_id] = _latent_path(
            spec, n_min, mrng, 1.0 + 0.1 * i, has_binance, impact
        )

    next_id = 1
    for d in range(n_days):
        day = first_day + dt.timedelta(days=d)
        table, next_id = _raw_day(
            spec, ft.day_start_ms(day), d, [m.market_id for m in markets], paths, half, rng, next_id, events or None
        )
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "raw.parquet"
            pq.write_table(table, raw)
            with contextlib.redirect_stderr(io.StringIO()):
                folded, _ = ft.fold_file(raw, day)
        out_path = fold_dir / "v1" / f"date={day.isoformat()}.parquet"
        pq.write_table(folded, out_path, compression="zstd")
        digest = hashlib.sha256(out_path.read_bytes()).hexdigest()
        with open(fold_dir / "manifest.jsonl", "a") as f:
            f.write(json.dumps({"date": day.isoformat(), "fold_version": "v1", "output_sha256": digest}) + "\n")

    # Binance 1m files: one per month of the span, header-only stubs for every later month through 2026-10.
    all_minutes = t0 + np.arange(n_min, dtype=np.int64) * MINUTE
    for market in markets:
        if not market.binance_symbol or market.cls != "crypto":
            continue
        mid = market.market_id
        close = np.exp(paths[mid] + impacts[mid] + eps[mid]) * 100.0
        brng = np.random.default_rng([spec.seed, 99, mid])
        qv = np.exp(brng.normal(9.0, 1.0, n_min))
        tbq = qv * np.clip(brng.normal(0.5, 0.1, n_min), 0.05, 0.95)
        month_of = np.array(
            [dt.datetime.fromtimestamp(t / 1000, dt.UTC).strftime("%Y-%m") for t in all_minutes[::60]]
        ).repeat(60)
        sym_dir = binance_dir / market.binance_symbol
        sym_dir.mkdir(parents=True, exist_ok=True)
        for label in sorted(set(month_of)):
            sel = month_of == label
            lines = [BINANCE_HEADER]
            for t, c, q, b in zip(all_minutes[sel], close[sel], qv[sel], tbq[sel], strict=True):
                lines.append(f"{t},{c:.6f},{c:.6f},{c:.6f},{c:.6f},{q / c:.4f},{q:.4f},10,{b / c:.4f},{b:.4f}\n")
            with gzip.open(sym_dir / f"{market.binance_symbol}-1m-{label}.csv.gz", "wt") as f:
                f.write("".join(lines))
        for y, m in _month_starts(first_day, dt.date(2026, 10, 31)):
            path = sym_dir / f"{market.binance_symbol}-1m-{y:04d}-{m:02d}.csv.gz"
            if not path.exists():
                with gzip.open(path, "wt") as f:
                    f.write(BINANCE_HEADER)

    # Hourly funding from a day before the span to a day after (the guard filters the rest).
    f_first = t0 // 1000 - 86_400
    n_hours = (n_days + 2) * 24
    manifest_lines = []
    for market in markets:
        if market.market_id in spec.no_funding_markets:
            manifest_lines.append({"market_id": market.market_id, "symbol": market.symbol, "status": "empty"})
            continue
        manifest_lines.append({"market_id": market.market_id, "symbol": market.symbol, "status": "ok"})
        frng = np.random.default_rng([spec.seed, 7, market.market_id])
        ts = f_first + np.arange(n_hours, dtype=np.int64) * 3600
        rate = frng.normal(0.0, spec.funding_sd, n_hours)
        pq.write_table(
            pa.table(
                {
                    "market_id": pa.array(np.full(n_hours, market.market_id), pa.int32()),
                    "symbol": pa.array([market.coin] * n_hours),
                    "timestamp": pa.array(ts, pa.int64()),
                    "value": pa.array(["0"] * n_hours),
                    "rate": pa.array([f"{r * 100:.6f}" for r in rate]),
                    "direction": pa.array(["long"] * n_hours),
                    "rate_pct": pa.array(rate * 100),
                    "rate_long_pays": pa.array(rate),
                },
                schema=fetch_funding.SCHEMA,
            ),
            funding_dir / f"market_{market.market_id}.parquet",
        )

    (funding_dir / "manifest.jsonl").write_text("".join(json.dumps(x) + "\n" for x in manifest_lines))

    order_books = [
        {
            "symbol": m.symbol,
            "market_id": m.market_id,
            "market_type": "perp",
            "status": "active",
            "supported_price_decimals": m.price_decimals,
            "supported_size_decimals": 2,
            "min_base_amount": "0.01",
            "min_quote_amount": "10",
            "created_at": 0,
            "maker_fee": "0",
            "taker_fee": "0",
            "listed_in_order_books": m.market_id not in spec.no_funding_markets,  # a no-funding market is delisted
        }
        for m in markets
    ]
    order_books.append({**order_books[0], "symbol": "ETH/USDC", "market_id": 2048, "market_type": "spot"})
    (fold_dir / "markets.json").write_text(
        json.dumps(
            {
                "markets_file_version": 3,
                "fetched_at": "2026-11-11T00:00:00+00:00",
                "source": "synthetic",
                "unknown_market_ids": [],
                "order_books": order_books,
            },
            indent=1,
        )
    )
    quote_half = {
        m.market_id: half[m.market_id] * (events[m.market_id]["burst_factor"] if events else np.ones(n_min))
        for m in markets
    }
    return Panel(
        root,
        spec,
        fold_dir,
        binance_dir,
        funding_dir,
        last_day,
        markets,
        ft.day_start_ms(spec.start),
        half,
        t0,
        quote_half,
    )


def blank_minute_data(market: Market, t0_ms: int, n: int) -> MinuteData:

    def nan() -> np.ndarray:
        return np.full(n, np.nan)

    def zero() -> np.ndarray:
        return np.zeros(n)

    return MinuteData(
        market=market,
        t0_ms=t0_ms,
        n=n,
        last_px=nan(),
        last_buy_px=nan(),
        last_sell_px=nan(),
        last_buy_ts=nan(),
        last_sell_ts=nan(),
        first_buy_px=nan(),
        first_sell_px=nan(),
        first_buy_ts=nan(),
        first_sell_ts=nan(),
        buy_small=zero(),
        sell_small=zero(),
        buy_large=zero(),
        sell_large=zero(),
        b_has=np.zeros(n, dtype=bool),
        b_close=nan(),
        b_qv=nan(),
        b_tbq=nan(),
    )


def random_minute_data(market: Market, t0_ms: int, days: int, seed: int, binance: bool = True) -> MinuteData:
    """A MinuteData with random but fold-shaped content: gaps, one-sided minutes and noisy Binance bars."""
    n = days * 1440
    rng = np.random.default_rng(seed)
    md = blank_minute_data(market, t0_ms, n)
    minute = t0_ms + np.arange(n, dtype=np.int64) * MINUTE
    level = 100.0 * np.exp(np.cumsum(rng.normal(0.0, 3e-4, n)))
    h = 1e-4
    has_buy = rng.random(n) < 0.85
    has_sell = rng.random(n) < 0.85
    first_buy = has_buy & (rng.random(n) < 0.8)
    first_sell = has_sell & (rng.random(n) < 0.8)
    last_buy = level * (1 + h)
    last_sell = level * (1 - h)
    md.last_buy_px = np.where(has_buy, last_buy, np.nan)
    md.last_sell_px = np.where(has_sell, last_sell, np.nan)
    md.last_buy_ts = np.where(has_buy, minute + np.clip(MINUTE - rng.exponential(5000.0, n), 500, MINUTE - 1), np.nan)
    md.last_sell_ts = np.where(has_sell, minute + np.clip(MINUTE - rng.exponential(5000.0, n), 500, MINUTE - 1), np.nan)
    buy_later = np.nan_to_num(md.last_buy_ts, nan=-1.0) >= np.nan_to_num(md.last_sell_ts, nan=-1.0)
    md.last_px = np.where(buy_later, md.last_buy_px, md.last_sell_px)
    md.last_px = np.where(has_buy | has_sell, md.last_px, np.nan)
    md.first_buy_px = np.where(first_buy, last_buy * (1 + rng.normal(0, 1e-5, n)), np.nan)
    md.first_sell_px = np.where(first_sell, last_sell * (1 + rng.normal(0, 1e-5, n)), np.nan)
    md.first_buy_ts = np.where(first_buy, minute + rng.integers(500, 30_000, n), np.nan)
    md.first_sell_ts = np.where(first_sell, minute + rng.integers(500, 30_000, n), np.nan)
    md.buy_small = np.where(has_buy, rng.exponential(300.0, n), 0.0)
    md.sell_small = np.where(has_sell, rng.exponential(300.0, n), 0.0)
    md.buy_large = np.where(has_buy & (rng.random(n) < 0.2), rng.exponential(30_000.0, n), 0.0)
    md.sell_large = np.where(has_sell & (rng.random(n) < 0.2), rng.exponential(30_000.0, n), 0.0)
    if binance:
        md.b_has = rng.random(n) < 0.9995
        md.b_close = np.where(md.b_has, level * (1 + rng.normal(0, 1.5e-4, n)), np.nan)
        md.b_qv = np.where(md.b_has, rng.exponential(1e5, n), np.nan)
        md.b_tbq = np.where(md.b_has, md.b_qv * rng.uniform(0.2, 0.8, n), np.nan)
    return md


def rewrite_binance_wrong_asset(panel: Panel, symbol: str, seed: int = 99) -> None:
    """Replace a symbol's Binance files (months with data) by an unrelated random walk (another asset's ticker)."""
    rng = np.random.default_rng(seed)
    for path in sorted((panel.binance_dir / symbol).glob(f"{symbol}-1m-*.csv.gz")):
        with gzip.open(path, "rt") as f:
            lines = f.read().splitlines()
        if len(lines) <= 1:
            continue
        header, rows = lines[0], [r.split(",") for r in lines[1:]]
        walk = 100.0 * np.exp(np.cumsum(rng.normal(0.0, 3e-4, len(rows))))
        out = [header]
        for r, px in zip(rows, walk, strict=True):
            out.append(f"{r[0]},{px:.6f},{px:.6f},{px:.6f},{px:.6f},{r[5]},{r[6]},{r[7]},{r[8]},{r[9]}")
        with gzip.open(path, "wt") as f:
            f.write("\n".join(out) + "\n")
