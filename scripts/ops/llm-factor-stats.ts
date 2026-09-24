/**
 * Pure statistics for reading the LLM panel's live record, honest about the
 * two things that make a naive read of it misleading.
 *
 * No I/O here: plain arrays in, plain numbers out, so it is tested without
 * Mongo. The script that feeds it is llm-factor-readout.ts.
 *
 * WHY THIS EXISTS RATHER THAN JUST live-outcomes.ts. That script reports
 * per-tier expectancy, which is the right thing for a trading readout but
 * answers a different question, and it has no defence against either of these:
 *
 * 1. MARKET BETA. The panel scores ten correlated symbols at the same instant.
 *    Over the first resolved window every tier had a positive mean forward
 *    return -- including `sell` -- because the market rose about 3% over the
 *    horizon. A per-tier mean therefore mostly measures what the market did,
 *    not what the panel knew. Removing each bar's cross-sectional mean leaves
 *    only the part of the call that was about THIS symbol versus the others,
 *    which is the only part a ten-symbol panel can be credited with.
 *
 * 2. OVERLAPPING HORIZONS. A 1h call is scored against the next 24 bars, and
 *    calls are posted every two hours, so consecutive observations share ~22 of
 *    the 24 bars in their forward window. They are close to the same
 *    observation counted twelve times. A t-stat over the raw series is
 *    therefore inflated by roughly sqrt(horizon) -- the first read of this
 *    record looked like t = -2.76 on 15 bars, which corrected is barely one
 *    independent observation. `effectiveBars` and `independentWindows` below
 *    exist so that cannot be reported without the caveat attached.
 *
 * The HAC machinery in scripts/research/ic-stats.ts is the right correction for
 * a per-symbol time series. It is not reused for the pooled panel statistic
 * because the panel's bar count is currently smaller than its horizon, so a
 * Newey-West window at lag h-1 would span the entire sample. The honest answer
 * at this size is to report the independent-window count and refuse to dress a
 * t-stat up as significance; `verdict` does that.
 */

export interface PanelObservation {
  symbol: string;
  /** Bar open time; the cross-section key. */
  candleTimestamp: number;
  /** Signed conviction, `signedStrength(tier, strength)`. */
  score: number;
  /** Realised forward return over the call's horizon, long-perspective. */
  forwardReturnPercent: number;
}

export interface PanelIcStats {
  /** Observations kept: those in a bar with at least `minCrossSection` symbols. */
  n: number;
  /** Distinct bars contributing a cross-section. */
  bars: number;
  /**
   * Bars divided by the horizon: roughly how many non-overlapping forward
   * windows the record spans. This, not `bars`, is the sample size any claim
   * of significance has to live with.
   */
  independentWindows: number;
  /** Pooled IC after removing each bar's cross-sectional mean return. */
  demeanedIc: number;
  /** Pooled IC on raw returns, i.e. with market beta left in. Reported for contrast only. */
  rawIc: number;
  /** Mean of the per-bar cross-sectional ICs, and its spread across bars. */
  meanBarIc: number;
  sdBarIc: number;
  /** Share of bars whose cross-sectional IC is positive. */
  barsPositive: number;
  /**
   * Naive t of `meanBarIc`, DELIBERATELY paired with `inflationFactor`. Treating
   * this as significance is the error this module exists to prevent.
   */
  naiveT: number;
  /** Roughly how much `naiveT` overstates things: sqrt(bars / independentWindows). */
  inflationFactor: number;
  verdict: string;
}

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Pearson correlation. Returns NaN when either side has no variance. */
export function correlation(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const u = a[i] - ma;
    const v = b[i] - mb;
    num += u * v;
    da += u * u;
    db += v * v;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
}

/** Groups observations by bar, keeping only bars wide enough to have a cross-section. */
export function crossSections(
  observations: PanelObservation[],
  minCrossSection: number
): PanelObservation[][] {
  const byBar = new Map<number, PanelObservation[]>();
  for (const o of observations) {
    if (!Number.isFinite(o.score) || !Number.isFinite(o.forwardReturnPercent)) continue;
    const bucket = byBar.get(o.candleTimestamp);
    if (bucket) bucket.push(o);
    else byBar.set(o.candleTimestamp, [o]);
  }

  return [...byBar.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, group]) => group)
    .filter((group) => group.length >= minCrossSection);
}

/**
 * `horizonBars` is the call's horizon, used only to convert a bar count into an
 * independent-window count. `minCrossSection` is the narrowest cross-section
 * worth demeaning: below three symbols, removing the mean leaves almost no
 * signal and the IC is arithmetic noise.
 */
export function panelIcStats(
  observations: PanelObservation[],
  horizonBars: number,
  minCrossSection = 3
): PanelIcStats {
  const groups = crossSections(observations, minCrossSection);

  const scores: number[] = [];
  const demeaned: number[] = [];
  const raw: number[] = [];
  const barIcs: number[] = [];

  for (const group of groups) {
    const barMean = mean(group.map((o) => o.forwardReturnPercent));
    const gs = group.map((o) => o.score);
    const gd = group.map((o) => o.forwardReturnPercent - barMean);

    gs.forEach((s, i) => {
      scores.push(s);
      demeaned.push(gd[i]);
      raw.push(group[i].forwardReturnPercent);
    });

    const ic = correlation(gs, gd);
    if (Number.isFinite(ic)) barIcs.push(ic);
  }

  const bars = groups.length;
  const independentWindows = horizonBars > 0 ? bars / horizonBars : bars;
  const n = scores.length;

  const meanBarIc = barIcs.length > 0 ? mean(barIcs) : NaN;
  const sdBarIc =
    barIcs.length > 1
      ? Math.sqrt(barIcs.reduce((s, v) => s + (v - meanBarIc) ** 2, 0) / (barIcs.length - 1))
      : NaN;
  const naiveT =
    barIcs.length > 1 && sdBarIc > 0 ? meanBarIc / (sdBarIc / Math.sqrt(barIcs.length)) : NaN;
  const inflationFactor =
    independentWindows > 0 ? Math.sqrt(bars / independentWindows) : NaN;

  return {
    n,
    bars,
    independentWindows,
    demeanedIc: correlation(scores, demeaned),
    rawIc: correlation(scores, raw),
    meanBarIc,
    sdBarIc,
    barsPositive: barIcs.length > 0 ? barIcs.filter((v) => v > 0).length / barIcs.length : NaN,
    naiveT,
    inflationFactor,
    verdict: verdictFor(bars, independentWindows, barIcs.length),
  };
}

/**
 * States what the sample can and cannot support, so a striking IC cannot be
 * quoted without its sample size. The thresholds are deliberately blunt: the
 * point is to refuse a conclusion, not to grade one.
 */
export function verdictFor(bars: number, independentWindows: number, icBars: number): string {
  if (icBars < 3) {
    return 'too few cross-sections to compute an IC at all';
  }
  if (independentWindows < 2) {
    return `NOT READABLE: ${bars} bars span under 2 non-overlapping horizons, so this is ~1 independent observation however large n looks`;
  }
  if (independentWindows < 10) {
    return `DIRECTIONAL ONLY: ~${independentWindows.toFixed(1)} independent windows; a sign worth watching, not a result`;
  }
  if (independentWindows < 30) {
    return `WEAK: ~${independentWindows.toFixed(1)} independent windows; treat the t-stat as indicative at best`;
  }
  return `~${independentWindows.toFixed(1)} independent windows; the t-stat is worth reading`;
}
