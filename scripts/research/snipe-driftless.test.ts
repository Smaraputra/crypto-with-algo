/**
 * Snipe regression test for AMENDMENT 1, A1-1: the baseline must not absorb the flagged move.
 *
 * The final review of the snipe branch (.superpowers/sdd/snipe-precision-2026-10-10/final-review.md) ran the
 * branch's own modules on simulated DRIFTLESS prices, where no edge exists by construction, and found that the
 * locked baseline (symbol x calendar month x ATR quintile) made every return-extreme cell look like a reversal
 * edge (z about +/-3.6 at 1h): bars before an extreme move share its month and their label windows contain the
 * move, so the month's baseline leans against it. This test is that simulation, committed: it runs the real
 * pipeline (monthlyThresholds, tailFlags, atrQuintiles, labelEntries, buildSliceContext, nullOffsets,
 * evaluateCell) on 10 symbols of zero-mean log-returns with a common factor (cross-symbol correlation) and
 * slowly varying volatility (so ATR quintiles differ), 1h entry bars over about 15 months with a consistent 5m
 * path (12 sub-steps per hour, the 1h OHLC is the envelope of its sub-steps), and requires the mean z of the
 * 10% tail cells of a trailing 20-bar and a trailing 5-bar return to centre near zero. With the month in the
 * baseline key it fails (per-cell mean z of several units); with the ATR quintile alone it passes. It is the
 * evidence that A1-1 removes the bias.
 */
import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import { seededRandom } from './carry-sim';
import { SNIPE_ATR_PERIOD, SNIPE_BARRIER_ATR, SNIPE_NULL, SNIPE_THRESHOLD_LOOKBACK_DAYS, SNIPE_TIMEFRAMES } from './snipe';
import { labelEntries } from './snipe-labels';
import type { SnipeSymbolArrays } from './snipe-matrix';
import { buildSliceContext, evaluateCell, nullOffsets, type SnipeCell } from './snipe-stats';
import { atrQuintiles, monthIndex, monthlyThresholds, tailFlags, TAIL_PROBS } from './snipe-tails';

const M5 = 5 * 60_000;
const H1 = 12 * M5;
const HOURS = 465 * 24;
const START = Date.UTC(2022, 0, 1);
const SYMBOLS = 10;
const REPLICATIONS = 40;
const DRAWS = 100;
const RHO = 0.25;
const PHI = 0.998;

interface SimulatedSymbol {
  entryBars: OHLCV[];
  pathBars: OHLCV[];
}

/** Driftless 5m paths for SYMBOLS symbols; the 1h bars are the envelopes of their 12 sub-steps. */
function simulate(seed: number): SimulatedSymbol[] {
  const random = seededRandom(seed);
  const gauss = (): number => {
    const u = 1 - random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };
  const innov = Math.sqrt(1 - PHI * PHI);
  let commonVol = 0;
  const symbolVol = new Float64Array(SYMBOLS);
  const price = new Float64Array(SYMBOLS).fill(100);
  const out: SimulatedSymbol[] = Array.from({ length: SYMBOLS }, () => ({ entryBars: [], pathBars: [] }));
  for (let h = 0; h < HOURS; h++) {
    commonVol = PHI * commonVol + innov * gauss();
    const hourStart = START + h * H1;
    const hi = new Float64Array(SYMBOLS).fill(-Infinity);
    const lo = new Float64Array(SYMBOLS).fill(Infinity);
    const open = Float64Array.from(price);
    const sigma = new Float64Array(SYMBOLS);
    for (let s = 0; s < SYMBOLS; s++) {
      symbolVol[s] = PHI * symbolVol[s] + innov * gauss();
      sigma[s] = 0.0014 * Math.exp(0.5 * (0.6 * commonVol + 0.8 * symbolVol[s]));
    }
    for (let k = 0; k < 12; k++) {
      const factor = gauss();
      for (let s = 0; s < SYMBOLS; s++) {
        const o = price[s];
        const c = o * Math.exp(sigma[s] * (Math.sqrt(RHO) * factor + Math.sqrt(1 - RHO) * gauss()));
        price[s] = c;
        const high = Math.max(o, c);
        const low = Math.min(o, c);
        if (high > hi[s]) hi[s] = high;
        if (low < lo[s]) lo[s] = low;
        out[s].pathBars.push({ timestamp: hourStart + k * M5, open: o, high, low, close: c, volume: 1 });
      }
    }
    for (let s = 0; s < SYMBOLS; s++) {
      out[s].entryBars.push({ timestamp: hourStart, open: open[s], high: hi[s], low: lo[s], close: price[s], volume: 1 });
    }
  }
  return out;
}

/** Trailing n-bar log return of the closes, NaN before n bars exist. */
function trailingReturn(bars: OHLCV[], n: number): Float64Array {
  const out = new Float64Array(bars.length).fill(Number.NaN);
  for (let i = n; i < bars.length; i++) out[i] = Math.log(bars[i].close / bars[i - n].close);
  return out;
}

function arraysOf(symbol: string, sim: SimulatedSymbol): SnipeSymbolArrays {
  const { maxHoldMs } = SNIPE_TIMEFRAMES.intraday;
  const timestamps = Float64Array.from(sim.entryBars, (b) => b.timestamp);
  const labels = labelEntries({
    entryBars: sim.entryBars,
    entryIntervalMs: H1,
    pathBars: sim.pathBars,
    maxHoldMs,
    atrPeriod: SNIPE_ATR_PERIOD,
    barrierAtr: SNIPE_BARRIER_ATR,
    sliceEndMs: timestamps[timestamps.length - 1] + H1 - 1,
  });
  const columns = ['ret20', 'ret5'];
  const flags = [trailingReturn(sim.entryBars, 20), trailingReturn(sim.entryBars, 5)].map((values) =>
    tailFlags(timestamps, values, monthlyThresholds(timestamps, values, TAIL_PROBS, SNIPE_THRESHOLD_LOOKBACK_DAYS, H1))
  );
  return {
    symbol,
    timeframe: 'intraday',
    columns,
    timestamps,
    flags,
    ...labels,
    atrQuintile: atrQuintiles(timestamps, labels.atrPct, SNIPE_THRESHOLD_LOOKBACK_DAYS, H1),
    month: Int32Array.from(timestamps, monthIndex),
    warmupBars: 20,
    finiteShare: [1, 1],
  };
}

const CELLS: SnipeCell[] = [
  { column: 'ret20', tail: 'top', level: 'many', timeframe: 'intraday' },
  { column: 'ret20', tail: 'bottom', level: 'many', timeframe: 'intraday' },
  { column: 'ret5', tail: 'top', level: 'many', timeframe: 'intraday' },
  { column: 'ret5', tail: 'bottom', level: 'many', timeframe: 'intraday' },
];

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('snipe pipeline on driftless prices (A1-1)', () => {
  it(
    'centres the null-calibrated z of the return-extreme cells near zero',
    () => {
      const zs: number[][] = CELLS.map(() => []);
      for (let r = 0; r < REPLICATIONS; r++) {
        const sims = simulate(1_000 + r);
        const list = sims.map((sim, s) => arraysOf(`S${s}`, sim));
        const ctx = buildSliceContext(
          list,
          { startMs: START, endMs: START + HOURS * H1 - 1 },
          'intraday',
          SNIPE_TIMEFRAMES.intraday.maxHoldMs
        );
        const shift = Math.round((SNIPE_NULL.minShiftDays * 86_400_000) / H1);
        const offsets = nullOffsets(ctx.grid.G, shift, DRAWS, SNIPE_NULL.seed);
        CELLS.forEach((cell, c) => zs[c].push(evaluateCell(ctx, cell, offsets).z));
      }
      const all = zs.flat();
      expect(all.every(Number.isFinite)).toBe(true);
      const reversal = zs.flatMap((z, c) => z.map((v) => (CELLS[c].tail === 'top' ? -v : v)));
      if (process.env.SNIPE_DRIFTLESS_LOG) {
        process.stderr.write(
          JSON.stringify({ cellMeans: zs.map(mean), meanZ: mean(all), meanReversalZ: mean(reversal), maxAbsZ: Math.max(...all.map(Math.abs)) }) + '\n'
        );
      }
      // Per cell, and overall in the reversal direction (a top-tail cell biased against the move has z < 0).
      CELLS.forEach((_, c) => expect(Math.abs(mean(zs[c]))).toBeLessThan(1));
      expect(Math.abs(mean(reversal))).toBeLessThan(1);
      expect(Math.abs(mean(all))).toBeLessThan(1);
      expect(Math.max(...all.map(Math.abs))).toBeLessThan(4);
    },
    240_000
  );
});
