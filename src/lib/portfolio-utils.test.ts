import { describe, expect, it } from 'vitest';
import { calculateHoldingState } from './portfolio-utils';
import type { ITransaction } from '@/lib/models/portfolio';

function tx(overrides: Partial<ITransaction> & Pick<ITransaction, 'type' | 'quantity' | 'price'>): ITransaction {
  return {
    date: new Date(),
    fee: 0,
    ...overrides,
  };
}

describe('calculateHoldingState', () => {
  it('returns zero state for empty transactions', () => {
    const result = calculateHoldingState([]);
    expect(result.quantity).toBe(0);
    expect(result.avgBuyPrice).toBe(0);
  });

  it('calculates state for single buy', () => {
    const result = calculateHoldingState([
      tx({ type: 'buy', quantity: 0.5, price: 40000 }),
    ]);
    expect(result.quantity).toBe(0.5);
    expect(result.avgBuyPrice).toBe(40000);
  });

  it('calculates weighted average for multiple buys', () => {
    const result = calculateHoldingState([
      tx({ type: 'buy', quantity: 1, price: 40000 }),
      tx({ type: 'buy', quantity: 1, price: 50000 }),
    ]);
    expect(result.quantity).toBe(2);
    expect(result.avgBuyPrice).toBe(45000);
  });

  it('handles buy then sell (avg price unchanged)', () => {
    const result = calculateHoldingState([
      tx({ type: 'buy', quantity: 2, price: 30000 }),
      tx({ type: 'sell', quantity: 1, price: 35000 }),
    ]);
    expect(result.quantity).toBe(1);
    expect(result.avgBuyPrice).toBe(30000);
  });

  it('handles sell all (quantity and price zero)', () => {
    const result = calculateHoldingState([
      tx({ type: 'buy', quantity: 1, price: 40000 }),
      tx({ type: 'sell', quantity: 1, price: 45000 }),
    ]);
    expect(result.quantity).toBe(0);
    expect(result.avgBuyPrice).toBe(0);
  });

  it('includes fee in cost basis', () => {
    const result = calculateHoldingState([
      tx({ type: 'buy', quantity: 1, price: 40000, fee: 100 }),
    ]);
    expect(result.quantity).toBe(1);
    expect(result.avgBuyPrice).toBe(40100);
  });
});
