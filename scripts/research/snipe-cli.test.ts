import { describe, expect, it } from 'vitest';
import { confirmationSlice, discoverySlice } from './snipe-cli';
import { OUTCOME_UP } from './snipe-labels';
import type { SnipeSymbolArrays } from './snipe-matrix';
import { sliceView } from './snipe-stats';

describe('slice bounds (A1-7)', () => {
  it('discovery starts at 2022-01-01 and ends 1 ms before the confirmation start', () => {
    const s = discoverySlice();
    expect(new Date(s.startMs).toISOString()).toBe('2022-01-01T00:00:00.000Z');
    expect(new Date(s.endMs).toISOString()).toBe('2024-12-31T23:59:59.999Z');
  });

  it('confirmation starts at 2025-01-01 and ends 1 ms before the lockbox start', () => {
    const s = confirmationSlice();
    expect(new Date(s.startMs).toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(new Date(s.endMs).toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });

  it('keeps the last bar whose trade window ends exactly at the slice end', () => {
    // The 1h bar at 2024-12-30T23:00 enters at 2024-12-31T00:00 and holds 24h: its last millisecond is
    // 2024-12-31T23:59:59.999Z. The second-rounded end 23:59:59 would have dropped it.
    const hour = 3_600_000;
    const day = 24 * hour;
    const t = Date.parse('2024-12-30T23:00:00Z');
    const arrays = {
      timestamps: Float64Array.of(t, t + hour),
      outcome: Int8Array.of(OUTCOME_UP, OUTCOME_UP),
      entryMs: Float64Array.of(t + hour, t + 2 * hour),
      atrQuintile: Int8Array.of(1, 1),
    } as unknown as SnipeSymbolArrays;
    const view = sliceView(arrays, discoverySlice(), day);
    expect(Array.from(view.idx)).toEqual([0]);
    const old = sliceView(arrays, { startMs: discoverySlice().startMs, endMs: Date.parse('2024-12-31T23:59:59Z') }, day);
    expect(Array.from(old.idx)).toEqual([]);
  });
});
