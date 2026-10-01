// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { equityCurveFromTrades, readRuleState, requiredTrades } from './report';

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

describe('the pre-declared read rule', () => {
  it('sizes the count from the effective sd: ((z(0.95) + z(0.8)) x sd / delta)^2', () => {
    // z(0.95) 1.6449 + z(0.8) 0.8416 = 2.4865; at sd 2.045 and delta 0.05 that is 10,342.5 -> 10,343.
    expect(requiredTrades(2.045, 0.05, 0.05, 0.8)).toBe(10343);
    expect(requiredTrades(1, 1, 0.05, 0.8)).toBe(7);
  });

  it('reads go-live only once the count is reached, and futility at any time', () => {
    const stats = (ciLow: number, ciHigh: number, trades: number) => ({
      trades,
      expectancyPercent: (ciLow + ciHigh) / 2,
      ciLowPercent: ciLow,
      ciHighPercent: ciHigh,
      winRate: 0.5,
      totalPnl: 0,
    });
    const early = readRuleState('15m', stats(0.01, 0.2, 40));
    expect(early.goLive).toBe(early.requiredTrades === null ? 'no_count' : 'not_yet');
    expect(early.executionReadReady).toBe(true);
    expect(readRuleState('15m', stats(-0.3, -0.01, 40)).futility).toBe(true);
    const required = readRuleState('15m', null).requiredTrades;
    if (required !== null) {
      expect(readRuleState('15m', stats(0.01, 0.2, required)).goLive).toBe('pass');
      expect(readRuleState('15m', stats(-0.01, 0.2, required)).goLive).toBe('fail');
    }
  });

  it('cannot size a count without a recorded sd', () => {
    expect(readRuleState('1m', null)).toMatchObject({ requiredTrades: null, goLive: 'no_count', executableTrades: 0 });
  });
});
