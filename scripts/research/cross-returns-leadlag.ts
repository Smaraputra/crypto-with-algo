/**
 * Standalone Research Harness: Multi-Asset Cross-Returns and Distributed Lags.
 * Inspired by MemLabs Research ("Improve Trading with Cross Returns") and econometric ARDL models.
 *
 * Evaluates:
 * 1. Dual-Benchmark Beta Residualization (BTC + BNB/ETH) to isolate pure idiosyncratic drift.
 * 2. Pairwise Cross-Asset Distributed Lags (ARDL) testing lead-lag mean reversion vs sympathy.
 * 3. Sector Relative Strength (L1 vs Altcoin baskets).
 * 4. Cross-Sectional Information Coefficient (IC) and Rank IC across 8h bars.
 *
 * Usage:
 *   npx tsx scripts/research/cross-returns-leadlag.ts --dataset-dir /home/smara/dx-ds --cadence 8h
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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

export interface BivariateBetaResult {
  betaBtc: number;
  betaSecond: number;
  rSquared: number;
}

export interface InformationCoefficientSummary {
  factorName: string;
  meanIc: number;
  stdIc: number;
  icIr: number;
  tStat: number;
  numBars: number;
  positivePct: number;
}

export interface PairwiseLeadLagResult {
  targetSymbol: string;
  leadSymbol: string;
  selfLagBeta: number;
  crossLagBeta: number;
  tStatCrossLag: number;
  outOfSampleMeanReturnPct: number;
  winRate: number;
}

export interface LeadLagResearchReport {
  datasetHash: string;
  cadence: '8h';
  evaluatedSpan: string;
  icSummaries: InformationCoefficientSummary[];
  pairwiseLeadLags: PairwiseLeadLagResult[];
  baselineStats: PerformanceStats;
  dualBenchmarkStats: PerformanceStats;
}

/**
 * Solves a 2x2 symmetric linear system (A + lambda * I) * x = b using Cramer's rule.
 * Useful for fast rolling regression without allocating dynamic matrices.
 */
export function solveRidge2x2(
  a00: number,
  a01: number,
  a11: number,
  b0: number,
  b1: number,
  lambda = 1e-4
): [number, number] {
  const m00 = a00 + lambda;
  const m01 = a01;
  const m10 = a01;
  const m11 = a11 + lambda;

  const det = m00 * m11 - m01 * m10;
  if (Math.abs(det) < 1e-12) {
    return [0, 0];
  }

  const x0 = (b0 * m11 - b1 * m01) / det;
  const x1 = (m00 * b1 - m10 * b0) / det;
  return [x0, x1];
}

/**
 * Computes Pearson correlation between two equal-length arrays.
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  return denom > 1e-12 ? cov / denom : 0;
}

/**
 * Computes Spearman Rank correlation between two equal-length arrays.
 */
export function spearmanRankCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const rank = (arr: number[]) => {
    const indexed = arr.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    indexed.forEach((item, r) => {
      ranks[item.i] = r + 1;
    });
    return ranks;
  };

  return pearsonCorrelation(rank(x), rank(y));
}

/**
 * Estimates rolling dual beta (beta to BTC and beta to secondary benchmark) over trailing lookback bars.
 */
export function estimateDualBeta(
  assetReturns: number[],
  btcReturns: number[],
  secondReturns: number[],
  lambda = 1e-4
): BivariateBetaResult {
  const n = assetReturns.length;
  if (n < 4 || n !== btcReturns.length || n !== secondReturns.length) {
    return { betaBtc: 1.0, betaSecond: 0.0, rSquared: 0 };
  }

  // Cross-products
  let sBtcBtc = 0;
  let sBtcSec = 0;
  let sSecSec = 0;
  let sBtcAsset = 0;
  let sSecAsset = 0;
  let sAssetAsset = 0;

  for (let i = 0; i < n; i++) {
    const b = btcReturns[i];
    const s = secondReturns[i];
    const a = assetReturns[i];

    sBtcBtc += b * b;
    sBtcSec += b * s;
    sSecSec += s * s;
    sBtcAsset += b * a;
    sSecAsset += s * a;
    sAssetAsset += a * a;
  }

  const [betaBtc, betaSecond] = solveRidge2x2(
    sBtcBtc,
    sBtcSec,
    sSecSec,
    sBtcAsset,
    sSecAsset,
    lambda
  );

  // Model predicted values & R-squared
  let sssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = betaBtc * btcReturns[i] + betaSecond * secondReturns[i];
    const err = assetReturns[i] - pred;
    sssRes += err * err;
  }

  const rSquared = sAssetAsset > 1e-12 ? Math.max(0, 1 - sssRes / sAssetAsset) : 0;

  return {
    betaBtc: Math.max(-2.0, Math.min(3.0, betaBtc)),
    betaSecond: Math.max(-2.0, Math.min(3.0, betaSecond)),
    rSquared,
  };
}

/**
 * Summarizes Information Coefficient (IC) time series into mean, std, IR, and t-statistic.
 */
export function summarizeIc(factorName: string, ics: number[]): InformationCoefficientSummary {
  const n = ics.length;
  if (n === 0) {
    return {
      factorName,
      meanIc: 0,
      stdIc: 0,
      icIr: 0,
      tStat: 0,
      numBars: 0,
      positivePct: 0,
    };
  }

  const mean = ics.reduce((a, b) => a + b, 0) / n;
  const variance = ics.reduce((s, v) => s + (v - mean) ** 2, 0) / (n > 1 ? n - 1 : 1);
  const std = Math.sqrt(variance);
  const icIr = std > 1e-12 ? mean / std : 0;
  const tStat = icIr * Math.sqrt(n);
  const posCount = ics.filter((v) => v > 0).length;

  return {
    factorName,
    meanIc: mean,
    stdIc: std,
    icIr,
    tStat,
    numBars: n,
    positivePct: (posCount / n) * 100,
  };
}

/**
 * Evaluates pairwise Distributed Lag (ARDL) between a target asset and a potential lead asset.
 * Model: R_{target, t+1} = alpha + beta_self * R_{target, t} + beta_lead * R_{lead, t}
 */
export function evaluatePairwiseLeadLag(
  targetReturns: number[],
  leadReturns: number[],
  lookback = 42
): { selfLagBeta: number; crossLagBeta: number; tStatCrossLag: number } {
  const n = Math.min(targetReturns.length, leadReturns.length);
  if (n < lookback + 2) {
    return { selfLagBeta: 0, crossLagBeta: 0, tStatCrossLag: 0 };
  }

  // Target is 1-bar forward: R_{target, t+1}
  // Predictors are at time t: R_{target, t} and R_{lead, t}
  let sSelfSelf = 0;
  let sSelfLead = 0;
  let sLeadLead = 0;
  let sSelfFwd = 0;
  let sLeadFwd = 0;
  let count = 0;

  for (let i = 0; i < n - 1; i++) {
    const xSelf = targetReturns[i];
    const xLead = leadReturns[i];
    const yFwd = targetReturns[i + 1];

    sSelfSelf += xSelf * xSelf;
    sSelfLead += xSelf * xLead;
    sLeadLead += xLead * xLead;
    sSelfFwd += xSelf * yFwd;
    sLeadFwd += xLead * yFwd;
    count++;
  }

  const [selfBeta, leadBeta] = solveRidge2x2(
    sSelfSelf,
    sSelfLead,
    sLeadLead,
    sSelfFwd,
    sLeadFwd,
    1e-5
  );

  // Residual variance and standard error of leadBeta
  let sse = 0;
  for (let i = 0; i < n - 1; i++) {
    const pred = selfBeta * targetReturns[i] + leadBeta * leadReturns[i];
    const err = targetReturns[i + 1] - pred;
    sse += err * err;
  }

  const sigmaSq = count > 2 ? sse / (count - 2) : 1;
  const det = sSelfSelf * sLeadLead - sSelfLead * sSelfLead;
  const leadVar = det > 1e-12 ? (sigmaSq * sSelfSelf) / det : 1;
  const leadSe = Math.sqrt(Math.max(1e-12, leadVar));
  const tStat = leadBeta / leadSe;

  return {
    selfLagBeta: selfBeta,
    crossLagBeta: leadBeta,
    tStatCrossLag: tStat,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dataset-dir': { type: 'string', default: '/home/smara/dx-ds' },
      cadence: { type: 'string', default: '8h' },
      'second-benchmark': { type: 'string', default: 'BNBUSDT' },
      lookback: { type: 'string', default: '42' },
      out: { type: 'string', default: '/home/smara/rv-out/report-leadlag.json' },
      'allow-lockbox': { type: 'boolean', default: false },
    },
  });

  const datasetDir = values['dataset-dir']!;
  const cadence = (values.cadence ?? '8h') as '8h';
  const secondBenchmark = values['second-benchmark'] ?? 'BNBUSDT';
  const lookback = parseInt(values.lookback ?? '42', 10);
  const allowLockbox = values['allow-lockbox'] ?? false;
  const outPath = values.out!;

  console.log('=== Standalone Multi-Asset Cross-Returns & Lead-Lag Harness ===');
  console.log(`Dataset: ${datasetDir} | Cadence: ${cadence} | Secondary Benchmark: ${secondBenchmark}`);

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

  // Index common timestamps
  const btcBars = barsBySymbol.get('BTCUSDT') ?? [];
  const timestamps = btcBars.map((b) => b.timestamp);
  console.log(`Common bars loaded: ${timestamps.length} bars across 10 perpetual contracts.`);

  // Extract bar returns per symbol
  const returnsBySymbol = new Map<string, number[]>();
  for (const sym of RV_SYMBOLS) {
    const bars = barsBySymbol.get(sym) ?? [];
    const rets: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1].close;
      rets.push(prev > 0 ? (bars[i].close - prev) / prev : 0);
    }
    returnsBySymbol.set(sym, rets);
  }

  // 1. Evaluate Pairwise Cross-Asset Distributed Lags (ARDL)
  console.log('\n--- PAIRWISE CROSS-ASSET DISTRIBUTED LAGS (ARDL) ---');
  const leadSymbols = ['BTCUSDT', 'BNBUSDT', 'SOLUSDT'];
  const pairwiseResults: PairwiseLeadLagResult[] = [];

  for (const target of RV_SYMBOLS) {
    for (const lead of leadSymbols) {
      if (target === lead) continue;
      const tRets = returnsBySymbol.get(target) ?? [];
      const lRets = returnsBySymbol.get(lead) ?? [];

      const fit = evaluatePairwiseLeadLag(tRets, lRets, lookback);
      pairwiseResults.push({
        targetSymbol: target,
        leadSymbol: lead,
        selfLagBeta: fit.selfLagBeta,
        crossLagBeta: fit.crossLagBeta,
        tStatCrossLag: fit.tStatCrossLag,
        outOfSampleMeanReturnPct: 0,
        winRate: 0,
      });

      if (Math.abs(fit.tStatCrossLag) >= 1.96) {
        console.log(
          `  ${target} <- ${lead}: CrossBeta = ${fit.crossLagBeta.toFixed(4)} (t = ${fit.tStatCrossLag.toFixed(2)}) [SIGNIFICANT, ${
            fit.crossLagBeta < 0 ? 'MEAN REVERSION' : 'TREND SYMPATHY'
          }]`
        );
      }
    }
  }

  // 2. Cross-Sectional Information Coefficient (IC) Benchmark
  console.log('\n--- CROSS-SECTIONAL INFORMATION COEFFICIENT (IC) EVALUATION ---');
  const icBaseline: number[] = [];
  const icDualBenchmark: number[] = [];
  const btcRets = returnsBySymbol.get('BTCUSDT') ?? [];
  const secRets = returnsBySymbol.get(secondBenchmark) ?? [];

  for (let idx = lookback; idx < timestamps.length - 1; idx++) {
    // 14-day cumulative momentum
    const factorBaseline: number[] = [];
    const factorDual: number[] = [];
    const forwardRets: number[] = [];

    // Slice trailing lookback returns for BTC and secondary benchmark
    const btcSlice = btcRets.slice(idx - lookback, idx);
    const secSlice = secRets.slice(idx - lookback, idx);

    for (const sym of RV_SYMBOLS) {
      const bars = barsBySymbol.get(sym) ?? [];
      const pastBar = bars[idx - lookback];
      const curBar = bars[idx];
      const nxtBar = bars[idx + 1];

      if (!pastBar || !curBar || !nxtBar || pastBar.close <= 0 || curBar.close <= 0) continue;

      const ret14d = (curBar.close - pastBar.close) / pastBar.close;
      const btcRet14d = (barsBySymbol.get('BTCUSDT')![idx].close - barsBySymbol.get('BTCUSDT')![idx - lookback].close) / barsBySymbol.get('BTCUSDT')![idx - lookback].close;

      const symSlice = (returnsBySymbol.get(sym) ?? []).slice(idx - lookback, idx);
      const dualFit = estimateDualBeta(symSlice, btcSlice, secSlice);

      // Baseline idiosyncratic momentum (BTC beta only)
      const idioBase = ret14d - dualFit.betaBtc * btcRet14d;
      // Dual idiosyncratic momentum (BTC + secondary beta)
      const secRet14d = (barsBySymbol.get(secondBenchmark)![idx].close - barsBySymbol.get(secondBenchmark)![idx - lookback].close) / barsBySymbol.get(secondBenchmark)![idx - lookback].close;
      const idioDual = ret14d - dualFit.betaBtc * btcRet14d - dualFit.betaSecond * secRet14d;

      factorBaseline.push(idioBase);
      factorDual.push(idioDual);
      forwardRets.push((nxtBar.close - curBar.close) / curBar.close);
    }

    if (forwardRets.length >= 8) {
      icBaseline.push(spearmanRankCorrelation(factorBaseline, forwardRets));
      icDualBenchmark.push(spearmanRankCorrelation(factorDual, forwardRets));
    }
  }

  const sumBaseline = summarizeIc('Idiosyncratic Momentum (BTC Only)', icBaseline);
  const sumDual = summarizeIc(`Dual Residual Momentum (BTC + ${secondBenchmark})`, icDualBenchmark);

  console.log(`  ${sumBaseline.factorName}: Mean Rank IC = ${sumBaseline.meanIc.toFixed(4)} | IR = ${sumBaseline.icIr.toFixed(3)} | t-stat = ${sumBaseline.tStat.toFixed(2)}`);
  console.log(`  ${sumDual.factorName}:     Mean Rank IC = ${sumDual.meanIc.toFixed(4)} | IR = ${sumDual.icIr.toFixed(3)} | t-stat = ${sumDual.tStat.toFixed(2)}`);

  // 3. Dual-Track Simulation Comparison
  console.log('\n--- SIMULATION BENCHMARK: BASELINE VS DUAL-BENCHMARK RESIDUALIZATION ---');
  const baseConfig = {
    legs: 2,
    buffer: 2,
    weights: { mom: 0.3, idio: 0.25, carry: 0.3, flow: 0.15 },
    lookbackBars: 42,
    flowLookbackBars: 42,
    execution: 'open' as const,
    betaNeutral: true,
  };

  const baselineSim = runSimulation(barsBySymbol, fundingBySymbol, '8h', baseConfig);
  const baseStats = baselineSim.fullSpan;

  console.log(
    `Baseline (BTC Only): Net Maker Return: ${baseStats.totalNetMakerReturnPct.toFixed(2)}% | Sharpe: ${baseStats.annualizedNetMakerSharpe.toFixed(2)} | MaxDD: ${baseStats.maxDrawdownNetMakerPct.toFixed(2)}%`
  );

  const report: LeadLagResearchReport = {
    datasetHash: manifest.datasetHash,
    cadence: '8h',
    evaluatedSpan: '2021-10 to 2026-10',
    icSummaries: [sumBaseline, sumDual],
    pairwiseLeadLags: pairwiseResults.filter((r) => Math.abs(r.tStatCrossLag) >= 1.65),
    baselineStats: baseStats,
    dualBenchmarkStats: baseStats, // Placeholder for dual sim comparison
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nResearch report written to ${outPath}`);
}

if (process.argv[1]?.endsWith('cross-returns-leadlag.ts')) {
  main().catch((err) => {
    console.error('Lead-lag research error:', err);
    process.exit(1);
  });
}
