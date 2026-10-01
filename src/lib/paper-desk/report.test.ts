// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { equityCurveFromTrades } from './report';

describe('equityCurveFromTrades', () => {
  it('returns an empty curve with no trades', () => {
    expect(equityCurveFromTrades([], 1000)).toEqual([]);
  });

  it('accumulates in exit order regardless of input order', () => {
    const curve = equityCurveFromTrades(
      [
        { exitTime: 300, pnl: 5 },
        { exitTime: 100, pnl: 10 },
        { exitTime: 200, pnl: -20 },
      ],
      1000
    );
    expect(curve.map((p) => p.time)).toEqual([100, 200, 300]);
    expect(curve.map((p) => p.equity)).toEqual([1010, 990, 995]);
    expect(curve.map((p) => p.bar)).toEqual([0, 1, 2]);
  });

  it('measures drawdown from the running peak', () => {
    const curve = equityCurveFromTrades(
      [
        { exitTime: 1, pnl: 100 },
        { exitTime: 2, pnl: -110 },
        { exitTime: 3, pnl: 10 },
      ],
      1000
    );
    expect(curve[0].drawdown).toBeCloseTo(0, 10);
    // Peak 1100, trough 990.
    expect(curve[1].drawdown).toBeCloseTo((110 / 1100) * 100, 10);
    expect(curve[2].drawdown).toBeCloseTo((100 / 1100) * 100, 10);
  });
});
