/**
 * Factor IC study CLI: for one interval, measures every (or a chosen subset
 * of) factor against forward returns at several horizons, per symbol and
 * pooled, and writes a FactorIcReport (schema in report-schema.ts).
 *
 * Usage:
 *   npx tsx scripts/research/factor-ic.ts --interval 1h
 *   npx tsx scripts/research/factor-ic.ts --interval 5m --symbols BTCUSDT,ETHUSDT --factors raw.ret1,raw.rsi
 *   npx tsx scripts/research/factor-ic.ts --interval 1h --cell raw.ret1:4:BTCUSDT
 *
 * Reads a dataset exported by export-dataset.ts (via load-dataset.ts's
 * lockbox-aware loaders) and never touches Mongo.
 */

import { execFileSync } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import {
  bootstrapCi,
  forwardReturns,
  icNonOverlapping,
  icWithHac,
  nonOverlappingIndices,
  quantileSpread,
  rollingByQuarter,
  signHitRate,
  spearman,
} from './ic-stats';
import { computeFactorMatrix, type FactorMatrix } from './factors';
import { loadCandles, loadHtf, loadManifest, loadSnapshots, verifyManifest } from './load-dataset';
import { evaluateSurvivors, validateFactorIcReport, type FactorIcReport, type FactorReport, type HorizonStat } from './report-schema';
import type { SnapshotRow } from './dataset-format';

const DEFAULT_HORIZONS = [1, 2, 4, 8, 16, 32];
// Snapshots are only ingested at 1h/4h/1d (see export-dataset.ts's
// SNAPSHOT_INTERVALS); no snapshot file exists for these two intervals.
const NO_SNAPSHOT_INTERVALS = new Set(['5m', '15m']);
// Matches icWithHac/icNonOverlapping/spearman's own minimum-pairs threshold
// (fewer pairs than this and those functions already return NaN).
const MIN_PAIRS = 3;

export interface FactorIcArgs {
  interval: string;
  symbols?: string[];
  horizons: number[];
  start?: number;
  end?: number;
  datasetDir: string;
  out: string;
  taskId: string;
  bootstrapN: number;
  bootstrapSeed: number;
  bootstrapPerSymbol: boolean;
  allowLockbox: boolean;
  factors?: string[];
  cell?: { factor: string; horizon: number; symbol?: string };
}

export interface CellResult {
  factor: string;
  horizon: number;
  symbol?: string;
  ic: number;
  n: number;
}

function parseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseIntList(value: string): number[] {
  return parseList(value).map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid horizon in --horizons: ${s}`);
    }
    return n;
  });
}

function parseIsoFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid --${name} date: ${value}`);
  }
  return ms;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function defaultTaskId(interval: string, now: Date): string {
  const stamp =
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
  return `factor-ic-${interval}-${stamp}`;
}

function parseCell(value: string): { factor: string; horizon: number; symbol?: string } {
  const parts = value.split(':');
  if (parts.length === 2) {
    const [factor, horizonStr] = parts;
    const horizon = Number(horizonStr);
    if (!factor || !Number.isFinite(horizon)) {
      throw new Error(`Invalid --cell value: ${value}, expected factor:horizon[:symbol]`);
    }
    return { factor, horizon };
  }
  if (parts.length === 3) {
    const [factor, horizonStr, symbol] = parts;
    const horizon = Number(horizonStr);
    if (!factor || !Number.isFinite(horizon) || !symbol) {
      throw new Error(`Invalid --cell value: ${value}, expected factor:horizon[:symbol]`);
    }
    return { factor, horizon, symbol };
  }
  throw new Error(`Invalid --cell value: ${value}, expected factor:horizon[:symbol]`);
}

// These two flags are presence-only switches (no following value), unlike
// every other flag in this CLI.
const BOOLEAN_FLAGS = new Set(['allow-lockbox', 'bootstrap-per-symbol']);

/** Pure CLI argument parsing. `now` is injectable so default-taskId tests are deterministic. */
export function parseArgs(argv: string[], now: Date = new Date()): FactorIcArgs {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      booleans.add(key);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }
    flags.set(key, value);
    i++;
  }

  const interval = flags.get('interval');
  if (!interval) {
    throw new Error('--interval is required');
  }

  const taskId = flags.get('task-id') ?? defaultTaskId(interval, now);
  const out = flags.get('out') ?? `data/research/reports/factor-ic-${interval}-${taskId}.json`;

  return {
    interval,
    symbols: flags.has('symbols') ? parseList(flags.get('symbols')!) : undefined,
    horizons: flags.has('horizons') ? parseIntList(flags.get('horizons')!) : [...DEFAULT_HORIZONS],
    start: parseIsoFlag(flags.get('start'), 'start'),
    end: parseIsoFlag(flags.get('end'), 'end'),
    datasetDir: flags.get('dataset-dir') ?? 'data/research',
    out,
    taskId,
    bootstrapN: flags.has('bootstrap-n') ? Number(flags.get('bootstrap-n')) : 1000,
    bootstrapSeed: flags.has('bootstrap-seed') ? Number(flags.get('bootstrap-seed')) : 42,
    bootstrapPerSymbol: booleans.has('bootstrap-per-symbol'),
    allowLockbox: booleans.has('allow-lockbox'),
    factors: flags.has('factors') ? parseList(flags.get('factors')!) : undefined,
    cell: flags.has('cell') ? parseCell(flags.get('cell')!) : undefined,
  };
}

interface SymbolData {
  symbol: string;
  matrix: FactorMatrix;
  lockboxApplied: boolean;
}

function inRange(t: number, start: number | undefined, end: number | undefined): boolean {
  if (start !== undefined && t < start) return false;
  if (end !== undefined && t > end) return false;
  return true;
}

function loadSymbolData(
  datasetDir: string,
  symbol: string,
  interval: string,
  opts: { allowLockbox: boolean; start?: number; end?: number }
): SymbolData {
  const candleResult = loadCandles(datasetDir, symbol, interval, { allowLockbox: opts.allowLockbox });
  const htfResult = loadHtf(datasetDir, symbol, interval, { allowLockbox: opts.allowLockbox });

  const candles = candleResult.rows.filter((r) => inRange(r.t, opts.start, opts.end));
  const htf = htfResult.rows.filter((r) => inRange(r.t, opts.start, opts.end));

  const snapshots: SnapshotRow[] | null = NO_SNAPSHOT_INTERVALS.has(interval)
    ? null
    : loadSnapshots(datasetDir, symbol, interval, { allowLockbox: opts.allowLockbox }).rows.filter((r) =>
        inRange(r.t, opts.start, opts.end)
      );

  const matrix = computeFactorMatrix({ candles, snapshots, htf, interval });

  return { symbol, matrix, lockboxApplied: !opts.allowLockbox };
}

/**
 * Builds one HorizonStat, or null when there is not enough usable data at
 * this horizon (fewer than MIN_PAIRS valid pairs, overlapping or
 * non-overlapping) to produce a well-defined statistic. This is the gate
 * that keeps every published field a real, finite number: a factor with no
 * data at all for this interval (e.g. a funding-rate-derived factor on 5m/
 * 15m, which never has snapshot data) simply produces no HorizonStat here,
 * rather than one full of NaN.
 */
function buildHorizonStat(
  factorArr: number[],
  fwd: (number | null)[],
  horizon: number,
  bootstrap: { iterations: number; seed: number } | null
): HorizonStat | null {
  const overlap = icWithHac(factorArr, fwd, horizon);
  if (overlap.n < MIN_PAIRS || !Number.isFinite(overlap.ic) || !Number.isFinite(overlap.t)) {
    return null;
  }

  const nonOverlap = icNonOverlapping(factorArr, fwd, horizon);
  if (nonOverlap.n < MIN_PAIRS || !Number.isFinite(nonOverlap.ic)) {
    return null;
  }

  const idxs = nonOverlappingIndices(Math.min(factorArr.length, fwd.length), horizon, 0);
  const factorSub = idxs.map((i) => factorArr[i]);
  const fwdSub = idxs.map((i) => fwd[i] ?? NaN);

  const hitRate = signHitRate(factorSub, fwdSub);
  const spread = quantileSpread(factorSub, fwdSub);
  if (
    !Number.isFinite(hitRate) ||
    !Number.isFinite(spread.top) ||
    !Number.isFinite(spread.bottom) ||
    !Number.isFinite(spread.spread)
  ) {
    return null;
  }

  let bootstrapCi95: [number, number] | null = null;
  if (bootstrap) {
    const ci = bootstrapCi(factorArr, fwd, (f, r) => spearman(f, r), {
      iterations: bootstrap.iterations,
      meanBlockLen: horizon,
      seed: bootstrap.seed,
    });
    if (Number.isFinite(ci.low) && Number.isFinite(ci.high)) {
      bootstrapCi95 = [ci.low, ci.high];
    }
  }

  return {
    horizon,
    n: overlap.n,
    ic: overlap.ic,
    icT: overlap.t,
    nNonOverlapping: nonOverlap.n,
    icNonOverlapping: nonOverlap.ic,
    signHitRate: hitRate,
    bootstrapCi95,
    quantileSpread: spread,
  };
}

function buildRollingQuarterly(
  timestamps: number[],
  factorArr: number[],
  fwd: (number | null)[],
  horizon: number
): FactorReport['rollingQuarterly'] {
  return rollingByQuarter(timestamps, factorArr, fwd, horizon)
    .filter((r) => r.n >= MIN_PAIRS && Number.isFinite(r.ic) && Number.isFinite(r.t))
    .map((r) => ({ quarter: r.quarter, horizon, ic: r.ic, n: r.n, t: r.t }));
}

function resolveCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Full, file-free computation pipeline: verifies the dataset, loads every
 * requested symbol, computes every requested factor's per-symbol and pooled
 * statistics plus rolling-quarterly IC, and returns a schema-validated
 * report. Throws on a manifest mismatch, an unknown requested factor, or a
 * report that fails validation.
 */
export async function buildFactorIcReport(args: FactorIcArgs): Promise<FactorIcReport> {
  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  const symbols = args.symbols && args.symbols.length > 0 ? args.symbols : manifest.symbols;

  console.error(`[factor-ic] interval=${args.interval} symbols=${symbols.join(',')} horizons=${args.horizons.join(',')}`);

  const perSymbolData: SymbolData[] = [];
  for (const symbol of symbols) {
    console.error(`[factor-ic] loading ${symbol}...`);
    perSymbolData.push(
      loadSymbolData(args.datasetDir, symbol, args.interval, {
        allowLockbox: args.allowLockbox,
        start: args.start,
        end: args.end,
      })
    );
  }
  const lockboxApplied = perSymbolData.every((s) => s.lockboxApplied);

  // Union of factor names across symbols' matrices, first-seen order (they
  // agree on raw.*/cat.*/composite; sig.* can differ when a signal never
  // fires for a given symbol's data).
  const nameOrder: string[] = [];
  const nameCategory = new Map<string, string>();
  for (const data of perSymbolData) {
    data.matrix.names.forEach((name, i) => {
      if (!nameCategory.has(name)) {
        nameCategory.set(name, data.matrix.categories[i]);
        nameOrder.push(name);
      }
    });
  }

  let requestedFactors = nameOrder;
  if (args.factors) {
    const missing = args.factors.filter((f) => !nameCategory.has(f));
    if (missing.length > 0) {
      throw new Error(`Unknown factor(s) requested: ${missing.join(', ')}`);
    }
    requestedFactors = args.factors;
  }

  const bootstrapPerSymbolOpt = args.bootstrapPerSymbol
    ? { iterations: args.bootstrapN, seed: args.bootstrapSeed }
    : null;
  // Pooled bootstrapCi95 is always computed per the brief, for every
  // requested factor x horizon. Its cost is dominated by re-ranking (an
  // O(m log m) sort, twice) per iteration on the pooled series, which for a
  // full 5m/10-symbol run (~1M pooled bars) is on the order of ~1s per
  // iteration -- see the concerns section of the C3 report for measured
  // numbers and a recommended --bootstrap-n for full production runs.
  const bootstrapPooledOpt = { iterations: args.bootstrapN, seed: args.bootstrapSeed };

  // forwardReturns depends only on (symbol, horizon), not on the factor, so
  // it is computed once per pair and reused across every requested factor.
  const fwdCache = new Map<string, (number | null)[]>();
  function fwdFor(symbolIdx: number, horizon: number): (number | null)[] {
    const key = `${symbolIdx}:${horizon}`;
    let cached = fwdCache.get(key);
    if (!cached) {
      cached = forwardReturns(perSymbolData[symbolIdx].matrix.closes, horizon);
      fwdCache.set(key, cached);
    }
    return cached;
  }

  const factorReports: FactorReport[] = [];

  for (const factorName of requestedFactors) {
    console.error(`[factor-ic] computing ${factorName}...`);

    const perSymbol: FactorReport['perSymbol'] = [];
    // Per-symbol arrays retained for pooling below (null when this symbol's
    // matrix never discovered this factor at all, e.g. a sig.* that never fired).
    const symbolFactorArrays: Array<number[] | null> = [];

    for (let s = 0; s < perSymbolData.length; s++) {
      const { matrix } = perSymbolData[s];
      const idx = matrix.names.indexOf(factorName);
      if (idx === -1) {
        symbolFactorArrays.push(null);
        continue;
      }
      // Float64Array must not be passed directly into ic-stats.ts's functions:
      // they call .map/.reduce expecting a plain number[] result, which
      // Float64Array.prototype.map does not produce.
      const factorArr = Array.from(matrix.values[idx]);
      symbolFactorArrays.push(factorArr);

      const horizonsForSymbol: HorizonStat[] = [];
      for (const h of args.horizons) {
        const stat = buildHorizonStat(factorArr, fwdFor(s, h), h, bootstrapPerSymbolOpt);
        if (stat) horizonsForSymbol.push(stat);
      }
      if (horizonsForSymbol.length > 0) {
        perSymbol.push({ symbol: perSymbolData[s].symbol, horizons: horizonsForSymbol });
      }
    }

    // Pooled: concatenate every symbol's factor and forward-return series in
    // symbol order. Uses .concat, not push(...array)/Math.min(...array): a
    // spread that large would risk exceeding the engine's call-argument limit.
    let pooledFactor: number[] = [];
    let pooledTimestamps: number[] = [];
    for (let s = 0; s < perSymbolData.length; s++) {
      const arr = symbolFactorArrays[s];
      if (arr) {
        pooledFactor = pooledFactor.concat(arr);
        pooledTimestamps = pooledTimestamps.concat(perSymbolData[s].matrix.timestamps);
      }
    }

    const pooledHorizons: HorizonStat[] = [];
    const rollingQuarterly: FactorReport['rollingQuarterly'] = [];

    for (const h of args.horizons) {
      let pooledFwd: (number | null)[] = [];
      for (let s = 0; s < perSymbolData.length; s++) {
        if (symbolFactorArrays[s]) {
          pooledFwd = pooledFwd.concat(fwdFor(s, h));
        }
      }

      const stat = buildHorizonStat(pooledFactor, pooledFwd, h, bootstrapPooledOpt);
      if (stat) pooledHorizons.push(stat);

      rollingQuarterly.push(...buildRollingQuarterly(pooledTimestamps, pooledFactor, pooledFwd, h));
    }

    if (pooledHorizons.length === 0) {
      // No usable signal anywhere for this factor at this interval (e.g. a
      // funding/sentiment-derived factor on 5m/15m, which never has snapshot
      // data). Omit it rather than encode "no data" as NaN in a report whose
      // numeric fields are all plain, schema-validated numbers.
      console.error(`[factor-ic] skipping ${factorName}: no usable data at any horizon`);
      continue;
    }

    factorReports.push({
      name: factorName,
      category: nameCategory.get(factorName) ?? 'unknown',
      perSymbol,
      pooled: { horizons: pooledHorizons },
      rollingQuarterly,
    });
  }

  let startMs = Infinity;
  let endMs = -Infinity;
  for (const data of perSymbolData) {
    for (const t of data.matrix.timestamps) {
      if (t < startMs) startMs = t;
      if (t > endMs) endMs = t;
    }
  }
  const dateRange = {
    startMs: Number.isFinite(startMs) ? startMs : 0,
    endMs: Number.isFinite(endMs) ? endMs : 0,
  };

  const report: FactorIcReport = {
    schemaVersion: 1,
    taskId: args.taskId,
    datasetManifestHash: manifest.datasetHash,
    lockboxApplied,
    interval: args.interval,
    symbols,
    horizons: args.horizons,
    dateRange,
    computedAt: new Date().toISOString(),
    gitCommit: resolveCommit(),
    bootstrap: {
      iterations: args.bootstrapN,
      seed: args.bootstrapSeed,
      perSymbol: args.bootstrapPerSymbol,
    },
    factors: factorReports,
  };

  const validated = validateFactorIcReport(report);
  if (!validated.ok) {
    throw new Error(`factor-ic report failed schema validation:\n${validated.issues.join('\n')}`);
  }

  return validated.data;
}

function formatTopTable(report: FactorIcReport): string {
  const rows: Array<{ factor: string; horizon: number; ic: number; icT: number; n: number }> = [];
  for (const factor of report.factors) {
    for (const h of factor.pooled.horizons) {
      rows.push({ factor: factor.name, horizon: h.horizon, ic: h.ic, icT: h.icT, n: h.n });
    }
  }
  rows.sort((a, b) => Math.abs(b.icT) - Math.abs(a.icT));
  const top = rows.slice(0, 15);

  const header = ['factor', 'horizon', 'ic', 'icT', 'n'].map((h) => h.padEnd(10)).join('');
  const lines = top.map((r) =>
    [
      r.factor.padEnd(28),
      String(r.horizon).padEnd(10),
      r.ic.toFixed(4).padEnd(10),
      r.icT.toFixed(2).padEnd(10),
      String(r.n),
    ].join('')
  );
  return [header, ...lines].join('\n');
}

/** Computes and writes the full report, then prints a top-factors table and survivor count. */
export async function runFactorIc(args: FactorIcArgs): Promise<FactorIcReport> {
  const report = await buildFactorIcReport(args);

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.error(`[factor-ic] wrote ${args.out}`);

  console.log(formatTopTable(report));
  const survivors = evaluateSurvivors(report).filter((row) => row.survivor).length;
  console.log(`survivors: ${survivors} / ${report.factors.length} factors`);

  return report;
}

/**
 * Recomputes one (factor, horizon[, symbol]) cell -- pooled across
 * --symbols/the manifest's symbols when no symbol is given -- and prints it
 * as JSON to stdout. Writes no file; used by the orchestrator to spot-check
 * a subagent's report (see report-schema.ts's spotCheckCell).
 */
export async function runCell(args: FactorIcArgs): Promise<CellResult> {
  if (!args.cell) {
    throw new Error('runCell requires args.cell');
  }
  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const { factor: factorName, horizon, symbol } = args.cell;

  let ic: number;
  let n: number;

  if (symbol) {
    const data = loadSymbolData(args.datasetDir, symbol, args.interval, {
      allowLockbox: args.allowLockbox,
      start: args.start,
      end: args.end,
    });
    const idx = data.matrix.names.indexOf(factorName);
    if (idx === -1) {
      throw new Error(`Factor "${factorName}" not present for symbol ${symbol}`);
    }
    const factorArr = Array.from(data.matrix.values[idx]);
    const result = icWithHac(factorArr, forwardReturns(data.matrix.closes, horizon), horizon);
    ic = result.ic;
    n = result.n;
  } else {
    const manifest = loadManifest(args.datasetDir);
    const symbols = args.symbols && args.symbols.length > 0 ? args.symbols : manifest.symbols;

    let pooledFactor: number[] = [];
    let pooledFwd: (number | null)[] = [];
    let foundAny = false;
    for (const sym of symbols) {
      const data = loadSymbolData(args.datasetDir, sym, args.interval, {
        allowLockbox: args.allowLockbox,
        start: args.start,
        end: args.end,
      });
      const idx = data.matrix.names.indexOf(factorName);
      if (idx === -1) continue;
      foundAny = true;
      pooledFactor = pooledFactor.concat(Array.from(data.matrix.values[idx]));
      pooledFwd = pooledFwd.concat(forwardReturns(data.matrix.closes, horizon));
    }
    if (!foundAny) {
      throw new Error(`Factor "${factorName}" not present for any of: ${symbols.join(', ')}`);
    }
    const result = icWithHac(pooledFactor, pooledFwd, horizon);
    ic = result.ic;
    n = result.n;
  }

  const cellResult: CellResult = { factor: factorName, horizon, ic, n, ...(symbol ? { symbol } : {}) };
  console.log(JSON.stringify(cellResult));
  return cellResult;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cell) {
    await runCell(args);
  } else {
    await runFactorIc(args);
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
