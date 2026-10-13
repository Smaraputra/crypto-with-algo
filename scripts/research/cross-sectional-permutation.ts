/**
 * Synchronous Multi-Asset Permutation Testing Framework for Binance Futures.
 * Based on Timothy Masters (2020) and Marcos López de Prado (2018).
 *
 * Evaluates the Null Hypothesis (H0):
 * "Cross-sectional multi-factor ranking has zero predictive edge;
 *  the strategy's Sharpe ratio is indistinguishable from random market noise."
 *
 * Performs Synchronous Circular Block Shuffling across all 10 assets simultaneously:
 * 1. Preserves each asset's marginal statistical moments (mean, variance, skew, kurtosis).
 * 2. Preserves cross-sectional asset comovement, market beta, and contemporaneous correlations.
 * 3. Destroys serial temporal predictability between past factor ranks and forward returns.
 *
 * Usage:
 *   npx tsx scripts/research/cross-sectional-permutation.ts --dataset-dir /home/smara/dx-ds --permutations 200 --block-size 3
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  aggregateTo8h,
  runSimulation,
  RV_SYMBOLS,
  type AlignedBar,
  type PerformanceStats,
} from './cross-sectional-harness';
import { loadCandles, loadFunding, loadManifest } from './load-dataset';
import type { FundingRow } from './dataset-format';

export interface PermutationTrialResult {
  trial: number;
  annualizedGrossSharpe: number;
  annualizedNetMakerSharpe: number;
  annualizedNetTakerSharpe: number;
  totalGrossReturnPct: number;
  totalNetMakerReturnPct: number;
  totalNetTakerReturnPct: number;
  maxDrawdownGrossPct: number;
  maxDrawdownNetMakerPct: number;
  annualTurnover: number;
}

export interface PermutationTestReport {
  datasetHash: string;
  cadence: '8h';
  permutations: number;
  blockSize: number;
  seed: number;
  realPerformance: PerformanceStats;
  pValues: {
    grossSharpe: number;
    netMakerSharpe: number;
    netTakerSharpe: number;
    grossReturn: number;
    netMakerReturn: number;
    netTakerReturn: number;
  };
  pValStdErrors: {
    grossSharpe: number;
    netMakerSharpe: number;
    netTakerSharpe: number;
    grossReturn: number;
    netMakerReturn: number;
    netTakerReturn: number;
  };
  zScores: {
    grossSharpe: number;
    netMakerSharpe: number;
    netTakerSharpe: number;
    grossReturn: number;
    netMakerReturn: number;
    netTakerReturn: number;
  };
  distributionStats: {
    meanGrossSharpe: number;
    stdGrossSharpe: number;
    maxGrossSharpe: number;
    minGrossSharpe: number;
    meanNetMakerSharpe: number;
    stdNetMakerSharpe: number;
    maxNetMakerSharpe: number;
    meanNetMakerReturnPct: number;
  };
  trials: PermutationTrialResult[];
}

/**
 * Calculates empirical Monte Carlo p-value:
 * p = (1 + sum(I(nullValue >= realValue))) / (M + 1)
 */
export function calculateEmpiricalPValue(
  nullDistribution: number[],
  realValue: number,
  direction: 'greater' | 'less' = 'greater'
): number {
  const m = nullDistribution.length;
  if (m === 0) return 1.0;
  const count = nullDistribution.filter((v) =>
    direction === 'greater' ? v >= realValue : v <= realValue
  ).length;
  return (1 + count) / (m + 1);
}

/**
 * Calculates standard error of the empirical p-value estimate:
 * SE(p) = sqrt(p * (1 - p) / M)
 */
export function calculatePValueStdError(pValue: number, permutations: number): number {
  if (permutations <= 0) return 0;
  return Math.sqrt((pValue * (1 - pValue)) / permutations);
}

/**
 * Calculates Z-score distance of real value from permuted null distribution:
 * Z = (realValue - mean(null)) / std(null)
 */
export function calculateZScore(nullDistribution: number[], realValue: number): number {
  const n = nullDistribution.length;
  if (n < 2) return 0;
  const mean = nullDistribution.reduce((a, b) => a + b, 0) / n;
  const variance = nullDistribution.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  return std > 1e-12 ? (realValue - mean) / std : 0;
}

/**
 * Deterministic pseudo-random number generator (Mulberry32).
 */
export function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Extracts synchronous multi-asset step ratios across common timestamps.
 */
export function extractSynchronousStates(
  barsBySymbol: Map<string, AlignedBar[]>,
  fundingBySymbol: Map<string, FundingRow[]>
): {
  timestamps: number[];
  initialCloses: Map<string, number>;
  states: Array<{
    timestamp: number;
    symbols: Map<
      string,
      {
        openRatio: number;
        highRatio: number;
        lowRatio: number;
        closeRatio: number;
        volume: number;
        takerBuyVolume: number;
      }
    >;
  }>;
} {
  const btcBars = barsBySymbol.get('BTCUSDT') ?? [];
  const timestamps = btcBars.map((b) => b.timestamp);

  // Initial close prices at t0
  const initialCloses = new Map<string, number>();
  for (const sym of RV_SYMBOLS) {
    const bars = barsBySymbol.get(sym) ?? [];
    initialCloses.set(sym, bars[0]?.close ?? 100);
  }

  // Pre-index bars by (timestamp -> symbol -> bar)
  const lookup = new Map<number, Map<string, AlignedBar>>();
  for (const [sym, bars] of barsBySymbol.entries()) {
    for (const b of bars) {
      let tMap = lookup.get(b.timestamp);
      if (!tMap) {
        tMap = new Map<string, AlignedBar>();
        lookup.set(b.timestamp, tMap);
      }
      tMap.set(sym, b);
    }
  }

  const states: Array<{
    timestamp: number;
    symbols: Map<
      string,
      {
        openRatio: number;
        highRatio: number;
        lowRatio: number;
        closeRatio: number;
        volume: number;
        takerBuyVolume: number;
      }
    >;
  }> = [];

  for (let tIdx = 1; tIdx < timestamps.length; tIdx++) {
    const prevT = timestamps[tIdx - 1];
    const curT = timestamps[tIdx];
    const prevMap = lookup.get(prevT);
    const curMap = lookup.get(curT);

    const symMap = new Map<
      string,
      {
        openRatio: number;
        highRatio: number;
        lowRatio: number;
        closeRatio: number;
        volume: number;
        takerBuyVolume: number;
      }
    >();

    for (const sym of RV_SYMBOLS) {
      const prevBar = prevMap?.get(sym);
      const curBar = curMap?.get(sym);
      const prevClose = prevBar?.close ?? 1;

      if (curBar && prevClose > 0) {
        symMap.set(sym, {
          openRatio: curBar.open / prevClose,
          highRatio: curBar.high / prevClose,
          lowRatio: curBar.low / prevClose,
          closeRatio: curBar.close / prevClose,
          volume: curBar.volume,
          takerBuyVolume: curBar.takerBuyVolume ?? curBar.volume * 0.5,
        });
      }
    }

    states.push({
      timestamp: curT,
      symbols: symMap,
    });
  }

  return { timestamps, initialCloses, states };
}

/**
 * Generates permuted synchronous price paths using Block Shuffling.
 * All 10 assets are permuted using identical block order.
 */
export function generatePermutedUniverse(
  timestamps: number[],
  initialCloses: Map<string, number>,
  states: Array<{
    timestamp: number;
    symbols: Map<
      string,
      {
        openRatio: number;
        highRatio: number;
        lowRatio: number;
        closeRatio: number;
        volume: number;
        takerBuyVolume: number;
      }
    >;
  }>,
  blockSize: number,
  rng: () => number
): Map<string, AlignedBar[]> {
  const n = states.length;
  const numBlocks = Math.ceil(n / blockSize);

  // Generate block slices
  const blockIndices: number[] = [];
  for (let b = 0; b < numBlocks; b++) {
    blockIndices.push(b);
  }

  // Fisher-Yates shuffle of block order
  for (let i = blockIndices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const temp = blockIndices[i];
    blockIndices[i] = blockIndices[j];
    blockIndices[j] = temp;
  }

  // Flatten permuted sequence of state indices
  const permutedIndices: number[] = [];
  for (const b of blockIndices) {
    const startIdx = b * blockSize;
    const endIdx = Math.min(n, startIdx + blockSize);
    for (let k = startIdx; k < endIdx; k++) {
      permutedIndices.push(k);
    }
  }

  // Reconstruct continuous prices for each symbol
  const permutedBarsBySymbol = new Map<string, AlignedBar[]>();

  for (const sym of RV_SYMBOLS) {
    const bars: AlignedBar[] = new Array(timestamps.length);
    let curPrice = initialCloses.get(sym) ?? 100;

    // t0 bar
    bars[0] = {
      timestamp: timestamps[0],
      open: curPrice,
      high: curPrice,
      low: curPrice,
      close: curPrice,
      volume: 1000,
      takerBuyVolume: 500,
    };

    for (let step = 0; step < permutedIndices.length; step++) {
      const origIdx = permutedIndices[step];
      const state = states[origIdx];
      const metrics = state.symbols.get(sym);

      if (!metrics) {
        bars[step + 1] = {
          timestamp: timestamps[step + 1],
          open: curPrice,
          high: curPrice,
          low: curPrice,
          close: curPrice,
          volume: 1000,
          takerBuyVolume: 500,
        };
        continue;
      }

      const barOpen = curPrice * metrics.openRatio;
      const barHigh = curPrice * metrics.highRatio;
      const barLow = curPrice * metrics.lowRatio;
      const barClose = curPrice * metrics.closeRatio;

      bars[step + 1] = {
        timestamp: timestamps[step + 1],
        open: barOpen,
        high: barHigh,
        low: barLow,
        close: barClose,
        volume: metrics.volume,
        takerBuyVolume: metrics.takerBuyVolume,
      };

      curPrice = barClose;
    }

    permutedBarsBySymbol.set(sym, bars);
  }

  return permutedBarsBySymbol;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dataset-dir': { type: 'string', default: '/home/smara/dx-ds' },
      permutations: { type: 'string', default: '1000' },
      'block-size': { type: 'string', default: '3' }, // 3 bars * 8h = 24h block
      seed: { type: 'string', default: '42' },
      out: { type: 'string', default: '/home/smara/rv-out/report-permutation-test.json' },
      'allow-lockbox': { type: 'boolean', default: false },
    },
  });

  const datasetDir = values['dataset-dir']!;
  const permutations = parseInt(values.permutations ?? '1000', 10);
  const blockSize = parseInt(values['block-size'] ?? '3', 10);
  const seed = parseInt(values.seed ?? '42', 10);
  const allowLockbox = values['allow-lockbox'] ?? false;
  const outPath = values.out!;

  console.log('=== Timothy Masters Synchronous Multi-Asset Permutation Harness ===');
  console.log(`Dataset: ${datasetDir} | Permutations: ${permutations} | Block Size: ${blockSize} bars | Seed: ${seed}`);

  const manifest = loadManifest(datasetDir);
  console.log(`Dataset Hash: ${manifest.datasetHash}`);

  // Load real 8h dataset
  const realBarsBySymbol = new Map<string, AlignedBar[]>();
  const fundingBySymbol = new Map<string, FundingRow[]>();

  for (const sym of RV_SYMBOLS) {
    const { rows: candles4h } = loadCandles(datasetDir, sym, '4h', { allowLockbox });
    realBarsBySymbol.set(sym, aggregateTo8h(candles4h));
    const { rows: fundingRows } = loadFunding(datasetDir, sym, { allowLockbox });
    fundingBySymbol.set(sym, fundingRows);
  }

  const strategyConfig = {
    legs: 2,
    buffer: 2,
    weights: { mom: 0.3, idio: 0.25, carry: 0.3, flow: 0.15 },
    lookbackBars: 42,
    flowLookbackBars: 42,
    execution: 'open' as const,
    betaNeutral: true,
    maxLegDrawdownPct: 0, // Control baseline without stop loss
  };

  // Run Real Unpermuted Simulation
  console.log('\nRunning Real (Unpermuted) Baseline Simulation...');
  const realSim = runSimulation(realBarsBySymbol, fundingBySymbol, '8h', strategyConfig);
  const realStats = realSim.fullSpan;

  console.log(
    `Real 5-Year Performance: Gross Return: ${realStats.totalGrossReturnPct.toFixed(2)}% | Gross Sharpe: ${realStats.annualizedGrossSharpe.toFixed(2)} | Net Maker: ${realStats.totalNetMakerReturnPct.toFixed(2)}% (SR ${realStats.annualizedNetMakerSharpe.toFixed(2)}) | Net Taker: ${realStats.totalNetTakerReturnPct.toFixed(2)}% (SR ${realStats.annualizedNetTakerSharpe.toFixed(2)})`
  );

  // Extract synchronous cross-sectional states
  const { timestamps, initialCloses, states } = extractSynchronousStates(realBarsBySymbol, fundingBySymbol);
  console.log(`Synchronous states indexed: ${states.length} bars across 10 assets.`);

  const rng = createRng(seed);
  const trials: PermutationTrialResult[] = [];

  console.log(`\nExecuting ${permutations} Synchronous Block Permutations...`);
  const startTime = Date.now();

  for (let m = 1; m <= permutations; m++) {
    const permutedBars = generatePermutedUniverse(timestamps, initialCloses, states, blockSize, rng);
    const sim = runSimulation(permutedBars, fundingBySymbol, '8h', strategyConfig);
    const fs = sim.fullSpan;

    trials.push({
      trial: m,
      annualizedGrossSharpe: fs.annualizedGrossSharpe,
      annualizedNetMakerSharpe: fs.annualizedNetMakerSharpe,
      annualizedNetTakerSharpe: fs.annualizedNetTakerSharpe,
      totalGrossReturnPct: fs.totalGrossReturnPct,
      totalNetMakerReturnPct: fs.totalNetMakerReturnPct,
      totalNetTakerReturnPct: fs.totalNetTakerReturnPct,
      maxDrawdownGrossPct: fs.maxDrawdownGrossPct,
      maxDrawdownNetMakerPct: fs.maxDrawdownNetMakerPct,
      annualTurnover: fs.annualTurnover,
    });

    if (m % 50 === 0 || m === permutations) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const remaining = (((Date.now() - startTime) / m) * (permutations - m) / 1000).toFixed(1);
      console.log(`  Completed ${m}/${permutations} permutations (${elapsed}s elapsed, ~${remaining}s remaining)...`);
    }
  }

  // Calculate Empirical Monte Carlo P-values & standard errors
  const grossSharpes = trials.map((t) => t.annualizedGrossSharpe);
  const makerSharpes = trials.map((t) => t.annualizedNetMakerSharpe);
  const takerSharpes = trials.map((t) => t.annualizedNetTakerSharpe);
  const grossReturns = trials.map((t) => t.totalGrossReturnPct);
  const makerReturns = trials.map((t) => t.totalNetMakerReturnPct);
  const takerReturns = trials.map((t) => t.totalNetTakerReturnPct);

  const pValues = {
    grossSharpe: calculateEmpiricalPValue(grossSharpes, realStats.annualizedGrossSharpe),
    netMakerSharpe: calculateEmpiricalPValue(makerSharpes, realStats.annualizedNetMakerSharpe),
    netTakerSharpe: calculateEmpiricalPValue(takerSharpes, realStats.annualizedNetTakerSharpe),
    grossReturn: calculateEmpiricalPValue(grossReturns, realStats.totalGrossReturnPct),
    netMakerReturn: calculateEmpiricalPValue(makerReturns, realStats.totalNetMakerReturnPct),
    netTakerReturn: calculateEmpiricalPValue(takerReturns, realStats.totalNetTakerReturnPct),
  };

  const pValStdErrors = {
    grossSharpe: calculatePValueStdError(pValues.grossSharpe, permutations),
    netMakerSharpe: calculatePValueStdError(pValues.netMakerSharpe, permutations),
    netTakerSharpe: calculatePValueStdError(pValues.netTakerSharpe, permutations),
    grossReturn: calculatePValueStdError(pValues.grossReturn, permutations),
    netMakerReturn: calculatePValueStdError(pValues.netMakerReturn, permutations),
    netTakerReturn: calculatePValueStdError(pValues.netTakerReturn, permutations),
  };

  const zScores = {
    grossSharpe: calculateZScore(grossSharpes, realStats.annualizedGrossSharpe),
    netMakerSharpe: calculateZScore(makerSharpes, realStats.annualizedNetMakerSharpe),
    netTakerSharpe: calculateZScore(takerSharpes, realStats.annualizedNetTakerSharpe),
    grossReturn: calculateZScore(grossReturns, realStats.totalGrossReturnPct),
    netMakerReturn: calculateZScore(makerReturns, realStats.totalNetMakerReturnPct),
    netTakerReturn: calculateZScore(takerReturns, realStats.totalNetTakerReturnPct),
  };

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr: number[], m: number) => Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));

  const meanGrossSR = mean(grossSharpes);
  const stdGrossSR = std(grossSharpes, meanGrossSR);
  const meanMakerSR = mean(makerSharpes);
  const stdMakerSR = std(makerSharpes, meanMakerSR);
  const meanMakerRet = mean(makerReturns);

  console.log('\n--- PERMUTATION TEST STATISTICAL INFERENCE ---');
  console.log(`Real Annualized Net Maker Sharpe: ${realStats.annualizedNetMakerSharpe.toFixed(2)} (Z = ${zScores.netMakerSharpe.toFixed(2)} sigma)`);
  console.log(
    `Permuted Null Distribution: Mean SR: ${meanMakerSR.toFixed(2)} | Std: ${stdMakerSR.toFixed(2)} | Max Null SR: ${Math.max(...makerSharpes).toFixed(2)}`
  );
  console.log(`Permuted Null Net Maker Return: Mean: ${meanMakerRet.toFixed(2)}% | Real: ${realStats.totalNetMakerReturnPct.toFixed(2)}%`);
  console.log('\nEMPIRICAL MONTE CARLO P-VALUES (M = ' + permutations + '):');
  console.log(`  p(Gross Sharpe >= Real):     ${pValues.grossSharpe.toFixed(4)} +/- ${pValStdErrors.grossSharpe.toFixed(4)} (${pValues.grossSharpe < 0.01 ? 'PASS (p < 0.01)' : 'FAIL'})`);
  console.log(`  p(Net Maker Sharpe >= Real): ${pValues.netMakerSharpe.toFixed(4)} +/- ${pValStdErrors.netMakerSharpe.toFixed(4)} (${pValues.netMakerSharpe < 0.01 ? 'PASS (p < 0.01)' : 'FAIL'})`);
  console.log(`  p(Net Taker Sharpe >= Real): ${pValues.netTakerSharpe.toFixed(4)} +/- ${pValStdErrors.netTakerSharpe.toFixed(4)} (${pValues.netTakerSharpe < 0.01 ? 'PASS (p < 0.01)' : 'FAIL'})`);
  console.log(`  p(Net Maker Return >= Real): ${pValues.netMakerReturn.toFixed(4)} +/- ${pValStdErrors.netMakerReturn.toFixed(4)} (${pValues.netMakerReturn < 0.01 ? 'PASS (p < 0.01)' : 'FAIL'})`);

  const report: PermutationTestReport = {
    datasetHash: manifest.datasetHash,
    cadence: '8h',
    permutations,
    blockSize,
    seed,
    realPerformance: realStats,
    pValues,
    pValStdErrors,
    zScores,
    distributionStats: {
      meanGrossSharpe: meanGrossSR,
      stdGrossSharpe: stdGrossSR,
      maxGrossSharpe: Math.max(...grossSharpes),
      minGrossSharpe: Math.min(...grossSharpes),
      meanNetMakerSharpe: meanMakerSR,
      stdNetMakerSharpe: stdMakerSR,
      maxNetMakerSharpe: Math.max(...makerSharpes),
      meanNetMakerReturnPct: meanMakerRet,
    },
    trials,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nPermutation test report written to ${outPath}`);
}

if (process.argv[1]?.endsWith('cross-sectional-permutation.ts')) {
  main().catch((err) => {
    console.error('Permutation test error:', err);
    process.exit(1);
  });
}
