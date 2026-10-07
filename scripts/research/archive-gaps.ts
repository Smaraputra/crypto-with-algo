/**
 * Finds daily-kline gaps in production `perpcandles` for a universe-source file and splits them into
 * repairable days (a daily archive file exists) and source gaps (no file anywhere). Also lists every
 * consecutive-day close ratio above 5 or below one fifth, the redenomination check that broad-trend.ts
 * (CONTRACTS) requires in the universe report before any rule runs. Data tooling only: the Mongo access is a
 * read-only query and nothing is written to any database. Zero-volume days (AMENDMENT 1) are listed
 * per symbol as days and runs, apart from missing days, and are not repair targets.
 *
 * Usage:
 *   npx tsx scripts/research/archive-gaps.ts --universe universe.json --repair-out repair.json \
 *     --report-out gaps-report.json [--mongo-uri <uri>] [--through 2026-06-30]
 *
 * The repair file is a symbols file for `scripts/ops/ingest-archive.ts --symbols-file` (klineDays only).
 * Days are compared as UTC day numbers (epoch ms / 86,400,000).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import mongoose from 'mongoose';

import { listKeys } from '@/lib/external/binance-archive-listing';
import { connectDB } from '@/lib/mongodb';
import { PerpCandle } from '@/lib/models/perp-candle';
import {
  DAILY_KLINES_PREFIX,
  keyDates,
  type UniverseFolder,
  type UniverseSource,
} from './universe-source';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The sample's last day (broad-trend.ts: nothing from 2026-07-01 onward is read). */
const DEFAULT_THROUGH = '2026-06-30';
/** Header: "close after the gap is more than 5 times, or less than one fifth of, the close before it". */
export const REDENOMINATION_RATIO = 5;

export function dayNumber(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export function dayKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function dayNumberOf(isoDay: string): number {
  return dayNumber(Date.parse(`${isoDay}T00:00:00Z`));
}

/** Missing day numbers in [first, last], ascending. `barDays` need not be sorted or unique. */
export function findGaps(barDays: number[], expected: { first: number; last: number }): number[] {
  const present = new Set(barDays);
  const missing: number[] = [];
  for (let day = expected.first; day <= expected.last; day++) {
    if (!present.has(day)) missing.push(day);
  }
  return missing;
}

export interface CloseJump {
  day: string;
  ratio: number;
}

/**
 * Consecutive-day close ratios beyond 5x or under 1/5, over bars on adjacent calendar days only.
 * `bars` must be sorted ascending by day.
 */
export function closeJumps(bars: Array<{ day: number; close: number }>): CloseJump[] {
  const out: CloseJump[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].day - bars[i - 1].day !== 1) continue;
    const before = bars[i - 1].close;
    if (!(before > 0) || !(bars[i].close > 0)) continue;
    const ratio = bars[i].close / before;
    if (ratio > REDENOMINATION_RATIO || ratio < 1 / REDENOMINATION_RATIO) {
      out.push({ day: dayKey(bars[i].day), ratio });
    }
  }
  return out;
}

/**
 * The days a folder's listed files cover: first day of its first monthly file (or first daily file) to the
 * last day of its last monthly file (or last daily file), capped at `through`. Null when it lists no 1d files.
 */
export function expectedRange(
  folder: Pick<UniverseFolder, 'klineMonths' | 'dailyKlines'>,
  through: string
): { first: number; last: number } | null {
  const firsts: number[] = [];
  const lasts: number[] = [];
  if (folder.klineMonths.length > 0) {
    const [fy, fm] = folder.klineMonths[0].split('-').map(Number);
    const [ly, lm] = folder.klineMonths[folder.klineMonths.length - 1].split('-').map(Number);
    firsts.push(dayNumber(Date.UTC(fy, fm - 1, 1)));
    lasts.push(dayNumber(Date.UTC(ly, lm, 1)) - 1);
  }
  if (folder.dailyKlines) {
    firsts.push(dayNumberOf(folder.dailyKlines.first));
    lasts.push(dayNumberOf(folder.dailyKlines.last));
  }
  if (firsts.length === 0) return null;
  const first = Math.min(...firsts);
  const last = Math.min(Math.max(...lasts), dayNumberOf(through));
  return last >= first ? { first, last } : null;
}

export interface ZeroVolumeRun {
  start: string;
  end: string;
  length: number;
}

/**
 * Header AMENDMENT 1: a zero-volume bar counts as a missing day for every rule, but it is a halted or
 * settling contract printing a flat bar, not a hole in the archive, so it is never a repair target.
 * `days` must be ascending; runs are maximal runs of consecutive calendar days.
 */
export function zeroVolumeRuns(days: number[]): ZeroVolumeRun[] {
  const runs: ZeroVolumeRun[] = [];
  for (const day of days) {
    const last = runs[runs.length - 1];
    if (last && dayNumberOf(last.end) + 1 === day) {
      last.end = dayKey(day);
      last.length++;
    } else {
      runs.push({ start: dayKey(day), end: dayKey(day), length: 1 });
    }
  }
  return runs;
}

export interface SymbolGapResult {
  symbol: string;
  /** No bars at all in the database: not ingested, reported apart from gaps. */
  notIngested: boolean;
  /** Missing days with a daily archive file: repairable with ingest-archive --symbols-file. */
  repairDays: string[];
  /** Missing days with no file anywhere: the archive itself lacks them. */
  sourceGapDays: string[];
  /** Days with a bar of zero volume: reported apart from gaps, never repaired. */
  zeroVolumeDays: string[];
  zeroVolumeRuns: ZeroVolumeRun[];
  jumps: CloseJump[];
  barCount: number;
}

/**
 * Gap analysis for one folder. `listDailyKeys` is called only when there is a gap, so a clean symbol costs
 * no listing.
 */
export async function analyzeSymbol(
  folder: Pick<UniverseFolder, 'name' | 'klineMonths' | 'dailyKlines'>,
  bars: Array<{ day: number; close: number; volume?: number }>,
  listDailyKeys: (symbol: string) => Promise<string[]>,
  through: string = DEFAULT_THROUGH
): Promise<SymbolGapResult | null> {
  const range = expectedRange(folder, through);
  if (!range) return null;

  const sorted = [...bars].sort((a, b) => a.day - b.day);
  const zeroDays = sorted.filter((b) => b.volume === 0).map((b) => b.day);
  // A zero-volume bar is not a bar (AMENDMENT 1), so it neither forms nor hides a close jump.
  const traded = sorted.filter((b) => b.volume !== 0);
  const base: SymbolGapResult = {
    symbol: folder.name,
    notIngested: sorted.length === 0,
    repairDays: [],
    sourceGapDays: [],
    zeroVolumeDays: zeroDays.map(dayKey),
    zeroVolumeRuns: zeroVolumeRuns(zeroDays),
    jumps: closeJumps(traded),
    barCount: sorted.length,
  };
  if (base.notIngested) return base;

  const missing = findGaps(
    sorted.map((b) => b.day),
    range
  );
  if (missing.length === 0) return base;

  const dailyFiles = new Set(keyDates(await listDailyKeys(folder.name), folder.name, '1d', 'day'));
  for (const day of missing) {
    const key = dayKey(day);
    (dailyFiles.has(key) ? base.repairDays : base.sourceGapDays).push(key);
  }
  return base;
}

export interface GapReport {
  universeSha256: string;
  through: string;
  counts: {
    symbolsChecked: number;
    notIngested: number;
    symbolsWithGaps: number;
    repairDays: number;
    sourceGapDays: number;
    jumps: number;
    zeroVolumeDays: number;
  };
  notIngested: string[];
  sourceGaps: Array<{ symbol: string; days: string[] }>;
  repairs: Array<{ symbol: string; days: string[] }>;
  zeroVolume: Array<{ symbol: string; days: string[]; runs: ZeroVolumeRun[] }>;
  jumps: Array<{ symbol: string; day: string; ratio: number }>;
  sha256: string;
}

export function buildReport(
  universeSha256: string,
  through: string,
  results: SymbolGapResult[]
): { report: GapReport; repairFile: Array<{ symbol: string; klineDays: string[] }> } {
  const sorted = [...results].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  const content = {
    universeSha256,
    through,
    counts: {
      symbolsChecked: sorted.length,
      notIngested: sorted.filter((r) => r.notIngested).length,
      symbolsWithGaps: sorted.filter((r) => r.repairDays.length + r.sourceGapDays.length > 0).length,
      repairDays: sorted.reduce((n, r) => n + r.repairDays.length, 0),
      sourceGapDays: sorted.reduce((n, r) => n + r.sourceGapDays.length, 0),
      jumps: sorted.reduce((n, r) => n + r.jumps.length, 0),
      zeroVolumeDays: sorted.reduce((n, r) => n + r.zeroVolumeDays.length, 0),
    },
    notIngested: sorted.filter((r) => r.notIngested).map((r) => r.symbol),
    sourceGaps: sorted.filter((r) => r.sourceGapDays.length > 0).map((r) => ({ symbol: r.symbol, days: r.sourceGapDays })),
    repairs: sorted.filter((r) => r.repairDays.length > 0).map((r) => ({ symbol: r.symbol, days: r.repairDays })),
    zeroVolume: sorted
      .filter((r) => r.zeroVolumeDays.length > 0)
      .map((r) => ({ symbol: r.symbol, days: r.zeroVolumeDays, runs: r.zeroVolumeRuns })),
    jumps: sorted.flatMap((r) => r.jumps.map((j) => ({ symbol: r.symbol, day: j.day, ratio: j.ratio }))),
  };
  const sha256 = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return {
    report: { ...content, sha256 },
    repairFile: content.repairs.map((r) => ({ symbol: r.symbol, klineDays: r.days })),
  };
}

function parseCliArgs(argv: string[]): {
  universe: string;
  repairOut: string;
  reportOut: string;
  mongoUri: string;
  through: string;
} {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    i++;
  }
  const need = (name: string): string => {
    const value = flags.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const through = flags.get('through') ?? DEFAULT_THROUGH;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through)) throw new Error(`--through: expected YYYY-MM-DD, got "${through}"`);
  return {
    universe: need('universe'),
    repairOut: need('repair-out'),
    reportOut: need('report-out'),
    mongoUri: flags.get('mongo-uri') ?? process.env.MONGODB_URI ?? '',
    through,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);
  if (!args.mongoUri) throw new Error('A MongoDB URI is required (--mongo-uri or MONGODB_URI)');
  const universe = JSON.parse(readFileSync(args.universe, 'utf8')) as UniverseSource;
  const folders = universe.folders.filter((f) => f.include);

  process.env.MONGODB_URI = args.mongoUri;
  await connectDB();
  try {
    const results: SymbolGapResult[] = [];
    for (const folder of folders) {
      // Read-only: a projection of two fields of one symbol's 1d klines.
      const docs = await PerpCandle.find(
        { symbol: folder.name, interval: '1d', series: 'klines' },
        { timestamp: 1, close: 1, volume: 1, _id: 0 }
      ).lean();
      const bars = docs.map((d) => ({ day: dayNumber(d.timestamp), close: d.close, volume: d.volume }));
      const result = await analyzeSymbol(
        folder,
        bars,
        (symbol) => listKeys(`${DAILY_KLINES_PREFIX}${symbol}/1d/`),
        args.through
      );
      if (result) results.push(result);
    }

    const { report, repairFile } = buildReport(universe.sha256, args.through, results);
    writeFileSync(args.repairOut, `${JSON.stringify(repairFile, null, 2)}\n`);
    writeFileSync(args.reportOut, `${JSON.stringify(report, null, 2)}\n`);
    console.error(JSON.stringify(report.counts));
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
