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
 *
 * Phase 3 results (2026-09-18, dataset 3fdeac9e495e3051ad2e2c7553be6b07b1da0d7b9e84f468d635d2708c624782,
 * commit f7946f4, lockbox applied so every window ends 2026-06-30, ten
 * symbols, horizons 1,2,4,8,16,32, bootstrap 200 draws seed 42; reports
 * under data/research/reports/factor-ic-<interval>-p3.json, one random cell
 * per report re-run with --cell --report and reproduced digit for digit).
 * Survivor rule: pooled |ic| >= 0.02 and |t| >= 2.5 at two or more horizons,
 * same sign in 60% of quarters and in seven of ten symbols. Sign is the
 * sign of the pooled IC; "+" means a higher reading precedes a higher
 * forward return. Survivors per interval: 5m 21 of 30, 1h 18 of 40,
 * 4h 4 of 40, 1d 2 of 35.
 *
 *   factor              5m                1h              4h            1d
 *   composite           .                 - h8,16         .             .
 *   cat.trend           - h1-32           - h1-16         .             .
 *   sig.EMA Cross       - h1-32           - h1-16         .             .
 *   sig.SMA Trend       - h1-32           .               .             .
 *   sig.SuperTrend      - h1-16           - h2-16         .             .
 *   sig.Ichimoku        .                 - h1,2,4        .             .
 *   sig.MACD            - h1-32           .               .             .
 *   cat.htf, HTF sigs   - h8-32           .               .             .
 *   raw.emaSpreadPct    - h1-32           - h2-16         .             .
 *   cat.momentum        + h1,2,4          .               + h2,4        .
 *   sig.Williams %R     + h1-32           + h1,2,4        .             .
 *   sig.StochRSI        .                 .               + h2,4        .
 *   raw.rsi             - h1-32           - h1-8          .             .
 *   cat.volatility      + h1-32           + h1-8          .             .
 *   sig.Bollinger       + h1-32           + h1-8          .             .
 *   cat.volume          .                 - h1,2          .             .
 *   sig.OBV             - h1-16           - h1,2,4        .             .
 *   sig.Volume          - h1,2,4          .               .             .
 *   sig.Taker Flow      .                 - h1,2          .             .
 *   raw.takerBuyRatio   .                 - h1,2          .             .
 *   raw.longShortRatio  (no data)         - h4,8,32       .             - h4,8,32
 *   raw.ret1            - h1-8            - h1,2,4        - h1,2        - h1,2,4,32
 *   raw.ret5            - h1-32           - h1-8          - h1-8        .
 *   raw.ret20           - h1-32           - h1-32         .             .
 *
 * Reading: intraday (5m, 1h) every trend-following input, the composite
 * included, predicts with the wrong sign, and mean reversion dominates:
 * past returns, RSI, and buying pressure (OBV, Volume, Taker Flow, taker
 * buy ratio) precede lower returns, while oversold readings (Williams %R,
 * Bollinger lower band, which is the whole volatility category once ATR
 * is excluded) precede higher ones. Strongest cells: raw.rsi 5m h1
 * ic -0.046 t -39.6, cat.volatility 5m h2 ic 0.047 t 36.6, raw.ret5 5m h1
 * ic -0.043 t -35.3, cat.trend 5m h1 ic -0.032 t -27.1, raw.ret1 1h h1
 * ic -0.048 t -27.7. At 4h only short-horizon momentum (cat.momentum,
 * StochRSI) and 1 to 8 bar return reversal survive; at 1d only 1 bar
 * reversal and the long/short ratio (500-bar sample). The composite is
 * negative at 1h (h8 ic -0.022 t -6.5), positive but below the effect
 * floor at 5m h1,2 and at 4h, and uninformative at 1d. The contrarian
 * sentiment category is on the wrong side at 4h and 1d (t -3.7 to -5.0,
 * fails only on quarter agreement): the raw Fear & Greed index has a
 * positive IC at 1d (h8 ic 0.063 t 4.1). Effect sizes are small (pooled
 * |ic| 0.02 to 0.05) and measured before costs; whether any survives the
 * cost model is the Phase 4 harness question.
 *
 * Caveats: 5m ran with snapshots forced null (cat.futures, cat.sentiment,
 * raw.fundingRate, raw.longShortRatio, raw.fearGreed skipped), which is
 * this CLI's documented divergence from live scoring; long/short ratio
 * and open interest cover only the last 500 bars of their interval; the
 * factor matrix keeps Ichimoku at 5m where live scoring nulls it;
 * sig.ATR has no directional reading and is skipped everywhere.
 *
 * bootstrapCi95 is a fixed-rank block bootstrap of the IC: ranks are
 * computed once per (sub)sample (ic-stats.ts's standardizedRankProducts),
 * not recomputed inside every resample, and only the resulting per-pair
 * products are block-bootstrapped (bootstrapCiOfMean). This is an
 * approximation -- a resample's "true" rank correlation would re-rank its
 * own resampled values -- but a standard one at this sample size: re-ranking
 * on every resample (ic-stats.ts's own bootstrapCi, still available there,
 * unused by this CLI) was measured at roughly 21 seconds per gated cell at
 * this file's maxPairs/iterations defaults; see the C3 report's fix-round 2
 * entry for the fixed-rank measurement and the round 1 entry for the
 * re-ranking one.
 *
 * Memory and wall time at 5m scale (10 symbols x ~105,000 bars each):
 * - The forward-return cache (fwdFor) is a Float64Array per (symbol,
 *   horizon), not a (number | null)[]: at 10 symbols x 6 default horizons x
 *   105,000 bars, a boxed (number | null)[] cache measured 144.2 MB on the
 *   V8 heap (each element boxed once `null` appears anywhere in the array,
 *   which disqualifies V8's packed-double fast path); the Float64Array
 *   version measured ~48.1 MB, and critically, entirely OFF the V8 heap (in
 *   ArrayBuffer/external memory, not subject to V8's heap-size limits or
 *   its GC the same way). Measured directly against these two
 *   representations at this exact shape, not against the whole CLI.
 * - Wall time: computeFactorMatrix itself (indicator + composite scoring,
 *   all factors) measured 0.0112ms/bar on a 10,000-bar 1h fixture, which
 *   extrapolates linearly to about 12s for 10 symbols x 105,000 bars.
 *   icWithHac/icNonOverlapping/signHitRate/quantileSpread together measured
 *   174ms per (factor, horizon) at a single symbol's 105,000 rows and 2.1s
 *   per (factor, horizon) at the ~1.05M-row pooled scale. Across every
 *   factor this style/interval combination discovers (measured 38 for a
 *   day_trading/1h fixture) at the default 6 horizons, that extrapolates to
 *   roughly 400s (per-symbol) + 470s (pooled) + rolling-quarterly and the
 *   gated bootstrap (small in comparison, seconds to low tens of seconds
 *   given the ~0.3s/gated-cell figure above) -- on the order of 15-18
 *   minutes for a full, unrestricted run. Restricting --factors to a
 *   curated subset (as every test fixture in this file's test suite does)
 *   reduces this proportionally; see the C3 report's fix-round entry for
 *   the benchmark methodology and raw numbers.
 */

import { execFileSync } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import {
  bootstrapCiOfMean,
  forwardReturns,
  icNonOverlapping,
  icWithHac,
  nonOverlappingIndices,
  quantileSpread,
  rollingByQuarter,
  signHitRate,
  standardizedRankProducts,
} from './ic-stats';
import { computeFactorMatrix, type FactorMatrix } from './factors';
import { loadCandles, loadHtf, loadManifest, loadSnapshots, verifyManifest } from './load-dataset';
import {
  evaluateSurvivors,
  validateFactorIcReport,
  type FactorIcReport,
  type FactorReport,
  type HorizonStat,
} from './report-schema';
import type { SnapshotRow } from './dataset-format';

const DEFAULT_HORIZONS = [1, 2, 4, 8, 16, 32];
// Snapshots are only ingested at 1h/4h/1d (see export-dataset.ts's
// SNAPSHOT_INTERVALS); no snapshot file exists for these two intervals.
const NO_SNAPSHOT_INTERVALS = new Set(['5m', '15m']);
// Matches icWithHac/icNonOverlapping/spearman's own minimum-pairs threshold
// (fewer pairs than this and those functions already return NaN).
const MIN_PAIRS = 3;
// Pooled bootstrapCi95 is only attempted for cells whose pooled HAC |icT|
// clears this gate -- a candidate for the survivor rule (SURVIVOR_RULE.minT
// is 2.5; this gate is deliberately its own, slightly looser, constant).
// Cells below it carry bootstrapCi95: null rather than paying for a wide
// interval on a cell nobody will treat as a finding.
const BOOTSTRAP_GATE_ABS_T = 2;
// Upper bound on how many (factor, forward-return) rows feed one bootstrapCi
// call; see subsampleForBootstrap below for how a larger pooled series is
// reduced to this size.
const DEFAULT_BOOTSTRAP_MAX_PAIRS = 100_000;

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
  bootstrapMaxPairs: number;
  allowLockbox: boolean;
  factors?: string[];
  cell?: { factor: string; horizon: number; symbol?: string };
  /** Abort if the loaded dataset's manifest.datasetHash does not equal this. */
  expectManifestHash?: string;
  /**
   * --cell only: a FactorIcReport file whose symbols/window/lockbox setting
   * this cell run must reproduce exactly (see runCell). --symbols/--start/
   * --end/--allow-lockbox are ignored when this is set.
   */
  reportPath?: string;
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
    // Non-positive horizons are rejected here, not left to fail downstream:
    // nonOverlappingIndices(n, h<=0) would otherwise loop forever (i += h
    // never advances past 0, or moves backward for a negative h).
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid horizon in --horizons: "${s}" (must be a positive integer)`);
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

// Every flag that takes a following value. An unrecognized --flag is
// rejected rather than silently absorbed as a no-op (and its value token
// silently swallowed) so a typo fails loudly instead of quietly doing
// nothing.
const VALUE_FLAGS = new Set([
  'interval',
  'symbols',
  'horizons',
  'start',
  'end',
  'dataset-dir',
  'out',
  'task-id',
  'bootstrap-n',
  'bootstrap-seed',
  'bootstrap-max-pairs',
  'factors',
  'cell',
  'expect-manifest-hash',
  'report',
]);

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
    if (!VALUE_FLAGS.has(key)) {
      throw new Error(`Unknown flag --${key}`);
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
    bootstrapN: flags.has('bootstrap-n') ? Number(flags.get('bootstrap-n')) : 200,
    bootstrapSeed: flags.has('bootstrap-seed') ? Number(flags.get('bootstrap-seed')) : 42,
    bootstrapPerSymbol: booleans.has('bootstrap-per-symbol'),
    bootstrapMaxPairs: flags.has('bootstrap-max-pairs')
      ? Number(flags.get('bootstrap-max-pairs'))
      : DEFAULT_BOOTSTRAP_MAX_PAIRS,
    allowLockbox: booleans.has('allow-lockbox'),
    factors: flags.has('factors') ? parseList(flags.get('factors')!) : undefined,
    cell: flags.has('cell') ? parseCell(flags.get('cell')!) : undefined,
    expectManifestHash: flags.get('expect-manifest-hash'),
    reportPath: flags.get('report'),
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

  // Same invariant computeFactorMatrix itself checks (belt and suspenders:
  // a misalignment here is a bug in this loader's own filtering, a
  // misalignment there is a bug in whatever calls computeFactorMatrix).
  if (htf.length !== candles.length) {
    throw new Error(
      `Candle/HTF row count mismatch for ${symbol} ${interval}: ${candles.length} candles vs ${htf.length} htf rows`
    );
  }
  for (let i = 0; i < candles.length; i++) {
    if (htf[i].t !== candles[i].t) {
      throw new Error(
        `Candle/HTF timestamp misalignment for ${symbol} ${interval} at index ${i}: candle t=${candles[i].t}, htf t=${htf[i].t}`
      );
    }
  }

  const snapshots: SnapshotRow[] | null = NO_SNAPSHOT_INTERVALS.has(interval)
    ? null
    : loadSnapshots(datasetDir, symbol, interval, { allowLockbox: opts.allowLockbox }).rows.filter((r) =>
        inRange(r.t, opts.start, opts.end)
      );

  const matrix = computeFactorMatrix({ candles, snapshots, htf, interval });

  return { symbol, matrix, lockboxApplied: !opts.allowLockbox };
}

// Number of equal strata the pooled series is split into when it needs
// subsampling for the bootstrap; see subsampleForBootstrap.
const SUBSAMPLE_BLOCK_COUNT = 20;

/** mulberry32: same small seeded PRNG as ic-stats.ts's own (unexported) one, reimplemented locally for the subsample below. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically picks at most maxLen indices out of [0, len) as
 * SUBSAMPLE_BLOCK_COUNT contiguous blocks, one per equal stratum of the
 * range, each at a seeded-random offset within its stratum. Each block
 * stays an unbroken run of the original series, so the autocorrelation/
 * block structure inside it survives untouched -- only which slabs are kept
 * is randomized, not the order of what is inside them. Stratifying across
 * the whole range (rather than one single contiguous slice of length
 * maxLen) keeps every part of a multi-symbol pooled series represented,
 * instead of a slice that could land entirely inside one symbol's data.
 * Deterministic for a given (len, maxLen, seed).
 */
function pickSubsampleIndices(len: number, maxLen: number, seed: number): number[] {
  if (len <= maxLen) {
    const all = new Array<number>(len);
    for (let i = 0; i < len; i++) all[i] = i;
    return all;
  }

  const rng = mulberry32(seed);
  const blockCount = Math.min(SUBSAMPLE_BLOCK_COUNT, len);
  const strataSize = Math.floor(len / blockCount);
  const blockLen = Math.max(1, Math.floor(maxLen / blockCount));

  const indices: number[] = [];
  for (let b = 0; b < blockCount; b++) {
    const strataStart = b * strataSize;
    const strataEnd = b === blockCount - 1 ? len : strataStart + strataSize;
    const available = Math.max(1, strataEnd - strataStart - blockLen);
    const offset = strataStart + Math.floor(rng() * available);
    const end = Math.min(strataEnd, offset + blockLen);
    for (let i = offset; i < end; i++) indices.push(i);
  }
  return indices;
}

/**
 * Reduces (factor, fwd) to at most maxPairs positionally-aligned rows before
 * they reach standardizedRankProducts/bootstrapCiOfMean, when the pooled
 * series is larger than that. A pooled 5m/10-symbol series is on the order
 * of 1M rows; ranking is O(m log m) even done once, and each bootstrap
 * iteration is still O(m), so bounding the input size bounds both the
 * one-time ranking cost and the per-iteration cost regardless of how large
 * the underlying dataset is. Below maxPairs, both arrays are returned
 * unchanged.
 */
function subsampleForBootstrap(
  factor: number[],
  fwd: (number | null)[],
  maxPairs: number,
  seed: number
): { factor: number[]; fwd: (number | null)[] } {
  const len = Math.min(factor.length, fwd.length);
  if (len <= maxPairs) return { factor, fwd };

  const indices = pickSubsampleIndices(len, maxPairs, seed);
  return {
    factor: indices.map((i) => factor[i]),
    fwd: indices.map((i) => fwd[i]),
  };
}

/**
 * Concatenates Float64Arrays into one. Not `[].concat(...)`: TypedArrays are
 * not concat-spreadable (per the ES spec), so `[].concat(float64arr)` pushes
 * the whole array as a single nested element instead of spreading its
 * numbers -- a real correctness bug, not just a style choice.
 */
function concatFloat64(chunks: Float64Array[]): Float64Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float64Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Builds one HorizonStat, or null when there is not enough usable data at
 * this horizon (fewer than MIN_PAIRS valid pairs, overlapping or
 * non-overlapping) to produce a well-defined statistic. This is the gate
 * that keeps every published field a real, finite number: a factor with no
 * data at all for this interval (e.g. a funding-rate-derived factor on 5m/
 * 15m, which never has snapshot data) simply produces no HorizonStat here,
 * rather than one full of NaN.
 *
 * `fwdTyped` is a Float64Array (NaN as the missing sentinel), not the
 * `(number | null)[]` ic-stats.ts's functions take: it is converted to a
 * plain array once here and reused for every statistic this cell computes,
 * so the caller's long-lived forward-return cache (see fwdFor) can stay in
 * the compact, unboxed Float64Array representation instead of the ~3-4x
 * larger boxed-element array `(number | null)[]` forces in V8 once `null`
 * appears in it.
 */
function buildHorizonStat(
  factorArr: number[],
  fwdTyped: Float64Array,
  horizon: number,
  bootstrap: { iterations: number; seed: number; maxPairs: number; gateAbsT: number | null } | null
): HorizonStat | null {
  const fwd: (number | null)[] = Array.from(fwdTyped);
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
  if (bootstrap && (bootstrap.gateAbsT === null || Math.abs(overlap.t) >= bootstrap.gateAbsT)) {
    const sample = subsampleForBootstrap(factorArr, fwd, bootstrap.maxPairs, bootstrap.seed);
    // Fixed-rank block bootstrap (see this file's header comment): ranks are
    // computed once by standardizedRankProducts, not re-ranked per resample,
    // so bootstrapCiOfMean only resamples and averages -- O(n) per
    // iteration, no sorting.
    const d = standardizedRankProducts(sample.factor, sample.fwd);
    const ci = bootstrapCiOfMean(d, {
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
  fwdTyped: Float64Array,
  horizon: number
): FactorReport['rollingQuarterly'] {
  const fwd: (number | null)[] = Array.from(fwdTyped);
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
  if (args.expectManifestHash !== undefined && manifest.datasetHash !== args.expectManifestHash) {
    throw new Error(
      `Dataset manifest hash mismatch: loaded dataset has ${manifest.datasetHash}, expected ${args.expectManifestHash}`
    );
  }
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

  // Per-symbol bootstrapCi95 (opt-in via --bootstrap-per-symbol) is ungated:
  // gateAbsT: null means "always attempt", since it is already off by
  // default and the caller explicitly asked for it.
  const bootstrapPerSymbolOpt = args.bootstrapPerSymbol
    ? { iterations: args.bootstrapN, seed: args.bootstrapSeed, maxPairs: args.bootstrapMaxPairs, gateAbsT: null }
    : null;
  // Pooled bootstrapCi95 is attempted for every requested factor x horizon,
  // but only actually computed for cells whose pooled HAC |icT| clears
  // BOOTSTRAP_GATE_ABS_T (a ruling from the controller after C3's initial
  // report flagged that "always computed" at the default --bootstrap-n
  // (formerly 1000), re-ranking every resample, was on the order of 15
  // minutes per pooled cell at full production scale; a second ruling then
  // replaced the re-ranking bootstrap with the fixed-rank one this file's
  // header describes, at roughly 21 seconds per gated cell before the
  // fixed-rank change and well under a second after it -- see the C3
  // report's two fix-round entries for both benchmarks). Cells below the
  // gate carry bootstrapCi95: null.
  const bootstrapPooledOpt = {
    iterations: args.bootstrapN,
    seed: args.bootstrapSeed,
    maxPairs: args.bootstrapMaxPairs,
    gateAbsT: BOOTSTRAP_GATE_ABS_T,
  };

  // forwardReturns depends only on (symbol, horizon), not on the factor, so
  // it is computed once per pair and reused across every requested factor.
  // Cached as Float64Array (NaN sentinel), not the (number | null)[]
  // forwardReturns itself returns: at 10 symbols x 105,000 5m bars x 6
  // horizons, a (number | null)[] cache costs on the order of 1 GB in V8
  // (null in the array forces boxed/tagged elements, roughly 24-32 bytes
  // each, instead of the 8 bytes/element a homogeneous-double Float64Array
  // uses). See the C3 report's fix-round entry for the measured heap.
  const fwdCache = new Map<string, Float64Array>();
  function fwdFor(symbolIdx: number, horizon: number): Float64Array {
    const key = `${symbolIdx}:${horizon}`;
    let cached = fwdCache.get(key);
    if (!cached) {
      const raw = forwardReturns(perSymbolData[symbolIdx].matrix.closes, horizon);
      cached = Float64Array.from(raw, (v) => v ?? NaN);
      fwdCache.set(key, cached);
    }
    return cached;
  }

  const factorReports: FactorReport[] = [];
  const skippedFactors: FactorIcReport['skippedFactors'] = [];

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
      const pooledFwdChunks: Float64Array[] = [];
      for (let s = 0; s < perSymbolData.length; s++) {
        if (symbolFactorArrays[s]) {
          pooledFwdChunks.push(fwdFor(s, h));
        }
      }
      const pooledFwd = concatFloat64(pooledFwdChunks);

      const stat = buildHorizonStat(pooledFactor, pooledFwd, h, bootstrapPooledOpt);
      if (stat) pooledHorizons.push(stat);

      rollingQuarterly.push(...buildRollingQuarterly(pooledTimestamps, pooledFactor, pooledFwd, h));
    }

    if (pooledHorizons.length === 0) {
      // No usable signal anywhere for this factor at this interval (e.g. a
      // funding/sentiment-derived factor on 5m/15m, which never has snapshot
      // data). Recorded in skippedFactors rather than encoded as NaN in a
      // report whose numeric fields are all plain, schema-validated numbers,
      // so it is visible to the orchestrator instead of silently vanishing.
      const reason = 'no finite pairs at any horizon';
      console.error(`[factor-ic] skipping ${factorName}: ${reason}`);
      skippedFactors.push({ name: factorName, category: nameCategory.get(factorName) ?? 'unknown', reason });
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
      gateAbsT: BOOTSTRAP_GATE_ABS_T,
      maxPairs: args.bootstrapMaxPairs,
    },
    factors: factorReports,
    skippedFactors,
  };

  const validated = validateFactorIcReport(report);
  if (!validated.ok) {
    throw new Error(`factor-ic report failed schema validation:\n${validated.issues.join('\n')}`);
  }

  return validated.data;
}

/**
 * The 15 largest pooled |icT| rows across all horizons (not top 15 per
 * horizon): every factor's pooled HorizonStat, at every horizon, is flattened
 * into one list and sorted by |icT|, so a factor can appear more than once
 * if several of its horizons rank highly, and a horizon with no standout
 * factor may not appear at all.
 */
function formatTopTable(report: FactorIcReport): string {
  const rows: Array<{ factor: string; horizon: number; ic: number; icT: number; n: number }> = [];
  for (const factor of report.factors) {
    for (const h of factor.pooled.horizons) {
      rows.push({ factor: factor.name, horizon: h.horizon, ic: h.ic, icT: h.icT, n: h.n });
    }
  }
  rows.sort((a, b) => Math.abs(b.icT) - Math.abs(a.icT));
  const top = rows.slice(0, 15);

  const title = 'top 15 pooled |icT| rows across all horizons:';
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
  return [title, header, ...lines].join('\n');
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
  console.log(`skipped: ${report.skippedFactors.length} factor(s) with no usable data`);

  return report;
}

/**
 * Recomputes one (factor, horizon[, symbol]) cell -- pooled across
 * --symbols/the manifest's symbols when no symbol is given -- and prints it
 * as JSON to stdout. Writes no file; used by the orchestrator to spot-check
 * a subagent's report (see report-schema.ts's spotCheckCell).
 *
 * When args.reportPath is set (--cell --report <path>), the referenced
 * FactorIcReport's symbols, dateRange (as start/end), and lockboxApplied
 * (as !allowLockbox) are used instead of args.symbols/start/end/
 * allowLockbox, which are ignored in that mode -- so the orchestrator's spot
 * check reproduces exactly the window the subagent's report was built from,
 * not whatever the CLI invocation's own flags happened to say. The current
 * dataset's manifest hash is also checked against the report's
 * datasetManifestHash (in addition to any --expect-manifest-hash), since a
 * spot check against a different dataset than the report used would not be
 * reproducing anything.
 */
export async function runCell(args: FactorIcArgs): Promise<CellResult> {
  if (!args.cell) {
    throw new Error('runCell requires args.cell');
  }

  let symbolsOverride = args.symbols;
  let startOverride = args.start;
  let endOverride = args.end;
  let allowLockboxOverride = args.allowLockbox;
  let expectManifestHash = args.expectManifestHash;

  if (args.reportPath) {
    const raw = JSON.parse(await readFile(args.reportPath, 'utf8'));
    const validated = validateFactorIcReport(raw);
    if (!validated.ok) {
      throw new Error(`--report ${args.reportPath} failed schema validation:\n${validated.issues.join('\n')}`);
    }
    const report = validated.data;
    symbolsOverride = report.symbols;
    startOverride = report.dateRange.startMs;
    endOverride = report.dateRange.endMs;
    allowLockboxOverride = !report.lockboxApplied;
    expectManifestHash = expectManifestHash ?? report.datasetManifestHash;
  }

  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  if (expectManifestHash !== undefined && manifest.datasetHash !== expectManifestHash) {
    throw new Error(
      `Dataset manifest hash mismatch: loaded dataset has ${manifest.datasetHash}, expected ${expectManifestHash}`
    );
  }

  const { factor: factorName, horizon, symbol } = args.cell;

  let ic: number;
  let n: number;

  if (symbol) {
    const data = loadSymbolData(args.datasetDir, symbol, args.interval, {
      allowLockbox: allowLockboxOverride,
      start: startOverride,
      end: endOverride,
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
    const symbols = symbolsOverride && symbolsOverride.length > 0 ? symbolsOverride : manifest.symbols;

    let pooledFactor: number[] = [];
    let pooledFwd: (number | null)[] = [];
    let foundAny = false;
    for (const sym of symbols) {
      const data = loadSymbolData(args.datasetDir, sym, args.interval, {
        allowLockbox: allowLockboxOverride,
        start: startOverride,
        end: endOverride,
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
