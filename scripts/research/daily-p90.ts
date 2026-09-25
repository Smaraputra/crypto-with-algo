/**
 * Daily |composite| p90 from the research dataset, pooled across symbols.
 *
 * WHY THIS EXISTS. The calibration header records a pooled p90 per interval
 * (1h 32.2, 15m 30.3, and so on) measured over YEARS. It is tempting to read a
 * few hours of live scoring against those numbers and call a shortfall a
 * defect. That comparison is invalid: measured here, daily p90 at 1h spans 11.3
 * to 42.8 across 1800 days with an interquartile range of 27.5 to 33.7, so a
 * single day can sit six points either side of the pooled figure for no reason
 * beyond the market. This script supplies the missing denominator -- where a
 * given day sits in the distribution of days.
 *
 * It was written after exactly that mistake was made on 2026-09-25: a live p90
 * of 23.9 at 1h looked like an 8-point shortfall against 32.2, and turned out
 * to be an ordinary soft day that the research path scored at 24.4 over the
 * same hours, bar for bar identical to live.
 *
 * Usage:
 *   npx tsx scripts/research/daily-p90.ts --dataset-dir data/research --interval 1h
 *   npx tsx scripts/research/daily-p90.ts --dataset-dir <dir> --interval 1h --live-p90 23.9
 *
 * Flags:
 *   --dataset-dir <dir>   required
 *   --interval <iv>       required (5m, 15m, 1h, 4h, 1d)
 *   --symbols <a,b>       default: every symbol in the manifest
 *   --recent-days <n>     default 10, how many trailing days to print
 *   --live-p90 <x>        optional, reports which percentile of days x sits at
 */
import { loadSymbolData } from './factor-ic';
import { loadManifest } from './load-dataset';

const DAY_MS = 86_400_000;

/**
 * Bars below which a calendar day is treated as a partial day and dropped.
 *
 * The first and last day of any export are partial, and a partial day's p90 is
 * computed from too few bars to compare against a full one.
 */
export const MIN_BARS_FOR_A_DAY = 50;

/** Nearest-rank quantile of an ALREADY SORTED ascending array. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** UTC midnight of the day a timestamp falls in. */
export function dayBucket(timestampMs: number): number {
  return Math.floor(timestampMs / DAY_MS) * DAY_MS;
}

/** Absolute composite values bucketed by UTC day, accumulated across symbols. */
export type DayBuckets = Map<number, number[]>;

/**
 * Add one symbol's series to the buckets.
 *
 * `timestamps` and `values` are positionally paired. Non-finite values are
 * dropped rather than counted as zero, which is how a bar with a missing input
 * stays out of the distribution instead of dragging it down.
 */
export function accumulateDays(
  timestamps: readonly number[],
  values: readonly number[],
  buckets: DayBuckets = new Map()
): DayBuckets {
  for (let i = 0; i < timestamps.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const day = dayBucket(timestamps[i]);
    const list = buckets.get(day);
    if (list) list.push(Math.abs(v));
    else buckets.set(day, [Math.abs(v)]);
  }
  return buckets;
}

/** p90 of each FULL day, keyed by UTC midnight and sorted by day. */
export function p90PerDay(buckets: DayBuckets): Array<{ day: number; p90: number }> {
  return [...buckets.entries()]
    .filter(([, list]) => list.length >= MIN_BARS_FOR_A_DAY)
    .map(([day, list]) => ({ day, p90: quantile([...list].sort((a, b) => a - b), 0.9) }))
    .sort((a, b) => a.day - b.day);
}

/** Where `value` falls among `sorted`, as a percentile of entries below it. */
export function percentileOf(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return Number.NaN;
  return (100 * sorted.filter((v) => v < value).length) / sorted.length;
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

async function main(): Promise<void> {
  const datasetDir = arg('dataset-dir');
  const interval = arg('interval');
  const manifest = loadManifest(datasetDir);
  const symbolsArg = arg('symbols', '');
  const symbols = symbolsArg ? symbolsArg.split(',') : manifest.symbols;
  const recentDays = Number(arg('recent-days', '10'));
  const liveP90 = Number(arg('live-p90', 'NaN'));

  let buckets: DayBuckets = new Map();
  for (const symbol of symbols) {
    const data = loadSymbolData(datasetDir, symbol, interval, { allowLockbox: true });
    const matrix = data.matrix;
    const idx = matrix.names.indexOf('composite');
    if (idx < 0) throw new Error('factor matrix has no composite column');

    buckets = accumulateDays(
      matrix.timestamps.slice(matrix.warmupBars),
      Array.from(matrix.values[idx]).slice(matrix.warmupBars),
      buckets
    );
  }

  const pooled = [...buckets.values()].flat().sort((a, b) => a - b);
  console.log(`interval=${interval} symbols=${symbols.length} bars=${pooled.length}`);
  console.log(
    `pooled over the whole range: p50=${quantile(pooled, 0.5).toFixed(1)} ` +
      `p90=${quantile(pooled, 0.9).toFixed(1)} p98=${quantile(pooled, 0.98).toFixed(1)}`
  );

  const daily = p90PerDay(buckets);
  const sortedDaily = daily.map((d) => d.p90).sort((a, b) => a - b);

  console.log('');
  console.log(`DAILY p90 ACROSS ${sortedDaily.length} FULL DAYS`);
  console.log(
    `  min=${sortedDaily[0].toFixed(1)}  p05=${quantile(sortedDaily, 0.05).toFixed(1)}` +
      `  p25=${quantile(sortedDaily, 0.25).toFixed(1)}  median=${quantile(sortedDaily, 0.5).toFixed(1)}` +
      `  p75=${quantile(sortedDaily, 0.75).toFixed(1)}  p95=${quantile(sortedDaily, 0.95).toFixed(1)}` +
      `  max=${sortedDaily[sortedDaily.length - 1].toFixed(1)}`
  );

  if (Number.isFinite(liveP90)) {
    console.log(
      `  a p90 of ${liveP90} sits at the ${percentileOf(sortedDaily, liveP90).toFixed(1)}th percentile of days`
    );
  }

  console.log('');
  console.log(`MOST RECENT ${recentDays} FULL DAYS`);
  for (const entry of daily.slice(-recentDays)) {
    console.log(
      `  ${new Date(entry.day).toISOString().slice(0, 10)}  p90=${entry.p90.toFixed(1).padStart(5)}`
    );
  }
}

if (require.main === module) {
  void main().then(() => process.exit(0));
}
