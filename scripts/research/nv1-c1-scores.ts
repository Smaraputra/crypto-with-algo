import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import type { CandleRow, HtfRow } from './dataset-format';
import { writeJsonlGz } from './dataset-format';
import { computeFactorMatrix } from './factors';
import { loadCandles, loadManifest, verifyManifest } from './load-dataset';
import { NV1_SEGMENTS, quantile7 } from './nv1-core';

export const NV1_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'ADAUSDT',
  'XRPUSDT',
  'LINKUSDT',
  'DOGEUSDT',
  'SOLUSDT',
  'DOTUSDT',
  'AVAXUSDT',
] as const;

export const HOLDOUT_GUARD_MESSAGE =
  'nv1: segment A may only be read after the Round 1 lock is committed';

/**
 * Asserts that the Round 1 lock file exists next to this script before allowing
 * holdout segment A to be read.
 */
export function assertHoldoutAllowed(scriptDir: string): void {
  const lockPath = join(scriptDir, 'next-version-v1.ts');
  if (!existsSync(lockPath)) {
    throw new Error(HOLDOUT_GUARD_MESSAGE);
  }
}

/**
 * v8-intraday composite per bar for one symbol: computeFactorMatrix with snapshots null,
 * every htf context null, interval '1h', style 'day_trading'. Bars before warmup get NaN.
 */
export function c1Scores(candles: CandleRow[]): {
  t: number[];
  close: number[];
  score: number[];
} {
  if (candles.length === 0) {
    return { t: [], close: [], score: [] };
  }

  const htf: HtfRow[] = candles.map((c) => ({ t: c.t, context: null }));
  const matrix = computeFactorMatrix({
    candles,
    snapshots: null,
    htf,
    interval: '1h',
    style: 'day_trading',
  });

  const compIdx = matrix.names.indexOf('composite');
  if (compIdx === -1) {
    throw new Error('computeFactorMatrix: composite column not found');
  }

  return {
    t: matrix.timestamps,
    close: matrix.closes,
    score: Array.from(matrix.values[compIdx]),
  };
}

/**
 * Type-7 90th percentile of |score| over finite scores whose t falls in any of the given segments.
 */
export function c1Cutoff(
  rows: Array<{ t: number; score: number }>,
  segments: Array<{ start: number; end: number }>
): number;
export function c1Cutoff(
  rows: Array<{ t: number; score: number | null }>,
  segments: Array<{ start: number; end: number }>
): number;
export function c1Cutoff(
  rows: Array<{ t: number; score: number | null }>,
  segments: Array<{ start: number; end: number }>
): number {
  const absScores: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.score === null || !Number.isFinite(row.score)) {
      continue;
    }
    const inSegment = segments.some((seg) => row.t >= seg.start && row.t < seg.end);
    if (inSegment) {
      absScores.push(Math.abs(row.score));
    }
  }
  return quantile7(absScores, 0.9);
}

export interface ScoreRow {
  symbol: string;
  t: number;
  close: number;
  score: number | null;
}

/**
 * Reads a gzipped JSON-lines score file back into rows without calling
 * readJsonlGz, adhering to the holdout guard's file-level caller check.
 */
export function readScoresFile(path: string): ScoreRow[] {
  const compressed = readFileSync(path);
  const text = gunzipSync(compressed).toString('utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ScoreRow);
}

export interface ParsedScoresArgs {
  command: 'scores';
  datasetDir: string;
  out: string;
  holdout: boolean;
}

export interface ParsedCutoffArgs {
  command: 'cutoff';
  scores: string;
}

export type ParsedCliArgs = ParsedScoresArgs | ParsedCutoffArgs;

export function parseArgs(argv: string[]): ParsedCliArgs {
  if (argv.length === 0) {
    throw new Error('No command specified. Expected "scores" or "cutoff".');
  }

  const command = argv[0];
  if (command === 'scores') {
    let datasetDir: string | null = null;
    let out: string | null = null;
    let holdout = false;

    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      const value = (): string => {
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) {
          throw new Error(`${flag} requires a value`);
        }
        return v;
      };

      if (flag === '--dataset-dir') {
        datasetDir = value();
      } else if (flag === '--out') {
        out = value();
      } else if (flag === '--holdout') {
        holdout = true;
      } else {
        throw new Error(`Unknown flag "${flag}" for scores command`);
      }
    }

    if (!datasetDir) {
      throw new Error('--dataset-dir is required');
    }
    if (!out) {
      throw new Error('--out is required');
    }

    return { command: 'scores', datasetDir, out, holdout };
  }

  if (command === 'cutoff') {
    let scores: string | null = null;

    for (let i = 1; i < argv.length; i++) {
      const flag = argv[i];
      const value = (): string => {
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) {
          throw new Error(`${flag} requires a value`);
        }
        return v;
      };

      if (flag === '--scores') {
        scores = value();
      } else {
        throw new Error(`Unknown flag "${flag}" for cutoff command`);
      }
    }

    if (!scores) {
      throw new Error('--scores is required');
    }

    return { command: 'cutoff', scores };
  }

  throw new Error(`Unknown command "${command}". Expected "scores" or "cutoff".`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (args.command === 'scores') {
    if (args.holdout) {
      try {
        assertHoldoutAllowed(__dirname);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }

    const verify = await verifyManifest(args.datasetDir);
    if (!verify.ok) {
      throw new Error(`verifyManifest failed: ${verify.mismatches.join(', ')}`);
    }

    const manifest = loadManifest(args.datasetDir);
    const allRows: ScoreRow[] = [];
    const rowsPerSymbol: Record<string, number> = {};
    let firstT: number | null = null;
    let lastT: number | null = null;

    for (const symbol of NV1_SYMBOLS) {
      const candles = loadCandles(args.datasetDir, symbol, '1h', {
        allowLockbox: false,
        allowHoldoutA: args.holdout,
      }).rows;

      const scored = c1Scores(candles);
      rowsPerSymbol[symbol] = scored.t.length;

      for (let i = 0; i < scored.t.length; i++) {
        const t = scored.t[i];
        if (firstT === null || t < firstT) firstT = t;
        if (lastT === null || t > lastT) lastT = t;
        const s = scored.score[i];
        allRows.push({
          symbol,
          t,
          close: scored.close[i],
          score: Number.isFinite(s) ? s : null,
        });
      }
    }

    allRows.sort((a, b) => a.t - b.t || a.symbol.localeCompare(b.symbol));
    await writeJsonlGz(args.out, allRows);

    console.log(
      JSON.stringify({
        rowsPerSymbol,
        firstT,
        lastT,
        holdout: args.holdout,
        datasetHash: manifest.datasetHash,
      })
    );
    return;
  }

  if (args.command === 'cutoff') {
    const rawRows = readScoresFile(args.scores);
    const devSegments = [NV1_SEGMENTS.B, NV1_SEGMENTS.C];
    const c90 = c1Cutoff(rawRows, devSegments);
    const qualifyingCount = rawRows.filter(
      (r) =>
        r.score !== null &&
        Number.isFinite(r.score) &&
        devSegments.some((seg) => r.t >= seg.start && r.t < seg.end)
    ).length;

    console.log(JSON.stringify({ c90, rows: qualifyingCount }));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
