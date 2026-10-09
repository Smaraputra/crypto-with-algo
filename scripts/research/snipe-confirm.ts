/**
 * Snipe confirmation: the cells selected at discovery, on the confirmation slice, direction fixed.
 *
 *   npx tsx scripts/research/snipe-confirm.ts --cache-dir C --discovery discovery.json --out confirm.json
 *       [--draws 1000] [--symbols BTCUSDT,...]
 *   npx tsx scripts/research/snipe-confirm.ts --cache-dir C --discovery discovery.json --cell raw.ret1:top:many:intraday
 *
 * Refuses a discovery report whose verdict is NULL or whose dataset hash differs from the cache. The --cell mode
 * prints the evaluateCell result (fixed direction taken from the discovery report) as one JSON line, equal to
 * the `report` of that cell's entry in the confirmation report.
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import {
  SNIPE_CONFIRMATION,
  SNIPE_CONFIRM_ALPHA,
  SNIPE_NULL,
  type SnipeTimeframe,
} from './snipe';
import {
  loadTimeframe,
  maxHoldMsOf,
  offsetsFor,
  parseCellSpec,
  parseDraws,
  parseFlags,
  parseSymbols,
  sliceOf,
  TIMEFRAME_ORDER,
} from './snipe-cli';
import type { SanityBlock, SnipeDiscoveryReport } from './snipe-scan';
import { sanityOf } from './snipe-scan';
import {
  buildSliceContext,
  confirmCell,
  evaluateCell,
  type CellReport,
  type ConfirmResult,
  type SnipeCell,
} from './snipe-stats';

export interface SnipeConfirmArgs {
  cacheDir: string;
  discovery: string;
  out?: string;
  draws: number;
  symbols: string[];
  cell?: SnipeCell;
}

export interface ConfirmationEntry {
  cell: SnipeCell;
  direction: 1 | -1;
  pass: boolean;
  empiricalP: number;
  threshold: number;
  consistency: ConfirmResult['consistency'];
  report: CellReport;
}

export interface SnipeConfirmationReport {
  reportKind: 'snipe-confirmation';
  schemaVersion: 1;
  datasetManifestHash: string;
  gitCommit: string;
  computedAt: string;
  slice: { start: string; end: string };
  draws: number;
  seed: number;
  minShiftDays: number;
  symbols: string[];
  discoveryReportSha256: string;
  m: number;
  alphaPerCell: number;
  sanity: SanityBlock[];
  cells: ConfirmationEntry[];
  verdict: 'EDGE_BEFORE_COSTS' | 'NULL';
}

const FLAGS = ['cache-dir', 'discovery', 'out', 'draws', 'cell', 'symbols'];

export function parseArgs(argv: string[]): SnipeConfirmArgs {
  const flags = parseFlags(argv, FLAGS);
  const cacheDir = flags.get('cache-dir');
  const discovery = flags.get('discovery');
  if (!cacheDir) throw new Error('--cache-dir is required');
  if (!discovery) throw new Error('--discovery is required');
  const cell = flags.get('cell') ? parseCellSpec(flags.get('cell')!) : undefined;
  const out = flags.get('out');
  if (!out && !cell) throw new Error('--out is required (unless --cell is given)');
  return {
    cacheDir,
    discovery,
    out,
    draws: parseDraws(flags.get('draws'), SNIPE_NULL.confirmationDraws),
    symbols: parseSymbols(flags.get('symbols')),
    cell,
  };
}

export function runSnipeConfirm(
  args: SnipeConfirmArgs,
  log: (line: string) => void = console.log
): SnipeConfirmationReport | CellReport {
  const raw = readFileSync(args.discovery);
  const discovery = JSON.parse(raw.toString('utf8')) as SnipeDiscoveryReport;
  if (discovery.reportKind !== 'snipe-discovery') throw new Error('snipe-confirm: not a snipe-discovery report');
  if (discovery.verdict === 'NULL' || discovery.selected.length === 0) {
    throw new Error('snipe-confirm: the discovery verdict is NULL, nothing to confirm');
  }
  const selected = args.cell
    ? discovery.selected.filter(
        (c) =>
          c.cell.column === args.cell!.column &&
          c.cell.tail === args.cell!.tail &&
          c.cell.level === args.cell!.level &&
          c.cell.timeframe === args.cell!.timeframe
      )
    : discovery.selected;
  if (args.cell && selected.length === 0) throw new Error('snipe-confirm: --cell is not among the selected cells');
  // m is the number of confirmed cells of the report, also in the single-cell spot check.
  const m = discovery.selected.length;

  const slice = sliceOf(SNIPE_CONFIRMATION);
  const timeframes = TIMEFRAME_ORDER.filter((tf) => selected.some((c) => c.cell.timeframe === tf));
  const entries: ConfirmationEntry[] = [];
  const sanity: SanityBlock[] = [];
  let hash: string | undefined;

  for (const tf of timeframes as SnipeTimeframe[]) {
    const loaded = loadTimeframe(args.cacheDir, args.symbols, tf, hash);
    hash = loaded.datasetManifestHash;
    if (hash !== discovery.datasetManifestHash) {
      throw new Error(`snipe-confirm: dataset hash ${hash} differs from the discovery report ${discovery.datasetManifestHash}`);
    }
    const ctx = buildSliceContext(loaded.arrays, slice, tf, maxHoldMsOf(tf));
    const offsets = offsetsFor(tf, ctx.grid.G, args.draws);
    sanity.push(sanityOf(ctx, args.symbols));
    for (const d of selected.filter((c) => c.cell.timeframe === tf)) {
      const direction = d.direction as 1 | -1;
      if (args.cell) {
        const report = evaluateCell(ctx, d.cell, offsets, direction);
        log(JSON.stringify(report));
        return report;
      }
      const res = confirmCell(ctx, d.cell, direction, m, offsets);
      entries.push({
        cell: d.cell,
        direction,
        pass: res.pass,
        empiricalP: res.empiricalP,
        threshold: res.threshold,
        consistency: res.consistency,
        report: res.report,
      });
    }
  }

  const report: SnipeConfirmationReport = {
    reportKind: 'snipe-confirmation',
    schemaVersion: 1,
    datasetManifestHash: hash ?? '',
    gitCommit: process.env.GIT_COMMIT ?? 'unknown',
    computedAt: new Date().toISOString(),
    slice: { start: SNIPE_CONFIRMATION.start, end: SNIPE_CONFIRMATION.end },
    draws: args.draws,
    seed: SNIPE_NULL.seed,
    minShiftDays: SNIPE_NULL.minShiftDays,
    symbols: args.symbols,
    discoveryReportSha256: createHash('sha256').update(raw).digest('hex'),
    m,
    alphaPerCell: SNIPE_CONFIRM_ALPHA / m,
    sanity,
    cells: entries,
    verdict: entries.some((e) => e.pass) ? 'EDGE_BEFORE_COSTS' : 'NULL',
  };
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  log(`snipe-confirmation ${report.verdict}: m ${m}, alpha per cell ${report.alphaPerCell}, draws ${args.draws}`);
  for (const e of entries) {
    log(
      `  ${e.cell.column}:${e.cell.tail}:${e.cell.level}:${e.cell.timeframe} dir ${e.direction} ` +
        `${e.pass ? 'PASS' : 'FAIL'} p ${e.empiricalP.toFixed(4)} < ${e.threshold.toFixed(4)} ` +
        `excess ${e.report.obsAll.toFixed(4)} win ${e.report.winRate.toFixed(4)} base ${e.report.baseline.toFixed(4)}`
    );
  }
  return report;
}

if (require.main === module) {
  try {
    runSnipeConfirm(parseArgs(process.argv.slice(2)));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
