import type { OHLCV } from '@/types/market';

/** Default half-window length for internal structure pivots (5 bars on each side). */
export const INTERNAL_LENGTH = 5;

/** Default half-window length for swing structure pivots (20 bars on each side). */
export const SWING_LENGTH = 20;

/** Swing pivot orientation: high or low. */
export type PivotKind = 'high' | 'low';

/** Swing label relative to the preceding pivot of the same kind. */
export type SwingLabel = 'HH' | 'LH' | 'HL' | 'LL';

/** Structural event classification: break-of-structure or change-of-character. */
export type StructureEventType = 'BOS' | 'CHoCH';

/** Directional bias of a market structure break. */
export type Direction = 'bull' | 'bear';

/** Current trend state: 1 for bullish, -1 for bearish, 0 for undefined/neutral. */
export type Trend = 1 | -1 | 0;

/** Confirmed swing pivot point. */
export interface Pivot {
  /** Pivot orientation ('high' or 'low'). */
  kind: PivotKind;
  /** Bar index of the pivot itself in the candle series. */
  index: number;
  /** Timestamp of the pivot candle (candles[index].timestamp). */
  timestamp: number;
  /** Price level (high for 'high', low for 'low'). */
  price: number;
  /** Confirmation bar index (index + length), the first bar where the pivot is known. */
  confirmedIndex: number;
  /** Swing label vs the previous pivot of the same kind; null for the initial pivot. */
  label: SwingLabel | null;
}

/** Market structure break event (BOS or CHoCH). */
export interface StructureEvent {
  /** Event classification: BOS (continuation) or CHoCH (reversal). */
  type: StructureEventType;
  /** Direction of the break: bull or bear. */
  direction: Direction;
  /** Broken pivot price level. */
  level: number;
  /** Bar index of the broken pivot. */
  pivotIndex: number;
  /** Bar index of the candle whose close confirmed the break. */
  breakIndex: number;
  /** Timestamp of the breaking candle. */
  breakTimestamp: number;
}

/** Complete market structure analysis output. */
export interface StructureResult {
  /** Half-window length used for pivot detection. */
  length: number;
  /** Confirmed pivots ordered by confirmedIndex (ties: highs before lows). */
  pivots: Pivot[];
  /** Structural break events ordered by breakIndex. */
  events: StructureEvent[];
  /** Market trend state after the final bar. */
  trend: Trend;
}

/**
 * Validates that pivot half-window length is an integer >= 1.
 *
 * @param length - Half-window length in bars.
 * @throws Error if length is non-integer or < 1.
 */
function validateLength(length: number): void {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error(`length must be an integer >= 1, got ${length}`);
  }
}

/**
 * Identifies confirmed swing pivots and assigns directional swing labels.
 *
 * @param candles - Array of closed candles sorted ascending by timestamp.
 * @param length - Number of bars required on each side of a pivot.
 * @returns Confirmed pivots in confirmedIndex order (ties: highs before lows).
 */
export function findPivots(candles: readonly OHLCV[], length: number): Pivot[] {
  validateLength(length);

  const highs: Pivot[] = [];
  const lows: Pivot[] = [];

  const lastPossibleIndex = candles.length - 1 - length;
  for (let i = length; i <= lastPossibleIndex; i++) {
    const bar = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - length; j <= i + length; j++) {
      if (j === i) {
        continue;
      }
      const other = candles[j];
      if (other.high >= bar.high) {
        isHigh = false;
      }
      if (other.low <= bar.low) {
        isLow = false;
      }
      if (!isHigh && !isLow) {
        break;
      }
    }

    if (isHigh) {
      const prevHigh = highs.length > 0 ? highs[highs.length - 1] : null;
      const label: SwingLabel | null = prevHigh
        ? bar.high > prevHigh.price ? 'HH' : 'LH'
        : null;
      highs.push({
        kind: 'high',
        index: i,
        timestamp: bar.timestamp,
        price: bar.high,
        confirmedIndex: i + length,
        label,
      });
    }

    if (isLow) {
      const prevLow = lows.length > 0 ? lows[lows.length - 1] : null;
      const label: SwingLabel | null = prevLow
        ? bar.low > prevLow.price ? 'HL' : 'LL'
        : null;
      lows.push({
        kind: 'low',
        index: i,
        timestamp: bar.timestamp,
        price: bar.low,
        confirmedIndex: i + length,
        label,
      });
    }
  }

  const pivots: Pivot[] = [];
  let h = 0;
  let l = 0;

  while (h < highs.length || l < lows.length) {
    if (h < highs.length && l < lows.length) {
      const high = highs[h];
      const low = lows[l];
      if (high.confirmedIndex < low.confirmedIndex) {
        pivots.push(high);
        h++;
      } else if (low.confirmedIndex < high.confirmedIndex) {
        pivots.push(low);
        l++;
      } else {
        // Ties: highs before lows
        pivots.push(high);
        pivots.push(low);
        h++;
        l++;
      }
    } else if (h < highs.length) {
      pivots.push(highs[h]);
      h++;
    } else {
      pivots.push(lows[l]);
      l++;
    }
  }

  return pivots;
}

/**
 * Deterministically analyzes market structure for confirmed pivots, break events, and trend.
 *
 * @param candles - Array of closed candles sorted ascending by timestamp.
 * @param length - Number of bars required on each side of a pivot.
 * @returns Structure analysis containing confirmed pivots, events, and final trend.
 */
export function analyzeStructure(candles: readonly OHLCV[], length: number): StructureResult {
  validateLength(length);

  const pivots = findPivots(candles, length);
  const events: StructureEvent[] = [];
  let trend: Trend = 0;

  let activeHigh: { pivot: Pivot; broken: boolean } | null = null;
  let activeLow: { pivot: Pivot; broken: boolean } | null = null;
  let pivotIdx = 0;

  for (let t = 0; t < candles.length; t++) {
    // 4a: Pivots confirmed at bar t become active (highs processed before lows)
    while (pivotIdx < pivots.length && pivots[pivotIdx].confirmedIndex === t) {
      const p = pivots[pivotIdx];
      if (p.kind === 'high') {
        activeHigh = { pivot: p, broken: false };
      } else {
        activeLow = { pivot: p, broken: false };
      }
      pivotIdx++;
    }

    const candle = candles[t];

    // 4b: Check for bullish break of active high
    if (activeHigh !== null && !activeHigh.broken && candle.close > activeHigh.pivot.price) {
      events.push({
        type: trend === -1 ? 'CHoCH' : 'BOS',
        direction: 'bull',
        level: activeHigh.pivot.price,
        pivotIndex: activeHigh.pivot.index,
        breakIndex: t,
        breakTimestamp: candle.timestamp,
      });
      trend = 1;
      activeHigh.broken = true;
    } else if (activeLow !== null && !activeLow.broken && candle.close < activeLow.pivot.price) {
      // 4c: Check for bearish break of active low (only if 4b did not trigger)
      events.push({
        type: trend === 1 ? 'CHoCH' : 'BOS',
        direction: 'bear',
        level: activeLow.pivot.price,
        pivotIndex: activeLow.pivot.index,
        breakIndex: t,
        breakTimestamp: candle.timestamp,
      });
      trend = -1;
      activeLow.broken = true;
    }
  }

  return {
    length,
    pivots,
    events,
    trend,
  };
}
