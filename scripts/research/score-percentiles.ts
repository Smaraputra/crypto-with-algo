/**
 * Measures the distribution of the live composite score on the research
 * dataset, so the tier cutoffs in src/lib/signals/calibration.ts
 * (TIER_BUY_CUTOFF 30, TIER_STRONG_CUTOFF 38) can be checked against
 * refilled bars and every symbol the live engine scores.
 *
 * Why: the calibration header's percentiles were measured on 2026-09-16 from
 * production candles written before the candle-finalization fix (every
 * cron-synced bar was stored in its in-progress state) and from five of the
 * ten live symbols. The session 05 handover ruled that nothing measured
 * before the refill is trusted. This script re-measures on the exported,
 * hashed dataset (scripts/research/export-dataset.ts, refilled bars, ten
 * symbols) and prints |composite| p50, p90, and p98 plus the share of bars
 * strictly above each cutoff, per symbol and pooled across symbols, for each
 * interval in the dataset (5m, 15m, 1h, 4h, 1d; 1m is not exported).
 *
 * How a bar is scored: computeFactorMatrix (scripts/research/factors.ts),
 * which scores every post-warmup bar with the style's DEFAULT_TEMPLATE_WEIGHTS
 * (styleForInterval maps 5m to scalping, 15m and 1h to day_trading, 4h to
 * swing_trading, 1d to position_trading), the point-in-time snapshot at or
 * before the bar (futures and sentiment inputs), the HTF context exported
 * per bar, and Ichimoku stripped for scalping as live scoring does. By
 * default only bars that carry a snapshot are kept (raw.fundingRate or
 * raw.fearGreed is a number at the bar): without futures and sentiment data
 * their weight is redistributed and |score| inflates, which is the
 * compression the calibration header documents (position_trading p90 54
 * without snapshots, 25 with). --include-no-snapshot keeps every post-warmup
 * bar and reports how many lacked a snapshot either way.
 *
 * The lockbox (2026-07-01 onward) is applied by default, as for every other
 * research read, and --allow-lockbox reads through it. The dataset carries
 * one snapshot per bar back to 2021-10 at 1h and 2018-10 at 4h and 1d (the
 * 2026-09-18 snapshot pass backfilled them), so the default window is the
 * whole pre-lockbox history and withoutSnapshot reads 0 on it. The
 * 2026-03-04 coverage start in the calibration header describes production
 * on 2026-09-16, before that pass. This is a measurement, not a rule fit:
 * the constants in calibration.ts are not changed here. A cutoff change is a
 * discontinuity in the live outcome record and is decided by hand from the
 * printed table. The full run (five intervals, ten symbols) takes about 25 s.
 *
 *   npx tsx scripts/research/score-percentiles.ts
 *   npx tsx scripts/research/score-percentiles.ts --intervals 5m,1h --symbols BTCUSDT,ETHUSDT --json
 *
 * Flags:
 *   --dataset-dir <dir>       default data/research
 *   --intervals <a,b,...>     default: every interval in the manifest
 *   --symbols <a,b,...>       default: every symbol in the manifest
 *   --allow-lockbox           read data from 2026-07-01 onward too
 *   --include-no-snapshot     keep post-warmup bars that carry no snapshot
 *   --json                    one JSON line per interval instead of the table
 */
import type { TradingStyle } from '@/lib/models/signal-template';
import { TIER_BUY_CUTOFF, TIER_STRONG_CUTOFF } from '@/lib/signals/calibration';
import { loadSymbolData } from './factor-ic';
import { styleForInterval, type FactorMatrix } from './factors';
import { loadManifest, verifyManifest } from './load-dataset';

export interface ScorePercentilesArgs {
  datasetDir: string;
  intervals: string[] | undefined;
  symbols: string[] | undefined;
  allowLockbox: boolean;
  includeNoSnapshot: boolean;
  json: boolean;
}

export interface TierCutoffs {
  buy: number;
  strong: number;
}

export interface ScoreSummary {
  count: number;
  p50: number;
  p90: number;
  p98: number;
  /** Share of bars with |score| strictly above the buy cutoff, as the tiers are assigned. */
  shareAboveBuy: number;
  shareAboveStrong: number;
}

export interface CollectResult {
  /** |composite| of every kept bar, in bar order. */
  scores: number[];
  /** Post-warmup bars with a composite score, kept or not. */
  barsScored: number;
  /** Post-warmup bars whose snapshot inputs were absent, kept only with requireSnapshot false. */
  barsWithoutSnapshot: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

export interface SymbolScoreRow {
  symbol: string;
  from: string | null;
  to: string | null;
  barsWithoutSnapshot: number;
  summary: ScoreSummary;
}

export interface IntervalScoreReport {
  interval: string;
  style: TradingStyle;
  from: string | null;
  to: string | null;
  barsWithoutSnapshot: number;
  pooled: ScoreSummary;
  symbols: SymbolScoreRow[];
}

export interface ScorePercentilesReport {
  generatedAt: string;
  datasetHash: string;
  commit: string;
  lockboxApplied: boolean;
  requireSnapshot: boolean;
  cutoffs: TierCutoffs;
  intervals: IntervalScoreReport[];
}

const BOOLEAN_FLAGS = new Set(['allow-lockbox', 'include-no-snapshot', 'json']);
const VALUE_FLAGS = new Set(['dataset-dir', 'intervals', 'symbols']);

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Pure CLI argument parsing, the same flag grammar as factor-ic.ts. */
export function parseArgs(argv: string[]): ScorePercentilesArgs {
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

  return {
    datasetDir: flags.get('dataset-dir') ?? 'data/research',
    intervals: flags.has('intervals') ? parseList(flags.get('intervals')!) : undefined,
    symbols: flags.has('symbols') ? parseList(flags.get('symbols')!) : undefined,
    allowLockbox: booleans.has('allow-lockbox'),
    includeNoSnapshot: booleans.has('include-no-snapshot'),
    json: booleans.has('json'),
  };
}

/** Nearest-rank percentile of an ascending series: the value at rank ceil(p * n). NaN when empty. */
export function nearestRankPercentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
  return sortedAsc[rank - 1];
}

export function summarizeAbsScores(scores: number[], cutoffs: TierCutoffs): ScoreSummary {
  const sorted = [...scores].sort((a, b) => a - b);
  const count = sorted.length;
  const share = (cutoff: number) =>
    count === 0 ? NaN : sorted.filter((s) => s > cutoff).length / count;

  return {
    count,
    p50: nearestRankPercentile(sorted, 0.5),
    p90: nearestRankPercentile(sorted, 0.9),
    p98: nearestRankPercentile(sorted, 0.98),
    shareAboveBuy: share(cutoffs.buy),
    shareAboveStrong: share(cutoffs.strong),
  };
}

/**
 * |composite| of every post-warmup bar of a factor matrix. A bar carries a
 * snapshot when raw.fundingRate or raw.fearGreed is a number there: both
 * come straight from the snapshot aligned to the bar (NaN when none), so
 * either one proves the futures and sentiment inputs were present.
 */
export function collectAbsScores(
  matrix: FactorMatrix,
  opts: { requireSnapshot: boolean }
): CollectResult {
  const compositeIdx = matrix.names.indexOf('composite');
  if (compositeIdx < 0) {
    throw new Error('collectAbsScores: factor matrix has no composite column');
  }
  const fundingIdx = matrix.names.indexOf('raw.fundingRate');
  const fearGreedIdx = matrix.names.indexOf('raw.fearGreed');
  const isNumber = (idx: number, bar: number) =>
    idx >= 0 && !Number.isNaN(matrix.values[idx][bar]);

  const scores: number[] = [];
  let barsScored = 0;
  let barsWithoutSnapshot = 0;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (let bar = matrix.warmupBars; bar < matrix.timestamps.length; bar++) {
    const score = matrix.values[compositeIdx][bar];
    if (Number.isNaN(score)) continue;
    barsScored++;

    const hasSnapshot = isNumber(fundingIdx, bar) || isNumber(fearGreedIdx, bar);
    if (!hasSnapshot) {
      barsWithoutSnapshot++;
      if (opts.requireSnapshot) continue;
    }

    scores.push(Math.abs(score));
    if (firstTimestamp === null) firstTimestamp = matrix.timestamps[bar];
    lastTimestamp = matrix.timestamps[bar];
  }

  return { scores, barsScored, barsWithoutSnapshot, firstTimestamp, lastTimestamp };
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Does the read: verifies the manifest, loads every symbol at every interval, and summarizes. */
export async function runScorePercentiles(args: ScorePercentilesArgs): Promise<ScorePercentilesReport> {
  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  const intervals = args.intervals && args.intervals.length > 0 ? args.intervals : manifest.intervals;
  const symbols = args.symbols && args.symbols.length > 0 ? args.symbols : manifest.symbols;
  const requireSnapshot = !args.includeNoSnapshot;
  const cutoffs: TierCutoffs = { buy: TIER_BUY_CUTOFF, strong: TIER_STRONG_CUTOFF };

  const intervalReports: IntervalScoreReport[] = [];
  for (const interval of intervals) {
    const style = styleForInterval(interval);
    const rows: SymbolScoreRow[] = [];
    const pooledScores: number[] = [];
    let barsWithoutSnapshot = 0;
    let from: number | null = null;
    let to: number | null = null;

    for (const symbol of symbols) {
      console.error(`[score-percentiles] ${interval} ${symbol}...`);
      const data = loadSymbolData(args.datasetDir, symbol, interval, { allowLockbox: args.allowLockbox });
      const collected = collectAbsScores(data.matrix, { requireSnapshot });

      rows.push({
        symbol,
        from: isoOrNull(collected.firstTimestamp),
        to: isoOrNull(collected.lastTimestamp),
        barsWithoutSnapshot: collected.barsWithoutSnapshot,
        summary: summarizeAbsScores(collected.scores, cutoffs),
      });
      pooledScores.push(...collected.scores);
      barsWithoutSnapshot += collected.barsWithoutSnapshot;
      if (collected.firstTimestamp !== null && (from === null || collected.firstTimestamp < from)) {
        from = collected.firstTimestamp;
      }
      if (collected.lastTimestamp !== null && (to === null || collected.lastTimestamp > to)) {
        to = collected.lastTimestamp;
      }
    }

    intervalReports.push({
      interval,
      style,
      from: isoOrNull(from),
      to: isoOrNull(to),
      barsWithoutSnapshot,
      pooled: summarizeAbsScores(pooledScores, cutoffs),
      symbols: rows,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    datasetHash: manifest.datasetHash,
    commit: manifest.commit,
    lockboxApplied: !args.allowLockbox,
    requireSnapshot,
    cutoffs,
    intervals: intervalReports,
  };
}

function formatSummary(label: string, summary: ScoreSummary, cutoffs: TierCutoffs): string {
  return (
    `  ${label.padEnd(10)} count=${summary.count} p50=${summary.p50.toFixed(1)} ` +
    `p90=${summary.p90.toFixed(1)} p98=${summary.p98.toFixed(1)} ` +
    `above${cutoffs.buy}=${summary.shareAboveBuy.toFixed(4)} ` +
    `above${cutoffs.strong}=${summary.shareAboveStrong.toFixed(4)}`
  );
}

/** Renders the report as JSON lines or as the plain table; pure string building. */
export function formatReport(report: ScorePercentilesReport, json: boolean): string {
  if (json) {
    return report.intervals.map((block) => JSON.stringify(block)).join('\n');
  }

  const lines: string[] = [
    `dataset=${report.datasetHash} commit=${report.commit} generatedAt=${report.generatedAt}`,
  ];
  for (const block of report.intervals) {
    lines.push('');
    lines.push(
      `interval=${block.interval} style=${block.style} symbols=${block.symbols.length} ` +
        `lockbox=${report.lockboxApplied ? 'applied' : 'off'} ` +
        `snapshot=${report.requireSnapshot ? 'required' : 'optional'} ` +
        `withoutSnapshot=${block.barsWithoutSnapshot} ` +
        `range=${block.from ?? 'n/a'}..${block.to ?? 'n/a'}`
    );
    lines.push(formatSummary('pooled', block.pooled, report.cutoffs));
    for (const row of block.symbols) {
      lines.push(formatSummary(row.symbol, row.summary, report.cutoffs));
    }
  }
  lines.push('');
  lines.push(
    `note: |composite| per post-warmup bar, scored as live (default weights, snapshot at or before the bar, ` +
      `Ichimoku skipped for scalping); cutoffs: buy above ${report.cutoffs.buy}, strong above ${report.cutoffs.strong}`
  );
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runScorePercentiles(args);
    console.log(formatReport(report, args.json));
    process.exit(0);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
