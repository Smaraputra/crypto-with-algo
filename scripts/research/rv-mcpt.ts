/**
 * Masters' four steps for the rv-v1 re-validation (header STEPS 1 to 4 in scripts/research/rv-revalidation.ts,
 * with AMENDMENTS 1 to 3 and the Task 7B controller rulings).
 *
 * - STEP 1, in-sample excellence: runCells runs the 12 cells on the full span. Factor inputs are computed once
 *   per panel (prepareSteps), and every cell calls the shared engine (rvComposite, rvTargets, rvStep), so cell 11
 *   reproduces rvV1NetTakerReturns bitwise.
 * - STEP 2, in-sample permutation: insampleShard permutes from bar 1 (startIndex 0) and records the best of the
 *   12 cells per permutation.
 * - STEP 3, walk-forward: walkForward selects a cell per fold from each cell's continuous full-panel run sliced to
 *   the fold's training window, then runs a separate book with the selected cells (runWalkForwardBook).
 * - STEP 4, walk-forward permutation: wfShard permutes from bar train (startIndex train - 1) and re-runs the whole
 *   walk-forward per permutation.
 *
 * Return convention (AMENDMENT 1): step k is the signal at the close of bar k, filled at the open of bar k + 1.
 * Its return is equity after step k over equity after step k - 1, minus 1: the move of the legs held from open k
 * to open k + 1, bar k's funding, and the costs of the trade at open k + 1. The first step is measured against
 * the starting equity, so it carries only the entry costs.
 *
 * Walk-forward book (AMENDMENT 2, addendum rule 5): it opens flat. Its first signal is at the close of bar
 * train - 1 (1,094) with fold 1's cell, filled at open train (1,095). Every later signal at bar k uses the cell
 * of the fold that holds bar k, so a newly selected cell first trades at the close of its fold's first bar and
 * the cost of that rebalance lands in the fold's first return. The out-of-sample series starts with bar train:
 * its first return is equity after step train over the starting equity, which also holds the entry costs at
 * open train. Positions carry across fold boundaries. Only complete test folds are evaluated.
 */
import {
  RV_V1,
  rvComposite,
  rvFactors,
  rvInitialState,
  rvStep,
  rvTargets,
  type RvCell,
  type RvConfig,
  type RvFactorRow,
  type RvFillBar,
  type RvSettlement,
  type RvSymbolInput,
  type RvTrackState,
  type RvWeights,
} from '@/lib/signals/cross-sectional/engine';
import { perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import type { FirstHourBars, RvPanel } from './rv-panel';
import { applyBarPermutation, permutationIndex, permutePanel } from './rv-permute';
import { ANNUALISATION, type SyntheticMode } from './rv-synthetic';

const BAR_MS = RV_V1.barMs;

// ------------------------------------------------------------------------------------------------ seeds

/** Header SEEDS: the base seed of every random stream in the study. */
export const RV_BASE_SEED = 20261014;

/** Header STEP 2, STEP 4 and REPORTED: M = 1,000 each, block length 9 bars. */
export const IS_M = 1000;
export const WF_M = 1000;
export const BLOCK_M = 1000;
export const BLOCK_LEN = 9;

/**
 * Header SEEDS. The carry-only universe is not in the header (AMENDMENT 2 adds the universe without seeds) and
 * takes the next free block of the header's pattern, base + 230,000 + k.
 */
export const RV_SEEDS = {
  is: (m: number) => RV_BASE_SEED + m,
  wf: (m: number) => RV_BASE_SEED + 100_000 + m,
  block: (m: number) => RV_BASE_SEED + 300_000 + m,
  desk: RV_BASE_SEED + 400_000,
  iid: (k: number) => RV_BASE_SEED + 200_000 + k,
  planted: (k: number) => RV_BASE_SEED + 210_000 + k,
  garch: (k: number) => RV_BASE_SEED + 220_000 + k,
  carry: (k: number) => RV_BASE_SEED + 230_000 + k,
  /** Inner permutation m of calibration universe seed s (exceeds 2^32, see assertDistinctSeeds). */
  inner: (s: number, m: number) => s * 10_000 + m,
} as const;

/**
 * AMENDMENT 1: createSeededRandom reduces a seed with `>>> 0` (modulo 2^32), so two different seeds can drive the
 * same stream. Throws unless every seed in every group is an integer and all of them are distinct after that
 * reduction, within and across the groups.
 */
export function assertDistinctSeeds(groups: Record<string, readonly number[]>): void {
  const seen = new Map<number, string>();
  for (const [name, seeds] of Object.entries(groups)) {
    for (const seed of seeds) {
      if (!Number.isSafeInteger(seed)) throw new Error(`seed ${seed} in ${name} is not a safe integer`);
      const reduced = seed >>> 0;
      const other = seen.get(reduced);
      if (other !== undefined) {
        throw new Error(`seeds are not distinct after the >>> 0 reduction: ${seed} in ${name} and ${other} both reduce to ${reduced}`);
      }
      seen.set(reduced, `${seed} in ${name}`);
    }
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Every seed the real study uses: steps 2 and 4, the block sensitivity and the desk bootstrap. */
export function realStudySeedGroups(): Record<string, number[]> {
  return {
    'is-mcpt': range(1, IS_M).map(RV_SEEDS.is),
    'wf-mcpt': range(1, WF_M).map(RV_SEEDS.wf),
    block: range(1, BLOCK_M).map(RV_SEEDS.block),
    desk: [RV_SEEDS.desk],
  };
}

/** Header CALIBRATION: each universe kind, its seed rule, count, mode, strength and M (see CALIBRATION_UNIVERSES). */
export type UniverseKind = 'iid' | 'planted' | 'garch' | 'carry';

export interface UniverseSpec {
  kind: UniverseKind;
  count: number;
  seed: (k: number) => number;
  mode: SyntheticMode;
  strength: number;
  /** Permutations per universe in each of steps 2 and 4. */
  M: number;
  gate: boolean;
}

/**
 * Header CALIBRATION ACCEPTANCE. iid: 100 seeds at M = 99 (gate). planted: 10 seeds at M = 199 (gate). GARCH:
 * 10 seeds, reported, at M = 99 (the header gives no M, and 99 is the driftless universes' M). carry-only
 * (AMENDMENT 2): 10 seeds, reported, at M = 199 (the planted universes' M).
 */
export const CALIBRATION_UNIVERSES: Record<UniverseKind, UniverseSpec> = {
  iid: { kind: 'iid', count: 100, seed: RV_SEEDS.iid, mode: 'iid', strength: 0, M: 99, gate: true },
  planted: { kind: 'planted', count: 10, seed: RV_SEEDS.planted, mode: 'planted', strength: 1, M: 199, gate: true },
  garch: { kind: 'garch', count: 10, seed: RV_SEEDS.garch, mode: 'garch', strength: 0, M: 99, gate: false },
  carry: { kind: 'carry', count: 10, seed: RV_SEEDS.carry, mode: 'carry', strength: 1, M: 199, gate: false },
};

/** Synthetic panels of the calibration: 10 symbols and 3,000 8h bars (header CALIBRATION). */
export const CALIBRATION_BARS = 3000;

/**
 * Every seed one calibration step uses: the universe seeds and their inner permutation seeds. The header gives
 * steps 2 and 4 the same inner seeds s * 10,000 + m, so this one set is the range of each step.
 */
export function calibrationSeedGroups(): Record<string, number[]> {
  const groups: Record<string, number[]> = {};
  for (const u of Object.values(CALIBRATION_UNIVERSES)) {
    const seeds = range(1, u.count).map(u.seed);
    groups[`${u.kind} universe`] = seeds;
    groups[`${u.kind} inner`] = seeds.flatMap((s) => range(1, u.M).map((m) => RV_SEEDS.inner(s, m)));
  }
  return groups;
}

// ------------------------------------------------------------------------------------------------ cells

export interface RvCellSpec {
  index: number;
  buffer: number;
  betaNeutral: boolean;
  flowOn: boolean;
  weights: RvWeights;
  cell: RvCell;
}

const FLOW_OFF: RvWeights = { mom: 0.4, idio: 0.3, carry: 0.3, flow: 0 };
const FLOW_ON: RvWeights = { mom: 0.3, idio: 0.25, carry: 0.3, flow: 0.15 };

/** Header CELLS: index = 4 * buffer + 2 * betaNeutral + flowOn. */
export const RV_CELLS: readonly RvCellSpec[] = Array.from({ length: 12 }, (_, index) => {
  const buffer = Math.floor(index / 4);
  const betaNeutral = Math.floor(index / 2) % 2 === 1;
  const flowOn = index % 2 === 1;
  return {
    index,
    buffer,
    betaNeutral,
    flowOn,
    weights: flowOn ? FLOW_ON : FLOW_OFF,
    cell: { legs: RV_V1.legs, buffer, betaNeutral, autoClampBuffer: RV_V1.autoClampBuffer },
  };
});

/** rv-v1 is cell 11 (buffer 2, betaNeutral true, flow on). */
export const RV_V1_CELL_INDEX = 11;

/** AMENDMENT 1: the first signal is at the close of bar 42, the first full 43-close window. */
export const FIRST_SIGNAL_BAR = RV_V1.flowBars - 1;

// ------------------------------------------------------------------------------------------------ objective

/** Header OBJECTIVE: per-bar net Sharpe, mean over sample sd (perPeriodSharpe, 0 when the sd is 0). */
export function objective(returns: readonly number[]): number {
  return perPeriodSharpe(returns as number[]);
}

/** Reported only: a per-bar Sharpe annualised with sqrt(365.25 * 3). */
export function annualise(perBar: number): number {
  return perBar * ANNUALISATION;
}

/** Argmax over the 12 cells, ties to the lowest index (header CELLS). */
export function selectCell(objectives: readonly number[]): number {
  if (objectives.length !== RV_CELLS.length) throw new Error(`selectCell needs 12 objectives, got ${objectives.length}`);
  let best = 0;
  for (let i = 0; i < objectives.length; i++) {
    if (!Number.isFinite(objectives[i])) throw new Error(`objective of cell ${i} is not finite: ${objectives[i]}`);
    if (objectives[i] > objectives[best]) best = i;
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ steps

/** The per-step engine inputs every cell shares, computed once per panel. Index i is step firstStep + i. */
export interface PreparedSteps {
  panel: RvPanel;
  firstStep: number;
  lastStep: number;
  rows: RvFactorRow[][];
  betas: Map<string, number>[];
  fillTime: number[];
  fillBars: Record<string, RvFillBar>[];
  settlements: Record<string, RvSettlement[]>[];
}

/**
 * Factor inputs per signal bar k = 42..n - 2, exactly as rvV1TakerSteps builds them: bars k - 42..k, the carry
 * input fundLast of bar k stamped at bar k's close, and one synthetic settlement { bar close, fundSum of bar k,
 * markPrice null } per symbol (so funding is charged at the previous fill price, addendum rule 9). The fill bar of
 * step k is panel bar k + 1. Throws on any skipped symbol: a panel that builds has none (AMENDMENT 3) and a
 * permutation only moves existing values, so a skip means a defect, never a ranking of fewer symbols.
 */
export function prepareSteps(panel: RvPanel): PreparedSteps {
  const n = panel.t.length;
  for (let k = 1; k < n; k++) {
    if (panel.t[k] - panel.t[k - 1] !== BAR_MS) throw new Error(`The panel is not contiguous at bar ${k}`);
  }
  const window = RV_V1.flowBars;
  const firstStep = window - 1;
  const lastStep = n - 2;
  if (lastStep < firstStep) throw new Error(`The panel has ${n} bars, fewer than the ${window + 1} one step needs`);

  const bars = panel.symbols.map((_, s) =>
    panel.t.map((openTime, j) => ({ openTime, close: panel.close[s][j], volume: panel.volume[s][j], takerBuyVolume: panel.tbv[s][j] }))
  );
  const prep: PreparedSteps = { panel, firstStep, lastStep, rows: [], betas: [], fillTime: [], fillBars: [], settlements: [] };
  for (let k = firstStep; k <= lastStep; k++) {
    const barClose = panel.t[k] + BAR_MS;
    const inputs: RvSymbolInput[] = panel.symbols.map((symbol, s) => {
      const rate = panel.fundLast[s][k];
      return {
        symbol,
        bars: bars[s].slice(k - window + 1, k + 1),
        lastSettlement: rate === null ? null : { fundingTime: barClose, rate, markPrice: null },
      };
    });
    const factors = rvFactors(inputs, panel.t[k]);
    if (factors.skipped.length > 0) {
      const listed = factors.skipped.map((x) => `${x.symbol} (${x.reason})`).join(', ');
      throw new Error(`HALT: the engine skipped ${listed} at bar ${k} (${new Date(panel.t[k]).toISOString()}): runCells never ranks a partial universe`);
    }
    const fillBars: Record<string, RvFillBar> = {};
    const settlements: Record<string, RvSettlement[]> = {};
    panel.symbols.forEach((symbol, s) => {
      fillBars[symbol] = { open: panel.open[s][k + 1], high: panel.high[s][k + 1], low: panel.low[s][k + 1], close: panel.close[s][k + 1] };
      settlements[symbol] = [{ fundingTime: barClose, rate: panel.fundSum[s][k], markPrice: null }];
    });
    prep.rows.push(factors.rows);
    prep.betas.push(new Map(factors.rows.map((r) => [r.symbol, r.beta])));
    prep.fillTime.push(barClose);
    prep.fillBars.push(fillBars);
    prep.settlements.push(settlements);
  }
  return prep;
}

export interface BookOptions {
  /** Cost override (the combined stress run). The engine's RV_V1 costs otherwise. */
  costs?: RvConfig['costs'];
  /** Maker track with the first-hour fill bars (real data only, reported). Taker otherwise. */
  maker?: FirstHourBars;
  /** Per-step funding, price and cost components and turnover. */
  detail?: boolean;
  /** Per-step targets and states (tests). */
  trace?: boolean;
}

/** Per-step components as fractions of the equity the step's return is measured against. */
export interface StepDetail {
  /** Funding received (negative when paid). */
  funding: number[];
  /** Mark-to-market of the legs held into the step, open k to open k + 1. */
  price: number[];
  /** Fees plus the fill price's distance from the bar open (slippage, or a maker fallback's drift). */
  cost: number[];
  /** Traded notional at the bar open over the equity before trading. */
  turnover: number[];
  /** Maker track only: fills filled as maker and fills that fell back to taker. */
  makerFills?: number;
  fallbackFills?: number;
}

export interface StepTrace {
  firstStep: number;
  targets: Record<string, number>[];
  before: RvTrackState[];
  after: RvTrackState[];
  equityAfter: number[];
}

/** One book over steps from..to (amounts in currency, used by runCells and the walk-forward book). */
interface BookPass {
  equityAfter: number[];
  funding: number[];
  price: number[];
  cost: number[];
  traded: number[];
  equityBefore: number[];
  makerFills: number;
  fallbackFills: number;
  trace?: StepTrace;
}

function runBookPass(prep: PreparedSteps, schedule: (k: number) => number, from: number, to: number, opts: BookOptions): BookPass {
  if (from < prep.firstStep || to > prep.lastStep || from > to) {
    throw new Error(`book steps ${from}..${to} lie outside the prepared steps ${prep.firstStep}..${prep.lastStep}`);
  }
  const cfg: RvConfig = opts.costs ? { ...RV_V1, costs: opts.costs } : RV_V1;
  const track = opts.maker ? 'maker' : 'taker';
  const symbols = prep.panel.symbols;
  let state = rvInitialState(cfg);
  let prevFillTime: number | null = null;
  const pass: BookPass = { equityAfter: [], funding: [], price: [], cost: [], traded: [], equityBefore: [], makerFills: 0, fallbackFills: 0 };
  if (opts.trace) pass.trace = { firstStep: from, targets: [], before: [], after: [], equityAfter: [] };

  for (let k = from; k <= to; k++) {
    const i = k - prep.firstStep;
    const spec = RV_CELLS[schedule(k)];
    if (!spec) throw new Error(`no cell ${schedule(k)} at step ${k}`);
    const ranked = rvComposite(prep.rows[i], spec.weights);
    const held = new Map<string, 1 | -1>();
    for (const [symbol, p] of Object.entries(state.positions)) if (p.qty !== 0) held.set(symbol, p.qty > 0 ? 1 : -1);
    const targets = Object.fromEntries(rvTargets(ranked, held, prep.betas[i], spec.cell));

    let fillBars = prep.fillBars[i];
    if (opts.maker) {
      const m = opts.maker;
      fillBars = {};
      symbols.forEach((symbol, s) => {
        fillBars[symbol] = { open: m.open[s][k + 1], high: m.high[s][k + 1], low: m.low[s][k + 1], close: m.close[s][k + 1] };
      });
    }
    const { state: next, record } = rvStep(
      state,
      { track, prevFillTime, fillTime: prep.fillTime[i], fillBars, settlements: prep.settlements[i], targets },
      cfg
    );
    if (record.stale.length > 0 || record.skippedEntries.length > 0 || record.halted !== null) {
      throw new Error(`HALT: step ${k} could not trade cleanly (stale ${record.stale.join(',')}, skipped ${record.skippedEntries.join(',')}, halted ${record.halted})`);
    }

    pass.equityAfter.push(record.equityAfter);
    if (opts.detail) {
      let price = 0;
      for (const [symbol, p] of Object.entries(state.positions)) price += p.qty * (fillBars[symbol].open - p.lastMark);
      let cost = 0;
      let traded = 0;
      for (const f of record.fills) {
        const ref = fillBars[f.symbol].open;
        cost += f.fee + f.deltaQty * (f.price - ref);
        traded += Math.abs(f.deltaQty) * ref;
        if (f.kind === 'maker') pass.makerFills++;
        if (f.kind === 'taker_fallback') pass.fallbackFills++;
      }
      pass.funding.push(record.funding.reduce((a, x) => a + x.amount, 0));
      pass.price.push(price);
      pass.cost.push(cost);
      pass.traded.push(traded);
      pass.equityBefore.push(record.equityBefore);
    }
    if (pass.trace) {
      pass.trace.targets.push(targets);
      pass.trace.before.push(state);
      pass.trace.after.push(next);
      pass.trace.equityAfter.push(record.equityAfter);
    }
    state = next;
    prevFillTime = prep.fillTime[i];
  }
  return pass;
}

/**
 * Returns and components of a pass's steps j0..end (indices into the pass), each measured against the equity
 * after the step before. The first is measured against `base`: the starting equity, or for the walk-forward book
 * the equity before its entry step, so step j0 also carries the entry step's costs (`entryStep`).
 */
function seriesOf(pass: BookPass, j0: number, base: number, entryStep: number | null, detail: boolean): { returns: number[]; detail?: StepDetail } {
  const returns: number[] = [];
  const out: StepDetail = { funding: [], price: [], cost: [], turnover: [] };
  for (let j = j0; j < pass.equityAfter.length; j++) {
    const prev = j === j0 ? base : pass.equityAfter[j - 1];
    returns.push(pass.equityAfter[j] / prev - 1);
    if (detail) {
      const extra = j === j0 && entryStep !== null ? entryStep : null;
      out.funding.push((pass.funding[j] + (extra === null ? 0 : pass.funding[extra])) / prev);
      out.price.push((pass.price[j] + (extra === null ? 0 : pass.price[extra])) / prev);
      out.cost.push((pass.cost[j] + (extra === null ? 0 : pass.cost[extra])) / prev);
      out.turnover.push(pass.traded[j] / pass.equityBefore[j] + (extra === null ? 0 : pass.traded[extra] / pass.equityBefore[extra]));
    }
  }
  if (detail) {
    out.makerFills = pass.makerFills;
    out.fallbackFills = pass.fallbackFills;
  }
  return detail ? { returns, detail: out } : { returns };
}

export interface CellRun {
  index: number;
  /** Return of step firstStep + i (AMENDMENT 1). */
  returns: number[];
  detail?: StepDetail;
  trace?: StepTrace;
}

export interface CellsResult {
  firstStep: number;
  lastStep: number;
  runs: CellRun[];
  objectives: number[];
}

export interface RunCellsOptions extends BookOptions {
  /** Steps prepared by prepareSteps for this very panel, to avoid computing the factors twice. */
  prepared?: PreparedSteps;
  /** The cells to run (all 12 when absent, the header's family). */
  cells?: readonly number[];
}

/**
 * Header STEP 1: each cell as one continuous book from the first signal (bar 42) to the second-last bar, taker
 * track unless `maker` is given. Returns per-cell per-step net returns and the objective of each.
 */
export function runCells(panel: RvPanel, opts: RunCellsOptions = {}): CellsResult {
  const prep = opts.prepared ?? prepareSteps(panel);
  if (prep.panel !== panel) throw new Error('the prepared steps belong to another panel');
  const indices = opts.cells ?? RV_CELLS.map((c) => c.index);
  const runs = indices.map((index) => {
    const pass = runBookPass(prep, () => index, prep.firstStep, prep.lastStep, opts);
    const { returns, detail } = seriesOf(pass, 0, RV_V1.startingEquity, null, opts.detail === true);
    const run: CellRun = { index, returns };
    if (detail) run.detail = detail;
    if (pass.trace) run.trace = pass.trace;
    return run;
  });
  return { firstStep: prep.firstStep, lastStep: prep.lastStep, runs, objectives: runs.map((r) => objective(r.returns)) };
}

// ------------------------------------------------------------------------------------------------ walk-forward

export interface WfGeometry {
  /** Rolling training window in bars. The step 4 permutation starts at index train - 1. */
  train: number;
  /** Test fold length, which is also the step. */
  test: number;
}

/** Header STEP 3: training 1,095 bars, test and step 273 bars. */
export const RV_WF_GEOMETRY: WfGeometry = { train: 1095, test: 273 };

export interface Fold {
  f: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
}

/**
 * Rolling folds over an n-bar panel: fold f trains on bars (f - 1) * test .. + train - 1 and tests on the next
 * `test` bars. A test bar needs a realised return (an open after it), so the last usable step is n - 2. Only
 * complete folds are kept, and `remainder` counts the trailing steps dropped.
 */
export function foldsOf(n: number, g: WfGeometry): { folds: Fold[]; remainder: number } {
  if (!Number.isInteger(g.train) || !Number.isInteger(g.test) || g.test < 1 || g.train <= FIRST_SIGNAL_BAR + 1) {
    throw new Error(`invalid walk-forward geometry ${JSON.stringify(g)}`);
  }
  const lastStep = n - 2;
  const count = Math.max(0, Math.floor((lastStep - g.train + 1) / g.test));
  const folds: Fold[] = [];
  for (let f = 1; f <= count; f++) {
    const trainFrom = (f - 1) * g.test;
    const trainTo = trainFrom + g.train - 1;
    folds.push({ f, trainFrom, trainTo, testFrom: trainTo + 1, testTo: trainTo + g.test });
  }
  const covered = count > 0 ? folds[count - 1].testTo : g.train - 1;
  return { folds, remainder: Math.max(0, lastStep - covered) };
}

/**
 * The steps whose returns train fold f: a signal exists (from firstStep) and the return is realised inside the
 * window, from the window's first open to its last open, so step trainTo (which ends at the test fold's first
 * open) is excluded. `purge` drops that many more steps from the end (the 1-bar purge sensitivity).
 */
export function trainingSteps(fold: Fold, firstStep: number, purge: number): [number, number] {
  if (!Number.isInteger(purge) || purge < 0) throw new Error(`purge must be a non-negative integer, got ${purge}`);
  return [Math.max(fold.trainFrom, firstStep), fold.trainTo - 1 - purge];
}

export interface WfFold extends Fold {
  objectives: number[];
  cell: number;
}

export interface WfBook {
  /** The out-of-sample series, one return per test bar of the complete folds. */
  returns: number[];
  /** First out-of-sample step: the first test bar. */
  firstStep: number;
  detail?: StepDetail;
  trace?: StepTrace;
}

/**
 * The walk-forward book with fold f trading `cells[f - 1]` (addendum rule 5). Opens flat, first signal at the
 * close of bar train - 1 with fold 1's cell, then each signal at bar k with the cell of the fold holding bar k.
 * Hysteresis follows the book's own held legs.
 */
export function runWalkForwardBook(prep: PreparedSteps, folds: readonly Fold[], cells: readonly number[], g: WfGeometry, opts: BookOptions = {}): WfBook {
  if (folds.length === 0) throw new Error('the walk-forward has no complete test fold');
  if (cells.length !== folds.length) throw new Error(`${folds.length} folds but ${cells.length} cells`);
  const first = folds[0].testFrom;
  if (first !== g.train) throw new Error(`fold 1 must test from bar ${g.train}, got ${first}`);
  folds.forEach((fold, i) => {
    if (fold.testFrom !== first + i * g.test || fold.testTo !== fold.testFrom + g.test - 1) {
      throw new Error(`fold ${i + 1} must test bars ${first + i * g.test}..${first + (i + 1) * g.test - 1}, got ${fold.testFrom}..${fold.testTo}`);
    }
  });
  const from = first - 1;
  const to = folds[folds.length - 1].testTo;
  const schedule = (k: number) => (k < first ? cells[0] : cells[Math.floor((k - first) / g.test)]);
  const pass = runBookPass(prep, schedule, from, to, opts);
  const { returns, detail } = seriesOf(pass, 1, RV_V1.startingEquity, 0, opts.detail === true);
  const book: WfBook = { returns, firstStep: first };
  if (detail) book.detail = detail;
  if (pass.trace) book.trace = pass.trace;
  return book;
}

export interface WfResult {
  geometry: WfGeometry;
  folds: WfFold[];
  remainder: number;
  purge: number;
  firstStep: number;
  returns: number[];
  objective: number;
  detail?: StepDetail;
}

export interface WalkForwardOptions {
  /** The 1-bar purge sensitivity (reported only) drops the last realised training return: 1. Primary: 0. */
  purge?: number;
  detail?: boolean;
  prepared?: PreparedSteps;
  cells?: CellsResult;
}

/**
 * Header STEP 3: per fold, each cell's objective over its training steps of its continuous full-panel run, the
 * argmax (ties to the lowest index), then the book over the complete test folds. The stitched objective is the
 * result.
 */
export function walkForward(panel: RvPanel, g: WfGeometry, opts: WalkForwardOptions = {}): WfResult {
  const { folds, remainder } = foldsOf(panel.t.length, g);
  if (folds.length === 0) throw new Error(`the panel of ${panel.t.length} bars holds no complete test fold for ${JSON.stringify(g)}`);
  const prep = opts.prepared ?? prepareSteps(panel);
  if (prep.panel !== panel) throw new Error('the prepared steps belong to another panel');
  const cells = opts.cells ?? runCells(panel, { prepared: prep });
  if (cells.runs.length !== RV_CELLS.length || cells.runs.some((r, i) => r.index !== i) || cells.firstStep !== prep.firstStep) {
    throw new Error('walkForward selects among the 12 cells: the cell runs must be all 12 in index order from this panel');
  }
  const purge = opts.purge ?? 0;
  const selected: WfFold[] = folds.map((fold) => {
    const [a, b] = trainingSteps(fold, cells.firstStep, purge);
    const objectives = cells.runs.map((r) => objective(r.returns.slice(a - cells.firstStep, b - cells.firstStep + 1)));
    return { ...fold, objectives, cell: selectCell(objectives) };
  });
  const book = runWalkForwardBook(
    prep,
    folds,
    selected.map((f) => f.cell),
    g,
    { detail: opts.detail }
  );
  const result: WfResult = { geometry: g, folds: selected, remainder, purge, firstStep: book.firstStep, returns: book.returns, objective: objective(book.returns) };
  if (book.detail) result.detail = book.detail;
  return result;
}

// ------------------------------------------------------------------------------------------------ p-values

/** Header STEP 2: p = (1 + #{null >= real}) / (M + 1), ties counted as at least as extreme. */
export function pValue(real: number, nulls: readonly number[]): number {
  if (!Number.isFinite(real)) throw new Error(`the real statistic is not finite: ${real}`);
  if (nulls.length === 0) throw new Error('the null is empty');
  let atLeast = 0;
  for (const x of nulls) {
    if (!Number.isFinite(x)) throw new Error(`a null statistic is not finite: ${x}`);
    if (x >= real) atLeast++;
  }
  return (1 + atLeast) / (nulls.length + 1);
}

// ------------------------------------------------------------------------------------------------ block permutation

/** A permutation of 0..permN - 1 that moves blocks of `blockLen` consecutive positions as units (the last may be short). */
function blockIndex(permN: number, blockLen: number, random: () => number): number[] {
  const nBlocks = Math.ceil(permN / blockLen);
  const order = permutationIndex(nBlocks, random);
  const out: number[] = [];
  for (const b of order) for (let i = b * blockLen; i < Math.min((b + 1) * blockLen, permN); i++) out.push(i);
  return out;
}

/** Both shared indices at block level, drawn in bar_permute's order: intrabar (perm1) first, gap (perm2) second. */
export function drawBlockPermutation(permN: number, blockLen: number, random: () => number): { perm1: number[]; perm2: number[] } {
  if (!Number.isInteger(blockLen) || blockLen < 1) throw new Error(`blockLen must be a positive integer, got ${blockLen}`);
  const perm1 = blockIndex(permN, blockLen, random);
  const perm2 = blockIndex(permN, blockLen, random);
  return { perm1, perm2 };
}

/**
 * Header REPORTED block sensitivity: the step 2 scheme with blocks of `blockLen` bars moved as units. Both indices
 * are block permutations shared by every symbol, applied with 7A's applyBarPermutation.
 */
export function permutePanelBlocks(panel: RvPanel, startIndex: number, random: () => number, blockLen: number): RvPanel {
  const n = panel.t.length;
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= n) {
    throw new Error(`startIndex must be an integer in [0, ${n - 1}], got ${startIndex}`);
  }
  const { perm1, perm2 } = drawBlockPermutation(n - startIndex - 1, blockLen, random);
  return applyBarPermutation(panel, startIndex, perm1, perm2);
}

// ------------------------------------------------------------------------------------------------ nulls

/** One null permutation: its index m, the seed it used, the statistic and per-cell or per-fold detail. */
export interface NullLine {
  m: number;
  seed: number;
  best: number;
  perCell?: number[];
  cells?: number[];
}

function runNull(
  mFrom: number,
  mTo: number,
  seedOf: (m: number) => number,
  permute: (random: () => number) => RvPanel,
  statistic: (p: RvPanel) => Omit<NullLine, 'm' | 'seed'>
): NullLine[] {
  if (!Number.isInteger(mFrom) || !Number.isInteger(mTo) || mFrom < 1 || mTo < mFrom) {
    throw new Error(`invalid permutation range ${mFrom}..${mTo}`);
  }
  const ms = range(mFrom, mTo);
  const seeds = ms.map(seedOf);
  assertDistinctSeeds({ shard: seeds });
  return ms.map((m, i) => ({ m, seed: seeds[i], ...statistic(permute(createSeededRandom(seeds[i]))) }));
}

const bestOfCells = (p: RvPanel) => {
  const res = runCells(p);
  return { best: Math.max(...res.objectives), perCell: res.objectives };
};

/** Header STEP 2: permutations mFrom..mTo of the whole panel from bar 1, each the best of the 12 cells. */
export function insampleShard(panel: RvPanel, mFrom: number, mTo: number, seedOf: (m: number) => number): NullLine[] {
  return runNull(mFrom, mTo, seedOf, (random) => permutePanel(panel, 0, random), bestOfCells);
}

/** Header STEP 4: bars 0..train - 1 stay real, then the whole walk-forward per permutation, its stitched objective. */
export function wfShard(panel: RvPanel, mFrom: number, mTo: number, seedOf: (m: number) => number, g: WfGeometry): NullLine[] {
  return runNull(
    mFrom,
    mTo,
    seedOf,
    (random) => permutePanel(panel, g.train - 1, random),
    (p) => {
      const wf = walkForward(p, g);
      return { best: wf.objective, cells: wf.folds.map((f) => f.cell) };
    }
  );
}

/** Header REPORTED block sensitivity of step 2: blocks of BLOCK_LEN bars, the best of the 12 cells. */
export function blockShard(panel: RvPanel, mFrom: number, mTo: number, seedOf: (m: number) => number): NullLine[] {
  return runNull(mFrom, mTo, seedOf, (random) => permutePanelBlocks(panel, 0, random, BLOCK_LEN), bestOfCells);
}
