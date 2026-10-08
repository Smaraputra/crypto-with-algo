// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as frontier from '../../../scripts/research/frontier';
import { costPercentOfMargin, leverageRows, liquidationDistancePercent } from './leverage';

describe('leverage arithmetic', () => {
  it('scales cost with notional, not the round-trip rate', () => {
    const rows = leverageRows(100, [1, 10], 0.072);
    expect(rows[0]).toEqual({ leverage: 1, notionalUsdt: 100, costUsdt: 0.072, costPercentOfAccount: 0.072 });
    expect(rows[1].costUsdt).toBeCloseTo(0.72, 12);
    expect(rows[1].costPercentOfAccount).toBeCloseTo(0.72, 12);
  });

  it('bounds the liquidation distance by 1/L minus the lowest maintenance tier', () => {
    expect(liquidationDistancePercent(20)).toBeCloseTo(4.6, 10);
    expect(liquidationDistancePercent(50, 0.005)).toBeCloseTo(1.5, 10);
  });

  it('expresses a round trip as a share of margin', () => {
    expect(costPercentOfMargin(0.16, 10)).toBeCloseTo(1.6, 12);
  });

  it('is the same function frontier.ts re-exports, so recorded frontier output is unchanged', () => {
    expect(frontier.leverageRows).toBe(leverageRows);
    expect(frontier.liquidationDistancePercent).toBe(liquidationDistancePercent);
  });
});
