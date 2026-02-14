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
  },
  MAX_JOURNAL_ENTRIES_PER_USER: 1000,
}));

import { GET, POST } from './route';
import { auth } from '@/lib/auth';
import { JournalEntry } from '@/lib/models/journal-entry';
import { mockCreateJournalInput } from '@/__fixtures__/journal';

const mockSession = { user: { id: 'user-1' } };

function mockFindChain(entries: unknown[] = []) {
  vi.mocked(JournalEntry.find).mockReturnValue({
    sort: vi.fn().mockReturnValue({
      skip: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(entries),
      }),
    }),
  } as never);
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
    mockFindChain([{ _id: 'j1', symbol: 'BTCUSDT' }]);
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
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('symbol=ETHUSDT'));
    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'ETHUSDT' })
    );
  });

  it('filters by tag', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('tag=breakout'));
    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({ tags: 'breakout' })
    );
  });

  it('filters by action', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('action=buy'));
    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'buy' })
    );
  });

  it('filters by setup type', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('setupType=breakout'));
    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({ setupType: 'breakout' })
    );
  });

  it('filters by market condition', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('marketCondition=trending_up'));
    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({ marketCondition: 'trending_up' })
    );
  });

  it('filters by status=open', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('status=open'));
    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPrice: { $ne: null },
        exitPrice: null,
      })
    );
  });

  it('filters by status=closed', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('status=closed'));
    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({
        exitPrice: { $ne: null },
      })
    );
  });

  it('filters by date range', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('startDate=2025-01-01&endDate=2025-01-31'));
    expect(JournalEntry.find).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: {
          $gte: new Date('2025-01-01'),
          $lte: new Date('2025-01-31'),
        },
      })
    );
  });

  it('paginates with page and limit params', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(100);

    const res = await GET(makeGetRequest('page=2&limit=10'));
    const data = await res.json();
    expect(data.page).toBe(2);
    expect(data.totalPages).toBe(10);

    const findCall = vi.mocked(JournalEntry.find).mock.results[0].value;
    const sortCall = findCall.sort.mock.results[0].value;
    expect(sortCall.skip).toHaveBeenCalledWith(10);
  });

  it('clamps limit to max 100', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    mockFindChain([]);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);

    await GET(makeGetRequest('limit=500'));
    const findCall = vi.mocked(JournalEntry.find).mock.results[0].value;
    const sortCall = findCall.sort.mock.results[0].value;
    const skipCall = sortCall.skip.mock.results[0].value;
    expect(skipCall.limit).toHaveBeenCalledWith(100);
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
    vi.mocked(JournalEntry.create).mockResolvedValue({
      _id: 'j1',
      userId: 'user-1',
      ...mockCreateJournalInput,
    } as never);

    const res = await POST(makePostRequest(mockCreateJournalInput));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.entry.symbol).toBe('BTCUSDT');
  });

  it('creates entry with new fields', async () => {
    vi.mocked(auth).mockResolvedValue(mockSession as never);
    vi.mocked(JournalEntry.countDocuments).mockResolvedValue(0);
    const input = {
      ...mockCreateJournalInput,
      tags: ['breakout'],
      marketCondition: 'trending_up',
      setupType: 'breakout',
      sentiment: { fearGreedIndex: 65, fearGreedLabel: 'Greed' },
    };
    vi.mocked(JournalEntry.create).mockResolvedValue({
      _id: 'j1',
      userId: 'user-1',
      ...input,
    } as never);

    const res = await POST(makePostRequest(input));
    expect(res.status).toBe(201);
    expect(JournalEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['breakout'],
        marketCondition: 'trending_up',
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
