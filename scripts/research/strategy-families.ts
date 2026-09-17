/**
 * Registry of strategy families for the research walk-forward harness. A
 * family is a named, parameterized rule set: a small numeric parameter grid
 * plus a `create` function that turns one grid cell into a `Strategy`
 * (src/lib/backtest/strategy.ts) the backtest engines can run directly. Pure,
 * no I/O.
 *
 * `expandGrid` materializes a family's cartesian product of parameter
 * values, one `{ name: value }` record per grid cell, the first declared
 * param varying slowest (an odometer, least-significant digit last). Bounded
 * by `MAX_PARAMS` (a family's own declared param count) and
 * `MAX_GRID_CELLS` (the product across all params): a walk-forward's
 * per-window cost is linear in cell count, so an unbounded grid is an
 * unbounded backtest bill, not just a slow test.
 *
 * `STRATEGY_FAMILIES`'s one entry today, `control`, has no parameters and
 * wraps today's composite score-threshold strategy
 * (createScoreThresholdStrategy). Its thresholds and weights come from the
 * walk-forward's own config (DEFAULT_TEMPLATE_THRESHOLDS/WEIGHTS for the
 * style), never from the family, so a parameterless family still varies
 * with style and interval through the caller, not through its own (empty)
 * params.
 */

import type { TradingStyle } from '@/lib/models/signal-template';
import type { Strategy } from '@/lib/backtest/strategy';
import { createScoreThresholdStrategy } from '@/lib/backtest/strategies/score-threshold';

/** One numeric parameter a family exposes to the grid search. Numeric only;
 * a boolean-valued parameter is encoded as 0/1 and interpreted by `create`. */
export interface ParamSpec {
  name: string;
  values: number[];
}

export interface StrategyFamily {
  name: string;
  description: string;
  /** At most MAX_PARAMS entries. */
  params: ParamSpec[];
  create(params: Record<string, number>, ctx: { style: TradingStyle; interval: string }): Strategy;
}

export const MAX_PARAMS = 4;
export const MAX_GRID_CELLS = 60;

/**
 * Cartesian product of a family's declared parameter values, in declared
 * order (the first param varies slowest). A family with no params expands
 * to one empty-record cell, `[{}]`: a strategy that reads no params is
 * still exactly one cell to run.
 *
 * Throws when the family declares more than MAX_PARAMS params, when any
 * param has no values (a family that cannot produce even one cell from
 * that param), or when the cartesian product would exceed MAX_GRID_CELLS.
 */
export function expandGrid(family: StrategyFamily): Record<string, number>[] {
  const { params } = family;

  if (params.length > MAX_PARAMS) {
    throw new Error(
      `strategy family "${family.name}" declares ${params.length} params, at most ${MAX_PARAMS} params allowed`
    );
  }

  for (const spec of params) {
    if (spec.values.length === 0) {
      throw new Error(`strategy family "${family.name}" param "${spec.name}" has no values`);
    }
  }

  const totalCells = params.reduce((product, spec) => product * spec.values.length, 1);
  if (totalCells > MAX_GRID_CELLS) {
    throw new Error(
      `strategy family "${family.name}" grid has ${totalCells} cells, at most ${MAX_GRID_CELLS} cells allowed`
    );
  }

  let cells: Record<string, number>[] = [{}];
  for (const spec of params) {
    const next: Record<string, number>[] = [];
    for (const cell of cells) {
      for (const value of spec.values) {
        next.push({ ...cell, [spec.name]: value });
      }
    }
    cells = next;
  }

  return cells;
}

export const STRATEGY_FAMILIES: Record<string, StrategyFamily> = {
  control: {
    name: 'control',
    description: 'current composite score with calibrated thresholds',
    params: [],
    create(): Strategy {
      return createScoreThresholdStrategy();
    },
  },
};
