/**
 * The legends phase's six strategy-harness rules, exactly as pre-registered
 * in the header of scripts/research/trend-sim.ts (LOCKED 2026-10-02). Every
 * parameter is fixed by that text, so each family is ONE cell: there is no
 * grid and no selection. Run in the harness's fixed-evaluation mode.
 *
 *   P1  turtle-s2               1d  Turtle System 2, single unit (Faith)
 *   P2  nr7                     1d  Crabel NR7 bracket
 *   P3  holy-grail              1d  Raschke Holy Grail
 *   P4  turtle-soup-plus-one    1d  Raschke Turtle Soup Plus One
 *   C1  bollinger-breakout      1h  Bollinger (42, 2.5) breakout, the scour's R30
 *   C2  rsi70-breakout          4h  RSI(14) crosses above 70, long-only, the scour's X24
 *
 * Choices the locked text leaves open, recorded here and in the pre-registration's implementation notes:
 * - P1's 55-day channel at the close of bar t is the high and low of bars t-54..t,
 *   the levels the next bar must break; its 20-day exit channel, applied through
 *   `manage` one bar behind, is bars p-19..p of the prior bar p.
 * - P2's NR7 holds when today's range is at most each of the prior six ranges.
 * - P3's "while the setup holds" is read as the trend condition (ADX(14) > 30 and
 *   the DI order) still holding at each re-placement close; the setup bar is the
 *   most recent one in the last three bars; the stop is the lowest low (highest
 *   high) from the setup bar through the decision bar; a target on the wrong
 *   side of the trigger cancels the setup, and so does any later bar reaching
 *   the trigger (re-placement is for an UNFILLED order, so a setup whose trade
 *   filled, or whose breakout passed, is never entered again).
 * - P4's "prior 20-day low at least 3 sessions old" takes the most recent bar at
 *   that low and requires it at t-3 or earlier.
 * - C1's "close of the 18th bar after entry", with entry at a bar's open (that
 *   bar is the first after the entry moment, the source's 1,075 minutes), is the
 *   close of entry bar + 17: timeStopBars 17. P4's entry is inside day two, so
 *   its "sixth bar after entry" is day two + 6: timeStopBars 6.
 * - Short legs mirror the long definitions where the text gives only the long side.
 * - The random-entry null enters at the next open (nextOpenEntryWrapper).
 */
import type { EntryDecision, ManagementContext, Strategy, StrategyContext } from '@/lib/backtest/strategy';
import type { OpenPosition } from '@/lib/backtest/trade-utils';
import type { StrategyFamily } from '../strategy-families';
import { adx, atr, bollinger, ema, highest, lowest, nextOpenEntryWrapper, rsi, turtleN } from './legends-indicators';

const finite = (x: number) => Number.isFinite(x);

function base(name: string): Pick<Strategy, 'name' | 'params' | 'entryWrapper'> {
  return { name, params: {}, entryWrapper: nextOpenEntryWrapper };
}

/** P1: Turtle System 2, one unit. */
export const turtleS2Family: StrategyFamily = {
  name: 'turtle-s2',
  description: 'P1 Turtle System 2 single unit: 55-day OCO stop bracket, 2N stop, 20-day opposite-extreme exit (1d)',
  params: [],
  create(): Strategy {
    return {
      ...base('turtle-s2'),
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        const t = ctx.bar;
        if (t < 54) return null;
        const n = turtleN(ctx.candles)[t];
        if (!finite(n) || !(n > 0)) return null;
        const high55 = highest(ctx.candles, t - 54, t);
        const low55 = lowest(ctx.candles, t - 54, t);
        return {
          side: 'long',
          orderType: 'stop',
          triggerPrice: high55,
          timeoutBars: 1,
          stopPrice: high55 - 2 * n,
          targetPrice: null,
          fillRelative: { stopDistance: 2 * n },
          oco: {
            side: 'short',
            triggerPrice: low55,
            stopPrice: low55 + 2 * n,
            targetPrice: null,
            fillRelative: { stopDistance: 2 * n },
          },
        };
      },
      decideExit: () => false,
      manage(ctx: ManagementContext, position: OpenPosition) {
        const p = ctx.bar;
        if (p < 19) return null;
        const initial = position.initialStopPrice ?? position.stopPrice;
        return position.side === 'long'
          ? { stopPrice: Math.max(initial, lowest(ctx.candles, p - 19, p)) }
          : { stopPrice: Math.min(initial, highest(ctx.candles, p - 19, p)) };
      },
    };
  },
};

/** P2: Crabel NR7. */
export const nr7Family: StrategyFamily = {
  name: 'nr7',
  description: 'P2 Crabel NR7: next-bar OCO stop bracket at the NR7 high and low, opposite-extreme stop, first profitable close (1d)',
  params: [],
  create(): Strategy {
    return {
      ...base('nr7'),
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        const t = ctx.bar;
        if (t < 6) return null;
        const c = ctx.candles;
        const range = c[t].high - c[t].low;
        for (let k = t - 6; k < t; k++) if (range > c[k].high - c[k].low) return null;
        return {
          side: 'long',
          orderType: 'stop',
          triggerPrice: c[t].high,
          timeoutBars: 1,
          stopPrice: c[t].low,
          targetPrice: null,
          oco: { side: 'short', triggerPrice: c[t].low, stopPrice: c[t].high, targetPrice: null },
        };
      },
      decideExit(ctx: StrategyContext): boolean {
        const pos = ctx.position;
        if (!pos) return false;
        const close = ctx.candles[ctx.bar].close;
        return pos.side === 'long' ? close > pos.entryPrice : close < pos.entryPrice;
      },
    };
  },
};

/** The most recent Holy Grail setup bar among t, t-1, t-2 for `side`, or -1. */
function holyGrailSetup(ctx: StrategyContext, side: 'long' | 'short'): number {
  const c = ctx.candles;
  const { adx: a, plusDi, minusDi } = adx(c, 14);
  const e = ema(c, 20);
  const t = ctx.bar;
  const trendHolds = (i: number) =>
    a[i] > 30 && (side === 'long' ? plusDi[i] > minusDi[i] : minusDi[i] > plusDi[i]);
  if (!trendHolds(t)) return -1;
  for (let s = t; s >= t - 2; s--) {
    if (s < 21 || s - 5 < 0) continue;
    if (!finite(a[s]) || !finite(a[s - 5]) || !finite(e[s]) || !finite(e[s - 1])) continue;
    if (!(trendHolds(s) && a[s] > a[s - 5])) continue;
    const pulledBack =
      side === 'long'
        ? c[s].low <= e[s] && c[s - 1].close > e[s - 1]
        : c[s].high >= e[s] && c[s - 1].close < e[s - 1];
    if (!pulledBack) continue;
    // A setup is re-placed only while its order is UNFILLED: once a bar after
    // the setup has reached the trigger, the setup has been traded (or its
    // breakout passed) and is spent, so a trade that exited never re-enters it.
    if (s < t) {
      const reached = side === 'long' ? highest(c, s + 1, t) >= c[s].high : lowest(c, s + 1, t) <= c[s].low;
      if (reached) return -1;
    }
    return s;
  }
  return -1;
}

/** P3: Raschke Holy Grail. */
export const holyGrailFamily: StrategyFamily = {
  name: 'holy-grail',
  description: 'P3 Raschke Holy Grail: ADX(14) > 30 and rising, pullback to EMA20, stop entry at the setup bar extreme for up to 3 bars (1d)',
  params: [],
  create(): Strategy {
    return {
      ...base('holy-grail'),
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        const c = ctx.candles;
        const t = ctx.bar;
        const longSetup = holyGrailSetup(ctx, 'long');
        if (longSetup !== -1) {
          const trigger = c[longSetup].high;
          const target = highest(c, longSetup - 20, longSetup - 1);
          if (target > trigger) {
            return {
              side: 'long',
              orderType: 'stop',
              triggerPrice: trigger,
              timeoutBars: 1,
              stopPrice: lowest(c, longSetup, t),
              targetPrice: target,
            };
          }
        }
        const shortSetup = holyGrailSetup(ctx, 'short');
        if (shortSetup !== -1) {
          const trigger = c[shortSetup].low;
          const target = lowest(c, shortSetup - 20, shortSetup - 1);
          if (target < trigger) {
            return {
              side: 'short',
              orderType: 'stop',
              triggerPrice: trigger,
              timeoutBars: 1,
              stopPrice: highest(c, shortSetup, t),
              targetPrice: target,
            };
          }
        }
        return null;
      },
      decideExit: () => false,
    };
  },
};

/** The most recent index of the extreme over bars from..to (inclusive). */
function lastIndexOfExtreme(ctx: StrategyContext, from: number, to: number, side: 'low' | 'high'): number {
  const c = ctx.candles;
  let best = to;
  for (let i = to; i >= from; i--) {
    if (side === 'low' ? c[i].low < c[best].low : c[i].high > c[best].high) best = i;
  }
  return best;
}

/** P4: Raschke Turtle Soup Plus One. */
export const turtleSoupPlusOneFamily: StrategyFamily = {
  name: 'turtle-soup-plus-one',
  description: 'P4 Raschke Turtle Soup Plus One: a failed 20-day breakout of a 3+ session old extreme, stop entry back through it on day two (1d)',
  params: [],
  create(): Strategy {
    return {
      ...base('turtle-soup-plus-one'),
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        const t = ctx.bar;
        if (t < 20) return null;
        const c = ctx.candles;
        const lowIdx = lastIndexOfExtreme(ctx, t - 20, t - 1, 'low');
        const priorLow = c[lowIdx].low;
        if (t - lowIdx >= 3 && c[t].low < priorLow && c[t].close <= priorLow) {
          return {
            side: 'long',
            orderType: 'stop',
            triggerPrice: priorLow,
            timeoutBars: 1,
            stopPrice: c[t].low,
            targetPrice: null,
            timeStopBars: 6,
          };
        }
        const highIdx = lastIndexOfExtreme(ctx, t - 20, t - 1, 'high');
        const priorHigh = c[highIdx].high;
        if (t - highIdx >= 3 && c[t].high > priorHigh && c[t].close >= priorHigh) {
          return {
            side: 'short',
            orderType: 'stop',
            triggerPrice: priorHigh,
            timeoutBars: 1,
            stopPrice: c[t].high,
            targetPrice: null,
            timeStopBars: 6,
          };
        }
        return null;
      },
      decideExit: () => false,
      manage(ctx: ManagementContext, position: OpenPosition) {
        // From day three: the lower (higher) of day one's and day two's lows (highs).
        // Day two is the fill bar; ctx.bar is the bar before the current one.
        if (ctx.bar < position.entryBar) return null;
        const dayTwo = ctx.candles[position.entryBar];
        const dayOne = position.initialStopPrice ?? position.stopPrice;
        return position.side === 'long'
          ? { stopPrice: Math.min(dayOne, dayTwo.low) }
          : { stopPrice: Math.max(dayOne, dayTwo.high) };
      },
    };
  },
};

/** C1: Bollinger (42, 2.5) breakout, 1h. */
export const bollingerBreakoutFamily: StrategyFamily = {
  name: 'bollinger-breakout',
  description: 'C1 (R30) Bollinger (42, 2.5) close breakout, next-open fill, 3% target, 1.5% stop, 18-bar time exit (1h)',
  params: [],
  create(): Strategy {
    return {
      ...base('bollinger-breakout'),
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        const t = ctx.bar;
        const bb = bollinger(ctx.candles, 42, 2.5);
        const close = ctx.candles[t].close;
        if (!finite(bb.upper[t]) || !finite(bb.lower[t])) return null;
        const fillRelative = { stopFraction: 0.015, targetFraction: 0.03 };
        if (close >= bb.upper[t]) {
          return {
            side: 'long',
            orderType: 'next-open',
            stopPrice: close * (1 - 0.015),
            targetPrice: close * (1 + 0.03),
            timeStopBars: 17,
            fillRelative,
          };
        }
        if (close <= bb.lower[t]) {
          return {
            side: 'short',
            orderType: 'next-open',
            stopPrice: close * (1 + 0.015),
            targetPrice: close * (1 - 0.03),
            timeStopBars: 17,
            fillRelative,
          };
        }
        return null;
      },
      decideExit: () => false,
    };
  },
};

/** C2: RSI(14) crosses above 70, 4h, long-only. */
export const rsi70BreakoutFamily: StrategyFamily = {
  name: 'rsi70-breakout',
  description: 'C2 (X24) RSI(14) closes above 70 from at or below: long at the next open, out at the next open after it closes below 70, 10 ATR disaster stop (4h)',
  params: [],
  create(): Strategy {
    return {
      ...base('rsi70-breakout'),
      exitFill: 'next-open',
      decideEntry(ctx: StrategyContext): EntryDecision | null {
        const t = ctx.bar;
        if (t < 1) return null;
        const r = rsi(ctx.candles, 14);
        const a = atr(ctx.candles, 14)[t];
        if (!finite(r[t]) || !finite(r[t - 1]) || !finite(a) || !(a > 0)) return null;
        if (!(r[t] > 70 && r[t - 1] <= 70)) return null;
        const close = ctx.candles[t].close;
        return {
          side: 'long',
          orderType: 'next-open',
          stopPrice: close - 10 * a,
          targetPrice: null,
          fillRelative: { stopDistance: 10 * a },
        };
      },
      decideExit(ctx: StrategyContext): boolean {
        return rsi(ctx.candles, 14)[ctx.bar] < 70;
      },
    };
  },
};

export const LEGENDS_FAMILIES: Record<string, StrategyFamily> = {
  'turtle-s2': turtleS2Family,
  nr7: nr7Family,
  'holy-grail': holyGrailFamily,
  'turtle-soup-plus-one': turtleSoupPlusOneFamily,
  'bollinger-breakout': bollingerBreakoutFamily,
  'rsi70-breakout': rsi70BreakoutFamily,
};
