import { describe, it, expect } from 'vitest';
import type { OHLCV } from '@/types/market';
import {
  labelEntries,
  wilderAtr,
  OUTCOME_NONE,
  OUTCOME_UP,
  OUTCOME_DOWN,
  OUTCOME_TIMEOUT,
  OUTCOME_AMBIGUOUS,
  type LabelInput,
} from './snipe-labels';

const M5 = 5 * 60_000;
const H1 = 12 * M5;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H1);

function bar(ts: number, o: number, h: number, l: number, c: number): OHLCV {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 1 };
}

/** Flat-ish entry bars, each with range 2 (high 101, low 99) around 100, so ATR(2) = 2. */
function entryBars(count: number, step = M5, start = T0): OHLCV[] {
  return Array.from({ length: count }, (_, i) => bar(start + i * step, 100, 101, 99, 100));
}

function path(start: number, count: number, h = 100.5, l = 99.5): OHLCV[] {
  return Array.from({ length: count }, (_, i) => bar(start + i * M5, 100, h, l, 100));
}

function base(over: Partial<LabelInput> = {}): LabelInput {
  return {
    entryBars: entryBars(6),
    entryIntervalMs: M5,
    pathBars: path(T0, 200),
    maxHoldMs: 12 * M5,
    atrPeriod: 2,
    barrierAtr: 1,
    sliceEndMs: T0 + 10_000 * M5,
    ...over,
  };
}

// With entry bars flat at 100 with range 2, ATR(2) = 2, entry = 100, upper = 102, lower = 98.
// Condition bar t = 4 enters at bar 5 (open T0 + 5 M5).
const T = 4;
const ENTRY = T0 + 5 * M5;

function withPath(candles: Record<number, [number, number]>): OHLCV[] {
  const p = path(T0, 200);
  for (const [k, [h, l]] of Object.entries(candles)) {
    const i = Number(k);
    p[i] = bar(p[i].timestamp, 100, h, l, 100);
  }
  return p;
}
const idx = (offset: number) => 5 + offset; // path index of the entry candle plus offset (path starts at T0)

describe('wilderAtr', () => {
  it('is NaN before the seed and equals the mean true range at the seed', () => {
    const a = wilderAtr(entryBars(6), 2);
    expect(Number.isNaN(a[0])).toBe(true);
    expect(Number.isNaN(a[1])).toBe(true);
    expect(a[2]).toBeCloseTo(2, 12);
  });
});

describe('labelEntries', () => {
  it('labels UP when the upper barrier is hit first', () => {
    const r = labelEntries(base({ pathBars: withPath({ [idx(3)]: [102.5, 99.5] }) }));
    expect(r.outcome[T]).toBe(OUTCOME_UP);
    expect(r.entryMs[T]).toBe(ENTRY);
    expect(r.exitMs[T]).toBe(ENTRY + 3 * M5 + M5);
    expect(r.atrPct[T]).toBeCloseTo(2, 12);
  });

  it('labels DOWN when the lower barrier is hit first', () => {
    const r = labelEntries(base({ pathBars: withPath({ [idx(1)]: [100.5, 97.9], [idx(2)]: [103, 99.5] }) }));
    expect(r.outcome[T]).toBe(OUTCOME_DOWN);
    expect(r.exitMs[T]).toBe(ENTRY + M5 + M5);
  });

  it('labels AMBIGUOUS when one candle reaches both barriers', () => {
    const r = labelEntries(base({ pathBars: withPath({ [idx(2)]: [103, 97] }) }));
    expect(r.outcome[T]).toBe(OUTCOME_AMBIGUOUS);
    expect(r.exitMs[T]).toBe(ENTRY + 2 * M5 + M5);
  });

  it('labels TIMEOUT with exit at entry plus maxHold when nothing is touched', () => {
    const r = labelEntries(base());
    expect(r.outcome[T]).toBe(OUTCOME_TIMEOUT);
    expect(r.exitMs[T]).toBe(ENTRY + 12 * M5);
  });

  it('ignores a touch at or after the window end', () => {
    const r = labelEntries(base({ pathBars: withPath({ [idx(12)]: [110, 99.5] }) }));
    expect(r.outcome[T]).toBe(OUTCOME_TIMEOUT);
  });

  it('counts an exact touch of the barrier', () => {
    const up = labelEntries(base({ pathBars: withPath({ [idx(0)]: [102, 99.5] }) }));
    expect(up.outcome[T]).toBe(OUTCOME_UP);
    const down = labelEntries(base({ pathBars: withPath({ [idx(0)]: [100.5, 98] }) }));
    expect(down.outcome[T]).toBe(OUTCOME_DOWN);
  });

  it('keeps walking over missing path candles', () => {
    const p = withPath({ [idx(5)]: [103, 99.5] }).filter((_, i) => i !== idx(1) && i !== idx(2));
    const r = labelEntries(base({ pathBars: p }));
    expect(r.outcome[T]).toBe(OUTCOME_UP);
    expect(r.exitMs[T]).toBe(ENTRY + 6 * M5);
  });

  it('gives none across a gap between t and t+1', () => {
    const bars = entryBars(6);
    bars[5] = { ...bars[5], timestamp: bars[5].timestamp + M5 };
    const r = labelEntries(base({ entryBars: bars }));
    expect(r.outcome[T]).toBe(OUTCOME_NONE);
    expect(Number.isNaN(r.exitMs[T])).toBe(true);
    expect(Number.isNaN(r.entryMs[T])).toBe(true);
    expect(Number.isNaN(r.atrPct[T])).toBe(true);
  });

  it('gives none for the last bar and for bars without ATR', () => {
    const r = labelEntries(base());
    expect(r.outcome[5]).toBe(OUTCOME_NONE);
    expect(r.outcome[0]).toBe(OUTCOME_NONE);
    expect(r.outcome[1]).toBe(OUTCOME_NONE);
    expect(r.outcome[2]).toBe(OUTCOME_NONE);
    expect(r.outcome[3]).toBe(OUTCOME_TIMEOUT);
  });

  it('gives none when ATR is zero', () => {
    const flat = Array.from({ length: 6 }, (_, i) => bar(T0 + i * M5, 100, 100, 100, 100));
    const r = labelEntries(base({ entryBars: flat }));
    expect(r.outcome[T]).toBe(OUTCOME_NONE);
  });

  it('uses ATR through bar t-1, not bar t', () => {
    const calm = labelEntries(base({ pathBars: withPath({ [idx(1)]: [102.5, 99.5] }) }));
    const bars = entryBars(6);
    bars[T] = bar(bars[T].timestamp, 100, 150, 50, 100);
    const wild = labelEntries(base({ entryBars: bars, pathBars: withPath({ [idx(1)]: [102.5, 99.5] }) }));
    expect(wild.atrPct[T]).toBeCloseTo(calm.atrPct[T], 12);
    expect(wild.outcome[T]).toBe(OUTCOME_UP);
    expect(wild.exitMs[T]).toBe(calm.exitMs[T]);
  });

  it('drops trades whose window ends after the slice end', () => {
    const windowEnd = ENTRY + 12 * M5;
    const kept = labelEntries(base({ sliceEndMs: windowEnd - 1 }));
    expect(kept.outcome[T]).toBe(OUTCOME_TIMEOUT);
    const dropped = labelEntries(base({ sliceEndMs: windowEnd - 2 }));
    expect(dropped.outcome[T]).toBe(OUTCOME_NONE);
  });

  it('walks hourly entries on 5m candles', () => {
    const bars = entryBars(6, H1);
    const p = path(T0, 12 * 12);
    const hit = 5 * 12 + 7; // seven candles after the entry hour opens
    p[hit] = bar(p[hit].timestamp, 100, 100.5, 97.5, 100);
    const r = labelEntries({
      entryBars: bars,
      entryIntervalMs: H1,
      pathBars: p,
      maxHoldMs: 24 * H1,
      atrPeriod: 2,
      barrierAtr: 1,
      sliceEndMs: T0 + 1000 * H1,
    });
    expect(r.outcome[T]).toBe(OUTCOME_DOWN);
    expect(r.entryMs[T]).toBe(T0 + 5 * H1);
    expect(r.exitMs[T]).toBe(T0 + 5 * H1 + 7 * M5 + M5);
  });

  it('handles several entries sharing the forward path pointer', () => {
    const bars = entryBars(10);
    const p = withPath({ [idx(1)]: [103, 99.5], [idx(6)]: [100.5, 96] });
    const r = labelEntries(base({ entryBars: bars, pathBars: p }));
    // t = 4 enters at path index 5, hits UP one candle later; t = 5 enters at 6 and is UP at index 6.
    expect(r.outcome[4]).toBe(OUTCOME_UP);
    expect(r.outcome[5]).toBe(OUTCOME_UP);
    expect(r.exitMs[5]).toBe(T0 + 6 * M5 + M5);
    expect(r.outcome[6]).toBe(OUTCOME_DOWN);
  });
});
