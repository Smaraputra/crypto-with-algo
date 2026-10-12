import { describe, it, expect } from 'vitest';
import type { ICrossSectionalSignal } from '@/lib/models/cross-sectional-signal';
import {
  stepCrossSectionalBookState,
  MAKER_FEE_RATE,
  TAKER_FEE_RATE,
  type CrossSectionalBookState,
} from './cross-sectional-runner';

function createMockSignal(overrides: Partial<ICrossSectionalSignal> = {}): ICrossSectionalSignal {
  const timestamp = 1700000000000;
  return {
    timestamp,
    barCloseTime: timestamp + 8 * 3600 * 1000,
    cadence: '8h',
    universe: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
    snapshots: [
      {
        symbol: 'BTCUSDT',
        close: 50000,
        return14d: 0.05,
        fundingRate: 0.0001, // 1 bp positive funding
        btcReturn14d: 0.05,
        betaToBtc: 1.0,
        takerBuyRatio: 0.52,
      },
      {
        symbol: 'ETHUSDT',
        close: 3000,
        return14d: 0.08,
        fundingRate: -0.0002, // Negative funding
        btcReturn14d: 0.05,
        betaToBtc: 1.1,
        takerBuyRatio: 0.55,
      },
      {
        symbol: 'SOLUSDT',
        close: 100,
        return14d: -0.04,
        fundingRate: 0.0001,
        btcReturn14d: 0.05,
        betaToBtc: 1.2,
        takerBuyRatio: 0.45,
      },
      {
        symbol: 'BNBUSDT',
        close: 300,
        return14d: -0.06,
        fundingRate: 0.0003,
        btcReturn14d: 0.05,
        betaToBtc: 0.9,
        takerBuyRatio: 0.42,
      },
    ],
    ranks: [
      { symbol: 'ETHUSDT', zMom: 1.5, zIdio: 1.2, zCarry: 1.0, zFlow: 1.1, compositeZ: 1.3, rank: 1 },
      { symbol: 'BTCUSDT', zMom: 0.8, zIdio: 0.5, zCarry: 0.4, zFlow: 0.6, compositeZ: 0.6, rank: 2 },
      { symbol: 'SOLUSDT', zMom: -0.6, zIdio: -0.5, zCarry: -0.4, zFlow: -0.5, compositeZ: -0.5, rank: 3 },
      { symbol: 'BNBUSDT', zMom: -1.2, zIdio: -1.0, zCarry: -1.2, zFlow: -1.0, compositeZ: -1.1, rank: 4 },
    ],
    targets: [
      { symbol: 'ETHUSDT', weight: 0.25, side: 'long' },
      { symbol: 'BTCUSDT', weight: 0.25, side: 'long' },
      { symbol: 'SOLUSDT', weight: -0.25, side: 'short' },
      { symbol: 'BNBUSDT', weight: -0.25, side: 'short' },
    ],
    turnover: 1.0,
    rebalanced: true,
    netBetaExposure: 0.0,
    grossExposure: 1.0,
    ...overrides,
  } as ICrossSectionalSignal;
}

describe('stepCrossSectionalBookState', () => {
  it('opens initial portfolio legs and debits entry maker and taker fees', () => {
    const initialState: CrossSectionalBookState = {
      bookName: 'rv-8h-buffer2',
      startEquity: 10000,
      equityMaker: 10000,
      equityTaker: 10000,
      lastProcessedBarTime: null,
      positions: [],
      totalTurnover: 0,
      totalFundingCollected: 0,
      peakLeverage: 0,
    };

    const signal = createMockSignal();
    const { updatedBook, closedTrades } = stepCrossSectionalBookState(initialState, signal);

    expect(closedTrades.length).toBe(0);
    expect(updatedBook.positions.length).toBe(4);
    expect(updatedBook.totalTurnover).toBe(1.0);
    expect(updatedBook.peakLeverage).toBe(1.0);
    expect(updatedBook.lastProcessedBarTime).toBe(signal.timestamp);

    // Initial equity was 10,000, gross exposure 1.0 = 10,000 traded
    // Maker fee: 10000 * 0.00018 = 1.80 USDT -> 9998.20
    expect(updatedBook.equityMaker).toBeCloseTo(10000 - 10000 * MAKER_FEE_RATE, 2);
    // Taker fee: 10000 * 0.0007 = 7.00 USDT -> 9993.00
    expect(updatedBook.equityTaker).toBeCloseTo(10000 - 10000 * TAKER_FEE_RATE, 2);

    const ethPos = updatedBook.positions.find((p) => p.symbol === 'ETHUSDT');
    expect(ethPos).toBeDefined();
    expect(ethPos?.side).toBe('long');
    expect(ethPos?.entryPrice).toBe(3000);
    expect(ethPos?.barsHeld).toBe(0);

    const bnbPos = updatedBook.positions.find((p) => p.symbol === 'BNBUSDT');
    expect(bnbPos).toBeDefined();
    expect(bnbPos?.side).toBe('short');
    expect(bnbPos?.entryPrice).toBe(300);
  });

  it('accrues funding cash flows and increments barsHeld on existing positions', () => {
    const signal1 = createMockSignal();
    const initialState: CrossSectionalBookState = {
      bookName: 'rv-8h-buffer2',
      startEquity: 10000,
      equityMaker: 10000,
      equityTaker: 10000,
      lastProcessedBarTime: null,
      positions: [],
      totalTurnover: 0,
      totalFundingCollected: 0,
      peakLeverage: 0,
    };

    const { updatedBook: bookAfter1 } = stepCrossSectionalBookState(initialState, signal1);

    // Signal 2: identical targets, positive funding on BTC (+0.0001) and negative funding on ETH (-0.0002)
    const signal2 = createMockSignal({
      timestamp: signal1.timestamp + 8 * 3600 * 1000,
      turnover: 0,
      rebalanced: false,
    });

    const { updatedBook: bookAfter2, closedTrades } = stepCrossSectionalBookState(bookAfter1, signal2);

    expect(closedTrades.length).toBe(0);
    expect(bookAfter2.positions.length).toBe(4);
    // All positions should have advanced barsHeld from 0 to 1
    for (const p of bookAfter2.positions) {
      expect(p.barsHeld).toBe(1);
    }
  });

  it('closes positions when target weight drops to flat and logs ClosedTradeRecord', () => {
    const signal1 = createMockSignal();
    const initialState: CrossSectionalBookState = {
      bookName: 'rv-8h-buffer2',
      startEquity: 10000,
      equityMaker: 10000,
      equityTaker: 10000,
      lastProcessedBarTime: null,
      positions: [],
      totalTurnover: 0,
      totalFundingCollected: 0,
      peakLeverage: 0,
    };

    const { updatedBook: bookAfter1 } = stepCrossSectionalBookState(initialState, signal1);

    // Signal 2: ETH is no longer long (target weight = 0), replaced by another asset
    // Price of ETH increased from 3000 to 3300 (+10% profit)
    const signal2 = createMockSignal({
      timestamp: signal1.timestamp + 8 * 3600 * 1000,
      snapshots: signal1.snapshots.map((s) =>
        s.symbol === 'ETHUSDT' ? { ...s, close: 3300 } : s
      ),
      targets: [
        { symbol: 'ETHUSDT', weight: 0, side: 'flat' },
        { symbol: 'BTCUSDT', weight: 0.5, side: 'long' },
        { symbol: 'SOLUSDT', weight: -0.25, side: 'short' },
        { symbol: 'BNBUSDT', weight: -0.25, side: 'short' },
      ],
      turnover: 0.5,
    });

    const { updatedBook: bookAfter2, closedTrades } = stepCrossSectionalBookState(bookAfter1, signal2);

    expect(closedTrades.length).toBe(1);
    const ethTrade = closedTrades[0];
    expect(ethTrade.symbol).toBe('ETHUSDT');
    expect(ethTrade.side).toBe('long');
    expect(ethTrade.entryPrice).toBe(3000);
    expect(ethTrade.exitPrice).toBe(3300);
    expect(ethTrade.pnlPercentGross).toBeCloseTo(10.0, 2);
    expect(ethTrade.pnlNetMaker).toBeGreaterThan(0);
    expect(ethTrade.exitReason).toBe('rank_buffer_exit');
    expect(ethTrade.barsHeld).toBe(1);

    // ETH should no longer be in active positions
    expect(bookAfter2.positions.find((p) => p.symbol === 'ETHUSDT')).toBeUndefined();
  });
});
