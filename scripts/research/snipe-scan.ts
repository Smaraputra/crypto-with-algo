/**
 * Snipe discovery scan: every cell (38 columns x 2 tails x 2 levels x timeframe) on the discovery slice.
 *
 *   npx tsx scripts/research/snipe-scan.ts --cache-dir C --out report.json [--timeframes scalp,intraday]
 *       [--draws 200] [--symbols BTCUSDT,...]
 *   npx tsx scripts/research/snipe-scan.ts --cache-dir C --cell raw.ret1:top:many:intraday [--draws 200]
 *   npx tsx scripts/research/snipe-scan.ts --cache-dir C --sanity-only --out sanity.json [--timeframes ...]
 *
 * The --sanity-only mode (AMENDMENT 1, A1-5) builds the DISCOVERY slice contexts and reports data checks only:
 * bars, outcome shares, pooled long win rate, strata, grid loss, labels with a data gap, per-column tail-eligible
 * and finite shares, and a deterministic sample of 20 labels per timeframe for hand-checking against the raw
 * candles. It evaluates no cell, draws no null and prints no cell statistic.
 *
 * The --cell mode recomputes one cell exactly as the scan does (same slice, grid and offsets) and prints its
 * evaluateCell result as one JSON line, to be compared digit for digit with the report entry (the report entry
 * additionally carries bhRejected). Offsets are generated once per timeframe and do not depend on the cells run.
 * JSON.stringify serialises NaN and Infinity as null.
 */
import { writeFileSync } from 'fs';
import { seededRandom } from './carry-sim';
import {
  SNIPE_BARRIER_ATR,
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
  discoveryBinding,
  discoverySlice,
  sanityBinding,
  gitCommitFromEnv,
  loadTimeframe,
  maxHoldMsOf,
  minShiftBarsOf,
  offsetsFor,
  parseCellSpec,
  parseDraws,
  parseFlags,
  parseSymbols,
  parseTimeframes,
  TIMEFRAME_ORDER,
} from './snipe-cli';
import { OUTCOME_AMBIGUOUS, OUTCOME_DOWN, OUTCOME_TIMEOUT, OUTCOME_UP } from './snipe-labels';
import { TAIL_ELIGIBLE } from './snipe-tails';
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
  /** Sanity-only mode (AMENDMENT 1, A1-5): data checks, no cell. */
  sanityOnly?: boolean;
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

export const SANITY_SAMPLE_SIZE = 20;
export const SANITY_SAMPLE_SEED = 7;

export interface SanityLabelSample {
  symbol: string;
  conditionTime: string;
  entryTime: string;
  entryPrice: number;
  atrAbs: number;
  upper: number;
  lower: number;
  outcome: 'UP' | 'DOWN' | 'TIMEOUT' | 'AMBIGUOUS';
  exitTime: string;
}

export interface SanityColumnBlock {
  column: string;
  /** Share of the in-slice bars (pooled over symbols) with TAIL_ELIGIBLE set. */
  tailEligibleShare: number;
  /** The cache's whole-span finite share, mean over symbols, and per symbol in symbol order. */
  finiteShare: number;
  finiteShareBySymbol: number[];
}

export interface SanityOnlyBlock extends SanityBlock {
  /** In-slice labels with gap = 1 (a hole in the ATR window or the 5m path). */
  gapLabels: number;
  columns: SanityColumnBlock[];
  sample: SanityLabelSample[];
}

export interface SnipeSanityReport {
  reportKind: 'snipe-sanity';
  schemaVersion: 1;
  datasetManifestHash: string;
  gitCommit: string;
  binding: boolean;
  computedAt: string;
  slice: { start: string; end: string };
  seed: number;
  symbols: string[];
  timeframes: SnipeTimeframe[];
  blocks: SanityOnlyBlock[];
}

export interface DiscoveryCellEntry extends CellReport {
  bhRejected: boolean;
}

export interface SnipeDiscoveryReport {
  reportKind: 'snipe-discovery';
  schemaVersion: 1;
  datasetManifestHash: string;
  gitCommit: string;
  /** True only for the run the pre-registration counts (AMENDMENT 1, A1-6, see discoveryBinding). */
  binding: boolean;
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
  // --sanity-only is the one flag without a value.
  const sanityOnly = argv.includes('--sanity-only');
  const flags = parseFlags(argv.filter((a) => a !== '--sanity-only'), FLAGS);
  const cacheDir = flags.get('cache-dir');
  if (!cacheDir) throw new Error('--cache-dir is required');
  const cell = flags.get('cell') ? parseCellSpec(flags.get('cell')!) : undefined;
  const out = flags.get('out');
  if (sanityOnly && cell) throw new Error('--sanity-only cannot be combined with --cell');
  if (sanityOnly && flags.has('draws')) throw new Error('--sanity-only draws no null, --draws does not apply');
  if (!out && !cell) throw new Error('--out is required (unless --cell is given)');
  return {
    sanityOnly,
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
      strata.add(`${s}|${a.atrQuintile[i]}`);
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

const OUTCOME_NAMES: Record<number, SanityLabelSample['outcome']> = {
  [OUTCOME_UP]: 'UP',
  [OUTCOME_DOWN]: 'DOWN',
  [OUTCOME_TIMEOUT]: 'TIMEOUT',
  [OUTCOME_AMBIGUOUS]: 'AMBIGUOUS',
};

/**
 * The sanity-only block of one timeframe: sanityOf plus the gap count, the per-column shares and the label
 * sample. Pure over a slice context; it touches no cell and no null.
 */
export function sanityOnlyBlockOf(ctx: SliceContext, symbols: string[]): SanityOnlyBlock {
  const base = sanityOf(ctx, symbols);
  const eligible = SNIPE_COLUMNS.map(() => 0);
  let gapLabels = 0;
  // Pooled in-slice bars in a fixed order: symbol order, then time order.
  const offsets: number[] = [];
  let pooled = 0;
  ctx.views.forEach((v) => {
    offsets.push(pooled);
    pooled += v.idx.length;
    const a = v.arrays;
    const flagsOf = SNIPE_COLUMNS.map((column) => a.flags[a.columns.indexOf(column)]);
    for (let j = 0; j < v.idx.length; j++) {
      const i = v.idx[j];
      if (a.gap[i] === 1) gapLabels++;
      for (let c = 0; c < flagsOf.length; c++) if ((flagsOf[c][i] & TAIL_ELIGIBLE) !== 0) eligible[c]++;
    }
  });
  const columns: SanityColumnBlock[] = SNIPE_COLUMNS.map((column, c) => {
    const bySymbol = ctx.views.map((v) => v.arrays.finiteShare[v.arrays.columns.indexOf(column)]);
    return {
      column,
      tailEligibleShare: pooled === 0 ? Number.NaN : eligible[c] / pooled,
      finiteShare: bySymbol.length === 0 ? Number.NaN : bySymbol.reduce((s, x) => s + x, 0) / bySymbol.length,
      finiteShareBySymbol: bySymbol,
    };
  });

  const sample: SanityLabelSample[] = [];
  if (pooled > 0) {
    const random = seededRandom(SANITY_SAMPLE_SEED);
    const picked = new Set<number>();
    const want = Math.min(SANITY_SAMPLE_SIZE, pooled);
    while (picked.size < want) {
      const p = Math.floor(random() * pooled);
      if (picked.has(p)) continue;
      picked.add(p);
      let s = offsets.length - 1;
      while (offsets[s] > p) s--;
      const a = ctx.views[s].arrays;
      const i = ctx.views[s].idx[p - offsets[s]];
      const entryPrice = a.entryPrice[i];
      const atrAbs = a.atrAbs[i];
      sample.push({
        symbol: symbols[s],
        conditionTime: new Date(a.timestamps[i]).toISOString(),
        entryTime: new Date(a.entryMs[i]).toISOString(),
        entryPrice,
        atrAbs,
        upper: entryPrice + SNIPE_BARRIER_ATR * atrAbs,
        lower: entryPrice - SNIPE_BARRIER_ATR * atrAbs,
        outcome: OUTCOME_NAMES[a.outcome[i]],
        exitTime: new Date(a.exitMs[i]).toISOString(),
      });
    }
  }
  return { ...base, gapLabels, columns, sample };
}

/**
 * Sanity-only run (AMENDMENT 1, A1-5): builds the discovery slice contexts and writes the data checks. It never
 * calls evaluateCell, nullOffsets or any statistic of a cell.
 */
export function runSnipeSanity(args: SnipeScanArgs, log: (line: string) => void = console.log): SnipeSanityReport {
  const slice = discoverySlice();
  let hash: string | undefined;
  const cacheCommits: string[] = [];
  const blocks: SanityOnlyBlock[] = [];
  for (const tf of TIMEFRAME_ORDER.filter((t) => args.timeframes.includes(t))) {
    const loaded = loadTimeframe(args.cacheDir, args.symbols, tf, hash);
    hash = loaded.datasetManifestHash;
    cacheCommits.push(...loaded.gitCommits);
    blocks.push(sanityOnlyBlockOf(buildSliceContext(loaded.arrays, slice, tf, maxHoldMsOf(tf)), args.symbols));
  }
  const gitCommit = gitCommitFromEnv();
  const report: SnipeSanityReport = {
    reportKind: 'snipe-sanity',
    schemaVersion: 1,
    datasetManifestHash: hash ?? '',
    gitCommit,
    binding: sanityBinding({ timeframes: args.timeframes, symbols: args.symbols, gitCommit, cacheCommits }),
    computedAt: new Date().toISOString(),
    slice: { start: SNIPE_DISCOVERY.start, end: SNIPE_DISCOVERY.end },
    seed: SANITY_SAMPLE_SEED,
    symbols: args.symbols,
    timeframes: args.timeframes,
    blocks,
  };
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  log(JSON.stringify(report, null, 2));
  return report;
}

export function runSnipeScan(args: SnipeScanArgs, log: (line: string) => void = console.log): SnipeDiscoveryReport | CellReport {
  const slice = discoverySlice();
  let hash: string | undefined;
  const cacheCommits: string[] = [];
  const cells: CellReport[] = [];
  const sanity: SanityBlock[] = [];

  for (const tf of TIMEFRAME_ORDER.filter((t) => args.timeframes.includes(t))) {
    const loaded = loadTimeframe(args.cacheDir, args.symbols, tf, hash);
    hash = loaded.datasetManifestHash;
    cacheCommits.push(...loaded.gitCommits);
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
  const gitCommit = gitCommitFromEnv();
  const binding = discoveryBinding({
    timeframes: args.timeframes,
    symbols: args.symbols,
    draws: args.draws,
    cells: cells.length,
    gitCommit,
    cacheCommits,
  });
  const rejected = benjaminiHochberg(cells.map(bhP), SNIPE_FDR_Q);
  const selected = selectForConfirmation(cells, SNIPE_FDR_Q);
  const report: SnipeDiscoveryReport = {
    reportKind: 'snipe-discovery',
    schemaVersion: 1,
    datasetManifestHash: hash ?? '',
    gitCommit,
    binding,
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
    `snipe-discovery ${report.verdict} (${binding ? 'binding' : 'NON-BINDING'}): ${cells.length} cells, ${rejected.filter(Boolean).length} BH-rejected, ` +
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
    const args = parseArgs(process.argv.slice(2));
    if (args.sanityOnly) runSnipeSanity(args);
    else runSnipeScan(args);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
