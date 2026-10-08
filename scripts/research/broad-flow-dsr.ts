/**
 * The broad flow phase's gate 7 (broad-flow.ts header, GATES 7), computed ONCE across the three trial reports
 * DO, W and WO (schema v3, broad-flow-harness.ts):
 *
 *   SR* = sqrt(V) x ((1 - g) x InvPhi(1 - 1/N) + g x InvPhi(1 - 1/(N e))) at N = 3, every quantity per period
 *   (daily); V = the larger of the sample variance of the three per-period Sharpes and the null floor 1 / (T - 1),
 *   T the shortest of the three daily series; each trial's probabilistic Sharpe uses its own length, skewness and
 *   kurtosis; a trial passes at 0.95. The same at the program count 1,732 is reported, never gated.
 *
 * The control D is not a trial and is refused. A trial's verdict: every other gate passed (its report reads
 * 'pending-trials') and gate 7 passes. A pass gets the lockbox read once; nothing else (implementation note F15).
 *
 * Usage:
 *   npx tsx scripts/research/broad-flow-dsr.ts --reports do.json,w.json,wo.json --out broad-flow-gate7.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { FLOW_TRIAL_IDS } from './broad-flow';
import { FLOW_PHASE_TRIALS, FLOW_PROGRAM_TRIALS } from './broad-flow-gates';
import {
  computeGate8Detailed,
  formatGate8,
  type Gate8Options,
  type Gate8Result,
  type Gate8Variance,
  type TrialSeries,
} from './legends-dsr';
import { validateBroadFlowReport, type BroadFlowReport } from './report-schema';

/** Header gate 7: N = 3 over DO, W and WO, the program count 1,732 beside, V = max(cross-trial, 1 / (T - 1)). */
export const FLOW_GATE7: Gate8Options = {
  trialIds: FLOW_TRIAL_IDS,
  numTrials: FLOW_PHASE_TRIALS,
  programTrials: FLOW_PROGRAM_TRIALS,
  varianceMode: 'max-cross-sampling',
};

export interface FlowTrials {
  series: TrialSeries[];
  other: Record<string, { pass: boolean; consistency: boolean | null; note: string }>;
  datasetManifestHash: string;
  universeSha256: string;
}

/**
 * The three trial reports as gate 7 trials. Refuses a report that fails its schema, the control D, a missing or
 * repeated trial, and reports from different exports or universes. A trial's other gates pass when its verdict is
 * 'pending-trials' (every gate but 7 passed).
 */
export function flowTrialsFrom(reports: readonly unknown[], labels: readonly string[] = []): FlowTrials {
  const parsed: BroadFlowReport[] = reports.map((json, k) => {
    const v = validateBroadFlowReport(json);
    if (!v.ok) throw new Error(`${labels[k] ?? `report ${k}`}: ${v.issues.join('; ')}`);
    if (v.data.role !== 'trial') throw new Error(`${labels[k] ?? `report ${k}`}: ${v.data.rule} is the control, not a trial`);
    return v.data;
  });
  const hashes = new Set(parsed.map((r) => r.datasetManifestHash));
  const universes = new Set(parsed.map((r) => r.universe.sha256));
  if (hashes.size !== 1) throw new Error(`the flow reports come from ${hashes.size} exports: ${[...hashes].join(', ')}`);
  if (universes.size !== 1) throw new Error(`the flow reports come from ${universes.size} universes: ${[...universes].join(', ')}`);
  const series: TrialSeries[] = [];
  const other: FlowTrials['other'] = {};
  for (const r of parsed) {
    if (other[r.rule]) throw new Error(`two reports for ${r.rule}`);
    series.push({ id: r.rule, kind: 'trend', days: r.daily.days, returns: r.daily.returns });
    const failed = r.gates.filter((g) => g.pass === false).map((g) => g.name);
    other[r.rule] = {
      pass: r.verdict === 'pending-trials',
      consistency: null,
      note: failed.length > 0 ? `failed gates ${failed.join(', ')}` : 'every gate but 7 passed',
    };
  }
  const ids = series.map((s) => s.id).sort();
  const expected = [...FLOW_TRIAL_IDS].sort();
  if (ids.join(',') !== expected.join(',')) throw new Error(`gate 7 is computed once across ${expected.join(',')}; got ${ids.join(',')}`);
  return { series, other, datasetManifestHash: [...hashes][0], universeSha256: [...universes][0] };
}

export interface FlowGate7 {
  phase: 'broad-flow';
  numTrials: number;
  programTrials: number;
  datasetManifestHash: string;
  universeSha256: string;
  variance: Gate8Variance;
  result: Gate8Result;
  verdicts: Record<string, 'pass' | 'fail'>;
}

/** Gate 7 across the three trials (FLOW_GATE7). */
export function computeFlowGate7(trials: FlowTrials): FlowGate7 {
  const { result, variance } = computeGate8Detailed(trials.series, trials.other, FLOW_GATE7);
  return {
    phase: 'broad-flow',
    numTrials: FLOW_GATE7.numTrials,
    programTrials: FLOW_GATE7.programTrials,
    datasetManifestHash: trials.datasetManifestHash,
    universeSha256: trials.universeSha256,
    variance,
    result,
    verdicts: Object.fromEntries(result.results.map((r) => [r.id, r.verdict === 'fail' ? 'fail' : 'pass'])),
  };
}

export function formatFlowGate7(g: FlowGate7): string {
  const v = g.variance;
  return [
    `V = ${v.used.toExponential(3)} per day (${v.used === v.floor ? 'the floor' : 'cross-trial'}): ` +
      `cross-trial ${v.crossTrial.toExponential(3)}, floor 1/(T - 1) = ${v.floor?.toExponential(3) ?? '-'} at T = ${v.floorObservations ?? '-'}`,
    formatGate8(g.result, FLOW_GATE7).replace(/^gate 8 /, 'gate 7 '),
  ].join('\n');
}

export function parseArgs(argv: string[]): { reports: string[]; out: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--reports', '--out'].includes(key)) throw new Error(`Unknown flag ${key}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    flags.set(key.slice(2), value);
  }
  const reports = (flags.get('reports') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = flags.get('out');
  if (reports.length === 0) throw new Error('--reports is required');
  if (!out) throw new Error('--out is required');
  return { reports, out };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const trials = flowTrialsFrom(
    args.reports.map((p) => JSON.parse(readFileSync(p, 'utf8'))),
    args.reports
  );
  const g = computeFlowGate7(trials);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify({ ...g, computedAt: new Date().toISOString() }, null, 2));
  console.log(formatFlowGate7(g));
}

if (require.main === module) {
  main();
}
