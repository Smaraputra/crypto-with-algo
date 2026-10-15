// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DESK_BOOKS, DESK_READ_RULE, RETIRED_BOOKS, bookId, parseBookId } from './books';

describe('desk books', () => {
  it('excludes the retired scalping:1m book, with its reason recorded', () => {
    expect(DESK_BOOKS.map(bookId)).not.toContain('scalping:1m');
    expect(RETIRED_BOOKS['scalping:1m']).toMatch(/never researched/);
    expect(() => parseBookId('scalping:1m')).toThrow(/Unknown paper desk book/);
    expect(DESK_BOOKS).toHaveLength(6);
    // Slimming v8 (no 1m scoring) must not change which books step.
    expect(DESK_BOOKS.map(bookId)).toEqual([
      'scalping:5m',
      'day_trading:15m',
      'day_trading:1h',
      'swing_trading:4h',
      'swing_trading:1d',
      'position_trading:1d',
    ]);
  });

  it('declares the read rule before any v8 trade, with its parameters fixed', () => {
    expect(DESK_READ_RULE).toEqual({
      declaredOn: '2026-10-02',
      deltaPercent: 0.05,
      alphaOneSided: 0.05,
      power: 0.8,
      executionReadMinTrades: 30,
    });
  });
});
