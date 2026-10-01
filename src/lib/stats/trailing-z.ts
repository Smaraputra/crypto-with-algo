/**
 * Trailing z-scores shared by the research columns and the live scorer.
 *
 * `trailingZScore` moved here from scripts/research/factors.ts on 2026-10-01
 * (scorer configVersion 8) unchanged, and factors.ts re-exports it, so every
 * research column built on it is byte-identical. `trailingZByTime` is its
 * time-windowed twin for an irregular series, such as stored 1h snapshots with
 * missed ingest ticks, where a window counted in rows would silently stretch
 * across a gap.
 */

/**
 * Trailing z-score of a series, over a window of `windowBars` bars.
 *
 * Running sums, so the cost is one pass regardless of window size: at 5m a
 * thirty-day window is 8,640 bars and a naive recompute per bar would be
 * quadratic over the 800,000-bar dataset.
 *
 * NaN entries take part in neither the mean nor the count, so a gap in the
 * input thins the window instead of poisoning it, and a bar whose own value
 * is NaN stays NaN. A window with no spread returns NaN rather than 0: a
 * constant funding rate has no z-score, and reporting 0 would read as
 * "exactly average" on what is really "no information".
 */
export function trailingZScore(series: Float64Array, windowBars: number, minSamples: number): Float64Array {
  const n = series.length;
  const out = new Float64Array(n).fill(NaN);
  let count = 0;
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < n; i++) {
    const entering = series[i];
    if (Number.isFinite(entering)) {
      count++;
      sum += entering;
      sumSq += entering * entering;
    }

    const leavingIndex = i - windowBars;
    if (leavingIndex >= 0) {
      const leaving = series[leavingIndex];
      if (Number.isFinite(leaving)) {
        count--;
        sum -= leaving;
        sumSq -= leaving * leaving;
      }
    }

    const value = series[i];
    if (!Number.isFinite(value) || count < minSamples) continue;

    const mean = sum / count;
    const meanSq = mean * mean;
    // Sample variance, matching realizedVol20's ddof of 1.
    const variance = (sumSq - count * meanSq) / (count - 1);

    // sumSq and count*meanSq are nearly equal for a near-constant series, so
    // their difference is pure cancellation noise there: a constant funding
    // rate would otherwise get a standard deviation around 1e-12 and a z-score
    // of arbitrary size. Anything at or below the scale of that noise counts as
    // no spread, which is NaN rather than 0: a series that never moves has no
    // z-score, and 0 would read as "exactly average".
    const epsilon = 1e-12 * Math.max(sumSq / count, meanSq, Number.MIN_VALUE);
    if (variance <= epsilon) continue;

    out[i] = (value - mean) / Math.sqrt(variance);
  }

  return out;
}

/** A reading on an irregular time grid. `value` may be non-finite (a gap). */
export interface TimedValue {
  t: number;
  value: number;
}

/**
 * Trailing z-score over a TIME window: for each row, the rows with
 * `t` in `(row.t - windowMs, row.t]`, the row itself included, exactly as
 * `trailingZScore` includes the current bar. Rows must be sorted by `t`
 * ascending. Non-finite values take part in neither the mean nor the count,
 * fewer than `minSamples` finite values gives NaN, and a window with no spread
 * gives NaN, with the same cancellation guard as `trailingZScore`.
 *
 * On a gapless grid with `windowMs = windowBars * step` the result equals
 * `trailingZScore(values, windowBars, minSamples)` (`trailing-z.test.ts`).
 */
export function trailingZByTime(rows: readonly TimedValue[], windowMs: number, minSamples: number): Float64Array {
  const n = rows.length;
  const out = new Float64Array(n).fill(NaN);
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let left = 0;

  for (let i = 0; i < n; i++) {
    const entering = rows[i].value;
    if (Number.isFinite(entering)) {
      count++;
      sum += entering;
      sumSq += entering * entering;
    }
    // Drop rows that fell out of (t - windowMs, t].
    while (left <= i && rows[left].t <= rows[i].t - windowMs) {
      const leaving = rows[left].value;
      if (Number.isFinite(leaving)) {
        count--;
        sum -= leaving;
        sumSq -= leaving * leaving;
      }
      left++;
    }

    const value = rows[i].value;
    if (!Number.isFinite(value) || count < minSamples) continue;

    const mean = sum / count;
    const meanSq = mean * mean;
    const variance = (sumSq - count * meanSq) / (count - 1);
    const epsilon = 1e-12 * Math.max(sumSq / count, meanSq, Number.MIN_VALUE);
    if (variance <= epsilon) continue;

    out[i] = (value - mean) / Math.sqrt(variance);
  }

  return out;
}
