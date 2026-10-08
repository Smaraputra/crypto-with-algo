/**
 * The legends phase's gate 8, computed ONCE across all eleven pre-registered
 * trials in one unit (header of trend-sim.ts, "PHASE BUDGET"):
 *
 *   each trial is the annualised Sharpe of a DAILY return series --
 *     trend rules (TF1 to TF4, C3): the PRIMARY portfolio's daily returns
 *       (trend-harness.ts reports carry them);
 *     harness rules (P1 to P4, C1, C2): realised trade PnL booked on the exit
 *       day, per unit of notional (pnlPercent / 100), each symbol a sleeve,
 *       the sleeves equal-weighted over the symbols evaluating that day;
 *   the variance of the eleven per-period Sharpes feeds the expected maximum
 *   Sharpe at N = 11 (Bailey and Lopez de Prado), and a trial passes gate 8
 *   when its deflated Sharpe probability is at least 0.95. The same
 *   probability at the program's trial count (1,724) is reported, never gated
 *   (user ruling 2026-10-01; agy dissents).
 *
 * The final verdict per trial: a trend rule passes when its report reads
 * 'pending-trials' (every other gate passed) and gate 8 passes; a harness rule
 * when every one of its eight gates but `trials` (vacuous with one cell, M5)
 * passes, its perp CONSISTENCY run's pooled expectancy has the same sign, and
 * gate 8 passes. Any pass is PROVISIONAL (survivor universe) and is the only
 * thing that unlocks a lockbox read.
 *
 * Usage:
 *   npx tsx scripts/research/legends-dsr.ts --trend a.json,b.json,... --harness c.json,... \
 *     --consistency d.json,... [--out data/research/reports/legends-gate8.json]
 *
 * Parameterised for the broad trend phase (Gate8Options: trial ids, N, program
 * count, variance mode); the defaults, LEGENDS_GATE8, are the legends rule above
 * and reproduce its record exactly (legends-dsr.test.ts). BROAD_GATE8 and the
 * schema v2 reader serve broad-dsr.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { deflatedSharpe, expectedMaxSharpe, perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { sampleKurtosis, sampleSkewness } from '@/lib/stats/normal';
import {
  validateBroadTrendReport,
  validateStrategyReport,
  validateTrendReport,
  type BroadTrendReport,
  type StrategyReport,
  type TrendReport,
} from './report-schema';
import { BROAD_PHASE_TRIALS, BROAD_PROGRAM_TRIALS, BROAD_TRIAL_IDS } from './broad-gates';

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365;
export const PHASE_TRIALS = 11;
export const PROGRAM_TRIALS = 1724;
export const DSR_MIN = 0.95;

/** The pre-registered trial ids and the report field that names each. */
export const TREND_TRIALS = ['TF1', 'TF2', 'TF3', 'TF4', 'C3'] as const;
export const HARNESS_TRIALS: Record<string, string> = {
  'turtle-s2': 'P1',
  nr7: 'P2',
  'holy-grail': 'P3',
  'turtle-soup-plus-one': 'P4',
  'bollinger-breakout': 'C1',
  'rsi70-breakout': 'C2',
};

export interface TrialSeries {
  id: string;
  kind: 'trend' | 'harness';
  days: number[];
  returns: number[];
}

/**
 * A harness rule's daily series: each symbol's trades booked on their exit
 * day (pnlPercent / 100), summed per day; the day's return the mean over the
 * symbols whose evaluation has started. Days run from the earliest evaluation
 * start to the last evaluated day.
 */
export function harnessDailySeries(report: StrategyReport, lastDay: number): { days: number[]; returns: number[] } {
  const fixed = report.fixedEvaluation;
  if (!fixed) throw new Error(`${report.family}: not a fixed-evaluation report`);
  const dayOf = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;
  const starts = report.perSymbol.map((s) => dayOf(fixed.perSymbol[s.symbol].evalStartTime));
  const first = Math.min(...starts);
  const days: number[] = [];
  for (let d = first; d <= lastDay; d += DAY_MS) days.push(d);
  const index = new Map(days.map((d, k) => [d, k]));
  const sums = report.perSymbol.map(() => new Float64Array(days.length));
  report.perSymbol.forEach((s, j) => {
    for (const w of s.windows) {
      for (const t of w.trades ?? []) {
        const k = index.get(dayOf(t.exitTime));
        if (k !== undefined) sums[j][k] += t.pnlPercent / 100;
      }
    }
  });
  const returns = days.map((d, k) => {
    let total = 0;
    let live = 0;
    report.perSymbol.forEach((_, j) => {
      if (starts[j] <= d) {
        total += sums[j][k];
        live++;
      }
    });
    return live > 0 ? total / live : 0;
  });
  return { days, returns };
}

export interface TrialResult {
  id: string;
  kind: 'trend' | 'harness';
  days: number;
  annualSharpe: number;
  perPeriodSharpe: number;
  skewness: number;
  kurtosis: number;
  dsrPhase: number;
  dsrProgram: number;
  gate8: boolean;
  otherGates: boolean;
  consistency: boolean | null;
  verdict: 'pass (provisional)' | 'fail';
  note: string;
}

export interface Gate8Result {
  trials: number;
  varianceOfPerPeriodSharpes: number;
  expectedMaxAnnualSharpePhase: number;
  expectedMaxAnnualSharpeProgram: number;
  results: TrialResult[];
}

/**
 * Where V, the variance behind the expected maximum Sharpe, comes from:
 *   - 'cross-trial' (the legends rule): the sample variance of the trials' per-period Sharpes;
 *   - 'max-cross-sampling' (broad-trend.ts header, gate 8): the larger of that and the null floor
 *     1 / (T - 1), the sampling variance of a per-period Sharpe over T periods.
 */
export type VarianceMode = 'cross-trial' | 'max-cross-sampling';

export interface Gate8Options {
  /** The trial ids the series must be, in any order; null checks the count alone (the legends default). */
  trialIds: readonly string[] | null;
  /** N, the trial count the expected maximum is taken over. */
  numTrials: number;
  /** The program-level trial count, reported beside, never gated. */
  programTrials: number;
  varianceMode: VarianceMode;
  /** T of the floor in 'max-cross-sampling'; when absent, the shortest series. */
  floorObservations?: number;
}

/** The legends phase's gate 8, the defaults: N = 11, program 1,724, cross-trial variance. */
export const LEGENDS_GATE8: Gate8Options = {
  trialIds: null,
  numTrials: PHASE_TRIALS,
  programTrials: PROGRAM_TRIALS,
  varianceMode: 'cross-trial',
};

/** One trial's inputs to gate 8: its per-period Sharpe and moments over its own series. */
export interface TrialStats {
  id: string;
  kind: 'trend' | 'harness';
  /** Periods in the trial's series. */
  n: number;
  perPeriodSharpe: number;
  skewness: number;
  kurtosis: number;
}

export function trialStats(s: TrialSeries): TrialStats {
  return {
    id: s.id,
    kind: s.kind,
    n: s.returns.length,
    perPeriodSharpe: perPeriodSharpe(s.returns),
    skewness: sampleSkewness(s.returns),
    kurtosis: sampleKurtosis(s.returns),
  };
}

export interface Gate8Variance {
  mode: VarianceMode;
  /** Sample variance of the trials' per-period Sharpes. */
  crossTrial: number;
  /** 1 / (T - 1) in 'max-cross-sampling', else null. */
  floor: number | null;
  floorObservations: number | null;
  /** The V used. */
  used: number;
}

/** V from the trials' per-period Sharpes (VarianceMode). */
export function gate8Variance(sharpes: readonly number[], mode: VarianceMode, floorObservations: number | null): Gate8Variance {
  const mean = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
  const crossTrial = sharpes.reduce((a, b) => a + (b - mean) ** 2, 0) / (sharpes.length - 1);
  if (mode === 'cross-trial') return { mode, crossTrial, floor: null, floorObservations: null, used: crossTrial };
  if (floorObservations === null || !Number.isInteger(floorObservations) || floorObservations < 2) {
    throw new Error(`the sampling floor needs T >= 2 observations; got ${floorObservations}`);
  }
  const floor = 1 / (floorObservations - 1);
  return { mode, crossTrial, floor, floorObservations, used: Math.max(crossTrial, floor) };
}

function resolveOptions(options: Partial<Gate8Options>): Gate8Options {
  return { ...LEGENDS_GATE8, ...options };
}

function checkTrialSet(ids: readonly string[], options: Gate8Options): void {
  if (options.trialIds === null) {
    if (ids.length !== options.numTrials) {
      throw new Error(`gate 8 is computed once across all ${options.numTrials} trials; got ${ids.length}`);
    }
    return;
  }
  const got = [...ids].sort();
  const expected = [...options.trialIds].sort();
  if (got.join(',') !== expected.join(',')) {
    throw new Error(`gate 8 is computed once across the trials ${expected.join(',')}; got ${got.join(',')}`);
  }
}

/**
 * Gate 8 from each trial's statistics: V (Gate8Options.varianceMode), the
 * expected maximum per-period Sharpe at N, and each trial's deflated Sharpe
 * probability with its own length, skewness and kurtosis; the same at the
 * program count is reported. computeGate8 is this on the series' statistics.
 */
export function gate8FromStats(
  stats: readonly TrialStats[],
  otherGates: Record<string, { pass: boolean; consistency: boolean | null; note: string }>,
  options: Partial<Gate8Options> = {}
): { result: Gate8Result; variance: Gate8Variance } {
  const opts = resolveOptions(options);
  checkTrialSet(
    stats.map((s) => s.id),
    opts
  );
  const sharpes = stats.map((s) => s.perPeriodSharpe);
  const floorT = opts.varianceMode === 'cross-trial' ? null : (opts.floorObservations ?? Math.min(...stats.map((s) => s.n)));
  const v = gate8Variance(sharpes, opts.varianceMode, floorT);
  const variance = v.used;
  const results = stats.map((s, i) => {
    const { skewness, kurtosis } = s;
    const at = (numTrials: number) =>
      deflatedSharpe({
        observedSharpe: sharpes[i],
        numTrials,
        varianceOfTrialSharpes: variance,
        nObservations: s.n,
        skewness,
        kurtosis,
      }).probability;
    const dsrPhase = at(opts.numTrials);
    const gate8 = dsrPhase >= DSR_MIN;
    const other = otherGates[s.id];
    // A harness rule needs its perp CONSISTENCY run to agree; a missing run is not a pass.
    const consistent = s.kind === 'harness' ? other.consistency === true : other.consistency !== false;
    const pass = other.pass && consistent && gate8;
    return {
      id: s.id,
      kind: s.kind,
      days: s.n,
      annualSharpe: sharpes[i] * Math.sqrt(YEAR_DAYS),
      perPeriodSharpe: sharpes[i],
      skewness,
      kurtosis,
      dsrPhase,
      dsrProgram: at(opts.programTrials),
      gate8,
      otherGates: other.pass,
      consistency: other.consistency,
      verdict: pass ? ('pass (provisional)' as const) : ('fail' as const),
      note: other.note,
    };
  });
  return {
    result: {
      trials: opts.numTrials,
      varianceOfPerPeriodSharpes: variance,
      expectedMaxAnnualSharpePhase: expectedMaxSharpe(opts.numTrials, variance) * Math.sqrt(YEAR_DAYS),
      expectedMaxAnnualSharpeProgram: expectedMaxSharpe(opts.programTrials, variance) * Math.sqrt(YEAR_DAYS),
      results,
    },
    variance: v,
  };
}

/** gate8FromStats with the variance detail, from the daily series. */
export function computeGate8Detailed(
  series: TrialSeries[],
  otherGates: Record<string, { pass: boolean; consistency: boolean | null; note: string }>,
  options: Partial<Gate8Options> = {}
): { result: Gate8Result; variance: Gate8Variance } {
  checkTrialSet(
    series.map((s) => s.id),
    resolveOptions(options)
  );
  return gate8FromStats(series.map(trialStats), otherGates, options);
}

/** Gate 8 across the trials' daily series; the defaults are the legends phase's (LEGENDS_GATE8). */
export function computeGate8(
  series: TrialSeries[],
  otherGates: Record<string, { pass: boolean; consistency: boolean | null; note: string }>,
  options: Partial<Gate8Options> = {}
): Gate8Result {
  return computeGate8Detailed(series, otherGates, options).result;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listFlag(flags: Map<string, string>, key: string): string[] {
  return (flags.get(key) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadTrials(
  trendPaths: string[],
  harnessPaths: string[],
  consistencyPaths: string[]
): { series: TrialSeries[]; other: Record<string, { pass: boolean; consistency: boolean | null; note: string }> } {
  const series: TrialSeries[] = [];
  const other: Record<string, { pass: boolean; consistency: boolean | null; note: string }> = {};
  let lastDay = -Infinity;

  const trends: TrendReport[] = trendPaths.map((p) => {
    const v = validateTrendReport(readJson(p));
    if (!v.ok) throw new Error(`${p}: ${v.issues.join('; ')}`);
    return v.data;
  });
  for (const r of trends) {
    series.push({ id: r.rule, kind: 'trend', days: r.daily.days, returns: r.daily.returns });
    lastDay = Math.max(lastDay, r.daily.days[r.daily.days.length - 1]);
    const failed = r.gates.filter((g) => g.pass === false).map((g) => g.name);
    other[r.rule] = {
      pass: r.verdict === 'pending-trials',
      consistency: null,
      note: failed.length > 0 ? `failed gates ${failed.join(', ')}` : 'every gate but 8 passed',
    };
  }

  const consistency = new Map<string, StrategyReport>();
  for (const p of consistencyPaths) {
    const v = validateStrategyReport(readJson(p));
    if (!v.ok) throw new Error(`${p}: ${v.issues.join('; ')}`);
    consistency.set(v.data.family, v.data);
  }
  for (const p of harnessPaths) {
    const v = validateStrategyReport(readJson(p));
    if (!v.ok) throw new Error(`${p}: ${v.issues.join('; ')}`);
    const r = v.data;
    const id = HARNESS_TRIALS[r.family];
    if (!id) throw new Error(`${p}: family ${r.family} is not a legends trial`);
    const { days, returns } = harnessDailySeries(r, Number.isFinite(lastDay) ? lastDay : Date.UTC(2026, 5, 30));
    series.push({ id, kind: 'harness', days, returns });
    const failed = r.gates.filter((g) => g.name !== 'trials' && !g.pass).map((g) => g.name);
    const cons = consistency.get(r.family);
    const primarySign = Math.sign(r.pooled.expectancyPercent ?? 0);
    const consSign = cons ? Math.sign(cons.pooled.expectancyPercent ?? 0) : null;
    const consistent = consSign === null ? null : consSign === primarySign && primarySign !== 0;
    other[id] = {
      pass: failed.length === 0,
      consistency: consistent,
      note:
        (failed.length > 0 ? `failed gates ${failed.join(', ')}` : 'every gate but trials passed') +
        (cons ? `; perp expectancy ${(cons.pooled.expectancyPercent ?? Number.NaN).toFixed(4)}%` : '; no consistency run'),
    };
  }

  const ids = series.map((s) => s.id).sort();
  const expected = [...TREND_TRIALS, ...Object.values(HARNESS_TRIALS)].sort();
  if (ids.join(',') !== expected.join(',')) {
    throw new Error(`expected the eleven pre-registered trials ${expected.join(',')}, got ${ids.join(',')}`);
  }
  return { series, other };
}

/**
 * The broad trend phase's gate 8 (broad-trend.ts header): N = 16 (the eleven
 * legends trials plus these five), V the larger of the five per-period Sharpes'
 * sample variance and 1 / (T - 1) with T the shortest of the five series, the
 * program count 1,729 reported beside.
 */
export const BROAD_GATE8: Gate8Options = {
  trialIds: BROAD_TRIAL_IDS,
  numTrials: BROAD_PHASE_TRIALS,
  programTrials: BROAD_PROGRAM_TRIALS,
  varianceMode: 'max-cross-sampling',
};

export interface BroadTrials {
  series: TrialSeries[];
  other: Record<string, { pass: boolean; consistency: boolean | null; note: string }>;
  datasetManifestHash: string;
  universeSha256: string;
}

/**
 * The five broad reports (schema v2) as gate 8 trials. Refuses a report that
 * fails its schema, a missing or repeated rule, and reports from different
 * exports or universes. A trial's other gates pass when its verdict is
 * 'pending-trials' (every gate but 8 passed); ex-2021 is one of those gates.
 */
export function broadTrialsFrom(reports: readonly unknown[], labels: readonly string[] = []): BroadTrials {
  const parsed: BroadTrendReport[] = reports.map((json, k) => {
    const v = validateBroadTrendReport(json);
    if (!v.ok) throw new Error(`${labels[k] ?? `report ${k}`}: ${v.issues.join('; ')}`);
    return v.data;
  });
  const hashes = new Set(parsed.map((r) => r.datasetManifestHash));
  const universes = new Set(parsed.map((r) => r.universe.sha256));
  if (hashes.size !== 1) throw new Error(`the broad reports come from ${hashes.size} exports: ${[...hashes].join(', ')}`);
  if (universes.size !== 1) throw new Error(`the broad reports come from ${universes.size} universes: ${[...universes].join(', ')}`);
  const series: TrialSeries[] = [];
  const other: BroadTrials['other'] = {};
  for (const r of parsed) {
    if (other[r.rule]) throw new Error(`two reports for ${r.rule}`);
    series.push({ id: r.rule, kind: 'trend', days: r.daily.days, returns: r.daily.returns });
    const failed = r.gates.filter((g) => g.pass === false).map((g) => g.name);
    other[r.rule] = {
      pass: r.verdict === 'pending-trials',
      consistency: null,
      note: failed.length > 0 ? `failed gates ${failed.join(', ')}` : 'every gate but 8 passed',
    };
  }
  checkTrialSet(
    series.map((s) => s.id),
    BROAD_GATE8
  );
  return { series, other, datasetManifestHash: [...hashes][0], universeSha256: [...universes][0] };
}

/** Reads the five broad reports from disk (broadTrialsFrom). */
export function loadBroadTrials(paths: readonly string[]): BroadTrials {
  return broadTrialsFrom(
    paths.map((p) => readJson(p)),
    paths
  );
}

export function formatGate8(g: Gate8Result, options: Partial<Gate8Options> = {}): string {
  const opts = resolveOptions(options);
  const lines = [
    `gate 8 across ${g.trials} trials: variance of per-period Sharpes ${g.varianceOfPerPeriodSharpes.toExponential(3)}, ` +
      `expected max annual Sharpe ${g.expectedMaxAnnualSharpePhase.toFixed(3)} at N = ${opts.numTrials}, ` +
      `${g.expectedMaxAnnualSharpeProgram.toFixed(3)} at N = ${opts.programTrials}`,
  ];
  for (const r of g.results) {
    lines.push(
      `${r.id.padEnd(4)} ${r.kind.padEnd(7)} Sharpe ${r.annualSharpe.toFixed(3).padStart(7)}  DSR ${r.dsrPhase.toFixed(3)} ` +
        `(program ${r.dsrProgram.toFixed(3)})  gate8 ${r.gate8 ? 'pass' : 'FAIL'}  others ${r.otherGates ? 'pass' : 'FAIL'}  ` +
        `consistency ${r.consistency === null ? '-' : r.consistency ? 'pass' : 'FAIL'}  ${r.verdict.toUpperCase()}  (${r.note})`
    );
  }
  return lines.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || argv[i + 1] === undefined) throw new Error(`Bad argument ${key}`);
    if (!['--trend', '--harness', '--consistency', '--out'].includes(key)) throw new Error(`Unknown flag ${key}`);
    flags.set(key.slice(2), argv[i + 1]);
  }
  const { series, other } = loadTrials(listFlag(flags, 'trend'), listFlag(flags, 'harness'), listFlag(flags, 'consistency'));
  const result = computeGate8(series, other);
  const out = flags.get('out') ?? 'data/research/reports/legends-gate8.json';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...result, computedAt: new Date().toISOString() }, null, 2));
  console.log(formatGate8(result));
}

if (require.main === module) {
  main();
}
