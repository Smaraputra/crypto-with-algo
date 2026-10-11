import type { EntryDecision, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import { researchValue } from '@/lib/backtest/research-series';
import type { OHLCV } from '@/types/market';
import type { SignalComponent } from '@/types/signal';
import type { StrategyFamily } from '../strategy-families';
import {
  DIRECTION_EXIT_ASIA_HOURS_UTC, DIRECTION_EXIT_ATR_PERIOD, DIRECTION_EXIT_CELLS, DIRECTION_EXIT_CUTOFFS,
  DIRECTION_EXIT_EXIT_FRACTION, DIRECTION_EXIT_FIT, DIRECTION_EXIT_K_GRID, DIRECTION_EXIT_PROTECTIVE_STOP_ATR,
  type DirectionExitFit,
} from '../direction-exit';
import { atr, nextOpenEntryWrapper } from './legends-indicators';

export const DX_VOL_COLUMN = 'dx.volTopThreshold';

export function d1FromComponents(components: readonly SignalComponent[], signs: DirectionExitFit['signs']): number | null {
  let sum = 0;
  let n = 0;
  for (const c of components) {
    if (c.signals.length === 0) continue;
    sum += signs[c.category as keyof DirectionExitFit['signs']] * c.score;
    n++;
  }
  return n > 0 ? sum / n : null;
}

/** factors.ts realizedVol20 on OHLCV closes. */
export function vol20(candles: readonly OHLCV[], bar: number): number {
  if (bar < 20) return NaN;
  const r: number[] = [];
  for (let k = bar - 19; k <= bar; k++) r.push(Math.log(candles[k].close / candles[k - 1].close));
  const mean = r.reduce((s, v) => s + v, 0) / r.length;
  return Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / (r.length - 1));
}

type Direction = (ctx: StrategyContext) => { dir: 1 | -1; score: number } | null;

const tierDirection: Direction = (ctx) => {
  if (ctx.tier === 'buy' || ctx.tier === 'strong_buy') return { dir: 1, score: ctx.score };
  if (ctx.tier === 'sell' || ctx.tier === 'strong_sell') return { dir: -1, score: ctx.score };
  return null;
};

function horizonOf(interval: string): number {
  const cell = DIRECTION_EXIT_CELLS.find((c) => c.interval === interval);
  if (!cell) throw new Error(`direction-exit: no cell at ${interval}`);
  return cell.horizonBars;
}

function conditionHolds(cond: number, ctx: StrategyContext, dir: 1 | -1): boolean {
  if (cond === 1) {
    const htf = ctx.components?.find((c) => c.category === 'htf');
    return !!htf && htf.signals.length > 0 && Math.sign(htf.score) === dir;
  }
  if (cond === 2) {
    const v = vol20(ctx.candles, ctx.bar);
    const t = researchValue(ctx.research, ctx.bar, DX_VOL_COLUMN);
    return Number.isFinite(v) && Number.isFinite(t) && v <= t;
  }
  if (cond === 3) return Math.abs(ctx.score) > DIRECTION_EXIT_CUTOFFS.strong;
  return new Date(ctx.candles[ctx.bar].timestamp).getUTCHours() >= DIRECTION_EXIT_ASIA_HOURS_UTC.to;
}

function makeStrategy(
  name: string,
  direction: Direction,
  exitLevel: number,
  exit: number,
  k: number,
  horizon: number,
  scoreOf: (ctx: StrategyContext) => number | null
): Strategy {
  const inner: Strategy = {
    name,
    // E4's exit is decided at a bar's close and fills at the next bar's open (note N9). E1 to E3 never
    // exit through decideExit, so this changes nothing for them.
    exitFill: 'next-open',
    decideEntry(ctx): EntryDecision | null {
      const d = direction(ctx);
      if (!d) return null;
      const a = atr(ctx.candles, DIRECTION_EXIT_ATR_PERIOD)[ctx.bar];
      if (!Number.isFinite(a) || a <= 0) return null;
      const close = ctx.candles[ctx.bar].close;
      const stopDist = exit === 3 ? k * a : DIRECTION_EXIT_PROTECTIVE_STOP_ATR * a;
      const target = exit === 2 || exit === 3 ? close + d.dir * k * a : null;
      return {
        side: d.dir === 1 ? 'long' : 'short',
        orderType: 'market',
        stopPrice: close - d.dir * stopDist,
        targetPrice: target,
        // The next-open fill is bar i + 1, so h - 1 bars later the time stop closes at close[i + h] (note N8).
        timeStopBars: horizon - 1,
      };
    },
    decideExit(ctx): boolean {
      if (exit !== 4 || !ctx.position) return false;
      const s = scoreOf(ctx);
      if (s === null || !Number.isFinite(s)) return false;
      return ctx.position.side === 'long' ? s <= exitLevel : s >= -exitLevel;
    },
  };
  // Market decisions become next-open fills with fill-relative barriers, as in the legends phase;
  // set as entryWrapper too, so the random-entry benchmark enters the same way.
  return { ...nextOpenEntryWrapper(inner), entryWrapper: nextOpenEntryWrapper };
}

const exitParams = [
  { name: 'exit', values: [1, 2, 3, 4] },
  { name: 'k', values: [...DIRECTION_EXIT_K_GRID] },
];

export const DX_FAMILIES: Record<'dx-d0' | 'dx-d1' | 'dx-d2', StrategyFamily> = {
  'dx-d0': {
    name: 'dx-d0',
    description: 'direction-exit D0: the v8 calls with exit E1 to E4',
    params: exitParams,
    create(params, { interval }) {
      const level = DIRECTION_EXIT_EXIT_FRACTION * DIRECTION_EXIT_CUTOFFS.buy;
      return makeStrategy('dx-d0', tierDirection, level, params.exit, params.k, horizonOf(interval), (ctx) => ctx.score);
    },
  },
  'dx-d1': {
    name: 'dx-d1',
    description: 'direction-exit D1: sign-corrected equal-weight categories',
    params: exitParams,
    create(params, { interval }) {
      const fit = DIRECTION_EXIT_FIT[interval as '1h' | '4h'];
      if (!fit) throw new Error(`dx-d1: DIRECTION_EXIT_FIT['${interval}'] is not recorded yet`);
      const scoreOf = (ctx: StrategyContext) => d1FromComponents(ctx.components ?? [], fit.signs);
      const direction: Direction = (ctx) => {
        const s = scoreOf(ctx);
        return s === null || !Number.isFinite(s) || Math.abs(s) <= fit.threshold ? null : { dir: s > 0 ? 1 : -1, score: s };
      };
      const level = DIRECTION_EXIT_EXIT_FRACTION * fit.threshold;
      return makeStrategy('dx-d1', direction, level, params.exit, params.k, horizonOf(interval), scoreOf);
    },
  },
  'dx-d2': {
    name: 'dx-d2',
    description: 'direction-exit D2: the v8 calls under one abstention condition',
    params: [{ name: 'cond', values: [1, 2, 3, 4] }, ...exitParams],
    requiresResearchColumns: [DX_VOL_COLUMN],
    create(params, { interval }) {
      const direction: Direction = (ctx) => {
        const d = tierDirection(ctx);
        return d && conditionHolds(params.cond, ctx, d.dir) ? d : null;
      };
      const level = DIRECTION_EXIT_EXIT_FRACTION * DIRECTION_EXIT_CUTOFFS.buy;
      return makeStrategy('dx-d2', direction, level, params.exit, params.k, horizonOf(interval), (ctx) => ctx.score);
    },
  },
};
