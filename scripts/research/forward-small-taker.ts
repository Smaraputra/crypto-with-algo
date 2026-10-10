/**
 * Forward test, cell B (small-trade taker imbalance, NEGATIVE IC) on the never-read window. The binding spec is
 * the header of forward-test.ts; every constant here is imported from it. Nothing is re-tuned.
 *
 *   npx tsx scripts/research/forward-small-taker.ts --dataset-dir D --out report.json [--draws 1000]
 *       [--window-end <ISO>]
 *
 * The statistic is factor-ic's own and the null is qh-flow-null's own (both called programmatically with
 * allowLockbox on, window FORWARD_WINDOW, 1h, horizon 1, execution lag 1, perp returns):
 * - observed pooled IC and per-symbol ICs come from buildFactorIcReport;
 * - the null (common-offset circular shift on the window's common grid, seed 7, 30 days) and the observed grid IC
 *   come from buildNullReport. qh-flow-null requires a null-only floor report before it reads an observed cell,
 *   so a null-only report is written first to `<out>.floor.json` and then handed to the observed run;
 * - z = (observed grid IC - null mean) / (1.25 x null sd), p = the normal lower tail (negative direction).
 *
 * PASS: pooled IC < 0 AND empiricalPLow < alpha AND z lower-tail p < alpha AND at least 7 symbols with IC < 0.
 */
import { writeFileSync } from 'fs';
import { normalCdf } from '@/lib/stats/normal';
import {
  FORWARD_ALPHA,
  FORWARD_B_BREAKEVEN_IC,
  FORWARD_B_SYMBOLS_AGREE,
  FORWARD_CELLS,
  FORWARD_NULL,
  FORWARD_WINDOW,
} from './forward-test';
import { buildFactorIcReport, parseArgs as parseFactorIcArgs } from './factor-ic';
import { buildNullReport, parseNullArgs, type NullCell } from './qh-flow-null';
import { gitCommitFromEnv, parseDraws, parseFlags, parseWindowEnd, type ForwardMode } from './snipe-cli';

export interface ForwardSmallTakerArgs {
  datasetDir: string;
  out: string;
  draws: number;
  /** ISO end of the measured window: FORWARD_WINDOW.end (binding) or a later instant (descriptive). */
  windowEnd: string;
  mode: ForwardMode;
}

const FLAGS = ['dataset-dir', 'out', 'draws', 'window-end'];

export function parseForwardSmallTakerArgs(argv: string[]): ForwardSmallTakerArgs {
  const flags = parseFlags(argv, FLAGS);
  const datasetDir = flags.get('dataset-dir');
  const out = flags.get('out');
  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');
  const { windowEnd, mode } = parseWindowEnd(flags.get('window-end'), FORWARD_WINDOW.end);
  return { datasetDir, out, windowEnd, mode, draws: parseDraws(flags.get('draws'), FORWARD_NULL.draws) };
}

/**
 * z = (observed grid IC - null mean) / (inflation x null sd) and its lower-tail normal p (the negative
 * direction). A null without a usable spread gives z NaN and p 1.
 */
export function negativeZ(
  obsGridIc: number,
  nullMean: number,
  nullSd: number,
  inflation: number = FORWARD_NULL.sdInflation
): { z: number; p: number } {
  const scale = inflation * nullSd;
  if (!Number.isFinite(obsGridIc) || !Number.isFinite(nullMean) || !Number.isFinite(scale) || scale <= 0) {
    return { z: Number.NaN, p: 1 };
  }
  const z = (obsGridIc - nullMean) / scale;
  return { z, p: normalCdf(z) };
}

/** Number of symbols whose IC is finite and below zero. */
export function negativeSymbolCount(ics: ReadonlyArray<number | null | undefined>): number {
  return ics.filter((ic) => typeof ic === 'number' && Number.isFinite(ic) && ic < 0).length;
}

/**
 * The pre-registered pass rule for B: a negative pooled IC, the empirical low-tail p and the inflated-z lower-tail
 * p each strictly below alpha, and at least FORWARD_B_SYMBOLS_AGREE symbols with a negative IC. NaN never passes.
 */
export function forwardSmallTakerPass(input: {
  pooledIc: number;
  empiricalPLow: number;
  zP: number;
  negativeSymbols: number;
  alpha?: number;
  symbolsAgree?: number;
}): boolean {
  const alpha = input.alpha ?? FORWARD_ALPHA;
  const agree = input.symbolsAgree ?? FORWARD_B_SYMBOLS_AGREE;
  return input.pooledIc < 0 && input.empiricalPLow < alpha && input.zP < alpha && input.negativeSymbols >= agree;
}

/** |IC| against the 1h taker and maker breakeven ICs of the header. */
export function breakevenLine(pooledIc: number): {
  taker: number;
  maker: number;
  absIc: number;
  aboveTaker: boolean;
  aboveMaker: boolean;
} {
  const absIc = Math.abs(pooledIc);
  return {
    taker: FORWARD_B_BREAKEVEN_IC.taker,
    maker: FORWARD_B_BREAKEVEN_IC.maker,
    absIc,
    aboveTaker: absIc > FORWARD_B_BREAKEVEN_IC.taker,
    aboveMaker: absIc > FORWARD_B_BREAKEVEN_IC.maker,
  };
}

export interface ForwardSmallTakerReport {
  reportKind: 'forward-small-taker';
  schemaVersion: 1;
  mode: ForwardMode;
  binding: boolean;
  datasetManifestHash: string;
  gitCommit: string;
  computedAt: string;
  window: { start: string; end: string };
  interval: '1h';
  factor: string;
  horizon: number;
  executionLag: number;
  returnSeries: 'perp';
  draws: number;
  seed: number;
  minShiftDays: number;
  sdInflation: number;
  alpha: number;
  symbols: string[];
  observed: {
    pooledIc: number;
    pooledT: number;
    pooledN: number;
    perSymbol: Array<{ symbol: string; ic: number | null; n: number | null }>;
    negativeSymbols: number;
    gridIc: number | null;
    gridT: number | null;
  };
  null: {
    mean: number;
    sd: number;
    validDraws: number;
    gridBars: number;
    minShiftBars: number;
    floorReport: string;
  };
  z: number;
  pValues: { empiricalPLow: number; empiricalPHigh: number; zLowerTail: number };
  breakevenIc: ReturnType<typeof breakevenLine>;
  /** The binding verdict, or null in descriptive mode (never a new pass/fail). */
  pass: boolean | null;
  /** Present (true) only in descriptive mode. */
  descriptiveOnly?: true;
}

/** `factor` defaults to the frozen B column; it is a parameter only so a test can run the pipeline on a column its fixture carries. */
export async function runForwardSmallTaker(
  args: ForwardSmallTakerArgs,
  log: (line: string) => void = console.log,
  factor: string = FORWARD_CELLS.B.column
): Promise<ForwardSmallTakerReport> {
  const cell = FORWARD_CELLS.B;
  const start = Date.parse(FORWARD_WINDOW.start);
  const end = Date.parse(args.windowEnd);

  // Observed: factor-ic's own pooled and per-symbol ICs.
  const ic = await buildFactorIcReport(
    parseFactorIcArgs([
      '--interval', cell.interval,
      '--dataset-dir', args.datasetDir,
      '--factors', factor,
      '--horizons', String(cell.horizon),
      '--execution-lag', String(cell.executionLag),
      '--return-series', cell.returnSeries,
      '--start', FORWARD_WINDOW.start,
      '--end', args.windowEnd,
      '--allow-lockbox',
    ])
  );
  const factorReport = ic.factors.find((f) => f.name === factor);
  const pooled = factorReport?.pooled.horizons.find((h) => h.horizon === cell.horizon);
  if (!factorReport || !pooled) {
    throw new Error(`forward-small-taker: factor-ic produced no pooled ${factor} h=${cell.horizon} statistic`);
  }
  const perSymbol = factorReport.perSymbol.map((p) => {
    const h = p.horizons.find((x) => x.horizon === cell.horizon);
    return { symbol: p.symbol, ic: h ? h.ic : null, n: h ? h.n : null };
  });

  // Null: a null-only floor report first, then the observed run that needs it.
  const nullArgv = (extra: string[]): string[] => [
    '--interval', cell.interval,
    '--dataset-dir', args.datasetDir,
    '--start', FORWARD_WINDOW.start,
    '--end', args.windowEnd,
    '--horizons', String(cell.horizon),
    '--factors', factor,
    '--execution-lag', String(cell.executionLag),
    '--return-series', cell.returnSeries,
    '--draws', String(args.draws),
    '--seed', String(FORWARD_NULL.seed),
    '--min-shift-days', String(FORWARD_NULL.minShiftDays),
    '--allow-lockbox',
    ...extra,
  ];
  const floorPath = `${args.out}.floor.json`;
  const floor = await buildNullReport(parseNullArgs(nullArgv(['--null-only'])));
  writeFileSync(floorPath, JSON.stringify(floor));
  const nullReport = await buildNullReport(
    parseNullArgs(nullArgv(['--with-observed', '--floor-report', floorPath]))
  );
  if (nullReport.datasetManifestHash !== ic.datasetManifestHash || floor.datasetManifestHash !== ic.datasetManifestHash) {
    throw new Error('forward-small-taker: dataset manifest hash differs between factor-ic and the null');
  }
  if (nullReport.args.start !== start || nullReport.args.end !== end) {
    throw new Error('forward-small-taker: the null did not run on the forward window');
  }
  const nullCell: NullCell | undefined = nullReport.cells.find((c) => c.factor === factor && c.horizon === cell.horizon);
  if (!nullCell || nullCell.observedGridIc == null || nullCell.empiricalPLow == null || nullCell.empiricalPHigh == null) {
    throw new Error(`forward-small-taker: the null produced no observed ${factor} h=${cell.horizon} cell (${nullCell?.reason ?? 'missing'})`);
  }

  const { z, p: zLowerTail } = negativeZ(nullCell.observedGridIc, nullCell.nullMeanIc, nullCell.nullSdIc);
  const negativeSymbols = negativeSymbolCount(perSymbol.map((p) => p.ic));
  const pass: boolean | null =
    args.mode === 'binding'
      ? forwardSmallTakerPass({
          pooledIc: pooled.ic,
          empiricalPLow: nullCell.empiricalPLow,
          zP: zLowerTail,
          negativeSymbols,
        })
      : null;

  const report: ForwardSmallTakerReport = {
    reportKind: 'forward-small-taker',
    schemaVersion: 1,
    mode: args.mode,
    binding: args.mode === 'binding',
    datasetManifestHash: ic.datasetManifestHash,
    gitCommit: gitCommitFromEnv(),
    computedAt: new Date().toISOString(),
    window: { start: FORWARD_WINDOW.start, end: args.windowEnd },
    interval: cell.interval,
    factor,
    horizon: cell.horizon,
    executionLag: cell.executionLag,
    returnSeries: cell.returnSeries,
    draws: args.draws,
    seed: FORWARD_NULL.seed,
    minShiftDays: FORWARD_NULL.minShiftDays,
    sdInflation: FORWARD_NULL.sdInflation,
    alpha: FORWARD_ALPHA,
    symbols: nullReport.symbols,
    observed: {
      pooledIc: pooled.ic,
      pooledT: pooled.icT,
      pooledN: pooled.n,
      perSymbol,
      negativeSymbols,
      gridIc: nullCell.observedGridIc,
      gridT: nullCell.observedGridT ?? null,
    },
    null: {
      mean: nullCell.nullMeanIc,
      sd: nullCell.nullSdIc,
      validDraws: nullCell.validDraws,
      gridBars: nullReport.grid.bars,
      minShiftBars: nullReport.minShiftBars,
      floorReport: floorPath,
    },
    z,
    pValues: { empiricalPLow: nullCell.empiricalPLow, empiricalPHigh: nullCell.empiricalPHigh, zLowerTail },
    breakevenIc: breakevenLine(pooled.ic),
    pass,
    ...(args.mode === 'descriptive' ? { descriptiveOnly: true as const } : {}),
  };
  writeFileSync(args.out, JSON.stringify(report, null, 2));

  log(`forward-small-taker ${pass === null ? 'DESCRIPTIVE' : pass ? 'PASS' : 'FAIL'} (window ${FORWARD_WINDOW.start} to ${args.windowEnd}, draws ${args.draws}, alpha ${FORWARD_ALPHA.toFixed(5)})`);
  log(
    `  pooled IC ${pooled.ic.toFixed(5)} (t ${pooled.icT.toFixed(2)}, n ${pooled.n}), grid IC ${nullCell.observedGridIc.toFixed(5)}, ` +
      `null mean ${nullCell.nullMeanIc.toFixed(5)} sd ${nullCell.nullSdIc.toFixed(5)}, z ${z.toFixed(3)}`
  );
  log(
    `  p: empirical low ${nullCell.empiricalPLow.toFixed(4)}, high ${nullCell.empiricalPHigh.toFixed(4)}, z lower tail ${zLowerTail.toExponential(2)}; ` +
      `negative symbols ${negativeSymbols}/${perSymbol.length} (need ${FORWARD_B_SYMBOLS_AGREE})`
  );
  log(
    `  |IC| ${report.breakevenIc.absIc.toFixed(5)} vs breakeven taker ${FORWARD_B_BREAKEVEN_IC.taker} maker ${FORWARD_B_BREAKEVEN_IC.maker}`
  );
  for (const p of perSymbol) log(`  ${p.symbol} IC ${p.ic == null ? 'n/a' : p.ic.toFixed(5)}`);
  return report;
}

if (require.main === module) {
  runForwardSmallTaker(parseForwardSmallTakerArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
