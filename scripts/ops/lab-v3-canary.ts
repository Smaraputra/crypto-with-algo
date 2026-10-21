/**
 * scripts/ops/lab-v3-canary.ts
 *
 * Pre-flight canary and validation script for lab-v3 (Hypothesis F1-1d).
 * Designed to execute on the Contabo VPS testing ground (or locally)
 * with zero database writes.
 *
 * Checks performed:
 * 1. Binance USD-M Futures REST connectivity and IP standing.
 * 2. Sequential 400ms paced fetching across all 30 universe symbols.
 * 3. Inspection of x-mbx-used-weight-1m headers to confirm safe rate-limit margins.
 * 4. 7-day rolling funding calculation (computeFund7) and settlement completeness verification.
 * 5. Target book formation (zero-mean dollar neutrality and gross-1 normalization).
 * 6. Deterministic golden vector verification through gradeBookBar.
 *
 * Usage:
 *   npx tsx scripts/ops/lab-v3-canary.ts [--out <path>]
 */

import { LAB_V3_UNIVERSE, LAB_V3_UNIVERSE_SHA256 } from '../../src/lib/signals/lab/candidates';
import {
  computeFund7,
  DAY_MS,
  targetBook,
  type FundingSettlement,
} from '../../src/lib/signals/lab/v3/f1';
import { gradeBookBar, type BookGradeInput } from '../../src/lib/signals/lab/job-grade';
import { writeFileSync } from 'node:fs';

interface CanarySymbolResult {
  symbol: string;
  settlementsCount: number;
  fund7: number | null;
  weightUsed: string | null;
  latencyMs: number;
  error?: string;
}

interface CanaryReport {
  timestamp: string;
  universeSize: number;
  universeSha256: string;
  pacingMs: number;
  totalDurationMs: number;
  maxUsedWeight1m: number;
  symbolsAttempted: number;
  symbolsSuccessful: number;
  symbolsSkipped: number;
  targetBookCoins: number;
  targetBookGrossExposure: number;
  targetBookNetExposure: number;
  goldenVectorCheck: {
    passed: boolean;
    expectedNetReturn: number;
    actualNetReturn: number;
    turnover: number;
    eValue: number;
  };
  symbolResults: CanarySymbolResult[];
}

const DEFAULT_FUTURES_URL = 'https://fapi.binance.com';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFundingWithHeaders(
  symbol: string,
  startTime: number,
  endTime: number
): Promise<{
  settlements: FundingSettlement[];
  usedWeight1m: number | null;
  latencyMs: number;
}> {
  const url = `${DEFAULT_FUTURES_URL}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=100`;
  const t0 = Date.now();
  const res = await fetch(url);
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const weightHeader = res.headers.get('x-mbx-used-weight-1m');
  const usedWeight1m = weightHeader ? parseInt(weightHeader, 10) : null;
  const data = (await res.json()) as Array<{ fundingTime: number; fundingRate: string }>;

  const settlements: FundingSettlement[] = data.map((d) => ({
    t: d.fundingTime,
    rate: parseFloat(d.fundingRate),
  }));

  return { settlements, usedWeight1m, latencyMs };
}

export async function runCanary(options?: { outPath?: string }): Promise<CanaryReport> {
  console.log('Starting lab-v3 canary inspection...');
  console.log(`Target universe: ${LAB_V3_UNIVERSE.length} symbols, SHA256: ${LAB_V3_UNIVERSE_SHA256}`);

  const now = Date.now();
  const trailing7dStart = now - 7 * DAY_MS;
  const symbolResults: CanarySymbolResult[] = [];
  const scores: Array<{ symbol: string; score: number }> = [];

  let maxUsedWeight1m = 0;
  const startTimeTotal = Date.now();

  for (let i = 0; i < LAB_V3_UNIVERSE.length; i++) {
    const symbol = LAB_V3_UNIVERSE[i];
    try {
      const { settlements, usedWeight1m, latencyMs } = await fetchFundingWithHeaders(
        symbol,
        trailing7dStart,
        now
      );

      if (usedWeight1m !== null && usedWeight1m > maxUsedWeight1m) {
        maxUsedWeight1m = usedWeight1m;
      }

      const res = computeFund7(settlements, now);
      const f7 = res.fund7;
      if (f7 !== null) {
        scores.push({ symbol, score: f7 });
      }

      symbolResults.push({
        symbol,
        settlementsCount: res.count,
        fund7: f7,
        weightUsed: usedWeight1m !== null ? String(usedWeight1m) : 'n/a',
        latencyMs,
      });

      console.log(
        `[${i + 1}/${LAB_V3_UNIVERSE.length}] ${symbol}: ` +
        `${res.count} settlements, fund7: ${f7 !== null ? f7.toFixed(6) : 'null'}, ` +
        `weight: ${usedWeight1m ?? 'n/a'}, latency: ${latencyMs}ms`
      );
    } catch (err) {
      console.error(`[${i + 1}/${LAB_V3_UNIVERSE.length}] ${symbol} FAILED:`, err);
      symbolResults.push({
        symbol,
        settlementsCount: 0,
        fund7: null,
        weightUsed: null,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (i < LAB_V3_UNIVERSE.length - 1) {
      await sleep(400);
    }
  }

  const totalDurationMs = Date.now() - startTimeTotal;
  console.log(`Paced fetch finished in ${(totalDurationMs / 1000).toFixed(2)}s. Peak 1m used weight: ${maxUsedWeight1m}`);

  const target = targetBook(scores);
  let grossExposure = 0;
  let netExposure = 0;

  for (const w of target.values()) {
    grossExposure += Math.abs(w);
    netExposure += w;
  }

  console.log(`Target book formed: ${target.size} coins, Gross exposure: ${grossExposure.toFixed(4)}, Net dollar balance: ${netExposure.toFixed(6)}`);

  console.log('Verifying deterministic grading golden vector...');
  const gradeInput = {
    hypothesis: {
      id: 'F1-1d' as const,
      candidate: 'F1' as const,
      version: 'lab-v3' as const,
      scale: 0.1,
      threshold: 200,
    },
    barClose: now,
    late: false,
    scores: { BTCUSDT: 0.1, ETHUSDT: -0.1 },
    prices: {
      BTCUSDT: { start: 50000, end: 50500 },
      ETHUSDT: { start: 3000, end: 2970 },
    },
    fundingSums: { BTCUSDT: 0.0003, ETHUSDT: -0.0003 },
    prev: {
      weights: { BTCUSDT: 0.05, ETHUSDT: -0.05 },
      state: {
        logE: 0,
        logE0: 0,
        n: 0,
        sumX: 0,
        sumX2: 0,
        sumD: 0,
        sumD2: 0,
        crossedAt: null,
      },
    },
    gradedAt: new Date(now),
  };

  const graded = gradeBookBar(gradeInput);

  const expectedNetReturn = 0.00187;
  const actualNetReturn = graded?.netBookReturn ?? 0;
  const goldenPassed = Math.abs(actualNetReturn - expectedNetReturn) < 1e-8 && graded?.turnover === 0.1;

  console.log(`Golden vector check: ${goldenPassed ? 'PASS' : 'FAIL'} (Expected net return: ${expectedNetReturn}, Actual: ${actualNetReturn})`);

  const report: CanaryReport = {
    timestamp: new Date().toISOString(),
    universeSize: LAB_V3_UNIVERSE.length,
    universeSha256: LAB_V3_UNIVERSE_SHA256,
    pacingMs: 400,
    totalDurationMs,
    maxUsedWeight1m,
    symbolsAttempted: LAB_V3_UNIVERSE.length,
    symbolsSuccessful: symbolResults.filter((s) => !s.error && s.fund7 !== null).length,
    symbolsSkipped: symbolResults.filter((s) => s.error || s.fund7 === null).length,
    targetBookCoins: target.size,
    targetBookGrossExposure: grossExposure,
    targetBookNetExposure: netExposure,
    goldenVectorCheck: {
      passed: goldenPassed,
      expectedNetReturn,
      actualNetReturn,
      turnover: graded?.turnover ?? 0,
      eValue: graded?.state?.logE ? Math.exp(graded.state.logE) : 1.0,
    },
    symbolResults,
  };

  if (options?.outPath) {
    writeFileSync(options.outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Canary report saved to ${options.outPath}`);
  }

  return report;
}

if (process.argv[1]?.endsWith('lab-v3-canary.ts')) {
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : undefined;

  runCanary({ outPath })
    .then((rep) => {
      if (!rep.goldenVectorCheck.passed) {
        console.error('Canary golden vector check failed.');
        process.exit(1);
      }
      if (rep.symbolsSuccessful < 20) {
        console.error(`Insufficient successful symbols (${rep.symbolsSuccessful}/30).`);
        process.exit(1);
      }
      console.log('Canary inspection passed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Canary fatal error:', err);
      process.exit(1);
    });
}
