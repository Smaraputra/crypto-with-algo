import { describe, expect, it } from 'vitest';

import { callMarks, chunkRange, chunkStarts, viewTally } from './chart-data';
import { TRACK_BARS_CHUNK, TRACK_BARS_MAX_SPAN, type TrackBar } from './types';

const HOUR = 3_600_000;
const SPAN = TRACK_BARS_CHUNK * HOUR;

describe('chunkStarts', () => {
  it('covers the range with chunks aligned to the epoch', () => {
    const from = 3 * SPAN + 5 * HOUR;
    const to = 5 * SPAN + 2 * HOUR;
    expect(chunkStarts(from, to, HOUR)).toEqual([3 * SPAN, 4 * SPAN, 5 * SPAN]);
  });

  it('returns one chunk for a range inside one, and none for an inverted range', () => {
    expect(chunkStarts(SPAN + HOUR, SPAN + 2 * HOUR, HOUR)).toEqual([SPAN]);
    expect(chunkStarts(10, 5, HOUR)).toEqual([]);
  });
});

describe('chunkRange', () => {
  it('spans exactly one chunk of bars, within the route limit', () => {
    const r = chunkRange(SPAN, HOUR);
    expect(r).toEqual({ from: SPAN, to: 2 * SPAN - 1 });
    expect((r.to - r.from) / HOUR).toBeLessThanOrEqual(TRACK_BARS_MAX_SPAN);
  });
});

const bar = (t: number, tier: TrackBar['tier'], fwd: number | null, source: TrackBar['source'] = 'rescore'): TrackBar => ({
  t,
  score: 0,
  tier,
  fwd,
  source,
});

describe('callMarks', () => {
  it('keeps buy and sell bars with their outcome, drops neutral bars', () => {
    const marks = callMarks(
      [
        bar(1, 'buy', 0.5),
        bar(2, 'neutral', 3),
        bar(3, 'strong_sell', -0.1),
        bar(4, 'sell', 0.2),
        bar(5, 'buy', null, 'live'),
      ],
      0.16
    );
    expect([...marks.keys()]).toEqual([1, 3, 4, 5]);
    expect(marks.get(1)).toMatchObject({ dir: 1, outcome: 'won', source: 'rescore' });
    expect(marks.get(3)).toMatchObject({ dir: -1, outcome: 'cost' });
    expect(marks.get(4)).toMatchObject({ dir: -1, outcome: 'wrong' });
    expect(marks.get(5)).toMatchObject({ outcome: 'pending', source: 'live', fwd: null });
  });
});

describe('viewTally', () => {
  it('counts each outcome inside the window only', () => {
    const marks = callMarks(
      [bar(1, 'buy', 0.5), bar(2, 'buy', 0.1), bar(3, 'sell', 0.4), bar(4, 'buy', null, 'live'), bar(9, 'buy', 5)],
      0.16
    );
    expect(viewTally(marks, 1, 4)).toEqual({ calls: 4, right: 2, won: 1, cost: 1, wrong: 1, pending: 1 });
    expect(viewTally(marks, 20, 30).calls).toBe(0);
  });
});
