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
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { deflatedSharpe, expectedMaxSharpe, perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { sampleKurtosis, sampleSkewness } from '@/lib/stats/normal';
import { validateStrategyReport, validateTrendReport, type StrategyReport, type TrendReport } from './report-schema';

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

export function computeGate8(
  series: TrialSeries[],
  otherGates: Record<string, { pass: boolean; consistency: boolean | null; note: string }>
): Gate8Result {
  if (series.length !== PHASE_TRIALS) {
    throw new Error(`gate 8 is computed once across all ${PHASE_TRIALS} trials; got ${series.length}`);
  }
  const sharpes = series.map((s) => perPeriodSharpe(s.returns));
  const mean = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
  const variance = sharpes.reduce((a, b) => a + (b - mean) ** 2, 0) / (sharpes.length - 1);
  const results = series.map((s, i) => {
    const skewness = sampleSkewness(s.returns);
    const kurtosis = sampleKurtosis(s.returns);
    const at = (numTrials: number) =>
      deflatedSharpe({
        observedSharpe: sharpes[i],
        numTrials,
        varianceOfTrialSharpes: variance,
        nObservations: s.returns.length,
        skewness,
        kurtosis,
      }).probability;
    const dsrPhase = at(PHASE_TRIALS);
    const gate8 = dsrPhase >= DSR_MIN;
    const other = otherGates[s.id];
    const pass = other.pass && other.consistency !== false && gate8;
    return {
      id: s.id,
      kind: s.kind,
      days: s.returns.length,
      annualSharpe: sharpes[i] * Math.sqrt(YEAR_DAYS),
      perPeriodSharpe: sharpes[i],
      skewness,
      kurtosis,
      dsrPhase,
      dsrProgram: at(PROGRAM_TRIALS),
      gate8,
      otherGates: other.pass,
      consistency: other.consistency,
      verdict: pass ? ('pass (provisional)' as const) : ('fail' as const),
      note: other.note,
    };
  });
  return {
    trials: PHASE_TRIALS,
    varianceOfPerPeriodSharpes: variance,
    expectedMaxAnnualSharpePhase: expectedMaxSharpe(PHASE_TRIALS, variance) * Math.sqrt(YEAR_DAYS),
    expectedMaxAnnualSharpeProgram: expectedMaxSharpe(PROGRAM_TRIALS, variance) * Math.sqrt(YEAR_DAYS),
    results,
  };
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

export function formatGate8(g: Gate8Result): string {
  const lines = [
    `gate 8 across ${g.trials} trials: variance of per-period Sharpes ${g.varianceOfPerPeriodSharpes.toExponential(3)}, ` +
      `expected max annual Sharpe ${g.expectedMaxAnnualSharpePhase.toFixed(3)} at N = ${PHASE_TRIALS}, ` +
      `${g.expectedMaxAnnualSharpeProgram.toFixed(3)} at N = ${PROGRAM_TRIALS}`,
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
