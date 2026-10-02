import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import type { ManagementContext, StrategyContext } from '@/lib/backtest/strategy';
import type { OpenPosition } from '@/lib/backtest/trade-utils';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/types';
import { expandGrid } from '../strategy-families';
import { adx, ema, highest, lowest, rsi, turtleN } from './legends-indicators';
import {
  LEGENDS_FAMILIES,
  bollingerBreakoutFamily,
  holyGrailFamily,
  nr7Family,
  rsi70BreakoutFamily,
  turtleS2Family,
  turtleSoupPlusOneFamily,
} from './legends';

const CTX = { style: 'swing_trading' as const, interval: '1d' };
const CONFIG = DEFAULT_BACKTEST_CONFIG;

function candle(open: number, high: number, low: number, close: number, i = 0): OHLCV {
  return { timestamp: i * 86_400_000, open, high, low, close, volume: 1 };
}

function ctxAt(candles: OHLCV[], bar: number, position: OpenPosition | null = null): StrategyContext {
  return { bar, candles, position } as unknown as StrategyContext;
}

function mctxAt(candles: OHLCV[], bar: number): ManagementContext {
  return { bar, candles } as unknown as ManagementContext;
}

function position(side: 'long' | 'short', entryPrice: number, stop: number, entryBar = 0): OpenPosition {
  return { side, entryPrice, stopPrice: stop, initialStopPrice: stop, entryBar } as OpenPosition;
}

/** A gently oscillating series around `level`, so ranges and true ranges are non-trivial. */
function wavy(n: number, level = 100): OHLCV[] {
  return Array.from({ length: n }, (_, i) => {
    const c = level + Math.sin(i / 3) * 2;
    return candle(c - 0.2, c + 1 + (i % 3) * 0.3, c - 1 - (i % 2) * 0.4, c, i);
  });
}

describe('legends families', () => {
  it('are six single-cell families registered under their own names, entering at the next open in the null', () => {
    expect(Object.keys(LEGENDS_FAMILIES).sort()).toEqual(
      ['bollinger-breakout', 'holy-grail', 'nr7', 'rsi70-breakout', 'turtle-s2', 'turtle-soup-plus-one']
    );
    for (const [name, family] of Object.entries(LEGENDS_FAMILIES)) {
      expect(family.name).toBe(name);
      expect(expandGrid(family)).toEqual([{}]);
      expect(family.create({}, CTX).entryWrapper).toBeTypeOf('function');
    }
  });
});

describe('P1 turtle-s2', () => {
  const c = wavy(80);
  const s = turtleS2Family.create({}, CTX);

  it('brackets the 55-bar high and low with a 2N stop from the fill', () => {
    const t = 70;
    const n = turtleN(c)[t];
    const d = s.decideEntry(ctxAt(c, t), CONFIG)!;
    expect(d).toMatchObject({ side: 'long', orderType: 'stop', timeoutBars: 1, triggerPrice: highest(c, t - 54, t) });
    expect(d.fillRelative?.stopDistance).toBeCloseTo(2 * n, 12);
    expect(d.oco).toMatchObject({ side: 'short', triggerPrice: lowest(c, t - 54, t) });
    expect(d.oco?.fillRelative?.stopDistance).toBeCloseTo(2 * n, 12);
    expect(s.decideEntry(ctxAt(c, 40), CONFIG)).toBeNull(); // N needs 21 bars, the channel 55
  });

  it('trails the prior bar 20-day opposite extreme, never past the 2N stop', () => {
    const low20 = lowest(c, 61, 80 - 1);
    const tight = s.manage!(mctxAt(c, 79), position('long', 110, low20 - 5));
    expect(tight).toEqual({ stopPrice: low20 });
    const loose = s.manage!(mctxAt(c, 79), position('long', 110, low20 + 5));
    expect(loose).toEqual({ stopPrice: low20 + 5 });
    const high20 = highest(c, 60, 79);
    expect(s.manage!(mctxAt(c, 79), position('short', 90, high20 + 3))).toEqual({ stopPrice: high20 });
  });
});

describe('P2 nr7', () => {
  const s = nr7Family.create({}, CTX);
  const ranges = [4, 3, 5, 6, 3.5, 4.5, 2];
  const c = ranges.map((r, i) => candle(100, 100 + r / 2, 100 - r / 2, 100, i));

  it('brackets an NR7 bar at its high and low, each leg stopped at the opposite extreme', () => {
    expect(s.decideEntry(ctxAt(c, 6), CONFIG)).toMatchObject({
      side: 'long',
      orderType: 'stop',
      triggerPrice: 101,
      stopPrice: 99,
      timeoutBars: 1,
      oco: { side: 'short', triggerPrice: 99, stopPrice: 101 },
    });
    const wide = [...c.slice(0, 6), candle(100, 102, 98, 100, 6)];
    expect(s.decideEntry(ctxAt(wide, 6), CONFIG)).toBeNull();
  });

  it('exits at the first close beyond the entry price in the trade favour', () => {
    const bars = [candle(100, 101, 99, 100.5, 0), candle(100, 101, 99, 99.5, 1)];
    expect(s.decideExit(ctxAt(bars, 0, position('long', 100, 99)), CONFIG)).toBe(true);
    expect(s.decideExit(ctxAt(bars, 1, position('long', 100, 99)), CONFIG)).toBe(false);
    expect(s.decideExit(ctxAt(bars, 1, position('short', 100, 101)), CONFIG)).toBe(true);
  });
});

describe('P3 holy-grail', () => {
  // A sideways stretch, a young 15-bar climb (ADX still rising), then one bar
  // dipping to the EMA. A long saturated climb would not do: its ADX sits near
  // 100, so the dip lowers it below its value five bars earlier and the rule
  // (correctly) takes no setup.
  const flat = wavy(40);
  const climb = Array.from({ length: 15 }, (_, k) => {
    const c = flat[39].close + (k + 1) * 1.5;
    return candle(c - 0.6, c + 0.8, c - 0.8, c, 40 + k);
  });
  const trend = [...flat, ...climb];
  const e = ema(trend, 20)[54];
  const pullback = [...trend, candle(trend[54].close, trend[54].close + 0.2, e - 0.1, e + 0.5, 55)];
  const s = holyGrailFamily.create({}, CTX);

  it('places a buy stop at the setup bar high, stop at the low, target at the prior 20-bar high', () => {
    const t = 55;
    const { adx: a, plusDi, minusDi } = adx(pullback, 14);
    expect(a[t]).toBeGreaterThan(30);
    expect(plusDi[t]).toBeGreaterThan(minusDi[t]);
    const d = s.decideEntry(ctxAt(pullback, t), CONFIG)!;
    expect(d).toMatchObject({
      side: 'long',
      orderType: 'stop',
      timeoutBars: 1,
      triggerPrice: pullback[t].high,
      stopPrice: pullback[t].low,
      targetPrice: highest(pullback, t - 20, t - 1),
    });
  });

  it('keeps the setup for up to three bars and then lets it go', () => {
    const next = (k: number) => {
      const p = pullback[55].close + k * 0.3;
      return candle(p, p + 0.4, p - 0.3, p, 55 + k);
    };
    const later = [...pullback, next(1), next(2), next(3)];
    expect(s.decideEntry(ctxAt(later, 57), CONFIG)?.triggerPrice).toBe(pullback[55].high);
    expect(s.decideEntry(ctxAt(later, 57), CONFIG)?.stopPrice).toBe(lowest(later, 55, 57));
    expect(s.decideEntry(ctxAt(later, 58), CONFIG)).toBeNull();
  });

  it('takes no setup without a trend', () => {
    expect(s.decideEntry(ctxAt(wavy(80), 70), CONFIG)).toBeNull();
  });
});

describe('P4 turtle-soup-plus-one', () => {
  const s = turtleSoupPlusOneFamily.create({}, CTX);
  // Bars 0..24; the 20-day low (95) sits at bar 19, five sessions before day one at bar 24.
  const base = Array.from({ length: 25 }, (_, i) => candle(100, 101, 99, 100, i));
  base[19] = candle(100, 101, 95, 99, 19);

  it('buys back through a 3+ session old 20-day low the day after a close beneath it', () => {
    const c = [...base];
    c[24] = candle(96, 96.5, 94, 94.5, 24);
    expect(s.decideEntry(ctxAt(c, 24), CONFIG)).toMatchObject({
      side: 'long',
      orderType: 'stop',
      triggerPrice: 95,
      stopPrice: 94,
      timeoutBars: 1,
      timeStopBars: 6,
    });
  });

  it('skips a low only 2 sessions old and a close back above it', () => {
    const young = [...base];
    young[19] = candle(100, 101, 99, 100, 19);
    young[22] = candle(100, 101, 95, 99, 22);
    young[24] = candle(96, 96.5, 94, 94.5, 24);
    expect(s.decideEntry(ctxAt(young, 24), CONFIG)).toBeNull();
    const reclaimed = [...base];
    reclaimed[24] = candle(96, 96.5, 94, 95.5, 24);
    expect(s.decideEntry(ctxAt(reclaimed, 24), CONFIG)).toBeNull();
  });

  it('moves the stop from day three to the lower of day one and day two lows', () => {
    const c = [...base, candle(95, 97, 93.5, 96, 25)];
    expect(s.manage!(mctxAt(c, 25), position('long', 95, 94, 25))).toEqual({ stopPrice: 93.5 });
  });
});

describe('C1 bollinger-breakout', () => {
  const s = bollingerBreakoutFamily.create({}, CTX);
  const flat = Array.from({ length: 50 }, (_, i) => candle(100, 100.5, 99.5, 100 + (i % 2) * 0.1, i));

  it('goes long at the next open on a close at or above the upper band, 1.5% stop, 3% target, 18 bars', () => {
    const c = [...flat, candle(100, 106, 100, 105, 50)];
    expect(s.decideEntry(ctxAt(c, 50), CONFIG)).toMatchObject({
      side: 'long',
      orderType: 'next-open',
      timeStopBars: 17,
      fillRelative: { stopFraction: 0.015, targetFraction: 0.03 },
    });
    const down = [...flat, candle(100, 100, 94, 95, 50)];
    expect(s.decideEntry(ctxAt(down, 50), CONFIG)?.side).toBe('short');
    expect(s.decideEntry(ctxAt(flat, 49), CONFIG)).toBeNull();
  });
});

describe('C2 rsi70-breakout', () => {
  const s = rsi70BreakoutFamily.create({}, CTX);
  const c = [
    ...Array.from({ length: 20 }, (_, i) => candle(100, 101, 99, 100 + (i % 2 ? 0.5 : -0.5), i)),
    ...Array.from({ length: 6 }, (_, k) => {
      const p = 100 + (k + 1) * 1.5;
      return candle(p - 1, p + 0.5, p - 1.2, p, 20 + k);
    }),
  ];
  const r = rsi(c, 14);
  const cross = r.findIndex((v, i) => i > 0 && v > 70 && r[i - 1] <= 70);

  it('buys at the next open when RSI(14) closes above 70 from at or below, with a 10 ATR stop', () => {
    expect(cross).toBeGreaterThan(0);
    const d = s.decideEntry(ctxAt(c, cross), CONFIG)!;
    expect(d).toMatchObject({ side: 'long', orderType: 'next-open', targetPrice: null });
    expect(d.fillRelative?.stopDistance).toBeGreaterThan(0);
    expect(s.decideEntry(ctxAt(c, cross - 1), CONFIG)).toBeNull();
  });

  it('exits at the next open after RSI closes below 70', () => {
    expect(s.exitFill).toBe('next-open');
    const last = c.length;
    const fall = [...c, candle(108, 108, 100, 101, last)];
    expect(rsi(fall, 14)[last]).toBeLessThan(70);
    expect(s.decideExit(ctxAt(fall, last, position('long', 106, 90)), CONFIG)).toBe(true);
    expect(s.decideExit(ctxAt(c, last - 1, position('long', 106, 90)), CONFIG)).toBe(false);
  });
});
