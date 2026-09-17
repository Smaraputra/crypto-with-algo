// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  expandGrid,
  MAX_GRID_CELLS,
  MAX_PARAMS,
  STRATEGY_FAMILIES,
  type StrategyFamily,
} from './strategy-families';
import { createScoreThresholdStrategy } from '@/lib/backtest/strategies/score-threshold';

function makeFamily(overrides: Partial<StrategyFamily> = {}): StrategyFamily {
  return {
    name: 'test-family',
    description: 'a family for testing expandGrid',
    params: [],
    create: () => createScoreThresholdStrategy(),
    ...overrides,
  };
}

describe('expandGrid', () => {
  it('returns the cartesian product in declared order, first param varying slowest', () => {
    const family = makeFamily({
      params: [
        { name: 'a', values: [1, 2] },
        { name: 'b', values: [10, 20] },
      ],
    });

    expect(expandGrid(family)).toEqual([
      { a: 1, b: 10 },
      { a: 1, b: 20 },
      { a: 2, b: 10 },
      { a: 2, b: 20 },
    ]);
  });

  it('returns a single empty-record cell for a family with no params', () => {
    const family = makeFamily({ params: [] });

    expect(expandGrid(family)).toEqual([{}]);
  });

  it('throws when the family declares more than MAX_PARAMS params', () => {
    const family = makeFamily({
      params: Array.from({ length: MAX_PARAMS + 1 }, (_, i) => ({
        name: `p${i}`,
        values: [1],
      })),
    });

    expect(() => expandGrid(family)).toThrow(/at most 4 params/);
  });

  it('throws when the grid product exceeds MAX_GRID_CELLS', () => {
    // 8 * 8 = 64 > 60
    const family = makeFamily({
      params: [
        { name: 'a', values: Array.from({ length: 8 }, (_, i) => i) },
        { name: 'b', values: Array.from({ length: 8 }, (_, i) => i) },
      ],
    });

    expect(() => expandGrid(family)).toThrow(/60 cells/);
    expect(MAX_GRID_CELLS).toBe(60);
  });

  it('throws when a param has an empty values list', () => {
    const family = makeFamily({
      params: [{ name: 'a', values: [] }],
    });

    expect(() => expandGrid(family)).toThrow(/no values/);
  });
});

describe('STRATEGY_FAMILIES', () => {
  it('has one entry, control, with no params', () => {
    expect(Object.keys(STRATEGY_FAMILIES)).toEqual(['control']);
    expect(STRATEGY_FAMILIES.control.params).toEqual([]);
  });

  it('control creates a score-threshold strategy', () => {
    const strategy = STRATEGY_FAMILIES.control.create({}, { style: 'day_trading', interval: '1h' });
    expect(strategy.name).toBe('score-threshold');
  });

  it('control expands to exactly one cell', () => {
    expect(expandGrid(STRATEGY_FAMILIES.control)).toEqual([{}]);
  });
});
