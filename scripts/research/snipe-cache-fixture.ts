/** Test-support: a small synthetic snipe cache (arrays written with the real cache writer). */
import { seededRandom } from './carry-sim';
import { SNIPE_COLUMNS, SNIPE_TIMEFRAMES, type SnipeTimeframe } from './snipe';
import { writeSnipeCache } from './snipe-cache';
import { OUTCOME_AMBIGUOUS, OUTCOME_DOWN, OUTCOME_TIMEOUT, OUTCOME_UP } from './snipe-labels';
import type { SnipeSymbolArrays } from './snipe-matrix';
import {
  TAIL_BOTTOM_1,
  TAIL_BOTTOM_10,
  TAIL_ELIGIBLE,
  TAIL_TOP_1,
  TAIL_TOP_10,
  monthIndex,
} from './snipe-tails';

export interface SyntheticOpts {
  symbol: string;
  timeframe: SnipeTimeframe;
  startMs: number;
  bars: number;
  seed: number;
  /** A column whose TOP_10 flag is set on a share of the UP bars only (a planted edge). */
  plant?: { column: string; share: number };
}

export function syntheticArrays(o: SyntheticOpts): SnipeSymbolArrays {
  const interval = SNIPE_TIMEFRAMES[o.timeframe].interval === '5m' ? 300_000 : 3_600_000;
  const rnd = seededRandom(o.seed);
  const n = o.bars;
  const timestamps = new Float64Array(n);
  const outcome = new Int8Array(n);
  const entryMs = new Float64Array(n);
  const exitMs = new Float64Array(n);
  const atrPct = new Float64Array(n);
  const atrQuintile = new Int8Array(n);
  const month = new Int32Array(n);
  const flags = SNIPE_COLUMNS.map(() => new Uint8Array(n));
  for (let i = 0; i < n; i++) {
    timestamps[i] = o.startMs + i * interval;
    const u = rnd();
    outcome[i] = u < 0.45 ? OUTCOME_UP : u < 0.9 ? OUTCOME_DOWN : u < 0.95 ? OUTCOME_TIMEOUT : OUTCOME_AMBIGUOUS;
    entryMs[i] = timestamps[i] + interval;
    exitMs[i] = entryMs[i] + interval;
    atrPct[i] = 0.5 + rnd();
    atrQuintile[i] = Math.floor(rnd() * 5);
    month[i] = monthIndex(timestamps[i]);
    for (let c = 0; c < SNIPE_COLUMNS.length; c++) {
      const v = rnd();
      let f = TAIL_ELIGIBLE;
      if (SNIPE_COLUMNS[c] === o.plant?.column) {
        if (outcome[i] === OUTCOME_UP && v < o.plant.share) f |= TAIL_TOP_10;
      } else {
        if (v < 0.1) f |= TAIL_TOP_10;
        if (v < 0.01) f |= TAIL_TOP_1;
        if (v > 0.9) f |= TAIL_BOTTOM_10;
        if (v > 0.99) f |= TAIL_BOTTOM_1;
      }
      flags[c][i] = f;
    }
  }
  return {
    symbol: o.symbol,
    timeframe: o.timeframe,
    columns: [...SNIPE_COLUMNS],
    timestamps,
    flags,
    outcome,
    entryMs,
    exitMs,
    atrPct,
    atrQuintile,
    month,
    warmupBars: 0,
    finiteShare: SNIPE_COLUMNS.map(() => 1),
  };
}

export const FIXTURE_SYMBOLS = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT', 'FFFUSDT', 'GGGUSDT', 'HHHUSDT'];

export interface SyntheticCacheOpts {
  dir: string;
  hash?: string;
  /** Intraday plant, if any. */
  plant?: { column: string; share: number };
  symbols?: string[];
  /** Per-timeframe (start, bars); defaults give a discovery and a confirmation year at 1h and 70 days at 5m. */
  scalp?: { startMs: number; bars: number };
  intraday?: { startMs: number; bars: number };
  /** Overrides the hash for the given symbol (to test a mismatch). */
  hashOverride?: Record<string, string>;
}

export function writeSyntheticCache(o: SyntheticCacheOpts): void {
  const symbols = o.symbols ?? FIXTURE_SYMBOLS;
  const scalp = o.scalp ?? { startMs: Date.UTC(2024, 9, 1), bars: 20_160 };
  const intraday = o.intraday ?? { startMs: Date.UTC(2023, 9, 1), bars: 820 * 24 };
  symbols.forEach((symbol, k) => {
    const hash = o.hashOverride?.[symbol] ?? o.hash ?? 'hash-test';
    writeSnipeCache(
      o.dir,
      syntheticArrays({ symbol, timeframe: 'scalp', seed: 100 + k, ...scalp }),
      { datasetManifestHash: hash }
    );
    writeSnipeCache(
      o.dir,
      syntheticArrays({ symbol, timeframe: 'intraday', seed: 200 + k, plant: o.plant, ...intraday }),
      { datasetManifestHash: hash }
    );
  });
}
