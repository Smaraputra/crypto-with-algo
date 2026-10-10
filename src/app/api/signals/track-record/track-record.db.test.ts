// @vitest-environment node
//
// The track-record routes against a real Mongo: the hand-over from re-scored
// bars to the live record at the boundary, the live summary's filters (run
// version, composite source, symbol, cell), and the promise that both routes
// only read: every collection hashes the same after they ran, and every cache
// key is a track-record key.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';

import { GlobalSignal } from '@/lib/models/global-signal';
import { SignalOutcome } from '@/lib/models/signal-outcome';
import { SignalRescoreBar } from '@/lib/models/signal-rescore-bar';
import { SignalRescoreRun } from '@/lib/models/signal-rescore-run';
import { pointMeasures, tierCode } from '@/lib/signals/track-record/measures';
import {
  TRACK_RECORD_RUN_ID,
  type TrackBarsResponse,
  type TrackRecordResponse,
  type TrackRun,
} from '@/lib/signals/track-record/types';
import type { SignalTier } from '@/types/signal';

const mocks = vi.hoisted(() => ({
  cacheKeys: [] as string[],
  session: { user: { id: 'user-1' } } as { user: { id: string } } | null,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => mocks.session }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => null,
  rateLimitUser: async () => null,
}));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/redis', () => ({
  cachedFetch: (key: string, fn: () => Promise<unknown>) => {
    mocks.cacheKeys.push(key);
    return fn();
  },
}));

import { GET as getSummary } from './route';
import { GET as getBars } from './bars/route';

const HOUR = 3_600_000;
const DAY0 = Date.UTC(2026, 8, 28);
/** Re-scored bars: 72 hours from DAY0. The live record starts 48 hours in. */
const LIVE_SINCE = DAY0 + 48 * HOUR;
const MODELS = [GlobalSignal, SignalOutcome, SignalRescoreBar, SignalRescoreRun];

function tierOf(score: number): SignalTier {
  if (score > 36) return 'strong_buy';
  if (score > 28) return 'buy';
  if (score < -36) return 'strong_sell';
  if (score < -28) return 'sell';
  return 'neutral';
}

/** Bar i: score cycles through every tier, return alternates sign and size. */
const scoreAt = (i: number) => [40, 30, 0, -30, -40][i % 5];
const fwdAt = (i: number) => (i % 2 === 0 ? 0.5 : -0.3) * (1 + (i % 3));

const rescored = Array.from({ length: 72 }, (_, i) => ({
  t: DAY0 + i * HOUR,
  score: scoreAt(i),
  tier: tierOf(scoreAt(i)),
  fwd: fwdAt(i),
}));

function runDoc(): TrackRun {
  const rows = rescored.map((b) => ({ tier: b.tier, forwardReturnPercent: b.fwd }));
  return {
    runId: TRACK_RECORD_RUN_ID,
    configVersion: 8,
    windowStart: '2025-10-01T00:00:00.000Z',
    windowEnd: '2026-10-09T23:59:59.999Z',
    cutoffs: { buy: 28, strong: 36 },
    rowsSha256: 'a'.repeat(64),
    reportSha256: 'b'.repeat(64),
    gitCommit: '663e4a1',
    resamples: 1_000,
    seed: 13,
    loadedAt: '2026-10-11T00:00:00.000Z',
    cells: [
      {
        style: 'day_trading',
        interval: '1h',
        horizonBars: 24,
        costPercent: 0.16,
        pooled: {
          rows: 89_520,
          buyN: 7_874,
          sellN: 7_987,
          bh: 0.441,
          bhLo: 0.387,
          bhHi: 0.495,
          net: -0.236,
          netLo: -0.72,
          netHi: 0.231,
          spearman: -0.047,
          level: 1 - 0.05 / 6,
          verdict: 'NO DETECTABLE EDGE',
        },
        parity: { matched: 1_740, sameTierShare: 0.9994, scoreCorrelation: 0.99999 },
        symbols: [
          {
            symbol: 'BTCUSDT',
            first: rescored[0].t,
            last: rescored[rescored.length - 1].t,
            liveSince: LIVE_SINCE,
            measures: pointMeasures(rows, 0.16),
            intervals: { right: { lo: 0.4, hi: 0.6 }, bh: { lo: 0.4, hi: 0.6 }, net: { lo: -0.3, hi: 0.2 } },
            months: [{ month: '2026-09', calls: 40, right: 0.5, bh: 0.5, net: -0.1 }],
          },
          {
            symbol: 'ETHUSDT',
            first: rescored[0].t,
            last: rescored[rescored.length - 1].t,
            liveSince: null,
            measures: pointMeasures(rows, 0.16),
            intervals: { right: null, bh: null, net: null },
            months: [],
          },
        ],
      },
    ],
  };
}

function outcome(overrides: Record<string, unknown>) {
  return {
    signalId: new Types.ObjectId(),
    source: 'composite',
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    tier: 'buy',
    score: 30,
    configVersion: 8,
    candleTimestamp: LIVE_SINCE,
    horizonBars: 24,
    resolveAt: LIVE_SINCE + 25 * HOUR,
    status: 'resolved',
    entryPrice: 60_000,
    forwardReturnPercent: 0.4,
    ...overrides,
  };
}

/** Live v8 rows from LIVE_SINCE: 30 hourly bars, the last 6 still pending. */
const liveRows = Array.from({ length: 30 }, (_, i) => {
  const score = scoreAt(i + 1);
  const pending = i >= 24;
  return outcome({
    candleTimestamp: LIVE_SINCE + i * HOUR,
    score,
    tier: tierOf(score),
    status: pending ? 'pending' : 'resolved',
    forwardReturnPercent: pending ? null : fwdAt(i + 7),
  });
});

/** Rows the routes must ignore: another version, the llm source, another symbol, another cell. */
const foreignRows = [
  outcome({ configVersion: 7, candleTimestamp: LIVE_SINCE + HOUR, tier: 'strong_sell', score: -50, forwardReturnPercent: 9 }),
  outcome({ source: 'llm', candleTimestamp: LIVE_SINCE + 2 * HOUR, tier: 'strong_sell', score: -50, forwardReturnPercent: 9 }),
  outcome({ symbol: 'SOLUSDT', candleTimestamp: LIVE_SINCE + 3 * HOUR, forwardReturnPercent: 9 }),
  outcome({ interval: '15m', candleTimestamp: LIVE_SINCE + 4 * HOUR, forwardReturnPercent: 9 }),
];

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all(MODELS.map((m) => m.init()));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  mocks.cacheKeys.length = 0;
  mocks.session = { user: { id: 'user-1' } };
});

async function seed() {
  const run = runDoc();
  await SignalRescoreRun.create({ ...run, loadedAt: new Date(run.loadedAt) });
  const byDay = new Map<number, typeof rescored>();
  for (const b of rescored) {
    const day = Math.floor(b.t / (24 * HOUR)) * 24 * HOUR;
    byDay.set(day, [...(byDay.get(day) ?? []), b]);
  }
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    await SignalRescoreBar.insertMany(
      [...byDay.entries()].map(([bucketStart, bars]) => ({
        runId: TRACK_RECORD_RUN_ID,
        symbol,
        interval: '1h',
        tradingStyle: 'day_trading',
        bucketStart,
        t: bars.map((b) => b.t),
        score: bars.map((b) => b.score),
        tier: bars.map((b) => tierCode(b.tier)),
        fwd: bars.map((b) => b.fwd),
      }))
    );
  }
  await SignalOutcome.insertMany([...liveRows, ...foreignRows]);
  await GlobalSignal.create({
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    candleTimestamp: LIVE_SINCE,
    score: 30,
    tier: 'buy',
    confidence: 90,
    configVersion: 8,
    expiresAt: new Date(Date.UTC(2030, 0, 1)),
  });
}

async function hashAll(): Promise<string> {
  const hash = createHash('sha256');
  for (const model of MODELS) {
    const docs = await model.collection.find({}).sort({ _id: 1 }).toArray();
    hash.update(model.collection.collectionName);
    hash.update(JSON.stringify(docs));
  }
  return hash.digest('hex');
}

function request(path: string, params: Record<string, string | number>): NextRequest {
  const url = new URL(`http://localhost:3000${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return new NextRequest(url);
}

const CELL = { symbol: 'BTCUSDT', interval: '1h', style: 'day_trading' };

describe('track-record routes before the run is loaded', () => {
  it('report no run, and no bars', async () => {
    const summary = (await (await getSummary(request('/api/signals/track-record', CELL))).json()) as TrackRecordResponse;
    expect(summary).toEqual({ available: false, reason: 'no-run' });
    const bars = (await (
      await getBars(request('/api/signals/track-record/bars', { ...CELL, from: DAY0, to: DAY0 + 10 * HOUR }))
    ).json()) as TrackBarsResponse;
    expect(bars.available).toBe(false);
    expect(bars.bars).toEqual([]);
  });
});

describe('track-record routes with a loaded run', () => {
  beforeAll(seed);

  it('rejects anonymous callers and bad queries', async () => {
    mocks.session = null;
    expect((await getSummary(request('/api/signals/track-record', CELL))).status).toBe(401);
    expect((await getBars(request('/api/signals/track-record/bars', { ...CELL, from: 0, to: 1 }))).status).toBe(401);
    mocks.session = { user: { id: 'user-1' } };
    expect((await getSummary(request('/api/signals/track-record', { ...CELL, symbol: 'PEPEUSDT' }))).status).toBe(400);
    expect(
      (await getBars(request('/api/signals/track-record/bars', { ...CELL, from: DAY0, to: DAY0 + 2_000 * HOUR }))).status
    ).toBe(400);
    expect((await getBars(request('/api/signals/track-record/bars', { ...CELL, from: 10, to: 5 }))).status).toBe(400);
  });

  it('answers not-scored for a cell the re-score does not cover', async () => {
    const res = (await (
      await getSummary(request('/api/signals/track-record', { ...CELL, interval: '1m', style: 'scalping' }))
    ).json()) as TrackRecordResponse;
    expect(res).toEqual({ available: false, reason: 'not-scored' });
  });

  it('returns the pooled verdict, the symbol year, the boundary and the live record', async () => {
    const res = (await (await getSummary(request('/api/signals/track-record', CELL))).json()) as TrackRecordResponse;
    if (!res.available) throw new Error('expected a track record');
    expect(res.run.runId).toBe(TRACK_RECORD_RUN_ID);
    expect(res.run).not.toHaveProperty('cells');
    expect(res.cell).not.toHaveProperty('symbols');
    expect(res.cell.pooled.verdict).toBe('NO DETECTABLE EDGE');
    expect(res.symbol?.symbol).toBe('BTCUSDT');
    expect(res.boundary).toBe(LIVE_SINCE);
    expect(res.liveConfigVersion).toBe(8);

    const resolved = liveRows.filter((r) => r.status === 'resolved');
    expect(res.live.since).toBe(LIVE_SINCE);
    expect(res.live.resolved).toBe(resolved.length);
    expect(res.live.pending).toBe(6);
    expect(res.live.measures).toEqual(
      pointMeasures(resolved as Array<{ tier: string; forwardReturnPercent: number }>, 0.16)
    );
  });

  it('falls back to the bar after the last re-scored bar when the symbol has no live start', async () => {
    const res = (await (
      await getSummary(request('/api/signals/track-record', { ...CELL, symbol: 'ETHUSDT' }))
    ).json()) as TrackRecordResponse;
    if (!res.available) throw new Error('expected a track record');
    expect(res.boundary).toBe(rescored[rescored.length - 1].t + HOUR);
    expect(res.live).toMatchObject({ resolved: 0, pending: 0 });
  });

  it('serves re-scored bars before the boundary and live bars from it, nothing foreign', async () => {
    const from = DAY0 + 40 * HOUR;
    const to = DAY0 + 60 * HOUR;
    const res = (await (
      await getBars(request('/api/signals/track-record/bars', { ...CELL, from, to }))
    ).json()) as TrackBarsResponse;
    expect(res).toMatchObject({ available: true, configVersion: 8, boundary: LIVE_SINCE, horizonBars: 24, costPercent: 0.16 });

    const rescoreBars = res.bars.filter((b) => b.source === 'rescore');
    const liveBars = res.bars.filter((b) => b.source === 'live');
    expect(rescoreBars.map((b) => b.t)).toEqual(rescored.filter((b) => b.t >= from && b.t < LIVE_SINCE).map((b) => b.t));
    expect(rescoreBars[0]).toEqual({ t: from, score: rescored[40].score, tier: rescored[40].tier, fwd: rescored[40].fwd, source: 'rescore' });
    expect(liveBars.map((b) => b.t)).toEqual(liveRows.filter((r) => r.candleTimestamp <= to).map((r) => r.candleTimestamp));
    expect(liveBars.some((b) => b.fwd === 9)).toBe(false);
  });

  it('marks pending live bars with a null outcome', async () => {
    const res = (await (
      await getBars(request('/api/signals/track-record/bars', { ...CELL, from: LIVE_SINCE + 20 * HOUR, to: LIVE_SINCE + 40 * HOUR }))
    ).json()) as TrackBarsResponse;
    const pending = res.bars.filter((b) => b.fwd === null);
    expect(pending.map((b) => b.t)).toEqual(liveRows.slice(24).map((r) => r.candleTimestamp));
    expect(pending.every((b) => b.source === 'live')).toBe(true);
  });

  it('serves only re-scored bars for a range wholly before the boundary', async () => {
    const res = (await (
      await getBars(request('/api/signals/track-record/bars', { ...CELL, from: DAY0, to: DAY0 + 5 * HOUR }))
    ).json()) as TrackBarsResponse;
    expect(res.bars.map((b) => b.source)).toEqual(Array(6).fill('rescore'));
  });

  it('only reads: every collection is unchanged and every cache key is a track-record key', async () => {
    const before = await hashAll();
    await getSummary(request('/api/signals/track-record', CELL));
    await getSummary(request('/api/signals/track-record', { ...CELL, symbol: 'ETHUSDT' }));
    await getBars(request('/api/signals/track-record/bars', { ...CELL, from: DAY0, to: DAY0 + 100 * HOUR }));
    expect(await hashAll()).toBe(before);
    expect(mocks.cacheKeys.length).toBeGreaterThan(0);
    expect(mocks.cacheKeys.every((k) => k.startsWith('track-record:'))).toBe(true);
  });
});
