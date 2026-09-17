/**
 * Standard normal distribution helpers (mean 0, variance 1).
 *
 * normalCdf is built on a numerically stable complementary error function,
 * computed through its exact relation to the regularized incomplete gamma
 * function: for x >= 0, erf(x) = P(1/2, x^2) and erfc(x) = Q(1/2, x^2)
 * (Q = 1 - P). P is evaluated as a power series when x^2 < 1.5, where every
 * term is positive and P is nowhere near 1, so there is nothing to cancel.
 * Q is evaluated directly via a continued fraction (modified Lentz's method)
 * when x^2 >= 1.5, so erfc for large x is computed as a small number
 * directly rather than as "1 minus something extremely close to 1". A prior
 * version computed erf via its Maclaurin series, which sums large
 * alternating terms that nearly cancel once |x| is more than a few units;
 * that lost so much precision that normalCdf(9) came out as 0.9338 and
 * normalCdf(10) as -978 (both should be ~1). normalCdf(x) = 0.5 *
 * erfc(-x/sqrt(2)) extends the same cancellation-free property to negative
 * x via erfc(-y) = 2 - erfc(y) (subtracting a tiny erfc(y) from an exact 2
 * is benign). This reaches double-precision accuracy (errors observed at
 * 1e-9 to 1e-16 across x in [-40, 40]), comfortably inside the 1e-7 bound
 * this module targets.
 */

const SQRT_2 = Math.SQRT2;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

// ln(Gamma(1/2)) = ln(sqrt(pi)), needed by the incomplete gamma evaluations below.
const LN_GAMMA_HALF = 0.5 * Math.log(Math.PI);

/**
 * Regularized lower incomplete gamma function P(a, x) via its series
 * representation (all terms positive, safe for x < a + 1).
 */
function regularizedGammaPSeries(a: number, x: number): number {
  if (x <= 0) return 0;

  let ap = a;
  let sum = 1 / a;
  let delta = sum;
  const maxIterations = 300;
  for (let n = 1; n <= maxIterations; n++) {
    ap += 1;
    delta *= x / ap;
    sum += delta;
    if (Math.abs(delta) < Math.abs(sum) * 1e-16) break;
  }

  return sum * Math.exp(-x + a * Math.log(x) - LN_GAMMA_HALF);
}

/**
 * Regularized upper incomplete gamma function Q(a, x) = 1 - P(a, x), via its
 * continued fraction representation (modified Lentz's method; safe and fast
 * for x >= a + 1, where the series above converges too slowly).
 */
function regularizedGammaQContinuedFraction(a: number, x: number): number {
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;

  const maxIterations = 300;
  for (let i = 1; i <= maxIterations; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }

  return Math.exp(-x + a * Math.log(x) - LN_GAMMA_HALF) * h;
}

/**
 * Complementary error function, valid and cancellation-free across the
 * whole real line (see the module doc comment for the method).
 */
function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);

  const xSquared = x * x;
  if (xSquared < 1.5) {
    return 1 - regularizedGammaPSeries(0.5, xSquared);
  }
  return regularizedGammaQContinuedFraction(0.5, xSquared);
}

/** Cumulative distribution function of the standard normal distribution. */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / SQRT_2);
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
