// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  fundingSettlementUpserts,
  settlementSpacingReport,
  settlementTimeOf,
  type SettlementRow,
} from './funding-settlements';

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

describe('settlementTimeOf', () => {
  it('rounds the archive calc_time, stamped 1 ms after the boundary, back onto it', () => {
    expect(settlementTimeOf(T0 + 1)).toBe(T0);
    expect(settlementTimeOf(T0 + 8 * HOUR + 1)).toBe(T0 + 8 * HOUR);
  });
  it('also absorbs a stamp a little before the boundary', () => {
    expect(settlementTimeOf(T0 - 5)).toBe(T0);
  });
});

describe('fundingSettlementUpserts', () => {
  it('keys each settlement on (symbol, boundary) and keeps the raw time for audit', () => {
    const ops = fundingSettlementUpserts('BTCUSDT', [
      { timestamp: T0 + 1, intervalHours: 8, rate: 0.0001 },
      { timestamp: T0 + 8 * HOUR + 1, intervalHours: null, rate: -0.00005 },
    ]);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      filter: { symbol: 'BTCUSDT', fundingTime: T0 },
      set: { symbol: 'BTCUSDT', fundingTime: T0, rawTime: T0 + 1, rate: 0.0001, intervalHours: 8 },
    });
    expect(ops[1].set.intervalHours).toBeNull();
  });
  it('skips a row with a non-finite time or rate rather than storing a zero', () => {
    const ops = fundingSettlementUpserts('BTCUSDT', [
      { timestamp: Number.NaN, intervalHours: 8, rate: 0.0001 },
      { timestamp: T0, intervalHours: 8, rate: Number.NaN },
    ]);
    expect(ops).toHaveLength(0);
  });
});

function series(start: number, hours: number[], rates: number[], intervals: (number | null)[]): SettlementRow[] {
  let t = start;
  return hours.map((h, i) => {
    const row = { t, rate: rates[i], intervalHours: intervals[i] };
    t += h * HOUR;
    return row;
  });
}

describe('settlementSpacingReport', () => {
  it('finds no mismatch on a clean 8h grid and counts the base-rate share', () => {
    const rows = series(T0, [8, 8, 8, 8], [0.0001, 0.0001, 0.0002, -0.0001], [8, 8, 8, 8]);
    const [year] = settlementSpacingReport(rows);
    expect(year).toMatchObject({ year: 2024, settlements: 4, spacingMismatches: 0, missingSpan: 0, intervalSwitches: 0 });
    expect(year.byInterval).toEqual({ '8': 4 });
    expect(year.baseRateShare).toBe(0.5);
    expect(year.minRate).toBe(-0.0001);
    expect(year.maxRate).toBe(0.0002);
  });

  it('flags a missing settlement as a long gap', () => {
    // 8h, then 16h (one settlement absent), then 8h.
    const rows = series(T0, [8, 16, 8, 8], [0.0001, 0.0001, 0.0001, 0.0001], [8, 8, 8, 8]);
    const [year] = settlementSpacingReport(rows);
    expect(year.spacingMismatches).toBe(1);
    expect(year.missingSpan).toBe(1);
  });

  it('records a switch to a 4h interval, the case a fixed 8h grid undercounts', () => {
    const rows = series(T0, [8, 8, 4, 4, 4], [0.0001, 0.0001, 0.003, 0.003, 0.0001], [8, 8, 4, 4, 8]);
    const [year] = settlementSpacingReport(rows);
    expect(year.intervalSwitches).toBe(2);
    expect(year.byInterval).toEqual({ '8': 3, '4': 2 });
    expect(year.spacingMismatches).toBe(0);
    // Two settlements sit at the year's largest |rate|: the pile a cap leaves.
    expect(year.atExtreme).toBe(2);
  });

  it('splits by UTC calendar year', () => {
    const lastOf2023 = Date.UTC(2023, 11, 31, 16);
    const rows = series(lastOf2023, [8, 8, 8], [0.0001, 0.0001, 0.0001], [8, 8, 8]);
    expect(settlementSpacingReport(rows).map((r) => [r.year, r.settlements])).toEqual([
      [2023, 1],
      [2024, 2],
    ]);
  });
});
