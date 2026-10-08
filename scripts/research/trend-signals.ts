/**
 * Legends phase: the pre-registered trend rules as pure functions of daily closes.
 * The rules, parameters and gates are fixed in the header of trend-sim.ts; this
 * module only computes them.
 *
 * Every rule is split the same way so the timing null can move one part and
 * keep the other aligned:
 *   - `signal` is the pre-sizing path s_i (a score, a sign blend, an in/out
 *     state), decided at the close of day i from closes up to and including i;
 *   - `size` is the volatility sizing z_i, aligned to the true dates;
 *   - the target exposure decided at close i is s_i x z_i (0 when either is not
 *     yet defined, so a horizon or a volatility estimate without enough history
 *     holds nothing).
 * `decide(i)` says whether close i is a decision day, and `rebalance` what a
 * decision day trades:
 *   - 'on-decision' (TF1, TF2): to the target, signal and size, every time;
 *   - 'on-signal-change' (TF3, C3): only when the signal changes ("trade only
 *     when the state changes"), so the held quantity drifts in between;
 *   - 'band' (TF4): a signal change trades at once, a volatility-only change
 *     only when |target - current| / current exceeds the band.
 */

export const DAY_MS = 86_400_000;
export const YEAR_DAYS = 365;
const SQRT_YEAR = Math.sqrt(YEAR_DAYS);

export type TrendRuleId = 'TF1' | 'TF2' | 'TF3' | 'TF4' | 'C3';
export const TREND_RULE_IDS: readonly TrendRuleId[] = ['TF1', 'TF2', 'TF3', 'TF4', 'C3'];

export type Rebalance = { kind: 'on-decision' } | { kind: 'on-signal-change' } | { kind: 'band'; band: number };

export interface RulePaths {
  signal: Float64Array;
  size: Float64Array;
  /** Whether the close of day i is a decision day. */
  decide: (i: number) => boolean;
  rebalance: Rebalance;
  /**
   * Broad phase only (broad-trend.ts): 1 where the rule's signal AND size are
   * both defined. Absent on the legends builders' paths.
   */
  defined?: Uint8Array;
}

/** Daily simple returns; r[i] is close i over close i-1, NaN at 0. */
export function dailyReturns(c: ArrayLike<number>): Float64Array {
  const r = new Float64Array(c.length).fill(Number.NaN);
  for (let i = 1; i < c.length; i++) r[i] = c[i] / c[i - 1] - 1;
  return r;
}

/** Sum over lookbacks of sign(c_i / c_{i-L} - 1); a lookback contributes 0 until it has L days. */
export function signSum(c: ArrayLike<number>, lookbacks: readonly number[]): Float64Array {
  const out = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) {
    let s = 0;
    for (const L of lookbacks) {
      if (i - L < 0) continue;
      s += Math.sign(c[i] / c[i - L] - 1);
    }
    out[i] = s;
  }
  return out;
}

/** TF1's volatility: mean absolute daily return over the last `window` returns, times sqrt(365). */
export function meanAbsVol(c: ArrayLike<number>, window = 30): Float64Array {
  const r = dailyReturns(c);
  const out = new Float64Array(c.length).fill(Number.NaN);
  for (let i = window; i < c.length; i++) {
    let s = 0;
    for (let k = i - window + 1; k <= i; k++) s += Math.abs(r[k]);
    out[i] = (s / window) * SQRT_YEAR;
  }
  return out;
}

/** TF4's volatility: sample standard deviation of the last `window` daily returns, times sqrt(365). */
export function stdVol(c: ArrayLike<number>, window = 90): Float64Array {
  const r = dailyReturns(c);
  const out = new Float64Array(c.length).fill(Number.NaN);
  for (let i = window; i < c.length; i++) {
    let m = 0;
    for (let k = i - window + 1; k <= i; k++) m += r[k];
    m /= window;
    let v = 0;
    for (let k = i - window + 1; k <= i; k++) v += (r[k] - m) ** 2;
    out[i] = Math.sqrt(v / (window - 1)) * SQRT_YEAR;
  }
  return out;
}

/**
 * TF2's volatility as pre-registered: an EWMA of SQUARED daily returns (not
 * demeaned, unlike Moskowitz, Ooi and Pedersen's estimator; the difference is
 * the squared mean, well under 1% of the variance at crypto's daily scale),
 * centre of mass `com` days (delta = com / (com + 1)), annualised by 365.
 * Seeded with the mean square of the first `com` returns and defined from then on.
 */
export function ewmaVol(c: ArrayLike<number>, com = 60): Float64Array {
  const r = dailyReturns(c);
  const out = new Float64Array(c.length).fill(Number.NaN);
  const delta = com / (com + 1);
  if (c.length <= com) return out;
  let meanSquare = 0;
  for (let k = 1; k <= com; k++) meanSquare += r[k] ** 2;
  meanSquare /= com;
  out[com] = Math.sqrt(meanSquare * YEAR_DAYS);
  for (let i = com + 1; i < c.length; i++) {
    meanSquare = delta * meanSquare + (1 - delta) * r[i] ** 2;
    out[i] = Math.sqrt(meanSquare * YEAR_DAYS);
  }
  return out;
}

/** Simple moving average of the last n closes including i; NaN before n closes exist. */
export function sma(c: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(c.length).fill(Number.NaN);
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    s += c[i];
    if (i >= n) s -= c[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/**
 * Zarattini, Pagani and Barbon's long-only Donchian model for one lookback n, on
 * closes. Up and Down are the max and min close over n days including i, Mid
 * their average. Flat and close >= Up: enter, stop = Mid. Long: exit when close
 * <= stop, else stop = max(stop, Mid). Returns the in/out state decided at each
 * close; 0 until n closes exist.
 */
export function donchianState(c: ArrayLike<number>, n: number): Uint8Array {
  const state = new Uint8Array(c.length);
  let held = false;
  let stop = Number.NaN;
  for (let i = n - 1; i < c.length; i++) {
    let up = -Infinity;
    let down = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (c[k] > up) up = c[k];
      if (c[k] < down) down = c[k];
    }
    const mid = 0.5 * (up + down);
    if (held) {
      if (c[i] <= stop) {
        held = false;
        stop = Number.NaN;
      } else {
        stop = Math.max(stop, mid);
      }
    } else if (c[i] >= up) {
      held = true;
      stop = mid;
    }
    state[i] = held ? 1 : 0;
  }
  return state;
}

export const TF4_LOOKBACKS = [5, 10, 20, 30, 60, 90, 150, 250, 360] as const;
/** TF4's relative band for a volatility-only resize (Zarattini, Pagani, Barbon, Section 5.1). */
export const TF4_BAND = 0.2;
export const TF1_LOOKBACKS = [7, 14, 30, 60] as const;
export const TF2_LOOKBACKS = [30, 91, 365] as const;

/** The close of day i is at t_i + 1 day; these name the UTC date of that close. */
function closeDate(t: number): Date {
  return new Date(t + DAY_MS);
}

/** TF1 decides at the close that falls on Monday 00:00 UTC, i.e. at the end of Sunday's bar. */
export function isWeeklyDecision(t: number): boolean {
  return closeDate(t).getUTCDay() === 1;
}

/** TF2 decides at the first close of each calendar month, the one at 00:00 UTC on the 1st. */
export function isMonthlyDecision(t: number): boolean {
  return closeDate(t).getUTCDate() === 1;
}

/** TF1: the 4-horizon weekly score, sized by 0.25 over the mean-absolute volatility. */
export function tf1Paths(t: readonly number[], c: ArrayLike<number>): RulePaths {
  const score = signSum(c, TF1_LOOKBACKS);
  const vol = meanAbsVol(c, 30);
  const signal = new Float64Array(c.length);
  const size = new Float64Array(c.length).fill(Number.NaN);
  for (let i = 0; i < c.length; i++) {
    signal[i] = score[i] / 4;
    if (vol[i] > 0) size[i] = 0.25 / vol[i];
  }
  return { signal, size, decide: (i) => isWeeklyDecision(t[i]), rebalance: { kind: 'on-decision' } };
}

/** TF2: the equal blend of the 1, 3 and 12-month signs, sized by 0.40 over the EWMA volatility. */
export function tf2Paths(t: readonly number[], c: ArrayLike<number>): RulePaths {
  const sum = signSum(c, TF2_LOOKBACKS);
  const vol = ewmaVol(c, 60);
  const signal = new Float64Array(c.length);
  const size = new Float64Array(c.length).fill(Number.NaN);
  for (let i = 0; i < c.length; i++) {
    signal[i] = sum[i] / 3;
    if (vol[i] > 0) size[i] = 0.4 / vol[i];
  }
  return { signal, size, decide: (i) => isMonthlyDecision(t[i]), rebalance: { kind: 'on-decision' } };
}

/** TF3: long, unscaled, while the close is above its 200-day simple average; flat otherwise. */
export function tf3Paths(t: readonly number[], c: ArrayLike<number>): RulePaths {
  const avg = sma(c, 200);
  const signal = new Float64Array(c.length);
  const size = new Float64Array(c.length).fill(1);
  for (let i = 0; i < c.length; i++) signal[i] = c[i] > avg[i] ? 1 : 0;
  return { signal, size, decide: () => true, rebalance: { kind: 'on-signal-change' } };
}

/**
 * TF4: the mean of nine Donchian lookbacks' weights, each min(0.25 / sigma90, 2.0)
 * when long. Because every lookback shares sigma90, the combo is (k/9) x
 * min(0.25 / sigma90, 2.0) with k the lookbacks in; `signal` is k/9.
 */
export function tf4Paths(t: readonly number[], c: ArrayLike<number>): RulePaths {
  const states = TF4_LOOKBACKS.map((n) => donchianState(c, n));
  const vol = stdVol(c, 90);
  const signal = new Float64Array(c.length);
  const size = new Float64Array(c.length).fill(Number.NaN);
  for (let i = 0; i < c.length; i++) {
    let k = 0;
    for (const s of states) k += s[i];
    signal[i] = k / TF4_LOOKBACKS.length;
    // Zero volatility sizes at the 2.0 cap (0.25 / 0 is Infinity).
    if (Number.isFinite(vol[i])) size[i] = Math.min(0.25 / vol[i], 2.0);
  }
  return { signal, size, decide: () => true, rebalance: { kind: 'band', band: TF4_BAND } };
}

/**
 * C3, after Han, Kang and Ryu: hold the basket for 5 days from the close at which
 * the basket's 28-day return ranks in the top third of its own trailing 365
 * values; re-check at the end of each hold. `index` is the basket's level on the
 * same days as `t`. Unscaled. The returned state is shared by every sleeve.
 */
export function c3State(index: ArrayLike<number>, lookback = 28, history = 365, hold = 5): Float64Array {
  const n = index.length;
  const ret = new Float64Array(n).fill(Number.NaN);
  for (let i = lookback; i < n; i++) ret[i] = index[i] / index[i - lookback] - 1;
  const top = new Uint8Array(n);
  for (let i = lookback + history; i < n; i++) {
    let below = 0;
    for (let k = i - history; k < i; k++) if (ret[k] < ret[i]) below++;
    top[i] = below / history >= 2 / 3 ? 1 : 0;
  }
  const state = new Float64Array(n);
  let remaining = 0;
  for (let i = 0; i < n; i++) {
    if (remaining > 0) {
      remaining--;
      state[i] = 1;
      continue;
    }
    if (top[i] === 1) {
      remaining = hold - 1;
      state[i] = 1;
    }
  }
  return state;
}

/** C3's paths for one sleeve, given the shared basket state. */
export function c3Paths(c: ArrayLike<number>, basketState: Float64Array): RulePaths {
  return {
    signal: Float64Array.from(basketState),
    size: new Float64Array(c.length).fill(1),
    decide: () => true,
    rebalance: { kind: 'on-signal-change' },
  };
}

/** The always-long twin T+: the same paths with the signal forced to fully long. */
export function twinOf(paths: RulePaths): RulePaths {
  return { ...paths, signal: new Float64Array(paths.signal.length).fill(1) };
}

/*
 * BROAD PHASE (broad-trend.ts header): undefined-aware paths, the symmetric
 * twin and the point-in-time C3 basket. Nothing above changes; these are new
 * functions, and the legends builders keep their exact outputs.
 */

/**
 * The first bar index at which each TF rule's signal and size are both defined,
 * from the rule's definition (trend-sim.ts header, TREND SET):
 *   - TF1: the 60-day lookback reads close_{i-60} (i >= 60); the 30-day mean
 *     absolute volatility needs 30 returns (i >= 30).
 *   - TF2: the 365-day lookback (i >= 365); the EWMA is seeded at i = 60.
 *   - TF3: the 200-day SMA needs 200 closes including i (i >= 199).
 *   - TF4: the 360-day Donchian needs 360 closes including i (i >= 359); sigma90
 *     needs 90 returns (i >= 90).
 */
export const TF_FIRST_DEFINED: Readonly<Record<Exclude<TrendRuleId, 'C3'>, number>> = {
  TF1: Math.max(...TF1_LOOKBACKS, 30),
  TF2: Math.max(...TF2_LOOKBACKS, 60),
  TF3: 200 - 1,
  TF4: Math.max(Math.max(...TF4_LOOKBACKS) - 1, 90),
};

/** C3's state needs a 28-day return and its trailing 365 values: index position 28 + 365 on. */
export const C3_FIRST_DEFINED = 28 + 365;

/**
 * A TF rule's defined mask: 1 from its first defined index where its size is
 * finite (TF1 and TF2 leave the size undefined on a zero volatility).
 */
export function tfDefined(rule: Exclude<TrendRuleId, 'C3'>, size: Float64Array): Uint8Array {
  const first = TF_FIRST_DEFINED[rule];
  const defined = new Uint8Array(size.length);
  for (let i = first; i < size.length; i++) defined[i] = Number.isFinite(size[i]) ? 1 : 0;
  return defined;
}

/** One contract's closes as the point-in-time basket reads them (TrendSymbolInput fits). */
export interface BasketInput {
  symbol: string;
  /** Bar open times, consecutive UTC days. */
  t: readonly number[];
  close: ArrayLike<number>;
  /** 1 on a carried day (no real close). */
  carried?: Uint8Array;
  /** The last traded day when the contract ends before the sample end (a delisting), else null. */
  endDay?: number | null;
}

/** C3's point-in-time basket: the index, its state and where the state is defined, on consecutive days. */
export interface BroadBasket {
  /** Consecutive UTC day starts from the first basket day. */
  days: number[];
  index: Float64Array;
  /** c3State on the index, unchanged. */
  state: Float64Array;
  /** 1 from position C3_FIRST_DEFINED on. */
  defined: Uint8Array;
}

function dayIndexOf(t: readonly number[], day: number): number {
  if (t.length === 0) return -1;
  const i = Math.round((day - t[0]) / DAY_MS);
  return i >= 0 && i < t.length && t[i] === day ? i : -1;
}

/**
 * Header C3 BASKET: the basket index from its own point-in-time membership
 * (`membership[symbol]`: member for days from <= d < to). On each day after the
 * first, the index moves by the equal-weighted close-to-close return of that
 * day's members with real (non-carried) closes on both days; a contract that was
 * a basket member on its last traded day (`endDay`) adds -delistHaircut as its
 * return on the day after. A day with no contributor keeps the level. Chain-
 * linked from 1 on the first basket day (the legends index convention: the
 * first day carries no return). Its state is c3State, unchanged.
 *
 * Reading recorded at build time (broad-trend.ts implementation notes, A4): the
 * header charges "a member whose contract ends ... so the index pays every
 * failure the portfolio pays". The portfolio pays a delisting when it holds the
 * contract on its last day, so the index charges a contract that was a member on
 * its last traded day, whether or not the next month's ranking keeps it.
 */
export function pointInTimeBasket(
  inputs: readonly BasketInput[],
  membership: Readonly<Record<string, ReadonlyArray<{ from: number; to: number }>>>,
  delistHaircut: number
): BroadBasket {
  let first = Infinity;
  let last = -Infinity;
  for (const spans of Object.values(membership)) {
    for (const span of spans) {
      if (!(span.to > span.from) || span.from % DAY_MS !== 0 || span.to % DAY_MS !== 0) {
        throw new Error(`Basket span [${span.from}, ${span.to}) is not a range of UTC days`);
      }
      first = Math.min(first, span.from);
      last = Math.max(last, span.to - DAY_MS);
    }
  }
  if (!Number.isFinite(first)) throw new Error('The basket has no membership');
  const n = Math.round((last - first) / DAY_MS) + 1;
  const days = Array.from({ length: n }, (_, k) => first + k * DAY_MS);

  const flags = inputs.map((input) => {
    const flag = new Uint8Array(n);
    for (const span of membership[input.symbol] ?? []) {
      for (let d = span.from; d < span.to; d += DAY_MS) flag[Math.round((d - first) / DAY_MS)] = 1;
    }
    return flag;
  });

  const index = new Float64Array(n);
  index[0] = 1;
  for (let k = 1; k < n; k++) {
    const day = days[k];
    let sum = 0;
    let count = 0;
    inputs.forEach((input, j) => {
      if (flags[j][k] === 1) {
        const i = dayIndexOf(input.t, day);
        const before = dayIndexOf(input.t, day - DAY_MS);
        const real = (x: number) => input.carried === undefined || input.carried[x] !== 1;
        if (i !== -1 && before !== -1 && real(i) && real(before)) {
          sum += input.close[i] / input.close[before] - 1;
          count++;
          return;
        }
      }
      if (input.endDay !== undefined && input.endDay !== null && input.endDay === day - DAY_MS && flags[j][k - 1] === 1) {
        sum -= delistHaircut;
        count++;
      }
    });
    index[k] = index[k - 1] * (1 + (count > 0 ? sum / count : 0));
  }
  const state = c3State(index);
  const defined = new Uint8Array(n);
  for (let k = C3_FIRST_DEFINED; k < n; k++) defined[k] = 1;
  return { days, index, state, defined };
}

/** C3's paths for one contract from the point-in-time basket; 0 (holds nothing) outside the basket's days. */
export function c3BroadPaths(t: readonly number[], basket: BroadBasket): RulePaths {
  const signal = new Float64Array(t.length);
  const defined = new Uint8Array(t.length);
  const first = basket.days.length > 0 ? basket.days[0] : 0;
  for (let i = 0; i < t.length; i++) {
    const k = Math.round((t[i] - first) / DAY_MS);
    if (k >= 0 && k < basket.days.length && basket.days[k] === t[i]) {
      signal[i] = basket.state[k];
      defined[i] = basket.defined[k];
    }
  }
  return {
    signal,
    size: new Float64Array(t.length).fill(1),
    decide: () => true,
    rebalance: { kind: 'on-signal-change' },
    defined,
  };
}

/**
 * Broad phase paths for one contract, computed on its own full history: the
 * legends builder's paths (unchanged) with `defined` set and the signal set to 0
 * where it is not defined ("A signal that is not yet defined holds nothing").
 * C3 reads the shared point-in-time basket.
 */
export function broadPaths(
  rule: TrendRuleId,
  input: { t: readonly number[]; close: ArrayLike<number> },
  basket?: BroadBasket
): RulePaths {
  if (rule === 'C3') {
    if (!basket) throw new Error('C3 needs the point-in-time basket');
    return c3BroadPaths(input.t, basket);
  }
  const build = { TF1: tf1Paths, TF2: tf2Paths, TF3: tf3Paths, TF4: tf4Paths }[rule];
  const base = build(input.t, input.close);
  const defined = tfDefined(rule, base.size);
  const signal = new Float64Array(base.signal.length);
  for (let i = 0; i < signal.length; i++) signal[i] = defined[i] === 1 ? base.signal[i] : 0;
  return { ...base, signal, defined };
}

/**
 * Header PORTFOLIO: the always-long twin T+ of the broad phase, forced fully long
 * where the rule's signal is defined and holding nothing where it is not. Same
 * size, schedule and band. `twinOf` is unchanged for the legends phase.
 */
export function twinOfBroad(paths: RulePaths): RulePaths {
  const { defined } = paths;
  if (!defined) throw new Error('twinOfBroad needs the paths\' defined mask (broadPaths)');
  const signal = new Float64Array(paths.signal.length);
  for (let i = 0; i < signal.length; i++) signal[i] = defined[i] === 1 ? 1 : 0;
  return { ...paths, signal };
}
