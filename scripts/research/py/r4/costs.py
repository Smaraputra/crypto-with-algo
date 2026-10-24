"""Trading costs, fee schedules, slippage, and funding rate math with parity to TypeScript."""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

BINANCE_FUTURES_MAKER_FEE: float = 0.0002
BINANCE_FUTURES_TAKER_FEE: float = 0.0005

STUDY_SLIPPAGE_BPS: dict[str, int] = {
    "1m": 5,
    "5m": 5,
    "15m": 3,
    "1h": 3,
    "4h": 2,
    "8h": 2,
    "1d": 2,
}

FUNDING_INTERVAL_MS: int = 28_800_000
DEFAULT_FEE_PROFILE: str = "standard"


@dataclass(frozen=True)
class FeeProfile:
    """A fee schedule the research study can price under."""

    name: str
    maker_fee: float
    taker_fee: float
    note: str
    symbols: tuple[str, ...] | None = None
    fallback: str | None = None

    @property
    def makerFee(self) -> float:
        return self.maker_fee

    @property
    def takerFee(self) -> float:
        return self.taker_fee

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "name": self.name,
            "makerFee": self.maker_fee,
            "takerFee": self.taker_fee,
        }
        if self.symbols is not None:
            d["symbols"] = list(self.symbols)
        if self.fallback is not None:
            d["fallback"] = self.fallback
        d["note"] = self.note
        return d

    def __eq__(self, other: object) -> bool:
        if isinstance(other, dict):
            return self.to_dict() == other
        if isinstance(other, FeeProfile):
            return (
                self.name == other.name
                and self.maker_fee == other.maker_fee
                and self.taker_fee == other.taker_fee
                and self.symbols == other.symbols
                and self.fallback == other.fallback
                and self.note == other.note
            )
        return False

    def __hash__(self) -> int:
        return hash((self.name, self.maker_fee, self.taker_fee, self.symbols, self.fallback, self.note))

    def __getitem__(self, key: str) -> Any:
        if key == "maker_fee":
            return self.maker_fee
        if key == "taker_fee":
            return self.taker_fee
        return self.to_dict()[key]

    def get(self, key: str, default: Any = None) -> Any:
        try:
            return self[key]
        except KeyError:
            return default


FEE_PROFILES: dict[str, FeeProfile] = {
    "standard": FeeProfile(
        name="standard",
        maker_fee=BINANCE_FUTURES_MAKER_FEE,
        taker_fee=BINANCE_FUTURES_TAKER_FEE,
        note="Binance USDT-M VIP 0, fees paid in USDT. Every recorded research number is on this schedule.",
    ),
    "bnb": FeeProfile(
        name="bnb",
        maker_fee=0.00018,
        taker_fee=0.00045,
        note="VIP 0 with the 10% discount for paying fees in BNB.",
    ),
    "promo-btc-eth-2026-07": FeeProfile(
        name="promo-btc-eth-2026-07",
        maker_fee=0.0,
        taker_fee=0.00036,
        symbols=("BTCUSDT", "ETHUSDT"),
        fallback="bnb",
        note=(
            "HYPOTHETICAL ON USDT-M PAIRS. Binance Futures promotion from 2026-07-02 10:00 UTC "
            '"until further notice": 0 maker fee for all users, 20% taker discount (0.036% with BNB) '
            'regular through VIP 3, announced for "BTCU and ETHU". Verified on the account fee page 2026-09-27: '
            "the schedule applies to USDC-MARGINED contracts (USDC maker 0.0000% / taker 0.0400%, "
            "0.0360% with BNB); USDT-M pairs stay at the standard 0.0200% / 0.0500% (0.0180% / 0.0450% with BNB). "
            "This profile prices BTCUSDT and ETHUSDT at a schedule they cannot get and is kept, "
            "with its original symbol scoping, only so the 2026-09-26 audit reports reproduce "
            "(strategy-families.ts, PROMO FEE CHECK). Never a selection profile; for the traded venue the "
            "cheapest real schedule is bnb."
        ),
    ),
}


def resolve_fee_profile(
    profile: str | FeeProfile = DEFAULT_FEE_PROFILE,
    symbol: str | None = None,
) -> FeeProfile:
    """Resolve the fee schedule a symbol actually pays under a given profile."""
    profile_name = profile.name if isinstance(profile, FeeProfile) else profile
    if profile_name not in FEE_PROFILES:
        raise ValueError(f"Unknown fee profile: {profile_name}")

    candidate = FEE_PROFILES[profile_name]
    if candidate.symbols is not None and (symbol is None or symbol not in candidate.symbols):
        if candidate.fallback is None or candidate.fallback not in FEE_PROFILES:
            raise ValueError(f"Fee profile {profile_name} is symbol-scoped and has no fallback")
        return FEE_PROFILES[candidate.fallback]
    return candidate


def study_cost_config(
    interval: str,
    profile: str | FeeProfile = DEFAULT_FEE_PROFILE,
    symbol: str | None = None,
) -> dict[str, float | int]:
    """Return cost parameters dict for backtest at the given interval."""
    if interval not in STUDY_SLIPPAGE_BPS:
        raise ValueError(f"No slippage budget configured for interval: {interval}")
    fees = resolve_fee_profile(profile, symbol)
    slippage_bps = STUDY_SLIPPAGE_BPS[interval]
    return {
        "fee_percent": fees.taker_fee,
        "maker_fee_percent": fees.maker_fee,
        "taker_fee_percent": fees.taker_fee,
        "slippage_bps": slippage_bps,
    }


def default_cost_percent(
    interval: str,
    profile: str | FeeProfile = DEFAULT_FEE_PROFILE,
    symbol: str | None = None,
) -> float:
    """Round-trip cost estimate in PERCENT for taker-in, taker-out trade."""
    if interval not in STUDY_SLIPPAGE_BPS:
        raise ValueError(f"No slippage budget configured for interval: {interval}")
    fees = resolve_fee_profile(profile, symbol)
    slippage_bps = STUDY_SLIPPAGE_BPS[interval]
    return 2.0 * fees.taker_fee * 100.0 + (2.0 * slippage_bps) / 100.0


def apply_slippage(
    price: float,
    direction: str,
    slippage_bps: float | int | None,
) -> float:
    """Move price against the trader by slippage_bps."""
    if not slippage_bps:
        return price
    factor = slippage_bps / 10000.0
    if direction == "buy":
        return price * (1.0 + factor)
    if direction == "sell":
        return price * (1.0 - factor)
    raise ValueError(f"Unknown direction: {direction}")


def funding_crossings(prev_close_time: int, close_time: int) -> int:
    """Count funding timestamps t with prev_close_time < t <= close_time on legacy 8h grid."""
    if close_time <= prev_close_time:
        return 0
    first = (prev_close_time // FUNDING_INTERVAL_MS) + 1
    last = close_time // FUNDING_INTERVAL_MS
    return max(0, last - first + 1)


def funding_pnl(
    notional: float,
    funding_rate: float,
    side: str,
    crossings: int,
) -> float:
    """Signed funding pnl over crossings on a position with given notional."""
    magnitude = notional * funding_rate * crossings
    if side == "long":
        return -magnitude
    if side == "short":
        return magnitude
    raise ValueError(f"Unknown side: {side}")


def _extract_settlement(s: Any) -> tuple[int, float]:
    if isinstance(s, dict):
        return int(s["t"]), float(s["rate"])
    if isinstance(s, (tuple, list)):
        return int(s[0]), float(s[1])
    return int(s.t), float(s.rate)


def funding_sums_for(
    opens_ms: Sequence[int] | np.ndarray,
    interval_ms: int,
    settlements: Sequence[tuple[int, float] | dict[str, Any] | Any],
) -> np.ndarray:
    """Port of fundingSumsFor: sum of funding rates settled in each candle's interval."""
    n = len(opens_ms)
    sums = np.zeros(n, dtype=np.float64)
    if not settlements or n == 0:
        return sums

    parsed = [_extract_settlement(s) for s in settlements]
    sorted_settlements = sorted(parsed, key=lambda s: s[0])
    times = [s[0] for s in sorted_settlements]

    for i, open_time in enumerate(opens_ms):
        o = int(open_time)
        p = bisect_right(times, o)
        k = bisect_right(times, o + interval_ms)
        s = 0.0
        for idx in range(p, k):
            s += sorted_settlements[idx][1]
        sums[i] = s

    return sums


def trade_funding(
    settlement_times_ms: Sequence[int] | np.ndarray,
    rates: Sequence[float] | np.ndarray,
    entry_ms: int,
    exit_ms: int,
) -> float:
    """Sum of funding rates settled in the half-open window (entry_ms, exit_ms].

    Follows the lab convention (fundingTime > entry_ms and <= exit_ms).
    """
    if entry_ms >= exit_ms or len(settlement_times_ms) == 0:
        return 0.0
    times = np.asarray(settlement_times_ms)
    r = np.asarray(rates, dtype=np.float64)
    if len(times) != len(r):
        raise ValueError(f"Length mismatch: {len(times)} timestamps vs {len(r)} rates")
    mask = (times > entry_ms) & (times <= exit_ms)
    return float(np.sum(r[mask]))


def trade_net_return(
    side: int | str,
    entry_price: float,
    exit_price: float,
    funding_sum: float,
    interval: str,
    entry_fill: str = "taker",
    exit_fill: str = "taker",
    profile: str | FeeProfile = DEFAULT_FEE_PROFILE,
    symbol: str | None = None,
) -> float:
    """Net trade return accounting for price change, funding, fees, and slippage.

    This function implements the Round 4 convention, which is additive in return
    space:
        side * (exit_price / entry_price - 1) - side * funding_sum - fee_in - fee_out - slip_in - slip_out

    The TypeScript engine instead slips prices multiplicatively through apply_slippage.
    The two agree to first order, and the port keeps both.

    side must be +1 (or "long") or -1 (or "short").
    entry_fill and exit_fill must each be "maker" or "taker".
    """
    if side in (1, +1, "long"):
        side_val = 1
    elif side in (-1, "short"):
        side_val = -1
    else:
        raise ValueError(f"side must be +1, -1, 'long', or 'short', got: {side}")

    if entry_fill not in ("maker", "taker"):
        raise ValueError(f"Unknown entry_fill kind: {entry_fill}")
    if exit_fill not in ("maker", "taker"):
        raise ValueError(f"Unknown exit_fill kind: {exit_fill}")

    if interval not in STUDY_SLIPPAGE_BPS:
        raise ValueError(f"No slippage budget configured for interval: {interval}")

    fees = resolve_fee_profile(profile, symbol)
    fee_in = fees.maker_fee if entry_fill == "maker" else fees.taker_fee
    fee_out = fees.maker_fee if exit_fill == "maker" else fees.taker_fee

    slip_rate = STUDY_SLIPPAGE_BPS[interval] / 10000.0
    slip_in = slip_rate if entry_fill == "taker" else 0.0
    slip_out = slip_rate if exit_fill == "taker" else 0.0

    gross_return = side_val * (exit_price / entry_price - 1.0)
    funding_term = side_val * funding_sum

    return gross_return - funding_term - fee_in - fee_out - slip_in - slip_out
