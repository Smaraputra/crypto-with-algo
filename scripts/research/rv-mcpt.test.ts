// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  RV_V1,
  rvComposite,
  rvFactors,
  rvInitialState,
  rvStep,
  rvTargets,
  type RvCell,
  type RvFillBar,
  type RvSettlement,
  type RvSymbolInput,
  type RvTrackState,
  type RvWeights,
} from '@/lib/signals/cross-sectional/engine';
import { perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import type { FirstHourBars, RvPanel } from './rv-panel';
import * as permuteModule from './rv-permute';
import { ANNUALISATION, rvV1NetTakerReturns, syntheticPanel } from './rv-synthetic';
import {
  BLOCK_LEN,
  BLOCK_M,
  FIRST_SIGNAL_BAR,
  IS_M,
  RV_BASE_SEED,
  RV_CELLS,
  RV_SEEDS,
  RV_V1_CELL_INDEX,
  RV_WF_GEOMETRY,
  WF_M,
  annualise,
  assertDistinctSeeds,
  blockShard,
  calibrationSeedGroups,
  drawBlockPermutation,
  foldsOf,
  insampleShard,
  objective,
  pValue,
  permutePanelBlocks,
  prepareSteps,
  realStudySeedGroups,
  runCells,
  runWalkForwardBook,
  selectCell,
  trainingSteps,
  walkForward,
  wfShard,
} from './rv-mcpt';

vi.mock('./rv-permute', async (importOriginal) => {
  const original = await importOriginal<typeof import('./rv-permute')>();
  return { ...original, permutePanel: vi.fn(original.permutePanel) };
});

const H8 = 8 * 3_600_000;
const SLIP = RV_V1.costs.takerSlippageBps / 1e4;
const FEE = RV_V1.costs.takerFee;

const planted = (bars: number, seed: number, strength = 1) => syntheticPanel({ bars, symbols: 10, mode: 'planted', strength, seed });
const iid = (bars: number, seed: number) => syntheticPanel({ bars, symbols: 10, mode: 'iid', strength: 0, seed });

const clone = (p: RvPanel, f: (q: RvPanel) => void): RvPanel => {
  const q = structuredClone(p);
  f(q);
  return q;
};
const truncate = (p: RvPanel, n: number): RvPanel =>
  clone(p, (q) => {
    q.t = q.t.slice(0, n);
    const cols = q as unknown as Record<string, unknown[][]>;
    for (const col of ['open', 'high', 'low', 'close', 'volume', 'tbv', 'fundSum', 'fundLast']) cols[col] = cols[col].map((row) => row.slice(0, n));
  });
const firstDiff = (a: readonly number[], b: readonly number[]) => a.findIndex((x, i) => x !== b[i]);

// ------------------------------------------------------------------------------------------------
// An independent reading of the header CELLS rule and of the engine calls, written separately from
// rv-mcpt.ts so the module is checked against the header text rather than against itself.
// ------------------------------------------------------------------------------------------------

/** Header CELLS: index = 4 * buffer + 2 * betaNeutral + flowOn, flow off .40/.30/.30/0, flow on .30/.25/.30/.15. */
function headerCell(index: number): { weights: RvWeights; cell: RvCell } {
  const buffer = Math.floor(index / 4);
  const betaNeutral = Math.floor(index / 2) % 2 === 1;
  const flowOn = index % 2 === 1;
  return {
    weights: flowOn ? { mom: 0.3, idio: 0.25, carry: 0.3, flow: 0.15 } : { mom: 0.4, idio: 0.3, carry: 0.3, flow: 0 },
    cell: { legs: 2, buffer, betaNeutral, autoClampBuffer: true },
  };
}

interface RefStep {
  k: number;
  targets: Record<string, number>;
  before: RvTrackState;
  after: RvTrackState;
  equityAfter: number;
}

/** A plain loop over the engine: a book that opens flat and signals at bars from..to with schedule(k)'s cell. */
function referenceBook(panel: RvPanel, schedule: (k: number) => number, from: number, to: number, maker?: FirstHourBars): RefStep[] {
  let state = rvInitialState();
  let prevFillTime: number | null = null;
  const out: RefStep[] = [];
  for (let k = from; k <= to; k++) {
    const close = panel.t[k] + H8;
    const inputs: RvSymbolInput[] = panel.symbols.map((symbol, s) => ({
      symbol,
      bars: Array.from({ length: 43 }, (_, j) => {
        const b = k - 42 + j;
        return { openTime: panel.t[b], close: panel.close[s][b], volume: panel.volume[s][b], takerBuyVolume: panel.tbv[s][b] };
      }),
      lastSettlement: { fundingTime: close, rate: panel.fundLast[s][k] as number, markPrice: null },
    }));
    const f = rvFactors(inputs, panel.t[k]);
    const { weights, cell } = headerCell(schedule(k));
    const held = new Map<string, 1 | -1>();
    for (const [sym, p] of Object.entries(state.positions)) if (p.qty !== 0) held.set(sym, p.qty > 0 ? 1 : -1);
    const targets = Object.fromEntries(rvTargets(rvComposite(f.rows, weights), held, new Map(f.rows.map((r) => [r.symbol, r.beta])), cell));
    const fillBars: Record<string, RvFillBar> = {};
    const settlements: Record<string, RvSettlement[]> = {};
    panel.symbols.forEach((sym, s) => {
      fillBars[sym] = maker
        ? { open: maker.open[s][k + 1], high: maker.high[s][k + 1], low: maker.low[s][k + 1], close: maker.close[s][k + 1] }
        : { open: panel.open[s][k + 1], high: panel.high[s][k + 1], low: panel.low[s][k + 1], close: panel.close[s][k + 1] };
      settlements[sym] = [{ fundingTime: close, rate: panel.fundSum[s][k], markPrice: null }];
    });
    const { state: next, record } = rvStep(state, { track: maker ? 'maker' : 'taker', prevFillTime, fillTime: close, fillBars, settlements, targets });
    out.push({ k, targets, before: state, after: next, equityAfter: record.equityAfter });
    state = next;
    prevFillTime = close;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------

describe('cells (header CELLS: index = 4 * buffer + 2 * betaNeutral + flowOn)', () => {
  it('lists the 12 cells in index order with the header weights and configs, and cell 11 is rv-v1', () => {
    expect(RV_CELLS).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      const want = headerCell(i);
      expect(RV_CELLS[i].index).toBe(i);
      expect(RV_CELLS[i].weights).toEqual(want.weights);
      expect(RV_CELLS[i].cell).toEqual(want.cell);
      expect(4 * RV_CELLS[i].buffer + 2 * Number(RV_CELLS[i].betaNeutral) + Number(RV_CELLS[i].flowOn)).toBe(i);
    }
    expect(RV_V1_CELL_INDEX).toBe(11);
    expect(RV_CELLS[11].weights).toEqual(RV_V1.weights);
    expect(RV_CELLS[11].cell).toEqual({ legs: RV_V1.legs, buffer: RV_V1.buffer, betaNeutral: RV_V1.betaNeutral, autoClampBuffer: RV_V1.autoClampBuffer });
  });
});

describe('objective (header OBJECTIVE: per-bar net Sharpe, annualised only for reporting)', () => {
  it('is mean over sample sd, and the annualisation factor is sqrt(365.25 * 3) = sqrt(1095.75)', () => {
    const x = [0.01, -0.02, 0.03, 0.005];
    const mean = x.reduce((a, b) => a + b, 0) / 4;
    const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / 3);
    expect(objective(x)).toBeCloseTo(mean / sd, 15);
    expect(ANNUALISATION).toBe(Math.sqrt(1095.75));
    expect(annualise(1)).toBe(Math.sqrt(1095.75));
    expect(annualise(0.1)).toBe(0.1 * Math.sqrt(1095.75));
  });

  it('selectCell takes the argmax and gives ties to the lowest index', () => {
    expect(selectCell([0, 0.2, 0.1, 0.2, -1, 0, 0, 0, 0, 0, 0, 0.2])).toBe(1);
    expect(selectCell([0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3])).toBe(0);
    expect(selectCell([-3, -2, -1, -0.5, -4, -4, -4, -4, -4, -4, -4, -0.5])).toBe(3);
    expect(() => selectCell([0, 0.1, NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow(/finite/);
    expect(() => selectCell([0, 0.1])).toThrow(/12/);
  });
});

describe('runCells (header STEP 1, AMENDMENT 1, addendum rules 2, 3 and 9)', () => {
  const base = planted(200, 11);

  it('cell 11 equals rvV1NetTakerReturns bitwise on planted, iid and garch panels (addendum 2)', () => {
    for (const p of [planted(400, 3), iid(400, 4), syntheticPanel({ bars: 400, symbols: 10, mode: 'garch', strength: 0, seed: 5 })]) {
      const res = runCells(p);
      expect(res.firstStep).toBe(FIRST_SIGNAL_BAR);
      expect(res.lastStep).toBe(398);
      expect(res.runs[11].returns).toEqual(rvV1NetTakerReturns(p));
      expect(res.objectives[11]).toBe(perPeriodSharpe(rvV1NetTakerReturns(p)));
      expect(res.runs.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(res.objectives.map((o, i) => o === perPeriodSharpe(res.runs[i].returns))).toEqual(Array(12).fill(true));
    }
  });

  it('reads carry from fundLast and charges fundSum, as the reference does, when a bar holds two settlements', () => {
    // three symbols on a 4h funding grid: the bar's sum holds an earlier settlement the carry input must not see
    const twoPerBar = clone(planted(400, 6), (p) => {
      for (const s of [2, 5, 8]) p.fundSum[s] = p.fundSum[s].map((x, k) => x + 0.0003 * Math.cos(k * (s + 1)));
    });
    expect(twoPerBar.fundSum[2]).not.toEqual(twoPerBar.fundLast[2]);
    expect(runCells(twoPerBar).runs[11].returns).toEqual(rvV1NetTakerReturns(twoPerBar));
  });

  it('the first signal is at bar 42 and step 0 carries only entry friction (AMENDMENT 1, agy minor)', () => {
    const res = runCells(base, { detail: true });
    expect(FIRST_SIGNAL_BAR).toBe(42);
    for (const run of res.runs) {
      const d = run.detail!;
      expect(d.funding[0]).toBe(0);
      expect(d.price[0]).toBe(0);
      expect(d.cost[0]).toBeGreaterThan(0);
      expect(run.returns[0]).toBeCloseTo(-d.cost[0], 14);
      // from flat every target is a full entry: cost = sum |w| (slippage + fee at the slipped price), gross 1
      const entry = (1 + SLIP) * FEE + SLIP;
      expect(d.cost[0]).toBeGreaterThan(entry * (1 - 1e-9) * (1 - 2 * SLIP));
      expect(d.cost[0]).toBeLessThan(entry * (1 + 1e-9));
    }
  });

  it('every cell\'s targets equal direct rvFactors, rvComposite and rvTargets calls with that cell\'s weights and config', () => {
    const res = runCells(base, { trace: true });
    for (let c = 0; c < 12; c++) {
      const ref = referenceBook(base, () => c, 42, 198);
      const trace = res.runs[c].trace!;
      expect(trace.targets).toEqual(ref.map((s) => s.targets));
      expect(res.runs[c].returns).toEqual(ref.map((s, i) => s.equityAfter / (i === 0 ? RV_V1.startingEquity : ref[i - 1].equityAfter) - 1));
    }
  });

  it('is causal: on a panel cut after bar n the targets and returns equal the full run\'s first n - 43, for every cell', () => {
    const full = runCells(base, { trace: true });
    for (const n of [60, 120, 199]) {
      const cut = runCells(truncate(base, n), { trace: true });
      for (let c = 0; c < 12; c++) {
        expect(cut.runs[c].returns).toEqual(full.runs[c].returns.slice(0, n - 43));
        expect(cut.runs[c].trace!.targets).toEqual(full.runs[c].trace!.targets.slice(0, n - 43));
      }
    }
  });

  it('charges bar k\'s funding in the step that fills at open k + 1 and nothing earlier, for every cell', () => {
    const k = 100;
    const full = runCells(base);
    // a different bump per symbol: a dollar-neutral cell re-sizes every leg each step, so a uniform bump nets to zero
    const bumped = runCells(clone(base, (p) => p.fundSum.forEach((row, s) => (row[k] += 0.001 * (s + 1)))));
    for (let c = 0; c < 12; c++) expect(firstDiff(bumped.runs[c].returns, full.runs[c].returns)).toBe(k - 42);
  });

  it('fills and marks at open k + 1: its open moves step k, its close, high and low do not, for every cell', () => {
    const k = 100;
    const full = runCells(base);
    const byOpen = runCells(clone(base, (p) => p.open.forEach((row) => (row[k + 1] *= 1.01))));
    const byRest = runCells(
      clone(base, (p) => {
        p.close.forEach((row) => (row[k + 1] *= 1.01));
        p.high.forEach((row) => (row[k + 1] *= 1.02));
        p.low.forEach((row) => (row[k + 1] *= 0.98));
      })
    );
    for (let c = 0; c < 12; c++) {
      expect(firstDiff(byOpen.runs[c].returns, full.runs[c].returns)).toBe(k - 42);
      const d = firstDiff(byRest.runs[c].returns, full.runs[c].returns);
      expect(d === -1 || d > k - 42).toBe(true);
    }
  });

  it('matches a hand computation of every step of cells 0, 6 and 11 (price open k to k + 1, bar k funding, costs at open k + 1)', () => {
    const res = runCells(base, { trace: true });
    for (const c of [0, 6, 11]) {
      const run = res.runs[c];
      const tr = run.trace!;
      let eqPrev: number = RV_V1.startingEquity;
      let heldLegs = 0;
      for (let j = 0; j < run.returns.length; j++) {
        const k = 42 + j;
        let equity = eqPrev;
        for (const [sym, pos] of Object.entries(tr.before[j].positions)) {
          const s = base.symbols.indexOf(sym);
          expect(pos.lastMark).toBe(base.open[s][k]);
          equity += pos.qty * (base.open[s][k + 1] - base.open[s][k]);
          equity -= pos.qty * base.open[s][k] * base.fundSum[s][k];
          heldLegs++;
        }
        for (const sym of base.symbols) {
          const s = base.symbols.indexOf(sym);
          const delta = (tr.after[j].positions[sym]?.qty ?? 0) - (tr.before[j].positions[sym]?.qty ?? 0);
          if (Math.abs(delta) <= 1e-12) continue;
          const ref = base.open[s][k + 1];
          equity -= Math.abs(delta) * ref * SLIP + Math.abs(delta) * ref * (1 + Math.sign(delta) * SLIP) * FEE;
        }
        expect(Math.abs(run.returns[j] - (equity / eqPrev - 1))).toBeLessThan(1e-10);
        eqPrev = equity;
      }
      expect(heldLegs).toBeGreaterThan(4 * 100);
    }
  });

  it('decomposes each return into funding, price and cost (addendum 9)', () => {
    const res = runCells(base, { detail: true, trace: true });
    for (const c of [2, 11]) {
      const run = res.runs[c];
      const d = run.detail!;
      const tr = run.trace!;
      for (let j = 0; j < run.returns.length; j++) {
        const k = 42 + j;
        const eqPrev = j === 0 ? RV_V1.startingEquity : tr.equityAfter[j - 1];
        expect(tr.equityAfter[j] / eqPrev - 1).toBe(run.returns[j]);
        expect(Math.abs(d.funding[j] + d.price[j] - d.cost[j] - run.returns[j])).toBeLessThan(1e-14);
        let funding = 0;
        let price = 0;
        for (const [sym, pos] of Object.entries(tr.before[j].positions)) {
          const s = base.symbols.indexOf(sym);
          funding -= pos.qty * base.open[s][k] * base.fundSum[s][k];
          price += pos.qty * (base.open[s][k + 1] - base.open[s][k]);
        }
        expect(d.funding[j]).toBeCloseTo(funding / eqPrev, 14);
        expect(d.price[j]).toBeCloseTo(price / eqPrev, 13);
        expect(d.cost[j]).toBeGreaterThanOrEqual(0);
        expect(d.turnover[j]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('charges stressed costs when given (1.5x fees, 2x slippage), and only costs change', () => {
    const plain = runCells(base, { detail: true });
    const costs = { ...RV_V1.costs, takerFee: RV_V1.costs.takerFee * 1.5, takerSlippageBps: RV_V1.costs.takerSlippageBps * 2 };
    const stressed = runCells(base, { detail: true, costs });
    expect(stressed.runs[11].detail!.cost[0]).toBeGreaterThan(plain.runs[11].detail!.cost[0] * 1.6);
    expect(stressed.objectives[11]).toBeLessThan(plain.objectives[11]);
  });

  it('runs the maker track on the first-hour bars with the engine\'s fill model (addendum rule 10)', () => {
    const through: FirstHourBars = {
      open: base.open.map((r) => [...r]),
      high: base.open.map((r) => r.map((o) => o * 1.003)),
      low: base.open.map((r) => r.map((o) => o * 0.997)),
      close: base.open.map((r) => r.map((o) => o * 1.001)),
    };
    const flat: FirstHourBars = { open: through.open, high: through.open, low: through.open, close: through.close };
    for (const [bars, makerOnly] of [
      [through, true],
      [flat, false],
    ] as const) {
      const res = runCells(base, { cells: [11, 4], maker: bars, detail: true });
      for (const run of res.runs) {
        const ref = referenceBook(base, () => run.index, 42, 198, bars);
        expect(run.returns).toEqual(ref.map((x, i) => x.equityAfter / (i === 0 ? RV_V1.startingEquity : ref[i - 1].equityAfter) - 1));
        const d = run.detail!;
        expect(makerOnly ? d.fallbackFills : d.makerFills).toBe(0);
        expect(makerOnly ? d.makerFills : d.fallbackFills).toBeGreaterThan(100);
      }
    }
    // a maker fill at the open pays the maker fee and no slippage
    const entry = runCells(base, { cells: [11], maker: through, detail: true }).runs[0].detail!.cost[0];
    expect(entry).toBeCloseTo(RV_V1.costs.makerFee, 12);
  });

  it('throws on a skipped symbol (BTCUSDT, a held symbol, or any other) instead of ranking without it (addendum 3)', () => {
    // BTC: the engine's own btc_missing
    expect(() => runCells(clone(base, (p) => (p.fundLast[0][120] = null)))).toThrow(/BTCUSDT/);
    // a symbol cell 11 holds at bar 120
    const res = runCells(base, { trace: true });
    const held = Object.keys(res.runs[11].trace!.after[120 - 42].positions);
    expect(held.length).toBe(4);
    const heldSym = held.find((s) => s !== 'BTCUSDT')!;
    const hs = base.symbols.indexOf(heldSym);
    expect(() => runCells(clone(base, (p) => (p.fundLast[hs][121] = null)))).toThrow(new RegExp(`${heldSym}[\\s\\S]*skipped|skipped[\\s\\S]*${heldSym}`));
    // a symbol nobody holds: still a throw, never a silent ranking of nine
    const unheld = base.symbols.findIndex((s) => res.runs.every((r) => !(s in (r.trace!.after[121 - 42].positions ?? {}))) && s !== 'BTCUSDT');
    if (unheld >= 0) expect(() => runCells(clone(base, (p) => (p.fundLast[unheld][122] = null)))).toThrow(/skipped/);
    expect(() => runCells(clone(base, (p) => (p.tbv[3][130] = p.volume[3][130] * 2)))).toThrow(/skipped/);
  });

  it('refuses a panel whose bars are not contiguous', () => {
    expect(() => runCells({ ...base, t: base.t.map((t, i) => (i >= 60 ? t + H8 : t)) })).toThrow(/contiguous/);
  });
});

describe('walk-forward geometry (header STEP 3, AMENDMENT 2)', () => {
  it('pins the header values: training 1,095 bars, test and step 273, step 4 start index 1,094', () => {
    expect(RV_WF_GEOMETRY).toEqual({ train: 1095, test: 273 });
  });

  it('lays out rolling folds and keeps only complete 273-bar test folds', () => {
    // the real panel: 2022-01-01 00:00 to 2026-10-13 08:00 is 5,240 bars, returns run to step 5,238
    const { folds, remainder } = foldsOf(5240, RV_WF_GEOMETRY);
    expect(folds).toHaveLength(15);
    expect(folds[0]).toEqual({ f: 1, trainFrom: 0, trainTo: 1094, testFrom: 1095, testTo: 1367 });
    expect(folds[1]).toEqual({ f: 2, trainFrom: 273, trainTo: 1367, testFrom: 1368, testTo: 1640 });
    expect(folds[14].testTo).toBe(1095 + 15 * 273 - 1);
    expect(remainder).toBe(5238 - folds[14].testTo);
    expect(remainder).toBe(49);
    // a fold ending exactly on the last realisable step is complete, one bar less is not
    expect(foldsOf(1096 + 273, RV_WF_GEOMETRY).folds).toHaveLength(1);
    expect(foldsOf(1096 + 273, RV_WF_GEOMETRY).remainder).toBe(0);
    expect(foldsOf(1096 + 272, RV_WF_GEOMETRY).folds).toHaveLength(0);
    expect(foldsOf(1096 + 2 * 273 - 1, RV_WF_GEOMETRY).folds).toHaveLength(1);
  });

  it('trains on steps with a signal whose returns are realised inside the window, and the purge drops the last', () => {
    const [f1, f2] = foldsOf(5240, RV_WF_GEOMETRY).folds;
    // window 1 = bars 0..1,094: the first signal is at 42 and step 1,093 is the last return ending at open 1,094
    expect(trainingSteps(f1, 42, 0)).toEqual([42, 1093]);
    expect(trainingSteps(f2, 42, 0)).toEqual([273, 1366]);
    expect(trainingSteps(f1, 42, 1)).toEqual([42, 1092]);
    expect(trainingSteps(f2, 42, 1)).toEqual([273, 1365]);
  });
});

describe('walkForward (header STEP 3, AMENDMENT 2, addendum rules 4 and 5)', () => {
  // 2 complete folds at the header geometry, a 58-bar remainder dropped
  const wfPanel = planted(1700, 21);
  let wf: ReturnType<typeof walkForward>;
  let cells: ReturnType<typeof runCells>;
  beforeAll(() => {
    wf = walkForward(wfPanel, RV_WF_GEOMETRY, { detail: true });
    cells = runCells(wfPanel);
  });

  it('selects each fold\'s cell from the slice of each cell\'s continuous run inside its training window', () => {
    expect(wf.folds).toHaveLength(2);
    for (const fold of wf.folds) {
      const [a, b] = trainingSteps(fold, 42, 0);
      const want = cells.runs.map((r) => perPeriodSharpe(r.returns.slice(a - 42, b - 42 + 1)));
      expect(fold.objectives).toEqual(want);
      expect(fold.cell).toBe(selectCell(want));
    }
    expect(wf.returns).toHaveLength(2 * 273);
    expect(wf.firstStep).toBe(1095);
    expect(wf.objective).toBe(perPeriodSharpe(wf.returns));
  });

  it('a fold\'s training objectives and selection ignore every bar after its window (no lookahead)', () => {
    for (const [f, after] of [
      [0, 1095],
      [1, 1368],
    ] as const) {
      const changed = clone(wfPanel, (p) => {
        for (let s = 0; s < 10; s++) {
          for (let i = after; i < p.t.length; i++) {
            const m = 1 + 0.03 * Math.sin(i * (s + 1));
            p.open[s][i] *= m;
            p.high[s][i] *= m * 1.01;
            p.low[s][i] *= m * 0.99;
            p.close[s][i] *= m;
            p.fundSum[s][i] = -p.fundSum[s][i];
            p.fundLast[s][i] = -(p.fundLast[s][i] as number);
            p.tbv[s][i] = p.volume[s][i] - p.tbv[s][i];
          }
        }
      });
      const w2 = walkForward(changed, RV_WF_GEOMETRY);
      for (let g = 0; g <= f; g++) {
        expect(w2.folds[g].objectives).toEqual(wf.folds[g].objectives);
        expect(w2.folds[g].cell).toBe(wf.folds[g].cell);
      }
    }
    // the check has teeth: the open of the window's last bar moves fold 1's objectives
    const inside = walkForward(clone(wfPanel, (p) => p.open.forEach((row) => (row[1094] *= 1.02))), RV_WF_GEOMETRY);
    expect(inside.folds[0].objectives).not.toEqual(wf.folds[0].objectives);
  });

  it('the book opens flat, signals first at the close of 1,094 and fills at open 1,095, and the first return runs from open 1,095', () => {
    const cellsByFold = [3, 11];
    const book = runWalkForwardBook(prepareSteps(wfPanel), wf.folds, cellsByFold, RV_WF_GEOMETRY, { trace: true });
    const tr = book.trace!;
    expect(tr.firstStep).toBe(1094);
    expect(tr.before[0]).toEqual(rvInitialState());
    // every target of the first signal is a full entry at open 1,095
    for (const [sym, w] of Object.entries(tr.targets[0])) {
      const s = wfPanel.symbols.indexOf(sym);
      expect(tr.after[0].positions[sym].qty).toBeCloseTo((w * RV_V1.startingEquity) / wfPanel.open[s][1095], 9);
      expect(tr.after[0].positions[sym].lastMark).toBe(wfPanel.open[s][1095]);
    }
    // the entry costs land on the first out-of-sample return, measured against the starting equity
    expect(book.returns[0]).toBe(tr.equityAfter[1] / RV_V1.startingEquity - 1);
  });

  it('the stitched series equals an independent replay: cell f from the first signal inside fold f, positions carried', () => {
    const prep = prepareSteps(wfPanel);
    const cellsByFold = [3, 11];
    const book = runWalkForwardBook(prep, wf.folds, cellsByFold, RV_WF_GEOMETRY, { trace: true });
    const schedule = (k: number) => (k < 1368 ? 3 : 11);
    const ref = referenceBook(wfPanel, schedule, 1094, 1640);
    const eq = ref.map((s) => s.equityAfter);
    const want = [eq[1] / RV_V1.startingEquity - 1, ...eq.slice(2).map((e, i) => e / eq[i + 1] - 1)];
    expect(book.returns).toEqual(want);
    expect(book.returns).toHaveLength(546);
    // positions carry across the fold boundary: the state entering the fold's first step is the one leaving the last
    const j = 1368 - 1094;
    expect(book.trace!.before[j]).toEqual(book.trace!.after[j - 1]);
    expect(Object.keys(book.trace!.before[j].positions)).toHaveLength(4);
    // the new cell's rebalance is the trade of the fold's first step, inside its first return
    expect(book.trace!.targets[j]).toEqual(ref[j].targets);
    // continuity: the stitched series compounds to the book's final equity
    const compounded = book.returns.reduce((e, r) => e * (1 + r), RV_V1.startingEquity as number);
    expect(compounded / eq[eq.length - 1]).toBeCloseTo(1, 12);
  });

  it('the stitched series equals concatenated per-fold runs from the carried state', () => {
    const prep = prepareSteps(wfPanel);
    const book = runWalkForwardBook(prep, wf.folds, [5, 8], RV_WF_GEOMETRY, { trace: true });
    const ref1 = referenceBook(wfPanel, () => 5, 1094, 1367);
    // fold 2 from the state fold 1 left, replayed with cell 8
    const refBoth = referenceBook(wfPanel, (k) => (k < 1368 ? 5 : 8), 1094, 1640);
    expect(refBoth.slice(0, ref1.length).map((s) => s.equityAfter)).toEqual(ref1.map((s) => s.equityAfter));
    const fold1 = book.returns.slice(0, 273);
    const fold2 = book.returns.slice(273);
    const eq = refBoth.map((s) => s.equityAfter);
    expect(fold1).toEqual([eq[1] / RV_V1.startingEquity - 1, ...eq.slice(2, 274).map((e, i) => e / eq[i + 1] - 1)]);
    expect(fold2).toEqual(eq.slice(274).map((e, i) => e / eq[273 + i] - 1));
  });

  it('walkForward runs its book with the cells it selected', () => {
    const book = runWalkForwardBook(prepareSteps(wfPanel), wf.folds, wf.folds.map((f) => f.cell), RV_WF_GEOMETRY);
    expect(book.returns).toEqual(wf.returns);
  });

  it('the purge sensitivity re-selects without the last realised training return', () => {
    const purged = walkForward(wfPanel, RV_WF_GEOMETRY, { purge: 1 });
    for (const [i, fold] of purged.folds.entries()) {
      const [a, b] = trainingSteps(wf.folds[i], 42, 1);
      expect(fold.objectives).toEqual(cells.runs.map((r) => perPeriodSharpe(r.returns.slice(a - 42, b - 42 + 1))));
    }
  });

  it('decomposes the stitched series (addendum 9)', () => {
    const d = wf.detail!;
    for (let j = 0; j < wf.returns.length; j++) expect(Math.abs(d.funding[j] + d.price[j] - d.cost[j] - wf.returns[j])).toBeLessThan(1e-14);
    expect(d.price[0]).not.toBe(0); // the first return holds the bar 1,095 move
  });

  it('refuses steps or cell runs from another panel, a partial cell family, and irregular folds', () => {
    const other = planted(1700, 22);
    expect(() => walkForward(wfPanel, RV_WF_GEOMETRY, { prepared: prepareSteps(other) })).toThrow(/another panel/);
    const prep = prepareSteps(wfPanel);
    expect(() => walkForward(wfPanel, RV_WF_GEOMETRY, { prepared: prep, cells: runCells(wfPanel, { prepared: prep, cells: [11, 4] }) })).toThrow(/12 cells/);
    const shuffled = runCells(wfPanel, { prepared: prep });
    shuffled.runs.reverse();
    expect(() => walkForward(wfPanel, RV_WF_GEOMETRY, { prepared: prep, cells: shuffled })).toThrow(/12 cells/);
    const folds = foldsOf(1700, RV_WF_GEOMETRY).folds;
    expect(() => runWalkForwardBook(prep, [folds[0], { ...folds[1], testFrom: folds[1].testFrom + 1 }], [1, 2], RV_WF_GEOMETRY)).toThrow(/fold 2/);
  });

  it('refuses a panel too short for one complete fold', () => {
    expect(() => walkForward(planted(1300, 2), RV_WF_GEOMETRY)).toThrow(/complete/);
  });
});

describe('pValue (header STEP 2: p = (1 + #{null >= real}) / (M + 1))', () => {
  it('counts ties as at least as extreme', () => {
    expect(pValue(1, [1, 1, 0.5])).toBe(3 / 4);
    expect(pValue(1, [0.1, 0.2, 0.3, 0.4])).toBe(1 / 5);
    expect(pValue(0.5, [0.6, 0.7])).toBe(1);
    expect(pValue(0.3, Array(99).fill(0.3))).toBe(1);
    expect(pValue(0.3, [...Array(98).fill(0), 0.3])).toBe(2 / 100);
  });

  it('refuses a non-finite statistic or an empty null', () => {
    expect(() => pValue(NaN, [1])).toThrow(/finite/);
    expect(() => pValue(1, [1, NaN])).toThrow(/finite/);
    expect(() => pValue(1, [])).toThrow(/empty/);
  });
});

describe('null machinery (header STEPS 2 and 4)', () => {
  const small = { train: 100, test: 25 };
  const panel = planted(200, 41);

  it('the walk-forward null calls the permutation exactly M times, from start index train - 1', () => {
    const spy = vi.mocked(permuteModule.permutePanel);
    spy.mockClear();
    const lines = wfShard(panel, 1, 5, RV_SEEDS.wf, small);
    expect(spy).toHaveBeenCalledTimes(5);
    for (const call of spy.mock.calls) expect(call[1]).toBe(99);
    expect(lines.map((l) => l.m)).toEqual([1, 2, 3, 4, 5]);
    expect(lines.map((l) => l.seed)).toEqual([1, 2, 3, 4, 5].map((m) => RV_BASE_SEED + 100_000 + m));
    spy.mockClear();
    insampleShard(panel, 1, 3, RV_SEEDS.is);
    expect(spy).toHaveBeenCalledTimes(3);
    for (const call of spy.mock.calls) expect(call[1]).toBe(0);
  });

  it('the header walk-forward null permutes from bar 1,095 (start index 1,094)', () => {
    const spy = vi.mocked(permuteModule.permutePanel);
    spy.mockClear();
    wfShard(planted(1400, 9), 1, 1, RV_SEEDS.wf, RV_WF_GEOMETRY);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(1094);
  });

  it('each line is the permuted panel\'s statistic: the best of 12 cells in step 2, the stitched objective in step 4', () => {
    const [line] = insampleShard(panel, 7, 7, RV_SEEDS.is);
    const permuted = permuteModule.permutePanel(panel, 0, createSeededRandom(RV_BASE_SEED + 7));
    const res = runCells(permuted);
    expect(line.perCell).toEqual(res.objectives);
    expect(line.best).toBe(Math.max(...res.objectives));
    const [wl] = wfShard(panel, 7, 7, RV_SEEDS.wf, small);
    const w = walkForward(permuteModule.permutePanel(panel, 99, createSeededRandom(RV_BASE_SEED + 100_007)), small);
    expect(wl.best).toBe(w.objective);
    expect(wl.cells).toEqual(w.folds.map((f) => f.cell));
    const [bl] = blockShard(panel, 7, 7, RV_SEEDS.block);
    const blocked = runCells(permutePanelBlocks(panel, 0, createSeededRandom(RV_BASE_SEED + 300_007), 9));
    expect(bl.perCell).toEqual(blocked.objectives);
    expect(bl.best).toBe(Math.max(...blocked.objectives));
  });

  it('the null has spread: sd > 0 with at least 20 distinct values over 25 permutations', () => {
    for (const lines of [insampleShard(panel, 1, 25, RV_SEEDS.is), wfShard(panel, 1, 25, RV_SEEDS.wf, small)]) {
      const xs = lines.map((l) => l.best);
      expect(new Set(xs).size).toBeGreaterThanOrEqual(20);
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      expect(xs.reduce((a, b) => a + (b - mean) ** 2, 0)).toBeGreaterThan(0);
    }
  });

  it('two seed bases give different nulls, and two shards together equal one unsharded run', () => {
    const a = insampleShard(panel, 1, 6, RV_SEEDS.is).map((l) => l.best);
    const b = insampleShard(panel, 1, 6, (m) => RV_SEEDS.is(m) + 7).map((l) => l.best);
    expect(b).not.toEqual(a);
    expect([...insampleShard(panel, 1, 3, RV_SEEDS.is), ...insampleShard(panel, 4, 6, RV_SEEDS.is)]).toEqual(insampleShard(panel, 1, 6, RV_SEEDS.is));
    expect([...wfShard(panel, 1, 2, RV_SEEDS.wf, small), ...wfShard(panel, 3, 4, RV_SEEDS.wf, small)]).toEqual(wfShard(panel, 1, 4, RV_SEEDS.wf, small));
    expect([...blockShard(panel, 1, 2, RV_SEEDS.block), ...blockShard(panel, 3, 4, RV_SEEDS.block)]).toEqual(blockShard(panel, 1, 4, RV_SEEDS.block));
  });

  it('each shard runner refuses seeds that collide after the >>> 0 reduction (addendum rule 6)', () => {
    expect(() => insampleShard(panel, 1, 2, () => 5)).toThrow(/distinct/);
    expect(() => wfShard(panel, 1, 2, (m) => 5 + (m - 1) * 2 ** 32, small)).toThrow(/distinct/);
    expect(() => blockShard(panel, 1, 2, () => 5)).toThrow(/distinct/);
  });

  it('refuses an empty or inverted shard range', () => {
    expect(() => insampleShard(panel, 3, 2, RV_SEEDS.is)).toThrow(/range/);
    expect(() => insampleShard(panel, 0, 2, RV_SEEDS.is)).toThrow(/range/);
  });
});

describe('permutePanelBlocks (header REPORTED: block sensitivity, block length 9 bars)', () => {
  it('moves blocks of 9 consecutive bars as units, the last partial block included, both indices drawn as blocks', () => {
    const { perm1, perm2 } = drawBlockPermutation(40, 9, createSeededRandom(5));
    for (const perm of [perm1, perm2]) {
      expect([...perm].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
      // split the output into runs of consecutive source indices: each run is one whole source block
      const starts = [0];
      for (let i = 1; i < 40; i++) if (perm[i] !== perm[i - 1] + 1 || perm[i] % 9 === 0) starts.push(i);
      const runs = starts.map((s, j) => perm.slice(s, starts[j + 1] ?? 40));
      expect(runs).toHaveLength(5);
      for (const run of runs) {
        expect(run[0] % 9).toBe(0);
        expect(run.length).toBe(run[0] === 36 ? 4 : 9);
      }
    }
    expect(perm1).not.toEqual(perm2);
    expect(perm1).not.toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('applies one block mapping to every symbol, keeps bars up to startIndex and the final close', () => {
    const p = planted(120, 8);
    const marked = clone(p, (q) => q.volume.forEach((row) => row.forEach((_, i) => (row[i] = 1000 + i))));
    const out = permutePanelBlocks(marked, 10, createSeededRandom(3), 9);
    for (let s = 0; s < 10; s++) {
      expect(out.volume[s]).toEqual(out.volume[0]);
      for (let i = 0; i <= 10; i++) {
        expect(out.open[s][i]).toBe(marked.open[s][i]);
        expect(out.close[s][i]).toBe(marked.close[s][i]);
      }
      expect(out.close[s][119] / marked.close[s][119]).toBeCloseTo(1, 9);
    }
    const src = out.volume[0].slice(11).map((v) => v - 1000 - 11);
    // within a block the source bars stay in order
    let inOrder = 0;
    for (let i = 1; i < src.length; i++) if (src[i] === src[i - 1] + 1) inOrder++;
    expect(inOrder).toBeGreaterThanOrEqual(src.length - Math.ceil(src.length / 9) - 1);
    expect(permutePanelBlocks(marked, 10, createSeededRandom(3), 9)).toEqual(out);
    expect(BLOCK_LEN).toBe(9);
  });
});

describe('seeds (header SEEDS, AMENDMENT 1)', () => {
  it('follows the header rule for every stage', () => {
    expect(RV_BASE_SEED).toBe(20261014);
    expect(RV_SEEDS.is(1)).toBe(20261015);
    expect(RV_SEEDS.wf(1)).toBe(20361015);
    expect(RV_SEEDS.block(1)).toBe(20561015);
    expect(RV_SEEDS.desk).toBe(20661014);
    expect(RV_SEEDS.iid(1)).toBe(20461015);
    expect(RV_SEEDS.planted(1)).toBe(20471015);
    expect(RV_SEEDS.garch(1)).toBe(20481015);
    expect(RV_SEEDS.inner(20471015, 7)).toBe(20471015 * 10_000 + 7);
    // not in the header: the carry-only universe (AMENDMENT 2) takes the next free block, base + 230,000 + k
    expect(RV_SEEDS.carry(1)).toBe(20491015);
    expect([IS_M, WF_M, BLOCK_M]).toEqual([1000, 1000, 1000]);
  });

  it('asserts the seeds a stage uses are distinct after the >>> 0 reduction createSeededRandom applies', () => {
    expect(() => assertDistinctSeeds({ a: [1, 2, 3] })).not.toThrow();
    expect(() => assertDistinctSeeds({ a: [1, 2, 2] })).toThrow(/distinct/);
    expect(() => assertDistinctSeeds({ a: [5], b: [5 + 2 ** 32] })).toThrow(/distinct/);
    expect(() => assertDistinctSeeds({ a: [7 * 2 ** 32 + 11, 11] })).toThrow(/distinct/);
    expect(() => assertDistinctSeeds({ a: [1.5] })).toThrow(/integer/);
    // the real study's ranges and every calibration range, as the header fixes them
    expect(() => assertDistinctSeeds(realStudySeedGroups())).not.toThrow();
    expect(() => assertDistinctSeeds(calibrationSeedGroups())).not.toThrow();
    const groups = calibrationSeedGroups();
    expect(groups['iid inner']).toHaveLength(100 * 99);
    expect(groups['planted inner']).toHaveLength(10 * 199);
    expect(Object.values(realStudySeedGroups()).flat()).toHaveLength(3001);
  });
});
