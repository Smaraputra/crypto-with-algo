import { describe, expect, it } from 'vitest';

import type { PerpDepth, PerpExchangeSymbol, PerpKline } from '@/lib/binance-futures';
import {
  closedBars,
  costCheckSymbols,
  depthSlippageBps,
  effectiveMinNotional,
  isWholeLot,
} from './market-facts';

function sym(over: Partial<PerpExchangeSymbol>): PerpExchangeSymbol {
  return {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    status: 'TRADING',
    contractType: 'PERPETUAL',
    underlyingType: 'COIN',
    onboardDate: 1_569_398_400_000,
    filters: [],
    ...over,
  };
}

describe('costCheckSymbols', () => {
  it('keeps only trading crypto USDT perpetuals, sorted', () => {
    const out = costCheckSymbols([
      sym({ symbol: 'ETHUSDT', baseAsset: 'ETH' }),
      sym({ symbol: 'BTCUSDT' }),
      sym({ symbol: 'BTCUSDT_261225', contractType: 'CURRENT_QUARTER' }),
      sym({ symbol: 'BTCUSDC', quoteAsset: 'USDC' }),
      sym({ symbol: 'XAUUSDT', underlyingType: 'COMMODITY' }),
      sym({ symbol: 'OLDUSDT', status: 'SETTLING' }),
    ]);
    expect(out).toEqual([
      { symbol: 'BTCUSDT', baseAsset: 'BTC', onboardDate: 1_569_398_400_000 },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', onboardDate: 1_569_398_400_000 },
    ]);
  });
});

describe('depthSlippageBps', () => {
  // mid 100, half spread 0.1 -> 10 bps
  const depth: PerpDepth = {
    bids: [
      [99.9, 10],
      [99.5, 10],
    ],
    asks: [
      [100.1, 10],
      [100.5, 10],
    ],
  };

  it('is the half spread when the top level fills the order', () => {
    const r = depthSlippageBps(depth, 500);
    expect(r.halfSpreadBps).toBeCloseTo(10, 6);
    expect(r.bps).toBeCloseTo(10, 6);
    expect(r.exceedsTopOfBook).toBe(false);
  });

  it('walks into the second level and averages the two sides', () => {
    // 1501 USDT: asks fill 1001 at 100.1 (10 units) then 500 at 100.5; bids fill 999 at 99.9 then 502 at 99.5.
    const buyAvg = 1501 / (10 + 500 / 100.5);
    const sellAvg = 1501 / (10 + 502 / 99.5);
    const r = depthSlippageBps(depth, 1501);
    const expected = ((Math.abs(buyAvg - 100) + Math.abs(sellAvg - 100)) / 100 / 2) * 10_000;
    expect(r.bps).toBeCloseTo(expected, 6);
    expect(r.exceedsTopOfBook).toBe(false);
  });

  it('flags a book that cannot fill and fills the remainder at the worst visible price', () => {
    // 2100 USDT: asks hold 2006 USDT, so 94 more fill at 100.5; bids hold 1994, so 106 more at 99.5.
    const buyAvg = 2100 / (10 + 10 + 94 / 100.5);
    const sellAvg = 2100 / (10 + 10 + 106 / 99.5);
    const r = depthSlippageBps(depth, 2100);
    expect(r.exceedsTopOfBook).toBe(true);
    const expected = ((Math.abs(buyAvg - 100) + Math.abs(sellAvg - 100)) / 100 / 2) * 10_000;
    expect(r.bps).toBeCloseTo(expected, 6);
    // a lower bound: well under the worst level's 50 bps when most of the order fills near the top
    expect(r.bps).toBeLessThan(35);
  });

  it('approaches the worst level distance as the remainder dominates', () => {
    const r = depthSlippageBps(depth, 1_000_000);
    expect(r.exceedsTopOfBook).toBe(true);
    expect(r.bps).toBeLessThan(50);
    expect(r.bps).toBeGreaterThan(49.9);
  });

  it('flags when only one side is too thin', () => {
    const thin: PerpDepth = { bids: [[99.9, 1000]], asks: [[100.1, 1]] };
    expect(depthSlippageBps(thin, 500).exceedsTopOfBook).toBe(true);
  });

  it('throws on an empty side or a bad notional', () => {
    expect(() => depthSlippageBps({ bids: [], asks: depth.asks }, 100)).toThrow();
    expect(() => depthSlippageBps(depth, 0)).toThrow();
  });
});

describe('effectiveMinNotional and isWholeLot', () => {
  it('takes the larger of minNotional and minQty at the mark', () => {
    expect(effectiveMinNotional({ minNotional: 5, minQty: 0.001 }, 60_000)).toBe(60);
    expect(effectiveMinNotional({ minNotional: 100, minQty: 0.001 }, 60_000)).toBe(100);
  });

  it('checks lot alignment', () => {
    expect(isWholeLot(100, 50, 0.5)).toBe(true);
    expect(isWholeLot(100.1, 50, 0.5)).toBe(false);
    expect(isWholeLot(100, 0, 0.5)).toBe(false);
  });
});

describe('closedBars', () => {
  const bar = (closeTime: number): PerpKline => ({
    openTime: closeTime - 999,
    closeTime,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    quoteVolume: 1,
  });
  it('drops a bar that has not closed yet', () => {
    expect(closedBars([bar(999), bar(1999), bar(2999)], 2000).map((b) => b.closeTime)).toEqual([999, 1999]);
  });
  it('drops a bar closing exactly now', () => {
    expect(closedBars([bar(1999)], 1999)).toEqual([]);
  });
});
