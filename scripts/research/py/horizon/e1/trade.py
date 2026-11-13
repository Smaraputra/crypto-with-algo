"""Hedged short trade simulation for one pair (rules 3 to 7 of horizon-e1 lock)."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from horizon.e1 import lock
from horizon.e1.data import Bars, Funding
from horizon.e1.events import Pair, record_status

__all__ = ["TradeResult", "simulate"]


@dataclass(frozen=True)
class TradeResult:
    token: str
    symbol: str
    horizon_hours: int
    delay_minutes: int
    status: str  # "ok" or "excluded"
    reason: str | None  # for "excluded": "activity", "entry_bar" or "btc_missing"
    entry_ms: int
    te_ms: int  # entry_ms + horizon_hours * 3_600_000
    exit_ms: int  # when both legs close (rule 3 and rule 5), 0 when excluded
    pe: float  # NaN when excluded
    px: float
    be: float
    bx: float
    stopped: bool
    truncated: bool
    funding_gap: bool
    n_settlements: int
    gross_token: float  # (pe - px) / pe
    gross_btc: float  # (bx - be) / be
    fees: float  # both legs, entry and exit, as a fraction of the 1.0 short notional
    slippage: float  # both legs
    funding_token: float
    funding_btc: float
    net: float  # hedged net result
    net_unhedged: float  # token leg only
    net_stress: float  # hedged net with SLIP_STRESS_MULT x slippage
    max_adverse: float  # max high over the scan range / pe - 1


def _make_excluded(
    token: str,
    symbol: str,
    horizon_hours: int,
    delay_minutes: int,
    reason: str,
    entry_ms: int,
    te_ms: int,
) -> TradeResult:
    """Return an excluded TradeResult filled with NaNs and zero or false values."""
    nan = float("nan")
    return TradeResult(
        token=token,
        symbol=symbol,
        horizon_hours=horizon_hours,
        delay_minutes=delay_minutes,
        status="excluded",
        reason=reason,
        entry_ms=entry_ms,
        te_ms=te_ms,
        exit_ms=0,
        pe=nan,
        px=nan,
        be=nan,
        bx=nan,
        stopped=False,
        truncated=False,
        funding_gap=False,
        n_settlements=0,
        gross_token=nan,
        gross_btc=nan,
        fees=nan,
        slippage=nan,
        funding_token=nan,
        funding_btc=nan,
        net=nan,
        net_unhedged=nan,
        net_stress=nan,
        max_adverse=nan,
    )


def _check_funding_gap(funding: Funding, entry_ms: int, exit_ms: int) -> bool:
    """Check if funding settlement series has a gap over [entry_ms, exit_ms]."""
    if len(funding.calc_time) == 0:
        return True

    before_entry = np.where(funding.calc_time <= entry_ms)[0]
    if len(before_entry) == 0:
        return True
    idx_start = int(before_entry[-1])

    after_exit = np.where(funding.calc_time > exit_ms)[0]
    if len(after_exit) == 0:
        return True
    idx_end = int(after_exit[0])

    for i in range(idx_start, idx_end):
        inv_hours = float(funding.interval_hours[i])
        if math.isnan(inv_hours):
            return True
        allowed_ms = int(inv_hours * lock.HOUR_MS) + lock.FUNDING_GAP_SLACK_MINUTES * lock.MINUTE_MS
        diff_ms = int(funding.calc_time[i + 1] - funding.calc_time[i])
        if diff_ms > allowed_ms:
            return True

    return False


def _calc_leg_funding(
    funding: Funding,
    bars: Bars,
    entry_ms: int,
    exit_ms: int,
    base_price: float,
    *,
    is_short: bool,
) -> tuple[float, int]:
    """Calculate funding cashflow and settlement count for one leg over (entry_ms, exit_ms]."""
    mask = (funding.calc_time > entry_ms) & (funding.calc_time <= exit_ms)
    settlement_times = funding.calc_time[mask]
    settlement_rates = funding.rate[mask]

    n_settlements = len(settlement_times)
    if n_settlements == 0:
        return 0.0, 0

    total_funding = 0.0
    for t, rate in zip(settlement_times, settlement_rates, strict=True):
        target_open_time = int(t) - lock.MINUTE_MS
        idx = int(np.searchsorted(bars.open_time, target_open_time, side="right")) - 1
        if idx >= 0:
            close_before = float(bars.close[idx])
            factor = close_before / base_price
        else:
            factor = 1.0

        cashflow = float(rate) * factor
        total_funding += cashflow

    if is_short:
        return total_funding, n_settlements
    return -total_funding, n_settlements


def simulate(
    pair: Pair,
    store,
    horizon_hours: int,
    delay_minutes: int = lock.ENTRY_DELAY_MINUTES,
) -> TradeResult:
    """Simulate a hedged short trade on one pair following horizon-e1 rules 2 to 7."""
    rec_status = record_status(pair)
    if rec_status is not None:
        raise AssertionError(f"pair {pair.token} is not eligible: record_status={rec_status!r}")
    if pair.symbol is None:
        raise AssertionError(f"pair {pair.token} has no symbol")

    token = pair.token
    symbol = pair.symbol

    # 1. Clock (rule 3)
    s = pair.stamp_ms
    m_start = (s // lock.MINUTE_MS) * lock.MINUTE_MS
    m0 = m_start + lock.MINUTE_MS
    entry_ms = m0 + delay_minutes * lock.MINUTE_MS
    te_ms = entry_ms + horizon_hours * lock.HOUR_MS

    # 2. Eligibility from the bars (rule 2)
    # Request token bars for [M - 1440 * 60_000, te + 60_000]
    token_bars = store.bars(symbol, m_start - lock.ACTIVITY_WINDOW_MINUTES * lock.MINUTE_MS, te_ms + lock.MINUTE_MS)
    # Request BTCUSDT bars for [entry_ms, te + 60_000]
    btc_bars = store.bars("BTCUSDT", entry_ms, te_ms + lock.MINUTE_MS)

    # (s4) Activity check in [M - 1440 min, M)
    act_mask = (
        (token_bars.open_time >= m_start - lock.ACTIVITY_WINDOW_MINUTES * lock.MINUTE_MS)
        & (token_bars.open_time < m_start)
        & (token_bars.volume > 0)
    )
    if int(np.count_nonzero(act_mask)) < lock.ACTIVITY_MIN_TRADED_MINUTES:
        return _make_excluded(token, symbol, horizon_hours, delay_minutes, "activity", entry_ms, te_ms)

    # (s5) Token entry bar with volume > 0
    token_entry_idx = token_bars.index_of(entry_ms)
    if token_entry_idx < 0 or token_bars.volume[token_entry_idx] <= 0:
        return _make_excluded(token, symbol, horizon_hours, delay_minutes, "entry_bar", entry_ms, te_ms)

    # BTCUSDT entry bar exists
    btc_entry_idx = btc_bars.index_of(entry_ms)
    if btc_entry_idx < 0:
        return _make_excluded(token, symbol, horizon_hours, delay_minutes, "btc_missing", entry_ms, te_ms)

    # 3. Entry prices
    pe = float(token_bars.open[token_entry_idx])
    be = float(btc_bars.open[btc_entry_idx])

    # 5. Exit candidate when not stopped (rule 3)
    bar_te_idx = token_bars.index_of(te_ms)
    if bar_te_idx >= 0 and token_bars.volume[bar_te_idx] > 0:
        cand_px = float(token_bars.open[bar_te_idx])
        cand_exit_idx = bar_te_idx
        cand_exit_ms = te_ms
        cand_truncated = False
        cand_btc_target_ms = te_ms
        scan_end_inclusive = False
        scan_boundary_ms = te_ms
    else:
        valid_mask = (token_bars.open_time <= te_ms) & (token_bars.volume > 0)
        valid_indices = np.where(valid_mask)[0]
        last_traded_idx = int(valid_indices[-1])
        last_traded_open_ms = int(token_bars.open_time[last_traded_idx])
        cand_px = float(token_bars.close[last_traded_idx])
        cand_exit_idx = last_traded_idx

        if (te_ms - last_traded_open_ms) > lock.STALE_EXIT_MINUTES * lock.MINUTE_MS:
            cand_truncated = True
            cand_exit_ms = last_traded_open_ms + lock.MINUTE_MS
            cand_btc_target_ms = cand_exit_ms
            scan_end_inclusive = True
            scan_boundary_ms = last_traded_open_ms
        else:
            cand_truncated = False
            cand_exit_ms = te_ms
            cand_btc_target_ms = te_ms
            scan_end_inclusive = False
            scan_boundary_ms = te_ms

    # Scan range for stop and max adverse excursion
    if scan_end_inclusive:
        scan_mask = (token_bars.open_time >= entry_ms) & (token_bars.open_time <= scan_boundary_ms)
    else:
        scan_mask = (token_bars.open_time >= entry_ms) & (token_bars.open_time < scan_boundary_ms)
    scan_indices = np.where(scan_mask)[0]

    # 10. Max adverse excursion over the scan range (stop does not shorten it)
    max_high = float(np.max(token_bars.high[scan_indices]))
    max_adverse = (max_high / pe) - 1.0

    # 4. Stop scan (rule 5)
    stop_level = pe * (1.0 + lock.STOP_ADVERSE)
    stop_idx: int | None = None
    for idx in scan_indices:
        if token_bars.high[idx] >= stop_level:
            stop_idx = int(idx)
            break

    if stop_idx is not None:
        stopped = True
        truncated = False
        exit_ms = int(token_bars.open_time[stop_idx])
        px = max(stop_level, float(token_bars.open[stop_idx]))
        exit_bar_idx = stop_idx
        btc_target_ms = exit_ms
    else:
        stopped = False
        truncated = cand_truncated
        exit_ms = cand_exit_ms
        px = cand_px
        exit_bar_idx = cand_exit_idx
        btc_target_ms = cand_btc_target_ms

    # BTC exit price lookup
    btc_exit_idx = btc_bars.index_of(btc_target_ms)
    if btc_exit_idx >= 0:
        bx = float(btc_bars.open[btc_exit_idx])
    else:
        btc_fallback_mask = (btc_bars.open_time >= btc_target_ms - lock.STALE_EXIT_MINUTES * lock.MINUTE_MS) & (
            btc_bars.open_time <= btc_target_ms
        )
        btc_fallback_indices = np.where(btc_fallback_mask)[0]
        if len(btc_fallback_indices) == 0:
            return _make_excluded(token, symbol, horizon_hours, delay_minutes, "btc_missing", entry_ms, te_ms)
        bx = float(btc_bars.open[btc_fallback_indices[-1]])

    # 6. Gross (rule 4)
    gross_token = (pe - px) / pe
    gross_btc = (bx - be) / be

    # 7. Costs (rule 6)
    bps = 1e-4
    vt = px / pe
    vb = bx / be
    fees = lock.TAKER_FEE_BPS * bps * (1.0 + vt + 1.0 + vb)

    # Token slippage
    entry_range_bps = (float(token_bars.high[token_entry_idx]) - float(token_bars.low[token_entry_idx])) / pe * 1e4
    entry_slip_bps = max(lock.SLIP_TOKEN_FLOOR_BPS, lock.SLIP_TOKEN_RANGE_SHARE * entry_range_bps)
    entry_slip_token = entry_slip_bps * bps * 1.0

    exit_bar_open = float(token_bars.open[exit_bar_idx])
    exit_range_bps = (float(token_bars.high[exit_bar_idx]) - float(token_bars.low[exit_bar_idx])) / exit_bar_open * 1e4
    exit_slip_bps = max(lock.SLIP_TOKEN_FLOOR_BPS, lock.SLIP_TOKEN_RANGE_SHARE * exit_range_bps)
    exit_slip_token = exit_slip_bps * bps * vt

    token_slippage = entry_slip_token + exit_slip_token
    btc_slippage = lock.SLIP_BTC_BPS * bps * (1.0 + vb)
    slippage = token_slippage + btc_slippage

    # 8. Funding (rule 7)
    f_start = entry_ms - lock.DAY_MS
    f_end = exit_ms + 12 * lock.HOUR_MS
    token_funding = store.funding(symbol, f_start, f_end)
    btc_funding = store.funding("BTCUSDT", f_start, f_end)

    funding_gap = _check_funding_gap(token_funding, entry_ms, exit_ms) or _check_funding_gap(
        btc_funding, entry_ms, exit_ms
    )

    funding_token, n_settlements = _calc_leg_funding(token_funding, token_bars, entry_ms, exit_ms, pe, is_short=True)
    funding_btc, _ = _calc_leg_funding(btc_funding, btc_bars, entry_ms, exit_ms, be, is_short=False)

    # 9. Net
    net = gross_token + gross_btc - fees - slippage + funding_token + funding_btc
    token_fees = lock.TAKER_FEE_BPS * bps * (1.0 + vt)
    net_unhedged = gross_token - token_fees - token_slippage + funding_token
    net_stress = gross_token + gross_btc - fees - (lock.SLIP_STRESS_MULT * slippage) + funding_token + funding_btc

    return TradeResult(
        token=token,
        symbol=symbol,
        horizon_hours=horizon_hours,
        delay_minutes=delay_minutes,
        status="ok",
        reason=None,
        entry_ms=entry_ms,
        te_ms=te_ms,
        exit_ms=exit_ms,
        pe=pe,
        px=px,
        be=be,
        bx=bx,
        stopped=stopped,
        truncated=truncated,
        funding_gap=funding_gap,
        n_settlements=n_settlements,
        gross_token=gross_token,
        gross_btc=gross_btc,
        fees=fees,
        slippage=slippage,
        funding_token=funding_token,
        funding_btc=funding_btc,
        net=net,
        net_unhedged=net_unhedged,
        net_stress=net_stress,
        max_adverse=max_adverse,
    )
