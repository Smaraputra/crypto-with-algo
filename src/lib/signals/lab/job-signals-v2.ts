/**
 * Live signal jobs for the forward signal lab (lab-v2).
 *
 * Jobs:
 * - runLabV2Weekly: scores hypothesis N2-1w at the weekly close (Monday 00:00 UTC).
 * - runLabV2Daily: scores hypothesis N3-1d at each 1d close (00:00 UTC).
 *
 * Each hypothesis is scored at most once per bar close T using insertLabSignalOnce.
 * If a row already exists, the bar is recorded as waiting with reason 'exists' and skipped.
 * A first attempt that encounters any fetch error writes nothing and reports reason 'fetch_failed'.
 * A retry (final) attempt proceeds with whatever klines were fetched.
 */

import { createHash } from 'node:crypto';

import { fetchKlinesRange } from '@/lib/binance';
import { insertLabSignalOnce, LabSignal, type LabSkipReason } from '@/lib/models/lab-signal';
import { connectDB } from '@/lib/mongodb';
import { labDelayMs } from '@/lib/signals/lab/candidates';
import { latestClose, type LabSignalsReport } from '@/lib/signals/lab/job-signals';
import { n2BookAt, n2HistoryNeeded, type Bar1d } from '@/lib/signals/lab/v2/n2';
import { dailyValueAreas, n3BarsNeeded, n3Position, DAY_MS, type Bar15 } from '@/lib/signals/lab/v2/n3';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import type { OHLCV } from '@/types/market';

export interface LabV2JobDeps {
  fetchKlinesRange: typeof fetchKlinesRange;
  clock: () => number;
}

export const defaultLabV2JobDeps: LabV2JobDeps = {
  fetchKlinesRange,
  clock: () => Date.now(),
};

export type { LabSignalsReport };

function mapToBar1d(k: OHLCV): Bar1d {
  return {
    t: k.timestamp,
    o: k.open,
    h: k.high,
    l: k.low,
    c: k.close,
    v: k.volume,
    ...(k.takerBuyVolume !== undefined && Number.isFinite(k.takerBuyVolume)
      ? { tbv: k.takerBuyVolume }
      : {}),
  };
}

function mapToBar15(k: OHLCV): Bar15 {
  return {
    t: k.timestamp,
    o: k.open,
    h: k.high,
    l: k.low,
    c: k.close,
    v: k.volume,
  };
}

function computeInputsSha256<T extends { t: number }>(
  candlesBySymbol: Record<string, T[]>
): string {
  const flat: Array<Record<string, unknown>> = [];
  const symbols = Object.keys(candlesBySymbol).sort();
  for (const symbol of symbols) {
    const bars = [...(candlesBySymbol[symbol] ?? [])].sort((a, b) => a.t - b.t);
    for (const b of bars) {
      flat.push({ symbol, ...b });
    }
  }
  return createHash('sha256').update(JSON.stringify(flat)).digest('hex');
}

/**
 * N2 weekly Ridge scorer at Monday 00:00 UTC.
 */
export async function runLabV2Weekly(
  now: number,
  deps?: Partial<LabV2JobDeps>,
  opts?: { final?: boolean }
): Promise<LabSignalsReport> {
  await connectDB();
  const isFinal = opts?.final ?? false;
  const d = {
    fetchKlinesRange: deps?.fetchKlinesRange ?? defaultLabV2JobDeps.fetchKlinesRange,
    clock: deps?.clock ?? defaultLabV2JobDeps.clock,
  };

  const report: LabSignalsReport = {
    success: true,
    written: [],
    waiting: [],
    errors: [],
  };

  const T = latestClose(now, '1w');
  const D = labDelayMs('1w');

  const exists = await LabSignal.exists({ version: 'lab-v2', hypothesis: 'N2-1w', barClose: T });
  if (exists) {
    report.waiting.push({ hypothesis: 'N2-1w', barClose: T, reason: 'exists' });
    return report;
  }

  const { startTime, endTime } = n2HistoryNeeded(T);

  const settled = await Promise.allSettled(
    SIGNAL_SYMBOLS.map((symbol) =>
      d.fetchKlinesRange(symbol, '1d', startTime, endTime)
    )
  );

  const candlesBySymbol: Record<string, Bar1d[]> = {};
  const candleCounts: Record<string, number> = {};
  let hasErrors = false;

  for (let i = 0; i < SIGNAL_SYMBOLS.length; i++) {
    const symbol = SIGNAL_SYMBOLS[i];
    const res = settled[i];
    if (res.status === 'fulfilled') {
      const bars = res.value.map(mapToBar1d).filter((b) => b.t < T);
      candlesBySymbol[symbol] = bars;
      candleCounts[symbol] = bars.length;
    } else {
      hasErrors = true;
      candlesBySymbol[symbol] = [];
      candleCounts[symbol] = 0;
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
      report.errors.push(msg);
    }
  }

  if (hasErrors && !isFinal) {
    report.waiting.push({ hypothesis: 'N2-1w', barClose: T, reason: 'fetch_failed' });
    return report;
  }

  const book = n2BookAt(candlesBySymbol, T);
  const inputsSha256 = computeInputsSha256(candlesBySymbol);

  const w = d.clock();
  const late = w > T + D;

  const res = await insertLabSignalOnce({
    version: 'lab-v2',
    hypothesis: 'N2-1w',
    candidate: 'N2',
    timeframe: '1w',
    barClose: T,
    writtenAt: new Date(w),
    late,
    scores: book.weights,
    skipped: [],
    inputs: {
      reason: book.reason,
      cash: book.cash,
      predictions: book.predictions,
      eligible: book.eligible,
      candleCounts,
      inputsSha256,
    },
  });

  if (res.inserted) {
    report.written.push({ hypothesis: 'N2-1w', barClose: T, late });
  }

  return report;
}

/**
 * N3 daily Value Area breakout scorer at 1d close (00:00 UTC).
 */
export async function runLabV2Daily(
  now: number,
  deps?: Partial<LabV2JobDeps>,
  opts?: { final?: boolean }
): Promise<LabSignalsReport> {
  await connectDB();
  const isFinal = opts?.final ?? false;
  const d = {
    fetchKlinesRange: deps?.fetchKlinesRange ?? defaultLabV2JobDeps.fetchKlinesRange,
    clock: deps?.clock ?? defaultLabV2JobDeps.clock,
  };

  const report: LabSignalsReport = {
    success: true,
    written: [],
    waiting: [],
    errors: [],
  };

  const T = latestClose(now, '1d');
  const D = labDelayMs('1d');

  const exists = await LabSignal.exists({ version: 'lab-v2', hypothesis: 'N3-1d', barClose: T });
  if (exists) {
    report.waiting.push({ hypothesis: 'N3-1d', barClose: T, reason: 'exists' });
    return report;
  }

  const { startTime, endTime } = n3BarsNeeded(T);

  const settled = await Promise.allSettled(
    SIGNAL_SYMBOLS.map((symbol) =>
      d.fetchKlinesRange(symbol, '15m', startTime, endTime)
    )
  );

  const barsBySymbol: Record<string, Bar15[]> = {};
  let hasErrors = false;

  for (let i = 0; i < SIGNAL_SYMBOLS.length; i++) {
    const symbol = SIGNAL_SYMBOLS[i];
    const res = settled[i];
    if (res.status === 'fulfilled') {
      const bars = res.value.map(mapToBar15).filter((b) => b.t < T);
      barsBySymbol[symbol] = bars;
    } else {
      hasErrors = true;
      barsBySymbol[symbol] = [];
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
      report.errors.push(msg);
    }
  }

  if (hasErrors && !isFinal) {
    report.waiting.push({ hypothesis: 'N3-1d', barClose: T, reason: 'fetch_failed' });
    return report;
  }

  const scores: Record<string, number> = {};
  const skipped: { symbol: string; reason: LabSkipReason }[] = [];
  const barCounts: Record<string, Record<number, number>> = {};

  const d1 = T - 1 * DAY_MS;
  const d2 = T - 2 * DAY_MS;
  const d3 = T - 3 * DAY_MS;

  for (const symbol of SIGNAL_SYMBOLS) {
    const bars = barsBySymbol[symbol] ?? [];

    const counts: Record<number, number> = {
      [d3]: 0,
      [d2]: 0,
      [d1]: 0,
    };
    for (const b of bars) {
      const dayT = Math.floor(b.t / DAY_MS) * DAY_MS;
      counts[dayT] = (counts[dayT] ?? 0) + 1;
    }
    barCounts[symbol] = counts;

    const vas = dailyValueAreas(bars);
    const va1 = vas.get(d1);
    const va2 = vas.get(d2);
    const va3 = vas.get(d3);

    if (!va1 || !va2 || !va3) {
      skipped.push({ symbol, reason: 'va_incomplete' });
      continue;
    }

    const pos = n3Position(vas, T);
    if (pos !== 0) {
      scores[symbol] = pos;
    }
  }

  const inputsSha256 = computeInputsSha256(barsBySymbol);
  const w = d.clock();
  const late = w > T + D;

  const res = await insertLabSignalOnce({
    version: 'lab-v2',
    hypothesis: 'N3-1d',
    candidate: 'N3',
    timeframe: '1d',
    barClose: T,
    writtenAt: new Date(w),
    late,
    scores,
    skipped,
    inputs: {
      barCounts,
      inputsSha256,
    },
  });

  if (res.inserted) {
    report.written.push({ hypothesis: 'N3-1d', barClose: T, late });
  }

  return report;
}
