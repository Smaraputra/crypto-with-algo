// @vitest-environment node
//
// Acceptance test for the central promise of the provisional overlay: the
// route and the scoring that follows it can never leave a trace in Mongo. It
// seeds real documents in every collection the live record touches, drives
// the real route handler at several moments of one forming bar, scores
// synthetic ticks, and proves nothing changed and no provisional score was
// stored anywhere.
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';

import { buildCandles, mulberry32, seedFor } from '@/__fixtures__/scoring-fixture';
import { LS_Z_WARMUP_MS } from '@/lib/backtest/snapshot-series';
import { Candle } from '@/lib/models/candle';
import { GlobalSignal } from '@/lib/models/global-signal';
import { HistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { SignalOutcome } from '@/lib/models/signal-outcome';
import { DEFAULT_TEMPLATE_WEIGHTS, SignalTemplate } from '@/lib/models/signal-template';
import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';
import { scoreProvisional } from '@/lib/signals/provisional/score-provisional';
import type {
  FormingBar,
  ProvisionalContext,
  ProvisionalScore,
} from '@/lib/signals/provisional/types';

const mocks = vi.hoisted(() => ({
  cacheKeys: [] as string[],
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'user-1' } }) }));
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
vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreed: async () => {
    throw new Error('the shared Fear and Greed fetcher must not be called');
  },
  fetchFearAndGreedUncached: async () => ({ fearGreedIndex: 31, label: 'Fear' }),
}));
vi.mock('@/lib/binance', () => ({
  fetchKlines: async () => {
    throw new Error('Binance REST must not be called');
  },
}));

const SYMBOL = 'BTCUSDT';
const HOUR = 3_600_000;
const FORMING = Date.UTC(2026, 9, 9, 5, 0, 0, 0);
const MODELS = [Candle, GlobalSignal, HistoricalSnapshot, SignalOutcome, SignalTemplate];

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { monitorCommands: true });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(() => {
  vi.useRealTimers();
});

async function seed() {
  const candles = [
    ...buildCandles({
      symbol: SYMBOL,
      interval: '1h',
      count: 520,
      endOpenTime: FORMING - HOUR,
      seed: seedFor('candles', SYMBOL, '1h'),
      startPrice: 60000,
    }).map((c) => ({ ...c, symbol: SYMBOL, interval: '1h' })),
    ...buildCandles({
      symbol: SYMBOL,
      interval: '4h',
      count: 520,
      endOpenTime: Date.UTC(2026, 9, 9, 0, 0, 0, 0),
      seed: seedFor('candles', SYMBOL, '4h'),
      startPrice: 60000,
    }).map((c) => ({ ...c, symbol: SYMBOL, interval: '4h' })),
  ];
  await Candle.insertMany(candles);

  const rng = mulberry32(7);
  const first = FORMING - LS_Z_WARMUP_MS - 5 * 24 * HOUR;
  const rows = [];
  let k = 0;
  for (let t = Math.ceil(first / HOUR) * HOUR; t <= FORMING; t += HOUR, k++) {
    const ratio = 1.5 + 0.4 * Math.sin(k / 30) + (rng() - 0.5) * 0.1;
    const longAccount = ratio / (1 + ratio);
    rows.push({
      symbol: SYMBOL,
      interval: '1h',
      timestamp: t,
      data: {
        fundingRate: { rate: 0.0001 + (rng() - 0.4) * 0.0004, markPrice: 60000 },
        longShortRatio: { ratio, longAccount, shortAccount: 1 - longAccount },
        newsSentiment: { count: 7, avgSentiment: 0.25, topics: ['etf'] },
      },
    });
  }
  await HistoricalSnapshot.insertMany(rows);

  await SignalTemplate.create({
    tradingStyle: 'day_trading',
    version: 3,
    weights: { ...DEFAULT_TEMPLATE_WEIGHTS.day_trading },
    thresholds: { entryThreshold: 30, exitThreshold: 10, shortEntryThreshold: -30, shortExitThreshold: -10 },
    active: true,
  });

  const signal = await GlobalSignal.create({
    symbol: SYMBOL,
    interval: '1h',
    tradingStyle: 'day_trading',
    score: 17.318429,
    tier: 'neutral',
    confidence: 41.726193,
    components: [],
    configVersion: SCORER_CONFIG_VERSION,
    candleTimestamp: FORMING - HOUR,
    session: null,
    htfContext: null,
    expiresAt: new Date(Date.UTC(2027, 0, 1)),
  });
  await SignalOutcome.create({
    signalId: signal._id,
    symbol: SYMBOL,
    interval: '1h',
    tradingStyle: 'day_trading',
    tier: 'neutral',
    score: 17.318429,
    configVersion: SCORER_CONFIG_VERSION,
    candleTimestamp: FORMING - HOUR,
    horizonBars: 4,
    resolveAt: FORMING + 3 * HOUR,
  });
}

const WRITE_COMMANDS = new Set([
  'insert',
  'update',
  'delete',
  'findAndModify',
  'createIndexes',
  'drop',
  'dropIndexes',
  'dropDatabase',
  'create',
  'renameCollection',
]);

/** A write command, or an aggregate that writes through $out or $merge. */
function isWriteCommand(name: string, command: Record<string, unknown>): boolean {
  if (WRITE_COMMANDS.has(name)) return true;
  if (name !== 'aggregate') return false;
  const pipeline = Array.isArray(command.pipeline) ? command.pipeline : [];
  return pipeline.some((stage) => stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage));
}

interface Snapshot {
  hashes: Map<string, string>;
  docs: Map<string, unknown[]>;
}

async function snapshotDb(): Promise<Snapshot> {
  const db = mongoose.connection.db!;
  const hashes = new Map<string, string>();
  const docs = new Map<string, unknown[]>();
  for (const { name } of await db.listCollections().toArray()) {
    const all = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    docs.set(name, all);
    hashes.set(name, createHash('sha256').update(JSON.stringify(all)).digest('hex'));
  }
  return { hashes, docs };
}

function* numbersIn(value: unknown): Generator<number> {
  if (typeof value === 'number') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* numbersIn(v);
  else if (value && typeof value === 'object' && !(value instanceof Date)) {
    // ObjectId and Buffer-like values carry no numeric field of interest
    if ((value as { _bsontype?: string })._bsontype) return;
    for (const v of Object.values(value)) yield* numbersIn(v);
  }
}

async function callRoute(now: number): Promise<ProvisionalContext> {
  vi.setSystemTime(now);
  const { GET } = await import('./route');
  const url = new URL('http://localhost:3000/api/signals/provisional-context');
  url.searchParams.set('symbol', SYMBOL);
  url.searchParams.set('interval', '1h');
  url.searchParams.set('style', 'day_trading');
  const res = await GET(new NextRequest(url));
  expect(res.status).toBe(200);
  return (await res.json()) as ProvisionalContext;
}

describe('provisional context never reaches Mongo', () => {
  it('leaves every collection byte-identical and stores no provisional score', async () => {
    await seed();
    for (const model of MODELS) await model.init();

    const before = await snapshotDb();
    const observed: string[] = [];
    const writes: string[] = [];
    const onCommand = (ev: { commandName: string; command: Record<string, unknown> }) => {
      observed.push(ev.commandName);
      if (isWriteCommand(ev.commandName, ev.command)) writes.push(ev.commandName);
    };
    const client = mongoose.connection.getClient();
    client.on('commandStarted', onCommand);
    expect(before.hashes.size).toBeGreaterThanOrEqual(MODELS.length);

    vi.useFakeTimers({ now: FORMING + 60_000, toFake: ['Date'] });

    const times = [5, 15, 27, 41, 58].map((m) => FORMING + m * 60_000);
    const rng = mulberry32(99);
    const scores: ProvisionalScore[] = [];
    let readyContexts = 0;

    for (const now of times) {
      const ctx = await callRoute(now);
      if (!ctx.ready) continue;
      readyContexts++;
      const last = ctx.closedCandles[ctx.closedCandles.length - 1];
      let close = last.close;
      for (let tick = 0; tick < 20; tick++) {
        const open = last.close;
        close *= 1 + (rng() - 0.5) * 0.004;
        const bar: FormingBar = {
          openTime: ctx.formingOpenTime,
          open,
          high: Math.max(open, close) * (1 + rng() * 0.001),
          low: Math.min(open, close) * (1 - rng() * 0.001),
          close,
          volume: 100 + tick * 15,
          takerBuyVolume: (100 + tick * 15) * (0.3 + rng() * 0.4),
        };
        const scored = scoreProvisional(ctx, bar);
        expect(scored).not.toBeNull();
        scores.push(scored!);
      }
    }

    // The test cannot pass vacuously.
    expect(readyContexts).toBe(times.length);
    expect(scores.length).toBeGreaterThanOrEqual(20);
    expect(new Set(scores.map((s) => s.score)).size).toBeGreaterThan(1);

    client.off('commandStarted', onCommand);

    // The listener really saw the route's reads, and no command wrote. A hash
    // comparison alone cannot see an idempotent upsert or an insert then delete.
    expect(observed).toContain('find');
    expect(writes).toEqual([]);

    const after = await snapshotDb();

    // No new collection, no changed collection.
    expect([...after.hashes.keys()].sort()).toEqual([...before.hashes.keys()].sort());
    for (const [name, hash] of before.hashes) {
      expect(after.hashes.get(name), `collection ${name} changed`).toBe(hash);
    }

    // No stored number equals any produced provisional score.
    const produced = new Set(scores.map((s) => s.score));
    for (const [name, docs] of after.docs) {
      for (const doc of docs) {
        for (const n of numbersIn(doc)) {
          expect(produced.has(n), `${name} holds ${n}, a provisional score`).toBe(false);
        }
      }
    }

    // Only provisional: keys were written through the cache.
    expect(mocks.cacheKeys.length).toBeGreaterThan(0);
    for (const key of mocks.cacheKeys) expect(key.startsWith('provisional:')).toBe(true);
  }, 60_000);
});
