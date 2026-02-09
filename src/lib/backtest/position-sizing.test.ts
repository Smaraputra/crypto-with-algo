import { describe, it, expect } from 'vitest';
import { fixedFractional, kellyCriterion, riskBased } from './position-sizing';

describe('fixedFractional', () => {
  it('calculates correct quantity', () => {
    // equity=10000, risk 2%, entry=100, stop=95 -> risk per unit=5
    // dollar risk = 200, quantity = 200/5 = 40
    const qty = fixedFractional(10000, 0.02, 100, 95);
    expect(qty).toBe(40);
  });

  it('handles short position (stop above entry)', () => {
    // entry=100, stop=105 -> risk per unit=5
    const qty = fixedFractional(10000, 0.02, 100, 105);
    expect(qty).toBe(40);
  });

  it('returns 0 when entry price is 0', () => {
    expect(fixedFractional(10000, 0.02, 0, 95)).toBe(0);
  });

  it('returns 0 when stop loss equals entry', () => {
    expect(fixedFractional(10000, 0.02, 100, 100)).toBe(0);
  });
});

describe('kellyCriterion', () => {
  it('calculates position with positive edge', () => {
    // 60% win rate, avg win=200, avg loss=-100
    // b = 200/100 = 2, kelly = (0.6*2 - 0.4)/2 = 0.4
    // half kelly = 0.2, dollar = 2000, qty = 2000/100 = 20
    const qty = kellyCriterion(10000, 0.6, 200, -100, 100, 0.5);
    expect(qty).toBeCloseTo(20);
  });

  it('returns 0 when no edge (negative kelly)', () => {
    // 30% win rate, avg win=100, avg loss=-200
    // b = 0.5, kelly = (0.3*0.5 - 0.7)/0.5 = -1.1 -> clamped to 0
    const qty = kellyCriterion(10000, 0.3, 100, -200, 100);
    expect(qty).toBe(0);
  });

  it('returns 0 when entry price is 0', () => {
    expect(kellyCriterion(10000, 0.6, 200, -100, 0)).toBe(0);
  });

  it('returns 0 when avg loss is 0', () => {
    expect(kellyCriterion(10000, 0.6, 200, 0, 100)).toBe(0);
  });

  it('clamps fraction to 1.0 max', () => {
    // 90% win, avg win=1000, avg loss=-10 => huge kelly but clamped
    const qty = kellyCriterion(10000, 0.9, 1000, -10, 100, 1.0);
    expect(qty).toBeGreaterThan(0);
    expect(qty).toBeLessThanOrEqual(100); // max = equity/entryPrice = 100
  });
});

describe('riskBased', () => {
  it('is equivalent to fixedFractional', () => {
    const ff = fixedFractional(10000, 0.02, 100, 95);
    const rb = riskBased(10000, 0.02, 100, 95);
    expect(rb).toBe(ff);
  });
});
