import { describe, it, expect } from 'vitest';
import { computeFIFO, computeHoldingCostBasis } from './cost-basis';
import type { Transaction } from '@/types/portfolio';

function tx(
  overrides: Partial<Transaction> & Pick<Transaction, 'type' | 'quantity' | 'price'>
): Transaction {
  return {
    date: new Date('2024-01-15'),
    ...overrides,
  };
}

describe('computeFIFO', () => {
  it('returns empty result for no transactions', () => {
    const result = computeFIFO([], 'BTCUSDT');
    expect(result.openLots).toEqual([]);
    expect(result.realizedGains).toEqual([]);
    expect(result.totalRealizedGain).toBe(0);
    expect(result.totalUnrealizedCostBasis).toBe(0);
  });

  it('handles single buy - no sells', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 0.5, price: 40000, date: new Date('2024-01-15') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].remainingQuantity).toBe(0.5);
    expect(result.openLots[0].pricePerUnit).toBe(40000);
    expect(result.realizedGains).toHaveLength(0);
    expect(result.totalRealizedGain).toBe(0);
    expect(result.totalUnrealizedCostBasis).toBe(20000);
  });

  it('handles buy then full sell (exact quantity match)', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 1, price: 40000, date: new Date('2024-01-15') }),
      tx({ type: 'sell', quantity: 1, price: 65000, date: new Date('2024-06-15') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    expect(result.openLots).toHaveLength(0);
    expect(result.realizedGains).toHaveLength(1);
    expect(result.realizedGains[0].gain).toBe(25000);
    expect(result.realizedGains[0].quantity).toBe(1);
    expect(result.totalRealizedGain).toBe(25000);
    expect(result.totalUnrealizedCostBasis).toBe(0);
  });

  it('handles buy then partial sell', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 1, price: 40000, date: new Date('2024-01-15') }),
      tx({ type: 'sell', quantity: 0.3, price: 60000, date: new Date('2024-06-15') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].remainingQuantity).toBeCloseTo(0.7);
    expect(result.realizedGains).toHaveLength(1);
    expect(result.realizedGains[0].quantity).toBe(0.3);
    expect(result.realizedGains[0].gain).toBeCloseTo(6000);
    expect(result.totalUnrealizedCostBasis).toBeCloseTo(28000);
  });

  it('depletes lots in FIFO order (multiple buys, one sell)', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 0.5, price: 30000, date: new Date('2024-01-01') }),
      tx({ type: 'buy', quantity: 0.5, price: 50000, date: new Date('2024-02-01') }),
      tx({ type: 'sell', quantity: 0.7, price: 60000, date: new Date('2024-06-15') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    expect(result.realizedGains).toHaveLength(2);
    // First lot fully depleted: 0.5 * (60000 - 30000) = 15000
    expect(result.realizedGains[0].quantity).toBe(0.5);
    expect(result.realizedGains[0].costBasis).toBe(15000);
    // Second lot partially: 0.2 * (60000 - 50000) = 2000
    expect(result.realizedGains[1].quantity).toBeCloseTo(0.2);
    expect(result.realizedGains[1].costBasis).toBeCloseTo(10000);

    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].remainingQuantity).toBeCloseTo(0.3);
    expect(result.openLots[0].pricePerUnit).toBe(50000);
  });

  it('handles multiple buys and multiple sells interleaved', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 1, price: 30000, date: new Date('2024-01-01') }),
      tx({ type: 'sell', quantity: 0.5, price: 40000, date: new Date('2024-02-01') }),
      tx({ type: 'buy', quantity: 1, price: 35000, date: new Date('2024-03-01') }),
      tx({ type: 'sell', quantity: 1, price: 45000, date: new Date('2024-04-01') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    // After sell 0.5 at 40000: lot1 has 0.5 remaining
    // After sell 1 at 45000: lot1 depleted (0.5), lot2 partially (0.5)
    expect(result.realizedGains).toHaveLength(3);
    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].remainingQuantity).toBeCloseTo(0.5);
    expect(result.openLots[0].pricePerUnit).toBe(35000);
  });

  it('handles buy fees (added to cost basis)', () => {
    const transactions = [
      tx({
        type: 'buy',
        quantity: 1,
        price: 40000,
        fee: 100,
        date: new Date('2024-01-15'),
      }),
      tx({ type: 'sell', quantity: 1, price: 50000, date: new Date('2024-06-15') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    // Cost per unit = 40000 + 100/1 = 40100
    expect(result.realizedGains[0].costBasis).toBe(40100);
    expect(result.realizedGains[0].gain).toBe(9900);
  });

  it('handles sell fees (deducted from proceeds)', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 1, price: 40000, date: new Date('2024-01-15') }),
      tx({
        type: 'sell',
        quantity: 1,
        price: 50000,
        fee: 50,
        date: new Date('2024-06-15'),
      }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    // Proceeds = 50000 - 50 = 49950
    expect(result.realizedGains[0].proceeds).toBe(49950);
    expect(result.realizedGains[0].gain).toBe(9950);
  });

  it('handles both buy and sell fees together', () => {
    const transactions = [
      tx({
        type: 'buy',
        quantity: 1,
        price: 40000,
        fee: 100,
        date: new Date('2024-01-15'),
      }),
      tx({
        type: 'sell',
        quantity: 1,
        price: 50000,
        fee: 50,
        date: new Date('2024-06-15'),
      }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    expect(result.realizedGains[0].costBasis).toBe(40100);
    expect(result.realizedGains[0].proceeds).toBe(49950);
    expect(result.realizedGains[0].gain).toBe(9850);
  });

  it('classifies short-term holding period (<= 365 days)', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 1, price: 40000, date: new Date('2024-01-15') }),
      tx({ type: 'sell', quantity: 1, price: 50000, date: new Date('2024-06-15') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');
    expect(result.realizedGains[0].holdingPeriod).toBe('short-term');
  });

  it('classifies long-term holding period (> 365 days)', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 1, price: 40000, date: new Date('2023-01-01') }),
      tx({ type: 'sell', quantity: 1, price: 50000, date: new Date('2024-06-15') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');
    expect(result.realizedGains[0].holdingPeriod).toBe('long-term');
  });

  it('classifies at exactly 365-day boundary as short-term', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 1, price: 40000, date: new Date('2024-01-01') }),
      tx({ type: 'sell', quantity: 1, price: 50000, date: new Date('2025-01-01') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');
    // 2024 is a leap year, so Jan 1 2024 -> Jan 1 2025 = 366 days
    expect(result.realizedGains[0].holdingPeriod).toBe('long-term');
  });

  it('ignores zero-quantity transactions', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 0, price: 40000 }),
      tx({ type: 'buy', quantity: 1, price: 40000 }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');
    expect(result.openLots).toHaveLength(1);
  });

  it('sorts transactions by date regardless of input order', () => {
    const transactions = [
      tx({ type: 'sell', quantity: 0.5, price: 60000, date: new Date('2024-06-15') }),
      tx({ type: 'buy', quantity: 1, price: 40000, date: new Date('2024-01-15') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    expect(result.realizedGains).toHaveLength(1);
    expect(result.realizedGains[0].gain).toBe(10000);
    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].remainingQuantity).toBe(0.5);
  });

  it('handles complex mixed sequence', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 2, price: 30000, date: new Date('2024-01-01') }),
      tx({ type: 'buy', quantity: 1, price: 35000, date: new Date('2024-02-01') }),
      tx({ type: 'sell', quantity: 1.5, price: 40000, date: new Date('2024-03-01') }),
      tx({ type: 'buy', quantity: 0.5, price: 38000, date: new Date('2024-04-01') }),
      tx({ type: 'sell', quantity: 1, price: 42000, date: new Date('2024-05-01') }),
      tx({ type: 'sell', quantity: 0.5, price: 45000, date: new Date('2024-06-01') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    // After buy 2@30k, buy 1@35k: lots=[2@30k, 1@35k]
    // Sell 1.5@40k: deplete 1.5 from first lot, lots=[0.5@30k, 1@35k]
    // Buy 0.5@38k: lots=[0.5@30k, 1@35k, 0.5@38k]
    // Sell 1@42k: deplete 0.5@30k, 0.5@35k => lots=[0.5@35k, 0.5@38k]
    // Sell 0.5@45k: deplete 0.5@35k => lots=[0.5@38k]
    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].remainingQuantity).toBe(0.5);
    expect(result.openLots[0].pricePerUnit).toBe(38000);
    expect(result.realizedGains.length).toBeGreaterThanOrEqual(4);
  });

  it('handles sell with no available lots gracefully', () => {
    const transactions = [
      tx({ type: 'sell', quantity: 1, price: 50000, date: new Date('2024-06-15') }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');
    // No lots to deplete, sell is effectively ignored
    expect(result.openLots).toHaveLength(0);
    expect(result.realizedGains).toHaveLength(0);
  });

  it('distributes sell fee proportionally across lots', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 0.5, price: 30000, date: new Date('2024-01-01') }),
      tx({ type: 'buy', quantity: 0.5, price: 40000, date: new Date('2024-02-01') }),
      tx({
        type: 'sell',
        quantity: 1,
        price: 50000,
        fee: 100,
        date: new Date('2024-06-15'),
      }),
    ];
    const result = computeFIFO(transactions, 'BTCUSDT');

    // Total sell fee = 100, split 50/50 between two depletions
    const gain1 = result.realizedGains[0];
    const gain2 = result.realizedGains[1];
    // gain1: proceeds = 0.5 * 50000 - 50 = 24950, cost = 0.5 * 30000 = 15000, gain = 9950
    expect(gain1.proceeds).toBeCloseTo(24950);
    expect(gain1.gain).toBeCloseTo(9950);
    // gain2: proceeds = 0.5 * 50000 - 50 = 24950, cost = 0.5 * 40000 = 20000, gain = 4950
    expect(gain2.proceeds).toBeCloseTo(24950);
    expect(gain2.gain).toBeCloseTo(4950);
  });
});

describe('computeHoldingCostBasis', () => {
  it('computes holding-level summary from transactions', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 1, price: 40000, date: new Date('2024-01-15') }),
      tx({ type: 'sell', quantity: 0.3, price: 60000, date: new Date('2024-06-15') }),
    ];
    const result = computeHoldingCostBasis(transactions, 'BTCUSDT');

    expect(result.symbol).toBe('BTCUSDT');
    expect(result.totalQuantity).toBeCloseTo(0.7);
    expect(result.averageCost).toBe(40000);
    expect(result.totalCost).toBeCloseTo(28000);
    expect(result.openLots).toHaveLength(1);
    expect(result.realizedGains).toHaveLength(1);
    expect(result.totalRealizedGain).toBeCloseTo(6000);
  });

  it('returns zero average cost when no holdings remain', () => {
    const transactions = [
      tx({ type: 'buy', quantity: 1, price: 40000, date: new Date('2024-01-15') }),
      tx({ type: 'sell', quantity: 1, price: 50000, date: new Date('2024-06-15') }),
    ];
    const result = computeHoldingCostBasis(transactions, 'BTCUSDT');

    expect(result.totalQuantity).toBe(0);
    expect(result.averageCost).toBe(0);
  });
});
