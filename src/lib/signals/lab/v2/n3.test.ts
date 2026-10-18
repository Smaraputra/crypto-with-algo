import { describe, expect, it } from 'vitest';
import {
  Bar15,
  DAY_MS,
  N3,
  dailyValueAreas,
  n3BarsNeeded,
  n3Position,
  valueAreaOfDay,
} from './n3';
import {
  coinDailySeries,
  computeDailyValueAreas,
} from '../../../../../scripts/research/nv1-c3';
import { buildTrades } from '../../../../../scripts/research/nv1-core';
import type { CandleRow } from '../../../../../scripts/research/dataset-format';
import { createSeededRandom } from '@/lib/stats/seeded-random';

interface SyntheticCandle extends Bar15 {
  tbv: number | null;
}

function generateSyntheticBars(
  seed: number,
  startT: number,
  numDays: number,
  basePrice: number
): { bars15m: SyntheticCandle[]; candles1d: CandleRow[] } {
  const rng = createSeededRandom(seed);
  const bars15m: SyntheticCandle[] = [];
  const candles1d: CandleRow[] = [];
  const BARS_PER_DAY = 96;
  const BAR_MS = 15 * 60 * 1000;

  let currentPrice = basePrice;

  for (let day = 0; day < numDays; day++) {
    const dayStartT = startT + day * DAY_MS;
    let dayOpenPrice: number | null = null;
    // Base 3% deletion, slightly higher on occasional days so some days drop below 90 bars
    const dropRate = day % 15 === 5 ? 0.12 : 0.025;

    for (let b = 0; b < BARS_PER_DAY; b++) {
      const barT = dayStartT + b * BAR_MS;

      // Delete about 3% of bars at random so some days fall below 90 bars
      if (rng() < dropRate) {
        continue;
      }

      const priceChange = (rng() - 0.49) * 2;
      const open = currentPrice;
      const close = Math.max(1, open + priceChange);
      currentPrice = close;

      let high: number;
      let low: number;

      // Add some bars with high equal to low (about 3% chance)
      if (rng() < 0.03) {
        high = open;
        low = open;
      } else {
        high = Math.max(open, close) + rng() * 1.5;
        low = Math.min(open, close) - rng() * 1.5;
        if (low < 0.01) low = 0.01;
      }

      const volume = 10 + rng() * 100;

      if (dayOpenPrice === null) {
        dayOpenPrice = open;
      }

      bars15m.push({
        t: barT,
        o: open,
        h: high,
        l: low,
        c: close,
        v: volume,
        tbv: null,
      });
    }

    const open1d = dayOpenPrice ?? currentPrice;
    candles1d.push({
      t: dayStartT,
      o: open1d,
      h: open1d,
      l: open1d,
      c: currentPrice,
      v: 1000,
      tbv: null,
    });
  }

  // Provide day numDays open so buildTrades can close a trade opened on day numDays - 1
  candles1d.push({
    t: startT + numDays * DAY_MS,
    o: currentPrice,
    h: currentPrice,
    l: currentPrice,
    c: currentPrice,
    v: 1000,
    tbv: null,
  });

  return { bars15m, candles1d };
}

describe('lab-v2 N3 live scorer', () => {
  describe('edge cases', () => {
    it('a day with 89 bars gives null', () => {
      const startT = Date.UTC(2024, 0, 1);
      const bars89: Bar15[] = [];
      for (let i = 0; i < 89; i++) {
        bars89.push({
          t: startT + i * 15 * 60 * 1000,
          o: 100 + i * 0.1,
          h: 101 + i * 0.1,
          l: 99 + i * 0.1,
          c: 100.5 + i * 0.1,
          v: 50,
        });
      }
      expect(valueAreaOfDay(bars89)).toBeNull();
    });

    it('a flat day (every bar the same price) gives null', () => {
      const startT = Date.UTC(2024, 0, 1);
      const flatBars: Bar15[] = [];
      for (let i = 0; i < 96; i++) {
        flatBars.push({
          t: startT + i * 15 * 60 * 1000,
          o: 100,
          h: 100,
          l: 100,
          c: 100,
          v: 50,
        });
      }
      expect(valueAreaOfDay(flatBars)).toBeNull();
    });

    it('n3BarsNeeded ends 1 ms before dayT', () => {
      const dayT = Date.UTC(2024, 5, 15);
      const window = n3BarsNeeded(dayT);
      expect(window.endTime).toBe(dayT - 1);
      expect(window.startTime).toBe(dayT - 3 * DAY_MS);
    });
  });

  describe('parity with Round 1 research screen', () => {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'] as const;
    const startT = Date.UTC(2023, 0, 1);
    const numDays = 60;

    symbols.forEach((symbol, symIdx) => {
      it(`matches computeDailyValueAreas and buildTrades exactly for ${symbol}`, () => {
        const { bars15m, candles1d } = generateSyntheticBars(
          12345 + symIdx * 997,
          startT,
          numDays,
          100 + symIdx * 50
        );

        // Verify synthetic bars include bars with high == low and days with < 90 bars
        const hasFlatBar = bars15m.some((b) => b.h === b.l);
        expect(hasFlatBar).toBe(true);

        const vasLab = dailyValueAreas(bars15m);
        const vasScreen = computeDailyValueAreas(bars15m);

        // Verify some days fell below 90 bars and therefore produced null
        let nullDayCount = 0;
        for (const va of vasLab.values()) {
          if (va === null) nullDayCount++;
        }
        expect(nullDayCount).toBeGreaterThan(0);

        // 1. Exact equality of daily value areas
        expect(vasLab.size).toBe(vasScreen.size);
        for (const [dayT, vaLab] of vasLab) {
          const vaScreen = vasScreen.get(dayT);
          if (vaLab === null) {
            expect(vaScreen).toBeNull();
          } else {
            expect(vaScreen).not.toBeNull();
            expect(vaLab.poc).toBe(vaScreen!.poc);
            expect(vaLab.vah).toBe(vaScreen!.vah);
            expect(vaLab.val).toBe(vaScreen!.val);
            expect(vaLab.m).toBe(vaScreen!.m);
            expect(vaLab.width).toBe(vaScreen!.width);
          }
        }

        // 2. Parity with coinDailySeries and buildTrades
        const series = coinDailySeries(symbol, vasScreen, candles1d, N3.threshold);

        const trades = buildTrades(series, {
          k: N3.k,
          hold: 1,
          stepMs: DAY_MS,
          costPct: 0.14,
          from: startT,
          to: Number.POSITIVE_INFINITY,
        });

        // The comparison below is only meaningful if the synthetic data produces trades on both sides.
        expect(trades.length).toBeGreaterThan(0);

        const tradeByOpenT = new Map<number, 1 | -1>();
        for (const tr of trades) {
          tradeByOpenT.set(tr.openT, tr.d);
        }

        // For every day D, n3Position must equal the trade side opened at D (0 if none)
        for (let d = 0; d < numDays; d++) {
          const dayT = startT + d * DAY_MS;
          const pos = n3Position(vasLab, dayT);
          const expected = tradeByOpenT.get(dayT) ?? 0;
          expect(pos, `Mismatch at day index ${d}`).toBe(expected);
        }
      });
    });
  });
});
