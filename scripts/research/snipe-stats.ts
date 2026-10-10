/**
 * Snipe phase statistics (pure, no I/O). Implements the TRADE AND LABEL, STATISTIC, NULL, DISCOVERY,
 * CONFIRMATION and REPORTED sections of snipe.ts over the per-(symbol, timeframe) arrays of snipe-matrix.ts.
 *
 * Design notes (recorded at build time, before any discovery run):
 * - Common random numbers: ONE shift offset per draw is shared by every symbol AND every cell of a timeframe
 *   and slice (nullOffsets is called once per slice context). Draws are therefore comparable across cells.
 * - The null is evaluated on the common grid only. For offset k the flag at grid position p moves to
 *   (p + k) mod G; entry, exit, y and b stay at their grid positions. Per-cell flagged positions are held as a
 *   sorted Int32Array per symbol, and a draw walks the wrapped part (p >= G - k, landing in [0, k)) before the
 *   rest (landing in [k, G)), so the blocking walk sees positions in ascending order without any sort.
 * - A draw allocates nothing: it reads typed arrays and returns a number.
 * - The grid holds the bars that are in-slice for every symbol given. A cell's flags are read through a
 *   per-symbol grid-to-bar index, so no per-column copy of the flags is made.
 * - The normal CDF is reused from src/lib/stats/normal.ts; the PRNG is seededRandom from carry-sim.ts.
 * - Baseline b is computed for every in-slice bar whose stratum has at least one resolved bar, from all
 *   in-slice resolved bars of that stratum (no blocking, flagged or not). A stratum without a resolved bar
 *   gives NaN, which can only attach to unresolved bars.
 * - Direction: the sign of obsAll (0 when NaN). A fixed direction (confirmation) overrides it. The empirical
 *   p, the consistency sign and the direction win rate all follow the direction. With direction 0 the
 *   empirical p is NaN and consistency fails.
 * - A cell is a trial with p = 1 when skipped, without resolved trades, or with a non-finite two-sided p.
 * - Day-block bootstrap resamples the days that carry at least one resolved taken trade, D days drawn with
 *   replacement per resample, and uses a fresh seededRandom(SNIPE_BOOTSTRAP.seed) per call, so every cell's
 *   interval reproduces independently of the order the cells are evaluated in.
 */

import { normalCdf } from '@/lib/stats/normal';
import { seededRandom } from './carry-sim';
import {
  SNIPE_BOOTSTRAP,
  SNIPE_CONFIRM_ALPHA,
  SNIPE_CONSISTENCY,
  SNIPE_FDR_Q,
  SNIPE_FEES,
  SNIPE_MAX_CONFIRM,
  SNIPE_NULL_SD_INFLATION,
  SNIPE_TIE_SKIP_FACTOR,
  SNIPE_TAIL_LEVELS,
  type SnipeLevel,
  type SnipeTail,
  type SnipeTimeframe,
} from './snipe';
import { OUTCOME_DOWN, OUTCOME_UP, OUTCOME_TIMEOUT, OUTCOME_AMBIGUOUS } from './snipe-labels';
import type { SnipeSymbolArrays } from './snipe-matrix';
import { TAIL_BOTTOM_1, TAIL_BOTTOM_10, TAIL_ELIGIBLE, TAIL_TOP_1, TAIL_TOP_10 } from './snipe-tails';

const DAY_MS = 86_400_000;

export interface SnipeSlice {
  startMs: number;
  endMs: number;
}

export interface SnipeCell {
  column: string;
  tail: SnipeTail;
  level: SnipeLevel;
  timeframe: SnipeTimeframe;
}

/** The flag bit of a cell. */
export function cellBit(cell: Pick<SnipeCell, 'tail' | 'level'>): number {
  if (cell.level === 'snipe') return cell.tail === 'top' ? TAIL_TOP_1 : TAIL_BOTTOM_1;
  return cell.tail === 'top' ? TAIL_TOP_10 : TAIL_BOTTOM_10;
}

export function nominalShare(level: SnipeLevel): number {
  return SNIPE_TAIL_LEVELS[level];
}

// ---------------------------------------------------------------------------------------------------------
// Slice view and baseline
// ---------------------------------------------------------------------------------------------------------

export interface SliceView {
  arrays: SnipeSymbolArrays;
  /** In-slice bar indices, ascending (time order). */
  idx: Int32Array;
  /** Baseline long win rate per bar index (full length); NaN outside the slice or in an unresolved stratum. */
  b: Float64Array;
}

/**
 * A bar i is in the slice iff startMs <= timestamps[i] <= endMs, outcome[i] !== 0,
 * entryMs[i] + maxHoldMs - 1 <= endMs and atrQuintile[i] >= 0. The baseline is per ATR quintile stratum of this
 * symbol over the whole slice (AMENDMENT 1, A1-1: no calendar month, a month baseline absorbs the flagged move):
 * #up / (#up + #down) over the in-slice bars of the stratum.
 */
export function sliceView(arrays: SnipeSymbolArrays, slice: SnipeSlice, maxHoldMs: number): SliceView {
  const n = arrays.timestamps.length;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = arrays.timestamps[i];
    if (t < slice.startMs || t > slice.endMs) continue;
    if (arrays.outcome[i] === 0) continue;
    if (arrays.entryMs[i] + maxHoldMs - 1 > slice.endMs) continue;
    if (arrays.atrQuintile[i] < 0) continue;
    keep.push(i);
  }
  const idx = Int32Array.from(keep);
  const strata = new Map<number, number>();
  const up: number[] = [];
  const down: number[] = [];
  const stratumOf = new Int32Array(idx.length);
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const key = arrays.atrQuintile[i];
    let s = strata.get(key);
    if (s === undefined) {
      s = up.length;
      strata.set(key, s);
      up.push(0);
      down.push(0);
    }
    stratumOf[j] = s;
    if (arrays.outcome[i] === OUTCOME_UP) up[s]++;
    else if (arrays.outcome[i] === OUTCOME_DOWN) down[s]++;
  }
  const b = new Float64Array(n).fill(Number.NaN);
  for (let j = 0; j < idx.length; j++) {
    const s = stratumOf[j];
    const d = up[s] + down[s];
    if (d > 0) b[idx[j]] = up[s] / d;
  }
  return { arrays, idx, b };
}

// ---------------------------------------------------------------------------------------------------------
// Taken trades (blocking walk over all in-slice bars)
// ---------------------------------------------------------------------------------------------------------

export interface TakenTrades {
  /** Index into the views array. */
  symbol: Int32Array;
  /** Bar index into that symbol's arrays. */
  bar: Int32Array;
  /** 1 up, 0 down, -1 unresolved (timeout or ambiguous). */
  y: Int8Array;
  b: Float64Array;
  taken: number;
  resolved: number;
  timeouts: number;
  ambiguous: number;
}

function columnIndex(arrays: SnipeSymbolArrays, column: string): number {
  const c = arrays.columns.indexOf(column);
  if (c < 0) throw new Error(`snipe-stats: unknown column ${column}`);
  return c;
}

/** Per symbol: take bar i when entryMs[i] >= nextFree, then nextFree = exitMs[i]. */
export function takenTrades(views: SliceView[], column: string, bit: number): TakenTrades {
  const sym: number[] = [];
  const bar: number[] = [];
  const y: number[] = [];
  const bs: number[] = [];
  let resolved = 0;
  let timeouts = 0;
  let ambiguous = 0;
  for (let s = 0; s < views.length; s++) {
    const v = views[s];
    const a = v.arrays;
    const flags = a.flags[columnIndex(a, column)];
    let nextFree = -Infinity;
    for (let j = 0; j < v.idx.length; j++) {
      const i = v.idx[j];
      if ((flags[i] & bit) === 0) continue;
      if (a.entryMs[i] < nextFree) continue;
      nextFree = a.exitMs[i];
      const o = a.outcome[i];
      sym.push(s);
      bar.push(i);
      bs.push(v.b[i]);
      if (o === OUTCOME_UP) {
        y.push(1);
        resolved++;
      } else if (o === OUTCOME_DOWN) {
        y.push(0);
        resolved++;
      } else {
        y.push(-1);
        if (o === OUTCOME_TIMEOUT) timeouts++;
        else if (o === OUTCOME_AMBIGUOUS) ambiguous++;
      }
    }
  }
  return {
    symbol: Int32Array.from(sym),
    bar: Int32Array.from(bar),
    y: Int8Array.from(y),
    b: Float64Array.from(bs),
    taken: sym.length,
    resolved,
    timeouts,
    ambiguous,
  };
}

/** Mean of (y - b) over resolved taken trades, NaN when there is none. */
export function excessOf(t: TakenTrades): number {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < t.taken; k++) {
    if (t.y[k] < 0) continue;
    sum += t.y[k] - t.b[k];
    n++;
  }
  return n === 0 ? Number.NaN : sum / n;
}

// ---------------------------------------------------------------------------------------------------------
// Common grid
// ---------------------------------------------------------------------------------------------------------

export interface GridSymbol {
  /** Grid position to bar index in the symbol's arrays. */
  barIdx: Int32Array;
  entryMs: Float64Array;
  exitMs: Float64Array;
  /** 1 up, 0 down, -1 unresolved. */
  y: Int8Array;
  b: Float64Array;
  /** In-slice bars of this symbol that are not on the grid. */
  lostBars: number;
}

export interface CommonGrid {
  G: number;
  timestamps: Float64Array;
  symbols: GridSymbol[];
}

export function buildCommonGrid(views: SliceView[]): CommonGrid {
  if (views.length === 0) return { G: 0, timestamps: new Float64Array(0), symbols: [] };
  let common: number[] = Array.from(views[0].idx, (i) => views[0].arrays.timestamps[i]);
  for (let s = 1; s < views.length; s++) {
    const ts = views[s].arrays.timestamps;
    const idx = views[s].idx;
    const next: number[] = [];
    let p = 0;
    for (const t of common) {
      while (p < idx.length && ts[idx[p]] < t) p++;
      if (p < idx.length && ts[idx[p]] === t) next.push(t);
    }
    common = next;
  }
  const G = common.length;
  const timestamps = Float64Array.from(common);
  const symbols: GridSymbol[] = views.map((v) => {
    const a = v.arrays;
    const barIdx = new Int32Array(G);
    const entryMs = new Float64Array(G);
    const exitMs = new Float64Array(G);
    const y = new Int8Array(G);
    const b = new Float64Array(G);
    let p = 0;
    for (let g = 0; g < G; g++) {
      while (a.timestamps[v.idx[p]] < timestamps[g]) p++;
      const i = v.idx[p];
      barIdx[g] = i;
      entryMs[g] = a.entryMs[i];
      exitMs[g] = a.exitMs[i];
      y[g] = a.outcome[i] === OUTCOME_UP ? 1 : a.outcome[i] === OUTCOME_DOWN ? 0 : -1;
      b[g] = v.b[i];
    }
    return { barIdx, entryMs, exitMs, y, b, lostBars: v.idx.length - G };
  });
  return { G, timestamps, symbols };
}

// ---------------------------------------------------------------------------------------------------------
// Null: circular shift on the common grid
// ---------------------------------------------------------------------------------------------------------

/** Per symbol, the sorted grid positions carrying the cell's flag bit. */
export type PreparedCell = Int32Array[];

export function prepareGridCell(views: SliceView[], grid: CommonGrid, column: string, bit: number): PreparedCell {
  return grid.symbols.map((gs, s) => {
    const a = views[s].arrays;
    const flags = a.flags[columnIndex(a, column)];
    let count = 0;
    for (let g = 0; g < grid.G; g++) if ((flags[gs.barIdx[g]] & bit) !== 0) count++;
    const out = new Int32Array(count);
    let c = 0;
    for (let g = 0; g < grid.G; g++) if ((flags[gs.barIdx[g]] & bit) !== 0) out[c++] = g;
    return out;
  });
}

/**
 * Excess on the grid with every flag moved to (p + k) mod G. k = 0 is the observed grid statistic.
 * Allocation-free. NaN when no resolved trade is taken.
 */
export function shiftedExcess(grid: CommonGrid, prepared: PreparedCell, k: number): number {
  const G = grid.G;
  let sum = 0;
  let n = 0;
  for (let s = 0; s < prepared.length; s++) {
    const pos = prepared[s];
    const gs = grid.symbols[s];
    const entry = gs.entryMs;
    const exit = gs.exitMs;
    const y = gs.y;
    const b = gs.b;
    const len = pos.length;
    // first index with pos >= G - k
    const limit = G - k;
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pos[mid] < limit) lo = mid + 1;
      else hi = mid;
    }
    let nextFree = -Infinity;
    for (let m = lo; m < len; m++) {
      const q = pos[m] + k - G;
      if (entry[q] < nextFree) continue;
      nextFree = exit[q];
      const yq = y[q];
      if (yq >= 0) {
        sum += yq - b[q];
        n++;
      }
    }
    for (let m = 0; m < lo; m++) {
      const q = pos[m] + k;
      if (entry[q] < nextFree) continue;
      nextFree = exit[q];
      const yq = y[q];
      if (yq >= 0) {
        sum += yq - b[q];
        n++;
      }
    }
  }
  return n === 0 ? Number.NaN : sum / n;
}

/** Integers uniform in [minShiftBars, G - minShiftBars], one per draw. */
export function nullOffsets(G: number, minShiftBars: number, draws: number, seed: number): Int32Array {
  const lo = minShiftBars;
  const hi = G - minShiftBars;
  if (hi < lo) throw new Error(`snipe-stats: grid of ${G} bars is too short for a ${minShiftBars}-bar minimum shift`);
  const random = seededRandom(seed);
  const out = new Int32Array(draws);
  for (let d = 0; d < draws; d++) out[d] = lo + Math.floor(random() * (hi - lo + 1));
  return out;
}

export function nullDraws(grid: CommonGrid, prepared: PreparedCell, offsets: ArrayLike<number>): Float64Array {
  const out = new Float64Array(offsets.length);
  for (let d = 0; d < offsets.length; d++) out[d] = shiftedExcess(grid, prepared, offsets[d]);
  return out;
}

export interface NullSummary {
  mean: number;
  sd: number;
  validDraws: number;
  nonFiniteDraws: number;
  z: number;
  pTwoSided: number;
}

/** A null sd at or below this is degenerate (A1-4): z NaN, p = 1. */
const SD_FLOOR = 1e-12;

export function summarizeNull(draws: ArrayLike<number>, obsGrid: number): NullSummary {
  let n = 0;
  let sum = 0;
  for (let d = 0; d < draws.length; d++) {
    if (Number.isFinite(draws[d])) {
      n++;
      sum += draws[d];
    }
  }
  const mean = n === 0 ? Number.NaN : sum / n;
  let ss = 0;
  for (let d = 0; d < draws.length; d++) if (Number.isFinite(draws[d])) ss += (draws[d] - mean) ** 2;
  const sd = n < 2 ? Number.NaN : Math.sqrt(ss / (n - 1));
  // AMENDMENT 1 (A1-3, A1-4): the null sd is inflated before any z is formed, and a null without spread gives p = 1.
  // Below 1e-12 the spread is floating-point noise (identical draws give about 1e-17), not a null.
  if (!(sd > SD_FLOOR)) {
    return { mean, sd, validDraws: n, nonFiniteDraws: draws.length - n, z: Number.NaN, pTwoSided: 1 };
  }
  const z = (obsGrid - mean) / (SNIPE_NULL_SD_INFLATION * sd);
  const pTwoSided = Number.isNaN(z) ? Number.NaN : 2 * normalCdf(-Math.abs(z));
  return { mean, sd, validDraws: n, nonFiniteDraws: draws.length - n, z, pTwoSided };
}

/** One-sided normal p of z in direction d: 1 - Phi(d x z). 1 when z is NaN or d is 0. */
export function pOneSided(z: number, d: 1 | -1 | 0): number {
  if (d === 0 || Number.isNaN(z)) return 1;
  return normalCdf(-d * z);
}

/**
 * (1 + #{draws with d x excess >= d x obsGrid}) / (draws.length + 1) (AMENDMENT 1, A1-8). A non-finite draw counts as
 * not at least the observed. NaN when d is 0 or obsGrid is not finite.
 */
export function empiricalP(draws: ArrayLike<number>, obsGrid: number, d: 1 | -1 | 0): number {
  if (d === 0 || !Number.isFinite(obsGrid)) return Number.NaN;
  let ge = 0;
  for (let i = 0; i < draws.length; i++) {
    if (!Number.isFinite(draws[i])) continue;
    if (d * draws[i] >= d * obsGrid) ge++;
  }
  return (1 + ge) / (draws.length + 1);
}

// ---------------------------------------------------------------------------------------------------------
// Bootstrap and consistency
// ---------------------------------------------------------------------------------------------------------

/** Type 7 percentile of an ascending-sorted array. */
export function percentile7(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Day-block bootstrap of the excess of the resolved taken trades; [2.5th, 97.5th] percentiles. */
export function bootstrapCi(
  views: SliceView[],
  trades: TakenTrades,
  resamples: number = SNIPE_BOOTSTRAP.resamples,
  seed: number = SNIPE_BOOTSTRAP.seed,
): [number, number] {
  const byDay = new Map<number, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  for (let k = 0; k < trades.taken; k++) {
    if (trades.y[k] < 0) continue;
    const day = Math.floor(views[trades.symbol[k]].arrays.timestamps[trades.bar[k]] / DAY_MS);
    let d = byDay.get(day);
    if (d === undefined) {
      d = sums.length;
      byDay.set(day, d);
      sums.push(0);
      counts.push(0);
    }
    sums[d] += trades.y[k] - trades.b[k];
    counts[d]++;
  }
  const D = sums.length;
  if (D === 0) return [Number.NaN, Number.NaN];
  const random = seededRandom(seed);
  const out = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    let c = 0;
    for (let j = 0; j < D; j++) {
      const d = Math.floor(random() * D);
      s += sums[d];
      c += counts[d];
    }
    out[r] = s / c;
  }
  out.sort();
  return [percentile7(out, 0.025), percentile7(out, 0.975)];
}

export interface ConsistencyResult {
  quarters: { kept: number; agree: number; share: number; pass: boolean };
  symbols: { kept: number; agree: number; pass: boolean };
  pass: boolean;
}

/** Consistency of the resolved taken trades with sign s (+1 long edge, -1 short edge). A zero excess never agrees. */
export function consistency(views: SliceView[], trades: TakenTrades, sign: number): ConsistencyResult {
  const q = new Map<number, [number, number]>();
  const sy = new Map<number, [number, number]>();
  for (let k = 0; k < trades.taken; k++) {
    if (trades.y[k] < 0) continue;
    const e = trades.y[k] - trades.b[k];
    const quarter = Math.floor(views[trades.symbol[k]].arrays.month[trades.bar[k]] / 3);
    const a = q.get(quarter) ?? [0, 0];
    a[0] += e;
    a[1]++;
    q.set(quarter, a);
    const c = sy.get(trades.symbol[k]) ?? [0, 0];
    c[0] += e;
    c[1]++;
    sy.set(trades.symbol[k], c);
  }
  const agrees = (sum: number) => sign !== 0 && sum !== 0 && Math.sign(sum) === sign;
  let qKept = 0;
  let qAgree = 0;
  for (const [sum, n] of q.values()) {
    if (n < SNIPE_CONSISTENCY.minQuarterTrades) continue;
    qKept++;
    if (agrees(sum)) qAgree++;
  }
  const share = qKept === 0 ? Number.NaN : qAgree / qKept;
  const qPass = qKept >= SNIPE_CONSISTENCY.minQuarters && share >= SNIPE_CONSISTENCY.quarterShare;
  let sKept = 0;
  let sAgree = 0;
  for (const [sum, n] of sy.values()) {
    if (n < SNIPE_CONSISTENCY.minSymbolTrades) continue;
    sKept++;
    if (agrees(sum)) sAgree++;
  }
  const sPass = sKept >= SNIPE_CONSISTENCY.symbolsAgree && sAgree >= SNIPE_CONSISTENCY.symbolsAgree;
  return {
    quarters: { kept: qKept, agree: qAgree, share, pass: qPass },
    symbols: { kept: sKept, agree: sAgree, pass: sPass },
    pass: qPass && sPass,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Tie skip
// ---------------------------------------------------------------------------------------------------------

export function tailShare(views: SliceView[], column: string, bit: number): { share: number; flagged: number; eligible: number } {
  let flagged = 0;
  let eligible = 0;
  for (const v of views) {
    const flags = v.arrays.flags[columnIndex(v.arrays, column)];
    for (let j = 0; j < v.idx.length; j++) {
      const f = flags[v.idx[j]];
      if ((f & bit) !== 0) flagged++;
      if ((f & TAIL_ELIGIBLE) !== 0) eligible++;
    }
  }
  return { share: eligible === 0 ? Number.NaN : flagged / eligible, flagged, eligible };
}

export function isSkipped(share: number, level: SnipeLevel): boolean {
  return !(share <= SNIPE_TIE_SKIP_FACTOR * nominalShare(level));
}

// ---------------------------------------------------------------------------------------------------------
// Cell report
// ---------------------------------------------------------------------------------------------------------

export interface SliceContext {
  timeframe: SnipeTimeframe;
  views: SliceView[];
  grid: CommonGrid;
}

export function buildSliceContext(
  arraysList: SnipeSymbolArrays[],
  slice: SnipeSlice,
  timeframe: SnipeTimeframe,
  maxHoldMs: number,
): SliceContext {
  const views = arraysList.map((a) => sliceView(a, slice, maxHoldMs));
  return { timeframe, views, grid: buildCommonGrid(views) };
}

export interface CellReport {
  cell: SnipeCell;
  skipped: boolean;
  tailShare: number;
  taken: number;
  resolved: number;
  timeoutShare: number;
  ambiguousShare: number;
  /** #up / resolved (long win rate). */
  longWinRate: number;
  /** Mean baseline over resolved taken trades (long). */
  meanBaseline: number;
  obsAll: number;
  obsGrid: number;
  /** +1 long edge, -1 short edge, 0 when obsAll is NaN (or a fixed direction of 0). */
  direction: 1 | -1 | 0;
  /** Win rate and baseline of the direction (1 - long values for a short). */
  winRate: number;
  baseline: number;
  ci: [number, number];
  nullMean: number;
  nullSd: number;
  /** (obsGrid - nullMean) / (SNIPE_NULL_SD_INFLATION x nullSd); NaN without a usable null spread. */
  z: number;
  /** Two-sided normal p of z (1 without a usable null spread). */
  pTwoSided: number;
  /** One-sided normal p of z in the cell's direction (1 when z is NaN or the direction is 0). */
  zP1: number;
  /** sign(obsAll) equals sign(obsGrid - nullMean); false when either is 0 or NaN (AMENDMENT 1, A1-4). */
  directionAgrees: boolean;
  /** Empirical p in the direction. */
  empiricalP: number;
  validDraws: number;
  nonFiniteDraws: number;
  consistency: ConsistencyResult;
  meanAtrPct: number;
  medianAtrPct: number;
  makerBreakEven: number;
  takerBreakEven: number;
  lostBars: number[];
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = Float64Array.from(values).sort();
  return percentile7(s, 0.5);
}

/** sign(a) === sign(b), false when either is 0 or NaN. */
function signsAgree(a: number, b: number): boolean {
  if (!(a !== 0 && b !== 0) || Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.sign(a) === Math.sign(b);
}

const EMPTY_CONSISTENCY: ConsistencyResult = {
  quarters: { kept: 0, agree: 0, share: Number.NaN, pass: false },
  symbols: { kept: 0, agree: 0, pass: false },
  pass: false,
};

/**
 * Full report of one cell. `offsets` are the shared null offsets of the context (nullOffsets). With
 * `fixedDirection` (confirmation) the direction, empirical p and consistency sign are fixed to it.
 */
export function evaluateCell(
  ctx: SliceContext,
  cell: SnipeCell,
  offsets: ArrayLike<number>,
  fixedDirection?: 1 | -1,
): CellReport {
  const bit = cellBit(cell);
  const { views, grid } = ctx;
  const ts = tailShare(views, cell.column, bit);
  const skipped = isSkipped(ts.share, cell.level);
  const lostBars = grid.symbols.map((g) => g.lostBars);
  const trades = takenTrades(views, cell.column, bit);
  const empty: CellReport = {
    cell,
    skipped,
    tailShare: ts.share,
    taken: trades.taken,
    resolved: trades.resolved,
    timeoutShare: trades.taken === 0 ? Number.NaN : trades.timeouts / trades.taken,
    ambiguousShare: trades.taken === 0 ? Number.NaN : trades.ambiguous / trades.taken,
    longWinRate: Number.NaN,
    meanBaseline: Number.NaN,
    obsAll: Number.NaN,
    obsGrid: Number.NaN,
    direction: fixedDirection ?? 0,
    winRate: Number.NaN,
    baseline: Number.NaN,
    ci: [Number.NaN, Number.NaN],
    nullMean: Number.NaN,
    nullSd: Number.NaN,
    z: Number.NaN,
    pTwoSided: Number.NaN,
    zP1: 1,
    directionAgrees: false,
    empiricalP: Number.NaN,
    validDraws: 0,
    nonFiniteDraws: 0,
    consistency: EMPTY_CONSISTENCY,
    meanAtrPct: Number.NaN,
    medianAtrPct: Number.NaN,
    makerBreakEven: Number.NaN,
    takerBreakEven: Number.NaN,
    lostBars,
  };
  if (trades.taken === 0) return empty;

  const atr: number[] = [];
  let ups = 0;
  let bSum = 0;
  let beMaker = 0;
  let beTaker = 0;
  for (let k = 0; k < trades.taken; k++) {
    const a = views[trades.symbol[k]].arrays;
    atr.push(a.atrPct[trades.bar[k]]);
    if (trades.y[k] < 0) continue;
    ups += trades.y[k];
    bSum += trades.b[k];
    const x = a.atrPct[trades.bar[k]];
    beMaker += 0.5 + SNIPE_FEES.makerRoundTripPct / (2 * x);
    beTaker += 0.5 + SNIPE_FEES.takerRoundTripPct / (2 * x);
  }
  const r = trades.resolved;
  const meanAtrPct = atr.reduce((s, v) => s + v, 0) / atr.length;
  const base: CellReport = {
    ...empty,
    meanAtrPct,
    medianAtrPct: median(atr),
    longWinRate: r === 0 ? Number.NaN : ups / r,
    meanBaseline: r === 0 ? Number.NaN : bSum / r,
    makerBreakEven: r === 0 ? Number.NaN : beMaker / r,
    takerBreakEven: r === 0 ? Number.NaN : beTaker / r,
  };
  if (r === 0) return base;

  const obsAll = excessOf(trades);
  const direction: 1 | -1 | 0 = fixedDirection ?? (Number.isNaN(obsAll) || obsAll === 0 ? 0 : obsAll > 0 ? 1 : -1);
  const prepared = prepareGridCell(views, grid, cell.column, bit);
  const obsGrid = shiftedExcess(grid, prepared, 0);
  const draws = nullDraws(grid, prepared, offsets);
  const nul = summarizeNull(draws, obsGrid);
  return {
    ...base,
    obsAll,
    obsGrid,
    direction,
    winRate: direction === -1 ? 1 - base.longWinRate : base.longWinRate,
    baseline: direction === -1 ? 1 - base.meanBaseline : base.meanBaseline,
    ci: bootstrapCi(views, trades),
    nullMean: nul.mean,
    nullSd: nul.sd,
    z: nul.z,
    pTwoSided: nul.pTwoSided,
    zP1: pOneSided(nul.z, direction),
    directionAgrees: signsAgree(obsAll, obsGrid - nul.mean),
    empiricalP: empiricalP(draws, obsGrid, direction),
    validDraws: nul.validDraws,
    nonFiniteDraws: nul.nonFiniteDraws,
    consistency: consistency(views, trades, direction),
  };
}

// ---------------------------------------------------------------------------------------------------------
// BH, selection, confirmation
// ---------------------------------------------------------------------------------------------------------

/** Benjamini-Hochberg step-up. Non-finite p enter as 1. Returns the rejected flags in input order. */
export function benjaminiHochberg(ps: ArrayLike<number>, q: number = SNIPE_FDR_Q): boolean[] {
  const m = ps.length;
  const p = Array.from(ps, (v) => (Number.isFinite(v) ? v : 1));
  const order = p.map((_, i) => i).sort((a, b) => p[a] - p[b] || a - b);
  let cut = -1;
  for (let rank = 0; rank < m; rank++) {
    if (p[order[rank]] <= ((rank + 1) / m) * q) cut = rank;
  }
  const rejected = new Array<boolean>(m).fill(false);
  for (let rank = 0; rank <= cut; rank++) rejected[order[rank]] = true;
  return rejected;
}

/** The p that enters BH: 1 for skipped cells, cells without resolved trades, and non-finite p. */
export function bhP(c: CellReport): number {
  if (c.skipped || c.resolved === 0 || !Number.isFinite(c.pTwoSided)) return 1;
  return c.pTwoSided;
}

/**
 * BH-rejected cells passing consistency and direction agreement (A1-4), at most one per (column, tail, timeframe) (smaller pTwoSided wins,
 * ties: larger |obsAll|), then the SNIPE_MAX_CONFIRM smallest pTwoSided (ties: larger |obsAll|).
 */
export function selectForConfirmation(cells: CellReport[], q: number = SNIPE_FDR_Q): CellReport[] {
  const rejected = benjaminiHochberg(cells.map(bhP), q);
  const better = (a: CellReport, b: CellReport) =>
    bhP(a) - bhP(b) || Math.abs(b.obsAll) - Math.abs(a.obsAll);
  const best = new Map<string, CellReport>();
  cells.forEach((c, i) => {
    if (!rejected[i] || !c.consistency.pass || !c.directionAgrees) return;
    const key = `${c.cell.column}|${c.cell.tail}|${c.cell.timeframe}`;
    const cur = best.get(key);
    if (!cur || better(c, cur) < 0) best.set(key, c);
  });
  return [...best.values()].sort(better).slice(0, SNIPE_MAX_CONFIRM);
}

export interface ConfirmResult {
  pass: boolean;
  empiricalP: number;
  /** One-sided normal p of the inflated null z, in the fixed direction (AMENDMENT 1, A1-3). */
  zP1: number;
  threshold: number;
  consistency: ConsistencyResult;
  report: CellReport;
}

/**
 * Pass iff the empirical p in the fixed direction is below alpha / m AND the one-sided normal p of the inflated
 * null z is below alpha / m (AMENDMENT 1, A1-3) AND consistency with s = d passes.
 */
export function confirmDecision(report: CellReport, threshold: number): boolean {
  return report.empiricalP < threshold && report.zP1 < threshold && report.consistency.pass;
}

/** Evaluates the cell in the fixed direction and applies confirmDecision at alpha / m. */
export function confirmCell(
  ctx: SliceContext,
  cell: SnipeCell,
  direction: 1 | -1,
  m: number,
  offsets: ArrayLike<number>,
): ConfirmResult {
  const report = evaluateCell(ctx, cell, offsets, direction);
  const threshold = SNIPE_CONFIRM_ALPHA / m;
  return {
    pass: confirmDecision(report, threshold),
    empiricalP: report.empiricalP,
    zP1: report.zP1,
    threshold,
    consistency: report.consistency,
    report,
  };
}
