import { describe, it, expect } from 'vitest';
import { computeRiskMetrics } from './risk-metrics';

function makeSnapshots(
  values: number[],
  startDate = '2024-01-01'
): { date: string; totalValue: number }[] {
  return values.map((v, i) => {
    const d = new Date(startDate);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString(), totalValue: v };
  });
}

describe('computeRiskMetrics', () => {
  it('returns null for fewer than 2 snapshots', () => {
    expect(computeRiskMetrics([])).toBeNull();
    expect(computeRiskMetrics([{ date: '2024-01-01', totalValue: 1000 }])).toBeNull();
  });

  it('computes basic metrics for 2 data points', () => {
    const data = makeSnapshots([1000, 1100]);
    const result = computeRiskMetrics(data);

    expect(result).not.toBeNull();
    expect(result!.dataPoints).toBe(2);
    expect(result!.totalReturn).toBeCloseTo(0.1);
    expect(result!.bestDay!.return).toBeCloseTo(0.1);
    expect(result!.worstDay!.return).toBeCloseTo(0.1);
    // Not enough points for drawdown or ratios
    expect(result!.maxDrawdown).toBeNull();
    expect(result!.sharpeRatio).toBeNull();
    expect(result!.sortinoRatio).toBeNull();
  });

  it('computes max drawdown with >= 7 data points', () => {
    // Values: goes up then down then up
    const data = makeSnapshots([1000, 1100, 1200, 1050, 900, 950, 1000]);
    const result = computeRiskMetrics(data);

    expect(result).not.toBeNull();
    expect(result!.maxDrawdown).not.toBeNull();
    // Max drawdown: peak was 1200, trough was 900 => (900-1200)/1200 = -0.25
    expect(result!.maxDrawdown).toBeCloseTo(-0.25);
  });

  it('returns null drawdown for < 7 data points', () => {
    const data = makeSnapshots([1000, 1100, 1050, 900, 950, 1000]);
    const result = computeRiskMetrics(data);

    expect(result!.maxDrawdown).toBeNull();
    expect(result!.maxDrawdownDate).toBeNull();
  });

  it('computes Sharpe and Sortino with >= 30 data points', () => {
    // 30 days of gradual growth with some volatility
    const values = Array.from({ length: 31 }, (_, i) => {
      return 10000 + i * 100 + Math.sin(i) * 200;
    });
    const data = makeSnapshots(values);
    const result = computeRiskMetrics(data);

    expect(result).not.toBeNull();
    expect(result!.sharpeRatio).not.toBeNull();
    expect(result!.sortinoRatio).not.toBeNull();
    expect(typeof result!.sharpeRatio).toBe('number');
    expect(typeof result!.sortinoRatio).toBe('number');
  });

  it('returns null Sharpe/Sortino for < 30 data points', () => {
    const data = makeSnapshots(Array.from({ length: 10 }, (_, i) => 1000 + i * 10));
    const result = computeRiskMetrics(data);

    expect(result!.sharpeRatio).toBeNull();
    expect(result!.sortinoRatio).toBeNull();
  });

  it('identifies best and worst days correctly', () => {
    const data = makeSnapshots([1000, 1200, 1100, 800, 1300]);
    const result = computeRiskMetrics(data);

    expect(result).not.toBeNull();
    // Best day: 800 -> 1300 = 62.5%
    expect(result!.bestDay!.return).toBeCloseTo(0.625);
    // Worst day: 1100 -> 800 = -27.27%
    expect(result!.worstDay!.return).toBeCloseTo(-0.2727, 3);
  });

  it('computes annualized volatility', () => {
    // Stable values should yield low volatility
    const stableData = makeSnapshots([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]);
    const stableResult = computeRiskMetrics(stableData);

    // Volatile values
    const volatileData = makeSnapshots([1000, 1200, 900, 1300, 800, 1400, 700, 1500]);
    const volatileResult = computeRiskMetrics(volatileData);

    expect(stableResult!.annualizedVolatility).toBeLessThan(
      volatileResult!.annualizedVolatility!
    );
  });

  it('computes total return correctly', () => {
    const data = makeSnapshots([1000, 1100, 1200, 1500]);
    const result = computeRiskMetrics(data);

    // (1500 - 1000) / 1000 = 0.5
    expect(result!.totalReturn).toBeCloseTo(0.5);
  });

  it('sorts snapshots by date', () => {
    // Provide out-of-order data
    const data = [
      { date: '2024-01-03T00:00:00.000Z', totalValue: 1200 },
      { date: '2024-01-01T00:00:00.000Z', totalValue: 1000 },
      { date: '2024-01-02T00:00:00.000Z', totalValue: 1100 },
    ];
    const result = computeRiskMetrics(data);

    expect(result!.totalReturn).toBeCloseTo(0.2);
  });

  it('handles zero-value data points gracefully', () => {
    const data = makeSnapshots([0, 0, 1000]);
    const result = computeRiskMetrics(data);

    // All daily returns are skipped (division by zero), so returns null
    expect(result).toBeNull();
  });

  it('handles partial zero-value data points', () => {
    const data = makeSnapshots([0, 1000, 1100, 1050]);
    const result = computeRiskMetrics(data);

    // First return skipped (0->1000 is div by 0), but others work
    expect(result).not.toBeNull();
    expect(result!.dataPoints).toBe(4);
  });

  it('returns drawdown date for max drawdown', () => {
    const data = makeSnapshots([
      1000, 1100, 1200, 1050, 900, 850, 950, 1000,
    ]);
    const result = computeRiskMetrics(data);

    expect(result!.maxDrawdownDate).not.toBeNull();
    // Max drawdown is at value 850 (index 5)
    const expectedDate = new Date('2024-01-01');
    expectedDate.setUTCDate(expectedDate.getUTCDate() + 5);
    expect(result!.maxDrawdownDate).toBe(expectedDate.toISOString());
  });
});
