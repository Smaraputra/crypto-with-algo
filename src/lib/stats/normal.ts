/**
 * Standard normal distribution helpers (mean 0, variance 1).
 */

const SQRT_2 = Math.SQRT2;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * Error function via its Maclaurin series, erf(x) = (2/sqrt(pi)) *
 * sum_{n=0}^inf (-1)^n x^(2n+1) / (n! (2n+1)), summed by updating each term
 * from the previous one (term_n = term_{n-1} * (-x^2/n) * (2n-1)/(2n+1)) to
 * avoid separately evaluating large powers and factorials. Converges to
 * double-precision accuracy for the |x| this module deals with (well under
 * 1e-7 absolute error, satisfying normalCdf's error bound), stopping once a
 * term no longer moves the running sum.
 */
function erf(x: number): number {
  if (x === 0) return 0;

  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const xSquared = ax * ax;

  let term = ax;
  let sum = term;
  const maxIterations = 300;
  for (let n = 1; n < maxIterations; n++) {
    term *= (-xSquared / n) * ((2 * n - 1) / (2 * n + 1));
    sum += term;
    if (Math.abs(term) < 1e-18 * Math.abs(sum)) break;
  }

  return sign * (2 / Math.sqrt(Math.PI)) * sum;
}

/** Cumulative distribution function of the standard normal distribution. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / SQRT_2));
}

/** Probability density function of the standard normal distribution. */
function normalPdf(x: number): number {
  return Math.exp((-x * x) / 2) / SQRT_2PI;
}

// Acklam's rational approximation coefficients for the inverse normal CDF.
const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239e0,
];
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
];
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0,
  4.374664141464968e0, 2.938163982698783e0,
];
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0,
];

const ACKLAM_P_LOW = 0.02425;
const ACKLAM_P_HIGH = 1 - ACKLAM_P_LOW;

/**
 * Inverse standard normal CDF (quantile function), via Acklam's rational
 * approximation with one Newton refinement step against normalCdf.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new Error('normalQuantile: p must be in (0, 1)');
  }

  let x: number;
  if (p < ACKLAM_P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q +
        ACKLAM_C[4]) *
        q +
        ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1);
  } else if (p <= ACKLAM_P_HIGH) {
    const q = p - 0.5;
    const r = q * q;
    x =
      (((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r +
        ACKLAM_A[4]) *
        r +
        ACKLAM_A[5]) *
      q /
      (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r +
        ACKLAM_B[4]) *
        r +
        1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(
      (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q +
        ACKLAM_C[4]) *
        q +
        ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1)
    );
  }

  // One Newton refinement step on f(x) = normalCdf(x) - p.
  x = x - (normalCdf(x) - p) / normalPdf(x);

  return x;
}

/** Sample skewness (third standardized moment, population-style, not bias-corrected). */
export function sampleSkewness(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;

  const mean = values.reduce((s, v) => s + v, 0) / n;
  const m2 = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  if (m2 === 0) return 0;
  const m3 = values.reduce((s, v) => s + (v - mean) ** 3, 0) / n;

  return m3 / Math.pow(m2, 1.5);
}

/**
 * Sample kurtosis: raw fourth standardized moment (not excess kurtosis).
 * A normal sample gives a value close to 3.
 */
export function sampleKurtosis(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;

  const mean = values.reduce((s, v) => s + v, 0) / n;
  const m2 = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  if (m2 === 0) return 0;
  const m4 = values.reduce((s, v) => s + (v - mean) ** 4, 0) / n;

  return m4 / (m2 * m2);
}
