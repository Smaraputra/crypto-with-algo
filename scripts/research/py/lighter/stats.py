"""Lighter stage 2: per-configuration statistics, the passing rules, the noise bar, finalists and the account layer."""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from lighter import lock
from lighter.fills import TradeBatch

DAY_MS = lock.DAY_MS


def newey_west(x: np.ndarray, lags: int = lock.NW_LAGS) -> tuple[float, float, float]:
    """Mean, Newey-West standard error of the mean (Bartlett kernel) and t. t is 0 when the error is 0."""
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    if n == 0:
        return 0.0, 0.0, 0.0
    mean = float(x.mean())
    if n < 2:
        return mean, 0.0, 0.0
    d = x - mean
    var = float(d @ d) / n
    for lag in range(1, min(lags, n - 1) + 1):
        w = 1.0 - lag / (lags + 1.0)
        var += 2.0 * w * float(d[lag:] @ d[:-lag]) / n
    se = math.sqrt(var / n) if var > 0 else 0.0
    return mean, se, (mean / se if se > 0 else 0.0)


def normal_sf(t: float) -> float:
    return 0.5 * math.erfc(t / math.sqrt(2.0))


class _Block:
    """Daily series and counters of one set of trades (a whole configuration, or one price source of it)."""

    def __init__(self, n_days: int) -> None:
        self.n_days = n_days
        self.daily_sum = np.zeros(n_days)
        self.daily_cnt = np.zeros(n_days, dtype=np.int64)
        self.gross = 0.0
        self.fund = 0.0
        self.n = 0
        self.flagged = 0
        self.missing = 0
        self.settlements = 0
        self.cost = 0.0
        self.ties = 0
        self.markets: dict[int, list[float]] = {}

    def add(
        self,
        market_id: int,
        day: np.ndarray,
        batch: TradeBatch,
        sel: np.ndarray | None = None,
        count_funding: bool = True,
    ) -> None:
        """count_funding False (a no-funding market): the trade's settlements and missing rows stay out of the
        missing-funding share, numerator and denominator."""
        row = self.markets.setdefault(market_id, [0.0, 0.0])
        net = batch.net if sel is None else batch.net[sel]
        if len(net) == 0:
            return
        d = day if sel is None else day[sel]
        pick = (lambda a: a) if sel is None else (lambda a: a[sel])
        self.daily_sum += np.bincount(d, weights=net, minlength=self.n_days)
        self.daily_cnt += np.bincount(d, minlength=self.n_days)
        self.n += len(net)
        self.flagged += int(np.count_nonzero(pick(batch.flag)))
        if count_funding:
            self.missing += int(pick(batch.miss).sum())
            self.settlements += int(pick(batch.nsettle).sum())
        self.cost += float(pick(batch.cost).sum())
        self.ties += int(pick(batch.ties).sum())
        self.gross += float(pick(batch.gross).sum())
        self.fund += float(pick(batch.fund).sum())
        row[0] += len(net)
        row[1] += float(net.sum())

    def summary(self, day0_ms: int) -> dict[str, Any]:
        series, counts = self.daily_sum, self.daily_cnt
        mean_daily, se, t = newey_west(series)
        hours = len(series) * 24
        out: dict[str, Any] = {
            "trades": self.n,
            "flagged_exits": self.flagged,
            "missing_funding": self.missing,
            "settlements_crossed": self.settlements,
            "mean_fill_cost_bps": (self.cost / self.n) if self.n else None,
            "tie_share": (self.ties / (2 * self.n)) if self.n else None,
            "days": len(series),
            "mean_net_bps": (float(series.sum()) / self.n * lock.BPS) if self.n else None,
            "mean_gross_bps": (self.gross / self.n * lock.BPS) if self.n else None,
            "mean_funding_bps": (self.fund / self.n * lock.BPS) if self.n else None,
            "mean_daily_net": mean_daily,
            "se_daily": se,
            "t": t,
            "entries_per_hour": self.n / hours if hours else 0.0,
        }
        days = (day0_ms // DAY_MS + np.arange(len(series))).astype("datetime64[D]")
        labels, inv = np.unique(days.astype("datetime64[M]"), return_inverse=True)
        m_net = np.bincount(inv, weights=series, minlength=len(labels))
        m_cnt = np.bincount(inv, weights=counts, minlength=len(labels)).astype(np.int64)
        months = [
            {"month": str(lab), "net": float(net), "trades": int(c)}
            for lab, net, c in zip(labels, m_net, m_cnt, strict=True)
        ]
        out["months"] = months
        traded = [m for m in months if m["trades"] > 0]
        out["months_with_trades"] = len(traded)
        out["pos_month_share"] = (sum(m["net"] > 0 for m in traded) / len(traded)) if traded else None
        big = [v for v in self.markets.values() if v[0] >= lock.PASS_MARKET_MIN_TRADES]
        out["markets_100"] = len(big)
        out["pos_market_share"] = (sum(v[1] > 0 for v in big) / len(big)) if big else None
        out["per_market"] = {str(k): {"trades": int(v[0]), "net": v[1]} for k, v in sorted(self.markets.items())}
        return out


class ConfigAcc:
    """Accumulates one configuration's trades across markets, in total and split by signal price source."""

    SOURCES = ("binance", "lighter")

    def __init__(self, cfg: lock.Config, day0_ms: int, n_days: int) -> None:
        self.cfg = cfg
        self.day0_ms = day0_ms
        self.n_days = n_days
        self.total = _Block(n_days)
        self.by_source = {src: _Block(n_days) for src in self.SOURCES}
        self.by_class = {k: _Block(n_days) for k in ("crypto", "tradfi", "unclassified")}
        self.no_funding_trades = 0  # trades of no-funding markets (charged zero funding)
        self.no_funding_net = 0.0  # their summed net, so the mean without them needs no second run
        self.unfilled = 0
        self.no_sigma = 0
        self.no_exit = 0
        self.trigger_fired = 0
        self.trigger_valid = 0

    def add_trigger(self, fired: int, valid: int) -> None:
        self.trigger_fired += fired
        self.trigger_valid += valid

    def add(
        self,
        market_id: int,
        batch: TradeBatch,
        binance: np.ndarray | None = None,
        klass: str | None = None,
        no_funding: bool = False,
    ) -> None:
        """binance: per trade, True when the decision month's price source was binance (None: all lighter).

        klass: the asset class of the market, for the split of the F2 statistics. no_funding: the market is a
        no-funding market: its trades are counted in no_funding_trades and kept out of the missing-funding share."""
        self.unfilled += batch.unfilled
        self.no_sigma += batch.no_sigma
        self.no_exit += batch.no_exit
        if batch.n == 0:
            self.total.markets.setdefault(market_id, [0.0, 0.0])
            return
        day = (batch.exit_ts - self.day0_ms) // DAY_MS
        if day.min() < 0 or day.max() >= self.n_days:
            raise ValueError("a trade exits outside the span")
        flags = np.zeros(batch.n, dtype=bool) if binance is None else np.asarray(binance, dtype=bool)
        cf = not no_funding
        self.total.add(market_id, day, batch, count_funding=cf)
        if no_funding:
            self.no_funding_trades += batch.n
            self.no_funding_net += float(batch.net.sum())
        if klass in self.by_class:
            self.by_class[klass].add(market_id, day, batch, count_funding=cf)
        if flags.any():
            self.by_source["binance"].add(market_id, day, batch, flags, count_funding=cf)
        if (~flags).any():
            self.by_source["lighter"].add(market_id, day, batch, ~flags, count_funding=cf)

    def finalize(self) -> dict[str, Any]:
        cfg = self.cfg
        out: dict[str, Any] = {
            "id": cfg.cid,
            "family": cfg.family,
            "signal": cfg.signal.sig_id,
            "hold": cfg.hold,
            "exit": cfg.exit,
            "universe": cfg.universe,
            "unfilled": self.unfilled,
            "no_sigma": self.no_sigma,
            "no_exit": self.no_exit,
        }
        out.update(self.total.summary(self.day0_ms))
        out["class"] = "desk" if out["entries_per_hour"] >= lock.DESK_ENTRIES_PER_HOUR else "slow"
        out["flagged_share"] = out["flagged_exits"] / out["trades"] if out["trades"] else 0.0
        out["missing_funding_share"] = (
            out["missing_funding"] / out["settlements_crossed"] if out["settlements_crossed"] else 0.0
        )
        keep = ("trades", "mean_net_bps", "mean_gross_bps", "t", "entries_per_hour", "pos_month_share", "markets_100")
        out["by_source"] = {}
        for src, block in self.by_source.items():
            sub = block.summary(self.day0_ms)
            out["by_source"][src] = {k: sub[k] for k in keep} | {"months": sub["months"]}
        counts = {src: out["by_source"][src]["trades"] for src in self.SOURCES}
        majority = max(counts, key=lambda k: (counts[k], k)) if out["trades"] else None
        rest = out["trades"] - self.no_funding_trades
        out["no_funding_trades"] = self.no_funding_trades
        out["trades_ex_no_funding"] = rest
        out["mean_net_ex_no_funding_bps"] = (
            (float(self.total.daily_sum.sum()) - self.no_funding_net) / rest * lock.BPS if rest > 0 else None
        )
        out["majority_source"] = majority
        out["majority_source_mean_net_bps"] = out["by_source"][majority]["mean_net_bps"] if majority else None
        if cfg.family == "F2":
            out["by_class"] = {}
            for klass, block in self.by_class.items():
                sub = block.summary(self.day0_ms)
                if sub["trades"]:
                    out["by_class"][klass] = {k: sub[k] for k in keep}
        if cfg.family == "F4":
            out["trigger_rate"] = self.trigger_fired / self.trigger_valid if self.trigger_valid else None
            out["trigger_valid_points"] = self.trigger_valid
        return out


def noise_offset_days(seed: int) -> int:
    """The day offset D of shift run `seed` (1 to 20): the seed-th of 20 distinct values, shared by all markets."""
    return lock.noise_offsets()[seed - 1]


def shift_sides(sides: np.ndarray, start_j: int, days: int) -> np.ndarray:
    """Circular shift of the decision array by `days` days within [start_j, end) (the market's span)."""
    out = sides.copy()
    out[start_j:] = np.roll(sides[start_j:], days * lock.GRID_PER_DAY)
    return out


def signflip_rng(seed: int) -> np.random.Generator:
    return np.random.default_rng([lock.NOISE_SEED, seed])


def signflip(sides: np.ndarray, rng: np.random.Generator, start_j: int) -> np.ndarray:
    """Each decision multiplied by an independent fair random sign (one draw per grid point of the span)."""
    signs = rng.choice(np.array([-1, 1], dtype=np.int8), size=len(sides) - start_j)
    out = sides.copy()
    out[start_j:] = sides[start_j:] * signs
    return out


def noise_bar(maxima: list[float]) -> float:
    """The largest of the maxima."""
    return float(np.max(np.asarray(maxima, dtype=np.float64)))


def dev_flags(stat: dict[str, Any], bar: float, f6_bar: float | None = None) -> dict[str, Any]:
    """Development items (a) to (f) for one configuration's stats. bar: NOISE_BAR, f6_bar: F6_BAR (for family F6)."""
    use = f6_bar if (stat.get("family") == "F6" and f6_bar is not None) else bar
    mean = stat.get("mean_net_bps")
    a = mean is not None and mean > 0
    b = stat["t"] >= max(lock.PASS_MIN_T, use)
    share = stat.get("pos_month_share")
    c = (
        stat.get("months_with_trades", 0) >= lock.PASS_MIN_MONTHS_WITH_TRADES
        and share is not None
        and share >= lock.PASS_MIN_MONTH_SHARE
    )
    mshare = stat.get("pos_market_share")
    d = (
        stat.get("markets_100", 0) >= lock.PASS_MIN_MARKETS
        and mshare is not None
        and mshare >= lock.PASS_MIN_MARKET_SHARE
    )
    e = stat["trades"] >= lock.PASS_MIN_TRADES
    f = stat["trades"] > 0 and stat.get("flagged_exits", 0) <= lock.PASS_MAX_FLAGGED_SHARE * stat["trades"]
    flags = {"a": a, "b": b, "c": c, "d": d, "e": e, "f": f}
    out = {k: bool(v) for k, v in flags.items()}
    out["pass"] = all(out.values())
    return out


def is_suspect(stat: dict[str, Any]) -> bool:
    mean = stat.get("mean_net_bps")
    return bool((mean is not None and mean > lock.TRIPWIRE_MEAN_BPS) or stat["t"] > lock.TRIPWIRE_T)


def finalist_candidates(
    stats: list[dict[str, Any]], bar: float, f6_bar: float, cleared: tuple[str, ...] = ()
) -> list[dict[str, Any]]:
    """Configurations passing items (a) to (f), not SUSPECT unless cleared, with funding coverage in order."""
    out = []
    for s in stats:
        if not dev_flags(s, bar, f6_bar)["pass"]:
            continue
        if is_suspect(s) and s["id"] not in cleared:
            continue
        if s.get("missing_funding_share", 0.0) > lock.MAX_MISSING_FUNDING_SHARE:
            continue
        if "majority_source_mean_net_bps" in s and not (s["majority_source_mean_net_bps"] or 0.0) > 0:
            continue
        out.append(s)
    return out


def variant_checks(
    cfg_mean: float | None,
    mirror_mean: float | None,
    doubled_mean: float | None,
    cost_bps: float | None = 0.0,
    no_funding_trades: int = 0,
    mean_ex_no_funding: float | None = None,
) -> dict[str, Any]:
    """The cost-adjusted mirror diagnostic and the spread sensitivity of one configuration (means in bps per trade).

    The diagnostic (mean(cfg) - mean(mirror)) / 2 must exceed the mean over the configuration's trades of
    (sp_fill at entry + sp_fill at exit) / 2, both in bps, i.e. the same units (log return x 10,000).

    The no-funding condition: funding of a no-funding market is assumed zero, so with every trade of such a market
    removed the mean net per trade must still be positive (nothing left counts as failing). It holds trivially when
    the configuration has no no-funding trades.
    """
    diag = None if cfg_mean is None or mirror_mean is None else (cfg_mean - mirror_mean) / 2.0
    cost = 0.0 if cost_bps is None else cost_bps
    return {
        "mean_cfg_bps": cfg_mean,
        "mean_mirror_bps": mirror_mean,
        "mirror_diagnostic_bps": diag,
        "mean_fill_cost_bps": cost,
        "mirror_ok": bool(diag is not None and diag > cost),
        "mean_doubled_spread_bps": doubled_mean,
        "doubled_ok": bool(doubled_mean is not None and doubled_mean > 0),
        "no_funding_trades": int(no_funding_trades),
        "mean_net_ex_no_funding_bps": mean_ex_no_funding,
        "no_funding_ok": bool(no_funding_trades == 0 or (mean_ex_no_funding is not None and mean_ex_no_funding > 0)),
    }


def select_finalists(
    candidates: list[dict[str, Any]], checks: dict[str, dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """At most three: the best candidate of each family (desk first), then the top three by daily t.

    checks maps a configuration id to its variant_checks; a candidate needs both of its checks to be ok.
    """
    best: list[dict[str, Any]] = []
    for fam in lock.FAMILIES:
        pool = [s for s in candidates if s["family"] == fam]
        if checks is not None:
            pool = [
                s
                for s in pool
                if checks.get(s["id"], {}).get("mirror_ok")
                and checks[s["id"]].get("doubled_ok")
                and checks[s["id"]].get("no_funding_ok", True)
            ]
        if not pool:
            continue
        desk = [s for s in pool if s["class"] == "desk"]
        best.append(max(desk or pool, key=lambda s: (s["t"], s["id"])))
    best.sort(key=lambda s: (-s["t"], s["id"]))
    return best[: lock.MAX_FINALISTS]


def holm(pvalues: dict[str, float], alpha: float = lock.CONFIRM_ALPHA) -> dict[str, bool]:
    """Holm at family level alpha: smallest p < alpha / F, next < alpha / (F - 1), stop at the first failure."""
    order = sorted(pvalues, key=lambda k: (pvalues[k], k))
    out = dict.fromkeys(order, False)
    f = len(order)
    for rank, key in enumerate(order):
        if pvalues[key] < alpha / (f - rank):
            out[key] = True
        else:
            break
    return out


def confirm_flags(
    stat: dict[str, Any], checks: dict[str, Any] | None = None, majority_source: str | None = None
) -> dict[str, Any]:
    """One finalist's confirmation items before Holm: mean, p, months, mirror, doubled spread and the source.

    majority_source: the signal price source that carried most of the configuration's DEVELOPMENT trades. The mean net
    per trade within that source on the confirmation data must be positive too.
    """
    mean = stat.get("mean_net_bps")
    p = normal_sf(stat["t"])
    by_month = {m["month"]: m["net"] for m in stat.get("months", [])}
    positive = sum(by_month.get(f"{y:04d}-{m:02d}", 0.0) > 0 for y, m in lock.CONFIRM_MONTHS)
    ok_mean = mean is not None and mean > 0
    ok_m = positive >= lock.CONFIRM_MIN_POSITIVE_MONTHS
    out: dict[str, Any] = {
        "mean_positive": bool(ok_mean),
        "p_one_sided": p,
        "positive_months": int(positive),
        "months_ok": bool(ok_m),
    }
    ok_source = True
    if majority_source is not None:
        src_mean = stat.get("by_source", {}).get(majority_source, {}).get("mean_net_bps")
        ok_source = bool(src_mean is not None and src_mean > 0)
        out["majority_source"] = majority_source
        out["majority_source_mean_net_bps"] = src_mean
    out["source_ok"] = ok_source
    ok_checks = True
    if checks is not None:
        out.update(checks)
        ok_checks = bool(checks["mirror_ok"] and checks["doubled_ok"] and checks.get("no_funding_ok", True))
    out["checks_ok"] = ok_checks
    out["pre_holm_ok"] = bool(ok_mean and ok_m and ok_checks and ok_source)
    return out


def apply_holm(flags_by_id: dict[str, dict[str, Any]]) -> None:
    """Adds p_below_holm and pass to each finalist's flags (Holm over the finalists' p values)."""
    verdict = holm({k: v["p_one_sided"] for k, v in flags_by_id.items()})
    for k, v in flags_by_id.items():
        v["p_below_holm"] = bool(verdict[k])
        v["pass"] = bool(v["pre_holm_ok"] and verdict[k])


# ---------------------------------------------------------------------------------------------------------------
# Account layer (report only)


def simulate_account(
    trades: dict[str, np.ndarray],
    mids: dict[int, tuple[int, np.ndarray]],
    leverage: float,
) -> dict[str, Any]:
    """100 USD account over one configuration's trades (all markets). mids maps market id to (t0_ms, mid per minute)."""
    n = len(trades["entry_ts"])
    order = np.lexsort((trades["exit_ts"], trades["market_id"], trades["entry_ts"]))
    e_min = (trades["entry_ts"][order] // lock.MINUTE_MS).tolist()
    x_min = (trades["exit_ts"][order] // lock.MINUTE_MS).tolist()
    mk = trades["market_id"][order].tolist()
    sd = trades["side"][order].astype(np.int64).tolist()
    e_px = trades["entry_px"][order].tolist()
    x_px = trades["exit_px"][order].tolist()
    fund = trades["fund"][order].tolist()

    def mark(market_id: int, minute: int, fallback: float) -> float:
        t0, arr = mids[market_id]
        i = minute - t0 // lock.MINUTE_MS
        if 0 <= i < len(arr) and not math.isnan(arr[i]):
            return float(arr[i])
        return fallback

    cash = lock.ACCOUNT_START
    min_eq = cash
    skipped = 0
    taken = 0
    liquidated = False
    open_pos: list[list[Any]] = []  # [idx, notional]
    ptr = 0
    m = e_min[0] if n else 0
    while (ptr < n or open_pos) and not liquidated:
        if not open_pos and ptr < n:
            m = max(m, e_min[ptr])
        still = []
        for pos in open_pos:
            i, notional = pos
            if x_min[i] <= m:
                cash += notional * (sd[i] * (x_px[i] / e_px[i] - 1.0) - fund[i])
            else:
                still.append(pos)
        open_pos = still
        while ptr < n and e_min[ptr] <= m:
            unreal = sum(notional * sd[i] * (mark(mk[i], m, e_px[i]) / e_px[i] - 1.0) for i, notional in open_pos)
            equity = cash + unreal
            if len(open_pos) >= lock.ACCOUNT_MAX_POSITIONS or equity * leverage / 10.0 < lock.ACCOUNT_MIN_NOTIONAL:
                skipped += 1
            else:
                open_pos.append([ptr, max(lock.ACCOUNT_MIN_NOTIONAL, equity * leverage / 10.0)])
                taken += 1
            ptr += 1
        unreal = sum(notional * sd[i] * (mark(mk[i], m, e_px[i]) / e_px[i] - 1.0) for i, notional in open_pos)
        equity = cash + unreal
        min_eq = min(min_eq, equity)
        gross = sum(notional for _, notional in open_pos)
        if open_pos and equity <= lock.ACCOUNT_MAINTENANCE * gross:
            liquidated = True
            cash = max(equity, 0.0)
            open_pos = []
            break
        m += 1
    return {
        "leverage": leverage,
        "final_equity": cash,
        "min_equity": min_eq,
        "entries_taken": taken,
        "entries_skipped": skipped,
        "liquidated": liquidated,
    }
