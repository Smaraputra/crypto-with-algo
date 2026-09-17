import { describe, it, expect } from 'vitest';
import { passesSaveGate, SAVE_GATE } from './save-gate';
import type { BacktestMetrics } from '@/lib/backtest/types';
import type { WalkForwardWindow } from '@/types/optimization';

function makeMetrics(expectancyPercent: number): BacktestMetrics {
  return { expectancyPercent } as unknown as BacktestMetrics;
}

function makeWindow(oosMetrics: BacktestMetrics | null, index = 0): WalkForwardWindow {
  return {
    trainStart: index * 100,
    trainEnd: index * 100 + 299,
    testStart: index * 100 + 300,
    testEnd: index * 100 + 399,
    oosMetrics,
    robustCandidates: oosMetrics ? 5 : 0,
  };
}

describe('passesSaveGate', () => {
  it('refuses zero windows', () => {
    const result = passesSaveGate([]);

    expect(result.pass).toBe(false);
    expect(result.contributingWindows).toBe(0);
    expect(result.avgOosExpectancyPercent).toBeNull();
    expect(result.reason).toContain('0');
    expect(result.reason).toContain(String(SAVE_GATE.minContributingWindows));
  });

  it('refuses a single contributing window even with positive expectancy', () => {
    const windows = [makeWindow(makeMetrics(5))];
    const result = passesSaveGate(windows);

    expect(result.pass).toBe(false);
    expect(result.contributingWindows).toBe(1);
    expect(result.avgOosExpectancyPercent).toBe(5);
    expect(result.reason).toContain('1');
    expect(result.reason).toContain(String(SAVE_GATE.minContributingWindows));
  });

  it('refuses five contributing windows with a negative mean expectancy', () => {
    const values = [-4, -2, -1, 3, -6]; // mean -2
    const windows = values.map((v, i) => makeWindow(makeMetrics(v), i));
    const result = passesSaveGate(windows);

    expect(result.pass).toBe(false);
    expect(result.contributingWindows).toBe(5);
    expect(result.avgOosExpectancyPercent).toBeCloseTo(-2, 5);
    expect(result.reason).toContain(result.avgOosExpectancyPercent!.toFixed(4));
  });

  it('passes two contributing windows with a positive mean expectancy', () => {
    const windows = [makeWindow(makeMetrics(2), 0), makeWindow(makeMetrics(4), 1)];
    const result = passesSaveGate(windows);

    expect(result.pass).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.contributingWindows).toBe(2);
    expect(result.avgOosExpectancyPercent).toBeCloseTo(3, 5);
  });

  it('counts only non-null windows in a mixed set', () => {
    const windows = [
      makeWindow(null, 0),
      makeWindow(makeMetrics(1), 1),
      makeWindow(null, 2),
      makeWindow(makeMetrics(3), 3),
      makeWindow(null, 4),
    ];
    const result = passesSaveGate(windows);

    expect(result.contributingWindows).toBe(2);
    expect(result.avgOosExpectancyPercent).toBeCloseTo(2, 5);
    expect(result.pass).toBe(true);
  });
});
