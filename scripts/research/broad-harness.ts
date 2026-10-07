/**
 * CLI for the broad trend phase pre-registered in broad-trend.ts's header: one rule
 * (TF1 to TF4 or C3, parameters unchanged) on the point-in-time top-50 universe of
 * Binance USDT-M perpetuals, through every gated and reported statistic, into a
 * schema v2 report (report-schema.ts BroadTrendReportSchema).
 *
 * Reads a hash-verified export and a universe file built from it (broad-inputs.ts),
 * lockbox applied. Costs: the taker fee (BROAD_FEE) plus the rank-tiered slippage,
 * the leave slippage and the delisting haircut (BROAD_COST). Sample: the universe's
 * start close to 2026-07-01.
 *
 * Usage:
 *   npx tsx scripts/research/broad-harness.ts --rule TF4 --dataset-dir <export> --universe-file <universe.json> \
 *     --out <report.json> --task-id <id> [--draws 200] [--null-size-universes 50]
 *
 * Gate 8 is left pending: broad-dsr.ts computes it once across the five reports.
 * The choices the header leaves open are recorded in broad-trend.ts's
 * implementation notes (A5).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { createSeededRandom } from '@/lib/stats/seeded-random';
import {
  BROAD_BLOCK_DAYS,
  BROAD_BLOCK_SENSITIVITY,
  BROAD_BOOT_DRAWS,
  BROAD_BOOT_SEED,
  BROAD_GATED_YEARS,
  BROAD_MIN_POSITIVE_YEAR_SHARE,
  BROAD_MIN_SAMPLE_DAYS,
  BROAD_NULL_DRAWS,
  BROAD_NULL_SEED,
  BROAD_REPORT_YEARS,
  BROAD_TIMING_P,
  BTC_ETH_ASSETS,
  COHORT_MIN_SHARE,
  EX2021_FROM,
  EX2021_TO,
  LEGENDS_TEN_ASSETS,
  NULL_SIZE_SEED,
  NULL_SIZE_UNIVERSES,
  STRESS_FEE_MULTIPLE,
  STRESS_REPORTED_HAIRCUT,
  broadVerdict,
  contractsOfAssets,
  evaluateBroadGates,
  firstDefinedMemberDay,
  listingYearCohorts,
  rejectionRates,
  topContributors,
  windowAlpha,
  yearAlphaBetas,
} from './broad-gates';
import { BENCHMARK_SYMBOL, loadBroadInputs, type BroadInputs } from './broad-inputs';
import {
  BROAD_COST,
  BROAD_FEE,
  DELIST_HAIRCUT,
  LEAVE_SLIPPAGE,
  SLIPPAGE_TIERS,
  isoDay,
  monthCloses,
} from './broad-trend';
import { validateBroadTrendReport, type BroadTrendReport } from './report-schema';
import { ciJson, resolveCommit, summarise } from './trend-harness';
import {
  DAY_MS,
  TREND_RULE_IDS,
  broadPaths,
  pointInTimeBasket,
  twinOfBroad,
  type BroadBasket,
  type RulePaths,
  type TrendRuleId,
} from './trend-signals';
import {
  NULL_CALENDAR_DAYS,
  NULL_CALENDAR_START,
  alphaCi,
  annualAlpha,
  annualMean,
  annualisedSharpe,
  barIndex,
  memberDays,
  runTrend,
  sharpeCi,
  spanAt,
  stressBroad,
  timingNull,
  type MembershipSpan,
  type SharedStatePath,
  type SimOptions,
  type TimingNullOptions,
  type TimingNullResult,
  type TrendRun,
  type TrendSymbolInput,
} from './trend-sim';

export interface BroadArgs {
  rule: TrendRuleId;
  datasetDir: string;
  universeFile: string;
  out: string;
  taskId: string;
  draws: number;
  nullSizeUniverses: number;
  /** Recorded resolutions of flagged funding settlements (note A6-1). */
  fundingResolutions?: string;
  /** Where to write the full list of flagged settlements when the coverage check stops the run. */
  fundingCheckOut?: string;
}

const FLAGS = [
  'rule',
  'dataset-dir',
  'universe-file',
  'out',
  'task-id',
  'draws',
  'null-size-universes',
  'funding-resolutions',
  'funding-check-out',
];

export function parseArgs(argv: string[]): BroadArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    const key = flag.slice(2);
    if (!FLAGS.includes(key)) throw new Error(`Unknown flag ${flag}`);
    flags.set(key, value);
    i++;
  }
  const rule = flags.get('rule');
  if (!rule || !(TREND_RULE_IDS as readonly string[]).includes(rule)) throw new Error(`--rule must be one of ${TREND_RULE_IDS.join(', ')}`);
  for (const required of ['dataset-dir', 'universe-file', 'out', 'task-id']) {
    if (!flags.has(required)) throw new Error(`--${required} is required`);
  }
  const draws = Number(flags.get('draws') ?? String(BROAD_NULL_DRAWS));
  if (!Number.isInteger(draws) || draws < 1) throw new Error('--draws must be a positive integer');
  const nullSizeUniverses = Number(flags.get('null-size-universes') ?? String(NULL_SIZE_UNIVERSES));
  if (!Number.isInteger(nullSizeUniverses) || nullSizeUniverses < 0) throw new Error('--null-size-universes must be a non-negative integer');
  return {
    rule: rule as TrendRuleId,
    datasetDir: flags.get('dataset-dir')!,
    universeFile: flags.get('universe-file')!,
    out: flags.get('out')!,
    taskId: flags.get('task-id')!,
    draws,
    nullSizeUniverses,
    ...(flags.has('funding-resolutions') ? { fundingResolutions: flags.get('funding-resolutions')! } : {}),
    ...(flags.has('funding-check-out') ? { fundingCheckOut: flags.get('funding-check-out')! } : {}),
  };
}

/** The null calendar (header gate 4): S days from its first. */
export interface NullCalendar {
  start: number;
  days: number;
}

export const DEFAULT_CALENDAR: NullCalendar = { start: NULL_CALENDAR_START, days: NULL_CALENDAR_DAYS };

/** The broad container's options: taker fee, rank-tiered slippage, leave slippage and delisting haircut. */
export function broadOptions(from: number, to: number, overrides: Partial<SimOptions> = {}): SimOptions {
  return { from, to, cost: BROAD_FEE, delay: 0, broad: BROAD_COST, ...overrides };
}

/** Header gate 7: 1.5x the fee, 2x every slippage tier and the leave slippage, a 4% haircut (or `haircut`). */
export function stressOptions(base: SimOptions, haircut?: number): SimOptions {
  const stressed = stressBroad(BROAD_COST);
  return {
    ...base,
    cost: { fee: base.cost.fee * STRESS_FEE_MULTIPLE, slippage: 0 },
    broad: haircut === undefined ? stressed : { ...stressed, delistHaircut: haircut },
  };
}

/** The rule's broad paths for every sleeve, and C3's point-in-time basket. */
export function broadRulePaths(
  rule: TrendRuleId,
  loaded: Pick<BroadInputs, 'inputs' | 'basketInputs' | 'basketMembership'>
): { paths: Record<string, RulePaths>; basket: BroadBasket | null } {
  const basket = rule === 'C3' ? pointInTimeBasket(loaded.basketInputs, loaded.basketMembership, DELIST_HAIRCUT) : null;
  const paths = Object.fromEntries(loaded.inputs.map((input) => [input.symbol, broadPaths(rule, input, basket ?? undefined)]));
  return { paths, basket };
}

export function twinPaths(paths: Record<string, RulePaths>): Record<string, RulePaths> {
  return Object.fromEntries(Object.entries(paths).map(([s, p]) => [s, twinOfBroad(p)]));
}

/** Refuses any bar outside the null calendar, before a return is computed: the aligned null could not place it. */
export function assertInCalendar(inputs: readonly TrendSymbolInput[], calendar: NullCalendar = DEFAULT_CALENDAR): void {
  const last = calendar.start + (calendar.days - 1) * DAY_MS;
  for (const input of inputs) {
    if (input.t.length === 0) continue;
    if (input.t[0] < calendar.start || input.t[input.t.length - 1] > last) {
      throw new Error(
        `${input.symbol}: bars ${isoDay(input.t[0])} to ${isoDay(input.t[input.t.length - 1])} lie outside the null calendar ` +
          `${isoDay(calendar.start)} to ${isoDay(last)}`
      );
    }
  }
}

export interface Pair {
  t: TrendRun;
  twin: TrendRun;
}

export function runPair(
  inputs: TrendSymbolInput[],
  paths: Record<string, RulePaths>,
  twin: Record<string, RulePaths>,
  opts: SimOptions
): Pair {
  return { t: runTrend(inputs, paths, opts), twin: runTrend(inputs, twin, opts) };
}

/** Index range of the run's days from `firstDay` (empty when null). */
export function rangeFrom(days: readonly number[], firstDay: number | null): { first: number; last: number } {
  const first = firstDay === null ? days.length : days.indexOf(firstDay);
  return { first: first === -1 ? days.length : first, last: days.length - 1 };
}

const finiteOrNull = (v: number) => (Number.isFinite(v) ? v : null);

function slice<T>(xs: readonly T[], range: { first: number; last: number }): T[] {
  return xs.slice(range.first, range.last + 1);
}

export function pairPoint(p: Pair, range: { first: number; last: number }) {
  const r = slice(p.t.returns, range);
  const w = slice(p.twin.returns, range);
  const { alpha, beta } = annualAlpha(r, w);
  return {
    alpha: finiteOrNull(alpha),
    beta: finiteOrNull(beta),
    sharpe: finiteOrNull(annualisedSharpe(r)),
    twinSharpe: finiteOrNull(annualisedSharpe(w)),
  };
}

/** Ranking-close spans covering [from, to), every month, at `rank`. */
export function everyMonth(from: number, to: number, rank = 1): MembershipSpan[] {
  const closes = monthCloses(isoDay(from), isoDay(to));
  return closes.map((close, k) => ({ from: close, to: k + 1 < closes.length ? closes[k + 1] : to, rank }));
}

function constantPaths(n: number, rebalance: RulePaths['rebalance']): RulePaths {
  return {
    signal: new Float64Array(n).fill(1),
    size: new Float64Array(n).fill(1),
    decide: () => true,
    rebalance,
    defined: new Uint8Array(n).fill(1),
  };
}

export interface Benchmark {
  available: boolean;
  note: string;
  alpha: number | null;
  beta: number | null;
  benchmarkSharpe: number | null;
  benchmarkAnnual: number | null;
}

function benchmarkOf(tR: readonly number[], bR: readonly number[], note: string): Benchmark {
  const { alpha, beta } = annualAlpha(tR, bR);
  return {
    available: true,
    note,
    alpha: finiteOrNull(alpha),
    beta: finiteOrNull(beta),
    benchmarkSharpe: finiteOrNull(annualisedSharpe(bR)),
    benchmarkAnnual: finiteOrNull(annualMean(bR)),
  };
}

/**
 * Header gate 3, reported: BTCUSDT perp held at 1x of equity through the sample in
 * the same container (one sleeve, a member every month at rank 1, so it returns to
 * 1x at each ranking close and drifts between), with the broad costs and archive
 * funding. Unavailable when no BTCUSDT contract spans the sample.
 */
export function btcBenchmark(loaded: BroadInputs, base: SimOptions, range: { first: number; last: number }, tR: readonly number[]): Benchmark {
  const ids = new Set(loaded.contracts.filter((c) => c.symbol === BENCHMARK_SYMBOL).map((c) => c.id));
  const btc = loaded.inputs.find(
    (i) => ids.has(i.symbol) && barIndex(i, base.from - DAY_MS) !== -1 && barIndex(i, base.to - DAY_MS) !== -1
  );
  if (!btc) return { available: false, note: `no ${BENCHMARK_SYMBOL} contract spans the sample`, alpha: null, beta: null, benchmarkSharpe: null, benchmarkAnnual: null };
  const input: TrendSymbolInput = { ...btc, membership: everyMonth(base.from, base.to) };
  const run = runTrend([input], { [btc.symbol]: constantPaths(btc.t.length, { kind: 'on-signal-change' }) }, base);
  return benchmarkOf(
    tR,
    slice(run.returns, range),
    `${btc.symbol} held at 1x of equity, re-set at each ranking close, broad costs and archive funding`
  );
}

/**
 * Header gate 3, reported: a constant-gross equal-weight long of the members, in
 * the same container: every member at 1x of its sleeve, traded back to 1x at every
 * close (so gross stays at 1 outside cash), capital split equally at each ranking
 * close, delistings as for the rule.
 */
export function memberBasketBenchmark(
  loaded: BroadInputs,
  base: SimOptions,
  range: { first: number; last: number },
  tR: readonly number[]
): Benchmark {
  const paths = Object.fromEntries(loaded.inputs.map((i) => [i.symbol, constantPaths(i.t.length, { kind: 'on-decision' })]));
  const run = runTrend(loaded.inputs, paths, base);
  return benchmarkOf(tR, slice(run.returns, range), 'every member long at 1x of its sleeve, back to 1x at every close, equal capital at each ranking close');
}

/**
 * The 'aligned' null's exposure loss: the mean over its draws of the share of
 * member-days whose source day (d - k on the wrapping calendar) lies outside the
 * contract's bars (C3: outside the basket's days), where the shifted rule holds
 * nothing.
 */
export function outsideLifeShare(
  inputs: readonly TrendSymbolInput[],
  opts: SimOptions,
  shifts: readonly number[],
  calendar: NullCalendar,
  shared?: SharedStatePath
): number {
  const member: Array<{ input: TrendSymbolInput; days: number[] }> = inputs.map((input) => {
    const days: number[] = [];
    for (let d = opts.from; d < opts.to; d += DAY_MS) if (barIndex(input, d) !== -1 && spanAt(input.membership, d)) days.push(d);
    return { input, days };
  });
  const total = member.reduce((s, m) => s + m.days.length, 0);
  if (total === 0 || shifts.length === 0) return Number.NaN;
  const sharedFirst = shared && shared.days.length > 0 ? shared.days[0] : Number.NaN;
  const sharedLast = shared && shared.days.length > 0 ? shared.days[shared.days.length - 1] : Number.NaN;
  let sum = 0;
  for (const k of shifts) {
    let outside = 0;
    for (const { input, days } of member) {
      for (const d of days) {
        const c = Math.round((d - calendar.start) / DAY_MS);
        const source = calendar.start + ((((c - k) % calendar.days) + calendar.days) % calendar.days) * DAY_MS;
        const inLife = shared ? source >= sharedFirst && source <= sharedLast : barIndex(input, source) !== -1;
        if (!inLife) outside++;
      }
    }
    sum += outside / total;
  }
  return sum / shifts.length;
}

/**
 * Header gate 4, null size: one contract's daily close-to-close returns on its real
 * (non-carried) days permuted among those days, prices rebuilt from the first close,
 * each open the previous close; carried days stay carried. No timing survives.
 */
export function permuteReturns(input: TrendSymbolInput, random: () => number): TrendSymbolInput {
  const n = input.t.length;
  const carried = input.carried;
  const positions: number[] = [];
  for (let i = 1; i < n; i++) if (!(carried && carried[i] === 1)) positions.push(i);
  const returns = positions.map((i) => input.close[i] / input.close[i - 1] - 1);
  for (let j = returns.length - 1; j > 0; j--) {
    const k = Math.floor(random() * (j + 1));
    const tmp = returns[j];
    returns[j] = returns[k];
    returns[k] = tmp;
  }
  const close = new Array<number>(n);
  const open = new Array<number>(n);
  if (n > 0) {
    close[0] = input.close[0];
    open[0] = input.open[0];
  }
  let r = 0;
  for (let i = 1; i < n; i++) {
    open[i] = close[i - 1];
    close[i] = carried && carried[i] === 1 ? close[i - 1] : close[i - 1] * (1 + returns[r++]);
  }
  return { ...input, open, close };
}

export interface NullSizeResult {
  universes: number;
  seed: number;
  draws: number;
  perUniverse: Array<{ observedAlpha: number | null; wrappedP: number | null; alignedP: number | null }>;
  rates: { wrapped: number; aligned: number; both: number };
}

function nullOptions(mode: 'wrapped' | 'aligned', calendar: NullCalendar, basket: BroadBasket | null): TimingNullOptions {
  return {
    mode,
    calendarStart: calendar.start,
    calendarDays: calendar.days,
    shared: basket ? { days: basket.days, state: basket.state } : undefined,
  };
}

/** Both common-shift nulls, or null p values when the observed alpha is undefined (the gate then fails). */
function bothNulls(
  inputs: TrendSymbolInput[],
  paths: Record<string, RulePaths>,
  twinReturns: readonly number[],
  observed: number,
  opts: SimOptions,
  range: { first: number; last: number },
  draws: number,
  calendar: NullCalendar,
  basket: BroadBasket | null
): { wrapped: TimingNullResult | null; aligned: TimingNullResult | null } {
  if (!Number.isFinite(observed)) return { wrapped: null, aligned: null };
  const run = (mode: 'wrapped' | 'aligned') =>
    timingNull(inputs, paths, twinReturns, observed, opts, range, draws, BROAD_NULL_SEED, nullOptions(mode, calendar, basket));
  return { wrapped: run('wrapped'), aligned: run('aligned') };
}

/**
 * Header gate 4, reported before the run and not gated: in each of `universes`
 * synthetic universes (seed 11, one stream) every contract's daily returns are
 * permuted (permuteReturns), the rule, its twin and both nulls re-run (seed 7,
 * `draws` each) on the same membership and funding, and each null's rejection rate
 * at 0.05 is reported. C3's basket is rebuilt from the permuted closes.
 */
export function nullSizeCheck(params: {
  rule: TrendRuleId;
  loaded: Pick<BroadInputs, 'inputs' | 'basketInputs' | 'basketMembership'>;
  opts: SimOptions;
  universes: number;
  draws: number;
  calendar?: NullCalendar;
  seed?: number;
}): NullSizeResult {
  const { rule, loaded, opts, universes, draws } = params;
  const calendar = params.calendar ?? DEFAULT_CALENDAR;
  const seed = params.seed ?? NULL_SIZE_SEED;
  const random = createSeededRandom(seed);
  const all = new Map<string, TrendSymbolInput>();
  for (const input of [...loaded.inputs, ...loaded.basketInputs]) all.set(input.symbol, input);
  const ids = [...all.keys()].sort();
  const perUniverse: NullSizeResult['perUniverse'] = [];
  for (let u = 0; u < universes; u++) {
    const permuted = new Map(ids.map((id) => [id, permuteReturns(all.get(id)!, random)]));
    const inputs = loaded.inputs.map((i) => permuted.get(i.symbol)!);
    const basketInputs = loaded.basketInputs.map((i) => permuted.get(i.symbol)!);
    const { paths, basket } = broadRulePaths(rule, { inputs, basketInputs, basketMembership: loaded.basketMembership });
    const pair = runPair(inputs, paths, twinPaths(paths), opts);
    const range = rangeFrom(pair.t.days, firstDefinedMemberDay(inputs, paths, opts.from, opts.to));
    const observed = annualAlpha(slice(pair.t.returns, range), slice(pair.twin.returns, range)).alpha;
    const nulls = bothNulls(inputs, paths, pair.twin.returns, observed, opts, range, draws, calendar, basket);
    perUniverse.push({
      observedAlpha: finiteOrNull(observed),
      wrappedP: nulls.wrapped?.p ?? null,
      alignedP: nulls.aligned?.p ?? null,
    });
  }
  return { universes, seed, draws, perUniverse, rates: rejectionRates(perUniverse) };
}

export interface BroadStudyOptions {
  /** Draws of each timing null (200 pre-registered). */
  draws: number;
  /** Permuted universes of the null-size check (50 pre-registered; 0 skips it). */
  nullSizeUniverses: number;
  /** Draws of each null inside the null-size check; default `draws`. */
  nullSizeDraws?: number;
  /** Bootstrap draws (2,000 pre-registered); tests lower it. */
  bootstrapDraws?: number;
  calendar?: NullCalendar;
  gitCommit?: string;
}

/**
 * The pure core the CLI wraps: one rule through every gate and reported statistic
 * on loaded inputs. Throws on a bar outside the null calendar before computing a
 * return; the null-size check runs first ("reported before the run").
 */
export function runBroadStudy(
  args: { rule: TrendRuleId; taskId: string },
  loaded: BroadInputs,
  options: BroadStudyOptions
): BroadTrendReport {
  const started = Date.now();
  const calendar = options.calendar ?? DEFAULT_CALENDAR;
  const bootstrapDraws = options.bootstrapDraws ?? BROAD_BOOT_DRAWS;
  const nullSizeDraws = options.nullSizeDraws ?? options.draws;
  assertInCalendar([...loaded.inputs, ...loaded.basketInputs], calendar);
  const base = broadOptions(loaded.from, loaded.to);

  const nullSize =
    options.nullSizeUniverses > 0
      ? nullSizeCheck({ rule: args.rule, loaded, opts: base, universes: options.nullSizeUniverses, draws: nullSizeDraws, calendar })
      : null;

  const { paths, basket } = broadRulePaths(args.rule, loaded);
  const twin = twinPaths(paths);
  const main = runPair(loaded.inputs, paths, twin, base);
  const firstDefinedDay = firstDefinedMemberDay(loaded.inputs, paths, base.from, base.to);
  const range = rangeFrom(main.t.days, firstDefinedDay);
  const tR = slice(main.t.returns, range);
  const twinR = slice(main.twin.returns, range);
  const days = slice(main.t.days, range);
  const boot = (blockLen: number) => ({ blockLen, iterations: bootstrapDraws, seed: BROAD_BOOT_SEED });

  // Gates 2 and 3, with the 20 and 120 day blocks reported.
  const sharpe = sharpeCi(tR, boot(BROAD_BLOCK_DAYS));
  const alpha = alphaCi(tR, twinR, boot(BROAD_BLOCK_DAYS));
  const { beta } = annualAlpha(tR, twinR);

  // Gate 4: both common-shift nulls, the larger p gating.
  const nulls = bothNulls(loaded.inputs, paths, main.twin.returns, alpha.point, base, range, options.draws, calendar, basket);
  const shared = basket ? { days: basket.days, state: basket.state } : undefined;
  const timing = {
    wrapped: {
      mode: 'wrapped' as const,
      p: nulls.wrapped?.p ?? null,
      nullMean: finiteOrNull(nulls.wrapped?.nullMean ?? Number.NaN),
      draws: options.draws,
      misalignedShare: finiteOrNull(nulls.wrapped?.misalignedShare ?? Number.NaN),
      outsideLifeShare: null,
    },
    aligned: {
      mode: 'aligned' as const,
      p: nulls.aligned?.p ?? null,
      nullMean: finiteOrNull(nulls.aligned?.nullMean ?? Number.NaN),
      draws: options.draws,
      misalignedShare: nulls.aligned ? 0 : null,
      outsideLifeShare: nulls.aligned ? finiteOrNull(outsideLifeShare(loaded.inputs, base, nulls.aligned.shifts ?? [], calendar, shared)) : null,
    },
  };
  const gatingP = nulls.wrapped && nulls.aligned ? Math.max(nulls.wrapped.p, nulls.aligned.p) : null;

  // Gate 5: drop each listing-year cohort, the legends ten, BTC and ETH, and the top five contributors.
  const contractById = new Map(loaded.contracts.map((c) => [c.id, c]));
  const members = loaded.inputs.map((i) => contractById.get(i.symbol)!);
  const memberDayCount = new Map(loaded.inputs.map((i) => [i.symbol, memberDays(i, base)]));
  const totalMemberDays = [...memberDayCount.values()].reduce((s, n) => s + n, 0);
  const drop = (label: string, ids: readonly string[]) => {
    const set = new Set(ids);
    const rest = loaded.inputs.filter((i) => !set.has(i.symbol));
    const point = pairPoint(runPair(rest, paths, twin, base), range);
    const days = ids.reduce((s, id) => s + (memberDayCount.get(id) ?? 0), 0);
    return {
      label,
      contracts: [...ids].sort(),
      memberDays: days,
      share: totalMemberDays > 0 ? days / totalMemberDays : null,
      alpha: point.alpha,
      beta: point.beta,
    };
  };
  const cohorts = listingYearCohorts(
    members.map((c) => ({ id: c.id, listingYear: c.listingYear, memberDays: memberDayCount.get(c.id) ?? 0 })),
    COHORT_MIN_SHARE
  );
  const listingYears = cohorts.map((c) => ({ ...drop(c.label, c.contracts), years: c.years }));
  const legendsTen = drop('legends ten', contractsOfAssets(members, LEGENDS_TEN_ASSETS));
  const btcEth = drop('BTC and ETH', contractsOfAssets(members, BTC_ETH_ASSETS));
  const contributions = topContributors(main.t.contributions, main.twin.contributions, beta, range);
  const top5 = { ...drop('top five', contributions.map((c) => c.contract)), contributions };

  // Gates 6, 7 and 9.
  const years = yearAlphaBetas(days, tR, twinR, BROAD_REPORT_YEARS);
  const stress = pairPoint(runPair(loaded.inputs, paths, twin, stressOptions(base)), range);
  const stressHaircut5 = pairPoint(runPair(loaded.inputs, paths, twin, stressOptions(base, STRESS_REPORTED_HAIRCUT)), range);
  const ex2021 = windowAlpha(days, tR, twinR, EX2021_FROM, EX2021_TO);

  // Reported, not gated.
  const delay1 = pairPoint(runPair(loaded.inputs, paths, twin, { ...base, delay: 1 }), range);
  const benchmarks = {
    btc: btcBenchmark(loaded, base, range, tR),
    memberBasket: memberBasketBenchmark(loaded, base, range, tR),
  };
  const detail = main.t.broad!;
  const dayIndex = new Map(main.t.days.map((d, k) => [d, k]));
  const membersPerMonth = loaded.universe.universe.months
    .filter((m) => m.closeMs >= base.from && m.closeMs < base.to)
    .map((m) => {
      const k = dayIndex.get(m.closeMs)!;
      return {
        close: m.close,
        eligible: m.eligibleCount,
        members: m.members.length,
        live: detail.members[k],
        cashShare: finiteOrNull(detail.cash[k]),
      };
    });
  const delistings = detail.delistings.map((d) => ({
    contract: d.symbol,
    day: d.day,
    qty: d.qty,
    close: d.close,
    exitPrice: d.exitPrice,
    haircut: d.haircut,
    fee: d.fee,
    dayContribution: main.t.contributions[d.symbol][dayIndex.get(d.day)!],
  }));
  const leaves = {
    count: detail.leaves.length,
    traded: detail.leaves.reduce((s, l) => s + l.traded, 0),
    cost: detail.leaves.reduce((s, l) => s + l.cost, 0),
  };
  const carriedDays = Object.fromEntries(members.filter((c) => c.carriedDays > 0).map((c) => [c.id, c.carriedDays]));

  const gates = evaluateBroadGates({
    sampleDays: tR.length,
    startLaterThan20210701: loaded.universe.universe.startLaterThan20210701,
    sharpeCiLow: sharpe.low,
    alphaCiLow: alpha.low,
    wrappedP: nulls.wrapped?.p ?? Number.NaN,
    alignedP: nulls.aligned?.p ?? Number.NaN,
    drops: [...listingYears, legendsTen, btcEth, top5].map((d) => ({ label: d.label, alpha: d.alpha ?? Number.NaN })),
    yearAlphas: years.map((y) => ({ year: y.year, alpha: y.alpha })),
    stressAlpha: stress.alpha ?? Number.NaN,
    ex2021Alpha: ex2021.alpha,
  });

  const report: BroadTrendReport = {
    schemaVersion: 2,
    phase: 'broad-trend',
    taskId: args.taskId,
    rule: args.rule,
    datasetManifestHash: loaded.datasetHash,
    universe: {
      sha256: loaded.universe.sha256,
      sourceDatasetHash: loaded.universe.sourceDatasetHash,
      startClose: loaded.universe.universe.startClose!,
      startLaterThan20210701: loaded.universe.universe.startLaterThan20210701,
      contracts: loaded.inputs.length,
      basketContracts: loaded.basketInputs.length,
    },
    lockboxApplied: loaded.lockboxApplied,
    parameters: {
      from: base.from,
      to: base.to,
      fee: BROAD_FEE.fee,
      slippageTiers: SLIPPAGE_TIERS.map((t) => ({ maxRank: t.maxRank, bps: t.bps })),
      leaveSlippage: LEAVE_SLIPPAGE,
      delistHaircut: DELIST_HAIRCUT,
      stress: {
        feeMultiple: STRESS_FEE_MULTIPLE,
        slippageMultiple: 2,
        delistHaircut: stressBroad(BROAD_COST).delistHaircut,
        reportedHaircut: STRESS_REPORTED_HAIRCUT,
      },
      blockDays: BROAD_BLOCK_DAYS,
      blockSensitivity: [...BROAD_BLOCK_SENSITIVITY],
      bootstrapDraws,
      bootstrapSeed: BROAD_BOOT_SEED,
      nullDraws: options.draws,
      nullSeed: BROAD_NULL_SEED,
      nullCalendarStart: calendar.start,
      nullCalendarDays: calendar.days,
      nullSizeUniverses: options.nullSizeUniverses,
      nullSizeSeed: NULL_SIZE_SEED,
      nullSizeDraws,
      minSampleDays: BROAD_MIN_SAMPLE_DAYS,
      timingP: BROAD_TIMING_P,
      minPositiveYearShare: BROAD_MIN_POSITIVE_YEAR_SHARE,
      gatedYears: [...BROAD_GATED_YEARS],
      cohortMinShare: COHORT_MIN_SHARE,
      ex2021From: EX2021_FROM,
      ex2021To: EX2021_TO,
    },
    sample: {
      from: base.from,
      to: base.to,
      firstDefinedDay,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      days: days.length,
    },
    run: summarise(main.t, range),
    twin: summarise(main.twin, range),
    sharpe: ciJson(sharpe),
    sharpeBlock20: ciJson(sharpeCi(tR, boot(BROAD_BLOCK_SENSITIVITY[0]))),
    sharpeBlock120: ciJson(sharpeCi(tR, boot(BROAD_BLOCK_SENSITIVITY[1]))),
    sharpeDifference: finiteOrNull(sharpe.point - annualisedSharpe(twinR)),
    alpha: ciJson(alpha),
    alphaBlock20: ciJson(alphaCi(tR, twinR, boot(BROAD_BLOCK_SENSITIVITY[0]))),
    alphaBlock120: ciJson(alphaCi(tR, twinR, boot(BROAD_BLOCK_SENSITIVITY[1]))),
    beta: finiteOrNull(beta),
    benchmarks,
    timing: { ...timing, gatingP },
    nullSize: nullSize
      ? {
          universes: nullSize.universes,
          seed: nullSize.seed,
          draws: nullSize.draws,
          wrappedRejection: finiteOrNull(nullSize.rates.wrapped),
          alignedRejection: finiteOrNull(nullSize.rates.aligned),
          bothRejection: finiteOrNull(nullSize.rates.both),
          perUniverse: nullSize.perUniverse,
        }
      : null,
    cohorts: { listingYears, legendsTen, btcEth, top5 },
    years: years.map((y) => ({ year: y.year, alpha: finiteOrNull(y.alpha), beta: finiteOrNull(y.beta), days: y.days })),
    stress,
    stressHaircut5,
    ex2021: { from: EX2021_FROM, to: EX2021_TO, days: ex2021.days, alpha: finiteOrNull(ex2021.alpha), beta: finiteOrNull(ex2021.beta) },
    delay1,
    membersPerMonth,
    delistings,
    leaves,
    funding: loaded.funding,
    fundingResolutions: loaded.fundingResolutions,
    carriedDays,
    gates,
    verdict: broadVerdict(gates),
    daily: { days, returns: tR },
    computedAt: new Date().toISOString(),
    gitCommit: options.gitCommit ?? 'unknown',
    durationMs: Date.now() - started,
  };

  const validated = validateBroadTrendReport(report);
  if (!validated.ok) throw new Error(`Broad report failed its schema: ${validated.issues.join('; ')}`);
  return validated.data;
}

const pct = (v: number | null, digits = 2) => (v === null ? '-' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null, digits = 2) => (v === null ? '-' : v.toFixed(digits));

export function formatBroad(r: BroadTrendReport): string {
  const lines: string[] = [];
  lines.push(
    `${r.rule}: ${r.universe.contracts} member contracts (${r.universe.basketContracts} in the basket), ` +
      `${r.sample.firstDay === null ? '-' : isoDay(r.sample.firstDay)} to ${r.sample.lastDay === null ? '-' : isoDay(r.sample.lastDay)} ` +
      `(${r.sample.days} days), lockbox ${r.lockboxApplied}, export ${r.datasetManifestHash.slice(0, 12)}, universe ${r.universe.sha256.slice(0, 12)}`
  );
  lines.push(
    `T   Sharpe ${num(r.sharpe.point)} CI [${num(r.sharpe.low)}, ${num(r.sharpe.high)}]  annual ${pct(r.run.annualReturn)}  ` +
      `long ${pct(r.run.longLegAnnual)} short ${pct(r.run.shortLegAnnual)} cost ${pct(r.run.costAnnual)} funding ${pct(r.run.fundingAnnual)}  ` +
      `maxDD ${pct(r.run.maxDrawdown, 1)} turnover ${num(r.run.turnoverAnnual, 1)}x gross ${num(r.run.gross.mean)}`
  );
  lines.push(`T+  Sharpe ${num(r.twin.sharpe)}  annual ${pct(r.twin.annualReturn)}  maxDD ${pct(r.twin.maxDrawdown, 1)}`);
  lines.push(
    `alpha ${pct(r.alpha.point)} CI [${pct(r.alpha.low)}, ${pct(r.alpha.high)}] beta ${num(r.beta)}; ` +
      `vs BTC ${pct(r.benchmarks.btc.alpha)} (beta ${num(r.benchmarks.btc.beta)}); vs members ${pct(r.benchmarks.memberBasket.alpha)} (beta ${num(r.benchmarks.memberBasket.beta)})`
  );
  lines.push(
    `timing wrapped p ${num(r.timing.wrapped.p, 3)} (misaligned ${num(r.timing.wrapped.misalignedShare, 3)}), ` +
      `aligned p ${num(r.timing.aligned.p, 3)} (outside life ${num(r.timing.aligned.outsideLifeShare, 3)}); ` +
      `null size ${r.nullSize ? `wrapped ${num(r.nullSize.wrappedRejection, 3)} aligned ${num(r.nullSize.alignedRejection, 3)} both ${num(r.nullSize.bothRejection, 3)} over ${r.nullSize.universes}` : 'not run'}`
  );
  const drops = [...r.cohorts.listingYears, r.cohorts.legendsTen, r.cohorts.btcEth, r.cohorts.top5];
  lines.push(`drops ${drops.map((d) => `${d.label} ${pct(d.alpha, 1)}`).join(', ')}`);
  lines.push(`years ${r.years.map((y) => `${y.year} ${pct(y.alpha, 1)}`).join(', ')}`);
  lines.push(
    `stress ${pct(r.stress.alpha)} (5% haircut ${pct(r.stressHaircut5.alpha)}); ex-2021 ${pct(r.ex2021.alpha)}; ` +
      `delay 1 ${pct(r.delay1.alpha)} Sharpe ${num(r.delay1.sharpe)}; delistings ${r.delistings.length}, leaves ${r.leaves.count}`
  );
  lines.push(`gates ${r.gates.map((g) => `${g.id} ${g.name} ${g.pass === null ? 'PENDING' : g.pass ? 'pass' : 'FAIL'}`).join(', ')}`);
  lines.push(`VERDICT ${r.verdict}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadBroadInputs(args.datasetDir, args.universeFile, {
    fundingResolutionsPath: args.fundingResolutions,
    fundingCheckOut: args.fundingCheckOut,
  });
  const report = runBroadStudy(args, loaded, {
    draws: args.draws,
    nullSizeUniverses: args.nullSizeUniverses,
    gitCommit: resolveCommit(),
  });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(formatBroad(report));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
