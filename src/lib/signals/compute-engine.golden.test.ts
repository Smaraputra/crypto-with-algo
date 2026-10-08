// Golden test of the scheduler's scoring output.
//
// computeSignalBatch is the live scheduler's only scoring path and its
// documents are the live GlobalSignal record. This pins them, fed by fully
// deterministic fixtures covering every input category (candles for the
// scored and HTF intervals, stored futures snapshots, news, Fear and Greed,
// default and explicit template weights), so a refactor of the engine can be
// proven behaviour-neutral.
//
// If this fails, the question is whether the change was meant to move a live
// score. If not, it is a regression. The golden is regenerated only for an
// intended scoring change (with a configVersion bump), by running the test
// with UPDATE_GOLDEN=1; never regenerate it to make a refactor pass.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OHLCV } from '@/types/market';
import { DEFAULT_TEMPLATE_WEIGHTS, type TradingStyle } from '@/lib/models/signal-template';
import { getConfirmationInterval } from '@/lib/signals/htf';
import { LS_Z_WARMUP_MS, mapToSnapshotInterval } from '@/lib/backtest/snapshot-series';
import golden from '@/__fixtures__/compute-engine-golden.json';
import {
  buildCandles,
  buildSnapshotRows,
  FIXED_NOW,
  FIXTURE_FEAR_GREED,
  lastClosedOpenTime,
  NEWS_AGGREGATE_ROWS,
  seedFor,
  type FixtureSnapshotRow,
} from '@/__fixtures__/scoring-fixture';
import { SCORER_CONFIG_VERSION } from './config-version';

const mockGetCandles = vi.fn();
const mockFetchKlines = vi.fn();
const mockFetchFearAndGreed = vi.fn();
const mockConnectDB = vi.fn();
const mockInsertMany = vi.fn();
const mockSnapshotAggregate = vi.fn();
const mockSnapshotFind = vi.fn();
const mockCreate = vi.fn();
const mockFindOne = vi.fn();
const mockCreatePendingOutcomes = vi.hoisted(() => vi.fn());

vi.mock('@/lib/signals/outcome-resolver', () => ({
  createPendingOutcomes: (...args: unknown[]) => mockCreatePendingOutcomes(...args),
}));

vi.mock('@/lib/candle-ingestion', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/candle-ingestion')>('@/lib/candle-ingestion');
  return {
    dropOpenBars: actual.dropOpenBars,
    getCandles: (...args: unknown[]) => mockGetCandles(...args),
  };
});

vi.mock('@/lib/binance', () => ({
  fetchKlines: (...args: unknown[]) => mockFetchKlines(...args),
}));

vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: () => mockFetchFearAndGreed(),
}));

vi.mock('@/lib/redis', () => ({
  cachedFetch: (_key: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

vi.mock('@/lib/models/global-signal', () => ({
  GlobalSignal: {
    insertMany: (...args: unknown[]) => mockInsertMany(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    aggregate: () => Promise.resolve([]),
  },
}));

vi.mock('@/lib/models/signal-template', async () => {
  const actual = await vi.importActual('@/lib/models/signal-template');
  return {
    ...actual,
    SignalTemplate: {
      findOne: (query: unknown) => ({ lean: () => mockFindOne(query) }),
    },
  };
});

vi.mock('@/lib/models/historical-snapshot', () => ({
  HistoricalSnapshot: {
    aggregate: (...args: unknown[]) => mockSnapshotAggregate(...args),
    find: (...args: unknown[]) => ({ sort: () => ({ lean: () => mockSnapshotFind(...args) }) }),
  },
}));

const GOLDEN_PATH = resolve(__dirname, '../../__fixtures__/compute-engine-golden.json');

const TASKS: Array<{ symbol: string; interval: string; tradingStyle: TradingStyle }> = [
  { symbol: 'BTCUSDT', interval: '1h', tradingStyle: 'day_trading' },
  { symbol: 'ETHUSDT', interval: '4h', tradingStyle: 'swing_trading' },
  { symbol: 'BTCUSDT', interval: '5m', tradingStyle: 'scalping' },
  { symbol: 'BTCUSDT', interval: '1d', tradingStyle: 'position_trading' },
];

// Explicit active template for swing_trading; every other style gets null
// (findOne returns nothing) and so falls back to DEFAULT_TEMPLATE_WEIGHTS.
const SWING_TEMPLATE = {
  tradingStyle: 'swing_trading',
  active: true,
  weights: {
    trend: 0.2,
    momentum: 0.2,
    volume: 0.1,
    volatility: 0.1,
    futures: 0.15,
    sentiment: 0.1,
    htf: 0.15,
  },
};

const START_PRICE: Record<string, number> = { BTCUSDT: 60000, ETHUSDT: 2500 };

function candlesFor(symbol: string, interval: string, count: number): OHLCV[] {
  return buildCandles({
    symbol,
    interval,
    count,
    endOpenTime: lastClosedOpenTime(interval),
    seed: seedFor('candles', symbol, interval),
    startPrice: START_PRICE[symbol],
  });
}

function snapshotRowsFor(symbol: string, snapshotInterval: string): FixtureSnapshotRow[] {
  return buildSnapshotRows({
    symbol,
    snapshotInterval,
    from: FIXED_NOW - LS_Z_WARMUP_MS - 5 * 24 * 3_600_000,
    to: FIXED_NOW,
    seed: seedFor('snapshots', symbol, snapshotInterval),
  });
}

function stripVolatile(docs: Array<Record<string, unknown>>): unknown {
  const stripped = docs.map((doc) => {
    const rest = { ...doc };
    delete rest.createdAt;
    delete rest.expiresAt;
    return rest;
  });
  // Round-trip through JSON so the comparison is against exactly what the
  // golden file can hold (full float precision, no rounding).
  return JSON.parse(JSON.stringify(stripped));
}

async function runEngine(): Promise<Array<Record<string, unknown>>> {
  const { computeSignalBatch } = await import('./compute-engine');
  const result = await computeSignalBatch(TASKS);
  expect(result.errors).toBe(0);
  expect(result.skipped).toBe(0);
  expect(result.computed).toBe(TASKS.length);
  expect(mockInsertMany).toHaveBeenCalledTimes(1);
  return mockInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>;
}

describe('compute-engine golden', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] });

    mockGetCandles.mockImplementation(
      async (symbol: string, interval: string, _from: unknown, _to: unknown, limit: number) =>
        candlesFor(symbol, interval, limit)
    );
    // The DB path always satisfies recommendedCandles, so the REST fallback is unused.
    mockFetchKlines.mockRejectedValue(new Error('fetchKlines must not be called'));
    mockFetchFearAndGreed.mockResolvedValue(FIXTURE_FEAR_GREED);
    mockSnapshotAggregate.mockResolvedValue(NEWS_AGGREGATE_ROWS);
    mockSnapshotFind.mockImplementation(
      async (filter: { symbol: string; interval: string; timestamp: { $gte: number; $lte: number } }) =>
        snapshotRowsFor(filter.symbol, filter.interval).filter(
          (r) => r.timestamp >= filter.timestamp.$gte && r.timestamp <= filter.timestamp.$lte
        )
    );
    mockFindOne.mockImplementation(async (query: { tradingStyle: string }) =>
      query.tradingStyle === 'swing_trading' ? SWING_TEMPLATE : null
    );
    mockInsertMany.mockResolvedValue([]);
    mockCreatePendingOutcomes.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches the committed golden output', async () => {
    const docs = stripVolatile(await runEngine());

    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN_PATH, JSON.stringify(docs, null, 2) + '\n');
      return;
    }

    expect(docs).toEqual(golden);
  });

  it('feeds every input category into the captured documents', async () => {
    const docs = (await runEngine()) as Array<{
      symbol: string;
      interval: string;
      tradingStyle: TradingStyle;
      score: number;
      configVersion: number;
      htfContext: { interval: string } | null;
      components: Array<{
        category: string;
        score: number;
        weight: number;
        signals: Array<{ name: string; description: string }>;
      }>;
    }>;

    expect(docs).toHaveLength(TASKS.length);
    for (const doc of docs) {
      expect(doc.configVersion).toBe(SCORER_CONFIG_VERSION);

      const htfInterval = getConfirmationInterval(doc.interval, doc.tradingStyle);
      if (htfInterval) {
        expect(doc.htfContext).not.toBeNull();
        expect(doc.htfContext?.interval).toBe(htfInterval);
      } else {
        expect(doc.htfContext).toBeNull();
      }

      const byCategory = new Map(doc.components.map((c) => [c.category, c]));
      // Futures is always fed. Sentiment is fed everywhere, but a style whose
      // weight for it is 0 (scalping) carries no weighted contribution.
      expect(byCategory.get('futures')?.signals.length).toBeGreaterThan(0);
      expect(byCategory.get('futures')?.score).not.toBe(0);
      // The 30-day L/S z is defined (enough 1h history), not the abstaining path.
      const ls = byCategory.get('futures')?.signals.find((sig) => sig.name === 'Long/Short Ratio');
      expect(ls?.description).toMatch(/z [+-]\d+\.\d{2} vs 30d/);
      expect(byCategory.get('sentiment')?.signals.length).toBeGreaterThan(0);
      expect(byCategory.get('sentiment')?.score).not.toBe(0);
    }

    // Candles for the scored and the HTF interval were both requested.
    const requested = new Set(
      mockGetCandles.mock.calls.map((c: unknown[]) => `${c[0]}:${c[1]}`)
    );
    for (const t of TASKS) {
      expect(requested.has(`${t.symbol}:${t.interval}`)).toBe(true);
      const htf = getConfirmationInterval(t.interval, t.tradingStyle);
      if (htf) expect(requested.has(`${t.symbol}:${htf}`)).toBe(true);
    }
    // Snapshots were read at each task's snapshot interval, and at 1h for the L/S z.
    const snapReads = new Set(
      mockSnapshotFind.mock.calls.map(
        (c: unknown[]) => `${(c[0] as { symbol: string; interval: string }).symbol}:${(c[0] as { interval: string }).interval}`
      )
    );
    for (const t of TASKS) {
      expect(snapReads.has(`${t.symbol}:${mapToSnapshotInterval(t.interval)}`)).toBe(true);
      expect(snapReads.has(`${t.symbol}:1h`)).toBe(true);
    }

    // The scores differ across the four tasks.
    expect(new Set(docs.map((d) => d.score)).size).toBe(TASKS.length);
  });

  it('uses the explicit template for swing_trading and defaults elsewhere', async () => {
    const docs = (await runEngine()) as Array<{
      tradingStyle: TradingStyle;
      components: Array<{ category: string; weight: number }>;
    }>;
    const swing = docs.find((d) => d.tradingStyle === 'swing_trading')!;
    const weightOf = (d: (typeof docs)[number], cat: string) =>
      d.components.find((c) => c.category === cat)?.weight;
    expect(weightOf(swing, 'trend')).toBe(SWING_TEMPLATE.weights.trend);
    for (const doc of docs.filter((d) => d.tradingStyle !== 'swing_trading')) {
      expect(weightOf(doc, 'trend')).toBe(DEFAULT_TEMPLATE_WEIGHTS[doc.tradingStyle].trend);
    }
    expect(mockFindOne).toHaveBeenCalledTimes(TASKS.length);
  });
});
