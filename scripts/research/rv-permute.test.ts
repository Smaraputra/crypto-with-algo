// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createSeededRandom } from '@/lib/stats/seeded-random';
import type { RvPanel } from './rv-panel';
import { permutationIndex, permutePanel } from './rv-permute';

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

  it('handles n = 0 and n = 1, and rejects a negative or fractional n', () => {
    expect(permutationIndex(0, createSeededRandom(1))).toEqual([]);
    expect(permutationIndex(1, createSeededRandom(1))).toEqual([0]);
    expect(() => permutationIndex(-1, createSeededRandom(1))).toThrow();
    expect(() => permutationIndex(2.5, createSeededRandom(1))).toThrow();
  });
});

describe('permutePanel (mcpt bar_permute for several markets, header steps 2 and 4)', () => {
  const N = 600;

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

  it('moves every symbol with the same two row mappings (marker columns), and the two mappings differ', () => {
    const p = makePanel({ n: N, symbols: 5, seed: 8, markers: true });
    const q = permutePanel(p, 0, createSeededRandom(5));
    for (let i = 1; i < N; i++) {
      for (let s = 1; s < 5; s++) {
        expect(q.volume[s][i]).toBe(q.volume[0][i]);
        expect(Math.abs(Math.log(q.open[s][i]) - Math.log(q.close[s][i - 1]) - (Math.log(q.open[0][i]) - Math.log(q.close[0][i - 1])))).toBeLessThan(1e-12);
      }
    }
    // Recover each mapping from its marker: volume = 1000 + source index, gap = f(source index)
    const intrabarSource = q.volume[0].slice(1).map((v) => v - 1000);
    const gapValue = (i: number) => (((i * 37) % 101) - 50) * 1e-5 + i * 1e-9;
    const gapSource = gapsOf(q, 0, 1).map((g) => {
      let best = -1;
      for (let i = 1; i < N; i++) if (best < 0 || Math.abs(gapValue(i) - g) < Math.abs(gapValue(best) - g)) best = i;
      return best;
    });
    expect(new Set(intrabarSource).size).toBe(N - 1);
    expect(new Set(gapSource).size).toBe(N - 1);
    expect(intrabarSource).not.toEqual(Array.from({ length: N - 1 }, (_, i) => i + 1));
    expect(gapSource).not.toEqual(intrabarSource);
  });

  it('keeps bars 0..startIndex bitwise identical and permutes from startIndex + 1, that bar\'s gap included', () => {
    const p = makePanel({ n: N, symbols: 3, seed: 9 });
    const start = 200;
    const q = permutePanel(p, start, createSeededRandom(3));
    for (const col of ['open', 'high', 'low', 'close', 'volume', 'tbv', 'fundSum', 'fundLast'] as const) {
      for (let s = 0; s < 3; s++) {
        for (let i = 0; i <= start; i++) expect(Object.is(q[col][s][i], p[col][s][i])).toBe(true);
      }
    }
    expect(q.t).toEqual(p.t);
    expect(q.symbols).toEqual(p.symbols);
    // bar start + 1 compounds from the last real close with a drawn gap
    const changed = [0, 1, 2].filter((s) => q.open[s][start + 1] !== p.open[s][start + 1]);
    expect(changed.length).toBeGreaterThan(0);
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
