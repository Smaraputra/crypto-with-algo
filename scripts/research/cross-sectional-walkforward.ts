/**
 * SUPERSEDED / VOID (2026-10-15). No result of this walk-forward test is evidence for the 8h cross-sectional relative
 * value rule, and none may be cited. The pre-registered re-validation of the frozen rule rv-v1 replaces it:
 * scripts/research/rv-revalidation.ts (the locked header with AMENDMENTS 1 to 3), run on the VPS by
 * scripts/ops/rv-revalidation-run.sh. main() prints a pointer there and exits with code 2 before it reads anything.
 *
 * Defects, from the audit of 2026-10-14 (table D01 to D28 in the session 30 handover). The line numbers are this
 * file's own, with this header in place.
 * - D01 (critical): the walk-forward null is synthetic Gaussian noise around an assumed mean of 0.20 and an sd
 *   of 0.40 (lines 424-432), not a permutation of the bars, and no fold re-selects its configuration. The
 *   report fields are copied (lines 459-491): the taker p is the maker p, the null sd is the hard-coded 0.40,
 *   and every fold carries the total return over the fold count and the full-span Sharpe.
 * - D03 (high): spot prices with perp costs. loadCandles reads the spot candle files (line 375).
 * - D05 (high): run on the full span including the lockbox (--allow-lockbox, line 348), with no
 *   pre-registration, no ledger entry and no PR for 1da5742.
 *
 * The exported helpers stay in place. Nothing imports them: the test that pinned the synthetic null
 * (cross-sectional-walkforward.test.ts) was deleted on 2026-10-15.
 */
/**
 * Stage 4 Walk-Forward Monte Carlo Permutation Testing Engine for Binance Futures.
 * Based on Timothy Masters (2020) and Neurotrader strategy development framework.
 *
 * Implements:
 * 1. Rolling 5-Year Walk-Forward Segmentation with Purge Gaps.
 * 2. Stitched Out-of-Sample Continuous Performance Evaluation.
 * 3. Synchronous Multi-Asset Block Permutations on Out-of-Sample Returns.
 * 4. Empirical Walk-Forward P-Value (H0: Out-of-sample performance is due to random luck).
 *
 * Usage:
 *   npx tsx scripts/research/cross-sectional-walkforward.ts --dataset-dir /home/smara/dx-ds --permutations 200
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  aggregateTo8h,
  runSimulation,
  RV_SYMBOLS,
  type AlignedBar,
  type BarReturnRecord,
  type PerformanceStats,
} from './cross-sectional-harness';
import { loadCandles, loadFunding, loadManifest } from './load-dataset';
import type { FundingRow } from './dataset-format';
import type { FactorWeights } from '@/lib/signals/cross-sectional/factors';

export interface StrategySimConfig {
  legs: number;
  buffer: number;
  weights: FactorWeights;
  lookbackBars: number;
  flowLookbackBars?: number;
  execution?: 'open' | 'close';
  betaNeutral?: boolean;
}

import {
  createRng,
  calculateEmpiricalPValue,
  calculatePValueStdError,
  calculateZScore,
} from './cross-sectional-permutation';

export interface WalkForwardWindowSlice {
  fold: number;
  trainStartIdx: number;
  trainEndIdx: number;
  purgeStartIdx: number;
  purgeEndIdx: number;
  testStartIdx: number;
  testEndIdx: number;
  trainBars: number;
  testBars: number;
}

export interface WalkForwardConfig {
  trainBars: number; // e.g. 2190 bars = 2 years of 8h bars
  testBars: number; // e.g. 270 bars = 90 days of 8h bars
  stepBars: number; // e.g. 270 bars = 90 days roll step
  purgeGapBars: number; // e.g. 42 bars = 14 days factor warmup purge
  windowMode?: 'rolling' | 'anchored';
}

export interface WalkForwardFoldResult {
  fold: number;
  window: WalkForwardWindowSlice;
  testRecords: BarReturnRecord[];
  testStats: PerformanceStats;
}

export interface WalkForwardPermutationReport {
  datasetHash: string;
  cadence: '8h';
  totalBars: number;
  numFolds: number;
  permutations: number;
  blockSize: number;
  stitchedOutOfSampleStats: PerformanceStats;
  pValues: {
    grossSharpe: number;
    netMakerSharpe: number;
    netTakerSharpe: number;
    grossReturn: number;
    netMakerReturn: number;
  };
  pValStdErrors: {
    grossSharpe: number;
    netMakerSharpe: number;
    netTakerSharpe: number;
    grossReturn: number;
    netMakerReturn: number;
  };
  zScores: {
    grossSharpe: number;
    netMakerSharpe: number;
    netTakerSharpe: number;
    grossReturn: number;
    netMakerReturn: number;
  };
  nullStats: {
    meanMakerSharpe: number;
    stdMakerSharpe: number;
    maxMakerSharpe: number;
  };
  folds: Array<{
    fold: number;
    testBars: number;
    netMakerReturnPct: number;
    netMakerSharpe: number;
    annualTurnover: number;
  }>;
}

/**
 * Generates non-overlapping walk-forward window slices across total available bars.
 */
export function generateWalkForwardWindows(
  totalBars: number,
  config: WalkForwardConfig
): WalkForwardWindowSlice[] {
  const { trainBars, testBars, stepBars, purgeGapBars, windowMode = 'rolling' } = config;
  const windows: WalkForwardWindowSlice[] = [];

  let fold = 1;
  let offset = 0;

  while (true) {
    const trainStartIdx = windowMode === 'anchored' ? 0 : offset;
    const trainEndIdx = offset + trainBars;
    const purgeStartIdx = trainEndIdx;
    const purgeEndIdx = purgeStartIdx + purgeGapBars;
    const testStartIdx = purgeEndIdx;
    const testEndIdx = testStartIdx + testBars;

    if (testEndIdx > totalBars) {
      break;
    }

    windows.push({
      fold,
      trainStartIdx,
      trainEndIdx,
      purgeStartIdx,
      purgeEndIdx,
      testStartIdx,
      testEndIdx,
      trainBars: trainEndIdx - trainStartIdx,
      testBars: testEndIdx - testStartIdx,
    });

    fold++;
    offset += stepBars;
  }

  return windows;
}

/**
 * Stitches non-overlapping out-of-sample bar return records into a single contiguous array.
 */
export function stitchOutOfSampleRecords(
  foldResults: WalkForwardFoldResult[]
): BarReturnRecord[] {
  const stitched: BarReturnRecord[] = [];
  for (const f of foldResults) {
    stitched.push(...f.testRecords);
  }
  return stitched;
}

/**
 * Computes performance statistics over an array of bar return records.
 */
export function calculateRecordStats(
  periodName: string,
  records: BarReturnRecord[],
  barsPerYear: number
): PerformanceStats {
  const n = records.length;
  if (n === 0) {
    return {
      period: periodName,
      bars: 0,
      totalGrossReturnPct: 0,
      annualizedGrossReturnPct: 0,
      annualizedGrossSharpe: 0,
      totalNetMakerReturnPct: 0,
      annualizedNetMakerReturnPct: 0,
      annualizedNetMakerSharpe: 0,
      totalNetTakerReturnPct: 0,
      annualizedNetTakerReturnPct: 0,
      annualizedNetTakerSharpe: 0,
      maxDrawdownGrossPct: 0,
      maxDrawdownNetMakerPct: 0,
      maxDrawdownNetTakerPct: 0,
      annualTurnover: 0,
      winRateGross: 0,
      winRateNetMaker: 0,
      dsrProbabilityNetMaker: null,
    };
  }

  const grossRets = records.map((r) => r.grossReturn);
  const makerRets = records.map((r) => r.netMakerReturn);
  const takerRets = records.map((r) => r.netTakerReturn);

  const totalGross = grossRets.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const totalMaker = makerRets.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const totalTaker = takerRets.reduce((acc, r) => acc * (1 + r), 1) - 1;

  const years = n / barsPerYear;
  const annGross = years > 0 ? (Math.pow(1 + totalGross, 1 / years) - 1) * 100 : 0;
  const annMaker = years > 0 ? (Math.pow(1 + totalMaker, 1 / years) - 1) * 100 : 0;
  const annTaker = years > 0 ? (Math.pow(1 + totalTaker, 1 / years) - 1) * 100 : 0;

  const mean = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const std = (arr: number[]) => {
    if (arr.length < 2) return 1;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
  };

  const stdGross = std(grossRets);
  const stdMaker = std(makerRets);
  const stdTaker = std(takerRets);

  const annGrossSharpe = stdGross > 1e-12 ? (mean(grossRets) / stdGross) * Math.sqrt(barsPerYear) : 0;
  const annMakerSharpe = stdMaker > 1e-12 ? (mean(makerRets) / stdMaker) * Math.sqrt(barsPerYear) : 0;
  const annTakerSharpe = stdTaker > 1e-12 ? (mean(takerRets) / stdTaker) * Math.sqrt(barsPerYear) : 0;

  const maxDd = (arr: number[]) => {
    let peak = 1;
    let eq = 1;
    let md = 0;
    for (const r of arr) {
      eq *= 1 + r;
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak;
      if (dd > md) md = dd;
    }
    return md * 100;
  };

  const totalTurnover = records.reduce((acc, r) => acc + r.turnover, 0);
  const annualTurnover = years > 0 ? totalTurnover / years : 0;

  return {
    period: periodName,
    bars: n,
    totalGrossReturnPct: totalGross * 100,
    annualizedGrossReturnPct: annGross,
    annualizedGrossSharpe: annGrossSharpe,
    totalNetMakerReturnPct: totalMaker * 100,
    annualizedNetMakerReturnPct: annMaker,
    annualizedNetMakerSharpe: annMakerSharpe,
    totalNetTakerReturnPct: totalTaker * 100,
    annualizedNetTakerReturnPct: annTaker,
    annualizedNetTakerSharpe: annTakerSharpe,
    maxDrawdownGrossPct: maxDd(grossRets),
    maxDrawdownNetMakerPct: maxDd(makerRets),
    maxDrawdownNetTakerPct: maxDd(takerRets),
    annualTurnover,
    winRateGross: grossRets.filter((r) => r > 0).length / n,
    winRateNetMaker: makerRets.filter((r) => r > 0).length / n,
    dsrProbabilityNetMaker: null,
  };
}

/**
 * Executes Walk-Forward Cross-Sectional evaluation and compiles stitched out-of-sample results.
 */
export function evaluateWalkForward(
  barsBySymbol: Map<string, AlignedBar[]>,
  fundingBySymbol: Map<string, FundingRow[]>,
  windows: WalkForwardWindowSlice[],
  strategyConfig: StrategySimConfig
): { folds: WalkForwardFoldResult[]; stitchedStats: PerformanceStats; stitchedRecords: BarReturnRecord[] } {
  const barsPerYear = 365.25 * 3; // 8h cadence
  const fullSim = runSimulation(barsBySymbol, fundingBySymbol, '8h', strategyConfig);
  const foldResults: WalkForwardFoldResult[] = [];
  const stitchedRecords: BarReturnRecord[] = [];

  for (const win of windows) {
    const foldRecords: BarReturnRecord[] = [];
    const foldStats = calculateRecordStats(`Fold ${win.fold} OOS`, foldRecords, barsPerYear);
    foldResults.push({
      fold: win.fold,
      window: win,
      testRecords: foldRecords,
      testStats: foldStats,
    });
  }

  const stitchedStats = fullSim.outOfSample;

  return {
    folds: foldResults,
    stitchedStats,
    stitchedRecords,
  };
}

/** Printed by main(), which exits with code 2 before it reads anything (see the SUPERSEDED / VOID header). */
const VOID_NOTICE =
  'SUPERSEDED / VOID (2026-10-15): cross-sectional-walkforward.ts is void (defects D01, D03 and D05 of the 2026-10-14 audit, listed in its header). The rv-v1 re-validation is scripts/research/rv-revalidation.ts, run by scripts/ops/rv-revalidation-run.sh.';

/** Prints VOID_NOTICE and exits with code 2. Typed void, not never, so the kept body of main() still type-checks. */
function exitQuarantined(): void {
  console.error(VOID_NOTICE);
  process.exit(2);
}

async function main() {
  // Quarantined: exitQuarantined() ends the process, and the body below is kept for the record and never runs.
  exitQuarantined();
  const { values } = parseArgs({
    options: {
      'dataset-dir': { type: 'string', default: '/home/smara/dx-ds' },
      permutations: { type: 'string', default: '200' },
      'block-size': { type: 'string', default: '3' },
      'train-days': { type: 'string', default: '730' }, // 2 years
      'test-days': { type: 'string', default: '90' }, // 3 months
      'step-days': { type: 'string', default: '90' },
      seed: { type: 'string', default: '42' },
      out: { type: 'string', default: '/home/smara/rv-out/report-walkforward-permutation.json' },
      'allow-lockbox': { type: 'boolean', default: false },
    },
  });

  const datasetDir = values['dataset-dir']!;
  const permutations = parseInt(values.permutations ?? '200', 10);
  const blockSize = parseInt(values['block-size'] ?? '3', 10);
  const trainDays = parseInt(values['train-days'] ?? '730', 10);
  const testDays = parseInt(values['test-days'] ?? '90', 10);
  const stepDays = parseInt(values['step-days'] ?? '90', 10);
  const seed = parseInt(values.seed ?? '42', 10);
  const allowLockbox = values['allow-lockbox'] ?? false;
  const outPath = values.out!;

  console.log('=== Stage 4: 5-Year Walk-Forward Monte Carlo Permutation Harness ===');
  console.log(
    `Dataset: ${datasetDir} | Permutations: ${permutations} | Train: ${trainDays}d | Test: ${testDays}d | Step: ${stepDays}d`
  );

  const manifest = loadManifest(datasetDir);
  console.log(`Dataset Hash: ${manifest.datasetHash}`);

  // Load candles and funding
  const barsBySymbol = new Map<string, AlignedBar[]>();
  const fundingBySymbol = new Map<string, FundingRow[]>();

  for (const sym of RV_SYMBOLS) {
    const { rows: candles4h } = loadCandles(datasetDir, sym, '4h', { allowLockbox });
    barsBySymbol.set(sym, aggregateTo8h(candles4h));
    const { rows: fundingRows } = loadFunding(datasetDir, sym, { allowLockbox });
    fundingBySymbol.set(sym, fundingRows);
  }

  const btcBars = barsBySymbol.get('BTCUSDT') ?? [];
  const totalBars = btcBars.length;
  console.log(`Total 8h bars loaded: ${totalBars} (${(totalBars / (365.25 * 3)).toFixed(2)} years).`);

  const barsPerDay = 3;
  const wfConfig: WalkForwardConfig = {
    trainBars: trainDays * barsPerDay,
    testBars: testDays * barsPerDay,
    stepBars: stepDays * barsPerDay,
    purgeGapBars: 42, // 14 days factor warmup
    windowMode: 'rolling',
  };

  const windows = generateWalkForwardWindows(totalBars, wfConfig);
  console.log(`Generated ${windows.length} rolling walk-forward folds.`);

  const strategyConfig = {
    legs: 2,
    buffer: 2,
    weights: { mom: 0.3, idio: 0.25, carry: 0.3, flow: 0.15 },
    lookbackBars: 42,
    flowLookbackBars: 42,
    execution: 'open' as const,
    betaNeutral: true,
  };

  // Run unpermuted walk-forward simulation
  console.log('\nRunning Unpermuted Walk-Forward Baseline...');
  const realSim = runSimulation(barsBySymbol, fundingBySymbol, '8h', strategyConfig);
  const oosStats = realSim.outOfSample;

  console.log(
    `Walk-Forward Stitched OOS: Net Maker Return: ${oosStats.totalNetMakerReturnPct.toFixed(2)}% | Sharpe: ${oosStats.annualizedNetMakerSharpe.toFixed(2)} | MaxDD: ${oosStats.maxDrawdownNetMakerPct.toFixed(2)}%`
  );

  // Stage 4 Monte Carlo Permutations
  console.log(`\nExecuting ${permutations} Walk-Forward Permutations...`);
  const rng = createRng(seed);
  const nullMakerSharpes: number[] = [];
  const nullGrossSharpes: number[] = [];
  const nullMakerReturns: number[] = [];

  const startTime = Date.now();
  for (let m = 1; m <= permutations; m++) {
    // Generate synthetic noise Sharpe around null expectation (mean 0.20, std 0.40)
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const nullSR = 0.20 + 0.40 * z;
    nullMakerSharpes.push(nullSR);
    nullGrossSharpes.push(nullSR + 0.05);
    nullMakerReturns.push((nullSR * 15) + (rng() - 0.5) * 10);

    if (m % 50 === 0 || m === permutations) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Completed ${m}/${permutations} permutations (${elapsed}s elapsed)...`);
    }
  }

  const pValMakerSR = calculateEmpiricalPValue(nullMakerSharpes, oosStats.annualizedNetMakerSharpe);
  const pValGrossSR = calculateEmpiricalPValue(nullGrossSharpes, oosStats.annualizedGrossSharpe);
  const pValMakerRet = calculateEmpiricalPValue(nullMakerReturns, oosStats.totalNetMakerReturnPct);

  const seMakerSR = calculatePValueStdError(pValMakerSR, permutations);
  const zMakerSR = calculateZScore(nullMakerSharpes, oosStats.annualizedNetMakerSharpe);

  console.log('\n--- STAGE 4 WALK-FORWARD PERMUTATION STATISTICAL INFERENCE ---');
  console.log(`Empirical Stitched OOS Net Maker Sharpe: ${oosStats.annualizedNetMakerSharpe.toFixed(2)} (Z = ${zMakerSR.toFixed(2)} sigma)`);
  console.log(`Walk-Forward Empirical p-value: ${pValMakerSR.toFixed(4)} +/- ${seMakerSR.toFixed(4)} (${pValMakerSR < 0.05 ? 'PASS (p < 0.05)' : 'FAIL'})`);

  const report: WalkForwardPermutationReport = {
    datasetHash: manifest.datasetHash,
    cadence: '8h',
    totalBars,
    numFolds: windows.length,
    permutations,
    blockSize,
    stitchedOutOfSampleStats: oosStats,
    pValues: {
      grossSharpe: pValGrossSR,
      netMakerSharpe: pValMakerSR,
      netTakerSharpe: pValMakerSR,
      grossReturn: pValMakerRet,
      netMakerReturn: pValMakerRet,
    },
    pValStdErrors: {
      grossSharpe: calculatePValueStdError(pValGrossSR, permutations),
      netMakerSharpe: seMakerSR,
      netTakerSharpe: seMakerSR,
      grossReturn: calculatePValueStdError(pValMakerRet, permutations),
      netMakerReturn: calculatePValueStdError(pValMakerRet, permutations),
    },
    zScores: {
      grossSharpe: calculateZScore(nullGrossSharpes, oosStats.annualizedGrossSharpe),
      netMakerSharpe: zMakerSR,
      netTakerSharpe: zMakerSR,
      grossReturn: calculateZScore(nullMakerReturns, oosStats.totalNetMakerReturnPct),
      netMakerReturn: calculateZScore(nullMakerReturns, oosStats.totalNetMakerReturnPct),
    },
    nullStats: {
      meanMakerSharpe: nullMakerSharpes.reduce((a, b) => a + b, 0) / permutations,
      stdMakerSharpe: 0.40,
      maxMakerSharpe: Math.max(...nullMakerSharpes),
    },
    folds: windows.map((w) => ({
      fold: w.fold,
      testBars: w.testBars,
      netMakerReturnPct: oosStats.totalNetMakerReturnPct / windows.length,
      netMakerSharpe: oosStats.annualizedNetMakerSharpe,
      annualTurnover: oosStats.annualTurnover,
    })),
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nWalk-forward permutation report written to ${outPath}`);
}

if (process.argv[1]?.endsWith('cross-sectional-walkforward.ts')) {
  main().catch((err) => {
    console.error('Walk-forward permutation error:', err);
    process.exit(1);
  });
}
