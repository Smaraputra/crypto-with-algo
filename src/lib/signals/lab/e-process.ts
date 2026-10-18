/**
 * Any-time valid testing by betting for the forward signal lab (Shafer 2021, Waudby-Smith and Ramdas 2024).
 *
 * Mathematical guarantees:
 * 1. Factor lower bound: 1 + lambda * d >= 0.5 > 0 always holds.
 *    For any valid betting bar, x is in [-1, 1] and b >= 0, so d = x - b >= -1 - b = -(1 + b).
 *    Because lambda is capped at LAB_CAP_NUMERATOR / (1 + b) = 0.5 / (1 + b),
 *    the product lambda * d is lower-bounded by (0.5 / (1 + b)) * (-(1 + b)) = -0.5.
 *    Hence 1 + lambda * d >= 0.5 > 0, ensuring log1p is well-defined and wealth never drops to zero.
 *    Similarly, lambda0 * x >= 0.5 * (-1) = -0.5, so 1 + lambda0 * x >= 0.5 > 0.
 *
 * 2. Predictability:
 *    The bet fractions lambda and lambda0 for the current bar depend on the historical
 *    summary statistics (prev.n, prev.sumD, prev.sumD2, prev.sumX, prev.sumX2) accumulated
 *    from strictly earlier betting bars, and lambda's cap also depends on the current bar's b.
 *    That keeps the bet predictable because b is fixed before x can be observed (the lab's
 *    b uses only the scores at the bar close and earlier bars). The current bar's x never
 *    influences its own bet.
 *
 * 3. Finality of crossing under Ville's inequality:
 *    Under the null hypothesis H0: E[X_t - b_t | past] <= 0, the wealth process E_t is a
 *    non-negative supermartingale with E_0 = 1.
 *    By Ville's inequality, P(exists t >= 1: E_t >= LAB_THRESHOLD) <= 1 / LAB_THRESHOLD = alpha / K = 1 / 800.
 *    Because this uniform boundary holds across all time steps simultaneously, validation
 *    is permanent once crossedAt is recorded (it is sticky and cannot be undone).
 */

export const LAB_ALPHA = 0.01;
export const LAB_HYPOTHESES = 8;
/** e-Bonferroni: validated when E >= K / alpha. */
export const LAB_THRESHOLD = LAB_HYPOTHESES / LAB_ALPHA; // 800
export const LAB_WARMUP_BARS = 30;
export const LAB_VARIANCE_EPS = 1e-6;
export const LAB_CAP_NUMERATOR = 0.5;

export interface EProcessOptions {
  threshold?: number;
  lossUnbounded?: boolean;
}

export interface EProcessState {
  /** log E at the bar's hurdle b. */
  logE: number;
  /** log E of the same bets at b = 0 ("has predictive content"), reported only, never validates. */
  logE0: number;
  /** Betting bars seen so far (degenerate bars excluded). */
  n: number;
  sumD: number; // sum of (x - b) over betting bars
  sumD2: number; // sum of (x - b)^2
  sumX: number; // sum of x
  sumX2: number; // sum of x^2
  /** barTime of the first bar after which logE >= log(LAB_THRESHOLD), null before. Sticky. */
  crossedAt: number | null;
  /** True when state hit non-positive wealth under unbounded losses and ceased betting. */
  absorbed?: boolean;
}

export function initialEState(): EProcessState {
  return {
    logE: 0,
    logE0: 0,
    n: 0,
    sumD: 0,
    sumD2: 0,
    sumX: 0,
    sumX2: 0,
    crossedAt: null,
  };
}

export interface LabBar {
  barTime: number;
  /** X_t, or null when the bar is degenerate. */
  x: number | null;
  /** b_t, or null when it could not be computed. */
  b: number | null;
}

export interface LabStepResult {
  state: EProcessState;
  /** True when the bar placed a bet (x and b finite, x in [-1, 1], b >= 0). */
  bet: boolean;
  lambda: number; // 0 when no bet
  lambda0: number; // 0 when no bet
}

/** Bet size from past betting bars only. */
export function kellyLambda(
  n: number,
  sum: number,
  sum2: number,
  cap: number
): number {
  if (n < LAB_WARMUP_BARS) {
    return 0;
  }
  const m = sum / n;
  const v = Math.max(0, sum2 / n - m * m);
  const raw = m / (v + LAB_VARIANCE_EPS);
  if (!Number.isFinite(raw) || !Number.isFinite(cap)) {
    return 0;
  }
  return Math.min(Math.max(raw, 0), cap);
}

export function stepEProcess(
  prev: EProcessState,
  bar: LabBar,
  options?: EProcessOptions
): LabStepResult {
  if (prev.absorbed) {
    return {
      state: { ...prev },
      bet: false,
      lambda: 0,
      lambda0: 0,
    };
  }

  const { x, b, barTime } = bar;
  const lossUnbounded = options?.lossUnbounded ?? false;
  const isXValid =
    x !== null &&
    Number.isFinite(x) &&
    x <= 1 &&
    (lossUnbounded || x >= -1);
  const isBValid = b !== null && Number.isFinite(b) && b >= 0;

  if (!isXValid || !isBValid) {
    return {
      state: { ...prev },
      bet: false,
      lambda: 0,
      lambda0: 0,
    };
  }

  const d = x - b;
  const cap = LAB_CAP_NUMERATOR / (1 + b);
  const lambda = kellyLambda(prev.n, prev.sumD, prev.sumD2, cap);
  const lambda0 = kellyLambda(prev.n, prev.sumX, prev.sumX2, LAB_CAP_NUMERATOR);

  const factor = 1 + lambda * d;
  const factor0 = 1 + lambda0 * x;

  const becomesAbsorbed = lossUnbounded && factor <= 0;
  const logE = becomesAbsorbed ? -Infinity : prev.logE + Math.log1p(lambda * d);
  const logE0 =
    prev.logE0 === -Infinity || (lossUnbounded && factor0 <= 0)
      ? -Infinity
      : prev.logE0 + Math.log1p(lambda0 * x);

  const n = prev.n + 1;
  const sumD = prev.sumD + d;
  const sumD2 = prev.sumD2 + d * d;
  const sumX = prev.sumX + x;
  const sumX2 = prev.sumX2 + x * x;

  const threshold = options?.threshold ?? LAB_THRESHOLD;
  const thresholdLog = Math.log(threshold);
  const crossedAt =
    prev.crossedAt !== null
      ? prev.crossedAt
      : logE >= thresholdLog
      ? barTime
      : null;

  const nextState: EProcessState = {
    logE,
    logE0,
    n,
    sumD,
    sumD2,
    sumX,
    sumX2,
    crossedAt,
    ...(becomesAbsorbed ? { absorbed: true } : {}),
  };

  return {
    state: nextState,
    bet: true,
    lambda,
    lambda0,
  };
}

/** Folds stepEProcess over bars in the given order and returns every step. */
export function runEProcess(
  bars: readonly LabBar[],
  start?: EProcessState,
  options?: EProcessOptions
): LabStepResult[] {
  const results: LabStepResult[] = [];
  let currentState = start ? { ...start } : initialEState();
  for (const bar of bars) {
    const step = stepEProcess(currentState, bar, options);
    results.push(step);
    currentState = step.state;
  }
  return results;
}

export function isValidated(state: EProcessState): boolean {
  return state.crossedAt !== null;
}

export function eValue(state: EProcessState): number {
  if (state.absorbed) {
    return 0;
  }
  return Math.exp(state.logE);
}

export function eValue0(state: EProcessState): number {
  return Math.exp(state.logE0);
}
