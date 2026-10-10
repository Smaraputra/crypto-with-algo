import type { SignalTier } from '@/types/signal';

import { directionOf, outcomeOf } from './measures';
import { TRACK_BARS_CHUNK, type CallOutcome, type TrackBar, type TrackSource } from './types';

/**
 * Pure helpers that turn track-record bars into what the chart draws. Client
 * safe: no I/O, no models.
 */

/** Starts of the aligned chunks covering [from, to]; aligned so every viewer asks for the same ranges. */
export function chunkStarts(from: number, to: number, intervalMs: number): number[] {
  if (!(to >= from) || intervalMs <= 0) return [];
  const span = TRACK_BARS_CHUNK * intervalMs;
  const starts: number[] = [];
  for (let s = Math.floor(from / span) * span; s <= to; s += span) starts.push(s);
  return starts;
}

/** The inclusive range of the chunk starting at `start`: TRACK_BARS_CHUNK bars. */
export function chunkRange(start: number, intervalMs: number): { from: number; to: number } {
  return { from: start, to: start + TRACK_BARS_CHUNK * intervalMs - 1 };
}

/** A directional call as the price pane marks it. */
export interface CallMark {
  t: number;
  dir: 1 | -1;
  outcome: CallOutcome | 'pending';
  source: TrackSource;
  score: number;
  tier: SignalTier;
  fwd: number | null;
}

/** Buy and sell bars keyed by candle open time; neutral bars are not calls. */
export function callMarks(bars: Iterable<TrackBar>, costPercent: number): Map<number, CallMark> {
  const out = new Map<number, CallMark>();
  for (const bar of bars) {
    const dir = directionOf(bar.tier);
    if (dir === 0) continue;
    out.set(bar.t, {
      t: bar.t,
      dir,
      outcome: outcomeOf(bar.tier, bar.fwd, costPercent) ?? 'pending',
      source: bar.source,
      score: bar.score,
      tier: bar.tier,
      fwd: bar.fwd,
    });
  }
  return out;
}

export interface ViewTally {
  calls: number;
  /** Right direction: won plus cost. */
  right: number;
  won: number;
  cost: number;
  wrong: number;
  pending: number;
}

/** Counts of the calls whose bar opens inside [from, to]. */
export function viewTally(calls: ReadonlyMap<number, CallMark>, from: number, to: number): ViewTally {
  const tally: ViewTally = { calls: 0, right: 0, won: 0, cost: 0, wrong: 0, pending: 0 };
  for (const call of calls.values()) {
    if (call.t < from || call.t > to) continue;
    tally.calls++;
    tally[call.outcome]++;
  }
  tally.right = tally.won + tally.cost;
  return tally;
}
