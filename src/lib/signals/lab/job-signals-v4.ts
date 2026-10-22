/**
 * Live signal jobs for the forward signal lab (lab-v4).
 *
 * Jobs:
 * - runLabV4Hourly: scores hypotheses S1-1h and S2-1h after each 1h bar close across
 *   the 10 signal symbols (SIGNAL_SYMBOLS).
 *
 * Each hourly run evaluates contiguous 720 1h bars ending at T - 1h for each symbol:
 * - S1: structure reversal confirmed by flow (swing CHoCH with agreeing barDelta);
 * - S2: flow divergence at swing pivots (regular bear/bull delta divergence, fade).
 *
 * In-trade rule:
 * A trade enters at T + D (10 min) and is held 8 hours. One trade per coin at a time.
 * If a coin had an active trade entered in (T - 8h, T), any new signal on this bar
 * is skipped with reason 'in_trade' and not stored in scores.
 *
 * First attempt versus retry:
 * On a non-final attempt, any REST fetch error aborts writing and reports 'fetch_failed'.
 * On a final attempt, the failed symbol is skipped with 'bars_incomplete_v4'.
 */

import { fetchPerpKlinesOhlcv } from '@/lib/binance-futures';
import { insertLabSignalOnce, LabSignal, type LabSkipReason } from '@/lib/models/lab-signal';
import { connectDB } from '@/lib/mongodb';
import {
  LAB_HYPOTHESES_V4,
  LAB_V4_HOLD_MS,
  LAB_VERSION_V4,
  labDelayMs,
  type LabHypothesis,
} from '@/lib/signals/lab/candidates';
import { latestClose, type LabSignalsReport } from '@/lib/signals/lab/job-signals';
import {
  HOUR_MS,
  isContiguousHourly,
  LAB_V4_WINDOW_BARS,
  s1SideAtLast,
  s2SideAtLast,
} from '@/lib/signals/lab/v4/rules';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

export interface LabV4JobDeps {
  fetchPerpKlinesOhlcv: typeof fetchPerpKlinesOhlcv;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultLabV4JobDeps: LabV4JobDeps = {
  fetchPerpKlinesOhlcv,
  clock: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type { LabSignalsReport };

export async function runLabV4Hourly(
  now: number,
  deps?: Partial<LabV4JobDeps>,
  opts?: { final?: boolean }
): Promise<LabSignalsReport> {
  await connectDB();
  const isFinal = opts?.final ?? false;
  const d: LabV4JobDeps = {
    fetchPerpKlinesOhlcv: deps?.fetchPerpKlinesOhlcv ?? defaultLabV4JobDeps.fetchPerpKlinesOhlcv,
    clock: deps?.clock ?? defaultLabV4JobDeps.clock,
    sleep: deps?.sleep ?? defaultLabV4JobDeps.sleep,
  };

  const report: LabSignalsReport = {
    success: true,
    written: [],
    waiting: [],
    errors: [],
  };

  const T = latestClose(now, '1h');
  const D = labDelayMs('1h');

  const hypothesesToRun: LabHypothesis[] = [];
  for (const hyp of LAB_HYPOTHESES_V4) {
    const exists = await LabSignal.exists({ version: LAB_VERSION_V4, hypothesis: hyp.id, barClose: T });
    if (exists) {
      report.waiting.push({ hypothesis: hyp.id, barClose: T, reason: 'exists' });
    } else {
      hypothesesToRun.push(hyp);
    }
  }

  if (hypothesesToRun.length === 0) {
    return report;
  }

  const rawSides: Record<'S1' | 'S2', Record<string, number>> = {
    S1: {},
    S2: {},
  };
  const skippedByCandidate: Record<'S1' | 'S2', { symbol: string; reason: LabSkipReason }[]> = {
    S1: [],
    S2: [],
  };

  let hasFetchError = false;

  for (let i = 0; i < SIGNAL_SYMBOLS.length; i++) {
    const symbol = SIGNAL_SYMBOLS[i];
    if (i > 0) {
      await d.sleep(150);
    }

    try {
      const allBars = await d.fetchPerpKlinesOhlcv(symbol, '1h', LAB_V4_WINDOW_BARS + 2);
      const closed = allBars
        .filter((b) => b.timestamp + HOUR_MS <= T)
        .slice(-LAB_V4_WINDOW_BARS);

      if (closed.length < LAB_V4_WINDOW_BARS || !isContiguousHourly(closed, T - HOUR_MS)) {
        skippedByCandidate.S1.push({ symbol, reason: 'bars_incomplete_v4' });
        skippedByCandidate.S2.push({ symbol, reason: 'bars_incomplete_v4' });
      } else {
        const s1 = s1SideAtLast(closed);
        const s2 = s2SideAtLast(closed);
        if (s1 !== 0) rawSides.S1[symbol] = s1;
        if (s2 !== 0) rawSides.S2[symbol] = s2;
      }
    } catch (err: unknown) {
      hasFetchError = true;
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`${symbol}: ${msg}`);
      if (isFinal) {
        skippedByCandidate.S1.push({ symbol, reason: 'bars_incomplete_v4' });
        skippedByCandidate.S2.push({ symbol, reason: 'bars_incomplete_v4' });
      }
    }
  }

  if (hasFetchError && !isFinal) {
    for (const hyp of hypothesesToRun) {
      report.waiting.push({ hypothesis: hyp.id, barClose: T, reason: 'fetch_failed' });
    }
    return report;
  }

  for (const hyp of hypothesesToRun) {
    const candidateId = hyp.candidate as 'S1' | 'S2';
    const candidateSides = rawSides[candidateId];
    const candidateSkipped = [...skippedByCandidate[candidateId]];

    const priorSignals = await LabSignal.find({
      version: LAB_VERSION_V4,
      hypothesis: hyp.id,
      barClose: { $gt: T - LAB_V4_HOLD_MS, $lt: T },
    }).lean();

    const inTrade = new Set<string>();
    for (const row of priorSignals) {
      if (row.scores && typeof row.scores === 'object') {
        for (const [sym, sc] of Object.entries(row.scores)) {
          if (typeof sc === 'number' && sc !== 0) {
            inTrade.add(sym);
          }
        }
      }
    }

    const scores: Record<string, number> = {};
    for (const [sym, side] of Object.entries(candidateSides)) {
      if (side !== 0) {
        if (inTrade.has(sym)) {
          candidateSkipped.push({ symbol: sym, reason: 'in_trade' });
        } else {
          scores[sym] = side;
        }
      }
    }

    const w = d.clock();
    const late = w > T + D;

    const res = await insertLabSignalOnce({
      version: LAB_VERSION_V4,
      hypothesis: hyp.id,
      candidate: hyp.candidate,
      timeframe: '1h',
      barClose: T,
      writtenAt: new Date(w),
      late,
      scores,
      skipped: candidateSkipped,
      inputs: {
        windowBars: LAB_V4_WINDOW_BARS,
        lastBarOpen: T - HOUR_MS,
      },
    });

    if (res.inserted) {
      report.written.push({ hypothesis: hyp.id, barClose: T, late });
    }
  }

  return report;
}
