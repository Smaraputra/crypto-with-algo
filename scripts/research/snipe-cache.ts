/**
 * Snipe phase binary cache: the arrays of one (symbol, timeframe) in a single `<symbol>.<timeframe>.bin`, described
 * by `<symbol>.<timeframe>.json` (array names, dtypes, lengths, 8-byte aligned byte offsets, provenance and the
 * sha256 of the .bin). The reader verifies the hash before returning typed arrays.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SnipeSymbolArrays } from './snipe-matrix';
import type { SnipeTimeframe } from './snipe';

type Dtype = 'f64' | 'i32' | 'i8' | 'u8';
type TypedArray = Float64Array | Int32Array | Int8Array | Uint8Array;

export interface CacheArrayEntry {
  name: string;
  dtype: Dtype;
  length: number;
  offset: number;
}

export interface SnipeCacheIndex {
  version: 1;
  symbol: string;
  timeframe: SnipeTimeframe;
  datasetManifestHash: string;
  gitCommit: string;
  columns: string[];
  warmupBars: number;
  finiteShare: number[];
  arrays: CacheArrayEntry[];
  binBytes: number;
  binSha256: string;
}

const BYTES: Record<Dtype, number> = { f64: 8, i32: 4, i8: 1, u8: 1 };
const FLAG_PREFIX = 'flag:';

function dtypeOf(a: TypedArray): Dtype {
  if (a instanceof Float64Array) return 'f64';
  if (a instanceof Int32Array) return 'i32';
  if (a instanceof Int8Array) return 'i8';
  return 'u8';
}

export function cachePaths(outDir: string, symbol: string, timeframe: string): { bin: string; json: string } {
  return { bin: join(outDir, `${symbol}.${timeframe}.bin`), json: join(outDir, `${symbol}.${timeframe}.json`) };
}

export function writeSnipeCache(
  outDir: string,
  data: SnipeSymbolArrays,
  meta: { datasetManifestHash: string; gitCommit?: string }
): SnipeCacheIndex {
  const named: Array<[string, TypedArray]> = [
    ['timestamps', data.timestamps],
    ['outcome', data.outcome],
    ['entryMs', data.entryMs],
    ['exitMs', data.exitMs],
    ['atrPct', data.atrPct],
    ['entryPrice', data.entryPrice],
    ['atrAbs', data.atrAbs],
    ['gap', data.gap],
    ['atrQuintile', data.atrQuintile],
    ['month', data.month],
    ...data.columns.map((c, i): [string, TypedArray] => [FLAG_PREFIX + c, data.flags[i]]),
  ];

  const arrays: CacheArrayEntry[] = [];
  let offset = 0;
  for (const [name, a] of named) {
    offset = Math.ceil(offset / 8) * 8;
    arrays.push({ name, dtype: dtypeOf(a), length: a.length, offset });
    offset += a.byteLength;
  }
  const bin = Buffer.alloc(offset);
  named.forEach(([, a], i) => {
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(bin, arrays[i].offset);
  });

  const index: SnipeCacheIndex = {
    version: 1,
    symbol: data.symbol,
    timeframe: data.timeframe,
    datasetManifestHash: meta.datasetManifestHash,
    gitCommit: meta.gitCommit ?? process.env.GIT_COMMIT ?? 'unknown',
    columns: data.columns,
    warmupBars: data.warmupBars,
    finiteShare: data.finiteShare,
    arrays,
    binBytes: bin.length,
    binSha256: createHash('sha256').update(bin).digest('hex'),
  };
  mkdirSync(outDir, { recursive: true });
  const paths = cachePaths(outDir, data.symbol, data.timeframe);
  writeFileSync(paths.bin, bin);
  writeFileSync(paths.json, JSON.stringify(index, null, 2));
  return index;
}

export function readSnipeCache(
  outDir: string,
  symbol: string,
  timeframe: SnipeTimeframe
): { index: SnipeCacheIndex; data: SnipeSymbolArrays } {
  const paths = cachePaths(outDir, symbol, timeframe);
  const index = JSON.parse(readFileSync(paths.json, 'utf8')) as SnipeCacheIndex;
  const bin = readFileSync(paths.bin);
  const sha = createHash('sha256').update(bin).digest('hex');
  if (bin.length !== index.binBytes || sha !== index.binSha256) {
    throw new Error(`snipe cache ${symbol}.${timeframe}: .bin does not match its index sha256`);
  }

  const read = (e: CacheArrayEntry): TypedArray => {
    const bytes = e.length * BYTES[e.dtype];
    // Copy into a fresh, aligned buffer (a Buffer from readFileSync can sit at an unaligned pool offset).
    const copy = new Uint8Array(bin.buffer.slice(bin.byteOffset + e.offset, bin.byteOffset + e.offset + bytes));
    const buf = copy.buffer;
    switch (e.dtype) {
      case 'f64':
        return new Float64Array(buf);
      case 'i32':
        return new Int32Array(buf);
      case 'i8':
        return new Int8Array(buf);
      default:
        return new Uint8Array(buf);
    }
  };
  const byName = new Map(index.arrays.map((e) => [e.name, e]));
  const get = (name: string): TypedArray => {
    const e = byName.get(name);
    if (!e) throw new Error(`snipe cache ${symbol}.${timeframe}: array ${name} missing`);
    return read(e);
  };

  const data: SnipeSymbolArrays = {
    symbol: index.symbol,
    timeframe: index.timeframe,
    columns: index.columns,
    timestamps: get('timestamps') as Float64Array,
    flags: index.columns.map((c) => get(FLAG_PREFIX + c) as Uint8Array),
    outcome: get('outcome') as Int8Array,
    entryMs: get('entryMs') as Float64Array,
    exitMs: get('exitMs') as Float64Array,
    atrPct: get('atrPct') as Float64Array,
    entryPrice: get('entryPrice') as Float64Array,
    atrAbs: get('atrAbs') as Float64Array,
    gap: get('gap') as Uint8Array,
    atrQuintile: get('atrQuintile') as Int8Array,
    month: get('month') as Int32Array,
    warmupBars: index.warmupBars,
    finiteShare: index.finiteShare,
  };
  return { index, data };
}
