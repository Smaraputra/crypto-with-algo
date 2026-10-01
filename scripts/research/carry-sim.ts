/**
 * FUNDING CARRY: long spot, short USDT-M perpetual, collecting funding.
 *
 * PRE-REGISTRATION, 2026-10-02, committed before any simulation code.
 * Decided by the user on 2026-10-01 after the program review: the one kind of
 * return the program never measured is a structural transfer (longs paying
 * shorts), not a prediction of direction. Every directional axis on this
 * dataset has already failed under a pre-registered criterion.
 *
 * HYPOTHESIS. Holding one unit of notional long spot against one unit short
 * perp on each of the ten signal symbols earns the funding the perp's longs
 * pay, net of fees, slippage and basis drift, positively and stably enough
 * over 2023-01-01 to 2026-06-30 to beat a USDT savings yield.
 *
 * DATA. Per-settlement funding from the `funding` dataset kind (the
 * `FundingSettlement` collection, backfilled 2026-10-01: 69,945 settlements,
 * the 8h grid holding in 69 of 70 symbol-years and SOLUSDT 2022 on 2h and 4h);
 * spot 1h candles (`candles`); perp 1h klines (`perp`). Each symbol's bars are
 * the timestamps its spot and perp series share. Lockbox applied: nothing
 * from 2026-07-01 is read.
 *
 * POSITION. Per symbol a weight w in {0, 1}: w = 1 is one unit of notional
 * long spot and one unit short perp, re-marked to constant notional each bar
 * (the hedge drift that rebalancing would cost is not modelled and is small on
 * a hedged pair). Spot is 1x: 2x and 3x need USDT borrow-rate history the
 * repository does not have, and are DEFERRED rather than modelled on an
 * assumed rate, which could decide the result.
 *
 * RETURN per unit notional over bar t, decided at its close T_t:
 *   w_t x [ (S_t+1 / S_t - 1) - (P_t+1 / P_t - 1) ]          basis drift
 *   + w_t x sum of rate_s over settlements T_t < s <= T_t+1     funding received
 *   - c x |w_t - w_t-1|                                        turnover cost
 * A settlement at exactly T_t belongs to the bar before, so entering at T_t
 * does not collect it and an exit decided at T_t+1 = s does. Signals read
 * only settlements with s <= T_t.
 *
 * COSTS. c per unit turnover = spot taker 0.10% + perp taker 0.05% + 3 bps
 * study slippage on each leg = 0.21%, so 0.42% a round trip. Spot is the
 * published VIP 0 schedule (0.10% maker and taker); THE USER CONFIRMS IT ON
 * THEIR OWN FEE PAGE before the result is read, as perp fees were confirmed on
 * 2026-09-27. Reported, never selected on: maker on both legs (0.12% a side,
 * no slippage) and spot with BNB (0.075%).
 *
 * RULES, trials 7.
 *   R0  always on: w = 1 throughout. The benchmark, nothing selected.
 *   R1  hysteresis on trailing funding. F_L = (sum of rates settled in the last
 *       L days) x 365 / L, annualised in calendar time so a symbol settling
 *       every 2h or 4h is counted correctly. Enter when F_L > E, exit when
 *       F_L < 0. Grid L in {3, 7} days, E in {5%, 10%, 20%} a year: 6 cells.
 *
 * WALK-FORWARD. Seven test windows of six months from 2023-01-01 to
 * 2026-06-30, each trained on the twelve months before it. Every window starts
 * flat and ends flat for both rules, round trips charged. R1's cell is the one
 * with the best training-window net return per unit notional.
 *
 * STATISTICS. The book's daily return is the mean over the ten symbols of
 * each symbol's return per unit notional (an idle symbol earns 0), annualised
 * by 365. Stationary block bootstrap of daily returns, 2,000 draws, seed 42,
 * mean block max(mean R1 episode in days, 20); 10 and 40 days as sensitivity.
 *
 * KILL CRITERION. The carry hypothesis is rejected if ANY of:
 *   (a) the pooled annualised net return per unit notional has CI low <= 0;
 *   (b) its point estimate is below H = 5% a year, a USDT savings yield taken
 *       as an assumption at the level of Binance Simple Earn's flexible USDT
 *       product over 2024 to 2026 (stated, not measured here);
 *   (c) more than one of the calendar periods 2023, 2024, 2025, 2026H1 is
 *       negative.
 * R1 counts as a timing finding only if it also beats R0 (paired annualised
 * difference with CI low > 0) AND a timing null that circularly shifts each
 * symbol's weight path against its returns and settlements, 200 shifts,
 * gives p < 0.05. The null keeps each path's duty cycle and switch count, so
 * its costs are R1's own.
 *
 * Reported, never gates: per-symbol results, the drop-one-symbol jackknife,
 * the two cost rows above, a per-symbol feasibility table at 100, 500 and
 * 1,000 USDT of capital (spot and perp minimum notional, perp lot rounding),
 * and a LEVERAGE TABLE for the perp leg at 1x, 3x, 10x, 20x and 50x. Leverage
 * cannot change the return per unit notional, which is why the verdict is
 * judged there; it changes return on capital (notional return / (1 + 1/L))
 * and liquidation risk. Margin is topped up from the spot leg once a day at
 * 00:00 UTC; between top-ups the short is liquidated if a 1h perp HIGH rises
 * past the top-up reference by 1/L - 0.5% (an assumed maintenance margin),
 * costing an assumed 1.0% of notional plus a re-entry round trip. Per leverage:
 * return on capital, liquidation count, cost, worst drawdown and worst adverse
 * move against the liquidation distance.
 *
 * PREDICTION, with its arithmetic. Funding settled on 1h snapshots from
 * 2021-10 to 2026-06 averaged, a year: BTC 7.3%, ETH 6.5%, LINK 8.6%,
 * DOGE 8.1%, ADA 6.3%, XRP 6.2%, AVAX 3.6%, SOL 0.2%, DOT -0.4%, BNB -5.8%, an
 * equal-weight 4.1%. The test span is later and weaker: from 2025 the highest
 * settled rate on most symbols is the 0.01% base, and the share settling at it
 * fell to 2 to 3% on BTC and ETH in 2026H1. Costs take about 0.84% a year
 * (one round trip per six-month window). Predicted R0: +2% to +3.5% a year per
 * unit notional, CI low plausibly above zero, BELOW the 5% hurdle, so the kill
 * criterion fires on (b). Predicted R1: +2% to +4%, avoiding BNB, DOT and SOL's
 * negative stretches but earning nothing while idle, also below the hurdle,
 * with timing p against R0 above 0.05.
 *
 * The lockbox is read once, only if the criterion is passed.
 */
import {
  BINANCE_FUTURES_MAKER_FEE,
  BINANCE_FUTURES_TAKER_FEE,
  BINANCE_SPOT_BNB_FEE,
  BINANCE_SPOT_MAKER_FEE,
  BINANCE_SPOT_TAKER_FEE,
  STUDY_SLIPPAGE_BPS,
} from '@/lib/backtest/cost-model';
import { bootstrapCi, meanOf } from '@/lib/stats/block-bootstrap';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const YEAR_DAYS = 365;
/** The simulation grid: 1h bars. */
export const BAR_MS = HOUR_MS;

/** One settled funding rate, `t` the settlement boundary (FundingRow in dataset-format.ts). */
export interface Settlement {
  t: number;
  rate: number;
}

/** One symbol on the bars its spot and perp series share. */
export interface CarrySymbolInput {
  symbol: string;
  /** Bar OPEN times, ascending; the bar's close is t + BAR_MS. */
  t: number[];
  spotClose: number[];
  perpClose: number[];
  perpHigh: number[];
  /** Sorted by t. */
  settlements: Settlement[];
}

export type CarryRule =
  | { kind: 'always' }
  | { kind: 'hysteresis'; lookbackDays: number; enterAnnual: number };

/** The six pre-registered R1 cells, in declaration order (ties go to the first). */
export const R1_GRID: CarryRule[] = [3, 7].flatMap((lookbackDays) =>
  [0.05, 0.1, 0.2].map((enterAnnual) => ({ kind: 'hysteresis' as const, lookbackDays, enterAnnual }))
);

/** R0 plus the six R1 cells. */
export const CARRY_TRIALS = 1 + R1_GRID.length;

export function ruleLabel(rule: CarryRule): string {
  return rule.kind === 'always' ? 'R0 always' : `R1 L${rule.lookbackDays}d E${Math.round(rule.enterAnnual * 100)}%`;
}

/** Cost per unit of notional turnover, both legs. */
export interface CostProfile {
  name: string;
  perSide: number;
}

const SLIP_1H = (STUDY_SLIPPAGE_BPS['1h'] ?? 0) / 10000;

/** Taker on both legs plus study slippage on each: the pre-registered verdict cost. */
export const CARRY_COST_TAKER: CostProfile = {
  name: 'taker',
  perSide: BINANCE_SPOT_TAKER_FEE + BINANCE_FUTURES_TAKER_FEE + 2 * SLIP_1H,
};
/** Reported only: resting orders on both legs, no slippage. */
export const CARRY_COST_MAKER: CostProfile = {
  name: 'maker',
  perSide: BINANCE_SPOT_MAKER_FEE + BINANCE_FUTURES_MAKER_FEE,
};
/** Reported only: spot fees paid in BNB, perp taker, slippage on both legs. */
export const CARRY_COST_BNB: CostProfile = {
  name: 'bnb',
  perSide: BINANCE_SPOT_BNB_FEE + BINANCE_FUTURES_TAKER_FEE + 2 * SLIP_1H,
};

/**
 * F_L at each bar's CLOSE: the rates settled in (close - L days, close],
 * summed and scaled to a year in calendar time, so a symbol settling every 2h
 * counts every settlement. Reads nothing after the close.
 */
export function trailingFundingAnnual(input: CarrySymbolInput, lookbackDays: number): Float64Array {
  const n = input.t.length;
  const out = new Float64Array(n);
  const { settlements } = input;
  const windowMs = lookbackDays * DAY_MS;
  let right = 0;
  let left = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const close = input.t[i] + BAR_MS;
    while (right < settlements.length && settlements[right].t <= close) {
      sum += settlements[right].rate;
      right++;
    }
    while (left < right && settlements[left].t <= close - windowMs) {
      sum -= settlements[left].rate;
      left++;
    }
    out[i] = (sum * YEAR_DAYS) / lookbackDays;
  }
  return out;
}

/**
 * The weight held over (close_i, close_i+1] for each bar of a window
 * [from, to]: flat before `from`, flat from `to` on (the window ends flat).
 */
export function weightPath(input: CarrySymbolInput, rule: CarryRule, from: number, to: number): Float64Array {
  const w = new Float64Array(input.t.length);
  if (to <= from) return w;
  if (rule.kind === 'always') {
    for (let i = from; i < to; i++) w[i] = 1;
    return w;
  }
  const f = trailingFundingAnnual(input, rule.lookbackDays);
  let held = 0;
  for (let i = from; i < to; i++) {
    if (held === 0 && f[i] > rule.enterAnnual) held = 1;
    else if (held === 1 && f[i] < 0) held = 0;
    w[i] = held;
  }
  return w;
}

/** Sum of settlements with prev < s <= next. Settlements must be sorted. */
function fundingIn(settlements: Settlement[], startIdx: { i: number }, prev: number, next: number): number {
  while (startIdx.i < settlements.length && settlements[startIdx.i].t <= prev) startIdx.i++;
  let sum = 0;
  let k = startIdx.i;
  while (k < settlements.length && settlements[k].t <= next) {
    sum += settlements[k].rate;
    k++;
  }
  return sum;
}

export interface BarReturns {
  /** Net return per unit notional booked for each bar index (0 outside the window). */
  net: Float64Array;
  /** Funding part of `net`. */
  funding: Float64Array;
  /** Cost part of `net` (a positive number, subtracted). */
  cost: Float64Array;
}

/**
 * Per-bar returns of a weight path over [from, to]. Decision i, at close_i,
 * holds w_i over (close_i, close_i+1] and earns the spot-minus-perp move plus
 * every settlement in that interval; its turnover |w_i - w_i-1| pays `cost`.
 * The bar `to` only closes what was held (w_to is 0 by construction).
 */
export function barReturns(
  input: CarrySymbolInput,
  w: Float64Array,
  from: number,
  to: number,
  cost: CostProfile
): BarReturns {
  const n = input.t.length;
  const net = new Float64Array(n);
  const funding = new Float64Array(n);
  const costs = new Float64Array(n);
  const ptr = { i: 0 };
  for (let i = from; i <= to && i < n; i++) {
    const prevW = i > from ? w[i - 1] : 0;
    const turnover = Math.abs(w[i] - prevW);
    const c = turnover * cost.perSide;
    let r = -c;
    if (w[i] !== 0 && i + 1 < n) {
      const spot = input.spotClose[i + 1] / input.spotClose[i] - 1;
      const perp = input.perpClose[i + 1] / input.perpClose[i] - 1;
      const close = input.t[i] + BAR_MS;
      const nextClose = input.t[i + 1] + BAR_MS;
      // The short perp RECEIVES a positive rate.
      const f = w[i] * fundingIn(input.settlements, ptr, close, nextClose);
      funding[i] = f;
      r += w[i] * (spot - perp) + f;
    }
    costs[i] = c;
    net[i] = r;
  }
  return { net, funding, cost: costs };
}

/** The UTC day a moment belongs to; a moment exactly at midnight closes the day before. */
export function dayOf(ms: number): number {
  return Math.floor((ms - 1) / DAY_MS) * DAY_MS;
}

/**
 * Daily sums of one window's bookings, keyed by UTC day start. A decision's
 * turnover cost is booked on the day of the close it is decided at, and its
 * holding return (price move plus funding) on the day the holding period
 * ends, so the closing trade at a window's last bar is never pushed past the
 * window and lost.
 */
export function dailySums(input: CarrySymbolInput, r: BarReturns, from: number, to: number): Map<number, number> {
  const out = new Map<number, number>();
  const add = (day: number, value: number) => {
    if (value !== 0) out.set(day, (out.get(day) ?? 0) + value);
  };
  for (let i = from; i <= to && i < input.t.length; i++) {
    add(dayOf(input.t[i] + BAR_MS), -r.cost[i]);
    if (i + 1 < input.t.length) add(dayOf(input.t[i + 1] + BAR_MS), r.net[i] + r.cost[i]);
  }
  return out;
}

/** First bar whose OPEN is at or after `fromMs`, and last bar whose CLOSE is at or before `toMs`. */
export function windowBars(input: CarrySymbolInput, fromMs: number, toMs: number): { from: number; to: number } {
  let from = input.t.findIndex((t) => t >= fromMs);
  if (from === -1) from = input.t.length;
  let to = -1;
  for (let i = input.t.length - 1; i >= 0; i--) {
    if (input.t[i] + BAR_MS <= toMs) {
      to = i;
      break;
    }
  }
  return { from, to };
}

/** Every UTC day start in [fromMs, toMs). */
export function daysIn(fromMs: number, toMs: number): number[] {
  const days: number[] = [];
  for (let d = dayOf(fromMs + 1); d < toMs; d += DAY_MS) days.push(d);
  return days;
}

export interface BookRun {
  /** The book's daily net return per unit notional (mean over symbols), one per day. */
  daily: number[];
  days: number[];
  /** Per symbol, daily net return per unit notional over the same days. */
  perSymbol: Record<string, number[]>;
  /** Per symbol, the weight path, for the timing null and the leverage table. */
  weights: Record<string, Float64Array>;
  /** Episode lengths in bars, every symbol. */
  episodes: number[];
  funding: number;
  cost: number;
}

/**
 * One rule over one calendar span for the whole book: each symbol simulated
 * on its own bars inside [fromMs, toMs), the book's day the mean over ALL
 * symbols (an idle or missing symbol contributes 0), so the result is per unit
 * of notional per symbol.
 */
export function runBook(
  inputs: CarrySymbolInput[],
  rule: CarryRule,
  fromMs: number,
  toMs: number,
  cost: CostProfile,
  weightsOverride?: Record<string, Float64Array>
): BookRun {
  const days = daysIn(fromMs, toMs);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const perSymbol: Record<string, number[]> = {};
  const weights: Record<string, Float64Array> = {};
  const episodes: number[] = [];
  let funding = 0;
  let costSum = 0;
  for (const input of inputs) {
    const { from, to } = windowBars(input, fromMs, toMs);
    const w = weightsOverride?.[input.symbol] ?? weightPath(input, rule, from, to);
    weights[input.symbol] = w;
    const r = barReturns(input, w, from, to, cost);
    const series = new Array(days.length).fill(0);
    for (const [day, value] of dailySums(input, r, from, to)) {
      const k = dayIndex.get(day);
      if (k !== undefined) series[k] += value;
    }
    perSymbol[input.symbol] = series;
    for (let i = from; i <= to && i < input.t.length; i++) {
      funding += r.funding[i];
      costSum += r.cost[i];
    }
    let run = 0;
    for (let i = from; i <= to && i < input.t.length; i++) {
      if (w[i] === 1) run++;
      else if (run > 0) {
        episodes.push(run);
        run = 0;
      }
    }
    if (run > 0) episodes.push(run);
  }
  const n = inputs.length;
  const daily = days.map((_, k) => (n === 0 ? 0 : inputs.reduce((sum, inp) => sum + perSymbol[inp.symbol][k], 0) / n));
  return { daily, days, perSymbol, weights, episodes, funding: funding / Math.max(1, n), cost: costSum / Math.max(1, n) };
}

/** Annualised mean of a daily series. */
export function annualised(daily: number[]): number {
  return daily.length === 0 ? Number.NaN : meanOf(daily) * YEAR_DAYS;
}

export interface WindowSpec {
  testFrom: number;
  testTo: number;
  trainFrom: number;
  trainTo: number;
}

/** Seven six-month test windows, 2023-01-01 to 2026-06-30, each trained on the twelve months before. */
export function carryWindows(start = Date.UTC(2023, 0, 1), end = Date.UTC(2026, 6, 1)): WindowSpec[] {
  const out: WindowSpec[] = [];
  for (let k = 0; ; k++) {
    const from = new Date(start);
    from.setUTCMonth(from.getUTCMonth() + 6 * k);
    if (from.getTime() >= end) break;
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + 6);
    const trainFrom = new Date(from);
    trainFrom.setUTCMonth(trainFrom.getUTCMonth() - 12);
    out.push({
      testFrom: from.getTime(),
      testTo: Math.min(to.getTime(), end),
      trainFrom: trainFrom.getTime(),
      trainTo: from.getTime(),
    });
  }
  return out;
}

export interface WalkForwardWindow {
  window: WindowSpec;
  r1Selected: CarryRule;
  r1TrainAnnual: number;
  r0: BookRun;
  r1: BookRun;
}

/** R0 and the selected R1 cell over every window, the R1 cell chosen on the window's training span. */
export function walkForward(inputs: CarrySymbolInput[], cost: CostProfile, windows = carryWindows()): WalkForwardWindow[] {
  return windows.map((window) => {
    let best: { rule: CarryRule; annual: number } | null = null;
    for (const rule of R1_GRID) {
      const annual = annualised(runBook(inputs, rule, window.trainFrom, window.trainTo, cost).daily);
      if (best === null || annual > best.annual) best = { rule, annual };
    }
    return {
      window,
      r1Selected: best!.rule,
      r1TrainAnnual: best!.annual,
      r0: runBook(inputs, { kind: 'always' }, window.testFrom, window.testTo, cost),
      r1: runBook(inputs, best!.rule, window.testFrom, window.testTo, cost),
    };
  });
}

/** The out-of-sample daily book series of one rule, windows concatenated. */
export function pooledDaily(windows: WalkForwardWindow[], which: 'r0' | 'r1'): { days: number[]; daily: number[] } {
  const days: number[] = [];
  const daily: number[] = [];
  for (const w of windows) {
    days.push(...w[which].days);
    daily.push(...w[which].daily);
  }
  return { days, daily };
}

export interface AnnualStat {
  annual: number;
  ciLow: number;
  ciHigh: number;
  days: number;
}

/** Annualised mean and its stationary block bootstrap 95% CI. */
export function annualStat(daily: number[], meanBlockLen: number, iterations = 2000, seed = 42): AnnualStat {
  if (daily.length < 2) return { annual: Number.NaN, ciLow: Number.NaN, ciHigh: Number.NaN, days: daily.length };
  const ci = bootstrapCi(daily, meanOf, { iterations, meanBlockLen, seed });
  return { annual: ci.point * YEAR_DAYS, ciLow: ci.low * YEAR_DAYS, ciHigh: ci.high * YEAR_DAYS, days: daily.length };
}

/** Calendar periods the kill criterion reads: 2023, 2024, 2025, 2026H1. */
export const CARRY_PERIODS: Array<{ label: string; from: number; to: number }> = [
  { label: '2023', from: Date.UTC(2023, 0, 1), to: Date.UTC(2024, 0, 1) },
  { label: '2024', from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1) },
  { label: '2025', from: Date.UTC(2025, 0, 1), to: Date.UTC(2026, 0, 1) },
  { label: '2026H1', from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 6, 1) },
];

export function periodAnnuals(days: number[], daily: number[]): Array<{ label: string; annual: number; days: number }> {
  return CARRY_PERIODS.map((p) => {
    const slice = daily.filter((_, k) => days[k] >= p.from && days[k] < p.to);
    return { label: p.label, annual: annualised(slice), days: slice.length };
  });
}

/** Deterministic PRNG (mulberry32), so the timing null reproduces by seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The circular shift of one weight path inside a window: the held bars
 * [from, to) rotate by `k`, the closing bar stays flat. Duty cycle and switch
 * count are kept (one switch can move across the wrap), so the costs a shifted
 * path pays are the original path's own.
 */
export function shiftWeights(w: Float64Array, from: number, to: number, k: number): Float64Array {
  const out = new Float64Array(w.length);
  const len = to - from;
  if (len <= 0) return out;
  for (let i = 0; i < len; i++) out[from + ((i + k) % len)] = w[from + i];
  return out;
}

/**
 * Timing null for R1: in every window, each symbol's selected R1 path is
 * shifted by its own random offset, and the book is re-run with those paths.
 * p = (1 + draws at or above the observed annual) / (draws + 1).
 */
export function timingNull(
  inputs: CarrySymbolInput[],
  windows: WalkForwardWindow[],
  cost: CostProfile,
  draws = 200,
  seed = 7
): { p: number; observed: number; nullMean: number } {
  const observed = annualised(pooledDaily(windows, 'r1').daily);
  const random = seededRandom(seed);
  let atOrAbove = 0;
  let sum = 0;
  for (let d = 0; d < draws; d++) {
    const daily: number[] = [];
    for (const w of windows) {
      const shifted: Record<string, Float64Array> = {};
      for (const input of inputs) {
        const { from, to } = windowBars(input, w.window.testFrom, w.window.testTo);
        const len = Math.max(1, to - from);
        shifted[input.symbol] = shiftWeights(w.r1.weights[input.symbol], from, to, Math.floor(random() * len));
      }
      daily.push(...runBook(inputs, w.r1Selected, w.window.testFrom, w.window.testTo, cost, shifted).daily);
    }
    const a = annualised(daily);
    sum += a;
    if (a >= observed) atOrAbove++;
  }
  return { p: (1 + atOrAbove) / (draws + 1), observed, nullMean: sum / draws };
}

/** Pre-registered liquidation assumptions for the leverage table. */
export const MAINTENANCE_MARGIN = 0.005;
export const LIQUIDATION_FEE = 0.01;
export const CARRY_LEVERAGES = [1, 3, 10, 20, 50];

export interface LeverageRow {
  leverage: number;
  liquidationDistance: number;
  annualOnCapital: number;
  liquidations: number;
  liquidationCostAnnual: number;
  worstAdverseMove: number;
  worstDrawdownOnCapital: number;
}

/**
 * The perp leg at leverage L, for a rule's out-of-sample paths. Capital is
 * notional x (1 + 1/L). The short's margin is topped up from the spot leg at
 * the first bar closing after each 00:00 UTC; between top-ups a 1h perp HIGH
 * above reference x (1 + 1/L - maintenance) liquidates it, costing the
 * liquidation fee plus a re-entry round trip, and the reference resets.
 */
export function leverageTable(
  inputs: CarrySymbolInput[],
  windows: WalkForwardWindow[],
  which: 'r0' | 'r1',
  cost: CostProfile
): LeverageRow[] {
  const base = pooledDaily(windows, which);
  return CARRY_LEVERAGES.map((leverage) => {
    const distance = 1 / leverage - MAINTENANCE_MARGIN;
    let liquidations = 0;
    let worst = 0;
    const liqCostByDay = new Map<number, number>();
    for (const w of windows) {
      for (const input of inputs) {
        const path = w[which].weights[input.symbol];
        const { from, to } = windowBars(input, w.window.testFrom, w.window.testTo);
        let ref = Number.NaN;
        for (let i = from; i < to && i + 1 < input.t.length; i++) {
          if (path[i] !== 1) {
            ref = Number.NaN;
            continue;
          }
          const close = input.t[i] + BAR_MS;
          if (!Number.isFinite(ref) || Math.floor(close / DAY_MS) !== Math.floor((close - BAR_MS) / DAY_MS)) {
            ref = input.perpClose[i];
          }
          const move = input.perpHigh[i + 1] / ref - 1;
          if (move > worst) worst = move;
          if (move >= distance) {
            liquidations++;
            const day = dayOf(input.t[i + 1] + BAR_MS);
            liqCostByDay.set(day, (liqCostByDay.get(day) ?? 0) + (LIQUIDATION_FEE + 2 * cost.perSide) / inputs.length);
            ref = input.perpClose[i + 1];
          }
        }
      }
    }
    const capital = 1 + 1 / leverage;
    const dailyOnCapital = base.daily.map((r, k) => (r - (liqCostByDay.get(base.days[k]) ?? 0)) / capital);
    let cum = 0;
    let peak = 0;
    let worstDd = 0;
    for (const r of dailyOnCapital) {
      cum += r;
      if (cum > peak) peak = cum;
      if (peak - cum > worstDd) worstDd = peak - cum;
    }
    const liqTotal = [...liqCostByDay.values()].reduce((a, b) => a + b, 0);
    return {
      leverage,
      liquidationDistance: distance,
      annualOnCapital: annualised(dailyOnCapital),
      liquidations,
      liquidationCostAnnual: base.daily.length > 0 ? (liqTotal / base.daily.length) * YEAR_DAYS : Number.NaN,
      worstAdverseMove: worst,
      worstDrawdownOnCapital: worstDd,
    };
  });
}

/** Binance spot minimum order notional on these pairs, USDT (published NOTIONAL filter). */
export const SPOT_MIN_NOTIONAL = 5;

export interface FeasibilityRow {
  symbol: string;
  capital: number;
  /** Notional per leg when all the capital goes to this one symbol at 1x. */
  notionalSingle: number;
  feasibleSingle: boolean;
  /** Notional per leg when the capital is split across all ten symbols at 1x. */
  notionalInBook: number;
  feasibleInBook: boolean;
}

/**
 * Whether one symbol's hedge can be placed at a capital level, at 1x: the
 * spot leg must clear its minimum notional, the perp leg its minimum notional
 * after rounding the quantity down to the lot.
 */
export function feasibility(
  symbol: string,
  price: number,
  capital: number,
  perp: { stepSize: number; minQty: number; minNotional: number },
  bookSize: number
): FeasibilityRow {
  const fits = (notional: number) => {
    const qty = Math.floor(notional / price / perp.stepSize) * perp.stepSize;
    return notional >= SPOT_MIN_NOTIONAL && qty >= perp.minQty && qty * price >= perp.minNotional;
  };
  const notionalSingle = capital / 2;
  const notionalInBook = capital / bookSize / 2;
  return {
    symbol,
    capital,
    notionalSingle,
    feasibleSingle: fits(notionalSingle),
    notionalInBook,
    feasibleInBook: fits(notionalInBook),
  };
}
