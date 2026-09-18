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
  it('has the five registered families', () => {
    expect(Object.keys(STRATEGY_FAMILIES)).toEqual([
      'control',
      'fade-composite',
      'return-reversal',
      'oscillator-reversion',
      'stochrsi-momentum',
    ]);
  });

  it('control has no params', () => {
    expect(STRATEGY_FAMILIES.control.params).toEqual([]);
  });

  it('control creates a score-threshold strategy', () => {
    const strategy = STRATEGY_FAMILIES.control.create({}, { style: 'day_trading', interval: '1h' });
    expect(strategy.name).toBe('score-threshold');
  });

  it('control expands to exactly one cell', () => {
    expect(expandGrid(STRATEGY_FAMILIES.control)).toEqual([{}]);
  });

  it.each([
    ['fade-composite', 18],
    ['return-reversal', 27],
    ['oscillator-reversion', 18],
    ['stochrsi-momentum', 18],
  ])('%s expands to %d grid cells', (name, cellCount) => {
    expect(expandGrid(STRATEGY_FAMILIES[name])).toHaveLength(cellCount);
  });

  it('expands each phase 4 family in declared param order, first param varying slowest', () => {
    const fadeCells = expandGrid(STRATEGY_FAMILIES['fade-composite']);
    expect(fadeCells[0]).toEqual({ T: 15, timeStop: 8, k: 2 });
    expect(fadeCells[fadeCells.length - 1]).toEqual({ T: 30, timeStop: 32, k: 3 });

    const returnCells = expandGrid(STRATEGY_FAMILIES['return-reversal']);
    expect(returnCells[0]).toEqual({ L: 1, Z: 1.5, H: 4 });
    expect(returnCells[returnCells.length - 1]).toEqual({ L: 20, Z: 2.5, H: 16 });

    const oscillatorCells = expandGrid(STRATEGY_FAMILIES['oscillator-reversion']);
    expect(oscillatorCells[0]).toEqual({ R: 25, H: 8, band: 0 });
    expect(oscillatorCells[oscillatorCells.length - 1]).toEqual({ R: 35, H: 32, band: 1 });

    const stochCells = expandGrid(STRATEGY_FAMILIES['stochrsi-momentum']);
    expect(stochCells[0]).toEqual({ zone: 20, hold: 2, k: 1.5 });
    expect(stochCells[stochCells.length - 1]).toEqual({ zone: 30, hold: 4, k: 3 });
  });

  it.each(['fade-composite', 'return-reversal', 'oscillator-reversion', 'stochrsi-momentum'])(
    '%s: create returns a strategy named for the family, carrying the cell as params, for every grid cell',
    (name) => {
      const family = STRATEGY_FAMILIES[name];
      const cells = expandGrid(family);
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        const strategy = family.create(cell, { style: 'day_trading', interval: '1h' });
        expect(strategy.name).toBe(name);
        expect(strategy.params).toEqual(cell);
      }
    }
  );
});
