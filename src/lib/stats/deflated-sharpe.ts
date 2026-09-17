/**
 * Deflated Sharpe ratio (Bailey and Lopez de Prado, "The Deflated Sharpe
 * Ratio: Correcting for Selection Bias, Backtest Overfitting and
 * Non-Normality", 2014). All Sharpe values in this module are per period
 * (e.g. per bar or per trade), not annualized; annualize at the call site
 * if needed.
 */

import { normalCdf, normalQuantile } from './normal';

const EULER_MASCHERONI = 0.5772156649;

/**
 * Expected value of the maximum Sharpe ratio observed across numTrials
 * independent trials, given the variance of Sharpe ratios across those
 * trials. varianceOfTrialSharpes is the sample variance of perPeriodSharpe()
 * computed once per trial across the trials of the optimization grid (i.e.
 * the spread of per-trial per-period Sharpe ratios) - per period, never
 * annualized, matching every other Sharpe value in this module. Returns 0
 * for a single trial (there is no selection effect). Throws RangeError if
 * varianceOfTrialSharpes is negative, since a variance cannot be negative.
 */
export function expectedMaxSharpe(numTrials: number, varianceOfTrialSharpes: number): number {
  if (varianceOfTrialSharpes < 0) {
    throw new RangeError('expectedMaxSharpe: varianceOfTrialSharpes must be >= 0');
  }
  if (numTrials <= 1) return 0;

  const gamma = EULER_MASCHERONI;
  const term1 = (1 - gamma) * normalQuantile(1 - 1 / numTrials);
  const term2 = gamma * normalQuantile(1 - 1 / (numTrials * Math.E));

  return Math.sqrt(varianceOfTrialSharpes) * (term1 + term2);
}

/**
 * Radicand of the probabilistic Sharpe ratio's standard error term:
 * 1 - skewness * observedSharpe + (kurtosis - 1) / 4 * observedSharpe^2.
 * Exposed so a caller (the validation gate) can detect and report the
 * degenerate case on its own: extreme skewness/kurtosis combined with the
 * observed Sharpe magnitude can drive this non-positive (e.g.
 * psrRadicand(0.3, 6, 10) is about -0.597), which puts the sample's moments
 * outside the formula's domain - Bailey and Lopez de Prado's derivation
 * assumes this term behaves like a variance. probabilisticSharpe returns
 * NaN in that case rather than a bare NaN from an unchecked sqrt of a
 * negative number, and this helper lets a caller explain why.
 */
export function psrRadicand(observedSharpe: number, skewness: number, kurtosis: number): number {
  return 1 - skewness * observedSharpe + ((kurtosis - 1) / 4) * observedSharpe ** 2;
}

/**
 * Probability that the true Sharpe ratio exceeds benchmarkSharpe, given an
 * observed Sharpe estimated over nObservations periods with the sample's
 * skewness and kurtosis (raw fourth moment, not excess). Returns NaN when
 * psrRadicand is non-positive - the moments are outside the formula's
 * domain (see psrRadicand's doc comment).
 */
export function probabilisticSharpe(
  observedSharpe: number,
  benchmarkSharpe: number,
  nObservations: number,
  skewness: number,
  kurtosis: number
): number {
  const radicand = psrRadicand(observedSharpe, skewness, kurtosis);
  if (radicand <= 0) return NaN;

  const numerator = (observedSharpe - benchmarkSharpe) * Math.sqrt(nObservations - 1);
  const denominator = Math.sqrt(radicand);

  return normalCdf(numerator / denominator);
}

/**
 * Deflated Sharpe ratio: the probabilistic Sharpe ratio evaluated against
 * the expected maximum Sharpe across numTrials, which corrects the
 * probability for having selected the best of many trials.
 */
export function deflatedSharpe(input: {
  observedSharpe: number;
  numTrials: number;
  varianceOfTrialSharpes: number;
  nObservations: number;
  skewness: number;
  kurtosis: number;
}): { benchmarkSharpe: number; probability: number } {
  const benchmarkSharpe = expectedMaxSharpe(input.numTrials, input.varianceOfTrialSharpes);
  const probability = probabilisticSharpe(
    input.observedSharpe,
    benchmarkSharpe,
    input.nObservations,
    input.skewness,
    input.kurtosis
  );

  return { benchmarkSharpe, probability };
}

/** Per-period Sharpe ratio: mean return over sample standard deviation, 0 when undefined. */
export function perPeriodSharpe(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return 0;

  return mean / stdev;
}
