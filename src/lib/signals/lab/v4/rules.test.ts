import { describe, expect, it } from 'vitest';
import { barDelta } from '@/lib/market/delta';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import type { OHLCV } from '@/types/market';
import { c1Signals, c2Signals } from '../../../../../scripts/research/lab-v4-preview';
import {
  HOUR_MS,
  isContiguousHourly,
  LAB_V4_HOLD_BARS,
  LAB_V4_WINDOW_BARS,
  s1SideAtLast,
  s2SideAtLast,
} from './rules';

function makeCandle(opts: {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume?: number;
}): OHLCV {
  return {
    timestamp: opts.timestamp,
    open: opts.open,
    high: opts.high,
    low: opts.low,
    close: opts.close,
    volume: opts.volume,
    takerBuyVolume: opts.takerBuyVolume,
  };
}

function buildBullChochSeries(breakBarTakerBuyVolume: number): OHLCV[] {
  const bars: OHLCV[] = [];
  const baseTime = 1_700_000_000_000;

  for (let i = 0; i < 87; i++) {
    const timestamp = baseTime + i * HOUR_MS;
    if (i === 20) {
      // Pivot low L1 at index 20 (confirmed at index 40)
      bars.push(
        makeCandle({
          timestamp,
          open: 80,
          high: 85,
          low: 50,
          close: 75,
          volume: 1000,
          takerBuyVolume: 500,
        })
      );
    } else if (i === 41) {
      // Close below L1 breaks active low -> trend becomes -1
      bars.push(
        makeCandle({
          timestamp,
          open: 70,
          high: 75,
          low: 35,
          close: 40,
          volume: 1000,
          takerBuyVolume: 500,
        })
      );
    } else if (i === 65) {
      // Pivot high H1 at index 65 (confirmed at index 85)
      bars.push(
        makeCandle({
          timestamp,
          open: 90,
          high: 150,
          low: 85,
          close: 95,
          volume: 1000,
          takerBuyVolume: 500,
        })
      );
    } else if (i === 86) {
      // Last bar: close breaks active high (150) -> bull CHoCH
      bars.push(
        makeCandle({
          timestamp,
          open: 140,
          high: 165,
          low: 135,
          close: 160,
          volume: 1000,
          takerBuyVolume: breakBarTakerBuyVolume,
        })
      );
    } else {
      bars.push(
        makeCandle({
          timestamp,
          open: 90,
          high: 100,
          low: 80,
          close: 90,
          volume: 1000,
          takerBuyVolume: 500,
        })
      );
    }
  }

  return bars;
}

function buildBearDivergenceSeries(): OHLCV[] {
  const bars: OHLCV[] = [];
  const baseTime = 1_700_000_000_000;

  for (let i = 0; i <= 70; i++) {
    const timestamp = baseTime + i * HOUR_MS;
    let high = 100;
    const low = 80;
    const open = 90;
    const close = 90;
    const volume = 100;
    let takerBuyVolume = 50;

    if (i === 25) {
      // High H1
      high = 150;
    } else if (i === 50) {
      // High H2 (> H1)
      high = 180;
    }

    if (i > 25 && i <= 50) {
      // Net negative delta between H1 and H2
      takerBuyVolume = 30;
    }

    bars.push(
      makeCandle({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        takerBuyVolume,
      })
    );
  }

  return bars;
}

function generateRandomWalkWithTaker(numBars: number, seed: number): OHLCV[] {
  const rand = createSeededRandom(seed);
  const candles: OHLCV[] = [];
  let prevClose = 1000;
  const baseTime = 1_700_000_000_000;

  for (let i = 0; i < numBars; i++) {
    const change = (rand() - 0.49) * 20;
    const open = prevClose;
    const close = Math.round((open + change) * 100) / 100;
    const maxOC = Math.max(open, close);
    const minOC = Math.min(open, close);
    const high = Math.round((maxOC + rand() * 10) * 100) / 100;
    const low = Math.round((minOC - rand() * 10) * 100) / 100;
    const volume = 1000 + Math.floor(rand() * 500);
    const takerBuyVolume = Math.round((0.3 + 0.4 * rand()) * volume);
    prevClose = close;
    candles.push({
      timestamp: baseTime + i * HOUR_MS,
      open,
      high,
      low,
      close,
      volume,
      takerBuyVolume,
    });
  }
  return candles;
}

function buildBothDivergencesSeries(): OHLCV[] {
  const bars: OHLCV[] = [];
  const baseTime = 1_700_000_000_000;

  for (let i = 0; i <= 70; i++) {
    const timestamp = baseTime + i * HOUR_MS;
    let high = 100;
    let low = 80;
    const open = 90;
    const close = 90;
    let volume = 100;
    let takerBuyVolume = 50;

    if (i === 25) {
      high = 150;
    } else if (i === 26) {
      low = 50;
      volume = 1000;
      takerBuyVolume = 0;
    } else if (i === 50) {
      high = 180;
      low = 30;
      volume = 100;
      takerBuyVolume = 60;
    } else if (i > 26 && i < 50) {
      volume = 100;
      takerBuyVolume = 60;
    }

    bars.push(
      makeCandle({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        takerBuyVolume,
      })
    );
  }

  return bars;
}

describe('lab-v4 rules', () => {
  it('exports expected constants', () => {
    expect(LAB_V4_WINDOW_BARS).toBe(720);
    expect(LAB_V4_HOLD_BARS).toBe(8);
    expect(HOUR_MS).toBe(3_600_000);
  });

  describe('S1 fixture', () => {
    it('gives 1 on bull CHoCH with positive delta, 0 with negative delta, and 0 when last bar is cut', () => {
      const bullWithPositiveDelta = buildBullChochSeries(700);
      expect(barDelta(bullWithPositiveDelta[bullWithPositiveDelta.length - 1])).toBe(400);
      expect(s1SideAtLast(bullWithPositiveDelta)).toBe(1);

      const bullWithNegativeDelta = buildBullChochSeries(300);
      expect(barDelta(bullWithNegativeDelta[bullWithNegativeDelta.length - 1])).toBe(-400);
      expect(s1SideAtLast(bullWithNegativeDelta)).toBe(0);

      const cutSeries = bullWithPositiveDelta.slice(0, -1);
      expect(s1SideAtLast(cutSeries)).toBe(0);
    });
  });

  describe('S2 fixture', () => {
    it('gives -1 on regular bear divergence confirmed at last bar, and 0 when nothing confirms', () => {
      const bearDivSeries = buildBearDivergenceSeries();
      expect(s2SideAtLast(bearDivSeries)).toBe(-1);

      const cutSeries = bearDivSeries.slice(0, -1);
      expect(s2SideAtLast(cutSeries)).toBe(0);

      const emptySeries: OHLCV[] = [];
      expect(s2SideAtLast(emptySeries)).toBe(0);
    });

    it('returns -1 when both a regular bear and regular bull divergence confirm at the last bar', () => {
      const bothSeries = buildBothDivergencesSeries();
      expect(s2SideAtLast(bothSeries)).toBe(-1);
    });
  });

  describe('agreement with preview code', () => {
    it('matches c1Signals and c2Signals on a 900-bar seeded walk (window start mismatches <= 2)', () => {
      const seed = 1;
      const bars = generateRandomWalkWithTaker(900, seed);
      const c1Full = c1Signals(bars);
      const c2Full = c2Signals(bars);

      const c1ByBar = new Map<number, number>();
      for (const sig of c1Full) {
        c1ByBar.set(sig.index, sig.side);
      }

      const c2ByBar = new Map<number, number>();
      for (const sig of c2Full) {
        if (!c2ByBar.has(sig.index)) {
          c2ByBar.set(sig.index, sig.side);
        }
      }

      let s1Mismatches = 0;
      let s2Mismatches = 0;
      let s1SignalsCount = 0;
      let s2SignalsCount = 0;

      for (let t = 719; t <= 899; t++) {
        const window = bars.slice(t - 719, t + 1);
        const expectedS1 = c1ByBar.get(t) ?? 0;
        const actualS1 = s1SideAtLast(window);
        if (expectedS1 !== 0) s1SignalsCount++;
        if (actualS1 !== expectedS1) {
          s1Mismatches++;
        }

        const expectedS2 = c2ByBar.get(t) ?? 0;
        const actualS2 = s2SideAtLast(window);
        if (expectedS2 !== 0) s2SignalsCount++;
        if (actualS2 !== expectedS2) {
          s2Mismatches++;
        }
      }

      console.log(
        `Preview agreement (seed=${seed}): S1 signals=${s1SignalsCount}, S2 signals=${s2SignalsCount}, mismatches: S1=${s1Mismatches}, S2=${s2Mismatches}`
      );

      expect(s1Mismatches).toBeLessThanOrEqual(2);
      expect(s2Mismatches).toBeLessThanOrEqual(2);
    });
  });

  describe('isContiguousHourly', () => {
    it('returns true for contiguous hourly bars matching lastOpen', () => {
      const base = 1_700_000_000_000;
      const bars = [
        makeCandle({ timestamp: base, open: 1, high: 2, low: 0, close: 1, volume: 10 }),
        makeCandle({ timestamp: base + HOUR_MS, open: 1, high: 2, low: 0, close: 1, volume: 10 }),
        makeCandle({ timestamp: base + 2 * HOUR_MS, open: 1, high: 2, low: 0, close: 1, volume: 10 }),
      ];

      expect(isContiguousHourly(bars, base + 2 * HOUR_MS)).toBe(true);
    });

    it('returns false for a 2h gap', () => {
      const base = 1_700_000_000_000;
      const barsWithGap = [
        makeCandle({ timestamp: base, open: 1, high: 2, low: 0, close: 1, volume: 10 }),
        makeCandle({ timestamp: base + 2 * HOUR_MS, open: 1, high: 2, low: 0, close: 1, volume: 10 }),
      ];

      expect(isContiguousHourly(barsWithGap, base + 2 * HOUR_MS)).toBe(false);
    });

    it('returns false for wrong last open', () => {
      const base = 1_700_000_000_000;
      const bars = [
        makeCandle({ timestamp: base, open: 1, high: 2, low: 0, close: 1, volume: 10 }),
        makeCandle({ timestamp: base + HOUR_MS, open: 1, high: 2, low: 0, close: 1, volume: 10 }),
      ];

      expect(isContiguousHourly(bars, base + 2 * HOUR_MS)).toBe(false);
    });

    it('returns false for empty series', () => {
      expect(isContiguousHourly([], 1_700_000_000_000)).toBe(false);
    });
  });
});
