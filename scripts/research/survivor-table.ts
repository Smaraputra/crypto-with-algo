/**
 * The survivor rule applied across a phase: reads every factor-ic report the
 * phase produced, applies SURVIVOR_RULE with Benjamini-Hochberg FDR across
 * all their pooled cells, prints per-interval counts and the survivor rows,
 * and optionally writes the whole table as JSON beside the reports.
 *
 * Usage:
 *   npx tsx scripts/research/survivor-table.ts --reports a.json,b.json [--fdr-q 0.10] [--out survivors.json]
 *
 * A single report's own "survivors:" line (factor-ic.ts) is pre-FDR; this is
 * the reading the phase records.
 */
import { readFile, writeFile } from 'fs/promises';
import {
  evaluatePhaseSurvivors,
  PHASE_FDR_Q,
  validateFactorIcReport,
  type FactorIcReport,
  type PhaseSurvivorTable,
  type SurvivorRow,
} from './report-schema';

export interface SurvivorTableArgs {
  reports: string[];
  fdrQ: number;
  out: string | undefined;
}

// Every flag this CLI takes. An unrecognized --flag is rejected rather than
// silently absorbed as a no-op (and its value token silently swallowed), the
// same rule factor-ic.ts applies.
const VALUE_FLAGS = new Set(['reports', 'fdr-q', 'out']);

export function parseArgs(argv: string[]): SurvivorTableArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!VALUE_FLAGS.has(key)) throw new Error(`Unknown flag --${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    flags.set(key, value);
    i++;
  }
  const reportsRaw = flags.get('reports');
  if (!reportsRaw) throw new Error('--reports is required (comma-separated factor-ic report paths)');
  const fdrQ = flags.has('fdr-q') ? Number(flags.get('fdr-q')) : PHASE_FDR_Q;
  if (!(fdrQ > 0 && fdrQ < 1)) throw new Error(`--fdr-q must be in (0, 1), got ${flags.get('fdr-q')}`);
  return {
    reports: reportsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    fdrQ,
    out: flags.get('out'),
  };
}

export async function loadReports(paths: string[]): Promise<FactorIcReport[]> {
  const reports: FactorIcReport[] = [];
  for (const path of paths) {
    const validated = validateFactorIcReport(JSON.parse(await readFile(path, 'utf8')));
    if (!validated.ok) {
      throw new Error(`${path} failed schema validation:\n${validated.issues.join('\n')}`);
    }
    reports.push(validated.data);
  }
  return reports;
}

/**
 * One width per column, used by BOTH the header and the rows so a cell always
 * starts at its own column's offset. The header labels are short enough to fit
 * their widths ("iv" rather than "interval"), which is the other half of that:
 * a label wider than its column shifts every column after it.
 *
 * horizons is 20 because a seven-horizon list (1,2,4,8,16,32,48 at 15m) is 16
 * characters and used to run into the next column.
 */
const COLUMNS: ReadonlyArray<{ label: string; width: number }> = [
  { label: 'iv', width: 6 },
  { label: 'taskId', width: 12 },
  { label: 'factor', width: 30 },
  { label: 'sign', width: 6 },
  { label: 'horizons', width: 20 },
  { label: 'quarters', width: 10 },
  { label: 'symbols', width: 10 },
];

/**
 * Pads to the column's width, and keeps one separating space when the cell is
 * wider than its column: a real taskId (defaultTaskId produces
 * "factor-ic-15m-202609261234") does not fit 12 characters, and truncating an
 * identifier in a research table is worse than shifting one row. Nothing is
 * ever allowed to run into the next cell.
 */
function cell(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

function headerLine(trailing?: string): string {
  const padded = COLUMNS.map((c) => cell(c.label, c.width)).join('');
  return trailing ? padded + trailing : padded.trimEnd();
}

function rowLine(row: SurvivorRow, trailing?: string): string {
  const cells = [
    row.interval,
    row.taskId,
    row.factor,
    row.sign > 0 ? '+' : row.sign < 0 ? '-' : '0',
    row.horizonsPassing.join(','),
    row.quarterAgreement.toFixed(2),
    row.symbolAgreement.toFixed(2),
  ];
  const padded = cells.map((text, i) => cell(text, COLUMNS[i].width)).join('');
  return trailing ? padded + trailing : padded.trimEnd();
}

export function formatSurvivorTable(table: PhaseSurvivorTable): string {
  const lines: string[] = [];
  lines.push(
    `survivor rule: |ic| >= ${table.minAbsIc}, |t| >= ${table.minT}, FDR q ${table.fdrQ}, ` +
      `cells ${table.cells}, FDR-rejected ${table.rejectedCells}`
  );
  for (const p of table.perInterval) {
    lines.push(`${p.interval.padEnd(4)}${p.taskId.padEnd(16)}survivors ${p.survivors} / ${p.factors}`);
  }
  lines.push('');
  lines.push(headerLine());
  for (const row of table.rows.filter((r) => r.survivor)) {
    lines.push(rowLine(row));
  }

  // A row that cleared the effect-size and significance legs and then lost on
  // the FDR or on quarter/symbol agreement is the one a reader of this table
  // most needs to see next: it is where the phase's near-decisions are, and
  // printing survivors alone hides them. A row that passed no horizon at all
  // is not a near miss and stays out.
  const nearMisses = table.rows.filter(
    (r) => !r.survivor && (r.horizonsPassing.length > 0 || (r.fdrExcludedHorizons?.length ?? 0) > 0)
  );
  lines.push('');
  lines.push('near misses (cleared |ic| and |t|, failed the FDR or a consistency leg):');
  lines.push(headerLine('reasons'));
  for (const row of nearMisses) {
    lines.push(rowLine(row, row.reasons.join('; ')));
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reports = await loadReports(args.reports);
  const table = evaluatePhaseSurvivors(reports, args.fdrQ);
  console.log(formatSurvivorTable(table));
  if (args.out) {
    await writeFile(args.out, JSON.stringify(table, null, 2) + '\n', 'utf8');
    console.error(`[survivor-table] wrote ${args.out}`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
