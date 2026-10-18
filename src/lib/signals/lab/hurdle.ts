/**
 * Pure statistics for the forward signal lab hurdle calculations.
 * No I/O, no clock, no randomness.
 */

/** 5 bps taker fee plus 2 bps slippage, per unit of notional traded. */
export const LAB_COST_PER_SIDE = 0.0007;

/** Bars in the trailing mean of the cross-sectional return SD. */
export const LAB_S_WINDOW = 90;

/**
 * Sum over the union of symbols of |w - wPrev|, a symbol missing from one side
 * counting as weight 0. With no previous book (prev null) it is sum |w|, the
 * cost of entering from flat.
 */
export function bookTurnover(
  prev: Record<string, number> | null,
  next: Record<string, number>
): number {
  if (prev === null) {
    let sum = 0;
    for (const key of Object.keys(next)) {
      sum += Math.abs(next[key]);
    }
    return sum;
  }

  const symbols = new Set([...Object.keys(prev), ...Object.keys(next)]);
  let sum = 0;
  for (const sym of symbols) {
    const prevWeight = prev[sym] ?? 0;
    const nextWeight = next[sym] ?? 0;
    sum += Math.abs(nextWeight - prevWeight);
  }
  return sum;
}

/**
 * Mean of the last `window` values of `pastS` (all of them when fewer).
 * Null when `pastS` is empty. Non-finite entries are ignored, and returns
 * null when none is finite.
 */
export function trailingS(
  pastS: readonly number[],
  window: number = LAB_S_WINDOW
): number | null {
  if (pastS.length === 0) {
    return null;
  }
  const sliceStart = Math.max(0, pastS.length - window);
  const slice = pastS.slice(sliceStart);
  let sum = 0;
  let count = 0;
  for (const val of slice) {
    if (Number.isFinite(val)) {
      sum += val;
      count++;
    }
  }
  if (count === 0) {
    return null;
  }
  return sum / count;
}

/**
 * b_t = turnover x LAB_COST_PER_SIDE / (kN x sHat). Null when sHat is null or
 * not > 0, when kN is not finite or not > 0, or when turnover is not finite or
 * negative.
 */
export function hurdle(input: {
  turnover: number;
  kN: number;
  sHat: number | null;
}): number | null {
  const { turnover, kN, sHat } = input;
  if (sHat === null || !Number.isFinite(sHat) || sHat <= 0) {
    return null;
  }
  if (!Number.isFinite(kN) || kN <= 0) {
    return null;
  }
  if (!Number.isFinite(turnover) || turnover < 0) {
    return null;
  }
  return (turnover * LAB_COST_PER_SIDE) / (kN * sHat);
}
