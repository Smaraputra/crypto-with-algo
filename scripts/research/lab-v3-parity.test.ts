import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  compareBooks,
  compareCosts,
  parseArgs,
  runRestCheck,
  type CompareBooksInput,
} from './lab-v3-parity';
import { LAB_V3_UNIVERSE } from '../../src/lib/signals/lab/candidates';
import type { FundingRow, PerpCandleRow } from './dataset-format';

describe('lab-v3-parity argument parsing', () => {
  it('parses required and optional flags', () => {
    const args = parseArgs([
      '--dataset-dir',
      '/path/to/dataset',
      '--out',
      '/path/to/out.json',
      '--start-day',
      '2022-01-01',
      '--end-day',
      '2022-06-30',
      '--skip-rest',
      '--rest-from',
      '2022-01-01',
      '--rest-to',
      '2022-01-15',
    ]);
    expect(args).toEqual({
      datasetDir: '/path/to/dataset',
      out: '/path/to/out.json',
      startDay: '2022-01-01',
      endDay: '2022-06-30',
      skipRest: true,
      restFrom: '2022-01-01',
      restTo: '2022-01-15',
    });
  });

  it('uses default values when optional flags are omitted', () => {
    const args = parseArgs(['--dataset-dir', '/dataset', '--out', '/out.json']);
    expect(args.startDay).toBe('2021-03-01');
    expect(args.endDay).toBe('2026-06-29');
    expect(args.skipRest).toBe(false);
    expect(args.restFrom).toBe('2026-06-01');
    expect(args.restTo).toBe('2026-06-29');
  });

  it('throws when required flags are missing', () => {
    expect(() => parseArgs(['--out', '/out.json'])).toThrow('--dataset-dir is required');
    expect(() => parseArgs(['--dataset-dir', '/dataset'])).toThrow('--out is required');
  });
});

describe('lab-v3-parity compareBooks', () => {
  function makeSyntheticData(coinsCount = 12, daysCount = 20): {
    symbols: string[];
    barsBySymbol: Record<string, PerpCandleRow[]>;
    fundingBySymbol: Record<string, FundingRow[]>;
    startDay: string;
    endDay: string;
    startMs: number;
    endMs: number;
  } {
    const symbols = Array.from({ length: coinsCount }, (_, i) => `SYM${String(i + 1).padStart(2, '0')}`);
    const startMs = Date.parse('2026-01-01T00:00:00Z');
    const endMs = startMs + (daysCount - 1) * DAY_MS;
    const startDay = new Date(startMs).toISOString().slice(0, 10);
    const endDay = new Date(endMs).toISOString().slice(0, 10);

    const barsBySymbol: Record<string, PerpCandleRow[]> = {};
    const fundingBySymbol: Record<string, FundingRow[]> = {};

    const fundingStartMs = startMs - 10 * DAY_MS;
    const fundingEndMs = endMs + DAY_MS;
    const interval8h = 8 * 3600 * 1000;

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const bars: PerpCandleRow[] = [];
      for (let t = startMs; t <= endMs; t += DAY_MS) {
        bars.push({
          t,
          o: 100 + i,
          h: 105 + i,
          l: 95 + i,
          c: 102 + i,
          v: 1000,
          qv: 100000,
          n: 100,
          tbv: 500,
        });
      }
      barsBySymbol[sym] = bars;

      const settlements: FundingRow[] = [];
      for (let t = fundingStartMs; t <= fundingEndMs; t += interval8h) {
        settlements.push({
          t,
          rate: (i + 1) * 0.0001,
          intervalHours: 8,
        });
      }
      fundingBySymbol[sym] = settlements;
    }

    return {
      symbols,
      barsBySymbol,
      fundingBySymbol,
      startDay,
      endDay,
      startMs,
      endMs,
    };
  }

  it('1. reports full agreement on a 12-coin, 20-day synthetic set with funding every 8h', () => {
    const { symbols, barsBySymbol, fundingBySymbol, startDay, endDay } = makeSyntheticData(12, 20);

    const input: CompareBooksInput = {
      barsBySymbol,
      fundingBySymbol,
      startDay,
      endDay,
      universe: symbols,
    };

    const res = compareBooks(input);

    expect(res.days).toBe(20);
    expect(res.matching).toBe(20);
    expect(res.mismatches).toHaveLength(0);
    expect(res.liveBooks).toHaveLength(20);
    expect(res.previewBooks).toHaveLength(20);

    // Verify books are non-empty
    for (const book of res.liveBooks) {
      expect(book.size).toBeGreaterThan(0);
    }
  });

  it('2. flags a mismatch when one side is given a perturbed settlement (inject through the input)', () => {
    const { symbols, barsBySymbol, fundingBySymbol, startDay, endDay, startMs } = makeSyntheticData(12, 20);

    // Perturb funding on the live side for the first symbol
    const targetSym = symbols[0];
    const perturbedFunding: Record<string, FundingRow[]> = {};
    for (const sym of symbols) {
      if (sym === targetSym) {
        perturbedFunding[sym] = fundingBySymbol[sym].map((f) => {
          // Perturb a settlement near day 5
          if (f.t > startMs + 3 * DAY_MS && f.t < startMs + 6 * DAY_MS) {
            return { ...f, rate: f.rate + 0.05 };
          }
          return { ...f };
        });
      } else {
        perturbedFunding[sym] = fundingBySymbol[sym];
      }
    }

    const input: CompareBooksInput = {
      barsBySymbol,
      fundingBySymbol,
      liveFundingBySymbol: perturbedFunding,
      startDay,
      endDay,
      universe: symbols,
    };

    const res = compareBooks(input);

    expect(res.days).toBe(20);
    expect(res.matching).toBeLessThan(20);
    expect(res.mismatches.length).toBeGreaterThan(0);
    expect(res.mismatches[0].preview).not.toBe(res.mismatches[0].live);
  });

  it('3. a day with only 9 tradeable coins gives empty target books on both sides (live minimum is 10)', () => {
    const { symbols, barsBySymbol, fundingBySymbol } = makeSyntheticData(12, 1);
    const day = '2026-01-01';

    // Make only 9 coins tradeable (set open to 0 for the other 3)
    const modifiedBars: Record<string, PerpCandleRow[]> = {};
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      modifiedBars[sym] = barsBySymbol[sym].map((b) => ({
        ...b,
        o: i < 9 ? b.o : 0,
      }));
    }

    const input: CompareBooksInput = {
      barsBySymbol: modifiedBars,
      fundingBySymbol,
      startDay: day,
      endDay: day,
      universe: symbols,
    };

    const res = compareBooks(input);

    expect(res.days).toBe(1);
    expect(res.matching).toBe(1);
    expect(res.mismatches).toHaveLength(0);
    expect(res.liveBooks[0].size).toBe(0);
    expect(res.previewBooks[0].size).toBe(0);
  });
});

describe('lab-v3-parity compareCosts', () => {
  it('4. matches on a hand-built pair that uses ranks 1, 11 and 30', () => {
    const sym1 = LAB_V3_UNIVERSE[0]; // rank 1 (BTCUSDT)
    const sym11 = LAB_V3_UNIVERSE[10]; // rank 11 (UNIUSDT)
    const sym30 = LAB_V3_UNIVERSE[29]; // rank 30 (PENGUUSDT)

    const prev = new Map<string, number>([
      [sym1, 0.25],
      [sym11, -0.2],
      [sym30, 0.15],
    ]);

    const next = new Map<string, number>([
      [sym1, 0.1],
      [sym11, -0.1],
      [sym30, -0.05],
    ]);

    const res = compareCosts([prev, next]);

    expect(res.pairs).toBe(1);
    expect(res.matching).toBe(1);
    expect(res.mismatches).toHaveLength(0);
  });
});

describe('lab-v3-parity runRestCheck', () => {
  it('5. counts an offset print (raw time T + 3 ms) as offsetPrints: 1 with no time mismatch, flags a rate mismatch, and throws on an HTTP 418 error without calling the fetch again', async () => {
    const T = Date.parse('2026-06-15T08:00:00Z');
    const symbol = 'BTCUSDT';

    const archiveFundingBySymbol: Record<string, FundingRow[]> = {
      [symbol]: [{ t: T, rate: 0.0001, intervalHours: 8 }],
    };

    let fetchCalls = 0;
    const mockFetch = async (): Promise<Array<{ symbol: string; fundingRate: number; fundingTime: number; markPrice: number }>> => {
      fetchCalls++;
      return [
        {
          symbol,
          fundingTime: T + 3,
          fundingRate: 0.00025,
          markPrice: 65000,
        },
      ];
    };

    const deps = {
      fetchFundingHistory: mockFetch,
      sleep: async (): Promise<void> => {},
    };

    const res = await runRestCheck(deps, {
      from: T,
      to: T,
      archiveFundingBySymbol,
      symbols: [symbol],
    });

    expect(fetchCalls).toBe(1);
    expect(res[symbol]).toEqual({
      archiveRows: 1,
      restRows: 1,
      timeMismatches: 0,
      rateMismatches: 1,
      offsetPrints: 1,
    });

    // Sub-test: throws on HTTP 418 without calling fetch again
    let abortCalls = 0;
    const abortFetch = async (): Promise<never> => {
      abortCalls++;
      throw new Error('BinanceFuturesAPI HTTP 418: I am a teapot');
    };

    await expect(
      runRestCheck(
        {
          fetchFundingHistory: abortFetch,
          sleep: async (): Promise<void> => {},
        },
        {
          from: T,
          to: T,
          archiveFundingBySymbol,
          symbols: ['BTCUSDT', 'ETHUSDT'],
        }
      )
    ).rejects.toThrow('HTTP 418');

    expect(abortCalls).toBe(1);
  });
});
