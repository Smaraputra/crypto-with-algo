/**
 * Snipe cache builder CLI. One (symbol, timeframe) at a time, so the peak is one factor matrix.
 *
 *   npx tsx scripts/research/snipe-build.ts --dataset-dir D --out O [--symbols BTCUSDT,ETHUSDT] [--timeframes scalp,intraday]
 *
 * Verifies the dataset manifest first and records its hash in every cache index. Logs one JSON line per pair.
 */

import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { loadManifest, verifyManifest } from './load-dataset';
import { buildSymbolArrays } from './snipe-matrix';
import { writeSnipeCache } from './snipe-cache';
import { OUTCOME_AMBIGUOUS, OUTCOME_DOWN, OUTCOME_NONE, OUTCOME_TIMEOUT, OUTCOME_UP } from './snipe-labels';
import { SNIPE_TIMEFRAMES, type SnipeTimeframe } from './snipe';
import { gitCommitFromEnv, isCommitSet, TIMEFRAME_ORDER } from './snipe-cli';

export interface SnipeBuildArgs {
  datasetDir: string;
  out: string;
  symbols: string[];
  timeframes: SnipeTimeframe[];
}

export function parseArgs(argv: string[]): SnipeBuildArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!['dataset-dir', 'out', 'symbols', 'timeframes'].includes(key)) throw new Error(`Unknown flag --${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    flags.set(key, value);
    i++;
  }
  const datasetDir = flags.get('dataset-dir');
  const out = flags.get('out');
  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');
  const timeframes = (flags.get('timeframes') ?? 'scalp,intraday').split(',').map((s) => s.trim()) as SnipeTimeframe[];
  for (const tf of timeframes) {
    if (!(tf in SNIPE_TIMEFRAMES)) throw new Error(`Unknown timeframe ${tf}`);
  }
  const symbols = flags.get('symbols') ? flags.get('symbols')!.split(',').map((s) => s.trim()) : [...SIGNAL_SYMBOLS];
  return { datasetDir, out, symbols, timeframes };
}

export async function runSnipeBuild(args: SnipeBuildArgs, log: (line: string) => void = console.log): Promise<void> {
  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) throw new Error(`dataset manifest verification failed: ${verify.mismatches.join(', ')}`);
  const manifestHash = loadManifest(args.datasetDir).datasetHash;
  // AMENDMENT 1 (A1-6): the commit is recorded in every cache index, and a build is binding-eligible only with the
  // commit set, both timeframes and the ten symbols (the scan and confirmation compare the commits).
  const gitCommit = gitCommitFromEnv();
  const binding =
    isCommitSet(gitCommit) &&
    args.timeframes.length === TIMEFRAME_ORDER.length &&
    TIMEFRAME_ORDER.every((tf) => args.timeframes.includes(tf)) &&
    args.symbols.join(',') === SIGNAL_SYMBOLS.join(',');

  for (const symbol of args.symbols) {
    for (const timeframe of args.timeframes) {
      const started = Date.now();
      const data = buildSymbolArrays(args.datasetDir, symbol, timeframe);
      writeSnipeCache(args.out, data, { datasetManifestHash: manifestHash, gitCommit });
      const counts = { none: 0, up: 0, down: 0, timeout: 0, ambiguous: 0 };
      for (const o of data.outcome) {
        if (o === OUTCOME_NONE) counts.none++;
        else if (o === OUTCOME_UP) counts.up++;
        else if (o === OUTCOME_DOWN) counts.down++;
        else if (o === OUTCOME_TIMEOUT) counts.timeout++;
        else if (o === OUTCOME_AMBIGUOUS) counts.ambiguous++;
      }
      log(
        JSON.stringify({
          symbol,
          timeframe,
          gitCommit,
          binding,
          bars: data.timestamps.length,
          warmupBars: data.warmupBars,
          outcomeCounts: counts,
          seconds: Math.round((Date.now() - started) / 100) / 10,
          heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
        })
      );
    }
  }
}

if (require.main === module) {
  runSnipeBuild(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
