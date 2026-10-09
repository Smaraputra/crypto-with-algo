import { describe, expect, it } from 'vitest';
import { seededRandom } from './carry-sim';
import { SNIPE_CONSISTENCY, SNIPE_NULL_SD_INFLATION } from './snipe';
import { OUTCOME_AMBIGUOUS, OUTCOME_DOWN, OUTCOME_NONE, OUTCOME_TIMEOUT, OUTCOME_UP } from './snipe-labels';
import type { SnipeSymbolArrays } from './snipe-matrix';
import {
  benjaminiHochberg,
  bootstrapCi,
  buildCommonGrid,
  buildSliceContext,
  cellBit,
  confirmCell,
  confirmDecision,
  consistency,
  empiricalP,
  evaluateCell,
  excessOf,
  nullDraws,
  nullOffsets,
  pOneSided,
  prepareGridCell,
  selectForConfirmation,
  shiftedExcess,
  sliceView,
  summarizeNull,
  takenTrades,
  type CellReport,
  type SnipeCell,
  type TakenTrades,
} from './snipe-stats';
import { TAIL_ELIGIBLE, TAIL_TOP_1, TAIL_TOP_10, monthIndex } from './snipe-tails';

const DAY = 86_400_000;
const T0 = Date.UTC(2018, 0, 1);

interface GenOpts {
  symbol?: string;
  n: number;
  seed: number;
  holdBars?: number;
  /** Returns the flag byte for bar i given its outcome and a uniform draw. */
  flag?: (i: number, outcome: number, u: number) => number;
  outcomeOf?: (i: number, u: number) => number;
}

/** Daily bars; bar i enters at the next bar's time and exits holdBars bars later. */
function makeArrays(o: GenOpts): SnipeSymbolArrays {
  const rnd = seededRandom(o.seed);
  const hold = o.holdBars ?? 1;
  const n = o.n;
  const timestamps = new Float64Array(n);
  const flags = new Uint8Array(n);
  const outcome = new Int8Array(n);
  const entryMs = new Float64Array(n);
  const exitMs = new Float64Array(n);
  const atrPct = new Float64Array(n);
  const atrQuintile = new Int8Array(n);
  const month = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    timestamps[i] = T0 + i * DAY;
    const u = rnd();
    outcome[i] = o.outcomeOf ? o.outcomeOf(i, u) : u < 0.45 ? OUTCOME_UP : u < 0.9 ? OUTCOME_DOWN : u < 0.95 ? OUTCOME_TIMEOUT : OUTCOME_AMBIGUOUS;
    entryMs[i] = timestamps[i] + DAY;
    exitMs[i] = entryMs[i] + hold * DAY;
    atrPct[i] = 0.5 + rnd();
    atrQuintile[i] = Math.floor(rnd() * 5);
    month[i] = monthIndex(timestamps[i]);
    flags[i] = o.flag ? o.flag(i, outcome[i], rnd()) : TAIL_ELIGIBLE;
  }
  return {
    symbol: o.symbol ?? 'AAA',
    timeframe: 'intraday',
    columns: ['c0'],
    timestamps,
    flags: [flags],
    outcome,
    entryMs,
    exitMs,
    atrPct,
    atrQuintile,
    month,
    warmupBars: 0,
    finiteShare: [1],
  };
}

const ALL = { startMs: T0, endMs: T0 + 100_000 * DAY };
const MANY_TOP: SnipeCell = { column: 'c0', tail: 'top', level: 'many', timeframe: 'intraday' };

function hand(n: number, set: Record<number, { outcome: number; flag?: number; q?: number }>, hold = 3): SnipeSymbolArrays {
  return makeArrays({
    n,
    seed: 1,
    holdBars: hold,
    outcomeOf: (i) => set[i]?.outcome ?? OUTCOME_UP,
    flag: (i) => (set[i]?.flag ?? 0) | TAIL_ELIGIBLE,
  });
}

describe('sliceView', () => {
  it('drops none outcomes, quintile -1, bars outside and path-crossing bars', () => {
    const a = makeArrays({ n: 10, seed: 3, holdBars: 2 });
    a.outcome[1] = OUTCOME_NONE;
    a.atrQuintile[2] = -1;
    // slice ends at bar 8 timestamp: maxHold 2 days, entry = ts + 1 day, so bar i needs ts_i + 3d - 1 <= end
    const slice = { startMs: T0 + 0 * DAY, endMs: T0 + 8 * DAY };
    const v = sliceView(a, slice, 2 * DAY);
    // bars 0..8 are in time; bar 6: entry T0+7d, +2d-1ms = T0+9d-1 > T0+8d => dropped; bar 5: T0+6d+2d-1 ok
    expect(Array.from(v.idx)).toEqual([0, 3, 4, 5]);
    const w = sliceView(a, { startMs: T0 + 3 * DAY, endMs: T0 + 8 * DAY }, 2 * DAY);
    expect(Array.from(w.idx)).toEqual([3, 4, 5]);
  });

  it('computes the baseline per stratum from all in-slice resolved bars, flagged or not', () => {
    // one month (days 0..9, Jan 2018), two quintiles
    const a = hand(10, {}, 1);
    for (let i = 0; i < 10; i++) {
      a.atrQuintile[i] = i < 5 ? 0 : 1;
      a.flags[0][i] = (i === 0 ? TAIL_TOP_10 : 0) | TAIL_ELIGIBLE;
    }
    // quintile 0: outcomes up,up,down,timeout,ambiguous => 2/3
    [OUTCOME_UP, OUTCOME_UP, OUTCOME_DOWN, OUTCOME_TIMEOUT, OUTCOME_AMBIGUOUS].forEach((o, i) => (a.outcome[i] = o));
    // quintile 1: down,down,down,up,timeout => 1/4
    [OUTCOME_DOWN, OUTCOME_DOWN, OUTCOME_DOWN, OUTCOME_UP, OUTCOME_TIMEOUT].forEach((o, i) => (a.outcome[5 + i] = o));
    const v = sliceView(a, ALL, DAY);
    for (let i = 0; i < 5; i++) expect(v.b[i]).toBeCloseTo(2 / 3, 12);
    for (let i = 5; i < 10; i++) expect(v.b[i]).toBeCloseTo(1 / 4, 12);
  });

  it('pools the baseline across calendar months (A1-1: the stratum is the ATR quintile only)', () => {
    // 90 daily bars span Jan-Mar 2018, one quintile. Month by month the up share differs; the baseline must not.
    const a = hand(90, {}, 1);
    for (let i = 0; i < 90; i++) {
      a.atrQuintile[i] = 2;
      a.outcome[i] = i < 31 ? OUTCOME_UP : OUTCOME_DOWN;
    }
    const v = sliceView(a, ALL, DAY);
    for (const j of v.idx) expect(v.b[j]).toBeCloseTo(31 / 90, 12);
  });
});

describe('blocking walk', () => {
  it('takes only the first overlapping flag until its exit, and timeouts and ambiguous trades block', () => {
    // hold 3 bars: bar i exits at ts_i + 4d; bar j entry ts_j + 1d. Flags at 0,1,2,3,4,5,10.
    const a = hand(
      20,
      {
        0: { outcome: OUTCOME_TIMEOUT, flag: TAIL_TOP_10 },
        1: { outcome: OUTCOME_UP, flag: TAIL_TOP_10 },
        2: { outcome: OUTCOME_UP, flag: TAIL_TOP_10 },
        3: { outcome: OUTCOME_UP, flag: TAIL_TOP_10 },
        4: { outcome: OUTCOME_AMBIGUOUS, flag: TAIL_TOP_10 },
        5: { outcome: OUTCOME_UP, flag: TAIL_TOP_10 },
        6: { outcome: OUTCOME_DOWN, flag: TAIL_TOP_10 },
        10: { outcome: OUTCOME_DOWN, flag: TAIL_TOP_10 },
      },
      3,
    );
    const v = sliceView(a, ALL, 3 * DAY);
    const t = takenTrades([v], 'c0', TAIL_TOP_10);
    // bar0 exit = T0+4d. bar1..3 entries T0+2d..4d: bar 3 entry = T0+4d >= exit -> taken (exit T0+7d).
    // bar4 entry T0+5d < T0+7d blocked, bar5 6d blocked, bar6 7d >= 7d taken (down, exit T0+10d), bar10 entry 11d taken.
    expect(Array.from(t.bar)).toEqual([0, 3, 6, 10]);
    expect(Array.from(t.y)).toEqual([-1, 1, 0, 0]);
    expect(t.taken).toBe(4);
    expect(t.resolved).toBe(3);
    expect(t.timeouts).toBe(1);
    expect(t.ambiguous).toBe(0);
  });

  it('counts a taken ambiguous trade and blocks behind it', () => {
    const a = hand(10, { 0: { outcome: OUTCOME_AMBIGUOUS, flag: TAIL_TOP_10 }, 1: { outcome: OUTCOME_UP, flag: TAIL_TOP_10 } }, 3);
    const t = takenTrades([sliceView(a, ALL, 3 * DAY)], 'c0', TAIL_TOP_10);
    expect(Array.from(t.bar)).toEqual([0]);
    expect(t.ambiguous).toBe(1);
    expect(Number.isNaN(excessOf(t))).toBe(true);
  });

  it('short excess equals minus the long excess on resolved trades', () => {
    const a = makeArrays({ n: 600, seed: 5, flag: (_i, _o, u) => (u < 0.2 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE) });
    const v = sliceView(a, ALL, DAY);
    const t = takenTrades([v], 'c0', TAIL_TOP_10);
    let long = 0;
    let short = 0;
    let n = 0;
    for (let k = 0; k < t.taken; k++) {
      if (t.y[k] < 0) continue;
      long += t.y[k] - t.b[k];
      short += 1 - t.y[k] - (1 - t.b[k]);
      n++;
    }
    expect(n).toBeGreaterThan(50);
    expect(short / n).toBeCloseTo(-long / n, 12);
    const rep = evaluateCell(buildSliceContext([a], ALL, 'intraday', DAY), MANY_TOP, [100]);
    expect(rep.winRate - rep.baseline).toBeCloseTo(rep.direction * rep.obsAll, 12);
  });
});

describe('common grid', () => {
  it('keeps positions present in every symbol and counts lost bars', () => {
    const a = makeArrays({ n: 20, seed: 1, symbol: 'A' });
    const b = makeArrays({ n: 20, seed: 2, symbol: 'B' });
    b.outcome[3] = OUTCOME_NONE;
    b.outcome[7] = OUTCOME_NONE;
    a.atrQuintile[7] = -1;
    a.atrQuintile[11] = -1;
    const va = sliceView(a, ALL, DAY);
    const vb = sliceView(b, ALL, DAY);
    const grid = buildCommonGrid([va, vb]);
    // a in-slice 0..18 minus {7,11} (bar 19 path-crossing? ALL has a huge end so bar 19 is in) => 18
    expect(grid.G).toBe(20 - 3);
    const ts = Array.from(grid.timestamps).map((t) => (t - T0) / DAY);
    expect(ts).not.toContain(3);
    expect(ts).not.toContain(7);
    expect(ts).not.toContain(11);
    expect(grid.symbols[0].lostBars).toBe(18 - 17);
    expect(grid.symbols[1].lostBars).toBe(18 - 17);
    expect(Array.from(grid.symbols[0].barIdx).slice(0, 4)).toEqual([0, 1, 2, 4]);
  });
});

describe('null', () => {
  function build(seed0: number, flag: GenOpts['flag'], symbols = 4, n = 3000, hold = 1) {
    const arrays = Array.from({ length: symbols }, (_, s) => makeArrays({ n, seed: seed0 + s, symbol: `S${s}`, flag, holdBars: hold }));
    return { arrays, ctx: buildSliceContext(arrays, ALL, 'intraday', hold * DAY) };
  }

  it('nullOffsets are uniform integers in range and reproducible', () => {
    const o = nullOffsets(1000, 100, 500, 7);
    expect(Math.min(...o)).toBeGreaterThanOrEqual(100);
    expect(Math.max(...o)).toBeLessThanOrEqual(900);
    expect(Array.from(nullOffsets(1000, 100, 500, 7))).toEqual(Array.from(o));
    expect(Array.from(nullOffsets(1000, 100, 500, 8))).not.toEqual(Array.from(o));
    expect(() => nullOffsets(150, 100, 5, 7)).toThrow();
  });

  it('random flags with independent labels give a null mean near zero and a modest z', () => {
    const { ctx } = build(100, (_i, _o, u) => (u < 0.1 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE));
    const offsets = nullOffsets(ctx.grid.G, 100, 400, 7);
    const rep = evaluateCell(ctx, MANY_TOP, offsets);
    expect(Math.abs(rep.nullMean)).toBeLessThan(0.02);
    expect(Math.abs(rep.z)).toBeLessThan(3.5);
    expect(rep.validDraws).toBe(400);
    expect(rep.skipped).toBe(false);
  });

  it('flags placed exactly on up bars give a huge z and the minimal empirical p', () => {
    const { ctx } = build(200, (_i, o, u) => (o === OUTCOME_UP && u < 0.2 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE));
    const offsets = nullOffsets(ctx.grid.G, 100, 200, 7);
    const rep = evaluateCell(ctx, MANY_TOP, offsets);
    expect(rep.direction).toBe(1);
    expect(rep.z).toBeGreaterThan(20);
    expect(rep.empiricalP).toBeCloseTo(1 / 201, 12);
    expect(rep.pTwoSided).toBeLessThan(1e-10);
  });

  it('the wrapped walk equals a brute-force shift of the flag array', () => {
    const { ctx } = build(300, (_i, _o, u) => (u < 0.3 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE), 3, 400, 3);
    const { grid, views } = ctx;
    const prepared = prepareGridCell(views, grid, 'c0', TAIL_TOP_10);
    for (const k of [0, 1, 37, 199, 200, 399]) {
      let sum = 0;
      let n = 0;
      for (let s = 0; s < grid.symbols.length; s++) {
        const gs = grid.symbols[s];
        const shifted = new Uint8Array(grid.G);
        for (const p of prepared[s]) shifted[(p + k) % grid.G] = 1;
        let nextFree = -Infinity;
        for (let g = 0; g < grid.G; g++) {
          if (!shifted[g] || gs.entryMs[g] < nextFree) continue;
          nextFree = gs.exitMs[g];
          if (gs.y[g] >= 0) {
            sum += gs.y[g] - gs.b[g];
            n++;
          }
        }
      }
      expect(shiftedExcess(grid, prepared, k)).toBeCloseTo(sum / n, 12);
    }
  });

  it('summarizes with sample sd, excludes non-finite draws and counts them', () => {
    const s = summarizeNull([1, 2, 3, Number.NaN], 5);
    expect(s.mean).toBe(2);
    expect(s.sd).toBe(1);
    expect(s.validDraws).toBe(3);
    expect(s.nonFiniteDraws).toBe(1);
    // (5 - 2) / (1.25 x 1): the null sd is inflated (A1-3)
    expect(s.z).toBeCloseTo(3 / SNIPE_NULL_SD_INFLATION, 12);
    expect(s.pTwoSided).toBeCloseTo(0.0164, 3);
    // denominator is draws.length + 1 and a non-finite draw is never at least the observed (A1-8)
    expect(empiricalP([1, 2, 3, Number.NaN], 3, 1)).toBeCloseTo(2 / 5, 12);
    expect(empiricalP([1, 2, Number.NaN, Number.NaN], 1, -1)).toBeCloseTo(2 / 5, 12);
    expect(empiricalP([1, 2, 3], 1, -1)).toBeCloseTo(2 / 4, 12);
    expect(Number.isNaN(empiricalP([1], 1, 0))).toBe(true);
  });

  it('gives z NaN and p 1 for a null without spread, and a one-sided p in the direction (A1-3, A1-4)', () => {
    for (const draws of [[2, 2, 2], [1], [], [Number.NaN, 1]]) {
      const s = summarizeNull(draws, 5);
      expect(Number.isNaN(s.z)).toBe(true);
      expect(s.pTwoSided).toBe(1);
    }
    expect(pOneSided(Number.NaN, 1)).toBe(1);
    expect(pOneSided(2, 0)).toBe(1);
    expect(pOneSided(1.6448536, 1)).toBeCloseTo(0.05, 5);
    expect(pOneSided(-1.6448536, -1)).toBeCloseTo(0.05, 5);
    expect(pOneSided(1.6448536, -1)).toBeCloseTo(0.95, 5);
    expect(pOneSided(0, 1)).toBeCloseTo(0.5, 12);
  });

  it('nullDraws is deterministic and pools symbols', () => {
    const { ctx } = build(400, (_i, _o, u) => (u < 0.1 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE), 2, 800);
    const prepared = prepareGridCell(ctx.views, ctx.grid, 'c0', TAIL_TOP_10);
    const offs = nullOffsets(ctx.grid.G, 30, 20, 7);
    expect(Array.from(nullDraws(ctx.grid, prepared, offs))).toEqual(Array.from(nullDraws(ctx.grid, prepared, offs)));
  });
});

describe('skip and bits', () => {
  it('maps cells to their flag bits and skips tie-heavy cells', () => {
    expect(cellBit({ tail: 'top', level: 'snipe' })).toBe(TAIL_TOP_1);
    expect(cellBit({ tail: 'bottom', level: 'snipe' })).toBe(2);
    expect(cellBit({ tail: 'top', level: 'many' })).toBe(4);
    expect(cellBit({ tail: 'bottom', level: 'many' })).toBe(8);
    // 25% of eligible bars flagged at the 10% level: above 2 x 10%
    const a = makeArrays({ n: 400, seed: 9, flag: (_i, _o, u) => (u < 0.25 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE) });
    const ctx = buildSliceContext([a], ALL, 'intraday', DAY);
    expect(evaluateCell(ctx, MANY_TOP, [50]).skipped).toBe(true);
    const b = makeArrays({ n: 400, seed: 9, flag: (_i, _o, u) => (u < 0.1 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE) });
    expect(evaluateCell(buildSliceContext([b], ALL, 'intraday', DAY), MANY_TOP, [50]).skipped).toBe(false);
  });
});

describe('bootstrap', () => {
  it('is reproducible by seed and brackets the observed excess', () => {
    const a = makeArrays({ n: 1500, seed: 11, flag: (_i, _o, u) => (u < 0.2 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE) });
    const v = sliceView(a, ALL, DAY);
    const t = takenTrades([v], 'c0', TAIL_TOP_10);
    const ci1 = bootstrapCi([v], t, 300, 11);
    const ci2 = bootstrapCi([v], t, 300, 11);
    const ci3 = bootstrapCi([v], t, 300, 12);
    expect(ci1).toEqual(ci2);
    expect(ci1).not.toEqual(ci3);
    expect(ci1[0]).toBeLessThan(ci1[1]);
    const obs = excessOf(t);
    expect(ci1[0]).toBeLessThan(obs);
    expect(ci1[1]).toBeGreaterThan(obs);
  });
});

describe('consistency', () => {
  /** Hand-built trades: one entry per (symbol, quarter, count) with a fixed per-trade excess. */
  function handTrades(spec: Array<{ symbol: number; quarter: number; count: number; e: number }>, symbols: number) {
    const arrays = Array.from({ length: symbols }, (_, s) => {
      const a = makeArrays({ n: 400, seed: 20 + s });
      return a;
    });
    const views = arrays.map((a) => sliceView(a, ALL, DAY));
    const sym: number[] = [];
    const bar: number[] = [];
    const y: number[] = [];
    const b: number[] = [];
    for (const { symbol, quarter, count, e } of spec) {
      // pick bars whose month falls in the target quarter index (quarter counted from the first quarter of the data)
      const base = Math.floor(arrays[symbol].month[0] / 3);
      const bars: number[] = [];
      for (let i = 0; i < 400 && bars.length < count; i++) if (Math.floor(arrays[symbol].month[i] / 3) === base + quarter) bars.push(i);
      expect(bars.length).toBe(count);
      for (const i of bars) {
        sym.push(symbol);
        bar.push(i);
        y.push(1);
        b.push(1 - e);
      }
    }
    const trades: TakenTrades = {
      symbol: Int32Array.from(sym),
      bar: Int32Array.from(bar),
      y: Int8Array.from(y),
      b: Float64Array.from(b),
      taken: sym.length,
      resolved: sym.length,
      timeouts: 0,
      ambiguous: 0,
    };
    return { views, trades };
  }

  const manyQuarters = (e: (q: number, s: number) => number, symbols = 8, quarters = 5, count = 25) => {
    const spec: Array<{ symbol: number; quarter: number; count: number; e: number }> = [];
    for (let s = 0; s < symbols; s++) for (let q = 0; q < quarters; q++) spec.push({ symbol: s, quarter: q, count, e: e(q, s) });
    return spec;
  };

  it('passes when quarters and symbols agree with the sign', () => {
    const { views, trades } = handTrades(manyQuarters(() => 0.1, 8, 5, 10), 8);
    // 10 trades per symbol-quarter, 8 symbols => 80 per quarter pooled; per symbol 50
    const r = consistency(views, trades, 1);
    expect(r.quarters).toMatchObject({ kept: 5, agree: 5, pass: true });
    expect(r.symbols).toMatchObject({ kept: 8, agree: 8, pass: true });
    expect(r.pass).toBe(true);
    const wrong = consistency(views, trades, -1);
    expect(wrong.quarters.agree).toBe(0);
    expect(wrong.pass).toBe(false);
  });

  it('fails when fewer than minQuarters quarters have enough trades', () => {
    const { views, trades } = handTrades(manyQuarters(() => 0.1, 8, 3, 25), 8);
    const r = consistency(views, trades, 1);
    expect(r.quarters.kept).toBe(3);
    expect(r.quarters.kept).toBeLessThan(SNIPE_CONSISTENCY.minQuarters);
    expect(r.quarters.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('never counts a zero excess as agreeing', () => {
    // quarters 0,1 zero excess, 2,3,4 positive: share 3/5 = 0.6 passes; with quarter 2 also zero it is 2/5
    const mk = (zero: number[]) => handTrades(manyQuarters((q) => (zero.includes(q) ? 0 : 0.1), 8, 5, 10), 8);
    const a = mk([0, 1]);
    expect(consistency(a.views, a.trades, 1).quarters).toMatchObject({ kept: 5, agree: 3, pass: true });
    const b = mk([0, 1, 2]);
    expect(consistency(b.views, b.trades, 1).quarters).toMatchObject({ kept: 5, agree: 2, pass: false });
    const c = mk([0, 1, 2, 3, 4]);
    expect(consistency(c.views, c.trades, 1).symbols.agree).toBe(0);
    expect(consistency(c.views, c.trades, -1).symbols.agree).toBe(0);
  });

  it('applies the symbol count rule', () => {
    // 6 symbols only: fewer than 7 kept => fail
    const six = handTrades(manyQuarters(() => 0.1, 6, 5, 10), 6);
    const r = consistency(six.views, six.trades, 1);
    expect(r.symbols.kept).toBe(6);
    expect(r.symbols.pass).toBe(false);
    // 8 symbols, 2 disagree => 6 agree < 7
    const e = handTrades(manyQuarters((_q, s) => (s < 2 ? -0.3 : 0.1), 8, 5, 10), 8);
    const r2 = consistency(e.views, e.trades, 1);
    expect(r2.symbols).toMatchObject({ kept: 8, agree: 6, pass: false });
    // symbols with too few trades are not counted
    const thin = handTrades(manyQuarters(() => 0.1, 8, 5, 3), 8);
    expect(consistency(thin.views, thin.trades, 1).symbols.kept).toBe(0);
  });
});

describe('benjamini-hochberg and selection', () => {
  it('matches a hand example including the step-up property', () => {
    const ps = [0.205, 0.001, 0.042, 0.074, 0.008, 0.039, 0.059, 0.216, 0.041, 0.212];
    // sorted: .001 .008 .039 .041 .042 .059 .074 .205 .212 .216 ; q = 0.1 thresholds .01 .02 .03 .04 .05 .06 .07 .08 .09 .1
    // largest passing rank is 6 (.059 <= .06), so ranks 1..6 are rejected, including .039 and .041.
    const r = benjaminiHochberg(ps, 0.1);
    expect(ps.filter((_, i) => r[i]).sort()).toEqual([0.001, 0.008, 0.039, 0.041, 0.042, 0.059].sort());
    // q = 0.05: thresholds .005 .01 .015 ...: ranks 1 and 2 pass
    const r2 = benjaminiHochberg(ps, 0.05);
    expect(r2.filter(Boolean).length).toBe(2);
    expect(benjaminiHochberg([Number.NaN, 0.0001], 0.1)).toEqual([false, true]);
    expect(benjaminiHochberg([], 0.1)).toEqual([]);
  });

  const stub = (column: string, tail: 'top' | 'bottom', tf: 'scalp' | 'intraday', p: number, obsAll: number, over: Partial<CellReport> = {}): CellReport =>
    ({
      cell: { column, tail, level: 'snipe', timeframe: tf },
      skipped: false,
      resolved: 100,
      pTwoSided: p,
      obsAll,
      consistency: { pass: true },
      directionAgrees: true,
      ...over,
    }) as unknown as CellReport;

  it('keeps one per (column, tail, timeframe), filters consistency and skipped, breaks ties by |obsAll|', () => {
    const filler = Array.from({ length: 40 }, (_, i) => stub(`f${i}`, 'top', 'scalp', 0.9, 0.01));
    const cells = [
      stub('a', 'top', 'scalp', 1e-6, 0.02),
      // same key as the first with a larger p: dropped by the one-per-key rule
      { ...stub('a', 'top', 'scalp', 2e-6, 0.5), cell: { column: 'a', tail: 'top', level: 'many', timeframe: 'scalp' } } as CellReport,
      stub('a', 'bottom', 'scalp', 1e-6, -0.04),
      stub('b', 'top', 'intraday', 1e-5, 0.03, { consistency: { pass: false } as CellReport['consistency'] }),
      stub('c', 'top', 'intraday', 1e-7, 0.03, { skipped: true }),
      // the whole-slice excess and the grid excess minus the null mean disagree in sign (A1-4)
      stub('e', 'top', 'intraday', 1e-9, 0.03, { directionAgrees: false }),
      stub('d', 'top', 'intraday', 1e-5, 0.01),
      ...filler,
    ];
    const sel = selectForConfirmation(cells);
    expect(sel.map((c) => `${c.cell.column}|${c.cell.tail}`)).toEqual(['a|bottom', 'a|top', 'd|top']);
  });

  it('caps at five by smallest p', () => {
    const cells = Array.from({ length: 8 }, (_, i) => stub(`x${i}`, 'top', 'scalp', 1e-6 * (i + 1), 0.01));
    const sel = selectForConfirmation(cells);
    expect(sel.map((c) => c.cell.column)).toEqual(['x0', 'x1', 'x2', 'x3', 'x4']);
  });

  it('returns nothing when nothing is rejected', () => {
    expect(selectForConfirmation([stub('a', 'top', 'scalp', 0.5, 0.1), stub('b', 'top', 'scalp', 0.6, 0.1)])).toEqual([]);
  });
});

describe('confirmCell', () => {
  const symbols = 8;
  const n = 3000;
  const mk = (flag: GenOpts['flag']) => {
    const arrays = Array.from({ length: symbols }, (_, s) => makeArrays({ n, seed: 500 + s, symbol: `S${s}`, flag }));
    return buildSliceContext(arrays, ALL, 'intraday', DAY);
  };

  it('passes a planted long edge in the fixed direction and fails the opposite direction', () => {
    const ctx = mk((_i, o, u) => (o === OUTCOME_UP && u < 0.2 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE));
    const offsets = nullOffsets(ctx.grid.G, 30, 300, 7);
    const ok = confirmCell(ctx, MANY_TOP, 1, 1, offsets);
    expect(ok.pass).toBe(true);
    expect(ok.empiricalP).toBeCloseTo(1 / 301, 12);
    expect(ok.threshold).toBeCloseTo(0.05, 12);
    expect(confirmCell(ctx, MANY_TOP, -1, 1, offsets).pass).toBe(false);
    expect(ok.zP1).toBeLessThan(ok.threshold);
    expect(ok.report.directionAgrees).toBe(true);
  });

  it('also needs the one-sided normal p of the inflated z below alpha / m (A1-3)', () => {
    const t = 0.01;
    const rep = (over: Partial<CellReport>) =>
      ({ empiricalP: 0.003, zP1: 0.002, consistency: { pass: true }, ...over }) as unknown as CellReport;
    expect(confirmDecision(rep({}), t)).toBe(true);
    expect(confirmDecision(rep({ zP1: 0.02 }), t)).toBe(false);
    expect(confirmDecision(rep({ zP1: 1 }), t)).toBe(false);
    expect(confirmDecision(rep({ empiricalP: 0.02 }), t)).toBe(false);
    expect(confirmDecision(rep({ consistency: { pass: false } as CellReport['consistency'] }), t)).toBe(false);
    expect(confirmDecision(rep({ empiricalP: Number.NaN }), t)).toBe(false);
    // a strict inequality on both p values
    expect(confirmDecision(rep({ empiricalP: t }), t)).toBe(false);
    expect(confirmDecision(rep({ zP1: t }), t)).toBe(false);
  });

  it('applies the Bonferroni threshold alpha / m', () => {
    const ctx = mk((_i, o, u) => (o === OUTCOME_UP && u < 0.2 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE));
    const offsets = nullOffsets(ctx.grid.G, 30, 300, 7);
    // empirical p is 1/301 = 0.00332; alpha / 5 = 0.01 passes, a threshold of 0.0033 would not
    expect(confirmCell(ctx, MANY_TOP, 1, 5, offsets).pass).toBe(true);
    expect(confirmCell(ctx, MANY_TOP, 1, 5, offsets.slice(0, 100)).empiricalP).toBeCloseTo(1 / 101, 12);
  });

  it('fails a random-flag cell', () => {
    const ctx = mk((_i, _o, u) => (u < 0.1 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE));
    const offsets = nullOffsets(ctx.grid.G, 30, 300, 7);
    const r1 = confirmCell(ctx, MANY_TOP, 1, 1, offsets);
    const r2 = confirmCell(ctx, MANY_TOP, -1, 1, offsets);
    expect(r1.pass && r2.pass).toBe(false);
    expect(r1.empiricalP + r2.empiricalP).toBeGreaterThan(1);
  });
});

describe('evaluateCell report', () => {
  it('reports break-even win rates from atrPct in percent and the timeout share of taken trades', () => {
    const a = makeArrays({ n: 500, seed: 31, flag: (_i, _o, u) => (u < 0.1 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE) });
    a.atrPct.fill(1);
    const rep = evaluateCell(buildSliceContext([a], ALL, 'intraday', DAY), MANY_TOP, [60, 120]);
    expect(rep.makerBreakEven).toBeCloseTo(0.5 + 0.04 / 2, 12);
    expect(rep.takerBreakEven).toBeCloseTo(0.5 + 0.1 / 2, 12);
    expect(rep.meanAtrPct).toBe(1);
    expect(rep.medianAtrPct).toBe(1);
    expect(rep.timeoutShare).toBeGreaterThanOrEqual(0);
    expect(rep.resolved).toBeLessThanOrEqual(rep.taken);
    expect(rep.ci[0]).toBeLessThan(rep.ci[1]);
    expect(rep.lostBars).toEqual([0]);
  });

  it('reports direction agreement and the one-sided p of z in the direction (A1-4)', () => {
    const planted = evaluateCell(
      buildSliceContext(
        Array.from({ length: 4 }, (_, k) =>
          makeArrays({ n: 600, seed: 70 + k, symbol: `S${k}`, flag: (_i, o, u) => (o === OUTCOME_UP && u < 0.2 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE) })
        ),
        ALL,
        'intraday',
        DAY
      ),
      MANY_TOP,
      nullOffsets(2000, 30, 100, 7)
    );
    expect(planted.directionAgrees).toBe(true);
    expect(planted.zP1).toBeCloseTo(pOneSided(planted.z, 1), 15);
    // random flags over a handful of seeds: the flag is exactly the sign comparison, false when a side is zero or NaN
    for (let seed = 1; seed <= 6; seed++) {
      const a = makeArrays({ n: 500, seed: 90 + seed, flag: (_i, _o, u) => (u < 0.1 ? TAIL_TOP_10 | TAIL_ELIGIBLE : TAIL_ELIGIBLE) });
      const rep = evaluateCell(buildSliceContext([a], ALL, 'intraday', DAY), MANY_TOP, nullOffsets(400, 30, 60, 7));
      const d = rep.obsGrid - rep.nullMean;
      expect(rep.directionAgrees).toBe(rep.obsAll !== 0 && d !== 0 && Math.sign(rep.obsAll) === Math.sign(d));
    }
    const none = evaluateCell(buildSliceContext([makeArrays({ n: 300, seed: 2 })], ALL, 'intraday', DAY), { ...MANY_TOP, level: 'snipe' }, [60]);
    expect(none.directionAgrees).toBe(false);
    expect(none.zP1).toBe(1);
  });

  it('returns a harmless report when no trade is taken', () => {
    const a = makeArrays({ n: 300, seed: 2 });
    const rep = evaluateCell(buildSliceContext([a], ALL, 'intraday', DAY), { ...MANY_TOP, level: 'snipe' }, [60]);
    expect(rep.taken).toBe(0);
    expect(rep.direction).toBe(0);
    expect(Number.isNaN(rep.pTwoSided)).toBe(true);
    expect(rep.consistency.pass).toBe(false);
  });
});
