// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/journal-entry', () => ({
  JournalEntry: {
    find: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
    aggregate: vi.fn(),
  },
  MAX_JOURNAL_ENTRIES_PER_USER: 1000,
  // The route filters on this; it is the real value, not a stub, so a change
  // to the action vocabulary surfaces here rather than passing silently.
  POSITION_ACTIONS: ['buy', 'sell'],
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { JournalEntry } from '@/lib/models/journal-entry';
import { mockCreateJournalInput } from '@/__fixtures__/journal';

const mockSession = { user: { id: 'user-1' } };

function mockAggregate(entries: unknown[] = [], total = entries.length) {
  vi.mocked(JournalEntry.aggregate).mockResolvedValue([
    {
      entries,
      total: total > 0 ? [{ n: total }] : [],
    },
  ]);
}

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/journal', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns paginated journal entries with entry limit info', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([{ _id: 'j1', symbol: 'BTCUSDT', enteredAt: new Date('2026-01-01'), exitedAt: null }]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(1);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    expect(data.totalPages).toBe(1);
    expect(data.entryLimit).toBe(1000);
    expect(data.totalUserEntries).toBe(1);
  });

  it('filters by symbol', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('symbol=ETHUSDT'));
    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({ symbol: 'ETHUSDT' })
    );
  });

  it('filters by tag', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('tag=breakout'));
    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({ tags: 'breakout' })
    );
  });

  it('filters by action', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('action=buy'));
    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({ action: 'buy' })
    );
  });

  it('filters by setup type', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('setupType=breakout'));
    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({ setupType: 'breakout' })
    );
  });

  it('filters by market condition', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('marketCondition=trending_up'));
    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({ marketCondition: 'trending_up' })
    );
  });

  it('filters by status=open', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('status=open'));
    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({
        entryPrice: { $ne: null },
        exitPrice: null,
      })
    );
  });

  it('filters by status=closed', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('status=closed'));
    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({
        exitPrice: { $ne: null },
      })
    );
  });

  it('filters by date range', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('startDate=2025-01-01&endDate=2025-01-31'));
    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    const dateMatch = pipeline.find(
      (stage) => stage.$match && 'enteredAt' in (stage.$match as Record<string, unknown>)
    );
    expect(dateMatch?.$match).toEqual({
      enteredAt: {
        $gte: new Date('2025-01-01'),
        $lte: new Date('2025-01-31'),
      },
    });
  });

  it('paginates with page and limit params', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([], 100);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(100);

    const res = await GET(makeGetRequest('page=2&limit=10'));
    const data = await res.json();
    expect(data.page).toBe(2);
    expect(data.totalPages).toBe(10);

    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    const facet = pipeline.find((stage) => '$facet' in stage)?.$facet as {
      entries: Array<Record<string, unknown>>;
    };
    expect(facet.entries).toContainEqual({ $skip: 10 });
    expect(facet.entries).toContainEqual({ $limit: 10 });
  });

  it('clamps limit to max 100', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockAggregate([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('limit=500'));
    const pipeline = vi.mocked(JournalEntry.aggregate).mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    const facet = pipeline.find((stage) => '$facet' in stage)?.$facet as {
      entries: Array<Record<string, unknown>>;
    };
    expect(facet.entries).toContainEqual({ $limit: 100 });
  });
});

describe('POST /api/journal', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makePostRequest(mockCreateJournalInput));
    expect(res.status).toBe(401);
  });

  it('creates a journal entry', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);
    const now = new Date('2026-01-10T12:00:00.000Z');
    vi.mocked(JournalEntry.create).mockResolvedValue({
      _id: 'j1',
      userId: 'user-1',
      createdAt: now,
      enteredAt: now,
      exitedAt: null,
      ...mockCreateJournalInput,
    } as never);

    const res = await POST(makePostRequest(mockCreateJournalInput));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.entry.symbol).toBe('BTCUSDT');
    expect(data.entry.enteredAt).toBeDefined();
    expect(data.entry.exitedAt).toBeNull();
    expect(JournalEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        enteredAt: expect.any(Date),
      })
    );
  });

  it('creates entry with new fields', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);
    const now = new Date('2026-01-10T12:00:00.000Z');
    const customEnteredAt = '2026-01-05T09:30:00.000Z';
    const input = {
      ...mockCreateJournalInput,
      enteredAt: customEnteredAt,
      tags: ['breakout'],
      marketCondition: 'trending_up',
      setupType: 'breakout',
      sentiment: { fearGreedIndex: 65, fearGreedLabel: 'Greed' },
    };
    vi.mocked(JournalEntry.create).mockResolvedValue({
      _id: 'j1',
      userId: 'user-1',
      createdAt: now,
      ...input,
      enteredAt: new Date(customEnteredAt),
      exitedAt: null,
    } as never);

    const res = await POST(makePostRequest(input));
    expect(res.status).toBe(201);
    expect(JournalEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['breakout'],
        marketCondition: 'trending_up',
        enteredAt: new Date(customEnteredAt),
      })
    );
  });

  it('returns 400 for invalid input', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    const res = await POST(makePostRequest({ symbol: '' }));
    expect(res.status).toBe(400);
  });

  it('enforces entry limit', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(1000);

    const res = await POST(makePostRequest(mockCreateJournalInput));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Maximum of 1000');
  });
});
