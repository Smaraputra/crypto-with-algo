/**
 * Live signal jobs for the forward signal lab (lab-v1).
 *
 * Schedule:
 * - runLabSignals8h: called at minute 3 (first attempt) and minute 8 (final attempt) after each 8h close. A first attempt that hits any REST error writes nothing for that hypothesis, so the final attempt can still store a complete cross-section. A first attempt also waits when any coin would be skipped, so a short Binance response cannot freeze a degraded row.
 * - runLabSignalsFast: called every minute to score L2 at 5m, 15m, 1h, 4h, and 1d.
 *
 * Write-once rule:
 * Each hypothesis is scored at most once per bar close T using insertLabSignalOnce.
 * Before performing any venue fetches or intensive queries, LabSignal.exists is checked.
 * If a row already exists, the bar is recorded as waiting with reason 'exists' and skipped.
 *
 * Fast bar v8 completion window:
 * Fast bars require a complete cross-section of all 10 signal symbols for ranking.
 * Scorer jobs across symbols may finish slightly after the bar close.
 * If fewer than 10 symbols have a v8 row and more than 60 seconds remain before T + D,
 * the job records reason 'v8_incomplete' and waits for the next minute retry.
 * Within 60 seconds of T + D, the job proceeds with whatever rows exist so the bet window is not missed.
 *
 * L4 ratio fetch point count:
 * L4 positioning reads the ratio point stamped exactly T - 4h (T - L4_LAG_MS) as its latest.
 * The point stamped T may already be published by Binance at or slightly after T.
 * Fetching L4_POINTS + 2 (182 points) guarantees that the 180 consecutive points up to T - 4h
 * are captured even if the venue payload includes the newer point at T.
 */

import { fetchLongShortRatio, fetchPerpKlinesRange } from '@/lib/binance-futures';
import { GlobalSignal } from '@/lib/models/global-signal';
import { insertLabSignalOnce, LabSignal } from '@/lib/models/lab-signal';
import { RvSignal } from '@/lib/models/rv-signal';
import { connectDB } from '@/lib/mongodb';
import {
  L2_V8_CONFIG_VERSION,
  L2_V8_STYLE,
  L3_BARS,
  L4_PERIOD,
  L4_POINTS,
  LAB_TIMEFRAME_MS,
  LAB_VERSION,
  labDelayMs,
  type LabTimeframe,
} from '@/lib/signals/lab/candidates';
import {
  type HourBar,
  l1Scores,
  l2Scores,
  l3Scores,
  l4Scores,
  type RatioPoint,
} from '@/lib/signals/lab/factors';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

export interface LabJobDeps {
  fetchPerpKlinesRange: typeof fetchPerpKlinesRange;
  fetchLongShortRatio: typeof fetchLongShortRatio;
  /** Wall clock in ms, read immediately before each write. */
  clock: () => number;
}

export const defaultLabJobDeps: LabJobDeps = {
  fetchPerpKlinesRange,
  fetchLongShortRatio,
  clock: () => Date.now(),
};

export interface LabSignalsReport {
  success: boolean;
  written: { hypothesis: string; barClose: number; late: boolean }[];
  /** Bars this run did not write, and why (none is an error). */
  waiting: {
    hypothesis: string;
    barClose: number;
    reason:
      | 'exists'
      | 'rv_signal_missing'
      | 'v8_incomplete'
      | 'window_passed'
      | 'fetch_failed'
      | 'inputs_incomplete';
  }[];
  errors: string[];
}

/** The latest bar close at or before `now`: Math.floor(now / Δ) * Δ. 1d closes fall on 00:00 UTC. */
export function latestClose(now: number, tf: LabTimeframe): number {
  const delta = LAB_TIMEFRAME_MS[tf];
  return Math.floor(now / delta) * delta;
}

/** L1, L3 and L4 at the 8h close. Called at minutes 3 and 8 after each close. */
export async function runLabSignals8h(
  now: number,
  deps: LabJobDeps = defaultLabJobDeps,
  opts?: { final?: boolean }
): Promise<LabSignalsReport> {
  await connectDB();
  const isFinal = opts?.final ?? false;
  const d: LabJobDeps = {
    fetchPerpKlinesRange: deps?.fetchPerpKlinesRange ?? defaultLabJobDeps.fetchPerpKlinesRange,
    fetchLongShortRatio: deps?.fetchLongShortRatio ?? defaultLabJobDeps.fetchLongShortRatio,
    clock: deps?.clock ?? defaultLabJobDeps.clock,
  };

  const report: LabSignalsReport = {
    success: true,
    written: [],
    waiting: [],
    errors: [],
  };

  const T = latestClose(now, '8h');
  const D = labDelayMs('8h');

  // L1-8h
  const l1Exists = await LabSignal.exists({ version: LAB_VERSION, hypothesis: 'L1-8h', barClose: T });
  if (l1Exists) {
    report.waiting.push({ hypothesis: 'L1-8h', barClose: T, reason: 'exists' });
  } else {
    const rv = await RvSignal.findOne({ version: 'rv-v1', barCloseTime: T }).lean();
    if (!rv) {
      report.waiting.push({ hypothesis: 'L1-8h', barClose: T, reason: 'rv_signal_missing' });
    } else {
      const { scores, skipped } = l1Scores(SIGNAL_SYMBOLS, rv.ranked ?? []);
      const w = d.clock();
      const late = w > T + D;
      const inputs = { rvBarTime: rv.barTime, rvCreatedAt: rv.createdAt };
      const res = await insertLabSignalOnce({
        version: LAB_VERSION,
        hypothesis: 'L1-8h',
        candidate: 'L1',
        timeframe: '8h',
        barClose: T,
        writtenAt: new Date(w),
        late,
        scores,
        skipped,
        inputs,
      });
      if (res.inserted) {
        report.written.push({ hypothesis: 'L1-8h', barClose: T, late });
      }
    }
  }

  // L3-8h
  const l3Exists = await LabSignal.exists({ version: LAB_VERSION, hypothesis: 'L3-8h', barClose: T });
  if (l3Exists) {
    report.waiting.push({ hypothesis: 'L3-8h', barClose: T, reason: 'exists' });
  } else {
    const l3Settled = await Promise.allSettled(
      SIGNAL_SYMBOLS.map((symbol) =>
        d.fetchPerpKlinesRange(symbol, '1h', T - L3_BARS * 3_600_000, T - 1)
      )
    );

    const barsBySymbol: Record<string, HourBar[] | undefined> = {};
    const lastBarOpenTime: Record<string, number | null> = {};
    const l3Errors: Record<string, string> = {};

    for (let i = 0; i < SIGNAL_SYMBOLS.length; i++) {
      const symbol = SIGNAL_SYMBOLS[i];
      const res = l3Settled[i];
      if (res.status === 'fulfilled') {
        const klines = res.value;
        const bars: HourBar[] = klines.map((k) => ({
          openTime: k.openTime,
          closeTime: k.closeTime,
          close: k.close,
        }));
        barsBySymbol[symbol] = bars;
        lastBarOpenTime[symbol] = bars.length > 0 ? bars[bars.length - 1].openTime : null;
      } else {
        barsBySymbol[symbol] = undefined;
        lastBarOpenTime[symbol] = null;
        const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        l3Errors[symbol] = msg;
        report.errors.push(msg);
      }
    }

    const hasL3Errors = Object.keys(l3Errors).length > 0;
    if (hasL3Errors && !isFinal) {
      report.waiting.push({ hypothesis: 'L3-8h', barClose: T, reason: 'fetch_failed' });
    } else {
      const { scores, skipped } = l3Scores(SIGNAL_SYMBOLS, barsBySymbol, T);
      if (skipped.length > 0 && !isFinal) {
        report.waiting.push({ hypothesis: 'L3-8h', barClose: T, reason: 'inputs_incomplete' });
      } else {
        const w = d.clock();
        const late = w > T + D;
        const inputs = { lastBarOpenTime, errors: l3Errors };
        const res = await insertLabSignalOnce({
          version: LAB_VERSION,
          hypothesis: 'L3-8h',
          candidate: 'L3',
          timeframe: '8h',
          barClose: T,
          writtenAt: new Date(w),
          late,
          scores,
          skipped,
          inputs,
        });
        if (res.inserted) {
          report.written.push({ hypothesis: 'L3-8h', barClose: T, late });
        }
      }
    }
  }

  // L4-8h
  const l4Exists = await LabSignal.exists({ version: LAB_VERSION, hypothesis: 'L4-8h', barClose: T });
  if (l4Exists) {
    report.waiting.push({ hypothesis: 'L4-8h', barClose: T, reason: 'exists' });
  } else {
    const l4Settled = await Promise.allSettled(
      SIGNAL_SYMBOLS.map((symbol) =>
        d.fetchLongShortRatio(symbol, L4_PERIOD, L4_POINTS + 2)
      )
    );

    const pointsBySymbol: Record<string, RatioPoint[] | undefined> = {};
    const l4Errors: Record<string, string> = {};

    for (let i = 0; i < SIGNAL_SYMBOLS.length; i++) {
      const symbol = SIGNAL_SYMBOLS[i];
      const res = l4Settled[i];
      if (res.status === 'fulfilled') {
        const points: RatioPoint[] = res.value.map((p) => ({
          timestamp: p.timestamp,
          longShortRatio: p.longShortRatio,
        }));
        pointsBySymbol[symbol] = points;
      } else {
        pointsBySymbol[symbol] = undefined;
        const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        l4Errors[symbol] = msg;
        report.errors.push(msg);
      }
    }

    const hasL4Errors = Object.keys(l4Errors).length > 0;
    if (hasL4Errors && !isFinal) {
      report.waiting.push({ hypothesis: 'L4-8h', barClose: T, reason: 'fetch_failed' });
    } else {
      const { result, inputs: l4ScoreInputs } = l4Scores(SIGNAL_SYMBOLS, pointsBySymbol, T);
      if (result.skipped.length > 0 && !isFinal) {
        report.waiting.push({ hypothesis: 'L4-8h', barClose: T, reason: 'inputs_incomplete' });
      } else {
        const w = d.clock();
        const late = w > T + D;
        const inputs = { points: l4ScoreInputs, errors: l4Errors };
        const res = await insertLabSignalOnce({
          version: LAB_VERSION,
          hypothesis: 'L4-8h',
          candidate: 'L4',
          timeframe: '8h',
          barClose: T,
          writtenAt: new Date(w),
          late,
          scores: result.scores,
          skipped: result.skipped,
          inputs,
        });
        if (res.inserted) {
          report.written.push({ hypothesis: 'L4-8h', barClose: T, late });
        }
      }
    }
  }

  return report;
}

const FAST_TIMEFRAMES: readonly ('5m' | '15m' | '1h' | '4h' | '1d')[] = [
  '5m',
  '15m',
  '1h',
  '4h',
  '1d',
];

/** L2 at every timeframe whose bar just closed. Called every minute. */
export async function runLabSignalsFast(
  now: number,
  deps: LabJobDeps = defaultLabJobDeps
): Promise<LabSignalsReport> {
  await connectDB();
  const d: LabJobDeps = {
    fetchPerpKlinesRange: deps?.fetchPerpKlinesRange ?? defaultLabJobDeps.fetchPerpKlinesRange,
    fetchLongShortRatio: deps?.fetchLongShortRatio ?? defaultLabJobDeps.fetchLongShortRatio,
    clock: deps?.clock ?? defaultLabJobDeps.clock,
  };

  const report: LabSignalsReport = {
    success: true,
    written: [],
    waiting: [],
    errors: [],
  };

  for (const tf of FAST_TIMEFRAMES) {
    const delta = LAB_TIMEFRAME_MS[tf];
    const D = labDelayMs(tf);
    const hypothesis = `L2-${tf}`;
    const T = latestClose(now, tf);

    if (now > T + D) {
      report.waiting.push({ hypothesis, barClose: T, reason: 'window_passed' });
      continue;
    }

    const exists = await LabSignal.exists({ version: LAB_VERSION, hypothesis, barClose: T });
    if (exists) {
      report.waiting.push({ hypothesis, barClose: T, reason: 'exists' });
      continue;
    }

    const v8Rows = await GlobalSignal.find({
      tradingStyle: L2_V8_STYLE[tf],
      interval: tf,
      candleTimestamp: T - delta,
      configVersion: L2_V8_CONFIG_VERSION,
      // a row created before T could only describe a forming bar.
      createdAt: { $gte: new Date(T) },
    })
      .sort({ createdAt: 1 })
      .lean();

    const v8BySymbol: Record<string, { score: number; candleTimestamp: number; createdAt: Date }> = {};
    const v8ScoresOnly: Record<string, number> = {};

    for (const row of v8Rows) {
      if (!v8BySymbol[row.symbol]) {
        v8BySymbol[row.symbol] = {
          score: row.score,
          candleTimestamp: row.candleTimestamp,
          createdAt: row.createdAt,
        };
        v8ScoresOnly[row.symbol] = row.score;
      }
    }

    const symbolsWithRow = SIGNAL_SYMBOLS.filter((sym) => sym in v8BySymbol);
    if (symbolsWithRow.length < SIGNAL_SYMBOLS.length && now < T + D - 60_000) {
      report.waiting.push({ hypothesis, barClose: T, reason: 'v8_incomplete' });
      continue;
    }

    const rv = await RvSignal.findOne({
      version: 'rv-v1',
      barCloseTime: { $lte: T },
    })
      .sort({ barCloseTime: -1 })
      .lean();

    const rvRanked = rv?.ranked ?? [];
    const rvBarTime = rv?.barTime ?? null;

    const { scores, skipped } = l2Scores(SIGNAL_SYMBOLS, v8ScoresOnly, rvRanked);
    const inputs = {
      rvBarTime,
      v8: v8BySymbol,
    };

    const w = d.clock();
    const late = w > T + D;
    const res = await insertLabSignalOnce({
      version: LAB_VERSION,
      hypothesis,
      candidate: 'L2',
      timeframe: tf,
      barClose: T,
      writtenAt: new Date(w),
      late,
      scores,
      skipped,
      inputs,
    });

    if (res.inserted) {
      report.written.push({ hypothesis, barClose: T, late });
    }
  }

  return report;
}
