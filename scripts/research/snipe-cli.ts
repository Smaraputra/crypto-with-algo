/**
 * Shared helpers of the snipe scan and confirmation CLIs: flag parsing, cache loading with the dataset hash and
 * lockbox checks, slice bounds, and the offsets of a slice. No statistics live here (see snipe-stats.ts).
 */
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import {
  SNIPE_COLUMNS,
  SNIPE_CONFIRMATION,
  SNIPE_DISCOVERY,
  SNIPE_LOCKBOX_START,
  SNIPE_NULL,
  SNIPE_TAIL_LEVELS,
  SNIPE_TIMEFRAMES,
  type SnipeTimeframe,
} from './snipe';
import { readSnipeCache } from './snipe-cache';
import type { SnipeSymbolArrays } from './snipe-matrix';
import { nullOffsets, type SnipeCell, type SnipeSlice } from './snipe-stats';

/** Timeframes in the fixed evaluation order, whatever order the flag lists them in. */
export const TIMEFRAME_ORDER: SnipeTimeframe[] = ['scalp', 'intraday'];

export function parseFlags(argv: string[], allowed: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!allowed.includes(key)) throw new Error(`Unknown flag --${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    flags.set(key, value);
    i++;
  }
  return flags;
}

export function parseTimeframes(raw: string | undefined): SnipeTimeframe[] {
  const given = (raw ?? 'scalp,intraday').split(',').map((s) => s.trim());
  for (const tf of given) {
    if (!(tf in SNIPE_TIMEFRAMES)) throw new Error(`Unknown timeframe ${tf}`);
  }
  return TIMEFRAME_ORDER.filter((tf) => given.includes(tf));
}

export function parseDraws(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--draws must be a positive integer, got ${raw}`);
  return n;
}

export function parseSymbols(raw: string | undefined): string[] {
  return raw ? raw.split(',').map((s) => s.trim()) : [...SIGNAL_SYMBOLS];
}

/** `<column>:<tail>:<level>:<timeframe>`, e.g. raw.ret1:top:many:intraday. */
export function parseCellSpec(raw: string): SnipeCell {
  const parts = raw.split(':');
  if (parts.length !== 4) throw new Error(`--cell must be <column>:<tail>:<level>:<timeframe>, got ${raw}`);
  const [column, tail, level, timeframe] = parts;
  if (!(SNIPE_COLUMNS as readonly string[]).includes(column)) throw new Error(`Unknown column ${column}`);
  if (tail !== 'top' && tail !== 'bottom') throw new Error(`Unknown tail ${tail}`);
  if (!(level in SNIPE_TAIL_LEVELS)) throw new Error(`Unknown level ${level}`);
  if (!(timeframe in SNIPE_TIMEFRAMES)) throw new Error(`Unknown timeframe ${timeframe}`);
  return { column, tail, level: level as SnipeCell['level'], timeframe: timeframe as SnipeTimeframe };
}

/**
 * AMENDMENT 1 (A1-7): a slice ends 1 ms before the next slice starts (2024-12-31T23:59:59.999Z for discovery,
 * 2026-06-30T23:59:59.999Z for confirmation), so the last bar's trade window is not dropped by second rounding.
 */
export function discoverySlice(): SnipeSlice {
  return { startMs: Date.parse(SNIPE_DISCOVERY.start), endMs: Date.parse(SNIPE_CONFIRMATION.start) - 1 };
}

export function confirmationSlice(): SnipeSlice {
  return { startMs: Date.parse(SNIPE_CONFIRMATION.start), endMs: Date.parse(SNIPE_LOCKBOX_START) - 1 };
}

export function maxHoldMsOf(tf: SnipeTimeframe): number {
  return SNIPE_TIMEFRAMES[tf].maxHoldMs;
}

export function intervalMsOf(tf: SnipeTimeframe): number {
  const interval = SNIPE_TIMEFRAMES[tf].interval;
  return interval === '5m' ? 5 * 60_000 : 60 * 60_000;
}

/** minShiftDays in bars of the timeframe. */
export function minShiftBarsOf(tf: SnipeTimeframe): number {
  return Math.round((SNIPE_NULL.minShiftDays * 86_400_000) / intervalMsOf(tf));
}

/** Offsets of one (timeframe, slice), generated once and shared by every cell. */
export function offsetsFor(tf: SnipeTimeframe, gridLength: number, draws: number): Int32Array {
  return nullOffsets(gridLength, minShiftBarsOf(tf), draws, SNIPE_NULL.seed);
}

/** Lockbox: no bar timestamp or entry time at or after SNIPE_LOCKBOX_START may be in a loaded array. */
export function assertNoLockbox(arrays: SnipeSymbolArrays): void {
  const lock = Date.parse(SNIPE_LOCKBOX_START);
  for (const name of ['timestamps', 'entryMs'] as const) {
    const a = arrays[name];
    for (let i = 0; i < a.length; i++) {
      if (a[i] >= lock) {
        throw new Error(`snipe: ${arrays.symbol}.${arrays.timeframe} ${name}[${i}] is at or after the lockbox start`);
      }
    }
  }
}

export interface LoadedTimeframe {
  arrays: SnipeSymbolArrays[];
  datasetManifestHash: string;
}

/** Reads every symbol's cache (sha256 verified by the reader), one manifest hash across all, lockbox asserted. */
export function loadTimeframe(
  cacheDir: string,
  symbols: string[],
  timeframe: SnipeTimeframe,
  expectedHash?: string
): LoadedTimeframe {
  let hash = expectedHash;
  const arrays: SnipeSymbolArrays[] = [];
  for (const symbol of symbols) {
    const { index, data } = readSnipeCache(cacheDir, symbol, timeframe);
    if (hash === undefined) hash = index.datasetManifestHash;
    else if (index.datasetManifestHash !== hash) {
      throw new Error(
        `snipe: dataset manifest hash mismatch at ${symbol}.${timeframe}: ${index.datasetManifestHash} vs ${hash}`
      );
    }
    assertNoLockbox(data);
    arrays.push(data);
  }
  return { arrays, datasetManifestHash: hash ?? '' };
}
