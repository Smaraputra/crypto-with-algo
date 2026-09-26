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
} from './report-schema';

export interface SurvivorTableArgs {
  reports: string[];
  fdrQ: number;
  out: string | undefined;
}

export function parseArgs(argv: string[]): SurvivorTableArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    flags.set(arg.slice(2), value);
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
  lines.push(['interval', 'factor', 'sign', 'horizons', 'quarters', 'symbols'].map((h) => h.padEnd(12)).join(''));
  for (const row of table.rows.filter((r) => r.survivor)) {
    lines.push(
      [
        row.interval.padEnd(12),
        row.factor.padEnd(30),
        (row.sign > 0 ? '+' : row.sign < 0 ? '-' : '0').padEnd(12),
        row.horizonsPassing.join(',').padEnd(12),
        row.quarterAgreement.toFixed(2).padEnd(12),
        row.symbolAgreement.toFixed(2),
      ].join('')
    );
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
