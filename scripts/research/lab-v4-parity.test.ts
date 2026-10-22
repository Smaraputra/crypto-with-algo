import { describe, expect, it } from 'vitest';
import { s1SideAtLast, type Side } from '../../src/lib/signals/lab/v4/rules';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';
import type { OHLCV } from '../../src/types/market';
import { tradesFor, type Signal } from './lab-v4-preview';
import {
  buildLiveTrades,
  compareSignals,
  compareTrades,
  HOUR_MS,
  LAB_V4_WINDOW_BARS,
  runRestCheck,
} from './lab-v4-parity';

function makeRandomWalkBars(count = 1000, seed = 42): OHLCV[] {
  const rng = createSeededRandom(seed);
  const bars: OHLCV[] = [];
  let price = 100;
  const baseTime = 1_700_000_000_000;

  for (let i = 0; i < count; i++) {
    const ret = (rng() - 0.498) * 0.02;
    const open = price;
    price = Math.max(10, open * (1 + ret));
    const high = Math.max(open, price) * (1 + rng() * 0.005);
    const low = Math.min(open, price) * (1 - rng() * 0.005);
    const close = price;
    const volume = 1000 + rng() * 500;
    const takerBuyVolume = volume * (0.3 + 0.4 * rng());

    bars.push({
      timestamp: baseTime + i * HOUR_MS,
      open,
      high,
      low,
      close,
      volume,
      takerBuyVolume,
    });
  }
  return bars;
}

function makeContiguousBars(count = 40): OHLCV[] {
  const bars: OHLCV[] = [];
  const baseTime = 1_700_000_000_000;
  for (let i = 0; i < count; i++) {
    bars.push({
      timestamp: baseTime + i * HOUR_MS,
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 101 + i,
      volume: 1000,
      takerBuyVolume: 500,
    });
  }
  return bars;
}

describe('lab-v4-parity', () => {
  describe('compareSignals', () => {
    it('gives full agreement on a 1,000-bar seeded random walk or at most 2 window-start mismatches', () => {
      const bars = makeRandomWalkBars(1000, 42);
      const res = compareSignals(bars);

      const s1Mismatches = res.S1.liveOnly + res.S1.previewOnly + res.S1.opposite;
      const s2Mismatches = res.S2.liveOnly + res.S2.previewOnly + res.S2.opposite;

      expect(s1Mismatches).toBeLessThanOrEqual(2);
      expect(s2Mismatches).toBeLessThanOrEqual(2);

      expect(res.S1.agree + s1Mismatches).toBe(res.S1.bars);
      expect(res.S2.agree + s2Mismatches).toBe(res.S2.bars);
      expect(res.S1.bars).toBe(1000 - LAB_V4_WINDOW_BARS + 1);
      expect(res.S2.bars).toBe(1000 - LAB_V4_WINDOW_BARS + 1);
    });

    it('flags a mismatch when the live function is fed a perturbed bar', () => {
      const bars = makeRandomWalkBars(1000, 42);

      // Wrapper feeding a perturbed bar (or flipping live rule output)
      const perturbedS1 = (closed: readonly OHLCV[]): Side => {
        const last = closed[closed.length - 1];
        const perturbedLast: OHLCV = {
          ...last,
          close: last.close * 2,
          takerBuyVolume: (last.volume ?? 1000) * 0.99,
        };
        const liveSide = s1SideAtLast([...closed.slice(0, -1), perturbedLast]);
        // If liveSide is still 0, perturb the decision so a mismatch is guaranteed
        return (liveSide !== 0 ? liveSide : 1) as Side;
      };

      const res = compareSignals(bars, LAB_V4_WINDOW_BARS, { s1Fn: perturbedS1 });

      const s1Mismatches = res.S1.liveOnly + res.S1.previewOnly + res.S1.opposite;
      expect(s1Mismatches).toBeGreaterThan(0);
      expect(res.S1.examples.length).toBeGreaterThan(0);
      expect(res.S1.examples[0]).toHaveProperty('t');
      expect(res.S1.examples[0]).toHaveProperty('timestamp');
      expect(res.S1.examples[0]).toHaveProperty('live');
      expect(res.S1.examples[0]).toHaveProperty('preview');
    });
  });

  describe('compareTrades', () => {
    it('matches tradesFor on hand-built signal series with 8-bar overlap rule (8 taken, 7 ignored)', () => {
      const bars = makeContiguousBars(40);
      const settlements = [{ t: bars[0].timestamp + 10 * HOUR_MS, rate: 0.001 }];

      // Hand-built signal series:
      // Signal at 0: enters bar 1, exits bar 9 (taken)
      // Signal at 7: 7 bars after previous taken signal 0 (7 - 0 = 7 < 8 -> ignored)
      // Signal at 8: 8 bars after previous taken signal 0 (8 - 0 = 8 >= 8 -> taken, enters bar 9, exits bar 17)
      // Signal at 15: 7 bars after previous taken signal 8 (15 - 8 = 7 < 8 -> ignored)
      // Signal at 16: 8 bars after previous taken signal 8 (16 - 8 = 8 >= 8 -> taken, enters bar 17, exits bar 25)
      const signals: Signal[] = [
        { index: 0, side: 1 },
        { index: 7, side: 1 },
        { index: 8, side: -1 },
        { index: 15, side: 1 },
        { index: 16, side: 1 },
      ];

      const liveTrades = buildLiveTrades(bars, settlements, signals);
      const previewTrades = tradesFor(bars, settlements, signals);

      expect(liveTrades).toHaveLength(3);
      expect(previewTrades).toHaveLength(3);
      expect(liveTrades).toEqual(previewTrades);

      expect(liveTrades[0].entryTime).toBe(bars[1].timestamp);
      expect(liveTrades[0].exitTime).toBe(bars[9].timestamp);
      expect(liveTrades[0].side).toBe(1);

      expect(liveTrades[1].entryTime).toBe(bars[9].timestamp);
      expect(liveTrades[1].exitTime).toBe(bars[17].timestamp);
      expect(liveTrades[1].side).toBe(-1);

      expect(liveTrades[2].entryTime).toBe(bars[17].timestamp);
      expect(liveTrades[2].exitTime).toBe(bars[25].timestamp);
      expect(liveTrades[2].side).toBe(1);

      const res = compareTrades(bars, settlements, {
        signalsS1: signals,
        signalsS2: signals,
      });

      expect(res.S1.previewTrades).toBe(3);
      expect(res.S1.liveTrades).toBe(3);
      expect(res.S1.matched).toBe(3);
      expect(res.S1.onlyPreview).toBe(0);
      expect(res.S1.onlyLive).toBe(0);

      expect(res.S2.previewTrades).toBe(3);
      expect(res.S2.liveTrades).toBe(3);
      expect(res.S2.matched).toBe(3);
      expect(res.S2.onlyPreview).toBe(0);
      expect(res.S2.onlyLive).toBe(0);
    });
  });

  describe('runRestCheck', () => {
    const bars: OHLCV[] = [
      {
        timestamp: Date.parse('2026-06-01T00:00:00.000Z'),
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1000,
        takerBuyVolume: 500,
      },
      {
        timestamp: Date.parse('2026-06-01T01:00:00.000Z'),
        open: 102,
        high: 107,
        low: 97,
        close: 104,
        volume: 1100,
        takerBuyVolume: 550,
      },
    ];

    it('gives zero mismatches when REST bars equal archive bars', async () => {
      const mockFetch = async (): Promise<OHLCV[]> => bars.map((b) => ({ ...b }));

      const res = await runRestCheck(
        { fetchPerpKlinesOhlcv: mockFetch, sleep: async () => {} },
        {
          archiveBarsBySymbol: { BTCUSDT: bars },
          symbols: ['BTCUSDT'],
          from: '2026-06-01',
          to: '2026-06-02',
        }
      );

      expect(res.BTCUSDT).toEqual({
        archiveBars: 2,
        restBars: 2,
        timeMismatches: 0,
        fieldMismatches: 0,
      });
    });

    it('counts a changed takerBuyVolume as a field mismatch', async () => {
      const mockFetch = async (): Promise<OHLCV[]> => [
        { ...bars[0], takerBuyVolume: 600 },
        { ...bars[1] },
      ];

      const res = await runRestCheck(
        { fetchPerpKlinesOhlcv: mockFetch, sleep: async () => {} },
        {
          archiveBarsBySymbol: { BTCUSDT: bars },
          symbols: ['BTCUSDT'],
          from: '2026-06-01',
          to: '2026-06-02',
        }
      );

      expect(res.BTCUSDT.timeMismatches).toBe(0);
      expect(res.BTCUSDT.fieldMismatches).toBe(1);
      expect(res.BTCUSDT.archiveBars).toBe(2);
      expect(res.BTCUSDT.restBars).toBe(2);
    });

    it('throws on HTTP 418 without another fetch', async () => {
      let callCount = 0;
      const mockFetch = async (): Promise<OHLCV[]> => {
        callCount++;
        throw new Error('Binance futures /fapi/v1/klines failed: HTTP 418');
      };

      await expect(
        runRestCheck(
          { fetchPerpKlinesOhlcv: mockFetch, sleep: async () => {} },
          {
            archiveBarsBySymbol: { BTCUSDT: bars, ETHUSDT: bars },
            symbols: ['BTCUSDT', 'ETHUSDT'],
            from: '2026-06-01',
            to: '2026-06-02',
          }
        )
      ).rejects.toThrow('HTTP 418');

      expect(callCount).toBe(1);
    });
  });
});
