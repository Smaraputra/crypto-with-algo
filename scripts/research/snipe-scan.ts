/**
 * Snipe discovery scan: every cell (38 columns x 2 tails x 2 levels x timeframe) on the discovery slice.
 *
 *   npx tsx scripts/research/snipe-scan.ts --cache-dir C --out report.json [--timeframes scalp,intraday]
 *       [--draws 200] [--symbols BTCUSDT,...]
 *   npx tsx scripts/research/snipe-scan.ts --cache-dir C --cell raw.ret1:top:many:intraday [--draws 200]
 *
 * The --cell mode recomputes one cell exactly as the scan does (same slice, grid and offsets) and prints its
 * evaluateCell result as one JSON line, to be compared digit for digit with the report entry (the report entry
 * additionally carries bhRejected). Offsets are generated once per timeframe and do not depend on the cells run.
 * JSON.stringify serialises NaN and Infinity as null.
 */
import { writeFileSync } from 'fs';
import {
  SNIPE_COLUMNS,
  SNIPE_DISCOVERY,
  SNIPE_DISCOVERY_CELLS,
  SNIPE_FDR_Q,
  SNIPE_NULL,
  SNIPE_TAIL_LEVELS,
  type SnipeLevel,
  type SnipeTail,
  type SnipeTimeframe,
} from './snipe';
import {
  loadTimeframe,
  maxHoldMsOf,
  minShiftBarsOf,
  offsetsFor,
  parseCellSpec,
  parseDraws,
  parseFlags,
  parseSymbols,
  parseTimeframes,
  sliceOf,
  TIMEFRAME_ORDER,
} from './snipe-cli';
import { OUTCOME_AMBIGUOUS, OUTCOME_DOWN, OUTCOME_TIMEOUT, OUTCOME_UP } from './snipe-labels';
import {
  benjaminiHochberg,
  bhP,
  buildSliceContext,
  evaluateCell,
  selectForConfirmation,
  type CellReport,
  type SliceContext,
  type SnipeCell,
} from './snipe-stats';

export interface SnipeScanArgs {
  cacheDir: string;
  out?: string;
  timeframes: SnipeTimeframe[];
  draws: number;
  symbols: string[];
  cell?: SnipeCell;
}

export interface SanityBlock {
  timeframe: SnipeTimeframe;
  inSliceBars: number;
  outcomes: { up: number; down: number; timeout: number; ambiguous: number };
  shares: { up: number; down: number; timeout: number; ambiguous: number };
  pooledLongWinRate: number;
  strata: number;
  gridLength: number;
  minShiftBars: number;
  barsLostToGrid: Record<string, number>;
}

export interface DiscoveryCellEntry extends CellReport {
  bhRejected: boolean;
}

export interface SnipeDiscoveryReport {
  reportKind: 'snipe-discovery';
  schemaVersion: 1;
  datasetManifestHash: string;
  gitCommit: string;
  computedAt: string;
  slice: { start: string; end: string };
  draws: number;
  seed: number;
  minShiftDays: number;
  symbols: string[];
  timeframes: SnipeTimeframe[];
  fdrQ: number;
  columns: string[];
  sanity: SanityBlock[];
  cells: DiscoveryCellEntry[];
  selected: CellReport[];
  verdict: 'SELECTED' | 'NULL';
}

const FLAGS = ['cache-dir', 'out', 'timeframes', 'draws', 'cell', 'symbols'];

export function parseArgs(argv: string[]): SnipeScanArgs {
  const flags = parseFlags(argv, FLAGS);
  const cacheDir = flags.get('cache-dir');
  if (!cacheDir) throw new Error('--cache-dir is required');
  const cell = flags.get('cell') ? parseCellSpec(flags.get('cell')!) : undefined;
  const out = flags.get('out');
  if (!out && !cell) throw new Error('--out is required (unless --cell is given)');
  return {
    cacheDir,
    out,
    timeframes: cell ? [cell.timeframe] : parseTimeframes(flags.get('timeframes')),
    draws: parseDraws(flags.get('draws'), SNIPE_NULL.discoveryDraws),
    symbols: parseSymbols(flags.get('symbols')),
    cell,
  };
}

/** Every cell of one timeframe: column x tail x level, in a fixed order. */
export function cellsOf(timeframe: SnipeTimeframe): SnipeCell[] {
  const out: SnipeCell[] = [];
  for (const column of SNIPE_COLUMNS) {
    for (const tail of ['top', 'bottom'] as SnipeTail[]) {
      for (const level of Object.keys(SNIPE_TAIL_LEVELS) as SnipeLevel[]) {
        out.push({ column, tail, level, timeframe });
      }
    }
  }
  return out;
}

export function sanityOf(ctx: SliceContext, symbols: string[]): SanityBlock {
  const counts = { up: 0, down: 0, timeout: 0, ambiguous: 0 };
  const strata = new Set<string>();
  let bars = 0;
  ctx.views.forEach((v, s) => {
    const a = v.arrays;
    bars += v.idx.length;
    for (let j = 0; j < v.idx.length; j++) {
      const i = v.idx[j];
      const o = a.outcome[i];
      if (o === OUTCOME_UP) counts.up++;
      else if (o === OUTCOME_DOWN) counts.down++;
      else if (o === OUTCOME_TIMEOUT) counts.timeout++;
      else if (o === OUTCOME_AMBIGUOUS) counts.ambiguous++;
      strata.add(`${s}|${a.month[i]}|${a.atrQuintile[i]}`);
    }
  });
  const share = (n: number) => (bars === 0 ? Number.NaN : n / bars);
  const lost: Record<string, number> = {};
  ctx.grid.symbols.forEach((g, s) => (lost[symbols[s]] = g.lostBars));
  return {
    timeframe: ctx.timeframe,
    inSliceBars: bars,
    outcomes: counts,
    shares: {
      up: share(counts.up),
      down: share(counts.down),
      timeout: share(counts.timeout),
      ambiguous: share(counts.ambiguous),
    },
    pooledLongWinRate: counts.up + counts.down === 0 ? Number.NaN : counts.up / (counts.up + counts.down),
    strata: strata.size,
    gridLength: ctx.grid.G,
    minShiftBars: minShiftBarsOf(ctx.timeframe),
    barsLostToGrid: lost,
  };
}

export function runSnipeScan(args: SnipeScanArgs, log: (line: string) => void = console.log): SnipeDiscoveryReport | CellReport {
  const slice = sliceOf(SNIPE_DISCOVERY);
  let hash: string | undefined;
  const cells: CellReport[] = [];
  const sanity: SanityBlock[] = [];

  for (const tf of TIMEFRAME_ORDER.filter((t) => args.timeframes.includes(t))) {
    const loaded = loadTimeframe(args.cacheDir, args.symbols, tf, hash);
    hash = loaded.datasetManifestHash;
    const ctx = buildSliceContext(loaded.arrays, slice, tf, maxHoldMsOf(tf));
    const offsets = offsetsFor(tf, ctx.grid.G, args.draws);
    if (args.cell) {
      const report = evaluateCell(ctx, args.cell, offsets);
      log(JSON.stringify(report));
      return report;
    }
    sanity.push(sanityOf(ctx, args.symbols));
    for (const cell of cellsOf(tf)) cells.push(evaluateCell(ctx, cell, offsets));
  }

  if (args.timeframes.length === TIMEFRAME_ORDER.length && cells.length !== SNIPE_DISCOVERY_CELLS) {
    throw new Error(`snipe-scan: expected ${SNIPE_DISCOVERY_CELLS} cells, got ${cells.length}`);
  }
  const rejected = benjaminiHochberg(cells.map(bhP), SNIPE_FDR_Q);
  const selected = selectForConfirmation(cells, SNIPE_FDR_Q);
  const report: SnipeDiscoveryReport = {
    reportKind: 'snipe-discovery',
    schemaVersion: 1,
    datasetManifestHash: hash ?? '',
    gitCommit: process.env.GIT_COMMIT ?? 'unknown',
    computedAt: new Date().toISOString(),
    slice: { start: SNIPE_DISCOVERY.start, end: SNIPE_DISCOVERY.end },
    draws: args.draws,
    seed: SNIPE_NULL.seed,
    minShiftDays: SNIPE_NULL.minShiftDays,
    symbols: args.symbols,
    timeframes: args.timeframes,
    fdrQ: SNIPE_FDR_Q,
    columns: [...SNIPE_COLUMNS],
    sanity,
    cells: cells.map((c, i) => ({ ...c, bhRejected: rejected[i] })),
    selected,
    verdict: selected.length > 0 ? 'SELECTED' : 'NULL',
  };
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  log(
    `snipe-discovery ${report.verdict}: ${cells.length} cells, ${rejected.filter(Boolean).length} BH-rejected, ` +
      `${selected.length} selected (draws ${args.draws})`
  );
  for (const c of selected) {
    log(
      `  ${c.cell.column}:${c.cell.tail}:${c.cell.level}:${c.cell.timeframe} dir ${c.direction} ` +
        `excess ${c.obsAll.toFixed(4)} win ${c.winRate.toFixed(4)} base ${c.baseline.toFixed(4)} ` +
        `p ${c.pTwoSided.toExponential(2)} resolved ${c.resolved}`
    );
  }
  return report;
}

if (require.main === module) {
  try {
    runSnipeScan(parseArgs(process.argv.slice(2)));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
