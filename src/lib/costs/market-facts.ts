import type { PerpDepth, PerpExchangeSymbol, PerpKline } from '@/lib/binance-futures';

/** Crypto USDT-M perpetuals that are trading, sorted by symbol. */
export interface CostCheckSymbol {
  symbol: string;
  baseAsset: string;
  /** Listing time, epoch ms (0 when the venue does not say). */
  onboardDate: number;
}

/**
 * Only crypto-underlying USDT-margined perpetuals are checkable: quarterly
 * contracts, USDC-margined contracts (different fees) and TradFi-style
 * perpetuals (`underlyingType` other than COIN) are excluded.
 */
export function costCheckSymbols(exchangeSymbols: readonly PerpExchangeSymbol[]): CostCheckSymbol[] {
  return exchangeSymbols
    .filter(
      (s) =>
        s.contractType === 'PERPETUAL' &&
        s.status === 'TRADING' &&
        s.quoteAsset === 'USDT' &&
        s.underlyingType === 'COIN'
    )
    .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, onboardDate: s.onboardDate ?? 0 }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

export interface DepthSlippage {
  /** Mean of the buy-side and sell-side impact, basis points, one way. */
  bps: number;
  /** Half the top-of-book spread relative to the mid, basis points. */
  halfSpreadBps: number;
  /** True when either side's visible levels cannot fill the notional. */
  exceedsTopOfBook: boolean;
}

interface SideImpact {
  bps: number;
  exceeds: boolean;
}

/**
 * Impact of walking one side of the book for `notional` USDT, as the distance
 * of the average fill price from the mid. When the visible levels cannot fill
 * the notional, the unfilled remainder is assumed to fill at the worst visible
 * price; it can only fill there or worse, so the impact is then a lower bound
 * on the true one, and `exceeds` says so.
 */
function sideImpact(levels: readonly [number, number][], mid: number, notional: number): SideImpact {
  let remaining = notional;
  let quantity = 0;
  for (const [price, qty] of levels) {
    const take = Math.min(remaining, price * qty);
    quantity += take / price;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  const exceeds = remaining > 1e-9;
  if (exceeds) quantity += remaining / levels[levels.length - 1][0];
  const average = notional / quantity;
  return { bps: (Math.abs(average - mid) / mid) * 10_000, exceeds };
}

/**
 * Slippage a market order of `notional` USDT would suffer, measured against
 * the mid: asks are walked for a buy, bids for a sell, and the two impacts are
 * averaged. Throws when a side of the book is empty or the inputs are invalid,
 * so a caller can fall back to a flat assumption.
 */
export function depthSlippageBps(depth: PerpDepth, notional: number): DepthSlippage {
  if (!(notional > 0)) throw new Error('notional must be positive');
  if (depth.bids.length === 0 || depth.asks.length === 0) throw new Error('Order book side is empty');
  const bestBid = depth.bids[0][0];
  const bestAsk = depth.asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  if (!(mid > 0)) throw new Error('Order book has no valid mid');
  const buy = sideImpact(depth.asks, mid, notional);
  const sell = sideImpact(depth.bids, mid, notional);
  return {
    bps: (buy.bps + sell.bps) / 2,
    halfSpreadBps: ((bestAsk - bestBid) / 2 / mid) * 10_000,
    exceedsTopOfBook: buy.exceeds || sell.exceeds,
  };
}

export interface VenueLimits {
  minNotional: number;
  minQty: number;
}

/** The smallest order the venue accepts in USDT: the larger of MIN_NOTIONAL and minQty at the mark. */
export function effectiveMinNotional(filters: VenueLimits, markPrice: number): number {
  return Math.max(filters.minNotional, filters.minQty * markPrice);
}

/** Whether `notional` USDT at `markPrice` is an exact multiple of the lot step. */
export function isWholeLot(notional: number, markPrice: number, stepSize: number): boolean {
  if (!(markPrice > 0) || !(stepSize > 0)) return false;
  const steps = notional / markPrice / stepSize;
  return Math.abs(steps - Math.round(steps)) < 1e-9 * Math.max(1, Math.abs(steps));
}

/** Drops the in-progress bar: Binance returns it last, with a closeTime in the future. */
export function closedBars(klines: readonly PerpKline[], now: number): PerpKline[] {
  return klines.filter((k) => k.closeTime < now);
}
