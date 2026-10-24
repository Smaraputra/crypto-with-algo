/**
 * Model description:
 *
 * Prices:
 * - 10 coins on an hourly grid over 24 months: HOURS = 730 * 24.
 * - Each coin's hourly log return is sigma * (sqrt(rho) * m_t + sqrt(1 - rho) * e_it), where m_t and e_it are independent standard normals.
 * - --tails t4 uses Student t with 4 degrees of freedom, scaled to unit variance (divide by sqrt(2)).
 * - sigma = 0.012 (1.2% an hour). Zero drift, so no rule has an edge.
 *
 * Entries (a causal rule on the simulated prices, like the lab rules):
 * - At each hour T, for each coin not blocked by an open trade, compute z = (logP_T - logP_{T-20}) / (sigma * sqrt(20)) from closed hours only.
 * - If |z| > zStar the coin enters at T.
 * - Side: sign(z) for rule cont (continuation, like S1) and -sign(z) for rule fade (like S2).
 * - The trade earns the log return from T to T+8h, with no entry delay. Then the coin is free again at T+8h.
 * - zStar defaults to 2.2. The report must state the realised trades per day (target about 1 to 2 a day across 10 coins, like S1 and S2).
 *
 * Grading A, overlapping (lab-v4 as built):
 * - For every hour T with at least one entry, R_T = sum over entering coins of (side * r) - 0.0014 * (number of entering coins).
 * - x = min(R_T / 0.15, 1). Hours with no entry place no bet (x: null).
 * - Step stepEProcess(prev, { barTime: T, x, b: 0 }, { threshold, lossUnbounded: true }) in hour order.
 *
 * Grading B, non-overlapping control:
 * - The same rule and grading as A, but entries are only allowed at hours divisible by 8. With the 8-hour hold, no two graded windows overlap.
 *
 * Grading C, daily mark-to-market (the lab-v5 design):
 * - For each UTC day (24-hour block of the grid), R_day = sum over open trades of side * (log return inside that day of the part of the trade within the day). Charge 0.0014 per trade on the day the trade enters.
 * - x = min(R_day / 0.15, 1). Days with no open trade place no bet.
 * - Step the e-process day by day.
 *
 * Thresholds and outputs:
 * - For each grading, record whether the path's e-process ever reached logE >= log(k) within the 24 months, for every k in {10, 20, 50, 100, 200, 600, 800}.
 * - Track the maximum of logE once per path and compare it to each log(k). One e-process run per grading is enough.
 * - The Ville bound is 1/k.
 * - Cells: rule in {cont, fade} x rho in {0.5, 0.7, 0.9} with normal tails, plus rule cont with rho 0.7 and t4 tails, so 7 cells.
 * - Each cell runs --paths paths (default 2000). All three gradings share each path's prices and entries.
 * - Report per cell and grading, for every k:
 *   - the crossing share
 *   - a Wilson 95% interval
 *   - the bound 1/k
 *   - a flag exceedsBound that is true when the Wilson lower end is above 1/k.
 * - Also report:
 *   - mean trades per day
 *   - the share of graded hours with more than one entering coin
 *   - the lag-1 correlation of graded x values (A only)
 *   - seed, paths, zStar, sigma, and the git commit if --commit is passed.
 *
 * PREDICTIONS, recorded before any run:
 * - A exceeds the bound at small k (10 to 50) for rule cont at rho 0.7 or higher.
 * - B and C stay at or below the bound everywhere, apart from sampling noise.
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  type EProcessOptions,
  initialEState,
  type LabBar,
  stepEProcess,
} from '@/lib/signals/lab/e-process';

export const THRESHOLDS = [10, 20, 50, 100, 200, 600, 800] as const;

export interface SimCell {
  id?: string;
  rule: 'cont' | 'fade';
  rho: number;
  tails: 'normal' | 't4';
}

export const DEFAULT_CELLS: SimCell[] = [
  { id: 'cont_rho0.5_normal', rule: 'cont', rho: 0.5, tails: 'normal' },
  { id: 'cont_rho0.7_normal', rule: 'cont', rho: 0.7, tails: 'normal' },
  { id: 'cont_rho0.9_normal', rule: 'cont', rho: 0.9, tails: 'normal' },
  { id: 'fade_rho0.5_normal', rule: 'fade', rho: 0.5, tails: 'normal' },
  { id: 'fade_rho0.7_normal', rule: 'fade', rho: 0.7, tails: 'normal' },
  { id: 'fade_rho0.9_normal', rule: 'fade', rho: 0.9, tails: 'normal' },
  { id: 'cont_rho0.7_t4', rule: 'cont', rho: 0.7, tails: 't4' },
];

export interface SimPricesParams {
  numCoins?: number;
  hours?: number;
  sigma?: number;
  rho: number;
  tails: 'normal' | 't4';
}

export interface Trade {
  coin: number;
  entryHour: number;
  side: number;
  r: number;
}

export interface GenTradesParams {
  rule: 'cont' | 'fade';
  zStar?: number;
  sigma?: number;
  lookback?: number;
  holdHours?: number;
}

export interface GradedBar extends LabBar {
  barTime: number;
  x: number;
  b: number;
  R: number;
  enteringCoins?: number;
}

export interface GradeParams {
  fee?: number;
  scale?: number;
  holdHours?: number;
}

export type WilsonInterval = [number, number] & { lower: number; upper: number };

export interface ThresholdReport {
  k: number;
  bound: number;
  crossings: number;
  share: number;
  wilson: [number, number];
  exceedsBound: boolean;
}

export type GradingThresholdMap = Record<number, ThresholdReport> & {
  thresholds: ThresholdReport[];
  lag1Correlation?: number;
  shareMultiCoinHours?: number;
};

export interface CellReport {
  id: string;
  rule: 'cont' | 'fade';
  rho: number;
  tails: 'normal' | 't4';
  meanTradesPerDay: number;
  shareMultiCoinHours: number;
  lag1CorrA: number;
  gradings: {
    A: GradingThresholdMap;
    B: GradingThresholdMap;
    C: GradingThresholdMap;
  };
}

export interface SimOptions {
  paths?: number;
  seed?: number;
  zStar?: number;
  sigma?: number;
  hours?: number;
  numCoins?: number;
}

export interface StudyOptions extends SimOptions {
  cells?: SimCell[];
  commit?: string;
}

export interface StudyReport {
  seed: number;
  paths: number;
  zStar: number;
  sigma: number;
  commit?: string;
  cells: CellReport[];
}

/**
 * Deterministic 32-bit PRNG (mulberry32).
 * Returns floating numbers strictly in (0, 1).
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const u32 = (t ^ (t >>> 14)) >>> 0;
    return (u32 + 0.5) / 4294967296;
  };
}

/** Box-Muller generator for standard normal N(0, 1). */
function makeNormalRng(rng: () => number): () => number {
  let hasSpare = false;
  let spare = 0;
  return function nextNormal(): number {
    if (hasSpare) {
      hasSpare = false;
      return spare;
    }
    const u1 = rng();
    const u2 = rng();
    const mag = Math.sqrt(-2 * Math.log(u1));
    spare = mag * Math.sin(2 * Math.PI * u2);
    hasSpare = true;
    return mag * Math.cos(2 * Math.PI * u2);
  };
}

/**
 * Student t generator with 4 degrees of freedom, scaled to unit variance.
 * Scaling divides by sqrt(2) so Var = 1.
 */
function makeT4Rng(rng: () => number): () => number {
  const normal = makeNormalRng(rng);
  return function nextT4(): number {
    const z = normal();
    const z1 = normal();
    const z2 = normal();
    const z3 = normal();
    const z4 = normal();
    const v = (z1 * z1 + z2 * z2 + z3 * z3 + z4 * z4) / 2;
    return z / Math.sqrt(Math.max(v, 1e-12));
  };
}

/**
 * Simulates hourly log returns [coin][hour] under a single-factor correlation model.
 */
export function simulatePrices(
  params: SimPricesParams,
  rng: () => number
): number[][] {
  const numCoins = params.numCoins ?? 10;
  const hours = params.hours ?? 730 * 24;
  const sigma = params.sigma ?? 0.012;
  const rho = params.rho;
  const tails = params.tails;

  const sqrtRho = Math.sqrt(rho);
  const sqrt1MinusRho = Math.sqrt(Math.max(0, 1 - rho));

  const gen = tails === 't4' ? makeT4Rng(rng) : makeNormalRng(rng);

  const returns: number[][] = new Array(numCoins);
  for (let c = 0; c < numCoins; c++) {
    returns[c] = new Array(hours);
  }

  for (let h = 0; h < hours; h++) {
    const m_t = gen();
    for (let c = 0; c < numCoins; c++) {
      const e_it = gen();
      returns[c][h] = sigma * (sqrtRho * m_t + sqrt1MinusRho * e_it);
    }
  }

  return returns;
}

/**
 * Generates trades from hourly log returns using a 20-hour momentum z-score.
 */
export function generateTrades(
  logReturns: number[][],
  params: GenTradesParams
): Trade[] {
  const numCoins = logReturns.length;
  if (numCoins === 0) return [];
  const hours = logReturns[0].length;
  const zStar = params.zStar ?? 2.2;
  const sigma = params.sigma ?? 0.012;
  const lookback = params.lookback ?? 20;
  const holdHours = params.holdHours ?? 8;
  const rule = params.rule;

  const cum: Float64Array[] = new Array(numCoins);
  for (let c = 0; c < numCoins; c++) {
    const row = logReturns[c];
    const cRow = new Float64Array(hours + 1);
    for (let h = 0; h < hours; h++) {
      cRow[h + 1] = cRow[h] + row[h];
    }
    cum[c] = cRow;
  }

  const denom = sigma * Math.sqrt(lookback);
  const blockedUntil = new Int32Array(numCoins);
  const trades: Trade[] = [];

  const maxEntry = hours - holdHours;
  for (let T = lookback; T <= maxEntry; T++) {
    for (let c = 0; c < numCoins; c++) {
      if (T < blockedUntil[c]) {
        continue;
      }
      const diff = cum[c][T] - cum[c][T - lookback];
      const z = diff / denom;
      if (Math.abs(z) > zStar) {
        const baseSide = z > 0 ? 1 : -1;
        const side = rule === 'cont' ? baseSide : -baseSide;
        const r = cum[c][T + holdHours] - cum[c][T];
        trades.push({
          coin: c,
          entryHour: T,
          side,
          r,
        });
        blockedUntil[c] = T + holdHours;
      }
    }
  }

  return trades;
}

/**
 * Grading A: Overlapping lab-v4 grading.
 * Hours with no entry produce no bar.
 */
export function gradeOverlapping(
  trades: readonly Trade[],
  params?: GradeParams
): GradedBar[] {
  if (trades.length === 0) return [];
  const fee = params?.fee ?? 0.0014;
  const scale = params?.scale ?? 0.15;

  const groups = new Map<number, Trade[]>();
  for (const t of trades) {
    const list = groups.get(t.entryHour);
    if (list) {
      list.push(t);
    } else {
      groups.set(t.entryHour, [t]);
    }
  }

  const entryHours = Array.from(groups.keys()).sort((a, b) => a - b);
  const bars: GradedBar[] = [];

  for (const T of entryHours) {
    const group = groups.get(T);
    if (!group || group.length === 0) continue;
    let sumTradeReturn = 0;
    for (const t of group) {
      sumTradeReturn += t.side * t.r;
    }
    const R_T = sumTradeReturn - fee * group.length;
    const x = Math.min(R_T / scale, 1);
    bars.push({
      barTime: T,
      x,
      b: 0,
      R: R_T,
      enteringCoins: group.length,
    });
  }

  return bars;
}

/**
 * Grading B: Non-overlapping control grading.
 * Entries allowed only at hours divisible by holdHours (default 8).
 */
export function gradeControl(
  trades: readonly Trade[],
  params?: GradeParams
): GradedBar[] {
  const holdHours = params?.holdHours ?? 8;
  const filtered = trades.filter((t) => t.entryHour % holdHours === 0);
  return gradeOverlapping(filtered, params);
}

/**
 * Grading C: Daily mark-to-market grading (lab-v5 design).
 * Partitions trade returns into 24-hour UTC day blocks.
 * Days with no open trade produce no bar.
 */
export function gradeDailyMtm(
  trades: readonly Trade[],
  logReturns: number[][],
  params?: GradeParams
): GradedBar[] {
  if (trades.length === 0 || logReturns.length === 0) return [];
  const fee = params?.fee ?? 0.0014;
  const scale = params?.scale ?? 0.15;
  const holdHours = params?.holdHours ?? 8;
  const hours = logReturns[0].length;
  const numCoins = logReturns.length;

  const cum: Float64Array[] = new Array(numCoins);
  for (let c = 0; c < numCoins; c++) {
    const row = logReturns[c];
    const cRow = new Float64Array(hours + 1);
    for (let h = 0; h < hours; h++) {
      cRow[h + 1] = cRow[h] + row[h];
    }
    cum[c] = cRow;
  }

  const dayReturns = new Map<number, number>();

  for (const t of trades) {
    const entryH = t.entryHour;
    const endH = entryH + holdHours - 1;
    const d1 = Math.floor(entryH / 24);
    const d2 = Math.floor(endH / 24);

    const h1End = Math.min(endH, (d1 + 1) * 24 - 1);
    const r1 = cum[t.coin][h1End + 1] - cum[t.coin][entryH];
    const mtm1 = t.side * r1 - fee;
    dayReturns.set(d1, (dayReturns.get(d1) ?? 0) + mtm1);

    if (d2 > d1) {
      const h2Start = d2 * 24;
      const r2 = cum[t.coin][endH + 1] - cum[t.coin][h2Start];
      const mtm2 = t.side * r2;
      dayReturns.set(d2, (dayReturns.get(d2) ?? 0) + mtm2);
    }
  }

  const sortedDays = Array.from(dayReturns.keys()).sort((a, b) => a - b);
  const bars: GradedBar[] = [];

  for (const d of sortedDays) {
    const R_day = dayReturns.get(d) ?? 0;
    const x = Math.min(R_day / scale, 1);
    bars.push({
      barTime: d,
      x,
      b: 0,
      R: R_day,
    });
  }

  return bars;
}

/**
 * Folds stepEProcess across bars and returns the maximum logE achieved.
 */
export function maxLogE(
  bars: readonly LabBar[],
  options?: EProcessOptions
): number {
  if (bars.length === 0) return 0;
  let state = initialEState();
  let max = -Infinity;
  const opts: EProcessOptions = {
    lossUnbounded: options?.lossUnbounded ?? true,
    ...options,
  };
  for (const bar of bars) {
    const res = stepEProcess(state, bar, opts);
    state = res.state;
    if (state.logE > max) {
      max = state.logE;
    }
  }
  return max;
}

/**
 * Wilson score 95% confidence interval for proportion.
 */
export function wilson(successes: number, n: number): WilsonInterval {
  if (n <= 0) {
    const res = [0, 1] as WilsonInterval;
    res.lower = 0;
    res.upper = 1;
    return res;
  }
  if (successes <= 0) {
    const z = 1.959963984540054;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const upper = Math.min(1, (z2 / n) / denom);
    const res = [0, upper] as WilsonInterval;
    res.lower = 0;
    res.upper = upper;
    return res;
  }
  const z = 1.959963984540054;
  const z2 = z * z;
  const p = successes / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin =
    (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);

  const res = [lower, upper] as WilsonInterval;
  res.lower = lower;
  res.upper = upper;
  return res;
}

/**
 * Computes lag-1 autocorrelation of graded x values across all paths.
 */
function computeLag1Corr(pathsBars: GradedBar[][]): number {
  let count = 0;
  let sumU = 0;
  let sumV = 0;
  let sumU2 = 0;
  let sumV2 = 0;
  let sumUV = 0;

  for (const bars of pathsBars) {
    for (let i = 0; i < bars.length - 1; i++) {
      const u = bars[i].x;
      const v = bars[i + 1].x;
      sumU += u;
      sumV += v;
      sumU2 += u * u;
      sumV2 += v * v;
      sumUV += u * v;
      count++;
    }
  }

  if (count <= 1) return 0;
  const meanU = sumU / count;
  const meanV = sumV / count;
  const varU = sumU2 / count - meanU * meanU;
  const varV = sumV2 / count - meanV * meanV;
  if (varU <= 0 || varV <= 0) return 0;
  const cov = sumUV / count - meanU * meanV;
  return cov / Math.sqrt(varU * varV);
}

function buildGradingMap(
  crossings: Map<number, number>,
  paths: number,
  extra?: { lag1Correlation?: number; shareMultiCoinHours?: number }
): GradingThresholdMap {
  const map: Record<number, ThresholdReport> & {
    thresholds: ThresholdReport[];
    lag1Correlation?: number;
    shareMultiCoinHours?: number;
  } = {
    thresholds: [],
    ...(extra?.lag1Correlation !== undefined ? { lag1Correlation: extra.lag1Correlation } : {}),
    ...(extra?.shareMultiCoinHours !== undefined ? { shareMultiCoinHours: extra.shareMultiCoinHours } : {}),
  };

  for (const k of THRESHOLDS) {
    const c = crossings.get(k) ?? 0;
    const share = paths > 0 ? c / paths : 0;
    const w = wilson(c, paths);
    const bound = 1 / k;
    const exceedsBound = w.lower > bound;
    const item: ThresholdReport = {
      k,
      bound,
      crossings: c,
      share,
      wilson: [w.lower, w.upper],
      exceedsBound,
    };
    map[k] = item;
    map.thresholds.push(item);
  }

  return map;
}

/**
 * Runs simulation paths for a single cell across Gradings A, B, and C.
 */
export function runCell(cell: SimCell, options?: SimOptions): CellReport {
  const paths = options?.paths ?? 2000;
  const baseSeed = options?.seed ?? 42;
  const zStar = options?.zStar ?? 2.2;
  const sigma = options?.sigma ?? 0.012;
  const hours = options?.hours ?? 730 * 24;
  const numCoins = options?.numCoins ?? 10;

  const cellId = cell.id ?? `${cell.rule}_rho${cell.rho}_${cell.tails}`;

  const crossingsA = new Map<number, number>();
  const crossingsB = new Map<number, number>();
  const crossingsC = new Map<number, number>();
  for (const k of THRESHOLDS) {
    crossingsA.set(k, 0);
    crossingsB.set(k, 0);
    crossingsC.set(k, 0);
  }

  let totalTrades = 0;
  let totalGradedHoursA = 0;
  let multiCoinGradedHoursA = 0;
  const allBarsA: GradedBar[][] = [];

  for (let p = 0; p < paths; p++) {
    const pathSeed = (baseSeed + p * 31337 + 7) >>> 0;
    const rng = makeRng(pathSeed);
    const logReturns = simulatePrices(
      { numCoins, hours, sigma, rho: cell.rho, tails: cell.tails },
      rng
    );
    const trades = generateTrades(logReturns, { rule: cell.rule, zStar, sigma });
    totalTrades += trades.length;

    const barsA = gradeOverlapping(trades);
    const barsB = gradeControl(trades);
    const barsC = gradeDailyMtm(trades, logReturns);

    allBarsA.push(barsA);
    for (const b of barsA) {
      totalGradedHoursA++;
      if ((b.enteringCoins ?? 0) > 1) {
        multiCoinGradedHoursA++;
      }
    }

    const maxA = maxLogE(barsA);
    const maxB = maxLogE(barsB);
    const maxC = maxLogE(barsC);

    for (const k of THRESHOLDS) {
      const logK = Math.log(k);
      if (maxA >= logK) {
        crossingsA.set(k, (crossingsA.get(k) ?? 0) + 1);
      }
      if (maxB >= logK) {
        crossingsB.set(k, (crossingsB.get(k) ?? 0) + 1);
      }
      if (maxC >= logK) {
        crossingsC.set(k, (crossingsC.get(k) ?? 0) + 1);
      }
    }
  }

  const days = hours / 24;
  const meanTradesPerDay = paths > 0 && days > 0 ? totalTrades / paths / days : 0;
  const shareMultiCoinHours =
    totalGradedHoursA > 0 ? multiCoinGradedHoursA / totalGradedHoursA : 0;
  const lag1CorrA = computeLag1Corr(allBarsA);

  const gradingA = buildGradingMap(crossingsA, paths, {
    lag1Correlation: lag1CorrA,
    shareMultiCoinHours,
  });
  const gradingB = buildGradingMap(crossingsB, paths);
  const gradingC = buildGradingMap(crossingsC, paths);

  return {
    id: cellId,
    rule: cell.rule,
    rho: cell.rho,
    tails: cell.tails,
    meanTradesPerDay,
    shareMultiCoinHours,
    lag1CorrA,
    gradings: {
      A: gradingA,
      B: gradingB,
      C: gradingC,
    },
  };
}

/**
 * Runs study across requested cells and returns the final report object.
 */
export function runStudy(options?: StudyOptions): StudyReport {
  const seed = options?.seed ?? 42;
  const paths = options?.paths ?? 2000;
  const zStar = options?.zStar ?? 2.2;
  const sigma = options?.sigma ?? 0.012;
  const cellsToRun = options?.cells ?? DEFAULT_CELLS;
  const commit = options?.commit;

  const cellReports: CellReport[] = [];

  for (let idx = 0; idx < cellsToRun.length; idx++) {
    const cell = cellsToRun[idx];
    const cellSeed = (seed + idx * 10007) >>> 0;
    const report = runCell(cell, {
      ...options,
      seed: cellSeed,
      paths,
      zStar,
      sigma,
    });
    cellReports.push(report);
  }

  return {
    seed,
    paths,
    zStar,
    sigma,
    ...(commit ? { commit } : {}),
    cells: cellReports,
  };
}

interface CliArgs {
  paths: number;
  seed: number;
  zStar: number;
  out?: string;
  commit?: string;
  cells?: string[];
}

function getGitCommit(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function parseArgs(argv: string[]): CliArgs {
  let paths = 2000;
  let seed = 42;
  let zStar = 2.2;
  let out: string | undefined;
  let commit: string | undefined;
  let cells: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--paths' && i + 1 < argv.length) {
      paths = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--paths=')) {
      paths = parseInt(arg.slice('--paths='.length), 10);
    } else if (arg === '--seed' && i + 1 < argv.length) {
      seed = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--seed=')) {
      seed = parseInt(arg.slice('--seed='.length), 10);
    } else if (arg === '--zstar' && i + 1 < argv.length) {
      zStar = parseFloat(argv[++i]);
    } else if (arg.startsWith('--zstar=')) {
      zStar = parseFloat(arg.slice('--zstar='.length));
    } else if (arg === '--out' && i + 1 < argv.length) {
      out = argv[++i];
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--commit') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        commit = argv[++i];
      } else {
        commit = getGitCommit();
      }
    } else if (arg.startsWith('--commit=')) {
      commit = arg.slice('--commit='.length);
    } else if (arg === '--cells' && i + 1 < argv.length) {
      cells = argv[++i].split(',').map((s) => s.trim());
    } else if (arg.startsWith('--cells=')) {
      cells = arg.slice('--cells='.length).split(',').map((s) => s.trim());
    }
  }

  return { paths, seed, zStar, out, commit, cells };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);

  let selectedCells = DEFAULT_CELLS;
  if (args.cells && args.cells.length > 0) {
    const filterSet = new Set(args.cells);
    selectedCells = DEFAULT_CELLS.filter(
      (c, idx) =>
        filterSet.has(c.id ?? '') ||
        filterSet.has(c.rule) ||
        filterSet.has(String(idx))
    );
  }

  const report = runStudy({
    paths: args.paths,
    seed: args.seed,
    zStar: args.zStar,
    commit: args.commit,
    cells: selectedCells,
  });

  const jsonStr = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(args.out, jsonStr, 'utf8');
  } else {
    console.log(jsonStr);
  }

  process.exit(0);
}

const isDirectRun =
  (typeof require !== 'undefined' && require.main === module) ||
  (typeof process !== 'undefined' &&
    process.argv[1] &&
    process.argv[1].endsWith('round4-overlap-sim.ts'));

if (isDirectRun) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
