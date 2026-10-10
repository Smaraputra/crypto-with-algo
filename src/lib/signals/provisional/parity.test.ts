// Parity: the provisional score for the forming bar, computed from the
// route's context with the browser-side module, must equal EXACTLY what the
// scheduler records for that bar once it closes (same fixtures and mocking
// as the A1 golden). If this fails, the chart would show a value the
// scheduler then contradicts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OHLCV } from '@/types/market';
import { intervalToMs } from '@/lib/intervals';
import { LS_Z_WARMUP_MS } from '@/lib/backtest/snapshot-series';
import {
  buildCandles,
  buildSnapshotRows,
  FIXTURE_FEAR_GREED,
  NEWS_AGGREGATE_ROWS,
  seedFor,
  type FixtureSnapshotRow,
} from '@/__fixtures__/scoring-fixture';
import { scoreProvisional } from './score-provisional';
import type { FormingBar, ProvisionalContext, ProvisionalContextReady } from './types';

const mocks = vi.hoisted(() => ({
  getCandles: vi.fn(),
  fetchKlines: vi.fn(),
  fetchFearAndGreed: vi.fn(),
  fetchFearAndGreedUncached: vi.fn(),
  insertMany: vi.fn(),
  snapshotAggregate: vi.fn(),
  snapshotFind: vi.fn(),
  createPendingOutcomes: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => null,
  rateLimitUser: async () => null,
}));
vi.mock('@/lib/signals/outcome-resolver', () => ({
  createPendingOutcomes: (...a: unknown[]) => mocks.createPendingOutcomes(...a),
}));
vi.mock('@/lib/candle-ingestion', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/candle-ingestion')>('@/lib/candle-ingestion');
  return {
    dropOpenBars: actual.dropOpenBars,
    getCandles: (...a: unknown[]) => mocks.getCandles(...a),
  };
});
vi.mock('@/lib/binance', () => ({ fetchKlines: (...a: unknown[]) => mocks.fetchKlines(...a) }));
vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: () => mocks.fetchFearAndGreed(),
  fetchFearAndGreedUncached: () => mocks.fetchFearAndGreedUncached(),
}));
vi.mock('@/lib/redis', () => ({
  cachedFetch: (_key: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/models/global-signal', () => ({
  GlobalSignal: {
    insertMany: (...a: unknown[]) => mocks.insertMany(...a),
    aggregate: () => Promise.resolve([]),
  },
}));
vi.mock('@/lib/models/signal-template', async () => {
  const actual = await vi.importActual('@/lib/models/signal-template');
  return { ...actual, SignalTemplate: { findOne: () => ({ lean: async () => null }) } };
});
vi.mock('@/lib/models/historical-snapshot', () => ({
  HistoricalSnapshot: {
    aggregate: (...a: unknown[]) => mocks.snapshotAggregate(...a),
    find: (...a: unknown[]) => ({ sort: () => ({ lean: () => mocks.snapshotFind(...a) }) }),
  },
}));

const SYMBOL = 'BTCUSDT';
const HOUR = 3_600_000;
const SERIES_END = Date.UTC(2026, 9, 9, 12, 0, 0, 0);
const SERIES_COUNT = 800;

// One fixed series per interval, so the same bar has the same values whichever
// moment the mocked Mongo is read at. Mongo holds closed bars only.
const series = new Map<string, OHLCV[]>();
for (const interval of ['1h', '4h']) {
  series.set(
    interval,
    buildCandles({
      symbol: SYMBOL,
      interval,
      count: SERIES_COUNT,
      endOpenTime: SERIES_END,
      seed: seedFor('candles', SYMBOL, interval),
      startPrice: 60000,
    })
  );
}
const snapshotRows = new Map<string, FixtureSnapshotRow[]>();
for (const snapshotInterval of ['1h']) {
  snapshotRows.set(
    snapshotInterval,
    buildSnapshotRows({
      symbol: SYMBOL,
      snapshotInterval,
      from: SERIES_END - LS_Z_WARMUP_MS - 40 * 24 * HOUR,
      to: SERIES_END,
      seed: seedFor('snapshots', SYMBOL, snapshotInterval),
    })
  );
}

function barAt(interval: string, openTime: number): OHLCV {
  const bar = series.get(interval)!.find((c) => c.timestamp === openTime);
  if (!bar) throw new Error(`no ${interval} bar at ${openTime}`);
  return bar;
}

function toFormingBar(c: OHLCV): FormingBar {
  return {
    openTime: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    takerBuyVolume: c.takerBuyVolume!,
  };
}

async function routeContextAt(now: number): Promise<ProvisionalContext> {
  vi.setSystemTime(now);
  const { GET } = await import('@/app/api/signals/provisional-context/route');
  const url = new URL('http://localhost:3000/api/signals/provisional-context');
  url.searchParams.set('symbol', SYMBOL);
  url.searchParams.set('interval', '1h');
  url.searchParams.set('style', 'day_trading');
  const res = await GET(new NextRequest(url));
  expect(res.status).toBe(200);
  return (await res.json()) as ProvisionalContext;
}

interface EngineDoc {
  candleTimestamp: number;
  score: number;
  tier: string;
  confidence: number;
  components: unknown[];
  htfContext: { candleTimestamp: number };
}

async function engineDocAt(now: number, openTime: number): Promise<EngineDoc> {
  vi.setSystemTime(now);
  mocks.insertMany.mockClear();
  const { computeSignalBatch } = await import('@/lib/signals/compute-engine');
  const result = await computeSignalBatch([
    { symbol: SYMBOL, interval: '1h', tradingStyle: 'day_trading' },
  ]);
  expect(result).toMatchObject({ computed: 1, errors: 0, skipped: 0 });
  const [doc] = mocks.insertMany.mock.calls[0][0] as EngineDoc[];
  expect(doc.candleTimestamp).toBe(openTime);
  return doc;
}

describe('provisional score parity with the scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: SERIES_END, toFake: ['Date'] });

    // Mongo as of the (fake) wall clock: closed bars only, newest `limit`.
    mocks.getCandles.mockImplementation(
      async (symbol: string, interval: string, _s: unknown, _e: unknown, limit: number) => {
        expect(symbol).toBe(SYMBOL);
        const now = Date.now();
        const ms = intervalToMs(interval);
        return series.get(interval)!.filter((c) => c.timestamp + ms <= now).slice(-limit);
      }
    );
    mocks.fetchKlines.mockRejectedValue(new Error('fetchKlines must not be called'));
    mocks.fetchFearAndGreed.mockResolvedValue(FIXTURE_FEAR_GREED);
    mocks.fetchFearAndGreedUncached.mockResolvedValue(FIXTURE_FEAR_GREED);
    mocks.snapshotAggregate.mockResolvedValue(NEWS_AGGREGATE_ROWS);
    mocks.snapshotFind.mockImplementation(
      async (f: { symbol: string; interval: string; timestamp: { $gte: number; $lte: number } }) =>
        (snapshotRows.get(f.interval) ?? []).filter(
          (r) => r.timestamp >= f.timestamp.$gte && r.timestamp <= f.timestamp.$lte
        )
    );
    mocks.insertMany.mockResolvedValue([]);
    mocks.createPendingOutcomes.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('equals the scheduler record for the bar once it closes (close is not a 4h boundary)', async () => {
    // Bar N opens 05:00 and closes 06:00. 4h boundaries are 04:00 and 08:00.
    const openN = Date.UTC(2026, 9, 9, 5, 0, 0, 0);
    expect((openN + HOUR) % (4 * HOUR)).not.toBe(0);

    const ctx = await routeContextAt(openN + 20 * 60_000);
    expect(ctx.ready).toBe(true);
    const ready = ctx as ProvisionalContextReady;
    expect(ready.formingOpenTime).toBe(openN);
    expect(ready.futures).not.toBeNull();
    expect(ready.htfContext).not.toBeNull();
    expect(ready.sentiment?.news).toEqual({ count: 8, avgSentiment: 0.42 });

    const doc = await engineDocAt(openN + HOUR + 7 * 60_000, openN);
    const provisional = scoreProvisional(ready, toFormingBar(barAt('1h', openN)));

    expect(provisional).not.toBeNull();
    expect(provisional!.score).toBe(doc.score);
    expect(provisional!.tier).toBe(doc.tier);
    expect(provisional!.confidence).toBe(doc.confidence);
    expect(provisional!.components).toEqual(doc.components);
    // The HTF context the two paths used is the same bar.
    expect(ready.htfContext!.candleTimestamp).toBe(doc.htfContext.candleTimestamp);
    // Guard against a vacuous match on a neutral zero.
    expect(doc.components.length).toBeGreaterThan(0);
    expect(doc.score).not.toBe(0);
  });

  it('KNOWN DIVERGENCE at a 4h boundary: the route HTF context is one HTF bar older', async () => {
    // Bar N opens 07:00 and closes 08:00, the instant the 04:00 4h bar closes.
    // While N forms, that 4h bar is still open; once N closes it is the last
    // closed HTF bar, so the scheduler uses a newer HTF context than the
    // provisional value could. The score may therefore shift at the close.
    const openN = Date.UTC(2026, 9, 9, 7, 0, 0, 0);
    expect((openN + HOUR) % (4 * HOUR)).toBe(0);

    const ready = (await routeContextAt(openN + 20 * 60_000)) as ProvisionalContextReady;
    const doc = await engineDocAt(openN + HOUR + 7 * 60_000, openN);

    const fourHours = 4 * HOUR;
    expect(doc.htfContext.candleTimestamp - ready.htfContext!.candleTimestamp).toBe(fourHours);
    expect(ready.htfContext!.candleTimestamp).toBe(Date.UTC(2026, 9, 9, 0, 0, 0, 0));
    expect(doc.htfContext.candleTimestamp).toBe(Date.UTC(2026, 9, 9, 4, 0, 0, 0));
  });
});
