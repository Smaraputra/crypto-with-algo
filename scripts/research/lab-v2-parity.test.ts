import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  compareCandleSets,
  compareN2Weeks,
  compareN3ForCoin,
  getDaysInRange,
  parseArgs,
} from './lab-v2-parity';
import type { CoinSeries, Trade } from './nv1-core';
import type { Bar1d } from '../../src/lib/signals/lab/v2/n2';
import type { ValueArea as LiveValueArea } from '../../src/lib/signals/lab/v2/n3';
import type { PreparedDataset, WalkForwardWeekResult } from './nv1-c2';

describe('lab-v2-parity argument parsing', () => {
  it('parses parity command with dataset-dir and out', () => {
    const args = parseArgs(['parity', '--dataset-dir', '/path/to/dataset', '--out', '/path/to/out.json']);
    expect(args).toEqual({
      command: 'parity',
      datasetDir: '/path/to/dataset',
      out: '/path/to/out.json',
    });
  });

  it('parses rest-check command with custom days and out', () => {
    const args = parseArgs(['rest-check', '--days', '30', '--out', '/path/to/out.json']);
    expect(args).toEqual({
      command: 'rest-check',
      days: 30,
      out: '/path/to/out.json',
    });
  });

  it('parses rest-check command with default 60 days', () => {
    const args = parseArgs(['rest-check', '--out', '/path/to/out.json']);
    expect(args).toEqual({
      command: 'rest-check',
      days: 60,
      out: '/path/to/out.json',
    });
  });

  it('throws when no command is provided', () => {
    expect(() => parseArgs([])).toThrow('No command specified');
  });

  it('throws on unknown command', () => {
    expect(() => parseArgs(['unknown-cmd'])).toThrow('Unknown command "unknown-cmd"');
  });

  it('throws on missing --dataset-dir for parity', () => {
    expect(() => parseArgs(['parity', '--out', '/path/to/out.json'])).toThrow('--dataset-dir is required');
  });

  it('throws on missing --out for parity', () => {
    expect(() => parseArgs(['parity', '--dataset-dir', '/path/to/dataset'])).toThrow('--out is required');
  });

  it('throws on missing --out for rest-check', () => {
    expect(() => parseArgs(['rest-check', '--days', '60'])).toThrow('--out is required');
  });

  it('throws on invalid --days for rest-check', () => {
    expect(() => parseArgs(['rest-check', '--days', '0', '--out', '/out.json'])).toThrow('--days must be a positive integer');
    expect(() => parseArgs(['rest-check', '--days', '-5', '--out', '/out.json'])).toThrow('--days must be a positive integer');
    expect(() => parseArgs(['rest-check', '--days', 'abc', '--out', '/out.json'])).toThrow('--days must be a positive integer');
  });

  it('throws when flag value is missing', () => {
    expect(() => parseArgs(['parity', '--dataset-dir'])).toThrow('--dataset-dir requires a value');
    expect(() => parseArgs(['parity', '--dataset-dir', '--out'])).toThrow('--dataset-dir requires a value');
  });
});

describe('lab-v2-parity N3 mismatch counting on tiny hand-made case', () => {
  it('counts one agreement, one live-only and one opposite day', () => {
    const symbol = 'BTCUSDT';
    const t0 = Date.UTC(2022, 0, 10); // Monday
    const t1 = t0 + DAY_MS;            // Tuesday (Day 1)
    const t2 = t1 + DAY_MS;            // Wednesday (Day 2)
    const t3 = t2 + DAY_MS;            // Thursday (Day 3)
    const days = [t1, t2, t3];

    // Day 1: live = 1, screen = 1 (agreement)
    // Day 2: live = 1, screen = 0 (live-only)
    // Day 3: live = 1, screen = -1 (opposite)

    // Screen trades:
    // Trade on Day 1: openT = t1, direction = 1
    // No trade on Day 2: screen = 0
    // Trade on Day 3: openT = t3, direction = -1
    const trades: Trade[] = [
      {
        symbol,
        openT: t1,
        closeT: t1 + DAY_MS,
        d: 1,
        grossPct: 1.0,
        netPct: 0.86,
      },
      {
        symbol,
        openT: t3,
        closeT: t3 + DAY_MS,
        d: -1,
        grossPct: 0.5,
        netPct: 0.36,
      },
    ];

    // Coin series:
    // Day 0 (t0), Day 1 (t1), Day 2 (t2), Day 3 (t3)
    // Day 2 has side = 1 and Day 1 has side = 1, so k=1 is confirmed at t2.
    // But t2 + 1d (t3) is the last bar or we set segmentTo = t3 so closeT = t2 + DAY_MS = t3 >= segmentTo!
    // This exercises the contiguityOnly check!
    const coin: CoinSeries = {
      symbol,
      t: [t0, t1, t2, t3],
      close: [100, 101, 102, 103],
      side: [1, 1, 1, -1],
    };

    // Value areas designed so that n3Position returns:
    // n3Position(vas, t1) = 1
    // n3Position(vas, t2) = 1
    // n3Position(vas, t3) = 1
    // n3Position(vas, dayT) needs sideOfDay(vas, dayT) and sideOfDay(vas, dayT - 1d).
    // sideOfDay(vas, dayT) checks va(dayT - 1d).m - va(dayT - 2d).m > 0.25 * va(dayT - 2d).width.
    const vas = new Map<number, LiveValueArea | null>();
    // Need value areas for:
    // t1 - 3d, t1 - 2d, t1 - 1d, t2 - 1d (= t1), t3 - 1d (= t2)
    // Let's create an upward trend in m with small width (width = 10, threshold = 0.25 => cutoff = 2.5)
    // m values:
    const baseM = 100;
    for (let d = -4; d <= 4; d++) {
      const day = t1 + d * DAY_MS;
      vas.set(day, {
        poc: baseM + d * 10,
        vah: baseM + d * 10 + 5,
        val: baseM + d * 10 - 5,
        m: baseM + d * 10,
        width: 10,
      });
    }

    // Setting segmentTo = t3 means for Day 2 (t2), closeT = t2 + DAY_MS = t3 >= segmentTo,
    // so buildTrades could not open a trade because closeT was at segment boundary.
    const result = compareN3ForCoin(symbol, coin, trades, vas, days, t3);

    expect(result.days).toBe(3);
    expect(result.agree).toBe(1);
    expect(result.liveOnly).toBe(1);
    expect(result.opposite).toBe(1);
    expect(result.screenOnly).toBe(0);
    expect(result.contiguityOnly).toBe(1);
    expect(result.examples).toHaveLength(2);

    expect(result.examples[0]).toEqual({
      symbol: 'BTCUSDT',
      date: new Date(t2).toISOString().slice(0, 10),
      t: t2,
      live: 1,
      screen: 0,
      kind: 'liveOnly',
      contiguityOnly: true,
    });

    expect(result.examples[1]).toEqual({
      symbol: 'BTCUSDT',
      date: new Date(t3).toISOString().slice(0, 10),
      t: t3,
      live: 1,
      screen: -1,
      kind: 'opposite',
    });
  });
});

describe('lab-v2-parity helper functions', () => {
  it('computes days in range correctly', () => {
    const start = Date.UTC(2023, 0, 1);
    const end = Date.UTC(2023, 0, 4);
    const days = getDaysInRange(start, end);
    expect(days).toEqual([
      Date.UTC(2023, 0, 1),
      Date.UTC(2023, 0, 2),
      Date.UTC(2023, 0, 3),
    ]);
  });

  it('compares candle sets correctly with max difference calculation', () => {
    const t1 = 1600000000000;
    const t2 = t1 + DAY_MS;
    const t3 = t2 + DAY_MS;

    const restCandles = [
      { timestamp: t1, open: 100, high: 105, low: 95, close: 102, volume: 1000, takerBuyVolume: 500 },
      { timestamp: t2, open: 102, high: 108, low: 101, close: 107, volume: 1200, takerBuyVolume: 600 },
    ];

    const storedCandles = [
      // t1 matches with small diff
      { timestamp: t1, open: 100.01, high: 104.99, low: 95.02, close: 102.05, volume: 1000.5, takerBuyVolume: 499.8 },
      // t3 is stored only
      { timestamp: t3, open: 107, high: 110, low: 106, close: 109, volume: 800, takerBuyVolume: 400 },
    ];

    const comp = compareCandleSets('BTCUSDT', '1d', restCandles, storedCandles);

    expect(comp.symbol).toBe('BTCUSDT');
    expect(comp.interval).toBe('1d');
    expect(comp.restCount).toBe(2);
    expect(comp.storedCount).toBe(2);
    expect(comp.matchedCount).toBe(1);
    expect(comp.restOnlyCount).toBe(1); // t2 is rest only
    expect(comp.storedOnlyCount).toBe(1); // t3 is stored only

    expect(comp.maxDiff.open).toBeCloseTo(0.01, 6);
    expect(comp.maxDiff.high).toBeCloseTo(0.01, 6);
    expect(comp.maxDiff.low).toBeCloseTo(0.02, 6);
    expect(comp.maxDiff.close).toBeCloseTo(0.05, 6);
    expect(comp.maxDiff.volume).toBeCloseTo(0.5, 6);
    expect(comp.maxDiff.takerBuyVolume).toBeCloseTo(0.2, 6);
  });

  it('compares N2 weeks agreement and detects mismatches', () => {
    const M1 = Date.UTC(2023, 0, 9);
    const M2 = Date.UTC(2023, 0, 16);

    // Mock wf results
    const wfResults: WalkForwardWeekResult[] = [
      { M: M1, ic: 0.15, net: 0.02, eligible: 10, cash: false, incomplete: false, turnover: 0.5 },
      { M: M2, ic: 0.12, net: 0.015, eligible: 10, cash: false, incomplete: false, turnover: 0.4 },
    ];

    const mockFeatures = {
      beta: 1.0,
      res1w: 0,
      res4w: 0,
      vol4w: 0.02,
      tbs1w: 0.5,
      vtrend: 1.0,
    };

    // Mock prepared dataset
    const prepared: PreparedDataset = {
      weeks: [],
      byM: new Map([
        [M1, { M: M1, coinData: new Map([['BTCUSDT', { symbol: 'BTCUSDT', rawFeatures: mockFeatures, target: 0, rawForwardReturn: 0.03 }]]) }],
        [M2, { M: M2, coinData: new Map([['BTCUSDT', { symbol: 'BTCUSDT', rawFeatures: mockFeatures, target: 0, rawForwardReturn: 0.02 }]]) }],
      ]),
      symbols: ['BTCUSDT'],
      droppedCoinWeeks: { training: 0, B: 0, C: 0 },
    };

    // If candles are empty, n2BookAt returns cash: true with few_kept
    // So both weeks in live will be cash: true, whereas wf has cash: false
    // That means 2 mismatches are detected!
    const candlesMappedToBar1d: Record<string, Bar1d[]> = { BTCUSDT: [] };
    const res = compareN2Weeks(candlesMappedToBar1d, prepared, wfResults);

    expect(res.weeks).toBe(2);
    expect(res.agree).toBe(0);
    expect(res.mismatches).toBe(2);
    expect(res.examples).toHaveLength(2);
    expect(res.examples[0].diffs.some((d) => d.includes('cash mismatch'))).toBe(true);
  });
});
