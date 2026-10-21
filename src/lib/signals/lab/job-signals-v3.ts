/**
 * Live signal jobs for the forward signal lab (lab-v3).
 *
 * Jobs:
 * - runLabV3Daily: scores hypothesis F1-1d at each 1d close (00:00 UTC) across the
 *   frozen top-30 perpetual universe (LAB_V3_UNIVERSE).
 *
 * It sleeps 100 ms between funding fetches, rounds settlement times to the
 * boundary, and skips symbols that exchangeInfo does not list as TRADING ('delisted').
 *
 * Scored at most once per bar close T using insertLabSignalOnce.
 * If a row already exists, the bar is recorded as waiting with reason 'exists' and skipped.
 * A first attempt that encounters any fetch error writes nothing and reports reason 'fetch_failed'.
 * A retry (final) attempt proceeds with whatever funding settlements were fetched.
 */

import { fetchPerpExchangeInfo } from '@/lib/binance-futures';
import { settlementTimeOf } from '@/lib/funding-settlements';
import { insertLabSignalOnce, LabSignal, type LabSkipReason } from '@/lib/models/lab-signal';
import { connectDB } from '@/lib/mongodb';
import { LAB_V3_UNIVERSE, labDelayMs } from '@/lib/signals/lab/candidates';
import { latestClose, type LabSignalsReport } from '@/lib/signals/lab/job-signals';
import { computeFund7, DAY_MS, STAGGER_DAYS, staggeredBook, targetBook, type FundingSettlement } from '@/lib/signals/lab/v3/f1';
import { fetchFundingHistory } from '@/lib/snapshot-backfill';

export interface LabV3JobDeps {
  fetchFundingHistory: (symbol: string, startTime: number, endTime: number) => Promise<Array<{ fundingTime: number; fundingRate: number }>>;
  fetchExchangeInfo: () => Promise<Array<{ symbol: string; status: string }>>;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultLabV3JobDeps: LabV3JobDeps = {
  fetchFundingHistory,
  fetchExchangeInfo: fetchPerpExchangeInfo,
  clock: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type { LabSignalsReport };

export async function runLabV3Daily(
  now: number,
  deps?: Partial<LabV3JobDeps>,
  opts?: { final?: boolean }
): Promise<LabSignalsReport> {
  await connectDB();
  const isFinal = opts?.final ?? false;
  const d: LabV3JobDeps = {
    fetchFundingHistory: deps?.fetchFundingHistory ?? defaultLabV3JobDeps.fetchFundingHistory,
    fetchExchangeInfo: deps?.fetchExchangeInfo ?? defaultLabV3JobDeps.fetchExchangeInfo,
    clock: deps?.clock ?? defaultLabV3JobDeps.clock,
    sleep: deps?.sleep ?? defaultLabV3JobDeps.sleep,
  };

  const report: LabSignalsReport = {
    success: true,
    written: [],
    waiting: [],
    errors: [],
  };

  const T = latestClose(now, '1d');
  const D = labDelayMs('1d');

  const exists = await LabSignal.exists({ version: 'lab-v3', hypothesis: 'F1-1d', barClose: T });
  if (exists) {
    report.waiting.push({ hypothesis: 'F1-1d', barClose: T, reason: 'exists' });
    return report;
  }

  let trading: Set<string> | null = null;
  try {
    const exchangeInfo = await d.fetchExchangeInfo();
    trading = new Set(
      exchangeInfo.filter((s) => s.status === 'TRADING').map((s) => s.symbol)
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`exchangeInfo: ${msg}`);
    if (!isFinal) {
      report.waiting.push({ hypothesis: 'F1-1d', barClose: T, reason: 'fetch_failed' });
      return report;
    }
  }

  // Trailing 14 days of funding settlements to calculate fund7 at T
  const startTime = T - 14 * DAY_MS;
  const endTime = T + 60_000;

  const rawScores: Array<{ symbol: string; score: number }> = [];
  const skipped: { symbol: string; reason: LabSkipReason }[] = [];
  const settlementsCountBySymbol: Record<string, number> = {};
  let hasErrors = false;
  let fetchedCount = 0;

  for (let i = 0; i < LAB_V3_UNIVERSE.length; i++) {
    const symbol = LAB_V3_UNIVERSE[i];

    if (trading && !trading.has(symbol)) {
      skipped.push({ symbol, reason: 'delisted' });
      continue;
    }

    if (fetchedCount > 0) {
      await d.sleep(100);
    }
    fetchedCount++;

    try {
      const history = await d.fetchFundingHistory(symbol, startTime, endTime);
      const byBoundary = new Map<number, { fundingTime: number; fundingRate: number }>();
      for (const h of history) {
        if (!Number.isFinite(h.fundingTime) || !Number.isFinite(h.fundingRate)) continue;
        const key = settlementTimeOf(h.fundingTime);
        const prior = byBoundary.get(key);
        if (!prior || h.fundingTime > prior.fundingTime) {
          byBoundary.set(key, h);
        }
      }

      const settlements: FundingSettlement[] = Array.from(byBoundary.entries()).map(([t, h]) => ({
        t,
        rate: h.fundingRate,
      }));

      const { fund7, count } = computeFund7(settlements, T);
      settlementsCountBySymbol[symbol] = count;

      if (fund7 === null) {
        skipped.push({ symbol, reason: 'funding_incomplete' });
      } else {
        rawScores.push({ symbol, score: fund7 });
      }
    } catch (err: unknown) {
      hasErrors = true;
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`${symbol}: ${msg}`);
      skipped.push({ symbol, reason: 'funding_incomplete' });
    }
  }

  if (hasErrors && !isFinal) {
    report.waiting.push({ hypothesis: 'F1-1d', barClose: T, reason: 'fetch_failed' });
    return report;
  }

  const currTarget = targetBook(rawScores);

  // Retrieve past 6 daily target books to form the 7-day staggered book
  const pastBarCloses: number[] = [];
  for (let k = 1; k < STAGGER_DAYS; k++) {
    pastBarCloses.push(T - k * DAY_MS);
  }

  const priorSignals = await LabSignal.find({
    version: 'lab-v3',
    hypothesis: 'F1-1d',
    barClose: { $in: pastBarCloses },
  }).lean();

  const priorSignalsByClose = new Map<number, (typeof priorSignals)[number]>();
  for (const s of priorSignals) {
    priorSignalsByClose.set(s.barClose, s);
  }

  const pastTargets: Array<Map<string, number>> = [];
  for (let k = 1; k < STAGGER_DAYS; k++) {
    const pastClose = T - k * DAY_MS;
    const prior = priorSignalsByClose.get(pastClose);
    if (prior && prior.inputs && typeof prior.inputs === 'object' && 'targetBook' in prior.inputs) {
      const targetObj = (prior.inputs as { targetBook?: Record<string, number> }).targetBook ?? {};
      pastTargets.push(new Map(Object.entries(targetObj)));
    } else {
      pastTargets.push(new Map<string, number>());
    }
  }

  const activeWeights = staggeredBook([currTarget, ...pastTargets]);
  const activeWeightsRecord: Record<string, number> = Object.fromEntries(activeWeights);

  const w = d.clock();
  const late = w > T + D;

  const res = await insertLabSignalOnce({
    version: 'lab-v3',
    hypothesis: 'F1-1d',
    candidate: 'F1',
    timeframe: '1d',
    barClose: T,
    writtenAt: new Date(w),
    late,
    scores: activeWeightsRecord,
    skipped,
    inputs: {
      rawScores: Object.fromEntries(rawScores.map((s) => [s.symbol, s.score])),
      targetBook: Object.fromEntries(currTarget),
      settlementsCountBySymbol,
      priorDaysFound: priorSignals.length,
    },
  });

  if (res.inserted) {
    report.written.push({ hypothesis: 'F1-1d', barClose: T, late });
  }

  return report;
}
