// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { trailingZByTime, trailingZScore } from './trailing-z';

const HOUR = 3_600_000;

function wave(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 1.5 + 0.3 * Math.sin(i / 7) + 0.05 * Math.cos(i / 3));
}

describe('trailingZByTime', () => {
  it('equals the row-count trailingZScore on a gapless grid', () => {
    const values = wave(400);
    const byIndex = trailingZScore(Float64Array.from(values), 48, 24);
    const byTime = trailingZByTime(
      values.map((value, i) => ({ t: i * HOUR, value })),
      48 * HOUR,
      24
    );
    for (let i = 0; i < values.length; i++) {
      if (Number.isNaN(byIndex[i])) expect(byTime[i]).toBeNaN();
      else expect(byTime[i]).toBeCloseTo(byIndex[i], 10);
    }
  });

  it('thins the window across a gap instead of reaching back past it', () => {
    // 30 hourly rows, a 20-hour hole, then 30 more. With a 24h window the
    // first row after the hole sees only itself and the rows of the last 24h.
    const rows = [
      ...wave(30).map((value, i) => ({ t: i * HOUR, value })),
      ...wave(30).map((value, i) => ({ t: (50 + i) * HOUR, value: value + 1 })),
    ];
    const z = trailingZByTime(rows, 24 * HOUR, 4);
    // Row 30 is t = 50h: its window (26h, 50h] holds rows t = 27, 28, 29 and
    // itself. t = 26h sits on the open end and is out.
    expect(Number.isNaN(z[30])).toBe(false);
    expect(Number.isNaN(trailingZByTime(rows, 24 * HOUR, 5)[30])).toBe(true);
    const window = [rows[27], rows[28], rows[29], rows[30]].map((r) => r.value);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / (window.length - 1));
    expect(z[30]).toBeCloseTo((rows[30].value - mean) / sd, 10);
  });

  it('is NaN below the sample floor, for a non-finite value, and with no spread', () => {
    const rows = [1, 2, 3, Number.NaN, 5].map((value, i) => ({ t: i * HOUR, value }));
    const z = trailingZByTime(rows, 10 * HOUR, 3);
    expect(z[0]).toBeNaN();
    expect(z[1]).toBeNaN();
    expect(Number.isFinite(z[2])).toBe(true);
    expect(z[3]).toBeNaN();
    const flat = trailingZByTime([1, 1, 1, 1].map((value, i) => ({ t: i * HOUR, value })), 10 * HOUR, 2);
    expect(Array.from(flat).every(Number.isNaN)).toBe(true);
  });
});
