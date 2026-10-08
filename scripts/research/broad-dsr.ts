/**
 * The broad trend phase's gate 8 (broad-trend.ts header, GATES 8), computed ONCE
 * across the five broad reports (schema v2, broad-harness.ts):
 *
 *   SR* = sqrt(V) x ((1 - g) x InvPhi(1 - 1/N) + g x InvPhi(1 - 1/(N e))) at N = 16,
 *   every quantity per period (daily); V = the larger of the sample variance of the
 *   five per-period Sharpes and the null floor 1 / (T - 1), T the shortest of the
 *   five daily series; each trial's probabilistic Sharpe uses its own length,
 *   skewness and kurtosis; a trial passes at 0.95. The same at the program count
 *   1,729 is reported, never gated. The legends Sharpes do not enter V.
 *
 * A trial's verdict: every other gate passed (its report reads 'pending-trials')
 * and gate 8 passes. A pass unlocks the lockbox read once; nothing else.
 *
 * Usage:
 *   npx tsx scripts/research/broad-dsr.ts --reports tf1.json,tf2.json,tf3.json,tf4.json,c3.json --out broad-gate8.json
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  BROAD_GATE8,
  computeGate8Detailed,
  formatGate8,
  loadBroadTrials,
  type BroadTrials,
  type Gate8Result,
  type Gate8Variance,
} from './legends-dsr';

export interface BroadGate8 {
  phase: 'broad-trend';
  numTrials: number;
  programTrials: number;
  datasetManifestHash: string;
  universeSha256: string;
  variance: Gate8Variance;
  result: Gate8Result;
  verdicts: Record<string, 'pass' | 'fail'>;
}

/** Gate 8 across the five broad trials (BROAD_GATE8). */
export function computeBroadGate8(trials: BroadTrials): BroadGate8 {
  const { result, variance } = computeGate8Detailed(trials.series, trials.other, BROAD_GATE8);
  return {
    phase: 'broad-trend',
    numTrials: BROAD_GATE8.numTrials,
    programTrials: BROAD_GATE8.programTrials,
    datasetManifestHash: trials.datasetManifestHash,
    universeSha256: trials.universeSha256,
    variance,
    result,
    verdicts: Object.fromEntries(result.results.map((r) => [r.id, r.verdict === 'fail' ? 'fail' : 'pass'])),
  };
}

export function formatBroadGate8(g: BroadGate8): string {
  const v = g.variance;
  return [
    `V = ${v.used.toExponential(3)} per day (${v.used === v.floor ? 'the floor' : 'cross-trial'}): ` +
      `cross-trial ${v.crossTrial.toExponential(3)}, floor 1/(T - 1) = ${v.floor?.toExponential(3) ?? '-'} at T = ${v.floorObservations ?? '-'}`,
    formatGate8(g.result, BROAD_GATE8),
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
  const g = computeBroadGate8(loadBroadTrials(args.reports));
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify({ ...g, computedAt: new Date().toISOString() }, null, 2));
  console.log(formatBroadGate8(g));
}

if (require.main === module) {
  main();
}
