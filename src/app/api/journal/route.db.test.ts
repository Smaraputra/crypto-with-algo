// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';

import { JournalEntry } from '@/lib/models/journal-entry';

const mocks = vi.hoisted(() => ({
  session: { user: { id: 'user-1' } } as { user: { id: string } } | null,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => mocks.session }));
vi.mock('@/lib/rate-limit', () => ({
  authenticatedLimiter: {},
  rateLimitUser: async () => null,
}));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

import { GET, POST } from './route';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await JournalEntry.init();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  mocks.session = { user: { id: 'user-1' } };
});

function makeGetRequest(params?: string): NextRequest {
  const url = params
    ? `http://localhost/api/journal?${params}`
    : 'http://localhost/api/journal';
  return new NextRequest(url);
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/journal', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Journal route with real MongoDB', () => {
  it('handles old entries, POST entries, effective enteredAt sorting, filtering and user isolation', async () => {
    // 1. Insert one old entry straight into collection with no enteredAt (createdAt 2026-01-10)
    const oldCreatedAt = new Date('2026-01-10T12:00:00.000Z');
    await JournalEntry.collection.insertOne({
      userId: 'user-1',
      symbol: 'BTCUSDT',
      interval: '1h',
      signalScore: 40,
      signalTier: 'buy',
      action: 'buy',
      entryPrice: 42000,
      exitPrice: null,
      outcomePnlPercent: null,
      notes: 'Old entry without enteredAt',
      reviewedAt: null,
      tags: [],
      indicatorSnapshot: null,
      strategyId: null,
      backtestResultId: null,
      lessonsLearned: '',
      reviewHistory: [],
      setupType: '',
      marketCondition: null,
      emotion: null,
      mistakes: [],
      convictionLevel: null,
      plannedRiskReward: null,
      sentiment: null,
      createdAt: oldCreatedAt,
      updatedAt: oldCreatedAt,
    });

    // Also insert another user's entry to test isolation
    await JournalEntry.collection.insertOne({
      userId: 'user-2',
      symbol: 'DOGEUSDT',
      interval: '1h',
      signalScore: 20,
      signalTier: 'buy',
      action: 'buy',
      entryPrice: null,
      exitPrice: null,
      outcomePnlPercent: null,
      notes: 'Other user trade',
      reviewedAt: null,
      tags: [],
      indicatorSnapshot: null,
      strategyId: null,
      backtestResultId: null,
      lessonsLearned: '',
      reviewHistory: [],
      setupType: '',
      marketCondition: null,
      emotion: null,
      mistakes: [],
      convictionLevel: null,
      plannedRiskReward: null,
      sentiment: null,
      createdAt: new Date('2026-01-15T10:00:00.000Z'),
      updatedAt: new Date('2026-01-15T10:00:00.000Z'),
    });

    // 2. Create two entries through POST: one with enteredAt 2026-01-05, one with none
    const resPost1 = await POST(
      makePostRequest({
        symbol: 'ETHUSDT',
        interval: '1h',
        signalScore: 35,
        signalTier: 'buy',
        action: 'buy',
        enteredAt: '2026-01-05T12:00:00.000Z',
      })
    );
    expect(resPost1.status).toBe(201);

    const resPost2 = await POST(
      makePostRequest({
        symbol: 'SOLUSDT',
        interval: '1h',
        signalScore: -35,
        signalTier: 'sell',
        action: 'sell',
      })
    );
    expect(resPost2.status).toBe(201);

    // 3. GET returns three entries ordered newest enteredAt first,
    // with the old one's enteredAt equal to its createdAt
    const resGet = await GET(makeGetRequest());
    expect(resGet.status).toBe(200);
    const data = await resGet.json();

    expect(data.entries).toHaveLength(3);
    expect(data.total).toBe(3);
    expect(data.totalUserEntries).toBe(3);

    // Order: SOLUSDT (now) > BTCUSDT (2026-01-10) > ETHUSDT (2026-01-05)
    expect(data.entries[0].symbol).toBe('SOLUSDT');
    expect(data.entries[1].symbol).toBe('BTCUSDT');
    expect(data.entries[2].symbol).toBe('ETHUSDT');

    // The old entry has enteredAt equal to its createdAt
    const oldEntry = data.entries.find((e: { symbol: string }) => e.symbol === 'BTCUSDT');
    expect(oldEntry).toBeDefined();
    expect(new Date(oldEntry.enteredAt).getTime()).toBe(oldCreatedAt.getTime());
    expect(new Date(oldEntry.enteredAt).toISOString()).toBe(new Date(oldEntry.createdAt).toISOString());
    expect(oldEntry.exitedAt).toBeNull();

    // 4. startDate=2026-01-06 excludes the 01-05 entry
    const resFiltered = await GET(makeGetRequest('startDate=2026-01-06T00:00:00.000Z'));
    expect(resFiltered.status).toBe(200);
    const filteredData = await resFiltered.json();
    expect(filteredData.entries).toHaveLength(2);
    expect(filteredData.entries.map((e: { symbol: string }) => e.symbol)).toEqual(['SOLUSDT', 'BTCUSDT']);
    expect(filteredData.entries.some((e: { symbol: string }) => e.symbol === 'ETHUSDT')).toBe(false);

    // 5. Another user's entries are never returned
    expect(data.entries.some((e: { userId: string }) => e.userId === 'user-2')).toBe(false);
    expect(data.entries.some((e: { symbol: string }) => e.symbol === 'DOGEUSDT')).toBe(false);
    expect(filteredData.entries.some((e: { userId: string }) => e.userId === 'user-2')).toBe(false);
  });
});
