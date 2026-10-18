import type { TradingStyle } from '@/lib/models/signal-template';

export type LabVersion = 'lab-v1' | 'lab-v2';
export const LAB_VERSION = 'lab-v1' as const;
export const LAB_VERSION_V2 = 'lab-v2' as const;

/** Four slots at alpha 0.01 / 4. */
export const LAB_V2_THRESHOLD = 400;

export type LabCandidateId = 'L1' | 'L2' | 'L3' | 'L4' | 'N2' | 'N3';
export type LabTimeframe = '5m' | '15m' | '1h' | '4h' | '8h' | '1d';
export type LabTimeframeAny = LabTimeframe | '1w';

export const LAB_TIMEFRAME_MS: Record<LabTimeframeAny, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '4h': 4 * 3_600_000,
  '8h': 8 * 3_600_000,
  '1d': 86_400_000,
  '1w': 7 * 86_400_000,
};

/** Fixed execution delay D between bar close T and the start of the graded return window. */
export function labDelayMs(tf: LabTimeframeAny): number {
  return tf === '5m' ? 5 * 60_000 : 10 * 60_000;
}

/** Minimum coins with both a score and a return for a bar to place a bet. */
export const LAB_MIN_CROSS_SECTION = 8;

export interface LabHypothesis {
  /** `${candidate}-${timeframe}`, e.g. 'L2-15m'. */
  id: string;
  candidate: LabCandidateId;
  timeframe: LabTimeframeAny;
  version: LabVersion;
  metric?: 'ic' | 'book';
  scale?: number;
}

/** The 8 hypotheses of lab-v1, frozen. Order is part of the record. */
export const LAB_HYPOTHESES_V1: readonly LabHypothesis[] = Object.freeze([
  Object.freeze({ id: 'L1-8h', candidate: 'L1', timeframe: '8h', version: LAB_VERSION }),
  Object.freeze({ id: 'L2-5m', candidate: 'L2', timeframe: '5m', version: LAB_VERSION }),
  Object.freeze({ id: 'L2-15m', candidate: 'L2', timeframe: '15m', version: LAB_VERSION }),
  Object.freeze({ id: 'L2-1h', candidate: 'L2', timeframe: '1h', version: LAB_VERSION }),
  Object.freeze({ id: 'L2-4h', candidate: 'L2', timeframe: '4h', version: LAB_VERSION }),
  Object.freeze({ id: 'L2-1d', candidate: 'L2', timeframe: '1d', version: LAB_VERSION }),
  Object.freeze({ id: 'L3-8h', candidate: 'L3', timeframe: '8h', version: LAB_VERSION }),
  Object.freeze({ id: 'L4-8h', candidate: 'L4', timeframe: '8h', version: LAB_VERSION }),
]);

/** v8 GlobalSignal source per L2 timeframe, frozen. */
export const L2_V8_STYLE: Record<'5m' | '15m' | '1h' | '4h' | '1d', TradingStyle> = Object.freeze({
  '5m': 'scalping',
  '15m': 'day_trading',
  '1h': 'day_trading',
  '4h': 'swing_trading',
  '1d': 'swing_trading',
});

/** L2 reads v8 GlobalSignal rows of this configVersion only, so a later scorer can never enter lab-v1. */
export const L2_V8_CONFIG_VERSION = 8;

/** L3: 1h bars in the variance window (168 log returns need 169 closes). */
export const L3_BARS = 169;
/** L4: top-trader position ratio period and window (30 days of 4h points). */
export const L4_PERIOD = '4h' as const;
export const L4_PERIOD_MS = 4 * 3_600_000;
export const L4_POINTS = 180;
/** L4 reads the ratio point stamped exactly T - L4_LAG_MS as its latest, the newest one always published by T. */
export const L4_LAG_MS = L4_PERIOD_MS;
