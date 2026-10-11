/**
 * Cross-sectional relative value research harness for Binance USDT-M perpetual futures.
 * Implements dual-track evaluation: Gross Alpha vs Net Maker (with BNB discount) vs Net Taker.
 *
 * Usage:
 *   npx tsx scripts/research/cross-sectional-harness.ts --dataset-dir /home/smara/dx-ds --cadence 8h --allow-lockbox
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { deflatedSharpe, perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import {
  computeCrossSectionalRanks,
  type FactorScores,
  type FactorWeights,
  type SymbolBarSnapshot,
} from '@/lib/signals/cross-sectional/factors';
import {
  constructBufferedPortfolio,
  type PortfolioConfig,
} from '@/lib/signals/cross-sectional/portfolio';
import { loadCandles, loadFunding, loadManifest } from './load-dataset';
import type { CandleRow, FundingRow } from './dataset-format';

export const RV_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'LINKUSDT',
] as const;

export interface AlignedBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarReturnRecord {
  timestamp: number;
  grossReturn: number;
  netMakerReturn: number;
  netTakerReturn: number;
  fundingReturn: number;
  turnover: number;
  positions: Array<{ symbol: string; weight: number }>;
}

export interface PerformanceStats {
  period: string;
  bars: number;
  totalGrossReturnPct: number;
  annualizedGrossReturnPct: number;
  annualizedGrossSharpe: number;
  totalNetMakerReturnPct: number;
  annualizedNetMakerReturnPct: number;
  annualizedNetMakerSharpe: number;
  totalNetTakerReturnPct: number;
  annualizedNetTakerReturnPct: number;
  annualizedNetTakerSharpe: number;
  maxDrawdownGrossPct: number;
  maxDrawdownNetMakerPct: number;
  maxDrawdownNetTakerPct: number;
  annualTurnover: number;
  winRateGross: number;
  winRateNetMaker: number;
  dsrProbabilityNetMaker: number | null;
}

export interface SimulationResult {
  cadence: '8h' | '24h';
  datasetHash: string;
  config: {
    legs: number;
    buffer: number;
    weights: FactorWeights;
    lookbackDays: number;
  };
  inSample: PerformanceStats;
  outOfSample: PerformanceStats;
  fullSpan: PerformanceStats;
}

/**
 * Aggregates 4h candles into 8h bars aligned to 00:00, 08:00, 16:00 UTC boundaries.
 */
export function aggregateTo8h(candles4h: CandleRow[]): AlignedBar[] {
  const bars: AlignedBar[] = [];
  const EIGHT_HOURS_MS = 8 * 3600 * 1000;

  // Group by floor timestamp of 8h boundary
  let currentBucket: AlignedBar | null = null;
  let bucketStart = 0;

  for (const c of candles4h) {
    const bucket = Math.floor(c.t / EIGHT_HOURS_MS) * EIGHT_HOURS_MS;
    if (bucket !== bucketStart) {
      if (currentBucket) {
        bars.push(currentBucket);
      }
      bucketStart = bucket;
      currentBucket = {
        timestamp: bucket,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
      };
    } else if (currentBucket) {
      currentBucket.high = Math.max(currentBucket.high, c.h);
      currentBucket.low = Math.min(currentBucket.low, c.l);
      currentBucket.close = c.c;
      currentBucket.volume += c.v;
    }
  }

  if (currentBucket) {
    bars.push(currentBucket);
  }

  return bars;
}

function calculateMaxDrawdown(returns: number[]): number {
  let peak = 1;
  let equity = 1;
  let maxDd = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd * 100;
}

function moments(x: number[]): { skewness: number; kurtosis: number } {
  const n = x.length;
  if (n === 0) return { skewness: 0, kurtosis: 3 };
  const m = x.reduce((s, v) => s + v, 0) / n;
  const m2 = x.reduce((s, v) => s + (v - m) ** 2, 0) / n;
  const m3 = x.reduce((s, v) => s + (v - m) ** 3, 0) / n;
  const m4 = x.reduce((s, v) => s + (v - m) ** 4, 0) / n;
  return m2 > 0 ? { skewness: m3 / m2 ** 1.5, kurtosis: m4 / m2 ** 2 } : { skewness: 0, kurtosis: 3 };
}

function calculateStats(
  periodName: string,
  records: BarReturnRecord[],
  barsPerYear: number,
  trials = 54
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

  // Cumulative compounded returns
  const totalGross = grossRets.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const totalMaker = makerRets.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const totalTaker = takerRets.reduce((acc, r) => acc * (1 + r), 1) - 1;

  const years = n / barsPerYear;
  const annGross = years > 0 ? (Math.pow(1 + totalGross, 1 / years) - 1) * 100 : 0;
  const annMaker = years > 0 ? (Math.pow(1 + totalMaker, 1 / years) - 1) * 100 : 0;
  const annTaker = years > 0 ? (Math.pow(1 + totalTaker, 1 / years) - 1) * 100 : 0;

  // Annualized Sharpe ratios
  const perPeriodGrossSharpe = perPeriodSharpe(grossRets);
  const perPeriodMakerSharpe = perPeriodSharpe(makerRets);
  const perPeriodTakerSharpe = perPeriodSharpe(takerRets);

  const annGrossSharpe = perPeriodGrossSharpe * Math.sqrt(barsPerYear);
  const annMakerSharpe = perPeriodMakerSharpe * Math.sqrt(barsPerYear);
  const annTakerSharpe = perPeriodTakerSharpe * Math.sqrt(barsPerYear);

  const totalTurnover = records.reduce((acc, r) => acc + r.turnover, 0);
  const annualTurnover = years > 0 ? totalTurnover / years : 0;

  const winGross = grossRets.filter((r) => r > 0).length / n;
  const winMaker = makerRets.filter((r) => r > 0).length / n;

  // Deflated Sharpe Ratio calculation
  let dsrProb: number | null = null;
  try {
    const { skewness, kurtosis } = moments(makerRets);
    const ds = deflatedSharpe({
      observedSharpe: perPeriodMakerSharpe,
      numTrials: trials,
      varianceOfTrialSharpes: 0.003, // Historical trial variance established in research
      nObservations: n,
      skewness,
      kurtosis,
    });
    dsrProb = ds.probability;
  } catch {
    dsrProb = null;
  }

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
    maxDrawdownGrossPct: calculateMaxDrawdown(grossRets),
    maxDrawdownNetMakerPct: calculateMaxDrawdown(makerRets),
    maxDrawdownNetTakerPct: calculateMaxDrawdown(takerRets),
    annualTurnover,
    winRateGross: winGross,
    winRateNetMaker: winMaker,
    dsrProbabilityNetMaker: dsrProb,
  };
}

export function runSimulation(
  barsBySymbol: Map<string, AlignedBar[]>,
  fundingBySymbol: Map<string, FundingRow[]>,
  cadence: '8h' | '24h',
  config: {
    legs: number;
    buffer: number;
    weights: FactorWeights;
    lookbackBars: number;
  }
): {
  inSample: PerformanceStats;
  outOfSample: PerformanceStats;
  fullSpan: PerformanceStats;
} {
  const barsPerYear = cadence === '8h' ? 365.25 * 3 : 365.25;

  // Find common timestamps across symbols
  const btcBars = barsBySymbol.get('BTCUSDT') ?? [];
  const commonTimestamps = btcBars.map((b) => b.timestamp);

  // Map of timestamp -> Map(symbol -> bar)
  const barLookup = new Map<number, Map<string, AlignedBar>>();
  for (const [sym, bars] of barsBySymbol.entries()) {
    for (const bar of bars) {
      let tMap = barLookup.get(bar.timestamp);
      if (!tMap) {
        tMap = new Map<string, AlignedBar>();
        barLookup.set(bar.timestamp, tMap);
      }
      tMap.set(sym, bar);
    }
  }

  let currentPositions = new Map<string, number>();
  const records: BarReturnRecord[] = [];

  const lookback = config.lookbackBars;

  // Start after warmup lookback
  for (let idx = lookback; idx < commonTimestamps.length - 1; idx++) {
    const t = commonTimestamps[idx];
    const tNext = commonTimestamps[idx + 1];

    const currentMap = barLookup.get(t);
    const nextMap = barLookup.get(tNext);
    const pastMap = barLookup.get(commonTimestamps[idx - lookback]);
    const btcCurrent = currentMap?.get('BTCUSDT');
    const btcPast = pastMap?.get('BTCUSDT');

    if (!currentMap || !nextMap || !pastMap || !btcCurrent || !btcPast) continue;

    const btcReturn = (btcCurrent.close - btcPast.close) / btcPast.close;

    // Build snapshot for all active symbols
    const snapshots: SymbolBarSnapshot[] = [];
    for (const sym of RV_SYMBOLS) {
      const cur = currentMap.get(sym);
      const past = pastMap.get(sym);
      if (!cur || !past) continue;

      const ret = (cur.close - past.close) / past.close;

      // Find last settled funding rate at or before t
      const fundings = fundingBySymbol.get(sym) ?? [];
      let lastRate = 0;
      for (let fIdx = fundings.length - 1; fIdx >= 0; fIdx--) {
        if (fundings[fIdx].t <= t) {
          lastRate = fundings[fIdx].rate;
          break;
        }
      }

      snapshots.push({
        symbol: sym,
        close: cur.close,
        return7d: ret,
        return14d: ret,
        fundingRate: lastRate,
        btcReturn14d: btcReturn,
      });
    }

    if (snapshots.length < 5) continue;

    // Compute ranks and buffered target portfolio
    const ranks = computeCrossSectionalRanks(snapshots, config.weights);
    const target = constructBufferedPortfolio(currentPositions, ranks, {
      legs: config.legs,
      buffer: config.buffer,
    });

    // Realize return over t -> tNext
    let grossReturn = 0;
    let fundingReturn = 0;

    for (const [sym, weight] of target.positions.entries()) {
      const cur = currentMap.get(sym);
      const nxt = nextMap.get(sym);
      if (!cur || !nxt) continue;

      const symbolReturn = (nxt.close - cur.close) / cur.close;
      grossReturn += weight * symbolReturn;

      // Funding cash flow: if long (weight > 0), pay funding rate; if short (weight < 0), receive funding rate
      const fundings = fundingBySymbol.get(sym) ?? [];
      let rate = 0;
      for (let fIdx = fundings.length - 1; fIdx >= 0; fIdx--) {
        if (fundings[fIdx].t <= t) {
          rate = fundings[fIdx].rate;
          break;
        }
      }
      fundingReturn += -weight * rate;
    }

    // Cost calculations
    // Maker: 0.018% fee per side (BNB discount VIP 0), 0 slippage
    const makerFee = target.turnover * 0.00018;
    // Taker: 0.05% fee + 2 bps slippage = 0.07% per side
    const takerFee = target.turnover * 0.0007;

    const netMakerReturn = grossReturn - makerFee + fundingReturn;
    const netTakerReturn = grossReturn - takerFee + fundingReturn;

    records.push({
      timestamp: t,
      grossReturn,
      netMakerReturn,
      netTakerReturn,
      fundingReturn,
      turnover: target.turnover,
      positions: Array.from(target.positions.entries()).map(([symbol, weight]) => ({ symbol, weight })),
    });

    currentPositions = target.positions;
  }

  // Partition into In-Sample (before 2025-01-01) and Out-of-Sample (2025-01-01 onward)
  const SPLIT_MS = Date.parse('2025-01-01T00:00:00.000Z');
  const isRecords = records.filter((r) => r.timestamp < SPLIT_MS);
  const oosRecords = records.filter((r) => r.timestamp >= SPLIT_MS);

  return {
    inSample: calculateStats('In-Sample (2021-10 to 2024-12)', isRecords, barsPerYear),
    outOfSample: calculateStats('Out-of-Sample (2025-01 to 2026-10)', oosRecords, barsPerYear),
    fullSpan: calculateStats('Full Span (2021-10 to 2026-10)', records, barsPerYear),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dataset-dir': { type: 'string', default: '/home/smara/dx-ds' },
      cadence: { type: 'string', default: '8h' },
      out: { type: 'string' },
      'allow-lockbox': { type: 'boolean', default: true },
      legs: { type: 'string', default: '2' },
      buffer: { type: 'string', default: '1' },
      'lookback-bars': { type: 'string', default: '42' }, // 42 bars * 8h = 14 days
    },
  });

  const datasetDir = values['dataset-dir']!;
  const cadence = (values.cadence ?? '8h') as '8h' | '24h';
  const allowLockbox = values['allow-lockbox'] ?? true;
  const legs = parseInt(values.legs ?? '2', 10);
  const buffer = parseInt(values.buffer ?? '1', 10);
  const lookbackBars = parseInt(values['lookback-bars'] ?? '42', 10);

  console.log(`=== Binance Futures Cross-Sectional Relative Value Harness ===`);
  console.log(`Dataset Directory: ${datasetDir}`);
  console.log(`Cadence: ${cadence} | Legs: ${legs} | Buffer: ${buffer} | Lookback: ${lookbackBars} bars`);

  const manifest = loadManifest(datasetDir);
  console.log(`Manifest Dataset Hash: ${manifest.datasetHash}`);

  // Load candle data and funding settlements for the 10 symbols
  const barsBySymbol = new Map<string, AlignedBar[]>();
  const fundingBySymbol = new Map<string, FundingRow[]>();

  for (const sym of RV_SYMBOLS) {
    if (cadence === '8h') {
      const { rows: candles4h } = loadCandles(datasetDir, sym, '4h', { allowLockbox });
      barsBySymbol.set(sym, aggregateTo8h(candles4h));
    } else {
      const { rows: candles1d } = loadCandles(datasetDir, sym, '1d', { allowLockbox });
      barsBySymbol.set(
        sym,
        candles1d.map((c) => ({
          timestamp: c.t,
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v,
        }))
      );
    }

    const { rows: fundingRows } = loadFunding(datasetDir, sym, { allowLockbox });
    fundingBySymbol.set(sym, fundingRows);
  }

  const result = runSimulation(barsBySymbol, fundingBySymbol, cadence, {
    legs,
    buffer,
    weights: { mom: 0.4, idio: 0.3, carry: 0.3 },
    lookbackBars,
  });

  console.log('\n--- PERFORMANCE RESULTS (DUAL TRACK) ---');
  const printRow = (title: string, s: PerformanceStats) => {
    console.log(`\n[${title}] (${s.bars} bars)`);
    console.log(`  Gross Return:      ${s.totalGrossReturnPct.toFixed(2)}% | Ann: ${s.annualizedGrossReturnPct.toFixed(2)}% | Sharpe: ${s.annualizedGrossSharpe.toFixed(2)} | MaxDD: ${s.maxDrawdownGrossPct.toFixed(2)}%`);
    console.log(`  Net Maker (BNB):   ${s.totalNetMakerReturnPct.toFixed(2)}% | Ann: ${s.annualizedNetMakerReturnPct.toFixed(2)}% | Sharpe: ${s.annualizedNetMakerSharpe.toFixed(2)} | MaxDD: ${s.maxDrawdownNetMakerPct.toFixed(2)}%`);
    console.log(`  Net Taker:         ${s.totalNetTakerReturnPct.toFixed(2)}% | Ann: ${s.annualizedNetTakerReturnPct.toFixed(2)}% | Sharpe: ${s.annualizedNetTakerSharpe.toFixed(2)} | MaxDD: ${s.maxDrawdownNetTakerPct.toFixed(2)}%`);
    console.log(`  Annual Turnover:   ${s.annualTurnover.toFixed(1)}x | Win Rate (Gross/Maker): ${(s.winRateGross * 100).toFixed(1)}% / ${(s.winRateNetMaker * 100).toFixed(1)}%`);
    if (s.dsrProbabilityNetMaker !== null) {
      console.log(`  Deflated Sharpe Probability (Net Maker): ${s.dsrProbabilityNetMaker.toFixed(4)}`);
    }
  };

  printRow('IN-SAMPLE (2021-10 to 2024-12)', result.inSample);
  printRow('OUT-OF-SAMPLE (2025-01 to 2026-10)', result.outOfSample);
  printRow('FULL 5-YEAR SPAN (2021-10 to 2026-10)', result.fullSpan);

  if (values.out) {
    const outData: SimulationResult = {
      cadence,
      datasetHash: manifest.datasetHash,
      config: {
        legs,
        buffer,
        weights: { mom: 0.4, idio: 0.3, carry: 0.3 },
        lookbackDays: (lookbackBars * (cadence === '8h' ? 8 : 24)) / 24,
      },
      ...result,
    };
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, JSON.stringify(outData, null, 2), 'utf8');
    console.log(`\nReport written to ${values.out}`);
  }
}

// Execute if run directly from CLI
if (process.argv[1]?.endsWith('cross-sectional-harness.ts')) {
  main().catch((err) => {
    console.error('Harness error:', err);
    process.exit(1);
  });
}
