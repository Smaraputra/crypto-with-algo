// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FactorMatrix } from './factors';
import { appendCrossSymbolFactors } from './cross-symbol-factors';

function matrixOf(ret1: number[], timestamps = [0, 1, 2]): FactorMatrix {
  return {
    names: ['raw.ret1'],
    categories: ['raw'],
    values: [Float64Array.from(ret1)],
    warmupBars: 0,
    timestamps,
    closes: ret1.map(() => 100),
    perpCloses: ret1.map(() => NaN),
  };
}

describe('appendCrossSymbolFactors', () => {
  it('is BTC ret1 minus the equal-weight market ret1, NaN for BTC and below minSymbols', () => {
    const data = [
      { symbol: 'BTCUSDT', matrix: matrixOf([0.01, 0.02, NaN]) },
      { symbol: 'ETHUSDT', matrix: matrixOf([0.0, 0.04, 0.01]) },
      { symbol: 'SOLUSDT', matrix: matrixOf([-0.01, 0.0, 0.02]) },
    ];
    appendCrossSymbolFactors(data, 3);
    const col = (i: number) => Array.from(data[i].matrix.values[data[i].matrix.names.indexOf('raw.btcLeadLag')]);
    // t0 market mean 0, t1 mean 0.02, t2 only two finite readings.
    expect(col(1)[0]).toBeCloseTo(0.01, 12);
    expect(col(1)[1]).toBeCloseTo(0, 12);
    expect(col(1)[2]).toBeNaN();
    expect(col(2)).toEqual(col(1));
    expect(col(0).every(Number.isNaN)).toBe(true);
    expect(data[1].matrix.categories[data[1].matrix.names.indexOf('raw.btcLeadLag')]).toBe('raw');
  });

  it('is NaN everywhere without BTC in the universe, and idempotent', () => {
    const data = [{ symbol: 'ETHUSDT', matrix: matrixOf([0.0, 0.04, 0.01]) }, { symbol: 'SOLUSDT', matrix: matrixOf([-0.01, 0.0, 0.02]) }, { symbol: 'ADAUSDT', matrix: matrixOf([0.02, 0.01, 0.0]) }];
    appendCrossSymbolFactors(data, 3);
    appendCrossSymbolFactors(data, 3);
    expect(data[0].matrix.names.filter((n) => n === 'raw.btcLeadLag')).toHaveLength(1);
    expect(Array.from(data[0].matrix.values[1]).every(Number.isNaN)).toBe(true);
  });

  it('joins on timestamps, not positions', () => {
    const data = [
      { symbol: 'BTCUSDT', matrix: matrixOf([0.01, 0.03], [0, 2]) },
      { symbol: 'ETHUSDT', matrix: matrixOf([0.0, 0.04, 0.01], [0, 1, 2]) },
      { symbol: 'SOLUSDT', matrix: matrixOf([-0.01, 0.0, 0.02], [0, 1, 2]) },
    ];
    appendCrossSymbolFactors(data, 3);
    const eth = Array.from(data[1].matrix.values[1]);
    expect(eth[0]).toBeCloseTo(0.01, 12);
    expect(eth[1]).toBeNaN();
    expect(eth[2]).toBeCloseTo(0.03 - 0.02, 12);
  });
});
