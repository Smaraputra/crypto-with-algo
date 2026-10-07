import { describe, expect, it } from 'vitest';
import { DAYS_PER_MONTH, bracketBreakeven, monthlyCostBurn, symmetricBreakeven } from './breakeven';

function winRate(b: ReturnType<typeof bracketBreakeven>): number {
  if (b.kind !== 'possible') throw new Error('expected a possible breakeven');
  return b.winRate;
}

describe('bracketBreakeven', () => {
  it('needs one winner in three on a costless 1:2 bracket', () => {
    expect(winRate(bracketBreakeven({ stopPercent: 1, targetPercent: 2, lossCostPercent: 0, winCostPercent: 0 }))).toBeCloseTo(1 / 3, 12);
  });

  it('raises the bar when costs are added to both outcomes', () => {
    const p = winRate(bracketBreakeven({ stopPercent: 1, targetPercent: 2, lossCostPercent: 0.16, winCostPercent: 0.1 }));
    expect(p).toBeCloseTo(1.16 / (1.16 + 1.9), 12);
    expect(p).toBeGreaterThan(1 / 3);
  });

  it('is impossible when a win does not cover its own cost', () => {
    expect(bracketBreakeven({ stopPercent: 1, targetPercent: 0.1, lossCostPercent: 0.16, winCostPercent: 0.1 })).toEqual({ kind: 'impossible' });
  });

  it('refuses non-positive distances', () => {
    expect(() => bracketBreakeven({ stopPercent: 0, targetPercent: 1, lossCostPercent: 0, winCostPercent: 0 })).toThrow();
  });
});

describe('symmetricBreakeven', () => {
  it('reduces to 0.5 + C / 2M', () => {
    expect(winRate(symmetricBreakeven(0.16, 0.45))).toBeCloseTo(0.5 + 0.16 / 0.9, 12);
  });

  it('equals the bracket formula with equal stop and target', () => {
    const bracket = bracketBreakeven({ stopPercent: 0.8, targetPercent: 0.8, lossCostPercent: 0.12, winCostPercent: 0.12 });
    expect(winRate(symmetricBreakeven(0.12, 0.8))).toBeCloseTo(winRate(bracket), 12);
  });

  it('is exactly a coin flip with no cost, and impossible once cost reaches the move', () => {
    expect(winRate(symmetricBreakeven(0, 0.5))).toBe(0.5);
    expect(symmetricBreakeven(0.5, 0.5)).toEqual({ kind: 'impossible' });
    expect(symmetricBreakeven(0.6, 0.5)).toEqual({ kind: 'impossible' });
  });
});

describe('monthlyCostBurn', () => {
  it('adds a steady trade rate up over an average month', () => {
    const burn = monthlyCostBurn(10, 1, 1000);
    expect(burn.perMonthUsdt).toBeCloseTo(10 * DAYS_PER_MONTH, 9);
    expect(burn.percentOfEquity).toBeCloseTo(DAYS_PER_MONTH, 9);
  });

  it('reports no share without a positive equity', () => {
    expect(monthlyCostBurn(10, 1, null).percentOfEquity).toBeNull();
    expect(monthlyCostBurn(10, 1, 0).percentOfEquity).toBeNull();
  });
});
