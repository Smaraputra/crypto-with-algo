/**
 * Round 2 candidate preview on the point-in-time top 30 Binance USDT-M perpetuals.
 * Computes daily cross-sectional book returns, statistics, power and null calibrations.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { stepEProcess, initialEState, type EProcessState } from '../../src/lib/signals/lab/e-process';
import { bookWeights } from '../../src/lib/stats/rank-ic';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';
import type { FundingRow, PerpCandleRow } from './dataset-format';
import { loadFunding, loadManifest, loadPerp, verifyManifest } from './load-dataset';

export const DAY_MS = 86_400_000;
export const SAMPLE_END_DAY = '2026-06-29';
export const MIN_SCORED_COINS = 10;
export const DELISTING_HAIRCUT = 0.02;
export const TAKER_FEE_RATE = 0.0005;

export type SignalKind = 'fund7' | 'fundChange' | 'mom1' | 'rev7' | 'lottery30';
export type HoldKind = 'h1' | 'h7';

export const SIGNALS: readonly SignalKind[] = ['fund7', 'fundChange', 'mom1', 'rev7', 'lottery30'];
export const HOLDS: readonly HoldKind[] = ['h1', 'h7'];

export interface SignalScores {
  fund7: number | null;
  fundChange: number | null;
  mom1: number | null;
  rev7: number | null;
  lottery30: number | null;
}

export interface UniverseMember {
  id: string;
  symbol: string;
  assetKey: string;
  rank: number;
  volume: number;
}

export interface UniverseMonth {
  close: string;
  closeMs: number;
  validFrom: string;
  validUntil: string;
  eligibleCount: number;
  rankedCount: number;
  members: UniverseMember[];
}

export interface UniverseJson {
  sourceDatasetHash: string;
  sha256: string;
  universe: {
    months: UniverseMonth[];
  };
}

export interface DailySeriesItem {
  D: string;
  R: number;
  gross: number;
  funding: number;
  cost: number;
  turnover: number;
  coins: number;
  missingHeld: number;
}

export interface StatSummary {
  days: number;
  meanR: number;
  sdR: number;
  sharpe: number;
  sharePositive: number;
  maxDrawdown: number;
  meanTurnover: number;
  meanGross: number;
  meanFunding: number;
  meanCost: number;
  totalMissingHeld: number;
  maxMissingHeld: number;
}

export interface PowerThresholdResult {
  share: number;
  medianBar: number | null;
}

export interface CandidateResult {
  signal: SignalKind;
  hold: HoldKind;
  scale: number;
  stats: {
    all: StatSummary;
    byYear: Record<string, StatSummary>;
  };
  power: {
    iid: Record<number, PowerThresholdResult>;
    block: Record<number, PowerThresholdResult>;
  };
  null: {
    crossingCount: number;
    maxLogE: number;
  };
}

export interface Nv2PreviewOutput {
  datasetHash: string;
  universeSha256: string;
  top: number;
  generatedAt: string;
  candidates: CandidateResult[];
  series: Record<string, DailySeriesItem[]>;
}

export function dayStartMs(isoDay: string): number {
  const ms = Date.parse(`${isoDay}T00:00:00Z`);
  if (!Number.isFinite(ms)) {
    throw new Error(`Bad day format: "${isoDay}"`);
  }
  return ms;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Slippage rate by ranking tier: 1-10 at 2 bps, 11-25 at 5 bps, 26+ at 10 bps. */
export function slippageOfRank(rank?: number): number {
  if (rank === undefined || rank >= 26) return 0.0010;
  if (rank >= 11) return 0.0005;
  if (rank >= 1) return 0.0002;
  return 0.0010;
}

/** Cost for traded amount: tradedAmount * (0.0005 fee + slippage). */
export function costOf(tradedAmount: number, rank?: number): number {
  return tradedAmount * (TAKER_FEE_RATE + slippageOfRank(rank));
}

/**
 * Daily return from open(D) to open(D+1).
 * If bar(D+1) is missing, applies the 2% haircut: c(D)/o(D) - 1 - 0.02.
 */
export function dayReturn(
  barD: PerpCandleRow | null,
  barD1: PerpCandleRow | null
): number | null;
export function dayReturn(
  symbol: string,
  d: number,
  barD: PerpCandleRow | null,
  barD1: PerpCandleRow | null
): number | null;
export function dayReturn(
  arg1: PerpCandleRow | string | null,
  arg2: PerpCandleRow | number | null,
  arg3?: PerpCandleRow | null,
  arg4?: PerpCandleRow | null
): number | null {
  const barD = (typeof arg1 === 'string' ? arg3 : arg1) as PerpCandleRow | null;
  const barD1 = (typeof arg1 === 'string' ? arg4 : arg2) as PerpCandleRow | null;

  if (!barD || barD.o === 0) return null;
  if (barD1 && barD1.o !== 0) {
    return barD1.o / barD.o - 1;
  }
  return barD.c / barD.o - 1 - DELISTING_HAIRCUT;
}

/**
 * Funding per unit long is minus the sum of settlement rates in (D, D + 1 day].
 */
export function fundingOf(d: number, settlements: readonly FundingRow[]): number;
export function fundingOf(symbol: string, d: number, settlements: readonly FundingRow[]): number;
export function fundingOf(
  arg1: number | string,
  arg2: readonly FundingRow[] | number,
  arg3?: readonly FundingRow[]
): number {
  const d = typeof arg1 === 'number' ? arg1 : (arg2 as number);
  const settlements = (typeof arg1 === 'number' ? arg2 : arg3) as readonly FundingRow[];

  const start = d;
  const end = d + DAY_MS;
  let sum = 0;
  for (const s of settlements) {
    if (s.t > start && s.t <= end) {
      sum += s.rate;
    }
  }
  return -sum;
}

/**
 * Signals evaluated at day D (timestamp D).
 * Only uses 1d bars with t + 1 day <= D (closed by D) and settlements with t <= D.
 */
export function signalsAt(
  d: number,
  bars: readonly PerpCandleRow[],
  settlements: readonly FundingRow[]
): SignalScores;
export function signalsAt(
  symbol: string,
  d: number,
  bars: readonly PerpCandleRow[],
  settlements: readonly FundingRow[]
): SignalScores;
export function signalsAt(
  arg1: number | string,
  arg2: readonly PerpCandleRow[] | number,
  arg3: readonly FundingRow[] | readonly PerpCandleRow[],
  arg4?: readonly FundingRow[]
): SignalScores {
  const d = typeof arg1 === 'number' ? arg1 : (arg2 as number);
  const bars = (typeof arg1 === 'number' ? arg2 : arg3) as readonly PerpCandleRow[];
  const settlements = (typeof arg1 === 'number' ? arg3 : arg4) as readonly FundingRow[];

  // Index closed bars by t (strictly closed by D: t + DAY_MS <= d)
  const closedBars = new Map<number, PerpCandleRow>();
  for (const b of bars) {
    if (b.t + DAY_MS <= d) {
      closedBars.set(b.t, b);
    }
  }

  // mom1: last closed day's return, c/o - 1 of bar with t = D - 1 day
  let mom1: number | null = null;
  const barD1 = closedBars.get(d - DAY_MS);
  if (barD1 && barD1.o !== 0) {
    mom1 = barD1.c / barD1.o - 1;
  }

  // rev7: minus 7-day close-to-close return: - (c(D-1d bar)/c(D-8d bar) - 1)
  // Needs all 8 daily bars: d - 8d through d - 1d
  let rev7: number | null = null;
  let rev7Complete = true;
  for (let k = 1; k <= 8; k++) {
    if (!closedBars.has(d - k * DAY_MS)) {
      rev7Complete = false;
      break;
    }
  }
  if (rev7Complete) {
    const b1 = closedBars.get(d - DAY_MS)!;
    const b8 = closedBars.get(d - 8 * DAY_MS)!;
    if (b8.c !== 0) {
      rev7 = -(b1.c / b8.c - 1);
    }
  }

  // lottery30: minus max daily close-to-close return over last 30 closed days
  // Needs all 31 daily bars: d - 31d through d - 1d
  let lottery30: number | null = null;
  let lotteryComplete = true;
  for (let k = 1; k <= 31; k++) {
    if (!closedBars.has(d - k * DAY_MS)) {
      lotteryComplete = false;
      break;
    }
  }
  if (lotteryComplete) {
    let maxReturn = -Infinity;
    let valid = true;
    for (let k = 1; k <= 30; k++) {
      const bCurr = closedBars.get(d - k * DAY_MS)!;
      const bPrev = closedBars.get(d - (k + 1) * DAY_MS)!;
      if (bPrev.c === 0) {
        valid = false;
        break;
      }
      const r = bCurr.c / bPrev.c - 1;
      if (r > maxReturn) maxReturn = r;
    }
    if (valid && maxReturn > -Infinity) {
      lottery30 = -maxReturn;
    }
  }

  // Settlements: only those with t <= d
  // fund7: minus sum of funding rates over settlements in (D - 7d, D]. At least 18 settlements.
  let fund7: number | null = null;
  const start7 = d - 7 * DAY_MS;
  const start14 = d - 14 * DAY_MS;

  let sum7 = 0;
  let count7 = 0;
  let sum14 = 0;
  let count14 = 0;

  for (const s of settlements) {
    if (s.t > start7 && s.t <= d) {
      sum7 += s.rate;
      count7++;
    } else if (s.t > start14 && s.t <= start7) {
      sum14 += s.rate;
      count14++;
    }
  }

  if (count7 >= 18) {
    fund7 = -sum7;
  }

  // fundChange: minus (sum over (D - 7d, D] minus sum over (D - 14d, D - 7d]).
  // Needs >= 18 settlements in both windows.
  let fundChange: number | null = null;
  if (count7 >= 18 && count14 >= 18) {
    fundChange = -(sum7 - sum14);
  }

  return { fund7, fundChange, mom1, rev7, lottery30 };
}

/**
 * Dollar-neutral, gross-1 target book of scores.
 * Needs at least 10 coins with a score; otherwise returns an empty map (cash).
 */
export function targetBook(
  scores: Map<string, number> | Array<{ symbol: string; score: number }>
): Map<string, number> {
  const entries: Array<{ symbol: string; score: number }> = [];
  if (scores instanceof Map) {
    for (const [symbol, score] of scores.entries()) {
      if (Number.isFinite(score)) {
        entries.push({ symbol, score });
      }
    }
  } else {
    for (const item of scores) {
      if (Number.isFinite(item.score)) {
        entries.push({ symbol: item.symbol, score: item.score });
      }
    }
  }

  if (entries.length < MIN_SCORED_COINS) {
    return new Map<string, number>();
  }

  entries.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const rawScores = entries.map((e) => e.score);
  const weights = bookWeights(rawScores);

  const result = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const w = weights[i];
    if (Math.abs(w) > 1e-15) {
      result.set(entries[i].symbol, w);
    }
  }
  return result;
}

/**
 * h7 staggered book: equal average of the targets formed at D, D-1, ..., D-6.
 * A day with an empty target counts as zero weights (always divided by 7).
 */
export function staggeredBook(
  pastTargets: readonly (Map<string, number> | ReadonlyMap<string, number>)[]
): Map<string, number> {
  const sums = new Map<string, number>();
  const count = Math.min(pastTargets.length, 7);

  for (let k = 0; k < count; k++) {
    const target = pastTargets[k];
    for (const [symbol, weight] of target.entries()) {
      sums.set(symbol, (sums.get(symbol) ?? 0) + weight);
    }
  }

  const result = new Map<string, number>();
  for (const [symbol, sum] of sums.entries()) {
    const w = sum / 7;
    if (Math.abs(w) > 1e-15) {
      result.set(symbol, w);
    }
  }
  return result;
}

export interface BookValuation {
  gross: number;
  funding: number;
  missingHeld: number;
}

/**
 * Evaluates gross return, funding return, and counts missing held coins for a book.
 * Loops over every coin in book with non-zero weight.
 * If a held coin is in coinDataMap, accumulates w * r and w * f.
 * If a held coin has no bar (not in coinDataMap), contributes 0 and increments missingHeld.
 */
export function valueBook(
  book: ReadonlyMap<string, number>,
  coinDataMap: ReadonlyMap<string, { r: number; f: number }>
): BookValuation {
  let gross = 0;
  let funding = 0;
  let missingHeld = 0;

  for (const [sym, w] of book.entries()) {
    if (Math.abs(w) <= 1e-15) continue;
    const cd = coinDataMap.get(sym);
    if (cd) {
      gross += w * cd.r;
      funding += w * cd.f;
    } else {
      missingHeld++;
    }
  }

  return { gross, funding, missingHeld };
}

/** Rounds UP a positive number to 2 significant figures. */
export function roundUp2SigFigs(val: number): number {
  if (val <= 0 || !Number.isFinite(val)) return 0;
  const exp = Math.floor(Math.log10(val));
  const factor = Math.pow(10, exp - 1);
  const rounded = Math.ceil(val / factor - 1e-12);
  return rounded * factor;
}

/** Computes performance statistics over a list of daily series items. */
export function computeStats(
  items: readonly {
    R: number;
    gross: number;
    funding: number;
    cost: number;
    turnover: number;
    missingHeld?: number;
  }[]
): StatSummary {
  const days = items.length;
  if (days === 0) {
    return {
      days: 0,
      meanR: 0,
      sdR: 0,
      sharpe: 0,
      sharePositive: 0,
      maxDrawdown: 0,
      meanTurnover: 0,
      meanGross: 0,
      meanFunding: 0,
      meanCost: 0,
      totalMissingHeld: 0,
      maxMissingHeld: 0,
    };
  }

  let sumR = 0;
  let sumGross = 0;
  let sumFunding = 0;
  let sumCost = 0;
  let sumTurnover = 0;
  let positiveDays = 0;
  let totalMissingHeld = 0;
  let maxMissingHeld = 0;

  for (const it of items) {
    sumR += it.R;
    sumGross += it.gross;
    sumFunding += it.funding;
    sumCost += it.cost;
    sumTurnover += it.turnover;
    if (it.R > 0) positiveDays++;
    const m = it.missingHeld ?? 0;
    totalMissingHeld += m;
    if (m > maxMissingHeld) maxMissingHeld = m;
  }

  const meanR = sumR / days;
  let variance = 0;
  for (const it of items) {
    const diff = it.R - meanR;
    variance += diff * diff;
  }
  variance = days > 1 ? variance / (days - 1) : 0;
  const sdR = Math.sqrt(variance);
  const sharpe = sdR > 0 ? (meanR / sdR) * Math.sqrt(365) : 0;
  const sharePositive = positiveDays / days;

  // Max drawdown of cumulative R: peak - cum
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const it of items) {
    cum += it.R;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    days,
    meanR,
    sdR,
    sharpe,
    sharePositive,
    maxDrawdown,
    meanTurnover: sumTurnover / days,
    meanGross: sumGross / days,
    meanFunding: sumFunding / days,
    meanCost: sumCost / days,
    totalMissingHeld,
    maxMissingHeld,
  };
}

function medianOf(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Runs 300 resampling runs of 730 bars for iid and block bootstrap.
 */
export function runPowerSimulation(
  realR: readonly number[],
  scale: number,
  rngSeed: number = 42
): {
  iid: Record<number, PowerThresholdResult>;
  block: Record<number, PowerThresholdResult>;
} {
  const n = realR.length;
  const barsCount = 730;
  const thresholds = [200, 400, 800] as const;
  const runsCount = 300;

  const rng = createSeededRandom(rngSeed);

  // Helper for one pass over 730 returns
  const evalRun = (sampled: number[]): Record<number, number | null> => {
    let state = initialEState();
    const crossedAt: Record<number, number | null> = { 200: null, 400: null, 800: null };

    for (let bar = 1; bar <= barsCount; bar++) {
      const r = sampled[bar - 1];
      const x = Math.min(r / scale, 1);
      const step = stepEProcess(state, { barTime: bar, x, b: 0 }, { lossUnbounded: true });
      state = step.state;

      for (const th of thresholds) {
        if (crossedAt[th] === null && state.logE >= Math.log(th)) {
          crossedAt[th] = bar;
        }
      }
    }
    return crossedAt;
  };

  // 1. iid bootstrap
  const iidCrossings: Record<number, number[]> = { 200: [], 400: [], 800: [] };
  for (let r = 0; r < runsCount; r++) {
    const sampled = new Array<number>(barsCount);
    for (let b = 0; b < barsCount; b++) {
      const idx = Math.floor(rng() * n);
      sampled[b] = realR[idx];
    }
    const res = evalRun(sampled);
    for (const th of thresholds) {
      if (res[th] !== null) {
        iidCrossings[th].push(res[th]!);
      }
    }
  }

  // 2. Stationary block bootstrap (mean block length 10 days)
  const p = 1 / 10;
  const blockCrossings: Record<number, number[]> = { 200: [], 400: [], 800: [] };
  for (let r = 0; r < runsCount; r++) {
    const sampled = new Array<number>(barsCount);
    let idx = Math.floor(rng() * n);
    for (let b = 0; b < barsCount; b++) {
      if (b > 0) {
        if (rng() < p) {
          idx = Math.floor(rng() * n);
        } else {
          idx = (idx + 1) % n;
        }
      }
      sampled[b] = realR[idx];
    }
    const res = evalRun(sampled);
    for (const th of thresholds) {
      if (res[th] !== null) {
        blockCrossings[th].push(res[th]!);
      }
    }
  }

  const formatResult = (crossings: Record<number, number[]>): Record<number, PowerThresholdResult> => {
    const out: Record<number, PowerThresholdResult> = {
      200: { share: crossings[200].length / runsCount, medianBar: medianOf(crossings[200]) },
      400: { share: crossings[400].length / runsCount, medianBar: medianOf(crossings[400]) },
      800: { share: crossings[800].length / runsCount, medianBar: medianOf(crossings[800]) },
    };
    return out;
  };

  return {
    iid: formatResult(iidCrossings),
    block: formatResult(blockCrossings),
  };
}

export interface CliOptions {
  datasetDir: string;
  universe: string;
  out: string;
  top: number;
}

export function parseCliArgs(args: string[]): CliOptions {
  let datasetDir = '';
  let universe = '';
  let out = '';
  let top = 30;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dataset-dir' && i + 1 < args.length) {
      datasetDir = args[++i];
    } else if (arg.startsWith('--dataset-dir=')) {
      datasetDir = arg.slice('--dataset-dir='.length);
    } else if (arg === '--universe' && i + 1 < args.length) {
      universe = args[++i];
    } else if (arg.startsWith('--universe=')) {
      universe = arg.slice('--universe='.length);
    } else if (arg === '--out' && i + 1 < args.length) {
      out = args[++i];
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--top' && i + 1 < args.length) {
      top = parseInt(args[++i], 10);
    } else if (arg.startsWith('--top=')) {
      top = parseInt(arg.slice('--top='.length), 10);
    }
  }

  if (!datasetDir || !universe || !out) {
    throw new Error('Usage: nv2-preview --dataset-dir <dir> --universe <file> --out <file> [--top 30]');
  }

  return { datasetDir, universe, out, top };
}

/** Full preview pipeline execution. */
export async function runPreview(options: CliOptions): Promise<Nv2PreviewOutput> {
  const verify = await verifyManifest(options.datasetDir);
  if (!verify.ok) {
    throw new Error(`Manifest verification failed: ${verify.mismatches.join(', ')}`);
  }

  const manifest = loadManifest(options.datasetDir);
  const universeContent = readFileSync(options.universe, 'utf8');
  const universe = JSON.parse(universeContent) as UniverseJson;

  if (manifest.datasetHash !== universe.sourceDatasetHash) {
    throw new Error(
      `Dataset hash mismatch: manifest=${manifest.datasetHash} vs universe=${universe.sourceDatasetHash}`
    );
  }

  // Collect distinct symbols in the universe
  const symbolsSet = new Set<string>();
  for (const month of universe.universe.months) {
    for (const mem of month.members) {
      symbolsSet.add(mem.symbol);
    }
  }
  const symbols = [...symbolsSet];

  // Load 1d bars and funding settlements for each symbol
  const perpBySymbol = new Map<string, PerpCandleRow[]>();
  const fundingBySymbol = new Map<string, FundingRow[]>();

  for (const sym of symbols) {
    perpBySymbol.set(sym, loadPerp(options.datasetDir, sym, '1d').rows);
    fundingBySymbol.set(sym, loadFunding(options.datasetDir, sym).rows);
  }

  // Fast map lookups per symbol
  const barMapBySymbol = new Map<string, Map<number, PerpCandleRow>>();
  for (const sym of symbols) {
    const map = new Map<number, PerpCandleRow>();
    for (const b of perpBySymbol.get(sym) ?? []) {
      map.set(b.t, b);
    }
    barMapBySymbol.set(sym, map);
  }

  // Daily grid
  const startD = dayStartMs(universe.universe.months[0].validFrom);
  const endD = dayStartMs(SAMPLE_END_DAY);

  const days: number[] = [];
  for (let d = startD; d <= endD; d += DAY_MS) {
    days.push(d);
  }

  // Month lookup for day D
  const getMonthForDay = (d: number): UniverseMonth | undefined => {
    return universe.universe.months.find((m) => {
      const vf = dayStartMs(m.validFrom);
      const vu = dayStartMs(m.validUntil);
      return vf <= d && d < vu;
    });
  };

  // Pre-compute daily coin returns and funding for EVERY symbol that has a bar at D
  const allCoinsByDay = new Map<number, Map<string, { r: number; f: number }>>();

  for (const d of days) {
    const coinMap = new Map<string, { r: number; f: number }>();
    for (const sym of symbols) {
      const barsMap = barMapBySymbol.get(sym);
      const barD = barsMap?.get(d) ?? null;
      if (!barD || barD.o === 0) continue;

      const barD1 = barsMap?.get(d + DAY_MS) ?? null;
      const r = dayReturn(barD, barD1);
      if (r === null) continue;

      const settlements = fundingBySymbol.get(sym) ?? [];
      const f = fundingOf(d, settlements);

      coinMap.set(sym, { r, f });
    }
    allCoinsByDay.set(d, coinMap);
  }

  // Pre-compute daily signals for tradeable members of month's top N
  interface DayMemberData {
    symbol: string;
    rank: number;
    scores: SignalScores;
  }

  const dayData = new Map<number, DayMemberData[]>();

  for (const d of days) {
    const month = getMonthForDay(d);
    if (!month) {
      dayData.set(d, []);
      continue;
    }

    const members = month.members.filter((m) => m.rank <= options.top);
    const coins: DayMemberData[] = [];
    const coinsAtD = allCoinsByDay.get(d);

    for (const mem of members) {
      // Must have valid bar at D (tradeable) to receive scores and target weights
      if (!coinsAtD?.has(mem.symbol)) {
        continue;
      }

      const settlements = fundingBySymbol.get(mem.symbol) ?? [];
      const allBars = perpBySymbol.get(mem.symbol) ?? [];
      const scores = signalsAt(d, allBars, settlements);

      coins.push({
        symbol: mem.symbol,
        rank: mem.rank,
        scores,
      });
    }

    dayData.set(d, coins);
  }

  // Run pipeline for each signal
  const allSeries: Record<string, DailySeriesItem[]> = {};
  const candidates: CandidateResult[] = [];

  for (const sig of SIGNALS) {
    // 1. Form target books at each D
    const targetBooks = new Map<number, Map<string, number>>();
    for (const d of days) {
      const coins = dayData.get(d) ?? [];
      const scoreEntries: Array<{ symbol: string; score: number }> = [];
      for (const c of coins) {
        const val = c.scores[sig];
        if (val !== null && Number.isFinite(val)) {
          scoreEntries.push({ symbol: c.symbol, score: val });
        }
      }
      targetBooks.set(d, targetBook(scoreEntries));
    }

    // 2. Compute series for h1 and h7
    for (const hold of HOLDS) {
      const candidateKey = `${sig}_${hold}`;
      const seriesItems: DailySeriesItem[] = [];
      let prevBook = new Map<string, number>();

      for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
        const d = days[dayIdx];
        const month = getMonthForDay(d);
        const rankBySymbol = new Map<string, number>();
        if (month) {
          for (const m of month.members) {
            rankBySymbol.set(m.symbol, m.rank);
          }
        }

        let currBook: Map<string, number>;
        if (hold === 'h1') {
          currBook = targetBooks.get(d) ?? new Map();
        } else {
          const past: Array<Map<string, number>> = [];
          for (let k = 0; k < 7; k++) {
            const pastD = d - k * DAY_MS;
            past.push(targetBooks.get(pastD) ?? new Map());
          }
          currBook = staggeredBook(past);
        }

        // Rebalancing turnover and cost
        const allTradedCoins = new Set<string>([...currBook.keys(), ...prevBook.keys()]);
        let dayCost = 0;
        let dayTurnover = 0;

        for (const sym of allTradedCoins) {
          const wCurr = currBook.get(sym) ?? 0;
          const wPrev = prevBook.get(sym) ?? 0;
          const traded = Math.abs(wCurr - wPrev);
          if (traded > 1e-12) {
            dayTurnover += traded;
            const rank = rankBySymbol.get(sym);
            dayCost += costOf(traded, rank);
          }
        }

        // Gross return and funding
        const allCoinsMap = allCoinsByDay.get(d) ?? new Map();
        const { gross: dayGross, funding: dayFunding, missingHeld } = valueBook(currBook, allCoinsMap);

        const netR = dayGross + dayFunding - dayCost;
        let activeCoins = 0;
        for (const w of currBook.values()) {
          if (Math.abs(w) > 1e-8) activeCoins++;
        }

        seriesItems.push({
          D: isoDay(d),
          R: netR,
          gross: dayGross,
          funding: dayFunding,
          cost: dayCost,
          turnover: dayTurnover,
          coins: activeCoins,
          missingHeld,
        });

        prevBook = currBook;
      }

      allSeries[candidateKey] = seriesItems;

      // Statistics
      const allStats = computeStats(seriesItems);
      const byYear: Record<string, StatSummary> = {};
      const itemsByYear = new Map<string, DailySeriesItem[]>();

      for (const item of seriesItems) {
        const y = item.D.slice(0, 4);
        if (!itemsByYear.has(y)) itemsByYear.set(y, []);
        itemsByYear.get(y)!.push(item);
      }

      for (const [y, yItems] of itemsByYear.entries()) {
        byYear[y] = computeStats(yItems);
      }

      // Scale: c = 4 * SD(R) rounded UP to 2 sig figs
      const scale = roundUp2SigFigs(4 * allStats.sdR);

      // Power calculation
      const rValues = seriesItems.map((it) => it.R);
      const power = runPowerSimulation(rValues, scale, 42);

      // Null calibration: 200 runs
      const nullRunsCount = 200;
      const nullRng = createSeededRandom(100 + SIGNALS.indexOf(sig));
      let crossingCount = 0;
      let maxLogE = -Infinity;

      for (let run = 0; run < nullRunsCount; run++) {
        let nullPrevBook = new Map<string, number>();
        let nullEState: EProcessState = initialEState();
        const nullTargets = new Map<number, Map<string, number>>();

        for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
          const d = days[dayIdx];
          const coins = dayData.get(d) ?? [];

          // Collect scored coins
          const scoredSymbols: string[] = [];
          const scoredValues: number[] = [];
          for (const c of coins) {
            const v = c.scores[sig];
            if (v !== null && Number.isFinite(v)) {
              scoredSymbols.push(c.symbol);
              scoredValues.push(v);
            }
          }

          let target: Map<string, number>;
          if (scoredSymbols.length < MIN_SCORED_COINS) {
            target = new Map();
          } else {
            // Permute scores
            const permuted = [...scoredValues];
            for (let i = permuted.length - 1; i > 0; i--) {
              const j = Math.floor(nullRng() * (i + 1));
              const temp = permuted[i];
              permuted[i] = permuted[j];
              permuted[j] = temp;
            }
            const pairs = scoredSymbols.map((s, idx) => ({ symbol: s, score: permuted[idx] }));
            target = targetBook(pairs);
          }
          nullTargets.set(d, target);

          let book: Map<string, number>;
          if (hold === 'h1') {
            book = target;
          } else {
            const past: Array<Map<string, number>> = [];
            for (let k = 0; k < 7; k++) {
              past.push(nullTargets.get(d - k * DAY_MS) ?? new Map());
            }
            book = staggeredBook(past);
          }

          // Cost and turnover
          const tradedCoins = new Set<string>([...book.keys(), ...nullPrevBook.keys()]);
          let cost = 0;
          const month = getMonthForDay(d);
          const rankMap = new Map<string, number>();
          if (month) {
            for (const m of month.members) {
              rankMap.set(m.symbol, m.rank);
            }
          }

          for (const sym of tradedCoins) {
            const w1 = book.get(sym) ?? 0;
            const w0 = nullPrevBook.get(sym) ?? 0;
            const tr = Math.abs(w1 - w0);
            if (tr > 1e-12) {
              cost += costOf(tr, rankMap.get(sym));
            }
          }

          const allCoinsMap = allCoinsByDay.get(d) ?? new Map();
          const { gross, funding } = valueBook(book, allCoinsMap);

          const rNet = gross + funding - cost;
          const x = Math.min(rNet / scale, 1);
          const step = stepEProcess(
            nullEState,
            { barTime: dayIdx + 1, x, b: 0 },
            { threshold: 200, lossUnbounded: true }
          );
          nullEState = step.state;
          if (nullEState.logE > maxLogE) {
            maxLogE = nullEState.logE;
          }

          nullPrevBook = book;
        }

        if (nullEState.crossedAt !== null) {
          crossingCount++;
        }
      }

      candidates.push({
        signal: sig,
        hold,
        scale,
        stats: {
          all: allStats,
          byYear,
        },
        power,
        null: {
          crossingCount,
          maxLogE,
        },
      });
    }
  }

  const output: Nv2PreviewOutput = {
    datasetHash: manifest.datasetHash,
    universeSha256: universe.sha256,
    top: options.top,
    generatedAt: new Date().toISOString(),
    candidates,
    series: allSeries,
  };

  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, JSON.stringify(output, null, 2), 'utf8');

  return output;
}

// CLI entry point
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const options = parseCliArgs(process.argv.slice(2));
  runPreview(options)
    .then((out) => {
      console.log(`NV2 preview complete. Generated output for ${out.candidates.length} candidates.`);
      console.log(`Saved output to ${options.out}`);
    })
    .catch((err) => {
      console.error('Error running NV2 preview:', err);
      process.exit(1);
    });
}
