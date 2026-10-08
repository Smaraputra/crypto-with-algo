/**
 * CLI for the event studies phase pre-registered in event-studies.ts's header (E1 forced deleveraging, E2
 * funding extremes, E3 volume shocks, each at 1h, 4h and 24h, plus the volatility read).
 *
 * Verifies the dataset manifest (every file hash and the dataset hash), loads each of the ten symbols' 1h
 * perp klines, 5m futures metrics and funding settlements with the lockbox applied, builds one hourly panel
 * per symbol (the raw 5m rows are dropped as soon as the panel exists), runs runEventStudies and writes a
 * schema-validated report.
 *
 * The dataset is a fresh export of exactly those kinds, for example:
 *   npx tsx scripts/research/export-dataset.ts --datasets perp,metrics,funding --intervals 1h --out <dir>
 *
 * Usage:
 *   npx tsx scripts/research/event-studies-harness.ts --dataset-dir <dir> [--out <file>] [--task-id <id>]
 */
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { loadFunding, loadManifest, loadMetrics, loadPerp, verifyManifest } from './load-dataset';
import {
  PREREGISTERED_CONFIG,
  buildHourlyPanel,
  gridStartOf,
  runEventStudies,
  type EventStudyConfig,
  type HourlyPanel,
} from './event-studies';
import { validateEventStudyReport, type EventStudyReport } from './report-schema';

export interface EventStudyArgs {
  datasetDir: string;
  out: string;
  taskId: string;
}

const FLAGS = ['dataset-dir', 'out', 'task-id'];

export function parseArgs(argv: string[]): EventStudyArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const key = flag.slice(2);
    if (!FLAGS.includes(key)) throw new Error(`Unknown flag ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    flags.set(key, value);
    i++;
  }
  const datasetDir = flags.get('dataset-dir');
  if (!datasetDir) throw new Error('--dataset-dir is required (a fresh export of perp 1h, metrics and funding)');
  const taskId = flags.get('task-id') ?? 'event-studies';
  return {
    datasetDir,
    out: flags.get('out') ?? `data/research/reports/event-studies-${taskId}.json`,
    taskId,
  };
}

/** The three files each symbol is read from, as the manifest lists them. */
export function requiredFiles(symbol: string): string[] {
  return [`perp/${symbol}/1h.jsonl.gz`, `metrics/${symbol}/5m.jsonl.gz`, `funding/${symbol}/settlements.jsonl.gz`];
}

export interface LoadedPanels {
  panels: HourlyPanel[];
  datasetHash: string;
  lockboxApplied: boolean;
}

/**
 * Verifies the manifest, refuses any input file it does not list (an unlisted file is not covered by the
 * dataset hash), and builds one panel per symbol with the lockbox applied by the loaders.
 */
export async function loadEventPanels(
  datasetDir: string,
  config: EventStudyConfig = PREREGISTERED_CONFIG
): Promise<LoadedPanels> {
  const verify = await verifyManifest(datasetDir);
  if (!verify.ok) throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  const manifest = loadManifest(datasetDir);
  const listed = new Set(manifest.files.map((f) => f.path));
  const missing = config.symbols.flatMap(requiredFiles).filter((path) => !listed.has(path));
  if (missing.length > 0) throw new Error(`The manifest does not list: ${missing.join(', ')}`);

  const gridStart = gridStartOf(config);
  let lockboxApplied = true;
  const panels: HourlyPanel[] = [];
  for (const symbol of config.symbols) {
    const perp = loadPerp(datasetDir, symbol, '1h');
    const metrics = loadMetrics(datasetDir, symbol);
    const funding = loadFunding(datasetDir, symbol);
    lockboxApplied = lockboxApplied && perp.lockboxApplied && metrics.lockboxApplied && funding.lockboxApplied;
    panels.push(buildHourlyPanel(symbol, perp.rows, metrics.rows, funding.rows, gridStart, config.sampleEnd));
  }
  return { panels, datasetHash: manifest.datasetHash, lockboxApplied };
}

function resolveCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

/** Loads, runs and validates. `config` is PREREGISTERED_CONFIG on the CLI; tests pass a shorter one. */
export async function runEventStudiesHarness(
  args: EventStudyArgs,
  config: EventStudyConfig = PREREGISTERED_CONFIG
): Promise<EventStudyReport> {
  const started = Date.now();
  const loaded = await loadEventPanels(args.datasetDir, config);
  const result = runEventStudies(loaded.panels, config);
  const report: EventStudyReport = {
    schemaVersion: 1,
    taskId: args.taskId,
    datasetManifestHash: loaded.datasetHash,
    lockboxApplied: loaded.lockboxApplied,
    ...result,
    computedAt: new Date().toISOString(),
    gitCommit: resolveCommit(),
    durationMs: Date.now() - started,
  };
  const validated = validateEventStudyReport(report);
  if (!validated.ok) throw new Error(`Event study report failed its schema: ${validated.issues.join('; ')}`);
  return validated.data;
}

const pct = (v: number | null, digits = 3) => (v === null ? '-' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null, digits = 2) => (v === null ? '-' : v.toFixed(digits));

export function formatEventStudies(r: EventStudyReport): string {
  const lines: string[] = [];
  lines.push(
    `event studies: ${r.symbols.length} symbols, ${new Date(r.config.sampleStart).toISOString().slice(0, 10)} to ` +
      `${new Date(r.config.sampleEnd).toISOString().slice(0, 10)}, cost ${pct(r.config.cost, 2)}, trials ${r.trials} ` +
      `(ledger ${r.ledgerBefore} -> ${r.ledgerAfter}), lockbox ${r.lockboxApplied}, dataset ${r.datasetManifestHash.slice(0, 12)}`
  );
  lines.push(
    `detected: E1 ${r.detected.E1.total}, E2 ${r.detected.E2.total} (at threshold ${r.detected.E2.atThreshold}), ` +
      `E3 ${r.detected.E3.total}, E1 1/99 ${r.detected.E1Sensitivity.total}`
  );
  for (const c of r.cells) {
    lines.push(
      `${c.event} ${String(c.horizon).padStart(2)}h s ${c.side > 0 ? '+' : '-'}  n ${c.n} over ${c.days} days  ` +
        `gross ${pct(c.gross.mean)} [${pct(c.gross.ciLow)}, ${pct(c.gross.ciHigh)}] p ${c.gross.p.toFixed(4)}  ` +
        `net ${pct(c.net.mean)} [${pct(c.net.ciLow)}, ${pct(c.net.ciHigh)}]  ` +
        `gates ${c.gates.map((g) => `${g.name} ${g.pass ? 'pass' : 'FAIL'}`).join(', ')}  ${c.pass ? 'PASS' : 'fail'}`
    );
  }
  for (const c of r.e1Sensitivity) {
    lines.push(
      `E1 1st/99th ${String(c.horizon).padStart(2)}h  n ${c.n}  gross ${pct(c.gross.mean)} p ${c.gross.p.toFixed(4)}  ` +
        `net ${pct(c.net.mean)} [${pct(c.net.ciLow)}, ${pct(c.net.ciHigh)}]`
    );
  }
  const v = r.volatility;
  for (const [label, read] of [
    ['E1', v.byEvent.E1],
    ['E2', v.byEvent.E2],
    ['E3', v.byEvent.E3],
    ['E1|E3', v.pooledE1E3],
  ] as const) {
    lines.push(
      `vol ratio ${label.padEnd(5)} n ${read.n} (excluded ${read.excluded})  median ${num(read.median)} ` +
        `[${num(read.ciLow)}, ${num(read.ciHigh)}]`
    );
  }
  if (v.stress) {
    lines.push(
      `stress flag on ${v.stress.symbol}: ${v.stress.days} days (skipped ${v.stress.skippedDays}), ` +
        `top quintile ${v.stress.topQuintileDays}, flagged ${v.stress.flaggedDays}, hit ${num(v.stress.hitRate)}, ` +
        `TNR ${num(v.stress.trueNegativeRate)}, balanced accuracy ${num(v.stress.balancedAccuracy, 3)}`
    );
  } else {
    lines.push('stress flag: no reference panel');
  }
  lines.push(
    `PRODUCT READ ${v.product.pass ? 'SHIPS' : 'does not ship'} (balanced accuracy ${v.product.balancedAccuracyPass ? 'pass' : 'fail'}, ` +
      `ratio ${v.product.ratioPass ? 'pass' : 'fail'})`
  );
  lines.push(`VERDICT ${r.verdict}${r.passingCells.length > 0 ? `: ${r.passingCells.join(', ')}` : ''}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runEventStudiesHarness(args);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(formatEventStudies(report));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
