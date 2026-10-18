import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { normalQuantile } from '../../src/lib/stats/normal';
import { pearson, rank } from '../../src/lib/stats/rank-ic';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';
import { readJsonlGz, sha256File } from './dataset-format';
import { NV1_SYMBOLS, c1Cutoff, readScoresFile, type ScoreRow } from './nv1-c1-scores';
import {
  CoinSeries,
  NV1_BALANCED_UNIVERSE,
  NV1_SEGMENTS,
  buildTrades,
  drawFraction,
  maxStandardised,
  nullMoments,
  nullN,
  quantile7,
  rotateWithinSpans,
  sumNetTrades,
} from './nv1-core';

export const NV1_C1 = {
  ks: [0, 1, 2, 3],
  hold: 24,
  stepMs: 3_600_000,
  costPct: 0.16,
  minShiftBars: 30 * 24,      // 30 days of 1h bars
  minTrades: 400,             // per k, else NOT ASSESSABLE
  minBlocks: 40,              // timeline hours / 168 must reach this
  blockHours: 168,
  alpha: 0.05,
  testStandardiseDraws: 1000, testStandardiseSeed: 20261018,
  testNullDraws: 10000, testNullSeed: 20261019,
  calReplays: 200, calReplaySeedBase: 20261100,
  calStandardiseDraws: 250, calNullDraws: 500,
  powerEdges: [0, 0.1, 0.2, 0.3],
} as const;

export const LOCK_GUARD_MESSAGE =
  'nv1: the C1 holdout test runs only after the Round 1 lock is committed';

/** Asserts that Round 1 lock file exists next to this script before running holdout test. */
export function assertLockPresent(scriptDir: string): void {
  const lockPath = join(scriptDir, 'next-version-v1.ts');
  if (!existsSync(lockPath)) {
    throw new Error(LOCK_GUARD_MESSAGE);
  }
}

/** +1 where score >= c90, -1 where score <= -c90, else 0 (NaN gives 0). */
export function sidesFromScores(score: number[], c90: number): number[] {
  const n = score.length;
  const result = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const s = score[i];
    if (s >= c90) {
      result[i] = 1;
    } else if (s <= -c90) {
      result[i] = -1;
    } else {
      result[i] = 0;
    }
  }
  return result;
}

/** Filter symbol rows in [start, end) on the 1h grid, sorted by t, side from sidesFromScores. */
export function coinSeriesInWindow(
  rows: readonly ScoreRow[],
  symbol: string,
  start: number,
  end: number,
  c90: number
): CoinSeries {
  const filtered: ScoreRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.symbol === symbol && r.t >= start && r.t < end && r.t % NV1_C1.stepMs === 0) {
      filtered.push(r);
    }
  }
  filtered.sort((a, b) => a.t - b.t);

  const n = filtered.length;
  const t = new Array<number>(n);
  const close = new Array<number>(n);
  const scores = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    t[i] = filtered[i].t;
    close[i] = filtered[i].close;
    const s = filtered[i].score;
    scores[i] = s !== null && Number.isFinite(s) ? s : Number.NaN;
  }

  const side = sidesFromScores(scores, c90);
  return {
    symbol,
    t,
    close,
    side,
  };
}

/** Pooled sumNetTrades with NV1_C1 options (no blocking). */
export function observedN(
  coins: CoinSeries[],
  k: number,
  from: number,
  to: number
): { n: number; trades: number } {
  let pooledSum = 0;
  let pooledCount = 0;

  for (let c = 0; c < coins.length; c++) {
    const res = sumNetTrades(coins[c], {
      k,
      hold: NV1_C1.hold,
      stepMs: NV1_C1.stepMs,
      costPct: NV1_C1.costPct,
      from,
      to,
    });
    pooledSum += res.sum;
    pooledCount += res.count;
  }

  return {
    n: pooledCount > 0 ? pooledSum / pooledCount : Number.NaN,
    trades: pooledCount,
  };
}

/** trades >= 400 and timelineHours / 168 >= 40. */
export function assessable(trades: number, timelineHours: number): boolean {
  return trades >= NV1_C1.minTrades && timelineHours / NV1_C1.blockHours >= NV1_C1.minBlocks;
}

export interface MaxTestResult {
  nK: number[];
  tradesK: number[];
  assessableK: boolean[];
  maxObs: number;
  nullMax: number[];
  p: number;
  critical95: number;
  argmaxK: number | null;
  pass: boolean;
}

/** Max-over-k Monte Carlo gate test against persistence-preserving null. */
export function maxTest(
  coins: CoinSeries[],
  from: number,
  to: number,
  standardiseDraws: number,
  standardiseSeed: number,
  nullDraws: number,
  nullSeed: number
): MaxTestResult {
  const timelineHours = (to - from) / NV1_C1.stepMs;
  const ks = [...NV1_C1.ks];
  const nK: number[] = [];
  const tradesK: number[] = [];
  const assessableK: boolean[] = [];

  for (let ki = 0; ki < ks.length; ki++) {
    const k = ks[ki];
    const obs = observedN(coins, k, from, to);
    nK.push(obs.n);
    tradesK.push(obs.trades);
    assessableK.push(assessable(obs.trades, timelineHours));
  }

  const base = {
    hold: NV1_C1.hold,
    stepMs: NV1_C1.stepMs,
    costPct: NV1_C1.costPct,
    from,
    to,
  };

  const stdMatrix = nullN(coins, ks, base, standardiseDraws, NV1_C1.minShiftBars, standardiseSeed);
  const moments = nullMoments(stdMatrix);

  const maxObs = maxStandardised(nK, moments, assessableK);

  const nullMatrix = nullN(coins, ks, base, nullDraws, NV1_C1.minShiftBars, nullSeed);
  const nullMax = new Array<number>(nullDraws);
  for (let i = 0; i < nullDraws; i++) {
    nullMax[i] = maxStandardised(nullMatrix[i], moments, assessableK);
  }

  let countGe = 0;
  if (Number.isFinite(maxObs)) {
    for (let i = 0; i < nullMax.length; i++) {
      if (nullMax[i] >= maxObs) {
        countGe++;
      }
    }
  }
  const p = (1 + countGe) / (1 + nullDraws);

  const finiteNullMax = nullMax.filter(Number.isFinite);
  const critical95 = quantile7(finiteNullMax.length > 0 ? finiteNullMax : nullMax, 0.95);

  let argmaxK: number | null = null;
  let bestZ = -Infinity;
  for (let ki = 0; ki < ks.length; ki++) {
    if (!assessableK[ki]) continue;
    const sd = moments.sd[ki];
    const mean = moments.mean[ki];
    if (sd > 0) {
      const z = (nK[ki] - mean) / sd;
      if (Number.isFinite(z) && z > bestZ) {
        bestZ = z;
        argmaxK = ks[ki];
      }
    }
  }

  const argmaxIdx = argmaxK !== null ? (ks as readonly number[]).indexOf(argmaxK) : -1;
  const pass =
    argmaxK !== null &&
    Number.isFinite(maxObs) &&
    maxObs > critical95 &&
    argmaxIdx >= 0 &&
    nK[argmaxIdx] > 0;

  return {
    nK,
    tradesK,
    assessableK,
    maxObs,
    nullMax,
    p,
    critical95,
    argmaxK,
    pass,
  };
}

/** Computes two-sided Wilson score confidence interval for binomial proportion. */
export function wilsonScoreInterval(
  successes: number,
  trials: number,
  confidence = 0.95
): [number, number] {
  if (trials <= 0) return [0, 0];
  const p = successes / trials;
  const z = confidence === 0.95 ? 1.959963984540054 : normalQuantile(1 - (1 - confidence) / 2);
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) / denom;
  const lower = successes === 0 ? 0 : Math.max(0, center - half);
  const upper = successes === trials ? 1 : Math.min(1, center + half);
  return [lower, upper];
}

/** One-sided upper binomial p-value under p = 0.5. */
export function binomialSignTestP(positiveCount: number, totalCount: number): number {
  if (totalCount <= 0) return 1;
  let pVal = 0;
  for (let j = positiveCount; j <= totalCount; j++) {
    let comb = 1;
    for (let i = 1; i <= j; i++) {
      comb = (comb * (totalCount - i + 1)) / i;
    }
    pVal += comb * Math.pow(0.5, totalCount);
  }
  return pVal;
}

function restrictCoin(coin: CoinSeries, start: number, end: number): CoinSeries {
  const t: number[] = [];
  const close: number[] = [];
  const side: number[] = [];
  for (let i = 0; i < coin.t.length; i++) {
    const ti = coin.t[i];
    if (ti >= start && ti < end) {
      t.push(ti);
      close.push(coin.close[i]);
      side.push(coin.side[i]);
    }
  }
  return {
    symbol: coin.symbol,
    t,
    close,
    side,
  };
}

export interface CalibrateEdgeResult {
  edge: number;
  passes: number;
  replays: number;
  passRate: number;
  rate: number;
  wilson95: [number, number];
  argmaxShare: Record<number, number>;
}

export interface CalibrateResult {
  replays: number;
  falsePassRate: number;
  edges: CalibrateEdgeResult[];
  byEdge: Record<number, CalibrateEdgeResult>;
}

/** Calibration of false-pass rate and power across development segments B and C. */
export function calibrate(
  coinsBC: CoinSeries[],
  replays: number,
  seedBase: number,
  standardiseDraws: number,
  nullDraws: number,
  powerEdges: readonly number[]
): CalibrateResult {
  const aLenMs = NV1_SEGMENTS.A2.end - NV1_SEGMENTS.A1.start;
  const bcStart = NV1_SEGMENTS.B.start;
  const bcEnd = NV1_SEGMENTS.C.end;
  const maxOffsetBars = Math.floor((bcEnd - bcStart - aLenMs) / NV1_C1.stepMs);

  const passesPerEdge = new Array<number>(powerEdges.length).fill(0);
  const argmaxCountPerEdge: Array<Record<number, number>> = powerEdges.map(() => ({}));
  for (let edgeIdx = 0; edgeIdx < powerEdges.length; edgeIdx++) {
    for (const k of NV1_C1.ks) {
      argmaxCountPerEdge[edgeIdx][k] = 0;
    }
  }

  const ks = [...NV1_C1.ks];

  for (let i = 0; i < replays; i++) {
    const replaySeed = seedBase + i;
    const replayRandom = createSeededRandom(replaySeed);

    const offsetBars = maxOffsetBars > 0 ? Math.floor(replayRandom() * (maxOffsetBars + 1)) : 0;
    const sliceStart = bcStart + offsetBars * NV1_C1.stepMs;
    const sliceEnd = sliceStart + aLenMs;

    const sliceCoins = coinsBC.map((coin) => restrictCoin(coin, sliceStart, sliceEnd));

    const u = drawFraction(sliceCoins, NV1_C1.minShiftBars, replayRandom);
    const { coins: pseudoCoins } = rotateWithinSpans(sliceCoins, u);

    const timelineHours = (sliceEnd - sliceStart) / NV1_C1.stepMs;
    const nK = new Array<number>(ks.length);
    const assessableK = new Array<boolean>(ks.length);

    for (let ki = 0; ki < ks.length; ki++) {
      const k = ks[ki];
      const obs = observedN(pseudoCoins, k, sliceStart, sliceEnd);
      nK[ki] = obs.n;
      assessableK[ki] = assessable(obs.trades, timelineHours);
    }

    const stdSeed = ((replaySeed * 1000 + 1) >>> 0);
    const nullSeed = ((replaySeed * 1000 + 2) >>> 0);

    const base = {
      hold: NV1_C1.hold,
      stepMs: NV1_C1.stepMs,
      costPct: NV1_C1.costPct,
      from: sliceStart,
      to: sliceEnd,
    };

    const stdMatrix = nullN(pseudoCoins, ks, base, standardiseDraws, NV1_C1.minShiftBars, stdSeed);
    const moments = nullMoments(stdMatrix);

    const nullMatrix = nullN(pseudoCoins, ks, base, nullDraws, NV1_C1.minShiftBars, nullSeed);
    const nullMax = nullMatrix.map((row) => maxStandardised(row, moments, assessableK));
    const finiteNullMax = nullMax.filter(Number.isFinite);
    const critical95 = quantile7(finiteNullMax.length > 0 ? finiteNullMax : nullMax, 0.95);

    for (let edgeIdx = 0; edgeIdx < powerEdges.length; edgeIdx++) {
      const edge = powerEdges[edgeIdx];
      const nK_E = nK.map((v) => v + edge);
      const maxObs_E = maxStandardised(nK_E, moments, assessableK);

      let argmaxK_E: number | null = null;
      let bestZ_E = -Infinity;
      for (let ki = 0; ki < ks.length; ki++) {
        if (!assessableK[ki]) continue;
        const sd = moments.sd[ki];
        const mean = moments.mean[ki];
        if (sd > 0) {
          const z = (nK_E[ki] - mean) / sd;
          if (Number.isFinite(z) && z > bestZ_E) {
            bestZ_E = z;
            argmaxK_E = ks[ki];
          }
        }
      }

      const argmaxIdx = argmaxK_E !== null ? (ks as readonly number[]).indexOf(argmaxK_E) : -1;
      const pass_E =
        argmaxK_E !== null &&
        Number.isFinite(maxObs_E) &&
        maxObs_E > critical95 &&
        argmaxIdx >= 0 &&
        nK_E[argmaxIdx] > 0;

      if (pass_E) {
        passesPerEdge[edgeIdx]++;
      }
      if (argmaxK_E !== null) {
        argmaxCountPerEdge[edgeIdx][argmaxK_E]++;
      }
    }
  }

  const edgeResults: CalibrateEdgeResult[] = [];
  for (let edgeIdx = 0; edgeIdx < powerEdges.length; edgeIdx++) {
    const edge = powerEdges[edgeIdx];
    const passes = passesPerEdge[edgeIdx];
    const passRate = replays > 0 ? passes / replays : 0;
    const wilson95 = wilsonScoreInterval(passes, replays, 0.95);
    const argmaxShare: Record<number, number> = {};
    for (const k of ks) {
      argmaxShare[k] = replays > 0 ? (argmaxCountPerEdge[edgeIdx][k] || 0) / replays : 0;
    }
    edgeResults.push({
      edge,
      passes,
      replays,
      passRate,
      rate: passRate,
      wilson95,
      argmaxShare,
    });
  }

  const edge0 = edgeResults.find((r) => r.edge === 0);
  const falsePassRate = edge0 ? edge0.passRate : 0;

  return {
    replays,
    falsePassRate,
    edges: edgeResults,
    byEdge: Object.fromEntries(edgeResults.map((r) => [r.edge, r])),
  };
}

export interface CalibrateCliArgs {
  command: 'calibrate';
  scores: string;
  c90: number;
  out: string;
}

export interface TestCliArgs {
  command: 'test';
  scores: string;
  c90: number;
  out: string;
  c85?: number;
  c95?: number;
}

export interface ParityCliArgs {
  command: 'parity';
  scores: string;
  v8rows: string;
  out: string;
  c90?: number;
}

export type CliArgs = CalibrateCliArgs | TestCliArgs | ParityCliArgs;

export function parseCliArgs(argv: string[]): CliArgs {
  if (argv.length === 0) {
    throw new Error('No command specified. Expected "calibrate", "test", or "parity".');
  }

  const command = argv[0];

  if (command === 'calibrate') {
    let scores: string | null = null;
    let c90: number | null = null;
    let out: string | null = null;

    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      const nextVal = (): string => {
        const val = argv[++i];
        if (val === undefined || val.startsWith('--')) {
          throw new Error(`${flag} requires a value`);
        }
        return val;
      };

      if (flag === '--scores') scores = nextVal();
      else if (flag === '--c90') c90 = Number(nextVal());
      else if (flag === '--out') out = nextVal();
      else throw new Error(`Unknown flag "${flag}" for calibrate command`);
    }

    if (!scores) throw new Error('--scores is required');
    if (c90 === null || !Number.isFinite(c90)) throw new Error('--c90 is required');
    if (!out) throw new Error('--out is required');

    return { command: 'calibrate', scores, c90, out };
  }

  if (command === 'test') {
    let scores: string | null = null;
    let c90: number | null = null;
    let out: string | null = null;
    let c85: number | undefined;
    let c95: number | undefined;

    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      const nextVal = (): string => {
        const val = argv[++i];
        if (val === undefined || val.startsWith('--')) {
          throw new Error(`${flag} requires a value`);
        }
        return val;
      };

      if (flag === '--scores') scores = nextVal();
      else if (flag === '--c90') c90 = Number(nextVal());
      else if (flag === '--out') out = nextVal();
      else if (flag === '--c85') c85 = Number(nextVal());
      else if (flag === '--c95') c95 = Number(nextVal());
      else throw new Error(`Unknown flag "${flag}" for test command`);
    }

    if (!scores) throw new Error('--scores is required');
    if (c90 === null || !Number.isFinite(c90)) throw new Error('--c90 is required');
    if (!out) throw new Error('--out is required');

    return { command: 'test', scores, c90, out, c85, c95 };
  }

  if (command === 'parity') {
    let scores: string | null = null;
    let v8rows: string | null = null;
    let out: string | null = null;
    let c90: number | undefined;

    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      const nextVal = (): string => {
        const val = argv[++i];
        if (val === undefined || val.startsWith('--')) {
          throw new Error(`${flag} requires a value`);
        }
        return val;
      };

      if (flag === '--scores') scores = nextVal();
      else if (flag === '--v8rows') v8rows = nextVal();
      else if (flag === '--out') out = nextVal();
      else if (flag === '--c90') c90 = Number(nextVal());
      else throw new Error(`Unknown flag "${flag}" for parity command`);
    }

    if (!scores) throw new Error('--scores is required');
    if (!v8rows) throw new Error('--v8rows is required');
    if (!out) throw new Error('--out is required');

    return { command: 'parity', scores, v8rows, out, c90 };
  }

  throw new Error(`Unknown command "${command}". Expected "calibrate", "test", or "parity".`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);

  if (args.command === 'calibrate') {
    const startedAt = Date.now();
    const scoresSha256 = await sha256File(args.scores);
    const scoreRows = readScoresFile(args.scores);

    const coinsBC = NV1_SYMBOLS.map((symbol) =>
      coinSeriesInWindow(scoreRows, symbol, NV1_SEGMENTS.B.start, NV1_SEGMENTS.C.end, args.c90)
    );

    const result = calibrate(
      coinsBC,
      NV1_C1.calReplays,
      NV1_C1.calReplaySeedBase,
      NV1_C1.calStandardiseDraws,
      NV1_C1.calNullDraws,
      NV1_C1.powerEdges
    );

    const elapsedMs = Date.now() - startedAt;

    const output = {
      command: 'calibrate',
      inputs: {
        scores: args.scores,
        scoresSha256,
        c90: args.c90,
      },
      constants: NV1_C1,
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        elapsedMs,
      },
      result,
    };

    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(output, null, 2));

    for (const e of result.edges) {
      const kShares = NV1_C1.ks
        .map((k) => `k${k}=${(e.argmaxShare[k] || 0).toFixed(2)}`)
        .join(', ');
      console.log(
        `E = ${e.edge.toFixed(1)}: pass rate ${e.passRate.toFixed(3)} (Wilson 95%: [${e.wilson95[0].toFixed(3)}, ${e.wilson95[1].toFixed(3)}]), argmax shares: ${kShares}`
      );
    }
    return;
  }

  if (args.command === 'test') {
    try {
      assertLockPresent(__dirname);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }

    const startedAt = Date.now();
    const scoresSha256 = await sha256File(args.scores);
    const scoreRows = readScoresFile(args.scores);

    const fromA = NV1_SEGMENTS.A1.start;
    const toA = NV1_SEGMENTS.A2.end;
    const coinsA = NV1_SYMBOLS.map((symbol) =>
      coinSeriesInWindow(scoreRows, symbol, fromA, toA, args.c90)
    );

    const mainResult = maxTest(
      coinsA,
      fromA,
      toA,
      NV1_C1.testStandardiseDraws,
      NV1_C1.testStandardiseSeed,
      NV1_C1.testNullDraws,
      NV1_C1.testNullSeed
    );

    const segmentReport: Record<
      string,
      { nK: number[]; tradesK: number[] }
    > = {};
    const segments: Array<keyof typeof NV1_SEGMENTS> = ['A1', 'A2', 'B', 'C'];
    for (const segKey of segments) {
      const seg = NV1_SEGMENTS[segKey];
      const segCoins = NV1_SYMBOLS.map((symbol) =>
        coinSeriesInWindow(scoreRows, symbol, seg.start, seg.end, args.c90)
      );
      const segNK: number[] = [];
      const segTradesK: number[] = [];
      for (const k of NV1_C1.ks) {
        const obs = observedN(segCoins, k, seg.start, seg.end);
        segNK.push(obs.n);
        segTradesK.push(obs.trades);
      }
      segmentReport[segKey] = { nK: segNK, tradesK: segTradesK };
    }

    const balancedCoinsA = NV1_BALANCED_UNIVERSE.map((symbol) =>
      coinSeriesInWindow(scoreRows, symbol, fromA, toA, args.c90)
    );
    const balancedSegmentReport: Record<
      string,
      { nK: number[]; tradesK: number[] }
    > = {};
    for (const segKey of segments) {
      const seg = NV1_SEGMENTS[segKey];
      const segCoins = NV1_BALANCED_UNIVERSE.map((symbol) =>
        coinSeriesInWindow(scoreRows, symbol, seg.start, seg.end, args.c90)
      );
      const segNK: number[] = [];
      const segTradesK: number[] = [];
      for (const k of NV1_C1.ks) {
        const obs = observedN(segCoins, k, seg.start, seg.end);
        segNK.push(obs.n);
        segTradesK.push(obs.trades);
      }
      balancedSegmentReport[segKey] = { nK: segNK, tradesK: segTradesK };
    }

    const argmaxK = mainResult.argmaxK ?? NV1_C1.ks[0];
    const calendarYears = [2017, 2018, 2019, 2020, 2021];
    const yearlyResults: Array<{ year: number; n: number; trades: number; positive: boolean }> = [];
    let positiveYearCount = 0;

    for (const year of calendarYears) {
      const yearStart = Math.max(Date.UTC(year, 0, 1), fromA);
      const yearEnd = Math.min(Date.UTC(year + 1, 0, 1), toA);
      const obs = observedN(coinsA, argmaxK, yearStart, yearEnd);
      const positive = Number.isFinite(obs.n) && obs.n > 0;
      if (positive) positiveYearCount++;
      yearlyResults.push({
        year,
        n: obs.n,
        trades: obs.trades,
        positive,
      });
    }

    const signTestP = binomialSignTestP(positiveYearCount, calendarYears.length);

    const tradesArgmaxK = coinsA.flatMap((coin) =>
      buildTrades(coin, {
        k: argmaxK,
        hold: NV1_C1.hold,
        stepMs: NV1_C1.stepMs,
        costPct: NV1_C1.costPct,
        from: fromA,
        to: toA,
      })
    );
    const buyCount = tradesArgmaxK.filter((t) => t.d === 1).length;
    const sellCount = tradesArgmaxK.filter((t) => t.d === -1).length;
    const totalTrades = buyCount + sellCount;
    const buySellShare = {
      buyCount,
      sellCount,
      totalTrades,
      buyShare: totalTrades > 0 ? buyCount / totalTrades : 0,
      sellShare: totalTrades > 0 ? sellCount / totalTrades : 0,
    };

    const grossNK: number[] = [];
    for (const k of NV1_C1.ks) {
      let pooledSum = 0;
      let pooledCount = 0;
      for (const c of coinsA) {
        const res = sumNetTrades(c, {
          k,
          hold: NV1_C1.hold,
          stepMs: NV1_C1.stepMs,
          costPct: 0,
          from: fromA,
          to: toA,
        });
        pooledSum += res.sum;
        pooledCount += res.count;
      }
      grossNK.push(pooledCount > 0 ? pooledSum / pooledCount : Number.NaN);
    }

    let plateauReport: {
      c85?: number;
      result85?: MaxTestResult;
      c95?: number;
      result95?: MaxTestResult;
    } | null = null;

    if (args.c85 !== undefined && args.c95 !== undefined) {
      const coins85 = NV1_SYMBOLS.map((symbol) =>
        coinSeriesInWindow(scoreRows, symbol, fromA, toA, args.c85!)
      );
      const res85 = maxTest(
        coins85,
        fromA,
        toA,
        NV1_C1.testStandardiseDraws,
        NV1_C1.testStandardiseSeed,
        NV1_C1.testNullDraws,
        NV1_C1.testNullSeed
      );

      const coins95 = NV1_SYMBOLS.map((symbol) =>
        coinSeriesInWindow(scoreRows, symbol, fromA, toA, args.c95!)
      );
      const res95 = maxTest(
        coins95,
        fromA,
        toA,
        NV1_C1.testStandardiseDraws,
        NV1_C1.testStandardiseSeed,
        NV1_C1.testNullDraws,
        NV1_C1.testNullSeed
      );

      plateauReport = {
        c85: args.c85,
        result85: res85,
        c95: args.c95,
        result95: res95,
      };
    }

    const elapsedMs = Date.now() - startedAt;

    const output = {
      command: 'test',
      inputs: {
        scores: args.scores,
        scoresSha256,
        c90: args.c90,
        c85: args.c85,
        c95: args.c95,
      },
      constants: NV1_C1,
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        elapsedMs,
      },
      testResult: mainResult,
      reported: {
        segments: segmentReport,
        balancedUniverse: {
          holdoutA: {
            nK: NV1_C1.ks.map((k) => observedN(balancedCoinsA, k, fromA, toA).n),
            tradesK: NV1_C1.ks.map((k) => observedN(balancedCoinsA, k, fromA, toA).trades),
          },
          segments: balancedSegmentReport,
        },
        yearlyInA: {
          argmaxK,
          years: yearlyResults,
          positiveYearCount,
          totalYears: calendarYears.length,
          signTestP,
        },
        buySellShare,
        grossN: {
          grossNK,
          argmaxGrossN: grossNK[(NV1_C1.ks as readonly number[]).indexOf(argmaxK)],
        },
        plateau: plateauReport,
      },
    };

    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(output, null, 2));

    console.log(
      `Holdout A test result: pass=${mainResult.pass}, p=${mainResult.p.toFixed(5)}, maxObs=${mainResult.maxObs.toFixed(3)}, critical95=${mainResult.critical95.toFixed(3)}, argmaxK=${mainResult.argmaxK}`
    );
    return;
  }

  if (args.command === 'parity') {
    const startedAt = Date.now();
    const scoreRows = readScoresFile(args.scores);
    const v8Rows = readJsonlGz<{
      symbol: string;
      interval?: string;
      tradingStyle?: string;
      tier?: string;
      score?: number;
      candleTimestamp?: number;
      t?: number;
    }>(args.v8rows);

    const devSegments = [NV1_SEGMENTS.B, NV1_SEGMENTS.C];
    const c90 = args.c90 !== undefined ? args.c90 : c1Cutoff(scoreRows, devSegments);

    const v8Map = new Map<string, { score: number; tier: string }>();
    for (const r of v8Rows) {
      if (r.tradingStyle === 'day_trading' && r.interval === '1h') {
        const t = r.candleTimestamp ?? r.t;
        if (t !== undefined && r.score !== undefined && Number.isFinite(r.score)) {
          v8Map.set(`${r.symbol}:${t}`, { score: r.score, tier: r.tier || '' });
        }
      }
    }

    const scoresIntraday: number[] = [];
    const scoresV8: number[] = [];
    let agreeCount = 0;

    for (const r of scoreRows) {
      if (r.score === null || !Number.isFinite(r.score)) continue;
      const key = `${r.symbol}:${r.t}`;
      const v8 = v8Map.get(key);
      if (v8 === undefined) continue;

      scoresIntraday.push(r.score);
      scoresV8.push(v8.score);

      const sideIntraday = r.score >= c90 ? 1 : r.score <= -c90 ? -1 : 0;
      const tierLower = v8.tier.toLowerCase();
      const sideV8 =
        tierLower === 'buy' || tierLower === 'strong_buy'
          ? 1
          : tierLower === 'sell' || tierLower === 'strong_sell'
          ? -1
          : 0;

      if (sideIntraday === sideV8) {
        agreeCount++;
      }
    }

    const matchedBars = scoresIntraday.length;
    const agreementRate = matchedBars > 0 ? agreeCount / matchedBars : 0;
    const pearsonCorr = matchedBars > 1 ? pearson(scoresIntraday, scoresV8) : Number.NaN;
    const spearmanCorr =
      matchedBars > 1 ? pearson(rank(scoresIntraday), rank(scoresV8)) : Number.NaN;

    const elapsedMs = Date.now() - startedAt;

    const output = {
      command: 'parity',
      inputs: {
        scores: args.scores,
        v8rows: args.v8rows,
        c90,
      },
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        elapsedMs,
      },
      result: {
        matchedBars,
        agreementRate,
        agreeCount,
        pearson: pearsonCorr,
        spearman: spearmanCorr,
      },
    };

    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(output, null, 2));

    console.log(JSON.stringify(output.result));
    return;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
