import { barDelta, deltaDivergences, DIVERGENCE_MAX_BARS } from '@/lib/market/delta';
import { analyzeStructure, findPivots, SWING_LENGTH } from '@/lib/market/structure';
import type { OHLCV } from '@/types/market';

/** Closed 1h bars the live job analyses: structure state is built over this window only. */
export const LAB_V4_WINDOW_BARS = 720;
export const LAB_V4_HOLD_BARS = 8;
export const HOUR_MS = 3_600_000;

export type Side = 1 | -1 | 0;

/** S1 (Round 3 C1): +1 or -1 when the LAST bar of `closed` is the break bar of a swing CHoCH (SWING_LENGTH, close-break)
 *  whose barDelta has the same sign as the event direction; else 0.
 *  Produces the same signal as the preview's c1Signals, apart from the window start: structure state is built from the window's first bar. */
export function s1SideAtLast(closed: readonly OHLCV[]): Side {
  if (closed.length === 0) {
    return 0;
  }
  const lastIdx = closed.length - 1;
  const lastBar = closed[lastIdx];
  const delta = barDelta(lastBar);
  if (delta === null || delta === 0) {
    return 0;
  }

  const structure = analyzeStructure(closed, SWING_LENGTH);
  for (const event of structure.events) {
    if (event.type === 'CHoCH' && event.breakIndex === lastIdx) {
      if (event.direction === 'bull' && delta > 0) {
        return 1;
      }
      if (event.direction === 'bear' && delta < 0) {
        return -1;
      }
      return 0;
    }
  }

  return 0;
}

/** S2 (Round 3 C2): -1 for a regular bear divergence and +1 for a regular bull divergence (deltaDivergences over
 *  findPivots(closed, SWING_LENGTH), DIVERGENCE_MAX_BARS) whose confirmedIndex is the LAST bar of `closed`; else 0.
 *  When both a regular bear and a regular bull divergence confirm at the last bar, return -1 (bear).
 *  Produces the same signal as the preview's c2Signals, apart from the window start: structure state is built from the window's first bar. */
export function s2SideAtLast(closed: readonly OHLCV[]): Side {
  if (closed.length === 0) {
    return 0;
  }
  const lastIdx = closed.length - 1;
  const pivots = findPivots(closed, SWING_LENGTH);
  const divergences = deltaDivergences(closed, pivots, DIVERGENCE_MAX_BARS);

  let hasBull = false;
  let hasBear = false;

  for (const div of divergences) {
    if (div.kind !== 'regular' || div.confirmedIndex !== lastIdx) {
      continue;
    }
    if (div.direction === 'bull') {
      hasBull = true;
    } else if (div.direction === 'bear') {
      hasBear = true;
    }
  }

  if (hasBear) {
    return -1;
  }
  if (hasBull) {
    return 1;
  }
  return 0;
}

/** True when `closed` is non-empty, strictly ascending, every gap is exactly HOUR_MS, and the last bar opens at lastOpen. */
export function isContiguousHourly(closed: readonly OHLCV[], lastOpen: number): boolean {
  if (closed.length === 0) {
    return false;
  }
  if (closed[closed.length - 1].timestamp !== lastOpen) {
    return false;
  }
  for (let i = 1; i < closed.length; i++) {
    if (closed[i].timestamp - closed[i - 1].timestamp !== HOUR_MS) {
      return false;
    }
  }
  return true;
}
