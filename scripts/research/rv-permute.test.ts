// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createSeededRandom } from '@/lib/stats/seeded-random';
import type { RvPanel } from './rv-panel';
import { applyBarPermutation, drawBarPermutation, permutationIndex, permutePanel } from './rv-permute';

const H8 = 8 * 3_600_000;
const T0 = Date.UTC(2022, 0, 1);

interface PanelOpts {
  n: number;
  symbols: number;
  seed: number;
  /** Lag-1 coefficient of each symbol's intrabar log return (0 = iid). */
  ar?: number;
  /** Marker columns: gap and volume depend on the bar index only, identical for every symbol. */
  markers?: boolean;
}

function gaussian(random: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
}

function makePanel(o: PanelOpts): RvPanel {
  const random = createSeededRandom(o.seed);
  const z = gaussian(random);
  const p: RvPanel = { symbols: [], t: [], open: [], high: [], low: [], close: [], volume: [], tbv: [], fundSum: [], fundLast: [] };
  for (let i = 0; i < o.n; i++) p.t.push(T0 + i * H8);
  for (let s = 0; s < o.symbols; s++) {
    p.symbols.push(`S${s}USDT`);
    const cols = { open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[], tbv: [] as number[], fundSum: [] as number[], fundLast: [] as (number | null)[] };
    let prevClose = 50 + 30 * s;
    let prevR = 0;
    for (let i = 0; i < o.n; i++) {
      const gap = o.markers ? (((i * 37) % 101) - 50) * 1e-5 + i * 1e-9 : z() * 1e-4;
      const open = i === 0 ? prevClose : prevClose * Math.exp(gap);
      const r = (o.ar ?? 0) * prevR + z() * 0.01;
      prevR = r;
      const close = open * Math.exp(r);
      const high = Math.max(open, close) * Math.exp(Math.abs(z()) * 0.004);
      const low = Math.min(open, close) * Math.exp(-Math.abs(z()) * 0.004);
      const volume = o.markers ? 1000 + i : 500 + random() * 1000;
      cols.open.push(open);
      cols.high.push(high);
      cols.low.push(low);
      cols.close.push(close);
      cols.volume.push(volume);
      cols.tbv.push(volume * (0.4 + random() * 0.2));
      cols.fundSum.push(0.0001 + z() * 0.00005);
      cols.fundLast.push(i % 50 === 7 ? null : 0.0001 + z() * 0.00005);
      prevClose = close;
    }
    p.open.push(cols.open);
    p.high.push(cols.high);
    p.low.push(cols.low);
    p.close.push(cols.close);
    p.volume.push(cols.volume);
    p.tbv.push(cols.tbv);
    p.fundSum.push(cols.fundSum);
    p.fundLast.push(cols.fundLast);
  }
  return p;
}

const gapsOf = (p: RvPanel, s: number, from: number) => {
  const out: number[] = [];
  for (let i = from; i < p.t.length; i++) out.push(Math.log(p.open[s][i]) - Math.log(p.close[s][i - 1]));
  return out;
};

/** Intrabar tuples keyed by volume (unique in the fixture): the copied fields and the three log ratios to the open. */
const tuplesOf = (p: RvPanel, s: number, from: number) => {
  const out = new Map<number, { copied: (number | null)[]; ratios: number[] }>();
  for (let i = from; i < p.t.length; i++) {
    const o = Math.log(p.open[s][i]);
    out.set(p.volume[s][i], {
      copied: [p.tbv[s][i], p.fundSum[s][i], p.fundLast[s][i]],
      ratios: [Math.log(p.high[s][i]) - o, Math.log(p.low[s][i]) - o, Math.log(p.close[s][i]) - o],
    });
  }
  return out;
};

const expectSameTuples = (a: ReturnType<typeof tuplesOf>, b: ReturnType<typeof tuplesOf>) => {
  expect([...b.keys()].sort((x, y) => x - y)).toEqual([...a.keys()].sort((x, y) => x - y));
  for (const [key, ta] of a) {
    const tb = b.get(key)!;
    expect(tb.copied).toEqual(ta.copied);
    tb.ratios.forEach((r, j) => expect(Math.abs(r - ta.ratios[j])).toBeLessThan(1e-12));
  }
};

const lag1 = (x: number[]) => {
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    den += (x[i] - m) ** 2;
    if (i > 0) num += (x[i] - m) * (x[i - 1] - m);
  }
  return num / den;
};

describe('permutationIndex (Fisher-Yates over 0..n-1)', () => {
  it('returns a permutation of 0..n-1, deterministic for a seed', () => {
    const a = permutationIndex(500, createSeededRandom(1));
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 500 }, (_, i) => i));
    expect(permutationIndex(500, createSeededRandom(1))).toEqual(a);
    expect(permutationIndex(500, createSeededRandom(2))).not.toEqual(a);
    expect(a).not.toEqual(Array.from({ length: 500 }, (_, i) => i));
  });

  it('is unbiased: 6,000 draws of n = 3 give each of the six orders near 1/6 (review m9)', () => {
    const random = createSeededRandom(20261016);
    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      const key = permutationIndex(3, random).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(['012', '021', '102', '120', '201', '210']);
    // Expected 1,000 each, sd about 29: five sd either side
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(855);
      expect(c).toBeLessThan(1145);
    }
  });

  it('handles n = 0 and n = 1, and rejects a negative or fractional n', () => {
    expect(permutationIndex(0, createSeededRandom(1))).toEqual([]);
    expect(permutationIndex(1, createSeededRandom(1))).toEqual([0]);
    expect(() => permutationIndex(-1, createSeededRandom(1))).toThrow();
    expect(() => permutationIndex(2.5, createSeededRandom(1))).toThrow();
  });
});

describe('drawBarPermutation and applyBarPermutation (the two halves of permutePanel)', () => {
  it('draws the intrabar index first and the gap index second: golden vectors for seed 20261015, n = 10 (review m9)', () => {
    expect(drawBarPermutation(10, createSeededRandom(20261015))).toEqual({
      perm1: [2, 7, 6, 0, 1, 5, 3, 8, 9, 4],
      perm2: [7, 5, 1, 0, 4, 3, 9, 2, 6, 8],
    });
    const p = makePanel({ n: 12, symbols: 2, seed: 21 });
    expect(permutePanel(p, 1, createSeededRandom(20261015))).toEqual(
      applyBarPermutation(p, 1, [2, 7, 6, 0, 1, 5, 3, 8, 9, 4], [7, 5, 1, 0, 4, 3, 9, 2, 6, 8])
    );
  });

  it('applies explicit perm1 and perm2 exactly as a hand-written panel says, first and last permuted bars included (review I4a)', () => {
    // Log prices of symbol A, bars 0..5. Gaps of bars 2..5: 0.005, -0.002, 0.001, -0.003.
    // Intrabar (high, low, close over open) of bars 2..5: (0.025, -0.015, 0.005), (0.012, -0.008, 0.007),
    // (0.024, -0.006, 0.014), (0.008, -0.007, -0.005). Symbol B has every log move doubled.
    const logA = {
      open: [0, 0.01, 0.035, 0.038, 0.046, 0.057],
      high: [0.02, 0.05, 0.06, 0.05, 0.07, 0.065],
      low: [-0.01, 0, 0.02, 0.03, 0.04, 0.05],
      close: [0.01, 0.03, 0.04, 0.045, 0.06, 0.052],
    };
    const px = (logs: number[], scale: number) => logs.map((x) => 100 * Math.exp(scale * x));
    const p: RvPanel = {
      symbols: ['AUSDT', 'BUSDT'],
      t: [0, 1, 2, 3, 4, 5].map((i) => T0 + i * H8),
      open: [px(logA.open, 1), px(logA.open, 2)],
      high: [px(logA.high, 1), px(logA.high, 2)],
      low: [px(logA.low, 1), px(logA.low, 2)],
      close: [px(logA.close, 1), px(logA.close, 2)],
      volume: [[10, 11, 12, 13, 14, 15], [110, 111, 112, 113, 114, 115]],
      tbv: [[5, 5.5, 6, 6.5, 7, 7.5], [50, 55, 60, 65, 70, 75]],
      fundSum: [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [1.1, 1.2, 1.3, 1.4, 1.5, 1.6]],
      fundLast: [[0.1, 0.2, 0.3, null, 0.5, 0.6], [1.1, 1.2, 1.3, 1.4, null, 1.6]],
    };
    // startIndex 1: bars 0 and 1 stay real. perm1 = [3, 0, 2, 1] moves the intrabar tuples of bars 5, 2, 4, 3
    // onto bars 2, 3, 4, 5. perm2 = [2, 3, 1, 0] moves the gaps of bars 4, 5, 3, 2 onto bars 2, 3, 4, 5.
    const q = applyBarPermutation(p, 1, [3, 0, 2, 1], [2, 3, 1, 0]);
    // By hand, compounding from bar 1's log close 0.03:
    // bar 2: open 0.03 + 0.001 = 0.031, high 0.039, low 0.024, close 0.026 (tuple of bar 5)
    // bar 3: open 0.026 - 0.003 = 0.023, high 0.048, low 0.008, close 0.028 (tuple of bar 2)
    // bar 4: open 0.028 - 0.002 = 0.026, high 0.05, low 0.02, close 0.04 (tuple of bar 4)
    // bar 5: open 0.04 + 0.005 = 0.045, high 0.057, low 0.037, close 0.052 (tuple of bar 3)
    const expected = {
      open: [0, 0.01, 0.031, 0.023, 0.026, 0.045],
      high: [0.02, 0.05, 0.039, 0.048, 0.05, 0.057],
      low: [-0.01, 0, 0.024, 0.008, 0.02, 0.037],
      close: [0.01, 0.03, 0.026, 0.028, 0.04, 0.052],
    };
    for (const col of ['open', 'high', 'low', 'close'] as const) {
      for (const [s, scale] of [[0, 1], [1, 2]] as const) {
        expect(Object.is(q[col][s][0], p[col][s][0]) && Object.is(q[col][s][1], p[col][s][1])).toBe(true);
        px(expected[col], scale).forEach((v, i) => expect(Math.abs(q[col][s][i] / v - 1), `${col} ${s} ${i}`).toBeLessThan(1e-12));
      }
    }
    const moved = [0, 1, 5, 2, 4, 3];
    for (const col of ['volume', 'tbv', 'fundSum', 'fundLast'] as const) {
      for (const s of [0, 1]) expect(q[col][s]).toEqual(moved.map((i) => p[col][s][i]));
    }
    expect(q.t).toEqual(p.t);
  });

  it('rejects index arrays of the wrong length or that are not permutations', () => {
    const p = makePanel({ n: 6, symbols: 2, seed: 22 });
    expect(() => applyBarPermutation(p, 1, [0, 1, 2], [0, 1, 2, 3])).toThrow(/perm1/);
    expect(() => applyBarPermutation(p, 1, [0, 1, 2, 3], [0, 1, 1, 3])).toThrow(/perm2/);
    expect(() => applyBarPermutation(p, 1, [0, 1, 2, 4], [0, 1, 2, 3])).toThrow(/perm1/);
  });
});

describe('permutePanel (mcpt bar_permute for several markets, header steps 2 and 4)', () => {
  const N = 600;
  const gapValue = (i: number) => (((i * 37) % 101) - 50) * 1e-5 + i * 1e-9;
  /** Source bar of each permuted position, recovered from the marker columns: volume = 1000 + source, gap = gapValue(source). */
  const sources = (q: RvPanel, s: number, start: number) => {
    const intrabar = q.volume[s].slice(start + 1).map((v) => v - 1000);
    const gap = gapsOf(q, s, start + 1).map((g) => {
      let best = -1;
      for (let i = 1; i < q.t.length; i++) if (best < 0 || Math.abs(gapValue(i) - g) < Math.abs(gapValue(best) - g)) best = i;
      return best;
    });
    return { intrabar, gap };
  };

  it('preserves each symbol\'s multiset of gaps and of intrabar tuples after startIndex', () => {
    const p = makePanel({ n: N, symbols: 4, seed: 7 });
    for (const start of [0, 120]) {
      const q = permutePanel(p, start, createSeededRandom(99));
      for (let s = 0; s < 4; s++) {
        const a = gapsOf(p, s, start + 1).sort((x, y) => x - y);
        const b = gapsOf(q, s, start + 1).sort((x, y) => x - y);
        expect(b).toHaveLength(a.length);
        b.forEach((g, i) => expect(Math.abs(g - a[i])).toBeLessThan(1e-12));
        expectSameTuples(tuplesOf(p, s, start + 1), tuplesOf(q, s, start + 1));
      }
    }
  });

  it('moves every symbol with the same two row mappings, each a non-identity bijection onto the permuted range (review I4b)', () => {
    const p = makePanel({ n: N, symbols: 5, seed: 8, markers: true });
    for (const start of [0, 200]) {
      const q = permutePanel(p, start, createSeededRandom(5));
      const range = Array.from({ length: N - start - 1 }, (_, i) => start + 1 + i);
      const ref = sources(q, 0, start);
      for (let s = 1; s < 5; s++) expect(sources(q, s, start)).toEqual(ref);
      for (const mapping of [ref.intrabar, ref.gap]) {
        expect([...mapping].sort((a, b) => a - b)).toEqual(range);
        expect(mapping).not.toEqual(range);
        // the first and the last permuted positions both receive another bar's values for this seed
        expect(mapping[0]).not.toBe(start + 1);
        expect(mapping[mapping.length - 1]).not.toBe(N - 1);
      }
      expect(ref.gap).not.toEqual(ref.intrabar);
    }
  });

  it('keeps bars 0..startIndex bitwise identical and permutes from startIndex + 1, that bar\'s gap included', () => {
    const p = makePanel({ n: N, symbols: 3, seed: 9, markers: true });
    const start = 200;
    const q = permutePanel(p, start, createSeededRandom(3));
    for (const col of ['open', 'high', 'low', 'close', 'volume', 'tbv', 'fundSum', 'fundLast'] as const) {
      for (let s = 0; s < 3; s++) {
        for (let i = 0; i <= start; i++) expect(Object.is(q[col][s][i], p[col][s][i])).toBe(true);
      }
    }
    expect(q.t).toEqual(p.t);
    expect(q.symbols).toEqual(p.symbols);
    // bar start + 1 takes a drawn gap and a drawn intrabar tuple, recovered from the markers (review I4c)
    const src = sources(q, 0, start);
    expect(src.gap[0]).not.toBe(start + 1);
    expect(src.intrabar[0]).not.toBe(start + 1);
  });

  it('ends every symbol on its real final close (within 1e-9 relative) with valid OHLC', () => {
    const p = makePanel({ n: N, symbols: 4, seed: 10 });
    for (const start of [0, 300]) {
      const q = permutePanel(p, start, createSeededRandom(start + 1));
      for (let s = 0; s < 4; s++) {
        expect(Math.abs(q.close[s][N - 1] / p.close[s][N - 1] - 1)).toBeLessThan(1e-9);
        for (let i = 0; i < N; i++) {
          expect(q.low[s][i]).toBeLessThanOrEqual(Math.min(q.open[s][i], q.close[s][i]));
          expect(q.high[s][i]).toBeGreaterThanOrEqual(Math.max(q.open[s][i], q.close[s][i]));
          expect(q.low[s][i]).toBeGreaterThan(0);
          expect(q.tbv[s][i]).toBeLessThanOrEqual(q.volume[s][i]);
        }
      }
    }
  });

  it('is deterministic for a seed, different across seeds, and leaves the input untouched', () => {
    const p = makePanel({ n: N, symbols: 3, seed: 11 });
    const before = JSON.stringify(p);
    const a = permutePanel(p, 0, createSeededRandom(42));
    expect(permutePanel(p, 0, createSeededRandom(42))).toEqual(a);
    expect(permutePanel(p, 0, createSeededRandom(43)).close).not.toEqual(a.close);
    expect(JSON.stringify(p)).toBe(before);
  });

  it('carries a null fundLast with its intrabar tuple', () => {
    const p = makePanel({ n: N, symbols: 2, seed: 12 });
    const q = permutePanel(p, 0, createSeededRandom(4));
    const nulls = (x: RvPanel, s: number) => x.fundLast[s].slice(1).filter((v) => v === null).length;
    expect(nulls(q, 0)).toBe(nulls(p, 0));
    for (let i = 1; i < N; i++) expect(q.fundLast[0][i] === null).toBe(q.fundLast[1][i] === null);
  });

  it('destroys a planted AR(1) in the intrabar returns: |lag-1 autocorrelation| < 4 / sqrt(n)', () => {
    const n = 3000;
    const p = makePanel({ n, symbols: 2, seed: 13, ar: 0.5 });
    const ret = (x: RvPanel, s: number) => x.close[s].slice(1).map((c, i) => Math.log(c) - Math.log(x.close[s][i]));
    expect(lag1(ret(p, 0))).toBeGreaterThan(0.4);
    const q = permutePanel(p, 0, createSeededRandom(17));
    for (let s = 0; s < 2; s++) expect(Math.abs(lag1(ret(q, s)))).toBeLessThan(4 / Math.sqrt(n));
  });

  it('rejects a start index outside the panel and returns an unchanged copy when nothing is left to permute', () => {
    const p = makePanel({ n: 20, symbols: 2, seed: 14 });
    expect(() => permutePanel(p, -1, createSeededRandom(1))).toThrow();
    expect(() => permutePanel(p, 1.5, createSeededRandom(1))).toThrow();
    expect(() => permutePanel(p, 20, createSeededRandom(1))).toThrow();
    expect(permutePanel(p, 19, createSeededRandom(1))).toEqual(p);
  });
});
