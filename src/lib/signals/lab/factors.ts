/**
 * Frozen candidate factor score functions for the forward signal lab (lab-v1).
 *
 * Look-ahead rules:
 * - L3 realised variance uses closed 1h bars only, rejecting any forming bar with closeTime >= T.
 * - L4 positioning z-score uses points stamped at or before T only.
 *
 * Every function here is pure and frozen as part of lab-v1. Any logic changes require a new version.
 */

import { L3_BARS, L4_PERIOD_MS, L4_POINTS } from './candidates';

export type LabSkipReason =
  | 'rv_skipped'          // L1, L2: the rv-v1 signal has no rank for the symbol
  | 'v8_missing'          // L2: no finite v8 score for the symbol at this bar
  | 'bars_incomplete'     // L3: fewer than L3_BARS bars, or the last bar is not the one closing at T, or a close is not finite and > 0
  | 'bars_not_contiguous' // L3: consecutive bars are not exactly 1h apart
  | 'forming_bar'         // L3: a bar closes at or after T (look-ahead guard)
  | 'ratio_incomplete'    // L4: fewer than L4_POINTS points, a non-finite or non-positive ratio, or points not exactly L4_PERIOD_MS apart
  | 'ratio_stale'         // L4: the latest point stamped at or before T is older than T - L4_PERIOD_MS
  | 'ratio_no_spread';    // L4: the window's sample SD is 0 or not finite

export interface LabScores {
  /** Higher = more long. Only symbols that were scored. */
  scores: Record<string, number>;
  skipped: { symbol: string; reason: LabSkipReason }[];
}

// ------------------------------------------------------------------ L1, rv-v1 composite

export function l1Scores(
  symbols: readonly string[],
  rvRanked: readonly { symbol: string; compositeZ: number; rank: number }[]
): LabScores {
  const rvMap = new Map<string, { symbol: string; compositeZ: number; rank: number }>();
  for (const item of rvRanked) {
    rvMap.set(item.symbol, item);
  }

  const scores: Record<string, number> = {};
  const skipped: { symbol: string; reason: LabSkipReason }[] = [];

  for (const symbol of symbols) {
    const entry = rvMap.get(symbol);
    if (!entry || !Number.isFinite(entry.compositeZ)) {
      skipped.push({ symbol, reason: 'rv_skipped' });
    } else {
      scores[symbol] = entry.compositeZ;
    }
  }

  return { scores, skipped };
}

// ------------------------------------------------------------------ L2, combined v8 and rv

/** 100 x (5.5 - rank) / 4.5: rank 1 maps to +100, rank 10 to -100. */
export function rvRankComponent(rank: number): number {
  return (100 * (5.5 - rank)) / 4.5;
}

export const L2_WEIGHTS = { v8: 0.5, rv: 0.5 } as const;

export function l2Scores(
  symbols: readonly string[],
  v8Scores: Readonly<Record<string, number | null | undefined>>,
  rvRanked: readonly { symbol: string; compositeZ: number; rank: number }[]
): LabScores {
  const rvMap = new Map<string, { symbol: string; compositeZ: number; rank: number }>();
  for (const item of rvRanked) {
    rvMap.set(item.symbol, item);
  }

  const scores: Record<string, number> = {};
  const skipped: { symbol: string; reason: LabSkipReason }[] = [];

  for (const symbol of symbols) {
    const rvEntry = rvMap.get(symbol);
    if (!rvEntry || !Number.isFinite(rvEntry.rank)) {
      skipped.push({ symbol, reason: 'rv_skipped' });
      continue;
    }

    const v8 = v8Scores[symbol];
    if (v8 === undefined || v8 === null || !Number.isFinite(v8)) {
      skipped.push({ symbol, reason: 'v8_missing' });
      continue;
    }

    scores[symbol] = L2_WEIGHTS.v8 * v8 + L2_WEIGHTS.rv * rvRankComponent(rvEntry.rank);
  }

  return { scores, skipped };
}

// ------------------------------------------------------------------ L3, variance fade

export interface HourBar {
  openTime: number;
  closeTime: number;
  close: number;
}

export function realisedVariance168(
  bars: readonly HourBar[],
  barClose: number
): number | LabSkipReason {
  for (const bar of bars) {
    if (bar.closeTime >= barClose) {
      return 'forming_bar';
    }
  }

  if (bars.length < L3_BARS) {
    return 'bars_incomplete';
  }

  const sorted = [...bars].sort((a, b) => a.openTime - b.openTime);
  const window = sorted.slice(-L3_BARS);

  const lastBar = window[window.length - 1];
  if (lastBar.openTime !== barClose - 3_600_000) {
    return 'bars_incomplete';
  }

  for (const bar of window) {
    if (!Number.isFinite(bar.close) || bar.close <= 0) {
      return 'bars_incomplete';
    }
  }

  for (let i = 1; i < window.length; i++) {
    if (window[i].openTime - window[i - 1].openTime !== 3_600_000) {
      return 'bars_not_contiguous';
    }
  }

  let variance = 0;
  for (let k = 1; k < window.length; k++) {
    const r = Math.log(window[k].close / window[k - 1].close);
    variance += r * r;
  }

  return variance;
}

export function l3Scores(
  symbols: readonly string[],
  barsBySymbol: Readonly<Record<string, readonly HourBar[] | undefined>>,
  barClose: number
): LabScores {
  const scores: Record<string, number> = {};
  const skipped: { symbol: string; reason: LabSkipReason }[] = [];

  for (const symbol of symbols) {
    const bars = barsBySymbol[symbol];
    if (!bars) {
      skipped.push({ symbol, reason: 'bars_incomplete' });
      continue;
    }

    const res = realisedVariance168(bars, barClose);
    if (typeof res === 'string') {
      skipped.push({ symbol, reason: res });
    } else {
      scores[symbol] = -res;
    }
  }

  return { scores, skipped };
}

// ------------------------------------------------------------------ L4, positioning fade

export interface RatioPoint {
  timestamp: number;
  longShortRatio: number;
}

export interface L4Input {
  z: number;
  latestTimestamp: number;
}

export function positioningZ(
  points: readonly RatioPoint[],
  barClose: number
): L4Input | LabSkipReason {
  const pointMap = new Map<number, RatioPoint>();
  for (const p of points) {
    if (p.timestamp <= barClose) {
      pointMap.set(p.timestamp, p);
    }
  }

  const kept = Array.from(pointMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  if (kept.length === 0) {
    return 'ratio_stale';
  }

  const latestKept = kept[kept.length - 1];
  if (latestKept.timestamp < barClose - L4_PERIOD_MS) {
    return 'ratio_stale';
  }

  if (kept.length < L4_POINTS) {
    return 'ratio_incomplete';
  }

  const window = kept.slice(-L4_POINTS);

  for (const p of window) {
    if (!Number.isFinite(p.longShortRatio) || p.longShortRatio <= 0) {
      return 'ratio_incomplete';
    }
  }

  for (let i = 1; i < window.length; i++) {
    if (window[i].timestamp - window[i - 1].timestamp !== L4_PERIOD_MS) {
      return 'ratio_incomplete';
    }
  }

  const n = window.length;
  let sum = 0;
  for (const p of window) {
    sum += p.longShortRatio;
  }
  const mean = sum / n;

  let sumSqDiff = 0;
  for (const p of window) {
    const diff = p.longShortRatio - mean;
    sumSqDiff += diff * diff;
  }

  const sd = Math.sqrt(sumSqDiff / (n - 1));
  if (!Number.isFinite(sd) || sd === 0) {
    return 'ratio_no_spread';
  }

  const latest = window[window.length - 1];
  const z = (latest.longShortRatio - mean) / sd;

  return {
    z,
    latestTimestamp: latest.timestamp,
  };
}

export function l4Scores(
  symbols: readonly string[],
  pointsBySymbol: Readonly<Record<string, readonly RatioPoint[] | undefined>>,
  barClose: number
): { result: LabScores; inputs: Record<string, L4Input> } {
  const scores: Record<string, number> = {};
  const skipped: { symbol: string; reason: LabSkipReason }[] = [];
  const inputs: Record<string, L4Input> = {};

  for (const symbol of symbols) {
    const points = pointsBySymbol[symbol];
    if (!points) {
      skipped.push({ symbol, reason: 'ratio_stale' });
      continue;
    }

    const res = positioningZ(points, barClose);
    if (typeof res === 'string') {
      skipped.push({ symbol, reason: res });
    } else {
      scores[symbol] = -res.z;
      inputs[symbol] = res;
    }
  }

  return {
    result: { scores, skipped },
    inputs,
  };
}
